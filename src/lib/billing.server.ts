import type { BillingPlan, BillingStatus, Organization } from "@/types";
import type {
  ApplySubscriptionInvoiceGrantResult,
  OrgDO,
  SubscriptionInvoiceGrantCommand,
  SubscriptionInvoiceGrantRow,
} from "../../workers/main/src/auth";
import {
  getBillingPlanLimits,
  getIncludedCreditCentsForPlan,
  getMinimumSeats,
  getOrgBillingPlan,
  normalizeBillingPlan,
  normalizeSeatCount,
} from "@/lib/billing-plans";
import { canBuyCreditsForBillingState } from "@/lib/billing-credit-packs";
import { isSelfhostRuntime, type SelfhostRuntimeEnv } from "@/lib/selfhost-runtime";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
export const STRIPE_API_VERSION = "2026-06-24.dahlia";
const CREDIT_CHECKOUT_EVENT_PREFIX = "stripe_checkout_credits:";
const INCLUDED_CREDIT_INVOICE_EVENT_PREFIX = "stripe_invoice_included_credit:";
const BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION = 5;
const BILLING_PORTAL_CONFIGURATION_KV_PREFIX = "stripe_billing_portal_configuration:";
const LEGACY_MIGRATION_META_ORG_ID = "v2_mig_org";
const LEGACY_MIGRATION_META_SUBSCRIPTION_ID = "v2_mig_sub";
const LEGACY_MIGRATION_META_TARGET_PLAN = "v2_mig_plan";
const LEGACY_MIGRATION_META_SEAT_COUNT = "v2_mig_seats";
const LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS = "v2_mig_credits";
const LEGACY_MIGRATION_META_SOURCE_PRICE_ID = "v2_mig_price";
export const DEFAULT_TRIAL_CREDIT_CENTS = 1000;
export const DEFAULT_SUBSCRIPTION_INCLUDED_CREDIT_CENTS = 1000;
const NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES = new Set([
  "canceled",
  "incomplete_expired",
]);

type SubscriptionBillingPlan = Exclude<
  BillingPlan,
  "free" | "payg" | "enterprise"
>;

export interface StripeBillingEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  APP_KV?: KVNamespace;
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET_NEXT?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID?: string;
  STRIPE_STARTER_PRICE_ID?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_TEAM_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_IDS?: string;
  BILLING_TRIAL_CREDIT_CENTS?: string;
  BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}

export interface StripeCustomer {
  id: string;
  email?: string | null;
  metadata?: Record<string, string>;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer?: string | StripeCustomer | null;
  metadata?: Record<string, string>;
  quantity?: number | null;
  trial_start?: number | null;
  trial_end?: number | null;
  current_period_end?: number | null;
  cancel_at?: number | null;
  canceled_at?: number | null;
  cancel_at_period_end?: boolean | null;
  items?: {
    data?: StripeSubscriptionItem[];
  } | null;
}

export type BillingPortalMode = "management" | "upgrade" | "downgrade";

export interface CanonicalPaidPlanCatalogEntry {
  plan: SubscriptionBillingPlan;
  productId: string;
  priceId: string;
  unitAmount: number;
  currency: "usd";
  interval: "month";
  intervalCount: 1;
}

export interface StripeSubscriptionItem {
  id: string;
  quantity?: number | null;
  price?: string | StripePriceSummary | null;
  current_period_start?: number | null;
  current_period_end?: number | null;
}

export interface StripeInvoiceListEntry {
  id: string;
  created: number;
  amount_paid?: number | null;
  amount_due?: number | null;
  total?: number | null;
  currency: string;
  status?: string | null;
  hosted_invoice_url?: string | null;
}

export interface StripeSubscriptionSummary {
  id: string;
  status: string;
  current_period_end_ms: number | null;
  cancel_at_ms: number | null;
  cancellation_date_ms: number | null;
  cancel_at_period_end: boolean;
  is_canceling: boolean;
  trial_end_ms: number | null;
}

export interface StripeCheckoutSession {
  id: string;
  mode?: string | null;
  customer?: string | null;
  subscription?: string | null;
  payment_status?: string | null;
  amount_subtotal?: number | null;
  amount_total?: number | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
  url?: string | null;
}

export interface StripeInvoice {
  id: string;
  customer?: string | StripeCustomer | null;
  subscription?: string | StripeSubscription | null;
  status?: string | null;
  paid?: boolean | null;
  amount_paid?: number | null;
  amount_due?: number | null;
  total?: number | null;
  billing_reason?: string | null;
  metadata?: Record<string, string>;
  subscription_details?: {
    metadata?: Record<string, string>;
  } | null;
  parent?: {
    subscription_details?: {
      subscription?: string | StripeSubscription | null;
      metadata?: Record<string, string>;
    } | null;
  } | null;
  lines?: {
    data?: StripeInvoiceLine[];
    has_more?: boolean;
  } | null;
}

export interface StripeInvoiceLine {
  id?: string | null;
  amount?: number | null;
  currency?: string | null;
  description?: string | null;
  quantity?: number | null;
  price?: string | StripePriceSummary | null;
  pricing?: {
    price_details?: {
      price?: string | StripePriceSummary | null;
      product?: string | { id?: string | null } | null;
    } | null;
  } | null;
  proration?: boolean | null;
  type?: string | null;
  subscription_item?: string | null;
  parent?: {
    type?: string | null;
    subscription_item_details?: {
      proration?: boolean | null;
      subscription_item?: string | null;
    } | null;
    invoice_item_details?: unknown;
  } | null;
}

export type PaidSubscriptionInvoiceProcessingResult =
  | {
      status: "ignored";
      reason: string;
      invoiceId: string;
      subscriptionId?: string | null;
    }
  | {
      status: "processed" | "duplicate";
      invoiceId: string;
      subscriptionId: string;
      orgId: string;
      plan: SubscriptionBillingPlan;
      seatCount: number;
      grantCents: number;
      source: SubscriptionInvoiceGrantCommand["source"];
      org: Organization;
    };

export type SubscriptionInvoiceReconciliationReport =
  | {
      status: "ignored";
      invoiceId: string;
      subscriptionId: string | null;
      reason: string;
    }
  | {
      status: "preview" | "processed" | "duplicate";
      invoiceId: string;
      subscriptionId: string;
      orgId: string;
      billingReason: SubscriptionInvoiceGrantCommand["billingReason"];
      plan: SubscriptionBillingPlan;
      seatCount: number;
      source: SubscriptionInvoiceGrantCommand["source"];
      computedGrantCents: number;
      creditedGrantCents: number;
      oldKvMarker: boolean;
      lastInvoiceMarker: string | null;
      ledgerStatus: "not_recorded" | "recorded" | "legacy_processed";
    };

export interface StripeWebhookEvent<T = unknown> {
  id: string;
  type: string;
  data: {
    object: T;
  };
}

export class StaleTrialingSubscriptionStatusError extends Error {
  stripeSubscriptionStatus: string | null | undefined;

  constructor(stripeSubscriptionStatus: string | null | undefined) {
    super("Stripe subscription is no longer trialing.");
    this.name = "StaleTrialingSubscriptionStatusError";
    this.stripeSubscriptionStatus = stripeSubscriptionStatus;
  }
}

export class StripeSubscriptionRequiresManagementError extends Error {
  stripeSubscriptionStatus: string | null | undefined;

  constructor(stripeSubscriptionStatus: string | null | undefined) {
    super("This Stripe subscription must be managed in the billing portal.");
    this.name = "StripeSubscriptionRequiresManagementError";
    this.stripeSubscriptionStatus = stripeSubscriptionStatus;
  }
}

export function isStripeSubscriptionRequiresManagementError(
  error: unknown,
): error is StripeSubscriptionRequiresManagementError {
  return (
    error instanceof StripeSubscriptionRequiresManagementError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "StripeSubscriptionRequiresManagementError")
  );
}

export function isStaleTrialingSubscriptionStatusError(
  error: unknown,
): error is StaleTrialingSubscriptionStatusError {
  return (
    error instanceof StaleTrialingSubscriptionStatusError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name ===
        "StaleTrialingSubscriptionStatusError")
  );
}

const RECURRING_INCLUDED_CREDIT_BILLING_REASONS = new Set([
  "subscription_cycle",
]);

const LEGACY_INDIVIDUAL_PRICE_IDS = new Set([
  "price_1QIfnqGvliMKf4vHaDTMG2Mu",
  "price_1QIfnqGvliMKf4vHOeGHG69q",
  // Stripe test-mode fixture for staging legacy migration QA.
  "price_1TSMnnGvliMKf4vHrdn58Izi",
]);

const LEGACY_TEAM_PRICE_IDS = new Set(["price_1S6NRLGvliMKf4vHtFDiA07o"]);

const LEGACY_MIGRATION_PRICE_IDS = new Set([
  ...LEGACY_INDIVIDUAL_PRICE_IDS,
  ...LEGACY_TEAM_PRICE_IDS,
]);

// Prices retired by the July 2026 Starter/Pro pricing rollout. Keep recognizing
// them while the out-of-band subscription migration converges, and for
// already-issued invoices that can be paid after a subscription has moved to
// the replacement price.
const RETIRED_PRICING_ROLLOUT_PRICES = new Map<
  string,
  {
    plan: "starter" | "pro";
    unitAmount: number;
    includedCreditCents: number;
  }
>([
  [
    "price_1TS5SoGvliMKf4vHohXqB19x",
    { plan: "starter", unitAmount: 4000, includedCreditCents: 1000 },
  ],
  [
    "price_1TS5SoGvliMKf4vHmzDcxSXF",
    { plan: "pro", unitAmount: 15000, includedCreditCents: 3000 },
  ],
  [
    "price_1TRzJ5GvliMKf4vHt5P6ODiY",
    { plan: "starter", unitAmount: 4000, includedCreditCents: 1000 },
  ],
  [
    "price_1TRzJDGvliMKf4vHiCvInGpn",
    { plan: "pro", unitAmount: 15000, includedCreditCents: 3000 },
  ],
]);

const STRIPE_CHECKOUT_MAX_ADJUSTABLE_QUANTITY = 999_999;

interface UsageLogSumResponse {
  total_cost_usd: number;
  total_requests: number;
}

interface OrgSpendResponse {
  total_cost_usd: number;
  total_requests: number;
}

export interface StripePriceSummary {
  id: string;
  unit_amount: number | null;
  currency: string;
  active?: boolean;
  product?: string | { id?: string | null } | null;
  recurring?: {
    interval: string;
    interval_count?: number;
  } | null;
}

export interface ConfiguredCreditPack extends StripePriceSummary {}

export interface OrgBillingAccessSnapshot {
  org_id: string;
  billing_status: BillingStatus;
  billing_plan: BillingPlan;
  billing_seat_count: number;
  billing_subscription_status: string | null;
  billing_trial_started_at: number | null;
  billing_trial_ends_at: number | null;
  billing_credit_purchase_total_cents: number;
  billing_credit_grant_total_cents: number;
  billing_trial_credit_grant_cents: number;
  billing_trial_credit_granted_at: number | null;
  billing_free_credit_grant_cents: number;
  billing_free_credit_granted_at: number | null;
  billing_last_included_credit_invoice_id: string | null;
  billing_credit_usage_started_at: number | null;
}

export interface OrgBillingOverview extends OrgBillingAccessSnapshot {
  lifetime_spend_cents: number;
  chargeable_usage_cents: number;
  chargeable_request_count: number;
  available_credits_cents: number;
  total_credit_limit_cents: number;
  trial_credit_allowance_cents: number;
  subscription_included_credit_cents: number;
}

function getOrgStub(env: Pick<StripeBillingEnv, "ORG">, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId));
}

function centsFromUsd(amountUsd: number): number {
  return Math.max(0, Math.round(amountUsd * 100));
}

export function isStripeSecretKeyAllowedForMode(
  secretKey: string | null | undefined,
  mode: string | null | undefined,
): boolean {
  const normalizedMode = mode?.trim().toLowerCase();
  if (!normalizedMode) return true;

  const trimmedKey = secretKey?.trim() ?? "";
  if (normalizedMode === "test") {
    return (
      trimmedKey.startsWith("sk_test_") || trimmedKey.startsWith("rk_test_")
    );
  }
  if (normalizedMode === "live") {
    return (
      trimmedKey.startsWith("sk_live_") || trimmedKey.startsWith("rk_live_")
    );
  }
  return false;
}

function assertStripeSecretKeyMatchesMode(
  secretKey: string,
  mode: string | null | undefined,
): void {
  if (!isStripeSecretKeyAllowedForMode(secretKey, mode)) {
    throw new Error(
      `Stripe secret key does not match configured STRIPE_MODE=${mode?.trim() || "unset"}`,
    );
  }
}

function parseCreditCents(
  rawValue: string | null | undefined,
  fallbackCents: number,
): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallbackCents;
  return Math.max(0, Math.floor(parsed));
}

export function getBillingAllowanceConfig(
  env: Pick<
    StripeBillingEnv,
    "BILLING_TRIAL_CREDIT_CENTS" | "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS"
  >,
): {
  trialCreditCents: number;
  subscriptionIncludedCreditCents: number;
} {
  return {
    trialCreditCents: parseCreditCents(
      env.BILLING_TRIAL_CREDIT_CENTS,
      DEFAULT_TRIAL_CREDIT_CENTS,
    ),
    subscriptionIncludedCreditCents: parseCreditCents(
      env.BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS,
      DEFAULT_SUBSCRIPTION_INCLUDED_CREDIT_CENTS,
    ),
  };
}

