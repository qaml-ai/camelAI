// Pi model / billing-source resolution for ChatThreadDO, extracted as free
// functions with explicit deps: BYOK credential resolution, hosted-credit
// gating, per-request provider config (custom/openrouter/bedrock/hosted
// gateway), and the model catalog fallbacks. Sibling steps arrive as injected
// callbacks so ChatThreadDO's thin delegates keep routing through `this`
// (preserving the DO-internal call surface and its test seams).
import type { Model } from "@earendil-works/pi-ai";
import type {
  ChatContextState,
  ChatEnv,
  PiHeaderValue,
  PiResolvedModelReference,
} from "./types";
import type { PiModelMapping } from "../pi-model-resolution";
import { decryptCredentials } from "../../../../src/lib/integration-crypto";
import {
  OPENAI_CODEX_API_BASE_URL,
} from "../../../../src/lib/openai-subscription.server";
import {
  CAMEL_CODE_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  isCreditFreeHostedModel,
  parseStoredLlmProviderConfig,
} from "../../../../src/lib/llm-provider-config";
import {
  getSelfhostAiProviderCredentials,
} from "../../../../src/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "../../../../src/lib/selfhost-runtime";
import { buildCloudflareGatewayUrl } from "../../../../src/lib/cloudflare-ai-gateway";
import {
  FREE_VLLM_PRIORITY,
  getHostedVllmPriority,
} from "../hosted-vllm-priority";

export type PiBillingSource = "hosted" | "byok";

export function primaryPiThinkingLevel(
  modelId: string | null | undefined,
): "medium" | "high" {
  return modelId === CAMEL_CODE_LLM_MODEL || modelId === "gpt-5.6-luna"
    ? "high"
    : "medium";
}

export type LlmProviderConfigRecord = ReturnType<
  import("../identity/org-do").OrgDO["getLlmProviderConfig"]
>;

export interface PiRequestConfig {
  apiKey: string;
  api?: string;
  baseUrl?: string;
  headers?: Record<string, PiHeaderValue>;
  requestProvider?: string;
  requestModelId?: string;
  modelLookupProvider?: string;
  modelLookupModelId?: string;
  billingSource: PiBillingSource;
  creditChargeable: boolean;
  usageProvider?: string;
}

export interface PiResolvedModelConfig {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, PiHeaderValue>;
  provider: string;
  modelId: string;
  billingSource: PiBillingSource;
  creditChargeable: boolean;
  usageProvider: string;
}

/**
 * Mirror Pi's transformMessages image capability check. Pi replaces typed image
 * blocks for these models at request time; we use the same predicate earlier to
 * discard inline image data URLs before they bloat the persisted agent context.
 */
export function isPiImageBlindModel(model: Pick<Model<any>, "input"> | null | undefined): boolean {
  return !model?.input?.includes("image");
}

export interface ResolvePiModelDeps {
  env: ChatEnv;
  modelMapping: PiModelMapping;
  resolveRequestConfig(
    resolved: PiResolvedModelReference,
    context: ChatContextState,
    requestedModelId: string,
  ): Promise<PiRequestConfig>;
  /**
   * Invoked as soon as the request config settles (before the resolved model
   * is assembled), mirroring the original mid-method field writes so the
   * billing fields are updated even when a later model-lookup step throws.
   */
  onBillingResolved(
    billingSource: PiBillingSource,
    creditChargeable: boolean,
    usageProvider: string,
  ): void;
  onHostedModelFallback?(
    requestedModel: string,
    fallbackModel: string,
    reason: HostedModelFallbackReason,
  ): Promise<void>;
}

export type HostedModelFallbackReason =
  | "hosted_credits_exhausted"
  | "hosted_subscription_unavailable";

export class HostedModelFallbackRequiredError extends Error {
  constructor(
    message: string,
    readonly fallbackReason: HostedModelFallbackReason,
  ) {
    super(message);
    this.name = "HostedModelFallbackRequiredError";
  }
}

