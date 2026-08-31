// Storage-boundary render-history derivation for ChatThreadDO.
//
// The derive-on-read path used to materialize the WHOLE thread before paginating
// it: parse every pi_core row, derive every UIMessage, walk the entire ai-chat
// archive table, concatenate, cache — and only then apply the 50-message / 4MB
// render window. On a thread with thousands of rows and tens of megabytes of
// transcript that peak is fatal (a post-start RPC OOM the wake circuit breaker
// cannot see), so every load killed the Durable Object.
//
// This module derives a page at the storage boundary instead: pi_core rows are
// paged newest-first by idx in bounded batches (metadata first, so the byte cost
// of a batch is known before any payload is materialized), converted
// incrementally, and the walk STOPS once the requested page plus one message of
// lookahead is satisfied.
//
// MEMORY CEILING, stated honestly. The rows a window accepts are retained (their
// parsed graphs) until the derive returns, so peak is proportional to the BYTES
// the window admits, not to the thread:
//
//   * phase 1 (fill) never starts a row it cannot afford: it stops before the
//     read that would push `payloadChars` past `maxBytes` — except for the very
//     first row, which is always read so a single oversized turn still serves.
//   * phase 2 (boundary) may grow the window to `maxBytes *
//     PI_DERIVE_MAX_WINDOW_BYTE_FACTOR` to close a turn, with the same
//     read-only-what-you-can-afford rule.
//   * the "nothing visible yet" scan is bounded by rows AND by bytes, so a run
//     of huge tool answers cannot admit hundreds of megabytes looking for an
//     anchor.
//
// So the ceiling is `maxBytes * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR` of stored
// payload plus one oversized row, not O(thread) and not unbounded.
//
// Two invariants make that safe, and both live here:
//
//  1. TURN BOUNDARIES. `deriveUiMessagesFromParsedPiCore` folds every pi_core
//     row sharing a `uiMetadata.renderMessageId` into ONE UIMessage under that
//     id (steer user rows interposed between commits become markers inside it).
//     A window that cut such a fold would emit a partial message under an id
//     another page also emits — the client's id-keyed state would keep whichever
//     arrived last and silently lose the rest. So a window is only closed at a
//     boundary no fold and no tool-call/answer pair crosses, and every cursor
//     published names such a boundary.
//  2. SAME CONTENT ⇒ SAME ID. A row's derived id can depend on its POSITION in
//     the legacy full load (`pi_user_<timestamp>_<index>` for unstamped user
//     rows). The window therefore reconstructs absolute positions from the row's
//     idx and the compaction watermark rather than numbering from the window's
//     own start.
import type { UIMessage } from "ai";

import {
  encodeDerivedArchiveCursor,
  encodeDerivedPiRowCursor,
  formatAiChatCreatedAt,
  markRenderFoldPartial,
  selectNewestUiMessageWindow,
  selectNewestUiMessagesWithinBudget,
  type ChatRenderHistoryPage,
} from "../../../../src/lib/chat-render-history";
import {
  deriveUiMessagesWithRowAnchors,
  overlayLiveUiMessages,
  type PiParsedRenderMessage,
} from "../../../../src/lib/derive-ui-messages-from-pi-core";
import { uiMessageCreatedAtMs } from "../../../../src/lib/ui-message-adapter";
import { attachPiToolResultToParsedMessages } from "../pi-message-export";

/**
 * Identity guard for the archive seam: the ids and `role+createdAtMs` keys the
 * derive already owns, which a render-table row must not re-serve.
 *
 * Chronology alone is not enough. A compaction rewrites pi_core in place, and an
 * unstamped user row's derived id embeds its POSITION (`pi_user_<ts>_<index>`),
 * so the same message can come back under a different id after the renumber —
 * which is exactly why the pre-change pager carried both sets.
 */
export interface DerivedArchiveExclusion {
  ids: Set<string>;
  keys: Set<string>;
}

/** The pre-change pager's dedupe key, kept byte-identical on purpose. */
export function renderMessageDedupeKey(message: UIMessage): string {
  const createdAt = uiMessageCreatedAtMs(message);
  if (createdAt !== undefined) return `${message.role}:${createdAt}`;
  return `${message.role}:${message.id}`;
}

function buildArchiveExclusion(
  messages: readonly UIMessage[],
): DerivedArchiveExclusion {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const message of messages) {
    if (!message?.id) continue;
    ids.add(message.id);
    keys.add(renderMessageDedupeKey(message));
  }
  return { ids, keys };
}

/** Rows per metadata batch. Payloads are still materialized one at a time. */
export const PI_DERIVE_ROW_BATCH_SIZE = 24;
/**
 * Rows the boundary resolver may read beyond the page before it gives up and
 * accepts the window as it stands. A turn's pi_core rows are committed together,
 * so a fold spans a short contiguous run; this only bounds the pathological case
 * (a stamp reappearing far below), which would otherwise be an unbounded walk.
 */