function getConfiguredCreditCents(
  rawValue: string | null | undefined,
  fallbackCents: number,
): number {
  if (rawValue === undefined || rawValue === null || rawValue.trim() === "") {
    return fallbackCents;
  }
  return parseCreditCents(rawValue, fallbackCents);
}

function getDefaultTrialCreditCentsForPlan(
  plan: BillingPlan,
  seatCount: number,
): number {
  if (plan === "team") {
    return DEFAULT_TRIAL_CREDIT_CENTS;
  }
  return getIncludedCreditCentsForPlan(plan, seatCount);
}

function getTrialCreditCentsForPlan(
  env: Pick<StripeBillingEnv, "BILLING_TRIAL_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return getConfiguredCreditCents(
    env.BILLING_TRIAL_CREDIT_CENTS,
    getDefaultTrialCreditCentsForPlan(plan, seatCount),
  );
}

function getSubscriptionIncludedCreditCentsForPlan(
  env: Pick<StripeBillingEnv, "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return getConfiguredCreditCents(
    env.BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS,
    getIncludedCreditCentsForPlan(plan, seatCount),
  );
}

function getStripePriceId(
  price: string | StripePriceSummary | null | undefined,
) {
  return typeof price === "string" ? price : (price?.id ?? null);
}

function getStripeProductId(price: StripePriceSummary | null | undefined) {
  const product = price?.product;
  if (!product) return null;
  if (typeof product === "string") return product;
  return product.id?.trim() || null;
}

function getStripeSubscriptionSeatQuantity(
  subscription: StripeSubscription,
  priceId: string | null,
): number | null {
  const items = subscription.items?.data ?? [];
  const matchingItem = priceId
    ? items.find((item) => getStripePriceId(item.price) === priceId)
    : null;
  const quantity = matchingItem?.quantity ?? items[0]?.quantity;
  if (typeof quantity === "number" && Number.isFinite(quantity)) {
    return quantity;
  }
  return subscription.quantity ?? null;
}

function normalizeBillingStatus(
  status: string | null | undefined,
): BillingStatus {
  switch (status) {
    case "trialing":
    case "active":
    case "enterprise":
    case "past_due":
    case "canceled":
      return status;
    case "paying":
      return "active";
    default:
      return "inactive";
  }
}

function mapStripeSubscriptionStatus(
  status: string | null | undefined,
): BillingStatus {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      return "inactive";
  }
}

function mapStripeSubscriptionBillingStatus(
  subscription: Pick<StripeSubscription, "status">,
): BillingStatus {
  return mapStripeSubscriptionStatus(subscription.status);
}

function isTerminalStripeSubscriptionStatus(
  status: string | null | undefined,
): boolean {
  return (
    status === "canceled" ||
    NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.has(status ?? "")
  );
}

function stripeTimestampMs(seconds: number | null | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return seconds * 1000;
}

function getSubscriptionPeriodEndSeconds(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): number | null | undefined {
  const paidPriceIds = new Set(
    (["starter", "pro", "team"] as const)
      .map((plan) => getConfiguredSubscriptionPriceId(env, plan))
      .filter((priceId): priceId is string => Boolean(priceId)),
  );
  const items = subscription.items?.data ?? [];
  const paidItems = items.filter((item) =>
    paidPriceIds.has(getStripePriceId(item.price) ?? ""),
  );
  if (paidItems.length === 1 && paidItems[0].current_period_end) {
    return paidItems[0].current_period_end;
  }
  const itemPeriodEnds = items
    .map((item) => item.current_period_end)
    .filter(
      (periodEnd): periodEnd is number =>
        typeof periodEnd === "number" &&
        Number.isFinite(periodEnd) &&
        periodEnd > 0,
    );
  return itemPeriodEnds.length > 0
    ? Math.min(...itemPeriodEnds)
    : subscription.current_period_end;
}

function getSubscriptionCancellationDateMs(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): number | null {
  const seconds =
    subscription.cancel_at ??
    (subscription.cancel_at_period_end
      ? (getSubscriptionPeriodEndSeconds(env, subscription) ??
        subscription.trial_end)
      : null) ??
    (subscription.status === "canceled"
      ? (subscription.canceled_at ?? null)
      : null);
  return stripeTimestampMs(seconds);
}

function isSubscriptionCanceling(subscription: StripeSubscription): boolean {
  return (
    subscription.cancel_at_period_end === true ||
    Boolean(subscription.cancel_at) ||
    subscription.status === "canceled"
  );
}

function stripeAuthHeaders(secretKey: string): Headers {
  return new Headers({
    Authorization: `Bearer ${secretKey}`,
    "Stripe-Version": STRIPE_API_VERSION,
  });
}

async function stripeRequest<T>(
  env: StripeBillingEnv,
  path: string,
  init: {
    method?: string;
    body?: URLSearchParams;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }
  assertStripeSecretKeyMatchesMode(secretKey, env.STRIPE_MODE);

  const headers = stripeAuthHeaders(secretKey);
  if (init.idempotencyKey?.trim()) {
    headers.set("Idempotency-Key", init.idempotencyKey.trim());
  }
  let body: string | undefined;
  if (init.body) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    body = init.body.toString();
  }

  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Stripe ${path} returned ${response.status}: ${detail}`);
  }

  return response.json() as Promise<T>;
}

async function stripeTestCleanupRequest<T>(
  env: StripeBillingEnv,
  path: string,
  method = "GET",
): Promise<T | null> {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("Stripe secret key is not configured");
  }
  assertStripeSecretKeyMatchesMode(secretKey, env.STRIPE_MODE);
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: stripeAuthHeaders(secretKey),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Stripe test cleanup request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Permanently remove an organization's Stripe test customer and cancel its
 * projected subscription. This is intentionally a server-only cleanup helper
 * for authenticated admin tooling; it must never operate in live mode.
 */
export async function deleteStripeTestCustomerForOrg(
  env: StripeBillingEnv,
  org: Organization,
): Promise<{
  subscription_deleted: boolean;
  customer_deleted: boolean;
  org: Organization;
}> {
  if (env.STRIPE_MODE?.trim().toLowerCase() !== "test") {
    throw new Error("Stripe test customer deletion requires STRIPE_MODE=test");
  }

  const customerId = org.billing_customer_id?.trim() || null;
  const subscriptionId = org.billing_subscription_id?.trim() || null;
  let customerAlreadyDeleted = false;

  if (customerId) {
    const customer = await stripeTestCleanupRequest<
      StripeCustomer & { deleted?: boolean }
    >(
      env,
      `/customers/${customerId}`,
    ).catch(() => {
      throw new Error("Failed to load the Stripe test customer for cleanup");
    });
    customerAlreadyDeleted = !customer || customer.deleted === true;
    const metadataOrgId = customer?.metadata?.org_id?.trim();
    if (!customerAlreadyDeleted && metadataOrgId !== org.id) {
      throw new Error(
        "Stripe customer metadata does not match the target organization",
      );
    }
  }

  if (subscriptionId) {
    const subscription = await stripeTestCleanupRequest<StripeSubscription>(
      env,
      `/subscriptions/${subscriptionId}`,
    ).catch(() => {
      throw new Error("Failed to load the Stripe test subscription for cleanup");
    });
    if (subscription && subscription.metadata?.org_id?.trim() !== org.id) {
      throw new Error(
        "Stripe subscription metadata does not match the target organization",
      );
    }
    const subscriptionCustomerId = getStripeCustomerId(subscription?.customer);
    if (
      customerId &&
      subscriptionCustomerId &&
      subscriptionCustomerId !== customerId
    ) {
      throw new Error(
        "Stripe subscription customer does not match the target organization",
      );
    }
    if (subscription) {
      await stripeTestCleanupRequest<{
        id: string;
        status?: string;
        deleted?: boolean;
      }>(env, `/subscriptions/${subscriptionId}`, "DELETE").catch(() => {
        throw new Error("Failed to cancel the Stripe test subscription");
      });
    }
  }

  if (customerId && !customerAlreadyDeleted) {
    await stripeTestCleanupRequest<{ id: string; deleted?: boolean }>(
      env,
      `/customers/${customerId}`,
      "DELETE",
    ).catch(() => {
      throw new Error("Failed to delete the Stripe test customer");
    });
  }

  const updated = await getOrgStub(env, org.id).updateBillingState({
    billing_status: "inactive",
    billing_plan: "payg",
    billing_seat_count: 1,
    billing_customer_id: null,
    billing_subscription_id: null,
    billing_subscription_status: null,
    billing_trial_started_at: null,
    billing_trial_ends_at: null,
  });
  if (!updated) {
    throw new Error("Organization not found");
  }

  return {
    subscription_deleted: Boolean(subscriptionId),
    customer_deleted: Boolean(customerId && !customerAlreadyDeleted),
    org: updated,
  };
}

export function isStripeBillingConfigured(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SECRET_KEY"
    | "STRIPE_MODE"
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
    | "STRIPE_CREDIT_PRICE_IDS"
    | "STRIPE_CREDIT_PRICE_ID"
  >,
): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY?.trim() &&
    isStripeSecretKeyAllowedForMode(env.STRIPE_SECRET_KEY, env.STRIPE_MODE) &&
    getConfiguredSubscriptionPriceId(env, "starter") &&
    getConfiguredCreditPriceIds(env).length > 0,
  );
}

export function parseStripePriceIdList(
  rawValue: string | null | undefined,
): string[] {
  if (!rawValue) return [];

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of rawValue.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids;
}

function getStripeCustomerId(
  customer: string | StripeCustomer | null | undefined,
): string | null {
  return typeof customer === "string" ? customer : (customer?.id ?? null);
}


const BILLING_SETUP_PATHS = new Set([
  "/settings/organization/billing",
  "/settings/organization/usage",
]);

export type OrgBillingAccessState =
  | {
      kind: "ready";
      mode:
        | "enterprise"
        | "subscription"
        | "byok"
        | "credits"
        | "camel_free"
        | "selfhost";
      setupRouteAccessible: true;
    }
  | {
      kind: "setup_required";
      reason: "missing_llm_provider";
      setupRouteAccessible: boolean;
    };

export function isBillingSetupPath(pathname: string): boolean {
  return BILLING_SETUP_PATHS.has(pathname);
}

export function resolveOrgBillingAccess(args: {
  org:
    | Pick<
        Organization,
        | "billing_status"
        | "billing_credit_purchase_total_cents"
        | "billing_credit_grant_total_cents"
      >
    | null
    | undefined;
  llmProviderConfig?: unknown;
  pathname?: string;
  env?: SelfhostRuntimeEnv;
}): OrgBillingAccessState {
  const setupRouteAccessible = args.pathname
    ? isBillingSetupPath(args.pathname)
    : false;
  if (args.env && isSelfhostRuntime(args.env)) {
    return { kind: "ready", mode: "selfhost", setupRouteAccessible: true };
  }
  const org = args.org;
  if (org?.billing_status === "enterprise") {
    return { kind: "ready", mode: "enterprise", setupRouteAccessible: true };
  }
  if (
    org?.billing_status === "trialing" ||
    org?.billing_status === "active"
  ) {
    return { kind: "ready", mode: "subscription", setupRouteAccessible: true };
  }
  if (args.llmProviderConfig) {
    return { kind: "ready", mode: "byok", setupRouteAccessible: true };
  }

  const totalCreditsCents =
    (org?.billing_credit_purchase_total_cents ?? 0) +
    (org?.billing_credit_grant_total_cents ?? 0);
  if (totalCreditsCents > 0) {
    return { kind: "ready", mode: "credits", setupRouteAccessible: true };
  }

  // camelCode is always available to hosted organizations. A subscription,
  // purchased credits, or a BYOK provider unlocks additional models, but is
  // not required to finish onboarding or enter the application.
  if (org) {
    return { kind: "ready", mode: "camel_free", setupRouteAccessible: true };
  }

  return {
    kind: "setup_required",
    reason: "missing_llm_provider",
    setupRouteAccessible,
  };
}

export function isOrgBillingAccessReady(
  access: OrgBillingAccessState,
): access is Extract<OrgBillingAccessState, { kind: "ready" }> {
  return access.kind === "ready";
}

export function getConfiguredCreditPriceIds(
  env: Pick<
    StripeBillingEnv,
    "STRIPE_CREDIT_PRICE_IDS" | "STRIPE_CREDIT_PRICE_ID"
  >,
): string[] {
  const configured = parseStripePriceIdList(env.STRIPE_CREDIT_PRICE_IDS);
  if (configured.length > 0) {
    return configured;
  }
  return parseStripePriceIdList(env.STRIPE_CREDIT_PRICE_ID);
}

export function getConfiguredSubscriptionPriceId(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
  plan: BillingPlan,
): string | null {
  switch (plan) {
    case "starter":
      return (
        env.STRIPE_STARTER_PRICE_ID?.trim() ||
        env.STRIPE_SUBSCRIPTION_PRICE_ID?.trim() ||
        null
      );
    case "pro":
      return env.STRIPE_PRO_PRICE_ID?.trim() || null;
    case "team":
      return env.STRIPE_TEAM_PRICE_ID?.trim() || null;
    default:
      return null;
  }
}

export async function fetchStripePriceSummary(
  env: StripeBillingEnv,
  priceId: string | null | undefined,
): Promise<StripePriceSummary | null> {
  const trimmedPriceId = priceId?.trim();
  if (!trimmedPriceId || !env.STRIPE_SECRET_KEY?.trim()) {
    return null;
  }

  const response = await stripeRequest<StripePriceSummary>(
    env,
    `/prices/${trimmedPriceId}`,
  );
  return response;
}

function validateCanonicalPaidPlanPrice(
  plan: SubscriptionBillingPlan,
  priceId: string,
  price: StripePriceSummary | null,
): CanonicalPaidPlanCatalogEntry {
  const advertisedAmount = getBillingPlanLimits(plan).monthlyPriceCents;
  const productId = getStripeProductId(price);
  if (
    !price ||
    price.id !== priceId ||
    price.active !== true ||
    advertisedAmount === null ||
    price.unit_amount !== advertisedAmount ||
    price.currency?.toLowerCase() !== "usd" ||
    price.recurring?.interval !== "month" ||
    (price.recurring.interval_count ?? 1) !== 1 ||
    !productId
  ) {
    throw new Error(
      `Stripe ${plan} price ${priceId} does not match the advertised subscription catalog requirements.`,
    );
  }
  return {
    plan,
    productId,
    priceId,
    unitAmount: price.unit_amount,
    currency: "usd",
    interval: "month",
    intervalCount: 1,
  };
}

export async function loadCanonicalPaidPlanCatalog(
  env: StripeBillingEnv,
): Promise<CanonicalPaidPlanCatalogEntry[]> {
  return Promise.all(
    (["starter", "pro", "team"] as const).map(async (plan) => {
      const priceId = getConfiguredSubscriptionPriceId(env, plan);
      if (!priceId) throw new Error(`Stripe ${plan} subscription price is not configured`);
      return validateCanonicalPaidPlanPrice(
        plan,
        priceId,
        await fetchStripePriceSummary(env, priceId),
      );
    }),
  );
}

async function fetchStripeSubscription(
  env: StripeBillingEnv,
  subscriptionId: string,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${subscriptionId}`,
  );
}

