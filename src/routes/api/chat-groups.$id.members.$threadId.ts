import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import * as chatDO from "@/lib/chat-do.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('DELETE');

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "DELETE") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    { requireWrite: true },
  );
  const groupId = params.id?.trim();
  const threadId = params.threadId?.trim();
  if (!groupId || !threadId) {
    return Response.json({ error: "Missing required IDs" }, { status: 400 });
  }
  const thread = await chatDO.getThread(context, threadId, workspaceId, {
    orgId,
  });
  if (!thread) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const authEnv = getAuthEnv(getEnv(context));
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const group = await userStub.getChatGroup(groupId);
  if (!group || group.org_id !== orgId || group.workspace_id !== workspaceId) {
    return Response.json({ error: "Group not found" }, { status: 404 });
  }
  const summary = await userStub.getChatGroupSummary(groupId);
  if (!summary?.open_thread_ids.includes(threadId)) {
    return Response.json(
      { error: "Thread is not an open tab in this group" },
      { status: 404 },
    );
  }
  await userStub.closeThreadTab(threadId);
  return Response.json({ success: true });
}
