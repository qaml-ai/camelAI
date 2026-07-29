#!/usr/bin/env node
import path from "node:path";
import {
  readSelfhostEnv,
  repoRoot,
} from "./selfhost-common.mjs";
import {
  caddyConfigFile,
  writeCaddyConfig,
} from "./selfhost-caddy-config.mjs";
import {
  pomeriumConfigFile,
  writePomeriumConfig,
} from "./selfhost-pomerium-config.mjs";

const env = await readSelfhostEnv(true);
const pomerium = await writePomeriumConfig(env);
const caddy = await writeCaddyConfig(env);

for (const file of [pomerium, caddy]) {
  if (file) console.log(`Wrote ${path.relative(repoRoot, file)}.`);
}
if (!pomerium) {
  console.log(`Pomerium configuration is external; ${path.relative(repoRoot, pomeriumConfigFile)} was not changed.`);
}
console.log(`TLS front door: ${path.relative(repoRoot, caddyConfigFile)}.`);