function getStripeSubscriptionItemForPlanChange(
  subscription: StripeSubscription,
  currentPriceId: string | null,
): StripeSubscriptionItem {
  const items = subscription.items?.data ?? [];
  const matchingItem = currentPriceId
    ? items.find((item) => getStripePriceId(item.price) === currentPriceId)
    : null;
  if (matchingItem?.id) return matchingItem;
  if (items.length === 1 && items[0]?.id) return items[0];
  throw new Error("Stripe subscription does not have a single plan item");
}

function getPlanFromConfiguredPrice(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
  priceId: string | null | undefined,
): BillingPlan | null {
  const trimmedPriceId = priceId?.trim();
  if (!trimmedPriceId) return null;
  for (const plan of ["starter", "pro", "team"] as const) {
    if (getConfiguredSubscriptionPriceId(env, plan) === trimmedPriceId) {
      return plan;
    }
  }
  return null;
}

function getSubscriptionPlanFromItems(
  env: Pick<
    StripeBillingEnv,
    | "STRIPE_SUBSCRIPTION_PRICE_ID"
    | "STRIPE_STARTER_PRICE_ID"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_TEAM_PRICE_ID"
  >,
  subscription: StripeSubscription,
): { plan: BillingPlan; item: StripeSubscriptionItem } | null {
  for (const item of subscription.items?.data ?? []) {
    const plan = getPlanFromConfiguredPrice(env, getStripePriceId(item.price));
    if (plan) return { plan, item };
  }
  return null;
}

export async function getBillableTeamSeatCount(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  pendingReservedSeatDelta = 0,
): Promise<number | null> {
  const orgStub = getOrgStub(env as StripeBillingEnv, orgId);
  const org = await orgStub.getInfo();
  if (!org || getOrgBillingPlan(org) !== "team") return null;

  return getBillableTeamSeatCountForOrg(env, orgId, pendingReservedSeatDelta);
}

export async function getBillableTeamSeatCountForOrg(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  pendingReservedSeatDelta = 0,
): Promise<number> {
  return normalizeSeatCount(
    "team",
    (await getOccupiedSeatCountForOrg(env, orgId)) + pendingReservedSeatDelta,
  );
}

async function getOccupiedSeatCountForOrg(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
): Promise<number> {
  const orgStub = getOrgStub(env as StripeBillingEnv, orgId);
  const [memberCount, invitations] = await Promise.all([
    orgStub.getMemberCount(),
    orgStub.getInvitations().catch(() => []),
  ]);
  const now = Date.now();
  const activeInvitationCount = invitations.filter(
    (invitation) => invitation.expires_at > now,
  ).length;
  return memberCount + activeInvitationCount;
}

function assertPlanCoversOccupiedSeats(
  plan: SubscriptionBillingPlan,
  seatCount: number,
  occupiedSeatCount: number,
): void {
  if (occupiedSeatCount <= seatCount) return;
  throw new Error(
    `The ${plan} plan includes ${seatCount} seat${seatCount === 1 ? "" : "s"}, but this organization has ${occupiedSeatCount} occupied seats. Remove members or active invitations before changing plans.`,
  );
}

export async function fetchConfiguredCreditPacks(
  env: StripeBillingEnv,
): Promise<ConfiguredCreditPack[]> {
  const priceIds = getConfiguredCreditPriceIds(env);
  if (priceIds.length === 0) {
    return [];
  }

  const packs = await Promise.all(
    priceIds.map((priceId) => fetchStripePriceSummary(env, priceId)),
  );

  return packs
    .filter((pack): pack is ConfiguredCreditPack => Boolean(pack))
    .sort((left, right) => {
      const leftAmount = left.unit_amount ?? Number.MAX_SAFE_INTEGER;
      const rightAmount = right.unit_amount ?? Number.MAX_SAFE_INTEGER;
      return leftAmount - rightAmount;
    });
}

export function getBillingAccessSnapshotForOrg(
  org: Organization,
): OrgBillingAccessSnapshot {
  const effectiveStatus = normalizeBillingStatus(org.billing_status);
  const effectivePlan = normalizeBillingPlan(
    org.billing_plan,
    org.billing_status,
  );

  return {
    org_id: org.id,
    billing_status: effectiveStatus,
    billing_plan: effectivePlan,
    billing_seat_count: normalizeSeatCount(
      effectivePlan,
      org.billing_seat_count,
    ),
    billing_subscription_status: org.billing_subscription_status ?? null,
    billing_trial_started_at: org.billing_trial_started_at ?? null,
    billing_trial_ends_at: org.billing_trial_ends_at ?? null,
    billing_credit_purchase_total_cents:
      org.billing_credit_purchase_total_cents ?? 0,
    billing_credit_grant_total_cents: org.billing_credit_grant_total_cents ?? 0,
    billing_trial_credit_grant_cents: org.billing_trial_credit_grant_cents ?? 0,
    billing_trial_credit_granted_at:
      org.billing_trial_credit_granted_at ?? null,
    billing_free_credit_grant_cents: org.billing_free_credit_grant_cents ?? 0,
    billing_free_credit_granted_at: org.billing_free_credit_granted_at ?? null,
    billing_last_included_credit_invoice_id:
      org.billing_last_included_credit_invoice_id ?? null,
    billing_credit_usage_started_at:
      org.billing_credit_usage_started_at ?? null,
  };
}

async function fetchUsageLogSum(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
  fromMs: number,
  toMs: number,
  chargeableOnly = false,
): Promise<UsageLogSumResponse> {
  return getOrgStub(env, orgId).getUsageLogSum(fromMs, toMs, chargeableOnly);
}

async function fetchLifetimeSpend(
  env: Pick<StripeBillingEnv, "ORG">,
  orgId: string,
): Promise<OrgSpendResponse> {
  return getOrgStub(env, orgId).getUsageSpend();
}

export async function getOrgBillingOverview(
  env: StripeBillingEnv,
  org: Organization,
): Promise<OrgBillingOverview> {
  const snapshot = getBillingAccessSnapshotForOrg(org);

  const now = Date.now();
  const [lifetimeSpend, chargeableUsage] = await Promise.all([
    fetchLifetimeSpend(env, org.id).catch(() => ({
      total_cost_usd: 0,
      total_requests: 0,
    })),
    fetchUsageLogSum(env, org.id, 0, now, true).catch(() => ({
      total_cost_usd: 0,
      total_requests: 0,
    })),
  ]);

  const chargeableUsageCents = centsFromUsd(
    chargeableUsage.total_cost_usd ?? 0,
  );
  const totalCreditLimitCents =
    snapshot.billing_credit_purchase_total_cents +
    snapshot.billing_credit_grant_total_cents;
  const availableCreditsCents = Math.max(
    0,
    totalCreditLimitCents - chargeableUsageCents,
  );
  const trialCreditCents = getTrialCreditCentsForPlan(
    env,
    snapshot.billing_plan,
    snapshot.billing_seat_count,
  );
  const subscriptionIncludedCreditCents =
    getSubscriptionIncludedCreditCentsForPlan(
      env,
      snapshot.billing_plan,
      snapshot.billing_seat_count,
    );

  return {
    ...snapshot,
    lifetime_spend_cents: centsFromUsd(lifetimeSpend.total_cost_usd ?? 0),
    chargeable_usage_cents: chargeableUsageCents,
    chargeable_request_count: chargeableUsage.total_requests ?? 0,
    available_credits_cents: availableCreditsCents,
    total_credit_limit_cents: totalCreditLimitCents,
    trial_credit_allowance_cents: trialCreditCents,
    subscription_included_credit_cents: subscriptionIncludedCreditCents,
  };
}

export async function ensureStripeCustomerForOrg(
  env: StripeBillingEnv,
  org: Organization,
  email: string | null | undefined,
): Promise<string> {
  if (org.billing_customer_id) {
    return org.billing_customer_id;
  }

  const body = new URLSearchParams();
  body.set("name", org.name);
  if (email?.trim()) {
    body.set("email", email.trim());
  }
  body.set("metadata[org_id]", org.id);

  const customer = await stripeRequest<StripeCustomer>(env, "/customers", {
    method: "POST",
    body,
  });

  await getOrgStub(env, org.id).updateBillingState({
    billing_customer_id: customer.id,
  });

  return customer.id;
}

export function hasOrgUsedSubscriptionTrial(
  org: Pick<
    Organization,
    | "billing_trial_started_at"
    | "billing_trial_ends_at"
    | "billing_trial_credit_granted_at"
  >,
): boolean {
  return Boolean(
    org.billing_trial_started_at ||
    org.billing_trial_ends_at ||
    org.billing_trial_credit_granted_at,
  );
}

async function getLatestOrgInfo(
  env: StripeBillingEnv,
  org: Organization,
): Promise<Organization> {
  try {
    const orgNamespace = env.ORG;
    if (
      typeof orgNamespace?.idFromName !== "function" ||
      typeof orgNamespace?.get !== "function"
    ) {
      return org;
    }
    const latest = await getOrgStub(env, org.id).getInfo();
    return latest ?? org;
  } catch {
    return org;
  }
}

export async function createSubscriptionCheckoutSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  successUrl: string;
  cancelUrl: string;
  plan: BillingPlan;
  seatCount?: number | null;
}): Promise<string> {
  const { env, org, customerEmail, successUrl, cancelUrl } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise orgs are billed outside Stripe Checkout");
  }
  const plan = normalizeBillingPlan(args.plan, latestOrg.billing_status);
  if (plan === "free" || plan === "payg" || plan === "enterprise") {
    throw new Error("This plan cannot be started through Stripe Checkout");
  }
  const priceId = getConfiguredSubscriptionPriceId(env, plan);
  if (!priceId) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }
  validateCanonicalPaidPlanPrice(
    plan,
    priceId,
    await fetchStripePriceSummary(env, priceId),
  );
  const seatCount = normalizeSeatCount(
    plan,
    args.seatCount ?? latestOrg.billing_seat_count ?? getMinimumSeats(plan),
  );
  const subscriptionIncludedCreditCents =
    getSubscriptionIncludedCreditCentsForPlan(env, plan, seatCount);

  const customerId = await ensureStripeCustomerForOrg(
    env,
    latestOrg,
    customerEmail,
  );
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("customer", customerId);
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("allow_promotion_codes", "true");
  body.set("client_reference_id", org.id);
  body.set("metadata[org_id]", org.id);
  body.set("metadata[purchase_type]", "subscription");
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set("metadata[trial_credit_cents]", "0");
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set(
    "metadata[initial_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set("line_items[0][price]", priceId);
  body.set("line_items[0][quantity]", String(seatCount));
  if (plan === "team") {
    body.set("line_items[0][adjustable_quantity][enabled]", "true");
    body.set(
      "line_items[0][adjustable_quantity][minimum]",
      String(seatCount),
    );
    body.set(
      "line_items[0][adjustable_quantity][maximum]",
      String(STRIPE_CHECKOUT_MAX_ADJUSTABLE_QUANTITY),
    );
  }
  body.set("subscription_data[metadata][org_id]", org.id);
  body.set("subscription_data[metadata][billing_plan]", plan);
  body.set("subscription_data[metadata][seat_count]", String(seatCount));
  body.set("subscription_data[metadata][trial_credit_cents]", "0");
  body.set(
    "subscription_data[metadata][subscription_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );
  body.set(
    "subscription_data[metadata][initial_included_credit_cents]",
    String(subscriptionIncludedCreditCents),
  );

  const session = await stripeRequest<StripeCheckoutSession>(
    env,
    "/checkout/sessions",
    {
      method: "POST",
      body,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return session.url;
}

export async function createCreditsCheckoutSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  successUrl: string;
  cancelUrl: string;
  priceId: string;
}): Promise<string> {
  const { env, org, customerEmail, successUrl, cancelUrl, priceId } = args;
  const allowedPriceIds = new Set(getConfiguredCreditPriceIds(env));
  const trimmedPriceId = priceId.trim();
  if (!trimmedPriceId) {
    throw new Error("Stripe credit pack is required");
  }
  if (!allowedPriceIds.has(trimmedPriceId)) {
    throw new Error("Stripe credit pack is not allowed");
  }

  const latestOrg = await getLatestOrgInfo(env, org);
  if (!canBuyCreditsForBillingState(latestOrg)) {
    throw new Error(
      "Choose Pay as you go or an active subscription before buying credits.",
    );
  }

  const customerId = await ensureStripeCustomerForOrg(
    env,
    latestOrg,
    customerEmail,
  );
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("customer", customerId);
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("allow_promotion_codes", "true");
  body.set("client_reference_id", org.id);
  body.set("metadata[org_id]", org.id);
  body.set("metadata[purchase_type]", "credits");
  body.set("metadata[credit_price_id]", trimmedPriceId);
  body.set("line_items[0][price]", trimmedPriceId);
  body.set("line_items[0][quantity]", "1");

  const session = await stripeRequest<StripeCheckoutSession>(
    env,
    "/checkout/sessions",
    {
      method: "POST",
      body,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return session.url;
}

export async function activatePayAsYouGoPlan(args: {
  env: StripeBillingEnv;
  org: Organization;
}): Promise<Organization> {
  const { env, org } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise orgs are billed outside Pay as you go.");
  }
  const subscriptionStatus = latestOrg.billing_subscription_status?.trim();
  const hasRecoverableSubscription =
    latestOrg.billing_subscription_id?.trim() &&
    (!subscriptionStatus ||
      !NON_RECOVERABLE_STRIPE_SUBSCRIPTION_STATUSES.has(subscriptionStatus));
  if (hasRecoverableSubscription) {
    throw new Error(
      "Cancel the current subscription before switching to Pay as you go.",
    );
  }

  const updated = await getOrgStub(env, latestOrg.id).updateBillingState({
    billing_status: "inactive",
    billing_plan: "payg",
    billing_seat_count: 1,
    billing_subscription_id: null,
    billing_subscription_status: null,
    billing_trial_started_at: latestOrg.billing_trial_started_at ?? null,
    billing_trial_ends_at: latestOrg.billing_trial_ends_at ?? null,
  });
  if (!updated) {
    throw new Error("Organization not found");
  }
  return updated;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface CachedBillingPortalConfiguration {
  id: string;
  fingerprint: string;
}

function parseCachedBillingPortalConfiguration(
  value: string | null,
): CachedBillingPortalConfiguration | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CachedBillingPortalConfiguration>;
    const id = parsed.id?.trim();
    const fingerprint = parsed.fingerprint?.trim();
    return id && fingerprint ? { id, fingerprint } : null;
  } catch {
    return null;
  }
}

export async function getOrCreateBillingPortalConfiguration(
  env: StripeBillingEnv,
  mode: BillingPortalMode,
  suppliedCatalog?: CanonicalPaidPlanCatalogEntry[],
): Promise<string> {
  const catalog =
    mode === "management"
      ? []
      : (suppliedCatalog ?? (await loadCanonicalPaidPlanCatalog(env)));
  const fingerprint = await sha256Hex(
    JSON.stringify({
      schema: BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION,
      mode,
      catalog: catalog.map(({ plan, productId, priceId, unitAmount }) => ({
        plan,
        productId,
        priceId,
        unitAmount,
        minimumSeats: getMinimumSeats(plan),
        maximumSeats: plan === "team" ? null : 2,
      })),
      behavior: {
        allowedUpdates: mode === "management" ? [] : ["price", "quantity"],
        proration:
          mode === "upgrade"
            ? "always_invoice"
            : mode === "downgrade"
              ? "none"
              : null,
        cancellation: mode === "management" ? "at_period_end" : "disabled",
      },
    }),
  );
  const cacheKey =
    `${BILLING_PORTAL_CONFIGURATION_KV_PREFIX}v${BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION}:${mode}`;
  const cached = env.APP_KV
    ? parseCachedBillingPortalConfiguration(
        await env.APP_KV.get(cacheKey).catch(() => null),
      )
    : null;
  if (cached?.fingerprint === fingerprint) return cached.id;

  const body = new URLSearchParams();
  // Stripe accepts `active` when updating a portal configuration, but not when
  // creating one. New configurations are active by default.
  if (cached) body.set("active", "true");
  body.set("business_profile[headline]", "Manage your camelAI subscription");
  body.set("features[invoice_history][enabled]", "true");
  body.set("features[payment_method_update][enabled]", "true");
  body.set(
    "features[subscription_cancel][enabled]",
    mode === "management" ? "true" : "false",
  );
  if (mode === "management") {
    body.set("features[subscription_cancel][mode]", "at_period_end");
    body.set("features[subscription_update][enabled]", "false");
  } else {
    body.set("features[subscription_update][enabled]", "true");
    body.append(
      "features[subscription_update][default_allowed_updates][]",
      "price",
    );
    body.append(
      "features[subscription_update][default_allowed_updates][]",
      "quantity",
    );
    body.set(
      "features[subscription_update][proration_behavior]",
      mode === "upgrade" ? "always_invoice" : "none",
    );
    body.set(
      "features[subscription_update][billing_cycle_anchor]",
      "unchanged",
    );
    body.set(
      "features[subscription_update][trial_update_behavior]",
      "continue_trial",
    );
    catalog.forEach((entry, index) => {
      const prefix = `features[subscription_update][products][${index}]`;
      body.set(`${prefix}[product]`, entry.productId);
      body.append(`${prefix}[prices][]`, entry.priceId);
      body.set(`${prefix}[adjustable_quantity][enabled]`, "true");
      body.set(
        `${prefix}[adjustable_quantity][minimum]`,
        String(getMinimumSeats(entry.plan)),
      );
      if (entry.plan !== "team") {
        body.set(
          `${prefix}[adjustable_quantity][maximum]`,
          "2",
        );
      }
    });
  }

  const configuration = await stripeRequest<{
    id?: string | null;
    active?: boolean;
  }>(
    env,
    cached
      ? `/billing_portal/configurations/${cached.id}`
      : "/billing_portal/configurations",
    {
      method: "POST",
      body,
      idempotencyKey: cached
        ? undefined
        : `camelai-billing-portal-v${BILLING_PORTAL_CONFIGURATION_SCHEMA_VERSION}:${mode}:${fingerprint}`,
    },
  );
  const configurationId = (configuration.id ?? cached?.id)?.trim();
  if (!configurationId) {
    throw new Error("Stripe did not return a billing portal configuration.");
  }
  if (configuration.active === false) {
    throw new Error("Stripe billing portal configuration remained inactive.");
  }
  if (env.APP_KV) {
    await env.APP_KV
      .put(cacheKey, JSON.stringify({ id: configurationId, fingerprint }))
      .catch(() => undefined);
  }
  return configurationId;
}
async function verifySubscriptionCustomerOwnership(args: {
  env: StripeBillingEnv;
  org: Organization;
  subscription: StripeSubscription;
}): Promise<string> {
  const subscriptionOrgId = args.subscription.metadata?.org_id?.trim();
  if (subscriptionOrgId && subscriptionOrgId !== args.org.id) {
    throw new Error(
      "Stripe subscription does not belong to this organization.",
    );
  }
  const customerId = getStripeCustomerId(args.subscription.customer);
  if (!customerId)
    throw new Error("Stripe subscription does not have a customer.");
  const cachedCustomerId = args.org.billing_customer_id?.trim() || null;
  if (!cachedCustomerId || cachedCustomerId !== customerId) {
    const metadata = await fetchStripeCustomerMetadata(args.env, customerId);
    if (resolveOrgIdFromStripeCustomerMetadata(metadata) !== args.org.id) {
      throw new Error("Stripe subscription customer does not belong to this organization.");
    }
  }
  if (cachedCustomerId !== customerId) {
    await getOrgStub(args.env, args.org.id).updateBillingState({
      billing_customer_id: customerId,
    });
  }
  return customerId;
}

export async function createBillingPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
}): Promise<string> {
  const { env, org, customerEmail, returnUrl } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  const customerId = subscriptionId
    ? await (async () => {
        const subscription = await fetchStripeSubscription(env, subscriptionId);
        if (isTerminalStripeSubscriptionStatus(subscription.status)) {
          throw new Error("This organization does not have a recoverable Stripe subscription.");
        }
        return verifySubscriptionCustomerOwnership({ env, org: latestOrg, subscription });
      })()
    : await ensureStripeCustomerForOrg(env, latestOrg, customerEmail);
  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  body.set("configuration", await getOrCreateBillingPortalConfiguration(env, "management"));

  const session = await stripeRequest<{ url?: string | null }>(
    env,
    "/billing_portal/sessions",
    {
      method: "POST",
      body,
    },
  );

  if (!session.url) {
    throw new Error("Stripe did not return a billing portal URL");
  }

  return session.url;
}

export type StripeCancellationPortalResult =
  | {
      kind: "portal";
      billingPortalUrl: string;
    }
  | {
      kind: "already_scheduled";
      cancellationDateMs: number | null;
      subscriptionStatus: string;
    };

function stripeCancellationScheduledResult(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): StripeCancellationPortalResult {
  return {
    kind: "already_scheduled",
    cancellationDateMs: getSubscriptionCancellationDateMs(env, subscription),
    subscriptionStatus: subscription.status,
  };
}

