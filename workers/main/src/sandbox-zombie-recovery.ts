// Zombie-container self-heal for the sandbox DOs.
//
// A ZOMBIE container is one whose sandbox server process is up and answering
// cheap file/HTTP operations while its shell/executor layer is dead: `exists`
// succeeds, `exec` answers `SessionTerminatedError: … shell exited (exit code:
// 128)` forever. Nothing in the SDK recovers from that on its own — the session
// id is re-created against the same dead container, and every build/analysis
// command in that org keeps failing until the idle reaper eventually stops the
// container (up to PROJECT_BUILD_SLEEP_AFTER later).
//
// The only lever that fixes it is destroying the container instance so the next
// call boots a clean one (`Sandbox.destroy()` → `Container.destroy()`, SIGKILL,
// fires `onStop`). That is a big hammer: it kills any concurrent work in the
// same container, so it is fired ONLY on the session-death signature (never on
// timeouts, transport errors or slow boots — a healthy cold boot must never
// reach it) and at most once per cooldown window per container.
//
// The cooldown timestamp lives in the DO's own key/value storage, which is
// durable across container restarts and DO evictions — a genuinely broken image
// (one that comes back dead every time) therefore cannot restart-loop; it gets
// one restart per window and then fails honestly.
//
// See plans/sse-migration/ZOMBIE-CONTAINER-FIX.md.
import {
  errorToObservabilityFields,
  recordObservabilityEvent,
  type ObservabilityEnv,
} from "./observability.js";
import { isSandboxSessionDeathError } from "./sandbox-session-death.js";

/** At most one forced restart per container per this window. */
export const SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS = 5 * 60_000;

/** DO-storage key holding the last forced-restart timestamp (ms). */
export const SANDBOX_ZOMBIE_RESTART_AT_KEY = "camelai:zombieRestartAtMs";

/**
 * Consecutive session-death readiness probes that mean "zombie", not "blip".
 *
 * Higher than 1 because a single session death can also be an ordinary
 * mid-flight container restart, which the next probe already recovers from; a
 * zombie answers session-death to EVERY probe, so it reaches this in a few
 * seconds of the gate's 1.5s cadence.
 *
 * This threshold only means anything because the readiness probe reaches the
 * container through a heal-EXEMPT entry point (`ProjectBuildSandbox.probeShell`):
 * a probe routed through `exec` would be healed by the wrapper below before the
 * gate ever counted it.
 */
export const SANDBOX_ZOMBIE_PROBE_THRESHOLD = 3;

/**
 * Consecutive session-death `exec` failures before the ANALYSIS container is
 * destroyed.
 *
 * The analysis path has its own cheap recovery for the first death
 * (`AnalysisService.withSessionRecovery`: reset the cached session id, re-run
 * the create-session handshake against the SAME warm container, retry once).
 * That is sub-second and is exactly right for the self-recovering class the SDK
 * documents ("the next call with the same sessionId will transparently start a
 * fresh session"). Destroying on the FIRST death would replace it with a
 * 30-120s cold boot plus a full re-mount, for a shell that was going to come
 * back on its own. A death that survives that handshake is real zombie
 * evidence, so the heal fires on the SECOND consecutive one — i.e. the retry
 * the service already performs is the discriminator.
 *
 * The build path has no such retry (its ladder restarts the whole operation) and
 * keeps the plan's destroy-on-first-exec-death behaviour.
 */
export const SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD = 2;

/** Why a restart was requested. Low-cardinality; goes straight to telemetry. */
export type SandboxZombieRestartTrigger =
  | "exec_session_death"
  | "probe_session_death"
  | "mount_io_error";

export type SandboxZombieRestartOutcome =
  | {
    restarted: true;
    /** `instance_aborted`: the teardown was wedged, so the DO instance was evicted instead. */
    reason: "forced" | "instance_aborted";
    sinceLastRestartMs: number | null;
  }
  | {
    restarted: false;
    reason: "rate_limited" | "container_not_running" | "destroy_failed";
    sinceLastRestartMs: number | null;
  };

