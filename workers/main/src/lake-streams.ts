// Optional Cloudflare Pipelines writer for bounded code-mode tool timings.
// The chat runtime has no transcript-lake writer; see config/pipelines/README.md.
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

interface ToolCallLakeEnv {
  TOOL_CALLS_LAKE?: LakeStream<ToolCallLakeRecord>;
}

/** One observed code-mode tool execution. Carries no arguments or result text. */
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

/** Records per send(), kept finite even though current calls emit one row. */
const LAKE_SEND_BATCH_SIZE = 50;

export function boundLakeErrorMessage(message: string): string {
  return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}

async function sendInBatches<TRecord>(
  stream: LakeStream<TRecord>,
  records: TRecord[],
): Promise<void> {
  for (
    let offset = 0;
    offset < records.length;
    offset += LAKE_SEND_BATCH_SIZE
  ) {
    await stream.send(records.slice(offset, offset + LAKE_SEND_BATCH_SIZE));
  }
}

/**
 * Best-effort tool-call telemetry. There is no watermark or retry path, so this
 * can never delay or own turn completion.
 */
export function sendToolCallRecords(
  env: ToolCallLakeEnv | undefined,
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
