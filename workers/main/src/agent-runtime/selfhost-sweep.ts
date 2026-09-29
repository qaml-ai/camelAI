/**
 * The self-host thread sweep: move every thread still on ChatThreadDO to the
 * agent runtime with migrateThreadToRuntime, in the background (threads also
 * move when opened; SELF_HOSTING.md, "Moving existing threads").
 *
 * The app's startup process drives it (scripts/selfhost-runtime-sweep.mjs)
 * through the admin API, one bounded step at a time; everything it knows is
 * in D1, so a restart resumes where it stopped:
 *
 * - the job (app_index_metadata `selfhost_runtime_sweep`): its pass, cursor
 *   (org, then thread, both in id order), counts, and when it finished;
 * - one row per thread it could not move yet (`selfhost_runtime_sweep_threads`):
 *   retried later (busy, failed, the DO's own backoff) with a growing delay,
 *   or skipped with the reason (too_large, no runtime route for its model, …).
 *
 * A pass walks every org (D1 `orgs`) and each org's threads without a
 * thread_runtime row (OrgDO.listThreadsWithoutRuntime), `concurrency` moves
 * at a time. When a pass ends with nothing left to retry the sweep is
 * `complete`: that marker, with how many threads it had to skip, is what a
 * release without the exporter checks before it starts
 * (scripts/selfhost-runtime-gate.mjs). A start begins a new pass, so threads
 * a pass could not move yet are tried again.
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import { migrateThreadToRuntime, type RuntimeMigrationResult } from "./thread-migration";
import { runtimeUrl } from "./runtime-api";

export const SWEEP_STATE_KEY = "selfhost_runtime_sweep";
const THREADS_TABLE = "selfhost_runtime_sweep_threads";

export type SweepStatus = "idle" | "running" | "waiting" | "complete" | "blocked";

export interface SweepState {
  status: SweepStatus;
  /** Passes started; a start (the app's) begins a new one. */
  pass: number;
  /** The pass a start began last: threads skipped since are not retried until the next start. */
  startPass: number;
  cursor: { orgId: string | null; threadId: string | null };
  startedAt: number | null;
  updatedAt: number | null;
  /** When the last pass ended with nothing left to retry: the migrated marker. */
  completedAt: number | null;
  /** When a waiting sweep's next pass is due (its earliest retry). */
  nextPassAt: number | null;
  /** This pass's outcomes. */
  counts: { migrated: number; skipped: number; retrying: number; checked: number };
  /** Threads still off the runtime when the last pass ended: skipped plus retrying. */
  remaining: number | null;
  /** Why the sweep cannot run (blocked), e.g. direct threads are off. */
  error: string | null;
  /** Threads off the runtime when a pass last completed: what the gate goes by while a later pass rechecks. */
  completedRemaining: number | null;
  /** The circuit breaker: no step starts moves before this (the runtime failing, or not answering). */
  pausedUntil: number | null;
  /** Breaker trips in a row, for its backoff; a move that succeeds resets it. */
  breakerTrips: number;
  /** Set on an answer while another step holds the step lease (not saved). */
  stepInProgress?: boolean;
}

export interface SweepThreadRecord {
  threadId: string;
  orgId: string;
  workspaceId: string;
  outcome: "skipped" | "retry";
  reason: string;
  attempts: number;
  nextAttemptAt: number | null;
  /** When it was first tried: a thread still failing after GIVE_UP_MS is given up on (skipped). */
  firstAttemptAt: number | null;
  pass: number;
  updatedAt: number;
}

export interface SweepReport extends SweepState {
  skipped: SweepThreadRecord[];
  retrying: SweepThreadRecord[];
}

const IDLE: SweepState = {
  status: "idle",
  pass: 0,
  startPass: 0,
  cursor: { orgId: null, threadId: null },
  startedAt: null,
  updatedAt: null,
  completedAt: null,
  nextPassAt: null,
  counts: { migrated: 0, skipped: 0, retrying: 0, checked: 0 },
  remaining: null,
  error: null,
  completedRemaining: null,
  pausedUntil: null,
  breakerTrips: 0,
};

