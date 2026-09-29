import { reportClientEvent } from "./client-error-reporting";

/**
 * Client-side timing of starting a new chat, from the click that submits the
 * new-chat composer (`markNewChatSubmitted`) to what the user sees on the new
 * thread's page. Each stage is reported once per thread as a
 * `new_chat_timing` event (source `chat_new_thread`, `status` = the stage,
 * `durationMs` = time since the click), next to the server's
 * `chat_create_thread_stage` and `runtime_thread_send_timing`.
 *
 *   thread_visible       the thread's page rendered the user's message
 *   first_send_accepted  the runtime took the first message
 *   first_output         the first streamed output (reasoning or text)
 */
export type NewChatTimingStage =
  | "thread_visible"
  | "first_send_accepted"
  | "first_output";

/** A click older than this is not what the thread's page is timing. */
const MAX_CLICK_AGE_MS = 60_000;

let submittedAt: number | null = null;
const timedThreads = new Map<string, { startedAt: number; reported: Set<NewChatTimingStage> }>();

export function markNewChatSubmitted(now = Date.now()): void {
  submittedAt = now;
}

/** Forget the click (the action failed and the composer is back). */
export function clearNewChatSubmitted(): void {
  submittedAt = null;
}

/**
 * Report `stage` for `threadId`, once. The first thread page to show its new
 * first message (`thread_visible`) after a click claims the click; a thread
 * opened any other way reports nothing.
 */
export function trackNewChatStage(
  threadId: string | null | undefined,
  stage: NewChatTimingStage,
  now = Date.now(),
): number | null {
  if (!threadId) return null;
  let timed = timedThreads.get(threadId);
  if (!timed) {
    if (stage !== "thread_visible" || submittedAt === null || now - submittedAt > MAX_CLICK_AGE_MS) return null;
    timed = { startedAt: submittedAt, reported: new Set() };
    submittedAt = null;
    timedThreads.set(threadId, timed);
  }
  if (timed.reported.has(stage)) return null;
  timed.reported.add(stage);
  const durationMs = Math.max(0, now - timed.startedAt);
  reportClientEvent({
    source: "chat_new_thread",
    event: "new_chat_timing",
    severity: "info",
    status: stage,
    message: "New chat timing.",
    threadId,
    durationMs,
  });
  return durationMs;
}

/** When the click that started `threadId` happened, once its page claimed it (see trackNewChatStage). */
export function newChatStartedAt(threadId: string | null | undefined): number | null {
  return threadId ? timedThreads.get(threadId)?.startedAt ?? null : null;
}

/** For tests. */
export function resetNewChatTiming(): void {
  submittedAt = null;
  timedThreads.clear();
}
