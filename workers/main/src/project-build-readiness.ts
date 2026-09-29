// Boot-aware readiness gate for the per-org ProjectBuildSandbox container.
//
// The build container sleeps when idle (see PROJECT_BUILD_SLEEP_AFTER). Waking
// it takes 30-120s, while the deploy_project retry ladder only spans ~15s, so a
// deploy landing on a cold container used to burn all five attempts inside the
// boot window and surface "Build service temporarily unavailable" to the user —
// who then retried straight back into the same boot and concluded builds were
// broken.
//
// This module waits for the container ONCE per build-tool call, on a gentle
// cadence, with a budget that dominates the SDK's own per-call retry budget
// (see PROJECT_BUILD_SDK_RETRY_BUDGET_MS). The existing retry ladder stays
// as-is: it is the right guard for blips on an already-warm container, and it
// runs after readiness.
//
// Two failure classes never wait: a storage-mount misconfiguration
// (isProjectBuildStorageMountError) and a permanent container-startup failure
// (isProjectBuildPermanentStartupError) — retrying either cannot help, so they
// fail fast with their own terminal message instead of burning the budget.
import {
  createSandboxDeadlineTimer,
  isSandboxDeadlineExceededError,
  type SandboxDeadlineTimer,
  type SandboxExecDeadline,
} from "./sandbox-exec-deadline.js";
import { isSandboxSessionDeathError } from "./sandbox-session-death.js";
import { SANDBOX_ZOMBIE_PROBE_THRESHOLD } from "./sandbox-zombie-recovery.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

/**
 * The sandbox SDK retries its own control-plane upgrade on 503 for
 * `computeRetryTimeoutMs()` = max(120_000, instanceGetTimeoutMS +
 * portReadyTimeoutMS + 30_000) — 30_000 + 90_000 + 30_000 = 150_000 with this
 * repo's (default) container timeouts.
 * Source: node_modules/@cloudflare/sandbox/dist/sandbox-*.js `computeRetryTimeoutMs`.
 * A single probe can therefore block ~135-165s before it rejects: retries stop
 * once elapsed >= retryTimeoutMs - MIN_TIME_FOR_RETRY_MS (15_000), and the last
 * attempt may still take a full 30s connect timeout.
 */
export const PROJECT_BUILD_SDK_RETRY_BUDGET_MS = 150_000;

/**
 * Cold-boot budget. MUST dominate PROJECT_BUILD_SDK_RETRY_BUDGET_MS (plus the
 * ~30s tail of the SDK's final connect attempt), otherwise the very first probe
 * consumes the whole budget and the re-probe loop below never runs — the gate
 * would then add nothing over what the SDK already does internally.
 * Re-check this constant whenever @cloudflare/sandbox is upgraded
 * (tests/project-build-readiness.test.ts asserts the relationship).
 */
export const PROJECT_BUILD_COLD_START_BUDGET_MS = 240_000;

/**
 * Per-probe deadline. capnweb has no client-side call timeout, so a probe whose
 * WebSocket upgrade succeeds against a container that never answers would block
 * forever; this bounds it. Chosen above the SDK's own retry budget + connect
 * tail so a legitimate cold boot is never cut short. Always further clamped to
 * the remaining cold-start budget.
 */
export const PROJECT_BUILD_PROBE_TIMEOUT_MS = 180_000;

/**
 * Budget for a control-plane upgrade that failed with a 500.
 *
 * Under transport "rpc" the SDK discards the response body, so the only signal
 * that survives is the status code: 503 = "container is starting, retry", 500 =
 * the SDK's permanent-startup branch ("Container failed to start due to a
 * permanent error"). A plain DO exception also surfaces as 500, so this is a
 * short bounded budget (a couple of probes) rather than an absolute fast-fail.
 */
export const PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS = 5_000;

/** Gentle re-probe cadence while the container boots. */
export const PROJECT_BUILD_READY_PROBE_INTERVAL_MS = 1_500;
/** Report "still starting" progress once a wait crosses this threshold. */
export const PROJECT_BUILD_READY_PROGRESS_AFTER_MS = 5_000;
/** Progress text shown while the container boots. */
export const PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE =
  "Build environment is starting…";

export const PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE =
  "Build service temporarily unavailable. Please try again in a moment.";
export const PROJECT_BUILD_STORAGE_MOUNT_MESSAGE =
  "Build sandbox storage is not available in this installation. Retrying will not help. " +
  "Self-hosted installations should upgrade to a release that uses FUSE-free local R2 synchronization, " +
  "then run the self-host container smoke checks.";
