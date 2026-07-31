import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCanStartHostedTurn,
  chargeTurn,
  CreditDeniedError,
} from "../src/server/chat/credits-gate.ts";
import { createPlatform } from "../src/server/platform/index.ts";

const tempDirs: string[] = [];

function platformFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "agentos-credits-"));
  tempDirs.push(dataDir);
  return createPlatform({ dataDir });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("hosted turn credit gate", () => {
  it("denies a hosted turn with no credits and permits BYOK", () => {
    const platform = platformFixture();
    expect(() =>
      assertCanStartHostedTurn({
        billing: platform.billing,
        orgId: "org-empty",
      }),
    ).toThrow(CreditDeniedError);
    expect(() =>
      assertCanStartHostedTurn({
        billing: platform.billing,
        orgId: "org-empty",
        bypass: true,
      }),
    ).not.toThrow();
  });

  it("charges credits and records the successful turn", () => {
    const platform = platformFixture();
    platform.billing.grantCredits("org-funded", 10);
    assertCanStartHostedTurn({
      billing: platform.billing,
      orgId: "org-funded",
    });

    chargeTurn(
      platform.billing,
      platform.usage,
      {
        orgId: "org-funded",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        userId: "user-1",
      },
      { cents: 3, durationMs: 20, model: "hosted/test" },
    );

    expect(platform.billing.getCreditBalance("org-funded")).toBe(7);
    expect(platform.usage.listUsage("org-funded")).toMatchObject([
      {
        orgId: "org-funded",
        kind: "turn",
        cents: 3,
        creditChargeable: true,
        durationMs: 20,
        model: "hosted/test",
      },
    ]);
    expect(platform.usage.sumChargeableCents("org-funded")).toBe(3);
  });

  it("meters BYOK turns without consuming credits", () => {
    const platform = platformFixture();
    chargeTurn(
      platform.billing,
      platform.usage,
      {
        orgId: "org-byok",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        bypass: true,
      },
      { cents: 4 },
    );

    expect(platform.billing.getCreditBalance("org-byok")).toBe(0);
    expect(platform.usage.listUsage("org-byok")[0]).toMatchObject({
      cents: 4,
      creditChargeable: false,
    });
    expect(platform.usage.sumChargeableCents("org-byok")).toBe(0);
  });
});
