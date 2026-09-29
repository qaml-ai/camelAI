import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { moveThreadToGroup } from "@/lib/chat-groups.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

function moveThreadErrorResponse(error: unknown): Response {
  const message =
    error instanceof Error && error.message
      ? error.message
      : "Failed to move thread";
  if (message === "Thread not found" || message === "Chat group not found") {
    return Response.json({ error: message }, { status: 404 });
  }
  return Response.json(
    { error: message },
    { status: 409 },
  );
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    { requireWrite: true },
  );
  const body = (await request.json().catch(() => null)) as
    | { threadId?: unknown; targetGroupId?: unknown; name?: unknown }
    | null;
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
  const targetGroupId =
    typeof body?.targetGroupId === "string" ? body.targetGroupId.trim() : "";
  if (!threadId || !targetGroupId) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }
  let group;
  try {
    group = await moveThreadToGroup(context, {
      userId,
      orgId,
      workspaceId,
      threadId,
      targetGroupId,
      name: typeof body?.name === "string" ? body.name : undefined,
    });
  } catch (error) {
    return moveThreadErrorResponse(error);
  }
  return Response.json({ group });
}
