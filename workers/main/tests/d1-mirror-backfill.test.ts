import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppIndexDatabase } from '../src/app-index-db';
import {
  getMirrorBackfillState,
  runMirrorBackfillStep,
  startMirrorBackfill,
} from '../src/admin-index-bootstrap';
import {
  createOrg,
  createUser,
  flushD1Mirror,
  setWorkspaceAccess,
  type TestEnv,
} from './test-helpers';

const testEnv = env as unknown as TestEnv;

function uniqueEmail(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}@example.com`;
}

async function ready() {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
}

describe('D1 mirror fan-out tables', () => {
  it('mirrors workspace access overrides and the member default', async () => {
    await ready();
    const { userId: ownerId } = await createUser(testEnv, uniqueEmail('owner'), 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, uniqueEmail('member'), 'password123', 'Member');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Fanout Org', ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.addMember(memberId, 'member', ownerId);
    await setWorkspaceAccess(testEnv, defaultWorkspaceId, memberId, 'none', ownerId);
    await flushD1Mirror(orgStub);

    const db = testEnv.APP_DB!;
    expect(
      await db
        .prepare('SELECT org_id, access_level FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .bind(defaultWorkspaceId, memberId)
        .first(),
    ).toMatchObject({ org_id: org.id, access_level: 'none' });
    expect(
      await db
        .prepare('SELECT workspace_access_default FROM org_memberships WHERE org_id = ? AND user_id = ?')
        .bind(org.id, memberId)
        .first(),
    ).toMatchObject({ workspace_access_default: 'full' });

    // Removing the member removes the override row too.
    await orgStub.removeMember(memberId, ownerId);
    await flushD1Mirror(orgStub);
    expect(
      await db
        .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .bind(defaultWorkspaceId, memberId)
        .first(),
    ).toBeNull();
  });

  it('mirrors the user profile and thread-list columns', async () => {
    await ready();
    const { userId } = await createUser(testEnv, uniqueEmail('cols'), 'password123', 'Cols');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Cols Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const longMessage = 'x'.repeat(800);
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Cols thread', userId, longMessage);
    await orgStub.recordThreadAssistantCompletion(thread.id, { completedAt: Date.now() + 1000, summary: 'Done' });
    await flushD1Mirror(orgStub);
    await flushD1Mirror(testEnv.USER.get(testEnv.USER.idFromName(userId)));

    const db = testEnv.APP_DB!;
    const threadRow = await db
      .prepare(
        'SELECT first_user_message, first_user_message_preview, last_assistant_summary, last_assistant_summary_status FROM threads WHERE id = ?',
      )
      .bind(thread.id)
      .first<Record<string, string>>();
    expect(threadRow?.first_user_message_preview?.length).toBeLessThanOrEqual(501);
    expect(threadRow?.first_user_message_preview?.length).toBeGreaterThan(300);
    expect(threadRow?.first_user_message?.length).toBeLessThanOrEqual(301);
    expect(threadRow).toMatchObject({ last_assistant_summary: 'Done', last_assistant_summary_status: 'ready' });

    const userRow = await db
      .prepare('SELECT email_verified_at, orphaned_at FROM users WHERE id = ?')
      .bind(userId)
      .first<{ email_verified_at: number | null; orphaned_at: number | null }>();
    expect(userRow).toMatchObject({ orphaned_at: null });
    expect(userRow).toHaveProperty('email_verified_at');
  });
});

describe('D1 mirror backfill job', () => {
  it('walks users then orgs, resumably, and re-mirrors wiped rows', async () => {
    await ready();
    const email = uniqueEmail('backfill');
    const { userId } = await createUser(testEnv, email, 'password123', 'Backfill');
    await testEnv.EMAIL_TO_USER.put(`email:${email}`, userId);
    const { org } = await createOrg(testEnv, 'Backfill Job Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));
    await flushD1Mirror(orgStub);
    await flushD1Mirror(userStub);
    await testEnv.APP_DB!.batch([
      testEnv.APP_DB!.prepare('DELETE FROM orgs WHERE id = ?').bind(org.id),
      testEnv.APP_DB!.prepare('DELETE FROM users WHERE id = ?').bind(userId),
    ]);

    expect((await getMirrorBackfillState(testEnv)).status).not.toBe('running');
    await startMirrorBackfill(testEnv);
    let state = await getMirrorBackfillState(testEnv);
    expect(state).toMatchObject({ status: 'running', phase: 'users' });
    for (let step = 0; step < 200 && state.status === 'running'; step += 1) {
      state = await runMirrorBackfillStep(testEnv, 5);
    }
    expect(state).toMatchObject({ status: 'done', phase: 'done', errors: 0 });
    expect(state.users_queued).toBeGreaterThan(0);
    expect(state.orgs_queued).toBeGreaterThan(0);

    // The job only queues; each DO's alarm applies.
    await flushD1Mirror(orgStub);
    await flushD1Mirror(userStub);
    expect(await testEnv.APP_DB!.prepare('SELECT name FROM orgs WHERE id = ?').bind(org.id).first())
      .toMatchObject({ name: 'Backfill Job Org' });
    expect(await testEnv.APP_DB!.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first())
      .toMatchObject({ email });

    // A finished job is a no-op until restarted.
    expect(await runMirrorBackfillStep(testEnv)).toMatchObject({ status: 'done' });
  });
});