export const PI_DERIVE_BOUNDARY_MAX_EXTRA_ROWS = 64;
/**
 * Hard payload ceiling for one window, as a multiple of the page's byte budget.
 *
 * Turn atomicity is a memory liability as well as a correctness rule: ONE ai-chat
 * turn can commit hundreds of pi_core rows under a single `renderMessageId` (every
 * tool call and its answer), each up to `PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS`. A
 * boundary resolver that "just closes the fold" would happily read 90MB to do it
 * and kill the isolate this whole change exists to keep alive. So the fold loses:
 * past this ceiling the window closes mid-fold and says so (`boundaryUnresolved`
 * plus `foldCuts`, which the DO reports at warn severity).
 *
 * Be precise about the consequence: the older page re-emits that id carrying the
 * EARLIER parts. The client keys render history by id, so without a merge the
 * older copy is DROPPED, not deferred — the turn's opening content would never
 * render. `prependOlderRenderMessages` therefore merges parts for a duplicate id
 * instead of discarding the arrival (see src/lib/chat-render-history.ts); this
 * ceiling is safe only because that merge exists.
 */
export const PI_DERIVE_MAX_WINDOW_BYTE_FACTOR = 2;
/**
 * Rows the resolver may scan past the boundary WITHOUT finding a stamped
 * assistant commit before it gives up on an unmatched tool call. A tool answer's
 * call is committed a few rows above it in the same turn, so an id that has gone
 * unmatched for longer than this is orphaned (its assistant row is a storage
 * placeholder, hidden, or corrupt) and must not pin the resolver.
 */
export const PI_DERIVE_BOUNDARY_LOOKAHEAD_ROWS = 8;
/**
 * Rows scanned while the window has produced NOTHING visible yet (hidden
 * internal rows, empty assistant rows). Bounded by BYTES as well (see
 * `fillBudgetSpent`): a contiguous run of megabyte tool answers must not admit
 * hundreds of megabytes looking for an anchor.
 */
export const PI_DERIVE_EMPTY_SCAN_MAX_ROWS = 512;
/** Archive pages consulted in one request while filtering for genuine archive rows. */
const ARCHIVE_PAGE_FILL_MAX_PAGES = 4;

/** One pi_core row, read through the render policy and pre-classified. */
export interface PiDeriveRowRead {
  /** Parsed render rows this row contributes (empty for hidden/internal/empty). */
  parsed: PiParsedRenderMessage[];
  /** Set when the row is a `toolResult`, which folds into the calling assistant. */
  toolResult?: Record<string, unknown>;
  /** `uiMetadata.renderMessageId`: the fold key a window may not cut. */
  stamp: string | null;
  /** tool_use ids this row's parsed content declares. */
  toolUseIds: string[];
  /** The tool call a `toolResult` row answers. */
  toolCallId: string | null;
}

export interface PiDeriveVisibleWindow {
  firstKeptIndex: number;
  summaryOffset: number;
  endIdx: number;
}

export interface PiDeriveRowSource {
  visibleWindow(): PiDeriveVisibleWindow;
  listRowMeta(args: {
    minIdx: number;
    beforeIdx: number;
    limit: number;
  }): Array<{ idx: number; chars: number }>;
  /**
   * `parsedIndex` is the row's position in the LEGACY full load
   * (`idx - firstKeptIndex + summaryOffset`), which is what unstamped rows derive
   * their id from — see the same-content-same-id note at the top of this file.
   */
  readRow(idx: number, parsedIndex: number): PiDeriveRowRead | null;
}

export interface PiDerivedWindowStats {
  /** pi_core payload rows materialized (the allocator this fix bounds). */
  rowsRead: number;
  /** Sum of their stored payload lengths. */
  payloadChars: number;
  /** Rows read past the page to close the window on a turn boundary. */
  boundaryExtraRows: number;
  /** The boundary budget ran out with a fold still possibly open below. */
  boundaryUnresolved: boolean;
  /** toolResult rows whose call sits below the window (dropped, not misattached). */
  droppedToolResults: number;
  /**
   * Tool calls the resolver stopped searching for because they went unmatched
   * past {@link PI_DERIVE_BOUNDARY_LOOKAHEAD_ROWS} extra rows — an answer whose
   * assistant row parses to nothing (storage placeholder, hidden, corrupt). This
   * is deliberately NOT `boundaryUnresolved`: nothing about a fold is in doubt.
   */
  orphanedToolResults: number;
  /**
   * This window closed with its OLDEST message's fold still open below it, so
   * that message is served partial and the older page carries the rest under the
   * same id. Warn-worthy: it is the only shape where two pages emit one id.
   */
  foldCuts: number;
  /** The scan stopped on its byte/row budget rather than on the page bound. */
  budgetExhausted: boolean;
}

