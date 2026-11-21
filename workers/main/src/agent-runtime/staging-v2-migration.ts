import { WorkerEntrypoint } from "cloudflare:workers";
import { parseUploadRefs } from "../../../../src/lib/chat-attachment-refs";
import { retryTransientDurableObjectRpc } from "../../../../src/lib/do-rpc-retry.server";
import { CAMEL_CODE_LLM_MODEL } from "../../../../src/lib/llm-provider-config";
import { getChannelThreadMapKey } from "../channels";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import type { Env } from "../types";
import { channelHandoffBinding, channelHandoffOwner, type HandoffChannel } from "./channel-handoff";
import type { OrgThread, ThreadRuntimeRecord } from "../identity/org-do";
import { HOSTED_KEY_SCOPE } from "./key-scopes";
import { CAMEL_CODE_RUNTIME_MODEL, isPreviousCamelCodeRuntimeModel, v2ByokEnabled, v2HostedModelMatches, v2RouteSupported } from "./model-routes";
import { resolveThreadRuntimeRoute, runtimeAgentModel, RuntimeRunRefused, syncV2RouteKeyScope } from "./run-gates";
import { runtimeApi, runtimeUrl, RuntimeApiError, v2WorkspaceEnabled } from "./runtime-api";
import { attachV2Uploads, createV2ThreadAgent, v2AgentPath, v2Json, type V2Agent } from "./runtime-v2";
import { MAX_IMPORT_BYTES, migrationSubject } from "./thread-migration";
import { RUNTIME_PROMPT_VERSION } from "./runtime-prompt";

type ImportBlock = { type: string; text?: string; path?: string; volume?: string; version?: number; size?: number; contentType?: string };
type ImportMessage = { role: string; content: string | ImportBlock[] };
type CopiedWorkspace = { volume: string; repoId: string; seq: number; head: string };
type HandoffSelection = { expectedThreadModel?: string };
type V1Handoff = HandoffSelection & ({ phase: "inspect" } | { phase: "prepare" } | {
  phase: "publish";
  fencedAgentId: string;
  workspace?: CopiedWorkspace;
}) & { channel?: HandoffChannel };

const HISTORY_CHUNK_TARGET_BYTES = 550 * 1024;
const MAX_SINGLE_TEXT_CHARS = 500_000;
const MAX_PINNED_IMAGE_BYTES = 3_000_000;

function trimOversizedMessage(message: ImportMessage): ImportMessage {
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
  return changed ? { ...message, content } : message;
}

async function v1ThreadHandoffBinding(
  env: ChatEnv, orgId: string, thread: OrgThread, row: ThreadRuntimeRecord, channel: HandoffChannel | undefined,
) {
  if (channel === undefined) return thread.source === "channel" || thread.channel_kind ? false : null;
  if (!v2ByokEnabled(env) && (thread.model !== CAMEL_CODE_LLM_MODEL || !isPreviousCamelCodeRuntimeModel(row.model))) return false;
  const binding = channelHandoffBinding(thread, channel);
  return binding && await env.APP_KV.get(getChannelThreadMapKey({
    ...binding, orgId, workspaceId: thread.workspace_id,
  })) === thread.id ? binding : false;
}


async function readV1HistoryTotal(env: ChatEnv, agentPath: string): Promise<number> {
  const page = await runtimeApi(env, "GET", `${agentPath}/history?after=0&limit=1`) as {
    total: number;
    truncated: boolean;
  };
  if (page.truncated) throw new Error("V1 history is truncated");
  return page.total;
}

async function resolveMessageAttachments(
  env: ChatEnv,
  context: ChatContextState,
  agentId: string,
  messageIndex: number,
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
  const text = typeof message.content === "string" ? message.content :
    message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  if (!parseUploadRefs(text).refs.some(ref => ref.kind === "user_upload")) return [];
  return await attachV2Uploads(env, context, agentId, `${uploadPrefix}-${messageIndex}`, text).catch(() => []);
}

