import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { childProcess, type Rpc } from "./rpc.ts";
import type { AgentConfig, ToolBridge } from "./protocol.ts";
import type { RequestMethod } from "../shared/client-protocol.ts";
import type { ChildProcess } from "node:child_process";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { pickExecutor, type Executions, type ExecutorEndpoint } from "./executions.ts";

/** With `executor`, agents run js_exec on executor hosts; tool callbacks are relayed back into the owning agent. */
export type SupervisorOptions = { runtime?: string; maxAgents?: number; executor?: { endpoint: ExecutorEndpoint; executions: Executions } };
type Handle = { bridge: ToolBridge; child: ChildProcess; rpc: Rpc; calls: Set<AbortController>; listeners: Set<(event: any) => void>; groupKilled: boolean };

function killGroup(handle: Handle) {
  if (handle.groupKilled || !handle.child.pid) return;
  try { process.kill(-handle.child.pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  // Never signal an already reaped group again on the subsequent exit event.
  handle.groupKilled = true;
}

export class AgentSupervisor {
  readonly agents = new Map<string, Handle>();
  readonly starting = new Set<string>();
  readonly root: string;
  readonly options: SupervisorOptions;
  constructor(root: string, options: SupervisorOptions = {}) {
    this.root = root;
    this.options = options;
  }

  async start(id: string, config: Omit<AgentConfig, "id" | "directory" | "tools">, bridge: ToolBridge) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    validateDefinitions(bridge.definitions);
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent already exists");
    if (this.full) throw new Error("VM agent capacity reached");
    this.starting.add(id);
    try {
      const directory = resolve(join(this.root, id));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const { child, rpc } = childProcess("./agent-child.ts", directory, this.options.runtime, true);
      const handle: Handle = { bridge, child, rpc, calls: new Set(), listeners: new Set(), groupKilled: false };
      this.agents.set(id, handle);
      this.starting.delete(id);
      const cleanup = () => {
        for (const call of handle.calls) call.abort();
        this.options.executor?.executions.releaseOwner(handle);
        // A VM is Unix: reap the entire agent process group, including a
        // codemode child stuck in synchronous code when its agent dies.
        try { killGroup(handle); }
        catch (error) { console.error("Failed to reap agent process group", child.pid, error); }
        if (this.agents.get(id) === handle) this.agents.delete(id);
      };
      child.once("exit", cleanup);
      child.once("error", cleanup);
      rpc.onEvent = event => { for (const listener of handle.listeners) listener(event); };
      rpc.handler = async (method, params) => {
        if (method === "cancel-tools") {
          for (const call of handle.calls) call.abort();
          return null;
        }
        if (method === "register-execution" || method === "release-execution") return this.#execution(handle, method, params);
        if (method !== "tool") throw new Error("Unknown tool");
        const checked = validateToolCall(bridge.definitions, params.name, params.args);
        const controller = new AbortController();
        handle.calls.add(controller);
        try {
          const result = await bridge.call(checked.tool.name, checked.args, controller.signal, params.toolCallId ? { toolCallId: params.toolCallId } : undefined);
          controller.signal.throwIfAborted();
          return JSON.parse(jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result"));
        }
        finally { handle.calls.delete(controller); }
      };
      const timeout = setTimeout(() => { rpc.close("Agent initialization timed out"); killGroup(handle); }, 30_000);
      try { return await rpc.request("init", { ...config, id, directory, tools: bridge.definitions, remoteExecutor: !!this.options.executor }); }
      catch (error) { await this.stop(id); throw error; }
      finally { clearTimeout(timeout); }
    } finally { this.starting.delete(id); }
  }

  /**
   * The agent child has no HTTP server, so the runtime registers its remote
   * executions here. The callback route relays each tool call back to this
   * agent, whose executeCode applies the same validation and quotas as locally.
   */
  #execution(handle: Handle, method: string, params: any) {
    const executor = this.options.executor;
    if (!executor) throw new Error("No code executor is configured");
    if (method === "release-execution") { executor.executions.release(String(params.id), handle); return null; }
    const grant = executor.executions.register(params.timeoutMs, call => handle.rpc.request("execution-tool", { id: grant.id, ...call }), handle);
    return { id: grant.id, token: grant.token, callbackUrl: grant.callbackUrl, executorUrl: pickExecutor(executor.endpoint), executorToken: executor.endpoint.token };
  }

  /** No capacity for another agent process; callers may stop an idle agent first. */
  get full() { return this.agents.size + this.starting.size >= (this.options.maxAgents ?? 8); }

  async request(id: string, method: RequestMethod, params: any = {}, onEvent?: (event: any) => void) {
    const handle = this.agents.get(id);
    if (!handle) throw new Error("Agent not found");
    if (method === "configure" && params.tools !== undefined) validateDefinitions(params.tools);
    if (method === "abort") for (const call of handle.calls) call.abort();
    if (onEvent) handle.listeners.add(onEvent);
    try {
      const result = await handle.rpc.request(method, params);
      if (method === "configure" && params.tools !== undefined) handle.bridge.definitions = params.tools;
      return result;
    }
    finally { if (onEvent) handle.listeners.delete(onEvent); }
  }

  async stop(id: string) {
    const handle = this.agents.get(id);
    if (!handle) return;
    for (const call of handle.calls) call.abort();
    handle.rpc.close("Agent stopped");
    const closed = once(handle.child, "close");
    killGroup(handle);
    await closed;
    this.agents.delete(id);
  }

  async close() { await Promise.all([...this.agents.keys()].map(id => this.stop(id))); }
}
