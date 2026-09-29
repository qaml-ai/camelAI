/**
 * A runtime thread's metadata work (completion records and summaries, chat
 * group avatars) with ChatThreadDO's own helpers, run outside any DO: there
 * is no DO state to keep and no DO socket to tell, so those deps do nothing.
 */
import type { ChatContextState } from "../chat-thread/types.js";
import { ChatThreadMetadata, type ChatThreadMetadataEnv } from "../chat-thread/metadata.js";
import { recordWorkspaceThreadStreaming } from "../thread-status.js";

export function runtimeThreadMetadata(
  env: unknown,
  context: ChatContextState,
  waitUntil: (promise: Promise<unknown>) => void,
): ChatThreadMetadata {
  return new ChatThreadMetadata({
    chatContext: () => context,
    env: () => env as ChatThreadMetadataEnv,
    waitUntil,
    titleGenerationInFlight: () => true,
    setTitleGenerationInFlight: () => {},
    setAssistantCompletionRecordedAt: () => {},
    setAssistantCompletionSummaryRequestedAt: () => {},
    setTitle: async () => {},
    broadcastChat: () => {},
    recordWorkspaceThreadStreaming: (workspaceId, threadId, isStreaming, options) =>
      recordWorkspaceThreadStreaming(env as never, workspaceId, threadId, isStreaming, options),
    retryChatDurableObjectRpc: (_operation, fn) => fn(),
    recordChatThreadObservabilityEvent: () => {},
  });
}

/** The chat group avatar a runtime thread's first title earns (ChatThreadDO's generateChatGroupAvatarForThread). */
export async function generateRuntimeThreadGroupAvatar(env: unknown, context: ChatContextState): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await runtimeThreadMetadata(env, context, (promise) => pending.push(promise))
    .maybeGenerateChatGroupAvatarForThread(context.threadId, "first_title");
  await Promise.allSettled(pending);
}
