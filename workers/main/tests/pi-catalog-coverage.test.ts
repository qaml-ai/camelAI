import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

import { normalizeLlmModel, replaceRetiredLlmModel } from "../../../src/lib/llm-provider-config";
import { MODEL_CATALOG } from "../../../src/lib/model-catalog";
import { PiModelMapping } from "../src/pi-model-resolution";

const lookup = getModel as unknown as (provider: string, id: string) => unknown;
const mapping = new PiModelMapping();
const pickerModels = Object.keys(MODEL_CATALOG).filter((id) => id !== "custom");

// chiridion keeps no catalog fallbacks (chat-thread/pi-model-config.ts): every
// model it resolves must be in Pi's catalog, or its threads cannot start.
describe("Pi's catalog", () => {
  it.each(pickerModels)("has %s as chiridion resolves it", (id) => {
    const reference = mapping.resolvePiModelReference(id);
    expect(lookup(reference.provider, reference.modelId), `${reference.provider}/${reference.modelId}`).toBeTruthy();
  });

  it.each(pickerModels)("has hosted %s's OpenRouter model", (id) => {
    const reference = mapping.resolvePiModelReference(id);
    if (reference.hostedGatewayProvider !== "openrouter" || !reference.hostedModelId) return;
    const openRouterId = reference.hostedModelId.replace(/:nitro$/, "");
    expect(lookup("openrouter", openRouterId), `openrouter/${openRouterId}`).toBeTruthy();
  });
});

// Raw Claude API ids that older threads and agents may still carry, and the
// current Claude model each runs as. They take the same route as the picker's
// Claude models (never the OpenAI default), so each must be in Pi's catalog.
const LEGACY_CLAUDE_MODELS: Readonly<Record<string, { model: string; piModel: string; openRouter: string }>> = {
  "claude-sonnet-4-20250514": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-sonnet-4-5-20250929": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-sonnet-4-6": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-sonnet-5-5": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-3-7-sonnet-20250219": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-3-7-sonnet-latest": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-3-5-sonnet-20241022": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-3-5-sonnet-20240620": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "us.anthropic.claude-3-7-sonnet-20250219-v1:0": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "anthropic.claude-sonnet-4-20250514-v1:0": { model: "sonnet", piModel: "claude-sonnet-5-5", openRouter: "anthropic/claude-sonnet-5.5" },
  "claude-opus-4-20250514": { model: "opus-5.5", piModel: "claude-opus-5-5", openRouter: "anthropic/claude-opus-5.5" },
  "claude-opus-4-1-20250805": { model: "opus-5.5", piModel: "claude-opus-5-5", openRouter: "anthropic/claude-opus-5.5" },
  "claude-opus-4-5-20251101": { model: "opus-5.5", piModel: "claude-opus-5-5", openRouter: "anthropic/claude-opus-5.5" },
  "claude-3-opus-20240229": { model: "opus-5.5", piModel: "claude-opus-5-5", openRouter: "anthropic/claude-opus-5.5" },
  "claude-3-5-haiku-20241022": { model: "haiku-5.5", piModel: "claude-haiku-5-5", openRouter: "anthropic/claude-haiku-5.5" },
  "claude-haiku-4-5-20251001": { model: "haiku-5.5", piModel: "claude-haiku-5-5", openRouter: "anthropic/claude-haiku-5.5" },
  "claude-3-haiku-20240307": { model: "haiku-5.5", piModel: "claude-haiku-5-5", openRouter: "anthropic/claude-haiku-5.5" },
  "claude-fable-5": { model: "fable-5.1", piModel: "claude-fable-5-1", openRouter: "anthropic/claude-fable-5.1" },
};

describe("legacy Claude ids", () => {
  it.each(Object.entries(LEGACY_CLAUDE_MODELS))("run %s on Claude", (id, expected) => {
    expect(replaceRetiredLlmModel(id)).toBe(expected.model);
    expect(normalizeLlmModel(id)).toBe(expected.model);
    expect(normalizeLlmModel(id, "anthropic")).toBe(expected.model);
    expect(normalizeLlmModel(id, "bedrock")).toBe(expected.model);
    const reference = mapping.resolvePiModelReference(id);
    expect(reference).toMatchObject({
      provider: "anthropic",
      modelId: expected.piModel,
      hostedGatewayProvider: "openrouter",
    });
    expect(lookup("anthropic", expected.piModel), `anthropic/${expected.piModel}`).toBeTruthy();
    const openRouterId = reference.hostedModelId!.replace(/:nitro$/, "");
    expect(openRouterId).toBe(expected.openRouter);
    expect(lookup("openrouter", openRouterId), `openrouter/${openRouterId}`).toBeTruthy();
  });

  it("leaves OpenRouter Claude ids and other models alone", () => {
    expect(replaceRetiredLlmModel("anthropic/claude-sonnet-4.5")).toBe("anthropic/claude-sonnet-4.5");
    expect(mapping.resolvePiModelReference("anthropic/claude-sonnet-4.5")).toMatchObject({ provider: "openrouter" });
    expect(replaceRetiredLlmModel("claude")).toBe("claude");
    expect(replaceRetiredLlmModel("gpt-6-luna")).toBe("gpt-6-luna");
  });
});
