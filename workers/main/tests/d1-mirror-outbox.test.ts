import { describe, expect, it } from 'vitest';
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getAppIndexDatabase, type AppIndexDatabase } from '../src/app-index-db';
import type { VersionedAdminEvent } from '../src/admin-index-types';
import { D1MirrorOutbox, mirrorRetryDelayMs } from '../src/identity/d1-mirror-outbox';
import { createOrg, createUser, flushD1Mirror, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function appIndex(): Promise<AppIndexDatabase> {
  const db = getAppIndexDatabase(testEnv)!;
  await db.ensureSchema();
  return db;
}

function orgUpsert(id: string, name: string, version?: number): VersionedAdminEvent {
  return {
    type: 'org_upsert',
    payload: { id, name, created_at: 1, created_by: 'u', archived: false },
    ...(version === undefined ? {} : { version }),
  };
}

async function orgName(id: string): Promise<string | null> {
  const row = await testEnv.APP_DB!.prepare('SELECT name FROM orgs WHERE id = ?').bind(id).first<{ name: string }>();
  return row?.name ?? null;
}

async function membershipExists(orgId: string, userId: string): Promise<boolean> {
  const row = await testEnv.APP_DB!
    .prepare('SELECT 1 AS ok FROM org_memberships WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId)
    .first();
  return Boolean(row);
}

describe('D1 mirror versioned apply', () => {
  it('keeps the newest version when drains arrive out of order', async () => {
    const db = await appIndex();
    const orgId = uid('org');
    await db.applyAdminEvent(orgUpsert(orgId, 'newer', 2_000));
    await db.applyAdminEvent(orgUpsert(orgId, 'older', 1_000));
    expect(await orgName(orgId)).toBe('newer');

    // A retry of the current version is idempotent, a newer one lands.
    await db.applyAdminEvent(orgUpsert(orgId, 'newer', 2_000));
    expect(await orgName(orgId)).toBe('newer');
    await db.applyAdminEvent(orgUpsert(orgId, 'newest', 3_000));
    expect(await orgName(orgId)).toBe('newest');
  });

  it('tombstones versioned deletes against stale and unversioned upserts', async () => {
    const db = await appIndex();
    const orgId = uid('org');
    const userId = uid('user');
    const membership = (version?: number): VersionedAdminEvent => ({
      type: 'org_membership_upsert',
      payload: { org_id: orgId, user_id: userId, role: 'member', joined_at: 1 },
      ...(version === undefined ? {} : { version }),
    });

    await db.applyAdminEvent(membership(1_000));
    expect(await membershipExists(orgId, userId)).toBe(true);

    await db.applyAdminEvent({
      type: 'org_membership_delete',
      payload: { org_id: orgId, user_id: userId },
      version: 2_000,
    });
    expect(await membershipExists(orgId, userId)).toBe(false);

    // A stale drain and a legacy unversioned write cannot resurrect it...
    await db.applyAdminEvent(membership(1_500));
    await db.applyAdminEvent(membership());
    expect(await membershipExists(orgId, userId)).toBe(false);

    // ...but a newer re-add does.
    await db.applyAdminEvent(membership(3_000));
    expect(await membershipExists(orgId, userId)).toBe(true);
  });

  it('ignores a stale versioned delete after a newer upsert', async () => {
    const db = await appIndex();
    const threadId = uid('thread');
    const workspaceId = uid('ws');
    await db.applyAdminEvent({
      type: 'thread_upsert',
      payload: { id: threadId, title: 'kept', org_id: 'o', workspace_id: workspaceId, created_at: 1, updated_at: 1 },
      version: 5_000,
    });
    await db.applyAdminEvent({ type: 'thread_delete', payload: { id: threadId }, version: 4_000 });
    const row = await testEnv.APP_DB!.prepare('SELECT title FROM threads WHERE id = ?').bind(threadId).first<{ title: string }>();
    expect(row?.title).toBe('kept');
  });

  it('still applies unversioned writes to rows it has never versioned', async () => {
    const db = await appIndex();
    const orgId = uid('org');
    await db.applyAdminEvent(orgUpsert(orgId, 'legacy'));
    expect(await orgName(orgId)).toBe('legacy');
  });
});

describe('D1 mirror outbox (UserDO)', () => {
  async function outboxRows(stub: DurableObjectStub) {
    return runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ key: string; attempts: number; next_attempt_at: number; generation: number }>(
          'SELECT key, attempts, next_attempt_at, generation FROM d1_mirror_outbox ORDER BY key',
        )
        .toArray(),
    );
  }

  it('writes the outbox row with the fact and drains current state on the alarm', async () => {
    await appIndex();
    const email = `${uid('mirror')}@example.com`;
    const { userId } = await createUser(testEnv, email, 'password123', 'Mirror User', '203.0.113.9');
    const stub = testEnv.USER.get(testEnv.USER.idFromName(userId));
    await stub.addOrg(uid('org'), 'member');

    expect((await outboxRows(stub)).map((row) => row.key)).toEqual(['user:self']);

    // Force the coalescing delay to have elapsed, then run the alarm.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE d1_mirror_outbox SET next_attempt_at = 0');
    });
    await runDurableObjectAlarm(stub);

    expect(await outboxRows(stub)).toEqual([]);
    const row = await testEnv.APP_DB!
      .prepare('SELECT email, name, org_count, signup_ip FROM users WHERE id = ?')
      .bind(userId)
      .first();
    expect(row).toMatchObject({ email, name: 'Mirror User', org_count: 1, signup_ip: '203.0.113.9' });
    const version = await testEnv.APP_DB!
      .prepare("SELECT version FROM mirror_rows WHERE entity = 'user' AND entity_key = ?")
      .bind(userId)
      .first<{ version: number }>();
    expect(version?.version).toBeGreaterThan(0);
  });

  it('backs off failed rows and stops draining after repeated failures', async () => {
    const { userId } = await createUser(testEnv, `${uid('mirror')}@example.com`, 'password123', 'Backoff');
    const stub = testEnv.USER.get(testEnv.USER.idFromName(userId));

    await runInDurableObject(stub, async (_instance, state) => {
      const outbox = new D1MirrorOutbox(state.storage);
      state.storage.sql.exec('DELETE FROM d1_mirror_outbox');
      for (const id of ['a', 'b', 'c', 'd']) outbox.markDirty('thread', id);
      state.storage.sql.exec('UPDATE d1_mirror_outbox SET next_attempt_at = 0');

      const failing = {
        applyAdminEvent: async () => {
          throw new Error('D1 unavailable');
        },
      } as unknown as AppIndexDatabase;
      const before = Date.now();
      const result = await outbox.drain(failing, (kind, id) => [
        { type: 'thread_delete', payload: { id: `${kind}-${id}` } },
      ]);
      expect(result).toMatchObject({ applied: 0, failed: 3, remaining: 4 });

      const rows = state.storage.sql
        .exec<{ attempts: number; next_attempt_at: number; last_error: string | null }>(
          'SELECT attempts, next_attempt_at, last_error FROM d1_mirror_outbox',
        )
        .toArray();
      // Every row, including the one never attempted, is pushed behind the backoff.
      for (const row of rows) expect(row.next_attempt_at).toBeGreaterThan(before);
      expect(rows.filter((row) => row.attempts === 1)).toHaveLength(3);
      expect(rows.find((row) => row.attempts === 1)?.last_error).toBe('D1 unavailable');

      // Re-dirtying a row in backoff keeps its backoff rather than hammering D1.
      const due = outbox.nextDueAt()!;
      outbox.markDirty('thread', 'a');
      expect(outbox.nextDueAt()).toBe(due);
    });
  });

  it('keeps a row that was re-dirtied while its drain was in flight', async () => {
    const { userId } = await createUser(testEnv, `${uid('mirror')}@example.com`, 'password123', 'Redirty');
    const stub = testEnv.USER.get(testEnv.USER.idFromName(userId));

    await runInDurableObject(stub, async (_instance, state) => {
      const outbox = new D1MirrorOutbox(state.storage);
      state.storage.sql.exec('DELETE FROM d1_mirror_outbox');
      outbox.markDirty('org', 'x');
      state.storage.sql.exec('UPDATE d1_mirror_outbox SET next_attempt_at = 0');

      const versions: Array<number | undefined> = [];
      const db = {
        applyAdminEvent: async (event: VersionedAdminEvent) => {
          versions.push(event.version);
          outbox.markDirty('org', 'x');
        },
      } as unknown as AppIndexDatabase;
      const snapshot = () => [orgUpsert('x', 'n')];
      await outbox.drain(db, snapshot);
      expect(outbox.pendingCount()).toBe(1);

      state.storage.sql.exec('UPDATE d1_mirror_outbox SET next_attempt_at = 0');
      await outbox.drain({ applyAdminEvent: async (e: VersionedAdminEvent) => void versions.push(e.version) } as unknown as AppIndexDatabase, snapshot);
      expect(outbox.pendingCount()).toBe(0);
      expect(versions[1]!).toBeGreaterThan(versions[0]!);
    });
  });

  it('caps retry delay growth', () => {
    expect(mirrorRetryDelayMs(1)).toBeLessThanOrEqual(6_000);
    expect(mirrorRetryDelayMs(50)).toBeLessThanOrEqual(60 * 60 * 1000 * 1.2);
  });
});

