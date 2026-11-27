import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { DynamicServiceBroker } from '../src/dynamic-service-broker';

const orgId = 'org-1';
const workspaceId = 'workspace-1';
const secretKey = 'integration-test-key';

interface IntegrationRow {
  id: string;
  name: string;
  integration_type: string;
  credentials_encrypted: string;
  config: string;
}

function createBroker(records: IntegrationRow[] = [], ownerOrgId: string | null = orgId) {
  const getWorkspaceIntegrations = vi.fn(async (_workspaceId: string) => records);
  const getWorkspaceRecord = vi.fn(async (_workspaceId: string) =>
    ownerOrgId === null ? null : { org_id: ownerOrgId });
  const get = vi.fn((_orgId: string) => ({ getWorkspaceRecord, getWorkspaceIntegrations }));
  const idFromName = vi.fn((name: string) => name);
  const broker = Object.create(DynamicServiceBroker.prototype) as DynamicServiceBroker;
  Object.defineProperty(broker, 'env', {
    value: { ORG: { get, idFromName }, INTEGRATION_SECRET_KEY: secretKey },
  });
  return { broker, idFromName, getWorkspaceRecord, getWorkspaceIntegrations };
}

afterEach(() => vi.restoreAllMocks());

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

  it('uses the stored BigQuery token and never returns its private service account JSON', async () => {
    const { broker } = createBroker([{
      id: 'bigquery-1',
      name: 'Warehouse',
      integration_type: 'bigquery',
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
