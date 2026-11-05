import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildGenerateImageMessages,
  generateImage,
  parseGenerateImageResponse,
} from "../src/generate-image.js";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  appendNitro,
  executeVirtualAiRun,
  extractModelFromInput,
  normalizeLegacyModel,
  resolveGatewaySettings,
  resolveRouting,
  resolveSelfhostBedrockModel,
  runViaGatewayHTTP,
  toSelfhostBedrockInput,
  type AIVirtualBindingEnv,
  type VirtualAiRunScope,
} from "../src/ai-virtual-binding.js";
import {
  BedrockPiCompletionError,
  buildBedrockPiModel,
  chatCompletionToPiCall,
  piMessageToChatCompletion,
} from "../src/bedrock-pi-adapter.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function bedrockMessagesSseBody(): string {
  // A whole Anthropic Messages stream: Pi fails streams without a stop reason.
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "anthropic.claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function virtualAiTestScope(envOverrides: Partial<AIVirtualBindingEnv> = {}) {
  const orgStub = {
    getLlmProviderConfig: vi.fn<() => Promise<{
      provider: string;
      config: string;
      credentials_encrypted: string;
    } | null>>(async () => null),
    getInfo: vi.fn(async () => ({
      billing_status: "active",
      billing_plan: "payg",
      billing_credit_purchase_total_cents: 1_000,
      billing_credit_grant_total_cents: 0,
    })),
    getCreditChargeableSpendUsd: vi.fn(async () => 0),
    checkUserLlmUsageAccess: vi.fn(async () => ({
      allowed: true,
      reason: "no_limits" as const,
      evaluated_at_ms: Date.now(),
      blocking_limit: null,
      limits: [],
    })),
    recordUsage: vi.fn(async () => undefined),
  };
  const backgroundTasks: Promise<unknown>[] = [];
  const scope: VirtualAiRunScope = {
    env: {
      CF_ACCOUNT_ID: "acct",
      CF_GATEWAY_NAME: "gateway",
      CF_GATEWAY_TOKEN: "hosted-token",
      INTEGRATION_SECRET_KEY: "secret",
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      } as never,
      ...envOverrides,
    },
    props: { orgId: "org1", workspaceId: "ws1", userId: "user1" },
    waitUntil: vi.fn((task: Promise<unknown>) => { backgroundTasks.push(task); }),
  };
  return { scope, orgStub, backgroundTasks };
}

