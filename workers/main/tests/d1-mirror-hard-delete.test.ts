import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppIndexDatabase } from '../src/app-index-db';
import {
  getMirrorBackfillState,
  runMirrorBackfillStep,
  startMirrorBackfill,
} from '../src/admin-index-bootstrap';
import { reconcileOrg, runMirrorReconcile } from '../src/d1-mirror-reconcile';
import { createOrg, createUser, flushD1Mirror, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;
type ReconcileEnv = Parameters<typeof reconcileOrg>[0];

async function mirroredOrg(name: string) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.ensureSchema();
  const { userId } = await createUser(testEnv, `hd-${crypto.randomUUID()}@example.com`, 'password123', 'HD');
  const { org, defaultWorkspaceId } = await createOrg(testEnv, name, userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const thread = await orgStub.createThread(defaultWorkspaceId, 'HD thread', userId);
  await flushD1Mirror(orgStub);
  return { appIndex, userId, org, orgStub, defaultWorkspaceId, thread };
}

async function orgRowCounts(orgId: string) {
  const db = testEnv.APP_DB!;
  const count = async (table: string, column = 'org_id') =>
    Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(orgId).first<{ n: number }>())?.n);
  return {
    orgs: await count('orgs', 'id'),
    memberships: await count('org_memberships'),
    workspaces: await count('workspaces'),
    threads: await count('threads'),
  };
}

const NONE = { orgs: 0, memberships: 0, workspaces: 0, threads: 0 };

