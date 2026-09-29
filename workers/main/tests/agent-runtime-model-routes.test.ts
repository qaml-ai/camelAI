import { describe, expect, it } from "vitest";

import { runtimeModelRoute } from "../src/agent-runtime/model-routes";
import { PiModelMapping } from "../src/pi-model-resolution";
import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CODEX_TOKEN = `${b64url({})}.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })}.sig`;

function config(overrides: { model: Record<string, unknown>; billingSource?: "hosted" | "byok"; usageProvider: string; apiKey?: string }): PiResolvedModelConfig {
  return {
    apiKey: overrides.apiKey ?? "key",
    billingSource: overrides.billingSource ?? "byok",
    creditChargeable: overrides.billingSource === "hosted",
    usageProvider: overrides.usageProvider,
    provider: "anthropic",
    modelId: "m",
    model: overrides.model,
  } as unknown as PiResolvedModelConfig;
}

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/acct/gw";
const org = { orgId: "org1" };

describe("runtimeModelRoute", () => {
  it("runs hosted models with the hosted key scope and their OpenRouter id", () => {
    expect(runtimeModelRoute(config({
      billingSource: "hosted", usageProvider: "openrouter",
      model: { provider: "cloudflare-ai-gateway", id: "anthropic/claude-sonnet-5.5:nitro", baseUrl: `${GATEWAY}/openrouter` },
    }), org)).toEqual({ kind: "scope", model: "openrouter/anthropic/claude-sonnet-5.5:nitro", keyScope: "hosted" });
  });

  it.each([
    ["sonnet", "openrouter/anthropic/claude-sonnet-5.5:nitro"],
    ["opus-5.5", "openrouter/anthropic/claude-opus-5.5"],
    ["fable-5.1", "openrouter/anthropic/claude-fable-5.1:nitro"],
    ["haiku", "openrouter/anthropic/claude-sonnet-5.5:nitro"],
    ["gpt-6-sol", "openrouter/openai/gpt-6-sol:nitro"],
    ["gpt-6-luna", "openrouter/openai/gpt-6-luna"],
    ["gemini-3.8-flash", "openrouter/google/gemini-3.8-flash"],
    ["deepseek-v4.1-flash", "openrouter/deepseek/deepseek-v4.1-flash"],
    ["kimi-k3", "openrouter/moonshotai/kimi-k3:nitro"],
    ["grok-4.7", "openrouter/x-ai/grok-4.7:nitro"],
    ["glm-5.3", "openrouter/z-ai/glm-5.3:nitro"],
    ["glm-5.3-flash", "openrouter/z-ai/glm-5.3-flash:nitro"],
  ])("runs hosted %s on the runtime as %s", (threadModel, runtimeModel) => {
    const { hostedModelId } = new PiModelMapping().resolvePiModelReference(threadModel);
    expect(runtimeModelRoute(config({
      billingSource: "hosted", usageProvider: "openrouter",
      model: { provider: "cloudflare-ai-gateway", id: hostedModelId, baseUrl: `${GATEWAY}/openrouter` },
    }), org)).toEqual({ kind: "scope", model: runtimeModel, keyScope: "hosted" });
  });

  it("runs the free tier as GPT-6 Luna, and no other dynamic route", () => {
    const free = config({ billingSource: "hosted", usageProvider: "compat", model: { provider: "cloudflare-ai-gateway", id: "dynamic/luna-muse-fallback", baseUrl: `${GATEWAY}/compat` } });
    expect(runtimeModelRoute(free, { ...org, freeTier: true })).toEqual({ kind: "scope", model: "openrouter/openai/gpt-6-luna", keyScope: "hosted" });
    expect(runtimeModelRoute(free, org)).toBeNull();
  });

  it("runs BYOK models with the org's key scope", () => {
    const scope = "org_org1";
    expect(runtimeModelRoute(config({ usageProvider: "anthropic", model: { provider: "anthropic", id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" } }), org))
      .toEqual({ kind: "scope", model: "anthropic/claude-opus-5-5", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "openai", model: { provider: "openai", id: "gpt-6-sol", baseUrl: "https://api.openai.com/v1" } }), org))
      .toEqual({ kind: "scope", model: "openai/gpt-6-sol", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "openrouter", model: { provider: "anthropic", id: "anthropic/claude-sonnet-5.5:nitro", baseUrl: "https://openrouter.ai/api" } }), org))
      .toEqual({ kind: "scope", model: "openrouter/anthropic/claude-sonnet-5.5:nitro", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "anthropic-messages", id: "anthropic.claude-sonnet-5-5", baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/anthropic" } }), org))
      .toEqual({ kind: "scope", model: "amazon-bedrock/global.anthropic.claude-sonnet-5-5", keyScope: scope });
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "anthropic-messages", id: "anthropic.claude-opus-5-5", baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/anthropic" } }), org))
      .toEqual({ kind: "scope", model: "amazon-bedrock/eu.anthropic.claude-opus-5-5", keyScope: scope });
  });

  // Each id is one the runtime's catalog (Pi 0.87.1) lists and Bedrock serves in that region (2026-09-28).
  it.each([
    ["us-east-1", "anthropic.claude-opus-5-5", "us.anthropic.claude-opus-5-5"],
    ["us-west-2", "anthropic.claude-fable-5-1", "us.anthropic.claude-fable-5-1"],
    ["us-east-1", "anthropic.claude-haiku-4-5", "us.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["eu-west-1", "anthropic.claude-opus-5-5", "eu.anthropic.claude-opus-5-5"],
    ["eu-central-1", "anthropic.claude-haiku-4-5", "eu.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["eu-west-1", "anthropic.claude-fable-5-1", "global.anthropic.claude-fable-5-1"],
    ["ap-northeast-1", "anthropic.claude-opus-5-5", "jp.anthropic.claude-opus-5-5"],
    ["ap-northeast-3", "anthropic.claude-haiku-4-5", "jp.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["ap-northeast-1", "anthropic.claude-fable-5-1", "global.anthropic.claude-fable-5-1"],
    ["ap-southeast-2", "anthropic.claude-opus-5-5", "au.anthropic.claude-opus-5-5"],
    ["ap-southeast-4", "anthropic.claude-haiku-4-5", "au.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["ap-southeast-1", "anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5-5"],
    ["ap-south-1", "anthropic.claude-haiku-4-5", "global.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ["ap-northeast-1", "anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-5-5"],
    ["sa-east-1", "anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5-5"],
  ])("runs Bedrock in %s: %s as %s", (region, id, profile) => {
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "anthropic-messages", id, baseUrl: `https://bedrock-mantle.${region}.api.aws/anthropic` } }), org))
      .toEqual({ kind: "scope", model: `amazon-bedrock/${profile}`, keyScope: "org_org1" });
  });

  it("sends the ChatGPT subscription through chiridion's Codex forwarder", () => {
    expect(runtimeModelRoute(config({ usageProvider: "openai", apiKey: CODEX_TOKEN, model: { provider: "openai-codex", id: "gpt-6-luna", baseUrl: "https://chatgpt.com/backend-api/codex" } }), org))
      .toEqual({ kind: "codex", model: "chiridion/openai-codex/gpt-6-luna" });
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"])("runs a custom %s endpoint as the org scope's custom provider", (api) => {
    const custom = (headers?: Record<string, string | null>) => ({
      ...config({ usageProvider: "custom", model: { provider: "custom", api, id: "acme-70b", baseUrl: "https://llm.acme.example/v1" } }),
      headers,
    }) as PiResolvedModelConfig;
    expect(runtimeModelRoute(custom(), org)).toEqual({ kind: "scope", model: "custom/acme-70b", keyScope: "org_org1" });
    // Anthropic Messages behind Authorization: Bearer (the provider's `auth: "bearer"`).
    if (api === "anthropic-messages") {
      expect(runtimeModelRoute(custom({ "x-api-key": null, Authorization: "Bearer key" }), org)).toEqual({ kind: "scope", model: "custom/acme-70b", keyScope: "org_org1" });
    }
    // An OpenAI endpoint that takes x-api-key gets it as a header.
    if (api !== "anthropic-messages") {
      expect(runtimeModelRoute(custom({ Authorization: null, "x-api-key": "key" }), org)).toEqual({ kind: "scope", model: "custom/acme-70b", keyScope: "org_org1" });
    }
  });

  it("keeps custom endpoints the runtime cannot call on the in-DO loop", () => {
    const custom = (model: Record<string, unknown>, headers?: Record<string, string | null>) => ({
      ...config({ usageProvider: "custom", model: { provider: "custom", api: "openai-completions", id: "acme-70b", baseUrl: "https://llm.acme.example/v1", ...model } }),
      headers,
    }) as PiResolvedModelConfig;
    // Not https.
    expect(runtimeModelRoute(custom({ baseUrl: "http://llm.acme.example/v1" }), org)).toBeNull();
    // A model id the runtime refuses.
    expect(runtimeModelRoute(custom({ id: "acme 70b" }), org)).toBeNull();
    // Without a key, or not BYOK.
    expect(runtimeModelRoute(config({ usageProvider: "custom", apiKey: "", model: { provider: "custom", api: "openai-completions", id: "m", baseUrl: "https://llm.acme.example/v1" } }), org)).toBeNull();
    expect(runtimeModelRoute(config({ billingSource: "hosted", usageProvider: "custom", model: { provider: "custom", api: "openai-completions", id: "m", baseUrl: "https://llm.acme.example/v1" } }), org)).toBeNull();
  });

  it("runs Bedrock's OpenAI models as the org scope's provider for their bedrock-mantle region", () => {
    const { modelId, baseUrl } = new PiModelMapping().bedrockOpenAiModelConfig("gpt-5.6-terra", "us-west-2")!;
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "openai-responses", id: modelId, baseUrl } }), org))
      .toEqual({ kind: "scope", model: "bedrock-openai-us-west-2/openai.gpt-5.6-terra", keyScope: "org_org1" });
    // Not BYOK (no key): no route.
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", apiKey: "", model: { provider: "custom", api: "openai-responses", id: modelId, baseUrl } }), org)).toBeNull();
    // Another address (the E2E replay stub): no route.
    expect(runtimeModelRoute(config({ usageProvider: "bedrock", model: { provider: "custom", api: "openai-responses", id: modelId, baseUrl: "http://127.0.0.1:8788" } }), org)).toBeNull();
  });
});