describe("resolveSelfhostBedrockModel", () => {
  it.each([
    ["cheap", "anthropic.claude-sonnet-5-5"],
    ["fast", "anthropic.claude-sonnet-5-5"],
    ["auto", "anthropic.claude-sonnet-5-5"],
    ["smart", "anthropic.claude-opus-5-5"],
    ["anthropic/claude-opus-5.5", "anthropic.claude-opus-5-5"],
    ["claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
    ["anthropic.claude-haiku-5-5", "anthropic.claude-haiku-5-5"],
    ["global.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5"],
    ["us.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"],
    ["anthropic/claude-fable-5.1", "anthropic.claude-fable-5-1"],
    ["anthropic/claude-3.5-sonnet", "anthropic.claude-sonnet-5-5"],
    ["anthropic/claude-haiku-4.5", "anthropic.claude-haiku-4-5"],
    ["anthropic.claude-haiku-4-5", "anthropic.claude-haiku-4-5"],
    ["claude-haiku-4-5-20251001", "anthropic.claude-haiku-4-5"],
    ["claude-unknown", "anthropic.claude-sonnet-5-5"],
  ])("maps %s to %s", (model, expected) => {
    expect(resolveSelfhostBedrockModel(model)).toBe(expected);
  });

  it.each([
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "@cf/openai/gpt-oss-120b",
    "openai/gpt-5.6-luna",
    "deepseek-v4-pro",
    "deepseek-v4-auto",
    "google/gemini-3.8-flash",
    "moonshotai/kimi-k3",
    "",
  ])("maps %s to the default auto model", (model) => {
    expect(resolveSelfhostBedrockModel(model)).toBe("anthropic.claude-sonnet-5-5");
  });

  it.each([
    "@cf/black-forest-labs/flux-1-schnell",
    "@cf/myshell-ai/melotts",
    "@cf/deepgram/aura-1",
    "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    "@cf/runwayml/model",
    "@cf/bytedance/model",
    "@cf/lykon/model",
    "@cf/leonardo/model",
    "google/gemini-3.8-flash-image",
    "openai/gpt-image-1",
    "openai/dall-e-3",
    "other/stable-diffusion",
    "@CF/BLACK-FOREST-LABS/FLUX-1-SCHNELL",
  ])("rejects non-text model %s with an actionable error", (model) => {
    expect(() => resolveSelfhostBedrockModel(model)).toThrow(new Error(
      `Model "${model}" isn't available through env.AI on this install. Its AI provider is AWS Bedrock, which serves text generation here (chat messages or a text prompt), and this model makes images, audio or other non-text output.`,
    ));
  });
});

describe("toSelfhostBedrockInput", () => {
  it("keeps messages and tool options unchanged", () => {
    const input = {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
      tool_choice: "auto",
      prompt: "ignored because messages win",
    };
    expect(toSelfhostBedrockInput("auto", input)).toBe(input);
  });

  it("converts a prompt while preserving generation options", () => {
    expect(toSelfhostBedrockInput("auto", {
      prompt: "Say ok",
      messages: [],
      stream: true,
      max_tokens: 10,
      temperature: 0.5,
    })).toEqual({
      messages: [{ role: "user", content: "Say ok" }],
      stream: true,
      max_tokens: 10,
      temperature: 0.5,
    });
  });

  it.each([
    null, undefined, "Say ok", 42, [], new Date(), {},
    { messages: [] }, { messages: "hello" }, { prompt: "" },
    { text: ["a"] }, { prompt: "x", image: [1, 2] },
    { messages: [{ role: "user", content: "x" }], audio: undefined },
    { prompt: "x", mask: [] },
  ].map((input) => ({ input })))("rejects unsupported input $input", ({ input }) => {
    expect(() => toSelfhostBedrockInput("requested-model", input)).toThrow(new Error(
      'env.AI.run("requested-model") needs chat "messages" or a text "prompt" on this install. Its AI provider is AWS Bedrock, which serves text generation here; image, audio, embedding and other non-text inputs aren\'t supported.',
    ));
  });
});

describe("self-host install Bedrock virtual AI", () => {
  afterEach(() => vi.restoreAllMocks());

  function selfhostScope(overrides: Partial<AIVirtualBindingEnv> = {}) {
    return virtualAiTestScope({
      CF_ACCOUNT_ID: "selfhost",
      CF_DISPATCH_NAMESPACE: "selfhost",
      CF_GATEWAY_NAME: undefined,
      CF_GATEWAY_TOKEN: undefined,
      SELFHOST_AI_PROVIDER: "bedrock",
      SELFHOST_AI_API_KEY: "install-bedrock-key",
      SELFHOST_AI_AWS_REGION: "us-west-2",
      ...overrides,
    });
  }

  function mockBedrockFetch() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(bedrockMessagesSseBody(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
  }

  it.each([
    ["auto", "anthropic.claude-sonnet-5-5"],
    ["opus", "anthropic.claude-opus-5-5"],
  ])("routes %s through the install without reading stored org credentials", async (model, expected) => {
    const { scope, orgStub } = selfhostScope();
    orgStub.getLlmProviderConfig.mockResolvedValue({
      provider: "bedrock",
      config: JSON.stringify({ aws_region: "eu-west-1" }),
      credentials_encrypted: await encryptCredentials({ bearer_token: "org-key" }, "secret"),
    });
    expect(await resolveRouting(scope, model)).toEqual({
      provider: "bedrock",
      gatewayProvider: "compat",
      model: expected,
      byokKey: "install-bedrock-key",
      awsRegion: "us-west-2",
      installProvider: true,
    });
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
  });

  it("defaults the install's region to us-east-1", async () => {
    const { scope } = selfhostScope({ SELFHOST_AI_AWS_REGION: undefined });
    expect(await resolveRouting(scope, "auto")).toMatchObject({ awsRegion: "us-east-1" });
  });

  it("serves messages with the install key and records BYOK usage without credits or a gateway", async () => {
    const fetchMock = mockBedrockFetch();
    const { scope, orgStub, backgroundTasks } = selfhostScope();
    const result = await executeVirtualAiRun(scope, "auto", {
      messages: [{ role: "user", content: "Say ok" }],
    });
    expect(result).toMatchObject({
      model: "anthropic.claude-sonnet-5-5",
      choices: [{ message: { content: "ok" } }],
      response: "ok",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstream = new URL(url);
    expect(`${upstream.origin}${upstream.pathname}`).toBe(
      "https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages",
    );
    expect(new Headers(init.headers).get("x-api-key")).toBe("install-bedrock-key");
    expect(JSON.parse(String(init.body)).model).toBe("anthropic.claude-sonnet-5-5");
    expect(scope.waitUntil).toHaveBeenCalledOnce();
    await Promise.all(backgroundTasks);
    expect(orgStub.recordUsage).toHaveBeenCalledOnce();
    expect(orgStub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "bedrock",
      billing_source: "byok",
      credit_chargeable: false,
      usage_surface: "virtual_ai",
      user_id: "user1",
      input_tokens: 3,
      output_tokens: 1,
    }));
    expect(orgStub.checkUserLlmUsageAccess).toHaveBeenCalledOnce();
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
    expect(orgStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getCreditChargeableSpendUsd).not.toHaveBeenCalled();
  });

  it("converts a Workers AI prompt to a Bedrock user message", async () => {
    const fetchMock = mockBedrockFetch();
    const { scope, backgroundTasks } = selfhostScope();
    const result = await executeVirtualAiRun(scope, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      prompt: "Say ok",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "anthropic.claude-sonnet-5-5",
      messages: [{ role: "user", content: [{ type: "text", text: "Say ok" }] }],
    });
    expect(result).toMatchObject({ response: "ok" });
    await Promise.all(backgroundTasks);
  });

  it("streams OpenAI deltas without response fields and records usage after consumption", async () => {
    mockBedrockFetch();
    const { scope, orgStub, backgroundTasks } = selfhostScope();
    const result = await executeVirtualAiRun(scope, "auto", {
      messages: [{ role: "user", content: "Say ok" }],
      stream: true,
    });
    expect(result).toBeInstanceOf(ReadableStream);
    const body = await new Response(result as ReadableStream<Uint8Array>).text();
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    const chunks = body.split("\n\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk).not.toHaveProperty("response");
    }
    expect(chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? "").join("")).toBe("ok");
    expect(scope.waitUntil).toHaveBeenCalledOnce();
    await Promise.all(backgroundTasks);
    expect(orgStub.recordUsage).toHaveBeenCalledOnce();
    expect(orgStub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "bedrock", billing_source: "byok", credit_chargeable: false,
      usage_surface: "virtual_ai", input_tokens: 3, output_tokens: 1,
    }));
  });

  it.each([null, ""])("leaves completions with %j content unchanged", async (content) => {
    const { scope } = selfhostScope();
    const result = { choices: [{ message: { content, tool_calls: [] } }] };
    scope.runBedrock = vi.fn(async () => result);
    expect(await executeVirtualAiRun(scope, "auto", { prompt: "hello" })).toBe(result);
    expect(result).not.toHaveProperty("response");
  });

  it.each([
    ["@cf/baai/bge-base-en-v1.5", { text: ["a"] }],
    ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", { prompt: "x", image: [1, 2] }],
  ])("rejects unsupported input for %s before fetching", async (model, input) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { scope, orgStub } = selfhostScope();
    await expect(executeVirtualAiRun(scope, model, input)).rejects.toThrow(new Error(
      `env.AI.run("${model}") needs chat "messages" or a text "prompt" on this install. Its AI provider is AWS Bedrock, which serves text generation here; image, audio, embedding and other non-text inputs aren't supported.`,
    ));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(orgStub.checkUserLlmUsageAccess).not.toHaveBeenCalled();
  });

  it("rejects non-text models before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { scope } = selfhostScope();
    await expect(executeVirtualAiRun(scope, "google/gemini-3.8-flash-image", { prompt: "x" })).rejects.toThrow(new Error(
      'Model "google/gemini-3.8-flash-image" isn\'t available through env.AI on this install. Its AI provider is AWS Bedrock, which serves text generation here (chat messages or a text prompt), and this model makes images, audio or other non-text output.',
    ));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["auto_image", "dynamic/auto_image"])("explains unavailable %s without a gateway", async (model) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { scope } = selfhostScope();
    await expect(executeVirtualAiRun(scope, model, { prompt: "x" })).rejects.toThrow(new Error(
      "Image generation isn't available on this install yet. Its AI provider is AWS Bedrock, which serves text generation through env.AI.",
    ));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps auto_image on the gateway when configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ response: "image" }));
    const { scope, orgStub } = selfhostScope({ CF_GATEWAY_NAME: "gateway", CF_GATEWAY_TOKEN: "hosted-token" });
    expect(await executeVirtualAiRun(scope, "auto_image", { prompt: "x" })).toEqual({ response: "image" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/selfhost/gateway/compat/chat/completions");
    expect(JSON.parse(String(init.body)).model).toBe("dynamic/auto_image");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer hosted-token");
    expect(orgStub.getInfo).toHaveBeenCalledOnce();
  });

  it("surfaces the install configuration error before fetching or reading org keys", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { scope, orgStub } = selfhostScope({ SELFHOST_AI_API_KEY: "" });
    await expect(executeVirtualAiRun(scope, "auto", { prompt: "x" })).rejects.toThrow(new Error(
      "SELFHOST_AI_API_KEY is required for the configured self-host AI provider.",
    ));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
  });
});

