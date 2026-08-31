// Client-side deadlines for sandbox exec-class operations.
//
// Every exec-class call in this repo forwards a `timeout` to the container,
// which is the PRIMARY enforcement and produces the better error (it knows the
// exit code and the partial output). But nothing bounded the await on THIS
// side: a wedged container, a hung capnweb call, or a shell that died under the
// command leaves the caller waiting until the 20-minute
// PI_TURN_TOOL_HARD_TIMEOUT backstop fires. Production saw an `analysis_exec`
// declaring `timeoutMs: 120000` occupy a turn for 1,200,000ms.
//
// This module is the upper bound with grace: it never replaces the
// container-side timeout, it only refuses to wait forever for one that failed
// to fire. Inside the grace window the container's own error still wins.
//
// ## What the SDK does and does not give us
//
// `@cloudflare/sandbox` 0.12.0 (`dist/sandbox-*.js`):
//   - `exec(command, { timeout })` forwards `timeoutMs` to the container and
//     the container enforces it ("unlimited by default"), so container-side
//     enforcement is real — this deadline is strictly the outer bound.
//   - `ExecOptions.signal` is checked ONCE before dispatch (and between SSE
//     events on the streaming path). The non-streaming `execWithSession` await
//     is NOT abortable, so passing a signal cannot cancel an in-flight command.
//   - `killProcess`/`killAllProcesses` are sandbox-scoped and operate on the
//     `startProcess` registry; a command run through `exec` has no process id
//     and is not reachable from them, and the analysis/build containers are
//     shared per workspace/org, so a blanket kill would take out unrelated
//     concurrent work.
// There is therefore NO safe per-exec cancellation surface to fire on a
// deadline or an abort. The abandoned command stays bounded by the timeout the
// container already holds. Re-check this when the SDK is upgraded.

/**
 * Cancellable deadline for one awaited operation; the seam tests replace to
 * drive deadlines without real timers. Shared with the build-readiness gate's
 * per-probe deadline (project-build-readiness.ts), which has the same shape.
 */
export interface SandboxDeadlineTimer {
  promise: Promise<void>;
  cancel: () => void;
}

export function createSandboxDeadlineTimer(ms: number): SandboxDeadlineTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * Slack beyond the operation's own budget, for marshalling the result of a
 * command the container timed out PROPERLY. Sized so the container-side error
 * (which carries the exit code and output) still wins a close race.
 */
export const SANDBOX_EXEC_DEADLINE_GRACE_MS = 15_000;

/**
 * Distinct failure for "we stopped waiting", never for "the command failed".
 * The message mirrors the PI_TURN_TOOL_TIMEOUT_MESSAGE tone: say what the
 * budget was, tell the agent to shrink the work, make clear the turn survives.
 *
 * `started: false` is the budget-exhausted refusal — we never dispatched, so
 * the agent can retry freely. `started: true` means the work WAS dispatched and
 * we have no cancellation surface (see the module header): the command may have
 * completed, and its side effects may still be landing, so the agent must be
 * told not to blind-retry something non-idempotent.
 */
export class SandboxDeadlineExceededError extends Error {
  readonly operation: string;
  readonly declaredTimeoutMs: number | undefined;
  readonly budgetMs: number;
  readonly waitedMs: number;
  /** False when the budget was already spent and we refused to dispatch. */
  readonly started: boolean;

  constructor(input: {
    operation: string;
    declaredTimeoutMs: number | undefined;
    budgetMs: number;
    waitedMs: number;
    started?: boolean;
  }) {
    const started = input.started !== false;
    super(
      `${input.operation} did not return within its ${Math.round(input.budgetMs / 1000)}s budget ` +
      `(declared timeout ${input.declaredTimeoutMs == null ? "default" : `${input.declaredTimeoutMs}ms`}) ` +
      (started
        ? `and was abandoned. It may already have run to completion in the sandbox — file writes, ` +
          `installs and database changes it started can still be landing — so do NOT simply repeat it ` +
          `unless it is safe to run twice; check the resulting state first. `
        : `and was NOT started: the budget for this tool call was already spent. Nothing ran. `) +
      `Try a smaller scope, a shorter command, or a different approach — the turn is still active.`,
    );
    this.name = "SandboxDeadlineExceededError";
    this.operation = input.operation;
    this.declaredTimeoutMs = input.declaredTimeoutMs;
    this.budgetMs = input.budgetMs;
    this.waitedMs = input.waitedMs;
    this.started = started;
  }
}

export function isSandboxDeadlineExceededError(error: unknown): boolean {
  if (error instanceof SandboxDeadlineExceededError) return true;
  // Survives an RPC hop, where only name/message are preserved.
  return error instanceof Error && error.name === "SandboxDeadlineExceededError";
}

