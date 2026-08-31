/**
 * PER-SURFACE WORKING-SET BUDGETS — the class net's numbers, in one place.
 *
 * Each budget is what ONE invocation of a DO surface may materialize out of
 * SQLite while serving a whale thread (see whale-thread-fixture: ~6_000 rows,
 * ~40 MB stored). They are derived from the SHIPPED bounds, not fitted to the
 * current implementation's measurements: every number below is a shipped
 * constant times the factor that constant's own doc-comment admits, plus a
 * stated slack. That direction matters — a budget fitted to today's numbers
 * ratchets on every refactor and stops meaning anything, while a budget derived
 * from the bound fails exactly when the bound stops holding.
 *
 * Rule for changing one: you may raise a budget only by raising the SHIPPED
 * bound it is derived from, and only with the same reasoning written down.
 * "Make the test pass" is not a reason (BOUNDED-MEMORY-BY-CONSTRUCTION, non-goals).
 */

import { CHAT_RENDER_WINDOW_MAX_BYTES } from "../../../../src/lib/chat-render-history";
import { PI_DERIVE_MAX_WINDOW_BYTE_FACTOR } from "../../src/chat-thread/derived-render-page";
import { PI_SESSION_LOAD_MAX_CHARS } from "../../src/chat-thread/pi-core-store";
import { PI_PRESERVE_ARCHIVE_BATCH_CHARS } from "../../src/chat-thread/render-archive-preserve";
import {
  UI_TOPUP_MAX_CHARS_PER_CALL,
  UI_TOPUP_MAX_ROWS_PER_CALL,
} from "../../src/chat-thread/ui-mirror";
import type { StorageUsage } from "./instrumented-do-storage";

export interface WorkingSetBudget {
  surface: string;
  why: string;
  /** Cumulative pi_core payload chars this surface may materialize. */
  piCoreBytesMaterialized?: number;
  /** Cumulative pi_core rows this surface may materialize. */
  piCoreRowsRead?: number;
  /** Largest SINGLE materialization, whatever the table. */
  maxBytesPerQuery?: number;
  /** Largest read-side accumulation between two durable render writes. */
  maxBytesBetweenRenderWrites?: number;
  /** Cumulative render-table payload chars. */
  renderBytesMaterialized?: number;
  /** Cumulative stream-buffer payload chars. */
  streamBytesMaterialized?: number;
}

/**
 * One derived render window's hard ceiling: the pager's byte budget times the
 * factor its boundary phase is allowed to grow by, plus one oversized row.
 */
const DERIVE_WINDOW_CEILING_CHARS =
  CHAT_RENDER_WINDOW_MAX_BYTES * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR;
/** A single pi_core row's storage soft limit; every "plus one row" slack. */
const ONE_OVERSIZED_ROW_CHARS = 1_500_000;

