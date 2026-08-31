import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ContentBlock, Message } from "@/types";
import { boundBlockText } from "./pi-chunk-encoder";
import { uiMessageToMessage } from "./ui-message-adapter";
import { splitUiMessagesAtSteerMarkers } from "./steer-split";
import {
  reportChatStreamNoProgress,
  reportChatStreamStallClamped,
} from "./chat-sse-telemetry";

/**
 * Client bridge onto ai-chat's owned render history (commit 4). Wraps
 * `useAgentChat` so the durable UIMessage list is the single source of truth for
 * the transcript, adapts each UIMessage into the legacy `Message` shape the
 * renderer consumes, and folds in transient live tool output. The send path,
 * optimistic bubbles, and turn-lifecycle side effects stay in Chat.tsx; this hook
 * is purely the history + streaming projection.
 */

type AgentConnection = Parameters<typeof useAgentChat>[0]["agent"];

// Transient per-tool live output chunk (never persisted); see the encoder spec.
const PI_TOOL_STREAM_PART = "data-pi-tool-stream";

/**
 * Busy-state staleness bound. The server kills any turn whose reply stream goes
 * chunk-silent for chatStreamStallTimeoutMs (10min) and finalizes the stream —
 * and a healthy turn emits at least a transient heartbeat every 30s — so a
 * connected client whose busy indicator sees ZERO progress (no chunk via onData,
 * no message-list change) for longer than this is attached to a dead stream
 * (e.g. a resume handshake adopted a stream whose terminal frame was lost).
 * Clamp the indicator to idle instead of spinning forever; any later genuine
 * progress (a recovery continuation's chunks) releases the clamp.
 */
export const STREAM_PROGRESS_STALE_MS = 12 * 60_000;
const STREAM_STALL_POLL_MS = 30_000;

/** Early-warning bound: a busy turn with zero observable progress for this
 * long is reported to telemetry (once per busy window) well before the clamp
 * fires — a healthy turn heartbeats every 30s, so 90s of silence means the
 * receive path is likely dead. */
export const STREAM_NO_PROGRESS_WARN_MS = 90_000;

/** Pure core of the stall clamp: whether a busy stream with its last observed
 * progress at `lastProgressAt` should be treated as dead at `now`. */
export function isStreamProgressStale(
  lastProgressAt: number,
  now: number,
): boolean {
  return now - lastProgressAt >= STREAM_PROGRESS_STALE_MS;
}

export interface PiChatStream {
  /** Adapted transcript: UIMessages → legacy Message, with live tool output and
   * per-message streaming flags applied. */
  messages: Message[];
  /** Raw ai-chat history (UIMessage), for reconciliation/backfill callers. */
  uiMessages: UIMessage[];
  status: string;
  /** True while a client- or server-initiated stream is active for this turn. */
  isStreaming: boolean;
  /** True after an otherwise-busy stream has made no observable progress past
   * the client stall bound. Presentation may hide stale progress UI while this
   * is set, but lifecycle decisions must still honor durable running state.
   * Genuine progress clears it. */
  isStallClamped: boolean;
  /** Id of the assistant message currently streaming (the last assistant in the
   * transcript), or null when idle / awaiting the first token. */
  streamingMessageId: string | null;
  /** Replace the durable render history from a loader payload (deferred initial
   * load, missed-turn revalidation). Guarded by the caller. */
  setUiMessages: (messages: UIMessage[]) => void;
}

/**
 * Fold one transient `data-pi-tool-stream` chunk into the per-tool accumulated
 * output. Returns the next map, or null when the chunk is a no-op (malformed, or
 * a duplicate delivery/replay whose `seq` does not advance the per-tool cursor —
 * useAgentChat can hand the same chunk to `onData` twice, and a reconnect
 * replays the whole buffered stream). `cursors` is advanced in place. The
 * accumulated string is bounded to the shared live-overlay tail so a
 * long-running command cannot grow client memory without bound.
 */
export function applyToolStreamData(
  toolStream: ReadonlyMap<string, string>,
  cursors: Map<string, number>,
  data: unknown,
): Map<string, string> | null {
  const record = data as
    | { toolCallId?: unknown; text?: unknown; seq?: unknown }
    | undefined;
  const toolCallId =
    typeof record?.toolCallId === "string" ? record.toolCallId : null;
  if (!toolCallId) return null;
  const text = typeof record?.text === "string" ? record.text : "";
  const seq = typeof record?.seq === "number" ? record.seq : null;
  if (seq !== null) {
    const lastSeq = cursors.get(toolCallId);
    if (lastSeq !== undefined && seq <= lastSeq) return null;
    cursors.set(toolCallId, seq);
  }
  if (!text) return null;
  const next = new Map(toolStream);
  next.set(toolCallId, boundBlockText((next.get(toolCallId) ?? "") + text));
  return next;
}

