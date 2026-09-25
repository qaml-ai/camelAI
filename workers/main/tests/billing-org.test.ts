import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";
import {
  createSubscriptionCheckoutSession,
  deleteStripeTestCustomerForOrg,
  getBillingAccessSnapshotForOrg,
  syncOrgSubscriptionFromStripe,
  type StripeBillingEnv,
  type StripeSubscription,
} from "../../../src/lib/billing.server";

const testEmail = () =>
  `billing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe("OrgDO billing grant idempotency", () => {
  const testEnv = env as unknown as TestEnv;

  function stripeBillingEnv(): StripeBillingEnv {
    return {
      ...(testEnv as unknown as StripeBillingEnv),
      STRIPE_STARTER_PRICE_ID: "price_starter_test",
    };
  }

  function trialingStarterSubscription(
    orgId: string,
    cancelAtPeriodEnd: boolean,
  ): StripeSubscription {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return {
      id: `sub_${crypto.randomUUID()}`,
      status: "trialing",
      customer: "cus_test",
      trial_start: nowSeconds,
      trial_end: nowSeconds + 7 * 24 * 60 * 60,
      cancel_at_period_end: cancelAtPeriodEnd,
      metadata: {
        org_id: orgId,
        billing_plan: "starter",
        seat_count: "1",
        trial_credit_cents: "1000",
        subscription_included_credit_cents: "1000",
      },
      items: {
        data: [
          {
            id: "si_starter_test",
            quantity: 1,
            price: {
              id: "price_starter_test",
              unit_amount: 1000,
              currency: "usd",
            },
          },
        ],
      },
    };
  }

  function pausedStarterSubscription(orgId: string): StripeSubscription {
    return {
      id: `sub_${crypto.randomUUID()}`,
      status: "paused",
      customer: "cus_test",
      cancel_at_period_end: false,
      metadata: {
        org_id: orgId,
        billing_plan: "starter",
        seat_count: "1",
        subscription_included_credit_cents: "1000",
      },
      items: {
        data: [
          {
            id: "si_starter_test",
            quantity: 1,
            price: {
              id: "price_starter_test",
              unit_amount: 1000,
              currency: "usd",
            },
          },
        ],
      },
    };
  }

  it("normalizes a completed cancellation to the free tier", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(
      testEnv,
      "Canceled Subscription Org",
      ownerId,
      { billingPlan: "pro" },
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await expect(
      orgStub.updateBillingState({
        billing_status: "canceled",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_subscription_id: "sub_canceled",
        billing_subscription_status: "canceled",
      }),
    ).resolves.toMatchObject({
      billing_status: "inactive",
      billing_plan: "payg",
      billing_seat_count: 1,
      billing_subscription_id: null,
      billing_subscription_status: null,
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_status: "inactive",
      billing_plan: "payg",
      billing_subscription_id: null,
      billing_subscription_status: null,
    });
  });

  it("uses paid Team capacity locally without mutating billing", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Team Capacity Org", ownerId, {
      billingPlan: "team",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
      billing_subscription_id: "sub_team_capacity",
      billing_subscription_status: "active",
    });

    const invitations = await orgStub.createInvitations(
      ["first@example.com", "second@example.com"],
      "member",
      ownerId,
    );
    expect(invitations).toHaveLength(2);

    await orgStub.deleteInvitation(invitations[0].id);
    await expect(
      orgStub.createInvitations(["replacement@example.com"], "member", ownerId),
    ).resolves.toHaveLength(1);
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_seat_count: 3,
      billing_subscription_id: "sub_team_capacity",
    });
  });

  it("atomically rejects a paid billing projection below occupied seats", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Team Projection Guard", ownerId, {
      billingPlan: "team",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
      billing_subscription_id: "sub_team_guard",
      billing_subscription_status: "active",
    });
    await orgStub.createInvitations(
      ["reserved@example.com"],
      "member",
      ownerId,
    );

    await expect(
      orgStub.syncSubscriptionBillingState(
        {
          billing_status: "active",
          billing_plan: "pro",
          billing_seat_count: 1,
          billing_subscription_id: "sub_team_guard",
          billing_subscription_status: "active",
        },
        0,
      ),
    ).resolves.toMatchObject({
      capacityInvariantError:
        "The projected billing plan includes 1 seat, but this organization has 2 occupied seats.",
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 3,
    });

    await expect(
      orgStub.syncSubscriptionBillingState(
        {
          billing_status: "inactive",
          billing_plan: "payg",
          billing_seat_count: 1,
          billing_subscription_id: null,
          billing_subscription_status: null,
        },
        0,
      ),
    ).resolves.toMatchObject({
      org: { billing_status: "inactive", billing_plan: "payg" },
    });
  });

  it("keeps pending-cancel trial subscriptions trialing until Stripe cancels them", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Canceled Trial Org", ownerId, {
      billingPlan: "payg",
    });

    const subscription = trialingStarterSubscription(org.id, true);
    const synced = await syncOrgSubscriptionFromStripe(
      stripeBillingEnv(),
      subscription,
    );

    expect(synced?.billing_status).toBe("trialing");
    expect(synced?.billing_plan).toBe("starter");
    expect(synced?.billing_subscription_id).toBe(subscription.id);
    expect(synced?.billing_subscription_status).toBe("trialing");
    expect(synced?.billing_credit_grant_total_cents).toBe(1000);
    expect(synced?.billing_trial_credit_grant_cents).toBe(1000);
    expect(synced?.billing_trial_credit_granted_at).toEqual(
      expect.any(Number),
    );

    const snapshot = getBillingAccessSnapshotForOrg(synced!);
    expect(snapshot?.billing_status).toBe("trialing");
    expect(snapshot?.billing_plan).toBe("starter");
  });

  it("preserves paused Stripe subscriptions instead of converting them to Pay as you go", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Paused Subscription Org", ownerId, {
      billingPlan: "payg",
    });
    const subscription = pausedStarterSubscription(org.id);

    const synced = await syncOrgSubscriptionFromStripe(
      stripeBillingEnv(),
      subscription,
    );

    expect(synced?.billing_status).toBe("inactive");
    expect(synced?.billing_plan).toBe("starter");
    expect(synced?.billing_subscription_id).toBe(subscription.id);
    expect(synced?.billing_subscription_status).toBe("paused");
  });

  it("creates paid subscription checkout without a free trial period", async () => {
    const { userId: ownerId, user } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Paid Checkout Org", ownerId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const billingOrg = await orgStub.updateBillingState({
      billing_customer_id: "cus_test",
    });
    expect(billingOrg).not.toBeNull();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          id: "price_starter_test",
          unit_amount: 1000,
          currency: "usd",
          active: true,
          product: "prod_starter_test",
          recurring: { interval: "month", interval_count: 1 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "cs_test",
          mode: "subscription",
          url: "https://checkout.stripe.test/session",
        }),
      );

    try {
      await expect(
        createSubscriptionCheckoutSession({
          env: {
            ...stripeBillingEnv(),
            STRIPE_MODE: "test",
            STRIPE_SECRET_KEY: "sk_test_checkout",
            STRIPE_STARTER_PRICE_ID: "price_starter_test",
          },
          org: billingOrg!,
          customerEmail: user.email,
          successUrl: "https://camelai.test/success",
          cancelUrl: "https://camelai.test/cancel",
          plan: "starter",
          seatCount: 1,
        }),
      ).resolves.toBe("https://checkout.stripe.test/session");

      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = new URLSearchParams(String(init.body));

      expect(body.get("mode")).toBe("subscription");
      expect(body.get("subscription_data[trial_period_days]")).toBeNull();
      expect(body.get("metadata[trial_credit_cents]")).toBe("0");
      expect(body.get("subscription_data[metadata][trial_credit_cents]")).toBe(
        "0",
      );
      expect(body.get("metadata[initial_included_credit_cents]")).toBe("1000");
      expect(
        body.get("subscription_data[metadata][initial_included_credit_cents]"),
      ).toBe("1000");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("deletes only a matching Stripe test customer and clears its projection", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Test Customer Cleanup Org", ownerId, {
      billingPlan: "starter",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const billingOrg = await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "starter",
      billing_customer_id: "cus_cleanup",
      billing_subscription_id: "sub_cleanup",
      billing_subscription_status: "active",
    });
    expect(billingOrg).not.toBeNull();

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          id: "cus_cleanup",
          metadata: { org_id: org.id },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: "sub_cleanup",
          status: "active",
          customer: "cus_cleanup",
          metadata: { org_id: org.id },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "sub_cleanup", status: "canceled" }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "cus_cleanup", deleted: true }),
      );

    try {
      await expect(
        deleteStripeTestCustomerForOrg(
          {
            ...stripeBillingEnv(),
            STRIPE_MODE: "test",
            STRIPE_SECRET_KEY: "sk_test_cleanup",
          },
          billingOrg!,
        ),
      ).resolves.toMatchObject({
        subscription_deleted: true,
        customer_deleted: true,
        org: {
          billing_status: "inactive",
          billing_plan: "payg",
          billing_customer_id: null,
          billing_subscription_id: null,
          billing_subscription_status: null,
        },
      });
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.stripe.com/v1/customers/cus_cleanup",
        "https://api.stripe.com/v1/subscriptions/sub_cleanup",
        "https://api.stripe.com/v1/subscriptions/sub_cleanup",
        "https://api.stripe.com/v1/customers/cus_cleanup",
      ]);
      expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");
      expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("refuses Stripe customer deletion outside test mode before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      await expect(
        deleteStripeTestCustomerForOrg(
          {
            ...stripeBillingEnv(),
            STRIPE_MODE: "live",
            STRIPE_SECRET_KEY: "sk_live_cleanup",
          },
          {
            id: "org_live",
            billing_customer_id: "cus_live",
          } as never,
        ),
      ).rejects.toThrow("STRIPE_MODE=test");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("clears a late OrgDO projection for an already-deleted Stripe test customer", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Deleted Customer Cleanup Org", ownerId, {
      billingPlan: "starter",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const billingOrg = await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "starter",
      billing_customer_id: "cus_deleted",
      billing_subscription_id: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ id: "cus_deleted", deleted: true }),
      );

    try {
      await expect(
        deleteStripeTestCustomerForOrg(
          {
            ...stripeBillingEnv(),
            STRIPE_MODE: "test",
            STRIPE_SECRET_KEY: "sk_test_cleanup",
          },
          billingOrg!,
        ),
      ).resolves.toMatchObject({
        customer_deleted: false,
        org: {
          billing_status: "inactive",
          billing_plan: "payg",
          billing_customer_id: null,
        },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    ["missing", {}],
    ["mismatched", { org_id: "org_other" }],
  ])(
    "fails closed when Stripe customer ownership metadata is %s",
    async (_case, metadata) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json({ id: "cus_unowned", metadata }));
      try {
        await expect(
          deleteStripeTestCustomerForOrg(
            {
              ...stripeBillingEnv(),
              STRIPE_MODE: "test",
              STRIPE_SECRET_KEY: "sk_test_cleanup",
            },
            {
              id: "org_expected",
              billing_customer_id: "cus_unowned",
            } as never,
          ),
        ).rejects.toThrow(
          "Stripe customer metadata does not match the target organization",
        );
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
      } finally {
        fetchMock.mockRestore();
      }
    },
  );

  it("continues granting first-trial credits when the Stripe trial is not canceling", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Active Trial Org", ownerId, {
      billingPlan: "payg",
    });

    const synced = await syncOrgSubscriptionFromStripe(
      stripeBillingEnv(),
      trialingStarterSubscription(org.id, false),
    );

    expect(synced?.billing_status).toBe("trialing");
    expect(synced?.billing_subscription_status).toBe("trialing");
    expect(synced?.billing_credit_grant_total_cents).toBe(1000);
    expect(synced?.billing_trial_credit_grant_cents).toBe(1000);
    expect(synced?.billing_trial_credit_granted_at).toEqual(
      expect.any(Number),
    );
  });

  it("applies trial credits once when subscription events are delivered more than once", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Trial Grant Org", ownerId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const trialStart = Date.now();
    const trialEnd = trialStart + 7 * 24 * 60 * 60 * 1000;

    const first = await orgStub.syncSubscriptionBillingState(
      {
        billing_status: "trialing",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_test",
        billing_subscription_id: "sub_test",
        billing_subscription_status: "trialing",
        billing_trial_started_at: trialStart,
        billing_trial_ends_at: trialEnd,
      },
      1200,
    );

    expect(first?.trialCreditGranted).toBe(true);
    expect(first?.org.billing_credit_grant_total_cents).toBe(1200);
    expect(first?.org.billing_trial_credit_grant_cents).toBe(1200);
    expect(first?.org.billing_trial_credit_granted_at).toEqual(
      expect.any(Number),
    );

    const duplicate = await orgStub.syncSubscriptionBillingState(
      {
        billing_status: "trialing",
        billing_plan: "starter",
        billing_seat_count: 1,
        billing_customer_id: "cus_test",
        billing_subscription_id: "sub_test",
        billing_subscription_status: "trialing",
        billing_trial_started_at: trialStart,
        billing_trial_ends_at: trialEnd,
      },
      1200,
    );

    expect(duplicate?.trialCreditGranted).toBe(false);
    expect(duplicate?.org.billing_credit_grant_total_cents).toBe(1200);
    expect(duplicate?.org.billing_trial_credit_grant_cents).toBe(1200);
  });

  it("does not grant trial credits again after any prior org trial", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Prior Trial Org", ownerId, {
      billingPlan: "payg",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const priorTrialStart = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const trialStart = Date.now();
    const trialEnd = trialStart + 7 * 24 * 60 * 60 * 1000;

    await orgStub.updateBillingState({
      billing_trial_started_at: priorTrialStart,
      billing_trial_ends_at: priorTrialStart + 7 * 24 * 60 * 60 * 1000,
    });

    const result = await orgStub.syncSubscriptionBillingState(
      {
        billing_status: "trialing",
        billing_plan: "pro",
        billing_seat_count: 1,
        billing_customer_id: "cus_test",
        billing_subscription_id: "sub_test",
        billing_subscription_status: "trialing",
        billing_trial_started_at: trialStart,
        billing_trial_ends_at: trialEnd,
      },
      3000,
    );

    expect(result?.trialCreditGranted).toBe(false);
    expect(result?.org.billing_credit_grant_total_cents).toBe(0);
    expect(result?.org.billing_trial_credit_grant_cents).toBe(0);
    expect(result?.org.billing_trial_credit_granted_at).toBeNull();
  });

  it("applies manual credit grants idempotently by grant id", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Manual Grant Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const first = await orgStub.applyManualCreditGrant(
      2500,
      "manual onboarding credit",
      "grant-test-1",
    );
    expect(first?.applied).toBe(true);
    expect(first?.amountCents).toBe(2500);
    expect(first?.reason).toBe("manual onboarding credit");
    expect(first?.org.billing_credit_grant_total_cents).toBe(2500);

    const duplicate = await orgStub.applyManualCreditGrant(
      2500,
      "manual onboarding credit",
      "grant-test-1",
    );
    expect(duplicate?.applied).toBe(false);
    expect(duplicate?.amountCents).toBe(2500);
    expect(duplicate?.org.billing_credit_grant_total_cents).toBe(2500);
  });

  it("applyManualCreditGrant stores created_by and source", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Manual Grant Metadata Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const result = await orgStub.applyManualCreditGrant(
      2500,
      "test grant",
      "grant-metadata-1",
      { createdBy: ownerId, source: "qaml-backdoor" },
    );

    expect(result).toMatchObject({
      applied: true,
      grantId: "grant-metadata-1",
      amountCents: 2500,
      reason: "test grant",
      createdBy: ownerId,
      source: "qaml-backdoor",
    });
    expect(result?.createdAt).toEqual(expect.any(Number));
    expect(result?.org.billing_credit_grant_total_cents).toBe(2500);

    await expect(orgStub.listManualCreditGrants()).resolves.toEqual([
      {
        grant_id: "grant-metadata-1",
        amount_cents: 2500,
        reason: "test grant",
        created_at: result?.createdAt,
        created_by: ownerId,
        source: "qaml-backdoor",
      },
    ]);
  });

  it("applyManualCreditGrant duplicate idempotency key does not double grant or double audit", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Manual Grant Duplicate Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const first = await orgStub.applyManualCreditGrant(
      1200,
      "duplicate test",
      "grant-duplicate-1",
      { createdBy: ownerId, source: "qaml-backdoor" },
    );
    const duplicate = await orgStub.applyManualCreditGrant(
      1200,
      "duplicate test",
      "grant-duplicate-1",
      { createdBy: ownerId, source: "qaml-backdoor" },
    );

    expect(first?.applied).toBe(true);
    expect(duplicate).toMatchObject({
      applied: false,
      grantId: "grant-duplicate-1",
      amountCents: 1200,
      reason: "duplicate test",
      createdAt: first?.createdAt,
      createdBy: ownerId,
      source: "qaml-backdoor",
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 1200,
    });
    const grants = await orgStub.listManualCreditGrants();
    expect(grants.filter((grant) => grant.grant_id === "grant-duplicate-1"))
      .toHaveLength(1);

    const audit = await orgStub.getAuditLog();
    expect(
      audit.filter((entry) => entry.action === "usage_credit_granted"),
    ).toHaveLength(1);
  });

  it("manual grants do not mutate purchased or stripe billing fields", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Manual Grant Stripe Isolation Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const before = await orgStub.updateBillingState({
      billing_credit_purchase_total_cents: 7300,
      billing_credit_grant_total_cents: 400,
      billing_customer_id: "cus_manual_grant_test",
      billing_subscription_id: "sub_manual_grant_test",
      billing_subscription_status: "active",
      billing_last_included_credit_invoice_id: "in_manual_grant_test",
      billing_trial_credit_grant_cents: 1000,
      billing_trial_credit_granted_at: 1710000000000,
    });

    const result = await orgStub.applyManualCreditGrant(
      900,
      "stripe isolation",
      "grant-stripe-isolation-1",
      { createdBy: ownerId, source: "qaml-backdoor" },
    );

    expect(result?.org.billing_credit_grant_total_cents).toBe(1300);
    expect(result?.org.billing_credit_usage_started_at).toEqual(
      expect.any(Number),
    );
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_purchase_total_cents:
        before?.billing_credit_purchase_total_cents,
      billing_customer_id: before?.billing_customer_id,
      billing_subscription_id: before?.billing_subscription_id,
      billing_subscription_status: before?.billing_subscription_status,
      billing_last_included_credit_invoice_id:
        before?.billing_last_included_credit_invoice_id,
      billing_trial_credit_grant_cents:
        before?.billing_trial_credit_grant_cents,
      billing_trial_credit_granted_at: before?.billing_trial_credit_granted_at,
    });
  });

  it("listManualCreditGrants returns newest first and limits results", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Manual Grant List Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await orgStub.applyManualCreditGrant(100, "first", "grant-list-1", {
      createdBy: ownerId,
      source: "qaml-backdoor",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await orgStub.applyManualCreditGrant(200, "second", "grant-list-2", {
      createdBy: ownerId,
      source: "qaml-backdoor",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await orgStub.applyManualCreditGrant(300, "third", "grant-list-3", {
      createdBy: ownerId,
      source: "qaml-backdoor",
    });

    await expect(orgStub.listManualCreditGrants(2)).resolves.toMatchObject([
      { grant_id: "grant-list-3" },
      { grant_id: "grant-list-2" },
    ]);
  });

  it("atomically records and credits each Stripe invoice exactly once", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Invoice Ledger Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "active",
      billing_plan: "team",
      billing_seat_count: 7,
      billing_customer_id: "cus_current",
      billing_subscription_id: "sub_current",
      billing_subscription_status: "active",
      billing_credit_grant_total_cents: 300,
    });
    const command = {
      invoiceId: `in_${crypto.randomUUID()}`,
      subscriptionId: "sub_ledger",
      customerId: "cus_ledger",
      billingReason: "subscription_cycle" as const,
      source: "renewal" as const,
      plan: "pro" as const,
      seatCount: 1,
      grantCents: 4000,
    };

    const [first, duplicate] = await Promise.all([
      orgStub.applySubscriptionInvoiceGrant(command),
      orgStub.applySubscriptionInvoiceGrant(command),
    ]);

    expect([first?.applied, duplicate?.applied].sort()).toEqual([false, true]);
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_customer_id: "cus_current",
      billing_subscription_id: "sub_current",
      billing_plan: "team",
      billing_seat_count: 7,
      billing_credit_grant_total_cents: 4300,
      billing_last_included_credit_invoice_id: command.invoiceId,
    });
    await expect(
      orgStub.getSubscriptionInvoiceGrant(command.invoiceId),
    ).resolves.toMatchObject({
      invoice_id: command.invoiceId,
      amount_cents: 4000,
      source: "renewal",
    });
  });

  it("rejects immutable conflicts for an already-recorded invoice", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Invoice Conflict Org", ownerId, {
      billingPlan: "pro",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const command = {
      invoiceId: `in_${crypto.randomUUID()}`,
      subscriptionId: "sub_conflict",
      customerId: "cus_conflict",
      billingReason: "subscription_update" as const,
      source: "plan_change" as const,
      plan: "team" as const,
      seatCount: 3,
      grantCents: 1500,
    };
    await orgStub.applySubscriptionInvoiceGrant(command);

    await expect(
      orgStub.applySubscriptionInvoiceGrant({ ...command, grantCents: 1600 }),
    ).resolves.toMatchObject({
      applied: false,
      credited: false,
      invariantError: expect.stringContaining("conflicting immutable grant fields"),
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 1500,
    });
  });

  it("records zero grants and suppresses credits for enterprise organizations", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Invoice Enterprise Org", ownerId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_credit_grant_total_cents: 700,
    });
    const enterpriseInvoiceId = `in_${crypto.randomUUID()}`;
    const result = await orgStub.applySubscriptionInvoiceGrant({
      invoiceId: enterpriseInvoiceId,
      subscriptionId: "sub_enterprise",
      customerId: "cus_enterprise",
      billingReason: "subscription_cycle",
      source: "renewal",
      plan: "pro",
      seatCount: 1,
      grantCents: 4000,
    });

    expect(result).toMatchObject({ applied: true, credited: false });
    expect(result?.org).toMatchObject({
      billing_status: "enterprise",
      billing_plan: "enterprise",
      billing_credit_grant_total_cents: 700,
    });
    const zeroInvoiceId = `in_${crypto.randomUUID()}`;
    await expect(
      orgStub.applySubscriptionInvoiceGrant({
        invoiceId: zeroInvoiceId,
        subscriptionId: "sub_enterprise",
        customerId: "cus_enterprise",
        billingReason: "subscription_update",
        source: "plan_change",
        plan: "starter",
        seatCount: 1,
        grantCents: 0,
      }),
    ).resolves.toMatchObject({ applied: true, credited: false });
    await expect(
      orgStub.getSubscriptionInvoiceGrant(zeroInvoiceId),
    ).resolves.toMatchObject({ amount_cents: 0 });
  });

  it("seeds a legacy-processed ledger row from the last-invoice compatibility marker", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Invoice Bridge Org", ownerId, {
      billingPlan: "pro",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const invoiceId = `in_${crypto.randomUUID()}`;
    await orgStub.updateBillingState({
      billing_credit_grant_total_cents: 4000,
      billing_last_included_credit_invoice_id: invoiceId,
    });

    await expect(
      orgStub.applySubscriptionInvoiceGrant({
        invoiceId,
        subscriptionId: "sub_bridge",
        customerId: "cus_bridge",
        billingReason: "subscription_cycle",
        source: "renewal",
        plan: "pro",
        seatCount: 1,
        grantCents: 4000,
      }),
    ).resolves.toMatchObject({
      applied: true,
      credited: false,
      legacyProcessed: true,
    });
    await expect(orgStub.getInfo()).resolves.toMatchObject({
      billing_credit_grant_total_cents: 4000,
    });
    await expect(
      orgStub.getSubscriptionInvoiceGrant(invoiceId),
    ).resolves.toMatchObject({ source: "legacy_processed", amount_cents: 0 });
  });

  it("does not re-grant a migration covered by the deterministic legacy manual grant", async () => {
    const { userId: ownerId } = await createUser(
      testEnv,
      testEmail(),
      "password",
      "Owner",
    );
    const { org } = await createOrg(testEnv, "Migration Grant Bridge Org", ownerId, {
      billingPlan: "pro",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const subscriptionId = "sub_migration_bridge";
    await orgStub.applyManualCreditGrant(
      4000,
      "Legacy Stripe migration current-period included credits",
      `legacy-migration:${org.id}:${subscriptionId}:pro:current-period-included-credits`,
      { source: "stripe-migration" },
    );

    const result = await orgStub.applySubscriptionInvoiceGrant({
      invoiceId: `in_${crypto.randomUUID()}`,
      subscriptionId,
      customerId: "cus_migration_bridge",
      billingReason: "subscription_update",
      source: "legacy_migration",
      plan: "pro",
      seatCount: 1,
      grantCents: 4000,
    });

    expect(result).toMatchObject({
      applied: true,
      credited: false,
      legacyProcessed: true,
    });
    expect(result?.org.billing_credit_grant_total_cents).toBe(4000);
  });
});
