/**
 * Moving ChatThreadDO threads to the agent runtime (agent-runtime/thread-migration.ts).
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeApiMock, directEnabledMock, directRowMock, routeMock } = vi.hoisted(() => ({
  runtimeApiMock: vi.fn(),
  routeMock: vi.fn(),
  directEnabledMock: vi.fn(() => true),
  directRowMock: vi.fn(),
}));

vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));
vi.mock("../src/agent-runtime/run-gates.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveThreadRuntimeRoute: routeMock,
}));
vi.mock("../src/agent-runtime/thread-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeDirectThreadsEnabled: directEnabledMock,
}));
vi.mock("../src/agent-runtime/channel-turns.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  directRuntimeRow: directRowMock,
}));

import {
  ARCHIVE_PATH,
  MAX_IMPORT_BYTES,
  MAX_TOOL_RESULT_CHARS,
  convertTranscript,
  importNote,
  migrateThreadToRuntime,
  type RuntimeMigrationExport,
} from "../src/agent-runtime/thread-migration";
import type { ChatEnv } from "../src/chat-thread/types";

const user = (text: string, extra: Record<string, unknown> = {}) => ({ role: "user", content: text, timestamp: 1, ...extra });
const assistantCall = (id: string, name: string, args: unknown) => ({
  role: "assistant",
  content: [{ type: "text", text: "Let me check." }, { type: "toolCall", id, name, arguments: args }],
  provider: "openrouter", model: "m", stopReason: "toolUse", timestamp: 2,
});
const toolResult = (id: string, name: string, text: string) => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 3,
});

describe("convertTranscript", () => {
  it("keeps a plain conversation as it is, and is not lossy", () => {
    const converted = convertTranscript([user("hi"), { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 }] as never);
    expect(converted.lossy).toBe(false);
    expect(converted.messages).toHaveLength(2);
  });

  it("keeps old tool calls as calls: every provider takes calls to tools the agent lacks", () => {
    const messages = [user("deploy"), assistantCall("tc1", "deploy_project", { name: "shop" }), toolResult("tc1", "deploy_project", "Deployed")];
    expect(convertTranscript(messages as never).messages).toEqual(messages);
  });

  it("can write old tool calls and results as text", () => {
    const converted = convertTranscript([user("deploy"), assistantCall("tc1", "deploy_project", { name: "shop" }), toolResult("tc1", "deploy_project", "Deployed to https://shop.test")] as never, { rewriteToolCalls: true });
    const [, assistant, result] = converted.messages as Array<{ role: string; content: unknown }>;
    expect(assistant.content).toEqual([{ type: "text", text: "Let me check." }, { type: "text", text: '[called deploy_project({"name":"shop"})]' }]);
    expect(result).toMatchObject({ role: "user", content: "[deploy_project result] Deployed to https://shop.test" });
  });

  it("can keep tool calls as calls, shortening a huge result", () => {
    const huge = "x".repeat(MAX_TOOL_RESULT_CHARS * 2);
    const converted = convertTranscript([assistantCall("tc1", "read", {}), toolResult("tc1", "read", huge)] as never, { rewriteToolCalls: false });
    const result = converted.messages[1] as { role: string; content: Array<{ text: string }> };
    expect(result.role).toBe("toolResult");
    expect(result.content[0].text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(result.content[0].text).toContain(ARCHIVE_PATH);
    expect(converted).toMatchObject({ lossy: true, stats: { shortenedResults: 1 } });
  });

  it("keeps inline images, leaves out stored ones and other message kinds, and says so", () => {
    const stored = { type: "image", data: "", mimeType: "image/png", metadata: { chiridionR2Image: { key: "k", mimeType: "image/png", sha256: "s" } } };
    const converted = convertTranscript([
      user("look", { content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }, stored] }),
      { role: "bashExecution", command: "ls" },
    ] as never);
    expect(converted.messages).toHaveLength(1);
    expect((converted.messages[0] as { content: unknown[] }).content).toEqual([
      { type: "text", text: "look" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "text", text: `[image left out of the import; see ${ARCHIVE_PATH}]` },
    ]);
    expect(converted.stats).toMatchObject({ droppedRoles: 1, omittedImages: 1 });
    expect(converted.lossy).toBe(true);
  });

  it("drops thinking signatures, which only the recording model can check", () => {
    const converted = convertTranscript([{
      role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", timestamp: 2,
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
        { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
        { type: "text", text: "done" },
      ],
    }] as never);
    expect((converted.messages[0] as { content: unknown[] }).content).toEqual([{ type: "thinking", thinking: "plan" }, { type: "text", text: "done" }]);
    expect(converted.messages[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
    expect(converted.lossy).toBe(false);
  });

  it("imports a compaction summary as one, standing in for what came before", () => {
    const converted = convertTranscript([user("old"), user("[Context Summary]\n\nEarlier: built the shop.", { timestamp: 9 }), user("and now?")] as never);
    expect(converted.messages[1]).toEqual({ role: "compactionSummary", summary: "Earlier: built the shop.", timestamp: 9 });
  });

  it("imports the latest context of a history over the cap, from its last compaction summary", () => {
    const big = "y".repeat(1024 * 1024);
    const messages = [
      ...Array.from({ length: 20 }, () => user(big)),
      user("[Context Summary]\n\nEarlier: built the shop."),
      user("and now?"),
    ];
    const converted = convertTranscript(messages as never);
    expect(converted.stats.tail).toBe(true);
    expect(converted.messages[0]).toMatchObject({ role: "compactionSummary", summary: "Earlier: built the shop." });
    expect(new TextEncoder().encode(JSON.stringify(converted.messages)).length).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
  });
});

describe("migrateThreadToRuntime", () => {
  const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
  const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };

  function fakeEnv(handover: RuntimeMigrationExport, options: { row?: typeof ROW | null; setRow?: typeof ROW | null } = {}) {
    const doStub = {
      beginRuntimeMigration: vi.fn(async () => handover),
      abortRuntimeMigration: vi.fn(async () => true),
      completeRuntimeMigration: vi.fn(async () => true),
    };
    const org = {
      getThread: vi.fn(async () => ({ created_by: "u1" })),
      getThreadRuntime: vi.fn(async () => options.row ?? null),
      setThreadRuntimeAgent: vi.fn(async () => (options.setRow === undefined ? ROW : options.setRow)),
      setThreadUiState: vi.fn(async () => ({})),
    };
    const env = {
      AGENT_RUNTIME_DEFINITION: "def_1",
      AGENT_RUNTIME_URL: "https://runtime.test",
      AGENT_RUNTIME_API_TOKEN: "operator",
      ORG: { idFromName: (name: string) => name, get: () => org },
      CHAT_THREAD: { idFromName: (name: string) => name, get: () => doStub },
    } as unknown as ChatEnv;
    return { env, doStub, org };
  }

  const ok = (messages: unknown[]): RuntimeMigrationExport => ({
    status: "ok", leaseId: "lease-1", messages: messages as never, previewTabs: [{ kind: "app", scriptName: "shop", isPublic: true } as never], previewActiveTabId: "app:shop",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    directEnabledMock.mockReturnValue(true);
    routeMock.mockResolvedValue({ route: { provider: "openrouter" } });
    runtimeApiMock.mockResolvedValue({ id: "agt_new" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 201 }));
  });

  it("moves a thread: an agent with its history, its preview tabs, then the row, then the DO told", async () => {
    const { env, doStub, org } = fakeEnv(ok([user("hi")]));
    const result = await migrateThreadToRuntime(env, context);
    expect(result).toMatchObject({ status: "migrated", row: ROW, archived: false });
    const [, method, path, body, headers] = runtimeApiMock.mock.calls[0];
    expect([method, path]).toEqual(["POST", "/v1/agents"]);
    expect(body).toMatchObject({ definition: "def_1", subject: "u1", context: { org: "org1", workspace: "ws1", thread: "t1" } });
    expect(body.initialMessages).toEqual([importNote(false, body.initialMessages[0].timestamp), user("hi")]);
    expect(headers["Idempotency-Key"]).toMatch(/^migrate_t1_[0-9a-f]{16}$/);
    expect(org.setThreadUiState).toHaveBeenCalledWith("t1", { tabs: [{ kind: "app", scriptName: "shop", isPublic: true }], activeTabId: "app:shop" });
    expect(org.setThreadRuntimeAgent).toHaveBeenCalledWith("t1", { agentId: "agt_new", model: null, keyScope: null, configured: null });
    expect(doStub.completeRuntimeMigration).toHaveBeenCalledWith("lease-1", "agt_new");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("puts the import note after the last compaction summary, where the model still sees it", async () => {
    const { env } = fakeEnv(ok([user("old"), user("[Context Summary]\n\nEarlier."), user("now")]));
    await migrateThreadToRuntime(env, context);
    const roles = runtimeApiMock.mock.calls[0][3].initialMessages.map((message: { role: string; content?: string }) =>
      message.role === "user" ? message.content?.slice(0, 22) : message.role);
    expect(roles).toEqual(["old", "compactionSummary", "<camelai system messag", "now"]);
  });

  it("archives the original transcript when the import is not all of it", async () => {
    const { env } = fakeEnv(ok([assistantCall("tc1", "read", {}), toolResult("tc1", "read", "z".repeat(MAX_TOOL_RESULT_CHARS + 1))]));
    expect(await migrateThreadToRuntime(env, context)).toMatchObject({ status: "migrated", archived: true });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://runtime.test/v1/agents/agt_new/uploads/camel-migration/original-transcript.jsonl");
    expect(init.method).toBe("PUT");
    expect(String(init.body).split("\n")).toHaveLength(2);
  });

  it("leaves the thread on the DO when anything fails before the row: agent deleted, lease released", async () => {
    const { env, doStub, org } = fakeEnv(ok([assistantCall("tc1", "read", {}), toolResult("tc1", "read", "z".repeat(MAX_TOOL_RESULT_CHARS + 1))]));
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await migrateThreadToRuntime(env, context);
    expect(result).toMatchObject({ status: "failed" });
    expect(runtimeApiMock).toHaveBeenCalledWith(expect.anything(), "DELETE", "/v1/agents/agt_new");
    expect(doStub.abortRuntimeMigration).toHaveBeenCalledWith("lease-1");
    expect(org.setThreadRuntimeAgent).not.toHaveBeenCalled();
    expect(doStub.completeRuntimeMigration).not.toHaveBeenCalled();
  });

  it("reports a dry run without moving anything", async () => {
    const { env, doStub, org } = fakeEnv(ok([user("hi")]));
    const result = await migrateThreadToRuntime(env, context, { dryRun: true });
    expect(result).toMatchObject({ status: "dry_run", lossy: false, stats: { total: 1, imported: 1 } });
    expect(runtimeApiMock).not.toHaveBeenCalled();
    expect(org.setThreadRuntimeAgent).not.toHaveBeenCalled();
    expect(doStub.abortRuntimeMigration).toHaveBeenCalledWith("lease-1");
  });

  it("adopts a relay thread, and waits out a busy one", async () => {
    directRowMock.mockResolvedValue(ROW);
    expect(await migrateThreadToRuntime(fakeEnv({ status: "relay" }).env, context)).toMatchObject({ status: "adopted", row: ROW });
    expect(await migrateThreadToRuntime(fakeEnv({ status: "busy", reason: "running" }).env, context)).toEqual({ status: "busy", reason: "running" });
  });

  it("leaves a thread whose model has no runtime route on ChatThreadDO", async () => {
    routeMock.mockResolvedValueOnce({ route: null });
    const unrouted = fakeEnv(ok([user("hi")]));
    expect(await migrateThreadToRuntime(unrouted.env, context)).toEqual({ status: "skipped", reason: "no runtime route for its model" });
    expect(unrouted.doStub.beginRuntimeMigration).not.toHaveBeenCalled();
    // Checking the route must not move the thread to the free model (the DO does that at its next run).
    expect(routeMock).toHaveBeenCalledWith(unrouted.env, context, { persistFallback: false });
    routeMock.mockRejectedValueOnce(new Error("unknown model"));
    expect(await migrateThreadToRuntime(fakeEnv(ok([])).env, context)).toEqual({ status: "skipped", reason: "its model did not resolve: unknown model" });
  });

  it("does nothing for a thread already on the runtime, or where direct threads are off", async () => {
    const onRuntime = fakeEnv(ok([]), { row: ROW });
    expect(await migrateThreadToRuntime(onRuntime.env, context)).toMatchObject({ status: "runtime" });
    expect(onRuntime.doStub.beginRuntimeMigration).not.toHaveBeenCalled();
    directEnabledMock.mockReturnValue(false);
    expect(await migrateThreadToRuntime(fakeEnv(ok([])).env, context)).toMatchObject({ status: "skipped" });
  });
});
