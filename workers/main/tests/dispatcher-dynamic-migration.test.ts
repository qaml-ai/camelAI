import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBundleStoreCachesForTest } from '../../dispatcher/src/dynamic/bundle-store';
import { dispatchDynamicWorkerEdge } from '../../dispatcher/src/dynamic/edge-dispatch';
import { TenantDoRouter, type TenantDoRouterProps } from '../../dispatcher/src/dynamic/entrypoints';
import { TenantObjectSupervisorDO, type SupervisorEnv } from '../../dispatcher/src/dynamic/supervisor-do';
import type { DynamicServiceBroker } from '../src/dynamic-service-broker';
import { dynamicBundleObjectKey, type AppRuntimeMode, type DynamicWorkerBundleRecord } from '../src/dynamic-worker-registry';

const appId = 'migration-test--acme';
const className = 'Store';
const objectId = 'primary';
const bundleSha = 'abcdef0123456789';
const bundleR2Key = dynamicBundleObjectKey(appId, bundleSha);
const runtimeMode = 'dynamic_migrating';
const identity = { supervisorKey: `${appId}:${className}:${objectId}`, dispatchScriptName: appId, className, objectId };
const bundle: DynamicWorkerBundleRecord = {
  schemaVersion: 2,
  appId,
  scriptName: 'migration-test',
  dispatchScriptName: appId,
  orgId: 'org-1',
  orgSlug: 'acme',
  workspaceId: 'workspace-1',
  bundleSha,
  createdAt: '2026-07-13T00:00:00Z',
  compatibilityDate: '2026-07-13',
  compatibilityFlags: [],
  mainModule: 'index.js',
  modules: { 'index.js': { name: 'index.js', type: 'js', content: 'export default {};' } },
  bindings: [],
  doBindings: { STORE: className },
  doClasses: [className],
  hasAssets: false,
  hasCodemodeLoader: false,
};

function setup(
  kvMode?: AppRuntimeMode,
  { record = bundle, broker }: {
    record?: DynamicWorkerBundleRecord;
    broker?: Pick<DynamicServiceBroker, 'resolveLegacyIntegrationEnvVars'>;
  } = {},
) {
  const recordKey = dynamicBundleObjectKey(appId, record.bundleSha);
  const values = new Map<string, unknown>();
  const appKv = { get: async (key: string) => key === `script:${appId}` && kvMode
    ? JSON.stringify({ org_id: bundle.orgId, is_public: true, runtime_mode: kvMode })
    : null, put: vi.fn() };
  const facet = {
    fetch: vi.fn(async (request: Request) => Response.json({
      reached: 'fetch',
      runtimeModeHeader: request.headers.get('x-chiridion-runtime-mode'),
    })),
    __chiridionCallMethod: vi.fn(async () => 'rpc'),
    __chiridionRunAlarm: vi.fn(async () => {}),
    __chiridionFlushMetrics: async () => ({ rowsRead: 0, rowsWritten: 0, dbSizeBytes: 0, trips: 0 }),
  };
  const importerFetch = vi.fn(async (request: Request) => {
    switch (new URL(request.url).pathname) {
      case '/__import/schema':
      case '/__import/rows':
        return Response.json({ ok: true });
      case '/__import/finalize':
        return Response.json({ ok: true, integrityOk: true, kvCount: 0, tableCounts: { rows: 2 } });
      default:
        throw new Error(`Unexpected importer request ${request.url}`);
    }
  });
  const sourceFetch = vi.fn<(request: Request) => Promise<Response>>();
  const setAlarm = vi.fn();
  const abortFacet = vi.fn();
  const ctx = {
    storage: {
      get: async (key: string) => values.get(key),
      kv: { get: (key: string) => values.get(key) },
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: async (key: string) => values.delete(key),
      setAlarm,
    },
    facets: {
      abort: abortFacet,
      get: (_name: string, factory: () => { class: string }) =>
        factory().class === 'ChiridionMigrationImporterDO' ? { fetch: importerFetch } : facet,
    },
  };
  const workerCodes = new Map<string, WorkerLoaderWorkerCode>();
  const loader = { get: (key: string, create: () => WorkerLoaderWorkerCode) => {
    if (!workerCodes.has(key)) workerCodes.set(key, create());
    const code = workerCodes.get(key)!;
    return {
      getDurableObjectClass: (name: string) => name,
      getEntrypoint: () => ({ fetch: async (request: Request) => {
        const router = (code.env as { __CHIRIDION_DO_ROUTER: TenantDoRouter }).__CHIRIDION_DO_ROUTER;
        if (new URL(request.url).pathname === '/rpc') {
          return Response.json(await router.rpcObject(appId, className, objectId, 'read', []));
        }
        return router.fetchObject(appId, className, objectId, request);
      } }),
    };
  } };
  const env = {
    APP_KV: appKv,
    R2_BUCKET: { get: async (key: string) => key === recordKey ? { text: async () => JSON.stringify(record) } : null },
    USER_APP_LOADER: loader,
    MAIN_APP_BROKER: broker,
    MIGRATION_HMAC_SECRET: 'test-migration-secret',
    DISPATCHER: { get: () => ({ fetch: sourceFetch }) },
  } as unknown as SupervisorEnv;
  const createSupervisor = (): TenantObjectSupervisorDO => Object.create(TenantObjectSupervisorDO.prototype, {
    ctx: { value: ctx },
    env: { value: env },
  });
  const supervisor = createSupervisor();
  const makeRouter = (props: TenantDoRouterProps, target = supervisor): TenantDoRouter =>
    Object.create(TenantDoRouter.prototype, {
      ctx: { value: { props } },
      env: { value: { APP_KV: appKv, TENANT_DO_SUPERVISOR: { idFromName: (name: string) => name, get: () => target } } },
      hopCount: { value: 0, writable: true },
    });
  const tenantDoRouter = vi.fn(({ props }: { props: TenantDoRouterProps }) => makeRouter(props));
  const edgeFetch = (path: string, mode: AppRuntimeMode = runtimeMode) => dispatchDynamicWorkerEdge({
    request: new Request(`https://migration-test.example${path}`, {
      headers: { 'x-chiridion-runtime-mode': 'dynamic' },
    }),
    env,
    ctx: {} as ExecutionContext,
    exports: { TenantDoRouter: tenantDoRouter },
    dispatchScriptName: appId,
    accessInfo: { runtime_mode: mode, is_public: true, org_id: bundle.orgId, bundle_r2_key: recordKey },
  });
  return { edgeFetch, supervisor, createSupervisor, makeRouter, facet, setAlarm, sourceFetch, tenantDoRouter, values, workerCodes, abortFacet };
}

