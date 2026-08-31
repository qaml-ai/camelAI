/**
 * RESIDENCY and TRUNCATION of the bounded preserve archive (stage 2a), at the
 * level where they are actually decidable.
 *
 * chat-thread-working-set-invariants.test.ts meters this path against per-
 * operation STORAGE budgets, and that is all it can do: its peak proxy
 * (`maxBytesBetweenRenderWrites`) is reset by every durable render write, so
 * `persistBatch` zeroes it on every iteration of the walk no matter how much the
 * pass is holding in JS memory. A version of this file that retained every
 * archived message for the whole pass — peak = the archived range rather than
 * one window, ~40 MB on the suite's own whale fixture — measured perfectly clean
 * there. So the walk reports its own residency and the assertions live here,
 * over fake deps, where "how many batches" is a dial rather than a fixture.
 *
 * The other half is truncation. A ceiling that stops the walk leaves rows with
 * no archive copy anywhere, and the caller must not then delete them; that is
 * asserted in chat-thread-bounded-write-paths.test.ts against a real DO. Here we
 * only pin the contract this file owns: truncation is REPORTED.
 */

import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';

import {
  materializeBoundedRenderArchive,
  PI_PRESERVE_ARCHIVE_MAX_BATCHES,
} from '../src/chat-thread/render-archive-preserve';
import type { PiDerivedRenderWindow } from '../src/chat-thread/derived-render-page';

const MESSAGES_PER_WINDOW = 50;
const ROWS_PER_MESSAGE = 2;

/** Parts carry ids, as real derived render parts do — that is what lets
 *  `mergeOlderRenderMessage` tell two halves of one fold apart. */
function renderMessage(id: string, part: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', id: part, text: part }],
  } as unknown as UIMessage;
}

/**
 * Deps over a synthetic row range: `windowCount` contiguous descending windows
 * of `MESSAGES_PER_WINDOW` distinct messages each, newest first, exactly the
 * shape `deriveRenderWindowFromPiCore` produces.
 *
 * `foldEveryWindow` re-emits the previous window's OLDEST message as this
 * window's NEWEST one, carrying an earlier part — the fold cut the join exists
 * to repair.
 */
function fakeDeps(options: { windowCount: number; foldEveryWindow?: boolean }) {
  const totalRows = options.windowCount * MESSAGES_PER_WINDOW * ROWS_PER_MESSAGE;
  const persisted: UIMessage[][] = [];
  let windowsServed = 0;

  const deps = {
    visibleWindow: () => ({ firstKeptIndex: 0, endIdx: totalRows }),
    deriveWindow: (beforeIdx: number): PiDerivedRenderWindow => {
      const index = windowsServed;
      windowsServed += 1;
      const startRowIdx = Math.max(
        0,
        beforeIdx - MESSAGES_PER_WINDOW * ROWS_PER_MESSAGE,
      );
      const messages: UIMessage[] = [];
      for (let offset = MESSAGES_PER_WINDOW - 1; offset >= 0; offset -= 1) {
        messages.push(renderMessage(`m-${index}-${offset}`, `w${index}p${offset}`));
      }
      if (options.foldEveryWindow && index > 0) {
        // The previous window's OLDEST message is this (older) window's NEWEST
        // one, re-emitted with the earlier half of its parts — a cut fold.
        messages.push(
          renderMessage(
            `m-${index - 1}-${MESSAGES_PER_WINDOW - 1}`,
            `older-half-of-${index - 1}`,
          ),
        );
      }
      return {
        messages,
        anchorRowIdx: [],
        endRowIdx: [],
        startRowIdx,
        reachedOldest: startRowIdx <= 0,
        stats: {
          rowsRead: MESSAGES_PER_WINDOW * ROWS_PER_MESSAGE,
          payloadChars: 1_000,
          droppedToolResults: 0,
          boundaryUnresolved: false,
          foldCuts: 0,
        },
      } as unknown as PiDerivedRenderWindow;
    },
    persistBatch: vi.fn(async (messages: UIMessage[]) => {
      persisted.push(messages);
    }),
    stampChronology: vi.fn(),
  };
  return { deps, persisted, totalRows };
}

