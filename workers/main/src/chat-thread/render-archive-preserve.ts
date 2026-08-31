// Bounded compaction PRESERVE path (BOUNDED-MEMORY-BY-CONSTRUCTION stage 2a).
//
// Before a preserve-compaction rewrites pi_core, the rows it is about to
// summarize away have to be snapshotted into the ai-chat render table, or they
// disappear from the user's visible history. The pre-change implementation did
// that by materializing the ENTIRE visible transcript (`getPiCoreParsedMessages`
// → `deriveUiMessagesFromParsedPiCore` → one `persistMessages` of everything) —
// the same O(thread) shape as the derive-then-paginate bug, fired at exactly the
// biggest threads there are, from a `waitUntil` no wake breaker can see.
//
// Two independent bounds replace it:
//
//  1. SCOPE. Only rows the POST-compaction derive can no longer see need
//     preserving. The rewrite keeps the newest `keptTailRows` rows, so the
//     archive range is `[firstKeptIndex, endIdx - keptTailRows)` — on an
//     ordinary compaction that is the prefix, not the whole window.
//  2. RESIDENCY. That range is walked with the SAME bounded reader the render
//     pager uses (`deriveRenderWindowFromPiCore`, newest-first, metadata before
//     bodies) and persisted one window at a time, so peak is a window, not the
//     range. A hard total ceiling stops the walk (and says so) rather than
//     letting a pathological thread run forever.
//
// Two things the first version of this file got wrong, both worth stating
// plainly because the class net cannot see either one:
//
//  - RESIDENCY IS A JS-HEAP CLAIM, AND THE STORAGE COUNTERS DO NOT MEASURE IT.
//    The instrumented storage in the invariants suite counts rows read and
//    payload bytes materialized PER STORAGE OPERATION, and its peak proxy
//    (`maxBytesBetweenRenderWrites`) resets on every durable render write — so
//    it is zeroed by `persistBatch` on every iteration no matter what the pass
//    retains in memory. A map of every message the pass had persisted lived
//    here and made peak residency O(archived range); it measured perfectly
//    clean. The fold join now carries ONE window (`carried` below) and the walk
//    reports `peakRetainedMessages`, which is a number a test can assert.
//  - A CEILING THAT TRUNCATES MUST NOT ALSO DELETE. `PI_PRESERVE_ARCHIVE_MAX_*`
//    stopping the walk means the rows below `lowestRowIdx` have no archive copy,
//    so the caller may not go on to `DELETE FROM pi_core_messages`. Truncation
//    is reported, and `replacePiCoreMessages` abandons the rewrite when it sees
//    it — the compaction watermark alone bounds that turn, exactly the way the
//    capped-session branch already does.
import type { UIMessage } from "ai";

import type { PiDerivedRenderWindow } from "./derived-render-page";

/** Messages per persisted batch — the render pager's own page size. */
export const PI_PRESERVE_ARCHIVE_BATCH_MESSAGES = 50;
/**
 * Stored payload chars one batch may admit. The derive's boundary phase may
 * grow a window to `maxBytes * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR` to close a
 * fold, so this is half the real peak: 2 MB here means ≤4 MB of stored payload
 * resident at once, plus that window's parse graph — the same order as one
 * render page, which every connect already pays.
 */
export const PI_PRESERVE_ARCHIVE_BATCH_CHARS = 2_000_000;
/**
 * Total stored payload chars one preserve pass may read, across all batches.
 *
 * This is NOT a residency bound (batches are bounded individually); it is a
 * runtime bound on a `waitUntil` task. Deliberately generous — 64 MB is larger
 * than the largest thread observed in production — because hitting it means the
 * pass cannot archive the whole range, and the caller then has to abandon its
 * rewrite entirely rather than delete unarchived rows. It exists so a corrupt or
 * adversarial thread cannot pin the isolate, and every truncation is reported at
 * warn severity.
 */
export const PI_PRESERVE_ARCHIVE_MAX_CHARS = 64_000_000;
/**
 * Absolute batch ceiling — a runaway guard, NOT the working bound.
 *
 * The working bound is derived per pass from the actual row range
 * ({@link batchCeilingForRange}), because a flat ceiling is the wrong shape
 * here: a batch closes on `PI_PRESERVE_ARCHIVE_BATCH_MESSAGES` anchors long
 * before it closes on `PI_PRESERVE_ARCHIVE_BATCH_CHARS` unless the average
 * render message exceeds ~40 KB, so a flat 64 batches is really a ~3,200
 * render-message ceiling and the documented 64 MB never binds at all. On the
 * shape this file exists for — an uncompacted legacy whale of many small rows —
 * that truncated at roughly half the thread while spending 7 MB of the 64 MB
 * budget, and the caller then deleted the unarchived rows.
 *
 * Raising it costs `waitUntil` runtime and nothing else: peak residency is one
 * batch by construction (see the file header), and total work is still pinned by
 * {@link PI_PRESERVE_ARCHIVE_MAX_CHARS}. Truncation costs the whole rewrite, so
 * the trade is heavily one-sided.
 */
