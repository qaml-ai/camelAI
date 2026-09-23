import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentSupervisor } from "../src/supervisor.ts";
import { localTools } from "../src/local-tools.ts";
import { configuredModel } from "../src/model.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

const model = configuredModel();
async function fixture(t: { after: (fn: () => Promise<void>) => void }, maxAgents = 4) {
  const root = await mkdtemp(join(tmpdir(), "camelai-runtime-test-"));
  const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const start = async (id: string, chosen = model, systemPrompt?: string) => supervisor.start(id, { model: chosen, apiKey: "fixture-only", systemPrompt }, await localTools(join(root, "workspaces", id)));
  return { root, supervisor, start };
}

test("two real agent processes compose tools concurrently, with distinct workspaces and code processes", async t => {
  const { root, supervisor, start } = await fixture(t, 2);
  const [a, b] = await Promise.all([start("a"), start("b")]);
  assert.notEqual(a.pid, b.pid);
  await assert.rejects(start("c"), /capacity/);
  await assert.rejects(start("a"), /already exists/);
  const outputs = await Promise.all(["a", "b"].map(id => supervisor.request(id, "execute", { code: `
    const value: string = "${id}";
    await tools.write({path: "result.txt", content: value});
    const results = await Promise.all([tools.read({path: "result.txt"}), tools.ls({})]);
    text(results[0].data.text);
    text((await tools.describe("read")).name);
    return typeof process;
  ` })));
  assert.deepEqual(outputs.map(r => r.output), [["a", "read", "undefined"], ["b", "read", "undefined"]]);
  assert.equal(await readFile(join(root, "workspaces", "a", "result.txt"), "utf8"), "a");
});

test("timeout, cancellation, errors and output limits leave the agent usable", async t => {
  const { supervisor, start } = await fixture(t);
  await start("a");
  await assert.rejects(supervisor.request("a", "execute", { code: "while (true) {}", timeoutMs: 1000 }), /timed out/);
  const started = Promise.withResolvers<void>();
  const running = supervisor.request("a", "execute", { code: 'text("started");\nreturn await new Promise(() => {});' }, () => started.resolve());
  const rejected = assert.rejects(running, /aborted/);
  await started.promise;
  await assert.rejects(supervisor.request("a", "execute", { code: "return 1" }), /busy/);
  await supervisor.request("a", "abort");
  await rejected;
  await assert.rejects(supervisor.request("a", "execute", { code: 'throw new Error("fixture failure")' }), /fixture failure/);
  await assert.rejects(supervisor.request("a", "execute", { code: "return 1", timeoutMs: 0 }), /timeoutMs/);
  const capped = await supervisor.request("a", "execute", { code: 'text("1234567890"); return "more";', maxOutputCharacters: 5 });
  assert.deepEqual(capped, { output: ["12345"], truncated: true });
  assert.equal((await supervisor.request("a", "status")).busy, false);
  assert.deepEqual((await supervisor.request("a", "execute", { code: "1 + 2;" })).output, ["3"]);
});

test("tool calls are correlated across reversed completion order and aborted on timeout", async t => {
  const { root, supervisor } = await fixture(t);
  let cancelled = false;
  await supervisor.start("a", { model }, {
    definitions: [{ name: "delay", description: "fixture", parameters: {} }],
    async call(_name, args, signal) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(args.value), Number(args.ms));
        signal.addEventListener("abort", () => { cancelled = true; clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
      });
    },
  });
  const result = await supervisor.request("a", "execute", { code: 'return await Promise.all([tools.delay({ms: 100, value: "first"}), tools.delay({ms: 1, value: "second"})]);' });
  assert.deepEqual(JSON.parse(result.output[0]), ["first", "second"]);
  await assert.rejects(supervisor.request("a", "execute", { code: 'await tools.delay({ms: 10000, value: 1});', timeoutMs: 1000 }), /timed out/);
  assert.equal(cancelled, true);
  const bridge = await localTools(join(root, "workspace"));
  await assert.rejects(bridge.call("read", { path: "../elsewhere" }, new AbortController().signal), /escapes/);
  await symlink(tmpdir(), join(root, "workspace", "escape"));
  await assert.rejects(bridge.call("write", { path: "escape/bad.txt", content: "x" }, new AbortController().signal), /escapes/);
});

