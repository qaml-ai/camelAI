/**
 * MCP server for the hosted agent runtime (https://agents.camelai.dev).
 *
 * The runtime runs the model loop; chiridion serves the tools. Every request
 * carries a runtime identity token (EdDSA JWT, two minutes, one per request):
 * `ctx` is the { org, workspace, thread } chiridion gave the agent when it
 * created it, and `act ?? sub` is the user acting. Nothing is stored here: each
 * request is verified, authorized against OrgDO, and answered by a fresh
 * CodeModeToolsBinding scoped to that org/workspace/thread/user — the same
 * implementation js_exec's `tools.<name>()` calls use today.
 *
 * Stateless Streamable HTTP, JSON responses only (like the admin MCP): no
 * session id, no server-initiated stream, GET/DELETE answer 405.
 */
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { CODE_MODE_TOOL_DEFINITIONS } from "../code-mode-tools.js";
import type { CodeModeToolsProps } from "../code-mode-tools.js";
import type { Env, RouteContext } from "../types.js";
import { getOrgStub } from "../helpers/stubs.js";

const DEFAULT_ISSUER = "https://agents.camelai.dev";
const JWKS_CACHE_TTL_SECONDS = 600;
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Tools served so far: read-only workspace/project/app inspection plus the
 * workspace file write path. Anything needing the live chat UI (preview,
 * todos, questions, subagents) waits for the ChatThreadDO adapter.
 */
export const AGENT_MCP_TOOL_NAMES = new Set([
  "workspace_info",
  "list_projects",
  "list_commits",
  "list_apps",
  "list_deploy_versions",
  "get_latest_logs",
  "list_scheduled_prompts",
  "connections_list",
  "read_skill",
  "ls",
  "read",
  "grep",
  "find",
  "write",
  "edit",
]);

