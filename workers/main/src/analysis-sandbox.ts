import {
  InvalidMountConfigError,
  S3FSMountError,
  Sandbox,
  type ExecOptions,
  type ExecResult,
  type MountBucketOptions,
} from "@cloudflare/sandbox";

import { isSelfhostRuntime, type SelfhostRuntimeEnv } from "../../../src/lib/selfhost-runtime.js";
import { ANALYSIS_SLEEP_AFTER } from "./container-sizing.js";
import { handleAuthenticatedConnectionsRpc } from "./routes/connections-rpc.js";
import {
  createSandboxZombieHealState,
  createZombieHealTarget,
  healZombieSandboxContainer,
  SandboxSessionDeathTracker,
  SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD,
  withZombieSelfHeal,
  type SandboxZombieRestartOutcome,
  type SandboxZombieRestartRequest,
  type ZombieHealableSandbox,
} from "./sandbox-zombie-recovery.js";
import type { Env } from "./types.js";

/**
 * Both of these mean "the prefix is already mounted" — recoverable presence, not
 * a hard failure — so callers can unmount+remount (see `mountOrRecover`):
 *
 * - `S3FSMountError` whose message looks like a busy/nonempty mountpoint: the
 *   prefix is still mounted at the kernel level from a previous container life
 *   (this DO instance was recreated, losing the SDK's in-memory mount registry,
 *   while the container kept the mount). We match the message so genuine s3fs
 *   failures (auth, network, missing bucket) still surface.
 * - `InvalidMountConfigError` with an "already in use" message: the SDK's own
 *   in-memory registry already holds this path, so it rejects a second mount of
 *   it (e.g. a concurrent `ensureMounted` that mounted it first). We match the
 *   message so genuine config errors — bad bucket name, a different
 *   prefix/readOnly at the same path — still surface as real failures.
 *
 * Any other error (bad binding name, missing binding, invalid path) is genuine.
 */
export function isMountAlreadyPresent(error: unknown): boolean {
  if (
    error instanceof S3FSMountError &&
    /not empty|MOUNTPOINT|busy|already mounted/i.test(String(error.message ?? error))
  ) {
    return true;
  }
  if (error instanceof InvalidMountConfigError && /already in use/i.test(String(error.message))) {
    return true;
  }
  return false;
}

/** R2-binding options before choosing Cloudflare s3fs or self-host local sync. */
export type R2BindingMountOptions = {
  prefix: string;
  readOnly?: boolean;
  s3fsOptions?: string[];
};

/**
 * Cloudflare Containers can mount R2 through credential-less s3fs. Local
 * workerd containers do not receive /dev/fuse and should use the Sandbox SDK's
 * local R2 synchronization mode instead. That mode uses the R2 binding plus
 * container file/watch APIs, so self-host never needs SYS_ADMIN or an
 * unconfined AppArmor profile.
 */
export function sandboxR2MountOptions(
  env: SelfhostRuntimeEnv,
  options: R2BindingMountOptions,
): MountBucketOptions {
  if (isSelfhostRuntime(env)) {
    return {
      localBucket: true,
      prefix: options.prefix,
      readOnly: options.readOnly,
    };
  }
  return options;
}

