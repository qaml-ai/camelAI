import {
  reportClientEvent,
  type ClientTelemetrySeverity,
} from "./client-error-reporting";
import {
  chatSseCloseCodeForByeReason,
  chatSseCloseCodeForHttpStatus,
  isGracefulServerChatSseBye,
  isIntentionalCleanChatSseTeardown,
  type ChatSseByeReason,
} from "./chat-sse-close";

/**
 * Client-side chat SSE + POST-send telemetry.
 *
 * Every event funnels through reportClientEvent (source "chat_sse" /
 * "chat_runner") into /api/client-errors → OBSERVABILITY_EVENTS, so a user
 * whose stream is reconnect-looping, half-dead (POSTs work, receive dead), or
 * never reattaching leaves a server-side trace without us asking for a HAR.
 *
 * Reporting budgets live in client-error-reporting (40 events/page, 5 per
 * signature). Event `message` strings must stay CONSTANT per event type
 * (variable data rides `details`/`durationMs`/`count`/`status`) so the
 * signature dedupe caps a reconnect loop instead of letting it drain the
 * page budget.
 *
 * Thresholds are carried over verbatim from the WebSocket era so prod rates
 * stay comparable across the cutover.
 */

export const SEND_ACK_TIMEOUT_MS = 15_000;
export const FLAP_WINDOW_MS = 60_000;
export const FLAP_CLOSE_THRESHOLD = 4;

interface RecentClose {
  at: number;
  code: number | null;
}

interface ThreadStreamStats {
  opens: number;
  closes: number;
  errors: number;
  lastOpenAt: number | null;
  lastCloseAt: number | null;
  everOpened: boolean;
  isOpen: boolean;
  recentCloses: RecentClose[];
  lastFlapReportAt: number;
}

/** Everything the transport knows about why a stream ended. */
export interface ChatSseCloseInfo {
  /** HTTP status when the attach itself failed; null for a mid-stream end. */
  status?: number | null;
  byeReason?: ChatSseByeReason | null;
  reason?: string;
  /** True when the client aborted the reader itself (unmount/navigation). */
  aborted?: boolean;
}

const statsByThread = new Map<string, ThreadStreamStats>();

function statsFor(threadId: string): ThreadStreamStats {
  let stats = statsByThread.get(threadId);
  if (!stats) {
    stats = {
      opens: 0,
      closes: 0,
      errors: 0,
      lastOpenAt: null,
      lastCloseAt: null,
      everOpened: false,
      isOpen: false,
      recentCloses: [],
      lastFlapReportAt: 0,
    };
    statsByThread.set(threadId, stats);
  }
  return stats;
}

/** Network/tab context attached to lifecycle events so a dead-network close
 * is distinguishable from a background-tab throttle or a server-side kill. */
function connectionContext(): Record<string, unknown> {
  return {
    online: typeof navigator !== "undefined" ? navigator.onLine : null,
    visibility:
      typeof document !== "undefined" ? document.visibilityState : null,
  };
}

function lifecycleCounts(stats: ThreadStreamStats): Record<string, unknown> {
  return {
    opens: stats.opens,
    closes: stats.closes,
    errors: stats.errors,
    everOpened: stats.everOpened,
    isOpen: stats.isOpen,
  };
}

/** Pure core of reconnect-loop detection: whether `recentCloses` (pruned to the
 * flap window by the caller) crosses the reporting threshold at `now`, honoring
 * one report per window. */
export function shouldReportFlap(
  recentCloses: readonly RecentClose[],
  lastFlapReportAt: number,
  now: number,
): boolean {
  if (recentCloses.length < FLAP_CLOSE_THRESHOLD) return false;
  return now - lastFlapReportAt >= FLAP_WINDOW_MS;
}

export type ChatSseCloseClassification =
  | "clean_teardown"
  | "server_park"
  | "preopen_close"
  | "abnormal_disconnect";

/** Pure core of close classification: which lifecycle event a stream end is. */
export function classifyChatSseClose(
  info: ChatSseCloseInfo,
  connectionWasOpen: boolean,
): ChatSseCloseClassification {
  if (isIntentionalCleanChatSseTeardown({ aborted: info.aborted, connectionWasOpen })) {
    return "clean_teardown";
  }
  // A graceful `bye` (idle park / retry / shutdown) is the server ending the
  // stream on purpose. Counting it as an abnormal disconnect would make a quiet
  // parked thread indistinguishable from the dead-transport signal this module
  // exists to measure, and would let healthy parks crowd the flap window.
  if (connectionWasOpen && isGracefulServerChatSseBye(info.byeReason)) {
    return "server_park";
  }
  return connectionWasOpen ? "abnormal_disconnect" : "preopen_close";
}

