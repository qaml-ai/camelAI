/**
 * Forking a runtime thread: a new thread whose agent is the runtime's fork of
 * the source thread's, through the fork point (agent-runtime/thread-fork.ts).
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeApiMock, v2JsonMock, v2FetchMock } = vi.hoisted(() => ({
  runtimeApiMock: vi.fn(),
  v2JsonMock: vi.fn(),
  v2FetchMock: vi.fn(),
}));
vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));
vi.mock("../src/agent-runtime/runtime-v2.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  v2Json: v2JsonMock,
  v2Fetch: v2FetchMock,
}));

import { forkRuntimeThread } from "../src/agent-runtime/thread-fork";
import { RuntimeApiError } from "../src/agent-runtime/runtime-api";
import type { ChatEnv } from "../src/chat-thread/types";
import { hostedModelHeaders } from "../src/agent-runtime/key-scopes";
import { RUNTIME_PROMPT_VERSION } from "../src/agent-runtime/runtime-prompt";

const SOURCE = { threadId: "src", agentId: "agt_src", model: "anthropic/claude-sonnet-5-5", keyScope: "org_org1", configured: null, createdAt: 1, updatedAt: 1 };
const target = { orgId: "org1", workspaceId: "ws1", threadId: "fork1", userId: "u1", userName: "Ada", userEmail: null };
const forkCall = () => runtimeApiMock.mock.calls.find((call) => call[1] === "POST")!;

function fakeEnv() {
  const org = {
    getThread: vi.fn(async () => ({ created_by: "u1" })),
    getThreadUiState: vi.fn(async () => ({ preview: { tabs: [{ kind: "app", scriptName: "shop", isPublic: true }], activeTabId: "app:shop" } })),
    setThreadUiState: vi.fn(async () => ({})),
    pinThreadRuntime: vi.fn(async () => true),
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
    if (method === "POST" && path === "/v1/agents/agt_src/fork") return { id: "agt_fork", forkedFrom: { agentId: "agt_src", atMessage: 3 } };
    return {};
  });
  v2JsonMock.mockImplementation(async (_env: unknown, path: string, init?: { method?: string }) => {
    if (init?.method === "POST" && path === "/agents/agt_src/fork") return { id: "agt_v2_fork", forkedFrom: { agentId: "agt_src", atSeq: 7 } };
    return {};
  });
  v2FetchMock.mockResolvedValue(new Response(null, { status: 200 }));
});

describe("forkRuntimeThread", () => {
  it("forks the source's agent through the fork point in one call, for the new thread, with its preview", async () => {
    const { env, org } = fakeEnv();
    const result = await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" });
    expect(result).toMatchObject({ status: "forked", row: { threadId: "fork1", agentId: "agt_fork" } });
    expect(runtimeApiMock).toHaveBeenCalledTimes(1);
    const [, , path, body] = forkCall();
    expect(path).toBe("/v1/agents/agt_src/fork");
    expect(body).toMatchObject({ key: "fork_fork1", name: "fork1", atMessage: 3, ttlSeconds: null, subject: "u1", context: { org: "org1", workspace: "ws1", thread: "fork1" } });
    expect(body.systemPromptAppend).toContain("Thread ID: fork1");
    expect(body.modelHeaders).toBeNull();
    expect(org.setThreadUiState).toHaveBeenCalledWith("fork1", { tabs: [{ kind: "app", scriptName: "shop", isPublic: true }], activeTabId: "app:shop" });
    expect(org.claimThreadRuntimeAgent).toHaveBeenCalledWith("fork1", "agt_fork", {
      model: "anthropic/claude-sonnet-5-5",
      keyScope: "org_org1",
      configured: { thinkingLevel: "medium", promptVersion: RUNTIME_PROMPT_VERSION },
    });
  });

  it("gives a fork of a hosted thread the hosted model headers for its own thread", async () => {
    await forkRuntimeThread(fakeEnv().env, { source: { ...SOURCE, keyScope: "hosted", configured: { thinkingLevel: "high" } }, target, forkEntryId: "rt:3" });
    expect(forkCall()[3]).toMatchObject({ modelHeaders: hostedModelHeaders(target) });
  });

  it("answers not found for a fork point the history lacks", async () => {
    runtimeApiMock.mockRejectedValueOnce(new RuntimeApiError("atMessage is a history index from 0 to 4, or a request id", 400, "FORK_POINT_INVALID"));
    expect(await forkRuntimeThread(fakeEnv().env, { source: SOURCE, target, forkEntryId: "rt:9" })).toMatchObject({ status: "not_found" });
    vi.clearAllMocks();
    expect(await forkRuntimeThread(fakeEnv().env, { source: SOURCE, target, forkEntryId: "client-1" })).toMatchObject({ status: "not_found" });
    expect(runtimeApiMock).not.toHaveBeenCalled();
  });

  it("says when the fork point's turn is still running", async () => {
    runtimeApiMock.mockRejectedValueOnce(new RuntimeApiError("Message 3 is in a turn that has not ended yet", 409, "FORK_POINT_RUNNING"));
    expect(await forkRuntimeThread(fakeEnv().env, { source: SOURCE, target, forkEntryId: "rt:3" })).toMatchObject({ status: "failed", error: expect.stringMatching(/still running/) });
  });

  it("deletes the fork's agent when the fork cannot be recorded", async () => {
    const { env, org } = fakeEnv();
    org.claimThreadRuntimeAgent.mockRejectedValueOnce(new Error("OrgDO down"));
    expect(await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" })).toMatchObject({ status: "failed", error: "OrgDO down" });
    expect(runtimeApiMock).toHaveBeenCalledWith(env, "DELETE", "/v1/agents/agt_fork");
  });

  it("never gives a thread that already has an agent a second one, and keeps the one a retry recorded", async () => {
    const { env, org } = fakeEnv();
    org.claimThreadRuntimeAgent.mockResolvedValueOnce({ row: { ...SOURCE, threadId: "fork1", agentId: "agt_other" }, claimed: false } as never);
    expect(await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" })).toMatchObject({ status: "failed" });
    expect(runtimeApiMock).toHaveBeenCalledWith(env, "DELETE", "/v1/agents/agt_fork");
    vi.clearAllMocks();
    org.claimThreadRuntimeAgent.mockResolvedValueOnce({ row: { ...SOURCE, threadId: "fork1", agentId: "agt_fork" }, claimed: false } as never);
    expect(await forkRuntimeThread(env, { source: SOURCE, target, forkEntryId: "rt:3" })).toMatchObject({ status: "forked", row: { agentId: "agt_fork" } });
    expect(runtimeApiMock.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
  });

  it("forks a v2 thread via CamelRun v2, pins runtimeVersion v2, and passes target thread instructions & toolIdentity", async () => {
    const { env, org } = fakeEnv();
    const v2Source = { ...SOURCE, runtimeVersion: "v2" as const, model: "azure/gpt-6.1-terra", keyScope: null };
    org.claimThreadRuntimeAgent.mockResolvedValueOnce({ row: { ...v2Source, threadId: "fork1", agentId: "agt_v2_fork" }, claimed: true } as never);
    const result = await forkRuntimeThread(env, { source: v2Source, target, forkEntryId: "rt:7" });
    expect(result).toMatchObject({ status: "forked", row: { threadId: "fork1", agentId: "agt_v2_fork", runtimeVersion: "v2" } });
    expect(runtimeApiMock).not.toHaveBeenCalled();
    expect(v2JsonMock).toHaveBeenCalledTimes(1);
    const [, path, init] = v2JsonMock.mock.calls[0]!;
    expect(path).toBe("/agents/agt_src/fork");
    expect(init.method).toBe("POST");
    expect(init.body).toMatchObject({
      key: "chiridion-thread-fork1",
      atSeq: 7,
      forkRepo: true,
      toolIdentity: { subject: "u1", context: { org: "org1", workspace: "ws1", thread: "fork1" } },
    });
    expect(init.body.instructions).toContain("Thread ID: fork1");
    expect(org.pinThreadRuntime).toHaveBeenCalledWith("fork1", null, "v2");
    expect(org.claimThreadRuntimeAgent).toHaveBeenCalledWith("fork1", "agt_v2_fork", {
      model: "azure/gpt-6.1-terra",
      keyScope: null,
      configured: { thinkingLevel: "medium", promptVersion: RUNTIME_PROMPT_VERSION },
    });
  });

  it("maps v2 fork_point_invalid and fork_point_running and cleans up via v2 DELETE on claim failure", async () => {
    const { env, org } = fakeEnv();
    const v2Source = { ...SOURCE, runtimeVersion: "v2" as const };
    v2JsonMock.mockRejectedValueOnce(new RuntimeApiError("Fork target not found", 404, "fork_point_invalid"));
    expect(await forkRuntimeThread(env, { source: v2Source, target, forkEntryId: "rt:99" })).toMatchObject({ status: "not_found" });

    v2JsonMock.mockRejectedValueOnce(new RuntimeApiError("Still running", 409, "fork_point_running"));
    expect(await forkRuntimeThread(env, { source: v2Source, target, forkEntryId: "rt:7" })).toMatchObject({ status: "failed", error: expect.stringMatching(/still running/) });

    org.claimThreadRuntimeAgent.mockRejectedValueOnce(new Error("OrgDO down"));
    expect(await forkRuntimeThread(env, { source: v2Source, target, forkEntryId: "rt:7" })).toMatchObject({ status: "failed", error: "OrgDO down" });
    expect(v2FetchMock).toHaveBeenCalledWith(env, "/agents/agt_v2_fork", { method: "DELETE" });
  });
});
