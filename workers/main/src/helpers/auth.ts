/**
 * Authentication and authorization helpers
 */

import type { Env } from "../types.js";
import type { SessionData } from "../session-kv.js";
import type { WorkspaceDO } from "../workspace.js";
import type { OrgDO, UserDO } from "../auth.js";
import { getSignedSessionFromRequest } from "../cookies.js";
import { text } from "./response.js";
import { getWorkspaceStub, getOrgStub } from "./stubs.js";
import { isOrgBanned, isUserBanned } from "../ban-list.js";
import { validateSessionMapsToOrg } from "./proxy-auth-providers.js";
import {
  isDegradableChatWebSocketAuthError,
  retryTransientDurableObjectRpc,
} from "../../../../src/lib/do-rpc-retry.server";
import { getAppIndexReadDatabase } from "../app-index-db.js";
import { validateOrgSsoSession } from "../org-sso.js";
import { ENTERPRISE_OIDC_AUTH_SOURCE } from "../signed-session.js";

export type AuthResult = { session: SessionData } | { error: Response };

// Per-RPC budget for the chat WS auth chain. Client connectionTimeout is 20s;
// at most three sequential timed phases (UserDO invalidation, workspace→org
// resolution, one OrgDO validation) × two 2.5s attempts stay below that bound,
// including the short retry delays.
const CHAT_WS_AUTH_RPC_TIMEOUT_MS = 2_500;
const CHAT_WS_AUTH_RPC_ATTEMPTS = 2;
const WORKSPACE_ORG_INDEX_PREFIX = "workspace_org:";

async function getWorkspaceOrgId(
  env: Env,
  workspaceId: string,
): Promise<string | null> {
  const indexed = await env.APP_KV.get(`${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`);
  if (indexed) return indexed;
  const appIndex = getAppIndexReadDatabase(env);
  const orgId = appIndex ? await appIndex.getWorkspaceOrgId(workspaceId) : null;
  if (orgId) {
    await env.APP_KV.put(`${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`, orgId);
  }
  return orgId;
}

class ChatWebSocketAuthRpcTimeoutError extends Error {
  // Picked up by isTransientDurableObjectRpcError so timeouts retry and
  // degrade like dropped RPC channels instead of failing closed.
  retryable = true;

  constructor(operation: string) {
    super(`Durable Object RPC timed out: ${operation}`);
    this.name = "ChatWebSocketAuthRpcTimeoutError";
  }
}

function chatWsAuthRpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return retryTransientDurableObjectRpc(
    operation,
    () => {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new ChatWebSocketAuthRpcTimeoutError(operation));
        }, CHAT_WS_AUTH_RPC_TIMEOUT_MS);
        fn().then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
    { attempts: CHAT_WS_AUTH_RPC_ATTEMPTS, initialDelayMs: 50 },
  );
}

const LOCAL_AUTH_USER_ID = "local-dev-user";
const LOCAL_AUTH_ORG_ID = "local-dev-org";
const LOCAL_AUTH_EMAIL = "local-dev@camelai.local";
const LOCAL_AUTH_NAME = "Local Dev";

