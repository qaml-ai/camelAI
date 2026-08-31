import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import type { DurableChatTurnStore } from "../src/chat-thread/durable-turn-store";
import {
  ChatRuntimeController,
  type ChatRuntimeCallbacks,
  type ChatRuntimeLiveUpdate,
  type TrustedChatRuntimeScope,
} from "../src/chat-thread/chat-runtime-controller";

const scope: TrustedChatRuntimeScope = {
  threadId: "thread-1",
  workspaceId: "workspace-1",
  orgId: "org-1",
  userId: "user-1",
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

class TestState {
  waits: Promise<unknown>[] = [];
  alarms: number[] = [];
  aborts: string[] = [];
  storage = {
    setAlarm: async (at: number) => {
      this.alarms.push(at);
    },
  };

  waitUntil(task: Promise<unknown>): void {
    this.waits.push(task);
  }

  abort(reason: string): void {
    this.aborts.push(reason);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.waits);
  }
}

const emptySnapshot = () => ({
  revision: 0,
  messages: [],
  bytes: 0,
});

function store(overrides: Record<string, unknown> = {}): DurableChatTurnStore {
  return {
    revision: () => 0,
    latestSnapshot: emptySnapshot,
    admit: () => ({
      ok: true,
      duplicate: false,
      turn: { id: "message-1", status: "queued" },
    }),
    nextAlarmAt: (now: number) => now,
    ...overrides,
  } as unknown as DurableChatTurnStore;
}

function callbacks(
  overrides: Partial<ChatRuntimeCallbacks> = {},
): ChatRuntimeCallbacks {
  return {
    kick: vi.fn(),
    control: vi.fn(),
    coarseState: () => ({ model: "test" }),
    ...overrides,
  };
}

function url(path: string, extra = ""): string {
  return `https://runtime.test${path}?threadId=${scope.threadId}&workspaceId=${scope.workspaceId}&orgId=${scope.orgId}${extra}`;
}

function post(path: string, body: unknown, headers?: HeadersInit): Request {
  return new Request(url(path), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function data(chunk: Uint8Array): unknown {
  const text = new TextDecoder().decode(chunk);
  const raw = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  return raw ? JSON.parse(raw) : null;
}

function liveUpdate(
  content: ChatRuntimeLiveUpdate["message"]["content"],
  epoch = "attempt-1",
): ChatRuntimeLiveUpdate {
  return {
    turnId: "turn-1",
    epoch,
    activeTurn: {
      id: "turn-1",
      status: "running",
      acceptedAt: Date.now(),
      startedAt: Date.now(),
    },
    message: {
      id: "turn-1:assistant",
      role: "assistant",
      content,
      status: "running",
      createdAt: Date.now(),
    },
  };
}

const controllers: ChatRuntimeController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close();
  vi.useRealTimers();
});

function controller(
  state: TestState,
  turnStore: DurableChatTurnStore,
  handlers = callbacks(),
) {
  const result = new ChatRuntimeController(
    state as unknown as DurableObjectState,
    turnStore,
    () => scope,
    handlers,
  );
  controllers.push(result);
  return result;
}

