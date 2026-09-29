import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/** How often the page asks whether a move under way has finished. */
export const MOVE_POLL_INTERVAL_MS = 2_000;
/** A failed move with no time for its next attempt is retried after this. */
export const MOVE_RETRY_FALLBACK_MS = 60_000;

/** Where a thread still on the old chat engine stands in its move (GET /api/threads/:id/move). */
export type ThreadMoveStatus =
  | { state: "moving" }
  | { state: "retrying"; retryAt: number | null }
  | { state: "blocked"; message: string };

type Settled = "runtime" | "readonly";

function parseStatus(body: unknown): ThreadMoveStatus | Settled | null {
  const value = body as { state?: unknown; retryAt?: unknown; message?: unknown } | null;
  switch (value?.state) {
    case "runtime":
    case "readonly":
      return value.state;
    case "moving":
      return { state: "moving" };
    case "retrying":
      return { state: "retrying", retryAt: typeof value.retryAt === "number" ? value.retryAt : null };
    case "blocked":
      return { state: "blocked", message: typeof value.message === "string" ? value.message : "This conversation cannot move yet." };
    default:
      return null;
  }
}

function formatRetryTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * A conversation still on the old chat engine, moving to the new one as it is
 * opened. While the move runs, it polls GET /api/threads/:id/move; a move that
 * failed says when it is tried again (and tries then), and a move that cannot
 * happen yet says why. Both offer to retry now. Once the thread runs on the
 * runtime (or can only be read), it hands back to the page, which loads it.
 */
export function ChatMovingNotice({
  threadId,
  workspaceId,
  initial = { state: "moving" },
  onSettled,
  intervalMs = MOVE_POLL_INTERVAL_MS,
}: {
  threadId: string;
  workspaceId: string;
  initial?: ThreadMoveStatus;
  onSettled: (state: Settled) => void;
  intervalMs?: number;
}) {
  const [status, setStatus] = useState<ThreadMoveStatus>(initial);
  const [checking, setChecking] = useState(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const check = useCallback(async (retry: boolean) => {
    setChecking(true);
    try {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(threadId)}/move?workspaceId=${encodeURIComponent(workspaceId)}${retry ? "&retry=1" : ""}`,
        { headers: { Accept: "application/json" } },
      );
      const next = parseStatus(await response.json().catch(() => null));
      if (!mounted.current) return;
      if (next === "runtime" || next === "readonly") {
        onSettledRef.current(next);
        return;
      }
      // A poll that fails keeps the state it had, and is tried again.
      if (next) setStatus(next);
      else setStatus((current) => ({ ...current }));
    } catch {
      if (mounted.current) setStatus((current) => ({ ...current }));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [threadId, workspaceId]);

  // The next automatic check: soon while moving, at the retry time after a failure, never while blocked.
  useEffect(() => {
    if (status.state === "blocked") return;
    const delay = status.state === "moving"
      ? intervalMs
      : status.retryAt !== null
        ? Math.max(intervalMs, status.retryAt - Date.now())
        : MOVE_RETRY_FALLBACK_MS;
    const timer = setTimeout(() => void check(status.state === "retrying"), delay);
    return () => clearTimeout(timer);
  }, [check, intervalMs, status]);

  if (status.state === "moving") {
    return (
      <div className="flex flex-1 items-center justify-center p-6" role="status" aria-live="polite">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Moving this conversation…</p>
          <p className="text-xs text-muted-foreground">
            It is moving to camelAI's new chat engine. This takes a moment, and it opens here when it is done.
          </p>
        </div>
      </div>
    );
  }

  const detail = status.state === "blocked"
    ? status.message
    : status.retryAt !== null
      ? `Retrying at ${formatRetryTime(status.retryAt)}.`
      : "It will be tried again shortly.";
  return (
    <div className="flex flex-1 items-center justify-center p-6" role="status" aria-live="polite">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Couldn't move this conversation yet</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
        <Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => void check(true)}>
          {checking ? "Retrying…" : "Retry now"}
        </Button>
      </div>
    </div>
  );
}

/** What a conversation that could not move says above its read-only history. */
export function readOnlyMoveNotice(reason: string, truncated: boolean): string {
  const why =
    reason === "too_large"
      ? "It is too large to move to camelAI's new chat engine"
      : reason === "invalid_history"
        ? "Its history could not be moved to camelAI's new chat engine"
        : reason === "no_route"
          ? "Its model is not available on camelAI's new chat engine"
          : "It could not be moved to camelAI's new chat engine";
  return `${why}, so it is read-only. Start a new chat to continue.${truncated ? " Only its most recent messages are shown." : ""}`;
}
