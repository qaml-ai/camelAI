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
      text.startsWith('CREATE TABLE') ||
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

describe('capped load meets compaction', () => {
  const MODEL = { contextWindow: 32_000, maxTokens: 8_000 } as any;

  /** A DO stub with a capped load's index space already adopted. */
  function cappedLoadFake(firstRowIdx: number) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let compaction: { summary: string; firstKeptIndex: number; updatedAt: number } | null =
      null;
    fake.loadPiCoreCompaction = vi.fn(() => compaction);
    fake.persistPiCoreCompaction = vi.fn((summary: string, firstKeptIndex: number) => {
      compaction = { summary, firstKeptIndex, updatedAt: 1 };
    });
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piEphemeralCompaction = null;
    fake.piSessionLoadWindow = { firstRowIdx, summaryOffset: 1 };
    return fake;
  }

  function cappedMessages(placeholder: string) {
    return [
      createPiSummaryMessage(placeholder, 9_000),
      { role: 'user', content: 'question about the omitted work', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `long answer ${'word '.repeat(40_000)}` }],
        responseId: 'resp_a',
        timestamp: 2,
      },
      { role: 'user', content: 'the newest question', timestamp: 3 },
    ];
  }

  it('persists the compaction row in pi_core idx space, not session space', async () => {
    // Session index 2 is pi_core row 900 + 2 - 1 = 901. Writing `2` instead would
    // silently keep the whole prefix and the load bound would never apply again.
    const fake = cappedLoadFake(900);
    const messages = cappedMessages('history was omitted');
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'real summary' }],
    }));

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages as never,
      MODEL,
      'token',
      completeSimple as never,
      undefined,
      { committedBound: messages.length },
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledTimes(1);
    const [summary, storedIndex] = fake.persistPiCoreCompaction.mock.calls[0];
    expect(summary).toBe('real summary');
    const sessionCut = messages.length - (compacted.length - 1);
    expect(storedIndex).toBe(900 + sessionCut - 1);
    expect((compacted[0] as { content: string }).content).toBe(
      '[Context Summary]\n\nreal summary',
    );
  });

  it('never summarizes the placeholder as conversation', async () => {
    const fake = cappedLoadFake(900);
    const messages = cappedMessages('THE-PLACEHOLDER-MARKER');
    let prompt = '';
    const completeSimple = vi.fn(async (_model: unknown, context: any) => {
      prompt = String(context.messages[0].content);
      return { content: [{ type: 'text', text: 'real summary' }] };
    });

    await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages as never,
      MODEL,
      'token',
      completeSimple as never,
      undefined,
      { committedBound: messages.length },
    );

    // It arrives in the previous-summary slot exactly once, and never inside the
    // <conversation> block being summarized.
    expect(prompt).toContain('<previous-summary>\nTHE-PLACEHOLDER-MARKER\n</previous-summary>');
    expect(prompt.split('THE-PLACEHOLDER-MARKER')).toHaveLength(2);
    expect(prompt.slice(prompt.indexOf('<conversation>'))).not.toContain(
      'THE-PLACEHOLDER-MARKER',
    );
  });

  /**
   * A capped, IMAGE-DOMINATED context that sits under both compaction triggers.
   *
   * This is the production shape in miniature, and the whole reason the gap
   * existed: an image is charged a flat `PI_IMAGE_CONTEXT_TOKENS`, so a dozen
   * screenshots is ~36k tokens — nowhere near a million-token window — while
   * being megabytes of working set. Enough bytes to be over
   * `PI_COMPACTION_KEEP_RECENT_BYTES` (so a cut exists to make), far under
   * `PI_CONTEXT_MAX_WORKING_SET_BYTES` (so the byte trigger does not fire), and
   * `PI_SESSION_LOAD_MAX_CHARS` sits below that ceiling by design — so a capped
   * load of this shape trips nothing at all on arrival.
   */
  const WIDE_MODEL = { contextWindow: 1_000_000, maxTokens: 8_000 } as any;
  function underTriggerMessages() {
    const shot = 'A'.repeat(200_000);
    return [
      createPiSummaryMessage('placeholder: earlier messages were NOT loaded', 9_000),
      ...Array.from({ length: 12 }, (_, index) => ({
        role: 'user' as const,
        content: [
          { type: 'text', text: `screenshot ${index}` },
          { type: 'image', mimeType: 'image/png', data: shot },
        ],
        timestamp: index + 1,
      })),
    ];
  }

  function transformFake(options: {
    capped: boolean;
    existingFirstKeptIndex?: number;
  }) {
    const fake = cappedLoadFake(900) as any;
    if (typeof options.existingFirstKeptIndex === 'number') {
      fake.persistPiCoreCompaction('durable summary', options.existingFirstKeptIndex);
      fake.persistPiCoreCompaction.mockClear();
    }
    fake.piSessionLoadWindow = {
      firstRowIdx: 900,
      summaryOffset: 1,
      capped: options.capped,
    };
    fake.piDegradedResumeAttempt = false;
    fake.piMainBaselineIndex = 13;
    fake.recordPiContextBudget = vi.fn();
    fake.hydratePiStoredImages = vi.fn(async (messages: unknown) => messages);
    return fake;
  }

  it('forces a capped load to persist its own watermark on the first request', async () => {
    // Without this the durable row is only ever written when a threshold fires,
    // and a capped load is sized to sit UNDER both of them. An image-dominated
    // thread therefore re-enters the capped branch on every wake forever: the
    // placeholder is permanent, `pi_session_load_capped` (documented as at most
    // once per thread) fires every turn, and each wake re-materializes 12 MB.
    const fake = transformFake({ capped: true });
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'follow-through summary' }],
    }));

    await ChatThreadDO.prototype['transformPiProviderContext'].call(
      fake,
      underTriggerMessages() as never,
      WIDE_MODEL,
      'token',
      completeSimple as never,
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledTimes(1);
    const [summary, storedIndex] = fake.persistPiCoreCompaction.mock.calls[0];
    expect(summary).toBe('follow-through summary');
    // pi_core idx space, not session space: firstRowIdx + (cut - summaryOffset).
    expect(storedIndex).toBeGreaterThanOrEqual(900);
    // ...and the load is no longer missing its watermark.
    expect(ChatThreadDO.prototype['piCappedLoadNeedsWatermark'].call(fake)).toBe(false);
  });

  it('leaves an uncapped load exactly as it was', async () => {
    // The control that makes the test above mean something: identical context,
    // identical model, no cap — and nothing compacts, because neither trigger
    // fires. So the row above was written by the capped follow-through and by
    // nothing else.
    const fake = transformFake({ capped: false });
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));

    await ChatThreadDO.prototype['transformPiProviderContext'].call(
      fake,
      underTriggerMessages() as never,
      WIDE_MODEL,
      'token',
      completeSimple as never,
    );

    expect(completeSimple).not.toHaveBeenCalled();
    expect(fake.persistPiCoreCompaction).not.toHaveBeenCalled();
  });

  it('stops forcing once a watermark at or above the window exists', async () => {
    // The forced path must be a ONE-SHOT, or a capped turn would re-summarize on
    // every one of its ~25 provider requests.
    const fake = transformFake({ capped: true, existingFirstKeptIndex: 901 });
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'should not run' }],
    }));

    expect(ChatThreadDO.prototype['piCappedLoadNeedsWatermark'].call(fake)).toBe(false);
    await ChatThreadDO.prototype['transformPiProviderContext'].call(
      fake,
      underTriggerMessages() as never,
      WIDE_MODEL,
      'token',
      completeSimple as never,
    );

    expect(completeSimple).not.toHaveBeenCalled();
    expect(fake.persistPiCoreCompaction).not.toHaveBeenCalled();
  });

  it('carries the previous summary through a summarizer failure', async () => {
    // `recordCut` advances the watermark on the catch branch exactly as it does
    // on the success branch, so whatever the fallback returns BECOMES the
    // thread's entire durable summary. Dropping the previous one meant a single
    // transient failure discarded every earlier compaction's work — and on a
    // capped thread, the only record that an unsummarized prefix exists at all.
    const fake = cappedLoadFake(900);
    const messages = cappedMessages('PLACEHOLDER: earlier history was omitted');
    const completeSimple = vi.fn(async () => {
      throw new Error('summarizer unavailable');
    });

    await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages as never,
      MODEL,
      'token',
      completeSimple as never,
      undefined,
      { committedBound: messages.length },
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledTimes(1);
    const [summary] = fake.persistPiCoreCompaction.mock.calls[0];
    expect(summary).toContain('PLACEHOLDER: earlier history was omitted');
    expect(summary).toContain('Automatic fallback summary');
  });

  it('reuses the persisted row for the rest of the turn instead of re-summarizing', async () => {
    // The pathology this closes: with a summary-shaped head the row branch used to
    // fall through, so every one of a turn's ~25 provider requests paid for a fresh
    // summarization of the same prefix.
    //
    // Many medium messages rather than one huge one, deliberately: the cut lands ON
    // the message that busts `keepRecentTokens`, so a single enormous message is
    // always retained and no kept tail could ever be inside the budget.
    const fake = cappedLoadFake(900);
    const bigModel = { contextWindow: 60_000, maxTokens: 4_000 } as any;
    const messages = [
      createPiSummaryMessage('history was omitted', 9_000),
      ...Array.from({ length: 24 }, (_, index) => ({
        role: 'user' as const,
        content: `turn ${index} ${'word '.repeat(1_840)}`,
        timestamp: index + 1,
      })),
    ];
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'real summary' }],
    }));
    const options = { committedBound: messages.length };

    const first = await ChatThreadDO.prototype['compactPiContext'].call(
      fake, messages as never, bigModel, 'token', completeSimple as never, undefined, options,
    );
    const second = await ChatThreadDO.prototype['compactPiContext'].call(
      fake, messages as never, bigModel, 'token', completeSimple as never, undefined, options,
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledTimes(1);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    // Same cut, same content — only the summary bubble's wall-clock differs.
    expect(second).toHaveLength(first.length);
    expect((second[0] as { content: string }).content).toBe(
      (first[0] as { content: string }).content,
    );
    expect(second.slice(1)).toEqual(first.slice(1));
  });

  it('reports no_cut instead of summarizing a placeholder into itself', async () => {
    // A capped load whose entire tail fits inside `keepRecentTokens` has nothing
    // to compact. Cutting at session index 1 would summarize the placeholder ALONE
    // and write a watermark that makes no progress — once per provider request.
    const fake = cappedLoadFake(900);
    const messages = [
      createPiSummaryMessage('history was omitted', 9_000),
      {
        role: 'user',
        content: `only turn ${'word '.repeat(40_000)}`,
        timestamp: 1,
      },
    ];
    const completeSimple = vi.fn();
    const outcome = { status: 'unchanged' } as { status: string };

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages as never,
      MODEL,
      'token',
      completeSimple as never,
      undefined,
      { committedBound: messages.length, outcome: outcome as never },
    );

    expect(completeSimple).not.toHaveBeenCalled();
    expect(fake.persistPiCoreCompaction).not.toHaveBeenCalled();
    expect(compacted).toBe(messages);
    expect(outcome.status).toBe('no_cut');
  });

  it('leaves the pre-existing index mapping alone when no session load ran', async () => {
    // Direct callers (tests, admin paths) have no recorded window; the durable
    // compaction row remains the only offset, exactly as before.
    const fake = cappedLoadFake(0);
    fake.piSessionLoadWindow = null;
    fake.loadPiCoreCompaction = vi.fn(() => ({
      summary: 'first summary',
      firstKeptIndex: 2,
      updatedAt: 100,
    }));
    const messages = [
      createPiSummaryMessage('first summary', 100),
      { role: 'user', content: 'raw row 2', timestamp: 200 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: `raw row 3 ${'word '.repeat(40_000)}` }],
        timestamp: 300,
      },
      { role: 'user', content: 'raw row 4', timestamp: 400 },
    ];
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'second summary' }],
    }));

    await ChatThreadDO.prototype['compactPiContext'].call(
      fake, messages as never, MODEL, 'token', completeSimple as never,
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith('second summary', 3);
  });
});

