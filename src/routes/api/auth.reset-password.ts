import type { Route } from "./+types/auth.reset-password";
import { getEnv } from "@/lib/cloudflare.server";
import { getBanForEmail } from "@/lib/ban.server";
import { validatePasswordResetToken } from "@/lib/password-reset-token";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

const MIN_PASSWORD_LENGTH = 8;

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await request.json()) as {
      token?: string;
      password?: string;
    };
    const token = body.token?.trim();
    const password = body.password;

    if (!token) {
      return Response.json(
        { error: "Reset link is invalid or has expired." },
        { status: 400 },
      );
    }

    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return Response.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 },
      );
    }

    const env = getEnv(context);
    const payload = await validatePasswordResetToken(
      env.TOKEN_SIGNING_SECRET,
      token,
    );
    if (!payload) {
      return Response.json(
        { error: "Reset link is invalid or has expired." },
        { status: 400 },
      );
    }

    if (await getBanForEmail(context, payload.email)) {
      return Response.json(
        { error: "This account has been blocked.", redirect: "/banned" },
        { status: 403 },
      );
    }

    const userStub = env.USER.get(env.USER.idFromName(payload.user_id));
    const profile = await userStub.getProfile();
    if (!profile || profile.email.toLowerCase() !== payload.email.toLowerCase()) {
      return Response.json(
        { error: "Reset link is invalid or has expired." },
        { status: 400 },
      );
    }

    const reset = await userStub.resetPassword(password, payload.nonce);
    if (!reset) {
      return Response.json(
        { error: "Reset link is invalid or has expired." },
        { status: 400 },
      );
    }

    return Response.json({
      success: true,
      redirect: "/login?passwordReset=1",
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return Response.json(
      { error: "Unable to reset password right now. Please try again." },
      { status: 500 },
    );
  }
}
