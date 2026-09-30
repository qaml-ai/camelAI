import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ANALYSIS_IDLE_TIMEOUT_MS,
  ANALYSIS_INSTANCE_TYPE,
  DB_QUERY_IDLE_TIMEOUT_MS,
  DB_QUERY_INSTANCE_TYPE,
  PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS,
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
  PROJECT_BUILD_IDLE_TIMEOUT_MS,
} from "../workers/main/src/container-sizing";

// The image keys only; importing the classes would pull in cloudflare:workers.
const PROJECT_BUILD_IMAGE = "project-build";
const DB_QUERY_IMAGE = "db-query";
const ANALYSIS_IMAGE = "analysis";

interface WranglerConfig {
  containers?: Array<Record<string, unknown>>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }>;
  vars: Record<string, string>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
}

/**
 * Strip // and /* *\/ comments plus trailing commas so wrangler JSONC can be
 * JSON.parse'd. Good enough for our containers blocks (no // inside strings).
 */
function loadJsonc(path: string): WranglerConfig {
  const raw = readFileSync(resolve(process.cwd(), path), "utf8");
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped);
}

describe("container right-sizing", () => {
  it("keeps idle windows short for provisioned billing", () => {
    expect(PROJECT_BUILD_IDLE_TIMEOUT_MS).toBe(2 * 60_000);
    expect(ANALYSIS_IDLE_TIMEOUT_MS).toBe(5 * 60_000);
    expect(DB_QUERY_IDLE_TIMEOUT_MS).toBe(2 * 60_000);
    // Chosen in start(): the durable_object policy has no instance_type.
    expect(ANALYSIS_INSTANCE_TYPE).toBe("standard-3");
    expect(DB_QUERY_INSTANCE_TYPE).toBe("standard-1");
  });

  it("bounds the active build-session warm window", () => {
    expect(PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS).toBeGreaterThan(2 * 60_000);
    expect(PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS)
      .toBeLessThanOrEqual(PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS);
    expect(PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS).toBeLessThanOrEqual(30 * 60_000);
  });

  it.each([
    "wrangler.prod.jsonc",
    "wrangler.staging.jsonc",
    "wrangler.jsonc",
    "wrangler.dev-miguel.jsonc",
    "wrangler.dev-illiana.jsonc",
  ])("%s declares only durable_object containers", (path) => {
    for (const container of loadJsonc(path).containers ?? []) {
      expect(container.scheduling_policy, `${path} ${String(container.class_name)}`).toBe("durable_object");
    }
  });

  it.each([
    ["wrangler.prod.jsonc", "chiridion-app-project-build"],
    ["wrangler.staging.jsonc", "chiridion-app-staging-project-build"],
    ["wrangler.jsonc", "chiridion-app-local-project-build"],
    ["wrangler.dev-miguel.jsonc", "chiridion-app-dev-miguel-project-build"],
    ["wrangler.dev-illiana.jsonc", "chiridion-app-dev-illiana-project-build"],
  ] as const)("%s declares ProjectBuildContainer as a durable_object container", (path, name) => {
    const config = loadJsonc(path);
    expect(config.containers?.find((container) => container.class_name === "ProjectBuildContainer")).toEqual({
      class_name: "ProjectBuildContainer",
      name,
      scheduling_policy: "durable_object",
      images: { [PROJECT_BUILD_IMAGE]: { dockerfile: "./workers/main/project-build-container.Dockerfile" } },
    });
    expect(config.durable_objects.bindings).toContainEqual({
      name: "PROJECT_BUILD_SANDBOX",
      class_name: "ProjectBuildContainer",
    });
    const created = config.migrations.findIndex((m) => m.new_sqlite_classes?.includes("ProjectBuildContainer"));
    expect(config.migrations[created + 1]).toEqual(expect.objectContaining({ deleted_classes: ["ProjectBuildSandbox"] }));
  });

  it.each([
    ["wrangler.prod.jsonc", "chiridion-app-db-query", "chiridion-warehouse-exports"],
    ["wrangler.staging.jsonc", "chiridion-app-staging-db-query", "chiridion-warehouse-exports-staging"],
    ["wrangler.jsonc", "chiridion-app-local-db-query", "chiridion-warehouse-exports-staging"],
    ["wrangler.dev-miguel.jsonc", "chiridion-app-dev-miguel-db-query", undefined],
    ["wrangler.dev-illiana.jsonc", "chiridion-app-dev-illiana-db-query", undefined],
  ] as const)("%s serves DB_QUERY_SANDBOX from the DbQueryContainer durable_object container", (path, name, bucketName) => {
    const config = loadJsonc(path);
    expect(config.containers?.find((container) => container.class_name === "DbQueryContainer")).toEqual({
      class_name: "DbQueryContainer",
      name,
      scheduling_policy: "durable_object",
      images: { [DB_QUERY_IMAGE]: { dockerfile: "./workers/main/db-query-container.Dockerfile" } },
    });
    expect(config.durable_objects.bindings.filter((binding) => binding.name.startsWith("DB_QUERY"))).toEqual([
      { name: "DB_QUERY_SANDBOX", class_name: "DbQueryContainer" },
    ]);
    expect(config.migrations).toContainEqual(expect.objectContaining({
      new_sqlite_classes: ["DbQueryContainer"],
      deleted_classes: ["DbQuerySandbox"],
    }));
    // The S3 mount must name the bucket the WAREHOUSE_EXPORT_BUCKET binding uses.
    const bound = config.r2_buckets?.find((bucket) => bucket.binding === "WAREHOUSE_EXPORT_BUCKET")?.bucket_name;
    expect(bound).toBe(bucketName);
    expect(config.vars.WAREHOUSE_EXPORT_BUCKET_NAME).toBe(bucketName);
  });

  it.each([
    ["wrangler.prod.jsonc", "chiridion-app-analysis"],
    ["wrangler.staging.jsonc", "chiridion-app-staging-analysis"],
    ["wrangler.jsonc", "chiridion-app-local-analysis"],
  ] as const)("%s declares AnalysisContainer as a durable_object container", (path, name) => {
    const config = loadJsonc(path);
    expect(config.containers?.find((container) => container.class_name === "AnalysisContainer")).toEqual({
      class_name: "AnalysisContainer",
      name,
      scheduling_policy: "durable_object",
      images: { [ANALYSIS_IMAGE]: { dockerfile: "./workers/main/analysis-container.Dockerfile" } },
    });
    expect(config.durable_objects.bindings).toContainEqual({
      name: "ANALYSIS_SANDBOX",
      class_name: "AnalysisContainer",
    });
    // One migration creates the new class and deletes the 0.12 one.
    expect(config.migrations).toContainEqual(expect.objectContaining({
      new_sqlite_classes: ["AnalysisContainer"],
      deleted_classes: ["AnalysisSandbox"],
    }));
    // The mounts name their buckets; S3 mounts need no second binding for /outputs.
    expect(config.vars.R2_BUCKET_NAME).toBeTruthy();
    expect(config.vars.WAREHOUSE_EXPORT_BUCKET_NAME).toBeTruthy();
    expect(config.r2_buckets?.some((bucket) => bucket.binding === "R2_OUTPUTS_BUCKET")).toBe(false);
  });

  it.each([
    "wrangler.prod.jsonc",
    "wrangler.staging.jsonc",
    "wrangler.jsonc",
    "wrangler.dev-miguel.jsonc",
    "wrangler.dev-illiana.jsonc",
    "wrangler.test.jsonc",
  ])("%s has increasing, unique migration tags", (path) => {
    const tags = loadJsonc(path).migrations.map((m) => Number(m.tag.slice(1)));
    for (let i = 1; i < tags.length; i += 1) expect(tags[i], `${path} after v${tags[i - 1]}`).toBeGreaterThan(tags[i - 1]);
  });

  it("keeps containers out of the worker test config (vitest-pool-workers' wrangler predates the durable_object policy)", () => {
    const config = loadJsonc("wrangler.test.jsonc");
    expect(config.containers ?? []).toEqual([]);
    expect(config.durable_objects.bindings).toContainEqual({ name: "ANALYSIS_SANDBOX", class_name: "AnalysisContainer" });
  });
});