async function bestEffortSyncCancelingStripeSubscription(args: {
  env: StripeBillingEnv;
  subscription: StripeSubscription;
}): Promise<void> {
  await syncOrgSubscriptionFromStripe(args.env, args.subscription).catch(
    (error) => {
      console.error("[billing] failed to sync canceling Stripe subscription", {
        subscriptionId: args.subscription.id,
        stripeStatus: args.subscription.status,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export async function createSubscriptionCancellationPortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  customerEmail: string | null | undefined;
  returnUrl: string;
  afterCompletionReturnUrl?: string;
}): Promise<StripeCancellationPortalResult> {
  const { env, org, returnUrl } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  if (!subscriptionId) {
    throw new Error("This organization does not have a Stripe subscription.");
  }
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise organizations are billed outside Stripe.");
  }

  const subscription = await fetchStripeSubscription(env, subscriptionId);
  if (isSubscriptionCanceling(subscription)) {
    await bestEffortSyncCancelingStripeSubscription({ env, subscription });
    return stripeCancellationScheduledResult(env, subscription);
  }

  const customerId = await verifySubscriptionCustomerOwnership({
    env,
    org: latestOrg,
    subscription,
  });

  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  body.set("flow_data[type]", "subscription_cancel");
  body.set("flow_data[subscription_cancel][subscription]", subscriptionId);
  body.set("flow_data[after_completion][type]", "redirect");
  body.set(
    "flow_data[after_completion][redirect][return_url]",
    args.afterCompletionReturnUrl ?? returnUrl,
  );
  body.set("configuration", await getOrCreateBillingPortalConfiguration(env, "management"));

  try {
    const session = await stripeRequest<{ url?: string | null }>(
      env,
      "/billing_portal/sessions",
      {
        method: "POST",
        body,
      },
    );

    if (!session.url) {
      throw new Error("Stripe did not return a billing portal URL");
    }

    return { kind: "portal", billingPortalUrl: session.url };
  } catch (error) {
    const refreshedSubscription = await fetchStripeSubscription(
      env,
      subscriptionId,
    ).catch((refreshError) => {
      console.error(
        "[billing] failed to refresh subscription after cancellation portal failure",
        {
          orgId: latestOrg.id,
          subscriptionId,
          error:
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError),
        },
      );
      return null;
    });

    if (refreshedSubscription && isSubscriptionCanceling(refreshedSubscription)) {
      await bestEffortSyncCancelingStripeSubscription({
        env,
        subscription: refreshedSubscription,
      });
      return stripeCancellationScheduledResult(env, refreshedSubscription);
    }

    throw error;
  }
}

/**
 * Creates a Stripe-hosted confirmation flow for an exact plan and quantity,
 * or returns null after repairing the local projection when Stripe already
 * has the requested state.
 * Stripe owns payment collection, proration, and authentication; webhooks
 * project the confirmed subscription back into camelAI.
 */
export async function createSubscriptionUpdatePortalSession(args: {
  env: StripeBillingEnv;
  org: Organization;
  plan: SubscriptionBillingPlan;
  seatCount?: number | null;
  returnUrl: string;
}): Promise<string | null> {
  const { env, org, plan, returnUrl } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  if (!subscriptionId) {
    throw new Error("This organization does not have a Stripe subscription.");
  }
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise organizations are billed outside Stripe.");
  }

  const [catalog, subscription] = await Promise.all([
    loadCanonicalPaidPlanCatalog(env),
    fetchStripeSubscription(env, subscriptionId),
  ]);
  if (
    !["active", "trialing"].includes(subscription.status) ||
    subscription.cancel_at_period_end === true ||
    Boolean(subscription.cancel_at)
  ) {
    throw new StripeSubscriptionRequiresManagementError(subscription.status);
  }
  const customerId = await verifySubscriptionCustomerOwnership({
    env,
    org: latestOrg,
    subscription,
  });
  const item = getStripeSubscriptionItemForPlanChange(subscription, null);
  const currentPriceId = getStripePriceId(item.price);
  const currentCatalogEntry = catalog.find(
    (entry) => entry.priceId === currentPriceId,
  );
  const retiredCurrentPrice = currentPriceId
    ? RETIRED_PRICING_ROLLOUT_PRICES.get(currentPriceId)
    : undefined;
  const currentPlan = currentCatalogEntry?.plan ?? retiredCurrentPrice?.plan;
  const currentUnitAmount =
    currentCatalogEntry?.unitAmount ?? retiredCurrentPrice?.unitAmount;
  const targetEntry = catalog.find((entry) => entry.plan === plan);
  if (!currentPlan || currentUnitAmount === undefined) {
    throw new Error(
      "Stripe subscription item is not in the configured paid-plan catalog.",
    );
  }
  if (!targetEntry) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }

  const currentSeatCount = normalizeSeatCount(
    currentPlan,
    item.quantity ?? getMinimumSeats(currentPlan),
  );
  const requestedSeatCount = normalizeSeatCount(
    plan,
    args.seatCount ??
      latestOrg.billing_seat_count ??
      getMinimumSeats(plan),
  );
  const occupiedSeatCount = await getOccupiedSeatCountForOrg(
    env,
    latestOrg.id,
  );
  if (plan !== "team") {
    assertPlanCoversOccupiedSeats(
      plan,
      requestedSeatCount,
      occupiedSeatCount,
    );
  }
  const occupiedTargetSeatCount =
    plan === "team"
      ? Math.max(
          requestedSeatCount,
          normalizeSeatCount("team", occupiedSeatCount),
        )
      : getMinimumSeats(plan);
  // Buying Team capacity is increase-only. Membership and invitation changes
  // must never silently reduce a quantity that Stripe already knows about.
  const targetSeatCount =
    currentPlan === "team" && plan === "team"
      ? Math.max(occupiedTargetSeatCount, currentSeatCount)
      : occupiedTargetSeatCount;

  if (
    currentPriceId === targetEntry.priceId &&
    currentSeatCount === targetSeatCount
  ) {
    // Stripe may be ahead of the webhook projection (for example, after a
    // concurrent capacity purchase). Repair the projection without opening a
    // no-op Portal confirmation or accidentally turning the request into a
    // decrease.
    await syncOrgSubscriptionFromStripe(env, subscription);
    return null;
  }
  const mode: Exclude<BillingPortalMode, "management"> =
    targetEntry.unitAmount * targetSeatCount >
    currentUnitAmount * currentSeatCount
      ? "upgrade"
      : "downgrade";

  const body = new URLSearchParams();
  body.set("customer", customerId);
  body.set("return_url", returnUrl);
  body.set("configuration", await getOrCreateBillingPortalConfiguration(env, mode, catalog));
  body.set("flow_data[type]", "subscription_update_confirm");
  body.set(
    "flow_data[subscription_update_confirm][subscription]",
    subscriptionId,
  );
  body.set(
    "flow_data[subscription_update_confirm][items][0][id]",
    item.id,
  );
  body.set(
    "flow_data[subscription_update_confirm][items][0][price]",
    targetEntry.priceId,
  );
  body.set(
    "flow_data[subscription_update_confirm][items][0][quantity]",
    String(targetSeatCount),
  );
  body.set("flow_data[after_completion][type]", "redirect");
  body.set(
    "flow_data[after_completion][redirect][return_url]",
    returnUrl,
  );

  const session = await stripeRequest<{ url?: string | null }>(
    env,
    "/billing_portal/sessions",
    {
      method: "POST",
      body,
    },
  );
  if (!session.url) {
    throw new Error("Stripe did not return a billing portal URL");
  }
  return session.url;
}

