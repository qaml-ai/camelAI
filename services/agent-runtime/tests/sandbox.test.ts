import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readFile, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCode } from "../src/codemode.ts";
import { localTools } from "../src/local-tools.ts";
import { SANDBOX_LIMITS, codeRequest } from "../src/limits.ts";
import type { ToolBridge } from "../src/protocol.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, bridge?: ToolBridge) {
  const directory = await mkdtemp(join(tmpdir(), "camelai-sandbox-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = bridge ?? await localTools(join(directory, "workspace"));
  return {
    directory,
    run: (code: string, options: { timeoutMs?: number; maxOutputCharacters?: number } = {}) => executeCode({
      code, directory, bridge: tools, runtime: process.env.AGENT_RUNTIME, ...options,
    }),
  };
}

test("guest globals, function constructors, eval and callback prototypes cannot reach the host", async t => {
  const { run } = await fixture(t);
  const result = await run(`
    const denied = ["process", "Bun", "require", "module", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "WebAssembly", "SharedArrayBuffer", "Atomics", "setTimeout", "setInterval", "__call", "__emit"];
    const globals = denied.map(name => typeof globalThis[name]);
    const constructorProbes = [
      Function("return typeof process")(),
      ({}).constructor.constructor("return typeof process")(),
      console.log.constructor("return typeof process")(),
      text.constructor("return typeof process")(),
      await tools.read.constructor("return typeof process")(),
      eval("typeof process"),
      (await tools.ls({})).constructor.constructor("return typeof process")(),
    ];
    return {globals, constructorProbes};
  `);
  const resultObject = JSON.parse(result.output[0]);
  assert.ok(resultObject.globals.every((value: string) => value === "undefined"), JSON.stringify(resultObject));
  assert.ok(resultObject.constructorProbes.every((value: string) => value === "undefined"));
  await assert.rejects(run('tools.read = () => "hijacked";'), /read.only|not writable|read-only/i);
  await run('Object.prototype.guestMutation = "only here";');
  assert.deepEqual((await run('return typeof ({}).guestMutation;')).output, ["undefined"]);
  assert.equal((Object.prototype as any).guestMutation, undefined);
});

test("all module import schemes and direct network access are denied", async t => {
  const { run } = await fixture(t);
  const result = await run(`
    return await Promise.all(["node:fs", "node:child_process", "bun", "file:///etc/passwd", "https://example.com/module.js", "data:text/javascript,export default 1"]
      .map(async name => { try { await import(name); return "escaped"; } catch { return "denied"; } }));
  `);
  assert.deepEqual(JSON.parse(result.output[0]), Array(6).fill("denied"));
  await assert.rejects(run('return await fetch("http://127.0.0.1:8790");'), /fetch.*not defined/);
});

test("host policy validates schemas and rejects execution policy overrides", async t => {
  const { run } = await fixture(t);
  await assert.rejects(run('return await tools.read({path: 12});'), /Invalid arguments/);
  await assert.rejects(run('return await tools.write({path: "x", content: "ok", extra: "no"});'), /Invalid arguments/);
  await assert.rejects(run('return await tools.notRegistered({});'), /not a function/);
  await assert.rejects(run('return await tools.read({path: "x".repeat(150000)});'), /size limit/);
  for (const [key, value] of Object.entries({ runtime: "/bin/sh", directory: "/", bridge: {}, tools: [], cpuMs: 100000, wasmBytes: 1e9 })) {
    assert.throws(() => codeRequest({ code: "return 1", [key]: value }), /Unknown codemode option/);
  }
});

test("bulk arrays and strings cannot grow beyond the fixed WASM memory", async t => {
  const { run } = await fixture(t);
  for (const allocation of ['new Uint8Array(1024 * 1024)', '"x".repeat(1024 * 1024)']) {
    const result = await run(`
      const allocations = [];
      try { for (let i = 0; i < 128; i++) allocations.push(${allocation}); }
      catch (error) { return {count: allocations.length, stopped: true}; }
      return {count: allocations.length, stopped: false};
    `);
    const value = JSON.parse(result.output[0]);
    assert.equal(value.stopped, true);
    assert.ok(value.count < SANDBOX_LIMITS.wasmBytes / (1024 * 1024), JSON.stringify(value));
  }
  assert.deepEqual((await run("return 42;")).output, ["42"]);
});

test("CPU, stack, hostile serialization and abandoned promises are bounded", { timeout: 20_000 }, async t => {
  const { run } = await fixture(t);
  await assert.rejects(run("while (true) {}", { timeoutMs: 10_000 }), /CPU.*limit/);
  await assert.rejects(run("while (true) await Promise.resolve();", { timeoutMs: 5000 }), /CPU.*limit|timed out/);
  await assert.rejects(run("function recurse() { return recurse() + 1; } return recurse();"), /stack|recursion/i);
  await assert.rejects(run("return { toJSON() { while (true) {} } };", { timeoutMs: 500 }), /timed out/);
  await assert.rejects(run('throw { get message() { while (true) {} } };', { timeoutMs: 500 }), /timed out/);
  await assert.rejects(run("return await new Promise(() => {});", { timeoutMs: 500 }), /timed out/);
  assert.deepEqual((await run("return 42;")).output, ["42"]);
});

test("output floods are bounded by both characters and event count", async t => {
  const { run } = await fixture(t);
  assert.deepEqual(await run('return "x".repeat(1000000);', { maxOutputCharacters: 5 }), { output: ["xxxxx"], truncated: true });
  const result = await run('for(let i=0;i<10000;i++) text("x");', { maxOutputCharacters: 128000 });
  assert.equal(result.output.length, SANDBOX_LIMITS.outputEvents);
  assert.equal(result.truncated, true);
});

test("tool call count, concurrency and result transfer quotas hold outside the guest", async t => {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  const { run } = await fixture(t, {
    definitions: [{ name: "echo", description: "Test capability", parameters: { type: "object" } }],
    async call(_name, args) {
      calls++;
      peak = Math.max(peak, ++inflight);
      try {
        if (args.delay) await new Promise(resolve => setTimeout(resolve, 50));
        if (args.big) return "x".repeat(SANDBOX_LIMITS.resultBytes + 1);
        return args;
      } finally { inflight--; }
    },
  });
  await assert.rejects(run('for(let i=0;i<257;i++) await tools.echo({i});'), /tool call limit/);
  assert.equal(calls, SANDBOX_LIMITS.toolCalls);
  const result = await run('return (await Promise.allSettled(Array.from({length:40}, () => tools.echo({delay:true})))).map(r => r.status);');
  const statuses = JSON.parse(result.output[0]);
  assert.equal(statuses.filter((s: string) => s === "fulfilled").length, SANDBOX_LIMITS.concurrentTools);
  assert.equal(peak, SANDBOX_LIMITS.concurrentTools);
  await assert.rejects(run('return await tools.echo({big:true});'), /Tool result exceeds JSON size limit/);
  const before = calls;
  await assert.rejects(run('tools.echo({}); return 1;'), /Unawaited tool calls/);
  assert.equal(calls, before, "An unawaited call must not dispatch after sandbox disposal");
});

test("workspace capabilities reject traversal, live/dangling symlinks and hard links", async t => {
  const { directory, run } = await fixture(t);
  const outside = join(directory, "secret.txt");
  await writeFile(outside, "unchanged");
  await symlink(outside, join(directory, "workspace", "link"));
  await symlink(join(directory, "created-outside.txt"), join(directory, "workspace", "dangling"));
  await link(outside, join(directory, "workspace", "hardlink"));
  for (const path of ["../secret.txt", "link", "dangling", "hardlink"]) {
    await assert.rejects(run(`return await tools.write({path:${JSON.stringify(path)}, content:"escaped"});`), /escapes|linked/);
  }
  assert.equal(await readFile(outside, "utf8"), "unchanged");
  await assert.rejects(readFile(join(directory, "created-outside.txt")), /ENOENT/);
});
