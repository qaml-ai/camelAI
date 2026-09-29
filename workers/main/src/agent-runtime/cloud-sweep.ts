/**
 * The cloud thread sweep: move the threads still on ChatThreadDO that were
 * active lately to the agent runtime with migrateThreadToRuntime, in the
 * background, newest activity first (every org's, wherever the runtime is
 * configured). An operator starts it (POST
 * /api/admin/runtime-migration/sweep); the cron advances it a bounded step at
 * a time. Everything it knows is in D1, so it resumes wherever it stopped:
 *
 * - the job (app_index_metadata `runtime_migration_sweep`): its settings, the
 *   phase and cursor, counts, the breaker;
 * - one row per thread it could not move yet (`runtime_migration_sweep_threads`),
 *   retried with a growing delay, or skipped with the reason.
 *
 * A pass first scans the D1 thread index (threads updated within
 * `activeWithinDays`, newest first, by a keyset cursor), then retries what
 * could not move until nothing is left to retry: the sweep is then complete.
 * The runtime is spared: about two moves start a second, at most four at
 * once, a thread storing over 4 MB alone; a Retry-After the runtime sends
 * pauses the sweep that long, and moves that keep failing trip the breaker
 * (the self-host sweep's). A dry run moves nothing: it asks each thread what
 * its move would import, for every org whatever the flag, and tallies it.
 * Each thread's outcome is recorded (runtime_thread_migration, operation
 * "sweep"), and each step's progress (runtime_migration_sweep_step).
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import type { ThreadRuntimeRecord } from "../identity/org-do";
import { migrateThreadToRuntime, type RuntimeMigrationResult } from "./thread-migration";
import { recordRuntimeMigration } from "./runtime-thread-telemetry";
import { recordObservabilityEvent } from "../observability";
import { runtimeDirectThreadsEnabled } from "../../../../src/lib/agent-runtime-shared";
import {
  BREAKER_FAILURES,
  GIVE_UP_ATTEMPTS,
  GIVE_UP_MS,
  acquireStepLease,
  breakerPauseMs,
  classifyMigration,
  releaseStepLease,
  retryDelay,
  runtimeAnswers,
  withMoveTimeout,
} from "./selfhost-sweep";

export const CLOUD_SWEEP_STATE_KEY = "runtime_migration_sweep";
const STEP_LEASE_KEY = "runtime_migration_sweep_step";
const THREADS_TABLE = "runtime_migration_sweep_threads";

export type CloudSweepStatus = "idle" | "running" | "waiting" | "paused" | "complete" | "blocked";

export interface CloudSweepState {
  status: CloudSweepStatus;
  /** Asks what each move would import, and moves nothing. */
  dryRun: boolean;
  activeWithinDays: number;
  /** Threads updated at or after this are swept (set at start). */
  activeSince: number | null;
  /** scan: walking the thread index; retry: working through what could not move yet. */
  phase: "scan" | "retry";
  /** The last thread the scan reached, newest first (updated_at, then id, descending). */
  cursor: { updatedAt: number; threadId: string } | null;
  startedAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  /** When a waiting sweep's next retry is due. */
  nextAttemptAt: number | null;
  counts: {
    checked: number;
    migrated: number;
    /** Already on the runtime when the sweep came to it. */
    alreadyOnRuntime: number;
    /** Its org's threads do not move (the flag names other orgs). */
    notEnabled: number;
    skipped: number;
    retrying: number;
    /** Dry runs: moves that would import. */
    wouldMove: number;
    wouldBeLossy: number;
    largestBytes: number;
    largestThreadId: string | null;
  };
  error: string | null;
  /** No step starts moves before this: the breaker, or the runtime's Retry-After. */
  pausedUntil: number | null;
  breakerTrips: number;
  stepInProgress?: boolean;
}

export interface CloudSweepThreadRecord {
  threadId: string;
  orgId: string;
  workspaceId: string;
  createdBy: string | null;
  outcome: "skipped" | "retry";
  reason: string;
  attempts: number;
  nextAttemptAt: number | null;
  firstAttemptAt: number | null;
  updatedAt: number;
}

const COUNTS: CloudSweepState["counts"] = {
  checked: 0,
  migrated: 0,
  alreadyOnRuntime: 0,
  notEnabled: 0,
  skipped: 0,
  retrying: 0,
  wouldMove: 0,
  wouldBeLossy: 0,
  largestBytes: 0,
  largestThreadId: null,
};

