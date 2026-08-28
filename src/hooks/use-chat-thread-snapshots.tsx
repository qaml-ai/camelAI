import {
  createContext,
  use,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { TodoItem } from "@/components/floating-todo";
import { CHAT_RUNTIME_BOUNDS } from "@/lib/chat-runtime-bounds";
import {
  boundedPlainJsonClone,
  type BoundedPlainJsonResult,
} from "@/lib/chat-runtime-client";
import type { Message } from "@/types";

export interface ChatThreadSnapshot {
  messages: Message[];
  todos: TodoItem[];
  updatedAt: number;
}

interface ChatThreadSnapshotsContextValue {
  getSnapshot: (threadId: string) => ChatThreadSnapshot | null;
  setSnapshot: (
    threadId: string,
    snapshot: Omit<ChatThreadSnapshot, "updatedAt">,
  ) => void;
}

const ChatThreadSnapshotsContext =
  createContext<ChatThreadSnapshotsContextValue | null>(null);

interface CachedChatThreadSnapshot {
  snapshot: ChatThreadSnapshot;
  byteSize: number;
}

function freezeSnapshot(snapshot: ChatThreadSnapshot): ChatThreadSnapshot {
  const pending: object[] = [snapshot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (
        descriptor &&
        "value" in descriptor &&
        descriptor.value !== null &&
        typeof descriptor.value === "object"
      ) {
        pending.push(descriptor.value);
      }
    }
    Object.freeze(current);
  }
  return snapshot;
}

export function ChatThreadSnapshotsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const snapshotsRef = useRef<Map<string, CachedChatThreadSnapshot>>(new Map());
  const snapshotBytesRef = useRef(0);

  const getSnapshot = useCallback((threadId: string) => {
    const cached = snapshotsRef.current.get(threadId);
    if (!cached) return null;
    // Map insertion order is the LRU order. Reads make an entry recent.
    snapshotsRef.current.delete(threadId);
    snapshotsRef.current.set(threadId, cached);
    return cached.snapshot;
  }, []);

  const setSnapshot = useCallback(
    (threadId: string, snapshot: Omit<ChatThreadSnapshot, "updatedAt">) => {
      if (
        threadId.length === 0 ||
        threadId.length > CHAT_RUNTIME_BOUNDS.identifierChars
      ) {
        return;
      }
      let detached: BoundedPlainJsonResult<ChatThreadSnapshot>;
      try {
        const messages = Object.getOwnPropertyDescriptor(snapshot, "messages");
        const todos = Object.getOwnPropertyDescriptor(snapshot, "todos");
        if (
          !messages?.enumerable ||
          !("value" in messages) ||
          !todos?.enumerable ||
          !("value" in todos)
        ) {
          return;
        }
        detached = boundedPlainJsonClone<ChatThreadSnapshot>(
          {
            messages: messages.value,
            todos: todos.value,
            updatedAt: Date.now(),
          },
          CHAT_RUNTIME_BOUNDS.clientSnapshotCacheEntryBytes,
        );
      } catch {
        return;
      }
      const nextSnapshot = detached.value;
      if (
        !Array.isArray(nextSnapshot.messages) ||
        nextSnapshot.messages.length > CHAT_RUNTIME_BOUNDS.snapshotMessages ||
        !Array.isArray(nextSnapshot.todos)
      ) {
        return;
      }
      // Keep the last settled snapshot while a turn is live. Besides avoiding
      // attempt-local retention, this is a defensive boundary for all callers.
      if (
        nextSnapshot.messages.some(
          (message) => message && message.isStreaming === true,
        )
      ) {
        return;
      }
      freezeSnapshot(nextSnapshot);

      const previous = snapshotsRef.current.get(threadId);
      if (previous) {
        snapshotsRef.current.delete(threadId);
        snapshotBytesRef.current -= previous.byteSize;
      }

      snapshotsRef.current.set(threadId, {
        snapshot: nextSnapshot,
        byteSize: detached.bytes,
      });
      snapshotBytesRef.current += detached.bytes;

      while (
        snapshotsRef.current.size >
          CHAT_RUNTIME_BOUNDS.clientSnapshotCacheEntries ||
        snapshotBytesRef.current > CHAT_RUNTIME_BOUNDS.clientSnapshotCacheBytes
      ) {
        const oldestThreadId = snapshotsRef.current.keys().next().value;
        if (typeof oldestThreadId !== "string") break;
        const oldest = snapshotsRef.current.get(oldestThreadId);
        snapshotsRef.current.delete(oldestThreadId);
        snapshotBytesRef.current -= oldest?.byteSize ?? 0;
      }
    },
    [],
  );

  const value = useMemo(
    () => ({
      getSnapshot,
      setSnapshot,
    }),
    [getSnapshot, setSnapshot],
  );

  return (
    <ChatThreadSnapshotsContext.Provider value={value}>
      {children}
    </ChatThreadSnapshotsContext.Provider>
  );
}

export function useChatThreadSnapshots() {
  const context = use(ChatThreadSnapshotsContext);
  if (!context) {
    throw new Error(
      "useChatThreadSnapshots must be used within ChatThreadSnapshotsProvider",
    );
  }
  return context;
}
