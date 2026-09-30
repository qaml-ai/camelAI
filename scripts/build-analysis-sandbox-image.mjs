#!/usr/bin/env node
// Build the analysis container image (workers/main/analysis-container.Dockerfile)
// for the HOST architecture, for local runs: self-host smokes and dev. Wrangler
// builds the deployed (linux/amd64) image itself.
//
// Every stage is multi-arch except the sandbox-shim donor, which the Dockerfile
// pins to linux/amd64, so an arm64 host builds a native image. That matters for
// notebooks: under Rosetta/QEMU the Jupyter kernel binds its sockets but never
// answers the client handshake, so an emulated image fails every run_notebook.
// (The static amd64 shim runs fine under the host's emulation.)
//
// Idempotent: exits fast when the image already exists with the host's
// architecture AND was built from the current Dockerfile + analysis-sandbox-assets
// (a content hash is stamped on the image as a label, so editing an asset —
// validate-notebook, the camelai package, the execute-notebook runner —
// triggers a rebuild instead of silently running a stale image).
//
// Usage: node scripts/build-analysis-sandbox-image.mjs [--force] [--tag <image>]

import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_IMAGE = "camelai-analysis-container:latest";
const ANALYSIS_DOCKERFILE = "workers/main/analysis-container.Dockerfile";
const ANALYSIS_ASSETS_DIR = "workers/main/analysis-sandbox-assets";
const ASSETS_HASH_LABEL = "camelai.assets-hash";

const args = process.argv.slice(2);
const force = args.includes("--force");
const tagIndex = args.indexOf("--tag");
const image = tagIndex >= 0 && args[tagIndex + 1] ? args[tagIndex + 1] : DEFAULT_IMAGE;

function capture(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Content hash over the Dockerfile + every baked asset.
function analysisAssetsHash() {
  const hash = createHash("sha256");
  hash.update(readFileSync(ANALYSIS_DOCKERFILE));
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === "__pycache__") continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else {
        hash.update(entryPath);
        hash.update(readFileSync(entryPath));
      }
    }
  };
  walk(ANALYSIS_ASSETS_DIR);
  return hash.digest("hex").slice(0, 16);
}

const dockerArch = capture("docker", ["info", "--format", "{{.Architecture}}"]);
if (!dockerArch) {
  console.error("[analysis-image] docker is unavailable");
  process.exit(1);
}
const hostArch = /aarch64|arm64/.test(dockerArch) ? "arm64" : "amd64";
const assetsHash = analysisAssetsHash();
const existing = capture("docker", [
  "image",
  "inspect",
  image,
  "--format",
  `{{.Architecture}} {{index .Config.Labels "${ASSETS_HASH_LABEL}"}}`,
]);

if (!force && existing === `${hostArch} ${assetsHash}`) {
  console.log(`[analysis-image] ${image} already built for ${hostArch} (assets ${assetsHash})`);
  process.exit(0);
}

console.log(`[analysis-image] Building ${image} for ${hostArch} (assets ${assetsHash})`);
const build = spawnSync(
  "docker",
  [
    "build",
    "--platform",
    `linux/${hostArch}`,
    "--label",
    `${ASSETS_HASH_LABEL}=${assetsHash}`,
    "-t",
    image,
    "-f",
    ANALYSIS_DOCKERFILE,
    "workers/main",
  ],
  { stdio: "inherit" },
);
if (build.status !== 0) {
  console.error(`[analysis-image] docker build failed`);
  process.exit(build.status ?? 1);
}
console.log(`[analysis-image] Done`);