export interface PiDerivedRenderWindow {
  /** Oldest → newest, a suffix of the full derive (given a clean boundary). */
  messages: UIMessage[];
  /** pi_core row idx each message is anchored at (a fold: its FIRST row). */
  anchorRowIdx: number[];
  /** pi_core row idx each message ENDS at (a fold: its last row). */
  endRowIdx: number[];
  /** Lowest pi_core row idx included. */
  startRowIdx: number;
  /** No visible pi_core row exists below this window. */
  reachedOldest: boolean;
  stats: PiDerivedWindowStats;
}

const EMPTY_READ: PiDeriveRowRead = {
  parsed: [],
  stamp: null,
  toolUseIds: [],
  toolCallId: null,
};

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Derive the newest (or, with `beforeIdx`, an older) window of settled render
 * messages straight out of pi_core, reading no more rows than the page needs
 * plus the lookahead its boundary and cursor require.
 */
export function deriveRenderWindowFromPiCore(
  source: PiDeriveRowSource,
  options: {
    beforeIdx?: number | null;
    maxMessages: number;
    maxBytes: number;
    rowBatchSize?: number;
    maxBoundaryExtraRows?: number;
    boundaryLookaheadRows?: number;
    emptyScanMaxRows?: number;
  },
): PiDerivedRenderWindow {
  const maxMessages = Math.max(1, Math.floor(options.maxMessages));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));
  const batchSize = positiveInt(
    options.rowBatchSize ?? PI_DERIVE_ROW_BATCH_SIZE,
    PI_DERIVE_ROW_BATCH_SIZE,
  );
  const maxExtraRows = positiveInt(
    options.maxBoundaryExtraRows ?? PI_DERIVE_BOUNDARY_MAX_EXTRA_ROWS,
    PI_DERIVE_BOUNDARY_MAX_EXTRA_ROWS,
  );
  const lookaheadRows = positiveInt(
    options.boundaryLookaheadRows ?? PI_DERIVE_BOUNDARY_LOOKAHEAD_ROWS,
    PI_DERIVE_BOUNDARY_LOOKAHEAD_ROWS,
  );
  const emptyScanMaxRows = positiveInt(
    options.emptyScanMaxRows ?? PI_DERIVE_EMPTY_SCAN_MAX_ROWS,
    PI_DERIVE_EMPTY_SCAN_MAX_ROWS,
  );

  const { firstKeptIndex, summaryOffset, endIdx } = source.visibleWindow();
  const beforeIdx =
    options.beforeIdx === null || options.beforeIdx === undefined
      ? endIdx
      : Math.min(Math.max(0, Math.floor(options.beforeIdx)), endIdx);

  /** Accepted rows, newest-first. */
  const accepted: Array<{ idx: number; read: PiDeriveRowRead }> = [];
  const stamps = new Set<string>();
  const countedStamps = new Set<string>();
  const toolUseIds = new Set<string>();
  /** tool_use id → `boundaryExtraRows` when it started being searched for. */
  const pendingToolCallIds = new Map<string, number>();
  const stats: PiDerivedWindowStats = {
    rowsRead: 0,
    payloadChars: 0,
    boundaryExtraRows: 0,
    boundaryUnresolved: false,
    droppedToolResults: 0,
    orphanedToolResults: 0,
    foldCuts: 0,
    budgetExhausted: false,
  };
  /** Calls the resolver gave up searching for (their answers are orphaned). */
  const abandonedToolCallIds = new Set<string>();
  let anchors = 0;
  let exhausted = false;

  const nextBoundaryIdx = (): number =>
    accepted.length > 0 ? accepted[accepted.length - 1].idx : beforeIdx;

  const readAt = (meta: { idx: number; chars: number }): PiDeriveRowRead => {
    stats.rowsRead += 1;
    stats.payloadChars += meta.chars;
    return (
      source.readRow(meta.idx, meta.idx - firstKeptIndex + summaryOffset) ??
      EMPTY_READ
    );
  };

  const accept = (idx: number, read: PiDeriveRowRead): void => {
    accepted.push({ idx, read });
    if (read.stamp) stamps.add(read.stamp);
    for (const toolUseId of read.toolUseIds) {
      toolUseIds.add(toolUseId);
      pendingToolCallIds.delete(toolUseId);
    }
    if (read.toolResult) {
      if (
        read.toolCallId &&
        !toolUseIds.has(read.toolCallId) &&
        !abandonedToolCallIds.has(read.toolCallId) &&
        !pendingToolCallIds.has(read.toolCallId)
      ) {
        pendingToolCallIds.set(read.toolCallId, stats.boundaryExtraRows);
      }
      return;
    }
    if (read.parsed.length === 0) return;
    // Newest-first: a fold's tail row is seen before its head, so a stamp only
    // ever starts one message.
    if (read.stamp) {
      if (countedStamps.has(read.stamp)) return;
      countedStamps.add(read.stamp);
    }
    anchors += 1;
  };

  const fillBudgetSpent = (): boolean => {
    if (anchors >= maxMessages + 1) return true;
    if (stats.payloadChars >= maxBytes) {
      // Applies with or without an anchor: the "nothing visible yet" scan is
      // bounded by bytes too, so a run of megabyte tool answers cannot admit
      // hundreds of megabytes before it gives up (it falls back to the render
      // table exactly as the row-count cap already made it).
      stats.budgetExhausted = true;
      return true;
    }
    if (anchors === 0 && stats.rowsRead >= emptyScanMaxRows) {
      stats.budgetExhausted = true;
      return true;
    }
    return false;
  };

  // Phase 1: page rows newest-first until the requested page (plus one message
  // of lookahead, so the byte rule sees the same neighbour the full array would)
  // is covered, or a budget stops us. The byte check happens BEFORE the read, so
  // the window cannot overshoot its budget by a whole (up to 1.5MB) row; the
  // very first row is always read so one oversized turn still serves.
  let fillStopped = false;
  while (!fillStopped && !fillBudgetSpent()) {
    const batch = source.listRowMeta({
      minIdx: firstKeptIndex,
      beforeIdx: nextBoundaryIdx(),
      limit: batchSize,
    });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const meta of batch) {
      if (
        accepted.length > 0 &&
        stats.payloadChars + meta.chars > maxBytes
      ) {
        stats.budgetExhausted = true;
        fillStopped = true;
        break;
      }
      accept(meta.idx, readAt(meta));
      if (fillBudgetSpent()) {
        fillStopped = true;
        break;
      }
    }
  }

  // Phase 2: close the window on a turn boundary.
  //
  // The window may not end inside a fold (rows sharing `renderMessageId`) nor
  // hold a tool answer whose call is below it. Both questions are answered by
  // scanning DOWN one row at a time, holding each row out of the window until it
  // is proven necessary:
  //
  //  * a row whose stamp is already in the window continues a fold → it and
  //    everything held above it join the window (`settleHeld`);
  //  * a row declaring a tool_use id the window is still waiting for is the
  //    missing call → same;
  //  * a row carrying a DIFFERENT assistant stamp is an older turn's commit.
  //    Turns commit contiguously, so nothing below it can continue a fold in
  //    this window: the boundary is proven clean and the scan stops.
  //
  // Everything else (tool answers, user rows, hidden rows) is stamp-less and
  // therefore proves nothing — the old fixed 8-row lookahead treated a run of
  // them as a clean boundary, which silently split any turn whose commits were
  // separated by a parallel tool batch of 8+ answers. The scan now walks past
  // such runs (bounded by `maxExtraRows` and the byte ceiling) instead.
  const maxWindowChars = maxBytes * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR;
  let boundaryClean = false;
  /** Rows read below the window and not (yet) part of it, newest-first. */
  let held: Array<{ idx: number; read: PiDeriveRowRead }> = [];
  let metaQueue: Array<{ idx: number; chars: number }> = [];
  /** A foreign stamped commit is already held: only tool calls still block us. */
  let sawForeignCommit = false;

  /** Promote held rows up to (and including) the deepest one now required. */
  const settleHeld = (): boolean => {
    let promoted = false;
    for (;;) {
      let deepest = -1;
      for (let position = 0; position < held.length; position += 1) {
        const read = held[position].read;
        if (read.stamp && stamps.has(read.stamp)) deepest = position;
        else if (
          read.toolUseIds.some((id) => pendingToolCallIds.has(id))
        ) {
          deepest = position;
        }
      }
      if (deepest < 0) return promoted;
      for (let position = 0; position <= deepest; position += 1) {
        accept(held[position].idx, held[position].read);
      }
      held = held.slice(deepest + 1);
      promoted = true;
    }
  };

  /**
   * A tool answer's call is committed a few rows above it in the same turn. An
   * id still unmatched after `lookaheadRows` extra rows is orphaned — its
   * assistant row is a storage placeholder, hidden or corrupt and declares
   * nothing — so stop searching instead of reading one row at a time to the full
   * 64-row / 8MB ceiling on every load of that page.
   */
  const abandonStalePendingCalls = (): void => {
    for (const [id, since] of pendingToolCallIds) {
      if (stats.boundaryExtraRows - since <= lookaheadRows) continue;
      pendingToolCallIds.delete(id);
      abandonedToolCallIds.add(id);
      stats.orphanedToolResults += 1;
    }
  };

  const nextMeta = (): { idx: number; chars: number } | null => {
    if (metaQueue.length === 0) {
      const beforeIdxForProbe =
        held.length > 0 ? held[held.length - 1].idx : nextBoundaryIdx();
      metaQueue = source.listRowMeta({
        minIdx: firstKeptIndex,
        beforeIdx: beforeIdxForProbe,
        limit: Math.max(
          1,
          Math.min(batchSize, maxExtraRows - stats.boundaryExtraRows),
        ),
      });
    }
    return metaQueue.shift() ?? null;
  };

  while (!exhausted) {
    abandonStalePendingCalls();
    if (pendingToolCallIds.size === 0) {
      // Nothing in the window can fold (no assistant stamp at all), or an older
      // turn's commit is already held below it: the boundary is proven.
      if (stamps.size === 0 || sawForeignCommit) {
        boundaryClean = true;
        break;
      }
    }
    if (stats.boundaryExtraRows >= maxExtraRows) break;
    const meta = nextMeta();
    if (meta === null) {
      exhausted = true;
      break;
    }
    if (stats.payloadChars + meta.chars > maxWindowChars) break;
    stats.boundaryExtraRows += 1;
    const read = readAt(meta);
    held.push({ idx: meta.idx, read });
    if (settleHeld()) {
      // The window grew, so an already-held "foreign" commit may now be part of
      // it; re-prove the boundary from scratch.
      sawForeignCommit = false;
      continue;
    }
    if (read.stamp) sawForeignCommit = true;
  }
  // Anything other than "clean break" or "no rows left" means a budget stopped
  // the resolver with an extension possibly still owed: this window may cut a
  // fold, and the older page will re-emit that id with the earlier parts (which
  // the client MERGES — see PI_DERIVE_MAX_WINDOW_BYTE_FACTOR).
  stats.boundaryUnresolved = !boundaryClean && !exhausted;
  stats.foldCuts = stats.boundaryUnresolved && stamps.size > 0 ? 1 : 0;

  // Phase 3: one derive over the window, oldest-first, through the SAME pure
  // transform the full-thread path used.
  const parsed: PiParsedRenderMessage[] = [];
  const parsedRowIdx: number[] = [];
  for (let position = accepted.length - 1; position >= 0; position -= 1) {
    const row = accepted[position];
    if (row.read.toolResult) {
      // An answer whose call is outside the window would be appended to the
      // window's last assistant instead (the parsed-attach fallback), i.e. shown
      // under the wrong turn. Drop it: the turn that owns it is on an older page
      // and carries it there.
      if (row.read.toolCallId && toolUseIds.has(row.read.toolCallId)) {
        attachPiToolResultToParsedMessages(parsed, row.read.toolResult);
      } else {
        stats.droppedToolResults += 1;
      }
      continue;
    }
    for (const entry of row.read.parsed) {
      parsed.push(entry);
      parsedRowIdx.push(row.idx);
    }
  }

  const derived = deriveUiMessagesWithRowAnchors(parsed);
  const startRowIdx =
    accepted.length > 0 ? accepted[accepted.length - 1].idx : beforeIdx;
  return {
    messages: derived.messages,
    anchorRowIdx: derived.anchorIndexes.map((index) => parsedRowIdx[index]),
    endRowIdx: derived.endIndexes.map((index) => parsedRowIdx[index]),
    startRowIdx,
    reachedOldest: exhausted || startRowIdx <= firstKeptIndex,
    stats,
  };
}

