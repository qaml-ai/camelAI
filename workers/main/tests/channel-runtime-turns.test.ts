/**
 * Channel threads on the direct runtime path (agent-runtime/channel-turns.ts).
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { startRuntimeTurnMock, directEnabledMock, migrateOnSendMock } = vi.hoisted(() => ({
  startRuntimeTurnMock: vi.fn(),
  migrateOnSendMock: vi.fn(async () => null),
  directEnabledMock: vi.fn(() => true),
}));

vi.mock("../src/agent-runtime/thread-runtime.js", () => ({
  startRuntimeTurn: startRuntimeTurnMock,
  runtimeDirectThreadsEnabled: directEnabledMock,
}));

vi.mock("../src/agent-runtime/thread-migration.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migrateThreadOnSend: migrateOnSendMock,
}));

import {
  channelRequestId,
  formatChannelHistoryNote,
  queueChannelHistoryNote,
  startChannelRuntimeTurn,
  type ChannelTurnRequest,
} from "../src/agent-runtime/channel-turns";
import type { ChatEnv } from "../src/chat-thread/types";

const ROW = { threadId: "t1", agentId: "agt_1", model: "m", keyScope: "hosted", configured: null, createdAt: 1, updatedAt: 1 };

function fakeEnv(options: { row?: typeof ROW | null; relay?: { agentId: string; model: string | null; keyScope: string | null } | null } = {}) {
  const kv = new Map<string, string>();
  const setThreadRuntimeAgent = vi.fn(async (_thread: string, update: { agentId: string }) => ({ ...ROW, agentId: update.agentId }));
  const relayRuntimeAgent = vi.fn(async () => options.relay ?? null);
  const env = {
    APP_KV: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key);
        return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => { kv.set(key, value); },
      delete: async (key: string) => { kv.delete(key); },
    },
    ORG: {
      idFromName: (name: string) => name,
      get: () => ({ getThreadRuntime: async () => options.row === undefined ? ROW : options.row, setThreadRuntimeAgent }),
    },
    CHAT_THREAD: { idFromName: (name: string) => name, get: () => ({ relayRuntimeAgent }) },
  } as unknown as ChatEnv;
  return { env, kv, setThreadRuntimeAgent, relayRuntimeAgent };
}

const request = (overrides: Partial<ChannelTurnRequest> = {}): ChannelTurnRequest => ({
  threadId: "t1",
  workspaceId: "ws1",
  orgId: "org1",
  channelKind: "discord",
  userId: "owner-1",
  userName: "Ada",
  userEmail: null,
  systemMessage: "<camelai system message>Reply with send_discord_message.</camelai system message>",
  message: "deploy it",
  clientMessageId: "discord:123",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  directEnabledMock.mockReturnValue(true);
  startRuntimeTurnMock.mockResolvedValue({ status: "accepted", requestId: "r", agentId: "agt_1", fallback: null });
});

describe("startChannelRuntimeTurn", () => {
  it("leaves the thread on ChatThreadDO where direct threads are off", async () => {
    directEnabledMock.mockReturnValue(false);
    expect(await startChannelRuntimeTurn(fakeEnv().env, request())).toBeNull();
    expect(startRuntimeTurnMock).not.toHaveBeenCalled();
  });

  it("starts a direct thread's turn as the acting member, worded as ChatThreadDO words it", async () => {
    const { env } = fakeEnv();
    expect(await startChannelRuntimeTurn(env, request())).toEqual({ status: "accepted" });
    const input = startRuntimeTurnMock.mock.calls[0][1];
    expect(input).toMatchObject({
      row: ROW,
      sender: { userId: "owner-1", userName: "Ada", userEmail: null },
      clientMessageId: "discord_123",
      source: "discord",
      context: { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "owner-1" },
    });
    expect(input.text).toContain("<camelai system message>Reply with send_discord_message.</camelai system message>");
    expect(input.text).toContain("[discord message from Ada]: deploy it");
  });

  it("adopts the runtime agent ChatThreadDO relays the thread to", async () => {
    const { env, setThreadRuntimeAgent } = fakeEnv({ row: null, relay: { agentId: "agt_relay", model: "openrouter/x", keyScope: "hosted" } });
    expect(await startChannelRuntimeTurn(env, request())).toEqual({ status: "accepted" });
    expect(setThreadRuntimeAgent).toHaveBeenCalledWith("t1", { agentId: "agt_relay", model: "openrouter/x", keyScope: "hosted", configured: null });
    expect(startRuntimeTurnMock.mock.calls[0][1].row.agentId).toBe("agt_relay");
  });

  it("refuses a direct thread's message when no member can act for it", async () => {
    expect(await startChannelRuntimeTurn(fakeEnv().env, request({ userId: null }))).toMatchObject({ status: "error" });
    expect(startRuntimeTurnMock).not.toHaveBeenCalled();
  });

  it("leaves a relay thread on ChatThreadDO when no member can act for it", async () => {
    const { env, setThreadRuntimeAgent, relayRuntimeAgent } = fakeEnv({ row: null, relay: { agentId: "agt_relay", model: null, keyScope: null } });
    expect(await startChannelRuntimeTurn(env, request({ userId: null }))).toBeNull();
    expect(relayRuntimeAgent).not.toHaveBeenCalled();
    expect(setThreadRuntimeAgent).not.toHaveBeenCalled();
  });

  it("leaves a thread on ChatThreadDO's own loop there when it does not move", async () => {
    const { env } = fakeEnv({ row: null, relay: null });
    expect(await startChannelRuntimeTurn(env, request())).toBeNull();
    expect(migrateOnSendMock).toHaveBeenCalledWith(env, expect.objectContaining({ threadId: "t1", userId: "owner-1", userName: "Ada" }));
    expect(startRuntimeTurnMock).not.toHaveBeenCalled();
  });

  it("moves a thread on ChatThreadDO's own loop to the runtime, then runs the message there", async () => {
    migrateOnSendMock.mockResolvedValueOnce({ ...ROW, agentId: "agt_moved" } as never);
    expect(await startChannelRuntimeTurn(fakeEnv({ row: null, relay: null }).env, request())).toEqual({ status: "accepted" });
    expect(startRuntimeTurnMock.mock.calls[0][1].row.agentId).toBe("agt_moved");
  });

  it("does not move a thread with no member to act for its message", async () => {
    expect(await startChannelRuntimeTurn(fakeEnv({ row: null, relay: null }).env, request({ userId: null }))).toBeNull();
    expect(migrateOnSendMock).not.toHaveBeenCalled();
  });

  it("puts queued channel history in the next prompt, once", async () => {
    const { env } = fakeEnv();
    await queueChannelHistoryNote(env, "t1", { channelKind: "discord", sentAt: 0, text: "Report sent" });
    await startChannelRuntimeTurn(env, request());
    expect(startRuntimeTurnMock.mock.calls[0][1].text).toContain("Delivered message:\nReport sent");
    await startChannelRuntimeTurn(env, request({ clientMessageId: "discord:124" }));
    expect(startRuntimeTurnMock.mock.calls[1][1].text).not.toContain("Report sent");
  });

  it("keeps the history for a later turn when this one is refused", async () => {
    const { env } = fakeEnv();
    await queueChannelHistoryNote(env, "t1", { channelKind: "discord", sentAt: 0, text: "Report sent" });
    startRuntimeTurnMock.mockResolvedValueOnce({ status: "busy", error: "Agent is busy" });
    expect(await startChannelRuntimeTurn(env, request())).toEqual({ status: "busy", error: "Agent is busy" });
    await startChannelRuntimeTurn(env, request());
    expect(startRuntimeTurnMock.mock.calls[1][1].text).toContain("Report sent");
  });
});

describe("channel request ids", () => {
  it("makes a channel's message id a valid runtime request id, and invents one when there is none", () => {
    expect(channelRequestId("discord:1234")).toBe("discord_1234");
    expect(channelRequestId("slack/T1.C1")).toBe("slack_T1_C1");
    expect(channelRequestId(null)).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(channelRequestId(null)).not.toBe(channelRequestId(null));
  });
});

describe("channel history notes", () => {
  it("words a note as ChatThreadDO appends it", () => {
    const note = formatChannelHistoryNote({
      channelKind: "telegram", sentAt: 0, sourceThreadId: "src", connectionId: "int", remoteConversationId: "42",
      providerMessageIds: ["9"], attachmentCount: 1, text: "Hi",
    });
    expect(note).toBe([
      "<camelai system message>",
      "A camelAI run sent an outbound telegram message to this channel at 1970-01-01T00:00:00.000Z.",
      "Source thread: src.",
      "Channel connection: int.",
      "Remote conversation: 42.",
      "Provider message ids: 9.",
      "Attachment count: 1.",
      "Treat this as already-delivered channel history. Do not resend it unless the user explicitly asks.",
      "",
      "Delivered message:",
      "Hi",
      "</camelai system message>",
    ].join("\n"));
  });
});

describe("ChatThreadDO.relayRuntimeAgent", () => {
  async function relayOf(store: Record<string, unknown>, streaming = false) {
    const { ChatThreadDO } = await import("../src/chat-thread-do");
    const fake = Object.create(ChatThreadDO.prototype) as Record<string, unknown>;
    fake.ctx = { storage: { kv: { get: (key: string) => store[key] } } };
    fake.isThreadStreaming = () => streaming;
    return (ChatThreadDO.prototype as unknown as { relayRuntimeAgent(): unknown }).relayRuntimeAgent.call(fake);
  }

  it("hands over the relayed agent between turns", async () => {
    expect(await relayOf({ runtimeAgent: { id: "agt_1", token: "t", model: "m", keyScope: "hosted" } }))
      .toEqual({ agentId: "agt_1", model: "m", keyScope: "hosted" });
  });

  it("keeps it while a turn runs, and has none for a thread it never relayed", async () => {
    expect(await relayOf({ runtimeAgent: { id: "agt_1", token: "t" } }, true)).toBeNull();
    expect(await relayOf({ runtimeAgent: { id: "agt_1", token: "t" }, runtimeAgentRun: { requestId: "r" } })).toBeNull();
    expect(await relayOf({})).toBeNull();
  });
});