export const PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE =
  "Build environment failed to start and will not recover on retry. " +
  "This needs operator attention: check the build container configuration (image, instance limits) and its logs.";

/** Fixed, always-present path — the fallback probe never mutates the workdir. */
const PROJECT_BUILD_READY_PROBE_PATH = "/workspace";

/**
 * The probe command. It has to run THROUGH the session/shell layer, because
 * that is the layer that dies: a zombie container (sandbox server up, shell
 * dead) answers `exists` happily and fails every `exec` with
 * `SessionTerminatedError`. Probing the cheap layer is what let a gated deploy
 * conclude "ready" instantly and then die in ~15s of ladder
 * (plans/sse-migration/ZOMBIE-CONTAINER-FIX.md).
 *
 * `true` is the cheapest possible command: no output, no filesystem effect.
 */
const PROJECT_BUILD_READY_PROBE_COMMAND = "true";

/**
 * Container-side bound on the probe command. The client-side per-probe deadline
 * (PROJECT_BUILD_PROBE_TIMEOUT_MS) has to stay long enough for a legitimate
 * cold boot to complete inside one call, so it cannot double as the bound on a
 * shell that accepted the command and never answered — this does that, and the
 * container enforces it itself.
 */
export const PROJECT_BUILD_PROBE_COMMAND_TIMEOUT_MS = 15_000;

/** Low-cardinality cause for the SDK's permanent-startup class. */
const PERMANENT_STARTUP_CAUSE = "container_startup_permanent";
/** Low-cardinality cause for a 500 on the control-plane upgrade (rpc transport). */
const STARTUP_FAILURE_CAUSE = "container_startup_failed";
/** Low-cardinality cause for the zombie signature (dead shell, live server). */
export const PROJECT_BUILD_SESSION_DEATH_CAUSE = "session_death";
const PROBE_SESSION_DEATH_CAUSE = PROJECT_BUILD_SESSION_DEATH_CAUSE;

/**
 * Markers the sandbox SDK uses for its non-recoverable startup class.
 *
 * The first two are the SDK's own wrapper text (`message` / `suggestion` of the
 * HTTP 500 body); the rest are the underlying platform messages it embeds in
 * `context.error` and matches in `isPermanentStartupError`.
 * Source: node_modules/@cloudflare/sandbox/dist/sandbox-*.js.
 */
const PERMANENT_STARTUP_PATTERNS = [
  /Container failed to start due to a permanent error/i,
  /will not resolve with retries/i,
  /ran out of memory/i,
  /too many subprocesses/i,
  /no application that matches/i,
  /no container application assigned/i,
  /no such image/i,
  /did not call start/i,
] as const;

/**
 * Terminal storage misconfiguration (self-host without FUSE). Checked before
 * the transient classification so a mount failure never waits out the cold-boot
 * budget or the retry ladder.
 */
