#!/usr/bin/env node
import path from "node:path";
import {
  ensureSelfhostAgentPackSkeleton,
  loadSelfhostAgentPack,
} from "./selfhost-agent-pack.mjs";
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
const agentSkeleton = await ensureSelfhostAgentPackSkeleton(repoRoot, env);
const agentPack = await loadSelfhostAgentPack(repoRoot, env);

for (const file of [pomerium, caddy]) {
  if (file) console.log(`Wrote ${path.relative(repoRoot, file)}.`);
}
if (!pomerium) {
  console.log(`Pomerium configuration is external; ${path.relative(repoRoot, pomeriumConfigFile)} was not changed.`);
}
console.log(`TLS front door: ${path.relative(repoRoot, caddyConfigFile)}.`);
console.log(`Agent pack: ${path.relative(repoRoot, agentSkeleton.agentDir)}`);
if (agentPack.skillNames.length > 0) {
  console.log(`  custom skills: ${agentPack.skillNames.join(", ")}`);
}
if (agentPack.promptPrepend) console.log("  prompt.prepend.md loaded");
if (agentPack.promptAppend) console.log("  prompt.append.md loaded");
