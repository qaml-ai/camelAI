import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { ensureAdminIndexReady } from '../../../src/lib/auth-do.server';
import { getAppIndexDatabase } from '../src/app-index-db';
import { createOrg, createUser, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;
const APP_INDEX_BOOTSTRAP_LOCK_KEY = 'admin_index_d1_bootstrap_lock';
const APP_INDEX_BOOTSTRAP_IN_PROGRESS = 'syncing';

function testEmail() {
  return `admin-index-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe('D1 admin index bootstrap', () => {
  it('bootstraps preexisting DO records into an empty D1 app index', async () => {
    const email = testEmail();
    const { userId } = await createUser(
      testEnv,
      email,
      'password123',
      'Bootstrap User',
    );
    await testEnv.EMAIL_TO_USER.put(`email:${email.toLowerCase()}`, userId);
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Bootstrap Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'Bootstrap Thread',
      userId,
    );

    const appIndex = getAppIndexDatabase(testEnv)!;
    await appIndex.ensureSchema();
    await testEnv.APP_DB!.batch([
      testEnv.APP_DB!.prepare('DELETE FROM app_index_metadata WHERE key IN (?, ?)')
        .bind('bootstrap_complete', 'ready'),
      testEnv.APP_DB!.prepare('DELETE FROM org_memberships WHERE org_id = ?')
        .bind(org.id),
      testEnv.APP_DB!.prepare('DELETE FROM threads WHERE id = ?').bind(thread.id),
      testEnv.APP_DB!.prepare('DELETE FROM workspaces WHERE id = ?')
        .bind(defaultWorkspaceId),
      testEnv.APP_DB!.prepare('DELETE FROM orgs WHERE id = ?').bind(org.id),
      testEnv.APP_DB!.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    ]);

    await ensureAdminIndexReady(testEnv as never);

    await expect(appIndex.isBootstrapComplete()).resolves.toBe(true);
    await expect(appIndex.getThreadContextById(thread.id)).resolves.toMatchObject({
      id: thread.id,
      org_id: org.id,
      workspace_id: defaultWorkspaceId,
    });
    await expect(appIndex.getOrgById(org.id)).resolves.toMatchObject({
      id: org.id,
      name: 'Bootstrap Org',
    });
    const users = await appIndex.getUsersPaginated(0, 100, 'Bootstrap User');
    expect(users.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: userId,
          name: 'Bootstrap User',
        }),
      ]),
    );
  });

  it('does not launch schema backfills from ready-database request paths', async () => {
    const email = testEmail();
    const { userId } = await createUser(
      testEnv,
      email,
      'password123',
      'Backfill User',
    );
    await testEnv.EMAIL_TO_USER.put(`email:${email.toLowerCase()}`, userId);
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Backfill Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'Backfill Thread',
      userId,
    );

    const appIndex = getAppIndexDatabase(testEnv)!;
    await appIndex.ensureSchema();
    await appIndex.markBootstrapComplete();
    await testEnv.APP_DB!.batch([
      testEnv.APP_DB!.prepare('DELETE FROM threads WHERE id = ?').bind(thread.id),
      testEnv.APP_DB!.prepare('DELETE FROM workspaces WHERE id = ?')
        .bind(defaultWorkspaceId),
      testEnv.APP_DB!.prepare('DELETE FROM orgs WHERE id = ?').bind(org.id),
      testEnv.APP_DB!.prepare('DELETE FROM users WHERE id = ?').bind(userId),
      testEnv.APP_DB!.prepare(
        "INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES ('threads_index_backfill_required', '1', ?)",
      ).bind(Date.now()),
    ]);
    await expect(appIndex.isBootstrapComplete()).resolves.toBe(true);
    await expect(appIndex.isThreadsIndexBackfillRequired()).resolves.toBe(true);

    await ensureAdminIndexReady(testEnv as never);

    await expect(appIndex.isThreadsIndexBackfillRequired()).resolves.toBe(true);
    await expect(appIndex.getThreadContextById(thread.id)).resolves.toBeNull();
  });

  it('does not return partial admin index results while another bootstrap owns the lock', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    await appIndex.ensureSchema();
    await testEnv.APP_DB!.prepare(
      "DELETE FROM app_index_metadata WHERE key IN ('bootstrap_complete', 'ready')",
    ).run();
    await testEnv.APP_KV.put(
      APP_INDEX_BOOTSTRAP_LOCK_KEY,
      APP_INDEX_BOOTSTRAP_IN_PROGRESS,
      { expirationTtl: 60 },
    );

    try {
      await expect(
        ensureAdminIndexReady(testEnv as never, {
          waitMs: 1,
          pollMs: 1,
        }),
      ).rejects.toThrow('Admin index bootstrap is still in progress');
      await expect(appIndex.isBootstrapComplete()).resolves.toBe(false);
    } finally {
      await testEnv.APP_KV.delete(APP_INDEX_BOOTSTRAP_LOCK_KEY);
      await appIndex.markBootstrapComplete();
    }
  });
});
