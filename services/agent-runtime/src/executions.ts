import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { errorText } from "./protocol.ts";
import { SANDBOX_LIMITS } from "./limits.ts";

/** One guest tool call relayed from an executor; the receiver applies codemode's validation and quotas. */
export type ToolDispatch = (call: { name: unknown; args: unknown }) => Promise<unknown>;
/** Where and how one execution runs remotely: the executor endpoint plus a capability for its tool callbacks. */
export type ExecutionGrant = { id: string; token: string; callbackUrl: string; executorUrl: string; executorToken: string; release(): void };
export interface RemoteExecutor { register(timeoutMs: number, dispatch: ToolDispatch): Promise<ExecutionGrant> }
/** Executor hosts are interchangeable; each execution goes to one picked at random. */
export type ExecutorEndpoint = { urls: string[]; token: string };

type Entry = { hash: Buffer; expiresAt: number; dispatch: ToolDispatch; owner: unknown; timer: NodeJS.Timeout };
const hash = (token: string) => createHash("sha256").update(token).digest();
const PATH = /^\/internal\/executions\/([0-9a-f-]{36})\/tools$/;

/** Parses AGENT_EXECUTOR_URL (comma-separated http(s) URLs) and AGENT_EXECUTOR_TOKEN. */
export function executorEndpoint(urls: string | undefined, token: string | undefined): ExecutorEndpoint {
  const list = (urls ?? "").split(",").map(url => url.trim().replace(/\/+$/, "")).filter(Boolean);
  if (!list.length || list.some(url => !/^https?:\/\/[^/]+$/.test(url))) throw new Error("AGENT_EXECUTOR_URL must list http(s) origins");
  if (!token || token.length < 32) throw new Error("AGENT_EXECUTOR_TOKEN must be at least 32 characters");
  return { urls: list, token };
}

export function pickExecutor(endpoint: ExecutorEndpoint) {
  return endpoint.urls[Math.floor(Math.random() * endpoint.urls.length)];
}

/**
 * Tool-callback capabilities for remote executions. A token reaches exactly one
 * execution's dispatcher and dies at that execution's deadline or release,
 * whichever comes first. Only hashes are kept.
 */
export class Executions {
  readonly #entries = new Map<string, Entry>();
  readonly #base: string;
  constructor(callbackBaseUrl: string) {
    if (!/^https?:\/\//.test(callbackBaseUrl)) throw new Error("AGENT_EXECUTOR_CALLBACK_URL must be an http(s) URL");
    this.#base = callbackBaseUrl.replace(/\/+$/, "");
  }

  register(timeoutMs: number, dispatch: ToolDispatch, owner?: unknown) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const timer = setTimeout(() => this.release(id), timeoutMs);
    timer.unref();
    this.#entries.set(id, { hash: hash(token), expiresAt: Date.now() + timeoutMs, dispatch, owner, timer });
    return { id, token, callbackUrl: `${this.#base}/internal/executions/${id}/tools`, release: () => this.release(id) };
  }

  /** With an owner, releases only that owner's execution: an agent cannot end another agent's run. */
  release(id: string, owner?: unknown) {
    const entry = this.#entries.get(id);
    if (!entry || owner !== undefined && entry.owner !== owner) return;
    clearTimeout(entry.timer);
    this.#entries.delete(id);
  }

  releaseOwner(owner: unknown) {
    for (const [id, entry] of this.#entries) if (entry.owner === owner) this.release(id);
  }

  get size() { return this.#entries.size; }

  /** `POST /internal/executions/:id/tools`. Returns false for any other route. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const match = PATH.exec(req.url ?? "");
    if (!match) return false;
    if (req.method !== "POST") { res.writeHead(405).end(); return true; }
    const entry = this.#entries.get(match[1]);
    if (!entry || Date.now() >= entry.expiresAt) { this.release(match[1]); res.writeHead(404).end(); return true; }
    const presented = /^Bearer (\S{1,512})$/.exec(req.headers.authorization ?? "")?.[1];
    if (!presented || !timingSafeEqual(hash(presented), entry.hash)) { res.writeHead(401).end(); return true; }
    let call: { name: unknown; args: unknown };
    try {
      call = JSON.parse(await bounded(req, SANDBOX_LIMITS.argumentBytes + 4096));
      if (!call || typeof call !== "object") throw new Error("Expected {name, args}");
    } catch (error) { json(res, 400, { error: errorText(error) }); return true; }
    try { json(res, 200, { result: await entry.dispatch({ name: call.name, args: call.args }) }); }
    catch (error) { json(res, 422, { error: errorText(error) }); }
    return true;
  }
}

/** A RemoteExecutor over an in-process registry: the runtime host when it is not relaying for an agent child. */
export function remoteExecutor(executions: Executions, endpoint: ExecutorEndpoint): RemoteExecutor {
  return {
    register: async (timeoutMs, dispatch) => ({ ...executions.register(timeoutMs, dispatch), executorUrl: pickExecutor(endpoint), executorToken: endpoint.token }),
  };
}

async function bounded(req: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Tool call too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}
