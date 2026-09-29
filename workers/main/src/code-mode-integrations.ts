import type { OrgDO } from "./auth";
import type { IntegrationCategory } from "../../../src/types";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  getAllIntegrations,
  getIntegrationsByCategory,
  getIntegrationDefinition,
  shouldStoreIntegrationCredentials,
  validateConfig,
  validateCredentials,
  type DynamicField,
  type DynamicIntegrationSchema,
} from "../../../src/lib/integration-registry";
import { getProviderMcpDefinition } from "../../../src/lib/provider-mcp-registry";
import { getConnectionContract } from "../../../src/lib/connection-contract";
import { parseWorkspaceIntegrationDefinition } from "../../../src/lib/integration-definition";
import {
  normalizeRemoteMcpUrl,
  validateRemoteMcpConnection,
} from "../../../src/lib/remote-mcp";
import {
  discordChannelCatalogAvailable,
  type DiscordBridgeFetcher,
} from "./discord-types";

/** What a connection setup prompt answers (the user's form, or a cancel). */
export interface ConnectionSetupResponse {
  requestId: string;
  cancelled: boolean;
  integration?: {
    type: string;
    name: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  };
}

interface CodeModeIntegrationsEnv {
  INTEGRATION_SECRET_KEY: string;
  DISCORD_CHANNEL_ENABLED?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BRIDGE?: DiscordBridgeFetcher;
}

interface CodeModeIntegrationsOptions {
  env: CodeModeIntegrationsEnv;
  orgStub: DurableObjectStub<OrgDO>;
  workspaceId: string;
  userId?: string;
  promptConnectionSetup: (input: {
    integrationId?: string;
    integrationType: string;
    suggestedName?: string;
    message?: string;
    instructions?: string;
    initialConfig?: Record<string, unknown>;
    initialCredentials?: Record<string, unknown>;
    dynamicSchema?: DynamicIntegrationSchema;
  }) => Promise<ConnectionSetupResponse>;
}

function hasNonEmptyCredentialValue(credentials: Record<string, unknown>): boolean {
  return Object.values(credentials).some((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  });
}

type IntegrationAccessMetadata = {
  id: string;
  type: string;
  config?: Record<string, unknown>;
};

function hasTelegramDefaultRecipient(config: Record<string, unknown> | undefined): boolean {
  return typeof config?.chat_id === "string" && config.chat_id.trim().length > 0;
}

function telegramRoutingNote(
  config: Record<string, unknown> | undefined,
  connectedTelegramCount?: number,
): string {
  if (!hasTelegramDefaultRecipient(config)) {
    return "No default Telegram recipient is configured yet; ask the user to connect Telegram first.";
  }
  if (connectedTelegramCount !== undefined && connectedTelegramCount > 1) {
    return "Default Telegram recipient is configured for this connection; pass integration_id to choose it.";
  }
  return "Default Telegram recipient is configured for this connection; integration_id may be omitted when this is the only connected Telegram integration.";
}

function recommendedChannelActions(
  integration: IntegrationAccessMetadata,
  connectedTelegramCount?: number,
): Record<string, unknown>[] {
  if (integration.type === "discord_channel") {
    return [
      {
        name: "send_discord_message",
        tool: "tools.send_discord_message",
        usage: `await tools.send_discord_message({ integration_id: ${JSON.stringify(integration.id)}, text: "..." })`,
        description: "Send a Discord message from js_exec through this connected native channel.",
        routing: "The destination is restricted to this integration's configured channel; do not supply channel or thread ids.",
      },
    ];
  }
  if (integration.type !== "telegram") return [];
  return [
    {
      name: "send_telegram_message",
      tool: "tools.send_telegram_message",
      usage: `await tools.send_telegram_message({ integration_id: ${JSON.stringify(integration.id)}, text: "..." })`,
      description: "Send a Telegram message from js_exec through this connected Telegram channel.",
      routing: telegramRoutingNote(integration.config, connectedTelegramCount),
    },
  ];
}

