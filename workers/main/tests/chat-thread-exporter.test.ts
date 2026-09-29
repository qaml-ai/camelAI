/**
 * ChatThreadDO as a read-only exporter: a thread written in the old in-DO
 * loop's storage format (tests/fixtures/chat-thread-storage-2026-09.json,
 * dumped from a ChatThreadDO of the last release that ran the loop) moves to
 * the agent runtime, whole and each message once; and a turn, a send or a
 * connection is answered "moved".
 *
 * Run with: bun run test:workers
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import fixture from "./fixtures/chat-thread-storage-2026-09.json";
import { RUNTIME_MIGRATION_KEY } from "../src/chat-thread/runtime-migration";

type FixtureTable = { schema: string; rows: Array<Record<string, unknown>> };
const tables = fixture.tables as unknown as Record<string, FixtureTable>;
const kv = fixture.kv as Record<string, unknown>;
const THREAD = "fixture-thread";
const context = { threadId: THREAD, workspaceId: "ws_fixture", orgId: "org_fixture", userId: "user_fixture", userName: "Ada", userEmail: "ada@example.com" };
const agentModel = { model: "openrouter/anthropic/claude-sonnet-5", keyScope: "hosted", modelHeaders: null, thinkingLevel: "medium" as const };

const namespace = () => (env as unknown as { CHAT_THREAD: DurableObjectNamespace }).CHAT_THREAD;

/** Write the fixture into a fresh ChatThreadDO's storage, as the old loop left it. */
function restore(state: DurableObjectState): void {
  const sql = state.storage.sql;
  for (const [name, table] of Object.entries(tables)) {
    sql.exec(table.schema);
    for (const row of table.rows) {
      const columns = Object.keys(row);
      sql.exec(
        `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...columns.map((column) => row[column] as SqlStorageValue),
      );
    }
  }
  for (const [key, value] of Object.entries(kv)) state.storage.kv.put(key, value);
}

function counts(state: DurableObjectState) {
  const one = (sql: string) => Number(state.storage.sql.exec<{ n: number }>(sql).toArray()[0]?.n ?? 0);
  return {
    rows: one("SELECT COUNT(*) AS n FROM pi_core_messages"),
    chars: one("SELECT COALESCE(SUM(length(payload)), 0) AS n FROM pi_core_messages"),
    render: one("SELECT COUNT(*) AS n FROM cf_ai_chat_agent_messages"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ChatThreadDO exporter: a thread in today's storage format", () => {
  it("moves the whole thread to the runtime, each message once, and changes none of its rows", async () => {
    const stub = namespace().get(namespace().idFromName(THREAD));
    const creates: unknown[] = [];
    const archives: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/v1/agents")) {
        creates.push(JSON.parse(await new Response(init.body as BodyInit).text()));
        return Response.json({ id: "agt_moved" }, { status: 201 });
      }
      if (init?.method === "PUT" && url.includes("/uploads/")) {
        archives.push(await new Response(init.body as BodyInit).text());
        return Response.json({}, { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const org = {
      claimThreadRuntimeAgent: vi.fn(async (threadId: string, agentId: string) => ({
        row: { threadId, agentId, model: agentModel.model, keyScope: "hosted", configured: null, createdAt: 1, updatedAt: 1 },
        claimed: true,
      })),
      getThreadRuntime: vi.fn(async () => null),
      setThreadUiState: vi.fn(async () => ({})),
    };

    await runInDurableObject(stub, async (instance: any, state: DurableObjectState) => {
      restore(state);
      const before = counts(state);
      expect(before.rows).toBe(21);
      expect(before.render).toBe(20);

      // The move runs against a runtime and an OrgDO the test answers for.
      instance.env = {
        ...instance.env,
        AGENT_RUNTIME_URL: "https://runtime.test",
        AGENT_RUNTIME_API_TOKEN: "operator",
        AGENT_RUNTIME_TENANT: "chiridion",
        AGENT_RUNTIME_DEFINITION: "def_1",
        ORG: { idFromName: (name: string) => name, get: () => org },
      };
      instance.migrationInstance = null;
      instance.storeInstance = null;

      // The fixture's earlier attempt failed and backed off; its backoff is over.
      expect(await instance.runtimeMigrationStatus()).toEqual({ state: null });
      expect(instance.runtimeMigrationSize()).toEqual({ rows: before.rows, chars: before.chars });

      const result = await instance.migrateToRuntime({ context, subject: "user_fixture", agentModel });
      expect(result).toMatchObject({ status: "migrated", archived: true, row: { agentId: "agt_moved" } });

      // Nothing in the thread's own storage changed: the exporter only reads it.
      expect(counts(state)).toEqual(before);
      expect(state.storage.kv.get(RUNTIME_MIGRATION_KEY)).toMatchObject({ phase: "moved", agentId: "agt_moved" });
      expect(await instance.runtimeMigrationStatus()).toEqual({ state: "moved" });
    });

    // The agent: made with the thread's model, for its creator, with the whole history.
    expect(creates).toHaveLength(1);
    const created = creates[0] as { model: string; subject: string; context: Record<string, string>; initialMessages: Array<Record<string, unknown>> };
    expect(created).toMatchObject({ model: agentModel.model, subject: "user_fixture", context: { org: "org_fixture", workspace: "ws_fixture", thread: THREAD } });
    const messages = created.initialMessages;
    const text = (message: Record<string, unknown>) => JSON.stringify(message.content ?? message.summary ?? "");
    // Every question and answer, the ones only the render archive kept (0 to 7)
    // and the ones pi_core holds (8 to 12), exactly once, in order.
    for (let index = 0; index <= 12; index++) {
      const asked = messages.filter((message) => message.role === "user" && new RegExp(`question ${index}\\b`).test(text(message)));
      const answered = messages.filter((message) => message.role === "assistant" && text(message).includes(`answer ${index}"`));
      expect(asked, `question ${index}`).toHaveLength(1);
      expect(answered, `answer ${index}`).toHaveLength(1);
    }
    const order = messages
      .map((message) => /question (\d+)/.exec(text(message))?.[1])
      .filter((index): index is string => index !== undefined)
      .map(Number);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The model's view: the last compaction's summary, then the move's note, then what it kept.
    const summaries = messages.filter((message) => message.role === "compactionSummary");
    expect(summaries.at(-1)?.summary).toBe("Earlier: questions 0 to 10 about doubling numbers.");
    const lastSummary = messages.lastIndexOf(summaries.at(-1)!);
    expect(text(messages[lastSummary + 1])).toContain("moved here from camelAI's previous chat engine");
    expect(text(messages[lastSummary + 2])).toContain("question 11");
    // Tool calls keep their results; thinking arrives unsigned.
    const calls = messages.flatMap((message) => (Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []))
      .filter((block) => block.type === "toolCall");
    const results = new Set(messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId));
    expect(calls.length).toBeGreaterThanOrEqual(13);
    for (const call of calls) expect(results.has(call.id)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("thinkingSignature");

    // The whole original is archived in the agent's workspace: every stored row, then the render archive.
    expect(archives).toHaveLength(1);
    const lines = archives[0].trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((line) => !("archivedRenderMessage" in line))).toHaveLength(21);
    expect(lines.filter((line) => "archivedRenderMessage" in line).length).toBeGreaterThan(0);

    // The row is claimed with what the agent was made with, and the preview tabs move to OrgDO.
    expect(org.claimThreadRuntimeAgent).toHaveBeenCalledWith(THREAD, "agt_moved", expect.objectContaining({ model: agentModel.model }));
    await vi.waitFor(() => expect(org.setThreadUiState).toHaveBeenCalledWith(THREAD, {
      tabs: [{ kind: "app", scriptName: "shop", isPublic: false }],
      activeTabId: "app:shop",
    }));
  }, 60_000);

  it("shows a thread that cannot move read-only: its history, bounded, without the model's summaries", async () => {
    const stub = namespace().get(namespace().idFromName(`${THREAD}-readonly`));
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => restore(state));
    const history = await (stub as unknown as {
      readOnlyHistory(threadId: string): Promise<{ messages: Array<{ role: string; content: unknown }>; truncated: boolean }>;
    }).readOnlyHistory(THREAD);
    expect(history.truncated).toBe(false);
    const all = JSON.stringify(history.messages);
    for (let index = 0; index <= 12; index++) expect(all).toContain(`question ${index}`);
    expect(all).not.toContain("[Context Summary]");
  }, 60_000);
});

