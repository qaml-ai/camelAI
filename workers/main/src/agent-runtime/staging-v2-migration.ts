import { WorkerEntrypoint } from "cloudflare:workers";
import { parseUploadRefs } from "../../../../src/lib/chat-attachment-refs";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import type { Env } from "../types";
import { HOSTED_KEY_SCOPE } from "./key-scopes";
import { v2HostedModelMatches } from "./model-routes";
import { resolveThreadRuntimeRoute, runtimeAgentModel, RuntimeRunRefused } from "./run-gates";
import { runtimeApi, runtimeUrl, RuntimeApiError, v2WorkspaceEnabled } from "./runtime-api";
import { attachV2Uploads, createV2ThreadAgent, v2AgentPath, v2Json, type V2Agent } from "./runtime-v2";
import { MAX_IMPORT_BYTES, migrationSubject } from "./thread-migration";
import { RUNTIME_PROMPT_VERSION } from "./runtime-prompt";

type ImportMessage = { role: string; content: string | Array<{ type: string; text?: string }> };
type V1Handoff = { phase: "inspect" } | { phase: "prepare" } | {
  phase: "publish";
  fencedAgentId: string;
  workspace?: { volume: string; repoId: string; seq: number; head: string };
};


async function readV1History(env: ChatEnv, agentPath: string): Promise<ImportMessage[]> {
  const messages: ImportMessage[] = [];
  const encoder = new TextEncoder();
  let bytes = 2;
  let total: number | undefined;
  for (;;) {
    const page = await runtimeApi(env, "GET", `${agentPath}/history?after=${messages.length}&limit=100`) as {
      entries: Array<{ index: number; message: ImportMessage }>;
      total: number;
      truncated: boolean;
      nextAfter: number;
    };
    total ??= page.total;
    if (page.truncated || page.total !== total || messages.length + page.entries.length > total) {
      throw new Error("V1 history changed or has a gap");
    }
    for (const { index, message } of page.entries) {
      if (index !== messages.length) throw new Error("V1 history is missing a message");
      bytes += encoder.encode(JSON.stringify(message)).byteLength + 1;
      if (bytes > MAX_IMPORT_BYTES) throw new RuntimeApiError("V1 history is too large to import in one request", 413, "large_history");
      messages.push(message);
    }
    if (!page.entries.length && messages.length === total) return messages;
    if (!page.entries.length || page.nextAfter !== messages.length) throw new Error("V1 history cursor did not advance");
  }
}

async function copyHistory(env: ChatEnv, context: ChatContextState, agentId: string, source: string, messages: ImportMessage[], uploadPrefix = "legacy") {
  const agentPath = v2AgentPath(agentId);
  const attachments = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content :
      message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
    if (!parseUploadRefs(text).refs.some(ref => ref.kind === "user_upload")) continue;
    const files = await attachV2Uploads(env, context, agentId, `${uploadPrefix}-${messageIndex}`, text);
    attachments.push({ messageIndex, files });
  }
  const receipt = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import", {
    method: "PUT", body: { source, messages, attachments },
  });
  if (!receipt.receipt || receipt.count !== messages.length) throw new Error("Incomplete v2 import receipt");
  return await verifyHistory(env, agentPath, messages);
}

async function verifyHistory(env: ChatEnv, agentPath: string, messages: ImportMessage[]) {
  let messagesWithAttachments = 0;
  for (let offset = 0; offset < messages.length; offset += 50) {
    const limit = Math.min(50, messages.length - offset);
    const page = await v2Json<{ messages: Array<{ seq: number; content: { meta?: { v1?: unknown }; files?: unknown[] } }> }>(
      env, agentPath + `/history?after=${offset}&limit=${limit}`,
    );
    if (page.messages.length !== limit || page.messages.some(({ seq, content }, index) =>
      seq !== offset + index + 1 || JSON.stringify(content.meta?.v1) !== JSON.stringify(messages[offset + index]))) {
      throw new Error("The copied chat history does not match its source");
    }
    messagesWithAttachments += page.messages.filter(({ content }) => content.files?.length).length;
  }
  return { messagesWithAttachments };
}

