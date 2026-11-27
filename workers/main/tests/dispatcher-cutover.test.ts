import { beforeEach, describe, expect, it, vi } from 'vitest';
import DispatcherEntrypoint from '../../dispatcher/src/index';
import { clearBundleStoreCachesForTest } from '../../dispatcher/src/dynamic/bundle-store';
import { dynamicBundleObjectKey, type DynamicWorkerBundleRecord } from '../src/dynamic-worker-registry';

const appId = 'orders--acme123';
const appUrl = 'https://orders--acme123.camelai.app';
const bundleKey = dynamicBundleObjectKey(appId, 'version-1');
const pointerKey = `dynamic-bundles/${appId}/latest.json`;
const registry = { org_id: 'org-1', is_public: false, runtime_mode: 'wfp' };
const pointer = { ...registry, runtime_mode: 'dynamic_migrating', bundle_r2_key: bundleKey };
const bundle: DynamicWorkerBundleRecord = {
  schemaVersion: 2,
  appId,
  dispatchScriptName: appId,
  scriptName: 'orders',
  orgId: registry.org_id,
  orgSlug: 'acme123',
  workspaceId: 'workspace-1',
  bundleSha: 'version-1',
  createdAt: '',
  compatibilityDate: '2026-03-24',
  compatibilityFlags: [],
  mainModule: 'index.js',
  modules: { 'index.js': { name: 'index.js', type: 'js', content: 'export default {};' } },
  bindings: [],
  doBindings: {},
  doClasses: [],
  hasAssets: true,
  hasCodemodeLoader: false,
};

function setup(access: object = registry, options: { dynamic?: boolean } = {}) {
  const legacyFetch = vi.fn(async (_request: Request) => new Response('legacy'));
  const getLegacyWorker = vi.fn((_name: string) => ({ fetch: legacyFetch }));
  const dynamicFetch = vi.fn(async (_request: Request) => new Response('dynamic'));
  const getDynamicWorker = vi.fn(() => ({ getEntrypoint: () => ({ fetch: dynamicFetch }) }));
  const getRegistry = vi.fn(async (key: string) => key === `script:${appId}` ? JSON.stringify(access) : null);
  const getR2 = vi.fn(async (key: string): Promise<R2ObjectBody | null> => {
    if (key === pointerKey) return { json: async () => pointer } as R2ObjectBody;
    if (key === bundleKey) return { text: async () => JSON.stringify(bundle) } as R2ObjectBody;
    return null;
  });
  const putR2 = vi.fn();
  const getAssets = vi.fn(() => ({ fetch: () => Promise.resolve(new Response(null, { status: 404 })) }));
  const dispatcher = new DispatcherEntrypoint(
    { waitUntil: vi.fn(), exports: { AssetsVirtualBinding: getAssets } } as unknown as ExecutionContext,
    {
      APP_KV: { get: getRegistry },
      DISPATCHER: { get: getLegacyWorker },
      R2_BUCKET: { get: getR2, put: putR2 },
      USER_APP_LOADER: options.dynamic === false ? undefined : { get: getDynamicWorker },
    } as unknown as ConstructorParameters<typeof DispatcherEntrypoint>[1],
  );
  return { dispatcher, legacyFetch, getLegacyWorker, dynamicFetch, getR2, putR2, getAssets, getRegistry };
}

beforeEach(() => clearBundleStoreCachesForTest());

describe('dispatcher workspace app quarantine', () => {
  it.each(['suspending', 'suspended', 'error'])('quarantines %s apps on trusted RPC and HTTP', async (status) => {
    const app = setup({ ...registry, usage_guard_status: status }, { dynamic: false });
    for (const response of [
      await app.dispatcher.fetchWorkspaceApp(new Request(appUrl)),
      await app.dispatcher.fetch(new Request(appUrl)),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('X-CamelAI-App-Status')).toBe('suspended');
      expect(response.headers.get('Retry-After')).toBe('300');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(app.getLegacyWorker).not.toHaveBeenCalled();
    expect(app.dynamicFetch).not.toHaveBeenCalled();
  });

  it('dispatches an active private app over trusted RPC without a browser session', async () => {
    const app = setup({ ...registry, usage_guard_status: 'active' }, { dynamic: false });
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(appUrl));
    expect(await response.text()).toBe('legacy');
    expect(app.legacyFetch).toHaveBeenCalledOnce();
    expect(app.getRegistry).toHaveBeenCalledWith(`script:${appId}`);
    expect(app.getR2).not.toHaveBeenCalled();
  });

  it('returns a retryable error when registry access fails', async () => {
    const app = setup();
    app.getRegistry.mockRejectedValueOnce(new Error('KV unavailable'));
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(appUrl));
    expect(response.status).toBe(503);
    expect(app.getLegacyWorker).not.toHaveBeenCalled();
    expect(app.dynamicFetch).not.toHaveBeenCalled();
  });
});

