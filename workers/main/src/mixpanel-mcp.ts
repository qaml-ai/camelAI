import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface MixpanelMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface MixpanelClient {
  projectId: string;
  region: 'us' | 'eu';
  username: string;
  secret: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function isMixpanelMcpIntegration(integrationType: string): boolean {
  return integrationType === 'mixpanel';
}

export function listMixpanelMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'top_events',
      description: 'List top Mixpanel events for a date range.',
      inputSchema: {
        type: 'object',
        properties: {
          fromDate: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
          toDate: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum events to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        required: ['fromDate', 'toDate'],
        additionalProperties: false,
      },
    },
    {
      name: 'event_properties',
      description: 'List properties seen for a Mixpanel event in a date range.',
      inputSchema: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'Mixpanel event name.' },
          fromDate: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
          toDate: { type: 'string', description: 'End date in YYYY-MM-DD format.' },
        },
        required: ['event', 'fromDate', 'toDate'],
        additionalProperties: false,
      },
    },
    {
      name: 'query_jql_readonly',
      description: 'Run a read-only Mixpanel JQL query.',
      inputSchema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'Mixpanel JQL script. Mutating JavaScript globals are rejected.' },
        },
        required: ['script'],
        additionalProperties: false,
      },
    },
  ];
}

export async function mixpanelMcpRpc(
  env: MixpanelMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isMixpanelMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Mixpanel.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-mixpanel', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listMixpanelMcpTools() };
    case 'tools/call':
      return callMixpanelTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callMixpanelTool(
  env: MixpanelMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createMixpanelClient(env, record);

  switch (name) {
    case 'top_events':
      return textToolResult(await mixpanelFetch(client, '/api/2.0/events/top', {
        project_id: client.projectId,
        from_date: requireDate(args.fromDate, 'fromDate'),
        to_date: requireDate(args.toDate, 'toDate'),
        limit: String(boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
      }));
    case 'event_properties':
      return textToolResult(await mixpanelFetch(client, '/api/2.0/events/properties/top', {
        project_id: client.projectId,
        event: requireString(args.event, 'event'),
        from_date: requireDate(args.fromDate, 'fromDate'),
        to_date: requireDate(args.toDate, 'toDate'),
      }));
    case 'query_jql_readonly':
      return textToolResult(await mixpanelPost(client, '/api/2.0/jql', {
        project_id: client.projectId,
        script: safeJqlScript(requireString(args.script, 'script')),
      }));
    default:
      throw Object.assign(new Error(`Unknown Mixpanel tool: ${name}`), { status: 404 });
  }
}

async function createMixpanelClient(
  env: MixpanelMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<MixpanelClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  return {
    projectId: requireString(config.project_id, 'project_id'),
    region: config.region === 'eu' ? 'eu' : 'us',
    username: requireString(credentials.api_key, 'api_key'),
    secret: requireString(credentials.api_secret, 'api_secret'),
  };
}

async function mixpanelFetch(
  client: MixpanelClient,
  path: string,
  params: Record<string, string>
): Promise<JsonValue> {
  const url = new URL(`${mixpanelBase(client)}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return mixpanelRequest(client, url.toString());
}

async function mixpanelPost(
  client: MixpanelClient,
  path: string,
  body: Record<string, string>
): Promise<JsonValue> {
  return mixpanelRequest(client, `${mixpanelBase(client)}${path}`, {
    method: 'POST',
    body: new URLSearchParams(body),
  });
}

async function mixpanelRequest(
  client: MixpanelClient,
  url: string,
  init: { method?: string; body?: URLSearchParams } = {}
): Promise<JsonValue> {
  const response = await fetchMcpHttp(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Basic ${btoa(`${client.username}:${client.secret}`)}`,
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: init.body,
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue : null;
  if (!response.ok) {
    throw Object.assign(new Error(`Mixpanel API request failed with HTTP ${response.status}: ${text}`), {
      status: response.status,
    });
  }
  return payload;
}

function mixpanelBase(client: MixpanelClient): string {
  return client.region === 'eu' ? 'https://eu.mixpanel.com' : 'https://mixpanel.com';
}

function safeJqlScript(script: string): string {
  if (/\b(fetch|XMLHttpRequest|require|import|process|globalThis|Function|eval)\b/.test(script)) {
    throw Object.assign(new Error('Mixpanel MCP rejected unsafe JQL script content.'), { status: 400 });
  }
  return script;
}

function requireDate(value: unknown, field: string): string {
  const date = requireString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error(`${field} must be in YYYY-MM-DD format.`), { status: 400 });
  }
  return date;
}
