import type {
  LlmModel,
  LlmProvider,
  LlmProviderConfigPublic,
} from "../types";
import { decryptCredentials } from "./integration-crypto";

export const DEFAULT_LLM_MODEL: LlmModel = "sonnet";
export const DEFAULT_OPENAI_MODEL: LlmModel = "gpt-5.6-terra";
export const DEFAULT_OPENROUTER_MODEL: LlmModel = "kimi-k2.7-code";
export const CUSTOM_LLM_MODEL: LlmModel = "custom";
export const THREAD_MODEL_LOCK_MESSAGE =
  "This thread is locked to its original model. Start a new thread to use a different model.";

const STORED_LLM_MODEL_REPLACEMENTS: Readonly<Record<string, LlmModel>> = {
  "gemini-3.1-pro-preview": "gemini-3.5-flash",
  "kimi-k2.6": "kimi-k2.7-code",
  "kimi-latest": "kimi-k2.7-code",
  "grok-4.3": "grok-4.5",
  "grok-latest": "grok-4.5",
  opus: "opus-4.8",
  "opus-4.7": "opus-4.8",
};

// When adding a model here, also add it to the picker catalog at
// src/lib/model-catalog.ts and the pricing table at src/lib/usage-pricing.ts.
export const ANTHROPIC_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: "opus-4.8",
    label: "Opus 4.8",
    description: "Flagship coding model",
  },
  {
    value: "fable-5",
    label: "Fable 5",
    description: "Highest-capability Claude model",
  },
  {
    value: "sonnet",
    label: "Sonnet 5",
    description: "Default and recommended",
  },
  { value: "haiku", label: "Haiku 4.5", description: "Faster and cheaper" },
];

export const OPENAI_COMPATIBLE_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    description: "Highest-capability OpenAI model",
  },
  {
    value: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    description: "Default balanced OpenAI model",
  },
  {
    value: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    description: "Efficient high-volume OpenAI reasoning model",
  },
  {
    value: "gpt-5.6-sol-bedrock",
    label: "GPT-5.6 Sol Bedrock",
    description: "GPT-5.6 Sol through Amazon Bedrock",
  },
  {
    value: "gpt-5.6-terra-bedrock",
    label: "GPT-5.6 Terra Bedrock",
    description: "GPT-5.6 Terra through Amazon Bedrock",
  },
  {
    value: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    description: "OpenRouter/camelAI hosted fast high-intelligence coding model",
  },
  {
    value: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    description: "OpenRouter/camelAI hosted fast reasoning model",
  },
  {
    value: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "OpenRouter/camelAI hosted flagship reasoning model",
  },
  {
    value: "deepseek-v4-auto",
    label: "camelCode",
    description: "camelAI hosted model with automatic routing",
  },
  {
    value: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "OpenRouter/camelAI hosted faster and cheaper model",
  },
  {
    value: "kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    description: "OpenRouter/camelAI hosted model",
  },
  {
    value: "grok-4.5",
    label: "Grok 4.5",
    description: "OpenRouter/camelAI hosted model",
  },
  {
    value: "glm-5.2",
    label: "GLM 5.2",
    description: "OpenRouter/camelAI hosted model",
  },
];

export const CUSTOM_LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  {
    value: CUSTOM_LLM_MODEL,
    label: "Custom model",
    description: "Model configured on your custom provider",
  },
];

export const LLM_MODEL_OPTIONS: ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> = [
  ...ANTHROPIC_LLM_MODEL_OPTIONS,
  ...OPENAI_COMPATIBLE_LLM_MODEL_OPTIONS,
  ...CUSTOM_LLM_MODEL_OPTIONS,
];

const OPENROUTER_ONLY_MODELS = new Set<LlmModel>([
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
]);

const CAMELAI_HOSTED_ONLY_MODELS = new Set<LlmModel>([
  "deepseek-v4-auto",
]);