export interface SweepOptions {
  /** Moves at once. */
  concurrency?: number;
  /** Threads listed per OrgDO call. */
  pageSize?: number;
  /** How long one step may keep starting moves. */
  budgetMs?: number;
  now?: () => number;
  /** The move (tests substitute one). */
  migrate?: (env: ChatEnv, context: ChatContextState) => Promise<RuntimeMigrationResult>;
  /** How long a step waits for one move before leaving it to finish on its own (it is looked at again later). */
  moveTimeoutMs?: number;
  /** Whether the runtime answers (tests substitute one); the default asks its /healthz. */
  probe?: (env: ChatEnv) => Promise<boolean>;
}

type SweepEnv = ChatEnv & { APP_DB?: D1Database };

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_BUDGET_MS = 20_000;
/**
 * How long a step waits for one move: its own agent create and archive run
 * under a lease the DO renews, so a slow move goes on, and the next pass finds it moved.
 */
export const DEFAULT_MOVE_TIMEOUT_MS = 3 * 60_000;
/** The longest a step can take (its budget, then the moves it started): the driver waits longer. */
export const MAX_STEP_MS = DEFAULT_BUDGET_MS + DEFAULT_MOVE_TIMEOUT_MS + 30_000;
/** Moves failing (not busy) in one step that trip the breaker. */
export const BREAKER_FAILURES = 5;
/** The breaker's pause: 1 min, doubling, at most 30 min. */
export const breakerPauseMs = (trips: number) => Math.min(60_000 * 2 ** Math.max(0, trips - 1), 30 * 60_000);
/** A thread given up on (skipped) after this many failed tries, or this long since its first. */
export const GIVE_UP_ATTEMPTS = 12;
export const GIVE_UP_MS = 3 * 24 * 60 * 60_000;
const STEP_LEASE_KEY = "selfhost_runtime_sweep_step";
/** A thread that could not move now is tried again after 1 min, doubling, at most 1 h. */
export const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Reasons a thread will not move however often it is tried: never retried within a start. */
export const PERMANENT = /^(too_large|invalid_history|refused_\d+|thread deleted|not a thread of this workspace)\b/;

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
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      first_attempt_at INTEGER,
      pass INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
  ]);
  // Tables made before first_attempt_at.
  await db(env).prepare(`ALTER TABLE ${THREADS_TABLE} ADD COLUMN first_attempt_at INTEGER`).run().catch(() => undefined);
}

export async function getSweepState(env: SweepEnv): Promise<SweepState> {
  await ensureSchema(env);
  const row = await db(env).prepare("SELECT value FROM app_index_metadata WHERE key = ?").bind(SWEEP_STATE_KEY).first<{ value: string }>();
  if (!row) return structuredClone(IDLE);
  try {
    const saved = JSON.parse(row.value) as Partial<SweepState>;
    return { ...structuredClone(IDLE), ...saved, counts: { ...IDLE.counts, ...saved.counts }, cursor: { ...IDLE.cursor, ...saved.cursor } };
  } catch {
    return structuredClone(IDLE);
  }
}

async function saveSweepState(env: SweepEnv, state: SweepState): Promise<void> {
  await db(env)
    .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES (?, ?, ?)")
    .bind(SWEEP_STATE_KEY, JSON.stringify(state), state.updatedAt ?? Date.now())
    .run();
}

