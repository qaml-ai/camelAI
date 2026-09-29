import type { AppLoadContext } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import * as chatDO from "@/lib/chat-do.server";
import type { Message } from "@/types";
import {
  recordErrorEvent,
  recordObservabilityEvent,
} from "../../workers/main/src/observability";

interface ReadThreadMessagesOptions {
  workspaceId: string;
  orgId: string;
  threadId: string;
  skipBanCheck?: boolean;
}

export async function readThreadMessages(
  context: AppLoadContext,
  {
    workspaceId,
    orgId,
    threadId,
    skipBanCheck = false,
  }: ReadThreadMessagesOptions,
): Promise<Message[]> {
  void skipBanCheck;
  const env = getEnv(context);
  const startedAt = Date.now();
  try {
    const piMessages = await chatDO.getThreadTranscript(context, { orgId, threadId });
    recordObservabilityEvent(env, {
      event: "chat_history_read",
      component: "react_router",
      operation: "read_thread_messages",
      status: piMessages.length > 0 ? "pi_core_hit" : "empty",
      threadId,
      workspaceId,
      orgId,
      count: piMessages.length,
      durationMs: Date.now() - startedAt,
    });
    return piMessages as Message[];
  } catch (error) {
    recordErrorEvent(env, {
      event: "chat_history_read_exception",
      component: "react_router",
      operation: "read_thread_messages",
      status: "exception",
      threadId,
      workspaceId,
      orgId,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}
