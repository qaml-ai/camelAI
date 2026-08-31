import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import type { TodoItem } from "@/components/floating-todo";
import {
  ChatThreadSnapshotsProvider,
  useChatThreadSnapshots,
} from "@/hooks/use-chat-thread-snapshots";
import { CHAT_RUNTIME_BOUNDS } from "@/lib/chat-runtime-bounds";
import type { Message } from "@/types";

function wrapper({ children }: { children: ReactNode }) {
  return <ChatThreadSnapshotsProvider>{children}</ChatThreadSnapshotsProvider>;
}

function message(id: string, content = id): Message {
  return {
    id,
    thread_id: id,
    role: "assistant",
    content,
    created_at: 1,
  };
}

describe("ChatThreadSnapshotsProvider", () => {
  it("evicts the least-recently-used entry at the count bound", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });

    act(() => {
      for (
        let index = 0;
        index < CHAT_RUNTIME_BOUNDS.clientSnapshotCacheEntries;
        index += 1
      ) {
        result.current.setSnapshot(`thread-${index}`, {
          messages: [message(`message-${index}`)],
          todos: [],
        });
      }
      expect(result.current.getSnapshot("thread-0")).not.toBeNull();
      result.current.setSnapshot("thread-extra", {
        messages: [message("message-extra")],
        todos: [],
      });
    });

    expect(result.current.getSnapshot("thread-0")).not.toBeNull();
    expect(result.current.getSnapshot("thread-1")).toBeNull();
    expect(result.current.getSnapshot("thread-extra")).not.toBeNull();
  });

  it("enforces the aggregate byte bound independently of entry count", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });
    const content = "x".repeat(
      Math.floor(CHAT_RUNTIME_BOUNDS.clientSnapshotCacheBytes / 4),
    );

    act(() => {
      for (let index = 0; index < 4; index += 1) {
        result.current.setSnapshot(`large-${index}`, {
          messages: [message(`large-message-${index}`, content)],
          todos: [],
        });
      }
    });

    expect(result.current.getSnapshot("large-0")).toBeNull();
    expect(result.current.getSnapshot("large-3")).not.toBeNull();
  });

  it("keeps the settled snapshot instead of caching a live overlay", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });

    act(() => {
      result.current.setSnapshot("thread-live", {
        messages: [message("settled", "settled content")],
        todos: [],
      });
      result.current.setSnapshot("thread-live", {
        messages: [
          {
            ...message("live", "large attempt-local content"),
            isStreaming: true,
          },
        ],
        todos: [],
      });
    });

    expect(result.current.getSnapshot("thread-live")?.messages).toMatchObject([
      { id: "settled", content: "settled content" },
    ]);
  });

  it("does not retain a snapshot larger than the per-entry bound", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });

    act(() => {
      result.current.setSnapshot("too-large", {
        messages: [
          message(
            "too-large-message",
            "x".repeat(CHAT_RUNTIME_BOUNDS.clientSnapshotCacheEntryBytes),
          ),
        ],
        todos: [],
      });
    });

    expect(result.current.getSnapshot("too-large")).toBeNull();
  });

  it("does not retain more than the client snapshot message bound", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });
    act(() => {
      result.current.setSnapshot("too-many", {
        messages: Array.from(
          { length: CHAT_RUNTIME_BOUNDS.snapshotMessages + 1 },
          (_, index) => message(String(index), ""),
        ),
        todos: [],
      });
    });
    expect(result.current.getSnapshot("too-many")).toBeNull();
  });

  it("retains a detached frozen snapshot when the caller mutates its input", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });
    const sourceMessage = message("detached", "original");
    const source = { messages: [sourceMessage], todos: [] };

    act(() => result.current.setSnapshot("thread-detached", source));
    sourceMessage.content = "mutated source";
    source.messages.push(message("later"));

    const cached = result.current.getSnapshot("thread-detached");
    expect(cached?.messages).toMatchObject([
      { id: "detached", content: "original" },
    ]);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached?.messages)).toBe(true);
    expect(Object.isFrozen(cached?.messages[0])).toBe(true);
    expect(() => {
      cached!.messages[0].content = "mutated cache";
    }).toThrow();
    expect(result.current.getSnapshot("thread-detached")?.messages[0].content).toBe(
      "original",
    );
  });

  it("rejects accessor-backed snapshots without invoking their getters", () => {
    const { result } = renderHook(() => useChatThreadSnapshots(), { wrapper });
    let getterReads = 0;
    const snapshot = { todos: [] } as unknown as {
      messages: Message[];
      todos: TodoItem[];
    };
    Object.defineProperty(snapshot, "messages", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        throw new Error("getter must not run");
      },
    });

    act(() => result.current.setSnapshot("thread-getter", snapshot));

    expect(getterReads).toBe(0);
    expect(result.current.getSnapshot("thread-getter")).toBeNull();
  });
});
