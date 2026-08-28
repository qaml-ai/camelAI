import type { TodoItem } from "@/components/floating-todo";
import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
import type { Message } from "@/types";

export interface DisplaySnapshotFields {
  messages: Message[];
  todos: TodoItem[];
}

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
