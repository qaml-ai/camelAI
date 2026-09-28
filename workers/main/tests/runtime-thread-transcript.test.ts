/**
 * A thread's whole transcript, wherever the thread runs: the runtime's
 * history for runtime threads, ChatThreadDO's pi_core for the rest
 * (agent-runtime/thread-transcript.ts).
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeApiMock } = vi.hoisted(() => ({ runtimeApiMock: vi.fn() }));
vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));

import { parsedThreadTranscript, threadExplorerSummary, threadRecentSource } from "../src/agent-runtime/thread-transcript";
import { piMessagesToParsedMessages } from "../src/pi-message-export";
import type { ChatEnv } from "../src/chat-thread/types";

const history = [
  { role: "user", content: "deploy it", timestamp: 1 },
  { role: "assistant", content: [{ type: "text", text: "Deploying." }, { type: "toolCall", id: "tc1", name: "camel__deploy", arguments: {} }], timestamp: 2 },
  { role: "toolResult", toolCallId: "tc1", toolName: "camel__deploy", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
];

function fakeEnv(row: { agentId: string | null } | null) {
  const getPiCoreParsedMessages = vi.fn(async () => [{ id: "do-1", role: "user" }]);
  const getAdminExplorerSummary = vi.fn(async () => ({ userMessageCount: 9 }));
  const getGroupNewChatRecentSource = vi.fn(async () => ({ messages: [{ id: "do-1" }], projectActivity: [{ project: "shop" }] }));
  const env = {
    ORG: { idFromName: (name: string) => name, get: () => ({ getThreadRuntime: async () => row }) },
    CHAT_THREAD: { idFromName: (name: string) => name, get: () => ({ getPiCoreParsedMessages, getAdminExplorerSummary, getGroupNewChatRecentSource }) },
  } as unknown as ChatEnv;
  return { env, getPiCoreParsedMessages, getAdminExplorerSummary, getGroupNewChatRecentSource };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeApiMock.mockResolvedValue({ messages: history });
});

describe("piMessagesToParsedMessages", () => {
  it("parses Pi messages, folding each tool result into its call's message", () => {
    const parsed = piMessagesToParsedMessages(history as never, "t1");
    expect(parsed.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(parsed[1].content)).toContain('"tool_use_id":"tc1"');
  });
});

describe("parsedThreadTranscript", () => {
  it("reads a runtime thread's whole history from the runtime", async () => {
    const { env, getPiCoreParsedMessages } = fakeEnv({ agentId: "agt_1" });
    const parsed = await parsedThreadTranscript(env, "org1", "t1");
    expect(runtimeApiMock).toHaveBeenCalledWith(env, "GET", "/v1/agents/agt_1/history");
    expect(parsed).toEqual(piMessagesToParsedMessages(history as never, "t1"));
    expect(getPiCoreParsedMessages).not.toHaveBeenCalled();
  });

  it("has nothing for a runtime thread whose agent is not made yet", async () => {
    expect(await parsedThreadTranscript(fakeEnv({ agentId: null }).env, "org1", "t1")).toEqual([]);
    expect(runtimeApiMock).not.toHaveBeenCalled();
  });

  it("reads a thread still on ChatThreadDO from the DO", async () => {
    const { env, getPiCoreParsedMessages } = fakeEnv(null);
    expect(await parsedThreadTranscript(env, "org1", "t1")).toEqual([{ id: "do-1", role: "user" }]);
    expect(getPiCoreParsedMessages).toHaveBeenCalledWith("t1");
  });
});

describe("threadExplorerSummary", () => {
  it("counts a runtime thread's messages and models from its history", async () => {
    runtimeApiMock.mockResolvedValue({ messages: [...history, { role: "user", content: "again", timestamp: 4 }, { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-sonnet-5-5", timestamp: 5 }] });
    const summary = await threadExplorerSummary(fakeEnv({ agentId: "agt_1" }).env, "org1", "t1", { userMessageCap: 20 });
    expect(summary).toMatchObject({ userMessageCount: 2, userMessageCountCapped: false });
    expect(summary.models).toContain("claude-sonnet-5-5");
  });

  it("asks ChatThreadDO for a thread still there", async () => {
    const { env, getAdminExplorerSummary } = fakeEnv(null);
    expect(await threadExplorerSummary(env, "org1", "t1", { userMessageCap: 5 })).toEqual({ userMessageCount: 9 });
    expect(getAdminExplorerSummary).toHaveBeenCalledWith({ userMessageCap: 5 });
  });
});

describe("threadRecentSource", () => {
  it("reads a runtime thread's newest page of history, not the whole thread", async () => {
    runtimeApiMock.mockResolvedValue({ entries: history.map((message, index) => ({ index: index + 10, message })), next: 10 });
    const source = await threadRecentSource(fakeEnv({ agentId: "agt_1" }).env, "org1", "t1");
    expect(runtimeApiMock).toHaveBeenCalledWith(expect.anything(), "GET", "/v1/agents/agt_1/history?limit=50");
    expect(source).toEqual({ messages: piMessagesToParsedMessages(history as never, "t1"), projectActivity: [] });
  });

  it("asks ChatThreadDO for a thread still there", async () => {
    const { env, getGroupNewChatRecentSource } = fakeEnv(null);
    expect(await threadRecentSource(env, "org1", "t1")).toEqual({ messages: [{ id: "do-1" }], projectActivity: [{ project: "shop" }] });
    expect(getGroupNewChatRecentSource).toHaveBeenCalledWith("t1");
  });
});
