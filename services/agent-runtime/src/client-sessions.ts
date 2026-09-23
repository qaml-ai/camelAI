import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentConfig, ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import type { AgentSupervisor } from "./supervisor.ts";
import { configurationUpdate } from "./session-config.ts";
import { validateDefinitions } from "./tool-policy.ts";
import { validateUserMessages } from "./history.ts";
import { readTranscript } from "./transcript.ts";
import { writeDurableJson, canonical } from "../shared/durable-json.ts";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";
import { FRAME_BYTES, type CallRecord, type ClientEvent, type Outcome, type RequestRecord } from "../shared/client-protocol.ts";
import { agentMetadata, type AgentMetadata } from "../shared/agent-metadata.ts";
import { DEFAULT_TENANT } from "./tenants.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
type SessionConfig = Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">;
/** Rarely-changing session identity and configuration; rewritten only when it changes. */
interface SessionHeader {
  version: 3; id: string; digest: string; expiresAt: number; revoked: boolean;
  /** Owning tenant; absent on sessions created before tenants existed (the default tenant). */
  tenant?: string;
  metadata?: AgentMetadata; definitions: ToolDefinition[]; provisionHash: string; config: SessionConfig;
}
/** Upserts of request and tool-call records, appended as their state changes. */
type JournalRecord = { t: "request"; record: RequestRecord } | { t: "call"; record: CallRecord };
type BufferedEvent = { id: number; bytes: number; data: ClientEvent };
type Session = {
  header: SessionHeader;
  requests: Map<string, RequestRecord>;
  calls: Map<string, CallRecord>;
  log: AppendLog<JournalRecord>;
  /** Streamed events live only in memory; durable state is recovered through /state. */
  cursor: number; events: BufferedEvent[]; eventBytes: number;
  response?: ServerResponse; starting?: Promise<unknown>;
  pending: Map<string, (outcome: Outcome) => void>;
  fault?: Error;
  lastActive: number;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const validSessionId = (value: string) => /^client_[a-f0-9]{40}$/.test(value);
const has = (object: object, key: string) => Object.hasOwn(object, key);
const RUN_METHODS = ["prompt", "execute", "continue"];
const REQUEST_METHODS = [...RUN_METHODS, "status", "abort", "history", "steer", "followUp", "configure"];
/** Settled records kept for idempotent retries once the journal is folded. */
const RETAINED_SETTLED = 256;
const FOLD_AFTER_RECORDS = 2048;
const MAX_BUFFERED_EVENTS = 512;

export async function readJson(req: IncomingMessage, maximum = FRAME_BYTES) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximum) throw new HttpError(413, "Request too large");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
}
function outcome(value: any): Outcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid outcome");
  if (typeof value.error === "string" && !has(value, "result")) return { error: value.error.slice(0, 2048), ...(value.uncertain ? { uncertain: true } : {}) };
  if (has(value, "result") && !has(value, "error") && !value.uncertain) {
    if (Buffer.byteLength(JSON.stringify(value.result)) > 1024 * 1024) throw new HttpError(413, "Tool result too large");
    return { result: value.result };
  }
  throw new HttpError(400, "Supply either result or error");
}
const settled = (state: string) => !["running", "offered", "started"].includes(state);

export interface ClientSessionOptions {
  root: string; secret: string; toolTimeoutMs?: number; ttlMs?: number; eventBytes?: number;
  /** Fallback provider key when `apiKeyFor` is absent (single-tenant hosts and tests). */
  apiKey?: string;
  /** The provider key an agent uses, resolved per tenant at process start; never persisted. */
  apiKeyFor?: (tenant: string, provider: string) => string | undefined;
  /** Stop an agent's process, and unload its session, after this long without activity. */
  idleMs?: number;
  retry?: AgentConfig["retry"];
  /** Called with each finished assistant message that reports token usage. */
  onUsage?: (tenant: string, agentId: string, message: { provider?: string; model?: string; usage: any; timestamp?: number }) => void;
}

/**
 * SSE carries streamed events; POST mutations use persistent request/call IDs.
 * Sessions load lazily and unload when idle, so only active agents use memory.
 */
