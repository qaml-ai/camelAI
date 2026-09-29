#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  capture,
  composeArgs,
  optionalVolumeNames,
  readSelfhostEnv,
  repoRoot,
  run,
  scriptEnv,
  volumeName,
  volumeNamesForEnv,
} from "./selfhost-common.mjs";

const env = await readSelfhostEnv(true);
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.resolve(repoRoot, process.argv[2] || `.selfhost/backups/${timestamp}`);
const selectedVolumeNames = [];
for (const name of volumeNamesForEnv(env)) {
  if (optionalVolumeNames.has(name) && !(await volumeExists(volumeName(name, env)))) {
    console.log(`[selfhost:backup] ${volumeName(name, env)} does not exist yet; skipped.`);
    continue;
  }
  selectedVolumeNames.push(name);
}

await fs.mkdir(backupDir, { recursive: true });

const ps = await capture("docker", composeArgs(env, ["ps", "--format", "json"]), {
  env: scriptEnv(env),
});
if (ps.code === 0 && ps.stdout.trim()) {
  console.warn("[selfhost:backup] If the stack is running, this is a live backup. Stop the stack for the most consistent snapshot.");
}

for (const name of selectedVolumeNames) {
  const dockerVolume = volumeName(name, env);
  await backupVolume(dockerVolume, `${name}.tgz`);
}

await fs.writeFile(
  path.join(backupDir, "manifest.json"),
  JSON.stringify({
    createdAt: new Date().toISOString(),
    composeProject: env.COMPOSE_PROJECT_NAME,
    volumes: selectedVolumeNames.map((name) => ({
      name,
      dockerVolume: volumeName(name, env),
      archive: `${name}.tgz`,
    })),
    notes: [
      ".env.selfhost is not included because it contains secrets.",
      "Restore with: bun run selfhost:restore -- <backup-dir>",
    ],
  }, null, 2),
);

console.log(`Self-host backup written to ${backupDir}`);

async function volumeExists(dockerVolume) {
  const inspect = await capture("docker", ["volume", "inspect", dockerVolume], {
    env: scriptEnv(env),
  });
  return inspect.code === 0;
}

async function backupVolume(dockerVolume, archiveName) {
  const inspect = await capture("docker", ["volume", "inspect", dockerVolume], {
    env: scriptEnv(env),
  });
  if (inspect.code !== 0) {
    throw new Error(
      `[selfhost:backup] Required volume ${dockerVolume} does not exist. No successful backup manifest was written.`,
    );
  }

  await run("docker", [
    "run",
    "--rm",
    "-v",
    `${dockerVolume}:/data:ro`,
    "-v",
    `${backupDir}:/backup`,
    "alpine:3.20",
    "tar",
    "-czf",
    `/backup/${archiveName}`,
    "-C",
    "/data",
    ".",
  ], { env: scriptEnv(env) });
}
