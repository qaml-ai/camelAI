#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  capture,
  composeArgs,
  envFile,
  readSelfhostEnv,
  repoRoot,
  run,
  scriptEnv,
  writeEnvValue,
} from "./selfhost-common.mjs";
import { writeCaddyConfig } from "./selfhost-caddy-config.mjs";
import { writePomeriumConfig } from "./selfhost-pomerium-config.mjs";

const IMAGE_ENV_BY_MANIFEST_KEY = {
  app: "SELFHOST_APP_IMAGE",
  "local-artifacts": "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
  "project-build": "SELFHOST_PROJECT_BUILD_IMAGE",
  analysis: "SELFHOST_ANALYSIS_IMAGE",
  "db-query": "SELFHOST_DB_QUERY_IMAGE",
  "container-egress": "SELFHOST_CONTAINER_EGRESS_IMAGE",
  caddy: "SELFHOST_CADDY_IMAGE",
  pomerium: "SELFHOST_POMERIUM_IMAGE",
};

const args = parseArgs(process.argv.slice(2));
const skipBackup = args.flags.has("skip-backup");
const releaseRef = args.values.get("release");
const manifestArg = args.values.get("manifest");
const rollbackArg = args.values.get("rollback");
const resumeUpgradeArg = args.values.get("resume-upgrade");

if (args.unknown.length > 0) {
  usage(`Unknown argument${args.unknown.length === 1 ? "" : "s"}: ${args.unknown.join(", ")}`);
}
if (
  resumeUpgradeArg &&
  (releaseRef || manifestArg || rollbackArg || skipBackup)
) {
  usage("--resume-upgrade is internal and cannot be combined with other arguments");
}
if (rollbackArg && (releaseRef || manifestArg)) {
  usage("--rollback cannot be combined with --release or --manifest");
}
if (Boolean(releaseRef) !== Boolean(manifestArg)) {
  usage("--release and --manifest must be provided together");
}

if (resumeUpgradeArg) {
  await resumeReleaseUpgrade(path.resolve(repoRoot, resumeUpgradeArg));
} else if (rollbackArg) {
  await rollbackRelease(path.resolve(repoRoot, rollbackArg), { skipBackup });
} else if (releaseRef && manifestArg) {
  await upgradeRelease({
    releaseRef,
    manifestPath: path.resolve(repoRoot, manifestArg),
    skipBackup,
  });
} else {
  await refreshCurrentRelease({ skipBackup });
}

async function refreshCurrentRelease({ skipBackup: shouldSkipBackup }) {
  const env = await readSelfhostEnv(true);
  if (!shouldSkipBackup) await backup(env);
  await applyCurrentConfig(env);
  console.log(
    "Self-host refresh completed with the current checkout and configured image references.",
  );
}

async function upgradeRelease({ releaseRef: targetRef, manifestPath, skipBackup: shouldSkipBackup }) {
  await assertCleanCheckout();
  const currentEnv = await readSelfhostEnv(true);
  const expectedRevision = await readManifestRevision(manifestPath);
  const snapshotDir = await snapshotReleaseState();
  const handoffPath = await writeUpgradeHandoff(snapshotDir, {
    targetRef,
    manifestPath,
  });

  if (!shouldSkipBackup) await backup(currentEnv);

  let checkoutChanged = false;
  try {
    await run("git", ["fetch", "--force", "--tags", "origin"]);
    const targetCommit = await gitOutput([
      "rev-parse",
      `${targetRef}^{commit}`,
    ]);
    if (targetCommit.toLowerCase() !== expectedRevision.toLowerCase()) {
      throw new Error(
        `Release manifest revision ${expectedRevision} does not match ${targetRef} (${targetCommit})`,
      );
    }
    checkoutChanged = true;
    await run("git", ["checkout", "--detach", targetCommit]);
  } catch (error) {
    if (checkoutChanged) {
      console.error(`Upgrade failed: ${errorMessage(error)}`);
      console.error("Restoring the previous checkout and image configuration.");
      try {
        await restoreReleaseState(snapshotDir);
      } catch (rollbackError) {
        throw new Error(
          `Upgrade failed (${errorMessage(error)}) and automatic runtime rollback also failed (${errorMessage(
            rollbackError,
          )}). Restore ${path.relative(repoRoot, snapshotDir)} manually and use the pre-upgrade volume backup.`,
        );
      }
    }
    throw error;
  }

  // The current Node process still has the old checkout's module loaded.
  // Re-exec the target release so its manifest schema, dependency mapping,
  // migration boundary, and validation logic own the apply phase.
  await run(process.execPath, [
    "scripts/selfhost-upgrade.mjs",
    "--resume-upgrade",
    handoffPath,
  ]);
}

