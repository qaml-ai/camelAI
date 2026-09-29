import type { Route } from "./+types/auth.switch-org";
import { getEnv, type CloudflareEnv } from "@/lib/cloudflare.server";
import {
  createSessionCookieHeader,
  getRemainingSessionCookieMaxAge,
} from "@/lib/cookies.server";
import { type AuthEnv } from "@/lib/auth-helpers";
import { getSession } from "@/lib/auth.server";
import {
  isOrgMember,
  listUserWorkspaces,
  switchSessionOrg,
} from "@/lib/auth-do";
import { getBanForSessionIdentifiers } from "@/lib/ban.server";
import { requireAccessMappedOrg } from "@/lib/cloudflare-access-auth.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv["USER"],
    ORG: env.ORG as AuthEnv["ORG"],
    WORKSPACE: env.WORKSPACE as AuthEnv["WORKSPACE"],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
  };
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    const sessionContext = await getSession(request, context);
    if (!sessionContext) {
      return Response.json({ error: "Not authenticated" }, { status: 401 });
    }
    const session = sessionContext.session;

    const existingBan = await getBanForSessionIdentifiers(context, {
      userId: session.user_id,
      userEmail: session.user_email,
      orgId: session.org_id,
    });
    if (existingBan) {
      return Response.json(
        { error: "This account has been blocked.", redirect: "/banned" },
        { status: 403 },
      );
    }

    const body = (await request.json()) as { orgId?: string };
    const { orgId } = body;

    if (!orgId) {
      return Response.json(
        { error: "Organization ID is required" },
        { status: 400 },
      );
    }

    const nextOrgBan = await getBanForSessionIdentifiers(context, { orgId });
    if (nextOrgBan) {
      return Response.json(
        { error: "This organization has been blocked.", redirect: "/banned" },
        { status: 403 },
      );
    }

    // Verify user is member of the org
    const isMember = await isOrgMember(authEnv, session.user_id, orgId);
    if (!isMember) {
      return Response.json(
        { error: "Not a member of this organization" },
        { status: 403 },
      );
    }

    const accessDenied = await requireAccessMappedOrg(request, env, session, orgId);
    if (accessDenied) return accessDenied;

    // Get workspaces for the org
    const workspaces = await listUserWorkspaces(
      authEnv,
      session.user_id,
      orgId,
    );
    const workspaceId = workspaces[0]?.id ?? null;

    // Re-sign session with new org/workspace
    const currentSessionData = {
      user_id: session.user_id,
      org_id: session.org_id,
      workspace_id: session.workspace_id,
      created_at: session.created_at,
      last_accessed: session.created_at,
      expires_at: session.expires_at,
      sso_connection_id: session.sso_connection_id,
      sso_config_version: session.sso_config_version,
      user_name: session.user_name,
      user_email: session.user_email,
      auth_source: session.auth_source ?? null,
    };
    const signedToken = await switchSessionOrg(
      authEnv,
      currentSessionData,
      orgId,
      workspaceId,
    );

    return Response.json(
      { success: true },
      {
        headers: {
          "Set-Cookie": createSessionCookieHeader(
            signedToken,
            request,
            getRemainingSessionCookieMaxAge(session),
          ),
        },
      },
    );
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Switch org error:", error);
    return Response.json(
      { error: "Failed to switch organization" },
      { status: 500 },
    );
  }
}
