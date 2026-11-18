/**
 * A thread's whole transcript as parsed chat messages, wherever the thread
 * runs: a runtime thread's from its agent's history on the runtime, any
 * other's from ChatThreadDO's pi_core. For the readers that need the whole
 * thread (the admin views, the JSONL export, condensed transcripts), not the
 * chat page, which pages.
 */
import type { AgentMessage } from "../../../../src/lib/agent-messages";
import type { AgentEvalParsedMessage, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { piMessagesToParsedMessages } from "../pi-message-export.js";
import { runtimeApi } from "./runtime-api.js";
import { v2HistoryPage } from "./v2-thread-read.js";

export interface ThreadRecentSource {
  messages: AgentEvalParsedMessage[];
  projectActivity: unknown[];
}

/** How many of a thread's newest messages the group welcome page looks through. */
const RECENT_MESSAGES = 50;

/** A runtime agent's whole history, oldest first. */
export async function runtimeTranscript(env: ChatEnv, agentId: string, runtimeVersion?: "v2"): Promise<AgentMessage[]> {
  if (runtimeVersion === "v2") {
    const pages: AgentMessage[][] = [];
    let before: number | null = null;
    do {
      const page = await v2HistoryPage(env, agentId, { before, limit: 100 });
      pages.push(page.entries.map((entry) => entry.message));
      before = page.next;
    } while (before !== null);
    return pages.reverse().flat();
  }
  const history = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(agentId)}/history`) as { messages?: unknown } | null;
  return Array.isArray(history?.messages) ? history.messages as AgentMessage[] : [];
}

async function threadRuntimeRow(env: ChatEnv, orgId: string, threadId: string): Promise<ThreadRuntimeRecord | null> {
  const org = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
    getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
  };
  return await org.getThreadRuntime(threadId);
}

function chatThread(env: ChatEnv, threadId: string) {
  return env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId)) as unknown as {
    getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]>;
    getGroupNewChatRecentSource(threadId: string): Promise<ThreadRecentSource>;
  };
}

export async function parsedThreadTranscript(env: ChatEnv, orgId: string, threadId: string): Promise<AgentEvalParsedMessage[]> {
  const row = await threadRuntimeRow(env, orgId, threadId);
  if (row) return row.agentId ? piMessagesToParsedMessages(await runtimeTranscript(env, row.agentId, row.runtimeVersion), threadId) : [];
  return await chatThread(env, threadId).getPiCoreParsedMessages(threadId);
}

/**
 * A thread's newest messages (and ChatThreadDO's project activity for a DO
 * thread), for the group welcome page's recent connections and uploads.
 */
export async function threadRecentSource(env: ChatEnv, orgId: string, threadId: string): Promise<ThreadRecentSource> {
  const row = await threadRuntimeRow(env, orgId, threadId);
  if (!row) return await chatThread(env, threadId).getGroupNewChatRecentSource(threadId);
  if (!row.agentId) return { messages: [], projectActivity: [] };
  const page = row.runtimeVersion === "v2"
    ? await v2HistoryPage(env, row.agentId, { limit: RECENT_MESSAGES })
    : await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(row.agentId)}/history?limit=${RECENT_MESSAGES}`) as {
    entries?: Array<{ message: unknown }>;
  } | null;
  const messages = (page?.entries ?? []).map((entry) => entry.message as AgentMessage);
  return { messages: piMessagesToParsedMessages(messages, threadId), projectActivity: [] };
}
