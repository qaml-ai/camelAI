import { describe, it, expect } from 'vitest';
import {
  dbErrorToLegacy,
  dbResultToLegacyResponse,
  exportRequestToDbQuery,
  mssqlRequestToDbQuery,
  mysqlRequestToDbQuery,
  postgresRequestToDbQuery,
} from '../workers/main/src/db-query-compat.js';

// These mappings ARE the legacy Go data-proxy contract (defaults, error codes,
// response shapes) that user-app DATA_PROXY bindings and the connection MCP
// depend on — treat changes as breaking.

const OPTS = { maxResponseBytes: 8 * 1024 * 1024 };

describe('postgresRequestToDbQuery', () => {
  const base = { mode: 'read' as const, host: 'db.example.com', user: 'u', password: 'p', query: 'SELECT 1' };

  it('applies the Go defaults: port 5432, database "postgres", sslmode require, uncapped rows', () => {
    const mapped = postgresRequestToDbQuery(base, OPTS);
    expect(mapped).toMatchObject({
      engine: 'postgres',
      mode: 'read',
      sql: 'SELECT 1',
      params: [],
      rowLimit: null,
      maxResponseBytes: OPTS.maxResponseBytes,
      target: { host: 'db.example.com', port: 5432, database: 'postgres', sslMode: 'require' },
    });
  });

  it('maps lib/pq sslmodes and rejects unknown ones', () => {
    expect(postgresRequestToDbQuery({ ...base, sslmode: 'verify-full' }, OPTS).target.sslMode).toBe('verify-full');
    expect(postgresRequestToDbQuery({ ...base, sslmode: 'verify-ca' }, OPTS).target.sslMode).toBe('verify-ca');
    expect(postgresRequestToDbQuery({ ...base, sslmode: 'disable' }, OPTS).target.sslMode).toBe('disable');
    expect(() => postgresRequestToDbQuery({ ...base, sslmode: 'prefer' }, OPTS)).toThrow(/unsupported sslmode "prefer"/);
  });

  it('requires host/user/password/query with the legacy message', () => {
    expect(() => postgresRequestToDbQuery({ ...base, password: ' ' }, OPTS)).toThrow(
      'Missing required fields: host, user, password, query',
    );
  });

  it('requires a valid mode with the legacy message', () => {
    expect(() => postgresRequestToDbQuery({ ...base, mode: 'write' as never }, OPTS)).toThrow(
      'Missing or invalid mode. Expected "read" or "modify"',
    );
  });
});

describe('mysqlRequestToDbQuery', () => {
  const base = { mode: 'read' as const, host: 'db.example.com', user: 'u', password: 'p', query: 'SELECT 1' };

  it('applies the Go defaults: port 3306, empty database allowed, tls preferred', () => {
    const mapped = mysqlRequestToDbQuery(base, OPTS);
    expect(mapped.target).toMatchObject({ port: 3306, database: '', sslMode: 'prefer' });
  });

  it('maps go-sql-driver tls values', () => {
    expect(mysqlRequestToDbQuery({ ...base, tls: 'true' }, OPTS).target.sslMode).toBe('verify-full');
    expect(mysqlRequestToDbQuery({ ...base, tls: 'false' }, OPTS).target.sslMode).toBe('disable');
    expect(mysqlRequestToDbQuery({ ...base, tls: 'skip-verify' }, OPTS).target.sslMode).toBe('require');
    expect(mysqlRequestToDbQuery({ ...base, tls: 'preferred' }, OPTS).target.sslMode).toBe('prefer');
    expect(() => mysqlRequestToDbQuery({ ...base, tls: 'custom' }, OPTS)).toThrow(/invalid value \/ unknown config name/);
  });

  it('passes the charset through', () => {
    expect(mysqlRequestToDbQuery({ ...base, charset: 'latin1' }, OPTS).target.charset).toBe('latin1');
    expect(mysqlRequestToDbQuery(base, OPTS).target.charset).toBeUndefined();
  });
});

