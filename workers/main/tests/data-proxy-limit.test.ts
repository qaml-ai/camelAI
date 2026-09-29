import { describe, expect, it } from 'vitest';
import { mssqlQuery, postgresQuery } from '../src/data-proxy.js';
import { fakeDbQuerySandboxNamespace } from './fake-db-query-sandbox.js';

const CONTEXT = { orgId: 'org-1', workspaceId: 'ws-1' };

describe('data-proxy response limits', () => {
  it('hands DATA_PROXY_MAX_RESPONSE_BYTES to the runner as the byte cap', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request.maxResponseBytes).toBe(32);
      // The runner enforces the cap next to the query and reports a 413.
      return { ok: false, error: { message: 'Query response too large (999 bytes > limit 32 bytes)', status: 413 } };
    });

    await expect(mssqlQuery(
      {
        DB_QUERY_SANDBOX: fake.namespace as never,
        DATA_PROXY_MAX_RESPONSE_BYTES: '32',
      },
      CONTEXT,
      {
        mode: 'read',
        server: 'db.example.com',
        user: 'user',
        password: 'pass',
        query: 'SELECT 1',
      },
    )).rejects.toMatchObject({
      status: 413,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('defaults the byte cap to 8 MiB when the env var is unset', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request.maxResponseBytes).toBe(8 * 1024 * 1024);
      return { ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 1 };
    });

    await expect(postgresQuery(
      { DB_QUERY_SANDBOX: fake.namespace as never },
      CONTEXT,
      { mode: 'read', host: 'db.example.com', user: 'u', password: 'p', query: 'SELECT 1' },
    )).resolves.toEqual({ recordset: [] });
  });

  it('fails loudly when the container binding is missing', async () => {
    // .then-capture instead of .rejects: workerd flags the rejection as
    // unhandled before the matcher attaches its handler.
    const error = await postgresQuery(
      {},
      CONTEXT,
      { mode: 'read', host: 'db.example.com', user: 'u', password: 'p', query: 'SELECT 1' },
    ).then(() => null, (thrown: unknown) => thrown);
    expect(error).toMatchObject({ status: 500, message: expect.stringContaining('DB_QUERY_SANDBOX') });
  });
});

describe('data-proxy sandbox sessions', () => {
  it("runs every exec sessionless so a workspace's calls do not queue behind one shell", async () => {
    const fake = fakeDbQuerySandboxNamespace(() => (
      { ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 1 }
    ));

    await postgresQuery(
      {
        DB_QUERY_SANDBOX: fake.namespace as never,
        DB_EGRESS_RELAY_HOSTNAME: 'db-relay.example.com',
        DB_EGRESS_RELAY_SOCKS_USERNAME: 'u',
        DB_EGRESS_RELAY_SOCKS_PASSWORD: 'p',
      },
      CONTEXT,
      { mode: 'read', host: 'db.example.com', user: 'u', password: 'p', query: 'SELECT 1' },
    );

    // Relay probe + runner, neither on the shared default session.
    expect(fake.execSessions.length).toBeGreaterThanOrEqual(2);
    expect(fake.execSessions).not.toContain('default');
    expect(fake.stub.exec).not.toHaveBeenCalled();
  });
});
