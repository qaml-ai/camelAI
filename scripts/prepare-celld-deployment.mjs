#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildServerDir = path.join(repoRoot, "build/server");
const sourceConfigPath = path.join(buildServerDir, "wrangler.json");
const targetConfigPath = path.join(buildServerDir, "wrangler.celld.json");
const stagedAssetsPath = path.join(buildServerDir, "celld-assets");
const workerName = process.env.CELLD_WORKER_NAME ?? "chiridion-celld";
const appDatabaseName =
  process.env.CELLD_APP_DB_NAME ?? "chiridion-app-celld-db";

const EXTERNAL_COMPUTE_CLASSES = new Set([
  "AnalysisSandbox",
  "ProjectBuildSandbox",
  "DbQuerySandbox",
]);

const CELLD_SELFHOST_VARS = {
  NODE_ENV: "production",
  AI_VIRTUAL_MODEL: "dynamic/auto",
  ARTIFACTS_NAMESPACE: "selfhost",
  CF_ACCOUNT_ID: "selfhost",
  CF_DISPATCH_NAMESPACE: "selfhost",
  CF_WORKER_NAME: workerName,
  CELLD_RUNTIME: "1",
  EMAIL_FROM_ADDRESS: "no-reply@localhost",
  LOCAL_APP_IFRAME_DOMAIN:
    process.env.LOCAL_APP_IFRAME_DOMAIN ?? "localhost",
  LOCAL_APP_VANITY_DOMAIN:
    process.env.LOCAL_APP_VANITY_DOMAIN ?? "localhost",
  WORKSPACE_EMAIL_DOMAIN: "localhost",
  WORKER_BASE_URL: process.env.CELLD_PUBLIC_BASE_URL ?? "http://127.0.0.1:8080",
  LOCAL_ARTIFACTS_BASE_URL:
    process.env.LOCAL_ARTIFACTS_BASE_URL ?? "http://127.0.0.1:7001",
};

const sourceConfig = JSON.parse(await fs.readFile(sourceConfigPath, "utf8"));
const sourceBindings = sourceConfig.durable_objects?.bindings;
if (!Array.isArray(sourceBindings) || sourceBindings.length === 0) {
  throw new Error(`No Durable Object bindings found in ${sourceConfigPath}`);
}

const durableObjectBindings = sourceBindings.filter(
  (binding) => !EXTERNAL_COMPUTE_CLASSES.has(binding.class_name),
);
const sqliteClasses = [
  ...new Set(durableObjectBindings.map((binding) => binding.class_name)),
];

const sourceAssetsDirectory = sourceConfig.assets?.directory;
if (typeof sourceAssetsDirectory !== "string" || !sourceAssetsDirectory) {
  throw new Error(`No assets directory found in ${sourceConfigPath}`);
}
const sourceAssetsPath = path.resolve(buildServerDir, sourceAssetsDirectory);

await fs.rm(stagedAssetsPath, { recursive: true, force: true });
await fs.cp(sourceAssetsPath, stagedAssetsPath, {
  recursive: true,
  filter: (source) => path.basename(source) !== ".assetsignore",
});

const config = {
  name: workerName,
  main: sourceConfig.main ?? "index.js",
  compatibility_date: sourceConfig.compatibility_date,
  compatibility_flags: sourceConfig.compatibility_flags ?? [],
  durable_objects: { bindings: durableObjectBindings },
  migrations: [
    {
      tag: "celld-v1",
      new_sqlite_classes: sqliteClasses,
    },
  ],
  assets: {
    binding: sourceConfig.assets.binding ?? "ASSETS",
    directory: "celld-assets",
  },
  services: [
    {
      binding: "APP_KV",
      service: "chiridion-celld-kv",
      entrypoint: "AppKv",
    },
    {
      binding: "EMAIL_TO_USER",
      service: "chiridion-celld-kv",
      entrypoint: "EmailToUserKv",
    },
    {
      binding: "SESSIONS",
      service: "chiridion-celld-kv",
      entrypoint: "SessionsKv",
    },
    {
      binding: "WORKER_SELF_REFERENCE",
      service: workerName,
    },
    ...[
      "OBJECT_STORE_SERVICE",
      "ARTIFACTS_SERVICE",
      "COMPUTE_SERVICE",
      "CODE_EXECUTOR_SERVICE",
      "AI_SERVICE",
      "EMAIL_SERVICE",
      "BROWSER_SERVICE",
      "IMAGES_SERVICE",
      "QUEUE_SERVICE",
      "PIPELINE_SERVICE",
      "OBSERVABILITY_SERVICE",
    ].map((binding) => ({
      binding,
      service: "chiridion-celld-facades",
    })),
  ],
  triggers: sourceConfig.triggers ?? {},
  vars: CELLD_SELFHOST_VARS,
  d1_databases: (sourceConfig.d1_databases ?? []).map((database) =>
    database.binding === "APP_DB"
      ? {
          ...database,
          database_name: appDatabaseName,
          database_id: appDatabaseName,
        }
      : database,
  ),
};

await fs.writeFile(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`Prepared celld deployment config: ${targetConfigPath}`);
console.log(`Staged celld assets: ${stagedAssetsPath}`);
console.log(
  `Enabled ${durableObjectBindings.length} Durable Object bindings; ` +
    `externalized ${sourceBindings.length - durableObjectBindings.length} compute bindings.`,
);
