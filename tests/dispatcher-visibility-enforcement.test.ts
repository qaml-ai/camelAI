import { describe, expect, it } from 'vitest';
import {
  getWorkerAccessInfo,
  isPublicAppRequest,
} from '../workers/dispatcher/src/access-control';

function createKv(seed: Record<string, string>) {
  return {
    async get(key: string): Promise<string | null> {
      return seed[key] ?? null;
    },
  };
}

describe('dispatcher visibility enforcement', () => {
  it('reads visibility and usage-guard state from the canonical registry key', async () => {
    const kv = createKv({
      'script:my-app--acme-85b': JSON.stringify({
        org_id: 'org-1',
        org_slug: 'acme-85b',
        is_public: false,
        usage_guard_status: 'suspended',
        usage_guard_reason: 'sustained_sqlite_usage',
      }),
    });

    const access = await getWorkerAccessInfo(kv, 'my-app--acme-85b');

    expect(access).toMatchObject({
      org_id: 'org-1',
      is_public: false,
      usage_guard_status: 'suspended',
      usage_guard_reason: 'sustained_sqlite_usage',
    });
  });

  it('returns null when the canonical registry key is absent', async () => {
    await expect(
      getWorkerAccessInfo(createKv({}), 'my-app--acme-85b'),
    ).resolves.toBeNull();
  });

  it('honors configurable visibility for self-host deployments', () => {
    expect(
      isPublicAppRequest(
        { is_public: true },
        { CF_ACCOUNT_ID: 'selfhost' },
      ),
    ).toBe(true);
    expect(
      isPublicAppRequest(
        { is_public: true },
        { CF_DISPATCH_NAMESPACE: 'selfhost' },
      ),
    ).toBe(true);
    expect(
      isPublicAppRequest(
        { is_public: false },
        { CF_ACCOUNT_ID: 'selfhost' },
      ),
    ).toBe(false);
  });

  it('preserves configurable visibility for hosted deployments', () => {
    expect(
      isPublicAppRequest(
        { is_public: true },
        { CF_ACCOUNT_ID: 'hosted-account' },
      ),
    ).toBe(true);
    expect(
      isPublicAppRequest(
        { is_public: false },
        { CF_ACCOUNT_ID: 'hosted-account' },
      ),
    ).toBe(false);
  });
});
