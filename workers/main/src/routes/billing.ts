import type { RouteContext } from "../types.js";
import { text } from "../helpers/response.js";
import {
  applyCreditsCheckoutCompleted,
  processPaidSubscriptionInvoice,
  syncOrgSubscriptionFromStripe,
  verifyStripeWebhookSignature,
  type StripeCheckoutSession,
  type StripeSubscription,
  type StripeWebhookEvent,
} from "../../../../src/lib/billing.server.js";
import { recordErrorEvent, recordObservabilityEvent } from "../observability.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleStripeWebhook({
  req,
  env,
  url,
}: RouteContext): Promise<Response> {
  if (req.method !== "POST") {
    return text("Method not allowed", 405);
  }

  const webhookSecret = (
    url.searchParams.get("version") === "next"
      ? env.STRIPE_WEBHOOK_SECRET_NEXT
      : env.STRIPE_WEBHOOK_SECRET
  )?.trim();
  if (!webhookSecret || !env.STRIPE_SECRET_KEY?.trim()) {
    return text("Stripe billing is not configured", 503);
  }

  const payload = await req.text();
  const signatureHeader = req.headers.get("stripe-signature");
  const valid = await verifyStripeWebhookSignature({
    payload,
    signatureHeader,
    secret: webhookSecret,
  });
  if (!valid) {
    return text("Invalid Stripe signature", 400);
  }

  let event: StripeWebhookEvent;
  try {
    event = JSON.parse(payload) as StripeWebhookEvent;
  } catch {
    return text("Invalid JSON payload", 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await applyCreditsCheckoutCompleted(
          env,
          event.data.object as StripeCheckoutSession,
        );
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await syncOrgSubscriptionFromStripe(
          env,
          event.data.object as StripeSubscription,
        );
        break;
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const invoiceId = (event.data.object as { id?: string | null }).id?.trim();
        if (!invoiceId) throw new Error("Stripe paid-invoice event did not include an id.");
        const result = await processPaidSubscriptionInvoice(env, invoiceId);
        const safe = {
          eventId: event.id,
          eventType: event.type,
          invoiceId,
          subscriptionId: result.subscriptionId ?? null,
          orgId: result.status === "ignored" ? null : result.orgId,
          plan: result.status === "ignored" ? null : result.plan,
          seatCount: result.status === "ignored" ? null : result.seatCount,
          grantCents: result.status === "ignored" ? 0 : result.grantCents,
          outcome: result.status,
          reason: result.status === "ignored" ? result.reason : undefined,
        };
        if (
          result.status === "ignored" &&
          result.reason === "organization_not_resolved"
        ) {
          console.warn(
            "[billing] paid invoice ignored (no platform organization)",
            safe,
          );
        } else {
          console.info("[billing] paid invoice webhook processed", safe);
        }
        recordObservabilityEvent(env, {
          event: "stripe_subscription_invoice",
          component: "billing_webhook",
          operation: event.type,
          status: result.status,
          orgId: safe.orgId,
          requestId: event.id,
          provider: safe.plan,
          count: safe.grantCents,
          size: safe.seatCount,
          sampleIndex: invoiceId,
        });
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error("[billing] webhook processing failed", {
      eventType: event.type,
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
    recordErrorEvent(env, {
      event: "stripe_webhook_processing_failed",
      component: "billing_webhook",
      operation: event.type,
      status: "failed",
      requestId: event.id,
      route: "/api/billing/stripe/webhook",
      method: req.method,
      path: url.pathname,
      error,
    });
    return text("Webhook processing failed", 500);
  }

  return jsonResponse({ received: true });
}
