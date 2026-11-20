import { afterEach, describe, expect, it, vi } from "vitest";
import { v2Fetch } from "../src/agent-runtime/runtime-v2";
import { readV2Thread } from "../src/agent-runtime/v2-thread-read";
import type { ChatEnv } from "../src/chat-thread/types";

const env = { AGENT_RUNTIME_V2_API_TOKEN: "captured-server-key" } as ChatEnv;
const agentId = "agt_thread";
const request = (read: string) => new Request(`https://app.test/threads/123/${read}`);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("uses Workers-compatible manual redirects and never repeats the request at the redirect target", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.redirect("https://other.test/", 307));
  await expect(v2Fetch(env, "/agents/test")).rejects.toMatchObject({ status: 502, code: "v2_runtime_redirect" });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://run.camelai.com/v2/agents/test", expect.objectContaining({
    redirect: "manual",
  }));
});

it("projects v2 messages and hides the upstream agent's configuration", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer captured-server-key");
    return String(input).includes("/history?") ? Response.json({
      messages: [{ seq: 9, role: "user", createdAt: 123, content: { text: "Hello", meta: { requestId: "client-123" } } }],
      nextBefore: 9,
    }) : Response.json({ activeRunId: "run_abc", mcpServers: [{ headers: { Authorization: "private" } }] });
  });
  const history = await readV2Thread(env, agentId, "viewer", "history", request("history"));
  expect(await history.json()).toEqual({
    entries: [{ index: 9, message: { role: "user", content: "Hello", timestamp: 123, requestId: "client-123" } }],
    next: 9,
  });
  const state = await readV2Thread(env, agentId, "viewer", "state", request("state"));
  expect(await state.json()).toEqual({ requests: [{ method: "prompt", state: "running", began: true }] });
});

it("delivers a tool snapshot and a text delta while the run is still active", async () => {
  const pending = new ReadableStream<Uint8Array>({
    start(controller) {
      const event = (seq: number, type: string, data: object) =>
        `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, runId: "run_abc", createdAt: 123, data })}\n\n`;
      controller.enqueue(new TextEncoder().encode(
        event(2, "tool_call_start", { callId: "call_abc", name: "camel__list_projects" }) +
        event(3, "text_delta", { delta: "Working", step: 2 }),
      ));
    },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const query = new URL(String(input)).searchParams;
    if (query.get("after") === "latest") return Response.json({ nextAfter: 1 });
    expect(query.get("after")).toBe("1");
    expect(query.get("follow")).toBe("1");
    return new Response(pending, { headers: { "content-type": "text/event-stream" } });
  });
  const response = await readV2Thread(env, agentId, "viewer", "events", request("events"));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const read = async () => decoder.decode((await reader.read()).value);
    expect(await read()).toContain("event: ready");
    expect(await read()).toContain("id: 1");
    expect(await read()).toContain('id: 2\ndata: {"type":"snapshot"}');
    const text = await read();
    expect(text).toContain('"type":"message_start"');
    expect(text).toContain('"delta":"Working"');
  } finally {
    await reader.cancel();
  }
});

