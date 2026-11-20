import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeState = {
  messages: unknown[];
  indexes: number[];
  partial: unknown;
  progress: Map<string, unknown>;
  running: boolean;
  pendingInputs: unknown[];
  lastOutcome: unknown;
  hasOlder: boolean;
  transport: null;
  connected: boolean;
  expired?: boolean;
  loaded: boolean;
};

const watchers: Array<{ options: any; state: FakeState; emit(patch: Partial<FakeState>): void; closed: boolean; loadOlder: ReturnType<typeof vi.fn> }> = [];

vi.mock("@camelai/run/watch", () => ({
  watchAgent: (options: any) => {
    const state: FakeState = { messages: [], indexes: [], partial: null, progress: new Map(), running: false, pendingInputs: [], lastOutcome: null, hasOlder: false, transport: null, connected: true, loaded: true };
    const watcher = {
      options,
      state,
      closed: false,
      loadOlder: vi.fn(async () => true),
      emit(patch: Partial<FakeState>) {
        Object.assign(state, patch);
        options.onChange?.(state);
      },
    };
    watchers.push(watcher);
    return { state, loadOlder: watcher.loadOlder, close: () => { watcher.closed = true; } };
  },
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));
const { missedReply, watchLifecycle } = vi.hoisted(() => ({ missedReply: vi.fn(), watchLifecycle: vi.fn() }));
vi.mock("@/lib/chat-sse-telemetry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trackRuntimeViewMissedReply: missedReply,
  trackRuntimeWatchLifecycle: watchLifecycle,
}));

import { useRuntimeThread, type RuntimeThreadSeed } from "@/lib/use-runtime-thread";
import { V2_BROWSER_SESSION } from "@/lib/agent-runtime-shared";

const fetchCalls: Array<{ url: string; method: string; body: any }> = [];
let responses: Record<string, unknown> = {};
let statuses: Record<string, number> = {};

