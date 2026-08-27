import type {
  User,
  Organization,
  OrgMembership,
  OrgRole,
  Workspace,
  WorkspaceWithAccess,
  WorkspaceAccessLevel,
  AuditLogEntry,
  AppPreviewStatus,
  Integration,
} from "@/types";
import { validateApiToken as validateApiTokenKV } from "../../workers/main/src/api-tokens";
import {
  createSignedSession,
  ENTERPRISE_OIDC_AUTH_SOURCE,
  type SignedSessionData,
} from "../../workers/main/src/signed-session";
import {
  assertEmailDomainAllowed,
  getBlocklistFromKV,
} from "./email-domain-blocklist";
import { getBillingPlanLimits } from "./billing-plans";
import { isSelfhostRuntime } from "./selfhost-runtime";
import { retryTransientDurableObjectRead } from "./do-rpc-retry.server";

import {
  type AuthEnv,
  type SessionData,
  type ApiTokenData,
} from "./auth-helpers";
import type { UserOrg } from "../../workers/main/src/auth";
import type { WorkspaceIntegrationRecord } from "../../workers/main/src/workspace";
import type { WorkspaceIntegrationDefinitionRecord } from "@/lib/integration-definition";
import type { LlmProviderConfigRecord } from "./llm-provider-config";
import { getAppIndexDatabase, getAppIndexReadDatabase } from "../../workers/main/src/app-index-db";

interface GetUserOrgsOptions {
  preloadedOrgInfoById?: Map<
    string,
    Promise<Organization | null> | Organization | null
  >;
  preloadedUserOrgs?: UserOrg[];
}

interface ListUserWorkspacesAcrossOrgsOptions {
  preloadedWorkspacesByOrgId?: Map<
    string,
    Promise<Workspace[]> | Workspace[]
  >;
}

const WORKSPACE_ORG_INDEX_PREFIX = "workspace_org:";

async function getWorkspaceOrgId(
  env: AuthEnv,
  workspaceId: string,
): Promise<string | null> {
  const indexed = await env.APP_KV.get(`${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`);
  if (indexed) return indexed;
  const appIndex = getAppIndexReadDatabase(env);
  const orgId = appIndex ? await appIndex.getWorkspaceOrgId(workspaceId) : null;
  if (orgId) {
    await env.APP_KV.put(`${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`, orgId);
    return orgId;
  }
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const workspace = await retryTransientDurableObjectRead(
    "WorkspaceDO.getInfo",
    () =>
      (
        workspaceStub as unknown as {
          getInfo(): Promise<Workspace | null>;
        }
      ).getInfo(),
  );
  if (workspace?.org_id) {
    await env.APP_KV.put(
      `${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`,
      workspace.org_id,
    );
    return workspace.org_id;
  }
  return null;
}

async function getWorkspaceRecord(
  env: AuthEnv,
  workspaceId: string,
): Promise<Workspace | null> {
  const orgId = await getWorkspaceOrgId(env, workspaceId);
  if (!orgId) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  return retryTransientDurableObjectRead(
    "OrgDO.getWorkspaceRecord",
    () =>
      (
        orgStub as unknown as {
          getWorkspaceRecord(workspaceId: string): Promise<Workspace | null>;
        }
      ).getWorkspaceRecord(workspaceId),
  );
}

async function getWorkspaceOrgStub(
  env: AuthEnv,
  workspaceId: string,
): Promise<DurableObjectStub | null> {
  const orgId = await getWorkspaceOrgId(env, workspaceId);
  if (!orgId) return null;
  return env.ORG.get(env.ORG.idFromName(orgId));
}

export interface OrgSettingsSummary {
  name: string;
  archived: boolean;
  billing_plan: Organization["billing_plan"];
  billing_status: Organization["billing_status"];
  member_count: number;
  workspace_count: number;
}

export interface OrgProviderContext {
  info: Organization | null;
  llmProviderConfig: LlmProviderConfigRecord | null;
}

export interface OrgOnboardingWelcomeContext extends OrgProviderContext {
  memberCount: number;
  appCount: number;
  integrations: string[];
}

export async function resetOnboardingForUser(
  env: AuthEnv,
  userId: string,
): Promise<void> {
  const stub = env.USER.get(env.USER.idFromName(userId));
  await retryTransientDurableObjectRead("UserDO.resetOnboarding", () =>
    stub.resetOnboarding(),
  );
}

// Session functions — signed cookies replace KV storage

/**
 * Create a new signed session token. Returns the HMAC-signed token string
 * that should be set as the session cookie value.
 */
export async function createSession(
  env: AuthEnv,
  userId: string,
  orgId: string,
  workspaceId: string | null = null,
  userInfo?: { name?: string | null; email?: string | null },
  options?: {
    authSource?: SignedSessionData["auth_source"];
    expiresAt?: number;
    ssoConnectionId?: string;
    ssoConfigVersion?: number;
  },
): Promise<{ signedToken: string; sessionData: SessionData }> {
  const now = Date.now();
  const sessionData: SessionData = {
    user_id: userId,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: now,
    last_accessed: now,
    expires_at: options?.expiresAt,
    sso_connection_id: options?.ssoConnectionId ?? null,
    sso_config_version: options?.ssoConfigVersion ?? null,
    user_name: userInfo?.name ?? null,
    user_email: userInfo?.email ?? null,
    auth_source: options?.authSource ?? null,
  };
  const signedSession: SignedSessionData = {
    user_id: userId,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: now,
    expires_at: options?.expiresAt,
    sso_connection_id: options?.ssoConnectionId ?? null,
    sso_config_version: options?.ssoConfigVersion ?? null,
    user_name: userInfo?.name ?? null,
    user_email: userInfo?.email ?? null,
    auth_source: options?.authSource ?? null,
  };
  const signedToken = await createSignedSession(
    env.TOKEN_SIGNING_SECRET,
    signedSession,
  );
  return { signedToken, sessionData };
}

/**
 * Re-sign a session with updated org/workspace. Returns new signed token.
 */
