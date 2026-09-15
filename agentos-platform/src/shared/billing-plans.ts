export const BILLING_PLANS = [
  "free",
  "payg",
  "starter",
  "pro",
  "team",
  "enterprise",
] as const;

export type BillingPlan = (typeof BILLING_PLANS)[number];

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

export function includedCreditsForPlan(
  plan: BillingPlan,
  seatCount: number | null | undefined,
): number {
  const limits = BILLING_PLAN_LIMITS[plan];
  const seats = Number.isFinite(seatCount)
    ? Math.max(limits.minimumSeats, Math.floor(seatCount ?? limits.minimumSeats))
    : limits.minimumSeats;
  return (
    limits.includedCreditCentsBase + limits.includedCreditCentsPerSeat * seats
  );
}

export function planAllowsHostedModels(plan: BillingPlan): boolean {
  return !BILLING_PLAN_LIMITS[plan].byokOnly;
}
