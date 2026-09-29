/**
 * Authentication and authorization helpers
 */

import type { Env } from "../types.js";
import type { SessionData } from "../session-kv.js";
import type { WorkspaceDO } from "../workspace.js";
import type { OrgDO, UserDO } from "../auth.js";
import { getSignedSessionFromRequest } from "../cookies.js";
import { text } from "./response.js";
import { isOrgBanned, isUserBanned } from "../ban-list.js";
import { validateSessionMapsToOrg } from "./proxy-auth-providers.js";
import {
  isDegradableChatWebSocketAuthError,
  retryTransientDurableObjectRpc,
} from "../../../../src/lib/do-rpc-retry.server";
import { validateOrgSsoSession } from "../org-sso.js";

export type AuthResult = { session: SessionData } | { error: Response };

// Per-RPC budget for the chat WS auth chain. Client connectionTimeout is 20s;
// at most three sequential timed phases (UserDO invalidation, workspace→org
// resolution, one OrgDO validation) × two 2.5s attempts stay below that bound,
// including the short retry delays.
const CHAT_WS_AUTH_RPC_TIMEOUT_MS = 2_500;
const CHAT_WS_AUTH_RPC_ATTEMPTS = 2;

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

