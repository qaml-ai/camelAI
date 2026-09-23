import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import type { ToolDefinition } from "../src/protocol.ts";
import { writeDurableJson } from "../shared/durable-json.ts";
import { FRAME_BYTES, type CallRecord, type ClientEvent, type Outcome, type RequestMethod, type SessionCredentials, type SessionState } from "../shared/client-protocol.ts";
export { Type as schema };
export type { SessionCredentials, SessionState };

export interface ToolContext { signal: AbortSignal; callId: string }
export interface Tool<T = any> {
  description: string;
  input: Record<string, unknown>;
  execute: (args: T, context: ToolContext) => unknown | Promise<unknown>;
}
/** Infer callback arguments from the schema; no manually duplicated argument type. */
export function tool<S extends TSchema>(definition: Omit<Tool<Static<S>>, "input"> & { input: S }): Tool<Static<S>> {
  return { ...definition, input: definition.input as unknown as Record<string, unknown> };
}
export type Tools = Record<string, Tool>;
export interface RuntimeOptions {
  url?: string;
  apiKey?: string;
  stateDirectory?: string;
  /** Injectable for tests, observability, or an application's HTTP stack. */
  fetch?: typeof globalThis.fetch;
}
export interface AgentOptions {
  tools: Tools;
  onEvent?: (event: any) => void;
  onConnection?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}
export interface RequestOptions { idempotencyKey?: string; timeoutMs?: number }
export class AgentError extends Error {
  status: number;
  requestId?: string;
  constructor(message: string, status = 0, requestId?: string) { super(message); this.name = "AgentError"; this.status = status; this.requestId = requestId; }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const definitions = (tools: Tools): ToolDefinition[] => Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.input }));

class Transport {
  readonly base: string;
  readonly fetcher: typeof globalThis.fetch;
  constructor(options: RuntimeOptions) {
    const url = new URL(options.url ?? process.env.AGENT_URL ?? "http://127.0.0.1:8790");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a runtime origin without credentials, path, or query");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Remote runtimes require https://");
    this.base = url.origin;
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  async json(path: string, token: string, method = "GET", body?: unknown, retry = true, headers: Record<string, string> = {}): Promise<any> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data && Buffer.byteLength(data) > FRAME_BYTES) throw new AgentError("Request exceeds transport limit");
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(this.base + path, {
          method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: data,
          redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        const value = await response.json() as any;
        if (!response.ok) throw new AgentError(value.error ?? `HTTP ${response.status}`, response.status);
        return value;
      } catch (error) {
        if (!retry || attempt >= 3 || (error instanceof AgentError && error.status < 500)) throw error;
        await pause(100 * 2 ** attempt);
      }
    }
  }
}

/** Trusted-backend SDK. Only createAgent needs the operator key. */
export class AgentRuntime {
  readonly options: RuntimeOptions;
  private readonly transport: Transport;
  constructor(options: RuntimeOptions = {}) { this.options = options; this.transport = new Transport(options); }
  async createAgent(options: AgentOptions & { idempotencyKey?: string; systemPrompt?: string; name?: string; type?: string }): Promise<AgentClient> {
    const key = this.options.apiKey ?? process.env.AGENT_RUNTIME_TOKEN;
    if (!key) throw new AgentError("Set apiKey or AGENT_RUNTIME_TOKEN to provision an agent");
    const session = await this.transport.json("/client-sessions", key, "POST", { tools: definitions(options.tools), ...(options.name !== undefined ? { name: options.name } : {}), ...(options.type !== undefined ? { type: options.type } : {}), ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}) }, true,
      { "Idempotency-Key": options.idempotencyKey ?? randomUUID() });
    return this.connectAgent(session, options);
  }
  async connectAgent(session: SessionCredentials, options: AgentOptions): Promise<AgentClient> {
    const client = new AgentClient(this.options, session, options);
    try { await client.connect(); return client; }
    catch (error) { await client.close(); throw error; }
  }
}

