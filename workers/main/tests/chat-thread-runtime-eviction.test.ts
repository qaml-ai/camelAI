import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { ChatThreadRuntimeDO } from "../src/chat-thread/chat-thread-runtime-do";
import { DurableChatTurnStore } from "../src/chat-thread/durable-turn-store";
import { LegacySessionMigrator } from "../src/chat-thread/legacy-session-migration";

type ChatStub = DurableObjectStub<ChatThreadRuntimeDO>;
type SseFrame = Record<string, unknown>;

const scope = {
  threadId: "eviction-thread",
  workspaceId: "eviction-workspace",
  orgId: "eviction-org",
  userId: "eviction-user",
};

function threadStub(name: string): ChatStub {
  const namespace = (
    env as unknown as {
      CHAT_THREAD: DurableObjectNamespace<ChatThreadRuntimeDO>;
    }
  ).CHAT_THREAD;
  return namespace.get(namespace.idFromName(`runtime-eviction-${name}`));
}

function eventsRequest(after?: number): Request {
  const query = new URLSearchParams({
    threadId: scope.threadId,
    workspaceId: scope.workspaceId,
    orgId: scope.orgId,
  });
  if (after !== undefined) query.set("after", String(after));
  return new Request(
    `https://runtime.test/agents/chat-thread/${scope.threadId}/v2/events?${query}`,
    {
      headers: {
        "X-Chiridion-User-Id": scope.userId,
      },
    },
  );
}

async function completeLegacyMigration(
  storage: DurableObjectStorage,
  now: number,
): Promise<void> {
  const result = await new LegacySessionMigrator(
    storage,
    () => now,
  ).runAfterTrigger(now, `migration:${now}`);
  expect(result.state).toBe("complete");
}

async function readSseFrames(
  response: Response,
  expectedCount: number,
): Promise<SseFrame[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffered = "";

  try {
    while (frames.length < expectedCount) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for SSE frames")),
            3_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });

      for (;;) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary < 0) break;
        const event = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = event
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data) frames.push(JSON.parse(data) as SseFrame);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  expect(frames).toHaveLength(expectedCount);
  return frames;
}

