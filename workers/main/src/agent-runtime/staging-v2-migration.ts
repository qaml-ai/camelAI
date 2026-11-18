import { WorkerEntrypoint } from "cloudflare:workers";
import { parseUploadRefs } from "../../../../src/lib/chat-attachment-refs";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import type { Env } from "../types";
import { HOSTED_KEY_SCOPE } from "./key-scopes";
import { v2HostedModelMatches } from "./model-routes";
import { resolveThreadRuntimeRoute, runtimeAgentModel, RuntimeRunRefused } from "./run-gates";
import { RuntimeApiError } from "./runtime-api";
import { attachV2Uploads, createV2ThreadAgent, v2AgentPath, v2Json } from "./runtime-v2";
import { MAX_IMPORT_BYTES, migrationSubject } from "./thread-migration";
import { RUNTIME_PROMPT_VERSION } from "./runtime-prompt";

/** The first migration source is immutable. Its old conversation ID and workspace remain the same. */
export class StagingV2Migration extends WorkerEntrypoint<Env> {
  async moveLegacyThread(orgId: string, threadId: string, dryRun = true) {
    if (this.env.WORKER_BASE_URL !== "https://staging.camelai.dev") throw new Error("Staging migration only");
    const env = this.env as unknown as ChatEnv;
    const org = env.ORG.get(env.ORG.idFromName(orgId));
    const [thread, existing] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
    if (!thread) return { status: "missing" };
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
      const attachments = [];
      for (const [messageIndex, message] of messages.entries()) {
        if (message.role !== "user") continue;
        const text = typeof message.content === "string" ? message.content :
          message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
        if (!parseUploadRefs(text).refs.some((ref) => ref.kind === "user_upload")) continue;
        const files = await attachV2Uploads(env, context, agentId, `legacy-${messageIndex}`, text);
        attachments.push({ messageIndex, files });
      }
      const receipt = await v2Json<{ count: number; receipt: string }>(env, agentPath + "/history/import", {
        method: "PUT",
        body: { source: `chiridion-legacy:${threadId}`, messages, attachments },
      });
      if (!receipt.receipt || receipt.count !== messages.length) throw new Error("Incomplete v2 import receipt");
      for (let offset = 0; offset < messages.length; offset += 50) {
        const limit = Math.min(50, messages.length - offset);
        const page = await v2Json<{ messages: Array<{ seq: number; content: { meta?: { v1?: unknown } } }> }>(
          env, agentPath + `/history?after=${offset}&limit=${limit}`,
        );
        if (page.messages.length !== limit || page.messages.some(({ seq, content }, index) =>
          seq !== offset + index + 1 || JSON.stringify(content.meta?.v1) !== JSON.stringify(messages[offset + index]))) {
          throw new Error("The copied chat history does not match its source");
        }
      }
      claimed = await org.claimLegacyThreadForV2(threadId, thread.model ?? null, {
        agentId, model: model.model, keyScope: HOSTED_KEY_SCOPE,
        configured: { thinkingLevel: model.thinkingLevel, promptVersion: RUNTIME_PROMPT_VERSION },
      }, { tabs: source.preview.tabs, activeTabId: source.preview.activeTabId });
      return { status: claimed ? "moved" : "source_changed", messages: messages.length, messagesWithAttachments: attachments.length };
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
}