describe('D1 mirror outbox (OrgDO)', () => {
  async function setupOrg() {
    await appIndex();
    const { userId } = await createUser(testEnv, `${uid('owner')}@example.com`, 'password123', 'Owner');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Mirror Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    return { userId, org, defaultWorkspaceId, orgStub };
  }

  it('mirrors org, membership, workspace and thread state on the alarm', async () => {
    const { userId, org, defaultWorkspaceId, orgStub } = await setupOrg();
    const { userId: memberId } = await createUser(testEnv, `${uid('member')}@example.com`, 'password123', 'Member');
    await orgStub.addMember(memberId, 'member', userId);
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Mirrored thread', userId);
    await flushD1Mirror(orgStub);

    const db = testEnv.APP_DB!;
    expect(await db.prepare('SELECT name, member_count FROM orgs WHERE id = ?').bind(org.id).first())
      .toMatchObject({ name: 'Mirror Org', member_count: 2 });
    expect(await membershipExists(org.id, memberId)).toBe(true);
    expect(await db.prepare('SELECT org_id FROM workspaces WHERE id = ?').bind(defaultWorkspaceId).first())
      .toMatchObject({ org_id: org.id });
    expect(await db.prepare('SELECT title FROM threads WHERE id = ?').bind(thread.id).first())
      .toMatchObject({ title: 'Mirrored thread' });

    await orgStub.removeMember(memberId, userId);
    await orgStub.deleteThread(thread.id, userId);
    await flushD1Mirror(orgStub);
    expect(await membershipExists(org.id, memberId)).toBe(false);
    expect(await db.prepare('SELECT member_count FROM orgs WHERE id = ?').bind(org.id).first())
      .toMatchObject({ member_count: 1 });
    expect(await db.prepare('SELECT 1 FROM threads WHERE id = ?').bind(thread.id).first()).toBeNull();
    expect(
      await db
        .prepare("SELECT deleted FROM mirror_rows WHERE entity = 'thread' AND entity_key = ?")
        .bind(thread.id)
        .first(),
    ).toMatchObject({ deleted: 1 });
  });

  it('keeps the outbox alarm armed when token-refresh scheduling runs', async () => {
    const { orgStub } = await setupOrg();
    await runInDurableObject(orgStub, async (instance, state) => {
      state.storage.sql.exec('DELETE FROM d1_mirror_outbox');
      await state.storage.deleteAlarm();
      const internals = instance as unknown as {
        markMirrorDirty(kind: string, id: string): void;
        scheduleNextTokenRefresh(): Promise<void>;
      };
      internals.markMirrorDirty('org', '');
      // No integration has a token expiry, which used to delete the alarm outright.
      await internals.scheduleNextTokenRefresh();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it('re-mirrors everything an org owns on requestMirrorResync', async () => {
    const { org, defaultWorkspaceId, orgStub, userId } = await setupOrg();
    await orgStub.createThread(defaultWorkspaceId, 'Resync thread', userId);
    await flushD1Mirror(orgStub);
    await testEnv.APP_DB!.batch([
      testEnv.APP_DB!.prepare('DELETE FROM orgs WHERE id = ?').bind(org.id),
      testEnv.APP_DB!.prepare('DELETE FROM org_memberships WHERE org_id = ?').bind(org.id),
    ]);

    const { queued } = await orgStub.requestMirrorResync();
    expect(queued).toBeGreaterThanOrEqual(4); // org, owner, workspace, thread
    await flushD1Mirror(orgStub);
    expect(await orgName(org.id)).toBe('Mirror Org');
    expect(await membershipExists(org.id, userId)).toBe(true);
  });
});
