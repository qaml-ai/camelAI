# Transcript data lake

Streams chat transcripts and tool-call timings into Apache Iceberg tables in R2
Data Catalog, so fleet-wide questions ("what are the slowest tool calls?", "how
often does the agent retry after a failed edit?") are one SQL query instead of
one Durable Object wakeup per thread.

Reading **one** transcript stays faster through the admin API
(`get_thread_jsonl` / `manage_thread_message_rows`) — that path is a point
lookup against the authoritative store and is always current. The lake exists
for **bulk** and **predicate-selected** reads, where the win is structural:
today, selecting threads requires downloading all of them first.

## Why the timing instrumentation is not optional

Pi records no tool start timestamp. An assistant message's `timestamp` is
stamped when the model *request opens* (`pi-ai/api/*`, before any streaming), so
a duration derived after the fact as `toolResult.timestamp − previous message
timestamp` silently includes model latency. Measured against production, only
~12% of tool calls sit second-or-later in a batch where that subtraction is
clean.

So the duration is measured live, between `tool_execution_start` and
`tool_execution_end`, and stamped onto the persisted row as
`uiMetadata.toolDurationMs`. Exporting raw transcripts *without* this would
reproduce the same unusable numbers, only faster to query.

Inner `js_exec` calls get the same treatment in `CodeModeToolsBinding
.callToolEnvelope`. They never produce a `pi_core` row at all — to the
transcript the whole script is one opaque `js_exec`, which in production is ~35%
of all tool calls and hides every build, deploy, notebook, and DB timing inside
it.

## Tables

| Table | Row | Retention posture |
| --- | --- | --- |
| `pi_messages` | one per persisted `pi_core` row | user content — deletion-bound |
| `tool_calls` | one per tool execution, incl. inner code-mode calls | no content — long retention |

They are deliberately separate. Transcripts are customer content subject to
deletion requests; operational timings you want to keep for years. One table
would weld those two policies together.

Schemas live in the JSON files alongside this README. Columns are **flat
scalars**, which is load-bearing rather than stylistic: Parquet is columnar and
R2 SQL bills on bytes scanned, so a duration query prunes the fat `text` column
and reads almost nothing. A single JSON payload column would force every query
to scan the entire transcript corpus.

`pi_messages.text` is a bounded text projection (100k chars, `text_truncated`
flags the cut, `text_chars` keeps the true length queryable). It never contains
image bytes — images are reduced to `image_count`.

## Setup

Nothing exports until the bindings exist; the code no-ops on a missing binding
exactly like `recordObservabilityEvent` does for a missing Analytics Engine
dataset. That makes this safe to deploy before the infrastructure is created,
and safe to leave off in dev, tests, and self-host.

1. Create an R2 API token with **Admin Read & Write**. Pipelines authenticates
   to the catalog with it, and it also carries R2 SQL Read for querying. It is
   held by the sink, never by the Worker.

2. Create a stream + sink + pipeline per table, per environment:

   ```bash
   npx wrangler pipelines setup --name camelai_pi_messages_prod
   # Stream:   schema from config/pipelines/pi_messages.schema.json
   #           HTTP endpoint: no (every producer is a Worker binding)
   # Sink:     Data Catalog (Iceberg), table pi_messages
   # Pipeline: Simple ingestion (SELECT * FROM stream)

   npx wrangler pipelines setup --name camelai_tool_calls_prod
   # ... same, schema config/pipelines/tool_calls.schema.json, table tool_calls
   ```

   Consider `--roll-interval 60` (the minimum) if you want fresher data; the
   default is 300s. Below 60s Iceberg compaction starts fighting the writes.

3. Add the bindings to the environment's Wrangler config:

   ```jsonc
   "pipelines": [
     { "binding": "TRANSCRIPT_LAKE", "stream": "<PI_MESSAGES_STREAM_ID>" },
     { "binding": "TOOL_CALLS_LAKE", "stream": "<TOOL_CALLS_STREAM_ID>" }
   ]
   ```

   Use separate streams per environment, matching the existing
   `chiridion_observability_prod` / `_staging` dataset convention.

## Delivery semantics

`TranscriptLakeMirror` keeps a high-water mark in DO storage and advances it
only after the stream accepts the rows, mirroring the `pi_core` → render-history
backfill in `chat-thread/ui-mirror.ts`. The sync runs after every commit (via
`waitUntil`, so a slow stream never extends a turn) and again on WebSocket
connect, which doubles as the repair path for rows lost to an eviction.

That makes the guarantee **at-least-once**, so duplicates are expected. Dedupe
at read time:

```sql
SELECT * FROM default.pi_messages
QUALIFY row_number() OVER (
  PARTITION BY thread_id, idx ORDER BY ingested_at_ms DESC
) = 1
```

`replacePiCoreMessages` (compaction, fork seeding, admin repair) rewrites the
whole table with a fresh `created_at`; the mirror detects that its anchor row
changed and re-exports the thread. The lake keeps both versions — the newest
`ingested_at_ms` wins under the dedupe above, and the older rows remain as an
audit trail of what the rewrite replaced.

A cold DO holding a long thread backfills its history on first sync, capped at
500 rows per call and resumed on the next one. Threads that never wake up are
not exported: a fleet-wide backfill of dormant history should read each thread
once and write Parquet directly to R2, not stream it (streams cap at 5MB/s).

## Querying

R2 SQL supports `GROUP BY`, `HAVING`, joins, CTEs, window functions, `QUALIFY`,
and `approx_percentile_cont`. It does **not** support `OFFSET` or `UNNEST`, and
is read-only.

Slowest real tool calls, excluding tools that block on a human (those measure
how long the user was away, not how slow we are):

```sql
SELECT tool_name, surface,
       approx_percentile_cont(duration_ms, 0.5) AS p50,
       approx_percentile_cont(duration_ms, 0.99) AS p99,
       max(duration_ms) AS max_ms,
       count(*) AS calls
FROM default.tool_calls
WHERE ts_ms > <epoch_ms> AND NOT blocks_on_human
GROUP BY tool_name, surface
ORDER BY p99 DESC
LIMIT 25
```

For bulk transcript reads, do **not** page through R2 SQL — it has no `OFFSET`
and open-beta query timeouts. R2 Data Catalog is a standard Iceberg REST
catalog, so point DuckDB or PyIceberg at it and read the Parquet directly.

## Privacy note

`AGENTS.md` requires that observability payloads stay diagnostic and never carry
chat message contents. **The lake is the deliberate exception**: `pi_messages`
stores transcript text on purpose, because behavioral analysis is the point.
That makes access control, retention, and deletion policy decisions rather than
implementation details:

- The catalog is reachable only with an account R2 token. Treat it as customer
  data, not telemetry.
- Iceberg through Pipelines is append-only — there is no row delete. Deletion
  requests need either a partition rewrite job or a design change that keeps
  bodies in R2 objects keyed by thread, with the lake holding pointers.
- `tool_calls` carries no content and is unaffected by any of this, which is the
  main reason it is a separate table.
