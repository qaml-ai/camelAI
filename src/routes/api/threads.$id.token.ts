import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { runtimeReadProxyBase } from "@/lib/agent-runtime-shared";
import { mintRuntimeBrowserToken } from "../../../workers/main/src/agent-runtime/thread-runtime";
import { recordRuntimeTokenMintFailure } from "../../../workers/main/src/agent-runtime/runtime-thread-telemetry";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

/**
 * POST /api/threads/:id/token: a short-lived, read-only token the browser
 * watches the thread's runtime agent with (events, state, history, inputs).
 * 404 until the thread's first message created its agent.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { env, context: threadContext, sender, row } = await requireRuntimeThread(request, context, params.id, requestWorkspaceId(request));
  if (!row.agentId) {
    recordRuntimeTokenMintFailure(env, threadContext, "token_route", { status: "no_agent", statusCode: 404 });
    return Response.json({ error: "The thread has no agent yet" }, { status: 404 });
  }
  try {
    const token = await mintRuntimeBrowserToken(
      env,
      { ...row, agentId: row.agentId },
      sender.userId,
      runtimeReadProxyBase(threadContext.threadId, threadContext.workspaceId),
    );
    return Response.json(token, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    recordRuntimeTokenMintFailure(env, threadContext, "token_route", { error });
    throw error;
  }
}