const IDLE: CloudSweepState = {
  status: "idle",
  dryRun: false,
  activeWithinDays: 30,
  activeSince: null,
  phase: "scan",
  cursor: null,
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  nextAttemptAt: null,
  counts: COUNTS,
  error: null,
  pausedUntil: null,
  breakerTrips: 0,
};

export const DEFAULT_ACTIVE_WITHIN_DAYS = 30;
/** Moves in flight at once. */
const DEFAULT_CONCURRENCY = 4;
/** The least time between two moves' starts: about two creates a second. */
export const MIN_START_INTERVAL_MS = 500;
/** A thread storing more than this moves alone. */
export const LARGE_THREAD_CHARS = 4 * 1024 * 1024;
const PAGE_SIZE = 50;
const DEFAULT_BUDGET_MS = 20_000;
/** The cron's step: longer, as nobody waits on it (the cron runs every 5 minutes). */
export const CRON_BUDGET_MS = 120_000;
const DEFAULT_MOVE_TIMEOUT_MS = 3 * 60_000;

type SweepEnv = ChatEnv & { APP_DB?: D1Database };

type SweepThread = { id: string; orgId: string; workspaceId: string; createdBy: string | null; updatedAt: number };

export interface CloudSweepOptions {
  concurrency?: number;
  budgetMs?: number;
  moveTimeoutMs?: number;
  minStartIntervalMs?: number;
  now?: () => number;
  /** Waits (tests substitute one that advances their clock). */
  sleep?: (ms: number) => Promise<void>;
  migrate?: (env: ChatEnv, context: ChatContextState, options: { dryRun: boolean }) => Promise<RuntimeMigrationResult>;
  probe?: (env: ChatEnv) => Promise<boolean>;
  /** The thread's runtime row (a cheap check before its move takes a start). */
  runtimeRow?: (env: ChatEnv, thread: SweepThread) => Promise<ThreadRuntimeRecord | null>;
  /** How much transcript the thread stores. */
  size?: (env: ChatEnv, thread: SweepThread) => Promise<number>;
}

function db(env: SweepEnv): D1Database {
  if (!env.APP_DB) throw new Error("APP_DB binding is not configured");
  return env.APP_DB;
}

async function ensureSchema(env: SweepEnv): Promise<void> {
  await db(env).batch([
    db(env).prepare("CREATE TABLE IF NOT EXISTS app_index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"),
    db(env).prepare(`CREATE TABLE IF NOT EXISTS ${THREADS_TABLE} (
      thread_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      created_by TEXT,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      first_attempt_at INTEGER,
      updated_at INTEGER NOT NULL
    )`),
  ]);
}

export async function getCloudSweepState(env: SweepEnv): Promise<CloudSweepState> {
  await ensureSchema(env);
  const row = await db(env).prepare("SELECT value FROM app_index_metadata WHERE key = ?").bind(CLOUD_SWEEP_STATE_KEY).first<{ value: string }>();
  if (!row) return structuredClone(IDLE);
  try {
    const saved = JSON.parse(row.value) as Partial<CloudSweepState>;
    return { ...structuredClone(IDLE), ...saved, counts: { ...COUNTS, ...saved.counts } };
  } catch {
    return structuredClone(IDLE);
  }
}

async function saveState(env: SweepEnv, state: CloudSweepState): Promise<void> {
  const { stepInProgress: _step, ...saved } = state;
  await db(env)
    .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(CLOUD_SWEEP_STATE_KEY, JSON.stringify(saved), state.updatedAt ?? Date.now())
    .run();
}

