/**
 * Test helpers for direct DO calls
 *
 * These helpers replace the DoRpcService for tests, using direct DO namespace bindings.
 *
 * IMPORTANT: For business logic functions (acceptInvitation, createWorkspace, removeOrgMember,
 * archiveWorkspace, archiveOrg), we delegate to the production code in auth-do.ts.
 * TestEnv is structurally compatible with AuthEnv, so we can cast between them.
 * Only test-only utilities (creating users with known passwords, session management)
 * remain as shadow logic here.
 */

import type { UserDO, OrgDO, OrgRole, User } from '../src/auth';
import type { WorkspaceDO, Workspace, WorkspaceAccessLevel as WorkspaceAccessLevelDO } from '../src/workspace';
import type { AuthEnv } from '../../../src/lib/auth-helpers';
import type { SignupDO } from '../src/signup-do';
import { hashPassword, verifyPassword } from '../src/password';
import { getSession, updateSession, destroySession, type SessionData } from '../src/session-kv';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
// Production business logic - delegated to instead of reimplemented
import {
  acceptInvitation as prodAcceptInvitation,
  adminTransferOrgOwnership as prodAdminTransferOrgOwnership,
  createWorkspace as prodCreateWorkspace,
  removeOrgMember as prodRemoveOrgMember,
  updateOrgMemberRole as prodUpdateOrgMemberRole,
  archiveOrg as prodArchiveOrg,
  checkUserOrphaned as prodCheckUserOrphaned,
  listOrgWorkspaces as prodListOrgWorkspaces,
  listUserWorkspaces as prodListUserWorkspaces,
  listUserWorkspacesAcrossOrgs as prodListUserWorkspacesAcrossOrgs,
  getWorkspace as prodGetWorkspace,
  updateWorkspace as prodUpdateWorkspace,
  getWorkspaceAuditLog as prodGetWorkspaceAuditLog,
  getWorkspaceAccess as prodGetWorkspaceAccess,
  setWorkspaceAccess as prodSetWorkspaceAccess,
  transferOrgOwnership as prodTransferOrgOwnership,
} from '../../../src/lib/auth-do';

export interface TestEnv {
  USER: DurableObjectNamespace<UserDO>;
  SIGNUP: DurableObjectNamespace<SignupDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  APP_DB?: D1Database;
  EMAIL_TO_USER: KVNamespace;
  SESSIONS: KVNamespace;
  APP_KV: KVNamespace;
  INTEGRATION_SECRET_KEY?: string;
}

// Helper to generate unique IDs
function generateId(): string {
  return crypto.randomUUID();
}

// ============ User Operations ============

export async function createUser(
  env: TestEnv,
  email: string,
  password: string,
  name: string,
  signupIp: string | null = null
): Promise<{ userId: string; user: User }> {
  const userId = generateId();
  const userStub = env.USER.get(env.USER.idFromName(userId));

  const user = await userStub.createUser(userId, email, password, name, signupIp);

  // Store email -> userId mapping
  await env.EMAIL_TO_USER.put(email.toLowerCase(), userId);

  return { userId, user };
}

export async function getUserByEmail(
  env: TestEnv,
  email: string
): Promise<{ userId: string; user: User } | null> {
  const userId = await env.EMAIL_TO_USER.get(email.toLowerCase());
  if (!userId) return null;

  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile) return null;

  return { userId, user: profile };
}

export async function getUserById(
  env: TestEnv,
  userId: string
): Promise<User | null> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.getProfile();
}

export async function verifyUserPassword(
  env: TestEnv,
  userId: string,
  password: string
): Promise<boolean> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.verifyPassword(password);
}

export async function updateUserProfile(
  env: TestEnv,
  userId: string,
  updates: { name?: string | null; avatar?: { color?: string; content?: string }; is_superuser?: boolean }
): Promise<User | null> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.updateProfile(updates);
  if (updates.is_superuser === true) {
    await userStub.markEmailVerified();
    return userStub.getProfile();
  }
  return profile;
}

/**
 * Re-run UserDO migrations, simulating a DO re-instantiation (eviction + re-creation).
 * This triggers the same migration path as the constructor.
 */
export async function remigrateUser(
  env: TestEnv,
  userId: string
): Promise<void> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.remigrate();
}

/**
 * Get the schema version as read by the UserDO migration logic.
 */
