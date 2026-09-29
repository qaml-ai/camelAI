import type { LoaderFunctionArgs } from "react-router";
import { requireSessionWorkspaceAccess } from "@/lib/auth.server";
import * as chatDO from "@/lib/chat-do.server";
import { getGroupForWorkspace } from "@/lib/chat-groups.server";
import { buildCondensedTranscript } from "@/lib/condensed-transcript";

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const threadId = params.id?.trim();
  if (!threadId) {
    return Response.json({ error: "Thread ID required" }, { status: 400 });
  }

  const url = new URL(request.url);
  const groupId = url.searchParams.get("groupId")?.trim();
  if (!groupId) {
    return Response.json({ error: "groupId query param required" }, { status: 400 });
  }

  try {
    const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
      request,
      context,
    );
    const [thread, group] = await Promise.all([
      chatDO.getThread(context, threadId, workspaceId, { orgId }),
      getGroupForWorkspace(context, {
        userId,
        orgId,
        workspaceId,
        groupId,
      }),
    ]);

    if (!thread) {
      return Response.json({ error: "Thread not found" }, { status: 404 });
    }
    if (!group) {
      return Response.json({ error: "Chat group not found" }, { status: 404 });
    }

    const isGroupMember =
      group.open_thread_ids.includes(threadId) ||
      group.closed_thread_ids.includes(threadId);
    if (!isGroupMember) {
      return Response.json({ error: "Thread is not in this chat group" }, { status: 403 });
    }

    const messages = await chatDO.getThreadTranscript(context, { orgId, threadId });
    const transcript = buildCondensedTranscript({
      threadId,
      title: thread.title || "Untitled Chat",
      messages,
    });

    return Response.json(transcript, {
      headers: {
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error("Failed to load condensed transcript:", error);
    return Response.json(
      { error: "Failed to load condensed transcript" },
      { status: 500 },
    );
  }
}
