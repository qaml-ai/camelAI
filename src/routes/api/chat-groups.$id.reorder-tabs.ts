import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

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
    | { orderedThreadIds?: unknown }
    | null;
  if (
    !Array.isArray(body?.orderedThreadIds) ||
    !body.orderedThreadIds.every((threadId) => typeof threadId === "string")
  ) {
    return Response.json({ error: "Invalid tab order" }, { status: 400 });
  }
  const orderedThreadIds = body.orderedThreadIds as string[];
  const authEnv = getAuthEnv(getEnv(context));
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const group = await userStub.getChatGroup(groupId);
  if (!group || group.org_id !== orgId || group.workspace_id !== workspaceId) {
    return Response.json({ error: "Group not found" }, { status: 404 });
  }
  const summary = await userStub.getChatGroupSummary(groupId);
  const openThreadIds = summary?.open_thread_ids ?? [];
  const orderedSet = new Set(orderedThreadIds);
  const openSet = new Set(openThreadIds);
  const isExactOpenSet =
    orderedSet.size === orderedThreadIds.length &&
    orderedThreadIds.length === openThreadIds.length &&
    orderedThreadIds.every((threadId) => openSet.has(threadId));
  if (!isExactOpenSet) {
    return Response.json(
      { error: "Tab order must exactly match open tabs" },
      { status: 400 },
    );
  }
  await userStub.reorderThreadTabs(groupId, orderedThreadIds);
  return Response.json({ success: true });
}
