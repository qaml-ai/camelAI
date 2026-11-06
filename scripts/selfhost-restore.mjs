#!/usr/bin/env node
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  readSelfhostEnv,
  run,
  scriptEnv,
  restorableVolumeNames,
  volumeName,
} from "./selfhost-common.mjs";

const backupDir = path.resolve(process.cwd(), process.argv[2] || "");
if (!process.argv[2] || !existsSync(backupDir)) {
  console.error("Usage: bun run selfhost:restore -- <backup-dir>");
  process.exit(1);
}

const env = await readSelfhostEnv(true);
const manifestPath = path.join(backupDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Missing backup manifest: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const selectedVolumeNames = Array.isArray(manifest.volumes)
  ? manifest.volumes.map((entry) => entry?.name)
  : [];
if (
  selectedVolumeNames.length === 0 ||
  new Set(selectedVolumeNames).size !== selectedVolumeNames.length ||
  selectedVolumeNames.some(
    (name) => typeof name !== "string" || !restorableVolumeNames.has(name),
  )
) {
  console.error(`Invalid volume list in backup manifest: ${manifestPath}`);
  process.exit(1);
}
for (const name of selectedVolumeNames) {
  const archive = path.join(backupDir, `${name}.tgz`);
  if (!existsSync(archive)) {
    console.error(`Missing declared backup archive: ${archive}`);
    process.exit(1);
  }
}
for (const name of selectedVolumeNames) {
  await restoreVolume(volumeName(name, env), `${name}.tgz`);
}

console.log(`Restored self-host backup created at ${manifest.createdAt || "unknown time"}.`);

async function restoreVolume(dockerVolume, archiveName) {
  await run("docker", ["volume", "create", dockerVolume], { env: scriptEnv(env) });
  await run("docker", [
    "run",
    "--rm",
    "-v",
    `${dockerVolume}:/data`,
    "-v",
    `${backupDir}:/backup:ro`,
    "alpine:3.20",
    "sh",
    "-lc",
    `rm -rf /data/* /data/.[!.]* /data/..?* 2>/dev/null || true; tar -xzf /backup/${archiveName} -C /data`,
  ], { env: scriptEnv(env) });
}