export interface RuntimeCaller {
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  claims: JWTPayload;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

type ToolsBinding = {
  callToolEnvelope(
    name: string,
    args: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>;
};
export type ToolsFactory = (props: CodeModeToolsProps) => ToolsBinding;

class McpAuthError extends Error {
  constructor(message: string, readonly status: 401 | 403 | 503) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function runtimeIssuer(env: Env): string {
  return (env.AGENT_RUNTIME_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, "");
}

function jwksUrl(env: Env): string {
  return env.AGENT_RUNTIME_JWKS_URL || `${runtimeIssuer(env)}/.well-known/jwks.json`;
}

/** The URL tokens must name as `aud`: this endpoint, unless configured (behind a proxy). */
export function mcpAudience(env: Env, req: Request): string {
  if (env.AGENT_RUNTIME_MCP_AUDIENCE) return env.AGENT_RUNTIME_MCP_AUDIENCE;
  const url = new URL(req.url);
  return `${url.origin}${url.pathname}`;
}

function edgeCache(): Cache | null {
  try {
    return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

/** The runtime's JWKS through the edge cache; `fresh` skips it (a key rotated in). */
async function loadJwks(url: string, fresh: boolean): Promise<JSONWebKeySet> {
  const cache = edgeCache();
  if (cache && !fresh) {
    const cached = await cache.match(url).catch(() => undefined);
    if (cached) return await cached.json() as JSONWebKeySet;
  }
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new McpAuthError(`Cannot load runtime signing keys: ${error instanceof Error ? error.message : String(error)}`, 503);
  }
  if (!response.ok) throw new McpAuthError(`Cannot load runtime signing keys: HTTP ${response.status}`, 503);
  const body = await response.text();
  if (cache) {
    await cache.put(url, new Response(body, {
      headers: { ...JSON_HEADERS, "Cache-Control": `public, max-age=${JWKS_CACHE_TTL_SECONDS}` },
    })).catch(() => {});
  }
  return JSON.parse(body) as JSONWebKeySet;
}

/** Verify a runtime identity token: signature (EdDSA, runtime JWKS), issuer, audience, expiry. */
export async function verifyRuntimeToken(token: string, env: Env, audience: string): Promise<JWTPayload> {
  const url = jwksUrl(env);
  const options = { issuer: runtimeIssuer(env), audience, algorithms: ["EdDSA"], requiredClaims: ["exp", "jti"] };
  try {
    return (await jwtVerify(token, createLocalJWKSet(await loadJwks(url, false)), options)).payload;
  } catch (error) {
    if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
    return (await jwtVerify(token, createLocalJWKSet(await loadJwks(url, true)), options)).payload;
  }
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Who a verified token acts for. `ctx` was set by chiridion at agent creation
 * (the runtime signs it; agents cannot change it), but membership is checked
 * on every request so a removed user loses tool access at once.
 */
export async function authorizeRuntimeCaller(env: Env, claims: JWTPayload): Promise<RuntimeCaller> {
  const expectedTenant = env.AGENT_RUNTIME_TENANT?.trim();
  if (expectedTenant && claims.tenant !== expectedTenant) {
    throw new McpAuthError("Token is for another runtime tenant", 403);
  }
  const ctx = isRecord(claims.ctx) ? claims.ctx : {};
  const orgId = stringClaim(ctx.org);
  const workspaceId = stringClaim(ctx.workspace);
  const threadId = stringClaim(ctx.thread);
  const userId = stringClaim(claims.act) || stringClaim(claims.sub);
  if (!orgId || !workspaceId || !threadId || !userId) {
    throw new McpAuthError("Token lacks org, workspace, thread or user", 403);
  }
  const access = await getOrgStub(env, orgId).validateChatWebSocketAccess(userId, workspaceId, threadId);
  if (!access.ok || access.orgId !== orgId) {
    throw new McpAuthError(`Forbidden (${access.ok ? "org_mismatch" : access.reason})`, 403);
  }
  return { orgId, workspaceId, threadId, userId, claims };
}

export function agentMcpTools() {
  return CODE_MODE_TOOL_DEFINITIONS
    .filter((definition) => AGENT_MCP_TOOL_NAMES.has(definition.name) && !definition.hidden)
    .map((definition) => ({
      name: definition.name,
      description: definition.description,
      // TypeBox schemas are JSON Schema; the round trip drops its symbol keys.
      inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as Record<string, unknown>,
      annotations: { readOnlyHint: !definition.sideEffect },
    }));
}

/** An MCP tools/call result from the code-mode envelope. */
export function toMcpResult(envelope: Awaited<ReturnType<ToolsBinding["callToolEnvelope"]>>) {
  if (!envelope.ok) {
    return { content: [{ type: "text", text: envelope.error.message }], isError: true };
  }
  const { data } = envelope;
  const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
  return {
    content: [{ type: "text", text }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
  };
}

async function handleRpc(rpc: JsonRpcRequest, caller: RuntimeCaller, tools: ToolsFactory) {
  switch (rpc.method) {
    case "initialize":
      return jsonRpcResult(rpc.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "camelai", version: "1.0.0" },
      });
    case "ping":
      return jsonRpcResult(rpc.id, {});
    case "tools/list":
      return jsonRpcResult(rpc.id, { tools: agentMcpTools() });
    case "tools/call": {
      const params = isRecord(rpc.params) ? rpc.params : {};
      const name = typeof params.name === "string" ? params.name : "";
      if (!AGENT_MCP_TOOL_NAMES.has(name)) return jsonRpcError(rpc.id, -32602, `Unknown tool: ${name}`);
      const binding = tools({
        orgId: caller.orgId,
        workspaceId: caller.workspaceId,
        threadId: caller.threadId,
        userId: caller.userId,
        allowWebTools: false,
      });
      return jsonRpcResult(rpc.id, toMcpResult(await binding.callToolEnvelope(name, params.arguments ?? {})));
    }
    default:
      return jsonRpcError(rpc.id, -32601, "Method not found");
  }
}

function unauthorized(error: unknown): Response {
  const status = error instanceof McpAuthError ? error.status : 401;
  const message = error instanceof Error ? error.message : "Unauthorized";
  return Response.json(jsonRpcError(null, -32001, message), {
    status,
    headers: status === 401 ? { ...JSON_HEADERS, "WWW-Authenticate": 'Bearer error="invalid_token"' } : JSON_HEADERS,
  });
}

export async function handleAgentMcpRequest(req: Request, env: Env, tools: ToolsFactory): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });

  const token = req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return unauthorized(new McpAuthError("Missing runtime identity token", 401));
  let caller: RuntimeCaller;
  try {
    caller = await authorizeRuntimeCaller(env, await verifyRuntimeToken(token, env, mcpAudience(env, req)));
  } catch (error) {
    return unauthorized(error);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error"), { status: 400, headers: JSON_HEADERS });
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  if (!messages.every(isRecord)) {
    return Response.json(jsonRpcError(null, -32600, "Invalid Request"), { status: 400, headers: JSON_HEADERS });
  }
  // Notifications and responses (no id) are acknowledged without a body.
  const requests = (messages as JsonRpcRequest[]).filter((rpc) => rpc.id !== undefined);
  if (requests.length === 0) return new Response(null, { status: 202 });

  const responses = await Promise.all(requests.map((rpc) => handleRpc(rpc, caller, tools)));
  return Response.json(Array.isArray(payload) ? responses : responses[0], { headers: JSON_HEADERS });
}

export async function handleAgentMcp({ req, env, ctx }: RouteContext): Promise<Response> {
  const exports = (ctx as unknown as {
    exports: { CodeModeToolsBinding(init: { props: CodeModeToolsProps }): ToolsBinding };
  }).exports;
  return handleAgentMcpRequest(req, env, (props) => exports.CodeModeToolsBinding({ props }));
}