export async function switchSessionOrg(
  env: AuthEnv,
  currentSession: SessionData,
  orgId: string,
  workspaceId: string | null = null,
): Promise<string> {
  if (
    currentSession.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE &&
    currentSession.org_id !== orgId
  ) {
    throw new Error("Enterprise SSO sessions cannot switch organizations");
  }
  const signedSession: SignedSessionData = {
    user_id: currentSession.user_id,
    org_id: orgId,
    workspace_id: workspaceId,
    created_at: Date.now(),
    expires_at: currentSession.expires_at,
    sso_connection_id: currentSession.sso_connection_id,
    sso_config_version: currentSession.sso_config_version,
    user_name: currentSession.user_name,
    user_email: currentSession.user_email,
    auth_source: currentSession.auth_source ?? null,
  };
  const signedToken = await createSignedSession(
    env.TOKEN_SIGNING_SECRET,
    signedSession,
  );
  // Update user's last workspace for this org
  if (workspaceId) {
    const stub = env.USER.get(env.USER.idFromName(currentSession.user_id));
    await stub.setOrgLastWorkspace(orgId, workspaceId);
  }
  return signedToken;
}

/**
 * Re-sign a session with updated workspace. Returns new signed token.
 */
export async function switchSessionWorkspace(
  env: AuthEnv,
  currentSession: SessionData,
  workspaceId: string | null,
): Promise<string> {
  const signedSession: SignedSessionData = {
    user_id: currentSession.user_id,
    org_id: currentSession.org_id,
    workspace_id: workspaceId,
    created_at: Date.now(),
    expires_at: currentSession.expires_at,
    sso_connection_id: currentSession.sso_connection_id,
    sso_config_version: currentSession.sso_config_version,
    user_name: currentSession.user_name,
    user_email: currentSession.user_email,
    auth_source: currentSession.auth_source ?? null,
  };
  const signedToken = await createSignedSession(
    env.TOKEN_SIGNING_SECRET,
    signedSession,
  );
  // Update user's last workspace for this org
  if (workspaceId && currentSession.org_id) {
    const stub = env.USER.get(env.USER.idFromName(currentSession.user_id));
    await stub.setOrgLastWorkspace(currentSession.org_id, workspaceId);
  }
  return signedToken;
}

// User functions
export async function getUserByEmail(
  env: AuthEnv,
  email: string,
): Promise<{ userId: string; user: User } | null> {
  const normalizedEmail = email.toLowerCase();
  const userId = await env.EMAIL_TO_USER.get(`email:${normalizedEmail}`);
  if (!userId) return null;
  const stub = env.USER.get(env.USER.idFromName(userId));
  const user = await stub.getProfile();
  if (!user) return null;
  return { userId, user };
}

export async function getUsersByIds(
  env: AuthEnv,
  userIds: string[],
): Promise<(User & Disposable)[]> {
  const results = await Promise.all(
    userIds.map(async (userId) => {
      const stub = env.USER.get(env.USER.idFromName(userId));
      return stub.getProfile();
    }),
  );
  return results.filter((p): p is User & Disposable => p !== null);
}

export async function updateUser(
  env: AuthEnv,
  userId: string,
  updates: {
    name?: string | null;
    avatar?: { color: string; content: string };
  },
): Promise<User | null> {
  const stub = env.USER.get(env.USER.idFromName(userId));
  const profile = await stub.updateProfile({
    name: updates.name,
    avatar: updates.avatar,
  });
  if (!profile) return null;
  return profile;
}

export async function createUser(
  env: AuthEnv,
  email: string,
  password: string,
  name: string | null,
  signupIp: string | null = null,
): Promise<{ userId: string; user: User }> {
  const blocklist = await getBlocklistFromKV(env.APP_KV);
  assertEmailDomainAllowed(email, blocklist);

  const normalizedEmail = email.toLowerCase();
  const emailKvKey = `email:${normalizedEmail}`;

  // Check if email already exists
  const existingUserId = await env.EMAIL_TO_USER.get(emailKvKey);
  if (existingUserId) {
    throw new Error("An account with this email already exists");
  }

  const userId = crypto.randomUUID();

  // Claim the email
  await env.EMAIL_TO_USER.put(emailKvKey, userId);

  // Verify we still own it
  const verifyEmail = await env.EMAIL_TO_USER.get(emailKvKey);
  if (verifyEmail !== userId) {
    throw new Error("An account with this email already exists");
  }

  try {
    const stub = env.USER.get(env.USER.idFromName(userId));
    const user = await stub.createUser(
      userId,
      normalizedEmail,
      password,
      name,
      signupIp,
    );
    return { userId, user };
  } catch (error) {
    // Clean up on failure
    await env.EMAIL_TO_USER.delete(emailKvKey);
    throw error;
  }
}

export async function completePasswordSignup(
  env: AuthEnv,
  input: {
    attemptId: string;
    email: string;
    password: string;
    name: string | null;
    signupIp: string | null;
  },
) {
  const normalizedEmail = input.email.trim().toLowerCase();
  if (!env.SIGNUP) {
    throw new Error("SIGNUP Durable Object binding is not configured");
  }
  const stub = env.SIGNUP.get(env.SIGNUP.idFromName(normalizedEmail));
  return stub.completePasswordSignup({ ...input, email: normalizedEmail });
}

export async function isSignupIpBlocked(
  env: AuthEnv,
  ip: string | null | undefined,
): Promise<boolean> {
  const normalizedIp = ip?.trim();
  if (!normalizedIp) {
    return false;
  }

  const appIndex = getAppIndexReadDatabase(env);
  return appIndex ? appIndex.isSignupIpBlocked(normalizedIp) : false;
}

export async function blockSignupIp(
  env: AuthEnv,
  ip: string,
  blockedBy: string | null = null,
  reason: string | null = null,
): Promise<void> {
  const appIndex = getAppIndexDatabase(env);
  if (!appIndex) {
    throw new Error("APP_DB binding is not configured");
  }

  await appIndex.blockSignupIp(ip, blockedBy, reason);
}

export async function unblockSignupIp(env: AuthEnv, ip: string): Promise<void> {
  const appIndex = getAppIndexDatabase(env);
  if (!appIndex) {
    throw new Error("APP_DB binding is not configured");
  }

  await appIndex.unblockSignupIp(ip);
}