export function isProjectBuildStorageMountError(error: unknown): boolean {
  const message = errorText(error);
  return /S3FS mount failed/i.test(message) ||
    /fuse:\s*device not found/i.test(message) ||
    /try ['"]?modprobe fuse/i.test(message);
}

/**
 * Terminal container-startup failure: the SDK explicitly classifies these as
 * non-recoverable (bad image, missing container application, OOM at boot, app
 * never called start). Checked before the transient classification so a broken
 * build container fails fast instead of re-probing for the whole budget.
 */
export function isProjectBuildPermanentStartupError(error: unknown): boolean {
  if (isProjectBuildStorageMountError(error)) return false;
  const message = errorText(error);
  return PERMANENT_STARTUP_PATTERNS.some((pattern) => pattern.test(message));
}

export function isProjectBuildServiceUnavailableError(error: unknown): boolean {
  return projectBuildTransientCause(error) !== null;
}

/**
 * Name the transient failure mode so retry/readiness logs and telemetry carry a
 * low-cardinality cause instead of a raw message. Returns null when the error is
 * not one of the known container-wake transients — including the permanent
 * startup class, so the surrounding retry ladder stops retrying it too.
 *
 * Ordering note: under transport "rpc" the real production shape is
 * `RPCTransportError: WebSocket upgrade failed: <status> <text>`, so the
 * upgrade status is matched BEFORE the generic RPCTransportError rule — the
 * status code is the only discriminator the SDK preserves on that path.
 */
export function projectBuildTransientCause(error: unknown): string | null {
  if (error instanceof ProjectBuildProbeTimeoutError) return "probe_timeout";
  // The probe ran but the shell answered with a non-zero exit for `true`: the
  // container is up and answering, its executor layer is not healthy. Transient
  // so the gate keeps probing (and the ladder keeps retrying) rather than
  // surfacing a raw exit code as a build failure.
  if (error instanceof ProjectBuildProbeCommandFailedError) return "probe_command_failed";
  // Zombie container: the sandbox server is up while its shell layer is dead.
  // Classified transient because the self-heal (destroy → clean boot on the
  // next call) makes it genuinely recoverable — the gate's budget and the
  // ladder are exactly the machinery that should absorb the reboot.
  if (isSandboxSessionDeathError(error)) return PROBE_SESSION_DEATH_CAUSE;
  // A build we abandoned on its client-side deadline: the container is wedged
  // (its own timeout should have fired and did not). Named here so retry logs
  // and telemetry carry the real cause instead of a raw message.
  //
  // It is transient in CLASSIFICATION only. The ladder in code-mode-tools stops
  // on it as soon as the shared exec budget is spent — which a deadline
  // exceedance means by definition — because an abandoned build cannot be
  // cancelled and a further attempt would run concurrently with it in the same
  // per-project workdir. The terminal path surfaces the deadline's own message
  // rather than the generic "temporarily unavailable" one.
  if (isSandboxDeadlineExceededError(error)) return "exec_deadline_exceeded";
  if (isProjectBuildPermanentStartupError(error)) return null;
  const message = errorText(error);
  const upgradeStatus = message.match(/WebSocket upgrade failed:\s*(\d{3})/i)?.[1];
  if (upgradeStatus) {
    return upgradeStatus === "500" ? STARTUP_FAILURE_CAUSE : "websocket_upgrade_failed";
  }
  if (/RPCTransportError/i.test(message)) return "rpc_transport";
  // Typed platform transients added in @cloudflare/sandbox 0.12.5/0.12.3; both
  // are documented as retryable (the container is starting, replaced, or at
  // capacity; or the runtime was replaced under an admitted operation).
  if (/ContainerUnavailableError/.test(message)) return "container_unavailable";
  if (/OperationInterruptedError/.test(message)) return "operation_interrupted";
  // sandbox-sdk#928: on the rpc transport a refused container start disposes
  // the client, and the first call fails ~1s in with this text.
  if (/disposing the main stub/i.test(message)) return "rpc_session_disposed";
  if (/Network connection lost/i.test(message)) return "network_connection_lost";
  if (/WebSocket upgrade failed/i.test(message)) return "websocket_upgrade_failed";
  // Capacity/provisioning: the container VM has not been handed out yet. Only
  // reachable when the response body survives (http/websocket transports); the
  // rpc transport collapses it into a 503 upgrade failure.
  if (/no container instance/i.test(message)) return "container_provisioning";
  if (/Container is currently provisioning/i.test(message)) return "container_provisioning";
  if (/503\s+Service\s+Unavailable/i.test(message)) return "service_unavailable";
  if (/Container failed to start/i.test(message)) return "container_failed_to_start";
  return null;
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? `${error.name}: ${error.message}` : error);
}

/** Budget a given transient cause is allowed to spend. */
function budgetForCause(cause: string | null, budgetMs: number): number {
  if (cause === STARTUP_FAILURE_CAUSE) {
    return Math.min(budgetMs, PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS);
  }
  return budgetMs;
}

/**
 * The probe command came back non-zero. Distinct from a thrown SDK error: the
 * container answered, so this is "not healthy yet", not "unreachable".
 */
export class ProjectBuildProbeCommandFailedError extends Error {
  readonly exitCode: number | undefined;

  constructor(exitCode: number | undefined, stderr?: string) {
    super(
      `Project build sandbox probe command exited ${exitCode ?? "unknown"}` +
      (stderr ? `: ${stderr.slice(0, 200)}` : ""),
    );
    this.name = "ProjectBuildProbeCommandFailedError";
    this.exitCode = exitCode;
  }
}

