import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface MongoDbMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface MongoDbClient {
  dataApiUrl: string;
  apiKey: string;
  dataSource: string;
  database: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export function isMongoDbMcpIntegration(integrationType: string): boolean {
  return integrationType === 'mongodb';
}

export function listMongoDbMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_collections',
      description: 'List collections in the configured MongoDB database through Atlas Data API.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'find_documents',
      description: 'Find documents in a collection. Filter and projection must be JSON objects.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          filter: { type: 'object', description: 'MongoDB find filter.' },
          projection: { type: 'object', description: 'MongoDB projection.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        required: ['collection'],
        additionalProperties: false,
      },
    },
    {
      name: 'aggregate_readonly',
      description: 'Run a read-only aggregation pipeline. Write stages are rejected.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          pipeline: { type: 'array', description: 'Aggregation pipeline stages.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        required: ['collection', 'pipeline'],
        additionalProperties: false,
      },
    },
  ];
}

export async function mongoDbMcpRpc(
  env: MongoDbMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isMongoDbMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not MongoDB.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-mongodb', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listMongoDbMcpTools() };
    case 'tools/call':
      return callMongoDbTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callMongoDbTool(
  env: MongoDbMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createMongoDbClient(env, record);

  switch (name) {
    case 'list_collections':
      return textToolResult(await mongoDbAction(client, 'listCollections', {}));
    case 'find_documents':
      return textToolResult(await mongoDbAction(client, 'find', {
        collection: requireCollectionName(args.collection),
        filter: objectArg(args.filter),
        projection: args.projection === undefined ? undefined : objectArg(args.projection),
        limit: boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit'),
      }));
    case 'aggregate_readonly':
      return textToolResult(await mongoDbAction(client, 'aggregate', {
        collection: requireCollectionName(args.collection),
        pipeline: normalizePipeline(args.pipeline, boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
      }));
    default:
      throw Object.assign(new Error(`Unknown MongoDB tool: ${name}`), { status: 404 });
  }
}

async function createMongoDbClient(env: MongoDbMcpEnv, record: WorkspaceIntegrationRecord): Promise<MongoDbClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const dataApiUrl = optionalString(credentials.data_api_url) || optionalString(config.data_api_url);
  if (!dataApiUrl) {
    throw Object.assign(new Error('MongoDB MCP requires Atlas Data API URL in credentials.data_api_url or config.data_api_url.'), { status: 400 });
  }
  return {
    dataApiUrl: validateHttpsBaseUrl(dataApiUrl),
    apiKey: requireString(credentials.data_api_key, 'data_api_key'),
    dataSource: optionalString(config.data_source) || optionalString(config.cluster_url) || 'Cluster0',
    database: requireString(config.database, 'database'),
  };
}

async function mongoDbAction(client: MongoDbClient, action: string, body: Record<string, unknown>): Promise<JsonValue> {
  const response = await fetchMcpHttp(`${client.dataApiUrl}/action/${action}`, {
    method: 'POST',
    headers: {
      'api-key': client.apiKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      dataSource: client.dataSource,
      database: client.database,
      ...dropUndefined(body),
    }),
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue & { error?: string } : {} as JsonValue;
  if (!response.ok) {
    const message = typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : `MongoDB Data API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload;
}

function normalizePipeline(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) throw Object.assign(new Error('pipeline must be an array.'), { status: 400 });
  for (const stage of value) {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw Object.assign(new Error('pipeline stages must be JSON objects.'), { status: 400 });
    }
  }
  return [...value, { $limit: limit }];
}

function requireCollectionName(value: unknown): string {
  const collection = requireString(value, 'collection');
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(collection) || collection.startsWith('system.')) {
    throw Object.assign(new Error('collection contains invalid characters.'), { status: 400 });
  }
  return collection;
}

function dropUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function validateHttpsBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw Object.assign(new Error('data_api_url must use HTTPS.'), { status: 400 });
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function optionalString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}
