// Cloudflare Pipelines stream bindings for the transcript data lake.
//
// Two narrow, FLAT record shapes are sent here and land as Apache Iceberg
// tables in R2 Data Catalog (see config/pipelines/README.md):
//
//   pi_messages  - one row per persisted pi_core row (the transcript itself)
//   tool_calls   - one row per tool execution, including the inner code-mode
//                  calls that js_exec makes and that never reach pi_core
//
// Flatness is load-bearing, not stylistic. Parquet is columnar, and R2 SQL
// bills on bytes scanned: with real columns a duration/percentile query prunes
// the fat `text` column and reads almost nothing, whereas a single JSON payload
// column would force every query to scan the entire transcript corpus.
//
// Both bindings are OPTIONAL. Local dev, `vitest`, and any environment whose
// Wrangler config omits the binding simply do not export — every helper here
// no-ops on a missing binding exactly like recordObservabilityEvent does for a
// missing Analytics Engine dataset.
import { waitUntil } from "cloudflare:workers";

/**
 * Structural shape of a Pipelines stream binding. Declared locally rather than
 * imported from `cloudflare:pipelines` so the worker still typechecks in
 * environments that have not configured (and therefore not code-generated) the
 * binding, and so tests can inject a plain fake.
 */
export interface LakeStream<TRecord> {
  send(records: TRecord[]): Promise<void>;
}

export interface LakeStreamEnv {
  TRANSCRIPT_LAKE?: LakeStream<PiMessageLakeRecord>;
  TOOL_CALLS_LAKE?: LakeStream<ToolCallLakeRecord>;
}

/** One row per persisted pi_core message. */
export interface PiMessageLakeRecord {
  ingested_at_ms: number;
  ts_ms: number;
  thread_id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  idx: number;
  role: string;
  render_message_id: string;
  tool_name: string;
  tool_call_id: string;
  tool_is_error: boolean;
  /** -1 when unknown (pi records no start time; see PiUiMetadata.toolDurationMs). */
  tool_duration_ms: number;
  model: string;
  provider: string;
  stop_reason: string;
  /** Bounded text projection. Never contains image bytes. */
  text: string;
  /** Full character count before truncation, so truncation is visible in SQL. */
  text_chars: number;
  text_truncated: boolean;
  image_count: number;
}

/** One row per tool execution. Carries no message content. */
export interface ToolCallLakeRecord {
  ingested_at_ms: number;
  ts_ms: number;
  thread_id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  turn_id: string;
  tool_call_id: string;
  /** Set for calls js_exec makes through the code-mode binding; "" at top level. */
  parent_tool_call_id: string;
  tool_name: string;
  /** "agent" for model-visible calls, "code_mode" for inner js_exec calls. */
  surface: string;
  model: string;
  provider: string;
  duration_ms: number;
  ok: boolean;
  error_message: string;
  /**
   * True for tools that block on a human answering. These dominate any naive
   * "slowest tool" ranking while measuring nothing but how long the user was
   * away, so ranking queries filter on this rather than hardcoding names.
   */
  blocks_on_human: boolean;
  result_chars: number;
}

/**
 * Tools whose duration is bounded by a human, not by our systems.
 * Keep in sync with the blocking tool surface in pi-tools.ts.
 */
const HUMAN_BLOCKING_TOOLS = new Set([
  "AskUserQuestion",
  "ask_user_question",
  "prompt_connection_setup",
]);

export function toolBlocksOnHuman(toolName: string): boolean {
  return HUMAN_BLOCKING_TOOLS.has(toolName);
}

/** Bound on a single `text` projection; longer content is truncated and flagged. */
export const LAKE_TEXT_MAX_CHARS = 100_000;

/**
 * Records per send(). Streams cap an ingestion request at 5MB; batching well
 * under that keeps a single fat transcript row from rejecting a whole batch.
 */
const LAKE_SEND_BATCH_SIZE = 50;

export function truncateForLake(text: string): {
  text: string;
  chars: number;
  truncated: boolean;
} {
  const chars = text.length;
  if (chars <= LAKE_TEXT_MAX_CHARS) return { text, chars, truncated: false };
  return { text: text.slice(0, LAKE_TEXT_MAX_CHARS), chars, truncated: true };
}

export function boundLakeErrorMessage(message: string): string {
  return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}

async function sendInBatches<TRecord>(
  stream: LakeStream<TRecord>,
  records: TRecord[],
): Promise<void> {
  for (let offset = 0; offset < records.length; offset += LAKE_SEND_BATCH_SIZE) {
    await stream.send(records.slice(offset, offset + LAKE_SEND_BATCH_SIZE));
  }
}

/**
 * Await-able send used by the transcript mirror, whose high-water mark may only
 * advance once the rows are durably accepted. Resolves false on any failure so
 * the caller leaves the mark where it is and retries the same range later.
 */
export async function sendPiMessageRecords(
  env: LakeStreamEnv | undefined,
  records: PiMessageLakeRecord[],
): Promise<boolean> {
  const stream = env?.TRANSCRIPT_LAKE;
  if (!stream || records.length === 0) return false;
  try {
    await sendInBatches(stream, records);
    return true;
  } catch (error) {
    console.error("[lake] transcript stream send failed", error);
    return false;
  }
}

/**
 * Fire-and-forget send for tool-call telemetry. Unlike the transcript rows these
 * are derived data with no watermark behind them: a dropped batch costs one
 * turn's timing rows, never transcript history, so it must not delay a turn.
 */
export function sendToolCallRecords(
  env: LakeStreamEnv | undefined,
  records: ToolCallLakeRecord[],
): void {
  const stream = env?.TOOL_CALLS_LAKE;
  if (!stream || records.length === 0) return;
  waitUntil(
    sendInBatches(stream, records).catch((error) => {
      console.error("[lake] tool-call stream send failed", error);
    }),
  );
}
