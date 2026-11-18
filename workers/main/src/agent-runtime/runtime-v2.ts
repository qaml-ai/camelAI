import { Buffer } from "node:buffer";
import { parseUploadRefs } from "../../../../src/lib/chat-attachment-refs";
import { buildWorkspaceScopedR2Key } from "../../../../src/lib/workspace-r2-paths";
import { RUNTIME_TOOL_SERVER } from "../../../../src/lib/agent-runtime-shared";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import { isUnsafeUploadPath } from "../file-safety";
import { RuntimeApiError } from "./runtime-api";
import { runtimeSystemPromptAppend } from "./run-gates";

export const V2_RUNTIME_URL = "https://run.camelai.com/v2";
export const V2_BROWSER_SESSION = "chiridion-v2-session";
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface V2Input {
  id: string;
  toolCallId: string;
  kind: "approval" | "question";
  status: string;
  prompt: { message?: string; question?: string; options?: string[]; elicitation?: { mode: "form" | "url"; url?: string; requestedSchema?: Record<string, unknown> } };
  expiresAt: number;
}

export interface V2Run {
  id: string;
  actor?: string;
  idempotencyKey: string | null;
  status: "queued" | "running" | "input_required" | "completed" | "failed" | "cancelled";
  inputs: V2Input[];
  startedAt: number;
  error: { code: string; message: string } | null;
}

export interface V2Agent {
  id: string;
  activeRunId: string | null;
  lastRun: V2Run | null;
  repoId: string | null;
  branch: string;
}

export const v2AgentPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}`;

export async function v2Fetch(
  env: ChatEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = env.AGENT_RUNTIME_V2_API_TOKEN?.trim();
  if (!token) throw new RuntimeApiError("Chiridion's v2 tenant key is missing", 503, "v2_not_configured");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(V2_RUNTIME_URL + path, { ...init, headers, redirect: "error" });
}

export async function v2Json<T>(
  env: ChatEnv,
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = "GET", body, signal } = options;
  const response = await v2Fetch(env, path, { method, signal, ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new RuntimeApiError(error?.error?.message ?? `camelRun v2 returned HTTP ${response.status}`, response.status, error?.error?.code);
  }
  return await response.json() as T;
}

export async function createV2ThreadAgent(env: ChatEnv, context: ChatContextState, subject: string, model: string) {
  if (!env.WORKER_BASE_URL || !env.AGENT_RUNTIME_V2_TENANT || !env.AGENT_RUNTIME_V2_EVENTS_WEBHOOK_SECRET) {
    throw new RuntimeApiError("Chiridion's v2 tenant and callback URLs are required", 503, "v2_not_configured");
  }
  const url = new URL("/mcp/agent/v2", env.WORKER_BASE_URL).toString();
  const agent = await v2Json<{ id: string }>(env, v2AgentPath(`chiridion-thread-${context.threadId}`), {
    method: "PUT",
    body: {
      model,
      instructions: runtimeSystemPromptAppend(env, context, "v2"),
      builtins: ["codemode", "web_search", "web_fetch", "human"],
      mcpServers: [{ name: RUNTIME_TOOL_SERVER, url, audience: url, auth: { type: "runtime" } }],
      toolIdentity: { subject, context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId } },
    },
  });
  if (!agent.id) throw new RuntimeApiError("camelRun v2 returned no agent id", 502);
  return agent.id;
}

/** Uploads live in R2. Each run pins an immutable repository commit for its attachments. */
export async function attachV2Uploads(
  env: ChatEnv,
  context: ChatContextState,
  agentId: string,
  requestId: string,
  text: string,
) {
  const refs = parseUploadRefs(text).refs.filter((ref) => ref.kind === "user_upload");
  if (!refs.length) return [];
  if (refs.length > 20 || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
    throw new RuntimeApiError("Invalid v2 attachment count or request ID", 400, "invalid_attachments");
  }
  const puts: Array<{ path: string; base64: string }> = [];
  const files: Array<{ path: string; contentType: string }> = [];
  let bytes = 0;
  for (const [index, ref] of refs.entries()) {
    if (isUnsafeUploadPath(ref.filename)) throw new RuntimeApiError("Invalid upload path", 400, "invalid_attachment");
    const object = await env.R2_BUCKET.get(buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, `user-uploads/${ref.filename}`));
    if (!object) throw new RuntimeApiError("A message attachment is missing", 404, "attachment_missing");
    bytes += object.size;
    // Leave headroom in the Worker for the base64 encoding and serialized request.
    if (bytes > MAX_FILE_BYTES) {
      await object.body.cancel();
      throw new RuntimeApiError("Test workspace attachments are limited to 8 MiB per message", 413, "attachments_too_large");
    }
    const name = ref.originalName.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-100) || "file";
    const path = `uploads/${requestId}/${index + 1}-${name}`;
    const base64 = Buffer.from(await object.arrayBuffer()).toString("base64");
    puts.push({ path, base64 });
    files.push({ path, contentType: object.httpMetadata?.contentType?.split(";")[0] || "application/octet-stream" });
  }
  const repo = await v2Json<{ repoId: string; branch: string }>(env, v2AgentPath(agentId) + "/repo", { method: "PUT" });
  const { commit } = await v2Json<{ commit: string }>(env, `/repos/${encodeURIComponent(repo.repoId)}/write`, {
    method: "POST",
    body: { ref: repo.branch, puts, message: "Chiridion message attachments" },
  });
  if (!commit) throw new RuntimeApiError("camelRun v2 returned no attachment commit", 502);
  return files.map((file) => ({ ...file, commit }));
}

export async function fetchV2Scratch(
  env: ChatEnv,
  agentId: string,
  volumePath: string,
  range?: string | null,
): Promise<Response> {
  const { repoId, branch } = await v2Json<V2Agent>(env, v2AgentPath(agentId));
  if (!repoId) return new Response(null, { status: 404 });
  const query = new URLSearchParams({ path: volumePath.replace(/^\//, ""), at: branch, limit: String(MAX_FILE_BYTES + 1) });
  try {
    const result = await v2Json<{ size: number; content: string | null; base64: string | null; commit: string }>(
      env, `/repos/${encodeURIComponent(repoId)}/files?${query}`,
    );
    if (result.size > MAX_FILE_BYTES) return new Response(null, { status: 413 });
    const bytes = result.base64 === null ? new TextEncoder().encode(result.content ?? "") : new Uint8Array(Buffer.from(result.base64, "base64"));
    if (bytes.byteLength !== result.size) throw new RuntimeApiError("camelRun v2 returned an incomplete file", 502);
    const headers = new Headers({ "Accept-Ranges": "bytes", "Content-Length": String(result.size) });
    if (!range) return new Response(bytes, { headers });
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, result.size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(result.size - 1, Number(match[2])) : result.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${result.size}` } });
    }
    headers.set("Content-Length", String(end - start + 1));
    headers.set("Content-Range", `bytes ${start}-${end}/${result.size}`);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 404) return new Response(null, { status: 404 });
    throw error;
  }
}