async function streamV1HistoryToV2(
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
    const res = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import/chunk", {
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
    if (!res.receipt) throw new Error("Incomplete v2 chunk receipt");
    previous = res.receipt;
    finalCount = res.count;
    chunkMessages = [];
    chunkAttachments = [];
    chunkBytes = 256;
  };

  let cursor = offset;
  while (cursor < totalMessages) {
    const page = await runtimeApi(env, "GET", `${sourcePath}/history?after=${cursor}&limit=100`) as {
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
      const att = await resolveMessageAttachments(env, context, agentId, cursor, trimmed, uploadPrefix, workspace);
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

async function pinnedV1Files(env: ChatEnv, files: ImportBlock[], workspace: CopiedWorkspace | undefined) {
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
    const path = file.path.slice("/workspace".length);
    const query = new URLSearchParams({ prefix: path, limit: "1" });
    const entry = await runtimeApi(env, "GET", `/v1/volumes/${encodeURIComponent(workspace.volume)}/files?${query}`) as {
      files: Array<{ path: string; version: number; size: number }>;
    };
    const current = entry.files[0];
    if (current?.path !== path || current.version !== file.version || current.size !== file.size) {
      continue;
    }
    if (isImage) imageBytes += current.size;
    pinned.push({ path: path.slice(1), contentType: file.contentType, commit: workspace.head });
  }
  return pinned;
}

async function copyHistory(
  env: ChatEnv,
  context: ChatContextState,
  agentId: string,
  source: string,
  messages: ImportMessage[],
  uploadPrefix = "legacy",
  workspace?: CopiedWorkspace,
  existingCount = 0,
) {
  const agentPath = v2AgentPath(agentId);
  let resumeOffset = 0;
  let resumePrevious: string | undefined;
  if (existingCount > 0) {
    const proof = await v2Json<{ source: string; receipt: string; messageCount: number }>(env, agentPath + "/history/import")
      .catch(() => null);
    if (proof && proof.source === source && proof.messageCount > 0 && proof.messageCount <= messages.length) {
      if (proof.messageCount === messages.length) return await verifyHistoryCount(env, agentPath, proof.messageCount);
      resumeOffset = proof.messageCount;
      resumePrevious = proof.receipt;
    }
  }
  const attachmentsByMessage = new Map<number, Array<{ path: string; contentType: string; commit: string }>>();
  for (let messageIndex = resumeOffset; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (message.role !== "user" && message.role !== "toolResult") continue;
    const nativeFiles = Array.isArray(message.content) ? message.content.filter(block => block.type === "file") : [];
    if (nativeFiles.length) {
      const pinned = await pinnedV1Files(env, nativeFiles, workspace).catch(() => []);
      if (pinned.length) attachmentsByMessage.set(messageIndex, pinned);
      continue;
    }
    if (message.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content :
      message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (!parseUploadRefs(text).refs.some(ref => ref.kind === "user_upload")) continue;
    const files = await attachV2Uploads(env, context, agentId, `${uploadPrefix}-${messageIndex}`, text).catch(() => []);
    if (files.length) attachmentsByMessage.set(messageIndex, files);
  }
  const encoder = new TextEncoder();
  const fullAttachments = [...attachmentsByMessage.entries()].map(([messageIndex, files]) => ({ messageIndex, files }));
  const fullPayload = { source, messages, attachments: fullAttachments, repair: true };
  let finalCount = resumeOffset;
  if (resumeOffset === 0 && (encoder.encode(JSON.stringify(fullPayload)).byteLength <= HISTORY_CHUNK_TARGET_BYTES || messages.length === 0)) {
    const receipt = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import", {
      method: "PUT", body: fullPayload,
    });
    if (!receipt.receipt || receipt.count > messages.length) throw new Error("Incomplete v2 import receipt");
    finalCount = receipt.count;
  } else {
    let offset = resumeOffset;
    let previous = resumePrevious;
    while (offset < messages.length) {
      const chunkMessages: ImportMessage[] = [];
      const chunkAttachments: Array<{ messageIndex: number; files: Array<{ path: string; contentType: string; commit: string }> }> = [];
      let chunkBytes = 256;
      while (offset + chunkMessages.length < messages.length) {
        const msgIdx = offset + chunkMessages.length;
        const msg = messages[msgIdx];
        const att = attachmentsByMessage.get(msgIdx);
        const est = encoder.encode(JSON.stringify(msg)).byteLength + (att ? encoder.encode(JSON.stringify(att)).byteLength + 64 : 0) + 16;
        if (chunkMessages.length > 0 && chunkBytes + est > HISTORY_CHUNK_TARGET_BYTES) break;
        if (att) chunkAttachments.push({ messageIndex: chunkMessages.length, files: att });
        chunkMessages.push(msg);
        chunkBytes += est;
      }
      const res = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import/chunk", {
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
      if (!res.receipt) throw new Error("Incomplete v2 chunk receipt");
      previous = res.receipt;
      finalCount = res.count;
      offset += chunkMessages.length;
    }
  }
  return await verifyHistoryCount(env, agentPath, finalCount);
}

