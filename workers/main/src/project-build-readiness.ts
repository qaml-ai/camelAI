// Boot-aware readiness gate for the per-org build container
// (ProjectBuildContainer).
//
// The build container stops after its idle window, and starting it again takes
// far longer than the deploy_project retry ladder (~15s) spans. A deploy landing
// on a stopped container used to burn every attempt inside the boot and surface
// "Build service temporarily unavailable" to the user, who then retried straight
// back into the same boot.
//
// This module waits for the container ONCE per build-tool call: a cheap probe
// command (`true`) that starts the container if needed, re-probed on a gentle
// cadence within a budget. The retry ladder stays as the guard for blips on a
// running container, and runs after readiness.
//
// A permanent startup failure (isProjectBuildPermanentStartupError) never
// waits: retrying cannot help, so it fails fast with its own terminal message.
import { ProjectBuildContainerUnavailableError } from "./project-build-contracts.js";
import {
  createSandboxDeadlineTimer,
  isSandboxDeadlineExceededError,
  type SandboxDeadlineTimer,
  type SandboxExecDeadline,
} from "./sandbox-exec-deadline.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

/** Cold-boot budget: how long one tool call waits for the container overall. */
export const PROJECT_BUILD_COLD_START_BUDGET_MS = 240_000;

/**
 * Per-probe deadline. A probe on a stopped container blocks while it boots, so
 * this sits well above a normal boot; it only stops a call that never returns
 * from holding the whole budget. Always further clamped to the remaining
 * cold-start budget.
 */
export const PROJECT_BUILD_PROBE_TIMEOUT_MS = 180_000;

/** Gentle re-probe cadence while the container boots. */
export const PROJECT_BUILD_READY_PROBE_INTERVAL_MS = 1_500;
/** Report "still starting" progress once a wait crosses this threshold. */
export const PROJECT_BUILD_READY_PROGRESS_AFTER_MS = 5_000;
/** Progress text shown while the container boots. */
export const PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE =
  "Build environment is starting…";

export const PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE =
  "Build service temporarily unavailable. Please try again in a moment.";
export const PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE =
  "Build environment failed to start and will not recover on retry. " +
  "This needs operator attention: check the build container configuration (image, instance limits) and its logs.";

/** The probe command: no output, no filesystem effect. */
const PROJECT_BUILD_READY_PROBE_COMMAND = "true";

/**
 * Container-side bound on the probe command. The per-probe deadline has to stay
 * long enough for a boot to complete inside one call, so it cannot also bound a
 * shell that accepted the command and never answered; this does, container-side.
 */
export const PROJECT_BUILD_PROBE_COMMAND_TIMEOUT_MS = 15_000;

/** Low-cardinality cause for a permanent startup failure. */
const PERMANENT_STARTUP_CAUSE = "container_startup_permanent";

/**
 * Startup failures that no retry fixes: the build image is missing from the
 * deployment (ProjectBuildContainer's own "no such image", or the platform's),
 * or the Worker has no container application for the class.
 */
const PERMANENT_STARTUP_PATTERNS = [
  /no such image/i,
  /no application that matches/i,
  /no container application assigned/i,
] as const;

/**
 * Terminal container-startup failure. Checked before the transient
 * classification so a broken build container fails fast instead of re-probing
 * for the whole budget.
 */
export function isProjectBuildPermanentStartupError(error: unknown): boolean {
  const message = errorText(error);
  return PERMANENT_STARTUP_PATTERNS.some((pattern) => pattern.test(message));
}

export function isProjectBuildServiceUnavailableError(error: unknown): boolean {
  return projectBuildTransientCause(error) !== null;
}

/**
 * Name the transient failure mode so retry/readiness logs and telemetry carry a
 * low-cardinality cause instead of a raw message. Returns null when the error is
 * not transient — including the permanent startup class, so the surrounding
 * retry ladder stops retrying it too.
 */
export function projectBuildTransientCause(error: unknown): string | null {
  if (error instanceof ProjectBuildProbeTimeoutError) return "probe_timeout";
  // The probe ran but `true` exited non-zero: the container answers, its
  // executor is not healthy yet.
  if (error instanceof ProjectBuildProbeCommandFailedError) return "probe_command_failed";
  // A build we abandoned on its client-side deadline: the container is wedged
  // (its own timeout should have fired and did not).
  //
  // It is transient in CLASSIFICATION only. The ladder stops on it as soon as
  // the shared exec budget is spent — which a deadline exceedance means by
  // definition — because an abandoned build cannot be cancelled and a further
  // attempt would run concurrently with it in the same per-project workdir. The
  // terminal path surfaces the deadline's own message rather than the generic
  // "temporarily unavailable" one.
  if (isSandboxDeadlineExceededError(error)) return "exec_deadline_exceeded";
  if (isProjectBuildPermanentStartupError(error)) return null;
  // The container failed to start or stopped under the call; the next call
  // starts a fresh one.
  if (ProjectBuildContainerUnavailableError.is(error)) return "container_unavailable";
  // The Durable Object call itself failed in a way the runtime marks as safe to
  // retry (the DO was reset by a deploy, or the connection to it was lost).
  if (isRetryableDurableObjectError(error)) return "durable_object_retryable";
  return null;
}

function isRetryableDurableObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as { retryable?: unknown }).retryable === true || /Network connection lost/i.test(error.message);
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? `${error.name}: ${error.message}` : error);
}

/**
 * The probe command came back non-zero. Distinct from a thrown error: the
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

/** Telemetry event name for a readiness event (tool binding and admin route). */
export function projectBuildReadinessEventName(event: ProjectBuildReadinessEvent): string {
  switch (event.type) {
    case "cold_start":
      return "build_sandbox_cold_start";
    case "startup_failed":
      return "build_sandbox_startup_failed";
    case "ready_timeout":
      return "build_sandbox_ready_timeout";
  }
}

export interface ProjectBuildReadinessResult {
  /** Wall-clock ms spent waiting for the container, including the last probe. */
  waitedMs: number;
  /** Probe count; 1 on the warm path. */
  attempts: number;
  /**
   * True when the container was not immediately available: either a probe
   * failed transiently, or the wait crossed the progress threshold (a probe on
   * a stopped container blocks while it boots, so a slow first probe is a cold
   * start even though nothing was thrown).
   */
  coldStart: boolean;
}

/**
 * Cancellable deadline for a single probe; the test seam for probe timeouts.
 * Same shape (and default implementation) as the exec-class deadline in
 * sandbox-exec-deadline.ts.
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
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timer?: (ms: number) => ProjectBuildProbeDeadline;
  probe?: (sandbox: ProjectBuildSandboxLike) => Promise<unknown>;
}

/**
 * Wait until the build container runs a probe command.
 *
 * Warm path: exactly one probe, no event, no added delay. Cold path: re-probe
 * every probeIntervalMs until the container answers or budgetMs is exhausted,
 * with every probe bounded by its own deadline so a hung call cannot outlive
 * the budget. A permanent startup failure is terminal immediately.
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

  const startedAtMs = now();
  const elapsed = () => Math.max(0, now() - startedAtMs);
  let attempts = 0;
  let sawTransient = false;
  let announcedProgress = false;
  let lastCause: string | null = null;
  let lastError: unknown = null;

  for (;;) {
    // Budget is checked at the top, not only after a probe settles, so a probe
    // that overran its share cannot buy another full probe window.
    const spentMs = elapsed();
    if (attempts > 0 && spentMs >= budgetMs) {
      throw readinessTimeout({ waitedMs: spentMs, attempts, budgetMs, cause: lastCause, error: lastError, onEvent: options.onEvent });
    }
    attempts += 1;
    const probeWindowMs = Math.max(1, Math.min(probeTimeoutMs, budgetMs - spentMs));
    try {
      await runProbeWithDeadline(probe, sandbox, probeWindowMs, timer);
      const waitedMs = elapsed();
      const coldStart = sawTransient || waitedMs >= progressAfterMs;
      if (coldStart) {
        options.onEvent?.({ type: "cold_start", waitedMs, attempts, cause: lastCause });
      }
      return { waitedMs, attempts, coldStart };
    } catch (error) {
      if (isProjectBuildPermanentStartupError(error)) {
        options.onEvent?.({ type: "startup_failed", waitedMs: elapsed(), attempts, cause: PERMANENT_STARTUP_CAUSE });
        throw new Error(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE, { cause: error });
      }
      const cause = projectBuildTransientCause(error);
      if (cause === null) throw error;
      sawTransient = true;
      lastCause = cause;
      lastError = error;
      const waitedMs = elapsed();
      if (waitedMs + probeIntervalMs >= budgetMs) {
        throw readinessTimeout({ waitedMs, attempts, budgetMs, cause, error, onEvent: options.onEvent });
      }
      if (!announcedProgress && waitedMs >= progressAfterMs) {
        announcedProgress = true;
        options.onProgress?.(PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE);
      }
      await sleep(probeIntervalMs);
    }
  }
}

/** Terminal error for an exhausted budget. */
function readinessTimeout(input: {
  waitedMs: number;
  attempts: number;
  budgetMs: number;
  cause: string | null;
  error: unknown;
  onEvent?: (event: ProjectBuildReadinessEvent) => void;
}): Error {
  input.onEvent?.({
    type: "ready_timeout",
    waitedMs: input.waitedMs,
    attempts: input.attempts,
    budgetMs: input.budgetMs,
    cause: input.cause,
  });
  return new Error(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE, {
    cause: new ProjectBuildSandboxNotReadyError({
      waitedMs: input.waitedMs,
      attempts: input.attempts,
      budgetMs: input.budgetMs,
      cause: input.error,
    }),
  });
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

/** Prove the container can RUN something, which also starts a stopped one. */
async function probeBuildSandbox(sandbox: ProjectBuildSandboxLike): Promise<unknown> {
  const result = await sandbox.exec(PROJECT_BUILD_READY_PROBE_COMMAND, {
    cwd: "/",
    timeout: PROJECT_BUILD_PROBE_COMMAND_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) throw new ProjectBuildProbeCommandFailedError(result.exitCode, result.stderr);
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
     * would abandon immediately, and an abandoned build cannot be cancelled.
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