async function fakeProvider(t: { after: (fn: () => Promise<void>) => void }, onRequest: (body: any) => any) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const delta = onRequest(JSON.parse(body));
    if (!delta) return; // Deliberately stalled provider for interrupted-turn test.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  return {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024,
  } as Model<Api>;
}

test("real Pi provider loop calls codemode and persists native messages across process restarts", async t => {
  const requests: any[] = [];
  const chosen = await fakeProvider(t, body => {
    requests.push(body);
    if (requests.length === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code: 'await tools.write({path: "pi.txt", content: "from Pi"}); return await tools.read({path: "pi.txt"});' }) } }] };
    return { role: "assistant", content: "File verified." };
  });
  const { root, supervisor, start } = await fixture(t);
  const applicationPrompt = "You are a release reviewer. Keep replies concise.";
  const first = await start("pi", chosen, applicationPrompt);
  const events: string[] = [];
  const result = await supervisor.request("pi", "prompt", { text: "Write and verify a file." }, event => events.push(event.type));
  assert.equal(result.error, null);
  assert.ok(events.includes("tool_execution_start"));
  assert.ok(events.includes("agent_end"));
  assert.equal(await readFile(join(root, "workspaces", "pi", "pi.txt"), "utf8"), "from Pi");
  const saved = JSON.parse(await readFile(join(root, "sessions", "pi", "session.json"), "utf8"));
  assert.deepEqual(saved.messages.map((m: any) => m.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(saved.active, false);
  assert.ok(requests[1].messages.some((m: any) => m.role === "tool" && m.content.includes("from Pi")));
  await supervisor.stop("pi");
  const restarted = await start("pi", chosen, applicationPrompt);
  assert.notEqual(restarted.pid, first.pid);
  assert.equal(restarted.messages, 4);
  await supervisor.request("pi", "prompt", { text: "What did you do?" });
  assert.ok(requests[2].messages.some((m: any) => m.content === "File verified."));
  for (const request of [requests[0], requests[2]]) {
    const instructions = request.messages.filter((m: any) => ["system", "developer"].includes(m.role)).map((m: any) => m.content).join("\n");
    assert.ok(instructions.includes(applicationPrompt));
    assert.ok(instructions.includes('await tools.search("")'));
    assert.ok(instructions.includes("QuickJS/WebAssembly"));
    assert.equal(instructions.split("Runtime tools and execution:").length - 1, 1);
  }
});

test("process death leaves an interrupted marker and does not silently replay a turn", async t => {
  const requested = Promise.withResolvers<void>();
  const chosen = await fakeProvider(t, () => { requested.resolve(); return null; });
  const { supervisor, start } = await fixture(t);
  await start("a", chosen);
  const running = supervisor.request("a", "prompt", { text: "Interrupted request" });
  const rejected = assert.rejects(running, /stopped|exited/);
  await requested.promise;
  await supervisor.stop("a");
  await rejected;
  const restarted = await start("a", chosen);
  assert.equal(restarted.interrupted, true);
  await assert.rejects(supervisor.request("a", "prompt", { text: "Retry" }), /reconciliation/);
});