export class HostedModelCreditsExhaustedError extends HostedModelFallbackRequiredError {
  constructor(message: string) {
    super(message, "hosted_credits_exhausted");
    this.name = "HostedModelCreditsExhaustedError";
  }
}

export class HostedModelSubscriptionUnavailableError extends HostedModelFallbackRequiredError {
  constructor(message: string) {
    super(message, "hosted_subscription_unavailable");
    this.name = "HostedModelSubscriptionUnavailableError";
  }
}

export interface ResolvePiRequestConfigDeps {
  env: ChatEnv;
  modelMapping: PiModelMapping;
  /** Platform-sponsored capability agents must use the hosted route, never user credentials. */
  forceHosted?: boolean;
  getChatMetadata(): {
    orgId?: string;
    workspaceId?: string;
    threadId?: string;
  } | null;
  resolveByokCredentials(
    context: ChatContextState,
    options: { includeOpenAiSubscription: boolean },
  ): Promise<Awaited<ReturnType<typeof resolveCurrentByokCredentials>>>;
  checkHostedModelAccess(
    context: ChatContextState,
    model: string,
  ): Promise<HostedModelAccess>;
}

export interface HostedModelAccess {
  creditChargeable: boolean;
  vllmPriority: string;
}

function hostedDeepseekStickyKey(
  resolved: PiResolvedModelReference,
  metadata: ReturnType<ResolvePiRequestConfigDeps["getChatMetadata"]>,
): string | null {
  if (!resolved.hostedStickyRouting || !metadata?.threadId) {
    return null;
  }
  // Namespace the thread by its owning scope. Thread IDs are normally globally
  // unique, but the full identity keeps imported/legacy IDs from sharing a KV
  // cache affinity bucket with another workspace.
  return ["chiridion", metadata.orgId, metadata.workspaceId, metadata.threadId]
    .filter(Boolean)
    .join(":");
}

const PI_MODEL_CATALOG_FALLBACKS: Record<string, Model<any>> = {
  "anthropic/claude-sonnet-5": {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"anthropic-messages">,
  "anthropic/claude-fable-5": {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    compat: { forceAdaptiveThinking: true },
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: "xhigh" },
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"anthropic-messages">,
  "anthropic/claude-opus-5": {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
    },
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  } satisfies Model<"anthropic-messages">,
  "openai/gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  } satisfies Model<"openai-responses">,
  "openrouter/google/gemini-3.5-flash": {
    id: "google/gemini-3.5-flash",
    name: "Google: Gemini 3.5 Flash",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 1.5,
      output: 9,
      cacheRead: 0.15,
      cacheWrite: 0.08333333333333334,
    },
    contextWindow: 1048576,
    maxTokens: 65536,
  } satisfies Model<"openai-completions">,
  "openrouter/moonshotai/kimi-k2.7-code": {
    id: "moonshotai/kimi-k2.7-code",
    name: "MoonshotAI: Kimi K2.7 Code",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 0.74,
      output: 3.5,
      cacheRead: 0.15,
      cacheWrite: 0,
    },
    contextWindow: 262144,
    maxTokens: 16384,
  } satisfies Model<"openai-completions">,
  "openrouter/x-ai/grok-4.5": {
    id: "x-ai/grok-4.5",
    name: "xAI: Grok 4.5",
    api: "openai-responses",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: {
      input: 2,
      output: 6,
      cacheRead: 0.5,
      cacheWrite: 0,
    },
    contextWindow: 500000,
    maxTokens: 128000,
  } satisfies Model<"openai-responses">,
  "openrouter/z-ai/glm-5.3": {
    id: "z-ai/glm-5.3",
    name: "Z.ai: GLM 5.3",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true,
    // https://openrouter.ai/z-ai/glm-5.3 (verified 2026-09-23).
    // Reasoning is mandatory and accepts only low/high/max. Map Pi's medium
    // default to high and keep the mapping enabled through AI Gateway.
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "high",
      high: "high",
      xhigh: "max",
      max: "max",
    },
    input: ["text"],
    cost: {
      input: 0.84,
      output: 2.64,
      cacheRead: 0.156,
      cacheWrite: 0,
    },
    contextWindow: 1048576,
    maxTokens: 131072,
  } satisfies Model<"openai-completions">,
};