async function resumeReleaseUpgrade(handoffPath) {
  const { targetRef, manifestPath, snapshotDir } =
    await readUpgradeHandoff(handoffPath);
  let runtimeMayHaveMigrated = false;
  try {
    const manifest = await readReleaseManifest(manifestPath);
    const checkedOutCommit = await gitOutput(["rev-parse", "HEAD"]);
    if (checkedOutCommit.toLowerCase() !== manifest.revision.toLowerCase()) {
      throw new Error(
        `Release manifest revision ${manifest.revision} does not match ${targetRef} (${checkedOutCommit})`,
      );
    }

    await run("bun", ["install", "--frozen-lockfile"]);
    await updateReleaseEnvironment(manifest);
    const releaseEnv = await readSelfhostEnv(true);
    await applyCurrentConfig(releaseEnv, {
      onRuntimeStart() {
        runtimeMayHaveMigrated = true;
      },
    });

    console.log(`Self-host upgrade to ${targetRef} completed.`);
    console.log(`Previous runtime configuration: ${path.relative(repoRoot, snapshotDir)}`);
    console.log(
      `Rollback command: bun run selfhost:upgrade -- --rollback ${path.relative(repoRoot, snapshotDir)}`,
    );
  } catch (error) {
    if (!runtimeMayHaveMigrated) {
      console.error(`Upgrade failed: ${errorMessage(error)}`);
      console.error("Restoring the previous checkout and image configuration.");
      try {
        await restoreReleaseState(snapshotDir);
      } catch (rollbackError) {
        throw new Error(
          `Upgrade failed (${errorMessage(error)}) and automatic runtime rollback also failed (${errorMessage(
            rollbackError,
          )}). Restore ${path.relative(repoRoot, snapshotDir)} manually and use the pre-upgrade volume backup.`,
        );
      }
    } else {
      console.error(`Upgrade failed after the new runtime started: ${errorMessage(error)}`);
      console.error(
        "Automatic code rollback is disabled because D1 migrations may already have run. " +
          `The new checkout and image configuration were left in place. Restore the pre-upgrade volume backup before using bun run selfhost:upgrade -- --rollback ${path.relative(repoRoot, snapshotDir)}.`,
      );
    }
    throw error;
  }
}

async function rollbackRelease(snapshotDir, { skipBackup: shouldSkipBackup }) {
  await assertCleanCheckout();
  const currentEnv = await readSelfhostEnv(true);
  if (!shouldSkipBackup) await backup(currentEnv);
  console.warn(
    "Runtime rollback does not reverse D1 migrations. Restore the matching pre-upgrade volume backup when a schema rollback is required.",
  );
  await restoreReleaseState(snapshotDir);
  console.log(`Self-host runtime configuration restored from ${path.relative(repoRoot, snapshotDir)}.`);
}

