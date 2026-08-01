import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { getIntegrationDefinition } from '../../../src/lib/integration-registry';
import {
  getConnectionContract,
  type ConnectionContract,
  type ConnectionVerificationStatus,
} from '../../../src/lib/connection-contract';
import { validateRemoteMcpUrl } from '../../../src/lib/remote-mcp';
import {
  parseWorkspaceIntegrationDefinition,
  type IntegrationOperationDefinition,
} from '../../../src/lib/integration-definition';
import {
  PROVIDER_MCP_REGISTRY,
  type ProviderMcpDefinition,
} from '../../../src/lib/provider-mcp-registry';
import {
  getHostedConnectionAdapter,
  getHostedConnectionVerificationProbe,
} from './connection-adapters.js';
import {
  recordErrorEvent,
  recordObservabilityEvent,
  type ObservabilityEnv,
} from './observability.js';
import {
  GOOGLE_ANALYTICS_INTEGRATION_TYPE,
  GOOGLE_ANALYTICS_METHODS,
  googleAnalyticsTool,
} from './google-analytics-mcp.js';
import type {
  WorkspaceIntegrationAuthStatus,
  WorkspaceIntegrationRecord,
} from './workspace.js';
import type { OrgDO } from './auth.js';
import type { DataProxyEnv } from './data-proxy.js';
import {
  discordBridgeClient,
  discordChannelEnabled,
  parseDiscordChannelConfig,
  type DiscordBridgeFetcher,
} from './discord-types.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ConnectionsRuntimeEnv extends DataProxyEnv, ObservabilityEnv {
  INTEGRATION_SECRET_KEY: string;
  ORG: DurableObjectNamespace<OrgDO>;
  /** Auto-expiring R2 staging bucket for warehouse exports (connection `export` method). */
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
  DISCORD_BRIDGE?: DiscordBridgeFetcher;
  DISCORD_CHANNEL_ENABLED?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  /**
   * When "false"/"0"/"off"/"no"/"disabled", deployed-app CONNECTIONS bindings
   * fail closed. Chat-agent / js_exec paths do not consult this flag.
   */
  CONNECTIONS_BINDING_ENABLED?: string;
}
export interface ConnectionsContext {
  orgId: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
  requestId?: string;
}

export interface ConnectionSummary {
  id: string;
  type: string;
  name: string;
  displayName: string;
  category: string;
  authMethod: string;
  authStatus: WorkspaceIntegrationAuthStatus;
  authErrorCode: string | null;
  authErrorMessage: string | null;
  authCheckedAt: string | null;
  reauthRequiredAt: string | null;
  reauthUrl: string | null;
  hasCredentials: boolean;
  capabilities: string[];
  contract: ConnectionContract;
  verification: {
    status: ConnectionVerificationStatus;
    message: string | null;
    checkedAt: string | null;
    live: boolean;
    strategy: ConnectionContract['verification']['strategy'];
  };
  recommendedActions: ConnectionRecommendedAction[];
  nativeMcp: {
    serverName: string;
    transport: ProviderMcpDefinition['transport'];
    directConnect: boolean;
    brokered: boolean;
    authStrategy: string;
    preferredMode?: 'direct' | 'brokered';
    direct?: {
      serverName: string;
      url: string;
      transport: ProviderMcpDefinition['transport'];
      authStrategy: string;
      docsUrl?: string;
      notes?: string;
    };
    broker?: {
      serverName: string;
      url: string;
      transport: ProviderMcpDefinition['transport'];
      authStrategy: string;
      brokerPath: string;
      docsUrl?: string;
      notes?: string;
    };
  } | null;
}

export interface ConnectionRecommendedAction {
  name: string;
  tool: string;
  usage: string;
  description?: string;
  routing?: string;
}

export interface ConnectionMethodSummary {
  name: string;
  tool: string;
  description?: string;
  example?: string;
  invokeVia?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  access?: 'read' | 'write';
}

export interface ConnectionMethodCatalogEntry {
  alias: string;
  connection: ConnectionSummary;
  methods: ConnectionMethodSummary[];
  error?: {
    message: string;
    code?: unknown;
    data?: unknown;
  };
}

export interface ConnectionInvokeRequest {
  connection: string;
  method?: string;
  input?: unknown;
}

export type ConnectionFindQuery =
  | string
  | {
    id?: string;
    alias?: string;
    type?: string;
    name?: string;
  };

export interface ConnectionSmokeTestResult {
  ok: true;
  alias: string;
  connection: ConnectionSummary;
  method: string | null;
  result?: unknown;
}

export interface ConnectionVerificationResult {
  ok: boolean;
  status: ConnectionVerificationStatus;
  checkedAt: string;
  live: boolean;
  strategy: ConnectionContract['verification']['strategy'];
  message: string;
  connection: ConnectionSummary;
  method?: string;
}

const NATIVE_MCP_SERVERS = PROVIDER_MCP_REGISTRY;
const OTHER_CONNECTION_FETCH_TOOL = 'authenticated_fetch';
const IMPORTED_OPERATION_TOOL_PREFIX = 'integration_operation:';
type NativeHttpApiConnection = {
  displayName: string;
  baseUrl: string;
  credentialKeys: string[];
  authHeader: 'bearer';
  defaultHeaders?: Record<string, string>;
};
const NATIVE_HTTP_API_CONNECTIONS: Record<string, NativeHttpApiConnection> = {
  resend: {
    displayName: 'Resend',
    baseUrl: 'https://api.resend.com',
    credentialKeys: ['api_key'],
    authHeader: 'bearer',
    defaultHeaders: {
      accept: 'application/json',
      'user-agent': 'camelai-resend-connection/1.0',
    },
  },
};
const SLACK_SEND_TOOL = 'send_slack_message';
const SLACK_API_TOOL = 'slack_api';
const SLACK_COMMON_API_METHODS: ConnectionMethodSummary[] = [
  {
    name: 'slackApi',
    tool: SLACK_API_TOOL,
    invokeVia: 'connections.<alias>.slackApi',
    description: 'Call any Slack Web API method available to the connected bot token.',
    example: 'await connections.<alias>.slackApi({ method: "conversations.list", params: { types: "public_channel,private_channel", limit: 100 } })',
    inputSchema: {
      type: 'object',
      required: ['method'],
      properties: {
        method: {
          type: 'string',
          description: 'Slack Web API method, for example conversations.list, chat.update, reactions.add, or users.info.',
        },
        params: {
          type: 'object',
          description: 'Slack API parameters. Objects and arrays are sent as JSON for POST requests.',
        },
        http_method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method for the Slack API call. Defaults to POST.',
        },
        encoding: {
          type: 'string',
          enum: ['json', 'form'],
          description: 'POST body encoding. Defaults to JSON.',
        },
      },
    },
  },
  {
    name: 'listSlackChannels',
    tool: 'list_slack_channels',
    invokeVia: 'connections.<alias>.listSlackChannels',
    description: 'List Slack conversations visible to the connected bot.',
    example: 'await connections.<alias>.listSlackChannels({ types: "public_channel,private_channel", limit: 100 })',
  },
  {
    name: 'listSlackUsers',
    tool: 'list_slack_users',
    invokeVia: 'connections.<alias>.listSlackUsers',
    description: 'List Slack users visible to the connected bot.',
    example: 'await connections.<alias>.listSlackUsers({ limit: 100 })',
  },
  {
    name: 'getSlackChannelHistory',
    tool: 'get_slack_channel_history',
    invokeVia: 'connections.<alias>.getSlackChannelHistory',
    description: 'Read Slack conversation history for a channel the bot can access.',
    example: 'await connections.<alias>.getSlackChannelHistory({ channel: "C123", limit: 20 })',
  },
  {
    name: 'getSlackThreadReplies',
    tool: 'get_slack_thread_replies',
    invokeVia: 'connections.<alias>.getSlackThreadReplies',
    description: 'Read replies in a Slack thread.',
    example: 'await connections.<alias>.getSlackThreadReplies({ channel: "C123", ts: "1712345678.901" })',
  },
  {
    name: 'updateSlackMessage',
    tool: 'update_slack_message',
    invokeVia: 'connections.<alias>.updateSlackMessage',
    description: 'Update a Slack message posted by the connected bot.',
    example: 'await connections.<alias>.updateSlackMessage({ channel: "C123", ts: "1712345678.901", text: "Updated text" })',
  },
  {
    name: 'deleteSlackMessage',
    tool: 'delete_slack_message',
    invokeVia: 'connections.<alias>.deleteSlackMessage',
    description: 'Delete a Slack message posted by the connected bot.',
    example: 'await connections.<alias>.deleteSlackMessage({ channel: "C123", ts: "1712345678.901" })',
  },
  {
    name: 'addSlackReaction',
    tool: 'add_slack_reaction',
    invokeVia: 'connections.<alias>.addSlackReaction',
    description: 'Add a reaction to a Slack message as the connected bot.',
    example: 'await connections.<alias>.addSlackReaction({ channel: "C123", timestamp: "1712345678.901", name: "white_check_mark" })',
  },
];
const TELEGRAM_SEND_TOOL = 'send_telegram_message';
const DISCORD_SEND_TOOL = 'send_discord_message';
const SLACK_SEND_METHOD: ConnectionMethodSummary = {
  name: 'sendSlackMessage',
  tool: SLACK_SEND_TOOL,
  invokeVia: 'tools.send_slack_message',
  description:
    'Virtual channel action for sending a Slack message as the connected bot. Call the example from js_exec; this is not a raw Slack API fetch method.',
  example: 'await tools.send_slack_message({ integration_id: "<integration_id>", channel_id: "C123", text: "Hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      integration_id: {
        type: 'string',
        description:
          'Slack integration id. Optional only when exactly one Slack connection exists or the current thread originated from Slack.',
      },
      team_id: {
        type: 'string',
        description: 'Optional Slack team id used to select a connection when multiple Slack workspaces are connected.',
      },
      channel_id: {
        type: 'string',
        description: 'Slack channel or DM id. Required outside Slack-originated threads.',
      },
      thread_ts: {
        type: 'string',
        description: 'Optional Slack thread timestamp for replies.',
      },
      text: {
        type: 'string',
        description: 'Message text to send.',
      },
      attachments: {
        type: 'array',
        description: 'Optional attachments from workspace paths.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            filename: { type: 'string' },
            content_type: { type: 'string' },
            caption: { type: 'string' },
          },
        },
      },
    },
  },
};
const TELEGRAM_SEND_METHOD: ConnectionMethodSummary = {
  name: 'sendTelegramMessage',
  tool: TELEGRAM_SEND_TOOL,
  invokeVia: 'tools.send_telegram_message',
  description:
    'Virtual channel action for sending a Telegram message. Call the example from js_exec; this is not a raw Telegram API fetch method.',
  example: 'await tools.send_telegram_message({ integration_id: "<integration_id>", text: "Hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      integration_id: {
        type: 'string',
        description:
          'Telegram integration id. Optional only when exactly one connected Telegram integration exists or the current thread originated from Telegram.',
      },
      text: {
        type: 'string',
        description: 'Message text to send.',
      },
      attachments: {
        type: 'array',
        description:
          'Optional attachments. Image attachments are sent as native Telegram photos unless send_as is "document".',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            filename: { type: 'string' },
            content_type: { type: 'string' },
            caption: { type: 'string' },
            send_as: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: true,
        },
      },
    },
    anyOf: [
      { required: ['text'] },
      { required: ['attachments'] },
    ],
    additionalProperties: false,
  },
};
const DISCORD_SEND_METHOD: ConnectionMethodSummary = {
  name: 'sendDiscordMessage',
  tool: DISCORD_SEND_TOOL,
  invokeVia: 'tools.send_discord_message',
  description:
    'Virtual channel action for sending a Discord message to this integration or the originating Discord thread.',
  example: 'await tools.send_discord_message({ integration_id: "<integration_id>", text: "Hello" })',
  inputSchema: {
    type: 'object',
    properties: {
      integration_id: {
        type: 'string',
        description: 'Native Discord integration id. Optional only when one active integration exists or the current thread originated from Discord.',
      },
      text: { type: 'string', description: 'Message text to send.' },
      attachments: {
        type: 'array',
        description: 'Optional attachments from workspace paths.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            filename: { type: 'string' },
            content_type: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    anyOf: [
      { required: ['text'] },
      { required: ['attachments'] },
    ],
    additionalProperties: false,
  },
};
const NATIVE_MCP_HTTP_TIMEOUT_MS = 15_000;
const OTHER_CONNECTION_FETCH_METHOD: ConnectionMethodSummary = {
  name: 'fetch',
  tool: OTHER_CONNECTION_FETCH_TOOL,
  description:
    'Fetch from this authenticated HTTP connection like fetch(input, init). Relative URLs are resolved against the connection API base URL and camelAI applies the stored auth settings.',
  example: 'await connections.<alias>.fetch("/v1/items", { method: "GET" })',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description:
          'Fetch input: a relative URL such as "/v1/items" or an absolute http(s) URL allowed by the connection.',
      },
      init: {
        type: 'object',
        description: 'Fetch init object. Supports method, headers, and body.',
        properties: {
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
            description: 'HTTP method. Defaults to GET.',
          },
          headers: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional request headers. Authentication headers are applied by camelAI.',
          },
          body: {
            description:
              'Optional request body. Strings are sent as-is; objects and arrays are JSON encoded.',
          },
        },
        additionalProperties: true,
      },
    },
    required: ['input'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'number' },
      statusText: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      bodyText: { type: 'string' },
      truncated: { type: 'boolean' },
    },
    required: ['status', 'statusText', 'headers', 'bodyText', 'truncated'],
    additionalProperties: false,
  },
};
const OTHER_CONNECTION_RESPONSE_LIMIT = 1_000_000;
const DATABASE_QUERY_TOOL_NAMES = new Set([
  'execute_sql_readonly',
]);
const DATABASE_QUERY_INTEGRATION_TYPES = new Set([
  'bigquery',
  'clickhouse',
  'databricks',
  'mysql',
  'neon',
  'planetscale',
  'postgres',
  'snowflake',
  'turso',
]);

