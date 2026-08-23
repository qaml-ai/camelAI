import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { parseJsonObject, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';
import { warehouseExportKey, stageWarehouseExport } from './warehouse-export.js';
import { resolveObjectStoreBinding } from './binding-facades/object-store.js';

/** Minimal context the export path needs to namespace the R2 staging key. */
export interface ClickHouseMcpContext {
  workspaceId: string;
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ClickHouseMcpEnv {
  INTEGRATION_SECRET_KEY: string;
  OBJECT_STORE_SERVICE?: Fetcher;
  /** Auto-expiring R2 staging bucket for warehouse exports. */
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
}

interface ClickHouseClient {
  endpoint: string;
  database: string;
  username: string;
  password: string;
}

const CLICKHOUSE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

export function isClickHouseMcpIntegration(integrationType: string): boolean {
  return integrationType === 'clickhouse';
}

export function listClickHouseMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_databases',
      description: 'List ClickHouse databases.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List tables in a ClickHouse database. Uses the connection database when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'ClickHouse database name.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_table_info',
      description: 'Get ClickHouse table columns from system.columns.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'ClickHouse database name. Optional when configured on the connection.' },
          table: { type: 'string', description: 'ClickHouse table name.' },
        },
        required: ['table'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description: 'Execute a ClickHouse query and return JSON. The query is run exactly as written — add your own LIMIT if you want to cap rows for inline display, or use export for the full result set.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL query to execute, verbatim.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'export',
      description:
        'Export the FULL result of a query to the workspace warehouse (R2) — no row cap, streamed server-side. Returns an R2 object handle to read with DuckDB. Use for bulk extracts feeding analytics/joins, not for inline display.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'SQL query to export in full.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function clickHouseMcpRpc(
  env: ClickHouseMcpEnv,
  context: ClickHouseMcpContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isClickHouseMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not ClickHouse.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-clickhouse', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listClickHouseMcpTools() };
    case 'tools/call':
      return callClickHouseTool(env, context, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callClickHouseTool(
  env: ClickHouseMcpEnv,
  context: ClickHouseMcpContext,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createClickHouseClient(env, record);

  switch (name) {
    case 'list_databases':
      return textToolResult(await executeClickHouseJson(client, 'SELECT name FROM system.databases ORDER BY name'));
    case 'list_tables':
      return textToolResult(await executeClickHouseJson(
        client,
        `SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = ${sqlString(databaseFromArgs(client, args))} ORDER BY name`
      ));
    case 'get_table_info':
      return textToolResult(await executeClickHouseJson(
        client,
        `SELECT name, type, default_kind, comment FROM system.columns WHERE database = ${sqlString(databaseFromArgs(client, args))} AND table = ${sqlString(requireIdentifier(args.table, 'table'))} ORDER BY position`
      ));
    case 'execute_sql_readonly':
      return textToolResult(await executeClickHouseJson(client, requireString(args.query, 'query')));
    case 'export': {
      const bucket = resolveObjectStoreBinding(
        env,
        'WAREHOUSE_EXPORT_BUCKET',
        env.WAREHOUSE_EXPORT_BUCKET,
      );
      // ClickHouse emits Parquet natively (`FORMAT Parquet`); stream it straight
      // into the auto-expiring warehouse bucket without buffering. The sealed
      // DuckDB container then reads `r2_key` via mountBucket.
      const query = requireString(args.query, 'query');
      // Namespace by unique integration id, not display name (names can collide across types).
      const r2Key = warehouseExportKey(context.workspaceId, record.id, query, 'parquet');
      const response = await executeClickHouseParquet(client, query);
      await stageWarehouseExport(bucket, r2Key, response.body, 'parquet');
      return { ok: true, r2_key: r2Key };
    }
    default:
      throw Object.assign(new Error(`Unknown ClickHouse tool: ${name}`), { status: 404 });
  }
}

async function createClickHouseClient(
  env: ClickHouseMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<ClickHouseClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const host = requireString(config.host, 'host');
  const port = typeof config.port === 'number' && Number.isFinite(config.port)
    ? config.port
    : 8443;
  const database = typeof config.database === 'string' && config.database.trim()
    ? requireIdentifier(config.database, 'database')
    : 'default';
  const username = requireString(credentials.username, 'username');
  const password = requireString(credentials.password, 'password');
  return {
    endpoint: validateClickHouseEndpoint(host, port),
    database,
    username,
    password,
  };
}

async function executeClickHouseJson(client: ClickHouseClient, query: string): Promise<Record<string, JsonValue>> {
  // Set the output format via `default_format` (a URL param) instead of appending
  // ` FORMAT JSON` to the SQL, so the user's query is sent exactly as written. A
  // FORMAT clause in the query itself still wins over default_format.
  // `readonly=2` makes ClickHouse reject any write/DDL statement server-side (a
  // readonly-labelled method must not be a write path), while still allowing the
  // `default_format` setting we pass (mode 1 would reject setting changes).
  const response = await fetch(`${client.endpoint}/?database=${encodeURIComponent(client.database)}&default_format=JSON&readonly=2`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${client.username}:${client.password}`)}`,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: query,
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(text || `ClickHouse request failed with HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return JSON.parse(text) as Record<string, JsonValue>;
}

/**
 * Run a query and return the raw streaming Response as Parquet so the caller can
 * pipe the bytes straight to R2. ClickHouse produces Parquet natively, so no
 * row-by-row re-encoding happens in the Worker. The output format is set via the
 * `default_format` URL param (not a ` FORMAT Parquet` SQL append), so the user's
 * query runs exactly as written. On a non-2xx the (small) error body is consumed
 * and rethrown loudly.
 */
async function executeClickHouseParquet(client: ClickHouseClient, query: string): Promise<Response> {
  // `readonly=2`: reject writes/DDL server-side while allowing the default_format setting.
  const response = await fetch(`${client.endpoint}/?database=${encodeURIComponent(client.database)}&default_format=Parquet&readonly=2`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${client.username}:${client.password}`)}`,
      'content-type': 'text/plain; charset=utf-8',
    },
    body: query,
  });
  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(new Error(text || `ClickHouse request failed with HTTP ${response.status}`), {
      status: response.status,
    });
  }
  return response;
}

function validateClickHouseEndpoint(host: string, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('port must be a valid TCP port.'), { status: 400 });
  }
  const raw = host.includes('://') ? host : `https://${host}`;
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('ClickHouse host must use HTTPS.'), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error('ClickHouse host must not include embedded credentials.'), { status: 400 });
  }
  if (!url.port) url.port = String(port);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function databaseFromArgs(client: ClickHouseClient, args: Record<string, unknown>): string {
  if (typeof args.database === 'string' && args.database.trim()) {
    return requireIdentifier(args.database, 'database');
  }
  return client.database;
}

function requireIdentifier(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!CLICKHOUSE_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} must be a valid ClickHouse identifier.`), { status: 400 });
  }
  return id;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
