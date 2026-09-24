import type { LlmProvider, LlmProviderConfigPublic } from "../types";
import { isSelfhostRuntime } from "./selfhost-runtime";
import {
  keyHint,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
  type CustomLlmProviderApi,
  type LlmProviderConfigRecord,
} from "./llm-provider-config";

export interface SelfhostAiProviderEnv {
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  SELFHOST_AI_PROVIDER?: string;
  SELFHOST_AI_API_KEY?: string;
  SELFHOST_AI_BASE_URL?: string;
  SELFHOST_AI_MODEL?: string;
  SELFHOST_AI_NAME?: string;
  SELFHOST_AI_AUTH_TYPE?: string;
  SELFHOST_AI_API?: string;
  SELFHOST_AI_AWS_REGION?: string;
}

export interface SelfhostAiProviderCredentials {
  provider: LlmProvider;
  apiKey: string;
  awsRegion?: string;
  baseUrl?: string;
  authType?: "bearer" | "x-api-key";
  api?: CustomLlmProviderApi;
  modelId?: string;
}

export type SelfhostAiProviderRecord = Pick<
  LlmProviderConfigRecord,
  "provider" | "config"
>;

export interface SelfhostAiProviderStatus {
  configured: boolean;
  valid: boolean;
  message?: string;
  provider?: LlmProvider;
  publicConfig?: LlmProviderConfigPublic;
}

