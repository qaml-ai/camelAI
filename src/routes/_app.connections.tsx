import { normalizeIntegrationTokens } from '@/lib/integration-token';
import { Suspense } from 'react';
import { Await, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.connections';
import { requireAuthContext, getAuthEnv, requireWorkspaceAccess } from '@/lib/auth.server';
import {
  createWorkspaceIntegrationRecord,
  createWorkspaceIntegrationDefinitionRecord,
  deleteWorkspaceIntegrationRecord,
  getWorkspaceIntegrationRecord,
  getWorkspaceIntegrationDefinitionRecord,
  isOrgAdmin,
  listWorkspaceIntegrationRecords,
  updateWorkspaceIntegrationRecord,
  workspaceIntegrationNameExists,
} from '@/lib/auth-do';
import { discoverIntegrationSurfaces } from '@/lib/openapi-integration.server';
import {
  integrationDefinitionRequiresEndpointConfirmation,
  parseWorkspaceIntegrationDefinition,
  resolveIntegrationDefinitionVariables,
  type IntegrationAuthKind,
} from '@/lib/integration-definition';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import {
  getAllIntegrations,
  getIntegrationDefinition,
  isCredentialFieldRequired,
  shouldShowConfigField,
  shouldShowCredentialField,
  shouldStoreIntegrationCredentials,
} from '@/lib/integration-registry';
import { decryptCredentials, encryptCredentials } from '@/lib/integration-crypto';
import {
  normalizeRemoteMcpUrl,
  validateRemoteMcpConnection,
  validateRemoteMcpUrl,
} from '@/lib/remote-mcp';
import {
  buildTelegramDeepLink,
  generateTelegramSetupToken,
  getTelegramRegistryName,
  normalizeTelegramBotUsername,
  TELEGRAM_SETUP_TTL_SECONDS,
  type TelegramSetupRecord,
} from '@/lib/telegram-channel';
import type { WorkspaceIntegrationRecord } from '../../workers/main/src/workspace';
import ConnectionsClient from '@/components/pages/connections/connections-client';
import { ConnectionsLoadingSkeleton } from '@/components/pages/connections/connections-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import { shouldRevalidateConnectionsRoute } from '@/lib/connections-route-revalidation';
import {
  buildWorkspaceEmailAddress,
  getWorkspaceEmailDomain,
} from '@/lib/workspace-email';
import { getBillingPlanLimits } from '@/lib/billing-plans';
import type { Integration, User } from '@/types';
import type { ConnectionListItem } from '@/lib/connections-shared';
import { getConnectionContract } from '@/lib/connection-contract';
import { projectsToMentionables, type MentionableProject } from '@/lib/mentions';
import {
  loadUserProfileSummaries,
  type UserProfileSummary,
} from '@/lib/user-profiles.server';
import {
  DiscordBridgeRequestError,
  discordBridgeClient,
  discordChannelEnabled,
  getDiscordChannelAvailability,
  parseDiscordChannelConfig,
  type DiscordBridgeBindingRecord,
  type DiscordChannelConfigV1,
  type DiscordPendingSetupContext,
} from '../../workers/main/src/discord-types';
import { completeConnectionSetupPromptContext } from '../../workers/main/src/connection-setup-completion';

const CONNECTION_MANAGEMENT_INTENTS = new Set([
  'createIntegration',
  'updateIntegration',
  'deleteIntegration',
  'duplicateIntegration',
  'discoverIntegration',
  'createDiscoveredIntegration',
  'discordListChannels',
  'discordActivateChannel',
  'discordDisconnect',
]);

interface DiscordActivationTarget {
  activationAttemptId: string | undefined;
  applicationId: string;
  guildId: string;
  guildName: string;
  botUserId: string | undefined;
  messageContentMode: DiscordChannelConfigV1['message_content_mode'];
}

function getDiscordActivationTarget(
  config: DiscordChannelConfigV1,
): DiscordActivationTarget {
  const pending = config.pending_reauthorization;
  return {
    activationAttemptId:
      pending?.activation_attempt_id ?? config.activation_attempt_id,
    applicationId: pending?.application_id ?? config.application_id,
    guildId: pending?.guild_id ?? config.guild_id,
    guildName: pending?.guild_name ?? config.guild_name,
    botUserId: pending?.bot_user_id ?? config.bot_user_id,
    messageContentMode:
      pending?.message_content_mode ?? config.message_content_mode,
  };
}

function discordBindingActivationId(input: {
  integrationId: string;
  activationAttemptId: string;
  guildId: string;
  parentChannelId: string;
}): string {
  return [
    'discord-binding-activation',
    input.integrationId,
    input.activationAttemptId,
    input.guildId,
    input.parentChannelId,
  ].join(':');
}

function getDiscordPendingSetup(
  config: DiscordChannelConfigV1,
): DiscordPendingSetupContext | null {
  const pending = config.pending_setup;
  return pending &&
    typeof pending.request_id === 'string' &&
    typeof pending.thread_id === 'string' &&
    typeof pending.return_path === 'string' &&
    pending.return_path.startsWith('/') &&
    !pending.return_path.startsWith('//')
    ? pending
    : null;
}

export function shouldRevalidate(
  args: Parameters<typeof shouldRevalidateConnectionsRoute>[0],
) {
  return shouldRevalidateConnectionsRoute(args);
}

async function loadWorkspaceMentionProjects(
  env: unknown,
  workspaceId: string,
): Promise<MentionableProject[]> {
  const { WorkspaceFilesystemClient } = await import(
    "../../workers/main/src/workspace-filesystem-do"
  );
  const projects = await new WorkspaceFilesystemClient(
    env as never,
    workspaceId,
  ).listProjects();
  return projectsToMentionables(projects);
}

function parseIntegrationConfig(rawConfig: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function validateRequiredIntegrationFields(
  definition: NonNullable<ReturnType<typeof getIntegrationDefinition>>,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  for (const field of definition.configSchema) {
    if (!shouldShowConfigField(definition.type, field.name, config)) continue;
    const value = config[field.name];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  for (const field of definition.credentialSchema) {
    if (!shouldShowCredentialField(definition.type, field.name, config)) continue;
    const value = credentials[field.name];
    const required = isCredentialFieldRequired(definition.type, field.name, config, field.required);
    if (required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  return errors;
}

async function getOptionalCreatorProfiles(
  authEnv: ReturnType<typeof getAuthEnv>,
  userIds: Iterable<string | null | undefined>,
  request: Request,
  preloadedUsers: Iterable<User | null | undefined>,
  label: string,
): Promise<Map<string, UserProfileSummary>> {
  try {
    return await loadUserProfileSummaries(authEnv, userIds, {
      request,
      preloadedUsers,
    });
  } catch (error) {
    console.error(`Failed to load ${label} creator profiles:`, error);
    return new Map();
  }
}

async function channelMetadata(
  record: WorkspaceIntegrationRecord,
  config: Record<string, unknown>,
  env: CloudflareEnv,
): Promise<ConnectionListItem['channelMetadata']> {
  if (record.integration_type === 'discord_channel') {
    const fallback = {
      guild_id: typeof config.guild_id === 'string' ? config.guild_id : null,
      guild_name: typeof config.guild_name === 'string' ? config.guild_name : null,
      parent_channel_id: null,
      parent_channel_name: null,
      bot_user_id: typeof config.bot_user_id === 'string' ? config.bot_user_id : null,
      message_content_mode:
        typeof config.message_content_mode === 'string' ? config.message_content_mode : null,
      status: typeof config.status === 'string' ? config.status : null,
      error_code: typeof config.error_code === 'string' ? config.error_code : null,
    };
    try {
      const binding = await discordBridgeClient(env.DISCORD_BRIDGE).binding(record.id);
      if (!binding) throw new DiscordBridgeRequestError(
        'binding_not_found',
        'Discord binding not found',
        404,
      );
      return {
        ...fallback,
        guild_id: binding.guildId,
        guild_name: binding.guildName,
        parent_channel_id: binding.parentChannelId,
        parent_channel_name: binding.parentChannelName,
        status: 'active',
        error_code: null,
      };
    } catch (error) {
      if (error instanceof DiscordBridgeRequestError && error.code === 'binding_not_found') {
        return {
          ...fallback,
          status: fallback.status === 'pending_channel' ? 'pending_channel' : 'disconnected',
        };
      }
      return fallback;
    }
  }
  if (record.integration_type !== 'slack') return undefined;
  const fromConfig = {
    team_id: typeof config.team_id === 'string' ? config.team_id : null,
    team_name: typeof config.team_name === 'string' ? config.team_name : null,
    bot_user_id: typeof config.bot_user_id === 'string' ? config.bot_user_id : null,
  };
  if (fromConfig.team_id || fromConfig.team_name || fromConfig.bot_user_id) {
    return fromConfig;
  }
  if (!record.credentials_encrypted) return fromConfig;

  try {
    const credentials = await decryptCredentials<Record<string, unknown>>(
      record.credentials_encrypted,
      env.INTEGRATION_SECRET_KEY,
    );
    return {
      team_id: typeof credentials.team_id === 'string' ? credentials.team_id : null,
      team_name: typeof credentials.team_name === 'string' ? credentials.team_name : null,
      bot_user_id: typeof credentials.bot_user_id === 'string' ? credentials.bot_user_id : null,
    };
  } catch (error) {
    console.error('Failed to read Slack channel metadata:', error);
    return fromConfig;
  }
}

async function recordToIntegration(
  record: WorkspaceIntegrationRecord,
  creators: Map<string, UserProfileSummary>,
  env: CloudflareEnv,
  discordOperationalReady: boolean,
): Promise<ConnectionListItem> {
  const config = parseIntegrationConfig(record.config);
  const importedDefinition = parseWorkspaceIntegrationDefinition(record.definition);
  const creator = creators.get(record.created_by);
  const contract = getConnectionContract(record.integration_type, {
    config,
    definition: importedDefinition,
  });
  const discordUnavailable = record.integration_type === 'discord_channel' &&
    !discordOperationalReady;
  return {
    id: record.id,
    integration_type: record.integration_type,
    name: record.name,
    category: record.category as Integration['category'],
    auth_method: record.auth_method as Integration['auth_method'],
    config,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
    has_credentials: Boolean(record.credentials_encrypted),
    auth_status: record.auth_status,
    auth_error_code: record.auth_error_code,
    auth_error_message: record.auth_error_message,
    auth_checked_at: record.auth_checked_at,
    reauth_required_at: record.reauth_required_at,
    token_expires_at: record.token_expires_at,
    created_by_name: creator ? creator.name || creator.email : null,
    created_by_avatar: creator?.avatar ?? null,
    channelMetadata: await channelMetadata(record, config, env),
    definitionMetadata: importedDefinition
      ? {
          source: importedDefinition.source,
          operationCount: importedDefinition.operations.length,
          genericFetch: true,
        }
      : undefined,
    contract,
    verification: {
      status: discordUnavailable ? 'degraded' : record.verification_status ?? 'unknown',
      message: discordUnavailable
        ? 'Discord channels are unavailable in this environment.'
        : record.verification_message ?? null,
      checkedAt: record.verification_checked_at ?? null,
      live: record.verification_live === 1,
      strategy: record.verification_strategy ?? contract.verification.strategy,
    },
  };
}

function hasNonEmptyCredentialValue(credentials: Record<string, unknown>): boolean {
  return Object.values(credentials).some((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  });
}

export function meta() {
  return [
    { title: 'Connections - camelAI' },
    { name: 'description', content: 'Manage integrations and connections' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);

  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) {
    return { error: 'No workspace selected' };
  }
  await requireWorkspaceAccess(request, context, workspaceId, 'full');

  const authEnv = getAuthEnv(env);
  const discord = discordBridgeClient(env.DISCORD_BRIDGE);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (typeof intent === 'string' && CONNECTION_MANAGEMENT_INTENTS.has(intent)) {
    const canManageConnections = await isOrgAdmin(
      getAuthEnv(env),
      authContext.user.id,
      authContext.currentOrg.id,
    );
    if (!canManageConnections) {
      return { error: 'Only organization admins can manage connections' };
    }
  }

  if (intent === 'discordListChannels') {
    const integrationId = String(formData.get('integrationId') ?? '').trim();
    if (!integrationId) return { error: 'Integration ID is required' };
    if (!discordChannelEnabled(env)) {
      return { error: 'Discord channel is not configured in this environment' };
    }
    const record = await getWorkspaceIntegrationRecord(authEnv, workspaceId, integrationId);
    const config = record && record.integration_type === 'discord_channel'
      ? parseDiscordChannelConfig(record.config || '{}')
      : null;
    if (!record || !config) return { error: 'Discord integration not found' };
    const target = getDiscordActivationTarget(config);
    try {
      const result = await discord.guildChannels(target.guildId);
      return {
        success: true,
        discordSetup: {
          integrationId,
          guild: result.guild,
          channels: result.channels,
        },
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to list Discord channels',
      };
    }
  }

  if (intent === 'discordActivateChannel') {
    const integrationId = String(formData.get('integrationId') ?? '').trim();
    const parentChannelId = String(formData.get('parentChannelId') ?? '').trim();
    const acknowledged = formData.get('securityAcknowledged') === 'true';
    if (!integrationId || !parentChannelId) {
      return { error: 'Choose a Discord channel' };
    }
    if (!acknowledged) {
      return { error: 'Acknowledge the Discord channel security boundary before connecting' };
    }
    if (!discordChannelEnabled(env)) {
      return { error: 'Discord channel is not configured in this environment' };
    }
    const record = await getWorkspaceIntegrationRecord(authEnv, workspaceId, integrationId);
    const priorConfig = record && record.integration_type === 'discord_channel'
      ? parseDiscordChannelConfig(record.config || '{}')
      : null;
    if (!record || !priorConfig) return { error: 'Discord integration not found' };
    const activationTarget = getDiscordActivationTarget(priorConfig);
    let authoritativeBinding: DiscordBridgeBindingRecord | null = null;
    try {
      const live = await discord.binding(integrationId);
      if (
        live &&
        (live.integrationId !== integrationId ||
        live.orgId !== authContext.currentOrg.id ||
        live.workspaceId !== workspaceId)
      ) {
        return { error: 'Discord binding ownership does not match this workspace' };
      }
      authoritativeBinding = live;
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Failed to inspect Discord binding',
      };
    }
    const pendingSetup = getDiscordPendingSetup(priorConfig);
    const sameLiveBinding = authoritativeBinding?.guildId === activationTarget.guildId &&
      authoritativeBinding.parentChannelId === parentChannelId;
    if (
      sameLiveBinding &&
      !activationTarget.activationAttemptId &&
      !pendingSetup
    ) {
      return { success: true };
    }
    let activationConfig = priorConfig;
    let activationAttemptId = activationTarget.activationAttemptId;
    let binding = sameLiveBinding && !activationAttemptId
      ? authoritativeBinding
      : null;
    if (!binding) {
      if (!activationAttemptId) {
        activationAttemptId = crypto.randomUUID();
        activationConfig = {
          ...priorConfig,
          activation_attempt_id: activationAttemptId,
        };
        try {
          await updateWorkspaceIntegrationRecord(
            authEnv,
            workspaceId,
            integrationId,
            { config: JSON.stringify(activationConfig) },
            authContext.user.id,
          );
        } catch (error) {
          return {
            error: error instanceof Error
              ? `Failed to begin Discord channel activation: ${error.message}`
              : 'Failed to begin Discord channel activation',
          };
        }
      }
      try {
        const activated = await discord.activateBinding({
          guildId: activationTarget.guildId,
          parentChannelId,
          integrationId,
          orgId: authContext.currentOrg.id,
          workspaceId,
          idempotencyKey: discordBindingActivationId({
            integrationId,
            activationAttemptId,
            guildId: activationTarget.guildId,
            parentChannelId,
          }),
          ...(authoritativeBinding === null
            ? {}
            : { expectedVersion: authoritativeBinding.version }),
        });
        binding = activated.binding;
      } catch (error) {
        return {
          error: error instanceof Error
            ? `Discord could not confirm and activate the channel: ${error.message}`
            : 'Discord could not confirm and activate the channel',
        };
      }
    }

    const integrationName = `${binding.guildName} #${binding.parentChannelName}`;
    if (pendingSetup) {
      const completed = await completeConnectionSetupPromptContext(
        env,
        {
          requestId: pendingSetup.request_id,
          threadId: pendingSetup.thread_id,
        },
        integrationId,
        'discord_channel',
        integrationName,
      );
      if (!completed) {
        return {
          error: 'Discord is connected, but the original chat setup request could not be resumed. Retry Connect channel.',
        };
      }
    }

    const settledConfig = {
      ...activationConfig,
      status: 'active' as const,
      application_id: activationTarget.applicationId,
      guild_id: binding.guildId,
      guild_name: binding.guildName,
      parent_channel_id: binding.parentChannelId,
      parent_channel_name: binding.parentChannelName,
      bot_user_id: activationTarget.botUserId,
      binding_version: binding.version,
      activation_attempt_id: undefined,
      pending_reauthorization: undefined,
      pending_setup: undefined,
      message_content_mode: activationTarget.messageContentMode,
      security_acknowledged_at: Date.now(),
      last_verified_at: Date.now(),
      error_code: undefined,
    };
    try {
      await updateWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
        {
          name: integrationName,
          config: JSON.stringify(settledConfig),
        },
        authContext.user.id,
      );
    } catch (error) {
      return {
        error: error instanceof Error
          ? `Discord is connected, but its connection record could not be updated: ${error.message}`
          : 'Discord is connected, but its connection record could not be updated',
      };
    }
    return {
      success: true,
      ...(pendingSetup ? { returnTo: pendingSetup.return_path } : {}),
    };
  }

  if (intent === 'discordDisconnect') {
    const integrationId = String(formData.get('integrationId') ?? '').trim();
    if (!integrationId) return { error: 'Integration ID is required' };
    const record = await getWorkspaceIntegrationRecord(authEnv, workspaceId, integrationId);
    const config = record && record.integration_type === 'discord_channel'
      ? parseDiscordChannelConfig(record.config || '{}')
      : null;
    if (!record || !config) return { error: 'Discord integration not found' };
    if (env.DISCORD_BRIDGE) {
      try {
        await discord.releaseCurrentBinding(integrationId);
      } catch (error) {
        return {
          error: error instanceof Error
            ? `Failed to release Discord channel: ${error.message}`
            : 'Failed to release Discord channel',
        };
      }
    } else if (config.binding_version) {
      return { error: 'Discord bridge is unavailable; the channel was not disconnected' };
    }
    const activationTarget = getDiscordActivationTarget(config);
    const disconnectedConfig = {
      ...config,
      status: 'disconnected' as const,
      application_id: activationTarget.applicationId,
      guild_id: activationTarget.guildId,
      guild_name: activationTarget.guildName,
      bot_user_id: activationTarget.botUserId,
      message_content_mode: activationTarget.messageContentMode,
      parent_channel_id: undefined,
      parent_channel_name: undefined,
      binding_version: undefined,
      pending_reauthorization: undefined,
      activation_attempt_id: activationTarget.activationAttemptId,
      error_code: undefined,
      last_verified_at: Date.now(),
    };
    await updateWorkspaceIntegrationRecord(
      authEnv,
      workspaceId,
      integrationId,
      { config: JSON.stringify(disconnectedConfig) },
      authContext.user.id,
    );
    return { success: true };
  }

  if (intent === 'verifyIntegration') {
    const integrationId = String(formData.get('integrationId') ?? '').trim();
    if (!integrationId) return { error: 'Integration ID is required' };
    try {
      const { verifyConnection } = await import(
        '../../workers/main/src/connections-runtime'
      );
      const verification = await verifyConnection(
        env as never,
        {
          orgId: authContext.currentOrg.id,
          workspaceId,
          userId: authContext.user.id,
        },
        { id: integrationId },
      );
      return { success: true, verification };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to verify connection' };
    }
  }

  if (intent === 'createIntegration') {
    const integrationType = formData.get('integration_type') as string;
    const name = formData.get('name') as string;
    const configStr = formData.get('config') as string;
    const credentialsStr = formData.get('credentials') as string;

    if (!integrationType || !name) {
      return { error: 'Missing required fields' };
    }

    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return { error: `Unknown integration type: ${integrationType}` };
    }
    if (definition.deprecated?.hiddenFromCreate) {
      return { error: `${definition.displayName} can no longer be created` };
    }
    if (integrationType === 'discord_channel') {
      return { error: 'Use Add Camel to Discord to create this connection' };
    }

    try {
      const config = configStr ? JSON.parse(configStr) : {};
      const credentials = normalizeIntegrationTokens(integrationType, config, credentialsStr ? JSON.parse(credentialsStr) : {});
      const validationErrors = validateRequiredIntegrationFields(definition, config, credentials);
      if (validationErrors.length > 0) {
        return { error: validationErrors.join(', ') };
      }
      if (integrationType === 'remote_mcp') {
        const validationErrors = validateRemoteMcpConnection(config, credentials);
        if (validationErrors.length > 0) {
          return { error: validationErrors.join(', ') };
        }
        config.server_url = normalizeRemoteMcpUrl(String(config.server_url));
      }
      if (integrationType === 'telegram') {
        const botUsername = normalizeTelegramBotUsername(env.TELEGRAM_BOT_USERNAME);
        if (!botUsername || !env.TELEGRAM_BOT_TOKEN?.trim()) {
          return { error: 'Telegram bot is not configured' };
        }
        if (!env.TELEGRAM_REGISTRY) {
          return { error: 'Telegram registry is not configured' };
        }

        const setupToken = generateTelegramSetupToken();
        const integrationId = crypto.randomUUID();
        const setupExpiresAt = Date.now() + TELEGRAM_SETUP_TTL_SECONDS * 1000;
        const telegramConfig = {
          ...config,
          status: 'pending',
          setup_token: setupToken,
          setup_expires_at: setupExpiresAt,
          bot_username: botUsername,
        };
        const credentialsEncrypted = await encryptCredentials(
          { shared_bot: true },
          env.INTEGRATION_SECRET_KEY,
        );

        await createWorkspaceIntegrationRecord(
          authEnv,
          workspaceId,
          integrationId,
          integrationType,
          name,
          definition.category,
          definition.authMethod,
          JSON.stringify(telegramConfig),
          credentialsEncrypted,
          authContext.user.id
        );

        const setupRecord: TelegramSetupRecord = {
          workspaceId,
          orgId: authContext.currentOrg.id,
          integrationId,
          userId: authContext.user.id,
        };
        const registry = env.TELEGRAM_REGISTRY.get(
          env.TELEGRAM_REGISTRY.idFromName(getTelegramRegistryName(botUsername)),
        );
        await registry.putSetupToken(
          setupToken,
          setupRecord,
          TELEGRAM_SETUP_TTL_SECONDS,
        );

        return {
          success: true,
          oauthUrl: buildTelegramDeepLink(botUsername, setupToken),
        };
      }
      const shouldStoreCredentials =
        integrationType === 'remote_mcp'
          ? hasNonEmptyCredentialValue(credentials)
          : shouldStoreIntegrationCredentials(integrationType, credentials);
      const credentialsEncrypted = shouldStoreCredentials
        ? await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY)
        : '';

      const integrationId = crypto.randomUUID();
        await createWorkspaceIntegrationRecord(
          authEnv,
          workspaceId,
          integrationId,
          integrationType,
          name,
        definition.category,
        definition.authMethod,
        JSON.stringify(config),
        credentialsEncrypted,
        authContext.user.id
      );
      if (integrationType === 'remote_mcp' && config.auth_type === 'oauth') {
        const params = new URLSearchParams({
          integration_id: integrationId,
          redirect: '/connections',
        });
        return { success: true, oauthUrl: `/api/integrations/remote_mcp/oauth?${params.toString()}` };
      }
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to create integration' };
    }
  }

  if (intent === 'discoverIntegration') {
    const sourceUrl = String(formData.get('source_url') ?? '').trim();
    if (!sourceUrl) return { error: 'Enter a service, API, GraphQL, or MCP URL' };
    try {
      const definitions = await discoverIntegrationSurfaces(sourceUrl);
      return { success: true, definition: definitions[0], definitions };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Could not discover this service',
        genericFallback: true,
      };
    }
  }

  if (intent === 'createDiscoveredIntegration') {
    const sourceUrl = String(formData.get('source_url') ?? '').trim();
    const requestedName = String(formData.get('name') ?? '').trim();
    const authType = String(formData.get('auth_type') ?? 'none').trim().toLowerCase();
    const authHeader = String(formData.get('auth_header') ?? '').trim();
    const endpointConfirmed = formData.get('endpoint_confirmed') === 'true';
    const surfaceSlug = String(formData.get('surface_slug') ?? '').trim();
    const operationPolicy = formData.get('operation_policy') === 'all' ? 'all' : 'read_only';
    const credentialsStr = String(formData.get('credentials') ?? '{}');
    const variablesStr = String(formData.get('surface_variables') ?? '{}');
    try {
      const definitions = await discoverIntegrationSurfaces(sourceUrl);
      const definition = definitions.find((candidate) => candidate.slug === surfaceSlug) ?? definitions[0];
      if (!definition) return { error: 'The selected integration surface is no longer available' };
      if (integrationDefinitionRequiresEndpointConfirmation(definition, sourceUrl) && !endpointConfirmed) {
        return { error: 'Confirm the integrations.sh endpoint before creating this connection' };
      }
      const variableValues = JSON.parse(variablesStr) as Record<string, unknown>;
      const resolvedDefinition = resolveIntegrationDefinitionVariables(definition, variableValues);
      const resolvedUrlErrors = validateRemoteMcpUrl(resolvedDefinition.baseUrl);
      if (resolvedUrlErrors.length > 0) {
        return { error: resolvedUrlErrors[0]!.replace('Remote MCP server URL', 'Endpoint URL').replace('Server URL', 'Endpoint URL') };
      }
      const supportedAuth = new Set(definition.auth.map((auth) => auth.kind));
      const allowedAuth = definition.surface === 'mcp'
        ? ['none', 'bearer', 'header', 'oauth2']
        : ['none', 'bearer', 'basic', 'header'];
      if (authType === 'unknown') {
        return { error: 'Choose an authentication method after verifying the service documentation' };
      }
      if (!allowedAuth.includes(authType)) {
        return { error: `This authentication type is not supported for imported ${definition.surface} surfaces yet` };
      }
      if (
        !supportedAuth.has('unknown') &&
        !supportedAuth.has(authType as IntegrationAuthKind) &&
        !(authType === 'bearer' && supportedAuth.has('oauth2'))
      ) {
        return { error: `The discovered surface does not declare ${authType} authentication` };
      }
      const credentials = JSON.parse(credentialsStr) as Record<string, unknown>;
      if (
        (authType === 'bearer' || authType === 'header') &&
        (typeof credentials.api_key !== 'string' || !credentials.api_key.trim())
      ) {
        return { error: authType === 'bearer' ? 'Access token is required' : 'Header value is required' };
      }
      if (
        authType === 'basic' &&
        (
          typeof credentials.client_id !== 'string' || !credentials.client_id.trim() ||
          typeof credentials.client_secret !== 'string' || !credentials.client_secret.trim()
        )
      ) {
        return { error: 'Username and password are required for basic authentication' };
      }
      const definitionId = crypto.randomUUID();
      const integrationId = crypto.randomUUID();
      const connectionName = requestedName || definition.displayName;
      const integrationType = definition.surface === 'mcp' ? 'remote_mcp' : 'other';
      if (await workspaceIntegrationNameExists(authEnv, workspaceId, integrationType, connectionName)) {
        return { error: `A ${definition.surface} connection named "${connectionName}" already exists` };
      }
      const selectedTemplate = definition.auth.find((auth) => auth.kind === authType);
      if (definition.surface === 'mcp') {
        const remoteCredentials = normalizeIntegrationTokens('remote_mcp', { auth_type: authType },
          authType === 'bearer' || authType === 'header' ? { token: credentials.api_key } : {});
        const remoteConfig = {
          server_url: normalizeRemoteMcpUrl(resolvedDefinition.baseUrl),
          auth_type: authType === 'oauth2' ? 'oauth' : authType === 'header' ? 'custom_header' : authType,
          ...(authType === 'header'
            ? { auth_header: authHeader || selectedTemplate?.header || 'X-API-Key' }
            : {}),
          discovery_source: definition.sourceUrl,
        };
        const remoteErrors = validateRemoteMcpConnection(remoteConfig, remoteCredentials);
        if (remoteErrors.length > 0) return { error: remoteErrors.join(', ') };
        const credentialsEncrypted = hasNonEmptyCredentialValue(remoteCredentials)
          ? await encryptCredentials(remoteCredentials, env.INTEGRATION_SECRET_KEY)
          : '';
        await createWorkspaceIntegrationRecord(
          authEnv,
          workspaceId,
          integrationId,
          'remote_mcp',
          connectionName,
          'saas',
          'api_key',
          JSON.stringify(remoteConfig),
          credentialsEncrypted,
          authContext.user.id,
        );
        if (authType === 'oauth2') {
          const params = new URLSearchParams({
            integration_id: integrationId,
            redirect: '/connections',
          });
          return { success: true, integrationId, oauthUrl: `/api/integrations/remote_mcp/oauth?${params.toString()}` };
        }
        return { success: true, integrationId };
      }
      const config = {
        display_name: resolvedDefinition.displayName,
        description: resolvedDefinition.description,
        base_url: resolvedDefinition.baseUrl,
        auth_type: authType,
        ...(authType === 'header'
          ? { auth_header: authHeader || selectedTemplate?.header || 'X-API-Key' }
          : {}),
        operation_policy: operationPolicy,
        restrict_to_base_origin: true,
        generic_fetch_enabled: true,
      };
      if (
        authType === 'header' &&
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(String(config.auth_header ?? ''))
      ) {
        return { error: 'Custom authentication header name is invalid' };
      }
      const requiresCredentials = authType !== 'none';
      const credentialsEncrypted = requiresCredentials
        ? await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY)
        : '';
      await createWorkspaceIntegrationDefinitionRecord(
        authEnv,
        workspaceId,
        definitionId,
        resolvedDefinition.slug,
        JSON.stringify(resolvedDefinition),
        resolvedDefinition.source,
        resolvedDefinition.sourceUrl ?? sourceUrl,
        authContext.user.id,
      );
      await createWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
        'other',
        connectionName,
        'saas',
        'api_key',
        JSON.stringify(config),
        credentialsEncrypted,
        authContext.user.id,
        null,
        definitionId,
      );
      return { success: true, integrationId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to import API connection' };
    }
  }

  if (intent === 'updateIntegration') {
    const integrationId = formData.get('integrationId') as string;
    const name = formData.get('name') as string | null;
    const configStr = formData.get('config') as string | null;
    const credentialsStr = formData.get('credentials') as string | null;

    if (!integrationId) {
      return { error: 'Integration ID is required' };
    }

    try {
      const existing = await getWorkspaceIntegrationRecord(authEnv, workspaceId, integrationId);
      if (!existing) {
        return { error: 'Integration not found' };
      }

      const updates: {
        name?: string;
        config?: string;
        credentialsEncrypted?: string;
      } = {};

      if (name) updates.name = name;
      let parsedConfig: Record<string, unknown> | null = null;
      let parsedCredentials: Record<string, unknown> | null = null;
      if (configStr) {
        parsedConfig = JSON.parse(configStr) as Record<string, unknown>;
      }
      if (credentialsStr) {
        parsedCredentials = normalizeIntegrationTokens(
          existing.integration_type,
          parsedConfig ?? JSON.parse(existing.config),
          JSON.parse(credentialsStr) as Record<string, unknown>,
        );
      }

      if (existing.integration_type === 'remote_mcp' && (parsedConfig || parsedCredentials)) {
        const validationConfig = parsedConfig ?? JSON.parse(existing.config) as Record<string, unknown>;
        const validationCredentials = parsedCredentials ?? (
          existing.credentials_encrypted
            ? await decryptCredentials<Record<string, unknown>>(
                existing.credentials_encrypted,
                env.INTEGRATION_SECRET_KEY
              )
            : {}
        );
        const validationErrors = validateRemoteMcpConnection(validationConfig, validationCredentials);
        if (validationErrors.length > 0) {
          return { error: validationErrors.join(', ') };
        }
        if (parsedConfig) {
          parsedConfig.server_url = normalizeRemoteMcpUrl(String(parsedConfig.server_url));
        }
      }

      if (parsedConfig) updates.config = JSON.stringify(parsedConfig);
      if (parsedCredentials) {
        const shouldStoreCredentials =
          existing.integration_type === 'remote_mcp'
            ? hasNonEmptyCredentialValue(parsedCredentials)
            : shouldStoreIntegrationCredentials(existing.integration_type, parsedCredentials);
        updates.credentialsEncrypted = shouldStoreCredentials
          ? await encryptCredentials(parsedCredentials, env.INTEGRATION_SECRET_KEY)
          : '';
      }

      await updateWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
        updates,
        authContext.user.id,
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to update integration' };
    }
  }

  if (intent === 'deleteIntegration') {
    const integrationId = formData.get('integrationId') as string;

    if (!integrationId) {
      return { error: 'Integration ID is required' };
    }

    try {
      const existing = await getWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
      );
      if (existing?.integration_type === 'discord_channel') {
        try {
          await discord.releaseCurrentBinding(integrationId);
        } catch (error) {
          return {
            error: error instanceof Error
              ? `Failed to release Discord channel: ${error.message}`
              : 'Failed to release Discord channel',
          };
        }
      }
      await deleteWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
        authContext.user.id,
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete integration' };
    }
  }

  if (intent === 'duplicateIntegration') {
    const integrationId = formData.get('integrationId') as string;
    const targetWorkspaceId = formData.get('targetWorkspaceId') as string;

    if (!integrationId || !targetWorkspaceId) {
      return { error: 'Integration ID and target workspace are required' };
    }

    const targetInfo = authContext.workspaces?.find((ws) => ws.id === targetWorkspaceId);
    if (!targetInfo) {
      return { error: 'Target workspace must belong to the same organization' };
    }

    try {
      // Get the source integration record (including encrypted credentials)
      const sourceRecord = await getWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
      );
      if (!sourceRecord) {
        return { error: 'Integration not found' };
      }
      if (
        sourceRecord.integration_type === 'telegram' ||
        sourceRecord.integration_type === 'discord_channel'
      ) {
        return { error: 'Native channel integrations cannot be duplicated' };
      }

      // Deduplicate name: append " (copy)" if the name already exists on target
      let copyName = sourceRecord.name;
      const nameExists = await workspaceIntegrationNameExists(
        authEnv,
        targetWorkspaceId,
        sourceRecord.integration_type,
        copyName,
      );
      if (nameExists) {
        copyName = `${copyName} (copy)`;
      }

      // Copy to target workspace with new ID
      let targetDefinitionId: string | null = null;
      if (sourceRecord.definition_id) {
        const sourceDefinition = await getWorkspaceIntegrationDefinitionRecord(
          authEnv,
          workspaceId,
          sourceRecord.definition_id,
        );
        if (sourceDefinition) {
          targetDefinitionId = crypto.randomUUID();
          await createWorkspaceIntegrationDefinitionRecord(
            authEnv,
            targetWorkspaceId,
            targetDefinitionId,
            sourceDefinition.slug,
            sourceDefinition.payload,
            sourceDefinition.source,
            sourceDefinition.source_url,
            authContext.user.id,
          );
        }
      }
      const copyId = crypto.randomUUID();
      if (targetDefinitionId) {
        await createWorkspaceIntegrationRecord(
          authEnv,
          targetWorkspaceId,
          copyId,
          sourceRecord.integration_type,
          copyName,
          sourceRecord.category,
          sourceRecord.auth_method,
          sourceRecord.config,
          sourceRecord.credentials_encrypted,
          authContext.user.id,
          sourceRecord.token_expires_at ?? null,
          targetDefinitionId,
        );
      } else {
        await createWorkspaceIntegrationRecord(
          authEnv,
          targetWorkspaceId,
          copyId,
          sourceRecord.integration_type,
          copyName,
          sourceRecord.category,
          sourceRecord.auth_method,
          sourceRecord.config,
          sourceRecord.credentials_encrypted,
          authContext.user.id,
          sourceRecord.token_expires_at ?? null,
        );
      }

      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to duplicate integration' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const workspaceId = authContext.currentWorkspace?.id;
  const workspace = authContext.currentWorkspace;
  const discordAvailability = await getDiscordChannelAvailability(env);

  // Get integration types
  const integrations = getAllIntegrations({ includeFeatureGated: true }).filter(
    (integration) =>
      integration.type !== 'discord_channel' || discordAvailability.catalogAvailable,
  );
  const categories = Array.from(
    new Set(integrations.map((i) => i.category))
  ) as string[];

  // Get workspace integrations
  const connectionsPromise: Promise<ConnectionListItem[]> = workspaceId
    ? listWorkspaceIntegrationRecords(authEnv, workspaceId)
        .then(async (records) => {
          const creators = await getOptionalCreatorProfiles(authEnv, [
            ...records.map((record) => record.created_by),
            workspace?.created_by ?? '',
          ], request, [authContext.user], 'workspace connection');
          return Promise.all(
            records.map((record) => recordToIntegration(
              record,
              creators,
              env,
              discordAvailability.operationalReady,
            )),
          );
        })
        .catch((error) => {
          console.error('Failed to load workspace connections:', error);
          return [];
        })
    : Promise.resolve([]);
  const projectsPromise: Promise<MentionableProject[]> = workspaceId
    ? loadWorkspaceMentionProjects(env, workspaceId).catch((error) => {
        console.error('Failed to load workspace projects:', error);
        return [];
      })
    : Promise.resolve([]);
  // Promises passed to <Await> must be created here in the loader, never inline
  // in render: a suspended revalidation transition recreates render-scoped
  // promises on every retry and never commits.
  const pageDataPromise = Promise.all([connectionsPromise, projectsPromise]).then(
    ([connections, projects]) => ({ connections, projects }),
  );

  // Get other workspaces in the org for duplication targets
  const otherWorkspaces = (authContext.workspaces ?? [])
    .filter((ws) => ws.id !== workspaceId)
    .map((ws) => ({ id: ws.id, name: ws.name }));
  const workspaceEmailDomain = getWorkspaceEmailDomain(env);
  const workspaceEmailAddress = workspace?.email_handle && workspaceEmailDomain
    ? buildWorkspaceEmailAddress(workspace.email_handle, workspaceEmailDomain)
    : null;
  const emailInboxEnabled = getBillingPlanLimits(
    authContext.currentOrg.billing_plan,
    authContext.currentOrg.billing_status,
  ).emailInbox;
  const workspaceCreator = workspace?.created_by
    ? (await getOptionalCreatorProfiles(
        authEnv,
        [workspace.created_by],
        request,
        [authContext.user],
        'workspace email',
      )).get(workspace.created_by)
    : null;

  return {
    pageData: pageDataPromise,
    integrations,
    categories,
    orgId: authContext.currentOrg.id,
    workspaceId: workspaceId ?? null,
    otherWorkspaces,
    workspaceEmailAddress,
    emailMentionSlug: null,
    emailInboxEnabled,
    emailHandle: workspace?.email_handle ?? null,
    workspaceCreatedBy: workspace?.created_by ?? null,
    workspaceCreatedByName: workspaceCreator?.name ?? null,
    workspaceCreatedByAvatar: workspaceCreator?.avatar ?? null,
    workspaceCreatedAt: workspace?.created_at ?? null,
  };
}

