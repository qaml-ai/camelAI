import type { Route } from "./+types/billing.start-subscription";
import { requireAuthContext } from "@/lib/auth.server";
import {
  createSubscriptionCheckoutSession,
  getBillableTeamSeatCountForOrg,
} from "@/lib/billing.server";
import { isBillingPlan } from "@/lib/billing-plans";
import { getEnv } from "@/lib/cloudflare.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

const SUBSCRIPTION_PLANS = new Set(["starter", "pro", "team"]);

function isSubscriptionPlan(plan: string): plan is "starter" | "pro" | "team" {
  return isBillingPlan(plan) && SUBSCRIPTION_PLANS.has(plan);
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const formData = await request.formData();
  const rawPlan = String(formData.get("plan") || "").trim();

  if (!isSubscriptionPlan(rawPlan)) {
    return Response.json(
      { error: "Choose Starter, Pro, or Team to start a subscription." },
      { status: 400 },
    );
  }

  const successUrl = new URL("/chat?checkout=success", request.url).toString();
  const cancelUrl = new URL("/chat?checkout=cancelled", request.url).toString();

  try {
    const seatCount =
      rawPlan === "team"
        ? await getBillableTeamSeatCountForOrg(env, authContext.currentOrg.id)
        : 1;

    const checkoutUrl = await createSubscriptionCheckoutSession({
      env,
      org: authContext.currentOrg,
      customerEmail: authContext.user.email,
      successUrl,
      cancelUrl,
      plan: rawPlan,
      seatCount,
    });

    return Response.json({ checkoutUrl });
  } catch (error) {
    console.error("[billing] failed to create subscription checkout", {
      orgId: authContext.currentOrg.id,
      plan: rawPlan,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to start subscription checkout",
      },
      { status: 503 },
    );
  }
}