test("stopping an agent also kills a CPU-bound codemode child", async t => {
  const { supervisor, start } = await fixture(t);
  await start("a");
  const started = Promise.withResolvers<void>();
  const running = supervisor.request("a", "execute", { code: 'text("started");\nwhile (true) {}' }, () => started.resolve());
  const rejected = assert.rejects(running, /stopped|exited/);
  await started.promise;
  const agentPid = supervisor.agents.get("a")!.child.pid;
  const children = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")
    .map(line => line.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === agentPid);
  assert.equal(children.length, 1);
  const pid = children[0][0];
  await supervisor.stop("a");
  await rejected;
  // Allow the OS to reap the orphan after the entire process group is killed.
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("Codemode child survived agent shutdown");
});

test("HTTP control plane authenticates, streams codemode output, and stops agents", async t => {
  const root = await mkdtemp(join(tmpdir(), "camelai-http-test-"));
  const token = "runtime-test-token-with-enough-characters";
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_RUNTIME_TOKEN: token, PORT: "0", ...(process.env.AGENT_RUNTIME ? { AGENT_RUNTIME: process.env.AGENT_RUNTIME } : {}) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => {
    const closed = once(child, "close");
    child.kill("SIGTERM");
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const ready = Promise.withResolvers<number>();
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk;
    if (output.includes("\n")) ready.resolve(JSON.parse(output.split("\n")[0]).address.port);
  });
  child.on("error", ready.reject);
  child.on("exit", code => ready.reject(new Error(`HTTP server exited: ${code}`)));
  const base = `http://127.0.0.1:${await ready.promise}/agents/demo`;
  assert.equal((await fetch(base)).status, 401);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const clientBase = base.replace("/agents/demo", "/client-sessions");
  assert.equal((await fetch(clientBase, { method: "POST", body: JSON.stringify({ tools: [] }) })).status, 401);
  assert.equal((await fetch(clientBase, { method: "POST", headers, body: JSON.stringify({ tools: [{}] }) })).status, 400);
  for (const systemPrompt of [null, 123, "", "x".repeat(32001)]) {
    assert.equal((await fetch(clientBase, { method: "POST", headers, body: JSON.stringify({ tools: [], systemPrompt }) })).status, 400);
  }
  const clientSessionResponse = await fetch(clientBase, { method: "POST", headers, body: JSON.stringify({ tools: [], name: "Test agent", type: "reviewer", systemPrompt: "You are a test assistant." }) });
  assert.equal(clientSessionResponse.status, 201);
  const clientSession = await clientSessionResponse.json() as { id: string; token: string };
  assert.equal(JSON.parse(await readFile(join(root, "client-sessions", `${clientSession.id}.json`), "utf8")).config.systemPrompt, "You are a test assistant.");
  const registryUrl = base.replace("/agents/demo", "/registry");
  assert.equal((await fetch(registryUrl)).status, 401);
  assert.equal((await fetch(registryUrl, { headers: { Authorization: `Bearer ${clientSession.token}` } })).status, 401);
  const listing = await (await fetch(registryUrl, { headers })).json() as any[];
  assert.equal(listing[0].name, "Test agent"); assert.equal(listing[0].type, "reviewer");
  const detail = await (await fetch(`${registryUrl}/${clientSession.id}`, { headers })).json() as any;
  assert.equal(detail.token, undefined); assert.equal(detail.digest, undefined); assert.equal(detail.config, undefined);
  for (const name of [null, "", 42, "x".repeat(121)]) assert.equal((await fetch(clientBase, { method: "POST", headers, body: JSON.stringify({ tools: [], name }) })).status, 400);
  assert.equal((await fetch(base, { headers: { Authorization: `Bearer ${clientSession.token}` } })).status, 401);
  assert.equal((await fetch(base.replace("/agents/demo", `/agents/${clientSession.id}`), { method: "DELETE", headers })).status, 200);
  const created = await fetch(base, { method: "POST", headers });
  assert.equal(created.status, 200);
  assert.ok((await created.json() as any).pid > 0);
  const response = await fetch(`${base}/execute`, { method: "POST", headers, body: JSON.stringify({ code: 'return "http works";' }) });
  const records = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records[0].type, "event");
  assert.deepEqual(records.at(-1).result.output, ["http works"]);
  const bypass = await fetch(`${base}/execute`, { method: "POST", headers, body: JSON.stringify({ code: "return 1", runtime: "/bin/sh" }) });
  assert.match(await bypass.text(), /Unknown codemode option: runtime/);
  assert.equal((await fetch(base, { method: "DELETE", headers })).status, 200);
});

