import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentConfig, ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import type { AgentSupervisor } from "./supervisor.ts";
import { validateDefinitions } from "./tool-policy.ts";
import { writeDurableJson, canonical } from "../shared/durable-json.ts";
import { FRAME_BYTES, type CallRecord, type ClientEvent, type Outcome, type RequestRecord } from "../shared/client-protocol.ts";

import { agentMetadata, type AgentMetadata } from "../shared/agent-metadata.ts";

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
interface SavedSession {
  metadata?: AgentMetadata;
  version: 2; id: string; digest: string; expiresAt: number; revoked: boolean;
  definitions: ToolDefinition[]; provisionHash: string;
  config: Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">;
  cursor: number; events: { id: number; at?: number; data: ClientEvent }[];
  calls: Record<string, CallRecord>; requests: Record<string, RequestRecord>;
}
type Session = {
  saved: SavedSession; response?: ServerResponse; starting?: Promise<unknown>;
  pending: Map<string, (outcome: Outcome) => void>;
  fault?: Error;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const has = (object: object, key: string) => Object.hasOwn(object, key);
const MAX_RECORDS = 1024;

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

/** SSE carries durable events; POST mutations use persistent request/call IDs. */
export class ClientSessions {
  readonly sessions = new Map<string, Session>();
  readonly supervisor: AgentSupervisor;
  readonly options: { root: string; secret: string; apiKey?: string; toolTimeoutMs?: number; ttlMs?: number; eventBytes?: number };
  readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(supervisor: AgentSupervisor, options: ClientSessions["options"]) {
    this.supervisor = supervisor;
    this.options = options;
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(options.root).filter(name => /^client_[a-f0-9]{40}\.json$/.test(name))) {
      const saved = JSON.parse(readFileSync(join(options.root, name), "utf8")) as SavedSession;
      if (saved.version !== 2 || saved.id + ".json" !== name) throw new Error("Invalid client session journal");
      const session: Session = { saved, pending: new Map() };
      this.sessions.set(saved.id, session);
      // A dead host cannot assert the outcome of an accepted turn or claimed tool.
      for (const request of Object.values(saved.requests)) if (request.state === "running") {
        request.state = "uncertain";
        request.outcome = { error: "Host restarted during request; reconcile before retrying", uncertain: true };
      }
      for (const call of Object.values(saved.calls)) {
        if (call.state === "started") { call.state = "uncertain"; call.outcome = { error: "Host restarted during tool execution", uncertain: true }; }
        else if (call.state === "offered") { call.state = "cancelled"; call.outcome = { error: "Host restarted before execution claim" }; }
      }
      this.save(session);
    }
    this.heartbeat = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (!session.saved.revoked && session.saved.expiresAt <= Date.now()) {
          this.remove(session.saved.id);
          void supervisor.stop(session.saved.id).catch(() => {});
        } else if (session.response && !session.response.write(": heartbeat\n\n")) session.response.destroy();
      }
    }, 5000);
    this.heartbeat.unref();
  }

  private save(session: Session) {
    if (session.fault) throw session.fault;
    try {
      if (Buffer.byteLength(JSON.stringify(session.saved)) > 32 * 1024 * 1024) throw new Error("Session journal full; create a new agent after reconciliation");
      writeDurableJson(join(this.options.root, `${session.saved.id}.json`), session.saved);
    } catch (error) {
      // A failed disk commit must never turn into a successful retry from RAM.
      session.fault = new Error(`Session persistence failed: ${errorText(error)}`);
      session.response?.destroy();
      for (const finish of session.pending.values()) finish({ error: session.fault.message, uncertain: true });
      throw session.fault;
    }
  }

  private publish(session: Session, data: ClientEvent) {
    if (this.closed || session.fault) return;
    if (Buffer.byteLength(JSON.stringify(data)) > FRAME_BYTES) {
      // Control outcomes remain in the journal; oversized display events are explicit gaps.
      data = { type: "event", requestId: "", event: { type: "event_omitted", reason: "Event exceeded transport limit" } };
    }
    const record = { id: ++session.saved.cursor, at: Date.now(), data };
    session.saved.events.push(record);
    const limit = this.options.eventBytes ?? 2 * 1024 * 1024;
    while (session.saved.events.length > 1 && (session.saved.events.length > 512 || Buffer.byteLength(JSON.stringify(session.saved.events)) > limit)) session.saved.events.shift();
    this.save(session);
    const res = session.response;
    if (res && !res.destroyed) {
      const frame = `id: ${record.id}\ndata: ${JSON.stringify(record.data)}\n\n`;
      if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) res.destroy();
      else res.write(frame);
    }
  }

  private blocked(session: Session) {
    return Object.values(session.saved.calls).some(call => call.state === "uncertain") ||
      Object.values(session.saved.requests).some(request => request.state === "uncertain");
  }

  private ensureStarted(session: Session) {
    if (this.closed || session.saved.revoked) return Promise.reject(new HttpError(410, "Session closed"));
    if (session.fault) return Promise.reject(session.fault);
    if (this.supervisor.agents.has(session.saved.id) && !session.starting) return Promise.resolve();
    return session.starting ??= this.supervisor.start(session.saved.id, { ...session.saved.config, apiKey: this.options.apiKey }, {
      definitions: session.saved.definitions,
      call: (name, args, signal) => this.call(session, name, args, signal),
    }).finally(() => { session.starting = undefined; });
  }

  async create(definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, key: string = randomUUID(), metadata: AgentMetadata = {}) {
    metadata = agentMetadata(metadata);
    validateDefinitions(definitions);
    if (!validId(key)) throw new HttpError(400, "Invalid provisioning idempotency key");
    const id = `client_${hash(key).slice(0, 40)}`;
    const token = createHmac("sha256", this.options.secret).update(`client-v2:${key}`).digest("hex");
    const { apiKey: _key, ...safeConfig } = config;
    const provisionHash = hash(canonical({ definitions, config: safeConfig, ...(Object.keys(metadata).length ? { metadata } : {}) }));
    let session = this.sessions.get(id);
    if (session) {
      if (session.saved.provisionHash !== provisionHash) throw new HttpError(409, "Idempotency key reused with different configuration");
      if (session.saved.revoked || session.saved.expiresAt <= Date.now()) throw new HttpError(410, "Session expired or revoked");
    } else {
      if (this.sessions.size >= 128) throw new HttpError(429, "Client session retention capacity reached");
      session = { pending: new Map(), saved: {
        version: 2, id, digest: hash(token), expiresAt: Date.now() + (this.options.ttlMs ?? 24 * 60 * 60 * 1000), revoked: false,
        metadata, definitions, config: safeConfig, provisionHash, cursor: 0, events: [], calls: {}, requests: {},
      } };
      this.sessions.set(id, session);
      this.save(session);
    }
    await this.ensureStarted(session);
    const status = await this.supervisor.request(id, "status");
    return { id, token, expiresAt: session.saved.expiresAt, ...status };
  }

  list() {
    return [...this.sessions.values()].filter(s => !s.saved.revoked && s.saved.expiresAt > Date.now()).map(s => ({
      id: s.saved.id, name: s.saved.metadata?.name ?? s.saved.id, type: s.saved.metadata?.type ?? 'general',
      connected: !!s.response && !s.response.destroyed,
    }));
  }

  inspect(id: string) {
    const metadata = this.list().find(a => a.id === id);
    if (!metadata) throw new HttpError(404, "Agent not found");
    const saved = this.sessions.get(id)!.saved;
    return { ...metadata, tools: saved.definitions, systemPrompt: saved.config.systemPrompt ?? '',
      cursor: saved.cursor, events: saved.events, requests: Object.values(saved.requests), calls: Object.values(saved.calls) };
  }

  /** Called before operator authentication; this route requires a scoped credential. */
  async handle(req: IncomingMessage, res: ServerResponse, operator = false): Promise<boolean> {
    if (!(req.url ?? "").startsWith("/clients/")) return false;
    try {
      const match = /^\/clients\/(client_[a-f0-9]{40})(?:\/(events|state|metadata|requests|calls)(?:\/([A-Za-z0-9_-]{1,80})(?:\/(claim|outcome|reconcile))?)?)?$/.exec(req.url ?? "");
      const session = match && this.sessions.get(match[1]);
      const header = req.headers.authorization ?? "";
      if (!session || req.headers.origin || (!operator && (!header.startsWith("Bearer ") || !timingSafeEqual(Buffer.from(hash(header.slice(7)), "hex"), Buffer.from(session.saved.digest, "hex"))))) throw new HttpError(401, "Unauthorized");
      if (session.fault) throw session.fault;
      if (session.saved.revoked || session.saved.expiresAt <= Date.now()) throw new HttpError(410, "Session expired or revoked");
      const [, id, resource, resourceId, action] = match!;
      if (operator && !(resource === "requests" && req.method === "POST" && !resourceId)) throw new HttpError(403, "Operator bridge only accepts requests");
      if (req.method === "POST" && resource === "metadata" && !resourceId) {
        session.saved.metadata = agentMetadata(await readJson(req, 4096));
        this.save(session);
        json(res, 200, session.saved.metadata);
      } else if (req.method === "DELETE" && !resource) {
        this.remove(id);
        await this.supervisor.stop(id);
        json(res, 200, { stopped: true });
      } else if (req.method === "GET" && resource === "events" && !resourceId) {
        const rawCursor = req.headers["last-event-id"] ?? "0";
        if (typeof rawCursor !== "string" || !/^\d+$/.test(rawCursor)) throw new HttpError(400, "Invalid event cursor");
        const cursor = Number(rawCursor);
        if (!Number.isSafeInteger(cursor) || cursor > session.saved.cursor) throw new HttpError(400, "Invalid event cursor");
        const first = session.saved.events[0]?.id ?? session.saved.cursor + 1;
        if (cursor < first - 1) throw new HttpError(409, "REPLAY_GAP: recover from session state");
        await this.ensureStarted(session);
        session.response?.end();
        session.response = res;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.write(`event: ready\ndata: ${JSON.stringify({ version: 2, agentId: id })}\n\n`);
        for (const event of session.saved.events) if (event.id > cursor) {
          const frame = `id: ${event.id}\ndata: ${JSON.stringify(event.data)}\n\n`;
          if (res.writableLength + Buffer.byteLength(frame) > 2 * FRAME_BYTES) { res.destroy(); break; }
          res.write(frame);
        }
        res.on("close", () => { if (session.response === res) session.response = undefined; });
      } else if (req.method === "GET" && resource === "state" && !resourceId) {
        json(res, 200, { cursor: session.saved.cursor, calls: Object.values(session.saved.calls), requests: Object.values(session.saved.requests), needsReconciliation: this.blocked(session) });
      } else if (req.method === "POST" && resource === "requests" && !resourceId) {
        const body = await readJson(req, 256_000);
        if (!validId(body?.id) || !["prompt", "execute", "status", "abort"].includes(body.method) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw new HttpError(400, "Invalid request");
        const fingerprint = hash(canonical({ method: body.method, params: body.params }));
        const existing = has(session.saved.requests, body.id) ? session.saved.requests[body.id] : undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new HttpError(409, "Request ID reused with different arguments");
          json(res, 200, existing); // Includes the committed response after a lost POST ack.
        } else {
          if (this.blocked(session) && ["prompt", "execute"].includes(body.method)) throw new HttpError(409, "Reconciliation required: inspect uncertain outcomes before continuing");
          if (Object.keys(session.saved.requests).length >= MAX_RECORDS) throw new HttpError(429, "Request journal full; start a new session");
          if (Object.values(session.saved.requests).filter(request => request.state === "running").length >= 8) throw new HttpError(429, "Too many requests");
          await this.ensureStarted(session);
          // Concurrent retries may have waited on the same process startup.
          if (has(session.saved.requests, body.id)) {
            const accepted = session.saved.requests[body.id];
            if (accepted.fingerprint !== fingerprint) throw new HttpError(409, "Request ID reused with different arguments");
            json(res, 200, accepted);
            return true;
          }
          const record: RequestRecord = { startedAt: Date.now(), ...(body.method === "prompt" && typeof body.params.text === "string" ? { prompt: body.params.text } : {}), ...(body.method === "execute" && typeof body.params.code === "string" ? { code: body.params.code } : {}), id: body.id, method: body.method, fingerprint, state: "running" };
          Object.defineProperty(session.saved.requests, body.id, { value: record, enumerable: true, writable: true, configurable: true });
          this.save(session);
          json(res, 202, record);
          void this.run(session, record, body.params);
        }
      } else if (req.method === "GET" && resource === "requests" && resourceId && !action) {
        if (!has(session.saved.requests, resourceId)) throw new HttpError(404, "Unknown request");
        json(res, 200, session.saved.requests[resourceId]);
      } else if (req.method === "POST" && resourceId && resource === "calls") {
        if (!has(session.saved.calls, resourceId)) throw new HttpError(404, "Unknown tool call");
        const call = session.saved.calls[resourceId];
        if (action === "claim") {
          await readJson(req);
          if (call.state !== "offered" || call.deadline <= Date.now() || this.blocked(session)) json(res, 200, { execute: false, call });
          else { call.state = "started"; this.save(session); json(res, 200, { execute: true }); }
        } else if (action === "outcome" || action === "reconcile") {
          const value = outcome(await readJson(req));
          if (action === "reconcile") {
            if (value.uncertain) throw new HttpError(400, "Reconciliation requires a verified outcome");
            if (call.state !== "uncertain") throw new HttpError(409, "Only uncertain calls need reconciliation");
            call.state = "completed"; call.outcome = value;
            this.save(session);
          } else this.recordOutcome(session, call, value);
          json(res, 200, { recorded: true, state: call.state });
        } else throw new HttpError(404, "Unknown call operation");
      } else if (req.method === "POST" && resource === "requests" && resourceId && action === "reconcile") {
        const body = await readJson(req);
        if (!has(session.saved.requests, resourceId) || session.saved.requests[resourceId].state !== "uncertain" || body?.acknowledged !== true) throw new HttpError(409, "Acknowledge an uncertain request after inspecting its effects");
        session.saved.requests[resourceId].state = "completed";
        this.save(session);
        json(res, 200, { acknowledged: true });
      } else throw new HttpError(404, "Unknown client route");
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error instanceof HttpError ? error.status : 500, { error: errorText(error) });
    }
    return true;
  }

  private async run(session: Session, record: RequestRecord, params: unknown) {
    let value: Outcome;
    try {
      const result = await this.supervisor.request(session.saved.id, record.method, params, ["prompt", "execute"].includes(record.method)
        ? event => { try { this.publish(session, { type: "event", requestId: record.id, event }); } catch { void this.supervisor.request(session.saved.id, "abort").catch(() => {}); } } : undefined);
      value = { result };
    } catch (error) { value = { error: errorText(error) }; }
    if (this.closed || session.fault || record.state !== "running") return;
    record.state = "completed"; record.outcome = value; record.endedAt = Date.now();
    try { this.publish(session, { type: "response", id: record.id, outcome: value }); }
    catch { /* The persistence fault blocks every subsequent request. */ }
  }

  private recordOutcome(session: Session, call: CallRecord, value: Outcome) {
    if (call.state === "completed") {
      if (canonical(call.outcome) !== canonical(value)) throw new HttpError(409, "Conflicting tool outcome");
      return;
    }
    if (call.state === "cancelled") throw new HttpError(409, "Tool cancelled before execution claim");
    if (call.state === "offered") throw new HttpError(409, "Tool has not been claimed");
    if (call.state === "uncertain") {
      if (call.lateOutcome && canonical(call.lateOutcome) !== canonical(value)) throw new HttpError(409, "Conflicting late outcome");
      call.lateOutcome = value; // Evidence, never silently unblocks a timed-out turn.
      this.save(session);
      return;
    }
    call.state = value.uncertain ? "uncertain" : "completed";
    call.outcome = value;
    this.save(session);
    session.pending.get(call.id)?.(value);
    if (value.uncertain) void this.supervisor.request(session.saved.id, "abort").catch(() => {});
  }

  private call(session: Session, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.closed || session.fault || session.saved.revoked) return Promise.reject(new Error("Client session unavailable"));
    if (this.blocked(session)) return Promise.reject(new Error("Reconciliation required before more tool calls"));
    if (Object.keys(session.saved.calls).length >= MAX_RECORDS) return Promise.reject(new Error("Tool journal full; start a new session"));
    if (session.pending.size >= 32) return Promise.reject(new Error("Too many pending client tools"));
    const request = Object.values(session.saved.requests).find(r => r.state === "running" && ["prompt", "execute"].includes(r.method));
    const call: CallRecord = { ...(request ? { requestId: request.id } : {}), createdAt: Date.now(), id: randomUUID(), name, args, state: "offered", deadline: Date.now() + (this.options.toolTimeoutMs ?? 15_000) };
    session.saved.calls[call.id] = call;
    return new Promise((resolve, reject) => {
      const finish = (value: Outcome) => {
        if (!session.pending.delete(call.id)) return;
        clearTimeout(timer); signal.removeEventListener("abort", abort);
        if ("error" in value) reject(new Error(value.error)); else resolve(value.result);
      };
      const cancel = (reason: string) => {
        if (!["offered", "started"].includes(call.state)) return;
        const uncertain = call.state === "started";
        call.state = uncertain ? "uncertain" : "cancelled";
        call.outcome = { error: uncertain ? `${reason}; tool outcome unknown. Reconciliation required.` : `${reason} before tool execution claim`, ...(uncertain ? { uncertain: true } : {}) };
        try { this.publish(session, { type: "tool_cancel", id: call.id }); }
        catch { /* save() already faults and rejects the pending call. */ }
        finish(call.outcome);
        if (uncertain) void this.supervisor.request(session.saved.id, "abort").catch(() => {});
      };
      const abort = () => cancel("Tool cancelled");
      const timer = setTimeout(() => cancel("Client tool timed out"), Math.max(1, call.deadline - Date.now()));
      session.pending.set(call.id, finish);
      signal.addEventListener("abort", abort, { once: true });
      try { this.publish(session, { type: "tool_call", call: { ...call } }); }
      catch (error) { finish({ error: errorText(error), uncertain: true }); }
    });
  }

  remove(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.saved.revoked) return;
    session.saved.revoked = true;
    this.interrupt(session, "Session revoked");
    session.response?.end();
  }

  private interrupt(session: Session, reason: string) {
    for (const call of Object.values(session.saved.calls)) if (["offered", "started"].includes(call.state)) {
      const uncertain = call.state === "started";
      call.state = uncertain ? "uncertain" : "cancelled";
      call.outcome = { error: reason, ...(uncertain ? { uncertain: true } : {}) };
    }
    for (const request of Object.values(session.saved.requests)) if (request.state === "running") {
      request.state = "uncertain"; request.outcome = { error: reason, uncertain: true };
    }
    this.save(session);
    for (const [id, finish] of session.pending) finish(session.saved.calls[id].outcome!);
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const session of this.sessions.values()) {
      try { this.interrupt(session, "Host stopped during execution; reconcile before retrying"); }
      catch { /* Already faulted; disk state will be recovered conservatively. */ }
      session.response?.end();
    }
  }
}
