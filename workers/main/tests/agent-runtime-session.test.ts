import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import {
  RuntimeAgentSession,
  type RuntimeAgentRecord,
  type RuntimeRunRecord,
} from "../src/chat-thread/runtime-agent";

const MODEL = { id: "sonnet", api: "anthropic-messages", provider: "anthropic" } as never;

/** A runtime that answers each run with the frames `script` returns for it. */
function fakeRuntime(script: (requestId: string, method: string) => Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; path: string; body?: unknown; headers: Headers }> = [];
  let frames: string[] = [];
  let nextId = 6;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, body, headers });
    if (method === "POST" && url.pathname === "/v1/agents") return Response.json({ id: "client_1", token: "agent-token" }, { status: 201 });
    if (method === "PATCH") return Response.json({ id: "configure" }, { status: 202 });
    if (url.pathname === "/clients/client_1/state") return Response.json({ cursor: 5, requests: [] });
    if (method === "POST" && url.pathname === "/clients/client_1/requests") {
      const params = body as { id: string; method: string };
      if (params.method === "prompt" || params.method === "continue") {
        for (const frame of script(params.id, params.method)) {
          frames.push(`id: ${nextId++}\ndata: ${JSON.stringify(frame)}\n\n`);
        }
      }
      return Response.json({ id: params.id });
    }
    if (url.pathname.startsWith("/clients/client_1/requests/")) return Response.json({ id: "r" });
    if (url.pathname === "/clients/client_1/events") {
      const after = Number(headers.get("Last-Event-ID") ?? 0);
      const pending = frames.filter((frame) => Number(/^id: (\d+)/.exec(frame)![1]) > after);
      return new Response(`event: ready\ndata: {}\n\n: heartbeat\n\n${pending.join("")}`, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, reset: () => { frames = []; } };
}

function memoryStore() {
  const data: { agent: RuntimeAgentRecord | null; cursor: number | null; run: RuntimeRunRecord | null } = { agent: null, cursor: null, run: null };
  return {
    data,
    store: {
      agent: () => data.agent,
      saveAgent: (agent: RuntimeAgentRecord) => { data.agent = agent; },
      cursor: () => data.cursor,
      saveCursor: (cursor: number) => { data.cursor = cursor; },
      run: () => data.run,
      saveRun: (run: RuntimeRunRecord | null) => { data.run = run; },
    },
  };
}

function session(runtime: ReturnType<typeof fakeRuntime>, store = memoryStore()) {
  let activity = 0;
  const agent = new RuntimeAgentSession({
    env: { AGENT_RUNTIME_URL: "https://runtime.test", AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_DEFINITION: "def_1", APP_KV: {} as KVNamespace },
    store: store.store,
    identity: { orgId: "org1", workspaceId: "ws1", threadId: "thread1", subject: "user1" },
    actor: () => "user2",
    initialState: { systemPrompt: "", model: MODEL, tools: [], messages: [], thinkingLevel: "medium" },
    configuration: async () => ({ systemPrompt: "camel prompt" }),
    onActivity: () => { activity += 1; },
    fetch: runtime.fetch,
  });
  const events: Array<Record<string, unknown>> = [];
  agent.subscribe((event) => { events.push(event as never); });
  return { agent, events, store, activity: () => activity };
}

const userMessage = { role: "user", content: "hello", timestamp: 1, metadata: { renderMessageId: "u1" } } as unknown as AgentMessage;

