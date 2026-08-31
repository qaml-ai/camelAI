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

function admitCurrent(store: DurableChatTurnStore, now = 10_000) {
  return store.admit(
    {
      id: "current",
      clientMessageId: "current",
      threadId: "thread:test",
      workspaceId: "workspace:test",
      orgId: "org:test",
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
  instance.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pi_core_messages (
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

describe("bounded just-in-time legacy session migration", () => {
  it("starts only after admission or a durable post-open request", async () => {
    await runInDurableObject(stub("unseen"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "old", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          timestamp: 2,
        },
      ]);
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 100,
      );

      expect(await migrator.runAfterTrigger(100, "attempt-1")).toMatchObject({
        state: "unseen",
        attemptCount: 0,
      });
      expect(migrator.status().state).toBe("unseen");
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
      expect(store.latestSnapshot().messages).toEqual([]);

      expect(migrator.requestAfterOpen({
        threadId: "thread:test",
        workspaceId: "workspace:test",
        orgId: "org:test",
      }, 100)).toMatchObject({ state: "pending", attemptCount: 0 });
      expect(await migrator.runAfterTrigger(100, "attempt-2")).toMatchObject({
        state: "complete",
        importedTurns: 1,
      });
      expect(store.latestSnapshot().messages.map(({ role, content }) => ({
        role,
        content,
      }))).toEqual([
        { role: "user", content: "old" },
        { role: "assistant", content: "answer" },
      ]);
    });
  });

  it("imports only closed Pi turns and exact complete parallel tool batches", async () => {
    await runInDurableObject(stub("pi-closed"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "first question", timestamp: 100 },
        {
          role: "assistant",
          responseId: "answer-1",
          content: [{ type: "text", text: "first answer" }],
          timestamp: 110,
        },
        { role: "user", content: "inspect both", timestamp: 200 },
        {
          role: "assistant",
          responseId: "tool-batch",
          content: [
            { type: "text", text: "I will inspect both." },
            {
              type: "toolCall",
              id: "call-a",
              name: "read_file",
              arguments: { path: "a" },
            },
            {
              type: "toolCall",
              id: "call-b",
              name: "read_file",
              arguments: { path: "b" },
            },
          ],
          timestamp: 210,
        },
        {
          role: "toolResult",
          toolCallId: "call-a",
          toolName: "read_file",
          content: [{ type: "text", text: "a" }],
          timestamp: 220,
        },
        {
          role: "toolResult",
          toolCallId: "call-b",
          toolName: "read_file",
          content: [{ type: "text", text: "b" }],
          timestamp: 230,
        },
        {
          role: "assistant",
          responseId: "answer-2",
          content: [{ type: "text", text: "both are sound" }],
          timestamp: 240,
        },
        { role: "user", content: "unfinished", timestamp: 300 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-open",
              name: "deploy",
              arguments: {},
            },
          ],
          timestamp: 310,
        },
      ]);
      const beforeLegacy = instance.ctx.storage.sql
        .exec<{
          idx: number;
          payload: string;
        }>("SELECT idx, payload FROM pi_core_messages ORDER BY idx")
        .toArray();
      const admitted = admitCurrent(store);
      expect(admitted).toMatchObject({
        ok: true,
        turn: { status: "queued", attemptCount: 0 },
      });
      const originalDeadline = store.getTurn("current")?.terminalDeadlineAt;
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      const result = await migrator.runAfterTrigger(10_000, "migration-1");

      expect(result).toMatchObject({
        state: "complete",
        attemptCount: 1,
        attemptToken: null,
        importedTurns: 2,
        source: "pi_core",
        error: null,
      });
      expect(migrator.claimBlocked()).toBe(false);
      expect(legacyMigrationBlocksClaim(store.sql)).toBe(false);
      expect(store.getTurn("current")).toMatchObject({
        status: "queued",
        attemptCount: 0,
        terminalDeadlineAt: originalDeadline,
      });
      expect(store.getTurn("legacy:pi:0")).toMatchObject({
        userContent: "first question",
        assistantFinal: "first answer",
        status: "completed",
        source: "legacy_migration",
      });
      expect(store.getTurn("legacy:pi:2")).toMatchObject({
        userContent: "inspect both",
        assistantFinal: "I will inspect both.\n\nboth are sound",
        status: "completed",
      });
      expect(
        Number(
          instance.ctx.storage.sql
            .exec<{
              payload_bytes: number;
            }>(
              "SELECT payload_bytes FROM chat_turns_v2 WHERE id = 'legacy:pi:0'",
            )
            .one().payload_bytes,
        ),
      ).toBe(
        new TextEncoder().encode(
          JSON.stringify({
            content: "first question",
            display: "first question",
          }),
        ).byteLength,
      );
      expect(store.getTurn("legacy:pi:8")).toBeNull();
      expect(store.readOutbox(0).events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "BeginLegacyMigration",
          "CompleteLegacyMigration",
        ]),
      );
      expect(
        instance.ctx.storage.sql
          .exec<{
            idx: number;
            payload: string;
          }>("SELECT idx, payload FROM pi_core_messages ORDER BY idx")
          .toArray(),
      ).toEqual(beforeLegacy);

      // A terminal marker makes future calls no-ops without touching legacy.
      instance.ctx.storage.sql.exec(
        "UPDATE pi_core_messages SET payload = 'not json' WHERE idx = 0",
      );
      expect(
        await migrator.runAfterTrigger(11_000, "migration-should-not-run"),
      ).toMatchObject({
        state: "complete",
        attemptCount: 1,
        importedTurns: 2,
        changed: false,
      });
    });
  });

  it("drops an incomplete Pi turn without poisoning the following complete turn", async () => {
    await runInDurableObject(
      stub("pi-incomplete-boundary"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedPi(instance, [
          { role: "user", content: "unfinished", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "open", name: "deploy", arguments: {} },
            ],
            timestamp: 2,
          },
          { role: "user", content: "independent next turn", timestamp: 3 },
          {
            role: "assistant",
            content: [{ type: "text", text: "settled answer" }],
            timestamp: 4,
          },
        ]);
        admitCurrent(store);
        const migrator = new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        );

        expect(
          await migrator.runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({ state: "complete", importedTurns: 1 });
        expect(store.getTurn("legacy:pi:0")).toBeNull();
        expect(store.getTurn("legacy:pi:2")).toMatchObject({
          userContent: "independent next turn",
          userDisplay: "independent next turn",
          assistantFinal: "settled answer",
        });
      },
    );
  });

  it("folds metadata-marked steering while preserving raw display text", async () => {
    await runInDurableObject(
      stub("pi-steer-display"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedPi(instance, [
          {
            role: "user",
            content:
              "[Miguel]: typed first\n\n<camelai system message>model-only context</camelai system message>",
            timestamp: 1_700_000_000_123,
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "working" },
              {
                type: "toolCall",
                id: "read",
                name: "read_file",
                arguments: {},
              },
            ],
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "read",
            toolName: "read_file",
            content: [{ type: "text", text: "ok" }],
            timestamp: 3,
          },
          {
            role: "user",
            content: "[Miguel]: typed steer",
            timestamp: 4,
            metadata: { sentDuringStreaming: true },
            uiMetadata: { renderMessageId: "raw-steer" },
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            timestamp: 5,
          },
        ]);
        seedAiChat(instance, [
          {
            id: "raw-first",
            role: "user",
            parts: [{ type: "text", text: "typed first", state: "done" }],
            metadata: { piCoreMessageKey: "1700000000123" },
          },
          {
            id: "raw-steer",
            role: "user",
            parts: [{ type: "text", text: "typed steer", state: "done" }],
            metadata: { sentDuringStreaming: true },
          },
        ]);
        admitCurrent(store);
        const migrator = new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        );

        expect(
          await migrator.runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({ state: "complete", importedTurns: 1 });
        expect(store.getTurn("legacy:pi:0")).toMatchObject({
          userContent:
            "[Miguel]: typed first\n\n<camelai system message>model-only context</camelai system message>\n\n[Follow-up]\n[Miguel]: typed steer",
          userDisplay: "typed first\n\n[Follow-up]\ntyped steer",
          assistantFinal: "working\n\ndone",
        });
      },
    );
  });

  it("requires a unique Pi timestamp before using display fallback", async () => {
    await runInDurableObject(
      stub("pi-display-key-ambiguity"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedPi(instance, [
          { role: "user", content: "[Miguel]: model one", timestamp: 77 },
          {
            role: "assistant",
            content: [{ type: "text", text: "answer one" }],
            timestamp: 78,
          },
          { role: "user", content: "[Beth]: model two", timestamp: 77 },
          {
            role: "assistant",
            content: [{ type: "text", text: "answer two" }],
            timestamp: 79,
          },
        ]);
        seedAiChat(instance, [
          {
            id: "raw-one",
            role: "user",
            parts: [{ type: "text", text: "typed one", state: "done" }],
            metadata: { piCoreMessageKey: "77" },
          },
        ]);
        admitCurrent(store);

        expect(
          await new LegacySessionMigrator(
            instance.ctx.storage,
            () => 10_001,
          ).runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({ state: "complete", importedTurns: 2 });
        expect(store.getTurn("legacy:pi:0")?.userDisplay).toBe("model one");
        expect(store.getTurn("legacy:pi:2")?.userDisplay).toBe("model two");
      },
    );
  });

  it("honors the Pi compaction watermark and keeps its summary model-only", async () => {
    await runInDurableObject(stub("pi-watermark"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (0, 'not json', 0)",
      );
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        2,
        JSON.stringify({
          role: "user",
          content: "visible question",
          timestamp: 2,
        }),
        2,
      );
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        3,
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "visible answer" }],
          timestamp: 3,
        }),
        3,
      );
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_compaction (
        id INTEGER PRIMARY KEY, summary TEXT NOT NULL,
        first_kept_index INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        `INSERT INTO pi_core_compaction
          (id, summary, first_kept_index, updated_at) VALUES (1, ?, 2, 4)`,
        "bounded earlier context",
      );
      admitCurrent(store);
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      expect(
        await migrator.runAfterTrigger(10_000, "migration-1"),
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

  it("accepts settled ai-chat backfill rows and excludes an in-flight render row", async () => {
    await runInDurableObject(stub("ai-chat"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedAiChat(instance, [
        {
          id: "old-user",
          role: "user",
          parts: [{ type: "text", text: "run it", state: "done" }],
          metadata: { pi: { createdAtMs: 100 } },
        },
        {
          id: "old-assistant",
          role: "assistant",
          parts: [
            {
              type: "tool-read_file",
              toolCallId: "call-1",
              state: "output-available",
              input: { path: "a" },
              output: { content: "ok" },
            },
            { type: "text", text: "finished", state: "done" },
          ],
          // Historical pi_core backfill stamps createdAtMs, not completedAtMs.
          metadata: { pi: { createdAtMs: 200 } },
        },
        {
          id: "orphan-user",
          role: "user",
          parts: [{ type: "text", text: "crash window", state: "done" }],
        },
        {
          id: "orphan-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "looks done", state: "done" }],
        },
        {
          id: "error-user",
          role: "user",
          parts: [{ type: "text", text: "failed turn", state: "done" }],
        },
        {
          id: "error-assistant",
          role: "assistant",
          parts: [
            { type: "data-pi-error", data: { error: "provider failed" } },
          ],
          metadata: { pi: { completedAtMs: 250 } },
        },
        {
          id: "live-user",
          role: "user",
          parts: [{ type: "text", text: "newest", state: "done" }],
        },
        {
          id: "live-assistant",
          role: "assistant",
          parts: [{ type: "text", text: "half", state: "streaming" }],
        },
      ]);
      admitCurrent(store);
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      expect(
        await migrator.runAfterTrigger(10_000, "migration-1"),
      ).toMatchObject({
        state: "complete",
        source: "ai_chat",
        importedTurns: 1,
      });
      expect(store.getTurn("legacy:ai:old-user")).toMatchObject({
        userContent: "run it",
        assistantFinal: "finished",
        createdAt: 100,
        updatedAt: 200,
      });
      expect(store.getTurn("legacy:ai:live-user")).toBeNull();
      expect(store.getTurn("legacy:ai:orphan-user")).toBeNull();
      expect(store.getTurn("legacy:ai:error-user")).toBeNull();
    });
  });

  it("does not use a creation timestamp as completion proof at the transcript tail", async () => {
    await runInDurableObject(
      stub("ai-chat-created-tail"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedAiChat(instance, [
          {
            id: "tail-user",
            role: "user",
            parts: [{ type: "text", text: "unfinished", state: "done" }],
            metadata: { pi: { createdAtMs: 100 } },
          },
          {
            id: "tail-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "partial", state: "done" }],
            metadata: { pi: { createdAtMs: 200 } },
          },
        ]);
        admitCurrent(store);

        expect(
          await new LegacySessionMigrator(
            instance.ctx.storage,
            () => 10_001,
          ).runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({
          state: "complete",
          source: "none",
          importedTurns: 0,
        });
        expect(store.getTurn("legacy:ai:tail-user")).toBeNull();
      },
    );
  });

  it("drops a leading ai-chat follow-up and its partial assistant tail", async () => {
    await runInDurableObject(
      stub("ai-chat-leading-followup"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedAiChat(instance, [
          {
            id: "orphan-followup",
            role: "user",
            parts: [{ type: "text", text: "missing base", state: "done" }],
            metadata: {
              sentDuringStreaming: true,
              pi: { createdAtMs: 100 },
            },
          },
          {
            id: "orphan-tail",
            role: "assistant",
            parts: [{ type: "text", text: "partial answer", state: "done" }],
            metadata: { pi: { completedAtMs: 200 } },
          },
          {
            id: "real-user",
            role: "user",
            parts: [{ type: "text", text: "whole prompt", state: "done" }],
          },
          {
            id: "real-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "whole answer", state: "done" }],
            metadata: { pi: { completedAtMs: 400 } },
          },
        ]);
        admitCurrent(store);

        expect(
          await new LegacySessionMigrator(
            instance.ctx.storage,
            () => 10_001,
          ).runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({ importedTurns: 1, source: "ai_chat" });
        expect(store.getTurn("legacy:ai:orphan-followup")).toBeNull();
        expect(store.getTurn("legacy:ai:real-user")).toMatchObject({
          userContent: "whole prompt",
          assistantFinal: "whole answer",
        });
      },
    );
  });

  it("folds a settled steer marker when its user row was inserted later", async () => {
    await runInDurableObject(
      stub("ai-chat-steer-order"),
      async (instance: any) => {
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
        admitCurrent(store);

        expect(
          await new LegacySessionMigrator(
            instance.ctx.storage,
            () => 10_001,
          ).runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({
          state: "complete",
          source: "ai_chat",
          importedTurns: 1,
        });
        expect(store.getTurn("legacy:ai:base-user")).toMatchObject({
          userContent: "initial request\n\n[Follow-up]\nchanged requirement",
          userDisplay: "initial request\n\n[Follow-up]\nchanged requirement",
          assistantFinal: "before steer\nafter steer",
          updatedAt: 300,
        });
        expect(store.getTurn("legacy:ai:steer-user")).toBeNull();
      },
    );
  });

  it("pages modern ai-chat history by durable chronology instead of insertion order", async () => {
    await runInDurableObject(
      stub("ai-chat-chronology"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        instance.ctx.storage.sql.exec(`CREATE TABLE cf_ai_chat_agent_messages (
        id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at DATETIME,
        render_seq INTEGER, serialized_bytes INTEGER, chronology_key TEXT
      )`);
        const rows = [
          {
            id: "new-user",
            chronology: "2025-01-01 00:00:03.000:00000000000000000001:new-user",
            message: {
              id: "new-user",
              role: "user",
              parts: [{ type: "text", text: "new question", state: "done" }],
              metadata: { pi: { createdAtMs: 300 } },
            },
          },
          {
            id: "old-user",
            chronology: "2025-01-01 00:00:01.000:00000000000000000002:old-user",
            message: {
              id: "old-user",
              role: "user",
              parts: [{ type: "text", text: "old question", state: "done" }],
              metadata: { pi: { createdAtMs: 100 } },
            },
          },
          {
            id: "new-assistant",
            chronology:
              "2025-01-01 00:00:04.000:00000000000000000003:new-assistant",
            message: {
              id: "new-assistant",
              role: "assistant",
              parts: [{ type: "text", text: "new answer", state: "done" }],
              metadata: { pi: { completedAtMs: 400 } },
            },
          },
          {
            id: "old-assistant",
            chronology:
              "2025-01-01 00:00:02.000:00000000000000000004:old-assistant",
            message: {
              id: "old-assistant",
              role: "assistant",
              parts: [
                { type: "reasoning", text: "private reasoning", state: "done" },
                { type: "text", text: "old answer", state: "done" },
              ],
              metadata: { pi: { completedAtMs: 200 } },
            },
          },
        ];
        for (const [index, row] of rows.entries()) {
          const payload = JSON.stringify(row.message);
          instance.ctx.storage.sql.exec(
            `INSERT INTO cf_ai_chat_agent_messages
            (id, message, created_at, render_seq, serialized_bytes, chronology_key)
           VALUES (?, ?, ?, ?, ?, ?)`,
            row.id,
            payload,
            row.chronology.slice(0, 23),
            index + 1,
            new TextEncoder().encode(payload).byteLength,
            row.chronology,
          );
        }
        instance.ctx.storage.sql.exec(
          `CREATE UNIQUE INDEX cf_ai_chat_agent_messages_chronology
             ON cf_ai_chat_agent_messages(chronology_key)`,
        );
        instance.ctx.storage.sql
          .exec(`CREATE TABLE cf_ai_chat_render_history_meta (
          key TEXT PRIMARY KEY, value INTEGER NOT NULL
        )`);
        instance.ctx.storage.sql.exec(
          "INSERT INTO cf_ai_chat_render_history_meta VALUES ('metadata_v1', 1)",
        );
        admitCurrent(store);
        const migrator = new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        );

        expect(
          await migrator.runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({
          state: "complete",
          source: "ai_chat",
          importedTurns: 2,
        });
        expect(store.getTurn("legacy:ai:old-user")).toMatchObject({
          userContent: "old question",
          assistantFinal: "old answer",
        });
        expect(store.getTurn("legacy:ai:new-user")).toMatchObject({
          userContent: "new question",
          assistantFinal: "new answer",
        });
      },
    );
  });

  it("uses bounded rowid paging when chronology backfill is incomplete", async () => {
    await runInDurableObject(
      stub("ai-chat-partial-chronology"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        instance.ctx.storage.sql.exec(`CREATE TABLE cf_ai_chat_agent_messages (
          id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at DATETIME,
          render_seq INTEGER, serialized_bytes INTEGER, chronology_key TEXT
        )`);
        const rows = [
          {
            id: "old-user",
            role: "user",
            parts: [{ type: "text", text: "old", state: "done" }],
          },
          {
            id: "old-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "old answer", state: "done" }],
            metadata: { pi: { completedAtMs: 2 } },
          },
          {
            id: "new-user",
            role: "user",
            parts: [{ type: "text", text: "new", state: "done" }],
          },
          {
            id: "new-assistant",
            role: "assistant",
            parts: [{ type: "text", text: "new answer", state: "done" }],
            metadata: { pi: { completedAtMs: 4 } },
          },
        ];
        for (const [index, message] of rows.entries()) {
          instance.ctx.storage.sql.exec(
            `INSERT INTO cf_ai_chat_agent_messages
              (id, message, created_at, render_seq, serialized_bytes, chronology_key)
             VALUES (?, ?, ?, ?, ?, ?)`,
            message.id,
            JSON.stringify(message),
            index + 1,
            index + 1,
            JSON.stringify(message).length,
            index < 2 ? `filled:${index}` : null,
          );
        }
        const plan = instance.ctx.storage.sql
          .exec<{ detail: string }>(
            `EXPLAIN QUERY PLAN SELECT rowid FROM cf_ai_chat_agent_messages
              WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
            Number.MAX_SAFE_INTEGER,
            CHAT_RUNTIME_BOUNDS.legacyMigrationPageRows,
          )
          .toArray()
          .map((row: { detail: string }) => row.detail)
          .join(" ");
        expect(plan).toMatch(/INTEGER PRIMARY KEY.*rowid<\?/i);

        admitCurrent(store);
        const result = await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "migration-1");
        expect(result).toMatchObject({ state: "complete", importedTurns: 2 });
        expect(store.getTurn("legacy:ai:old-user")?.assistantFinal).toBe(
          "old answer",
        );
        expect(store.getTurn("legacy:ai:new-user")?.assistantFinal).toBe(
          "new answer",
        );
      },
    );
  });

  it("reads only the newest bounded window and retains at most 128 turns", async () => {
    await runInDurableObject(stub("window"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      // This malformed row is older than the bounded 129-user look-back and is
      // never materialized. A whole-transcript reader would fail this migration.
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (0, 'not json', 0)",
      );
      let idx = 1;
      for (let turn = 0; turn < 130; turn += 1) {
        instance.ctx.storage.sql.exec(
          "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
          idx++,
          JSON.stringify({
            role: "user",
            content: `question-${turn}`,
            timestamp: 100 + turn * 2,
          }),
          100 + turn * 2,
        );
        instance.ctx.storage.sql.exec(
          "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
          idx++,
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: `answer-${turn}` }],
            timestamp: 101 + turn * 2,
          }),
          101 + turn * 2,
        );
      }
      admitCurrent(store);
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      const result = await migrator.runAfterTrigger(10_000, "migration-1");

      expect(result).toMatchObject({
        state: "complete",
        source: "pi_core",
        importedTurns: CHAT_RUNTIME_BOUNDS.historyTurns,
      });
      expect(result.importedBytes).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.historyBytes,
      );
      expect(store.getTurn("legacy:pi:1")).toBeNull();
      expect(store.getTurn("legacy:pi:5")?.userContent).toBe("question-2");
      expect(store.getTurn("legacy:pi:259")?.assistantFinal).toBe("answer-129");
    });
  });

  it("does not promote a Pi follow-up at the bounded scan seam", async () => {
    await runInDurableObject(
      stub("pi-followup-scan-seam"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const messages: Record<string, unknown>[] = [
          { role: "user", content: "base outside window", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "before cutoff" }],
            timestamp: 2,
          },
          {
            role: "user",
            content: "orphaned follow-up",
            sentDuringStreaming: true,
            timestamp: 3,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "must not become a turn" }],
            timestamp: 4,
          },
          { role: "user", content: "newer base", timestamp: 5 },
          {
            role: "assistant",
            content: [{ type: "text", text: "newer first answer" }],
            timestamp: 6,
          },
          {
            role: "user",
            content: "newer follow-up",
            sentDuringStreaming: true,
            timestamp: 7,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "newer final answer" }],
            timestamp: 8,
          },
        ];
        for (
          let turn = 0;
          turn < CHAT_RUNTIME_BOUNDS.historyTurns - 2;
          turn += 1
        ) {
          messages.push(
            {
              role: "user",
              content: `question-${turn}`,
              timestamp: 9 + turn * 2,
            },
            {
              role: "assistant",
              content: [{ type: "text", text: `answer-${turn}` }],
              timestamp: 10 + turn * 2,
            },
          );
        }
        seedPi(instance, messages);
        admitCurrent(store);

        const result = await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "migration-1");
        expect(result).toMatchObject({
          state: "complete",
          source: "pi_core",
          importedTurns: CHAT_RUNTIME_BOUNDS.historyTurns - 1,
        });
        expect(store.getTurn("legacy:pi:2")).toBeNull();
        expect(store.getTurn("legacy:pi:4")).toMatchObject({
          userContent: "newer base\n\n[Follow-up]\nnewer follow-up",
          assistantFinal: "newer first answer\n\nnewer final answer",
        });
      },
    );
  });

  it("shares one total source-row budget with display hydration", async () => {
    await runInDurableObject(
      stub("shared-row-budget"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
        instance.ctx.storage.sql.exec(
          `WITH RECURSIVE sequence(idx) AS (
           VALUES(0) UNION ALL SELECT idx + 1 FROM sequence WHERE idx + 1 < ?
         ) INSERT INTO pi_core_messages (idx, payload, created_at)
           SELECT idx, ?, idx FROM sequence`,
          CHAT_RUNTIME_BOUNDS.legacyMigrationScanRows,
          JSON.stringify({ role: "assistant", visibility: "hidden" }),
        );
        instance.ctx.storage.sql.exec(
          "UPDATE pi_core_messages SET payload = ? WHERE idx = ?",
          JSON.stringify({
            role: "user",
            content: "bounded question",
            timestamp: 1,
          }),
          CHAT_RUNTIME_BOUNDS.legacyMigrationScanRows - 2,
        );
        instance.ctx.storage.sql.exec(
          "UPDATE pi_core_messages SET payload = ? WHERE idx = ?",
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "bounded answer" }],
            timestamp: 2,
          }),
          CHAT_RUNTIME_BOUNDS.legacyMigrationScanRows - 1,
        );
        seedAiChat(instance, [
          { id: "must-not-read", role: "user", parts: [] },
        ]);
        instance.ctx.storage.sql.exec(
          "UPDATE cf_ai_chat_agent_messages SET message = 'not json'",
        );
        admitCurrent(store);

        expect(
          await new LegacySessionMigrator(
            instance.ctx.storage,
            () => 10_001,
          ).runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({
          state: "complete",
          source: "pi_core",
          importedTurns: 1,
        });
        expect(
          store.getTurn(
            `legacy:pi:${CHAT_RUNTIME_BOUNDS.legacyMigrationScanRows - 2}`,
          )?.assistantFinal,
        ).toBe("bounded answer");
      },
    );
  });

  it("shares one total source-byte budget with display hydration", async () => {
    await runInDurableObject(
      stub("shared-byte-budget"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
        const user = JSON.stringify({ role: "user", content: "byte question" });
        const assistant = JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "byte answer" }],
        });
        const bytes = (value: string) =>
          new TextEncoder().encode(value).byteLength;
        const hiddenCount = 64;
        const targetPiBytes = CHAT_RUNTIME_BOUNDS.historyBytes - 64 * 1024;
        const emptyHidden = JSON.stringify({
          role: "assistant",
          visibility: "hidden",
          padding: "",
        });
        const paddingBytes =
          targetPiBytes -
          bytes(user) -
          bytes(assistant) -
          hiddenCount * bytes(emptyHidden);
        const paddingPerRow = Math.floor(paddingBytes / hiddenCount);
        const extraPaddingRows = paddingBytes % hiddenCount;
        const hidden = Array.from({ length: hiddenCount }, (_, index) =>
          JSON.stringify({
            role: "assistant",
            visibility: "hidden",
            padding: "x".repeat(
              paddingPerRow + (index < extraPaddingRows ? 1 : 0),
            ),
          }),
        );
        expect(
          [...hidden, user, assistant].reduce(
            (sum, value) => sum + bytes(value),
            0,
          ),
        ).toBe(targetPiBytes);
        hidden.forEach((payload, index) => {
          instance.ctx.storage.sql.exec(
            `INSERT INTO pi_core_messages (idx, payload, created_at)
             VALUES (?, ?, ?)`,
            index,
            payload,
            index,
          );
        });
        instance.ctx.storage.sql.exec(
          `INSERT INTO pi_core_messages (idx, payload, created_at)
         VALUES (?, ?, ?), (?, ?, ?)`,
          hiddenCount,
          user,
          hiddenCount,
          hiddenCount + 1,
          assistant,
          hiddenCount + 1,
        );
        seedAiChat(instance, [
          { id: "must-not-read", role: "user", parts: [] },
        ]);
        instance.ctx.storage.sql.exec(
          "UPDATE cf_ai_chat_agent_messages SET message = ?",
          "not-json".repeat(16 * 1024),
        );
        admitCurrent(store);

        expect(
          await new LegacySessionMigrator(
            instance.ctx.storage,
            () => 10_001,
          ).runAfterTrigger(10_000, "migration-1"),
        ).toMatchObject({
          state: "complete",
          source: "pi_core",
          importedTurns: 1,
        });
        expect(store.getTurn(`legacy:pi:${hiddenCount}`)?.assistantFinal).toBe(
          "byte answer",
        );
      },
    );
  });

  it("stops a yielded stale scan before reading another legacy page", async () => {
    await runInDurableObject(
      stub("stale-page-fence"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const messages: Array<Record<string, unknown>> = [];
        for (let turn = 0; turn < 20; turn += 1) {
          messages.push({
            role: "user",
            content: `question-${turn}`,
            timestamp: turn * 2 + 1,
          });
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: `answer-${turn}` }],
            timestamp: turn * 2 + 2,
          });
        }
        seedPi(instance, messages);
        admitCurrent(store);
        const migrator = new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        );

        // The first 32-row metadata page is consumed synchronously; its bounded
        // yield lets this terminal marker supersede the in-flight attempt.
        const migration = migrator.runAfterTrigger(10_000, "migration-1");
        expect(migrator.status()).toMatchObject({
          state: "pending",
          attemptToken: "migration-1",
        });
        instance.ctx.storage.sql.exec(
          `UPDATE chat_legacy_migration_v2
            SET state = 'complete', attempt_token = NULL, source = 'none'
          WHERE singleton = 1`,
        );
        // This row belongs to the next page. Reading it would fail the stale run.
        instance.ctx.storage.sql.exec(
          "UPDATE pi_core_messages SET payload = 'not json' WHERE idx = 0",
        );

        expect(await migration).toMatchObject({
          state: "complete",
          attemptToken: null,
          importedTurns: 0,
          changed: false,
        });
        expect(
          instance.ctx.storage.sql
            .exec<{
              count: number;
            }>(
              "SELECT COUNT(*) AS count FROM chat_turns_v2 WHERE source = 'legacy_migration'",
            )
            .one().count,
        ).toBe(0);
      },
    );
  });

  it("fails malformed newest history explicitly and never rereads after failure", async () => {
    await runInDurableObject(stub("malformed"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (0, 'not json', 1)",
      );
      admitCurrent(store);
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      expect(
        await migrator.runAfterTrigger(10_000, "migration-1"),
      ).toMatchObject({
        state: "failed",
        attemptCount: 1,
        error: "malformed_pi_core_json",
      });
      expect(migrator.claimBlocked()).toBe(false);
      expect(migrator.nextAlarmAt()).toBeNull();

      instance.ctx.storage.sql.exec(
        `UPDATE pi_core_messages SET payload = ? WHERE idx = 0`,
        JSON.stringify({ role: "user", content: "now valid" }),
      );
      expect(
        await migrator.runAfterTrigger(11_000, "migration-2"),
      ).toMatchObject({
        state: "failed",
        attemptCount: 1,
        error: "malformed_pi_core_json",
        changed: false,
      });
      expect(store.getTurn("current")?.status).toBe("queued");
    });
  });

  it("rolls back every imported row when the atomic terminal commit fails", async () => {
    await runInDurableObject(stub("atomic-rollback"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "first", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          timestamp: 2,
        },
        { role: "user", content: "second", timestamp: 3 },
        {
          role: "assistant",
          content: [{ type: "text", text: "second answer" }],
          timestamp: 4,
        },
      ]);
      // Collide with the second deterministic import id. The first legacy row
      // is inserted earlier in the same transaction and must roll back too.
      store.admit(
        {
          id: "legacy:pi:2",
          clientMessageId: "legacy:pi:2",
          threadId: "thread:test",
          workspaceId: "workspace:test",
          orgId: "org:test",
          userId: "user:test",
          source: "web",
          userContent: "continue",
          userDisplay: "continue",
        },
        10_000,
      );
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      expect(
        await migrator.runAfterTrigger(10_000, "migration-1"),
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
      expect(
        instance.ctx.storage.sql
          .exec<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM chat_turns_v2 WHERE source = 'legacy_migration'",
          )
          .one().count,
      ).toBe(0);
    });
  });

  it("keeps one absolute deadline and permits only one bounded retry", async () => {
    await runInDurableObject(stub("retry"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      seedPi(instance, [
        { role: "user", content: "old", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          timestamp: 2,
        },
      ]);
      admitCurrent(store);
      let now = 10_001;
      let throwNextRead = true;
      const migrator = new LegacySessionMigrator(instance.ctx.storage, () => {
        if (throwNextRead) {
          throwNextRead = false;
          throw new Error("transient read failure");
        }
        return now;
      });

      const first = await migrator.runAfterTrigger(10_000, "migration-1");
      expect(first).toMatchObject({
        state: "pending",
        attemptCount: 1,
        error: "legacy_migration_read_failed",
      });
      const deadline = first.deadlineAt;
      expect(deadline).toBe(
        10_000 + CHAT_RUNTIME_BOUNDS.legacyMigrationDeadlineMs,
      );
      expect(migrator.claimBlocked()).toBe(true);
      expect(legacyMigrationBlocksClaim(store.sql)).toBe(true);
      expect(migrator.nextAlarmAt(now)).toBe(
        now + CHAT_RUNTIME_BOUNDS.legacyMigrationRetryMs,
      );

      throwNextRead = true;
      now += 100;
      const second = await migrator.runAfterTrigger(now, "migration-2");
      expect(second).toMatchObject({
        state: "failed",
        attemptCount: CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts,
        error: "legacy_migration_read_failed",
        deadlineAt: deadline,
      });
      expect(migrator.claimBlocked()).toBe(false);
      expect(
        await migrator.runAfterTrigger(now + 1, "migration-3"),
      ).toMatchObject({
        state: "failed",
        attemptCount: CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts,
        changed: false,
      });
    });
  });

  it("terminalizes a pending marker when its admitted turn disappears", async () => {
    await runInDurableObject(
      stub("pending-without-turn"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedPi(instance, [
          { role: "user", content: "old", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
            timestamp: 2,
          },
        ]);
        admitCurrent(store);
        let throwRead = true;
        const migrator = new LegacySessionMigrator(instance.ctx.storage, () => {
          if (throwRead) {
            throwRead = false;
            throw new Error("transient read failure");
          }
          return 10_001;
        });
        const pending = await migrator.runAfterTrigger(10_000, "migration-1");
        expect(pending).toMatchObject({ state: "pending", attemptCount: 1 });

        // Bad tokens report durable state but consume neither a retry nor time.
        expect(await migrator.runAfterTrigger(10_010, "")).toMatchObject({
          state: "pending",
          attemptCount: 1,
          deadlineAt: pending.deadlineAt,
        });
        instance.ctx.storage.sql.exec(
          "DELETE FROM chat_turns_v2 WHERE id = 'current'",
        );

        expect(
          await migrator.runAfterTrigger(10_020, "migration-2"),
        ).toMatchObject({
          state: "failed",
          attemptCount: 1,
          deadlineAt: pending.deadlineAt,
          error: "legacy_migration_admission_missing",
        });
        expect(migrator.claimBlocked()).toBe(false);
      },
    );

    await runInDurableObject(
      stub("pending-deadline"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        seedPi(instance, [
          { role: "user", content: "old", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
            timestamp: 2,
          },
        ]);
        admitCurrent(store);
        let now = 10_001;
        let throwRead = true;
        const migrator = new LegacySessionMigrator(instance.ctx.storage, () => {
          if (throwRead) {
            throwRead = false;
            throw new Error("transient read failure");
          }
          return now;
        });
        const pending = await migrator.runAfterTrigger(10_000, "migration-1");
        now = pending.deadlineAt as number;

        expect(
          await migrator.runAfterTrigger(now, "migration-2"),
        ).toMatchObject({
          state: "failed",
          attemptCount: 1,
          deadlineAt: pending.deadlineAt,
          error: "legacy_migration_deadline",
        });
      },
    );
  });

  it("treats existing V2 history as authoritative without reading legacy", async () => {
    await runInDurableObject(stub("existing-v2"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.replaceSettledHistory(
        {
          threadId: "thread:test",
          workspaceId: "workspace:test",
          orgId: "org:test",
          userId: "user:test",
        },
        [
          {
            id: "forked",
            userContent: "fork context",
            userDisplay: "fork context",
            assistantFinal: "fork answer",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      );
      admitCurrent(store);
      instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (0, 'not json', 1)",
      );
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10_001,
      );

      expect(
        await migrator.runAfterTrigger(10_000, "migration-1"),
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