export default function ConnectionsPage() {
  const {
    pageData,
    integrations,
    categories,
    workspaceId,
    otherWorkspaces,
    workspaceEmailAddress,
    emailMentionSlug,
    emailInboxEnabled,
    emailHandle,
    workspaceCreatedBy,
    workspaceCreatedByName,
    workspaceCreatedByAvatar,
    workspaceCreatedAt,
  } =
    useLoaderData<typeof loader>();

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <Suspense fallback={<ConnectionsLoadingSkeleton />}>
      <Await resolve={pageData}>
        {({ connections, projects }) => (
          <ConnectionsClient
            key={workspaceId}
            initialConnections={connections}
            initialMentionProjects={projects}
            connectionTypes={integrations}
            categories={categories}
            workspaceId={workspaceId}
            otherWorkspaces={otherWorkspaces}
            workspaceEmailAddress={workspaceEmailAddress}
            emailMentionSlug={emailMentionSlug}
            emailInboxEnabled={emailInboxEnabled}
            emailHandle={emailHandle}
            workspaceCreatedBy={workspaceCreatedBy}
            workspaceCreatedByName={workspaceCreatedByName}
            workspaceCreatedByAvatar={workspaceCreatedByAvatar}
            workspaceCreatedAt={workspaceCreatedAt}
          />
        )}
      </Await>
    </Suspense>
  );
}

export function HydrateFallback() {
  return <ConnectionsLoadingSkeleton />;
}
