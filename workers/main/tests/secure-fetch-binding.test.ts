import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { SECURE_FETCH_REDIRECT_HEADER, type SecureFetchEnv } from '../src/secure-fetch';
import { SecureFetchBinding } from '../src/secure-fetch-service';
import { performWorkspaceAppFetch } from '../src/workspace-app-fetcher';

/**
 * Regression tests for js_exec workspace-app auto-auth via SecureFetchBinding.
 *
 * Main app workers route workspace-app fetches through the dispatcher service
 * dispatcher default entrypoint RPC, not a dispatch namespace on the main worker.
 */

const WORKSPACE_APP_HOST = 'water-tracker--ms-workspace-d05.staging.camelai.app';
const WORKSPACE_APP_URL = `https://${WORKSPACE_APP_HOST}/api/water`;

function workspaceHostIndex() {
  return {
    hostnames: new Set([WORKSPACE_APP_HOST]),
    routesByHostname: new Map([
      [WORKSPACE_APP_HOST, {
        scriptName: 'water-tracker',
        orgSlug: 'ms-workspace-d05',
        dispatchScriptName: 'water-tracker--ms-workspace-d05',
        workspaceId: 'workspace1',
        orgId: 'org1',
        isPublic: false,
      }],
    ]),
  };
}

function dispatcherServiceEnv(fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))) {
  return {
    DISPATCHER: { fetchWorkspaceApp: fetchMock },
    ORG: env.ORG,
    WORKER_BASE_URL: 'https://staging.camelai.dev',
  };
}

describe('secure fetch binding regression', () => {
  it.each([
    ['follow', 200, ['/api/water', '/final']],
    ['manual', 302, ['/api/water']],
  ] as const)('uses the caller\'s %s mode when Workerd sends a manual HTTP request', async (mode, status, paths) => {
    const fetchWorkspaceApp = vi.fn(async (request: Request) => {
      expect(request.redirect).toBe('manual');
      expect(request.headers.has(SECURE_FETCH_REDIRECT_HEADER)).toBe(false);
      return new URL(request.url).pathname === '/api/water'
        ? new Response(null, { status: 302, headers: { Location: '/final' } })
        : new Response('done');
    });
    const context = { orgId: 'org1', workspaceId: 'workspace1' };
    const binding = new SecureFetchBinding(
      { props: context } as ExecutionContext,
      {
        DISPATCHER: { fetchWorkspaceApp },
        ORG: {
          idFromName: () => context.orgId,
          get: () => ({
            getInfo: async () => ({ slug: 'ms-workspace-d05' }),
            listWorkerScriptsByWorkspace: async () => [{
              script_name: 'water-tracker',
              is_public: false,
              custom_domain_hostname: WORKSPACE_APP_HOST,
              custom_domain_status: 'active',
              custom_domain_ssl_status: 'active',
            }],
          }),
        } as unknown as SecureFetchEnv['ORG'],
        WORKER_BASE_URL: 'https://staging.camelai.dev',
      },
    );
    const response = await binding.fetch(new Request(WORKSPACE_APP_URL, {
      headers: { [SECURE_FETCH_REDIRECT_HEADER]: mode },
      redirect: 'manual',
    }));

    expect(response.status).toBe(status);
    expect(fetchWorkspaceApp.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(paths);
  });

  it('requires DISPATCHER to be a service binding with fetchWorkspaceApp()', () => {
    return expect(performWorkspaceAppFetch(
      {
        DISPATCHER: { get: vi.fn() } as never,
        ORG: env.ORG,
        WORKER_BASE_URL: 'https://staging.camelai.dev',
      },
      { orgId: 'org1', workspaceId: 'workspace1' },
      WORKSPACE_APP_URL,
      undefined,
      { getHostIndex: async () => workspaceHostIndex() },
    )).rejects.toThrow(/DISPATCHER service binding is not configured/i);
  });

  it('fetches workspace app URLs through the dispatcher service binding', async () => {
    const dispatchFetchMock = vi.fn(async () => new Response('{"glasses":2}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const response = await performWorkspaceAppFetch(
      dispatcherServiceEnv(dispatchFetchMock) as never,
      { orgId: 'org1', workspaceId: 'workspace1' },
      WORKSPACE_APP_URL,
      undefined,
      { getHostIndex: async () => workspaceHostIndex() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ glasses: 2 });
    expect(dispatchFetchMock).toHaveBeenCalledTimes(1);
    const forwarded = dispatchFetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe(WORKSPACE_APP_URL);
  });

  it('keeps external URLs on native fetch even when SECURE_FETCH is installed', async () => {
    const dispatchFetchMock = vi.fn();
    const externalFetchMock = vi.fn(async () => new Response('external', { status: 200 }));
    vi.stubGlobal('fetch', externalFetchMock);

    await performWorkspaceAppFetch(
      dispatcherServiceEnv(dispatchFetchMock) as never,
      { orgId: 'org1', workspaceId: 'workspace1' },
      'https://example.com/status',
      undefined,
      { getHostIndex: async () => workspaceHostIndex() },
    );

    expect(externalFetchMock).toHaveBeenCalledTimes(1);
    expect(dispatchFetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