type ConnectionAuthErrorData = {
  code: string;
  authStatus: WorkspaceIntegrationAuthStatus;
  reauthUrl: string | null;
  integration: Record<string, string>;
};

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function timestamp(value: number | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function normalizedVerificationStatus(value: string | null | undefined): ConnectionVerificationStatus {
  return value === 'ready' ||
    value === 'configured' ||
    value === 'needs_authorization' ||
    value === 'misconfigured' ||
    value === 'degraded'
    ? value
    : 'unknown';
}

function hasTelegramDefaultRecipient(config: Record<string, unknown>): boolean {
  return typeof config.chat_id === 'string' && config.chat_id.trim().length > 0;
}

function telegramRoutingNote(config: Record<string, unknown>): string {
  return hasTelegramDefaultRecipient(config)
    ? 'Default Telegram recipient is configured for this connection. Outside Telegram-originated threads, pass integration_id when more than one Telegram connection exists.'
    : 'No default Telegram recipient is configured yet; ask the user to connect Telegram first.';
}

function recommendedConnectionActions(
  record: WorkspaceIntegrationRecord,
  config: Record<string, unknown>
): ConnectionRecommendedAction[] {
  if (record.integration_type === 'slack') {
    return [
      {
        name: SLACK_SEND_TOOL,
        tool: `tools.${SLACK_SEND_TOOL}`,
        usage: `await tools.${SLACK_SEND_TOOL}({ integration_id: ${JSON.stringify(record.id)}, channel_id: "C123", text: "Hello" })`,
        description: 'Send a Slack message from js_exec through this connected Slack bot.',
        routing: 'Outside Slack-originated threads, provide channel_id and pass integration_id when more than one Slack connection exists.',
      },
    ];
  }
  if (record.integration_type === 'discord_channel') {
    return [
      {
        name: DISCORD_SEND_TOOL,
        tool: `tools.${DISCORD_SEND_TOOL}`,
        usage: `await tools.${DISCORD_SEND_TOOL}({ integration_id: ${JSON.stringify(record.id)}, text: "Hello" })`,
        description: 'Send a Discord message from js_exec through this native channel.',
        routing: 'The configured parent channel and Camel-created threads are the only allowed destinations.',
      },
    ];
  }
  if (record.integration_type !== 'telegram') return [];
  return [
    {
      name: TELEGRAM_SEND_TOOL,
      tool: `tools.${TELEGRAM_SEND_TOOL}`,
      usage: `await tools.${TELEGRAM_SEND_TOOL}({ integration_id: ${JSON.stringify(record.id)}, text: "Hello" })`,
      description: 'Send a Telegram message from js_exec through this connected Telegram channel.',
      routing: telegramRoutingNote(config),
    },
  ];
}

function authStatus(record: WorkspaceIntegrationRecord): WorkspaceIntegrationAuthStatus {
  return record.auth_status ?? (record.credentials_encrypted ? 'connected' : 'setup_incomplete');
}

function isRemoteMcpOAuth(record: WorkspaceIntegrationRecord, config = parseJsonObject(record.config)): boolean {
  return record.integration_type === 'remote_mcp' && config.auth_type === 'oauth';
}

function reauthUrl(record: WorkspaceIntegrationRecord, context: ConnectionsContext): string | null {
  if (record.auth_method === 'oauth2' || isRemoteMcpOAuth(record)) {
    const params = new URLSearchParams({
      workspace_id: context.workspaceId,
      integration_id: record.id,
      redirect: '/connections',
    });
    const oauthType = record.integration_type === 'discord_channel'
      ? 'discord'
      : record.integration_type;
    return `/api/integrations/${encodeURIComponent(oauthType)}/oauth?${params.toString()}`;
  }
  return `/connections?${new URLSearchParams({ connection: record.id, reauth: '1' }).toString()}`;
}

function authErrorData(
  record: WorkspaceIntegrationRecord,
  context: ConnectionsContext,
  status: WorkspaceIntegrationAuthStatus,
  code: string
): ConnectionAuthErrorData {
  return {
    code,
    authStatus: status,
    reauthUrl: reauthUrl(record, context),
    integration: compactIntegrationRef(record),
  };
}

function connectionAuthError(
  record: WorkspaceIntegrationRecord,
  context: ConnectionsContext,
  status: WorkspaceIntegrationAuthStatus,
  code: string,
  message: string,
  httpStatus = 401
): Error {
  return Object.assign(new Error(message), {
    status: httpStatus,
    code,
    data: authErrorData(record, context, status, code),
  });
}

function providerAuthStatus(httpStatus: number): WorkspaceIntegrationAuthStatus | null {
  if (httpStatus === 401) return 'needs_reauth';
  if (httpStatus === 403) return 'missing_scopes';
  return null;
}

function providerSetupStatus(httpStatus: number, message: string): WorkspaceIntegrationAuthStatus | null {
  if (httpStatus !== 400) return null;
  const normalized = message.toLowerCase();
  if (
    normalized.includes('no stored credentials') ||
    normalized.includes('usable access token') ||
    normalized.includes('connection_string is required') ||
    normalized.includes('requires atlas data api url') ||
    normalized.includes('requires rest_url') ||
    normalized.includes('requires rest token') ||
    normalized.includes('workspace_url is required') ||
    normalized.includes('warehouseid is required because the connection has no') ||
    normalized.includes('private_key_fingerprint is required') ||
    normalized.includes('database_url is required') ||
    normalized.includes('shop_domain is required') ||
    normalized.includes('tenant_id is required') ||
    normalized.includes('data_api_url must use https') ||
    normalized.includes('workspace_url must use https') ||
    normalized.includes('data_api_key is required') ||
    normalized.includes('rest_token is required') ||
    normalized.includes('api_key is required') ||
    normalized.includes('auth_token is required') ||
    normalized.includes('account_sid is required') ||
    normalized.includes('client_id is required') ||
    normalized.includes('client_secret is required') ||
    normalized.includes('private_key is required')
  ) {
    return 'setup_incomplete';
  }
  return null;
}

async function markConnectionAuthStatus(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  status: WorkspaceIntegrationAuthStatus,
  code: string,
  message: string
): Promise<void> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId)) as unknown as OrgDO;
    await orgStub.updateWorkspaceIntegrationAuthStatus(
      context.workspaceId,
      record.id,
      status,
      code,
      message,
      context.userId ?? 'system',
      {
        config: record.config,
        credentialsEncrypted: record.credentials_encrypted,
      },
    );
  } catch (error) {
    console.warn('[connections-runtime] failed to update connection auth status', {
      integrationId: record.id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function persistConnectionVerification(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  result: Pick<
    ConnectionVerificationResult,
    'status' | 'message' | 'live' | 'strategy'
  > & { checkedAtMs: number },
): Promise<boolean> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId)) as unknown as OrgDO;
    return await orgStub.updateWorkspaceIntegrationVerification(
      context.workspaceId,
      record.id,
      {
        status: result.status,
        message: result.message,
        checkedAt: result.checkedAtMs,
        live: result.live,
        strategy: result.strategy,
      },
      context.userId ?? 'system',
      {
        config: record.config,
        credentialsEncrypted: record.credentials_encrypted,
      },
    );
  } catch (error) {
    console.warn('[connections-runtime] failed to persist connection verification', {
      integrationId: record.id,
      status: result.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function mcpDefinitionForRecord(
  record: WorkspaceIntegrationRecord,
  config = parseJsonObject(record.config)
): ProviderMcpDefinition | null {
  if (record.integration_type === 'remote_mcp') {
    const serverUrl = typeof config.server_url === 'string' ? config.server_url.trim() : '';
    if (!serverUrl || validateRemoteMcpUrl(serverUrl).length > 0) return null;
    return {
      integrationType: 'remote_mcp',
      serverName: record.name,
      url: serverUrl,
      transport: 'streamable_http',
      authStrategy: 'remote_mcp_config',
      brokered: true,
      directConnect: false,
      preferredMode: 'brokered',
      broker: {
        serverName: record.name,
        url: serverUrl,
        transport: 'streamable_http',
        authStrategy: 'remote_mcp_config',
        notes:
          'User-configured remote MCP server. camelAI proxies this server and applies the configured auth header server-side.',
      },
      notes:
        'User-configured remote MCP server. camelAI proxies this server and applies the configured auth header server-side.',
    } as unknown as ProviderMcpDefinition;
  }
  return NATIVE_MCP_SERVERS[record.integration_type] ?? null;
}

function summarizeConnection(record: WorkspaceIntegrationRecord, context: ConnectionsContext): ConnectionSummary {
  const config = parseJsonObject(record.config);
  const importedDefinition = parseWorkspaceIntegrationDefinition(record.definition);
  const definition = getIntegrationDefinition(record.integration_type);
  const nativeMcp = mcpDefinitionForRecord(record, config);
  const contract = getConnectionContract(record.integration_type, {
    config,
    definition: importedDefinition,
  });
  const resolvedAuthStatus = authStatus(record);
  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
    displayName:
      (record.integration_type === 'other' && typeof config.display_name === 'string'
        ? config.display_name
        : definition?.displayName) ?? record.name,
    category: record.category,
    authMethod: record.auth_method,
    authStatus: resolvedAuthStatus,
    authErrorCode: record.auth_error_code ?? null,
    authErrorMessage: record.auth_error_message ?? null,
    authCheckedAt: timestamp(record.auth_checked_at),
    reauthRequiredAt: timestamp(record.reauth_required_at),
    reauthUrl: resolvedAuthStatus === 'connected' ? null : reauthUrl(record, context),
    hasCredentials: Boolean(record.credentials_encrypted),
    capabilities: contract.capabilities,
    contract,
    verification: {
      status: normalizedVerificationStatus(record.verification_status),
      message: record.verification_message ?? null,
      checkedAt: timestamp(record.verification_checked_at),
      live: record.verification_live === 1,
      strategy: (record.verification_strategy as ConnectionContract['verification']['strategy'] | null)
        ?? contract.verification.strategy,
    },
    recommendedActions: recommendedConnectionActions(record, config),
    nativeMcp: nativeMcp
      ? {
          serverName: nativeMcp.serverName,
          transport: nativeMcp.transport,
          directConnect: false,
          brokered: true,
          authStrategy: nativeMcp.authStrategy === 'first_party_oauth_direct'
            ? 'connected_credentials_broker'
            : nativeMcp.authStrategy,
          preferredMode: 'brokered',
          broker: {
            serverName: nativeMcp.broker?.serverName ?? nativeMcp.serverName,
            url: nativeMcp.broker?.url ?? nativeMcp.url,
            transport: nativeMcp.broker?.transport ?? nativeMcp.transport,
            authStrategy: nativeMcp.broker?.authStrategy ?? (
              nativeMcp.authStrategy === 'first_party_oauth_direct'
                ? 'connected_credentials_broker'
                : nativeMcp.authStrategy
            ),
            brokerPath: '/rpc/connections',
            docsUrl: nativeMcp.broker?.docsUrl ?? nativeMcp.docsUrl,
            notes: nativeMcp.broker?.notes,
          },
        }
      : null,
  };
}

function compactIntegrationRef(record: WorkspaceIntegrationRecord): Record<string, string> {
  return {
    id: record.id,
    type: record.integration_type,
    name: record.name,
  };
}

function toIdentifier(value: string, fallback: string): string {
  const parts = value
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  const [first, ...rest] = parts;
  const identifier = [
    first!.charAt(0).toLowerCase() + first!.slice(1),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)),
  ].join('');
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `${fallback}${identifier}`;
}