export async function updateTrialingStripeSubscriptionPlan(args: {
  env: StripeBillingEnv;
  org: Organization;
  plan: SubscriptionBillingPlan;
  seatCount?: number | null;
}): Promise<Organization> {
  const { env, org, plan } = args;
  const latestOrg = await getLatestOrgInfo(env, org);
  if (latestOrg.billing_status === "enterprise") {
    throw new Error("Enterprise organizations are billed outside Stripe.");
  }
  const subscriptionId = latestOrg.billing_subscription_id?.trim();
  if (!subscriptionId) {
    throw new Error("This organization does not have a Stripe subscription.");
  }
  const priceId = getConfiguredSubscriptionPriceId(env, plan);
  if (!priceId) {
    throw new Error(`Stripe ${plan} subscription price is not configured`);
  }

  const subscription = await fetchStripeSubscription(env, subscriptionId);
  if (subscription.status !== "trialing") {
    await syncOrgSubscriptionFromStripe(env, subscription).catch((error) => {
      console.error("[billing] failed to sync stale trialing subscription", {
        orgId: latestOrg.id,
        subscriptionId,
        stripeStatus: subscription.status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throw new StaleTrialingSubscriptionStatusError(subscription.status);
  }
  if (subscription.cancel_at_period_end === true) {
    await syncOrgSubscriptionFromStripe(env, subscription).catch((error) => {
      console.error("[billing] failed to sync canceled trialing subscription", {
        orgId: latestOrg.id,
        subscriptionId,
        stripeStatus: subscription.status,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    throw new StaleTrialingSubscriptionStatusError(subscription.status);
  }

  const requestedSeatCount = normalizeSeatCount(
    plan,
    args.seatCount ?? latestOrg.billing_seat_count ?? getMinimumSeats(plan),
  );
  const occupiedSeatCount = await getOccupiedSeatCountForOrg(
    env,
    latestOrg.id,
  );
  if (plan !== "team") {
    assertPlanCoversOccupiedSeats(
      plan,
      requestedSeatCount,
      occupiedSeatCount,
    );
  }
  const seatCount =
    plan === "team"
      ? Math.max(
          requestedSeatCount,
          normalizeSeatCount("team", occupiedSeatCount),
        )
      : requestedSeatCount;
  const currentPlan = getOrgBillingPlan(latestOrg);
  const currentPriceId =
    currentPlan === "free" ||
    currentPlan === "payg" ||
    currentPlan === "enterprise"
      ? null
      : getConfiguredSubscriptionPriceId(env, currentPlan);
  const item = getStripeSubscriptionItemForPlanChange(
    subscription,
    currentPriceId,
  );
  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    plan,
    seatCount,
  );
  const trialCreditCents =
    parsePositiveInteger(subscription.metadata?.trial_credit_cents) ??
    (latestOrg.billing_trial_credit_grant_cents > 0
      ? latestOrg.billing_trial_credit_grant_cents
      : getTrialCreditCentsForPlan(env, plan, seatCount));

  const body = new URLSearchParams();
  body.set("items[0][id]", item.id);
  body.set("items[0][price]", priceId);
  body.set("items[0][quantity]", String(seatCount));
  body.set("proration_behavior", "none");
  body.set("metadata[org_id]", latestOrg.id);
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set("metadata[trial_credit_cents]", String(trialCreditCents));
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );

  const updatedSubscription = await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${subscriptionId}`,
    {
      method: "POST",
      body,
    },
  );

  const synced = await syncOrgSubscriptionFromStripe(env, updatedSubscription);
  if (synced) return synced;

  const customerId =
    getStripeCustomerId(updatedSubscription.customer) ??
    getStripeCustomerId(subscription.customer) ??
    latestOrg.billing_customer_id ??
    null;
  const updatedOrg = await getOrgStub(env, latestOrg.id).updateBillingState({
    billing_status: mapStripeSubscriptionBillingStatus(updatedSubscription),
    billing_plan: plan,
    billing_seat_count: seatCount,
    billing_customer_id: customerId,
    billing_subscription_id: updatedSubscription.id,
    billing_subscription_status: updatedSubscription.status ?? null,
    billing_trial_started_at: updatedSubscription.trial_start
      ? updatedSubscription.trial_start * 1000
      : latestOrg.billing_trial_started_at,
    billing_trial_ends_at: updatedSubscription.trial_end
      ? updatedSubscription.trial_end * 1000
      : latestOrg.billing_trial_ends_at,
  });
  if (!updatedOrg) {
    throw new Error("Failed to update organization billing state.");
  }
  return updatedOrg;
}

async function fetchStripeCustomerMetadata(
  env: StripeBillingEnv,
  customerId: string | null | undefined,
): Promise<Record<string, string> | null> {
  const trimmedCustomerId = customerId?.trim();
  if (!trimmedCustomerId) return null;

  const customer = await stripeRequest<StripeCustomer>(
    env,
    `/customers/${trimmedCustomerId}`,
  );
  return customer.metadata ?? null;
}

function resolveOrgIdFromStripeCustomerMetadata(
  metadata: Record<string, string> | null | undefined,
): string | null {
  return metadata?.org_id?.trim() || null;
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function getMetadataBillingPlan(
  metadata: Record<string, string> | null | undefined,
  fallbackStatus?: BillingStatus | null,
): BillingPlan {
  return normalizeBillingPlan(metadata?.billing_plan, fallbackStatus);
}

function getMetadataSeatCount(
  metadata: Record<string, string> | null | undefined,
  plan: BillingPlan,
  fallback?: number | null,
): number {
  return normalizeSeatCount(
    plan,
    parsePositiveInteger(metadata?.seat_count) ?? fallback,
  );
}

function getMetadataTrialCreditCents(
  metadata: Record<string, string> | null | undefined,
  env: Pick<StripeBillingEnv, "BILLING_TRIAL_CREDIT_CENTS">,
  plan: BillingPlan,
  seatCount: number,
): number {
  return (
    parsePositiveInteger(metadata?.trial_credit_cents) ??
    getTrialCreditCentsForPlan(env, plan, seatCount)
  );
}

async function bestEffortSyncStripeSubscriptionBillingMetadata(args: {
  env: StripeBillingEnv;
  subscription: StripeSubscription;
  orgId: string;
  plan: BillingPlan;
  seatCount: number;
}): Promise<void> {
  const { env, subscription, orgId, plan, seatCount } = args;
  if (plan === "free" || plan === "payg" || plan === "enterprise") return;

  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    plan,
    seatCount,
  );
  const metadata = subscription.metadata ?? {};
  if (
    metadata.org_id === orgId &&
    metadata.billing_plan === plan &&
    metadata.seat_count === String(seatCount) &&
    metadata.subscription_included_credit_cents === String(includedCreditCents)
  ) {
    return;
  }

  const body = new URLSearchParams();
  body.set("metadata[org_id]", orgId);
  body.set("metadata[billing_plan]", plan);
  body.set("metadata[seat_count]", String(seatCount));
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );

  try {
    await stripeRequest<StripeSubscription>(
      env,
      `/subscriptions/${subscription.id}`,
      {
        method: "POST",
        body,
      },
    );
  } catch (error) {
    console.error("[billing] failed to sync Stripe subscription metadata", {
      orgId,
      subscriptionId: subscription.id,
      plan,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface PendingLegacyMigrationCustomerMetadata {
  orgId: string;
  subscriptionId: string;
  targetPlan: BillingPlan;
  includedCreditCents: number;
  seatCount: number;
}

function getPendingLegacyMigrationCustomerMetadata(
  metadata: Record<string, string> | null | undefined,
): PendingLegacyMigrationCustomerMetadata | null {
  const orgId =
    metadata?.[LEGACY_MIGRATION_META_ORG_ID]?.trim() ||
    metadata?.pending_legacy_migration_org_id?.trim();
  const subscriptionId =
    metadata?.[LEGACY_MIGRATION_META_SUBSCRIPTION_ID]?.trim() ||
    metadata?.pending_legacy_migration_subscription_id?.trim();
  if (!orgId || !subscriptionId) return null;
  const targetPlan = normalizeBillingPlan(
    metadata?.[LEGACY_MIGRATION_META_TARGET_PLAN] ||
      metadata?.pending_legacy_migration_target_plan,
  );
  if (
    targetPlan === "free" ||
    targetPlan === "payg" ||
    targetPlan === "enterprise"
  ) {
    return null;
  }
  return {
    orgId,
    subscriptionId,
    targetPlan,
    includedCreditCents:
      parsePositiveInteger(
        metadata?.[LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS] ||
          metadata?.pending_legacy_migration_included_credit_cents,
      ) ?? 0,
    seatCount:
      parsePositiveInteger(
        metadata?.[LEGACY_MIGRATION_META_SEAT_COUNT] ||
          metadata?.pending_legacy_migration_seat_count,
      ) ?? getMinimumSeats(targetPlan),
  };
}

async function bestEffortClearPendingLegacyMigrationCustomerMetadata(args: {
  env: StripeBillingEnv;
  customerId: string | null | undefined;
  orgId: string;
}): Promise<void> {
  const trimmedCustomerId = args.customerId?.trim();
  if (!trimmedCustomerId) return;

  const body = new URLSearchParams();
  body.set("metadata[org_id]", args.orgId);
  body.set(`metadata[${LEGACY_MIGRATION_META_ORG_ID}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_SUBSCRIPTION_ID}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_TARGET_PLAN}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_SEAT_COUNT}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_INCLUDED_CREDIT_CENTS}]`, "");
  body.set(`metadata[${LEGACY_MIGRATION_META_SOURCE_PRICE_ID}]`, "");
  body.set("metadata[pending_legacy_migration_org_id]", "");
  body.set("metadata[pending_legacy_migration_subscription_id]", "");
  body.set("metadata[pending_legacy_migration_target_plan]", "");
  body.set("metadata[pending_legacy_migration_seat_count]", "");
  body.set("metadata[pending_legacy_migration_included_credit_cents]", "");
  body.set("metadata[pending_legacy_migration_source_price_id]", "");

  try {
    await stripeRequest<StripeCustomer>(
      args.env,
      `/customers/${trimmedCustomerId}`,
      {
        method: "POST",
        body,
      },
    );
  } catch (error) {
    console.error(
      "[billing] failed to clear legacy migration customer metadata",
      {
        orgId: args.orgId,
        customerId: trimmedCustomerId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function getPaidSubscriptionPlanSeatState(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): { plan: SubscriptionBillingPlan; seatCount: number } | null {
  if (
    !["active", "trialing", "past_due", "unpaid"].includes(
      subscription.status,
    )
  ) {
    return null;
  }
  const itemPlan = getSubscriptionPlanFromItems(env, subscription);
  const fallbackPlan = getMetadataBillingPlan(
    subscription.metadata,
    mapStripeSubscriptionBillingStatus(subscription),
  );
  const plan = itemPlan?.plan ?? fallbackPlan;
  if (plan === "free" || plan === "payg" || plan === "enterprise") {
    return null;
  }
  const quantity =
    itemPlan?.item.quantity ??
    getStripeSubscriptionSeatQuantity(
      subscription,
      getConfiguredSubscriptionPriceId(env, plan),
    ) ??
    parsePositiveInteger(subscription.metadata?.seat_count);
  return { plan, seatCount: normalizeSeatCount(plan, quantity) };
}

async function enforceTeamSubscriptionCapacityInvariant(args: {
  env: StripeBillingEnv;
  org: Organization;
  subscription: StripeSubscription;
}): Promise<StripeSubscription> {
  const { env, org } = args;
  if (org.billing_status === "enterprise") return args.subscription;

  const existingPlan = getOrgBillingPlan(org);
  const incomingState = getPaidSubscriptionPlanSeatState(
    env,
    args.subscription,
  );
  if (
    !incomingState ||
    (existingPlan !== "team" && incomingState.plan !== "team")
  ) {
    return args.subscription;
  }

  const occupiedSeatCount = await getOccupiedSeatCountForOrg(env, org.id);
  const protectedTeamSeatCount = normalizeSeatCount(
    "team",
    Math.max(
      occupiedSeatCount,
      existingPlan === "team" ? (org.billing_seat_count ?? 0) : 0,
    ),
  );
  const violatesCapacityInvariant = (state: {
    plan: SubscriptionBillingPlan;
    seatCount: number;
  } | null): boolean => {
    if (!state) return false;
    if (state.plan === "team") {
      return state.seatCount < protectedTeamSeatCount;
    }
    return existingPlan === "team" && occupiedSeatCount > state.seatCount;
  };
  if (!violatesCapacityInvariant(incomingState)) return args.subscription;

  const liveSubscription = await fetchStripeSubscription(
    env,
    args.subscription.id,
  );
  const liveState = getPaidSubscriptionPlanSeatState(env, liveSubscription);
  if (!violatesCapacityInvariant(liveState)) return liveSubscription;

  const teamPriceId = getConfiguredSubscriptionPriceId(env, "team");
  if (!teamPriceId) {
    throw new Error("Stripe team subscription price is not configured");
  }
  const item = getStripeSubscriptionItemForPlanChange(liveSubscription, null);
  const includedCreditCents = getSubscriptionIncludedCreditCentsForPlan(
    env,
    "team",
    protectedTeamSeatCount,
  );
  const body = new URLSearchParams();
  body.set("items[0][id]", item.id);
  body.set("items[0][price]", teamPriceId);
  body.set("items[0][quantity]", String(protectedTeamSeatCount));
  body.set("proration_behavior", "none");
  body.set("metadata[org_id]", org.id);
  body.set("metadata[billing_plan]", "team");
  body.set("metadata[seat_count]", String(protectedTeamSeatCount));
  body.set(
    "metadata[subscription_included_credit_cents]",
    String(includedCreditCents),
  );

  const repairedSubscription = await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${liveSubscription.id}`,
    { method: "POST", body },
  );
  const repairedState = getPaidSubscriptionPlanSeatState(
    env,
    repairedSubscription,
  );
  if (
    repairedState?.plan !== "team" ||
    repairedState.seatCount < protectedTeamSeatCount
  ) {
    throw new Error(
      `Stripe subscription ${liveSubscription.id} did not preserve the organization's Team seat capacity.`,
    );
  }
  console.warn("[billing] repaired regressed Team subscription capacity", {
    orgId: org.id,
    subscriptionId: liveSubscription.id,
    incomingPlan: incomingState.plan,
    incomingSeatCount: incomingState.seatCount,
    restoredSeatCount: protectedTeamSeatCount,
    occupiedSeatCount,
  });
  return repairedSubscription;
}

export async function syncOrgSubscriptionFromStripe(
  env: StripeBillingEnv,
  subscription: StripeSubscription,
): Promise<Organization | null> {
  const directOrgId = subscription.metadata?.org_id?.trim();
  let customerId = getStripeCustomerId(subscription.customer);
  let customerMetadata =
    typeof subscription.customer === "object"
      ? (subscription.customer?.metadata ?? null)
      : null;
  if (!directOrgId && customerId && !customerMetadata) {
    customerMetadata = await fetchStripeCustomerMetadata(env, customerId);
  }
  let itemPlan = getSubscriptionPlanFromItems(env, subscription);
  const pendingLegacyMigration =
    getPendingLegacyMigrationCustomerMetadata(customerMetadata);
  const pendingLegacyMigrationOrgId =
    pendingLegacyMigration &&
    pendingLegacyMigration.subscriptionId === subscription.id &&
    itemPlan &&
    pendingLegacyMigration.targetPlan === itemPlan.plan
      ? pendingLegacyMigration.orgId
      : null;
  const orgId =
    directOrgId ||
    pendingLegacyMigrationOrgId ||
    resolveOrgIdFromStripeCustomerMetadata(customerMetadata);
  if (!orgId) {
    return null;
  }

  const orgStub = getOrgStub(env, orgId);
  const existing = await orgStub.getInfo();
  if (!existing) return null;

  subscription = await enforceTeamSubscriptionCapacityInvariant({
    env,
    org: existing,
    subscription,
  });
  customerId = getStripeCustomerId(subscription.customer) ?? customerId;
  itemPlan = getSubscriptionPlanFromItems(env, subscription);

  const nextStatus = mapStripeSubscriptionBillingStatus(subscription);
  const shouldClearStripeSubscription = isTerminalStripeSubscriptionStatus(
    subscription.status,
  );
  const shouldUsePayAsYouGoPlan =
    shouldClearStripeSubscription || nextStatus === "canceled";
  const nextBillingStatus =
    existing.billing_status === "enterprise"
      ? "enterprise"
      : shouldUsePayAsYouGoPlan
        ? "inactive"
        : nextStatus;
  const nextPlan =
    existing.billing_status === "enterprise"
      ? "enterprise"
      : shouldUsePayAsYouGoPlan
        ? "payg"
      : (itemPlan?.plan ??
        getMetadataBillingPlan(subscription.metadata, nextStatus));
  const subscriptionSeatQuantity =
    itemPlan?.item.quantity ??
    getStripeSubscriptionSeatQuantity(
      subscription,
      getConfiguredSubscriptionPriceId(env, nextPlan),
    );
  const seatCount = normalizeSeatCount(
    nextPlan,
    subscriptionSeatQuantity ??
      parsePositiveInteger(subscription.metadata?.seat_count) ??
      existing.billing_seat_count,
  );
  const trialCreditCents = getMetadataTrialCreditCents(
    subscription.metadata,
    env,
    nextPlan,
    seatCount,
  );
  await bestEffortSyncStripeSubscriptionBillingMetadata({
    env,
    subscription,
    orgId,
    plan: nextPlan,
    seatCount,
  });

  const result = await orgStub.syncSubscriptionBillingState(
    {
      billing_status: nextBillingStatus,
      billing_plan: nextPlan,
      billing_seat_count: seatCount,
      billing_customer_id: customerId,
      billing_subscription_id:
        shouldClearStripeSubscription ? null : subscription.id,
      billing_subscription_status:
        shouldClearStripeSubscription ? null : (subscription.status ?? null),
      billing_trial_started_at: subscription.trial_start
        ? subscription.trial_start * 1000
        : null,
      billing_trial_ends_at: subscription.trial_end
        ? subscription.trial_end * 1000
        : null,
      billing_credit_usage_started_at:
        existing.billing_credit_usage_started_at ?? null,
    },
    trialCreditCents,
  );
  if (result?.capacityInvariantError) {
    throw new Error(result.capacityInvariantError);
  }

  return result?.org ?? null;
}

async function hasProcessedIncludedCreditInvoice(
  env: Pick<StripeBillingEnv, "APP_KV">,
  invoiceId: string,
): Promise<boolean> {
  if (!env.APP_KV) return false;
  const existing = await env.APP_KV.get(
    `${INCLUDED_CREDIT_INVOICE_EVENT_PREFIX}${invoiceId}`,
  );
  return Boolean(existing);
}

async function markIncludedCreditInvoiceProcessed(
  env: Pick<StripeBillingEnv, "APP_KV">,
  invoiceId: string,
): Promise<void> {
  if (!env.APP_KV) return;
  await env.APP_KV.put(
    `${INCLUDED_CREDIT_INVOICE_EVENT_PREFIX}${invoiceId}`,
    "1",
  );
}

export function getInvoiceSubscriptionId(invoice: StripeInvoice): string | null {
  const subscription =
    invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  return typeof subscription === "string" ? subscription : (subscription?.id ?? null);
}

export function getInvoiceSubscriptionMetadata(
  invoice: StripeInvoice,
): Record<string, string> | null | undefined {
  return (
    invoice.parent?.subscription_details?.metadata ||
    invoice.subscription_details?.metadata ||
    (typeof invoice.subscription === "object" ? invoice.subscription?.metadata : null)
  );
}

export function getInvoiceLinePriceId(line: StripeInvoiceLine): string | null {
  return getStripePriceId(line.pricing?.price_details?.price ?? line.price);
}

export function isStripeProrationLine(line: StripeInvoiceLine): boolean {
  return Boolean(line.proration || line.parent?.subscription_item_details?.proration);
}

export function isRecurringSubscriptionInvoice(
  invoice: StripeInvoice,
): boolean {
  return RECURRING_INCLUDED_CREDIT_BILLING_REASONS.has(
    invoice.billing_reason ?? "",
  );
}

function getInvoiceMetadata(
  invoice: StripeInvoice,
): Record<string, string> | null | undefined {
  return (
    getInvoiceSubscriptionMetadata(invoice) ||
    invoice.metadata
  );
}

function isPaidInvoice(invoice: StripeInvoice): boolean {
  return invoice.status === "paid";
}

export interface SubscriptionInvoiceGrantResolution {
  command: SubscriptionInvoiceGrantCommand | null;
  ignoredReason: string | null;
}

function catalogEntryForPrice(
  catalog: CanonicalPaidPlanCatalogEntry[],
  priceId: string | null | undefined,
): CanonicalPaidPlanCatalogEntry | null {
  return catalog.find((entry) => entry.priceId === priceId) ?? null;
}

function recognizedSubscriptionItem(
  subscription: StripeSubscription,
  catalog: CanonicalPaidPlanCatalogEntry[],
): { entry: CanonicalPaidPlanCatalogEntry; item: StripeSubscriptionItem } | null {
  const matches = (subscription.items?.data ?? []).flatMap((item) => {
    const entry = catalogEntryForPrice(catalog, getStripePriceId(item.price));
    return entry ? [{ entry, item }] : [];
  });
  if (matches.length > 1) throw new Error("Stripe subscription has multiple paid-plan items.");
  return matches[0] ?? null;
}

function isRecurringSubscriptionInvoiceLine(line: StripeInvoiceLine): boolean {
  if (isStripeProrationLine(line)) return false;
  if (line.parent?.invoice_item_details || line.type === "invoiceitem") {
    return false;
  }
  return Boolean(
    line.parent?.subscription_item_details ||
    line.subscription_item ||
    line.type === "subscription" ||
    getInvoiceLinePriceId(line),
  );
}

function getInvoiceLineSeatCount(
  invoiceId: string,
  line: StripeInvoiceLine,
  plan: SubscriptionBillingPlan,
): number {
  if (
    typeof line.quantity !== "number" ||
    !Number.isFinite(line.quantity) ||
    !Number.isInteger(line.quantity) ||
    line.quantity <= 0
  ) {
    throw new Error(
      `Paid invoice ${invoiceId} has no valid quantity for ${plan}.`,
    );
  }
  if (plan !== "team" && line.quantity !== 1) {
    throw new Error(
      `Paid invoice ${invoiceId} has unsupported quantity ${line.quantity} for fixed-allowance ${plan}.`,
    );
  }
  return normalizeSeatCount(plan, line.quantity);
}

function recognizedRecurringInvoiceLine(
  invoice: StripeInvoice,
  lines: StripeInvoiceLine[],
  catalog: CanonicalPaidPlanCatalogEntry[],
): {
  entry: CanonicalPaidPlanCatalogEntry;
  line: StripeInvoiceLine;
  seatCount: number;
} | null {
  const matches = lines.flatMap((line) => {
    if (!isRecurringSubscriptionInvoiceLine(line)) return [];
    const entry = catalogEntryForPrice(catalog, getInvoiceLinePriceId(line));
    return entry
      ? [
          {
            entry,
            line,
            seatCount: getInvoiceLineSeatCount(invoice.id, line, entry.plan),
          },
        ]
      : [];
  });
  if (matches.length > 1) {
    throw new Error(
      `Paid ${invoice.billing_reason ?? "subscription"} invoice ${invoice.id} has multiple recognized recurring plan lines.`,
    );
  }
  return matches[0] ?? null;
}

function recognizedRetiredPricingRolloutInvoiceLine(
  invoice: StripeInvoice,
  lines: StripeInvoiceLine[],
): {
  plan: "starter" | "pro";
  seatCount: number;
  grantCents: number;
} | null {
  const matches = lines.flatMap((line) => {
    if (!isRecurringSubscriptionInvoiceLine(line)) return [];
    const retired = RETIRED_PRICING_ROLLOUT_PRICES.get(
      getInvoiceLinePriceId(line) ?? "",
    );
    if (!retired) return [];
    return [
      {
        ...retired,
        seatCount: getInvoiceLineSeatCount(invoice.id, line, retired.plan),
      },
    ];
  });
  if (matches.length > 1) {
    throw new Error(
      `Paid ${invoice.billing_reason ?? "subscription"} invoice ${invoice.id} has multiple retired recurring plan lines.`,
    );
  }
  const match = matches[0];
  if (!match) return null;

  const invoiceMetadata = getInvoiceMetadata(invoice);
  if (normalizeBillingPlan(invoiceMetadata?.billing_plan) !== match.plan) {
    throw new Error(
      `Paid ${invoice.billing_reason ?? "subscription"} invoice ${invoice.id} has retired price metadata for a different plan.`,
    );
  }
  const metadataSeatCount = parsePositiveInteger(invoiceMetadata?.seat_count);
  if (
    metadataSeatCount !== null &&
    normalizeSeatCount(match.plan, metadataSeatCount) !== match.seatCount
  ) {
    throw new Error(
      `Paid ${invoice.billing_reason ?? "subscription"} invoice ${invoice.id} has conflicting retired price seat metadata.`,
    );
  }
  const metadataGrantCents = parsePositiveInteger(
    invoiceMetadata?.subscription_included_credit_cents,
  );
  if (
    metadataGrantCents !== null &&
    metadataGrantCents !== match.includedCreditCents
  ) {
    throw new Error(
      `Paid ${invoice.billing_reason ?? "subscription"} invoice ${invoice.id} has conflicting retired price credit metadata.`,
    );
  }
  const initialGrantCents = parsePositiveInteger(
    invoiceMetadata?.initial_included_credit_cents,
  );
  if (
    invoice.billing_reason === "subscription_create" &&
    initialGrantCents !== null &&
    initialGrantCents !== match.includedCreditCents
  ) {
    throw new Error(
      `Paid subscription_create invoice ${invoice.id} has conflicting retired price initial credit metadata.`,
    );
  }

  return {
    plan: match.plan,
    seatCount: match.seatCount,
    grantCents: metadataGrantCents ?? match.includedCreditCents,
  };
}

export function resolveSubscriptionInvoiceGrant(args: {
  env: Pick<StripeBillingEnv, "BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS">;
  invoice: StripeInvoice;
  lines: StripeInvoiceLine[];
  subscription: StripeSubscription;
  catalog: CanonicalPaidPlanCatalogEntry[];
  orgId: string;
  customerId: string;
  customerMetadata?: Record<string, string> | null;
}): SubscriptionInvoiceGrantResolution {
  const { invoice, subscription, catalog } = args;
  if (!isPaidInvoice(invoice)) return { command: null, ignoredReason: "invoice_not_paid" };
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return { command: null, ignoredReason: "not_subscription_invoice" };
  if (subscriptionId !== subscription.id) {
    throw new Error(`Invoice ${invoice.id} references a different subscription.`);
  }
  const billingReason = invoice.billing_reason;
  if (
    billingReason !== "subscription_create" &&
    billingReason !== "subscription_cycle" &&
    billingReason !== "subscription_update"
  ) {
    return { command: null, ignoredReason: "unsupported_billing_reason" };
  }
  const recognized =
    billingReason === "subscription_update"
      ? recognizedSubscriptionItem(subscription, catalog)
      : null;
  const pendingMigration = getPendingLegacyMigrationCustomerMetadata(
    args.customerMetadata,
  );
  const isLegacyMigration =
    billingReason === "subscription_update" &&
    recognized !== null &&
    pendingMigration?.orgId === args.orgId &&
    pendingMigration.subscriptionId === subscription.id &&
    pendingMigration.targetPlan === recognized.entry.plan &&
    normalizeSeatCount(recognized.entry.plan, pendingMigration.seatCount) ===
      normalizeSeatCount(recognized.entry.plan, recognized.item.quantity);
  if (isLegacyMigration) {
    const plan = recognized!.entry.plan;
    const seatCount = normalizeSeatCount(plan, recognized!.item.quantity);
    return {
      command: {
        invoiceId: invoice.id,
        subscriptionId,
        customerId: args.customerId,
        billingReason,
        source: "legacy_migration",
        plan,
        seatCount,
        grantCents: getSubscriptionIncludedCreditCentsForPlan(args.env, plan, seatCount),
      },
      ignoredReason: null,
    };
  }
  if (billingReason === "subscription_update") {
    if (!recognized) throw new Error(`Paid update invoice ${invoice.id} has no recognized plan.`);
    let netAllowance = 0;
    const positiveTargets: Array<{
      plan: SubscriptionBillingPlan;
      seatCount: number;
    }> = [];
    for (const line of args.lines) {
      if (!isStripeProrationLine(line)) continue;
      const priceId = getInvoiceLinePriceId(line);
      const entry = catalogEntryForPrice(catalog, priceId);
      if (!entry) {
        throw new Error(
          `Paid subscription update invoice ${invoice.id} contains unknown proration price ${priceId ?? "missing"}.`,
        );
      }
      const quantity = normalizeSeatCount(entry.plan, line.quantity ?? getMinimumSeats(entry.plan));
      const denominator = entry.unitAmount * quantity;
      if (typeof line.amount !== "number" || denominator <= 0) {
        throw new Error(`Stripe proration line for ${entry.priceId} is invalid.`);
      }
      netAllowance +=
        (line.amount / denominator) *
        getSubscriptionIncludedCreditCentsForPlan(
          args.env,
          entry.plan,
          quantity,
        );
      if (line.amount > 0) {
        positiveTargets.push({ plan: entry.plan, seatCount: quantity });
      }
    }
    const distinctPositiveTargets = positiveTargets.filter(
      (target, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.plan === target.plan &&
            candidate.seatCount === target.seatCount,
        ) === index,
    );
    if (distinctPositiveTargets.length > 1) {
      throw new Error(
        `Paid subscription update invoice ${invoice.id} has ambiguous target plan lines.`,
      );
    }
    const invoiceTarget = distinctPositiveTargets[0];
    const plan = invoiceTarget?.plan ?? recognized.entry.plan;
    const seatCount =
      invoiceTarget?.seatCount ??
      normalizeSeatCount(plan, recognized.item.quantity);
    return {
      command: {
        invoiceId: invoice.id,
        subscriptionId,
        customerId: args.customerId,
        billingReason,
        source: "plan_change",
        plan,
        seatCount,
        grantCents: Math.max(0, Math.floor(netAllowance)),
      },
      ignoredReason: null,
    };
  }
  const recurringLine = recognizedRecurringInvoiceLine(
    invoice,
    args.lines,
    catalog,
  );
  let plan = recurringLine?.entry.plan ?? null;
  let seatCount = recurringLine?.seatCount ?? null;
  let grantCents: number | null = null;
  if (!plan || seatCount === null) {
    const retiredInvoice =
      billingReason === "subscription_create" ||
      billingReason === "subscription_cycle"
        ? recognizedRetiredPricingRolloutInvoiceLine(invoice, args.lines)
        : null;
    if (retiredInvoice) {
      plan = retiredInvoice.plan;
      seatCount = retiredInvoice.seatCount;
      grantCents = retiredInvoice.grantCents;
    }
  }
  if (!plan || seatCount === null) {
    const invoiceMetadata = getInvoiceMetadata(invoice);
    const fallback = normalizeBillingPlan(invoiceMetadata?.billing_plan);
    const hasLegacyPrice = args.lines.some((line) => {
      if (!isRecurringSubscriptionInvoiceLine(line)) return false;
      const priceId = getInvoiceLinePriceId(line);
      return Boolean(priceId && LEGACY_MIGRATION_PRICE_IDS.has(priceId));
    });
    if (
      billingReason !== "subscription_cycle" ||
      !["starter", "pro", "team"].includes(fallback) ||
      !hasLegacyPrice
    ) {
      throw new Error(`Paid ${billingReason} invoice ${invoice.id} has no recognized plan.`);
    }
    plan = fallback as SubscriptionBillingPlan;
    seatCount = getMetadataSeatCount(invoiceMetadata, plan);
  }
  return {
    command: {
      invoiceId: invoice.id,
      subscriptionId,
      customerId: args.customerId,
      billingReason,
      source: billingReason === "subscription_create" ? "initial" : "renewal",
      plan,
      seatCount,
      grantCents:
        grantCents ??
        getSubscriptionIncludedCreditCentsForPlan(args.env, plan, seatCount),
    },
    ignoredReason: null,
  };
}

export async function retrieveCanonicalStripeInvoice(args: {
  env: StripeBillingEnv;
  invoiceId: string;
}): Promise<{ invoice: StripeInvoice; lines: StripeInvoiceLine[] }> {
  const invoiceId = args.invoiceId.trim();
  if (!invoiceId) throw new Error("Stripe invoice id is required.");
  const invoice = await stripeRequest<StripeInvoice>(
    args.env,
    `/invoices/${encodeURIComponent(invoiceId)}`,
  );
  const lines: StripeInvoiceLine[] = [];
  let startingAfter: string | null = null;
  do {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const page = await stripeRequest<StripeListResponse<StripeInvoiceLine>>(
      args.env,
      `/invoices/${encodeURIComponent(invoiceId)}/lines?${params.toString()}`,
    );
    lines.push(...(page.data ?? []));
    if (!page.has_more) break;
    startingAfter = page.data?.at(-1)?.id?.trim() ?? null;
    if (!startingAfter) throw new Error(`Stripe invoice ${invoiceId} pagination has no cursor.`);
  } while (startingAfter);
  return { invoice, lines };
}

type EligibleInvoiceGrant = {
  invoice: StripeInvoice;
  subscription: StripeSubscription;
  command: SubscriptionInvoiceGrantCommand;
  orgId: string;
  customerId: string;
  customerMetadata: Record<string, string> | null | undefined;
  org: Organization;
  orgStub: ReturnType<typeof getOrgStub>;
  oldKvMarker: boolean;
  existingLedger: Awaited<
    ReturnType<ReturnType<typeof getOrgStub>["getSubscriptionInvoiceGrant"]>
  >;
};

function getPersistedInvoiceGrantSource(
  row: SubscriptionInvoiceGrantRow,
  billingReason: SubscriptionInvoiceGrantCommand["billingReason"],
): SubscriptionInvoiceGrantCommand["source"] {
  if (
    row.source === "initial" ||
    row.source === "renewal" ||
    row.source === "plan_change" ||
    row.source === "legacy_migration"
  ) {
    return row.source;
  }
  if (row.source === "legacy_processed") {
    if (billingReason === "subscription_create") return "initial";
    if (billingReason === "subscription_cycle") return "renewal";
    return "plan_change";
  }
  throw new Error(
    `Invoice ${row.invoice_id} has an invalid persisted grant source.`,
  );
}

function commandFromPersistedInvoiceGrant(args: {
  invoice: StripeInvoice;
  subscriptionId: string;
  customerId: string;
  billingReason: SubscriptionInvoiceGrantCommand["billingReason"];
  row: SubscriptionInvoiceGrantRow;
}): SubscriptionInvoiceGrantCommand {
  const { invoice, subscriptionId, customerId, billingReason, row } = args;
  if (
    row.invoice_id !== invoice.id ||
    row.subscription_id !== subscriptionId ||
    row.customer_id !== customerId ||
    row.billing_reason !== billingReason
  ) {
    throw new Error(
      `Invoice ${invoice.id} was already recorded with conflicting immutable Stripe fields.`,
    );
  }
  if (row.plan !== "starter" && row.plan !== "pro" && row.plan !== "team") {
    throw new Error(`Invoice ${invoice.id} has an invalid persisted grant plan.`);
  }
  const seatCount = Number(row.seat_count);
  const grantCents = Number(row.amount_cents);
  if (
    !Number.isInteger(seatCount) ||
    seatCount <= 0 ||
    normalizeSeatCount(row.plan, seatCount) !== seatCount ||
    !Number.isInteger(grantCents) ||
    grantCents < 0
  ) {
    throw new Error(`Invoice ${invoice.id} has invalid persisted grant amounts.`);
  }
  return {
    invoiceId: invoice.id,
    subscriptionId,
    customerId,
    billingReason,
    source: getPersistedInvoiceGrantSource(row, billingReason),
    plan: row.plan,
    seatCount,
    grantCents,
  };
}

async function preparePaidSubscriptionInvoice(
  env: StripeBillingEnv,
  invoiceId: string,
): Promise<
  | { kind: "ignored"; result: Extract<PaidSubscriptionInvoiceProcessingResult, { status: "ignored" }> }
  | { kind: "eligible"; grant: EligibleInvoiceGrant }
> {
  const { invoice, lines } = await retrieveCanonicalStripeInvoice({ env, invoiceId });
  if (!isPaidInvoice(invoice)) {
    return {
      kind: "ignored",
      result: {
        status: "ignored",
        reason: "invoice_not_paid",
        invoiceId: invoice.id,
        subscriptionId: getInvoiceSubscriptionId(invoice),
      },
    };
  }
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    return { kind: "ignored", result: { status: "ignored", reason: "not_subscription_invoice", invoiceId: invoice.id } };
  }
  if (!invoice.billing_reason || !["subscription_create", "subscription_cycle", "subscription_update"].includes(invoice.billing_reason)) {
    return {
      kind: "ignored",
      result: { status: "ignored", reason: "unsupported_billing_reason", invoiceId: invoice.id, subscriptionId },
    };
  }
  const billingReason =
    invoice.billing_reason as SubscriptionInvoiceGrantCommand["billingReason"];
  const subscription = await fetchStripeSubscription(env, subscriptionId);
  if (subscription.id !== subscriptionId) {
    throw new Error(`Invoice ${invoice.id} references a different subscription.`);
  }
  const invoiceCustomerId = getStripeCustomerId(invoice.customer);
  const subscriptionCustomerId = getStripeCustomerId(subscription.customer);
  if (invoiceCustomerId && subscriptionCustomerId && invoiceCustomerId !== subscriptionCustomerId) {
    throw new Error(`Invoice ${invoice.id} and subscription ${subscription.id} have different customers.`);
  }
  const customerId = subscriptionCustomerId ?? invoiceCustomerId;
  if (!customerId) throw new Error(`Paid subscription invoice ${invoice.id} has no customer.`);
  const directOrgId =
    subscription.metadata?.org_id?.trim() ||
    getInvoiceSubscriptionMetadata(invoice)?.org_id?.trim() ||
    null;
  let customerMetadata =
    typeof subscription.customer === "object" ? subscription.customer?.metadata : null;
  if (!customerMetadata && (!directOrgId || invoice.billing_reason === "subscription_update")) {
    customerMetadata = await fetchStripeCustomerMetadata(env, customerId);
  }
  const orgId = directOrgId || resolveOrgIdFromStripeCustomerMetadata(customerMetadata);
  // Legacy SaaS / API product renewals share this Stripe account but never had
  // platform org_id metadata. Ack them as ignored so Stripe stops retrying;
  // only invoices that resolve to an org receive included-credit grants.
  if (!orgId) {
    return {
      kind: "ignored",
      result: {
        status: "ignored",
        reason: "organization_not_resolved",
        invoiceId: invoice.id,
        subscriptionId,
      },
    };
  }
  const orgStub = getOrgStub(env, orgId);
  const org = await orgStub.getInfo();
  if (!org) throw new Error(`Organization ${orgId} does not exist.`);
  const [oldKvMarker, existingLedger] = await Promise.all([
    hasProcessedIncludedCreditInvoice(env, invoice.id),
    orgStub.getSubscriptionInvoiceGrant(invoice.id),
  ]);
  if (existingLedger) {
    return {
      kind: "eligible",
      grant: {
        invoice,
        subscription,
        command: commandFromPersistedInvoiceGrant({
          invoice,
          subscriptionId,
          customerId,
          billingReason,
          row: existingLedger,
        }),
        orgId,
        customerId,
        customerMetadata,
        org,
        orgStub,
        oldKvMarker,
        existingLedger,
      },
    };
  }
  const catalog = await loadCanonicalPaidPlanCatalog(env);
  const resolution = resolveSubscriptionInvoiceGrant({
    env,
    invoice,
    lines,
    subscription,
    catalog,
    orgId,
    customerId,
    customerMetadata,
  });
  if (
    resolution.command?.source === "renewal" &&
    !recognizedRecurringInvoiceLine(invoice, lines, catalog)
  ) {
    console.warn("[billing] using legacy renewal price metadata fallback", {
      invoiceId: invoice.id,
      subscriptionId,
      orgId,
      plan: resolution.command.plan,
      seatCount: resolution.command.seatCount,
    });
  }
  if (!resolution.command) {
    return {
      kind: "ignored",
      result: {
        status: "ignored",
        reason: resolution.ignoredReason ?? "not_eligible",
        invoiceId: invoice.id,
        subscriptionId,
      },
    };
  }
  return {
    kind: "eligible",
    grant: {
      invoice,
      subscription,
      command: resolution.command,
      orgId,
      customerId,
      customerMetadata,
      org,
      orgStub,
      oldKvMarker,
      existingLedger,
    },
  };
}

