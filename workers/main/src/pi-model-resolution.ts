// Pure Pi model/provider mapping helpers (OpenRouter / Bedrock / custom
// provider model-id and header derivation) extracted from chat-thread-do.ts.
// Stateless: grouped as a class so the verbatim methods keep calling each other
// via `this`. The stateful resolution orchestrators (resolvePiModel,
// resolvePiRequestConfig, getCachedLlmProviderConfig, resolveCurrentByokCredentials)
// remain on ChatThreadDO and call into a PiModelMapping instance.
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_LLM_MODEL,
  getBedrockOpenAiModelRegions,
  normalizeLlmModel,
} from "../../../src/lib/llm-provider-config";
import type { PiHeaderValue, PiResolvedModelReference } from "./chat-thread-do";

// This is the public client-side contract for the AWS RTX Flash pool. It is
// mirrored by the router's /router/capabilities endpoint. The working limit
// deliberately leaves room for the vLLM chat template and tool schemas.
const DEEPSEEK_V4_FLASH_RTX_PROFILE = {
  name: "deepseek-v4-flash-rtx" as const,
  contextWindow: 220_000,
  // This is the RTX service's real maximum output for an empty prompt. Pi's
  // compaction reserve remains independently bounded; this must not become an
  // artificial 32k generation limit for clients that need a longer response.
  maxTokens: 262_144,
  reasoning: true,
  supportsReasoningEffort: true,
  thinkingFormat: "openai" as const,
};

