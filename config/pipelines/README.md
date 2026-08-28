# Tool-call timing lake

`CodeModeToolsBinding` emits bounded, best-effort timing rows for tools invoked
inside `js_exec`. Those inner calls otherwise appear as one opaque `js_exec`
operation, hiding build, deploy, notebook, browser, and database latency.

The bounded chat runtime does **not** export transcripts or message rows. The
retired `TRANSCRIPT_LAKE`/`pi_messages` producer and its `pi_core` watermark were
removed with the legacy runtime. `TOOL_CALLS_LAKE` is the only Pipeline binding
owned by this feature.

## Table

The `tool_calls` schema is
[`tool_calls.schema.json`](./tool_calls.schema.json). Rows are flat scalars so
R2 SQL can prune unrelated columns. They contain identifiers, timing, success,
bounded error metadata, and result character counts; they never contain tool
arguments, result bodies, chat messages, auth headers, or secrets.

The `surface` column remains in the schema for historical rows. The bounded
runtime currently writes `code_mode` rows only.

## Setup

Nothing is sent when the optional binding is absent, so local development,
tests, and self-host installations need no Pipeline configuration.

Create one stream, sink, and pipeline per environment:

```bash
npx wrangler pipelines setup --name camelai_tool_calls_prod
# Stream:   schema from config/pipelines/tool_calls.schema.json
#           HTTP endpoint: no (the producer is a Worker binding)
# Sink:     Data Catalog (Iceberg), table tool_calls
# Pipeline: Simple ingestion (SELECT * FROM stream)
```

Then add only the tool-call binding to the relevant Wrangler environment:

```jsonc
"pipelines": [
  { "binding": "TOOL_CALLS_LAKE", "stream": "<TOOL_CALLS_STREAM_ID>" }
]
```

Use separate streams for production and staging, matching the existing
Analytics Engine environment split.

## Delivery semantics

Rows are derived diagnostics, not lifecycle state. The Worker batches at most
50 records per Pipeline send and schedules the send with `waitUntil`; failures
are caught and logged. There is no watermark, retry queue, or completion
dependency. A lost row cannot delay, fail, retry, or change a chat turn.

## Querying

R2 SQL supports `GROUP BY`, `HAVING`, joins, CTEs, window functions, `QUALIFY`,
and `approx_percentile_cont`. It does not support `OFFSET` or `UNNEST`, and is
read-only.

For example, this reports latency for recent non-human-blocking calls:

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

## Privacy and retention

`tool_calls` is operational telemetry, not customer transcript storage. Keep
the existing restricted R2 Data Catalog access, but it does not require the
message-deletion workflow that a transcript table would. Bounded error strings
must remain platform-generated diagnostics; callers must never add tool input
or raw user output to them.

Removing the source binding does not delete any historical `pi_messages`
Iceberg data or Cloudflare Pipeline resources. Decommission those separately
under the applicable retention policy if they still exist.
