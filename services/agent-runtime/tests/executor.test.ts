import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { executeCode } from "../src/codemode.ts";
import { Executions, remoteExecutor, type ToolDispatch } from "../src/executions.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { localTools } from "../src/local-tools.ts";
import { configuredModel } from "../src/model.ts";
import { SANDBOX_LIMITS } from "../src/limits.ts";
import type { ToolBridge } from "../src/protocol.ts";

type T = { after: (fn: () => unknown) => void };
const TOKEN = "executor-test-token-0123456789abcdef";
const CANARY = "executor-test-canary-must-not-leak";

async function listen(t: T, server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A real executor process, started the way a host runs it, with a canary secret in its environment. */
async function startExecutor(t: T) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/executor/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, AGENT_EXECUTOR_TOKEN: TOKEN, PORT: "0", HOST: "127.0.0.1", EXECUTOR_TEST_CANARY: CANARY, ...process.env.AGENT_RUNTIME ? { AGENT_RUNTIME: process.env.AGENT_RUNTIME } : {} },
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => { child.kill("SIGKILL"); });
  const [line] = await once(createInterface({ input: child.stdout! }), "line");
  const { address } = JSON.parse(line);
  return { url: `http://127.0.0.1:${address.port}`, urls: [`http://127.0.0.1:${address.port}`], token: TOKEN, pid: child.pid! };
}

/** The runtime side: the callback listener and its execution registry. */
async function startCallbacks(t: T) {
  let executions!: Executions;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.url ?? "");
    if (!await executions.handle(req, res)) res.writeHead(404).end();
  });
  executions = new Executions(await listen(t, server));
  return { executions, requests };
}

