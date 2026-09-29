import type { LoaderFunctionArgs } from "react-router";
import { openUnmovedThread, requestWorkspaceId, requireRuntimeThreadAccess } from "@/lib/runtime-threads.server";
import { waitUntil } from "@/lib/wait-until";

/** How long one poll waits for a move it (re)starts before answering "moving". */
const POLL_WAIT_MS = 3_000;

/**
 * GET /api/threads/:id/move: where a thread still on ChatThreadDO stands in
 * its move to the agent runtime, for its page's "Moving this conversation"
 * state (see UnmovedThreadOpen): `runtime` (reload), `moving` (poll again),
 * `retrying` (with `retryAt`), `blocked` (with `message`) or `readonly`
 * (with `reason`). Each poll drives the move on; `?retry=1` (the page's retry
 * button) also ends a backoff after a transient failure.
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
  const retryBackoff = new URL(request.url).searchParams.get("retry") === "1";
  const open = await openUnmovedThread(context, threadContext, waitUntil, POLL_WAIT_MS, { retryBackoff });
  const { row: _row, ...answer } = open as UnmovedThreadOpen & { row?: unknown };
  return Response.json(answer, { headers });
}

type UnmovedThreadOpen = Awaited<ReturnType<typeof openUnmovedThread>>;
