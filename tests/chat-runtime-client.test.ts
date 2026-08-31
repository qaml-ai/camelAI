import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatRuntimeClient,
  type ChatRuntimeFrame,
  type ChatRuntimeMessage,
} from "@/lib/chat-runtime-client";
import { CHAT_RUNTIME_BOUNDS } from "@/lib/chat-runtime-bounds";

class TestStream {
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly response: Response;

  constructor(signal?: AbortSignal | null) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    signal?.addEventListener("abort", () => {
      try {
        this.controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // Already closed.
      }
    });
    this.response = new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  }

  write(text: string): void {
    this.controller.enqueue(new TextEncoder().encode(text));
  }

  writeBytes(bytes: Uint8Array): void {
    this.controller.enqueue(bytes);
  }

  frame(frame: unknown): void {
    this.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  comment(): void {
    this.write(":hb\n\n");
  }

  end(): void {
    this.controller.close();
  }
}

class TestTransport {
  gets: string[] = [];
  posts: Array<{ url: string; body: unknown }> = [];
  streams: TestStream[] = [];
  getFailures = 0;
  postFailures = 0;
  hangGets = false;

  fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET") === "POST") {
      this.posts.push({ url, body: JSON.parse(String(init?.body)) });
      if (this.postFailures > 0) {
        this.postFailures -= 1;
        throw new TypeError("response lost");
      }
      return Response.json({ accepted: true });
    }
    this.gets.push(url);
    if (this.hangGets) {
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }
    if (this.getFailures > 0) {
      this.getFailures -= 1;
      return new Response("unavailable", { status: 503 });
    }
    const stream = new TestStream(init?.signal);
    this.streams.push(stream);
    return stream.response;
  };

  get lastStream(): TestStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no stream");
    return stream;
  }
}

const message = (id: string, text = id): ChatRuntimeMessage => ({
  id,
  role: "assistant",
  content: text,
  createdAt: 1,
  status: "completed",
});

