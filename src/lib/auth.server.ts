import { redirect, type AppLoadContext } from "react-router";
import { getEnv } from "./cloudflare.server";
import { getSignedSessionFromRequest } from "./cookies.server";
import { redirectIfBannedSession } from "./ban.server";
import {
  createSignedSession,
  ENTERPRISE_OIDC_AUTH_SOURCE,
} from "../../workers/main/src/signed-session";
import type { OrgAuthContextBootstrap } from "../../workers/main/src/auth";
import type {
  Organization,
  OrgMembership,
  Workspace,
  WorkspaceAccessLevel,
  WorkspaceWithAccess,
} from "@/types";
import type { User } from "@/types";
import type { OnboardingPreferences } from "@/types";
import { type AuthEnv, type SessionData, getAuthEnv } from "./auth-helpers";
import {
  listUserWorkspacesAcrossOrgs,
  listOrgWorkspaces,
  getWorkspace,
} from "./auth-do";
import {
  type LlmProviderConfigRecord,
} from "./llm-provider-config";
import {
  tryCloudflareAccessSilentLogin,
  type CloudflareAccessEnv,
} from "./cloudflare-access-auth.server";
import {
  tryPomeriumSilentLogin,
  type PomeriumEnv,
} from "./pomerium-auth.server";
import {
  isProxyAuthSource,
  validateSessionMapsToOrg,
} from "../../workers/main/src/helpers/proxy-auth-providers";
import type { ProxyAuthValidationEnv } from "../../workers/main/src/helpers/proxy-auth-core";
import { retryTransientDurableObjectRead } from "./do-rpc-retry.server";
import { validateOrgSsoSession } from "../../workers/main/src/org-sso";

const LOCAL_AUTH_USER_ID = "local-dev-user";
const LOCAL_AUTH_ORG_ID = "local-dev-org";
const LOCAL_AUTH_EMAIL = "local-dev@camelai.local";
const LOCAL_AUTH_NAME = "Local Dev";

// Request-scoped cache for auth context to avoid duplicate DO RPC calls
// when multiple loaders call requireAuthContext() in the same request
const authContextCache = new WeakMap<Request, Promise<AuthContext | null>>();
const checkedSessionCache = new WeakMap<Request, Promise<SessionContext | null>>();
const uncheckedSessionCache = new WeakMap<
  Request,
  Promise<SessionContext | null>
>();

// Re-export AuthEnv and getAuthEnv for routes that need them
export { getAuthEnv, type AuthEnv } from "./auth-helpers";

export type Session = SessionData;

export interface SessionContext {
  sessionId: string;
  session: Session;
  createdSessionCookie?: string;
}

export interface UserContext extends SessionContext {
  user: User;
}

export interface AuthContext extends UserContext {
  currentOrg: Organization;
  currentWorkspace: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  onboarding: OnboardingPreferences | null;
  /** Workspaces in the current org only (for settings/management) */
  workspaces: WorkspaceWithAccess[];
  /** All workspaces across all orgs (for workspace switcher) */
  allWorkspaces: WorkspaceWithAccess[];
  /** Total workspaces in org (includes ones user may not have access to) */
  orgWorkspaceCount: number;
  /** Email verification status (bundled from UserDO bootstrap) */
  emailVerification: { required: boolean; verified: boolean };
  /** Current org LLM provider config (bundled from OrgDO bootstrap) */
  currentOrgLlmProviderConfig: LlmProviderConfigRecord | null;
  /** When set, the session cookie should be re-signed with this token (e.g. workspace fallback) */
  resignedSessionCookie?: string;
}

export interface SessionWorkspaceAccessContext extends SessionContext {
  orgId: string;
  workspaceId: string;
  userId: string;
  access: WorkspaceAccessLevel;
}

