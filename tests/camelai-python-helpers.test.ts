import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Exercises the baked-in camelai Python helper package
 * (workers/main/analysis-sandbox-assets/camelai) with the host's Python:
 * pure response-shape parsing plus an end-to-end run against a stdlib fake of
 * the connections RPC endpoint. Stdlib-only on purpose — the host running
 * these tests has no pandas/duckdb; DataFrame conversion is a thin layer over
 * the row extraction tested here.
 */

const root = process.cwd();
const packageDir = path.join(root, 'workers/main/analysis-sandbox-assets');

function findPython(): string | null {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) {
      return command;
    }
  }
  return null;
}

const python = findPython();
const describeIfPython = python ? describe : describe.skip;

function runPython(script: string) {
  if (!python) {
    throw new Error('Python is required to run camelai helper tests');
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'camelai-python-'));
  const scriptPath = path.join(directory, 'driver.py');
  writeFileSync(scriptPath, script, 'utf8');
  try {
    return spawnSync(python, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: packageDir },
      timeout: 30_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describeIfPython('camelai Python helpers', () => {
  it('uses an export-safe RPC timeout and supports a per-call override', () => {
    const result = runPython(`
import json
import os
from unittest.mock import patch

os.environ["CAMELAI_CONNECTIONS_RPC_URL"] = "http://connections.internal/"
from camelai import connections

timeouts = []


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self):
        return json.dumps({"ok": True, "result": {"ok": True}}).encode("utf-8")


def fake_urlopen(request, timeout):
    timeouts.append(timeout)
    return Response()


with patch("urllib.request.urlopen", fake_urlopen):
    connections.rpc("methods")
    connections.invoke("db", "export", {}, timeout_seconds=42)

assert timeouts == [330, 42], timeouts

try:
    connections.rpc("methods", timeout_seconds=0)
except ValueError as error:
    assert "positive number" in str(error)
else:
    raise SystemExit("expected timeout validation error")

print("TIMEOUTS OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TIMEOUTS OK');
  });

  it('extracts rows from every connection result shape', () => {
    const result = runPython(`
import json
from camelai import connections

# top-level list
assert connections.rows([{"a": 1}]) == [{"a": 1}]
# DATA_PROXY-style {ok, data: {recordset}}
assert connections.rows({"ok": True, "data": {"recordset": [{"a": 1}]}}) == [{"a": 1}]
# {data: {rows}}
assert connections.rows({"data": {"rows": [1, 2]}}) == [1, 2]
# direct rows / recordset / data list
assert connections.rows({"rows": [3]}) == [3]
assert connections.rows({"recordset": [4]}) == [4]
assert connections.rows({"ok": True, "data": [5]}) == [5]
# MCP content envelope around a BigQuery payload
mcp = {"content": [{"type": "text", "text": json.dumps({"schema": {}, "rows": [{"x": 1}]})}]}
assert connections.rows(mcp) == [{"x": 1}]
# MCP envelope around nested data.rows
nested = {"content": [{"type": "text", "text": json.dumps({"data": {"rows": [3]}})}]}
assert connections.rows(nested) == [3]
# MCP envelope whose text is a bare JSON list
bare = {"content": [{"type": "text", "text": "[7, 8]"}]}
assert connections.rows(bare) == [7, 8]

# unknown shapes fail loudly instead of returning []
try:
    connections.rows({"weird": {"stuff": True}})
except ValueError as error:
    assert "Could not locate a row list" in str(error)
else:
    raise SystemExit("expected ValueError for unknown shape")

print("PARSE OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PARSE OK');
  });

  it('runs find/invoke round-trips against a fake RPC endpoint', () => {
    const result = runPython(`
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

requests = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        status = 200
        if body["action"] == "find":
            result = {
                "alias": "bigqueryMain",
                "connection": {"id": "bq1", "type": "bigquery", "name": "main"},
                "methods": [{"name": "query", "tool": "execute_sql_readonly"}],
            }
            envelope = {"ok": True, "result": result}
        elif body["action"] == "invoke" and body["method"] == "execute_sql_readonly":
            payload = {
                "totalRows": "5",
                "schema": {"fields": [{"name": "n", "type": "INTEGER"}]},
                "rows": [{"n": "1"}, {"n": "2"}],
            }
            envelope = {"ok": True, "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
        elif body["action"] == "invoke" and body["method"] == "query":
            envelope = {"ok": True, "result": {"ok": True, "data": {"rows": [{"id": 1}]}}}
        elif body["action"] == "invoke" and body["method"] == "get_table_info":
            envelope = {"ok": True, "result": {"content": [{"type": "text", "text": json.dumps({"numRows": "42", "input": body["input"]})}]}}
        else:
            status = 400
            envelope = {"ok": False, "error": {"message": "boom: unexpected action", "code": "TEST"}}
        out = json.dumps(envelope).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["CAMELAI_CONNECTIONS_RPC_URL"] = "http://127.0.0.1:%d/" % server.server_port

from camelai import bq, connections

# generic connection query
rows = connections.query_rows("postgres", "SELECT 1")
assert rows == [{"id": 1}], rows
assert requests[-1]["input"] == {"query": "SELECT 1"}, requests[-1]

# bq query: find is called once (cached), MCP envelope is unwrapped
brows, payload = bq.query_rows("SELECT n FROM t", max_results=100)
assert brows == [{"n": "1"}, {"n": "2"}], brows
assert payload["totalRows"] == "5"
assert requests[-1]["connection"] == "bq1"
assert requests[-1]["input"] == {"query": "SELECT n FROM t", "maxResults": 100}
# table_info splits dataset.table and unwraps the payload
info = bq.table_info("hn.materialized")
assert info["numRows"] == "42"
assert requests[-1]["input"] == {"tableId": "materialized", "datasetId": "hn"}

# the bq connection lookup is cached: one find across all bq calls (the plain
# connections.query_rows passes its connection query straight to invoke)
find_calls = [r for r in requests if r["action"] == "find"]
assert len(find_calls) == 1, find_calls

# server-side errors surface as ConnectionsRpcError with the message
try:
    connections.invoke("bq1", "unknown_method")
except connections.ConnectionsRpcError as error:
    assert "boom: unexpected action" in str(error), str(error)
else:
    raise SystemExit("expected ConnectionsRpcError")

server.shutdown()
print("E2E OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('E2E OK');
  });

  it('re-resolves a stale cached bq connection id once and retries', () => {
    const result = runPython(`
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

requests = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        status = 200
        if body["action"] == "find":
            # second find returns the NEW connection id
            conn_id = "bq-old" if len([r for r in requests if r["action"] == "find"]) == 1 else "bq-new"
            envelope = {"ok": True, "result": {"alias": "bq", "connection": {"id": conn_id, "type": "bigquery", "name": "bq"}, "methods": []}}
        elif body["action"] == "invoke" and body["connection"] == "bq-new":
            payload = {"rows": [{"n": 1}], "totalRows": "1", "schema": {"fields": []}}
            envelope = {"ok": True, "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
        else:
            status = 404
            envelope = {"ok": False, "error": {"message": "No connected integration matched %s" % body.get("connection")}}
        out = json.dumps(envelope).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["CAMELAI_CONNECTIONS_RPC_URL"] = "http://127.0.0.1:%d/" % server.server_port

from camelai import bq

rows, payload = bq.query_rows("SELECT 1")
assert rows == [{"n": 1}], rows
# stale id failed → cache dropped → fresh find → retried with the new id
invokes = [r for r in requests if r["action"] == "invoke"]
assert [r["connection"] for r in invokes] == ["bq-old", "bq-new"], invokes
# invoke errors carry method/connection context
from camelai import connections
try:
    connections.invoke("nope", "query")
except connections.ConnectionsRpcError as error:
    assert "invoke 'query' on connection 'nope' failed" in str(error), str(error)
else:
    raise SystemExit("expected ConnectionsRpcError")

server.shutdown()
print("RETRY OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RETRY OK');
  });

  it('adds the mounted read path to export results', () => {
    const result = runPython(`
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body["action"] == "find":
            envelope = {"ok": True, "result": {"alias": "ch", "connection": {"id": "ch1", "type": "clickhouse", "name": "ch"}, "methods": []}}
        else:
            envelope = {"ok": True, "result": {"ok": True, "r2_key": "warehouse/ws1/abc.parquet", "rows": 10}}
        out = json.dumps(envelope).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["CAMELAI_CONNECTIONS_RPC_URL"] = "http://127.0.0.1:%d/" % server.server_port

from camelai import connections

info = connections.export("clickhouse", "SELECT * FROM events")
assert info["r2_key"] == "warehouse/ws1/abc.parquet"
assert info["path"] == "/warehouse/ws1/abc.parquet"

server.shutdown()
print("EXPORT OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('EXPORT OK');
  });

  it('wraps transport failures and non-JSON responses in ConnectionsRpcError', () => {
    const result = runPython(`
import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from camelai import connections

# transport failure (connection refused): grab a free port and close it
probe = socket.socket()
probe.bind(("127.0.0.1", 0))
dead_port = probe.getsockname()[1]
probe.close()
os.environ["CAMELAI_CONNECTIONS_RPC_URL"] = "http://127.0.0.1:%d/" % dead_port
try:
    connections.find("postgres")
except connections.ConnectionsRpcError as error:
    assert "connections RPC request failed" in str(error), str(error)
else:
    raise SystemExit("expected ConnectionsRpcError for refused connection")


# 200 response with a non-JSON body
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        out = b"<html>gateway error</html>"
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
os.environ["CAMELAI_CONNECTIONS_RPC_URL"] = "http://127.0.0.1:%d/" % server.server_port
try:
    connections.find("postgres")
except connections.ConnectionsRpcError as error:
    assert "non-JSON response" in str(error), str(error)
else:
    raise SystemExit("expected ConnectionsRpcError for non-JSON body")

server.shutdown()
print("ERRORS OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ERRORS OK');
  });

  it('fails with guidance when CAMELAI_CONNECTIONS_RPC_URL is unset', () => {
    const result = runPython(`
import os
os.environ.pop("CAMELAI_CONNECTIONS_RPC_URL", None)
from camelai import connections
try:
    connections.find("postgres")
except connections.ConnectionsRpcError as error:
    assert "CAMELAI_CONNECTIONS_RPC_URL" in str(error)
else:
    raise SystemExit("expected ConnectionsRpcError")
print("ENV OK")
`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ENV OK');
  });
});