describe('D1 mirror hard deletes and orphans', () => {
  it('org hard delete purges and tombstones its D1 rows', async () => {
    const { appIndex, org, orgStub } = await mirroredOrg('Hard Delete Org');
    expect((await orgRowCounts(org.id)).orgs).toBe(1);

    await orgStub.hardDeleteOrg('system-admin');
    expect(await orgRowCounts(org.id)).toEqual(NONE);

    // A late drain of the org row cannot bring it back.
    await appIndex.applyAdminEvent({
      type: 'org_upsert',
      payload: { id: org.id, name: 'Zombie', created_at: 1 },
      version: Date.now() * 1000,
    });
    await appIndex.applyAdminEvent({ type: 'org_upsert', payload: { id: org.id, name: 'Zombie', created_at: 1 } });
    expect((await orgRowCounts(org.id)).orgs).toBe(0);
  });

  it('the orphan purge removes rows of orgs and users whose DO is gone', async () => {
    const { appIndex, org, orgStub } = await mirroredOrg('Orphan Org');
    // Simulate a hard delete from before the purge existed: DO wiped, D1 left behind.
    await orgStub.hardDeleteOrg('system-admin');
    const orphanUserId = `orphan-${crypto.randomUUID()}`;
    await appIndex.applyAdminEvent({
      type: 'org_upsert',
      payload: { id: `ghost-${crypto.randomUUID()}`, name: 'never had a DO', created_at: 1 },
    });
    await testEnv.APP_DB!.batch([
      testEnv.APP_DB!.prepare('DELETE FROM mirror_rows WHERE entity = ? AND entity_key = ?').bind('org', org.id),
      testEnv.APP_DB!.prepare(
        "INSERT INTO orgs (id, name, created_at, archived, member_count, workspace_count) VALUES (?, 'Left behind', 1, 0, 1, 1)",
      ).bind(org.id),
      testEnv.APP_DB!.prepare(
        "INSERT INTO workspaces (id, name, org_id, created_at, archived, compute_tier, thread_count, integration_count) VALUES (?, 'Left', ?, 1, 0, 'standard', 0, 0)",
      ).bind(`left-${crypto.randomUUID()}`, org.id),
      testEnv.APP_DB!.prepare(
        "INSERT INTO users (id, email, created_at, is_superuser, is_orphaned, org_count) VALUES (?, 'orphan@example.com', 1, 0, 0, 0)",
      ).bind(orphanUserId),
    ]);
    // The reconciler sees it as drift until purged.
    expect((await reconcileOrg(testEnv as unknown as ReconcileEnv, org.id)).drift).toEqual([
      expect.objectContaining({ entity: 'org', field: 'do_missing' }),
    ]);

    // A live org is kept.
    const live = await mirroredOrg('Live Org');

    await startMirrorBackfill(testEnv, { orphansOnly: true });
    let state = await getMirrorBackfillState(testEnv);
    expect(state.phase).toBe('orphan_orgs');
    for (let step = 0; step < 500 && state.status === 'running'; step += 1) {
      state = await runMirrorBackfillStep(testEnv, 50);
    }
    expect(state).toMatchObject({ status: 'done', errors: 0 });
    expect(state.orphan_orgs_purged).toBeGreaterThanOrEqual(2);
    expect(state.orphan_users_purged).toBeGreaterThanOrEqual(1);

    expect(await orgRowCounts(org.id)).toEqual(NONE);
    expect(await testEnv.APP_DB!.prepare('SELECT 1 FROM users WHERE id = ?').bind(orphanUserId).first()).toBeNull();
    expect((await orgRowCounts(live.org.id)).orgs).toBe(1);
  });

  it('dry run lists candidates without deleting; purges need corroboration', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    await appIndex.ensureSchema();
    const db = testEnv.APP_DB!;
    const now = Date.now();
    const quietOrg = `quiet-${crypto.randomUUID()}`;
    const recentOrg = `recent-${crypto.randomUUID()}`;
    const goneUser = `gone-${crypto.randomUUID()}`;
    const loginUser = `login-${crypto.randomUUID()}`;
    const memberUser = `member-${crypto.randomUUID()}`;
    const loginEmail = `${loginUser}@example.com`;
    const userRow = (id: string, email: string) =>
      db.prepare(
        'INSERT INTO users (id, email, created_at, is_superuser, is_orphaned, org_count) VALUES (?, ?, 1, 0, 0, 0)',
      ).bind(id, email);
    await db.batch([
      // No OrgDO behind either org; only the recent one has fresh D1 activity.
      db.prepare("INSERT INTO orgs (id, name, created_at, archived, member_count, workspace_count) VALUES (?, 'Quiet', 1, 0, 0, 0)").bind(quietOrg),
      db.prepare("INSERT INTO orgs (id, name, created_at, archived, member_count, workspace_count) VALUES (?, 'Recent', 1, 0, 1, 0)").bind(recentOrg),
      db.prepare("INSERT INTO org_memberships (org_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)").bind(recentOrg, memberUser, now),
      // No UserDO profile behind any of these users.
      userRow(goneUser, `${goneUser}@example.com`),
      userRow(loginUser, loginEmail),
      userRow(memberUser, `${memberUser}@example.com`),
    ]);
    // The login index still maps this user's email to it.
    await testEnv.EMAIL_TO_USER.put(`email:${loginEmail}`, loginUser);

    const runJob = async (dryRun: boolean) => {
      await startMirrorBackfill(testEnv, { orphansOnly: true, dryRun });
      let state = await getMirrorBackfillState(testEnv);
      for (let step = 0; step < 500 && state.status === 'running'; step += 1) {
        state = await runMirrorBackfillStep(testEnv, 50);
      }
      return state;
    };
    const exists = async (table: string, id: string) =>
      Boolean(await db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first());

    const dry = await runJob(true);
    expect(dry).toMatchObject({ status: 'done', dry_run: true });
    expect(dry.orphan_org_candidates).toContain(quietOrg);
    expect(dry.orphan_org_candidates).not.toContain(recentOrg);
    expect(dry.orphan_user_candidates).toContain(goneUser);
    expect(dry.orphan_user_candidates).not.toContain(loginUser);
    expect(dry.orphan_user_candidates).not.toContain(memberUser);
    expect(await exists('orgs', quietOrg)).toBe(true);
    expect(await exists('users', goneUser)).toBe(true);

    const real = await runJob(false);
    expect(real).toMatchObject({ status: 'done', dry_run: false });
    expect(await exists('orgs', quietOrg)).toBe(false);
    expect(await exists('orgs', recentOrg)).toBe(true);
    expect(await exists('users', goneUser)).toBe(false);
    expect(await exists('users', loginUser)).toBe(true);
    expect(await exists('users', memberUser)).toBe(true);
    expect(await db.prepare('SELECT 1 FROM deleted_users WHERE id = ?').bind(loginUser).first()).toBeNull();
  });

  it('the reconciler purges a do_missing org it samples', async () => {
    const { org, orgStub } = await mirroredOrg('Reconciler Purge Org');
    await orgStub.hardDeleteOrg('system-admin');
    await testEnv.APP_DB!.batch([
      testEnv.APP_DB!.prepare('DELETE FROM mirror_rows WHERE entity = ? AND entity_key = ?').bind('org', org.id),
      testEnv.APP_DB!.prepare(
        "INSERT INTO orgs (id, name, created_at, archived, member_count, workspace_count) VALUES (?, 'Left behind', 1, 0, 0, 0)",
      ).bind(org.id),
    ]);
    await runMirrorReconcile(testEnv as unknown as ReconcileEnv, { sample: 1000 });
    expect((await orgRowCounts(org.id)).orgs).toBe(0);
  });
});