export interface PiDerivedPageDeps {
  /** Derive one bounded window (oldest→newest) ending at `beforeIdx`. */
  deriveWindow(beforeIdx: number | null): PiDerivedRenderWindow;
  /** ai-chat's resident render rows (the live/open-turn overlay source). */
  liveMessages(): UIMessage[];
  activeTurnId(): string | null;
  /** One bounded page of the ai-chat render table. */
  renderHistoryPage(args: {
    beforeCursor: string | null;
    maxMessages: number;
    maxBytes: number;
  }): ChatRenderHistoryPage;
  /**
   * pi timestamp of the OLDEST derived message, used to place the archive seam.
   * Only consulted for an archive-phase request (a pi-phase page that reaches
   * the oldest row already knows it).
   */
  oldestDerivedCreatedAtMs(): number | undefined;
}

export interface PiDerivedPageResult extends ChatRenderHistoryPage {
  /** Which store answered, for telemetry and tests. */
  source: "pi" | "archive" | "render_table";
  stats?: PiDerivedWindowStats;
}

/**
 * The newest (or an older) page of settled render history: pi_core-derived tail
 * first, then the pre-compaction archive still held in the ai-chat table.
 */
export function buildDerivedRenderPage(
  deps: PiDerivedPageDeps,
  options: {
    /** Parsed cursor; null means the newest page. */
    cursor: { kind: "pi"; beforeIdx: number } | { kind: "archive"; beforeCursor: string | null } | null;
    maxMessages: number;
    maxBytes: number;
    /**
     * A cursor this pager does not own (ai-chat's own chronology cursor, handed
     * out when the derive was empty). Passed through to the render table when the
     * derive is still empty.
     */
    passthroughCursor?: string | null;
  },
): PiDerivedPageResult {
  const maxMessages = Math.max(1, Math.floor(options.maxMessages));
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));

  if (options.cursor?.kind === "archive") {
    return buildArchivePage(deps, {
      beforeCursor: options.cursor.beforeCursor,
      firstDerivedAtMs: deps.oldestDerivedCreatedAtMs() ?? 0,
      maxMessages,
      maxBytes,
    });
  }

  const isNewestPage = options.cursor === null;
  const window = deps.deriveWindow(
    options.cursor?.kind === "pi" ? options.cursor.beforeIdx : null,
  );

  if (window.messages.length === 0) {
    if (isNewestPage || options.passthroughCursor) {
      // Nothing derives from pi_core: serve the ai-chat table with its native
      // chronology cursor (live-only threads, render-table tests, brand new
      // threads) — the pre-derive behaviour, unchanged.
      const page = deps.renderHistoryPage({
        beforeCursor: options.passthroughCursor ?? null,
        maxMessages,
        maxBytes,
      });
      return { ...page, source: "render_table", stats: window.stats };
    }
    if (!window.reachedOldest) {
      // An older page whose window found nothing visible but has rows below:
      // publish a cursor that keeps the walk moving instead of ending it here.
      // `startRowIdx` is strictly below the requested bound, so this terminates.
      return {
        messages: [],
        nextCursor: encodeDerivedPiRowCursor(window.startRowIdx),
        hasMore: true,
        source: "pi",
        stats: window.stats,
      };
    }
    // An OLDER page that ran out of pi_core rows: continue into the archive if
    // there is one. Deliberately NOT the render-table fallback above — that
    // serves the table's NEWEST rows, which a client asking for older history
    // would prepend to the top of its transcript. This is also the landing spot
    // for a cursor left stale by a compaction that moved the watermark past it.
    const firstDerivedAtMs = deps.oldestDerivedCreatedAtMs() ?? 0;
    const seam = archiveSeamCursor(firstDerivedAtMs);
    if (seam === null) {
      return {
        messages: [],
        nextCursor: null,
        hasMore: false,
        source: "pi",
        stats: window.stats,
      };
    }
    return buildArchivePage(deps, {
      beforeCursor: seam,
      firstDerivedAtMs,
      maxMessages,
      maxBytes,
    });
  }

  if (options.passthroughCursor) {
    // An ai-chat chronology cursor handed out while the derive was still empty,
    // replayed now that pi_core has history: it can only name a render-table row,
    // so continue in the archive phase from there (the seam filter keeps rows the
    // derive itself owns out of the page).
    return buildArchivePage(deps, {
      beforeCursor: options.passthroughCursor,
      firstDerivedAtMs: deps.oldestDerivedCreatedAtMs() ?? 0,
      maxMessages,
      maxBytes,
    });
  }

  // The resident window overlays the newest page (open turn, client-minted user
  // skeletons). Older pages take the REPLACEMENTS only: a live-only row belongs
  // at the transcript's newest end, which is not this page.
  const overlaid = overlayLiveUiMessages(
    window.messages,
    deps.liveMessages(),
    {
      activeTurnId: deps.activeTurnId(),
      appendLiveOnly: isNewestPage,
      // The window is a suffix, not the transcript: only a resident row at or
      // after its newest settled message can be genuinely live-only.
      appendLiveOnlyNewerThanMs:
        uiMessageCreatedAtMs(window.messages[window.messages.length - 1]) ?? 0,
    },
  );
  const budgeted = selectNewestUiMessageWindow(overlaid, {
    maxMessages,
    maxBytes,
  });
  const startIndex = extendPageToFoldBoundary(
    overlaid.length - budgeted.messages.length,
    window,
  );
  const rawSelected =
    startIndex === overlaid.length - budgeted.messages.length
      ? budgeted.messages
      : overlaid.slice(startIndex);
  // A window that closed inside a fold serves its OLDEST message partial: the
  // turn's earlier parts sit below `startRowIdx` and arrive on the next page
  // under the same id. Say so on the wire — the client MERGES a flagged
  // message's halves instead of dropping the later arrival, which is the only
  // thing that keeps a cut fold from being permanent, silent data loss.
  const selected = markPartialFoldHead(rawSelected, startIndex, window, deps);

  if (startIndex > 0 || !window.reachedOldest) {
    // The next older page ends exclusively at a turn boundary: the anchor row of
    // the oldest message served, or one past the newest fold's last row when the
    // page carried only appended live rows.
    const beforeIdx =
      startIndex < window.anchorRowIdx.length
        ? window.anchorRowIdx[startIndex]
        : (window.endRowIdx[window.endRowIdx.length - 1] ?? window.startRowIdx) + 1;
    return {
      messages: selected,
      nextCursor: encodeDerivedPiRowCursor(beforeIdx),
      hasMore: true,
      source: "pi",
      stats: window.stats,
    };
  }

  // pi_core is exhausted: this page has reached back past the derived tail, so
  // anything older is pre-compaction archive still held in the ai-chat table.
  // THIS is the only place the archive is consulted — a page that stopped on its
  // own budget never touches it, which is what keeps a whale thread's load cheap.
  //
  // The seam is the MINIMUM pi timestamp in the window, never `messages[0]`'s.
  // After a preserve-compaction the derive's FIRST message is the synthetic
  // "[Context Summary]" row, whose timestamp is the compaction wall clock — i.e.
  // NEWER than every row it summarizes and every row of the kept tail. Reading
  // the seam off it opened the filter to the entire render table, including the
  // kept tail's own mirrors, so every compacted thread's first page duplicated
  // its newest turns.
  const firstDerivedAtMs = oldestUiMessageCreatedAtMs(window.messages);
  const archiveCursor = archiveSeamCursor(firstDerivedAtMs);
  if (archiveCursor === null) {
    return {
      messages: selected,
      nextCursor: null,
      hasMore: false,
      source: "pi",
      stats: window.stats,
    };
  }
  // The derive owns these messages; a render-table mirror of any of them is a
  // duplicate no matter what its chronology says.
  const exclude = buildArchiveExclusion([...window.messages, ...selected]);
  const remainingMessages = maxMessages - selected.length;
  const remainingBytes = maxBytes - budgeted.bytes;
  if (remainingMessages <= 0 || remainingBytes <= 0) {
    // The page is already full; only report whether older rows exist.
    const hasArchive = archivePageHasRows(deps, {
      beforeCursor: archiveCursor,
      firstDerivedAtMs,
      maxMessages,
      maxBytes,
      exclude,
    });
    return {
      messages: selected,
      nextCursor: hasArchive ? encodeDerivedArchiveCursor(archiveCursor) : null,
      hasMore: hasArchive,
      source: "pi",
      stats: window.stats,
    };
  }
  // Top the page up from the archive with the budget the derive left over, so a
  // compacted thread still opens on a full window rather than on its short tail.
  const archive = buildArchivePage(deps, {
    beforeCursor: archiveCursor,
    firstDerivedAtMs,
    maxMessages: remainingMessages,
    maxBytes: remainingBytes,
    exclude,
  });
  return {
    messages:
      archive.messages.length > 0
        ? [...archive.messages, ...selected]
        : selected,
    nextCursor: archive.nextCursor,
    hasMore: archive.hasMore,
    source: "pi",
    stats: window.stats,
  };
}