export async function requireSession(
  req: Request,
  env: Env,
  options: { failOpenOnInvalidationCheckError?: boolean } = {},
): Promise<AuthResult> {
  const localBypassSession = await getLocalAuthBypassSession(req, env);
  if (localBypassSession) {
    return { session: localBypassSession };
  }

  const signedSession = await getSignedSessionFromRequest(
    req,
    env.TOKEN_SIGNING_SECRET,
  );
  if (!signedSession) return { error: text("Unauthorized", 401) };
  if (!(await validateOrgSsoSession(env, signedSession))) {
    return { error: text("Unauthorized", 401) };
  }
  const proxyValidation = await validateSessionMapsToOrg(req, env, signedSession);
  if (proxyValidation === "unavailable") {
    return {
      error: text("Identity proxy validation is temporarily unavailable", 503),
    };
  }
  if (proxyValidation !== "valid") {
    return { error: text("Unauthorized", 401) };
  }

  const [userBan, orgBan] = await Promise.all([
    isUserBanned(env.APP_KV, {
      userId: signedSession.user_id,
      email: signedSession.user_email,
    }),
    signedSession.org_id
      ? isOrgBanned(env.APP_KV, { orgId: signedSession.org_id })
      : Promise.resolve(null),
  ]);
  if (userBan || orgBan) {
    return { error: text("Blocked", 403) };
  }

  // Check if this session was created before a logout invalidation
  const userNs = env.USER as DurableObjectNamespace<UserDO>;
  let invalidatedAt: number | null;
  if (options.failOpenOnInvalidationCheckError) {
    try {
      invalidatedAt = await chatWsAuthRpc("UserDO.getSessionInvalidatedAt", () =>
        userNs
          .get(userNs.idFromName(signedSession.user_id))
          .getSessionInvalidatedAt(),
      );
    } catch (error) {
      if (!isDegradableChatWebSocketAuthError(error)) {
        // Only DO unavailability/overload justifies failing open; an application
        // error must keep the pre-existing fail-closed behavior, or a
        // "log out everywhere" revocation would be ignored until the bug
        // is fixed.
        throw error;
      }
      // Fail open: the session cookie signature was already verified locally.
      // This check only enforces "log out everywhere" revocation, and blocking
      // every chat connection during a transient DO outage is worse than
      // honoring a signed session for the duration of the blip.
      invalidatedAt = null;
    }
  } else {
    invalidatedAt = await userNs
      .get(userNs.idFromName(signedSession.user_id))
      .getSessionInvalidatedAt();
  }
  if (invalidatedAt && signedSession.created_at < invalidatedAt) {
    return { error: text("Unauthorized", 401) };
  }

  // Map to SessionData format for compatibility
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

  return { session };
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isLocalhostRequest(req: Request, extraHosts?: string): boolean {
  const hostname = new URL(req.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  return (extraHosts || "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .includes(hostname.toLowerCase());
}

async function getLocalAuthBypassSession(
  req: Request,
  env: Env,
): Promise<SessionData | null> {
  if (!envFlagEnabled(env.LOCAL_AUTH_BYPASS) || !isLocalhostRequest(req, env.LOCAL_AUTH_BYPASS_HOSTS)) {
    return null;
  }

  const email = (env.LOCAL_AUTH_USER_EMAIL || LOCAL_AUTH_EMAIL).toLowerCase();
  const name = env.LOCAL_AUTH_USER_NAME || LOCAL_AUTH_NAME;
  const userNs = env.USER as DurableObjectNamespace<UserDO>;
  const orgNs = env.ORG as DurableObjectNamespace<OrgDO>;
  const workspaceNs = env.WORKSPACE as DurableObjectNamespace<WorkspaceDO>;

  const userStub = userNs.get(userNs.idFromName(LOCAL_AUTH_USER_ID));
  let profile = await userStub.getProfile();
  if (!profile) {
    await env.EMAIL_TO_USER.put(`email:${email}`, LOCAL_AUTH_USER_ID);
    await env.EMAIL_TO_USER.put("oauth:github:local-dev", LOCAL_AUTH_USER_ID);
    profile = await userStub.createUserFromOAuth(
      LOCAL_AUTH_USER_ID,
      email,
      name,
      "github",
      "local-dev",
    );
  }

  const orgStub = orgNs.get(orgNs.idFromName(LOCAL_AUTH_ORG_ID));
  let orgInfo = await orgStub.getInfo();
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

  if (workspaceId) {
    const workspaceStub = workspaceNs.get(workspaceNs.idFromName(workspaceId));
    await orgStub.setWorkspaceAccess(
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

  if (orgInfo.billing_status !== "enterprise") {
    const updatedOrgInfo = await orgStub.updateBillingState({
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_seat_count: Math.max(orgInfo.billing_seat_count ?? 1, 1),
    });
    if (!updatedOrgInfo) {
      return null;
    }
    orgInfo = updatedOrgInfo;
  }

  const onboarding = await userStub.getOnboarding();
  if (!onboarding?.completed_at) {
    await userStub.updateOnboarding({ completed_at: Date.now() });
  }

  const now = Date.now();
  return {
    user_id: profile.id,
    org_id: orgInfo.id,
    workspace_id: workspaceId,
    created_at: now,
    last_accessed: now,
    user_name: profile.name,
    user_email: profile.email,
  };
}

export interface ChatWebSocketAccess {
  session: SessionData;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  userId: string;
  wsStub: WorkspaceDO;
  threadId: string;
}

/**
 * Returned when the user has a valid signed session but the authorization
 * Durable Objects (WorkspaceDO/OrgDO) were unreachable after retries. The
 * route may forward the upgrade to ChatThreadDO marked as degraded; the DO
 * only admits users it has previously seen pass full authorization for the
 * same thread.
 */
export interface ChatWebSocketDegradedAccess {
  degraded: true;
  session: SessionData;
  userId: string;
  threadId: string;
}

export type ChatWebSocketAccessResult =
  | ChatWebSocketAccess
  | ChatWebSocketDegradedAccess
  | { error: Response };

export async function requireChatWebSocketAccess(
  req: Request,
  env: Env,
  threadId: string,
  workspaceIdFromUrl?: string | null,
): Promise<ChatWebSocketAccessResult> {
  const auth = await requireSession(req, env, {
    failOpenOnInvalidationCheckError: true,
  });
  if ("error" in auth) return auth;

  const { session } = auth;
  const { org_id: sessionOrgId, user_id: userId } = session;

  // Authorize against the workspace the tab is actually connected to, not the
  // session's currently-selected workspace.
  // The session selection is a shared per-browser cookie that other tabs
  // mutate; using it here breaks open threads in other workspaces/orgs.
  const workspaceId =
    workspaceIdFromUrl?.trim() || session.workspace_id || "";
  if (!workspaceId) {
    return { error: text("No workspace selected", 400) };
  }

  try {
    const wsStub = getWorkspaceStub(env, workspaceId);
    const resolvedOrgId = await chatWsAuthRpc(
      "workspace_org_index.get",
      () => getWorkspaceOrgId(env, workspaceId),
    );
    const workspaceOrgId = resolvedOrgId || sessionOrgId;
    if (
      session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE &&
      workspaceOrgId !== sessionOrgId
    ) {
      return { error: text("Forbidden", 403) };
    }
    const orgStub = getOrgStub(env, workspaceOrgId);
    const orgValidation = await chatWsAuthRpc(
      "OrgDO.validateChatWebSocketAccess",
      () => orgStub.validateChatWebSocketAccess(userId, workspaceId, threadId),
    );

    if (!orgValidation.ok) {
      switch (orgValidation.reason) {
        case "org_not_found":
        case "workspace_not_found":
          return { error: text("Workspace not found", 404) };
        case "thread_not_found":
          return { error: text("Thread not found", 404) };
        case "forbidden":
        default:
          return { error: text("Forbidden", 403) };
      }
    }

    return {
      session,
      orgId: orgValidation.orgId,
      orgSlug: orgValidation.orgSlug,
      workspaceId: orgValidation.workspaceId,
      userId,
      wsStub,
      threadId: orgValidation.threadId,
    };
  } catch (error) {
    if (isDegradableChatWebSocketAuthError(error)) {
      // The authorization DOs are unreachable or overloaded, not denying
      // access. Fall back to degraded auth: the session is verified, and
      // ChatThreadDO will only admit users it has already seen pass full
      // authorization.
      return { degraded: true, session, userId, threadId };
    }
    // Unknown/application errors are not authoritative denials. Return 503 so
    // the upgrade path closes with reconnectable 1013 instead of terminal 4403
    // (which would permanently kill tabs during a bad deploy window).
    return { error: text("Authorization temporarily unavailable", 503) };
  }
}