// OAuth functions
export async function createUserFromOAuth(
  env: AuthEnv,
  email: string,
  name: string | null,
  provider: "google" | "github" | "cloudflare_access" | "pomerium",
  providerId: string,
): Promise<{ userId: string; user: User }> {
  const blocklist = await getBlocklistFromKV(env.APP_KV);
  assertEmailDomainAllowed(email, blocklist);

  const normalizedEmail = email.toLowerCase();
  const emailKvKey = `email:${normalizedEmail}`;
  const oauthKvKey = `oauth:${provider}:${providerId}`;

  // Check if email already exists
  const existingUserId = await env.EMAIL_TO_USER.get(emailKvKey);
  if (existingUserId) {
    throw new Error("An account with this email already exists");
  }

  // Check if OAuth provider already linked
  const existingOAuthUserId = await env.EMAIL_TO_USER.get(oauthKvKey);
  if (existingOAuthUserId) {
    throw new Error("This OAuth account is already linked to another user");
  }

  const userId = crypto.randomUUID();

  // Claim the email and OAuth provider
  await Promise.all([
    env.EMAIL_TO_USER.put(emailKvKey, userId),
    env.EMAIL_TO_USER.put(oauthKvKey, userId),
  ]);

  // Verify we still own them
  const [verifyEmail, verifyOAuth] = await Promise.all([
    env.EMAIL_TO_USER.get(emailKvKey),
    env.EMAIL_TO_USER.get(oauthKvKey),
  ]);

  if (verifyEmail !== userId || verifyOAuth !== userId) {
    // Clean up and abort
    await Promise.all([
      env.EMAIL_TO_USER.delete(emailKvKey),
      env.EMAIL_TO_USER.delete(oauthKvKey),
    ]);
    throw new Error(
      "An account with this email or OAuth provider already exists",
    );
  }

  try {
    const stub = env.USER.get(env.USER.idFromName(userId));
    const user = await stub.createUserFromOAuth(
      userId,
      normalizedEmail,
      name,
      provider,
      providerId,
    );
    return { userId, user };
  } catch (error) {
    // Clean up on failure
    await Promise.all([
      env.EMAIL_TO_USER.delete(emailKvKey),
      env.EMAIL_TO_USER.delete(oauthKvKey),
    ]);
    throw error;
  }
}

/**
 * Creates an enterprise-SSO-only user at an identity claimed by OrgDO.
 *
 * Deliberately does not write EMAIL_TO_USER. The email claim is authoritative
 * only inside the organization that owns the SSO connection, so a tenant must
 * never be able to reserve or overwrite a global camelAI email identity.
 */
export async function createTenantScopedUserFromEnterpriseSso(
  env: AuthEnv,
  userId: string,
  email: string,
  name: string | null,
): Promise<{ userId: string; user: User }> {
  const blocklist = await getBlocklistFromKV(env.APP_KV);
  assertEmailDomainAllowed(email, blocklist);

  const normalizedEmail = email.toLowerCase();
  const user = await env.USER.get(
    env.USER.idFromName(userId),
  ).createUserFromEnterpriseSso(userId, normalizedEmail, name);
  return { userId, user };
}

export async function linkOAuthProvider(
  env: AuthEnv,
  userId: string,
  provider: "google" | "github" | "cloudflare_access" | "pomerium",
  providerId: string,
): Promise<void> {
  const oauthKvKey = `oauth:${provider}:${providerId}`;

  // Check if already linked to another user
  const existingUserId = await env.EMAIL_TO_USER.get(oauthKvKey);
  if (existingUserId && existingUserId !== userId) {
    throw new Error("This OAuth account is already linked to another user");
  }

  // Link in KV and DO
  await env.EMAIL_TO_USER.put(oauthKvKey, userId);
  const stub = env.USER.get(env.USER.idFromName(userId));
  await stub.linkOAuthProvider(provider, providerId);
}

export async function getUserOrgs(
  env: AuthEnv,
  userId: string,
  options?: GetUserOrgsOptions,
): Promise<OrgMembership[]> {
  const userOrgs =
    options?.preloadedUserOrgs ??
    (await env.USER.get(env.USER.idFromName(userId)).getOrgs());
  const preloadedOrgInfoById = options?.preloadedOrgInfoById;

  // Fetch all org info in parallel instead of sequential loop
  const orgInfos = await Promise.all(
    userOrgs.map(async (uo) => {
      const preloadedOrgInfo = preloadedOrgInfoById?.get(uo.org_id);
      const orgInfo = preloadedOrgInfo
        ? await preloadedOrgInfo
        : await env.ORG.get(env.ORG.idFromName(uo.org_id)).getInfo();
      return { uo, orgInfo };
    }),
  );

  return orgInfos
    .filter(({ orgInfo }) => orgInfo && !orgInfo.archived)
    .map(({ uo, orgInfo }) => ({
      org_id: uo.org_id,
      org_name: orgInfo!.name,
      role: uo.role,
      joined_at: uo.joined_at,
      last_workspace_id: uo.last_workspace_id ?? null,
    }));
}

// Admin functions that operate on single DOs (real implementations)
export async function adminUpdateUser(
  env: AuthEnv,
  userId: string,
  updates: {
    name?: string | null;
    avatar?: { color: string; content: string };
    is_superuser?: boolean;
  },
): Promise<User | null> {
  const stub = env.USER.get(env.USER.idFromName(userId));
  const profile = await stub.updateProfile({
    name: updates.name,
    avatar: updates.avatar,
    is_superuser: updates.is_superuser,
  });
  if (!profile) return null;
  return profile;
}

export async function adminTransferOrgOwnership(
  env: AuthEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string,
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await orgStub.getMembers();
  const currentOwner = members.find((member) => member.role === "owner");
  if (!currentOwner) {
    throw new Error("Organization has no owner");
  }
  if (newOwnerId === currentOwner.user_id) {
    return;
  }

  await orgStub.adminTransferOwnership(actorId, newOwnerId);

  const newOwnerStub = env.USER.get(env.USER.idFromName(newOwnerId));
  await newOwnerStub.updateOrgRole(orgId, "owner");

  const oldOwnerStub = env.USER.get(env.USER.idFromName(currentOwner.user_id));
  await oldOwnerStub.updateOrgRole(orgId, "admin");
}