describe("RuntimeAgentSession", () => {
  it("creates the thread's agent once, prompts as the actor, and relays the run's events with chiridion tool names", async () => {
    const reply = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "camel__list_apps", arguments: {} }], stopReason: "toolUse" };
    const runtime = fakeRuntime((requestId) => [
      { type: "event", requestId, event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "message_end", message: { role: "user", content: "hello", timestamp: 9 } } },
      { type: "event", requestId, event: { type: "tool_execution_start", toolCallId: "c1", toolName: "camel__list_apps", args: {} } },
      { type: "event", requestId, event: { type: "message_end", message: reply } },
      { type: "event", requestId: "other", event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: { reply: "" } } },
    ]);
    const { agent, events, store, activity } = session(runtime);
    await agent.prompt(userMessage);

    const create = runtime.calls.find((call) => call.path === "/v1/agents")!;
    expect(create.headers.get("Idempotency-Key")).toBe("thread:thread1");
    expect(create.body).toMatchObject({ definition: "def_1", ttlSeconds: null, subject: "user1", context: { org: "org1", workspace: "ws1", thread: "thread1" } });
    expect(runtime.calls.find((call) => call.method === "PATCH")!.body).toMatchObject({ systemPrompt: "camel prompt" });
    const prompt = runtime.calls.find((call) => call.path === "/clients/client_1/requests")!;
    expect(prompt.body).toMatchObject({ method: "prompt", params: { text: "hello", actor: "user2" } });
    expect(prompt.headers.get("Authorization")).toBe("Bearer agent-token");

    expect(events.map((event) => event.type)).toEqual(["agent_start", "message_end", "tool_execution_start", "message_end", "agent_end"]);
    expect(events[2]).toMatchObject({ toolName: "list_apps" });
    // The DO's own copy of the user message keeps its render id.
    expect(agent.state.messages[0]).toBe(userMessage);
    expect(agent.state.messages[1]).toMatchObject({ content: [{ name: "list_apps" }] });
    expect(agent.state.isStreaming).toBe(false);
    expect(store.data.agent).toEqual({ id: "client_1", token: "agent-token" });
    expect(store.data.cursor).toBe(12);
    expect(store.data.run).toBeNull();
    expect(activity()).toBeGreaterThan(0);

    // A second run reuses the agent and starts from the saved cursor.
    await agent.prompt(userMessage);
    expect(runtime.calls.filter((call) => call.path === "/v1/agents")).toHaveLength(1);
  });

  it("closes the turn with an error when the runtime refuses the run", async () => {
    const runtime = fakeRuntime((requestId) => [{ type: "response", id: requestId, outcome: { error: "Payment required" } }]);
    const { agent, events } = session(runtime);
    await agent.prompt(userMessage);
    expect(events.map((event) => event.type)).toEqual(["message_start", "message_end", "turn_end", "agent_end"]);
    expect(events[3]).toMatchObject({ messages: [{ stopReason: "error", errorMessage: "Payment required" }] });
  });

  it("resumes a run in flight by replaying it from its start cursor, without prompting again", async () => {
    const runtime = fakeRuntime((requestId) => [
      { type: "event", requestId, event: { type: "agent_start" } },
      { type: "event", requestId, event: { type: "agent_end", messages: [] } },
      { type: "response", id: requestId, outcome: { result: {} } },
    ]);
    const first = session(runtime);
    await first.agent.prompt(userMessage);
    const runId = (runtime.calls.find((call) => call.path === "/clients/client_1/requests")!.body as { id: string }).id;
    // The DO restarted mid-run: its store still names the run and where it began.
    const store = memoryStore();
    store.data.agent = first.store.data.agent;
    store.data.run = { requestId: runId, cursor: 5 };
    const second = session(runtime, store);
    const requestsBefore = runtime.calls.filter((call) => call.method === "POST" && call.path === "/clients/client_1/requests").length;
    await second.agent.continue();
    expect(second.events.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
    expect(runtime.calls.filter((call) => call.method === "POST" && call.path === "/clients/client_1/requests")).toHaveLength(requestsBefore);
    expect(store.data.run).toBeNull();
  });

  it("closes out a resumed turn whose message never reached the runtime", async () => {
    const runtime = fakeRuntime(() => []);
    const { agent, events } = session(runtime);
    await agent.continue();
    expect(events.at(-1)).toMatchObject({ type: "agent_end", messages: [{ errorMessage: expect.stringContaining("did not reach") }] });
  });
});
