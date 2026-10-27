import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";

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

// Claude ids that older threads and BYOK configs may still carry, and the
// current OpenRouter model each runs as. pi-ai 1.4.0 (camelRun's catalog) has
// no Claude Sonnet 4, Opus 4, 3.7 Sonnet or 3.5s, so none maps to them.
const LEGACY_CLAUDE_OPENROUTER_MODELS: Readonly<Record<string, string>> = {
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
  "claude-sonnet-4-5-20250929": "anthropic/claude-sonnet-4.5",
  "claude-sonnet-4-20250514": "anthropic/claude-sonnet-4.5",
  "claude-3-7-sonnet-20250219": "anthropic/claude-sonnet-4.5",
  "claude-3-5-sonnet-20241022": "anthropic/claude-sonnet-4.5",
  "claude-3-5-sonnet-20240620": "anthropic/claude-sonnet-4.5",
  "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5",
  "claude-3-5-haiku-20241022": "anthropic/claude-haiku-4.5",
  "claude-opus-4-5-20251101": "anthropic/claude-opus-4.5",
  "claude-opus-4-20250514": "anthropic/claude-opus-4.5",
};

describe("legacy Claude ids", () => {
  it.each(Object.entries(LEGACY_CLAUDE_OPENROUTER_MODELS))("run %s as %s, a model Pi's catalog has", (id, expected) => {
    const openRouterId = mapping.openRouterClaudeModel(id);
    expect(openRouterId).toBe(expected);
    expect(lookup("openrouter", openRouterId), `openrouter/${openRouterId}`).toBeTruthy();
  });
});
