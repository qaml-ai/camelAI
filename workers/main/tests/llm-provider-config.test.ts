import { describe, expect, it } from "vitest";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  buildPublicLlmProviderConfig,
  DEFAULT_LLM_MODEL,
  getDefaultLlmModel,
  getLlmModelOptions,
  getVisibleLlmModelOptions,
  isLlmModel,
  isLlmModelAllowedForNewThread,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
} from "../../../src/lib/llm-provider-config";

const CAMEL_CODE_MODEL = "deepseek-v4-auto" as const;

const OPENAI_COMPATIBLE_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  CAMEL_CODE_MODEL,
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
] as const;

const ANTHROPIC_MODELS = [
  "opus-4.8",
  "fable-5",
  "sonnet",
  "haiku",
] as const;

const PINNED_HOSTED_MODELS = [
  CAMEL_CODE_MODEL,
  ...ANTHROPIC_MODELS,
  ...OPENAI_COMPATIBLE_MODELS.filter((model) => model !== CAMEL_CODE_MODEL),
] as const;

const OPENROUTER_ONLY_MODELS = [
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
] as const;

const OPENROUTER_OPENAI_COMPATIBLE_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  CAMEL_CODE_MODEL,
  "deepseek-v4-flash",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.2",
] as const;

const PINNED_OPENROUTER_MODELS = [
  CAMEL_CODE_MODEL,
  ...ANTHROPIC_MODELS,
  ...OPENROUTER_OPENAI_COMPATIBLE_MODELS.filter((model) => model !== CAMEL_CODE_MODEL),
] as const;

const CAMELAI_HOSTED_ONLY_MODELS = [CAMEL_CODE_MODEL] as const;

const BEDROCK_OPENAI_MODELS = [
  "gpt-5.6-sol-bedrock",
  "gpt-5.6-terra-bedrock",
] as const;