function recordOf(row: Record<string, unknown>): CloudSweepThreadRecord {
  const number = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    threadId: String(row.thread_id),
    orgId: String(row.org_id),
    workspaceId: String(row.workspace_id),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    outcome: row.outcome === "retry" ? "retry" : "skipped",
    reason: String(row.reason),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: number(row.next_attempt_at),
    firstAttemptAt: number(row.first_attempt_at),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** The job, and the threads it skipped or will retry (the first `limit` of each, with reasons). */
export async function getCloudSweepReport(env: SweepEnv, limit = 100): Promise<CloudSweepState & {
  skipped: CloudSweepThreadRecord[];
  retrying: CloudSweepThreadRecord[];
  totals: { skipped: number; retrying: number };
}> {
  const state = await getCloudSweepState(env);
  const list = async (outcome: "skipped" | "retry") =>
    ((await db(env).prepare(`SELECT * FROM ${THREADS_TABLE} WHERE outcome = ? ORDER BY updated_at DESC LIMIT ?`).bind(outcome, limit).all()).results ?? [])
      .map((row) => recordOf(row as Record<string, unknown>));
  const totals = await db(env)
    .prepare(`SELECT SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped, SUM(CASE WHEN outcome = 'retry' THEN 1 ELSE 0 END) AS retrying FROM ${THREADS_TABLE}`)
    .first<{ skipped: number | null; retrying: number | null }>();
  return {
    ...state,
    skipped: await list("skipped"),
    retrying: await list("retry"),
    totals: { skipped: Number(totals?.skipped ?? 0), retrying: Number(totals?.retrying ?? 0) },
  };
}

/**
 * Begin a sweep: threads updated within `activeWithinDays`, newest first,
 * moved (or, `dryRun`, asked). One running or waiting with the same settings
 * is returned as it is (a start is idempotent); a paused one resumes;
 * `restart` begins afresh, forgetting its thread records.
 */
export async function startCloudSweep(
  env: SweepEnv,
  options: { dryRun?: boolean; activeWithinDays?: number; restart?: boolean; now?: () => number } = {},
): Promise<CloudSweepState> {
  const now = (options.now ?? Date.now)();
  const state = await getCloudSweepState(env);
  const dryRun = options.dryRun ?? false;
  const activeWithinDays = Math.max(1, Math.min(Math.floor(options.activeWithinDays ?? DEFAULT_ACTIVE_WITHIN_DAYS), 3650));
  const same = state.dryRun === dryRun && state.activeWithinDays === activeWithinDays;
  if (!options.restart && same && (state.status === "running" || state.status === "waiting")) return state;
  if (!options.restart && same && state.status === "paused") {
    const resumed: CloudSweepState = { ...state, status: "running", error: null, updatedAt: now };
    await saveState(env, resumed);
    return resumed;
  }
  await db(env).prepare(`DELETE FROM ${THREADS_TABLE}`).run();
  const started: CloudSweepState = {
    ...structuredClone(IDLE),
    status: "running",
    dryRun,
    activeWithinDays,
    activeSince: now - activeWithinDays * 24 * 60 * 60_000,
    startedAt: now,
    updatedAt: now,
  };
  await saveState(env, started);
  return started;
}

/** Stop advancing (steps and the cron do nothing) until the next start, which resumes it. */
export async function pauseCloudSweep(env: SweepEnv, now = Date.now()): Promise<CloudSweepState> {
  const state = await getCloudSweepState(env);
  if (state.status !== "running" && state.status !== "waiting") return state;
  const paused: CloudSweepState = { ...state, status: "paused", updatedAt: now };
  await saveState(env, paused);
  return paused;
}

/** A step's sweep was restarted or paused while it ran: it stops, and saves nothing more. */
class StepSuperseded extends Error {
  constructor(readonly state: CloudSweepState) {
    super("the sweep was restarted or paused during this step");
  }
}

/**
 * Save a step's progress only onto the sweep it began with: a sweep
 * restarted meanwhile (another startedAt) is left as it is, and a pause
 * made meanwhile stands (the progress is kept, paused). Throws
 * StepSuperseded in either case, so the step stops.
 */
async function saveStepState(env: SweepEnv, next: CloudSweepState): Promise<CloudSweepState> {
  const stored = await getCloudSweepState(env);
  if (stored.startedAt !== next.startedAt) throw new StepSuperseded(stored);
  const saved: CloudSweepState = stored.status === "paused" ? { ...next, status: "paused" } : next;
  await saveState(env, saved);
  if (saved.status === "paused") throw new StepSuperseded(saved);
  return saved;
}

/** The next page of the scan: threads updated since the cutoff, after the cursor, newest first. */
async function scanPage(env: SweepEnv, state: CloudSweepState): Promise<SweepThread[]> {
  const since = state.activeSince ?? 0;
  const cursor = state.cursor;
  const statement = cursor
    ? db(env).prepare(`SELECT id, org_id, workspace_id, created_by, updated_at FROM threads
        WHERE updated_at >= ? AND (updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC LIMIT ?`).bind(since, cursor.updatedAt, cursor.updatedAt, cursor.threadId, PAGE_SIZE)
    : db(env).prepare(`SELECT id, org_id, workspace_id, created_by, updated_at FROM threads
        WHERE updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`).bind(since, PAGE_SIZE);
  const rows = (await statement.all<{ id: string; org_id: string; workspace_id: string; created_by: string | null; updated_at: number }>()).results ?? [];
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    updatedAt: Number(row.updated_at),
  }));
}

