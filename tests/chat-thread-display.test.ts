import { describe, expect, it } from "vitest";

import { resolveDisplayChatData } from "@/lib/chat-thread-display";
import type { ChatThreadSnapshot } from "@/hooks/use-chat-thread-snapshots";
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

// The loader payload the route builds; only the message-bearing subset matters
// here, so the extra fields ride along and must be preserved on the merge.
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
    streamingMessageId: null,
    todos: [],
    updatedAt: 123,
  };
}

describe("resolveDisplayChatData", () => {
  it("returns the loader payload when no snapshot drives the render", () => {
    const resolved = loaderData();
    for (const result of [
      resolveDisplayChatData(resolved, null, false),
      resolveDisplayChatData(resolved, snapshotFor("t"), false),
      resolveDisplayChatData(resolved, null, true),
    ]) {
      expect(result).toBe(resolved);
    }
  });

  it("never carries the previous loader result's transcript into a cached-snapshot render", () => {
    // The loader still holds the PREVIOUS thread's data (its second fetch has
    // not resolved), while the snapshot is for the newly selected thread.
    const resolved = loaderData();
    const snapshot = snapshotFor("thread-next");

    const merged = resolveDisplayChatData(resolved, snapshot, true);

    expect(merged.messages).toBe(snapshot.messages);
    expect(merged.todos).toBe(snapshot.todos);
    // Non-message fields still come from the loader payload.
    expect(merged.activeTabId).toBe("prev-tab");
    expect(merged.previewTabs).toBe(resolved.previewTabs);
  });
});
