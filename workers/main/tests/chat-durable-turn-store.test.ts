import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../src/chat-thread/runtime-lifecycle";
import {
  DurableChatTurnStore,
  type AdmitChatTurn,
  type StoreResult,
} from "../src/chat-thread/durable-turn-store";
import { LegacySessionMigrator } from "../src/chat-thread/legacy-session-migration";
import type { CheckpointProviderBatch } from "../src/chat-thread/turn-checkpoint";

const stub = (name: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(`turn-store-${name}`));
};

const input = (
  id: string,
  content = `model:${id}`,
  display = `display:${id}`,
): AdmitChatTurn => ({
  id,
  clientMessageId: `client:${id}`,
  threadId: "thread:test",
  workspaceId: "workspace:test",
  orgId: "org:test",
  userId: "user:test",
  source: "web",
  userContent: content,
  userDisplay: display,
});

const batch = (callId: string): CheckpointProviderBatch => ({
  providerStateJson: JSON.stringify([
    { type: "toolCall", id: callId, name: "tool", arguments: {} },
  ]),
  calls: [
    {
      id: callId,
      name: "tool",
      inputJson: "{}",
      effectStarted: false,
      result: null,
    },
  ],
});

function completeTurn(
  store: DurableChatTurnStore,
  id: string,
  token: string,
  output: string,
  now: number,
): StoreResult {
  const started = store.startNextInference(id, token, now);
  if (!started.ok)
    throw new Error(`Could not start provider: ${started.reason}`);
  const checkpointed = store.checkpointProviderFinal(id, token, output, now);
  if (!checkpointed.ok) {
    throw new Error(`Could not checkpoint provider: ${checkpointed.reason}`);
  }
  return store.complete(id, token, output, now);
}

async function claimReady(
  instance: any,
  store: DurableChatTurnStore,
  now: number,
  token: string,
): Promise<StoreResult> {
  const migrator = new LegacySessionMigrator(instance.ctx.storage, () => now);
  await migrator.runAfterAdmission(now, `migration:${token}`);
  return store.claim(now, token);
}

