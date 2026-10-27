import { describe, expect, it } from "vitest";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
  buildPublicLlmProviderConfig,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_LLM_MODEL,
  getDefaultLlmModel,
  getBedrockOpenAiModelRegions,
  getLlmModelOptions,
  getVisibleLlmModelOptions,
  isLlmModel,
  isLlmModelAllowedForNewThread,
  normalizeLlmModel,
  parseStoredLlmProviderConfig,
  resolveStoredLlmModel,
  stringifyStoredLlmProviderConfig,
  LLM_MODEL_OPTIONS,
} from "../../../src/lib/llm-provider-config";
import { ALL_LLM_MODELS } from "../../../src/lib/model-catalog";
import { LlmModelSchema } from "../src/routes/admin/schemas";

const ALL_LLM_MODELS_FROM_OPTIONS = LLM_MODEL_OPTIONS.map((option) => option.value);

const CAMEL_CODE_MODEL = "deepseek-v4-auto" as const;

const OPENAI_COMPATIBLE_MODELS = [
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gemini-3.8-flash",
  CAMEL_CODE_MODEL,
  "deepseek-v4.1-flash",
  "kimi-k3",
  "grok-4.7",
  "glm-5.3",
  "glm-5.3-flash",
] as const;

const ANTHROPIC_MODELS = [
  "opus-5.5",
  "fable-5.1",
  "sonnet",
  "haiku-5.5",
] as const;

const PINNED_HOSTED_MODELS = [
  CAMEL_CODE_MODEL,
  ...ANTHROPIC_MODELS,
  ...OPENAI_COMPATIBLE_MODELS.filter((model) => model !== CAMEL_CODE_MODEL),
] as const;

const OPENROUTER_ONLY_MODELS = [
  "gemini-3.8-flash",
  "deepseek-v4.1-flash",
  "kimi-k3",
  "grok-4.7",
  "glm-5.3",
  "glm-5.3-flash",
] as const;

const OPENROUTER_OPENAI_COMPATIBLE_MODELS = OPENAI_COMPATIBLE_MODELS;

const PINNED_OPENROUTER_MODELS = [
  CAMEL_CODE_MODEL,
  ...ANTHROPIC_MODELS,
  ...OPENROUTER_OPENAI_COMPATIBLE_MODELS.filter((model) => model !== CAMEL_CODE_MODEL),
] as const;

const CAMELAI_HOSTED_ONLY_MODELS = [CAMEL_CODE_MODEL] as const;

const BEDROCK_OPENAI_MODELS = [
  "gpt-5.6-terra-bedrock",
] as const;

