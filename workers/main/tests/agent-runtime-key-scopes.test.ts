import { describe, expect, it } from "vitest";

import { encryptCredentials } from "../../../src/lib/integration-crypto";
import { LLM_MODEL_OPTIONS } from "../../../src/lib/llm-provider-config";
import { PiModelMapping } from "../src/pi-model-resolution";
import { runtimeModelRoute } from "../src/agent-runtime/model-routes";
import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";
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

const record = async (provider: string, creds: Record<string, string>, config: Record<string, string> = {}) => ({
  provider,
  credentials_encrypted: await encryptCredentials(creds, SECRET),
  config: JSON.stringify(config),
});

const LUNA = { contextWindow: 1_050_000, maxOutputTokens: 128_000, input: ["text", "image"], reasoning: true, pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } };

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
    expect(await orgScopeProviders(env(kv), await record("anthropic", { api_key: "sk-ant" }))).toEqual({ providers: { anthropic: { apiKey: "sk-ant" } } });
    expect(await orgScopeProviders(env(kv), await record("openrouter", { api_key: "sk-or" }))).toMatchObject({ providers: { openrouter: { apiKey: "sk-or" } } });
    expect(await orgScopeProviders(env(kv), await record("custom", { api_key: "k" }))).toEqual({ providers: {}, modelProviders: {} });
    expect(await orgScopeProviders(env(kv), null)).toEqual({ providers: {} });
  });

  it("gives a Bedrock org its key and its OpenAI models over bedrock-mantle", async () => {
    const { kv } = memoryKv();
    expect(await orgScopeProviders(env(kv), await record("bedrock", { bearer_token: "bedrock-key" }, { aws_region: "us-west-2" }))).toEqual({
      providers: { "amazon-bedrock": { apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com" } },
      modelProviders: {
        "bedrock-openai-us-west-2": {
          type: "openai-responses",
          baseUrl: "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
          apiKey: "bedrock-key",
          headers: null,
          models: [{ id: "openai.gpt-5.6-terra", contextWindow: 272_000, maxOutputTokens: 128_000, input: ["text", "image"], reasoning: true, pricing: expect.any(Object) }],
        },
      },
    });
    // A region Bedrock serves no GPT from: its models come from the first region that does, as the in-DO loop calls them.
    const eu = await orgScopeProviders(env(kv), await record("bedrock", { bearer_token: "bedrock-key" }, { aws_region: "eu-west-1" }));
    expect(eu.providers).toEqual({ "amazon-bedrock": { apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com" } });
    expect(Object.keys(eu.modelProviders ?? {})).toEqual(["bedrock-openai-us-east-1"]);
    // The route of a thread on Bedrock GPT names that provider's model.
    const { modelId, baseUrl } = new PiModelMapping().bedrockOpenAiModelConfig("gpt-5.6-terra", "eu-west-1")!;
    const route = runtimeModelRoute({
      apiKey: "bedrock-key", billingSource: "byok", creditChargeable: false, usageProvider: "bedrock", provider: "openai", modelId: "gpt-5.6-terra",
      model: { provider: "custom", api: "openai-responses", id: modelId, baseUrl },
    } as unknown as PiResolvedModelConfig, { orgId: "o" });
    expect(route).toEqual({ kind: "scope", model: "bedrock-openai-us-east-1/openai.gpt-5.6-terra", keyScope: "org_o" });
  });

  it("gives a custom endpoint with its own model id one model, looked up as the in-DO loop does", async () => {
    const { kv } = memoryKv();
    const custom = (api: string, extra: Record<string, string> = {}) =>
      record("custom", { api_key: "sk-acme" }, { custom_api: api, custom_base_url: "https://llm.acme.example/v1", custom_model_id: "acme-70b", ...extra });

    expect(await orgScopeProviders(env(kv), await custom("openai-completions"))).toEqual({
      providers: {},
      modelProviders: {
        custom: {
          type: "openai-completions",
          baseUrl: "https://llm.acme.example/v1",
          apiKey: "sk-acme",
          headers: null,
          models: [{ id: "acme-70b", ...LUNA }],
        },
      },
    });
    expect((await orgScopeProviders(env(kv), await custom("openai-responses"))).modelProviders?.custom)
      .toMatchObject({ type: "openai-responses", apiKey: "sk-acme", models: [{ id: "acme-70b", ...LUNA }] });
    // An OpenAI endpoint that takes x-api-key: that header, and no Authorization.
    expect((await orgScopeProviders(env(kv), await custom("openai-completions", { custom_auth_type: "x-api-key" }))).modelProviders?.custom)
      .toMatchObject({ apiKey: null, headers: { "x-api-key": "sk-acme" } });
    // Anthropic Messages with x-api-key, looked up as Sonnet.
    expect((await orgScopeProviders(env(kv), await custom("anthropic-messages", { custom_auth_type: "x-api-key" }))).modelProviders?.custom).toEqual({
      type: "anthropic-messages",
      baseUrl: "https://llm.acme.example/v1",
      apiKey: "sk-acme",
      headers: null,
      models: [{ id: "acme-70b", contextWindow: 1_000_000, maxOutputTokens: 128_000, input: ["text", "image"], reasoning: true, pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }],
    });
  });

  it("has no model provider for a custom endpoint the runtime cannot call", async () => {
    const { kv } = memoryKv();
    const custom = (extra: Record<string, string>) =>
      record("custom", { api_key: "sk-acme" }, { custom_api: "openai-completions", custom_base_url: "https://llm.acme.example/v1", ...extra });
    expect(await orgScopeProviders(env(kv), await custom({ custom_base_url: "http://llm.acme.example/v1" }))).toEqual({ providers: {}, modelProviders: {} });
    expect(await orgScopeProviders(env(kv), await custom({ custom_api: "anthropic-messages" }))).toEqual({ providers: {}, modelProviders: {} });
    expect(await orgScopeProviders(env(kv), await custom({ custom_model_id: "acme 70b" }))).toEqual({ providers: {}, modelProviders: {} });
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
    "declares every model a thread on a custom %s endpoint can send",
    async (api) => {
      const { kv } = memoryKv();
      const scope = await orgScopeProviders(env(kv), await record("custom", { api_key: "sk-acme" }, {
        custom_api: api, custom_base_url: "https://llm.acme.example", custom_auth_type: "x-api-key",
      }));
      const declared = scope.modelProviders?.custom?.models.map((model) => model.id) ?? [];
      const mapping = new PiModelMapping();
      // Whatever model a thread has, the in-DO loop sends one of these ids to the endpoint.
      for (const { value } of LLM_MODEL_OPTIONS) {
        if (mapping.resolvePiModelReference(value).byokAllowed === false) continue;
        expect(declared).toContain(mapping.resolveCustomProviderModelReference(api, value, undefined).requestModelId);
      }
      expect(declared).toContain(api === "anthropic-messages" ? "claude-sonnet-5-5" : "gpt-6-luna");
    },
  );
});

describe("syncKeyScope", () => {
  it("puts a scope once, rotates it without emptying it, and deletes it when the key is removed", async () => {
    const { kv } = memoryKv();
    const runtime = fakeRuntime();
    const e = env(kv);

    await syncKeyScope(e, "org_1", { providers: { anthropic: { apiKey: "sk-1" } } }, runtime.fetch);
    expect(runtime.calls).toEqual([{ method: "PUT", path: "/v1/key-scopes/org_1/providers/anthropic", body: { apiKey: "sk-1" }, auth: "Bearer operator" }]);

    // Unchanged: nothing sent.
    await syncKeyScope(e, "org_1", { providers: { anthropic: { apiKey: "sk-1" } } }, runtime.fetch);
    expect(runtime.calls).toHaveLength(1);

    // Switched provider: the new entry first, then the old one removed.
    await syncKeyScope(e, "org_1", { providers: { openai: { apiKey: "sk-oa" } } }, runtime.fetch);
    expect(runtime.calls.slice(1).map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /v1/key-scopes/org_1/providers/openai",
      "DELETE /v1/key-scopes/org_1/providers/anthropic",
    ]);

    // Removed: the whole scope goes.
    await syncKeyScope(e, "org_1", { providers: {} }, runtime.fetch);
    expect(runtime.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/v1/key-scopes/org_1" });
  });

  it("puts model providers, skips them unchanged, and deletes them when no longer configured", async () => {
    const { kv, data } = memoryKv();
    const runtime = fakeRuntime();
    const e = env(kv);
    const custom = (baseUrl: string) => ({
      type: "openai-completions" as const, baseUrl, apiKey: "sk-acme", headers: null,
      models: [{ id: "acme-70b", contextWindow: 131_072 }],
    });

    await syncKeyScope(e, "org_mp", { providers: {}, modelProviders: { custom: custom("https://a.example/v1") } }, runtime.fetch);
    expect(runtime.calls).toEqual([{
      method: "PUT", path: "/v1/key-scopes/org_mp/model-providers/custom", body: custom("https://a.example/v1"), auth: "Bearer operator",
    }]);
    expect(JSON.parse(data.get("agent_runtime_key_scope:org_mp")!)).toMatchObject({ providers: [], modelProviders: ["custom"] });

    // Unchanged: nothing sent.
    await syncKeyScope(e, "org_mp", { providers: {}, modelProviders: { custom: custom("https://a.example/v1") } }, runtime.fetch);
    expect(runtime.calls).toHaveLength(1);

    // A new address is a changed fingerprint: put again.
    await syncKeyScope(e, "org_mp", { providers: {}, modelProviders: { custom: custom("https://b.example/v1") } }, runtime.fetch);
    expect(runtime.calls.slice(1).map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /v1/key-scopes/org_mp/model-providers/custom"]);

    // Moved to Anthropic: its key first, then the custom endpoint removed.
    await syncKeyScope(e, "org_mp", { providers: { anthropic: { apiKey: "sk-ant" } }, modelProviders: {} }, runtime.fetch);
    expect(runtime.calls.slice(2).map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /v1/key-scopes/org_mp/providers/anthropic",
      "DELETE /v1/key-scopes/org_mp/model-providers/custom",
    ]);
    expect(JSON.parse(data.get("agent_runtime_key_scope:org_mp")!)).toEqual({ fingerprint: expect.any(String), providers: ["anthropic"] });
  });

  it("prints a scope of keys only as before model providers, so existing scopes do not resync", async () => {
    const { kv, data } = memoryKv();
    const runtime = fakeRuntime();
    await syncKeyScope(env(kv), "org_same", { providers: { anthropic: { apiKey: "sk-1" } } }, runtime.fetch);
    const withEmpty = memoryKv();
    await syncKeyScope(env(withEmpty.kv), "org_same_empty", { providers: { anthropic: { apiKey: "sk-1" } }, modelProviders: {} }, runtime.fetch);
    expect(JSON.parse(withEmpty.data.get("agent_runtime_key_scope:org_same_empty")!).fingerprint)
      .toBe(JSON.parse(data.get("agent_runtime_key_scope:org_same")!).fingerprint);
  });

  it("skips KV for a scope this isolate just synced, until its providers change", async () => {
    const { kv, data } = memoryKv();
    const runtime = fakeRuntime();
    const e = env(kv);
    let reads = 0;
    const get = kv.get.bind(kv);
    (kv as { get: unknown }).get = (...args: Parameters<typeof get>) => { reads += 1; return get(...args); };

    await syncKeyScope(e, "org_memo", { providers: { anthropic: { apiKey: "sk-1" } } }, runtime.fetch);
    expect(reads).toBe(1);
    await syncKeyScope(e, "org_memo", { providers: { anthropic: { apiKey: "sk-1" } } }, runtime.fetch);
    expect(reads).toBe(1);
    expect(runtime.calls).toHaveLength(1);

    // A changed key misses the isolate's memory and syncs as before.
    await syncKeyScope(e, "org_memo", { providers: { anthropic: { apiKey: "sk-2" } } }, runtime.fetch);
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

  it("syncs a Bedrock org's key and its OpenAI model provider", async () => {
    const { kv } = memoryKv();
    const runtime = fakeRuntime();
    await syncOrgKeyScope(env(kv), "org10", await record("bedrock", { bearer_token: "bedrock-key" }, { aws_region: "us-east-2" }), runtime.fetch);
    expect(runtime.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /v1/key-scopes/org_org10/providers/amazon-bedrock",
      "PUT /v1/key-scopes/org_org10/model-providers/bedrock-openai-us-east-2",
    ]);
    expect(runtime.calls[1].body).toMatchObject({ type: "openai-responses", baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1", apiKey: "bedrock-key" });
  });
});
