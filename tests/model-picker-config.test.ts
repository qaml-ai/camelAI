import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultOrgModelPickerConfig,
  parseOrgModelPickerConfig,
  parseWorkspaceModelPickerConfig,
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from '@/lib/model-picker-config';
import {
  CAMEL_CODE_LLM_MODEL,
  getVisibleLlmModelOptions,
} from '@/lib/llm-provider-config';

describe('model picker config parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the org default for empty or malformed org config values', () => {
    expect(parseOrgModelPickerConfig(null)).toEqual(defaultOrgModelPickerConfig());
    expect(parseOrgModelPickerConfig(undefined)).toEqual(defaultOrgModelPickerConfig());
    expect(parseOrgModelPickerConfig({})).toEqual(defaultOrgModelPickerConfig());
    expect(parseOrgModelPickerConfig('{not json')).toEqual(defaultOrgModelPickerConfig());
  });

  it('normalizes org configs', () => {
    const parsed = parseOrgModelPickerConfig({
      use_platform_defaults: false,
      models: [
        { id: 'opus', added_at: 10 },
        { id: 'gpt-99', added_at: 9 },
        { id: 'sonnet' },
      ],
      default_model: 'gpt-99',
    });

    expect(parsed.models).toEqual([
      { id: 'opus-5', added_at: 10 },
      { id: 'sonnet', added_at: Date.now() },
    ]);
    expect(parsed.default_model).toBeNull();
  });

  it.each([parseOrgModelPickerConfig, parseWorkspaceModelPickerConfig])(
    'upgrades saved GLM models and defaults without duplicating picker rows (%#)',
    (parseConfig) => {
      const parsed = parseConfig({
        use_platform_defaults: false,
        models: [
          { id: 'glm-5.2', added_at: 10 },
          { id: 'glm-5.3', added_at: 20 },
        ],
        default_model: 'glm-5.2',
      });

      expect(parsed.models).toEqual([{ id: 'glm-5.3', added_at: 10 }]);
      expect(parsed.default_model).toBe('glm-5.3');
    },
  );

  it('allows an intentionally empty org picker', () => {
    expect(parseOrgModelPickerConfig({
      use_platform_defaults: true,
      models: [],
      default_model: 'sonnet',
    })).toEqual({
      use_platform_defaults: true,
      models: [],
      default_model: 'sonnet',
    });
  });

  it('retains org picker models while platform defaults are active', () => {
    expect(parseOrgModelPickerConfig({
      use_platform_defaults: true,
      models: [
        { id: 'sonnet', added_at: 10 },
        { id: 'opus', added_at: 9 },
      ],
      default_model: 'sonnet',
    })).toEqual({
      use_platform_defaults: true,
      models: [
        { id: 'sonnet', added_at: 10 },
        { id: 'opus-5', added_at: 9 },
      ],
      default_model: 'sonnet',
    });
  });

  it('retains workspace picker models while platform defaults are active', () => {
    expect(parseWorkspaceModelPickerConfig({
      use_org_defaults: false,
      use_platform_defaults: true,
      models: [
        { id: 'gpt-5.4', added_at: 10 },
      ],
      default_model: 'gpt-5.4',
    })).toEqual({
      use_org_defaults: false,
      use_platform_defaults: true,
      models: [
        { id: 'gpt-5.6-terra', added_at: 10 },
      ],
      default_model: 'gpt-5.6-terra',
    });
  });

  it('keeps all deduped org picker override models', () => {
    const parsed = parseOrgModelPickerConfig({
      use_platform_defaults: false,
      models: Array.from({ length: 12 }, (_, index) => ({
        id: index % 2 === 0 ? 'sonnet' : 'opus',
        added_at: index,
      })),
      default_model: 'sonnet',
    });

    expect(parsed.models.length).toBe(2);
  });

  it('uses platform defaults by default', () => {
    const config = defaultOrgModelPickerConfig();

    expect(config.default_model).toBeNull();
    expect(config.models).toEqual([]);
    expect(config.use_platform_defaults).toBe(true);
  });

  it('does not set an org default model until a user explicitly chooses one', () => {
    expect(defaultOrgModelPickerConfig().default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('openrouter').default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('openai').default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('anthropic').default_model).toBeNull();
    expect(defaultOrgModelPickerConfig('bedrock').default_model).toBeNull();
  });

  it('uses platform defaults for empty or malformed org config values', () => {
    expect(parseOrgModelPickerConfig(null, 'openai')).toEqual(
      defaultOrgModelPickerConfig(),
    );
    expect(
      parseOrgModelPickerConfig(null, 'custom', {
        customApi: 'anthropic-messages',
      }),
    ).toEqual(defaultOrgModelPickerConfig());
  });

  it('drops old hosted picker preferences without the explicit override flag', () => {
    const parsed = parseOrgModelPickerConfig({
      models: [
        { id: 'opus-4.8', added_at: 10 },
        { id: 'sonnet', added_at: 9 },
        { id: 'gpt-5.5', added_at: 8 },
        { id: 'gpt-5.4-mini', added_at: 7 },
        { id: 'gemini-3.5-flash', added_at: 6 },
        { id: 'gemini-3-flash-preview', added_at: 5 },
        { id: 'deepseek-v4-pro', added_at: 4 },
        { id: 'deepseek-v4-flash', added_at: 3 },
        { id: 'kimi-k2.6', added_at: 2 },
        { id: 'grok-4.5', added_at: 1 },
      ],
      default_model: null,
    });

    expect(parsed).toEqual(defaultOrgModelPickerConfig());
  });

  it('upgrades legacy Opus values in explicit custom picker overrides', () => {
    const parsed = parseOrgModelPickerConfig({
      use_platform_defaults: false,
      models: [
        { id: 'opus-4.8', added_at: 10 },
        { id: 'sonnet', added_at: 9 },
      ],
      default_model: null,
    });

    expect(parsed.models.map((model) => model.id)).toEqual([
      'opus-5',
      'sonnet',
    ]);
    expect(parsed.default_model).toBeNull();
    expect(parsed.use_platform_defaults).toBe(false);
  });

  it('drops old Claude picker preferences without the explicit override flag', () => {
    const parsed = parseOrgModelPickerConfig(
      {
        models: [
          { id: 'opus-4.8', added_at: 3 },
          { id: 'sonnet', added_at: 2 },
          { id: 'haiku', added_at: 1 },
        ],
        default_model: null,
      },
      'anthropic',
    );

    expect(parsed).toEqual(defaultOrgModelPickerConfig());
  });

  it('drops legacy picker configs without an explicit platform-default flag', () => {
    const parsed = parseOrgModelPickerConfig({
      models: [
        { id: 'opus-4.8', added_at: 2 },
        { id: 'sonnet', added_at: 1 },
      ],
      default_model: null,
    });

    expect(parsed).toEqual(defaultOrgModelPickerConfig());
  });

  it('normalizes newly supported models in stored picker configs', () => {
    const parsed = parseOrgModelPickerConfig({
      use_platform_defaults: false,
      models: [
        { id: 'gpt-5.5', added_at: 5 },
        { id: 'opus-5', added_at: 4 },
        { id: 'gemini-3-flash-preview', added_at: 4 },
        { id: 'gemini-3.5-flash', added_at: 3 },
        { id: 'deepseek-v4-pro', added_at: 2 },
        { id: 'deepseek-v4-flash', added_at: 1 },
      ],
      default_model: 'deepseek-v4-flash',
    });

    expect(parsed).toEqual({
      use_platform_defaults: false,
      models: [
        { id: 'gpt-5.6-terra', added_at: 5 },
        { id: 'opus-5', added_at: 4 },
        { id: 'gemini-3-flash-preview', added_at: 4 },
        { id: 'gemini-3.5-flash', added_at: 3 },
        { id: 'deepseek-v4-pro', added_at: 2 },
        { id: 'deepseek-v4-flash', added_at: 1 },
      ],
      default_model: 'deepseek-v4-flash',
    });
  });

  it('remaps legacy Gemini 3.1 Pro Preview rows and defaults', () => {
    const parsed = parseOrgModelPickerConfig({
      use_platform_defaults: false,
      models: [
        { id: 'gpt-5.6-terra', added_at: 5 },
        { id: 'gemini-3.1-pro-preview', added_at: 4 },
      ],
      default_model: 'gemini-3.1-pro-preview',
    });

    expect(parsed).toEqual({
      use_platform_defaults: false,
      models: [
        { id: 'gpt-5.6-terra', added_at: 5 },
        { id: 'gemini-3.5-flash', added_at: 4 },
      ],
      default_model: 'gemini-3.5-flash',
    });
  });

  it('dedupes legacy and current Gemini rows after remapping', () => {
    const parsed = parseWorkspaceModelPickerConfig({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [
        { id: 'gemini-3.1-pro-preview', added_at: 4 },
        { id: 'gemini-3.5-flash', added_at: 3 },
        { id: 'gemini-3-flash-preview', added_at: 2 },
      ],
      default_model: 'gemini-3.5-flash',
    });

    expect(parsed).toEqual({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [
        { id: 'gemini-3.5-flash', added_at: 4 },
        { id: 'gemini-3-flash-preview', added_at: 2 },
      ],
      default_model: 'gemini-3.5-flash',
    });
  });

  it('remaps legacy Kimi and Grok rows', () => {
    const parsed = parseWorkspaceModelPickerConfig({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [
        { id: 'kimi-k2.6', added_at: 4 },
        { id: 'kimi-k2.7-code', added_at: 3 },
        { id: 'grok-4.3', added_at: 2 },
      ],
      default_model: 'kimi-k2.6',
    });

    expect(parsed).toEqual({
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [
        { id: 'kimi-k2.7-code', added_at: 4 },
        { id: 'grok-4.5', added_at: 2 },
      ],
      default_model: 'kimi-k2.7-code',
    });
  });

  it('parses workspace inheritance defaults and remaps legacy Opus fields', () => {
    expect(parseWorkspaceModelPickerConfig(null)).toEqual({
      use_org_defaults: true,
      use_platform_defaults: true,
      models: [],
      default_model: null,
    });
    expect(
      parseWorkspaceModelPickerConfig({
        use_org_defaults: true,
        use_platform_defaults: false,
        models: [{ id: 'opus', added_at: 1 }],
        default_model: 'opus',
      }),
    ).toEqual({
      use_org_defaults: true,
      use_platform_defaults: false,
      models: [{ id: 'opus-5', added_at: 1 }],
      default_model: 'opus-5',
    });
  });

  it('resolves org vs workspace effective config', () => {
    const org = {
      use_platform_defaults: false,
      models: [{ id: 'sonnet' as const, added_at: 1 }],
      default_model: 'sonnet' as const,
    };
    const workspace = {
      use_org_defaults: false,
      use_platform_defaults: false,
      models: [{ id: 'opus-5' as const, added_at: 2 }],
      default_model: 'opus-5' as const,
    };

    expect(resolveEffectivePickerConfig(org, null).source).toBe('org');
    expect(resolveEffectivePickerConfig(org, { ...workspace, use_org_defaults: true })).toMatchObject({
      source: 'org',
      default_model: 'sonnet',
    });
    expect(resolveEffectivePickerConfig(org, workspace)).toMatchObject({
      source: 'workspace',
      default_model: 'opus-5',
    });
  });

  it('ignores retained defaults while platform defaults are active', () => {
    const org = {
      use_platform_defaults: true,
      models: [{ id: 'sonnet' as const, added_at: 1 }],
      default_model: 'sonnet' as const,
    };
    const workspace = {
      use_org_defaults: false,
      use_platform_defaults: true,
      models: [{ id: 'opus-5' as const, added_at: 2 }],
      default_model: 'opus-5' as const,
    };

    expect(resolveEffectivePickerConfig(org, null)).toMatchObject({
      source: 'org',
      default_model: null,
    });
    expect(resolveEffectivePickerConfig(org, workspace)).toMatchObject({
      source: 'workspace',
      default_model: null,
    });
  });
});

