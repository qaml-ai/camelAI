import type {
  LlmModel,
  LlmProvider,
} from "../types";
import {
  CUSTOM_LLM_MODEL,
  getVisibleLlmModelOptions,
  type CustomLlmProviderApi,
} from "./llm-provider-config";
import type { EffectiveModelPickerConfig } from "./model-picker-config";

// Adding a new model - checklist
//
// 1. Add the canonical ID to the LlmModel union in src/types.ts.
// 2. Add model visibility/routing branches in src/lib/llm-provider-config.ts:
//    isLlmModel, isLlmModelAllowedForOrgProvider, and the model option lists.
// 3. Add per-token pricing in src/lib/usage-pricing.ts.
// 4. Add a MODEL_CATALOG entry below with a version-qualified label, logo type,
//    provider order, cost bucket, intelligence, and speed.
// 5. Add or update catalog tests so model picker platform defaults include it.
// 6. Add or update the catalog tests so the TS catalog, logos, and pricing do
//    not drift apart.

export type ProviderLogoType =
  | "camelai"
  | "claude"
  | "openai"
  | "kimi"
  | "grok"
  | "glm"
  | "gemini"
  | "deepseek";
export type CostBucket = "Free" | "$" | "$$" | "$$$" | "$$$$" | "$$$$$";
export const COST_BUCKET_MAX = 5;
// Half-step rating, 0.5 through 5.0. Used for both intelligence and speed.
// Renders as 5 circles in the model picker hover tooltip.
export type RatingScore =
  | 0.5
  | 1
  | 1.5
  | 2
  | 2.5
  | 3
  | 3.5
  | 4
  | 4.5
  | 5;

export interface ModelCatalogEntry {
  id: LlmModel;
  label: string;
  providerLogo: ProviderLogoType;
  providerOrder: number;
  modelOrder: number;
  cost: CostBucket;
  intelligence: RatingScore;
  speed: RatingScore;
}

export const LLM_MODEL_TO_PRICING_KEY: Readonly<Record<LlmModel, string>> = {
  "opus-5": "claude-opus-5",
  "fable-5": "claude-fable-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.6-sol-bedrock": "gpt-5.6-sol",
  "gpt-5.6-terra-bedrock": "gpt-5.6-terra",
  custom: "custom",
  "kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
  "grok-4.5": "grok-4.5",
  "glm-5.3": "z-ai/glm-5.3",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gemini-3-flash-preview": "google/gemini-3-flash-preview",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-auto": "deepseek-v4-auto",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
};

// Cost buckets are derived by hand from per-token pricing in
// src/lib/usage-pricing.ts. If you change pricing there, update the `cost`
// field below in the same PR.
//
// Buckets (USD per million tokens):
//   $     = input < $0.50 AND output < $1
//   $$    = input < $1.50 AND output < $6
//   $$$   = input < $4    AND output < $20
//   $$$$  = input < $10   AND output < $50
//   $$$$$ = input >= $10  OR  output >= $50
export const MODEL_CATALOG: Readonly<Record<LlmModel, ModelCatalogEntry>> = {
  "opus-5": {
    id: "opus-5",
    label: "Opus 5",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 0,
    cost: "$$$$",
    intelligence: 4.5,
    speed: 2,
  },
  "fable-5": {
    id: "fable-5",
    label: "Fable 5",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 1,
    cost: "$$$$$",
    intelligence: 5,
    speed: 2,
  },
  sonnet: {
    id: "sonnet",
    label: "Sonnet 5",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 2,
    cost: "$$$",
    intelligence: 4,
    speed: 3.5,
  },
  haiku: {
    id: "haiku",
    label: "Haiku 4.5",
    providerLogo: "claude",
    providerOrder: 0,
    modelOrder: 3,
    cost: "$$",
    intelligence: 2,
    speed: 5,
  },
  "gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 0,
    cost: "$$$$",
    intelligence: 5,
    speed: 3,
  },
  "gpt-5.6-terra": {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 1,
    cost: "$$$",
    intelligence: 4.5,
    speed: 3.5,
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 2,
    cost: "$",
    intelligence: 4,
    speed: 4.5,
  },
  "gpt-5.6-sol-bedrock": {
    id: "gpt-5.6-sol-bedrock",
    label: "GPT-5.6 Sol Bedrock",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 3,
    cost: "$$$$",
    intelligence: 5,
    speed: 3,
  },
  "gpt-5.6-terra-bedrock": {
    id: "gpt-5.6-terra-bedrock",
    label: "GPT-5.6 Terra Bedrock",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 4,
    cost: "$$$",
    intelligence: 4.5,
    speed: 3.5,
  },
  custom: {
    id: "custom",
    label: "Custom model",
    providerLogo: "openai",
    providerOrder: 1,
    modelOrder: 7,
    cost: "$",
    intelligence: 3,
    speed: 3,
  },
  "gemini-3.5-flash": {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    providerLogo: "gemini",
    providerOrder: 2,
    modelOrder: 0,
    cost: "$$$",
    intelligence: 4,
    speed: 4.5,
  },
  "gemini-3-flash-preview": {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    providerLogo: "gemini",
    providerOrder: 2,
    modelOrder: 1,
    cost: "$$",
    intelligence: 2,
    speed: 5,
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    providerLogo: "deepseek",
    providerOrder: 3,
    modelOrder: 0,
    cost: "$",
    intelligence: 3,
    speed: 3.5,
  },
  "deepseek-v4-auto": {
    id: "deepseek-v4-auto",
    label: "camelCode",
    providerLogo: "camelai",
    providerOrder: 3,
    modelOrder: 1,
    cost: "Free",
    intelligence: 3,
    speed: 3.5,
  },
  "deepseek-v4-flash": {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    providerLogo: "deepseek",
    providerOrder: 3,
    modelOrder: 2,
    cost: "$",
    intelligence: 1.5,
    speed: 5,
  },
  "kimi-k2.7-code": {
    id: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    providerLogo: "kimi",
    providerOrder: 4,
    modelOrder: 0,
    cost: "$$",
    intelligence: 3,
    speed: 3.5,
  },
  "grok-4.5": {
    id: "grok-4.5",
    label: "Grok 4.5",
    providerLogo: "grok",
    providerOrder: 5,
    modelOrder: 0,
    cost: "$$$",
    intelligence: 4,
    speed: 4.5,
  },
  "glm-5.3": {
    id: "glm-5.3",
    label: "GLM 5.3",
    providerLogo: "glm",
    providerOrder: 6,
    modelOrder: 0,
    cost: "$$",
    intelligence: 3.5,
    speed: 3,
  },
};

