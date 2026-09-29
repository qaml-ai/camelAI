import {
  createContext,
  use,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { TodoItem } from "@/components/floating-todo";
import type { Message } from "@/types";

export interface ChatThreadSnapshot {
  messages: Message[];
  // Id of the assistant message that was mid-stream when this snapshot was
  // captured (null when idle).
  streamingMessageId: string | null;
  todos: TodoItem[];
  updatedAt: number;
}

interface ChatThreadSnapshotsContextValue {
  getSnapshot: (threadId: string) => ChatThreadSnapshot | null;
  setSnapshot: (threadId: string, snapshot: Omit<ChatThreadSnapshot, "updatedAt">) => void;
}

const ChatThreadSnapshotsContext =
  createContext<ChatThreadSnapshotsContextValue | null>(null);

export function ChatThreadSnapshotsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const snapshotsRef = useRef<Map<string, ChatThreadSnapshot>>(new Map());

  const getSnapshot = useCallback((threadId: string) => {
    return snapshotsRef.current.get(threadId) ?? null;
  }, []);

  const setSnapshot = useCallback(
    (threadId: string, snapshot: Omit<ChatThreadSnapshot, "updatedAt">) => {
      snapshotsRef.current.set(threadId, {
        ...snapshot,
        updatedAt: Date.now(),
      });
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