export async function adminAddOrgMember(
  env: AuthEnv,
  orgId: string,
  userId: string,
  role: "admin" | "member",
  actorId: string,
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.addMember(userId, role, actorId);
  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addOrg(orgId, role, lastWorkspaceId);
  await userStub.setOrphaned(false);
}

export async function adminForceOrphanUser(
  env: AuthEnv,
  userId: string,
  _actorId: string,
): Promise<void> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const orgs = await userStub.getOrgs();
  // Remove from all orgs
  for (const org of orgs) {
    const orgStub = env.ORG.get(env.ORG.idFromName(org.org_id));
    await orgStub.removeMember(userId, userId);
    await userStub.removeOrg(org.org_id);
  }
  await userStub.setOrphaned(true);
}

// Organization functions
export async function getOrg(
  env: AuthEnv,
  orgId: string,
): Promise<Organization | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info) return null;
  return info;
}

export async function getOrgSettingsSummary(
  env: AuthEnv,
  orgId: string,
): Promise<OrgSettingsSummary | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return retryTransientDurableObjectRead("OrgDO.getSettingsSummary", () =>
    (
      stub as unknown as {
        getSettingsSummary(): Promise<OrgSettingsSummary | null>;
      }
    ).getSettingsSummary(),
  );
}

export async function getOrgProviderContext(
  env: AuthEnv,
  orgId: string,
): Promise<OrgProviderContext> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return retryTransientDurableObjectRead("OrgDO.getProviderContext", () =>
    (
      stub as unknown as {
        getProviderContext(): Promise<OrgProviderContext>;
      }
    ).getProviderContext(),
  );
}

export async function getOrgOnboardingWelcomeContext(
  env: AuthEnv,
  orgId: string,
  workspaceId: string | null,
): Promise<OrgOnboardingWelcomeContext> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return retryTransientDurableObjectRead(
    "OrgDO.getOnboardingWelcomeContext",
    () =>
      (
        stub as unknown as {
          getOnboardingWelcomeContext(
            workspaceId: string | null,
          ): Promise<OrgOnboardingWelcomeContext>;
        }
      ).getOnboardingWelcomeContext(workspaceId),
  );
}

export async function archiveOrg(
  env: AuthEnv,
  orgId: string,
  actorId: string,
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));

  // Archive all workspaces first (before marking org archived, so partial
  // failures don't leave an archived org with unarchived workspaces)
  const workspaces = await orgStub.getWorkspaces(true);
  await Promise.all(
    workspaces
      .filter((ws) => !ws.archived)
      .map(async (ws) => {
        const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
        await wsStub.archive(actorId);
      }),
  );

  // Remove non-owner members from OrgDO (owner stays for audit trail).
  // Remove org from ALL users' UserDO (including owner) so they can't access it.
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      if (member.role !== "owner") {
        await orgStub.removeMember(member.user_id, actorId);
      }
      const userStub = env.USER.get(env.USER.idFromName(member.user_id));
      await userStub.removeOrg(orgId);
      await checkUserOrphaned(env, member.user_id);
    }),
  );

  // Mark the org as archived last, after all cleanup is done
  await orgStub.archiveOrg(actorId);
}

export async function createOrg(
  env: AuthEnv,
  name: string,
  createdBy: string,
): Promise<{ org: Organization; defaultWorkspaceId: string }> {
  const orgId = crypto.randomUUID();
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // createOrg now creates the default workspace internally
  const { org: info, defaultWorkspaceId } = await orgStub.createOrg(
    orgId,
    name,
    createdBy,
  );

  // Add to user's orgs with the default workspace
  const userStub = env.USER.get(env.USER.idFromName(createdBy));
  await userStub.addOrg(orgId, "owner", defaultWorkspaceId);

  return { org: info, defaultWorkspaceId };
}

export async function getOrgMembers(
  env: AuthEnv,
  orgId: string,
): Promise<Array<{ user: User; role: OrgRole; joined_at: number }>> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const members = await stub.getMembers();

  // Fetch all user profiles in parallel instead of sequential loop
  const profileResults = await Promise.all(
    members.map(async (member) => {
      const userStub = env.USER.get(env.USER.idFromName(member.user_id));
      const profile = await userStub.getProfile();
      return { member, profile };
    }),
  );

  return profileResults
    .filter(({ profile }) => profile !== null)
    .map(({ member, profile }) => ({
      user: profile!,
      role: member.role,
      joined_at: member.joined_at,
    }));
}

export async function getOrgMembersWithWorkspaceAccess(
  env: AuthEnv,
  orgId: string,
): Promise<
  Array<{
    user: User;
    role: OrgRole;
    joined_at: number;
    workspaceAccess: Record<string, WorkspaceAccessLevel>;
  }>
> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const [members, workspaces] = await Promise.all([
    getOrgMembers(env, orgId),
    listOrgWorkspaces(env, orgId),
  ]);
  const accessByWorkspace = new Map<string, Map<string, WorkspaceAccessLevel>>();
  await Promise.all(
    workspaces.map(async (workspace) => {
      const rows = await retryTransientDurableObjectRead(
        "OrgDO.listWorkspaceMembers",
        () =>
          (
            orgStub as unknown as {
              listWorkspaceMembers(
                workspaceId: string,
              ): Promise<
                Array<{
                  user_id: string;
                  access_level: WorkspaceAccessLevel;
                }>
              >;
            }
          ).listWorkspaceMembers(workspace.id),
      );
      const accessMap = new Map<string, WorkspaceAccessLevel>();
      for (const row of rows) {
        accessMap.set(row.user_id, row.access_level);
      }
      accessByWorkspace.set(workspace.id, accessMap);
    }),
  );

  return members.map((member) => {
    const workspaceAccess: Record<string, WorkspaceAccessLevel> = {};
    for (const workspace of workspaces) {
      workspaceAccess[workspace.id] =
        accessByWorkspace.get(workspace.id)?.get(member.user.id) ?? "full";
    }
    return {
      ...member,
      workspaceAccess,
    };
  });
}

export async function isOrgMember(
  env: AuthEnv,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info || info.archived) return false;
  return stub.isMember(userId);
}

export async function isOrgAdmin(
  env: AuthEnv,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await stub.getInfo();
  if (!info || info.archived) return false;
  const member = await stub.getMember(userId);
  return member?.role === "owner" || member?.role === "admin";
}