function connectionAlias(connection: ConnectionSummary, used: Set<string>): string {
  const base = toIdentifier(`${connection.type} ${connection.name}`, 'connection');
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function toolToMethod(tool: unknown): ConnectionMethodSummary | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    input_schema?: unknown;
    outputSchema?: unknown;
    output_schema?: unknown;
  };
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  return {
    name: toIdentifier(record.name, 'method'),
    tool: record.name,
    description: typeof record.description === 'string' ? record.description : undefined,
    example: undefined,
    inputSchema: record.inputSchema ?? record.input_schema,
    outputSchema: record.outputSchema ?? record.output_schema,
  };
}

function methodExample(alias: string, method: ConnectionMethodSummary): string {
  if (method.tool === SLACK_SEND_TOOL) {
    return method.example?.replace('<integration_id>', alias) ?? `await tools.${SLACK_SEND_TOOL}({ integration_id: "${alias}", channel_id: "C123", text: "Hello" })`;
  }
  if (method.tool === TELEGRAM_SEND_TOOL) {
    return method.example?.replace('<integration_id>', alias) ?? `await tools.${TELEGRAM_SEND_TOOL}({ integration_id: "${alias}", text: "Hello" })`;
  }
  if (method.name === 'fetch') {
    return `await connections.${alias}.fetch("/v1/items", { method: "GET" })`;
  }
  if (method.name === 'query') {
    return `await connections.${alias}.query({ query: "SELECT 1 AS ok" })`;
  }
  if (method.inputSchema && typeof method.inputSchema === 'object') {
    const required = (method.inputSchema as { required?: unknown }).required;
    if (Array.isArray(required) && required.includes('query')) {
      return `await connections.${alias}.${method.name}({ query: "SELECT 1 AS ok" })`;
    }
  }
  return `await connections.${alias}.${method.name}({})`;
}

function attachMethodExamples(alias: string, methods: ConnectionMethodSummary[]): ConnectionMethodSummary[] {
  return methods.map((method) => ({
    ...method,
    example: method.example?.replace('<alias>', alias) ?? methodExample(alias, method),
  }));
}

function addNormalizedMethodAliases(
  connection: ConnectionSummary,
  methods: ConnectionMethodSummary[]
): ConnectionMethodSummary[] {
  const output = [...methods];
  const names = new Set(output.map((method) => method.name));
  const queryMethod = output.find((method) => (
    DATABASE_QUERY_TOOL_NAMES.has(method.tool) ||
    (DATABASE_QUERY_INTEGRATION_TYPES.has(connection.type) && method.name === 'executeSqlReadonly')
  ));
  if (queryMethod && !names.has('query')) {
    output.unshift({
      ...queryMethod,
      name: 'query',
      description: queryMethod.description
        ? `${queryMethod.description} Alias for ${queryMethod.name}.`
        : `Alias for ${queryMethod.name}.`,
    });
    names.add('query');
  }
  if (queryMethod && !names.has('executeQuery')) {
    output.push({
      ...queryMethod,
      name: 'executeQuery',
      description: queryMethod.description
        ? `${queryMethod.description} Alias for ${queryMethod.name}.`
        : `Alias for ${queryMethod.name}.`,
    });
  }
  return output;
}

