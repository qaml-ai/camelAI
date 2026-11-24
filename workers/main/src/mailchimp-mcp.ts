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

interface MailchimpMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface MailchimpClient {
  baseUrl: string;
  authorization: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DATA_CENTER_RE = /^[a-z]{2}\d+$/i;
const RESOURCE_ID_RE = /^[a-z0-9_-]+$/i;

export function isMailchimpMcpIntegration(integrationType: string): boolean {
  return integrationType === 'mailchimp';
}

export function listMailchimpMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_audiences',
      description: 'List Mailchimp audiences visible to the connected API key.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum audiences to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_audience',
      description: 'Get one Mailchimp audience by list id.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'Mailchimp audience/list id.' },
        },
        required: ['listId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_campaigns',
      description: 'List Mailchimp campaigns.',
      inputSchema: {
        type: 'object',
        properties: {
          listId: { type: 'string', description: 'Optional audience/list id filter.' },
          status: { type: 'string', description: 'Optional campaign status filter, for example sent, save, paused, schedule, sending.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum campaigns to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_campaign',
      description: 'Get one Mailchimp campaign by id.',
      inputSchema: {
        type: 'object',
        properties: {
          campaignId: { type: 'string', description: 'Mailchimp campaign id.' },
        },
        required: ['campaignId'],
        additionalProperties: false,
      },
    },
  ];
}

export async function mailchimpMcpRpc(
  env: MailchimpMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isMailchimpMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Mailchimp.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-mailchimp', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listMailchimpMcpTools() };
    case 'tools/call':
      return callMailchimpTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callMailchimpTool(
  env: MailchimpMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createMailchimpClient(env, record);

  switch (name) {
    case 'list_audiences':
      return textToolResult(await mailchimpFetch<JsonValue>(
        client,
        `/lists?${new URLSearchParams({
          count: String(boundedInteger(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
        })}`
      ));
    case 'get_audience':
      return textToolResult(await mailchimpFetch<JsonValue>(
        client,
        `/lists/${encodeURIComponent(requireResourceId(args.listId, 'listId'))}`
      ));
    case 'list_campaigns':
      return textToolResult(await listCampaigns(client, args));
    case 'get_campaign':
      return textToolResult(await mailchimpFetch<JsonValue>(
        client,
        `/campaigns/${encodeURIComponent(requireResourceId(args.campaignId, 'campaignId'))}`
      ));
    default:
      throw Object.assign(new Error(`Unknown Mailchimp tool: ${name}`), { status: 404 });
  }
}

async function createMailchimpClient(
  env: MailchimpMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<MailchimpClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};

  const dataCenter = requireDataCenter(config.data_center);
  const apiKey = requireString(credentials.api_key, 'api_key');
  return {
    baseUrl: `https://${dataCenter}.api.mailchimp.com/3.0`,
    authorization: `Basic ${btoa(`camelai:${apiKey}`)}`,
  };
}

async function listCampaigns(
  client: MailchimpClient,
  args: Record<string, unknown>
): Promise<JsonValue> {
  const params = new URLSearchParams({
    count: String(boundedInteger(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
  });
  if (typeof args.listId === 'string' && args.listId.trim()) {
    params.set('list_id', requireResourceId(args.listId, 'listId'));
  }
  if (typeof args.status === 'string' && args.status.trim()) {
    params.set('status', args.status.trim());
  }
  return mailchimpFetch<JsonValue>(client, `/campaigns?${params}`);
}

async function mailchimpFetch<T>(client: MailchimpClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${client.baseUrl}${path}`, {
    headers: {
      authorization: client.authorization,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload: T & { detail?: unknown; title?: unknown } = text
    ? JSON.parse(text) as T & { detail?: unknown; title?: unknown }
    : {} as T & { detail?: unknown; title?: unknown };
  if (!response.ok) {
    const message = typeof payload.detail === 'string'
      ? payload.detail
      : typeof payload.title === 'string'
        ? payload.title
        : `Mailchimp API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload as T;
}


function requireDataCenter(value: unknown): string {
  const dataCenter = requireString(value, 'data_center');
  if (!DATA_CENTER_RE.test(dataCenter)) {
    throw Object.assign(new Error('data_center must look like us21.'), { status: 400 });
  }
  return dataCenter.toLowerCase();
}

function requireResourceId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!RESOURCE_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  }
  return id;
}
