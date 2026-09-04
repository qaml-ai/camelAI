import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BILLING_PLAN_LIMITS,
  BILLING_PLANS,
  includedCreditsForPlan,
  type BillingPlan,
} from "../../shared/billing-plans.ts";
import {
  type BillingAccount,
  type BillingService,
  type BillingStatus,
} from "../platform/billing.ts";

export const STRIPE_API_VERSION = "2026-06-24.dahlia";

export type StripeMode = "test" | "live";

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  mode?: string;
  amount_total?: number | null;
  payment_status?: string;
  customer?: string | { id?: string } | null;
  metadata?: Record<string, string>;
  client_reference_id?: string | null;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

export interface StripeBillingClientOptions {
  secretKey?: string;
  webhookSecret?: string;
  mode?: StripeMode;
  fetch?: typeof fetch;
  now?: () => number;
  signatureToleranceSeconds?: number;
  priceIds?: Partial<Record<BillingPlan, string>>;
}

export interface CreateSubscriptionCheckoutInput {
  orgId: string;
  plan: BillingPlan;
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
  seatCount?: number;
}

export interface CreateCreditsCheckoutInput {
  orgId: string;
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
  customerId?: string;
}

export class StripeBillingClient {
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly mode: StripeMode;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly signatureToleranceSeconds: number;
  private readonly priceIds: Partial<Record<BillingPlan, string>>;

  constructor(options: StripeBillingClientOptions = {}) {
    this.secretKey =
      options.secretKey?.trim() ?? process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    this.webhookSecret =
      options.webhookSecret?.trim() ??
      process.env.STRIPE_WEBHOOK_SECRET?.trim() ??
      "";
    this.mode =
      options.mode ?? parseStripeMode(process.env.STRIPE_MODE) ?? "test";
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.signatureToleranceSeconds =
      options.signatureToleranceSeconds ?? 5 * 60;
    this.priceIds = {
      starter:
        options.priceIds?.starter ??
        process.env.STRIPE_STARTER_PRICE_ID?.trim(),
      pro:
        options.priceIds?.pro ?? process.env.STRIPE_PRO_PRICE_ID?.trim(),
      team:
        options.priceIds?.team ?? process.env.STRIPE_TEAM_PRICE_ID?.trim(),
      ...options.priceIds,
    };
  }

  async createCheckoutSessionForSubscription(
    input: CreateSubscriptionCheckoutInput,
  ): Promise<StripeCheckoutSession> {
    this.requireConfiguredKey();
    requireOrgId(input.orgId);
    requireHttpUrl(input.successUrl, "successUrl");
    requireHttpUrl(input.cancelUrl, "cancelUrl");

    const limits = BILLING_PLAN_LIMITS[input.plan];
    if (
      !limits ||
      limits.monthlyPriceCents === null ||
      limits.monthlyPriceCents <= 0
    ) {
      throw new Error(
        `Stripe subscription checkout is not available for plan ${input.plan}`,
      );
    }

    const seatCount = normalizeSeatCount(input.plan, input.seatCount);
    const body = new URLSearchParams();
    body.set("mode", "subscription");
    body.set("success_url", input.successUrl);
    body.set("cancel_url", input.cancelUrl);
    body.set("client_reference_id", input.orgId);
    if (input.customerId?.trim()) {
      body.set("customer", input.customerId.trim());
    }
    setMetadata(body, "metadata", {
      type: "subscription",
      purchase_type: "subscription",
      orgId: input.orgId,
      org_id: input.orgId,
      plan: input.plan,
      billing_plan: input.plan,
      seatCount: String(seatCount),
      seat_count: String(seatCount),
    });
    setMetadata(body, "subscription_data[metadata]", {
      orgId: input.orgId,
      org_id: input.orgId,
      plan: input.plan,
      billing_plan: input.plan,
      seatCount: String(seatCount),
      seat_count: String(seatCount),
    });

    const priceId = this.priceIds[input.plan]?.trim();
    if (priceId) {
      body.set("line_items[0][price]", priceId);
    } else {
      body.set("line_items[0][price_data][currency]", "usd");
      body.set(
        "line_items[0][price_data][unit_amount]",
        String(limits.monthlyPriceCents),
      );
      body.set(
        "line_items[0][price_data][recurring][interval]",
        "month",
      );
      body.set(
        "line_items[0][price_data][product_data][name]",
        `camelAI ${limits.label}`,
      );
    }
    body.set("line_items[0][quantity]", String(seatCount));

    return this.stripeRequest<StripeCheckoutSession>(
      "/v1/checkout/sessions",
      body,
    );
  }

