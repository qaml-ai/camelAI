import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { childProcess, type Rpc } from "./rpc.ts";
import type { AgentConfig, ToolBridge } from "./protocol.ts";
import type { RequestMethod } from "../shared/client-protocol.ts";
import type { ChildProcess } from "node:child_process";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { openStorage, type StorageDescriptor } from "../shared/storage-config.ts";
import type { Storage } from "../shared/storage.ts";
import { readTranscript, readTranscriptLog } from "./transcript.ts";

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
  readonly options: { runtime?: string; maxAgents?: number; storage?: StorageDescriptor };
  private storage?: Promise<Storage>;
  /**
   * `root` holds each agent's local working directory (its sandbox cwd). With
   * `storage`, transcripts live there under `sessions/<id>/transcript` instead of
   * in the working directory, so any host can load the agent.
   */
  constructor(root: string, options: { runtime?: string; maxAgents?: number; storage?: StorageDescriptor } = {}) {
    this.root = root;
    this.options = options;
  }

  static transcriptKey(id: string) { return `sessions/${id}/transcript`; }

  /** An agent's full history without its process. */
  async history(id: string) {
    if (!this.options.storage) return readTranscript(resolve(join(this.root, id)));
    this.storage ??= openStorage(this.options.storage);
    return readTranscriptLog((await this.storage).log(AgentSupervisor.transcriptKey(id)));
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
      const location = this.options.storage ? { storage: this.options.storage, transcriptKey: AgentSupervisor.transcriptKey(id) } : {};
      try { return await rpc.request("init", { ...config, ...location, id, directory, tools: bridge.definitions }); }
      catch (error) { await this.stop(id); throw error; }
      finally { clearTimeout(timeout); }
    } finally { this.starting.delete(id); }
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