describe("hosted virtual AI is unchanged by self-host Bedrock support", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "auto", "smart", "cheap", "deepseek-v4-auto", "deepseek-v4-pro",
    "anthropic/claude-opus-5.5", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "openai/gpt-5.6-luna",
  ])("keeps hosted routing identical for %s even with SELFHOST_AI vars", async (model) => {
    const { scope, orgStub } = virtualAiTestScope();
    const expected = await resolveRouting(scope, model);
    const actual = await resolveRouting({
      ...scope,
      env: { ...scope.env, SELFHOST_AI_PROVIDER: "bedrock", SELFHOST_AI_API_KEY: "install-key" },
    }, model);
    expect(actual).toEqual(expected);
    expect(actual).not.toHaveProperty("installProvider");
    expect(expected).not.toHaveProperty("installProvider");
    expect(orgStub.getLlmProviderConfig).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["cheap", "anthropic.claude-sonnet-5-5"],
    ["fast", "anthropic.claude-sonnet-5-5"],
    ["auto", "anthropic.claude-sonnet-5-5"],
    ["smart", "anthropic.claude-opus-5-5"],
  ])("keeps hosted Bedrock BYOK %s on the org's key and region", async (model, expected) => {
    const { scope, orgStub } = virtualAiTestScope({ SELFHOST_AI_PROVIDER: "bedrock", SELFHOST_AI_API_KEY: "ignored-install-key" });
    orgStub.getLlmProviderConfig.mockResolvedValue({
      provider: "bedrock",
      config: JSON.stringify({ aws_region: "eu-west-1" }),
      credentials_encrypted: await encryptCredentials({ bearer_token: "org-bedrock-key" }, "secret"),
    });
    expect(await resolveRouting(scope, model)).toEqual({
      provider: "bedrock", gatewayProvider: "compat", model: expected,
      byokKey: "org-bedrock-key", awsRegion: "eu-west-1",
    });
    expect(orgStub.getLlmProviderConfig).toHaveBeenCalledOnce();
  });

  it("still sends hosted auto to AI Gateway with the hosted token and credit check", async () => {
    const completion = {
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(completion));
    const { scope, orgStub, backgroundTasks } = virtualAiTestScope();
    expect(await executeVirtualAiRun(scope, "auto", {
      messages: [{ role: "user", content: "Say ok" }],
    })).toEqual(completion);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gateway/openrouter/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer hosted-token");
    expect(orgStub.getInfo).toHaveBeenCalledOnce();
    expect(orgStub.getCreditChargeableSpendUsd).toHaveBeenCalledOnce();
    await Promise.all(backgroundTasks);
    expect(orgStub.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      provider: "openrouter", billing_source: "hosted", credit_chargeable: true,
    }));
  });

  it.each([
    { SELFHOST_AI_PROVIDER: "openai", SELFHOST_AI_API_KEY: "openai-key" },
    { SELFHOST_AI_PROVIDER: "openai", SELFHOST_AI_API_KEY: "" },
    { SELFHOST_AI_API_KEY: "partial-config-key" },
    {},
  ])("keeps self-host non-Bedrock or unset providers on today's path: %j", async (providerEnv) => {
    const { scope, orgStub } = virtualAiTestScope({
      CF_ACCOUNT_ID: "selfhost", CF_DISPATCH_NAMESPACE: "selfhost", ...providerEnv,
    });
    expect(await resolveRouting(scope, "auto")).toEqual({
      provider: "openrouter", gatewayProvider: "openrouter", model: "openai/gpt-6-luna",
      byokKey: undefined, awsRegion: undefined,
    });
    expect(orgStub.getLlmProviderConfig).toHaveBeenCalledOnce();
  });
});