function resolvePiModelCatalogFallback(
  resolved: PiResolvedModelReference,
): Model<any> | null {
  return PI_MODEL_CATALOG_FALLBACKS[`${resolved.provider}/${resolved.modelId}`] ?? null;
}

export async function resolvePiModelConfig(
  deps: ResolvePiModelDeps,
  context: ChatContextState,
  envVars: Record<string, string>,
  getModelFn: (provider: never, modelId: never) => Model<any>,
): Promise<PiResolvedModelConfig> {
  const requestedModelId =
    envVars.CHIRIDION_MODEL ||
    DEFAULT_LLM_MODEL;
  const modelId = deps.modelMapping.normalizePiModelId(requestedModelId);
  const resolved = deps.modelMapping.resolvePiModelReference(modelId);
  const model =
    (getModelFn(
      resolved.provider as never,
      resolved.modelId as never,
    ) as Model<any> | null | undefined) ??
    resolvePiModelCatalogFallback(resolved);
  if (!model) {
    throw new Error(`Unsupported Pi model ${requestedModelId}`);
  }

  let configured: PiRequestConfig;
  try {
    configured = await deps.resolveRequestConfig(
      resolved,
      context,
      requestedModelId,
    );
  } catch (error) {
    if (
      error instanceof HostedModelFallbackRequiredError &&
      requestedModelId !== CAMEL_CODE_LLM_MODEL
    ) {
      const fallbackEnvVars = {
        ...envVars,
        CHIRIDION_MODEL: CAMEL_CODE_LLM_MODEL,
      };
      const fallback = await resolvePiModelConfig(
        deps,
        context,
        fallbackEnvVars,
        getModelFn,
      );
      await deps.onHostedModelFallback?.(
        requestedModelId,
        CAMEL_CODE_LLM_MODEL,
        error.fallbackReason,
      );
      Object.assign(envVars, fallbackEnvVars);
      return fallback;
    }
    throw error;
  }
  const configuredModel =
    configured.modelLookupProvider && configured.requestModelId
      ? (getModelFn(
          configured.modelLookupProvider as never,
          (configured.modelLookupModelId ?? configured.requestModelId) as never,
        ) as Model<any> | null | undefined) ??
        resolvePiModelCatalogFallback({
          provider: configured.modelLookupProvider,
          modelId: configured.modelLookupModelId ?? configured.requestModelId,
          hostedGatewayProvider: resolved.hostedGatewayProvider,
        })
      : null;
  if (configured.modelLookupProvider && !configuredModel) {
    throw new Error(
      `Unsupported ${configured.modelLookupProvider} Pi model ${configured.requestModelId}`,
    );
  }
  const modelBase = configuredModel ?? model;
  const usageProvider = configured.usageProvider ?? resolved.provider;
  deps.onBillingResolved(configured.billingSource, configured.creditChargeable, usageProvider);
  // E2E determinism: when TEST_LLM_REPLAY_URL is set, route every provider's
  // requests to the local deterministic fake LLM (scripts/fake-llm.mjs)
  // instead of the real model. Auth/headers are left untouched (the fake
  // ignores them); only the origin changes, so the agent loop runs offline
  // and deterministically. Unset in production -> no effect.
  const replayBaseUrl = (
    deps.env as { TEST_LLM_REPLAY_URL?: string }
  ).TEST_LLM_REPLAY_URL?.trim();
  const resolvedModel = {
    ...modelBase,
    api: configured.api ?? resolved.api ?? modelBase.api,
    id: configured.requestModelId ?? modelBase.id,
    provider: configured.requestProvider ?? modelBase.provider,
    baseUrl: replayBaseUrl || configured.baseUrl || modelBase.baseUrl,
    headers: {
      ...modelBase.headers,
      ...configured.headers,
    },
  } as Model<any>;
  if (resolvedModel.provider === "cloudflare-ai-gateway" && resolved.hostedRequestProfile) {
    const profile = resolved.hostedRequestProfile;
    if (profile.reasoning !== undefined) {
      resolvedModel.reasoning = profile.reasoning;
    }
    if (profile.contextWindow) {
      resolvedModel.contextWindow = profile.contextWindow;
    }
    if (profile.maxTokens) {
      resolvedModel.maxTokens = Math.min(
        Math.floor(Number(resolvedModel.maxTokens || profile.maxTokens)),
        profile.maxTokens,
      );
    }
    if (profile.supportsReasoningEffort !== undefined || profile.thinkingFormat) {
      resolvedModel.compat = {
        ...resolvedModel.compat,
        ...(profile.supportsReasoningEffort !== undefined && {
          supportsReasoningEffort: profile.supportsReasoningEffort,
        }),
        ...(profile.thinkingFormat && { thinkingFormat: profile.thinkingFormat }),
      };
    }
  }
  // Force a fixed reasoning effort on hosted AI Gateway models that need it
  // (e.g. DeepSeek V4 Pro/Auto -> xhigh). pi-ai treats the cloudflare-ai-gateway
  // provider as supportsReasoningEffort=false, so we flip it on and map every
  // agent thinking level to the target effort; otherwise reasoning_effort is
  // never emitted and the dynamic route falls back to its upstream default.
  if (
    resolved.hostedReasoningEffort &&
    resolvedModel.reasoning !== false &&
    resolvedModel.provider === "cloudflare-ai-gateway"
  ) {
    const effort = resolved.hostedReasoningEffort;
    resolvedModel.compat = {
      ...resolvedModel.compat,
      supportsReasoningEffort: true,
    };
    resolvedModel.thinkingLevelMap = {
      minimal: effort,
      low: effort,
      medium: effort,
      high: effort,
      xhigh: effort,
    } as Model<any>["thinkingLevelMap"];
  }
  return {
    model: resolvedModel,
    apiKey: configured.apiKey,
    headers: configured.headers,
    provider: resolved.provider,
    modelId: resolved.modelId,
    billingSource: configured.billingSource,
    creditChargeable: configured.creditChargeable,
    usageProvider,
  };
}

