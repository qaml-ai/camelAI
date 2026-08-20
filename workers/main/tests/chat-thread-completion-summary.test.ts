import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatThreadDO } from "../src/chat-thread-do";

describe("ChatThreadDO completion summaries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createFakeThread(options?: {
    aiResponse?: unknown;
    aiError?: Error;
  }) {
    const waitUntilPromises: Promise<unknown>[] = [];
    const recordThreadAssistantCompletion = vi.fn(
      async (_threadId: string, input: { completedAt: number }) => input.completedAt,
    );
    const recordThreadStreaming = vi.fn(async () => undefined);
    const aiRun = vi.fn();
    if (options?.aiError) {
      aiRun.mockRejectedValue(options.aiError);
    } else {
      aiRun.mockResolvedValue(
        options?.aiResponse ?? {
          choices: [{ message: { content: "Generated hover summary." } }],
        },
      );
    }
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = {
      orgId: "org1",
      workspaceId: "workspace1",
      threadId: "thread1",
      userId: "user1",
    };
    fake.chatIsStreaming = true;
    fake.assistantCompletionRecordedAt = null;
    fake.assistantCompletionSummaryRequestedAt = null;
    fake.currentTodos = [];
    fake.browserPrompts = { pendingQuestionCount: 0 };
    fake.trace = vi.fn();
    fake.broadcastChat = vi.fn();
    fake.broadcast = vi.fn();
    fake.broadcastRealtime = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.setState = vi.fn();
    fake.ctx = {
      storage: { kv: { delete: vi.fn() } },
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
      getWebSockets: vi.fn(() => [] as WebSocket[]),
    };
    fake.env = {
      CF_GATEWAY_NAME: "gw_1",
      AI: { run: aiRun },
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          recordThreadAssistantCompletion,
        })),
      },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          recordThreadStreaming,
        })),
      },
    };

    return {
      fake,
      aiRun,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    };
  }

  it("stores generated completion summaries instead of raw final text", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    const rawFinalText =
      "Final answer: I changed several files, ran commands, and here are verbose details.";

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      summarySource: rawFinalText,
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledTimes(3);
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "pending",
      clearOnlyIfRunning: true,
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "pending",
      clearRunningStartedAtOrBefore: expect.any(Number),
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(3, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "ready",
      summary: "Generated hover summary.",
      clearRunningStartedAtOrBefore: null,
    });
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      1,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "pending",
      },
    );
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      2,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: "Generated hover summary.",
        summaryStatus: "ready",
      },
    );
    expect(recordThreadAssistantCompletion).not.toHaveBeenCalledWith(
      "thread1",
      expect.objectContaining({ summary: rawFinalText }),
    );
  });

  it("marks summary generation failures as failed after completion is persisted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread({ aiError: new Error("Unauthorized") });

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      summarySource: "Raw final answer that should not be stored on failure.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledTimes(3);
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "pending",
      clearOnlyIfRunning: true,
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "pending",
      clearRunningStartedAtOrBefore: expect.any(Number),
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(3, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
      clearRunningStartedAtOrBefore: null,
    });
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      1,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "pending",
      },
    );
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      2,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "failed",
      },
    );
  });

  it("uses the stored completion timestamp for generated summaries", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread({
      aiResponse: { choices: [{ message: { content: "Stored timestamp summary." } }] },
    });
    const storedCompletedAt = 123456;
    recordThreadAssistantCompletion.mockImplementation(
      async (
        _threadId: string,
        input: { completedAt: number; summaryStatus?: string | null },
      ) =>
        input.summaryStatus === "pending" ? storedCompletedAt : input.completedAt,
    );

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Raw final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(2, "thread1", {
      completedAt: storedCompletedAt,
      summary: "Stored timestamp summary.",
      summaryStatus: "ready",
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: 100,
      summaryStatus: "pending",
      clearOnlyIfRunning: true,
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: storedCompletedAt,
      summaryStatus: "pending",
      clearRunningStartedAtOrBefore: 100,
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(3, "thread1", false, {
      completedAt: storedCompletedAt,
      summaryStatus: "ready",
      summary: "Stored timestamp summary.",
      clearRunningStartedAtOrBefore: null,
    });
  });

  it("clears workspace running state before OrgDO rejects a stale completion", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    recordThreadAssistantCompletion.mockResolvedValue(false);

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Stale final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: 100,
      summary: null,
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).toHaveBeenCalledWith("thread1", false, {
      completedAt: 100,
      summaryStatus: "pending",
      clearOnlyIfRunning: true,
    });
  });

  it("does not let a pending OrgDO completion delay the workspace terminal transition", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    let resolveCompletion!: (value: number) => void;
    recordThreadAssistantCompletion.mockImplementation(
      () => new Promise<number>((resolve) => {
        resolveCompletion = resolve;
      }),
    );

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 100,
      summarySource: null,
    });

    // Let recordThreadAssistantCompletion enter its first await. WorkspaceDO has
    // already received the authoritative terminal transition even though OrgDO
    // has not answered yet (and could reset the owning isolate at this point).
    await vi.waitFor(() => {
      expect(recordThreadAssistantCompletion).toHaveBeenCalledTimes(1);
    });
    expect(recordThreadStreaming).toHaveBeenCalledWith("thread1", false, {
      completedAt: 100,
      summaryStatus: "failed",
      clearOnlyIfRunning: true,
    });
    expect(recordThreadStreaming.mock.invocationCallOrder[0]).toBeLessThan(
      recordThreadAssistantCompletion.mock.invocationCallOrder[0],
    );

    resolveCompletion(100);
    await Promise.all(waitUntilPromises);
  });

  it("clears workspace running state when completion persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();
    recordThreadAssistantCompletion.mockRejectedValue(new Error("transient"));

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Completed final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: 100,
      summary: null,
      summaryStatus: "pending",
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(1, "thread1", false, {
      completedAt: 100,
      summaryStatus: "pending",
      clearOnlyIfRunning: true,
    });
    expect(recordThreadStreaming).toHaveBeenNthCalledWith(2, "thread1", false, {
      completedAt: 100,
      summaryStatus: "failed",
      clearRunningStartedAtOrBefore: 100,
    });
  });

  it("marks empty generated summaries as failed", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread({ aiResponse: { choices: [{ message: { content: "   " } }] } });

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      summarySource: "Raw final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenNthCalledWith(3, "thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
      clearRunningStartedAtOrBefore: null,
    });
    expect(recordThreadAssistantCompletion).toHaveBeenNthCalledWith(
      2,
      "thread1",
      {
        completedAt: expect.any(Number),
        summary: null,
        summaryStatus: "failed",
      },
    );
  });

  it("marks completion summary as failed when no source text is available", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      summarySource: null,
    });

    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledWith("thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
      clearRunningStartedAtOrBefore: expect.any(Number),
    });
    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: expect.any(Number),
      summary: null,
      summaryStatus: "failed",
    });
  });

  it("marks browser runner turn completion as unread with failed summary status", async () => {
    const {
      fake,
      waitUntilPromises,
      recordThreadAssistantCompletion,
      recordThreadStreaming,
    } = createFakeThread();

    await ChatThreadDO.prototype.setBrowserTurnStreaming.call(fake, false);
    await Promise.all(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledWith("thread1", false, {
      completedAt: expect.any(Number),
      summaryStatus: "failed",
      clearRunningStartedAtOrBefore: expect.any(Number),
    });
    expect(recordThreadAssistantCompletion).toHaveBeenCalledWith("thread1", {
      completedAt: expect.any(Number),
      summary: null,
      summaryStatus: "failed",
    });
  });

  it("does not mark an active automation run successful while a browser question is pending", async () => {
    const { fake, waitUntilPromises } = createFakeThread();
    const activeAutomationRun = {
      workspaceId: "workspace1",
      automationId: "prompt1",
      runId: "run1",
    };
    fake.activeAutomationRun = activeAutomationRun;
    fake.browserPrompts = { pendingQuestionCount: 1 };
    fake.updateActiveAutomationRun = vi.fn();

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 123,
      summarySource: null,
    });
    await Promise.all(waitUntilPromises);

    expect(fake.updateActiveAutomationRun).not.toHaveBeenCalled();
    expect(fake.activeAutomationRun).toBe(activeAutomationRun);
  });

  it("records success only when an explicit automation outcome reports success", async () => {
    const { fake, waitUntilPromises } = createFakeThread();
    fake.activeAutomationRun = {
      workspaceId: "workspace1",
      automationId: "prompt1",
      runId: "run1",
      requiresExplicitOutcome: true,
      reportedOutcome: {
        status: "success",
        summary: "Both exports were read back and verified.",
      },
    };
    fake.updateActiveAutomationRun = vi.fn();

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 123,
      summarySource: null,
    });
    await Promise.all(waitUntilPromises);

    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith({
      status: "success",
      message: "Both exports were read back and verified.",
      completedAt: 123,
      clear: true,
    });
  });

  it("records a scheduled run as failed when an explicit outcome is missing or non-success", async () => {
    const { fake, waitUntilPromises } = createFakeThread();
    fake.updateActiveAutomationRun = vi.fn();
    fake.activeAutomationRun = {
      workspaceId: "workspace1",
      automationId: "prompt1",
      runId: "run1",
      requiresExplicitOutcome: true,
    };

    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 123,
      summarySource: null,
    });
    await Promise.all(waitUntilPromises);
    expect(fake.updateActiveAutomationRun).toHaveBeenLastCalledWith({
      status: "error",
      message: "Automation completed without explicitly reporting an outcome",
      completedAt: 123,
      clear: true,
    });

    fake.assistantCompletionRecordedAt = null;
    fake.activeAutomationRun = {
      workspaceId: "workspace1",
      automationId: "prompt1",
      runId: "run2",
      requiresExplicitOutcome: true,
      reportedOutcome: {
        status: "partial",
        summary: "The database export worked, but readback failed.",
      },
    };
    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 456,
      summarySource: null,
    });
    await Promise.all(waitUntilPromises);
    expect(fake.updateActiveAutomationRun).toHaveBeenLastCalledWith({
      status: "error",
      message: "[partial] The database export worked, but readback failed.",
      completedAt: 456,
      clear: true,
    });
  });

  it("reuses one WorkspaceDO stub for ordered status writes", async () => {
    const { fake, waitUntilPromises } = createFakeThread();

    ChatThreadDO.prototype["publishRunningActivity"].call(fake, "Thinking", {
      immediate: true,
    });
    ChatThreadDO.prototype["finishTurn"].call(fake, {
      markUnread: true,
      completedAt: 100,
      summarySource: "Raw final answer.",
    });

    await Promise.all(waitUntilPromises);

    expect(fake.env.WORKSPACE.get).toHaveBeenCalledTimes(1);
  });
});
