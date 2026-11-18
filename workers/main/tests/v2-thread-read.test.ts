import { afterEach, expect, it, vi } from "vitest";
import { v2Fetch } from "../src/agent-runtime/runtime-v2";
import { readV2Thread } from "../src/agent-runtime/v2-thread-read";
import type { ChatEnv } from "../src/chat-thread/types";

const env = { AGENT_RUNTIME_V2_API_TOKEN: "captured-server-key" } as ChatEnv;
const agentId = "agt_thread";
const request = (read: string) => new Request(`https://app.test/threads/123/${read}`);

afterEach(() => vi.restoreAllMocks());

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
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("after=latest")
    ? Response.json({ nextAfter: 1 })
    : new Response(pending, { headers: { "content-type": "text/event-stream" } }));
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
