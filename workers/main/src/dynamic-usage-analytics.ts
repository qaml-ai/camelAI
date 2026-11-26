/**
 * Real-time Workers Analytics Engine SQL query helpers for hosted Dynamic Workers
 * (`APP_USAGE_AE` -> `chiridion_app_usage_{prod,staging}`).
 *
 * Replaces 5-15 minute delayed Cloudflare Observability trace polling with
 * near-real-time SQLite rows read/written, DO duration, quota trips, and
 * outbound SSRF telemetry per app and per org.
 */

export interface DynamicAppUsageSummary {
  dispatchScriptName: string;
  orgId: string;
  quotaTier: string;
  httpRequests: number;
  assetRequests: number;
  doEvents: number;
  rowsRead: number;
  rowsWritten: number;
  totalDurationMs: number;
  maxDbSizeBytes: number;
  quotaTrips: number;
  lazyMigrationHits: number;
}

export interface AnalyticsEngineQueryConfig {
  accountId: string;
  apiToken: string;
  dataset: string;
  fetcher?: typeof fetch;
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function safeDatasetName(dataset: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(dataset)) {
    throw new Error(`Invalid Analytics Engine dataset name: ${dataset}`);
  }
  return dataset;
}

function safeWindowHours(windowHours: number): number {
  const n = Math.floor(windowHours);
  if (!Number.isFinite(n) || n < 1) return 24;
  return Math.min(n, 24 * 31);
}

/**
 * Builds the Workers Analytics Engine SQL query for per-app usage rollups.
 *
 * Schema emitted by `emitAppUsageMetric` (`workers/dispatcher/src/dynamic/quota-policy.ts`):
 * - `index1`: dispatchScriptName
 * - `blob1`: orgId
 * - `blob2`: className
 * - `blob3`: eventKind ('http'|'asset'|'do_fetch'|'do_rpc'|'do_alarm'|'do_ws'|'quota_trip'|'quota_abort'|'outbound_blocked'|'lazy_migration_hit')
 * - `blob4`: quotaTier
 * - `double1`: rowsRead
 * - `double2`: rowsWritten
 * - `double3`: durationMs
 * - `double4`: dbSizeBytes
 * - `double5`: subrequests
 * - `double6`: quotaTripped (0|1)
 */
export function buildDynamicAppUsageSql(input: {
  dataset: string;
  windowHours?: number;
  orgId?: string;
  dispatchScriptName?: string;
  limit?: number;
}): string {
  const dataset = safeDatasetName(input.dataset);
  const hours = safeWindowHours(input.windowHours ?? 24);
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 50)));
  const filters: string[] = [`timestamp >= NOW() - INTERVAL '${hours}' HOUR`];
  if (input.orgId) {
    filters.push(`blob1 = '${escapeSqlString(input.orgId)}'`);
  }
  if (input.dispatchScriptName) {
    filters.push(`index1 = '${escapeSqlString(input.dispatchScriptName)}'`);
  }

  return [
    'SELECT',
    '  index1 AS dispatchScriptName,',
    '  blob1 AS orgId,',
    '  any(blob4) AS quotaTier,',
    "  sum(if(blob3 = 'http', _sample_interval, 0)) AS httpRequests,",
    "  sum(if(blob3 = 'asset', _sample_interval, 0)) AS assetRequests,",
    "  sum(if(blob3 IN ('do_fetch', 'do_rpc', 'do_alarm', 'do_ws'), _sample_interval, 0)) AS doEvents,",
    '  sum(double1 * _sample_interval) AS rowsRead,',
    '  sum(double2 * _sample_interval) AS rowsWritten,',
    '  sum(double3 * _sample_interval) AS totalDurationMs,',
    '  max(double4) AS maxDbSizeBytes,',
    '  sum(double6 * _sample_interval) AS quotaTrips,',
    "  sum(if(blob3 = 'lazy_migration_hit', _sample_interval, 0)) AS lazyMigrationHits",
    `FROM ${dataset}`,
    `WHERE ${filters.join(' AND ')}`,
    'GROUP BY dispatchScriptName, orgId',
    'ORDER BY rowsWritten DESC, rowsRead DESC',
    `LIMIT ${limit}`,
  ].join('\n');
}

export async function queryDynamicAppUsage(
  config: AnalyticsEngineQueryConfig,
  query: {
    windowHours?: number;
    orgId?: string;
    dispatchScriptName?: string;
    limit?: number;
  } = {},
): Promise<DynamicAppUsageSummary[]> {
  const sql = buildDynamicAppUsageSql({
    dataset: config.dataset,
    ...query,
  });
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/analytics_engine/sql`;
  const resp = await (config.fetcher ?? fetch)(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: sql,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Analytics Engine SQL query failed (${resp.status}): ${text.slice(0, 256)}`);
  }
  const body = (await resp.json()) as { data?: Array<Record<string, unknown>> };
  return (body.data ?? []).map((row) => ({
    dispatchScriptName: String(row.dispatchScriptName ?? ''),
    orgId: String(row.orgId ?? ''),
    quotaTier: String(row.quotaTier ?? 'free'),
    httpRequests: Number(row.httpRequests ?? 0),
    assetRequests: Number(row.assetRequests ?? 0),
    doEvents: Number(row.doEvents ?? 0),
    rowsRead: Number(row.rowsRead ?? 0),
    rowsWritten: Number(row.rowsWritten ?? 0),
    totalDurationMs: Number(row.totalDurationMs ?? 0),
    maxDbSizeBytes: Number(row.maxDbSizeBytes ?? 0),
    quotaTrips: Number(row.quotaTrips ?? 0),
    lazyMigrationHits: Number(row.lazyMigrationHits ?? 0),
  }));
}
