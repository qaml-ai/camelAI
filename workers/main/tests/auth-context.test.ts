/**
 * Tests for auth context building with parallel DO calls.
 *
 * These tests verify that the auth-do.ts functions properly fetch
 * user, org, and workspace data - including the Promise.all parallelization
 * for fetching multiple orgs/workspaces.
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { createSignedSession, type SignedSessionData } from '../src/signed-session';
import { getAuthContext, requireOrgAdmin } from '../../../src/lib/auth.server';
import {
  createUser,
  createOrg,
  getUserOrgs,
  listUserWorkspaces,
  listUserWorkspacesAcrossOrgs,
  createWorkspace,
  archiveWorkspace,
  createInvitation,
  acceptInvitation,
  setWorkspaceAccess,
  listOrgWorkspaces,
  type TestEnv,
} from './test-helpers';
import {
  listOrgWorkspaces as prodListOrgWorkspaces,
  listUserWorkspacesAcrossOrgs as prodListUserWorkspacesAcrossOrgs,
} from '../../../src/lib/auth-do';

describe('Auth context building (parallel DO calls)', () => {
  const testEnv = env as unknown as TestEnv;
  const signingSecret = (env as any).TOKEN_SIGNING_SECRET as string;

  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  async function createTestSession(
    userId: string,
    orgId: string,
    userEmail?: string,
    createdAt = Date.now(),
  ) {
    const workspaces = await listOrgWorkspaces(testEnv, orgId);
    const workspaceId = workspaces[0]?.id ?? null;
    const sessionData: SignedSessionData = {
      user_id: userId,
      org_id: orgId,
      workspace_id: workspaceId,
      created_at: createdAt,
      user_email: userEmail ?? null,
    };
    const signedToken = await createSignedSession(signingSecret, sessionData);
    return { signedToken, sessionData: { ...sessionData, last_accessed: sessionData.created_at } };
  }

  describe('getUserOrgs with parallelization', () => {
    it('should fetch all user orgs with their info in parallel', async () => {
      // Create user and their first org
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Multi-Org User');
      const { org: org1 } = await createOrg(testEnv, 'First Org', userId);

      // Create additional orgs
      const { org: org2 } = await createOrg(testEnv, 'Second Org', userId);
      const { org: org3 } = await createOrg(testEnv, 'Third Org', userId);

      // Fetch all orgs - this uses Promise.all internally
      const allOrgs = await getUserOrgs(testEnv, userId);

      expect(allOrgs.length).toBe(3);
      expect(allOrgs.map(o => o.org_name)).toContain('First Org');
      expect(allOrgs.map(o => o.org_name)).toContain('Second Org');
      expect(allOrgs.map(o => o.org_name)).toContain('Third Org');
    });

    it('should handle user with single org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Single Org User');
      const { org } = await createOrg(testEnv, 'My Org', userId);

      const orgs = await getUserOrgs(testEnv, userId);

      expect(orgs.length).toBe(1);
      expect(orgs[0].role).toBe('owner');
      expect(orgs[0].org_name).toBe('My Org');
    });
  });

  describe('listUserWorkspaces', () => {
    it('should fetch workspaces for a specific org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Workspace User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', userId);

      // Default workspace is created with org
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);

      expect(workspaces.length).toBeGreaterThanOrEqual(1);
      expect(workspaces[0].id).toBe(defaultWorkspaceId);
      expect(workspaces[0].access_level).toBe('full');
    });

    it('should fetch multiple workspaces in an org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Multi WS User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      // Create additional workspaces (note: createWorkspace(env, orgId, name, createdBy))
      await createWorkspace(testEnv, org.id, 'Workspace 2', userId);
      await createWorkspace(testEnv, org.id, 'Workspace 3', userId);

      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);

      expect(workspaces.length).toBe(3);
      // All workspaces should have full access
      expect(workspaces.every(w => w.access_level === 'full')).toBe(true);
    });
  });

  describe('listUserWorkspacesAcrossOrgs', () => {
    it('should fetch workspaces across all orgs in parallel', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Cross Org User');

      // Create first org with workspace
      const { org: org1 } = await createOrg(testEnv, 'Org 1', userId);

      // Create second org with workspace
      const { org: org2 } = await createOrg(testEnv, 'Org 2', userId);

      // Create third org with workspace
      const { org: org3 } = await createOrg(testEnv, 'Org 3', userId);

      const orgs = await getUserOrgs(testEnv, userId);

      // Fetch all workspaces across all orgs - uses Promise.all internally
      const allWorkspaces = await listUserWorkspacesAcrossOrgs(testEnv, userId, orgs);

      expect(allWorkspaces.length).toBe(3); // One default workspace per org
      expect(allWorkspaces.map(w => w.org_id).sort()).toEqual(
        orgs.map(o => o.org_id).sort()
      );
    });

    it('should include workspaces from orgs where user is member (not owner)', async () => {
      // Create owner and their org
      const ownerEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { org: ownerOrg } = await createOrg(testEnv, 'Owner Org', ownerId);

      // Create member and their org
      const memberEmail = testEmail();
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org: memberOrg } = await createOrg(testEnv, 'Member Org', memberId);

      // Invite member to owner's org
      const invitation = await createInvitation(testEnv, ownerOrg.id, memberEmail, 'member', ownerId);
      expect(invitation).not.toBeNull();

      // Accept invitation
      const accepted = await acceptInvitation(testEnv, ownerOrg.id, invitation!.id, memberId);
      expect(accepted).toBe(true);

      // Get member's orgs and workspaces
      const memberOrgs = await getUserOrgs(testEnv, memberId);
      const memberOrgIds = memberOrgs.map(o => o.org_id);

      // Member should now have access to both their own org and owner's org
      expect(memberOrgIds).toContain(ownerOrg.id);
      expect(memberOrgIds).toContain(memberOrg.id);

      // Fetch all workspaces for member
      const allWorkspaces = await listUserWorkspacesAcrossOrgs(testEnv, memberId, memberOrgs);

      // Member should see workspaces from both orgs
      expect(allWorkspaces.length).toBe(2);
    });

    it('excludes an archived org even when it still has an un-archived workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Archived Org User');
      const { org: activeOrg } = await createOrg(testEnv, 'Active Org', userId);
      const { org: archivedOrg } = await createOrg(testEnv, 'Archived Org', userId);

      // Mark the org archived WITHOUT archiving its workspaces — the partial-archive
      // edge. (The lazy-orgs change no longer filters archived orgs out of the
      // membership list up front, so the workspace listing must drop them itself.)
      const archivedOrgStub = testEnv.ORG.get(testEnv.ORG.idFromName(archivedOrg.id));
      await (
        archivedOrgStub as unknown as { archiveOrg(actorId: string): Promise<void> }
      ).archiveOrg(userId);

      // Pass the full membership (including the archived org) — mimicking the
      // unfiltered list getAuthContext now builds.
      const memberships = [
        { org_id: activeOrg.id, org_name: 'Active Org', role: 'owner' as const, joined_at: Date.now(), last_workspace_id: null },
        { org_id: archivedOrg.id, org_name: '', role: 'owner' as const, joined_at: Date.now(), last_workspace_id: null },
      ];
      const allWorkspaces = await listUserWorkspacesAcrossOrgs(testEnv, userId, memberships);
      const orgIds = new Set(allWorkspaces.map((w) => w.org_id));

      expect(orgIds.has(activeOrg.id)).toBe(true);
      expect(orgIds.has(archivedOrg.id)).toBe(false);
    });

    it('uses preloaded workspace lists without re-reading that org', async () => {
      const preloadedWorkspace = {
        id: 'ws-preloaded',
        org_id: 'org-preloaded',
        name: 'Preloaded Workspace',
        description: null,
        created_by: 'user-1',
        created_at: 123,
        avatar: { color: '#4F46E5', content: 'PW' },
        archived: false,
        archived_at: null,
        archived_by: null,
        compute_tier: 'standard' as const,
        email_handle: null,
      };
      const env = {
        ORG: {
          idFromName: (id: string) => id,
          get: () => ({
            getWorkspaces: async () => {
              throw new Error('preloaded org should not be read');
            },
          }),
        },
        WORKSPACE: {
          idFromName: (id: string) => id,
          get: () => ({
            getInfo: async () => null,
          }),
        },
      };

      const workspaces = await prodListUserWorkspacesAcrossOrgs(
        env as any,
        'user-1',
        [
          {
            org_id: 'org-preloaded',
            org_name: 'Preloaded Org',
            role: 'member',
            joined_at: 1,
          },
        ],
        {
          preloadedWorkspacesByOrgId: new Map([
            ['org-preloaded', [preloadedWorkspace]],
          ]),
        },
      );

      expect(workspaces).toEqual([
        { ...preloadedWorkspace, access_level: 'full' },
      ]);
    });
  });

  describe('transient workspace RPC failures', () => {
    it('reads workspace info from the org workspace index', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const env = {
        ORG: {
          idFromName: (id: string) => id,
          get: () => ({
            getWorkspaceInfos: async () => [
              {
                id: 'ws-fallback',
                org_id: 'org-1',
                name: 'Fallback Workspace',
                description: null,
                created_by: 'user-1',
                created_at: 123,
                avatar: { color: '#4F46E5', content: 'FW' },
                archived: false,
                archived_at: null,
                archived_by: null,
                compute_tier: 'standard',
                email_handle: null,
              },
            ],
          }),
        },
      };

      const workspaces = await prodListOrgWorkspaces(env as any, 'org-1');

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatchObject({
        id: 'ws-fallback',
        org_id: 'org-1',
        name: 'Fallback Workspace',
        created_at: 123,
        archived: false,
        compute_tier: 'standard',
        email_handle: null,
      });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('skips one failing org workspace list without failing the full switcher list', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const workspace = {
        id: 'ws-ok',
        org_id: 'org-ok',
        name: 'OK Workspace',
        description: null,
        created_by: 'user-1',
        created_at: 456,
        avatar: { color: '#4F46E5', content: 'OK' },
        archived: false,
        archived_at: null,
        archived_by: null,
        compute_tier: 'standard',
        email_handle: null,
      };
      const env = {
        ORG: {
          idFromName: (id: string) => id,
          get: (id: string) => ({
            listUserWorkspaces: async () => {
              if (id === 'org-failing') {
                throw new Error('Durable Object storage operation exceeded timeout');
              }
              return [{ ...workspace, access_level: 'full' }];
            },
          }),
        },
      };

      const workspaces = await prodListUserWorkspacesAcrossOrgs(
        env as any,
        'user-1',
        [
          { org_id: 'org-failing', org_name: 'Failing Org', role: 'member', joined_at: 1 },
          { org_id: 'org-ok', org_name: 'OK Org', role: 'member', joined_at: 2 },
        ],
      );

      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]).toMatchObject({
        id: 'ws-ok',
        org_id: 'org-ok',
        access_level: 'full',
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[auth] failed to load org workspaces, skipping org in workspace switcher',
        expect.objectContaining({ userId: 'user-1', orgId: 'org-failing' }),
      );

      warnSpy.mockRestore();
    });
  });

  describe('Session and auth context integration', () => {
    it('should create session with correct org and workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Session User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Test Org', userId);

      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspaceId = workspaces[0].id;

      const { sessionData } = await createTestSession(userId, org.id);

      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);
      expect(sessionData.workspace_id).toBe(workspaceId);
    });

    it('should handle user switching between orgs', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Org Switcher');

      // Create two orgs
      const { org: org1, defaultWorkspaceId: ws1Id } = await createOrg(testEnv, 'First Org', userId);
      const { org: org2, defaultWorkspaceId: ws2Id } = await createOrg(testEnv, 'Second Org', userId);

      const orgs = await getUserOrgs(testEnv, userId);
      expect(orgs.length).toBe(2);

      // Get workspaces for each org
      const ws1 = await listUserWorkspaces(testEnv, userId, org1.id);
      const ws2 = await listUserWorkspaces(testEnv, userId, org2.id);

      expect(ws1.length).toBeGreaterThanOrEqual(1);
      expect(ws2.length).toBeGreaterThanOrEqual(1);
      // Workspaces from different orgs have different IDs
      expect(ws1[0].id).toBe(ws1Id);
      expect(ws2[0].id).toBe(ws2Id);
      expect(ws1[0].id).not.toBe(ws2[0].id);
    });

    it('loads current org auth bootstrap in one OrgDO RPC', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Bootstrap User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Bootstrap Org', userId);

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const bootstrap = await orgStub.getAuthContextBootstrap(userId);

      expect(bootstrap.info?.id).toBe(org.id);
      expect(bootstrap.member).toMatchObject({
        user_id: userId,
        role: 'owner',
      });
      expect(bootstrap.workspaces.map((workspace) => workspace.id)).toContain(
        defaultWorkspaceId,
      );
      expect(bootstrap.llmProviderConfig).toBeNull();
    });

    it('loads workspace summary counts from OrgDO without route-level workspace fanout', async () => {
      const ownerEmail = testEmail();
      const memberEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Summary Count Org', ownerId);
      const secondWorkspace = await createWorkspace(testEnv, org.id, 'Second Workspace', ownerId);

      const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
      await acceptInvitation(testEnv, org.id, invitation.id, memberId);
      await setWorkspaceAccess(testEnv, secondWorkspace.id, memberId, 'none', ownerId);

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await orgStub.registerWorkerScript('default-app', defaultWorkspaceId, ownerId);
      await orgStub.registerWorkerScript('second-app-a', secondWorkspace.id, ownerId);
      await orgStub.registerWorkerScript('second-app-b', secondWorkspace.id, memberId);

      const counts = await orgStub.getWorkspaceSummaryCounts([
        defaultWorkspaceId,
        secondWorkspace.id,
      ]);
      const countMap = new Map(counts.map((entry) => [entry.workspaceId, entry]));

      expect(countMap.get(defaultWorkspaceId)).toMatchObject({
        memberCount: 2,
        publishedApps: 1,
      });
      expect(countMap.get(secondWorkspace.id)).toMatchObject({
        memberCount: 1,
        publishedApps: 2,
      });
    });

    it('records deploy versions with artifact metadata', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Deploy User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Deploy History Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      await orgStub.registerWorkerScript(
        'demo-app',
        defaultWorkspaceId,
        userId,
        'wrangler.jsonc',
        'project-1',
        'sha-1',
        'deploy-artifacts/key-1.json',
      );
      await orgStub.registerWorkerScript(
        'demo-app',
        defaultWorkspaceId,
        userId,
        'wrangler.jsonc',
        'project-1',
        'sha-2',
        'deploy-artifacts/key-2.json',
      );

      const versions = await orgStub.listWorkerScriptDeployVersions('demo-app', defaultWorkspaceId);
      expect(versions).toHaveLength(2);
      expect(versions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          script_name: 'demo-app',
          workspace_id: defaultWorkspaceId,
          created_by: userId,
          config_path: 'wrangler.jsonc',
          project_id: 'project-1',
          commit_sha: 'sha-1',
          artifact_cache_key: 'deploy-artifacts/key-1.json',
        }),
        expect.objectContaining({
          commit_sha: 'sha-2',
          artifact_cache_key: 'deploy-artifacts/key-2.json',
        }),
      ]));
    });

    it('keeps the dispatcher visibility index in sync with app visibility', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Visibility User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Visibility Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      await orgStub.registerWorkerScript('visibility-app', defaultWorkspaceId, userId);
      await orgStub.setWorkerScriptPublic('visibility-app', false, userId);

      const orgInfo = await orgStub.getInfo();
      const indexKey = `script:visibility-app--${orgInfo?.slug}`;
      await expect(testEnv.APP_KV.get(indexKey, 'json')).resolves.toEqual({
        org_id: org.id,
        org_slug: orgInfo?.slug,
        is_public: false,
      });

      await orgStub.setWorkerScriptPublic('visibility-app', true, userId);
      await expect(testEnv.APP_KV.get(indexKey, 'json')).resolves.toEqual({
        org_id: org.id,
        org_slug: orgInfo?.slug,
        is_public: true,
      });
    });

    it('hydrates legacy WorkspaceDO restrictions when workspace access has not been migrated', async () => {
      const ownerEmail = testEmail();
      const memberEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org } = await createOrg(testEnv, 'Legacy Summary Count Org', ownerId);
      const workspace = await createWorkspace(testEnv, org.id, 'Legacy Restricted Workspace', ownerId);

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await orgStub.addMember(memberId, 'member', ownerId);

      const workspaceStub = testEnv.WORKSPACE.get(
        testEnv.WORKSPACE.idFromName(workspace.id),
      ) as DurableObjectStub<{
        setMemberAccess(
          userId: string,
          accessLevel: 'none',
          actorId: string,
        ): Promise<void>;
      }>;
      await workspaceStub.setMemberAccess(memberId, 'none', ownerId);
      await orgStub.clearWorkspaceTenantMigrationMarkersForTest(workspace.id);

      const counts = await orgStub.getWorkspaceSummaryCounts([workspace.id]);

      expect(counts).toEqual([
        expect.objectContaining({
          workspaceId: workspace.id,
          memberCount: 1,
        }),
      ]);
    });

    it('does not lower workspace summary member counts from stale WorkspaceDO restrictions after migration', async () => {
      const ownerEmail = testEmail();
      const memberEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org } = await createOrg(testEnv, 'Stale Summary Count Org', ownerId);
      const workspace = await createWorkspace(testEnv, org.id, 'Migrated Workspace', ownerId);

      const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
      await acceptInvitation(testEnv, org.id, invitation.id, memberId);

      const workspaceStub = testEnv.WORKSPACE.get(
        testEnv.WORKSPACE.idFromName(workspace.id),
      ) as DurableObjectStub<{
        setMemberAccess(
          userId: string,
          accessLevel: 'none',
          actorId: string,
        ): Promise<void>;
      }>;
      await workspaceStub.setMemberAccess(memberId, 'none', ownerId);

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const counts = await orgStub.getWorkspaceSummaryCounts([workspace.id]);
      const memberWorkspaces = await listUserWorkspaces(testEnv, memberId, org.id);

      expect(counts).toEqual([
        expect.objectContaining({
          workspaceId: workspace.id,
          memberCount: 2,
        }),
      ]);
      expect(memberWorkspaces.some((entry) => entry.id === workspace.id)).toBe(true);
    });

    it('filters archived workspaces after hydrating stale auth bootstrap rows', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Bootstrap Archived User');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Bootstrap Archived Org', userId);
      const activeWorkspace = await createWorkspace(testEnv, org.id, 'Active Workspace', userId);

      await archiveWorkspace(testEnv, defaultWorkspaceId, userId);

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const archivedWorkspaceInfo = await orgStub.getWorkspaceRecord(defaultWorkspaceId);
      expect(archivedWorkspaceInfo?.archived).toBe(true);

      await orgStub.upsertWorkspaceInfo({
        ...archivedWorkspaceInfo!,
        archived: false,
        archived_at: null,
        archived_by: null,
        email_handle: null,
      });

      const bootstrap = await orgStub.getAuthContextBootstrap(userId);
      expect(bootstrap.workspaces.map((workspace) => workspace.id)).toContain(
        activeWorkspace.id,
      );
      expect(bootstrap.workspaces.map((workspace) => workspace.id)).not.toContain(
        defaultWorkspaceId,
      );
    });

    it('does not re-add a denied session workspace during auth fallback', async () => {
      const ownerEmail = testEmail();
      const memberEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Denied Session Workspace Org', ownerId);
      const deniedWorkspace = await createWorkspace(testEnv, org.id, 'Denied Workspace', ownerId);

      const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
      await acceptInvitation(testEnv, org.id, invitation.id, memberId);
      await setWorkspaceAccess(testEnv, deniedWorkspace.id, memberId, 'none', ownerId);

      const signedToken = await createSignedSession(signingSecret, {
        user_id: memberId,
        org_id: org.id,
        workspace_id: deniedWorkspace.id,
        created_at: Date.now(),
        user_email: memberEmail,
      });
      const request = new Request('https://camelai.dev/', {
        headers: {
          host: 'camelai.dev',
          'X-Chiridion-Session-Id': signedToken,
        },
      });
      const context = { cloudflare: { env: testEnv } } as any;

      const authContext = await getAuthContext(request, context);
      expect(authContext).not.toBeNull();
      expect(authContext?.allWorkspaces.map((workspace) => workspace.id)).toContain(defaultWorkspaceId);
      expect(authContext?.allWorkspaces.map((workspace) => workspace.id)).not.toContain(deniedWorkspace.id);
      expect(authContext?.currentWorkspace?.id).toBe(defaultWorkspaceId);
    });

    it('builds the org list from membership, resolving only the current org name (lazy switcher)', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Lazy Orgs User');
      const { org: currentOrg } = await createOrg(testEnv, 'Current Org', userId);
      const { org: otherOrg } = await createOrg(testEnv, 'Other Org', userId);

      const { signedToken } = await createTestSession(userId, currentOrg.id, email);
      const request = new Request('https://camelai.dev/', {
        headers: {
          host: 'camelai.dev',
          'X-Chiridion-Session-Id': signedToken,
        },
      });
      const context = { cloudflare: { env: testEnv } } as any;

      const authContext = await getAuthContext(request, context);
      expect(authContext).not.toBeNull();
      // Every membership is present by id (built from the preloaded bootstrap).
      expect(authContext!.orgs.map((o) => o.org_id).sort()).toEqual(
        [currentOrg.id, otherOrg.id].sort(),
      );
      // The current org carries its name (the critical path needs it)...
      expect(
        authContext!.orgs.find((o) => o.org_id === currentOrg.id)?.org_name,
      ).toBe('Current Org');
      // ...but other orgs' names are deferred (no per-org ORG.getInfo() in the
      // critical path) — the workspace switcher fetches them via /api/orgs.
      expect(
        authContext!.orgs.find((o) => o.org_id === otherOrg.id)?.org_name,
      ).toBe('');
    });

    it('rejects sessions invalidated before full auth context loads', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password', 'Invalidated User');
      const { org } = await createOrg(testEnv, 'Invalidated Org', userId);
      const createdAt = Date.now() - 10_000;
      const { signedToken } = await createTestSession(userId, org.id, email, createdAt);

      const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));
      await userStub.invalidateSessions();

      const request = new Request('https://camelai.dev/', {
        headers: {
          host: 'camelai.dev',
          'X-Chiridion-Session-Id': signedToken,
        },
      });
      const context = { cloudflare: { env: testEnv } } as any;

      await expect(getAuthContext(request, context)).resolves.toBeNull();
    });
  });

  describe('stale org role mismatch regression', () => {
    it('allows admin-gated access when OrgDO role is admin but UserDO role is stale member', async () => {
      const ownerEmail = testEmail();
      const memberEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password', 'Owner');
      const { userId: memberId } = await createUser(testEnv, memberEmail, 'password', 'Member');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Mismatch Org', ownerId);

      // Start as normal member in both OrgDO + UserDO.
      const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
      const accepted = await acceptInvitation(testEnv, org.id, invitation.id, memberId);
      expect(accepted).toBe(true);

      // Introduce drift: promote role in OrgDO only (skip UserDO update on purpose).
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await orgStub.updateMemberRole(memberId, 'admin', ownerId);

      // Verify mismatch exists.
      const userStub = testEnv.USER.get(testEnv.USER.idFromName(memberId));
      expect(await userStub.getOrgRole(org.id)).toBe('member');
      expect((await orgStub.getMember(memberId))?.role).toBe('admin');

      const { signedToken } = await createTestSession(memberId, org.id, memberEmail);

      const request = new Request('https://camelai.dev/settings/organization/workspaces', {
        headers: {
          host: 'camelai.dev',
          'X-Chiridion-Session-Id': signedToken,
        },
      });
      const context = { cloudflare: { env: testEnv } } as any;

      // Regression assertion: admin gate should trust OrgDO authority and allow access.
      await expect(requireOrgAdmin(request, context, org.id)).resolves.toBeDefined();

      // Auth context should reconcile the active org role to match OrgDO.
      const authContext = await getAuthContext(request, context);
      expect(authContext).not.toBeNull();
      const currentOrgMembership = authContext?.orgs.find((entry) => entry.org_id === org.id);
      expect(currentOrgMembership?.role).toBe('admin');
    });
  });
});
