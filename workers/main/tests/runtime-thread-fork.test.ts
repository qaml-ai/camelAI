/**
 * Forking a runtime thread: a new thread whose agent starts with the source
 * agent's history up to the fork point (agent-runtime/thread-fork.ts).
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeApiMock } = vi.hoisted(() => ({ runtimeApiMock: vi.fn() }));
vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));

import { forkRuntimeThread } from "../src/agent-runtime/thread-fork";
import type { ChatEnv } from "../src/chat-thread/types";

const history = [
  { role: "user", content: "build it", timestamp: 1 },
  { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "camel__read", arguments: {} }], timestamp: 2 },
  { role: "toolResult", toolCallId: "c1", toolName: "camel__read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
  { role: "assistant", content: [{ type: "text", text: "Built." }], timestamp: 4 },
  { role: "user", content: "now test it", timestamp: 5 },
];
const SOURCE = { threadId: "src", agentId: "agt_src", model: "anthropic/claude-sonnet-5-5", keyScope: "org_org1", configured: null, createdAt: 1, updatedAt: 1 };
const target = { orgId: "org1", workspaceId: "ws1", threadId: "fork1", userId: "u1", userName: "Ada", userEmail: null };

function fakeEnv() {
  const org = {
    getThread: vi.fn(async () => ({ created_by: "u1" })),
    getThreadUiState: vi.fn(async () => ({ preview: { tabs: [{ kind: "app", scriptName: "shop", isPublic: true }], activeTabId: "app:shop" } })),
    setThreadUiState: vi.fn(async () => ({})),
    claimThreadRuntimeAgent: vi.fn(async (threadId: string, agentId: string) => ({ row: { ...SOURCE, threadId, agentId, model: null, keyScope: null }, claimed: true })),
  };
  const env = {
    AGENT_RUNTIME_DEFINITION: "def_1",
    AGENT_RUNTIME_URL: "https://runtime.test",
    ORG: { idFromName: (name: string) => name, get: () => org },
  } as unknown as ChatEnv;
  return { env, org };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeApiMock.mockImplementation(async (_env: unknown, method: string, path: string) => {
    if (method === "GET" && path === "/v1/agents/agt_src/history") return { messages: history };
    if (method === "POST" && path === "/v1/agents") return { id: "agt_fork" };
    return {};
  });
});

describe("forkRuntimeThread", () => {
  it("starts the fork's agent with the history through the fork point, and its preview", async () => {
    const { env, org } = fakeEnv();
    const result = await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" });
    expect(result).toMatchObject({ status: "forked", row: { threadId: "fork1", agentId: "agt_fork" } });
    const [, , , body, headers] = runtimeApiMock.mock.calls.find((call) => call[1] === "POST")!;
    expect(body.initialMessages).toEqual(history.slice(0, 4));
    expect(body).toMatchObject({ name: "fork1", subject: "u1", context: { org: "org1", workspace: "ws1", thread: "fork1" } });
    expect(headers["Idempotency-Key"]).toMatch(/^fork_fork1_[0-9a-f]{16}$/);
    expect(org.setThreadUiState).toHaveBeenCalledWith("fork1", { tabs: [{ kind: "app", scriptName: "shop", isPublic: true }], activeTabId: "app:shop" });
    expect(org.claimThreadRuntimeAgent).toHaveBeenCalledWith("fork1", "agt_fork");
  });

  it("keeps a forked turn's tool results after its last message", async () => {
    await forkRuntimeThread(fakeEnv().env, { source: SOURCE, target, forkEntryId: "rt:1" });
    const [, , , body] = runtimeApiMock.mock.calls.find((call) => call[1] === "POST")!;
    expect(body.initialMessages).toEqual(history.slice(0, 3));
  });

  it("answers not found for a fork point the history lacks, making nothing", async () => {
    expect(await forkRuntimeThread(fakeEnv().env, { source: SOURCE, target, forkEntryId: "rt:9" })).toMatchObject({ status: "not_found" });
    expect(await forkRuntimeThread(fakeEnv().env, { source: SOURCE, target, forkEntryId: "client-1" })).toMatchObject({ status: "not_found" });
    expect(runtimeApiMock.mock.calls.some((call) => call[1] === "POST")).toBe(false);
  });

  it("deletes the fork's agent when the fork cannot be recorded", async () => {
    const { env, org } = fakeEnv();
    org.claimThreadRuntimeAgent.mockRejectedValueOnce(new Error("OrgDO down"));
    expect(await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" })).toMatchObject({ status: "failed", error: "OrgDO down" });
    expect(runtimeApiMock).toHaveBeenCalledWith(env, "DELETE", "/v1/agents/agt_fork");
  });

  it("never gives a thread that already has an agent a second one", async () => {
    const { env, org } = fakeEnv();
    org.claimThreadRuntimeAgent.mockResolvedValueOnce({ row: { ...SOURCE, threadId: "fork1", agentId: "agt_other" }, claimed: false } as never);
    expect(await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" })).toMatchObject({ status: "failed" });
    expect(runtimeApiMock).toHaveBeenCalledWith(env, "DELETE", "/v1/agents/agt_fork");
  });
});