async function applyEligibleInvoiceGrant(
  env: StripeBillingEnv,
  grant: EligibleInvoiceGrant,
): Promise<{
  result: Extract<PaidSubscriptionInvoiceProcessingResult, { status: "processed" | "duplicate" }>;
  grantResult: ApplySubscriptionInvoiceGrantResult;
}> {
  const syncedOrg = await syncOrgSubscriptionFromStripe(env, grant.subscription);
  if (grant.existingLedger) {
    const org = syncedOrg ?? (await grant.orgStub.getInfo());
    if (!org) throw new Error(`Organization ${grant.orgId} disappeared.`);
    await markIncludedCreditInvoiceProcessed(env, grant.invoice.id);
    if (grant.existingLedger.source === "legacy_migration") {
      await bestEffortClearPendingLegacyMigrationCustomerMetadata({
        env,
        customerId: grant.customerId,
        orgId: grant.orgId,
      });
    }
    const grantResult: ApplySubscriptionInvoiceGrantResult = {
      org,
      applied: false,
      credited: false,
      legacyProcessed: grant.existingLedger.source === "legacy_processed",
      invariantError: null,
    };
    return {
      grantResult,
      result: {
        status: "duplicate",
        invoiceId: grant.invoice.id,
        subscriptionId: grant.command.subscriptionId,
        orgId: grant.orgId,
        plan: grant.command.plan,
        seatCount: grant.command.seatCount,
        grantCents: 0,
        source: grant.command.source,
        org,
      },
    };
  }
  const grantResult = await grant.orgStub.applySubscriptionInvoiceGrant(
    grant.command,
    {
      legacyProcessed: grant.oldKvMarker,
    },
  );
  if (!grantResult) throw new Error(`Organization ${grant.orgId} disappeared.`);
  if (grantResult.invariantError) throw new Error(grantResult.invariantError);
  await markIncludedCreditInvoiceProcessed(env, grant.invoice.id);
  if (grant.command.source === "legacy_migration") {
    await bestEffortClearPendingLegacyMigrationCustomerMetadata({
      env,
      customerId: grant.customerId,
      orgId: grant.orgId,
    });
  }
  return {
    grantResult,
    result: {
      status: grantResult.applied ? "processed" : "duplicate",
      invoiceId: grant.invoice.id,
      subscriptionId: grant.command.subscriptionId,
      orgId: grant.orgId,
      plan: grant.command.plan,
      seatCount: grant.command.seatCount,
      grantCents: grantResult.credited ? grant.command.grantCents : 0,
      source: grant.command.source,
      org: grantResult.org,
    },
  };
}

