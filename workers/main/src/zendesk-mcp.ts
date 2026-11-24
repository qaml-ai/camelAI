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

interface ZendeskMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface ZendeskClient {
  baseUrl: string;
  authorization: string;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SUBDOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;

export function isZendeskMcpIntegration(integrationType: string): boolean {
  return integrationType === 'zendesk';
}

export function listZendeskMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'search_tickets',
      description: 'Search Zendesk tickets using Zendesk Support search syntax.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query. "type:ticket" is added automatically.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum results to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_ticket',
      description: 'Get one Zendesk ticket by id.',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: { type: 'integer', minimum: 1, description: 'Zendesk ticket id.' },
        },
        required: ['ticketId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_ticket_comments',
      description: 'List comments on one Zendesk ticket.',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: { type: 'integer', minimum: 1, description: 'Zendesk ticket id.' },
        },
        required: ['ticketId'],
        additionalProperties: false,
      },
    },
  ];
}

export async function zendeskMcpRpc(
  env: ZendeskMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isZendeskMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Zendesk.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-zendesk', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listZendeskMcpTools() };
    case 'tools/call':
      return callZendeskTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callZendeskTool(
  env: ZendeskMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createZendeskClient(env, record);

  switch (name) {
    case 'search_tickets':
      return textToolResult(await searchTickets(client, args));
    case 'get_ticket':
      return textToolResult(await zendeskFetch<JsonValue>(
        client,
        `/tickets/${boundedInteger(args.ticketId, 1, Number.MAX_SAFE_INTEGER, 'ticketId')}.json`
      ));
    case 'list_ticket_comments':
      return textToolResult(await zendeskFetch<JsonValue>(
        client,
        `/tickets/${boundedInteger(args.ticketId, 1, Number.MAX_SAFE_INTEGER, 'ticketId')}/comments.json`
      ));
    default:
      throw Object.assign(new Error(`Unknown Zendesk tool: ${name}`), { status: 404 });
  }
}

async function createZendeskClient(
  env: ZendeskMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<ZendeskClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};

  const subdomain = requireSubdomain(config.subdomain);
  const email = requireString(credentials.email, 'email');
  const token = requireString(credentials.api_key, 'api_key');
  return {
    baseUrl: `https://${subdomain}.zendesk.com/api/v2`,
    authorization: `Basic ${btoa(`${email}/token:${token}`)}`,
  };
}

async function searchTickets(
  client: ZendeskClient,
  args: Record<string, unknown>
): Promise<JsonValue> {
  const rawQuery = requireString(args.query, 'query');
  const query = /\btype\s*:\s*ticket\b/i.test(rawQuery) ? rawQuery : `type:ticket ${rawQuery}`;
  return zendeskFetch<JsonValue>(
    client,
    `/search.json?${new URLSearchParams({
      query,
      per_page: String(boundedInteger(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
    })}`
  );
}

async function zendeskFetch<T>(client: ZendeskClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${client.baseUrl}${path}`, {
    headers: {
      authorization: client.authorization,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload: T & { error?: unknown; description?: unknown } = text
    ? JSON.parse(text) as T & { error?: unknown; description?: unknown }
    : {} as T & { error?: unknown; description?: unknown };
  if (!response.ok) {
    const message = typeof payload.description === 'string'
      ? payload.description
      : typeof payload.error === 'string'
        ? payload.error
        : `Zendesk API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload as T;
}


function requireSubdomain(value: unknown): string {
  const subdomain = requireString(value, 'subdomain').replace(/\.zendesk\.com$/i, '');
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw Object.assign(new Error('subdomain must be a Zendesk subdomain, not a full URL.'), { status: 400 });
  }
  return subdomain;
}
