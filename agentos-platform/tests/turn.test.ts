import { describe, expect, test } from "vitest";
import type {
  ChatEvent,
  ThreadState,
  TurnStatus,
  UiMessage,
} from "../src/shared/index.ts";
import { EMPTY_THREAD_STATE } from "../src/shared/index.ts";
import { MockAgentRuntime } from "../src/server/chat/runtime.ts";
import { runChatTurn } from "../src/server/chat/turn.ts";

describe("runChatTurn", () => {
  test("streams a deterministic user and assistant exchange", async () => {
    const messages: UiMessage[] = [];
    const events: ChatEvent[] = [];
    let status: TurnStatus = "idle";
    let threadState: ThreadState = structuredClone(EMPTY_THREAD_STATE);

    const result = await runChatTurn({
      messages,
      broadcast: (event) => {
        events.push(event);
      },
      updateState: (patch) => {
        threadState = { ...threadState, ...patch };
      },
      updateTurnStatus: (next) => {
        status = next;
      },
      turnStatus: () => status,
      runtime: new MockAgentRuntime(),
      content: "hello",
      clientMessageId: "client-1",
    });

    expect(result.status).toBe("completed");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: "client-1",
      role: "user",
    });
    expect(messages[1]).toMatchObject({
      id: "assistant:client-1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Mock reply: hello",
          state: "done",
        },
      ],
    });
    expect(status).toBe("idle");
    expect(threadState.lastError).toBeNull();
    expect(events.some((event) => event.type === "messageDelta")).toBe(true);
    expect(
      events.some(
        (event) => event.type === "turnStatus" && event.status === "streaming",
      ),
    ).toBe(true);
  });

  test("records tool calls, tool results, and pending questions", async () => {
    const messages: UiMessage[] = [];
    let status: TurnStatus = "idle";
    let threadState: ThreadState = structuredClone(EMPTY_THREAD_STATE);

    await runChatTurn({
      messages,
      broadcast: () => {},
      updateState: (patch) => {
        threadState = { ...threadState, ...patch };
      },
      updateTurnStatus: (next) => {
        status = next;
      },
      turnStatus: () => status,
      runtime: new MockAgentRuntime(),
      content: "use a tool then ask: Which option?",
      clientMessageId: "client-tool",
    });

    const assistant = messages[1];
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "mock-tool-1",
          toolName: "read",
          state: "output-available",
        }),
        expect.objectContaining({
          type: "tool-result",
          toolCallId: "mock-tool-1",
          output: "Mock file contents",
        }),
      ]),
    );
    expect(threadState.pendingQuestion).toMatchObject({
      questionId: "mock-question-1",
      questions: [{ question: "Which option?" }],
    });
  });

  test("rejects duplicate and busy sends before mutating messages", async () => {
    const messages: UiMessage[] = [
      {
        id: "existing",
        role: "user",
        parts: [{ type: "text", text: "already sent" }],
        createdAt: 1,
      },
    ];
    const base = {
      messages,
      broadcast: () => {},
      updateState: () => {},
      runtime: new MockAgentRuntime(),
      content: "hello",
    };

    await expect(
      runChatTurn({ ...base, clientMessageId: "existing" }),
    ).resolves.toEqual({ status: "duplicate", messageId: "existing" });
    await expect(
      runChatTurn({
        ...base,
        clientMessageId: "new",
        turnStatus: "streaming",
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(messages).toHaveLength(1);
  });
});
