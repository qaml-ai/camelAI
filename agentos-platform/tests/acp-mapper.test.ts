import { describe, expect, test } from "vitest";
import {
  mapAcpSessionEntries,
  mapAcpSessionEntry,
} from "../src/server/chat/acp-mapper.ts";

const options = { messageId: "assistant:client-1" };

describe("ACP session event mapper", () => {
  test("maps agent text and thought chunks", () => {
    expect(
      mapAcpSessionEntries(
        [
          {
            type: "agent_message_chunk",
            content: { type: "text", text: "Hello" },
          },
          {
            type: "agent_thought_chunk",
            content: { type: "text", text: "Considering files" },
          },
        ],
        options,
      ),
    ).toEqual([
      {
        type: "messageDelta",
        messageId: "assistant:client-1",
        textDelta: "Hello",
      },
      {
        type: "messageDelta",
        messageId: "assistant:client-1",
        parts: [
          {
            type: "reasoning",
            text: "Considering files",
            state: "streaming",
          },
        ],
      },
    ]);
  });

  test("maps tool calls and terminal updates", () => {
    expect(
      mapAcpSessionEntry(
        {
          type: "tool_call",
          toolCallId: "tool-1",
          title: "Read file",
          kind: "read",
          rawInput: { path: "README.md" },
          status: "in_progress",
        },
        options,
      ),
    ).toEqual([
      {
        type: "messageDelta",
        messageId: "assistant:client-1",
        parts: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Read file",
            input: { path: "README.md" },
            state: "input-available",
          },
        ],
      },
    ]);

    expect(
      mapAcpSessionEntry(
        {
          type: "tool_call_update",
          toolCallId: "tool-1",
          title: "Read file",
          status: "completed",
          content: [
            {
              type: "content",
              content: { type: "text", text: "file contents" },
            },
          ],
        },
        options,
      ),
    ).toEqual([
      {
        type: "messageDelta",
        messageId: "assistant:client-1",
        parts: [
          {
            type: "tool-call",
            toolCallId: "tool-1",
            toolName: "Read file",
            input: {},
            state: "output-available",
          },
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "Read file",
            output: "file contents",
            isError: false,
          },
        ],
      },
    ]);
  });

  test("maps plans to thread todos", () => {
    expect(
      mapAcpSessionEntry(
        {
          type: "plan",
          entries: [
            {
              content: "Inspect the project",
              status: "completed",
              priority: "high",
            },
            {
              content: "Implement the change",
              status: "in_progress",
              priority: "high",
            },
          ],
        },
        options,
      ),
    ).toEqual([
      {
        type: "state",
        state: {
          currentTodos: [
            {
              content: "Inspect the project",
              activeForm: "Inspect the project",
              status: "completed",
            },
            {
              content: "Implement the change",
              activeForm: "Implement the change",
              status: "in_progress",
            },
          ],
        },
      },
    ]);
  });

  test("maps permission lifecycle events", () => {
    expect(
      mapAcpSessionEntries(
        [
          {
            type: "permission_request",
            requestId: "permission-1",
            toolCall: {
              toolCallId: "tool-1",
              title: "Run command",
              kind: "execute",
              rawInput: { command: "bun test" },
            },
          },
          {
            type: "permission_response",
            requestId: "permission-1",
            outcome: {
              outcome: "selected",
              optionId: "allow_always",
            },
          },
        ],
        options,
      ),
    ).toEqual([
      {
        type: "permissionRequest",
        requestId: "permission-1",
        toolCallId: "tool-1",
        toolName: "Run command",
        input: { command: "bun test" },
        description: "Run command",
      },
      {
        type: "permissionResolved",
        requestId: "permission-1",
        decision: "allow_always",
      },
    ]);
  });

  test("ignores unknown or malformed extension events", () => {
    expect(
      mapAcpSessionEntries(
        [
          { type: "future_extension", payload: true },
          { type: "agent_message_chunk", content: { type: "image" } },
          { notAType: true },
        ],
        options,
      ),
    ).toEqual([]);
  });
});
