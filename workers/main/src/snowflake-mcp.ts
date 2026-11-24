import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { ANALYTICS_MCP_HTTP_TIMEOUT_MS, fetchMcpHttp, objectArg, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };

interface SnowflakeMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface SnowflakeClient {
  account: string;
  username: string;
  privateKeyPem: string;
  fingerprint: string;
  warehouse: string | null;
  database: string | null;
  schema: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function isSnowflakeMcpIntegration(integrationType: string): boolean {
  return integrationType === 'snowflake';
}

export function listSnowflakeMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_databases',
      description: 'List Snowflake databases.',
      inputSchema: limitSchema(),
    },
    {
      name: 'list_schemas',
      description: 'List schemas in a database. Uses the connection database when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'Database name.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_tables',
      description: 'List tables in a database schema.',
      inputSchema: {
        type: 'object',
        properties: {
          database: { type: 'string', description: 'Database name. Uses connection database when omitted.' },
          schema: { type: 'string', description: 'Schema name. Uses connection schema when omitted.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'execute_sql_readonly',
      description: 'Execute a SQL query through the Snowflake SQL API. The query runs exactly as written; add your own LIMIT to cap rows.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Read-only SQL statement.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export async function snowflakeMcpRpc(
  env: SnowflakeMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isSnowflakeMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Snowflake.`), { status: 404 });
  }
  switch (method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'camelai-snowflake', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listSnowflakeMcpTools() };
    case 'tools/call':
      return callSnowflakeTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callSnowflakeTool(
  env: SnowflakeMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = objectArg(params.arguments);
  const client = await createSnowflakeClient(env, record);
  const limit = boundedInteger(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');

  switch (name) {
    case 'list_databases':
      return textToolResult(await executeSnowflakeSql(client, `SHOW DATABASES LIMIT ${limit}`));
    case 'list_schemas':
      return textToolResult(await executeSnowflakeSql(client, `SHOW SCHEMAS IN DATABASE ${quoteIdentifier(databaseFromArgs(client, args))} LIMIT ${limit}`));
    case 'list_tables':
      return textToolResult(await executeSnowflakeSql(client, `SHOW TABLES IN SCHEMA ${quoteIdentifier(databaseFromArgs(client, args))}.${quoteIdentifier(schemaFromArgs(client, args))} LIMIT ${limit}`));
    case 'execute_sql_readonly':
      return textToolResult(await executeSnowflakeSql(client, requireString(args.query, 'query')));
    default:
      throw Object.assign(new Error(`Unknown Snowflake tool: ${name}`), { status: 404 });
  }
}

async function createSnowflakeClient(env: SnowflakeMcpEnv, record: WorkspaceIntegrationRecord): Promise<SnowflakeClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  if (typeof credentials.private_key_passphrase === 'string' && credentials.private_key_passphrase.trim()) {
    throw Object.assign(new Error('Snowflake MCP currently requires an unencrypted PKCS#8 private key; encrypted private keys are still available to containers only.'), { status: 400 });
  }
  return {
    account: requireAccount(config.account),
    username: requireString(credentials.username, 'username').toUpperCase(),
    privateKeyPem: requireString(credentials.private_key, 'private_key'),
    fingerprint: requireString(credentials.private_key_fingerprint, 'private_key_fingerprint'),
    warehouse: optionalString(config.warehouse),
    database: optionalString(config.database),
    schema: optionalString(config.schema) || 'PUBLIC',
  };
}

async function executeSnowflakeSql(client: SnowflakeClient, statement: string): Promise<JsonValue> {
  const token = await snowflakeJwt(client);
  const response = await fetchMcpHttp(`https://${client.account}.snowflakecomputing.com/api/v2/statements`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      statement,
      timeout: 30,
      warehouse: client.warehouse ?? undefined,
      database: client.database ?? undefined,
      schema: client.schema ?? undefined,
    }),
  }, ANALYTICS_MCP_HTTP_TIMEOUT_MS);
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue & { message?: string; code?: string } : {} as JsonValue;
  if (!response.ok) {
    throw Object.assign(new Error((payload as { message?: string }).message || `Snowflake SQL API request failed with HTTP ${response.status}`), { status: response.status });
  }
  return payload;
}

async function snowflakeJwt(client: SnowflakeClient): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const qualifiedUser = `${client.account.toUpperCase()}.${client.username}`;
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: `${qualifiedUser}.${client.fingerprint}`,
    sub: qualifiedUser,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(client.privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw Object.assign(new Error('private_key must be an unencrypted PKCS#8 PEM private key.'), { status: 400 });
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function databaseFromArgs(client: SnowflakeClient, args: Record<string, unknown>): string {
  if (typeof args.database === 'string' && args.database.trim()) return args.database.trim();
  if (client.database) return client.database;
  throw Object.assign(new Error('database is required because the connection has no default database.'), { status: 400 });
}

function schemaFromArgs(client: SnowflakeClient, args: Record<string, unknown>): string {
  if (typeof args.schema === 'string' && args.schema.trim()) return args.schema.trim();
  if (client.schema) return client.schema;
  throw Object.assign(new Error('schema is required because the connection has no default schema.'), { status: 400 });
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$ -]*$/.test(value)) {
    throw Object.assign(new Error('identifier contains invalid characters.'), { status: 400 });
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function requireAccount(value: unknown): string {
  const account = requireString(value, 'account').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(account)) throw Object.assign(new Error('account contains invalid characters.'), { status: 400 });
  return account;
}

function limitSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    additionalProperties: false,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
