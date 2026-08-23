import { airtableMcpRpc } from './airtable-mcp.js';
import { amplitudeMcpRpc } from './amplitude-mcp.js';
import { bigQueryMcpRpc } from './bigquery-mcp.js';
import { clickHouseMcpRpc } from './clickhouse-mcp.js';
import { databricksMcpRpc } from './databricks-mcp.js';
import { mailchimpMcpRpc } from './mailchimp-mcp.js';
import { mixpanelMcpRpc } from './mixpanel-mcp.js';
import { mongoDbMcpRpc } from './mongodb-mcp.js';
import { postHogMcpRpc } from './posthog-mcp.js';
import { redisMcpRpc } from './redis-mcp.js';
import { segmentMcpRpc } from './segment-mcp.js';
import { sendGridMcpRpc } from './sendgrid-mcp.js';
import { sentryMcpRpc } from './sentry-mcp.js';
import { shopifyMcpRpc } from './shopify-mcp.js';
import { snowflakeMcpRpc } from './snowflake-mcp.js';
import { sqlDatabaseMcpRpc } from './sql-database-mcp.js';
import { teamsMcpRpc } from './teams-mcp.js';
import { tursoMcpRpc } from './turso-mcp.js';
import { twilioMcpRpc } from './twilio-mcp.js';
import { zendeskMcpRpc } from './zendesk-mcp.js';
import type { DataProxyEnv } from './data-proxy.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

export interface HostedConnectionAdapterEnv extends DataProxyEnv {
  INTEGRATION_SECRET_KEY: string;
  OBJECT_STORE_SERVICE?: Fetcher;
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
}

export interface HostedConnectionAdapterContext {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

export type HostedConnectionAdapter = (
  env: HostedConnectionAdapterEnv,
  context: HostedConnectionAdapterContext,
  record: WorkspaceIntegrationRecord,
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export interface HostedConnectionVerificationProbe {
  tool: string;
  input?: Record<string, unknown>;
}

export interface HostedConnectionAdapterRegistration {
  invoke: HostedConnectionAdapter;
  verification?: HostedConnectionVerificationProbe;
}

const direct = (
  rpc: (
    env: HostedConnectionAdapterEnv,
    record: WorkspaceIntegrationRecord,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>,
): HostedConnectionAdapter => (env, _context, record, method, params = {}) => (
  rpc(env, record, method, params)
);

const hosted = (
  invoke: HostedConnectionAdapter,
  tool?: string,
  input?: Record<string, unknown>,
): HostedConnectionAdapterRegistration => ({
  invoke,
  verification: tool ? { tool, input } : undefined,
});

/**
 * Hosted MCP implementations live behind this single registry. Adding a hosted
 * provider should require one adapter entry, not branches in every connection
 * catalog and proxy surface.
 */
export const HOSTED_CONNECTION_ADAPTERS: Readonly<Record<string, HostedConnectionAdapterRegistration>> = {
  bigquery: hosted((env, context, record, method, params = {}) => (
    bigQueryMcpRpc(env, { workspaceId: context.workspaceId }, record, method, params)
  )),
  clickhouse: hosted((env, context, record, method, params = {}) => (
    clickHouseMcpRpc(env, { workspaceId: context.workspaceId }, record, method, params)
  )),
  postgres: hosted((env, context, record, method, params = {}) => (
    sqlDatabaseMcpRpc(env, context, record, method, params)
  )),
  mysql: hosted((env, context, record, method, params = {}) => (
    sqlDatabaseMcpRpc(env, context, record, method, params)
  )),
  neon: hosted((env, context, record, method, params = {}) => (
    sqlDatabaseMcpRpc(env, context, record, method, params)
  )),
  planetscale: hosted((env, context, record, method, params = {}) => (
    sqlDatabaseMcpRpc(env, context, record, method, params)
  )),
  airtable: hosted(direct(airtableMcpRpc), 'list_bases'),
  amplitude: hosted(direct(amplitudeMcpRpc), 'list_events'),
  databricks: hosted(direct(databricksMcpRpc), 'list_sql_warehouses'),
  mailchimp: hosted(direct(mailchimpMcpRpc), 'list_audiences', { count: 1 }),
  mixpanel: hosted(direct(mixpanelMcpRpc), 'top_events', { limit: 1 }),
  mongodb: hosted(direct(mongoDbMcpRpc), 'list_collections'),
  posthog: hosted(direct(postHogMcpRpc), 'list_projects'),
  redis: hosted(direct(redisMcpRpc), 'scan_keys', { count: 1 }),
  segment: hosted(direct(segmentMcpRpc), 'list_sources'),
  sendgrid: hosted(direct(sendGridMcpRpc), 'list_sender_identities'),
  sentry: hosted(direct(sentryMcpRpc), 'list_organizations'),
  shopify: hosted(direct(shopifyMcpRpc), 'get_shop'),
  snowflake: hosted(direct(snowflakeMcpRpc), 'list_databases'),
  teams: hosted(direct(teamsMcpRpc), 'list_teams'),
  turso: hosted(direct(tursoMcpRpc), 'list_tables'),
  twilio: hosted(direct(twilioMcpRpc), 'list_messages', { page_size: 1 }),
  zendesk: hosted(direct(zendeskMcpRpc), 'search_tickets', { query: 'type:ticket', per_page: 1 }),
};

export function getHostedConnectionAdapter(
  integrationType: string,
): HostedConnectionAdapter | null {
  return HOSTED_CONNECTION_ADAPTERS[integrationType]?.invoke ?? null;
}

export function getHostedConnectionVerificationProbe(
  integrationType: string,
): HostedConnectionVerificationProbe | null {
  return HOSTED_CONNECTION_ADAPTERS[integrationType]?.verification ?? null;
}