/**
 * Flag the oldest message of a window that closed mid-fold.
 *
 * Only the window's own oldest message can be partial (`startIndex === 0`): any
 * later one has its whole fold inside the window. A message the live overlay
 * replaced is skipped — ai-chat's resident row carries the complete turn.
 */
function markPartialFoldHead(
  selected: UIMessage[],
  startIndex: number,
  window: PiDerivedRenderWindow,
  deps: PiDerivedPageDeps,
): UIMessage[] {
  if (startIndex !== 0 || selected.length === 0) return selected;
  if (window.stats.foldCuts === 0) return selected;
  const head = selected[0];
  if (deps.liveMessages().some((message) => message.id === head.id)) {
    return selected;
  }
  return [markRenderFoldPartial(head), ...selected.slice(1)];
}

/**
 * Grow a page downward until the row boundary it will publish splits no fold.
 *
 * Message order is anchor order, but a fold's ROWS can extend past the anchors of
 * later messages: a steered turn is `A(T) … steer-user … A(T)`, so the steer
 * bubble is a message of its own whose row sits INSIDE the fold's span while
 * sorting after it. A page that served only the steer bubble would publish its
 * anchor as the boundary, and the next page — deriving rows below it — would emit
 * the SAME turn id carrying only the pre-steer half. The client keeps whichever
 * arrives last, so the other half of the turn silently disappears.
 *
 * A fold is therefore atomic for pagination: if the boundary lands inside one,
 * the page extends down to that fold's anchor (and re-checks, since the extension
 * can uncover another). This can push a page one or two messages past its budget,
 * exactly as an oversized single message already does.
 */
