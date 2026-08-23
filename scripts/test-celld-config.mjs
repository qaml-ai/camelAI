#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, "build/server/wrangler.celld.json");
const prepareScript = path.join(repoRoot, "scripts/prepare-celld-deployment.mjs");
const deployScript = path.join(repoRoot, "scripts/celld-deploy.mjs");

execFileSync(process.execPath, [prepareScript], { cwd: repoRoot, stdio: "inherit" });

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const supportedKeys = new Set([
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "durable_objects",
  "migrations",
  "assets",
  "services",
  "triggers",
  "vars",
  "d1_databases",
]);

assert.deepEqual(
  Object.keys(config).filter((key) => !supportedKeys.has(key)),
  [],
  "generated config must contain only celld v0.3.0-supported keys",
);
assert.equal(config.name, "chiridion-celld");
assert.equal(config.vars.CF_ACCOUNT_ID, "selfhost");
assert.equal(config.vars.CF_DISPATCH_NAMESPACE, "selfhost");
assert.equal(config.vars.CELLD_RUNTIME, "1");
assert.equal(config.vars.LOCAL_APP_VANITY_DOMAIN, "localhost");
assert.equal(config.assets.directory, "celld-assets");
const facadeBindings = [
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
];
assert.deepEqual(config.services, [
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
    service: "chiridion-celld",
  },
  ...facadeBindings.map((binding) => ({
    binding,
    service: "chiridion-celld-facades",
  })),
]);
assert.deepEqual(config.d1_databases, [
  {
    binding: "APP_DB",
    database_name: "chiridion-app-celld-db",
    database_id: "chiridion-app-celld-db",
    migrations_dir: "../../migrations",
  },
]);

const bindings = config.durable_objects.bindings;
const bindingClasses = new Set(bindings.map((binding) => binding.class_name));
for (const externalClass of [
  "AnalysisSandbox",
  "ProjectBuildSandbox",
  "DbQuerySandbox",
]) {
  assert.equal(
    bindingClasses.has(externalClass),
    false,
    `${externalClass} must be provided by the external compute plane`,
  );
}
for (const requiredClass of [
  "ChatThreadDO",
  "UserDO",
  "OrgDO",
  "WorkspaceDO",
  "WorkspaceFilesystemDO",
]) {
  assert.equal(bindingClasses.has(requiredClass), true, `${requiredClass} is required`);
}

assert.equal(config.migrations.length, 1);
assert.deepEqual(
  new Set(config.migrations[0].new_sqlite_classes),
  bindingClasses,
  "fresh celld fleets should introduce exactly the bound SQLite classes",
);

const stagedAssetIgnore = path.join(
  repoRoot,
  "build/server/celld-assets/.assetsignore",
);
await assert.rejects(
  fs.access(stagedAssetIgnore),
  "celld rejects Wrangler's generated .assetsignore file",
);

const deploySource = await fs.readFile(deployScript, "utf8");
assert.match(
  deploySource,
  /FACADE_GATEWAY_TOKEN is required/,
  "facade deployment must fail closed without its gateway token",
);
assert.match(
  deploySource,
  /mode: 0o600/,
  "the runtime facade manifest containing the gateway token must be private",
);
assert.match(
  deploySource,
  /rmSync\(temporaryDirectory, \{ recursive: true, force: true \}\)/,
  "the runtime facade manifest must be removed after deployment",
);

console.log("celld deployment config checks passed.");
