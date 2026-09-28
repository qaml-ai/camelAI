import { describe, expect, it } from "vitest";

import { encryptCredentials } from "../../../src/lib/integration-crypto";
import { hostedModelHeaders, hostedScopeProviders, orgScopeProviders, syncKeyScope, syncOrgKeyScope, type KeyScopeEnv } from "../src/agent-runtime/key-scopes";

const SECRET = "test-integration-secret-key-for-key-scope-tests";

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    kv: {
      get: async (key: string, type?: string) => {
        const value = data.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => { data.set(key, value); },
      delete: async (key: string) => { data.delete(key); },
    } as unknown as KVNamespace,
  };
}

function fakeRuntime() {
  const calls: Array<{ method: string; path: string; body?: unknown; auth: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get("authorization") });
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function env(kv: KVNamespace, extra: Record<string, string> = {}): KeyScopeEnv {
  return {
    AGENT_RUNTIME_URL: "https://runtime.test",
    AGENT_RUNTIME_API_TOKEN: "operator",
    APP_KV: kv,
    ORG: {} as DurableObjectNamespace,
    INTEGRATION_SECRET_KEY: SECRET,
    ...extra,
  };
}

describe("key scope providers", () => {
  it("builds the hosted scope from the AI Gateway config, or none without it", () => {
    const { kv } = memoryKv();
    expect(hostedScopeProviders(env(kv))).toBeNull();
    expect(hostedScopeProviders(env(kv, { CF_ACCOUNT_ID: "acct", CF_GATEWAY_NAME: "gw", AI_GATEWAY_AUTH_TOKEN: "gw-token" }))).toEqual({
      openrouter: {
        baseUrl: "https://gateway.ai.cloudflare.com/v1/acct/gw/openrouter",
        headers: expect.objectContaining({ "cf-aig-authorization": "Bearer gw-token", "HTTP-Referer": "https://camelai.dev" }),
      },
    });
  });

  it("gives hosted agents the thread's gateway metadata", () => {
    const headers = hostedModelHeaders({ orgId: "o1", workspaceId: "w1", threadId: "t1" });
    expect(JSON.parse(headers["cf-aig-metadata"])).toEqual({ uid: "o1:w1:t1", chiridion: { orgId: "o1", workspaceId: "w1", threadId: "t1" } });
  });

  it("builds an org scope from its BYOK settings", async () => {
    const { kv } = memoryKv();
    const record = async (provider: string, creds: Record<string, string>, config: Record<string, string> = {}) => ({
      provider,
      credentials_encrypted: await encryptCredentials(creds, SECRET),
      config: JSON.stringify(config),
    });
    expect(await orgScopeProviders(env(kv), await record("anthropic", { api_key: "sk-ant" }))).toEqual({ anthropic: { apiKey: "sk-ant" } });
    expect(await orgScopeProviders(env(kv), await record("openrouter", { api_key: "sk-or" }))).toMatchObject({ openrouter: { apiKey: "sk-or" } });
    expect(await orgScopeProviders(env(kv), await record("bedrock", { bearer_token: "bedrock-key" }, { aws_region: "eu-west-1" })))
      .toEqual({ "amazon-bedrock": { apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com" } });
    expect(await orgScopeProviders(env(kv), await record("custom", { api_key: "k" }))).toEqual({});
    expect(await orgScopeProviders(env(kv), null)).toEqual({});
  });
});

describe("syncKeyScope", () => {
  it("puts a scope once, rotates it without emptying it, and deletes it when the key is removed", async () => {
    const { kv } = memoryKv();
    const runtime = fakeRuntime();
    const e = env(kv);

    await syncKeyScope(e, "org_1", { anthropic: { apiKey: "sk-1" } }, runtime.fetch);
    expect(runtime.calls).toEqual([{ method: "PUT", path: "/v1/key-scopes/org_1/providers/anthropic", body: { apiKey: "sk-1" }, auth: "Bearer operator" }]);

    // Unchanged: nothing sent.
    await syncKeyScope(e, "org_1", { anthropic: { apiKey: "sk-1" } }, runtime.fetch);
    expect(runtime.calls).toHaveLength(1);

    // Switched provider: the new entry first, then the old one removed.
    await syncKeyScope(e, "org_1", { openai: { apiKey: "sk-oa" } }, runtime.fetch);
    expect(runtime.calls.slice(1).map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /v1/key-scopes/org_1/providers/openai",
      "DELETE /v1/key-scopes/org_1/providers/anthropic",
    ]);

    // Removed: the whole scope goes.
    await syncKeyScope(e, "org_1", {}, runtime.fetch);
    expect(runtime.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/key-scopes/org_1" });
  });

  it("skips KV for a scope this isolate just synced, until its providers change", async () => {
    const { kv, data } = memoryKv();
    const runtime = fakeRuntime();
    const e = env(kv);
    let reads = 0;
    const get = kv.get.bind(kv);
    (kv as { get: unknown }).get = (...args: Parameters<typeof get>) => { reads += 1; return get(...args); };

    await syncKeyScope(e, "org_memo", { anthropic: { apiKey: "sk-1" } }, runtime.fetch);
    expect(reads).toBe(1);
    await syncKeyScope(e, "org_memo", { anthropic: { apiKey: "sk-1" } }, runtime.fetch);
    expect(reads).toBe(1);
    expect(runtime.calls).toHaveLength(1);

    // A changed key misses the isolate's memory and syncs as before.
    await syncKeyScope(e, "org_memo", { anthropic: { apiKey: "sk-2" } }, runtime.fetch);
    expect(reads).toBe(2);
    expect(runtime.calls).toHaveLength(2);
    expect(JSON.parse(data.get("agent_runtime_key_scope:org_memo")!)).toMatchObject({ providers: ["anthropic"] });
  });

  it("syncs an org scope from the record OrgDO hands it", async () => {
    const { kv } = memoryKv();
    const runtime = fakeRuntime();
    await syncOrgKeyScope(env(kv), "org9", {
      provider: "openai",
      credentials_encrypted: await encryptCredentials({ api_key: "sk-oa" }, SECRET),
      config: "{}",
    }, runtime.fetch);
    expect(runtime.calls).toMatchObject([{ method: "PUT", path: "/v1/key-scopes/org_org9/providers/openai", body: { apiKey: "sk-oa" } }]);
  });
});
