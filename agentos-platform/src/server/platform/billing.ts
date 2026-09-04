import type { Store } from "./store.ts";
import {
  BILLING_PLANS,
  BILLING_PLAN_LIMITS,
  planAllowsHostedModels,
  type BillingPlan,
} from "../../shared/billing-plans.ts";

export type BillingStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "enterprise";

export type BillingAccount = {
  orgId: string;
  plan: BillingPlan;
  billingStatus: BillingStatus;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  purchasedCreditCents: number;
  includedCreditCents: number;
  creditGrantTotalCents: number;
  usageChargeCents: number;
  seatCount: number;
  lastIncludedCreditInvoiceId?: string;
  updatedAt: string;
};

function billingKey(orgId: string): string {
  return `billing:${orgId}`;
}

function idempotencyKey(
  kind: "included" | "purchased",
  orgId: string,
  sourceId: string,
): string {
  return `billing-idempotency:${kind}:${orgId}:${sourceId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Per-org billing state persisted via Store.
 *
 * Credit balance is derived from durable grant and usage totals rather than
 * maintained as a second mutable value that can drift.
 */
export class BillingService {
  constructor(private readonly store: Store) {}

  getAccount(orgId: string): BillingAccount {
    this.requireOrgId(orgId);
    const existing = this.store.get<
      Partial<BillingAccount> & { creditBalanceCents?: number }
    >(billingKey(orgId));
    if (existing) {
      return this.normalizeAccount(orgId, existing);
    }
    return {
      orgId,
      plan: "payg",
      billingStatus: "none",
      purchasedCreditCents: 0,
      includedCreditCents: 0,
      creditGrantTotalCents: 0,
      usageChargeCents: 0,
      seatCount: 1,
      updatedAt: nowIso(),
    };
  }

  getCreditBalance(orgId: string): number {
    const account = this.getAccount(orgId);
    return Math.max(
      0,
      account.purchasedCreditCents +
        account.includedCreditCents +
        account.creditGrantTotalCents -
        account.usageChargeCents,
    );
  }

  canUseHostedModel(orgId: string): boolean {
    const account = this.getAccount(orgId);
    if (
      account.plan === "enterprise" ||
      account.billingStatus === "enterprise"
    ) {
      return true;
    }
    if (!planAllowsHostedModels(account.plan)) {
      return false;
    }
    if (this.getCreditBalance(orgId) <= 0) {
      return false;
    }
    return (
      account.plan === "payg" ||
      account.billingStatus === "trialing" ||
      account.billingStatus === "active"
    );
  }

  setPlan(
    orgId: string,
    plan: BillingPlan,
    seatCount?: number,
  ): BillingAccount {
    this.requireOrgId(orgId);
    if (!BILLING_PLANS.includes(plan)) {
      throw new Error(`setPlan: unsupported billing plan ${String(plan)}`);
    }
    const current = this.getAccount(orgId);
    const nextSeatCount = this.normalizeSeatCount(
      plan,
      seatCount ?? current.seatCount,
    );
    return this.save({
      ...current,
      plan,
      seatCount: nextSeatCount,
      updatedAt: nowIso(),
    });
  }

  setBillingStatus(orgId: string, billingStatus: BillingStatus): BillingAccount {
    this.requireOrgId(orgId);
    const allowed: readonly BillingStatus[] = [
      "none",
      "trialing",
      "active",
      "past_due",
      "canceled",
      "enterprise",
    ];
    if (!allowed.includes(billingStatus)) {
      throw new Error(
        `setBillingStatus: unsupported status ${String(billingStatus)}`,
      );
    }
    return this.save({
      ...this.getAccount(orgId),
      billingStatus,
      updatedAt: nowIso(),
    });
  }

  setStripeIds(
    orgId: string,
    ids:
      | {
          customerId?: string | null;
          subscriptionId?: string | null;
        }
      | string
      | null,
    subscriptionId?: string | null,
  ): BillingAccount {
    this.requireOrgId(orgId);
    const current = this.getAccount(orgId);
    const values =
      ids !== null && typeof ids === "object"
        ? ids
        : { customerId: ids, subscriptionId };
    const next = { ...current, updatedAt: nowIso() };
    if (values.customerId !== undefined) {
      this.assignOptionalId(next, "stripeCustomerId", values.customerId);
    }
    if (values.subscriptionId !== undefined) {
      this.assignOptionalId(
        next,
        "stripeSubscriptionId",
        values.subscriptionId,
      );
    }
    return this.save(next);
  }

  grantIncludedCredits(
    orgId: string,
    cents: number,
    invoiceId: string,
  ): BillingAccount {
    this.requireOrgId(orgId);
    this.requirePositiveCents(cents, "grantIncludedCredits");
    this.requireSourceId(invoiceId, "grantIncludedCredits", "invoiceId");
    const key = idempotencyKey("included", orgId, invoiceId);
    if (this.store.get(key)) {
      return this.getAccount(orgId);
    }
    const current = this.getAccount(orgId);
    const next = this.save({
      ...current,
      includedCreditCents: current.includedCreditCents + cents,
      lastIncludedCreditInvoiceId: invoiceId,
      updatedAt: nowIso(),
    });
    this.store.set(key, true);
    return next;
  }

  grantPurchasedCredits(
    orgId: string,
    cents: number,
    checkoutSessionId: string,
  ): BillingAccount {
    this.requireOrgId(orgId);
    this.requirePositiveCents(cents, "grantPurchasedCredits");
    this.requireSourceId(
      checkoutSessionId,
      "grantPurchasedCredits",
      "checkoutSessionId",
    );
    const key = idempotencyKey("purchased", orgId, checkoutSessionId);
    if (this.store.get(key)) {
      return this.getAccount(orgId);
    }
    const current = this.getAccount(orgId);
    const next = this.save({
      ...current,
      purchasedCreditCents: current.purchasedCreditCents + cents,
      updatedAt: nowIso(),
    });
    this.store.set(key, true);
    return next;
  }

  grantCredits(orgId: string, cents: number): BillingAccount {
    this.requireOrgId(orgId);
    this.requirePositiveCents(cents, "grantCredits");
    const current = this.getAccount(orgId);
    return this.save({
      ...current,
      creditGrantTotalCents: current.creditGrantTotalCents + cents,
      updatedAt: nowIso(),
    });
  }

  consumeCredits(orgId: string, cents: number): BillingAccount {
    this.requireOrgId(orgId);
    this.requirePositiveCents(cents, "consumeCredits");
    const current = this.getAccount(orgId);
    const balance = this.getCreditBalance(orgId);
    if (balance < cents) {
      throw new Error(
        `consumeCredits: insufficient credits for org ${orgId} ` +
          `(have ${balance}¢, need ${cents}¢)`,
      );
    }
    return this.save({
      ...current,
      usageChargeCents: current.usageChargeCents + cents,
      updatedAt: nowIso(),
    });
  }

  private normalizeAccount(
    orgId: string,
    existing: Partial<BillingAccount> & { creditBalanceCents?: number },
  ): BillingAccount {
    const plan = BILLING_PLANS.includes(existing.plan as BillingPlan)
      ? (existing.plan as BillingPlan)
      : "payg";
    const billingStatus = this.isBillingStatus(existing.billingStatus)
      ? existing.billingStatus
      : "none";
    const legacyBalance = this.nonNegativeCents(existing.creditBalanceCents);
    return {
      orgId,
      plan,
      billingStatus,
      ...(existing.stripeCustomerId
        ? { stripeCustomerId: existing.stripeCustomerId }
        : {}),
      ...(existing.stripeSubscriptionId
        ? { stripeSubscriptionId: existing.stripeSubscriptionId }
        : {}),
      purchasedCreditCents: this.nonNegativeCents(
        existing.purchasedCreditCents,
      ),
      includedCreditCents: this.nonNegativeCents(existing.includedCreditCents),
      creditGrantTotalCents:
        existing.creditGrantTotalCents === undefined
          ? legacyBalance
          : this.nonNegativeCents(existing.creditGrantTotalCents),
      usageChargeCents: this.nonNegativeCents(existing.usageChargeCents),
      seatCount: this.normalizeSeatCount(plan, existing.seatCount ?? 1),
      ...(existing.lastIncludedCreditInvoiceId
        ? {
            lastIncludedCreditInvoiceId:
              existing.lastIncludedCreditInvoiceId,
          }
        : {}),
      updatedAt: existing.updatedAt ?? nowIso(),
    };
  }

  private save(account: BillingAccount): BillingAccount {
    this.store.set(billingKey(account.orgId), account);
    return account;
  }

  private requireOrgId(orgId: string): void {
    if (!orgId?.trim()) {
      throw new Error("BillingService: orgId is required");
    }
  }

  private requirePositiveCents(cents: number, op: string): void {
    if (!Number.isFinite(cents) || !Number.isInteger(cents) || cents <= 0) {
      throw new Error(`${op}: cents must be a positive integer`);
    }
  }

  private requireSourceId(value: string, op: string, field: string): void {
    if (!value?.trim()) {
      throw new Error(`${op}: ${field} is required`);
    }
  }

  private nonNegativeCents(value: number | undefined): number {
    return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? (value ?? 0) : 0;
  }

  private normalizeSeatCount(plan: BillingPlan, seatCount: number): number {
    if (!Number.isFinite(seatCount)) {
      return BILLING_PLAN_LIMITS[plan].minimumSeats;
    }
    return Math.max(
      BILLING_PLAN_LIMITS[plan].minimumSeats,
      Math.floor(seatCount),
    );
  }

  private isBillingStatus(value: unknown): value is BillingStatus {
    return (
      value === "none" ||
      value === "trialing" ||
      value === "active" ||
      value === "past_due" ||
      value === "canceled" ||
      value === "enterprise"
    );
  }

  private assignOptionalId(
    account: BillingAccount,
    field: "stripeCustomerId" | "stripeSubscriptionId",
    value: string | null,
  ): void {
    const trimmed = value?.trim();
    if (trimmed) {
      account[field] = trimmed;
    } else {
      delete account[field];
    }
  }
}