export interface SandboxZombieRestartRequest {
  /** Low-cardinality operation name (`exec`, `readiness_probe`, …). */
  operation: string;
  trigger: SandboxZombieRestartTrigger;
  /** The session-death error that triggered this, for telemetry only. */
  error?: unknown;
}

/**
 * The narrow slice of a Sandbox DO this needs. Kept as an interface (rather
 * than the DO itself) so the decision logic is unit-testable without a
 * container, and so ProjectBuildSandbox and AnalysisSandbox share ONE
 * implementation instead of two copies that drift.
 */
export interface SandboxZombieRestartHost {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: number): Promise<void>;
  };
  /** `ctx.container?.running === true`; a stopped container needs no heal. */
  isContainerRunning(): boolean;
  /**
   * `Sandbox.destroy()`, bounded. Resolving with `{ escalated: true }` means the
   * teardown itself was wedged and the DO instance was evicted instead.
   */
  destroyContainer(): Promise<{ escalated?: boolean } | void>;
  /** Emits `build_sandbox_zombie_restart`. Never throws. */
  recordRestart(event: {
    request: SandboxZombieRestartRequest;
    outcome: SandboxZombieRestartOutcome;
    destroyError?: unknown;
  }): void;
}

/**
 * True when a forced restart is allowed right now: the container is up (so
 * there is something to destroy) and the cooldown has lapsed.
 */
export function canForceZombieRestart(input: {
  nowMs: number;
  lastRestartAtMs: number | undefined;
  containerRunning: boolean;
  cooldownMs?: number;
}): boolean {
  if (!input.containerRunning) return false;
  const cooldownMs = input.cooldownMs ?? SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS;
  const last = input.lastRestartAtMs;
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  // A clock that went backwards (or a timestamp from the future) must not
  // disable the heal for more than the skew plus one cooldown, but it also must
  // not open the gate immediately: treat it as "just restarted".
  if (last > input.nowMs) return false;
  return input.nowMs - last >= cooldownMs;
}

/**
 * Destroy the container so the next call boots clean, at most once per cooldown.
 *
 * The cooldown stamp is written BEFORE the destroy: `destroy()` tears the
 * container down under us, and an unrecorded restart is how a broken image
 * turns into a restart loop.
 */
export async function forceSandboxZombieRestart(
  host: SandboxZombieRestartHost,
  request: SandboxZombieRestartRequest,
  options: { nowMs?: number; cooldownMs?: number } = {},
): Promise<SandboxZombieRestartOutcome> {
  const nowMs = options.nowMs ?? Date.now();
  const lastRestartAtMs = await host.storage.get<number>(SANDBOX_ZOMBIE_RESTART_AT_KEY);
  const sinceLastRestartMs =
    typeof lastRestartAtMs === "number" && Number.isFinite(lastRestartAtMs)
      ? Math.max(0, nowMs - lastRestartAtMs)
      : null;
  const containerRunning = host.isContainerRunning();
  if (!containerRunning) {
    // Nothing to heal: the next call starts a fresh container anyway.
    return { restarted: false, reason: "container_not_running", sinceLastRestartMs };
  }
  if (!canForceZombieRestart({
    nowMs,
    lastRestartAtMs,
    containerRunning,
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  })) {
    // Suppressed on purpose and deliberately NOT recorded: a rate-limited
    // request can repeat every 1.5s while the gate probes, and the metric must
    // stay "forced restarts", not "restart attempts".
    return { restarted: false, reason: "rate_limited", sinceLastRestartMs };
  }
  await host.storage.put(SANDBOX_ZOMBIE_RESTART_AT_KEY, nowMs);
  let escalated = false;
  try {
    const destroyed = await host.destroyContainer();
    escalated = destroyed?.escalated === true;
  } catch (destroyError) {
    const outcome: SandboxZombieRestartOutcome = {
      restarted: false,
      reason: "destroy_failed",
      sinceLastRestartMs,
    };
    host.recordRestart({ request, outcome, destroyError });
    return outcome;
  }
  const outcome: SandboxZombieRestartOutcome = {
    restarted: true,
    reason: escalated ? "instance_aborted" : "forced",
    sinceLastRestartMs,
  };
  host.recordRestart({ request, outcome });
  return outcome;
}

