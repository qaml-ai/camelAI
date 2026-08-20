"""Workspace connections RPC helpers.

Talks to the stateless connections endpoint camelAI exposes inside the
analysis sandbox via ``CAMELAI_CONNECTIONS_RPC_URL``. Identity and stored
credentials are applied outside the container; nothing here handles secrets.
"""

import json
import os
import urllib.error
import urllib.request

__all__ = [
    "ConnectionsRpcError",
    "rpc",
    "catalog",
    "find",
    "invoke",
    "rows",
    "query_rows",
    "query",
    "export",
    "read_export",
    "query_full",
]

# Bulk exports can legitimately use the Worker-side five-minute query budget.
# Keep the client just beyond that budget while still below the analysis tool's
# default execution deadline, so the server can return its own useful timeout
# instead of urllib cutting the request off first.
_DEFAULT_TIMEOUT_SECONDS = 330

# Keys that hold a row list (or nest one) across the connection method result
# shapes: DATA_PROXY-style {ok, data: {recordset|rows}}, broker results with
# top-level rows/recordset, and MCP payloads like BigQuery's {rows: [...]}.
_ROW_KEYS = ("data", "rows", "recordset", "records", "results")


class ConnectionsRpcError(RuntimeError):
    """A connections RPC request failed; the message is the server's error."""


def _endpoint():
    url = os.environ.get("CAMELAI_CONNECTIONS_RPC_URL", "").strip()
    if not url:
        raise ConnectionsRpcError(
            "CAMELAI_CONNECTIONS_RPC_URL is not set. Workspace connections are only "
            "reachable from analysis runs (run_notebook / analysis_exec / run_code)."
        )
    return url


def rpc(action, timeout_seconds=None, **params):
    """POST one RPC action and return its unwrapped ``result``.

    Raises ConnectionsRpcError with the server's message (including hints such
    as candidate connections on an ambiguous ``find``) on any failure.
    """
    request_timeout = (
        _DEFAULT_TIMEOUT_SECONDS if timeout_seconds is None else timeout_seconds
    )
    if not isinstance(request_timeout, (int, float)) or request_timeout <= 0:
        raise ValueError("timeout_seconds must be a positive number")

    payload = {"action": action, **params}
    request = urllib.request.Request(
        _endpoint(),
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json", "accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=request_timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            raise ConnectionsRpcError(
                "connections RPC HTTP %s: %s" % (error.code, raw)
            ) from error
    except OSError as error:
        # URLError (connection refused, DNS), socket timeouts, and other
        # transport failures — surface as ConnectionsRpcError, not a raw
        # urllib traceback.
        raise ConnectionsRpcError("connections RPC request failed: %s" % error) from error
    else:
        try:
            body = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ConnectionsRpcError(
                "connections RPC returned non-JSON response: %s" % raw[:500]
            ) from error
    if not isinstance(body, dict) or not body.get("ok", False):
        error_value = body.get("error") if isinstance(body, dict) else body
        if isinstance(error_value, dict):
            message = str(error_value.get("message", error_value))
            details = {k: v for k, v in error_value.items() if k != "message"}
            if details:
                message += " " + json.dumps(details, default=str)[:2000]
        else:
            message = str(error_value)
        raise ConnectionsRpcError(message)
    return body.get("result")


def catalog():
    """Every connection with its alias, type, and callable methods."""
    return rpc("methods")


def find(query):
    """Resolve one connection by alias/id/name/type (e.g. "postgres")."""
    return rpc("find", query=query)


def invoke(connection, method, input=None, timeout_seconds=None):
    """Invoke a connection method and return the raw (unparsed) result.

    ``connection`` may be an id, alias, name, or type — resolution happens
    server-side. Failures carry the method/connection context so a traceback
    says which call failed, not just why.
    """
    try:
        return rpc(
            "invoke",
            connection=connection,
            method=method,
            input=input or {},
            timeout_seconds=timeout_seconds,
        )
    except ConnectionsRpcError as error:
        raise ConnectionsRpcError(
            "invoke %r on connection %r failed: %s" % (method, connection, error)
        ) from error


def _find_rows(value):
    if isinstance(value, list):
        return value
    if not isinstance(value, dict):
        return None
    for key in _ROW_KEYS:
        candidate = value.get(key)
        if isinstance(candidate, list):
            return candidate
        if isinstance(candidate, dict):
            nested = _find_rows(candidate)
            if nested is not None:
                return nested
    content = value.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict) or item.get("type") != "text":
                continue
            try:
                parsed = json.loads(item.get("text", ""))
            except json.JSONDecodeError:
                continue
            nested = _find_rows(parsed)
            if nested is not None:
                return nested
    return None


def rows(result):
    """Extract the row list from any connection method result shape.

    Handles top-level lists, ``data``/``rows``/``recordset`` nesting, and
    MCP-style ``content[0].text`` JSON envelopes. Raises ValueError when no
    row list can be located (so an unexpected shape fails loudly instead of
    silently becoming an empty result).
    """
    found = _find_rows(result)
    if found is None:
        keys = sorted(result.keys()) if isinstance(result, dict) else type(result).__name__
        raise ValueError(
            "Could not locate a row list in the connection result (saw: %s). "
            "Inspect the raw result from camelai.connections.invoke()." % (keys,)
        )
    return found


def query_rows(connection, sql, method="query", **input_kwargs):
    """Run SQL through a connection's query method; returns a list of dicts."""
    return rows(invoke(connection, method, {"query": sql, **input_kwargs}))


def query(connection, sql, method="query", **input_kwargs):
    """Run SQL through a connection's query method; returns a DataFrame.

    Inline results only — the broker runs SQL exactly as written, so add your
    own LIMIT for big tables, or use query_full() for uncapped results.
    """
    import pandas as pd

    return pd.DataFrame(query_rows(connection, sql, method=method, **input_kwargs))


def export(connection, sql, timeout_seconds=None, **input_kwargs):
    """Export a query's FULL result to R2 (no row cap).

    Returns the export result with the in-container read ``path`` added
    (exports are mounted read-only at ``'/' + r2_key``). SQL databases and
    ClickHouse export Parquet; BigQuery exports NDJSON.
    """
    result = invoke(
        connection,
        "export",
        {"query": sql, **input_kwargs},
        timeout_seconds=timeout_seconds,
    )
    if not isinstance(result, dict) or not result.get("r2_key"):
        raise ConnectionsRpcError(
            "export did not return an r2_key. This connection may not be exportable; "
            "raw result: %s" % json.dumps(result, default=str)[:2000]
        )
    return {**result, "path": "/" + str(result["r2_key"])}


def read_export(export_result):
    """Load an export() result into a DataFrame with DuckDB.

    Picks the reader from the file extension (.parquet → read_parquet,
    .ndjson → read_json_auto). A zero-row NDJSON export has nothing for
    read_json_auto to infer, so it returns an empty DataFrame using the
    export's reported columns.
    """
    import duckdb

    path = export_result["path"]
    if path.endswith(".ndjson") and export_result.get("rows") == 0:
        import pandas as pd

        return pd.DataFrame(columns=export_result.get("columns") or [])
    reader = "read_json_auto" if path.endswith(".ndjson") else "read_parquet"
    return duckdb.sql("SELECT * FROM %s(?)" % reader, params=[path]).df()


def query_full(connection, sql, timeout_seconds=None, **input_kwargs):
    """Uncapped query: export the full result to R2, read it back with DuckDB."""
    return read_export(
        export(connection, sql, timeout_seconds=timeout_seconds, **input_kwargs)
    )
