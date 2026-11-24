import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface AirtableMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface AirtableClient {
  token: string;
}

const AIRTABLE_API_BASE = 'https://api.airtable.com/v0';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const AIRTABLE_ID_RE = /^[A-Za-z0-9_ -]{1,128}$/;

export function isAirtableMcpIntegration(integrationType: string): boolean {
  return integrationType === 'airtable';
}

export function listAirtableMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_bases',
      description: 'List Airtable bases visible to the connected token.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List tables and fields in an Airtable base.',
      inputSchema: {
        type: 'object',
        properties: {
          baseId: { type: 'string', description: 'Airtable base id, for example appXXXXXXXXXXXXXX.' },
        },
        required: ['baseId'],
        additionalProperties: false,
      },
    },
    {
      name: 'query_records',
      description: 'Read records from an Airtable table by base id and table id or name.',
      inputSchema: {
        type: 'object',
        properties: {
          baseId: { type: 'string', description: 'Airtable base id.' },
          table: { type: 'string', description: 'Airtable table id or table name.' },
          view: { type: 'string', description: 'Optional Airtable view name.' },
          filterByFormula: { type: 'string', description: 'Optional Airtable formula filter.' },
          maxRecords: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum records to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        required: ['baseId', 'table'],
        additionalProperties: false,
      },
    },
  ];
}

export async function airtableMcpRpc(
  env: AirtableMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isAirtableMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Airtable.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-airtable', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listAirtableMcpTools() };
    case 'tools/call':
      return callAirtableTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callAirtableTool(
  env: AirtableMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createAirtableClient(env, record);

  switch (name) {
    case 'list_bases':
      return textToolResult(await airtableFetch<JsonValue>(client, '/meta/bases'));
    case 'list_tables':
      return textToolResult(await airtableFetch<JsonValue>(
        client,
        `/meta/bases/${encodeURIComponent(requireAirtableId(args.baseId, 'baseId'))}/tables`
      ));
    case 'query_records':
      return textToolResult(await queryRecords(client, args));
    default:
      throw Object.assign(new Error(`Unknown Airtable tool: ${name}`), { status: 404 });
  }
}

async function queryRecords(
  client: AirtableClient,
  args: Record<string, unknown>
): Promise<JsonValue> {
  const params = new URLSearchParams({
    maxRecords: String(boundedInteger(args.maxRecords, DEFAULT_LIMIT, 1, MAX_LIMIT, 'maxRecords')),
  });
  if (typeof args.view === 'string' && args.view.trim()) {
    params.set('view', args.view.trim());
  }
  if (typeof args.filterByFormula === 'string' && args.filterByFormula.trim()) {
    params.set('filterByFormula', args.filterByFormula.trim());
  }

  return airtableFetch<JsonValue>(
    client,
    `/${encodeURIComponent(requireAirtableId(args.baseId, 'baseId'))}/${encodeURIComponent(requireAirtableId(args.table, 'table'))}?${params}`
  );
}

async function createAirtableClient(
  env: AirtableMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<AirtableClient> {
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = typeof credentials.api_key === 'string' ? credentials.api_key.trim() : '';
  if (!token) {
    throw Object.assign(new Error('Airtable integration has no usable API token.'), { status: 400 });
  }
  return { token };
}

async function airtableFetch<T>(client: AirtableClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${AIRTABLE_API_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as T & { error?: { message?: string } | string } : {} as T;
  if (!response.ok) {
    const error = (payload as { error?: { message?: string } | string }).error;
    const message = typeof error === 'string' ? error : error?.message;
    throw Object.assign(
      new Error(message || `Airtable API request failed with HTTP ${response.status}`),
      { status: response.status }
    );
  }
  return payload as T;
}

function requireAirtableId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!AIRTABLE_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  }
  return id;
}