function extendPageToFoldBoundary(
  startIndex: number,
  window: PiDerivedRenderWindow,
): number {
  // A page that begins inside the appended live tail publishes "one past the
  // newest fold" instead, which is already a fold boundary.
  if (startIndex >= window.anchorRowIdx.length) return startIndex;
  let index = startIndex;
  while (index > 0) {
    const boundary = window.anchorRowIdx[index];
    let straddling = -1;
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      if (window.endRowIdx[candidate] >= boundary) {
        straddling = candidate;
        break;
      }
    }
    if (straddling < 0) break;
    index = straddling;
  }
  return index;
}

/**
 * The oldest pi timestamp in a derived window — NOT `messages[0]`'s, which after
 * a preserve-compaction is the wall-clock-stamped summary bubble.
 */
function oldestUiMessageCreatedAtMs(messages: readonly UIMessage[]): number {
  let oldest = 0;
  for (const message of messages) {
    const createdAt = uiMessageCreatedAtMs(message);
    if (createdAt === undefined || !(createdAt > 0)) continue;
    if (oldest === 0 || createdAt < oldest) oldest = createdAt;
  }
  return oldest;
}

/** Chronology cursor for "strictly older than the derive's first message". */
function archiveSeamCursor(firstDerivedAtMs: number): string | null {
  if (!Number.isFinite(firstDerivedAtMs) || firstDerivedAtMs <= 0) return null;
  return `e:${formatAiChatCreatedAt(firstDerivedAtMs)}`;
}

