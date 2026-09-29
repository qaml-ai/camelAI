/**
 * The self-host thread sweep: move every thread still on ChatThreadDO to the
 * agent runtime with migrateThreadToRuntime, in the background, so a later
 * release can delete the in-DO loop (SELF_HOSTING.md, "Moving existing
 * threads").
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
 * `complete`: that marker, with how many threads it had to skip, is what the
 * release that deletes the in-DO loop checks before it starts
 * (scripts/selfhost-runtime-gate.mjs). A start begins a new pass, so threads
 * created on the in-DO loop since (a model without a runtime route) are found.
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import { migrateThreadToRuntime, type RuntimeMigrationResult } from "./thread-migration";

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
}

export interface SweepThreadRecord {
  threadId: string;
  orgId: string;
  workspaceId: string;
  outcome: "skipped" | "retry";
  reason: string;
  attempts: number;
  nextAttemptAt: number | null;
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
}

type SweepEnv = ChatEnv & { APP_DB?: D1Database };

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_BUDGET_MS = 20_000;
/** A thread that could not move now is tried again after 1 min, doubling, at most 1 h. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Reasons a thread will not move however often it is tried: never retried within a start. */
const PERMANENT = /^(too_large|thread deleted|not a thread of this workspace)$/;

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
      pass INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
  ]);
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
      if (result.reason === "direct threads are off") return { outcome: "blocked", reason: result.reason };
      // The DO's own backoff after a failed attempt: try again later.
      if (result.reason.startsWith("backoff")) return { outcome: "retry", reason: result.reason };
      return { outcome: "skipped", reason: result.reason };
  }
}

function retryDelay(attempts: number): number {
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

async function runPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Advance the sweep by as many pages as fit in `budgetMs` (a page is always
 * finished once begun, and the cursor saved after it). A waiting sweep whose
 * retries are due begins its next pass; a complete or blocked one does
 * nothing until the next start.
 */
export async function runSweepStep(env: SweepEnv, options: SweepOptions = {}): Promise<SweepState> {
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 16));
  const pageSize = Math.max(1, Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, 500));
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const migrate = options.migrate ?? ((stepEnv: ChatEnv, context: ChatContextState) => migrateThreadToRuntime(stepEnv, context));
  let state = await getSweepState(env);
  if (state.status === "waiting" && (state.nextPassAt ?? 0) <= now()) {
    state = { ...state, status: "running", pass: state.pass + 1, cursor: { orgId: null, threadId: null }, counts: { ...IDLE.counts }, nextPassAt: null };
  }
  if (state.status !== "running") return state;
  const started = now();

  while (now() - started < budgetMs) {
    const orgId = state.cursor.orgId ?? await nextOrg(env, null);
    if (!orgId) {
      state = await finishPass(env, state, now());
      break;
    }
    const org = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgSweepStub;
    const page = await org.listThreadsWithoutRuntime(state.cursor.threadId, pageSize);
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
    const due = page.filter((thread) => {
      const record = known.get(thread.id);
      if (!record) return true;
      if (record.outcome === "retry") return (record.nextAttemptAt ?? 0) <= now();
      // Skipped: a thread that cannot move stays skipped until the next start
      // (its model or the install's settings may change by then), unless it never can.
      return !PERMANENT.test(record.reason) && record.pass < state.startPass;
    });
    // Records of threads this pass saw but does not try now are still current:
    // the pass's end drops the others (threads moved on open, or deleted).
    const waiting = page.filter((thread) => known.has(thread.id) && !due.includes(thread));
    if (waiting.length > 0) {
      await db(env).prepare(`UPDATE ${THREADS_TABLE} SET pass = ? WHERE thread_id IN (${waiting.map(() => "?").join(", ")})`)
        .bind(state.pass, ...waiting.map((thread) => thread.id)).run();
    }
    let blocked: string | null = null;
    await runPool(due, concurrency, async (thread) => {
      if (blocked) return;
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
        classified = classifyMigration(await migrate(env, context));
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
        await db(env).prepare(`DELETE FROM ${THREADS_TABLE} WHERE thread_id = ?`).bind(thread.id).run();
        console.log("[selfhost-sweep] moved thread to the runtime", { orgId, threadId: thread.id });
        return;
      }
      const attempts = (known.get(thread.id)?.attempts ?? 0) + 1;
      const nextAttemptAt = classified.outcome === "retry" ? at + retryDelay(attempts) : null;
      if (classified.outcome === "retry") state.counts.retrying += 1;
      else state.counts.skipped += 1;
      await db(env)
        .prepare(`INSERT OR REPLACE INTO ${THREADS_TABLE} (thread_id, org_id, workspace_id, outcome, reason, attempts, next_attempt_at, pass, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(thread.id, orgId, thread.workspace_id, classified.outcome, classified.reason.slice(0, 500), attempts, nextAttemptAt, state.pass, at)
        .run();
      console.warn(`[selfhost-sweep] thread ${classified.outcome === "retry" ? "will be retried" : "skipped"}`, {
        orgId,
        threadId: thread.id,
        reason: classified.reason,
      });
    });
    if (blocked) {
      state = { ...state, status: "blocked", error: blocked, updatedAt: now() };
      await saveSweepState(env, state);
      return state;
    }
    state.cursor = { orgId, threadId: page[page.length - 1].id };
    state.updatedAt = now();
    await saveSweepState(env, state);
  }
  return state;
}

/**
 * A pass walked every org: complete when nothing is left to retry (skipped
 * threads are counted in `remaining`), else waiting for the earliest retry.
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
  const done: SweepState = {
    ...state,
    cursor: { orgId: null, threadId: null },
    updatedAt: at,
    remaining: retrying + skipped,
    ...(retrying > 0
      ? { status: "waiting" as const, nextPassAt: Math.max(at, Number(pending?.next_at ?? at)) }
      : { status: "complete" as const, completedAt: at, nextPassAt: null }),
  };
  await saveSweepState(env, done);
  console.log("[selfhost-sweep] pass finished", {
    pass: done.pass,
    status: done.status,
    migrated: done.counts.migrated,
    skipped,
    retrying,
  });
  return done;
}