/** Only genuine failures may feed reconnect-loop detection; an intentional
 * teardown and a server park are both normal ends of a stream. */
function isChatSseCloseFailure(
  classification: ChatSseCloseClassification,
): boolean {
  return (
    classification === "preopen_close" || classification === "abnormal_disconnect"
  );
}

/** Per-classification event shape. `message` stays CONSTANT per event type — the
 * abnormal case shards by cause on purpose (see the §C rename contract). */
function chatSseCloseReport(
  classification: ChatSseCloseClassification,
  info: ChatSseCloseInfo,
  statusLabel: string,
): {
  event: string;
  severity: ClientTelemetrySeverity;
  status: string;
  message: string;
} {
  switch (classification) {
    case "clean_teardown":
      return {
        event: "chat_sse_clean_teardown",
        severity: "info",
        status: "intentional_clean_teardown",
        message: "Chat SSE stream closed cleanly during intentional teardown.",
      };
    case "server_park":
      return {
        event: "chat_sse_server_park",
        severity: "info",
        status: info.byeReason ?? "park",
        message: "Chat SSE stream was parked by the server.",
      };
    case "preopen_close":
      return {
        event: "chat_sse_preopen_close",
        severity: "error",
        status: "handshake_close",
        message: "Chat SSE stream ended before the first server frame.",
      };
    default:
      return {
        event: "chat_sse_abnormal_disconnect",
        severity: "warn",
        status: statusLabel,
        message: `Chat SSE stream disconnected abnormally (${statusLabel}).`,
      };
  }
}

function closeCodeFor(info: ChatSseCloseInfo): number | null {
  if (typeof info.status === "number") {
    return chatSseCloseCodeForHttpStatus(info.status);
  }
  if (info.byeReason) return chatSseCloseCodeForByeReason(info.byeReason);
  return null;
}

export function trackChatStreamOpen(threadId: string): void {
  const stats = statsFor(threadId);
  const now = Date.now();
  stats.opens += 1;
  const reconnect = stats.everOpened;
  stats.everOpened = true;
  stats.isOpen = true;
  const msSinceLastClose =
    stats.lastCloseAt !== null ? now - stats.lastCloseAt : undefined;
  stats.lastOpenAt = now;
  reportClientEvent({
    source: "chat_sse",
    event: "chat_sse_open",
    severity: "info",
    status: reconnect ? "reconnect" : "connect",
    message: "Chat SSE stream opened.",
    threadId,
    durationMs: msSinceLastClose,
    count: stats.opens,
    details: { ...connectionContext(), ...lifecycleCounts(stats) },
  });
}

