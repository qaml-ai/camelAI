/**
 * The hosted agent runtime's model endpoint for chiridion's tenant
 * (`modelEndpoints.chiridion.baseUrl` = `https://<host>/agent-runtime/llm`),
 * which now serves one route: `openai-codex`, the org's ChatGPT subscription.
 * Every other provider the runtime calls itself with a key scope's keys.
 * This verifies the runtime identity token (in `X-Agent-Runtime-Identity`),
 * authorizes the caller like the MCP server, and forwards the call
 * (agent-runtime/codex-forwarder.ts, as the thread's acting user).
 */
import { RuntimeTokenError, verifyRuntimeToken } from "@camelai/agent-runtime/server";
import type { Env, RouteContext } from "../types.js";
import { authorizeRuntimeIdentity } from "./agent-mcp.js";
import { forwardRuntimeThreadCodexCall } from "../agent-runtime/thread-runtime.js";

export const AGENT_RUNTIME_LLM_BASE_PATH = "/agent-runtime/llm";
export const AGENT_RUNTIME_IDENTITY_HEADER = "X-Agent-Runtime-Identity";
const DEFAULT_RUNTIME = "https://agents.camelai.dev";

export interface AgentRuntimeLlmOptions {
  /** Where the runtime's keys are fetched from; tests pass `testRuntime().fetch`. */
  fetch?: typeof globalThis.fetch;
}

function error(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: code, code } }, { status });
}

/** The base URL the runtime is configured with, which its tokens name as their audience. */
function audience(env: Env, req: Request): string {
  return env.AGENT_RUNTIME_LLM_AUDIENCE || `${new URL(req.url).origin}${AGENT_RUNTIME_LLM_BASE_PATH}`;
}

export async function handleAgentRuntimeLlmRequest(
  req: Request,
  env: Env,
  options: AgentRuntimeLlmOptions = {},
): Promise<Response> {
  const url = new URL(req.url);
  const match = /^\/agent-runtime\/llm\/([a-z0-9-]+)\/(.+)$/.exec(url.pathname);
  if (!match) return error(404, "Not found", "not_found");
  const [, provider, path] = match;
  const tenant = env.AGENT_RUNTIME_TENANT?.trim();
  if (!tenant) return error(503, "The agent runtime is not configured", "not_configured");
  const token = req.headers.get(AGENT_RUNTIME_IDENTITY_HEADER)?.trim();
  if (!token) return error(401, `No ${AGENT_RUNTIME_IDENTITY_HEADER} token`, "invalid_token");
  let identity: Awaited<ReturnType<typeof verifyRuntimeToken>>;
  try {
    identity = await verifyRuntimeToken(token, {
      tenant,
      runtime: env.AGENT_RUNTIME_URL || DEFAULT_RUNTIME,
      audience: audience(env, req),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (cause) {
    if (cause instanceof RuntimeTokenError) return error(401, cause.message, "invalid_token");
    throw cause;
  }
  const props = await authorizeRuntimeIdentity(env, identity);
  if ("error" in props) return error(403, props.error, "forbidden");
  const caller = {
    orgId: props.orgId,
    workspaceId: props.workspaceId,
    threadId: props.threadId ?? "",
    userId: props.userId ?? "",
  };
  return forwardRuntimeThreadCodexCall(env, {
    provider,
    path,
    search: url.search,
    method: req.method,
    headers: [...req.headers],
    // Bytes, untouched: a Codex body arrives zstd-compressed.
    body: req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer(),
  }, caller);
}

export async function handleAgentRuntimeLlm({ req, env }: RouteContext): Promise<Response> {
  return handleAgentRuntimeLlmRequest(req, env);
}
