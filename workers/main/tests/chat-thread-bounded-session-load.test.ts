import { describe, expect, it, vi } from 'vitest';
import {
  PiCoreMessageStore,
  PI_SESSION_INLINE_IMAGE_MAX_CHARS,
} from '../src/chat-thread/pi-core-store';
import { piCoreMessageKey } from '../src/chat-thread/pi-message-helpers';
import { createPiSummaryMessage } from '../src/chat-thread/pi-compaction';
import { ChatThreadDO } from '../src/chat-thread-do';

/**
 * A pi_core SQLite stand-in that answers the exact statements the store issues,
 * over a real in-memory row table. The bounded loader's whole contract is
 * "decide from metadata, then materialize only what you decided", so the harness
 * has to serve `length(payload)` / `SUM(length(payload))` honestly and count how
 * many payload bodies were actually selected — a mock that returned every row for
 * every query would let an unbounded regression pass.
 */
function createSqlHarness(rows: Array<{ idx: number; payload: string }>) {
  let compaction:
    | { summary: string; first_kept_index: number; updated_at: number }
    | null = null;
  const counters = { payloadBodyRowsSelected: 0, metadataQueries: 0 };
  const exec = vi.fn((sql: string, ...params: unknown[]) => {
    const text = sql.trimStart();
    if (
      text.startsWith('CREATE ') ||
      text.includes('INSERT OR IGNORE INTO pi_core_state') ||
      text.startsWith('UPDATE pi_core_state')
    ) {
      return { toArray: () => [] };
    }
    if (text.includes('INSERT OR REPLACE INTO pi_core_compaction')) {
      compaction = {
        summary: String(params[0]),
        first_kept_index: Number(params[1]),
        updated_at: Number(params[2]),
      };
      return { toArray: () => [] };
    }
    if (text.startsWith('DELETE FROM pi_core_compaction')) {
      compaction = null;
      return { toArray: () => [] };
    }
    if (text.includes('FROM pi_core_compaction')) {
      return { toArray: () => (compaction ? [compaction] : []) };
    }
    if (text.includes('FROM pi_core_state')) {
      return { toArray: () => [{ generation: 1, row_count: rows.length }] };
    }
    if (text.includes('MAX(idx) + 1')) {
      const maxIdx = rows.reduce((max, row) => Math.max(max, row.idx), -1);
      return { toArray: () => [{ next_idx: maxIdx + 1 }] };
    }
    if (text.includes('COUNT(*) AS visible_rows')) {
      counters.metadataQueries += 1;
      const visible = rows.filter((row) => row.idx >= Number(params[0]));
      return {
        toArray: () => [{
          visible_rows: visible.length,
          visible_chars: visible.reduce((total, row) => total + row.payload.length, 0),
        }],
      };
    }
    if (text.includes('length(payload) AS chars')) {
      counters.metadataQueries += 1;
      const [minIdx, beforeIdx, limit] = params.map(Number);
      return {
        toArray: () =>
          rows
            .filter((row) => row.idx >= minIdx && row.idx < beforeIdx)
            .sort((left, right) => right.idx - left.idx)
            .slice(0, limit)
            .map((row) => ({ idx: row.idx, chars: row.payload.length })),
      };
    }
    if (text.includes('SELECT idx, payload FROM pi_core_messages')) {
      const selected = rows
        .filter((row) => row.idx >= Number(params[0]))
        .sort((left, right) => left.idx - right.idx);
      counters.payloadBodyRowsSelected += selected.length;
      return { toArray: () => selected };
    }
    if (text.includes('SELECT payload FROM pi_core_messages')) {
      const from = text.includes('WHERE idx >= ?') ? Number(params[0]) : 0;
      const selected = rows
        .filter((row) => row.idx >= from)
        .sort((left, right) => left.idx - right.idx);
      counters.payloadBodyRowsSelected += selected.length;
      return { toArray: () => selected.map((row) => ({ payload: row.payload })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return {
    exec,
    counters,
    setCompaction(next: { summary: string; firstKeptIndex: number; updatedAt: number }) {
      compaction = {
        summary: next.summary,
        first_kept_index: next.firstKeptIndex,
        updated_at: next.updatedAt,
      };
    },
    get compaction() {
      return compaction;
    },
  };
}

function createStoreHarness(rows: Array<{ idx: number; payload: string }>) {
  const sql = createSqlHarness(rows);
  const r2Objects = new Map<string, string>();
  const puts: string[] = [];
  const r2 = {
    put: vi.fn(async (key: string, value: string) => {
      puts.push(key);
      r2Objects.set(key, value);
    }),
    head: vi.fn(async (key: string) =>
      r2Objects.has(key) ? { key, size: r2Objects.get(key)!.length } : null,
    ),
    get: vi.fn(async (key: string) => {
      const value = r2Objects.get(key);
      return value ? { size: value.length, text: async () => value } : null;
    }),
  };
  const operations = {
    payloadRowsParsed: 0,
    sessionImagesExternalized: 0,
    sessionImagesRestored: 0,
    sessionImageRestoreFailures: 0,
    providerImagesOmitted: 0,
  };
  const store = new PiCoreMessageStore({
    sql: () => ({ exec: sql.exec }) as never,
    transactionSync: (callback) => callback(),
    r2: () => r2 as never,
    chatContext: () => ({
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    }) as never,
    recordReadOperation: (operation) => {
      if (operation === 'payload_row_parsed') operations.payloadRowsParsed += 1;
      if (operation === 'session_image_externalized') {
        operations.sessionImagesExternalized += 1;
      }
      if (operation === 'session_image_restored') operations.sessionImagesRestored += 1;
      if (operation === 'session_image_restore_failed') {
        operations.sessionImageRestoreFailures += 1;
      }
      if (operation === 'provider_image_omitted') operations.providerImagesOmitted += 1;
    },
  });
  return { store, sql, r2, puts, operations };
}

function textRow(idx: number, role: 'user' | 'assistant', text: string) {
  return {
    idx,
    payload: JSON.stringify(
      role === 'user'
        ? { role, content: text, timestamp: 1000 + idx }
        : {
            role,
            content: [{ type: 'text', text }],
            responseId: `resp_${idx}`,
            timestamp: 1000 + idx,
          },
    ),
  };
}

/** A Salix-shaped thread: thousands of ordinary text rows, no images at all. */
function salixShapedRows(count: number, charsPerRow: number) {
  return Array.from({ length: count }, (_, index) =>
    textRow(
      index,
      index % 2 === 0 ? 'user' : 'assistant',
      `turn ${index} ${'x'.repeat(charsPerRow)}`,
    ),
  );
}

describe('bounded session load — under the cap', () => {
  it('returns exactly what the legacy full load returns', async () => {
    const rows = salixShapedRows(24, 200);
    const bounded = createStoreHarness(rows);
    const legacy = createStoreHarness(rows);

    const window = await bounded.store.loadBoundedPiCoreSessionWindow({
      maxChars: 10_000_000,
    });
    const full = await legacy.store.loadFullPiCoreTranscriptUnbounded({ imagePolicy: 'reference' });

    expect(window.messages).toEqual(full);
    expect(window.window).toMatchObject({
      capped: false,
      firstRowIdx: 0,
      summaryOffset: 0,
      totalRows: 24,
      loadedRows: 24,
    });
  });

  it('keeps the durable summary+tail shape when a compaction row exists', async () => {
    const rows = salixShapedRows(6, 100);
    const harness = createStoreHarness(rows);
    harness.sql.setCompaction({
      summary: 'earlier work',
      firstKeptIndex: 4,
      updatedAt: 55,
    });

    const { messages, window } = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 10_000_000,
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      content: '[Context Summary]\n\nearlier work',
      timestamp: 55,
    });
    // The `idx >= first_kept_index` predicate is the bound that already exists:
    // only rows 4 and 5 were ever selected.
    expect(window).toMatchObject({
      capped: false,
      firstRowIdx: 4,
      summaryOffset: 1,
      loadedRows: 2,
      totalRows: 2,
    });
  });
});

describe('bounded session load — over the cap', () => {
  it('loads only the newest tail that fits and names the rows it skipped', async () => {
    // 400 rows of ~1_000 chars each; a 40_000-char cap admits roughly 40.
    const rows = salixShapedRows(400, 1_000);
    const harness = createStoreHarness(rows);

    const { messages, window } = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 40_000,
    });

    expect(window.capped).toBe(true);
    expect(window.summaryOffset).toBe(1);
    expect(window.loadedChars).toBeLessThanOrEqual(40_000);
    expect(window.totalChars).toBeGreaterThan(400_000);
    expect(window.loadedRows).toBeLessThan(60);
    // Parsing is the allocator being bounded: only the admitted rows are parsed.
    expect(harness.operations.payloadRowsParsed).toBe(window.loadedRows);
    expect(messages).toHaveLength(window.loadedRows + 1);
    // The head is a summary-shaped placeholder that says what is missing.
    expect((messages[0] as unknown as { content: string }).content).toContain('[Context Summary]');
    expect((messages[0] as unknown as { content: string }).content).toContain('were NOT loaded');
    // The counts live on `pi_session_load_capped`, NOT in the placeholder text.
    // The placeholder is handed to the summarizer as `previousSummary` and ends
    // up verbatim in the durable summary, where a snapshot count silently drifts
    // into a lie as the watermark advances past more rows.
    expect((messages[0] as unknown as { content: string }).content).not.toContain(
      `${window.totalRows - window.loadedRows} message(s)`,
    );
    expect(window.totalRows - window.loadedRows).toBeGreaterThan(0);
    // ...and the tail really is the NEWEST rows, in order.
    expect((messages[messages.length - 1] as unknown as { content: unknown[] }).content).toEqual([
      { type: 'text', text: expect.stringContaining('turn 399') },
    ]);
    expect(window.firstRowIdx).toBe(400 - window.loadedRows);
  });

  it('opens the window on a turn boundary, never on an orphan tool answer', async () => {
    // A tail whose byte-chosen cut lands on toolResult rows: those rows answer a
    // call the window cannot see, so the window has to move forward past them.
    const rows = [
      textRow(0, 'user', 'x'.repeat(5_000)),
      textRow(1, 'assistant', 'x'.repeat(5_000)),
      {
        idx: 2,
        payload: JSON.stringify({
          role: 'toolResult',
          toolCallId: 'call-a',
          toolName: 'read',
          content: [{ type: 'text', text: 'answer a' }],
          isError: false,
          timestamp: 1002,
        }),
      },
      {
        idx: 3,
        payload: JSON.stringify({
          role: 'toolResult',
          toolCallId: 'call-b',
          toolName: 'read',
          content: [{ type: 'text', text: 'answer b' }],
          isError: false,
          timestamp: 1003,
        }),
      },
      textRow(4, 'user', 'newest question'),
    ];
    const harness = createStoreHarness(rows);

    const { messages, window } = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 1_000,
    });

    expect(window.capped).toBe(true);
    expect(window.firstRowIdx).toBe(4);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'user', content: 'newest question' });
  });

  it('keeps a Salix-shaped whale inside its budget', async () => {
    // Thousands of ordinary text rows and not one image — the shape that has no
    // compaction row, so the legacy load parsed every row before any bound applied.
    const rows = salixShapedRows(6_000, 2_000);
    const harness = createStoreHarness(rows);

    const { window } = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 12_000_000,
    });

    expect(window.totalChars).toBeGreaterThan(12_000_000);
    expect(window.loadedChars).toBeLessThanOrEqual(12_000_000);
    expect(harness.operations.payloadRowsParsed).toBeLessThan(rows.length);
    expect(harness.operations.payloadRowsParsed).toBe(window.loadedRows);
  });

  it('becomes an ordinary summary+tail load once the first turn persists a row', async () => {
    // The whole point of the placeholder: it is transitional. Once compaction has
    // written a real watermark at `firstRowIdx + cut - 1`, the next session build
    // takes the pre-existing bounded path and never reaches the cap again.
    const rows = salixShapedRows(400, 1_000);
    const harness = createStoreHarness(rows);

    const capped = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 40_000,
    });
    expect(capped.window.capped).toBe(true);

    // What compactPiContext would persist for a cut at session index 3.
    const storedFirstKeptIndex = capped.window.firstRowIdx + 3 - 1;
    harness.store.persistPiCoreCompaction('real summary', storedFirstKeptIndex);
    const before = harness.operations.payloadRowsParsed;

    const reloaded = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 40_000,
    });

    expect(reloaded.window).toMatchObject({
      capped: false,
      firstRowIdx: storedFirstKeptIndex,
      summaryOffset: 1,
    });
    expect(reloaded.messages[0]).toMatchObject({
      content: '[Context Summary]\n\nreal summary',
    });
    expect(reloaded.messages[1]).toEqual(capped.messages[3]);
    expect(harness.operations.payloadRowsParsed - before).toBe(
      400 - storedFirstKeptIndex,
    );
  });

  it('carries a durable summary into the placeholder rather than dropping it', async () => {
    const rows = salixShapedRows(200, 1_000);
    const harness = createStoreHarness(rows);
    harness.sql.setCompaction({
      summary: 'work done before the last compaction',
      firstKeptIndex: 20,
      updatedAt: 77,
    });

    const { messages, window } = await harness.store.loadBoundedPiCoreSessionWindow({
      maxChars: 20_000,
    });

    expect(window.capped).toBe(true);
    expect(window.firstRowIdx).toBeGreaterThan(20);
    const head = (messages[0] as unknown as { content: string }).content;
    expect(head).toContain('work done before the last compaction');
    expect(head).toContain('were NOT loaded');
  });
});

