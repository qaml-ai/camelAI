import type { Route } from "./+types/auth.login";
import { getEnv, type CloudflareEnv } from "@/lib/cloudflare.server";
import { createSessionCookieHeader } from "@/lib/cookies.server";
import { type AuthEnv } from "@/lib/auth-helpers";
import {
  getUserByEmail,
  checkUserOrphaned,
  handleOrphanedUserLogin,
  getUserOrgs,
  listUserWorkspaces,
  createSession,
} from "@/lib/auth-do";
import { getBanForEmail } from "@/lib/ban.server";
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
    const body = (await request.json()) as {
      email?: string;
      password?: string;
    };
    const { email, password } = body;

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400 },
      );
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    const existingBan = await getBanForEmail(context, email);
    if (existingBan) {
      return Response.json(
        { error: "This account has been blocked.", redirect: "/banned" },
        { status: 403 },
      );
    }

    const userResult = await getUserByEmail(authEnv, email);
    if (!userResult) {
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const isValid = await authEnv.USER.get(
      authEnv.USER.idFromName(userResult.userId),
    ).verifyPassword(password);
    if (!isValid) {
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const isOrphaned = await checkUserOrphaned(authEnv, userResult.userId);

    let orgId: string;
    let workspaceId: string | null = null;

    if (isOrphaned) {
      const result = await handleOrphanedUserLogin(authEnv, userResult.userId);
      if (!result) {
        return Response.json(
          { error: "Failed to create organization" },
          { status: 500 },
        );
      }
      orgId = result.org.id;
      workspaceId = result.workspace.id;
    } else {
      const orgs = await getUserOrgs(authEnv, userResult.userId);
      if (orgs.length === 0) {
        return Response.json(
          { error: "User has no organizations" },
          { status: 400 },
        );
      }
      orgId = orgs[0].org_id;
      const workspaces = await listUserWorkspaces(
        authEnv,
        userResult.userId,
        orgId,
      );
      workspaceId = workspaces[0]?.id ?? null;
    }

    const { signedToken } = await createSession(
      authEnv,
      userResult.userId,
      orgId,
      workspaceId,
      {
        name: userResult.user.name,
        email: userResult.user.email,
      },
    );

    return Response.json(
      { success: true },
      {
        headers: {
          "Set-Cookie": createSessionCookieHeader(signedToken, request),
        },
      },
    );
  } catch (error) {
    console.error("Login error:", error);
    return Response.json({ error: "Login failed" }, { status: 500 });
  }
}