describe("buildBedrockPiModel", () => {
  it("uses the suffix-free Opus 5.5 Mantle model with adaptive-thinking metadata", () => {
    expect(
      buildBedrockPiModel("global.anthropic.claude-opus-5-5", "us-west-2"),
    ).toMatchObject({
      id: "anthropic.claude-opus-5-5",
      name: "Claude Opus 5.5",
      api: "anthropic-messages",
      provider: "custom",
      baseUrl: "https://bedrock-mantle.us-west-2.api.aws/anthropic",
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsEagerToolInputStreaming: false,
      },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
  });

  it("upgrades legacy Opus Mantle IDs to Opus 5.5", () => {
    expect(buildBedrockPiModel("anthropic.claude-opus-4-8").id).toBe(
      "anthropic.claude-opus-5-5",
    );
    expect(buildBedrockPiModel("anthropic.claude-opus-5").id).toBe(
      "anthropic.claude-opus-5-5",
    );
  });

  it("upgrades Fable Mantle IDs to Fable 5.1", () => {
    expect(buildBedrockPiModel("anthropic.claude-fable-5")).toMatchObject({
      id: "anthropic.claude-fable-5-1",
      name: "Claude Fable 5.1",
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    });
  });

  it("knows Haiku 5.5 as Pi's catalog has it", () => {
    for (const id of ["anthropic.claude-haiku-5-5", "global.anthropic.claude-haiku-5-5", "claude-haiku-5-5"]) {
      expect(buildBedrockPiModel(id, "eu-west-1")).toMatchObject({
        id: "anthropic.claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/anthropic",
        thinkingLevelMap: { off: null, minimal: null },
        cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
    }
  });
});

describe("resolveGatewaySettings", () => {
  it("returns gateway settings from required env vars", () => {
    const settings = resolveGatewaySettings({
      CF_ACCOUNT_ID: "acct",
      CF_GATEWAY_NAME: "chiridion",
      CF_GATEWAY_TOKEN: "token",
    });

    expect(settings).toEqual({
      accountID: "acct",
      gatewayID: "chiridion",
      authToken: "token",
      origin: "https://gateway.ai.cloudflare.com",
    });
  });

  it("uses AI_GATEWAY_AUTH_TOKEN when set", () => {
    const settings = resolveGatewaySettings({
      CF_ACCOUNT_ID: "acct",
      CF_GATEWAY_NAME: "chiridion",
      CF_GATEWAY_TOKEN: "token",
      AI_GATEWAY_AUTH_TOKEN: "override-token",
    });

    expect(settings?.authToken).toBe("override-token");
  });

  it("returns undefined when required gateway config is missing", () => {
    expect(
      resolveGatewaySettings({
        CF_ACCOUNT_ID: "acct",
        CF_GATEWAY_NAME: "chiridion",
        CF_GATEWAY_TOKEN: "",
      }),
    ).toBeUndefined();
  });
});

describe("extractModelFromInput", () => {
  it("extracts model field from object input", () => {
    const result = extractModelFromInput({
      model: "smart",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.model).toBe("smart");
    expect(result.input).toEqual({
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("returns undefined model when no model field exists", () => {
    const input = { messages: [{ role: "user", content: "hello" }] };
    const result = extractModelFromInput(input);
    expect(result.model).toBeUndefined();
    expect(result.input).toBe(input);
  });

  it("returns undefined model for non-string model values", () => {
    const result = extractModelFromInput({ model: 42, messages: [] });
    expect(result.model).toBeUndefined();
  });

  it("passes through non-object input unchanged", () => {
    expect(extractModelFromInput(null)).toEqual({
      model: undefined,
      input: null,
    });
    expect(extractModelFromInput("hello")).toEqual({
      model: undefined,
      input: "hello",
    });
    expect(extractModelFromInput([1, 2])).toEqual({
      model: undefined,
      input: [1, 2],
    });
  });
});

describe("normalizeLegacyModel (back-compat shim)", () => {
  it("maps old auto-family routes to the auto tier", () => {
    expect(normalizeLegacyModel("dynamic/auto")).toBe("auto");
    expect(normalizeLegacyModel("auto_search")).toBe("auto");
    expect(normalizeLegacyModel("dynamic/auto_search")).toBe("auto");
  });

  it("maps dynamic/auto_image to the private auto_image route", () => {
    expect(normalizeLegacyModel("dynamic/auto_image")).toBe("auto_image");
  });

  it("maps old friendly model names to their OpenRouter ids", () => {
    expect(normalizeLegacyModel("gpt-5.5")).toBe("openai/gpt-6.1-sol");
    expect(normalizeLegacyModel("openai/gpt-5.5")).toBe("openai/gpt-6.1-sol");
    expect(normalizeLegacyModel("kimi-k2.6")).toBe("moonshotai/kimi-k3");
    expect(normalizeLegacyModel("kimi-latest")).toBe("moonshotai/kimi-k3");
    expect(normalizeLegacyModel("kimi-k2.7-code")).toBe("moonshotai/kimi-k3");
    expect(normalizeLegacyModel("kimi-k3")).toBe("moonshotai/kimi-k3");
    expect(normalizeLegacyModel("opus")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeLegacyModel("opus-4.7")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeLegacyModel("opus-4.8")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeLegacyModel("opus-5")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeLegacyModel("opus-5.5")).toBe("anthropic/claude-opus-5.5");
    expect(normalizeLegacyModel("fable-5")).toBe("anthropic/claude-fable-5.1");
    expect(normalizeLegacyModel("fable-5.1")).toBe("anthropic/claude-fable-5.1");
    expect(normalizeLegacyModel("grok-4.3")).toBe("x-ai/grok-4.7");
    expect(normalizeLegacyModel("x-ai/grok-4.3")).toBe("x-ai/grok-4.7");
    expect(normalizeLegacyModel("grok-latest")).toBe("x-ai/grok-4.7");
    expect(normalizeLegacyModel("grok-4.5")).toBe("x-ai/grok-4.7");
    expect(normalizeLegacyModel("grok-4.7")).toBe("x-ai/grok-4.7");
    expect(normalizeLegacyModel("glm-5.2")).toBe("z-ai/glm-5.3");
    expect(normalizeLegacyModel("z-ai/glm-5.2")).toBe("z-ai/glm-5.3");
    expect(normalizeLegacyModel("glm-5.3")).toBe("z-ai/glm-5.3");
    expect(normalizeLegacyModel("glm-5.3-flash")).toBe("z-ai/glm-5.3-flash");
    expect(normalizeLegacyModel("glm-latest")).toBe("z-ai/glm-5.3");
    expect(normalizeLegacyModel("gemini-3.5-flash")).toBe("google/gemini-3.8-flash");
    expect(normalizeLegacyModel("gemini-3-flash-preview")).toBe("google/gemini-3.8-flash");
    expect(normalizeLegacyModel("gemini-3.8-flash")).toBe("google/gemini-3.8-flash");
    expect(normalizeLegacyModel("deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("passes current tier names, friendly ids, and OpenRouter ids through unchanged", () => {
    expect(normalizeLegacyModel("auto")).toBe("auto");
    expect(normalizeLegacyModel("smart")).toBe("smart");
    expect(normalizeLegacyModel("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(normalizeLegacyModel("deepseek-v4-auto")).toBe("deepseek-v4-auto");
    expect(normalizeLegacyModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeLegacyModel("anthropic/claude-sonnet-4.6")).toBe("anthropic/claude-sonnet-4.6");
    expect(normalizeLegacyModel(normalizeLegacyModel("gpt-5.5"))).toBe("openai/gpt-6.1-sol");
  });

  it("trims whitespace before matching", () => {
    expect(normalizeLegacyModel("  gpt-5.5  ")).toBe("openai/gpt-6.1-sol");
  });
});

describe("resolveRouting", () => {
  it("routes the legacy DeepSeek V4 Auto id to hosted Luna on OpenRouter", async () => {
    const routing = await resolveRouting(
      {
        env: {
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => null),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-auto",
    );

    expect(routing.provider).toBe("openrouter");
    expect(routing.gatewayProvider).toBe("openrouter");
    expect(routing.usageProvider).toBe("openrouter");
    expect(routing.model).toBe("openai/gpt-5.6-luna");
    expect(routing.byokKey).toBeUndefined();
  });

  it("routes hosted DeepSeek V4 Pro through the pro fallback dynamic route", async () => {
    const routing = await resolveRouting(
      {
        env: {
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => null),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-pro",
    );

    expect(routing.gatewayProvider).toBe("compat");
    expect(routing.usageProvider).toBe("compat");
    expect(routing.model).toBe("dynamic/deepseek-v4-pro-fallback");
    expect(routing.byokKey).toBeUndefined();
  });

  it("routes hosted DeepSeek V4 Flash through the flash fallback dynamic route", async () => {
    const routing = await resolveRouting(
      {
        env: {
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => null),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-flash",
    );

    expect(routing.provider).toBe("openrouter");
    expect(routing.gatewayProvider).toBe("compat");
    expect(routing.usageProvider).toBe("compat");
    expect(routing.model).toBe("dynamic/deepseek-v4-flash-fallback");
    expect(routing.byokKey).toBeUndefined();
  });

  it("does not route DeepSeek V4 Auto through OpenRouter BYOK", async () => {
    const encrypted = await encryptCredentials({ api_key: "openrouter-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "openrouter",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "deepseek-v4-auto",
    );

    expect(routing.provider).toBe("openrouter");
    expect(routing.gatewayProvider).toBe("openrouter");
    expect(routing.usageProvider).toBe("openrouter");
    expect(routing.model).toBe("openai/gpt-5.6-luna");
    expect(routing.byokKey).toBeUndefined();
  });

  it("defaults Bedrock BYOK routing to us-east-1 when no region is stored", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "bedrock",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "auto",
    );

    expect(routing.provider).toBe("bedrock");
    expect(routing.awsRegion).toBe("us-east-1");
  });

  it("routes Anthropic BYOK smart tier to Opus 5.5", async () => {
    const encrypted = await encryptCredentials({ api_key: "anthropic-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "anthropic",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "smart",
    );

    expect(routing.provider).toBe("anthropic");
    expect(routing.model).toBe("anthropic/claude-opus-5-5");
  });

  it("routes Bedrock BYOK smart tier to Opus 5.5", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "bedrock",
                config: JSON.stringify({ aws_region: "us-east-1" }),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "smart",
    );

    expect(routing.provider).toBe("bedrock");
    expect(routing.model).toBe("anthropic.claude-opus-5-5");
    expect(routing.awsRegion).toBe("us-east-1");
  });

  it("routes Bedrock BYOK cheap tier to Sonnet 5.5 now that Haiku is retired", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const routing = await resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "bedrock",
                config: JSON.stringify({ aws_region: "us-east-1" }),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      "cheap",
    );

    expect(routing.provider).toBe("bedrock");
    expect(routing.model).toBe("anthropic.claude-sonnet-5-5");
  });
});

describe("resolveRouting tier defaults", () => {
  const hostedScope = () => ({
    env: {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getLlmProviderConfig: vi.fn(async () => null),
        })),
      } as never,
    },
    props: { orgId: "org1", workspaceId: "ws1" },
    waitUntil: vi.fn(),
  });

  it("routes the hosted auto, fast and cheap tiers to GPT-6 Luna without nitro", async () => {
    for (const tier of ["auto", "fast", "cheap"]) {
      const routing = await resolveRouting(hostedScope(), tier);
      expect(routing.gatewayProvider, tier).toBe("openrouter");
      expect(routing.model, tier).toBe("openai/gpt-6-luna");
    }
    expect((await resolveRouting(hostedScope(), "smart")).model).toBe(
      "anthropic/claude-sonnet-5.5:nitro",
    );
  });

  it("defaults an empty pass-through model to GPT-6 Luna", async () => {
    expect((await resolveRouting(hostedScope(), "")).model).toBe("openai/gpt-6-luna");
  });

  it("routes OpenAI BYOK tiers to GPT-6", async () => {
    const encrypted = await encryptCredentials({ api_key: "openai-token" }, "secret");
    const scope = (tier: string) => resolveRouting(
      {
        env: {
          INTEGRATION_SECRET_KEY: "secret",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => ({
                provider: "openai",
                config: JSON.stringify({}),
                credentials_encrypted: encrypted,
              })),
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1" },
        waitUntil: vi.fn(),
      },
      tier,
    );
    expect((await scope("smart")).model).toBe("openai/gpt-6.1-sol");
    expect((await scope("auto")).model).toBe("openai/gpt-6-luna");
    expect((await scope("cheap")).model).toBe("openai/gpt-6-luna");
  });
});

describe("executeVirtualAiRun", () => {
  it("fails closed before the upstream provider when a user's rolling limit denies the pull", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const checkUserLlmUsageAccess = vi.fn(async () => ({
      allowed: false,
      reason: "limit_exceeded" as const,
      evaluated_at_ms: Date.now(),
      blocking_limit: {
        window_hours: 24,
        label: "daily",
        limit_usd: 1,
        spent_usd: 1,
        remaining_usd: 0,
        unpriced_requests: 0,
        exceeded: true,
        retry_at_ms: Date.now() + 60_000,
      },
      limits: [],
    }));
    try {
      await expect(executeVirtualAiRun(
        {
          env: {
            CF_ACCOUNT_ID: "acct_1",
            CF_GATEWAY_NAME: "gw_1",
            CF_GATEWAY_TOKEN: "tok_1",
            ORG: {
              idFromName: vi.fn((id: string) => id),
              get: vi.fn(() => ({
                getLlmProviderConfig: vi.fn(async () => null),
                getInfo: vi.fn(async () => ({
                  billing_status: "active",
                  billing_plan: "payg",
                  billing_credit_purchase_total_cents: 0,
                  billing_credit_grant_total_cents: 0,
                })),
                checkUserLlmUsageAccess,
              })),
            } as never,
          },
          props: { orgId: "org1", workspaceId: "ws1", userId: "user1" },
          waitUntil: vi.fn(),
        },
        "deepseek-v4-auto",
        { messages: [{ role: "user", content: "hello" }] },
      )).rejects.toMatchObject({ code: "limit_exceeded" });
      expect(checkUserLlmUsageAccess).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("posts hosted DeepSeek V4 Auto to the compat dynamic route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        id: "chatcmpl_deepseek_auto",
        model: "provider/canonical-response-model",
        usage: {
          prompt_tokens: 1_000,
          completion_tokens: 3,
          prompt_tokens_details: {
            cached_tokens: 800,
            cache_write_tokens: 50,
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const getCreditChargeableSpendUsd = vi.fn(async () => 0);
    const recordUsage = vi.fn(async () => undefined);
    const checkUserLlmUsageAccess = vi.fn(async () => ({
      allowed: true,
      reason: "no_limits" as const,
      evaluated_at_ms: Date.now(),
      blocking_limit: null,
      limits: [],
    }));
    const backgroundTasks: Promise<unknown>[] = [];

    try {
      await executeVirtualAiRun(
        {
          env: {
            CF_ACCOUNT_ID: "acct_1",
            CF_GATEWAY_NAME: "gw_1",
            CF_GATEWAY_TOKEN: "tok_1",
            ORG: {
              idFromName: vi.fn((id: string) => id),
              get: vi.fn(() => ({
                getLlmProviderConfig: vi.fn(async () => null),
                getInfo: vi.fn(async () => ({
                  billing_status: "active",
                  billing_plan: "payg",
                  billing_credit_purchase_total_cents: 0,
                  billing_credit_grant_total_cents: 0,
                })),
                getCreditChargeableSpendUsd,
                checkUserLlmUsageAccess,
                recordUsage,
              })),
            } as never,
          },
          props: { orgId: "org1", workspaceId: "ws1", userId: "user1" },
          waitUntil: (task) => backgroundTasks.push(task),
        },
        "deepseek-v4-auto",
        { messages: [{ role: "user", content: "hello" }] },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openrouter/chat/completions",
      );
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBe("Bearer tok_1");
      expect(headers.get("cf-aig-authorization")).toBeNull();
      expect(headers.get("X-Chiridion-VLLM-Priority")).toBeNull();
      const body = JSON.parse(String(init.body)) as { model: string };
      expect(body.model).toBe("openai/gpt-5.6-luna");
      expect(getCreditChargeableSpendUsd).not.toHaveBeenCalled();
      expect(checkUserLlmUsageAccess).toHaveBeenCalledOnce();
      await Promise.all(backgroundTasks);
      expect(recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          credit_chargeable: false,
          user_id: "user1",
          model: "openai/gpt-5.6-luna",
          usage_kind: "llm",
          usage_surface: "virtual_ai",
          input_tokens: 150,
          output_tokens: 3,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
          source: "virtual_ai",
          source_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("records one attributable streaming usage row with its request id", async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"model":"openai/gpt-5.6-luna","usage":{"prompt_tokens":1000,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":800,"cache_write_tokens":50}}}\n\n',
        ));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(streamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const recordUsage = vi.fn(async () => undefined);
    const checkUserLlmUsageAccess = vi.fn(async () => ({
      allowed: true,
      reason: "within_limits" as const,
      evaluated_at_ms: Date.now(),
      blocking_limit: null,
      limits: [],
    }));
    const backgroundTasks: Promise<unknown>[] = [];

    try {
      const result = await executeVirtualAiRun({
        env: {
          CF_ACCOUNT_ID: "acct_1",
          CF_GATEWAY_NAME: "gw_1",
          CF_GATEWAY_TOKEN: "tok_1",
          ORG: {
            idFromName: vi.fn((id: string) => id),
            get: vi.fn(() => ({
              getLlmProviderConfig: vi.fn(async () => null),
              getInfo: vi.fn(async () => ({
                billing_status: "active",
                billing_plan: "payg",
                billing_credit_purchase_total_cents: 0,
                billing_credit_grant_total_cents: 0,
              })),
              checkUserLlmUsageAccess,
              recordUsage,
            })),
          } as never,
        },
        props: { orgId: "org1", workspaceId: "ws1", userId: "user1" },
        waitUntil: (task) => backgroundTasks.push(task),
      }, "deepseek-v4-auto", {
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result).toBeInstanceOf(ReadableStream);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      await new Response(result as ReadableStream).text();
      await Promise.all(backgroundTasks);

      expect(checkUserLlmUsageAccess).toHaveBeenCalledOnce();
      expect(recordUsage).toHaveBeenCalledOnce();
      expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
        user_id: "user1",
        input_tokens: 150,
        output_tokens: 4,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 50,
        source: "virtual_ai",
        source_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("records a terminal streaming usage frame even when the stream then errors", async () => {
    let pull = 0;
    const streamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pull++ === 0) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"model":"provider/response-alias","usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
          ));
          return;
        }
        controller.error(new Error("provider stream truncated"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(streamBody, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const recordUsage = vi.fn(async () => undefined);
    const backgroundTasks: Promise<unknown>[] = [];
    const result = await executeVirtualAiRun({
      env: {
        CF_ACCOUNT_ID: "acct_1",
        CF_GATEWAY_NAME: "gw_1",
        CF_GATEWAY_TOKEN: "tok_1",
        ORG: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getLlmProviderConfig: vi.fn(async () => null),
            getInfo: vi.fn(async () => ({
              billing_status: "active",
              billing_plan: "payg",
              billing_credit_purchase_total_cents: 0,
              billing_credit_grant_total_cents: 0,
            })),
            checkUserLlmUsageAccess: vi.fn(async () => ({
              allowed: true,
              reason: "within_limits" as const,
              evaluated_at_ms: Date.now(),
              blocking_limit: null,
              limits: [],
            })),
            recordUsage,
          })),
        } as never,
      },
      props: { orgId: "org1", workspaceId: "ws1", userId: "user1" },
      waitUntil: (task) => backgroundTasks.push(task),
    }, "deepseek-v4-auto", {
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    });

    await expect(new Response(result as ReadableStream).text()).rejects.toThrow("truncated");
    await expect(Promise.all(backgroundTasks)).resolves.toBeDefined();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      model: "openai/gpt-5.6-luna",
      input_tokens: 12,
      output_tokens: 3,
    }));
  });

  it("does not require AI Gateway settings before Bedrock BYOK routing", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const body = bedrockMessagesSseBody();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    try {
      await expect(
        executeVirtualAiRun(
          {
            env: {
              INTEGRATION_SECRET_KEY: "secret",
              ORG: {
                idFromName: vi.fn((id: string) => id),
                get: vi.fn(() => ({
                  getLlmProviderConfig: vi.fn(async () => ({
                    provider: "bedrock",
                    config: JSON.stringify({ aws_region: "us-east-1" }),
                    credentials_encrypted: encrypted,
                  })),
                  recordUsage: vi.fn(async () => undefined),
                })),
              } as never,
            },
            props: { orgId: "org1", workspaceId: "ws1" },
            waitUntil: vi.fn(),
          },
          "auto",
          { messages: [{ role: "user", content: "hello" }] },
        ),
      ).resolves.toBeDefined();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("records nonzero Bedrock usage before propagating a failed completion", async () => {
    const encrypted = await encryptCredentials({ bearer_token: "bedrock-token" }, "secret");
    const recordUsage = vi.fn(async () => undefined);
    const completion = {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "custom",
      model: "anthropic.claude-sonnet-5-5",
      usage: {
        input: 100,
        output: 5,
        cacheRead: 80,
        cacheWrite: 12,
        totalTokens: 197,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "bedrock failed after usage",
      timestamp: Date.now(),
    } as AssistantMessage;
    const runBedrock = vi.fn(async () => {
      throw new BedrockPiCompletionError("bedrock failed after usage", completion);
    });

    await expect(executeVirtualAiRun({
      env: {
        INTEGRATION_SECRET_KEY: "secret",
        ORG: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getLlmProviderConfig: vi.fn(async () => ({
              provider: "bedrock",
              config: JSON.stringify({ aws_region: "us-east-1" }),
              credentials_encrypted: encrypted,
            })),
            checkUserLlmUsageAccess: vi.fn(async () => ({
              allowed: true,
              reason: "within_limits" as const,
              evaluated_at_ms: Date.now(),
              blocking_limit: null,
              limits: [],
            })),
            recordUsage,
          })),
        } as never,
      },
      props: { orgId: "org1", workspaceId: "ws1", userId: "user1" },
      waitUntil: vi.fn(),
      runBedrock,
    }, "cheap", {
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("bedrock failed after usage");

    expect(runBedrock).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user1",
      provider: "bedrock",
      model: "anthropic.claude-sonnet-5-5",
      usage_kind: "llm",
      usage_surface: "virtual_ai",
      input_tokens: 100,
      output_tokens: 5,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 12,
    }));
  });
});

describe("appendNitro", () => {
  it("appends :nitro to plain OpenRouter ids", () => {
    expect(appendNitro("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash:nitro",
    );
    expect(appendNitro("moonshotai/kimi-k2.7-code")).toBe(
      "moonshotai/kimi-k2.7-code:nitro",
    );
  });

  it("leaves Luna unsuffixed", () => {
    expect(appendNitro("openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
    expect(appendNitro("openai/gpt-5.6-luna")).toBe(
      "openai/gpt-5.6-luna",
    );
  });

  it("does not double-suffix when a :variant is already present", () => {
    expect(appendNitro("anthropic/claude-sonnet-4.6:nitro")).toBe(
      "anthropic/claude-sonnet-4.6:nitro",
    );
    expect(appendNitro("openai/gpt-5.6-terra:online")).toBe("openai/gpt-5.6-terra:online");
  });

  it("returns empty string for empty input", () => {
    expect(appendNitro("")).toBe("");
    expect(appendNitro("   ")).toBe("");
  });
});

describe("runViaGatewayHTTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes to /compat/ with hosted gateway token when no BYOK key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl_1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1", userId: "user_1" },
      { messages: [{ role: "user", content: "hello" }] },
      "anthropic/claude-sonnet-4-6",
      "compat",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/compat/chat/completions",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok_1");
    expect(headers.get("cf-aig-authorization")).toBeNull();

    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("sends BYOK key as Authorization and gateway token as cf-aig-authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "gateway-tok" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "hi" }] },
      "openai/gpt-5.6-terra",
      "compat",
      "sk-user-byok",
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-user-byok");
    expect(headers.get("cf-aig-authorization")).toBe("Bearer gateway-tok");
  });

  it("routes OpenRouter models to /openrouter/", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "chatcmpl_or" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { messages: [{ role: "user", content: "hello" }] },
      "deepseek/deepseek-v4-flash:nitro",
      "openrouter",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct_1/gw_1/openrouter/chat/completions",
    );
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe("deepseek/deepseek-v4-flash:nitro");
  });

  it("throws the gateway error message for non-2xx responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "gateway rejected request" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      runViaGatewayHTTP(
        { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
        { orgId: "org_1", workspaceId: "ws_1" },
        { messages: [{ role: "user", content: "hello" }] },
        "openai/gpt-5.6-terra",
        "compat",
      ),
    ).rejects.toThrow("gateway rejected request");
  });

  it("passes through streaming responses when stream=true", async () => {
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"id":"evt_1"}\n\n'),
        );
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
    );

    const result = await runViaGatewayHTTP(
      { accountID: "acct_1", gatewayID: "gw_1", authToken: "tok_1" },
      { orgId: "org_1", workspaceId: "ws_1" },
      { stream: true, messages: [{ role: "user", content: "hello" }] },
      "deepseek/deepseek-v4-flash:nitro",
      "openrouter",
    );

    expect(result).toBeInstanceOf(ReadableStream);

    const reader = (result as ReadableStream<Uint8Array>).getReader();
    let combined = "";
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      combined += decoder.decode(value, { stream: true });
    }
    combined += decoder.decode();

    expect(combined).toContain('data: {"id":"evt_1"}');
    expect(combined).toContain("data: [DONE]");
  });
});

