import type { BillingPlan, Organization } from "@/types";

export const BILLING_PLANS = [
  "free",
  "payg",
  "starter",
  "pro",
  "team",
  "enterprise",
] as const satisfies readonly BillingPlan[];

export interface BillingPlanLimits {
  plan: BillingPlan;
  label: string;
  monthlyPriceCents: number | null;
  minimumSeats: number;
  includedWorkspaceCount: number | null;
  storageGbPerWorkspace: number | null;
  includedCreditCentsPerSeat: number;
  includedCreditCentsBase: number;
  maxDeployedAppsPerWorkspace: number | null;
  maxCustomDomains: number | null;
  maxCronJobsPerWorkspace: number | null;
  maxCronJobsPerUser: number | null;
  minCronIntervalMs: number | null;
  byokOnly: boolean;
  emailInbox: boolean;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const BILLING_PLAN_LIMITS: Record<BillingPlan, BillingPlanLimits> = {
  free: {
    plan: "free",
    label: "Free",
    monthlyPriceCents: 0,
    minimumSeats: 1,
    includedWorkspaceCount: 1,
    storageGbPerWorkspace: 5,
    includedCreditCentsPerSeat: 0,
    includedCreditCentsBase: 0,
    maxDeployedAppsPerWorkspace: 3,
    maxCustomDomains: 0,
    maxCronJobsPerWorkspace: 1,
    maxCronJobsPerUser: null,
    minCronIntervalMs: DAY_MS,
    byokOnly: true,
    emailInbox: false,
  },
  payg: {
    plan: "payg",
    label: "Free",
    monthlyPriceCents: 0,
    minimumSeats: 1,
    includedWorkspaceCount: 1,
    storageGbPerWorkspace: 5,
    includedCreditCentsPerSeat: 0,
    includedCreditCentsBase: 0,
    maxDeployedAppsPerWorkspace: 3,
    maxCustomDomains: 0,
    maxCronJobsPerWorkspace: 1,
    maxCronJobsPerUser: null,
    minCronIntervalMs: DAY_MS,
    byokOnly: false,
    emailInbox: false,
  },
  starter: {
    plan: "starter",
    label: "Starter",
    monthlyPriceCents: 1000,
    minimumSeats: 1,
    includedWorkspaceCount: 1,
    storageGbPerWorkspace: 50,
    includedCreditCentsPerSeat: 0,
    includedCreditCentsBase: 1000,
    maxDeployedAppsPerWorkspace: 30,
    maxCustomDomains: 10,
    maxCronJobsPerWorkspace: 1,
    maxCronJobsPerUser: null,
    minCronIntervalMs: HOUR_MS,
    byokOnly: false,
    emailInbox: true,
  },
  pro: {
    plan: "pro",
    label: "Pro",
    monthlyPriceCents: 4000,
    minimumSeats: 1,
    includedWorkspaceCount: 1,
    storageGbPerWorkspace: 100,
    includedCreditCentsPerSeat: 0,
    includedCreditCentsBase: 4000,
    maxDeployedAppsPerWorkspace: null,
    maxCustomDomains: null,
    maxCronJobsPerWorkspace: 50,
    maxCronJobsPerUser: null,
    minCronIntervalMs: 5 * MINUTE_MS,
    byokOnly: false,
    emailInbox: true,
  },
  team: {
    plan: "team",
    label: "Team",
    monthlyPriceCents: 5000,
    minimumSeats: 3,
    includedWorkspaceCount: 2,
    storageGbPerWorkspace: 100,
    includedCreditCentsPerSeat: 5000,
    includedCreditCentsBase: 0,
    maxDeployedAppsPerWorkspace: null,
    maxCustomDomains: null,
    maxCronJobsPerWorkspace: null,
    maxCronJobsPerUser: 50,
    minCronIntervalMs: 5 * MINUTE_MS,
    byokOnly: false,
    emailInbox: true,
  },
  enterprise: {
    plan: "enterprise",
    label: "Enterprise",
    monthlyPriceCents: null,
    minimumSeats: 1,
    includedWorkspaceCount: null,
    storageGbPerWorkspace: null,
    includedCreditCentsPerSeat: 0,
    includedCreditCentsBase: 0,
    maxDeployedAppsPerWorkspace: null,
    maxCustomDomains: null,
    maxCronJobsPerWorkspace: null,
    maxCronJobsPerUser: null,
    minCronIntervalMs: null,
    byokOnly: false,
    emailInbox: true,
  },
};

export function isBillingPlan(
  value: string | null | undefined,
): value is BillingPlan {
  return BILLING_PLANS.includes(value as BillingPlan);
}

export function normalizeBillingPlan(
  plan: string | null | undefined,
  status?: string | null,
): BillingPlan {
  if (status === "enterprise" || plan === "enterprise") return "enterprise";
  if (plan === "free") return "payg";
  if (isBillingPlan(plan)) return plan;
  if (
    status === "trialing" ||
    status === "active" ||
    status === "past_due" ||
    status === "paying"
  ) {
    return "starter";
  }
  return "payg";
}

export function getBillingPlanLimits(
  plan: string | null | undefined,
  status?: string | null,
): BillingPlanLimits {
  return BILLING_PLAN_LIMITS[normalizeBillingPlan(plan, status)];
}

export function getMinimumSeats(plan: BillingPlan): number {
  return BILLING_PLAN_LIMITS[plan].minimumSeats;
}

export function normalizeSeatCount(
  plan: BillingPlan,
  seatCount: number | null | undefined,
): number {
  const minimumSeats = getMinimumSeats(plan);
  if (!Number.isFinite(seatCount)) return minimumSeats;
  return Math.max(minimumSeats, Math.floor(seatCount ?? minimumSeats));
}

export function getIncludedCreditCentsForPlan(
  plan: BillingPlan,
  seatCount: number | null | undefined,
): number {
  const limits = BILLING_PLAN_LIMITS[plan];
  const seats = normalizeSeatCount(plan, seatCount);
  return (
    limits.includedCreditCentsBase + limits.includedCreditCentsPerSeat * seats
  );
}

export function getOrgBillingPlan(
  org: Pick<Organization, "billing_status" | "billing_plan">,
): BillingPlan {
  return normalizeBillingPlan(org.billing_plan, org.billing_status);
}

export function getOrgSeatCount(
  org: Pick<
    Organization,
    "billing_status" | "billing_plan" | "billing_seat_count"
  >,
): number {
  return normalizeSeatCount(getOrgBillingPlan(org), org.billing_seat_count);
}

export function getOrgSeatLimit(
  org: Pick<
    Organization,
    "billing_status" | "billing_plan" | "billing_seat_count"
  >,
): number | null {
  const plan = getOrgBillingPlan(org);
  if (plan === "enterprise") return null;
  if (plan === "team") return getOrgSeatCount(org);
  return 1;
}

function isTeamSeatSyncableStatus(status: string | null | undefined): boolean {
  switch (status?.trim().toLowerCase()) {
    case "trialing":
    case "active":
    case "past_due":
    case "paying":
      return true;
    default:
      return false;
  }
}

export function isTeamSeatBillingSyncable(
  org: Pick<
    Organization,
    | "billing_status"
    | "billing_plan"
    | "billing_subscription_id"
    | "billing_subscription_status"
  >,
): boolean {
  if (getOrgBillingPlan(org) !== "team") return false;
  if (org.billing_status === "enterprise") return false;
  if (!org.billing_subscription_id?.trim()) return false;

  const stripeSubscriptionStatus = org.billing_subscription_status?.trim();
  if (stripeSubscriptionStatus) {
    return isTeamSeatSyncableStatus(stripeSubscriptionStatus);
  }

  return isTeamSeatSyncableStatus(org.billing_status);
}

export interface BillableTeamInviteSeatChange {
  coveredSeatCount: number;
  occupiedSeatCount: number;
  requestedInviteCount: number;
  nextSeatCount: number;
  addedSeatCount: number;
  addedMonthlyAmountCents: number;
}

export interface TeamInviteBillingContext {
  occupiedSeatCount: number;
  coveredSeatCount: number;
  unitMonthlyAmountCents: number;
  minimumSeats: number;
  syncable: boolean;
}

export function getBillableTeamInviteSeatChangeForCount(
  org: Pick<
    Organization,
    | "billing_status"
    | "billing_plan"
    | "billing_seat_count"
    | "billing_subscription_id"
    | "billing_subscription_status"
  >,
  occupiedSeatCount: number,
  requestedInviteCount: number,
): BillableTeamInviteSeatChange | null {
  if (requestedInviteCount <= 0) return null;
  if (!isTeamSeatBillingSyncable(org)) return null;

  const coveredSeatCount = getOrgSeatCount(org);
  const nextSeatCount = normalizeSeatCount(
    "team",
    occupiedSeatCount + requestedInviteCount,
  );
  const addedSeatCount = Math.max(0, nextSeatCount - coveredSeatCount);

  if (addedSeatCount === 0) return null;

  return {
    coveredSeatCount,
    occupiedSeatCount,
    requestedInviteCount,
    nextSeatCount,
    addedSeatCount,
    addedMonthlyAmountCents:
      addedSeatCount * (BILLING_PLAN_LIMITS.team.monthlyPriceCents ?? 0),
  };
}

export function getBillableTeamInviteSeatChange(
  org: Pick<
    Organization,
    | "billing_status"
    | "billing_plan"
    | "billing_seat_count"
    | "billing_subscription_id"
    | "billing_subscription_status"
  >,
  occupiedSeatCount: number,
): BillableTeamInviteSeatChange | null {
  return getBillableTeamInviteSeatChangeForCount(org, occupiedSeatCount, 1);
}
