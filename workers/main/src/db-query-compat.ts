/**
 * Legacy data-proxy contract ↔ DbQuerySandbox mapping — PURE functions.
 *
 * The retired Go data-proxy (project-runtime-service cmd/data-proxy) defined
 * the request/response shapes that `DATA_PROXY` user-app bindings, the sandbox
 * container routes, and the connection MCP all still speak. This module maps
 * those shapes onto the db-query runner's request/result contract so the
 * public surface in data-proxy.ts stays byte-compatible while the transport
 * moves to the Cloudflare sandbox container.
 *
 * No imports with side effects, no `cloudflare:` modules — node vitest
 * (tests/db-query-compat.test.ts) exercises these mappings directly.
 */

import type { DbQueryRequest, DbQueryResult } from './db-query-service.js';
import type {
  MssqlQueryRequest,
  MysqlQueryRequest,
  PostgresQueryRequest,
  SqlQueryMode,
} from './data-proxy.js';

// Go data-proxy defaults (data_proxy.go).
const DEFAULT_MSSQL_PORT = 1433;
const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_MYSQL_PORT = 3306;
const DEFAULT_MSSQL_DATABASE = 'master';
const DEFAULT_POSTGRES_DATABASE = 'postgres';
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
// Bulk exports are explicitly the no-row-cap path and can include remote
// GROUP BY work over millions of rows. Two minutes was shorter than the real
// SecLock D365 tier aggregation even though the connection and stream were
// healthy; keep it below the 10-minute agent-turn stall budget while allowing
// the database enough time to produce the first/remaining rows.
const DEFAULT_EXPORT_TIMEOUT_MS = 300_000;

export type LegacyEngine = 'postgres' | 'mysql' | 'mssql';

export interface LegacyMappingOptions {
  /** Serialized-response byte cap (DATA_PROXY_MAX_RESPONSE_BYTES parity). */
  maxResponseBytes: number;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function requireFields(host: unknown, user: unknown, password: unknown, query: unknown, hostField: string): void {
  const missing =
    typeof host !== 'string' || !host.trim() ||
    typeof user !== 'string' || !user.trim() ||
    typeof password !== 'string' || !password.trim() ||
    typeof query !== 'string' || !query.trim();
  if (missing) {
    // Byte-for-byte the Go data-proxy message.
    throw badRequest(`Missing required fields: ${hostField}, user, password, query`);
  }
}

function requireMode(mode: unknown): SqlQueryMode {
  if (mode === 'read' || mode === 'modify') return mode;
  throw badRequest('Missing or invalid mode. Expected "read" or "modify"');
}

function effectivePort(port: unknown, fallback: number): number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : fallback;
}

/** lib/pq sslmode → runner sslMode. Unknown values error like lib/pq did. */
function postgresSslMode(sslmode: unknown): NonNullable<DbQueryRequest['target']['sslMode']> {
  const value = typeof sslmode === 'string' && sslmode.trim() ? sslmode.trim() : 'require';
  switch (value) {
    case 'disable':
    case 'require':
    case 'verify-ca':
    case 'verify-full':
      return value;
    default:
      throw badRequest(`unsupported sslmode "${value}"`);
  }
}

/** go-sql-driver tls param → runner sslMode. Unknown values error like the DSN did. */
function mysqlSslMode(tls: unknown): NonNullable<DbQueryRequest['target']['sslMode']> {
  const value = typeof tls === 'string' && tls.trim() ? tls.trim() : 'preferred';
  switch (value) {
    case 'false':
      return 'disable';
    case 'true':
      // go-sql-driver "true" verifies against system CAs incl. hostname.
      return 'verify-full';
    case 'skip-verify':
      return 'require';
    case 'preferred':
      return 'prefer';
    default:
      throw badRequest(`invalid value / unknown config name: ${value}`);
  }
}

/** mssql encrypt/trustServerCertificate (legacy defaults true/true) → runner sslMode. */
function mssqlSslMode(encrypt: unknown, trustServerCertificate: unknown): NonNullable<DbQueryRequest['target']['sslMode']> {
  const encryptEnabled = encrypt === undefined || encrypt === null ? true : encrypt === true;
  const trust = trustServerCertificate === undefined || trustServerCertificate === null ? true : trustServerCertificate === true;
  if (!encryptEnabled) return 'disable';
  return trust ? 'require' : 'verify-full';
}

export function postgresRequestToDbQuery(request: PostgresQueryRequest, options: LegacyMappingOptions): DbQueryRequest {
  requireFields(request.host, request.user, request.password, request.query, 'host');
  const mode = requireMode(request.mode);
  return {
    engine: 'postgres',
    mode,
    sql: request.query,
    params: request.params ?? [],
    rowLimit: null,
    timeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes,
    target: {
      host: request.host.trim(),
      port: effectivePort(request.port, DEFAULT_POSTGRES_PORT),
      user: request.user,
      password: request.password,
      database: request.database?.trim() ? request.database : DEFAULT_POSTGRES_DATABASE,
      sslMode: postgresSslMode(request.sslmode),
    },
  };
}

