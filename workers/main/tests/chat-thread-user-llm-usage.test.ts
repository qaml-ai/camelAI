import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ChatThreadDO } from "../src/chat-thread-do";
import { summarizePiMessages } from "../src/chat-thread/pi-compaction";
import { runPiSubagentTool } from "../src/chat-thread/pi-tools";
import { UserLlmUsageLimitError } from "../src/user-llm-usage-policy";

const context = {
  orgId: "org1",
  workspaceId: "workspace1",
  threadId: "thread1",
  userId: "viewer-can-change",
};

const modelConfig = {
  model: { id: "claude-sonnet-5", provider: "anthropic" },
  apiKey: "key",
  headers: {},
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  billingSource: "byok",
  creditChargeable: false,
  usageProvider: "anthropic",
};

describe("ChatThreadDO user LLM usage gate", () => {
  it("gates and settles exactly once through an actual main Agent pull", async () => {
    const checkUserLlmUsageAccess = vi.fn(async () => ({
      allowed: true,
      reason: "within_limits" as const,
      evaluated_at_ms: 1,
      blocking_limit: null,
      limits: [],
    }));
    const recordUsage = vi.fn(async () => undefined);
    const waitUntilTasks: Promise<unknown>[] = [];
    const mainModelConfig = {
      ...modelConfig,
      model: {
        id: "claude-sonnet-5",
        provider: "anthropic",
        api: "anthropic-messages",
        contextWindow: 128_000,
        maxTokens: 4_096,
        input: ["text"],
      },
    };
    const streamPiModel = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "main result" }],
        provider: "anthropic",
        model: "claude-sonnet-5",
        responseId: "response-main-lifecycle",
        stopReason: "stop",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
        timestamp: Date.now(),
      } as any;
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", delta: "main result", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    });
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = context;
    fake.env = {
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ checkUserLlmUsageAccess, recordUsage })),
      },
    };
    fake.ctx = { waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task) };
    fake.piEventHandlerChain = Promise.resolve();
    fake.llmUsageSettlementChain = Promise.resolve();
    fake.pendingLlmUsageSettlements = [];
    fake.noLlmLimitsCachedUserId = null;
    fake.resolvePiModel = vi.fn(async () => mainModelConfig);
    fake.withChatMemoryPhase = vi.fn(async (_phase: string, task: () => unknown) => task());
    fake.loadFullPiCoreTranscriptUnbounded = vi.fn(async () => []);
    fake.loadBoundedPiCoreSessionWindow = vi.fn(async () => ({
      messages: [],
      window: {
        firstRowIdx: 0,
        summaryOffset: 0,
        capped: false,
        totalChars: 0,
        loadedChars: 0,
        totalRows: 0,
        loadedRows: 0,
      },
    }));
    fake.readPiActiveTurn = vi.fn(() => null);
    fake.createPiSystemPrompt = vi.fn(() => "system");
    fake.createPiToolDefinitions = vi.fn(() => []);
    fake.transformPiProviderContext = vi.fn(async (messages: unknown[]) => messages);
    fake.refreshPiSessionCapabilitySurface = vi.fn();
    fake.streamPiModel = streamPiModel;
    fake.getActiveTurnUserId = vi.fn(() => "initiating-user");
    fake.touchPiTurnProgress = vi.fn();
    fake.attachCodeModeArtifactsToToolResult = vi.fn(async (message: unknown) => message);
    fake.annotatePiProviderErrorMessages = vi.fn((messages: unknown[]) => messages);
    fake.appendPiCoreMessagesIfMissing = vi.fn(async () => undefined);
    fake.clearPiTurnJournal = vi.fn();
    fake.pushPiRuntimeEvent = vi.fn();
    fake.piRuntimeThreadId = vi.fn(() => "thread1");
    fake.retryChatDurableObjectRpc = vi.fn(
      async (_operation: string, task: () => Promise<unknown>) => task(),
    );
    fake.piCurrentBillingSource = "byok";
    fake.piCurrentCreditChargeable = false;
    fake.piCurrentUsageProvider = "anthropic";
    fake.piCurrentUsageModel = "subagent-model-must-not-leak";
    fake.piUserStopRequestedAtMs = 0;
    fake.piTurnStartedAtMs = Date.now();
    fake.piSdkTurnIndex = 0;
    fake.piSdkTurnUsageTotal = null;
    fake.handlePiSessionEvent = async (event: { type: string }) => {
      if (event.type !== "turn_end") return;
      await ChatThreadDO.prototype["handlePiSessionEvent"].call(fake, event);
    };

    const session = await ChatThreadDO.prototype["createPiSession"].call(
      fake,
      context,
      {},
    );
    fake.piSession = session;
    await session.prompt("answer once");
    await fake.piEventHandlerChain;
    await fake.llmUsageSettlementChain;
    await Promise.all(waitUntilTasks);

    expect(checkUserLlmUsageAccess).toHaveBeenCalledOnce();
    expect(streamPiModel).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "initiating-user",
      usage_surface: "agent",
      input_tokens: 10,
      output_tokens: 2,
      source: "pi_assistant",
    }));
  });

  it("gates and settles exactly once through an actual child Agent pull", async () => {
    const gate = vi.fn(async () => undefined);
    const recordUsage = vi.fn(async () => undefined);
    const waitUntilTasks: Promise<unknown>[] = [];
    const modelConfig = {
      model: {
        id: "claude-sonnet-5",
        provider: "anthropic",
        api: "anthropic-messages",
        contextWindow: 128_000,
        maxTokens: 4_096,
        input: ["text"],
      },
      apiKey: "key",
      headers: {},
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      billingSource: "byok",
      creditChargeable: false,
      usageProvider: "anthropic",
    };
    const streamPiModel = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "child result" }],
        provider: "anthropic",
        model: "claude-sonnet-5",
        stopReason: "stop",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
        timestamp: Date.now(),
      } as any;
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", delta: "child result", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    });
    const deps = {
      piModelResolver: () => async () => modelConfig,
      activeTurnUserId: () => "initiating-user",
      assertUserLlmUsageAccess: gate,
      createPiSubagentSystemPrompt: vi.fn(async () => "system"),
      createPiToolDefinitions: vi.fn(() => []),
      beforePiToolCall: vi.fn(),
      afterPiToolCall: vi.fn(),
      streamPiModel,
      recordPiAssistantUsage: recordUsage,
      waitUntil: (task: Promise<unknown>) => waitUntilTasks.push(task),
    } as any;

    await expect(runPiSubagentTool(
      deps,
      context as any,
      "Agent",
      { prompt: "do one thing" },
    )).resolves.toMatchObject({ content: expect.any(Array) });
    await Promise.all(waitUntilTasks);
    expect(gate).toHaveBeenCalledOnce();
    expect(streamPiModel).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
      expect.any(Number),
      "byok",
      false,
      "anthropic",
      expect.objectContaining({
        userId: "initiating-user",
        model: "claude-sonnet-5",
        usageSurface: "subagent",
      }),
    );
  });

  it("waits for settlement and rechecks no-limits before every later pull", async () => {
    let release!: () => void;
    const settlement = new Promise<void>((resolve) => { release = resolve; });
    const checkUserLlmUsageAccess = vi.fn()
      .mockResolvedValueOnce({
        allowed: true,
        reason: "no_limits" as const,
        evaluated_at_ms: 1,
        blocking_limit: null,
        limits: [],
      })
      .mockResolvedValueOnce({
        allowed: false,
        reason: "limit_exceeded" as const,
        evaluated_at_ms: 2,
        blocking_limit: {
          window_hours: 24,
          limit_usd: 1,
          label: "new policy",
          spent_usd: 1,
          remaining_usd: 0,
          unpriced_requests: 0,
          exceeded: true,
          retry_at_ms: 3,
        },
        limits: [],
      });
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.llmUsageSettlementChain = settlement;
    fake.noLlmLimitsCachedUserId = null;
    fake.env = {
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ checkUserLlmUsageAccess })),
      },
    };

    const pending = ChatThreadDO.prototype["assertPiUserLlmUsageAccess"].call(
      fake,
      context,
      modelConfig,
      "initiating-user",
    );
    await Promise.resolve();
    expect(checkUserLlmUsageAccess).not.toHaveBeenCalled();
    release();
    await pending;
    await expect(ChatThreadDO.prototype["assertPiUserLlmUsageAccess"].call(
      fake, context, modelConfig, "initiating-user",
    )).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(checkUserLlmUsageAccess).toHaveBeenCalledTimes(2);
  });

  it.each([
    { stopReason: "error", stoppedAt: 0 },
    { stopReason: "aborted", stoppedAt: 1 },
  ])("meters a billed $stopReason main pull before transcript early-return", async ({
    stopReason,
    stoppedAt,
  }) => {
    const recordPiAssistantUsage = vi.fn(async () => undefined);
    const background: Promise<unknown>[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: (promise: Promise<unknown>) => background.push(promise) };
    fake.piTurnStartedAtMs = Date.now() - 10;
    fake.piCurrentBillingSource = "byok";
    fake.piCurrentCreditChargeable = false;
    fake.piCurrentUsageProvider = "anthropic";
    fake.piCurrentUsageModel = "claude-sonnet-5";
    fake.piUserStopRequestedAtMs = stoppedAt;
    fake.getActiveTurnUserId = vi.fn(() => "initiating-user");
    fake.piRuntimeThreadId = vi.fn(() => "thread1");
    fake.recordPiAssistantUsage = recordPiAssistantUsage;
    fake.discardUnpersistedPiSessionMessages = vi.fn();
    const message = {
      role: "assistant",
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-5",
      responseId: `response-${stopReason}`,
      stopReason,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
      timestamp: Date.now(),
    } as any;

    await ChatThreadDO.prototype["handlePiSessionEvent"].call(fake, {
      type: "turn_end",
      message,
    });
    await Promise.all(background);

    expect(recordPiAssistantUsage).toHaveBeenCalledOnce();
    expect(recordPiAssistantUsage).toHaveBeenCalledWith(
      message,
      expect.any(Number),
      "byok",
      false,
      "anthropic",
      expect.objectContaining({
        userId: "initiating-user",
        model: "claude-sonnet-5",
        usageSurface: "agent",
      }),
    );
  });

  it("does not cache within-limit policies across pulls", async () => {
    const checkUserLlmUsageAccess = vi.fn(async () => ({
      allowed: true,
      reason: "within_limits" as const,
      evaluated_at_ms: 1,
      blocking_limit: null,
      limits: [],
    }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.llmUsageSettlementChain = Promise.resolve();
    fake.noLlmLimitsCachedUserId = null;
    fake.env = {
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ checkUserLlmUsageAccess })),
      },
    };
    await ChatThreadDO.prototype["assertPiUserLlmUsageAccess"].call(fake, context, modelConfig, "user1");
    await ChatThreadDO.prototype["assertPiUserLlmUsageAccess"].call(fake, context, modelConfig, "user1");
    expect(checkUserLlmUsageAccess).toHaveBeenCalledTimes(2);
  });

  it("surfaces limit denial without entering hosted/free-model fallback", async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.llmUsageSettlementChain = Promise.resolve();
    fake.pendingLlmUsageSettlements = [];
    fake.noLlmLimitsCachedUserId = null;
    fake.fallbackThreadToFreeModel = vi.fn();
    fake.env = {
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({
          checkUserLlmUsageAccess: vi.fn(async () => ({
            allowed: false,
            reason: "limit_exceeded" as const,
            evaluated_at_ms: 1,
            blocking_limit: {
              window_hours: 24, limit_usd: 1, label: "daily", spent_usd: 1,
              remaining_usd: 0, unpriced_requests: 0, exceeded: true, retry_at_ms: 2,
            },
            limits: [],
          })),
        })),
      },
    };

    await expect(ChatThreadDO.prototype["assertPiUserLlmUsageAccess"].call(
      fake, context, modelConfig, "initiating-user",
    )).rejects.toMatchObject({ code: "limit_exceeded" });
    expect(fake.fallbackThreadToFreeModel).not.toHaveBeenCalled();
  });

  it("retries a failed settlement before policy evaluation and then resumes the queue", async () => {
    const checkUserLlmUsageAccess = vi.fn(async () => ({
      allowed: true,
      reason: "within_limits" as const,
      evaluated_at_ms: 1,
      blocking_limit: null,
      limits: [],
    }));
    const settle = vi.fn()
      .mockRejectedValueOnce(new Error("OrgDO temporarily unavailable"))
      .mockResolvedValue(undefined);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = context;
    fake.llmUsageSettlementChain = Promise.resolve();
    fake.pendingLlmUsageSettlements = [];
    fake.noLlmLimitsCachedUserId = null;
    fake.recordPiAssistantUsageSettled = settle;
    fake.env = {
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ checkUserLlmUsageAccess })),
      },
    };
    const firstMessage = { role: "assistant", content: [], usage: { input: 1 } } as any;
    const attribution = {
      userId: "initiating-user",
      usageSurface: "agent" as const,
      sourceScope: "thread1",
    };

    await expect(ChatThreadDO.prototype["recordPiAssistantUsage"].call(
      fake, firstMessage, 10, "byok", false, "anthropic", attribution,
    )).rejects.toThrow("temporarily unavailable");
    expect(fake.pendingLlmUsageSettlements).toHaveLength(1);

    await ChatThreadDO.prototype["assertPiUserLlmUsageAccess"].call(
      fake, context, modelConfig, "initiating-user",
    );
    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls[1]).toEqual(settle.mock.calls[0]);
    expect(checkUserLlmUsageAccess).toHaveBeenCalledOnce();
    expect(fake.pendingLlmUsageSettlements).toHaveLength(0);

    const secondMessage = { role: "assistant", content: [], usage: { input: 2 } } as any;
    await ChatThreadDO.prototype["recordPiAssistantUsage"].call(
      fake, secondMessage, 10, "byok", false, "anthropic", attribution,
    );
    expect(settle).toHaveBeenCalledTimes(3);
    expect(settle.mock.calls[2][0]).toBe(secondMessage);
    expect(fake.pendingLlmUsageSettlements).toHaveLength(0);
  });

  it("records the initiating user and context even if mutable chat context changes before settlement", async () => {
    let release!: () => void;
    const recordUsage = vi.fn(async () => undefined);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = context;
    fake.llmUsageSettlementChain = new Promise<void>((resolve) => { release = resolve; });
    fake.pendingLlmUsageSettlements = [];
    fake.env = {
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => ({ recordUsage })),
      },
    };
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-5",
      responseModel: "provider-canonical-model-v2",
      responseId: "response-immutable-user",
      content: [],
      usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7 },
    } as any;
    const pending = ChatThreadDO.prototype["recordPiAssistantUsage"].call(
      fake,
      message,
      10,
      "byok",
      false,
      "anthropic",
      {
        userId: "initiating-user",
        model: "custom/request-alias",
        usageSurface: "agent",
        sourceScope: "thread1",
      },
    );
    fake.chatContext = {
      orgId: "other-org",
      workspaceId: "other-workspace",
      threadId: "other-thread",
      userId: "later-viewer",
    };
    release();
    await pending;

    expect(fake.env.ORG.idFromName).toHaveBeenCalledWith("org1");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "workspace1",
      thread_id: "thread1",
      user_id: "initiating-user",
      model: "custom/request-alias",
    }));
  });

  it("gates and meters each compaction pull with one stable pull id", async () => {
    const response = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
      timestamp: 2,
    };
    const completeSimple = vi.fn(async () => response);
    const beforePull = vi.fn(async () => undefined);
    const afterPull = vi.fn(async () => undefined);
    const model = {
      id: "claude-sonnet-5",
      api: "anthropic-messages",
      provider: "anthropic",
      contextWindow: 128_000,
      maxTokens: 4096,
    };

    await expect(summarizePiMessages(
      [{ role: "user", content: "old context", timestamp: 1 }] as any,
      model as any,
      "key",
      completeSimple as any,
      undefined,
      undefined,
      { beforePull, afterPull },
    )).resolves.toBe("summary");
    expect(beforePull).toHaveBeenCalledOnce();
    expect(completeSimple).toHaveBeenCalledOnce();
    expect(afterPull).toHaveBeenCalledWith(response, beforePull.mock.calls[0][0], expect.any(Number));
  });

  it("stops compaction before the provider when its access check is denied", async () => {
    const completeSimple = vi.fn();
    const denial = new UserLlmUsageLimitError("limit_exceeded");
    await expect(summarizePiMessages(
      [{ role: "user", content: "old context", timestamp: 1 }] as any,
      {
        id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic",
        contextWindow: 128_000, maxTokens: 4096,
      } as any,
      "key",
      completeSimple as any,
      undefined,
      undefined,
      {
        beforePull: vi.fn(async () => { throw denial; }),
        afterPull: vi.fn(),
      },
    )).rejects.toBe(denial);
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