describe("ChatThreadDO: turns, sends and connections answer moved", () => {
  it("answers a turn, a send and the old transport with moved (410)", async () => {
    const stub = namespace().get(namespace().idFromName("moved-thread")) as unknown as DurableObjectStub & {
      startInitialUserMessage(request: unknown): Promise<{ status: string; error?: string }>;
      sendMessage(input: unknown): Promise<{ status: string; error?: string }>;
    };
    expect(await stub.startInitialUserMessage({ message: "hello", threadId: "moved-thread" })).toMatchObject({ status: "moved" });
    expect(await stub.sendMessage({ content: "hello" })).toMatchObject({ status: "moved" });

    const direct = await stub.fetch("https://do/agents/chat-thread/moved-thread/sse?transport=poll");
    expect(direct.status).toBe(410);
    expect(await direct.json()).toMatchObject({ status: "moved" });

    for (const [path, init] of [
      ["/agents/chat-thread/moved-thread", { headers: { Upgrade: "websocket" } }],
      ["/agents/chat-thread/moved-thread/sse", {}],
    ] as const) {
      const response = await SELF.fetch(`https://camelai.test${path}`, init);
      expect(response.status, path).toBe(410);
      expect(await response.json()).toMatchObject({ status: "moved" });
    }
  });
});
