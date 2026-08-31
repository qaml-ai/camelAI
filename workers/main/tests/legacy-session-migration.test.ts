import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import { DurableChatTurnStore } from "../src/chat-thread/durable-turn-store";
import {
  LegacySessionMigrator,
  legacyMigrationBlocksClaim,
} from "../src/chat-thread/legacy-session-migration";

const stub = (name: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(`legacy-migration-${name}`));
};

const scope = {
  threadId: "thread:test",
  workspaceId: "workspace:test",
  orgId: "org:test",
};

function admit(store: DurableChatTurnStore, id = "current", now = 10_000) {
  return store.admit(
    {
      id,
      clientMessageId: id,
      ...scope,
      userId: "user:test",
      source: "web",
      userContent: "continue the old thread",
      userDisplay: "continue the old thread",
    },
    now,
  );
}

function seedPi(
  instance: any,
  messages: readonly Record<string, unknown>[],
): void {
  instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
    idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  for (const [index, message] of messages.entries()) {
    instance.ctx.storage.sql.exec(
      `INSERT INTO pi_core_messages (idx, payload, created_at)
       VALUES (?, ?, ?)`,
      index,
      JSON.stringify(message),
      typeof message.timestamp === "number" ? message.timestamp : index + 1,
    );
  }
}

function seedAiChat(
  instance: any,
  messages: readonly Record<string, unknown>[],
): void {
  instance.ctx.storage.sql.exec(`CREATE TABLE cf_ai_chat_agent_messages (
    id TEXT PRIMARY KEY, message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const [index, message] of messages.entries()) {
    instance.ctx.storage.sql.exec(
      `INSERT INTO cf_ai_chat_agent_messages (id, message, created_at)
       VALUES (?, ?, ?)`,
      String(message.id ?? `message-${index}`),
      JSON.stringify(message),
      index + 1,
    );
  }
}

function importedCount(instance: any): number {
  return Number(
    instance.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM chat_turns_v2
          WHERE source = 'legacy_migration'`,
      )
      .one().count,
  );
}

