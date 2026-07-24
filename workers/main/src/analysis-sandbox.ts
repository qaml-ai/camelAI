import { InvalidMountConfigError, S3FSMountError, Sandbox } from "@cloudflare/sandbox";

import { handleAuthenticatedConnectionsRpc } from "./routes/connections-rpc.js";
import type { Env } from "./types.js";

/**
 * Both of these mean "the prefix is already mounted" — the state we want — so a
 * mount attempt that hits either is a success, not a failure:
 *
 * - `S3FSMountError`: the prefix is still mounted at the kernel level from a
 *   previous container life (this DO instance was recreated, losing the SDK's
 *   in-memory mount registry, while the container kept the mount), so s3fs
 *   reports the mountpoint busy.
 * - `InvalidMountConfigError` with an "already in use" message: the SDK's own
 *   in-memory registry already holds this path, so it rejects a second mount of
 *   it (e.g. a concurrent `ensureMounted` that mounted it first). We match the
 *   message so genuine config errors — bad bucket name, a different
 *   prefix/readOnly at the same path — still surface as real failures.
 *
 * Any other error (bad binding name, missing binding, invalid path) is genuine.
 */
export function isMountAlreadyPresent(error: unknown): boolean {
  if (error instanceof S3FSMountError) return true;
  if (error instanceof InvalidMountConfigError && /already in use/i.test(String(error.message))) {
    return true;
  }
  return false;
}

/**
 * Single-flight gate: concurrent callers share one in-flight run; once it
 * succeeds the gate stays open and the work never runs again. A failed run is
 * NOT cached, so the next call retries. Pure + unit-testable.
 */
