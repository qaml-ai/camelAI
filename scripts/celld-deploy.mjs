#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
const args = [
  "deploy",
  process.env.CELLD_PROJECT ?? "build/server/wrangler.celld.json",
  "--bucket",
  bucket,
  "--region",
  region,
];
if (dryRun) args.push("--dry-run");

const result = spawnSync(binary, args, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
