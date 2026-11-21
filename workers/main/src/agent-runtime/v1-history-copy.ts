import { Buffer } from "node:buffer";
import { parseUploadRefs } from "../../../../src/lib/chat-attachment-refs";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import { runtimeApi, runtimeUrl } from "./runtime-api";
import { attachV2Uploads, v2AgentPath, v2Json, type V2Agent } from "./runtime-v2";

export type ImportBlock = { type: string; text?: string; path?: string; volume?: string; version?: number; size?: number; contentType?: string };
export type ImportMessage = { role: string; content: string | ImportBlock[] };
export type CopiedWorkspace = {
  volume: string;
  repoId: string;
  seq: number;
  head: string;
  copiedFiles?: Map<string, { version: number; size: number }>;
};

export const HISTORY_CHUNK_TARGET_BYTES = 550 * 1024;
const MAX_SINGLE_TEXT_CHARS = 500_000;
const MAX_PINNED_IMAGE_BYTES = 3_000_000;
const MAX_AUTO_WORKSPACE_FILES = 200;
const MAX_AUTO_WORKSPACE_BYTES = 16 * 1024 * 1024;
const MAX_AUTO_SINGLE_FILE_BYTES = 4 * 1024 * 1024;
const RECENT_R2_UPLOAD_WINDOW = 20;
const WORKSPACE_COPY_CONCURRENCY = 8;
const HISTORY_PAGE_LIMIT = 500;

export function trimOversizedMessage(message: ImportMessage): ImportMessage {
  if (typeof message.content === "string") {
    return message.content.length > MAX_SINGLE_TEXT_CHARS
      ? { ...message, content: `${message.content.slice(0, MAX_SINGLE_TEXT_CHARS)}\n[truncated during migration]` }
      : message;
  }
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content = message.content.map((block) => {
    const data = (block as { data?: unknown }).data;
    if (block.type === "image" && typeof data === "string" && data.length > 500_000) {
      changed = true;
      return { ...block, data: "", omittedBytes: data.length };
    }
    if (block.type === "text" && typeof block.text === "string" && block.text.length > MAX_SINGLE_TEXT_CHARS) {
      changed = true;
      return { ...block, text: `${block.text.slice(0, MAX_SINGLE_TEXT_CHARS)}\n[truncated during migration]` };
    }
    return block;
  });
  const result = changed ? { ...message, content } : message;
  const serialized = JSON.stringify(result);
  if (serialized.length <= 750_000) return result;
  // A single message with massive tool details or multi-block payload would exceed v2's 1 MiB chunk cap.
  const slim: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  if ("details" in slim) delete slim.details;
  if (typeof slim.content === "string" && slim.content.length > 200_000) {
    slim.content = `${slim.content.slice(0, 200_000)}\n[truncated during migration]`;
  } else if (Array.isArray(slim.content)) {
    slim.content = (slim.content as Array<Record<string, unknown>>).map((block) => {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 150_000) {
        return { ...block, text: `${block.text.slice(0, 150_000)}\n[truncated during migration]` };
      }
      if (block.type === "image" && typeof block.data === "string" && block.data.length > 50_000) {
        return { ...block, data: "", omittedBytes: block.data.length };
      }
      if (block.type === "thinking") {
        const next: Record<string, unknown> = { ...block };
        if (typeof next.thinkingSignature === "string" && next.thinkingSignature.length > 50_000) {
          delete next.thinkingSignature;
        }
        if (typeof next.thinking === "string" && next.thinking.length > 150_000) {
          next.thinking = `${next.thinking.slice(0, 150_000)}\n[truncated during migration]`;
        }
        return next;
      }
      if (block.type === "toolCall" && block.arguments && JSON.stringify(block.arguments).length > 150_000) {
        return { ...block, arguments: { _truncated: true } };
      }
      return block;
    });
  }
  return slim as unknown as ImportMessage;
}

export async function readV1HistoryTotal(env: ChatEnv, agentPath: string): Promise<number> {
  const page = await runtimeApi(env, "GET", `${agentPath}/history?after=0&limit=1`) as {
    total: number;
    truncated: boolean;
  };
  if (page.truncated) throw new Error("V1 history is truncated");
  return page.total;
}

