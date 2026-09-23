import { once } from "node:events";
import { childProcess, type Rpc } from "./rpc.ts";
import type { ToolBridge } from "./protocol.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import type { RemoteExecutor } from "./executions.ts";

/** The part of Rpc executeCode drives, whether the sandbox is a local child or an executor host. */
type Channel = { handler?: Rpc["handler"]; onEvent?: Rpc["onEvent"]; request(method: string, params: any): Promise<any>; close(reason: string): void };
type Sandbox = { rpc: Channel; kill(): void; readonly closed: Promise<unknown> };

export async function executeCode(options: {
  code: string; directory: string; bridge: ToolBridge; signal?: AbortSignal;
  runtime?: string; timeoutMs?: number; maxOutputCharacters?: number;
  onEvent?: (event: unknown) => void;
  /** Run on an executor host instead of a local child. Validation and quotas below apply either way. */
  executor?: RemoteExecutor;
}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputCharacters = options.maxOutputCharacters ?? 32_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters < 1 || maxOutputCharacters > 128_000) throw new Error("maxOutputCharacters must be 1..128000");
  if (typeof options.code !== "string" || options.code.length > 256_000) throw new Error("Invalid or oversized code");
  validateDefinitions(options.bridge.definitions);
  options.signal?.throwIfAborted();
  const sandbox = options.executor ? remoteSandbox(options.executor, maxOutputCharacters) : localSandbox(options.directory, options.runtime);
  const { rpc } = sandbox;
  const controller = new AbortController();
  const stop = (reason: string) => {
    controller.abort();
    rpc.close(reason);
    sandbox.kill();
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
    await sandbox.closed;
  }
}

function localSandbox(directory: string, runtime?: string): Sandbox {
  const { child, rpc } = childProcess("./code-child.ts", directory, runtime);
  return { rpc, kill: () => child.kill("SIGKILL"), closed: once(child, "close") };
}

/**
 * The same request/handler/event surface over HTTP. The executor streams NDJSON
 * back; guest tool calls arrive separately at the runtime's callback route and
 * reach `handler` through the registered dispatch. Closing aborts the stream,
 * which makes the executor kill its child. The executor is untrusted: events
 * and the result are checked against the output limits it was asked to apply.
 */
function remoteSandbox(executor: RemoteExecutor, maxOutputCharacters: number): Sandbox {
  const aborted = new AbortController();
  let reason: string | undefined;
  let settled: Promise<unknown> = Promise.resolve();
  let characters = 0;
  let events = 0;
  const output = (text: unknown) => {
    if (typeof text !== "string" || ++events > SANDBOX_LIMITS.outputEvents || (characters += text.length) > maxOutputCharacters) {
      throw new Error("Executor returned output beyond the codemode limits");
    }
    return text;
  };
  const execute = async (params: any) => {
    const grant = await executor.register(params.timeoutMs, call => {
      if (!rpc.handler) throw new Error("RPC handler unavailable");
      return rpc.handler("tool", call);
    });
    try {
      aborted.signal.throwIfAborted();
      const response = await fetch(`${grant.executorUrl}/execute`, {
        method: "POST", signal: aborted.signal, redirect: "error",
        headers: { Authorization: `Bearer ${grant.executorToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ executionId: grant.id, ...params, callback: { url: grant.callbackUrl, token: grant.token } }),
      });
      if (!response.ok || !response.body) throw new Error(`Executor rejected the execution (${response.status})`);
      for await (const message of ndjson(response.body, 8 * 1024 * 1024)) {
        if (message?.type === "event" && message.event?.type === "output") {
          // Checked even without a listener: `onEvent?.(...)` would skip evaluating its argument.
          const text = output(message.event.text);
          rpc.onEvent?.({ type: "output", text });
        } else if (message?.type === "error") throw new Error(typeof message.error === "string" ? message.error.slice(0, 2048) : "Executor failed");
        else if (message?.type === "result") {
          const result = message.result;
          if (!result || !Array.isArray(result.output) || typeof result.truncated !== "boolean") throw new Error("Invalid executor result");
          // The result repeats every streamed part; count it afresh against the same limits.
          characters = events = 0;
          return { output: result.output.map(output), truncated: result.truncated };
        } else throw new Error("Invalid executor message");
      }
      throw new Error("Executor ended the execution without a result");
    } catch (error) {
      throw reason ? new Error(reason) : error;
    } finally { grant.release(); }
  };
  const rpc: Channel = {
    request(method, params) {
      if (method !== "execute") return Promise.reject(new Error(`Unsupported executor method: ${method}`));
      const run = execute(params);
      settled = run.catch(() => {});
      return run;
    },
    close(why) {
      reason ??= why;
      aborted.abort();
    },
  };
  return { rpc, kill: () => aborted.abort(), get closed() { return settled; } };
}

/** Parse newline-delimited JSON, accepting at most `limit` bytes in total. */
async function* ndjson(body: ReadableStream<Uint8Array>, limit: number) {
  const decoder = new TextDecoder();
  let buffered = "";
  let size = 0;
  for await (const chunk of body) {
    if ((size += chunk.byteLength) > limit) throw new Error("Executor response exceeds size limit");
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffered.trim()) yield JSON.parse(buffered);
}
