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
import { createAgentHost } from "./agent-host.ts";

/**
 * How agents run. "process": each agent is its own Node process (strong memory
 * isolation, ~50 MB each). "inline": many agents share this process, each
 * bounded by its compacted working set. Model-written code always runs in its
 * own sandbox process either way.
 */
export type Hosting = "process" | "inline";
type Common = { bridge: ToolBridge; calls: Set<AbortController>; listeners: Set<(event: any) => void> };
type ProcessHandle = Common & { kind: "process"; child: ChildProcess; rpc: Rpc; groupKilled: boolean };
type InlineHandle = Common & { kind: "inline"; host: ReturnType<typeof createAgentHost>; stop: (error: Error) => void; stopped: Promise<never> };
type Handle = ProcessHandle | InlineHandle;
type SupervisorOptions = { runtime?: string; maxAgents?: number; storage?: StorageDescriptor; hosting?: Hosting };

function killGroup(handle: ProcessHandle) {
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
  private storage?: Promise<Storage>;
  /**
   * `root` holds each agent's local working directory (its sandbox cwd). With
   * `storage`, transcripts live there under `sessions/<id>/transcript` instead of
   * in the working directory, so any host can load the agent.
   */
  constructor(root: string, options: SupervisorOptions = {}) {
    this.root = root;
    this.options = options;
  }

  get hosting(): Hosting { return this.options.hosting ?? "process"; }

  static transcriptKey(id: string) { return `sessions/${id}/transcript`; }

  /** An agent's full history without its process. */
  async history(id: string) {
    if (!this.options.storage) return readTranscript(resolve(join(this.root, id)));
    this.storage ??= openStorage(this.options.storage);
    return readTranscriptLog((await this.storage).log(AgentSupervisor.transcriptKey(id)));
  }

  /** Validate and dispatch an agent's application tool call, with the same limits in either hosting mode. */
  private async dispatchTool(handle: Handle, params: { name: string; args: unknown; toolCallId?: string }) {
    const checked = validateToolCall(handle.bridge.definitions, params.name, params.args);
    const controller = new AbortController();
    handle.calls.add(controller);
    try {
      const result = await handle.bridge.call(checked.tool.name, checked.args, controller.signal, params.toolCallId ? { toolCallId: params.toolCallId } : undefined);
      controller.signal.throwIfAborted();
      return JSON.parse(jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result"));
    }
    finally { handle.calls.delete(controller); }
  }
  private cancelTools(handle: Handle) { for (const call of handle.calls) call.abort(); return null; }

  async start(id: string, config: Omit<AgentConfig, "id" | "directory" | "tools">, bridge: ToolBridge) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    validateDefinitions(bridge.definitions);
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent already exists");
    if (this.full) throw new Error("Agent capacity reached");
    this.starting.add(id);
    try {
      const directory = resolve(join(this.root, id));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const location = this.options.storage ? { storage: this.options.storage, transcriptKey: AgentSupervisor.transcriptKey(id) } : {};
      const init = { ...config, ...location, id, directory, tools: bridge.definitions };
      return this.hosting === "inline" ? await this.startInline(id, init, bridge) : await this.startProcess(id, directory, init, bridge);
    } finally { this.starting.delete(id); }
  }

  private async startProcess(id: string, directory: string, init: AgentConfig, bridge: ToolBridge) {
    const { child, rpc } = childProcess("./agent-child.ts", directory, this.options.runtime, true);
    const handle: ProcessHandle = { kind: "process", bridge, child, rpc, calls: new Set(), listeners: new Set(), groupKilled: false };
    this.agents.set(id, handle);
    this.starting.delete(id);
    const cleanup = () => {
      this.cancelTools(handle);
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
      if (method === "cancel-tools") return this.cancelTools(handle);
      if (method !== "tool") throw new Error("Unknown tool");
      return this.dispatchTool(handle, params);
    };
    const timeout = setTimeout(() => { rpc.close("Agent initialization timed out"); killGroup(handle); }, 30_000);
    try { return await rpc.request("init", init); }
    catch (error) { await this.stop(id); throw error; }
    finally { clearTimeout(timeout); }
  }

  private async startInline(id: string, init: AgentConfig, bridge: ToolBridge) {
    const stopped = Promise.withResolvers<never>();
    stopped.promise.catch(() => {});
    const handle = { kind: "inline", bridge, calls: new Set(), listeners: new Set(), stop: stopped.reject, stopped: stopped.promise } as unknown as InlineHandle;
    handle.host = createAgentHost({
      // Copies keep the agent from sharing objects with the supervisor, as IPC would.
      emit: event => { for (const listener of handle.listeners) listener(structuredClone(event)); },
      tool: (name, args, toolCallId) => this.dispatchTool(handle, { name, args: structuredClone(args), toolCallId }),
      cancelTools: async () => this.cancelTools(handle),
    });
    this.agents.set(id, handle);
    this.starting.delete(id);
    try { return await this.invoke(handle, "init", init); }
    catch (error) { await this.stop(id); throw error; }
  }

  private invoke(handle: Handle, method: string, params: any): Promise<any> {
    if (handle.kind === "process") return handle.rpc.request(method, params);
    return Promise.race([handle.host.handle(method, structuredClone(params)), handle.stopped]).then(result => result === undefined ? result : structuredClone(result));
  }

  /** No capacity for another agent; callers may stop an idle agent first. */
  get full() { return this.agents.size + this.starting.size >= (this.options.maxAgents ?? 8); }

  async request(id: string, method: RequestMethod, params: any = {}, onEvent?: (event: any) => void) {
    const handle = this.agents.get(id);
    if (!handle) throw new Error("Agent not found");
    if (method === "configure" && params.tools !== undefined) validateDefinitions(params.tools);
    if (method === "abort") this.cancelTools(handle);
    if (onEvent) handle.listeners.add(onEvent);
    try {
      const result = await this.invoke(handle, method, params);
      if (method === "configure" && params.tools !== undefined) handle.bridge.definitions = params.tools;
      return result;
    }
    finally { if (onEvent) handle.listeners.delete(onEvent); }
  }

  async stop(id: string) {
    const handle = this.agents.get(id);
    if (!handle) return;
    this.cancelTools(handle);
    if (handle.kind === "process") {
      handle.rpc.close("Agent stopped");
      const closed = once(handle.child, "close");
      killGroup(handle);
      await closed;
    } else {
      // Callers see the same failure as a killed process; the host writes nothing more.
      handle.stop(new Error("Agent stopped"));
      await handle.host.dispose();
    }
    if (this.agents.get(id) === handle) this.agents.delete(id);
  }

  async close() { await Promise.all([...this.agents.keys()].map(id => this.stop(id))); }
}