function supportsAuthenticatedFetchConnection(connection: ConnectionSummary): boolean {
  return connection.type === 'other' || Boolean(NATIVE_HTTP_API_CONNECTIONS[connection.type]);
}

function authenticatedFetchMethods(connection: ConnectionSummary): ConnectionMethodSummary[] {
  if (
    !supportsAuthenticatedFetchConnection(connection)
  ) {
    return [];
  }
  if (connection.type === 'other' && !connection.capabilities.includes('authenticated_fetch')) {
    return [];
  }
  return [OTHER_CONNECTION_FETCH_METHOD];
}

function importedOperationMethods(record: WorkspaceIntegrationRecord): ConnectionMethodSummary[] {
  const definition = parseWorkspaceIntegrationDefinition(record.definition);
  if (!definition) return [];
  return definition.operations.map((operation) => ({
    name: operation.name,
    tool: `${IMPORTED_OPERATION_TOOL_PREFIX}${operation.id}`,
    description: operation.description ?? `${operation.method} ${operation.path}`,
    inputSchema: operation.inputSchema,
    access: operation.access,
  }));
}

function curatedOperationMethods(connection: ConnectionSummary): ConnectionMethodSummary[] {
  if (connection.type !== GOOGLE_ANALYTICS_INTEGRATION_TYPE) return [];
  return GOOGLE_ANALYTICS_METHODS.map((method) => ({ ...method }));
}

function virtualChannelMethods(connection: ConnectionSummary): ConnectionMethodSummary[] {
  if (connection.type === 'slack') {
    return [
      {
        ...SLACK_SEND_METHOD,
        example: `await tools.${SLACK_SEND_TOOL}({ integration_id: ${JSON.stringify(connection.id)}, channel_id: "C123", text: "Hello" })`,
      },
      ...SLACK_COMMON_API_METHODS,
    ];
  }
  if (connection.type === 'telegram') {
    return [{
      ...TELEGRAM_SEND_METHOD,
      example: `await tools.${TELEGRAM_SEND_TOOL}({ integration_id: ${JSON.stringify(connection.id)}, text: "Hello" })`,
    }];
  }
  if (connection.type === 'discord_channel') {
    return [{
      ...DISCORD_SEND_METHOD,
      example: `await tools.${DISCORD_SEND_TOOL}({ integration_id: ${JSON.stringify(connection.id)}, text: "Hello" })`,
    }];
  }
  return [];
}

