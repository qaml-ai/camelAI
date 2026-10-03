// Bounded, retried container starts for the three sandbox Durable Objects
// (DbQueryContainer, AnalysisContainer, ProjectBuildContainer).
//
// A cold start on the native container API is `ctx.container.start()` (which
// returns at once) followed by the first command, which blocks until the
// container runs. Nothing in the API reports progress: there is no image-pull
// phase, no "starting" state, only `running` (true as soon as start() returns)
// and `monitor()` (settles when the container exits). So a start that will
// never finish and one that is slowly pulling an image look the same.
//
// Prod, Oct 2026 (Sandbox SDK 1.0): healthy starts take 2-5s (analysis, setup
// included) and 4-17s (db-query, first query included); a fresh image right
// after a deploy took up to 220s. Two failure modes: a start whose first
// command never answers (one db-query start held 6 queries for the full 135s
// client budget), and starts that fail after ~45-55s with "The container
// connection is temporarily unavailable" (one workspace looped on that for ten
// minutes). In both, a fresh container started straight after served within
// seconds.
//
// So each attempt gets a short budget, a stuck or failed attempt is destroyed
// and retried once, and everything runs inside the DO's shared start promise,
// so every caller waiting on that start gets the retried container. The one
// allowance for a slow pull: when this DO has never started the current image,
// the RETRY gets a long budget. The first attempt stays short, so a start stuck
// for other reasons is still replaced quickly; a genuine pull keeps running on
// the host and the retry finds it further along.

import { errorToObservabilityFields, recordObservabilityEvent } from "./observability.js";
import { createSandboxDeadlineTimer, type SandboxDeadlineTimer } from "./sandbox-exec-deadline.js";

export interface ContainerStartPolicy {
  /** One attempt: container start through readiness (and, for analysis, setup). */
  readonly attemptMs: number;
  /**
   * The retry's budget when this DO has never started the current image: a
   * host may be pulling it. Healthy post-deploy pulls took up to 220s, and the
   * retry starts after at least `attemptMs` of that has passed.
   */
  readonly freshImageRetryMs: number;
  /** Bound on destroying the stuck container between attempts (prod: up to 45s). */
  readonly destroyMs: number;
}

/** db-query: healthy cold start + first query 4-17s, so 30s is about 2x p99. */
export const DB_QUERY_START_POLICY: ContainerStartPolicy = {
  attemptMs: 30_000,
  freshImageRetryMs: 180_000,
  destroyMs: 60_000,
};

/**
 * analysis: healthy start + mounts/egress/CA setup p50 2.3s, p99 5s outside
 * deploys; 17s during the post-deploy burst. 45s also covers the one 57s
 * outlier's likely cause (a pull on a new host) via the retry.
 */
export const ANALYSIS_START_POLICY: ContainerStartPolicy = {
  attemptMs: 45_000,
  freshImageRetryMs: 180_000,
  destroyMs: 60_000,
};

/** project build: measured cold starts 13-20s, so 45s is 2-3x. */
export const PROJECT_BUILD_START_POLICY: ContainerStartPolicy = {
  attemptMs: 45_000,
  freshImageRetryMs: 180_000,
  destroyMs: 60_000,
};

/**
 * The longest a start can take inside the DO with this policy: an attempt, the
 * destroy, and the (possibly fresh-image) retry. Client-side deadlines around
 * a start sit above this, so the DO's own bound is the one that fires.
 */
export function containerStartWorstCaseMs(policy: ContainerStartPolicy): number {
  return policy.attemptMs + policy.destroyMs + Math.max(policy.attemptMs, policy.freshImageRetryMs);
}

/** DO storage key: the image this DO last started successfully. */
export const LAST_STARTED_IMAGE_KEY = "container-last-started-image";

/** One attempt outlived its budget. */
export class ContainerStartTimeoutError extends Error {
  readonly budgetMs: number;

