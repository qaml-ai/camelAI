import type { TodoItem } from "@/components/floating-todo";
import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
import type { Message } from "@/types";

/** Message-bearing fields of the chat loader payload an instant-paint snapshot overrides on a thread switch. */
export interface DisplaySnapshotFields {
  messages: Message[];
  todos: TodoItem[];
}

/**
 * Merge the instant-paint snapshot over the loader payload for a thread
 * switch: when a cached snapshot drives the render, every message-bearing
 * field comes from it, so the newly selected thread never paints the previous
 * loader result's transcript while its own loads.
 */
export function resolveDisplayChatData<T extends DisplaySnapshotFields>(
  resolvedChatData: T,
  cachedSnapshot: ChatThreadSnapshot | null,
  shouldUseCachedSnapshot: boolean,
): T {
  if (!shouldUseCachedSnapshot || !cachedSnapshot) return resolvedChatData;
  return {
    ...resolvedChatData,
    messages: cachedSnapshot.messages,
    todos: cachedSnapshot.todos,
  };
}