// These hosted models remain metered for operational visibility, but their
// usage does not consume an organization's camelAI credits.
export const CAMEL_CODE_LLM_MODEL = "deepseek-v4-auto" satisfies LlmModel;

const CREDIT_FREE_HOSTED_MODELS = new Set<LlmModel>([
  CAMEL_CODE_LLM_MODEL,
]);

const PINNED_VISIBLE_LLM_MODELS = new Set<LlmModel>([
  CAMEL_CODE_LLM_MODEL,
]);

export function isCreditFreeHostedModel(model: string | null | undefined): boolean {
  return Boolean(model && CREDIT_FREE_HOSTED_MODELS.has(model as LlmModel));
}

function sortVisibleLlmModelOptions<
  T extends { value: LlmModel },
>(options: readonly T[]): T[] {
  return [...options].sort(
    (a, b) =>
      Number(PINNED_VISIBLE_LLM_MODELS.has(b.value)) -
      Number(PINNED_VISIBLE_LLM_MODELS.has(a.value)),
  );
}

const BEDROCK_ONLY_OPENAI_MODELS = new Set<LlmModel>([
  "gpt-5.6-sol-bedrock",
  "gpt-5.6-terra-bedrock",
]);

const BEDROCK_OPENAI_MODEL_REGIONS: Readonly<Record<string, readonly string[]>> = {
  "gpt-5.6-sol-bedrock": ["us-east-1", "us-east-2"],
  "gpt-5.6-terra-bedrock": ["us-east-1", "us-east-2", "us-west-2"],
};

export function isBedrockOpenAiModelAllowedInRegion(
  model: LlmModel,
  awsRegion: string | null | undefined,
): boolean {
  const supportedRegions = BEDROCK_OPENAI_MODEL_REGIONS[model];
  if (!supportedRegions) return false;
  const normalizedRegion = awsRegion?.trim() || "us-east-1";
  return supportedRegions.includes(normalizedRegion);
}

export interface LlmProviderStoredConfig {
  aws_region?: string;
  custom_name?: string;
  custom_base_url?: string;
  custom_auth_type?: "bearer" | "x-api-key";
  custom_api?: "openai-completions" | "openai-responses" | "anthropic-messages";
  custom_model_id?: string;
}

export type CustomLlmProviderApi = NonNullable<
  LlmProviderStoredConfig["custom_api"]
>;

interface LlmProviderModelOptions {
  customApi?: CustomLlmProviderApi | null;
  customModelId?: string | null;
  awsRegion?: string | null;
  allowOpenAiSubscription?: boolean;
  allowCamelCode?: boolean;
}

export function getDefaultLlmModel(
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): LlmModel {
  if (orgProvider === "openai") return DEFAULT_OPENAI_MODEL;
  if (orgProvider === "openrouter") return DEFAULT_OPENROUTER_MODEL;
  if (orgProvider === "custom" && hasCustomModelId(options?.customModelId)) {
    return CUSTOM_LLM_MODEL;
  }
  if (orgProvider === "custom" && isOpenAiCompatibleCustomApi(options?.customApi)) {
    return DEFAULT_OPENAI_MODEL;
  }
  return DEFAULT_LLM_MODEL;
}

export function getLlmModelOptions(
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  if (orgProvider === "custom" && hasCustomModelId(options?.customModelId)) {
    return CUSTOM_LLM_MODEL_OPTIONS;
  }
  return LLM_MODEL_OPTIONS.filter(
    (option) => isLlmModelAllowedForOrgProvider(option.value, orgProvider, options),
  );
}

export function isAnthropicLlmModel(model: unknown): model is LlmModel {
  return ANTHROPIC_LLM_MODEL_OPTIONS.some((option) => option.value === model);
}

export function isOpenAiCompatibleLlmModel(model: unknown): model is LlmModel {
  return OPENAI_COMPATIBLE_LLM_MODEL_OPTIONS.some((option) => option.value === model);
}