export function resolveIntegration(records: WorkspaceIntegrationRecord[], query: string):
  | { ok: true; record: WorkspaceIntegrationRecord }
  | { ok: false; status: number; error: string; matches?: Record<string, string>[] } {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return { ok: false, status: 400, error: 'connection is required' };
  }

  const idMatch = records.find((record) => record.id.toLowerCase() === normalized);
  if (idMatch) return { ok: true, record: idMatch };

  const nameMatches = records.filter((record) => record.name.toLowerCase() === normalized);
  if (nameMatches.length === 1) return { ok: true, record: nameMatches[0]! };
  if (nameMatches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Multiple connected integrations matched "${query}". Retry with an integration id.`,
      matches: nameMatches.map(compactIntegrationRef),
    };
  }

  const typeMatches = records.filter((record) => record.integration_type.toLowerCase() === normalized);
  if (typeMatches.length === 1) return { ok: true, record: typeMatches[0]! };
  if (typeMatches.length > 1) {
    return {
      ok: false,
      status: 409,
      error: `Multiple connected integrations matched "${query}". Retry with an integration id.`,
      matches: typeMatches.map(compactIntegrationRef),
    };
  }

  return {
    ok: false,
    status: 404,
    error: `No connected integration matched "${query}"`,
    matches: records.map(compactIntegrationRef),
  };
}

export async function getWorkspaceIntegrations(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext
): Promise<WorkspaceIntegrationRecord[]> {
  const orgStub = env.ORG.get(env.ORG.idFromName(context.orgId)) as unknown as OrgDO;
  return orgStub.getWorkspaceIntegrations(context.workspaceId);
}

export async function listConnections(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext
): Promise<ConnectionSummary[]> {
  const records = await getWorkspaceIntegrations(env, context);
  return records.map((record) => summarizeConnection(record, context));
}

export async function getConnection(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string
): Promise<ConnectionSummary> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  return summarizeConnection(resolved.record, context);
}

async function invokeNativeMcpRpc(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  try {
    return await invokeConnectionMcpRpc(env, context, record, method, params);
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    const message = error instanceof Error
      ? error.message
      : `Connection ${record.name} requires reauthorization.`;
    const auth = typeof status === 'number'
      ? providerAuthStatus(status) ?? providerSetupStatus(status, message)
      : null;
    if (auth) {
      const code = auth === 'missing_scopes'
        ? 'AUTH_MISSING_SCOPES'
        : auth === 'setup_incomplete'
          ? 'AUTH_SETUP_INCOMPLETE'
          : 'AUTH_REAUTH_REQUIRED';
      await markConnectionAuthStatus(env, context, record, auth, code, message);
      throw connectionAuthError(record, context, auth, code, message, status as number);
    }
    throw error;
  }
}

export async function listConnectionTools(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string
): Promise<unknown[]> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  if (resolved.record.integration_type === 'slack') {
    return SLACK_COMMON_API_METHODS.map((method) => ({
      name: method.tool,
      description: method.description,
      inputSchema: method.inputSchema ?? {
        type: 'object',
        additionalProperties: true,
      },
    }));
  }
  const result = await invokeNativeMcpRpc(env, context, resolved.record, 'tools/list');
  const tools = (result as { tools?: unknown[] })?.tools;
  return Array.isArray(tools) ? tools : [];
}

export async function listConnectionMethods(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext
): Promise<ConnectionMethodCatalogEntry[]> {
  const records = await getWorkspaceIntegrations(env, context);
  const connections = records.map((record) => summarizeConnection(record, context));
  const usedAliases = new Set<string>();
  return Promise.all(connections.map(async (connection) => {
    const entry: ConnectionMethodCatalogEntry = {
      alias: connectionAlias(connection, usedAliases),
      connection,
      methods: [],
    };
    if (!connection.nativeMcp || connection.nativeMcp.brokered === false) {
      entry.methods = attachMethodExamples(entry.alias, addNormalizedMethodAliases(
        connection,
        [
          ...virtualChannelMethods(connection),
          ...curatedOperationMethods(connection),
          ...importedOperationMethods(records.find((record) => record.id === connection.id)!),
          ...authenticatedFetchMethods(connection),
        ]
      ));
      return entry;
    }
    try {
      const tools = await listConnectionTools(env, context, connection.id);
      entry.methods = attachMethodExamples(
        entry.alias,
        addNormalizedMethodAliases(
          connection,
          tools
            .map(toolToMethod)
            .filter((method): method is ConnectionMethodSummary => method !== null)
        )
      );
    } catch (error) {
      entry.error = {
        message: error instanceof Error ? error.message : String(error),
        code: (error as { code?: unknown })?.code,
        data: (error as { data?: unknown })?.data,
      };
    }
    return entry;
  }));
}

function compactCatalogEntry(entry: ConnectionMethodCatalogEntry): Record<string, unknown> {
  return {
    alias: entry.alias,
    id: entry.connection.id,
    type: entry.connection.type,
    name: entry.connection.name,
  };
}

function findCatalogMatches(
  catalog: ConnectionMethodCatalogEntry[],
  query: ConnectionFindQuery
): ConnectionMethodCatalogEntry[] {
  if (typeof query === 'string') {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return catalog.filter((entry) => (
      entry.alias.toLowerCase() === normalized ||
      entry.connection.id.toLowerCase() === normalized ||
      entry.connection.name.toLowerCase() === normalized ||
      entry.connection.type.toLowerCase() === normalized
    ));
  }

  const id = query.id?.trim().toLowerCase();
  const alias = query.alias?.trim().toLowerCase();
  const type = query.type?.trim().toLowerCase();
  const name = query.name?.trim().toLowerCase();
  return catalog.filter((entry) => (
    (!id || entry.connection.id.toLowerCase() === id) &&
    (!alias || entry.alias.toLowerCase() === alias) &&
    (!type || entry.connection.type.toLowerCase() === type) &&
    (!name || entry.connection.name.toLowerCase() === name)
  ));
}

export async function findConnectionMethodEntry(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  query: ConnectionFindQuery
): Promise<ConnectionMethodCatalogEntry> {
  const catalog = await listConnectionMethods(env, context);
  const matches = findCatalogMatches(catalog, query);
  const label = typeof query === 'string' ? query : JSON.stringify(query);
  if (matches.length === 0) {
    throw Object.assign(new Error(`No connected integration matched ${label}`), {
      status: 404,
      matches: catalog.map(compactCatalogEntry),
    });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error(`Multiple connected integrations matched ${label}. Retry with a connection alias or id.`), {
      status: 409,
      matches: matches.map(compactCatalogEntry),
    });
  }
  return matches[0]!;
}

export async function testConnectionMethodEntry(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  query: ConnectionFindQuery
): Promise<ConnectionSmokeTestResult> {
  const entry = await findConnectionMethodEntry(env, context, query);
  if (entry.error) {
    const authStatus = (entry.error.data as { authStatus?: unknown } | undefined)?.authStatus;
    throw Object.assign(new Error(entry.error.message), {
      status: entry.error.code === 'AUTH_SETUP_INCOMPLETE'
        ? 400
        : authStatus === 'needs_reauth' || authStatus === 'missing_scopes'
          ? 401
          : 502,
      code: entry.error.code,
      data: entry.error.data,
    });
  }

  const queryMethod = entry.methods.find((method) => method.name === 'query');
  if (queryMethod) {
    return {
      ok: true,
      alias: entry.alias,
      connection: entry.connection,
      method: queryMethod.name,
      result: await invokeConnectionMethod(env, context, {
        connection: entry.alias,
        method: queryMethod.name,
        input: { query: 'SELECT 1 AS ok' },
      }),
    };
  }

  return {
    ok: true,
    alias: entry.alias,
    connection: entry.connection,
    method: entry.methods[0]?.name ?? null,
  };
}

function verificationStatusForAuth(
  status: WorkspaceIntegrationAuthStatus,
): ConnectionVerificationStatus | null {
  if (status === 'connected') return null;
  if (status === 'needs_reauth' || status === 'missing_scopes') return 'needs_authorization';
  if (status === 'setup_incomplete') return 'misconfigured';
  return 'degraded';
}

function verificationFailureStatus(error: unknown): ConnectionVerificationStatus {
  const status = (error as { status?: unknown })?.status;
  if (status === 401 || status === 403) return 'needs_authorization';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'misconfigured';
  return 'degraded';
}

export async function verifyConnection(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  query: ConnectionFindQuery,
): Promise<ConnectionVerificationResult> {
  const startedAt = Date.now();
  const records = await getWorkspaceIntegrations(env, context);
  const usedAliases = new Set<string>();
  const verificationCatalog = records.map((candidate) => {
    const connection = summarizeConnection(candidate, context);
    return {
      alias: connectionAlias(connection, usedAliases),
      connection,
      methods: [],
    } satisfies ConnectionMethodCatalogEntry;
  });
  const matches = findCatalogMatches(verificationCatalog, query);
  const label = typeof query === 'string' ? query : JSON.stringify(query);
  if (matches.length === 0) {
    throw Object.assign(new Error(`No connected integration matched ${label}`), {
      status: 404,
      matches: verificationCatalog.map(compactCatalogEntry),
    });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error(`Multiple connected integrations matched ${label}. Retry with a connection alias or id.`), {
      status: 409,
      matches: matches.map(compactCatalogEntry),
    });
  }
  const entry = matches[0]!;
  const record = records.find((candidate) => candidate.id === entry.connection.id);
  if (!record) {
    throw Object.assign(new Error('Connection disappeared while it was being verified.'), { status: 404 });
  }

  const finish = async (
    status: ConnectionVerificationStatus,
    message: string,
    method?: string,
  ): Promise<ConnectionVerificationResult> => {
    const checkedAtMs = Date.now();
    const checkedAt = new Date(checkedAtMs).toISOString();
    const persisted = await persistConnectionVerification(env, context, record, {
      status,
      message,
      live: entry.connection.contract.verification.live,
      strategy: entry.connection.contract.verification.strategy,
      checkedAtMs,
    });
    const effectiveStatus = persisted ? status : 'unknown';
    const effectiveMessage = persisted
      ? message
      : 'The connection changed while verification was running. Verify it again.';
    const verification: ConnectionVerificationResult = {
      ok: persisted && (status === 'ready' || status === 'configured'),
      status: effectiveStatus,
      checkedAt,
      live: entry.connection.contract.verification.live,
      strategy: entry.connection.contract.verification.strategy,
      message: effectiveMessage,
      connection: {
        ...entry.connection,
        verification: {
          status: effectiveStatus,
          message: effectiveMessage,
          checkedAt,
          live: entry.connection.contract.verification.live,
          strategy: entry.connection.contract.verification.strategy,
        },
      },
      ...(method ? { method } : {}),
    };
    recordObservabilityEvent(env, {
      event: 'connection_verification',
      component: 'connections-runtime',
      operation: verification.strategy,
      status: effectiveStatus,
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      userId: context.userId,
      provider: record.integration_type,
      durationMs: Date.now() - startedAt,
      sampleIndex: record.id,
    });
    return verification;
  };

  const authProblem = verificationStatusForAuth(authStatus(record));
  if (authProblem) {
    return finish(
      authProblem,
      record.auth_error_message || (
        authProblem === 'needs_authorization'
          ? 'This connection needs authorization.'
          : 'This connection is not fully configured.'
      ),
    );
  }

  try {
    const strategy = entry.connection.contract.verification.strategy;
    let method: string | undefined;

    if (strategy === 'database_query') {
      method = 'execute_sql_readonly';
      await invokeConnectionMcpRpc(env, context, record, 'tools/call', {
        name: method,
        arguments: { query: 'SELECT 1 AS ok' },
      });
    } else if (strategy === 'slack_auth') {
      method = 'auth.test';
      await callSlackConnectionTool(env, context, record.id, SLACK_API_TOOL, {
        method,
        params: {},
        http_method: 'POST',
      });
    } else if (strategy === 'curated_api') {
      method = 'list_properties';
      await callGoogleAnalyticsConnectionTool(env, context, record.id, method, {});
    } else if (strategy === 'mcp_discovery') {
      const probe = getHostedConnectionVerificationProbe(record.integration_type);
      if (probe) {
        method = probe.tool;
        await invokeConnectionMcpRpc(env, context, record, 'tools/call', {
          name: probe.tool,
          arguments: probe.input ?? {},
        });
      } else {
        method = 'tools/list';
        await invokeConnectionMcpRpc(env, context, record, method);
      }
    } else if (strategy === 'telegram_setup') {
      if (!hasTelegramDefaultRecipient(parseJsonObject(record.config))) {
        return finish('misconfigured', 'Choose a default Telegram chat before using this connection.');
      }
    } else if (strategy === 'discord_channel_access') {
      method = 'discord_channel_access';
      if (!discordChannelEnabled(env)) {
        return finish('degraded', 'Discord channels are unavailable in this environment.', method);
      }
      const config = parseDiscordChannelConfig(record.config || '{}');
      if (!config) {
        return finish('misconfigured', 'Discord connection configuration is invalid.', method);
      }
      const discord = discordBridgeClient(env.DISCORD_BRIDGE);
      const [bridgeStatus, verification] = await Promise.all([
        discord.status(),
        discord.verifyBinding<ConnectionVerificationStatus>(record.id),
      ]);
      if (
        bridgeStatus.applicationId !== env.DISCORD_CLIENT_ID ||
        !bridgeStatus.botUserId ||
        bridgeStatus.botUserId !== bridgeStatus.applicationId
      ) {
        return finish('misconfigured', 'Discord application identity does not match the connected bot.', method);
      }
      if (!bridgeStatus.readiness.ready) {
        return finish('degraded', bridgeStatus.readiness.message, method);
      }
      const binding = verification.binding;
      if (
        !binding ||
        binding.integrationId !== record.id ||
        binding.orgId !== context.orgId ||
        binding.workspaceId !== context.workspaceId
      ) {
        return finish('misconfigured', 'Discord channel binding does not belong to this connection.', method);
      }
      return finish(
        verification.status,
        verification.message || 'Discord verification completed.',
        method,
      );
    } else if (strategy === 'http_configuration') {
      const provider = NATIVE_HTTP_API_CONNECTIONS[record.integration_type];
      if (provider) {
        requireNativeProviderUrl(provider);
      } else {
        requireConfiguredUrl(parseJsonObject(record.config).base_url, 'base_url');
      }
    }

    await markConnectionAuthStatus(env, context, record, 'connected', '', '');
    return finish(
      entry.connection.contract.verification.live ? 'ready' : 'configured',
      entry.connection.contract.verification.live
        ? 'Connection verified successfully.'
        : 'Connection configuration is valid. This adapter does not make a network request during verification.',
      method,
    );
  } catch (error) {
    const status = verificationFailureStatus(error);
    const message = error instanceof Error ? error.message : String(error);
    const upstreamStatus = (error as { status?: unknown })?.status;
    if (typeof upstreamStatus === 'number') {
      const authProblem = providerAuthStatus(upstreamStatus) ?? providerSetupStatus(upstreamStatus, message);
      if (authProblem) {
        await markConnectionAuthStatus(
          env,
          context,
          record,
          authProblem,
          authProblem === 'missing_scopes'
            ? 'AUTH_MISSING_SCOPES'
            : authProblem === 'setup_incomplete'
              ? 'AUTH_SETUP_INCOMPLETE'
              : 'AUTH_REAUTH_REQUIRED',
          message,
        );
      }
    }
    return finish(status, message);
  }
}

type ConnectionInvocationDiagnostics = {
  provider?: string;
};

function connectionInvocationStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
      return value;
    }
  }
  return null;
}

function connectionInvocationDiagnosticError(error: unknown, statusCode: number | null): Error {
  const sourceName = error instanceof Error ? error.name : '';
  let name = 'ConnectionRuntimeError';
  if (statusCode === 401 || statusCode === 403) {
    name = 'ConnectionAuthError';
  } else if (statusCode === 408 || statusCode === 504 || sourceName === 'AbortError') {
    name = 'ConnectionTimeoutError';
  } else if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    name = 'ConnectionRequestError';
  } else if (statusCode !== null && statusCode >= 500) {
    name = 'ConnectionUpstreamError';
  } else if (/^[A-Za-z][A-Za-z0-9]*Error$/.test(sourceName)) {
    name = sourceName;
  }

  // Provider errors can echo query text or request payloads. Emit only a stable,
  // aggregate-friendly class; the original error still propagates to the caller.
  const diagnostic = new Error('Connection invocation failed');
  diagnostic.name = name;
  diagnostic.stack = '';
  return diagnostic;
}

export async function invokeConnectionMethod(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  request: ConnectionInvokeRequest
): Promise<unknown> {
  const startedAt = Date.now();
  const diagnostics: ConnectionInvocationDiagnostics = {};
  try {
    const result = await invokeConnectionMethodInternal(env, context, request, diagnostics);
    recordObservabilityEvent(env, {
      event: 'connection_invocation',
      component: 'connections-runtime',
      operation: typeof request.method === 'string' ? request.method : 'unknown',
      status: 'success',
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      userId: context.userId,
      threadId: context.threadId,
      requestId: context.requestId,
      provider: diagnostics.provider,
      durationMs: Date.now() - startedAt,
      sampleIndex: context.workspaceId,
    });
    return result;
  } catch (error) {
    const statusCode = connectionInvocationStatusCode(error);
    recordErrorEvent(env, {
      event: 'connection_invocation',
      component: 'connections-runtime',
      operation: typeof request.method === 'string' ? request.method : 'unknown',
      status: 'error',
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      userId: context.userId,
      threadId: context.threadId,
      requestId: context.requestId,
      provider: diagnostics.provider,
      durationMs: Date.now() - startedAt,
      statusCode,
      sampleIndex: context.workspaceId,
      error: connectionInvocationDiagnosticError(error, statusCode),
    });
    throw error;
  }
}

async function invokeConnectionMethodInternal(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  request: ConnectionInvokeRequest,
  diagnostics: ConnectionInvocationDiagnostics,
): Promise<unknown> {
  const method = typeof request.method === 'string' ? request.method : '';
  if (!method.trim()) {
    throw Object.assign(new Error('method is required'), { status: 400 });
  }

  const target = await findConnectionMethodEntry(env, context, request.connection);
  diagnostics.provider = target.connection.type;
  if (target.error) {
    const authStatus = (target.error.data as { authStatus?: unknown } | undefined)?.authStatus;
    throw Object.assign(new Error(target.error.message), {
      status: target.error.code === 'AUTH_SETUP_INCOMPLETE'
        ? 400
        : authStatus === 'needs_reauth' || authStatus === 'missing_scopes'
          ? 401
          : 502,
      code: target.error.code,
      data: target.error.data,
    });
  }
  const targetMethod = target.methods.find((candidate) => (
    candidate.name === method || candidate.tool === method
  ));
  if (!targetMethod) {
    throw Object.assign(new Error(`No method "${method}" exists on connection "${target.alias}"`), {
      status: 404,
      methods: target.methods,
    });
  }
  const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
    ? request.input as Record<string, unknown>
    : {};

  if (
    targetMethod.tool === OTHER_CONNECTION_FETCH_TOOL &&
    supportsAuthenticatedFetchConnection(target.connection)
  ) {
    return callAuthenticatedConnectionFetch(env, context, target.connection.id, request.input);
  }
  if (targetMethod.tool.startsWith(IMPORTED_OPERATION_TOOL_PREFIX)) {
    return callImportedIntegrationOperation(
      env,
      context,
      target.connection.id,
      targetMethod.tool.slice(IMPORTED_OPERATION_TOOL_PREFIX.length),
      input,
    );
  }
  if (target.connection.type === GOOGLE_ANALYTICS_INTEGRATION_TYPE) {
    return callGoogleAnalyticsConnectionTool(
      env,
      context,
      target.connection.id,
      targetMethod.tool,
      input,
    );
  }
  if (target.connection.type === 'slack' && targetMethod.tool === SLACK_SEND_TOOL) {
    throw Object.assign(
      new Error(
        `Slack send is available in js_exec as tools.${SLACK_SEND_TOOL}(...), not as connections.${target.alias}.${targetMethod.name}(...). Use the method catalog example: await tools.${SLACK_SEND_TOOL}({ integration_id: ${JSON.stringify(target.connection.id)}, channel_id: "C123", text: "Hello" })`
      ),
      { status: 400 }
    );
  }
  if (target.connection.type === 'slack') {
    return callSlackConnectionTool(env, context, target.connection.id, targetMethod.tool, input);
  }
  if (target.connection.type === 'telegram' && targetMethod.tool === TELEGRAM_SEND_TOOL) {
    throw Object.assign(
      new Error(
        `Telegram send is available in js_exec as tools.${TELEGRAM_SEND_TOOL}(...), not as connections.${target.alias}.${targetMethod.name}(...). Use the method catalog example: await tools.${TELEGRAM_SEND_TOOL}({ integration_id: ${JSON.stringify(target.connection.id)}, text: "Hello" })`
      ),
      { status: 400 }
    );
  }
  if (target.connection.type === 'discord_channel' && targetMethod.tool === DISCORD_SEND_TOOL) {
    throw Object.assign(
      new Error(
        `Discord send is available in js_exec as tools.${DISCORD_SEND_TOOL}(...), not as connections.${target.alias}.${targetMethod.name}(...). Use the method catalog example: await tools.${DISCORD_SEND_TOOL}({ integration_id: ${JSON.stringify(target.connection.id)}, text: "Hello" })`
      ),
      { status: 400 }
    );
  }

  return callConnectionTool(env, context, target.connection.id, targetMethod.tool, input);
}

async function callAuthenticatedConnectionFetch(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  input: unknown
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  const record = resolved.record;
  const nativeProvider = NATIVE_HTTP_API_CONNECTIONS[record.integration_type];
  if (record.integration_type !== 'other' && !nativeProvider) {
    throw Object.assign(new Error(`Connection "${record.name}" does not support authenticated fetch.`), { status: 400 });
  }

  const config = parseJsonObject(record.config);
  const baseUrl = nativeProvider
    ? requireNativeProviderUrl(nativeProvider)
    : requireConfiguredUrl(config.base_url, 'base_url');
  const request = normalizeOtherFetchInput(input);
  const requestUrl = resolveOtherFetchUrl(baseUrl, request.input, nativeProvider);
  if (
    !nativeProvider &&
    config.restrict_to_base_origin === true &&
    requestUrl.origin !== baseUrl.origin
  ) {
    throw Object.assign(
      new Error(`This imported API connection only allows requests to ${baseUrl.origin}.`),
      { status: 400 },
    );
  }

  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const method = otherFetchMethod(request.init.method);
  const headers = otherFetchHeaders(request.init.headers);
  if (nativeProvider) {
    await applyNativeHttpAuth(env, context, record, nativeProvider, headers, credentials);
  } else {
    await applyOtherAuth(env, context, record, headers, config, credentials);
  }

  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && Object.prototype.hasOwnProperty.call(request.init, 'body')) {
    const body = request.init.body;
    if (typeof body === 'string') {
      init.body = body;
    } else if (body !== undefined) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      init.body = JSON.stringify(body);
    }
  }

  const response = config.restrict_to_base_origin === true
    ? await fetchPinnedOrigin(requestUrl, init, baseUrl.origin)
    : await fetch(requestUrl, init);
  // Self-heal stale auth status: a successful authenticated fetch proves the
  // connection is usable again, so clear a previously recorded setup/reauth
  // problem. This covers config-only fixes (e.g. switching an "other" connection
  // to auth_type "none", correcting base_url, or fixing the header name) that do
  // not rewrite credentials and therefore would otherwise leave the connection
  // stuck looking broken in the connections UI. Skip on upstream auth-failure
  // responses, where credentials were applied but rejected.
  if (
    record.auth_status &&
    record.auth_status !== 'connected' &&
    response.status !== 401 &&
    response.status !== 403
  ) {
    await markConnectionAuthStatus(env, context, record, 'connected', '', '');
  }
  const responseBody = await boundedResponseText(response, OTHER_CONNECTION_RESPONSE_LIMIT);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeadersObject(response.headers),
    bodyText: responseBody.text,
    truncated: responseBody.truncated,
  };
}

async function fetchPinnedOrigin(url: URL, init: RequestInit, allowedOrigin: string): Promise<Response> {
  let requestUrl = url;
  let requestInit = { ...init, redirect: 'manual' as const };
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(requestUrl, requestInit);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === 5) {
      throw Object.assign(new Error('Imported API request exceeded the redirect limit.'), { status: 502 });
    }
    const nextUrl = new URL(location, requestUrl);
    if (nextUrl.origin !== allowedOrigin) {
      throw Object.assign(
        new Error(`Imported API redirect was blocked because it left ${allowedOrigin}.`),
        { status: 400 },
      );
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && requestInit.method === 'POST')
    ) {
      requestInit = { ...requestInit, method: 'GET', body: undefined };
    }
    requestUrl = nextUrl;
  }
  throw Object.assign(new Error('Imported API request could not resolve its redirect.'), { status: 502 });
}

async function callImportedIntegrationOperation(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  operationId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  const record = resolved.record;
  const definition = parseWorkspaceIntegrationDefinition(record.definition);
  const operation = definition?.operations.find((candidate) => candidate.id === operationId);
  if (!definition || !operation) {
    throw Object.assign(new Error(`Imported operation "${operationId}" was not found.`), { status: 404 });
  }
  const config = parseJsonObject(record.config);
  if (operation.access === 'write' && config.operation_policy !== 'all') {
    throw Object.assign(
      new Error(
        `Operation "${operation.name}" is classified as write access. Enable write operations in the connection settings before invoking it.`,
      ),
      { status: 403, code: 'CONNECTION_POLICY_BLOCKED' },
    );
  }
  const requestPath = renderOperationPath(operation, input.path);
  const url = requestPath
    ? new URL(`${definition.baseUrl.replace(/\/$/, '')}/${requestPath.replace(/^\//, '')}`)
    : new URL(definition.baseUrl);
  if (input.query && typeof input.query === 'object' && !Array.isArray(input.query)) {
    for (const [key, value] of Object.entries(input.query as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return callAuthenticatedConnectionFetch(env, context, record.id, {
    input: url.toString(),
    init: {
      method: operation.method,
      ...(Object.prototype.hasOwnProperty.call(input, 'body') ? { body: input.body } : {}),
    },
  });
}

function renderOperationPath(operation: IntegrationOperationDefinition, rawPath: unknown): string {
  const pathValues = rawPath && typeof rawPath === 'object' && !Array.isArray(rawPath)
    ? rawPath as Record<string, unknown>
    : {};
  return operation.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = pathValues[key];
    if (value === undefined || value === null || value === '') {
      throw Object.assign(new Error(`Operation "${operation.name}" requires path.${key}.`), { status: 400 });
    }
    return encodeURIComponent(String(value));
  });
}

async function callGoogleAnalyticsConnectionTool(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  const record = resolved.record;
  try {
    const result = await googleAnalyticsTool(env, record, tool, input);
    if (record.auth_status && record.auth_status !== 'connected') {
      await markConnectionAuthStatus(env, context, record, 'connected', '', '');
    }
    return result;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401 || status === 403) {
      const auth = status === 403 ? 'missing_scopes' : 'needs_reauth';
      const code = status === 403 ? 'AUTH_MISSING_SCOPES' : 'AUTH_REAUTH_REQUIRED';
      const message = error instanceof Error ? error.message : 'Google Analytics authorization failed.';
      await markConnectionAuthStatus(env, context, record, auth, code, message);
      throw connectionAuthError(record, context, auth, code, message, status);
    }
    throw error;
  }
}

async function callSlackConnectionTool(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  tool: string,
  input: Record<string, unknown> = {}
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  const record = resolved.record;
  if (record.integration_type !== 'slack') {
    throw Object.assign(new Error(`Connection "${record.name}" is not a Slack connection.`), { status: 400 });
  }

  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = typeof credentials.access_token === 'string'
    ? credentials.access_token.trim()
    : '';
  if (!token) {
    throw Object.assign(new Error(`Slack connection "${record.name}" does not have a bot access token.`), { status: 400 });
  }

  const request = slackApiRequestForTool(tool, input);
  return callSlackWebApi(token, request);
}

function slackApiRequestForTool(
  tool: string,
  input: Record<string, unknown>
): { method: string; params: Record<string, unknown>; httpMethod: 'GET' | 'POST'; encoding: 'json' | 'form' } {
  if (tool === SLACK_API_TOOL) {
    const method = typeof input.method === 'string' && input.method.trim()
      ? input.method.trim()
      : typeof input.api_method === 'string' && input.api_method.trim()
        ? input.api_method.trim()
        : '';
    const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
      ? input.params as Record<string, unknown>
      : {};
    return {
      method,
      params,
      httpMethod: slackHttpMethod(input.http_method),
      encoding: slackEncoding(input.encoding),
    };
  }

  const defaults: Record<string, { method: string; params?: Record<string, unknown>; httpMethod?: 'GET' | 'POST' }> = {
    list_slack_channels: {
      method: 'conversations.list',
      params: { types: 'public_channel,private_channel', exclude_archived: true, limit: 100 },
    },
    list_slack_users: {
      method: 'users.list',
      params: { limit: 100 },
    },
    get_slack_channel_history: {
      method: 'conversations.history',
      params: { limit: 20 },
    },
    get_slack_thread_replies: {
      method: 'conversations.replies',
      params: { limit: 20 },
    },
    update_slack_message: { method: 'chat.update' },
    delete_slack_message: { method: 'chat.delete' },
    add_slack_reaction: { method: 'reactions.add' },
  };
  const mapped = defaults[tool];
  if (!mapped) {
    throw Object.assign(new Error(`Unsupported Slack connection tool: ${tool}`), { status: 404 });
  }
  return {
    method: mapped.method,
    params: { ...mapped.params, ...input },
    httpMethod: mapped.httpMethod ?? 'POST',
    encoding: 'json',
  };
}

function slackHttpMethod(value: unknown): 'GET' | 'POST' {
  const method = typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase()
    : 'POST';
  if (method === 'GET' || method === 'POST') return method;
  throw Object.assign(new Error(`Unsupported Slack API HTTP method: ${method}`), { status: 400 });
}

function slackEncoding(value: unknown): 'json' | 'form' {
  const encoding = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : 'json';
  if (encoding === 'json' || encoding === 'form') return encoding;
  throw Object.assign(new Error(`Unsupported Slack API encoding: ${encoding}`), { status: 400 });
}

async function callSlackWebApi(
  token: string,
  request: { method: string; params: Record<string, unknown>; httpMethod: 'GET' | 'POST'; encoding: 'json' | 'form' }
): Promise<unknown> {
  const method = normalizeSlackApiMethod(request.method);
  const url = new URL(`https://slack.com/api/${method}`);
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  const init: RequestInit = { method: request.httpMethod, headers };

  if (request.httpMethod === 'GET') {
    for (const [key, value] of Object.entries(request.params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, slackParamValue(value));
    }
  } else if (request.encoding === 'form') {
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(request.params)) {
      if (value === undefined || value === null) continue;
      body.set(key, slackParamValue(value));
    }
    init.body = body;
  } else {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    init.body = JSON.stringify(request.params);
  }

  const response = await fetch(url, init);
  const responseJson = await response.json().catch(() => null) as {
    ok?: boolean;
    error?: string;
    [key: string]: unknown;
  } | null;
  if (!response.ok || responseJson?.ok !== true) {
    throw Object.assign(
      new Error(`Slack API ${method} failed: ${responseJson?.error || response.statusText}`),
      { status: response.ok ? 400 : response.status }
    );
  }
  return responseJson;
}

function normalizeSlackApiMethod(value: string): string {
  const method = value.trim().replace(/^\/?api\//, '');
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(method)) {
    throw Object.assign(
      new Error('Slack API method must look like conversations.list or chat.update.'),
      { status: 400 }
    );
  }
  return method;
}

function slackParamValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function requireConfiguredUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`Custom API connection is missing ${field}.`), { status: 400 });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error(`${field} must be a valid URL.`), { status: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error(`${field} must use http or https.`), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error(`${field} must not include embedded credentials.`), { status: 400 });
  }
  return url;
}

