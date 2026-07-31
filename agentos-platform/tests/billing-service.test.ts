import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BillingService } from "../src/server/platform/billing.ts";
import { Store } from "../src/server/platform/store.ts";

const tempDirs: string[] = [];

function createBilling(): { billing: BillingService; store: Store } {
  const dataDir = mkdtempSync(join(tmpdir(), "agentos-billing-"));
  tempDirs.push(dataDir);
  const store = new Store({ dataDir });
  return { billing: new BillingService(store), store };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("BillingService accounts", () => {
  it("creates a pay-as-you-go account with production ledger fields", () => {
    const { billing } = createBilling();
    expect(billing.getAccount("org-1")).toMatchObject({
      orgId: "org-1",
      plan: "payg",
      billingStatus: "none",
      purchasedCreditCents: 0,
      includedCreditCents: 0,
      creditGrantTotalCents: 0,
      usageChargeCents: 0,
      seatCount: 1,
    });
    expect(billing.getCreditBalance("org-1")).toBe(0);
  });

  it("derives balance from all grant sources minus metered usage", () => {
    const { billing } = createBilling();
    billing.grantPurchasedCredits("org-1", 500, "cs_1");
    billing.grantIncludedCredits("org-1", 1000, "in_1");
    billing.grantCredits("org-1", 250);
    billing.consumeCredits("org-1", 600);

    expect(billing.getAccount("org-1")).toMatchObject({
      purchasedCreditCents: 500,
      includedCreditCents: 1000,
      creditGrantTotalCents: 250,
      usageChargeCents: 600,
      lastIncludedCreditInvoiceId: "in_1",
    });
    expect(billing.getCreditBalance("org-1")).toBe(1150);
  });

  it("makes Stripe-origin grants idempotent", () => {
    const { billing } = createBilling();
    billing.grantPurchasedCredits("org-1", 500, "cs_same");
    billing.grantPurchasedCredits("org-1", 500, "cs_same");
    billing.grantIncludedCredits("org-1", 1000, "in_same");
    billing.grantIncludedCredits("org-1", 1000, "in_same");
    expect(billing.getCreditBalance("org-1")).toBe(1500);
  });

  it("enforces hosted-model plan, status, and credit rules", () => {
    const { billing } = createBilling();
    billing.grantCredits("org-1", 100);
    expect(billing.canUseHostedModel("org-1")).toBe(true);

    billing.setPlan("org-1", "free");
    expect(billing.canUseHostedModel("org-1")).toBe(false);

    billing.setPlan("org-1", "starter");
    expect(billing.canUseHostedModel("org-1")).toBe(false);
    billing.setBillingStatus("org-1", "active");
    expect(billing.canUseHostedModel("org-1")).toBe(true);
    billing.consumeCredits("org-1", 100);
    expect(billing.canUseHostedModel("org-1")).toBe(false);

    billing.setPlan("org-1", "enterprise");
    expect(billing.canUseHostedModel("org-1")).toBe(true);
  });

  it("normalizes team seats and persists Stripe identifiers", () => {
    const { billing } = createBilling();
    billing.setPlan("org-1", "team", 1);
    billing.setStripeIds("org-1", {
      customerId: "cus_1",
      subscriptionId: "sub_1",
    });
    expect(billing.getAccount("org-1")).toMatchObject({
      plan: "team",
      seatCount: 3,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
  });

  it("preserves balances written by the Phase 1 billing stub", () => {
    const { billing, store } = createBilling();
    store.set("billing:legacy", {
      orgId: "legacy",
      creditBalanceCents: 375,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(billing.getCreditBalance("legacy")).toBe(375);
    expect(billing.getAccount("legacy").creditGrantTotalCents).toBe(375);
  });
});