export function trackChatStreamClose(
  threadId: string,
  info: ChatSseCloseInfo = {},
): void {
  const stats = statsFor(threadId);
  const now = Date.now();
  stats.closes += 1;
  const connectionWasOpen = stats.isOpen;
  const streamLifeMs =
    connectionWasOpen && stats.lastOpenAt !== null
      ? now - stats.lastOpenAt
      : undefined;
  stats.lastCloseAt = now;
  stats.isOpen = false;
  const classification = classifyChatSseClose(info, connectionWasOpen);
  const code = closeCodeFor(info);
  // "eof" is the SSE equivalent of a 1006: the stream died with no verdict.
  const statusLabel =
    typeof info.status === "number" ? String(info.status) : "eof";
  const isFailure = isChatSseCloseFailure(classification);
  if (isFailure) {
    stats.recentCloses.push({ at: now, code });
    stats.recentCloses = stats.recentCloses.filter(
      (close) => now - close.at <= FLAP_WINDOW_MS,
    );
  }
  // The cause is deliberately part of the abnormal message: distinct causes get
  // their own per-signature reporting budget.
  const report = chatSseCloseReport(classification, info, statusLabel);
  reportClientEvent({
    source: "chat_sse",
    event: report.event,
    severity: report.severity,
    status: report.status,
    statusCode: typeof info.status === "number" ? info.status : undefined,
    message: report.message,
    threadId,
    durationMs: streamLifeMs,
    count: stats.closes,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      code,
      httpStatus: info.status ?? null,
      byeReason: info.byeReason ?? null,
      reason: info.reason || undefined,
      streamLifeMs,
      connectionWasOpen,
      aborted: info.aborted === true,
    },
  });

  if (
    isFailure &&
    shouldReportFlap(stats.recentCloses, stats.lastFlapReportAt, now)
  ) {
    stats.lastFlapReportAt = now;
    const lifetimes = stats.recentCloses
      .map((close, index) =>
        index === 0 ? null : close.at - stats.recentCloses[index - 1].at,
      )
      .filter((value): value is number => value !== null);
    const avgCycleMs = lifetimes.length
      ? Math.round(
          lifetimes.reduce((sum, value) => sum + value, 0) / lifetimes.length,
        )
      : undefined;
    reportClientEvent({
      source: "chat_sse",
      event: "chat_sse_reconnect_loop",
      severity: "error",
      status: "reconnect_loop",
      message: "Chat SSE stream is reconnecting in a loop (repeated attach/end cycles).",
      threadId,
      durationMs: avgCycleMs,
      count: stats.recentCloses.length,
      details: {
        ...connectionContext(),
        ...lifecycleCounts(stats),
        windowMs: FLAP_WINDOW_MS,
        closeCodes: stats.recentCloses.map((close) => close.code),
      },
    });
  }
}

function streamErrorDetails(error: unknown): {
  name?: string;
  message?: string;
  timeout: boolean;
} {
  const record =
    error && typeof error === "object"
      ? (error as { error?: unknown; message?: unknown; name?: unknown })
      : null;
  const nested =
    record?.error && typeof record.error === "object"
      ? (record.error as { message?: unknown; name?: unknown })
      : null;
  const message =
    typeof nested?.message === "string"
      ? nested.message
      : typeof record?.message === "string"
        ? record.message
        : typeof error === "string"
          ? error
          : undefined;
  const name =
    typeof nested?.name === "string"
      ? nested.name
      : typeof record?.name === "string"
        ? record.name
        : undefined;
  return {
    name,
    message,
    timeout: message?.toUpperCase().includes("TIMEOUT") === true,
  };
}

export function trackChatStreamError(threadId: string, error?: unknown): void {
  const stats = statsFor(threadId);
  stats.errors += 1;
  const details = streamErrorDetails(error);
  const preOpen = !stats.isOpen;
  reportClientEvent({
    source: "chat_sse",
    event: preOpen ? "chat_sse_connect_error" : "chat_sse_stream_error",
    severity: preOpen ? "error" : "warn",
    status:
      details.timeout && preOpen
        ? "handshake_timeout"
        : preOpen
          ? "handshake_error"
          : "error",
    message: preOpen
      ? "Chat SSE stream failed before the connection opened."
      : "Chat SSE reader reported a stream error.",
    threadId,
    count: stats.errors,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      errorName: details.name,
      errorMessage: details.message,
      timeout: details.timeout,
    },
  });
}

/** The transport hit a terminal denial and will NOT reconnect — from the
 * user's perspective the thread is dead until a manual refresh. */
export function trackChatStreamTerminalClose(
  threadId: string,
  error: { code?: number; reason?: string; wasClean?: boolean },
): void {
  const stats = statsFor(threadId);
  const code = typeof error.code === "number" ? error.code : null;
  reportClientEvent({
    source: "chat_sse",
    event: "chat_sse_terminal_close",
    severity: "error",
    status: code !== null ? String(code) : "terminal",
    statusCode: code ?? undefined,
    message: "Chat SSE stream closed terminally; client will not reconnect.",
    threadId,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      code,
      reason: error.reason || undefined,
      wasClean: error.wasClean,
    },
  });
}

/** A reconnect flushed user messages that were composed while disconnected. */
export function trackChatReconnectFlush(threadId: string, count: number): void {
  const stats = statsFor(threadId);
  reportClientEvent({
    source: "chat_sse",
    event: "chat_sse_reconnect_flush",
    severity: "info",
    status: "flush",
    message: "Re-sent queued user messages after reconnect.",
    threadId,
    count,
    details: { ...connectionContext(), ...lifecycleCounts(stats) },
  });
}