async function tryCreateProxyAuthSessionContext(
  request: Request,
  context: AppLoadContext,
  env: ReturnType<typeof getEnv>,
): Promise<SessionContext | null> {
  const authEnv = getAuthEnv(env);
  // Try each configured reverse-proxy identity provider in order. Only the
  // provider whose assertion header is present on the request returns a
  // session; the others short-circuit to null. A present-but-invalid assertion
  // throws a Response (403/503) and propagates.
  const proxySession =
    (await tryCloudflareAccessSilentLogin(
      request,
      env as unknown as CloudflareAccessEnv,
      authEnv,
    )) ??
    (await tryPomeriumSilentLogin(
      request,
      env as unknown as PomeriumEnv,
      authEnv,
    ));
  if (!proxySession) return null;

  await redirectIfBannedSession(request, context, {
    userId: proxySession.session.user_id,
    userEmail: proxySession.session.user_email,
    orgId: proxySession.session.org_id,
  });

  return {
    sessionId: `signed:${proxySession.session.user_id}`,
    session: proxySession.session,
    createdSessionCookie: proxySession.signedToken,
  };
}

/**
 * Get session from request, returns null if not authenticated.
 * Reads session data from HMAC-signed cookie, then checks UserDO
 * session invalidation to reject tokens issued before a logout.
 */
export async function getSession(
  request: Request,
  context: AppLoadContext,
): Promise<SessionContext | null> {
  const cached = checkedSessionCache.get(request);
  if (cached !== undefined) return cached;

  const promise = getSessionUncached(request, context, {
    checkInvalidation: true,
  });
  checkedSessionCache.set(request, promise);
  return promise;
}

function getUncheckedSession(
  request: Request,
  context: AppLoadContext,
): Promise<SessionContext | null> {
  const cached = uncheckedSessionCache.get(request);
  if (cached !== undefined) return cached;

  const checked = checkedSessionCache.get(request);
  if (checked !== undefined) return checked;

  const promise = getSessionUncached(request, context, {
    checkInvalidation: false,
  });
  uncheckedSessionCache.set(request, promise);
  return promise;
}

async function getSessionUncached(
  request: Request,
  context: AppLoadContext,
  options: { checkInvalidation: boolean },
): Promise<SessionContext | null> {
  const env = getEnv(context);
  const localBypassSession = await getLocalAuthBypassSession(request, context);
  if (localBypassSession) {
    return localBypassSession;
  }

  const signedSession = await getSignedSessionFromRequest(
    request,
    env.TOKEN_SIGNING_SECRET,
  );
  if (!signedSession) {
    return tryCreateProxyAuthSessionContext(request, context, env);
  }

  if (!(await validateOrgSsoSession(env, signedSession))) {
    return null;
  }

  if (isProxyAuthSource(signedSession.auth_source)) {
    // Read-only revalidation: confirm the live proxy identity still maps to
    // the session org without re-running the mutating provisioning flow when
    // the cookie still matches. If it no longer matches, immediately run the
    // silent login path so the current identity can replace the stale signed
    // cookie.
    const proxyValidation = await validateSessionMapsToOrg(
      request,
      env as unknown as ProxyAuthValidationEnv,
      signedSession,
    );
    if (proxyValidation === "unavailable") {
      throw new Response(
        "Identity proxy validation is temporarily unavailable",
        { status: 503 },
      );
    }
    if (proxyValidation !== "valid") {
      return tryCreateProxyAuthSessionContext(request, context, env);
    }
  }

  await redirectIfBannedSession(request, context, {
    userId: signedSession.user_id,
    userEmail: signedSession.user_email,
    orgId: signedSession.org_id,
  });

  if (options.checkInvalidation) {
    // Check if this session was created before a logout invalidation.
    const authEnv = getAuthEnv(env);
    const userStub = authEnv.USER.get(
      authEnv.USER.idFromName(signedSession.user_id),
    );
    const invalidatedAt = await retryTransientDurableObjectRead(
      "UserDO.getSessionInvalidatedAt",
      () => userStub.getSessionInvalidatedAt(),
    );
    if (invalidatedAt && signedSession.created_at < invalidatedAt) {
      return null;
    }
  }

  // Map signed session data to SessionData format (compatible with existing code)
  const session: SessionData = {
    user_id: signedSession.user_id,
    org_id: signedSession.org_id,
    workspace_id: signedSession.workspace_id,
    created_at: signedSession.created_at,
    last_accessed: signedSession.created_at,
    expires_at: signedSession.expires_at,
    sso_connection_id: signedSession.sso_connection_id,
    sso_config_version: signedSession.sso_config_version,
    user_name: signedSession.user_name,
    user_email: signedSession.user_email,
    auth_source: signedSession.auth_source ?? null,
  };

  // sessionId is a placeholder — with signed cookies, the cookie IS the session
  return { sessionId: `signed:${signedSession.user_id}`, session };
}

