import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface RedisMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface RedisClient {
  restUrl: string;
  token: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const KEY_RE = /^[^\r\n]{1,512}$/;

export function isRedisMcpIntegration(integrationType: string): boolean {
  return integrationType === 'redis';
}

export function listRedisMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'scan_keys',
      description: 'Scan Redis keys with an optional match pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          match: { type: 'string', description: 'Optional Redis glob pattern.' },
          cursor: { type: 'string', description: 'Optional cursor from a previous scan.' },
          count: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_key',
      description: 'Read a string key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    },
    {
      name: 'get_key_type',
      description: 'Get the Redis type for a key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    },
    {
      name: 'get_ttl',
      description: 'Get the TTL for a Redis key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    },
    {
      name: 'hash_get_all',
      description: 'Read all fields from a hash key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
    },
    {
      name: 'list_range',
      description: 'Read a bounded range from a list key.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          start: { type: 'integer', default: 0 },
          stop: { type: 'integer', default: 99 },
        },
        required: ['key'],
        additionalProperties: false,
      },
    },
  ];
}

export async function redisMcpRpc(
  env: RedisMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isRedisMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Redis.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-redis', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listRedisMcpTools() };
    case 'tools/call':
      return callRedisTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callRedisTool(
  env: RedisMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createRedisClient(env, record);

  switch (name) {
    case 'scan_keys':
      return textToolResult(await redisCommand(client, scanCommand(args)));
    case 'get_key':
      return textToolResult(await redisCommand(client, ['GET', requireKey(args.key)]));
    case 'get_key_type':
      return textToolResult(await redisCommand(client, ['TYPE', requireKey(args.key)]));
    case 'get_ttl':
      return textToolResult(await redisCommand(client, ['TTL', requireKey(args.key)]));
    case 'hash_get_all':
      return textToolResult(await redisCommand(client, ['HGETALL', requireKey(args.key)]));
    case 'list_range':
      return textToolResult(await redisCommand(client, [
        'LRANGE',
        requireKey(args.key),
        String(boundedInteger(args.start, 0, -1_000_000, 1_000_000, 'start')),
        String(boundedInteger(args.stop, 99, -1_000_000, 1_000_000, 'stop')),
      ]));
    default:
      throw Object.assign(new Error(`Unknown Redis tool: ${name}`), { status: 404 });
  }
}

async function createRedisClient(env: RedisMcpEnv, record: WorkspaceIntegrationRecord): Promise<RedisClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const restUrl = optionalString(credentials.rest_url) || optionalString(config.rest_url);
  if (!restUrl) {
    throw Object.assign(new Error('Redis MCP requires an Upstash-compatible REST URL in credentials.rest_url or config.rest_url.'), { status: 400 });
  }
  return {
    restUrl: validateHttpsBaseUrl(restUrl),
    token: requireString(credentials.rest_token, 'rest_token'),
  };
}

function scanCommand(args: Record<string, unknown>): string[] {
  const command = ['SCAN', typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : '0'];
  if (typeof args.match === 'string' && args.match.trim()) command.push('MATCH', requireKey(args.match, 'match'));
  command.push('COUNT', String(boundedInteger(args.count, DEFAULT_LIMIT, 1, MAX_LIMIT, 'count')));
  return command;
}

async function redisCommand(client: RedisClient, command: string[]): Promise<JsonValue> {
  const response = await fetchMcpHttp(client.restUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue & { error?: string } : {} as JsonValue;
  if (!response.ok) {
    const message = typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `Redis REST request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload;
}

function requireKey(value: unknown, field = 'key'): string {
  const key = requireString(value, field);
  if (!KEY_RE.test(key)) {
    throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  }
  return key;
}

function validateHttpsBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw Object.assign(new Error('rest_url must use HTTPS.'), { status: 400 });
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function optionalString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