export function isLlmModelCoveredByOpenAiSubscription(
  model: LlmModel,
): boolean {
  return (
    isOpenAiCompatibleLlmModel(model) &&
    !OPENROUTER_ONLY_MODELS.has(model) &&
    !BEDROCK_ONLY_OPENAI_MODELS.has(model) &&
    !CAMELAI_HOSTED_ONLY_MODELS.has(model)
  );
}

export function getVisibleLlmModelOptions(
  includeModel?: LlmModel | null,
  options?: {
    orgProvider?: string | null;
    customApi?: CustomLlmProviderApi | null;
    customModelId?: string | null;
    awsRegion?: string | null;
    allowOpenAiSubscription?: boolean;
    allowCamelCode?: boolean;
  },
): ReadonlyArray<{
  value: LlmModel;
  label: string;
  description: string;
}> {
  const baseOptions = getLlmModelOptions(options?.orgProvider, {
    customApi: options?.customApi,
    customModelId: options?.customModelId,
    awsRegion: options?.awsRegion,
    allowOpenAiSubscription: options?.allowOpenAiSubscription,
    allowCamelCode: options?.allowCamelCode,
  });
  const visibleOptions = sortVisibleLlmModelOptions(baseOptions);

  if (
    !includeModel ||
    visibleOptions.some((option) => option.value === includeModel)
  ) {
    return visibleOptions;
  }

  // Retained thread models may bypass the provider catalog so an existing
  // hosted thread can remain usable after an admin changes picker settings.
  // Runtime exclusions are different: self-host must never re-add camelCode
  // merely because a legacy thread still has it stored.
  if (
    !isLlmModelAllowedForOrgProvider(includeModel, options?.orgProvider, {
      customApi: options?.customApi,
      customModelId: options?.customModelId,
      awsRegion: options?.awsRegion,
      allowOpenAiSubscription: options?.allowOpenAiSubscription,
      allowCamelCode: options?.allowCamelCode,
    })
  ) {
    return visibleOptions;
  }

  const fallbackOption = [
    ...OPENAI_COMPATIBLE_LLM_MODEL_OPTIONS,
    ...ANTHROPIC_LLM_MODEL_OPTIONS,
  ].find((option) => option.value === includeModel);

  return fallbackOption
    ? sortVisibleLlmModelOptions([fallbackOption, ...visibleOptions])
    : visibleOptions;
}

export function isLlmModelAllowedForNewThread(
  value: unknown,
  orgProvider: string | null | undefined,
  options?: LlmProviderModelOptions,
): value is LlmModel {
  return (
    isLlmModel(value) &&
    isLlmModelAllowedForOrgProvider(value, orgProvider, options)
  );
}

export function isLlmModel(value: unknown): value is LlmModel {
  return (
    isOpenAiCompatibleLlmModel(value) ||
    isAnthropicLlmModel(value) ||
    value === CUSTOM_LLM_MODEL
  );
}

export function isLlmModelAllowedForOrgProvider(
  model: LlmModel,
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): boolean {
  if (
    options?.allowOpenAiSubscription &&
    isLlmModelCoveredByOpenAiSubscription(model)
  ) {
    return true;
  }
  if (model === CAMEL_CODE_LLM_MODEL) {
    return options?.allowCamelCode !== false;
  }
  if (CAMELAI_HOSTED_ONLY_MODELS.has(model) && orgProvider) {
    return false;
  }
  if (orgProvider === "openai") {
    return isOpenAiCompatibleLlmModel(model) &&
      !OPENROUTER_ONLY_MODELS.has(model) &&
      !BEDROCK_ONLY_OPENAI_MODELS.has(model);
  }
  if (orgProvider === "anthropic") {
    return isAnthropicLlmModel(model);
  }
  if (orgProvider === "bedrock") {
    return isAnthropicLlmModel(model) ||
      BEDROCK_ONLY_OPENAI_MODELS.has(model) &&
        isBedrockOpenAiModelAllowedInRegion(model, options?.awsRegion);
  }
  if (orgProvider === "custom") {
    if (model === CUSTOM_LLM_MODEL) {
      return hasCustomModelId(options?.customModelId);
    }
    if (options?.customApi === "anthropic-messages") {
      return isAnthropicLlmModel(model);
    }
    if (isOpenAiCompatibleCustomApi(options?.customApi)) {
      return isOpenAiCompatibleLlmModel(model) &&
        !OPENROUTER_ONLY_MODELS.has(model) &&
        !BEDROCK_ONLY_OPENAI_MODELS.has(model);
    }
    return !BEDROCK_ONLY_OPENAI_MODELS.has(model);
  }
  if (OPENROUTER_ONLY_MODELS.has(model)) {
    return orgProvider !== "openai";
  }
  if (BEDROCK_ONLY_OPENAI_MODELS.has(model)) return false;
  if (model === CUSTOM_LLM_MODEL) return false;
  return true;
}