/**
 * A render-table row is pre-compaction archive only if it carries a pi timestamp
 * older than the derive's first message. Rows without one are live skeletons
 * whose insert-time chronology can sort below the derive; rows at or after the
 * seam arrive through the derive or the live overlay.
 */
function archiveRows(
  page: ChatRenderHistoryPage,
  firstDerivedAtMs: number,
  exclude?: DerivedArchiveExclusion,
): UIMessage[] {
  const kept: UIMessage[] = [];
  for (const message of page.messages) {
    if (!message?.id) continue;
    const createdAt = uiMessageCreatedAtMs(message);
    if (createdAt === undefined || createdAt >= firstDerivedAtMs) continue;
    // Chronology alone cannot be trusted at the seam: equal timestamps, and
    // `pi_user_<ts>_<index>` ids that renumber when pi_core is rewritten. The
    // pre-change pager kept both an id set and a role+createdAtMs key set for
    // exactly this; so does this one.
    if (exclude?.ids.has(message.id)) continue;
    if (exclude?.keys.has(renderMessageDedupeKey(message))) continue;
    kept.push(message);
  }
  return kept;
}

function archivePageHasRows(
  deps: PiDerivedPageDeps,
  args: {
    beforeCursor: string;
    firstDerivedAtMs: number;
    maxMessages: number;
    maxBytes: number;
    exclude?: DerivedArchiveExclusion;
  },
): boolean {
  let beforeCursor: string | null = args.beforeCursor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = deps.renderHistoryPage({
      beforeCursor,
      maxMessages: 1,
      maxBytes: args.maxBytes,
    });
    if (archiveRows(page, args.firstDerivedAtMs, args.exclude).length > 0) {
      return true;
    }
    if (!page.hasMore || !page.nextCursor) return false;
    beforeCursor = exclusiveArchiveCursor(page.nextCursor);
  }
  // Inconclusive after a bounded probe, but rows older than the seam remain:
  // claim more rather than truncating the transcript. The archive page itself
  // may then come back empty, which the client treats as the end.
  return true;
}

