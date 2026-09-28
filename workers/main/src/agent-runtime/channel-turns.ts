/**
 * Channel threads (Discord, Slack, Telegram, email) on the direct runtime
 * path: their messages start turns with startRuntimeTurn instead of going
 * through ChatThreadDO. A thread is direct when it has a thread_runtime row:
 * new channel threads are pinned when created, and a thread the DO relays to
 * a runtime agent is adopted (the row points at that agent; its history is
 * already in the runtime). Threads on the DO's own loop stay there.
 *
 * The reply is the agent's to send (tools.send_<kind>_message, the channel
 * system message says so), and the runtime authorizes that tool call as the
 * turn's acting member, so a message needs one: the sender if they are a
 * member (email), else the member who connected the channel.
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { formatAttributedUserMessage } from "../chat-author-attribution.js";
import { RUNTIME_REQUEST_ID } from "../../../../src/lib/agent-runtime-shared.js";
import { runtimeDirectThreadsEnabled, startRuntimeTurn } from "./thread-runtime.js";

export interface ChannelTurnRequest {
  threadId: string;
  workspaceId: string;
  orgId: string;
  channelKind: string;
  /** The acting member: the sender, or the channel's connection owner; none when neither is known. */
  userId: string | null;
  userName?: string | null;
  userEmail?: string | null;
  /** The channel system message and the sender's message, as the DO would get them. */
  systemMessage: string;
  message: string;
  clientMessageId?: string | null;
}

export type ChannelTurnResult = { status: "accepted" | "busy" | "error"; error?: string };

/** A relay thread's runtime agent, as ChatThreadDO hands it over. */
export interface RelayRuntimeAgent {
  agentId: string;
  model: string | null;
  keyScope: string | null;
}

export interface ChannelHistoryNote {
  channelKind: string;
  sentAt: number;
  direction?: "inbound" | "outbound";
  sourceThreadId?: string | null;
  connectionId?: string | null;
  remoteConversationId?: string | null;
  providerMessageIds?: string[];
  attachmentCount?: number;
  text?: string | null;
}

/** Outbound channel history waiting for a direct thread's next prompt. */
const NOTES_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_NOTES = 20;

function notesKey(threadId: string): string {
  return `channel_history_notes:${threadId}`;
}

/** The system message that tells a channel thread's agent what a camelAI run already sent there. */
export function formatChannelHistoryNote(note: ChannelHistoryNote): string {
  const lines = [
    "<camelai system message>",
    `A camelAI run sent an outbound ${note.channelKind} message to this channel at ${new Date(note.sentAt).toISOString()}.`,
  ];
  if (note.direction && note.direction !== "outbound") lines.push(`Direction: ${note.direction}.`);
  if (note.sourceThreadId?.trim()) lines.push(`Source thread: ${note.sourceThreadId.trim()}.`);
  if (note.connectionId?.trim()) lines.push(`Channel connection: ${note.connectionId.trim()}.`);
  if (note.remoteConversationId?.trim()) lines.push(`Remote conversation: ${note.remoteConversationId.trim()}.`);
  if (note.providerMessageIds?.length) lines.push(`Provider message ids: ${note.providerMessageIds.join(", ")}.`);
  if (note.attachmentCount && note.attachmentCount > 0) lines.push(`Attachment count: ${note.attachmentCount}.`);
  lines.push("Treat this as already-delivered channel history. Do not resend it unless the user explicitly asks.");
  if (note.text?.trim()) lines.push("", "Delivered message:", note.text.trim());
  lines.push("</camelai system message>");
  return lines.join("\n");
}

/** Keep a note for a direct channel thread; its next prompt carries it. */
export async function queueChannelHistoryNote(env: Pick<ChatEnv, "APP_KV">, threadId: string, note: ChannelHistoryNote): Promise<void> {
  const notes = await env.APP_KV.get<string[]>(notesKey(threadId), "json") ?? [];
  notes.push(formatChannelHistoryNote(note));
  await env.APP_KV.put(notesKey(threadId), JSON.stringify(notes.slice(-MAX_NOTES)), { expirationTtl: NOTES_TTL_SECONDS });
}