describe("ChatRuntimeController events", () => {
  it("flushes its first byte before a blocked snapshot or runtime callback", async () => {
    const snapshotGate = deferred<ReturnType<typeof emptySnapshot>>();
    const stateGate = deferred<unknown>();
    const coarseState = vi.fn(() => stateGate.promise);
    const state = new TestState();
    const runtime = controller(
      state,
      store({ latestSnapshot: () => snapshotGate.promise }),
      callbacks({ coarseState }),
    );

    const response = await runtime.fetch(new Request(url("/v2/events")));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(":hb\n\n");
    expect(coarseState).not.toHaveBeenCalled();

    const hello = await reader.read();
    expect(data(hello.value!)).toEqual({ type: "hello", cursor: 0 });
    snapshotGate.resolve(emptySnapshot());
    await vi.waitFor(() => expect(coarseState).toHaveBeenCalledOnce());
    expect(state.waits).toHaveLength(2); // Seed plus once-per-isolate wake kick.

    stateGate.resolve({ ready: false });
    const snapshot = await reader.read();
    expect(data(snapshot.value!)).toMatchObject({
      type: "snapshot",
      cursor: 0,
      messages: [],
      activeTurn: null,
      state: { ready: false },
    });
    await reader.cancel();
    await state.flush();
  });

  it("does not let a delayed seed overwrite a newer published cursor", async () => {
    const seedState = deferred<unknown>();
    let stateCalls = 0;
    let cursor = 0;
    let messages: Array<Record<string, unknown>> = [];
    const revision = () => cursor;
    const state = new TestState();
    const runtime = controller(
      state,
      store({
        revision,
        latestSnapshot: () => ({
          revision: cursor,
          messages,
          bytes: 2,
        }),
      }),
      callbacks({
        coarseState: () =>
          ++stateCalls === 1 ? seedState.promise : { cursor },
      }),
    );
    const reader = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    await reader.read();
    await reader.read();
    await vi.waitFor(() => expect(stateCalls).toBe(1));

    cursor = 1;
    messages = [
      {
        id: "turn:user",
        turnId: "turn",
        role: "user",
        content: "new",
        status: "queued",
        createdAt: 1,
      },
    ];
    await runtime.publish();
    expect(data((await reader.read()).value!)).toMatchObject({
      type: "reset",
      cursor: 1,
      messages: [{ content: "new" }],
    });

    seedState.resolve({ cursor: 0 });
    await state.flush();
    cursor = 2;
    await runtime.publish();
    expect(data((await reader.read()).value!)).toMatchObject({
      type: "reset",
      cursor: 2,
    });
    await reader.cancel();
  });

  it("coalesces cumulative live updates without touching durable state or cursors", async () => {
    vi.useFakeTimers();
    const revision = vi.fn(() => 7);
    const latestSnapshot = vi.fn(emptySnapshot);
    const coarseState = vi.fn(() => ({ model: "test" }));
    const state = new TestState();
    const runtime = controller(
      state,
      store({ revision, latestSnapshot }),
      callbacks({ coarseState }),
    );
    const reader = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const durableCalls = {
      cursor: revision.mock.calls.length,
      snapshot: latestSnapshot.mock.calls.length,
      state: coarseState.mock.calls.length,
    };

    runtime.publishLive(liveUpdate("first"));
    runtime.publishLive(
      liveUpdate([
        { type: "text", text: "second" },
        { type: "tool_use", id: "call-1", name: "read", input: {} },
      ]),
    );
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    const first = data((await reader.read()).value!) as Record<string, unknown>;
    expect(first).toMatchObject({
      type: "live",
      turnId: "turn-1",
      epoch: "attempt-1",
      seq: 1,
      activeTurn: { id: "turn-1", status: "running" },
      message: {
        id: "turn-1:assistant",
        status: "running",
        content: [
          { type: "text", text: "second" },
          { type: "tool_use", id: "call-1", name: "read" },
        ],
      },
    });
    expect(first).not.toHaveProperty("cursor");
    expect(revision).toHaveBeenCalledTimes(durableCalls.cursor);
    expect(latestSnapshot).toHaveBeenCalledTimes(durableCalls.snapshot);
    expect(coarseState).toHaveBeenCalledTimes(durableCalls.state);

    runtime.publishLive(liveUpdate("third"));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    expect(data((await reader.read()).value!)).toMatchObject({
      type: "live",
      seq: 2,
      message: { content: "third" },
    });
    await reader.cancel();
  });

  it("seeds a newly attached writer with the last emitted live state after its snapshot", async () => {
    vi.useFakeTimers();
    const state = new TestState();
    const runtime = controller(state, store());
    const first = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    await first.read();
    await first.read();
    await first.read();

    runtime.publishLive(liveUpdate("emitted"));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    expect(data((await first.read()).value!)).toMatchObject({
      type: "live",
      seq: 1,
      message: { content: "emitted" },
    });
    runtime.publishLive(liveUpdate("pending"));

    const second = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    expect(new TextDecoder().decode((await second.read()).value)).toBe(
      ":hb\n\n",
    );
    expect(data((await second.read()).value!)).toMatchObject({ type: "hello" });
    expect(data((await second.read()).value!)).toMatchObject({
      type: "snapshot",
    });
    expect(data((await second.read()).value!)).toMatchObject({
      type: "live",
      seq: 1,
      message: { content: "emitted" },
    });

    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    for (const reader of [first, second]) {
      expect(data((await reader.read()).value!)).toMatchObject({
        type: "live",
        seq: 2,
        message: { content: "pending" },
      });
      await reader.cancel();
    }
  });

  it("paces maximal cumulative live frames through the full lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const runtime = controller(new TestState(), store());
    const large = "x".repeat(CHAT_RUNTIME_BOUNDS.liveMessageBytes - 4_096);
    const refillPerMs =
      (CHAT_RUNTIME_BOUNDS.liveBytesPerTurn -
        CHAT_RUNTIME_BOUNDS.liveBurstBytes) /
      CHAT_RUNTIME_BOUNDS.turnLeaseMs;
    expect(
      Math.ceil(CHAT_RUNTIME_BOUNDS.sseWriterBytes / refillPerMs),
    ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.liveMaxPacingDelayMs);

    for (let frame = 1; frame <= 2; frame += 1) {
      runtime.publishLive(liveUpdate(large));
      await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
      expect((runtime as any).liveEpoch.emitted).toBe(frame);
    }
    runtime.publishLive(liveUpdate(large));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    expect((runtime as any).liveEpoch.emitted).toBe(2);
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveMaxPacingDelayMs);
    expect((runtime as any).liveEpoch).toMatchObject({ emitted: 3, dirty: false });
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.turnLeaseMs);
    runtime.publishLive(liveUpdate("after the durable lease"));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    expect((runtime as any).liveEpoch).toMatchObject({
      emitted: 3,
      emittedBytes: CHAT_RUNTIME_BOUNDS.liveBytesPerTurn,
    });
  });

  it("publishes a durable reset while a large live frame is paced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let cursor = 0;
    const state = new TestState();
    const runtime = controller(
      state,
      store({
        revision: () => cursor,
        latestSnapshot: () => ({ revision: cursor, messages: [], bytes: 0 }),
      }),
    );
    const reader = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    await reader.read();
    await reader.read();
    await reader.read();
    const large = "x".repeat(CHAT_RUNTIME_BOUNDS.liveMessageBytes - 4_096);
    for (let frame = 0; frame < 3; frame += 1) {
      runtime.publishLive(liveUpdate(large));
      await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
      if (frame < 2) await reader.read();
    }
    expect((runtime as any).liveEpoch).toMatchObject({ emitted: 2, dirty: true });
    cursor = 1;
    await runtime.publish();
    expect(data((await reader.read()).value!)).toMatchObject({
      type: "reset",
      cursor: 1,
    });
    await reader.cancel();
  });

  it("stops best-effort live painting at the cumulative byte budget", async () => {
    vi.useFakeTimers();
    const runtime = controller(new TestState(), store());

    runtime.publishLive(liveUpdate("first"));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    const live = (
      runtime as unknown as {
        liveEpoch: { emitted: number; emittedBytes: number; dirty: boolean };
      }
    ).liveEpoch;
    expect(live.emitted).toBe(1);
    live.emittedBytes = CHAT_RUNTIME_BOUNDS.liveBytesPerTurn - 1;

    runtime.publishLive(liveUpdate("this frame cannot fit"));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    expect(live).toMatchObject({
      emitted: 1,
      emittedBytes: CHAT_RUNTIME_BOUNDS.liveBytesPerTurn,
      dirty: false,
    });

    runtime.publishLive(liveUpdate("no more normalization or timers"));
    expect(live.dirty).toBe(false);
  });

  it("cancels a matching live epoch and rejects oversized live frames", async () => {
    vi.useFakeTimers();
    const state = new TestState();
    const runtime = controller(state, store());
    const reader = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    await reader.read();
    await reader.read();
    await reader.read();

    runtime.publishLive(liveUpdate("cancelled", "attempt-1"));
    runtime.clearLive("turn-1", "other-attempt");
    runtime.clearLive("turn-1", "attempt-1");
    runtime.publishLive(liveUpdate("replacement", "attempt-2"));
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.liveFlushMs);
    expect(data((await reader.read()).value!)).toMatchObject({
      type: "live",
      epoch: "attempt-2",
      seq: 1,
      message: { content: "replacement" },
    });

    const huge = "\u0000".repeat(CHAT_RUNTIME_BOUNDS.liveMessageBytes);
    const oversized = liveUpdate(huge, "attempt-2");
    const stringify = vi.spyOn(JSON, "stringify");
    runtime.publishLive(oversized);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          value === oversized.message ||
          (Boolean(value) &&
            typeof value === "object" &&
            (value as { content?: unknown }).content === huge),
      ),
    ).toBe(false);
    stringify.mockRestore();
    await expect(reader.read()).rejects.toThrow("Chat SSE writer closed");
  });

  it("bounds array live content before serializing it", () => {
    const runtime = controller(new TestState(), store());
    const block = {
      type: "text",
      text: "x".repeat(CHAT_RUNTIME_BOUNDS.liveMessageBytes * 2),
    };
    const content = [block];
    const update = liveUpdate(content);
    const stringify = vi.spyOn(JSON, "stringify");
    runtime.publishLive(update);
    expect(
      stringify.mock.calls.some(
        ([value]) =>
          value === content ||
          value === block ||
          (Boolean(value) &&
            typeof value === "object" &&
            (value as { content?: unknown }).content === content),
      ),
    ).toBe(false);
    stringify.mockRestore();
  });

  it("enforces connection and serialized-byte caps with teardown", async () => {
    const state = new TestState();
    const runtime = controller(state, store());
    const limit = Math.min(
      CHAT_RUNTIME_BOUNDS.sseWritersPerThread,
      Math.floor(
        CHAT_RUNTIME_BOUNDS.sseDoBytes /
          CHAT_RUNTIME_BOUNDS.sseWriterQueueBytes,
      ),
    );
    const responses: Response[] = [];
    for (let index = 0; index < limit; index += 1) {
      responses.push(await runtime.fetch(new Request(url("/v2/events"))));
    }
    expect((await runtime.fetch(new Request(url("/v2/events")))).status).toBe(
      429,
    );
    await responses[0].body!.cancel();
    expect((await runtime.fetch(new Request(url("/v2/events")))).status).toBe(
      200,
    );
    runtime.close();
    await state.flush();

    const hugeState = "x".repeat(CHAT_RUNTIME_BOUNDS.sseWriterBytes);
    const bytesState = new TestState();
    const bytesRuntime = controller(
      bytesState,
      store(),
      callbacks({ coarseState: () => hugeState }),
    );
    const response = await bytesRuntime.fetch(new Request(url("/v2/events")));
    const reader = response.body!.getReader();
    // An impossible coarse-state frame closes the connection without
    // acknowledging the cursor. Reconnect can therefore retry from the same
    // durable revision instead of silently losing state.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      ":hb\n\n",
    );
    await expect(reader.read()).rejects.toThrow("Chat SSE writer closed");
    const retry = await bytesRuntime.fetch(new Request(url("/v2/events")));
    expect(retry.status).toBe(200);
    await retry.body!.cancel();
    await bytesState.flush();
  });

  it("never enqueues beyond one writer or the aggregate SSE queue budget", async () => {
    let cursor = 0;
    const content = "x".repeat(CHAT_RUNTIME_BOUNDS.assistantBytes);
    const revision = () => cursor;
    const state = new TestState();
    const runtime = controller(
      state,
      store({
        revision,
        latestSnapshot: () => ({
          revision: cursor,
          bytes: content.length,
          messages: [
            {
              id: "turn:assistant",
              turnId: "turn",
              role: "assistant",
              content,
              status: "completed",
              createdAt: cursor,
            },
          ],
        }),
      }),
      callbacks({ coarseState: () => undefined }),
    );
    const response = await runtime.fetch(new Request(url("/v2/events")));
    await state.flush();
    for (cursor = 1; cursor <= 8; cursor += 1) await runtime.publish();

    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toThrow("Chat SSE writer closed");
    const replacement = await runtime.fetch(new Request(url("/v2/events")));
    expect(replacement.status).toBe(200);
    await replacement.body!.cancel();
  });

  it("keeps the newest legal assistant answer in bounded SSE snapshots", async () => {
    for (const [content, truncated] of [
      ["x".repeat(CHAT_RUNTIME_BOUNDS.assistantBytes), false],
      ["\u0000".repeat(CHAT_RUNTIME_BOUNDS.assistantBytes), true],
    ] as const) {
      const state = new TestState();
      const runtime = controller(
        state,
        store({
          latestSnapshot: () => ({
            revision: 1,
            bytes: content.length,
            messages: [
              {
                id: "turn:user",
                turnId: "turn",
                role: "user",
                content: "question",
                status: "completed",
                createdAt: 1,
              },
              {
                id: "turn:assistant",
                turnId: "turn",
                role: "assistant",
                content,
                status: "completed",
                createdAt: 2,
              },
            ],
          }),
        }),
      );
      const response = await runtime.fetch(new Request(url("/v2/events")));
      const reader = response.body!.getReader();
      await reader.read();
      await reader.read();
      const frame = await reader.read();
      expect(frame.value?.byteLength).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.sseWriterBytes,
      );
      const snapshot = data(frame.value!) as {
        messages: Array<{ role: string; content: string }>;
        state?: { model: string };
      };
      expect(snapshot.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      const assistant = snapshot.messages[1].content;
      expect(truncated ? assistant.endsWith("…") : assistant === content).toBe(
        true,
      );
      expect(snapshot.state).toEqual({ model: "test" });
      await reader.cancel();
      await state.flush();
    }
  });

  it("drops only the smallest oversized snapshot prefix with logarithmic encoding", () => {
    const runtime = controller(new TestState(), store());
    const content = "x".repeat(42_000);
    const messages = Array.from({ length: 50 }, (_, index) => ({
      id: `turn-${index}:assistant`,
      turnId: `turn-${index}`,
      role: "assistant" as const,
      content,
      status: "completed" as const,
      createdAt: index,
    }));
    const stringify = vi.spyOn(JSON, "stringify");
    const frame = (runtime as any).buildSnapshotFrame(
      "snapshot",
      1,
      { revision: 1, messages, bytes: content.length * messages.length },
      undefined,
    ) as Uint8Array;
    expect((data(frame) as any).messages).toHaveLength(49);
    expect(stringify.mock.calls.length).toBeLessThanOrEqual(8);
    stringify.mockRestore();
  });

  it("sizes each candidate snapshot string only once before truncation", () => {
    const runtime = controller(new TestState(), store());
    const original = String.prototype.charCodeAt;
    let calls = 0;
    String.prototype.charCodeAt = function (index: number) {
      calls += 1;
      return original.call(this, index);
    };
    try {
      const messages = Array.from({ length: 50 }, (_, index) => ({
        id: `shared:${index}`,
        turnId: "shared",
        role: "assistant" as const,
        content: "é".repeat(index === 0 ? 200_000 : 20_000),
        status: "completed" as const,
        createdAt: index,
      }));
      expect(
        (runtime as any).buildSnapshotFrame(
          "snapshot",
          1,
          { revision: 1, messages, bytes: 2_360_000 },
          undefined,
        ),
      ).toBeInstanceOf(Uint8Array);
      expect(calls).toBeLessThan(1_600_000);
    } finally {
      String.prototype.charCodeAt = original;
    }
  });

  it("uses forwarded scope only as a check against trusted context", async () => {
    const state = new TestState();
    const revision = vi.fn(() => 0);
    const runtime = controller(state, store({ revision }));
    const denied = await runtime.fetch(
      new Request(url("/v2/events", "&workspaceId=attacker")),
    );
    expect(denied.status).toBe(403);
    expect(revision).not.toHaveBeenCalled();
  });

  it("publishes revision-ordered resets and durably kicks every open", async () => {
    let revision = 0;
    let messages: Array<Record<string, unknown>> = [];
    const readRevision = vi.fn(() => revision);
    const turnStore = store({
      revision: readRevision,
      latestSnapshot: () => ({
        revision,
        messages,
        bytes: 0,
      }),
    });
    const state = new TestState();
    const kick = vi.fn();
    const runtime = controller(state, turnStore, callbacks({ kick }));
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let index = 0; index < 2; index += 1) {
      const response = await runtime.fetch(new Request(url("/v2/events")));
      const reader = response.body!.getReader();
      readers.push(reader);
      await reader.read();
      await reader.read();
      await reader.read();
    }
    await state.flush();
    expect(kick).toHaveBeenCalledTimes(2);
    expect(kick).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceId: "workspace-1",
        orgId: "org-1",
      }),
    );

    revision = 1;
    messages = [
      {
        id: "turn-1:user",
        turnId: "turn-1",
        role: "user",
        content: "hello",
        status: "queued",
        createdAt: 10,
      },
    ];
    await runtime.publish();
    for (const reader of readers) {
      expect(data((await reader.read()).value!)).toMatchObject({
        type: "reset",
        cursor: 1,
        messages: [
          {
            id: "turn-1:user",
            role: "user",
            content: "hello",
            createdAt: 10,
            status: "queued",
          },
        ],
      });
    }

    const revisionReads = readRevision.mock.calls.length;
    await runtime.publish();
    expect(readRevision).toHaveBeenCalledTimes(revisionReads + 1);
    for (const reader of readers) await reader.cancel();
  });

  it("coalesces publish pressure while a new stream seeds independently", async () => {
    const stateGate = deferred<unknown>();
    let blocked = false;
    let cursor = 0;
    const coarseState = vi.fn(() =>
      blocked ? stateGate.promise : { model: "ready" },
    );
    const latestSnapshot = vi.fn(emptySnapshot);
    const revision = vi.fn(() => cursor);
    const state = new TestState();
    const runtime = controller(
      state,
      store({ revision, latestSnapshot }),
      callbacks({ coarseState }),
    );

    const first = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    await first.read();
    await first.read();
    await first.read();
    expect(coarseState).toHaveBeenCalledTimes(1);

    cursor = 1;
    blocked = true;
    let settled = false;
    const publishing = runtime.publish().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(coarseState).toHaveBeenCalledTimes(2));
    const coalesced = Array.from({ length: 100 }, () => runtime.publish());
    expect(settled).toBe(false);

    const second = (
      await runtime.fetch(new Request(url("/v2/events")))
    ).body!.getReader();
    expect(new TextDecoder().decode((await second.read()).value)).toBe(
      ":hb\n\n",
    );
    expect(data((await second.read()).value!)).toEqual({
      type: "hello",
      cursor: 1,
    });
    expect(settled).toBe(false);
    await vi.waitFor(() => expect(coarseState).toHaveBeenCalledTimes(3));

    stateGate.resolve({ model: "unblocked" });
    await publishing;
    await Promise.all(coalesced);
    await state.flush();
    expect(coarseState).toHaveBeenCalledTimes(3);
    expect(latestSnapshot).toHaveBeenCalledTimes(3);
    await first.cancel();
    await second.cancel();
  });
});