export async function getUserSchemaVersion(
  env: TestEnv,
  userId: string
): Promise<number> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.getSchemaVersion();
}

export async function getUserOrgs(
  env: TestEnv,
  userId: string
): Promise<Array<{ org_id: string; org_name: string; role: OrgRole; last_workspace_id: string | null }>> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const orgs = await userStub.getOrgs();

  const result: Array<{ org_id: string; org_name: string; role: OrgRole; last_workspace_id: string | null }> = [];
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.org_id));
    const info = await orgStub.getInfo();
    if (info && !info.archived) {
      result.push({
        org_id: org.org_id,
        org_name: info.name,
        role: org.role,
        last_workspace_id: org.last_workspace_id,
      });
    }
  }
  return result;
}

/**
 * Delegates to production auth-do.ts checkUserOrphaned.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function checkUserOrphaned(env: TestEnv, userId: string): Promise<void> {
  await prodCheckUserOrphaned(env as unknown as AuthEnv, userId);
}

export async function handleOrphanedUserLogin(
  env: TestEnv,
  userId: string
): Promise<{ org: { id: string; name: string }; workspace: { id: string; name: string } } | null> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile || !profile.is_orphaned) return null;

  // Create a new org for the orphaned user (which also creates default workspace)
  const { org, defaultWorkspaceId } = await createOrg(env, `${profile.name}'s Workspace`, userId);

  // Get default workspace info
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(defaultWorkspaceId));
  const workspace = await wsStub.getInfo();

  await userStub.setOrphaned(false);

  return {
    org: { id: org.id, name: org.name },
    workspace: { id: workspace!.id, name: workspace!.name },
  };
}

// ============ Organization Operations ============

type TestBillingPlan =
  | 'free'
  | 'payg'
  | 'starter'
  | 'pro'
  | 'team'
  | 'enterprise';

export async function createOrg(
  env: TestEnv,
  name: string,
  createdBy: string,
  options: { billingPlan?: TestBillingPlan } = {},
): Promise<{ org: { id: string; name: string; slug: string; created_by: string }; defaultWorkspaceId: string }> {
  const orgId = generateId();
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  const { org, defaultWorkspaceId } = await orgStub.createOrg(orgId, name, createdBy);
  const billingPlan = options.billingPlan ?? 'enterprise';
  const billingStatus =
    billingPlan === 'enterprise'
      ? 'enterprise'
      : billingPlan === 'starter' || billingPlan === 'pro' || billingPlan === 'team'
        ? 'active'
        : 'inactive';
  if (billingPlan !== org.billing_plan || billingStatus !== org.billing_status) {
    await orgStub.updateBillingState({
      billing_plan: billingPlan,
      billing_status: billingStatus,
    });
  }

  // Add org to user's orgs
  // Note: Org members have 'full' workspace access by default (no explicit record needed)
  const userStub = env.USER.get(env.USER.idFromName(createdBy));
  await userStub.addOrg(orgId, 'owner', defaultWorkspaceId);

  return { org: { id: org.id, name: org.name, slug: org.slug, created_by: org.created_by }, defaultWorkspaceId };
}

export async function getOrg(
  env: TestEnv,
  orgId: string
): Promise<{ id: string; name: string; created_by: string; archived?: boolean; billing_status?: string } | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await orgStub.getInfo();
  if (!info) return null;
  return { id: info.id, name: info.name, created_by: info.created_by, archived: info.archived, billing_status: info.billing_status };
}

export async function updateOrgName(
  env: TestEnv,
  orgId: string,
  name: string,
  actorId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.updateName(name, actorId);
}

export async function isOrgMember(env: TestEnv, userId: string, orgId: string): Promise<boolean> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  return userStub.hasOrg(orgId);
}

export async function isOrgAdmin(env: TestEnv, userId: string, orgId: string): Promise<boolean> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  return orgStub.isAdmin(userId);
}

export async function getOrgMembers(
  env: TestEnv,
  orgId: string
): Promise<Array<{ user: { id: string; name: string; email: string }; role: OrgRole }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await orgStub.getMembers();

  const result: Array<{ user: { id: string; name: string; email: string }; role: OrgRole }> = [];
  for (const member of members) {
    const userStub = env.USER.get(env.USER.idFromName(member.user_id));
    const profile = await userStub.getProfile();
    if (profile) {
      result.push({
        user: { id: member.user_id, name: profile.name, email: profile.email },
        role: member.role,
      });
    }
  }
  return result;
}

/**
 * Delegates to production auth-do.ts removeOrgMember.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function removeOrgMember(
  env: TestEnv,
  orgId: string,
  userId: string,
  actorId: string
): Promise<void> {
  return prodRemoveOrgMember(env as unknown as AuthEnv, orgId, userId, actorId);
}

export async function tryRemoveOrgMember(
  env: TestEnv,
  orgId: string,
  userId: string,
  actorId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Check if trying to remove the owner
  const isOwner = await orgStub.isOwner(userId);
  if (isOwner) {
    return { ok: false, error: 'Cannot remove organization owner' };
  }

  await removeOrgMember(env, orgId, userId, actorId);
  return { ok: true };
}

export async function updateOrgMemberRole(
  env: TestEnv,
  orgId: string,
  userId: string,
  role: OrgRole,
  actorId: string
): Promise<void> {
  return prodUpdateOrgMemberRole(
    env as unknown as AuthEnv,
    orgId,
    userId,
    role,
    actorId
  );
}

export async function tryUpdateOrgMemberRole(
  env: TestEnv,
  orgId: string,
  userId: string,
  role: OrgRole,
  actorId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Check if trying to change the owner's role
  const isOwner = await orgStub.isOwner(userId);
  if (isOwner && role !== 'owner') {
    return { ok: false, error: 'Cannot change the owner role. Transfer ownership first.' };
  }

  await updateOrgMemberRole(env, orgId, userId, role, actorId);
  return { ok: true };
}

/**
 * Delegates to production auth-do.ts transferOrgOwnership.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function transferOrgOwnership(
  env: TestEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string
): Promise<void> {
  return prodTransferOrgOwnership(env as unknown as AuthEnv, orgId, newOwnerId, actorId);
}

/**
 * Delegates to production auth-do.ts adminTransferOrgOwnership.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function adminTransferOrgOwnership(
  env: TestEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string
): Promise<void> {
  return prodAdminTransferOrgOwnership(env as unknown as AuthEnv, orgId, newOwnerId, actorId);
}

/**
 * Delegates to production auth-do.ts archiveOrg.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function archiveOrg(
  env: TestEnv,
  orgId: string,
  actorId: string
): Promise<void> {
  return prodArchiveOrg(env as unknown as AuthEnv, orgId, actorId);
}

export async function getOrgAuditLog(
  env: TestEnv,
  orgId: string
): Promise<Array<{ action: string; actor_id: string; target_id: string | null; details: Record<string, unknown> | null }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const audit = await orgStub.getAuditLog();
  return audit.map((entry) => ({
    action: entry.action,
    actor_id: entry.actor_id,
    target_id: entry.target_id,
    details: entry.details ? JSON.parse(entry.details) : null,
  }));
}

// ============ Invitation Operations ============

export async function createInvitation(
  env: TestEnv,
  orgId: string,
  email: string,
  role: OrgRole,
  actorId: string
): Promise<{ id: string; expires_at: number }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.createInvitation(email, role, actorId);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function getOrgInvitations(
  env: TestEnv,
  orgId: string
): Promise<Array<{ id: string; email: string; role: OrgRole }>> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitations = await orgStub.getInvitations();
  return invitations.map((inv) => ({ id: inv.id, email: inv.email, role: inv.role }));
}

export async function getInvitation(
  env: TestEnv,
  orgId: string,
  invitationId: string
): Promise<{ id: string; email: string; role: OrgRole; org: { id: string; name: string } } | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return null;

  const orgInfo = await orgStub.getInfo();
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    org: { id: orgId, name: orgInfo?.name || '' },
  };
}

/**
 * Delegates to production auth-do.ts acceptInvitation.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function acceptInvitation(
  env: TestEnv,
  orgId: string,
  invitationId: string,
  userId: string
): Promise<boolean> {
  return prodAcceptInvitation(env as unknown as AuthEnv, orgId, invitationId, userId);
}

export async function deleteInvitation(
  env: TestEnv,
  orgId: string,
  invitationId: string
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.deleteInvitation(invitationId);
}

// ============ Workspace Operations ============

/**
 * Delegates to production auth-do.ts createWorkspace.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function createWorkspace(
  env: TestEnv,
  orgId: string,
  name: string,
  createdBy: string,
  description?: string
): Promise<{ id: string; org_id: string; name: string }> {
  const ws = await prodCreateWorkspace(env as unknown as AuthEnv, orgId, name, createdBy, description ?? null);
  return { id: ws.id, org_id: ws.org_id, name: ws.name };
}

export async function getWorkspace(
  env: TestEnv,
  workspaceId: string
): Promise<Workspace | null> {
  return prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
}

export async function updateWorkspace(
  env: TestEnv,
  workspaceId: string,
  updates: { name?: string; description?: string },
  actorId: string
): Promise<Workspace | null> {
  return prodUpdateWorkspace(
    env as unknown as AuthEnv,
    workspaceId,
    updates,
    actorId,
  );
}

/**
 * Delegates to production auth-do.ts listOrgWorkspaces.
 * TestEnv is structurally compatible with AuthEnv.
 */
