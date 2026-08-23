/**
 * Legacy data-proxy surface, served by the DbQuerySandbox container.
 *
 * This module keeps the request/response contract of the retired Go
 * data-proxy (project-runtime-service cmd/data-proxy) — the shapes that the
 * `DATA_PROXY` user-app service binding, the sandbox container routes, and
 * the connection MCP all speak — but executes queries in the Cloudflare
 * sandbox container (db-query-service.ts) instead of forwarding to the Azure
 * VM over the SANDBOX_HOST VPC binding. With an egress relay configured the
 * database still sees the VM's static IP (docs/db-egress-relay.md); without
 * one, queries dial from the container's own IP.
 *
 * The pure request/response/error mapping lives in db-query-compat.ts; this
 * file is the thin orchestration (sandbox resolution + dispatch).
 */

import { getSandbox } from '@cloudflare/sandbox';

import {
  relayConfigFromEnv,
  runDbExport,
  runDbQuery,
  type DbEgressRelayEnv,
  type DbQueryDeps,
  type DbQueryRequest,
  type DbQuerySandboxStub,
} from './db-query-service.js';
import {
  dbErrorToLegacy,
  dbResultToLegacyResponse,
  exportRequestToDbQuery,
  mssqlRequestToDbQuery,
  mysqlRequestToDbQuery,
  postgresRequestToDbQuery,
  type LegacyEngine,
} from './db-query-compat.js';
import { recordObservabilityEvent, type ObservabilityEnv } from './observability.js';
import { warehouseWorkspacePrefix } from './warehouse-export.js';
import { resolveComputeSandbox } from './binding-facades/compute.js';

const DEFAULT_DATA_PROXY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface DataProxyEnv extends DbEgressRelayEnv, ObservabilityEnv {
  DB_QUERY_SANDBOX?: DurableObjectNamespace<import('./db-query-sandbox.js').DbQuerySandbox>;
  COMPUTE_SERVICE?: Fetcher;
  OBJECT_STORE_SERVICE?: Fetcher;
  DATA_PROXY_MAX_RESPONSE_BYTES?: string;
}

export interface DataProxyContext {
  orgId: string;
  workspaceId: string;
}

type DataProxyError = Error & {
  status?: number;
  code?: string;
  number?: number;
};

function createDataProxyError(message: string, status?: number, code?: string, num?: number): DataProxyError {
  const error = new Error(message) as DataProxyError;
  error.status = status;
  error.code = code;
  error.number = num;
  return error;
}

function resolveMaxResponseBytes(env: DataProxyEnv): number {
  const raw = (env.DATA_PROXY_MAX_RESPONSE_BYTES ?? '').trim();
  if (!raw) return DEFAULT_DATA_PROXY_MAX_RESPONSE_BYTES;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DATA_PROXY_MAX_RESPONSE_BYTES;
  }
  return parsed;
}

/**
 * Container deps for this workspace's queries. One sandbox per workspace: a
 * workspace's queries share a warm container (and its relay forwarder) while
 * tenants never share one.
 */
function resolveDbQueryDeps(env: DataProxyEnv, context: DataProxyContext): DbQueryDeps {
  if (!env.DB_QUERY_SANDBOX && !env.COMPUTE_SERVICE) {
    throw createDataProxyError('DB_QUERY_SANDBOX container binding is not configured', 500);
  }
  const sandboxId = `ws-${context.workspaceId}`;
  const sandbox = resolveComputeSandbox<DbQuerySandboxStub>(env, {
    kind: 'db-query',
    id: sandboxId,
    nativeAvailable: Boolean(env.DB_QUERY_SANDBOX),
    native: () => getSandbox(env.DB_QUERY_SANDBOX!, sandboxId, {
      normalizeId: true,
    }) as unknown as DbQuerySandboxStub,
  });
  return {
    sandbox,
    relay: relayConfigFromEnv(env),
    // A query we stopped waiting for is a container problem, not a SQL one:
    // give it its own event so it is visible next to the other sandbox
    // deadline exceedances rather than hiding inside the generic query errors.
    onDeadlineExceeded: (event) => {
      console.error('[data-proxy] db query exceeded its client deadline', {
        operation: event.operation,
        budgetMs: event.budgetMs,
        waitedMs: event.waitedMs,
        workspaceId: context.workspaceId,
      });
      recordObservabilityEvent(env, {
        event: 'sandbox_exec_deadline_exceeded',
        severity: 'error',
        component: 'DataProxy',
        operation: event.operation,
        status: 'deadline_exceeded',
        durationMs: event.waitedMs,
        size: event.budgetMs,
        errorName: 'SandboxDeadlineExceededError',
        workspaceId: context.workspaceId,
        orgId: context.orgId,
      });
    },
  };
}

