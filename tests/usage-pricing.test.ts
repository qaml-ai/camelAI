import { describe, expect, it } from "vitest";
import {
  calculateEffectiveUsageCostUsd,
  calculateUsageCostUsd,
  lookupPricing,
  lookupPricingOrNull,
} from "@/lib/usage-pricing";

describe("calculateEffectiveUsageCostUsd", () => {
  it("uses total reported cost instead of adding its upstream component", () => {
    expect(
      calculateEffectiveUsageCostUsd({
        model: "anthropic/claude-4.6-sonnet-20260217",
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reportedCostUsd: 0.0012,
        upstreamInferenceCostUsd: 0.0048,
      }),
    ).toBeCloseTo(0.0012);
  });

  it("falls back to table pricing when reported cost is zero", () => {
    expect(
      calculateEffectiveUsageCostUsd({
        model: "anthropic/claude-4.6-sonnet-20260217",
        inputTokens: 0,
        outputTokens: 1000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        reportedCostUsd: 0,
      }),
    ).toBeCloseTo(0.015);
  });
});

describe("calculateUsageCostUsd", () => {
  it("keeps strict lookup separate from the legacy Sonnet fallback", () => {
    expect(lookupPricingOrNull("camel/anthropic/claude-sonnet-5:nitro")).toEqual(
      lookupPricing("claude-sonnet-5"),
    );
    expect(lookupPricingOrNull("operator/private-model-v9")).toBeNull();
    expect(lookupPricing("operator/private-model-v9")).toBe(
      lookupPricing("claude-sonnet-5"),
    );
  });

  it("prices GLM 5.3 aliases while retaining historical GLM 5.2 pricing", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    };

    for (const model of ["glm-5.3", "z-ai/glm-5.3", "camel/z-ai/glm-5.3:nitro"]) {
      expect(lookupPricingOrNull(model)).toEqual({
        inputPerToken: 0.00000084,
        outputPerToken: 0.00000264,
        cacheReadPerToken: 0.000000156,
      });
      expect(calculateUsageCostUsd({ ...usage, model })).toBeCloseTo(3.636);
    }
    expect(calculateUsageCostUsd({ ...usage, model: "z-ai/glm-5.2" })).toBeCloseTo(5.5);
  });

  it("prices GPT-5.6 aliases and long prompts", () => {
    expect(lookupPricing("openai/gpt-5.6-terra")).toMatchObject({
      inputPerToken: 0.000002,
      outputPerToken: 0.000012,
    });
    expect(lookupPricing("openai/gpt-5.6-luna")).toMatchObject({
      inputPerToken: 0.0000002,
      outputPerToken: 0.0000012,
      cacheReadPerToken: 0.00000002,
    });
    expect(lookupPricing("openai/gpt-5.6-luna:nitro")).toBe(
      lookupPricing("gpt-5.6-luna"),
    );
    expect(lookupPricing("gpt-5.6")).toBe(lookupPricing("gpt-5.6-sol"));
    expect(lookupPricingOrNull("openai.gpt-5.6-sol")).toBe(
      lookupPricing("gpt-5.6-sol"),
    );
    expect(lookupPricingOrNull("openai.gpt-5.6-terra")).toBe(
      lookupPricing("gpt-5.6-terra"),
    );
    expect(
      calculateUsageCostUsd({
        model: "gpt-5.6-sol",
        inputTokens: 272_001,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      }),
    ).toBeCloseTo(2.72001);
  });

  it("calculates Fable 5 pricing and hosted prefixes", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "claude-fable-5" }),
    ).toBeCloseTo(73.5);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "anthropic/claude-fable-5",
      }),
    ).toBeCloseTo(73.5);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camel/anthropic/claude-fable-5:nitro",
      }),
    ).toBeCloseTo(73.5);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "openrouter/anthropic/claude-fable-5",
      }),
    ).toBeCloseTo(73.5);
  });

  it("calculates current Opus 5 pricing across provider spellings", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "claude-opus-5" }),
    ).toBeCloseTo(36.75);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camel/anthropic/claude-opus-5",
      }),
    ).toBeCloseTo(36.75);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "anthropic.claude-opus-5",
      }),
    ).toBeCloseTo(36.75);
  });

  it("retains historical Opus 4.8 pricing", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "claude-opus-4-8" }),
    ).toBeCloseTo(36.75);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camel/anthropic/claude-opus-4.8",
      }),
    ).toBeCloseTo(36.75);
  });

  it("calculates Gemini 3.5 Flash fallback pricing exactly from OpenRouter meters", () => {
    expect(
      calculateUsageCostUsd({
        model: "google/gemini-3.5-flash",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(10.733333333333333);
  });

  it("normalizes prefixed Gemini 3.5 Flash model strings to the same pricing", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "gemini-3.5-flash" }),
    ).toBeCloseTo(10.733333333333333);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camel/google/gemini-3.5-flash",
      }),
    ).toBeCloseTo(10.733333333333333);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "openrouter/google/gemini-3.5-flash",
      }),
    ).toBeCloseTo(10.733333333333333);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camelai-openrouter/google/gemini-3.5-flash",
      }),
    ).toBeCloseTo(10.733333333333333);
  });

  it("keeps historical Gemini 3.1 Pro Preview pricing available", () => {
    expect(
      calculateUsageCostUsd({
        model: "google/gemini-3.1-pro-preview",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
      }),
    ).toBeCloseTo(14.575);
  });

  it("calculates Kimi K2.7 Code pricing and hosted prefixes", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "kimi-k2.7-code" }),
    ).toBeCloseTo(4.39);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "moonshotai/kimi-k2.7-code",
      }),
    ).toBeCloseTo(4.39);
    expect(
      calculateUsageCostUsd({
        ...usage,
        model: "camelai-openrouter/moonshotai/kimi-k2.7-code:nitro",
      }),
    ).toBeCloseTo(4.39);
  });

  it("keeps historical Kimi K2.6 and latest pricing available", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    };

    expect(
      calculateUsageCostUsd({ ...usage, model: "moonshotai/kimi-k2.6" }),
    ).toBeCloseTo(5.3998);
    expect(
      calculateUsageCostUsd({ ...usage, model: "~moonshotai/kimi-latest" }),
    ).toBeCloseTo(5.3998);
  });
});