/** Retry records due now, earliest first. */
async function duePage(env: SweepEnv, at: number): Promise<Array<SweepThread & { record: CloudSweepThreadRecord }>> {
  const rows = (await db(env)
    .prepare(`SELECT * FROM ${THREADS_TABLE} WHERE outcome = 'retry' AND next_attempt_at <= ? ORDER BY next_attempt_at, thread_id LIMIT ?`)
    .bind(at, PAGE_SIZE).all()).results ?? [];
  return rows.map((row) => {
    const record = recordOf(row as Record<string, unknown>);
    return { id: record.threadId, orgId: record.orgId, workspaceId: record.workspaceId, createdBy: record.createdBy, updatedAt: 0, record };
  });
}

function orgStub(env: ChatEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as { getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null> };
}

const defaultRuntimeRow = (env: ChatEnv, thread: SweepThread) => orgStub(env, thread.orgId).getThreadRuntime(thread.id);
const defaultSize = async (env: ChatEnv, thread: SweepThread) => {
  const chat = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(thread.id)) as unknown as { runtimeMigrationSize(): Promise<{ chars: number }> };
  return (await chat.runtimeMigrationSize()).chars;
};

/**
 * Advance the sweep while `budgetMs` lasts (moves start only within it; the
 * step then waits for the ones it started, at most `moveTimeoutMs` each). One
 * step at a time (a lease in D1), whoever asks: the cron or an operator.
 */