describe("chatCompletionToPiCall (Bedrock adapter — input)", () => {
  it("lifts system messages, flattens text content, threads inference config", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hello!" }],
        },
      ],
      max_tokens: 256,
      temperature: 0.4,
      top_p: 0.95,
    });
    expect(call.stream).toBe(false);
    expect(call.context.systemPrompt).toBe("be helpful");
    expect(call.context.messages.length).toBe(2);
    expect(call.context.messages[0]).toMatchObject({ role: "user", content: "hi" });
    expect(call.context.messages[1].role).toBe("assistant");
    expect(call.maxTokens).toBe(256);
    expect(call.temperature).toBe(0.4);
  });

  it("returns stream=true when the input requests streaming", () => {
    const call = chatCompletionToPiCall({
      stream: true,
      messages: [{ role: "user", content: "go" }],
    });
    expect(call.stream).toBe(true);
  });

  it("preserves base64 data-URL image parts as pi-ai ImageContent", () => {
    const call = chatCompletionToPiCall({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAneed" },
            },
          ],
        },
      ],
    });
    expect(call.context.messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "AAAneed", mimeType: "image/png" },
      ],
    });
  });

  it("keeps an image-only user turn (does not drop it)", () => {
    const call = chatCompletionToPiCall({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/jpeg;base64,ZZZ" },
            },
          ],
        },
      ],
    });
    expect(call.context.messages.length).toBe(1);
    expect(call.context.messages[0].content).toEqual([
      { type: "image", data: "ZZZ", mimeType: "image/jpeg" },
    ]);
  });

  it("collapses a single text part back to a plain string", () => {
    const call = chatCompletionToPiCall({
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(call.context.messages[0].content).toBe("hi");
  });

  it("skips remote (non-data) image URLs rather than fetching them", () => {
    const call = chatCompletionToPiCall({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
          ],
        },
      ],
    });
    expect(call.context.messages[0].content).toBe("look");
  });

  it("translates OpenAI tools into pi-ai Tool[] and forwards tool_choice", () => {
    const call = chatCompletionToPiCall({
      messages: [{ role: "user", content: "go" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Lookup weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(call.context.tools).toEqual([
      {
        name: "get_weather",
        description: "Lookup weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
    expect(call.toolChoice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("maps tool_choice variants ('auto', 'required', 'none')", () => {
    expect(chatCompletionToPiCall({ messages: [{ role: "user", content: "x" }], tool_choice: "auto" }).toolChoice).toBe("auto");
    expect(chatCompletionToPiCall({ messages: [{ role: "user", content: "x" }], tool_choice: "required" }).toolChoice).toBe("any");
    expect(chatCompletionToPiCall({ messages: [{ role: "user", content: "x" }], tool_choice: "none" }).toolChoice).toBe("none");
  });

  it("translates assistant tool_calls into pi-ai ToolCall content blocks", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "user", content: "weather in SF" },
        {
          role: "assistant",
          content: "Looking that up.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
      ],
    });
    const assistant = call.context.messages[1] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "text", text: "Looking that up." },
      { type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "SF" } },
    ]);
  });

  it("translates role:tool messages into pi-ai ToolResultMessage and threads toolName from earlier tool_calls", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "user", content: "weather in SF" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    });
    expect(call.context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "get_weather",
      content: [{ type: "text", text: "sunny" }],
      isError: false,
    });
  });

  it("emits one ToolResultMessage per role:tool message", () => {
    const call = chatCompletionToPiCall({
      messages: [
        { role: "user", content: "weather in SF and NYC" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "w", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "w", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "sunny" },
        { role: "tool", tool_call_id: "c2", content: "cloudy" },
      ],
    });
    expect(call.context.messages.length).toBe(4);
    expect(call.context.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "c1" });
    expect(call.context.messages[3]).toMatchObject({ role: "toolResult", toolCallId: "c2" });
  });
});

