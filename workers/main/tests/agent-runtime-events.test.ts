/**
 * The runtime's run and input events for runtime threads (POST
 * /agent-runtime/events): signed envelopes, deduplicated by id, that mark the
 * thread running and idle and record its completion or failure.
 *
 * Run with: bun run test:workers
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { handleAgentRuntimeEventsRequest } from "../src/routes/agent-runtime-events";
import { runtimeAgentThreadKey } from "../src/agent-runtime/thread-runtime";
import type { Env } from "../src/types";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const KEY = new Uint8Array(32).map((_, index) => index + 7);
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY))}`;
const RUNTIME = "https://runtime.test";

async function sign(id: string, timestamp: number, body: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", KEY, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}

async function delivery(event: Record<string, unknown>, signature?: string) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request("https://camel.test/agent-runtime/events", {
    method: "POST",
    headers: {
      "webhook-id": String(event.id),
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature ?? await sign(String(event.id), timestamp, body),
      "content-type": "application/json",
    },
    body,
  });
}

const email = () => `rt-evt-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function setup(options: { source?: "channel" | "scheduled" } = {}) {
  const { userId } = await createUser(testEnv, email(), "password123", "Evt User");
  const { org, defaultWorkspaceId } = await createOrg(testEnv, "Evt Org", userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const thread = await orgStub.createThread(
    defaultWorkspaceId as string,
    "Runtime thread",
    userId,
    undefined,
    undefined,
    options.source === "channel"
      ? { source: "channel", channelKind: "slack", channelConnectionId: "int-1", channelConversationId: "T1:C1:1" }
      : options.source === "scheduled" ? { source: "scheduled" } : {},
  );
  const agentId = `client_${crypto.randomUUID().replaceAll("-", "")}`;
  await orgStub.setThreadRuntimeAgent(thread.id, { agentId, model: "m", keyScope: null });
  const streaming = vi.fn(async () => {});
  const runEnv = {
    ...(testEnv as unknown as Env),
    AGENT_RUNTIME_URL: RUNTIME,
    AGENT_RUNTIME_API_TOKEN: "operator",
    AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET: SECRET,
    WORKSPACE: { idFromName: (name: string) => name, get: () => ({ recordThreadStreaming: streaming }) },
  } as unknown as Env;
  const metadata = { source: "web", org: org.id, workspace: defaultWorkspaceId as string, thread: thread.id };
  return { orgStub, threadId: thread.id, workspaceId: defaultWorkspaceId as string, orgId: org.id, agentId, runEnv, streaming, metadata };
}

async function deliver(runEnv: Env, event: Record<string, unknown>, signature?: string) {
  const pending: Promise<unknown>[] = [];
  const response = await handleAgentRuntimeEventsRequest(await delivery(event, signature), runEnv, (promise) => { pending.push(promise); });
  await Promise.allSettled(pending);
  return response;
}

const eventId = () => `evt_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;

afterEach(() => vi.restoreAllMocks());

/** The runtime's input routes, as the webhook handler calls them with the tenant token. */
function fakeInputs(input: Record<string, unknown>) {
  const answers: Array<{ path: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(request instanceof Request ? request.url : String(request));
    if (url.origin !== RUNTIME) return original(request, init);
    if ((init?.method ?? "GET") === "GET") return Response.json(input);
    answers.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({ input: { ...input, state: "cancelled" } });
  });
  return answers;
}

describe("input.requested on POST /agent-runtime/events", () => {
  const inputEvent = (agentId: string) => ({
    id: eventId(), type: "input.requested", created: Math.floor(Date.now() / 1000),
    data: { agentId, requestId: "r1", inputId: "in_1", toolCallId: "tc_1", kind: "question", expiresAt: Date.now() + 60_000 },
  });

  it.each(["channel", "scheduled"] as const)(
    "cancels a %s thread's input: nobody is at a computer to answer it",
    async (source) => {
      const { runEnv, agentId, metadata } = await setup({ source });
      await testEnv.APP_KV.put(runtimeAgentThreadKey(agentId), JSON.stringify({ org: metadata.org, workspace: metadata.workspace, thread: metadata.thread }));
      const answers = fakeInputs({ id: "in_1", state: "pending", responders: { audience: ["owner-1"] } });
      expect((await deliver(runEnv, inputEvent(agentId))).status).toBe(204);
      expect(answers).toEqual([{
        path: `/v1/agents/${agentId}/inputs/in_1`,
        body: expect.objectContaining({ action: "cancel", actor: "owner-1" }),
      }]);
    },
  );

  it("leaves a web thread's input to the person watching it", async () => {
    const { runEnv, agentId, metadata } = await setup();
    await testEnv.APP_KV.put(runtimeAgentThreadKey(agentId), JSON.stringify({ org: metadata.org, workspace: metadata.workspace, thread: metadata.thread }));
    const answers = fakeInputs({ id: "in_1", state: "pending", responders: {} });
    expect((await deliver(runEnv, inputEvent(agentId))).status).toBe(204);
    expect(answers).toEqual([]);
  });

  it("does not answer an input that already settled", async () => {
    const { runEnv, agentId, metadata } = await setup({ source: "channel" });
    await testEnv.APP_KV.put(runtimeAgentThreadKey(agentId), JSON.stringify({ org: metadata.org, workspace: metadata.workspace, thread: metadata.thread }));
    const answers = fakeInputs({ id: "in_1", state: "answered", responders: {} });
    expect((await deliver(runEnv, inputEvent(agentId))).status).toBe(204);
    expect(answers).toEqual([]);
  });
});

