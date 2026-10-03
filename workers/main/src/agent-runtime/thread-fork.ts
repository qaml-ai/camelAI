/**
 * Forking a runtime thread: the runtime forks the source thread's agent
 * (POST /v1/agents/{id}/fork) into the new thread's, with its history through
 * the fork point and a copy of its workspace; the source's preview tabs come
 * along here. The fork point is a history index (`rt:<index>`, pi-render's
 * forkEntryId); the runtime keeps a turn's tool results after it, so no call
 * is left unanswered, and refuses a point in a turn still running.
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { RuntimeApiError, runtimeApi } from "./runtime-api.js";
import { runtimeSystemPromptAppend, type RuntimeAgentModel } from "./run-gates.js";
import { HOSTED_KEY_SCOPE, hostedModelHeaders } from "./key-scopes.js";
import { RUNTIME_PROMPT_VERSION } from "./runtime-prompt.js";

export type RuntimeForkResult =
  | { status: "forked"; row: ThreadRuntimeRecord }
  | { status: "not_found"; error: string }
  | { status: "failed"; error: string };

const NOT_FOUND = "Fork target not found in the thread's history";

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
  if (index === null) return { status: "not_found", error: NOT_FOUND };

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
  // The fork runs its source's model on its key scope, as the runtime copies
  // them, recorded on its row; a hosted fork's model headers name its own thread.
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
    agentId = await forkAgent(env, source.agentId, target, thread?.created_by?.trim() || target.userId || null, index, agentModel);
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
    // A retry finds the same agent recorded already: that is this fork.
    if (!claim.claimed && claim.row.agentId !== agentId) throw new Error("The fork already has an agent");
    return { status: "forked", row: claim.row };
  } catch (error) {
    if (agentId) await deleteAgent(env, agentId);
    if (error instanceof RuntimeApiError && error.code === "FORK_POINT_INVALID") return { status: "not_found", error: NOT_FOUND };
    if (error instanceof RuntimeApiError && error.code === "FORK_POINT_RUNNING") {
      return { status: "failed", error: "That message's turn is still running; fork it once the turn ends" };
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The fork's agent, in one runtime call: the source agent's configuration,
 * history through `atMessage` and workspace, named for the new thread, acting
 * for its creator in its own context, with its own instructions and model
 * headers. Its key is the new thread's, so a retried fork gets the same agent
 * back, never a second one.
 */
async function forkAgent(
  env: ChatEnv,
  sourceAgentId: string,
  context: ChatContextState,
  subject: string | null,
  atMessage: number,
  agentModel: RuntimeAgentModel | null,
): Promise<string> {
  const forked = await runtimeApi(env, "POST", `/v1/agents/${encodeURIComponent(sourceAgentId)}/fork`, {
    key: `fork_${context.threadId}`,
    name: context.threadId,
    atMessage,
    ttlSeconds: null,
    ...(subject ? { subject } : {}),
    context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId },
    systemPromptAppend: runtimeSystemPromptAppend(env, context),
    ...(agentModel ? { modelHeaders: agentModel.modelHeaders } : {}),
  }) as { id?: unknown };
  if (typeof forked?.id !== "string") throw new Error("Agent runtime returned no agent id");
  return forked.id;
}

async function deleteAgent(env: ChatEnv, agentId: string): Promise<void> {
  await runtimeApi(env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`).catch((cause: unknown) => {
    if (!(cause instanceof RuntimeApiError && cause.status === 404)) console.warn("[runtime-thread] could not delete a failed fork's agent", cause);
  });
}
