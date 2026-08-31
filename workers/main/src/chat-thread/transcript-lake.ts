// pi_core → transcript data lake mirror.
//
// Streams every persisted pi_core row to the `pi_messages` Iceberg table so
// fleet-wide transcript questions become one SQL query instead of one Durable
// Object wakeup per thread. (Reading ONE transcript stays faster through the
// admin API — this exists for bulk and predicate-selected reads.)
//
// Durability model mirrors the pi_core → ai-chat render-history backfill in
// ./ui-mirror: a high-water mark in DO storage, advanced only after the stream
// accepts the rows. A failed or dropped send simply leaves the mark behind, and
// the next sync (post-append, or on the next WebSocket connect) re-sends the
// same range. That makes at-least-once the guarantee and duplicates expected;
// readers dedupe on (thread_id, idx) keeping the newest ingested_at_ms.
import {
  boundLakeErrorMessage,
  sendPiMessageRecords,
  truncateForLake,
  type LakeStreamEnv,
  type PiMessageLakeRecord,
} from "../lake-streams";
import { normalizePiUiMetadata } from "../../../../src/lib/runtime-artifacts";
import type { ChatContextState } from "./types";

/** Next pi_core idx to export. */
const TRANSCRIPT_LAKE_MARK_KEY = "transcriptLakeSyncedIdx";
/**
 * `created_at` of the last exported row. replacePiCoreMessages (compaction,
 * fork seeding, admin repair) rewrites the whole table with a fresh timestamp,
 * so a mismatch here is the rewrite signal that forces a full re-export.
 */
const TRANSCRIPT_LAKE_MARK_STAMP_KEY = "transcriptLakeSyncedCreatedAtMs";

/**
 * Rows exported per sync call. A cold DO holding a long thread backfills its
 * whole history on first sync; capping the batch keeps that off a turn's
 * critical path, and the watermark makes the remainder resumable on the next
 * call rather than lost.
 */
const TRANSCRIPT_LAKE_MAX_ROWS_PER_SYNC = 500;

export interface TranscriptLakeDeps {
  sql(): SqlStorage;
  kv(): {
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
  };
  chatContext(): ChatContextState | null;
  env(): LakeStreamEnv;
  withMemoryPhase<T>(operation: string, fn: () => Promise<T>): Promise<T>;
  recordChatThreadObservabilityEvent(
    event: string,
    details?: Record<string, unknown>,
  ): void;
}

interface PiCoreRow extends Record<string, SqlStorageValue> {
  idx: number;
  payload: string;
  created_at: number;
}

/** Text projection of a pi message. Never carries image bytes. */
export function projectPiContentForLake(content: unknown): {
  text: string;
  imageCount: number;
} {
  if (typeof content === "string") return { text: content, imageCount: 0 };
  if (!Array.isArray(content)) return { text: "", imageCount: 0 };
  const parts: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      parts.push(item.thinking);
    } else if (item.type === "image") {
      // Deliberately drops `data`: image bytes would dominate the table and are
      // useless to SQL. The count keeps their presence queryable.
      imageCount += 1;
    } else if (item.type === "toolCall") {
      const name = typeof item.name === "string" ? item.name : "tool";
      parts.push(`[toolCall:${name}]`);
    }
  }
  return { text: parts.join("\n"), imageCount };
}

export function piCoreRowToLakeRecord(
  row: PiCoreRow,
  context: {
    threadId: string;
    orgId: string;
    workspaceId: string;
    userId: string;
  },
  ingestedAtMs: number,
): PiMessageLakeRecord | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    // A corrupt row must not wedge the mark behind it forever; skipping matches
    // how loadFullPiCoreTranscriptUnbounded tolerates unparseable history.
    return null;
  }
  const role = typeof parsed.role === "string" ? parsed.role : "";
  if (!role) return null;
  const projected = projectPiContentForLake(parsed.content);
  const bounded = truncateForLake(projected.text);
  const uiMetadata = normalizePiUiMetadata(parsed.uiMetadata);
  const timestamp =
    typeof parsed.timestamp === "number" && Number.isFinite(parsed.timestamp)
      ? Math.floor(parsed.timestamp)
      : row.created_at;
  return {
    ingested_at_ms: ingestedAtMs,
    ts_ms: timestamp,
    thread_id: context.threadId,
    org_id: context.orgId,
    workspace_id: context.workspaceId,
    user_id: context.userId,
    idx: row.idx,
    role,
    render_message_id: uiMetadata?.renderMessageId ?? "",
    tool_name: typeof parsed.toolName === "string" ? parsed.toolName : "",
    tool_call_id: typeof parsed.toolCallId === "string" ? parsed.toolCallId : "",
    tool_is_error: parsed.isError === true,
    tool_duration_ms: uiMetadata?.toolDurationMs ?? -1,
    model: typeof parsed.model === "string" ? parsed.model : "",
    provider: typeof parsed.provider === "string" ? parsed.provider : "",
    stop_reason: typeof parsed.stopReason === "string" ? parsed.stopReason : "",
    text: bounded.text,
    text_chars: bounded.chars,
    text_truncated: bounded.truncated,
    image_count: projected.imageCount,
  };
}