describe("piMessageToChatCompletion (Bedrock adapter — output)", () => {
  const baseUsage = {
    input: 3,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  it("renders a text-only assistant message", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
        api: "anthropic-messages",
        provider: "custom",
        model: "haiku",
        usage: baseUsage,
        stopReason: "stop",
        timestamp: Date.now(),
      },
      "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    ) as Record<string, unknown>;
    const choices = completion.choices as Array<Record<string, unknown>>;
    expect((choices[0].message as Record<string, unknown>).content).toBe("Hello!");
    expect(choices[0].finish_reason).toBe("stop");
    expect(completion.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });

  it("emits tool_calls payload (with JSON-stringified arguments) for toolUse stop", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking that up" },
          {
            type: "toolCall",
            id: "tu_1",
            name: "get_weather",
            arguments: { city: "SF" },
          },
        ],
        api: "anthropic-messages",
        provider: "custom",
        model: "haiku",
        usage: baseUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      "model",
    ) as Record<string, unknown>;
    const choices = completion.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe("Looking that up");
    expect(msg.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) },
      },
    ]);
  });

  it("falls back to finish_reason:stop when toolUse stop has no tool_calls", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "custom",
        model: "m",
        usage: baseUsage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      "model",
    ) as Record<string, unknown>;
    const choices = completion.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
    expect((choices[0].message as Record<string, unknown>).tool_calls).toBeUndefined();
  });

  it("propagates cache read + write tokens into prompt_tokens_details", () => {
    const completion = piMessageToChatCompletion(
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "anthropic-messages",
        provider: "custom",
        model: "m",
        usage: {
          input: 100,
          output: 5,
          cacheRead: 80,
          cacheWrite: 12,
          totalTokens: 105,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
      "model",
    ) as Record<string, unknown>;
    const usage = completion.usage as Record<string, unknown>;
    expect(usage).toMatchObject({
      prompt_tokens: 192,
      completion_tokens: 5,
      total_tokens: 197,
    });
    expect(usage.prompt_tokens_details).toEqual({
      cached_tokens: 80,
      cache_write_tokens: 12,
      cache_creation_input_tokens: 12,
    });
  });

  it("throws if pi-ai reports stopReason: error", () => {
    expect(() =>
      piMessageToChatCompletion(
        {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "custom",
          model: "m",
          usage: baseUsage,
          stopReason: "error",
          errorMessage: "boom",
          timestamp: Date.now(),
        },
        "model",
      ),
    ).toThrow("boom");
  });
});