async function applyCurrentConfig(env, { onRuntimeStart } = {}) {
  const sourceMode =
    (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
    "source";
  const effectiveEnv = scriptEnv(env);
  await writePomeriumConfig(env);
  await writeCaddyConfig(env);

  await run(
    "docker",
    composeArgs(env, [
      "pull",
      ...(sourceMode ? ["--ignore-pull-failures"] : []),
    ]),
    { env: effectiveEnv },
  );
  if (sourceMode) {
    await run("docker", composeArgs(env, ["build"]), { env: effectiveEnv });
  }
  onRuntimeStart?.();
  await run(
    "docker",
    composeArgs(env, [
      "up",
      "-d",
      "--remove-orphans",
      "--wait",
      "--wait-timeout",
      "900",
    ]),
    { env: effectiveEnv },
  );
  await run(process.execPath, ["scripts/selfhost-doctor.mjs"], {
    env: effectiveEnv,
  });
  await runDeepSmokes(effectiveEnv);
}

async function snapshotReleaseState() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = path.join(repoRoot, ".selfhost", "releases", timestamp);
  await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  await fs.copyFile(envFile, path.join(snapshotDir, "env.selfhost"));
  await fs.chmod(path.join(snapshotDir, "env.selfhost"), 0o600);
  await fs.writeFile(
    path.join(snapshotDir, "runtime.json"),
    `${JSON.stringify(
      {
        schema: 1,
        createdAt: new Date().toISOString(),
        repositoryCommit: await gitOutput(["rev-parse", "HEAD"]),
        environmentFile: "env.selfhost",
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return snapshotDir;
}

async function writeUpgradeHandoff(snapshotDir, { targetRef, manifestPath }) {
  const copiedManifest = path.join(snapshotDir, "target-manifest.json");
  await fs.copyFile(manifestPath, copiedManifest);
  await fs.chmod(copiedManifest, 0o600);
  const handoffPath = path.join(snapshotDir, "upgrade-handoff.json");
  await fs.writeFile(
    handoffPath,
    `${JSON.stringify(
      {
        schema: 1,
        targetRef,
        manifestFile: path.basename(copiedManifest),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return handoffPath;
}

async function readUpgradeHandoff(handoffPath) {
  const metadata = JSON.parse(await fs.readFile(handoffPath, "utf8"));
  if (
    metadata.schema !== 1 ||
    typeof metadata.targetRef !== "string" ||
    !metadata.targetRef.trim() ||
    metadata.manifestFile !== "target-manifest.json"
  ) {
    throw new Error(`Invalid upgrade handoff metadata: ${handoffPath}`);
  }
  const snapshotDir = path.dirname(handoffPath);
  return {
    targetRef: metadata.targetRef,
    manifestPath: path.join(snapshotDir, metadata.manifestFile),
    snapshotDir,
  };
}

async function restoreReleaseState(snapshotDir) {
  const metadataPath = path.join(snapshotDir, "runtime.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  if (
    metadata.schema !== 1 ||
    typeof metadata.repositoryCommit !== "string" ||
    !/^[0-9a-f]{40}$/i.test(metadata.repositoryCommit) ||
    metadata.environmentFile !== "env.selfhost"
  ) {
    throw new Error(`Invalid release snapshot metadata: ${metadataPath}`);
  }
  const snapshotEnv = path.join(snapshotDir, metadata.environmentFile);
  await fs.copyFile(snapshotEnv, envFile);
  await fs.chmod(envFile, 0o600);
  await run("git", ["checkout", "--detach", metadata.repositoryCommit]);
  await run("bun", ["install", "--frozen-lockfile"]);

  const restoredEnv = await readSelfhostEnv(true);
  // The restored checkout owns its Compose topology and config schema. This
  // matters when rolling back across a release that adds or removes overlays.
  await run("bun", ["run", "selfhost:configure"], {
    env: scriptEnv(restoredEnv),
  });
  await run("bun", ["run", "selfhost:up"], {
    env: scriptEnv(restoredEnv),
  });
  await run(process.execPath, ["scripts/selfhost-doctor.mjs"], {
    env: scriptEnv(restoredEnv),
  });
  await runDeepSmokes(scriptEnv(restoredEnv));
}

async function runDeepSmokes(env) {
  for (const runtime of ["project", "analysis", "db-query"]) {
    await run(
      "bun",
      ["run", `selfhost:container:smoke:${runtime}`],
      { env },
    );
  }
}

async function updateReleaseEnvironment(manifest) {
  const updates = { SELFHOST_DEPLOYMENT_MODE: "release" };
  for (const [manifestKey, envKey] of Object.entries(
    IMAGE_ENV_BY_MANIFEST_KEY,
  )) {
    updates[envKey] = manifest.images[manifestKey];
  }

  let text = await fs.readFile(envFile, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${writeEnvValue(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text)
      ? text.replace(pattern, line)
      : `${text.trimEnd()}\n${line}\n`;
  }
  await fs.writeFile(envFile, text, { mode: 0o600 });
}

async function readReleaseManifest(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    manifest.schema !== 1 ||
    typeof manifest.revision !== "string" ||
    !/^[0-9a-f]{40}$/i.test(manifest.revision) ||
    !manifest.images ||
    typeof manifest.images !== "object"
  ) {
    throw new Error(`Invalid self-host release manifest: ${manifestPath}`);
  }
  for (const key of Object.keys(IMAGE_ENV_BY_MANIFEST_KEY)) {
    const image = manifest.images[key];
    if (
      typeof image !== "string" ||
      !/@sha256:[0-9a-f]{64}$/i.test(image)
    ) {
      throw new Error(
        `Release manifest image ${key} must be pinned by sha256 digest`,
      );
    }
  }
  return manifest;
}

async function readManifestRevision(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    typeof manifest.revision !== "string" ||
    !/^[0-9a-f]{40}$/i.test(manifest.revision)
  ) {
    throw new Error(`Invalid self-host release manifest: ${manifestPath}`);
  }
  return manifest.revision;
}

async function backup(env) {
  await run(process.execPath, ["scripts/selfhost-backup.mjs"], {
    env: scriptEnv(env),
  });
}

async function assertCleanCheckout() {
  const status = await gitOutput(["status", "--porcelain", "--untracked-files=no"]);
  if (status) {
    throw new Error(
      "Release upgrade/rollback requires a clean tracked worktree. Commit or stash local changes first.",
    );
  }
}

async function gitOutput(args) {
  const result = await capture("git", args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  const unknown = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-backup") {
      flags.add("skip-backup");
      continue;
    }
    const inline = /^--(release|manifest|rollback|resume-upgrade)=(.+)$/.exec(arg);
    if (inline) {
      values.set(inline[1], inline[2]);
      continue;
    }
    const named = /^--(release|manifest|rollback|resume-upgrade)$/.exec(arg);
    if (named && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values.set(named[1], argv[index + 1]);
      index += 1;
      continue;
    }
    unknown.push(arg);
  }
  return { flags, values, unknown };
}

function usage(message) {
  console.error(message);
  console.error(
    "Usage:\n" +
      "  bun run selfhost:upgrade\n" +
      "  bun run selfhost:upgrade -- --release <git-ref> --manifest <selfhost-release.json>\n" +
      "  bun run selfhost:upgrade -- --rollback <snapshot-directory>",
  );
  process.exit(2);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