/** Telemetry event name for a forced zombie restart (both sandbox classes). */
export const SANDBOX_ZOMBIE_RESTART_EVENT = "build_sandbox_zombie_restart";

/**
 * Bound on `destroy()`. The SDK is explicit that it does not bound its own
 * teardown ("callers that need bounded waits must apply their own timeout"),
 * and this runs INSIDE a failing `exec` — an unbounded teardown would hold the
 * caller's error (and its exec budget) for as long as the container took to
 * die. The cooldown stamp is already written when this fires, so giving up
 * waiting cannot turn into a restart loop.
 */
export const SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS = 15_000;

class SandboxZombieDestroyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Sandbox container destroy did not complete within ${timeoutMs}ms`);
    this.name = "SandboxZombieDestroyTimeoutError";
  }
}

class SandboxZombieDestroyWedgedError extends Error {
  constructor() {
    super(
      "Sandbox container teardown is wedged and this DO instance cannot be evicted; " +
      "the heal cannot make progress until the instance is recycled",
    );
    this.name = "SandboxZombieDestroyWedgedError";
  }
}

/**
 * DO-instance-lifetime heal bookkeeping.
 *
 * `Sandbox.destroy()` stores its in-flight promise and every later call awaits
 * that SAME promise ("every coalesced caller hangs on the same promise until the
 * Durable Object is evicted"), and it is only cleared when the underlying work
 * settles. So once we abandon a teardown at SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS,
 * calling `destroy()` again after the cooldown lapses cannot make progress — it
 * re-attaches to the same hung promise, times out again, and the heal is dead
 * for the life of the instance. Remembering that here lets the next attempt skip
 * straight to the only lever that clears it: evicting the DO instance.
 */
export interface SandboxZombieHealState {
  /** A previous teardown was abandoned and may still be pending in the SDK. */
  destroyWedged: boolean;
}

export function createSandboxZombieHealState(): SandboxZombieHealState {
  return { destroyWedged: false };
}

async function destroyWithinTimeout(
  destroy: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const work = destroy();
  // The abandoned teardown must stay observed: a late rejection on a promise
  // nobody awaits surfaces as an unhandled rejection.
  work.catch(() => {});
  let handle: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([work.then(() => "done" as const), expired]);
    if (outcome === "timeout") throw new SandboxZombieDestroyTimeoutError(timeoutMs);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/**
 * The Sandbox-DO shape the self-heal drives. `ProjectBuildSandbox` and
 * `AnalysisSandbox` both satisfy it structurally (they extend
 * `Sandbox<Env>` → `Container<Env>`), so neither needs its own copy of this
 * wiring.
 */
export interface ZombieHealableSandbox {
  ctx: {
    storage: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: number): Promise<void>;
    };
    container?: { running?: boolean };
  };
  env: ObservabilityEnv;
  /** `Sandbox.destroy()` — SIGKILLs the container and fires `onStop`. */
  destroy(): Promise<void>;
  /**
   * Called as soon as the container is gone (or the teardown was abandoned and
   * it may be gone), so the DO can drop state that only describes the container
   * that just died — mount bookkeeping above all.
   *
   * `destroy()` does NOT synchronously run `onStop`: the containers SDK only
   * flushes pending stop events from `startAndWaitForPorts`/`stop()`/`alarm`,
   * so after a heal the next call would otherwise still see `mountedPaths`
   * claiming mounts that died with the container, short-circuit `ensureMounted`
   * and run user code against a container with nothing mounted (an empty
   * `/exports` read as exit 0 — a silent wrong answer).
   */
  onContainerDestroyed?(): void | Promise<void>;
  /** DO-instance heal bookkeeping (wedged teardown). */
  healState?: SandboxZombieHealState;
  /**
   * `ctx.abort()`. The only escalation that clears a wedged
   * `Sandbox.destroy()`: evicting the DO instance discards the coalesced
   * teardown promise, so the next call constructs a fresh instance (and a fresh
   * container). Optional — a runtime without it simply keeps reporting
   * `destroy_failed`.
   */
  abortInstance?(reason: string): void;
}

/**
 * Build the heal view of a Sandbox DO.
 *
 * `ctx`/`env`/`destroy` are protected or overridden on the DO subclasses, so
 * each one passes its own references — but the wiring (which levers exist, how
 * `ctx.abort` is detected) lives here so the two classes cannot drift.
 */
export function createZombieHealTarget(input: {
  ctx: ZombieHealableSandbox["ctx"] & { abort?: (reason?: string) => void };
  env: ObservabilityEnv;
  destroy: () => Promise<void>;
  healState: SandboxZombieHealState;
  onContainerDestroyed?: () => void | Promise<void>;
}): ZombieHealableSandbox {
  const abort = input.ctx.abort;
  return {
    ctx: input.ctx,
    env: input.env,
    destroy: input.destroy,
    healState: input.healState,
    ...(input.onContainerDestroyed
      ? { onContainerDestroyed: input.onContainerDestroyed }
      : {}),
    ...(typeof abort === "function"
      ? { abortInstance: (reason: string) => abort.call(input.ctx, reason) }
      : {}),
  };
}

/**
 * Destroy the container, bounded, and tell the DO its container is gone.
 *
 * Two ordering rules matter here:
 *  - the post-destroy notification runs on the timeout path too, because an
 *    abandoned teardown still (usually) takes the container with it, and stale
 *    mount bookkeeping is the dangerous state — a re-mount that turns out to be
 *    unnecessary is merely slow;
 *  - a teardown we already abandoned is never re-issued (the SDK would coalesce
 *    onto the same hung promise); the instance is evicted instead.
 */
async function destroySandboxContainer(
  sandbox: ZombieHealableSandbox,
  component: string,
  destroyTimeoutMs?: number,
): Promise<{ escalated?: boolean } | void> {
  const state = sandbox.healState;
  if (state?.destroyWedged) {
    if (typeof sandbox.abortInstance !== "function") throw new SandboxZombieDestroyWedgedError();
    console.warn("[sandbox] evicting the DO instance after a wedged container teardown", {
      component,
    });
    sandbox.abortInstance("sandbox container teardown wedged; evicting to recover");
    return { escalated: true };
  }
  try {
    await destroyWithinTimeout(
      () => sandbox.destroy(),
      destroyTimeoutMs ?? SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof SandboxZombieDestroyTimeoutError) {
      if (state) state.destroyWedged = true;
      await notifyContainerDestroyed(sandbox, component);
    }
    throw error;
  }
  await notifyContainerDestroyed(sandbox, component);
}

/** Best-effort: post-destroy bookkeeping must never fail the heal. */
async function notifyContainerDestroyed(
  sandbox: ZombieHealableSandbox,
  component: string,
): Promise<void> {
  if (typeof sandbox.onContainerDestroyed !== "function") return;
  try {
    await sandbox.onContainerDestroyed();
  } catch (error) {
    console.warn("[sandbox] post-destroy cleanup failed", {
      component,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Self-heal entry point for a sandbox DO: destroy a container whose shell layer
 * is dead, rate-limited to one restart per cooldown window.
 *
 * Callers reach this only after a narrow health check proves the container is
 * unrecoverable in place: repeated session death or an R2 mount that still
 * fails traversal after unmount/remount. Slow boots, transport errors,
 * timeouts, and ordinary 503s never call this helper.
 */
export async function healZombieSandboxContainer(
  sandbox: ZombieHealableSandbox,
  component: string,
  request: SandboxZombieRestartRequest,
  options: { nowMs?: number; cooldownMs?: number; destroyTimeoutMs?: number } = {},
): Promise<SandboxZombieRestartOutcome> {
  const host: SandboxZombieRestartHost = {
    storage: sandbox.ctx.storage,
    isContainerRunning: () => sandbox.ctx.container?.running === true,
    destroyContainer: () => destroySandboxContainer(sandbox, component, options.destroyTimeoutMs),
    recordRestart: ({ request: recorded, outcome, destroyError }) => {
      const fields = errorToObservabilityFields(destroyError ?? recorded.error);
      console.warn("[sandbox] forced zombie container restart", {
        component,
        operation: recorded.operation,
        trigger: recorded.trigger,
        restarted: outcome.restarted,
        reason: outcome.reason,
        error: fields.errorMessage,
      });
      recordObservabilityEvent(sandbox.env, {
        event: SANDBOX_ZOMBIE_RESTART_EVENT,
        severity: outcome.restarted ? "warn" : "error",
        component,
        operation: recorded.operation,
        status: outcome.restarted && outcome.reason === "forced" ? "restarted" : outcome.reason,
        // `trigger` is the low-cardinality dimension the dashboards slice on;
        // errorName is the only string column that keeps its cardinality.
        errorName: recorded.trigger,
        errorMessage: fields.errorMessage,
        durationMs: outcome.sinceLastRestartMs,
      });
    },
  };
  return forceSandboxZombieRestart(host, request, options);
}

/**
 * Consecutive session deaths on one DO instance.
 *
 * In-memory on purpose: it describes ONE container's shell layer, so it must
 * die with the DO instance (and is reset whenever the container goes away or a
 * call succeeds). Persisting it would carry a verdict about a container that no
 * longer exists.
 */
export class SandboxSessionDeathTracker {
  private consecutive = 0;

  /** Count one session death; returns the new consecutive count. */
  record(): number {
    this.consecutive += 1;
    return this.consecutive;
  }

  reset(): void {
    this.consecutive = 0;
  }

  get consecutiveDeaths(): number {
    return this.consecutive;
  }
}

export interface ZombieSelfHealOptions {
  /**
   * Consecutive session deaths required before the container is destroyed.
   * Defaults to 1 (destroy on the first). Anything above 1 needs a `tracker`.
   */
  threshold?: number;
  /** DO-instance counter backing `threshold`. */
  tracker?: SandboxSessionDeathTracker;
}

/**
 * Wrap one exec-class DO operation with the self-heal.
 *
 * The error is always re-thrown: healing is about the NEXT call (the destroyed
 * container boots clean), never about hiding this one's failure — the analysis
 * service's own recreate+retry and the build ladder still see the original
 * error and keep their existing semantics.
 *
 * ANY non-session-death outcome (success or another error class) resets the
 * consecutive counter, which is the same rule the readiness gate applies to its
 * probes: it is what makes a healthy container structurally incapable of
 * reaching the hammer.
 */
export async function withZombieSelfHeal<T>(
  sandbox: ZombieHealableSandbox,
  component: string,
  operation: string,
  run: () => Promise<T>,
  options: ZombieSelfHealOptions = {},
): Promise<T> {
  try {
    const value = await run();
    options.tracker?.reset();
    return value;
  } catch (error) {
    if (!isSandboxSessionDeathError(error)) {
      options.tracker?.reset();
      throw error;
    }
    const threshold = Math.max(1, Math.floor(options.threshold ?? 1));
    const consecutive = options.tracker ? options.tracker.record() : 1;
    if (consecutive >= threshold) {
      try {
        const outcome = await healZombieSandboxContainer(sandbox, component, {
          operation,
          trigger: "exec_session_death",
          error,
        });
        // The verdict was spent: the next container gets a fresh count.
        if (outcome.restarted) options.tracker?.reset();
      } catch (healError) {
        // The original failure is what the caller must see.
        console.warn("[sandbox] zombie self-heal failed", {
          component,
          operation,
          error: healError instanceof Error ? healError.message : String(healError),
        });
      }
    }
    throw error;
  }
}
