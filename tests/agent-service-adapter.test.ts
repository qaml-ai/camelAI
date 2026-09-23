// Runs chiridion's ChatThreadDO adapter (ServiceAgent) against a real agent
// runtime over its HTTP protocol. The runtime is a separate repository
// (qaml-ai/agent-runtime); point AGENT_RUNTIME_DIR at a checkout with its
// dependencies installed. Without it these tests are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { ServiceAgent } from "../workers/main/src/chat-thread/service-agent.ts";
import { memoryJournalStore, type SessionCredentials } from "@qaml-ai/agent-runtime";
import type { Api, Model } from "@earendil-works/pi-ai";

const runtimeDir = process.env.AGENT_RUNTIME_DIR ? resolve(process.env.AGENT_RUNTIME_DIR) : undefined;
if (runtimeDir && !existsSync(join(runtimeDir, "src/server.ts"))) throw new Error(`AGENT_RUNTIME_DIR=${runtimeDir} is not an agent-runtime checkout`);
const skip = runtimeDir ? false : "set AGENT_RUNTIME_DIR to a qaml-ai/agent-runtime checkout";
const options = { timeout: 20000, skip };

/** Start the runtime's own server entry point; resolves once it reports its listening address. */
async function startRuntime(env: Record<string, string>) {
  const child = spawn("node", ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(runtimeDir!, "src/server.ts")], {
    cwd: runtimeDir, env: { PATH: process.env.PATH ?? "", HOST: "127.0.0.1", PORT: "0", ...env }, stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = Promise.withResolvers<string>();
  child.on("error", ready.reject);
  child.on("exit", code => ready.reject(new Error(`Runtime exited with ${code} before listening`)));
  createInterface({ input: child.stdout! }).on("line", line => {
    try { const event = JSON.parse(line); if (event.type === "listening") ready.resolve(`http://127.0.0.1:${event.address.port}`); } catch {}
  });
  const url = await ready.promise;
  return { url, stop: () => stopProcess(child) };
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited; clearTimeout(timer);
}

async function fixture(t: any, reply: (body: any) => any) {
  const root = await mkdtemp(join(tmpdir(), "service-agent-test-"));
  const token = "test-service-agent-operator-key-long";
  const provider = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const delta = await reply(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const baseUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1`;
  const env = { AGENT_RUNTIME_TOKEN: token, AGENT_API_KEY: "fixture", AGENT_ALLOWED_BASE_URLS: baseUrl, AGENT_TOOL_TIMEOUT_MS: "5000", AGENT_DATA_DIR: root };
  let runtime = await startRuntime(env);
  const model = { id: "fixture", name: "Fixture", provider: "openai", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, baseUrl } as Model<Api>;
  const agents: ServiceAgent[] = [];
  let credentials: SessionCredentials | undefined;
  const store = memoryJournalStore();
  let requestId: string | undefined;
  const create = (tools: any[] = [], hooks: any = {}) => {
    const agent = new ServiceAgent({ initialState: { model, tools, systemPrompt: "Test agent", messages: [{ role: "user", content: "bootstrap", timestamp: 1 }] }, ...hooks }, {
      url: runtime.url, token, id: "adapter-test", journalStore: store,
      loadCredentials: () => credentials, saveCredentials: value => { credentials = value; },
      loadRequestId: () => requestId, saveRequestId: value => { requestId = value; },
      additionalTools: async () => ({}), authorize: async () => {},
    });
    agents.push(agent); return agent;
  };
  t.after(async () => {
    for (const agent of agents) await agent.closeService();
    await runtime.stop();
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { create, async restartService() {
    await runtime.stop();
    runtime = await startRuntime(env);
  }, get requestId() { return requestId; } };
}

test("application SDK adapter streams ordered native tool events, preserves history and reconnects", options, async t => {
  const bodies: any[] = [];
  const f = await fixture(t, body => {
    bodies.push(body);
    if (bodies.length === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "model-call-42", type: "function", function: { name: "inspect", arguments: "{}" } }] };
    return { role: "assistant", content: "completed" };
  });
  const events: string[] = []; let calls = 0; let originalId = ""; let policyAssistant: any;
  const agent = f.create([{ name: "inspect", label: "Inspect", description: "Read content", parameters: { type: "object" }, execute: async (id: string) => {
    calls++; originalId = id; assert.ok(events.includes("tool_execution_start"));
    return { content: [{ type: "text", text: "native-content" }], details: { ok: true } };
  } }], { beforeToolCall: async (context: any) => { policyAssistant = context.assistantMessage; } });
  agent.subscribe(async event => { await new Promise(resolve => setTimeout(resolve, 1)); events.push(event.type); });
  await agent.connectService();
  await agent.prompt({ role: "user", content: "Do inspect", timestamp: 2 });
  assert.equal(calls, 1); assert.equal(originalId, "model-call-42");
  assert.equal(policyAssistant.role, "assistant");
  assert.equal(events.at(-1), "agent_end");
  assert.ok(bodies[1].messages.some((m: any) => m.role === "tool" && m.content === "native-content"));
  assert.deepEqual(agent.state.messages.map(m => m.role), ["user", "user", "assistant", "toolResult", "assistant"]);
  await agent.closeService();
  // The agent's process goes away; its history must come back from durable state.
  await f.restartService();
  const reconnected = f.create(); await reconnected.connectService();
  await reconnected.prompt("What happened?");
  assert.ok(bodies.at(-1).messages.some((m: any) => m.content === "completed"));
  assert.equal(reconnected.state.messages.filter(m => m.role === "user" && m.content === "bootstrap").length, 1);
});

test("application policy blocks native side effects and failures remain tool errors", options, async t => {
  let requests = 0;
  const f = await fixture(t, () => {
    requests++;
    if (requests === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "blocked-call", type: "function", function: { name: "write", arguments: "{}" } }] };
    if (requests === 3) return { role: "assistant", tool_calls: [{ index: 0, id: "failed-call", type: "function", function: { name: "write", arguments: "{}" } }] };
    return { role: "assistant", content: "Tool failed safely." };
  });
  let calls = 0; let block = true;
  const agent = f.create([{ name: "write", label: "Write", description: "Write", parameters: { type: "object" }, execute: async () => {
    calls++; throw new Error("simulated write failure");
  } }], { beforeToolCall: async () => block ? { block: true, reason: "Policy denied" } : undefined });
  await agent.connectService();
  await agent.prompt("Attempt blocked write");
  assert.equal(calls, 0);
  let results = agent.state.messages.filter(message => message.role === "toolResult");
  assert.equal(results[0].isError, true);
  block = false;
  await agent.prompt("Attempt failed write");
  assert.equal(calls, 1);
  results = agent.state.messages.filter(message => message.role === "toolResult");
  assert.equal(results[1].isError, true);
  assert.match(JSON.stringify(results[1].content), /simulated write failure/);
});

test("native follow-up queued from a running tool completes without blocking SSE events", options, async t => {
  const bodies: any[] = [];
  const f = await fixture(t, body => {
    bodies.push(body);
    if (bodies.length === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "queue-call", type: "function", function: { name: "queue", arguments: "{}" } }] };
    return { role: "assistant", content: "finished" };
  });
  const agent = f.create([{ name: "queue", label: "Queue", description: "Queue", parameters: { type: "object" }, execute: async () => {
    agent.followUp({ role: "user", content: "queued native follow-up", timestamp: 42 });
    // Allow the distinct HTTP control request to be accepted while this callback runs.
    await new Promise(resolve => setTimeout(resolve, 100));
    return { content: [{ type: "text", text: "queued" }], details: {} };
  } }]);
  await agent.connectService();
  await agent.prompt("Start");
  assert.equal(bodies.length, 3);
  assert.ok(bodies[2].messages.some((m: any) => m.role === "user" && m.content === "queued native follow-up"));
  assert.ok(agent.state.messages.some(m => m.role === "user" && m.timestamp === 42));
});


test("detaching during inference keeps the service run alive and resumes without another model call", options, async t => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++; entered.resolve(); await release.promise;
    return { role: "assistant", content: "survived adapter disposal" };
  });
  const agent = f.create(); await agent.connectService();
  const pending = agent.prompt("Start a slow turn");
  const detached = assert.rejects(pending, /Client closed/);
  await entered.promise;
  const saved = f.requestId; assert.ok(saved);
  await agent.closeService(); await detached;
  assert.equal(f.requestId, saved);
  const next = f.create(); await next.connectService();
  const observing = next.resumeServiceRun();
  release.resolve();
  assert.equal(await observing, true);
  assert.equal(calls, 1);
  assert.equal(f.requestId, undefined);
  assert.match(JSON.stringify(next.state.messages), /survived adapter disposal/);
  assert.equal(await next.resumeServiceRun(), false);
});

test("completed detached request restores authoritative history without repeating tools", options, async t => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let providerCalls = 0; let toolCalls = 0;
  const f = await fixture(t, async () => {
    providerCalls++;
    if (providerCalls === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "once", type: "function", function: { name: "write", arguments: "{}" } }] };
    entered.resolve(); await release.promise;
    return { role: "assistant", content: "write completed exactly once" };
  });
  const tools = [{ name: "write", label: "Write", description: "Write", parameters: { type: "object" }, execute: async () => {
    toolCalls++; return { content: [{ type: "text", text: "written" }], details: {} };
  } }];
  const agent = f.create(tools); await agent.connectService();
  const pending = agent.prompt("Write once");
  const detached = assert.rejects(pending, /Client closed/);
  await entered.promise; await agent.closeService(); await detached;
  release.resolve();
  // Observe service completion before creating a new application adapter.
  // The fixture's server URL is private to the adapter; its read-only SDK client
  // gives us an exact completion barrier without timing-dependent sleeps.
  const oldClient = (agent as any).client;
  let record;
  do { record = await oldClient.requestStatus(f.requestId!); if (!record.outcome) await new Promise(resolve => setTimeout(resolve, 10)); } while (!record.outcome);
  const next = f.create(tools); await next.connectService();
  assert.equal(await next.resumeServiceRun(), true);
  assert.equal(providerCalls, 2); assert.equal(toolCalls, 1);
  assert.match(JSON.stringify(next.state.messages), /write completed exactly once/);
});


test("host restart surfaces interrupted execution without silently repeating the prompt", options, async t => {
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++; entered.resolve(); await release.promise;
    return { role: "assistant", content: "late response" };
  });
  const agent = f.create(); await agent.connectService();
  const pending = agent.prompt("Start"); const detached = assert.rejects(pending, /Client closed/);
  await entered.promise; await agent.closeService(); await detached;
  const saved = f.requestId;
  await f.restartService(); release.resolve();
  const next = f.create(); await next.connectService();
  await assert.rejects(next.resumeServiceRun(), /The runtime stopped during this request/);
  assert.equal(calls, 1); assert.equal(f.requestId, saved);
  await assert.rejects(next.prompt("Retry"), /existing service request/);
  assert.equal(calls, 1);
});