function recordOf(row: Record<string, unknown>): SweepThreadRecord {
  return {
    threadId: String(row.thread_id),
    orgId: String(row.org_id),
    workspaceId: String(row.workspace_id),
    outcome: row.outcome === "retry" ? "retry" : "skipped",
    reason: String(row.reason),
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: row.next_attempt_at === null || row.next_attempt_at === undefined ? null : Number(row.next_attempt_at),
    firstAttemptAt: row.first_attempt_at === null || row.first_attempt_at === undefined ? null : Number(row.first_attempt_at),
    pass: Number(row.pass ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/** The job, and the threads it skipped or will retry (the first `limit` of each), for the status endpoint and doctor. */
export async function getSweepReport(env: SweepEnv, limit = 100): Promise<SweepReport> {
  const state = await getSweepState(env);
  const list = async (outcome: "skipped" | "retry") =>
    ((await db(env).prepare(`SELECT * FROM ${THREADS_TABLE} WHERE outcome = ? ORDER BY org_id, thread_id LIMIT ?`).bind(outcome, limit).all()).results ?? [])
      .map((row) => recordOf(row as Record<string, unknown>));
  return { ...state, skipped: await list("skipped"), retrying: await list("retry") };
}

/**
 * Begin a pass (the app does at every start): from the first org, with this
 * pass's counts at zero. A pass under way when the app restarted is resumed
 * rather than restarted, so a crash loop still makes progress.
 */
export async function startSweep(env: SweepEnv, options: { now?: () => number; resume?: boolean } = {}): Promise<SweepState> {
  const now = (options.now ?? Date.now)();
  const state = await getSweepState(env);
  if (options.resume !== false && state.status === "running") return state;
  const next: SweepState = {
    ...state,
    status: "running",
    pass: state.pass + 1,
    startPass: state.pass + 1,
    cursor: { orgId: null, threadId: null },
    startedAt: now,
    updatedAt: now,
    nextPassAt: null,
    counts: { ...IDLE.counts },
    error: null,
  };
  await saveSweepState(env, next);
  return next;
}

/** Forget the job and its thread records (the next start begins from scratch). */
export async function resetSweep(env: SweepEnv): Promise<SweepState> {
  await ensureSchema(env);
  await db(env).prepare(`DELETE FROM ${THREADS_TABLE}`).run();
  const state = structuredClone(IDLE);
  state.updatedAt = Date.now();
  await saveSweepState(env, state);
  return state;
}

type Classified =
  | { outcome: "migrated" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "retry"; reason: string }
  | { outcome: "blocked"; reason: string };

export function classifyMigration(result: RuntimeMigrationResult): Classified {
  switch (result.status) {
    case "migrated":
    case "adopted":
    case "runtime":
      return { outcome: "migrated" };
    case "busy":
      return { outcome: "retry", reason: `busy: ${result.reason}` };
    case "failed":
      return { outcome: "retry", reason: `failed: ${result.error}` };
    case "dry_run":
      return { outcome: "retry", reason: "dry run" };
    case "skipped":
      if (result.reason === "moved") return { outcome: "migrated" };
      if (result.reason === "the agent runtime is not configured") return { outcome: "blocked", reason: result.reason };
      // A history the runtime refuses every time (backing off for a day): skipped, with its reason.
      if (/^backoff: (too_large|invalid_history)\b/.test(result.reason)) return { outcome: "skipped", reason: result.reason };
      // The DO's own backoff after a failed attempt, or a model that did not
      // resolve just now (a provider setting being changed): try again later.
      if (result.reason.startsWith("backoff") || result.reason.startsWith("its model did not resolve")) {
        return { outcome: "retry", reason: result.reason };
      }
      return { outcome: "skipped", reason: result.reason };
  }
}

export function retryDelay(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

async function nextOrg(env: SweepEnv, after: string | null): Promise<string | null> {
  const row = await db(env)
    .prepare("SELECT id FROM orgs WHERE id > ? ORDER BY id LIMIT 1")
    .bind(after ?? "")
    .first<{ id: string }>();
  return row?.id ?? null;
}

type OrgSweepStub = {
  listThreadsWithoutRuntime(after: string | null, limit: number): Promise<Array<{ id: string; workspace_id: string; created_by: string }>>;
};

/**
 * Hold the step lease until `until`: one step at a time, whoever asks (the
 * startup driver, an operator's POST, a driver that restarted mid-step).
 * False while another step holds it.
 */
export async function acquireStepLease(env: SweepEnv, at: number, until: number, key = STEP_LEASE_KEY): Promise<boolean> {
  const result = await db(env)
    .prepare(`INSERT INTO app_index_metadata (key, value, updated_at) VALUES (?, 'step', ?)
      ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at WHERE app_index_metadata.updated_at <= ?`)
    .bind(key, until, at)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function releaseStepLease(env: SweepEnv, key = STEP_LEASE_KEY): Promise<void> {
  await db(env).prepare("UPDATE app_index_metadata SET updated_at = 0 WHERE key = ?").bind(key).run();
}

/** Whether the runtime answers its health check, within a few seconds. */
export async function runtimeAnswers(env: ChatEnv): Promise<boolean> {
  try {
    const response = await fetch(`${runtimeUrl(env)}/healthz`, { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export function withMoveTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timed out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timed out">((resolve) => { timer = setTimeout(() => resolve("timed out"), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Advance the sweep while `budgetMs` lasts: moves start only within it (a
 * step then waits for the ones it started, at most `moveTimeoutMs` each),
 * and the cursor, saved after each page, is the last thread every thread
 * before which was tried, so a thread the budget cut off is the next step's
 * first. One step at a time (a lease in D1). When the runtime does not
 * answer, or moves keep failing, the breaker pauses the sweep (1 min,
 * doubling). A waiting sweep whose retries are due begins its next pass; a
 * complete or blocked one does nothing until the next start.
 */
export async function runSweepStep(env: SweepEnv, options: SweepOptions = {}): Promise<SweepState> {
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 16));
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, 500));
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const moveTimeoutMs = options.moveTimeoutMs ?? DEFAULT_MOVE_TIMEOUT_MS;
  const migrate = options.migrate ?? ((stepEnv: ChatEnv, context: ChatContextState) => migrateThreadToRuntime(stepEnv, context));
  const probe = options.probe ?? runtimeAnswers;
  let state = await getSweepState(env);
  if (state.status === "waiting" && (state.nextPassAt ?? 0) <= now()) {
    state = { ...state, status: "running", pass: state.pass + 1, cursor: { orgId: null, threadId: null }, counts: { ...IDLE.counts }, nextPassAt: null };
  }
  if (state.status !== "running") return state;
  if (state.pausedUntil && now() < state.pausedUntil) return state;
  const started = now();
  if (!await acquireStepLease(env, started, started + budgetMs + moveTimeoutMs + 30_000)) {
    return { ...state, stepInProgress: true };
  }
  try {
    const trip = async (reason: string): Promise<SweepState> => {
      const trips = state.breakerTrips + 1;
      state = { ...state, breakerTrips: trips, pausedUntil: now() + breakerPauseMs(trips), error: reason, updatedAt: now() };
      console.warn("[selfhost-sweep] paused", { reason, until: state.pausedUntil });
      await saveSweepState(env, state);
      return state;
    };
    if (!await probe(env)) return await trip("the agent runtime does not answer");

    while (now() - started < budgetMs) {
      const orgId = state.cursor.orgId ?? await nextOrg(env, null);
      if (!orgId) {
        state = await finishPass(env, state, now());
        break;
      }
      const org = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgSweepStub;
      let page: Array<{ id: string; workspace_id: string; created_by: string }>;
      try {
        page = await org.listThreadsWithoutRuntime(state.cursor.threadId, pageSize);
      } catch (error) {
        // An org that cannot be read is recorded (to retry, and for the
        // doctor) and passed over, so one broken org never stops the sweep.
        const at = now();
        await db(env)
          .prepare(`INSERT OR REPLACE INTO ${THREADS_TABLE} (thread_id, org_id, workspace_id, outcome, reason, attempts, next_attempt_at, first_attempt_at, pass, updated_at) VALUES (?, ?, '', 'retry', ?, 1, ?, ?, ?, ?)`)
          .bind(`org:${orgId}`, orgId, `failed: could not read the org: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), at + RETRY_BASE_MS, at, state.pass, at)
          .run();
        state.counts.retrying += 1;
        state.cursor = { orgId: await nextOrg(env, orgId), threadId: null };
        if (!state.cursor.orgId) {
          state = await finishPass(env, state, now());
          break;
        }
        state.updatedAt = now();
        await saveSweepState(env, state);
        continue;
      }
      if (page.length === 0) {
        const following = await nextOrg(env, orgId);
        state.cursor = { orgId: following, threadId: null };
        if (!following) {
          state = await finishPass(env, state, now());
          break;
        }
        state.updatedAt = now();
        await saveSweepState(env, state);
        continue;
      }
      const known = new Map<string, SweepThreadRecord>();
      const placeholders = page.map(() => "?").join(", ");
      const rows = (await db(env).prepare(`SELECT * FROM ${THREADS_TABLE} WHERE thread_id IN (${placeholders})`)
        .bind(...page.map((thread) => thread.id)).all()).results ?? [];
      for (const row of rows) {
        const record = recordOf(row as Record<string, unknown>);
        known.set(record.threadId, record);
      }
      const isDue = (thread: { id: string }) => {
        const record = known.get(thread.id);
        if (!record) return true;
        if (record.outcome === "retry") return (record.nextAttemptAt ?? 0) <= now();
        // Skipped: a thread that cannot move stays skipped until the next start
        // (its model or the install's settings may change by then), unless it never can.
        return !PERMANENT.test(record.reason) && record.pass < state.startPass;
      };

      // Page order, a thread at a time from `concurrency` workers; none starts
      // once the budget is spent or the breaker trips.
      let blocked: string | null = null;
      let failures = 0;
      let next = 0;
      const tried = new Set<string>();
      const stop = () => blocked !== null || failures >= BREAKER_FAILURES || now() - started >= budgetMs;
      const work = async (thread: { id: string; workspace_id: string; created_by: string }) => {
        if (!isDue(thread)) {
          // Its record is still current: the pass's end drops the others
          // (threads moved on open, or deleted).
          await db(env).prepare(`UPDATE ${THREADS_TABLE} SET pass = ? WHERE thread_id = ?`).bind(state.pass, thread.id).run();
          return;
        }
        const context: ChatContextState = {
          orgId,
          workspaceId: thread.workspace_id,
          threadId: thread.id,
          userId: thread.created_by || null,
          userName: null,
          userEmail: null,
        };
        let classified: Classified;
        try {
          const result = await withMoveTimeout(migrate(env, context), moveTimeoutMs);
          classified = result === "timed out"
            ? { outcome: "retry", reason: "busy: the move is still going" }
            : classifyMigration(result);
        } catch (error) {
          classified = { outcome: "retry", reason: `failed: ${error instanceof Error ? error.message : String(error)}` };
        }
        state.counts.checked += 1;
        const at = now();
        if (classified.outcome === "blocked") {
          blocked = classified.reason;
          return;
        }
        if (classified.outcome === "migrated") {
          state.counts.migrated += 1;
          state.breakerTrips = 0;
          await db(env).prepare(`DELETE FROM ${THREADS_TABLE} WHERE thread_id = ?`).bind(thread.id).run();
          console.log("[selfhost-sweep] moved thread to the runtime", { orgId, threadId: thread.id });
          return;
        }
        if (classified.outcome === "retry" && classified.reason.startsWith("failed:")) failures += 1;
        const previous = known.get(thread.id);
        const attempts = (previous?.attempts ?? 0) + 1;
        const firstAttemptAt = previous?.firstAttemptAt ?? at;
        // A thread that keeps failing is given up on (skipped, tried again at the next start).
        if (classified.outcome === "retry" && (attempts >= GIVE_UP_ATTEMPTS || at - firstAttemptAt >= GIVE_UP_MS)) {
          classified = { outcome: "skipped", reason: `gave up after ${attempts} attempts: ${classified.reason}` };
        }
        const nextAttemptAt = classified.outcome === "retry" ? at + retryDelay(attempts) : null;
        if (classified.outcome === "retry") state.counts.retrying += 1;
        else state.counts.skipped += 1;
        await db(env)
          .prepare(`INSERT OR REPLACE INTO ${THREADS_TABLE} (thread_id, org_id, workspace_id, outcome, reason, attempts, next_attempt_at, first_attempt_at, pass, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(thread.id, orgId, thread.workspace_id, classified.outcome, classified.reason.slice(0, 500), attempts, nextAttemptAt, firstAttemptAt, state.pass, at)
          .run();
        console.warn(`[selfhost-sweep] thread ${classified.outcome === "retry" ? "will be retried" : "skipped"}`, {
          orgId,
          threadId: thread.id,
          reason: classified.reason,
        });
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, page.length) }, async () => {
        while (next < page.length && !stop()) {
          const thread = page[next++];
          await work(thread);
          tried.add(thread.id);
        }
      }));
      if (blocked) {
        state = { ...state, status: "blocked", error: blocked, updatedAt: now() };
        await saveSweepState(env, state);
        return state;
      }
      // The cursor: the last thread of the page every thread before which was tried.
      let reached = -1;
      while (reached + 1 < page.length && tried.has(page[reached + 1].id)) reached += 1;
      if (reached >= 0) state.cursor = { orgId, threadId: page[reached].id };
      state.updatedAt = now();
      if (failures >= BREAKER_FAILURES) return await trip(`${failures} moves failed in one step`);
      state.pausedUntil = null;
      if (state.error && !state.error.startsWith("direct")) state.error = null;
      await saveSweepState(env, state);
      if (reached < page.length - 1) break;
    }
    return state;
  } finally {
    await releaseStepLease(env).catch(() => undefined);
  }
}

/**
 * A pass walked every org. With retries left it waits for the earliest.
 * Otherwise, before it says complete, it counts every org's threads still
 * off the runtime: a thread that came since the pass went by (a model without
 * a route, a thread made while the app ran) starts another pass; when the
 * count is the skipped threads', the sweep is complete, with them as
 * `remaining` (and `completedRemaining`, which the gate reads).
 */
async function finishPass(env: SweepEnv, state: SweepState, at: number): Promise<SweepState> {
  // A record this pass did not see is of a thread no longer on ChatThreadDO.
  await db(env).prepare(`DELETE FROM ${THREADS_TABLE} WHERE pass < ?`).bind(state.pass).run();
  const pending = await db(env)
    .prepare(`SELECT
        SUM(CASE WHEN outcome = 'retry' THEN 1 ELSE 0 END) AS retrying,
        SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        MIN(CASE WHEN outcome = 'retry' THEN next_attempt_at END) AS next_at
      FROM ${THREADS_TABLE}`)
    .first<{ retrying: number | null; skipped: number | null; next_at: number | null }>();
  const retrying = Number(pending?.retrying ?? 0);
  const skipped = Number(pending?.skipped ?? 0);
  let done: SweepState;
  if (retrying > 0) {
    done = {
      ...state,
      cursor: { orgId: null, threadId: null },
      updatedAt: at,
      remaining: retrying + skipped,
      status: "waiting",
      nextPassAt: Math.max(at, Number(pending?.next_at ?? at)),
    };
  } else {
    let offRuntime = 0;
    let counted = true;
    for (let orgId = await nextOrg(env, null); orgId; orgId = await nextOrg(env, orgId)) {
      try {
        offRuntime += Number(await (env.ORG.get(env.ORG.idFromName(orgId)) as unknown as { countThreadsWithoutRuntime(): Promise<number> }).countThreadsWithoutRuntime());
      } catch {
        counted = false;
      }
    }
    if (!counted || offRuntime > skipped) {
      // Threads the pass did not see (or an org it cannot count): another pass.
      done = {
        ...state,
        status: counted ? "running" : "waiting",
        pass: state.pass + 1,
        cursor: { orgId: null, threadId: null },
        counts: { ...IDLE.counts },
        updatedAt: at,
        remaining: offRuntime,
        nextPassAt: counted ? null : at + RETRY_BASE_MS,
      };
    } else {
      done = {
        ...state,
        status: "complete",
        cursor: { orgId: null, threadId: null },
        updatedAt: at,
        completedAt: at,
        nextPassAt: null,
        remaining: offRuntime,
        completedRemaining: offRuntime,
      };
    }
  }
  await saveSweepState(env, done);
  console.log("[selfhost-sweep] pass finished", {
    pass: state.pass,
    status: done.status,
    migrated: state.counts.migrated,
    skipped,
    retrying,
  });
  return done;
}
