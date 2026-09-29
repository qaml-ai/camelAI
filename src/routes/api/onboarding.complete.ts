import type { Route } from "./+types/onboarding.complete";
import { getAuthEnv, requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import {
  isOrgBillingAccessReady,
  resolveOrgBillingAccess,
} from "@/lib/billing.server";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { associateAttributionWithUser } from "@/lib/marketing-attribution.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

type OnboardingAccessChoice = "byok" | "existing" | null;

async function readAccessChoice(
  request: Request,
): Promise<OnboardingAccessChoice> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!body || typeof body !== "object") {
    return null;
  }
  const accessChoice = (body as { accessChoice?: unknown }).accessChoice;
  return accessChoice === "byok" || accessChoice === "existing"
    ? accessChoice
    : null;
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const accessChoice = await readAccessChoice(request);

  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) {
    return Response.json({ error: "No workspace selected" }, { status: 400 });
  }

  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(authContext.user.id),
  );
  const verificationStatus = await userStub.getEmailVerificationStatus();
  if (verificationStatus.required && !verificationStatus.verified) {
    return Response.json(
      { error: "Please verify your email before completing onboarding." },
      { status: 403 },
    );
  }

  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );

  if (accessChoice === "byok" && !effectiveLlmProviderConfig) {
    return Response.json(
      { error: "Add an API key before continuing with your own provider." },
      { status: 400 },
    );
  }

  const billingAccess = resolveOrgBillingAccess({
    env,
    org: authContext.currentOrg,
    llmProviderConfig: effectiveLlmProviderConfig,
  });

  if (!isOrgBillingAccessReady(billingAccess)) {
    return Response.json(
      { error: "Choose a billing option before continuing." },
      { status: 402 },
    );
  }

  if (!authContext.onboarding?.completed_at) {
    await userStub.updateOnboarding({ completed_at: Date.now() });
  }
  await associateAttributionWithUser(request, env.APP_KV, authContext.user.id);

  return Response.json({
    success: true,
    redirectTo: "/chat",
  });
}
