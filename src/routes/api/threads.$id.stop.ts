import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { abortRuntimeThread } from "../../../workers/main/src/agent-runtime/thread-runtime";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

/** POST /api/threads/:id/stop: stop the runtime thread's running turn. */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { env, row } = await requireRuntimeThread(request, context, params.id, requestWorkspaceId(request));
  if (!row.agentId) return Response.json({ stopped: false });
  await abortRuntimeThread(env, row.agentId);
  return Response.json({ stopped: true });
}