describe("POST /agent-runtime/events", () => {
  it("refuses unsigned or wrongly signed deliveries, and answers 503 without a secret", async () => {
    const { runEnv, agentId, metadata } = await setup();
    const event = { id: eventId(), type: "run.started", created: 1, data: { agentId, requestId: "r", method: "prompt", metadata } };
    expect((await deliver(runEnv, event, "v1,AAAA")).status).toBe(401);
    expect((await deliver({ ...runEnv, AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET: "" } as Env, event)).status).toBe(503);
  });

  it("marks the thread running when a run starts, once per event id", async () => {
    const { runEnv, agentId, metadata, workspaceId, threadId, streaming } = await setup();
    const event = { id: eventId(), type: "run.started", created: Math.floor(Date.now() / 1000), data: { agentId, requestId: "r1", method: "prompt", metadata } };
    expect((await deliver(runEnv, event)).status).toBe(204);
    expect(streaming).toHaveBeenCalledWith(threadId, true, undefined);
    expect(workspaceId).toBeTruthy();
    expect((await deliver(runEnv, event)).status).toBe(204);
    expect(streaming).toHaveBeenCalledTimes(1);
  });

  it("finds the thread of a run no message of ours started, by its agent", async () => {
    const { runEnv, agentId, metadata, threadId, streaming } = await setup();
    await testEnv.APP_KV.put(runtimeAgentThreadKey(agentId), JSON.stringify({ org: metadata.org, workspace: metadata.workspace, thread: metadata.thread }));
    await deliver(runEnv, { id: eventId(), type: "run.started", created: 1, data: { agentId, requestId: "resume1", method: "resume" } });
    expect(streaming).toHaveBeenCalledWith(threadId, true, undefined);
  });

  it("records a completed run: idle, completion time, and the reply read for its summary", async () => {
    const { runEnv, agentId, metadata, threadId, orgStub, streaming } = await setup();
    const reads: string[] = [];
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== RUNTIME) return original(input, init);
      reads.push(`${url.pathname}${url.search}`);
      return Response.json({ entries: [{ index: 3, message: { role: "assistant", content: [{ type: "text", text: "Deployed the dashboard." }] } }], next: null });
    });
    const created = Math.floor(Date.now() / 1000);
    const response = await deliver(runEnv, {
      id: eventId(), type: "run.completed", created,
      data: { agentId, requestId: "r2", method: "prompt", metadata, replyIndex: 3, messageCount: 4, usage: null },
    });
    expect(response.status).toBe(204);
    expect(reads).toEqual([`/v1/agents/${agentId}/history?limit=1&before=4`]);
    expect(streaming).toHaveBeenCalledWith(threadId, false, expect.objectContaining({ clearOnlyIfRunning: true }));
    const thread = await orgStub.getThread(threadId);
    expect(thread?.last_assistant_completed_at).toBeGreaterThanOrEqual(created * 1000);
  });

  it("finishes a scheduled prompt's run when its turn ends, and only that run", async () => {
    const { runEnv, agentId, metadata } = await setup({ source: "scheduled" });
    const finishScheduledRun = vi.fn(async () => true);
    const cronEnv = {
      ...runEnv,
      WORKSPACE_CRON: { idFromName: (name: string) => name, get: () => ({ finishScheduledRun }) },
    } as unknown as Env;
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== RUNTIME) return original(input, init);
      return Response.json({ entries: [], next: null });
    });
    await deliver(cronEnv, {
      id: eventId(), type: "run.failed", created: 1_790_000_000,
      data: { agentId, requestId: "run-7", method: "prompt", metadata: { ...metadata, source: "scheduled prompt" }, error: "Out of credit", usage: null },
    });
    expect(finishScheduledRun).toHaveBeenCalledWith({
      workspaceId: metadata.workspace, runId: "run-7", error: "Out of credit", completedAt: 1_790_000_000_000,
    });
    // A message someone sent in the thread is no scheduled run.
    finishScheduledRun.mockClear();
    await deliver(cronEnv, {
      id: eventId(), type: "run.completed", created: 1_790_000_001,
      data: { agentId, requestId: "cm_1", method: "prompt", metadata, usage: null },
    });
    expect(finishScheduledRun).not.toHaveBeenCalled();
  });

  it("records a failed run's error on the thread", async () => {
    const { runEnv, agentId, metadata, threadId, orgStub } = await setup();
    await deliver(runEnv, {
      id: eventId(), type: "run.failed", created: Math.floor(Date.now() / 1000),
      data: { agentId, requestId: "r3", method: "prompt", metadata, error: "Provider unavailable", usage: null },
    });
    const thread = await orgStub.getThread(threadId);
    expect(thread?.last_chat_error_message).toBe("Provider unavailable");
    expect(thread?.chat_error_count).toBe(1);
  });

  it("only clears running for a turn that waits on input, and ignores a steered message's end", async () => {
    const { runEnv, agentId, metadata, threadId, orgStub, streaming } = await setup();
    await deliver(runEnv, {
      id: eventId(), type: "run.completed", created: Math.floor(Date.now() / 1000),
      data: { agentId, requestId: "r4", method: "prompt", metadata, stopped: "input_required", inputIds: ["in_1"] },
    });
    expect(streaming).toHaveBeenCalledWith(threadId, false, { clearOnlyIfRunning: true });
    expect((await orgStub.getThread(threadId))?.last_assistant_completed_at ?? null).toBeNull();
    streaming.mockClear();
    await deliver(runEnv, {
      id: eventId(), type: "run.completed", created: 1,
      data: { agentId, requestId: "r5", method: "prompt", metadata, steeredInto: "r1" },
    });
    expect(streaming).not.toHaveBeenCalled();
  });

  it("records a handler failure and answers an error, so the runtime delivers the event again", async () => {
    const { runEnv, agentId, metadata } = await setup();
    const writes = { writeDataPoint: vi.fn() };
    const errors = { writeDataPoint: vi.fn() };
    const failing = {
      ...runEnv,
      OBSERVABILITY_EVENTS: writes,
      ERROR_ANALYTICS: errors,
      WORKSPACE: { idFromName: (name: string) => name, get: () => ({ recordThreadStreaming: async () => { throw new Error("workspace unavailable"); } }) },
    } as unknown as Env;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const event = { id: eventId(), type: "run.started", created: 1, data: { agentId, requestId: "r", method: "prompt", metadata } };
    await expect(deliver(failing, event)).rejects.toThrow("workspace unavailable");
    const [{ blobs }] = writes.writeDataPoint.mock.calls[0] as [{ blobs: string[] }];
    expect(blobs.slice(0, 5)).toEqual(["runtime_event_handler_failed", "error", "agent_runtime_events", "run.started", "failed"]);
    expect(errors.writeDataPoint).toHaveBeenCalledTimes(1);
    // Not marked seen: the redelivery is handled.
    expect(await testEnv.APP_KV.get(`agent-runtime:event:${event.id}`)).toBeNull();
  });

  it("records an event for no known runtime thread", async () => {
    const { runEnv, metadata } = await setup();
    const writes = { writeDataPoint: vi.fn() };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await deliver({ ...runEnv, OBSERVABILITY_EVENTS: writes } as unknown as Env, {
      id: eventId(), type: "run.completed", created: 1, data: { agentId: "client_other", requestId: "r", method: "prompt", metadata },
    });
    expect(response.status).toBe(204);
    const [{ blobs }] = writes.writeDataPoint.mock.calls[0] as [{ blobs: string[] }];
    expect(blobs.slice(0, 5)).toEqual(["runtime_event_unknown_thread", "warn", "agent_runtime_events", "run.completed", "unknown_thread"]);
  });

  it("acknowledges events for agents that are not the thread's, without acting", async () => {
    const { runEnv, metadata, streaming } = await setup();
    const response = await deliver(runEnv, {
      id: eventId(), type: "run.started", created: 1, data: { agentId: "client_other", requestId: "r", method: "prompt", metadata },
    });
    expect(response.status).toBe(204);
    expect(streaming).not.toHaveBeenCalled();
  });
});
