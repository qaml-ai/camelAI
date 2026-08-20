"""BigQuery helpers over the workspace connection.

    from camelai import bq

    bq.estimate("SELECT * FROM hn.materialized")   # dry run: bytes scanned, no charge
    df = bq.query("SELECT ... LIMIT 500")          # inline rows (capped at 1000)
    df = bq.query_full("SELECT ...")               # full result via R2 export + DuckDB
    bq.table_info("hn.materialized")               # schema + numRows + numBytes

Inline queries default to BigQuery's fail-without-charge billing cap (~1 GB
scanned). For bigger scans pass ``maximum_bytes_billed`` (a string, e.g.
"20000000000" for 20 GB) — run ``estimate()`` first to size it.
"""

import json
import warnings

from . import connections

__all__ = [
    "query",
    "query_rows",
    "query_full",
    "export",
    "estimate",
    "table_info",
    "datasets",
    "tables",
]

# Cached for the process lifetime; _call() drops the cache and re-resolves
# once when the id stops matching (the connection was deleted and re-created
# in a long-lived session).
_CONNECTION_ID = None


def _connection():
    global _CONNECTION_ID
    if _CONNECTION_ID is None:
        entry = connections.find("bigquery")
        _CONNECTION_ID = entry["connection"]["id"]
    return _CONNECTION_ID


def _payload(result):
    """Unwrap the MCP text envelope ({content: [{type: text, text: json}]})."""
    if isinstance(result, dict) and isinstance(result.get("content"), list):
        for item in result["content"]:
            if isinstance(item, dict) and item.get("type") == "text":
                try:
                    return json.loads(item.get("text", ""))
                except json.JSONDecodeError:
                    continue
    return result


def _call(method, timeout_seconds=None, **input_kwargs):
    global _CONNECTION_ID
    args = {key: value for key, value in input_kwargs.items() if value is not None}
    try:
        return _payload(
            connections.invoke(
                _connection(), method, args, timeout_seconds=timeout_seconds
            )
        )
    except connections.ConnectionsRpcError as error:
        # Cached id no longer resolves (connection re-created mid-session):
        # drop the cache and retry once with a fresh lookup.
        if "No connected integration matched" not in str(error):
            raise
        _CONNECTION_ID = None
        return _payload(
            connections.invoke(
                _connection(), method, args, timeout_seconds=timeout_seconds
            )
        )


def query_rows(sql, max_results=None, maximum_bytes_billed=None, dataset_id=None, timeout_ms=None):
    """Inline query; returns (rows, payload) where payload carries the stats
    (totalRows, totalBytesProcessed, schema, ...)."""
    payload = _call(
        "execute_sql_readonly",
        query=sql,
        maxResults=max_results,
        maximumBytesBilled=maximum_bytes_billed,
        datasetId=dataset_id,
        timeoutMs=timeout_ms,
    )
    return connections.rows(payload), payload


def query(sql, max_results=1000, maximum_bytes_billed=None, dataset_id=None, timeout_ms=None):
    """Inline query returning a DataFrame (typed from the BigQuery schema).

    Capped at ``max_results`` rows (broker maximum 1000). Warns when the
    result was truncated — reach for query_full() to get every row.
    """
    import pandas as pd

    rows, payload = query_rows(
        sql,
        max_results=max_results,
        maximum_bytes_billed=maximum_bytes_billed,
        dataset_id=dataset_id,
        timeout_ms=timeout_ms,
    )
    total = int(payload.get("totalRows") or 0) if isinstance(payload, dict) else 0
    if total > len(rows):
        warnings.warn(
            "BigQuery returned %d of %d rows (inline cap). Use camelai.bq.query_full(sql) "
            "for the full result." % (len(rows), total),
            stacklevel=2,
        )
    df = pd.DataFrame(rows)
    schema = payload.get("schema") if isinstance(payload, dict) else None
    return _coerce_types(df, schema)


def query_full(
    sql,
    maximum_bytes_billed=None,
    dataset_id=None,
    timeout_seconds=None,
):
    """Uncapped query: export the full result to R2 and read it with DuckDB."""
    return connections.read_export(
        export(
            sql,
            maximum_bytes_billed=maximum_bytes_billed,
            dataset_id=dataset_id,
            timeout_seconds=timeout_seconds,
        )
    )


def export(
    sql,
    maximum_bytes_billed=None,
    dataset_id=None,
    timeout_seconds=None,
):
    """Export the FULL query result to R2 as NDJSON.

    Returns {r2_key, path, rows, columns}; read ``path`` with DuckDB's
    read_json_auto (NOT read_parquet — BigQuery exports NDJSON).
    """
    result = _call(
        "export",
        query=sql,
        maximumBytesBilled=maximum_bytes_billed,
        datasetId=dataset_id,
        timeout_seconds=timeout_seconds,
    )
    if not isinstance(result, dict) or not result.get("r2_key"):
        raise connections.ConnectionsRpcError(
            "BigQuery export did not return an r2_key; raw result: %s"
            % json.dumps(result, default=str)[:2000]
        )
    return {**result, "path": "/" + str(result["r2_key"])}


def estimate(sql, dataset_id=None):
    """Dry-run a query (no execution, no charge).

    Returns totalBytesProcessed / totalGbProcessed and whether the query fits
    the default billing cap — use it to size maximum_bytes_billed before
    scanning a large table.
    """
    return _call("estimate_query", query=sql, datasetId=dataset_id)


def table_info(table, dataset_id=None):
    """Table metadata + schema. Accepts "table" or "dataset.table".

    The result's numRows / numBytes answer row-count questions without a
    billed COUNT(*) scan.
    """
    if "." in table and dataset_id is None:
        dataset_id, table = table.split(".", 1)
    return _call("get_table_info", tableId=table, datasetId=dataset_id)


def datasets():
    """Dataset ids in the connected project."""
    payload = _call("list_dataset_ids")
    return payload.get("datasetIds", payload) if isinstance(payload, dict) else payload


def tables(dataset_id=None):
    """Table ids in a dataset (default: the connection's default dataset)."""
    payload = _call("list_table_ids", datasetId=dataset_id)
    return payload.get("tableIds", payload) if isinstance(payload, dict) else payload


_INT_TYPES = {"INTEGER", "INT64"}
_FLOAT_TYPES = {"FLOAT", "FLOAT64", "NUMERIC", "BIGNUMERIC"}
_BOOL_TYPES = {"BOOLEAN", "BOOL"}
_EPOCH_TYPES = {"TIMESTAMP"}
_DATETIME_TYPES = {"DATETIME", "DATE"}


def _coerce_types(df, schema):
    """Type a DataFrame from the BigQuery schema (REST returns strings).

    Best-effort per column: a column that fails to convert is left as-is
    rather than failing the whole query.
    """
    if df.empty or not isinstance(schema, dict):
        return df
    import pandas as pd

    for field in schema.get("fields") or []:
        name = field.get("name")
        if name not in df.columns or field.get("mode") == "REPEATED":
            continue
        ftype = (field.get("type") or "").upper()
        try:
            if ftype in _INT_TYPES:
                df[name] = pd.to_numeric(df[name]).astype("Int64")
            elif ftype in _FLOAT_TYPES:
                df[name] = pd.to_numeric(df[name])
            elif ftype in _BOOL_TYPES:
                df[name] = df[name].astype("boolean")
            elif ftype in _EPOCH_TYPES:
                df[name] = pd.to_datetime(pd.to_numeric(df[name]), unit="s", utc=True)
            elif ftype in _DATETIME_TYPES:
                df[name] = pd.to_datetime(df[name])
        except (ValueError, TypeError):
            pass
    return df
