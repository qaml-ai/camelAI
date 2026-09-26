import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_INSTANCE_TYPE,
  ANALYSIS_SLEEP_AFTER,
  DB_QUERY_INSTANCE_TYPE,
  DB_QUERY_SLEEP_AFTER,
  PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS,
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
  PROJECT_BUILD_INSTANCE_TYPE,
  PROJECT_BUILD_SLEEP_AFTER,
} from "../workers/main/src/container-sizing";

/**
 * Strip // and /* *\/ comments plus trailing commas so wrangler JSONC can be
 * JSON.parse'd. Good enough for our containers blocks (no // inside strings).
 */
function loadJsonc(path: string): { containers?: Array<{ class_name: string; instance_type: string }> } {
  const raw = readFileSync(path, "utf8");
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped);
}

function instanceTypesByClass(path: string): Record<string, string> {
  const config = loadJsonc(resolve(process.cwd(), path));
  const out: Record<string, string> = {};
  for (const entry of config.containers ?? []) {
    out[entry.class_name] = entry.instance_type;
  }
  return out;
}

const EXPECTED = {
  ProjectBuildSandbox: PROJECT_BUILD_INSTANCE_TYPE,
  AnalysisSandbox: ANALYSIS_INSTANCE_TYPE,
  DbQuerySandbox: DB_QUERY_INSTANCE_TYPE,
} as const;

describe("container right-sizing", () => {
  it("keeps idle sleep shorter than the SDK 10m default for provisioned billing", () => {
    expect(PROJECT_BUILD_SLEEP_AFTER).toBe("2m");
    expect(ANALYSIS_SLEEP_AFTER).toBe("5m");
    expect(DB_QUERY_SLEEP_AFTER).toBe("2m");
  });

  it("bounds the active build-session warm window", () => {
    // Longer than the 2m idle sleep (that is the point), but capped well short
    // of a workday so a quiet workspace stops billing provisioned memory.
    expect(PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS).toBeGreaterThan(2 * 60_000);
    expect(PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS)
      .toBeLessThanOrEqual(PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS);
    expect(PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it.each([
    ["wrangler.prod.jsonc", ["ProjectBuildSandbox", "AnalysisSandbox", "DbQuerySandbox"]],
    ["wrangler.staging.jsonc", ["ProjectBuildSandbox", "AnalysisSandbox", "DbQuerySandbox"]],
    ["wrangler.jsonc", ["ProjectBuildSandbox", "AnalysisSandbox", "DbQuerySandbox"]],
    ["wrangler.test.jsonc", ["ProjectBuildSandbox", "AnalysisSandbox"]],
    ["wrangler.dev-miguel.jsonc", ["ProjectBuildSandbox", "DbQuerySandbox"]],
    ["wrangler.dev-illiana.jsonc", ["ProjectBuildSandbox", "DbQuerySandbox"]],
  ] as const)("%s instance_type matches container-sizing.ts", (path, classes) => {
    const types = instanceTypesByClass(path);
    for (const className of classes) {
      expect(types[className], `${path} ${className}`).toBe(EXPECTED[className]);
    }
  });
});
