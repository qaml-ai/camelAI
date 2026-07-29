import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getEnvMock = vi.fn();

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/thread-title-generation.server', () => ({
  generateThreadTitleWithOpenAI: vi.fn(),
}));

const {
  applyHostedCreditPause,
  createThread,
  createThreadWithValidatedAccess,
  deleteThread,
  getRecentThreads,
  getThread,
  getWorkspaceModelPickerState,
  generateThreadTitle,
  updateThread,
  updateThreadModel,
} = await import('@/lib/chat-do.server');
const { MODEL_CATALOG } = await import('@/lib/model-catalog');
const { CAMEL_CODE_LLM_MODEL } = await import('@/lib/llm-provider-config');
type WorkspaceModelPickerState =
  import('@/lib/chat-do.server').WorkspaceModelPickerState;
const { generateThreadTitleWithOpenAI } = await import('@/lib/thread-title-generation.server');

describe('getWorkspaceModelPickerState rollout compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails when model picker config RPCs are missing', async () => {
    const error = new Error('No such RPC method getModelPickerConfig');
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockRejectedValue(error),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(getWorkspaceModelPickerState({}, 'ws_123')).rejects.toBe(
      error,
    );
  });

  it('retries transient model picker config RPC failures', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Durable Object reset because its code was updated.'),
        )
        .mockResolvedValueOnce({
          use_org_defaults: true,
          models: [],
          default_model: null,
        }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Durable Object reset because its code was updated.'),
        )
        .mockResolvedValueOnce({
          use_platform_defaults: true,
          models: [],
          default_model: null,
        }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');
    expect(state).toMatchObject({
      orgId: 'org_123',
      llmProvider: null,
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      defaultModel: 'sonnet',
    });
    expect(state?.allowedThreadModels).toContain('sonnet');
    expect(state?.allowedThreadModels).toContain('gpt-5.6-luna');
    expect(state?.allowedThreadModels).toContain('gpt-5.6-terra');
    expect(orgStub.getModelPickerConfig).toHaveBeenCalledTimes(2);
    expect(workspaceStub.getModelPickerConfig).toHaveBeenCalledTimes(2);
  });

  it('links workspace pickers to their scoped model settings', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: false,
        use_platform_defaults: false,
        models: [{ id: 'sonnet', added_at: 1 }],
        default_model: 'sonnet',
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({
        billing_status: 'inactive',
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
      }),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');

    expect(state?.modelPickerSettingsHref).toBe(
      '/settings/organization/models?scope=ws&workspaceId=ws_123',
    );
    expect(state?.modelOptions.map((option) => option.id)).toEqual(['sonnet']);
    expect(state?.allowedThreadModels).toEqual([]);
  });

  it('defaults an inactive zero-credit hosted organization to camelCode', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({
        billing_status: 'inactive',
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
      }),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_free',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'deepseek-v4-auto',
        created_at: 1,
        updated_at: 1,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');

    expect(state).toMatchObject({
      llmProvider: null,
      effectivePickerDefaultModel: null,
      defaultModel: 'deepseek-v4-auto',
    });

    await createThread({}, 'ws_123', 'New Chat', 'user_123');
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'deepseek-v4-auto',
    );
  });

  it('never exposes or accepts camelCode in self-host mode', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({
        billing_status: 'inactive',
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
      }),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_selfhost',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 1,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      CF_ACCOUNT_ID: 'selfhost',
      SELFHOST_AI_PROVIDER: 'bedrock',
      SELFHOST_AI_API_KEY: 'bedrock-api-key-test',
      SELFHOST_AI_AWS_REGION: 'us-east-1',
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');

    expect(state).toMatchObject({
      billingAccessMode: 'selfhost',
      llmProvider: 'bedrock',
      defaultModel: 'sonnet',
    });
    expect(state?.modelOptions.map((option) => option.id)).not.toContain(
      CAMEL_CODE_LLM_MODEL,
    );
    expect(state?.allowedThreadModels).not.toContain(CAMEL_CODE_LLM_MODEL);

    await expect(
      createThread(
        {},
        'ws_123',
        'New Chat',
        'user_123',
        undefined,
        CAMEL_CODE_LLM_MODEL,
      ),
    ).rejects.toThrow('Invalid thread model');

    await createThread({}, 'ws_123', 'New Chat', 'user_123');
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'sonnet',
    );
  });

  it('keeps the hosted premium default for a subscribed organization', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({
        billing_status: 'active',
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
      }),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');

    expect(state?.defaultModel).toBe('sonnet');
  });

  it('locks premium models in free mode while preserving paid and OpenAI coverage', async () => {
    async function loadState({
      billingStatus,
      openAiSubscription = null,
      usePlatformDefaults = false,
    }: {
      billingStatus: 'inactive' | 'active';
      openAiSubscription?: object | null;
      usePlatformDefaults?: boolean;
    }) {
      const workspaceStub = {
        getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
        getModelPickerConfig: vi.fn().mockResolvedValue({
          use_org_defaults: true,
          models: [],
          default_model: null,
        }),
      };
      const orgStub = {
        getInfo: vi.fn().mockResolvedValue({
          billing_status: billingStatus,
          billing_credit_purchase_total_cents: 0,
          billing_credit_grant_total_cents: 0,
        }),
        getLlmProviderConfig: vi.fn().mockResolvedValue(null),
        getOpenAiSubscription: vi.fn().mockResolvedValue(openAiSubscription),
        getModelPickerConfig: vi.fn().mockResolvedValue(
          usePlatformDefaults
            ? {
                use_platform_defaults: true,
                models: [],
                default_model: null,
              }
            : {
                use_platform_defaults: false,
                models: [
                  { id: 'fable-5', added_at: 4 },
                  { id: 'sonnet', added_at: 3 },
                  { id: 'gpt-5.6-sol', added_at: 2 },
                  { id: 'grok-4.5', added_at: 1 },
                ],
                default_model: 'sonnet',
              },
        ),
      };

      getEnvMock.mockReturnValue({
        WORKSPACE: {
          idFromName: (id: string) => id,
          get: () => workspaceStub,
        },
        ORG: {
          idFromName: (id: string) => id,
          get: () => orgStub,
        },
      });

      return getWorkspaceModelPickerState({}, 'ws_123');
    }

    const freeState = await loadState({ billingStatus: 'inactive' });
    expect(freeState).toMatchObject({
      billingAccessMode: 'camel_free',
      defaultModel: null,
      effectivePickerDefaultModel: 'sonnet',
      canUnlockPremiumModels: true,
    });
    expect(freeState?.allowedThreadModels).toEqual([]);
    expect(freeState?.modelOptions.map((option) => option.id)).not.toContain(
      'deepseek-v4-auto',
    );
    expect(
      freeState?.modelOptions.find((option) => option.id === 'sonnet'),
    ).toMatchObject({ locked: true, unlockHint: 'generic' });
    expect(
      freeState?.modelOptions.find((option) => option.id === 'fable-5'),
    ).toMatchObject({ locked: true, unlockHint: 'generic' });
    expect(
      freeState?.modelOptions.find((option) => option.id === 'gpt-5.6-sol'),
    ).toMatchObject({ locked: true, unlockHint: 'openai' });
    expect(
      freeState?.modelOptions.find((option) => option.id === 'grok-4.5'),
    ).toMatchObject({ locked: true, unlockHint: 'generic' });

    const openAiState = await loadState({
      billingStatus: 'inactive',
      openAiSubscription: { account_id: 'acct_123' },
    });
    expect(openAiState?.billingAccessMode).toBe('camel_free');
    expect(openAiState?.canUnlockPremiumModels).toBe(true);
    expect(openAiState?.defaultModel).toBe('gpt-5.6-sol');
    expect(openAiState?.effectivePickerDefaultModel).toBe('gpt-5.6-sol');
    expect(openAiState?.allowedThreadModels).toContain('gpt-5.6-sol');
    expect(
      openAiState?.modelOptions.find(
        (option) => option.id === 'gpt-5.6-sol',
      )?.locked,
    ).not.toBe(true);
    expect(openAiState?.modelOptions.some((option) => option.locked)).toBe(false);
    expect(openAiState?.modelOptions.map((option) => option.id)).not.toContain(
      'sonnet',
    );
    expect(openAiState?.modelOptions.map((option) => option.id)).not.toContain(
      'grok-4.5',
    );
    expect(openAiState?.modelOptions.map((option) => option.id)).not.toContain(
      'deepseek-v4-auto',
    );

    const platformFreeState = await loadState({
      billingStatus: 'inactive',
      usePlatformDefaults: true,
    });
    expect(
      platformFreeState?.modelOptions.find(
        (option) => option.id === 'fable-5',
      ),
    ).toMatchObject({ locked: true, unlockHint: 'generic' });

    const paidState = await loadState({
      billingStatus: 'active',
      usePlatformDefaults: true,
    });
    expect(paidState?.billingAccessMode).toBe('subscription');
    expect(
      paidState?.modelOptions.find((option) => option.id === 'fable-5'),
    ).toMatchObject({ id: 'fable-5' });
    expect(paidState?.canUnlockPremiumModels).toBe(false);
    expect(paidState?.modelOptions.some((option) => option.locked)).toBe(false);
  });

  function pickerState(
    overrides: Partial<WorkspaceModelPickerState> = {},
  ): WorkspaceModelPickerState {
    return {
      orgId: 'org_123',
      llmProvider: null,
      customApi: null,
      customModelId: null,
      awsRegion: null,
      allowOpenAiSubscription: false,
      billingAccessMode: 'subscription',
      modelOptions: [
        MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
        MODEL_CATALOG.sonnet,
        MODEL_CATALOG['gpt-5.6-sol'],
        MODEL_CATALOG['grok-4.5'],
      ],
      allowedThreadModels: [
        CAMEL_CODE_LLM_MODEL,
        'sonnet',
        'gpt-5.6-sol',
        'grok-4.5',
      ],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
      canUnlockPremiumModels: false,
      hostedCreditsPaused: null,
      modelPickerSettingsHref: '/settings/organization/models',
      ...overrides,
    };
  }

  it.each([
    ['active', 'subscription', 'included_credits_exhausted'],
    ['trialing', 'subscription', 'trial_credits_exhausted'],
    ['inactive', 'credits', 'payg_credits_exhausted'],
    ['past_due', 'camel_free', 'subscription_unavailable'],
  ] as const)(
    'maps %s billing to %s hosted-model pauses',
    (billingStatus, billingAccessMode, reason) => {
      const result = applyHostedCreditPause(
        pickerState({ billingAccessMode }),
        { billingStatus, availableCreditsCents: 0 },
      );

      expect(result.hostedCreditsPaused).toEqual({ reason });
      expect(
        result.modelOptions.find(
          (option) => option.id === CAMEL_CODE_LLM_MODEL,
        )?.pausedReason,
      ).toBeUndefined();
      expect(
        result.modelOptions.find((option) => option.id === 'sonnet'),
      ).toMatchObject({ locked: true, pausedReason: reason });
      expect(result.allowedThreadModels).toEqual([CAMEL_CODE_LLM_MODEL]);
      expect(result.effectivePickerDefaultModel).toBe(CAMEL_CODE_LLM_MODEL);
      expect(result.defaultModel).toBe(CAMEL_CODE_LLM_MODEL);
    },
  );

  it('does not label a canceled subscription as a payment issue', () => {
    const state = pickerState({ billingAccessMode: 'camel_free' });
    const result = applyHostedCreditPause(state, {
      billingStatus: 'canceled',
      availableCreditsCents: 0,
    });

    expect(result.modelOptions).toEqual(state.modelOptions);
    expect(result.hostedCreditsPaused).toBeNull();
  });

  it('leaves BYOK- and OpenAI-covered models available during a hosted credit pause', () => {
    const result = applyHostedCreditPause(
      pickerState({
        llmProvider: 'anthropic',
        allowOpenAiSubscription: true,
      }),
      { billingStatus: 'active', availableCreditsCents: 0 },
    );

    expect(
      result.modelOptions.find((option) => option.id === 'sonnet')?.locked,
    ).not.toBe(true);
    expect(
      result.modelOptions.find((option) => option.id === 'gpt-5.6-sol')?.locked,
    ).not.toBe(true);
    expect(
      result.modelOptions.find((option) => option.id === 'grok-4.5'),
    ).toMatchObject({
      locked: true,
      pausedReason: 'included_credits_exhausted',
    });
  });

  it('keeps an all-paused custom picker unchanged and preserves its configured default', () => {
    const result = applyHostedCreditPause(
      pickerState({
        modelOptions: [MODEL_CATALOG.sonnet],
        allowedThreadModels: ['sonnet'],
      }),
      { billingStatus: 'active', availableCreditsCents: 0 },
    );

    expect(result.modelOptions.map((option) => option.id)).toEqual([
      'sonnet',
    ]);
    expect(result.allowedThreadModels).toEqual([]);
    expect(result.defaultModel).toBe('sonnet');
    expect(result.effectivePickerDefaultModel).toBe('sonnet');
  });

  it('uses the cheapest credential-covered model when the configured default pauses', () => {
    const result = applyHostedCreditPause(
      pickerState({
        allowOpenAiSubscription: true,
        modelOptions: [
          MODEL_CATALOG.sonnet,
          MODEL_CATALOG['gpt-5.6-sol'],
          MODEL_CATALOG['gpt-5.6-luna'],
        ],
        allowedThreadModels: [
          'sonnet',
          'gpt-5.6-sol',
          'gpt-5.6-luna',
        ],
      }),
      { billingStatus: 'active', availableCreditsCents: 0 },
    );

    expect(result.modelOptions.map((option) => option.id)).toEqual([
      'sonnet',
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ]);
    expect(result.allowedThreadModels).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ]);
    expect(result.defaultModel).toBe('gpt-5.6-luna');
    expect(result.effectivePickerDefaultModel).toBe('gpt-5.6-luna');
  });

  it.each(['enterprise', 'byok', 'camel_free'] as const)(
    'does not pause hosted models in %s mode',
    (billingAccessMode) => {
      const state = pickerState({ billingAccessMode });
      const result = applyHostedCreditPause(state, {
        billingStatus: 'active',
        availableCreditsCents: 0,
      });

      expect(result.modelOptions).toEqual(state.modelOptions);
      expect(result.hostedCreditsPaused).toBeNull();
    },
  );

  it('does not pause hosted models while credits remain', () => {
    const state = pickerState();
    const result = applyHostedCreditPause(state, {
      billingStatus: 'active',
      availableCreditsCents: 1,
    });

    expect(result.modelOptions).toEqual(state.modelOptions);
    expect(result.hostedCreditsPaused).toBeNull();
  });

  it('only offers More models when the org setup leaves unlockable catalog gaps', async () => {
    async function loadState(args: {
      provider?: 'anthropic' | 'openrouter' | 'custom';
      billingStatus?: 'inactive' | 'active' | 'enterprise';
      purchasedCredits?: number;
    }) {
      const workspaceStub = {
        getModelPickerConfig: vi.fn().mockResolvedValue({
          use_org_defaults: true,
          models: [],
          default_model: null,
        }),
      };
      const orgStub = {
        getOpenAiSubscription: vi.fn().mockResolvedValue(null),
        getModelPickerConfig: vi.fn().mockResolvedValue({
          use_platform_defaults: true,
          models: [],
          default_model: null,
        }),
      };
      getEnvMock.mockReturnValue({
        WORKSPACE: {
          idFromName: (id: string) => id,
          get: () => workspaceStub,
        },
        ORG: {
          idFromName: (id: string) => id,
          get: () => orgStub,
        },
      });
      const llmProviderConfig = args.provider
        ? {
            provider: args.provider,
            credentials_encrypted: 'encrypted',
            config:
              args.provider === 'custom'
                ? JSON.stringify({ custom_model_id: 'custom-model' })
                : '{}',
            created_by: 'user_123',
            created_at: 1,
            updated_at: 1,
          }
        : null;

      return getWorkspaceModelPickerState({}, 'ws_123', {
        orgId: 'org_123',
        llmProviderConfig,
        orgBillingState: {
          billing_status: args.billingStatus ?? 'inactive',
          billing_credit_purchase_total_cents: args.purchasedCredits ?? 0,
          billing_credit_grant_total_cents: 0,
        },
      });
    }

    await expect(loadState({ provider: 'anthropic' })).resolves.toMatchObject({
      billingAccessMode: 'byok',
      canUnlockPremiumModels: true,
    });
    await expect(loadState({ provider: 'openrouter' })).resolves.toMatchObject({
      billingAccessMode: 'byok',
      canUnlockPremiumModels: false,
    });
    await expect(loadState({ provider: 'custom' })).resolves.toMatchObject({
      billingAccessMode: 'byok',
      canUnlockPremiumModels: false,
    });
    await expect(loadState({ billingStatus: 'active' })).resolves.toMatchObject({
      billingAccessMode: 'subscription',
      canUnlockPremiumModels: false,
    });
    await expect(
      loadState({ purchasedCredits: 100 }),
    ).resolves.toMatchObject({
      billingAccessMode: 'credits',
      canUnlockPremiumModels: false,
    });
    await expect(
      loadState({ billingStatus: 'enterprise' }),
    ).resolves.toMatchObject({
      billingAccessMode: 'enterprise',
      canUnlockPremiumModels: false,
    });
  });

  it('rethrows picker config errors other than missing RPC rollout errors', async () => {
    const storageError = new Error('storage temporarily unavailable');
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockRejectedValue(storageError),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(getWorkspaceModelPickerState({}, 'ws_123')).rejects.toThrow(
      storageError,
    );
  });

  it('treats a null requested model as the picker default when creating a thread', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'sonnet', added_at: 1 }],
        default_model: 'sonnet',
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'fable-5',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      createThread({}, 'ws_123', 'New Chat', 'user_123', undefined, null),
    ).resolves.toMatchObject({ id: 'thread_123', model: 'fable-5' });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'sonnet',
    );
  });

  it('ignores retained picker defaults while platform defaults are active', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [
          { id: 'gpt-5.4', added_at: 1 },
        ],
        default_model: 'gpt-5.4',
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');

    expect(state).toMatchObject({
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      defaultModel: 'sonnet',
    });
  });

  it('generates a chat group avatar after app-side title generation', async () => {
    vi.mocked(generateThreadTitleWithOpenAI).mockResolvedValue(
      'Database Migrations',
    );
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
    };
    const orgStub = {
      updateThread: vi.fn().mockResolvedValue({ updated_at: 123 }),
    };
    const userStub = {
      renameEmptySingleThreadGroupForThread: vi.fn().mockResolvedValue(undefined),
    };
    const threadStub = {
      setTitle: vi.fn().mockResolvedValue(undefined),
      generateChatGroupAvatarForThread: vi.fn().mockResolvedValue(undefined),
    };

    getEnvMock.mockReturnValue({
      AI: { run: vi.fn() },
      CF_GATEWAY_NAME: 'gateway_1',
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
      USER: {
        idFromName: (id: string) => id,
        get: () => userStub,
      },
      CHAT_THREAD: {
        idFromName: (id: string) => id,
        get: () => threadStub,
      },
    });

    await generateThreadTitle(
      {},
      'thread_123',
      'ws_123',
      'help me plan database migrations',
      'user_123',
    );

    expect(orgStub.updateThread).toHaveBeenCalledWith(
      'thread_123',
      'Database Migrations',
    );
    expect(userStub.renameEmptySingleThreadGroupForThread).toHaveBeenCalledWith(
      'thread_123',
      'Database Migrations',
    );
    expect(threadStub.setTitle).toHaveBeenCalledWith(
      'Database Migrations',
      123,
    );
    expect(threadStub.generateChatGroupAvatarForThread).toHaveBeenCalledWith({
      threadId: 'thread_123',
      workspaceId: 'ws_123',
      orgId: 'org_123',
      userId: 'user_123',
    });
  });

  it('applies model picker validation on the validated-access create fast path', async () => {
    const workspaceStub = {
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'sonnet', added_at: 1 }],
        default_model: 'sonnet',
      }),
      createThread: vi.fn(),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      createThreadWithValidatedAccess(
        {},
        'org_123',
        'ws_123',
        'New Chat',
        'user_123',
        'hello',
        'gpt-5.4-mini',
      ),
    ).rejects.toThrow('Invalid thread model');
    expect(orgStub.createThread).not.toHaveBeenCalled();
  });

  it('allows Fable 5 in platform-default new threads', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
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
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'fable-5',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');
    const modelIds = state?.modelOptions.map((option) => option.id) ?? [];
    expect(modelIds).toContain('fable-5');
    expect(state?.allowedThreadModels).toContain('fable-5');
    expect(state?.allowedThreadModels[0]).toBe('deepseek-v4-auto');
    expect(state?.allowedThreadModels).toContain('opus-4.8');
    expect(modelIds.indexOf('opus-4.8')).toBeLessThan(
      modelIds.indexOf('fable-5'),
    );
    expect(modelIds.indexOf('fable-5')).toBeLessThan(
      modelIds.indexOf('sonnet'),
    );

    await expect(
      createThread({}, 'ws_123', 'New Chat', 'user_123', undefined, 'fable-5'),
    ).resolves.toMatchObject({ id: 'thread_123', model: 'fable-5' });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'fable-5',
    );
  });

  it('allows Fable 5 when a custom list includes it', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'fable-5', added_at: 1 }],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'New Chat',
        created_by: 'user_123',
        model: 'fable-5',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123');
    expect(state?.allowedThreadModels).toEqual(['fable-5']);

    await expect(
      createThread({}, 'ws_123', 'New Chat', 'user_123', undefined, 'fable-5'),
    ).resolves.toMatchObject({ id: 'thread_123', model: 'fable-5' });
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'ws_123',
      'New Chat',
      'user_123',
      undefined,
      'fable-5',
    );
  });

  it('allows switching an existing thread to Fable 5', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [
          { id: 'sonnet', added_at: 2 },
          { id: 'fable-5', added_at: 1 },
        ],
        default_model: null,
      }),
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
      updateThreadModel: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'fable-5',
        created_at: 1,
        updated_at: 3,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      updateThreadModel({}, 'thread_123', 'fable-5' as never, 'ws_123'),
    ).resolves.toMatchObject({ id: 'thread_123', model: 'fable-5' });
    expect(orgStub.updateThreadModel).toHaveBeenCalledWith('thread_123', 'fable-5');
  });

  it('normalizes legacy stored thread models before returning them to React', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Legacy Gemini thread',
        created_by: 'user_123',
        model: 'gemini-3.1-pro-preview',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const thread = await getThread({}, 'thread_123', 'ws_123');

    expect(thread?.model).toBe('gemini-3.5-flash');
  });

  it('replaces retained camelCode before returning self-host threads to React', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Migrated self-host thread',
        created_by: 'user_123',
        model: CAMEL_CODE_LLM_MODEL,
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      CF_ACCOUNT_ID: 'selfhost',
      SELFHOST_AI_PROVIDER: 'bedrock',
      SELFHOST_AI_API_KEY: 'bedrock-api-key-test',
      SELFHOST_AI_AWS_REGION: 'us-east-1',
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const thread = await getThread({}, 'thread_123', 'ws_123');

    expect(thread?.model).toBe('sonnet');
  });

  it('keeps full prompts for single thread reads but bounds recent-thread previews', async () => {
    const longFirstMessage = `first ${'x'.repeat(700)}`;
    const longLastMessage = `last ${'y'.repeat(700)}`;
    const orgThread = {
      id: 'thread_123',
      workspace_id: 'ws_123',
      title: 'Long prompt thread',
      created_by: 'user_123',
      model: 'sonnet',
      created_at: 1,
      updated_at: 2,
      user_message_count: 1,
      first_user_message: longFirstMessage,
      last_user_message: longLastMessage,
      last_user_message_at: 2,
    };
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org_123' }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue(orgThread),
      getThreadsPaginated: vi.fn().mockResolvedValue({
        items: [orgThread],
        total: 1,
        offset: 0,
        limit: 6,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const fullThread = await getThread({}, 'thread_123', 'ws_123');
    const [recentThread] = await getRecentThreads({}, 'ws_123', 6);

    expect(fullThread?.first_user_message).toBe(longFirstMessage);
    expect(fullThread?.last_user_message).toBe(longLastMessage);
    expect(recentThread?.first_user_message).toBe(longFirstMessage.slice(0, 500));
    expect(recentThread?.last_user_message).toBe(longLastMessage.slice(0, 500));
  });

  it('uses preloaded org model context without rereading workspace info or org provider settings', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected org billing state read');
      }),
      getLlmProviderConfig: vi.fn(async () => {
        throw new Error('unexpected provider config read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const state = await getWorkspaceModelPickerState({}, 'ws_123', {
      orgId: 'org_123',
      orgBillingState: {
        billing_status: 'active',
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
      },
      llmProviderConfig: {
        provider: 'openai',
        credentials_encrypted: 'encrypted',
        config: '{}',
        created_by: 'user_123',
        created_at: 1,
        updated_at: 1,
      },
    });

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
    expect(state?.orgId).toBe('org_123');
    expect(state?.llmProvider).toBe('openai');
    expect(state?.allowedThreadModels).toContain('gpt-5.6-terra');
  });

  it('uses preloaded org model context for thread model updates', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
      getLlmProviderConfig: vi.fn(async () => {
        throw new Error('unexpected provider config read');
      }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: false,
        models: [{ id: 'gpt-5.6-terra', added_at: 1 }],
        default_model: 'gpt-5.6-terra',
      }),
      updateThreadModel: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Existing Chat',
        created_by: 'user_123',
        model: 'gpt-5.6-terra',
        created_at: 1,
        updated_at: 3,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const updated = await updateThreadModel(
      {},
      'thread_123',
      'gpt-5.6-terra',
      'ws_123',
      {
        orgId: 'org_123',
        llmProviderConfig: {
          provider: 'openai',
          credentials_encrypted: 'encrypted',
          config: '{}',
          created_by: 'user_123',
          created_at: 1,
          updated_at: 1,
        },
      },
    );

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getLlmProviderConfig).not.toHaveBeenCalled();
    expect(orgStub.updateThreadModel).toHaveBeenCalledWith(
      'thread_123',
      'gpt-5.6-terra',
    );
    expect(updated?.model).toBe('gpt-5.6-terra');
  });

  it('uses a known org id for thread reads without loading workspace info', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_123',
        title: 'Thread',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    const thread = await getThread({}, 'thread_123', 'ws_123', {
      orgId: 'org_123',
    });

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.getThread).toHaveBeenCalledWith('thread_123');
    expect(thread?.id).toBe('thread_123');
  });

  it('still rejects known-org thread reads for the wrong workspace', async () => {
    const workspaceStub = {
      getInfo: vi.fn(async () => {
        throw new Error('unexpected workspace info read');
      }),
    };
    const orgStub = {
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        workspace_id: 'ws_other',
        title: 'Thread',
        created_by: 'user_123',
        model: 'sonnet',
        created_at: 1,
        updated_at: 2,
        user_message_count: 0,
        first_user_message: null,
      }),
      updateThread: vi.fn(),
      deleteThread: vi.fn(),
    };

    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => workspaceStub,
      },
      ORG: {
        idFromName: (id: string) => id,
        get: () => orgStub,
      },
    });

    await expect(
      getThread({}, 'thread_123', 'ws_123', { orgId: 'org_123' }),
    ).resolves.toBeNull();
    await expect(
      updateThread({}, 'thread_123', 'Title', 'ws_123', { orgId: 'org_123' }),
    ).resolves.toBeNull();
    await expect(
      deleteThread({}, 'thread_123', 'ws_123', { orgId: 'org_123' }),
    ).resolves.toBe(false);

    expect(workspaceStub.getInfo).not.toHaveBeenCalled();
    expect(orgStub.updateThread).not.toHaveBeenCalled();
    expect(orgStub.deleteThread).not.toHaveBeenCalled();
  });
});