export async function copyV1WorkspaceToV2Repo(
  env: ChatEnv,
  v1AgentId: string,
  v2AgentId: string,
): Promise<CopiedWorkspace | undefined> {
  const mounts = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(v1AgentId)}/mounts`).catch(() => null) as
    Array<{ volumeId: string; path: string; mode: string; subpath?: string }> | null;
  const mount = mounts?.find((m) => m.path === "/workspace" && !m.subpath);
  if (!mount?.volumeId) return undefined;

  const volPath = `/v1/volumes/${encodeURIComponent(mount.volumeId)}`;
  const volInfo = await runtimeApi(env, "GET", volPath).catch(() => null) as { seq?: number } | null;
  if (!volInfo) return undefined;

  const listed: Array<{ path: string; version: number; size: number }> = [];
  let after: string | undefined;
  while (listed.length < MAX_AUTO_WORKSPACE_FILES) {
    const query = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) });
    const page = await runtimeApi(env, "GET", `${volPath}/files?${query}`).catch(() => null) as {
      files?: Array<{ path: string; version: number; size: number }>;
      next?: string;
    } | null;
    if (!page?.files?.length) break;
    listed.push(...page.files);
    after = page.next;
    if (!after) break;
  }
  if (!listed.length) return undefined;

  const repo = await v2Json<{ repoId: string; branch: string }>(env, v2AgentPath(v2AgentId) + "/repo", { method: "PUT" });
  const puts: Array<{ path: string; base64: string }> = [];
  const pendingMeta: Array<{ path: string; version: number; size: number }> = [];
  const copiedFiles = new Map<string, { version: number; size: number }>();
  let batchBytes = 0;
  let totalBytes = 0;
  let head = "";

  const flush = async () => {
    if (!puts.length) return;
    const batchPuts = puts.splice(0, puts.length);
    const batchMeta = pendingMeta.splice(0, pendingMeta.length);
    const res = await v2Json<{ commit: string }>(env, `/repos/${encodeURIComponent(repo.repoId)}/write`, {
      method: "POST",
      body: { ref: repo.branch, puts: batchPuts, message: `Migrate v1 workspace ${mount.volumeId}` },
    });
    head = res.commit;
    for (const m of batchMeta) copiedFiles.set(m.path, { version: m.version, size: m.size });
    batchBytes = 0;
  };

  const candidates: Array<{ cleanPath: string; version: number; size: number }> = [];
  let plannedBytes = 0;
  for (const entry of listed.slice(0, MAX_AUTO_WORKSPACE_FILES)) {
    const cleanPath = entry.path.replace(/^\/+/, "");
    if (!cleanPath || entry.size > MAX_AUTO_SINGLE_FILE_BYTES) continue;
    if (plannedBytes + entry.size > MAX_AUTO_WORKSPACE_BYTES) break;
    plannedBytes += entry.size;
    candidates.push({ cleanPath, version: entry.version, size: entry.size });
  }

  for (let i = 0; i < candidates.length; i += WORKSPACE_COPY_CONCURRENCY) {
    const slice = candidates.slice(i, i + WORKSPACE_COPY_CONCURRENCY);
    const fetched = await Promise.all(slice.map(async (entry) => {
      const encodedPath = entry.cleanPath.split("/").map(encodeURIComponent).join("/");
      const fileRes = await fetch(`${runtimeUrl(env)}${volPath}/files/${encodedPath}`, {
        headers: { Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}` },
        redirect: "manual",
      }).catch(() => null);
      if (!fileRes?.ok) {
        await fileRes?.body?.cancel().catch(() => {});
        return null;
      }
      const bytes = new Uint8Array(await fileRes.arrayBuffer());
      return { entry, bytes };
    }));
    for (const item of fetched) {
      if (!item) continue;
      if (totalBytes + item.bytes.byteLength > MAX_AUTO_WORKSPACE_BYTES) continue;
      totalBytes += item.bytes.byteLength;
      const b64 = Buffer.from(item.bytes).toString("base64");
      if (puts.length > 0 && batchBytes + b64.length > 3 * 1024 * 1024) {
        await flush();
      }
      puts.push({ path: item.entry.cleanPath, base64: b64 });
      pendingMeta.push({ path: item.entry.cleanPath, version: item.entry.version, size: item.bytes.byteLength });
      batchBytes += b64.length;
    }
  }
  await flush();
  if (!head) return undefined;
  return { volume: mount.volumeId, repoId: repo.repoId, seq: Number(volInfo.seq ?? 0), head, copiedFiles };
}