async function remoteFixture(t: T, bridge: ToolBridge) {
  const executor = await startExecutor(t);
  const { executions, requests } = await startCallbacks(t);
  const directory = await mkdtemp(join(tmpdir(), "camelai-executor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    executor, executions, requests,
    run: (code: string, options: { timeoutMs?: number; maxOutputCharacters?: number; signal?: AbortSignal; onEvent?: (event: any) => void; endpoint?: { urls: string[]; token: string } } = {}) =>
      executeCode({ code, directory, bridge, executor: remoteExecutor(executions, options.endpoint ?? executor), ...options }),
  };
}

function children(pid: number): number[] {
  try { return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch { return []; }
}

async function until(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await sleep(25);
  }
}

function processEnvironment(pid: number): string {
  if (process.platform === "linux") return readFileSync(`/proc/${pid}/environ`, "utf8").replaceAll("\0", "\n");
  return execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
}

/** A tool that blocks until the execution's signal aborts, so a test can inspect the live executor. */
function hangingBridge() {
  const entered = Promise.withResolvers<void>();
  const bridge: ToolBridge = {
    definitions: [{ name: "hang", description: "Blocks until aborted", parameters: { type: "object" } }],
    call: (_name, _args, signal) => new Promise((_, reject) => {
      entered.resolve();
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  };
  return { bridge, entered: entered.promise };
}

test("code runs on the executor and its tool calls return through the runtime callback", async t => {
  const calls: unknown[] = [];
  const { run, requests, executions } = await remoteFixture(t, {
    definitions: [{ name: "add", description: "Adds", parameters: { type: "object", required: ["a", "b"], properties: { a: { type: "number" }, b: { type: "number" } } } }],
    async call(name, args) { calls.push([name, args]); return { sum: (args.a as number) + (args.b as number) }; },
  });
  const result = await run(`
    const [x, y] = await Promise.all([tools.add({a: 1, b: 2}), tools.add({a: 3, b: 4})]);
    text(x.sum + y.sum);
    return typeof process;
  `);
  assert.deepEqual(result, { output: ["10", "undefined"], truncated: false });
  assert.equal(calls.length, 2);
  assert.equal(requests.filter(url => /^\/internal\/executions\/[0-9a-f-]{36}\/tools$/.test(url)).length, 2);
  assert.equal(executions.size, 0, "The capability is released when the execution ends");
  await assert.rejects(run('return await tools.add({a: "1", b: 2});'), /Invalid arguments for tool: add/);
  await assert.rejects(run('throw new Error("guest failure")'), /guest failure/);
});

test("output streams from the executor while the program is still running", async t => {
  const seen: string[] = [];
  const first = Promise.withResolvers<void>();
  const { run } = await remoteFixture(t, {
    definitions: [{ name: "gate", description: "Waits for streamed output", parameters: { type: "object" } }],
    async call() { await first.promise; return seen.slice(); },
  });
  const result = await run('console.log("before"); const observed = await tools.gate({}); text("after"); return observed;', {
    onEvent: event => { seen.push(event.text); if (event.text.includes("before")) first.resolve(); },
  });
  assert.deepEqual(result.output, ["before", "after", '["before"]']);
  assert.deepEqual(seen, result.output, "Every part streamed before the result");
});

test("timeouts and aborts on the runtime side kill the executor's child", async t => {
  const hung = hangingBridge();
  const { run, executor, executions } = await remoteFixture(t, hung.bridge);
  const timedOut = assert.rejects(run("await tools.hang({});", { timeoutMs: 1_500 }), /timed out after 1500ms/);
  await hung.entered;
  assert.equal(children(executor.pid).length, 1, "One code child runs on the executor");
  await timedOut;
  await until(() => children(executor.pid).length === 0);
  assert.equal(executions.size, 0);

  const again = hangingBridge();
  const aborting = await remoteFixture(t, again.bridge);
  const controller = new AbortController();
  const aborted = assert.rejects(aborting.run("await tools.hang({});", { signal: controller.signal }), /aborted/);
  await again.entered;
  assert.equal(children(aborting.executor.pid).length, 1);
  controller.abort();
  await aborted;
  await until(() => children(aborting.executor.pid).length === 0);
  // CPU-bound guests die inside the sandbox too, remotely as locally.
  await assert.rejects(aborting.run("while (true) {}", { timeoutMs: 5_000 }), /CPU or wall-clock limit/);
});

test("callback capabilities reach one execution, only until its deadline", async t => {
  const { executions } = await startCallbacks(t);
  const received: Record<string, unknown[]> = { a: [], b: [] };
  const dispatch = (key: string): ToolDispatch => async call => { received[key].push(call); return "ok"; };
  const a = executions.register(10_000, dispatch("a"));
  const b = executions.register(10_000, dispatch("b"));
  const post = (url: string, token?: string) => fetch(url, {
    method: "POST", body: JSON.stringify({ name: "echo", args: {} }),
    headers: { "Content-Type": "application/json", ...token ? { Authorization: `Bearer ${token}` } : {} },
  });
  assert.equal((await post(a.callbackUrl)).status, 401);
  assert.equal((await post(a.callbackUrl, "x".repeat(43))).status, 401);
  assert.equal((await post(a.callbackUrl, b.token)).status, 401, "Another execution's token");
  assert.equal((await post(a.callbackUrl.replace(a.id, crypto.randomUUID()), a.token)).status, 404);
  assert.equal((await fetch(a.callbackUrl, { headers: { Authorization: `Bearer ${a.token}` } })).status, 405);
  assert.deepEqual(received, { a: [], b: [] });
  const ok = await post(a.callbackUrl, a.token);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { result: "ok" });
  assert.deepEqual(received, { a: [{ name: "echo", args: {} }], b: [] });
  a.release();
  assert.equal((await post(a.callbackUrl, a.token)).status, 404, "Released");
  const short = executions.register(50, dispatch("b"));
  await sleep(100);
  assert.equal((await post(short.callbackUrl, short.token)).status, 404, "Expired at its deadline");
  assert.equal(received.b.length, 0);
  const tooLarge = await fetch(b.callbackUrl, { method: "POST", headers: { Authorization: `Bearer ${b.token}` }, body: "x".repeat(SANDBOX_LIMITS.argumentBytes + 8192) });
  assert.equal(tooLarge.status, 400);
  // Owned registrations: one owner cannot release another's.
  const owned = executions.register(10_000, dispatch("b"), "agent-a");
  executions.release(owned.id, "agent-b");
  assert.equal((await post(owned.callbackUrl, owned.token)).status, 200);
  executions.releaseOwner("agent-a");
  assert.equal((await post(owned.callbackUrl, owned.token)).status, 404);
});

test("the executor requires its own bearer token", async t => {
  const { run, executor } = await remoteFixture(t, { definitions: [], call: async () => null });
  await assert.rejects(run("return 1", { endpoint: { urls: executor.urls, token: "wrong-token-0123456789abcdef-0123456789" } }), /Executor rejected the execution \(401\)/);
  assert.equal((await fetch(`${executor.url}/execute`, { method: "POST" })).status, 401);
  assert.deepEqual((await run("return 1")).output, ["1"]);
});

test("tool call count, concurrency and result transfer quotas hold in remote mode", async t => {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  const bridge: ToolBridge = {
    definitions: [{ name: "echo", description: "Test capability", parameters: { type: "object" } }],
    async call(_name, args) {
      calls++;
      peak = Math.max(peak, ++inflight);
      try {
        if (args.delay) await sleep(50);
        if (args.big) return "x".repeat(SANDBOX_LIMITS.resultBytes + 1);
        return args;
      } finally { inflight--; }
    },
  };
  const { run } = await remoteFixture(t, bridge);
  await assert.rejects(run("for(let i=0;i<257;i++) await tools.echo({i});"), /tool call limit/);
  assert.equal(calls, SANDBOX_LIMITS.toolCalls);
  const result = await run("return (await Promise.allSettled(Array.from({length:40}, () => tools.echo({delay:true})))).map(r => r.status);");
  const statuses = JSON.parse(result.output[0]);
  assert.equal(statuses.filter((s: string) => s === "fulfilled").length, SANDBOX_LIMITS.concurrentTools);
  assert.equal(peak, SANDBOX_LIMITS.concurrentTools);
  await assert.rejects(run("return await tools.echo({big:true});"), /Tool result exceeds JSON size limit/);
  assert.deepEqual(await run('return "x".repeat(1000000);', { maxOutputCharacters: 5 }), { output: ["xxxxx"], truncated: true });
});

test("a compromised executor still cannot exceed the runtime's validation, quotas or output limits", async t => {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  const bridge: ToolBridge = {
    definitions: [{ name: "echo", description: "Test capability", parameters: { type: "object", properties: { n: { type: "number" } } } }],
    async call(_name, args) {
      calls++;
      peak = Math.max(peak, ++inflight);
      try { await sleep(20); return args; } finally { inflight--; }
    },
  };
  // Stands in for an executor whose sandbox was escaped: it calls back directly, as fast and as
  // often as it likes, with whatever it wants, then reports what the runtime answered.
  let leaked: { url: string; token: string } | undefined;
  const hostile = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const { code, callback } = JSON.parse(text);
    leaked = callback;
    const call = (name: unknown, args: unknown) => fetch(callback.url, {
      method: "POST", headers: { Authorization: `Bearer ${callback.token}` }, body: JSON.stringify({ name, args }),
    }).then(async response => response.status === 200 ? "ok" : (await response.json()).error);
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const answers: unknown[] = [];
    if (code === "flood") for (let i = 0; i < 300; i++) answers.push(await call("echo", { n: i }));
    if (code === "concurrent") answers.push(...await Promise.all(Array.from({ length: 40 }, () => call("echo", {}))));
    if (code === "invalid") answers.push(await call("js_exec", { code: "1" }), await call("echo", { n: "x" }), await call("echo", []), await call("secret", {}));
    if (code === "output") {
      for (let i = 0; i < 10; i++) res.write(`${JSON.stringify({ type: "event", event: { type: "output", text: "x".repeat(100) } })}\n`);
      await sleep(1_000);
    }
    res.end(`${JSON.stringify({ type: "result", result: { output: [JSON.stringify(answers)], truncated: false } })}\n`);
  });
  const url = await listen(t, hostile);
  const { executions } = await startCallbacks(t);
  const directory = await mkdtemp(join(tmpdir(), "camelai-executor-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (code: string, maxOutputCharacters?: number) => executeCode({ code, directory, bridge, maxOutputCharacters, executor: remoteExecutor(executions, { urls: [url], token: TOKEN }) });

  const flood = JSON.parse((await run("flood")).output[0]);
  assert.equal(flood.filter((answer: string) => answer === "ok").length, SANDBOX_LIMITS.toolCalls);
  assert.match(flood.at(-1), /tool call limit/);
  assert.equal(calls, SANDBOX_LIMITS.toolCalls);

  const concurrent = JSON.parse((await run("concurrent")).output[0]);
  assert.equal(concurrent.filter((answer: string) => answer === "ok").length, SANDBOX_LIMITS.concurrentTools);
  assert.ok(concurrent.some((answer: string) => /Too many concurrent/.test(answer)));
  assert.equal(peak, SANDBOX_LIMITS.concurrentTools);

  const before = calls;
  const invalid = JSON.parse((await run("invalid")).output[0]);
  assert.deepEqual(invalid.map((answer: string) => answer.replace(/:.*/, "")), ["Unknown tool", "Invalid arguments for tool", "Tool arguments must be a JSON object", "Unknown tool"]);
  assert.equal(calls, before, "Nothing invalid reached the bridge");

  await assert.rejects(run("output", 500), /output beyond the codemode limits/);
  // Its capability died with the execution.
  const replay = await fetch(leaked!.url, { method: "POST", headers: { Authorization: `Bearer ${leaked!.token}` }, body: '{"name":"echo","args":{}}' });
  assert.equal(replay.status, 404);
  assert.equal(executions.size, 0);
});

test("the executor's code child inherits none of the executor's environment", async t => {
  const hung = hangingBridge();
  const { run, executor } = await remoteFixture(t, hung.bridge);
  const controller = new AbortController();
  const running = assert.rejects(run("await tools.hang({});", { signal: controller.signal }), /aborted/);
  await hung.entered;
  const [child] = children(executor.pid);
  assert.ok(child, "A code child is running");
  const environment = processEnvironment(child);
  assert.ok(process.platform === "linux" || environment.includes("code-child.ts"), "Inspected the code child");
  assert.match(environment, /TMPDIR=\S*codemode-/, "The environment is visible, and it is the fixed one childProcess sets");
  assert.ok(!environment.includes(CANARY), "No inherited canary");
  assert.ok(!environment.includes(TOKEN), "No executor token");
  assert.ok(!environment.includes("AGENT_EXECUTOR_TOKEN"));
  controller.abort();
  await running;
});

test("supervised agents run js_exec remotely and callbacks reach only the owning agent's tools", async t => {
  const executor = await startExecutor(t);
  const { executions, requests } = await startCallbacks(t);
  const root = await mkdtemp(join(tmpdir(), "camelai-executor-runtime-test-"));
  const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents: 2, executor: { endpoint: executor, executions } });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const start = async (id: string) => supervisor.start(id, { model: configuredModel(), apiKey: "fixture-only" }, await localTools(join(root, "workspaces", id)));
  await Promise.all([start("a"), start("b")]);
  const outputs = await Promise.all(["a", "b"].map(id => supervisor.request(id, "execute", { code: `
    await tools.write({path: "result.txt", content: "${id}"});
    text((await tools.read({path: "result.txt"})).data.text);
    return typeof process;
  ` })));
  assert.deepEqual(outputs.map(result => result.output), [["a", "undefined"], ["b", "undefined"]]);
  assert.equal(await readFile(join(root, "workspaces", "a", "result.txt"), "utf8"), "a");
  assert.equal(requests.length, 4, "Every tool call went through the callback route");
  assert.equal(executions.size, 0);
  await assert.rejects(supervisor.request("a", "execute", { code: "while (true) {}", timeoutMs: 1000 }), /timed out|CPU or wall-clock/);
  await until(() => children(executor.pid).length === 0);
  assert.deepEqual((await supervisor.request("a", "execute", { code: "1 + 2;" })).output, ["3"]);
});
