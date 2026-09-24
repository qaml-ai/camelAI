import { describe, expect, it, vi } from "vitest";
import {
  createMemoryChatTransport,
  type ChatConnectionStatus,
} from "../src/client/use-rivet-chat.ts";
import { applyChatEvent } from "../src/client/message-adapter.ts";
import type { ChatEvent, UiMessage } from "../src/shared/index.ts";

describe("createMemoryChatTransport", () => {
  it("sends a message, broadcasts events, and persists the applied transcript", async () => {
    const transport = createMemoryChatTransport();
    const events: ChatEvent[] = [];
    const statuses: ChatConnectionStatus[] = [];
    let rendered: UiMessage[] = [];

    const session = await transport.connect(
      {
        threadId: "thread-memory",
        workspaceId: "ws-1",
        orgId: "org-1",
        initialTitle: "Memory test",
      },
      {
        onEvent(event) {
          events.push(event);
          rendered = applyChatEvent(rendered, event);
        },
        onStatus(status) {
          statuses.push(status);
        },
        onError: vi.fn(),
      },
    );

    await session.sendMessage({
      content: "Build a dashboard",
      clientMessageId: "client-1",
    });

    expect(statuses).toEqual(["connecting", "connected"]);
    expect(events.map((event) => event.type)).toEqual([
      "messageUpsert",
      "turnStatus",
      "messageUpsert",
      "messageDelta",
      "messageUpsert",
      "turnStatus",
    ]);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toMatchObject({
      id: "client-1",
      role: "user",
      parts: [{ type: "text", text: "Build a dashboard", state: "done" }],
    });
    expect(rendered[1]?.parts).toEqual([
      {
        type: "text",
        text: "Memory mode received: Build a dashboard",
        state: "done",
      },
    ]);

    const snapshot = await session.refresh();
    expect(snapshot.messages).toEqual(rendered);
    expect(snapshot.threadState.title).toBe("Memory test");
    expect(snapshot.turnStatus).toBe("idle");

    await session.dispose();
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("accepts injected events for deterministic UI tests", async () => {
    const transport = createMemoryChatTransport();
    const onEvent = vi.fn();
    await transport.connect(
      {
        threadId: "thread-events",
        workspaceId: "ws-1",
        orgId: "org-1",
      },
      {
        onEvent,
        onStatus: vi.fn(),
        onError: vi.fn(),
      },
    );

    transport.emit("thread-events", {
      type: "state",
      state: { previewUrl: "https://preview.example" },
    });

    expect(onEvent).toHaveBeenCalledWith({
      type: "state",
      state: { previewUrl: "https://preview.example" },
    });
    expect(transport.getSnapshot("thread-events")?.threadState.previewUrl).toBe(
      "https://preview.example",
    );
  });
});
