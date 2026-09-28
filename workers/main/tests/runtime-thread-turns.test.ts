/**
 * Sends to threads that run directly on the hosted agent runtime
 * (plans/runtime-threads-direct.md §4.2), against a real OrgDO and a fake
 * runtime tenant API.
 *
 * Run with: bun run test:workers
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import { stringifyStoredLlmProviderConfig } from "../../../src/lib/llm-provider-config";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths";
import type { ChatEnv } from "../src/chat-thread/types";
import { RUNTIME_PROMPT_VERSION } from "../src/chat-thread/runtime-agent";
import {
  abortRuntimeThread,
  answerRuntimeInput,
  mintRuntimeBrowserToken,
  pinNewThreadToRuntime,
  runtimeAgentThreadKey,
  threadScratchVolume,
  startRuntimeTurn,
} from "../src/agent-runtime/thread-runtime";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const RUNTIME = "https://runtime.test";
const runtimeEnv = {
  ...(env as unknown as ChatEnv),
  AGENT_RUNTIME_URL: RUNTIME,
  AGENT_RUNTIME_API_TOKEN: "operator-token",
  AGENT_RUNTIME_TENANT: "chiridion-test",
  AGENT_RUNTIME_DEFINITION: "def_test",
} as ChatEnv;

type Call = { method: string; path: string; body: any; raw?: string; headers: Headers };

function fakeRuntime(responses: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== RUNTIME) return original(input, init);
    const headers = new Headers(init?.headers);
    const json = (headers.get("content-type") ?? "").includes("json");
    const raw = init?.body !== undefined && init?.body !== null && !json ? await new Response(init.body as BodyInit).text() : undefined;
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init?.body && json ? JSON.parse(String(init.body)) : undefined,
      raw,
      headers,
    };
    calls.push(call);
    const key = `${call.method} ${url.pathname}`;
    if (responses[key]) return responses[key](call);
    if (key === "POST /v1/agents") return Response.json({ id: "agt_1", token: "agent-token" }, { status: 201 });
    if (key.endsWith("/prompt")) return Response.json({ id: call.body.requestId, method: "prompt", state: "running", fingerprint: "f" }, { status: 202 });
    if (key.endsWith("/configuration")) return Response.json({ id: call.body.requestId, method: "configure", state: "running", fingerprint: "f" }, { status: 202 });
    if (key.endsWith("/browser-tokens")) return Response.json({ token: "abt_1", expiresAt: 1_900_000_000_000, agentId: "agt_1", url: "https://agents.test" }, { status: 201 });
    if (key.endsWith("/abort")) return Response.json({ aborted: true });
    if (call.method === "PUT" && url.pathname.includes("/uploads/")) {
      const [requestId, name] = url.pathname.split("/uploads/")[1].split("/").map(decodeURIComponent);
      return Response.json({ path: `/workspace/uploads/${requestId}/${name}`, version: 1, size: raw?.length ?? 0, updatedAt: 1, contentType: headers.get("content-type") ?? "" }, { status: 201 });
    }
    // An idle agent that has never seen the request.
    if (call.method === "GET" && url.pathname.endsWith("/state")) return Response.json({ cursor: 1, requests: [] });
    if (call.method === "GET" && url.pathname.includes("/requests/")) return Response.json({ error: "Unknown request" }, { status: 404 });
    return Response.json({}, { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const testEmail = () => `rt-turn-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

/** A BYOK (Anthropic) org with one runtime thread. */
async function runtimeThread() {
  const { userId } = await createUser(testEnv, testEmail(), "password123", "Runtime Sender");
  const { org, defaultWorkspaceId } = await createOrg(testEnv, "Runtime Org", userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const encrypted = await encryptCredentials({ api_key: "sk-ant-test" }, testEnv.INTEGRATION_SECRET_KEY ?? "test-secret");
  await orgStub.setLlmProviderConfig("anthropic", encrypted, stringifyStoredLlmProviderConfig({}), userId);
  const thread = await orgStub.createThread(defaultWorkspaceId as string, "Runtime thread", userId);
  await orgStub.pinThreadRuntime(thread.id);
  const context = {
    orgId: org.id,
    workspaceId: defaultWorkspaceId as string,
    threadId: thread.id,
    userId,
    userName: "Runtime Sender",
    userEmail: null,
  };
  return { orgStub, context, sender: { userId, userName: "Runtime Sender", userEmail: null }, threadId: thread.id };
}

async function send(setup: Awaited<ReturnType<typeof runtimeThread>>, text: string, clientMessageId: string) {
  const pending: Promise<unknown>[] = [];
  const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
  const result = await startRuntimeTurn(runtimeEnv, {
    context: setup.context,
    row,
    sender: setup.sender,
    text,
    clientMessageId,
    waitUntil: (promise) => { pending.push(promise); },
  });
  await Promise.allSettled(pending);
  return result;
}

describe("startRuntimeTurn", () => {
  it("creates the thread's agent on the first send and prompts it as the sender", async () => {
    const setup = await runtimeThread();
    const calls = fakeRuntime();
    const result = await send(setup, "Hello runtime", "cm_1");
    expect(result).toMatchObject({ status: "accepted", requestId: "cm_1", agentId: "agt_1" });

    const create = calls.find((call) => call.method === "POST" && call.path === "/v1/agents")!;
    expect(create.headers.get("idempotency-key")).toBe(`thread_${setup.threadId}`);
    expect(create.headers.get("authorization")).toBe("Bearer operator-token");
    expect(create.body).toMatchObject({
      definition: "def_test",
      keyScope: `org_${setup.context.orgId}`,
      subject: setup.sender.userId,
      context: { org: setup.context.orgId, workspace: setup.context.workspaceId, thread: setup.threadId },
    });
    expect(create.body.model).toMatch(/^anthropic\//);
    expect(create.body.systemPromptAppend).toContain("camelAI tools on this runtime");

    const prompt = calls.find((call) => call.path === "/v1/agents/agt_1/prompt")!;
    expect(prompt.body).toEqual({
      text: "Hello runtime",
      from: { id: setup.sender.userId, name: "Runtime Sender" },
      actor: setup.sender.userId,
      requestId: "cm_1",
      whileRunning: "steer",
      metadata: { source: "web", org: setup.context.orgId, workspace: setup.context.workspaceId, thread: setup.threadId },
    });
    // Runs no message started (a resume) find the thread by the agent.
    expect(await testEnv.APP_KV.get(runtimeAgentThreadKey("agt_1"), "json")).toEqual({
      org: setup.context.orgId, workspace: setup.context.workspaceId, thread: setup.threadId,
    });
    // The org's key scope was synced before the run.
    expect(calls.some((call) => call.path.startsWith(`/v1/key-scopes/org_${setup.context.orgId}/providers/anthropic`))).toBe(true);

    expect(await setup.orgStub.getThreadRuntime(setup.threadId)).toMatchObject({
      agentId: "agt_1",
      model: create.body.model,
      keyScope: `org_${setup.context.orgId}`,
    });
    const thread = await setup.orgStub.getThread(setup.threadId);
    expect(thread?.last_user_message).toBe("Hello runtime");
  });

  it("reuses the agent, and configures it only when the model changes", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_a");
    let calls = fakeRuntime();
    expect(await send(setup, "second", "cm_b")).toMatchObject({ status: "accepted" });
    expect(calls.some((call) => call.path === "/v1/agents")).toBe(false);
    expect(calls.some((call) => call.path.endsWith("/configuration"))).toBe(false);

    await setup.orgStub.updateThreadModel(setup.threadId, "opus");
    calls = fakeRuntime();
    await send(setup, "third", "cm_c");
    const configure = calls.find((call) => call.path === "/v1/agents/agt_1/configuration")!;
    expect(configure.body).toMatchObject({ thinkingLevel: expect.any(String) });
    // No limit before or now: the budget is left as it is.
    expect(configure.body).not.toHaveProperty("spendLimit");
    expect(configure.body.model).toMatch(/^anthropic\//);
    expect(configure.body).not.toHaveProperty("keyScope");
    const order = calls.map((call) => call.path);
    expect(order.indexOf("/v1/agents/agt_1/configuration")).toBeLessThan(order.indexOf("/v1/agents/agt_1/prompt"));
  });

  it("refuses an empty message without calling the runtime", async () => {
    const setup = await runtimeThread();
    const calls = fakeRuntime();
    expect(await send(setup, "   ", "cm_x")).toMatchObject({ status: "error", error: "Empty message" });
    expect(calls).toHaveLength(0);
  });

  it("answers busy when the runtime has too many queued", async () => {
    const setup = await runtimeThread();
    fakeRuntime({ "POST /v1/agents/agt_1/prompt": () => Response.json({ error: "Too many requests queued for this agent" }, { status: 429 }) });
    expect(await send(setup, "hi", "cm_busy")).toMatchObject({ status: "busy" });
  });
});

describe("runtime thread reads and writes", () => {
  it("mints a read-only browser token for one agent, showing costs to BYOK threads", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "hi", "cm_t");
    const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    const calls = fakeRuntime();
    const token = await mintRuntimeBrowserToken(runtimeEnv, { ...row, agentId: row.agentId! }, setup.sender.userId);
    expect(token).toEqual({ token: "abt_1", expiresAt: 1_900_000_000_000, agentId: "agt_1", url: "https://agents.test" });
    expect(calls[0].body).toMatchObject({
      ttlSeconds: 900,
      scopes: ["events", "state", "history", "inputs"],
      subject: setup.sender.userId,
    });
    expect(calls[0].body.events).toContain("message_update");
    expect(calls[0].body).not.toHaveProperty("redact");

    const hosted = fakeRuntime();
    await mintRuntimeBrowserToken(runtimeEnv, { ...row, agentId: row.agentId!, keyScope: "hosted" }, setup.sender.userId);
    expect(hosted[0].body.redact).toEqual(["usage.cost"]);
  });

  it("answers an input as the user, passes the runtime's refusals through, and aborts", async () => {
    const setup = await runtimeThread();
    let calls = fakeRuntime({
      "POST /v1/agents/agt_1/inputs/in_1": () => Response.json({ input: { id: "in_1" }, request: null }, { status: 202 }),
      "POST /v1/agents/agt_1/inputs/in_2": () => Response.json({ error: "The input had already settled" }, { status: 409 }),
    });
    expect(await answerRuntimeInput(runtimeEnv, "agt_1", "in_1", { action: "accept", content: { answers: { Q: "A" } } }, setup.sender))
      .toMatchObject({ status: 200 });
    expect(calls[0].body).toEqual({ action: "accept", content: { answers: { Q: "A" } }, from: { id: setup.sender.userId, name: "Runtime Sender" } });
    expect(await answerRuntimeInput(runtimeEnv, "agt_1", "in_2", { action: "decline" }, setup.sender)).toMatchObject({ status: 409 });

    calls = fakeRuntime();
    await abortRuntimeThread(runtimeEnv, "agt_1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/agents/agt_1/abort" });
  });
});

