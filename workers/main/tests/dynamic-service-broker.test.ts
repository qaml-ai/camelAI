import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { DynamicAIVirtualBinding } from '../../dispatcher/src/dynamic/service-proxies';
import { AnalysisAppService } from '../src/analysis-service';
import { DynamicServiceBroker } from '../src/dynamic-service-broker';
import { WarehouseService } from '../src/warehouse-service';

const orgId = 'org-1';
const workspaceId = 'workspace-1';
const secretKey = 'integration-test-key';

interface IntegrationRow {
  id: string;
  name: string;
  integration_type: string;
  credentials_encrypted: string;
  config: string;
  auth_method?: string;
  token_expires_at?: number | null;
}

function createBroker(records: IntegrationRow[] = [], ownerOrgId: string | null = orgId) {
  const getWorkspaceIntegrations = vi.fn(async (_workspaceId: string) => records);
  const getWorkspaceRecord = vi.fn(async (_workspaceId: string) =>
    ownerOrgId === null ? null : { org_id: ownerOrgId });
  const ensureFreshWorkspaceIntegration = vi.fn(async (_workspaceId: string, integrationId: string) =>
    records.find((record) => record.id === integrationId) ?? null);
  const get = vi.fn((_orgId: string) => ({
    getWorkspaceRecord, getWorkspaceIntegrations, ensureFreshWorkspaceIntegration,
  }));
  const idFromName = vi.fn((name: string) => name);
  const broker = Object.create(DynamicServiceBroker.prototype) as DynamicServiceBroker;
  Object.defineProperty(broker, 'env', {
    value: { ORG: { get, idFromName }, INTEGRATION_SECRET_KEY: secretKey },
  });
  return { broker, idFromName, getWorkspaceRecord, getWorkspaceIntegrations, ensureFreshWorkspaceIntegration };
}

afterEach(() => vi.restoreAllMocks());

function disposableResult<T extends object>(result: T, cleanup?: () => void) {
  const dispose = vi.fn(cleanup);
  return { result: Object.defineProperty(result, Symbol.dispose, { value: dispose }), dispose };
}

describe.each([
  {
    name: 'DynamicServiceBroker',
    forward: (result: unknown) => {
      const { broker } = createBroker();
      Object.defineProperty(broker, 'ctx', {
        value: { exports: { AIVirtualBinding: () => ({ run: async () => result }) } },
      });
      return broker.invoke('AIVirtualBinding', { orgId, workspaceId }, 'run', ['test-model', {}]);
    },
  },
  {
    name: 'BrokeredServiceProxy',
    forward: (result: unknown) => {
      const proxy = new DynamicAIVirtualBinding({ props: { orgId, workspaceId } } as ExecutionContext, {});
      Object.defineProperty(proxy, 'env', {
        value: { MAIN_APP_BROKER: { invoke: async () => result } },
      });
      return proxy.run('test-model', {});
    },
  },
])('$name RPC result lifetime', ({ forward }) => {
  it('clones the complete DTO before disposing the upstream result', async () => {
    const payload = { items: [{ id: 1 }], bytes: new Uint8Array([2, 3]) };
    const { result, dispose } = disposableResult(payload, () => { payload.items[0].id = 9; });

    const forwarded = await forward(result);

    expect(forwarded).not.toBe(result);
    expect(forwarded).toEqual({ items: [{ id: 1 }], bytes: new Uint8Array([2, 3]) });
    expect(Object.getOwnPropertySymbols(forwarded as object)).not.toContain(Symbol.dispose);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the upstream result even when reading its data fails', async () => {
    const { result, dispose } = disposableResult({
      get broken() { throw new Error('cannot read result'); },
    });

    await expect(forward(result)).rejects.toThrow('cannot read result');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards the AI byte stream by identity while keeping it readable', async () => {
    const { result, dispose } = disposableResult(new Response('streamed text').body!);

    const forwarded = await forward(result);

    expect(forwarded).toBe(result);
    expect(dispose).not.toHaveBeenCalled();
    await expect(new Response(forwarded as ReadableStream).text()).resolves.toBe('streamed text');
  });

  it('retains a Response body and headers', async () => {
    const { result, dispose } = disposableResult(new Response('response body', {
      status: 202, headers: { 'X-Test': 'forwarded' },
    }));

    const forwarded = await forward(result) as Response;

    expect(forwarded).toBe(result);
    expect(forwarded.status).toBe(202);
    expect(forwarded.headers.get('X-Test')).toBe('forwarded');
    expect(dispose).not.toHaveBeenCalled();
    await expect(forwarded.text()).resolves.toBe('response body');
  });

  it('passes binary buffers and views through without copying them', async () => {
    const view = new Uint8Array([0, 255]);
    for (const bytes of [view.buffer, view]) {
      const { result, dispose } = disposableResult(bytes);
      expect(await forward(result)).toBe(result);
      expect(dispose).not.toHaveBeenCalled();
    }
  });

  it('keeps ownership of a stream embedded in an RPC object with the reply', async () => {
    const stream = new Response('nested stream').body!;
    const { result, dispose } = disposableResult({ stream });

    expect(await forward(result)).toBe(result);
    expect(dispose).not.toHaveBeenCalled();
    await expect(new Response(stream).text()).resolves.toBe('nested stream');
  });
});