export function mysqlRequestToDbQuery(request: MysqlQueryRequest, options: LegacyMappingOptions): DbQueryRequest {
  requireFields(request.host, request.user, request.password, request.query, 'host');
  const mode = requireMode(request.mode);
  return {
    engine: 'mysql',
    mode,
    sql: request.query,
    params: request.params ?? [],
    rowLimit: null,
    timeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes,
    target: {
      host: request.host.trim(),
      port: effectivePort(request.port, DEFAULT_MYSQL_PORT),
      user: request.user,
      password: request.password,
      database: request.database?.trim() ? request.database : '',
      sslMode: mysqlSslMode(request.tls),
      charset: request.charset?.trim() ? request.charset.trim() : undefined,
    },
  };
}

export function mssqlRequestToDbQuery(request: MssqlQueryRequest, options: LegacyMappingOptions): DbQueryRequest {
  requireFields(request.server, request.user, request.password, request.query, 'server');
  const mode = requireMode(request.mode);
  return {
    engine: 'mssql',
    mode,
    sql: request.query,
    params: request.params ?? {},
    rowLimit: null,
    timeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes,
    target: {
      host: request.server.trim(),
      port: effectivePort(request.port, DEFAULT_MSSQL_PORT),
      user: request.user,
      password: request.password,
      database: request.database?.trim() ? request.database : DEFAULT_MSSQL_DATABASE,
      sslMode: mssqlSslMode(request.encrypt, request.trustServerCertificate),
    },
  };
}

/**
 * Legacy `/{engine}/export` body → export DbQueryRequest. Export is always
 * read-only (the runner enforces it) and uses the generous export timeout;
 * `mode` in the body is ignored, exactly like the Go handler.
 */
export function exportRequestToDbQuery(
  engine: LegacyEngine,
  body: Record<string, unknown>,
  options: LegacyMappingOptions,
): DbQueryRequest {
  const mapped =
    engine === 'postgres'
      ? postgresRequestToDbQuery({ ...(body as unknown as PostgresQueryRequest), mode: 'read' }, options)
      : engine === 'mysql'
        ? mysqlRequestToDbQuery({ ...(body as unknown as MysqlQueryRequest), mode: 'read' }, options)
        : mssqlRequestToDbQuery({ ...(body as unknown as MssqlQueryRequest), mode: 'read' }, options);
  return { ...mapped, op: 'export', timeoutMs: DEFAULT_EXPORT_TIMEOUT_MS };
}

export interface LegacyQueryResponse {
  recordset?: Record<string, unknown>[];
  rowsAffected?: number[];
}

/** Runner success → legacy response: read → recordset only, modify → rowsAffected only. */
export function dbResultToLegacyResponse(mode: SqlQueryMode, result: Extract<DbQueryResult, { ok: true }>): LegacyQueryResponse {
  if (mode === 'modify') {
    return { rowsAffected: result.rowsAffected ?? [0] };
  }
  return { recordset: result.rows };
}

export interface LegacyErrorShape {
  message: string;
  status: number;
  code?: string;
  number?: number;
}

/**
 * Runner error → legacy error shape (Go writeMssqlError/writePostgresError/
 * writeMySQLError + inferSQLErrorStatus parity):
 *   - postgres: `code` is the SQLSTATE (node-pg and lib/pq agree);
 *   - mysql/mssql: driver errors carry `number` and get the constant code;
 *   - infra: refused/unknown-host → 503, timeouts → 504 + ETIMEOUT.
 */
export function dbErrorToLegacy(engine: LegacyEngine, error: Extract<DbQueryResult, { ok: false }>['error']): LegacyErrorShape {
  let status = typeof error.status === 'number' ? error.status : 500;
  let code = error.code;
  let num = error.number;

  switch (code) {
    case 'ECONNREFUSED':
      status = 503;
      break;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      status = 503;
      code = 'ENOTFOUND';
      break;
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
      status = 504;
      code = 'ETIMEOUT';
      break;
    default:
      if (status === 504 && !code) code = 'ETIMEOUT';
      break;
  }

  // Driver errors: the legacy contract used a constant code + the numeric
  // driver error for mysql/mssql; postgres kept the SQLSTATE as the code.
  if (typeof num === 'number') {
    if (engine === 'mysql') code = 'MYSQL_ERROR';
    if (engine === 'mssql') code = 'MSSQL_ERROR';
  } else {
    num = undefined;
  }

  return { message: error.message, status, code, number: num };
}
