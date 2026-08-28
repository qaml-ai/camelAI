import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  CHAT_RUNTIME_KV_KEYS,
  ChatThreadRuntimeDO,
} from "../src/chat-thread/chat-thread-runtime-do";
import type { BoundedTurnAdapter } from "../src/chat-thread/bounded-turn-runner";
import type { DurableTurnDriver } from "../src/chat-thread/durable-turn-driver";
import { DurableChatTurnStore } from "../src/chat-thread/durable-turn-store";
import { LegacySessionMigrator } from "../src/chat-thread/legacy-session-migration";
import type { ChatEnv } from "../src/chat-thread/types";

const threadStub = (name: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(`runtime-do-${name}`));
};

const runtimeRequest = () =>
  new Request(
    "https://runtime.test/agents/chat-thread/thread-1/v2/events" +
      "?threadId=thread-1&workspaceId=workspace-1&orgId=org-1",
    { headers: { "X-Chiridion-User-Id": "user-1" } },
  );

async function finishLegacyMigration(
  storage: DurableObjectStorage,
  store: DurableChatTurnStore,
  now: number,
): Promise<void> {
  const migrator = new LegacySessionMigrator(storage, () => now);
  await migrator.runAfterTrigger(now, `migration:${now}`);
  expect(migrator.claimBlocked()).toBe(false);
  expect(store.nextAlarmAt(now)).not.toBeNull();
}

class ColdRuntime extends ChatThreadRuntimeDO {
  protected override createStore(): DurableChatTurnStore {
    throw new Error("cold storage unavailable");
  }

  protected override createDriver(): DurableTurnDriver {
    return { kick: vi.fn() } as unknown as DurableTurnDriver;
  }
}

