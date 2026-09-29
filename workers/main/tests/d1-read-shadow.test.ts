import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppIndexDatabase } from '../src/app-index-db';
import { getOrgMembers, getUserOrgs } from '../../../src/lib/auth-do';
import { getThreadsByIds, getThreadsPaginated } from '../../../src/lib/chat-do.server';
import { d1ReadMode } from '../../../src/lib/d1-read-shadow.server';
import { createOrg, createUser, flushD1Mirror, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function recordingDataset() {
  const points: Array<{ blobs?: unknown[] }> = [];
  return {
    points,
    dataset: { writeDataPoint: (point: { blobs?: unknown[] }) => points.push(point) } as unknown as AnalyticsEngineDataset,
    events: () => points.map((point) => ({ event: point.blobs?.[0], operation: point.blobs?.[3], status: point.blobs?.[4] })),
  };
}

function withFlags(flags: Record<string, string>, dataset?: AnalyticsEngineDataset) {
  return { ...testEnv, ...flags, ...(dataset ? { OBSERVABILITY_EVENTS: dataset } : {}) } as never;
}

async function mirroredFixture() {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
  const { userId } = await createUser(testEnv, `shadow-${crypto.randomUUID()}@example.com`, 'password123', 'Shadow Owner');
  const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Shadow Org', userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const thread = await orgStub.createThread(defaultWorkspaceId, 'Shadow thread', userId);
  await flushD1Mirror(orgStub);
  await flushD1Mirror(testEnv.USER.get(testEnv.USER.idFromName(userId)));
  return { userId, org, defaultWorkspaceId, thread };
}

describe('D1 read flags', () => {
  it('are off unless set, per call site, and serve wins over shadow', () => {
    expect(d1ReadMode(testEnv, 'getOrgMembers')).toBe('do');
    expect(d1ReadMode(withFlags({ D1_READ_SHADOW: 'getUserOrgs' }), 'getOrgMembers')).toBe('do');
    expect(d1ReadMode(withFlags({ D1_READ_SHADOW: 'getUserOrgs, getOrgMembers' }), 'getOrgMembers')).toBe('shadow');
    expect(d1ReadMode(withFlags({ D1_READ_SHADOW: 'all', D1_READ_SERVE: 'threadLists' }), 'threadLists')).toBe('d1');
    expect(d1ReadMode(withFlags({ D1_READ_SHADOW: 'all', D1_READ_SHADOW_SAMPLE_RATE: '0' }), 'threadLists')).toBe('do');
  });
});

describe('getOrgMembers from the D1 mirror', () => {
  it('shadow serves the DO and records field mismatches', async () => {
    const { org, userId } = await mirroredFixture();
    await testEnv.APP_DB!.prepare('UPDATE users SET name = ? WHERE id = ?').bind('Mirror Name', userId).run();
    const recorder = recordingDataset();
    const members = await getOrgMembers(withFlags({ D1_READ_SHADOW: 'getOrgMembers' }, recorder.dataset), org.id);
    expect(members.map((member) => member.user.name)).toEqual(['Shadow Owner']);
    expect(recorder.events()).toContainEqual({ event: 'd1_shadow_mismatch', operation: 'getOrgMembers', status: 'name' });
  });

  it('shadow records a match when D1 agrees', async () => {
    const { org } = await mirroredFixture();
    const recorder = recordingDataset();
    await getOrgMembers(withFlags({ D1_READ_SHADOW: 'getOrgMembers' }, recorder.dataset), org.id);
    expect(recorder.events()).toEqual([
      expect.objectContaining({ event: 'd1_shadow_match', operation: 'getOrgMembers' }),
    ]);
  });

  it('serve reads profiles from D1', async () => {
    const { org, userId } = await mirroredFixture();
    await testEnv.APP_DB!.prepare('UPDATE users SET name = ? WHERE id = ?').bind('Mirror Name', userId).run();
    const members = await getOrgMembers(withFlags({ D1_READ_SERVE: 'getOrgMembers' }), org.id);
    expect(members.map((member) => member.user.name)).toEqual(['Mirror Name']);
  });
});

describe('getUserOrgs from the D1 mirror', () => {
  it('serves org names from D1 only for opted-in callers', async () => {
    const { org, userId } = await mirroredFixture();
    await testEnv.APP_DB!.prepare('UPDATE orgs SET name = ? WHERE id = ?').bind('Mirror Org Name', org.id).run();
    const flagged = withFlags({ D1_READ_SERVE: 'getUserOrgs' });
    expect((await getUserOrgs(flagged, userId)).map((m) => m.org_name)).toEqual(['Shadow Org']);
    expect((await getUserOrgs(flagged, userId, { d1Read: true })).map((m) => m.org_name)).toEqual(['Mirror Org Name']);
  });
});

describe('thread lists from the D1 mirror', () => {
  const context = (flags: Record<string, string>, dataset?: AnalyticsEngineDataset) =>
    ({ cloudflare: { env: withFlags(flags, dataset) } }) as never;

  it('shadow compares pages; serve reads D1; searches stay on the DO', async () => {
    const { org, defaultWorkspaceId, thread } = await mirroredFixture();
    const recorder = recordingDataset();
    const clean = await getThreadsPaginated(context({ D1_READ_SHADOW: 'threadLists' }, recorder.dataset), defaultWorkspaceId, {}, { orgId: org.id });
    expect(clean.items.map((item) => item.id)).toEqual([thread.id]);
    expect(recorder.events()).toEqual([expect.objectContaining({ event: 'd1_shadow_match', operation: 'threadLists' })]);

    await testEnv.APP_DB!.prepare('UPDATE threads SET title = ? WHERE id = ?').bind('Mirror title', thread.id).run();
    const shadowed = recordingDataset();
    const page = await getThreadsPaginated(context({ D1_READ_SHADOW: 'threadLists' }, shadowed.dataset), defaultWorkspaceId, {}, { orgId: org.id });
    expect(page.items[0]!.title).toBe('Shadow thread');
    expect(shadowed.events()).toContainEqual({ event: 'd1_shadow_mismatch', operation: 'threadLists', status: 'title' });

    const served = await getThreadsPaginated(context({ D1_READ_SERVE: 'threadLists' }), defaultWorkspaceId, {}, { orgId: org.id });
    expect(served).toMatchObject({ total: 1, items: [expect.objectContaining({ id: thread.id, title: 'Mirror title' })] });

    const searched = await getThreadsPaginated(
      context({ D1_READ_SERVE: 'threadLists' }),
      defaultWorkspaceId,
      { searchQuery: 'Shadow' },
      { orgId: org.id },
    );
    expect(searched.items.map((item) => item.title)).toEqual(['Shadow thread']);

    const byIds = await getThreadsByIds(context({ D1_READ_SERVE: 'threadLists' }), defaultWorkspaceId, [thread.id, 'missing']);
    expect(byIds.map((item) => item.title)).toEqual(['Mirror title']);
  });
});