function requireNativeProviderUrl(provider: NativeHttpApiConnection): URL {
  try {
    return new URL(provider.baseUrl);
  } catch {
    throw Object.assign(new Error(`${provider.displayName} API base URL is invalid.`), { status: 500 });
  }
}

function normalizeOtherFetchInput(input: unknown): { input: string; init: Record<string, unknown> } {
  if (typeof input === 'string') {
    return { input, init: {} };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('fetch input must be a URL string or { input, init } object.'), {
      status: 400,
    });
  }
  const record = input as Record<string, unknown>;
  if (typeof record.input !== 'string') {
    throw Object.assign(new Error('fetch input.input must be a URL string.'), { status: 400 });
  }
  const init = record.init === undefined
    ? {}
    : record.init && typeof record.init === 'object' && !Array.isArray(record.init)
      ? record.init as Record<string, unknown>
      : null;
  if (!init) {
    throw Object.assign(new Error('fetch input.init must be an object when provided.'), { status: 400 });
  }
  return { input: record.input, init };
}

function resolveOtherFetchUrl(baseUrl: URL, input: unknown, nativeProvider?: NativeHttpApiConnection): URL {
  if (typeof input !== 'string' || !input.trim()) {
    throw Object.assign(new Error('fetch input is required'), { status: 400 });
  }
  const pathValue = input.trim();
  let requestUrl: URL;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathValue)) {
      requestUrl = new URL(pathValue);
    } else {
      const relativeBase = new URL(baseUrl.toString());
      if (!relativeBase.pathname.endsWith('/')) relativeBase.pathname += '/';
      requestUrl = new URL(pathValue, relativeBase);
    }
  } catch {
    throw Object.assign(new Error('fetch input must be a relative path or valid URL.'), { status: 400 });
  }
  if (requestUrl.protocol !== 'https:' && requestUrl.protocol !== 'http:') {
    const label = nativeProvider ? nativeProvider.displayName : 'Custom API';
    throw Object.assign(new Error(`${label} fetch input must use http or https.`), { status: 400 });
  }
  // TODO: Restrict custom API fetches to trusted domains from the connection
  // configuration once existing plaintext-env usage has fully migrated.
  if (requestUrl.username || requestUrl.password) {
    throw Object.assign(new Error('fetch input must not include embedded credentials.'), { status: 400 });
  }
  if (nativeProvider && requestUrl.origin !== baseUrl.origin) {
    throw Object.assign(
      new Error(`${nativeProvider.displayName} fetch input must resolve to ${baseUrl.origin}.`),
      { status: 400 }
    );
  }
  return requestUrl;
}

