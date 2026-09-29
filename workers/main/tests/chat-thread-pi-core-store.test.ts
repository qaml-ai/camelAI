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
  const get = vi.fn(async () => ({ text: async () => 'provider-image-data' }));
  const messageKeys = new Map<number, string>();
  const exec = vi.fn((sql: string, ...params: unknown[]) => {
    const text = sql.trimStart();
    if (text.startsWith('CREATE ') || sql.includes('INSERT OR IGNORE INTO pi_core_state')) {
      return { toArray: () => [] };
    }
    if (sql.includes('FROM pi_core_compaction')) {
      return { toArray: () => [] };
    }
    if (sql.includes('LEFT JOIN pi_core_message_keys')) {
      const firstKeptIndex = Number(params[0]);
      const limit = Number(params[1]);
      return {
        toArray: () => payloads
          .map((_, idx) => idx)
          .filter((idx) => idx >= firstKeptIndex && !messageKeys.has(idx))
          .slice(0, limit)
          .map((idx) => ({ idx })),
      };
    }
    if (
      text.startsWith('INSERT INTO pi_core_message_keys') &&
      sql.includes('SELECT idx')
    ) {
      const [keyHash, idxValue, expectedPayload] = params;
      const idx = Number(idxValue);
      if (payloads[idx] === expectedPayload) {
        messageKeys.set(idx, String(keyHash));
      }
      return { toArray: () => [] };
    }
    if (text.startsWith('INSERT INTO pi_core_message_keys')) {
      messageKeys.set(Number(params[0]), String(params[1]));
      return { toArray: () => [] };
    }
    if (sql.includes('SELECT DISTINCT keys.key_hash')) {
      const firstKeptIndex = Number(params[0]);
      const candidates = new Set(params.slice(1).map(String));
      return {
        toArray: () => Array.from(messageKeys.entries())
          .filter(([idx, hash]) => idx >= firstKeptIndex && candidates.has(hash))
          .map(([, key_hash]) => ({ key_hash })),
      };
    }
    if (sql.includes('SELECT payload FROM pi_core_messages WHERE idx = ?')) {
      const payload = payloads[Number(params[0])];
      return { toArray: () => payload === undefined ? [] : [{ payload }] };
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
  });
  return { store, get, messageKeys };
}

describe('PiCoreMessageStore image policy', () => {
  it('uses bounded render-safe markers without hydrating or leaking R2 keys', async () => {
    const privateKey = 'org-secret/workspace-secret/pi-images/object.base64';
    const harness = createReadHarness([
      JSON.stringify(externalImageMessage(privateKey)),
    ]);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({
      includeUiMetadata: true,
      imagePolicy: 'render',
    });

    expect(harness.get).not.toHaveBeenCalled();
    expect(messages[0].content).toEqual([{
      type: 'text',
      text: '(persisted image omitted from render: image/png, 900000 base64 chars)',
    }]);
    expect(JSON.stringify(messages)).not.toContain(privateKey);
    expect(JSON.stringify(messages)).not.toContain('chiridionR2Image');
  });

  it('keeps references by default without hydration or render leakage conversion', async () => {
    const privateKey = 'private/reference/image.base64';
    const harness = createReadHarness([JSON.stringify(externalImageMessage(privateKey))]);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({ includeUiMetadata: true });

    expect(harness.get).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toContain(privateKey);
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
        sql.trimStart().startsWith('CREATE ') ||
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
