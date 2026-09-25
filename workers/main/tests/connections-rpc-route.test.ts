import { describe, expect, it, vi } from 'vitest';
import { handleAuthenticatedConnectionsRpc } from '../src/routes/connections-rpc.js';
import type { ConnectionsRuntimeEnv } from '../src/connections-runtime.js';
import type { WorkspaceIntegrationRecord } from '../src/workspace.js';

function integration(overrides: Partial<WorkspaceIntegrationRecord>): WorkspaceIntegrationRecord {
  return {
    id: 'int_1',
    integration_type: 'postgres',
    name: 'main',
    category: 'databases',
    auth_method: 'password',
    config: JSON.stringify({ host: 'db.example.com', database: 'app' }),
    credentials_encrypted: '',
    created_by: 'user_1',
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    token_expires_at: null,
    auth_status: 'connected',
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

function envWith(records: WorkspaceIntegrationRecord[]): ConnectionsRuntimeEnv {
  const orgStub = {
    getWorkspaceIntegrations: async () => records,
    getWorkspaceIntegration: async (_workspaceId: string, integrationId: string) =>
      records.find((record) => record.id === integrationId) ?? null,
    updateWorkspaceIntegrationAuthStatus: async () => {},
    updateWorkspaceIntegrationVerification: async () => true,
  };

  return {
    INTEGRATION_SECRET_KEY: 'test-secret',
    ORG: {
      idFromName: (name: string) => name,
      get: () => orgStub,
    } as unknown as ConnectionsRuntimeEnv['ORG'],
  };
}

const AUTH = { orgId: 'org_1', workspaceId: 'ws_1', userId: 'user_1', threadId: 'thread_1' };

function rpcRequest(body: unknown): Request {
  return new Request('http://connections.internal/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-ray': 'ray_1',
    },
    body: JSON.stringify(body),
  });
}

describe('connections RPC', () => {
  it('lists connection methods through the stateless RPC endpoint', async () => {
    const records = [
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main' }),
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        auth_method: 'api_key',
        config: '{}',
      }),
    ];
    const req = rpcRequest({ action: 'methods' });

    const response = await handleAuthenticatedConnectionsRpc(req, envWith(records) as never, AUTH);

    const body = await response.json() as {
      result?: Array<{ alias: string; methods: Array<{ name: string; tool?: string }> }>;
    };
    expect(response.status).toBe(200);
    expect(body.result).toMatchObject([
      {
        alias: 'postgresMain',
        methods: expect.arrayContaining([expect.objectContaining({ name: 'query' })]),
      },
      {
        alias: 'resendTxn',
        methods: expect.arrayContaining([
          expect.objectContaining({ name: 'fetch', tool: 'authenticated_fetch' }),
        ]),
      },
    ]);
  });

  it('returns connection metadata without credentials', async () => {
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        credentials_encrypted: 'encrypted-value',
      }),
    ];
    const req = rpcRequest({ action: 'list' });

    const response = await handleAuthenticatedConnectionsRpc(req, envWith(records) as never, AUTH);

    const body = await response.json() as { result?: unknown };
    const connections = body.result;
    expect(connections).toMatchObject([
      {
        id: 'pg_main',
        hasCredentials: true,
      },
    ]);
    expect(JSON.stringify(connections)).not.toContain('encrypted-value');
  });

  it('verifies a connection through the stateless RPC endpoint', async () => {
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'inventory',
        category: 'saas',
        auth_method: 'api_key',
        config: JSON.stringify({ base_url: 'https://api.example.com', auth_type: 'none' }),
      }),
    ];
    const req = rpcRequest({ action: 'verify', query: { id: 'custom_api' } });

    const response = await handleAuthenticatedConnectionsRpc(req, envWith(records) as never, AUTH);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        status: 'configured',
        live: false,
        strategy: 'http_configuration',
      },
    });
  });

  it('propagates available thread and request ids into invocation telemetry', async () => {
    const records = [
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        auth_method: 'api_key',
        config: '{}',
      }),
    ];
    const env = envWith(records);
    const observabilityWrite = vi.fn();
    env.OBSERVABILITY_EVENTS = { writeDataPoint: observabilityWrite } as never;
    env.ERROR_ANALYTICS = { writeDataPoint: vi.fn() } as never;
    const req = rpcRequest({
      action: 'invoke',
      connection: 'resendTxn',
      method: 'missingMethod',
    });

    const response = await handleAuthenticatedConnectionsRpc(req, env as never, AUTH);

    expect(response.status).toBe(404);
    const point = observabilityWrite.mock.calls[0]![0] as { blobs: string[] };
    expect(point.blobs[8]).toBe('thread_1');
    expect(point.blobs[12]).toBe('ray_1');
    expect(point.blobs[13]).toBe('resend');
  });
});
