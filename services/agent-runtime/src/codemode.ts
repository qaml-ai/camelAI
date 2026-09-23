import { once } from "node:events";
import { childProcess } from "./rpc.ts";
import type { ToolBridge } from "./protocol.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";

export async function executeCode(options: {
  code: string; directory: string; bridge: ToolBridge; signal?: AbortSignal;
  runtime?: string; timeoutMs?: number; maxOutputCharacters?: number;
  onEvent?: (event: unknown) => void;
}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputCharacters = options.maxOutputCharacters ?? 32_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters < 1 || maxOutputCharacters > 128_000) throw new Error("maxOutputCharacters must be 1..128000");
  if (typeof options.code !== "string" || options.code.length > 256_000) throw new Error("Invalid or oversized code");
  validateDefinitions(options.bridge.definitions);
  options.signal?.throwIfAborted();
  const { child, rpc } = childProcess("./code-child.ts", options.directory, options.runtime);
  const exited = once(child, "close");
  const controller = new AbortController();
  const stop = (reason: string) => {
    controller.abort();
    rpc.close(reason);
    child.kill("SIGKILL");
  };
  const abort = () => stop("Codemode aborted; any external tool side effects may already have completed");
  const timer = setTimeout(() => stop(`Codemode timed out after ${timeoutMs}ms; external side effects may have completed`), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  rpc.onEvent = options.onEvent;
  let calls = 0;
  let inflight = 0;
  let transferred = 0;
  rpc.handler = async (method, params) => {
    if (method !== "tool") throw new Error("Unknown tool");
    const checked = validateToolCall(options.bridge.definitions, params.name, params.args);
    if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
    if (inflight >= SANDBOX_LIMITS.concurrentTools) throw new Error("Too many concurrent tool calls");
    transferred += checked.bytes;
    if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
    controller.signal.throwIfAborted();
    inflight++;
    try {
      const result = await options.bridge.call(checked.tool.name, checked.args, controller.signal);
      controller.signal.throwIfAborted();
      const json = jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result");
      transferred += Buffer.byteLength(json);
      if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
      return JSON.parse(json);
    } finally { inflight--; }
  };
  try {
    return await rpc.request("execute", { code: options.code, tools: options.bridge.definitions, maxOutputCharacters, timeoutMs });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    stop("Codemode completed");
    await exited;
  }
}
