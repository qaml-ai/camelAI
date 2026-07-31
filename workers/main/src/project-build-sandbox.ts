import { Sandbox } from "@cloudflare/sandbox";

import { PROJECT_BUILD_SLEEP_AFTER } from "./container-sizing.js";
import type { Env } from "./types.js";

/**
 * Warm per-org build container for DO+R2-backed projects.
 *
 * This is intentionally separate from AnalysisSandbox: builds execute arbitrary
 * package install/build code and need npm registry egress, while analysis
 * egress is allowlisted. Callers still run only fixed platform-issued commands
 * here. Sized as standard-3 (see container-sizing.ts) — enough vCPU for
 * Vite/esbuild parallelism without standard-4's provisioned memory/disk.
 */
export class ProjectBuildSandbox extends Sandbox<Env> {
  sleepAfter = PROJECT_BUILD_SLEEP_AFTER;
}
