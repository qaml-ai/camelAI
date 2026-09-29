import type { LoaderFunctionArgs } from "react-router";
import { openUnmovedThread, requestWorkspaceId, requireRuntimeThreadAccess } from "@/lib/runtime-threads.server";
import { waitUntil } from "@/lib/wait-until";

/** How long one poll waits for a move it (re)starts before answering "moving". */
const POLL_WAIT_MS = 3_000;

/**
 * GET /api/threads/:id/move: where a thread still on ChatThreadDO stands in
 * its move to the agent runtime, for its page's "Moving this conversation"
 * state: `runtime` (moved: reload), `moving` (poll again), or `readonly`
 * (it cannot move; the page shows its history read-only). Each poll drives
 * the move on (a move backing off after a failure is tried again once its
 * backoff ends).
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const { context: threadContext, row } = await requireRuntimeThreadAccess(
    request,
    context,
    params.id,
    requestWorkspaceId(request),
  );
  const headers = { "Cache-Control": "private, no-store" };
  if (row) return Response.json({ state: "runtime" }, { headers });
  const open = await openUnmovedThread(context, threadContext, waitUntil, POLL_WAIT_MS);
  return Response.json(
    open.state === "readonly" ? { state: "readonly", reason: open.reason } : { state: open.state },
    { headers },
  );
}
