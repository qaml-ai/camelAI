import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  envFile,
  pathExists,
  readSelfhostEnv,
  repoRoot,
  run as defaultRun,
  scriptEnv,
} from "./selfhost-common.mjs";
import { restoreSelfhostEnvSnapshot } from "./selfhost-secret-migrations.mjs";

/**
 * Return the install to a release snapshot (.selfhost/releases/<timestamp>,
 * written by snapshotReleaseState): its .env.selfhost and checkout, then the
 * restored checkout's own detached start and validation. The current
 * .env.selfhost is saved beside the snapshot first, and the secrets the
 * snapshot lacks are kept (restoreSelfhostEnvSnapshot). Used by --rollback and
 * by the automatic restore of an upgrade that failed before its runtime started.
 */
export async function restoreReleaseState(snapshotDir, {
  envPath = envFile,
  run = defaultRun,
  now = () => new Date(),
} = {}) {
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
  if (await pathExists(envPath)) {
    const timestamp = now().toISOString().replace(/[:.]/g, "-");
    const replacedPath = path.join(snapshotDir, `env.selfhost.replaced-${timestamp}`);
    await fs.copyFile(envPath, replacedPath);
    await fs.chmod(replacedPath, 0o600);
    console.log(`Saved the replaced .env.selfhost to ${path.relative(repoRoot, replacedPath)}.`);
  }
  const snapshotEnv = path.join(snapshotDir, metadata.environmentFile);
  const { kept } = await restoreSelfhostEnvSnapshot(snapshotEnv, envPath);
  if (kept.length > 0) {
    console.log(`Kept from the current .env.selfhost (the snapshot lacks them): ${kept.join(", ")}.`);
  }
  await run("git", ["checkout", "--detach", metadata.repositoryCommit]);
  await run("bun", ["install", "--frozen-lockfile"]);

  const restoredEnv = await readSelfhostEnv(true, envPath);
  // The restored checkout owns its Compose topology and config schema. This
  // matters when rolling back across a release that adds or removes overlays.
  await run("bun", ["run", "selfhost:configure"], {
    env: scriptEnv(restoredEnv),
  });
  // The restored release's own refresh: Compose up --detach --wait, then its
  // doctor and deep smokes (every release since selfhost-v0.1.0 has it). Not
  // its foreground start script, which attaches to the stack's logs and never
  // returns. The caller has already taken any backup it wants.
  await run(process.execPath, ["scripts/selfhost-upgrade.mjs", "--refresh", "--skip-backup"], {
    env: scriptEnv(restoredEnv),
  });
}