  constructor(budgetMs: number) {
    super(`The container did not become ready within ${Math.round(budgetMs / 1000)}s`);
    this.name = "ContainerStartTimeoutError";
    this.budgetMs = budgetMs;
  }
}

/**
 * The start failed after its retry (or failed in a way no retry fixes).
 * Nothing the caller asked for ran. Thrown inside the DO; a DO RPC hop delivers
 * a plain Error whose message starts with the name, so callers use `is()`.
 */
export class ContainerStartFailedError extends Error {
  static is(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === "ContainerStartFailedError" || error.message.startsWith("ContainerStartFailedError: ");
  }

  readonly attempts: number;
  readonly waitedMs: number;
  /** No retry fixes it (the image or the application is missing). */
  readonly permanent: boolean;

  constructor(input: { label: string; attempts: number; waitedMs: number; permanent: boolean; cause: unknown }) {
    const detail = input.cause instanceof Error ? input.cause.message : String(input.cause);
    const seconds = Math.max(1, Math.round(input.waitedMs / 1000));
    super(
      input.permanent
        ? `The ${input.label} could not start: ${detail}. Nothing ran. Retrying will not help; this needs operator attention.`
        : `The ${input.label} did not start (${input.attempts === 1 ? "1 attempt" : `${input.attempts} attempts, the stuck one replaced`}, ${seconds}s; last error: ${detail}). ` +
            `Nothing ran. This is a temporary infrastructure problem, not a problem with the request; ` +
            `retrying the same call in a minute is safe.`,
      { cause: input.cause },
    );
    this.name = "ContainerStartFailedError";
    this.attempts = input.attempts;
    this.waitedMs = input.waitedMs;
    this.permanent = input.permanent;
  }
}

/** Failures no retry fixes: the image or the container application is missing. */
const PERMANENT_START_PATTERNS: readonly RegExp[] = [
  /no such image/i,
  /no application that matches/i,
  /no container application assigned/i,
  /container binding is not configured/i,
];

export function isPermanentContainerStartError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return PERMANENT_START_PATTERNS.some((pattern) => pattern.test(text));
}

export type ContainerStartEvent =
  | { type: "attempt_failed"; attempt: number; durationMs: number; budgetMs: number; timedOut: boolean; error: unknown }
  | { type: "started"; attempts: number; durationMs: number; freshImage: boolean }
  | { type: "failed"; attempts: number; durationMs: number; error: unknown };

export interface StartWithRetryOptions {
  policy: ContainerStartPolicy;
  /** Shown to the agent: "database query environment", "analysis environment". */
  label: string;
  /** This DO has never started the current image, so the retry may wait for a pull. */
  freshImage: boolean;
  /**
   * Start the container and wait until it is ready. `signal` aborts when the
   * attempt's budget runs out; pass it to exec() so a hung probe is released.
   */
  attempt: (signal: AbortSignal) => Promise<void>;
  /** Destroy whatever the failed attempt left behind. */
  reset: () => Promise<void>;
  onEvent?: (event: ContainerStartEvent) => void;
  /** Test seams. */
  timer?: (ms: number) => SandboxDeadlineTimer;
  now?: () => number;
}

/**
 * Run `attempt` under the policy's budget; on a timeout or a non-permanent
 * failure, `reset` (bounded) and run it exactly once more. Throws
 * ContainerStartFailedError when it gives up.
 */
