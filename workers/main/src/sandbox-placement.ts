// Placement rotation for the three sandbox Durable Objects (AnalysisContainer,
// DbQueryContainer, ProjectBuildContainer).
//
// Prod, Oct 2026: twice, one workspace's sandbox DO failed every container
// start with "The container connection is temporarily unavailable" for 4-10
// minutes while every other workspace started fine (DbQuery 10-01, Analysis
// 10-02). container-start.ts bounds and retries each start, but the retry runs
// in the same DO and lands on the same bad placement. A container is placed
// with its Durable Object, so the way out is a new DO identity.
//
// So a sandbox's DO name carries a generation: `<base>` is generation 0 (the
// name every sandbox had before this), `<base>-g<N>` is generation N. When a
// generation fails STARTS_TO_ROTATE whole starts (each already retried once)
// within FAILURE_WINDOW_MS, with no successful start between them, it asks
// generation 0 to move the sandbox to the next generation. Generation 0 is the
// registry: it holds the current generation in its storage, bounds rotations to
// MAX_ROTATIONS per ROTATION_WINDOW_MS, and records `sandbox_placement_rotated`.
//
// Routing: callers always address generation 0 first, through
// followSandboxGeneration(). A DO whose generation is no longer current refuses
// every call with SandboxRelocatedError (before doing anything), and the caller
// re-sends the same call to the generation it names. So every caller moves at
// once, and the common case (never rotated) costs nothing extra. A rotated
// sandbox costs one cheap DO hop per caller stub; the old generation runs no
// container while it redirects.
//
// What a rotation loses is only what a container restart (or an idle timeout)
// already loses; nothing in these DOs is a source of truth:
//   - Analysis: materialized project trees, per-project venvs and pip/uv caches
//     in the container (re-created from the project store and the baked image);
//     the stored setup and last-started image (re-derived on the next start).
//     Uploads, outputs and exports live in R2 and are mounted, never copied.
//   - DbQuery: the relay forwarder process (started on demand per query) and
//     the export mount; credentials arrive with each call, nothing is stored.
//   - ProjectBuild: the build cache (a cold build); source comes from the
//     project store. The warm-session deadline restarts with the next build.
// The old generation's container is destroyed best-effort when it rotates (its
// start had already failed, so there is rarely one), and the DO idles out; its
// storage keeps only the redirect.

import { ContainerStartFailedError } from "./container-start.js";
import { recordObservabilityEvent } from "./observability.js";

/** Whole failed starts (each already retried once) that rotate a placement. */
export const STARTS_TO_ROTATE = 2;
/** The failed starts must fall within this window. */
export const FAILURE_WINDOW_MS = 10 * 60_000;
/** At most this many rotations per sandbox per ROTATION_WINDOW_MS. */
export const MAX_ROTATIONS = 3;
export const ROTATION_WINDOW_MS = 60 * 60_000;
/** Redirects a caller follows for one call before giving up. */
const MAX_REDIRECTS = 4;

/**
 * DO storage. In generation 0 it is the registry (current generation and the
 * recent rotation times); in a later generation it is set once that generation
 * is retired and says where the sandbox went.
 */
export const PLACEMENT_KEY = "sandbox-placement";
/** DO storage: this generation's recent failed starts (epoch ms), cleared by a successful one. */
export const START_FAILURES_KEY = "sandbox-start-failures";

export type SandboxComponent = "AnalysisContainer" | "DbQueryContainer" | "ProjectBuildContainer";

interface PlacementRecord {
  generation: number;
  /** Epoch ms of recent rotations (generation 0 only). */
  rotatedAt: number[];
}

export interface RotationRequest {
  /** The generation whose starts failed. */
  fromGeneration: number;
  /** Why: "start_failures". */
  reason: string;
  /** The last start error, for the event. */
  detail?: string;
}

export interface RotationResult {
  /** The current generation after the request. */
  generation: number;
  rotated: boolean;
  /** The rotation bound refused it. */
  limited: boolean;
}

/** The generation-0 DO's registry method, implemented by all three classes. */
export interface SandboxPlacementRegistry {
  rotateSandboxPlacement(request: RotationRequest): Promise<RotationResult>;
}

/** The DO name of `base` at `generation`. */
export function sandboxGenerationName(base: string, generation: number): string {
  return generation > 0 ? `${base}-g${generation}` : base;
}