export async function pinnedV1Files(env: ChatEnv, files: ImportBlock[], workspace: CopiedWorkspace | undefined) {
  let imageBytes = 0;
  const pinned: Array<{ path: string; contentType: string; commit: string }> = [];
  for (const file of files) {
    if (!workspace || file.volume !== workspace.volume || !file.path?.startsWith("/workspace/") ||
        !Number.isSafeInteger(file.version) || !Number.isSafeInteger(file.size) || !file.contentType) {
      continue;
    }
    const isImage = /^image\/(png|jpeg|gif|webp)$/i.test(file.contentType);
    if (isImage && ((file.size ?? 0) <= 0 || imageBytes + (file.size ?? 0) > MAX_PINNED_IMAGE_BYTES)) {
      continue;
    }
    const cleanPath = file.path.slice("/workspace/".length).replace(/^\/+/, "");
    if (!cleanPath) continue;
    if (workspace.copiedFiles) {
      const copied = workspace.copiedFiles.get(cleanPath);
      if (!copied || copied.version !== file.version || copied.size !== file.size) continue;
      if (isImage) imageBytes += copied.size;
      pinned.push({ path: cleanPath, contentType: file.contentType, commit: workspace.head });
      continue;
    }
    const path = `/${cleanPath}`;
    const query = new URLSearchParams({ prefix: path, limit: "1" });
    const entry = await runtimeApi(env, "GET", `/v1/volumes/${encodeURIComponent(workspace.volume)}/files?${query}`) as {
      files: Array<{ path: string; version: number; size: number }>;
    };
    const current = entry.files[0];
    if (current?.path !== path || current.version !== file.version || current.size !== file.size) {
      continue;
    }
    if (isImage) imageBytes += current.size;
    pinned.push({ path: cleanPath, contentType: file.contentType, commit: workspace.head });
  }
  return pinned;
}

async function resolveMessageAttachments(
  env: ChatEnv,
  context: ChatContextState,
  agentId: string,
  messageIndex: number,
  totalMessages: number,
  message: ImportMessage,
  uploadPrefix: string,
  workspace?: CopiedWorkspace,
): Promise<Array<{ path: string; contentType: string; commit: string }>> {
  if (message.role !== "user" && message.role !== "toolResult") return [];
  const nativeFiles = Array.isArray(message.content) ? message.content.filter(block => block.type === "file") : [];
  if (nativeFiles.length) {
    return await pinnedV1Files(env, nativeFiles, workspace).catch(() => []);
  }
  if (message.role !== "user") return [];
  if (totalMessages - messageIndex > RECENT_R2_UPLOAD_WINDOW) return [];
  const text = typeof message.content === "string" ? message.content :
    message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  if (!parseUploadRefs(text).refs.some(ref => ref.kind === "user_upload")) return [];
  return await attachV2Uploads(env, context, agentId, `${uploadPrefix}-${messageIndex}`, text).catch(() => []);
}

