import type { Route } from "./+types/marketing-attribution.purchase";
import { requireAuthContext } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { recordStreamPurchase } from "@/lib/marketing-attribution.server";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

const PURCHASE_STATUSES = new Set(["active", "trialing"]);

export const loader = actionOnlyLoader('POST');

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await requireAuthContext(request, context);
  const env = getEnv(context);
  const billingStatus = auth.currentOrg.billing_status;

  if (!PURCHASE_STATUSES.has(billingStatus)) {
    return Response.json(
      {
        purchased: false,
        reason: "billing_not_active",
        billingStatus,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const { record, isFirst } = await recordStreamPurchase(env.APP_KV, {
    orgId: auth.currentOrg.id,
    purchasedAt: Date.now(),
    billingStatus: billingStatus as "active" | "trialing",
    subscriptionId: auth.currentOrg.billing_subscription_id ?? null,
  });

  return Response.json(
    {
      purchased: true,
      shouldTrack: isFirst,
      eventId: record.eventId,
      billingStatus: record.billingStatus,
      subscriptionId: record.subscriptionId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
