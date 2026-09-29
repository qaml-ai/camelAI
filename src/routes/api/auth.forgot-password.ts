import type { Route } from "./+types/auth.forgot-password";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import { getUserByEmail } from "@/lib/auth-do";
import { getBanForEmail } from "@/lib/ban.server";
import { sendUserPasswordResetEmail } from "@/lib/password-reset.server";
import { waitUntil } from "@/lib/wait-until";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

const GENERIC_SUCCESS = {
  success: true,
  message:
    "If an account exists for that email, you'll receive a password reset link shortly.",
};

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { email?: string };
    const email = body.email?.trim().toLowerCase();

    if (!email) {
      return Response.json({ error: "Email is required" }, { status: 400 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);

    // Always return the same success response to avoid account enumeration.
    const respondSuccess = () => Response.json(GENERIC_SUCCESS);

    if (await getBanForEmail(context, email)) {
      return respondSuccess();
    }

    const userResult = await getUserByEmail(authEnv, email);
    if (!userResult) {
      return respondSuccess();
    }

    const userStub = authEnv.USER.get(
      authEnv.USER.idFromName(userResult.userId),
    );
    const passwordHash = await userStub.getPasswordHash();
    if (!passwordHash) {
      // OAuth-only accounts have no password to reset.
      return respondSuccess();
    }

    const nonce = crypto.randomUUID();
    await userStub.setPasswordResetNonce(nonce);

    waitUntil(
      sendUserPasswordResetEmail({
        env,
        requestUrl: new URL(request.url),
        userId: userResult.userId,
        email: userResult.user.email,
        nonce,
      }).then((delivery) => {
        if (delivery.status !== "sent") {
          console.error("Failed to send password reset email:", delivery.reason);
        }
      }),
    );

    return respondSuccess();
  } catch (error) {
    console.error("Forgot password error:", error);
    return Response.json(
      { error: "Unable to process request. Please try again." },
      { status: 500 },
    );
  }
}