/** The first migration source is immutable. Its old conversation ID and workspace remain the same. */
export class StagingV2Migration extends WorkerEntrypoint<Env> {
  async moveLegacyThread(orgId: string, threadId: string, dryRun = true) {
    const env = this.env as unknown as ChatEnv;
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const [thread, existing] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
    if (!thread) return { status: "missing" };
    if (!v2WorkspaceEnabled(env, thread.workspace_id)) return { status: "workspace_disabled" };
    if (existing) return { status: existing.runtimeVersion ?? "v1" };
    if (thread.source === "channel" || thread.channel_kind) return { status: "channel" };
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
    if (!resolved || !route || !v2HostedModelMatches(route, env.AGENT_RUNTIME_V2_MODELS)) return { status: "model_unavailable" };
    const source = await env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId)).exportLegacyThreadForV2();
    if (source.status !== "exported") return { status: source.status };
    if (!source.messages.length && (thread.user_message_count ?? 0) > 0) return { status: "missing_history" };
    const subject = await migrationSubject(env, thread, context);
    if (!subject) return { status: "missing_owner" };
    if (new TextEncoder().encode(JSON.stringify(source.messages)).byteLength > MAX_IMPORT_BYTES) {
      return { status: "large_history" };
    }
    const messages = source.messages;
    const model = runtimeAgentModel(context, route, resolved.threadModel);
    if (dryRun) return { status: "ready", model: model.model, messages: messages.length };

    // Each attempt stages a separate agent so simultaneous copies cannot change
    // the settings of the winner. Only the OrgDO claim makes it reachable.
    const agentId = await createV2ThreadAgent(env, context, subject, model.model, `chiridion-move-${crypto.randomUUID()}`);
    const agentPath = v2AgentPath(agentId);
    let claimed = false;
    try {
      const copy = await copyHistory(env, context, agentId, `chiridion-legacy:${threadId}`, messages);
      claimed = await org.claimLegacyThreadForV2(threadId, thread.model ?? null, {
        agentId, model: model.model, keyScope: HOSTED_KEY_SCOPE,
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
    if (row.runtimeVersion === "v2") return { status: "v2", agentId: row.agentId };
    if (handoff.phase === "publish" && row.agentId !== handoff.fencedAgentId) return { status: "source_changed" };
    if (!v2WorkspaceEnabled(env, thread.workspace_id)) return { status: "workspace_disabled" };
    if (thread.source === "channel" || thread.channel_kind || row.keyScope !== HOSTED_KEY_SCOPE) return { status: "ineligible" };
    if (row.pendingFirstMessage) return { status: "pending_first_message" };

    const context: ChatContextState = {
      orgId, threadId, workspaceId: thread.workspace_id, userId: thread.created_by || null, userName: null, userEmail: null,
    };
    const resolved = await resolveThreadRuntimeRoute(env, context, { persistFallback: false, allowFallback: false })
      .catch((error: unknown) => {
        if (error instanceof RuntimeRunRefused) return null;
        throw error;
      });
    const route = resolved?.route;
    if (!resolved || !route || !v2HostedModelMatches(route, env.AGENT_RUNTIME_V2_MODELS)) return { status: "model_unavailable" };
    const model = runtimeAgentModel(context, route, resolved.threadModel);
    const subject = await migrationSubject(env, thread, context);
    if (!subject) return { status: "missing_owner" };

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
    const messages = await readV1History(env, sourcePath);
    if (!messages.length && (thread.user_message_count ?? 0) > 0) return { status: "missing_history" };
    if (handoff.phase === "inspect") {
      return { status: "ready", agentId: row.agentId, model: model.model, messages: messages.length, volume: mount?.volumeId };
    }

    const agentId = await createV2ThreadAgent(env, context, subject, model.model);
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
    if (target.messageCount && target.messageCount !== messages.length) return { status: "destination_changed" };
    const copy = target.messageCount
      ? await verifyHistory(env, targetPath, messages)
      : await copyHistory(env, context, agentId, `chiridion-v1:${handoff.fencedAgentId}`, messages, `v1-migration-${crypto.randomUUID()}`);
    const latest = await readV1History(env, sourcePath);
    if (JSON.stringify(latest) !== JSON.stringify(messages)) return { status: "source_changed" };
    if (workspace) {
      const volume = await runtimeApi(env, "GET", `/v1/volumes/${encodeURIComponent(workspace.volume)}`) as { seq: number };
      if (volume.seq !== workspace.seq) return { status: "source_workspace_changed" };
    }
    const moved = await org.publishV1ThreadInV2(threadId, {
      agentId: handoff.fencedAgentId, workspaceId: thread.workspace_id, threadModel: thread.model ?? null, updatedAt: row.updatedAt,
    }, {
      agentId, model: model.model, keyScope: HOSTED_KEY_SCOPE,
      configured: { thinkingLevel: model.thinkingLevel, promptVersion: RUNTIME_PROMPT_VERSION },
    });
    return { status: moved ? "moved" : "source_changed", agentId, messages: messages.length, ...copy };
  }

  /** Read only the thread's own scratch volume, with the v1 credential kept inside the app. */
  async readV1ThreadVolume(orgId: string, threadId: string, sourceVolume: string, path: string, query: string): Promise<Response> {
    const env = this.env as unknown as ChatEnv;
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const [thread, row] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
    if (!thread || !row?.agentId || row.runtimeVersion || !v2WorkspaceEnabled(env, thread.workspace_id) ||
        thread.source === "channel" || thread.channel_kind || row.keyScope !== HOSTED_KEY_SCOPE) {
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
