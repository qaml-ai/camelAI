#!/usr/bin/env node
import {
  ensureSelfhostAgentPackSkeleton,
} from "./selfhost-agent-pack.mjs";
import {
  composeArgs,
  envFile,
  loadCaddyConfig,
  readSelfhostEnv,
  repoRoot,
  run,
  scriptEnv,
} from "./selfhost-common.mjs";
import { writeCaddyConfig } from "./selfhost-caddy-config.mjs";
import { writePomeriumConfig } from "./selfhost-pomerium-config.mjs";
import { ensureSelfhostSecrets } from "./selfhost-secret-migrations.mjs";

await readSelfhostEnv(true);
await ensureSelfhostSecrets(envFile);
const env = await readSelfhostEnv(true);
await writePomeriumConfig(env);
await writeCaddyConfig(env);
await ensureSelfhostAgentPackSkeleton(repoRoot, env);
const sourceMode =
  (env.SELFHOST_DEPLOYMENT_MODE || process.env.SELFHOST_DEPLOYMENT_MODE) ===
  "source";

// The generated Caddyfile is bind-mounted, so Compose cannot detect that it
// changed. Start Caddy if needed and explicitly reload it before attaching to
// the full stack; otherwise an existing container can keep the previous auth
// upstream indefinitely.
await loadCaddyConfig(env, { build: sourceMode });

await run("docker", composeArgs(env, [
  "up",
  ...(sourceMode ? ["--build"] : []),
]), {
  env: scriptEnv(env),
});
