import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRuntimeMessage } from "@/lib/chat-runtime-client";
import { useChatRuntime } from "@/lib/use-chat-runtime";

let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
let requests: Array<{ url: string; method: string; body?: unknown }>;

function emit(frame: unknown): void {
  controller!.enqueue(
    new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
  );
}

function emitTogether(frames: unknown[]): void {
  controller!.enqueue(
    new TextEncoder().encode(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""),
    ),
  );
}

const runtimeMessage = (
  id: string,
  role: "user" | "assistant",
  text: string,
): ChatRuntimeMessage => ({
  id,
  role,
  content: text,
  createdAt: 1,
  status: "completed",
});

describe("useChatRuntime", () => {
  beforeEach(() => {
    requests = [];
    controller = undefined;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push({
          url: String(input),
          method,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (method === "POST") return Response.json({ accepted: true });
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (value) => {
              controller = value;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("replaces snapshots/resets, projects legacy messages, and tracks active state", async () => {
    const { result } = renderHook(() =>
      useChatRuntime<{ model: string }>({ threadId: "thread 1" }),
    );
    await waitFor(() => expect(controller).toBeDefined());
    controller!.enqueue(new TextEncoder().encode(":hb\n\n"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(requests[0].url).toBe(
      "/agents/chat-thread/thread%201/v2/events?after=0",
    );

    act(() => {
      emit({
        type: "snapshot",
        cursor: 0,
        messages: [runtimeMessage("client-1:user", "user", "hello")],
        activeTurn: {
          id: "t1",
          status: "running",
          acceptedAt: 1,
          startedAt: 2,
        },
        state: { model: "sonnet" },
      });
    });
    await waitFor(() => expect(result.current.runtimeMessages).toHaveLength(1));
    expect(result.current.messages[0]).toMatchObject({
      id: "client-1:user",
      clientMessageId: "client-1",
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(result.current.status).toBe("running");
    expect(result.current.state).toEqual({ model: "sonnet" });

    act(() => {
      emit({
        type: "reset",
        cursor: 1,
        messages: [runtimeMessage("a1", "assistant", "done")],
        activeTurn: null,
      });
    });
    await waitFor(() =>
      expect(result.current.runtimeMessages[0]?.id).toBe("a1"),
    );
    expect(result.current.runtimeMessages).toHaveLength(1);
    expect(result.current.status).toBe("idle");
  });

  it("paints cumulative live blocks and preserves only the matching running overlay", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "running" as const,
      acceptedAt: 1,
      startedAt: 2,
    };
    const user = runtimeMessage("client-1:user", "user", "build it");
    const liveMessage = (content: ChatRuntimeMessage["content"]) => ({
      id: "turn-1:assistant",
      role: "assistant" as const,
      content,
      createdAt: 2,
      status: "running" as const,
    });
    const { result } = renderHook(() => useChatRuntime({ threadId: "t1" }));
    await waitFor(() => expect(controller).toBeDefined());
    controller!.enqueue(new TextEncoder().encode(":hb\n\n"));
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      emit({
        type: "snapshot",
        cursor: 1,
        messages: [user],
        activeTurn,
      });
      emit({
        type: "live",
        turnId: activeTurn.id,
        epoch: "attempt-a",
        seq: 1,
        activeTurn,
        message: liveMessage([
          { type: "thinking", thinking: "Inspecting" },
          { type: "text", text: "I found " },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "src/app.ts" },
          },
        ]),
      });
    });
    await waitFor(() =>
      expect(result.current.activeAssistantMessageId).toBe("turn-1:assistant"),
    );
    expect(result.current.runtimeMessages).toHaveLength(2);
    expect(result.current.messages.at(-1)).toMatchObject({
      id: "turn-1:assistant",
      role: "assistant",
      isStreaming: true,
      content: [
        { type: "thinking", thinking: "Inspecting" },
        { type: "text", text: "I found " },
        {
          type: "tool_use",
          id: "call-1",
          name: "read_file",
          input: { path: "src/app.ts" },
        },
      ],
    });

    act(() => {
      emit({
        type: "reset",
        cursor: 2,
        messages: [user],
        activeTurn,
      });
    });
    await waitFor(() =>
      expect(result.current.runtimeMessages.at(-1)?.id).toBe(
        "turn-1:assistant",
      ),
    );
    expect(result.current.messages.at(-1)?.isStreaming).toBe(true);

    act(() => {
      emit({
        type: "live",
        turnId: activeTurn.id,
        epoch: "attempt-a",
        seq: 2,
        activeTurn,
        message: liveMessage([
          { type: "thinking", thinking: "Inspecting" },
          { type: "text", text: "I found " },
          {
            type: "tool_use",
            id: "call-1",
            name: "read_file",
            input: { path: "src/app.ts" },
          },
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "export default App",
            status: "succeeded",
          },
          { type: "text", text: "the issue." },
        ]),
      });
    });
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.content).toEqual(
        expect.arrayContaining([
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "export default App",
            status: "succeeded",
          },
          { type: "text", text: "the issue." },
        ]),
      ),
    );

    act(() => {
      emit({
        type: "reset",
        cursor: 3,
        messages: [
          user,
          {
            ...liveMessage("I found the issue."),
            status: "completed",
          },
        ],
        activeTurn: null,
      });
    });
    await waitFor(() =>
      expect(result.current.activeAssistantMessageId).toBeNull(),
    );
    expect(result.current.messages.at(-1)).toMatchObject({
      id: "turn-1:assistant",
      content: [{ type: "text", text: "I found the issue." }],
    });
    expect(result.current.messages.at(-1)?.isStreaming).toBeUndefined();
    expect(result.current.status).toBe("idle");
  });

  it("clears a live overlay when a reset changes the active turn", async () => {
    const { result } = renderHook(() => useChatRuntime({ threadId: "t1" }));
    await waitFor(() => expect(controller).toBeDefined());
    const running = (id: string) => ({
      id,
      status: "running" as const,
      acceptedAt: 1,
      startedAt: 2,
    });
    act(() => {
      emit({
        type: "live",
        turnId: "turn-1",
        epoch: "attempt-a",
        seq: 1,
        activeTurn: running("turn-1"),
        message: {
          id: "turn-1:assistant",
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          createdAt: 2,
          status: "running",
        },
      });
    });
    await waitFor(() =>
      expect(result.current.activeAssistantMessageId).toBe("turn-1:assistant"),
    );

    act(() => {
      emit({
        type: "reset",
        cursor: 1,
        messages: [],
        activeTurn: running("turn-2"),
      });
    });
    await waitFor(() =>
      expect(result.current.activeAssistantMessageId).toBeNull(),
    );
    expect(result.current.runtimeMessages).toEqual([]);
    expect(result.current.activeTurn?.id).toBe("turn-2");
  });

  it("coalesces a live burst to its latest frame and cancels it on a terminal reset", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "running" as const,
      acceptedAt: 1,
      startedAt: 2,
    };
    const live = (seq: number) => ({
      type: "live",
      turnId: activeTurn.id,
      epoch: "attempt-a",
      seq,
      activeTurn,
      message: {
        id: "turn-1:assistant",
        role: "assistant",
        content: [{ type: "text", text: `frame-${seq}` }],
        createdAt: 2,
        status: "running",
      },
    });
    const seenLiveText: string[] = [];
    const { result } = renderHook(() => {
      const runtime = useChatRuntime({ threadId: "t1" });
      const content = runtime.messages.at(-1)?.content;
      const text =
        Array.isArray(content) && content[0]?.type === "text"
          ? content[0].text
          : undefined;
      if (runtime.activeAssistantMessageId && typeof text === "string") {
        seenLiveText.push(text);
      }
      return runtime;
    });
    await waitFor(() => expect(controller).toBeDefined());

    act(() => {
      emitTogether(Array.from({ length: 20 }, (_, index) => live(index + 1)));
    });
    await waitFor(() =>
      expect(result.current.messages.at(-1)?.content).toEqual([
        { type: "text", text: "frame-20" },
      ]),
    );
    expect(seenLiveText).toEqual(["frame-20"]);

    act(() => {
      emitTogether([
        live(21),
        {
          type: "reset",
          cursor: 1,
          messages: [runtimeMessage("turn-1:assistant", "assistant", "done")],
          activeTurn: null,
        },
      ]);
    });
    await waitFor(() =>
      expect(result.current.activeAssistantMessageId).toBeNull(),
    );
    expect(result.current.messages.at(-1)?.content).toEqual([
      { type: "text", text: "done" },
    ]);
    expect(seenLiveText).not.toContain("frame-21");
  });

  it("upserts turn messages and posts messages and controls", async () => {
    const { result } = renderHook(() =>
      useChatRuntime({ threadId: "t1", baseUrl: "/custom-v2" }),
    );
    await waitFor(() => expect(controller).toBeDefined());
    controller!.enqueue(new TextEncoder().encode(":hb\n\n"));
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => {
      emit({
        type: "snapshot",
        cursor: 1,
        messages: [runtimeMessage("a1", "assistant", "old")],
        activeTurn: null,
      });
      emit({
        type: "turn",
        cursor: 2,
        message: runtimeMessage("a1", "assistant", "new"),
        activeTurn: null,
      });
    });
    await waitFor(() =>
      expect(result.current.runtimeMessages[0]?.content).toBe("new"),
    );

    await act(async () => {
      await result.current.sendMessage({ id: "m1", text: "go" });
      await result.current.control("stop", { turnId: "t1" });
    });
    expect(requests.slice(-2)).toEqual([
      {
        url: "/custom-v2/messages",
        method: "POST",
        body: { id: "m1", text: "go" },
      },
      {
        url: "/custom-v2/controls",
        method: "POST",
        body: { action: "stop", payload: { turnId: "t1" } },
      },
    ]);
  });
});
