import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, objectArg, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface SegmentMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface SegmentClient {
  token: string;
}

const SEGMENT_API_BASE = 'https://api.segmentapis.com';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function isSegmentMcpIntegration(integrationType: string): boolean {
  return integrationType === 'segment';
}

export function listSegmentMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_sources',
      description: 'List Segment sources visible to the Public API token.',
      inputSchema: limitSchema(),
    },
    {
      name: 'get_source',
      description: 'Get one Segment source by id.',
      inputSchema: { type: 'object', properties: { sourceId: { type: 'string' } }, required: ['sourceId'], additionalProperties: false },
    },
    {
      name: 'list_destinations',
      description: 'List Segment destinations visible to the Public API token.',
      inputSchema: limitSchema(),
    },
    {
      name: 'get_destination',
      description: 'Get one Segment destination by id.',
      inputSchema: { type: 'object', properties: { destinationId: { type: 'string' } }, required: ['destinationId'], additionalProperties: false },
    },
  ];
}

export async function segmentMcpRpc(
  env: SegmentMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isSegmentMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Segment.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-segment', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listSegmentMcpTools() };
    case 'tools/call':
      return callSegmentTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callSegmentTool(
  env: SegmentMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createSegmentClient(env, record);

  switch (name) {
    case 'list_sources':
      return textToolResult(await segmentFetch<JsonValue>(client, `/sources?${pageParams(args)}`));
    case 'get_source':
      return textToolResult(await segmentFetch<JsonValue>(client, `/sources/${encodeURIComponent(requireId(args.sourceId, 'sourceId'))}`));
    case 'list_destinations':
      return textToolResult(await segmentFetch<JsonValue>(client, `/destinations?${pageParams(args)}`));
    case 'get_destination':
      return textToolResult(await segmentFetch<JsonValue>(client, `/destinations/${encodeURIComponent(requireId(args.destinationId, 'destinationId'))}`));
    default:
      throw Object.assign(new Error(`Unknown Segment tool: ${name}`), { status: 404 });
  }
}

async function createSegmentClient(env: SegmentMcpEnv, record: WorkspaceIntegrationRecord): Promise<SegmentClient> {
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  return { token: requireString(credentials.api_key, 'api_key') };
}

async function segmentFetch<T>(client: SegmentClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${SEGMENT_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${client.token}`, accept: 'application/json' },
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as T & { message?: string; error?: string } : {} as T;
  if (!response.ok) {
    throw Object.assign(new Error((payload as { message?: string; error?: string }).message || (payload as { error?: string }).error || `Segment API request failed with HTTP ${response.status}`), { status: response.status });
  }
  return payload as T;
}

function pageParams(args: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams({
    pagination: JSON.stringify({ count: boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit') }),
  });
  if (typeof args.cursor === 'string' && args.cursor.trim()) params.set('cursor', args.cursor.trim());
  return params;
}

function limitSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      cursor: { type: 'string', description: 'Optional pagination cursor.' },
    },
    additionalProperties: false,
  };
}

function requireId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!/^[A-Za-z0-9_.:/-]{1,256}$/.test(id)) throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  return id;
}