function getRuntimeEnvValue(
  env: Record<string, unknown>,
  key: string,
): string | undefined {
  const bindingValue = env[key];
  if (typeof bindingValue === "string") return bindingValue;

  const processEnv = (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  return processEnv?.[key];
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalhostRequest(request: Request, extraHosts?: string): boolean {
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  return (extraHosts || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .includes(hostname.toLowerCase());
}

async function getLocalAuthBypassSession(
  request: Request,
  context: AppLoadContext,
): Promise<SessionContext | null> {
  const env = getEnv(context);
  if (
    !envFlagEnabled(
      getRuntimeEnvValue(
        env as unknown as Record<string, unknown>,
        "LOCAL_AUTH_BYPASS",
      ),
    ) ||
    !isLocalhostRequest(
      request,
      getRuntimeEnvValue(
        env as unknown as Record<string, unknown>,
        "LOCAL_AUTH_BYPASS_HOSTS",
      ),
    )
  ) {
    return null;
  }

  const authEnv = getAuthEnv(env);
  const email =
    getRuntimeEnvValue(
      env as unknown as Record<string, unknown>,
      "LOCAL_AUTH_USER_EMAIL",
    ) ??
    LOCAL_AUTH_EMAIL;
  const name =
    getRuntimeEnvValue(
      env as unknown as Record<string, unknown>,
      "LOCAL_AUTH_USER_NAME",
    ) ??
    LOCAL_AUTH_NAME;

  const userStub = authEnv.USER.get(authEnv.USER.idFromName(LOCAL_AUTH_USER_ID));
  let profile = await userStub.getProfile();
  if (!profile) {
    await authEnv.EMAIL_TO_USER.put(
      `email:${email.toLowerCase()}`,
      LOCAL_AUTH_USER_ID,
    );
    await authEnv.EMAIL_TO_USER.put(
      "oauth:github:local-dev",
      LOCAL_AUTH_USER_ID,
    );
    profile = await userStub.createUserFromOAuth(
      LOCAL_AUTH_USER_ID,
      email.toLowerCase(),
      name,
      "github",
      "local-dev",
    );
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(LOCAL_AUTH_ORG_ID));
  let orgInfo: Organization | null = await orgStub.getInfo();
  let workspaceId: string | null = null;

  if (!orgInfo) {
    const created = await orgStub.createOrg(
      LOCAL_AUTH_ORG_ID,
      "Local Dev",
      LOCAL_AUTH_USER_ID,
    );
    orgInfo = created.org;
    workspaceId = created.defaultWorkspaceId;
    await userStub.addOrg(LOCAL_AUTH_ORG_ID, "owner", workspaceId);
  } else {
    const workspaces = await orgStub.getWorkspaces();
    workspaceId =
      workspaces.find((workspace) => !workspace.archived)?.id ?? null;

    if (!(await orgStub.isMember(LOCAL_AUTH_USER_ID))) {
      await orgStub.addMember(LOCAL_AUTH_USER_ID, "owner", LOCAL_AUTH_USER_ID);
    }
    if (!(await userStub.hasOrg(LOCAL_AUTH_ORG_ID))) {
      await userStub.addOrg(LOCAL_AUTH_ORG_ID, "owner", workspaceId);
    }
  }

  if (!orgInfo) {
    return null;
  }

  if (orgInfo.billing_status !== "enterprise") {
    orgInfo = await orgStub.updateBillingState({
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_seat_count: Math.max(orgInfo.billing_seat_count ?? 1, 1),
    });
    if (!orgInfo) {
      return null;
    }
  }

  if (workspaceId) {
    const workspaceStub = authEnv.WORKSPACE.get(
      authEnv.WORKSPACE.idFromName(workspaceId),
    );
    await (
      orgStub as unknown as {
        setWorkspaceAccess(
          workspaceId: string,
          userId: string,
          accessLevel: WorkspaceAccessLevel,
          actorId: string,
        ): Promise<void>;
      }
    ).setWorkspaceAccess(
      workspaceId,
      LOCAL_AUTH_USER_ID,
      "full",
      LOCAL_AUTH_USER_ID,
    );
    await workspaceStub.setMemberAccess(
      LOCAL_AUTH_USER_ID,
      "full",
      LOCAL_AUTH_USER_ID,
    );
    await userStub.setOrgLastWorkspace(LOCAL_AUTH_ORG_ID, workspaceId);
  }

  const onboarding = await userStub.getOnboarding();
  if (!onboarding?.completed_at) {
    await userStub.updateOnboarding({ completed_at: Date.now() });
  }

  const now = Date.now();
  return {
    sessionId: "local-dev",
    session: {
      user_id: profile.id,
      org_id: orgInfo.id,
      workspace_id: workspaceId,
      created_at: now,
      last_accessed: now,
      user_name: profile.name,
      user_email: profile.email,
    },
  };
}

async function getOrgAuthContextBootstrap(
  orgStub: ReturnType<AuthEnv["ORG"]["get"]>,
  userId: string,
): Promise<OrgAuthContextBootstrap> {
  return retryTransientDurableObjectRead(
    "OrgDO.getAuthContextBootstrap",
    () =>
      (
        orgStub as unknown as {
          getAuthContextBootstrap(
            userId: string,
          ): Promise<OrgAuthContextBootstrap>;
        }
      ).getAuthContextBootstrap(userId),
  );
}

async function getWorkspaceAccessBootstrap(
  orgStub: ReturnType<AuthEnv["ORG"]["get"]>,
  workspaceId: string,
  userId: string,
): Promise<{
  workspaceInfo: Workspace | null;
  access: WorkspaceAccessLevel;
}> {
  const result = await retryTransientDurableObjectRead(
    "OrgDO.getWorkspaceAccessContext",
    () =>
      (
        orgStub as unknown as {
          getWorkspaceAccessContext(
            workspaceId: string,
            userId: string,
          ): Promise<{ workspace: Workspace | null; access: WorkspaceAccessLevel }>;
        }
      ).getWorkspaceAccessContext(workspaceId, userId),
  );
  return {
    workspaceInfo: result.workspace,
    access: result.access,
  };
}

/**
 * Require authentication - redirects to login if not authenticated
 */
export async function requireSession(
  request: Request,
  context: AppLoadContext,
): Promise<SessionContext> {
  const sessionContext = await getSession(request, context);

  if (!sessionContext) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  return sessionContext;
}

/**
 * Require workspace access using session + targeted DO checks (no full auth context).
 */
export async function requireSessionWorkspaceAccess(
  request: Request,
  context: AppLoadContext,
  workspaceIdOverride?: string,
  options: { requireWrite?: boolean } = {},
): Promise<SessionWorkspaceAccessContext> {
  const sessionContext = await requireSession(request, context);
  const { session } = sessionContext;
  const orgId = session.org_id;
  const workspaceId = workspaceIdOverride ?? session.workspace_id;
  const userId = session.user_id;

  if (!orgId) {
    throw Response.json({ error: "No organization selected" }, { status: 400 });
  }
  if (!workspaceId) {
    throw Response.json({ error: "No workspace selected" }, { status: 400 });
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));

  const [workspaceAccess, isMember] = await Promise.all([
    getWorkspaceAccessBootstrap(orgStub, workspaceId, userId),
    orgStub.isMember(userId),
  ]);
  const { workspaceInfo, access } = workspaceAccess;

  if (
    !workspaceInfo ||
    workspaceInfo.archived ||
    workspaceInfo.org_id !== orgId
  ) {
    throw Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (!isMember) {
    throw Response.json({ error: "Workspace not found" }, { status: 404 });
  }

  if (access === "none") {
    throw Response.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (options.requireWrite && access !== "full") {
    throw Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return {
    ...sessionContext,
    orgId,
    workspaceId,
    userId,
    access,
  };
}

/**
 * Get user context (session + user profile)
 */
export async function getUserContext(
  request: Request,
  context: AppLoadContext,
): Promise<UserContext | null> {
  const sessionContext = await getSession(request, context);
  if (!sessionContext) return null;

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const profile = await retryTransientDurableObjectRead(
    "UserDO.getProfile",
    () =>
      authEnv.USER.get(
        authEnv.USER.idFromName(sessionContext.session.user_id),
      ).getProfile(),
  );
  if (!profile) return null;

  return {
    ...sessionContext,
    user: profile,
  };
}

/**
 * Require user context - redirects to login if not authenticated
 */
export async function requireUserContext(
  request: Request,
  context: AppLoadContext,
): Promise<UserContext> {
  const userContext = await getUserContext(request, context);

  if (!userContext) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  return userContext;
}

/**
 * Get full auth context including org, workspace, and memberships.
 * Uses request-scoped caching to avoid duplicate DO RPC calls when
 * multiple loaders call this in the same request.
 */
export async function getAuthContext(
  request: Request,
  context: AppLoadContext,
): Promise<AuthContext | null> {
  // Check cache first - returns the same promise if already in flight
  const cached = authContextCache.get(request);
  if (cached !== undefined) {
    return cached;
  }

  // Create and cache the promise immediately to dedupe concurrent calls
  const promise = getAuthContextUncached(request, context);
  authContextCache.set(request, promise);
  return promise;
}

/**
 * Internal uncached implementation of getAuthContext
 */
async function getAuthContextUncached(
  request: Request,
  context: AppLoadContext,
): Promise<AuthContext | null> {
  // getAuthBootstrap() below includes sessionInvalidatedAt, so this path
  // avoids an extra UserDO.getSessionInvalidatedAt() RPC per full auth load.
  const sessionContext = await getUncheckedSession(request, context);
  if (!sessionContext) {
    console.warn("[auth] getAuthContext returning null: no session");
    return null;
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(sessionContext.session.user_id),
  );
  const currentOrgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(sessionContext.session.org_id),
  );
  const [authBootstrap, currentOrgBootstrap] = await Promise.all([
    retryTransientDurableObjectRead("UserDO.getAuthBootstrap", () =>
      userStub.getAuthBootstrap(),
    ),
    getOrgAuthContextBootstrap(
      currentOrgStub,
      sessionContext.session.user_id,
    ),
  ]);
  const {
    info: orgInfo,
    member: currentOrgMember,
    workspaces: currentOrgWorkspaces,
    llmProviderConfig: currentOrgLlmProviderConfig,
  } = currentOrgBootstrap;
  const profile = authBootstrap.profile;
  if (!profile) {
    console.warn("[auth] getAuthContext returning null: profile is null", {
      user_id: sessionContext.session.user_id,
      org_id: sessionContext.session.org_id,
      workspace_id: sessionContext.session.workspace_id,
    });
    return null;
  }
  if (!orgInfo) {
    console.warn("[auth] getAuthContext returning null: orgInfo is null", {
      user_id: sessionContext.session.user_id,
      org_id: sessionContext.session.org_id,
    });
    return null;
  }

  // Check if this session was created before a logout invalidation
  if (
    authBootstrap.sessionInvalidatedAt &&
    sessionContext.session.created_at < authBootstrap.sessionInvalidatedAt
  ) {
    console.warn("[auth] getAuthContext returning null: session invalidated", {
      user_id: sessionContext.session.user_id,
      session_created_at: sessionContext.session.created_at,
      invalidated_at: authBootstrap.sessionInvalidatedAt,
    });
    return null;
  }
  const currentOrg: Organization = orgInfo;
  const onboarding = authBootstrap.onboarding;
  // Build the membership list straight from the already-loaded bootstrap, WITHOUT
  // a per-org ORG.getInfo() RPC. Those RPCs (one per org, only to fetch each
  // org's name + archived flag) dominated auth latency on every authenticated
  // page load — a single cold OrgDO could stall the whole request ~1.4s. The
  // critical path only needs the current org's name; the workspace switcher
  // lazy-loads the full named/archived-filtered list via GET /api/orgs. Other
  // consumers use org_id/role only. (Archived orgs the user still belongs to may
  // appear here until the switcher's lazy fetch filters them — a benign cosmetic
  // edge; current-org permissions are always correct.)
  let orgs: OrgMembership[] = authBootstrap.orgs.map((membership) => ({
    org_id: membership.org_id,
    org_name: membership.org_id === currentOrg.id ? currentOrg.name : "",
    role: membership.role,
    joined_at: membership.joined_at,
    last_workspace_id: membership.last_workspace_id ?? null,
  }));

  // OrgDO is the source of truth for role checks. If UserDO role data is stale
  // for the active org, reconcile it in-memory so current request permissions/UI
  // reflect the effective org role.
  if (currentOrgMember) {
    const currentOrgIndex = orgs.findIndex(
      (membership) => membership.org_id === currentOrg.id,
    );
    if (currentOrgIndex === -1) {
      orgs = [
        ...orgs,
        {
          org_id: currentOrg.id,
          org_name: currentOrg.name,
          role: currentOrgMember.role,
          joined_at: currentOrgMember.joined_at,
          last_workspace_id: null,
        },
      ];
    } else if (orgs[currentOrgIndex].role !== currentOrgMember.role) {
      orgs = orgs.map((membership, index) =>
        index === currentOrgIndex
          ? {
              ...membership,
              role: currentOrgMember.role,
            }
          : membership,
      );
    }
  }

  if (sessionContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE) {
    orgs = orgs.filter((membership) => membership.org_id === currentOrg.id);
  }

  const userContext: UserContext = {
    ...sessionContext,
    user: profile,
  };

  // Get all workspaces across all orgs (for workspace switcher).
  let allWorkspaces = await listUserWorkspacesAcrossOrgs(
    authEnv,
    sessionContext.session.user_id,
    orgs,
    {
      preloadedWorkspacesByOrgId: new Map([
        [currentOrg.id, currentOrgWorkspaces],
      ]),
    },
  );

  // Workspaces in the current org only (for settings/management).
  // Derive from allWorkspaces to avoid duplicate current-org RPC traversal.
  let workspaces = allWorkspaces.filter((ws) => ws.org_id === currentOrg.id);

  // Check if org has workspaces the user can't access (only when user has none)
  let orgWorkspaceCount = workspaces.length;
  if (workspaces.length === 0) {
    try {
      const allOrgWorkspaces = await listOrgWorkspaces(authEnv, currentOrg.id);
      orgWorkspaceCount = allOrgWorkspaces.length;
    } catch (error) {
      console.warn("[auth] failed to count current org workspaces", {
        user_id: sessionContext.session.user_id,
        org_id: currentOrg.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Select current workspace - must be from current org to maintain consistency
  // If no workspaces in current org, currentWorkspace will be null and UI shows NoWorkspacesError
  const sessionWorkspaceId = sessionContext.session.workspace_id;
  let sessionWorkspaceStillValid = sessionWorkspaceId
    ? workspaces.some((ws) => ws.id === sessionWorkspaceId)
    : false;

  if (sessionWorkspaceId && !sessionWorkspaceStillValid) {
    try {
      const sessionWorkspace = await getWorkspace(authEnv, sessionWorkspaceId);
      if (sessionWorkspace?.org_id === currentOrg.id) {
        const accessLevel = await retryTransientDurableObjectRead(
          "OrgDO.getWorkspaceAccess",
          () =>
            (
              currentOrgStub as unknown as {
                getWorkspaceAccess(
                  workspaceId: string,
                  userId: string,
                ): Promise<WorkspaceAccessLevel>;
              }
            ).getWorkspaceAccess(
              sessionWorkspaceId,
              sessionContext.session.user_id,
            ),
        );
        if (accessLevel !== "none") {
          const workspaceWithAccess: WorkspaceWithAccess = {
            ...sessionWorkspace,
            access_level: accessLevel,
          };
          allWorkspaces = [
            ...allWorkspaces.filter((ws) => ws.id !== workspaceWithAccess.id),
            workspaceWithAccess,
          ];
          workspaces = [
            ...workspaces.filter((ws) => ws.id !== workspaceWithAccess.id),
            workspaceWithAccess,
          ];
          orgWorkspaceCount = Math.max(orgWorkspaceCount, workspaces.length);
          sessionWorkspaceStillValid = true;
        }
      }
    } catch (error) {
      console.warn("[auth] failed to load session workspace fallback", {
        user_id: sessionContext.session.user_id,
        org_id: currentOrg.id,
        workspace_id: sessionWorkspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const currentWorkspace = sessionWorkspaceStillValid
    ? workspaces.find((ws) => ws.id === sessionWorkspaceId)!
    : (workspaces[0] ?? null);

  // Re-sign session cookie if workspace changed (stale session or fallback)
  const newWorkspaceId = currentWorkspace?.id ?? null;
  let resignedSessionCookie: string | undefined =
    sessionContext.createdSessionCookie;
  if (newWorkspaceId !== sessionWorkspaceId) {
    resignedSessionCookie = await createSignedSession(
      env.TOKEN_SIGNING_SECRET,
      {
        user_id: sessionContext.session.user_id,
        org_id: sessionContext.session.org_id,
        workspace_id: newWorkspaceId,
        created_at: sessionContext.session.created_at,
        expires_at: sessionContext.session.expires_at,
        sso_connection_id: sessionContext.session.sso_connection_id,
        sso_config_version: sessionContext.session.sso_config_version,
        user_name: sessionContext.session.user_name,
        user_email: sessionContext.session.user_email,
        auth_source: sessionContext.session.auth_source ?? null,
      },
    );
  }

  return {
    ...userContext,
    currentOrg,
    currentWorkspace,
    orgs,
    onboarding,
    workspaces,
    allWorkspaces,
    orgWorkspaceCount,
    emailVerification: authBootstrap.emailVerification,
    currentOrgLlmProviderConfig,
    resignedSessionCookie,
  };
}

/**
 * Require full auth context - redirects to login if not authenticated
 */
export async function requireAuthContext(
  request: Request,
  context: AppLoadContext,
): Promise<AuthContext> {
  const authContext = await getAuthContext(request, context);

  if (!authContext) {
    const url = new URL(request.url);
    const redirectTo = encodeURIComponent(url.pathname + url.search);
    throw redirect(`/login?redirect=${redirectTo}`);
  }

  return authContext;
}

export function canUseSuperuserAccess(
  context: Pick<UserContext, "user" | "session">,
): boolean {
  return Boolean(
    context.user.is_superuser &&
      context.user.email_verified_at != null &&
      context.session.auth_source !== ENTERPRISE_OIDC_AUTH_SOURCE,
  );
}

/**
 * Require superuser access - redirects to home if not a superuser
 */
export async function requireSuperuser(
  request: Request,
  context: AppLoadContext,
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);

  if (!canUseSuperuserAccess(authContext)) {
    throw redirect("/");
  }

  return authContext;
}

// TODO: Viewer role (deferred): When viewer role enforcement is added, route guards
// should deny viewers access to chat, connections, and any write operations.
// Viewers should only be able to view workspace apps (including private/unpublished ones).
// See the OrgRole type in types.ts for the full planned behavior.

/**
 * Require org admin access
 */
export async function requireOrgAdmin(
  request: Request,
  context: AppLoadContext,
  orgId: string,
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);
  if (
    authContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE &&
    authContext.session.org_id !== orgId
  ) {
    throw redirect("/");
  }

  const userOrg = authContext.orgs.find((o) => o.org_id === orgId);
  const cachedIsAdmin = userOrg?.role === "owner" || userOrg?.role === "admin";

  if (cachedIsAdmin) {
    return authContext;
  }

  // Fallback to OrgDO authority when UserDO org role data is stale.
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const effectiveIsAdmin = await orgStub.isAdmin(authContext.user.id);

  if (!effectiveIsAdmin) {
    throw redirect("/");
  }

  return authContext;
}

/**
 * Require workspace access
 */
export async function requireWorkspaceAccess(
  request: Request,
  context: AppLoadContext,
  workspaceId: string,
  requiredLevel: "full" | "any" = "any",
): Promise<AuthContext> {
  const authContext = await requireAuthContext(request, context);

  // Check if workspace exists in user's accessible workspaces
  const workspace = authContext.allWorkspaces.find(
    (ws) => ws.id === workspaceId,
  );
  if (
    !workspace ||
    (authContext.session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE &&
      workspace.org_id !== authContext.session.org_id)
  ) {
    throw redirect("/");
  }

  const env = getEnv(context);
  const orgStub = env.ORG.get(env.ORG.idFromName(workspace.org_id));
  const accessLevel = await retryTransientDurableObjectRead(
    "OrgDO.getWorkspaceAccess",
    () =>
      (
        orgStub as unknown as {
          getWorkspaceAccess(
            workspaceId: string,
            userId: string,
          ): Promise<WorkspaceAccessLevel>;
        }
      ).getWorkspaceAccess(workspaceId, authContext.user.id),
  );

  if (accessLevel === "none") {
    throw redirect("/");
  }

  if (requiredLevel === "full" && accessLevel !== "full") {
    throw redirect("/");
  }

  return authContext;
}