describe("bounded just-in-time legacy session migration", () => {
  it("starts after authenticated open and leaves a permanent read-only terminal marker", async () => {
    await runInDurableObject(stub("open"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "old question", timestamp: 1 },
        { role: "assistant", content: "old answer", timestamp: 2 },
      ]);
      const sourceBefore = instance.ctx.storage.sql
        .exec<{
          idx: number;
          payload: string;
        }>("SELECT idx, payload FROM pi_core_messages ORDER BY idx")
        .toArray();
      const revisionBefore = store.latestSnapshot().revision;
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 101,
      );

      expect(
        await migrator.runAfterTrigger(100, "before-trigger"),
      ).toMatchObject({
        state: "unseen",
        attemptCount: 0,
      });
      expect(
        instance.ctx.storage.sql
          .exec<{ present: number }>(
            `SELECT EXISTS(
               SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'chat_legacy_migration_v2'
             ) AS present`,
          )
          .one().present,
      ).toBe(0);

      expect(migrator.requestAfterOpen(scope, 100)).toMatchObject({
        state: "pending",
        attemptCount: 0,
        deadlineAt: 100 + CHAT_RUNTIME_BOUNDS.legacyMigrationDeadlineMs,
      });
      expect(migrator.claimBlocked()).toBe(true);
      expect(store.latestSnapshot().revision).toBeGreaterThan(revisionBefore);

      expect(await migrator.runAfterTrigger(100, "open-attempt")).toMatchObject(
        {
          state: "complete",
          importedTurns: 1,
          source: "pi_core",
        },
      );
      expect(migrator.claimBlocked()).toBe(false);
      expect(store.getTurn("legacy:pi:0")).toMatchObject({
        userContent: "old question",
        assistantFinal: "old answer",
      });
      expect(
        instance.ctx.storage.sql
          .exec("SELECT idx, payload FROM pi_core_messages ORDER BY idx")
          .toArray(),
      ).toEqual(sourceBefore);

      instance.ctx.storage.sql.exec(
        "UPDATE pi_core_messages SET payload = 'not json'",
      );
      expect(await migrator.runAfterTrigger(200, "never-reread")).toMatchObject(
        {
          state: "complete",
          importedTurns: 1,
          changed: false,
        },
      );
    });
  });

  it("imports settled Pi turns with only exactly closed tool batches", async () => {
    await runInDurableObject(stub("pi-tools"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "first", timestamp: 1 },
        { role: "assistant", content: "first answer", timestamp: 2 },
        { role: "user", content: "inspect both", timestamp: 3 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "working" },
            { type: "toolCall", id: "a", name: "read_file" },
            { type: "toolCall", id: "b", name: "read_file" },
          ],
          timestamp: 4,
        },
        { role: "toolResult", toolCallId: "a", toolName: "read_file" },
        { role: "toolResult", toolCallId: "b", toolName: "read_file" },
        { role: "assistant", content: "both are sound", timestamp: 7 },
        { role: "user", content: "unfinished", timestamp: 8 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "open", name: "deploy" }],
          timestamp: 9,
        },
      ]);
      const admitted = admit(store);
      const deadline = admitted.ok ? admitted.turn.terminalDeadlineAt : null;
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      expect(legacyMigrationBlocksClaim(store.sql)).toBe(true);
      expect(
        await migrator.runAfterTrigger(10_000, "pi-attempt"),
      ).toMatchObject({
        state: "complete",
        attemptCount: 1,
        importedTurns: 2,
        source: "pi_core",
      });
      expect(store.getTurn("legacy:pi:0")?.assistantFinal).toBe("first answer");
      expect(store.getTurn("legacy:pi:2")?.assistantFinal).toBe(
        "working\n\nboth are sound",
      );
      expect(store.getTurn("legacy:pi:7")).toBeNull();
      expect(store.getTurn("current")).toMatchObject({
        status: "queued",
        attemptCount: 0,
        terminalDeadlineAt: deadline,
      });
      expect(legacyMigrationBlocksClaim(store.sql)).toBe(false);
    });
  });

  it("folds a settled Pi streaming follow-up into its original turn", async () => {
    await runInDurableObject(stub("pi-followup"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "initial request", timestamp: 1 },
        { role: "assistant", content: "working", timestamp: 2 },
        {
          role: "user",
          content: "[Miguel]: changed requirement",
          metadata: { sentDuringStreaming: true },
          timestamp: 3,
        },
        { role: "assistant", content: "finished", timestamp: 4 },
      ]);
      admit(store);
      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "pi-followup-attempt"),
      ).toMatchObject({ state: "complete", importedTurns: 1 });
      expect(store.getTurn("legacy:pi:0")).toMatchObject({
        userContent:
          "initial request\n\n[Follow-up]\n[Miguel]: changed requirement",
        userDisplay: "initial request\n\n[Follow-up]\nchanged requirement",
        assistantFinal: "working\n\nfinished",
      });
    });
  });

  it("honors the Pi compaction watermark and prepends its bounded summary", async () => {
    await runInDurableObject(stub("pi-compaction"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages VALUES (0, 'not json', 0)",
      );
      for (const [idx, message] of [
        [2, { role: "user", content: "visible question", timestamp: 2 }],
        [3, { role: "assistant", content: "visible answer", timestamp: 3 }],
      ] as const) {
        instance.ctx.storage.sql.exec(
          "INSERT INTO pi_core_messages VALUES (?, ?, ?)",
          idx,
          JSON.stringify(message),
          idx,
        );
      }
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_compaction (
        id INTEGER PRIMARY KEY, summary TEXT NOT NULL,
        first_kept_index INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_compaction VALUES (1, ?, 2, 4)",
        "bounded earlier context",
      );
      admit(store);
      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "pi-compaction-attempt"),
      ).toMatchObject({ state: "complete", importedTurns: 1 });
      expect(store.getTurn("legacy:pi:0")).toBeNull();
      expect(store.getTurn("legacy:pi:2")).toMatchObject({
        userContent:
          "[Context Summary]\n\nbounded earlier context\n\nvisible question",
        userDisplay: "visible question",
        assistantFinal: "visible answer",
      });
    });
  });

  it("imports settled ai-chat rows and rejects ambiguous transcript tails", async () => {
    await runInDurableObject(stub("ai-chat"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedAiChat(instance, [
        {
          id: "backfill-user",
          role: "user",
          parts: [{ type: "text", text: "inspect", state: "done" }],
          metadata: { pi: { createdAtMs: 100 } },
        },
        {
          id: "backfill-assistant",
          role: "assistant",
          parts: [
            {
              type: "tool-read_file",
              toolCallId: "read",
              state: "output-available",
            },
            { type: "text", text: "finished", state: "done" },
          ],
          metadata: { pi: { createdAtMs: 200 } },
        },
        {
          id: "explicit-user",
          role: "user",
          parts: [{ type: "text", text: "next", state: "done" }],
        },
        {
          id: "explicit-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "done", state: "done" }],
          metadata: { pi: { completedAtMs: 400 } },
        },
        {
          id: "live-user",
          role: "user",
          parts: [{ type: "text", text: "newest", state: "done" }],
        },
        {
          id: "live-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "partial", state: "streaming" }],
          metadata: { pi: { createdAtMs: 600 } },
        },
      ]);
      admit(store);

      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "ai-attempt"),
      ).toMatchObject({
        state: "complete",
        importedTurns: 2,
        source: "ai_chat",
      });
      expect(store.getTurn("legacy:ai:backfill-user")).toMatchObject({
        assistantFinal: "finished",
        createdAt: 100,
        updatedAt: 200,
      });
      expect(store.getTurn("legacy:ai:explicit-user")?.assistantFinal).toBe(
        "done",
      );
      expect(store.getTurn("legacy:ai:live-user")).toBeNull();
    });
  });

  it("reconstructs an ai-chat steer marker whose follow-up row was inserted later", async () => {
    await runInDurableObject(stub("ai-steer"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedAiChat(instance, [
        {
          id: "base-user",
          role: "user",
          parts: [{ type: "text", text: "initial request", state: "done" }],
          metadata: { pi: { createdAtMs: 100 } },
        },
        {
          id: "assistant-turn",
          role: "assistant",
          parts: [
            { type: "text", text: "before steer", state: "done" },
            {
              type: "data-pi-steer-marker",
              data: { steerMessageId: "steer-user" },
            },
            { type: "text", text: "after steer", state: "done" },
          ],
          metadata: { pi: { completedAtMs: 300 } },
        },
        {
          id: "steer-user",
          role: "user",
          parts: [
            { type: "text", text: "changed requirement", state: "done" },
          ],
          metadata: {
            sentDuringStreaming: true,
            pi: { createdAtMs: 200 },
          },
        },
      ]);
      admit(store);
      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "ai-steer-attempt"),
      ).toMatchObject({ state: "complete", importedTurns: 1 });
      expect(store.getTurn("legacy:ai:base-user")).toMatchObject({
        userContent: "initial request\n\n[Follow-up]\nchanged requirement",
        assistantFinal: "before steer\nafter steer",
      });
      expect(store.getTurn("legacy:ai:steer-user")).toBeNull();
    });
  });

  it("uses completed durable chronology rather than insertion order", async () => {
    await runInDurableObject(stub("ai-chat-chronology"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(`CREATE TABLE cf_ai_chat_agent_messages (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at DATETIME,
        chronology_key TEXT
      )`);
      const rows = [
        ["new-user", "2025-01-01 00:00:03.000:01", { id: "new-user", role: "user", parts: [{ type: "text", text: "new question", state: "done" }] }],
        ["old-user", "2025-01-01 00:00:01.000:02", { id: "old-user", role: "user", parts: [{ type: "text", text: "old question", state: "done" }] }],
        ["new-assistant", "2025-01-01 00:00:04.000:03", { id: "new-assistant", role: "assistant", parts: [{ type: "text", text: "new answer", state: "done" }], metadata: { pi: { completedAtMs: 4 } } }],
        ["old-assistant", "2025-01-01 00:00:02.000:04", { id: "old-assistant", role: "assistant", parts: [{ type: "text", text: "old answer", state: "done" }], metadata: { pi: { completedAtMs: 2 } } }],
      ] as const;
      for (const [id, chronology, message] of rows) {
        instance.ctx.storage.sql.exec(
          `INSERT INTO cf_ai_chat_agent_messages
            (id, message, created_at, chronology_key) VALUES (?, ?, ?, ?)`,
          id,
          JSON.stringify(message),
          chronology.slice(0, 23),
          chronology,
        );
      }
      instance.ctx.storage.sql.exec(
        `CREATE UNIQUE INDEX cf_ai_chat_agent_messages_chronology
           ON cf_ai_chat_agent_messages(chronology_key)`,
      );
      instance.ctx.storage.sql.exec(
        `CREATE TABLE cf_ai_chat_render_history_meta
          (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
      );
      instance.ctx.storage.sql.exec(
        "INSERT INTO cf_ai_chat_render_history_meta VALUES ('metadata_v1', 1)",
      );
      admit(store);

      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "chronology-attempt"),
      ).toMatchObject({ state: "complete", importedTurns: 2 });
      expect(store.getTurn("legacy:ai:old-user")?.assistantFinal).toBe(
        "old answer",
      );
      expect(store.getTurn("legacy:ai:new-user")?.assistantFinal).toBe(
        "new answer",
      );
    });
  });

  it("falls back to bounded rowid order until chronology metadata is complete", async () => {
    await runInDurableObject(stub("ai-chat-incomplete-chronology"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(`CREATE TABLE cf_ai_chat_agent_messages (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at DATETIME,
        chronology_key TEXT
      )`);
      const rows = [
        { id: "old-user", role: "user", parts: [{ type: "text", text: "old", state: "done" }] },
        { id: "old-assistant", role: "assistant", parts: [{ type: "text", text: "old answer", state: "done" }], metadata: { pi: { completedAtMs: 2 } } },
        { id: "new-user", role: "user", parts: [{ type: "text", text: "new", state: "done" }] },
        { id: "new-assistant", role: "assistant", parts: [{ type: "text", text: "new answer", state: "done" }], metadata: { pi: { completedAtMs: 4 } } },
      ];
      for (const [index, message] of rows.entries()) {
        instance.ctx.storage.sql.exec(
          `INSERT INTO cf_ai_chat_agent_messages
            (id, message, created_at, chronology_key) VALUES (?, ?, ?, ?)`,
          message.id,
          JSON.stringify(message),
          index + 1,
          index < 2 ? `filled:${index}` : null,
        );
      }
      admit(store);
      const result = await new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      ).runAfterTrigger(10_000, "rowid-attempt");
      expect(result).toMatchObject({ state: "complete", importedTurns: 2 });
      expect(store.getTurn("legacy:ai:old-user")?.assistantFinal).toBe("old answer");
      expect(store.getTurn("legacy:ai:new-user")?.assistantFinal).toBe("new answer");
    });
  });

  it("retains only the newest 128 settled turns", async () => {
    await runInDurableObject(stub("turn-cap"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      const messages: Record<string, unknown>[] = [];
      for (let turn = 0; turn < 130; turn += 1) {
        messages.push(
          { role: "user", content: `question-${turn}`, timestamp: turn * 2 },
          {
            role: "assistant",
            content: `answer-${turn}`,
            timestamp: turn * 2 + 1,
          },
        );
      }
      seedPi(instance, messages);
      admit(store);
      const result = await new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      ).runAfterTrigger(10_000, "cap-attempt");

      expect(result).toMatchObject({
        state: "complete",
        importedTurns: CHAT_RUNTIME_BOUNDS.historyTurns,
      });
      expect(result.importedBytes).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.legacyMigrationBytes,
      );
      expect(store.getTurn("legacy:pi:0")).toBeNull();
      expect(store.getTurn("legacy:pi:2")).toBeNull();
      expect(store.getTurn("legacy:pi:4")?.assistantFinal).toBe("answer-2");
      expect(store.getTurn("legacy:pi:258")?.assistantFinal).toBe("answer-129");
    });
  });

  it("enforces one 8 MiB source and import budget", async () => {
    await runInDurableObject(stub("byte-cap"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      const messages: Record<string, unknown>[] = [];
      const largeAnswer = "x".repeat(90_000);
      for (let turn = 0; turn < 110; turn += 1) {
        messages.push(
          { role: "user", content: `question-${turn}` },
          { role: "assistant", content: largeAnswer },
        );
      }
      seedPi(instance, messages);
      admit(store);
      const result = await new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      ).runAfterTrigger(10_000, "byte-attempt");

      expect(result.state).toBe("complete");
      expect(result.importedTurns).toBeGreaterThan(0);
      expect(result.importedTurns).toBeLessThan(110);
      expect(result.importedBytes).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.legacyMigrationBytes,
      );
    });
  });

  it("pages metadata first and treats oversized or malformed JSON as seams", async () => {
    await runInDurableObject(stub("bounded-pages"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "older valid question" },
        { role: "assistant", content: "older valid answer" },
      ]);
      for (let index = 2; index < 34; index += 1) {
        instance.ctx.storage.sql.exec(
          `INSERT INTO pi_core_messages (idx, payload, created_at)
           VALUES (?, 'not json', ?)`,
          index,
          index,
        );
      }
      let nested = "0";
      for (let depth = 0; depth < 33; depth += 1) nested = `[${nested}]`;
      instance.ctx.storage.sql.exec(
        `INSERT INTO pi_core_messages (idx, payload, created_at)
         VALUES (34, ?, 34)`,
        `{"role":"user","content":${nested}}`,
      );
      instance.ctx.storage.sql.exec(
        `INSERT INTO pi_core_messages (idx, payload, created_at)
         VALUES (35, ?, 35)`,
        JSON.stringify({
          role: "assistant",
          padding: "x".repeat(CHAT_RUNTIME_BOUNDS.legacyMigrationRowBytes + 1),
        }),
      );
      admit(store);

      const result = await new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      ).runAfterTrigger(10_000, "page-attempt");
      expect(result).toMatchObject({
        state: "complete",
        importedTurns: 1,
        source: "pi_core",
      });
      expect(store.getTurn("legacy:pi:0")?.assistantFinal).toBe(
        "older valid answer",
      );
    });
  });

  it("fences a yielded stale scan before reading another page", async () => {
    await runInDurableObject(stub("stale"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      const messages: Record<string, unknown>[] = [];
      for (let turn = 0; turn < 20; turn += 1) {
        messages.push(
          { role: "user", content: `question-${turn}` },
          { role: "assistant", content: `answer-${turn}` },
        );
      }
      seedPi(instance, messages);
      admit(store);
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      const migration = migrator.runAfterTrigger(10_000, "old-owner");
      expect(migrator.status()).toMatchObject({
        state: "pending",
        attemptToken: "old-owner",
      });
      instance.ctx.storage.sql.exec(
        `UPDATE chat_legacy_migration_v2
            SET state = 'complete', attempt_token = NULL, source = 'none'
          WHERE singleton = 1`,
      );
      instance.ctx.storage.sql.exec(
        "UPDATE pi_core_messages SET payload = 'not json' WHERE idx = 0",
      );

      expect(await migration).toMatchObject({
        state: "complete",
        importedTurns: 0,
        changed: false,
      });
      expect(importedCount(instance)).toBe(0);
    });
  });

  it("rolls back all imported rows when the atomic terminal commit fails", async () => {
    await runInDurableObject(stub("atomic"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "first" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second" },
        { role: "assistant", content: "second answer" },
      ]);
      admit(store, "legacy:pi:2");

      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "collision-attempt"),
      ).toMatchObject({
        state: "failed",
        importedTurns: 0,
        error: "legacy_migration_id_collision",
      });
      expect(store.getTurn("legacy:pi:0")).toBeNull();
      expect(store.getTurn("legacy:pi:2")).toMatchObject({
        source: "web",
        status: "queued",
      });
      expect(importedCount(instance)).toBe(0);
    });
  });

  it("keeps one fixed 30-second deadline across at most two attempts", async () => {
    await runInDurableObject(stub("retry"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "old" },
        { role: "assistant", content: "answer" },
      ]);
      admit(store);
      let now = 10_001;
      let failRead = true;
      const migrator = new LegacySessionMigrator(instance.ctx.storage, () => {
        if (failRead) {
          failRead = false;
          throw new Error("transient read failure");
        }
        return now;
      });

      const first = await migrator.runAfterTrigger(10_000, "attempt-1");
      expect(first).toMatchObject({
        state: "pending",
        attemptCount: 1,
        error: "legacy_migration_read_failed",
        deadlineAt: 10_000 + CHAT_RUNTIME_BOUNDS.legacyMigrationDeadlineMs,
      });
      expect(migrator.nextAlarmAt(now)).toBe(
        now + CHAT_RUNTIME_BOUNDS.legacyMigrationRetryMs,
      );

      failRead = true;
      now += 100;
      const second = await migrator.runAfterTrigger(now, "attempt-2");
      expect(second).toMatchObject({
        state: "failed",
        attemptCount: CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts,
        deadlineAt: first.deadlineAt,
        error: "legacy_migration_read_failed",
      });
      expect(
        await migrator.runAfterTrigger(now + 1, "attempt-3"),
      ).toMatchObject({
        state: "failed",
        attemptCount: CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts,
        changed: false,
      });
    });
  });

  it("terminalizes admission-triggered pending work that disappears", async () => {
    await runInDurableObject(
      stub("missing-admission"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedPi(instance, [
          { role: "user", content: "old" },
          { role: "assistant", content: "answer" },
        ]);
        admit(store);
        let failRead = true;
        const migrator = new LegacySessionMigrator(instance.ctx.storage, () => {
          if (failRead) {
            failRead = false;
            throw new Error("transient read failure");
          }
          return 10_001;
        });
        const pending = await migrator.runAfterTrigger(10_000, "attempt-1");
        expect(pending.state).toBe("pending");
        instance.ctx.storage.sql.exec(
          "DELETE FROM chat_turns_v2 WHERE id = 'current'",
        );

        expect(
          await migrator.runAfterTrigger(10_020, "attempt-2"),
        ).toMatchObject({
          state: "failed",
          attemptCount: 1,
          deadlineAt: pending.deadlineAt,
          error: "legacy_migration_admission_missing",
        });
        expect(migrator.claimBlocked()).toBe(false);
      },
    );
  });

  it("marks existing V2 history authoritative without reading legacy", async () => {
    await runInDurableObject(stub("v2"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.replaceSettledHistory({ ...scope, userId: "user:test" }, [
        {
          id: "forked",
          userContent: "fork context",
          userDisplay: "fork context",
          assistantFinal: "fork answer",
          createdAt: 1,
          updatedAt: 2,
        },
      ]);
      admit(store);
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages VALUES (0, 'not json', 1)",
      );

      expect(
        await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "v2-attempt"),
      ).toMatchObject({
        state: "complete",
        attemptCount: 1,
        importedTurns: 0,
        source: "v2",
      });
      expect(store.getTurn("forked")?.assistantFinal).toBe("fork answer");
    });
  });
});
