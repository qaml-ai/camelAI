import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface TursoMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface TursoClient {
  endpoint: string;
  token: string;
}

export function isTursoMcpIntegration(integrationType: string): boolean {
  return integrationType === 'turso';
}

export function listTursoMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_tables',
      description: 'List tables in the Turso database.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'get_table_info',
      description: 'Get column metadata for one Turso table.',
      inputSchema: {
        type: 'object',
        properties: { table: { type: 'string', description: 'Table name.' } },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description: 'Execute a SQL query and return rows. The query runs exactly as written; add your own LIMIT to cap rows.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Read-only SQL query.' },
          params: { type: 'array', description: 'Optional positional parameters.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function tursoMcpRpc(
  env: TursoMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isTursoMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Turso.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-turso', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listTursoMcpTools() };
    case 'tools/call':
      return callTursoTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callTursoTool(
  env: TursoMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createTursoClient(env, record);

  switch (name) {
    case 'list_tables':
      return textToolResult(await executeTursoSql(client, "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name", []));
    case 'get_table_info':
      return textToolResult(await executeTursoSql(client, `PRAGMA table_info(${quoteSqlIdentifier(requireString(args.table, 'table'))})`, []));
    case 'execute_sql_readonly':
      return textToolResult(await executeTursoSql(
        client,
        requireString(args.query, 'query'),
        arrayArg(args.params, 'params')
      ));
    default:
      throw Object.assign(new Error(`Unknown Turso tool: ${name}`), { status: 404 });
  }
}

async function createTursoClient(env: TursoMcpEnv, record: WorkspaceIntegrationRecord): Promise<TursoClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const endpoint = tursoHttpEndpoint(requireString(config.database_url, 'database_url'));
  const token = requireString(credentials.api_key, 'api_key');
  return { endpoint, token };
}

async function executeTursoSql(client: TursoClient, sql: string, args: unknown[]): Promise<JsonValue> {
  const response = await fetchMcpHttp(`${client.endpoint}/v2/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        {
          type: 'execute',
          stmt: {
            sql,
            args: args.map((value) => ({ type: value == null ? 'null' : 'text', value: value == null ? undefined : String(value) })),
          },
        },
      ],
    }),
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue & { error?: string; message?: string } : {} as JsonValue;
  if (!response.ok) {
    const message = typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : `Turso API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload;
}

function tursoHttpEndpoint(rawUrl: string): string {
  const url = new URL(rawUrl.replace(/^libsql:/, 'https:'));
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('database_url must be an HTTPS or libsql URL.'), { status: 400 });
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function quoteSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw Object.assign(new Error('table must be a simple SQL identifier.'), { status: 400 });
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function arrayArg(value: unknown, field: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw Object.assign(new Error(`${field} must be an array.`), { status: 400 });
  return value;
}