export async function listOrgWorkspaces(
  env: TestEnv,
  orgId: string
): Promise<Array<{ id: string; name: string }>> {
  const workspaces = await prodListOrgWorkspaces(env as unknown as AuthEnv, orgId);
  return workspaces.map((ws) => ({ id: ws.id, name: ws.name }));
}

export async function listUserWorkspaces(
  env: TestEnv,
  userId: string,
  orgId: string
): Promise<Array<{ id: string; name: string; access_level: WorkspaceAccessLevelDO }>> {
  const workspaces = await prodListUserWorkspaces(env as unknown as AuthEnv, userId, orgId);
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    access_level: ws.access_level,
  }));
}

export async function listUserWorkspacesAcrossOrgs(
  env: TestEnv,
  userId: string
): Promise<Array<{ id: string; name: string; org_id: string; access_level: WorkspaceAccessLevelDO }>> {
  const workspaces = await prodListUserWorkspacesAcrossOrgs(
    env as unknown as AuthEnv,
    userId,
  );
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    org_id: ws.org_id,
    access_level: ws.access_level,
  }));
}

/**
 * Delegates to production auth-do.ts archiveWorkspace.
 * Uses the same import path; TestEnv is structurally compatible with AuthEnv.
 */
export async function archiveWorkspace(
  env: TestEnv,
  workspaceId: string,
  actorId: string
): Promise<void> {
  const { archiveWorkspace: prodArchiveWorkspace } = await import('../../../src/lib/auth-do');
  return prodArchiveWorkspace(env as unknown as AuthEnv, workspaceId, actorId);
}