export async function runCloudSweepStep(env: SweepEnv, options: CloudSweepOptions = {}): Promise<CloudSweepState> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 8));
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const moveTimeoutMs = options.moveTimeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;
  const minStartInterval = options.minStartIntervalMs ?? MIN_START_INTERVAL_MS;
  const migrate = options.migrate ?? ((stepEnv: ChatEnv, context: ChatContextState, { dryRun }: { dryRun: boolean }) =>
    migrateThreadToRuntime(stepEnv, context, { dryRun }));
  const probe = options.probe ?? runtimeAnswers;
  const runtimeRow = options.runtimeRow ?? defaultRuntimeRow;
  const size = options.size ?? defaultSize;

  let state = await getCloudSweepState(env);
  if (state.status === "waiting" && (state.nextAttemptAt ?? 0) <= now()) state = { ...state, status: "running", nextAttemptAt: null };
  if (state.status !== "running") return state;
  if (state.pausedUntil && now() < state.pausedUntil) return state;
  const started = now();
  if (!await acquireStepLease(env, started, started + budgetMs + moveTimeoutMs + 30_000, STEP_LEASE_KEY)) {
    return { ...state, stepInProgress: true };
  }
  const before = { ...state.counts };
  let superseded = false;
  try {
    const pause = async (reason: string, until: number, trip: boolean): Promise<CloudSweepState> => {
      state = { ...state, pausedUntil: until, error: reason, updatedAt: now(), breakerTrips: trip ? state.breakerTrips + 1 : state.breakerTrips };
      console.warn("[runtime-migration-sweep] paused", { reason, until });
      state = await saveStepState(env, state);
      return state;
    };
    if (!state.dryRun && !await probe(env)) {
      return await pause("the agent runtime does not answer", now() + breakerPauseMs(state.breakerTrips + 1), true);
    }

    let nextStartAt = 0;
    while (now() - started < budgetMs) {
      const scanning = state.phase === "scan";
      const page: Array<SweepThread & { record?: CloudSweepThreadRecord }> = scanning ? await scanPage(env, state) : await duePage(env, now());
      if (page.length === 0) {
        if (scanning) {
          state = await saveStepState(env, { ...state, phase: "retry", cursor: null, updatedAt: now() });
          continue;
        }
        state = await finish(env, state, now(), saveStepState);
        break;
      }
      const known = new Map<string, CloudSweepThreadRecord>();
      if (scanning) {
        const placeholders = page.map(() => "?").join(", ");
        const rows = (await db(env).prepare(`SELECT * FROM ${THREADS_TABLE} WHERE thread_id IN (${placeholders})`)
          .bind(...page.map((thread) => thread.id)).all()).results ?? [];
        for (const row of rows) {
          const record = recordOf(row as Record<string, unknown>);
          known.set(record.threadId, record);
        }
      } else {
        for (const thread of page) if (thread.record) known.set(thread.id, thread.record);
      }

      let failures = 0;
      let pausedFor: { reason: string; until: number } | null = null;
      let inFlight = 0;
      let alone = false;
      let next = 0;
      const tried = new Set<string>();
      const stop = () => pausedFor !== null || failures >= BREAKER_FAILURES || now() - started >= budgetMs;
      /** A start slot: at most one every `minStartInterval`, none while a big thread moves alone. */
      const takeStart = async (big: boolean): Promise<boolean> => {
        for (;;) {
          if (stop()) return false;
          const wait = Math.max(0, nextStartAt - now());
          if (!alone && (!big || inFlight === 0) && wait === 0) break;
          await sleep(wait > 0 ? wait : 25);
        }
        nextStartAt = now() + minStartInterval;
        inFlight += 1;
        if (big) alone = true;
        return true;
      };
      const settle = async (thread: SweepThread, outcome: { kind: "migrated" | "already" | "not_enabled" | "dry_run" } | { kind: "skipped" | "retry"; reason: string }) => {
        state.counts.checked += 1;
        const at = now();
        if (outcome.kind !== "skipped" && outcome.kind !== "retry") {
          if (outcome.kind === "migrated") state.counts.migrated += 1;
          if (outcome.kind === "already") state.counts.alreadyOnRuntime += 1;
          if (outcome.kind === "not_enabled") state.counts.notEnabled += 1;
          if (known.has(thread.id)) await db(env).prepare(`DELETE FROM ${THREADS_TABLE} WHERE thread_id = ?`).bind(thread.id).run();
          return;
        }
        const previous = known.get(thread.id);
        const attempts = (previous?.attempts ?? 0) + 1;
        const firstAttemptAt = previous?.firstAttemptAt ?? at;
        let kind = outcome.kind;
        let reason = outcome.reason;
        if (kind === "retry" && (attempts >= GIVE_UP_ATTEMPTS || at - firstAttemptAt >= GIVE_UP_MS)) {
          kind = "skipped";
          reason = `gave up after ${attempts} attempts: ${reason}`;
        }
        if (kind === "retry") state.counts.retrying += 1;
        else state.counts.skipped += 1;
        await db(env)
          .prepare(`INSERT OR REPLACE INTO ${THREADS_TABLE} (thread_id, org_id, workspace_id, created_by, outcome, reason, attempts, next_attempt_at, first_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(thread.id, thread.orgId, thread.workspaceId, thread.createdBy, kind, reason.slice(0, 500), attempts, kind === "retry" ? at + retryDelay(attempts) : null, firstAttemptAt, at)
          .run();
      };
      const work = async (thread: SweepThread): Promise<boolean> => {
        const record = known.get(thread.id);
        // Scanning past a thread this sweep already recorded: the retry phase owns it, or it was skipped.
        if (scanning && record) return true;
        if (!state.dryRun && !runtimeDirectThreadsEnabled(env)) {
          await settle(thread, { kind: "not_enabled" });
          return true;
        }
        if (!state.dryRun && await runtimeRow(env, thread).catch(() => null)) {
          await settle(thread, { kind: "already" });
          return true;
        }
        const big = await size(env, thread).then((chars) => chars > LARGE_THREAD_CHARS, () => false);
        if (!await takeStart(big)) return false;
        const context: ChatContextState = {
          orgId: thread.orgId,
          workspaceId: thread.workspaceId,
          threadId: thread.id,
          userId: thread.createdBy || null,
          userName: null,
          userEmail: null,
        };
        try {
          let result: RuntimeMigrationResult | "timed out";
          const moveStarted = Date.now();
          try {
            result = await withMoveTimeout(migrate(env, context, { dryRun: state.dryRun }), moveTimeoutMs);
          } catch (error) {
            result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
          }
          if (result === "timed out") {
            await settle(thread, { kind: "retry", reason: "busy: the move is still going" });
            return true;
          }
          recordRuntimeMigration(env, context, result, "sweep", Date.now() - moveStarted);
          if (result.status === "dry_run") {
            state.counts.wouldMove += 1;
            if (result.lossy) state.counts.wouldBeLossy += 1;
            if (result.bytes > state.counts.largestBytes) {
              state.counts.largestBytes = result.bytes;
              state.counts.largestThreadId = thread.id;
            }
            await settle(thread, { kind: "dry_run" });
            return true;
          }
          if (result.status === "failed" && result.retryAfterMs !== undefined) {
            pausedFor = { reason: `the runtime asked to wait (Retry-After ${Math.round(result.retryAfterMs / 1000)} s)`, until: now() + result.retryAfterMs };
          }
          const classified = classifyMigration(result);
          if (classified.outcome === "migrated") {
            state.breakerTrips = 0;
            await settle(thread, { kind: result.status === "runtime" ? "already" : "migrated" });
          } else if (classified.outcome === "blocked") {
            state = { ...state, status: "blocked", error: classified.reason };
          } else {
            if (classified.outcome === "retry" && classified.reason.startsWith("failed:")) failures += 1;
            await settle(thread, { kind: classified.outcome, reason: classified.reason });
          }
          return true;
        } finally {
          inFlight -= 1;
          if (big) alone = false;
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, page.length) }, async () => {
        while (next < page.length && !stop() && state.status === "running") {
          const thread = page[next++];
          if (await work(thread)) tried.add(thread.id);
        }
      }));
      if (state.status === "blocked") {
        state.updatedAt = now();
        state = await saveStepState(env, state);
        return state;
      }
      if (scanning) {
        // The cursor: the last thread of the page every thread before which was tried.
        let reached = -1;
        while (reached + 1 < page.length && tried.has(page[reached + 1].id)) reached += 1;
        if (reached >= 0) state.cursor = { updatedAt: page[reached].updatedAt, threadId: page[reached].id };
      }
      state.updatedAt = now();
      // Set inside the page loop's callbacks, which the compiler does not see.
      const paused = pausedFor as { reason: string; until: number } | null;
      if (paused) return await pause(paused.reason, paused.until, false);
      if (failures >= BREAKER_FAILURES) return await pause(`${failures} moves failed in one step`, now() + breakerPauseMs(state.breakerTrips + 1), true);
      state.pausedUntil = null;
      state.error = null;
      state = await saveStepState(env, state);
      if (tried.size < page.length) break;
    }
    return state;
  } catch (error) {
    if (!(error instanceof StepSuperseded)) throw error;
    console.warn("[runtime-migration-sweep] step stopped:", error.message);
    superseded = true;
    state = error.state;
    return state;
  } finally {
    if (!superseded) recordObservabilityEvent(env, {
      event: "runtime_migration_sweep_step",
      component: "runtime_thread",
      operation: "sweep",
      status: state.status,
      errorName: state.phase,
      errorMessage: state.error,
      count: state.counts.checked - before.checked,
      extraCounts: [
        state.counts.migrated - before.migrated,
        state.counts.alreadyOnRuntime - before.alreadyOnRuntime,
        state.counts.skipped - before.skipped,
        state.counts.retrying - before.retrying,
        state.counts.notEnabled - before.notEnabled,
        state.dryRun ? 1 : 0,
      ],
    });
    await releaseStepLease(env, STEP_LEASE_KEY).catch(() => undefined);
  }
}

/** The scan is done and nothing is due: waiting for the next retry, or complete. */
async function finish(
  env: SweepEnv,
  state: CloudSweepState,
  at: number,
  save: (env: SweepEnv, next: CloudSweepState) => Promise<CloudSweepState>,
): Promise<CloudSweepState> {
  const pending = await db(env)
    .prepare(`SELECT COUNT(*) AS retrying, MIN(next_attempt_at) AS next_at FROM ${THREADS_TABLE} WHERE outcome = 'retry'`)
    .first<{ retrying: number | null; next_at: number | null }>();
  const done: CloudSweepState = Number(pending?.retrying ?? 0) > 0
    ? { ...state, status: "waiting", nextAttemptAt: Math.max(at, Number(pending?.next_at ?? at)), updatedAt: at }
    : { ...state, status: "complete", completedAt: at, nextAttemptAt: null, updatedAt: at };
  const saved = await save(env, done);
  console.log("[runtime-migration-sweep] pass finished", { status: done.status, ...state.counts });
  return saved;
}

/** The cron's turn: a step of a running (or due) sweep; nothing otherwise. */
export async function runCloudSweepCron(env: SweepEnv): Promise<void> {
  if (!env.APP_DB) return;
  const state = await getCloudSweepState(env);
  if (state.status !== "running" && state.status !== "waiting") return;
  await runCloudSweepStep(env, { budgetMs: CRON_BUDGET_MS });
}
