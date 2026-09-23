import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, memoryJournalStore, schema, tool } from "../clients/typescript.ts";

const token = "cluster-operator-token-at-least-24-chars";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Runtime nodes sharing storage (shared files here, S3 in production) with short leases. */
async function cluster(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agent-cluster-"));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { "*": "fixture-key" } } } }));
  const children: ChildProcess[] = [];
  const start = async (name: string) => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
      env: {
        PATH: process.env.PATH, HOME: root, PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: url,
        AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
        AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "cluster-session-secret-with-32-characters!",
      } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    const ready = Promise.withResolvers<void>();
    child.stdout!.on("data", chunk => { if (String(chunk).includes("listening")) ready.resolve(); });
    child.on("exit", code => ready.reject(new Error(`node ${name} exited: ${code}`)));
    await ready.promise;
    return { name, url, child };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
    await rm(root, { recursive: true, force: true });
  });
  return { start };
}

const lookup = (calls: string[]) => ({
  lookup: tool({
    description: "Look up a value", input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
    execute: ({ key }) => { calls.push(key); return `value-of-${key}`; },
  }),
});

test("any node serves any agent: requests are forwarded to the owner, and a survivor takes over when it dies", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const calls: string[] = [];

  // Created through A, so A owns it.
  const viaA = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools: lookup(calls), idempotencyKey: "shared-agent" });
  assert.equal((await viaA.execute('return await tools.lookup({ key: "one" })')).output[0], "value-of-one");
  await viaA.close();

  // A client attached to B reaches the same agent: its requests and SSE stream are forwarded to A.
  const viaB = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(viaA.session, { tools: lookup(calls) });
  t.after(() => viaB.close());
  assert.equal((await viaB.execute('return await tools.lookup({ key: "two" })')).output[0], "value-of-two");
  const state = async () => (await (await fetch(`${b.url}/clients/${viaA.session.id}/state`, { headers: { Authorization: `Bearer ${viaA.session.token}` } })).json()) as any;
  assert.equal((await state()).requests.length, 2, "both requests are in the one journal A keeps");
  assert.deepEqual(calls, ["one", "two"]);

  // A wake-up scheduled through B is delivered to the agent on A, by whichever node claims it.
  const schedule = await viaB.schedule({ code: 'return await tools.lookup({ key: "timer" })', inSeconds: 0 });
  const wakeId = `schedule-${schedule.id}-${schedule.dueAt}`;
  for (let tries = 0; !(await state()).requests.some((request: any) => request.id === wakeId); tries++) {
    assert.ok(tries < 100, "the wake-up was delivered");
    await sleep(100);
  }
  const woken = await viaB.waitForRequest(wakeId, { timeoutMs: 20_000 });
  assert.equal(woken.output[0], "value-of-timer");
  assert.deepEqual(await viaB.schedules(), []);
  calls.splice(calls.indexOf("timer"), 1);

  // Re-provisioning through B returns the same agent without starting a second copy.
  const again = await fetch(`${b.url}/client-sessions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "shared-agent" },
    body: JSON.stringify({ tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } }] }),
  });
  assert.equal(again.status, 201, await again.clone().text());
  assert.equal((await again.json() as any).id, viaA.session.id);

  // A dies without releasing anything. Once its lease expires, B serves the agent from storage.
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 2000 + 500);
  const result = await viaB.execute('return await tools.lookup({ key: "three" })', { timeoutMs: 20_000 });
  assert.equal(result.output[0], "value-of-three");
  assert.ok((await state()).requests.length >= 4, "the journal A wrote is intact under B");
  assert.deepEqual(calls, ["one", "two", "three"]);
  const agents = await (await fetch(`${b.url}/v1/agents`, { headers: { Authorization: `Bearer ${token}` } })).json() as any[];
  assert.deepEqual(agents.map(agent => agent.id), [viaA.session.id]);
});