describe("pinNewThreadToRuntime", () => {
  it("pins a new thread only where direct runtime threads are on", async () => {
    const setup = await runtimeThread();
    const thread = await setup.orgStub.createThread(setup.context.workspaceId, "Fresh", setup.sender.userId);
    const context = { ...setup.context, threadId: thread.id };
    expect(await pinNewThreadToRuntime(runtimeEnv, context)).toBeNull();
    expect(await setup.orgStub.getThreadRuntime(thread.id)).toBeNull();

    const pinned = await pinNewThreadToRuntime({ ...runtimeEnv, AGENT_RUNTIME_DIRECT_THREADS: "1" } as ChatEnv, context);
    expect(pinned).toMatchObject({ threadId: thread.id, agentId: null });
    expect(await setup.orgStub.getThreadRuntime(thread.id)).toMatchObject({ threadId: thread.id });
  });

  it("leaves a thread whose model has no runtime route on ChatThreadDO", async () => {
    const setup = await runtimeThread();
    const encrypted = await encryptCredentials({ api_key: "sk-custom" }, testEnv.INTEGRATION_SECRET_KEY ?? "test-secret");
    await setup.orgStub.setLlmProviderConfig(
      "custom",
      encrypted,
      stringifyStoredLlmProviderConfig({ custom_base_url: "https://llm.example.test/v1", custom_api: "openai-completions", custom_model_id: "house-model" }),
      setup.sender.userId,
    );
    const thread = await setup.orgStub.createThread(setup.context.workspaceId, "Custom", setup.sender.userId);
    const context = { ...setup.context, threadId: thread.id };
    expect(await pinNewThreadToRuntime({ ...runtimeEnv, AGENT_RUNTIME_DIRECT_THREADS: "1" } as ChatEnv, context)).toBeNull();
    expect(await setup.orgStub.getThreadRuntime(thread.id)).toBeNull();
  });
});