export const WORKING_SET_BUDGETS = {
  /**
   * Connect / first settled page. The bound is one derived window; the archive
   * top-up may add one render page on a compacted thread.
   */
  connectFirstPage: {
    surface: "connect + first settled page",
    why:
      "deriveRenderWindowFromPiCore is capped at maxBytes * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR " +
      "plus the one row the fill rule always admits. This is the bug that shipped as " +
      "derive-then-paginate: the pre-change pager read every row before paginating.",
    piCoreBytesMaterialized: DERIVE_WINDOW_CEILING_CHARS + ONE_OVERSIZED_ROW_CHARS,
    // 24-row metadata batches with one payload read each; the boundary resolver
    // may add 64. A page never legitimately touches hundreds of rows.
    piCoreRowsRead: 512,
    maxBytesPerQuery: ONE_OVERSIZED_ROW_CHARS,
    renderBytesMaterialized: CHAT_RENDER_WINDOW_MAX_BYTES * 2,
  },
  /** Any older page. Same window bound — pagination does not get cheaper or dearer. */
  olderPage: {
    surface: "older settled page",
    why: "identical to the first page: one bounded window per request, cursor in row space.",
    piCoreBytesMaterialized: DERIVE_WINDOW_CEILING_CHARS + ONE_OVERSIZED_ROW_CHARS,
    piCoreRowsRead: 512,
    maxBytesPerQuery: ONE_OVERSIZED_ROW_CHARS,
    renderBytesMaterialized: CHAT_RENDER_WINDOW_MAX_BYTES * 2,
  },
  /**
   * Turn start: the model-side session load (stage 1c). The cap is on the
   * VISIBLE window's payload; the metadata probes that choose the cut select no
   * payload at all, so nothing but the admitted tail is materialized.
   */
  sessionLoad: {
    surface: "turn start (bounded session load)",
    why:
      "PI_SESSION_LOAD_MAX_CHARS bounds what a session build may materialize; the fill rule " +
      "always admits the newest row, hence one row of slack.",
    piCoreBytesMaterialized: PI_SESSION_LOAD_MAX_CHARS + ONE_OVERSIZED_ROW_CHARS,
    maxBytesPerQuery: PI_SESSION_LOAD_MAX_CHARS + ONE_OVERSIZED_ROW_CHARS,
  },
  /**
   * Provider request prepare (transformContext). It works on the session's
   * IN-MEMORY list; the only storage it touches is the compaction row and, when
   * it cuts, one small write. A provider prepare that reads pi_core rows has
   * regressed into re-loading the transcript 25 times per turn.
   */
  providerPrepare: {
    surface: "provider request prepare (transformContext)",
    why:
      "the request view is built from the session's resident list. Reading pi_core here at all " +
      "means the per-request path re-materializes history, which is the 25x amplifier.",
    piCoreBytesMaterialized: 64_000,
    piCoreRowsRead: 8,
  },
  /**
   * Compaction preserve path (stage 2a). Scoped to the rows the post-compaction
   * derive can no longer see, and walked one bounded window at a time — so the
   * meaningful bound is PEAK, not cumulative: bytes read between two durable
   * render writes may never exceed a batch's ceiling.
   */
  compactionPreserve: {
    surface: "compaction preserve (render archive snapshot)",
    why:
      "peak STORAGE residency is one derived window per persisted batch " +
      "(PI_PRESERVE_ARCHIVE_BATCH_CHARS * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR). The pre-change path " +
      "derived the WHOLE transcript and persisted it in one call, so its peak was the thread. " +
      "NOTE the scope: every counter here bounds what a STORAGE OPERATION materializes, and " +
      "maxBytesBetweenRenderWrites resets on each durable render write — so nothing in this " +
      "budget can see JS-heap retention ACROSS batches. That half is bounded separately, by the " +
      "single-message fold carry in render-archive-preserve, and asserted separately via " +
      "PreserveArchiveResult.peakRetainedMessages (chat-thread-render-archive-preserve.test.ts).",
    maxBytesBetweenRenderWrites:
      PI_PRESERVE_ARCHIVE_BATCH_CHARS * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR +
      ONE_OVERSIZED_ROW_CHARS,
    maxBytesPerQuery: ONE_OVERSIZED_ROW_CHARS,
  },
  /**
   * Render-mirror top-up (stage 2b). Bounded PER INVOCATION and resumable, so
   * this is a cumulative bound on one call.
   */
  mirrorTopUp: {
    surface: "render mirror top-up (one invocation)",
    why:
      "UI_TOPUP_MAX_CHARS_PER_CALL / UI_TOPUP_MAX_ROWS_PER_CALL, plus the turn-boundary " +
      "extension the reader is allowed (PI_TOPUP_BOUNDARY_MAX_EXTRA_ROWS = 256 rows) before it " +
      "retreats to the last boundary instead. The one shape that may exceed this is a single " +
      "turn longer than the whole budget, which has no legal boundary to retreat to and reports " +
      "itself as pi_topup_range_over_extended.",
    piCoreBytesMaterialized: UI_TOPUP_MAX_CHARS_PER_CALL * 2,
    piCoreRowsRead: UI_TOPUP_MAX_ROWS_PER_CALL + 256,
    maxBytesPerQuery: ONE_OVERSIZED_ROW_CHARS,
  },
  /**
   * Wake-time recovery classification. Reads the resumable-stream buffer, never
   * pi_core. Its own ceiling ships in chat-thread-do (recoveryPartialMaxStoredBytes).
   */
  recoveryClassification: {
    surface: "wake recovery classification",
    why:
      "the classification read is bounded by the recovery-partial ceiling and touches no " +
      "transcript at all. Any pi_core read here runs before the isolate is known to be healthy.",
    piCoreBytesMaterialized: 0,
    streamBytesMaterialized: 8_000_000,
  },
  /**
   * Stream replay. Must send the whole buffer, so the bound is per QUERY: the
   * batched reader pages it, the pre-change reader materialized it at once.
   */
  streamReplay: {
    surface: "stream replay (resume)",
    why:
      "a replay legitimately emits every stored chunk, so the invariant is that it never " +
      "materializes them all at once — the batched reader's page, not the buffer.",
    maxBytesPerQuery: 2_000_000,
    piCoreBytesMaterialized: 0,
  },
} satisfies Record<string, WorkingSetBudget>;

export type WorkingSetSurface = keyof typeof WORKING_SET_BUDGETS;

const MEASURED: Array<keyof StorageUsage> = [
  "piCoreBytesMaterialized",
  "piCoreRowsRead",
  "maxBytesPerQuery",
  "maxBytesBetweenRenderWrites",
  "renderBytesMaterialized",
  "streamBytesMaterialized",
];

/** Every budget line this usage violates, as human-readable strings. */
export function budgetViolations(
  usage: StorageUsage,
  budget: WorkingSetBudget,
): string[] {
  const violations: string[] = [];
  for (const key of MEASURED) {
    const limit = (budget as unknown as Record<string, number | undefined>)[key];
    if (limit === undefined) continue;
    const actual = usage[key];
    if (actual > limit) {
      violations.push(`${budget.surface}: ${key} ${actual} > ${limit}`);
    }
  }
  return violations;
}
