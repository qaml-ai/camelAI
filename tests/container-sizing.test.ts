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
  PROJECT_BUILD_IDLE_TIMEOUT_MS,
} from "../workers/main/src/container-sizing";

// The image key only; importing the class would pull in cloudflare:workers.
const PROJECT_BUILD_IMAGE = "project-build";

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
  AnalysisSandbox: ANALYSIS_INSTANCE_TYPE,
  DbQuerySandbox: DB_QUERY_INSTANCE_TYPE,
} as const;

describe("container right-sizing", () => {
  it("keeps idle sleep shorter than the SDK 10m default for provisioned billing", () => {
    expect(PROJECT_BUILD_IDLE_TIMEOUT_MS).toBe(2 * 60_000);
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
    ["wrangler.prod.jsonc", "chiridion-app-project-build"],
    ["wrangler.staging.jsonc", "chiridion-app-staging-project-build"],
    ["wrangler.jsonc", "chiridion-app-local-project-build"],
    ["wrangler.dev-miguel.jsonc", "chiridion-app-dev-miguel-project-build"],
    ["wrangler.dev-illiana.jsonc", "chiridion-app-dev-illiana-project-build"],
  ] as const)("%s declares ProjectBuildContainer as a durable_object container", (path, name) => {
    const config = loadJsonc(resolve(process.cwd(), path)) as unknown as {
      containers: Array<Record<string, unknown>>;
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }>;
    };
    const entry = config.containers.find((container) => container.class_name === "ProjectBuildContainer");
    // The durable_object policy rejects image/instance_type/max_instances, and
    // each environment needs its own container application name.
    expect(entry).toEqual({
      class_name: "ProjectBuildContainer",
      name,
      scheduling_policy: "durable_object",
      images: { [PROJECT_BUILD_IMAGE]: { dockerfile: "./workers/main/project-build-container.Dockerfile" } },
    });
    expect(config.containers.some((container) => container.class_name === "ProjectBuildSandbox")).toBe(false);
    expect(config.durable_objects.bindings).toContainEqual({
      name: "PROJECT_BUILD_SANDBOX",
      class_name: "ProjectBuildContainer",
    });
    expect(config.migrations.slice(-2)).toEqual([
      expect.objectContaining({ new_sqlite_classes: ["ProjectBuildContainer"] }),
      expect.objectContaining({ deleted_classes: ["ProjectBuildSandbox"] }),
    ]);
  });

  it.each([
    ["wrangler.prod.jsonc", ["AnalysisSandbox", "DbQuerySandbox"]],
    ["wrangler.staging.jsonc", ["AnalysisSandbox", "DbQuerySandbox"]],
    ["wrangler.jsonc", ["AnalysisSandbox", "DbQuerySandbox"]],
    ["wrangler.test.jsonc", ["AnalysisSandbox"]],
    ["wrangler.dev-miguel.jsonc", ["DbQuerySandbox"]],
    ["wrangler.dev-illiana.jsonc", ["DbQuerySandbox"]],
  ] as const)("%s instance_type matches container-sizing.ts", (path, classes) => {
    const types = instanceTypesByClass(path);
    for (const className of classes) {
      expect(types[className], `${path} ${className}`).toBe(EXPECTED[className]);
    }
  });
});
