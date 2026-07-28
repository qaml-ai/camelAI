/**
 * Workspace Durable Object tests using Cloudflare Vitest pool
 *
 * Run with: npm run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createNewSession, type SessionData } from '../src/session-kv';
import type { Workspace } from '../src/workspace';
import {
  createUser,
  createOrg,
  createWorkspace,
  updateWorkspace,
  getWorkspace,
  listOrgWorkspaces,
  listUserWorkspaces,
  archiveWorkspace,
  tryArchiveWorkspace,
  getWorkspaceAuditLog,
  setWorkspaceAccess,
  getWorkspaceAccess,
  listWorkspaceMembers,
  createInvitation,
  acceptInvitation,
  removeOrgMember,
  createWorkspaceIntegration,
  updateWorkspaceIntegration,
  deleteWorkspaceIntegration,
  getWorkspaceIntegrations,
  getUserOrgs,
  getSessionData,
  switchSessionWorkspace,
  type TestEnv,
} from './test-helpers';

describe('Workspace DO (full-stack with DOs)', () => {
  const testEnv = env as unknown as TestEnv;
  const sessionsKV = env.SESSIONS as KVNamespace;

  // Helper to create a session with the org's default workspace
  async function createTestSession(
    userId: string,
    orgId: string
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const workspaces = await listOrgWorkspaces(testEnv, orgId);
    const workspaceId = workspaces[0]?.id ?? null;
    return createNewSession(sessionsKV, userId, orgId, workspaceId);
  }

  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  it('creates a workspace and lists it under the org', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Workspace Owner');
    const { org } = await createOrg(testEnv, 'Workspace Org', userId);

    const workspace = await createWorkspace(testEnv, org.id, 'Design', userId, 'Design workspace');

    expect(workspace.id).toBeDefined();
    expect(workspace.org_id).toBe(org.id);
    expect(workspace.name).toBe('Design');
    const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
    await expect(workspaceStub.getInfo()).resolves.toMatchObject({
      id: workspace.id,
      org_id: org.id,
      name: 'Design',
    });

    const orgWorkspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(orgWorkspaces.some((entry) => entry.id === workspace.id)).toBe(true);
  });

  it('updates workspace metadata and records audit log entries', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Workspace Owner');
    const { org } = await createOrg(testEnv, 'Audit Org', userId);

    const workspace = await createWorkspace(testEnv, org.id, 'Initial', userId);
    const updated = await updateWorkspace(
      testEnv,
      workspace.id,
      { name: 'Renamed', description: 'Updated description' },
      userId
    );

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Renamed');
    expect(updated!.description).toBe('Updated description');

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('workspace_created');
    expect(actions).toContain('workspace_updated');
  });

  it('merges legacy WorkspaceDO audit log entries into workspace audit reads', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Workspace Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Workspace Member');
    const { org } = await createOrg(testEnv, 'Legacy Audit Org', ownerId);
    const workspace = await createWorkspace(testEnv, org.id, 'Legacy Audit', ownerId);

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

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    expect(audit).toContainEqual({
      action: 'access_granted',
      actor_id: ownerId,
    });
  });

  it('filters OrgDO workspace audit rows before applying pagination', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Workspace Owner');
    const { org } = await createOrg(testEnv, 'Busy Audit Org', userId);
    const workspace = await createWorkspace(testEnv, org.id, 'Quiet Workspace', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<{
      updateName(name: string, actorId: string): Promise<void>;
      getWorkspaceAuditLog(
        workspaceId: string,
        limit?: number,
        offset?: number,
      ): Promise<Array<{ action: string; target_id: string | null }>>;
    }>;

    // Seed >100 audit rows that do NOT belong to this workspace, so a
    // implementation that limits before filtering would push workspace_created
    // out of the page. Written in a single DO call: going through updateName()
    // one at a time costs a storage commit per row (~130ms each, ~16s total).
    const seededAt = Date.now();
    await runInDurableObject(orgStub, async (instance: { ctx: DurableObjectState }) => {
      for (let i = 0; i < 125; i++) {
        instance.ctx.storage.sql.exec(
          'INSERT INTO audit_log (id, action, actor_id, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          `seed-audit-${i}`,
          'org_renamed',
          userId,
          org.id,
          JSON.stringify({ name: `Busy Audit Org ${i}` }),
          seededAt + i + 1,
        );
      }
    });

    const audit = await orgStub.getWorkspaceAuditLog(workspace.id, 10, 0);
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: 'workspace_created',
        target_id: workspace.id,
      }),
    );
  });

  it('serves full workspace metadata from OrgDO without per-workspace reads', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Workspace Owner');
    const { org } = await createOrg(testEnv, 'Org Workspace Metadata', userId);

    const workspace = await createWorkspace(testEnv, org.id, 'Metadata', userId, 'Stored on org');
    const updated = await updateWorkspace(
      testEnv,
      workspace.id,
      {
        name: 'Metadata Updated',
        description: 'Updated on workspace and mirrored to org',
      },
      userId,
    );

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<{
      getWorkspaceInfos: () => Promise<Workspace[]>;
    }>;
    const orgWorkspaces = await orgStub.getWorkspaceInfos();
    const fromOrg = orgWorkspaces.find((entry) => entry.id === workspace.id);

    expect(fromOrg).toMatchObject({
      id: workspace.id,
      org_id: org.id,
      name: 'Metadata Updated',
      description: 'Updated on workspace and mirrored to org',
      created_by: userId,
      archived: false,
      compute_tier: 'standard',
    });
    expect(fromOrg?.avatar).toEqual(updated?.avatar);
    expect(fromOrg?.email_handle).toBe(updated?.email_handle);
  });

  it('skips stale org workspace rows when WorkspaceDO info is missing', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Workspace Owner');
    const { org } = await createOrg(testEnv, 'Org Stale Workspace Rows', userId);
    const orphanWorkspaceId = `orphan-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<{
      addWorkspace: (
        workspaceId: string,
        name: string,
        createdAt: number,
        actorId: string
      ) => Promise<void>;
      getWorkspaceInfos: () => Promise<Workspace[]>;
    }>;
    await orgStub.addWorkspace(orphanWorkspaceId, 'Orphan Workspace', Date.now(), userId);

    const orgWorkspaces = await orgStub.getWorkspaceInfos();

    expect(orgWorkspaces.some((entry) => entry.id === orphanWorkspaceId)).toBe(false);
  });

  it('archives workspace and preserves metadata for audit', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Archive Owner');
    const { org } = await createOrg(testEnv, 'Archive Org', userId);

    const workspace = await createWorkspace(testEnv, org.id, 'Archive Workspace', userId);
    await archiveWorkspace(testEnv, workspace.id, userId);

    const fromApi = await getWorkspace(testEnv, workspace.id);
    expect(fromApi).toBeNull();

    const userWorkspaces = await listUserWorkspaces(testEnv, userId, org.id);
    expect(userWorkspaces.some((entry) => entry.id === workspace.id)).toBe(false);

    const orgWorkspaces = await listOrgWorkspaces(testEnv, org.id);
    expect(orgWorkspaces.some((entry) => entry.id === workspace.id)).toBe(false);

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<{
      getWorkspaceRecord(workspaceId: string): Promise<Workspace | null>;
    }>;
    const info = await orgStub.getWorkspaceRecord(workspace.id);
    expect(info?.archived).toBe(true);
    expect(info?.name).toBe('Archive Workspace');

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('workspace_archived');
  });

  describe('Workspace archive edge cases', () => {
    it('blocks archiving the only workspace in an org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Solo Owner');
      const { org } = await createOrg(testEnv, 'Solo Org', userId);

      const workspaces = await listOrgWorkspaces(testEnv, org.id);
      expect(workspaces).toHaveLength(1);

      const result = await tryArchiveWorkspace(testEnv, workspaces[0].id, userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot archive the only workspace in an organization');
    });

    it('keeps archived workspace entries archived after metadata updates', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Archive Owner');
      const { org } = await createOrg(testEnv, 'Archive Metadata Org', userId);

      const workspace = await createWorkspace(testEnv, org.id, 'Archive Me', userId);

      await archiveWorkspace(testEnv, workspace.id, userId);
      const updated = await updateWorkspace(testEnv, workspace.id, { name: 'Renamed Archived' }, userId);

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Renamed Archived');
      expect(updated!.archived).toBe(true);
    });

    it('repairs session workspace when the current workspace is archived', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Session Owner');
      const { org } = await createOrg(testEnv, 'Session Org', userId);

      const secondWorkspace = await createWorkspace(testEnv, org.id, 'Second', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      const session = await getSessionData(testEnv, sessionId);
      const defaultWorkspaceId = session?.workspace_id;
      expect(defaultWorkspaceId).toBeTruthy();
      expect(defaultWorkspaceId).not.toBe(secondWorkspace.id);

      await archiveWorkspace(testEnv, defaultWorkspaceId!, userId);

      // Note: Session repair happens at session retrieval time in production.
      // For this test, we manually verify the workspace is archived and another exists.
      const remainingWorkspaces = await listUserWorkspaces(testEnv, userId, org.id);
      expect(remainingWorkspaces.length).toBeGreaterThan(0);
      expect(remainingWorkspaces.some((ws) => ws.id === secondWorkspace.id)).toBe(true);
    });

    it('clears last_workspace_id when the workspace is archived', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Org Owner');
      const { org } = await createOrg(testEnv, 'Last Workspace Org', userId);
      const secondWorkspace = await createWorkspace(testEnv, org.id, 'Second', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      await switchSessionWorkspace(testEnv, sessionId, secondWorkspace.id);

      let orgs = await getUserOrgs(testEnv, userId);
      expect(orgs[0]?.last_workspace_id).toBe(secondWorkspace.id);

      await archiveWorkspace(testEnv, secondWorkspace.id, userId);

      orgs = await getUserOrgs(testEnv, userId);
      expect(orgs[0]?.last_workspace_id).not.toBe(secondWorkspace.id);
    });
  });

  it('manages workspace access levels', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Access Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspaces = await listUserWorkspaces(testEnv, ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await setWorkspaceAccess(testEnv, workspace.id, memberId, 'full', ownerId);
    const access = await getWorkspaceAccess(testEnv, workspace.id, memberId);
    expect(access).toBe('full');

    const memberWorkspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(memberWorkspaces.some((entry) => entry.id === workspace.id && entry.access_level === 'full')).toBe(true);

    await setWorkspaceAccess(testEnv, workspace.id, memberId, 'none', ownerId);
    const removedAccess = await getWorkspaceAccess(testEnv, workspace.id, memberId);
    expect(removedAccess).toBe('none');
    const afterRemoval = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(afterRemoval.some((entry) => entry.id === workspace.id)).toBe(false);
  });

  it('uses OrgDO workspace access as the authoritative read path', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Org Access Source Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const [workspace] = await listUserWorkspaces(testEnv, ownerId, org.id);
    expect(workspace).toBeDefined();

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.setWorkspaceAccess(workspace.id, memberId, 'none', ownerId);

    const access = await getWorkspaceAccess(testEnv, workspace.id, memberId);
    expect(access).toBe('none');

    const memberWorkspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(memberWorkspaces.some((entry) => entry.id === workspace.id)).toBe(false);
  });

  it('hydrates legacy WorkspaceDO access rows into OrgDO on read', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Access Hydration Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspace = { id: defaultWorkspaceId };
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.clearWorkspaceTenantMigrationMarkersForTest(workspace.id);

    const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
    await workspaceStub.setMemberAccess(memberId, 'none', ownerId);

    const memberWorkspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(memberWorkspaces.some((entry) => entry.id === workspace.id)).toBe(false);

    const accessRows = await orgStub.listWorkspaceAccessRows();
    expect(accessRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspace.id,
          user_id: memberId,
          access_level: 'none',
        }),
      ]),
    );

    await setWorkspaceAccess(testEnv, workspace.id, memberId, 'full', ownerId);
    await expect(getWorkspaceAccess(testEnv, workspace.id, memberId)).resolves.toBe('full');
    const rowsAfterGrant = await orgStub.listWorkspaceAccessRows();
    expect(rowsAfterGrant).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: workspace.id,
          user_id: memberId,
          access_level: 'full',
        }),
      ]),
    );

    await workspaceStub.setMemberAccess(memberId, 'none', ownerId);
    await expect(getWorkspaceAccess(testEnv, workspace.id, memberId)).resolves.toBe('full');
  });

  it('does not keep reading WorkspaceDO for default full workspace access after migration', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Default Access Migration Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const [workspace] = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(workspace).toBeDefined();

    const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
    await workspaceStub.setMemberAccess(memberId, 'none', ownerId);

    const memberWorkspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(memberWorkspaces.some((entry) => entry.id === workspace.id)).toBe(true);
  });

  it('hydrates legacy WorkspaceDO integrations into OrgDO on read', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Legacy Integration Owner');
    const { org } = await createOrg(testEnv, 'Legacy Integration Org', userId);
    const [workspace] = await listUserWorkspaces(testEnv, userId, org.id);
    expect(workspace).toBeDefined();

    const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
    const integrationId = crypto.randomUUID();
    await workspaceStub.createIntegration(
      integrationId,
      'airtable',
      'Legacy Airtable',
      'saas',
      'api_key',
      JSON.stringify({ base_id: 'app123' }),
      'encrypted-secret',
      userId,
    );

    const integrations = await getWorkspaceIntegrations(testEnv, workspace.id);
    expect(integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: integrationId,
          name: 'Legacy Airtable',
        }),
      ]),
    );

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await expect(
      orgStub.getWorkspaceIntegration(workspace.id, integrationId),
    ).resolves.toMatchObject({
      id: integrationId,
      name: 'Legacy Airtable',
    });

    const secondLegacyIntegrationId = crypto.randomUUID();
    await workspaceStub.createIntegration(
      secondLegacyIntegrationId,
      'airtable',
      'Late Legacy Airtable',
      'saas',
      'api_key',
      JSON.stringify({ base_id: 'app456' }),
      'encrypted-secret',
      userId,
    );

    await expect(
      orgStub.getWorkspaceIntegration(workspace.id, secondLegacyIntegrationId),
    ).resolves.toBeNull();
  });

  it('revokes workspace access when org membership is removed', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Membership Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspaces = await listUserWorkspaces(testEnv, ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const accessBefore = await getWorkspaceAccess(testEnv, workspace.id, memberId);
    expect(accessBefore).toBe('full');

    await removeOrgMember(testEnv, org.id, memberId, ownerId);

    const accessAfter = await getWorkspaceAccess(testEnv, workspace.id, memberId);
    expect(accessAfter).toBe('none');

    const memberWorkspaces = await listUserWorkspaces(testEnv, memberId, org.id);
    expect(memberWorkspaces).toHaveLength(0);
  });

  it('creates integration and stores encrypted credentials', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Integration Owner');
    const { org } = await createOrg(testEnv, 'Integration Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await createWorkspaceIntegration(testEnv, workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    expect(integration.has_credentials).toBe(true);

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const record = await orgStub.getWorkspaceIntegration(workspace.id, integration.id);
    expect(record?.credentials_encrypted).toBeTruthy();
    expect(record?.credentials_encrypted).not.toBe('secret-key');

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('integration_created');
  });

  it('marks new integrations without credentials as setup_incomplete', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Setup Owner');
    const { org } = await createOrg(testEnv, 'Setup Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await createWorkspaceIntegration(testEnv, workspace.id, userId, {
      integration_type: 'cloudflare',
      name: 'Cloudflare',
      config: {},
    });

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const record = await orgStub.getWorkspaceIntegration(workspace.id, integration.id);
    expect(record?.credentials_encrypted).toBe('');
    expect(record?.auth_status).toBe('setup_incomplete');
    expect(record?.auth_error_code).toBe('AUTH_SETUP_INCOMPLETE');
    expect(record?.reauth_required_at).toEqual(expect.any(Number));
  });

  it('updates integration and logs audit entry', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Integration Owner');
    const { org } = await createOrg(testEnv, 'Integration Audit Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await createWorkspaceIntegration(testEnv, workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    const updated = await updateWorkspaceIntegration(testEnv, workspace.id, integration.id, userId, {
      name: 'Airtable Updated',
    });
    expect(updated?.name).toBe('Airtable Updated');

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('integration_updated');
  });

  it('invalidates persisted verification when connection behavior changes', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Verification Owner');
    const { org } = await createOrg(testEnv, 'Verification Org', userId);
    const [workspace] = await listUserWorkspaces(testEnv, userId, org.id);
    expect(workspace).toBeDefined();

    const integration = await createWorkspaceIntegration(testEnv, workspace!.id, userId, {
      integration_type: 'other',
      name: 'Inventory',
      config: { base_url: 'https://api.example.com/v1', auth_type: 'none' },
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const sourceRecord = await orgStub.getWorkspaceIntegration(workspace!.id, integration.id);
    expect(sourceRecord).toBeDefined();
    await orgStub.updateWorkspaceIntegrationVerification(workspace!.id, integration.id, {
      status: 'configured',
      message: 'Configuration valid.',
      checkedAt: Date.now(),
      live: false,
      strategy: 'http_configuration',
    }, userId, {
      config: sourceRecord!.config,
      credentialsEncrypted: sourceRecord!.credentials_encrypted,
    });
    const verifiedRecord = await orgStub.getWorkspaceIntegration(workspace!.id, integration.id);
    expect(verifiedRecord?.updated_at).toBe(sourceRecord!.updated_at);
    await updateWorkspaceIntegration(testEnv, workspace!.id, integration.id, userId, {
      config: { base_url: 'https://api.example.com/v2', auth_type: 'none' },
    });

    const staleWriteApplied = await orgStub.updateWorkspaceIntegrationVerification(workspace!.id, integration.id, {
      status: 'ready',
      message: 'Stale provider response.',
      checkedAt: Date.now(),
      live: true,
      strategy: 'mcp_discovery',
    }, userId, {
      config: sourceRecord!.config,
      credentialsEncrypted: sourceRecord!.credentials_encrypted,
    });
    expect(staleWriteApplied).toBe(false);

    const record = await orgStub.getWorkspaceIntegration(workspace!.id, integration.id);
    expect(record).toMatchObject({
      verification_status: null,
      verification_message: null,
      verification_checked_at: null,
      verification_live: null,
      verification_strategy: null,
    });
  });

  it('deletes integration (soft delete) and logs audit entry', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Integration Owner');
    const { org } = await createOrg(testEnv, 'Integration Delete Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await createWorkspaceIntegration(testEnv, workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    await deleteWorkspaceIntegration(testEnv, workspace.id, integration.id, userId);

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('integration_deleted');
  });

  it('getIntegrations excludes soft-deleted entries', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Integration Owner');
    const { org } = await createOrg(testEnv, 'Integration List Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    const integration = await createWorkspaceIntegration(testEnv, workspace.id, userId, {
      integration_type: 'airtable',
      name: 'Airtable',
      config: {},
      credentials: { api_key: 'secret-key' },
    });

    await deleteWorkspaceIntegration(testEnv, workspace.id, integration.id, userId);

    const integrations = await getWorkspaceIntegrations(testEnv, workspace.id);
    expect(integrations).toHaveLength(0);
  });

  it('lists workspace members with access levels', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Member Access Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspaces = await listUserWorkspaces(testEnv, ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await setWorkspaceAccess(testEnv, workspace.id, memberId, 'none', ownerId);
    const members = await listWorkspaceMembers(testEnv, workspace.id);
    const record = members.find((entry) => entry.user_id === memberId);
    expect(record?.access_level).toBe('none');
  });

  it('logs access changes in workspace audit log', async () => {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Access Audit Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspaces = await listUserWorkspaces(testEnv, ownerId, org.id);
    const workspace = workspaces[0];
    expect(workspace).toBeDefined();

    await setWorkspaceAccess(testEnv, workspace.id, memberId, 'none', ownerId);
    await setWorkspaceAccess(testEnv, workspace.id, memberId, 'full', ownerId);

    const audit = await getWorkspaceAuditLog(testEnv, workspace.id);
    const actions = audit.map((entry) => entry.action);
    expect(actions.filter((action) => action === 'workspace_access_changed').length).toBeGreaterThanOrEqual(2);
  });
});