test("native tools preserve content and imported history is owned by the service after restart", async t => {
  const requests: any[] = [];
  const chosen = await fakeProvider(t, body => {
    requests.push(body);
    if (requests.length === 1) return { role: "assistant", tool_calls: [{ index: 0, id: "native_1", type: "function", function: { name: "inspect", arguments: "{}" } }] };
    return { role: "assistant", content: "Native result received." };
  });
  const { supervisor } = await fixture(t);
  let calls = 0;
  const bridge = {
    definitions: [{ name: "inspect", description: "Read native content", parameters: { type: "object" }, exposure: "direct" as const, resultFormat: "content" as const }],
    async call() { calls++; return { content: [{ type: "text", text: "native-content-marker" }], details: { ok: true } }; },
  };
  const initialMessages = [{ role: "user" as const, content: "import-marker", timestamp: 1 }];
  await supervisor.start("native", { model: chosen, apiKey: "fixture", initialMessages }, bridge);
  await supervisor.request("native", "prompt", { message: { role: "user", content: "Call inspect", timestamp: 2 } });
  assert.equal(calls, 1);
  assert.ok(requests[0].tools.some((tool: any) => tool.function.name === "inspect"));
  assert.ok(requests[1].messages.some((message: any) => message.role === "tool" && message.content === "native-content-marker"));
  const before = await supervisor.request("native", "history");
  assert.equal(before.messages[0].content, "import-marker");
  await supervisor.stop("native");
  await supervisor.start("native", { model: chosen, apiKey: "fixture", initialMessages: [{ role: "user", content: "must-not-overwrite", timestamp: 3 }] }, bridge);
  assert.deepEqual((await supervisor.request("native", "history")).messages, before.messages);
  await supervisor.request("native", "configure", { systemPrompt: "Changed role.", tools: [] });
  await supervisor.request("native", "prompt", { text: "Next" });
  assert.equal(requests.at(-1).tools.length, 1);
  assert.ok(requests.at(-1).messages[0].content.includes("Changed role."));
});

test("explicit crash reconciliation closes missing tool outcomes without replaying their effects", async t => {
  const chosen = await fakeProvider(t, () => ({ role: "assistant", tool_calls: [{ index: 0, id: "uncertain_1", type: "function", function: { name: "effect", arguments: "{}" } }] }));
  const { supervisor } = await fixture(t);
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const bridge = {
    definitions: [{ name: "effect", description: "Side effect", parameters: {}, exposure: "direct" as const }],
    async call() { calls++; started.resolve(); return new Promise(() => {}); },
  };
  await supervisor.start("crash", { model: chosen, apiKey: "fixture" }, bridge);
  const rejected = assert.rejects(supervisor.request("crash", "prompt", { text: "Perform effect" }), /stopped|exited/);
  await started.promise;
  await supervisor.stop("crash");
  await rejected;
  await supervisor.start("crash", { model: chosen, apiKey: "fixture" }, bridge);
  await assert.rejects(supervisor.request("crash", "reconcile", {}), /Acknowledge/);
  await supervisor.request("crash", "reconcile", { acknowledged: true });
  const history = await supervisor.request("crash", "history");
  assert.equal(history.interrupted, false);
  assert.equal(calls, 1);
  const unknown = history.messages.find((message: any) => message.role === "toolResult");
  assert.equal(unknown.toolCallId, "uncertain_1");
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /unknown/);
  await supervisor.stop("crash");
  assert.equal((await supervisor.start("crash", { model: chosen }, bridge)).interrupted, false);
});