describe('Dynamic Workers DO migration gate', () => {
  beforeEach(clearBundleStoreCachesForTest);
  afterEach(() => vi.restoreAllMocks());

  it.each(['progress marker', 'legacy checkpoint'])('retries fetch and RPC after a budgeted import and resumes from a %s', async (checkpointKind) => {
    const { edgeFetch, supervisor, createSupervisor, makeRouter, facet, sourceFetch, values } = setup('wfp');
    const epoch = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(epoch);
    const firstSqlPage = Promise.withResolvers<Response>();
    const startedFirstPage = Promise.withResolvers<void>();
    const table = {
      name: 'rows', rowCount: 2, hasRowid: true, primaryKeyColumns: ['id'], columns: ['id'],
    };
    const freeze = {
      ok: true, hexId: 'a'.repeat(64), databaseSize: 512, alarmMs: null, kvCount: 0,
      sqliteSequence: [], tables: [table],
      schema: [{ type: 'table', name: 'rows', tblName: 'rows', sql: 'CREATE TABLE rows (id INTEGER PRIMARY KEY)' }],
    };
    sourceFetch.mockImplementation(async (request) => {
      const url = new URL(request.url);
      switch (url.pathname) {
        case '/__migrate/freeze': return Response.json(freeze);
        case '/__migrate/export-sql': {
          if (url.searchParams.get('afterRowid') === '1') {
            return Response.json({ table: table.name, rows: [{ rowid: 2, values: [2] }], done: true });
          }
          startedFirstPage.resolve();
          return firstSqlPage.promise;
        }
        case '/__migrate/export-kv': return Response.json({ entries: [], done: true });
        case '/__migrate/verify-counts': return Response.json({ ...freeze, tableCounts: { rows: 2 }, frozen: true });
        default: throw new Error(`Unexpected source request ${url}`);
      }
    });

    const migration = supervisor.migrateFromWfpShim(identity, { budgetMs: 5_000 });
    await startedFirstPage.promise;
    const bothWaiting = Promise.withResolvers<void>();
    const run = supervisor.migrateFromWfpShim.bind(supervisor);
    const join = vi.spyOn(supervisor, 'migrateFromWfpShim').mockImplementation((...args) => {
      if (join.mock.calls.length === 2) bothWaiting.resolve();
      return run(...args);
    });
    const fetch = edgeFetch('/fetch');
    const rpc = edgeFetch('/rpc');
    await bothWaiting.promise;
    expect(facet.fetch).not.toHaveBeenCalled();
    expect(facet.__chiridionCallMethod).not.toHaveBeenCalled();
    clock.mockReturnValue(epoch + 5_000);
    firstSqlPage.resolve(Response.json({ table: table.name, rows: [{ rowid: 1, values: [1] }], nextCursor: 1, done: false }));

    await expect(migration).resolves.toMatchObject({ status: 'in_progress', progress: { rowsCopied: 1 } });
    for (const response of await Promise.all([fetch, rpc])) {
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('2');
    }
    await expect(supervisor.getMigrationState()).resolves.toMatchObject({ status: 'in_progress' });
    expect(facet.fetch).not.toHaveBeenCalled();
    expect(facet.__chiridionCallMethod).not.toHaveBeenCalled();

    // Older forced imports could leave the prior terminal marker beside an unfinished checkpoint.
    if (checkpointKind === 'legacy checkpoint') {
      values.set('__chiridion_meta:migration', { status: 'migrated' });
    }
    const restarted = createSupervisor();
    const latestRouter = makeRouter({ dispatchScriptName: appId, orgId: bundle.orgId, bundleR2Key, runtimeMode: 'dynamic' }, restarted);
    const resumed = await latestRouter.fetchObject(appId, className, objectId, new Request('https://migration-test.example'));
    await expect(resumed.json()).resolves.toEqual({ reached: 'fetch', runtimeModeHeader: null });
    await expect(restarted.getMigrationState()).resolves.toMatchObject({ status: 'migrated' });
    await expect(latestRouter.rpcObject(appId, className, objectId, 'read', [])).resolves.toBe('rpc');
    expect(join).toHaveBeenCalledTimes(2);
    expect(sourceFetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      '/__migrate/freeze', '/__migrate/export-sql', '/__migrate/export-sql', '/__migrate/export-kv', '/__migrate/verify-counts',
    ]);
  });

  it('requires durable completion with missing KV and keeps the gate on cold starts from older routers', async () => {
    const { edgeFetch, supervisor, createSupervisor, makeRouter, facet, setAlarm } = setup();
    const migrate = vi.spyOn(supervisor, 'migrateFromWfpShim').mockResolvedValue({ status: 'migrated' });
    const fetch = await edgeFetch('/fetch');
    expect(fetch.status).toBe(503);
    expect(fetch.headers.get('Retry-After')).toBe('2');
    expect(migrate.mock.calls[0]?.[0]).toMatchObject({ runtimeMode, bundleR2Key });
    expect(facet.fetch).not.toHaveBeenCalled();

    const coldSupervisor = createSupervisor();
    const coldMigrate = vi.spyOn(coldSupervisor, 'migrateFromWfpShim').mockResolvedValue({ status: 'in_progress' });
    const oldRouter = makeRouter({ dispatchScriptName: appId, orgId: bundle.orgId, bundleR2Key }, coldSupervisor);
    const response = await oldRouter.fetchObject(appId, className, objectId, new Request('https://migration-test.example', {
      headers: { 'x-chiridion-runtime-mode': 'dynamic' },
    }));
    expect(response.status).toBe(503);
    expect(coldMigrate.mock.calls[0]?.[0]).toMatchObject({ runtimeMode });

    await coldSupervisor.alarm();
    expect(facet.__chiridionRunAlarm).not.toHaveBeenCalled();
    expect(setAlarm).toHaveBeenCalledTimes(1);
    await coldSupervisor.setMigrationState({ status: 'empty' });
    expect((await oldRouter.fetchObject(appId, className, objectId, new Request('https://migration-test.example'))).status).toBe(200);
    await coldSupervisor.alarm();
    expect(facet.__chiridionRunAlarm).toHaveBeenCalledTimes(1);
  });

  it('builds a fresh router when the mode changes with the same bundle', async () => {
    const { edgeFetch, supervisor, tenantDoRouter, sourceFetch } = setup();
    expect((await edgeFetch('/fetch', 'dynamic')).status).toBe(200);
    await supervisor.setMigrationState({ status: 'empty' });
    expect((await edgeFetch('/fetch')).status).toBe(200);
    expect(tenantDoRouter.mock.calls.map(([{ props }]) => props.runtimeMode)).toEqual(['dynamic', 'dynamic_migrating']);
    expect(sourceFetch).not.toHaveBeenCalled();
  });

  it('rebuilds the edge isolate and warm supervisor facet when the live BigQuery token rotates', async () => {
    const key = 'INT_BIGQUERY_ERP_ACCESS_TOKEN';
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [{ key, value: 'initial-token', isSecret: true as const }]);
    const { edgeFetch, workerCodes, abortFacet } = setup(undefined, {
      record: { ...bundle, bundleSha: '0123456789abcdef', bindings: [{ name: key, type: 'secret_text' }] },
      broker: { resolveLegacyIntegrationEnvVars },
    });
    const epoch = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(epoch);

    expect((await edgeFetch('/fetch', 'dynamic')).status).toBe(200);
    resolveLegacyIntegrationEnvVars.mockResolvedValue([{ key, value: 'fresh-token', isSecret: true }]);
    expect((await edgeFetch('/fetch', 'dynamic')).status).toBe(200);
    expect(workerCodes.size).toBe(2);
    expect(abortFacet).not.toHaveBeenCalled();

    clock.mockReturnValue(epoch + 5 * 60_000);
    expect((await edgeFetch('/fetch', 'dynamic')).status).toBe(200);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(2);
    expect(abortFacet).toHaveBeenCalledExactlyOnceWith('main', expect.any(Error));
    for (const kind of ['http:', 'do:']) {
      const codes = [...workerCodes].filter(([id]) => id.startsWith(kind)).map(([, code]) => code.env);
      expect(codes).toEqual([expect.objectContaining({ [key]: 'initial-token' }), expect.objectContaining({ [key]: 'fresh-token' })]);
    }
  });
});