/**
 * ai-chat hands out an INCLUSIVE cursor (`i:`) so a re-read overlaps its
 * boundary row; the walk here has already served that row, so re-emit it
 * exclusive and keep pages disjoint.
 */
function exclusiveArchiveCursor(cursor: string): string {
  const key = cursor.startsWith("i:") || cursor.startsWith("e:")
    ? cursor.slice(2)
    : cursor;
  return `e:${key}`;
}

function buildArchivePage(
  deps: PiDerivedPageDeps,
  args: {
    beforeCursor: string | null;
    firstDerivedAtMs: number;
    maxMessages: number;
    maxBytes: number;
    exclude?: DerivedArchiveExclusion;
  },
): PiDerivedPageResult {
  const seam = archiveSeamCursor(args.firstDerivedAtMs);
  let beforeCursor: string | null = args.beforeCursor ?? seam;
  if (beforeCursor === null) {
    return { messages: [], nextCursor: null, hasMore: false, source: "archive" };
  }

  const collected: UIMessage[] = [];
  let hasMore = false;
  let nextCursor: string | null = null;
  for (let page = 0; page < ARCHIVE_PAGE_FILL_MAX_PAGES; page += 1) {
    const archivePage = deps.renderHistoryPage({
      beforeCursor,
      maxMessages: args.maxMessages,
      maxBytes: args.maxBytes,
    });
    collected.unshift(
      ...archiveRows(archivePage, args.firstDerivedAtMs, args.exclude),
    );
    hasMore = archivePage.hasMore && !!archivePage.nextCursor;
    nextCursor = hasMore
      ? encodeDerivedArchiveCursor(
          exclusiveArchiveCursor(archivePage.nextCursor as string),
        )
      : null;
    if (collected.length > 0 || !hasMore) break;
    beforeCursor = exclusiveArchiveCursor(archivePage.nextCursor as string);
  }

  collected.sort(
    (left, right) =>
      (uiMessageCreatedAtMs(left) ?? 0) - (uiMessageCreatedAtMs(right) ?? 0),
  );
  const overlaid = overlayLiveUiMessages(collected, deps.liveMessages(), {
    activeTurnId: deps.activeTurnId(),
    appendLiveOnly: false,
  });
  const selected = selectNewestUiMessagesWithinBudget(overlaid, {
    maxMessages: args.maxMessages,
    maxBytes: args.maxBytes,
  });
  if (selected.length < overlaid.length) {
    // The byte rule cut inside this archive page; re-read from the boundary we
    // actually served rather than skipping the remainder.
    const oldestServed = selected[0];
    const oldestServedAtMs = uiMessageCreatedAtMs(oldestServed);
    const cursor = archiveSeamCursor(oldestServedAtMs ?? 0);
    return {
      messages: selected,
      nextCursor: cursor ? encodeDerivedArchiveCursor(cursor) : nextCursor,
      hasMore: true,
      source: "archive",
    };
  }
  return { messages: selected, nextCursor, hasMore, source: "archive" };
}