const VALID_PROVIDERS = new Set<LlmProvider>([
  "anthropic",
  "bedrock",
  "custom",
  "openai",
  "openrouter",
  "requesty",
]);
const VALID_CUSTOM_APIS = new Set<CustomLlmProviderApi>([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

export { isSelfhostRuntime };

export function getSelfhostAiProviderCredentials(
  env: SelfhostAiProviderEnv,
): SelfhostAiProviderCredentials | null {
  const status = getSelfhostAiProviderStatus(env);
  if (!status.configured) return null;
  if (!status.valid) {
    throw new Error(status.message ?? "Self-host AI provider is not configured correctly.");
  }
  const provider = status.provider!;
  const apiKey = requiredTrimmed(env.SELFHOST_AI_API_KEY);
  if (!apiKey) {
    throw new Error(status.message ?? "Self-host AI provider is not configured correctly.");
  }
  const record = buildSelfhostAiProviderRecord(env, provider);
  const config = parseStoredLlmProviderConfig(record.config);
  return {
    provider,
    apiKey,
    ...(config.aws_region ? { awsRegion: config.aws_region } : {}),
    ...(config.custom_base_url ? { baseUrl: config.custom_base_url } : {}),
    ...(config.custom_auth_type ? { authType: config.custom_auth_type } : {}),
    ...(config.custom_api ? { api: config.custom_api } : {}),
    ...(config.custom_model_id ? { modelId: config.custom_model_id } : {}),
  };
}

export function getSelfhostAiProviderRecord(
  env: SelfhostAiProviderEnv,
): SelfhostAiProviderRecord | null {
  const status = getSelfhostAiProviderStatus(env);
  if (!status.configured || !status.valid || !status.provider) return null;
  return buildSelfhostAiProviderRecord(env, status.provider);
}

export function getEffectiveLlmProviderConfig<T extends SelfhostAiProviderRecord>(
  env: SelfhostAiProviderEnv,
  orgRecord: T | null | undefined,
): T | SelfhostAiProviderRecord | null {
  return getSelfhostAiProviderRecord(env) ?? orgRecord ?? null;
}

export function getSelfhostAiProviderPublicConfig(
  env: SelfhostAiProviderEnv,
): LlmProviderConfigPublic | null {
  const status = getSelfhostAiProviderStatus(env);
  return status.valid ? status.publicConfig ?? null : null;
}

export function getSelfhostAiProviderStatus(
  env: SelfhostAiProviderEnv,
): SelfhostAiProviderStatus {
  const providerValue = env.SELFHOST_AI_PROVIDER?.trim().toLowerCase();
  if (!providerValue) {
    const hasPartialConfig = [
      env.SELFHOST_AI_API_KEY,
      env.SELFHOST_AI_BASE_URL,
      env.SELFHOST_AI_MODEL,
      env.SELFHOST_AI_NAME,
    ].some((value) => Boolean(value?.trim()));
    return hasPartialConfig
      ? {
          configured: true,
          valid: false,
          message: "SELFHOST_AI_PROVIDER is required when SELFHOST_AI_* variables are set.",
        }
      : { configured: false, valid: false };
  }

  if (!VALID_PROVIDERS.has(providerValue as LlmProvider)) {
    return {
      configured: true,
      valid: false,
      message:
        "SELFHOST_AI_PROVIDER must be one of anthropic, bedrock, custom, openai, openrouter, or requesty.",
    };
  }

  const provider = providerValue as LlmProvider;
  const apiKey = requiredTrimmed(env.SELFHOST_AI_API_KEY);
  if (!apiKey) {
    return {
      configured: true,
      valid: false,
      provider,
      message: "SELFHOST_AI_API_KEY is required for the configured self-host AI provider.",
    };
  }

  if (provider === "custom") {
    if (!requiredTrimmed(env.SELFHOST_AI_BASE_URL)) {
      return {
        configured: true,
        valid: false,
        provider,
        message: "SELFHOST_AI_BASE_URL is required when SELFHOST_AI_PROVIDER=custom.",
      };
    }
    if (!requiredTrimmed(env.SELFHOST_AI_MODEL)) {
      return {
        configured: true,
        valid: false,
        provider,
        message: "SELFHOST_AI_MODEL is required when SELFHOST_AI_PROVIDER=custom.",
      };
    }
    const api = parseCustomApi(env.SELFHOST_AI_API);
    if (!api) {
      return {
        configured: true,
        valid: false,
        provider,
        message:
          "SELFHOST_AI_API must be openai-completions, openai-responses, or anthropic-messages.",
      };
    }
  }

  const record = buildSelfhostAiProviderRecord(env, provider);
  return {
    configured: true,
    valid: true,
    provider,
    publicConfig: {
      provider,
      config: parseStoredLlmProviderConfig(record.config),
      key_hint: keyHint(apiKey!),
      created_by: "selfhost-env",
      created_at: 0,
      updated_at: 0,
    },
  };
}

function buildSelfhostAiProviderRecord(
  env: SelfhostAiProviderEnv,
  provider: LlmProvider,
): SelfhostAiProviderRecord {
  const customApi = parseCustomApi(env.SELFHOST_AI_API) ?? "openai-completions";
  const customBaseUrl = requiredTrimmed(env.SELFHOST_AI_BASE_URL)?.replace(/\/+$/, "");
  const customModelId = requiredTrimmed(env.SELFHOST_AI_MODEL);
  const customName = requiredTrimmed(env.SELFHOST_AI_NAME);
  const customAuthType =
    env.SELFHOST_AI_AUTH_TYPE?.trim() === "x-api-key" ? "x-api-key" : "bearer";
  return {
    provider,
    config: stringifyStoredLlmProviderConfig({
      ...(provider === "bedrock"
        ? { aws_region: requiredTrimmed(env.SELFHOST_AI_AWS_REGION) ?? "us-east-1" }
        : {}),
      ...(provider === "custom"
        ? {
            custom_name: customName ?? "Self-host AI provider",
            custom_base_url:
              customApi === "anthropic-messages"
                ? customBaseUrl?.replace(/\/v1$/i, "")
                : customBaseUrl,
            custom_model_id: customModelId,
            custom_auth_type: customAuthType,
            custom_api: customApi,
          }
        : {}),
    }),
  };
}

function parseCustomApi(value: string | undefined): CustomLlmProviderApi | null {
  const trimmed = value?.trim();
  if (!trimmed) return "openai-completions";
  return VALID_CUSTOM_APIS.has(trimmed as CustomLlmProviderApi)
    ? (trimmed as CustomLlmProviderApi)
    : null;
}

function requiredTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
