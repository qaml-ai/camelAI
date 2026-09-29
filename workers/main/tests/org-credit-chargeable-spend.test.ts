import { describe, expect, it } from "vitest";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

async function newOrgStub(label: string) {
  const { userId } = await createUser(
    testEnv,
    `${label}-${crypto.randomUUID()}@example.test`,
    "password123",
    label,
  );
  const { org } = await createOrg(testEnv, label, userId);
  return { userId, orgStub: testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) };
}

async function chargeableScanUsd(
  orgStub: Awaited<ReturnType<typeof newOrgStub>>["orgStub"],
): Promise<number> {
  // The gates scan `created_at_ms < Date.now()`, which drops a row written in
  // the same millisecond; look a second ahead so the comparison is exact.
  return (await orgStub.getUsageLogSum(0, Date.now() + 1_000, true)).total_cost_usd;
}

describe("OrgDO credit-chargeable spend total", () => {
  it("matches the all-time chargeable usage_log scan", async () => {
    const { userId, orgStub } = await newOrgStub("Chargeable Spend");
    expect(await orgStub.getCreditChargeableSpendUsd()).toBe(0);

    await orgStub.recordUsage({
      user_id: userId, provider: "anthropic", model: "claude-sonnet-5",
      usage_kind: "llm", usage_surface: "agent", cost_usd: 1.25,
      credit_chargeable: true, source: "pi_assistant", source_id: "a",
    });
    // Not chargeable (BYOK / enterprise / credit-free): excluded from both.
    await orgStub.recordUsage({
      user_id: userId, provider: "anthropic", model: "claude-sonnet-5",
      usage_kind: "llm", usage_surface: "agent", cost_usd: 7,
      credit_chargeable: false, billing_source: "byok", source: "pi_assistant", source_id: "b",
    });
    // Numeric flag, back-dated row, and a cost derived from reported cost.
    await orgStub.recordUsage({
      user_id: userId, provider: "camelai", model: "web-search",
      usage_kind: "capability", usage_surface: "capability", reported_cost_usd: 0.4,
      credit_chargeable: 1, created_at_ms: Date.now() - 86_400_000,
      billing_source: "hosted_capability", source: "web_search", source_id: "c",
    });
    // A duplicate (source, source_id) is not recorded twice.
    await orgStub.recordUsage({
      user_id: userId, provider: "anthropic", model: "claude-sonnet-5",
      usage_kind: "llm", usage_surface: "agent", cost_usd: 1.25,
      credit_chargeable: true, source: "pi_assistant", source_id: "a",
    });
    // No source id: never deduplicated.
    await orgStub.recordUsage({
      user_id: userId, provider: "openrouter", model: "dynamic/auto_image",
      usage_kind: "image", usage_surface: "auxiliary", cost_usd: 0.05,
      credit_chargeable: true, thread_id: "virtual-ai",
    });

    const scan = await chargeableScanUsd(orgStub);
    expect(scan).toBeCloseTo(1.7, 10);
    expect(await orgStub.getCreditChargeableSpendUsd()).toBeCloseTo(scan, 10);
  });

  it("backfills the total from usage_log for an org recorded before it existed", async () => {
    const { userId, orgStub } = await newOrgStub("Chargeable Backfill");
    for (const [index, chargeable] of [true, false, true].entries()) {
      await orgStub.recordUsage({
        user_id: userId, provider: "anthropic", model: "claude-sonnet-5",
        usage_kind: "llm", usage_surface: "agent", cost_usd: index + 1,
        credit_chargeable: chargeable, source: "pi_assistant", source_id: `row-${index}`,
      });
    }
    await runInDurableObject(orgStub, (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE usage_spend DROP COLUMN chargeable_cost_usd");
    });
    await evictDurableObject(orgStub);

    expect(await orgStub.getCreditChargeableSpendUsd()).toBe(4);
    expect(await chargeableScanUsd(orgStub)).toBe(4);

    // The backfill runs once; later rows add to it.
    await orgStub.recordUsage({
      user_id: userId, provider: "anthropic", model: "claude-sonnet-5",
      usage_kind: "llm", usage_surface: "agent", cost_usd: 0.5,
      credit_chargeable: true, source: "pi_assistant", source_id: "after",
    });
    await evictDurableObject(orgStub);
    expect(await orgStub.getCreditChargeableSpendUsd()).toBe(4.5);
    expect(await chargeableScanUsd(orgStub)).toBe(4.5);
  });
});
