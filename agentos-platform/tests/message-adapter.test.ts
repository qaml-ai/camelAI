import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  uiMessageToChatMessage,
} from "../src/client/message-adapter.ts";
import type { UiMessage } from "../src/shared/index.ts";

describe("uiMessageToChatMessage", () => {
  it("maps render parts to durable content blocks", () => {
    const ui: UiMessage = {
      id: "message-1",
      role: "assistant",
      createdAt: 123,
      parts: [
        { type: "reasoning", text: "Checking files", state: "done" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "read_file",
          input: { path: "README.md" },
          state: "output-available",
        },
        {
          type: "tool-result",
          toolCallId: "tool-1",
          toolName: "read_file",
          output: { content: "# Project" },
        },
        { type: "text", text: "The project is ready.", state: "done" },
        {
          type: "data-todos",
          data: {
            todos: [
              {
                content: "Inspect files",
                activeForm: "Inspecting files",
                status: "completed",
              },
            ],
          },
        },
      ],
    };

    expect(uiMessageToChatMessage(ui, "thread-1")).toEqual({
      id: "message-1",
      threadId: "thread-1",
      role: "assistant",
      createdAt: 123,
      isStreaming: false,
      content: [
        { type: "thinking", thinking: "Checking files" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "README.md" },
        },
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: '{\n  "content": "# Project"\n}',
          is_error: undefined,
        },
        { type: "text", text: "The project is ready." },
      ],
    });
  });
});

describe("applyChatEvent", () => {
  it("upserts durable messages and appends streaming text deltas", () => {
    const initial = applyChatEvent([], {
      type: "messageUpsert",
      message: {
        id: "assistant-1",
        threadId: "thread-1",
        role: "assistant",
        createdAt: 100,
        content: [{ type: "text", text: "Hello" }],
        isStreaming: true,
      },
    });

    const next = applyChatEvent(initial, {
      type: "messageDelta",
      messageId: "assistant-1",
      textDelta: ", world",
    });

    expect(next).not.toBe(initial);
    expect(next[0]?.parts).toEqual([
      { type: "text", text: "Hello, world", state: "streaming" },
    ]);
  });

  it("replaces keyed tool parts without mutating prior state", () => {
    const original: UiMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: 100,
        parts: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "write_file",
            input: {},
            state: "input-streaming",
          },
        ],
      },
    ];

    const next = applyChatEvent(original, {
      type: "messageDelta",
      messageId: "assistant-1",
      parts: [
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "write_file",
          input: { path: "src/index.ts" },
          state: "input-available",
        },
      ],
    });

    expect(next[0]?.parts).toEqual([
      expect.objectContaining({
        toolCallId: "tool-1",
        input: { path: "src/index.ts" },
        state: "input-available",
      }),
    ]);
    expect(original[0]?.parts[0]).toMatchObject({
      input: {},
      state: "input-streaming",
    });
  });
});
