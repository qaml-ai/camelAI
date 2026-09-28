// Transactional outbox for the Durable Object -> D1 identity mirror.
//
// A DO that owns mirrored facts (UserDO, OrgDO) marks the affected entity dirty
// in the SAME storage transaction as the fact write: call `markDirty` inside the
// `transactionSync` callback, or right after the write with no `await` between
// them (synchronous SQLite writes between awaits commit as one implicit
// transaction). The outbox row therefore exists iff the fact write committed.
//
// The DO alarm drains the outbox: for each dirty entity it reads the entity's
// CURRENT state (a synchronous snapshot), stamps it with a version from a
// per-DO monotonic clock, and applies it to D1 with versioned upserts (see
// `mirror_rows` in app-index-db.ts). Because a drain always mirrors current
// state, repeated writes to one entity coalesce into one row and a retry can
// never replay a stale payload; because versions are monotonic, a late drain
// can never regress D1. Failures back off exponentially per row.
//
// Append-only facts that have no current-state row (chat error events) are
// enqueued with their payload via `enqueueEvent`; D1 inserts them idempotently.

import type { AdminEventType } from "../admin-index-types";
import type { AppIndexDatabase } from "../app-index-db";
import { recordObservabilityEvent, type ObservabilityEnv } from "../observability";

export type MirrorKind =
  | "user"
  | "org"
  | "workspace"
  | "thread"
  | "app"
  | "invitation"
  | "org_membership"
  | "workspace_member";

/**
 * Reads one dirty entity's current state as the events that mirror it: an
 * upsert while it exists, a delete once it is gone, or `[]` when there is
 * nothing to mirror. Must be synchronous so the snapshot and its version are
 * taken atomically.
 */
export type MirrorSnapshot = (kind: MirrorKind, id: string) => AdminEventType[];

export interface MirrorDrainOptions {
  maxRows?: number;
  /** Drain rows still inside their coalescing or retry delay too (backfill/bootstrap). */
  ignoreSchedule?: boolean;
  budgetMs?: number;
  observability?: ObservabilityEnv;
  component?: string;
}

export interface MirrorDrainResult {
  applied: number;
  failed: number;
  remaining: number;
}

type OutboxRow = {
  key: string;
  kind: string;
  entity_id: string;
  payload: string | null;
  generation: number;
  attempts: number;
};

/** Delay before a freshly dirtied entity is drained, so write bursts coalesce. */
export const MIRROR_COALESCE_MS = 1_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_BUDGET_MS = 15_000;
/** Stop a drain after this many consecutive failures: D1 is likely down. */
const MAX_CONSECUTIVE_FAILURES = 3;

export function mirrorRetryDelayMs(attempts: number): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  // +-20% jitter so a fleet of DOs does not retry in lockstep after an outage.
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