export class PiModelMapping {
  resolvePiModelReference(modelId: string): PiResolvedModelReference {
    const normalizedModelId = this.normalizePiModelId(modelId);
    const claudeReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "anthropic",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(this.openRouterClaudeModel(resolvedModelId)),
    });
    const openRouterReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "openrouter",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(resolvedModelId),
    });
    const openRouterResponsesReference = (resolvedModelId: string): PiResolvedModelReference => ({
      ...openRouterReference(resolvedModelId),
      api: "openai-responses",
    });
    const openAiReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "openai",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(`openai/${resolvedModelId}`),
    });
    switch (normalizedModelId) {
      case "haiku":
        return claudeReference("claude-haiku-4-5-20251001");
      case "opus":
      case "opus-4.7":
      case "opus-4.8":
      case "opus-5":
        return claudeReference("claude-opus-5");
      case "fable-5":
        return claudeReference("claude-fable-5");
      case "sonnet":
        return claudeReference("claude-sonnet-5");
      case "gpt-5.6-sol":
      case "gpt-5.6-terra":
      case "gpt-5.6-luna":
        return openAiReference(normalizedModelId);
      case "gpt-5.6-sol-bedrock":
        return openAiReference("gpt-5.6-sol");
      case "gpt-5.6-terra-bedrock":
        return openAiReference("gpt-5.6-terra");
      case "custom":
        return openAiReference(DEFAULT_OPENAI_MODEL);
      case "kimi-k2.7-code":
        return openRouterReference("moonshotai/kimi-k2.7-code");
      case "grok-4.5":
        return openRouterResponsesReference("x-ai/grok-4.5");
      case "glm-5.3":
        return openRouterReference("z-ai/glm-5.3");
      case "gemini-3.5-flash":
        return openRouterReference("google/gemini-3.5-flash");
      case "gemini-3-flash-preview":
        return openRouterReference("google/gemini-3-flash-preview");
      case "gemini-3.1-pro-preview":
        return openRouterReference("google/gemini-3.5-flash");
      case "deepseek-v4-pro":
        // Hosted traffic goes through the AI Gateway dynamic route so Gateway
        // can try Azure first and fall back to OpenRouter; BYOK OpenRouter uses
        // the native OpenRouter Pro id from `modelId`.
        return {
          ...openRouterReference("deepseek/deepseek-v4-pro"),
          hostedGatewayProvider: "compat",
          hostedModelId: "dynamic/deepseek-v4-pro-fallback",
          hostedReasoningEffort: "xhigh",
        };
      case "deepseek-v4-auto":
        // Keep the persisted/public camelCode id stable while its hosted
        // backend uses the existing Luna-over-OpenRouter route. This lets old
        // threads and free-mode fallbacks move off the self-hosted DeepSeek
        // pool without a thread-model migration.
        //
        // Hosted traffic goes through an AI Gateway dynamic route so the
        // gateway falls back to Muse Spark when Luna's endpoints are rate
        // limited. Every available Luna endpoint in a region can be the same
        // provider, so a model-level fallback is the only reliable escape.
        // Dynamic routes are reachable only through the gateway's
        // /compat/chat/completions endpoint, so this tier uses the completions
        // shape like the other two hosted fallback routes.
        return {
          ...openAiReference("gpt-5.6-luna"),
          byokAllowed: false,
          api: "openai-completions",
          hostedGatewayProvider: "compat",
          hostedModelId: "dynamic/luna-muse-fallback",
        };
      case "deepseek-v4-flash":
        return {
          ...openRouterReference("deepseek/deepseek-v4-flash"),
          hostedGatewayProvider: "compat",
          hostedModelId: "dynamic/deepseek-v4-flash-fallback",
          hostedStickyRouting: true,
          hostedReasoningEffort: "xhigh",
          hostedRequestProfile: DEEPSEEK_V4_FLASH_RTX_PROFILE,
        };
      default:
        if (normalizedModelId.includes("/")) {
          return openRouterReference(normalizedModelId);
        }
        return openAiReference(DEFAULT_OPENAI_MODEL);
    }
  }

  normalizePiModelId(modelId: string): string {
    const trimmed = modelId.trim();
    const normalized = trimmed;
    const lower = normalized.toLowerCase();
    if (lower === "claude-fable-5") {
      return "fable-5";
    }
    if (
      lower === "kimi-k2.6" ||
      lower === "kimi-latest" ||
      lower === "~moonshotai/kimi-latest" ||
      lower === "moonshotai/kimi-latest" ||
      lower === "moonshotai/kimi-k2.6"
    ) {
      return "kimi-k2.7-code";
    }
    if (
      lower === "grok-4.3" ||
      lower === "grok-latest" ||
      lower === "x-ai/grok-4.3" ||
      lower === "x-ai/grok-latest"
    ) {
      return "grok-4.5";
    }
    if (
      lower === "glm-5.2" ||
      lower === "glm-latest" ||
      lower === "z-ai/glm-5.2" ||
      lower === "z-ai/glm-latest"
    ) {
      return "glm-5.3";
    }
    return normalized;
  }

  openRouterAttributionHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://camelai.dev",
      "X-OpenRouter-Title": "camelAI",
      "X-OpenRouter-Categories": "cloud-agent,programming-app",
    };
  }

  requestyAttributionHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://camelai.dev",
      "X-Title": "camelAI",
    };
  }

  customProviderAuthHeaders(
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
    authType: "bearer" | "x-api-key",
    apiKey: string,
  ): Record<string, PiHeaderValue> | undefined {
    if (api === "anthropic-messages") {
      return authType === "bearer"
        ? { "x-api-key": null, Authorization: `Bearer ${apiKey}` }
        : undefined;
    }

    return authType === "x-api-key"
      ? { Authorization: null, "x-api-key": apiKey }
      : undefined;
  }

  resolveCustomProviderModelReference(
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
    requestedModelId: string,
    customModelId: string | undefined,
  ): { provider: string; lookupModelId: string; requestModelId: string } {
    const model = normalizeLlmModel(this.normalizePiModelId(requestedModelId), "custom", {
      customApi: api,
      customModelId,
    });
    if (model === "custom" && customModelId?.trim()) {
      const lookupModel =
        api === "anthropic-messages" ? DEFAULT_LLM_MODEL : DEFAULT_OPENAI_MODEL;
      const lookupReference = this.resolvePiModelReference(lookupModel);
      return {
        provider: lookupReference.provider,
        lookupModelId: lookupReference.modelId,
        requestModelId: customModelId.trim(),
      };
    }
    const reference = this.resolvePiModelReference(model);
    return {
      provider: reference.provider,
      lookupModelId: reference.modelId,
      requestModelId: reference.modelId,
    };
  }

  openRouterClaudeModel(model: string): string {
    switch (model.trim().toLowerCase()) {
      case "sonnet":
        return "anthropic/claude-sonnet-5";
      case "fable-5":
      case "claude-fable-5":
        return "anthropic/claude-fable-5";
      case "haiku":
        return "anthropic/claude-haiku-4.5";
      case "opus":
      case "opus-4.7":
      case "opus-4.8":
      case "opus-5":
      case "claude-opus-5":
      case "claude-opus-4-8":
      case "claude-opus-4.8":
      case "claude-opus-4-7":
      case "claude-opus-4.7":
      case "claude-opus-4-6":
      case "claude-opus-4.6":
        return "anthropic/claude-opus-5";
      case "claude-sonnet-5":
        return "anthropic/claude-sonnet-5";
      case "claude-sonnet-4-6":
        return "anthropic/claude-sonnet-4.6";
      case "claude-sonnet-4-5-20250929":
        return "anthropic/claude-sonnet-4.5";
      case "claude-haiku-4-5-20251001":
        return "anthropic/claude-haiku-4.5";
      case "claude-opus-4-5-20251101":
        return "anthropic/claude-opus-4.5";
      case "claude-sonnet-4-20250514":
        return "anthropic/claude-sonnet-4";
      case "claude-opus-4-20250514":
        return "anthropic/claude-opus-4";
      case "claude-3-7-sonnet-20250219":
        return "anthropic/claude-3.7-sonnet";
      case "claude-3-5-sonnet-20241022":
      case "claude-3-5-sonnet-20240620":
        return "anthropic/claude-3.5-sonnet";
      case "claude-3-5-haiku-20241022":
        return "anthropic/claude-3.5-haiku";
      default:
        return model;
    }
  }

  openRouterNitroModel(model: string): string {
    const trimmed = model.trim();
    if (!trimmed) return model;
    const lower = trimmed.toLowerCase();
    if (
      lower === "openai/gpt-5.6-luna" ||
      lower.startsWith("dynamic/") ||
      lower.startsWith("google/gemini-") ||
      lower.startsWith("deepseek/deepseek-v4-") ||
      lower.startsWith("anthropic/claude-opus-") ||
      lower.endsWith(":nitro")
    ) {
      return trimmed;
    }
    const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (lastSegment.includes(":")) {
      return trimmed;
    }
    return `${trimmed}:nitro`;
  }

  // Requesty serves the catalog models under its managed model ids. Anything
  // without a managed id (for example raw vendor/model ids) passes through.
  requestyModel(modelId: string): string {
    switch (modelId.trim().toLowerCase()) {
      case "claude-haiku-4-5-20251001":
        return "claude-haiku-4-5";
      case "moonshotai/kimi-k2.7-code":
        return "kimi-k2.7-code";
      case "x-ai/grok-4.5":
        return "grok-4.5";
      case "z-ai/glm-5.3":
        return "glm-5.3";
      case "google/gemini-3.5-flash":
        return "gemini-3.5-flash";
      case "deepseek/deepseek-v4-pro":
        return "deepseek-v4-pro";
      case "deepseek/deepseek-v4-flash":
        return "deepseek-v4-flash";
      default:
        return modelId.trim();
    }
  }

  bedrockClaudeModel(modelId: string): string {
    switch (modelId) {
      case "claude-haiku-4-5-20251001":
        return "anthropic.claude-haiku-4-5";
      case "claude-opus-5":
        return "anthropic.claude-opus-5";
      case "claude-fable-5":
        return "anthropic.claude-fable-5";
      case "claude-opus-4-6":
      case "claude-opus-4-7":
      case "claude-opus-4-8":
        return "anthropic.claude-opus-5";
      case "claude-sonnet-5":
        return "anthropic.claude-sonnet-5";
      case "claude-sonnet-4-6":
      default:
        return "anthropic.claude-sonnet-5";
    }
  }

  bedrockAnthropicMessagesBaseUrl(region: string | undefined): string | undefined {
    const normalized = region?.trim() || "us-east-1";
    if (!/^[a-z0-9-]+$/.test(normalized)) return undefined;
    return `https://bedrock-mantle.${normalized}.api.aws/anthropic`;
  }

  bedrockOpenAiModelConfig(
    modelId: string,
    region: string | undefined,
  ): { modelId: string; baseUrl: string } | null {
    const normalizedModel = modelId.trim().toLowerCase();
    const normalizedRegion = region?.trim() || "us-east-1";
    if (!/^[a-z0-9-]+$/.test(normalizedRegion)) {
      throw new Error(`Invalid Bedrock AWS region: ${normalizedRegion}`);
    }
    const catalogModel = `${normalizedModel}-bedrock` as Parameters<
      typeof getBedrockOpenAiModelRegions
    >[0];
    const selectedRegion = getBedrockOpenAiModelRegions(
      catalogModel,
      normalizedRegion,
    )[0];
    if (!selectedRegion) return null;

    return {
      modelId: `openai.${normalizedModel}`,
      baseUrl: `https://bedrock-mantle.${selectedRegion}.api.aws/openai/v1`,
    };
  }

  bedrockRegionalBaseUrls(modelId: string, baseUrl: string): readonly string[] {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      return [baseUrl];
    }
    const match = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/.exec(parsed.hostname);
    if (!match) return [baseUrl];

    const currentRegion = match[1];
    const normalizedModel = modelId.trim().toLowerCase().replace(/^openai\./, "");
    const catalogModel = `${normalizedModel}-bedrock` as Parameters<
      typeof getBedrockOpenAiModelRegions
    >[0];
    const openAiRegions = getBedrockOpenAiModelRegions(catalogModel, currentRegion);
    const regions = openAiRegions.length > 0
      ? openAiRegions
      : [
          currentRegion,
          ...["us-east-1", "us-east-2", "us-west-2"].filter(
            (region) => region !== currentRegion,
          ),
        ];

    return regions.map((region) => {
      const candidate = new URL(parsed);
      candidate.hostname = `bedrock-mantle.${region}.api.aws`;
      return candidate.toString().replace(/\/$/, "");
    });
  }

}