describe("ChatRuntimeClient", () => {
  let transport: TestTransport;
  let client: ChatRuntimeClient;
  let frames: ChatRuntimeFrame[];
  let statuses: string[];
  let errors: Error[];

  beforeEach(() => {
    vi.useFakeTimers();
    transport = new TestTransport();
    frames = [];
    statuses = [];
    errors = [];
    client = new ChatRuntimeClient({
      baseUrl: "/agents/chat-thread/t1/v2",
      fetch: transport.fetch as typeof fetch,
      onFrame: (frame) => frames.push(frame),
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
    });
  });

  afterEach(() => {
    client.close();
    vi.useRealTimers();
  });

  it("opens cursor SSE, accepts a cursor-zero snapshot, and resumes after EOF", async () => {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.gets[0]).toBe("/agents/chat-thread/t1/v2/events?after=0");
    expect(client.connectionStatus).toBe("connecting");

    transport.lastStream.frame({
      type: "snapshot",
      cursor: 0,
      messages: [message("a1")],
      activeTurn: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connectionStatus).toBe("ready");
    expect(frames.at(-1)).toMatchObject({ type: "snapshot", cursor: 0 });

    transport.lastStream.frame({
      type: "turn",
      cursor: 2,
      activeTurn: null,
      message: message("a2"),
    });
    transport.lastStream.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.gets[1].endsWith("/events?after=2")).toBe(true);
  });

  it("delivers cumulative live frames without moving the durable cursor", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "running" as const,
      acceptedAt: 1,
      startedAt: 2,
    };
    const live = (epoch: string, seq: number, text: string) => ({
      type: "live",
      turnId: activeTurn.id,
      epoch,
      seq,
      activeTurn,
      message: {
        id: "turn-1:assistant",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking", signature: "sig" },
          { type: "text", text },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "src/app.ts" },
          },
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "contents",
            status: "succeeded",
          },
        ],
        createdAt: 2,
        status: "running",
      },
    });

    client.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.lastStream.frame({
      type: "snapshot",
      cursor: 7,
      messages: [],
      activeTurn,
    });
    transport.lastStream.frame(live("attempt-a", 1, "one"));
    transport.lastStream.frame(live("attempt-a", 1, "duplicate"));
    transport.lastStream.frame(live("attempt-a", 0, "older"));
    transport.lastStream.frame(live("attempt-a", 2, "two"));
    transport.lastStream.frame(live("attempt-b", 0, "recovered"));
    transport.lastStream.frame(live("attempt-a", 3, "stale retake"));
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toEqual([]);
    expect(frames.map((frame) => frame.type)).toEqual([
      "snapshot",
      "live",
      "live",
      "live",
    ]);
    expect(
      frames.slice(1).map((frame) => frame.type === "live" && frame.seq),
    ).toEqual([1, 2, 0]);
    expect(frames.at(-1)).toMatchObject({
      type: "live",
      epoch: "attempt-b",
      seq: 0,
      message: {
        content: expect.arrayContaining([{ type: "text", text: "recovered" }]),
      },
    });
    expect(client.lastCursor).toBe(7);

    transport.lastStream.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.gets[1]).toContain("after=7");
    transport.lastStream.frame({
      type: "reset",
      cursor: 7,
      messages: [],
      activeTurn,
    });
    transport.lastStream.frame(live("attempt-b", 0, "seeded again"));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.at(-1)).toMatchObject({
      type: "live",
      epoch: "attempt-b",
      seq: 0,
      message: {
        content: expect.arrayContaining([
          { type: "text", text: "seeded again" },
        ]),
      },
    });
  });

  it("rejects unsupported or over-bound live content", async () => {
    const base = {
      type: "live",
      turnId: "turn-1",
      epoch: "attempt-a",
      seq: 1,
      activeTurn: {
        id: "turn-1",
        status: "running",
        acceptedAt: 1,
        startedAt: 2,
      },
      message: {
        id: "turn-1:assistant",
        role: "assistant",
        createdAt: 2,
        status: "running",
      },
    };
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.lastStream.frame({
      ...base,
      message: {
        ...base.message,
        content: Array.from(
          { length: CHAT_RUNTIME_BOUNDS.liveContentBlocks + 1 },
          () => ({ type: "text", text: "" }),
        ),
      },
    });
    transport.lastStream.frame({
      ...base,
      message: {
        ...base.message,
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: [{ type: "text", text: "nested" }],
          },
        ],
      },
    });
    transport.lastStream.frame({
      ...base,
      message: {
        ...base.message,
        content: [{ type: "text", text: "safe" }],
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(errors).toHaveLength(2);
    expect(errors.every((error) => error.message.includes("live frame"))).toBe(
      true,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "live", seq: 1 });
    expect(client.lastCursor).toBe(0);
  });

  it("rejects broad tool input without materializing Object.entries", async () => {
    const wideInput = Object.fromEntries([
      ["wide_marker", true],
      ...Array.from(
        { length: CHAT_RUNTIME_BOUNDS.providerJsonEntries },
        (_, index) => [`field_${index}`, index],
      ),
    ]);
    const entriesSpy = vi.spyOn(Object, "entries");
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      transport.lastStream.frame({
        type: "live",
        turnId: "turn-1",
        epoch: "attempt-a",
        seq: 1,
        activeTurn: {
          id: "turn-1",
          status: "running",
          acceptedAt: 1,
          startedAt: 2,
        },
        message: {
          id: "turn-1:assistant",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call-1",
              name: "read_file",
              input: wideInput,
            },
          ],
          createdAt: 2,
          status: "running",
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(frames).toEqual([]);
      expect(errors.at(-1)?.message).toContain("live frame");
      expect(
        entriesSpy.mock.calls.some(
          ([value]) =>
            value !== null &&
            typeof value === "object" &&
            Object.prototype.hasOwnProperty.call(value, "wide_marker"),
        ),
      ).toBe(false);
    } finally {
      entriesSpy.mockRestore();
    }
  });

  it("counts comment heartbeats as liveness", async () => {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.lastStream.comment();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    transport.lastStream.comment();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.gets).toHaveLength(1);
    expect(client.connectionStatus).toBe("ready");
  });

  it("rejects malformed and over-bound snapshots without poisoning the cursor", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/custom",
      eventsPath: "/stream",
      fetch: transport.fetch as typeof fetch,
      maxSnapshotMessages: 1,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.lastStream.write("data: not-json\n\n");
    transport.lastStream.frame({
      type: "snapshot",
      cursor: 9,
      messages: [message("a1"), message("a2")],
      activeTurn: null,
    });
    transport.lastStream.frame({
      type: "snapshot",
      cursor: 9,
      messages: [message("safe")],
      activeTurn: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.gets[0]).toBe("/custom/stream?after=0");
    expect(errors).toHaveLength(2);
    expect(frames).toHaveLength(1);
    expect(client.lastCursor).toBe(9);
  });

  it("cuts off an event that exceeds the byte bound", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxFrameBytes: 32,
      maxAttempts: 2,
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    // Character counts are insufficient here: each `é` is two UTF-8 bytes.
    transport.lastStream.write(`data: ${"é".repeat(20)}`);
    await vi.advanceTimersByTimeAsync(250);
    expect(errors[0]?.message).toContain("byte limit");
    expect(transport.gets).toHaveLength(2);
  });

  it("accepts coalesced network chunks when every SSE frame is bounded", async () => {
    const maxFrameBytes = 256;
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxFrameBytes,
      maxAttempts: 1,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = (content: string) => ({
      type: "snapshot",
      cursor: 1,
      messages: [message("bounded", content)],
      activeTurn: null,
    });
    const frame = (content: string) =>
      `data: ${JSON.stringify(snapshot(content))}\n\n`;
    const wireBytes = (value: string) =>
      new TextEncoder().encode(value).byteLength;
    let low = 0;
    let high = maxFrameBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (wireBytes(frame("x".repeat(middle))) <= maxFrameBytes) low = middle;
      else high = middle - 1;
    }
    const boundedFrame = frame("x".repeat(low));
    const coalesced = `:hb\n\n${boundedFrame}`;
    expect(wireBytes(boundedFrame)).toBeLessThanOrEqual(maxFrameBytes);
    expect(wireBytes(coalesced)).toBeGreaterThan(maxFrameBytes);

    transport.lastStream.write(coalesced);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "snapshot", cursor: 1 });
  });

  it("keeps incomplete-frame byte accounting linear", async () => {
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    const content = "x".repeat(512 * 1024);
    const wire = `data: ${JSON.stringify({
      type: "snapshot",
      cursor: 1,
      messages: [message("large", content)],
      activeTurn: null,
    })}\n\n`;
    const bytes = new TextEncoder().encode(wire);
    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");

    try {
      transport.lastStream.writeBytes(bytes);
      await vi.advanceTimersByTimeAsync(0);

      const encodedCharacters = encodeSpy.mock.calls.reduce(
        (total, [value]) => total + (value?.length ?? 0),
        0,
      );
      // One completed-wire measurement plus semantic content validation is
      // linear. Re-encoding every growing 64 KiB prefix exceeds this by far.
      expect(encodedCharacters).toBeLessThan(wire.length * 3);
      expect(errors).toEqual([]);
      expect(frames.at(-1)).toMatchObject({
        type: "snapshot",
        messages: [{ id: "large" }],
      });
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it("counts raw CRLF event bytes before newline normalization", async () => {
    const maxFrameBytes = 512;
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxFrameBytes,
      maxAttempts: 1,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    const crlf = "\r\n";
    const data = `data: ${JSON.stringify({ type: "hello", cursor: 1 })}`;
    let comments = "";
    while (
      new TextEncoder().encode(
        `${comments}:${crlf}${data}${crlf}${crlf}`.replaceAll(crlf, "\n"),
      ).byteLength <= maxFrameBytes
    ) {
      comments += `:${crlf}`;
    }
    const wire = `${comments}${data}${crlf}${crlf}`;
    expect(new TextEncoder().encode(wire).byteLength).toBeGreaterThan(
      maxFrameBytes,
    );
    expect(
      new TextEncoder().encode(wire.replaceAll(crlf, "\n")).byteLength,
    ).toBeLessThanOrEqual(maxFrameBytes);

    transport.lastStream.write(wire);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([]);
    expect(errors.at(-1)?.message).toContain("byte limit");
  });

  it("includes the LF event delimiter in the exact frame cap", async () => {
    const maxFrameBytes = 256;
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxFrameBytes,
      maxAttempts: 1,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);

    const block = (content: string) =>
      `data: ${JSON.stringify({
        type: "snapshot",
        cursor: 1,
        messages: [message("bounded", content)],
        activeTurn: null,
      })}`;
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
    let low = 0;
    let high = maxFrameBytes;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (bytes(block("x".repeat(middle))) <= maxFrameBytes) low = middle;
      else high = middle - 1;
    }
    const exactBlock = block("x".repeat(low));
    expect(bytes(exactBlock)).toBe(maxFrameBytes);
    expect(bytes(`${exactBlock}\n\n`)).toBe(maxFrameBytes + 2);

    transport.lastStream.write(`${exactBlock}\n\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([]);
    expect(errors.at(-1)?.message).toContain("byte limit");
  });

  it("parses CRLF and UTF-8 split across individual network bytes", async () => {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    const wire = new TextEncoder().encode(
      `data: ${JSON.stringify({
        type: "snapshot",
        cursor: 1,
        messages: [message("split", "café")],
        activeTurn: null,
      })}\r\n\r\n`,
    );
    for (const byte of wire) {
      transport.lastStream.writeBytes(Uint8Array.of(byte));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([]);
    expect(frames.at(-1)).toMatchObject({
      type: "snapshot",
      cursor: 1,
      messages: [{ content: "café" }],
    });
  });

  it("accepts an authoritative reset whose cursor moved backwards", async () => {
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.lastStream.frame({
      type: "snapshot",
      cursor: 9,
      messages: [message("old")],
      activeTurn: null,
    });
    transport.lastStream.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(transport.gets[1]).toContain("after=9");

    transport.lastStream.frame({
      type: "snapshot",
      cursor: 1,
      messages: [message("stale")],
      activeTurn: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.lastCursor).toBe(9);
    expect(frames.at(-1)).toMatchObject({
      type: "snapshot",
      cursor: 9,
      messages: [{ id: "old" }],
    });

    transport.lastStream.frame({
      type: "reset",
      cursor: 1,
      messages: [message("new")],
      activeTurn: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.lastCursor).toBe(1);
    expect(frames.at(-1)).toMatchObject({ type: "reset", cursor: 1 });
  });

  it("does not renew the failure budget for an immediate heartbeat then EOF", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxAttempts: 2,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 2; index += 1) {
      transport.lastStream.comment();
      transport.lastStream.end();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(transport.gets).toHaveLength(2);
    expect(client.connectionStatus).toBe("offline");
  });

  it("does not renew the failure budget for live presentation then EOF", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxAttempts: 2,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 2; index += 1) {
      transport.lastStream.frame({
        type: "live",
        turnId: "turn-1",
        epoch: `attempt-${index}`,
        seq: 0,
        activeTurn: {
          id: "turn-1",
          status: "running",
          acceptedAt: 1,
          startedAt: 2,
        },
        message: {
          id: "turn-1:assistant",
          role: "assistant",
          content: "working",
          createdAt: 2,
          status: "running",
        },
      });
      transport.lastStream.end();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(transport.gets).toHaveLength(2);
    expect(client.connectionStatus).toBe("offline");
  });

  it("renews the failure budget only after a stable stream interval", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxAttempts: 2,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 3; index += 1) {
      transport.lastStream.comment();
      await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.reconnectStableMs);
      transport.lastStream.end();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(transport.gets).toHaveLength(4);
  });
  it("stops after a bounded activation budget and focus grants a new one", async () => {
    transport.getFailures = 20;
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxAttempts: 3,
    });
    client.start();
    await vi.runAllTimersAsync();
    expect(transport.gets).toHaveLength(3);
    expect(client.connectionStatus).toBe("offline");

    globalThis.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.gets).toHaveLength(4);
  });

  it("bounds a hung attach and keeps POST messages independent of SSE", async () => {
    transport.hangGets = true;
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      attachTimeoutMs: 100,
      maxAttempts: 1,
    });
    client.start();
    await expect(
      client.sendMessage({ id: "m1", text: "hello" }),
    ).resolves.toEqual({ accepted: true });
    expect(transport.posts[0]).toEqual({
      url: "/chat/messages",
      body: { id: "m1", text: "hello" },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(client.connectionStatus).toBe("offline");
  });

  it("bounds an attach even when fetch ignores AbortSignal", async () => {
    const fetcher = () => new Promise<Response>(() => undefined);
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: fetcher as typeof fetch,
      attachTimeoutMs: 100,
      maxAttempts: 1,
      onError: (error) => errors.push(error),
    });

    client.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(client.connectionStatus).toBe("offline");
    expect(errors.at(-1)?.message).toContain("attach timed out");
  });

  it("releases a silent reader even when its cancel hook never settles", async () => {
    let sink!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sink = controller;
      },
      cancel,
    });
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: (() =>
        Promise.resolve(
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        )) as typeof fetch,
      silenceTimeoutMs: 100,
      maxAttempts: 1,
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    sink.enqueue(new TextEncoder().encode(":hb\n\n"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.connectionStatus).toBe("ready");

    await vi.advanceTimersByTimeAsync(100);

    expect(client.connectionStatus).toBe("offline");
    expect(errors.at(-1)?.message).toContain("silence deadline");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("retries a lost admission response once with the identical id and body", async () => {
    transport.postFailures = 1;
    const body = { clientMessageId: "stable-id", content: "hello" };

    await expect(client.sendMessage(body)).resolves.toEqual({ accepted: true });
    expect(transport.posts).toEqual([
      { url: "/agents/chat-thread/t1/v2/messages", body },
      { url: "/agents/chat-thread/t1/v2/messages", body },
    ]);
  });

  it("clamps caller limits and rejects invalid POSTs before transport", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      maxSnapshotMessages: CHAT_RUNTIME_BOUNDS.snapshotMessages * 100,
      onError: (error) => errors.push(error),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    transport.lastStream.frame({
      type: "snapshot",
      cursor: 1,
      messages: Array.from(
        { length: CHAT_RUNTIME_BOUNDS.snapshotMessages + 1 },
        (_, index) => message(`too-many-${index}`),
      ),
      activeTurn: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.at(-1)?.message).toContain("snapshot exceeds bounds");

    const encodeSpy = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      await expect(
        client.sendMessage({
          content: "x".repeat(CHAT_RUNTIME_BOUNDS.requestBytes * 4),
        }),
      ).rejects.toThrow("byte limit");
      expect(
        encodeSpy.mock.calls.every(
          ([value]) => (value?.length ?? 0) <= CHAT_RUNTIME_BOUNDS.requestBytes,
        ),
      ).toBe(true);
    } finally {
      encodeSpy.mockRestore();
    }
    let getterReads = 0;
    const accessorBody = {};
    Object.defineProperty(accessorBody, "content", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "unsafe";
      },
    });
    await expect(client.sendMessage(accessorBody)).rejects.toThrow("valid JSON");
    expect(getterReads).toBe(0);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(client.sendMessage(cyclic)).rejects.toThrow("valid JSON");
    expect(transport.posts).toHaveLength(0);
  });

  it("keeps the attach deadline until the first SSE byte", async () => {
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: transport.fetch as typeof fetch,
      attachTimeoutMs: 100,
      maxAttempts: 1,
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.streams).toHaveLength(1);
    expect(client.connectionStatus).toBe("connecting");

    await vi.advanceTimersByTimeAsync(100);
    expect(client.connectionStatus).toBe("offline");
  });

  it("ignores an old generation after explicit reconnect", async () => {
    let resolveOld!: (response: Response) => void;
    let calls = 0;
    const old = new TestStream();
    const fresh = new TestStream();
    const fetcher = () => {
      calls += 1;
      return calls === 1
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(fresh.response);
    };
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: fetcher as typeof fetch,
      onFrame: (frame) => frames.push(frame),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    resolveOld(old.response);
    await vi.advanceTimersByTimeAsync(0);
    old.frame({ type: "state", cursor: 8, state: { stale: true } });
    fresh.frame({ type: "state", cursor: 1, state: { fresh: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([
      { type: "state", cursor: 1, state: { fresh: true } },
    ]);
  });

  it("ignores an old generation released from a pending body read", async () => {
    let resolveOldRead!: (
      value: ReadableStreamReadResult<Uint8Array>,
    ) => void;
    const oldReader = {
      read: vi.fn(
        () =>
          new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
            resolveOldRead = resolve;
          }),
      ),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const oldResponse = {
      ok: true,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body: { getReader: () => oldReader },
    } as unknown as Response;
    const fresh = new TestStream();
    let calls = 0;
    const fetcher = () =>
      Promise.resolve(calls++ === 0 ? oldResponse : fresh.response);
    client = new ChatRuntimeClient({
      baseUrl: "/chat",
      fetch: fetcher as typeof fetch,
      onFrame: (frame) => frames.push(frame),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(oldReader.read).toHaveBeenCalledOnce();

    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    resolveOldRead({
      done: false,
      value: new TextEncoder().encode(
        `data: ${JSON.stringify({
          type: "state",
          cursor: 8,
          state: { stale: true },
        })}\n\n`,
      ),
    });
    fresh.frame({ type: "state", cursor: 1, state: { fresh: true } });
    await vi.advanceTimersByTimeAsync(0);

    expect(frames).toEqual([
      { type: "state", cursor: 1, state: { fresh: true } },
    ]);
  });
});
