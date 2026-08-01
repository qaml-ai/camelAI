import { WorkerEntrypoint } from 'cloudflare:workers';
import { assertConnectionsBindingEnabled } from '../../../src/lib/connections-binding';
import { isSqlDatabaseMcpIntegration } from './sql-database-mcp.js';
import { isBigQueryMcpIntegration } from './bigquery-mcp.js';
import { isClickHouseMcpIntegration } from './clickhouse-mcp.js';

/**
 * Source-compat shim for the pre-merge WAREHOUSE virtual binding.
 *
 * Already-deployed user apps have `WAREHOUSE` service bindings baked at deploy
 * time pointing at this entrypoint, so the class and its two methods must keep
 * resolving. The sealed WarehouseSandbox container is gone — both methods
 * delegate to AnalysisService (the unified analysis tier, analysis-service.ts),
 * which honors the same contract: `runCode({ code, params })` → DuckDB over the
 * workspace's R2-staged exports at '/' + r2_key, results via stdout.
 *
 * New apps bind `ANALYSIS`; nothing advertises WAREHOUSE anymore.
 */

export interface WarehouseRunRequest {
  /** Python source to execute in the workspace's sandbox (DuckDB strongly preferred). */
  code: string;
  /**
   * Optional values injected into the Python runtime as a `params` dict (e.g.
   * `{ r2_key }`), so callers reference `params["r2_key"]` instead of
   * interpolating values into the code string (which is fragile with special
   * characters). JSON-serializable values only.
   */
  params?: Record<string, unknown>;
}

export interface WarehouseRunResult {
  ok: boolean;
  /** Captured stdout (everything the code `print()`ed), already joined. */
  stdout?: string;
  /** Captured stderr. */
  stderr?: string;
  /**
   * Pre-merge interpreter payload. The analysis tier reports via stdout/stderr,
   * so the shim synthesizes the `logs` shape pre-merge callers actually read
   * (`result.logs.stdout` / `result.logs.stderr`); richer interpreter fields
   * (per-cell outputs) no longer exist.
   */
  result?: unknown;
  error?: string;
}

/**
 * Wrap an analysis-tier runCode result in the pre-merge WAREHOUSE shape: the
 * old entrypoint returned the code-interpreter payload in `result`, whose only
 * documented consumption was `result.logs.stdout[…]` / `result.logs.stderr[…]`
 * (see the old extractWarehouseStdio). Synthesize exactly that so deployed apps
 * probing `result` keep working. Pure + unit-testable.
 */
export function toWarehouseCompatResult(response: WarehouseRunResult): WarehouseRunResult {
  if (response.result !== undefined) return response;
  return {
    ...response,
    result: {
      logs: {
        stdout: response.stdout ? [response.stdout] : [],
        stderr: response.stderr ? [response.stderr] : [],
      },
      ...(response.ok ? {} : { error: { name: "Error", message: response.error ?? "analysis code failed" } }),
    },
  };
}

/** A workspace connection, annotated for analysis/warehouse use. */
export interface WarehouseConnection {
  id: string;
  name: string;
  type: string;
  displayName: string;
  /**
   * True if this connection has an `export` method — i.e. its full query result
   * can be staged to R2 (`connections[alias].export({ query })`). That's the SQL
   * database family (Postgres/MySQL/Neon/PlanetScale), BigQuery, and ClickHouse
   * today; other types don't have an `export` method yet.
   */
  exportable: boolean;
  /**
   * The R2 staging format this connection's `export` produces, so the caller
   * reads it with the right DuckDB reader: `parquet` → `read_parquet`, `ndjson`
   * → `read_json_auto`. SQL + ClickHouse export Parquet; **BigQuery exports
   * NDJSON** (its REST API returns JSON, not Parquet bytes). `null` when not
   * exportable.
   */
  exportFormat: 'parquet' | 'ndjson' | null;
}

/**
 * Annotate a workspace's connection catalog with whether each has an `export`
 * method (and can therefore feed R2-staged analysis). Pure + unit-testable.
 */
export function annotateWarehouseConnections(
  summaries: ReadonlyArray<{ id: string; name: string; type: string; displayName: string }>,
): WarehouseConnection[] {
  return summaries.map((c) => {
    // BigQuery stages NDJSON (no Parquet over its REST API); SQL + ClickHouse
    // stage Parquet. Keep this in sync with each MCP module's `export` impl.
    const exportFormat: 'parquet' | 'ndjson' | null = isBigQueryMcpIntegration(c.type)
      ? 'ndjson'
      : isSqlDatabaseMcpIntegration(c.type) || isClickHouseMcpIntegration(c.type)
        ? 'parquet'
        : null;
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      displayName: c.displayName,
      exportable: exportFormat !== null,
      exportFormat,
    };
  });
}

/**
 * Prepend a `params` dict to the Python code so callers reference
 * `params["r2_key"]` instead of interpolating values into the code string.
 * The values are embedded as a JSON string and parsed with `json.loads`, so
 * arbitrary content (special characters, quotes) is safe.
 */
export function withWarehouseParams(code: string, params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return code;
  // Double-encode: inner produces JSON, outer produces a Python string literal of it.
  const literal = JSON.stringify(JSON.stringify(params));
  return `import json as _wh_json\nparams = _wh_json.loads(${literal})\ndel _wh_json\n${code}`;
}

interface WarehouseServiceProps {
  workspaceId: string;
  orgId: string;
}

/** The AnalysisService surface the shim delegates to, via ctx.exports. */
interface AnalysisDelegate {
  /** App-scoped runCode: separate container, export mounts only. */
  runCodeForApps(request: WarehouseRunRequest): Promise<WarehouseRunResult>;
  listConnections(): Promise<WarehouseConnection[]>;
}

export class WarehouseService extends WorkerEntrypoint<unknown, WarehouseServiceProps> {
  async runCode(request: WarehouseRunRequest): Promise<WarehouseRunResult> {
    // App-scoped by definition: this entrypoint is only reachable from deployed
    // apps' baked WAREHOUSE bindings, which were always export-mounts-only.
    return toWarehouseCompatResult(await this.analysis().runCodeForApps(request));
  }

  async listConnections(): Promise<WarehouseConnection[]> {
    // Legacy deployed-app WAREHOUSE binding — same kill switch as CONNECTIONS /
    // AnalysisAppService so connection catalogs cannot leak when disabled.
    assertConnectionsBindingEnabled(this.env as { CONNECTIONS_BINDING_ENABLED?: string });
    return this.analysis().listConnections();
  }

  private analysis(): AnalysisDelegate {
    return (this.ctx.exports as unknown as {
      AnalysisService: (options: { props: WarehouseServiceProps }) => AnalysisDelegate;
    }).AnalysisService({
      props: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    });
  }
}
