import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';
import { DAY_MS } from '../src/admin-dashboard-metrics';
import {
  AppIndexDatabase,
  getAppIndexDatabase,
  getAppIndexReadDatabase,
} from '../src/app-index-db';
import { encryptCredentials } from '../../../src/lib/integration-crypto';

const testEnv = env as unknown as TestEnv;

function uniqueEmail(domain = 'example.com') {
  return `admin-metrics-${Date.now()}-${Math.random().toString(36).slice(2)}@${domain}`;
}

function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function uniqueDomain(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.test`;
}

async function buildExcludedDomains(allowedDomain: string): Promise<string> {
  const adminIndex = getAppIndexReadDatabase(testEnv)!;
  const allUsers = await adminIndex.getUsersPaginated(0, 100_000);
  const domains = new Set<string>(['camelai.com']);

  for (const user of allUsers.items as Array<{ email?: string | null }>) {
    const email = user.email ?? null;
    const atIndex = email?.lastIndexOf('@') ?? -1;
    if (atIndex >= 0 && atIndex < (email?.length ?? 0) - 1) {
      domains.add(email!.slice(atIndex + 1).toLowerCase());
    }
  }

  domains.delete(allowedDomain);
  return Array.from(domains).sort().join(',');
}

async function seedDashboardMetricFixture(allowedDomain: string) {
  const adminIndex = getAppIndexDatabase(testEnv)!;
  const now = Date.now();
  const todayStart = startOfUtcDay(now);
  const tenDaysAgo = todayStart - 10 * DAY_MS + 1_000;
  const twoDaysAfterSignup = tenDaysAgo + 2 * DAY_MS + 1_000;

  const userAId = crypto.randomUUID();
  const userBId = crypto.randomUUID();
  const orgAId = crypto.randomUUID();
  const orgBId = crypto.randomUUID();
  const wsAId = crypto.randomUUID();
  const wsBId = crypto.randomUUID();
  const threadRetentionId = crypto.randomUUID();
  const threadTodayAId = crypto.randomUUID();
  const threadTodayBId = crypto.randomUUID();
  const appTodayAId = `${orgAId}:summary-public-${crypto.randomUUID().slice(0, 8)}`;
  const appTodayBId = `${orgBId}:summary-private-${crypto.randomUUID().slice(0, 8)}`;

  await adminIndex.handleEvent({
    type: 'user_upsert',
    payload: {
      id: userAId,
      email: `summary-a@${allowedDomain}`,
      name: 'Summary User A',
      avatar: { color: '#111111', content: 'A' },
      created_at: tenDaysAgo,
      is_superuser: false,
      is_orphaned: false,
      org_count: 1,
    },
  });
  await adminIndex.handleEvent({
    type: 'user_upsert',
    payload: {
      id: userBId,
      email: `summary-b@${allowedDomain}`,
      name: 'Summary User B',
      avatar: { color: '#222222', content: 'B' },
      created_at: todayStart + 2_000,
      is_superuser: false,
      is_orphaned: false,
      org_count: 1,
    },
  });

  await adminIndex.handleEvent({
    type: 'org_upsert',
    payload: {
      id: orgAId,
      name: 'Summary Org A',
      slug: `summary-org-a-${crypto.randomUUID().slice(0, 6)}`,
      created_at: tenDaysAgo + 100,
      archived: false,
      billing_status: 'paying',
      created_by: userAId,
      member_count: 1,
      workspace_count: 1,
    },
  });
  await adminIndex.handleEvent({
    type: 'org_upsert',
    payload: {
      id: orgBId,
      name: 'Summary Org B',
      slug: `summary-org-b-${crypto.randomUUID().slice(0, 6)}`,
      created_at: todayStart + 2_100,
      archived: false,
      billing_status: null,
      created_by: userBId,
      member_count: 1,
      workspace_count: 1,
    },
  });

  await adminIndex.handleEvent({
    type: 'workspace_upsert',
    payload: {
      id: wsAId,
      name: 'Summary Workspace A',
      org_id: orgAId,
      description: null,
      avatar: { color: '#aaaaaa', content: 'A' },
      created_at: tenDaysAgo + 200,
      created_by: userAId,
      archived: false,
      archived_at: null,
      archived_by: null,
      compute_tier: 'standard',
      integration_count: 0,
    },
  });
  await adminIndex.handleEvent({
    type: 'workspace_upsert',
    payload: {
      id: wsBId,
      name: 'Summary Workspace B',
      org_id: orgBId,
      description: null,
      avatar: { color: '#bbbbbb', content: 'B' },
      created_at: todayStart + 2_200,
      created_by: userBId,
      archived: false,
      archived_at: null,
      archived_by: null,
      compute_tier: 'standard',
      integration_count: 0,
    },
  });

  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: threadRetentionId,
      title: 'Retention Thread',
      org_id: orgAId,
      workspace_id: wsAId,
      created_at: twoDaysAfterSignup,
      updated_at: twoDaysAfterSignup,
      created_by: userAId,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: threadTodayAId,
      title: 'Today Thread A',
      org_id: orgAId,
      workspace_id: wsAId,
      created_at: todayStart + 4_000,
      updated_at: todayStart + 4_000,
      created_by: userAId,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: threadTodayBId,
      title: 'Today Thread B',
      org_id: orgBId,
      workspace_id: wsBId,
      created_at: todayStart + 5_000,
      updated_at: todayStart + 5_000,
      created_by: userBId,
    },
  });

  await adminIndex.handleEvent({
    type: 'app_upsert',
    payload: {
      app_id: appTodayAId,
      script_name: appTodayAId.split(':')[1],
      org_id: orgAId,
      workspace_id: wsAId,
      created_by: userAId,
      created_at: todayStart + 6_000,
      updated_at: todayStart + 6_000,
      is_public: true,
      preview_status: null,
      preview_error: null,
    },
  });
  await adminIndex.handleEvent({
    type: 'app_upsert',
    payload: {
      app_id: appTodayBId,
      script_name: appTodayBId.split(':')[1],
      org_id: orgBId,
      workspace_id: wsBId,
      created_by: userBId,
      created_at: todayStart + 7_000,
      updated_at: todayStart + 7_000,
      is_public: false,
      preview_status: null,
      preview_error: null,
    },
  });

  return {
    today: new Date(now).toISOString().slice(0, 10),
    userAId,
    userBId,
    orgAId,
    orgBId,
    threadTodayAId,
    threadTodayBId,
    appTodayAId,
    appTodayBId,
  };
}

async function seedRetentionMetricFixture(allowedDomain: string) {
  const adminIndex = getAppIndexDatabase(testEnv)!;
  const now = Date.now();
  const todayStart = startOfUtcDay(now);
  const eightDaysAgo = todayStart - 8 * DAY_MS + 1_000;

  const user1Id = crypto.randomUUID();
  const user2Id = crypto.randomUUID();
  const user3Id = crypto.randomUUID();
  const records = [
    {
      userId: user1Id,
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      email: `retention-one@${allowedDomain}`,
      name: 'Retention One',
      createdAt: eightDaysAgo,
      slug: `retention-one-${crypto.randomUUID().slice(0, 6)}`,
      billingStatus: null,
    },
    {
      userId: user2Id,
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      email: `retention-two@${allowedDomain}`,
      name: 'Retention Two',
      createdAt: eightDaysAgo + 1_000,
      slug: `retention-two-${crypto.randomUUID().slice(0, 6)}`,
      billingStatus: null,
    },
    {
      userId: user3Id,
      orgId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      email: `retention-three@${allowedDomain}`,
      name: 'Retention Three',
      createdAt: todayStart + 1_000,
      slug: `retention-three-${crypto.randomUUID().slice(0, 6)}`,
      billingStatus: null,
    },
  ];

  for (const [index, record] of records.entries()) {
    await adminIndex.handleEvent({
      type: 'user_upsert',
      payload: {
        id: record.userId,
        email: record.email,
        name: record.name,
        avatar: { color: `#${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}${index + 1}`, content: record.name[0] },
        created_at: record.createdAt,
        is_superuser: false,
        is_orphaned: false,
        org_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_upsert',
      payload: {
        id: record.orgId,
        name: `${record.name} Org`,
        slug: record.slug,
        created_at: record.createdAt + 10,
        archived: false,
        billing_status: record.billingStatus,
        created_by: record.userId,
        member_count: 1,
        workspace_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'workspace_upsert',
      payload: {
        id: record.workspaceId,
        name: `${record.name} Workspace`,
        org_id: record.orgId,
        description: null,
        avatar: { color: '#999999', content: record.name[0] },
        created_at: record.createdAt + 20,
        created_by: record.userId,
        archived: false,
        archived_at: null,
        archived_by: null,
        compute_tier: 'standard',
        integration_count: 0,
      },
    });
  }

  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: crypto.randomUUID(),
      title: 'Retention One Signup',
      org_id: records[0].orgId,
      workspace_id: records[0].workspaceId,
      created_at: records[0].createdAt + 30,
      updated_at: records[0].createdAt + 30,
      created_by: records[0].userId,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: crypto.randomUUID(),
      title: 'Retention One Day One',
      org_id: records[0].orgId,
      workspace_id: records[0].workspaceId,
      created_at: records[0].createdAt + DAY_MS + 30,
      updated_at: records[0].createdAt + DAY_MS + 30,
      created_by: records[0].userId,
    },
  });
  await adminIndex.handleEvent({
    type: 'app_upsert',
    payload: {
      app_id: `${records[1].orgId}:retention-signup`,
      script_name: 'retention-signup',
      org_id: records[1].orgId,
      workspace_id: records[1].workspaceId,
      created_by: records[1].userId,
      created_at: records[1].createdAt + 30,
      updated_at: records[1].createdAt + 30,
      is_public: true,
      preview_status: null,
      preview_error: null,
    },
  });
  await adminIndex.handleEvent({
    type: 'thread_upsert',
    payload: {
      id: crypto.randomUUID(),
      title: 'Retention Three Signup',
      org_id: records[2].orgId,
      workspace_id: records[2].workspaceId,
      created_at: records[2].createdAt + 30,
      updated_at: records[2].createdAt + 30,
      created_by: records[2].userId,
    },
  });
}

