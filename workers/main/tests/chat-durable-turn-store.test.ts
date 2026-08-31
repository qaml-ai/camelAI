import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../src/chat-thread/runtime-lifecycle";
import {
  DurableChatTurnStore,
  type AdmitChatTurn,
  type StoreResult,
} from "../src/chat-thread/durable-turn-store";
import { LegacySessionMigrator } from "../src/chat-thread/legacy-session-migration";
import type { CheckpointProviderBatch } from "../src/chat-thread/turn-checkpoint";
import { AUTOMATION_OUTCOME_TOOL } from "../src/chat-thread/automation-turn-report";

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

const retainedHistory = (instance: any) =>
  instance.ctx.storage.sql
    .exec(
      `SELECT COUNT(*) AS count, COALESCE(SUM(
        length(CAST(id AS BLOB)) + length(CAST(client_message_id AS BLOB)) +
        length(CAST(thread_id AS BLOB)) + length(CAST(workspace_id AS BLOB)) +
        length(CAST(org_id AS BLOB)) + length(CAST(COALESCE(user_id, '') AS BLOB)) +
        length(CAST(source AS BLOB)) + length(CAST(user_content AS BLOB)) +
        length(CAST(user_display AS BLOB)) +
        length(CAST(COALESCE(assistant_final, '') AS BLOB)) +
        length(CAST(COALESCE(assistant_error, '') AS BLOB)) +
        length(CAST(COALESCE(assistant_render_json, '') AS BLOB)) +
        length(CAST(COALESCE(automation_json, '') AS BLOB)) +
        length(CAST(status AS BLOB)) +
        length(CAST(COALESCE(attempt_token, '') AS BLOB)) +
        length(CAST(checkpoint_json AS BLOB))
      ), 0) AS bytes FROM chat_turns_v2
       WHERE retained = 1
         AND status IN ('completed', 'failed', 'interrupted')`,
    )
    .one();

function completeTurn(
  store: DurableChatTurnStore,
  id: string,
  token: string,
  output: string,
  now: number,
): StoreResult {
  const started = store.checkpoint(id, token, { type: "start_provider" }, now);
  if (!started.ok)
    throw new Error(`Could not start provider: ${started.reason}`);
  const checkpointed = store.checkpoint(
    id,
    token,
    { type: "provider_final", output },
    now,
  );
  if (!checkpointed.ok) {
    throw new Error(`Could not checkpoint provider: ${checkpointed.reason}`);
  }
  return store.finish(id, token, "completed", output, now);
}

