import type { Model } from "@earendil-works/pi-ai";

const DEFAULT_REGION = "us-east-1";

type AnthropicMantleMetadata = Pick<
  Model<"anthropic-messages">,
  | "name"
  | "compat"
  | "reasoning"
  | "thinkingLevelMap"
  | "input"
  | "cost"
  | "contextWindow"
  | "maxTokens"
>;

export function buildBedrockPiModel(
  modelId: string,
  region: string = DEFAULT_REGION,
): Model<"anthropic-messages"> {
  const mantleModelId = toMantleAnthropicModelId(modelId);
  const metadata = anthropicMantleMetadata(mantleModelId);
  return {
    id: mantleModelId,
    name: metadata.name,
    api: "anthropic-messages",
    provider: "custom",
    baseUrl: `https://bedrock-mantle.${region}.api.aws/anthropic`,
    reasoning: metadata.reasoning,
    thinkingLevelMap: metadata.thinkingLevelMap,
    input: metadata.input,
    cost: metadata.cost,
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
    headers: {
      "anthropic-dangerous-direct-browser-access": "true",
    },
    compat: {
      ...metadata.compat,
      supportsEagerToolInputStreaming: false,
    },
  };
}

function toMantleAnthropicModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes("fable-5")) return "anthropic.claude-fable-5-1";
  if (
    normalized.includes("opus-5") ||
    normalized.includes("opus-4-8") ||
    normalized.includes("opus-4.8") ||
    normalized.includes("opus-4-7") ||
    normalized.includes("opus-4.7")
  ) {
    return "anthropic.claude-opus-5-5";
  }
  if (normalized.includes("sonnet-5")) return "anthropic.claude-sonnet-5-5";
  if (normalized.includes("haiku-4-5") || normalized.includes("haiku-4.5")) {
    return "anthropic.claude-haiku-4-5";
  }
  if (normalized.startsWith("anthropic.")) return normalized;
  if (normalized.startsWith("global.anthropic.")) {
    return normalized.slice("global.".length);
  }
  return `anthropic.${modelId}`;
}

function anthropicMantleMetadata(modelId: string): AnthropicMantleMetadata {
  if (modelId.includes("claude-fable-5")) {
    return {
      name: "Claude Fable 5.1",
      compat: { forceAdaptiveThinking: true },
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh" },
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
  }
  if (modelId.includes("claude-opus-5")) {
    return {
      name: "Claude Opus 5.5",
      compat: {
        forceAdaptiveThinking: true,
        supportsTemperature: false,
      },
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      input: ["text", "image"],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
  }
  if (modelId.includes("claude-haiku-4-5")) {
    return {
      name: "Claude Haiku 4.5",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    };
  }
  return {
    name: "Claude Sonnet 5.5",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  };
}