function otherFetchMethod(value: unknown): string {
  const method = typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
    throw Object.assign(new Error(`Unsupported custom API request method: ${method}`), { status: 400 });
  }
  return method;
}

function otherFetchHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (value === undefined || value === null) return headers;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('headers must be an object when provided.'), { status: 400 });
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || ['authorization', 'proxy-authorization', 'host', 'content-length'].includes(normalized)) {
      continue;
    }
    if (typeof item !== 'string') {
      throw Object.assign(new Error(`headers.${key} must be a string.`), { status: 400 });
    }
    headers.set(key, item);
  }
  return headers;
}

function credentialString(credentials: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = credentials[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

async function applyNativeHttpAuth(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  provider: NativeHttpApiConnection,
  headers: Headers,
  credentials: Record<string, unknown>
): Promise<void> {
  const token = credentialString(credentials, ...provider.credentialKeys)?.trim();
  if (!token) {
    const message = `${provider.displayName} connection "${record.name}" requires ${provider.credentialKeys[0]}.`;
    const code = 'AUTH_SETUP_INCOMPLETE';
    await markConnectionAuthStatus(env, context, record, 'setup_incomplete', code, message);
    throw connectionAuthError(record, context, 'setup_incomplete', code, message, 400);
  }

  for (const [key, value] of Object.entries(provider.defaultHeaders ?? {})) {
    headers.set(key, value);
  }

  switch (provider.authHeader) {
    case 'bearer':
      headers.set('authorization', `Bearer ${token}`);
      return;
  }
}

async function applyOtherAuth(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  headers: Headers,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>
): Promise<void> {
  const authType = typeof config.auth_type === 'string' && config.auth_type.trim()
    ? config.auth_type.trim().toLowerCase()
    : 'bearer';
  // Mirror native HTTP providers: when an "other" connection is missing the
  // credentials its configured auth_type needs, flag it as setup_incomplete so
  // the connections UI surfaces the problem instead of failing opaquely later.
  const setupIncomplete = async (message: string): Promise<Error> => {
    const code = 'AUTH_SETUP_INCOMPLETE';
    await markConnectionAuthStatus(env, context, record, 'setup_incomplete', code, message);
    return connectionAuthError(record, context, 'setup_incomplete', code, message, 400);
  };
  switch (authType) {
    case 'none':
      return;
    case 'bearer': {
      const token = credentialString(credentials, 'api_key', 'access_token', 'token');
      if (!token) throw await setupIncomplete(`Custom API connection "${record.name}" requires api_key for bearer auth.`);
      headers.set('authorization', `Bearer ${token}`);
      return;
    }
    case 'basic': {
      const username = credentialString(credentials, 'client_id', 'username', 'api_key');
      const password = credentialString(credentials, 'client_secret', 'password', 'api_secret');
      if (!username || !password) {
        throw await setupIncomplete(`Custom API connection "${record.name}" requires username/client_id and password/client_secret for basic auth.`);
      }
      headers.set('authorization', `Basic ${btoa(`${username}:${password}`)}`);
      return;
    }
    case 'header': {
      const headerName = typeof config.auth_header === 'string' && config.auth_header.trim()
        ? config.auth_header.trim()
        : 'X-API-Key';
      const token = credentialString(credentials, 'api_key', 'access_token', 'token');
      if (!token) throw await setupIncomplete(`Custom API connection "${record.name}" requires api_key for custom header auth.`);
      headers.set(headerName, token);
      return;
    }
    default:
      throw Object.assign(new Error(`Unsupported custom API auth_type: ${authType}`), { status: 400 });
  }
}

async function boundedResponseText(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const decoder = new TextDecoder();
  let text = '';
  let truncated = false;
  while (text.length < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > limit) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return {
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated,
  };
}

function responseHeadersObject(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') return;
    output[key] = value;
  });
  return output;
}