export class TranscriptLakeMirror {
  constructor(private readonly deps: TranscriptLakeDeps) {}

  /**
   * Export pi_core rows at or beyond the high-water mark. Safe to call on every
   * append and on connect: with no new rows (or no configured binding) it costs
   * one scalar read and returns.
   *
   * Calls are serialized against each other. A single turn commits several
   * times (user message, turn_end, agent_end) and each commit schedules a sync;
   * run concurrently they all read the same pending range before any of them
   * advances the mark, so every row ships two or three times. Chaining makes
   * each sync observe its predecessor's mark, which leaves duplicates to their
   * intended cause — a failed send or an eviction replay — rather than making
   * them the norm. Correctness never depended on this (readers dedupe on
   * (thread_id, idx)), but ingest, storage, and scan cost all did.
   */
  syncTranscriptLake(options: { force?: boolean } = {}): Promise<void> {
    const previous = this.inFlightSync ?? Promise.resolve();
    // Swallow a predecessor's rejection here only: its own caller still sees it.
    const next = previous.catch(() => {}).then(() => this.runSync(options));
    this.inFlightSync = next;
    return next;
  }

  private inFlightSync?: Promise<void>;

  private async runSync(options: { force?: boolean }): Promise<void> {
    if (!this.deps.env().TRANSCRIPT_LAKE) return;
    const context = this.deps.chatContext();
    const threadId = context?.threadId ?? "";
    if (!threadId) return;

    const startedAt = Date.now();
    const rows = await this.deps.withMemoryPhase("transcript_lake_read", async () =>
      this.readPendingRows(options.force === true),
    );
    if (rows.length === 0) return;

    const ingestedAtMs = Date.now();
    const records: PiMessageLakeRecord[] = [];
    for (const row of rows) {
      const record = piCoreRowToLakeRecord(
        row,
        {
          threadId,
          orgId: context?.orgId ?? "",
          workspaceId: context?.workspaceId ?? "",
          userId: context?.userId ?? "",
        },
        ingestedAtMs,
      );
      if (record) records.push(record);
    }

    const lastRow = rows[rows.length - 1];
    const sent = records.length === 0
      ? true // every row in the range was unparseable; advance past them
      : await sendPiMessageRecords(this.deps.env(), records);
    if (!sent) {
      // Mark stays put: the same range re-sends on the next sync.
      this.deps.recordChatThreadObservabilityEvent("transcript_lake_sync", {
        operation: "transcript_lake_sync",
        status: "send_failed",
        severity: "warn",
        count: records.length,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    this.deps.kv().put(TRANSCRIPT_LAKE_MARK_KEY, lastRow.idx + 1);
    this.deps.kv().put(TRANSCRIPT_LAKE_MARK_STAMP_KEY, lastRow.created_at);
    this.deps.recordChatThreadObservabilityEvent("transcript_lake_sync", {
      operation: "transcript_lake_sync",
      status: "ok",
      count: records.length,
      durationMs: Date.now() - startedAt,
    });
  }

  private readPendingRows(force: boolean): Promise<PiCoreRow[]> {
    const mark = force ? 0 : this.readValidatedMark();
    const rows = this.deps.sql()
      .exec<PiCoreRow>(
        `SELECT idx, payload, created_at FROM pi_core_messages
         WHERE idx >= ? ORDER BY idx ASC LIMIT ?`,
        mark,
        TRANSCRIPT_LAKE_MAX_ROWS_PER_SYNC,
      )
      .toArray();
    return Promise.resolve(rows);
  }

  /**
   * The stored mark, or 0 when the row it was taken against no longer matches —
   * i.e. replacePiCoreMessages rewrote history underneath us and the whole
   * thread needs re-exporting.
   */
  private readValidatedMark(): number {
    const mark = this.deps.kv().get<number>(TRANSCRIPT_LAKE_MARK_KEY) ?? 0;
    if (mark <= 0) return 0;
    const stamp = this.deps.kv().get<number>(TRANSCRIPT_LAKE_MARK_STAMP_KEY);
    if (typeof stamp !== "number") return 0;
    const row = this.deps.sql()
      .exec<{ created_at: number }>(
        "SELECT created_at FROM pi_core_messages WHERE idx = ?",
        mark - 1,
      )
      .toArray()[0];
    if (!row || row.created_at !== stamp) return 0;
    return mark;
  }
}

export const __testing = {
  TRANSCRIPT_LAKE_MARK_KEY,
  TRANSCRIPT_LAKE_MARK_STAMP_KEY,
  TRANSCRIPT_LAKE_MAX_ROWS_PER_SYNC,
  boundLakeErrorMessage,
};