describe("v2 browser long polls", () => {
  const poll = (cursor: number | null = 10, wait = "25", signal?: AbortSignal) => new Request(
    `https://app.test/threads/123/events?poll=1&wait=${wait}`,
    { headers: cursor === null ? {} : { "Last-Event-ID": String(cursor) }, signal },
  );
  const event = (seq: number, type = "run_started", data: object = {}) =>
    ({ seq, type, runId: "run_abc", createdAt: 123, data });
  const wire = (value: ReturnType<typeof event>) =>
    `id: ${value.seq}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

  function fixture(records: ReturnType<typeof event>[] = [], onSubscribe?: () => void, readCancellation?: Error) {
    let current!: { push: (text: string) => void; cancelled: ReturnType<typeof vi.fn> };
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const query = new URL(String(input)).searchParams;
      if (query.get("after") === "latest") return Response.json({ nextAfter: records.at(-1)?.seq ?? 0 });
      const after = Number(query.get("after"));
      if (query.has("follow")) {
        onSubscribe?.();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const cancelled = vi.fn();
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: cancelled });
        if (readCancellation) init?.signal?.addEventListener("abort", () => controller.error(readCancellation), { once: true });
        current = { push: (text) => controller.enqueue(new TextEncoder().encode(text)), cancelled };
        current.push(": connected\n\n" + records.filter((item) => item.seq > after).map(wire).join(""));
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      const events = records.filter((item) => item.seq > after);
      return Response.json({ events, nextAfter: events.at(-1)?.seq ?? after });
    });
    return {
      fetcher, records, source: () => current,
      emit(value: ReturnType<typeof event>) { records.push(value); current.push(wire(value)); },
    };
  }

  it("uses the Workers runtime for the event subscription fixtures", () => {
    expect(typeof WebSocketPair).toBe("function");
  });

  it("holds an empty poll through heartbeats, with no repeated native requests, and cancels at 25 seconds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    const pending = readV2Thread(env, agentId, "viewer", "events", poll(10, "1000")).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(10_000);
    f.source().push(": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(2); // One canonical page and one subscription, no timer-driven native reads.
    expect(new URL(String(f.fetcher.mock.calls[1][0])).search).toBe("?after=10&follow=1");
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ cursor: 10, events: [] });
    expect(f.source().cancelled).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it("returns the idle deadline response when upstream cancellation rejects read with a platform Error", async () => {
    vi.useFakeTimers();
    const f = fixture([], undefined, new Error("Reader cancelled"));
    const pending = readV2Thread(env, agentId, "viewer", "events", poll());
    // Fetch response bodies may reject reads with a platform Error, rather
    // than the AbortSignal reason or a DOMException named AbortError.
    const result = pending.then(value => ({ response: value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await result).not.toHaveProperty("error");
    expect(await ((await result) as { response: Response }).response.json()).toEqual({ cursor: 10, events: [] });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds repeated empty polls at cursor zero, which the SDK omits from Last-Event-ID", async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let index = 0; index < 2; index++) {
      let settled = false;
      const pending = readV2Thread(env, agentId, "viewer", "events", poll(null)).then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(24_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await (await pending).json()).toEqual({ cursor: 0, events: [{ id: "", data: { type: "snapshot" } }] });
      expect(f.source().cancelled).toHaveBeenCalledTimes(1);
    }
    expect(f.fetcher).toHaveBeenCalledTimes(6); // Initial head, canonical page and subscription per 25-second poll.
  });

  it("wakes an idle poll on run admission without waiting for the deadline or making a status request", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = readV2Thread(env, agentId, "viewer", "events", poll());
    await vi.advanceTimersByTimeAsync(12_000);
    f.emit(event(11));
    expect(await (await pending).json()).toEqual({ cursor: 11, events: [{ id: "11", data: { type: "snapshot" } }] });
    expect(f.fetcher).toHaveBeenCalledTimes(3); // Initial page, subscription, then one canonical page on wake.
    expect(f.fetcher.mock.calls.every(([url]) => !String(url).includes("/runs/"))).toBe(true);
    expect(f.source().cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves canonical-page batching across the subscribe race and repeated normal events", async () => {
    const records: ReturnType<typeof event>[] = [];
    const f = fixture(records, () => records.push(
      event(11, "text_delta", { delta: "Work", step: 2 }),
      event(12, "text_delta", { delta: "ing", step: 2 }),
      event(13, "tool_call_start", { callId: "call_abc" }),
    ));
    const first = await readV2Thread(env, agentId, "viewer", "events", poll());
    const body = await first.json() as { cursor: number; events: Array<{ id: string; data: { event?: { type: string } } }> };
    expect(body.cursor).toBe(13);
    expect(body.events.map((item) => item.id)).toEqual(["11", "11", "12", "13"]);
    expect(body.events.filter((item) => item.data.event?.type === "message_start")).toHaveLength(1);
    records.push(event(14));
    const second = await readV2Thread(env, agentId, "viewer", "events", poll(13));
    expect(await second.json()).toEqual({ cursor: 14, events: [{ id: "14", data: { type: "snapshot" } }] });
    expect(f.fetcher).toHaveBeenCalledTimes(4); // The second poll keeps the original immediate-page fast path.
    expect(f.source().cancelled).toHaveBeenCalledTimes(1);
  });

  it("advances past unprojected events and split frames without treating a heartbeat as progress", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = readV2Thread(env, agentId, "viewer", "events", poll());
    await vi.advanceTimersByTimeAsync(1);
    const ignored = event(11, "usage_updated");
    f.records.push(ignored);
    const packet = wire(ignored);
    f.source().push(packet.slice(0, 20));
    await vi.advanceTimersByTimeAsync(1);
    f.source().push(packet.slice(20) + ": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(24_998);
    expect(await (await pending).json()).toEqual({ cursor: 11, events: [] });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("cancels a waiting subscription and rejects when the browser aborts", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const pending = readV2Thread(env, agentId, "viewer", "events", poll(10, "25", controller.signal));
    const rejected = expect(pending).rejects.toThrow("Browser left");
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("Browser left"));
    await rejected;
    expect(f.source().cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds opening the subscription without empty success (platform error: %s)", async (platformError) => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      if (!new URL(String(_url)).searchParams.has("follow")) return Promise.resolve(Response.json({ events: [], nextAfter: 10 }));
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(platformError ? new Error("Request cancelled") : signal.reason), { once: true });
      });
    });
    const pending = readV2Thread(env, agentId, "viewer", "events", poll());
    await vi.advanceTimersByTimeAsync(25_000);
    expect((await pending).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds terminal-run lookup without acknowledging a cursor (platform error: %s)", async (platformError) => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) => String(url).includes("/runs/")
      ? new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(platformError ? new Error("Request cancelled") : signal.reason), { once: true });
      }) : original(url, init));
    const pending = readV2Thread(env, agentId, "viewer", "events", poll());
    await vi.advanceTimersByTimeAsync(1);
    f.emit(event(11, "run_completed"));
    await vi.advanceTimersByTimeAsync(24_999);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.json()).not.toHaveProperty("cursor");
    expect(f.source().cancelled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps wait=0 as one immediate page and refuses invalid waits and unsafe cursors", async () => {
    const f = fixture();
    const response = await readV2Thread(env, agentId, "viewer", "events", poll(10, "0"));
    expect(await response.json()).toEqual({ cursor: 10, events: [] });
    expect(new URL(String(f.fetcher.mock.calls[0][0])).search).toBe("?after=10");
    for (const wait of ["-1", "NaN", "Infinity"]) {
      expect((await readV2Thread(env, agentId, "viewer", "events", poll(10, wait))).status).toBe(400);
    }
    expect((await readV2Thread(env, agentId, "viewer", "events", poll(Number.MAX_SAFE_INTEGER + 1))).status).toBe(400);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails on a prematurely ended subscription and invalid native sequence", async () => {
    const empty = new Response("", { headers: { "content-type": "text/event-stream" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => new URL(String(url)).searchParams.has("follow")
      ? empty : Response.json({ events: [], nextAfter: 10 }));
    await expect(readV2Thread(env, agentId, "viewer", "events", poll())).rejects.toThrow("ended before the poll completed");
    vi.useFakeTimers();
    const f = fixture();
    const pending = readV2Thread(env, agentId, "viewer", "events", poll());
    const rejected = expect(pending).rejects.toThrow("Invalid v2 event sequence");
    await vi.advanceTimersByTimeAsync(1);
    f.emit(event(1.5));
    await rejected;
    expect(f.source().cancelled).toHaveBeenCalledTimes(1);
  });
});