export async function callConnectionTool(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  connection: string,
  tool: string,
  input: Record<string, unknown> = {}
): Promise<unknown> {
  const records = await getWorkspaceIntegrations(env, context);
  const resolved = resolveIntegration(records, connection);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), {
      status: resolved.status,
      matches: resolved.matches,
    });
  }
  if (resolved.record.integration_type === 'slack') {
    return callSlackConnectionTool(env, context, resolved.record.id, tool, input);
  }
  return invokeNativeMcpRpc(env, context, resolved.record, 'tools/call', {
    name: tool,
    arguments: input,
  });
}

export async function invokeConnectionMcpRpc(
  env: ConnectionsRuntimeEnv,
  context: ConnectionsContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const config = parseJsonObject(record.config);
  const nativeDefinition = mcpDefinitionForRecord(record, config);
  if (!nativeDefinition) {
    throw Object.assign(
      new Error(`Connection type "${record.integration_type}" does not have MCP-backed tools.`),
      { status: 404 }
    );
  }
  const hostedAdapter = getHostedConnectionAdapter(record.integration_type);
  if (hostedAdapter) return hostedAdapter(env, context, record, method, params);

  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const authHeaders = mcpAuthHeaders(record, config, credentials);
  if (!authHeaders.ok) {
    const status = record.auth_method === 'oauth2' || isRemoteMcpOAuth(record, config)
      ? 'needs_reauth'
      : 'setup_incomplete';
    const code = status === 'needs_reauth' ? 'AUTH_REAUTH_REQUIRED' : 'AUTH_SETUP_INCOMPLETE';
    const message = authHeaders.error;
    await markConnectionAuthStatus(env, context, record, status, code, message);
    throw connectionAuthError(
      record,
      context,
      status,
      code,
      message,
      status === 'needs_reauth' ? 401 : 400
    );
  }

  const sessionId = await nativeMcpHttp(nativeDefinition, authHeaders.headers, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: {
      name: 'camelai-connections',
      version: '1.0.0',
    },
  }).then((result) => result.sessionId);

  return nativeMcpHttp(nativeDefinition, authHeaders.headers, method, params, sessionId)
    .then((result) => result.result);
}

function mcpAuthHeaders(
  record: WorkspaceIntegrationRecord,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>
): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (record.integration_type === 'remote_mcp') {
    const authType = typeof config.auth_type === 'string' ? config.auth_type : 'none';
    if (authType === 'none') return { ok: true, headers: {} };

    const token = authType === 'oauth'
      ? (typeof credentials.access_token === 'string' ? credentials.access_token.trim() : '')
      : (typeof credentials.token === 'string' ? credentials.token.trim() : '');
    if (!token) {
      return {
        ok: false,
        error: authType === 'oauth'
          ? `Remote MCP connection "${record.name}" needs OAuth authorization.`
          : `Remote MCP connection "${record.name}" requires a token for ${authType} authentication.`,
      };
    }
    if (authType === 'custom_header') {
      const headerName = typeof config.auth_header === 'string' ? config.auth_header.trim() : '';
      if (!headerName) {
        return {
          ok: false,
          error: `Remote MCP connection "${record.name}" is missing a custom auth header name.`,
        };
      }
      return { ok: true, headers: { [headerName]: token } };
    }
    return { ok: true, headers: { authorization: `Bearer ${token}` } };
  }

  const token = credentialToken(credentials);
  if (!token) {
    return {
      ok: false,
      error: `Connected ${record.integration_type} integration does not have a usable token credential for MCP proxying.`,
    };
  }
  return { ok: true, headers: { authorization: `Bearer ${token}` } };
}

export const NATIVE_MCP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function readBoundedMcpResponseText(
  response: Response,
  maxBytes = NATIVE_MCP_MAX_RESPONSE_BYTES,
): Promise<string> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    response.body?.cancel().catch(() => undefined);
    throw Object.assign(
      new Error(`Native MCP response exceeded ${limit} byte limit`),
      { status: 502 },
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(
          new Error(`Native MCP response exceeded ${limit} byte limit`),
          { status: 502 },
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function nativeMcpHttp(
  definition: ProviderMcpDefinition,
  authHeaders: Record<string, string>,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string | null
): Promise<{ result: unknown; sessionId: string | null }> {
  const headers: Record<string, string> = {
    ...authHeaders,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-06-18',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NATIVE_MCP_HTTP_TIMEOUT_MS);
  let response!: Response;
  let text = '';
  try {
    response = await fetch(definition.url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });
    text = await readBoundedMcpResponseText(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(
        new Error(`Native MCP ${method} request timed out after ${NATIVE_MCP_HTTP_TIMEOUT_MS}ms`),
        { status: 504 }
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const payload = parseNativePayload(text);
  if (!response.ok) {
    const message = extractMcpError(payload) || `Native MCP request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  const error = extractMcpError(payload);
  if (error) {
    throw Object.assign(new Error(error), { status: 502 });
  }
  return {
    result: (payload as { result?: unknown }).result ?? payload,
    sessionId: response.headers.get('mcp-session-id') || sessionId || null,
  };
}

function parseNativePayload(text: string): JsonValue | Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    const events = text.split(/\r?\n\r?\n/);
    const parsedEvents: JsonValue[] = [];
    for (const event of events) {
      const dataLines = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter((line) => line && line !== '[DONE]');
      if (dataLines.length === 0) continue;
      try {
        parsedEvents.push(JSON.parse(dataLines.join('\n')) as JsonValue);
      } catch {
        // Keep scanning later SSE events; streamable HTTP may include progress
        // frames before the JSON-RPC response frame.
      }
    }
    if (parsedEvents.length > 0) {
      return parsedEvents[parsedEvents.length - 1]!;
    }
    return { raw: text };
  }
}

function extractMcpError(payload: unknown): string {
  const error = (payload as { error?: unknown })?.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' ? message : JSON.stringify(error);
}

function credentialToken(credentials: Record<string, unknown>): string {
  for (const key of ['access_token', 'api_key', 'token', 'bot_token', 'user_access_token']) {
    const value = credentials[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}