/** Splits a DO name into its base and generation; a name without `-g<N>` is generation 0. */
export function parseSandboxGenerationName(name: string): { base: string; generation: number } {
  const match = /^(.+)-g([1-9]\d{0,5})$/.exec(name);
  return match ? { base: match[1], generation: Number(match[2]) } : { base: name, generation: 0 };
}

/**
 * This DO is not the sandbox's current generation. Thrown before a call does
 * anything, so re-sending the call to `generation` is always safe. A DO RPC hop
 * delivers a plain Error whose message starts with the name, so callers use
 * generationOf().
 */
export class SandboxRelocatedError extends Error {
  static generationOf(error: unknown): number | null {
    if (!(error instanceof Error)) return null;
    if (error instanceof SandboxRelocatedError) return error.generation;
    const match = /SandboxRelocatedError: the sandbox moved to generation (\d+)/.exec(error.message);
    return match ? Number(match[1]) : null;
  }

  readonly generation: number;

  constructor(generation: number) {
    super(`SandboxRelocatedError: the sandbox moved to generation ${generation}`);
    this.name = "SandboxRelocatedError";
    this.generation = generation;
  }
}

/**
 * A stub for the sandbox whose generation-N stub `open(N)` returns, that sends
 * each call to the current generation: it starts at generation 0 and follows
 * SandboxRelocatedError. Every member read is treated as an RPC method.
 */
export function followSandboxGeneration<T extends object>(open: (generation: number) => T): T {
  let generation = 0;
  let current = open(0);
  return new Proxy({} as T, {
    get(_target, property) {
      // Not a thenable, not inspectable: only string-named methods are forwarded.
      if (typeof property !== "string" || property === "then") return undefined;
      return async (...args: unknown[]) => {
        for (let redirects = 0; ; redirects += 1) {
          try {
            // Called as a method, never through `.apply`/`.call`: on a DO RPC
            // stub those are themselves RPC names ("does not implement the
            // method apply").
            return await (current as Record<string, (...a: unknown[]) => Promise<unknown>>)[property](...args);
          } catch (error) {
            const next = SandboxRelocatedError.generationOf(error);
            if (next === null || next <= generation || redirects >= MAX_REDIRECTS) throw error;
            generation = next;
            current = open(next);
          }
        }
      };
    },
  });
}

export interface SandboxPlacementOptions {
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  /** ctx.id.name. A DO without a name (an id-addressed instance) never rotates. */
  name: string | undefined;
  component: SandboxComponent;
  env: Parameters<typeof recordObservabilityEvent>[0];
  /** The generation-0 DO of `base` in this class's namespace. */
  registry: (base: string) => SandboxPlacementRegistry;
  /** Telemetry scope. */
  scope: () => { workspaceId?: string | null; orgId?: string | null };
  now?: () => number;
}

/**
 * One sandbox DO's view of its placement: whether it is current, its failed
 * starts, and (in generation 0) the registry.
 */
export class SandboxPlacement {
  readonly base: string | null;
  readonly generation: number;
  private readonly options: SandboxPlacementOptions;
  private readonly now: () => number;
  private record: PlacementRecord | null = null;
  private failures: number[] | null = null;

  constructor(options: SandboxPlacementOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    const parsed = options.name ? parseSandboxGenerationName(options.name) : null;
    this.base = parsed?.base ?? null;
    this.generation = parsed?.generation ?? 0;
  }

  /** Throws SandboxRelocatedError when this generation is retired. */
  async assertCurrent(): Promise<void> {
    if (this.base === null) return;
    const record = await this.readRecord();
    if (record.generation > this.generation) throw new SandboxRelocatedError(record.generation);
  }

  /**
   * Runs a container start (startWithRetry) and counts its outcome: a success
   * clears the failures, a non-permanent ContainerStartFailedError counts
   * toward a rotation (noteStartFailed). The start's own result or error is
   * returned unchanged.
   */
  async trackStart<T>(start: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
    let result: T;
    try {
      result = await start();
    } catch (error) {
      // A missing image fails in every placement: rotating would not help.
      if (error instanceof ContainerStartFailedError && !error.permanent) await this.noteStartFailed(error, cleanup);
      throw error;
    }
    await this.noteStartSucceeded();
    return result;
  }