export async function resolvePiRequestConfig(
  deps: ResolvePiRequestConfigDeps,
  resolved: PiResolvedModelReference,
  context: ChatContextState,
  requestedModelId: string,
): Promise<PiRequestConfig> {
  const byokAllowed = resolved.byokAllowed !== false;
  const selfhostProvider = deps.forceHosted
    ? null
    : getSelfhostAiProviderCredentials(deps.env);
  const byok = deps.forceHosted || !byokAllowed
    ? null
    : selfhostProvider ?? await deps.resolveByokCredentials(context, {
      includeOpenAiSubscription: resolved.provider === "openai",
    });
  if (
    byokAllowed &&
    byok &&
    "openAiSubscription" in byok &&
    byok.openAiSubscription &&
    resolved.provider === "openai"
  ) {
    const proxyBaseUrl = deps.env.OPENAI_CODEX_PROXY_BASE_URL?.trim();
    const proxyToken = deps.env.OPENAI_CODEX_PROXY_TOKEN?.trim();
    if (Boolean(proxyBaseUrl) !== Boolean(proxyToken)) {
      throw new Error(
        "OPENAI_CODEX_PROXY_BASE_URL and OPENAI_CODEX_PROXY_TOKEN must be configured together.",
      );
    }
    return {
      apiKey: byok.openAiSubscription.accessToken,
      api: "openai-codex-responses",
      billingSource: "byok",
      creditChargeable: false,
      requestProvider: "openai-codex",
      baseUrl: proxyBaseUrl || OPENAI_CODEX_API_BASE_URL,
      headers: proxyToken
        ? { "X-CamelAI-Proxy-Token": proxyToken }
        : undefined,
      usageProvider: "openai",
    };
  }
  if (byokAllowed && byok?.provider === "custom" && byok.apiKey && byok.baseUrl && byok.api) {
    const customModel = deps.modelMapping.resolveCustomProviderModelReference(
      byok.api,
      requestedModelId,
      byok.modelId,
    );
    return {
      apiKey: byok.apiKey,
      api: byok.api,
      billingSource: "byok",
      creditChargeable: false,
      requestProvider: "custom",
      requestModelId: customModel.requestModelId,
      modelLookupProvider: customModel.provider,
      modelLookupModelId: customModel.lookupModelId,
      baseUrl: byok.baseUrl,
      usageProvider: "custom",
      headers: deps.modelMapping.customProviderAuthHeaders(byok.api, byok.authType ?? "bearer", byok.apiKey),
    };
  }
  if (byokAllowed && byok?.provider === "openrouter" && byok.apiKey) {
    return {
      apiKey: byok.apiKey,
      billingSource: "byok",
      creditChargeable: false,
      usageProvider: "openrouter",
      // hostedModelId can be a gateway-only dynamic route (e.g.
      // "dynamic/..." on the AI Gateway compat endpoint); OpenRouter only
      // understands native model ids, so fall back to the OpenRouter id.
      requestModelId:
        resolved.hostedGatewayProvider === "openrouter"
          ? resolved.hostedModelId
          : deps.modelMapping.openRouterNitroModel(resolved.modelId),
      headers: {
        ...deps.modelMapping.openRouterAttributionHeaders(),
        ...(resolved.provider === "anthropic"
          ? { Authorization: `Bearer ${byok.apiKey}` }
          : {}),
      },
      baseUrl: resolved.provider === "anthropic"
        ? "https://openrouter.ai/api"
        : "https://openrouter.ai/api/v1",
    };
  }
  if (byokAllowed && byok?.provider === "bedrock" && byok.apiKey && resolved.provider === "anthropic") {
    return {
      apiKey: byok.apiKey,
      api: "anthropic-messages",
      billingSource: "byok",
      creditChargeable: false,
      requestProvider: "custom",
      requestModelId: deps.modelMapping.bedrockClaudeModel(resolved.modelId),
      modelLookupProvider: "anthropic",
      modelLookupModelId: resolved.modelId,
      baseUrl: deps.modelMapping.bedrockAnthropicMessagesBaseUrl(byok.awsRegion),
      usageProvider: "bedrock",
    };
  }
  if (byokAllowed && byok?.provider === "bedrock" && byok.apiKey && resolved.provider === "openai") {
    const bedrockOpenAi = deps.modelMapping.bedrockOpenAiModelConfig(resolved.modelId, byok.awsRegion);
    if (bedrockOpenAi) {
      return {
        apiKey: byok.apiKey,
        api: "openai-responses",
        billingSource: "byok",
        creditChargeable: false,
        requestProvider: "custom",
        requestModelId: bedrockOpenAi.modelId,
        modelLookupProvider: "openai",
        modelLookupModelId: resolved.modelId,
        baseUrl: bedrockOpenAi.baseUrl,
        usageProvider: "bedrock",
      };
    }
  }
  if (byokAllowed && byok?.provider === resolved.provider && byok.apiKey) {
    return {
      apiKey: byok.apiKey,
      billingSource: "byok",
      creditChargeable: false,
      usageProvider: resolved.provider,
    };
  }

  const hostedAccess = await deps.checkHostedModelAccess(
    context,
    requestedModelId,
  );
  const creditChargeable = hostedAccess.creditChargeable;
  // E2E replay routes hosted calls to a local stub that ignores account/
  // gateway/auth, so stand in dummy values to clear this gateway-config check
  // (the real origin is swapped in resolveCloudflareGatewayOrigin). Lets the
  // credential-free CI path replay hosted turns without gateway secrets.
  const replay = deps.env.TEST_LLM_REPLAY_URL?.trim() ? "replay" : undefined;
  const accountId = deps.env.CF_ACCOUNT_ID?.trim() || replay;
  const gatewayName = deps.env.CF_GATEWAY_NAME?.trim() || replay;
  const token =
    deps.env.AI_GATEWAY_AUTH_TOKEN?.trim() ||
    deps.env.CF_GATEWAY_TOKEN?.trim() ||
    replay;
  if (!accountId || !gatewayName || !token) {
    if (isSelfhostRuntime(deps.env)) {
      throw new Error(
        "Self-host chat requires an AI provider. Set SELFHOST_AI_PROVIDER and SELFHOST_AI_API_KEY in the self-host environment, or configure CF_ACCOUNT_ID, CF_GATEWAY_NAME, and AI_GATEWAY_AUTH_TOKEN for a hosted Cloudflare AI Gateway.",
      );
    }
    throw new Error("Cloudflare AI Gateway is not configured for DO Pi");
  }

  const chatMetadata = deps.getChatMetadata();
  const stickyKey = hostedDeepseekStickyKey(resolved, chatMetadata);
  return {
    apiKey: token,
    billingSource: "hosted",
    creditChargeable,
    requestProvider: "cloudflare-ai-gateway",
    requestModelId: resolved.hostedModelId,
    usageProvider: resolved.hostedGatewayProvider,
    baseUrl: buildCloudflareGatewayUrl(
      deps.env,
      `/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayName)}/${encodeURIComponent(resolved.hostedGatewayProvider)}`,
    ),
    headers: {
      ...(resolved.hostedGatewayProvider === "openrouter"
        ? deps.modelMapping.openRouterAttributionHeaders()
        : {}),
      // Pi's session is the chat thread. Only the DeepSeek dynamic routes can
      // reach our sticky router; do not leak this internal affinity header to
      // unrelated hosted providers.
      ...(stickyKey ? { "x-sticky-key": stickyKey } : {}),
      // The self-hosted DeepSeek provider translates this trusted header to
      // vLLM's request priority. Do not add it to unrelated model routes.
      ...(resolved.hostedModelId?.startsWith("dynamic/deepseek-v4-")
        ? { "X-Chiridion-VLLM-Priority": hostedAccess.vllmPriority }
        : {}),
      "cf-aig-metadata": JSON.stringify({
        uid: [chatMetadata?.orgId, chatMetadata?.workspaceId, chatMetadata?.threadId]
          .filter(Boolean)
          .join(":"),
        chiridion: {
          orgId: chatMetadata?.orgId,
          workspaceId: chatMetadata?.workspaceId,
          threadId: chatMetadata?.threadId,
        },
      }),
    },
  };
}