describe("an existing agent's spend limit, and retries", () => {
  async function withLimit(limit: number | null) {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_first");
    const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    await setup.orgStub.setThreadRuntimeAgent(setup.threadId, { agentId: row.agentId!, model: row.model, keyScope: row.keyScope, configured: { spendLimitUsd: limit, promptVersion: RUNTIME_PROMPT_VERSION } });
    return setup;
  }

  it("removes a spend limit an earlier release set on the agent itself", async () => {
    const setup = await withLimit(5);
    const calls = fakeRuntime();
    await send(setup, "next", "cm_idle");
    const configure = calls.find((call) => call.path.endsWith("/configuration"));
    expect(configure?.body).toMatchObject({ spendLimit: null });
    expect((await setup.orgStub.getThreadRuntime(setup.threadId))!.configured).not.toHaveProperty("spendLimitUsd");
  });

  it("changes nothing for a retried request", async () => {
    const setup = await withLimit(5);
    await setup.orgStub.updateThreadModel(setup.threadId, "opus");
    const calls = fakeRuntime({
      "GET /v1/agents/agt_1/requests/cm_retry": () => Response.json({ id: "cm_retry", method: "prompt", state: "running", fingerprint: "f" }),
    });
    expect(await send(setup, "again", "cm_retry")).toMatchObject({ status: "accepted", requestId: "cm_retry" });
    expect(calls.some((call) => call.path.endsWith("/configuration"))).toBe(false);
  });
});

