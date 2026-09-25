export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheCreationPerToken?: number;
  cacheReadPerToken?: number;
  tiers?: readonly ModelPricingTier[];
}

export interface ModelPricingTier {
  inputTokensAbove: number;
  inputPerToken: number;
  outputPerToken: number;
  cacheCreationPerToken?: number;
  cacheReadPerToken?: number;
}

export interface UsageTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  reportedCostUsd?: number | null;
  upstreamInferenceCostUsd?: number | null;
}

const SONNET_FALLBACK_MODEL = "claude-sonnet-5";

const modelPricingTable: Record<string, ModelPricing> = {
  "claude-fable-5": {
    inputPerToken: 0.00001,
    outputPerToken: 0.00005,
    cacheCreationPerToken: 0.0000125,
    cacheReadPerToken: 0.000001,
  },
  "anthropic/claude-fable-5": {
    inputPerToken: 0.00001,
    outputPerToken: 0.00005,
    cacheCreationPerToken: 0.0000125,
    cacheReadPerToken: 0.000001,
  },
  "claude-sonnet-5": {
    inputPerToken: 0.000002,
    outputPerToken: 0.00001,
    cacheCreationPerToken: 0.0000025,
    cacheReadPerToken: 0.0000002,
  },
  "anthropic/claude-sonnet-5": {
    inputPerToken: 0.000002,
    outputPerToken: 0.00001,
    cacheCreationPerToken: 0.0000025,
    cacheReadPerToken: 0.0000002,
  },
  "claude-opus-5": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-5": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic.claude-opus-5": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "claude-opus-4-8": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-4.8": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-4-8": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "claude-opus-4-7": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-4.7": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-4-7": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "claude-opus-4-6": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-4.6": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "anthropic/claude-opus-4-6": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "claude-sonnet-4-6": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "anthropic/claude-sonnet-4.6": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "claude-opus-4-5-20251101": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "claude-sonnet-4-5-20250929": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "claude-haiku-4-5-20251001": {
    inputPerToken: 0.000001,
    outputPerToken: 0.000005,
    cacheCreationPerToken: 0.00000125,
    cacheReadPerToken: 0.0000001,
  },
  "anthropic/claude-haiku-4.5": {
    inputPerToken: 0.000001,
    outputPerToken: 0.000005,
    cacheCreationPerToken: 0.00000125,
    cacheReadPerToken: 0.0000001,
  },
  "claude-sonnet-4-20250514": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "claude-opus-4-20250514": {
    inputPerToken: 0.000005,
    outputPerToken: 0.000025,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
  },
  "claude-3-5-sonnet-20241022": {
    inputPerToken: 0.000003,
    outputPerToken: 0.000015,
    cacheCreationPerToken: 0.00000375,
    cacheReadPerToken: 0.0000003,
  },
  "claude-3-5-haiku-20241022": {
    inputPerToken: 0.000001,
    outputPerToken: 0.000005,
    cacheCreationPerToken: 0.00000125,
    cacheReadPerToken: 0.0000001,
  },
  "gpt-5.5": {
    inputPerToken: 0.000005,
    outputPerToken: 0.00003,
    cacheReadPerToken: 0.0000005,
    tiers: [
      {
        inputTokensAbove: 272_000,
        inputPerToken: 0.00001,
        outputPerToken: 0.000045,
        cacheReadPerToken: 0.000001,
      },
    ],
  },
  "gpt-5.6-sol": {
    inputPerToken: 0.000005,
    outputPerToken: 0.00003,
    cacheCreationPerToken: 0.00000625,
    cacheReadPerToken: 0.0000005,
    tiers: [
      {
        inputTokensAbove: 272_000,
        inputPerToken: 0.00001,
        outputPerToken: 0.000045,
        cacheCreationPerToken: 0.0000125,
        cacheReadPerToken: 0.000001,
      },
    ],
  },
  "gpt-5.6-terra": {
    inputPerToken: 0.000002,
    outputPerToken: 0.000012,
    cacheCreationPerToken: 0.0000025,
    cacheReadPerToken: 0.0000002,
    tiers: [
      {
        inputTokensAbove: 272_000,
        inputPerToken: 0.000004,
        outputPerToken: 0.000018,
        cacheCreationPerToken: 0.000005,
        cacheReadPerToken: 0.0000004,
      },
    ],
  },
  "gpt-5.6-luna": {
    inputPerToken: 0.0000002,
    outputPerToken: 0.0000012,
    cacheCreationPerToken: 0.00000025,
    cacheReadPerToken: 0.00000002,
    tiers: [
      {
        inputTokensAbove: 272_000,
        inputPerToken: 0.0000004,
        outputPerToken: 0.0000018,
        cacheCreationPerToken: 0.0000005,
        cacheReadPerToken: 0.00000004,
      },
    ],
  },
  "custom": {
    inputPerToken: 0,
    outputPerToken: 0,
    cacheReadPerToken: 0,
  },
  "moonshotai/kimi-k2.7-code": {
    inputPerToken: 0.00000074,
    outputPerToken: 0.0000035,
    cacheReadPerToken: 0.00000015,
  },
  "kimi-k2.7-code": {
    inputPerToken: 0.00000074,
    outputPerToken: 0.0000035,
    cacheReadPerToken: 0.00000015,
  },
  "~moonshotai/kimi-latest": {
    inputPerToken: 0.0000007448,
    outputPerToken: 0.000004655,
  },
  "moonshotai/kimi-k2.6": {
    inputPerToken: 0.0000007448,
    outputPerToken: 0.000004655,
  },
  "kimi-k2.6": {
    inputPerToken: 0.0000007448,
    outputPerToken: 0.000004655,
  },
  "x-ai/grok-4.5": {
    inputPerToken: 0.000002,
    outputPerToken: 0.000006,
    cacheReadPerToken: 0.0000005,
  },
  "grok-4.5": {
    inputPerToken: 0.000002,
    outputPerToken: 0.000006,
    cacheReadPerToken: 0.0000005,
  },
  // OpenRouter /api/v1/models pricing snapshot, 2026-09-23.
  "z-ai/glm-5.3": {
    inputPerToken: 0.00000084,
    outputPerToken: 0.00000264,
    cacheReadPerToken: 0.000000156,
  },
  "glm-5.3": {
    inputPerToken: 0.00000084,
    outputPerToken: 0.00000264,
    cacheReadPerToken: 0.000000156,
  },
  "z-ai/glm-5.2": {
    inputPerToken: 0.0000012,
    outputPerToken: 0.0000041,
    cacheReadPerToken: 0.0000002,
  },
  "glm-5.2": {
    inputPerToken: 0.0000012,
    outputPerToken: 0.0000041,
    cacheReadPerToken: 0.0000002,
  },
  "google/gemini-3-flash-preview": {
    inputPerToken: 0.0000005,
    outputPerToken: 0.000003,
    cacheCreationPerToken: 0.00000008333333333333334,
    cacheReadPerToken: 0.00000005,
  },
  "gemini-3-flash-preview": {
    inputPerToken: 0.0000005,
    outputPerToken: 0.000003,
    cacheCreationPerToken: 0.00000008333333333333334,
    cacheReadPerToken: 0.00000005,
  },
  "google/gemini-3.5-flash": {
    inputPerToken: 0.0000015,
    outputPerToken: 0.000009,
    cacheCreationPerToken: 0.00000008333333333333334,
    cacheReadPerToken: 0.00000015,
  },
  "gemini-3.5-flash": {
    inputPerToken: 0.0000015,
    outputPerToken: 0.000009,
    cacheCreationPerToken: 0.00000008333333333333334,
    cacheReadPerToken: 0.00000015,
  },
  "google/gemini-3.1-pro-preview": {
    inputPerToken: 0.000002,
    outputPerToken: 0.000012,
    cacheCreationPerToken: 0.000000375,
    cacheReadPerToken: 0.0000002,
  },
  "gemini-3.1-pro-preview": {
    inputPerToken: 0.000002,
    outputPerToken: 0.000012,
    cacheCreationPerToken: 0.000000375,
    cacheReadPerToken: 0.0000002,
  },
  "deepseek/deepseek-v4-pro": {
    inputPerToken: 0.000000435,
    outputPerToken: 0.00000087,
    cacheReadPerToken: 0.000000003625,
  },
  "deepseek-v4-pro": {
    inputPerToken: 0.000000435,
    outputPerToken: 0.00000087,
    cacheReadPerToken: 0.000000003625,
  },
  "deepseek-v4-auto": {
    inputPerToken: 0.000000435,
    outputPerToken: 0.00000087,
    cacheReadPerToken: 0.000000003625,
  },
  "deepseek/deepseek-v4-flash": {
    inputPerToken: 0.00000014,
    outputPerToken: 0.00000028,
    cacheReadPerToken: 0.0000000028,
  },
  "deepseek-v4-flash": {
    inputPerToken: 0.00000014,
    outputPerToken: 0.00000028,
    cacheReadPerToken: 0.0000000028,
  },
};

