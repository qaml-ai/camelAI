/**
 * ChatThreadDO's side of moving a thread to the agent runtime: the move the
 * DO drives (chat-thread/runtime-migration.ts) and the turn guard.
 *
 * Run with: bun run test:workers
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtimeApiMock } = vi.hoisted(() => ({ runtimeApiMock: vi.fn() }));
vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));
vi.mock("../src/agent-runtime/run-gates.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeSystemPromptAppend: () => "append",
}));

import { ChatThreadDO } from "../src/chat-thread-do";
import {
  ChatThreadRuntimeMigration,
  RUNTIME_MIGRATION_KEY,
  RUNTIME_MIGRATION_LEASE_MS,
  migrationBackoffMs,
  type RuntimeMigrationRecord,
} from "../src/chat-thread/runtime-migration";
import { ARCHIVE_PATH, MAX_IMPORT_BYTES, MAX_TOOL_RESULT_CHARS } from "../src/agent-runtime/thread-migration";

const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
const user = (text: string, timestamp = 1) => ({ role: "user", content: text, timestamp });

function harness() {
  const store = new Map<string, unknown>();
  const state = {
    busy: null as string | null,
    relay: false,
    revision: { generation: 1, count: 1 },
    history: [user("hi")] as unknown[],
    whole: true,
  };
  const org = {
    setThreadUiState: vi.fn(async () => ({})),
    claimThreadRuntimeAgent: vi.fn(async (_threadId: string, agentId: string) => ({ row: { ...ROW, agentId }, claimed: true })),
    getThreadRuntime: vi.fn(async () => null as typeof ROW | null),
  };
  const alarms: number[] = [];
  const pending: Promise<unknown>[] = [];
  const loadHistory = vi.fn(async (_maxChars: number) => ({ messages: state.history as never[], whole: state.whole }));
  const migration = new ChatThreadRuntimeMigration({
    env: {
      AGENT_RUNTIME_URL: "https://runtime.test",
      AGENT_RUNTIME_API_TOKEN: "operator",
      AGENT_RUNTIME_DEFINITION: "def_1",
      ORG: { idFromName: (name: string) => name, get: () => org },
    } as never,
    kv: { get: <T>(key: string) => store.get(key) as T | undefined, put: (key, value) => { store.set(key, structuredClone(value)); } },
    busyReason: () => state.busy,
    hasRelayAgent: () => state.relay,
    revision: () => state.revision,
    loadHistory,
    payloadBatches: function* () { yield ['{"role":"user","content":"hi"}']; yield ['{"role":"assistant"}']; },
    preview: () => ({ tabs: [{ kind: "app", scriptName: "shop", isPublic: true } as never], activeTabId: "app:shop" }),
    scheduleAlarm: (at) => { alarms.push(at); },
    waitUntil: (promise) => { pending.push(promise); },
  });
  const record = () => store.get(RUNTIME_MIGRATION_KEY) as RuntimeMigrationRecord | undefined;
  const settle = () => Promise.all(pending.splice(0));
  return { store, state, org, alarms, migration, record, settle, loadHistory };
}

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[];
let createResponse: () => Promise<Response>;

function creates(): FetchCall[] {
  return fetchCalls.filter((call) => call.init.method === "POST");
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeApiMock.mockResolvedValue(null);
  fetchCalls = [];
  createResponse = async () => new Response(JSON.stringify({ id: "agt_new" }), { status: 201 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    fetchCalls.push(call);
    if (call.init.method === "POST") return await createResponse();
    return new Response("{}", { status: 201 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ChatThreadRuntimeMigration", () => {
  it("moves a thread: an agent with its history, its preview tabs, the row claimed, then final", async () => {
    const h = harness();
    const result = await h.migration.migrate({ context, subject: "u1" });
    expect(result).toMatchObject({ status: "migrated", row: ROW, archived: false });
    const [create] = creates();
    expect(create.url).toBe("https://runtime.test/v1/agents");
    const body = JSON.parse(String(create.init.body));
    expect(body).toMatchObject({ definition: "def_1", name: "t1", subject: "u1", ttlSeconds: null, context: { org: "org1", workspace: "ws1", thread: "t1" } });
    expect(body.initialMessages[0].content).toContain("moved here from camelAI's previous chat engine");
    expect(body.initialMessages[1]).toEqual(user("hi"));
    expect((create.init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^migrate_t1_[0-9a-f]{16}$/);
    expect(h.org.setThreadUiState).toHaveBeenCalledWith("t1", { tabs: [{ kind: "app", scriptName: "shop", isPublic: true }], activeTabId: "app:shop" });
    expect(h.org.claimThreadRuntimeAgent).toHaveBeenCalledWith("t1", "agt_new");
    expect(h.record()).toMatchObject({ phase: "moved", agentId: "agt_new" });
    expect(h.migration.state()).toBe("moved");
    expect(h.alarms).toHaveLength(1);
    expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "skipped", reason: "moved" });
  });

  it("holds the thread while it moves", async () => {
    const h = harness();
    let release!: () => void;
    createResponse = () => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ id: "agt_new" }), { status: 201 })); });
    const moving = h.migration.migrate({ context, subject: "u1" });
    await vi.waitFor(() => expect(creates()).toHaveLength(1));
    expect(h.migration.state()).toBe("moving");
    expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "busy", reason: "moving" });
    release();
    expect(await moving).toMatchObject({ status: "migrated" });
  });

  describe("race with a turn (blocker 1)", () => {
    it("does not commit when a turn started after the export, and lets the thread run here", async () => {
      const h = harness();
      h.loadHistory.mockImplementation(async () => {
        h.state.busy = "running";
        return { messages: h.state.history as never[], whole: true };
      });
      expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "busy", reason: "running" });
      await h.settle();
      expect(h.org.claimThreadRuntimeAgent).not.toHaveBeenCalled();
      expect(runtimeApiMock).toHaveBeenCalledWith(expect.anything(), "DELETE", "/v1/agents/agt_new");
      expect(h.record()).toMatchObject({ phase: "failed" });
      expect(h.migration.state()).toBeNull();
    });

    it("does not commit when the transcript changed since the lease began", async () => {
      const h = harness();
      h.loadHistory.mockImplementation(async () => {
        h.state.revision = { generation: 2, count: 3 };
        return { messages: h.state.history as never[], whole: true };
      });
      expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "busy", reason: "the thread changed while it was moving" });
      expect(h.org.claimThreadRuntimeAgent).not.toHaveBeenCalled();
      expect(h.migration.state()).toBeNull();
    });
  });

  describe("split brain (blocker 2)", () => {
    it("undoes a move whose lease ran out, and a late finish of it commits nothing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      let release!: () => void;
      createResponse = () => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify({ id: "agt_new" }), { status: 201 })); });
      const moving = h.migration.migrate({ context, subject: "u1" });
      await vi.waitFor(() => expect(creates()).toHaveLength(1));
      vi.setSystemTime(Date.now() + RUNTIME_MIGRATION_LEASE_MS + 1);
      await h.migration.onAlarm();
      expect(h.record()).toMatchObject({ phase: "failed", error: "the move's lease ran out" });
      expect(h.migration.state()).toBeNull();
      release();
      expect(await moving).toEqual({ status: "failed", error: "the move's lease ran out" });
      expect(h.org.claimThreadRuntimeAgent).not.toHaveBeenCalled();
    });

    it("never lets a commit expire: a failed row write keeps the thread held until the alarm finishes it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      h.org.claimThreadRuntimeAgent.mockRejectedValueOnce(new Error("OrgDO reset"));
      h.org.getThreadRuntime.mockRejectedValueOnce(new Error("OrgDO reset"));
      const result = await h.migration.migrate({ context, subject: "u1" });
      expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("commit is pending") });
      vi.setSystemTime(Date.now() + 10 * RUNTIME_MIGRATION_LEASE_MS);
      expect(h.record()).toMatchObject({ phase: "committing", agentId: "agt_new" });
      expect(h.migration.state()).toBe("moving");
      expect(h.alarms.length).toBeGreaterThanOrEqual(2);
      await h.migration.onAlarm();
      expect(h.record()).toMatchObject({ phase: "moved", agentId: "agt_new" });
      expect(runtimeApiMock).not.toHaveBeenCalledWith(expect.anything(), "DELETE", expect.anything());
    });

    it("keeps the agent a thread already has: the row is claimed compare-and-set, the spare agent deleted", async () => {
      const h = harness();
      h.org.claimThreadRuntimeAgent.mockResolvedValueOnce({ row: { ...ROW, agentId: "agt_first" }, claimed: false });
      expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "runtime", row: { ...ROW, agentId: "agt_first" } });
      await h.settle();
      expect(runtimeApiMock).toHaveBeenCalledWith(expect.anything(), "DELETE", "/v1/agents/agt_new");
      expect(h.record()).toMatchObject({ phase: "moved", agentId: "agt_first" });
    });
  });

  describe("ambiguous row write (blocker 6)", () => {
    it("reads the row back: a write that landed commits, and the agent is kept", async () => {
      const h = harness();
      h.org.claimThreadRuntimeAgent.mockRejectedValueOnce(new Error("network lost after write"));
      h.org.getThreadRuntime.mockResolvedValueOnce(ROW);
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "migrated", row: ROW });
      await h.settle();
      expect(runtimeApiMock).not.toHaveBeenCalledWith(expect.anything(), "DELETE", expect.anything());
      expect(h.record()).toMatchObject({ phase: "moved" });
    });
  });

  describe("idempotency (blocker 5)", () => {
    it("sends the same import under the same key on every attempt, whenever it runs", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      h.state.history = [user("hi", 5), { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 6 }];
      createResponse = async () => new Response("unavailable", { status: 500 });
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "failed" });
      vi.setSystemTime(Date.now() + migrationBackoffMs(1) + 1);
      createResponse = async () => new Response(JSON.stringify({ id: "agt_new" }), { status: 201 });
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "migrated" });
      const [first, second] = creates();
      expect(second.init.body).toBe(first.init.body);
      expect((second.init.headers as Record<string, string>)["Idempotency-Key"]).toBe((first.init.headers as Record<string, string>)["Idempotency-Key"]);
    });

    it("deletes the agent a failed attempt made before the next attempt makes one", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      h.loadHistory.mockImplementationOnce(async () => {
        h.state.busy = "running";
        return { messages: h.state.history as never[], whole: true };
      });
      runtimeApiMock.mockRejectedValueOnce(new Error("runtime down"));
      await h.migration.migrate({ context, subject: "u1" });
      await h.settle();
      expect(h.record()).toMatchObject({ phase: "failed", orphanAgentId: "agt_new" });
      h.state.busy = null;
      vi.setSystemTime(Date.now() + migrationBackoffMs(1) + 1);
      runtimeApiMock.mockResolvedValue(null);
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "migrated" });
      expect(runtimeApiMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("backoff (11)", () => {
    it("waits out a failed attempt before trying again", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = harness();
      createResponse = async () => new Response("unavailable", { status: 500 });
      await h.migration.migrate({ context, subject: "u1" });
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "skipped", reason: expect.stringContaining("backoff") });
      expect(creates()).toHaveLength(1);
      vi.setSystemTime(Date.now() + migrationBackoffMs(1) + 1);
      await h.migration.migrate({ context, subject: "u1" });
      expect(creates()).toHaveLength(2);
      expect(h.record()).toMatchObject({ phase: "failed", failures: 2 });
      expect(migrationBackoffMs(2)).toBe(2 * migrationBackoffMs(1));
    });
  });

  describe("size (blocker 4)", () => {
    it("refuses a history not even whose newest turn fits, without making an agent", async () => {
      const h = harness();
      h.state.history = [{ role: "user", content: [{ type: "image", data: "A".repeat(MAX_IMPORT_BYTES + 1), mimeType: "image/png" }], timestamp: 1 }];
      expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "skipped", reason: "too_large" });
      expect(creates()).toHaveLength(0);
      expect(h.migration.state()).toBeNull();
      expect(h.loadHistory).toHaveBeenCalledWith(12_000_000);
    });

    it("archives the whole original, streamed from storage, when the import is not all of it", async () => {
      const h = harness();
      h.state.whole = false;
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "migrated", archived: true });
      const archive = fetchCalls.find((call) => call.init.method === "PUT")!;
      expect(archive.url).toBe("https://runtime.test/v1/agents/agt_new/uploads/camel-migration/original-transcript.jsonl");
      expect(await new Response(archive.init.body as ReadableStream).text()).toBe('{"role":"user","content":"hi"}\n{"role":"assistant"}\n');
      const note = JSON.parse(String(creates()[0].init.body)).initialMessages[0];
      expect(note.content).toContain(ARCHIVE_PATH);
    });

    it("archives when a tool result was shortened", async () => {
      const h = harness();
      h.state.history = [
        { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }], timestamp: 1 },
        { role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "z".repeat(MAX_TOOL_RESULT_CHARS + 1) }], isError: false, timestamp: 2 },
      ];
      expect(await h.migration.migrate({ context, subject: "u1" })).toMatchObject({ status: "migrated", archived: true });
    });
  });

  it("waits out a running turn, and points a relay thread at adoption", async () => {
    const h = harness();
    h.state.busy = "question";
    expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "busy", reason: "question" });
    h.state.busy = null;
    h.state.relay = true;
    expect(await h.migration.migrate({ context, subject: "u1" })).toEqual({ status: "relay" });
    expect(h.record()).toBeUndefined();
  });

  it("reports a dry run without holding the thread or making anything", async () => {
    const h = harness();
    expect(await h.migration.migrate({ context, subject: "u1", dryRun: true })).toMatchObject({ status: "dry_run", lossy: false, stats: { total: 1, imported: 1 } });
    expect(creates()).toHaveLength(0);
    expect(h.record()).toBeUndefined();
  });
});

type Fake = Record<string, unknown> & { store: Map<string, unknown> };

function fakeThread(): Fake {
  const store = new Map<string, unknown>();
  const fake = Object.create(ChatThreadDO.prototype) as Fake;
  fake.store = store;
  fake.ctx = { storage: { kv: { get: (key: string) => store.get(key), put: (key: string, value: unknown) => { store.set(key, value); }, delete: (key: string) => store.delete(key) } }, waitUntil: () => {} };
  fake.env = { APP_KV: { get: async () => null } };
  fake.chatContext = { ...context };
  fake.isThreadStreaming = () => false;
  fake.applyMentionsForTurn = async (content: string) => content;
  fake.sendRunnerCommand = vi.fn(() => true);
  return fake;
}

const call = <T>(fake: Fake, method: string, ...args: unknown[]): Promise<T> =>
  Promise.resolve((ChatThreadDO.prototype as unknown as Record<string, (...a: unknown[]) => T>)[method].call(fake, ...args));

const leased = (): RuntimeMigrationRecord => ({
  phase: "leased", leaseId: "lease-1", startedAt: Date.now(), expiresAt: Date.now() + RUNTIME_MIGRATION_LEASE_MS, revision: { generation: 1, count: 1 }, failures: 0,
});

describe("ChatThreadDO turn guard", () => {
  it("refuses a message when a move began while it was being prepared (blocker 1)", async () => {
    const fake = fakeThread();
    // The move begins during the send's first await (the org ban check).
    fake.env = { APP_KV: { get: async () => { fake.store.set(RUNTIME_MIGRATION_KEY, leased()); return null; } } };
    expect(await call(fake, "enqueueRunnerUserMessage", { type: "message", content: "hello" }))
      .toEqual({ status: "busy", error: "This conversation is moving; try again in a moment." });
    expect(fake.sendRunnerCommand).not.toHaveBeenCalled();
  });

  it("refuses turns while a move commits, and for good once moved", async () => {
    const fake = fakeThread();
    fake.store.set(RUNTIME_MIGRATION_KEY, { phase: "committing", leaseId: "l", agentId: "a", orgId: "org1", threadId: "t1", previewTabs: [], previewActiveTabId: null, attempts: 0 });
    expect(await call(fake, "enqueueRunnerUserMessage", { type: "message", content: "hello" })).toMatchObject({ status: "busy" });
    fake.store.set(RUNTIME_MIGRATION_KEY, { phase: "moved", leaseId: "l", agentId: "a", movedAt: 1 });
    expect(await call(fake, "enqueueRunnerUserMessage", { type: "message", content: "hello" }))
      .toEqual({ status: "error", error: "This conversation moved; reload the page to continue it." });
    expect(fake.sendRunnerCommand).not.toHaveBeenCalled();
  });

  it("starts no turn on a moved thread from any path", async () => {
    const moved = fakeThread();
    delete moved.sendRunnerCommand;
    moved.store.set(RUNTIME_MIGRATION_KEY, { phase: "moved", leaseId: "l", agentId: "a", movedAt: 1 });
    expect(await call(moved, "sendRunnerCommand", { type: "message", content: "hello" })).toBe(false);
  });

  it("does not fork a moved thread from its stale transcript", async () => {
    const fake = fakeThread();
    fake.store.set(RUNTIME_MIGRATION_KEY, { phase: "moved", leaseId: "l", agentId: "a", movedAt: 1 });
    expect(await call(fake, "getPiCoreForkMessages", { forkEntryId: "x" })).toMatchObject({ success: false, code: "THREAD_MOVED" });
  });
});
