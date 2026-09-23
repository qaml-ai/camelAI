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

const NEW_ROUTED_MODELS: Array<{
  id: LlmModel;
  label: string;
  providerLogo: string;
  providerOrder: number;
  modelOrder: number;
  pricingKey: string;
  cost: string;
  intelligence: number;
  speed: number;
}> = [
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    providerLogo: 'gemini',
    providerOrder: 2,
    modelOrder: 0,
    pricingKey: 'google/gemini-3.5-flash',
    cost: '$$$',
    intelligence: 4,
    speed: 4.5,
  },
  {
    id: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash Preview',
    providerLogo: 'gemini',
    providerOrder: 2,
    modelOrder: 1,
    pricingKey: 'google/gemini-3-flash-preview',
    cost: '$$',
    intelligence: 2,
    speed: 5,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    providerLogo: 'deepseek',
    providerOrder: 3,
    modelOrder: 0,
    pricingKey: 'deepseek/deepseek-v4-pro',
    cost: '$',
    intelligence: 3,
    speed: 3.5,
  },
  {
    id: 'deepseek-v4-auto',
    label: 'camelCode',
    providerLogo: 'camelai',
    providerOrder: 3,
    modelOrder: 1,
    pricingKey: 'deepseek-v4-auto',
    cost: 'Free',
    intelligence: 3,
    speed: 3.5,
  },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    providerLogo: 'deepseek',
    providerOrder: 3,
    modelOrder: 2,
    pricingKey: 'deepseek/deepseek-v4-flash',
    cost: '$',
    intelligence: 1.5,
    speed: 5,
  },
];

const NEW_FRONTIER_MODELS: Array<{
  id: LlmModel;
  label: string;
  providerLogo: string;
  pricingKey: string;
  cost: string;
}> = [
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    providerLogo: 'openai',
    pricingKey: 'gpt-5.6-luna',
    cost: '$',
  },
  {
    id: 'opus-5',
    label: 'Opus 5',
    providerLogo: 'claude',
    pricingKey: 'claude-opus-5',
    cost: '$$$$',
  },
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
    expect(MODEL_CATALOG['opus-5'].providerLogo).toBe('claude');
    expect(MODEL_CATALOG.sonnet.providerLogo).toBe('claude');
    expect(MODEL_CATALOG.haiku.providerLogo).toBe('claude');
  });

  it('has pricing key mappings for every supported model', () => {
    for (const model of ALL_LLM_MODELS) {
      expect(LLM_MODEL_TO_PRICING_KEY[model]).toEqual(expect.any(String));
    }
  });

  it('does not expose retired Gemini 3.1 Pro Preview as a selectable model', () => {
    expect(ALL_LLM_MODELS).not.toContain('gemini-3.1-pro-preview');
    expect(MODEL_CATALOG).not.toHaveProperty('gemini-3.1-pro-preview');
    expect(LLM_MODEL_TO_PRICING_KEY).not.toHaveProperty(
      'gemini-3.1-pro-preview',
    );
  });

  it('adds Gemini and DeepSeek metadata with provider pricing keys', () => {
    for (const expected of NEW_ROUTED_MODELS) {
      expect(MODEL_CATALOG[expected.id]).toMatchObject({
        id: expected.id,
        label: expected.label,
        providerLogo: expected.providerLogo,
        providerOrder: expected.providerOrder,
        modelOrder: expected.modelOrder,
        cost: expected.cost,
        intelligence: expected.intelligence,
        speed: expected.speed,
      });
      expect(LLM_MODEL_TO_PRICING_KEY[expected.id]).toBe(expected.pricingKey);
    }
  });

  it('adds Luna and Opus 5 as distinct priced models', () => {
    for (const expected of NEW_FRONTIER_MODELS) {
      expect(MODEL_CATALOG[expected.id]).toMatchObject({
        id: expected.id,
        label: expected.label,
        providerLogo: expected.providerLogo,
        cost: expected.cost,
      });
      expect(LLM_MODEL_TO_PRICING_KEY[expected.id]).toBe(expected.pricingKey);
    }
    expect(MODEL_CATALOG).not.toHaveProperty('opus');
    expect(MODEL_CATALOG).not.toHaveProperty('opus-4.7');
    expect(LLM_MODEL_TO_PRICING_KEY).not.toHaveProperty('opus');
    expect(LLM_MODEL_TO_PRICING_KEY).not.toHaveProperty('opus-4.7');
    expect(MODEL_CATALOG).not.toHaveProperty('gpt-5.5');
    expect(LLM_MODEL_TO_PRICING_KEY).not.toHaveProperty('gpt-5.5');
    expect(MODEL_CATALOG['fable-5']).toMatchObject({
      id: 'fable-5',
      label: 'Fable 5',
      providerLogo: 'claude',
      cost: '$$$$$',
    });
    expect(LLM_MODEL_TO_PRICING_KEY['fable-5']).toBe('claude-fable-5');
  });

  it('hides Claude and OpenRouter-only models for OpenAI BYOK orgs', () => {
    const visible = resolveModelPickerCatalog({
      effectiveConfig: {
        source: 'org',
        use_platform_defaults: false,
        default_model: null,
        models: [
          { id: 'sonnet', added_at: 1 },
          { id: 'opus-5', added_at: 11 },
          { id: 'gpt-5.6-sol', added_at: 12 },
          { id: 'gpt-5.6-terra', added_at: 13 },
          { id: 'gpt-5.6-luna', added_at: 14 },
          { id: 'kimi-k2.7-code', added_at: 5 },
          { id: 'grok-4.5', added_at: 6 },
          { id: 'gemini-3-flash-preview', added_at: 7 },
          { id: 'gemini-3.5-flash', added_at: 8 },
          { id: 'deepseek-v4-pro', added_at: 9 },
          { id: 'deepseek-v4-auto', added_at: 10 },
          { id: 'deepseek-v4-flash', added_at: 11 },
        ],
      },
      orgProvider: 'openai',
    });

    expect(visible.map((entry) => entry.id)).toEqual([
      'deepseek-v4-auto',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
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
    expect(visible).toContain('gpt-5.6-terra');
    expect(visible).not.toContain('kimi-k2.7-code');
    expect(visible).not.toContain('gpt-5.5-bedrock');
  });

  it('filters custom provider picker models by API mode', () => {
    const effectiveConfig = {
      source: 'org' as const,
      use_platform_defaults: false,
      default_model: null,
        models: [
        { id: 'sonnet' as const, added_at: 1 },
        { id: 'opus-5' as const, added_at: 2 },
        { id: 'gpt-5.6-sol' as const, added_at: 3 },
        { id: 'gpt-5.6-terra' as const, added_at: 4 },
        { id: 'gpt-5.6-luna' as const, added_at: 5 },
        { id: 'kimi-k2.7-code' as const, added_at: 6 },
      ],
    };

    expect(
      resolveModelPickerCatalog({
        effectiveConfig,
        orgProvider: 'custom',
        customApi: 'openai-responses',
      }).map((entry) => entry.id),
    ).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(
      resolveModelPickerCatalog({
        effectiveConfig,
        orgProvider: 'custom',
        customApi: 'anthropic-messages',
      }).map((entry) => entry.id),
    ).toEqual(['opus-5', 'sonnet']);
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
      'opus-5',
      'fable-5',
      'sonnet',
      'haiku',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gemini-3.5-flash',
      'gemini-3-flash-preview',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.7-code',
      'grok-4.5',
      'glm-5.3',
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
    expect(platformDefaults.map((entry) => entry.id)).toContain('fable-5');
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
    expect(visible.map((entry) => entry.id)).not.toContain('fable-5');
  });
});
