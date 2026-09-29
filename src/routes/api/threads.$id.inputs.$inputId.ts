import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { answerRuntimeInput } from "../../../workers/main/src/agent-runtime/thread-runtime";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

const ACTIONS = new Set(["accept", "decline", "cancel"]);

export const loader = actionOnlyLoader('POST');

/**
 * POST /api/threads/:id/inputs/:inputId {action, content?}: answer a human
 * input the thread's agent waits on (an ask_user question, an approval, a
 * confirmation), as the signed-in user.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const body = (await request.json().catch(() => null)) as
    | { action?: unknown; content?: unknown; workspaceId?: unknown }
    | null;
  const inputId = params.inputId?.trim();
  if (!inputId) return Response.json({ error: "Input ID required" }, { status: 400 });
  if (typeof body?.action !== "string" || !ACTIONS.has(body.action)) {
    return Response.json({ error: "action must be accept, decline or cancel" }, { status: 400 });
  }
  const { env, sender, row } = await requireRuntimeThread(request, context, params.id, requestWorkspaceId(request, body));
  if (!row.agentId) return Response.json({ error: "The thread has no agent yet" }, { status: 404 });
  const answered = await answerRuntimeInput(
    env,
    row.agentId,
    inputId,
    { action: body.action as "accept" | "decline" | "cancel", ...(body.content !== undefined ? { content: body.content } : {}) },
    sender,
  );
  return Response.json(answered.body, { status: answered.status });
}