/**
 * Collapse duplicate messages sharing one id into a single entry at the FIRST
 * occurrence's position (no mid-turn reorder jump), keeping the copy with the
 * most parts (later copy on ties). The later copy is the one the resumed
 * stream is actively rebuilding, but it starts empty — preferring the richer
 * copy shows the seeded content until the rebuild catches up (equal part
 * count) instead of blanking it for the replay's duration. Returns the input
 * array identity when no id repeats.
 *
 * Why duplicates can exist at all: on a remount, `resume: true` replays the
 * buffered turn stream over the seeded transcript, and the AI SDK's chunk
 * writer only knows "replace last / push" — a replayed `start` whose id exists
 * in the seed but is NOT the tail message (e.g. a steering user skeleton below
 * a completed assistant) pushes a SECOND message under the same id instead of
 * adopting the seeded one. Id-identity dedupe is exact (no content
 * heuristics); part-level duplication is designed out at the seam — seeds
 * never include the in-flight streaming message (see resolveDisplayChatData),
 * so a replay always rebuilds it from scratch.
 */
export function dedupeUiMessagesById(messages: UIMessage[]): UIMessage[] {
  const bestById = new Map<string, UIMessage>();
  for (const message of messages) {
    const best = bestById.get(message.id);
    if (!best || message.parts.length >= best.parts.length) {
      bestById.set(message.id, message);
    }
  }
  if (bestById.size === messages.length) return messages;
  const emitted = new Set<string>();
  const next: UIMessage[] = [];
  for (const message of messages) {
    if (emitted.has(message.id)) continue;
    emitted.add(message.id);
    next.push(bestById.get(message.id) as UIMessage);
  }
  return next;
}

/** Splice a streaming tool_result (accumulated live output) after any tool_use
 * that has not yet settled. Mirrors the legacy overlay's streaming command
 * output; the settled block replaces it once tool-output-available arrives.
 * Returns the message unchanged (same identity) when nothing merges. */
function isAgentProgressTool(name: string): boolean {
  return name === "Task" || name === "Agent" || name === "agent" ||
    name === "Explore" || name === "explore" || name === "Research" ||
    name === "Oracle";
}

export function mergeLiveToolOutput(
  message: Message,
  toolStream: Map<string, string>,
): Message {
  if (typeof message.content === "string") return message;
  const settled = new Set<string>();
  for (const block of message.content) {
    if (block.type === "tool_result") settled.add(block.tool_use_id);
  }
  const next: ContentBlock[] = [];
  let changed = false;
  for (const block of message.content) {
    next.push(block);
    if (block.type === "tool_use" && !settled.has(block.id)) {
      const liveText = toolStream.get(block.id);
      if (liveText) {
        next.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: liveText,
          status: "succeeded",
          ...(isAgentProgressTool(block.name) ? { isTaskUpdate: true } : {}),
          itemId: block.id,
          ...(block.itemKind ? { itemKind: block.itemKind } : {}),
        });
        changed = true;
      }
    }
  }
  return changed ? { ...message, content: next } : message;
}