export function isLlmModelCoveredByByokProvider(
  model: LlmModel | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!provider) return false;
  if (!model) return true;
  if (provider === "openrouter") return true;
  if (provider === "anthropic") {
    return isAnthropicLlmModel(model);
  }
  if (provider === "bedrock") {
    return isAnthropicLlmModel(model) ||
      BEDROCK_ONLY_OPENAI_MODELS.has(model) &&
        isBedrockOpenAiModelAllowedInRegion(model, undefined);
  }
  if (provider === "openai") {
    return isOpenAiCompatibleLlmModel(model) &&
      !OPENROUTER_ONLY_MODELS.has(model) &&
      !BEDROCK_ONLY_OPENAI_MODELS.has(model);
  }
  if (provider === "custom") return true;
  return false;
}

export function normalizeLlmModel(
  value: unknown,
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): LlmModel {
  return resolveStoredLlmModel(value, orgProvider, options) ??
    getDefaultLlmModel(orgProvider, options);
}

export function resolveStoredLlmModel(
  value: unknown,
  orgProvider?: string | null,
  options?: LlmProviderModelOptions,
): LlmModel | null {
  if (typeof value !== "string") return null;

  let replacement = STORED_LLM_MODEL_REPLACEMENTS[value] ?? value;
  if (value === "gpt-5.6-sol" && orgProvider === "bedrock") {
    replacement = "gpt-5.6-sol-bedrock";
  } else if (value === "gpt-5.6-terra" && orgProvider === "bedrock") {
    replacement = "gpt-5.6-terra-bedrock";
  } else if (value === "gpt-5.5" || value === "gpt-5.4") {
    replacement = orgProvider === "bedrock"
      ? "gpt-5.6-terra-bedrock"
      : DEFAULT_OPENAI_MODEL;
  } else if (value === "gpt-5.5-bedrock" || value === "gpt-5.4-bedrock") {
    replacement = "gpt-5.6-terra-bedrock";
  } else if (value === "gpt-5.4-mini") {
    replacement = DEFAULT_OPENAI_MODEL;
  }

  return isLlmModel(replacement) &&
      isLlmModelAllowedForOrgProvider(replacement, orgProvider, options)
    ? replacement
    : null;
}

export function isOpenAiCompatibleCustomApi(
  customApi: CustomLlmProviderApi | null | undefined,
): boolean {
  return customApi === "openai-completions" || customApi === "openai-responses";
}

export function hasCustomModelId(customModelId: string | null | undefined): boolean {
  return Boolean(customModelId?.trim());
}

