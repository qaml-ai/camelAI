import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTIONS_BINDING_DISABLED_CODE,
  CONNECTIONS_BINDING_DISABLED_MESSAGE,
} from '../../../src/lib/connections-binding';
import { createConnections } from '../../../sandbox/create-worker/templates/starter/app/lib/connections';
import { ConnectionsService } from '../src/connections-service';

describe('ConnectionsService compatibility', () => {
  it('fails closed when CONNECTIONS_BINDING_ENABLED is false', async () => {
    const service = Object.create(ConnectionsService.prototype) as ConnectionsService;
    Object.defineProperty(service, 'env', {
      value: { CONNECTIONS_BINDING_ENABLED: 'false' },
    });
    Object.defineProperty(service, 'ctx', {
      value: { props: { orgId: 'org_1', workspaceId: 'ws_1' } },
    });

    await expect(service.list()).rejects.toMatchObject({
      message: CONNECTIONS_BINDING_DISABLED_MESSAGE,
      status: 503,
      code: CONNECTIONS_BINDING_DISABLED_CODE,
    });
    await expect(service.invoke({ connection: 'db', method: 'query' })).rejects.toMatchObject({
      code: CONNECTIONS_BINDING_DISABLED_CODE,
      status: 503,
    });
  });

  it('keeps the legacy hidden invoke entrypoint for already-deployed apps', async () => {
    const legacyInvokeMethod = ['_', '_', 'invoke'].join('');
    const invoke = vi.fn(async (request: unknown) => ({ ok: true, request }));
    const service = { invoke };
    const request = {
      connection: 'remoteMcpAdmin',
      method: 'getDashboardSummary',
      input: { date: '2026-05-29' },
    };

    const result = await (ConnectionsService.prototype as any)[legacyInvokeMethod].call(
      service,
      request,
    );

    expect(result).toEqual({ ok: true, request });
    expect(invoke).toHaveBeenCalledWith(request);
  });

  it('starter createConnections calls the service binding method without detaching it', async () => {
    const invoke = vi.fn(async function(this: unknown, request: unknown) {
      return { receiver: this, request };
    });
    const binding = {
      invoke,
      find: vi.fn(async () => ({ alias: 'remoteMcpAdmin' })),
    };
    const connections = createConnections({ CONNECTIONS: binding as any });
    const admin = await (binding.find as any)('admin');

    const result = await (connections as any)[admin.alias].getDashboardSummary({
      date: '2026-05-29',
    });

    expect(result).toEqual({
      receiver: binding,
      request: {
        connection: 'remoteMcpAdmin',
        method: 'getDashboardSummary',
        input: { date: '2026-05-29' },
      },
    });
  });

  it('routes other.fetch through invoke and reconstructs a Response', async () => {
    const invoke = vi.fn(async () => ({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      bodyText: '{"ok":true}',
      truncated: false,
    }));
    const binding = { invoke };
    const connections = createConnections({ CONNECTIONS: binding as any });

    const response = await (connections as any).otherCloudflareAnalyticsReadOnly.fetch(
      '/client/v4/accounts/example/storage/kv/namespaces/example/keys',
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
    );

    expect(invoke).toHaveBeenCalledWith({
      connection: 'otherCloudflareAnalyticsReadOnly',
      method: 'fetch',
      input: {
        input: '/client/v4/accounts/example/storage/kv/namespaces/example/keys',
        init: {
          method: 'GET',
          headers: { accept: 'application/json' },
        },
      },
    });
    expect(response).toBeInstanceOf(Response);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