async function verifyHistoryCount(env: ChatEnv, agentPath: string, expectedCount: number) {
  let messagesWithAttachments = 0;
  for (let offset = 0; offset < expectedCount; offset += 50) {
    const limit = Math.min(50, expectedCount - offset);
    const page = await v2Json<{ messages: Array<{ seq: number; content: { meta?: { v1?: unknown }; files?: unknown[] } }> }>(
      env, agentPath + `/history?after=${offset}&limit=${limit}`,
    );
    if (page.messages.length !== limit || page.messages.some(({ seq }, index) => seq !== offset + index + 1)) {
      throw new Error("The copied chat history does not match its source");
    }
    messagesWithAttachments += page.messages.filter(({ content }) => content.files?.length).length;
  }
  return { messagesWithAttachments };
}

/** The first migration source is immutable. Its old conversation ID and workspace remain the same. */
export class StagingV2Migration extends WorkerEntrypoint<Env> {
  async listCamelCodeModelMigrationOrgs(after: string | null, limit = 100) {
    if (!this.env.APP_DB) throw new Error("APP_DB binding is not configured");
    const size = Math.max(1, Math.min(Math.floor(limit) || 1, 100));
    const { results } = await this.env.APP_DB.prepare("SELECT id FROM orgs WHERE id > ? ORDER BY id LIMIT ?")
      .bind(after ?? "", size).all<{ id: string }>();
    return results.map(({ id }) => id);
  }

  async listCamelCodeModelMigrationThreads(orgId: string, after: string | null, limit = 100) {
    const org = this.env.ORG.idFromName(orgId);
    return retryTransientDurableObjectRpc("listCamelCodeModelMigrationThreads", () =>
      this.env.ORG.get(org).listCamelCodeModelMigrationThreads(after, limit));
  }

  async moveCamelCodeThreadToSol(orgId: string, threadId: string, apply = false) {
    const org = this.env.ORG.idFromName(orgId);
    return retryTransientDurableObjectRpc("moveCamelCodeThreadToSol", () =>
      this.env.ORG.get(org).moveCamelCodeThreadToSol(threadId, apply));
  }

