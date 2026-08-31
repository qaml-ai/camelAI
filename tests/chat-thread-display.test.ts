import type { UIMessage } from "ai";
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

function uiMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: `ui-${id}`, state: "done" }],
  } as unknown as UIMessage;
}

// The loader payload the route builds; only the message-bearing subset matters
// here, so the extra fields ride along and must be preserved on the merge.
function loaderData() {
  return {
    messages: [message("prev-1", "thread-prev")],
    messagesError: null as string | null,
    initialUiMessages: [uiMessage("prev-ui-1")],
    olderUiMessagesCursor: "previous-thread-cursor",
    todos: [],
    previewTabs: [],
    activeTabId: "prev-tab",
  };
}

function snapshotFor(
  threadId: string,
  streamingMessageId: string | null = null,
): ChatThreadSnapshot {
  return {
    messages: [message(`snap-1`, threadId)],
    uiMessages: [uiMessage(`snap-ui-${threadId}`)],
    streamingMessageId,
    todos: [],
    updatedAt: 123,
  };
}

describe("resolveDisplayChatData", () => {
  it("returns the loader payload (plus a null bridge id) when no snapshot drives the render", () => {
    const resolved = loaderData();
    for (const result of [
      resolveDisplayChatData(resolved, null, false),
      resolveDisplayChatData(resolved, snapshotFor("t"), false),
      resolveDisplayChatData(resolved, null, true),
    ]) {
      expect(result.messages).toBe(resolved.messages);
      expect(result.initialUiMessages).toBe(resolved.initialUiMessages);
      expect(result.bridgedStreamingMessageId).toBeNull();
    }
  });

  it("never carries the previous loader result's initialUiMessages into a cached-snapshot render", () => {
    // Loader still holds the PREVIOUS thread's data (its second fetch has not
    // resolved), while the snapshot is for the newly-selected thread.
    const resolved = loaderData();
    const snapshot = snapshotFor("thread-next");

    const merged = resolveDisplayChatData(resolved, snapshot, true);

    // initialUiMessages must come from the snapshot, not the stale loader list —
    // otherwise the remounted Chat paints the previous thread's transcript.
    expect(merged.initialUiMessages).toBe(snapshot.uiMessages);
    expect(merged.initialUiMessages).not.toBe(resolved.initialUiMessages);
    expect(merged.messages).toBe(snapshot.messages);
    expect(merged.todos).toBe(snapshot.todos);
    expect(merged.bridgedStreamingMessageId).toBeNull();
    expect(merged.olderUiMessagesCursor).toBeNull();

    // Non-message fields still come from the loader payload.
    expect(merged.activeTabId).toBe("prev-tab");
    expect(merged.previewTabs).toBe(resolved.previewTabs);
  });

  it("excludes the mid-stream message from the seed and reports it as the bridge id", () => {
    // Ownership seam: the resumed stream rebuilds the in-flight message from
    // scratch; seeding a hydrated copy underneath the replay is what used to
    // duplicate parts. The excluded id is bridged from the legacy view instead.
    const resolved = loaderData();
    const snapshot = snapshotFor("thread-live", "turn-live");
    snapshot.uiMessages = [
      uiMessage("snap-user"),
      uiMessage("turn-live"),
      uiMessage("snap-steer"),
    ];

    const merged = resolveDisplayChatData(resolved, snapshot, true);

    expect(merged.initialUiMessages.map((m) => m.id)).toEqual([
      "snap-user",
      "snap-steer",
    ]);
    expect(merged.bridgedStreamingMessageId).toBe("turn-live");
    // The legacy paint view keeps the full transcript (bridge source).
    expect(merged.messages).toBe(snapshot.messages);
  });
});