async function waitForAdminIndexOrgCount(minCount: number): Promise<void> {
  const adminIndex = getAppIndexDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const orgs = await adminIndex.getOrgDirectoryRows();
    if (orgs.length >= minCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for ${minCount} orgs in D1 app index`);
}

async function waitForAdminIndexOrgIds(orgIds: string[]): Promise<void> {
  const adminIndex = getAppIndexDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const orgs = await adminIndex.getOrgDirectoryRows();
    const orgIdSet = new Set(orgs.map((org: { id: string }) => org.id));
    if (orgIds.every((orgId) => orgIdSet.has(orgId))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for org ids ${orgIds.join(', ')} in D1 app index`);
}

async function waitForAdminIndexOrgBillingStatus(
  orgId: string,
  billingStatus: string | null,
): Promise<void> {
  const adminIndex = getAppIndexDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await adminIndex.getOrgDirectoryByIds([orgId]);
    if ((rows[0]?.billing_status ?? null) === billingStatus) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for billing status ${billingStatus} on org ${orgId}`);
}

async function waitForAdminIndexOrgLlmProvider(
  orgId: string,
  provider: string,
): Promise<void> {
  const adminIndex = getAppIndexDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await adminIndex.getOrgLlmProviderDirectoryPaginated(
      0,
      100,
      undefined,
      provider,
    );
    if (rows.items.some((org: { id: string }) => org.id === orgId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for LLM provider ${provider} on org ${orgId}`);
}