/** Same clamp analysis-service applies before forwarding a timeout container-side. */
export function clampSandboxTimeoutMs(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

export interface SandboxDeadlineExceededEvent {
  operation: string;
  declaredTimeoutMs: number | undefined;
  budgetMs: number;
  waitedMs: number;
  /** False when the budget was spent and we refused to dispatch the work. */
  started?: boolean;
}

/**
 * Smallest slice of budget worth dispatching work into.
 *
 * Below this, `run` refuses to start rather than launching a command it will
 * abandon milliseconds later. That matters because there is NO cancellation
 * surface (module header): a 1ms slice used to start a real `bun install &&
 * bun run build` into the shared per-project workdir and then walk away, so a
 * retry ladder could stack several of them on top of each other.
 */
export const SANDBOX_EXEC_DEADLINE_MIN_SLICE_MS = 1_000;

export interface SandboxExecDeadlineOptions {
  /** Low-cardinality operation name; used in the error, logs and telemetry. */
  operation: string;
  /** Agent-declared timeout, unclamped and untrusted. */
  declaredTimeoutMs?: number | undefined;
  /** Op-class default when nothing was declared (an existing repo constant). */
  defaultTimeoutMs: number;
  /** Op-class ceiling (an existing repo constant). */
  maxTimeoutMs: number;
  /**
   * Wall-clock the operation legitimately spends OUTSIDE the timed command:
   * materializing the source tree in, persisting the changed set out, fixed
   * secondary commands. Without it the deadline would cut short work the
   * declared timeout was never meant to cover.
   */
  overheadMs?: number;
  graceMs?: number;
  onExceeded?: (event: SandboxDeadlineExceededEvent) => void;
  /** Test seams. */
  now?: () => number;
  timer?: (ms: number) => SandboxDeadlineTimer;
}

export interface SandboxExecDeadline {
  /** Total wall-clock this deadline will allow, across all `run` calls. */
  readonly budgetMs: number;
  /** Budget left for further `run` calls; the full budget before the first. */
  readonly remainingMs: number;
  /**
   * True once the budget is gone. A caller with a retry ladder must treat this
   * as terminal: every further `run` refuses to dispatch.
   */
  readonly exhausted: boolean;
  /**
   * Run `fn` under the REMAINING budget. The budget clock starts on the first
   * call and is shared by later ones, so a retry ladder around one tool call
   * cannot multiply the wait by its attempt count.
   *
   * Refuses to dispatch (throws `SandboxDeadlineExceededError` with
   * `started: false`) once less than SANDBOX_EXEC_DEADLINE_MIN_SLICE_MS is
   * left, because an abandoned command cannot be cancelled.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run `fn` OUTSIDE the budget: the deadline moves forward by however long it
   * took. For wall-clock the exec budget was never meant to cover — waiting for
   * a cold container to boot, a retry ladder's backoff sleep — which would
   * otherwise silently eat the command's own time. The excluded work must carry
   * its OWN bound (the readiness gate and the ladder both do), or total
   * wall-clock stops being capped.
   */
  excluding<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSandboxExecDeadline(
  options: SandboxExecDeadlineOptions,
): SandboxExecDeadline {
  const now = options.now ?? (() => Date.now());
  const timer = options.timer ?? createSandboxDeadlineTimer;
  const declaredTimeoutMs =
    typeof options.declaredTimeoutMs === "number" && Number.isFinite(options.declaredTimeoutMs)
      ? options.declaredTimeoutMs
      : undefined;
  const budgetMs =
    clampSandboxTimeoutMs(declaredTimeoutMs, options.defaultTimeoutMs, options.maxTimeoutMs) +
    (options.overheadMs ?? 0) +
    (options.graceMs ?? SANDBOX_EXEC_DEADLINE_GRACE_MS);
  let deadlineAtMs: number | null = null;
  let exhausted = false;
  // A budget smaller than the floor (only reachable from a test-sized budget)
  // must still get one real attempt.
  const minSliceMs = Math.min(SANDBOX_EXEC_DEADLINE_MIN_SLICE_MS, budgetMs);

  return {
    budgetMs,
    get remainingMs(): number {
      if (deadlineAtMs === null) return budgetMs;
      return Math.max(0, deadlineAtMs - now());
    },
    get exhausted(): boolean {
      return exhausted;
    },
    async excluding<T>(fn: () => Promise<T>): Promise<T> {
      const startedAtMs = now();
      try {
        return await fn();
      } finally {
        // Before the first `run` there is no clock to push; the budget starts
        // whole when the first command is actually dispatched.
        if (deadlineAtMs !== null) deadlineAtMs += Math.max(0, now() - startedAtMs);
      }
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      deadlineAtMs ??= now() + budgetMs;
      const startedAtMs = now();
      const remainingMs = deadlineAtMs - startedAtMs;
      if (exhausted || remainingMs < minSliceMs) {
        // Do NOT invoke `fn`: there is no way to cancel what it starts, so a
        // sub-slice dispatch would leave a real command running in the shared
        // workdir with nobody awaiting it.
        const event: SandboxDeadlineExceededEvent = {
          operation: options.operation,
          declaredTimeoutMs,
          budgetMs,
          waitedMs: 0,
          started: false,
        };
        // Telemetry once per deadline: a ladder re-entering an already-spent
        // budget must not multiply the metric or poison its duration histogram.
        if (!exhausted) {
          exhausted = true;
          options.onExceeded?.(event);
        }
        throw new SandboxDeadlineExceededError(event);
      }
      const deadline = timer(remainingMs);
      try {
        const work = Promise.resolve().then(fn);
        // The abandoned promise must stay observed: workerd reports a late
        // rejection on a promise nobody is awaiting as an unhandled rejection,
        // which fails vitest's strict default.
        work.catch(() => {});
        const outcome = await Promise.race([
          work.then((value) => ({ kind: "value" as const, value })),
          deadline.promise.then(() => ({ kind: "deadline" as const })),
        ]);
        if (outcome.kind === "value") return outcome.value;
        const event: SandboxDeadlineExceededEvent = {
          operation: options.operation,
          declaredTimeoutMs,
          budgetMs,
          waitedMs: Math.max(0, now() - startedAtMs),
          started: true,
        };
        exhausted = true;
        options.onExceeded?.(event);
        throw new SandboxDeadlineExceededError(event);
      } finally {
        deadline.cancel();
      }
    },
  };
}
