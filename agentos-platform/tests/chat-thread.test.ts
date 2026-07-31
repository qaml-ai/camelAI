import { expect, test } from "vitest";
import { setupTest } from "rivetkit/test";
import { EMPTY_THREAD_STATE } from "../src/shared/index.ts";
import { chatThread } from "../src/server/actors/chat-thread.ts";
import { registry } from "../src/server/registry.ts";

test("chatThread sends, deduplicates, reports busy, and records tools", async (c) => {
  const { client } = await setupTest(c, registry);
  const suffix = crypto.randomUUID();
  const threadId = `thread-${suffix}`;
  const createWithInput = {
    threadId,
    workspaceId: `workspace-${suffix}`,
    orgId: `org-${suffix}`,
    projectId: `project-${suffix}`,
  };
  const chat = client.chatThread.getOrCreate(threadId, {
    createWithInput,
  });

  await expect(chat.sendMessage("hello", "client-1")).resolves.toMatchObject({
    status: "completed",
  });
  await expect(chat.sendMessage("hello", "client-1")).resolves.toEqual({
    status: "duplicate",
    messageId: "client-1",
  });

  let messages = await chat.getMessages();
  expect(messages).toHaveLength(2);
  expect(messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
  ]);

  await expect(
    chat.sendMessage("please use a tool", "client-tool"),
  ).resolves.toMatchObject({ status: "completed" });
  messages = await chat.getMessages();
  const toolAssistant = messages.find(
    (message) => message.id === "assistant:client-tool",
  );
  expect(toolAssistant?.parts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "tool-call",
        toolName: "read",
        state: "output-available",
      }),
      expect.objectContaining({
        type: "tool-result",
        output: "Mock file contents",
      }),
    ]),
  );

  const sendMessageAction = chatThread.config.actions?.sendMessage;
  if (typeof sendMessageAction !== "function") {
    throw new Error("chatThread sendMessage action is unavailable");
  }
  const busyResult = await sendMessageAction(
    {
      state: {
        threadId: "busy-thread",
        workspaceId: "busy-workspace",
        orgId: "busy-org",
        projectId: "busy-project",
        title: "Busy test",
        model: "mock",
        messages: [],
        threadState: structuredClone(EMPTY_THREAD_STATE),
        clientMessageIds: [],
        turnStatus: "streaming",
      },
    } as unknown as Parameters<typeof sendMessageAction>[0],
    "second response",
    "client-busy",
  );
  expect(busyResult).toEqual({ status: "busy" });
});
