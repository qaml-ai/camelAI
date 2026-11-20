import { describe, expect, it } from 'vitest';
import { AppIndexDatabase } from '../src/app-index-db';

/**
 * A D1 stand-in whose statements matching `broken` fail, as the old
 * `workspace_members` table (no org_id) failed `CREATE INDEX ... (org_id)` in
 * prod: a batch fails as a whole, naming no statement.
 */
function fakeD1(broken: RegExp, options: {
  batchFailsOnce?: boolean;
  columns?: Record<string, string[]>;
  error?: string;
} = {}) {
  const ran: string[] = [];
  let batchFails = options.batchFailsOnce ?? false;
  let failing = true;
  const fail = (sql: string) => failing && broken.test(sql);
  const statement = (sql: string) => ({
    sql,
    bind: () => statement(sql),
    run: async () => {
      ran.push(sql);
      if (fail(sql)) throw new Error(options.error ?? 'D1_ERROR: no such column: org_id: SQLITE_ERROR');
      return { success: true, results: [] };
    },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ sql: string }>) => {
      if (batchFails) {
        batchFails = false;
        throw new Error('D1_ERROR: internal error; reference = test');
      }
      if (statements.some((entry) => fail(entry.sql))) throw new Error('D1_ERROR: no such column: org_id: SQLITE_ERROR');
      ran.push(...statements.map((entry) => entry.sql));
      return statements.map(({ sql }) => {
        const table = /^PRAGMA table_info\((\w+)\)$/.exec(sql)?.[1];
        const columns = table ? options.columns?.[table] ?? [] : [];
        return { success: true, results: columns.map((name) => ({ name })) };
      });
    },
  };
  return { db, ran, repair: () => { failing = false; } };
}

function recordingDataset() {
  const points: Array<{ blobs?: unknown[] }> = [];
  return {
    points,
    dataset: { writeDataPoint: (point: { blobs?: unknown[] }) => points.push(point) } as unknown as AnalyticsEngineDataset,
  };
}

describe('AppIndexDatabase.ensureSchema', () => {
  it('names the statement that failed, in its error and in an AE error event', async () => {
    const { db } = fakeD1(/idx_workspace_members_user/);
    const events = recordingDataset();
    const errors = recordingDataset();
    const index = new AppIndexDatabase(db as never, { OBSERVABILITY_EVENTS: events.dataset, ERROR_ANALYTICS: errors.dataset });

    const failure = await index.ensureSchema().then(() => null, (error: unknown) => error as Error);

    expect(failure?.message).toContain('CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, org_id)');
    expect(failure?.message).toContain('no such column: org_id');
    const event = events.points.find((point) => point.blobs?.[0] === 'app_index_schema_failed');
    expect(event?.blobs?.[1]).toBe('error');
    expect(event?.blobs?.[2]).toBe('app_index_db');
    expect(String(event?.blobs?.[16])).toContain('idx_workspace_members_user');
    expect(errors.points.some((point) => point.blobs?.[0] === 'app_index_schema_failed')).toBe(true);
  });

  it('tries again on the next call instead of keeping the failure', async () => {
    const { db, repair } = fakeD1(/idx_workspace_members_user/);
    const index = new AppIndexDatabase(db as never);

    await expect(index.ensureSchema()).rejects.toThrow(/idx_workspace_members_user/);
    repair();
    await expect(index.ensureSchema()).resolves.toBeUndefined();
  });

  it('names a failing statement after the batch, too', async () => {
    const { db } = fakeD1(/idx_threads_chat_error_updated_at/);
    const events = recordingDataset();
    const index = new AppIndexDatabase(db as never, { OBSERVABILITY_EVENTS: events.dataset });

    await expect(index.ensureSchema()).rejects.toThrow(/idx_threads_chat_error_updated_at/);
    expect(events.points.some((point) => String(point.blobs?.[16]).includes('idx_threads_chat_error_updated_at'))).toBe(true);
  });

  it('adds only absent columns and tolerates another isolate adding the same one', async () => {
    const { db, ran } = fakeD1(/ADD COLUMN billing_plan /, {
      columns: { apps: ['project_id'], threads: ['first_user_message_preview'] },
      error: 'D1_ERROR: duplicate column name: billing_plan: SQLITE_ERROR',
    });
    const index = new AppIndexDatabase(db as never);

    await expect(index.ensureSchema()).resolves.toBeUndefined();

    expect(ran).not.toContain('ALTER TABLE apps ADD COLUMN project_id TEXT');
    expect(ran).not.toContain('ALTER TABLE threads ADD COLUMN first_user_message_preview TEXT');
    expect(ran).toContain('ALTER TABLE orgs ADD COLUMN billing_plan TEXT');
    expect(ran).toContain('ALTER TABLE threads ADD COLUMN chat_error_count INTEGER NOT NULL DEFAULT 0');
  });

  it('propagates other column migration failures and retries on the next call', async () => {
    const { db, repair } = fakeD1(/ADD COLUMN billing_plan /);
    const index = new AppIndexDatabase(db as never);

    await expect(index.ensureSchema()).rejects.toThrow(/ALTER TABLE orgs ADD COLUMN billing_plan TEXT/);
    repair();
    await expect(index.ensureSchema()).resolves.toBeUndefined();
  });

  it('takes a batch D1 failed on its own as done when each statement then succeeds', async () => {
    const { db, ran } = fakeD1(/^$/, { batchFailsOnce: true });
    const events = recordingDataset();
    const index = new AppIndexDatabase(db as never, { OBSERVABILITY_EVENTS: events.dataset });

    await expect(index.ensureSchema()).resolves.toBeUndefined();
    expect(ran.some((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS users'))).toBe(true);
    expect(events.points.some((point) => point.blobs?.[0] === 'app_index_schema_failed')).toBe(false);
  });
});
