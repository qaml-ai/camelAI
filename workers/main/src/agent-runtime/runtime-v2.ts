import { Buffer } from "node:buffer";
import { parseUploadRefs } from "../../../../src/lib/chat-attachment-refs";
import { getMimeType } from "../../../../src/lib/file-content-headers";
import { buildWorkspaceScopedR2Key } from "../../../../src/lib/workspace-r2-paths";
import { RUNTIME_TOOL_SERVER } from "../../../../src/lib/agent-runtime-shared";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import { isUnsafeUploadPath } from "../file-safety";
import {
  detectSupportedImageMimeType,
  normalizeImageMimeType,
} from "../image-tool-content";
import { RuntimeApiError, v2RuntimeUrl } from "./runtime-api";
import { v2WireKeyScope } from "./model-routes";
import { runtimeSystemPromptAppend } from "./run-gates";

const MAX_ATTACHMENTS = 20;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Match CamelRun v2's FILE_LIMITS.requestImageBytes / requestImageBase64Bytes. */
export const V2_REQUEST_IMAGE_BYTES = Math.floor(3.75 * 1024 * 1024);
export const V2_REQUEST_IMAGE_BASE64_BYTES = 20 * 1024 * 1024;
const MAX_RESIZABLE_IMAGE_BYTES = 32 * 1024 * 1024;

const V2_IMAGE_RESIZE_CANDIDATES = [
  { maxSide: 1568, quality: 80 },
  { maxSide: 1280, quality: 75 },
  { maxSide: 1024, quality: 70 },
  { maxSide: 768, quality: 60 },
] as const;

export function isV2NativeImageContentType(contentType: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(normalizeImageMimeType(contentType));
}

function imageBase64Size(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function replaceFilenameExtension(name: string, nextExtension: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0) return `${name}${nextExtension}`;
  return `${name.slice(0, lastDot)}${nextExtension}`;
}

async function resizeImageStreamForV2(
  images: ImagesBinding,
  getStream: (attempt: number) => Promise<ReadableStream<Uint8Array> | null>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; contentType: "image/jpeg" } | null> {
  if (maxBytes <= 0) return null;
  for (const [attempt, candidate] of V2_IMAGE_RESIZE_CANDIDATES.entries()) {
    const stream = await getStream(attempt);
    if (!stream) return null;
    try {
      const output = await images
        .input(stream)
        .transform({
          width: candidate.maxSide,
          height: candidate.maxSide,
          fit: "scale-down",
        })
        .output({
          format: "image/jpeg",
          quality: candidate.quality,
          anim: false,
        });
      const response = output.response();
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (
        bytes.byteLength > 0 &&
        bytes.byteLength <= maxBytes &&
        detectSupportedImageMimeType(bytes) === "image/jpeg"
      ) {
        return { bytes, contentType: "image/jpeg" };
      }
    } catch {
      // Try a smaller/more compressed candidate if available.
    }
  }
  return null;
}

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
  // Workers supports manual redirects. Stop here so the tenant key stays on the runtime origin.
  const response = await fetch(v2RuntimeUrl(env) + path, { ...init, headers, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new RuntimeApiError("camelRun v2 returned an unexpected redirect", 502, "v2_runtime_redirect");
  }
  return response;
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

export async function createV2ThreadAgent(
  env: ChatEnv,
  context: ChatContextState,
  subject: string,
  model: string,
  key = `chiridion-thread-${context.threadId}`,
  keyScope?: string | null,
) {
  if (!env.WORKER_BASE_URL || !env.AGENT_RUNTIME_V2_TENANT || !env.AGENT_RUNTIME_V2_EVENTS_WEBHOOK_SECRET) {
    throw new RuntimeApiError("Chiridion's v2 tenant and callback URLs are required", 503, "v2_not_configured");
  }
  const url = new URL("/mcp/agent/v2", env.WORKER_BASE_URL).toString();
  const wireKeyScope = v2WireKeyScope(keyScope);
  const agent = await v2Json<{ id: string }>(env, v2AgentPath(key), {
    method: "PUT",
    body: {
      model,
      ...(wireKeyScope ? { keyScope: wireKeyScope } : keyScope === null ? { keyScope: null } : {}),
      instructions: runtimeSystemPromptAppend(env, context, "v2"),
      builtins: ["codemode", "web_search", "web_fetch", "human"],
      mcpServers: [{ name: RUNTIME_TOOL_SERVER, url, audience: url, auth: { type: "runtime" } }],
      toolIdentity: { subject, context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId } },
    },
  });
  if (!agent.id) throw new RuntimeApiError("camelRun v2 returned no agent id", 502);
  return agent.id;
}