export const PI_PRESERVE_ARCHIVE_MAX_BATCHES = 1_024;
/**
 * Rows archived beyond the computed cut.
 *
 * `keptTailRows` is derived from the compacted MESSAGE list, and the session
 * list is only approximately row-for-row with pi_core (a load skips corrupt
 * rows; a resume folds a journaled tail in). An over-estimate would leave rows
 * unarchived — silent history loss — while an under-estimate only archives rows
 * the post-compaction derive still serves, which the archive seam filters out by
 * id and by `role:createdAtMs`. So the error is deliberately spent on the
 * harmless side.
 *
 * What this margin is NOT: a fallback copy of the kept tail. Settled reads
 * derive from the new pi_core and prepend archive rows only for ids the derive
 * does not produce, so for a row that SURVIVES the rewrite the derive always
 * wins and its archive copy is unreachable. Anything that could degrade a kept
 * row has to be fixed on the write path; no margin here can cover it.
 */
export const PI_PRESERVE_ARCHIVE_MARGIN_ROWS = 16;

/**
 * Batches this pass may run, derived from the range it actually has to archive.
 *
 * One batch admits at most `batchMessages` render messages and a render message
 * covers at least one pi_core row, so `rows / batchMessages` batches always
 * suffice; the slack absorbs the boundary phase re-reading a cut fold. Clamped
 * to {@link PI_PRESERVE_ARCHIVE_MAX_BATCHES} so a corrupt range cannot ask for
 * an unbounded walk.
 */
function batchCeilingForRange(rows: number, batchMessages: number): number {
  const needed = Math.ceil(Math.max(0, rows) / Math.max(1, batchMessages)) + 8;
  return Math.max(1, Math.min(PI_PRESERVE_ARCHIVE_MAX_BATCHES, needed));
}

export interface PreserveArchiveDeps {
  visibleWindow(): { firstKeptIndex: number; endIdx: number };
  /** One bounded derived window ending (exclusively) at `beforeIdx`. */
  deriveWindow(
    beforeIdx: number,
    limits: { maxMessages: number; maxBytes: number },
  ): PiDerivedRenderWindow;
  /** Upsert one batch into the durable render table. */
  persistBatch(messages: UIMessage[]): Promise<void>;
  /** Stamp a persisted row's immutable chronology cursor. */
  stampChronology(message: UIMessage): void;
}

export interface PreserveArchiveResult {
  batches: number;
  messagesPersisted: number;
  rowsRead: number;
  payloadChars: number;
  /** A ceiling stopped the walk with rows still unarchived below `lowestRowIdx`. */
  truncated: boolean;
  /** Lowest pi_core row idx this pass archived (its exclusive floor otherwise). */
  lowestRowIdx: number;
  /**
   * PEAK JS-heap residency, in derived render messages held live at once: the
   * batch being persisted plus the single-message fold carry.
   *
   * Exported because the storage-level counters structurally cannot see it (see
   * the file header) — this is the only number that distinguishes "peak is a
   * window" from "peak is the range", and a unit test asserts it stays at one
   * window's worth however many batches the walk runs.
   */
  peakRetainedMessages: number;
  /**
   * Ids re-emitted by a NON-adjacent window, i.e. outside the fold carry's
   * reach. Zero on every shape this path is built for (folds span adjacent
   * windows only); a non-zero value means an id skipped a window and the walk
   * declined to blind-upsert it rather than clobber a newer copy with an older
   * partial one, so it belongs in telemetry rather than in a comment.
   */
  duplicateIdsSkipped: number;
}

function renderPartKey(part: unknown, index: number): string {
  const record = part as Record<string, unknown> | null;
  const id = record && typeof record.id === "string" ? record.id : "";
  const type = record && typeof record.type === "string" ? record.type : "";
  const toolCallId =
    record && typeof record.toolCallId === "string" ? record.toolCallId : "";
  return id || toolCallId ? `${type}:${id}:${toolCallId}` : `${type}:#${index}`;
}

/**
 * Merge an OLDER copy of a message into the one already persisted this pass.
 *
 * A window that closes mid-fold serves its oldest message partial and the next
 * (older) window re-emits the same id carrying the EARLIER parts. Persisting
 * that blindly would upsert the row down to just the earlier parts — the exact
 * "client keeps whichever arrived last" data loss `prependOlderRenderMessages`
 * exists to prevent on the wire, except durable. So the halves are joined here,
 * older parts first, before either reaches storage.
 */
function mergeOlderRenderMessage(
  persisted: UIMessage,
  older: UIMessage,
): UIMessage {
  const persistedParts = Array.isArray(persisted.parts) ? persisted.parts : [];
  const olderParts = Array.isArray(older.parts) ? older.parts : [];
  const held = new Set(persistedParts.map(renderPartKey));
  const missing = olderParts.filter(
    (part, index) => !held.has(renderPartKey(part, index)),
  );
  if (missing.length === 0) return persisted;
  return { ...persisted, parts: [...missing, ...persistedParts] } as UIMessage;
}

