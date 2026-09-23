import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { explicitKeyStream } from "../src/compaction.ts";

type Body = { messages: { role: string; content: unknown }[] };
const text = (body: Body) => JSON.stringify(body.messages);
const isSummarization = (body: Body) => text(body).includes("context summarization assistant");

/** An OpenAI-compatible provider that reports no usage, like some proxies. */
async function provider(t: { after(fn: () => Promise<void>): void }, options: { overflowAboveChars?: number } = {}) {
  const requests: Body[] = [];
  let summaries = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Body;
    requests.push(body);
    if (!isSummarization(body) && options.overflowAboveChars && text(body).length > options.overflowAboveChars) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `This endpoint's maximum context length is 8000 tokens. However, you requested about ${Math.round(text(body).length / 4)} tokens`, type: "invalid_request_error" } }));
      return;
    }
    const reply = isSummarization(body) ? `## Goal\nSUMMARY-MARKER-${++summaries}` : "ack";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = (contextWindow: number) => ({
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1000,
  }) as Model<Api>;
  return { requests, model, chat: () => requests.filter(body => !isSummarization(body)), summarizations: () => requests.filter(isSummarization) };
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "compaction-test-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  return supervisor;
}
const bridge = { definitions: [], async call() { return null; } };
const turn = (index: number) => `TURN-${index} ${"x".repeat(9000)}`;

test("long conversations compact into a summary; history stays complete and the working set survives restarts", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const model = fake.model(8000);
  await supervisor.start("long", { model, apiKey: "fixture" }, bridge);
  const events: any[] = [];
  for (let index = 0; index < 5; index++) {
    const result = await supervisor.request("long", "prompt", { text: turn(index) }, event => events.push(event));
    assert.equal(result.error, null);
  }
  assert.ok(fake.summarizations().length >= 1, "a summary was requested");
  assert.ok(events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0));
  assert.equal(events.filter(event => event.type === "context_trimmed").length, 0, "compaction, not trimming, bounded the context");
  const last = text(fake.chat().at(-1)!);
  assert.match(last, /SUMMARY-MARKER/);
  assert.match(last, /compacted into the following summary/);
  assert.doesNotMatch(last, /TURN-0 /, "the oldest turn now lives only in the summary");
  assert.match(last, /TURN-4 /);
  const status = await supervisor.request("long", "status");
  assert.equal(status.compacted, true);
  assert.equal(status.messages, 10);
  assert.ok(status.contextMessages < status.messages);
  // History is the full conversation, read from the log.
  const history = (await supervisor.request("long", "history")).messages;
  assert.equal(history.length, 10);
  assert.match(JSON.stringify(history[0]), /TURN-0 /);

  await supervisor.stop("long");
  const restarted = await supervisor.start("long", { model, apiKey: "fixture" }, bridge);
  assert.equal(restarted.messages, 10);
  const after = await supervisor.request("long", "status");
  assert.equal(after.contextMessages, status.contextMessages, "only the working set is loaded");
  await supervisor.request("long", "prompt", { text: "After restart" });
  assert.match(text(fake.chat().at(-1)!), /SUMMARY-MARKER/);
});

test("an imported history larger than one summarization request is summarized in chunks", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const initialMessages = Array.from({ length: 12 }, (_, index) => [
    { role: "user", content: turn(index), timestamp: index * 2 },
    { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", timestamp: index * 2 + 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ]).flat() as any[];
  await supervisor.start("imported", { model: fake.model(8000), apiKey: "fixture", initialMessages }, bridge);
  const result = await supervisor.request("imported", "prompt", { text: "What happened so far?" });
  assert.equal(result.error, null);
  const summarizations = fake.summarizations();
  assert.ok(summarizations.length >= 2, `expected chunked summaries, got ${summarizations.length}`);
  // Each later chunk builds on the previous chunk's summary.
  assert.match(text(summarizations[1]), /SUMMARY-MARKER-1/);
  assert.ok(text(fake.chat().at(-1)!).length < 8000 * 4, "the model request fits the context window");
});

test("a context overflow from the provider compacts and retries the turn once", async t => {
  const fake = await provider(t, { overflowAboveChars: 24_000 });
  const supervisor = await fixture(t);
  // The configured window is huge, so only the provider's rejection reveals the real limit.
  await supervisor.start("overflow", { model: fake.model(1_000_000), apiKey: "fixture", retry: { maxAttempts: 0, baseDelayMs: 1 } }, bridge);
  const events: any[] = [];
  for (let index = 0; index < 3; index++) {
    const result = await supervisor.request("overflow", "prompt", { text: turn(index) }, event => events.push(event));
    assert.equal(result.error, null, `turn ${index}`);
  }
  assert.ok(events.some(event => event.type === "compaction_end" && event.reason === "overflow" && event.summarizedMessages > 0));
  const history = (await supervisor.request("overflow", "history")).messages;
  assert.equal(history.filter((message: any) => message.stopReason === "error").length, 0, "the rejected attempt is not history");
  assert.equal(history.length, 6);
});

test("model calls require the agent's explicit key and never read provider keys from the environment", async () => {
  process.env.OPENAI_API_KEY = "host-key-that-must-not-be-used";
  try {
    const stream = explicitKeyStream();
    const model = { id: "gpt-4o", provider: "openai", api: "openai-completions", baseUrl: "http://127.0.0.1:9" } as Model<Api>;
    assert.throws(() => stream(model, { messages: [] }, {}), /No openai API key/);
    assert.throws(() => stream(model, { messages: [] }, { apiKey: "  " }), /No openai API key/);
  } finally { delete process.env.OPENAI_API_KEY; }
});