function recommendedAccess(
  integration: IntegrationAccessMetadata,
  connectedTelegramCount?: number,
): Record<string, unknown> {
  const recommendedActions = recommendedChannelActions(integration, connectedTelegramCount);
  if (integration.type === "telegram") {
    return {
      tool: "js_exec",
      inspect_methods: "await env.CONNECTIONS.methods()",
      call_pattern: `await tools.send_telegram_message({ integration_id: ${JSON.stringify(integration.id)}, text: "..." })`,
      connection_id: integration.id,
      recommended_actions: recommendedActions,
      routing: telegramRoutingNote(integration.config, connectedTelegramCount),
    };
  }
  if (integration.type === "discord_channel") {
    return {
      tool: "js_exec",
      inspect_methods: "await env.CONNECTIONS.methods()",
      call_pattern: `await tools.send_discord_message({ integration_id: ${JSON.stringify(integration.id)}, text: "..." })`,
      connection_id: integration.id,
      recommended_actions: recommendedActions,
      routing: "Messages are sent only to the configured Discord channel or originating Camel-created thread.",
    };
  }
  return {
    tool: "js_exec",
    inspect_methods: "await env.CONNECTIONS.methods()",
    call_pattern: "await connections.<alias>.<method>({ ...input })",
    connection_id: integration.id,
  };
}

