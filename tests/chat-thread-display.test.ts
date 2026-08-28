import { describe, expect, it } from "vitest";

import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
import { resolveDisplayChatData } from "@/lib/chat-thread-display";
import type { Message } from "@/types";

function message(id: string, threadId: string): Message {
  return {
    id,
    thread_id: threadId,
    role: "user",
    content: `content-${id}`,
    created_at: 1,
  };
}

function loaderData() {
  return {
    messages: [message("prev-1", "thread-prev")],
    messagesError: null as string | null,
    todos: [],
    previewTabs: [],
    activeTabId: "prev-tab",
  };
}

function snapshotFor(threadId: string): ChatThreadSnapshot {
  return {
    messages: [message("snap-1", threadId)],
    todos: [],
    updatedAt: 123,
  };
}

describe("resolveDisplayChatData", () => {
  it("returns the loader payload when no snapshot drives the render", () => {
    const resolved = loaderData();
    expect(resolveDisplayChatData(resolved, null, false)).toBe(resolved);
    expect(resolveDisplayChatData(resolved, snapshotFor("t"), false)).toBe(
      resolved,
    );
  });

  it("uses the selected thread snapshot and preserves loader metadata", () => {
    const resolved = loaderData();
    const snapshot = snapshotFor("thread-next");
    const merged = resolveDisplayChatData(resolved, snapshot, true);

    expect(merged.messages).toBe(snapshot.messages);
    expect(merged.todos).toBe(snapshot.todos);
    expect(merged.activeTabId).toBe("prev-tab");
    expect(merged.previewTabs).toBe(resolved.previewTabs);
  });
});