  async createCheckoutSessionForCredits(
    input: CreateCreditsCheckoutInput,
  ): Promise<StripeCheckoutSession> {
    this.requireConfiguredKey();
    requireOrgId(input.orgId);
    requirePositiveCents(input.amountCents, "amountCents");
    requireHttpUrl(input.successUrl, "successUrl");
    requireHttpUrl(input.cancelUrl, "cancelUrl");

    const body = new URLSearchParams();
    body.set("mode", "payment");
    body.set("success_url", input.successUrl);
    body.set("cancel_url", input.cancelUrl);
    body.set("client_reference_id", input.orgId);
    if (input.customerId?.trim()) {
      body.set("customer", input.customerId.trim());
    }
    setMetadata(body, "metadata", {
      type: "credits",
      purchase_type: "credits",
      orgId: input.orgId,
      org_id: input.orgId,
      amountCents: String(input.amountCents),
      amount_cents: String(input.amountCents),
    });
    body.set("line_items[0][price_data][currency]", "usd");
    body.set(
      "line_items[0][price_data][unit_amount]",
      String(input.amountCents),
    );
    body.set(
      "line_items[0][price_data][product_data][name]",
      "camelAI credits",
    );
    body.set("line_items[0][quantity]", "1");

    return this.stripeRequest<StripeCheckoutSession>(
      "/v1/checkout/sessions",
      body,
    );
  }