describe('dispatcher stale KV cutover', () => {
  it.each(['namespace lookup', 'legacy fetch', 'migration shim'])('keeps the POST body after %s', async (failure) => {
    const app = setup();
    const bytes = new Uint8Array([0, 17, 128, 255]);
    if (failure === 'namespace lookup') {
      app.getLegacyWorker.mockImplementationOnce(() => { throw new Error('Worker not found'); });
    } else {
      app.legacyFetch.mockImplementationOnce(async (request) => {
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
        if (failure === 'legacy fetch') throw new Error('Worker not found');
        return new Response('Migrating', {
          status: 503,
          headers: { 'X-Chiridion-Migrating': '1' },
        });
      });
    }
    app.dynamicFetch.mockImplementationOnce(async (request) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe(`${appUrl}/orders?source=workflow`);
      expect(request.headers.get('content-type')).toBe('application/octet-stream');
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
      return new Response('recovered', { status: 201 });
    });
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(`${appUrl}/orders?source=workflow`, {
      method: 'POST',
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('recovered');
    expect(app.getR2).toHaveBeenNthCalledWith(1, pointerKey);
    expect(app.dynamicFetch).toHaveBeenCalledOnce();
  });

  it('leaves an ordinary legacy 503 response in place', async () => {
    const app = setup();
    app.legacyFetch.mockResolvedValueOnce(new Response('maintenance', { status: 503 }));
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(appUrl));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('maintenance');
    expect(app.getR2).not.toHaveBeenCalled();
  });

  it('returns the missing-worker 404 when the pointer is absent', async () => {
    const app = setup();
    app.legacyFetch.mockRejectedValueOnce(new Error('Worker not found'));
    app.getR2.mockResolvedValueOnce(null);
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(appUrl));
    expect(response.status).toBe(404);
    expect(app.getR2).toHaveBeenCalledExactlyOnceWith(pointerKey);
    expect(app.dynamicFetch).not.toHaveBeenCalled();
  });

  it('keeps the migration shim response when the pointer cannot be read', async () => {
    const app = setup();
    app.legacyFetch.mockResolvedValueOnce(new Response('Migrating', {
      status: 503,
      headers: { 'X-Chiridion-Migrating': '1' },
    }));
    app.getR2.mockRejectedValueOnce(new Error('R2 unavailable'));
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(appUrl));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Migrating');
    expect(app.dynamicFetch).not.toHaveBeenCalled();
  });

  it('enforces quarantine from the cutover pointer when KV is stale', async () => {
    const app = setup({ ...registry, usage_guard_status: 'active' });
    app.getLegacyWorker.mockImplementationOnce(() => { throw new Error('Worker not found'); });
    app.getR2.mockResolvedValueOnce({
      json: async () => ({ ...pointer, usage_guard_status: 'suspended' }),
    } as R2ObjectBody);
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(appUrl));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-CamelAI-App-Status')).toBe('suspended');
    expect(app.dynamicFetch).not.toHaveBeenCalled();
  });
});

describe('dispatcher edge asset routing', () => {
  it.each([
    ['GET', '/orders.data?_routes=routes%2Forders'],
    ['HEAD', '/assets/orders.data'],
  ])('runs %s %s in the app worker', async (method, path) => {
    const app = setup(pointer);
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(`${appUrl}${path}`, { method }));
    expect(response.status).toBe(200);
    expect(app.dynamicFetch).toHaveBeenCalledOnce();
    expect(app.dynamicFetch.mock.calls[0]?.[0].url).toBe(`${appUrl}${path}`);
    expect(app.getAssets).not.toHaveBeenCalled();
    expect(app.getLegacyWorker).not.toHaveBeenCalled();
    expect(app.putR2).not.toHaveBeenCalled();
  });

  it('retains the fast path for static assets', async () => {
    const app = setup(pointer);
    app.getAssets.mockReturnValueOnce({ fetch: async () => new Response('asset') });
    const response = await app.dispatcher.fetchWorkspaceApp(new Request(`${appUrl}/assets/orders.css`));
    expect(await response.text()).toBe('asset');
    expect(app.getAssets).toHaveBeenCalledOnce();
    expect(app.dynamicFetch).not.toHaveBeenCalled();
  });
});
