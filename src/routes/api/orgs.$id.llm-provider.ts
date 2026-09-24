import type { Route } from './+types/orgs.$id.llm-provider';
import { requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { encryptCredentials, decryptCredentials } from '@/lib/integration-crypto';
import {
  buildPublicLlmProviderConfig,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
  keyHint,
} from '@/lib/llm-provider-config';
import {
  getSelfhostAiProviderPublicConfig,
  getSelfhostAiProviderStatus,
} from '@/lib/selfhost-ai-provider';
import { waitUntil } from '@/lib/wait-until';
import {
  pollOpenAiDeviceAuthorization,
  startOpenAiDeviceAuthorization,
} from '@/lib/openai-subscription.server';
import type { LlmProvider, LlmProviderConfigPublic } from '@/types';

const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'bedrock', 'custom', 'openai', 'openrouter', 'requesty'];
export const ANTHROPIC_API_KEY_VALIDATION_MODEL = 'claude-sonnet-5';
const VALID_CUSTOM_AUTH_TYPES = ['bearer', 'x-api-key'] as const;
const VALID_CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
const VALID_AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'us-gov-west-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1',
];

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const orgId = params.id;
  await requireOrgAdmin(request, context, orgId);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const selfhostAiProvider = getSelfhostAiProviderStatus(env);
  const selfhostConfig = getSelfhostAiProviderPublicConfig(env);
  if (selfhostAiProvider.configured) {
    return Response.json({
      config: selfhostConfig ?? null,
      managed_by: 'selfhost-env',
      error: selfhostAiProvider.valid ? undefined : selfhostAiProvider.message,
    });
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const record = await orgStub.getLlmProviderConfig();

  if (!record) {
    return Response.json({ config: null });
  }

  const publicConfig: LlmProviderConfigPublic = await buildPublicLlmProviderConfig(
    record,
    env.INTEGRATION_SECRET_KEY
  );

  return Response.json({ config: publicConfig });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const orgId = params.id;
  const authContext = await requireOrgAdmin(request, context, orgId);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const selfhostAiProvider = getSelfhostAiProviderStatus(env);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const intent = body.intent as string;
  if (selfhostAiProvider.configured) {
    return Response.json(
      {
        error:
          selfhostAiProvider.message ??
          'AI Provider is managed by self-host environment variables.',
      },
      { status: 409 },
    );
  }

  if (intent === 'startOpenAiSubscription') {
    try {
      const device = await startOpenAiDeviceAuthorization();
      const pending_token = await encryptCredentials(
        {
          kind: 'openai-device-auth',
          org_id: orgId,
          device_auth_id: device.deviceAuthId,
          user_code: device.userCode,
          expires_at: device.expiresAt,
        },
        env.INTEGRATION_SECRET_KEY,
      );
      return Response.json({
        success: true,
        status: 'pending',
        pending_token,
        user_code: device.userCode,
        verification_url: device.verificationUrl,
        interval_seconds: device.intervalSeconds,
        expires_at: device.expiresAt,
      });
    } catch (error) {
      console.error('[llm-provider] Failed to start OpenAI subscription sign-in:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Could not start OpenAI sign-in.' },
        { status: 502 },
      );
    }
  }

  if (intent === 'pollOpenAiSubscription') {
    const pendingToken = typeof body.pending_token === 'string' ? body.pending_token : '';
    if (!pendingToken) {
      return Response.json({ error: 'Missing OpenAI sign-in state.' }, { status: 400 });
    }
    try {
      const pending = await decryptCredentials<Record<string, unknown>>(
        pendingToken,
        env.INTEGRATION_SECRET_KEY,
      );
      if (
        pending.kind !== 'openai-device-auth' ||
        pending.org_id !== orgId ||
        typeof pending.device_auth_id !== 'string' ||
        typeof pending.user_code !== 'string' ||
        typeof pending.expires_at !== 'number'
      ) {
        return Response.json({ error: 'Invalid OpenAI sign-in state.' }, { status: 400 });
      }
      if (pending.expires_at <= Date.now()) {
        return Response.json({ error: 'OpenAI sign-in code expired. Start again.' }, { status: 410 });
      }
      const result = await pollOpenAiDeviceAuthorization(
        pending.device_auth_id,
        pending.user_code,
      );
      if (result.status === 'pending') {
        return Response.json({ success: true, status: 'pending' });
      }

      const encrypted = await encryptCredentials(
        { ...result.credentials },
        env.INTEGRATION_SECRET_KEY,
      );
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      await orgStub.setOpenAiSubscription(
        encrypted,
        result.identity.email,
        result.identity.planType,
      );
      waitUntil(
        orgStub.notifyByokChanged().catch((error: unknown) => {
          console.error('[llm-provider] Failed to notify threads after OpenAI subscription connect:', error);
        }),
      );
      return Response.json({
        success: true,
        status: 'complete',
        account_email: result.identity.email,
        plan_type: result.identity.planType,
      });
    } catch (error) {
      console.error('[llm-provider] Failed to finish OpenAI subscription sign-in:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Could not finish OpenAI sign-in.' },
        { status: 502 },
      );
    }
  }

  if (intent === 'deleteOpenAiSubscription') {
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await orgStub.deleteOpenAiSubscription();
    waitUntil(
      orgStub.notifyByokChanged().catch((error: unknown) => {
        console.error('[llm-provider] Failed to notify threads after OpenAI subscription disconnect:', error);
      }),
    );
    return Response.json({ success: true });
  }

  if (intent === 'setProvider') {
    const provider = body.provider as string;
    if (!VALID_PROVIDERS.includes(provider as LlmProvider)) {
      return Response.json(
        { error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const existing = await orgStub.getLlmProviderConfig();
    const notifyByokChanged = () => {
      waitUntil(
        orgStub.notifyByokChanged().catch((error: unknown) => {
          console.error('[llm-provider] Failed to notify BYOK change:', error);
        })
      );
    };

    if (provider === 'anthropic') {
      const apiKey = (body.api_key as string)?.trim();
      const config = stringifyStoredLlmProviderConfig({});

      if (apiKey && !apiKey.startsWith('sk-ant-')) {
        return Response.json(
          { error: 'Invalid Anthropic API key format. Keys should start with sk-ant-' },
          { status: 400 }
        );
      }

      if (apiKey) {
        const encrypted = await encryptCredentials({ api_key: apiKey }, env.INTEGRATION_SECRET_KEY);
        await orgStub.setLlmProviderConfig(provider, encrypted, config, authContext.user.id);
        notifyByokChanged();
        return Response.json({ success: true, key_hint: keyHint(apiKey) });
      }

      if (!existing || existing.provider !== 'anthropic') {
        return Response.json({ error: 'API key is required' }, { status: 400 });
      }

      await orgStub.setLlmProviderConfig(
        provider,
        existing.credentials_encrypted,
        config,
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true });
    }

    if (provider === 'bedrock') {
      const bearerToken = (body.bearer_token as string)?.trim();
      const awsRegion = (body.aws_region as string)?.trim();

      if (!awsRegion || !VALID_AWS_REGIONS.includes(awsRegion)) {
        return Response.json(
          { error: `Invalid AWS region. Must be one of: ${VALID_AWS_REGIONS.join(', ')}` },
          { status: 400 }
        );
      }

      const config = stringifyStoredLlmProviderConfig({ aws_region: awsRegion });

      if (bearerToken) {
        // New key provided — encrypt and save
        const encrypted = await encryptCredentials(
          { bearer_token: bearerToken },
          env.INTEGRATION_SECRET_KEY
        );
        await orgStub.setLlmProviderConfig(provider, encrypted, config, authContext.user.id);
        notifyByokChanged();
        return Response.json({ success: true, key_hint: keyHint(bearerToken) });
      }

      // No new key — update region only if already configured as Bedrock
      if (!existing || existing.provider !== 'bedrock') {
        return Response.json({ error: 'Bedrock API key is required' }, { status: 400 });
      }
      // Re-use existing encrypted credentials, update config (region)
      await orgStub.setLlmProviderConfig(
        provider,
        existing.credentials_encrypted,
        config,
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true });
    }

    if (provider === 'custom') {
      const apiKey = (body.api_key as string)?.trim();
      const customName = (body.custom_name as string)?.trim();
      let customBaseUrl = (body.custom_base_url as string)?.trim().replace(/\/+$/, '');
      const customModelId = (body.custom_model_id as string)?.trim();
      const customAuthType = (body.custom_auth_type as string)?.trim();
      const customApi = (body.custom_api as string)?.trim();

      if (!apiKey) {
        return Response.json({ error: 'API key is required' }, { status: 400 });
      }
      if (!customName) {
        return Response.json({ error: 'Provider name is required' }, { status: 400 });
      }
      if (!customBaseUrl) {
        return Response.json({ error: 'Base URL is required' }, { status: 400 });
      }
      if (!customModelId) {
        return Response.json({ error: 'Model ID is required' }, { status: 400 });
      }
      if (customModelId.length > 200) {
        return Response.json({ error: 'Model ID must be 200 characters or fewer' }, { status: 400 });
      }
      let parsedBaseUrl: URL;
      try {
        parsedBaseUrl = new URL(customBaseUrl);
      } catch {
        return Response.json({ error: 'Base URL must be a valid URL' }, { status: 400 });
      }
      if (parsedBaseUrl.protocol !== 'https:') {
        return Response.json({ error: 'Base URL must use https' }, { status: 400 });
      }
      if (!VALID_CUSTOM_AUTH_TYPES.includes(customAuthType as (typeof VALID_CUSTOM_AUTH_TYPES)[number])) {
        return Response.json({ error: 'Auth header must be bearer or x-api-key' }, { status: 400 });
      }
      if (!VALID_CUSTOM_APIS.includes(customApi as (typeof VALID_CUSTOM_APIS)[number])) {
        return Response.json(
          { error: 'API mode must be chat completions, responses, or anthropic messages' },
          { status: 400 }
        );
      }
      if (customApi === 'anthropic-messages') {
        customBaseUrl = customBaseUrl.replace(/\/v1$/i, '');
      }

      const encrypted = await encryptCredentials({ api_key: apiKey }, env.INTEGRATION_SECRET_KEY);
      await orgStub.setLlmProviderConfig(
        provider,
        encrypted,
        stringifyStoredLlmProviderConfig({
          custom_name: customName,
          custom_base_url: customBaseUrl,
          custom_model_id: customModelId,
          custom_auth_type: customAuthType as 'bearer' | 'x-api-key',
          custom_api: customApi as 'openai-completions' | 'openai-responses' | 'anthropic-messages',
        }),
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true, key_hint: keyHint(apiKey) });
    }

    if (provider === 'openai' || provider === 'openrouter' || provider === 'requesty') {
      const apiKey = (body.api_key as string)?.trim();
      if (!apiKey) {
        return Response.json({ error: 'API key is required' }, { status: 400 });
      }
      if (provider === 'openai' && !apiKey.startsWith('sk-')) {
        return Response.json(
          { error: 'Invalid OpenAI API key format. Keys should start with sk-' },
          { status: 400 }
        );
      }
      if (provider === 'openrouter' && !apiKey.startsWith('sk-or-')) {
        return Response.json(
          { error: 'Invalid OpenRouter API key format. Keys should start with sk-or-' },
          { status: 400 }
        );
      }

      const encrypted = await encryptCredentials({ api_key: apiKey }, env.INTEGRATION_SECRET_KEY);
      await orgStub.setLlmProviderConfig(
        provider,
        encrypted,
        stringifyStoredLlmProviderConfig({}),
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true, key_hint: keyHint(apiKey) });
    }

    return Response.json({ error: 'Unsupported provider' }, { status: 400 });
  }

  if (intent === 'deleteProvider') {
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const existing = await orgStub.getLlmProviderConfig();
    await orgStub.deleteLlmProviderConfig();
    if (!existing?.provider) {
      return Response.json({ success: true });
    }
    waitUntil(
      orgStub.notifyByokChanged().catch((error: unknown) => {
        console.error('[llm-provider] Failed to notify BYOK change:', error);
      })
    );
    return Response.json({ success: true });
  }

  if (intent === 'testProvider') {
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const record = await orgStub.getLlmProviderConfig();
    if (!record) {
      return Response.json({ error: 'No provider configured' }, { status: 404 });
    }

    try {
      const creds = await decryptCredentials<Record<string, string>>(
        record.credentials_encrypted,
        env.INTEGRATION_SECRET_KEY
      );
      const config = parseStoredLlmProviderConfig(record.config);

      if (record.provider === 'anthropic') {
        // Test with a lightweight count_tokens call
        const resp = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': creds.api_key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: ANTHROPIC_API_KEY_VALIDATION_MODEL,
            messages: [{ role: 'user', content: 'test' }],
          }),
        });

        if (resp.ok) {
          return Response.json({ success: true, message: 'Anthropic API key is valid' });
        }

        const errorBody = await resp.text();
        if (resp.status === 401) {
          return Response.json(
            { success: false, message: 'Invalid API key. Please check and try again.' },
            { status: 200 }
          );
        }
        return Response.json(
          { success: false, message: `API returned ${resp.status}: ${errorBody.slice(0, 200)}` },
          { status: 200 }
        );
      }

      if (record.provider === 'bedrock') {
        // Test Bedrock API key by listing foundation models
        const region = config.aws_region || 'us-east-1';
        const resp = await fetch(
          `https://bedrock.${region}.amazonaws.com/foundation-models?byProvider=anthropic`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${creds.bearer_token}`,
            },
          }
        );

        if (resp.ok) {
          return Response.json({ success: true, message: 'Bedrock API key is valid' });
        }

        if (resp.status === 401 || resp.status === 403) {
          return Response.json(
            { success: false, message: 'Invalid Bedrock API key or insufficient permissions.' },
            { status: 200 }
          );
        }
        return Response.json(
          { success: false, message: `Bedrock API returned ${resp.status}` },
          { status: 200 }
        );
      }

      if (record.provider === 'openai' || record.provider === 'openrouter') {
        const resp = await fetch(
          record.provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1/models'
            : 'https://api.openai.com/v1/models?limit=1',
          {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${creds.api_key}`,
          },
          },
        );

        if (resp.ok) {
          return Response.json({
            success: true,
            message:
              record.provider === 'openrouter'
                ? 'OpenRouter API key is valid'
                : 'OpenAI API key is valid',
          });
        }

        const errorBody = await resp.text();
        if (resp.status === 401 || resp.status === 403) {
          return Response.json(
            {
              success: false,
              message:
                record.provider === 'openrouter'
                  ? 'Invalid OpenRouter API key. Please check and try again.'
                  : 'Invalid OpenAI API key. Please check and try again.',
            },
            { status: 200 }
          );
        }
        return Response.json(
          {
            success: false,
            message: `${record.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API returned ${resp.status}: ${errorBody.slice(0, 200)}`,
          },
          { status: 200 }
        );
      }

      if (record.provider === 'requesty') {
        const resp = await fetch('https://router.requesty.ai/v1/models', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${creds.api_key}`,
          },
        });

        if (resp.ok) {
          return Response.json({ success: true, message: 'Requesty API key is valid' });
        }

        const errorBody = await resp.text();
        if (resp.status === 401 || resp.status === 403) {
          return Response.json(
            {
              success: false,
              message: 'Invalid Requesty API key. Please check and try again.',
            },
            { status: 200 }
          );
        }
        return Response.json(
          {
            success: false,
            message: `Requesty API returned ${resp.status}: ${errorBody.slice(0, 200)}`,
          },
          { status: 200 }
        );
      }

      if (record.provider === 'custom') {
        const authType = config.custom_auth_type ?? 'bearer';
        const baseUrl = config.custom_base_url;
        if (!baseUrl || !creds.api_key) {
          return Response.json(
            { success: false, message: 'Custom provider is missing its base URL or API key.' },
            { status: 200 }
          );
        }
        const headers: Record<string, string> = authType === 'x-api-key'
          ? { 'x-api-key': creds.api_key }
          : { Authorization: `Bearer ${creds.api_key}` };
        const testUrl =
          config.custom_api === 'anthropic-messages'
            ? `${baseUrl}/v1/messages/count_tokens`
            : `${baseUrl}/models`;
        const resp = await fetch(testUrl, {
          method: config.custom_api === 'anthropic-messages' ? 'POST' : 'GET',
          headers: {
            ...headers,
            ...(config.custom_api === 'anthropic-messages'
              ? {
                  'Content-Type': 'application/json',
                  'anthropic-version': '2023-06-01',
                }
              : {}),
          },
          ...(config.custom_api === 'anthropic-messages'
            ? {
                body: JSON.stringify({
                  model: config.custom_model_id || 'claude-sonnet-5',
                  messages: [{ role: 'user', content: 'test' }],
                }),
              }
            : {}),
        });

        if (resp.ok) {
          return Response.json({
            success: true,
            message: `${config.custom_name || 'Custom provider'} API key is valid`,
          });
        }

        const errorBody = await resp.text();
        if (resp.status === 401 || resp.status === 403) {
          return Response.json(
            { success: false, message: 'Invalid custom provider API key. Please check and try again.' },
            { status: 200 }
          );
        }
        return Response.json(
          {
            success: false,
            message: `Custom provider API returned ${resp.status}: ${errorBody.slice(0, 200)}`,
          },
          { status: 200 }
        );
      }

      return Response.json({ error: 'Unknown provider' }, { status: 400 });
    } catch (err) {
      return Response.json(
        { success: false, message: `Test failed: ${(err as Error).message}` },
        { status: 200 }
      );
    }
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}