export async function tryArchiveWorkspace(
  env: TestEnv,
  workspaceId: string,
  actorId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const info = await prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
  if (!info) return { ok: false, error: 'Workspace not found' };

  // Check if this is the only workspace
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  const workspaces = await orgStub.getWorkspaces();
  const activeWorkspaces = workspaces.filter((ws) => !ws.archived);
  if (activeWorkspaces.length <= 1) {
    return { ok: false, error: 'Cannot archive the only workspace in an organization' };
  }

  await archiveWorkspace(env, workspaceId, actorId);
  return { ok: true };
}

export async function getWorkspaceAuditLog(
  env: TestEnv,
  workspaceId: string
): Promise<Array<{ action: string; actor_id: string }>> {
  const audit = await prodGetWorkspaceAuditLog(
    env as unknown as AuthEnv,
    workspaceId,
  );
  return audit.map((entry) => ({ action: entry.action, actor_id: entry.actor_id }));
}

// ============ Workspace Access Operations ============

export async function setWorkspaceAccess(
  env: TestEnv,
  workspaceId: string,
  userId: string,
  access: WorkspaceAccessLevelDO,
  actorId: string
): Promise<void> {
  await prodSetWorkspaceAccess(
    env as unknown as AuthEnv,
    workspaceId,
    userId,
    access,
    actorId,
  );
}

export async function getWorkspaceAccess(
  env: TestEnv,
  workspaceId: string,
  userId: string
): Promise<WorkspaceAccessLevelDO> {
  return prodGetWorkspaceAccess(env as unknown as AuthEnv, workspaceId, userId);
}

export async function listWorkspaceMembers(
  env: TestEnv,
  workspaceId: string
): Promise<Array<{ user_id: string; access_level: WorkspaceAccessLevelDO }>> {
  const info = await prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
  if (!info) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  return orgStub.listWorkspaceMembers(workspaceId);
}

