// Privacy-safe memory accounting for ChatThreadDO. This module deliberately
// operates on SQLite aggregate scalars only: transcript rows are never selected,
// parsed, logged, or serialized in JavaScript.
export type ChatMemoryStore = "render" | "pi" | "journal" | "toolRuns";

export interface ChatMemoryStoreStats {
  rows: number;
  bytes: number;
  maxRowBytes: number;
  /**
   * False when the store's table could not be read at all. Distinguishes "this
   * store is genuinely empty" from "we asked the wrong question" — the
   * distinction that let a store pointed at a non-existent table report a
   * confident 0 bytes indefinitely.
   */
  measured: boolean;
}

export interface ChatMemoryStats {
  totalRows: number;
  totalBytes: number;
  maxRowBytes: number;
  stores: Record<ChatMemoryStore, ChatMemoryStoreStats>;
}

const UNMEASURABLE_STORE: ChatMemoryStoreStats = { rows: 0, bytes: 0, maxRowBytes: 0, measured: false };

const STORE_QUERIES: Record<
  ChatMemoryStore,
  { table: string; column: string }
> = {
  render: { table: "cf_ai_chat_agent_messages", column: "message" },
  pi: { table: "pi_core_messages", column: "payload" },
  journal: { table: "pi_turn_journal", column: "payload" },
  // Was `cf_ai_chat_stream_chunks`, a table that exists in neither the installed
  // @cloudflare/ai-chat (which has agent_messages, request_context,
  // agent_tool_runs, agent_tool_milestones, stream_metadata) nor `agents`. The
  // silent catch below meant this store reported 0 bytes forever rather than
  // ever reporting the typo. Point it at a store that both exists and can
  // genuinely be large: tool output payloads.
  toolRuns: { table: "cf_ai_chat_agent_tool_runs", column: "output_json" },
};


function finiteNonNegative(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Cheap aggregate reads; missing/legacy tables are represented by zeroes. */
export function collectChatMemoryStats(sql: SqlStorage): ChatMemoryStats {
  const stores = {} as Record<ChatMemoryStore, ChatMemoryStoreStats>;
  for (const store of Object.keys(STORE_QUERIES) as ChatMemoryStore[]) {
    const { table, column } = STORE_QUERIES[store];
    try {
      const row = sql
        .exec<{ rows: number; bytes: number; max_row_bytes: number }>(
          `SELECT COUNT(*) AS rows,
                COALESCE(SUM(length(CAST(${column} AS BLOB))), 0) AS bytes,
                COALESCE(MAX(length(CAST(${column} AS BLOB))), 0) AS max_row_bytes
           FROM ${table}`,
        )
        .one();
      stores[store] = {
        rows: finiteNonNegative(row.rows),
        bytes: finiteNonNegative(row.bytes),
        maxRowBytes: finiteNonNegative(row.max_row_bytes),
        measured: true,
      };
    } catch {
      // Tables are created lazily by the owning SDKs. Missing telemetry must
      // never make a chat operation fail or cause a table to be created — but it
      // must not report a confident 0 forever either. A name that is simply
      // wrong is indistinguishable from "not created yet" unless we say so, and
      // that is exactly how the phantom stream table went unnoticed.
      stores[store] = { ...UNMEASURABLE_STORE };
    }
  }
  const values = Object.values(stores);
  return {
    totalRows: values.reduce((sum, value) => sum + value.rows, 0),
    totalBytes: values.reduce((sum, value) => sum + value.bytes, 0),
    maxRowBytes: values.reduce(
      (max, value) => Math.max(max, value.maxRowBytes),
      0,
    ),
    stores,
  };
}