export function createSingleFlight(): (run: () => Promise<void>) => Promise<void> {
  let settled = false;
  let inFlight: Promise<void> | undefined;
  return (run) => {
    if (settled) return Promise.resolve();
    if (!inFlight) {
      inFlight = (async () => {
        await run();
        settled = true;
      })().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

/**
 * The in-container hostname for the workspace connections RPC. Container code
 * (notebooks, scripts) POSTs to `http://connections.internal/` — the same
 * `CAMELAI_CONNECTIONS_RPC_URL` protocol the project VMs used — and the request
 * never leaves Cloudflare: the sandbox egress layer intercepts the host and
 * dispatches the registered outbound handler in Worker context (the same
 * mechanism the SDK itself uses for `r2.internal` mounts).
 */
export const ANALYSIS_CONNECTIONS_HOST = "connections.internal";

/** The outbound-handler method name registered for ANALYSIS_CONNECTIONS_HOST. */
export const ANALYSIS_CONNECTIONS_HANDLER = "connectionsRpc";

/** PyPI hosts, so `uv` can install packages beyond the baked default stack. */
export const ANALYSIS_PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];

/**
 * The container's egress allowlist. The SDK's proxy applies `allowedHosts` as a
 * whitelist gate BEFORE dispatching `outboundByHost` handlers ("outboundByHost
 * only maps a handler for a hostname, it does not allow it" — containers SDK),
 * so the intercepted connections host must be listed here for its handler to be
 * reachable at all. Listing it does NOT open internet access to it: a matching
 * outbound handler is dispatched before the allowed-host pass-through. The
 * app-scoped container doesn't rely on this list at all — its egress is sealed
 * outright per run (see sealAppEgress). Everything else is blocked.
 */
export const ANALYSIS_ALLOWED_HOSTS = [...ANALYSIS_PYPI_HOSTS, ANALYSIS_CONNECTIONS_HOST];

/** Workspace/org scope attached DO-side to the connections outbound handler. */
export interface AnalysisConnectionsParams {
  orgId: string;
  workspaceId: string;
}

/**
 * Unified analysis container — the successor to (and absorption of)
 * WarehouseSandbox.
 *
 * One warm container per workspace runs everything the old per-project VM did for
 * data analysis: Jupyter notebook execution, ad-hoc shell/Python, and the heavy
 * DuckDB cross-source reduction that used to be the sealed warehouse's whole job.
 * Per-call isolation is via sessions/working dirs (see analysis-service.ts).
 *
 * NETWORK POSTURE — `enableInternet = false` with an SDK-enforced egress
 * allowlist, not a sealed box and not open internet:
 *   - `allowedHosts` = PyPI only, so `uv` can install packages beyond the baked
 *     default stack. The sandbox egress proxy enforces this; it is not deferred
 *     to host-level infra.
 *   - `connections.internal` is an intercepted host: requests to it are
 *     dispatched to the `connectionsRpc` outbound handler below, running in
 *     Worker context with the workspace/org scope that the AnalysisService
 *     attached DO-side via `setOutboundByHost` params. Container code cannot
 *     forge that scope and no token or credential ever enters the container.
 *
 * DATA IN — read-only R2 mounts, platform-mediated (egress interception → the R2
 * binding, NOT the internet), scoped to the workspace's own key prefixes:
 *   - connection exports (WAREHOUSE_EXPORT_BUCKET / `warehouse/<ws>/…`)
 *   - workspace uploads (R2_BUCKET / `<org>/<ws>/user-uploads/…`)
 * Each prefix mounts at `/<prefix>`, so an object at R2 key `<prefix>/x` is read at
 * `/<prefix>/x` — this preserves the warehouse's `'/' + r2_key` contract exactly.
 * See plans/stateless-data-analysis-architecture.md.
 */
export class AnalysisSandbox extends Sandbox<Env> {
  // Internet off; PyPI reachable via allowedHosts, connections via the
  // intercepted internal host. See the class doc for the full posture.
  enableInternet = false;
  allowedHosts = ANALYSIS_ALLOWED_HOSTS;
  // Without this, HTTPS never enters the interception chain (the SDK only
  // applies the outbound fetcher to HTTPS when interceptHttps is on), so with
  // the internet off, uv's HTTPS requests to the allowed PyPI hosts would be
  // blocked outright. The SDK signals the container via SANDBOX_INTERCEPT_HTTPS
  // so the baked container-server trusts the interception CA for spawned
  // processes. connections.internal is plain HTTP and unaffected.
  interceptHttps = true;

  // Mount paths already established in this container, and a per-path single-flight
  // gate coalescing concurrent mount attempts of the SAME path. Both are tied to
  // the container lifecycle (they reset when the DO instance is recreated), so they
  // track the actual mounts, not DO storage. Instance state on a DO — not a
  // module-level cache — so nothing leaks across containers.
  private readonly mountedPaths = new Set<string>();
  private readonly mountGates = new Map<string, (run: () => Promise<void>) => Promise<void>>();

  /**
   * Mount an R2 prefix so container code can read the staged objects. Mounts are
   * read-only by default; pass `{ readOnly: false }` for the outputs mount,
   * which is how a run hands a generated file back to the user.
   *
   * By default the mount lands at `/<prefix>` (preserving the warehouse's
   * `'/' + r2_key` contract for exports); pass `mountPath` to mount at a stable
   * alias instead (uploads mount at `/uploads`, since the org/workspace-prefixed
   * R2 key is neither shown to the agent nor derivable inside the container).
   * The `prefix` option passed to `mountBucket` keeps the proven warehouse shape
   * (leading slash).
   *
   * The mount runs at most once per mount path per container life: the
   * single-flight gate coalesces concurrent callers and caches success; repeated
   * calls on a warm container are a no-op. An already-mounted error from a
   * previous container life is treated as success (see isMountAlreadyPresent).
   */
  async ensureMounted(
    bucketBinding: string,
    prefix: string,
    mountPath?: string,
    options: { readOnly?: boolean } = {},
  ): Promise<void> {
    const resolvedMountPath = mountPath ?? `/${prefix}`;
    if (this.mountedPaths.has(resolvedMountPath)) return;
    let gate = this.mountGates.get(resolvedMountPath);
    if (!gate) {
      gate = createSingleFlight();
      this.mountGates.set(resolvedMountPath, gate);
    }
    const readOnly = options.readOnly ?? true;
    await gate(async () => {
      try {
        await this.mountBucket(bucketBinding, resolvedMountPath, {
          prefix: `/${prefix}`,
          readOnly,
          // Shrink the s3fs stat cache (default 60s + negative caching) so a
          // just-staged export/upload isn't read through a stale/partial view —
          // which otherwise surfaces as a read failure. The stage → read gap
          // exceeds 1s, so this adds no real overhead. Matches WarehouseSandbox.
          s3fsOptions: ["stat_cache_expire=1"],
        });
      } catch (error) {
        if (!isMountAlreadyPresent(error)) throw error;
      }
      this.mountedPaths.add(resolvedMountPath);
    });
  }

  /**
   * Register the connections RPC interception for this container, scoping it to
   * the given workspace/org. Called by AnalysisService before each run — the
   * params live DO-side, so container code cannot change whose connections it
   * queries. Cheap on a warm container (a registry write, no error on repeat).
   */
  async ensureConnectionsRpc(params: AnalysisConnectionsParams): Promise<void> {
    await this.setOutboundByHost(ANALYSIS_CONNECTIONS_HOST, ANALYSIS_CONNECTIONS_HANDLER, params);
  }

  /**
   * Seal this container's egress entirely (block-all allowlist override). Used
   * for the app-scoped container: deployed-app code has no PyPI use case (no
   * uv, no installs) and no connections interception, so the class-level
   * allowlist would only be an exfiltration channel for the mounted export
   * data — the pre-merge WarehouseSandbox posture, restored. The override is
   * in-memory DO state, so AnalysisService applies it before every app run.
   */
  async sealAppEgress(): Promise<void> {
    // [] is a non-nullish override that matches no host — the SDK's proxy then
    // rejects every origin before any pass-through or handler dispatch.
    await this.setAllowedHosts([]);
  }
}

/**
 * Worker-side handler for `http://connections.internal/` requests from inside an
 * analysis container. Runs in the ContainerProxy WorkerEntrypoint context with
 * the full worker env; identity comes exclusively from `ctx.params` (attached by
 * `ensureConnectionsRpc` DO-side), never from anything in the request.
 *
 * Registered at module load via the Container static registry — both the DO
 * context and the ContainerProxy context import this module through the worker
 * entrypoint, so the registry is populated in each isolate.
 */
async function connectionsRpcOutboundHandler(
  req: Request,
  env: Env,
  ctx: { containerId: string; className: string; params?: unknown },
): Promise<Response> {
  const params = (ctx.params ?? {}) as Partial<AnalysisConnectionsParams>;
  if (!params.orgId || !params.workspaceId) {
    // No DO-attached scope means the interception was registered incorrectly —
    // fail closed rather than guessing a tenant.
    return new Response(
      JSON.stringify({ ok: false, error: { message: "connections scope not configured for this container" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  return handleAuthenticatedConnectionsRpc(req, env, {
    orgId: params.orgId,
    workspaceId: params.workspaceId,
  });
}

// Static registration keyed by class name ("AnalysisSandbox"); ContainerProxy
// resolves the handler from this registry when dispatching intercepted egress.
//
// COEXISTENCE WITH R2 MOUNTS: the sandbox SDK's mountBucket path also assigns
// `this.constructor.outboundHandlers = { r2EgressMount: ... }` on this class.
// That is safe because @cloudflare/containers' static setter MERGES into the
// registry (`{ ...existing, ...handlers }`) — it does not replace it — so
// connectionsRpc survives mount registration (and vice versa, since this module
// -scope assignment runs at isolate startup, before any mount). A regression
// test pins the merge semantics so an SDK change to replace-semantics fails
// loudly (analysis-service.test.ts).
AnalysisSandbox.outboundHandlers = {
  [ANALYSIS_CONNECTIONS_HANDLER]: connectionsRpcOutboundHandler as never,
};