/** Writable local-sync watches are restricted by the sandbox server to /workspace. */
export function sandboxR2MountPath(
  requestedMountPath: string,
  options: MountBucketOptions,
): string {
  if (
    "localBucket" in options &&
    options.localBucket &&
    options.readOnly === false &&
    requestedMountPath !== "/workspace" &&
    !requestedMountPath.startsWith("/workspace/")
  ) {
    return `/workspace/.camelai-mounts${requestedMountPath}`;
  }
  return requestedMountPath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function ensureLocalMountAlias(
  target: Pick<MountRecoverTarget, "exec">,
  requestedMountPath: string,
  actualMountPath: string,
): Promise<void> {
  if (requestedMountPath === actualMountPath) return;
  const parent = requestedMountPath.slice(0, requestedMountPath.lastIndexOf("/")) || "/";
  const result = await target.exec(
    `mkdir -p ${shellQuote(parent)} && rm -rf ${shellQuote(requestedMountPath)} && ` +
      `ln -s ${shellQuote(actualMountPath)} ${shellQuote(requestedMountPath)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to expose local R2 mount at ${requestedMountPath}: ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Minimal surface `mountOrRecover` needs from a Sandbox. Kept narrow so the
 * recovery path is unit-testable without spinning a container.
 */
export interface MountRecoverTarget {
  mountBucket(bucket: string, mountPath: string, options: MountBucketOptions): Promise<void>;
  unmountBucket(mountPath: string): Promise<void>;
  exec(
    command: string,
    options?: { timeout?: number },
  ): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
}

interface WritableLocalMountTarget {
  writeFile(path: string, content: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
}

interface LocalMountBucket {
  head(key: string): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
}

const LOCAL_MOUNT_READY_DELAYS_MS = [50, 100, 200, 400, 800, 1_200] as const;

/**
 * `localBucket` starts its writable container watcher asynchronously after the
 * initial R2 -> container sync. Prove that watcher is accepting events before
 * returning a writable mount, otherwise the first generated output/export can
 * be written during the startup gap and never reach R2.
 */
export async function waitForWritableLocalMount(
  target: WritableLocalMountTarget,
  bucket: LocalMountBucket,
  mountPath: string,
  prefix: string,
  delaysMs: readonly number[] = LOCAL_MOUNT_READY_DELAYS_MS,
): Promise<void> {
  const sentinelName = `.camelai-mount-ready-${crypto.randomUUID()}`;
  const sentinelPath = `${mountPath.replace(/\/$/, "")}/${sentinelName}`;
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const sentinelKey = normalizedPrefix ? `${normalizedPrefix}/${sentinelName}` : sentinelName;

  try {
    for (let attempt = 0; ; attempt += 1) {
      // Rewriting creates a fresh modify event if the initial create happened
      // just before the SDK's inotify stream became ready.
      await target.writeFile(sentinelPath, `ready-${attempt}`);
      if (await bucket.head(sentinelKey)) return;
      const delayMs = delaysMs[attempt];
      if (delayMs == null) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(
      `Writable local R2 synchronization did not start for ${mountPath}; ` +
      "sandbox output would not persist",
    );
  } finally {
    await target.deleteFile(sentinelPath).catch(() => undefined);
    await bucket.delete(sentinelKey).catch(() => undefined);
  }
}

/**
 * Mount an R2 prefix, recovering from the warm-container remount hazard:
 *
 * When a Sandbox DO is recreated, the SDK loses its in-memory mount registry
 * and `r2.internal` interception, but the container can keep the old FUSE
 * mounts. A naive remount then fails with "MOUNTPOINT … is not empty". The SDK
 * cleans up the failed attempt by calling `configureR2EgressOutbound` with the
 * *remaining* (often empty) bucket set — which **removes** `r2.internal` —
 * while the zombie FUSE mounts stay. Every subsequent read returns Errno 5.
 *
 * Swallowing that error (the old behaviour) left the workspace permanently
 * wedged until the container was destroyed. Instead: unmount, remount (so
 * egress is re-registered), and if the mount still only "looks" present, probe
 * a directory listing and fail loudly when I/O is dead.
 */
export async function mountOrRecover(
  target: MountRecoverTarget,
  bucket: string,
  mountPath: string,
  options: MountBucketOptions,
): Promise<void> {
  try {
    await target.mountBucket(bucket, mountPath, options);
    return;
  } catch (error) {
    if (!isMountAlreadyPresent(error)) throw error;
  }

  try {
    await target.unmountBucket(mountPath);
  } catch (error) {
    console.warn(`[sandbox] unmount ${mountPath} before remount failed`, error);
  }

  try {
    await target.mountBucket(bucket, mountPath, options);
    return;
  } catch (error) {
    if (!isMountAlreadyPresent(error)) throw error;
  }

  if (!(await mountAllowsList(target, mountPath))) {
    throw new Error(
      `R2 mount at ${mountPath} appears present but is not readable (I/O error). ` +
        `Recreate the analysis sandbox container to recover.`,
    );
  }
}

/** True when `ls` against the mount path succeeds without an I/O error. */
export async function mountAllowsList(
  target: Pick<MountRecoverTarget, "exec">,
  mountPath: string,
): Promise<boolean> {
  // Mount paths are platform-controlled (`/uploads`, `/outputs`, `/warehouse/<uuid>`).
  if (!/^\/[A-Za-z0-9._/-]+$/.test(mountPath) || mountPath.includes("..")) return false;
  try {
    const result = await target.exec(`ls -ld -- ${mountPath}`, { timeout: 15_000 });
    if ((result.exitCode ?? 1) !== 0) return false;
    const combined = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/Input\/output error|Errno 5/i.test(combined)) return false;
    return true;
  } catch {
    return false;
  }
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
  // Memory/disk bill while awake; 5m is enough for interactive notebooks
  // without the SDK's 10m default idle burn (see container-sizing.ts).
  sleepAfter = ANALYSIS_SLEEP_AFTER;

  // Mount paths already established in this container, and a per-path single-flight
  // gate coalescing concurrent mount attempts of the SAME path. Both track the
  // actual container mounts, not DO storage. Instance state on a DO — not a
  // module-level cache — so nothing leaks across containers.
  //
  // They are cleared in `onStop`, NOT by DO recreation: a container stop fires
  // `onStop` on the SURVIVING DO instance (that is what the hook is for) and the
  // SDK clears its own `activeMounts` there. Without the override below, a
  // restarted container came back with empty mount points while this set still
  // claimed them, so `ensureMounted` short-circuited and a run read an empty
  // `/exports` with exit 0 — a silent wrong answer.
  private mountedPaths = new Set<string>();
  private mountGates = new Map<string, (run: () => Promise<void>) => Promise<void>>();
  // Container generation `mountedPaths` describes. `onStop` is the hook that is
  // SUPPOSED to clear the bookkeeping, but the SDK only flushes pending stop
  // events from startAndWaitForPorts/stop()/alarm — a `destroy()` (which is what
  // the zombie self-heal does) does NOT run it synchronously. Pinning the
  // generation makes a stale entry unusable even if no hook ever fires.
  private mountedContainerGeneration: number | undefined;

  /** Consecutive session deaths seen by `exec` on this DO instance. */
  private sessionDeaths = new SandboxSessionDeathTracker();

  /**
   * Wedged-teardown bookkeeping, per DO instance (see
   * SandboxZombieHealState).
   */
  private zombieHealState = createSandboxZombieHealState();

  /**
   * Same zombie self-heal the build container runs (see
   * sandbox-zombie-recovery.ts), with one deliberate difference: it fires on the
   * SECOND consecutive session death, not the first.
   *
   * The analysis path already has a cheap, correct recovery for a single death —
   * `AnalysisService.withSessionRecovery` clears the cached session id
   * (`resetSession`) and retries once against the SAME warm container, which is
   * sub-second and is exactly what the SDK's self-recovering SessionTerminated
   * class needs. Destroying on the first death would pre-empt that retry with a
   * 30-120s cold boot plus a full re-mount. A death that survives the fresh
   * session handshake is a real zombie, and that is what
   * SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD counts. The error always propagates, so
   * the service's recovery keeps its semantics either way, and the shared
   * cooldown still prevents a double restart.
   */
  override async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return withZombieSelfHeal(
      this.zombieHealTarget,
      "AnalysisSandbox",
      "exec",
      () => super.exec(command, options),
      { threshold: SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD, tracker: this.sessionDeaths },
    );
  }

  /** Worker-side entry point for the same rate-limited self-heal. */
  async restartZombieContainer(
    request: SandboxZombieRestartRequest,
  ): Promise<SandboxZombieRestartOutcome> {
    return healZombieSandboxContainer(this.zombieHealTarget, "AnalysisSandbox", request);
  }

  /** `ctx` is protected, so the shared helper gets an explicit public view. */
  private get zombieHealTarget(): ZombieHealableSandbox {
    return createZombieHealTarget({
      ctx: this.ctx,
      env: this.env,
      destroy: () => this.destroy(),
      healState: this.zombieHealState,
      onContainerDestroyed: () => this.forgetDestroyedContainerState(),
    });
  }

  /**
   * The container was destroyed under us (zombie self-heal). `onStop` is NOT
   * guaranteed to run for that path, so everything that only described THAT
   * container is dropped here: the mount bookkeeping (otherwise the retry that
   * follows short-circuits `ensureMounted` and runs user code against a
   * container with nothing mounted — an empty `/exports` read as exit 0), the
   * cached session id, and the consecutive-death count.
   */
  private async forgetDestroyedContainerState(): Promise<void> {
    this.clearMountBookkeeping();
    this.sessionDeaths.reset();
    await this.resetSession();
  }

  private clearMountBookkeeping(): void {
    this.mountedPaths = new Set<string>();
    this.mountGates = new Map<string, (run: () => Promise<void>) => Promise<void>>();
  }

  /**
   * Drop mount bookkeeping left over from a previous container life. The SDK
   * bumps `containerGeneration` on every container stop; anything recorded under
   * an older generation describes mounts that no longer exist.
   */
  private syncMountBookkeepingToContainer(): void {
    const sdk = this as unknown as { containerGeneration?: number };
    const generation = typeof sdk.containerGeneration === "number" ? sdk.containerGeneration : 0;
    if (this.mountedContainerGeneration === generation) return;
    this.mountedContainerGeneration = generation;
    this.clearMountBookkeeping();
  }

  /**
   * Container went away: everything mounted into it went with it. Clear the
   * bookkeeping so the next `ensureMounted` really re-mounts.
   */
  override async onStop(): Promise<void> {
    this.clearMountBookkeeping();
    this.sessionDeaths.reset();
    await super.onStop();
  }

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
   * previous container life is recovered via unmount+remount (see mountOrRecover)
   * so `r2.internal` egress is re-registered instead of leaving zombie FUSE mounts.
   */
  async ensureMounted(
    bucketBinding: string,
    prefix: string,
    mountPath?: string,
    options: { readOnly?: boolean } = {},
  ): Promise<void> {
    const resolvedMountPath = mountPath ?? `/${prefix}`;
    // Never trust bookkeeping from a container that has since stopped/been
    // destroyed: short-circuiting there is what silently runs a query against
    // missing mounts.
    this.syncMountBookkeepingToContainer();
    const readOnly = options.readOnly ?? true;
    const mountOptions = sandboxR2MountOptions(this.env, {
      prefix: `/${prefix}`,
      readOnly,
      // Shrink the s3fs stat cache (default 60s + negative caching) so a
      // just-staged export/upload isn't read through a stale/partial view.
      // Self-host local sync deliberately drops this s3fs-only option.
      s3fsOptions: ["stat_cache_expire=1"],
    });
    const actualMountPath = sandboxR2MountPath(resolvedMountPath, mountOptions);
    if (this.mountedPaths.has(resolvedMountPath)) {
      if (await mountAllowsList(this, actualMountPath)) return;
      // A mount can die without a container stop (the exact production Errno 5
      // failure mode). Do not trust the cached success: reopen the single-flight
      // gate so this call unmounts/remounts before dispatching user code.
      console.warn(`[sandbox] cached R2 mount ${actualMountPath} is unreadable; remounting`);
      this.mountedPaths.delete(resolvedMountPath);
      this.mountGates.delete(resolvedMountPath);
    }
    let gate = this.mountGates.get(resolvedMountPath);
    if (!gate) {
      gate = createSingleFlight();
      this.mountGates.set(resolvedMountPath, gate);
    }
    await gate(async () => {
      await mountOrRecover(
        this,
        bucketBinding,
        actualMountPath,
        mountOptions,
      );
      await ensureLocalMountAlias(this, resolvedMountPath, actualMountPath);
      if ("localBucket" in mountOptions && mountOptions.localBucket && !readOnly) {
        const bucket = this.env[bucketBinding as keyof Env];
        await waitForWritableLocalMount(
          this,
          bucket as unknown as LocalMountBucket,
          actualMountPath,
          mountOptions.prefix ?? "",
        );
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

  /**
   * Forget the container session so the next command re-runs the create-session
   * handshake.
   *
   * A container OOM/restart kills the persistent shell; the container reaps the
   * session and answers `SessionTerminatedError`, but the SDK caches the default
   * session id in DO memory AND in DO storage and only clears it from `onStop`
   * (`node_modules/@cloudflare/sandbox/dist/sandbox-*.js`: `defaultSession`,
   * `ensureDefaultSession`, `onStop`) — so a shell that dies while the container
   * stays up leaves the cached id pointing at a session that no longer exists.
   * Clearing it here is the SDK's own documented remedy ("call createSession()
   * with the same id to recreate it explicitly"), just driven from inside the DO
   * where `ensureDefaultSession` will do it on the next call.
   *
   * Mount bookkeeping is deliberately left alone: mounts are container-level,
   * not session-level, so a dead shell does not invalidate them. A real
   * container stop is the case that DOES invalidate them, and `onStop` clears
   * them there (the DO instance itself survives a container stop).
   *
   * Called only by AnalysisService's one-shot session recovery, and always
   * best-effort: the SDK recreates a terminated session on the next call anyway,
   * so a failure here must not fail the run.
   */
  async resetSession(): Promise<void> {
    const sdkState = this as unknown as {
      defaultSession: string | null;
      defaultSessionInit: unknown;
    };
    sdkState.defaultSession = null;
    sdkState.defaultSessionInit = null;
    try {
      await this.ctx.storage.delete("defaultSession");
    } catch (error) {
      console.warn("[AnalysisSandbox] failed to clear the stored default session", error);
    }
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
