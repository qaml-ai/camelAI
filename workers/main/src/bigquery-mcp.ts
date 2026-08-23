import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { getProviderMcpDefinition } from '../../../src/lib/provider-mcp-registry';
import { mintBigQueryAccessTokenFromServiceAccount } from './google-service-account';
import type { WorkspaceIntegrationRecord } from './workspace.js';
import { warehouseExportKey, stageWarehouseExport } from './warehouse-export.js';
import { resolveObjectStoreBinding } from './binding-facades/object-store.js';

/** Minimal context the export path needs to namespace the R2 staging key. */
export interface BigQueryMcpContext {
  workspaceId: string;
}

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface BigQueryMcpEnv {
  INTEGRATION_SECRET_KEY: string;
  OBJECT_STORE_SERVICE?: Fetcher;
  /** Auto-expiring R2 staging bucket for warehouse exports. */
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
}

interface BigQueryConfig {
  projectId: string;
  defaultDataset: string | null;
}

interface BigQueryField {
  name?: string;
  type?: string;
  mode?: string;
  fields?: BigQueryField[];
}

interface BigQueryTableSchema {
  fields?: BigQueryField[];
}

interface BigQueryQueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; projectId?: string; location?: string };
  schema?: BigQueryTableSchema;
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
  totalRows?: string;
  totalBytesProcessed?: string;
  cacheHit?: boolean;
  pageToken?: string;
}

interface BigQueryJobResponse {
  statistics?: {
    totalBytesProcessed?: string;
    query?: {
      totalBytesProcessed?: string;
      totalBytesBilled?: string;
      cacheHit?: boolean;
      statementType?: string;
    };
  };
}

interface BigQueryErrorResponse {
  error?: {
    message?: string;
    status?: string;
    errors?: Array<{ message?: string; reason?: string }>;
  };
}

const BIGQUERY_API_BASE = 'https://bigquery.googleapis.com/bigquery/v2';
const BIGQUERY_TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const DEFAULT_MAX_RESULTS = 100;
const MAX_MAX_RESULTS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAXIMUM_BYTES_BILLED = '1000000000';
const BIGQUERY_ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
// Warehouse export paging: BigQuery caps a page at ~10MB regardless of this row
// hint, so a high value just minimizes round-trips on narrow rows.
const BIGQUERY_EXPORT_PAGE_SIZE = 50_000;
const BIGQUERY_EXPORT_TIMEOUT_MS = 30_000;
const BIGQUERY_EXPORT_POLL_ATTEMPTS = 60;
const BIGQUERY_PROVIDER_MCP = getProviderMcpDefinition('bigquery');
if (!BIGQUERY_PROVIDER_MCP) {
  throw new Error('BigQuery provider MCP definition is missing');
}

export const BIGQUERY_MCP_SERVER = {
  ...BIGQUERY_PROVIDER_MCP,
  server_name: BIGQUERY_PROVIDER_MCP.serverName,
  direct_connect: BIGQUERY_PROVIDER_MCP.directConnect,
  auth_strategy: BIGQUERY_PROVIDER_MCP.authStrategy,
  docs_url: BIGQUERY_PROVIDER_MCP.docsUrl,
};

export function isBigQueryMcpIntegration(integrationType: string): boolean {
  return integrationType === 'bigquery';
}

