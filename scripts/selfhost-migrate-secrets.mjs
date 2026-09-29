#!/usr/bin/env node
import path from "node:path";
import { envFile, readSelfhostEnv, repoRoot } from "./selfhost-common.mjs";
import { ensureSelfhostSecrets } from "./selfhost-secret-migrations.mjs";

await readSelfhostEnv(true);
const { created } = await ensureSelfhostSecrets(envFile);
console.log(
  created.length > 0
    ? `Added ${created.join(", ")} to ${path.relative(repoRoot, envFile)}.`
    : `Self-host secrets are current in ${path.relative(repoRoot, envFile)}.`,
);