export function usePiChatStream(opts: {
  agent: AgentConnection;
  threadId: string | undefined;
  initialUiMessages: UIMessage[];
}): PiChatStream {
  const { agent, threadId, initialUiMessages } = opts;

  // Live tool output keyed by toolCallId, fed by transient data-pi-tool-stream
  // chunks. Merged into the adapted tool_result at render, cleared on turn end
  // and thread switch (never persisted). The cursor map (last applied seq per
  // tool) rides alongside and is cleared with it.
  const [toolStream, setToolStream] = useState<Map<string, string>>(
    () => new Map(),
  );
  const toolStreamCursorsRef = useRef<Map<string, number>>(new Map());

  // Stall clamp (see STREAM_PROGRESS_STALE_MS): timestamp of the last observed
  // stream progress — any data-* chunk delivered to onData (tool output AND the
  // transient server heartbeats) or any change to the message list (text/tool
  // chunks replace the streaming message object each tick).
  const lastStreamProgressAtRef = useRef(Date.now());
  const [stallClamped, setStallClamped] = useState(false);
  const noteStreamProgress = useCallback(() => {
    lastStreamProgressAtRef.current = Date.now();
    setStallClamped(false);
  }, []);

  const onData = useCallback(
    (part: { type: string; data?: unknown }) => {
      noteStreamProgress();
      if (part.type !== PI_TOOL_STREAM_PART) return;
      const data = part.data;
      setToolStream((prev) => {
        const next = applyToolStreamData(
          prev,
          toolStreamCursorsRef.current,
          data,
        );
        return next ?? prev;
      });
    },
    [noteStreamProgress],
  );

  const chat = useAgentChat<unknown, UIMessage>({
    agent,
    messages: initialUiMessages,
    getInitialMessages: null,
    syncMessagesToServer: false,
    resume: true,
    onData,
  });

  // Normalized render history: duplicate-id messages collapsed to one exact
  // entry (see dedupeUiMessagesById). This (not chat.messages) is the
  // transcript every consumer sees — including the thread-switch snapshot, so
  // a captured state re-seeds clean.
  const uiMessages = useMemo(
    () => dedupeUiMessagesById(chat.messages),
    [chat.messages],
  );
  const rawIsStreaming = chat.isStreaming;
  const rawStatus = chat.status;

  // Message-list identity changes are stream progress too (text deltas never
  // reach onData). setState inside the effect is safe: it bails unless a clamp
  // was actually set.
  useEffect(() => {
    lastStreamProgressAtRef.current = Date.now();
    setStallClamped(false);
  }, [uiMessages]);

  // While the hook reports busy, poll for progress; clamp once the stream has
  // been provably dead for STREAM_PROGRESS_STALE_MS. Reset the progress clock
  // when a busy window opens so a fresh resume attach gets the full budget.
  const busy =
    rawIsStreaming || rawStatus === "streaming" || rawStatus === "submitted";
  // Telemetry context for the poll below without widening its deps (a mid-turn
  // threadId/status change must not restart the busy window).
  const stallTelemetryRef = useRef({ threadId, status: rawStatus });
  stallTelemetryRef.current = { threadId, status: rawStatus };
  useEffect(() => {
    if (!busy) {
      setStallClamped(false);
      return;
    }
    lastStreamProgressAtRef.current = Date.now();
    // Each report fires at most once per busy window.
    let noProgressReported = false;
    let stallReported = false;
    const timer = setInterval(() => {
      const sinceMs = Date.now() - lastStreamProgressAtRef.current;
      if (sinceMs >= STREAM_NO_PROGRESS_WARN_MS && !noProgressReported) {
        noProgressReported = true;
        reportChatStreamNoProgress(
          stallTelemetryRef.current.threadId,
          sinceMs,
          stallTelemetryRef.current.status,
        );
      }
      if (isStreamProgressStale(lastStreamProgressAtRef.current, Date.now())) {
        if (!stallReported) {
          stallReported = true;
          reportChatStreamStallClamped(
            stallTelemetryRef.current.threadId,
            sinceMs,
            stallTelemetryRef.current.status,
          );
        }
        console.warn(
          "[usePiChatStream] clearing busy indicator: stream reported active with no progress past the stall bound",
        );
        setStallClamped(true);
      }
    }, STREAM_STALL_POLL_MS);
    return () => clearInterval(timer);
  }, [busy]);

  const isStreaming = rawIsStreaming && !stallClamped;
  const status = stallClamped ? "ready" : rawStatus;

  // The streaming assistant is the LAST assistant message, not necessarily the
  // array tail: a steering user skeleton can land below it mid-turn.
  const streamingMessageId = useMemo(() => {
    if (!isStreaming) return null;
    for (let i = uiMessages.length - 1; i >= 0; i -= 1) {
      if (uiMessages[i].role === "assistant") return uiMessages[i].id;
    }
    return null;
  }, [isStreaming, uiMessages]);

  // Steer markers live inside the one raw UIMessage that owns the whole turn.
  // Split only the render projection: loader reconciliation, snapshots, resume
  // seeds, and streaming ids must continue to operate on the raw message list.
  const displayUiMessages = useMemo(
    () =>
      splitUiMessagesAtSteerMarkers(uiMessages, { streamingMessageId }),
    [uiMessages, streamingMessageId],
  );

  // Clear live tool output at each turn boundary and on thread switch so a stale
  // command tail never lingers into the next turn.
  const clearToolStream = useCallback(() => {
    toolStreamCursorsRef.current = new Map();
    setToolStream((prev) => (prev.size > 0 ? new Map() : prev));
  }, []);
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    const was = wasStreamingRef.current;
    wasStreamingRef.current = isStreaming;
    if (was && !isStreaming) clearToolStream();
  }, [clearToolStream, isStreaming]);
  useEffect(() => {
    clearToolStream();
  }, [clearToolStream, threadId]);

  // Adapt each UIMessage once, cached by object identity — ai-chat replaces only
  // the streaming message object per tick, so history never re-adapts. Streaming
  // flag and live tool output are cheap post-steps; mergeLiveToolOutput returns
  // the adapted message identity untouched when it has no unsettled tool with
  // accumulated output.
  const adaptCacheRef = useRef(new WeakMap<UIMessage, Message>());
  const messages = useMemo(() => {
    const cache = adaptCacheRef.current;
    return displayUiMessages.map((ui) => {
      let base = cache.get(ui);
      if (!base) {
        base = uiMessageToMessage(ui, { threadId });
        cache.set(ui, base);
      }
      const streaming = ui.id === streamingMessageId;
      const withLive =
        toolStream.size > 0 ? mergeLiveToolOutput(base, toolStream) : base;
      if (!streaming) return withLive;
      return withLive === base
        ? { ...base, isStreaming: true }
        : { ...withLive, isStreaming: true };
    });
  }, [displayUiMessages, streamingMessageId, toolStream, threadId]);

  const setUiMessages = useCallback(
    (next: UIMessage[]) => {
      chat.setMessages(next);
    },
    [chat],
  );

  return {
    messages,
    uiMessages,
    status,
    isStreaming,
    isStallClamped: stallClamped,
    streamingMessageId,
    setUiMessages,
  };
}
