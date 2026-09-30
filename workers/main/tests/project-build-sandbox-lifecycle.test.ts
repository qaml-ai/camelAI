import { describe, expect, it } from "vitest";

import { PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS } from "../src/container-sizing";
import { nextBuildSessionDeadline, projectBuildSandboxKey } from "../src/project-build-sandbox-lifecycle";

describe("projectBuildSandboxKey", () => {
  it("derives a stable, length-bounded key per org", () => {
    expect(projectBuildSandboxKey("Org_123")).toBe("org-org-123");
    const long = projectBuildSandboxKey("a".repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).toBe(projectBuildSandboxKey("a".repeat(200)));
    expect(() => projectBuildSandboxKey("  ")).toThrow("orgId is required");
  });
});

describe("build session window policy", () => {
  it("extends an unset or shorter window and skips a redundant write", () => {
    expect(nextBuildSessionDeadline(1_000, undefined, 60_000)).toBe(61_000);
    expect(nextBuildSessionDeadline(1_000, 30_000, 60_000)).toBe(61_000);
    // Stored deadline already covers the new one — no storage write.
    expect(nextBuildSessionDeadline(1_000, 120_000, 60_000)).toBeNull();
  });

  it("caps a requested window so a caller cannot pin the container", () => {
    expect(nextBuildSessionDeadline(0, undefined, 10 * 60 * 60_000))
      .toBe(PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS);
    expect(nextBuildSessionDeadline(0, undefined, 0)).toBeNull();
    expect(nextBuildSessionDeadline(0, undefined, Number.NaN)).toBeNull();
  });
});
