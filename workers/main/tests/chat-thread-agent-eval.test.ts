import { describe, expect, it, vi } from "vitest";

import { ChatThreadDO } from "../src/chat-thread-do";

describe("ChatThreadDO agent eval sessions", () => {
  it("runs a prompt through the Pi session and returns transcript events", async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const parsedMessages = [
      {
        id: "msg1",
        thread_id: "thread1",
        role: "assistant",
        content: "done",
        created_at: Date.now(),
        forkEntryId: "fork1",
      },
    ];

    fake.chatContext = null;
    fake.chatEventBuffer = [];
    fake.recordedChatErrors = new Map();
    fake.nextChatEventId = 1;
    fake.chatIsStreaming = false;
    fake.piEventHandlerChain = Promise.resolve();
    // pushChatEvent relays chunks through the encoder and feeds the eval
    // collector; seed the bridge fields the fake doesn't get from the SDK ctor
    // (no bridged turn here, so the encoder relay is a no-op).
    fake.piChunkEncoder = null;
    fake.piStreamWriter = null;
    fake.piPreAttachChunkBuffer = null;
    fake.activePiStreamTurnId = null;
    fake.setState = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.ctx = {
      storage: {
        kv: {
          put: vi.fn(),
          delete: vi.fn(),
        },
      },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: {
        get: vi.fn(async () => null),
      },
      // agentEvalResult collects deployed apps for the result via OrgDO; with no
      // scripts the collector short-circuits to undefined.
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          listWorkerScriptsByWorkspace: vi.fn(async () => []),
          getSlug: vi.fn(async () => null),
        })),
      },
    };
    fake.broadcastChat = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => undefined);
    fake.setActiveTurnUserId = vi.fn();
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.publishRunningUserMessageActivity = vi.fn();
    fake.refreshPiSessionModel = vi.fn(async () => undefined);
    fake.withPiTurnInactivityTimeout = vi.fn(async (fn: () => Promise<unknown>) => fn());
    fake.getPiCoreParsedMessages = vi.fn(async () => parsedMessages);
    fake.piSession = {
      state: { isStreaming: false },
      prompt: vi.fn(async () => {
        ChatThreadDO.prototype["pushChatEvent"].call(fake, {
          type: "runtime_event",
          event: {
            method: "item/started",
            params: { item: { type: "commandExecution", command: "echo done" } },
          },
        });
        ChatThreadDO.prototype["pushChatEvent"].call(fake, {
          type: "result",
          threadId: "thread1",
          result: "done",
        });
      }),
    };

    const result = await ChatThreadDO.prototype.runAgentEvalSession.call(fake, {
      threadId: "thread1",
      workspaceId: "workspace1",
      orgId: "org1",
      userId: "user1",
      userName: "Eval User",
      userEmail: "eval@example.com",
      message: "run the task",
      timeoutMs: 5_000,
    });

    expect(result.status).toBe("completed");
    expect(result.result).toBe("done");
    expect(result.messages).toBe(parsedMessages);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.type)).toEqual([
      "runtime_event",
      "result",
    ]);
    expect(fake.piSession.prompt).toHaveBeenCalledTimes(1);
    expect(fake.withPiTurnInactivityTimeout).toHaveBeenCalledTimes(1);
    // Turn-start bookkeeping in the eval path: the user is attributed to the turn.
    // (markTurnStarted itself now fires from the agent_start event the real prompt
    // emits, which this mock prompt does not synthesize.)
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith("user1");
  });
});
