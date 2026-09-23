import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Accounts, Principal } from "./accounts.ts";
import type { ClientSessions } from "./client-sessions.ts";
import type { ConsoleAuth } from "./console-auth.ts";
import { listModels, listProviders, providerInfo } from "./catalog.ts";
import { checkProviderKey } from "./key-check.ts";
import { errorText } from "./protocol.ts";

/**
 * Tenant self-service REST API. Every console action goes through these routes,
 * so anything the console can do, a script can do with an API token:
 *
 *   GET    /v1/me
 *   GET    /v1/providers                       key status per provider
 *   PUT    /v1/providers/:provider/key         { apiKey, verify? }
 *   DELETE /v1/providers/:provider/key
 *   GET    /v1/models?provider=&available=true
 *   GET    /v1/agents                          POST /v1/agents creates one
 *   GET    /v1/agents/:id                      DELETE revokes it
 *   GET    /v1/agents/:id/history
 *   POST   /v1/agents/:id/prompt               { text } → accepted request
 *   GET    /v1/agents/:id/requests/:requestId
 *   POST   /v1/agents/:id/abort
 *   GET    /v1/tokens                          POST { name } mints one; DELETE /v1/tokens/:id
 *   GET    /v1/usage?days=30
 */
export interface ApiContext {
  accounts: Accounts;
  clients: ClientSessions;
  consoleAuth: ConsoleAuth;
  /** Provision an agent for a tenant (shared with POST /client-sessions). */
  createAgent(tenant: string, params: any, idempotencyKey?: string): Promise<unknown>;
  verifyKeys?: boolean;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
async function readBody(req: IncomingMessage, limit = 1024 * 1024) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > limit) throw new ApiError(413, "Request too large");
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new ApiError(400, "Invalid JSON"); }
}
const send = (res: ServerResponse, status: number, value: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));

export async function handleApi(req: IncomingMessage, res: ServerResponse, context: ApiContext): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://runtime");
  if (url.pathname !== "/v1" && !url.pathname.startsWith("/v1/")) return false;
  try {
    const principal = await authenticate(req, context);
    const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const { accounts, clients } = context;
    const tenant = principal.tenant;
    const route = `${method} ${parts[0] ?? ""}`;

    if (route === "GET me") {
      send(res, 200, { tenant, via: principal.via, ...("login" in principal ? { login: principal.login } : {}), canStoreKeys: accounts.canStoreKeys });
    } else if (route === "GET providers" && parts.length === 1) {
      const keys = new Map((await accounts.keyStatus(tenant)).map(status => [status.provider, status]));
      const wildcard = keys.get("*");
      send(res, 200, listProviders().map(provider => ({ ...provider, key: keys.get(provider.id) ?? (wildcard && provider.apiKey ? wildcard : null) })));
    } else if (parts[0] === "providers" && parts[2] === "key" && parts.length === 3 && (method === "PUT" || method === "DELETE")) {
      const provider = providerInfo(parts[1]);
      if (!provider) throw new ApiError(404, `Unknown provider ${parts[1]}; see GET /v1/providers`);
      if (method === "DELETE") {
        if (!await accounts.deleteKey(tenant, provider.id)) throw new ApiError(404, `No ${provider.id} key set by this tenant`);
        await clients.providerKeyChanged(tenant, provider.id);
        send(res, 200, { deleted: true });
        return true;
      }
      if (!provider.apiKey) throw new ApiError(400, `${provider.id} needs ${provider.requires}, not just an API key; it is not supported yet`);
      if (!accounts.canStoreKeys) throw new ApiError(503, "This runtime is not configured to store provider keys");
      const body = await readBody(req, 16 * 1024);
      const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
      if (!apiKey || apiKey.length > 4096 || /\s/.test(apiKey)) throw new ApiError(400, "Send {\"apiKey\": \"...\"} with the provider's API key");
      const check = body.verify === false || context.verifyKeys === false ? { status: "unverified" as const, detail: "Verification skipped" } : await checkProviderKey(provider.id, apiKey);
      if (check.status === "invalid") throw new ApiError(422, check.detail);
      await accounts.setKey(tenant, provider.id, apiKey);
      await clients.providerKeyChanged(tenant, provider.id);
      send(res, 200, { provider: provider.id, last4: apiKey.slice(-4), verification: check });
    } else if (route === "GET models") {
      const provider = url.searchParams.get("provider") ?? undefined;
      const available = url.searchParams.get("available") === "true";
      const supported = new Set(listProviders().filter(entry => entry.apiKey).map(entry => entry.id));
      const keyed = await accounts.keyedProviders(tenant);
      const models = listModels(provider).map(model => ({ ...model, available: supported.has(model.provider) && keyed(model.provider) }));
      send(res, 200, available ? models.filter(model => model.available) : models);
    } else if (route === "GET agents" && parts.length === 1) {
      send(res, 200, await clients.list(tenant));
    } else if (route === "POST agents" && parts.length === 1) {
      const key = req.headers["idempotency-key"];
      if (key !== undefined && typeof key !== "string") throw new ApiError(400, "Invalid Idempotency-Key");
      send(res, 201, await context.createAgent(tenant, await readBody(req, 18 * 1024 * 1024), key));
    } else if (parts[0] === "agents" && parts[1]) {
      await agentRoute(req, res, context, tenant, parts.slice(1), method);
    } else if (route === "GET tokens") {
      send(res, 200, await accounts.listTokens(tenant));
    } else if (route === "POST tokens" && parts.length === 1) {
      const body = await readBody(req, 4096);
      send(res, 201, await accounts.createToken(tenant, body.name));
    } else if (route === "DELETE tokens" && parts[1]) {
      if (principal.tokenId === parts[1]) throw new ApiError(400, "A token cannot revoke itself; use another token or the console");
      if (!await accounts.revokeToken(tenant, parts[1])) throw new ApiError(404, "Unknown token");
      send(res, 200, { revoked: true });
    } else if (route === "GET usage") {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
      send(res, 200, await accounts.usage(tenant, Date.now() - days * 86_400_000));
    } else {
      throw new ApiError(404, "Unknown API route");
    }
  } catch (error) {
    if (res.headersSent) res.destroy();
    else send(res, error instanceof ApiError ? error.status : (error as { status?: number }).status ?? 400, { error: errorText(error) });
  }
  return true;
}