describe('session working-set image externalization', () => {
  const base64 = 'A'.repeat(PI_SESSION_INLINE_IMAGE_MAX_CHARS + 1_000);

  function imageRow(idx: number) {
    return {
      idx,
      payload: JSON.stringify({
        role: 'toolResult',
        toolCallId: 'shot-1',
        toolName: 'take_screenshot',
        content: [
          { type: 'text', text: 'here is the screen' },
          { type: 'image', mimeType: 'image/png', data: base64 },
        ],
        isError: false,
        timestamp: 4242,
      }),
    };
  }

  it('swaps oversized inline images for references in memory only', async () => {
    const rows = [imageRow(0)];
    const storedPayloadBefore = rows[0].payload;
    const harness = createStoreHarness(rows);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });

    const content = (messages[0] as unknown as { content: Array<Record<string, unknown>> }).content;
    expect(content[1]).toMatchObject({ type: 'image', data: '' });
    expect(
      (content[1].metadata as Record<string, { size: number }>).chiridionR2Image.size,
    ).toBe(base64.length);
    expect(harness.operations.sessionImagesExternalized).toBe(1);
    // The stored row is untouched: render still shows the image, and the mirror's
    // idempotent upsert still sees the same row content.
    expect(rows[0].payload).toBe(storedPayloadBefore);
    expect(harness.puts).toHaveLength(1);
  });

  it('writes the R2 object once across repeated loads', async () => {
    const harness = createStoreHarness([imageRow(0)]);

    await harness.store.loadFullPiCoreTranscriptUnbounded({ imagePolicy: 'reference' });
    await harness.store.loadFullPiCoreTranscriptUnbounded({ imagePolicy: 'reference' });

    expect(harness.operations.sessionImagesExternalized).toBe(2);
    expect(harness.puts).toHaveLength(1);
  });

  it('writes nothing and keeps the bytes when R2 rejects the put', async () => {
    const harness = createStoreHarness([imageRow(0)]);
    harness.r2.put.mockRejectedValueOnce(new Error('r2 down'));

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });

    const content = (messages[0] as unknown as { content: Array<Record<string, unknown>> }).content;
    // A reference whose object is not provably stored would hydrate to nothing,
    // so the inline bytes stay.
    expect(content[1]).toMatchObject({ type: 'image', data: base64 });
    expect(harness.operations.sessionImagesExternalized).toBe(0);
  });

  it('leaves images under the session threshold inline', async () => {
    const small = 'B'.repeat(PI_SESSION_INLINE_IMAGE_MAX_CHARS - 1);
    const harness = createStoreHarness([{
      idx: 0,
      payload: JSON.stringify({
        role: 'toolResult',
        toolCallId: 'shot-2',
        toolName: 'take_screenshot',
        content: [{ type: 'image', mimeType: 'image/png', data: small }],
        isError: false,
        timestamp: 1,
      }),
    }]);

    const messages = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });

    expect((messages[0] as unknown as { content: Array<Record<string, unknown>> }).content[0])
      .toMatchObject({ type: 'image', data: small });
    expect(harness.puts).toHaveLength(0);
  });

  it('re-inlines a trimmed image before it can reach a stored row', async () => {
    // The trim is a WORKING-SET optimization, but the list it produces is an
    // input to two wholesale rewrites (preserve compaction, fork seeding). Left
    // alone the rewrite stores `data: ""` — sanitizePiProviderContent preserves a
    // zero-data part that carries R2 metadata, and externalizePiImagesForSql
    // Storage no-ops on `"".length` — and renderPiStoredImageReferences then
    // replaces the image with a fixed text marker in the user's visible history,
    // permanently. That is exactly the retroactive deletion the storage
    // threshold's own doc comment says must never happen.
    const harness = createStoreHarness([imageRow(0)]);

    const [loaded] = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });
    const loadedPart = (loaded as unknown as { content: Array<Record<string, unknown>> })
      .content[1];
    expect(loadedPart).toMatchObject({ type: 'image', data: '' });
    expect(
      (loadedPart.metadata as Record<string, { origin: string }>).chiridionR2Image.origin,
    ).toBe('session');

    const serialized = await harness.store.serializePiMessageForSqlStorageDetailed(
      loaded,
    );
    const storedPart = (JSON.parse(serialized.payload) as {
      content: Array<Record<string, unknown>>;
    }).content[1];

    // The bytes are back, and the ephemeral reference is gone with them.
    expect(storedPart).toMatchObject({ type: 'image', data: base64 });
    expect(storedPart.metadata).toBeUndefined();
    // ...so the render policy still yields an image, not the omission marker.
    const rendered = harness.store.renderPiStoredImageReferences(
      JSON.parse(serialized.payload),
    ) as { content: Array<Record<string, unknown>> };
    expect(rendered.content[1]).toMatchObject({ type: 'image', data: base64 });
    expect(JSON.stringify(rendered)).not.toContain('persisted image omitted from render');
  });

  it('leaves a DURABLY externalized reference alone on the write path', async () => {
    // The mirror image of the test above: a row over PI_MAX_PERSISTED_IMAGE_DATA_
    // CHARS genuinely has no bytes, its render has always been a marker, and
    // re-inlining it would undo storage externalization on every rewrite.
    const stored = {
      role: 'toolResult',
      toolCallId: 'shot-3',
      toolName: 'take_screenshot',
      content: [{
        type: 'image',
        mimeType: 'image/png',
        data: '',
        metadata: {
          chiridionR2Image: {
            key: 'org1/workspace1/chat-sessions/thread1/pi-images/deadbeef.base64',
            mimeType: 'image/png',
            size: 900_000,
            sha256: 'deadbeef',
            storedAt: 1,
          },
        },
      }],
      isError: false,
      timestamp: 1,
    };
    const harness = createStoreHarness([]);

    const serialized = await harness.store.serializePiMessageForSqlStorageDetailed(
      stored as never,
    );
    const part = (JSON.parse(serialized.payload) as {
      content: Array<Record<string, unknown>>;
    }).content[0];

    expect(part).toMatchObject({ type: 'image', data: '' });
    expect(part.metadata).toMatchObject({ chiridionR2Image: { sha256: 'deadbeef' } });
    expect(harness.r2.get).not.toHaveBeenCalled();
  });

  it('keeps the reference, loudly, when the bytes cannot be recovered', async () => {
    const harness = createStoreHarness([imageRow(0)]);
    const [loaded] = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });
    harness.r2.get.mockResolvedValueOnce(null as never);

    const serialized = await harness.store.serializePiMessageForSqlStorageDetailed(
      loaded,
    );
    const part = (JSON.parse(serialized.payload) as {
      content: Array<Record<string, unknown>>;
    }).content[1];

    // Writing a reference is degradation, not corruption — the object is still in
    // R2 under a content hash — but it must be counted, never silent.
    expect(part).toMatchObject({ type: 'image', data: '' });
    expect(harness.operations.sessionImageRestoreFailures).toBe(1);
  });

  it('delivers every historical screenshot the char budget allows', async () => {
    // The count budget exists to bound R2 I/O for DURABLY externalized images.
    // Charging session-trimmed ones against it too would let a residency
    // optimization cap a thread's visual history at two screenshots per request:
    // the same content is delivered when it happens to be inline and dropped
    // when the load trimmed it.
    const harness = createStoreHarness([
      imageRow(0),
      imageRow(1),
      imageRow(2),
      imageRow(3),
    ]);

    const loaded = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });
    const hydrated = (await harness.store.hydratePiStoredImages(loaded)) as Array<{
      content: Array<Record<string, unknown>>;
    }>;

    expect(hydrated).toHaveLength(4);
    for (const message of hydrated) {
      expect(message.content[1]).toMatchObject({ type: 'image', data: base64 });
    }
    expect(JSON.stringify(hydrated)).not.toContain('omitted from provider context');
  });

  it('still bounds session images by the shared declared-char budget', async () => {
    // Exempt from the COUNT budget is not exempt from the byte budget: the char
    // ceiling is what actually keeps a provider body finite, and it charges
    // session references exactly what they cost when they were inline.
    const harness = createStoreHarness([imageRow(0), imageRow(1), imageRow(2)]);
    const loaded = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });

    const hydrated = (await harness.store.hydratePiStoredImages(loaded, {
      maxCount: 2,
      maxDeclaredChars: base64.length * 2,
    })) as Array<{ content: Array<Record<string, unknown>> }>;

    // Newest-first admission, so the two newest survive and the oldest degrades.
    expect(hydrated[0].content[1]).toMatchObject({ type: 'text' });
    expect(hydrated[1].content[1]).toMatchObject({ type: 'image', data: base64 });
    expect(hydrated[2].content[1]).toMatchObject({ type: 'image', data: base64 });
    expect(harness.operations.providerImagesOmitted).toBe(1);
  });

  it('keys a trimmed message identically to the inline one a live turn holds', async () => {
    // Without this, the working-set trim would break every dedup that compares a
    // loaded row against the live message it came from: turn-end commit would
    // re-append rows pi_core already has, and a resume would fold a duplicate
    // tail back into the transcript.
    const rows = [imageRow(0)];
    const harness = createStoreHarness(rows);
    const inline = JSON.parse(rows[0].payload);

    const [trimmed] = await harness.store.loadFullPiCoreTranscriptUnbounded({
      imagePolicy: 'reference',
    });

    expect(piCoreMessageKey(trimmed)).toBe(piCoreMessageKey(inline));
  });
});
