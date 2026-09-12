// Coalesce overlapping updates, preserving a trailing write for newer completions.
const pendingViews = new Map<string, {
  requestedAgain: boolean;
  promise: Promise<void>;
}>();

/** Best-effort browser write; report failures once per shared request. */
export function markThreadViewed(threadId: string): Promise<void> {
  const existing = pendingViews.get(threadId);
  if (existing) {
    existing.requestedAgain = true;
    return existing.promise;
  }

  const pending = { requestedAgain: false, promise: Promise.resolve() };
  pending.promise = Promise.resolve().then(async () => {
    try {
      do {
        pending.requestedAgain = false;
        const response = await fetch(
          `/api/threads/${encodeURIComponent(threadId)}/mark-viewed`,
          { method: "POST" },
        );
        if (!response.ok) {
          throw new Error(`Failed to mark thread viewed (${response.status})`);
        }
      } while (pending.requestedAgain);
    } catch (error) {
      console.warn("Failed to mark active chat viewed:", error);
    } finally {
      pendingViews.delete(threadId);
    }
  });
  pendingViews.set(threadId, pending);
  return pending.promise;
}