async function authenticate(req: IncomingMessage, context: ApiContext): Promise<Principal & { login?: string }> {
  if (req.headers.authorization) {
    const principal = await context.accounts.authenticate(req.headers.authorization);
    if (!principal) throw new ApiError(401, "Invalid token");
    return principal;
  }
  const principal = await context.consoleAuth.principal(req);
  if (!principal) throw new ApiError(401, "Sign in, or send Authorization: Bearer <token>");
  if (!["GET", "HEAD"].includes(req.method ?? "GET") && !context.consoleAuth.allowsMutation(req)) throw new ApiError(403, "Console requests must be same-origin");
  return principal;
}

async function agentRoute(req: IncomingMessage, res: ServerResponse, context: ApiContext, tenant: string, parts: string[], method: string) {
  const { clients } = context;
  const [id, resource, resourceId] = parts;
  if (!await clients.owns(id, tenant)) throw new ApiError(404, "Unknown agent");
  if (method === "GET" && !resource) {
    send(res, 200, await clients.inspect(id, tenant));
  } else if (method === "DELETE" && !resource) {
    await clients.destroyAgent(id, tenant);
    send(res, 200, { deleted: true });
  } else if (method === "GET" && resource === "history") {
    send(res, 200, await clients.agentHistory(id, tenant));
  } else if (method === "POST" && resource === "abort") {
    await clients.abortAgent(id, tenant);
    send(res, 200, { aborted: true });
  } else if (method === "POST" && resource === "prompt") {
    const body = await readBody(req, 1024 * 1024);
    if (typeof body.text !== "string" || !body.text.trim()) throw new ApiError(400, "Send {\"text\": \"...\"}");
    send(res, 202, await clients.submit(id, tenant, { id: body.requestId ?? randomUUID(), method: "prompt", params: { text: body.text } }));
  } else if (method === "GET" && resource === "requests" && resourceId) {
    const request = (await clients.inspect(id, tenant)).requests.find(record => record.id === resourceId);
    if (!request) throw new ApiError(404, "Unknown request");
    send(res, 200, request);
  } else {
    throw new ApiError(404, "Unknown agent route");
  }
}