describe('mssqlRequestToDbQuery', () => {
  const base = { mode: 'read' as const, server: 'db.example.com', user: 'u', password: 'p', query: 'SELECT 1' };

  it('applies the Go defaults: port 1433, database "master", encrypt+trust', () => {
    const mapped = mssqlRequestToDbQuery(base, OPTS);
    expect(mapped).toMatchObject({
      engine: 'mssql',
      params: {},
      target: { host: 'db.example.com', port: 1433, database: 'master', sslMode: 'require' },
    });
  });

  it('maps encrypt/trustServerCertificate to sslMode', () => {
    expect(mssqlRequestToDbQuery({ ...base, encrypt: false }, OPTS).target.sslMode).toBe('disable');
    expect(mssqlRequestToDbQuery({ ...base, trustServerCertificate: false }, OPTS).target.sslMode).toBe('verify-full');
    expect(mssqlRequestToDbQuery({ ...base, encrypt: true, trustServerCertificate: true }, OPTS).target.sslMode).toBe('require');
  });

  it('uses the legacy message with "server" as the host field', () => {
    expect(() => mssqlRequestToDbQuery({ ...base, server: '' }, OPTS)).toThrow(
      'Missing required fields: server, user, password, query',
    );
  });

  it('passes named params through', () => {
    expect(mssqlRequestToDbQuery({ ...base, params: { '@id': 7 } }, OPTS).params).toEqual({ '@id': 7 });
  });
});

describe('exportRequestToDbQuery', () => {
  it('marks the request as an export, forces read mode, and uses the export timeout', () => {
    const mapped = exportRequestToDbQuery(
      'postgres',
      { mode: 'modify', host: 'db.example.com', user: 'u', password: 'p', query: 'SELECT * FROM t' },
      OPTS,
    );
    expect(mapped.op).toBe('export');
    expect(mapped.mode).toBe('read'); // export ignores the body's mode, like the Go handler
    expect(mapped.timeoutMs).toBe(300_000);
  });
});

describe('dbResultToLegacyResponse', () => {
  const okResult = { ok: true as const, rows: [{ a: 1 }], fields: [{ name: 'a' }], rowCount: 1, truncated: false, durationMs: 2 };

  it('read → recordset only', () => {
    expect(dbResultToLegacyResponse('read', okResult)).toEqual({ recordset: [{ a: 1 }] });
  });

  it('modify → rowsAffected only', () => {
    expect(dbResultToLegacyResponse('modify', { ...okResult, rowsAffected: [3] })).toEqual({ rowsAffected: [3] });
    expect(dbResultToLegacyResponse('modify', okResult)).toEqual({ rowsAffected: [0] });
  });
});

describe('dbErrorToLegacy', () => {
  it('postgres keeps the SQLSTATE as the code', () => {
    expect(dbErrorToLegacy('postgres', { message: 'syntax error', code: '42601' })).toEqual({
      message: 'syntax error',
      status: 500,
      code: '42601',
      number: undefined,
    });
  });

  it('mysql driver errors become MYSQL_ERROR + number', () => {
    expect(dbErrorToLegacy('mysql', { message: 'dup', code: 'ER_DUP_ENTRY', number: 1062 })).toMatchObject({
      code: 'MYSQL_ERROR',
      number: 1062,
    });
  });

  it('mssql driver errors become MSSQL_ERROR + number', () => {
    expect(dbErrorToLegacy('mssql', { message: 'bad', number: 102 })).toMatchObject({
      code: 'MSSQL_ERROR',
      number: 102,
    });
  });

  it('infra errors get the legacy statuses', () => {
    expect(dbErrorToLegacy('postgres', { message: 'refused', code: 'ECONNREFUSED' })).toMatchObject({ status: 503, code: 'ECONNREFUSED' });
    expect(dbErrorToLegacy('postgres', { message: 'nx', code: 'ENOTFOUND' })).toMatchObject({ status: 503, code: 'ENOTFOUND' });
    expect(dbErrorToLegacy('postgres', { message: 'nx', code: 'EAI_AGAIN' })).toMatchObject({ status: 503, code: 'ENOTFOUND' });
    expect(dbErrorToLegacy('postgres', { message: 'slow', code: 'ETIMEDOUT' })).toMatchObject({ status: 504, code: 'ETIMEOUT' });
    expect(dbErrorToLegacy('postgres', { message: 'timeout', status: 504 })).toMatchObject({ status: 504, code: 'ETIMEOUT' });
  });

  it('runner 4xx statuses pass through (SSRF guard, validation, 413 size cap)', () => {
    expect(dbErrorToLegacy('postgres', { message: 'too large', status: 413 })).toMatchObject({ status: 413 });
    expect(dbErrorToLegacy('postgres', { message: 'blocked', status: 400 })).toMatchObject({ status: 400 });
  });
});
