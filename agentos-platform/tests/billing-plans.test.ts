import { describe, expect, it } from "vitest";
import {
  BILLING_PLANS,
  BILLING_PLAN_LIMITS,
  includedCreditsForPlan,
  planAllowsHostedModels,
} from "../src/shared/billing-plans.ts";

describe("billing plans", () => {
  it("ports every camelAI plan and its core limits", () => {
    expect(BILLING_PLANS).toEqual([
      "free",
      "payg",
      "starter",
      "pro",
      "team",
      "enterprise",
    ]);
    expect(BILLING_PLAN_LIMITS.free.byokOnly).toBe(true);
    expect(BILLING_PLAN_LIMITS.starter.monthlyPriceCents).toBe(1000);
    expect(BILLING_PLAN_LIMITS.pro.includedCreditCentsBase).toBe(4000);
    expect(BILLING_PLAN_LIMITS.team.minimumSeats).toBe(3);
    expect(BILLING_PLAN_LIMITS.enterprise.includedWorkspaceCount).toBeNull();
  });

  it("calculates base and seat-based included credits", () => {
    expect(includedCreditsForPlan("starter", 1)).toBe(1000);
    expect(includedCreditsForPlan("pro", 20)).toBe(4000);
    expect(includedCreditsForPlan("team", 1)).toBe(15_000);
    expect(includedCreditsForPlan("team", 4)).toBe(20_000);
    expect(includedCreditsForPlan("payg", undefined)).toBe(0);
  });

  it("only blocks hosted models on the BYOK-only free plan", () => {
    expect(planAllowsHostedModels("free")).toBe(false);
    for (const plan of BILLING_PLANS.filter((value) => value !== "free")) {
      expect(planAllowsHostedModels(plan)).toBe(true);
    }
  });
});
