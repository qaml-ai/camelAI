import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store, UsageService } from "../src/server/platform/index.ts";

const tempDirs: string[] = [];

function createUsage(): UsageService {
  const dataDir = mkdtempSync(join(tmpdir(), "agentos-usage-"));
  tempDirs.push(dataDir);
  return new UsageService(new Store({ dataDir }));
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("UsageService", () => {
  it("records, filters, limits, and sums chargeable usage", () => {
    const usage = createUsage();
    usage.recordUsage({
      id: "old",
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      kind: "inference",
      model: "hosted/test",
      cents: 2,
      creditChargeable: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    usage.recordUsage({
      id: "new",
      orgId: "org-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      userId: "user-1",
      kind: "turn",
      cents: 7,
      creditChargeable: false,
      durationMs: 25,
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    usage.recordUsage({
      id: "other-org",
      orgId: "org-2",
      workspaceId: "workspace-2",
      threadId: "thread-2",
      kind: "tool",
      cents: 100,
      creditChargeable: true,
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    expect(usage.listUsage("org-1").map((event) => event.id)).toEqual([
      "new",
      "old",
    ]);
    expect(
      usage.listUsage("org-1", {
        since: "2026-01-02T00:00:00.000Z",
        limit: 1,
      }),
    ).toMatchObject([{ id: "new" }]);
    expect(usage.sumChargeableCents("org-1")).toBe(2);
  });

  it("validates malformed usage events", () => {
    const usage = createUsage();
    expect(() =>
      usage.recordUsage({
        id: "bad",
        orgId: "org-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        kind: "turn",
        cents: -1,
        creditChargeable: true,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(/non-negative integer/);
    expect(() => usage.listUsage("org-1", { since: "not-a-date" })).toThrow(
      /valid timestamp/,
    );
  });
});