/**
 * Snapshot the rows a preserve-compaction is about to delete into the render
 * table, newest-first, one bounded window at a time.
 *
 * `keptTailRows` is how many of the CURRENT newest pi_core rows survive the
 * rewrite (the compacted list minus its synthetic summary head). Pass 0 to
 * archive the whole visible window, which is what a caller that cannot account
 * for the tail should do.
 *
 * CONTRACT FOR THE CALLER: `truncated: true` means rows below `lowestRowIdx`
 * have no archive copy and the rewrite MUST be abandoned. Deleting them anyway
 * is unrecoverable history loss, and there is a cheap correct alternative — keep
 * the rows and let the persisted compaction watermark bound the thread.
 */
export async function materializeBoundedRenderArchive(
  deps: PreserveArchiveDeps,
  options: {
    keptTailRows: number;
    maxChars?: number;
    maxBatches?: number;
    batchMessages?: number;
    batchChars?: number;
  },
): Promise<PreserveArchiveResult> {
  const { firstKeptIndex, endIdx } = deps.visibleWindow();
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? PI_PRESERVE_ARCHIVE_MAX_CHARS));
  const maxBatches = Math.max(
    1,
    Math.floor(options.maxBatches ?? PI_PRESERVE_ARCHIVE_MAX_BATCHES),
  );
  const limits = {
    maxMessages: Math.max(
      1,
      Math.floor(options.batchMessages ?? PI_PRESERVE_ARCHIVE_BATCH_MESSAGES),
    ),
    maxBytes: Math.max(
      1,
      Math.floor(options.batchChars ?? PI_PRESERVE_ARCHIVE_BATCH_CHARS),
    ),
  };
  const keptTailRows = Math.max(0, Math.floor(options.keptTailRows));
  let beforeIdx = Math.min(
    endIdx,
    endIdx - keptTailRows + PI_PRESERVE_ARCHIVE_MARGIN_ROWS,
  );

  const result: PreserveArchiveResult = {
    batches: 0,
    messagesPersisted: 0,
    rowsRead: 0,
    payloadChars: 0,
    truncated: false,
    lowestRowIdx: beforeIdx,
    peakRetainedMessages: 0,
    duplicateIdsSkipped: 0,
  };
  if (beforeIdx <= firstKeptIndex) return result;

  const maxBatchesForRange = Math.min(
    maxBatches,
    batchCeilingForRange(beforeIdx - firstKeptIndex, limits.maxMessages),
  );

  /**
   * The ONE message the next (older) window may re-emit: this batch's oldest.
   *
   * Windows are contiguous descending ranges, so a fold cut by a window boundary
   * is re-emitted by the immediately following window and by no other. Holding
   * the whole pass's output to join it — which is what this used to do — makes
   * peak residency the archived range instead of one window, and the fold that
   * spans several windows still works with a single slot because the carried
   * value is itself the accumulated merge.
   */
  let carried: UIMessage | null = null;
  /**
   * Ids already written, so an id that reappears OUTSIDE the carry slot is
   * caught instead of blind-upserted (which would overwrite a newer persisted
   * copy with an older partial one). Strings only, and bounded by the same
   * ceiling that bounds `messagesPersisted`.
   */
  const persistedIds = new Set<string>();

  for (;;) {
    if (result.batches >= maxBatchesForRange || result.payloadChars >= maxChars) {
      result.truncated = beforeIdx > firstKeptIndex;
      break;
    }
    const window = deps.deriveWindow(beforeIdx, limits);
    result.rowsRead += window.stats.rowsRead;
    result.payloadChars += window.stats.payloadChars;
    result.batches += 1;

    if (window.messages.length > 0) {
      const batch: UIMessage[] = [];
      for (const message of window.messages) {
        if (carried && carried.id === message.id) {
          batch.push(mergeOlderRenderMessage(carried, message));
          continue;
        }
        if (persistedIds.has(message.id)) {
          // Not reachable through the adjacency argument above. Skipping keeps
          // the newer, more complete persisted row; the count is reported.
          result.duplicateIdsSkipped += 1;
          continue;
        }
        batch.push(message);
      }
      for (const message of batch) persistedIds.add(message.id);
      result.peakRetainedMessages = Math.max(
        result.peakRetainedMessages,
        batch.length + (carried ? 1 : 0),
      );
      if (batch.length > 0) {
        await deps.persistBatch(batch);
        for (const message of batch) deps.stampChronology(message);
        result.messagesPersisted += batch.length;
      }
      // Drop everything but the join candidate. `batch[0]` is the window's
      // oldest message and therefore the only one an older window can re-emit.
      carried = batch.length > 0 ? batch[0] : carried;
    }

    result.lowestRowIdx = Math.min(result.lowestRowIdx, window.startRowIdx);
    if (window.reachedOldest) break;
    // `startRowIdx` is the lowest row the window admitted, so the next window
    // ends exclusively there. A window that admitted nothing new would loop
    // forever; treat that as exhausted rather than spinning.
    if (window.startRowIdx >= beforeIdx) {
      result.truncated = window.startRowIdx > firstKeptIndex;
      break;
    }
    beforeIdx = window.startRowIdx;
    if (beforeIdx <= firstKeptIndex) break;
  }

  return result;
}