/** A probe that blew its own deadline; treated as a transient boot signal. */
export class ProjectBuildProbeTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Project build sandbox probe timed out after ${timeoutMs}ms`);
    this.name = "ProjectBuildProbeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Cause attached to the thrown unavailable error so the wait is visible in
 * telemetry (the user-facing message stays unchanged).
 */
export class ProjectBuildSandboxNotReadyError extends Error {
  readonly waitedMs: number;
  readonly attempts: number;
  readonly budgetMs: number;

  constructor(input: {
    waitedMs: number;
    attempts: number;
    budgetMs: number;
    cause?: unknown;
  }) {
    super(
      `Project build sandbox was not ready after ${input.waitedMs}ms ` +
      `(${input.attempts} probes, budget ${input.budgetMs}ms)`,
      { cause: input.cause },
    );
    this.name = "ProjectBuildSandboxNotReadyError";
    this.waitedMs = input.waitedMs;
    this.attempts = input.attempts;
    this.budgetMs = input.budgetMs;
  }
}

export type ProjectBuildReadinessEvent =
  | {
    type: "zombie_detected";
    waitedMs: number;
    attempts: number;
    cause: string;
    /** Whether the DO actually destroyed the container (false = rate-limited). */
    restarted: boolean;
  }
  | {
    type: "cold_start";
    waitedMs: number;
    attempts: number;
    cause: string | null;
  }
  | {
    type: "ready_timeout";
    waitedMs: number;
    attempts: number;
    budgetMs: number;
    cause: string | null;
  }
  | {
    type: "startup_failed";
    waitedMs: number;
    attempts: number;
    cause: string;
  };

export interface ProjectBuildReadinessResult {
  /** Wall-clock ms spent waiting for the container, including the last probe. */
  waitedMs: number;
  /** Probe count; 1 on the warm path. */
  attempts: number;
  /**
   * True when the container was not immediately available: either a probe
   * failed transiently, or the wait crossed the progress threshold (the SDK
   * absorbs short 503 boots inside a single probe, so a slow first probe is a
   * cold start even though nothing was thrown).
   */
  coldStart: boolean;
}

/**
 * Cancellable deadline for a single probe; the test seam for probe timeouts.
 * Same shape (and default implementation) as the exec-class deadline in
 * sandbox-exec-deadline.ts — one primitive, two callers.
 */
export type ProjectBuildProbeDeadline = SandboxDeadlineTimer;

export interface EnsureBuildSandboxReadyOptions {
  budgetMs?: number;
  probeIntervalMs?: number;
  progressAfterMs?: number;
  probeTimeoutMs?: number;
  /** Called once, when the wait crosses progressAfterMs. */
  onProgress?: (message: string) => void;
  onEvent?: (event: ProjectBuildReadinessEvent) => void;
  /**
   * Consecutive session-death probes that mean "zombie". Never reachable from
   * a slow boot: transport/timeout/503 failures reset the counter.
   */
  zombieProbeThreshold?: number;
  /**
   * Self-heal hook, fired at most ONCE per wait. Defaults to the sandbox DO's
   * own rate-limited `restartZombieContainer`.
   */
  onZombieDetected?: (input: {
    sandbox: ProjectBuildSandboxLike;
    consecutive: number;
    error: unknown;
  }) => Promise<{ restarted?: boolean } | void> | { restarted?: boolean } | void;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timer?: (ms: number) => ProjectBuildProbeDeadline;
  probe?: (sandbox: ProjectBuildSandboxLike) => Promise<unknown>;
}

/**
 * Wait until the build container answers a cheap probe.
 *
 * Warm path: exactly one probe, no event, no added delay. Cold path: re-probe
 * every probeIntervalMs until the container answers or budgetMs is exhausted,
 * with every probe bounded by its own deadline so a hung call cannot outlive
 * the budget. Storage-mount and permanent-startup failures are terminal
 * immediately — they never wait.
 */
export async function ensureBuildSandboxReady(
  sandbox: ProjectBuildSandboxLike,
  options: EnsureBuildSandboxReadyOptions = {},
): Promise<ProjectBuildReadinessResult> {
  const budgetMs = options.budgetMs ?? PROJECT_BUILD_COLD_START_BUDGET_MS;
  const probeIntervalMs = options.probeIntervalMs ?? PROJECT_BUILD_READY_PROBE_INTERVAL_MS;
  const progressAfterMs = options.progressAfterMs ?? PROJECT_BUILD_READY_PROGRESS_AFTER_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? PROJECT_BUILD_PROBE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timer = options.timer ?? createSandboxDeadlineTimer;
  const probe = options.probe ?? probeBuildSandbox;
  const zombieProbeThreshold = options.zombieProbeThreshold ?? SANDBOX_ZOMBIE_PROBE_THRESHOLD;
  const onZombieDetected = options.onZombieDetected ?? requestSandboxZombieRestart;

  const startedAtMs = now();
  const elapsed = () => Math.max(0, now() - startedAtMs);
  let attempts = 0;
  let sawTransient = false;
  let announcedProgress = false;
  let lastCause: string | null = null;
  let lastError: unknown = null;
  // Zombie bookkeeping: consecutive session-death probes only. ANY other
  // failure (transport, 503, timeout) resets it, which is what makes a healthy
  // slow boot structurally incapable of triggering the self-heal.
  let consecutiveSessionDeaths = 0;
  let requestedZombieRestart = false;

  for (;;) {
    // Budget is checked at the top, not only after a probe settles, so a probe
    // that overran its share cannot buy another full probe window.
    const spentMs = elapsed();
    const currentBudgetMs = budgetForCause(lastCause, budgetMs);
    if (attempts > 0 && spentMs >= currentBudgetMs) {
      throw readinessTimeout({
        waitedMs: spentMs,
        attempts,
        budgetMs: currentBudgetMs,
        cause: lastCause,
        error: lastError,
        onEvent: options.onEvent,
      });
    }
    attempts += 1;
    const probeWindowMs = Math.max(1, Math.min(probeTimeoutMs, currentBudgetMs - spentMs));
    try {
      await runProbeWithDeadline(probe, sandbox, probeWindowMs, timer);
      const waitedMs = elapsed();
      const coldStart = sawTransient || waitedMs >= progressAfterMs;
      if (coldStart) {
        options.onEvent?.({ type: "cold_start", waitedMs, attempts, cause: lastCause });
      }
      return { waitedMs, attempts, coldStart };
    } catch (error) {
      if (isProjectBuildStorageMountError(error)) {
        throw new Error(PROJECT_BUILD_STORAGE_MOUNT_MESSAGE, { cause: error });
      }
      if (isProjectBuildPermanentStartupError(error)) {
        const waitedMs = elapsed();
        options.onEvent?.({
          type: "startup_failed",
          waitedMs,
          attempts,
          cause: PERMANENT_STARTUP_CAUSE,
        });
        throw new Error(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE, { cause: error });
      }
      const cause = projectBuildTransientCause(error);
      if (cause === null) throw error;
      sawTransient = true;
      lastCause = cause;
      lastError = error;
      const waitedMs = elapsed();
      if (cause === PROBE_SESSION_DEATH_CAUSE) {
        consecutiveSessionDeaths += 1;
        if (consecutiveSessionDeaths >= zombieProbeThreshold && !requestedZombieRestart) {
          // Once per wait: the DO rate-limits it too, but re-asking every
          // cadence tick would add a DO round trip to each probe for nothing.
          requestedZombieRestart = true;
          const outcome = await onZombieDetected({
            sandbox,
            consecutive: consecutiveSessionDeaths,
            error,
          });
          options.onEvent?.({
            type: "zombie_detected",
            waitedMs,
            attempts,
            cause,
            restarted: outcome?.restarted === true,
          });
        }
      } else {
        consecutiveSessionDeaths = 0;
      }
      const causeBudgetMs = budgetForCause(cause, budgetMs);
      if (waitedMs + probeIntervalMs >= causeBudgetMs) {
        throw readinessTimeout({
          waitedMs,
          attempts,
          budgetMs: causeBudgetMs,
          cause,
          error,
          onEvent: options.onEvent,
        });
      }
      // A re-probe against the same live DO can fail instantly on the poisoned
      // control connection the failed attempt left behind (the SDK's deferred
      // transport latches its failure), so an immediate repeat failure means
      // "still booting", not "a fresh signal" — hence the fixed cadence rather
      // than any backoff keyed on how fast the failure came back.
      if (!announcedProgress && waitedMs >= progressAfterMs) {
        announcedProgress = true;
        options.onProgress?.(PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE);
      }
      await sleep(probeIntervalMs);
    }
  }
}

/**
 * Terminal error for an exhausted budget. A repeated 500 upgrade is a broken
 * container rather than a slow boot, so it gets the operator-facing message and
 * its own telemetry event instead of "temporarily unavailable".
 */
function readinessTimeout(input: {
  waitedMs: number;
  attempts: number;
  budgetMs: number;
  cause: string | null;
  error: unknown;
  onEvent?: (event: ProjectBuildReadinessEvent) => void;
}): Error {
  const notReady = new ProjectBuildSandboxNotReadyError({
    waitedMs: input.waitedMs,
    attempts: input.attempts,
    budgetMs: input.budgetMs,
    cause: input.error,
  });
  if (input.cause === STARTUP_FAILURE_CAUSE) {
    input.onEvent?.({
      type: "startup_failed",
      waitedMs: input.waitedMs,
      attempts: input.attempts,
      cause: STARTUP_FAILURE_CAUSE,
    });
    return new Error(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE, { cause: notReady });
  }
  input.onEvent?.({
    type: "ready_timeout",
    waitedMs: input.waitedMs,
    attempts: input.attempts,
    budgetMs: input.budgetMs,
    cause: input.cause,
  });
  return new Error(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE, { cause: notReady });
}

async function runProbeWithDeadline(
  probe: (sandbox: ProjectBuildSandboxLike) => Promise<unknown>,
  sandbox: ProjectBuildSandboxLike,
  probeWindowMs: number,
  timer: (ms: number) => ProjectBuildProbeDeadline,
): Promise<void> {
  const deadline = timer(probeWindowMs);
  try {
    const probed = probe(sandbox);
    // Keep a late rejection from surfacing as an unhandled rejection once the
    // deadline has already won the race.
    probed.catch(() => {});
    const outcome = await Promise.race([
      probed.then(() => "ready" as const),
      deadline.promise.then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") throw new ProjectBuildProbeTimeoutError(probeWindowMs);
  } finally {
    deadline.cancel();
  }
}

/**
 * Ask the sandbox DO to destroy a zombie container so the next call boots
 * clean. Best-effort in every direction: the DO applies its own cooldown, an
 * older/foreign sandbox shape simply has no such method, and a failure here
 * must never turn a readiness wait into a hard error.
 */
async function requestSandboxZombieRestart(input: {
  sandbox: ProjectBuildSandboxLike;
  consecutive: number;
  error: unknown;
}): Promise<{ restarted?: boolean } | void> {
  const restart = input.sandbox.restartZombieContainer;
  if (typeof restart !== "function") return;
  try {
    const outcome = await input.sandbox.restartZombieContainer?.({
      operation: "readiness_probe",
      trigger: "probe_session_death",
      // Only the text crosses the RPC hop; the Error instance would not.
      error: input.error instanceof Error
        ? `${input.error.name}: ${input.error.message}`
        : String(input.error),
    });
    return { restarted: outcome?.restarted === true };
  } catch (error) {
    console.warn("[project-build] zombie container restart request failed", {
      consecutive: input.consecutive,
      error: error instanceof Error ? error.message : String(error),
    });
    return { restarted: false };
  }
}

/**
 * Prove the container can RUN something, not merely that it answers.
 *
 * Probe order: `probeShell` (a DO entry point that runs the command through the
 * session layer WITHOUT the DO-side zombie self-heal), then `exec`, then
 * `exists`. `exists` used to be first, which is exactly how a zombie passed the
 * gate.
 *
 * Preferring `probeShell` is what keeps `SANDBOX_ZOMBIE_PROBE_THRESHOLD`
 * meaningful: `ProjectBuildSandbox.exec` heals on the FIRST session death,
 * inside the DO, before the rejection crosses back to this worker — so a probe
 * routed through `exec` destroys the container before this loop can count a
 * second consecutive death, and the gate's own escalation would only ever run
 * after the DO's cooldown had already suppressed it. `exec` stays as the
 * fallback for sandbox shapes (older bindings, test fakes) without `probeShell`.
 */
async function probeBuildSandbox(sandbox: ProjectBuildSandboxLike): Promise<unknown> {
  const hasShellProbe = typeof sandbox.probeShell === "function" || typeof sandbox.exec === "function";
  if (!hasShellProbe) {
    if (typeof sandbox.exists !== "function") {
      throw new Error("Project build sandbox exposes no probe surface");
    }
    return sandbox.exists(PROJECT_BUILD_READY_PROBE_PATH);
  }
  // Called THROUGH the sandbox (never a detached/bound reference): these are RPC
  // stub properties, and `this` is what carries the DO call.
  const probeOptions = { cwd: "/", timeout: PROJECT_BUILD_PROBE_COMMAND_TIMEOUT_MS };
  const result = typeof sandbox.probeShell === "function"
    ? await sandbox.probeShell(PROJECT_BUILD_READY_PROBE_COMMAND, probeOptions)
    : await sandbox.exec(PROJECT_BUILD_READY_PROBE_COMMAND, probeOptions);
  const exitCode = result?.exitCode;
  // A missing exitCode is the shape older/mocked sandboxes return on success;
  // only an explicit non-zero is a failed probe.
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new ProjectBuildProbeCommandFailedError(exitCode, result?.stderr);
  }
  return result;
}

/**
 * Backoff for the ladder. Four retries after the first attempt — long enough to
 * ride out a blip on a warm container, short enough that a genuinely broken one
 * surfaces quickly (readiness, not this ladder, is what absorbs a cold boot).
 */
export const PROJECT_BUILD_SERVICE_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

// ---------------------------------------------------------------------------
// Retry ladder for a build-tool call
// ---------------------------------------------------------------------------

/**
 * Retry the operation past transient container failures, mapping the terminal
 * ones onto their user-facing messages.
 *
 * Lives beside the gate (rather than in the tool binding it grew up in) so the
 * admin verify route drives the SAME ladder — a second, subtly different
 * ladder is how the two paths diverged in the first place.
 */
export async function withProjectBuildServiceErrorMapping<T>(
  operationName: string,
  operation: () => Promise<T>,
  hooks: {
    /**
     * Invoked before each retry sleep. The readiness gate re-arms here so
     * attempt 2+ waits for a container that died mid-build instead of running
     * blind against it (the wait stays bounded by one shared cold-boot budget).
     */
    onTransient?: (error: unknown) => void;
    /** Final user-facing message; carries cold-start context when we have it. */
    unavailableMessage?: () => string;
    /**
     * The tool call's shared exec budget. Two jobs here: the backoff sleep is
     * charged OUTSIDE it (waiting is not building), and an exhausted budget
     * ends the ladder — retrying into a spent budget could only start builds we
     * would abandon immediately, and the SDK gives us no way to cancel them.
     */
    deadline?: SandboxExecDeadline;
  } = {},
): Promise<T> {
  const unavailableMessage = () =>
    hooks.unavailableMessage?.() ?? PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isProjectBuildStorageMountError(error)) {
        throw new Error(PROJECT_BUILD_STORAGE_MOUNT_MESSAGE, { cause: error });
      }
      if (!isProjectBuildServiceUnavailableError(error)) throw error;
      // A spent budget is terminal, whatever rung we are on: another attempt
      // could only be dispatched into a sub-slice (or refused outright), and an
      // abandoned build cannot be cancelled — it would overlap the previous one
      // in the SAME per-project workdir. Keep the deadline's own message so the
      // agent shrinks the build instead of being told to try again in a moment.
      if (isSandboxDeadlineExceededError(error) && hooks.deadline?.exhausted !== false) {
        throw error;
      }
      const retryDelayMs = PROJECT_BUILD_SERVICE_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs == null) {
        if (isSandboxDeadlineExceededError(error)) throw error;
        throw new Error(unavailableMessage(), { cause: error });
      }
      hooks.onTransient?.(error);
      console.warn("[project-build] transient service failure; retrying", {
        operation: operationName,
        attempt: attempt + 1,
        maxAttempts: PROJECT_BUILD_SERVICE_RETRY_DELAYS_MS.length + 1,
        retryDelayMs,
        cause: projectBuildTransientCause(error),
        error: error instanceof Error ? error.message : String(error),
      });
      const sleep = () => new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      // Backoff is not build time: charging it to the exec budget would leave
      // the next attempt a slice too small to build in.
      await (hooks.deadline ? hooks.deadline.excluding(sleep) : sleep());
    }
  }
}

// ---------------------------------------------------------------------------
// Readiness gate for one build-tool call
// ---------------------------------------------------------------------------

/**
 * Per-call gate around `ensureBuildSandboxReady`.
 *
 * `ensureReady` is invoked immediately before the first sandbox operation and
 * is memoized so the surrounding retry ladder does not re-wait a full cold-boot
 * budget per attempt. `invalidate` re-arms it after a transient failure, so an
 * attempt that runs against a container which died mid-build waits for the
 * reboot instead of running blind — the cumulative readiness wait across all
 * attempts stays bounded by ONE cold-boot budget.
 *
 * That bound counts WAITING only, not the build in between: an absolute
 * deadline latched on the first call meant a 200s build left attempt 2 a 1ms
 * probe window, which failed instantly as "temporarily unavailable" instead of
 * waiting out the reboot the invalidate was asking for.
 *
 * `annotate` stamps a cold wake onto the tool result so the agent — and through
 * it the user — reads the extra minute as "the environment was starting"
 * instead of retrying into the same boot window; `unavailableMessage` carries
 * the same context onto the failure path.
 *
 * Lives here (not in the tool binding) because the admin verify route runs the
 * same build against the same container and needs the same gate.
 */
export interface ProjectBuildReadinessGate {
  ensureReady: (sandbox: ProjectBuildSandboxLike) => Promise<void>;
  invalidate: () => void;
  annotate: <T>(result: T) => T;
  unavailableMessage: () => string;
}

export function createProjectBuildReadinessGate(
  waitForReady: (
    sandbox: ProjectBuildSandboxLike,
    budgetMs: number,
  ) => Promise<ProjectBuildReadinessResult>,
  options: { budgetMs?: number; now?: () => number } = {},
): ProjectBuildReadinessGate {
  const totalBudgetMs = options.budgetMs ?? PROJECT_BUILD_COLD_START_BUDGET_MS;
  const now = options.now ?? (() => Date.now());
  let pending: Promise<void> | null = null;
  // Sticky across re-arms: a later warm probe must not erase the fact that this
  // tool call already paid for a wake.
  let coldStart: ProjectBuildReadinessResult | null = null;
  // Readiness wall-clock already spent by earlier attempts of THIS call.
  let waitedMs = 0;
  return {
    ensureReady: (sandbox) => (pending ??= (() => {
      const startedAtMs = now();
      const budgetMs = Math.max(0, totalBudgetMs - waitedMs);
      return waitForReady(sandbox, budgetMs)
        .then((result) => {
          if (result.coldStart) coldStart ??= result;
        })
        .finally(() => {
          waitedMs += Math.max(0, now() - startedAtMs);
        });
    })()),
    invalidate: () => {
      pending = null;
    },
    unavailableMessage: () => {
      if (!coldStart) return PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE;
      return `${PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE} ` +
        `The build environment was still starting (waited ${coldStart.waitedMs}ms for it to wake).`;
    },
    annotate: <T,>(result: T): T => {
      if (!coldStart) return result;
      if (!result || typeof result !== "object" || Array.isArray(result)) return result;
      return {
        ...result,
        buildEnvironment: {
          coldStart: true,
          startupMs: coldStart.waitedMs,
          probes: coldStart.attempts,
          message:
            "The build container was asleep and had to start; the extra wait was startup, not the build.",
        },
      };
    },
  };
}

/**
 * Run one build-container operation behind the gate AND the ladder.
 *
 * This is the whole "wait for the container, then retry blips" contract in one
 * call, for callers that do not need the tool binding's streaming/annotation
 * (the admin verify route). deploy_project keeps driving the two pieces
 * directly because it interleaves other work — a notebook branch, a snapshot, a
 * dispatch upload — between them.
 */
export async function runWithProjectBuildReadiness<T>(
  sandbox: ProjectBuildSandboxLike,
  run: () => Promise<T>,
  options: {
    /** Low-cardinality name for logs. */
    operation: string;
    budgetMs?: number;
    onProgress?: (message: string) => void;
    onEvent?: (event: ProjectBuildReadinessEvent) => void;
    deadline?: SandboxExecDeadline;
    /** Test seam, forwarded to ensureBuildSandboxReady. */
    readiness?: Omit<EnsureBuildSandboxReadyOptions, "budgetMs" | "onProgress" | "onEvent">;
  },
): Promise<T> {
  const gate = createProjectBuildReadinessGate(
    (target, budgetMs) => ensureBuildSandboxReady(target, {
      ...options.readiness,
      budgetMs,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    }),
    options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs },
  );
  return gate.annotate(await withProjectBuildServiceErrorMapping(options.operation, async () => {
    // Cold-boot waiting is charged to the gate's own budget, never to the
    // caller's exec deadline: a container that has to wake first must not hand
    // the operation a truncated slice.
    if (options.deadline) await options.deadline.excluding(() => gate.ensureReady(sandbox));
    else await gate.ensureReady(sandbox);
    return run();
  }, {
    onTransient: () => gate.invalidate(),
    unavailableMessage: () => gate.unavailableMessage(),
    ...(options.deadline ? { deadline: options.deadline } : {}),
  }));
}