describe("the usual send", () => {
  const runningRows = (setup: Awaited<ReturnType<typeof runtimeThread>>) =>
    testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(setup.context.workspaceId)).listStreamingThreadStatuses();

  it("makes one runtime call, the prompt, to an agent configured as the send needs", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_u1");
    const calls = fakeRuntime();
    expect(await send(setup, "second", "cm_u2")).toMatchObject({ status: "accepted" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/agents/agt_1/prompt"]);
  });

  it("marks the thread running from when the message was taken, before the prompt", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_m1");
    // The first turn ended.
    await testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(setup.context.workspaceId)).recordThreadStreaming(setup.threadId, false);
    let atPrompt: Awaited<ReturnType<typeof runningRows>> = [];
    fakeRuntime({
      "POST /v1/agents/agt_1/prompt": async (call) => {
        atPrompt = await runningRows(setup);
        return Response.json({ id: call.body.requestId, method: "prompt", state: "running", fingerprint: "f" }, { status: 202 });
      },
    });
    const before = Date.now();
    await send(setup, "second", "cm_m2");
    const row = atPrompt.find((status) => status.threadId === setup.threadId);
    expect(row?.startedAt).toBeGreaterThanOrEqual(before);
    expect(row?.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("takes its mark back when the prompt fails, and leaves another turn's", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_f1");
    const workspace = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(setup.context.workspaceId));
    await workspace.recordThreadStreaming(setup.threadId, false);

    fakeRuntime({ "POST /v1/agents/agt_1/prompt": () => Response.json({ error: "down" }, { status: 502 }) });
    await expect(send(setup, "fails", "cm_f2")).rejects.toThrow(/HTTP 502/);
    expect((await runningRows(setup)).some((status) => status.threadId === setup.threadId)).toBe(false);

    // A retried request that had already finished starts no run to end the mark.
    fakeRuntime({ "POST /v1/agents/agt_1/prompt": (call) => Response.json({ id: call.body.requestId, method: "prompt", state: "completed", fingerprint: "f" }, { status: 202 }) });
    expect(await send(setup, "again", "cm_f1")).toMatchObject({ status: "accepted" });
    expect((await runningRows(setup)).some((status) => status.threadId === setup.threadId)).toBe(false);

    // Busy while another turn runs: that turn stays running, from its own start.
    const otherStart = Date.now() - 10_000;
    await workspace.recordThreadStreaming(setup.threadId, true, { startedAt: otherStart });
    fakeRuntime({ "POST /v1/agents/agt_1/prompt": () => Response.json({ error: "Too many requests queued" }, { status: 429 }) });
    expect(await send(setup, "busy", "cm_f3")).toMatchObject({ status: "busy" });
    expect(await runningRows(setup)).toEqual([expect.objectContaining({ threadId: setup.threadId, startedAt: otherStart })]);
  });

  it("sends each run the budget left now, and never reconfigures the agent for it", async () => {
    const setup = await runtimeThread();
    await setup.orgStub.setUserLlmUsageLimits(setup.sender.userId, [{ window_hours: 24, limit_usd: 5 }]);
    let calls = fakeRuntime();
    await send(setup, "first", "cm_s1");
    expect(calls.find((call) => call.path === "/v1/agents")!.body).not.toHaveProperty("spendLimit");
    expect(calls.find((call) => call.path.endsWith("/prompt"))!.body.spendLimit).toEqual({ usd: 5 });

    const usage = (threadId: string, id: string) => setup.orgStub.recordUsage({
      workspace_id: setup.context.workspaceId,
      user_id: setup.sender.userId,
      thread_id: threadId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      billing_source: "byok",
      usage_kind: "llm",
      usage_surface: "agent",
      reported_cost_usd: 1,
      source: "agent_runtime",
      source_id: id,
    });
    // This thread spent $1, then another thread $1 of the user's budget: each next run gets what is left.
    await usage(setup.threadId, "evt_own");
    calls = fakeRuntime();
    await send(setup, "second", "cm_s2");
    expect(calls.map((call) => call.path)).toEqual(["/v1/agents/agt_1/prompt"]);
    expect(calls[0].body.spendLimit).toEqual({ usd: 4 });
    await usage(crypto.randomUUID(), "evt_other");
    calls = fakeRuntime();
    await send(setup, "third", "cm_s3");
    expect(calls.map((call) => call.path)).toEqual(["/v1/agents/agt_1/prompt"]);
    expect(calls[0].body.spendLimit).toEqual({ usd: 3 });
  });
});