export function listBigQueryMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_dataset_ids',
      description: 'List BigQuery dataset ids in the connected project.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'get_dataset_info',
      description: 'Get metadata for one BigQuery dataset.',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: {
            type: 'string',
            description: 'Dataset id in the connected project.',
          },
        },
        required: ['datasetId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_table_ids',
      description: 'List table ids in a BigQuery dataset. Uses the connection default dataset when datasetId is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: {
            type: 'string',
            description: 'Dataset id. Optional when the connection has a default dataset.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_table_info',
      description: 'Get metadata and schema for one BigQuery table.',
      inputSchema: {
        type: 'object',
        properties: {
          datasetId: {
            type: 'string',
            description: 'Dataset id. Optional when the connection has a default dataset.',
          },
          tableId: {
            type: 'string',
            description: 'Table id in the dataset.',
          },
        },
        required: ['tableId'],
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description:
        'Execute a Standard SQL query against BigQuery. The broker dry-runs the query first and enforces result and bytes limits.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Standard SQL query to execute.',
          },
          datasetId: {
            type: 'string',
            description: 'Default dataset for unqualified table names. Optional when the connection has a default dataset.',
          },
          maxResults: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_MAX_RESULTS,
            description: `Maximum rows to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
          },
          maximumBytesBilled: {
            type: 'string',
            description: `Maximum bytes BigQuery may bill for the query. Defaults to ${DEFAULT_MAXIMUM_BYTES_BILLED}.`,
          },
          timeoutMs: {
            type: 'integer',
            minimum: 1000,
            maximum: MAX_TIMEOUT_MS,
            description: `Query timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'estimate_query',
      description:
        'Dry-run a Standard SQL query WITHOUT executing or billing it. Returns the statement type and totalBytesProcessed (the bytes a real run would scan/bill). Use before querying large tables to size maximumBytesBilled, or to check whether a query fits the default billing cap.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Standard SQL query to estimate.' },
          datasetId: {
            type: 'string',
            description: 'Default dataset for unqualified table names. Optional when the connection has a default dataset.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    {
      name: 'export',
      description:
        'Export the FULL result of a query to the workspace warehouse (R2) — no row cap, streamed server-side as NDJSON (BigQuery has no Parquet-over-API path, so unlike SQL/ClickHouse exports this is NDJSON, NOT Parquet). Returns { ok, r2_key, rows, columns }; read the object with DuckDB read_json_auto (NOT read_parquet). When rows is 0 the NDJSON file is empty (read_json_auto cannot infer columns from it) — treat that as a no-rows result and use the returned columns rather than reading the file. Use for bulk extracts feeding analytics/joins, not for inline display.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Standard SQL query to export in full.' },
          datasetId: { type: 'string', description: 'Default dataset for unqualified table names.' },
          maximumBytesBilled: {
            type: 'string',
            description: `Maximum bytes BigQuery may bill for the export (fail-without-charge cap). Defaults to ${DEFAULT_MAXIMUM_BYTES_BILLED}; raise it for legitimately large extracts.`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function bigQueryMcpRpc(
  env: BigQueryMcpEnv,
  context: BigQueryMcpContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isBigQueryMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not BigQuery.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-bigquery', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listBigQueryMcpTools() };
    case 'tools/call':
      return callBigQueryTool(env, context, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callBigQueryTool(
  env: BigQueryMcpEnv,
  context: BigQueryMcpContext,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createBigQueryClient(env, record);

  switch (name) {
    case 'list_dataset_ids':
      return textToolResult(await listDatasetIds(client));
    case 'get_dataset_info':
      return textToolResult(await getDatasetInfo(client, requireBigQueryId(args.datasetId, 'datasetId')));
    case 'list_table_ids':
      return textToolResult(await listTableIds(client, datasetFromArgs(client.config, args)));
    case 'get_table_info':
      return textToolResult(await getTableInfo(
        client,
        datasetFromArgs(client.config, args),
        requireBigQueryId(args.tableId, 'tableId')
      ));
    case 'execute_sql_readonly':
      return textToolResult(await executeSqlReadonly(client, args));
    case 'estimate_query':
      return textToolResult(await estimateQuery(client, args));
    case 'export':
      return runBigQueryWarehouseExport(
        env,
        context,
        client,
        record.id, // namespace by unique integration id, not display name (names can collide across types)
        requireString(args.query, 'query'),
        // Match execute_sql_readonly: apply the caller-provided datasetId or the
        // connection's default dataset so unqualified table names resolve.
        datasetFromArgs(client.config, args, false) || null,
        // ...and the same fail-without-charge billing cap (default or override).
        maximumBytesBilledFromArgs(args.maximumBytesBilled),
      );
    default:
      throw Object.assign(new Error(`Unknown BigQuery tool: ${name}`), { status: 404 });
  }
}

function textToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function createBigQueryClient(
  env: BigQueryMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<{ config: BigQueryConfig; token: string }> {
  return {
    config: parseBigQueryConfig(record),
    token: await getBigQueryAccessToken(env, record),
  };
}

function parseBigQueryConfig(record: WorkspaceIntegrationRecord): BigQueryConfig {
  const config = parseJsonObject(record.config);
  const projectId = requireString(config.project_id, 'project_id');
  const defaultDataset = typeof config.dataset === 'string' && config.dataset.trim()
    ? requireBigQueryId(config.dataset, 'dataset')
    : null;

  return { projectId, defaultDataset };
}

async function getBigQueryAccessToken(
  env: BigQueryMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<string> {
  if (!record.credentials_encrypted) {
    throw Object.assign(new Error('BigQuery integration has no stored credentials.'), { status: 400 });
  }

  const credentials = await decryptCredentials<Record<string, unknown>>(
    record.credentials_encrypted,
    env.INTEGRATION_SECRET_KEY
  );
  const accessToken = typeof credentials.access_token === 'string' ? credentials.access_token.trim() : '';
  const expiresAt = typeof credentials.expires_at === 'number'
    ? credentials.expires_at
    : record.token_expires_at;

  if (accessToken && (!expiresAt || expiresAt > Date.now() + BIGQUERY_TOKEN_REFRESH_SKEW_MS)) {
    return accessToken;
  }

  const serviceAccountJson = credentials.service_account_json;
  if (typeof serviceAccountJson === 'string' && serviceAccountJson.trim()) {
    const minted = await mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson);
    return minted.accessToken;
  }

  throw Object.assign(new Error('BigQuery integration does not have a usable access token.'), { status: 400 });
}

async function listDatasetIds(client: { config: BigQueryConfig; token: string }): Promise<Record<string, JsonValue>> {
  const payload = await bigQueryFetch<{ datasets?: Array<{ datasetReference?: { datasetId?: string } }> }>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets`
  );
  return {
    projectId: client.config.projectId,
    datasetIds: (payload.datasets ?? [])
      .map((dataset) => dataset.datasetReference?.datasetId)
      .filter((datasetId): datasetId is string => Boolean(datasetId)),
  };
}

async function getDatasetInfo(
  client: { config: BigQueryConfig; token: string },
  datasetId: string
): Promise<Record<string, JsonValue>> {
  return await bigQueryFetch<Record<string, JsonValue>>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets/${encodeURIComponent(datasetId)}`
  );
}

async function listTableIds(
  client: { config: BigQueryConfig; token: string },
  datasetId: string
): Promise<Record<string, JsonValue>> {
  const payload = await bigQueryFetch<{
    tables?: Array<{
      tableReference?: { tableId?: string };
      type?: string;
    }>;
  }>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets/${encodeURIComponent(datasetId)}/tables`
  );
  return {
    projectId: client.config.projectId,
    datasetId,
    tables: (payload.tables ?? [])
      .map((table) => ({
        tableId: table.tableReference?.tableId ?? '',
        type: table.type ?? null,
      }))
      .filter((table) => table.tableId),
  };
}

async function getTableInfo(
  client: { config: BigQueryConfig; token: string },
  datasetId: string,
  tableId: string
): Promise<Record<string, JsonValue>> {
  return await bigQueryFetch<Record<string, JsonValue>>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/datasets/${encodeURIComponent(datasetId)}/tables/${encodeURIComponent(tableId)}`
  );
}

async function executeSqlReadonly(
  client: { config: BigQueryConfig; token: string },
  args: Record<string, unknown>
): Promise<Record<string, JsonValue>> {
  const query = requireString(args.query, 'query');

  const datasetId = datasetFromArgs(client.config, args, false) || null;
  const maxResults = boundedInteger(args.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_MAX_RESULTS, 'maxResults');
  const timeoutMs = boundedInteger(args.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS, 'timeoutMs');
  const maximumBytesBilled = maximumBytesBilledFromArgs(args.maximumBytesBilled);
  const queryConfig = {
    query,
    useLegacySql: false,
    maximumBytesBilled,
    ...(datasetId
      ? { defaultDataset: { projectId: client.config.projectId, datasetId } }
      : {}),
  };

  const dryRun = await bigQueryFetch<BigQueryJobResponse>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/jobs`,
    {
      method: 'POST',
      body: {
        configuration: {
          dryRun: true,
          query: queryConfig,
        },
      },
    }
  );
  // BigQuery has no per-query read-only flag, but the dry-run reports the parsed
  // statement type without executing — reject anything that isn't a read.
  assertBigQueryReadOnly(dryRun.statistics?.query?.statementType);

  const response = await bigQueryFetch<BigQueryQueryResponse>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/queries`,
    {
      method: 'POST',
      body: {
        ...queryConfig,
        maxResults,
        timeoutMs,
      },
    }
  );

  return {
    projectId: client.config.projectId,
    datasetId,
    jobReference: (response.jobReference ?? null) as JsonValue,
    jobComplete: Boolean(response.jobComplete),
    totalRows: response.totalRows ?? '0',
    totalBytesProcessed:
      response.totalBytesProcessed
      ?? dryRun.statistics?.query?.totalBytesProcessed
      ?? dryRun.statistics?.totalBytesProcessed
      ?? null,
    totalBytesBilled: dryRun.statistics?.query?.totalBytesBilled ?? null,
    cacheHit: response.cacheHit ?? dryRun.statistics?.query?.cacheHit ?? null,
    schema: (response.schema ?? { fields: [] }) as JsonValue,
    rows: formatRows(response.schema?.fields ?? [], response.rows ?? []) as JsonValue,
  };
}

/**
 * Export the FULL result of a query to the workspace warehouse (R2) as NDJSON
 * and return the R2 handle. BigQuery's REST `jobs.query`/`getQueryResults` path
 * returns JSON rows (no native Parquet stream), so we page through every result
 * page and stream NDJSON straight into the auto-expiring bucket without
 * buffering the whole result. The sealed DuckDB container reads it with
 * `read_json_auto`. (A native BigQuery → GCS Parquet extract is a future
 * optimization; the R2 key extension already records the format.)
 */
// BigQuery statement types (from the dry-run) that are read-only. Anything else
// (INSERT/UPDATE/DELETE/MERGE/CREATE_*/DROP_*/SCRIPT/CALL/…) is a write/DDL.
const BIGQUERY_READONLY_STATEMENT_TYPES = new Set(['SELECT']);

function assertBigQueryReadOnly(statementType: string | undefined): void {
  const type = (statementType ?? '').toUpperCase();
  if (!BIGQUERY_READONLY_STATEMENT_TYPES.has(type)) {
    throw Object.assign(
      new Error(
        `This method is read-only — BigQuery statement type "${statementType || 'UNKNOWN'}" is not allowed. Use a SELECT query.`,
      ),
      { status: 400 },
    );
  }
}

/**
 * Dry-run a query (no execution, no charge) and report what a real run would
 * scan, so callers can size `maximumBytesBilled` before paying for anything.
 */
async function estimateQuery(
  client: { config: BigQueryConfig; token: string },
  args: Record<string, unknown>
): Promise<Record<string, JsonValue>> {
  const query = requireString(args.query, 'query');
  const datasetId = datasetFromArgs(client.config, args, false) || null;
  const dryRun = await bigQueryFetch<BigQueryJobResponse>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/jobs`,
    {
      method: 'POST',
      body: {
        configuration: {
          dryRun: true,
          query: {
            query,
            useLegacySql: false,
            ...(datasetId ? { defaultDataset: { projectId: client.config.projectId, datasetId } } : {}),
          },
        },
      },
    }
  );
  const totalBytesProcessed =
    dryRun.statistics?.query?.totalBytesProcessed
    ?? dryRun.statistics?.totalBytesProcessed
    ?? null;
  const bytes = totalBytesProcessed === null ? null : Number(totalBytesProcessed);
  return {
    dryRun: true,
    statementType: dryRun.statistics?.query?.statementType ?? null,
    totalBytesProcessed,
    totalGbProcessed: bytes !== null && Number.isFinite(bytes)
      ? Math.round((bytes / 1_000_000_000) * 100) / 100
      : null,
    cacheHit: dryRun.statistics?.query?.cacheHit ?? null,
    defaultMaximumBytesBilled: DEFAULT_MAXIMUM_BYTES_BILLED,
    fitsDefaultBillingCap: bytes !== null && Number.isFinite(bytes)
      ? bytes <= Number(DEFAULT_MAXIMUM_BYTES_BILLED)
      : null,
  };
}

/** Dry-run a query (no execution, no charge) and return its parsed statement type. */
async function bigQueryStatementType(
  client: { config: BigQueryConfig; token: string },
  query: string,
  datasetId: string | null,
): Promise<string | undefined> {
  const dryRun = await bigQueryFetch<BigQueryJobResponse>(
    client,
    `/projects/${encodeURIComponent(client.config.projectId)}/jobs`,
    {
      method: 'POST',
      body: {
        configuration: {
          dryRun: true,
          query: {
            query,
            useLegacySql: false,
            ...(datasetId ? { defaultDataset: { projectId: client.config.projectId, datasetId } } : {}),
          },
        },
      },
    },
  );
  return dryRun.statistics?.query?.statementType;
}

async function runBigQueryWarehouseExport(
  env: BigQueryMcpEnv,
  context: BigQueryMcpContext,
  client: { config: BigQueryConfig; token: string },
  connectionId: string,
  query: string,
  datasetId: string | null,
  maximumBytesBilled: string,
): Promise<Record<string, JsonValue>> {
  const bucket = resolveObjectStoreBinding(
    env,
    'WAREHOUSE_EXPORT_BUCKET',
    env.WAREHOUSE_EXPORT_BUCKET,
  );
  // Reject writes/DDL before launching the export job (export is read-only).
  assertBigQueryReadOnly(await bigQueryStatementType(client, query, datasetId));
  // Fold the default dataset into the cache key: the same query text resolves to
  // different rows under different default datasets, so they must not collide.
  const keyInput = datasetId ? `${datasetId}:${query}` : query;
  const r2Key = warehouseExportKey(context.workspaceId, connectionId, keyInput, 'ndjson');
  // The stream populates these as it pages; an empty NDJSON file can't convey the
  // schema, so surface row count + columns in the result. rows: 0 is an explicit
  // signal that read_json_auto('/' + r2_key) will have nothing to infer.
  const stats: BigQueryExportStats = { rows: 0, columns: [] };
  await stageWarehouseExport(
    bucket,
    r2Key,
    bigQueryNdjsonStream(client, query, datasetId, maximumBytesBilled, stats),
    'ndjson',
  );
  return { ok: true, r2_key: r2Key, rows: stats.rows, columns: stats.columns };
}

interface BigQueryExportStats {
  rows: number;
  columns: string[];
}

/**
 * A lazily-paging NDJSON stream over a BigQuery query result. Each `pull` fetches
 * the next page (kicking off the job on the first pull, polling until the job
 * completes), so memory stays bounded and R2 backpressure flows through.
 */
function bigQueryNdjsonStream(
  client: { config: BigQueryConfig; token: string },
  query: string,
  datasetId: string | null,
  maximumBytesBilled: string,
  stats: BigQueryExportStats,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const projectPath = `/projects/${encodeURIComponent(client.config.projectId)}`;
  const defaultDataset = datasetId
    ? { defaultDataset: { projectId: client.config.projectId, datasetId } }
    : {};
  let fields: BigQueryField[] = [];
  let jobId = '';
  let location: string | undefined;
  let pageToken: string | undefined;
  let started = false;
  let finished = false;

  const captureColumns = () => {
    if (!stats.columns.length && fields.length) {
      stats.columns = fields.map((field, index) => field.name || `field_${index}`);
    }
  };

  const enqueueRows = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    rows: Array<{ f?: Array<{ v?: unknown }> }> | undefined,
  ) => {
    if (!rows?.length) return;
    stats.rows += rows.length;
    let chunk = '';
    for (const formatted of formatRows(fields, rows)) {
      chunk += `${JSON.stringify(formatted)}\n`;
    }
    if (chunk) controller.enqueue(encoder.encode(chunk));
  };

  const resultsPath = () => {
    const params = new URLSearchParams({
      maxResults: String(BIGQUERY_EXPORT_PAGE_SIZE),
      timeoutMs: String(BIGQUERY_EXPORT_TIMEOUT_MS),
    });
    if (pageToken) params.set('pageToken', pageToken);
    if (location) params.set('location', location);
    return `${projectPath}/queries/${encodeURIComponent(jobId)}?${params.toString()}`;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) {
          controller.close();
          return;
        }
        if (!started) {
          started = true;
          let response = await bigQueryFetch<BigQueryQueryResponse>(client, `${projectPath}/queries`, {
            method: 'POST',
            body: {
              query,
              useLegacySql: false,
              maximumBytesBilled,
              ...defaultDataset,
              maxResults: BIGQUERY_EXPORT_PAGE_SIZE,
              timeoutMs: BIGQUERY_EXPORT_TIMEOUT_MS,
            },
          });
          jobId = response.jobReference?.jobId ?? '';
          location = response.jobReference?.location;
          fields = response.schema?.fields ?? [];

          // jobs.query can return before the job completes; poll getQueryResults.
          let attempts = 0;
          while (!response.jobComplete) {
            if (attempts++ >= BIGQUERY_EXPORT_POLL_ATTEMPTS) {
              throw Object.assign(new Error('BigQuery export timed out waiting for the query to complete.'), { status: 504 });
            }
            if (!jobId) {
              throw Object.assign(new Error('BigQuery export did not return a job reference to poll.'), { status: 502 });
            }
            response = await bigQueryFetch<BigQueryQueryResponse>(client, resultsPath());
            if (!fields.length) fields = response.schema?.fields ?? [];
          }
          captureColumns(); // record columns even when there are zero rows
          enqueueRows(controller, response.rows);
          pageToken = response.pageToken;
          if (!pageToken) {
            finished = true;
            controller.close();
          }
          return;
        }
        const response = await bigQueryFetch<BigQueryQueryResponse>(client, resultsPath());
        if (!fields.length) fields = response.schema?.fields ?? [];
        captureColumns();
        enqueueRows(controller, response.rows);
        pageToken = response.pageToken;
        if (!pageToken) {
          finished = true;
          controller.close();
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

async function bigQueryFetch<T>(
  client: { config?: BigQueryConfig; token: string },
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(`${BIGQUERY_API_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${client.token}`,
      'content-type': 'application/json',
      ...(client.config?.projectId ? { 'x-goog-user-project': client.config.projectId } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as T & BigQueryErrorResponse : {} as T & BigQueryErrorResponse;

  if (!response.ok) {
    const detail = payload.error?.message
      || payload.error?.errors?.map((item) => item.message).filter(Boolean).join('; ')
      || `BigQuery API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status });
  }

  return payload as T;
}