async function takeChannelHistoryNotes(env: Pick<ChatEnv, "APP_KV">, threadId: string): Promise<string[]> {
  const notes = await env.APP_KV.get<string[]>(notesKey(threadId), "json") ?? [];
  if (notes.length) await env.APP_KV.delete(notesKey(threadId));
  return notes;
}

async function restoreChannelHistoryNotes(env: Pick<ChatEnv, "APP_KV">, threadId: string, notes: string[]): Promise<void> {
  if (!notes.length) return;
  const later = await env.APP_KV.get<string[]>(notesKey(threadId), "json") ?? [];
  await env.APP_KV.put(notesKey(threadId), JSON.stringify([...notes, ...later].slice(-MAX_NOTES)), { expirationTtl: NOTES_TTL_SECONDS });
}

/**
 * A runtime request id for a channel message: its own id made safe (a
 * redelivery is then the same request), or a new one for channels that
 * give none.
 */
export function channelRequestId(clientMessageId: string | null | undefined): string {
  const safe = (clientMessageId ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  return safe && RUNTIME_REQUEST_ID.test(safe) ? safe : crypto.randomUUID();
}

function orgStub(env: ChatEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
    getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
    setThreadRuntimeAgent(threadId: string, update: {
      agentId: string;
      model: string | null;
      keyScope: string | null;
      configured?: Record<string, unknown> | null;
    }): Promise<ThreadRuntimeRecord | null>;
  };
}

/**
 * The thread's runtime row: its own, or one adopted from the runtime agent
 * ChatThreadDO relays it to (null while that agent's turn runs, or when the
 * thread has none). The adopted row carries no configuration, so the first
 * direct turn configures the agent for the direct path.
 */
export async function directRuntimeRow(
  env: ChatEnv,
  orgId: string,
  threadId: string,
  options: { adopt: boolean },
): Promise<ThreadRuntimeRecord | null> {
  const org = orgStub(env, orgId);
  const row = await org.getThreadRuntime(threadId);
  if (row || !options.adopt) return row;
  const relay = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId)) as unknown as {
    relayRuntimeAgent(): Promise<RelayRuntimeAgent | null>;
  };
  const agent = await relay.relayRuntimeAgent();
  if (!agent) return null;
  return await org.setThreadRuntimeAgent(threadId, { ...agent, configured: null });
}

/**
 * Start a channel message's turn on the direct path; null when the thread is
 * not a direct runtime thread (it stays on ChatThreadDO).
 */
export async function startChannelRuntimeTurn(env: ChatEnv, request: ChannelTurnRequest): Promise<ChannelTurnResult | null> {
  if (!runtimeDirectThreadsEnabled(env)) return null;
  // A relay thread is adopted only with a member to act for it; without
  // one it stays on ChatThreadDO, and a direct thread cannot run the turn
  // (every tool call, the reply's included, is authorized as a member).
  const row = await directRuntimeRow(env, request.orgId, request.threadId, { adopt: Boolean(request.userId) });
  if (!row) return null;
  if (!request.userId) return { status: "error", error: "No workspace member to act for this channel message" };
  const context: ChatContextState = {
    orgId: request.orgId,
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    userId: request.userId,
    userName: request.userName ?? null,
    userEmail: request.userEmail ?? null,
  };
  const notes = await takeChannelHistoryNotes(env, request.threadId);
  // As ChatThreadDO words a channel message: its system context, then the
  // sender and channel ("[slack message from …]: …").
  const text = formatAttributedUserMessage(
    [request.systemMessage, ...notes, request.message].filter(Boolean).join("\n\n"),
    { userName: request.userName, userEmail: request.userEmail, messageSource: request.channelKind },
  );
  const pending: Promise<unknown>[] = [];
  const result = await startRuntimeTurn(env, {
    context,
    row,
    sender: { userId: request.userId, userName: request.userName ?? null, userEmail: request.userEmail ?? null },
    text,
    clientMessageId: channelRequestId(request.clientMessageId),
    source: request.channelKind,
    waitUntil: (promise) => { pending.push(promise); },
  });
  await Promise.allSettled(pending);
  if (result.status !== "accepted") {
    await restoreChannelHistoryNotes(env, request.threadId, notes);
    return { status: result.status, error: result.error };
  }
  return { status: "accepted" };
}
