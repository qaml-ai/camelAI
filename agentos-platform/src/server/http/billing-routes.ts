import {
  BILLING_PLANS,
  type BillingPlan,
} from "../../shared/billing-plans.ts";
import { verifyTicket } from "../auth/tickets.ts";
import {
  StripeBillingClient,
  handleWebhookEvent,
} from "../billing/stripe.ts";
import type { BillingService } from "../platform/billing.ts";

export interface BillingRouteOptions {
  billingService: BillingService;
  stripeClient?: StripeBillingClient;
  authorize?: (
    request: Request,
    orgId: string,
  ) => boolean | undefined | Promise<boolean | undefined>;
  allowTestOrgHeader?: boolean;
}

type CheckoutBody = {
  orgId?: unknown;
  plan?: unknown;
  amountCents?: unknown;
  successUrl?: unknown;
  cancelUrl?: unknown;
  seatCount?: unknown;
};

export function createBillingRoutes(options: BillingRouteOptions) {
  const stripeClient = options.stripeClient ?? new StripeBillingClient();

  return async function handleBillingRoute(
    request: Request,
  ): Promise<Response | null> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/billing/stripe/webhook") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const rawBody = await request.text();
        const event = stripeClient.constructEvent(
          rawBody,
          request.headers.get("stripe-signature"),
        );
        handleWebhookEvent(event, options.billingService);
        return json({ received: true });
      }

      if (url.pathname === "/api/billing/account") {
        if (request.method !== "GET") return methodNotAllowed(["GET"]);
        const orgId = url.searchParams.get("orgId")?.trim() ?? "";
        requireOrgId(orgId);
        await requireAuthorization(request, orgId, options);
        const account = options.billingService.getAccount(orgId);
        return json({
          ...account,
          creditBalanceCents: options.billingService.getCreditBalance(orgId),
        });
      }

      if (url.pathname === "/api/billing/checkout/subscription") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const body = await readCheckoutBody(request);
        const orgId = requireString(body.orgId, "orgId");
        await requireAuthorization(request, orgId, options);
        const plan = requireBillingPlan(body.plan);
        const account = options.billingService.getAccount(orgId);
        const session =
          await stripeClient.createCheckoutSessionForSubscription({
            orgId,
            plan,
            successUrl: requireString(body.successUrl, "successUrl"),
            cancelUrl: requireString(body.cancelUrl, "cancelUrl"),
            ...(account.stripeCustomerId
              ? { customerId: account.stripeCustomerId }
              : {}),
            ...(body.seatCount === undefined
              ? {}
              : { seatCount: requirePositiveInteger(body.seatCount, "seatCount") }),
          });
        return json({ id: session.id, url: session.url }, 201);
      }

      if (url.pathname === "/api/billing/checkout/credits") {
        if (request.method !== "POST") return methodNotAllowed(["POST"]);
        const body = await readCheckoutBody(request);
        const orgId = requireString(body.orgId, "orgId");
        await requireAuthorization(request, orgId, options);
        const account = options.billingService.getAccount(orgId);
        const session = await stripeClient.createCheckoutSessionForCredits({
          orgId,
          amountCents: requirePositiveInteger(body.amountCents, "amountCents"),
          successUrl: requireString(body.successUrl, "successUrl"),
          cancelUrl: requireString(body.cancelUrl, "cancelUrl"),
          ...(account.stripeCustomerId
            ? { customerId: account.stripeCustomerId }
            : {}),
        });
        return json({ id: session.id, url: session.url }, 201);
      }

      return null;
    } catch (error) {
      return routeErrorResponse(error);
    }
  };
}

async function requireAuthorization(
  request: Request,
  orgId: string,
  options: BillingRouteOptions,
): Promise<void> {
  if (options.authorize) {
    const authorized = await options.authorize(request, orgId);
    if (authorized === true) return;
    if (authorized === false) throw new BillingRouteError(403, "Forbidden");
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const ticket = bearer ?? request.headers.get("x-auth-ticket");
  if (ticket) {
    const payload = verifyTicket(ticket);
    if (!payload) throw new BillingRouteError(401, "Unauthorized");
    if (payload.orgId !== orgId) throw new BillingRouteError(403, "Forbidden");
    return;
  }

  const allowTestHeader =
    options.allowTestOrgHeader ?? process.env.NODE_ENV === "test";
  if (
    allowTestHeader &&
    request.headers.get("x-org-id")?.trim() === orgId
  ) {
    return;
  }
  throw new BillingRouteError(401, "Unauthorized");
}

async function readCheckoutBody(request: Request): Promise<CheckoutBody> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new BillingRouteError(400, "Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingRouteError(400, "JSON body must be an object");
  }
  return value as CheckoutBody;
}

function requireBillingPlan(value: unknown): BillingPlan {
  if (
    typeof value !== "string" ||
    !BILLING_PLANS.includes(value as BillingPlan)
  ) {
    throw new BillingRouteError(400, "plan is invalid");
  }
  return value as BillingPlan;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BillingRouteError(400, `${field} is required`);
  }
  return value.trim();
}

function requireOrgId(value: string): void {
  if (!value) {
    throw new BillingRouteError(400, "orgId is required");
  }
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new BillingRouteError(400, `${field} must be a positive integer`);
  }
  return value;
}

function routeErrorResponse(error: unknown): Response {
  if (error instanceof BillingRouteError) {
    return json({ error: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : "Billing request failed";
  if (
    message === "Stripe not configured" ||
    message === "Stripe webhook not configured"
  ) {
    return json({ error: message }, 503);
  }
  if (
    message.startsWith("Invalid Stripe signature") ||
    message.startsWith("Invalid Stripe webhook")
  ) {
    return json({ error: message }, 400);
  }
  if (message.startsWith("Stripe request failed")) {
    return json({ error: message }, 502);
  }
  return json({ error: message }, 400);
}

function methodNotAllowed(methods: string[]): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json",
      Allow: methods.join(", "),
    },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

class BillingRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