describe('default model resolution', () => {
  const visible = (ids: readonly ('opus-5' | 'sonnet' | 'gpt-5.6-terra')[]) =>
    ids.map((id) => ({ id }));

  it('uses the visible admin default before recent models', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: 'sonnet',
        recentModel: 'opus-5',
        visibleCatalog: visible(['opus-5', 'sonnet']),
      }),
    ).toBe('sonnet');
  });

  it('uses recent model when no visible admin default exists', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: 'opus-5',
        visibleCatalog: visible(['opus-5', 'sonnet']),
      }),
    ).toBe('opus-5');
  });

  it('falls back to the first visible model', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: 'sonnet',
        recentModel: null,
        visibleCatalog: visible(['gpt-5.6-terra']),
      }),
    ).toBe('gpt-5.6-terra');
  });

  it('uses the fallback model before the first visible model', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: null,
        fallbackModel: 'sonnet',
        visibleCatalog: visible(['opus-5', 'sonnet']),
      }),
    ).toBe('sonnet');
  });

  it('returns null when no models are visible', () => {
    expect(
      resolveDefaultModelForChat({
        effectiveDefaultModel: null,
        recentModel: null,
        visibleCatalog: [],
      }),
    ).toBeNull();
  });
});

describe('provider model visibility', () => {
  it.each(['openai', 'anthropic', 'openrouter'])(
    'keeps camelCode visible with the %s provider configured',
    (orgProvider) => {
      expect(
        getVisibleLlmModelOptions(null, { orgProvider }).map(
          (option) => option.value,
        ),
      ).toContain(CAMEL_CODE_LLM_MODEL);
    },
  );
});
