import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, memoryJournalStore, type JournalStore, type SessionCredentials } from "../clients/typescript.ts";

const session: SessionCredentials = { id: `client_${"a".repeat(40)}`, token: "scoped-test-token", expiresAt: Date.now() + 60_000 };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("portable SDK awaits event consumers before persisting replay cursor and attaches with saved credentials", async () => {
  const backing = memoryJournalStore();
  await backing.save(session.id, { version: 1, cursor: 4, calls: {} });
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const committed = Promise.withResolvers<void>();
  const store: JournalStore = {
    load: id => backing.load(id),
    async save(id, journal) { await backing.save(id, journal); if (journal.cursor === 5) committed.resolve(); },
  };
  let eventStream: ReadableStreamDefaultController<Uint8Array>;
  const encode = new TextEncoder();
  const requestIds: (string | undefined)[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/events")) {
      assert.equal(new Headers(init?.headers).get("Last-Event-ID"), "4");
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        eventStream = controller;
        controller.enqueue(encode.encode('event: ready\ndata: {}\n\n'));
        init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    assert.ok(url.endsWith("/state"));
    return Response.json({ cursor: 4, calls: [], requests: [], needsReconciliation: false });
  };
  const client = await new AgentRuntime({ fetch: fetcher, journalStore: store }).connectAgent(session, {
    tools: {}, async onEvent(_event, requestId) { requestIds.push(requestId); started.resolve(); await gate.promise; },
  });
  try {
    eventStream!.enqueue(encode.encode('id: 5\ndata: {"type":"event","requestId":"turn-123","event":{"type":"message_end"}}\n\n'));
    await started.promise;
    await tick();
    assert.equal((await backing.load(session.id))?.cursor, 4);
    gate.resolve(); await committed.promise;
    assert.equal((await backing.load(session.id))?.cursor, 5);
    assert.deepEqual(requestIds, ["turn-123"]);
  } finally { gate.resolve(); await client.close(); }
});

test("portable SDK waits for journal loading and propagates storage failures before opening a connection", async () => {
  let fetched = false;
  const runtime = new AgentRuntime({ fetch: async () => { fetched = true; throw new Error("unexpected fetch"); },
    journalStore: { async load() { throw new Error("storage unavailable"); }, async save() {} },
  });
  await assert.rejects(runtime.connectAgent(session, { tools: {} }), /storage unavailable/);
  assert.equal(fetched, false);
});

test("async journals commit before claiming side effects and before delivering tool outcomes", async () => {
  const backing = memoryJournalStore();
  const gate = Promise.withResolvers<void>();
  const saving = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let executions = 0;
  let claimed = false;
  let eventStream: ReadableStreamDefaultController<Uint8Array>;
  const store: JournalStore = {
    load: id => backing.load(id),
    async save(id, journal) {
      if (journal.calls["call-1"]?.state === "started") { saving.resolve(); await gate.promise; }
      await backing.save(id, journal);
    },
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      eventStream = controller;
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    if (url.endsWith("/state")) return Response.json({ cursor: 0, calls: [], requests: [], needsReconciliation: false });
    if (url.endsWith("/claim")) {
      assert.equal((await backing.load(session.id))?.calls["call-1"].state, "started");
      claimed = true; return Response.json({ execute: true });
    }
    assert.ok(url.endsWith("/outcome"));
    assert.equal((await backing.load(session.id))?.calls["call-1"].state, "done");
    delivered.resolve(); return Response.json({ ok: true });
  };
  const client = await new AgentRuntime({ fetch: fetcher, journalStore: store }).connectAgent(session, {
    tools: { echo: { description: "echo", input: { type: "object" }, execute() { executions++; return "ok"; } } },
  });
  try {
    const event = { type: "tool_call", call: { id: "call-1", name: "echo", args: {}, state: "offered", deadline: Date.now() + 5000 } };
    eventStream!.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(event)}\n\n`));
    await saving.promise; await tick();
    assert.equal(claimed, false); assert.equal(executions, 0);
    gate.resolve(); await delivered.promise;
    assert.equal(executions, 1);
  } finally { gate.resolve(); await client.close(); }
});

test("native fetch is bound to the global receiver required by Workers", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (this: unknown, input, init) {
    assert.equal(this, globalThis);
    calls++;
    if (String(input).endsWith("/events")) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ cursor: 0, calls: [], requests: [], needsReconciliation: false });
  };
  try {
    const client = await new AgentRuntime().connectAgent(session, { tools: {} });
    await client.close();
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("JSON transport uses manual redirects and rejects them without following credentials", async () => {
  let calls = 0;
  let cancelled = false;
  const runtime = new AgentRuntime({ apiKey: "operator-key", fetch: async (_input, init) => {
    calls++; assert.equal(init?.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { Location: "https://untrusted.example/steal" },
    });
  } });
  await assert.rejects(runtime.createAgent({ tools: {} }), /redirects are not allowed/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("SSE transport uses manual redirects and cancels redirect bodies without following", async () => {
  let calls = 0;
  let cancelled = false;
  const runtime = new AgentRuntime({ fetch: async (_input, init) => {
    calls++; assert.equal(init?.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 307, headers: { Location: "https://untrusted.example/steal" },
    });
  } });
  await assert.rejects(runtime.connectAgent(session, { tools: {} }), /redirects are not allowed/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});
