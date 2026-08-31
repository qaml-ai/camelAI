import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { DurableChatTurnStore } from "../src/chat-thread/durable-turn-store";
import { DurableTurnDriver } from "../src/chat-thread/durable-turn-driver";
import { BoundedTurnError } from "../src/chat-thread/bounded-turn-runner";
import { LegacySessionMigrator } from "../src/chat-thread/legacy-session-migration";
import { CHAT_RUNTIME_BOUNDS } from "../src/chat-thread/runtime-lifecycle";

const stub = (name: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(`turn-driver-${name}`));
};

const admit = (store: DurableChatTurnStore, id: string, now = 0) =>
  store.admit(
    {
      id,
      clientMessageId: `client:${id}`,
      threadId: "thread:test",
      workspaceId: "workspace:test",
      orgId: "org:test",
      userId: "user:test",
      source: "web",
      userContent: `model:${id}`,
      userDisplay: `display:${id}`,
    },
    now,
  );

function driverContext(
  instance: any,
  order?: string[],
  abort: (reason?: string) => void = () => undefined,
): DurableObjectState {
  return {
    storage: {
      setAlarm: async (at: number) => {
        order?.push(`alarm:${at}`);
      },
      deleteAlarm: async () => {
        order?.push("alarm:delete");
      },
    },
    waitUntil: (task: Promise<unknown>) => instance.ctx.waitUntil(task),
    abort,
  } as unknown as DurableObjectState;
}