  constructEvent(
    rawBody: string | Uint8Array,
    signatureHeader: string | null | undefined,
  ): StripeWebhookEvent {
    if (!this.webhookSecret) {
      throw new Error("Stripe webhook not configured");
    }
    if (!signatureHeader) {
      throw new Error("Invalid Stripe signature");
    }

    const signatures = parseSignatureHeader(signatureHeader);
    const timestamp = signatures.timestamp;
    const ageSeconds = Math.abs(Math.floor(this.now() / 1000) - timestamp);
    if (ageSeconds > this.signatureToleranceSeconds) {
      throw new Error("Invalid Stripe signature: timestamp outside tolerance");
    }

    const payload = Buffer.isBuffer(rawBody)
      ? rawBody
      : Buffer.from(rawBody);
    const expected = createHmac("sha256", this.webhookSecret)
      .update(String(timestamp))
      .update(".")
      .update(payload)
      .digest();
    const valid = signatures.v1.some((candidate) => {
      if (!/^[0-9a-f]{64}$/i.test(candidate)) {
        return false;
      }
      const actual = Buffer.from(candidate, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!valid) {
      throw new Error("Invalid Stripe signature");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new Error("Invalid Stripe webhook payload");
    }
    if (!isStripeWebhookEvent(parsed)) {
      throw new Error("Invalid Stripe webhook event");
    }
    return parsed;
  }

  private requireConfiguredKey(): void {
    if (!this.secretKey) {
      throw new Error("Stripe not configured");
    }
    const keyMode = stripeKeyMode(this.secretKey);
    if (keyMode && keyMode !== this.mode) {
      throw new Error(
        `Stripe key mode mismatch: STRIPE_MODE=${this.mode} requires a ${this.mode} key`,
      );
    }
  }

  private async stripeRequest<T>(
    path: string,
    body: URLSearchParams,
  ): Promise<T> {
    const response = await this.fetchImpl(`https://api.stripe.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": STRIPE_API_VERSION,
      },
      body,
    });

    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: { message?: string } })
      | null;
    if (!response.ok) {
      const detail = payload?.error?.message?.trim();
      throw new Error(
        detail ? `Stripe request failed: ${detail}` : "Stripe request failed",
      );
    }
    if (!payload) {
      throw new Error("Stripe returned an invalid response");
    }
    return payload;
  }
}

export function handleWebhookEvent(
  event: StripeWebhookEvent,
  billingService: BillingService,
): BillingAccount | undefined {
  const object = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(object, billingService);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return handleSubscriptionChanged(object, billingService);
    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handlePaidInvoice(object, billingService);
    default:
      return undefined;
  }
}

function handleCheckoutCompleted(
  object: Record<string, unknown>,
  billingService: BillingService,
): BillingAccount | undefined {
  const metadata = asMetadata(object.metadata);
  if (
    object.mode !== "payment" ||
    (metadata.type !== "credits" && metadata.purchase_type !== "credits")
  ) {
    return undefined;
  }
  const orgId = firstString(
    metadata.orgId,
    metadata.org_id,
    object.client_reference_id,
  );
  const sessionId = stringValue(object.id);
  const amountCents =
    positiveInteger(object.amount_total) ??
    positiveInteger(metadata.amountCents) ??
    positiveInteger(metadata.amount_cents);
  if (!orgId || !sessionId || !amountCents) {
    throw new Error("Stripe credits checkout is missing billing metadata");
  }
  const customerId = expandableId(object.customer);
  if (customerId) {
    billingService.setStripeIds(orgId, { customerId });
  }
  return billingService.grantPurchasedCredits(
    orgId,
    amountCents,
    sessionId,
  );
}

function handleSubscriptionChanged(
  object: Record<string, unknown>,
  billingService: BillingService,
): BillingAccount {
  const metadata = asMetadata(object.metadata);
  const orgId = firstString(metadata.orgId, metadata.org_id);
  if (!orgId) {
    throw new Error("Stripe subscription is missing org metadata");
  }
  const current = billingService.getAccount(orgId);
  const plan =
    parseBillingPlan(firstString(metadata.plan, metadata.billing_plan)) ??
    current.plan;
  const seatCount =
    positiveInteger(metadata.seatCount) ??
    positiveInteger(metadata.seat_count) ??
    subscriptionQuantity(object) ??
    current.seatCount;
  billingService.setPlan(orgId, plan, seatCount);
  billingService.setBillingStatus(
    orgId,
    eventBillingStatus(stringValue(object.status)),
  );
  return billingService.setStripeIds(orgId, {
    customerId: expandableId(object.customer),
    subscriptionId: stringValue(object.id),
  });
}

function handlePaidInvoice(
  object: Record<string, unknown>,
  billingService: BillingService,
): BillingAccount | undefined {
  const invoiceId = stringValue(object.id);
  if (!invoiceId) {
    throw new Error("Stripe paid invoice is missing an id");
  }

  const metadataSources = invoiceMetadataSources(object);
  const orgId = firstFromMetadata(metadataSources, "orgId", "org_id");
  if (!orgId) {
    throw new Error("Stripe paid invoice is missing org metadata");
  }
  const current = billingService.getAccount(orgId);
  const plan =
    parseBillingPlan(
      firstFromMetadata(metadataSources, "plan", "billing_plan"),
    ) ?? current.plan;
  const seatCount =
    positiveInteger(
      firstFromMetadata(metadataSources, "seatCount", "seat_count"),
    ) ??
    invoiceQuantity(object) ??
    current.seatCount;
  const grantCents = includedCreditsForPlan(plan, seatCount);
  if (grantCents <= 0) {
    return undefined;
  }
  billingService.setPlan(orgId, plan, seatCount);
  return billingService.grantIncludedCredits(
    orgId,
    grantCents,
    invoiceId,
  );
}

function invoiceMetadataSources(
  object: Record<string, unknown>,
): Array<Record<string, string>> {
  const sources = [asMetadata(object.metadata)];
  const subscriptionDetails = asRecord(object.subscription_details);
  sources.push(asMetadata(subscriptionDetails?.metadata));
  const parent = asRecord(object.parent);
  const parentSubscription = asRecord(parent?.subscription_details);
  sources.push(asMetadata(parentSubscription?.metadata));
  const lines = asRecord(object.lines);
  const lineData = Array.isArray(lines?.data) ? lines.data : [];
  for (const line of lineData) {
    const record = asRecord(line);
    sources.push(asMetadata(record?.metadata));
    const lineParent = asRecord(record?.parent);
    const lineSubscription = asRecord(lineParent?.subscription_item_details);
    sources.push(asMetadata(lineSubscription?.metadata));
  }
  return sources;
}

function invoiceQuantity(object: Record<string, unknown>): number | undefined {
  const lines = asRecord(object.lines);
  const lineData = Array.isArray(lines?.data) ? lines.data : [];
  for (const line of lineData) {
    const quantity = positiveInteger(asRecord(line)?.quantity);
    if (quantity) return quantity;
  }
  return undefined;
}

function subscriptionQuantity(
  object: Record<string, unknown>,
): number | undefined {
  const items = asRecord(object.items);
  const itemData = Array.isArray(items?.data) ? items.data : [];
  for (const item of itemData) {
    const quantity = positiveInteger(asRecord(item)?.quantity);
    if (quantity) return quantity;
  }
  return undefined;
}

function firstFromMetadata(
  sources: Array<Record<string, string>>,
  ...keys: string[]
): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

function eventBillingStatus(status: string | undefined): BillingStatus {
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
      return "none";
  }
}

function parseStripeMode(value: string | undefined): StripeMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "test" || normalized === "live") return normalized;
  throw new Error("STRIPE_MODE must be test or live");
}

function stripeKeyMode(key: string): StripeMode | undefined {
  if (/^(?:sk|rk)_test_/.test(key)) return "test";
  if (/^(?:sk|rk)_live_/.test(key)) return "live";
  return undefined;
}

function setMetadata(
  body: URLSearchParams,
  prefix: string,
  metadata: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(metadata)) {
    body.set(`${prefix}[${key}]`, value);
  }
}

function parseSignatureHeader(header: string): {
  timestamp: number;
  v1: string[];
} {
  let timestamp: number | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && /^\d+$/.test(value ?? "")) {
      timestamp = Number(value);
    } else if (key === "v1" && value) {
      v1.push(value);
    }
  }
  if (!Number.isSafeInteger(timestamp) || !v1.length) {
    throw new Error("Invalid Stripe signature");
  }
  return { timestamp: timestamp as number, v1 };
}

function isStripeWebhookEvent(value: unknown): value is StripeWebhookEvent {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  return Boolean(
    stringValue(record?.id) &&
      stringValue(record?.type) &&
      asRecord(data?.object),
  );
}

function parseBillingPlan(value: string | undefined): BillingPlan | undefined {
  return BILLING_PLANS.includes(value as BillingPlan)
    ? (value as BillingPlan)
    : undefined;
}

function normalizeSeatCount(
  plan: BillingPlan,
  seatCount: number | undefined,
): number {
  const minimum = BILLING_PLAN_LIMITS[plan].minimumSeats;
  return Number.isFinite(seatCount)
    ? Math.max(minimum, Math.floor(seatCount ?? minimum))
    : minimum;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asMetadata(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = stringValue(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function expandableId(value: unknown): string | undefined {
  return stringValue(value) ?? stringValue(asRecord(value)?.id);
}

function requireOrgId(orgId: string): void {
  if (!orgId?.trim()) {
    throw new Error("orgId is required");
  }
}

function requirePositiveCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function requireHttpUrl(value: string, field: string): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new Error(`${field} must be an HTTP(S) URL`);
  }
}
