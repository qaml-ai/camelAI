/**
 * Forking a runtime thread: the new thread's agent starts with the source
 * agent's history through the fork point, and the source's preview tabs.
 * The fork point is a history index (`rt:<index>`, pi-render's forkEntryId);
 * a turn's tool results after it come along, so no call is left unanswered.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { ARCHIVE_FILE_NAME, ARCHIVE_REQUEST_ID, convertTranscript, withImportNote } from "./thread-migration.js";
import { RuntimeApiError, runtimeApi, runtimeUrl } from "./runtime-api.js";
import { runtimeSystemPromptAppend, type RuntimeAgentModel } from "./run-gates.js";
import { HOSTED_KEY_SCOPE, hostedModelHeaders } from "./key-scopes.js";
import { RUNTIME_PROMPT_VERSION } from "../chat-thread/runtime-agent.js";

export type RuntimeForkResult =
  | { status: "forked"; row: ThreadRuntimeRecord }
  | { status: "not_found"; error: string }
  | { status: "failed"; error: string };

function forkIndex(forkEntryId: string): number | null {
  const match = /^rt:(\d+)$/.exec(forkEntryId.trim());
  return match ? Number(match[1]) : null;
}

export async function forkRuntimeThread(
  env: ChatEnv,
  input: { source: ThreadRuntimeRecord & { agentId: string }; target: ChatContextState; forkEntryId: string },
): Promise<RuntimeForkResult> {
  const { source, target } = input;
  const index = forkIndex(input.forkEntryId);
  const whole = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(source.agentId)}/history`) as { messages?: unknown } | null;
  const history = Array.isArray(whole?.messages) ? whole.messages as AgentMessage[] : [];
  if (index === null || index >= history.length) return { status: "not_found", error: "Fork target not found in the thread's history" };
  let end = index + 1;
  while (end < history.length && (history[end] as { role?: string }).role === "toolResult") end++;
  const forked: AgentMessage[] = history.slice(0, end);
  const converted = convertTranscript(forked);
  if (converted.tooLarge) return { status: "failed", error: "The thread's history is too large to fork" };

  const org = env.ORG.get(env.ORG.idFromName(target.orgId)) as unknown as {
    getThread(threadId: string): Promise<{ created_by?: string | null } | null>;
    getThreadUiState(threadId: string): Promise<{ preview?: { tabs?: unknown[]; activeTabId?: string | null } | null } | null>;
    setThreadUiState(threadId: string, preview: Record<string, unknown> | null): Promise<unknown>;
    claimThreadRuntimeAgent(
      threadId: string,
      agentId: string,
      configuration?: { model: string | null; keyScope: string | null; configured: Record<string, unknown> | null },
    ): Promise<{ row: ThreadRuntimeRecord; claimed: boolean } | null>;
  };
  // The fork runs its source's model, on its key scope (synced by the source's
  // runs): the runtime refuses an agent made without one it has keys for.
  const agentModel: RuntimeAgentModel | null = source.model
    ? {
      model: source.model,
      keyScope: source.keyScope ?? null,
      modelHeaders: source.keyScope === HOSTED_KEY_SCOPE ? hostedModelHeaders(target) : null,
      thinkingLevel: source.configured?.thinkingLevel === "high" ? "high" : "medium",
    }
    : null;
  let agentId: string | null = null;
  try {
    const thread = await org.getThread(target.threadId);
    // A shortened fork says where its original is; a whole one needs no note.
    const initialMessages = converted.lossy ? withImportNote(converted.messages, true) : converted.messages;
    agentId = await createForkAgent(env, target, thread?.created_by?.trim() || target.userId || null, initialMessages, agentModel);
    if (converted.lossy) await archiveHistory(env, agentId, forked);
    const preview = (await org.getThreadUiState(source.threadId))?.preview;
    if (preview?.tabs?.length) {
      await org.setThreadUiState(target.threadId, { tabs: preview.tabs, activeTabId: preview.activeTabId ?? null });
    }
    const claim = await org.claimThreadRuntimeAgent(target.threadId, agentId, agentModel
      ? {
        model: agentModel.model,
        keyScope: agentModel.keyScope,
        configured: { thinkingLevel: agentModel.thinkingLevel, promptVersion: RUNTIME_PROMPT_VERSION },
      }
      : undefined);
    if (!claim) throw new Error("Thread not found");
    if (!claim.claimed) throw new Error("The fork already has an agent");
    return { status: "forked", row: claim.row };
  } catch (error) {
    if (agentId) await deleteAgent(env, agentId);
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The fork's agent, with its history and its source's model (the thread's
 * first send configures the rest). The same history makes the same agent
 * (a retried fork gets it back), never a second one.
 */
async function createForkAgent(
  env: ChatEnv,
  context: ChatContextState,
  subject: string | null,
  initialMessages: AgentMessage[],
  agentModel: RuntimeAgentModel | null,
): Promise<string> {
  const history = JSON.stringify(initialMessages);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(history));
  const key = `fork_${context.threadId}_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)}`;
  const created = await runtimeApi(env, "POST", "/v1/agents", {
    definition: env.AGENT_RUNTIME_DEFINITION,
    name: context.threadId,
    type: "camelai-thread",
    ttlSeconds: null,
    ...(agentModel
      ? {
        model: agentModel.model,
        ...(agentModel.keyScope ? { keyScope: agentModel.keyScope } : {}),
        ...(agentModel.modelHeaders ? { modelHeaders: agentModel.modelHeaders } : {}),
        thinkingLevel: agentModel.thinkingLevel,
      }
      : {}),
    systemPromptAppend: runtimeSystemPromptAppend(env, context),
    fileTools: false,
    ...(subject ? { subject } : {}),
    context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId },
    ...(initialMessages.length ? { initialMessages } : {}),
  }, { "Idempotency-Key": key }) as { id?: unknown };
  if (typeof created?.id !== "string") throw new Error("Agent runtime returned no agent id");
  return created.id;
}

/** The forked history as it was, into the fork agent's workspace, when the fork had to shorten it. */
async function archiveHistory(env: ChatEnv, agentId: string, messages: AgentMessage[]): Promise<void> {
  const response = await fetch(
    `${runtimeUrl(env)}/v1/agents/${encodeURIComponent(agentId)}/uploads/${ARCHIVE_REQUEST_ID}/${ARCHIVE_FILE_NAME}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`, "Content-Type": "application/x-ndjson" },
      body: messages.map((message) => JSON.stringify(message)).join("\n"),
    },
  );
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Could not save the forked history: HTTP ${response.status}`);
}

async function deleteAgent(env: ChatEnv, agentId: string): Promise<void> {
  await runtimeApi(env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`).catch((cause: unknown) => {
    if (!(cause instanceof RuntimeApiError && cause.status === 404)) console.warn("[runtime-thread] could not delete a failed fork's agent", cause);
  });
}