describe('post-turn compaction under a capped session', () => {
  function postTurnFake(capped: boolean) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const compacted = [
      createPiSummaryMessage('post-turn summary', 5),
      { role: 'user', content: 'kept tail', timestamp: 6 },
    ];
    const session = {
      state: { messages: [{ role: 'user', content: 'before', timestamp: 1 }], model: {}, isStreaming: false },
      waitForIdle: vi.fn(async () => undefined),
    };
    fake.piSession = session;
    fake.piModelResolver = vi.fn(async () => ({ model: {}, apiKey: 'k' }));
    fake.chatContext = null;
    fake.compactPiContext = vi.fn(async () => compacted);
    fake.replacePiCoreMessages = vi.fn(async () => ({ status: 'rewritten' }));
    fake.clearPiCoreCompaction = vi.fn();
    fake.loadPiCoreCompaction = vi.fn(() => ({
      summary: 'post-turn summary',
      firstKeptIndex: 950,
      updatedAt: 1,
    }));
    fake.piSessionLoadWindow = capped
      ? { firstRowIdx: 900, summaryOffset: 1, capped: true }
      : { firstRowIdx: 0, summaryOffset: 0, capped: false };
    return { fake, session, compacted };
  }

  it('never rewrites pi_core from a list that is short of the thread', async () => {
    // `replacePiCoreMessages` DELETES every row not in the list it is handed. A
    // capped session's list omits the rows it deliberately never loaded, so the
    // rewrite would destroy them — and its archive snapshot is the full-thread
    // derive, i.e. the exact allocator this change exists to avoid.
    const { fake, session, compacted } = postTurnFake(true);

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(
      fake,
      { role: 'assistant', usage: { totalTokens: 200_000 } } as never,
    );

    expect(fake.replacePiCoreMessages).not.toHaveBeenCalled();
    expect(fake.clearPiCoreCompaction).not.toHaveBeenCalled();
    expect(session.state.messages).toBe(compacted);
    // The durable watermark compactPiContext just wrote becomes the session's new
    // index space; the window is still short of the thread.
    expect(fake.piSessionLoadWindow).toEqual({
      firstRowIdx: 950,
      summaryOffset: 1,
      capped: true,
    });
    expect(fake.piMainBaselineIndex).toBe(compacted.length);
  });

  it('still rewrites pi_core for an ordinary full session', async () => {
    const { fake, compacted } = postTurnFake(false);

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(
      fake,
      { role: 'assistant', usage: { totalTokens: 200_000 } } as never,
    );

    expect(fake.replacePiCoreMessages).toHaveBeenCalledWith(compacted, {
      uiRender: 'preserve',
    });
    expect(fake.clearPiCoreCompaction).toHaveBeenCalled();
  });
});
