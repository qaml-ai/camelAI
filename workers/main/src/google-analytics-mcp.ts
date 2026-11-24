import { decryptCredentials } from '../../../src/lib/integration-crypto';
import type { WorkspaceIntegrationRecord } from './workspace.js';
import { fetchMcpHttp, readBoundedResponseText } from './mcp-values.js';

export const GOOGLE_ANALYTICS_INTEGRATION_TYPE = 'google_analytics';

export const GOOGLE_ANALYTICS_METHODS = [
  { name: 'listProperties', tool: 'list_properties', description: 'List GA4 properties available to the connected Google account.', access: 'read' as const },
  { name: 'getMetadata', tool: 'get_metadata', description: 'List GA4 dimensions and metrics, including custom fields, for a property.', access: 'read' as const },
  { name: 'checkCompatibility', tool: 'check_compatibility', description: 'Check whether requested GA4 dimensions and metrics can be used together.', access: 'read' as const },
  { name: 'runReport', tool: 'run_report', description: 'Run a GA4 core report. Although Google uses POST, this operation only reads analytics data.', access: 'read' as const },
  { name: 'runRealtimeReport', tool: 'run_realtime_report', description: 'Run a GA4 realtime report.', access: 'read' as const },
  { name: 'runPivotReport', tool: 'run_pivot_report', description: 'Run a GA4 pivot report.', access: 'read' as const },
  { name: 'topPages', tool: 'top_pages', description: 'Return top pages by views for a date range.', access: 'read' as const },
  { name: 'trafficOverview', tool: 'traffic_overview', description: 'Summarize users, sessions, engaged sessions, and views over time.', access: 'read' as const },
  { name: 'acquisitionOverview', tool: 'acquisition_overview', description: 'Break down acquisition by default channel group.', access: 'read' as const },
  { name: 'eventsOverview', tool: 'events_overview', description: 'Return top GA4 events and event counts.', access: 'read' as const },
  { name: 'keyEventsOverview', tool: 'key_events_overview', description: 'Return configured key events and counts.', access: 'read' as const },
];

interface GoogleAnalyticsEnv {
  INTEGRATION_SECRET_KEY: string;
}

function config(record: WorkspaceIntegrationRecord): Record<string, unknown> {
  try {
    return JSON.parse(record.config) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function propertyName(record: WorkspaceIntegrationRecord, input: Record<string, unknown>): string {
  const value = typeof input.property === 'string'
    ? input.property
    : typeof input.property_id === 'string'
      ? input.property_id
      : config(record).property_id;
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('Select a GA4 property or pass property_id.'), { status: 400 });
  }
  return value.startsWith('properties/') ? value : `properties/${value}`;
}

async function googleRequest(
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetchMcpHttp(url, { ...init, headers });
  const text = await readBoundedResponseText(response);
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // Preserve upstream text in the error below.
  }
  if (!response.ok) {
    const apiMessage = (payload as { error?: { message?: unknown } })?.error?.message;
    throw Object.assign(
      new Error(typeof apiMessage === 'string' ? apiMessage : `Google Analytics API failed with HTTP ${response.status}`),
      { status: response.status, data: payload },
    );
  }
  return payload;
}

function reportBody(input: Record<string, unknown>): Record<string, unknown> {
  const { property: _property, property_id: _propertyId, ...body } = input;
  return body;
}

function semanticDateRanges(input: Record<string, unknown>): unknown {
  return input.dateRanges ?? [{ startDate: '28daysAgo', endDate: 'yesterday' }];
}

function semanticLimit(input: Record<string, unknown>, fallback = 25): unknown {
  return input.limit ?? fallback;
}

export async function googleAnalyticsTool(
  env: GoogleAnalyticsEnv,
  record: WorkspaceIntegrationRecord,
  tool: string,
  input: Record<string, unknown> = {},
): Promise<unknown> {
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = typeof credentials.access_token === 'string' ? credentials.access_token.trim() : '';
  if (!token) {
    throw Object.assign(new Error(`Google Analytics connection "${record.name}" needs authorization.`), { status: 401 });
  }

  if (tool === 'list_properties') {
    return googleRequest(token, 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200');
  }

  const property = propertyName(record, input);
  const dataBase = `https://analyticsdata.googleapis.com/v1beta/${property}`;
  if (tool === 'get_metadata') {
    return googleRequest(token, `${dataBase}/metadata`);
  }
  if (tool === 'check_compatibility') {
    return googleRequest(token, `${dataBase}:checkCompatibility`, {
      method: 'POST',
      body: JSON.stringify(reportBody(input)),
    });
  }

  let endpoint = 'runReport';
  let body = reportBody(input);
  if (tool === 'run_realtime_report') endpoint = 'runRealtimeReport';
  if (tool === 'run_pivot_report') endpoint = 'runPivotReport';
  if (tool === 'top_pages') {
    body = {
      dateRanges: semanticDateRanges(input),
      dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: semanticLimit(input),
    };
  } else if (tool === 'traffic_overview') {
    body = {
      dateRanges: semanticDateRanges(input),
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'screenPageViews' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    };
  } else if (tool === 'acquisition_overview') {
    body = {
      dateRanges: semanticDateRanges(input),
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: semanticLimit(input),
    };
  } else if (tool === 'events_overview' || tool === 'key_events_overview') {
    body = {
      dateRanges: semanticDateRanges(input),
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: tool === 'key_events_overview' ? 'keyEvents' : 'eventCount' }],
      orderBys: [{ metric: { metricName: tool === 'key_events_overview' ? 'keyEvents' : 'eventCount' }, desc: true }],
      limit: semanticLimit(input),
    };
  } else if (!['run_report', 'run_realtime_report', 'run_pivot_report'].includes(tool)) {
    throw Object.assign(new Error(`Unknown Google Analytics tool: ${tool}`), { status: 404 });
  }

  return googleRequest(token, `${dataBase}:${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
