import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { addThreadToExistingGroup } from "@/lib/chat-groups.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

function addThreadErrorResponse(error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Failed to add thread to group";
  if (message === "Thread not found" || message === "Chat group not found") {
    return Response.json({ error: message }, { status: 404 });
  }
  console.error("Failed to add thread to chat group", error);
  return Response.json(
    { error: "Failed to add thread to group" },
    { status: 500 },
  );
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    { requireWrite: true },
  );
  const groupId = params.id?.trim();
  if (!groupId) {
    return Response.json({ error: "Group ID required" }, { status: 400 });
  }
  const body = (await request.json().catch(() => null)) as
    | { threadId?: unknown }
    | null;
  const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
  if (!threadId) {
    return Response.json({ error: "Thread ID required" }, { status: 400 });
  }
  let group;
  try {
    group = await addThreadToExistingGroup(context, {
      userId,
      orgId,
      workspaceId,
      groupId,
      threadId,
    });
  } catch (error) {
    return addThreadErrorResponse(error);
  }
  return Response.json({ group });
}
