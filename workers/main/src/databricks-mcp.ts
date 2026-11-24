import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { ANALYTICS_MCP_HTTP_TIMEOUT_MS, fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface DatabricksMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface DatabricksClient {
  workspaceUrl: string;
  token: string;
  defaultWarehouseId: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function isDatabricksMcpIntegration(integrationType: string): boolean {
  return integrationType === 'databricks';
}

export function listDatabricksMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_sql_warehouses',
      description: 'List Databricks SQL warehouses visible to the connected PAT.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'list_catalogs',
      description: 'List catalogs using a Databricks SQL warehouse.',
      inputSchema: warehouseInputSchema(),
    },
    {
      name: 'list_schemas',
      description: 'List schemas in a catalog.',
      inputSchema: {
        type: 'object',
        properties: {
          warehouseId: { type: 'string', description: 'SQL warehouse id. Uses sql_warehouse_id from config when omitted.' },
          catalog: { type: 'string', description: 'Catalog name.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        required: ['catalog'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List tables in a catalog schema.',
      inputSchema: {
        type: 'object',
        properties: {
          warehouseId: { type: 'string', description: 'SQL warehouse id. Uses sql_warehouse_id from config when omitted.' },
          catalog: { type: 'string', description: 'Catalog name.' },
          schema: { type: 'string', description: 'Schema name.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        required: ['catalog', 'schema'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description: 'Execute a SQL query through a SQL warehouse. The query runs exactly as written; add your own LIMIT to cap rows.',
      inputSchema: {
        type: 'object',
        properties: {
          warehouseId: { type: 'string', description: 'SQL warehouse id. Uses sql_warehouse_id from config when omitted.' },
          query: { type: 'string', description: 'Read-only SQL statement.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function databricksMcpRpc(
  env: DatabricksMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isDatabricksMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Databricks.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-databricks', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listDatabricksMcpTools() };
    case 'tools/call':
      return callDatabricksTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callDatabricksTool(
  env: DatabricksMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createDatabricksClient(env, record);
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');

  switch (name) {
    case 'list_sql_warehouses':
      return textToolResult(await databricksFetch<JsonValue>(client, '/api/2.0/sql/warehouses'));
    case 'list_catalogs':
      return textToolResult(await executeStatement(client, warehouseIdFromArgs(client, args), `SHOW CATALOGS LIMIT ${limit}`));
    case 'list_schemas':
      return textToolResult(await executeStatement(client, warehouseIdFromArgs(client, args), `SHOW SCHEMAS IN ${quoteIdentifier(requireString(args.catalog, 'catalog'))} LIMIT ${limit}`));
    case 'list_tables':
      return textToolResult(await executeStatement(client, warehouseIdFromArgs(client, args), `SHOW TABLES IN ${quoteIdentifier(requireString(args.catalog, 'catalog'))}.${quoteIdentifier(requireString(args.schema, 'schema'))} LIMIT ${limit}`));
    case 'execute_sql_readonly':
      return textToolResult(await executeStatement(client, warehouseIdFromArgs(client, args), requireString(args.query, 'query')));
    default:
      throw Object.assign(new Error(`Unknown Databricks tool: ${name}`), { status: 404 });
  }
}

async function createDatabricksClient(env: DatabricksMcpEnv, record: WorkspaceIntegrationRecord): Promise<DatabricksClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  return {
    workspaceUrl: validateHttpsBaseUrl(requireString(config.workspace_url, 'workspace_url')),
    token: requireString(credentials.api_key, 'api_key'),
    defaultWarehouseId: typeof config.sql_warehouse_id === 'string' && config.sql_warehouse_id.trim()
      ? config.sql_warehouse_id.trim()
      : null,
  };
}

async function executeStatement(client: DatabricksClient, warehouseId: string, statement: string): Promise<JsonValue> {
  const payload = await databricksFetch<Record<string, JsonValue>>(client, '/api/2.0/sql/statements', {
    method: 'POST',
    body: {
      warehouse_id: warehouseId,
      statement,
      disposition: 'INLINE',
      wait_timeout: '10s',
      on_wait_timeout: 'CONTINUE',
    },
  });
  const statementId = typeof payload.statement_id === 'string' ? payload.statement_id : '';
  const state = (((payload.status as Record<string, JsonValue> | undefined)?.state) ?? '') as string;
  if (statementId && (state === 'PENDING' || state === 'RUNNING')) {
    return databricksFetch<JsonValue>(client, `/api/2.0/sql/statements/${encodeURIComponent(statementId)}`);
  }
  return payload;
}

async function databricksFetch<T>(
  client: DatabricksClient,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetchMcpHttp(`${client.workspaceUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }, ANALYTICS_MCP_HTTP_TIMEOUT_MS);
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as T & { message?: string; error_code?: string } : {} as T;
  if (!response.ok) {
    throw Object.assign(new Error((payload as { message?: string }).message || `Databricks API request failed with HTTP ${response.status}`), { status: response.status });
  }
  return payload as T;
}

function warehouseInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      warehouseId: { type: 'string', description: 'SQL warehouse id. Uses sql_warehouse_id from config when omitted.' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
    },
    additionalProperties: false,
  };
}

function warehouseIdFromArgs(client: DatabricksClient, args: Record<string, unknown>): string {
  if (typeof args.warehouseId === 'string' && args.warehouseId.trim()) return args.warehouseId.trim();
  if (client.defaultWarehouseId) return client.defaultWarehouseId;
  throw Object.assign(new Error('warehouseId is required because the connection has no sql_warehouse_id config value.'), { status: 400 });
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_ -]*$/.test(value)) {
    throw Object.assign(new Error('identifier contains invalid characters.'), { status: 400 });
  }
  return `\`${value.replace(/`/g, '``')}\``;
}

function validateHttpsBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw Object.assign(new Error('workspace_url must use HTTPS.'), { status: 400 });
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}