describe.each([
  { name: 'AnalysisAppService', Entrypoint: AnalysisAppService },
  { name: 'WarehouseService', Entrypoint: WarehouseService },
])('$name AnalysisService result lifetime', ({ Entrypoint }) => {
  it('disposes runCode and listConnections replies while retaining their data', async () => {
    const run = disposableResult({ ok: true, stdout: 'result' });
    const connections = disposableResult([{ id: 'connection' }]);
    const AnalysisService = vi.fn(() => ({
      runCodeForApps: async () => run.result,
      listConnections: async () => connections.result,
    }));
    const props = { orgId, workspaceId };
    const entrypoint = new Entrypoint({ props, exports: { AnalysisService } } as unknown as ExecutionContext, {});

    const codeResult = await entrypoint.runCode({ code: 'print(1)' });
    const catalog = await entrypoint.listConnections();

    expect(codeResult).not.toBe(run.result);
    expect(codeResult).toMatchObject({ ok: true, stdout: 'result' });
    expect(catalog).not.toBe(connections.result);
    expect(catalog).toEqual([{ id: 'connection' }]);
    expect(run.dispose).toHaveBeenCalledTimes(1);
    expect(connections.dispose).toHaveBeenCalledTimes(1);
    expect(AnalysisService).toHaveBeenNthCalledWith(1, { props });
    expect(AnalysisService).toHaveBeenNthCalledWith(2, { props });
  });
});

