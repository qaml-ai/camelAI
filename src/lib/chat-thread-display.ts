import type { UIMessage } from "ai";
import type { TodoItem } from "@/components/floating-todo";
import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
import type { Message } from "@/types";

/**
 * Message-bearing fields of the chat loader payload that an instant-paint
 * snapshot overrides on a thread switch. `initialUiMessages` seeds the remounted
 * Chat/useAgentChat, so it MUST be overridden alongside `messages`/`todos`.
 */
export interface DisplaySnapshotFields {
  messages: Message[];
  initialUiMessages: UIMessage[];
  olderUiMessagesCursor?: string | null;
  todos: TodoItem[];
}

/**
 * Merge the instant-paint snapshot over the loader payload for a thread switch.
 * When a cached snapshot drives the render, EVERY message-bearing field comes
 * from the snapshot — including `initialUiMessages`. Reusing the loader's
 * `initialUiMessages` here would seed the newly-selected thread with the PREVIOUS
 * loader result's render history and briefly paint another thread's transcript
 * (Chat prefers non-empty `piChat.messages` over the legacy fallback) until the
 * second loader fetch resolves.
 *
 * Ownership seam: the useAgentChat seed (`initialUiMessages`) EXCLUDES the
 * message that was mid-stream at capture time. History comes from the seed;
 * the in-flight turn comes from the resumed stream, exclusively — it rebuilds
 * that message from scratch, so a hydrated copy underneath the replay (the old
 * part-duplication bug) can't exist. `bridgedStreamingMessageId` tells Chat
 * which message to keep painting from the legacy snapshot view until the
 * stream re-delivers it.
 */
export function resolveDisplayChatData<T extends DisplaySnapshotFields>(
  resolvedChatData: T,
  cachedSnapshot: ChatThreadSnapshot | null,
  shouldUseCachedSnapshot: boolean,
): T & { bridgedStreamingMessageId: string | null } {
  if (!shouldUseCachedSnapshot || !cachedSnapshot) {
    return { ...resolvedChatData, bridgedStreamingMessageId: null };
  }
  const streamingMessageId = cachedSnapshot.streamingMessageId;
  return {
    ...resolvedChatData,
    messages: cachedSnapshot.messages,
    initialUiMessages: streamingMessageId
      ? cachedSnapshot.uiMessages.filter(
          (message) => message.id !== streamingMessageId,
        )
      : cachedSnapshot.uiMessages,
    // A snapshot only owns its resident window. The loader cursor may belong to
    // a different thread while a tab switch is painting from cache.
    olderUiMessagesCursor: null,
    todos: cachedSnapshot.todos,
    bridgedStreamingMessageId: streamingMessageId,
  };
}
