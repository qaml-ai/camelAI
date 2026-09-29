import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";

/** How often the page asks whether the conversation has moved. */
export const MOVE_POLL_INTERVAL_MS = 2_000;

export type ThreadMoveState = "runtime" | "moving" | "readonly";

/**
 * A conversation still on the old chat engine, moving to the new one as it is
 * opened. Polls GET /api/threads/:id/move until the move ends (the thread runs
 * on the runtime, or cannot move and is shown read-only), then hands back to
 * the page, which loads the conversation's new view.
 */
export function ChatMovingNotice({
  threadId,
  workspaceId,
  onSettled,
  intervalMs = MOVE_POLL_INTERVAL_MS,
}: {
  threadId: string;
  workspaceId: string;
  onSettled: (state: Exclude<ThreadMoveState, "moving">) => void;
  intervalMs?: number;
}) {
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/threads/${encodeURIComponent(threadId)}/move?workspaceId=${encodeURIComponent(workspaceId)}`,
          { headers: { Accept: "application/json" } },
        );
        const body = (await response.json().catch(() => null)) as { state?: unknown } | null;
        if (cancelled) return;
        if (body?.state === "runtime" || body?.state === "readonly") {
          onSettledRef.current(body.state);
          return;
        }
      } catch {
        // A poll that fails is only retried.
      }
      if (!cancelled) timer = setTimeout(poll, intervalMs);
    };
    timer = setTimeout(poll, intervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, threadId, workspaceId]);

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