export function parseStoredLlmProviderConfig(
  raw: unknown,
): LlmProviderStoredConfig {
  let config: Record<string, unknown> = {};

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  } else if (raw && typeof raw === "object") {
    config = raw as Record<string, unknown>;
  }

  const awsRegion =
    typeof config.aws_region === "string" && config.aws_region.trim()
      ? config.aws_region.trim()
      : undefined;
  const customName =
    typeof config.custom_name === "string" && config.custom_name.trim()
      ? config.custom_name.trim().slice(0, 80)
      : undefined;
  const customBaseUrl =
    typeof config.custom_base_url === "string" && config.custom_base_url.trim()
      ? config.custom_base_url.trim().replace(/\/+$/, "")
      : undefined;
  const customAuthType =
    config.custom_auth_type === "bearer" || config.custom_auth_type === "x-api-key"
      ? config.custom_auth_type
      : undefined;
  const customApi =
    config.custom_api === "openai-completions" ||
    config.custom_api === "openai-responses" ||
    config.custom_api === "anthropic-messages"
      ? config.custom_api
      : undefined;
  const customModelId =
    typeof config.custom_model_id === "string" && config.custom_model_id.trim()
      ? config.custom_model_id.trim().slice(0, 200)
      : undefined;

  return {
    ...(awsRegion ? { aws_region: awsRegion } : {}),
    ...(customName ? { custom_name: customName } : {}),
    ...(customBaseUrl ? { custom_base_url: customBaseUrl } : {}),
    ...(customAuthType ? { custom_auth_type: customAuthType } : {}),
    ...(customApi ? { custom_api: customApi } : {}),
    ...(customModelId ? { custom_model_id: customModelId } : {}),
  };
}

export function stringifyStoredLlmProviderConfig(
  config: Partial<LlmProviderStoredConfig>,
): string {
  const normalized = parseStoredLlmProviderConfig(config);
  return JSON.stringify({
    ...(normalized.aws_region ? { aws_region: normalized.aws_region } : {}),
    ...(normalized.custom_name ? { custom_name: normalized.custom_name } : {}),
    ...(normalized.custom_base_url ? { custom_base_url: normalized.custom_base_url } : {}),
    ...(normalized.custom_auth_type ? { custom_auth_type: normalized.custom_auth_type } : {}),
    ...(normalized.custom_api ? { custom_api: normalized.custom_api } : {}),
    ...(normalized.custom_model_id ? { custom_model_id: normalized.custom_model_id } : {}),
  });
}

export interface LlmProviderConfigRecord {
  provider: string;
  credentials_encrypted: string;
  config: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export function getStoredCustomLlmProviderApi(
  record: Pick<LlmProviderConfigRecord, "provider" | "config"> | null | undefined,
): CustomLlmProviderApi | null {
  if (record?.provider !== "custom") return null;
  return parseStoredLlmProviderConfig(record.config).custom_api ?? null;
}

export function getStoredCustomLlmProviderModelId(
  record: Pick<LlmProviderConfigRecord, "provider" | "config"> | null | undefined,
): string | null {
  if (record?.provider !== "custom") return null;
  return parseStoredLlmProviderConfig(record.config).custom_model_id ?? null;
}

export function getStoredBedrockAwsRegion(
  record: Pick<LlmProviderConfigRecord, "provider" | "config"> | null | undefined,
): string | null {
  if (record?.provider !== "bedrock") return null;
  return parseStoredLlmProviderConfig(record.config).aws_region ?? null;
}

export function keyHint(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 8)}...`;
}

export async function buildPublicLlmProviderConfig(
  record: LlmProviderConfigRecord,
  integrationSecretKey: string,
): Promise<LlmProviderConfigPublic> {
  let hint = "********";

  try {
    const creds = await decryptCredentials<Record<string, string>>(
      record.credentials_encrypted,
      integrationSecretKey,
    );
    const primaryKey =
      record.provider === "anthropic" ||
      record.provider === "openai" ||
      record.provider === "openrouter" ||
      record.provider === "custom"
        ? creds.api_key
        : creds.bearer_token;
    if (primaryKey) {
      hint = keyHint(primaryKey);
    }
  } catch {
    // Fall back to a generic redacted hint.
  }

  return {
    provider: record.provider as LlmProvider,
    config: parseStoredLlmProviderConfig(record.config),
    key_hint: hint,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
