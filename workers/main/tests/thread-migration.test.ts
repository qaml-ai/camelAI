/**
 * Moving ChatThreadDO threads to the agent runtime (agent-runtime/thread-migration.ts).
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeApiMock, directEnabledMock, routeMock, hostedScopeMock, orgScopeMock } = vi.hoisted(() => ({
  runtimeApiMock: vi.fn(),
  routeMock: vi.fn(),
  directEnabledMock: vi.fn(() => true),
  hostedScopeMock: vi.fn(async () => true),
  orgScopeMock: vi.fn(async () => undefined),
}));

vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));
vi.mock("../src/agent-runtime/run-gates.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveThreadRuntimeRoute: routeMock,
}));
vi.mock("../src/agent-runtime/key-scopes", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureHostedKeyScope: hostedScopeMock,
  syncOrgKeyScope: orgScopeMock,
}));
vi.mock("../src/agent-runtime/thread-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeDirectThreadsEnabled: directEnabledMock,
}));

import {
  ARCHIVE_PATH,
  MAX_IMPORT_BYTES,
  MAX_TOOL_RESULT_CHARS,
  convertTranscript,
  classifyMove,
  importNote,
  migrateThreadOnSend,
  moveThreadForSend,
  migrateThreadToRuntime,
  reconcileRuntimeMigrationOrphans,
  runtimeMigrationKey,
  runtimeMigrationKeyThread,
  withImportNote,
  type DoMigrationResult,
} from "../src/agent-runtime/thread-migration";
import type { ChatEnv } from "../src/chat-thread/types";
import { hostedModelHeaders } from "../src/agent-runtime/key-scopes";

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

  const big = (label: string) => user(`${label}:${"y".repeat(1024 * 1024)}`);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  it("over the cap, keeps the model's part whole and fills the room left with the newest earlier turns", () => {
    const messages = [
      ...Array.from({ length: 20 }, (_, index) => big(`old${index}`)),
      user("[Context Summary]\n\nEarlier: built the shop."),
      user("and now?"),
    ];
    const converted = convertTranscript(messages as never);
    expect(converted).toMatchObject({ tooLarge: false, lossy: true, stats: { tail: true } });
    const kept = converted.messages as Array<{ role: string; content?: string }>;
    // The newest old turns, then the summary and what follows it.
    expect(kept.at(-2)).toMatchObject({ role: "compactionSummary", summary: "Earlier: built the shop." });
    expect(kept.at(-1)).toMatchObject({ content: "and now?" });
    expect(kept[0].content?.startsWith("old")).toBe(true);
    expect(kept.length).toBeGreaterThan(2);
    expect(bytes(converted.messages)).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
  });

  it("keeps a summary at the very start when the model's part alone is over the cap", () => {
    const messages = [user("[Context Summary]\n\nEarlier."), ...Array.from({ length: 20 }, (_, index) => big(`new${index}`))];
    const converted = convertTranscript(messages as never);
    expect(converted.messages[0]).toMatchObject({ role: "compactionSummary", summary: "Earlier." });
    expect((converted.messages.at(-1) as { content: string }).content.startsWith("new19")).toBe(true);
    expect(bytes(converted.messages)).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
  });

  it("never starts a cut import at a tool result whose call was cut off", () => {
    const turn = (index: number) => [
      big(`ask${index}`),
      assistantCall(`tc${index}`, "read", {}),
      toolResult(`tc${index}`, "read", "ok"),
    ];
    const converted = convertTranscript(Array.from({ length: 20 }, (_, index) => turn(index)).flat() as never, { rewriteToolCalls: false });
    expect(converted.messages[0]).toMatchObject({ role: "user" });
    expect(bytes(converted.messages)).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
  });

  it("says a history cannot move when not even its newest message fits", () => {
    const huge = { role: "user", content: [{ type: "image", data: "A".repeat(MAX_IMPORT_BYTES + 1), mimeType: "image/png" }], timestamp: 1 };
    expect(convertTranscript([user("hi"), huge] as never)).toMatchObject({ tooLarge: true, messages: [] });
  });

  it("converts the same history to the same import every time, note included", () => {
    const history = [user("hi", { timestamp: 5 }), assistantCall("tc1", "read", {}), { ...toolResult("tc1", "read", "ok"), timestamp: undefined }];
    vi.useFakeTimers();
    const first = withImportNote(convertTranscript(history as never, { rewriteToolCalls: true }).messages, false);
    vi.setSystemTime(Date.now() + 60_000);
    const second = withImportNote(convertTranscript(history as never, { rewriteToolCalls: true }).messages, false);
    vi.useRealTimers();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first[0]).toEqual(importNote(false, 5));
  });
});

describe("convertTranscript: what the runtime's import validator takes (M4)", () => {
  it("makes toolCall arguments objects, names every tool result, and keeps only text and typed images", () => {
    const converted = convertTranscript([
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: "AAAA" }, { type: "file", name: "a.pdf" }], timestamp: 1 },
      { role: "assistant", content: [
        { type: "toolCall", id: "c1", name: "read", arguments: '{"path":"a"}' },
        { type: "toolCall", id: "c2", name: "list", arguments: "not json" },
        { type: "toolCall", name: "nameless" },
        { type: "weird" },
        "stray",
      ], timestamp: 2 },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
      { role: "toolResult", content: "orphan", timestamp: 4 },
    ] as never);
    const [userMessage, assistant, result] = converted.messages as Array<{ content: unknown; toolName?: string }>;
    expect(userMessage.content).toEqual([
      { type: "text", text: "see" },
      { type: "text", text: `[image left out of the import; see ${ARCHIVE_PATH}]` },
      { type: "text", text: `[file left out of the import; see ${ARCHIVE_PATH}]` },
    ]);
    expect(assistant.content).toEqual([
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "c2", name: "list", arguments: { value: "not json" } },
      { type: "text", text: "[called nameless]" },
    ]);
    expect(result).toMatchObject({ toolCallId: "c1", toolName: "read" });
    expect(converted.messages).toHaveLength(3);
    expect(converted.lossy).toBe(true);
    expect(converted.stats.normalized).toBeGreaterThan(0);
  });
});

describe("convertTranscript: messages a provider refuses (review 3)", () => {
  it("leaves out user and assistant messages left empty", () => {
    const converted = convertTranscript([
      { role: "user", content: "  ", timestamp: 1 },
      { role: "user", content: [{ type: "weird" }].slice(1), timestamp: 2 },
      { role: "assistant", content: [{ type: "thinking", thinking: "", redacted: true }], timestamp: 3 },
      { role: "user", content: "real", timestamp: 4 },
    ] as never);
    expect(converted.messages).toEqual([{ role: "user", content: "real", timestamp: 4 }]);
    expect(converted.stats.normalized).toBe(3);
  });
});

describe("runtimeMigrationKey", () => {
  it("is a key the runtime takes for real (UUID) thread and lease ids, and names its thread", () => {
    const threadId = crypto.randomUUID();
    const key = runtimeMigrationKey(threadId, crypto.randomUUID());
    expect(key).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
    expect(runtimeMigrationKeyThread(key)).toBe(threadId);
    expect(runtimeMigrationKey(threadId, crypto.randomUUID())).not.toBe(key);
  });
});

describe("reconcileRuntimeMigrationOrphans", () => {
  const ORG_ROW = { threadId: "t1", agentId: "agt_row", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };

  it("deletes a move's agent that neither the thread's move nor its runtime row holds, and nothing else", async () => {
    runtimeApiMock.mockImplementation(async (_env: unknown, method: string) => method === "GET" ? [
      { id: "agt_moving", key: "migrate_t1_lease-a", name: "t1" },
      { id: "agt_row", key: "migrate_t1_lease-b", name: "t1" },
      { id: "agt_lost", key: "migrate_t1_lease-c", name: "t1" },
      { id: "agt_unknown_org", key: "migrate_t2_lease-d", name: "t2" },
      { id: "agt_thread", key: "thread_t1", name: "t1" },
    ] : null);
    const holds = vi.fn(async (agentId: string) => (agentId === "agt_unknown_org" ? { holds: false } : { holds: agentId === "agt_moving", orgId: "org1" }));
    const org = { getThreadRuntime: vi.fn(async () => ORG_ROW) };
    const env = {
      ORG: { idFromName: (name: string) => name, get: () => org },
      CHAT_THREAD: { idFromName: (name: string) => name, get: () => ({ runtimeMigrationHolds: holds }) },
    } as unknown as ChatEnv;
    const dry = await reconcileRuntimeMigrationOrphans(env, { dryRun: true });
    expect(dry).toEqual({ scanned: 4, kept: 2, orphans: ["agt_lost"], deleted: [], unverifiable: ["agt_unknown_org"], next: null });
    expect(runtimeApiMock.mock.calls.some((call) => call[1] === "DELETE")).toBe(false);
    const real = await reconcileRuntimeMigrationOrphans(env);
    expect(real.deleted).toEqual(["agt_lost"]);
    expect(runtimeApiMock).toHaveBeenCalledWith(expect.anything(), "DELETE", "/v1/agents/agt_lost", undefined, {}, expect.any(Function));
    expect(holds).toHaveBeenCalledWith("agt_moving", "migrate_t1_lease-a");
    // A page at a time, in agent id order.
    const first = await reconcileRuntimeMigrationOrphans(env, { dryRun: true, limit: 2 });
    expect(first).toMatchObject({ scanned: 2, next: "agt_moving" });
    expect(await reconcileRuntimeMigrationOrphans(env, { dryRun: true, limit: 2, after: first.next })).toMatchObject({ scanned: 2, next: null });
  });
});

describe("migrateThreadToRuntime", () => {
  const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
  const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
  const MEMBERS = [{ user_id: "owner1", role: "owner" }, { user_id: "u1", role: "member" }];

  function fakeEnv(
    answer: DoMigrationResult,
    options: { row?: typeof ROW | null; rows?: Array<typeof ROW | null>; thread?: Record<string, unknown> | null; connectionOwner?: string | null; relay?: object | null; flags?: Record<string, string>; status?: { state: string | null } } = {},
  ) {
    const chat = {
      migrateToRuntime: vi.fn(async () => answer),
      runtimeMigrationStatus: vi.fn(async () => options.status ?? { state: null }),
      relayRuntimeAgent: vi.fn(async () => options.relay ?? null),
    };
    const org = {
      getThread: vi.fn(async () => (options.thread === undefined ? { workspace_id: "ws1", created_by: "u1" } : options.thread)),
      getThreadRuntime: vi.fn(async () => (options.rows ? options.rows.shift() ?? null : options.row ?? null)),
      setThreadRuntimeAgent: vi.fn(async () => ROW),
      getMember: vi.fn(async (id: string) => MEMBERS.find((member) => member.user_id === id) ?? null),
      getMembers: vi.fn(async () => MEMBERS),
    };
    const workspace = { getIntegration: vi.fn(async () => (options.connectionOwner ? { created_by: options.connectionOwner } : null)) };
    const env = {
      ...options.flags,
      AGENT_RUNTIME_DEFINITION: "def_1",
      ORG: { idFromName: (name: string) => name, get: () => org },
      CHAT_THREAD: { idFromName: (name: string) => name, get: () => chat },
      WORKSPACE: { idFromName: (name: string) => name, get: () => workspace },
    } as unknown as ChatEnv;
    return { env, chat, org };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    directEnabledMock.mockReturnValue(true);
    hostedScopeMock.mockResolvedValue(true);
    routeMock.mockResolvedValue(HOSTED_ROUTE);
  });

  const HOSTED_ROUTE = {
    route: { kind: "scope", model: "openrouter/anthropic/claude-sonnet-5", keyScope: "hosted" },
    threadModel: "claude-sonnet-5",
    llmProviderRecord: null,
  };
  const HOSTED_AGENT = {
    model: "openrouter/anthropic/claude-sonnet-5",
    keyScope: "hosted",
    modelHeaders: hostedModelHeaders(context),
    thinkingLevel: "medium",
  };

  it("has the thread's DO move it, acting for its creator", async () => {
    const migrated = { status: "migrated", row: ROW, archived: false, stats: {} } as unknown as DoMigrationResult;
    const { env, chat } = fakeEnv(migrated);
    expect(await migrateThreadToRuntime(env, context)).toBe(migrated);
    expect(chat.migrateToRuntime).toHaveBeenCalledWith({ context, subject: "u1", agentModel: HOSTED_AGENT, dryRun: undefined });
  });

  describe("the agent's model and key scope (canary 1)", () => {
    it("syncs the hosted scope first and has the agent made on it, with the hosted model headers", async () => {
      const { env, chat } = fakeEnv({ status: "busy", reason: "running" });
      await migrateThreadToRuntime(env, context);
      expect(hostedScopeMock).toHaveBeenCalledWith(env);
      expect(orgScopeMock).not.toHaveBeenCalled();
      expect(hostedScopeMock.mock.invocationCallOrder[0]).toBeLessThan(chat.migrateToRuntime.mock.invocationCallOrder[0]);
      expect(chat.migrateToRuntime).toHaveBeenCalledWith(expect.objectContaining({ agentModel: HOSTED_AGENT }));
    });

    it("syncs a BYOK org's own scope first and has the agent made on it, without hosted headers", async () => {
      const record = { provider: "anthropic", credentials_encrypted: "x", config: "{}" };
      routeMock.mockResolvedValue({
        route: { kind: "scope", model: "anthropic/claude-sonnet-5", keyScope: "org_org1" },
        threadModel: "gpt-6-luna",
        llmProviderRecord: record,
      });
      const { env, chat } = fakeEnv({ status: "busy", reason: "running" });
      await migrateThreadToRuntime(env, context);
      expect(orgScopeMock).toHaveBeenCalledWith(env, "org1", record);
      expect(hostedScopeMock).not.toHaveBeenCalled();
      expect(chat.migrateToRuntime).toHaveBeenCalledWith(expect.objectContaining({
        agentModel: { model: "anthropic/claude-sonnet-5", keyScope: "org_org1", modelHeaders: null, thinkingLevel: "high" },
      }));
    });

    it("leaves the thread where it is when its key scope cannot be had", async () => {
      hostedScopeMock.mockResolvedValueOnce(false);
      const unconfigured = fakeEnv({ status: "busy", reason: "running" });
      expect(await migrateThreadToRuntime(unconfigured.env, context)).toMatchObject({ status: "skipped", reason: expect.stringContaining("not_configured") });
      expect(unconfigured.chat.migrateToRuntime).not.toHaveBeenCalled();
      hostedScopeMock.mockRejectedValueOnce(new Error("runtime down"));
      const down = fakeEnv({ status: "busy", reason: "running" });
      expect(await migrateThreadToRuntime(down.env, context)).toEqual({ status: "failed", error: "key scope: runtime down" });
      expect(down.chat.migrateToRuntime).not.toHaveBeenCalled();
    });

    it("checks the route and key scope on a dry run too, and says which", async () => {
      const { env } = fakeEnv({ status: "dry_run", stats: {}, lossy: false, bytes: 10 } as unknown as DoMigrationResult);
      expect(await migrateThreadToRuntime(env, context, { dryRun: true })).toMatchObject({ status: "dry_run", model: HOSTED_AGENT.model, keyScope: "hosted" });
      expect(hostedScopeMock).toHaveBeenCalled();
      hostedScopeMock.mockResolvedValueOnce(false);
      expect(await migrateThreadToRuntime(fakeEnv({ status: "dry_run" } as unknown as DoMigrationResult).env, context, { dryRun: true }))
        .toMatchObject({ status: "skipped", reason: expect.stringContaining("not_configured") });
    });
  });

  it("moves a thread of the caller's workspace only", async () => {
    const elsewhere = fakeEnv({ status: "skipped", reason: "moved" }, { thread: { workspace_id: "ws_other", created_by: "u1" } });
    expect(await migrateThreadToRuntime(elsewhere.env, context)).toEqual({ status: "skipped", reason: "not a thread of this workspace" });
    expect(elsewhere.chat.migrateToRuntime).not.toHaveBeenCalled();
    expect(elsewhere.org.getThreadRuntime).not.toHaveBeenCalled();
    const missing = fakeEnv({ status: "skipped", reason: "moved" }, { thread: null });
    expect(await migrateThreadToRuntime(missing.env, context)).toMatchObject({ status: "skipped" });
    expect(missing.chat.migrateToRuntime).not.toHaveBeenCalled();
  });

  it("asks the thread's DO where its move stands before doing the work to ask for one (L4)", async () => {
    for (const [state, expected] of [
      ["backoff", { status: "skipped", reason: "backoff" }],
      ["moved", { status: "skipped", reason: "moved" }],
      ["moving", { status: "busy", reason: "moving" }],
    ] as const) {
      const waiting = fakeEnv({ status: "relay" }, { status: { state } });
      expect(await migrateThreadToRuntime(waiting.env, context)).toEqual(expected);
      expect(waiting.chat.migrateToRuntime).not.toHaveBeenCalled();
      expect(waiting.org.getMembers).not.toHaveBeenCalled();
    }
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("finishes a commit left pending when the thread is opened (M-C)", async () => {
    const pending = fakeEnv({ status: "runtime", row: ROW } as DoMigrationResult, { status: { state: "committing" } });
    expect(await migrateThreadToRuntime(pending.env, context)).toEqual({ status: "runtime", row: ROW });
    expect(pending.chat.migrateToRuntime).toHaveBeenCalledWith({ context, subject: null });
    expect(routeMock).not.toHaveBeenCalled();
  });

  it("acts for the channel's connection owner, or the org's owner, when the creator is no member", async () => {
    const channel = fakeEnv({ status: "busy", reason: "running" }, { thread: { workspace_id: "ws1", created_by: "slack", channel_connection_id: "conn1" }, connectionOwner: "connector" });
    await migrateThreadToRuntime(channel.env, context);
    expect(channel.chat.migrateToRuntime).toHaveBeenCalledWith(expect.objectContaining({ subject: "connector" }));
    const scheduled = fakeEnv({ status: "busy", reason: "running" }, { thread: { workspace_id: "ws1", created_by: "system" } });
    await migrateThreadToRuntime(scheduled.env, context);
    expect(scheduled.chat.migrateToRuntime).toHaveBeenCalledWith(expect.objectContaining({ subject: "owner1" }));
  });

  it("adopts a relay thread, and waits out a busy one", async () => {
    const relay = fakeEnv({ status: "relay" }, { relay: { agentId: "agt_relay", model: "m", keyScope: "hosted" } });
    expect(await migrateThreadToRuntime(relay.env, context)).toMatchObject({ status: "adopted", row: ROW });
    expect(relay.org.setThreadRuntimeAgent).toHaveBeenCalledWith("t1", { agentId: "agt_relay", model: "m", keyScope: "hosted", configured: null });
    expect(await migrateThreadToRuntime(fakeEnv({ status: "busy", reason: "running" }).env, context)).toEqual({ status: "busy", reason: "running" });
  });

  it("leaves a thread whose model has no runtime route on ChatThreadDO", async () => {
    routeMock.mockResolvedValueOnce({ route: null });
    const unrouted = fakeEnv({ status: "skipped", reason: "moved" });
    expect(await migrateThreadToRuntime(unrouted.env, context)).toEqual({ status: "skipped", reason: "no runtime route for its model" });
    expect(unrouted.chat.migrateToRuntime).not.toHaveBeenCalled();
    // Checking the route must not move the thread to the free model (the DO does that at its next run).
    expect(routeMock).toHaveBeenCalledWith(unrouted.env, context, { persistFallback: false });
    routeMock.mockRejectedValueOnce(new Error("unknown model"));
    expect(await migrateThreadToRuntime(fakeEnv({ status: "relay" }).env, context)).toEqual({ status: "skipped", reason: "its model did not resolve: unknown model" });
  });

  it("does nothing for a thread already on the runtime, or where the agent runtime is not configured", async () => {
    const onRuntime = fakeEnv({ status: "relay" }, { row: ROW });
    expect(await migrateThreadToRuntime(onRuntime.env, context)).toMatchObject({ status: "runtime" });
    expect(onRuntime.chat.migrateToRuntime).not.toHaveBeenCalled();
    directEnabledMock.mockReturnValue(false);
    expect(await migrateThreadToRuntime(fakeEnv({ status: "relay" }).env, context)).toMatchObject({ status: "skipped" });
  });
});

describe("migrateThreadOnSend", () => {
  const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
  const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
  const FLAGS = { AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_TENANT: "chiridion", AGENT_RUNTIME_DIRECT_THREADS: "1", AGENT_RUNTIME_MIGRATE_DO_THREADS: "1" };

  function fakeEnv(answer: DoMigrationResult, rows: Array<typeof ROW | null>, flags: Record<string, string> = FLAGS) {
    const getThreadRuntime = vi.fn(async () => rows.shift() ?? null);
    const org = {
      getThread: vi.fn(async () => ({ workspace_id: "ws1", created_by: "u1" })),
      getThreadRuntime,
      getMember: vi.fn(async () => ({ user_id: "u1", role: "member" })),
      getMembers: vi.fn(async () => []),
    };
    const thread = {
      migrateToRuntime: vi.fn(async () => answer),
      runtimeMigrationStatus: vi.fn(async () => ({ state: null })),
      relayRuntimeAgent: vi.fn(async () => null),
    };
    return {
      env: { ...flags, AGENT_RUNTIME_DEFINITION: "def_1", ORG: { idFromName: (n: string) => n, get: () => org }, CHAT_THREAD: { idFromName: (n: string) => n, get: () => thread } } as unknown as ChatEnv,
      getThreadRuntime,
      thread,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    directEnabledMock.mockReturnValue(true);
    routeMock.mockResolvedValue({ route: { provider: "openrouter" } });
  });

  it("moves the thread and answers its new row", async () => {
    const { env } = fakeEnv({ status: "migrated", row: ROW, archived: false, stats: {} } as never, [null]);
    expect(await migrateThreadOnSend(env, context)).toEqual(ROW);
  });

  it("waits for a move another request is making", async () => {
    vi.useFakeTimers();
    const { env } = fakeEnv({ status: "busy", reason: "moving" }, [null, null, ROW]);
    const row = migrateThreadOnSend(env, context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await row).toEqual(ROW);
  });

  it("moves every org's thread (the old cohort flag no longer limits it), and gives none while a move cannot finish", async () => {
    expect(await migrateThreadOnSend(fakeEnv({ status: "failed", error: "HTTP 503" }, [null]).env, context)).toBeNull();
    const anyOrg = fakeEnv({ status: "migrated", row: ROW, archived: false, stats: {} } as never, [null], { ...FLAGS, AGENT_RUNTIME_MIGRATE_DO_THREADS: "" });
    expect(await migrateThreadOnSend(anyOrg.env, context)).toEqual(ROW);
  });
});

describe("classifyMove", () => {
  const ROW = { threadId: "t1", agentId: "agt_1", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
  it("sorts every answer a move gives into what the page and a sender do with it", () => {
    expect(classifyMove({ status: "migrated", row: ROW, archived: false, stats: {} } as never)).toEqual({ state: "runtime", row: ROW });
    expect(classifyMove({ status: "busy", reason: "moving" })).toEqual({ state: "moving" });
    expect(classifyMove({ status: "failed", error: "HTTP 503", retryAt: 5_000 })).toEqual({ state: "retrying", retryAt: 5_000, error: "HTTP 503" });
    // A backoff after a transient failure is retried, with when.
    expect(classifyMove({ status: "skipped", reason: "backoff: HTTP 503", retryAt: 9_000 })).toEqual({ state: "retrying", retryAt: 9_000, error: "HTTP 503" });
    // A model that did not resolve just now (a provider setting being changed) is retried, not read-only.
    expect(classifyMove({ status: "skipped", reason: "its model did not resolve: timeout" })).toMatchObject({ state: "retrying", retryAt: null });
    // A history the runtime refuses every time, backing off or not, and a model with no route: read-only.
    expect(classifyMove({ status: "skipped", reason: "too_large" })).toEqual({ state: "readonly", reason: "too_large" });
    expect(classifyMove({ status: "skipped", reason: "backoff: too_large: HTTP 413" })).toEqual({ state: "readonly", reason: "too_large" });
    expect(classifyMove({ status: "skipped", reason: "backoff: invalid_history: bad" })).toEqual({ state: "readonly", reason: "invalid_history" });
    expect(classifyMove({ status: "skipped", reason: "no runtime route for its model" })).toEqual({ state: "readonly", reason: "no_route" });
    expect(classifyMove({ status: "skipped", reason: "no_route: switch models" })).toEqual({ state: "readonly", reason: "no_route" });
    // What chiridion must set up first: blocked, saying what.
    expect(classifyMove({ status: "skipped", reason: "not_configured: Hosted models are not configured for the agent runtime." }))
      .toEqual({ state: "blocked", code: "not_configured", message: "Hosted models are not configured for the agent runtime." });
    expect(classifyMove({ status: "skipped", reason: "usage_limit: LLM usage limit reached." })).toMatchObject({ state: "blocked", code: "usage_limit" });
    expect(classifyMove({ status: "skipped", reason: "the agent runtime is not configured" })).toMatchObject({ state: "blocked", code: "not_configured" });
    // "moved" read between the row read and the DO's answer: the caller re-reads the row.
    expect(classifyMove({ status: "skipped", reason: "moved" })).toEqual({ state: "gone", reason: "moved" });
  });
});

describe("a person retrying a move", () => {
  const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
  const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
  function env(status: { state: string; retryAt?: number; error?: string }) {
    const chat = {
      runtimeMigrationStatus: vi.fn(async () => status),
      clearRuntimeMigrationBackoff: vi.fn(async () => true),
      migrateToRuntime: vi.fn(async () => ({ status: "migrated", row: ROW, archived: false, stats: {} })),
    };
    const org = {
      getThread: vi.fn(async () => ({ workspace_id: "ws1", created_by: "u1" })),
      getThreadRuntime: vi.fn(async () => null),
      getMember: vi.fn(async () => ({ user_id: "u1", role: "member" })),
      getMembers: vi.fn(async () => []),
    };
    return {
      chat,
      env: { AGENT_RUNTIME_DEFINITION: "def_1", ORG: { idFromName: (n: string) => n, get: () => org }, CHAT_THREAD: { idFromName: (n: string) => n, get: () => chat } } as unknown as ChatEnv,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    directEnabledMock.mockReturnValue(true);
    routeMock.mockResolvedValue({ route: { kind: "scope", model: "openrouter/x", keyScope: "hosted" }, threadModel: "x", llmProviderRecord: null });
  });

  it("ends a transient backoff and moves the thread at once", async () => {
    const { env: moveEnv, chat } = env({ state: "backoff", retryAt: Date.now() + 60_000, error: "HTTP 503" });
    expect(await migrateThreadToRuntime(moveEnv, context, { retryBackoff: true })).toMatchObject({ status: "migrated" });
    expect(chat.clearRuntimeMigrationBackoff).toHaveBeenCalledOnce();
  });

  it("keeps a backoff when nobody asked, or when the runtime refuses the history every time", async () => {
    const at = Date.now() + 60_000;
    const timer = env({ state: "backoff", retryAt: at, error: "HTTP 503" });
    expect(await migrateThreadToRuntime(timer.env, context)).toEqual({ status: "skipped", reason: "backoff: HTTP 503", retryAt: at });
    expect(timer.chat.clearRuntimeMigrationBackoff).not.toHaveBeenCalled();
    const refused = env({ state: "backoff", retryAt: at, error: "too_large: HTTP 413" });
    expect(await migrateThreadToRuntime(refused.env, context, { retryBackoff: true })).toMatchObject({ status: "skipped", reason: "backoff: too_large: HTTP 413" });
    expect(refused.chat.clearRuntimeMigrationBackoff).not.toHaveBeenCalled();
    expect(refused.chat.migrateToRuntime).not.toHaveBeenCalled();
  });
});

describe("moveThreadForSend", () => {
  const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
  const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
  function env(answer: DoMigrationResult, rows: Array<typeof ROW | null>) {
    const org = {
      getThread: vi.fn(async () => ({ workspace_id: "ws1", created_by: "u1" })),
      getThreadRuntime: vi.fn(async () => rows.shift() ?? null),
      getMember: vi.fn(async () => ({ user_id: "u1", role: "member" })),
      getMembers: vi.fn(async () => []),
    };
    const chat = { migrateToRuntime: vi.fn(async () => answer), runtimeMigrationStatus: vi.fn(async () => ({ state: null })) };
    return { AGENT_RUNTIME_DEFINITION: "def_1", ORG: { idFromName: (n: string) => n, get: () => org }, CHAT_THREAD: { idFromName: (n: string) => n, get: () => chat } } as unknown as ChatEnv;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    directEnabledMock.mockReturnValue(true);
    routeMock.mockResolvedValue({ route: { kind: "scope", model: "openrouter/x", keyScope: "hosted" }, threadModel: "x", llmProviderRecord: null });
  });

  it("says a thread that can never move is read-only, so its sender re-homes it", async () => {
    expect(await moveThreadForSend(env({ status: "skipped", reason: "too_large" }, [null]), context))
      .toEqual({ row: null, outcome: { state: "readonly", reason: "too_large" } });
  });

  it("re-reads the row when the move says it moved meanwhile", async () => {
    // The first read (before the move) finds none; the move says "moved"; the re-read finds it.
    expect(await moveThreadForSend(env({ status: "skipped", reason: "moved" }, [null, ROW]), context)).toEqual({ row: ROW });
  });
});