async function executeLegacyQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  engine: LegacyEngine,
  mode: SqlQueryMode,
  request: DbQueryRequest,
): Promise<{ recordset?: Record<string, unknown>[]; rowsAffected?: number[] }> {
  const result = await runDbQuery(resolveDbQueryDeps(env, context), request);
  if (!result.ok) {
    const legacy = dbErrorToLegacy(engine, result.error);
    throw createDataProxyError(legacy.message, legacy.status, legacy.code, legacy.number);
  }
  return dbResultToLegacyResponse(mode, result);
}

export async function mssqlQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: MssqlQueryRequest
): Promise<MssqlQueryResponse> {
  const mapped = mssqlRequestToDbQuery(request, { maxResponseBytes: resolveMaxResponseBytes(env) });
  return await executeLegacyQuery(env, context, 'mssql', request.mode, mapped);
}

export async function postgresQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: PostgresQueryRequest
): Promise<PostgresQueryResponse> {
  const mapped = postgresRequestToDbQuery(request, { maxResponseBytes: resolveMaxResponseBytes(env) });
  return await executeLegacyQuery(env, context, 'postgres', request.mode, mapped);
}

export async function mysqlQuery(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: MysqlQueryRequest
): Promise<MysqlQueryResponse> {
  const mapped = mysqlRequestToDbQuery(request, { maxResponseBytes: resolveMaxResponseBytes(env) });
  return await executeLegacyQuery(env, context, 'mysql', request.mode, mapped);
}

export interface SqlExportRequest {
  engine: 'mysql' | 'postgres' | 'mssql';
  /** Connection + query payload, identical in shape to the `/query` body. */
  body: Record<string, unknown>;
  /** Destination R2 key — must live inside this workspace's warehouse prefix. */
  r2Key: string;
}

/**
 * Run a bulk read-only export (Parquet) in the db-query sandbox, written
 * DIRECTLY to the workspace's warehouse R2 prefix via the container's
 * credential-less bucket mount — nothing streams through the Worker. The
 * runner enforces the export timeout and unlinks a partial file on failure;
 * callers should still HEAD-verify the staged object. Throws loudly (with the
 * runner's error) on failure.
 */
export async function sqlExportToWarehouse(
  env: DataProxyEnv,
  context: DataProxyContext,
  request: SqlExportRequest
): Promise<{ rowCount: number; bytes: number }> {
  const prefix = warehouseWorkspacePrefix(context.workspaceId);
  if (!request.r2Key.startsWith(`${prefix}/`)) {
    // Internal invariant: the caller derives the key from the same workspace.
    throw createDataProxyError(
      `export r2Key "${request.r2Key}" is outside the workspace warehouse prefix "${prefix}/"`,
      500
    );
  }
  const mapped = exportRequestToDbQuery(request.engine, request.body, {
    maxResponseBytes: resolveMaxResponseBytes(env),
  });
  const result = await runDbExport(resolveDbQueryDeps(env, context), mapped, prefix, `/${request.r2Key}`);
  if (!result.ok) {
    const legacy = dbErrorToLegacy(request.engine, result.error);
    throw createDataProxyError(legacy.message, legacy.status, legacy.code, legacy.number);
  }
  return { rowCount: result.rowCount, bytes: result.bytes };
}


// =============================================================================
// MS SQL Server Types
// =============================================================================

export type SqlQueryMode = 'read' | 'modify';

export interface MssqlQueryRequest {
  mode: SqlQueryMode;
  server: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: Record<string, unknown>;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export interface MssqlQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}

// =============================================================================
// Postgres Types
// =============================================================================

export interface PostgresQueryRequest {
  mode: SqlQueryMode;
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: unknown[];
  sslmode?: string;
}

export interface PostgresQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}

// =============================================================================
// MySQL Types
// =============================================================================

export interface MysqlQueryRequest {
  mode: SqlQueryMode;
  host: string;
  port?: number;
  user: string;
  password: string;
  database?: string;
  query: string;
  params?: unknown[];
  tls?: string;
  charset?: string;
}

export interface MysqlQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
  error?: string;
  code?: string;
  number?: number;
}
