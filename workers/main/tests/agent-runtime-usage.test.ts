/**
 * The runtime's `usage.recorded` events (POST /agent-runtime/events): each
 * model response of a runtime agent becomes a usage_log row of the org in its
 * context, idempotent by the event id.
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it, vi } from "vitest";

import { verifyStandardWebhook } from "../src/agent-runtime/webhooks";
import { usageRowFor, type RuntimeUsageRecorded } from "../src/agent-runtime/usage";
import { handleAgentRuntimeEventsRequest } from "../src/routes/agent-runtime-events";
import type { Env } from "../src/types";

const KEY = new Uint8Array(32).map((_, index) => index + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...KEY))}`;

async function sign(id: string, timestamp: number, body: string, key = KEY) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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

const data: RuntimeUsageRecorded = {
  agentId: "client_1",
  requestId: "r1",
  subject: "user1",
  actor: "user2",
  context: { org: "org1", workspace: "ws1", thread: "t1" },
  keyScope: "hosted",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-5:nitro",
  kind: "response",
  input: 12,
  output: 30,
  cacheRead: 2000,
  cacheWrite: 10,
  cost: { usd: 0.0042, source: "provider" },
  at: 1_790_000_000_000,
};

const usageEvent = (id = "evt_use1", overrides: Partial<RuntimeUsageRecorded> = {}) =>
  ({ id, type: "usage.recorded", created: 1_790_000_000, data: { ...data, ...overrides } });

describe("verifyStandardWebhook", () => {
  it("accepts the runtime's signature and refuses a wrong, stale or missing one", async () => {
    const body = JSON.stringify(usageEvent());
    const now = Math.floor(Date.now() / 1000);
    const headers = async (signature: string, timestamp = now) => new Headers({ "webhook-id": "msg_1", "webhook-timestamp": String(timestamp), "webhook-signature": signature });
    expect(await verifyStandardWebhook(SECRET, await headers(await sign("msg_1", now, body)), body)).toBe(true);
    // One of several signatures (a key rotation) is enough.
    expect(await verifyStandardWebhook(SECRET, await headers(`v1,bogus ${await sign("msg_1", now, body)}`), body)).toBe(true);
    expect(await verifyStandardWebhook(SECRET, await headers(await sign("msg_1", now, body, new Uint8Array(32))), body)).toBe(false);
    expect(await verifyStandardWebhook(SECRET, await headers(await sign("msg_1", now - 3600, body), now - 3600), body)).toBe(false);
    expect(await verifyStandardWebhook(SECRET, new Headers(), body)).toBe(false);
  });
});

describe("usageRowFor", () => {
  it("bills hosted usage as camelAI's, as the acting user, keyed by the event id", () => {
    expect(usageRowFor("evt_use1", data, { billing_status: "active" })).toMatchObject({
      workspace_id: "ws1",
      user_id: "user2",
      thread_id: "t1",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5:nitro",
      billing_source: "hosted",
      credit_chargeable: true,
      usage_surface: "agent",
      input_tokens: 12,
      output_tokens: 30,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 10,
      reported_cost_usd: 0.0042,
      created_at_ms: 1_790_000_000_000,
      source: "agent_runtime",
      source_id: "evt_use1",
    });
  });

  it("does not charge credits for the free tier, enterprise orgs, BYOK or Codex", () => {
    const row = (overrides: Partial<RuntimeUsageRecorded>, org: { billing_status?: unknown } | null = null) =>
      usageRowFor("evt", { ...data, ...overrides }, org);
    expect(row({ provider: "openrouter", model: "openai/gpt-6-luna" }, { billing_status: "active" }).credit_chargeable).toBe(false);
    expect(row({}, { billing_status: "enterprise" }).credit_chargeable).toBe(false);
    expect(row({ keyScope: "org_org1", provider: "anthropic", model: "claude-opus-5-5", cost: { usd: 0.01, source: "catalog" } }))
      .toMatchObject({ billing_source: "byok", credit_chargeable: false, estimated_cost_usd: 0.01 });
    expect(row({ keyScope: null, provider: "chiridion", model: "openai-codex/gpt-6-sol", actor: null }))
      .toMatchObject({ billing_source: "byok", provider: "openai", model: "gpt-6-sol", user_id: "user1" });
    expect(row({ kind: "compaction" }).usage_surface).toBe("compaction");
    expect(row({ keyScope: "org_org1", provider: "amazon-bedrock", model: "us.anthropic.claude-sonnet-5" }))
      .toMatchObject({ provider: "bedrock", model: "us.anthropic.claude-sonnet-5", billing_source: "byok" });
    // The runtime reports the agent as subject when it has none: no user then.
    expect(row({ actor: null, subject: "client_1" }).user_id).toBe("");
  });
});

describe("usage.recorded on POST /agent-runtime/events", () => {
  function fakeEnv(thread: { last_assistant_completed_at: number | null } | null = { last_assistant_completed_at: null }) {
    const getThread = vi.fn(async () => thread);
    const recordUsage = vi.fn(async () => ({ id: 1, cost_usd: 0, inserted: true }));
    const recordThreadStreaming = vi.fn(async () => {});
    const workspaces: string[] = [];
    const orgs: string[] = [];
    const kv = new Map<string, string>();
    const env = {
      AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET: SECRET,
      APP_KV: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => { kv.set(key, value); },
      },
      ORG: {
        idFromName: (name: string) => name,
        get: (id: string) => { orgs.push(id); return { getInfo: async () => ({ billing_status: "active" }), recordUsage, getThread }; },
      },
      WORKSPACE: {
        idFromName: (name: string) => name,
        get: (id: string) => { workspaces.push(id); return { recordThreadStreaming }; },
      },
    } as unknown as Env;
    return { env, recordUsage, recordThreadStreaming, workspaces, orgs };
  }

  const deliver = async (env: Env, event: Record<string, unknown>, signature?: string) =>
    handleAgentRuntimeEventsRequest(await delivery(event, signature), env, () => {});

  it("records a signed event in the org of its context, keyed by the event id", async () => {
    const { env, recordUsage, orgs } = fakeEnv();
    expect((await deliver(env, usageEvent())).status).toBe(204);
    expect(orgs).toContain("org1");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      source: "agent_runtime", source_id: "evt_use1", user_id: "user2", thread_id: "t1", credit_chargeable: true,
    }));
  });

  it("records a redelivered event once", async () => {
    const { env, recordUsage } = fakeEnv();
    await deliver(env, usageEvent("evt_again"));
    await deliver(env, usageEvent("evt_again"));
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("marks the thread running again, so a lease the sweeper cleared mid-run comes back", async () => {
    const { env, recordThreadStreaming, workspaces } = fakeEnv({ last_assistant_completed_at: data.at! - 60_000 });
    await deliver(env, usageEvent());
    expect(workspaces).toEqual(["ws1"]);
    expect(recordThreadStreaming).toHaveBeenCalledWith("t1", true, undefined);
  });

  it("only renews the lease for a response from before the thread's last completion", async () => {
    // A late delivery of a finished run's usage must not mark the thread running.
    const { env, recordThreadStreaming } = fakeEnv({ last_assistant_completed_at: data.at! + 1 });
    await deliver(env, usageEvent());
    expect(recordThreadStreaming).toHaveBeenCalledWith("t1", true, { refresh: true, source: "runtime_usage" });
    // Completion times are whole seconds (the run event's `created`): a
    // response later in the completing second is the same run's.
    const sameSecond = fakeEnv({ last_assistant_completed_at: data.at! - 400 });
    await deliver(sameSecond.env, usageEvent("evt_same_second"));
    expect(sameSecond.recordThreadStreaming).toHaveBeenCalledWith("t1", true, { refresh: true, source: "runtime_usage" });
  });

  it("still records usage when the lease cannot be renewed", async () => {
    const { env, recordUsage, recordThreadStreaming } = fakeEnv();
    recordThreadStreaming.mockRejectedValueOnce(new Error("WorkspaceDO overloaded"));
    expect((await deliver(env, usageEvent())).status).toBe(204);
    expect(recordUsage).toHaveBeenCalled();
  });

  it("refuses an unsigned event, and acknowledges (without billing) one with no org", async () => {
    const { env, recordUsage } = fakeEnv();
    expect((await deliver(env, usageEvent(), "v1,bad")).status).toBe(401);
    expect((await deliver(env, usageEvent("evt_noorg", { context: {} }))).status).toBe(204);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("answers 500 when recording fails, so the runtime delivers it again", async () => {
    const { env, recordUsage } = fakeEnv();
    recordUsage.mockRejectedValueOnce(new Error("OrgDO unavailable"));
    await expect(deliver(env, usageEvent("evt_retry"))).rejects.toThrow("OrgDO unavailable");
    expect((await deliver(env, usageEvent("evt_retry"))).status).toBe(204);
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });
});