describe("durable bounded chat turn store", () => {
  it("upgrades pre-checkpoint V2 rows without replaying unknown work", async () => {
    await runInDurableObject(stub("schema-upgrade"), async (instance: any) => {
      instance.ctx.storage.sql.exec(`CREATE TABLE chat_turns_v2 (
        id TEXT PRIMARY KEY, client_message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL, org_id TEXT NOT NULL,
        user_id TEXT, source TEXT NOT NULL, user_content TEXT NOT NULL,
        user_display TEXT NOT NULL, assistant_final TEXT, assistant_error TEXT,
        status TEXT NOT NULL, payload_bytes INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 1),
        attempt_token TEXT UNIQUE, lease_expires_at INTEGER,
        terminal_deadline_at INTEGER NOT NULL,
        effect_started INTEGER NOT NULL DEFAULT 0,
        retained INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      instance.ctx.storage.sql.exec(`CREATE TABLE chat_runtime_v2 (
        singleton INTEGER PRIMARY KEY, revision INTEGER NOT NULL,
        active_turn_id TEXT, thread_id TEXT, workspace_id TEXT, org_id TEXT
      )`);
      instance.ctx.storage.sql.exec(
        `INSERT INTO chat_turns_v2
          (id, client_message_id, thread_id, workspace_id, org_id, user_id,
           source, user_content, user_display, status, payload_bytes,
           attempt_count, attempt_token, lease_expires_at, terminal_deadline_at,
           effect_started, created_at, updated_at)
         VALUES ('legacy-running', 'legacy-client', 'thread:test',
           'workspace:test', 'org:test', 'user:test', 'web', 'old', 'old',
           'running', 3, 1, 'legacy-token', 5000, 5000, 0, 1, 2)`,
      );
      instance.ctx.storage.sql.exec(
        `INSERT INTO chat_runtime_v2 VALUES
          (1, 1, 'legacy-running', 'thread:test', 'workspace:test', 'org:test')`,
      );

      const store = new DurableChatTurnStore(instance.ctx.storage);
      expect(store.getTurn("legacy-running")).toMatchObject({
        status: "interrupted",
        assistantError: expect.stringContaining("bounded runtime upgrade"),
        checkpoint: { providerCalls: 0, batches: [] },
      });
      expect(store.activeTurn()).toBeNull();
      expect(store.admit(input("new"), 10)).toMatchObject({ ok: true });
      expect(
        await claimReady(instance, store, 11, "legacy-token"),
      ).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect(
        await claimReady(instance, store, 11, "fresh-token"),
      ).toMatchObject({ ok: true });
      expect(store.recoverFromCheckpoint(12, "recovery-token")).toMatchObject({
        ok: true,
        turn: { attemptCount: 2, attemptToken: "recovery-token" },
      });
    });
  });

  it("commits before returning its ACK and deduplicates from durable state", async () => {
    await runInDurableObject(stub("durable-ack"), async (instance: any) => {
      const first = new DurableChatTurnStore(instance.ctx.storage);
      const admitted = first.admit(input("one"), 10);
      expect(admitted).toMatchObject({
        ok: true,
        durable: true,
        duplicate: false,
        turn: { id: "one", status: "queued" },
        shouldArmAlarm: true,
      });

      // A new store instance observes the row before any additional async work.
      const afterRestart = new DurableChatTurnStore(instance.ctx.storage);
      expect(afterRestart.latestSnapshot().messages).toMatchObject([
        { id: "one:user", content: "display:one", status: "queued" },
      ]);
      const duplicate = afterRestart.admit(
        { ...input("replacement"), clientMessageId: "client:one" },
        20,
      );
      expect(duplicate).toMatchObject({
        ok: true,
        duplicate: true,
        turn: { id: "one", clientMessageId: "client:one" },
      });
      expect(duplicate.revision).toBe(admitted.revision);
      expect(afterRestart.readOutbox(0).events).toHaveLength(1);
    });
  });

  it("enforces request, queue-count, and queue-byte caps transactionally", async () => {
    await runInDurableObject(stub("count-caps"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      expect(
        store.admit(
          input("huge", "x".repeat(CHAT_RUNTIME_BOUNDS.requestBytes)),
          0,
        ),
      ).toMatchObject({ ok: false, reason: "request_bytes" });
      expect(store.latestSnapshot().messages).toHaveLength(0);

      for (let index = 0; index < CHAT_RUNTIME_BOUNDS.queueTurns; index += 1) {
        expect(store.admit(input(`q${index}`), index).ok).toBe(true);
      }
      expect(store.admit(input("overflow"), 100)).toMatchObject({
        ok: false,
        reason: "queue_full",
      });
      expect(store.latestSnapshot().messages).toHaveLength(
        CHAT_RUNTIME_BOUNDS.queueTurns,
      );
    });

    await runInDurableObject(stub("byte-caps"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      const body = "x".repeat(220_000);
      for (let index = 0; index < 4; index += 1) {
        expect(store.admit(input(`b${index}`, body, ""), index).ok).toBe(true);
      }
      expect(store.admit(input("bytes-overflow", body, ""), 10)).toMatchObject({
        ok: false,
        reason: "queue_bytes",
      });
    });
  });

  it("claims FIFO once and fences effects and terminal writes by token", async () => {
    await runInDurableObject(stub("token-fence"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.admit(input("first"), 1);
      store.admit(input("second"), 1);
      expect(store.nextAlarmAt(9)).toBe(9);

      expect(await claimReady(instance, store, 10, "attempt-1")).toMatchObject({
        ok: true,
        turn: { id: "first", status: "running", attemptToken: "attempt-1" },
      });
      expect(store.nextAlarmAt(11)).toBe(1 + CHAT_RUNTIME_BOUNDS.turnLeaseMs);
      expect(await claimReady(instance, store, 11, "attempt-2")).toMatchObject({
        ok: false,
        reason: "busy",
      });
      expect(store.startNextInference("first", "attempt-1", 11)).toMatchObject({
        ok: true,
      });
      expect(
        store.checkpointProviderBatch(
          "first",
          "attempt-1",
          batch("call:first"),
          12,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store
          .latestSnapshot()
          .messages.find((message) => message.id === "first:assistant")
          ?.content,
      ).toMatchObject([{ type: "tool_use", id: "call:first" }]);
      expect(
        store.markEffectStarted("first", "old-token", "call:first", 13),
      ).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect(
        store.markEffectStarted("first", "attempt-1", "call:first", 14),
      ).toMatchObject({ ok: true, turn: { effectStarted: true } });
      expect(
        store.recordToolResult(
          "first",
          "attempt-1",
          { callId: "call:first", status: "success", output: "1" },
          15,
        ),
      ).toMatchObject({ ok: true });
      expect(store.startNextInference("first", "attempt-1", 16)).toMatchObject({
        ok: true,
      });
      expect(
        store.checkpointProviderFinal("first", "attempt-1", "done", 17),
      ).toMatchObject({ ok: true });
      expect(store.complete("first", "old-token", "wrong", 18)).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect(store.complete("first", "attempt-1", "done", 19)).toMatchObject({
        ok: true,
        turn: { status: "completed", assistantFinal: "done" },
      });
      expect(
        store
          .latestSnapshot()
          .messages.find((message) => message.id === "first:assistant")
          ?.content,
      ).toMatchObject([
        { type: "tool_use", id: "call:first", name: "tool" },
        { type: "tool_result", tool_use_id: "call:first" },
        { type: "text", text: "done" },
      ]);
      expect(store.nextAlarmAt(20)).toBe(20);

      // Attempt tokens are globally one-shot, including after terminalization.
      expect(await claimReady(instance, store, 20, "attempt-1")).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect(await claimReady(instance, store, 20, "attempt-2")).toMatchObject({
        ok: true,
        turn: { id: "second" },
      });
      expect(
        store.fail("second", "attempt-2", "provider failed", 21),
      ).toMatchObject({
        ok: true,
        turn: { status: "failed", assistantError: "provider failed" },
        shouldArmAlarm: false,
      });
      expect(store.nextAlarmAt(22)).toBeNull();
    });
  });

  it("uses storage deadlines as authority for claim, effects, and completion", async () => {
    await runInDurableObject(stub("claim-deadline"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.admit(input("expired-head"), 0);
      store.admit(input("newer"), 1);
      expect(
        await claimReady(
          instance,
          store,
          CHAT_RUNTIME_BOUNDS.turnLeaseMs,
          "too-late",
        ),
      ).toMatchObject({ ok: false, reason: "idle" });
      expect(store.getTurn("expired-head")?.status).toBe("queued");
      expect(store.getTurn("newer")?.status).toBe("queued");
    });

    await runInDurableObject(stub("effect-deadline"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.admit(input("effect"), 0);
      await claimReady(instance, store, 1, "effect-attempt");
      store.startNextInference("effect", "effect-attempt", 2);
      store.checkpointProviderBatch(
        "effect",
        "effect-attempt",
        batch("call:effect"),
        3,
      );
      expect(
        store.markEffectStarted(
          "effect",
          "effect-attempt",
          "call:effect",
          CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        ),
      ).toMatchObject({
        ok: true,
        turn: { status: "interrupted", effectStarted: false },
      });
      expect(store.readOutbox(0).events.at(-1)?.type).toBe("ExpireOperation");
    });

    await runInDurableObject(
      stub("completion-deadline"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        store.admit(input("complete"), 0);
        await claimReady(instance, store, 1, "complete-attempt");
        expect(
          store.complete(
            "complete",
            "complete-attempt",
            "late answer",
            CHAT_RUNTIME_BOUNDS.turnLeaseMs,
          ),
        ).toMatchObject({
          ok: true,
          turn: { status: "interrupted", assistantFinal: null },
        });
        expect(store.latestSnapshot().messages.at(-1)).toMatchObject({
          status: "interrupted",
          content: expect.stringContaining("late result"),
        });
      },
    );
  });

  it("terminalizes a stale attempt at its lease and continues with queued work", async () => {
    await runInDurableObject(stub("expiry"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.admit(input("crashed"), 0);
      store.admit(input("next"), 1);
      await claimReady(instance, store, 100, "crashed-attempt");

      expect(store.expire(CHAT_RUNTIME_BOUNDS.turnLeaseMs - 1)).toMatchObject({
        ok: false,
        reason: "idle",
      });
      expect(store.expire(CHAT_RUNTIME_BOUNDS.turnLeaseMs)).toMatchObject({
        ok: true,
        turn: {
          id: "crashed",
          status: "interrupted",
          leaseExpiresAt: null,
        },
        shouldArmAlarm: true,
      });
      expect(
        await claimReady(instance, store, 200, "next-attempt"),
      ).toMatchObject({
        ok: true,
        turn: { id: "next", status: "running" },
      });
      const snapshot = store.latestSnapshot();
      expect(snapshot.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "crashed:assistant",
            status: "interrupted",
          }),
        ]),
      );
    });
  });

  it("recovers one provider dispatch with a fresh fence and original limits", async () => {
    await runInDurableObject(
      stub("recover-provider"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        store.admit(input("one"), 10);
        const claimed = await claimReady(instance, store, 20, "old-owner");
        expect(claimed).toMatchObject({
          ok: true,
          turn: { attemptCount: 1 },
        });
        const deadline = claimed.ok ? claimed.turn.terminalDeadlineAt : 0;
        expect(store.startNextInference("one", "old-owner", 21)).toMatchObject({
          ok: true,
          turn: { checkpoint: { providerCalls: 1, providerInFlight: true } },
        });

        const recovered = store.recoverFromCheckpoint(22, "fresh-owner");
        expect(recovered).toMatchObject({
          ok: true,
          turn: {
            status: "running",
            attemptCount: 2,
            attemptToken: "fresh-owner",
            terminalDeadlineAt: deadline,
            checkpoint: { providerCalls: 1, providerInFlight: false },
          },
        });
        expect(
          store.checkpointProviderFinal("one", "old-owner", "late", 23),
        ).toMatchObject({ ok: false, reason: "stale" });
        expect(store.recoverFromCheckpoint(24, "third-owner")).toMatchObject({
          ok: true,
          turn: {
            status: "interrupted",
            assistantError: expect.stringContaining("recovery was exhausted"),
          },
        });
      },
    );
  });

  it("recovers only unstarted or durably completed calls in an exact batch", async () => {
    await runInDurableObject(stub("recover-batch"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.admit(input("one"), 0);
      await claimReady(instance, store, 1, "old-owner");
      store.startNextInference("one", "old-owner", 2);
      const twoCalls: CheckpointProviderBatch = {
        providerStateJson: "[]",
        calls: [...batch("call:a").calls, ...batch("call:b").calls],
      };
      expect(
        store.checkpointProviderBatch("one", "old-owner", twoCalls, 3),
      ).toMatchObject({ ok: true });
      expect(store.startNextInference("one", "old-owner", 4)).toMatchObject({
        ok: false,
        reason: "stale",
      });

      const recovered = store.recoverFromCheckpoint(5, "fresh-owner");
      expect(recovered).toMatchObject({
        ok: true,
        turn: {
          checkpoint: {
            batches: [
              {
                calls: [
                  { id: "call:a", effectStarted: false, result: null },
                  { id: "call:b", effectStarted: false, result: null },
                ],
              },
            ],
          },
        },
      });
      expect(
        store.markEffectStarted("one", "fresh-owner", "call:b", 6),
      ).toMatchObject({ ok: false, reason: "stale" });
      expect(
        store.markEffectStarted("one", "fresh-owner", "call:a", 6),
      ).toMatchObject({ ok: true });
      expect(
        store.recordToolResult(
          "one",
          "fresh-owner",
          { callId: "call:b", status: "success", output: "1" },
          7,
        ),
      ).toMatchObject({ ok: false, reason: "stale" });
      expect(
        store.recordToolResult(
          "one",
          "fresh-owner",
          { callId: "call:a", status: "success", output: "1" },
          7,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.markEffectStarted("one", "fresh-owner", "call:b", 8),
      ).toMatchObject({ ok: true });
      expect(
        store.recordToolResult(
          "one",
          "fresh-owner",
          { callId: "call:b", status: "error", output: '"failed"' },
          9,
        ),
      ).toMatchObject({ ok: true });
      expect(store.startNextInference("one", "fresh-owner", 10)).toMatchObject({
        ok: true,
      });
    });
  });

  it("preserves a durably completed tool result across the one crash recovery", async () => {
    await runInDurableObject(
      stub("recover-completed-result"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        store.admit(input("one"), 0);
        await claimReady(instance, store, 1, "old-owner");
        store.startNextInference("one", "old-owner", 2);
        store.checkpointProviderBatch(
          "one",
          "old-owner",
          {
            providerStateJson: "[]",
            calls: [...batch("call:a").calls, ...batch("call:b").calls],
          },
          3,
        );
        store.markEffectStarted("one", "old-owner", "call:a", 4);
        store.recordToolResult(
          "one",
          "old-owner",
          { callId: "call:a", status: "success", output: '"durable"' },
          5,
        );

        expect(store.recoverFromCheckpoint(6, "fresh-owner")).toMatchObject({
          ok: true,
          turn: {
            status: "running",
            attemptCount: 2,
            checkpoint: {
              batches: [
                {
                  calls: [
                    {
                      id: "call:a",
                      effectStarted: true,
                      result: {
                        callId: "call:a",
                        status: "success",
                        output: '"durable"',
                      },
                    },
                    { id: "call:b", effectStarted: false, result: null },
                  ],
                },
              ],
            },
          },
        });
        expect(
          store.markEffectStarted("one", "fresh-owner", "call:b", 7),
        ).toMatchObject({ ok: true });
      },
    );
  });

  it("terminalizes recovery when BeginEffect has no matching durable result", async () => {
    await runInDurableObject(
      stub("recover-uncertain"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        store.admit(input("one"), 0);
        await claimReady(instance, store, 1, "old-owner");
        store.startNextInference("one", "old-owner", 2);
        store.checkpointProviderBatch("one", "old-owner", batch("call:a"), 3);
        store.markEffectStarted("one", "old-owner", "call:a", 4);

        expect(store.recoverFromCheckpoint(5, "fresh-owner")).toMatchObject({
          ok: true,
          turn: {
            status: "interrupted",
            assistantError: expect.stringContaining(
              "uncertain external effect",
            ),
          },
        });
        expect(store.activeTurn()).toBeNull();
      },
    );
  });

  it("binds trusted scope and expires queued work at its total deadline", async () => {
    await runInDurableObject(stub("scope-deadline"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      expect(store.admit(input("first"), 10)).toMatchObject({ ok: true });
      expect(store.scope()).toEqual({
        threadId: "thread:test",
        workspaceId: "workspace:test",
        orgId: "org:test",
      });
      expect(
        store.admit(
          { ...input("wrong-scope"), workspaceId: "workspace:attacker" },
          11,
        ),
      ).toMatchObject({ ok: false, reason: "invalid" });

      expect(store.expire(10 + CHAT_RUNTIME_BOUNDS.turnLeaseMs)).toMatchObject({
        ok: true,
        turn: {
          id: "first",
          status: "failed",
          assistantError: "Turn expired before execution could begin.",
        },
      });
      expect(
        await claimReady(
          instance,
          store,
          20 + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
          "late",
        ),
      ).toMatchObject({ ok: false, reason: "idle" });
    });
  });

  it("returns only the latest 50 messages within the snapshot byte cap", async () => {
    await runInDurableObject(stub("snapshot-count"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      for (let index = 0; index < 30; index += 1) {
        store.admit(input(`t${index}`), index * 3);
        await claimReady(instance, store, index * 3 + 1, `a${index}`);
        completeTurn(
          store,
          `t${index}`,
          `a${index}`,
          `answer:${index}`,
          index * 3 + 2,
        );
      }
      const snapshot = store.latestSnapshot();
      expect(snapshot.messages).toHaveLength(
        CHAT_RUNTIME_BOUNDS.snapshotMessages,
      );
      expect(snapshot.messages[0].id).toBe("t5:user");
      expect(snapshot.messages.at(-1)?.id).toBe("t29:assistant");
      expect(snapshot.bytes).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.snapshotBytes,
      );

      const outbox = instance.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
           FROM chat_outbox_v2`,
        )
        .one();
      expect(Number(outbox.count)).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.outboxEvents,
      );
      expect(Number(outbox.bytes)).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.outboxBytes,
      );
    });

    await runInDurableObject(stub("snapshot-bytes"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      const large = "é".repeat(110_000); // 220,000 UTF-8 bytes per message.
      for (let index = 0; index < 20; index += 1) {
        store.admit(input(`large${index}`, "", large), index * 3);
        await claimReady(
          instance,
          store,
          index * 3 + 1,
          `large-attempt${index}`,
        );
        completeTurn(
          store,
          `large${index}`,
          `large-attempt${index}`,
          large,
          index * 3 + 2,
        );
      }
      const snapshot = store.latestSnapshot();
      expect(snapshot.messages.length).toBeLessThan(40);
      expect(snapshot.bytes).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.snapshotBytes,
      );
      expect(
        new TextEncoder().encode(JSON.stringify(snapshot.messages)).byteLength,
      ).toBe(snapshot.bytes);
    });
  });

  it("retains a newest max-size answer after worst-case JSON escaping", async () => {
    await runInDurableObject(
      stub("snapshot-escaping"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const answer = "\u0000".repeat(CHAT_RUNTIME_BOUNDS.assistantBytes);
        store.admit(input("escaped", "model question", "visible question"), 0);
        await claimReady(instance, store, 1, "escaped-attempt");
        expect(
          completeTurn(store, "escaped", "escaped-attempt", answer, 2),
        ).toMatchObject({ ok: true, turn: { status: "completed" } });

        const snapshot = store.latestSnapshot();
        expect(snapshot.messages.map(({ role }) => role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(snapshot.messages.at(-1)?.content).toBe(answer);
        expect(snapshot.bytes).toBeGreaterThan(
          CHAT_RUNTIME_BOUNDS.sseWriterBytes,
        );
        expect(snapshot.bytes).toBeLessThanOrEqual(
          CHAT_RUNTIME_BOUNDS.snapshotBytes,
        );
      },
    );
  });

  it("bounds retained terminal history by both turn count and bytes", async () => {
    await runInDurableObject(
      stub("history-retention"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        for (
          let index = 0;
          index < CHAT_RUNTIME_BOUNDS.historyTurns + 12;
          index += 1
        ) {
          const id = `history-${index}`;
          store.admit(input(id), index * 3);
          await claimReady(
            instance,
            store,
            index * 3 + 1,
            `history-attempt-${index}`,
          );
          completeTurn(
            store,
            id,
            `history-attempt-${index}`,
            "ok",
            index * 3 + 2,
          );
        }
        let retained = instance.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) AS count,
            COALESCE(SUM(payload_bytes + length(CAST(COALESCE(
              assistant_final, assistant_error, ''
            ) AS BLOB))), 0) AS bytes
           FROM chat_turns_v2
           WHERE retained = 1
             AND status IN ('completed', 'failed', 'interrupted')`,
          )
          .one();
        expect(Number(retained.count)).toBe(CHAT_RUNTIME_BOUNDS.historyTurns);
        expect(store.latestSnapshot().messages.at(-1)?.id).toBe(
          `history-${CHAT_RUNTIME_BOUNDS.historyTurns + 11}:assistant`,
        );
        const beforeDuplicate = store.latestSnapshot().revision;
        const duplicate = store.admit(
          {
            ...input("replacement"),
            clientMessageId: "client:history-0",
          },
          9_999,
        );
        expect(duplicate).toMatchObject({
          ok: true,
          duplicate: true,
          turn: { id: "history-0", source: "tombstone" },
          revision: beforeDuplicate,
        });
        expect(
          instance.ctx.storage.sql
            .exec(
              "SELECT retained, user_content FROM chat_turns_v2 WHERE id = 'history-0'",
            )
            .one(),
        ).toMatchObject({ retained: 0, user_content: "" });

        const large = "x".repeat(900_000);
        for (let index = 0; index < 10; index += 1) {
          const id = `large-history-${index}`;
          const at = 10_000 + index * 3;
          store.admit(input(id), at);
          await claimReady(
            instance,
            store,
            at + 1,
            `large-history-attempt-${index}`,
          );
          completeTurn(
            store,
            id,
            `large-history-attempt-${index}`,
            large,
            at + 2,
          );
        }
        retained = instance.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) AS count,
            COALESCE(SUM(payload_bytes + length(CAST(COALESCE(
              assistant_final, assistant_error, ''
            ) AS BLOB))), 0) AS bytes
           FROM chat_turns_v2
           WHERE retained = 1
             AND status IN ('completed', 'failed', 'interrupted')`,
          )
          .one();
        expect(Number(retained.count)).toBeLessThanOrEqual(
          CHAT_RUNTIME_BOUNDS.historyTurns,
        );
        expect(Number(retained.bytes)).toBeLessThanOrEqual(
          CHAT_RUNTIME_BOUNDS.historyBytes,
        );
      },
    );
  });

  it("counts forked assistant bytes once when pruning imported history", async () => {
    await runInDurableObject(
      stub("fork-history-byte-accounting"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const assistant = "x".repeat(900_000);
        store.replaceSettledHistory(
          {
            threadId: "thread:test",
            workspaceId: "workspace:test",
            orgId: "org:test",
            userId: "user:test",
          },
          Array.from({ length: 5 }, (_, index) => ({
            id: `fork-${index}`,
            userContent: `question-${index}`,
            userDisplay: `question-${index}`,
            assistantFinal: assistant,
            createdAt: index + 1,
            updatedAt: index + 1,
          })),
        );

        const rows = instance.ctx.storage.sql
          .exec<{ id: string; payload_bytes: number; retained: number }>(
            `SELECT id, payload_bytes, retained FROM chat_turns_v2
              ORDER BY created_at`,
          )
          .toArray();
        expect(rows).toHaveLength(5);
        expect(rows.every((row) => Number(row.retained) === 1)).toBe(true);
        expect(Number(rows[0].payload_bytes)).toBe(
          new TextEncoder().encode(
            JSON.stringify({
              content: "question-0",
              display: "question-0",
            }),
          ).byteLength,
        );
      },
    );
  });

  it("rejects new admissions at the permanent lifetime cap", async () => {
    await runInDurableObject(stub("lifetime-cap"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(
        `WITH RECURSIVE n(value) AS (
           VALUES(0) UNION ALL SELECT value + 1 FROM n WHERE value + 1 < ?
         )
         INSERT INTO chat_turns_v2
           (id, client_message_id, thread_id, workspace_id, org_id, source,
            user_content, user_display, status, payload_bytes,
            terminal_deadline_at, retained, created_at, updated_at)
         SELECT 'cap:' || value, 'cap-client:' || value, 'thread:test',
           'workspace:test', 'org:test', 'tombstone', '', '', 'completed',
           0, 0, 0, value, value FROM n`,
        CHAT_RUNTIME_BOUNDS.admissionsPerThread,
      );
      instance.ctx.storage.sql.exec(
        `UPDATE chat_runtime_v2 SET thread_id = 'thread:test',
         workspace_id = 'workspace:test', org_id = 'org:test'
         WHERE singleton = 1`,
      );

      expect(store.admit(input("one-too-many"), 10_000)).toMatchObject({
        ok: false,
        reason: "thread_full",
      });
      expect(
        Number(
          instance.ctx.storage.sql
            .exec("SELECT COUNT(*) AS count FROM chat_turns_v2")
            .one().count,
        ),
      ).toBe(CHAT_RUNTIME_BOUNDS.admissionsPerThread);
    });
  });

  it("bounds outbox retention and resets stale, missing, and future cursors", async () => {
    await runInDurableObject(stub("outbox-cursors"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      for (let index = 0; index < 90; index += 1) {
        store.admit(input(`o${index}`), index * 3);
        await claimReady(instance, store, index * 3 + 1, `oa${index}`);
        completeTurn(store, `o${index}`, `oa${index}`, "ok", index * 3 + 2);
      }
      const range = instance.ctx.storage.sql
        .exec(
          `SELECT MIN(seq) AS oldest, MAX(seq) AS latest, COUNT(*) AS count,
            COALESCE(SUM(payload_bytes), 0) AS bytes FROM chat_outbox_v2`,
        )
        .one();
      const oldest = Number(range.oldest);
      const latest = Number(range.latest);
      expect(Number(range.count)).toBe(CHAT_RUNTIME_BOUNDS.outboxEvents);
      expect(Number(range.bytes)).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.outboxBytes,
      );

      expect(store.readOutbox(null)).toMatchObject({
        reset: true,
        cursor: latest,
        events: [],
      });
      expect(store.readOutbox(oldest - 2)).toMatchObject({
        reset: true,
        cursor: latest,
        events: [],
      });
      expect(store.readOutbox(latest + 1)).toMatchObject({
        reset: true,
        cursor: latest,
        events: [],
      });
      const replay = store.readOutbox(oldest - 1);
      expect(replay.reset).toBe(false);
      expect(replay.events).toHaveLength(CHAT_RUNTIME_BOUNDS.outboxEvents);
      expect(replay.events[0].seq).toBe(oldest);
      expect(replay.cursor).toBe(latest);
    });

    await runInDurableObject(stub("outbox-bytes"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      instance.ctx.storage.sql.exec(
        `WITH RECURSIVE n(value) AS (
           VALUES(0) UNION ALL SELECT value + 1 FROM n WHERE value < 39
         )
         INSERT INTO chat_outbox_v2
           (revision, event_type, turn_id, status, payload_bytes, created_at)
         SELECT 0, 'DurablyAdmit', 'synthetic:' || value, 'completed', ?, value
         FROM n`,
        CHAT_RUNTIME_BOUNDS.outboxEventBytes,
      );
      expect(store.admit(input("trigger"), 100)).toMatchObject({ ok: true });
      const retained = instance.ctx.storage.sql
        .exec(
          `SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
           FROM chat_outbox_v2`,
        )
        .one();
      expect(Number(retained.count)).toBeLessThan(40);
      expect(Number(retained.bytes)).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.outboxBytes,
      );
    });
  });
});