describe("buildGenerateImageMessages", () => {
  it("builds a text-only user message from a prompt string", () => {
    expect(buildGenerateImageMessages("A watercolor mountain")).toEqual([
      { role: "user", content: "A watercolor mountain" },
    ]);
  });

  it("builds multimodal content when a reference image is provided", () => {
    expect(
      buildGenerateImageMessages({
        prompt: "Same style, new subject",
        referenceImageUrl: "data:image/png;base64,abc",
      }),
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
          { type: "text", text: "Same style, new subject" },
        ],
      },
    ]);
  });

  it("throws when the prompt is empty", () => {
    expect(() => buildGenerateImageMessages("   ")).toThrow(
      "generateImage requires a non-empty prompt",
    );
  });
});

describe("generateImage", () => {
  it("calls auto_image via run and parses the response", async () => {
    const ai = {
      run: async (model: string, input: unknown) => {
        expect(model).toBe("auto_image");
        expect(input).toEqual({
          messages: [{ role: "user", content: "a star" }],
        });
        return {
          choices: [
            {
              message: {
                content: "done",
                images: [
                  {
                    index: 0,
                    image_url: { url: "data:image/png;base64,star" },
                  },
                ],
              },
            },
          ],
        };
      },
    };

    const result = await generateImage(ai, "a star");
    expect(result.imageDataUrl).toBe("data:image/png;base64,star");
  });
});

describe("parseGenerateImageResponse", () => {
  it("extracts text and image data URLs from gateway payloads", () => {
    const result = parseGenerateImageResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "Here is your image.",
            images: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAA" },
                index: 1,
              },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,BBB" },
                index: 0,
              },
            ],
          },
        },
      ],
    });

    expect(result).toEqual({
      text: "Here is your image.",
      imageDataUrl: "data:image/png;base64,BBB",
      images: [
        { dataUrl: "data:image/png;base64,BBB", index: 0 },
        { dataUrl: "data:image/png;base64,AAA", index: 1 },
      ],
    });
  });

  it("returns empty image fields when the model returns text only", () => {
    expect(
      parseGenerateImageResponse({
        choices: [{ message: { role: "assistant", content: "No image." } }],
      }),
    ).toEqual({
      text: "No image.",
      imageDataUrl: null,
      images: [],
    });
  });
});