/** A user hit send while the transport was not open+ready; the message was
 * queued for the reconnect flush instead of dispatched. */
export function trackChatSendQueuedOffline(
  threadId: string,
  info: { readyState: number | null; ready: boolean },
): void {
  const stats = statsFor(threadId);
  reportClientEvent({
    source: "chat_sse",
    event: "chat_post_queued_offline",
    severity: "warn",
    status: "queued",
    message: "User message queued: chat transport not open at send time.",
    threadId,
    details: {
      ...connectionContext(),
      ...lifecycleCounts(stats),
      readyState: info.readyState,
      ready: info.ready,
    },
  });
}

export interface ChatSendTracker {
  accepted(): void;
  rejected(status: string): void;
  failed(error: unknown): void;
}

/**
 * Track one sendMessage RPC. The ack-timeout report is the dead-send detector:
 * the POST went out while the transport reported open but no response came back
 * within SEND_ACK_TIMEOUT_MS — on a healthy connection the ack is sub-second.
 * Pure telemetry; the call's own timeout still owns the user-facing failure.
 */
export function trackChatSendDispatched(opts: {
  threadId: string;
  getReadyState: () => number | null;
}): ChatSendTracker {
  const { threadId, getReadyState } = opts;
  const dispatchedAt = Date.now();
  let settled = false;
  const ackTimer = setTimeout(() => {
    if (settled) return;
    const stats = statsFor(threadId);
    reportClientEvent({
      source: "chat_sse",
      event: "chat_post_ack_timeout",
      severity: "error",
      status: "ack_timeout",
      message: "sendMessage got no ack within the timeout on an open transport.",
      threadId,
      durationMs: Date.now() - dispatchedAt,
      details: {
        ...connectionContext(),
        ...lifecycleCounts(stats),
        readyState: getReadyState(),
        timeoutMs: SEND_ACK_TIMEOUT_MS,
      },
    });
  }, SEND_ACK_TIMEOUT_MS);

  const settle = () => {
    settled = true;
    clearTimeout(ackTimer);
  };

  return {
    accepted() {
      if (settled) return;
      settle();
      reportClientEvent({
        source: "chat_sse",
        event: "chat_post_accepted",
        severity: "info",
        status: "accepted",
        message: "sendMessage acknowledged.",
        threadId,
        durationMs: Date.now() - dispatchedAt,
      });
    },
    rejected(status: string) {
      if (settled) return;
      settle();
      reportClientEvent({
        source: "chat_sse",
        event: "chat_post_rejected",
        severity: "warn",
        status,
        message: "sendMessage was rejected by the server.",
        threadId,
        durationMs: Date.now() - dispatchedAt,
      });
    },
    failed(error: unknown) {
      if (settled) return;
      settle();
      const stats = statsFor(threadId);
      reportClientEvent({
        source: "chat_sse",
        event: "chat_post_failed",
        severity: "error",
        status: "failed",
        message: "sendMessage RPC failed.",
        threadId,
        durationMs: Date.now() - dispatchedAt,
        error,
        details: {
          ...connectionContext(),
          ...lifecycleCounts(stats),
          readyState: getReadyState(),
        },
      });
    },
  };
}

/** The busy indicator has seen zero stream progress for `sinceMs` while the
 * hook still reports an active turn — early warning for a dead receive path. */
export function reportChatStreamNoProgress(
  threadId: string | undefined,
  sinceMs: number,
  status: string,
): void {
  reportClientEvent({
    source: "chat_runner",
    event: "chat_stream_no_progress",
    severity: "warn",
    status,
    message: "Busy turn has made no observable stream progress.",
    threadId: threadId ?? null,
    durationMs: sinceMs,
    details: connectionContext(),
  });
}

/** The stall clamp fired: the stream was provably dead for the full stale
 * bound and the busy indicator was force-cleared. */
export function reportChatStreamStallClamped(
  threadId: string | undefined,
  sinceMs: number,
  status: string,
): void {
  reportClientEvent({
    source: "chat_runner",
    event: "chat_stream_stall_clamped",
    severity: "error",
    status,
    message: "Stream stall clamp fired: busy with no progress past the bound.",
    threadId: threadId ?? null,
    durationMs: sinceMs,
    details: connectionContext(),
  });
}
