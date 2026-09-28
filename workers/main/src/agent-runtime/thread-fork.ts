/**
 * Forking a runtime thread: the new thread's agent starts with the source
 * agent's history through the fork point, and the source's preview tabs.
 * The fork point is a history index (`rt:<index>`, pi-render's forkEntryId);
 * a turn's tool results after it come along, so no call is left unanswered.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { archiveTranscript, convertTranscript, createAgentWithHistory, deleteUnusedAgent } from "./thread-migration.js";
import { runtimeApi } from "./runtime-api.js";

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

  const org = env.ORG.get(env.ORG.idFromName(target.orgId)) as unknown as {
    getThreadUiState(threadId: string): Promise<{ preview?: { tabs?: unknown[]; activeTabId?: string | null } | null } | null>;
    setThreadUiState(threadId: string, preview: Record<string, unknown> | null): Promise<unknown>;
    setThreadRuntimeAgent(threadId: string, update: {
      agentId: string;
      model: string | null;
      keyScope: string | null;
      configured: null;
    }): Promise<ThreadRuntimeRecord | null>;
  };
  let agentId: string | null = null;
  try {
    agentId = await createAgentWithHistory(env, target, converted.messages, "fork");
    if (converted.lossy) await archiveTranscript(env, agentId, forked);
    const preview = (await org.getThreadUiState(source.threadId))?.preview;
    if (preview?.tabs?.length) {
      await org.setThreadUiState(target.threadId, { tabs: preview.tabs, activeTabId: preview.activeTabId ?? null });
    }
    const row = await org.setThreadRuntimeAgent(target.threadId, { agentId, model: null, keyScope: null, configured: null });
    if (!row) throw new Error("Thread not found");
    return { status: "forked", row };
  } catch (error) {
    if (agentId) await deleteUnusedAgent(env, agentId);
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
