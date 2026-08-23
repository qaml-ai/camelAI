#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const bucket =
  process.env.CELLD_BUCKET ??
  (dryRun ? "s3://camelai-celld-dry-run" : undefined);

if (!bucket) {
  throw new Error(
    "CELLD_BUCKET is required (for example s3://camelai-celld-state).",
  );
}

const binary = process.env.CELLD_BIN ?? "celld";
const region =
  process.env.CELLD_REGION ??
  process.env.AWS_REGION ??
  process.env.AWS_DEFAULT_REGION ??
  "us-east-1";
const configuredProject = process.env.CELLD_PROJECT ?? "build/server/wrangler.celld.json";
const preparedProject = prepareRuntimeProject(configuredProject);
const args = [
  "deploy",
  preparedProject.path,
  "--bucket",
  bucket,
  "--region",
  region,
];
if (dryRun) args.push("--dry-run");

try {
  const result = spawnSync(binary, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  preparedProject.cleanup();
}

function prepareRuntimeProject(project) {
  const sourcePath = path.resolve(repoRoot, project);
  const config = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (config.name !== "chiridion-celld-facades") {
    return { path: project, cleanup() {} };
  }

  const gatewayToken = process.env.FACADE_GATEWAY_TOKEN?.trim();
  if (!gatewayToken) {
    throw new Error(
      "FACADE_GATEWAY_TOKEN is required when deploying chiridion-celld-facades.",
    );
  }

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "camelai-celld-facades-"));
  const sourceMain = path.resolve(path.dirname(sourcePath), config.main);
  copyFileSync(sourceMain, path.join(temporaryDirectory, "index.ts"));
  config.main = "index.ts";
  config.vars = {
    ...config.vars,
    FACADE_GATEWAY_TOKEN: gatewayToken,
  };
  const runtimeConfigPath = path.join(temporaryDirectory, "wrangler.celld.json");
  writeFileSync(runtimeConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    path: runtimeConfigPath,
    cleanup() {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    },
  };
}
