/**
 * Cloudflare container right-sizing.
 *
 * Memory and disk are billed on *provisioned* resources for every second a
 * container is awake; CPU is active-usage only. Prefer the smallest instance
 * type that fits the workload, and sleep bursty sandboxes quickly.
 *
 * Instance types (Cloudflare predefined):
 *   lite        1/16 vCPU · 256 MiB · 2 GB
 *   basic       1/4  vCPU · 1 GiB   · 4 GB
 *   standard-1  1/2  vCPU · 4 GiB   · 8 GB
 *   standard-2  1    vCPU · 6 GiB   · 12 GB
 *   standard-3  2    vCPU · 8 GiB   · 16 GB
 *   standard-4  4    vCPU · 12 GiB  · 20 GB
 *
 * Keep wrangler `instance_type` values in sync with these constants
 * (tests/container-sizing.test.ts).
 */

/**
 * Per-org `bun install && bun run build` with a prewarmed bun cache.
 * standard-3 (2 vCPU) keeps Vite/esbuild parallelism without standard-4 memory.
 */
export const PROJECT_BUILD_INSTANCE_TYPE = "standard-3";

/**
 * Notebooks + DuckDB over mounted Parquet. Needs headroom above a Vite build,
 * but not the absolute max (standard-4) — most analysis fits in 8 GiB.
 */
export const ANALYSIS_INSTANCE_TYPE = "standard-3";

/** Trusted node SQL/export runner; no user code, bounded result buffers. */
export const DB_QUERY_INSTANCE_TYPE = "standard-1";

/** Builds finish in seconds; no reason to bill 10m of idle memory/disk. */
export const PROJECT_BUILD_SLEEP_AFTER = "2m";

/**
 * How long a FINISHED build keeps the container warm for the session that made
 * it.
 *
 * The 2m idle window is right for a workspace that built once and left, but it
 * reaped the container mid-session between two deploys, and the next deploy then
 * paid a 30-120s cold boot (see project-build-readiness.ts). The touch happens
 * when a build completes, so the window is a post-build tail; each new build
 * extends it, and once it lapses the normal 2m sleep applies again.
 *
 * Sized against the observed mid-session gap that caused the incident (~6 min
 * between two deploys), not against a workday: the container is a standard-3
 * billing provisioned memory/disk for every awake second, and each warm
 * instance also holds one of the `max_instances` slots in wrangler.prod.jsonc.
 * Raising this multiplies concurrent live instances — check
 * `build_sandbox_stop_deferred` telemetry against that cap first.
 */
export const PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS = 10 * 60_000;

/** Upper bound on a requested warm window, so a bad caller can't pin a container. */
export const PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS = 30 * 60_000;

/** Interactive notebooks; shorter than the SDK 10m default, still warm enough. */
export const ANALYSIS_SLEEP_AFTER = "5m";

/** Single-shot queries/exports; sleep promptly when the workspace goes quiet. */
export const DB_QUERY_SLEEP_AFTER = "2m";