describe('preserve archive residency', () => {
  it('holds one window, not the range, however many batches it runs', async () => {
    // 64 batches is what the old flat ceiling allowed; the pass-wide map held
    // every message of all of them (3,200 messages, ~40 MB on the real fixture).
    const { deps } = fakeDeps({ windowCount: 64 });

    const result = await materializeBoundedRenderArchive(deps, { keptTailRows: 0 });

    expect(result.batches).toBe(64);
    expect(result.messagesPersisted).toBe(64 * MESSAGES_PER_WINDOW);
    // The bound, stated as a number: one batch plus the single-message carry.
    expect(result.peakRetainedMessages).toBeLessThanOrEqual(MESSAGES_PER_WINDOW + 1);
    expect(result.truncated).toBe(false);
  });

  it('does not grow its peak when the walk gets longer', async () => {
    // The distinguishing assertion. Retention that is O(range) rises with batch
    // count; retention that is O(window) does not move at all.
    const short = await materializeBoundedRenderArchive(
      fakeDeps({ windowCount: 4 }).deps,
      { keptTailRows: 0 },
    );
    const long = await materializeBoundedRenderArchive(
      fakeDeps({ windowCount: 200 }).deps,
      { keptTailRows: 0 },
    );

    expect(long.batches).toBeGreaterThan(short.batches * 10);
    expect(long.peakRetainedMessages).toBe(short.peakRetainedMessages);
  });

  it('still joins a fold cut by a window boundary', async () => {
    // What the retention was FOR. A window that closes mid-fold serves its
    // oldest message partial; the next window re-emits the id with the earlier
    // parts, and persisting that blindly would upsert the row down to just the
    // earlier half. The one-slot carry has to keep repairing that.
    const { deps, persisted } = fakeDeps({ windowCount: 8, foldEveryWindow: true });

    const result = await materializeBoundedRenderArchive(deps, { keptTailRows: 0 });

    // A folding window is 51 messages wide (its own 50 plus the re-emitted
    // half), so the bound is that window plus the one carried message.
    expect(result.peakRetainedMessages).toBeLessThanOrEqual(MESSAGES_PER_WINDOW + 2);
    expect(result.duplicateIdsSkipped).toBe(0);
    // Every re-emitted id was written once more, carrying BOTH halves.
    const cutId = `m-0-${MESSAGES_PER_WINDOW - 1}`;
    const rejoined = persisted.flat().filter((message) => message.id === cutId);
    expect(rejoined).toHaveLength(2);
    const parts = JSON.stringify(rejoined[1].parts);
    expect(parts).toContain('older-half-of-0');
    expect(parts).toContain(`w0p${MESSAGES_PER_WINDOW - 1}`);
  });
});

describe('preserve archive truncation', () => {
  it('reports truncation instead of pretending the range was archived', async () => {
    const { deps } = fakeDeps({ windowCount: 64 });

    const result = await materializeBoundedRenderArchive(deps, {
      keptTailRows: 0,
      maxBatches: 4,
    });

    expect(result.batches).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.lowestRowIdx).toBeGreaterThan(0);
  });

  it('sizes its batch ceiling from the range instead of a flat number', async () => {
    // The defect this replaces: a flat 64 batches is really a ~3,200 render-
    // message ceiling, because a batch closes on its message count long before
    // its 2 MB byte budget. On a thread of many small rows that truncated at
    // roughly half the thread while spending a tenth of the documented 64 MB —
    // and the caller then deleted the unarchived rows.
    const { deps } = fakeDeps({ windowCount: 300 });

    const result = await materializeBoundedRenderArchive(deps, { keptTailRows: 0 });

    expect(result.batches).toBe(300);
    expect(result.truncated).toBe(false);
    expect(result.messagesPersisted).toBe(300 * MESSAGES_PER_WINDOW);
    // ...and the absolute guard is still a guard.
    expect(result.batches).toBeLessThanOrEqual(PI_PRESERVE_ARCHIVE_MAX_BATCHES);
  });
});
