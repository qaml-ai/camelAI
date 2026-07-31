import type { Store } from "./store.ts";

export type BillingAccount = {
  orgId: string;
  /** Available credits in USD cents. */
  creditBalanceCents: number;
  updatedAt: string;
};

function billingKey(orgId: string): string {
  return `billing:${orgId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Lightweight billing stub: per-org credit balance persisted via Store.
 * Hosted model access requires a positive balance.
 */
export class BillingService {
  constructor(private readonly store: Store) {}

  getAccount(orgId: string): BillingAccount {
    this.requireOrgId(orgId);
    const existing = this.store.get<BillingAccount>(billingKey(orgId));
    if (existing) {
      return existing;
    }
    return {
      orgId,
      creditBalanceCents: 0,
      updatedAt: nowIso(),
    };
  }

  getCreditBalance(orgId: string): number {
    return this.getAccount(orgId).creditBalanceCents;
  }

  canUseHostedModel(orgId: string): boolean {
    return this.getCreditBalance(orgId) > 0;
  }

  grantCredits(orgId: string, cents: number): BillingAccount {
    this.requireOrgId(orgId);
    this.requirePositiveCents(cents, "grantCredits");
    const current = this.getAccount(orgId);
    const next: BillingAccount = {
      orgId,
      creditBalanceCents: current.creditBalanceCents + cents,
      updatedAt: nowIso(),
    };
    this.store.set(billingKey(orgId), next);
    return next;
  }

  consumeCredits(orgId: string, cents: number): BillingAccount {
    this.requireOrgId(orgId);
    this.requirePositiveCents(cents, "consumeCredits");
    const current = this.getAccount(orgId);
    if (current.creditBalanceCents < cents) {
      throw new Error(
        `consumeCredits: insufficient credits for org ${orgId} ` +
          `(have ${current.creditBalanceCents}¢, need ${cents}¢)`,
      );
    }
    const next: BillingAccount = {
      orgId,
      creditBalanceCents: current.creditBalanceCents - cents,
      updatedAt: nowIso(),
    };
    this.store.set(billingKey(orgId), next);
    return next;
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
}
