import { describe, it, expect } from 'vitest';
import { mssqlQuery, mysqlQuery, postgresQuery } from '../src/data-proxy.js';
import { fakeDbQuerySandboxNamespace } from './fake-db-query-sandbox.js';

const CONTEXT = { orgId: 'org-1', workspaceId: 'ws-1' };

const cases = [
  {
    name: 'mssql',
    run: mssqlQuery,
    body: {
      mode: 'read',
      server: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT 1',
    },
    // Legacy Go defaults the compat layer must reproduce.
    expectedRequest: {
      engine: 'mssql',
      mode: 'read',
      sql: 'SELECT 1',
      target: { host: 'db.example.com', port: 1433, database: 'master', sslMode: 'require' },
    },
  },
  {
    name: 'postgres',
    run: postgresQuery,
    body: {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT $1::int as value',
      params: [123],
    },
    expectedRequest: {
      engine: 'postgres',
      mode: 'read',
      sql: 'SELECT $1::int as value',
      params: [123],
      target: { host: 'db.example.com', port: 5432, database: 'postgres', sslMode: 'require' },
    },
  },
  {
    name: 'mysql',
    run: mysqlQuery,
    body: {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT ? as value',
      params: [321],
    },
    expectedRequest: {
      engine: 'mysql',
      mode: 'read',
      sql: 'SELECT ? as value',
      params: [321],
      target: { host: 'db.example.com', port: 3306, database: '', sslMode: 'prefer' },
    },
  },
] as const;

describe('data-proxy legacy request mapping', () => {
  for (const testCase of cases) {
    it(`runs ${testCase.name} query in the db-query sandbox with the legacy request mapping`, async () => {
      const fake = fakeDbQuerySandboxNamespace((request) => {
        expect(request).toMatchObject(testCase.expectedRequest);
        // Legacy surfaces are uncapped-rows + byte-capped, never row-limited.
        expect(request.rowLimit).toBeNull();
        return { ok: true, rows: [{ value: 1 }], fields: [{ name: 'value' }], rowCount: 1, truncated: false, durationMs: 2 };
      });

      const run = testCase.run as (env: never, context: typeof CONTEXT, request: never) => Promise<unknown>;
      const result = await run({ DB_QUERY_SANDBOX: fake.namespace } as never, CONTEXT, testCase.body as never);

      expect(fake.calls).toHaveLength(1);
      expect(result).toEqual({ recordset: [{ value: 1 }] });
    });
  }

  it('modify mode returns rowsAffected only', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request.mode).toBe('modify');
      return { ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 2, rowsAffected: [3] };
    });

    const result = await postgresQuery({ DB_QUERY_SANDBOX: fake.namespace } as never, CONTEXT, {
      mode: 'modify',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'UPDATE t SET x = 1',
    } as never);

    expect(result).toEqual({ rowsAffected: [3] });
  });

  it('surfaces runner errors with the legacy status', async () => {
    const fake = fakeDbQuerySandboxNamespace(() => ({
      ok: false,
      error: { message: 'connect ECONNREFUSED', code: 'ECONNREFUSED' },
    }));

    const error = await postgresQuery({ DB_QUERY_SANDBOX: fake.namespace } as never, CONTEXT, {
      mode: 'read',
      host: 'db.example.com',
      user: 'user',
      password: 'pass',
      query: 'SELECT 1',
    } as never).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('connect ECONNREFUSED');
    expect((error as { status?: number }).status).toBe(503);
  });
});