describe("llm provider config helpers", () => {
  it("defaults missing thread model to sonnet", () => {
    expect(normalizeLlmModel(undefined)).toBe(DEFAULT_LLM_MODEL);
    expect(normalizeLlmModel(undefined, "openai")).toBe(DEFAULT_OPENAI_MODEL);
    expect(normalizeLlmModel(undefined, "openrouter")).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(getDefaultLlmModel("anthropic")).toBe(DEFAULT_LLM_MODEL);
    expect(getDefaultLlmModel("openai")).toBe(DEFAULT_OPENAI_MODEL);
    expect(getDefaultLlmModel("openrouter")).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(
      getDefaultLlmModel("custom", { customApi: "openai-responses" }),
    ).toBe(DEFAULT_OPENAI_MODEL);
    expect(
      getDefaultLlmModel("custom", { customApi: "anthropic-messages" }),
    ).toBe(DEFAULT_LLM_MODEL);
    expect(
      getDefaultLlmModel("custom", {
        customApi: "openai-responses",
        customModelId: "pi-custom-model",
      }),
    ).toBe("custom");
    expect(parseStoredLlmProviderConfig("{}")).toEqual({});
  });

  it("returns provider-specific model options", () => {
    expect(getLlmModelOptions("anthropic").map((option) => option.value)).toEqual([
      ...ANTHROPIC_MODELS,
      CAMEL_CODE_MODEL,
    ]);
    expect(getLlmModelOptions("openai").map((option) => option.value)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      CAMEL_CODE_MODEL,
    ]);
    expect(getLlmModelOptions("openrouter").map((option) => option.value)).toEqual([
      ...ANTHROPIC_MODELS,
      ...OPENROUTER_OPENAI_COMPATIBLE_MODELS,
    ]);
    expect(getLlmModelOptions(null).map((option) => option.value)).toEqual([
      ...ANTHROPIC_MODELS,
      ...OPENAI_COMPATIBLE_MODELS,
    ]);
    expect(
      getLlmModelOptions("custom", { customApi: "openai-responses" }).map(
        (option) => option.value,
      ),
    ).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      CAMEL_CODE_MODEL,
    ]);
    expect(
      getLlmModelOptions("custom", { customApi: "anthropic-messages" }).map(
        (option) => option.value,
      ),
    ).toEqual([...ANTHROPIC_MODELS, CAMEL_CODE_MODEL]);
    expect(
      getLlmModelOptions("custom", {
        customApi: "openai-responses",
        customModelId: "pi-custom-model",
      }).map((option) => option.value),
    ).toEqual(["custom"]);
    for (const model of OPENAI_COMPATIBLE_MODELS) {
      expect(isLlmModel(model)).toBe(true);
    }
    expect(isLlmModel("gemini-3.1-pro-preview")).toBe(false);
    expect(isLlmModel("fable-5")).toBe(true);
    expect(normalizeLlmModel("gemini-3.1-pro-preview")).toBe(
      "gemini-3.5-flash",
    );
    expect(normalizeLlmModel("fable-5")).toBe("fable-5");
    expect(normalizeLlmModel("kimi-k2.6")).toBe("kimi-k2.7-code");
    expect(normalizeLlmModel("kimi-latest")).toBe("kimi-k2.7-code");
    expect(normalizeLlmModel("opus")).toBe("opus-4.8");
    expect(normalizeLlmModel("opus-4.7")).toBe("opus-4.8");
    expect(normalizeLlmModel("deepseek-v4-auto")).toBe("deepseek-v4-auto");
    expect(normalizeLlmModel("deepseek-v4-auto", "openrouter")).toBe(
      CAMEL_CODE_MODEL,
    );
    expect(
      normalizeLlmModel("sonnet", "custom", { customApi: "openai-completions" }),
    ).toBe(DEFAULT_OPENAI_MODEL);
    expect(
      normalizeLlmModel("gpt-5.4", "custom", { customApi: "anthropic-messages" }),
    ).toBe(DEFAULT_LLM_MODEL);
    expect(
      normalizeLlmModel(undefined, "custom", {
        customApi: "openai-completions",
        customModelId: "pi-custom-model",
      }),
    ).toBe("custom");
  });

  it("keeps BYOK models provider-scoped while camelCode stays global", () => {
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "openai",
      }).map((option) => option.value),
    ).toEqual([
      CAMEL_CODE_MODEL,
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(
      getVisibleLlmModelOptions().map((option) => option.value),
    ).toEqual([...PINNED_HOSTED_MODELS]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "openrouter",
      }).map((option) => option.value),
    ).toEqual([...PINNED_OPENROUTER_MODELS]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "anthropic",
      }).map((option) => option.value),
    ).toEqual([CAMEL_CODE_MODEL, ...ANTHROPIC_MODELS]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "bedrock",
      }).map((option) => option.value),
    ).toEqual([
      CAMEL_CODE_MODEL,
      ...ANTHROPIC_MODELS,
      ...BEDROCK_OPENAI_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "bedrock",
        awsRegion: "us-west-2",
      }).map((option) => option.value),
    ).toEqual([
      CAMEL_CODE_MODEL,
      ...ANTHROPIC_MODELS,
      "gpt-5.6-terra-bedrock",
    ]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "bedrock",
        awsRegion: "eu-west-1",
      }).map((option) => option.value),
    ).toEqual([CAMEL_CODE_MODEL, ...ANTHROPIC_MODELS]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: null,
      }).map((option) => option.value),
    ).toEqual([...PINNED_HOSTED_MODELS]);
  });

  it("keeps camelCode visible in hosted model options", () => {
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: null,
      }).map((option) => option.value),
    ).toContain("deepseek-v4-auto");
    expect(isLlmModelAllowedForNewThread("deepseek-v4-auto", null)).toBe(true);
  });

  it("can exclude gateway-only camelCode from self-host model options", () => {
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "bedrock",
        awsRegion: "us-east-1",
        allowCamelCode: false,
      }).map((option) => option.value),
    ).toEqual([...ANTHROPIC_MODELS, ...BEDROCK_OPENAI_MODELS]);

    expect(
      getVisibleLlmModelOptions(CAMEL_CODE_MODEL, {
        orgProvider: "bedrock",
        awsRegion: "us-east-1",
        allowCamelCode: false,
      }).map((option) => option.value),
    ).toEqual([...ANTHROPIC_MODELS, ...BEDROCK_OPENAI_MODELS]);
  });

  it("shows only policy-allowed model families for new chats", () => {
    expect(
      getVisibleLlmModelOptions(null, { orgProvider: null }).map(
        (option) => option.value,
      ),
    ).toEqual([...PINNED_HOSTED_MODELS]);
    expect(
      getVisibleLlmModelOptions(null, { orgProvider: "openai" }).map(
        (option) => option.value,
      ),
    ).toEqual([
      CAMEL_CODE_MODEL,
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(
      getVisibleLlmModelOptions(null, { orgProvider: "openrouter" }).map(
        (option) => option.value,
      ),
    ).toEqual([...PINNED_OPENROUTER_MODELS]);
    expect(
      getVisibleLlmModelOptions(null, { orgProvider: "anthropic" }).map(
        (option) => option.value,
      ),
    ).toEqual([CAMEL_CODE_MODEL, ...ANTHROPIC_MODELS]);
  });

  it("keeps the current model visible for existing locked threads regardless of new-chat policy", () => {
    expect(
      getVisibleLlmModelOptions("sonnet").map((option) => option.value),
    ).toEqual([...PINNED_HOSTED_MODELS]);
  });

  it("validates new thread models against provider policy", () => {
    expect(
      isLlmModelAllowedForNewThread("gpt-5.6-terra", null),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("sonnet", null),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("sonnet", "anthropic"),
    ).toBe(true);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4", "anthropic"),
    ).toBe(false);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4", "openai"),
    ).toBe(false);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4", "bedrock"),
    ).toBe(false);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.6-terra-bedrock", "bedrock"),
    ).toBe(true);
    expect(normalizeLlmModel("gpt-5.4", "bedrock")).toBe(
      "gpt-5.6-terra-bedrock",
    );
    expect(normalizeLlmModel("gpt-5.5", "bedrock")).toBe(
      "gpt-5.6-terra-bedrock",
    );
    expect(
      isLlmModelAllowedForNewThread("sonnet", "openai"),
    ).toBe(false);
    expect(
      isLlmModelAllowedForNewThread("gpt-5.4-mini", "openrouter"),
    ).toBe(false);
    for (const model of OPENROUTER_ONLY_MODELS) {
      expect(
        isLlmModelAllowedForNewThread(model, "openrouter"),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, null),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, "openai"),
      ).toBe(false);
    }
    for (const model of CAMELAI_HOSTED_ONLY_MODELS) {
      expect(
        isLlmModelAllowedForNewThread(model, null),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, "openrouter"),
      ).toBe(true);
      expect(
        isLlmModelAllowedForNewThread(model, "openai"),
      ).toBe(true);
    }
    expect(
      isLlmModelAllowedForNewThread("haiku", "openrouter"),
    ).toBe(true);
  });

  it("round-trips explicit region values", () => {
    const serialized = stringifyStoredLlmProviderConfig({
      aws_region: "us-west-2",
    });

    expect(parseStoredLlmProviderConfig(serialized)).toEqual({
      aws_region: "us-west-2",
    });
  });

  it("round-trips custom provider settings", () => {
    const serialized = stringifyStoredLlmProviderConfig({
      custom_name: "  Acme AI  ",
      custom_base_url: "https://api.example.com/v1/",
      custom_auth_type: "x-api-key",
      custom_api: "anthropic-messages",
      custom_model_id: "claude-custom",
    });

    expect(parseStoredLlmProviderConfig(serialized)).toEqual({
      custom_name: "Acme AI",
      custom_base_url: "https://api.example.com/v1",
      custom_auth_type: "x-api-key",
      custom_api: "anthropic-messages",
      custom_model_id: "claude-custom",
    });
    expect(getLlmModelOptions("custom").map((option) => option.value)).toEqual([
      ...ANTHROPIC_MODELS,
      ...OPENROUTER_OPENAI_COMPATIBLE_MODELS,
    ]);
  });

  it("builds a public config with a redacted key hint", async () => {
    const encrypted = await encryptCredentials(
      { api_key: "sk-ant-test-secret-1234" },
      "test-secret-key",
    );

    const config = await buildPublicLlmProviderConfig(
      {
        provider: "anthropic",
        credentials_encrypted: encrypted,
        config: "{}",
        created_by: "user_123",
        created_at: 100,
        updated_at: 200,
      },
      "test-secret-key",
    );

    expect(config).toEqual({
      provider: "anthropic",
      config: {},
      key_hint: "sk-ant-t...",
      created_by: "user_123",
      created_at: 100,
      updated_at: 200,
    });
  });
});