beforeEach(() => {
  watchers.length = 0;
  fetchCalls.length = 0;
  missedReply.mockReset();
  watchLifecycle.mockReset();
  responses = {};
  statuses = {};
  toastError.mockReset();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const call = { url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
    fetchCalls.push(call);
    const path = url.split("?")[0];
    const body = responses[path] ?? {};
    return new Response(JSON.stringify(body), { status: statuses[path] ?? 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const seed: RuntimeThreadSeed = {
  agentId: "agt_1",
  token: "abt_seed",
  expiresAt: Date.now() + 900_000,
  url: "https://agents.test",
  page: {
    entries: [
      { index: 0, message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } },
      { index: 1, message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", timestamp: 2 } },
    ],
    next: null,
  },
  previewTabs: [],
  activeTabId: null,
};

function mount(initialSeed: RuntimeThreadSeed | null = seed) {
  const callbacks = { current: { onOpen: vi.fn(), onStateUpdate: vi.fn() } };
  const hook = renderHook(() => useRuntimeThread({ threadId: "t1", workspaceId: "w1", seed: initialSeed, enabled: true, callbacks }));
  return { ...hook, callbacks };
}

describe("useRuntimeThread", () => {
  it.each(["turn_limit", "agent_loop_limit"])("does not show a %s completion as an error", async (stopped) => {
    const { callbacks, result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    act(() => watchers[0].emit({
      running: false,
      lastOutcome: { id: "limited-run", stopped },
      messages: [...seed.page!.entries.map((entry) => entry.message), { role: "assistant", content: [{ type: "text", text: "Stopped at the limit" }], stopReason: "stop", timestamp: 3 }],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(JSON.stringify(result.current.chat.messages)).toContain("Stopped at the limit"));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ lastError: null })));
    expect(result.current.chat.isStreaming).toBe(false);
  });

  it("shows a paused spend stop even when the watcher has no error text", async () => {
    const { callbacks, result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    act(() => watchers[0].emit({ running: false, lastOutcome: { id: "budget-run", stopped: "spend_limit" } }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      lastError: expect.objectContaining({ id: "rt-outcome:budget-run", error: "The run reached its spend limit" }),
    })));
    expect(result.current.chat.isStreaming).toBe(false);
  });

  it("paints the loader's page, then watches the agent with the loader's token", async () => {
    const { result, callbacks } = mount();
    expect(result.current.chat.messages.map((message) => message.id)).toEqual(["rt:0", "rt:1"]);
    expect(result.current.hasOlder).toBe(false);
    await waitFor(() => expect(callbacks.current.onOpen).toHaveBeenCalled());
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(watchers[0].options).toMatchObject({ url: "https://agents.test", agentId: "agt_1", token: "abt_seed" });
    expect(watchers[0].options.transport).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);

    act(() => watchers[0].emit({
      messages: seed.page!.entries.map((entry) => entry.message),
      indexes: [0, 1],
      running: true,
      partial: { role: "assistant", content: [{ type: "text", text: "more" }], stopReason: "stop", timestamp: 3 },
    }));
    await waitFor(() => expect(result.current.chat.isStreaming).toBe(true));
    // A response after a finished answer is a new turn (a run no message of ours started).
    expect(result.current.chat.streamingMessageId).toBe("rt:2");
  });

  it("keeps v2 watchers on SSE through reconnection", async () => {
    const url = "/api/threads/t1/runtime/w1";
    responses["/api/threads/t1/token"] = { token: V2_BROWSER_SESSION, expiresAt: Date.now() + 900_000, url, agentId: "agt_1" };
    mount({ ...seed, token: V2_BROWSER_SESSION, url });
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(watchers[0].options.transport).toBe("sse");
    act(() => watchers[0].emit({ expired: true, connected: false }));
    await waitFor(() => expect(watchers).toHaveLength(2), { timeout: 3_000 });
    expect(watchers[1].options.transport).toBe("sse");
  });

  it("recovers a null seed page through the watcher using the successful seed token", async () => {
    const { result } = mount({ ...seed, page: null });
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(watchers[0].options).toMatchObject({ token: seed.token, agentId: seed.agentId, url: seed.url });
    expect(fetchCalls).toHaveLength(0); // no second token request
    act(() => watchers[0].emit({
      loaded: true,
      messages: seed.page!.entries.map((entry) => entry.message),
      indexes: [0, 1],
    }));
    await waitFor(() => expect(result.current.chat.messages.map((message) => message.id)).toEqual(["rt:0", "rt:1"]));
  });

  it("keeps the loader's page on screen until the watcher has read history (AgentView.loaded)", async () => {
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    // Connected, history on its way: an empty view is not an empty chat.
    act(() => watchers[0].emit({ loaded: false, messages: [], indexes: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.chat.messages.map((message) => message.id)).toEqual(["rt:0", "rt:1"]);
    act(() => watchers[0].emit({
      loaded: true,
      messages: [...seed.page!.entries.map((entry) => entry.message), { role: "user", content: [{ type: "text", text: "again" }], timestamp: 3 }],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(result.current.chat.messages.map((message) => message.id)).toEqual(["rt:0", "rt:1", "rt:2"]));
  });

  it("watches again with a new token once the watcher stops on an expired token", async () => {
    responses["/api/threads/t1/token"] = { token: "abt_new", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_1" };
    mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    act(() => watchers[0].emit({ expired: true, connected: false }));
    await waitFor(() => expect(watchers).toHaveLength(2), { timeout: 3_000 });
    expect(watchers[0].closed).toBe(true);
    expect(watchers[1].options).toMatchObject({ agentId: "agt_1", token: "abt_new" });
  });

  it("watches again when the watcher stays disconnected (a 403/404 stops it without expiring)", async () => {
    responses["/api/threads/t1/token"] = { token: "abt_new", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_1" };
    mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => watchers[0].emit({ connected: false }));
      // A short drop is the watcher's own reconnect: left alone.
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      act(() => watchers[0].emit({ connected: true }));
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(watchers).toHaveLength(1);
      // Disconnected past the stall limit: a new watcher.
      act(() => watchers[0].emit({ connected: false }));
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(watchers).toHaveLength(2), { timeout: 3_000 });
    expect(watchers[0].closed).toBe(true);
    expect(watchers[1].options).toMatchObject({ token: "abt_new" });
  });

  it("keeps trying to watch when the first token cannot be minted", async () => {
    statuses["/api/threads/t1/token"] = 503;
    // The loader's token is too close to expiry to use, so the hook mints one.
    mount({ ...seed, expiresAt: Date.now() });
    await waitFor(() => expect(fetchCalls.filter((call) => call.url.startsWith("/api/threads/t1/token"))).toHaveLength(1));
    statuses["/api/threads/t1/token"] = 200;
    responses["/api/threads/t1/token"] = { token: "abt_late", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_1" };
    await waitFor(() => expect(watchers).toHaveLength(1), { timeout: 3_000 });
    expect(watchers[0].options).toMatchObject({ token: "abt_late" });
  });

  it("says it is reconnecting while the watcher stays down, and not after a short drop", async () => {
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(result.current.reconnecting).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => watchers[0].emit({ connected: false }));
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(result.current.reconnecting).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      expect(result.current.reconnecting).toBe(true);
      act(() => watchers[0].emit({ connected: true }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(result.current.reconnecting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends through the route, and matches the message that comes back to the client's id", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_1", agentId: "agt_1", fallback: null };
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    let sent: any;
    await act(async () => {
      sent = await result.current.client.call("sendMessage", ["Deploy it", "cm_1"]);
    });
    expect(sent).toMatchObject({ status: "accepted" });
    expect(fetchCalls[0]).toMatchObject({ url: "/api/threads/t1/messages?workspaceId=w1", method: "POST", body: { text: "Deploy it", clientMessageId: "cm_1" } });
    expect(result.current.chat.status).toBe("submitted");

    act(() => watchers[0].emit({
      messages: [...seed.page!.entries.map((entry) => entry.message), { role: "user", content: [{ type: "text", text: "Deploy it" }], timestamp: 5 }],
      indexes: [0, 1, 2],
      running: true,
    }));
    await waitFor(() => expect(result.current.chat.messages.some((message) => message.id === "cm_1" && message.clientMessageId === "cm_1")).toBe(true));
    // The run answers it, but nothing streams yet: still submitted until its first token.
    expect(result.current.chat.status).toBe("submitted");
  });

  it("starts watching once the first send creates the agent", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_1", agentId: "agt_new", fallback: null };
    responses["/api/threads/t1/token"] = { token: "abt_new", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_new" };
    const { result } = mount({ ...seed, agentId: null, token: null, url: null, expiresAt: null, page: null });
    expect(watchers).toHaveLength(0);
    await act(async () => {
      await result.current.client.call("sendMessage", ["first", "cm_1"]);
    });
    await waitFor(() => expect(watchers).toHaveLength(1));
    expect(watchers[0].options).toMatchObject({ agentId: "agt_new", token: "abt_new" });
  });

  it("retries the same fenced web send once on its published agent and replaces the old history", async () => {
    responses["/api/threads/t1/messages"] = { error: "Between runtimes", code: "AGENT_V2_CUTOVER", retryable: true };
    statuses["/api/threads/t1/messages"] = 503;
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    await expect(result.current.client.call("sendMessage", ["Deploy it", "cm_move"])).rejects.toThrow("Between runtimes");
    expect(watchers[0].closed).toBe(false);

    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_move", agentId: "agt_v2", fallback: null };
    statuses["/api/threads/t1/messages"] = 200;
    responses["/api/threads/t1/token"] = {
      token: V2_BROWSER_SESSION, expiresAt: Date.now() + 900_000,
      url: "/api/threads/t1/runtime/w1", agentId: "agt_v2",
    };
    await act(async () => {
      expect(await result.current.client.call("sendMessage", ["Deploy it", "cm_move"])).toMatchObject({ status: "accepted", requestId: "cm_move" });
    });
    await waitFor(() => expect(watchers).toHaveLength(2));
    expect(watchers[0].closed).toBe(true);
    expect(watchers[1].options).toMatchObject({ agentId: "agt_v2", token: V2_BROWSER_SESSION, transport: "sse" });
    expect(fetchCalls.filter((call) => call.url.startsWith("/api/threads/t1/messages"))).toEqual([
      expect.objectContaining({ body: { text: "Deploy it", clientMessageId: "cm_move" } }),
      expect.objectContaining({ body: { text: "Deploy it", clientMessageId: "cm_move" } }),
    ]);
    // Keep the existing paint until the replacement has its authoritative page.
    act(() => watchers[1].emit({ loaded: false }));
    expect(result.current.chat.messages).toHaveLength(2);
    act(() => watchers[1].emit({
      loaded: true,
      messages: [
        ...seed.page!.entries.map((entry) => entry.message),
        { role: "user", content: "Deploy it", requestId: "cm_move", timestamp: 5 },
        { role: "assistant", content: [{ type: "text", text: "Deployed" }], stopReason: "stop", timestamp: 6 },
      ],
      indexes: [40, 41, 42, 43],
    }));
    await waitFor(() => expect(result.current.chat.messages).toHaveLength(4));
    expect(result.current.chat.messages.filter((message) => message.clientMessageId === "cm_move")).toHaveLength(1);
    act(() => watchers[0].emit({ messages: [{ role: "user", content: "stale source frame", timestamp: 7 }], indexes: [99] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(JSON.stringify(result.current.chat.messages)).not.toContain("stale source frame");
    expect(result.current.chat.messages).toHaveLength(4);
  });

  it("keeps the current watcher when a fenced send resumes on the restored v1 agent", async () => {
    responses["/api/threads/t1/messages"] = { error: "Between runtimes", code: "AGENT_V2_CUTOVER", retryable: true };
    statuses["/api/threads/t1/messages"] = 503;
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    await expect(result.current.client.call("sendMessage", ["Keep going", "cm_restore"])).rejects.toThrow("Between runtimes");
    statuses["/api/threads/t1/messages"] = 200;
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_restore", agentId: "agt_1", fallback: null };
    await act(async () => {
      await result.current.client.call("sendMessage", ["Keep going", "cm_restore"]);
    });
    expect(watchers).toHaveLength(1);
    expect(watchers[0].closed).toBe(false);
    expect(fetchCalls.filter((call) => call.url.includes("/token"))).toHaveLength(0);
    expect(fetchCalls.filter((call) => call.url.includes("/messages")).map((call) => call.body.clientMessageId)).toEqual(["cm_restore", "cm_restore"]);
  });

  it("refreshes an existing tab's watcher when token renewal discovers a different agent", async () => {
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    responses["/api/threads/t1/token"] = {
      token: V2_BROWSER_SESSION, expiresAt: Date.now() + 900_000,
      url: "/api/threads/t1/runtime/w1", agentId: "agt_v2",
    };
    await act(async () => { await watchers[0].options.getToken(); });
    await waitFor(() => expect(watchers).toHaveLength(2));
    expect(watchers[0].closed).toBe(true);
    expect(watchers[1].options).toMatchObject({ agentId: "agt_v2", token: V2_BROWSER_SESSION, transport: "sse" });
    expect(result.current.chat.messages).toHaveLength(2);
  });

  it("does not let an older token response switch back from a published agent", async () => {
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    let releaseToken!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { releaseToken = resolve; }));
    const oldToken = watchers[0].options.getToken();
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_move", agentId: "agt_v2", fallback: null };
    responses["/api/threads/t1/token"] = {
      token: V2_BROWSER_SESSION, expiresAt: Date.now() + 900_000,
      url: "/api/threads/t1/runtime/w1", agentId: "agt_v2",
    };
    await act(async () => { await result.current.client.call("sendMessage", ["Continue", "cm_move"]); });
    await waitFor(() => expect(watchers).toHaveLength(2));
    await act(async () => {
      releaseToken(Response.json({ token: "abt_old", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_1" }));
      await oldToken;
    });
    expect(watchers).toHaveLength(2);
    expect(watchers[1].closed).toBe(false);
    expect(watchers[1].options.agentId).toBe("agt_v2");
  });

  it("asks a pending input as the chat's question card and answers it through the route", async () => {
    const { result, callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const input = { id: "in_1", kind: "question", message: "", detail: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } };
    act(() => watchers[0].emit({ messages: seed.page!.entries.map((entry) => entry.message), indexes: [0, 1], pendingInputs: [input] }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      pendingQuestion: expect.objectContaining({ questionId: "in_1" }),
    })));
    await act(async () => {
      await result.current.client.call("answerQuestion", ["in_1", { "Which?": "B" }]);
    });
    expect(fetchCalls.at(-1)).toMatchObject({
      url: "/api/threads/t1/inputs/in_1?workspaceId=w1",
      body: { action: "accept", content: { answers: { "Which?": "B" } } },
    });
    await act(async () => {
      await result.current.client.call("requestStop");
    });
    expect(fetchCalls.at(-1)).toMatchObject({ url: "/api/threads/t1/stop?workspaceId=w1", method: "POST" });
  });

  it("shows a refused first message as the turn's error until the thread has an agent", async () => {
    const refused = { ...seed, agentId: null, token: null, url: null, expiresAt: null, page: null, startError: { id: "rt-start:5", error: "LLM usage limit reached." } };
    const { callbacks } = mount(refused);
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenCalledWith(expect.objectContaining({
      lastError: expect.objectContaining({ id: "rt-start:5", error: "LLM usage limit reached." }),
    })));
    expect(watchers).toHaveLength(0);
  });

  it("matches a send with @-mentions to the message that carries the model's context for them", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_m", agentId: "agt_1", fallback: null };
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    await act(async () => {
      await result.current.client.call("sendMessage", ["Check @sales-db", "cm_m"]);
    });
    const modelText = "<camelai system message>\n## Referenced connections\n- @sales-db\n</camelai system message>\n\nCheck @sales-db";
    act(() => watchers[0].emit({
      messages: [...seed.page!.entries.map((entry) => entry.message), { role: "user", content: [{ type: "text", text: modelText }], timestamp: Date.now() }],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(result.current.chat.messages.some((message) => message.id === "cm_m" && message.clientMessageId === "cm_m")).toBe(true));
  });

  it("matches by the echoed requestId, and keeps one entry for a retried send", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_r", agentId: "agt_1", fallback: null };
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    await act(async () => {
      await result.current.client.call("sendMessage", ["hello", "cm_r"]);
      await result.current.client.call("sendMessage", ["hello", "cm_r"]);
    });
    act(() => watchers[0].emit({
      messages: [
        ...seed.page!.entries.map((entry) => entry.message),
        { role: "user", content: [{ type: "text", text: "something else entirely" }], requestId: "cm_r", timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      ],
      indexes: [0, 1, 2, 3],
    }));
    await waitFor(() => expect(result.current.chat.messages.some((message) => message.id === "cm_r" && message.clientMessageId === "cm_r")).toBe(true));
    expect(result.current.chat.messages.find((message) => message.id === "rt:3")?.clientMessageId).toBeUndefined();
  });

  it("never takes a message that names another send's request as this tab's", async () => {
    responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_mine", agentId: "agt_1", fallback: null };
    const { result } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    await act(async () => {
      await result.current.client.call("sendMessage", ["same words", "cm_mine"]);
    });
    act(() => watchers[0].emit({
      messages: [
        ...seed.page!.entries.map((entry) => entry.message),
        { role: "user", content: [{ type: "text", text: "same words" }], requestId: "cm_theirs", timestamp: Date.now() },
      ],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(result.current.chat.messages.some((message) => message.id === "cm_theirs" && message.clientMessageId === "cm_theirs")).toBe(true));
  });

  it("turns a failed send into a transport failure, so Chat resends it under the same id", async () => {
    responses["/api/threads/t1/messages"] = { error: "socket hang up", retryable: true };
    statuses["/api/threads/t1/messages"] = 503;
    const { result } = mount();
    await expect(result.current.client.call("sendMessage", ["hi", "cm_fail"])).rejects.toThrow("socket hang up");
  });

  it("opens again once for reconnects asked together, and backs off while sends keep failing", async () => {
    responses["/api/threads/t1/messages"] = { error: "This node is shutting down; retry", retryable: true };
    statuses["/api/threads/t1/messages"] = 503;
    const { result, callbacks } = mount();
    await waitFor(() => expect(callbacks.current.onOpen).toHaveBeenCalledTimes(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Several failures at once (a queue of sends, a watcher's own reopen): one pending reopen.
      for (const id of ["cm_1", "cm_2"]) await expect(result.current.client.call("sendMessage", ["hi", id])).rejects.toThrow();
      result.current.client.reconnect();
      result.current.client.reconnect();
      result.current.client.reconnect();
      // Two sends failed in a row: 1 s doubled twice.
      await act(async () => { vi.advanceTimersByTime(3_999); });
      expect(callbacks.current.onOpen).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(1); });
      expect(callbacks.current.onOpen).toHaveBeenCalledTimes(2);
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(callbacks.current.onOpen).toHaveBeenCalledTimes(2);

      // An accepted send ends the backoff.
      statuses["/api/threads/t1/messages"] = 200;
      responses["/api/threads/t1/messages"] = { status: "accepted", requestId: "cm_3", agentId: "agt_1" };
      await result.current.client.call("sendMessage", ["hi", "cm_3"]);
      result.current.client.reconnect();
      await act(async () => { vi.advanceTimersByTime(1_000); });
      expect(callbacks.current.onOpen).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why an answer was refused", async () => {
    const { result, callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const input = { id: "in_9", kind: "question", message: "", detail: { questions: [{ question: "Q?", header: "", options: [{ label: "A" }] }] } };
    act(() => watchers[0].emit({ messages: seed.page!.entries.map((entry) => entry.message), indexes: [0, 1], pendingInputs: [input] }));
    responses["/api/threads/t1/inputs/in_9"] = { error: "Forbidden" };
    statuses["/api/threads/t1/inputs/in_9"] = 403;
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      pendingQuestion: expect.objectContaining({ questionId: "in_9" }),
    })));
    await act(async () => {
      await result.current.client.call("answerQuestion", ["in_9", { "Q?": "A" }]);
    });
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("Only the person who started this turn"));
  });

  it("opens the preview a set_preview result names while the page watches", async () => {
    const { callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const base = seed.page!.entries.map((entry) => entry.message);
    act(() => watchers[0].emit({ messages: base, indexes: [0, 1] }));
    const target = { kind: "app", scriptName: "shop", isPublic: false };
    act(() => watchers[0].emit({
      messages: [...base, { role: "toolResult", toolCallId: "c1", toolName: "camel__set_preview", content: [], details: { success: true, target }, isError: false, timestamp: 9 }],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      previewTabs: [target],
      previewActiveTabId: expect.any(String),
    })));
  });

  it("opens what a notebook run or a deploy previewed, as the DO path did", async () => {
    const { callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const base = seed.page!.entries.map((entry) => entry.message);
    act(() => watchers[0].emit({ messages: base, indexes: [0, 1] }));
    const notebook = { kind: "file", source: "project", workspaceId: "w1", project: "sales", path: "analysis.ipynb", contentType: "application/x-ipynb+json" };
    act(() => watchers[0].emit({
      messages: [...base, { role: "toolResult", toolCallId: "n1", toolName: "camel__run_notebook", content: [], isError: false, timestamp: 9,
        details: { ok: true, preview: { success: true, target: notebook }, message: "Executed and previewed analysis.ipynb" } }],
      indexes: [0, 1, 2],
    }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ previewTabs: [notebook] })));
    const app = { kind: "app", scriptName: "shop", isPublic: false };
    act(() => watchers[0].emit({
      messages: [...watchers[0].state.messages, { role: "toolResult", toolCallId: "d1", toolName: "camel__deploy_project", content: [], isError: false, timestamp: 10,
        details: { success: true, url: "https://shop.test", preview: { success: true, target: app } } }],
      indexes: [0, 1, 2, 3],
    }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      previewTabs: [notebook, app],
      previewActiveTabId: "app:shop",
    })));
  });

  it("picks up previews set from inside js_exec when the run ends, from the thread's saved preview", async () => {
    const app = { kind: "app", scriptName: "dash", isPublic: true };
    responses["/api/threads/t1/preview"] = { preview: { tabs: [app], activeTabId: "app:dash" }, previewVersion: 3 };
    const { callbacks } = mount();
    await waitFor(() => expect(watchers).toHaveLength(1));
    const base = seed.page!.entries.map((entry) => entry.message);
    act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A js_exec call deployed from code: its result names no preview.
    act(() => watchers[0].emit({
      messages: [...base, { role: "toolResult", toolCallId: "j1", toolName: "js_exec", content: [{ type: "text", text: "done" }], isError: false, timestamp: 9 }],
      indexes: [0, 1, 2],
      running: false,
    }));
    await waitFor(() => expect(callbacks.current.onStateUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      previewTabs: [app],
      previewActiveTabId: "app:dash",
    })));
    expect(fetchCalls.some((call) => call.url.startsWith("/api/threads/t1/preview") && call.method === "GET")).toBe(true);
  });

  describe("a run whose end the watcher missed", () => {
    const reply = { role: "assistant", content: [{ type: "text", text: "pong" }], stopReason: "stop", timestamp: 4 };
    const prompt = { role: "user", content: [{ type: "text", text: "ping" }], timestamp: 3 };
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    afterEach(() => setVisibility("visible"));

    it("says so in a visible page, reading nothing", async () => {
      mount();
      await waitFor(() => expect(watchers).toHaveLength(1));
      const base = seed.page!.entries.map((entry) => entry.message);
      act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      // The run ends, and the watcher never delivered its messages.
      act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: false }));
      await waitFor(() => expect(missedReply).toHaveBeenCalledWith("t1", expect.objectContaining({ reason: "run_ended", knownMaxIndex: 1, viewMaxIndex: 1 })), { timeout: 5_000 });
      expect(fetchCalls.some((call) => call.url.includes("/history"))).toBe(false);
    }, 10_000);

    it("says nothing for a hidden page, whose watcher pauses, and does not watch again meanwhile", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        responses["/api/threads/t1/token"] = { token: "abt_reopen", expiresAt: Date.now() + 900_000, url: "https://agents.test", agentId: "agt_1" };
        mount();
        await waitFor(() => expect(watchers).toHaveLength(1));
        const base = seed.page!.entries.map((entry) => entry.message);
        act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: true }));
        act(() => setVisibility("hidden"));
        act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: false, connected: false }));
        await act(async () => { await vi.advanceTimersByTimeAsync(65_000); });
        expect(missedReply).not.toHaveBeenCalled();
        expect(watchers).toHaveLength(1);
        // Shown again with the watcher still down: it is watched again after the stall.
        act(() => setVisibility("visible"));
        await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
        await waitFor(() => expect(watchers.length).toBeGreaterThan(1));
      } finally {
        vi.useRealTimers();
      }
    }, 10_000);

    it("reads nothing when the run's messages arrived", async () => {
      const { result } = mount();
      await waitFor(() => expect(watchers).toHaveLength(1));
      const base = seed.page!.entries.map((entry) => entry.message);
      act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      act(() => watchers[0].emit({ messages: [...base, prompt, reply], indexes: [0, 1, 2, 3], running: false }));
      await waitFor(() => expect(result.current.chat.messages.map((message) => message.id)).toContain("rt:3"));
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      expect(missedReply).not.toHaveBeenCalled();
      expect(fetchCalls.some((call) => call.url.includes("/history"))).toBe(false);
    }, 10_000);

    it("reports when a watcher first connects", async () => {
      mount();
      await waitFor(() => expect(watchers).toHaveLength(1));
      act(() => watchers[0].emit({ connected: true }));
      act(() => watchers[0].emit({ connected: true, running: true }));
      expect(watchLifecycle).toHaveBeenCalledTimes(1);
      expect(watchLifecycle).toHaveBeenCalledWith("t1", "open", expect.objectContaining({ agentId: "agt_1", generation: 1 }));
    });
  });
});