async function claimReady(
  instance: any,
  store: DurableChatTurnStore,
  now: number,
  token: string,
): Promise<StoreResult> {
  const migrator = new LegacySessionMigrator(instance.ctx.storage, () => now);
  await migrator.runAfterTrigger(now, `migration:${token}`);
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
      expect(store.revision()).toBe(2);
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
        duplicate: false,
        turn: { id: "one", status: "queued" },
      });
      const revision = first.revision();

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
      expect(afterRestart.revision()).toBe(revision);
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

  it("rejects huge input without serializing an unbounded copy", async () => {
    await runInDurableObject(
      stub("allocation-free-admit"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const huge = "x".repeat(CHAT_RUNTIME_BOUNDS.requestBytes);
        const stringify = vi.spyOn(JSON, "stringify");
        expect(store.admit(input("huge", huge, huge), 0)).toMatchObject({
          ok: false,
          reason: "request_bytes",
        });
        expect(stringify).not.toHaveBeenCalledWith(
          expect.objectContaining({ userContent: huge }),
        );
        expect(stringify).not.toHaveBeenCalledWith(
          expect.objectContaining({ content: huge }),
        );
        expect(store.scope()).toBeNull();
        stringify.mockRestore();
      },
    );
  });

  it("accounts for escaped and optional admission JSON bytes exactly", async () => {
    await runInDurableObject(
      stub("exact-admit-bytes"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const exact: AdmitChatTurn = {
          ...input("escaped"),
          userId: null,
          userContent: '"\\\n',
          automationRun: {
            workspaceId: "workspace:test",
            automationId: "automation:test",
            runId: "escaped",
            requiresExplicitOutcome: true,
          },
        };
        const encoder = new TextEncoder();
        const base = encoder.encode(JSON.stringify(exact)).byteLength;
        exact.userContent += "x".repeat(
          CHAT_RUNTIME_BOUNDS.requestBytes - base,
        );
        expect(encoder.encode(JSON.stringify(exact))).toHaveLength(
          CHAT_RUNTIME_BOUNDS.requestBytes,
        );
        expect(store.admit(exact, 0)).toMatchObject({ ok: true });
        expect(
          store.admit(
            {
              ...exact,
              id: "escapee",
              clientMessageId: "client:escapee",
              automationRun: { ...exact.automationRun!, runId: "escapee" },
              userContent: `${exact.userContent}x`,
            },
            1,
          ),
        ).toMatchObject({ ok: false, reason: "request_bytes" });
      },
    );
  });

  it("rejects raw automation extras before serialization and stores only normalized keys", async () => {
    await runInDurableObject(stub("automation-admit-shape"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      const huge = "x".repeat(CHAT_RUNTIME_BOUNDS.requestBytes * 2);
      const raw = {
        workspaceId: "workspace:test",
        automationId: "automation:test",
        runId: "bad",
        extra: huge,
      };
      const stringify = vi.spyOn(JSON, "stringify");
      expect(
        store.admit({ ...input("top-extra"), extra: huge } as never, 0),
      ).toMatchObject({ ok: false, reason: "invalid" });
      expect(
        store.admit({ ...input("bad"), automationRun: raw as never }, 0),
      ).toMatchObject({ ok: false, reason: "invalid" });
      expect(stringify).not.toHaveBeenCalledWith(raw);
      expect(store.scope()).toBeNull();
      stringify.mockRestore();

      expect(
        store.admit(
          {
            ...input("good"),
            automationRun: {
              workspaceId: "workspace:test",
              automationId: "automation:test",
              runId: "good",
            },
          },
          1,
        ),
      ).toMatchObject({ ok: true });
      const stored = instance.ctx.storage.sql
        .exec<{ automation_json: string }>(
          "SELECT automation_json FROM chat_turns_v2 WHERE id = 'good'",
        )
        .one().automation_json;
      expect(JSON.parse(stored)).toEqual({
        workspaceId: "workspace:test",
        automationId: "automation:test",
        runId: "good",
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
      expect(
        store.checkpoint("first", "attempt-1", { type: "start_provider" }, 11),
      ).toMatchObject({
        ok: true,
      });
      expect(
        store.checkpoint(
          "first",
          "attempt-1",
          { type: "provider_batch", batch: batch("call:first") },
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
        store.checkpoint(
          "first",
          "old-token",
          { type: "begin_effect", callId: "call:first" },
          13,
        ),
      ).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect(
        store.checkpoint(
          "first",
          "attempt-1",
          { type: "begin_effect", callId: "call:first" },
          14,
        ),
      ).toMatchObject({ ok: true, turn: { effectStarted: true } });
      expect(
        store.checkpoint(
          "first",
          "attempt-1",
          {
            type: "tool_result",
            result: { callId: "call:first", status: "success", output: "1" },
          },
          15,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.checkpoint("first", "attempt-1", { type: "start_provider" }, 16),
      ).toMatchObject({
        ok: true,
      });
      expect(
        store.checkpoint(
          "first",
          "attempt-1",
          { type: "provider_final", output: "done" },
          17,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.finish("first", "old-token", "completed", "wrong", 18),
      ).toMatchObject({
        ok: false,
        reason: "stale",
      });
      expect(
        store.finish("first", "attempt-1", "completed", "done", 19),
      ).toMatchObject({
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
        store.finish("second", "attempt-2", "failed", "provider failed", 21),
      ).toMatchObject({
        ok: true,
        turn: { status: "failed", assistantError: "provider failed" },
      });
      expect(store.nextAlarmAt(22)).toBeNull();
    });
  });

  it("rejects a malformed checkpoint mutation without persisting it", async () => {
    await runInDurableObject(
      stub("malformed-checkpoint-mutation"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        expect(store.admit(input("one"), 1)).toMatchObject({ ok: true });
        expect(await claimReady(instance, store, 2, "owner")).toMatchObject({
          ok: true,
        });
        expect(
          store.checkpoint("one", "owner", { type: "start_provider" }, 3),
        ).toMatchObject({ ok: true });
        const before = instance.ctx.storage.sql
          .exec<{
            checkpoint_json: string;
          }>("SELECT checkpoint_json FROM chat_turns_v2 WHERE id = 'one'")
          .one().checkpoint_json;
        const revision = store.latestSnapshot().revision;

        const rejected = store.checkpoint(
          "one",
          "owner",
          {
            type: "provider_batch",
            batch: { ...batch("malformed"), providerStateJson: "[" },
          },
          4,
        );

        expect(rejected).toMatchObject({ ok: false, reason: "invalid" });
        expect(
          instance.ctx.storage.sql
            .exec<{
              checkpoint_json: string;
            }>("SELECT checkpoint_json FROM chat_turns_v2 WHERE id = 'one'")
            .one().checkpoint_json,
        ).toBe(before);
        expect(store.latestSnapshot().revision).toBe(revision);
        expect(store.getTurn("one")?.checkpoint).toMatchObject({
          providerCalls: 1,
          providerInFlight: true,
          batches: [],
        });
      },
    );
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
      store.checkpoint(
        "effect",
        "effect-attempt",
        { type: "start_provider" },
        2,
      );
      store.checkpoint(
        "effect",
        "effect-attempt",
        { type: "provider_batch", batch: batch("call:effect") },
        3,
      );
      expect(
        store.checkpoint(
          "effect",
          "effect-attempt",
          { type: "begin_effect", callId: "call:effect" },
          CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        ),
      ).toMatchObject({
        ok: true,
        turn: { status: "interrupted", effectStarted: false },
      });
      expect(store.getTurn("effect")?.status).toBe("interrupted");
    });

    await runInDurableObject(
      stub("completion-deadline"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        store.admit(input("complete"), 0);
        await claimReady(instance, store, 1, "complete-attempt");
        expect(
          store.finish(
            "complete",
            "complete-attempt",
            "completed",
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
      });
      expect(store.nextAlarmAt(200)).toBe(200);
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
        expect(
          store.checkpoint("one", "old-owner", { type: "start_provider" }, 21),
        ).toMatchObject({
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
          store.checkpoint(
            "one",
            "old-owner",
            { type: "provider_final", output: "late" },
            23,
          ),
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
      store.checkpoint("one", "old-owner", { type: "start_provider" }, 2);
      const twoCalls: CheckpointProviderBatch = {
        providerStateJson: "[]",
        calls: [...batch("call:a").calls, ...batch("call:b").calls],
      };
      expect(
        store.checkpoint(
          "one",
          "old-owner",
          { type: "provider_batch", batch: twoCalls },
          3,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.checkpoint("one", "old-owner", { type: "start_provider" }, 4),
      ).toMatchObject({
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
        store.checkpoint(
          "one",
          "fresh-owner",
          { type: "begin_effect", callId: "call:b" },
          6,
        ),
      ).toMatchObject({ ok: false, reason: "stale" });
      expect(
        store.checkpoint(
          "one",
          "fresh-owner",
          { type: "begin_effect", callId: "call:a" },
          6,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.checkpoint(
          "one",
          "fresh-owner",
          {
            type: "tool_result",
            result: { callId: "call:b", status: "success", output: "1" },
          },
          7,
        ),
      ).toMatchObject({ ok: false, reason: "stale" });
      expect(
        store.checkpoint(
          "one",
          "fresh-owner",
          {
            type: "tool_result",
            result: { callId: "call:a", status: "success", output: "1" },
          },
          7,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.checkpoint(
          "one",
          "fresh-owner",
          { type: "begin_effect", callId: "call:b" },
          8,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.checkpoint(
          "one",
          "fresh-owner",
          {
            type: "tool_result",
            result: { callId: "call:b", status: "error", output: '"failed"' },
          },
          9,
        ),
      ).toMatchObject({ ok: true });
      expect(
        store.checkpoint("one", "fresh-owner", { type: "start_provider" }, 10),
      ).toMatchObject({
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
        store.checkpoint("one", "old-owner", { type: "start_provider" }, 2);
        store.checkpoint(
          "one",
          "old-owner",
          {
            type: "provider_batch",
            batch: {
              providerStateJson: "[]",
              calls: [...batch("call:a").calls, ...batch("call:b").calls],
            },
          },
          3,
        );
        store.checkpoint(
          "one",
          "old-owner",
          { type: "begin_effect", callId: "call:a" },
          4,
        );
        store.checkpoint(
          "one",
          "old-owner",
          {
            type: "tool_result",
            result: {
              callId: "call:a",
              status: "success",
              output: '"durable"',
            },
          },
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
          store.checkpoint(
            "one",
            "fresh-owner",
            { type: "begin_effect", callId: "call:b" },
            7,
          ),
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
        store.checkpoint("one", "old-owner", { type: "start_provider" }, 2);
        store.checkpoint(
          "one",
          "old-owner",
          { type: "provider_batch", batch: batch("call:a") },
          3,
        );
        store.checkpoint(
          "one",
          "old-owner",
          { type: "begin_effect", callId: "call:a" },
          4,
        );

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

  it("retains a bounded newest answer after worst-case JSON escaping", async () => {
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
        const projected = snapshot.messages.at(-1)?.content;
        expect(typeof projected).toBe("string");
        expect((projected as string).endsWith("…")).toBe(true);
        expect((projected as string).length).toBeLessThan(answer.length);
        expect(snapshot.bytes).toBeLessThanOrEqual(
          CHAT_RUNTIME_BOUNDS.snapshotBytes,
        );
        expect(snapshot.bytes).toBeLessThan(CHAT_RUNTIME_BOUNDS.sseWriterBytes);
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
        let retained = retainedHistory(instance);
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
        });
        expect(store.latestSnapshot().revision).toBe(beforeDuplicate);
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
        retained = retainedHistory(instance);
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

  it("counts both final text and rendered tool transcripts in retained bytes", async () => {
    await runInDurableObject(
      stub("tool-history-byte-accounting"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const answer = "x".repeat(900_000);
        for (let index = 0; index < 5; index += 1) {
          const id = `tool-history-${index}`;
          const token = `tool-history-owner-${index}`;
          const at = index * 10;
          store.admit(input(id), at);
          await claimReady(instance, store, at + 1, token);
          store.checkpoint(id, token, { type: "start_provider" }, at + 2);
          store.checkpoint(
            id,
            token,
            { type: "provider_batch", batch: batch(`call:${index}`) },
            at + 3,
          );
          store.checkpoint(
            id,
            token,
            { type: "begin_effect", callId: `call:${index}` },
            at + 4,
          );
          store.checkpoint(
            id,
            token,
            {
              type: "tool_result",
              result: {
                callId: `call:${index}`,
                status: "success",
                output: '"ok"',
              },
            },
            at + 5,
          );
          store.checkpoint(id, token, { type: "start_provider" }, at + 6);
          store.checkpoint(
            id,
            token,
            { type: "provider_final", output: answer },
            at + 7,
          );
          store.finish(id, token, "completed", answer, at + 8);
        }

        const retained = retainedHistory(instance);
        expect(Number(retained.count)).toBeLessThan(5);
        expect(Number(retained.bytes)).toBeLessThanOrEqual(
          CHAT_RUNTIME_BOUNDS.historyBytes,
        );
        expect(
          Number(
            instance.ctx.storage.sql
              .exec(
                `SELECT COUNT(*) AS count FROM chat_turns_v2
                 WHERE retained = 1 AND assistant_final IS NOT NULL
                   AND assistant_render_json IS NOT NULL`,
              )
              .one().count,
          ),
        ).toBeGreaterThan(0);
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

  it("uses the scalar runtime revision as its change cursor", async () => {
    await runInDurableObject(stub("revision-cursor"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      expect(store.revision()).toBe(0);
      store.admit(input("one"), 1);
      expect(store.revision()).toBe(1);
    });
  });

  it("atomically derives and queues one bounded automation report from the checkpoint", async () => {
    await runInDurableObject(
      stub("automation-report"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const runId = "automation-run:one";
        expect(
          store.admit(
            {
              ...input(runId),
              automationRun: {
                workspaceId: "workspace:test",
                automationId: "automation:one",
                runId,
                requiresExplicitOutcome: true,
              },
            },
            10,
          ),
        ).toMatchObject({ ok: true, turn: { automationRun: { runId } } });
        await claimReady(instance, store, 11, "automation-owner");
        store.checkpoint(
          runId,
          "automation-owner",
          { type: "start_provider" },
          12,
        );
        store.checkpoint(
          runId,
          "automation-owner",
          {
            type: "provider_batch",
            batch: {
              providerStateJson: "[]",
              calls: [
                {
                  id: "outcome-call",
                  name: AUTOMATION_OUTCOME_TOOL,
                  inputJson: JSON.stringify({
                    status: "success",
                    summary: "Verified the scheduled work.",
                  }),
                  effectStarted: false,
                  result: null,
                },
              ],
            },
          },
          13,
        );
        store.checkpoint(
          runId,
          "automation-owner",
          { type: "begin_effect", callId: "outcome-call" },
          14,
        );
        store.checkpoint(
          runId,
          "automation-owner",
          {
            type: "tool_result",
            result: {
              callId: "outcome-call",
              status: "success",
              output: JSON.stringify({
                content: [{ type: "text", text: "recorded" }],
              }),
            },
          },
          15,
        );
        expect(store.recordedAutomationOutcome(runId)).toEqual({
          status: "success",
          summary: "Verified the scheduled work.",
        });
        store.checkpoint(
          runId,
          "automation-owner",
          { type: "start_provider" },
          16,
        );
        store.checkpoint(
          runId,
          "automation-owner",
          { type: "provider_final", output: "done" },
          17,
        );
        expect(
          store.finish(runId, "automation-owner", "completed", "done", 18),
        ).toMatchObject({
          ok: true,
          turn: { status: "completed", checkpoint: { batches: [] } },
        });

        const report = store.claimAutomationReport(18);
        expect(report).toMatchObject({
          turnId: runId,
          runId,
          automationId: "automation:one",
          attempt: 1,
          status: "success",
          message: "Verified the scheduled work.",
          completedAt: 18,
        });
        instance.ctx.storage.sql.exec(
          `WITH RECURSIVE n(value) AS (
             VALUES(0) UNION ALL SELECT value + 1 FROM n WHERE value + 1 < ?
           )
           INSERT INTO chat_turns_v2
             (id, client_message_id, thread_id, workspace_id, org_id, source,
              user_content, user_display, assistant_final, status, payload_bytes,
              terminal_deadline_at, created_at, updated_at)
           SELECT 'report-history:' || value, 'report-history-client:' || value,
             'thread:test', 'workspace:test', 'org:test', 'web', 'q', 'q',
             'a', 'completed', 2, 0, 100 + value, 100 + value FROM n`,
          CHAT_RUNTIME_BOUNDS.historyTurns,
        );
        expect(
          instance.ctx.storage.sql
            .exec(
              "SELECT retained, automation_json FROM chat_turns_v2 WHERE id = ?",
              runId,
            )
            .one(),
        ).toMatchObject({ retained: 1 });
        expect(store.completeAutomationReport(runId, report!.attempt)).toBe(
          true,
        );
        expect(
          instance.ctx.storage.sql
            .exec(
              `SELECT retained, automation_json, automation_report_at
               FROM chat_turns_v2 WHERE id = ?`,
              runId,
            )
            .one(),
        ).toMatchObject({
          retained: 0,
          automation_json: null,
          automation_report_at: null,
        });
        expect(store.nextAlarmAt(18)).toBeNull();
      },
    );
  });

  it("queues an explicit error when an automation terminalizes without an outcome", async () => {
    await runInDurableObject(
      stub("automation-failure"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const runId = "automation-run:failed";
        store.admit(
          {
            ...input(runId),
            automationRun: {
              workspaceId: "workspace:test",
              automationId: "automation:failed",
              runId,
              requiresExplicitOutcome: true,
            },
          },
          10,
        );
        await claimReady(instance, store, 11, "failed-owner");
        store.finish(
          runId,
          "failed-owner",
          "failed",
          "Provider failed safely",
          12,
        );
        const report = store.claimAutomationReport(12);
        expect(report).toMatchObject({
          status: "error",
          message: "Provider failed safely",
        });
        expect(store.claimAutomationReport(report!.deadlineAt)).toBeNull();
        expect(
          instance.ctx.storage.sql
            .exec(
              `SELECT automation_json, automation_report_at
               FROM chat_turns_v2 WHERE id = ?`,
              runId,
            )
            .one(),
        ).toEqual({ automation_json: null, automation_report_at: null });
      },
    );
  });
});
