import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { ChatThreadDO } from "../src/chat-thread-do";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `chat-billing-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function createFakeThread() {
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.env = testEnv;
  fake.formatCreditCents = ChatThreadDO.prototype["formatCreditCents"];
  return fake;
}

describe("ChatThreadDO hosted billing access", () => {
  it("honors persisted enterprise status before checking credits", async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Configured Enterprise User",
    );
    const { org } = await createOrg(testEnv, "Enterprise Org", userId, {
      billingPlan: "enterprise",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
    });

    const fake = createFakeThread();

    await expect(
      ChatThreadDO.prototype["checkHostedPiModelAccess"].call(fake, {
        orgId: org.id,
      }),
    ).resolves.toEqual({
      creditChargeable: false,
      vllmPriority: "0",
    });
  });

  it("uses generic hosted credit exhaustion wording for legacy trialing orgs", async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Trialing Credits User",
    );
    const { org } = await createOrg(testEnv, "Trialing Credits Org", userId, {
      billingPlan: "starter",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "trialing",
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
    });

    const fake = createFakeThread();

    let error: unknown;
    try {
      await ChatThreadDO.prototype["checkHostedPiModelAccess"].call(fake, {
        orgId: org.id,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Hosted model credits are used up.",
    );
    expect((error as Error).message).not.toContain("Trial hosted-model");
  });

  it("allows camelCode without credits", async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "camelCode User",
    );
    const { org } = await createOrg(testEnv, "camelCode Org", userId, {
      billingPlan: "starter",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "trialing",
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
    });

    const fake = createFakeThread();

    await expect(
      ChatThreadDO.prototype["checkHostedPiModelAccess"].call(
        fake,
        { orgId: org.id },
        "deepseek-v4-auto",
      ),
    ).resolves.toEqual({
      creditChargeable: false,
      vllmPriority: "100",
    });
  });

  it("allows camelCode without an active paid subscription", async () => {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Inactive camelCode User",
    );
    const { org } = await createOrg(testEnv, "Inactive camelCode Org", userId, {
      billingPlan: "starter",
    });
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.updateBillingState({
      billing_status: "inactive",
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
    });

    const fake = createFakeThread();

    await expect(
      ChatThreadDO.prototype["checkHostedPiModelAccess"].call(
        fake,
        { orgId: org.id },
        "deepseek-v4-auto",
      ),
    ).resolves.toEqual({
      creditChargeable: false,
      vllmPriority: "100",
    });
  });

  it("starts a hosted thread without a stored model on camelCode", async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: "thread_free",
        workspace_id: "workspace_free",
      })),
      getInfo: vi.fn(async () => ({
        billing_status: "past_due",
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
      })),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: "thread_free",
      workspaceId: "workspace_free",
      orgId: "org_free",
      userId: "user_free",
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
    };
    fake.ctx = { storage: { kv: { put: vi.fn() } } };
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.getCachedLlmProviderConfig = vi.fn(async () => null);
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype["ensurePiSessionReady"].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread_free" }),
      expect.objectContaining({
        CHIRIDION_MODEL: "deepseek-v4-auto",
        CHIRIDION_MODEL: "deepseek-v4-auto",
      }),
    );
  });
});
