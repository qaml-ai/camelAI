import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SentryMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface SentryClient {
  token: string;
  organization: string | null;
}

const SENTRY_API_BASE = 'https://sentry.io/api/0';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SENTRY_SLUG_RE = /^[a-z0-9_-]+$/i;

export function isSentryMcpIntegration(integrationType: string): boolean {
  return integrationType === 'sentry';
}

export function listSentryMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_organizations',
      description: 'List Sentry organizations visible to the connected auth token.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_projects',
      description: 'List projects in a Sentry organization. Uses the connection organization when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          organization: { type: 'string', description: 'Sentry organization slug.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'search_issues',
      description: 'Search Sentry issues in an organization.',
      inputSchema: {
        type: 'object',
        properties: {
          organization: { type: 'string', description: 'Sentry organization slug. Optional when configured on the connection.' },
          query: { type: 'string', description: 'Sentry issue search query.' },
          project: { type: 'string', description: 'Optional Sentry project id or slug filter.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum issues to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_issue',
      description: 'Get details for one Sentry issue by issue id.',
      inputSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Sentry issue id.' },
        },
        required: ['issueId'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_issue_events',
      description: 'List events for one Sentry issue by issue id.',
      inputSchema: {
        type: 'object',
        properties: {
          issueId: { type: 'string', description: 'Sentry issue id.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum events to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        required: ['issueId'],
        additionalProperties: false,
      },
    },
  ];
}

export async function sentryMcpRpc(
  env: SentryMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isSentryMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Sentry.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-sentry', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listSentryMcpTools() };
    case 'tools/call':
      return callSentryTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callSentryTool(
  env: SentryMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createSentryClient(env, record);

  switch (name) {
    case 'list_organizations':
      return textToolResult(await sentryFetch<JsonValue>(client, '/organizations/'));
    case 'list_projects':
      return textToolResult(await sentryFetch<JsonValue>(
        client,
        `/organizations/${encodeURIComponent(organizationFromArgs(client, args))}/projects/`
      ));
    case 'search_issues':
      return textToolResult(await searchIssues(client, args));
    case 'get_issue':
      return textToolResult(await sentryFetch<JsonValue>(
        client,
        `/issues/${encodeURIComponent(requireNumericId(args.issueId, 'issueId'))}/`
      ));
    case 'list_issue_events':
      return textToolResult(await sentryFetch<JsonValue>(
        client,
        `/issues/${encodeURIComponent(requireNumericId(args.issueId, 'issueId'))}/events/?${new URLSearchParams({
          limit: String(boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
        })}`
      ));
    default:
      throw Object.assign(new Error(`Unknown Sentry tool: ${name}`), { status: 404 });
  }
}

async function searchIssues(
  client: SentryClient,
  args: Record<string, unknown>
): Promise<JsonValue> {
  const searchParams = new URLSearchParams({
    limit: String(boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
  });
  if (typeof args.query === 'string' && args.query.trim()) {
    searchParams.set('query', args.query.trim());
  }
  if (typeof args.project === 'string' && args.project.trim()) {
    searchParams.set('project', args.project.trim());
  }
  return sentryFetch<JsonValue>(
    client,
    `/organizations/${encodeURIComponent(organizationFromArgs(client, args))}/issues/?${searchParams}`
  );
}

async function createSentryClient(
  env: SentryMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<SentryClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = typeof credentials.api_key === 'string' ? credentials.api_key.trim() : '';
  if (!token) {
    throw Object.assign(new Error('Sentry integration has no usable auth token.'), { status: 400 });
  }
  const organization = typeof config.organization === 'string' && config.organization.trim()
    ? requireSlug(config.organization, 'organization')
    : null;
  return { token, organization };
}

async function sentryFetch<T>(client: SentryClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${SENTRY_API_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as T & { detail?: string } : {} as T & { detail?: string };
  if (!response.ok) {
    throw Object.assign(
      new Error(payload.detail || `Sentry API request failed with HTTP ${response.status}`),
      { status: response.status }
    );
  }
  return payload as T;
}

function organizationFromArgs(client: SentryClient, args: Record<string, unknown>): string {
  if (typeof args.organization === 'string' && args.organization.trim()) {
    return requireSlug(args.organization, 'organization');
  }
  if (client.organization) return client.organization;
  throw Object.assign(new Error('organization is required because the connection has no default organization.'), {
    status: 400,
  });
}

function requireSlug(value: unknown, field: string): string {
  const slug = requireString(value, field);
  if (!SENTRY_SLUG_RE.test(slug)) {
    throw Object.assign(new Error(`${field} must be a valid Sentry slug.`), { status: 400 });
  }
  return slug;
}

function requireNumericId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[0-9]+$/.test(id)) {
    throw Object.assign(new Error(`${field} must be a numeric Sentry id.`), { status: 400 });
  }
  return id;
}