export class D1MirrorOutbox {
  private readonly sql: SqlStorage;
  /** Earliest alarm this instance knows is armed; null = unknown. */
  private armedAt: number | null = null;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
  }

  ensureSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS d1_mirror_outbox (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT,
        generation INTEGER NOT NULL DEFAULT 1,
        enqueued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_d1_mirror_outbox_due ON d1_mirror_outbox(next_attempt_at)",
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS d1_mirror_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      )
    `);
  }

  /**
   * Record that `kind`/`id` changed. Synchronous: call it in the same storage
   * transaction as the fact write. Re-dirtying an entity that is already queued
   * keeps one row; a row in retry backoff keeps its backoff.
   */
  markDirty(kind: MirrorKind, id: string): void {
    const now = Date.now();
    const dueAt = now + MIRROR_COALESCE_MS;
    this.sql.exec(
      `INSERT INTO d1_mirror_outbox (key, kind, entity_id, payload, generation, enqueued_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, NULL, 1, ?, 0, ?)
       ON CONFLICT(key) DO UPDATE SET
         generation = d1_mirror_outbox.generation + 1,
         next_attempt_at = CASE
           WHEN d1_mirror_outbox.attempts > 0 THEN d1_mirror_outbox.next_attempt_at
           ELSE MIN(d1_mirror_outbox.next_attempt_at, excluded.next_attempt_at)
         END`,
      `${kind}:${id}`,
      kind,
      id,
      now,
      dueAt,
    );
    this.arm(dueAt);
  }

  /** Queue an append-only event (no current-state row to snapshot). */
  enqueueEvent(event: AdminEventType): void {
    const now = Date.now();
    const dueAt = now + MIRROR_COALESCE_MS;
    this.sql.exec(
      `INSERT INTO d1_mirror_outbox (key, kind, entity_id, payload, generation, enqueued_at, attempts, next_attempt_at)
       VALUES (?, 'event', '', ?, 1, ?, 0, ?)`,
      `event:${crypto.randomUUID()}`,
      JSON.stringify(event),
      now,
      dueAt,
    );
    this.arm(dueAt);
  }

  /** When the next outbox row is due, or null when the outbox is empty. */
  nextDueAt(): number | null {
    const row = this.sql
      .exec<{ due: number | null }>("SELECT MIN(next_attempt_at) AS due FROM d1_mirror_outbox")
      .toArray()[0];
    return typeof row?.due === "number" ? row.due : null;
  }

  /** Drop everything queued (the owning entity was hard-deleted). */
  clear(): void {
    this.sql.exec("DELETE FROM d1_mirror_outbox");
  }

  /** Outbox keys (`kind:id`) still waiting to reach D1: in flight, not drift. */
  pendingKeys(): string[] {
    return this.sql
      .exec<{ key: string }>("SELECT key FROM d1_mirror_outbox WHERE kind != 'event'")
      .toArray()
      .map((row) => row.key);
  }

  pendingCount(): number {
    const row = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM d1_mirror_outbox")
      .toArray()[0];
    return Number(row?.count ?? 0);
  }

  stats(): { pending: number; failing: number; oldestEnqueuedAt: number | null; nextDueAt: number | null } {
    const row = this.sql
      .exec<{ pending: number; failing: number; oldest: number | null }>(
        `SELECT COUNT(*) AS pending,
                COALESCE(SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END), 0) AS failing,
                MIN(enqueued_at) AS oldest
           FROM d1_mirror_outbox`,
      )
      .toArray()[0];
    return {
      pending: Number(row?.pending ?? 0),
      failing: Number(row?.failing ?? 0),
      oldestEnqueuedAt: typeof row?.oldest === "number" ? row.oldest : null,
      nextDueAt: this.nextDueAt(),
    };
  }

  /** Next version from this DO's monotonic clock (microsecond wall time, never repeating). */
  nextVersion(): number {
    const last = this.sql
      .exec<{ version: number }>("SELECT version FROM d1_mirror_clock WHERE id = 1")
      .toArray()[0]?.version;
    const next = Math.max(Date.now() * 1000, Number(last ?? 0) + 1);
    this.sql.exec(
      "INSERT INTO d1_mirror_clock (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
      next,
    );
    return next;
  }

  /**
   * The alarm handler calls this before draining: whatever alarm was armed has
   * fired, so the next `markDirty` must arm again.
   */
  noteAlarmFired(): void {
    this.armedAt = null;
  }

  /**
   * Apply due rows to D1. Never throws: failures are recorded on the row with
   * backoff. The caller reschedules the alarm from `nextDueAt()` afterwards.
   */
  async drain(
    db: AppIndexDatabase | null,
    snapshot: MirrorSnapshot,
    options: MirrorDrainOptions = {},
  ): Promise<MirrorDrainResult> {
    if (!db) {
      // No APP_DB binding: nothing can ever drain, so do not let the outbox grow.
      this.sql.exec("DELETE FROM d1_mirror_outbox");
      return { applied: 0, failed: 0, remaining: 0 };
    }

    const startedAt = Date.now();
    const deadline = startedAt + (options.budgetMs ?? DEFAULT_BUDGET_MS);
    const rows = this.sql
      .exec<OutboxRow>(
        `SELECT key, kind, entity_id, payload, generation, attempts
           FROM d1_mirror_outbox
          WHERE next_attempt_at <= ?
          ORDER BY next_attempt_at ASC, enqueued_at ASC
          LIMIT ?`,
        options.ignoreSchedule ? Number.MAX_SAFE_INTEGER : startedAt,
        options.maxRows ?? DEFAULT_MAX_ROWS,
      )
      .toArray();

    let applied = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    for (const row of rows) {
      if (Date.now() > deadline) break;
      try {
        // Snapshot and version are taken together, synchronously.
        const events = row.payload
          ? [JSON.parse(row.payload) as AdminEventType]
          : snapshot(row.kind as MirrorKind, row.entity_id);
        const version = events.length > 0 ? this.nextVersion() : 0;
        for (const event of events) {
          await db.applyAdminEvent(row.payload ? event : { ...event, version });
        }
        // A write that re-dirtied the row mid-drain bumped its generation: keep it.
        this.sql.exec(
          "DELETE FROM d1_mirror_outbox WHERE key = ? AND generation = ?",
          row.key,
          row.generation,
        );
        applied += 1;
        consecutiveFailures = 0;
      } catch (error) {
        failed += 1;
        consecutiveFailures += 1;
        const attempts = row.attempts + 1;
        const retryAt = Date.now() + mirrorRetryDelayMs(attempts);
        const message = error instanceof Error ? error.message : String(error);
        this.sql.exec(
          "UPDATE d1_mirror_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE key = ?",
          attempts,
          retryAt,
          message.slice(0, 1000),
          row.key,
        );
        recordObservabilityEvent(options.observability, {
          event: "d1_mirror_drain_failed",
          severity: attempts >= 5 ? "error" : "warn",
          component: options.component ?? "d1_mirror_outbox",
          operation: row.kind,
          status: "retry",
          errorMessage: message,
          count: attempts,
          sampleIndex: row.kind,
        });
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          // D1 is likely unavailable. Push every other due row behind this
          // backoff so the rescheduled alarm does not spin on them.
          this.sql.exec(
            "UPDATE d1_mirror_outbox SET next_attempt_at = ? WHERE next_attempt_at < ?",
            retryAt,
            retryAt,
          );
          break;
        }
      }
    }

    return { applied, failed, remaining: this.pendingCount() };
  }

  /**
   * Drain everything queued, ignoring coalescing and backoff delays, until the
   * outbox is empty or a pass fails (bootstrap, backfill and tests).
   */
  async drainAll(
    db: AppIndexDatabase | null,
    snapshot: MirrorSnapshot,
    options: MirrorDrainOptions = {},
    maxPasses = 50,
  ): Promise<MirrorDrainResult> {
    const total: MirrorDrainResult = { applied: 0, failed: 0, remaining: this.pendingCount() };
    for (let pass = 0; pass < maxPasses && total.remaining > 0; pass += 1) {
      const step = await this.drain(db, snapshot, { ...options, ignoreSchedule: true });
      total.applied += step.applied;
      total.failed += step.failed;
      total.remaining = step.remaining;
      if (step.failed > 0 || step.applied === 0) break;
    }
    return total;
  }

  private arm(dueAt: number): void {
    if (this.armedAt !== null && this.armedAt <= dueAt) return;
    this.armedAt = dueAt;
    const storage = this.storage;
    void (async () => {
      const current = await storage.getAlarm();
      if (current === null || current > dueAt) {
        await storage.setAlarm(dueAt);
      }
    })().catch((error) => {
      this.armedAt = null;
      console.error("[d1-mirror] failed to arm outbox alarm", error);
    });
  }
}

/**
 * Earliest of the given alarm candidates, never in the past. A DO that shares
 * its alarm between concerns passes every concern's next due time, including
 * `outbox.nextDueAt()`, so rescheduling one concern never starves another.
 */
export async function scheduleEarliestAlarm(
  storage: DurableObjectStorage,
  candidates: Array<number | null>,
): Promise<void> {
  const due = candidates.filter((time): time is number => typeof time === "number");
  if (due.length === 0) {
    await storage.deleteAlarm();
    return;
  }
  await storage.setAlarm(Math.max(Date.now() + 1, Math.min(...due)));
}
