import { expect, test, type TestContext } from "vitest";
import { setupTest } from "rivetkit/test";
import { registry } from "../src/server/registry.ts";

async function setupChat(c: TestContext) {
  const { client } = await setupTest(c, registry);
  const suffix = crypto.randomUUID();
  const threadId = `thread-${suffix}`;
  const workspaceId = `workspace-${suffix}`;
  const orgId = `org-${suffix}`;
  const chat = client.chatThread.getOrCreate(threadId, {
    createWithInput: {
      threadId,
      workspaceId,
      orgId,
      projectId: `project-${suffix}`,
    },
  });
  return { client, chat, threadId, workspaceId, orgId };
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for actor state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("chatThread persists a happy-path user and assistant exchange", async (c) => {
  const { chat } = await setupChat(c);

  await expect(chat.sendMessage("hello", "client-1")).resolves.toEqual({
    status: "completed",
    messageId: "assistant:client-1",
  });

  await expect(chat.getMessages()).resolves.toMatchObject([
    {
      id: "client-1",
      role: "user",
      parts: [{ type: "text", text: "hello", state: "done" }],
    },
    {
      id: "assistant:client-1",
      role: "assistant",
      parts: [{ type: "text", text: "Mock reply: hello", state: "done" }],
    },
  ]);
});

test("chatThread deduplicates client message ids", async (c) => {
  const { chat } = await setupChat(c);
  await chat.sendMessage("hello", "client-1");

  await expect(chat.sendMessage("different", "client-1")).resolves.toEqual({
    status: "duplicate",
    messageId: "client-1",
  });
  await expect(chat.getMessages()).resolves.toHaveLength(2);
});

test("chatThread rejects a concurrent send while streaming", async (c) => {
  const previousDelay = process.env.MOCK_AGENT_DELAY_MS;
  process.env.MOCK_AGENT_DELAY_MS = "200";
  try {
    const { chat } = await setupChat(c);
    const firstSend = chat.sendMessage("first", "client-first");
    await waitUntil(async () => {
      const state = await chat.getThreadState();
      return state.turnStatus === "streaming";
    });

    await expect(
      chat.sendMessage("second", "client-second"),
    ).resolves.toEqual({ status: "busy" });
    await expect(firstSend).resolves.toMatchObject({ status: "completed" });
    await expect(chat.getMessages()).resolves.toHaveLength(2);
  } finally {
    if (previousDelay === undefined) {
      delete process.env.MOCK_AGENT_DELAY_MS;
    } else {
      process.env.MOCK_AGENT_DELAY_MS = previousDelay;
    }
  }
});

test("chatThread records tool parts from the mock runtime", async (c) => {
  const { chat } = await setupChat(c);

  await expect(
    chat.sendMessage("please use a tool", "client-tool"),
  ).resolves.toMatchObject({ status: "completed" });
  const messages = await chat.getMessages();
  const assistant = messages.find(
    (message) => message.id === "assistant:client-tool",
  );
  expect(assistant?.parts).toEqual(
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
});

test("chatThread exposes pending questions in thread state", async (c) => {
  const { chat } = await setupChat(c);

  await chat.sendMessage("ask: Which option?", "client-ask");
  const state = await chat.getThreadState();
  expect(state.threadState.pendingQuestion).toMatchObject({
    questionId: "mock-question-1",
    questions: [{ question: "Which option?" }],
  });
});

test("chatThread stops an in-flight send", async (c) => {
  const previousDelay = process.env.MOCK_AGENT_DELAY_MS;
  process.env.MOCK_AGENT_DELAY_MS = "500";
  try {
    const { chat } = await setupChat(c);
    const send = chat.sendMessage("stop this", "client-stop");
    await waitUntil(async () => {
      const state = await chat.getThreadState();
      return state.turnStatus === "streaming";
    });

    await expect(chat.requestStop()).resolves.toEqual({ status: "stopped" });
    await expect(send).resolves.toEqual({
      status: "stopped",
      messageId: "assistant:client-stop",
    });
    await expect(chat.getThreadState()).resolves.toMatchObject({
      turnStatus: "idle",
    });
  } finally {
    if (previousDelay === undefined) {
      delete process.env.MOCK_AGENT_DELAY_MS;
    } else {
      process.env.MOCK_AGENT_DELAY_MS = previousDelay;
    }
  }
});

test("chatThread updates its title and model", async (c) => {
  const { chat } = await setupChat(c);

  await expect(chat.setTitle("Renamed thread")).resolves.toBe("Renamed thread");
  await expect(chat.setModel("anthropic/test")).resolves.toBe("anthropic/test");
  await expect(chat.getThreadState()).resolves.toMatchObject({
    title: "Renamed thread",
    model: "anthropic/test",
    threadState: {
      title: "Renamed thread",
      model: "anthropic/test",
    },
  });
});

test("org actor grants and reports credits", async (c) => {
  const { client } = await setupTest(c, registry);
  const orgId = `org-${crypto.randomUUID()}`;
  const org = client.org.getOrCreate(orgId, {
    createWithInput: {
      orgId,
      creditCents: 100,
    },
  });

  await expect(org.getCredits()).resolves.toBe(100);
  await expect(org.grantCredits(250)).resolves.toBe(350);
  await expect(org.getCredits()).resolves.toBe(350);
});

test("workspace actor registers and lists unique threads", async (c) => {
  const { client } = await setupTest(c, registry);
  const suffix = crypto.randomUUID();
  const workspaceId = `workspace-${suffix}`;
  const workspace = client.workspace.getOrCreate(workspaceId, {
    createWithInput: {
      workspaceId,
      orgId: `org-${suffix}`,
    },
  });

  await expect(workspace.listThreads()).resolves.toEqual([]);
  await expect(workspace.registerThread("thread-1")).resolves.toEqual([
    "thread-1",
  ]);
  await workspace.registerThread("thread-2");
  await workspace.registerThread("thread-1");
  await expect(workspace.listThreads()).resolves.toEqual([
    "thread-1",
    "thread-2",
  ]);
});

test("chatThread handles allowlisted slash commands without the runtime", async (c) => {
  const { chat } = await setupChat(c);

  await expect(chat.sendMessage("/compact", "client-compact")).resolves.toEqual({
    status: "completed",
    messageId: "assistant:client-compact",
  });
  const messages = await chat.getMessages();
  expect(messages[1]).toMatchObject({
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "Context compacted (stub).",
        state: "done",
      },
    ],
  });
});

test("chatThread rejects unknown slash commands with an assistant error", async (c) => {
  const { chat } = await setupChat(c);
  const error = "Unknown slash command: /not-allowed";

  await expect(
    chat.sendMessage("/not-allowed", "client-unknown"),
  ).resolves.toEqual({
    status: "error",
    messageId: "assistant:client-unknown",
    error,
  });
  const messages = await chat.getMessages();
  expect(messages[1]).toMatchObject({
    role: "assistant",
    parts: [{ type: "data-error", data: { error } }],
  });
  await expect(chat.getThreadState()).resolves.toMatchObject({
    turnStatus: "error",
    threadState: { lastError: { error } },
  });
});