describe('DynamicServiceBroker.resolveLegacyIntegrationEnvVars', () => {
  it('decrypts workspace integrations and returns only exact requested legacy keys', async () => {
    const { broker, idFromName, getWorkspaceRecord, getWorkspaceIntegrations } = createBroker([
      {
        id: 'stripe-1',
        name: ' Production / Billing ',
        integration_type: 'stripe',
        credentials_encrypted: await encryptCredentials({ api_key: 'stripe-fixture' }, secretKey),
        config: '{}',
      },
      {
        id: 'notion-1',
        name: 'Docs',
        integration_type: 'notion',
        credentials_encrypted: await encryptCredentials({ access_token: 'notion-fixture' }, secretKey),
        config: '{}',
      },
    ]);

    const key = 'INT_STRIPE_PRODUCTION_BILLING_API_KEY';
    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, [
      key, key, 'INT_STRIPE_PRODUCTION_BILLING_UNKNOWN', 'NOTION_API_KEY', 'INT_lowercase', 'INT_',
    ])).resolves.toEqual([{ key, value: 'stripe-fixture', isSecret: true }]);
    expect(idFromName).toHaveBeenCalledWith(orgId);
    expect(getWorkspaceRecord).toHaveBeenCalledWith(workspaceId);
    expect(getWorkspaceIntegrations).toHaveBeenCalledWith(workspaceId);
  });

  it.each([
    ['', workspaceId, ['INT_STRIPE_TEST_API_KEY']],
    [orgId, ' ', ['INT_STRIPE_TEST_API_KEY']],
    [orgId, workspaceId, []],
    [orgId, workspaceId, ['NOT_AN_INTEGRATION_KEY', 'INT_', 'INT_BAD-NAME']],
  ] as const)('skips OrgDO for invalid inputs (%s, %s, %j)', async (org, workspace, keys) => {
    const { broker, idFromName } = createBroker();
    await expect(broker.resolveLegacyIntegrationEnvVars(org, workspace, [...keys])).resolves.toEqual([]);
    expect(idFromName).not.toHaveBeenCalled();
  });

  it.each([null, 'other-org'])('skips the integration read for a mismatched workspace owner (%s)', async (owner) => {
    const { broker, getWorkspaceIntegrations } = createBroker([], owner);
    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, ['INT_STRIPE_TEST_API_KEY']))
      .resolves.toEqual([]);
    expect(getWorkspaceIntegrations).not.toHaveBeenCalled();
  });

  it('uses the fresh stored BigQuery token and never returns its private service account JSON', async () => {
    const { broker, ensureFreshWorkspaceIntegration } = createBroker([{
      id: 'bigquery-1',
      name: 'Warehouse',
      integration_type: 'bigquery',
      token_expires_at: Date.now() + 60 * 60_000,
      credentials_encrypted: await encryptCredentials({
        access_token: 'bigquery-fixture',
        service_account_json: 'private-key-fixture',
      }, secretKey),
      config: '{"project_id":"example-project"}',
    }]);

    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, [
      'INT_BIGQUERY_WAREHOUSE_ACCESS_TOKEN',
      'INT_BIGQUERY_WAREHOUSE_PROJECT_ID',
      'INT_BIGQUERY_WAREHOUSE_SERVICE_ACCOUNT_JSON',
    ])).resolves.toEqual([
      { key: 'INT_BIGQUERY_WAREHOUSE_ACCESS_TOKEN', value: 'bigquery-fixture', isSecret: true },
      { key: 'INT_BIGQUERY_WAREHOUSE_PROJECT_ID', value: 'example-project', isSecret: true },
    ]);
    expect(ensureFreshWorkspaceIntegration).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'expired', expiresInMs: -60_000, accessToken: 'stale-token' },
    { state: 'expiring', expiresInMs: 5 * 60_000, accessToken: 'stale-token' },
    { state: 'missing an expiry', expiresInMs: null, accessToken: 'stale-token' },
    { state: 'missing an access token', expiresInMs: 60 * 60_000, accessToken: undefined },
  ])('hydrates the refreshed token when matching BigQuery is $state', async ({ expiresInMs, accessToken }) => {
    const record = {
      id: 'bigquery-erp',
      name: 'ERP',
      integration_type: 'bigquery',
      token_expires_at: expiresInMs === null ? null : Date.now() + expiresInMs,
      credentials_encrypted: await encryptCredentials({
        access_token: accessToken,
        service_account_json: 'private-key-fixture',
      }, secretKey),
      config: '{"project_id":"example-project"}',
    };
    const { broker, ensureFreshWorkspaceIntegration } = createBroker([
      { ...record, id: 'bigquery-unrelated', name: 'Other warehouse', token_expires_at: Date.now() - 60_000 },
      record,
    ]);
    ensureFreshWorkspaceIntegration.mockResolvedValueOnce({
      ...record,
      token_expires_at: Date.now() + 60 * 60_000,
      credentials_encrypted: await encryptCredentials({ access_token: 'fresh-token' }, secretKey),
    });

    const key = 'INT_BIGQUERY_ERP_ACCESS_TOKEN';
    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, [key]))
      .resolves.toEqual([{ key, value: 'fresh-token', isSecret: true }]);
    expect(ensureFreshWorkspaceIntegration).toHaveBeenCalledExactlyOnceWith(workspaceId, 'bigquery-erp');
  });

  it('refreshes matching OAuth integrations with an expiring token', async () => {
    const credentials_encrypted = await encryptCredentials({ access_token: 'stored-token' }, secretKey);
    const expiring = { token_expires_at: Date.now() + 60_000, credentials_encrypted, config: '{}' };
    const { broker, ensureFreshWorkspaceIntegration } = createBroker([
      { ...expiring, id: 'notion-oauth', name: 'Docs', integration_type: 'notion' },
      { ...expiring, id: 'notion-no-expiry', name: 'Notes', integration_type: 'notion', token_expires_at: null },
      { ...expiring, id: 'salesforce-oauth', name: 'Sales', integration_type: 'salesforce', auth_method: 'oauth2' },
      { ...expiring, id: 'salesforce-api-key', name: 'Test', integration_type: 'salesforce', auth_method: 'api_key' },
    ]);

    const keys = [
      'INT_NOTION_DOCS_API_KEY', 'INT_NOTION_NOTES_API_KEY',
      'INT_SALESFORCE_SALES_ACCESS_TOKEN', 'INT_SALESFORCE_TEST_ACCESS_TOKEN',
    ];
    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, keys))
      .resolves.toEqual(keys.map((key) => ({ key, value: 'stored-token', isSecret: true })));
    expect(ensureFreshWorkspaceIntegration.mock.calls).toEqual([
      [workspaceId, 'notion-oauth'],
      [workspaceId, 'salesforce-oauth'],
    ]);
  });

  it('uses stored values and resolves other integrations if the refresh RPC fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { broker, ensureFreshWorkspaceIntegration } = createBroker([
      {
        id: 'bigquery-erp',
        name: 'ERP',
        integration_type: 'bigquery',
        token_expires_at: null,
        credentials_encrypted: await encryptCredentials({ access_token: 'stored-token' }, secretKey),
        config: '{}',
      },
      {
        id: 'stripe-1',
        name: 'Billing',
        integration_type: 'stripe',
        credentials_encrypted: await encryptCredentials({ api_key: 'stripe-fixture' }, secretKey),
        config: '{}',
      },
    ]);
    ensureFreshWorkspaceIntegration.mockRejectedValueOnce(new Error('RPC temporarily unavailable'));

    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, [
      'INT_BIGQUERY_ERP_ACCESS_TOKEN', 'INT_STRIPE_BILLING_API_KEY',
    ])).resolves.toEqual([
      { key: 'INT_BIGQUERY_ERP_ACCESS_TOKEN', value: 'stored-token', isSecret: true },
      { key: 'INT_STRIPE_BILLING_API_KEY', value: 'stripe-fixture', isSecret: true },
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[DynamicServiceBroker] Failed to request integration token refresh',
      { orgId, workspaceId, integrationId: 'bigquery-erp' },
    );
  });

  it('skips unrelated records and lets valid records hydrate when another credential cannot be decrypted', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { broker } = createBroker([
      { id: 'unrelated', name: 'Unrelated', integration_type: 'stripe', credentials_encrypted: 'invalid', config: '{}' },
      { id: 'broken', name: 'Broken', integration_type: 'stripe', credentials_encrypted: 'invalid', config: '{}' },
      {
        id: 'working',
        name: 'Working',
        integration_type: 'stripe',
        credentials_encrypted: await encryptCredentials({ api_key: 'working-fixture' }, secretKey),
        config: '{}',
      },
    ]);

    await expect(broker.resolveLegacyIntegrationEnvVars(orgId, workspaceId, [
      'INT_STRIPE_BROKEN_API_KEY', 'INT_STRIPE_WORKING_API_KEY',
    ])).resolves.toEqual([
      { key: 'INT_STRIPE_WORKING_API_KEY', value: 'working-fixture', isSecret: true },
    ]);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      '[DynamicServiceBroker] Failed to resolve legacy integration env vars',
      { orgId, workspaceId, integrationId: 'broken' },
    );
  });

  it('keeps secret hydration outside the virtual service invoke allowlist', async () => {
    const { broker, idFromName } = createBroker();
    await expect(broker.invoke('ConnectionsService', {}, 'resolveLegacyIntegrationEnvVars', [
      orgId, workspaceId, ['INT_STRIPE_TEST_API_KEY'],
    ])).rejects.toThrow('Unsupported method resolveLegacyIntegrationEnvVars on ConnectionsService');
    expect(idFromName).not.toHaveBeenCalled();
  });
});
