import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { hardDeleteAdminUserWithEnv } from '../../../src/lib/auth-do.server';
import { createUser, type TestEnv } from './test-helpers';
import { getAppIndexDatabase } from '../src/app-index-db';

const testEnv = env as unknown as TestEnv;

async function waitForAdminIndexUserPresence(userId: string, present: boolean): Promise<void> {
  const adminIndex = getAppIndexDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const exists = (await adminIndex.getUsersByIds([userId])).length > 0;
    if (exists === present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for user ${userId} presence=${present} in D1 app index`);
}

describe('hardDeleteAdminUserWithEnv', () => {
  it('removes deleted users from D1 app index user list', async () => {
    const email = `hard-delete-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const { userId } = await createUser(testEnv, email, 'password123', 'Delete Me');

    await waitForAdminIndexUserPresence(userId, true);

    const result = await hardDeleteAdminUserWithEnv(testEnv as never, userId, 'system-admin');
    expect(result.removed_org_memberships).toBe(0);

    const profile = await testEnv.USER.get(testEnv.USER.idFromName(userId)).getProfile();
    expect(profile).toBeNull();

    await waitForAdminIndexUserPresence(userId, false);
  });

  it('ignores stale user_upsert events after delete', async () => {
    const email = `hard-delete-race-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const { userId } = await createUser(testEnv, email, 'password123', 'Race User');
    const adminIndex = getAppIndexDatabase(testEnv)!;

    await waitForAdminIndexUserPresence(userId, true);

    await hardDeleteAdminUserWithEnv(testEnv as never, userId, 'system-admin');
    await waitForAdminIndexUserPresence(userId, false);

    // Simulate out-of-order delivery: stale upsert arrives after delete.
    await adminIndex.handleEvent({
      type: 'user_upsert',
      payload: {
        id: userId,
        email,
        name: 'Race User',
        avatar: { color: '#111111', content: 'R' },
        created_at: Date.now(),
        is_superuser: false,
        is_orphaned: true,
        org_count: 0,
      },
    });

    await waitForAdminIndexUserPresence(userId, false);
  });

  it('does not delete another global account email mapping for a tenant SSO user', async () => {
    const email = `tenant-delete-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const { userId: globalUserId } = await createUser(
      testEnv,
      email,
      'password123',
      'Global User',
    );
    const tenantUserId = crypto.randomUUID();
    await testEnv.USER.get(
      testEnv.USER.idFromName(tenantUserId),
    ).createUserFromEnterpriseSso(tenantUserId, email, 'Tenant User');
    // The legacy worker-test helper stores the unprefixed compatibility key;
    // production auth uses the namespaced email key.
    await testEnv.EMAIL_TO_USER.put(`email:${email}`, globalUserId);

    expect(await testEnv.EMAIL_TO_USER.get(`email:${email}`)).toBe(globalUserId);

    await hardDeleteAdminUserWithEnv(testEnv as never, tenantUserId, 'system-admin');

    expect(await testEnv.EMAIL_TO_USER.get(`email:${email}`)).toBe(globalUserId);
    expect(
      await testEnv.USER.get(
        testEnv.USER.idFromName(globalUserId),
      ).getProfile(),
    ).not.toBeNull();
  });
});
