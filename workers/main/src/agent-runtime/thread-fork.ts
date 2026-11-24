/**
 * Forking a runtime thread: the runtime forks the source thread's agent
 * (POST /v2/agents/{id}/fork for v2 threads, POST /v1/agents/{id}/fork for v1)
 * into the new thread's, with its history through the fork point and a copy of
 * its workspace; the source's preview tabs come along here. The fork point is a
 * history index (`rt:<index>`, pi-render's forkEntryId); the runtime keeps a
 * turn's tool results after it, so no call is left unanswered, and refuses a
 * point in a turn still running.
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { RuntimeApiError, runtimeApi } from "./runtime-api.js";
import { runtimeSystemPromptAppend, type RuntimeAgentModel } from "./run-gates.js";
import { HOSTED_KEY_SCOPE, hostedModelHeaders } from "./key-scopes.js";
import { RUNTIME_PROMPT_VERSION } from "./runtime-prompt.js";
import { v2AgentPath, v2Fetch, v2Json } from "./runtime-v2.js";

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
  const isV2 = source.runtimeVersion === "v2";
  const index = forkIndex(input.forkEntryId);
  if (index === null) return { status: "not_found", error: NOT_FOUND };

  const org = env.ORG.get(env.ORG.idFromName(target.orgId)) as unknown as {
    getThread(threadId: string): Promise<{ created_by?: string | null } | null>;
    getThreadUiState(threadId: string): Promise<{ preview?: { tabs?: unknown[]; activeTabId?: string | null } | null } | null>;
    setThreadUiState(threadId: string, preview: Record<string, unknown> | null): Promise<unknown>;
    pinThreadRuntime(threadId: string, pendingFirstMessage?: string | null, runtimeVersion?: "v1" | "v2"): Promise<boolean>;
    claimThreadRuntimeAgent(
      threadId: string,
      agentId: string,
      configuration?: { model: string | null; keyScope: string | null; configured: Record<string, unknown> | null },
    ): Promise<{ row: ThreadRuntimeRecord; claimed: boolean } | null>;
  };
  // The fork runs its source's model on its key scope, as the runtime copies
  // them, recorded on its row; a hosted fork's model headers name its own thread.
  const thinkingLevel = source.configured?.thinkingLevel;
  const agentModel: RuntimeAgentModel | null = source.model
    ? {
      model: source.model,
      keyScope: source.keyScope ?? null,
      modelHeaders: source.keyScope === HOSTED_KEY_SCOPE ? hostedModelHeaders(target) : null,
      thinkingLevel: thinkingLevel === "low" || thinkingLevel === "high" ? thinkingLevel : "medium",
    }
    : null;
  let agentId: string | null = null;
  try {
    const thread = await org.getThread(target.threadId);
    const subject = thread?.created_by?.trim() || target.userId || null;
    agentId = isV2
      ? await forkV2Agent(env, source.agentId, target, subject, index)
      : await forkAgent(env, source.agentId, target, subject, index, agentModel);
    const preview = (await org.getThreadUiState(source.threadId))?.preview;
    if (preview?.tabs?.length) {
      await org.setThreadUiState(target.threadId, { tabs: preview.tabs, activeTabId: preview.activeTabId ?? null });
    }
    if (isV2) {
      await org.pinThreadRuntime(target.threadId, null, "v2");
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
    if (agentId) await deleteAgent(env, agentId, isV2);
    if (error instanceof RuntimeApiError && (error.code === "FORK_POINT_INVALID" || error.code === "fork_point_invalid")) {
      return { status: "not_found", error: NOT_FOUND };
    }
    if (error instanceof RuntimeApiError && (error.code === "FORK_POINT_RUNNING" || error.code === "fork_point_running")) {
      return { status: "failed", error: "That message's turn is still running; fork it once the turn ends" };
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

async function forkV2Agent(
  env: ChatEnv,
  sourceAgentId: string,
  context: ChatContextState,
  subject: string | null,
  atSeq: number,
): Promise<string> {
  const forked = await v2Json<{ id?: unknown }>(env, `${v2AgentPath(sourceAgentId)}/fork`, {
    method: "POST",
    body: {
      key: `chiridion-thread-${context.threadId}`,
      atSeq,
      forkRepo: true,
      instructions: runtimeSystemPromptAppend(env, context, "v2"),
      toolIdentity: {
        subject: subject || context.userId || "unknown",
        context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId },
      },
    },
  });
  if (typeof forked?.id !== "string") throw new Error("Agent runtime v2 returned no agent id");
  return forked.id;
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

async function deleteAgent(env: ChatEnv, agentId: string, isV2 = false): Promise<void> {
  if (isV2) {
    await v2Fetch(env, v2AgentPath(agentId), { method: "DELETE" }).then((res) => res.body?.cancel()).catch((cause: unknown) => {
      if (!(cause instanceof RuntimeApiError && cause.status === 404)) console.warn("[runtime-thread] could not delete a failed v2 fork's agent", cause);
    });
    return;
  }
  await runtimeApi(env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`).catch((cause: unknown) => {
    if (!(cause instanceof RuntimeApiError && cause.status === 404)) console.warn("[runtime-thread] could not delete a failed fork's agent", cause);
  });
}