describe("single durable turn driver", () => {
  it("migrates bounded legacy history before claim without resetting the queued deadline", async () => {
    await runInDurableObject(
      stub("legacy-before-claim"),
      async (instance: any) => {
        instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
        idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
        instance.ctx.storage.sql.exec(
          `INSERT INTO pi_core_messages (idx, payload, created_at) VALUES
          (1, ?, 1), (2, ?, 2)`,
          JSON.stringify({
            role: "user",
            content: "old question",
            timestamp: 1,
          }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "old answer" }],
            timestamp: 2,
          }),
        );
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const admitted = admit(store, "current", 10);
        const originalDeadline = admitted.ok
          ? admitted.turn.terminalDeadlineAt
          : null;
        const migrator = new LegacySessionMigrator(
          instance.ctx.storage,
          () => 20,
        );
        const tokens = ["migration-owner", "turn-owner"];
        const run = vi.fn(
          async ({ turn, startNextInference, checkpointProviderFinal }) => {
            expect(turn).toMatchObject({
              id: "current",
              attemptCount: 1,
              terminalDeadlineAt: originalDeadline,
            });
            expect(store.getTurn("legacy:pi:1")).toMatchObject({
              status: "completed",
              userContent: "old question",
              assistantFinal: "old answer",
            });
            await startNextInference();
            await checkpointProviderFinal("continued");
            return "continued";
          },
        );
        const driver = new DurableTurnDriver({
          ctx: driverContext(instance),
          store,
          migrator,
          run,
          publish: vi.fn(),
          now: () => 20,
          token: () => tokens.shift() ?? "unexpected-token",
        });

        await driver.alarm();

        expect(run).toHaveBeenCalledOnce();
        expect(migrator.status()).toMatchObject({
          state: "complete",
          attemptCount: 1,
          importedTurns: 1,
        });
        expect(store.getTurn("current")).toMatchObject({
          status: "completed",
          terminalDeadlineAt: originalDeadline,
        });
        expect(store.revision()).toBeGreaterThan(0);
      },
    );
  });

  it("pre-arms the crash alarm, executes once, and commits a terminal answer", async () => {
    await runInDurableObject(stub("success"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      admit(store, "one", 10);
      const order: string[] = [];
      const publish = vi.fn();
      const run = vi.fn(
        async ({ startNextInference, checkpointProviderFinal }) => {
          order.push("run");
          await startNextInference();
          await checkpointProviderFinal("finished");
          return "finished";
        },
      );
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 20,
      );
      const driver = new DurableTurnDriver({
        ctx: driverContext(instance, order),
        store,
        migrator,
        run,
        publish,
        now: () => 20,
        token: () => "attempt:one",
      });

      await driver.alarm();

      expect(run).toHaveBeenCalledOnce();
      expect(order[0]).toMatch(/^alarm:/);
      expect(order.indexOf("run")).toBeGreaterThan(0);
      expect(store.activeTurn()).toBeNull();
      expect(store.latestSnapshot().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "one:assistant",
            content: "finished",
            status: "completed",
          }),
        ]),
      );
      expect(publish.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("aborts a local isolate whose alarm write does not settle", async () => {
    vi.useFakeTimers();
    try {
      await runInDurableObject(stub("alarm-timeout"), async (instance: any) => {
        const context = driverContext(instance);
        context.storage.setAlarm = () => new Promise<void>(() => undefined);
        const abort = vi.spyOn(context, "abort");
        const driver = new DurableTurnDriver({
          ctx: context,
          store: new DurableChatTurnStore(instance.ctx.storage),
          migrator: new LegacySessionMigrator(instance.ctx.storage),
          run: vi.fn(),
          publish: vi.fn(),
        });
        const kick = driver.kick().catch((error) => error);
        await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.alarmWriteMs);
        expect(await kick).toEqual(
          expect.objectContaining({ message: "Alarm write timed out" }),
        );
        expect(abort).toHaveBeenCalledWith("Alarm write timed out");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an idle surplus alarm instead of racing a future admission", async () => {
    await runInDurableObject(stub("surplus-alarm"), async (instance: any) => {
      const context = driverContext(instance);
      const deleteAlarm = vi.spyOn(context.storage, "deleteAlarm");
      const driver = new DurableTurnDriver({
        ctx: context,
        store: new DurableChatTurnStore(instance.ctx.storage),
        migrator: new LegacySessionMigrator(instance.ctx.storage),
        run: vi.fn(),
        publish: vi.fn(),
      });
      await driver.alarm();
      expect(deleteAlarm).not.toHaveBeenCalled();
    });
  });

  it("interrupts an attempt owned by a dead isolate and never regenerates it", async () => {
    await runInDurableObject(stub("crash"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      admit(store, "crashed", 0);
      admit(store, "next", 1);
      const migrator = new LegacySessionMigrator(instance.ctx.storage, () => 4);
      await migrator.runAfterTrigger(2, "migration:crash");
      store.claim(2, "dead-owner");
      store.checkpoint("crashed", "dead-owner", { type: "start_provider" }, 3);
      store.checkpoint(
        "crashed",
        "dead-owner",
        {
          type: "provider_batch",
          batch: {
            providerStateJson: "[]",
            calls: [
              {
                id: "call:crashed",
                name: "tool",
                inputJson: "{}",
                effectStarted: false,
                result: null,
              },
            ],
          },
        },
        3,
      );
      store.checkpoint(
        "crashed",
        "dead-owner",
        { type: "begin_effect", callId: "call:crashed" },
        3,
      );
      const run = vi.fn(
        async ({ startNextInference, checkpointProviderFinal }) => {
          await startNextInference();
          await checkpointProviderFinal("next completed");
          return "next completed";
        },
      );
      const driver = new DurableTurnDriver({
        ctx: driverContext(instance),
        store,
        migrator,
        run,
        publish: vi.fn(),
        now: () => 4,
        token: () => "new-owner",
      });

      // Reconciliation consumes this alarm invocation; it does not also claim.
      await driver.alarm();
      expect(run).not.toHaveBeenCalled();
      expect(store.latestSnapshot().messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "crashed:assistant",
            status: "interrupted",
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("uncertain external effect"),
              }),
            ]),
          }),
        ]),
      );

      await driver.alarm();
      expect(run).toHaveBeenCalledOnce();
      expect(store.latestSnapshot().messages.at(-1)).toMatchObject({
        id: "next:assistant",
        status: "completed",
      });
    });
  });

  it("recovers one safe checkpoint with a fresh attempt before executing", async () => {
    await runInDurableObject(stub("safe-recovery"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      admit(store, "one", 0);
      const migrator = new LegacySessionMigrator(instance.ctx.storage, () => 3);
      await migrator.runAfterTrigger(1, "migration:safe-recovery");
      const claimed = store.claim(1, "dead-owner");
      store.checkpoint("one", "dead-owner", { type: "start_provider" }, 2);
      const originalDeadline = claimed.ok ? claimed.turn.terminalDeadlineAt : 0;
      const run = vi.fn(
        async ({ turn, startNextInference, checkpointProviderFinal }) => {
          expect(turn).toMatchObject({
            attemptCount: 2,
            attemptToken: "fresh-owner",
            terminalDeadlineAt: originalDeadline,
            checkpoint: { providerCalls: 1, providerInFlight: false },
          });
          await startNextInference();
          await checkpointProviderFinal("recovered");
          return "recovered";
        },
      );
      const driver = new DurableTurnDriver({
        ctx: driverContext(instance),
        store,
        migrator,
        run,
        publish: vi.fn(),
        now: () => 3,
        token: () => "fresh-owner",
      });

      await driver.alarm();

      expect(run).toHaveBeenCalledOnce();
      expect(store.latestSnapshot().messages.at(-1)).toMatchObject({
        id: "one:assistant",
        content: "recovered",
        status: "completed",
      });
    });
  });

  it("stop terminalizes immediately and fences a late runner result", async () => {
    await runInDurableObject(stub("stop"), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      admit(store, "one");
      const migrator = new LegacySessionMigrator(
        instance.ctx.storage,
        () => 10,
      );
      let release!: (value: string) => void;
      const late = new Promise<string>((resolve) => (release = resolve));
      const driver = new DurableTurnDriver({
        ctx: driverContext(instance),
        store,
        migrator,
        run: () => late,
        publish: vi.fn(),
        now: () => 10,
        token: () => "attempt:one",
      });

      const alarm = driver.alarm();
      await vi.waitFor(() => expect(store.activeTurn()?.id).toBe("one"));
      expect(await driver.stop()).toBe(true);
      release("too late");
      await alarm;

      expect(store.latestSnapshot().messages.at(-1)).toMatchObject({
        id: "one:assistant",
        status: "interrupted",
      });
      expect(
        store
          .latestSnapshot()
          .messages.some((message) => message.content.includes("too late")),
      ).toBe(false);
    });
  });

  it("commits a tool timeout before evicting its uncancellable isolate", async () => {
    await runInDurableObject(
      stub("tool-timeout-abort"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        admit(store, "one", 10);
        const order: string[] = [];
        const abortInstance = vi.fn((reason?: string) => {
          order.push(`abort:${reason}`);
        });
        const migrator = new LegacySessionMigrator(
          instance.ctx.storage,
          () => 20,
        );
        const driver = new DurableTurnDriver({
          ctx: driverContext(instance, order, abortInstance),
          store,
          migrator,
          run: async ({
            startNextInference,
            checkpointProviderBatch,
            beginEffect,
          }) => {
            await startNextInference();
            await checkpointProviderBatch({
              providerStateJson: "[]",
              calls: [
                {
                  id: "call:timeout",
                  name: "tool",
                  inputJson: "{}",
                  effectStarted: false,
                  result: null,
                },
              ],
            });
            await beginEffect("call:timeout");
            throw new BoundedTurnError("tool_timeout", "tool timeout expired");
          },
          publish: vi.fn(),
          now: () => 20,
          token: () => "attempt:timeout",
        });

        await driver.alarm();

        expect(store.activeTurn()).toBeNull();
        expect(store.latestSnapshot().messages.at(-1)).toMatchObject({
          id: "one:assistant",
          status: "failed",
          content: [{ type: "text", text: "tool timeout expired" }],
        });
        expect(abortInstance).toHaveBeenCalledWith(
          "Uncancellable chat operation exceeded its deadline",
        );
        expect(order.at(-1)).toContain("abort:Uncancellable chat operation");
        expect(
          order.slice(0, -1).some((entry) => entry.startsWith("alarm:")),
        ).toBe(true);
      },
    );
  });

  it("drains at most one automation report per alarm and stops after finite attempts", async () => {
    await runInDurableObject(
      stub("automation-retries"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        const runId = "scheduled-run";
        store.admit(
          {
            id: runId,
            clientMessageId: runId,
            threadId: "thread:test",
            workspaceId: "workspace:test",
            orgId: "org:test",
            userId: "user:test",
            source: "scheduled prompt",
            userContent: "run",
            userDisplay: "run",
            automationRun: {
              workspaceId: "workspace:test",
              automationId: "scheduled-prompt",
              runId,
              requiresExplicitOutcome: true,
            },
          },
          20,
        );
        let now = 20;
        const tokens = ["migration-owner", "turn-owner"];
        const reportAutomation = vi.fn(async () => false);
        const driver = new DurableTurnDriver({
          ctx: driverContext(instance),
          store,
          migrator: new LegacySessionMigrator(instance.ctx.storage, () => now),
          run: async ({ startNextInference, checkpointProviderFinal }) => {
            await startNextInference();
            await checkpointProviderFinal("finished without a report");
            return "finished without a report";
          },
          publish: vi.fn(),
          reportAutomation,
          now: () => now,
          token: () => tokens.shift() ?? "unused-token",
        });

        await driver.alarm();
        expect(reportAutomation).not.toHaveBeenCalled();
        for (
          let attempt = 1;
          attempt <= CHAT_RUNTIME_BOUNDS.automationReportAttempts;
          attempt += 1
        ) {
          await driver.alarm();
          expect(reportAutomation).toHaveBeenCalledTimes(attempt);
          expect(reportAutomation.mock.calls.at(-1)?.[0]).toMatchObject({
            attempt,
            runId,
            status: "error",
            message:
              "Automation completed without explicitly reporting an outcome",
          });
          now += CHAT_RUNTIME_BOUNDS.automationReportRetryMs;
        }
        await driver.alarm();
        expect(reportAutomation).toHaveBeenCalledTimes(
          CHAT_RUNTIME_BOUNDS.automationReportAttempts,
        );
        expect(store.nextAlarmAt(now)).toBeNull();
      },
    );
  });

  it("bounds a hung automation-report RPC without reopening the terminal turn", async () => {
    vi.useFakeTimers();
    try {
      await runInDurableObject(
        stub("automation-timeout"),
        async (instance: any) => {
          const store = new DurableChatTurnStore(instance.ctx.storage);
          const runId = "timed-report";
          store.admit(
            {
              id: runId,
              clientMessageId: runId,
              threadId: "thread:test",
              workspaceId: "workspace:test",
              orgId: "org:test",
              userId: null,
              source: "scheduled prompt",
              userContent: "run",
              userDisplay: "run",
              automationRun: {
                workspaceId: "workspace:test",
                automationId: "prompt",
                runId,
              },
            },
            10,
          );
          const migrator = new LegacySessionMigrator(
            instance.ctx.storage,
            () => 11,
          );
          await migrator.runAfterTrigger(11, "migration-timeout");
          store.claim(11, "owner-timeout");
          store.finish(runId, "owner-timeout", "failed", "turn failed", 12);
          const error = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
          const driver = new DurableTurnDriver({
            ctx: driverContext(instance),
            store,
            migrator,
            run: vi.fn(),
            publish: vi.fn(),
            now: () => 12,
            reportAutomation: () => new Promise<boolean>(() => undefined),
          });
          const alarm = driver.alarm();
          await vi.advanceTimersByTimeAsync(
            CHAT_RUNTIME_BOUNDS.automationReportAttemptMs,
          );
          await alarm;
          expect(store.getTurn(runId)).toMatchObject({ status: "failed" });
          expect(
            store.claimAutomationReport(
              12 + CHAT_RUNTIME_BOUNDS.automationReportRetryMs,
            )?.attempt,
          ).toBe(2);
          error.mockRestore();
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
