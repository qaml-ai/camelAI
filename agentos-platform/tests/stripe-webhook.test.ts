import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STRIPE_API_VERSION,
  StripeBillingClient,
  handleWebhookEvent,
  type StripeWebhookEvent,
} from "../src/server/billing/stripe.ts";
import { createApiHandler } from "../src/server/http/api.ts";
import { BillingService } from "../src/server/platform/billing.ts";
import { Store } from "../src/server/platform/store.ts";

const tempDirs: string[] = [];
const webhookSecret = "whsec_unit_test";
const nowSeconds = 1_800_000_000;

function createBilling(): BillingService {
  const dataDir = mkdtempSync(join(tmpdir(), "agentos-stripe-"));
  tempDirs.push(dataDir);
  return new BillingService(new Store({ dataDir }));
}

function sign(payload: string, timestamp = nowSeconds): string {
  const signature = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function client(options: ConstructorParameters<typeof StripeBillingClient>[0] = {}) {
  return new StripeBillingClient({
    webhookSecret,
    now: () => nowSeconds * 1000,
    ...options,
  });
}

function event(
  type: string,
  object: Record<string, unknown>,
): StripeWebhookEvent {
  return {
    id: `evt_${type}`,
    type,
    data: { object },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Stripe webhook signatures", () => {
  it("verifies the raw payload before parsing the event", () => {
    const payload = JSON.stringify(
      event("checkout.session.completed", { id: "cs_1" }),
    );
    expect(client().constructEvent(payload, sign(payload))).toEqual(
      JSON.parse(payload),
    );
    expect(() =>
      client().constructEvent(`${payload} `, sign(payload)),
    ).toThrow(/Invalid Stripe signature/);
  });

  it("rejects missing, malformed, and stale signatures", () => {
    const payload = JSON.stringify(event("ignored", {}));
    expect(() => client().constructEvent(payload, null)).toThrow(
      /Invalid Stripe signature/,
    );
    expect(() => client().constructEvent(payload, "t=bad,v1=nope")).toThrow(
      /Invalid Stripe signature/,
    );
    expect(() =>
      client().constructEvent(payload, sign(payload, nowSeconds - 301)),
    ).toThrow(/outside tolerance/);
  });
});

describe("Stripe webhook billing", () => {
  it("grants completed credit checkouts exactly once", () => {
    const billing = createBilling();
    const completed = event("checkout.session.completed", {
      id: "cs_credits",
      mode: "payment",
      amount_total: 2500,
      customer: "cus_1",
      metadata: {
        type: "credits",
        orgId: "org-1",
        amountCents: "2500",
      },
    });

    handleWebhookEvent(completed, billing);
    handleWebhookEvent(completed, billing);
    expect(billing.getCreditBalance("org-1")).toBe(2500);
    expect(billing.getAccount("org-1").stripeCustomerId).toBe("cus_1");
  });

  it("syncs subscriptions and grants each paid invoice once", () => {
    const billing = createBilling();
    handleWebhookEvent(
      event("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: {
          org_id: "org-1",
          billing_plan: "team",
          seat_count: "4",
        },
      }),
      billing,
    );
    expect(billing.getAccount("org-1")).toMatchObject({
      plan: "team",
      billingStatus: "active",
      seatCount: 4,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });

    const invoice = event("invoice.payment_succeeded", {
      id: "in_1",
      parent: {
        subscription_details: {
          metadata: {
            org_id: "org-1",
            billing_plan: "team",
            seat_count: "4",
          },
        },
      },
    });
    handleWebhookEvent(invoice, billing);
    handleWebhookEvent(invoice, billing);
    expect(billing.getAccount("org-1").includedCreditCents).toBe(20_000);
    expect(billing.getAccount("org-1").lastIncludedCreditInvoiceId).toBe(
      "in_1",
    );
  });
});

describe("Stripe Checkout client", () => {
  it("creates dynamic-payment Checkout Sessions on the latest API version", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          id: "cs_new",
          url: "https://checkout.stripe.test/cs_new",
        }),
    );
    const stripe = client({
      secretKey: "sk_test_example",
      mode: "test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await stripe.createCheckoutSessionForSubscription({
      orgId: "org-1",
      plan: "team",
      seatCount: 4,
      successUrl: "https://camelai.test/success",
      cancelUrl: "https://camelai.test/cancel",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init?.headers).toMatchObject({
      "Stripe-Version": STRIPE_API_VERSION,
    });
    const body = init?.body as URLSearchParams;
    expect(body.get("mode")).toBe("subscription");
    expect(body.get("line_items[0][quantity]")).toBe("4");
    expect([...body.keys()].some((key) => key.includes("payment_method_types"))).toBe(
      false,
    );
  });

  it("fails closed when Stripe is absent or the key mode mismatches", async () => {
    await expect(
      client({ secretKey: "", mode: "test" }).createCheckoutSessionForCredits({
        orgId: "org-1",
        amountCents: 500,
        successUrl: "https://camelai.test/success",
        cancelUrl: "https://camelai.test/cancel",
      }),
    ).rejects.toThrow("Stripe not configured");

    await expect(
      client({
        secretKey: "sk_live_example",
        mode: "test",
      }).createCheckoutSessionForCredits({
        orgId: "org-1",
        amountCents: 500,
        successUrl: "https://camelai.test/success",
        cancelUrl: "https://camelai.test/cancel",
      }),
    ).rejects.toThrow(/key mode mismatch/);
  });
});

describe("billing HTTP routes", () => {
  it("mounts protected account and Checkout endpoints on the API handler", async () => {
    const billing = createBilling();
    billing.grantCredits("org-1", 300);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          id: "cs_http",
          url: "https://checkout.stripe.test/cs_http",
        }),
    );
    const handler = createApiHandler({
      billingService: billing,
      stripeClient: client({
        secretKey: "sk_test_example",
        fetch: fetchMock as unknown as typeof fetch,
      }),
      allowTestOrgHeader: true,
    });

    const unauthorized = await handler(
      new Request("http://localhost/api/billing/account?orgId=org-1"),
    );
    expect(unauthorized.status).toBe(401);

    const account = await handler(
      new Request("http://localhost/api/billing/account?orgId=org-1", {
        headers: { "x-org-id": "org-1" },
      }),
    );
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ creditBalanceCents: 300 });

    const checkout = await handler(
      new Request("http://localhost/api/billing/checkout/credits", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-org-id": "org-1",
        },
        body: JSON.stringify({
          orgId: "org-1",
          amountCents: 500,
          successUrl: "https://camelai.test/success",
          cancelUrl: "https://camelai.test/cancel",
        }),
      }),
    );
    expect(checkout.status).toBe(201);
    expect(await checkout.json()).toEqual({
      id: "cs_http",
      url: "https://checkout.stripe.test/cs_http",
    });
  });
});