describe("agent creation conflicts", () => {
  it("adopts the thread's agent when its key was used with an earlier configuration, and reconfigures it", async () => {
    const setup = await runtimeThread();
    const tenantKey = `chiridion-test:thread_${setup.threadId}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tenantKey));
    const adopted = `client_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
    const calls = fakeRuntime({
      "POST /v1/agents": () => Response.json({ error: "This Idempotency-Key was sent with another request: a key is for one method, path and body", code: "IDEMPOTENCY_CONFLICT" }, { status: 409 }),
      [`GET /v1/agents/${adopted}`]: () => Response.json({ id: adopted }),
    });
    expect(await send(setup, "hello", "cm_adopt")).toMatchObject({ status: "accepted", agentId: adopted });
    const configure = calls.find((call) => call.path === `/v1/agents/${adopted}/configuration`)!;
    expect(configure.body).toMatchObject({ model: expect.stringMatching(/^anthropic\//), keyScope: `org_${setup.context.orgId}`, spendLimit: null });
    expect(configure.body.systemPromptAppend).toContain("camelAI tools on this runtime");
    expect(await setup.orgStub.getThreadRuntime(setup.threadId)).toMatchObject({ agentId: adopted });
  });
});

describe("the runtime prompt's two filesystems", () => {
  it("tells the model /workspace is this thread's scratch and camelAI's workspace is durable, without forbidding fs", async () => {
    const setup = await runtimeThread();
    const calls = fakeRuntime();
    await send(setup, "hello", "cm_prompt");
    const append: string = calls.find((call) => call.path === "/v1/agents")!.body.systemPromptAppend;
    expect(append).toContain("/workspace is this conversation's scratch space");
    expect(append).toContain("fs in js_exec");
    expect(append).toContain("only when the user asks");
    expect(append).toContain("camel__import_file");
    expect(append).toContain("/workspace/tool-results/");
    expect(append).not.toMatch(/not fs\b/);
    expect(await setup.orgStub.getThreadRuntime(setup.threadId)).toMatchObject({ configured: { promptVersion: RUNTIME_PROMPT_VERSION } });
  });

  it("sends the prompt again, once, to an agent configured with an earlier version", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "first", "cm_p1");
    const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    await setup.orgStub.setThreadRuntimeAgent(setup.threadId, { agentId: row.agentId!, model: row.model, keyScope: row.keyScope, configured: { thinkingLevel: "medium", spendLimitUsd: null } });
    let calls = fakeRuntime();
    await send(setup, "second", "cm_p2");
    const configure = calls.find((call) => call.path.endsWith("/configuration"))!;
    expect(configure.body.systemPromptAppend).toContain("/workspace is this conversation's scratch space");
    expect(configure.body).not.toHaveProperty("model");
    calls = fakeRuntime();
    await send(setup, "third", "cm_p3");
    expect(calls.some((call) => call.path.endsWith("/configuration"))).toBe(false);
  });
});

describe("threadScratchVolume", () => {
  it("finds the agent's /workspace volume once, then keeps it on the thread's row", async () => {
    const setup = await runtimeThread();
    fakeRuntime();
    await send(setup, "hi", "cm_vol");
    let calls = fakeRuntime({
      "GET /v1/agents/agt_1": () => Response.json({ id: "agt_1", mounts: [{ volumeId: "vol_scratch", path: "/workspace", mode: "rw" }] }),
    });
    const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    expect(await threadScratchVolume(runtimeEnv, setup.context, row)).toBe("vol_scratch");
    expect(calls.filter((call) => call.path === "/v1/agents/agt_1")).toHaveLength(1);
    const saved = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    expect(saved.configured).toMatchObject({ scratchVolumeId: "vol_scratch", promptVersion: RUNTIME_PROMPT_VERSION });
    calls = fakeRuntime();
    expect(await threadScratchVolume(runtimeEnv, setup.context, saved)).toBe("vol_scratch");
    expect(calls).toHaveLength(0);
  });

  it("has none before the agent exists", async () => {
    const setup = await runtimeThread();
    const row = (await setup.orgStub.getThreadRuntime(setup.threadId))!;
    expect(await threadScratchVolume(runtimeEnv, setup.context, row)).toBeNull();
  });
});

describe("uploads attached to the runtime message", () => {
  async function upload(setup: Awaited<ReturnType<typeof runtimeThread>>, filename: string, body: string, contentType: string) {
    await testEnv.R2_BUCKET.put(buildWorkspaceScopedR2Key(setup.context.orgId, setup.context.workspaceId, `user-uploads/${filename}`), body, { httpMetadata: { contentType } });
  }
  const uploadRoute = (call: Call) => call.method === "PUT" && call.path.includes("/uploads/");

  it("streams the message's uploads from R2 to the agent and attaches them, keeping the R2 reference in the text", async () => {
    const setup = await runtimeThread();
    await upload(setup, "q3-1790000000000-ab12cd.pdf", "%PDF-1.7", "application/pdf");
    await upload(setup, "chart-1790000000001-ef34gh.png", "png-bytes", "image/png");
    const calls = fakeRuntime();
    const text = "Compare these (user uploaded file to uploads/q3-1790000000000-ab12cd.pdf) (user uploaded file to uploads/chart-1790000000001-ef34gh.png)";
    const result = await send(setup, text, "cm_up");
    expect(result).toMatchObject({ status: "accepted" });
    const uploads = calls.filter(uploadRoute);
    expect(uploads.map((call) => call.path)).toEqual([
      "/v1/agents/agt_1/uploads/cm_up/q3.pdf",
      "/v1/agents/agt_1/uploads/cm_up/chart.png",
    ]);
    expect(uploads[0].headers.get("content-type")).toBe("application/pdf");
    expect(uploads[0].raw).toBe("%PDF-1.7");
    // The agent exists before its uploads, and they come before the message.
    const order = calls.map((call) => call.path);
    expect(order.indexOf("/v1/agents")).toBeLessThan(order.indexOf(uploads[0].path));
    expect(order.indexOf(uploads[1].path)).toBeLessThan(order.findIndex((path) => path.endsWith("/prompt")));
    const prompt = calls.find((call) => call.path.endsWith("/prompt"))!;
    expect(prompt.body.files).toEqual([{ path: "/workspace/uploads/cm_up/q3.pdf" }, { path: "/workspace/uploads/cm_up/chart.png" }]);
    expect(prompt.body.text).toContain("(user uploaded file to uploads/q3-1790000000000-ab12cd.pdf)");
  });

  it("leaves out unsafe, missing and failed uploads, and still sends the message", async () => {
    const setup = await runtimeThread();
    await upload(setup, "tool-1790000000000-ab12cd.exe", "MZ", "application/octet-stream");
    const calls = fakeRuntime({
      "PUT /v1/agents/agt_1/uploads/cm_bad/notes.txt": () => Response.json({ error: "boom" }, { status: 500 }),
    });
    await upload(setup, "notes-1790000000002-zz99yy.txt", "hi", "text/plain");
    const text = "(user uploaded file to uploads/tool-1790000000000-ab12cd.exe) (user uploaded file to uploads/gone-1790000000003-aa11bb.csv) (user uploaded file to uploads/notes-1790000000002-zz99yy.txt)";
    expect(await send(setup, text, "cm_bad")).toMatchObject({ status: "accepted" });
    expect(calls.filter(uploadRoute).map((call) => call.path)).toEqual(["/v1/agents/agt_1/uploads/cm_bad/notes.txt"]);
    const prompt = calls.find((call) => call.path.endsWith("/prompt"))!;
    expect(prompt.body).not.toHaveProperty("files");
  });
});