describe("llm provider config helpers", () => {
  it("defaults missing thread models to GPT-6 Luna wherever the org can run it", () => {
    expect(DEFAULT_LLM_MODEL).toBe("gpt-6-luna");
    expect(DEFAULT_OPENAI_MODEL).toBe("gpt-6-luna");
    expect(DEFAULT_OPENROUTER_MODEL).toBe("gpt-6-luna");
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("sonnet");
    expect(normalizeLlmModel(undefined)).toBe("gpt-6-luna");
    expect(normalizeLlmModel(undefined, "openai")).toBe("gpt-6-luna");
    expect(normalizeLlmModel(undefined, "openrouter")).toBe("gpt-6-luna");
    expect(getDefaultLlmModel()).toBe("gpt-6-luna");
    expect(getDefaultLlmModel("openai")).toBe("gpt-6-luna");
    expect(getDefaultLlmModel("openrouter")).toBe("gpt-6-luna");
    // Keys that cannot run Luna keep the closest default their provider has.
    expect(getDefaultLlmModel("anthropic")).toBe("sonnet");
    expect(normalizeLlmModel(undefined, "anthropic")).toBe("sonnet");
    expect(
      getDefaultLlmModel("bedrock", { awsRegion: "us-east-2" }),
    ).toBe("gpt-5.6-terra-bedrock");
    expect(
      getDefaultLlmModel("bedrock", { awsRegion: "eu-west-1" }),
    ).toBe("gpt-5.6-terra-bedrock");
    expect(
      getBedrockOpenAiModelRegions("gpt-5.6-terra-bedrock", "us-east-2"),
    ).toEqual(["us-east-2", "us-east-1", "us-west-2"]);
    expect(
      getDefaultLlmModel("custom", { customApi: "openai-responses" }),
    ).toBe("gpt-6-luna");
    expect(
      getDefaultLlmModel("custom", { customApi: "anthropic-messages" }),
    ).toBe("sonnet");
    expect(
      getDefaultLlmModel("custom", {
        customApi: "openai-responses",
        customModelId: "pi-custom-model",
      }),
    ).toBe("custom");
    expect(parseStoredLlmProviderConfig("{}")).toEqual({});
  });

  it("keeps explicitly stored models instead of moving them to the new default", () => {
    expect(normalizeLlmModel("sonnet")).toBe("sonnet");
    expect(normalizeLlmModel("sonnet", "openrouter")).toBe("sonnet");
    expect(normalizeLlmModel("gpt-6.1-sol", "openai")).toBe("gpt-6.1-sol");
    expect(normalizeLlmModel("glm-5.3")).toBe("glm-5.3");
    expect(normalizeLlmModel("gpt-5.6-terra-bedrock", "bedrock")).toBe(
      "gpt-5.6-terra-bedrock",
    );
  });

  it("maps retired models to their closest replacement", () => {
    const replacements: Record<string, string> = {
      opus: "opus-5.5",
      "opus-4.7": "opus-5.5",
      "opus-4.8": "opus-5.5",
      "opus-5": "opus-5.5",
      "fable-5": "fable-5.1",
      "gpt-6-sol": "gpt-6.1-sol",
      "gpt-5.6-sol": "gpt-6.1-sol",
      "gpt-5.6-terra": "gpt-6.1-sol",
      "gpt-5.6-luna": "gpt-6-luna",
      "gpt-5.5": "gpt-6.1-sol",
      "gpt-5.4": "gpt-6.1-sol",
      "gpt-5.4-mini": "gpt-6-luna",
      "gemini-3.1-pro-preview": "gemini-3.8-flash",
      "gemini-3.5-flash": "gemini-3.8-flash",
      "gemini-3-flash-preview": "gemini-3.8-flash",
      "deepseek-v4-pro": "deepseek-v4.1-flash",
      "deepseek-v4-flash": "deepseek-v4.1-flash",
      "kimi-k2.6": "kimi-k3",
      "kimi-latest": "kimi-k3",
      "kimi-k2.7-code": "kimi-k3",
      "grok-4.3": "grok-4.7",
      "grok-latest": "grok-4.7",
      "grok-4.5": "grok-4.7",
      "glm-5.2": "glm-5.3",
      "glm-latest": "glm-5.3",
      haiku: "haiku-5.5",
    };
    for (const [stored, replacement] of Object.entries(replacements)) {
      expect(isLlmModel(stored), stored).toBe(false);
      expect(resolveStoredLlmModel(stored), stored).toBe(replacement);
    }
    expect(normalizeLlmModel("glm-5.2", "openrouter")).toBe("glm-5.3");
    expect(normalizeLlmModel("haiku", "anthropic")).toBe("haiku-5.5");
    expect(normalizeLlmModel("haiku", "bedrock")).toBe("haiku-5.5");
    expect(normalizeLlmModel("opus-5", "anthropic")).toBe("opus-5.5");
    expect(normalizeLlmModel("fable-5", "bedrock")).toBe("fable-5.1");
    expect(normalizeLlmModel("gpt-5.6-terra", "openai")).toBe("gpt-6.1-sol");
    expect(normalizeLlmModel("gpt-5.6-luna", "openai")).toBe("gpt-6-luna");
    // Bedrock has no GPT-6 Sol or Luna; its OpenAI threads land on Terra.
    for (const stored of [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-sol-bedrock",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.5-bedrock",
      "gpt-5.4-bedrock",
    ]) {
      expect(normalizeLlmModel(stored, "bedrock"), stored).toBe(
        "gpt-5.6-terra-bedrock",
      );
    }
  });

  it("returns provider-specific model options", () => {
    expect(getLlmModelOptions("anthropic").map((option) => option.value)).toEqual([
      ...ANTHROPIC_MODELS,
      CAMEL_CODE_MODEL,
    ]);
    expect(getLlmModelOptions("openai").map((option) => option.value)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-luna",
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
      "gpt-6.1-sol",
      "gpt-6-luna",
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
    expect(normalizeLlmModel("deepseek-v4-auto")).toBe("deepseek-v4-auto");
    expect(normalizeLlmModel("deepseek-v4-auto", "openrouter")).toBe(
      CAMEL_CODE_MODEL,
    );
    expect(
      normalizeLlmModel("sonnet", "custom", { customApi: "openai-completions" }),
    ).toBe(DEFAULT_OPENAI_MODEL);
    expect(
      normalizeLlmModel("gpt-5.4", "custom", { customApi: "anthropic-messages" }),
    ).toBe(DEFAULT_ANTHROPIC_MODEL);
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
      "gpt-6.1-sol",
      "gpt-6-luna",
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
      ...BEDROCK_OPENAI_MODELS,
    ]);
    expect(
      getVisibleLlmModelOptions(null, {
        orgProvider: "bedrock",
        awsRegion: "eu-west-1",
      }).map((option) => option.value),
    ).toEqual([
      CAMEL_CODE_MODEL,
      ...ANTHROPIC_MODELS,
      ...BEDROCK_OPENAI_MODELS,
    ]);
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
      "gpt-6.1-sol",
      "gpt-6-luna",
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
      isLlmModelAllowedForNewThread("gpt-6.1-sol", null),
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
    ).toBe(false);
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

describe("admin model enum", () => {
  it("accepts exactly the current model list", () => {
    expect([...LlmModelSchema.options].sort()).toEqual([...ALL_LLM_MODELS].sort());
    expect([...LlmModelSchema.options].sort()).toEqual(
      [...ALL_LLM_MODELS_FROM_OPTIONS].sort(),
    );
  });
});