export function normalizePricingModel(model: string): string {
  let normalized = model.trim();
  normalized = normalized.endsWith(":nitro")
    ? normalized.slice(0, -":nitro".length)
    : normalized;
  while (true) {
    const before = normalized;
    for (const prefix of [
      "camel/",
      "camelai-openrouter/",
      "openrouter/",
      "openai/",
      "openai.",
    ]) {
      if (normalized.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length);
      }
    }
    if (normalized === before) return normalized;
  }
}

export function lookupPricing(model: string): ModelPricing {
  return lookupPricingOrNull(model) ?? modelPricingTable[SONNET_FALLBACK_MODEL];
}

/**
 * Resolve pricing only when the model is explicitly known. Unlike
 * `lookupPricing`, this helper never applies the compatibility Sonnet fallback
 * and is therefore safe to use as an accounting authority for hard limits.
 */
export function lookupPricingOrNull(model: string): ModelPricing | null {
  if (modelPricingTable[model]) return modelPricingTable[model];
  const normalized = normalizePricingModel(model);
  if (modelPricingTable[normalized]) return modelPricingTable[normalized];

  if (normalized.startsWith("gpt-5.6-terra")) {
    return modelPricingTable["gpt-5.6-terra"];
  }
  if (normalized.startsWith("gpt-5.6-luna")) {
    return modelPricingTable["gpt-5.6-luna"];
  }
  if (normalized.startsWith("gpt-5.6-sol") || normalized === "gpt-5.6") {
    return modelPricingTable["gpt-5.6-sol"];
  }
  if (normalized.startsWith("gpt-5.5")) return modelPricingTable["gpt-5.5"];
  if (normalized.startsWith("gpt-5.4")) {
    return modelPricingTable["gpt-5.6-terra"];
  }
  if (normalized.includes("claude-fable-5")) {
    return modelPricingTable["claude-fable-5"];
  }
  if (normalized.includes("claude-sonnet-5")) {
    return modelPricingTable["claude-sonnet-5"];
  }
  if (normalized.includes("claude-opus-5")) {
    return modelPricingTable["claude-opus-5"];
  }
  if (
    normalized.includes("claude-opus-4.8") ||
    normalized.includes("claude-opus-4-8")
  ) {
    return modelPricingTable["claude-opus-4-8"];
  }
  if (
    normalized.includes("claude-opus-4.7") ||
    normalized.includes("claude-opus-4-7")
  ) {
    return modelPricingTable["claude-opus-4-7"];
  }
  if (
    normalized.includes("claude-opus-4.6") ||
    normalized.includes("claude-opus-4-6")
  ) {
    return modelPricingTable["claude-opus-4-6"];
  }
  if (
    normalized.includes("claude-sonnet-4.6") ||
    normalized.includes("claude-sonnet-4-6")
  ) {
    return modelPricingTable["claude-sonnet-4-6"];
  }
  if (normalized.includes("kimi-k2.7-code")) {
    return modelPricingTable["moonshotai/kimi-k2.7-code"];
  }
  if (normalized.includes("kimi-k2.6") || normalized.includes("kimi-latest")) {
    return modelPricingTable["~moonshotai/kimi-latest"];
  }
  if (normalized.includes("grok-4.5")) return modelPricingTable["x-ai/grok-4.5"];
  if (normalized.includes("grok-4.3")) return modelPricingTable["x-ai/grok-4.5"];
  if (normalized.includes("glm-5.3")) return modelPricingTable["z-ai/glm-5.3"];
  if (normalized.includes("glm-5.2")) return modelPricingTable["z-ai/glm-5.2"];
  if (normalized.includes("deepseek-v4-auto")) {
    return modelPricingTable["deepseek-v4-auto"];
  }
  if (normalized.includes("deepseek-v4-pro")) {
    return modelPricingTable["deepseek/deepseek-v4-pro"];
  }
  if (normalized.includes("deepseek-v4-flash")) {
    return modelPricingTable["deepseek/deepseek-v4-flash"];
  }
  if (
    normalized.includes("claude-haiku-4.5") ||
    normalized.includes("claude-haiku-4-5")
  ) {
    return modelPricingTable["anthropic/claude-haiku-4.5"];
  }
  if (normalized.includes("gemini-3.5-flash")) {
    return modelPricingTable["google/gemini-3.5-flash"];
  }
  if (normalized.includes("gemini-3.1-pro-preview")) {
    return modelPricingTable["google/gemini-3.1-pro-preview"];
  }
  if (normalized.includes("gemini-3-flash-preview")) {
    return modelPricingTable["google/gemini-3-flash-preview"];
  }
  return null;
}