export class ClientSessions {
  readonly sessions = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();
  readonly supervisor: AgentSupervisor;
  readonly options: ClientSessionOptions;
  readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(supervisor: AgentSupervisor, options: ClientSessionOptions) {
    this.supervisor = supervisor;
    this.options = options;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.heartbeat = setInterval(() => this.tick(), Math.min(5000, Math.max(50, Math.floor((options.idleMs ?? 5 * 60_000) / 2))));
    this.heartbeat.unref();
  }

  private headerPath(id: string) { return join(this.options.root, `${id}.json`); }
  private journalPath(id: string) { return join(this.options.root, `${id}.journal.jsonl`); }

  private readHeader(id: string): SessionHeader | undefined {
    if (!validSessionId(id)) return undefined;
    try { return JSON.parse(readFileSync(this.headerPath(id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  private writeHeader(session: Session) {
    if (session.fault) throw session.fault;
    try { writeDurableJson(this.headerPath(session.header.id), session.header); }
    catch (error) { this.fail(session, error); throw session.fault; }
  }

  private load(id: string): Promise<Session | undefined> {
    const loaded = this.sessions.get(id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.read(id).finally(() => this.loading.delete(id));
      this.loading.set(id, loading);
    }
    return loading;
  }

  private async read(id: string): Promise<Session | undefined> {
    let header = this.readHeader(id) as any;
    if (!header) return undefined;
    const log = fileAppendLog<JournalRecord>(this.journalPath(id));
    const session: Session = {
      header, requests: new Map(), calls: new Map(), log,
      // Cursors restart above any cursor from an earlier process, so clients see a gap, never a repeat.
      cursor: Date.now() * 1000, events: [], eventBytes: 0, pending: new Map(), lastActive: Date.now(),
    };
    if (header.version === 2) {
      // Version 2 rewrote requests, calls and buffered events into this header on every event.
      for (const record of Object.values(header.requests ?? {}) as RequestRecord[]) session.requests.set(record.id, record);
      for (const record of Object.values(header.calls ?? {}) as CallRecord[]) session.calls.set(record.id, record);
      const { requests: _requests, calls: _calls, events: _events, cursor: _cursor, ...rest } = header;
      session.header = header = { ...rest, version: 3 };
      await log.rewrite(() => this.snapshot(session));
      this.writeHeader(session);
    } else {
      for (const record of await log.read()) this.apply(session, record);
    }
    if (header.version !== 3 || header.id !== id) throw new Error("Invalid client session header");
    // Loading means no process in this host owns the session, so nothing it recorded is still running.
    for (const request of session.requests.values()) if (request.state === "running") {
      this.upsertRequest(session, { ...request, state: "completed", endedAt: Date.now(), outcome: { error: "The runtime restarted during this request", uncertain: true } });
    }
    for (const call of session.calls.values()) {
      if (call.state === "started") this.upsertCall(session, { ...call, state: "uncertain", outcome: { error: "The runtime restarted during this tool call; its outcome is unknown", uncertain: true } });
      else if (call.state === "offered") this.upsertCall(session, { ...call, state: "cancelled", outcome: { error: "The runtime restarted before this tool call was claimed" } });
    }
    await log.flush(true);
    this.sessions.set(id, session);
    return session;
  }

  private apply(session: Session, entry: JournalRecord) {
    if (entry.t === "request") session.requests.set(entry.record.id, entry.record);
    else if (entry.t === "call") session.calls.set(entry.record.id, entry.record);
  }

  private snapshot(session: Session): JournalRecord[] {
    return [
      ...[...session.requests.values()].map(record => ({ t: "request" as const, record })),
      ...[...session.calls.values()].map(record => ({ t: "call" as const, record })),
    ];
  }

  private upsertRequest(session: Session, record: RequestRecord) {
    session.requests.set(record.id, record);
    session.log.append({ t: "request", record });
    return record;
  }
  private upsertCall(session: Session, record: CallRecord) {
    session.calls.set(record.id, record);
    session.log.append({ t: "call", record });
    return record;
  }

  /** Write appended journal records. Durable flushes gate acknowledgements and side effects. */
  private async commit(session: Session, durable: boolean) {
    if (session.fault) throw session.fault;
    try { await session.log.flush(durable); }
    catch (error) { this.fail(session, error); throw session.fault; }
  }
  private commitLater(session: Session) { void this.commit(session, false).catch(() => {}); }

  private fail(session: Session, error: unknown) {
    if (session.fault) return;
    // A failed disk commit must never turn into a successful retry from memory.
    session.fault = new Error(`Session persistence failed: ${errorText(error)}`);
    session.response?.destroy();
    for (const finish of session.pending.values()) finish({ error: session.fault.message, uncertain: true });
  }

  /** Drop old settled records once the journal is long, keeping recent ones for idempotent retries. */
  private async fold(session: Session) {
    if (session.log.appendedSinceRewrite < FOLD_AFTER_RECORDS) return;
    const prune = <T extends { id: string; state: string }>(records: Map<string, T>, at: (record: T) => number) => {
      const old = [...records.values()].filter(record => settled(record.state)).sort((a, b) => at(a) - at(b));
      for (const record of old.slice(0, Math.max(0, old.length - RETAINED_SETTLED))) records.delete(record.id);
    };
    prune(session.requests, record => record.endedAt ?? record.startedAt ?? 0);
    prune(session.calls, record => record.createdAt ?? 0);
    try { await session.log.rewrite(() => this.snapshot(session)); }
    catch (error) { this.fail(session, error); }
  }

  private publish(session: Session, data: ClientEvent) {
    if (this.closed || session.fault) return;
    let text = JSON.stringify(data);
    if (Buffer.byteLength(text) > FRAME_BYTES) {
      // Control outcomes remain in the journal; oversized display events are explicit gaps.
      data = { type: "event", requestId: "", event: { type: "event_omitted", reason: "Event exceeded transport limit" } };
      text = JSON.stringify(data);
    }
    const event: BufferedEvent = { id: ++session.cursor, bytes: Buffer.byteLength(text), data };
    session.events.push(event);
    session.eventBytes += event.bytes;
    session.lastActive = Date.now();
    const limit = this.options.eventBytes ?? 2 * 1024 * 1024;
    while (session.events.length > 1 && (session.events.length > MAX_BUFFERED_EVENTS || session.eventBytes > limit)) session.eventBytes -= session.events.shift()!.bytes;
    const res = session.response;
    if (res && !res.destroyed) {
      const frame = `id: ${event.id}\ndata: ${text}\n\n`;
      if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) res.destroy();
      else res.write(frame);
    }
  }

  private busy(session: Session) {
    return !!session.starting || session.pending.size > 0 || [...session.requests.values()].some(request => request.state === "running");
  }

  /** Stop the least recently active idle agent process when the host is at capacity. */
  private async makeRoom(except: string) {
    while (this.supervisor.full) {
      const idle = [...this.sessions.values()]
        .filter(session => session.header.id !== except && this.supervisor.agents.has(session.header.id) && !this.busy(session))
        .sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle) throw new HttpError(503, "Agent capacity reached; retry when another agent is idle");
      await this.supervisor.stop(idle.header.id);
    }
  }

  private apiKey(session: Session, provider: string) {
    return this.options.apiKeyFor ? this.options.apiKeyFor(session.header.tenant ?? DEFAULT_TENANT, provider) : this.options.apiKey;
  }

  private ensureStarted(session: Session) {
    if (this.closed || session.header.revoked) return Promise.reject(new HttpError(410, "Session closed"));
    if (session.fault) return Promise.reject(session.fault);
    session.lastActive = Date.now();
    if (this.supervisor.agents.has(session.header.id) && !session.starting) return Promise.resolve();
    return session.starting ??= (async () => {
      await this.makeRoom(session.header.id);
      const apiKey = this.apiKey(session, session.header.config.model.provider);
      const result = await this.supervisor.start(session.header.id, { ...session.header.config, apiKey, ...(this.options.retry ? { retry: this.options.retry } : {}) }, {
        definitions: session.header.definitions,
        call: (name, args, signal, context) => this.call(session, name, args, signal, context),
      });
      // Bootstrap history has been imported into the transcript; keep only one authority.
      if (session.header.config.initialMessages !== undefined) {
        delete session.header.config.initialMessages;
        this.writeHeader(session);
      }
      if (result.recovered) this.publish(session, { type: "event", requestId: "", event: { type: "turn_recovered", reason: "The runtime restarted during a turn; unresolved tool calls were marked unknown" } });
      return result;
    })().finally(() => { session.starting = undefined; });
  }

  async create(definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, key: string = randomUUID(), metadata: AgentMetadata = {}, tenant = DEFAULT_TENANT) {
    metadata = agentMetadata(metadata);
    validateDefinitions(definitions);
    if (!validId(key)) throw new HttpError(400, "Invalid provisioning idempotency key");
    // Idempotency keys are per tenant; the default tenant keeps its pre-tenant IDs and tokens.
    const scoped = tenant === DEFAULT_TENANT ? key : `${tenant}:${key}`;
    const id = `client_${hash(scoped).slice(0, 40)}`;
    const token = createHmac("sha256", this.options.secret).update(`client-v2:${scoped}`).digest("hex");
    const { apiKey: _key, ...safeConfig } = config;
    const provisionHash = hash(canonical({ definitions, config: safeConfig, ...(Object.keys(metadata).length ? { metadata } : {}) }));
    let session = await this.load(id);
    if (session) {
      if ((session.header.tenant ?? DEFAULT_TENANT) !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
      if (session.header.provisionHash !== provisionHash) throw new HttpError(409, "Idempotency key reused with different configuration");
      if (session.header.revoked || session.header.expiresAt <= Date.now()) throw new HttpError(410, "Session expired or revoked");
    } else {
      session = {
        header: { version: 3, id, ...(tenant === DEFAULT_TENANT ? {} : { tenant }), digest: hash(token), expiresAt: Date.now() + (this.options.ttlMs ?? 24 * 60 * 60 * 1000), revoked: false, metadata, definitions, config: safeConfig, provisionHash },
        requests: new Map(), calls: new Map(), log: fileAppendLog<JournalRecord>(this.journalPath(id)),
        cursor: Date.now() * 1000, events: [], eventBytes: 0, pending: new Map(), lastActive: Date.now(),
      };
      this.writeHeader(session);
      this.sessions.set(id, session);
    }
    await this.ensureStarted(session);
    const status = await this.supervisor.request(id, "status");
    return { id, token, expiresAt: session.header.expiresAt, ...status };
  }

  /** Agents owned by `tenant`, or every agent when no tenant is given. */
  list(tenant?: string) {
    const result: { id: string; name: string; type: string; model: string; connected: boolean; running: boolean; expiresAt: number }[] = [];
    for (const name of readdirSync(this.options.root)) {
      const match = /^(client_[a-f0-9]{40})\.json$/.exec(name);
      const header = match && (this.sessions.get(match[1])?.header ?? this.readHeader(match[1]));
      if (!header || header.revoked || header.expiresAt <= Date.now()) continue;
      if (tenant !== undefined && (header.tenant ?? DEFAULT_TENANT) !== tenant) continue;
      const response = this.sessions.get(header.id)?.response;
      result.push({
        id: header.id, name: header.metadata?.name ?? header.id, type: header.metadata?.type ?? "general",
        model: `${header.config.model.provider}/${header.config.model.id}`,
        connected: !!response && !response.destroyed, running: this.supervisor.agents.has(header.id), expiresAt: header.expiresAt,
      });
    }
    return result;
  }

  async inspect(id: string, tenant?: string) {
    const metadata = this.list(tenant).find(agent => agent.id === id);
    const session = metadata && await this.load(id);
    if (!metadata || !session) throw new HttpError(404, "Agent not found");
    return { ...metadata, tools: session.header.definitions, systemPrompt: session.header.config.systemPrompt ?? "",
      cursor: session.cursor, events: session.events.map(({ id, data }) => ({ id, data })), requests: [...session.requests.values()], calls: [...session.calls.values()] };
  }

  /** A tenant's view of one agent's history; undefined when the agent is not theirs. */
  async agentHistory(id: string, tenant: string) {
    const session = this.list(tenant).some(agent => agent.id === id) ? await this.load(id) : undefined;
    return session && this.history(session);
  }

  /** Abort the running turn of a tenant's agent. Returns false when the agent is not theirs. */
  async abortAgent(id: string, tenant: string) {
    if (!this.list(tenant).some(agent => agent.id === id)) return false;
    if (this.supervisor.agents.has(id)) await this.supervisor.request(id, "abort");
    return true;
  }

  /**
   * A tenant's key for `provider` changed: stop that tenant's idle agents using it
   * so their next request starts with the new key. Busy agents keep their key
   * until their turn ends and they go idle.
   */
  async providerKeyChanged(tenant: string, provider: string) {
    for (const session of this.sessions.values()) {
      if ((session.header.tenant ?? DEFAULT_TENANT) !== tenant || session.header.config.model.provider !== provider) continue;
      if (this.supervisor.agents.has(session.header.id) && !this.busy(session)) await this.supervisor.stop(session.header.id);
    }
  }

  /** Revoke a tenant's agent and stop its process. Its files stay on disk. */
  async destroyAgent(id: string, tenant: string) {
    if (!this.list(tenant).some(agent => agent.id === id)) return false;
    await this.remove(id);
    await this.supervisor.stop(id);
    return true;
  }

  /** The transcript, from the live agent when it runs, otherwise straight from its log. */
  private async history(session: Session) {
    if (this.supervisor.agents.has(session.header.id)) return this.supervisor.request(session.header.id, "history");
    return { messages: await readTranscript(join(this.supervisor.root, session.header.id)) };
  }

  /**
   * Called before operator authentication; this route requires a scoped credential.
   * `operatorTenant` is set only for the authenticated operator bridge, which may
   * submit requests to that tenant's own agents without their session token.
   */
  async handle(req: IncomingMessage, res: ServerResponse, operatorTenant?: string): Promise<boolean> {
    const operator = operatorTenant !== undefined;
    if (!(req.url ?? "").startsWith("/clients/")) return false;
    try {
      const match = /^\/clients\/(client_[a-f0-9]{40})(?:\/(events|state|metadata|history|requests|calls)(?:\/([A-Za-z0-9_-]{1,80})(?:\/(claim|outcome))?)?)?$/.exec(req.url ?? "");
      // Authenticate against the small header before loading the journal.
      const header = match ? this.sessions.get(match[1])?.header ?? this.readHeader(match[1]) : undefined;
      const authorization = req.headers.authorization ?? "";
      if (!header || req.headers.origin || (operator && (header.tenant ?? DEFAULT_TENANT) !== operatorTenant) || (!operator && (!authorization.startsWith("Bearer ") || !timingSafeEqual(Buffer.from(hash(authorization.slice(7)), "hex"), Buffer.from(header.digest, "hex"))))) throw new HttpError(401, "Unauthorized");
      if (header.revoked || header.expiresAt <= Date.now()) throw new HttpError(410, "Session expired or revoked");
      const session = await this.load(header.id);
      if (!session) throw new HttpError(401, "Unauthorized");
      if (session.fault) throw session.fault;
      session.lastActive = Date.now();
      const [, id, resource, resourceId, action] = match!;
      if (operator && !(resource === "requests" && req.method === "POST" && !resourceId)) throw new HttpError(403, "Operator bridge only accepts requests");
      if (req.method === "POST" && resource === "metadata" && !resourceId) {
        session.header.metadata = agentMetadata(await readJson(req, 4096));
        this.writeHeader(session);
        json(res, 200, session.header.metadata);
      } else if (req.method === "DELETE" && !resource) {
        await this.remove(id);
        await this.supervisor.stop(id);
        json(res, 200, { stopped: true });
      } else if (req.method === "GET" && resource === "events" && !resourceId) {
        const rawCursor = req.headers["last-event-id"] ?? "0";
        if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor)) throw new HttpError(400, "Invalid event cursor");
        const cursor = Number(rawCursor);
        if (!Number.isSafeInteger(cursor)) throw new HttpError(400, "Invalid event cursor");
        // Cursor 0 means a new client: it takes whatever is buffered. Anything else must be contiguous.
        const first = session.events[0]?.id ?? session.cursor + 1;
        if (cursor !== 0 && (cursor > session.cursor || cursor < first - 1)) throw new HttpError(409, "REPLAY_GAP: recover from session state");
        session.response?.end();
        session.response = res;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.write(`event: ready\ndata: ${JSON.stringify({ version: 3, agentId: id })}\n\n`);
        for (const event of session.events) if (event.id > cursor) {
          const frame = `id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`;
          if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) { res.destroy(); break; }
          res.write(frame);
        }
        res.on("close", () => { if (session.response === res) session.response = undefined; });
      } else if (req.method === "GET" && resource === "history" && !resourceId) {
        json(res, 200, await this.history(session));
      } else if (req.method === "GET" && resource === "state" && !resourceId) {
        json(res, 200, { cursor: session.cursor, calls: [...session.calls.values()], requests: [...session.requests.values()] });
      } else if (req.method === "POST" && resource === "requests" && !resourceId) {
        const { status, record } = await this.accept(session, await readJson(req, FRAME_BYTES));
        json(res, status, record);
      } else if (req.method === "GET" && resource === "requests" && resourceId && !action) {
        const record = session.requests.get(resourceId);
        if (!record) throw new HttpError(404, "Unknown request");
        json(res, 200, record);
      } else if (req.method === "POST" && resourceId && resource === "calls") {
        const call = session.calls.get(resourceId);
        if (!call) throw new HttpError(404, "Unknown tool call");
        if (action === "claim") {
          await readJson(req);
          if (call.state !== "offered" || call.deadline <= Date.now()) json(res, 200, { execute: false, call });
          else {
            this.upsertCall(session, { ...call, state: "started" });
            // The claim must be durable before the client performs the side effect.
            await this.commit(session, true);
            json(res, 200, { execute: true });
          }
        } else if (action === "outcome") {
          await this.recordOutcome(session, call, outcome(await readJson(req)));
          json(res, 200, { recorded: true, state: session.calls.get(call.id)!.state });
        } else throw new HttpError(404, "Unknown call operation");
      } else throw new HttpError(404, "Unknown client route");
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error instanceof HttpError ? error.status : 500, { error: errorText(error) });
    }
    return true;
  }

