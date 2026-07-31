import { Sandbox } from "@cloudflare/sandbox";

import { PROJECT_BUILD_SLEEP_AFTER } from "./container-sizing.js";
import type { Env } from "./types.js";

/**
 * Warm per-org build container for DO+R2-backed projects.
 *
 * This is intentionally separate from AnalysisSandbox: builds execute arbitrary
 * package install/build code and need npm registry egress, while analysis
 * egress is allowlisted. Callers still run only fixed platform-issued commands
 * here. Sized as standard-2 (see container-sizing.ts) — Vite/bun builds do not
 * need standard-4 memory/disk, which are billed while the container is awake.
 */
export class ProjectBuildSandbox extends Sandbox<Env> {
  sleepAfter = PROJECT_BUILD_SLEEP_AFTER;
}