export const ALL_LLM_MODELS = Object.keys(MODEL_CATALOG) as LlmModel[];

export interface ResolvedModelCatalogEntry extends ModelCatalogEntry {
  addedAt: number;
}

const PINNED_MODEL_IDS = new Set<LlmModel>(["deepseek-v4-auto"]);

export function compareModelCatalogEntries(
  a: ModelCatalogEntry,
  b: ModelCatalogEntry,
): number {
  return (
    Number(PINNED_MODEL_IDS.has(b.id)) - Number(PINNED_MODEL_IDS.has(a.id)) ||
    a.providerOrder - b.providerOrder ||
    a.modelOrder - b.modelOrder ||
    a.label.localeCompare(b.label)
  );
}

export function resolveModelPickerCatalog(args: {
  effectiveConfig: EffectiveModelPickerConfig;
  orgProvider?: LlmProvider | string | null;
  customApi?: CustomLlmProviderApi | null;
  customModelId?: string | null;
  awsRegion?: string | null;
  allowOpenAiSubscription?: boolean;
  allowCamelCode?: boolean;
}): ResolvedModelCatalogEntry[] {
  const visibleModelIds = new Set(
    getVisibleLlmModelOptions(null, {
      orgProvider: args.orgProvider,
      customApi: args.customApi,
      customModelId: args.customModelId,
      awsRegion: args.awsRegion,
      allowOpenAiSubscription: args.allowOpenAiSubscription,
      allowCamelCode: args.allowCamelCode,
    }).map((option) => option.value),
  );

  const sourceModels =
    args.effectiveConfig.use_platform_defaults === false
      ? args.effectiveConfig.models
      : [...visibleModelIds].map((id) => ({ id, added_at: Date.now() }));

  const entries = sourceModels
    .filter((model) => visibleModelIds.has(model.id))
    .map((model) => ({
      ...MODEL_CATALOG[model.id],
      addedAt: model.added_at,
    }))
    .sort(compareModelCatalogEntries);

  if (
    entries.length === 0 &&
    args.effectiveConfig.use_platform_defaults !== false &&
    visibleModelIds.has(CUSTOM_LLM_MODEL)
  ) {
    return [{ ...MODEL_CATALOG[CUSTOM_LLM_MODEL], addedAt: Date.now() }];
  }

  return entries;
}

export function modelCatalogEntriesForIds(
  ids: readonly LlmModel[],
): ModelCatalogEntry[] {
  return ids.map((id) => MODEL_CATALOG[id]).filter(Boolean);
}

export function sortAdditionalModelCatalogEntries(
  entries: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  return [...entries].sort(compareModelCatalogEntries);
}
