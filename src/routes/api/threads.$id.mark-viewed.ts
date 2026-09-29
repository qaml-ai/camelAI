import type { ActionFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import * as chatDO from "@/lib/chat-do.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
  );
  const threadId = params.id?.trim();
  if (!threadId) {
    return Response.json({ error: "Thread ID required" }, { status: 400 });
  }
  const thread = await chatDO.getThread(context, threadId, workspaceId, {
    orgId,
  });
  if (!thread) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const authEnv = getAuthEnv(getEnv(context));
  await authEnv.USER.get(authEnv.USER.idFromName(userId)).markThreadViewed(
    threadId,
  );
  return Response.json({ success: true });
}