function formatCreditCents(cents: number): string {
  return `${(Math.max(0, Math.floor(cents)) / 100).toFixed(2)} credits`;
}

export async function checkHostedPiModelAccess(
  env: ChatEnv,
  context: ChatContextState,
  model?: string,
): Promise<HostedModelAccess> {
  if (isSelfhostRuntime(env)) {
    return { creditChargeable: false, vllmPriority: FREE_VLLM_PRIORITY };
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
  const org = await orgStub.getInfo();
  if (!org) {
    throw new Error("Organization not found");
  }

  const status = org.billing_status ?? "inactive";
  const plan = org.billing_plan ?? "payg";
  const vllmPriority = getHostedVllmPriority(org);
  if (status === "enterprise") {
    return { creditChargeable: false, vllmPriority };
  }
  if (isCreditFreeHostedModel(model)) {
    return { creditChargeable: false, vllmPriority };
  }
  const isPayAsYouGo = plan === "payg";
  if (status === "past_due") {
    throw new HostedModelSubscriptionUnavailableError(
      "Your subscription is past due. Update payment details, switch to Pay as you go in Settings -> Billing, or add your own API key in Settings -> AI Provider to continue. Your workspace is saved.",
    );
  }
  if (status === "canceled") {
    throw new HostedModelSubscriptionUnavailableError(
      "Your subscription was canceled. Start a new subscription, switch to Pay as you go in Settings -> Billing, or add your own API key in Settings -> AI Provider to continue. Your workspace is saved.",
    );
  }
  if (!isPayAsYouGo && status !== "trialing" && status !== "active") {
    throw new HostedModelSubscriptionUnavailableError(
      "Hosted models require billing access. Choose Pay as you go, start a subscription, or add your own API key in Settings -> AI Provider. Your workspace is saved.",
    );
  }

  const usage = await orgStub.getUsageLogSum(0, Date.now(), true);
  const spentCents = Math.round(Number(usage.total_cost_usd ?? 0) * 100);
  const totalCreditsCents =
    (org.billing_credit_purchase_total_cents ?? 0) +
    (org.billing_credit_grant_total_cents ?? 0);
  if (totalCreditsCents - spentCents > 0) {
    return { creditChargeable: true, vllmPriority };
  }

  throw new HostedModelCreditsExhaustedError(
    `Hosted model credits are used up. You have used ${formatCreditCents(spentCents)} of ${formatCreditCents(totalCreditsCents)}. Buy credits or manage your subscription in Settings -> Billing, or add your own API key in Settings -> AI Provider. Your workspace is saved.`,
  );
}

export async function resolveCurrentByokCredentials(
  env: ChatEnv,
  getProviderConfig: (orgId: string) => Promise<LlmProviderConfigRecord>,
  context: ChatContextState,
  options: { includeOpenAiSubscription: boolean },
): Promise<{
  provider: string;
  apiKey?: string;
  awsRegion?: string;
  baseUrl?: string;
  authType?: "bearer" | "x-api-key";
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  modelId?: string;
  openAiSubscription?: {
    accessToken: string;
    accountId: string;
  };
} | null> {
  const record = await getProviderConfig(context.orgId);
  let openAiSubscription:
    | { accessToken: string; accountId: string }
    | undefined;
  if (options.includeOpenAiSubscription) {
    const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId));
    const storedSubscription = await orgStub.getFreshOpenAiSubscription();
    if (storedSubscription) {
      const creds = await decryptCredentials<Record<string, string>>(
        storedSubscription.credentials_encrypted,
        env.INTEGRATION_SECRET_KEY,
      );
      if (creds.access_token && creds.refresh_token && creds.account_id) {
        openAiSubscription = {
          accessToken: creds.access_token,
          accountId: creds.account_id,
        };
      }
    }
  }
  const withSubscription = <T extends { provider: string }>(value: T): T & {
    openAiSubscription?: { accessToken: string; accountId: string };
  } => ({ ...value, ...(openAiSubscription ? { openAiSubscription } : {}) });

  if (!record) {
    return openAiSubscription
      ? { provider: "none", openAiSubscription }
      : null;
  }

  const creds = await decryptCredentials<Record<string, string>>(
    record.credentials_encrypted,
    env.INTEGRATION_SECRET_KEY,
  );
  const config = parseStoredLlmProviderConfig(record.config);

  if (record.provider === "anthropic" && creds.api_key) {
    return withSubscription({ provider: "anthropic", apiKey: creds.api_key });
  }
  if (record.provider === "openai" && creds.api_key) {
    return withSubscription({ provider: "openai", apiKey: creds.api_key });
  }
  if (record.provider === "openrouter" && creds.api_key) {
    return withSubscription({ provider: "openrouter", apiKey: creds.api_key });
  }
  if (record.provider === "custom" && creds.api_key && config.custom_base_url && config.custom_api) {
    return withSubscription({
      provider: "custom",
      apiKey: creds.api_key,
      baseUrl: config.custom_base_url,
      authType: config.custom_auth_type ?? "bearer",
      api: config.custom_api,
      modelId: config.custom_model_id,
    });
  }
  if (record.provider === "bedrock" && creds.bearer_token) {
    return withSubscription({
      provider: "bedrock",
      apiKey: creds.bearer_token,
      awsRegion: config.aws_region,
    });
  }

  return openAiSubscription ? { provider: record.provider, openAiSubscription } : null;
}