  /**
   * Accept an idempotent request: 200 with the existing record for a retried ID,
   * or 202 once the new record is durable and the work has started.
   */
  private async accept(session: Session, body: any): Promise<{ status: 200 | 202; record: RequestRecord }> {
    if (!validId(body?.id) || !REQUEST_METHODS.includes(body.method) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw new HttpError(400, "Invalid request");
    try {
      if (body.method === "configure") configurationUpdate(body.params);
      // Assistant and tool-result history is runtime-owned; callers may only add user input.
      if (["prompt", "steer", "followUp"].includes(body.method) && body.params.message !== undefined) validateUserMessages(Array.isArray(body.params.message) ? body.params.message : [body.params.message]);
    } catch (error) { throw new HttpError(400, errorText(error)); }
    const fingerprint = hash(canonical({ method: body.method, params: body.params }));
    const existing = () => {
      const record = session.requests.get(body.id);
      if (record && record.fingerprint !== fingerprint) throw new HttpError(409, "Request ID reused with different arguments");
      return record;
    };
    // A retried ID returns the committed record, including its outcome after a lost ack.
    const retried = existing();
    if (retried) return { status: 200, record: retried };
    if ([...session.requests.values()].filter(request => request.state === "running").length >= 8) throw new HttpError(429, "Too many requests");
    // Reads and aborts never need a process; everything else runs in the agent.
    if (!["history", "status", "abort"].includes(body.method)) await this.ensureStarted(session);
    // Concurrent retries may have waited on the same process startup.
    const raced = existing();
    if (raced) return { status: 200, record: raced };
    const record = this.upsertRequest(session, { startedAt: Date.now(), ...(body.method === "prompt" && typeof body.params.text === "string" ? { prompt: body.params.text } : {}), ...(body.method === "execute" && typeof body.params.code === "string" ? { code: body.params.code } : {}), id: body.id, method: body.method, fingerprint, state: "running" });
    await this.commit(session, true);
    void this.run(session, record, body.params);
    return { status: 202, record };
  }

  /** Submit a request to a tenant's agent on the tenant's behalf (REST API and console). */
  async submit(id: string, tenant: string, body: { id: string; method: string; params: Record<string, unknown> }) {
    const session = this.list(tenant).some(agent => agent.id === id) ? await this.load(id) : undefined;
    if (!session) throw new HttpError(404, "Unknown agent");
    if (session.fault) throw session.fault;
    session.lastActive = Date.now();
    return (await this.accept(session, body)).record;
  }

  private async execute(session: Session, record: RequestRecord, params: any) {
    const id = session.header.id;
    const live = this.supervisor.agents.has(id);
    if (record.method === "history") return this.history(session);
    if (record.method === "status" && !live) return { running: false };
    if (record.method === "abort" && !live) return { aborted: false, running: false };
    if (record.method === "configure") {
      const update = configurationUpdate(params);
      // A new model may belong to another provider: the agent needs that provider's key.
      const apiKey = update.model ? this.apiKey(session, update.model.provider) : undefined;
      if (update.model && this.options.apiKeyFor && !apiKey) throw new Error(`No ${update.model.provider} API key is configured for this tenant; set one with PUT /v1/providers/${update.model.provider}/key`);
      const result = await this.supervisor.request(id, "configure", { ...update, ...(apiKey ? { apiKey } : {}) });
      const { tools, ...config } = update;
      if (tools !== undefined) session.header.definitions = tools;
      session.header.config = { ...session.header.config, ...config };
      this.writeHeader(session);
      return result;
    }
    return this.supervisor.request(id, record.method, params, RUN_METHODS.includes(record.method)
      ? event => {
          // Failed calls report zero usage; count only responses the provider completed.
          if (event?.type === "message_end" && event.message?.role === "assistant" && event.message.usage && event.message.stopReason !== "error") {
            this.options.onUsage?.(session.header.tenant ?? DEFAULT_TENANT, id, event.message);
          }
          this.publish(session, { type: "event", requestId: record.id, event });
        } : undefined);
  }

  private async run(session: Session, record: RequestRecord, params: unknown) {
    let value: Outcome;
    try { value = { result: await this.execute(session, record, params) }; }
    catch (error) { value = { error: errorText(error) }; }
    if (this.closed || session.fault || session.requests.get(record.id)?.state !== "running") return;
    this.upsertRequest(session, { ...record, state: "completed", outcome: value, endedAt: Date.now() });
    try { await this.commit(session, true); }
    catch { return; /* The fault is reported to every later request. */ }
    session.lastActive = Date.now();
    this.publish(session, { type: "response", id: record.id, outcome: value });
    await this.fold(session);
  }

  private async recordOutcome(session: Session, call: CallRecord, value: Outcome) {
    if (call.state === "completed") {
      if (canonical(call.outcome) !== canonical(value)) throw new HttpError(409, "Conflicting tool outcome");
      return;
    }
    if (call.state === "cancelled") throw new HttpError(409, "Tool cancelled before execution claim");
    if (call.state === "offered") throw new HttpError(409, "Tool has not been claimed");
    if (call.state === "uncertain") {
      if (call.lateOutcome && canonical(call.lateOutcome) !== canonical(value)) throw new HttpError(409, "Conflicting late outcome");
      if (call.lateOutcome) return;
      // The model already saw "unknown"; keep the real result as evidence and tell observers.
      this.upsertCall(session, { ...call, lateOutcome: value });
      await this.commit(session, true);
      this.publish(session, { type: "event", requestId: call.requestId ?? "", event: { type: "tool_late_outcome", callId: call.id, toolCallId: call.toolCallId, name: call.name, outcome: value } });
      return;
    }
    this.upsertCall(session, { ...call, state: value.uncertain ? "uncertain" : "completed", outcome: value });
    await this.commit(session, true);
    session.pending.get(call.id)?.(value);
  }

  private call(session: Session, name: string, args: Record<string, unknown>, signal: AbortSignal, context?: { toolCallId: string }): Promise<unknown> {
    signal.throwIfAborted();
    if (this.closed || session.fault || session.header.revoked) return Promise.reject(new Error("Client session unavailable"));
    if (session.pending.size >= 32) return Promise.reject(new Error("Too many pending client tools"));
    const request = [...session.requests.values()].find(r => r.state === "running" && RUN_METHODS.includes(r.method));
    const call = this.upsertCall(session, { ...(context ? { toolCallId: context.toolCallId } : {}), ...(request ? { requestId: request.id } : {}), createdAt: Date.now(), id: randomUUID(), name, args, state: "offered", deadline: Date.now() + (this.options.toolTimeoutMs ?? 15_000) });
    // An offer needs no durable commit: after a restart, unclaimed offers are cancelled.
    this.commitLater(session);
    return new Promise((resolve, reject) => {
      const finish = (value: Outcome) => {
        if (!session.pending.delete(call.id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if ("error" in value) reject(new Error(value.error)); else resolve(value.result);
      };
      const cancel = (reason: string) => {
        const current = session.calls.get(call.id)!;
        if (!["offered", "started"].includes(current.state)) return;
        const uncertain = current.state === "started";
        const settledCall = this.upsertCall(session, { ...current, state: uncertain ? "uncertain" : "cancelled", outcome: uncertain
          ? { error: `${reason} after the application started it. Its outcome is unknown: it may or may not have taken effect.`, uncertain: true }
          : { error: `${reason} before the application started it` } });
        this.commitLater(session);
        this.publish(session, { type: "tool_cancel", id: call.id });
        // The model receives the unknown outcome and decides what to do; the turn keeps going.
        finish(settledCall.outcome!);
      };
      const abort = () => cancel("Tool call cancelled");
      const timer = setTimeout(() => cancel("Tool call timed out"), Math.max(1, call.deadline - Date.now()));
      session.pending.set(call.id, finish);
      signal.addEventListener("abort", abort, { once: true });
      this.publish(session, { type: "tool_call", call: { ...call } });
    });
  }

  async remove(id: string) {
    const session = await this.load(id);
    if (!session || session.header.revoked) return;
    session.header.revoked = true;
    this.writeHeader(session);
    await this.interrupt(session, "Session revoked");
    session.response?.end();
  }

  private async interrupt(session: Session, reason: string) {
    for (const call of session.calls.values()) if (["offered", "started"].includes(call.state)) {
      const uncertain = call.state === "started";
      this.upsertCall(session, { ...call, state: uncertain ? "uncertain" : "cancelled", outcome: { error: reason, ...(uncertain ? { uncertain: true } : {}) } });
    }
    for (const request of session.requests.values()) if (request.state === "running") {
      this.upsertRequest(session, { ...request, state: "completed", endedAt: Date.now(), outcome: { error: reason, uncertain: true } });
    }
    for (const [id, finish] of session.pending) finish(session.calls.get(id)!.outcome!);
    await this.commit(session, true);
  }

  /** Expire sessions, keep SSE alive, and release idle agents' processes and memory. */
  private tick() {
    const now = Date.now();
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    for (const session of this.sessions.values()) {
      const id = session.header.id;
      if (!session.header.revoked && session.header.expiresAt <= now) {
        void this.remove(id).then(() => this.supervisor.stop(id)).catch(() => {});
        continue;
      }
      if (session.response && !session.response.write(": heartbeat\n\n")) session.response.destroy();
      if (this.busy(session) || now - session.lastActive < idleMs) continue;
      if (this.supervisor.agents.has(id)) void this.supervisor.stop(id).catch(() => {});
      else if (!session.response && !session.fault) {
        // Nothing is connected or running: everything needed later is on disk.
        this.sessions.delete(id);
        void session.log.close().catch(() => {});
      }
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const session of this.sessions.values()) {
      try { await this.interrupt(session, "The runtime stopped during this request"); }
      catch { /* Already faulted; the next load recovers conservatively from disk. */ }
      session.response?.end();
      await session.log.close().catch(() => {});
    }
  }
}
