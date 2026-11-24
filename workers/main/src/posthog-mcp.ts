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

interface PostHogMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface PostHogClient {
  host: string;
  token: string;
  projectId: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function isPostHogMcpIntegration(integrationType: string): boolean {
  return integrationType === 'posthog';
}

export function listPostHogMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_projects',
      description: 'List PostHog projects visible to the connected personal API key.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_feature_flags',
      description: 'List PostHog feature flags for a project. Uses the connection project_id when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'PostHog project id.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum flags to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_insights',
      description: 'List PostHog saved insights for a project. Uses the connection project_id when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'PostHog project id.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum insights to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'execute_hogql_readonly',
      description: 'Execute a HogQL query in PostHog. Uses the connection project_id when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'PostHog project id.' },
          query: { type: 'string', description: 'HogQL query to execute.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function postHogMcpRpc(
  env: PostHogMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isPostHogMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not PostHog.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-posthog', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listPostHogMcpTools() };
    case 'tools/call':
      return callPostHogTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callPostHogTool(
  env: PostHogMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createPostHogClient(env, record);

  switch (name) {
    case 'list_projects':
      return textToolResult(await postHogFetch<JsonValue>(client, '/api/projects/'));
    case 'list_feature_flags':
      return textToolResult(await postHogFetch<JsonValue>(
        client,
        `/api/projects/${encodeURIComponent(projectIdFromArgs(client, args))}/feature_flags/?${limitParams(args.limit)}`
      ));
    case 'list_insights':
      return textToolResult(await postHogFetch<JsonValue>(
        client,
        `/api/projects/${encodeURIComponent(projectIdFromArgs(client, args))}/insights/?${limitParams(args.limit)}`
      ));
    case 'execute_hogql_readonly':
      return textToolResult(await executeHogqlReadonly(client, args));
    default:
      throw Object.assign(new Error(`Unknown PostHog tool: ${name}`), { status: 404 });
  }
}

async function executeHogqlReadonly(
  client: PostHogClient,
  args: Record<string, unknown>
): Promise<JsonValue> {
  const query = requireString(args.query, 'query');
  assertReadOnlyQuery(query);
  return postHogFetch<JsonValue>(
    client,
    `/api/projects/${encodeURIComponent(projectIdFromArgs(client, args))}/query/`,
    {
      method: 'POST',
      body: {
        query: {
          kind: 'HogQLQuery',
          query,
        },
      },
    }
  );
}

async function createPostHogClient(
  env: PostHogMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<PostHogClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = typeof credentials.api_key === 'string' ? credentials.api_key.trim() : '';
  if (!token) {
    throw Object.assign(new Error('PostHog integration has no usable personal API key.'), { status: 400 });
  }
  const host = validatePostHogHost(requireString(config.host, 'host'));
  const projectId = typeof config.project_id === 'string' && config.project_id.trim()
    ? config.project_id.trim()
    : null;
  return { host, token, projectId };
}

async function postHogFetch<T>(
  client: PostHogClient,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetchMcpHttp(`${client.host}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as T & { detail?: string; error?: string } : {} as T;
  if (!response.ok) {
    throw Object.assign(
      new Error((payload as { detail?: string; error?: string }).detail || (payload as { error?: string }).error || `PostHog API request failed with HTTP ${response.status}`),
      { status: response.status }
    );
  }
  return payload as T;
}

function projectIdFromArgs(client: PostHogClient, args: Record<string, unknown>): string {
  if (typeof args.projectId === 'string' && args.projectId.trim()) return args.projectId.trim();
  if (client.projectId) return client.projectId;
  throw Object.assign(new Error('projectId is required because the connection has no default project_id.'), {
    status: 400,
  });
}

function limitParams(value: unknown): URLSearchParams {
  return new URLSearchParams({
    limit: String(boundedInteger(value, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
  });
}

function assertReadOnlyQuery(query: string): void {
  const trimmed = query.trim().replace(/;\s*$/, '');
  if (!trimmed) throw Object.assign(new Error('query is required'), { status: 400 });
}
function validatePostHogHost(rawHost: string): string {
  let url: URL;
  try {
    url = new URL(rawHost);
  } catch {
    throw Object.assign(new Error('host must be a valid HTTPS URL.'), { status: 400 });
  }
  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('host must use HTTPS.'), { status: 400 });
  }
  if (url.username || url.password) {
    throw Object.assign(new Error('host must not include embedded credentials.'), { status: 400 });
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname.endsWith('.internal')
    || hostname.endsWith('.local')
  ) {
    throw Object.assign(new Error('host must not point to a local or internal address.'), { status: 400 });
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}
