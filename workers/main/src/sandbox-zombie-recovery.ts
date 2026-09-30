// Zombie-container self-heal for the sandbox DOs.
//
// A ZOMBIE container is one whose sandbox server process is up and answering
// cheap file/HTTP operations while its shell/executor layer is dead: `exists`
// succeeds, `exec` answers `SessionTerminatedError: … shell exited (exit code:
// 128)` forever. Nothing in the SDK recovers from that on its own — the session
// id is re-created against the same dead container, and every analysis command
// in that workspace keeps failing until the idle reaper eventually stops the
// container.
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
 * Consecutive session-death `exec` failures before the ANALYSIS container is
 * destroyed.
 *
 * Only DO-side analysis execs still pass through this wrapper, and they run
 * sessionless (AnalysisSandbox.exec), so a session death there should not
 * happen at all. Two consecutive ones are strong zombie evidence; the
 * threshold stays at 2 so a single stray failure never costs a 30-120s cold
 * boot plus a full re-mount. Remove with the rest of the heal logic once
 * telemetry shows sessionless execs never trip it.
 */
export const SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD = 2;

/** Why a restart was requested. Low-cardinality; goes straight to telemetry. */
export type SandboxZombieRestartTrigger =
  | "exec_session_death"
  | "mount_io_error"
  | "mount_session_timeout";

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
 * container.
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
  /** Emits `sandbox_zombie_restart` (plus the legacy name). Never throws. */
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

export interface SandboxZombieRestartOptions {
  nowMs?: number;
  cooldownMs?: number;
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
  options: SandboxZombieRestartOptions = {},
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

/**
 * Telemetry event for a forced zombie restart, from any sandbox class
 * (`blob3` component tells them apart).
 */
export const SANDBOX_ZOMBIE_RESTART_EVENT = "sandbox_zombie_restart";

/**
 * The event's old name, from when only the (since deleted) 0.12 build sandbox
 * healed. Every restart
 * is still written under it too, so saved queries and alerts keep working
 * during the switch; drop it once they read the new name.
 */
export const LEGACY_SANDBOX_ZOMBIE_RESTART_EVENT = "build_sandbox_zombie_restart";

/** Which tenant a sandbox DO serves, stamped on its telemetry. */
export interface SandboxTelemetryScope {
  workspaceId?: string;
  orgId?: string;
}

/**
 * The name the sandbox DO was addressed by (`getSandbox(ns, name)`), when it
 * is known: the SDK records it on the instance, and the runtime exposes it on
 * `ctx.id` for ids made with `idFromName`. `normalizeId` stubs lowercase it.
 */
export function sandboxInstanceName(sandbox: object): string | undefined {
  const sdkName = (sandbox as { sandboxName?: unknown }).sandboxName;
  if (typeof sdkName === "string" && sdkName) return sdkName;
  const idName = (sandbox as { ctx?: { id?: { name?: unknown } } }).ctx?.id?.name;
  return typeof idName === "string" && idName ? idName : undefined;
}

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
 * The Sandbox-DO shape the self-heal drives. `AnalysisSandbox` satisfies it
 * structurally (it extends `Sandbox<Env>` → `Container<Env>`).
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
  /** Tenant for the restart event. */
  scope?: () => SandboxTelemetryScope;
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
  scope?: () => SandboxTelemetryScope;
}): ZombieHealableSandbox {
  const abort = input.ctx.abort;
  return {
    ctx: input.ctx,
    env: input.env,
    destroy: input.destroy,
    healState: input.healState,
    ...(input.scope ? { scope: input.scope } : {}),
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
 * unrecoverable in place: repeated session death, an R2 mount that still
 * fails traversal after unmount/remount.
 * Slow boots, transport errors, runner timeouts, and ordinary 503s never call
 * this helper.
 */
export async function healZombieSandboxContainer(
  sandbox: ZombieHealableSandbox,
  component: string,
  request: SandboxZombieRestartRequest,
  options: SandboxZombieRestartOptions & { destroyTimeoutMs?: number } = {},
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
      const scope = safeScope(sandbox);
      for (const event of [SANDBOX_ZOMBIE_RESTART_EVENT, LEGACY_SANDBOX_ZOMBIE_RESTART_EVENT]) {
        recordObservabilityEvent(sandbox.env, {
          event,
          severity: outcome.restarted ? "warn" : "error",
          component,
          operation: recorded.operation,
          status: outcome.restarted && outcome.reason === "forced" ? "restarted" : outcome.reason,
          // `trigger` is the low-cardinality dimension the dashboards slice on;
          // errorName is the only string column that keeps its cardinality.
          errorName: recorded.trigger,
          errorMessage: fields.errorMessage,
          durationMs: outcome.sinceLastRestartMs,
          workspaceId: scope.workspaceId,
          orgId: scope.orgId,
        });
      }
    },
  };
  return forceSandboxZombieRestart(host, request, options);
}

/** Telemetry must never fail a heal. */
function safeScope(sandbox: ZombieHealableSandbox): SandboxTelemetryScope {
  try {
    return sandbox.scope?.() ?? {};
  } catch {
    return {};
  }
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
 * service still sees the original error and keeps its existing semantics.
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
