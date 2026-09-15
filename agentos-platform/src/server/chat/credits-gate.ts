import type { BillingService } from "../platform/billing.ts";
import type { UsageService } from "../platform/usage.ts";

export type HostedBillingService = Pick<
  BillingService,
  "canUseHostedModel"
> &
  Partial<Pick<BillingService, "consumeCredits">>;

export class CreditDeniedError extends Error {
  readonly code = "credits_denied";
  readonly status = 402;

  constructor(
    readonly orgId: string,
    readonly estimatedCents: number,
  ) {
    super(
      `Insufficient credits to start a hosted model turn for org ${orgId}`,
    );
    this.name = "CreditDeniedError";
  }
}

export function assertCanStartHostedTurn(opts: {
  billing: HostedBillingService;
  orgId: string;
  bypass?: boolean;
  estimatedCents?: number;
}): void {
  if (opts.bypass) {
    return;
  }
  if (!opts.orgId?.trim()) {
    throw new Error("assertCanStartHostedTurn: orgId is required");
  }
  const estimatedCents = opts.estimatedCents ?? 1;
  if (
    !Number.isInteger(estimatedCents) ||
    !Number.isFinite(estimatedCents) ||
    estimatedCents <= 0
  ) {
    throw new Error(
      "assertCanStartHostedTurn: estimatedCents must be a positive integer",
    );
  }
  if (!opts.billing.canUseHostedModel(opts.orgId)) {
    throw new CreditDeniedError(opts.orgId, estimatedCents);
  }
}

export type ChargeTurnContext = {
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId?: string;
  /** BYOK turns are metered but do not consume camelAI credits. */
  bypass?: boolean;
};

export function chargeTurn(
  billing: HostedBillingService,
  usage: UsageService,
  ctx: ChargeTurnContext,
  charge: {
    cents: number;
    durationMs?: number;
    model?: string;
  },
): void {
  if (
    !Number.isInteger(charge.cents) ||
    !Number.isFinite(charge.cents) ||
    charge.cents < 0
  ) {
    throw new Error("chargeTurn: cents must be a non-negative integer");
  }

  const creditChargeable = !ctx.bypass;
  if (creditChargeable && charge.cents > 0) {
    billing.consumeCredits?.(ctx.orgId, charge.cents);
  }

  usage.recordUsage({
    id: crypto.randomUUID(),
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
    kind: "turn",
    ...(charge.model ? { model: charge.model } : {}),
    cents: charge.cents,
    creditChargeable,
    ...(charge.durationMs === undefined
      ? {}
      : { durationMs: charge.durationMs }),
    createdAt: new Date().toISOString(),
  });
}
