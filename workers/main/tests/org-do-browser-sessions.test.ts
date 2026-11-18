/**
 * Tests for the OrgDO per-workspace browser-session registry used to cap
 * concurrent Browser Rendering sessions per workspace (see app-browser-binding).
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { createUser, createOrg, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;
const testEmail = () => `br-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function freshOrg() {
  const { userId } = await createUser(testEnv, testEmail(), 'password', 'Browser User');
  const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Browser Org', userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  return { orgStub, workspaceId: defaultWorkspaceId as string };
}

describe('OrgDO browser-session registry', () => {
  it('counts only sessions recorded for the given workspace', async () => {
    const { orgStub, workspaceId } = await freshOrg();
    const otherWorkspace = `${workspaceId}-other`;

    await orgStub.recordBrowserSession(workspaceId, 's1');
    await orgStub.recordBrowserSession(workspaceId, 's2');
    await orgStub.recordBrowserSession(otherWorkspace, 's3');
    expect(await orgStub.hasBrowserSession(workspaceId, 's1')).toBe(true);
    expect(await orgStub.hasBrowserSession(workspaceId, 's3')).toBe(false);

    // All three are still live -> workspace sees only its own two.
    const count = await orgStub.reconcileBrowserSessions(workspaceId, ['s1', 's2', 's3']);
    expect(count).toBe(2);

    const otherCount = await orgStub.reconcileBrowserSessions(otherWorkspace, ['s1', 's2', 's3']);
    expect(otherCount).toBe(1);
  });

  it('is idempotent on session id', async () => {
    const { orgStub, workspaceId } = await freshOrg();
    await orgStub.recordBrowserSession(workspaceId, 'dup');
    await orgStub.recordBrowserSession(workspaceId, 'dup');
    expect(await orgStub.reconcileBrowserSessions(workspaceId, ['dup'])).toBe(1);
  });

  it('prunes sessions missing from the live list (self-heals leaks)', async () => {
    const { orgStub, workspaceId } = await freshOrg();
    await orgStub.recordBrowserSession(workspaceId, 'alive');
    await orgStub.recordBrowserSession(workspaceId, 'leaked');

    // 'leaked' is not in the live list -> pruned; only 'alive' remains.
    const count = await orgStub.reconcileBrowserSessions(workspaceId, ['alive']);
    expect(count).toBe(1);

    // A subsequent reconcile with 'leaked' back in the live list must NOT
    // resurrect it (it was deleted, not just uncounted).
    const after = await orgStub.reconcileBrowserSessions(workspaceId, ['alive', 'leaked']);
    expect(after).toBe(1);
  });

  it('empty live list clears the registry', async () => {
    const { orgStub, workspaceId } = await freshOrg();
    await orgStub.recordBrowserSession(workspaceId, 'a');
    await orgStub.recordBrowserSession(workspaceId, 'b');
    expect(await orgStub.reconcileBrowserSessions(workspaceId, [])).toBe(0);
    // And the rows are gone, not merely uncounted.
    expect(await orgStub.reconcileBrowserSessions(workspaceId, ['a', 'b'])).toBe(0);
  });

  it('removeBrowserSession drops a single session', async () => {
    const { orgStub, workspaceId } = await freshOrg();
    await orgStub.recordBrowserSession(workspaceId, 'keep');
    await orgStub.recordBrowserSession(workspaceId, 'drop');
    await orgStub.removeBrowserSession('drop');
    expect(await orgStub.hasBrowserSession(workspaceId, 'drop')).toBe(false);
    expect(await orgStub.reconcileBrowserSessions(workspaceId, ['keep', 'drop'])).toBe(1);
  });

  it('ignores empty ids', async () => {
    const { orgStub, workspaceId } = await freshOrg();
    await orgStub.recordBrowserSession(workspaceId, '');
    await orgStub.recordBrowserSession('', 'x');
    expect(await orgStub.reconcileBrowserSessions(workspaceId, ['', 'x'])).toBe(0);
  });
});