export async function removeOrgMember(
  env: AuthEnv,
  orgId: string,
  userId: string,
  actorId: string,
): Promise<void> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));

  // Remove from all workspaces in the org
  const workspaces = await stub.getWorkspaces();
  await Promise.all(
    workspaces
      .filter((ws) => !ws.archived)
      .map(async (ws) => {
        const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
        await wsStub.removeMember(userId, actorId);
      }),
  );

  await stub.removeMember(userId, actorId);

  // Remove from user's org list
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.removeOrg(orgId);

  // Proactively check if user is now orphaned
  await checkUserOrphaned(env, userId);
}

export async function updateOrgMemberRole(
  env: AuthEnv,
  orgId: string,
  userId: string,
  role: OrgRole,
  actorId: string,
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  await orgStub.updateMemberRole(userId, role, actorId);

  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.updateOrgRole(orgId, role);
}

export async function transferOrgOwnership(
  env: AuthEnv,
  orgId: string,
  newOwnerId: string,
  actorId: string,
): Promise<void> {
  if (newOwnerId === actorId) {
    throw new Error("Cannot transfer ownership to yourself");
  }
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  await stub.transferOwnership(actorId, newOwnerId);
  // Update user roles
  const newOwnerStub = env.USER.get(env.USER.idFromName(newOwnerId));
  await newOwnerStub.updateOrgRole(orgId, "owner");
  const oldOwnerStub = env.USER.get(env.USER.idFromName(actorId));
  await oldOwnerStub.updateOrgRole(orgId, "admin");
}

export async function listOrgWorkspaces(
  env: AuthEnv,
  orgId: string,
  includeArchived = false,
): Promise<Workspace[]> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const workspaces = await retryTransientDurableObjectRead(
    "OrgDO.getWorkspaceInfos",
    () =>
      (
        stub as unknown as {
          getWorkspaceInfos(includeArchived?: boolean): Promise<Workspace[]>;
        }
      ).getWorkspaceInfos(includeArchived),
  );
  return includeArchived
    ? workspaces
    : workspaces.filter((workspace) => !workspace.archived);
}

export async function listUserWorkspaces(
  env: AuthEnv,
  userId: string,
  orgId: string,
): Promise<WorkspaceWithAccess[]> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return retryTransientDurableObjectRead("OrgDO.listUserWorkspaces", () =>
    (
      stub as unknown as {
        listUserWorkspaces(userId: string): Promise<WorkspaceWithAccess[]>;
      }
    ).listUserWorkspaces(userId),
  );
}

/**
 * List org workspaces skipping membership check — caller must have already
 * validated that the user belongs to the org (e.g. via getUserOrgs).
 */
async function listOrgWorkspacesForMember(
  env: AuthEnv,
  userId: string,
  orgId: string,
): Promise<WorkspaceWithAccess[]> {
  return listUserWorkspaces(env, userId, orgId);
}

export async function listUserWorkspacesAcrossOrgs(
  env: AuthEnv,
  userId: string,
  orgs?: OrgMembership[],
  options?: ListUserWorkspacesAcrossOrgsOptions,
): Promise<WorkspaceWithAccess[]> {
  const memberships = orgs ?? (await getUserOrgs(env, userId));
  if (memberships.length === 0) return [];
  const preloadedWorkspacesByOrgId = options?.preloadedWorkspacesByOrgId;

  // When orgs are pre-validated (passed in), skip redundant isOrgMember checks
  const results = await Promise.allSettled(
    orgs
      ? memberships.map(async (membership) => {
          const preloadedWorkspaces = preloadedWorkspacesByOrgId?.get(
            membership.org_id,
          );
          if (preloadedWorkspaces) {
            const workspaces = await preloadedWorkspaces;
            return workspaces.map((workspace) =>
              "access_level" in workspace
                ? (workspace as WorkspaceWithAccess)
                : { ...workspace, access_level: "full" as const },
            );
          }
          return listOrgWorkspacesForMember(env, userId, membership.org_id);
        })
      : memberships.map((membership) =>
          listUserWorkspaces(env, userId, membership.org_id),
        ),
  );
  return results.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;

    const membership = memberships[index];
    console.warn("[auth] failed to load org workspaces, skipping org in workspace switcher", {
      userId,
      orgId: membership?.org_id,
      error:
        result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    return [];
  });
}

export async function getWorkspace(
  env: AuthEnv,
  workspaceId: string,
): Promise<Workspace | null> {
  const info = await getWorkspaceRecord(env, workspaceId);
  if (!info || info.archived) return null;
  return info;
}

export async function createWorkspace(
  env: AuthEnv,
  orgId: string,
  name: string,
  createdBy: string,
  description?: string | null,
): Promise<Workspace> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const [orgInfo, existingWorkspaces] = await Promise.all([
    orgStub.getInfo(),
    listOrgWorkspaces(env, orgId),
  ]);
  const workspaceLimit = isSelfhostRuntime(env)
    ? null
    : orgInfo
    ? getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
        .includedWorkspaceCount
    : 1;
  if (workspaceLimit !== null && existingWorkspaces.length >= workspaceLimit) {
    throw new Error(
      `Your current billing plan includes ${workspaceLimit} workspace${workspaceLimit === 1 ? "" : "s"}.`,
    );
  }

  const workspaceId = crypto.randomUUID();
  const info = await (
    orgStub as unknown as {
      createWorkspaceRecord(
        workspaceId: string,
        name: string,
        createdBy: string,
        description?: string | null,
      ): Promise<Workspace>;
    }
  ).createWorkspaceRecord(workspaceId, name, createdBy, description ?? null);

  // Preserve each member's durable default. Tenant-scoped JIT members default
  // to no access, including for workspaces created after they joined.
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      if (member.workspace_access_default === "none") return;
      await (
        orgStub as unknown as {
          setWorkspaceAccess(
            workspaceId: string,
            userId: string,
            accessLevel: WorkspaceAccessLevel,
            actorId: string,
          ): Promise<void>;
        }
      ).setWorkspaceAccess(workspaceId, member.user_id, "full", createdBy);
    }),
  );

  return info;
}