  async moveLegacyThread(orgId: string, threadId: string, dryRun = true, selection: HandoffSelection = {}) {
    const env = this.env as unknown as ChatEnv;
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const [thread, existing] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
    if (!thread) return { status: "missing" };
    if (selection.expectedThreadModel !== undefined && thread.model !== selection.expectedThreadModel) {
      return { status: "source_changed" };
    }
    if (!v2WorkspaceEnabled(env, thread.workspace_id)) return { status: "workspace_disabled" };
    if (existing) return { status: existing.runtimeVersion ?? "v1" };
    if (thread.source === "channel" || thread.channel_kind) return { status: "channel" };
    if (thread.source === "scheduled" && thread.model === CAMEL_CODE_LLM_MODEL) return { status: "scheduled_handoff" };
    const context: ChatContextState = {
      orgId, threadId, workspaceId: thread.workspace_id,
      userId: thread.created_by || null, userName: null, userEmail: null,
    };
    const resolved = await resolveThreadRuntimeRoute(env, context, { persistFallback: false, allowFallback: false })
      .catch((error: unknown) => {
        if (error instanceof RuntimeRunRefused) return null;
        throw error;
      });
    const route = resolved?.route;
    if (!resolved || !route || !v2HostedModelMatches(route, env)) return { status: "model_unavailable" };
    const source = await env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId)).exportLegacyThreadForV2();
    if (source.status !== "exported") return { status: source.status };
    if (!source.messages.length && (thread.user_message_count ?? 0) > 0) return { status: "missing_history" };
    const subject = await migrationSubject(env, thread, context);
    if (!subject) return { status: "missing_owner" };
    if (new TextEncoder().encode(JSON.stringify(source.messages)).byteLength > MAX_IMPORT_BYTES) {
      return { status: "large_history" };
    }
    const messages = source.messages;
    const model = runtimeAgentModel(context, route, resolved.threadModel, "v2");
    if (dryRun) return { status: "ready", model: model.model, messages: messages.length };

    // Each attempt stages a separate agent so simultaneous copies cannot change
    // the settings of the winner. Only the OrgDO claim makes it reachable.
    await syncV2RouteKeyScope(env, context, resolved);
    const agentId = await createV2ThreadAgent(env, context, subject, model.model, `chiridion-move-${crypto.randomUUID()}`, model.keyScope);
    const agentPath = v2AgentPath(agentId);
    let claimed = false;
    try {
      const copy = await copyHistory(env, context, agentId, `chiridion-legacy:${threadId}`, messages);
      claimed = await org.claimLegacyThreadForV2(threadId, thread.model ?? null, {
        agentId, model: model.model, keyScope: model.keyScope ?? HOSTED_KEY_SCOPE,
        configured: { thinkingLevel: model.thinkingLevel, promptVersion: RUNTIME_PROMPT_VERSION },
      }, { tabs: source.preview.tabs, activeTabId: source.preview.activeTabId });
      return { status: claimed ? "moved" : "source_changed", messages: messages.length, ...copy };
    } catch (error) {
      if (error instanceof RuntimeApiError && [400, 404, 413, 422].includes(error.status)) {
        return { status: error.code ?? "copy_refused" };
      }
      throw error;
    } finally {
      if (!claimed) {
        // A failed RPC may have committed. Check authoritative placement before
        // cleaning up this attempt's private copy.
        const current = await org.getThreadRuntime(threadId);
        if (current?.agentId !== agentId) await v2Json(env, agentPath, { method: "DELETE" });
      }
    }
  }

  /** The operator fences the source and verifies the workspace copy before requesting publication. */
  async moveIdleV1Thread(orgId: string, threadId: string, handoff: V1Handoff = { phase: "inspect" }) {
    const env = this.env as unknown as ChatEnv;
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const [thread, row] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
    if (!thread || !row?.agentId) return { status: "missing" };
    if (handoff.expectedThreadModel !== undefined && thread.model !== handoff.expectedThreadModel) {
      return { status: "source_changed" };
    }
    if (row.runtimeVersion === "v2") return { status: "v2", agentId: row.agentId };
    if (handoff.phase === "publish" && row.agentId !== handoff.fencedAgentId) return { status: "source_changed" };
    if (!v2WorkspaceEnabled(env, thread.workspace_id)) return { status: "workspace_disabled" };
    if (!v2ByokEnabled(env) && row.keyScope !== HOSTED_KEY_SCOPE) return { status: "ineligible" };
    const channel = await v1ThreadHandoffBinding(env, orgId, thread, row, handoff.channel);
    if (channel === false) return { status: "ineligible" };
    if (row.pendingFirstMessage) return { status: "pending_first_message" };

    const context: ChatContextState = {
      orgId, threadId, workspaceId: thread.workspace_id, userId: thread.created_by || null, userName: null, userEmail: null,
    };
    // The fenced handoff stages a private destination. Its model can use Sol
    // from the start, including when v2 cannot serve the old backing model.
    const sol = thread.model === CAMEL_CODE_LLM_MODEL && isPreviousCamelCodeRuntimeModel(row.model) &&
      v2HostedModelMatches({ kind: "scope", keyScope: HOSTED_KEY_SCOPE, model: CAMEL_CODE_RUNTIME_MODEL }, env);
    const resolved = await resolveThreadRuntimeRoute(env, context, {
      persistFallback: false, allowFallback: false, configuredModel: sol ? CAMEL_CODE_RUNTIME_MODEL : row.model,
    })
      .catch((error: unknown) => {
        if (error instanceof RuntimeRunRefused) return null;
        throw error;
      });
    const route = resolved?.route;
    if (!resolved || !route || !v2RouteSupported(route, env) || (channel && !sol && !v2ByokEnabled(env))) return { status: "model_unavailable" };
    const model = runtimeAgentModel(context, route, resolved.threadModel, "v2");
    const connection = channel
      ? await env.WORKSPACE.get(env.WORKSPACE.idFromName(thread.workspace_id)).getIntegration(channel.connectionId)
      : null;
    const subject = (channel ? channelHandoffOwner(channel.kind, connection) : null) ?? await migrationSubject(env, thread, context);
    if (!subject || (channel && !await org.getMember(subject))) return { status: "missing_owner" };

    const sourcePath = `/v1/agents/${encodeURIComponent(row.agentId)}`;
    const [mounts, state, pending] = await Promise.all([
      runtimeApi(env, "GET", sourcePath + "/mounts") as Promise<Array<{ volumeId: string; path: string; mode: string; subpath?: string }>>,
      runtimeApi(env, "GET", sourcePath + "/state") as Promise<{ requests: Array<{ state: string }> }>,
      runtimeApi(env, "GET", sourcePath + "/inputs?state=pending") as Promise<unknown[]>,
    ]);
    const mount = mounts[0];
    if (mounts.length > 1 || (mount && (mount.path !== "/workspace" || mount.mode !== "rw" || mount.subpath))) {
      return { status: "unsupported_mounts" };
    }
    if (pending.length || state.requests.some(({ state }) => state === "running" || state === "queued")) return { status: "busy" };
    const totalMessages = await readV1HistoryTotal(env, sourcePath);
    if (!totalMessages && (thread.user_message_count ?? 0) > 0) return { status: "missing_history" };
    if (handoff.phase === "inspect") {
      return { status: "ready", agentId: row.agentId, model: model.model, messages: totalMessages, volume: mount?.volumeId };
    }

    await syncV2RouteKeyScope(env, context, resolved);
    const agentId = await createV2ThreadAgent(env, context, subject, model.model, undefined, model.keyScope);
    const targetPath = v2AgentPath(agentId);
    const target = await v2Json<V2Agent & { messageCount: number }>(env, targetPath);
    if (target.activeRunId || target.lastRun) return { status: "destination_active" };
    if (handoff.phase === "prepare") {
      const repo = mount && await v2Json<{ repoId: string; branch: string }>(env, targetPath + "/repo", { method: "PUT" });
      return { status: "prepared", agentId, sourceAgentId: row.agentId, volume: mount?.volumeId, repo: repo || null };
    }
    const workspace = handoff.workspace;
    if (mount?.volumeId !== workspace?.volume || (workspace && target.repoId !== workspace.repoId)) {
      return { status: "workspace_copy_required" };
    }
    if (workspace) {
      const files = await v2Json<{ commit: string }>(env, `/repos/${encodeURIComponent(workspace.repoId)}/ls?at=${encodeURIComponent(target.branch)}`);
      if (files.commit !== workspace.head) return { status: "destination_workspace_changed" };
    }
    const copy = await streamV1HistoryToV2(
      env,
      context,
      sourcePath,
      agentId,
      `chiridion-v1:${handoff.fencedAgentId}`,
      totalMessages,
      `v1-migration-${crypto.randomUUID()}`,
      workspace,
      target.messageCount,
    ).catch((error: unknown) => {
      if (error instanceof RuntimeApiError && [400, 404, 409, 413, 422].includes(error.status)) return { refused: error.code ?? "copy_refused" };
      throw error;
    });
    if ("refused" in copy) return { status: copy.refused };
    const latestTotal = await readV1HistoryTotal(env, sourcePath);
    if (latestTotal !== totalMessages) return { status: "source_changed" };
    if (workspace) {
      const volume = await runtimeApi(env, "GET", `/v1/volumes/${encodeURIComponent(workspace.volume)}`) as { seq: number };
      if (volume.seq !== workspace.seq) return { status: "source_workspace_changed" };
    }
    if (channel && !await v1ThreadHandoffBinding(env, orgId, thread, row, handoff.channel)) return { status: "source_changed" };
    const moved = await org.publishV1ThreadInV2(threadId, {
      agentId: handoff.fencedAgentId, workspaceId: thread.workspace_id, threadModel: thread.model ?? null, updatedAt: row.updatedAt,
      ...(channel ? { channel } : {}),
    }, {
      agentId, model: model.model, keyScope: model.keyScope ?? HOSTED_KEY_SCOPE,
      configured: { thinkingLevel: model.thinkingLevel, promptVersion: RUNTIME_PROMPT_VERSION },
    });
    return { status: moved ? "moved" : "source_changed", agentId, messages: totalMessages, ...copy };
  }

  /** Read only the thread's own scratch volume, with the v1 credential kept inside the app. */
  async readV1ThreadVolume(orgId: string, threadId: string, sourceVolume: string, path: string, query: string, channel?: HandoffChannel): Promise<Response> {
    const env = this.env as unknown as ChatEnv;
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const [thread, row] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
    if (!thread || !row?.agentId || row.runtimeVersion || !v2WorkspaceEnabled(env, thread.workspace_id) ||
        (!v2ByokEnabled(env) && row.keyScope !== HOSTED_KEY_SCOPE) || await v1ThreadHandoffBinding(env, orgId, thread, row, channel) === false) {
      return new Response(null, { status: 404 });
    }
    const mounts = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(row.agentId)}/mounts`) as
      Array<{ volumeId: string; path: string; mode: string; subpath?: string }>;
    if (mounts.length !== 1 || mounts[0]?.volumeId !== sourceVolume || mounts[0].path !== "/workspace" ||
        mounts[0].mode !== "rw" || mounts[0].subpath) return new Response(null, { status: 404 });
    const root = `/v1/volumes/${encodeURIComponent(sourceVolume)}`;
    const url = new URL(root + path, runtimeUrl(env));
    if (url.pathname !== root && url.pathname !== root + "/snapshots" && url.pathname !== root + "/files" &&
        !url.pathname.startsWith(root + "/files/")) return new Response(null, { status: 404 });
    url.search = query;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}` }, redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("Unexpected redirect reading the v1 scratch volume");
    }
    return response;
  }
}