async function waitForAdminIndexSpamSummary(orgIds: string[], expected: {
  users: number;
  threads: number;
  apps: number;
  orgs: number;
}): Promise<void> {
  const adminIndex = getAppIndexDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [users, threads, apps, orgs] = await Promise.all([
      adminIndex.getUsersByOrgIds(orgIds),
      adminIndex.getThreadsByOrgIds(orgIds),
      adminIndex.getAppsByOrgIds(orgIds),
      adminIndex.getOrgDirectoryByIds(orgIds),
    ]);
    if (
      users.length >= expected.users &&
      threads.length >= expected.threads &&
      apps.length >= expected.apps &&
      orgs.length >= expected.orgs
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for spam summary rows for org ids ${orgIds.join(', ')}`);
}

async function callAdminApi(
  request: Request,
  sandboxFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  envOverride?: WorkerEnv,
) {
  return handleAdminApi({
    req: request,
    env: envOverride ?? {
      ...testEnv,
      ADMIN_API_KEY: 'test-admin-api-key',
    } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
}

function createIsolatedAdminApiEnv(
  _adminIndexName: string,
  sandboxFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return {
    ...testEnv,
    ADMIN_API_KEY: 'test-admin-api-key',
  } as unknown as WorkerEnv;
}

describe('admin API metrics routes', () => {
  it('serves aggregate stats', async () => {
    const response = await callAdminApi(
      new Request('http://example/api/admin/stats', {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      }),
      vi.fn(async () => Response.json({})),
    );

    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toEqual(
      expect.objectContaining({
        total_users: expect.any(Number),
        total_orgs: expect.any(Number),
        total_workspaces: expect.any(Number),
      }),
    );
  });

  it('ranks top orgs without loading and discarding every org member', async () => {
    const getUsersByOrgIds = vi
      .spyOn(AppIndexDatabase.prototype, 'getUsersByOrgIds')
      .mockRejectedValue(new Error('top-org ranking must not load every member'));

    try {
      const response = await callAdminApi(
        new Request(
          'http://example/api/admin/dashboard/top-orgs?exclude_spam=false',
          { headers: { Authorization: 'Bearer test-admin-api-key' } },
        ),
        vi.fn(async () => Response.json({})),
      );

      expect(response?.status).toBe(200);
      expect(getUsersByOrgIds).not.toHaveBeenCalled();
    } finally {
      getUsersByOrgIds.mockRestore();
    }
  });

  it('keeps paginated thread rows to the public list projection', async () => {
    const adminIndex = getAppIndexDatabase(testEnv)!;
    const threadId = crypto.randomUUID();
    await adminIndex.handleEvent({
      type: 'thread_upsert',
      payload: {
        id: threadId,
        title: 'Projected admin thread',
        model: 'sonnet',
        org_id: crypto.randomUUID(),
        workspace_id: crypto.randomUUID(),
        created_at: Date.now(),
        updated_at: Date.now(),
        created_by: crypto.randomUUID(),
        first_user_message: 'This preview must not be loaded by the list route.',
        model_history: JSON.stringify([{ model: 'sonnet' }]),
      },
    });

    const response = await callAdminApi(
      new Request(
        `http://example/api/admin/threads?search=${encodeURIComponent(threadId)}`,
        { headers: { Authorization: 'Bearer test-admin-api-key' } },
      ),
      vi.fn(async () => Response.json({})),
    );

    expect(response?.status).toBe(200);
    const payload = await response!.json() as { items: Array<Record<string, unknown>> };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toEqual(expect.objectContaining({ id: threadId }));
    expect(payload.items[0]).not.toHaveProperty('first_user_message');
    expect(payload.items[0]).not.toHaveProperty('model_history');
    expect(payload.items[0]).not.toHaveProperty('last_chat_error_message');
  });

  it('serves counter columns used by dashboard API endpoints', async () => {
    const adminIndexName = `admin_index_legacy_counters_${crypto.randomUUID()}`;
    const sandboxFetch = vi.fn(async () => Response.json({ org_ids: [], count: 0 }));
    const isolatedEnv = createIsolatedAdminApiEnv(adminIndexName, sandboxFetch);
    const adminIndex = getAppIndexDatabase(testEnv)!;
    const now = Date.now();
    const selectedDate = new Date(now).toISOString().slice(0, 10);
    const userId = crypto.randomUUID();
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const adminRequest = (path: string) =>
      new Request(`http://example/api/admin${path}`, {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      });

    await adminIndex.handleEvent({
      type: 'user_upsert',
      payload: {
        id: userId,
        email: `legacy-workspace-${crypto.randomUUID()}@example.com`,
        name: 'Legacy Workspace User',
        avatar: { color: '#123456', content: 'L' },
        created_at: now,
        is_superuser: false,
        is_orphaned: false,
        org_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_upsert',
      payload: {
        id: orgId,
        name: 'Legacy Workspace Org',
        slug: `legacy-workspace-${crypto.randomUUID().slice(0, 8)}`,
        created_at: now,
        archived: false,
        billing_status: null,
        created_by: userId,
        member_count: 1,
        workspace_count: 1,
      },
    });
    await adminIndex.handleEvent({
      type: 'org_membership_upsert',
      payload: {
        org_id: orgId,
        user_id: userId,
        role: 'admin',
        joined_at: now,
      },
    });
    await adminIndex.handleEvent({
      type: 'workspace_upsert',
      payload: {
        id: workspaceId,
        name: 'Legacy Workspace',
        org_id: orgId,
        description: null,
        avatar: { color: '#654321', content: 'W' },
        created_at: now,
        created_by: userId,
        archived: false,
        archived_at: null,
        archived_by: null,
        compute_tier: 'standard',
        integration_count: 3,
      },
    });
    await adminIndex.handleEvent({
      type: 'thread_upsert',
      payload: {
        id: crypto.randomUUID(),
        title: 'Legacy Thread',
        org_id: orgId,
        workspace_id: workspaceId,
        created_at: now + 1,
        updated_at: now + 1,
        created_by: userId,
      },
    });

    const statsResponse = await callAdminApi(adminRequest('/stats'), sandboxFetch, isolatedEnv);
    expect(statsResponse?.status).toBe(200);
    const stats = await statsResponse!.json() as {
      total_workspaces: number;
      total_memberships: number;
      total_integrations: number;
    };
    expect(stats.total_workspaces).toBe(1);
    expect(stats.total_memberships).toBe(1);
    expect(stats.total_integrations).toBeGreaterThanOrEqual(3);

    const workspacesResponse = await callAdminApi(adminRequest('/workspaces?limit=10'), sandboxFetch, isolatedEnv);
    expect(workspacesResponse?.status).toBe(200);
    const workspaces = await workspacesResponse!.json() as {
      items: Array<{ id: string; thread_count: number; integration_count: number }>;
    };
    expect(workspaces.items).toEqual([
      expect.objectContaining({
        id: workspaceId,
        thread_count: 1,
        integration_count: 3,
      }),
    ]);

    const summaryResponse = await callAdminApi(
      adminRequest(`/dashboard/summary?date=${selectedDate}&exclude_spam=false`),
      sandboxFetch,
      isolatedEnv,
    );
    expect(summaryResponse?.status).toBe(200);
    const summary = await summaryResponse!.json() as {
      kpis: { total_workspaces: number; total_users: number };
    };
    expect(summary.kpis.total_workspaces).toBe(1);
    expect(summary.kpis.total_users).toBe(1);
  });




  it('exposes BYOK provider status for admin org listing', async () => {
    const secretKey = testEnv.INTEGRATION_SECRET_KEY ?? 'admin-byok-test-secret';
    const { userId } = await createUser(
      testEnv,
      uniqueEmail(),
      'password123',
      'Admin BYOK User',
    );
    const searchPrefix = `Admin BYOK ${crypto.randomUUID().slice(0, 8)}`;
    const { org } = await createOrg(testEnv, `${searchPrefix} One`, userId);
    const { org: secondOrg } = await createOrg(
      testEnv,
      `${searchPrefix} Two`,
      userId,
    );
    await waitForAdminIndexOrgIds([org.id]);
    await waitForAdminIndexOrgIds([secondOrg.id]);

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const secondOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(secondOrg.id));
    const encrypted = await encryptCredentials(
      { api_key: 'sk-or-admin-byok-visible' },
      secretKey,
    );
    const secondEncrypted = await encryptCredentials(
      { api_key: 'sk-or-admin-byok-visible-2' },
      secretKey,
    );
    await orgStub.setLlmProviderConfig(
      'openrouter',
      encrypted,
      JSON.stringify({}),
      userId,
    );
    await secondOrgStub.setLlmProviderConfig(
      'openrouter',
      secondEncrypted,
      JSON.stringify({}),
      userId,
    );
    await waitForAdminIndexOrgLlmProvider(org.id, 'openrouter');
    await waitForAdminIndexOrgLlmProvider(secondOrg.id, 'openrouter');

    const sandboxFetch = vi.fn(async () => Response.json({}));
    const adminEnv = {
      ...testEnv,
      ADMIN_API_KEY: 'test-admin-api-key',
      INTEGRATION_SECRET_KEY: secretKey,
    } as unknown as WorkerEnv;

    const byokResponse = await callAdminApi(
      new Request(
        `http://example/api/admin/orgs/llm-providers?search=${encodeURIComponent(org.slug)}`,
        {
          headers: { Authorization: 'Bearer test-admin-api-key' },
        },
      ),
      sandboxFetch,
      adminEnv,
    );
    expect(byokResponse?.status).toBe(200);
    const byokBody = await byokResponse!.json() as {
      items: Array<{
        id: string;
        has_llm_provider: boolean;
        llm_provider: { provider: string; key_hint: string };
      }>;
      total: number;
    };
    expect(byokBody.total).toBe(1);
    expect(byokBody.items).toEqual([
      expect.objectContaining({
        id: org.id,
        has_llm_provider: true,
        llm_provider: expect.objectContaining({
          provider: 'openrouter',
          key_hint: 'sk-or-ad...',
        }),
      }),
    ]);
    expect(JSON.stringify(byokBody)).not.toContain('credentials_encrypted');

    const paginatedByokResponse = await callAdminApi(
      new Request(
        `http://example/api/admin/orgs/llm-providers?search=${encodeURIComponent(searchPrefix)}&limit=1&offset=1`,
        {
          headers: { Authorization: 'Bearer test-admin-api-key' },
        },
      ),
      sandboxFetch,
      adminEnv,
    );
    expect(paginatedByokResponse?.status).toBe(200);
    const paginatedByokBody = await paginatedByokResponse!.json() as {
      items: Array<{ id: string; has_llm_provider: boolean }>;
      total: number;
      offset: number;
      limit: number;
    };
    expect(paginatedByokBody).toEqual({
      items: [
        expect.objectContaining({
          id: expect.stringMatching(
            new RegExp(`^(${org.id}|${secondOrg.id})$`),
          ),
          has_llm_provider: true,
        }),
      ],
      total: 2,
      offset: 1,
      limit: 1,
    });

    const orgsResponse = await callAdminApi(
      new Request(
        `http://example/api/admin/orgs?search=${encodeURIComponent(org.slug)}&include_llm_provider=1`,
        {
          headers: { Authorization: 'Bearer test-admin-api-key' },
        },
      ),
      sandboxFetch,
      adminEnv,
    );
    expect(orgsResponse?.status).toBe(200);
    await expect(orgsResponse!.json()).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: org.id,
          has_llm_provider: true,
          llm_provider: expect.objectContaining({
            provider: 'openrouter',
            key_hint: 'sk-or-ad...',
          }),
        }),
      ],
      total: 1,
      offset: 0,
      limit: 50,
    });
  });




  it('serves dashboard retention without sandbox spam lookups when disabled', async () => {
    const allowedDomain = uniqueDomain('retention-metrics');
    await seedRetentionMetricFixture(allowedDomain);
    const excludedDomains = await buildExcludedDomains(allowedDomain);

    const sandboxFetch = vi.fn(async () => {
      throw new Error('sandbox fetch should not be called');
    });

    const request = new Request(
      `http://example/api/admin/dashboard/retention?exclude_spam=false&exclude_internal_domains=${encodeURIComponent(excludedDomains)}`,
      {
        headers: { Authorization: 'Bearer test-admin-api-key' },
      },
    );
    const response = await callAdminApi(request, sandboxFetch);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const payload = await response!.json() as {
      retention_curve: Array<{ day: number; retention_pct: number; users_eligible: number }>;
      kpis: {
        day1_retention: number;
        day7_retention: number;
        day14_retention: number;
        day30_retention: number;
      };
      cohort_table: Array<{ cohort_size: number }>;
      wau_time_series: Array<{ wau: number }>;
      stickiness_series: Array<{ dau_wau_ratio: number }>;
    };

    expect(payload.retention_curve).toEqual(
      expect.arrayContaining([
        { day: 0, retention_pct: 100, users_eligible: 3 },
        { day: 1, retention_pct: 50, users_eligible: 2 },
        { day: 7, retention_pct: 50, users_eligible: 2 },
        { day: 14, retention_pct: 0, users_eligible: 0 },
        { day: 28, retention_pct: 0, users_eligible: 0 },
      ]),
    );
    expect(payload.kpis).toEqual(expect.objectContaining({
      day1_retention: 50,
      day7_retention: 50,
      day14_retention: 0,
      day30_retention: 0,
    }));
    expect(payload.cohort_table.length).toBeGreaterThan(0);
    expect(payload.wau_time_series.length).toBeGreaterThan(0);
    expect(payload.stickiness_series).toHaveLength(30);
    expect(sandboxFetch).not.toHaveBeenCalled();
  });


});