export async function archiveWorkspace(
  env: AuthEnv,
  workspaceId: string,
  actorId: string,
): Promise<void> {
  const info = await getWorkspaceRecord(env, workspaceId);
  if (!info) return;

  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  await (
    orgStub as unknown as {
      archiveWorkspaceRecord(
        workspaceId: string,
        actorId: string,
      ): Promise<Workspace | null>;
    }
  ).archiveWorkspaceRecord(workspaceId, actorId);

  // Clear last_workspace_id for users who had this as their active workspace
  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      const userStub = env.USER.get(env.USER.idFromName(member.user_id));
      const orgs = await userStub.getOrgs();
      const orgEntry = orgs.find((o) => o.org_id === info.org_id);
      if (orgEntry?.last_workspace_id === workspaceId) {
        // Reassign to the first active workspace where access is not explicitly blocked.
        const workspaceRows = await orgStub.getWorkspaces();
        let newWorkspaceId: string | null = null;
        for (const workspace of workspaceRows) {
          const access = await (
            orgStub as unknown as {
              getWorkspaceAccess(
                workspaceId: string,
                userId: string,
              ): Promise<WorkspaceAccessLevel>;
            }
          ).getWorkspaceAccess(workspace.id, member.user_id);
          if (access !== "none") {
            newWorkspaceId = workspace.id;
            break;
          }
        }
        await userStub.setOrgLastWorkspace(info.org_id, newWorkspaceId);
      }
    }),
  );
}

export async function updateWorkspace(
  env: AuthEnv,
  workspaceId: string,
  updates: {
    name?: string;
    description?: string | null;
    avatar?: { color: string; content: string };
  },
  actorId: string,
): Promise<Workspace | null> {
  const existing = await getWorkspaceRecord(env, workspaceId);
  if (!existing) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(existing.org_id));
  const info = await (
    orgStub as unknown as {
      updateWorkspaceRecord(
        workspaceId: string,
        updates: {
          name?: string;
          description?: string | null;
          avatar?: { color?: string; content?: string };
        },
        actorId: string,
      ): Promise<Workspace | null>;
    }
  ).updateWorkspaceRecord(workspaceId, updates, actorId);
  if (!info) return null;
  return info;
}

export async function getWorkspaceAccess(
  env: AuthEnv,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceAccessLevel> {
  return (await getWorkspaceAccessContext(env, workspaceId, userId)).access;
}

export async function getWorkspaceAccessContext(
  env: AuthEnv,
  workspaceId: string,
  userId: string,
): Promise<{ workspace: Workspace | null; access: WorkspaceAccessLevel }> {
  const info = await getWorkspace(env, workspaceId);
  if (!info || info.archived) return { workspace: null, access: "none" };

  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  return retryTransientDurableObjectRead("OrgDO.getWorkspaceAccessContext", () =>
    (
      orgStub as unknown as {
        getWorkspaceAccessContext(
          workspaceId: string,
          userId: string,
        ): Promise<{ workspace: Workspace | null; access: WorkspaceAccessLevel }>;
      }
    ).getWorkspaceAccessContext(workspaceId, userId),
  );
}

export async function setWorkspaceAccess(
  env: AuthEnv,
  workspaceId: string,
  userId: string,
  accessLevel: WorkspaceAccessLevel,
  actorId: string,
): Promise<void> {
  const info = await getWorkspace(env, workspaceId);
  if (!info) {
    throw new Error("Workspace not found");
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  await retryTransientDurableObjectRead("OrgDO.setWorkspaceAccess", () =>
    (
      orgStub as unknown as {
        setWorkspaceAccess(
          workspaceId: string,
          userId: string,
          accessLevel: WorkspaceAccessLevel,
          actorId: string,
        ): Promise<void>;
      }
    ).setWorkspaceAccess(workspaceId, userId, accessLevel, actorId),
  );
}

export async function listWorkspaceIntegrations(
  env: AuthEnv,
  workspaceId: string,
): Promise<Integration[]> {
  const records = await listWorkspaceIntegrationRecords(env, workspaceId);
  return records.map((r) => ({
    id: r.id,
    integration_type: r.integration_type,
    name: r.name,
    category: r.category as Integration["category"],
    auth_method: r.auth_method as Integration["auth_method"],
    config: r.config ? JSON.parse(r.config) : {},
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    has_credentials: !!r.credentials_encrypted,
  }));
}

export async function listWorkspaceIntegrationRecords(
  env: AuthEnv,
  workspaceId: string,
): Promise<WorkspaceIntegrationRecord[]> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) return [];
  return (
    stub as unknown as {
      getWorkspaceIntegrations(
        workspaceId: string,
      ): Promise<WorkspaceIntegrationRecord[]>;
    }
  ).getWorkspaceIntegrations(workspaceId);
}

export async function getWorkspaceIntegrationRecord(
  env: AuthEnv,
  workspaceId: string,
  integrationId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) return null;
  return (
    stub as unknown as {
      getWorkspaceIntegration(
        workspaceId: string,
        integrationId: string,
      ): Promise<WorkspaceIntegrationRecord | null>;
    }
  ).getWorkspaceIntegration(workspaceId, integrationId);
}

export async function workspaceIntegrationNameExists(
  env: AuthEnv,
  workspaceId: string,
  integrationType: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) return false;
  return (
    stub as unknown as {
      workspaceIntegrationNameExists(
        workspaceId: string,
        integrationType: string,
        name: string,
        excludeId?: string,
      ): Promise<boolean>;
    }
  ).workspaceIntegrationNameExists(workspaceId, integrationType, name, excludeId);
}

export async function createWorkspaceIntegrationRecord(
  env: AuthEnv,
  workspaceId: string,
  id: string,
  integrationType: string,
  name: string,
  category: string,
  authMethod: string,
  config: string,
  credentialsEncrypted: string,
  createdBy: string,
  tokenExpiresAt?: number | null,
  definitionId?: string | null,
): Promise<void> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) throw new Error("Workspace not found");
  await (
    stub as unknown as {
      createWorkspaceIntegration(
        workspaceId: string,
        id: string,
        integrationType: string,
        name: string,
        category: string,
        authMethod: string,
        config: string,
        credentialsEncrypted: string,
        createdBy: string,
        tokenExpiresAt?: number | null,
        definitionId?: string | null,
      ): Promise<void>;
    }
  ).createWorkspaceIntegration(
    workspaceId,
    id,
    integrationType,
    name,
    category,
    authMethod,
    config,
    credentialsEncrypted,
    createdBy,
    tokenExpiresAt,
    definitionId,
  );
}