function parseConfig(config: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(config || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export class CodeModeIntegrations {
  constructor(private readonly options: CodeModeIntegrationsOptions) {}

  async list(args: Record<string, unknown>): Promise<unknown> {
    const category = typeof args.category === "string" ? args.category : "";
    const rawIntegrations = await this.options.orgStub.getWorkspaceIntegrations(
      this.options.workspaceId,
    );
    const integrations = rawIntegrations.map((record) => {
      let parsedConfig: Record<string, unknown> = {};
      try {
        parsedConfig = record.config ? JSON.parse(record.config) : {};
      } catch {
        parsedConfig = {};
      }
      return {
        id: record.id,
        integration_type: record.integration_type,
        name: record.name,
        category: record.category,
        auth_method: record.auth_method,
        has_credentials: Boolean(record.credentials_encrypted),
        created_at: record.created_at,
        updated_at: record.updated_at,
        config: parsedConfig,
        contract: getConnectionContract(record.integration_type, {
          config: parsedConfig,
          definition: parseWorkspaceIntegrationDefinition(record.definition),
        }),
        verification: {
          status: record.verification_status ?? "unknown",
          message: record.verification_message ?? null,
          checked_at: record.verification_checked_at
            ? new Date(record.verification_checked_at).toISOString()
            : null,
          live: record.verification_live === 1,
          strategy: record.verification_strategy ?? null,
        },
      };
    });
    const filtered = category
      ? integrations.filter((integration) => integration.category === category)
      : integrations;
    const connectedTelegramCount = integrations.filter((integration) =>
      integration.integration_type === "telegram" &&
      hasTelegramDefaultRecipient(integration.config)
    ).length;
    return {
      count: filtered.length,
      integrations: filtered.map((integration) => ({
        id: integration.id,
        type: integration.integration_type,
        name: integration.name,
        category: integration.category,
        auth_method: integration.auth_method,
        has_credentials: integration.has_credentials,
        contract: integration.contract,
        verification: integration.verification,
        created_at: new Date(integration.created_at).toISOString(),
        updated_at: new Date(integration.updated_at).toISOString(),
        recommended_access: recommendedAccess(
          {
            id: integration.id,
            type: integration.integration_type,
            config: integration.config,
          },
          connectedTelegramCount,
        ),
        display_name: integration.integration_type === "other" && typeof integration.config.display_name === "string"
          ? integration.config.display_name
          : undefined,
      })),
    };
  }

  async listTypes(args: Record<string, unknown>): Promise<unknown> {
    const category = typeof args.category === "string" ? args.category : "";
    const validCategory: IntegrationCategory | "" =
      category === "databases" ||
      category === "saas" ||
      category === "ai_services" ||
      category === "cloud_providers" ||
      category === "communication"
        ? category
        : "";
    const catalogOptions = {
      includeFeatureGated: await discordChannelCatalogAvailable(this.options.env),
    };
    const definitions = validCategory
      ? getIntegrationsByCategory(validCategory, catalogOptions)
      : getAllIntegrations(catalogOptions);
    const types = definitions.map((definition) => {
      const contract = getConnectionContract(definition.type);
      return {
        connection_kind: contract.driver,
        type: definition.type,
        display_name: definition.displayName,
        description: definition.description,
        category: definition.category,
        auth_method: definition.authMethod,
        config_fields: definition.configSchema.map((field) => ({
          name: field.name,
          label: field.label,
          type: field.type,
          required: field.required,
          description: field.description,
        })),
        credential_fields: definition.credentialSchema.map((field) => ({
          name: field.name,
          label: field.label,
          required: field.required,
          description: field.description,
        })),
        supports_proxy: false,
        supports_native_mcp_connection: definition.type === "remote_mcp",
        supports_brokered_mcp_tools: definition.type === "remote_mcp" || Boolean(getProviderMcpDefinition(definition.type)),
        capabilities: contract.capabilities,
        verification: contract.verification,
        permissions: contract.permissions,
        setup_hint:
          definition.type === "remote_mcp"
            ? "Use this type for native remote MCP servers. Provide config.server_url and config.auth_type; use auth_type oauth for MCP OAuth/DCR servers, bearer/custom_header with credentials.token for token auth, or none for public servers."
            : undefined,
      };
    });
    const byCategory: Record<string, typeof types> = {};
    for (const type of types) {
      if (!byCategory[type.category]) byCategory[type.category] = [];
      byCategory[type.category].push(type);
    }
    return { total_count: types.length, by_category: byCategory };
  }

  async create(args: Record<string, unknown>): Promise<unknown> {
    const integrationType = typeof args.integration_type === "string" ? args.integration_type.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    let config = args.config && typeof args.config === "object" ? args.config as Record<string, unknown> : {};
    const credentials = args.credentials && typeof args.credentials === "object" ? args.credentials as Record<string, unknown> : {};
    if (!integrationType) throw new Error("integration_type is required");
    if (!name) throw new Error("name is required");
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return {
        success: false,
        error: `Unknown integration type: ${integrationType}. Use list_integration_types to see available types.`,
      };
    }
    if (
      definition.featureGate === "discord_channel" &&
      !(await discordChannelCatalogAvailable(this.options.env))
    ) {
      return {
        success: false,
        error: "Discord channel connections are not available in this environment.",
      };
    }
    const configErrors = validateConfig(integrationType, config);
    if (configErrors.length > 0) {
      return { success: false, error: "Invalid configuration", validation_errors: configErrors };
    }
    const credentialErrors = validateCredentials(integrationType, credentials);
    if (credentialErrors.length > 0) {
      return { success: false, error: "Invalid credentials", validation_errors: credentialErrors };
    }
    if (integrationType === "remote_mcp") {
      const validationErrors = validateRemoteMcpConnection(config, credentials);
      if (validationErrors.length > 0) {
        return { success: false, error: "Invalid remote MCP connection", validation_errors: validationErrors };
      }
      config = {
        ...config,
        server_url: normalizeRemoteMcpUrl(String(config.server_url)),
      };
    }
    const shouldStoreCredentials =
      integrationType === "remote_mcp"
        ? hasNonEmptyCredentialValue(credentials)
        : shouldStoreIntegrationCredentials(integrationType, credentials);
    const credentialsEncrypted = shouldStoreCredentials
      ? await encryptCredentials(credentials, this.options.env.INTEGRATION_SECRET_KEY)
      : "";
    const integrationId = crypto.randomUUID();
    await this.options.orgStub.createWorkspaceIntegration(
      this.options.workspaceId,
      integrationId,
      integrationType,
      name,
      definition.category,
      definition.authMethod,
      JSON.stringify(config),
      credentialsEncrypted,
      this.options.userId || "system",
    );
    return {
      success: true,
      integration: {
        id: integrationId,
        type: integrationType,
        name,
        category: definition.category,
        recommended_access: recommendedAccess({ id: integrationId, type: integrationType, config }),
      },
      ...(integrationType === "remote_mcp" && config.auth_type === "oauth"
        ? {
            oauth_url: `/api/integrations/remote_mcp/oauth?${new URLSearchParams({
              integration_id: integrationId,
              redirect: "/connections",
            }).toString()}`,
          }
        : {}),
      message:
        integrationType === "remote_mcp" && config.auth_type === "oauth"
          ? `Integration '${name}' created successfully. OAuth authorization is still required before MCP tools can be used.`
          : `Integration '${name}' created successfully.`,
    };
  }

  private async updateExistingIntegration(
    integrationId: string,
    args: {
      type: string;
      name: string;
      config: Record<string, unknown>;
      credentials: Record<string, unknown>;
    },
  ): Promise<unknown> {
    const existing = await this.options.orgStub.getWorkspaceIntegration(
      this.options.workspaceId,
      integrationId,
    );
    if (!existing) {
      return { success: false, error: `Connection not found: ${integrationId}` };
    }
    if (existing.integration_type !== args.type) {
      return {
        success: false,
        error: `Connection ${integrationId} is ${existing.integration_type}, not ${args.type}.`,
      };
    }

    const definition = getIntegrationDefinition(args.type);
    if (!definition) {
      return { success: false, error: `Unknown integration type from user response: ${args.type}` };
    }

    let config = args.config;
    const configErrors = validateConfig(args.type, config);
    if (configErrors.length > 0) {
      return { success: false, error: "Invalid configuration", validation_errors: configErrors };
    }
    const shouldReplaceCredentials = hasNonEmptyCredentialValue(args.credentials);
    const credentialErrors = shouldReplaceCredentials
      ? validateCredentials(args.type, args.credentials)
      : [];
    if (credentialErrors.length > 0) {
      return { success: false, error: "Invalid credentials", validation_errors: credentialErrors };
    }
    if (args.type === "remote_mcp") {
      const validationErrors = shouldReplaceCredentials
        ? validateRemoteMcpConnection(config, args.credentials)
        : validateConfig(args.type, config);
      if (validationErrors.length > 0) {
        return { success: false, error: "Invalid remote MCP connection", validation_errors: validationErrors };
      }
      config = {
        ...config,
        server_url: normalizeRemoteMcpUrl(String(config.server_url)),
      };
    }

    const updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
    } = {
      name: args.name,
      config: JSON.stringify(config),
    };
    if (shouldReplaceCredentials) {
      updates.credentialsEncrypted = (
        args.type === "remote_mcp" || shouldStoreIntegrationCredentials(args.type, args.credentials)
      )
        ? await encryptCredentials(args.credentials, this.options.env.INTEGRATION_SECRET_KEY)
        : "";
    }

    await this.options.orgStub.updateWorkspaceIntegration(
      this.options.workspaceId,
      integrationId,
      updates,
      this.options.userId || "system",
    );

    return {
      success: true,
      integration: {
        id: integrationId,
        type: args.type,
        name: args.name,
        category: definition.category,
        recommended_access: recommendedAccess({ id: integrationId, type: args.type, config }),
      },
      ...(args.type === "remote_mcp" && config.auth_type === "oauth"
        ? {
            oauth_url: `/api/integrations/remote_mcp/oauth?${new URLSearchParams({
              integration_id: integrationId,
              redirect: "/connections",
            }).toString()}`,
          }
        : {}),
      message:
        args.type === "remote_mcp" && config.auth_type === "oauth"
          ? `Integration '${args.name}' updated successfully. OAuth authorization is still required before MCP tools can be used.`
          : `Integration '${args.name}' updated successfully.`,
    };
  }

  async promptConnectionSetup(args: Record<string, unknown>): Promise<unknown> {
    const integrationId = typeof args.integration_id === "string" && args.integration_id.trim()
      ? args.integration_id.trim()
      : typeof args.connection_id === "string" && args.connection_id.trim()
        ? args.connection_id.trim()
        : "";
    const existing = integrationId
      ? await this.options.orgStub.getWorkspaceIntegration(
          this.options.workspaceId,
          integrationId,
        )
      : null;
    if (integrationId && !existing) {
      return { success: false, error: `Connection not found: ${integrationId}` };
    }

    const integrationType =
      typeof args.integration_type === "string" && args.integration_type.trim()
        ? args.integration_type.trim()
        : existing?.integration_type ?? "";
    if (!integrationType) throw new Error("integration_type is required");
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return {
        success: false,
        error: `Unknown integration type: ${integrationType}. Use list_integration_types to see available types.`,
      };
    }
    if (
      definition.featureGate === "discord_channel" &&
      !(await discordChannelCatalogAvailable(this.options.env))
    ) {
      return {
        success: false,
        error: "Discord channel connections are not available in this environment.",
      };
    }
    const dynamicSchema = integrationType === "other" && Array.isArray(args.fields)
      ? {
          displayName:
            typeof args.display_name === "string" && args.display_name.trim()
              ? args.display_name.trim()
              : typeof args.suggested_name === "string" && args.suggested_name.trim()
                ? args.suggested_name.trim()
                : "Custom Integration",
          description: typeof args.description === "string" ? args.description : undefined,
          instructions: typeof args.instructions === "string" ? args.instructions : undefined,
          fields: args.fields as DynamicField[],
        }
      : undefined;
    const initialConfig = args.config && typeof args.config === "object"
      ? args.config as Record<string, unknown>
      : existing
        ? parseConfig(existing.config)
        : undefined;
    const initialCredentials = args.credentials && typeof args.credentials === "object"
      ? args.credentials as Record<string, unknown>
      : undefined;
    const response = await this.options.promptConnectionSetup({
      integrationId: integrationId || undefined,
      integrationType,
      suggestedName:
        typeof args.suggested_name === "string" && args.suggested_name.trim()
          ? args.suggested_name.trim()
          : existing?.name ?? dynamicSchema?.displayName ?? definition.displayName,
      message: typeof args.message === "string" ? args.message : undefined,
      instructions: typeof args.instructions === "string" ? args.instructions : undefined,
      initialConfig,
      initialCredentials,
      dynamicSchema,
    });
    if (response.cancelled) {
      return { success: false, cancelled: true, message: "User cancelled the connection setup" };
    }
    if (!response.integration) {
      return { success: false, error: "Invalid response from user - missing integration data" };
    }
    const { type, name, config, credentials } = response.integration;
    const responseDefinition = getIntegrationDefinition(type);
    if (!responseDefinition) {
      return { success: false, error: `Unknown integration type from user response: ${type}` };
    }
    if (credentials._oauth_completed && credentials.integration_id) {
      const integrationId = String(credentials.integration_id);
      return {
        success: true,
        integration: {
          id: integrationId,
          type,
          name,
          category: responseDefinition.category,
          recommended_access: recommendedAccess({ id: integrationId, type, config }),
        },
        message: `Integration '${name}' connected successfully via OAuth.`,
      };
    }
    const finalConfig =
      type === "other" && dynamicSchema?.fields.length
        ? {
            ...config,
            display_name: dynamicSchema.displayName,
            dynamic_fields: dynamicSchema.fields,
          }
        : config;
    if (integrationId) {
      return this.updateExistingIntegration(integrationId, {
        type,
        name,
        config: finalConfig,
        credentials,
      });
    }
    return this.create({
      integration_type: type,
      name,
      config: finalConfig,
      credentials,
    });
  }
}
