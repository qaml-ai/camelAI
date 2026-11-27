import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceAppPath,
  buildWorkspaceAppHostIndex,
  buildWorkspaceAppUrl,
  fetchWorkspaceAppViaDispatch,
  isLocalAppHostname,
  isWorkspaceAppHostname,
  performWorkspaceAppFetch,
  PLATFORM_DISPATCH_SCRIPT_HEADER,
  PLATFORM_DISPATCH_SCRIPT_NAME_HEADER,
  shouldUseDispatchInterceptionForScreenshot,
  type WorkspaceAppFetcherEnv,
} from '../src/workspace-app-fetcher';

const appHost = 'private-app-alpha12.staging.camelai.app';
const siblingHost = 'sibling-app-alpha12.staging.camelai.app';
const context = { orgId: 'org1', workspaceId: 'workspace1' };

function redirectFixture(fetchWorkspaceApp: (request: Request) => Promise<Response>) {
  const route = { ...context, orgSlug: 'alpha12', isPublic: false };
  const index = {
    hostnames: new Set([appHost, siblingHost]),
    routesByHostname: new Map([
      [appHost, { ...route, scriptName: 'private-app', dispatchScriptName: 'private-app--alpha12' }],
      [siblingHost, { ...route, scriptName: 'sibling-app', dispatchScriptName: 'sibling-app--alpha12' }],
    ]),
  };
  const env: WorkspaceAppFetcherEnv = {
    DISPATCHER: { fetchWorkspaceApp },
    ORG: {} as WorkspaceAppFetcherEnv['ORG'],
  };
  return { env, index };
}

