import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface TeamsMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface TeamsClient {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function isTeamsMcpIntegration(integrationType: string): boolean {
  return integrationType === 'teams';
}

export function listTeamsMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_teams',
      description: 'List Microsoft Teams in the tenant using app-only Microsoft Graph permissions.',
      inputSchema: limitSchema(),
    },
    {
      name: 'list_channels',
      description: 'List channels in a team.',
      inputSchema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'Microsoft Graph team id.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        required: ['teamId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_channel_messages',
      description: 'List recent messages in a Teams channel.',
      inputSchema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', description: 'Microsoft Graph team id.' },
          channelId: { type: 'string', description: 'Microsoft Graph channel id.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        required: ['teamId', 'channelId'],
        additionalProperties: false,
      },
    },
  ];
}

export async function teamsMcpRpc(
  env: TeamsMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isTeamsMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Microsoft Teams.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-teams', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listTeamsMcpTools() };
    case 'tools/call':
      return callTeamsTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callTeamsTool(
  env: TeamsMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createTeamsClient(env, record);
  const token = await getGraphToken(client);
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');

  switch (name) {
    case 'list_teams':
      return textToolResult(await graphFetch<JsonValue>(
        token,
        `/groups?$top=${limit}&$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName,description,visibility,createdDateTime`
      ));
    case 'list_channels':
      return textToolResult(await graphFetch<JsonValue>(
        token,
        `/teams/${encodeURIComponent(requireId(args.teamId, 'teamId'))}/channels?$top=${limit}`
      ));
    case 'list_channel_messages':
      return textToolResult(await graphFetch<JsonValue>(
        token,
        `/teams/${encodeURIComponent(requireId(args.teamId, 'teamId'))}/channels/${encodeURIComponent(requireId(args.channelId, 'channelId'))}/messages?$top=${limit}`
      ));
    default:
      throw Object.assign(new Error(`Unknown Microsoft Teams tool: ${name}`), { status: 404 });
  }
}

async function createTeamsClient(env: TeamsMcpEnv, record: WorkspaceIntegrationRecord): Promise<TeamsClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  return {
    tenantId: requireGuidLike(config.tenant_id, 'tenant_id'),
    clientId: requireGuidLike(credentials.client_id, 'client_id'),
    clientSecret: requireString(credentials.client_secret, 'client_secret'),
  };
}

async function getGraphToken(client: TeamsClient): Promise<string> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const response = await fetchMcpHttp(`https://login.microsoftonline.com/${encodeURIComponent(client.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const tokenText = await readBoundedResponseText(response, 1024 * 1024);
  const payload = (tokenText ? JSON.parse(tokenText) : {}) as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !payload.access_token) {
    throw Object.assign(new Error(payload.error_description || payload.error || `Microsoft token request failed with HTTP ${response.status}`), { status: response.status });
  }
  return payload.access_token;
}

async function graphFetch<T>(token: string, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${GRAPH_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as T & { error?: { message?: string } } : {} as T;
  if (!response.ok) {
    throw Object.assign(new Error((payload as { error?: { message?: string } }).error?.message || `Microsoft Graph request failed with HTTP ${response.status}`), { status: response.status });
  }
  return payload as T;
}

function limitSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    additionalProperties: false,
  };
}

function requireGuidLike(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  return id;
}

function requireId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9._!:#%+=@-]{1,256}$/.test(id)) throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  return id;
}