describe("ChatRuntimeController POSTs", () => {
  it("does not ACK until admission is durable and its alarm is scheduled", async () => {
    const alarm = deferred<void>();
    const order: string[] = [];
    const state = new TestState();
    state.storage.setAlarm = async () => {
      order.push("alarm-start");
      await alarm.promise;
      order.push("alarm-durable");
    };
    const kick = vi.fn(() => order.push("kick"));
    const admit = vi.fn(() => {
      order.push("turn-durable");
      return {
        ok: true as const,
        duplicate: false,
        turn: { id: "message-1", status: "queued" },
      };
    });
    const runtime = controller(state, store({ admit }), callbacks({ kick }));
    let settled = false;
    const pending = runtime
      .fetch(
        post("/v2/messages", {
          clientMessageId: "message-1",
          content: "hello",
        }),
      )
      .then((response) => {
        settled = true;
        order.push("ack");
        return response;
      });

    await vi.waitFor(() => expect(order).toEqual(["alarm-start"]));
    expect(settled).toBe(false);
    expect(kick).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    alarm.resolve();
    const response = await pending;
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      turnId: "message-1",
    });
    await state.flush();
    expect(order.indexOf("alarm-durable")).toBeLessThan(
      order.indexOf("turn-durable"),
    );
    expect(order.indexOf("turn-durable")).toBeLessThan(order.indexOf("ack"));
    expect(order.indexOf("alarm-durable")).toBeLessThan(order.indexOf("kick"));
  });

  it("does not create a durable row when alarm pre-arming fails", async () => {
    const state = new TestState();
    state.storage.setAlarm = vi.fn(async () => {
      throw new Error("alarm unavailable");
    });
    const admit = vi.fn();
    const kick = vi.fn();
    const runtime = controller(state, store({ admit }), callbacks({ kick }));
    const response = await runtime.fetch(
      post("/v2/messages", {
        clientMessageId: "safe-id",
        content: "hello",
      }),
    );
    expect(response.status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("aborts the isolate when alarm pre-arming does not settle", async () => {
    vi.useFakeTimers();
    const state = new TestState();
    state.storage.setAlarm = vi.fn(() => new Promise<void>(() => undefined));
    const admit = vi.fn();
    const runtime = controller(state, store({ admit }));
    const pending = runtime.fetch(
      post("/v2/messages", {
        clientMessageId: "safe-timeout-id",
        content: "hello",
      }),
    );
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.alarmWriteMs);
    expect((await pending).status).toBe(503);
    expect(state.aborts).toEqual(["Alarm pre-arm timed out"]);
    expect(admit).not.toHaveBeenCalled();
  });

  it("rejects oversized, malformed, and structurally invalid messages", async () => {
    const state = new TestState();
    const admit = vi.fn();
    const runtime = controller(state, store({ admit }));
    const oversized = post(
      "/v2/messages",
      { content: "small" },
      {
        "content-length": String(CHAT_RUNTIME_BOUNDS.requestBytes + 1),
      },
    );
    expect((await runtime.fetch(oversized)).status).toBe(413);
    expect((await runtime.fetch(post("/v2/messages", "{"))).status).toBe(400);
    expect(
      (
        await runtime.fetch(
          post("/v2/messages", { clientMessageId: "id", text: "rpc" }),
        )
      ).status,
    ).toBe(422);

    const streamed = post(
      "/v2/messages",
      JSON.stringify({
        clientMessageId: "large",
        content: "x".repeat(CHAT_RUNTIME_BOUNDS.requestBytes),
      }),
    );
    expect((await runtime.fetch(streamed)).status).toBe(413);
    expect(admit).not.toHaveBeenCalled();
  });

  it("rejects deeply nested request JSON before JSON.parse", async () => {
    const state = new TestState();
    const runtime = controller(state, store({ admit: vi.fn() }));
    const raw =
      "[".repeat(CHAT_RUNTIME_BOUNDS.providerJsonDepth + 1) +
      "0" +
      "]".repeat(CHAT_RUNTIME_BOUNDS.providerJsonDepth + 1);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect((await runtime.fetch(post("/v2/messages", raw))).status).toBe(400);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("allows only named controls and has no generic RPC surface", async () => {
    const state = new TestState();
    const control = vi.fn(() => "stopped");
    const runtime = controller(state, store(), callbacks({ control }));
    expect(
      (
        await runtime.fetch(
          post("/v2/controls", { action: "rpc", payload: { method: "wipe" } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await runtime.fetch(post("/v2/controls", { action: "stop" }))).status,
    ).toBe(200);
    expect(control).toHaveBeenCalledOnce();
    expect((await runtime.fetch(post("/v2/call", {}))).status).toBe(404);
  });
});