export function calculateUsageCostUsd(usage: UsageTokens): number {
  const basePricing = lookupPricing(usage.model);
  const totalPromptTokens =
    Math.max(0, usage.inputTokens) +
    Math.max(0, usage.cacheCreationInputTokens) +
    Math.max(0, usage.cacheReadInputTokens);
  const pricing =
    basePricing.tiers
      ?.filter((tier) => totalPromptTokens > tier.inputTokensAbove)
      .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ??
    basePricing;
  return (
    Math.max(0, usage.inputTokens) * pricing.inputPerToken +
    Math.max(0, usage.outputTokens) * pricing.outputPerToken +
    Math.max(0, usage.cacheCreationInputTokens) *
      (pricing.cacheCreationPerToken ?? 0) +
    Math.max(0, usage.cacheReadInputTokens) * (pricing.cacheReadPerToken ?? 0)
  );
}

export function calculateEffectiveUsageCostUsd(usage: UsageTokens): number {
  if (
    usage.reportedCostUsd !== null &&
    usage.reportedCostUsd !== undefined &&
    usage.reportedCostUsd > 0
  ) {
    return usage.reportedCostUsd;
  }
  if (
    usage.upstreamInferenceCostUsd !== null &&
    usage.upstreamInferenceCostUsd !== undefined &&
    usage.upstreamInferenceCostUsd > 0
  ) {
    return usage.upstreamInferenceCostUsd;
  }
  return calculateUsageCostUsd(usage);
}