export async function createWorkspaceIntegrationDefinitionRecord(
  env: AuthEnv,
  workspaceId: string,
  id: string,
  slug: string,
  payload: string,
  source: string,
  sourceUrl: string | null,
  createdBy: string,
): Promise<void> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) throw new Error("Workspace not found");
  await (
    stub as unknown as {
      createWorkspaceIntegrationDefinition(
        workspaceId: string,
        id: string,
        slug: string,
        payload: string,
        source: string,
        sourceUrl: string | null,
        createdBy: string,
      ): Promise<void>;
    }
  ).createWorkspaceIntegrationDefinition(
    workspaceId,
    id,
    slug,
    payload,
    source,
    sourceUrl,
    createdBy,
  );
}

export async function getWorkspaceIntegrationDefinitionRecord(
  env: AuthEnv,
  workspaceId: string,
  id: string,
): Promise<WorkspaceIntegrationDefinitionRecord | null> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) return null;
  return (
    stub as unknown as {
      getWorkspaceIntegrationDefinition(
        workspaceId: string,
        id: string,
      ): Promise<WorkspaceIntegrationDefinitionRecord | null>;
    }
  ).getWorkspaceIntegrationDefinition(workspaceId, id);
}

export async function updateWorkspaceIntegrationRecord(
  env: AuthEnv,
  workspaceId: string,
  integrationId: string,
  updates: {
    name?: string;
    config?: string;
    credentialsEncrypted?: string;
    tokenExpiresAt?: number | null;
  },
  actorId: string,
): Promise<void> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) throw new Error("Workspace not found");
  await (
    stub as unknown as {
      updateWorkspaceIntegration(
        workspaceId: string,
        integrationId: string,
        updates: {
          name?: string;
          config?: string;
          credentialsEncrypted?: string;
          tokenExpiresAt?: number | null;
        },
        actorId: string,
      ): Promise<void>;
    }
  ).updateWorkspaceIntegration(workspaceId, integrationId, updates, actorId);
}

export async function deleteWorkspaceIntegrationRecord(
  env: AuthEnv,
  workspaceId: string,
  integrationId: string,
  actorId: string,
): Promise<void> {
  const stub = await getWorkspaceOrgStub(env, workspaceId);
  if (!stub) throw new Error("Workspace not found");
  await (
    stub as unknown as {
      deleteWorkspaceIntegration(
        workspaceId: string,
        integrationId: string,
        actorId: string,
      ): Promise<void>;
    }
  ).deleteWorkspaceIntegration(workspaceId, integrationId, actorId);
}

export async function checkUserOrphaned(
  env: AuthEnv,
  userId: string,
): Promise<boolean> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile) return false;

  const orgs = await userStub.getOrgs();
  const hasMemberships = orgs.length > 0;
  if (!hasMemberships && !profile.is_orphaned) {
    await userStub.setOrphaned(true);
    return true;
  }
  if (hasMemberships && profile.is_orphaned) {
    await userStub.setOrphaned(false);
    return false;
  }
  return profile.is_orphaned;
}

export async function handleOrphanedUserLogin(
  env: AuthEnv,
  userId: string,
): Promise<{ org: Organization; workspace: WorkspaceWithAccess } | null> {
  const userStub = env.USER.get(env.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile?.is_orphaned) return null;

  const baseName = profile.name?.trim() || "My";
  const orgName = `${baseName}'s Organization`;
  const { org, defaultWorkspaceId } = await createOrg(env, orgName, userId);

  // Get the default workspace info
  const workspace = await getWorkspace(env, defaultWorkspaceId);
  if (!workspace) {
    throw new Error("Failed to create default workspace");
  }

  await userStub.setOrphaned(false);

  return { org, workspace: { ...workspace, access_level: "full" } };
}

export async function getOrgAuditLog(
  env: AuthEnv,
  orgId: string,
  limit = 100,
  offset = 0,
): Promise<AuditLogEntry[]> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const entries = await stub.getAuditLog(limit, offset);
  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor_id: entry.actor_id,
    target_id: entry.target_id,
    details: entry.details ? JSON.parse(entry.details) : null,
    created_at: entry.created_at,
  }));
}

export async function getWorkspaceAuditLog(
  env: AuthEnv,
  workspaceId: string,
  limit = 100,
  offset = 0,
): Promise<AuditLogEntry[]> {
  const orgId = await getWorkspaceOrgId(env, workspaceId);
  if (!orgId) return [];
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const resolvedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const resolvedOffset = Math.max(0, Math.floor(offset));
  const fetchLimit = Math.min(500, resolvedLimit + resolvedOffset + 100);
  type RawAuditLogEntry = {
    id: string;
    action: string;
    actor_id: string;
    target_id: string | null;
    details: string | null;
    created_at: number;
  };
  const orgEntries = await (
    stub as unknown as {
      getWorkspaceAuditLog(
        workspaceId: string,
        limit?: number,
        offset?: number,
      ): Promise<RawAuditLogEntry[]>;
    }
  ).getWorkspaceAuditLog(workspaceId, fetchLimit, 0);
  const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const legacyEntries = await (
    workspaceStub as unknown as {
      getAuditLog(limit?: number, offset?: number): Promise<RawAuditLogEntry[]>;
    }
  ).getAuditLog(fetchLimit, 0);
  const mergedById = new Map<string, RawAuditLogEntry>();
  for (const entry of [...orgEntries, ...legacyEntries]) {
    mergedById.set(entry.id, entry);
  }
  const entries = Array.from(mergedById.values())
    .sort((a, b) => b.created_at - a.created_at)
    .slice(resolvedOffset, resolvedOffset + resolvedLimit);
  return entries.map((entry) => ({
    id: entry.id,
    action: entry.action,
    actor_id: entry.actor_id,
    target_id: entry.target_id,
    details: entry.details ? JSON.parse(entry.details) : null,
    created_at: entry.created_at,
  }));
}

