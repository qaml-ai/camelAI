import { describe, expect, it } from 'vitest';
import { logoRegistry } from '@/lib/integration-logo-registry';
import { OPENAI_COMPATIBLE_LLM_MODEL_OPTIONS } from '@/lib/llm-provider-config';
import {
  ALL_LLM_MODELS,
  COST_BUCKET_MAX,
  LLM_MODEL_TO_PRICING_KEY,
  MODEL_CATALOG,
  resolveModelPickerCatalog,
} from '@/lib/model-catalog';
import type { LlmModel } from '@/types';

const CURRENT_MODELS: Array<{
  id: LlmModel;
  label: string;
  providerLogo: string;
  providerOrder: number;
  modelOrder: number;
  pricingKey: string;
  cost: string;
}> = [
  { id: 'opus-5.5', label: 'Opus 5.5', providerLogo: 'claude', providerOrder: 0, modelOrder: 0, pricingKey: 'claude-opus-5-5', cost: '$$$$' },
  { id: 'fable-5.1', label: 'Fable 5.1', providerLogo: 'claude', providerOrder: 0, modelOrder: 1, pricingKey: 'claude-fable-5-1', cost: '$$$$$' },
  { id: 'sonnet', label: 'Sonnet 5.5', providerLogo: 'claude', providerOrder: 0, modelOrder: 2, pricingKey: 'claude-sonnet-5-5', cost: '$$$' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', providerLogo: 'openai', providerOrder: 1, modelOrder: 0, pricingKey: 'gpt-6-sol', cost: '$$$' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', providerLogo: 'openai', providerOrder: 1, modelOrder: 1, pricingKey: 'gpt-6-luna', cost: '$' },
  { id: 'gpt-5.6-terra-bedrock', label: 'GPT-5.6 Terra Bedrock', providerLogo: 'openai', providerOrder: 1, modelOrder: 2, pricingKey: 'gpt-5.6-terra', cost: '$$$' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', providerLogo: 'gemini', providerOrder: 2, modelOrder: 0, pricingKey: 'google/gemini-3.8-flash', cost: '$$' },
  { id: 'deepseek-v4-auto', label: 'camelCode', providerLogo: 'camelai', providerOrder: 3, modelOrder: 0, pricingKey: 'deepseek-v4-auto', cost: 'Free' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', providerLogo: 'deepseek', providerOrder: 3, modelOrder: 1, pricingKey: 'deepseek/deepseek-v4.1-flash', cost: '$$' },
  { id: 'kimi-k3', label: 'Kimi K3', providerLogo: 'kimi', providerOrder: 4, modelOrder: 0, pricingKey: 'moonshotai/kimi-k3', cost: '$$$' },
  { id: 'grok-4.7', label: 'Grok 4.7', providerLogo: 'grok', providerOrder: 5, modelOrder: 0, pricingKey: 'x-ai/grok-4.7', cost: '$$$' },
  { id: 'glm-5.3', label: 'GLM 5.3', providerLogo: 'glm', providerOrder: 6, modelOrder: 0, pricingKey: 'z-ai/glm-5.3', cost: '$$' },
  { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', providerLogo: 'glm', providerOrder: 6, modelOrder: 1, pricingKey: 'z-ai/glm-5.3-flash', cost: '$' },
];

const RETIRED_MODELS = [
  'haiku',
  'opus',
  'opus-4.7',
  'opus-5',
  'fable-5',
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.6-sol-bedrock',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'kimi-k2.7-code',
  'grok-4.5',
];

describe('MODEL_CATALOG', () => {
  it('uses camelCode in both free-model label sources', () => {
    expect(MODEL_CATALOG['deepseek-v4-auto'].label).toBe('camelCode');
    expect(
      OPENAI_COMPATIBLE_LLM_MODEL_OPTIONS.find(
        (option) => option.value === 'deepseek-v4-auto',
      )?.label,
    ).toBe('camelCode');
  });

  it('has one entry for every supported LlmModel', () => {
    for (const model of ALL_LLM_MODELS) {
      expect(MODEL_CATALOG[model]).toBeDefined();
      expect(MODEL_CATALOG[model].id).toBe(model);
    }
  });

  it('uses registered logo types', () => {
    for (const entry of Object.values(MODEL_CATALOG)) {
      expect(logoRegistry[entry.providerLogo]).toBeDefined();
    }
  });

  it('keeps metadata values in the expected finite sets', () => {
    const ALLOWED_SCORES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
    for (const entry of Object.values(MODEL_CATALOG)) {
      expect([0, 1, 2, 3, 4, 5, 6]).toContain(entry.providerOrder);
      expect(entry.modelOrder).toBeGreaterThanOrEqual(0);
      expect(entry.cost === 'Free' || /^\$+$/.test(entry.cost)).toBe(true);
      if (entry.cost !== 'Free') {
        expect(entry.cost.length).toBeGreaterThanOrEqual(1);
        expect(entry.cost.length).toBeLessThanOrEqual(COST_BUCKET_MAX);
      }
      expect(ALLOWED_SCORES).toContain(entry.intelligence);
      expect(ALLOWED_SCORES).toContain(entry.speed);
      expect(entry.label.trim()).not.toBe('');
    }
  });

  it('uses Claude product logos for Anthropic-family models', () => {
    expect(MODEL_CATALOG['opus-5.5'].providerLogo).toBe('claude');
    expect(MODEL_CATALOG.sonnet.providerLogo).toBe('claude');
    expect(MODEL_CATALOG['fable-5.1'].providerLogo).toBe('claude');
  });

  it('has pricing key mappings for every supported model', () => {
    for (const model of ALL_LLM_MODELS) {
      expect(LLM_MODEL_TO_PRICING_KEY[model]).toEqual(expect.any(String));
    }
  });

  it('lists exactly the current models with their metadata and pricing keys', () => {
    expect([...ALL_LLM_MODELS].sort()).toEqual(
      [...CURRENT_MODELS.map((model) => model.id), 'custom'].sort(),
    );
    for (const expected of CURRENT_MODELS) {
      expect(MODEL_CATALOG[expected.id]).toMatchObject({
        id: expected.id,
        label: expected.label,
        providerLogo: expected.providerLogo,
        providerOrder: expected.providerOrder,
        modelOrder: expected.modelOrder,
        cost: expected.cost,
      });
      expect(LLM_MODEL_TO_PRICING_KEY[expected.id]).toBe(expected.pricingKey);
    }
  });

  it('does not expose retired models as selectable', () => {
    for (const retired of RETIRED_MODELS) {
      expect(ALL_LLM_MODELS).not.toContain(retired);
      expect(MODEL_CATALOG).not.toHaveProperty(retired);
      expect(LLM_MODEL_TO_PRICING_KEY).not.toHaveProperty(retired);
    }
  });

  it('hides Claude and OpenRouter-only models for OpenAI BYOK orgs', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: false,
        default_model: null,
        models: [
          { id: 'sonnet', added_at: 1 },
          { id: 'opus-5.5', added_at: 11 },
          { id: 'gpt-6-sol', added_at: 12 },
          { id: 'gpt-6-luna', added_at: 14 },
          { id: 'kimi-k3', added_at: 5 },
          { id: 'grok-4.7', added_at: 6 },
          { id: 'gemini-3.8-flash', added_at: 8 },
          { id: 'deepseek-v4-auto', added_at: 10 },
          { id: 'deepseek-v4.1-flash', added_at: 11 },
        ],
      },
      orgProvider: 'openai',
    });

    expect(visible.map((entry) => entry.id)).toEqual([
      'deepseek-v4-auto',
      'gpt-6-sol',
      'gpt-6-luna',
    ]);
  });

  it('adds direct OpenAI models for an organization subscription', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: true,
        default_model: null,
        models: [],
      },
      orgProvider: 'anthropic',
      allowOpenAiSubscription: true,
    }).map((entry) => entry.id);

    expect(visible).toContain('sonnet');
    expect(visible).toContain('gpt-6-luna');
    expect(visible).not.toContain('kimi-k3');
    expect(visible).not.toContain('gpt-5.6-terra-bedrock');
  });

  it('filters custom provider picker models by API mode', () => {
    const effectiveConfig = {
      source: 'org' as const,
      use_platform_defaults: false,
      default_model: null,
        models: [
        { id: 'sonnet' as const, added_at: 1 },
        { id: 'opus-5.5' as const, added_at: 2 },
        { id: 'gpt-6-sol' as const, added_at: 3 },
        { id: 'gpt-6-luna' as const, added_at: 5 },
        { id: 'kimi-k3' as const, added_at: 6 },
      ],
    };

    expect(
      resolveModelPickerCatalog({
        effectiveConfig,
        orgProvider: 'custom',
        customApi: 'openai-responses',
      }).map((entry) => entry.id),
    ).toEqual(['gpt-6-sol', 'gpt-6-luna']);
    expect(
      resolveModelPickerCatalog({
        effectiveConfig,
        orgProvider: 'custom',
        customApi: 'anthropic-messages',
      }).map((entry) => entry.id),
    ).toEqual(['opus-5.5', 'sonnet']);
    expect(
      resolveModelPickerCatalog({
        effectiveConfig,
        orgProvider: 'custom',
        customApi: 'openai-responses',
        customModelId: 'pi-custom-model',
      }).map((entry) => entry.id),
    ).toEqual([]);
    expect(
      resolveModelPickerCatalog({
        effectiveConfig: {
          source: 'org',
          use_platform_defaults: true,
          default_model: null,
          models: [],
        },
        orgProvider: 'custom',
        customApi: 'openai-responses',
        customModelId: 'pi-custom-model',
      }).map((entry) => entry.id),
    ).toEqual(['custom']);
  });

  it('uses current OpenRouter BYOK platform models grouped by provider, then model order', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: true,
        default_model: null,
        models: [],
      },
      orgProvider: 'openrouter',
    });

    expect(visible.map((entry) => entry.id)).toEqual([
      'deepseek-v4-auto',
      'opus-5.5',
      'fable-5.1',
      'sonnet',
      'gpt-6-sol',
      'gpt-6-luna',
      'gemini-3.8-flash',
      'deepseek-v4.1-flash',
      'kimi-k3',
      'grok-4.7',
      'glm-5.3',
      'glm-5.3-flash',
    ]);
  });

  it('includes Fable in compatible platform defaults', () => {
    const platformDefaults = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: true,
        default_model: null,
        models: [],
      },
      orgProvider: null,
    });
    expect(platformDefaults.map((entry) => entry.id)).toContain('fable-5.1');
  });

  it('keeps camelCode in hosted camelAI platform models', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: true,
        default_model: null,
        models: [],
      },
      orgProvider: null,
    });

    expect(visible[0]?.id).toBe('deepseek-v4-auto');
  });

  it('removes gateway-only camelCode from self-host platform models', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: true,
        default_model: null,
        models: [],
      },
      orgProvider: 'bedrock',
      allowCamelCode: false,
    });

    expect(visible.map((entry) => entry.id)).not.toContain('deepseek-v4-auto');
    expect(visible.map((entry) => entry.id)).toContain('sonnet');
  });

  it('uses explicit custom overrides as an allowlist', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: false,
        default_model: null,
        models: [{ id: 'sonnet', added_at: 1 }],
      },
      orgProvider: 'openrouter',
    });

    expect(visible.map((entry) => entry.id)).toEqual(['sonnet']);
    expect(visible.map((entry) => entry.id)).not.toContain('fable-5.1');
  });
});