describe('workspace app fetcher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('indexes vanity, iframe, and custom app hostnames for a workspace', async () => {
    const orgStub = {
      getInfo: vi.fn(async () => ({ slug: 'alpha12' })),
      listWorkerScriptsByWorkspace: vi.fn(async () => ([
        {
          script_name: 'webhook-api',
          workspace_id: 'workspace1',
          is_public: false,
          custom_domain_hostname: 'hooks.example.com',
          custom_domain_status: 'active',
          custom_domain_ssl_status: 'active',
        },
      ])),
    };
    const env = {
      ORG: {
        idFromName: () => 'org-id',
        get: () => orgStub,
      },
      WORKER_BASE_URL: 'https://staging.camelai.dev',
    };

    const index = await buildWorkspaceAppHostIndex(env as any, {
      orgId: 'org1',
      workspaceId: 'workspace1',
    });

    expect(isWorkspaceAppHostname(index, 'webhook-api-alpha12.staging.camelai.app')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'webhook-api-alpha12.apps.staging.camelai.dev')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'hooks.example.com')).toBe(true);
    expect(isWorkspaceAppHostname(index, 'other-org-app-beta99.staging.camelai.app')).toBe(false);
  });

  it('routes workspace app requests through the dispatcher service binding', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const index = {
      hostnames: new Set(['private-app-alpha12.staging.camelai.app']),
      routesByHostname: new Map([
        ['private-app-alpha12.staging.camelai.app', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: {
        fetchWorkspaceApp: fetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/api/webhook', {
        method: 'POST',
        body: '{"ok":true}',
      }),
      index,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe('https://private-app-alpha12.staging.camelai.app/api/webhook');
    expect(forwarded.method).toBe('POST');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_HEADER)).toBe('private-app--alpha12');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_NAME_HEADER)).toBe('private-app');
    expect(forwarded.headers.get('Host')).toBe('private-app-alpha12.staging.camelai.app');
  });

  it('strips caller Host spoofing and forged platform dispatch headers', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    const index = {
      hostnames: new Set(['private-app-alpha12.staging.camelai.app']),
      routesByHostname: new Map([
        ['private-app-alpha12.staging.camelai.app', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: { fetchWorkspaceApp: fetchMock },
      ORG: { idFromName: () => 'org-id', get: () => ({}) },
    };

    await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/api/webhook', {
        headers: {
          Host: 'victim-app-beta99.staging.camelai.app',
          [PLATFORM_DISPATCH_SCRIPT_HEADER]: 'victim-app--beta99',
          [PLATFORM_DISPATCH_SCRIPT_NAME_HEADER]: 'victim-app',
        },
      }),
      index,
    );

    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('Host')).toBe('private-app-alpha12.staging.camelai.app');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_HEADER)).toBe('private-app--alpha12');
    expect(forwarded.headers.get(PLATFORM_DISPATCH_SCRIPT_NAME_HEADER)).toBe('private-app');
  });

  it('returns dispatcher 404 responses directly', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const index = {
      hostnames: new Set(['private-app-alpha12.staging.camelai.app']),
      routesByHostname: new Map([
        ['private-app-alpha12.staging.camelai.app', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: {
        fetchWorkspaceApp: fetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/missing'),
      index,
    );

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows redirects within workspace app hostnames', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: '/dashboard/' },
      }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const index = {
      hostnames: new Set(['private-app-alpha12.staging.camelai.app']),
      routesByHostname: new Map([
        ['private-app-alpha12.staging.camelai.app', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: {
        fetchWorkspaceApp: fetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/dashboard'),
      index,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const redirected = fetchMock.mock.calls[1]?.[0] as Request;
    expect(redirected.url).toBe('https://private-app-alpha12.staging.camelai.app/dashboard/');
    expect(redirected.method).toBe('GET');
  });

  it.each([[307, 'POST'], [308, 'PUT']] as const)(
    'replays an already consumed request body for %s with %s across multiple redirects',
    async (status, method) => {
      const upstream = vi.fn(async (request: Request) => {
        expect(request.redirect).toBe('manual');
        expect(request.method).toBe(method);
        expect(request.headers.get('Content-Type')).toBe('application/octet-stream');
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([0, 42, 255]);
        const path = new URL(request.url).pathname;
        expect(request.headers.get('Authorization')).toBe(path === '/sibling' ? null : 'Bearer app-token');
        return path === '/sibling'
          ? new Response('done')
          : new Response(null, {
            status,
            headers: { Location: path === '/start' ? '/middle' : `https://${siblingHost}/sibling` },
          });
      });
      const { env, index } = redirectFixture(upstream);
      const response = await fetchWorkspaceAppViaDispatch(
        env,
        context,
        new Request(`https://${appHost}/start`, {
          method,
          headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer app-token' },
          body: new Uint8Array([0, 42, 255]),
        }),
        index,
      );

      expect(await response.text()).toBe('done');
      expect(upstream).toHaveBeenCalledTimes(3);
    },
  );

  it('rejects replay beyond the limit without truncating an initial upload', async () => {
    const size = 1024 * 1024 + 1;
    const upstream = vi.fn(async (request: Request) => {
      expect((await request.arrayBuffer()).byteLength).toBe(size);
      return new Response(null, { status: 307, headers: { Location: '/next' } });
    });
    const { env, index } = redirectFixture(upstream);
    const request = (redirect: RequestRedirect) => new Request(`https://${appHost}/start`, {
      method: 'POST',
      body: new Uint8Array(size),
      redirect,
    });

    await expect(fetchWorkspaceAppViaDispatch(env, context, request('follow'), index))
      .rejects.toThrow('request body over 1 MiB');
    expect(upstream).toHaveBeenCalledTimes(1);
    await expect(fetchWorkspaceAppViaDispatch(env, context, request('manual'), index))
      .resolves.toMatchObject({ status: 307 });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('follows a 303 after a large POST as a bodyless GET', async () => {
    const upstream = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === '/start') {
        await request.arrayBuffer();
        return new Response(null, { status: 303, headers: { Location: '/next' } });
      }
      expect(request.method).toBe('GET');
      expect(request.body).toBeNull();
      expect(request.headers.has('Content-Type')).toBe(false);
      return new Response('done');
    });
    const { env, index } = redirectFixture(upstream);

    const response = await fetchWorkspaceAppViaDispatch(
      env,
      context,
      new Request(`https://${appHost}/start`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) }),
      index,
    );
    expect(await response.text()).toBe('done');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('routes self-host workspace app fetches through the dispatcher service binding', async () => {
    const fetchMock = vi.fn(async () => new Response('selfhost ok', { status: 200 }));
    const index = {
      hostnames: new Set(['private-app-alpha12.localhost']),
      routesByHostname: new Map([
        ['private-app-alpha12.localhost', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: {
        fetchWorkspaceApp: fetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('http://private-app-alpha12.localhost/api'),
      index,
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const forwarded = fetchMock.mock.calls[0]?.[0] as Request;
    expect(forwarded.url).toBe('http://private-app-alpha12.localhost/api');
  });

  it('passes through non-workspace URLs without using dispatch', async () => {
    const hostIndex = { hostnames: new Set(['private-app-alpha12.staging.camelai.app']), routesByHostname: new Map() };
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await performWorkspaceAppFetch(
      {} as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      'https://example.com/hook',
      undefined,
      { getHostIndex: async () => hostIndex },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('builds self-host preview URLs with the platform HTTP listener port', async () => {
    const orgStub = {
      getInfo: vi.fn(async () => ({ slug: 'alpha12' })),
      getWorkerScript: vi.fn(async () => ({
        script_name: 'private-app',
        workspace_id: 'workspace1',
        is_public: false,
      })),
    };
    const env = {
      ORG: {
        idFromName: () => 'org-id',
        get: () => orgStub,
      },
      WORKER_BASE_URL: 'http://localhost:3001',
      LOCAL_APP_VANITY_DOMAIN: 'localhost',
    };

    await expect(buildWorkspaceAppUrl(env as any, {
      orgId: 'org1',
      workspaceId: 'workspace1',
    }, 'private-app')).resolves.toBe('http://private-app-alpha12.localhost:3001/');
  });

  it('uses dispatch interception for private local apps when DISPATCHER is configured', () => {
    expect(shouldUseDispatchInterceptionForScreenshot(false, { DISPATCHER: { fetchWorkspaceApp: vi.fn() } })).toBe(true);
    expect(shouldUseDispatchInterceptionForScreenshot(false, {})).toBe(false);
    expect(shouldUseDispatchInterceptionForScreenshot(true, { DISPATCHER: { fetchWorkspaceApp: vi.fn() } })).toBe(false);
  });

  it('detects local app hostnames for platform URL finalization', () => {
    const env = {
      WORKER_BASE_URL: 'http://localhost:3001',
      LOCAL_APP_VANITY_DOMAIN: 'apps.example.test',
    };
    expect(isLocalAppHostname('demo.localhost', env as any)).toBe(true);
    expect(isLocalAppHostname('demo.apps.example.test', env as any)).toBe(true);
    expect(isLocalAppHostname('demo.staging.camelai.app', env as any)).toBe(false);
  });

  it('keeps workspace app paths on the validated app origin', () => {
    const base = 'https://private-app-alpha12.staging.camelai.app';
    expect(applyWorkspaceAppPath(base, '/dashboard').toString()).toBe(
      'https://private-app-alpha12.staging.camelai.app/dashboard',
    );
    expect(applyWorkspaceAppPath(base, 'dashboard?q=1#top').toString()).toBe(
      'https://private-app-alpha12.staging.camelai.app/dashboard?q=1#top',
    );
    expect(() => applyWorkspaceAppPath(base, '//example.com')).toThrow(
      'Workspace app path must stay on the app origin',
    );
    expect(() => applyWorkspaceAppPath(base, 'https://example.com')).toThrow(
      'Workspace app path must stay on the app origin',
    );
  });

  it('strips sensitive headers when following redirects off workspace app hostnames', async () => {
    const dispatchFetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://example.com/landing' },
    }));
    const externalFetchMock = vi.fn(async (_request: Request, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return new Response('external');
    });
    vi.stubGlobal('fetch', externalFetchMock);
    const index = {
      hostnames: new Set(['private-app-alpha12.staging.camelai.app']),
      routesByHostname: new Map([
        ['private-app-alpha12.staging.camelai.app', {
          scriptName: 'private-app',
          orgSlug: 'alpha12',
          dispatchScriptName: 'private-app--alpha12',
          workspaceId: 'workspace1',
          orgId: 'org1',
          isPublic: false,
        }],
      ]),
    };
    const env = {
      DISPATCHER: {
        fetchWorkspaceApp: dispatchFetchMock,
      },
      ORG: {
        idFromName: () => 'org-id',
        get: () => ({}),
      },
    };

    const response = await fetchWorkspaceAppViaDispatch(
      env as any,
      { orgId: 'org1', workspaceId: 'workspace1' },
      new Request('https://private-app-alpha12.staging.camelai.app/start', {
        headers: {
          Authorization: 'Bearer secret-token',
          Cookie: 'session=abc123',
          Host: appHost,
          [PLATFORM_DISPATCH_SCRIPT_HEADER]: 'forged-script',
        },
      }),
      index,
    );

    expect(response.status).toBe(200);
    expect(externalFetchMock).toHaveBeenCalledTimes(1);
    const externalRequest = externalFetchMock.mock.calls[0]?.[0] as Request;
    expect(externalRequest.url).toBe('https://example.com/landing');
    expect(externalRequest.headers.get('Authorization')).toBeNull();
    expect(externalRequest.headers.get('Cookie')).toBeNull();
    expect(externalRequest.headers.has('Host')).toBe(false);
    expect(externalRequest.headers.has(PLATFORM_DISPATCH_SCRIPT_HEADER)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('strips cross-origin credentials and replays PUT through an external redirect chain', async () => {
    const dispatched = vi.fn();
    const { env, index } = redirectFixture(dispatched);
    const externalFetch = vi.fn(async (request: Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(request.method).toBe('PUT');
      expect(await request.text()).toBe('body');
      const { hostname } = new URL(request.url);
      if (hostname === 'start.example.test') {
        expect(request.headers.get('Cookie')).toBe('session=123');
        return new Response(null, { status: 308, headers: { Location: `https://${appHost}/next` } });
      }
      expect(request.headers.get('Cookie')).toBeNull();
      return new Response('done');
    });
    vi.stubGlobal('fetch', externalFetch);

    const response = await performWorkspaceAppFetch(
      env,
      context,
      'https://start.example.test/start',
      { method: 'PUT', headers: { Cookie: 'session=123' }, body: 'body' },
      { getHostIndex: async () => index },
    );
    expect(await response.text()).toBe('done');
    expect(externalFetch).toHaveBeenCalledTimes(2);
    expect(dispatched).not.toHaveBeenCalled();
  });
});