export async function processPaidSubscriptionInvoice(
  env: StripeBillingEnv,
  invoiceId: string,
): Promise<PaidSubscriptionInvoiceProcessingResult> {
  const prepared = await preparePaidSubscriptionInvoice(env, invoiceId);
  if (prepared.kind === "ignored") return prepared.result;
  return (await applyEligibleInvoiceGrant(env, prepared.grant)).result;
}

export async function reconcilePaidSubscriptionInvoice(
  env: StripeBillingEnv,
  invoiceId: string,
  options: { apply?: boolean } = {},
): Promise<SubscriptionInvoiceReconciliationReport> {
  const prepared = await preparePaidSubscriptionInvoice(env, invoiceId);
  if (prepared.kind === "ignored") {
    return {
      status: "ignored",
      invoiceId: prepared.result.invoiceId,
      subscriptionId: prepared.result.subscriptionId ?? null,
      reason: prepared.result.reason,
    };
  }
  const grant = prepared.grant;
  const applied = options.apply ? await applyEligibleInvoiceGrant(env, grant) : null;
  const legacyMarker =
    grant.oldKvMarker || grant.org.billing_last_included_credit_invoice_id === grant.invoice.id;
  const wouldCredit =
    !legacyMarker && !grant.existingLedger && grant.org.billing_status !== "enterprise";
  return {
    status: applied ? applied.result.status : "preview",
    invoiceId: grant.invoice.id,
    subscriptionId: grant.command.subscriptionId,
    orgId: grant.orgId,
    billingReason: grant.command.billingReason,
    plan: grant.command.plan,
    seatCount: grant.command.seatCount,
    source: grant.command.source,
    computedGrantCents: grant.command.grantCents,
    creditedGrantCents: applied
      ? applied.grantResult.credited
        ? grant.command.grantCents
        : 0
      : wouldCredit
        ? grant.command.grantCents
        : 0,
    oldKvMarker: grant.oldKvMarker,
    lastInvoiceMarker: grant.org.billing_last_included_credit_invoice_id ?? null,
    ledgerStatus: grant.existingLedger
      ? grant.existingLedger.source === "legacy_processed"
        ? "legacy_processed"
        : "recorded"
      : "not_recorded",
  };
}

async function hasProcessedCreditCheckout(
  env: Pick<StripeBillingEnv, "APP_KV">,
  sessionId: string,
): Promise<boolean> {
  if (!env.APP_KV) return false;
  const existing = await env.APP_KV.get(
    `${CREDIT_CHECKOUT_EVENT_PREFIX}${sessionId}`,
  );
  return Boolean(existing);
}

export async function applyCreditsCheckoutCompleted(
  env: StripeBillingEnv,
  session: StripeCheckoutSession,
): Promise<Organization | null> {
  if (session.mode !== "payment") return null;
  if (session.payment_status !== "paid") return null;
  if (session.metadata?.purchase_type !== "credits") return null;
  if (await hasProcessedCreditCheckout(env, session.id)) return null;

  const orgId =
    session.metadata?.org_id?.trim() || session.client_reference_id?.trim();
  if (!orgId) {
    return null;
  }

  const amountCents = session.amount_subtotal ?? session.amount_total ?? 0;
  if (amountCents <= 0) {
    return null;
  }

  const orgStub = getOrgStub(env, orgId);
  const result = await orgStub.applyCreditCheckout(
    session.id,
    amountCents,
    session.customer ?? null,
  );
  return result?.org ?? null;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyStripeWebhookSignature(args: {
  payload: string;
  signatureHeader: string | null;
  secret: string;
  toleranceSeconds?: number;
}): Promise<boolean> {
  const { payload, signatureHeader, secret, toleranceSeconds = 300 } = args;
  if (!signatureHeader) {
    return false;
  }

  const parts = signatureHeader.split(",").map((part) => part.trim());
  const timestampPart = parts.find((part) => part.startsWith("t="));
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3))
    .filter(Boolean);
  if (!timestampPart || signatures.length === 0) {
    return false;
  }

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  const digest = Array.from(new Uint8Array(signed))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((signature) => timingSafeEqual(signature, digest));
}

interface StripeListResponse<T> {
  data: T[];
  has_more?: boolean;
}

export async function listStripeInvoicesForOrg(
  env: StripeBillingEnv,
  org: Organization,
  options: { limit?: number } = {},
): Promise<StripeInvoiceListEntry[]> {
  // FIXME(billing-stripe): paginate beyond the first page if needed.
  if (!org.billing_customer_id) return [];
  if (!env.STRIPE_SECRET_KEY?.trim()) return [];

  const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
  const params = new URLSearchParams();
  params.set("customer", org.billing_customer_id);
  params.set("limit", String(limit));
  const response = await stripeRequest<
    StripeListResponse<StripeInvoiceListEntry>
  >(env, `/invoices?${params.toString()}`);
  return response.data ?? [];
}

export async function getStripeSubscriptionSummary(
  env: StripeBillingEnv,
  org: Organization,
): Promise<StripeSubscriptionSummary | null> {
  // FIXME(billing-stripe): wire this to the live Stripe subscription so renewal
  // and cancel-at-period-end render correctly.
  if (!org.billing_subscription_id) return null;
  if (!env.STRIPE_SECRET_KEY?.trim()) return null;

  const subscription = await stripeRequest<StripeSubscription>(
    env,
    `/subscriptions/${org.billing_subscription_id}`,
  );

  return {
    id: subscription.id,
    status: subscription.status,
    current_period_end_ms: stripeTimestampMs(
      getSubscriptionPeriodEndSeconds(env, subscription),
    ),
    cancel_at_ms: stripeTimestampMs(subscription.cancel_at),
    cancellation_date_ms: getSubscriptionCancellationDateMs(env, subscription),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    is_canceling: isSubscriptionCanceling(subscription),
    trial_end_ms: stripeTimestampMs(subscription.trial_end),
  };
}
