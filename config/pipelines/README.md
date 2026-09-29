# Tool-call telemetry lake

Streams tool-call timings into an Apache Iceberg table in R2 Data Catalog, so
fleet-wide questions ("what are the slowest tool calls?") are one SQL query.

`CodeModeToolsBinding.callToolEnvelope` records one row per tool execution:
every camelAI tool a runtime agent calls (over MCP, directly or from its
js_exec) and every one a deterministic workflow calls. It carries no message
content.

The transcript table (`pi_messages`) was written by the in-DO chat loop, which
is gone; nothing writes it now, and its binding (`TRANSCRIPT_LAKE`) was
removed. The Pipelines stream, sink and R2 catalog behind it were left as they
are: deleting them is a separate decision.

## Table

| Table | Row | Retention posture |
| --- | --- | --- |
| `tool_calls` | one per tool execution | no content — long retention |

The schema is in `tool_calls.schema.json`. Columns are **flat scalars**:
Parquet is columnar and R2 SQL bills on bytes scanned, so a duration query
reads almost nothing.

## Setup

Nothing exports until the binding exists; the code no-ops on a missing binding
exactly like `recordObservabilityEvent` does for a missing Analytics Engine
dataset. That makes it safe to leave off in dev, tests, and self-host.

1. Create an R2 API token with **Admin Read & Write**. Pipelines authenticates
   to the catalog with it, and it also carries R2 SQL Read for querying. It is
   held by the sink, never by the Worker.

2. Create a stream + sink + pipeline per environment:

   ```bash
   npx wrangler pipelines setup --name camelai_tool_calls_prod
   # Stream:   schema from config/pipelines/tool_calls.schema.json
   #           HTTP endpoint: no (every producer is a Worker binding)
   # Sink:     Data Catalog (Iceberg), table tool_calls
   # Pipeline: Simple ingestion (SELECT * FROM stream)
   ```

   Consider `--roll-interval 60` (the minimum) if you want fresher data; the
   default is 300s.

3. Add the binding to the environment's Wrangler config:

   ```jsonc
   "pipelines": [
     { "binding": "TOOL_CALLS_LAKE", "stream": "<TOOL_CALLS_STREAM_ID>" }
   ]
   ```

Delivery is fire-and-forget (`waitUntil`): a dropped batch costs one call's
timing rows and never delays a tool call.

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