  /** A start succeeded: the failures before it no longer count. */
  async noteStartSucceeded(): Promise<void> {
    if (this.base === null) return;
    try {
      const failures = await this.readFailures();
      if (failures.length === 0) return;
      this.failures = [];
      await this.options.storage.delete(START_FAILURES_KEY);
    } catch (error) {
      console.warn("[sandbox-placement] clearing failed starts failed", {
        component: this.options.component,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * A whole start failed (after its retry). On the STARTS_TO_ROTATE-th within
   * the window, asks generation 0 to rotate; once retired, `cleanup` (destroy
   * the container) runs best-effort. Never throws: the start's own error is
   * what the caller sees.
   */
  async noteStartFailed(error: unknown, cleanup: () => Promise<void>): Promise<void> {
    if (this.base === null) return;
    try {
      const now = this.now();
      const failures = [...(await this.readFailures()), now]
        .filter((at) => now - at < FAILURE_WINDOW_MS)
        .slice(-STARTS_TO_ROTATE);
      this.failures = failures;
      await this.options.storage.put(START_FAILURES_KEY, failures);
      if (failures.length < STARTS_TO_ROTATE) return;

      const request: RotationRequest = {
        fromGeneration: this.generation,
        reason: "start_failures",
        detail: error instanceof Error ? error.message : String(error),
      };
      const result = this.generation === 0
        ? await this.rotate(request)
        : await this.options.registry(this.base).rotateSandboxPlacement(request);
      if (result.generation <= this.generation) return;

      // Retired: remember where the sandbox went, so a caller still holding
      // this generation is redirected, and let go of the container.
      if (this.generation > 0) {
        this.record = { generation: result.generation, rotatedAt: [] };
        await this.options.storage.put(PLACEMENT_KEY, this.record);
      }
      this.failures = [];
      await this.options.storage.delete(START_FAILURES_KEY);
      try {
        await cleanup();
      } catch (cleanupError) {
        console.warn("[sandbox-placement] destroying the retired generation's container failed", {
          component: this.options.component,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    } catch (rotationError) {
      console.error("[sandbox-placement] recording a failed start failed", {
        component: this.options.component,
        error: rotationError instanceof Error ? rotationError.message : String(rotationError),
      });
    }
  }

  /**
   * The registry (generation 0 only): moves the sandbox past
   * `request.fromGeneration` unless it already moved or the bound is reached.
   */
  async rotate(request: RotationRequest): Promise<RotationResult> {
    if (this.base === null || this.generation !== 0) {
      throw new Error("Only generation 0 of a sandbox keeps its placement");
    }
    const record = await this.readRecord();
    if (request.fromGeneration < record.generation) {
      return { generation: record.generation, rotated: false, limited: false };
    }
    const now = this.now();
    const recent = record.rotatedAt.filter((at) => now - at < ROTATION_WINDOW_MS);
    const scope = this.options.scope();
    if (recent.length >= MAX_ROTATIONS) {
      recordObservabilityEvent(this.options.env, {
        event: "sandbox_placement_rotation_limited",
        severity: "error",
        component: this.options.component,
        operation: "rotatePlacement",
        status: request.reason,
        workspaceId: scope.workspaceId ?? null,
        orgId: scope.orgId ?? null,
        count: record.generation,
        size: recent.length,
        errorMessage: request.detail?.slice(0, 500) ?? null,
      });
      return { generation: record.generation, rotated: false, limited: true };
    }
    const from = Math.max(record.generation, request.fromGeneration);
    const next: PlacementRecord = { generation: from + 1, rotatedAt: [...recent, now] };
    await this.options.storage.put(PLACEMENT_KEY, next);
    this.record = next;
    // count = from generation, size = to generation.
    recordObservabilityEvent(this.options.env, {
      event: "sandbox_placement_rotated",
      severity: "warn",
      component: this.options.component,
      operation: "rotatePlacement",
      status: request.reason,
      path: `${sandboxGenerationName(this.base, from)} -> ${sandboxGenerationName(this.base, next.generation)}`,
      workspaceId: scope.workspaceId ?? null,
      orgId: scope.orgId ?? null,
      count: from,
      size: next.generation,
      errorMessage: request.detail?.slice(0, 500) ?? null,
    });
    return { generation: next.generation, rotated: true, limited: false };
  }

  private async readRecord(): Promise<PlacementRecord> {
    this.record ??= (await this.options.storage.get<PlacementRecord>(PLACEMENT_KEY)) ??
      { generation: 0, rotatedAt: [] };
    return this.record;
  }

  private async readFailures(): Promise<number[]> {
    this.failures ??= (await this.options.storage.get<number[]>(START_FAILURES_KEY)) ?? [];
    return this.failures;
  }
}
