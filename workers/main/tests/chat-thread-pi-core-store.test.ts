import { describe, expect, it, vi } from 'vitest';
import { PiCoreMessageStore } from '../src/chat-thread/pi-core-store';

function externalImageMessage(key = 'private/org/workspace/image.base64') {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read',
    content: [{
      type: 'image',
      mimeType: 'image/png',
      data: '',
      metadata: {
        chiridionR2Image: {
          key,
          mimeType: 'image/png',
          size: 900_000,
          sha256: 'abc123',
          storedAt: 1,
        },
      },
    }],
    isError: false,
    timestamp: 1,
  };
}

function createReadHarness(payloads: string[]) {
  const operations = { payloadRowsParsed: 0, r2ImagesHydrated: 0 };
  const get = vi.fn(async () => ({ text: async () => 'provider-image-data' }));
  const exec = vi.fn((sql: string) => {
    if (sql.trimStart().startsWith('CREATE TABLE') || sql.includes('INSERT OR IGNORE INTO pi_core_state')) {
      return { toArray: () => [] };
    }
    if (sql.includes('FROM pi_core_compaction')) {
      return { toArray: () => [] };
    }
    if (sql.includes('SELECT payload FROM pi_core_messages')) {
      return { toArray: () => payloads.map((payload) => ({ payload })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const store = new PiCoreMessageStore({
    sql: () => ({ exec }) as never,
    r2: () => ({ get }) as never,
    chatContext: () => null,
    recordReadOperation: (operation) => {
      if (operation === 'payload_row_parsed') operations.payloadRowsParsed += 1;
      if (operation === 'r2_image_hydrated') operations.r2ImagesHydrated += 1;
    },
  });
  return { store, operations, get };
}

describe('PiCoreMessageStore image hydration policy', () => {
  it('uses bounded render-safe markers without hydrating or leaking R2 keys', async () => {
    const privateKey = 'org-secret/workspace-secret/pi-images/object.base64';
    const harness = createReadHarness([
      JSON.stringify(externalImageMessage(privateKey)),
    ]);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({
      includeUiMetadata: true,
      imagePolicy: 'render',
    });

    expect(harness.operations).toEqual({
      payloadRowsParsed: 1,
      r2ImagesHydrated: 0,
    });
    expect(harness.get).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([{
      type: 'text',
      text: '(persisted image omitted from render: image/png, 900000 base64 chars)',
    }]);
    expect(JSON.stringify(messages)).not.toContain(privateKey);
    expect(JSON.stringify(messages)).not.toContain('chiridionR2Image');
  });

  it('retains provider hydration for model context reads', async () => {
    const harness = createReadHarness([
      JSON.stringify(externalImageMessage()),
    ]);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({ imagePolicy: 'provider' });

    expect(harness.operations).toEqual({
      payloadRowsParsed: 1,
      r2ImagesHydrated: 1,
    });
    expect(harness.get).toHaveBeenCalledTimes(1);
    expect(messages[0].content).toEqual([
      expect.objectContaining({ type: 'image', data: 'provider-image-data' }),
    ]);
  });

  it('keeps references by default without hydration or render leakage conversion', async () => {
    const privateKey = 'private/reference/image.base64';
    const harness = createReadHarness([JSON.stringify(externalImageMessage(privateKey))]);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({ includeUiMetadata: true });

    expect(harness.get).not.toHaveBeenCalled();
    expect(harness.operations.r2ImagesHydrated).toBe(0);
    expect(JSON.stringify(messages)).toContain(privateKey);
  });

  it('deduplicates against image-bearing history without R2 hydration', async () => {
    const harness = createReadHarness([
      JSON.stringify({
        ...externalImageMessage(),
        role: 'assistant',
        responseId: 'response-1',
      }),
    ]);
    const append = vi.spyOn(harness.store, 'appendPiCoreMessages').mockResolvedValue();

    await harness.store.appendPiCoreMessagesIfMissing([{
      role: 'assistant',
      responseId: 'response-1',
      content: [{ type: 'text', text: 'finalized' }],
      timestamp: 2,
    } as never]);

    expect(harness.operations.r2ImagesHydrated).toBe(0);
    expect(harness.get).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith([]);
  });
});

describe('PiCoreMessageStore compaction watermark', () => {
  /** A store whose pi_core rows and compaction row are both controllable, so the
   *  `first_kept_index` <-> `idx` contract can be exercised end to end. */
  function createCompactionHarness(options: {
    rowCount: number;
    compaction?: { summary: string; first_kept_index: number; updated_at: number };
  }) {
    let compaction = options.compaction ?? null;
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (
        sql.trimStart().startsWith('CREATE TABLE') ||
        sql.includes('INSERT OR IGNORE INTO pi_core_state')
      ) {
        return { toArray: () => [] };
      }
      if (sql.includes('MAX(idx) + 1')) {
        return { toArray: () => [{ next_idx: options.rowCount }] };
      }
      if (sql.includes('INSERT OR REPLACE INTO pi_core_compaction')) {
        writes.push({ sql, params });
        compaction = {
          summary: String(params[0]),
          first_kept_index: Number(params[1]),
          updated_at: Number(params[2]),
        };
        return { toArray: () => [] };
      }
      if (sql.includes('FROM pi_core_compaction')) {
        return { toArray: () => (compaction ? [compaction] : []) };
      }
      if (sql.includes('FROM pi_core_state')) {
        return { toArray: () => [{ generation: 1, row_count: options.rowCount }] };
      }
      if (sql.startsWith('UPDATE pi_core_state')) return { toArray: () => [] };
      if (sql.includes('SELECT payload FROM pi_core_messages')) {
        const from = sql.includes('WHERE idx >= ?') ? Number(params[0]) : 0;
        const rows = [];
        for (let idx = from; idx < options.rowCount; idx += 1) {
          rows.push({
            payload: JSON.stringify({ role: 'user', content: `row ${idx}`, timestamp: idx }),
          });
        }
        return { toArray: () => rows };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const store = new PiCoreMessageStore({
      sql: () => ({ exec }) as never,
      r2: () => ({ get: vi.fn() }) as never,
      chatContext: () => null,
    });
    return { store, writes, get compaction() { return compaction; } };
  }

  it('refuses a watermark the committed rows cannot satisfy', () => {
    // A cut computed over a session list that still held the uncommitted journal
    // tail names rows pi_core does not have. Writing it would make every later
    // session build load the summary and NOTHING else.
    const harness = createCompactionHarness({ rowCount: 4 });

    harness.store.persistPiCoreCompaction('summary', 9);

    expect(harness.writes).toHaveLength(0);
    expect(harness.store.loadPiCoreCompaction()).toBeNull();
  });

  it('persists a watermark inside the committed rows', () => {
    const harness = createCompactionHarness({ rowCount: 4 });

    harness.store.persistPiCoreCompaction('summary', 2);

    expect(harness.writes).toHaveLength(1);
    expect(harness.store.loadPiCoreCompaction()).toMatchObject({
      summary: 'summary',
      firstKeptIndex: 2,
    });
  });

  it('keeps the whole history when a stored watermark outruns the rows', async () => {
    // Belt and braces for rows already written by an older build (or rewritten
    // shorter by a fork): an over-large context is recoverable, a blanked one is not.
    const harness = createCompactionHarness({
      rowCount: 3,
      compaction: { summary: 'stale summary', first_kept_index: 11, updated_at: 5 },
    });

    expect(harness.store.loadPiCoreCompaction()).toMatchObject({ firstKeptIndex: 0 });
    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded();

    expect(messages.map((message) => (message as { content: unknown }).content)).toEqual([
      'row 0',
      'row 1',
      'row 2',
    ]);
  });

  it('loads the summary plus the kept tail for a valid watermark', async () => {
    const harness = createCompactionHarness({
      rowCount: 3,
      compaction: { summary: 'earlier work', first_kept_index: 2, updated_at: 5 },
    });

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded();

    expect(messages).toHaveLength(2);
    expect((messages[0] as { content: string }).content).toContain('earlier work');
    expect((messages[1] as { content: string }).content).toBe('row 2');
  });
});