// ============ Workspace Integration Operations ============

export async function createWorkspaceIntegration(
  env: TestEnv,
  workspaceId: string,
  actorId: string,
  data: {
    integration_type: string;
    name: string;
    config: Record<string, unknown>;
    credentials?: Record<string, string>;
    category?: string;
    auth_method?: string;
  }
): Promise<{ id: string; has_credentials: boolean }> {
  const workspace = await prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  const orgStub = env.ORG.get(env.ORG.idFromName(workspace.org_id));

  let credentialsEncrypted: string | null = null;
  if (data.credentials && Object.keys(data.credentials).length > 0) {
    const secretKey = env.INTEGRATION_SECRET_KEY || 'test-secret-key-for-integration-tests';
    credentialsEncrypted = await encryptCredentials(data.credentials, secretKey);
  }

  const integrationId = generateId();
  await orgStub.createWorkspaceIntegration(
    workspaceId,
    integrationId,
    data.integration_type,
    data.name,
    data.category ?? 'general',
    data.auth_method ?? 'api_key',
    JSON.stringify(data.config),
    credentialsEncrypted ?? '',
    actorId
  );

  return { id: integrationId, has_credentials: !!credentialsEncrypted };
}

export async function updateWorkspaceIntegration(
  env: TestEnv,
  workspaceId: string,
  integrationId: string,
  actorId: string,
  data: { name?: string }
): Promise<{ name: string } | null> {
  const workspace = await prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  const orgStub = env.ORG.get(env.ORG.idFromName(workspace.org_id));
  await orgStub.updateWorkspaceIntegration(workspaceId, integrationId, data, actorId);
  // Fetch the updated integration to return the new values
  const updated = await orgStub.getWorkspaceIntegration(workspaceId, integrationId);
  if (!updated) return null;
  return { name: updated.name };
}

export async function deleteWorkspaceIntegration(
  env: TestEnv,
  workspaceId: string,
  integrationId: string,
  actorId: string
): Promise<void> {
  const workspace = await prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
  if (!workspace) throw new Error('Workspace not found');
  const orgStub = env.ORG.get(env.ORG.idFromName(workspace.org_id));
  await orgStub.deleteWorkspaceIntegration(workspaceId, integrationId, actorId);
}

export async function getWorkspaceIntegrations(
  env: TestEnv,
  workspaceId: string
): Promise<Array<{ id: string; name: string }>> {
  const workspace = await prodGetWorkspace(env as unknown as AuthEnv, workspaceId);
  if (!workspace) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(workspace.org_id));
  const integrations = await orgStub.getWorkspaceIntegrations(workspaceId);
  return integrations.map((i) => ({ id: i.id, name: i.name }));
}

// ============ Session Operations ============

export async function getSessionData(
  env: TestEnv,
  sessionId: string
): Promise<SessionData | null> {
  return getSession(env.SESSIONS, sessionId);
}

export async function destroySessionData(
  env: TestEnv,
  sessionId: string
): Promise<void> {
  await destroySession(env.SESSIONS, sessionId);
}

export async function switchSessionOrg(
  env: TestEnv,
  sessionId: string,
  orgId: string
): Promise<void> {
  const session = await getSession(env.SESSIONS, sessionId);
  if (!session) return;

  // Get a workspace for this org
  const userStub = env.USER.get(env.USER.idFromName(session.user_id));
  const orgs = await userStub.getOrgs();
  const orgEntry = orgs.find((o) => o.org_id === orgId);
  let workspaceId = orgEntry?.last_workspace_id || null;

  if (!workspaceId) {
    const workspaces = await listUserWorkspaces(env, session.user_id, orgId);
    workspaceId = workspaces[0]?.id || null;
  }

  await updateSession(env.SESSIONS, sessionId, { org_id: orgId, workspace_id: workspaceId });
}

export async function switchSessionWorkspace(
  env: TestEnv,
  sessionId: string,
  workspaceId: string
): Promise<void> {
  const session = await getSession(env.SESSIONS, sessionId);
  if (!session) return;

  await updateSession(env.SESSIONS, sessionId, { workspace_id: workspaceId });

  // Update last_workspace_id in user's org membership
  const userStub = env.USER.get(env.USER.idFromName(session.user_id));
  await userStub.setOrgLastWorkspace(session.org_id, workspaceId);
}