export async function startWithRetry(options: StartWithRetryOptions): Promise<{ attempts: number; durationMs: number }> {
  const timer = options.timer ?? createSandboxDeadlineTimer;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const budgets = [
    options.policy.attemptMs,
    options.freshImage ? Math.max(options.policy.attemptMs, options.policy.freshImageRetryMs) : options.policy.attemptMs,
  ];

  let lastError: unknown = null;
  for (let index = 0; index < budgets.length; index += 1) {
    const attempt = index + 1;
    const attemptStartedAt = now();
    const budgetMs = budgets[index];
    try {
      await runBounded((signal) => options.attempt(signal), budgetMs, timer);
      const durationMs = now() - startedAt;
      options.onEvent?.({ type: "started", attempts: attempt, durationMs, freshImage: options.freshImage });
      return { attempts: attempt, durationMs };
    } catch (error) {
      lastError = error;
      const timedOut = error instanceof ContainerStartTimeoutError;
      options.onEvent?.({
        type: "attempt_failed",
        attempt,
        durationMs: now() - attemptStartedAt,
        budgetMs,
        timedOut,
        error,
      });
      const permanent = !timedOut && isPermanentContainerStartError(error);
      // Destroy even before giving up, so the next call starts clean instead of
      // probing the same stuck container.
      let resetOk = true;
      try {
        await runBounded(() => options.reset(), options.policy.destroyMs, timer);
      } catch (resetError) {
        resetOk = false;
        console.warn("[container-start] destroying a failed start did not finish", {
          label: options.label,
          error: resetError instanceof Error ? resetError.message : String(resetError),
        });
      }
      // A destroy that did not finish leaves the old container in place: a
      // retry would only probe it again.
      if (permanent || !resetOk || attempt === budgets.length) {
        const durationMs = now() - startedAt;
        options.onEvent?.({ type: "failed", attempts: attempt, durationMs, error });
        throw new ContainerStartFailedError({
          label: options.label,
          attempts: attempt,
          waitedMs: durationMs,
          permanent,
          cause: error,
        });
      }
    }
  }
  // Unreachable: the loop returns or throws.
  throw lastError;
}

/**
 * Telemetry for a start: `sandbox_start_ready` (durationMs, count = attempts,
 * status "fresh_image" or "cached_image"), `sandbox_start_attempt_failed`
 * (status "timeout" or "error", size = the attempt's budget) and
 * `sandbox_start_failed`. `component` is the container class.
 */
export function recordContainerStartEvent(
  env: Parameters<typeof recordObservabilityEvent>[0],
  event: ContainerStartEvent,
  scope: { component: string; workspaceId?: string | null; orgId?: string | null },
): void {
  const base = {
    component: scope.component,
    operation: "startContainer",
    workspaceId: scope.workspaceId ?? null,
    orgId: scope.orgId ?? null,
  };
  switch (event.type) {
    case "started":
      recordObservabilityEvent(env, {
        ...base,
        event: "sandbox_start_ready",
        severity: event.attempts > 1 ? "warn" : "info",
        status: event.freshImage ? "fresh_image" : "cached_image",
        durationMs: event.durationMs,
        count: event.attempts,
      });
      return;
    case "attempt_failed":
      recordObservabilityEvent(env, {
        ...base,
        event: "sandbox_start_attempt_failed",
        severity: "warn",
        status: event.timedOut ? "timeout" : "error",
        durationMs: event.durationMs,
        count: event.attempt,
        size: event.budgetMs,
        ...errorToObservabilityFields(event.error),
      });
      return;
    case "failed":
      recordObservabilityEvent(env, {
        ...base,
        event: "sandbox_start_failed",
        severity: "error",
        status: "failed",
        durationMs: event.durationMs,
        count: event.attempts,
        ...errorToObservabilityFields(event.error),
      });
      return;
  }
}

async function runBounded(
  run: (signal: AbortSignal) => Promise<void>,
  budgetMs: number,
  timer: (ms: number) => SandboxDeadlineTimer,
): Promise<void> {
  const controller = new AbortController();
  const deadline = timer(budgetMs);
  try {
    const running = run(controller.signal);
    // A late rejection (the container destroyed under the abandoned attempt)
    // must not surface as an unhandled rejection.
    running.catch(() => {});
    const outcome = await Promise.race([
      running.then(() => "done" as const),
      deadline.promise.then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") {
      controller.abort(new ContainerStartTimeoutError(budgetMs));
      throw new ContainerStartTimeoutError(budgetMs);
    }
  } finally {
    deadline.cancel();
  }
}
