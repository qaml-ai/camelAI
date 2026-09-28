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
      lookupPricing("claude-sonnet-5-5"),
    );
  });

  it("prices Sonnet 5.5 on every provider id, like Sonnet 5", () => {
    for (const id of [
      "claude-sonnet-5-5",
      "anthropic/claude-sonnet-5.5",
      "anthropic/claude-sonnet-5.5:nitro",
      "anthropic.claude-sonnet-5-5",
      "us.anthropic.claude-sonnet-5-5",
    ]) {
      expect(lookupPricingOrNull(id)).toEqual(lookupPricing("claude-sonnet-5-5"));
    }
    expect(lookupPricing("claude-sonnet-5-5")).toEqual(lookupPricing("claude-sonnet-5"));
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
    // The runtime's free tier.
    expect(lookupPricingOrNull("openai/gpt-6-luna")).toMatchObject({
      inputPerToken: 0.0000001,
      outputPerToken: 0.0000005,
      cacheReadPerToken: 0.00000001,
    });
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

describe("current model list pricing", () => {
  const perMillion = (model: string) => {
    const pricing = lookupPricingOrNull(model);
    if (!pricing) return null;
    return {
      input: +(pricing.inputPerToken * 1e6).toFixed(6),
      output: +(pricing.outputPerToken * 1e6).toFixed(6),
      cacheRead: +((pricing.cacheReadPerToken ?? 0) * 1e6).toFixed(6),
      cacheWrite: +((pricing.cacheCreationPerToken ?? 0) * 1e6).toFixed(6),
    };
  };

  it("prices every spelling of each new model, not the Sonnet fallback", () => {
    const expected: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
      "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      "anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      "openrouter/anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      "anthropic.claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      "amazon-bedrock/us.anthropic.claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      "camel/anthropic/claude-fable-5.1:nitro": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      "anthropic.claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      "openrouter/openai/gpt-6-sol:nitro": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      "openai/gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      "moonshotai/kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      "kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      "x-ai/grok-4.7:nitro": { input: 1.6, output: 4.8, cacheRead: 0.4, cacheWrite: 0 },
      "grok-4.7": { input: 1.6, output: 4.8, cacheRead: 0.4, cacheWrite: 0 },
      "z-ai/glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
      "google/gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.041667 },
      "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.041667 },
      "deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
      "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
    };
    for (const [model, prices] of Object.entries(expected)) {
      expect(perMillion(model), model).toEqual(prices);
    }
  });

  it("keeps retired models on their historical prices", () => {
    expect(perMillion("claude-opus-5")).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(perMillion("anthropic/claude-fable-5")).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
    expect(perMillion("gpt-5.6-terra")?.input).toBe(2);
    expect(perMillion("moonshotai/kimi-k2.7-code")?.input).toBe(0.74);
    expect(perMillion("x-ai/grok-4.5")?.input).toBe(2);
    expect(perMillion("google/gemini-3.5-flash")?.input).toBe(1.5);
    expect(perMillion("deepseek/deepseek-v4-flash")?.input).toBe(0.14);
    expect(perMillion("z-ai/glm-5.3")?.input).toBe(0.84);
  });

  it("applies GPT-6 Sol's long-context tier", () => {
    const usage = { model: "gpt-6-sol", inputTokens: 300_000, outputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(calculateUsageCostUsd(usage)).toBeCloseTo(300_000 * 0.000004 + 1_000_000 * 0.000015);
  });
});