function formatRows(
  fields: BigQueryField[],
  rows: Array<{ f?: Array<{ v?: unknown }> }>
): Array<Record<string, JsonValue>> {
  return rows.map((row) => {
    const values = row.f ?? [];
    const formatted: Record<string, JsonValue> = {};
    fields.forEach((field, index) => {
      const name = field.name || `field_${index}`;
      formatted[name] = convertBigQueryValue(field, values[index]?.v) as JsonValue;
    });
    return formatted;
  });
}

function convertBigQueryValue(field: BigQueryField, value: unknown): JsonValue {
  if (value == null) return null;
  if (field.mode === 'REPEATED' && Array.isArray(value)) {
    return value.map((item) => convertBigQueryValue({ ...field, mode: undefined }, (item as { v?: unknown })?.v));
  }
  if (field.type === 'RECORD' && typeof value === 'object' && value !== null && Array.isArray((value as { f?: unknown }).f)) {
    return formatRows(field.fields ?? [], [{ f: (value as { f: Array<{ v?: unknown }> }).f }])[0] ?? {};
  }
  if (field.type === 'BOOLEAN' || field.type === 'BOOL') {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function datasetFromArgs(
  config: BigQueryConfig,
  args: Record<string, unknown>,
  required = true
): string {
  const datasetId = typeof args.datasetId === 'string' && args.datasetId.trim()
    ? requireBigQueryId(args.datasetId, 'datasetId')
    : config.defaultDataset;
  if (!datasetId && required) {
    throw Object.assign(new Error('datasetId is required because the connection has no default dataset.'), {
      status: 400,
    });
  }
  return datasetId ?? '';
}

function requireBigQueryId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!BIGQUERY_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} must be a valid BigQuery identifier.`), { status: 400 });
  }
  return id;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number,
  field: string
): number {
  if (value == null) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw Object.assign(new Error(`${field} must be an integer from ${min} to ${max}.`), { status: 400 });
  }
  return parsed;
}

function maximumBytesBilledFromArgs(value: unknown): string {
  if (value == null || value === '') return DEFAULT_MAXIMUM_BYTES_BILLED;
  const raw = typeof value === 'number' ? String(value) : requireString(value, 'maximumBytesBilled');
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw Object.assign(new Error('maximumBytesBilled must be a positive integer string.'), { status: 400 });
  }
  return raw;
}

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