/**
 * Uploads live in R2. Each run pins an immutable repository commit for its
 * attachments (best effort, matching v1: oversized images are automatically
 * scaled down to fit CamelRun v2's model request image limit via `env.IMAGES`,
 * and unattachable or too-large files stay referenced via R2 `uploads/...` in
 * the prompt rather than failing or bricking the thread).
 */
export async function attachV2Uploads(
  env: ChatEnv,
  context: ChatContextState,
  agentId: string,
  requestId: string,
  text: string,
) {
  const refs = parseUploadRefs(text).refs
    .filter((ref) => ref.kind === "user_upload")
    .slice(0, MAX_ATTACHMENTS);
  if (!refs.length) return [];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
    throw new RuntimeApiError("Invalid v2 attachment request ID", 400, "invalid_attachments");
  }

  const puts: Array<{ path: string; base64: string }> = [];
  const files: Array<{ path: string; contentType: string }> = [];
  let repoBytes = 0;
  let imageBase64Bytes = 0;

  for (const [index, ref] of refs.entries()) {
    if (isUnsafeUploadPath(ref.filename)) continue;
    const r2Key = buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, `user-uploads/${ref.filename}`);
    const object = await env.R2_BUCKET.get(r2Key);
    if (!object) continue;
    if (object.size <= 0) {
      await object.body.cancel().catch(() => {});
      continue;
    }

    const rawHeaderType = object.httpMetadata?.contentType?.split(";")[0]?.trim() || "";
    const declaredType = normalizeImageMimeType(rawHeaderType || getMimeType(ref.originalName) || "application/octet-stream");
    const isImageCandidate = declaredType.startsWith("image/") && declaredType !== "image/svg+xml";
    const baseName = ref.originalName.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-100) || "file";

    const remainingRepoBytes = MAX_FILE_BYTES - repoBytes;
    if (remainingRepoBytes <= 0) {
      await object.body.cancel().catch(() => {});
      break;
    }

    if (isImageCandidate) {
      const remainingImageBase64Bytes = V2_REQUEST_IMAGE_BASE64_BYTES - imageBase64Bytes;
      const remainingImageRawBytes = Math.floor(remainingImageBase64Bytes / 4) * 3;
      const imageByteBudget = Math.min(V2_REQUEST_IMAGE_BYTES, remainingRepoBytes, remainingImageRawBytes);

      if (object.size > MAX_RESIZABLE_IMAGE_BYTES || imageByteBudget <= 0) {
        await object.body.cancel().catch(() => {});
        console.warn("[runtime-v2] skipping oversized image attachment beyond resize budget", {
          file: ref.filename,
          size: object.size,
          imageByteBudget,
        });
        continue;
      }

      if (object.size > imageByteBudget) {
        if (!env.IMAGES) {
          await object.body.cancel().catch(() => {});
          console.warn("[runtime-v2] skipping oversized image attachment (IMAGES binding unavailable)", {
            file: ref.filename,
            size: object.size,
            imageByteBudget,
          });
          continue;
        }
        let initialConsumed = false;
        const resized = await resizeImageStreamForV2(
          env.IMAGES,
          async (attempt) => {
            if (attempt === 0) {
              initialConsumed = true;
              return object.body;
            }
            const retryObject = await env.R2_BUCKET.get(r2Key);
            return retryObject?.body ?? null;
          },
          imageByteBudget,
        );
        if (!initialConsumed) {
          await object.body.cancel().catch(() => {});
        }
        if (!resized) {
          console.warn("[runtime-v2] skipping oversized image attachment after resize attempts failed", {
            file: ref.filename,
            size: object.size,
            imageByteBudget,
          });
          continue;
        }
        const resizedName = replaceFilenameExtension(baseName, ".jpg");
        const path = `uploads/${requestId}/${index + 1}-${resizedName}`;
        puts.push({ path, base64: Buffer.from(resized.bytes).toString("base64") });
        files.push({ path, contentType: resized.contentType });
        repoBytes += resized.bytes.byteLength;
        imageBase64Bytes += imageBase64Size(resized.bytes.byteLength);
        continue;
      }

      const rawBytes = new Uint8Array(await object.arrayBuffer());
      const detected = detectSupportedImageMimeType(rawBytes);
      if (detected) {
        const path = `uploads/${requestId}/${index + 1}-${baseName}`;
        puts.push({ path, base64: Buffer.from(rawBytes).toString("base64") });
        files.push({ path, contentType: detected });
        repoBytes += rawBytes.byteLength;
        imageBase64Bytes += imageBase64Size(rawBytes.byteLength);
        continue;
      }

      // Bytes do not match a v2-native image header (e.g. BMP/AVIF/APNG or mislabeled file).
      // Try transcoding via IMAGES so the model can still view it; otherwise downgrade to octet-stream
      // so CamelRun v2 does not reject the turn with 422 attachment_invalid.
      if (env.IMAGES) {
        const transcoded = await resizeImageStreamForV2(
          env.IMAGES,
          async () => streamFromBytes(rawBytes),
          imageByteBudget,
        );
        if (transcoded) {
          const resizedName = replaceFilenameExtension(baseName, ".jpg");
          const path = `uploads/${requestId}/${index + 1}-${resizedName}`;
          puts.push({ path, base64: Buffer.from(transcoded.bytes).toString("base64") });
          files.push({ path, contentType: transcoded.contentType });
          repoBytes += transcoded.bytes.byteLength;
          imageBase64Bytes += imageBase64Size(transcoded.bytes.byteLength);
          continue;
        }
      }

      const path = `uploads/${requestId}/${index + 1}-${baseName}`;
      puts.push({ path, base64: Buffer.from(rawBytes).toString("base64") });
      files.push({ path, contentType: "application/octet-stream" });
      repoBytes += rawBytes.byteLength;
      continue;
    }

    if (object.size > remainingRepoBytes) {
      await object.body.cancel().catch(() => {});
      console.warn("[runtime-v2] skipping large non-image attachment; remains readable via R2", {
        file: ref.filename,
        size: object.size,
        remainingRepoBytes,
      });
      continue;
    }

    const rawBytes = new Uint8Array(await object.arrayBuffer());
    const path = `uploads/${requestId}/${index + 1}-${baseName}`;
    let contentType = declaredType || "application/octet-stream";
    if (contentType === "application/octet-stream") {
      const detected = detectSupportedImageMimeType(rawBytes);
      const remainingImageRawBytes = Math.floor((V2_REQUEST_IMAGE_BASE64_BYTES - imageBase64Bytes) / 4) * 3;
      if (detected && rawBytes.byteLength <= Math.min(V2_REQUEST_IMAGE_BYTES, remainingImageRawBytes)) {
        contentType = detected;
        imageBase64Bytes += imageBase64Size(rawBytes.byteLength);
      }
    }
    puts.push({ path, base64: Buffer.from(rawBytes).toString("base64") });
    files.push({ path, contentType });
    repoBytes += rawBytes.byteLength;
  }

  if (!puts.length) return [];

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
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Length": String(result.size),
      "Content-Type": getMimeType(volumePath),
    });
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