describe("ChatThreadRuntimeDO eviction recovery", () => {
  it("keeps admitted work and idempotency durable across a real eviction", async () => {
    const stub = threadStub("admission");
    await runInDurableObject(stub, async (_instance, state) => {
      const admitted = new DurableChatTurnStore(state.storage).admit(
        {
          id: "eviction-client-message",
          clientMessageId: "eviction-client-message",
          ...scope,
          source: "web",
          userContent: "survive the eviction",
          userDisplay: "survive the eviction",
        },
        Date.now(),
      );
      expect(admitted).toMatchObject({
        ok: true,
        duplicate: false,
        turn: { id: "eviction-client-message", status: "queued" },
      });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await evictDurableObject(stub);

    await expect(stub.getPiCoreParsedMessages(scope.threadId)).resolves.toEqual(
      [
        expect.objectContaining({
          id: "eviction-client-message:user",
          role: "user",
          content: "survive the eviction",
        }),
      ],
    );

    await runInDurableObject(stub, async (_instance, state) => {
      const store = new DurableChatTurnStore(state.storage);
      const duplicate = store.admit(
        {
          id: "eviction-client-message",
          clientMessageId: "eviction-client-message",
          ...scope,
          source: "web",
          userContent: "survive the eviction",
          userDisplay: "survive the eviction",
        },
        Date.now(),
      );
      expect(duplicate).toMatchObject({
        ok: true,
        duplicate: true,
        turn: { id: "eviction-client-message", status: "queued" },
      });
      const snapshot = store.latestSnapshot();
      expect(snapshot.messages).toEqual([
        expect.objectContaining({
          id: "eviction-client-message:user",
          role: "user",
          content: "survive the eviction",
          status: "queued",
        }),
      ]);
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
    });
  });

  it("finishes a durable provider-final checkpoint after eviction and fences the old owner", async () => {
    const stub = threadStub("provider-final");
    const turnId = "provider-final-turn";
    const oldToken = "provider-final-old-owner";
    const output = "answer already durably checkpointed";
    const now = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      const store = new DurableChatTurnStore(state.storage);
      expect(
        store.admit(
          {
            id: turnId,
            clientMessageId: turnId,
            ...scope,
            source: "web",
            userContent: "finish after a cold wake",
            userDisplay: "finish after a cold wake",
          },
          now,
        ).ok,
      ).toBe(true);
      await completeLegacyMigration(state.storage, now + 1);
      expect(store.claim(now + 2, oldToken).ok).toBe(true);
      expect(
        store.checkpoint(turnId, oldToken, { type: "start_provider" }, now + 3)
          .ok,
      ).toBe(true);
      expect(
        store.checkpoint(
          turnId,
          oldToken,
          { type: "provider_final", output },
          now + 4,
        ).ok,
      ).toBe(true);
      await state.storage.setAlarm(now + 60_000);
    });

    await evictDurableObject(stub);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const store = new DurableChatTurnStore(state.storage);
      const snapshot = store.latestSnapshot();
      expect(store.nextAlarmAt(Date.now())).toBeNull();
      expect(snapshot.messages).toEqual([
        expect.objectContaining({
          id: `${turnId}:user`,
          status: "completed",
        }),
        expect.objectContaining({
          id: `${turnId}:assistant`,
          content: output,
          status: "completed",
        }),
      ]);
      expect(store.activeTurn()).toBeNull();
      expect(
        store.finish(turnId, oldToken, "completed", output, Date.now()),
      ).toMatchObject({
        ok: false,
        reason: "stale",
      });
    });
  });

  it("terminalizes an uncertain effect after eviction instead of replaying it", async () => {
    const stub = threadStub("uncertain-effect");
    const turnId = "uncertain-effect-turn";
    const oldToken = "uncertain-effect-old-owner";
    const now = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      const store = new DurableChatTurnStore(state.storage);
      expect(
        store.admit(
          {
            id: turnId,
            clientMessageId: turnId,
            ...scope,
            source: "web",
            userContent: "do a side effect",
            userDisplay: "do a side effect",
          },
          now,
        ).ok,
      ).toBe(true);
      await completeLegacyMigration(state.storage, now + 1);
      expect(store.claim(now + 2, oldToken).ok).toBe(true);
      expect(
        store.checkpoint(turnId, oldToken, { type: "start_provider" }, now + 3)
          .ok,
      ).toBe(true);
      expect(
        store.checkpoint(
          turnId,
          oldToken,
          {
            type: "provider_batch",
            batch: {
              providerStateJson: "[]",
              calls: [
                {
                  id: "external-effect",
                  name: "deploy",
                  inputJson: '{"target":"staging"}',
                  effectStarted: false,
                  result: null,
                },
              ],
            },
          },
          now + 4,
        ).ok,
      ).toBe(true);
      expect(
        store.checkpoint(
          turnId,
          oldToken,
          { type: "begin_effect", callId: "external-effect" },
          now + 5,
        ).ok,
      ).toBe(true);
      await state.storage.setAlarm(now + 60_000);
    });

    await evictDurableObject(stub);

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const store = new DurableChatTurnStore(state.storage);
      const snapshot = store.latestSnapshot();
      expect(store.nextAlarmAt(Date.now())).toBeNull();
      expect(snapshot.messages.at(-1)).toMatchObject({
        id: `${turnId}:assistant`,
        role: "assistant",
        status: "interrupted",
      });
      expect(JSON.stringify(snapshot.messages.at(-1)?.content)).toContain(
        "Turn interrupted after a crash with an uncertain external effect.",
      );
      expect(
        store.checkpoint(
          turnId,
          oldToken,
          {
            type: "tool_result",
            result: {
              callId: "external-effect",
              status: "success",
              output: '{"late":true}',
            },
          },
          Date.now(),
        ),
      ).toMatchObject({ ok: false, reason: "stale" });
    });
  });

  it("reconnects from an SSE cursor after eviction with a canonical reset", async () => {
    const stub = threadStub("sse-reconnect");
    const turnId = "sse-reconnect-turn";
    const now = Date.now();
    const cursor = await runInDurableObject(stub, async (_instance, state) => {
      const store = new DurableChatTurnStore(state.storage);
      expect(
        store.admit(
          {
            id: turnId,
            clientMessageId: turnId,
            ...scope,
            source: "web",
            userContent: "show me the durable state",
            userDisplay: "show me the durable state",
          },
          now,
        ).ok,
      ).toBe(true);
      const priorCursor = store.revision();
      expect(priorCursor).toBeGreaterThan(0);
      await completeLegacyMigration(state.storage, now + 1);
      const token = "sse-reconnect-owner";
      expect(store.claim(now + 2, token).ok).toBe(true);
      expect(
        store.finish(
          turnId,
          token,
          "failed",
          "provider failed before eviction",
          now + 3,
        ),
      ).toMatchObject({ ok: true });
      await state.storage.deleteAlarm();
      return priorCursor;
    });
    await evictDurableObject(stub);

    const reconnectedFrames = await readSseFrames(
      await stub.fetch(eventsRequest(cursor)),
      2,
    );
    expect(reconnectedFrames[0]).toMatchObject({ type: "hello" });
    expect(reconnectedFrames[1]).toMatchObject({
      type: "reset",
      messages: [
        expect.objectContaining({
          id: `${turnId}:user`,
          status: "failed",
        }),
        expect.objectContaining({
          id: `${turnId}:assistant`,
          status: "failed",
        }),
      ],
      activeTurn: null,
    });
    expect(reconnectedFrames[1].cursor).toBeGreaterThan(cursor);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
});