export async function streamV1HistoryToV2(
  env: ChatEnv,
  context: ChatContextState,
  sourcePath: string,
  agentId: string,
  source: string,
  totalMessages: number,
  uploadPrefix: string,
  workspace?: CopiedWorkspace,
  existingCount = 0,
) {
  const agentPath = v2AgentPath(agentId);
  const encoder = new TextEncoder();
  let offset = 0;
  let finalCount = 0;
  let previous: string | undefined;
  if (existingCount > 0) {
    const proof = await v2Json<{ source: string; receipt: string; messageCount: number }>(env, agentPath + "/history/import")
      .catch(() => null);
    if (proof && proof.source === source && proof.messageCount > 0 && proof.messageCount <= totalMessages) {
      if (proof.messageCount === totalMessages) {
        return { messagesWithAttachments: 0 };
      }
      offset = proof.messageCount;
      finalCount = proof.messageCount;
      previous = proof.receipt;
    }
  }
  if (totalMessages === 0) {
    const receipt = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import", {
      method: "PUT",
      body: { source, messages: [], attachments: [], repair: true },
    });
    if (!receipt.receipt) throw new Error("Incomplete v2 import receipt");
    return { messagesWithAttachments: 0 };
  }

  let chunkMessages: ImportMessage[] = [];
  let chunkAttachments: Array<{ messageIndex: number; files: Array<{ path: string; contentType: string; commit: string }> }> = [];
  let chunkBytes = 256;
  let messagesWithAttachments = 0;

  const flushChunk = async () => {
    if (!chunkMessages.length) return;
    let res: { count: number; receipt: string };
    try {
      res = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import/chunk", {
        method: "PUT",
        body: {
          source,
          ...(previous ? { previous } : {}),
          appendAfter: finalCount,
          messages: chunkMessages,
          attachments: chunkAttachments,
          repair: true,
        },
      });
    } catch (error) {
      // Historical v1 attachments occasionally have mismatched MIME/magic bytes or oversized images;
      // drop pinned attachments on this chunk rather than blocking the user's entire chat history.
      if (!chunkAttachments.length) throw error;
      console.warn("[v1-history-copy] chunk import failed with attachments, retrying without attachments", {
        agentId,
        appendAfter: finalCount,
        attachments: chunkAttachments.length,
        error: error instanceof Error ? error.message : String(error),
      });
      res = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import/chunk", {
        method: "PUT",
        body: {
          source,
          ...(previous ? { previous } : {}),
          appendAfter: finalCount,
          messages: chunkMessages,
          attachments: [],
          repair: true,
        },
      });
    }
    if (!res.receipt) throw new Error("Incomplete v2 chunk receipt");
    previous = res.receipt;
    finalCount = res.count;
    chunkMessages = [];
    chunkAttachments = [];
    chunkBytes = 256;
  };

  let cursor = offset;
  while (cursor < totalMessages) {
    const page = await runtimeApi(env, "GET", `${sourcePath}/history?after=${cursor}&limit=${HISTORY_PAGE_LIMIT}`) as {
      entries: Array<{ index: number; message: ImportMessage }>;
      total: number;
      truncated: boolean;
      nextAfter: number;
    };
    if (page.truncated || page.total !== totalMessages || cursor + page.entries.length > totalMessages) {
      throw new Error("V1 history changed or has a gap");
    }
    if (!page.entries.length) break;
    for (const { index, message } of page.entries) {
      if (index !== cursor) throw new Error("V1 history is missing a message");
      const trimmed = trimOversizedMessage(message);
      const att = await resolveMessageAttachments(env, context, agentId, cursor, totalMessages, trimmed, uploadPrefix, workspace);
      const est = encoder.encode(JSON.stringify(trimmed)).byteLength + (att.length ? encoder.encode(JSON.stringify(att)).byteLength + 64 : 0) + 16;
      if (chunkMessages.length > 0 && chunkBytes + est > HISTORY_CHUNK_TARGET_BYTES) {
        await flushChunk();
      }
      if (att.length) {
        chunkAttachments.push({ messageIndex: chunkMessages.length, files: att });
        messagesWithAttachments += 1;
      }
      chunkMessages.push(trimmed);
      chunkBytes += est;
      cursor += 1;
    }
    if (page.nextAfter !== cursor) throw new Error("V1 history cursor did not advance");
  }
  await flushChunk();
  const state = await v2Json<V2Agent & { messageCount: number }>(env, agentPath);
  if (state.messageCount !== finalCount) {
    throw new Error("The copied chat history does not match its source");
  }
  return { messagesWithAttachments };
}