// Invitation functions
export async function createInvitation(
  env: AuthEnv,
  orgId: string,
  email: string,
  role: OrgRole,
  invitedBy: string,
): Promise<{ id: string; expires_at: number }> {
  if (role === "owner") {
    throw new Error("Cannot invite as owner");
  }
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await stub.createInvitation(email, role, invitedBy);
  return { id: invitation.id, expires_at: invitation.expires_at };
}

export async function createInvitations(
  env: AuthEnv,
  orgId: string,
  emails: string[],
  role: OrgRole,
  invitedBy: string,
): Promise<Array<{ id: string; email: string; expires_at: number }>> {
  if (role === "owner") {
    throw new Error("Cannot invite as owner");
  }
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitations = await stub.createInvitations(emails, role, invitedBy);
  return invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    expires_at: invitation.expires_at,
  }));
}

export async function getInvitation(
  env: AuthEnv,
  orgId: string,
  invitationId: string,
): Promise<{
  id: string;
  email: string;
  role: OrgRole;
  org: Organization;
} | null> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await orgStub.getInvitation(invitationId);
  if (!invitation) return null;

  const orgInfo = await orgStub.getInfo();
  if (!orgInfo || orgInfo.archived) return null;

  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    org: orgInfo,
  };
}

export async function acceptInvitation(
  env: AuthEnv,
  orgId: string,
  invitationId: string,
  userId: string,
): Promise<boolean> {
  // Validate invitation exists and org is not archived
  const validatedInvitation = await getInvitation(env, orgId, invitationId);
  if (!validatedInvitation) return false;

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const acceptedInvitation = await orgStub.acceptInvitation(
    invitationId,
    userId,
  );
  if (!acceptedInvitation) return false;

  const workspaces = await listOrgWorkspaces(env, orgId);
  const lastWorkspaceId = workspaces[0]?.id ?? null;

  // Apply workspace access from invitation, or default to 'full' for all
  const presetAccess = acceptedInvitation.workspace_access;
  await Promise.all(
    workspaces.map(async (ws) => {
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(ws.id));
      const access = presetAccess?.[ws.id] ?? "full";
      await (
        orgStub as unknown as {
          setWorkspaceAccess(
            workspaceId: string,
            userId: string,
            accessLevel: WorkspaceAccessLevel,
            actorId: string,
          ): Promise<void>;
        }
      ).setWorkspaceAccess(ws.id, userId, access, userId);
      await wsStub.setMemberAccess(userId, access, userId);
    }),
  );

  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.addOrg(orgId, acceptedInvitation.role, lastWorkspaceId);
  await userStub.setOrphaned(false);

  return true;
}

export async function getOrgInvitations(
  env: AuthEnv,
  orgId: string,
): Promise<
  Array<{
    id: string;
    email: string;
    role: OrgRole;
    invited_by: string;
    created_at: number;
    expires_at: number;
    workspace_access?: Record<string, "full" | "none"> | null;
  }>
> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitations = await stub.getInvitations();
  const now = Date.now();
  return invitations
    .filter((inv) => inv.expires_at > now)
    .map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      invited_by: inv.invited_by,
      created_at: inv.created_at,
      expires_at: inv.expires_at,
      workspace_access: inv.workspace_access ?? null,
    }));
}

export async function updateInvitationWorkspaceAccess(
  env: AuthEnv,
  orgId: string,
  invitationId: string,
  workspaceId: string,
  access: "full" | "none",
): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const invitation = await stub.getInvitation(invitationId);
  if (!invitation) return false;

  const current = invitation.workspace_access ?? {};
  if (access === "full") {
    delete current[workspaceId];
  } else {
    current[workspaceId] = access;
  }

  // If all entries are removed, set to null (default = all access)
  const updated = Object.keys(current).length > 0 ? current : null;
  return stub.updateInvitationWorkspaceAccess(invitationId, updated);
}

// API Token functions
export async function validateApiToken(
  env: AuthEnv,
  tokenId: string,
): Promise<ApiTokenData | null> {
  return validateApiTokenKV(env.APP_KV, tokenId);
}

// Worker script functions
export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

// KV key prefixes
const SCRIPT_PREFIX = "script:";

/**
 * Get worker access info by dispatch script name.
 * Reads the canonical org-scoped registry entry.
 */
export async function getWorkerAccessInfo(
  env: AuthEnv,
  dispatchScriptName: string,
): Promise<WorkerScriptAccess | null> {
  const data = await env.APP_KV.get(`${SCRIPT_PREFIX}${dispatchScriptName}`);
  if (data) {
    const { org_id, is_public } = JSON.parse(data) as {
      org_id: string;
      is_public: boolean;
    };
    return {
      script_name: dispatchScriptName,
      workspace_id: "", // Not needed for access check, avoids DO lookup
      org_id,
      is_public,
    };
  }

  return null;
}

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: AppPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
  project_id: string | null;
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export async function listWorkerScriptsByWorkspace(
  env: AuthEnv,
  workspaceId: string,
): Promise<WorkerScript[]> {
  const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const info = await wsStub.getInfo();
  if (!info) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(info.org_id));
  return orgStub.listWorkerScriptsByWorkspace(workspaceId);
}

export async function getWorkerScript(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
): Promise<WorkerScript | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return stub.getWorkerScript(scriptName);
}

export async function deleteWorkerScript(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  actorId: string,
): Promise<boolean> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const result = await stub.deleteWorkerScript(scriptName, actorId);
  if (result) {
    // Get org slug to build dispatch script name
    const orgInfo = await stub.getInfo();
    const orgSlug = orgInfo?.slug;
    if (orgSlug) {
      const dispatchScriptName = `${scriptName}--${orgSlug}`;
      // Remove from new format KV index
      await env.APP_KV.delete(`${SCRIPT_PREFIX}${dispatchScriptName}`);
    }
  }
  return result;
}

export async function setWorkerScriptPublic(
  env: AuthEnv,
  orgId: string,
  scriptName: string,
  isPublic: boolean,
  actorId: string,
): Promise<WorkerScript | null> {
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  return stub.setWorkerScriptPublic(
    scriptName,
    isPublic,
    actorId,
  );
}
