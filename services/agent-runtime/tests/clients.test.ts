import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSupervisor } from "../src/supervisor.ts";
import { ClientSessions, readJson } from "../src/client-sessions.ts";
import { configuredModel } from "../src/model.ts";
import { AgentClient, AgentRuntime, tool, schema, type AgentOptions, type RuntimeOptions, type Tool } from "../clients/typescript.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

const token = "fixture-operator-secret-32-characters";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: { timeout?: number; eventBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "camelai-sse-test-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME });
  let sessions = new ClientSessions(supervisor, { root: join(root, "sessions"), secret: token, apiKey: "fixture-only", toolTimeoutMs: options.timeout ?? 3000, eventBytes: options.eventBytes });
  let model = configuredModel();
  const server = createServer(async (req, res) => {
    if (await sessions.handle(req, res)) return;
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    try {
      const body = await readJson(req);
      const result = await sessions.create(body.tools, { model, ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt } : {}) }, req.headers["idempotency-key"] as string | undefined, { name: body.name, type: body.type });
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(error) })); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: AgentClient[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    sessions.close();
    await supervisor.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const runtimeOptions = { url, apiKey: token, stateDirectory: join(root, "sdk") };
  async function start(tools: AgentOptions["tools"] = {}, extra: Partial<AgentOptions> = {}, config: Partial<RuntimeOptions> = {}) {
    const runtime = new AgentRuntime({ ...runtimeOptions, ...config });
    const agent = await runtime.createAgent({ tools, ...extra });
    clients.push(agent);
    return agent;
  }
  async function post(agent: AgentClient, suffix: string, body: unknown) {
    return fetch(url + `/clients/${agent.session.id}${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${agent.session.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  return {
    root, supervisor, url, runtimeOptions, start, post, clients,
    get sessions() { return sessions; },
    setModel(chosen: Model<Api>) { model = chosen; },
    async restartHost() {
      sessions.close();
      await supervisor.close();
      sessions = new ClientSessions(supervisor, { root: join(root, "sessions"), secret: token, apiKey: "fixture-only" });
    },
  };
}
const echo = (execute: Tool<{ value: string }>["execute"]) => tool({
  description: "Fixture client tool", input: schema.Object({ value: schema.String() }, { additionalProperties: false }), execute,
});

test("SDK provisions scoped SSE sessions, infers tools, and controls lifecycle without raw HTTP", async t => {
  const f = await fixture(t);
  const a = await f.start({ echo: echo(() => "A") });
  const b = await f.start({ echo: echo(() => "B") });
  assert.notEqual((await a.status()).pid, (await b.status()).pid);
  const result = await Promise.all([a, b].map(agent => agent.execute('return await tools.echo({value:"hi"})')));
  assert.deepEqual(result.map(result => result.output), [["A"], ["B"]]);
  const headers = { Authorization: `Bearer ${b.session.token}` };
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/state`, { headers })).status, 401);
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/events?token=${a.session.token}`)).status, 401);
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/state`, { headers: { Authorization: `Bearer ${a.session.token}`, Origin: "https://evil.example" } })).status, 401);
  await assert.rejects(a.execute("return process.env"), /process/);
  await assert.rejects(a.request("execute", { code: "return 1", runtime: "/bin/sh" }), /Unknown codemode option/);
  await a.destroy();
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/state`, { headers: { Authorization: `Bearer ${a.session.token}` } })).status, 410);
  assert.equal((await b.status()).busy, false);
});

test("parallel calls correlate reversed replies and schemas reject invalid arguments", async t => {
  const f = await fixture(t);
  const invoked: string[] = [];
  const agent = await f.start({ echo: echo(async ({ value }) => {
    await sleep(value === "first" ? 50 : 1); invoked.push(value);
    return value;
  }) });
  const result = await agent.execute('return await Promise.all([tools.echo({value:"first"}),tools.echo({value:"second"})])');
  assert.deepEqual(JSON.parse(result.output[0]), ["first", "second"]);
  assert.deepEqual(invoked, ["second", "first"]);
  await assert.rejects(agent.execute('return await tools.echo({value: 1})'), /Invalid arguments/);
  assert.equal(invoked.length, 2);
});

test("lost request/result POST acknowledgements retry recorded outcomes, not executions", async t => {
  const f = await fixture(t);
  let writes = 0, lostRequest = false, lostResult = false;
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const path = String(input);
    if ((!lostRequest && path.endsWith("/requests")) || (!lostResult && path.endsWith("/outcome"))) {
      if (path.endsWith("/requests")) lostRequest = true; else lostResult = true;
      await response.text();
      throw new TypeError("Simulated acknowledgement lost after server commit");
    }
    return response;
  };
  const agent = await f.start({ echo: echo(() => { writes++; return { saved: true }; }) }, {}, { fetch: transport });
  const result = await agent.execute('return await tools.echo({value:"write"})', { idempotencyKey: "stable-request" });
  assert.deepEqual(JSON.parse(result.output[0]), { saved: true });
  const repeated = await agent.execute('return await tools.echo({value:"write"})', { idempotencyKey: "stable-request" });
  assert.deepEqual(repeated, result);
  assert.equal(writes, 1);
  assert.equal(lostRequest, true); assert.equal(lostResult, true);
  await assert.rejects(agent.execute("return 999", { idempotencyKey: "stable-request" }), /different arguments/);
  assert.equal((await agent.outcomes()).calls.length, 1);
});

test("SSE reconnect replays events and preserves an in-flight client callback", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const events: any[] = [];
  const agent = await f.start({ echo: echo(async () => { writes++; entered.resolve(); await release.promise; return "saved"; }) }, { onEvent: event => events.push(event) });
  const pid = (await agent.status()).pid;
  const running = agent.execute('text("before"); return await tools.echo({value:"write"})');
  await entered.promise;
  f.sessions.sessions.get(agent.session.id)!.response!.destroy();
  release.resolve();
  assert.deepEqual((await running).output, ["before", "saved"]);
  assert.equal(writes, 1);
  assert.equal((await agent.status()).pid, pid);
  assert.ok(events.length >= 1);
});

test("execution claims are one-time, late results are visible, and uncertain calls require explicit reconciliation", async t => {
  const f = await fixture(t, { timeout: 400 });
  const agent = await f.start({ echo: echo(() => "must not execute") });
  await agent.close();
  const running = f.supervisor.request(agent.session.id, "execute", { code: 'return await tools.echo({value:"write"})' });
  const rejected = assert.rejects(running, /timed out|aborted/);
  let callId = "";
  for (let i = 0; i < 100; i++) {
    const calls = f.sessions.sessions.get(agent.session.id)!.saved.calls;
    callId = Object.keys(calls)[0] ?? "";
    if (callId) break;
    await sleep(10);
  }
  assert.ok(callId);
  const claims = await Promise.all([f.post(agent, `/calls/${callId}/claim`, {}), f.post(agent, `/calls/${callId}/claim`, {})]);
  const values = await Promise.all(claims.map(response => response.json())) as { execute: boolean }[];
  assert.equal(values.filter(value => value.execute).length, 1);
  await rejected;
  assert.equal((await agent.outcomes()).needsReconciliation, true);
  assert.equal((await f.post(agent, "/requests", { id: "blocked", method: "execute", params: { code: "return 1" } })).status, 409);
  assert.equal((await f.post(agent, `/calls/${callId}/outcome`, { result: "verified late write" })).status, 200);
  assert.equal((await agent.outcomes()).calls[0].lateOutcome?.result, "verified late write");
  await agent.reconcile(callId, { result: "verified late write" });
  assert.equal((await agent.outcomes()).needsReconciliation, false);
  assert.equal((await f.post(agent, `/calls/${callId}/outcome`, { result: "conflicting result" })).status, 409);
});

test("client journal resends a completed result after restart without running the callback", async t => {
  const f = await fixture(t, { timeout: 5000 });
  let executions = 0;
  const receiptSaved = Promise.withResolvers<void>();
  let blackhole = true;
  const transport: typeof fetch = async (input, init) => {
    if (blackhole && String(input).endsWith("/outcome")) { receiptSaved.resolve(); throw new TypeError("Result upload unavailable"); }
    return fetch(input, init);
  };
  const tools = { echo: echo(() => { executions++; return "receipt survives restart"; }) };
  const agent = await f.start(tools, {}, { fetch: transport });
  const pending = agent.execute('return await tools.echo({value:"write"})', { idempotencyKey: "restart-request" });
  const rejected = assert.rejects(pending, /closed/);
  await receiptSaved.promise;
  await agent.close(); await rejected;
  blackhole = false;
  const resumed = await new AgentRuntime(f.runtimeOptions).connectAgent(agent.session, { tools });
  f.clients.push(resumed);
  const result = await resumed.execute('return await tools.echo({value:"write"})', { idempotencyKey: "restart-request" });
  assert.deepEqual(result.output, ["receipt survives restart"]);
  assert.equal(executions, 1);
  const journal = JSON.parse(await readFile(join(f.root, "sdk", `${agent.session.id}.json`), "utf8"));
  assert.equal(Object.values(journal.calls).length, 1);
});

test("bounded replay gaps recover from state; settled requests remain deduplicated after host restart", async t => {
  const f = await fixture(t, { eventBytes: 300 });
  const agent = await f.start();
  const original = await agent.execute('text("a".repeat(400)); return 42;', { idempotencyKey: "persisted" });
  await agent.close();
  await f.restartHost();
  const seen: string[] = [];
  const resumed = await new AgentRuntime({ ...f.runtimeOptions, stateDirectory: join(f.root, "new-sdk") }).connectAgent(agent.session, { tools: {}, onEvent: event => seen.push(event.type) });
  f.clients.push(resumed);
  assert.ok(seen.includes("replay_gap"));
  assert.deepEqual(await resumed.execute('text("a".repeat(400)); return 42;', { idempotencyKey: "persisted" }), original);
  assert.deepEqual((await resumed.execute("return 7")).output, ["7"]);
});

test("a real Pi turn receives an SSE client function's result", async t => {
  const f = await fixture(t);
  const bodies: any[] = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    const delta = bodies.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call_sse", type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code: 'return await tools.echo({value:"from model"})' }) } }] }
      : { role: "assistant", content: "Client updated." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish_reason] of [[delta, null], [{}, bodies.length === 1 ? "tool_calls" : "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(async () => { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  f.setModel({ id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>);
  let local = "";
  const agent = await f.start({ echo: echo(({ value }) => { local = value; return { verified: value }; }) });
  assert.equal((await agent.prompt("Update the client.")).error, null);
  assert.equal(local, "from model");
  assert.ok(bodies[1].messages.some((message: any) => message.role === "tool" && message.content.includes("verified")));
});


test("SDK system prompts are agent-scoped and persisted across host restarts", async t => {
  const f = await fixture(t);
  const runtime = new AgentRuntime(f.runtimeOptions);
  const systemPrompt = "You are the release reviewer. Answer concisely.";
  const agent = await runtime.createAgent({ tools: {}, systemPrompt, name: "September release", type: "release-reviewer" });
  f.clients.push(agent);
  const path = join(f.root, "sessions", `${agent.session.id}.json`);
  assert.equal(JSON.parse(await readFile(path, "utf8")).config.systemPrompt, systemPrompt);
  await agent.setMetadata({ name: "October release", type: "release-reviewer" });
  await agent.close();
  await f.restartHost();
  const resumed = await runtime.connectAgent(agent.session, { tools: {} });
  f.clients.push(resumed);
  assert.ok((await resumed.status()).pid);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).metadata, { name: "October release", type: "release-reviewer" });
  assert.equal(JSON.parse(await readFile(path, "utf8")).config.systemPrompt, systemPrompt);
});
