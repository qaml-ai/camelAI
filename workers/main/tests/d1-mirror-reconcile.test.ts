import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppIndexDatabase } from '../src/app-index-db';
import { reconcileOrg, reconcileUser, runMirrorReconcile } from '../src/d1-mirror-reconcile';
import { createOrg, createUser, flushD1Mirror, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;
type ReconcileEnv = Parameters<typeof reconcileOrg>[0];
const reconcileEnv = testEnv as unknown as ReconcileEnv;

async function mirroredOrg() {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
  const { userId } = await createUser(testEnv, `reconcile-${crypto.randomUUID()}@example.com`, 'password123', 'Rec');
  const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Reconcile Org', userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));
  const thread = await orgStub.createThread(defaultWorkspaceId, 'Reconcile thread', userId);
  await flushD1Mirror(orgStub);
  await flushD1Mirror(userStub);
  return { userId, org, defaultWorkspaceId, orgStub, userStub, thread };
}

describe('D1 mirror reconciler', () => {
  it('reports no drift for a freshly mirrored org and user', async () => {
    const { org, userId } = await mirroredOrg();
    const orgResult = await reconcileOrg(reconcileEnv, org.id);
    expect(orgResult.drift).toEqual([]);
    expect(orgResult.compared).toBeGreaterThanOrEqual(4); // org, owner, workspace, thread
    expect((await reconcileUser(reconcileEnv, userId)).drift).toEqual([]);
  });

  it('diffs field by field in both directions', async () => {
    const { org, userId, thread } = await mirroredOrg();
    const db = testEnv.APP_DB!;
    await db.batch([
      db.prepare('UPDATE orgs SET name = ? WHERE id = ?').bind('Tampered', org.id),
      db.prepare('DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?').bind(org.id, userId),
      db.prepare('UPDATE threads SET title = ? WHERE id = ?').bind('Tampered title', thread.id),
      db.prepare(
        "INSERT INTO workspaces (id, name, org_id, created_at, archived, compute_tier, thread_count, integration_count) VALUES (?, 'Ghost', ?, 1, 0, 'standard', 0, 0)",
      ).bind(`ghost-${crypto.randomUUID()}`, org.id),
      db.prepare('UPDATE users SET email = ? WHERE id = ?').bind('tampered@example.com', userId),
    ]);

    const { drift } = await reconcileOrg(reconcileEnv, org.id);
    const found = drift.map((finding) => `${finding.entity}.${finding.field}`).sort();
    expect(found).toEqual(
      ['org.name', 'org_membership.row_missing', 'thread.title', 'workspace.row_orphaned'].sort(),
    );
    expect((await reconcileUser(reconcileEnv, userId)).drift.map((finding) => finding.field)).toEqual(['email']);
  });

  it('skips rows still in flight in the outbox', async () => {
    const { org, orgStub } = await mirroredOrg();
    await orgStub.updateThread((await orgStub.getThreads())[0]!.id, 'Renamed, not yet drained');
    const { drift } = await reconcileOrg(reconcileEnv, org.id);
    expect(drift).toEqual([]);
  });

  it('resyncs a drifted DO so the next pass is clean', async () => {
    const { org, orgStub } = await mirroredOrg();
    await testEnv.APP_DB!.prepare('UPDATE orgs SET name = ? WHERE id = ?').bind('Tampered', org.id).run();
    // A sample of 500 covers every org this test file created, including this one.
    const first = await reconcileOrg(reconcileEnv, org.id);
    expect(first.drift.length).toBeGreaterThan(0);
    await runMirrorReconcile(reconcileEnv, { sample: 500 });
    await flushD1Mirror(orgStub);
    expect((await reconcileOrg(reconcileEnv, org.id)).drift).toEqual([]);
  });
});