describe("framework-free ChatThreadRuntimeDO", () => {
  it("returns an SSE heartbeat even when cold storage startup fails", async () => {
    await runInDurableObject(threadStub("cold"), async (instance: any) => {
      const runtime = new ColdRuntime(instance.ctx, env as unknown as ChatEnv);
      const response = await runtime.fetch(runtimeRequest());
      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(":hb\n\n");
      await reader.cancel();
    });
  });

  it("does not inspect tool values when no matching eval run is active", async () => {
    await runInDurableObject(
      threadStub("inactive-eval-tool"),
      async (instance: any) => {
        const runtime = new ChatThreadRuntimeDO(
          instance.ctx,
          env as unknown as ChatEnv,
        );
        const inputToJson = vi.fn(() => ({ leaked: true }));
        const resultToJson = vi.fn(() => ({ leaked: true }));
        const result = { toJSON: resultToJson };
        const adapter: BoundedTurnAdapter = {
          readContext: () => [],
          callProvider: async () => ({ kind: "assistant", content: "done" }),
          callTool: async () => result,
        };
        const wrapped = (
          runtime as unknown as {
            captureEvalTools(value: BoundedTurnAdapter): BoundedTurnAdapter;
          }
        ).captureEvalTools(adapter);
        await wrapped.callProvider({
          turn: { id: "ordinary-turn" } as never,
          context: [],
          toolBatches: [],
          signal: new AbortController().signal,
        });
        const returned = await wrapped.callTool(
          {
            id: "call:ordinary",
            name: "inspect",
            input: { toJSON: inputToJson },
          },
          new AbortController().signal,
        );

        expect(returned).toBe(result);
        expect(inputToJson).not.toHaveBeenCalled();
        expect(resultToJson).not.toHaveBeenCalled();
        expect(
          instance.ctx.storage.kv.get(CHAT_RUNTIME_KV_KEYS.evalEvents),
        ).toBeUndefined();
      },
    );
  });

  it("bounds active eval tool telemetry without inspecting arbitrary values", async () => {
    await runInDurableObject(
      threadStub("active-eval-tool"),
      async (instance: any) => {
        const runtime = new ChatThreadRuntimeDO(
          instance.ctx,
          env as unknown as ChatEnv,
        );
        instance.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.evalRun, {
          turnId: "eval-turn",
        });
        const toJSON = vi.fn(() => ({ leaked: true }));
        const getter = vi.fn(() => "leaked");
        const result: Record<string, unknown> = {
          huge: "x".repeat(CHAT_RUNTIME_BOUNDS.outboxEventBytes * 4),
          toJSON,
        };
        Object.defineProperty(result, "secret", {
          enumerable: true,
          get: getter,
        });
        result.self = result;
        const adapter: BoundedTurnAdapter = {
          readContext: () => [],
          callProvider: async () => ({ kind: "assistant", content: "done" }),
          callTool: async () => result,
        };
        const wrapped = (
          runtime as unknown as {
            captureEvalTools(value: BoundedTurnAdapter): BoundedTurnAdapter;
          }
        ).captureEvalTools(adapter);
        await wrapped.callProvider({
          turn: { id: "eval-turn" } as never,
          context: [],
          toolBatches: [],
          signal: new AbortController().signal,
        });

        const returned = await wrapped.callTool(
          { id: "call:eval", name: "inspect", input: {} },
          new AbortController().signal,
        );

        expect(returned).toBe(result);
        expect(toJSON).not.toHaveBeenCalled();
        expect(getter).not.toHaveBeenCalled();
        const events = instance.ctx.storage.kv.get<unknown[]>(
          CHAT_RUNTIME_KV_KEYS.evalEvents,
        );
        expect(events).toHaveLength(1);
        expect(
          new TextEncoder().encode(JSON.stringify(events)).byteLength,
        ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.snapshotBytes);
      },
    );
  });

  it("durably admits compatibility messages and deduplicates their client id", async () => {
    await runInDurableObject(threadStub("admit"), async (instance: any) => {
      const runtime = new ChatThreadRuntimeDO(
        instance.ctx,
        env as unknown as ChatEnv,
      );
      const request = {
        threadId: "thread-admit",
        workspaceId: "workspace-1",
        orgId: "org-1",
        userId: "user-1",
        clientMessageId: "client-1",
        message: "hello",
      };
      expect(await runtime.startInitialUserMessage(request)).toEqual({
        status: "accepted",
      });
      expect(await runtime.startInitialUserMessage(request)).toEqual({
        status: "accepted",
      });
      const messages = await runtime.getPiCoreParsedMessages("thread-admit");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "client-1:user",
        role: "user",
        content: "hello",
      });
      await instance.ctx.storage.deleteAlarm();
    });
  });

  it("bounds compatibility metadata and history by the shared limits", async () => {
    await runInDurableObject(threadStub("bounds"), async (instance: any) => {
      const runtime = new ChatThreadRuntimeDO(
        instance.ctx,
        env as unknown as ChatEnv,
      );
      await runtime.setTitle("x".repeat(CHAT_RUNTIME_BOUNDS.requestBytes * 2));
      expect(
        new TextEncoder().encode(
          instance.ctx.storage.kv.get<string>(CHAT_RUNTIME_KV_KEYS.title) ?? "",
        ).byteLength,
      ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.requestBytes);

      await runtime.setTodoState(
        Array.from(
          { length: CHAT_RUNTIME_BOUNDS.snapshotMessages * 2 },
          (_, index) => ({
            content: `todo-${index}`,
            status: "pending",
          }),
        ),
      );
      expect(runtime.getTodoState().length).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.snapshotMessages,
      );

      await runtime.setPreviewTabsState(
        Array.from(
          { length: CHAT_RUNTIME_BOUNDS.snapshotMessages * 2 },
          (_, index) => ({
            kind: "app" as const,
            scriptName: `app-${index}`,
            isPublic: false,
          }),
        ),
        null,
      );
      expect(runtime.getPreviewState().tabs.length).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.snapshotMessages,
      );

      for (
        let index = 0;
        index < CHAT_RUNTIME_BOUNDS.snapshotMessages + 4;
        index += 1
      ) {
        expect(
          await runtime.appendChannelHistoryEvent({
            threadId: "thread-bounds",
            workspaceId: "workspace-1",
            orgId: "org-1",
            channelKind: "slack",
            text: `delivered-${index}`,
            sentAt: index + 1,
          }),
        ).toEqual({ status: "appended" });
      }
      const messages = await runtime.getPiCoreParsedMessages("thread-bounds");
      expect(messages.length).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.snapshotMessages,
      );
      expect(
        new TextEncoder().encode(JSON.stringify(messages)).byteLength,
      ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.snapshotBytes);
    });
  });

  it("exports and adopts a bounded fork without pi-core replay state", async () => {
    await runInDurableObject(threadStub("fork"), async (instance: any) => {
      const runtime = new ChatThreadRuntimeDO(
        instance.ctx,
        env as unknown as ChatEnv,
      );
      await runtime.replacePiCoreForkMessages([
        { role: "user", content: "run the command", timestamp: 100 },
        {
          role: "assistant",
          responseId: "resp-tool",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "bash",
              arguments: { command: "false" },
            },
          ],
          timestamp: 200,
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "bash",
          content: [{ type: "text", text: "exit 1\n" }],
          isError: true,
          timestamp: 300,
        },
      ] as never);

      const exported = await runtime.getPiCoreParsedMessages("thread-fork");
      expect(exported).toHaveLength(2);
      expect(exported[1]).toMatchObject({
        id: "resp-tool",
        role: "assistant",
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "exit 1\n",
            status: "failed",
          }),
        ]),
      });
      expect(
        await runtime.getPiCoreForkMessages({ forkEntryId: "resp-tool" }),
      ).toMatchObject({ success: true, messageCount: 2 });

      runtime.applyForkStateSnapshot(
        {
          previewTarget: null,
          previewTabs: [],
          previewActiveTabId: null,
          previewVersion: 0,
          chatContext: null,
          currentTodos: [],
          contextUsedPercent: null,
          usageIsPostCompaction: true,
          cachedContextWindowByModel: {},
        },
        {
          threadId: "thread-fork",
          workspaceId: "workspace-1",
          orgId: "org-1",
          userId: "user-1",
        },
      );
      expect(new DurableChatTurnStore(instance.ctx.storage).scope()).toEqual({
        threadId: "thread-fork",
        workspaceId: "workspace-1",
        orgId: "org-1",
      });
      expect(
        instance.ctx.storage.kv.get(CHAT_RUNTIME_KV_KEYS.forkSeed),
      ).toBeUndefined();
      expect(await runtime.getPiCoreParsedMessages("thread-fork")).toHaveLength(
        2,
      );
      await expect(
        runtime.replacePiCoreForkMessages(
          Array.from(
            { length: CHAT_RUNTIME_BOUNDS.snapshotMessages * 2 },
            (_, index) => ({
              role: "user",
              content: `fork-${index}`,
              timestamp: index,
            }),
          ) as never,
        ),
      ).rejects.toThrow("nonempty runtime");
      const bounded = await runtime.getPiCoreParsedMessages("thread-fork");
      expect(bounded).toHaveLength(2);
      expect(
        new TextEncoder().encode(JSON.stringify(bounded)).byteLength,
      ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.snapshotBytes);
    });
  });

  it("runs eval compatibility as finite polling over alarm-owned work", async () => {
    const alarm = vi.fn(async () => undefined);
    class PollRuntime extends ChatThreadRuntimeDO {
      clock = 0;
      waits = 0;

      protected override createDriver(): DurableTurnDriver {
        return { alarm, kick: vi.fn() } as unknown as DurableTurnDriver;
      }

      protected override evalNow(): number {
        return this.clock;
      }

      protected override async waitForEvalPoll(ms: number): Promise<void> {
        this.waits += 1;
        await finishLegacyMigration(this.ctx.storage, this.store, Date.now());
        const claimed = this.store.claim(Date.now(), "eval-attempt");
        if (claimed.ok) {
          this.store.startNextInference(
            claimed.turn.id,
            "eval-attempt",
            Date.now(),
          );
          this.store.checkpointProviderFinal(
            claimed.turn.id,
            "eval-attempt",
            "bounded answer",
            Date.now(),
          );
          this.store.complete(
            claimed.turn.id,
            "eval-attempt",
            "bounded answer",
            Date.now(),
          );
        }
        this.clock += ms;
      }
    }

    await runInDurableObject(threadStub("eval-poll"), async (instance: any) => {
      const runtime = new PollRuntime(instance.ctx, env as unknown as ChatEnv);
      const result = await runtime.runAgentEvalSession({
        threadId: "thread-eval",
        workspaceId: "workspace-1",
        orgId: "org-1",
        userId: "user-1",
        clientMessageId: "eval-client",
        message: "do bounded work",
        timeoutMs: 100,
      });
      expect(result).toMatchObject({
        status: "completed",
        result: "bounded answer",
      });
      expect(result.events.map((event) => event.type)).toEqual([
        "runtime_event",
        "runtime_event",
        "result",
      ]);
      expect(result.messages).toHaveLength(2);
      expect(runtime.waits).toBe(1);
      expect(alarm).not.toHaveBeenCalled();
      await instance.ctx.storage.deleteAlarm();
    });
  });

  it("stops eval polling at the caller deadline without retrying the turn", async () => {
    const alarm = vi.fn(async () => undefined);
    class TimeoutRuntime extends ChatThreadRuntimeDO {
      clock = 0;
      waits = 0;

      protected override createDriver(): DurableTurnDriver {
        return { alarm, kick: vi.fn() } as unknown as DurableTurnDriver;
      }

      protected override evalNow(): number {
        return this.clock;
      }

      protected override async waitForEvalPoll(ms: number): Promise<void> {
        this.waits += 1;
        this.clock += ms;
      }
    }

    await runInDurableObject(
      threadStub("eval-timeout"),
      async (instance: any) => {
        const runtime = new TimeoutRuntime(
          instance.ctx,
          env as unknown as ChatEnv,
        );
        const result = await runtime.runAgentEvalSession({
          threadId: "thread-timeout",
          workspaceId: "workspace-1",
          orgId: "org-1",
          clientMessageId: "eval-timeout",
          message: "wait",
          timeoutMs: 25,
        });
        expect(result).toMatchObject({
          status: "error",
          error: "Agent eval timed out after 25ms",
        });
        expect(runtime.waits).toBe(1);
        expect(alarm).not.toHaveBeenCalled();
        expect(
          new DurableChatTurnStore(instance.ctx.storage).latestSnapshot()
            .messages,
        ).toHaveLength(1);
        await instance.ctx.storage.deleteAlarm();
      },
    );
  });

  it("derives a bounded admin summary from the canonical turn table", async () => {
    await runInDurableObject(
      threadStub("admin-summary"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        for (const [index, id] of ["failed", "completed"].entries()) {
          store.admit(
            {
              id,
              clientMessageId: `client:${id}`,
              threadId: "thread-admin",
              workspaceId: "workspace-1",
              orgId: "org-1",
              userId: "user-1",
              source: "web",
              userContent: id,
              userDisplay: id,
            },
            index * 3,
          );
          await finishLegacyMigration(
            instance.ctx.storage,
            store,
            index * 3 + 1,
          );
          store.claim(index * 3 + 1, `attempt:${id}`);
          if (id === "failed")
            store.fail(id, `attempt:${id}`, "provider failed", 2);
          else {
            store.startNextInference(id, `attempt:${id}`, 4);
            store.checkpointProviderFinal(id, `attempt:${id}`, "done", 5);
            store.complete(id, `attempt:${id}`, "done", 5);
          }
        }
        const runtime = new ChatThreadRuntimeDO(
          instance.ctx,
          env as unknown as ChatEnv,
        );
        await runtime.setModel("claude-sonnet-4-5");
        expect(runtime.getAdminExplorerSummary({ userMessageCap: 1 })).toEqual({
          userMessageCount: 1,
          userMessageCountCapped: true,
          hasError: true,
          errorCount: 1,
          lastErrorAt: 2,
          lastErrorMessage: "provider failed",
          models: ["claude-sonnet-4-5"],
        });
      },
    );
  });

  it("surfaces migration failure as coarse state without making it a turn error", async () => {
    await runInDurableObject(
      threadStub("migration-failure-state"),
      async (instance: any) => {
        const store = new DurableChatTurnStore(instance.ctx.storage);
        instance.ctx.storage.sql.exec(`CREATE TABLE pi_core_messages (
          idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
        )`);
        instance.ctx.storage.sql.exec(
          "INSERT INTO pi_core_messages VALUES (0, 'not json', 1)",
        );
        store.admit(
          {
            id: "queued",
            clientMessageId: "client:queued",
            threadId: "thread-1",
            workspaceId: "workspace-1",
            orgId: "org-1",
            userId: "user-1",
            source: "web",
            userContent: "continue",
            userDisplay: "continue",
          },
          10_000,
        );
        const migration = await new LegacySessionMigrator(
          instance.ctx.storage,
          () => 10_001,
        ).runAfterTrigger(10_000, "migration:failed");
        expect(migration.state).toBe("failed");

        const runtime = new ChatThreadRuntimeDO(
          instance.ctx,
          env as unknown as ChatEnv,
        );
        const state = (
          runtime as unknown as { coarseState(): Record<string, unknown> }
        ).coarseState();
        expect(state).toMatchObject({
          legacyMigrationError: {
            id: `legacy-migration:${migration.deadlineAt}`,
            error:
              "Recent chat history could not be restored. This message will continue without older context.",
          },
        });
        expect(state).not.toHaveProperty("lastError");
      },
    );
  });

  it("delegates the alarm entry point to exactly one driver", async () => {
    const alarm = vi.fn(async () => undefined);
    class AlarmRuntime extends ChatThreadRuntimeDO {
      protected override createDriver(): DurableTurnDriver {
        return { alarm } as unknown as DurableTurnDriver;
      }
    }

    await runInDurableObject(threadStub("alarm"), async (instance: any) => {
      const runtime = new AlarmRuntime(instance.ctx, env as unknown as ChatEnv);
      await runtime.alarm();
      await runtime.alarm();
      expect(alarm).toHaveBeenCalledTimes(2);
    });
  });
});