type Journal = { version: 1; cursor: number; calls: Record<string, { state: "started" | "done"; outcome?: Outcome }> };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class AgentClient {
  readonly session: SessionCredentials;
  readonly tools: Tools;
  private readonly transport: Transport;
  private readonly journalPath: string;
  private readonly journal: Journal;
  private readonly options: AgentOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly delivered = new Set<string>();
  private stream?: AbortController;
  private loop?: Promise<void>;
  private closed = false;
  private fatal?: Error;
  private ready = Promise.withResolvers<void>();

  constructor(runtime: RuntimeOptions, session: SessionCredentials, options: AgentOptions) {
    if (!/^client_[a-f0-9]{40}$/.test(session.id)) throw new AgentError("Invalid session id");
    this.session = { id: session.id, token: session.token, expiresAt: session.expiresAt };
    this.tools = options.tools;
    this.options = options;
    this.transport = new Transport(runtime);
    this.journalPath = join(resolve(runtime.stateDirectory ?? process.env.AGENT_CLIENT_STATE_DIR ?? ".agent-runtime/client-sdk"), `${session.id}.json`);
    try { this.journal = JSON.parse(readFileSync(this.journalPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.journal = { version: 1, cursor: 0, calls: {} };
    }
    if (this.journal.version !== 1) throw new AgentError("Unsupported client journal");
  }

  private save() { writeDurableJson(this.journalPath, this.journal); }
  private path(suffix = "") { return `/clients/${this.session.id}${suffix}`; }
  private http(suffix: string, method = "GET", body?: unknown, retry = true) { return this.transport.json(this.path(suffix), this.session.token, method, body, retry); }
  private report(error: unknown) { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }

  async connect() {
    if (this.closed) throw new AgentError("Client closed");
    this.loop ??= this.events();
    await Promise.race([this.ready.promise, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new AgentError("Timed out connecting to agent")), 10_000);
      this.ready.promise.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
  }

  private async events() {
    let backoff = 250;
    while (!this.closed) {
      this.stream = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => this.stream?.abort(), 20_000); };
      touch();
      try {
        const response = await this.transport.fetcher(this.transport.base + this.path("/events"), {
          headers: { Authorization: `Bearer ${this.session.token}`, Accept: "text/event-stream", "Last-Event-ID": String(this.journal.cursor) },
          signal: this.stream.signal, redirect: "error",
        });
        if (response.status === 409) {
          await response.body?.cancel();
          const snapshot = await this.sync();
          this.journal.cursor = snapshot.cursor; this.save();
          this.options.onEvent?.({ type: "replay_gap", cursor: snapshot.cursor });
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new AgentError(`Event stream HTTP ${response.status}`, response.status); }
        if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new AgentError("Expected an SSE response");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!this.closed) {
            const { value, done } = await reader.read();
            if (done) break;
            touch();
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              if (Buffer.byteLength(frame) > FRAME_BYTES) throw new AgentError("SSE frame too large");
              const lines = frame.split("\n");
              const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data) continue;
              if (lines.includes("event: ready")) {
                await this.sync();
                backoff = 250; this.ready.resolve(); this.options.onConnection?.(true);
                continue;
              }
              const id = Number(lines.find(line => line.startsWith("id:"))?.slice(3));
              if (!Number.isSafeInteger(id) || id <= 0) throw new AgentError("Invalid SSE cursor");
              if (id <= this.journal.cursor) continue;
              this.receive(JSON.parse(data));
              this.journal.cursor = id; this.save();
            }
            if (Buffer.byteLength(buffer) > FRAME_BYTES) throw new AgentError("SSE frame too large");
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        if (this.closed) break;
        if (error instanceof AgentError && [401, 403, 410].includes(error.status)) {
          this.fatal = error; this.ready.reject(error);
          for (const waiter of this.pending.values()) waiter.reject(error);
          this.pending.clear(); this.report(error); break;
        }
        this.report(error);
      } finally { clearTimeout(watchdog); this.options.onConnection?.(false); }
      if (!this.closed) { await pause(backoff); backoff = Math.min(5000, backoff * 2); }
    }
  }

  /** Rename/regroup this agent without changing its conversation or tools. */
  async setMetadata(metadata: { name: string; type: string }) {
    return this.transport.json(this.path('/metadata'), this.session.token, 'POST', metadata);
  }

  private receive(event: ClientEvent) {
    if (event.type === "tool_call") this.dispatch(event.call);
    else if (event.type === "tool_cancel") this.active.get(event.id)?.controller.abort();
    else if (event.type === "response") this.settle(event.id, event.outcome);
    else if (event.type === "event") this.options.onEvent?.(event.event);
  }
  private settle(id: string, value: Outcome) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if ("error" in value) waiter.reject(new AgentError(value.error ?? "Unknown failure", 0, id)); else waiter.resolve(value.result);
  }

  private async sync(): Promise<SessionState> {
    const state = await this.outcomes();
    for (const request of state.requests) if (request.outcome) this.settle(request.id, request.outcome);
    for (const call of state.calls) this.dispatch(call);
    return state;
  }

  private dispatch(call: CallRecord) {
    if (this.closed || this.active.has(call.id) || this.delivered.has(call.id) || ["completed", "cancelled"].includes(call.state)) return;
    const controller = new AbortController();
    // Defer execution until the active entry exists; replay can arrive immediately.
    const task = Promise.resolve().then(() => this.runTool(call, controller)).catch(error => this.report(error)).finally(() => this.active.delete(call.id));
    this.active.set(call.id, { controller, task });
  }

  private async runTool(call: CallRecord, controller: AbortController) {
    let receipt = this.journal.calls[call.id];
    if (receipt?.state === "done") {
      await this.http(`/calls/${call.id}/outcome`, "POST", receipt.outcome);
      this.delivered.add(call.id); return;
    }
    if (call.state === "uncertain") return; // Explicit reconciliation, never execute again.
    let value: Outcome;
    if (call.state === "started") value = { error: "Client lost its execution outcome; reconciliation required", uncertain: true };
    else {
      this.journal.calls[call.id] = { state: "started" }; this.save();
      try {
        // Claim is deliberately NOT retried. A lost acknowledgement is ambiguous.
        const claim = await this.http(`/calls/${call.id}/claim`, "POST", {}, false);
        if (!claim.execute) {
          if (claim.call.state !== "started") return;
          value = { error: "Tool execution was already claimed; outcome unknown", uncertain: true };
        } else {
          const timer = setTimeout(() => controller.abort(), Math.max(1, call.deadline - Date.now()));
          try {
            const definition = this.tools[call.name];
            if (!Object.hasOwn(this.tools, call.name) || !Check(definition.input, call.args)) throw new Error("Tool is missing or arguments failed validation");
            controller.signal.throwIfAborted();
            const result = await definition.execute(call.args, { callId: call.id, signal: controller.signal });
            if (result === undefined || Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("Tool must return a bounded JSON value");
            value = { result };
          } catch (error) { value = { error: String(error).slice(0, 2048), ...(controller.signal.aborted ? { uncertain: true } : {}) }; }
          finally { clearTimeout(timer); }
        }
      } catch (error) { value = { error: `Execution claim failed: ${String(error).slice(0, 1800)}`, uncertain: true }; }
    }
    // Persist before POST; reconnect resends this receipt, never the side effect.
    receipt = { state: "done", outcome: value };
    this.journal.calls[call.id] = receipt; this.save();
    await this.http(`/calls/${call.id}/outcome`, "POST", value);
    this.delivered.add(call.id);
  }

  async request(method: RequestMethod, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<any> {
    if (this.closed || this.fatal) throw this.fatal ?? new AgentError("Client closed");
    if (this.pending.size >= 8) throw new AgentError("Too many outstanding requests");
    const id = options.idempotencyKey ?? randomUUID();
    if (this.pending.has(id)) throw new AgentError("Request already pending", 409, id);
    const deferred = Promise.withResolvers<any>();
    // Attach immediately, even while the POST is pending, to avoid unhandled errors.
    deferred.promise.catch(() => {});
    this.pending.set(id, deferred);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(new AgentError("Request timed out; inspect requestStatus() or reuse the same idempotencyKey", 0, id));
    }, options.timeoutMs ?? 180_000);
    try {
      const record = await this.http("/requests", "POST", { id, method, params });
      if (record.outcome) this.settle(id, record.outcome);
      return await deferred.promise;
    } catch (error) {
      if (error instanceof AgentError) { error.requestId ??= id; throw error; }
      throw new AgentError(String(error), 0, id);
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }

  prompt(text: string, options?: RequestOptions) { return this.request("prompt", { text }, options); }
  execute(code: string, options?: RequestOptions & { timeoutMs?: number; executionTimeoutMs?: number }) {
    return this.request("execute", { code, ...(options?.executionTimeoutMs ? { timeoutMs: options.executionTimeoutMs } : {}) }, options);
  }
  status() { return this.request("status"); }
  abort() { return this.request("abort"); }
  requestStatus(id: string) { return this.http(`/requests/${encodeURIComponent(id)}`); }
  outcomes(): Promise<SessionState> { return this.http("/state"); }
  reconcile(callId: string, verified: Outcome) { return this.http(`/calls/${encodeURIComponent(callId)}/reconcile`, "POST", verified, false); }
  acknowledgeRequest(requestId: string) { return this.http(`/requests/${encodeURIComponent(requestId)}/reconcile`, "POST", { acknowledged: true }, false); }

  async close() {
    this.closed = true; this.stream?.abort();
    for (const { controller } of this.active.values()) controller.abort();
    for (const [id, waiter] of this.pending) waiter.reject(new AgentError("Client closed; request may still be running", 0, id));
    this.pending.clear();
    await this.loop;
    // User callbacks must cooperate with cancellation. Do not hang shutdown on one.
  }
  async destroy() { try { await this.http("", "DELETE"); } finally { await this.close(); } }
  async [Symbol.asyncDispose]() { await this.close(); }
}
