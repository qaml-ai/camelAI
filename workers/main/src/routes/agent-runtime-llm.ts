/**
 * Inference proxy for the hosted agent runtime: an OpenAI-compatible
 * `POST /agent-runtime/llm/v1/chat/completions` (streaming) that the runtime
 * calls for every model request of chiridion's agents, authenticated with the
 * same runtime identity token as the MCP server. The request runs in the
 * thread's ChatThreadDO (`runtimeChatCompletion`), which applies chiridion's
 * model routing (BYOK, Bedrock, Codex, hosted gateway), the credit and
 * per-user gates, and usage metering, as the user acting in the turn.
 */
import { RuntimeTokenError, bearerToken, verifyRuntimeToken } from "@camelai/agent-runtime/server";
import type { Env, RouteContext } from "../types.js";
import { authorizeRuntimeIdentity } from "./agent-mcp.js";

export const AGENT_RUNTIME_LLM_BASE_PATH = "/agent-runtime/llm/v1";
const DEFAULT_RUNTIME = "https://agents.camelai.dev";

export interface AgentRuntimeLlmOptions {
  /** Where the runtime's keys are fetched from; tests pass `testRuntime().fetch`. */
  fetch?: typeof globalThis.fetch;
}

function openAiError(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, type: code, code } }, { status });
}

/** The URLs tokens may name: the base URL the runtime is configured with, or the endpoint itself. */
function audiences(env: Env, req: Request): string[] {
  if (env.AGENT_RUNTIME_LLM_AUDIENCE) return [env.AGENT_RUNTIME_LLM_AUDIENCE];
  const url = new URL(req.url);
  const base = `${url.origin}${AGENT_RUNTIME_LLM_BASE_PATH}`;
  return [base, `${base}/chat/completions`];
}

export async function handleAgentRuntimeLlmRequest(
  req: Request,
  env: Env,
  options: AgentRuntimeLlmOptions = {},
): Promise<Response> {
  if (req.method !== "POST") return openAiError(405, "Use POST", "method_not_allowed");
  const token = bearerToken(req);
  if (!token) return openAiError(401, "No bearer token", "invalid_token");
  let identity: Awaited<ReturnType<typeof verifyRuntimeToken>>;
  try {
    identity = await verifyRuntimeToken(token, {
      runtime: env.AGENT_RUNTIME_URL || DEFAULT_RUNTIME,
      audience: audiences(env, req),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  } catch (error) {
    if (error instanceof RuntimeTokenError) return openAiError(401, error.message, "invalid_token");
    throw error;
  }
  const props = await authorizeRuntimeIdentity(env, identity);
  if ("error" in props) return openAiError(403, props.error, "forbidden");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return openAiError(400, "The body must be JSON", "invalid_request_error");
  }
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(props.threadId)) as unknown as {
    runtimeChatCompletion(
      body: unknown,
      caller: { orgId: string; workspaceId: string; threadId: string; userId: string },
    ): Promise<Response>;
  };
  return stub.runtimeChatCompletion(body, {
    orgId: props.orgId,
    workspaceId: props.workspaceId,
    threadId: props.threadId ?? "",
    userId: props.userId ?? "",
  });
}

export async function handleAgentRuntimeLlm({ req, env }: RouteContext): Promise<Response> {
  return handleAgentRuntimeLlmRequest(req, env);
}
