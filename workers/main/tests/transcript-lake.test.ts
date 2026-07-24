import { describe, expect, it, vi } from 'vitest';
import {
  TranscriptLakeMirror,
  piCoreRowToLakeRecord,
  projectPiContentForLake,
  __testing,
} from '../src/chat-thread/transcript-lake';
import { LAKE_TEXT_MAX_CHARS, type PiMessageLakeRecord } from '../src/lake-streams';
import { PiCoreMessageStore } from '../src/chat-thread/pi-core-store';

const CONTEXT = {
  threadId: 'thread-1',
  workspaceId: 'workspace-1',
  orgId: 'org-1',
  userId: 'user-1',
  userName: null,
  userEmail: null,
};

interface FakeRow {
  idx: number;
  payload: string;
  created_at: number;
}

function createMirrorHarness(
  rows: FakeRow[],
  options: { send?: (records: PiMessageLakeRecord[]) => Promise<void>; withBinding?: boolean } = {},
) {
  const kvStore = new Map<string, unknown>();
  const sent: PiMessageLakeRecord[][] = [];
  const send = options.send
    ?? (async (records: PiMessageLakeRecord[]) => {
      sent.push(records);
    });
  const exec = vi.fn((sql: string, ...args: unknown[]) => {
    if (sql.includes('WHERE idx >= ?')) {
      const [mark, limit] = args as [number, number];
      return { toArray: () => rows.filter((row) => row.idx >= mark).slice(0, limit) };
    }
    if (sql.includes('WHERE idx = ?')) {
      const [idx] = args as [number];
      const row = rows.find((candidate) => candidate.idx === idx);
      return { toArray: () => (row ? [{ created_at: row.created_at }] : []) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const mirror = new TranscriptLakeMirror({
    sql: () => ({ exec }) as never,
    kv: () => ({
      get: <T>(key: string) => kvStore.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        kvStore.set(key, value);
      },
    }),
    chatContext: () => CONTEXT,
    env: () => (options.withBinding === false ? {} : { TRANSCRIPT_LAKE: { send } }),
    withMemoryPhase: (_operation, fn) => fn(),
    recordChatThreadObservabilityEvent: () => {},
  });
  return { mirror, sent, kvStore, exec };
}

function userRow(idx: number, text: string, createdAt = 1_000 + idx): FakeRow {
  return {
    idx,
    payload: JSON.stringify({ role: 'user', content: text, timestamp: createdAt }),
    created_at: createdAt,
  };
}

describe('projectPiContentForLake', () => {
  it('keeps text and thinking but never image bytes', () => {
    const projected = projectPiContentForLake([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'pondering' },
      { type: 'image', mimeType: 'image/png', data: 'AAAABBBBCCCC-image-bytes' },
      { type: 'toolCall', name: 'deploy_project', id: 'call-1' },
    ]);
    expect(projected.text).toBe('hello\npondering\n[toolCall:deploy_project]');
    expect(projected.text).not.toContain('image-bytes');
    expect(projected.imageCount).toBe(1);
  });

  it('passes plain string content through', () => {
    expect(projectPiContentForLake('just text')).toEqual({ text: 'just text', imageCount: 0 });
  });
});

describe('piCoreRowToLakeRecord', () => {
  it('surfaces the stamped tool duration and tool identity as flat columns', () => {
    const row: FakeRow = {
      idx: 7,
      created_at: 5_000,
      payload: JSON.stringify({
        role: 'toolResult',
        toolCallId: 'call-9',
        toolName: 'deploy_project',
        isError: true,
        timestamp: 4_900,
        content: [{ type: 'text', text: 'boom' }],
        uiMetadata: { toolDurationMs: 1234, renderMessageId: 'turn-1' },
      }),
    };
    const record = piCoreRowToLakeRecord(row, CONTEXT, 9_999);
    expect(record).toMatchObject({
      idx: 7,
      role: 'toolResult',
      tool_name: 'deploy_project',
      tool_call_id: 'call-9',
      tool_is_error: true,
      tool_duration_ms: 1234,
      render_message_id: 'turn-1',
      ts_ms: 4_900,
      ingested_at_ms: 9_999,
      thread_id: 'thread-1',
      org_id: 'org-1',
      text: 'boom',
    });
  });

  it('reports -1 rather than 0 when no duration was measured', () => {
    const record = piCoreRowToLakeRecord(userRow(0, 'hi'), CONTEXT, 1);
    expect(record?.tool_duration_ms).toBe(-1);
  });

  it('truncates oversized text but keeps the true length queryable', () => {
    const long = 'x'.repeat(LAKE_TEXT_MAX_CHARS + 500);
    const record = piCoreRowToLakeRecord(userRow(0, long), CONTEXT, 1);
    expect(record?.text).toHaveLength(LAKE_TEXT_MAX_CHARS);
    expect(record?.text_chars).toBe(LAKE_TEXT_MAX_CHARS + 500);
    expect(record?.text_truncated).toBe(true);
  });

  it('skips corrupt rows instead of failing the batch', () => {
    expect(piCoreRowToLakeRecord({ idx: 0, payload: 'not json', created_at: 1 }, CONTEXT, 1))
      .toBeNull();
  });
});

describe('TranscriptLakeMirror', () => {
  it('does nothing when no stream binding is configured', async () => {
    const harness = createMirrorHarness([userRow(0, 'hi')], { withBinding: false });
    await harness.mirror.syncTranscriptLake();
    expect(harness.sent).toHaveLength(0);
    expect(harness.exec).not.toHaveBeenCalled();
  });

  it('exports pending rows once and advances the high-water mark', async () => {
    const harness = createMirrorHarness([userRow(0, 'one'), userRow(1, 'two')]);
    await harness.mirror.syncTranscriptLake();
    expect(harness.sent.flat().map((record) => record.idx)).toEqual([0, 1]);
    expect(harness.kvStore.get(__testing.TRANSCRIPT_LAKE_MARK_KEY)).toBe(2);

    await harness.mirror.syncTranscriptLake();
    expect(harness.sent.flat()).toHaveLength(2);
  });

  it('leaves the mark behind on a failed send so the range re-sends', async () => {
    let fail = true;
    const harness = createMirrorHarness([userRow(0, 'one')], {
      send: async () => {
        if (fail) throw new Error('stream unavailable');
      },
    });
    await harness.mirror.syncTranscriptLake();
    expect(harness.kvStore.get(__testing.TRANSCRIPT_LAKE_MARK_KEY)).toBeUndefined();

    fail = false;
    await harness.mirror.syncTranscriptLake();
    expect(harness.kvStore.get(__testing.TRANSCRIPT_LAKE_MARK_KEY)).toBe(1);
  });

  it('re-exports the whole thread when pi_core history was rewritten underneath it', async () => {
    const rows = [userRow(0, 'one', 1_000), userRow(1, 'two', 1_001)];
    const harness = createMirrorHarness(rows);
    await harness.mirror.syncTranscriptLake();
    expect(harness.kvStore.get(__testing.TRANSCRIPT_LAKE_MARK_KEY)).toBe(2);

    // replacePiCoreMessages (compaction / fork / admin repair) rewrites every
    // row with a fresh created_at, invalidating the mark's anchor row.
    rows.splice(0, rows.length, userRow(0, 'compacted', 7_000), userRow(1, 'two', 7_000));
    await harness.mirror.syncTranscriptLake();
    expect(harness.sent[1].map((record) => record.idx)).toEqual([0, 1]);
    expect(harness.sent[1][0].text).toBe('compacted');
  });

  it('caps a single sync so a long backfill stays resumable', async () => {
    const rows = Array.from(
      { length: __testing.TRANSCRIPT_LAKE_MAX_ROWS_PER_SYNC + 10 },
      (_row, idx) => userRow(idx, `m${idx}`),
    );
    const harness = createMirrorHarness(rows);
    await harness.mirror.syncTranscriptLake();
    expect(harness.sent.flat()).toHaveLength(__testing.TRANSCRIPT_LAKE_MAX_ROWS_PER_SYNC);
    expect(harness.kvStore.get(__testing.TRANSCRIPT_LAKE_MARK_KEY))
      .toBe(__testing.TRANSCRIPT_LAKE_MAX_ROWS_PER_SYNC);

    await harness.mirror.syncTranscriptLake();
    expect(harness.sent.flat()).toHaveLength(rows.length);
  });
});

describe('PiCoreMessageStore tool duration stamping', () => {
  function createAppendHarness(durations: Map<string, number>) {
    const inserted: string[] = [];
    const exec = vi.fn((sql: string, ...args: unknown[]) => {
      if (sql.trimStart().startsWith('CREATE TABLE') || sql.includes('INSERT OR IGNORE')) {
        return { toArray: () => [] };
      }
      if (sql.includes('FROM pi_core_state')) {
        return { toArray: () => [{ generation: 1, row_count: inserted.length }] };
      }
      if (sql.includes('UPDATE pi_core_state')) return { toArray: () => [] };
      if (sql.includes('next_idx')) return { toArray: () => [{ next_idx: inserted.length }] };
      if (sql.includes('INSERT INTO pi_core_messages')) {
        inserted.push(args[1] as string);
        return { toArray: () => [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const store = new PiCoreMessageStore({
      sql: () => ({ exec }) as never,
      r2: () => ({}) as never,
      chatContext: () => CONTEXT,
      takeToolDurationMs: (toolCallId) => {
        const value = durations.get(toolCallId);
        durations.delete(toolCallId);
        return value;
      },
    });
    return { store, inserted };
  }

  it('stamps the measured duration onto the toolResult row it belongs to', async () => {
    const harness = createAppendHarness(new Map([['call-1', 4321]]));
    await harness.store.appendPiCoreMessages([
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 1,
      },
    ] as never);
    expect(JSON.parse(harness.inserted[0]).uiMetadata).toMatchObject({ toolDurationMs: 4321 });
  });

  it('leaves rows untouched when no duration was measured', async () => {
    const harness = createAppendHarness(new Map());
    await harness.store.appendPiCoreMessages([
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 'unmeasured',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: 2,
      },
    ] as never);
    expect(JSON.parse(harness.inserted[0]).uiMetadata).toBeUndefined();
    expect(JSON.parse(harness.inserted[1]).uiMetadata).toBeUndefined();
  });
});
