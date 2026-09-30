#!/usr/bin/env tsx

// Local smoke for the HTTP-based connection MCP brokers (Redis, ClickHouse,
// MongoDB, Turso). The SQL-database MCP (postgres/mysql/mssql) is NOT smoked
// here anymore: it executes in the DbQueryContainer Cloudflare container (see
// workers/main/src/db-query-service.ts), which tsx cannot host — its coverage
// lives in tests/db-query-*.test.ts, workers/main/tests/data-proxy-*.test.ts,
// workers/main/tests/connections-runtime.test.ts, and the staging smoke route
// (POST /api/admin/db-query-sandbox/query).

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { encryptCredentials } from '../src/lib/integration-crypto.js';
import { clickHouseMcpRpc } from '../workers/main/src/clickhouse-mcp.js';
import { mongoDbMcpRpc } from '../workers/main/src/mongodb-mcp.js';
import { redisMcpRpc } from '../workers/main/src/redis-mcp.js';
import { tursoMcpRpc } from '../workers/main/src/turso-mcp.js';
import type { WorkspaceIntegrationRecord } from '../workers/main/src/workspace.js';

type StartedContainer = {
  name: string;
  host: string;
  port: number;
};

const SECRET = 'local-database-mcp-secret';
const CONTAINERS = [
  'camelai-mcp-smoke-redis',
  'camelai-mcp-smoke-clickhouse',
];

function sh(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function docker(args: string[]): Promise<string> {
  return sh('docker', args);
}

async function cleanupContainers(): Promise<void> {
  await Promise.all(CONTAINERS.map((name) =>
    docker(['rm', '-f', name]).catch(() => '')
  ));
}

async function waitForTcp(host: string, port: number, label: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host, port });
        socket.setTimeout(1_000);
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('timeout'));
        });
        socket.on('error', reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  throw new Error(`Timed out waiting for ${label} on ${host}:${port}: ${String(lastError)}`);
}

async function mappedPort(container: string, port: number): Promise<number> {
  const output = await docker(['port', container, `${port}/tcp`]);
  const match = output.match(/:(\d+)\s*$/);
  if (!match) {
    throw new Error(`Could not parse mapped port for ${container}: ${output}`);
  }
  return Number(match[1]);
}

async function startRedis(): Promise<StartedContainer> {
  const name = 'camelai-mcp-smoke-redis';
  await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-p',
    '127.0.0.1::6379',
    'redis:7-alpine',
  ]);
  const port = await mappedPort(name, 6379);
  await waitForTcp('127.0.0.1', port, 'Redis');
  await waitForDockerExec(name, ['redis-cli', 'SET', 'greeting', 'alpha']);
  await waitForDockerExec(name, ['redis-cli', 'HSET', 'profile:1', 'name', 'camel', 'role', 'tester']);
  await waitForDockerExec(name, ['redis-cli', 'RPUSH', 'queue', 'one', 'two']);
  return { name, host: '127.0.0.1', port };
}

async function startClickHouse(): Promise<StartedContainer> {
  const name = 'camelai-mcp-smoke-clickhouse';
  await docker([
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '-e',
    'CLICKHOUSE_USER=camel',
    '-e',
    'CLICKHOUSE_PASSWORD=camelpw',
    '-e',
    'CLICKHOUSE_DB=camel',
    '-p',
    '127.0.0.1::8123',
    'clickhouse/clickhouse-server:24-alpine',
  ]);
  const port = await mappedPort(name, 8123);
  await waitForTcp('127.0.0.1', port, 'ClickHouse');
  await waitForDockerExec(name, [
    'clickhouse-client',
    '--user',
    'camel',
    '--password',
    'camelpw',
    '--database',
    'camel',
    '--query',
    "CREATE TABLE IF NOT EXISTS widgets (id UInt32, name String) ENGINE = Memory; INSERT INTO widgets VALUES (1, 'alpha'), (2, 'beta');",
    '--multiquery',
  ]);
  return { name, host: '127.0.0.1', port };
}

async function waitForDockerExec(container: string, args: string[]): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await docker(['exec', container, ...args]);
      return;
    } catch (error) {
      lastError = error;
      await delay(1_000);
    }
  }
  throw new Error(`Timed out waiting for ${container} exec ${args[0]}: ${String(lastError)}`);
}

async function stopProcessGroup(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }

  await Promise.race([
    closed,
    delay(5_000).then(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }),
  ]);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Could not allocate a free local port'));
        }
      });
    });
  });
}

async function startRedisRestShim(redis: StartedContainer): Promise<{ server: http.Server; port: number }> {
  const port = await freePort();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    if (req.headers.authorization !== 'Bearer redis-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    try {
      const command = await readJsonArray(req);
      const result = await runRedisCommand(redis.name, command);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return { server, port };
}

async function startMongoDataApiShim(): Promise<{ server: http.Server; port: number }> {
  const port = await freePort();
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    if (req.headers['api-key'] !== 'mongo-token') {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = await readJsonObject(req);
    if (body.dataSource !== 'Cluster0' || body.database !== 'camel') {
      json(res, 400, { error: 'unexpected data source or database' });
      return;
    }

    if (path === '/action/listCollections') {
      json(res, 200, { collections: [{ name: 'widgets' }] });
      return;
    }
    if (path === '/action/find') {
      json(res, 200, { documents: [{ _id: '1', name: 'alpha' }, { _id: '2', name: 'beta' }] });
      return;
    }
    if (path === '/action/aggregate') {
      json(res, 200, { documents: [{ name: 'alpha' }] });
      return;
    }

    json(res, 404, { error: `unknown action: ${path}` });
  });

  await listen(server, port);
  return { server, port };
}

async function startTursoHttpShim(): Promise<{ server: http.Server; port: number }> {
  const port = await freePort();
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (req.method !== 'POST' || path !== '/v2/pipeline') {
      json(res, 404, { error: 'not found' });
      return;
    }
    if (req.headers.authorization !== 'Bearer turso-token') {
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    const body = await readJsonObject(req);
    const request = Array.isArray(body.requests) ? body.requests[0] : undefined;
    const sql = String((request as { stmt?: { sql?: unknown } } | undefined)?.stmt?.sql ?? '').toLowerCase();
    if (sql.includes('sqlite_master')) {
      json(res, 200, tursoRows(['name', 'type'], [['widgets', 'table']]));
      return;
    }
    if (sql.includes('pragma table_info')) {
      json(res, 200, tursoRows(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'], [[0, 'id', 'INTEGER', 0, null, 1], [1, 'name', 'TEXT', 1, null, 0]]));
      return;
    }
    if (sql.includes('select name from widgets')) {
      json(res, 200, tursoRows(['name'], [['alpha'], ['beta']]));
      return;
    }
    json(res, 400, { error: `unexpected SQL: ${sql}` });
  });

  await listen(server, port);
  return { server, port };
}

function tursoRows(cols: string[], rows: unknown[][]): Record<string, unknown> {
  return {
    results: [
      {
        type: 'ok',
        response: {
          type: 'execute',
          result: {
            cols: cols.map((name) => ({ name, decltype: null })),
            rows,
            affected_row_count: 0,
            last_insert_rowid: null,
          },
        },
      },
    ],
  };
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

async function readJsonArray(req: http.IncomingMessage): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('Redis REST shim expects a JSON string array command');
  }
  return parsed;
}

async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function runRedisCommand(container: string, command: string[]): Promise<unknown> {
  const output = await docker(['exec', container, 'redis-cli', '--raw', ...command]);
  const name = command[0]?.toUpperCase();
  if (name === 'SCAN') {
    const lines = output.split(/\r?\n/).filter(Boolean);
    return [lines[0] ?? '0', lines.slice(1)];
  }
  if (name === 'HGETALL') {
    const lines = output.split(/\r?\n/).filter(Boolean);
    const object: Record<string, string> = {};
    for (let index = 0; index < lines.length; index += 2) {
      object[lines[index]!] = lines[index + 1] ?? '';
    }
    return object;
  }
  if (name === 'LRANGE') {
    return output.split(/\r?\n/).filter(Boolean);
  }
  return output;
}

async function startNgrok(targetPort: number): Promise<{ process: ReturnType<typeof spawn>; url: string }> {
  const child = spawn('ngrok', [
    'http',
    `http://127.0.0.1:${targetPort}`,
    '--log=stdout',
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => process.stdout.write(`[ngrok] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[ngrok] ${chunk}`));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`ngrok exited early with code ${child.exitCode}`);
    }
    try {
      const response = await fetch('http://127.0.0.1:4040/api/tunnels');
      const payload = await response.json() as {
        tunnels?: Array<{ public_url?: string; config?: { addr?: string } }>;
      };
      const url = payload.tunnels
        ?.filter((tunnel) => tunnel.config?.addr === `http://127.0.0.1:${targetPort}`)
        .map((tunnel) => tunnel.public_url)
        .find((value): value is string => typeof value === 'string' && value.startsWith('https://'));
      if (url) {
        return { process: child, url };
      }
    } catch {
      // ngrok API is not ready yet.
    }
    await delay(500);
  }
  await stopProcessGroup(child);
  throw new Error('Timed out waiting for ngrok HTTPS tunnel');
}

function baseRecord(overrides: Partial<WorkspaceIntegrationRecord>): WorkspaceIntegrationRecord {
  return {
    id: 'local',
    integration_type: 'postgres',
    name: 'local',
    category: 'databases',
    auth_method: 'password',
    config: '{}',
    credentials_encrypted: '',
    created_by: 'local',
    created_at: Date.now(),
    updated_at: Date.now(),
    deleted_at: null,
    token_expires_at: null,
    auth_status: 'connected',
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

async function redisRecord(restUrl: string): Promise<WorkspaceIntegrationRecord> {
  return baseRecord({
    id: 'local_redis',
    integration_type: 'redis',
    name: 'local_redis',
    config: JSON.stringify({ rest_url: restUrl }),
    credentials_encrypted: await encryptCredentials({ rest_token: 'redis-token' }, SECRET),
  });
}

async function clickHouseRecord(endpoint: string): Promise<WorkspaceIntegrationRecord> {
  return baseRecord({
    id: 'local_clickhouse',
    integration_type: 'clickhouse',
    name: 'local_clickhouse',
    config: JSON.stringify({
      host: endpoint,
      port: 443,
      database: 'camel',
    }),
    credentials_encrypted: await encryptCredentials({ username: 'camel', password: 'camelpw' }, SECRET),
  });
}

async function mongoDbRecord(dataApiUrl: string): Promise<WorkspaceIntegrationRecord> {
  return baseRecord({
    id: 'local_mongodb',
    integration_type: 'mongodb',
    name: 'local_mongodb',
    config: JSON.stringify({
      data_api_url: dataApiUrl,
      data_source: 'Cluster0',
      database: 'camel',
    }),
    credentials_encrypted: await encryptCredentials({ data_api_key: 'mongo-token' }, SECRET),
  });
}

async function tursoRecord(databaseUrl: string): Promise<WorkspaceIntegrationRecord> {
  return baseRecord({
    id: 'local_turso',
    integration_type: 'turso',
    name: 'local_turso',
    config: JSON.stringify({ database_url: databaseUrl }),
    credentials_encrypted: await encryptCredentials({ api_key: 'turso-token' }, SECRET),
  });
}

function parseToolText(result: unknown): unknown {
  const text = (result as { content?: Array<{ type?: string; text?: string }> })?.content
    ?.find((part) => part.type === 'text')?.text;
  return typeof text === 'string' ? JSON.parse(text) : result;
}

async function verifyRedis(record: WorkspaceIntegrationRecord): Promise<void> {
  const env = { INTEGRATION_SECRET_KEY: SECRET };
  const tools = await redisMcpRpc(env, record, 'tools/list') as { tools?: Array<{ name?: string }> };
  if (!tools.tools?.some((tool) => tool.name === 'get_key')) {
    throw new Error('Redis did not expose get_key');
  }

  const value = parseToolText(await redisMcpRpc(env, record, 'tools/call', {
    name: 'get_key',
    arguments: { key: 'greeting' },
  }) as Record<string, unknown>) as { result?: string };
  if (value.result !== 'alpha') {
    throw new Error(`Redis get_key returned unexpected result: ${JSON.stringify(value)}`);
  }

  const type = parseToolText(await redisMcpRpc(env, record, 'tools/call', {
    name: 'get_key_type',
    arguments: { key: 'greeting' },
  }) as Record<string, unknown>) as { result?: string };
  if (type.result !== 'string') {
    throw new Error(`Redis get_key_type returned unexpected result: ${JSON.stringify(type)}`);
  }
}

async function verifyClickHouse(record: WorkspaceIntegrationRecord): Promise<void> {
  const env = { INTEGRATION_SECRET_KEY: SECRET };
  const ctx = { workspaceId: 'local-smoke' };
  const tools = await clickHouseMcpRpc(env, ctx, record, 'tools/list') as { tools?: Array<{ name?: string }> };
  if (!tools.tools?.some((tool) => tool.name === 'execute_sql_readonly')) {
    throw new Error('ClickHouse did not expose execute_sql_readonly');
  }

  const tables = parseToolText(await clickHouseMcpRpc(env, ctx, record, 'tools/call', {
    name: 'list_tables',
    arguments: {},
  }) as Record<string, unknown>) as { data?: Array<Record<string, unknown>> };
  if (!tables.data?.some((row) => row.name === 'widgets')) {
    throw new Error(`ClickHouse list_tables did not return widgets: ${JSON.stringify(tables)}`);
  }

  const result = parseToolText(await clickHouseMcpRpc(env, ctx, record, 'tools/call', {
    name: 'execute_sql_readonly',
    arguments: { query: 'select name from widgets order by id' },
  }) as Record<string, unknown>) as { data?: Array<Record<string, unknown>> };
  if (result.data?.[0]?.name !== 'alpha') {
    throw new Error(`ClickHouse readonly query returned unexpected rows: ${JSON.stringify(result)}`);
  }
}

async function verifyMongoDb(record: WorkspaceIntegrationRecord): Promise<void> {
  const env = { INTEGRATION_SECRET_KEY: SECRET };
  const tools = await mongoDbMcpRpc(env, record, 'tools/list') as { tools?: Array<{ name?: string }> };
  if (!tools.tools?.some((tool) => tool.name === 'find_documents')) {
    throw new Error('MongoDB did not expose find_documents');
  }

  const collections = parseToolText(await mongoDbMcpRpc(env, record, 'tools/call', {
    name: 'list_collections',
    arguments: {},
  }) as Record<string, unknown>) as { collections?: Array<{ name?: string }> };
  if (!collections.collections?.some((collection) => collection.name === 'widgets')) {
    throw new Error(`MongoDB list_collections did not return widgets: ${JSON.stringify(collections)}`);
  }

  const documents = parseToolText(await mongoDbMcpRpc(env, record, 'tools/call', {
    name: 'find_documents',
    arguments: { collection: 'widgets', filter: {}, limit: 2 },
  }) as Record<string, unknown>) as { documents?: Array<Record<string, unknown>> };
  if (documents.documents?.[0]?.name !== 'alpha') {
    throw new Error(`MongoDB find_documents returned unexpected rows: ${JSON.stringify(documents)}`);
  }
}

async function verifyTurso(record: WorkspaceIntegrationRecord): Promise<void> {
  const env = { INTEGRATION_SECRET_KEY: SECRET };
  const tools = await tursoMcpRpc(env, record, 'tools/list') as { tools?: Array<{ name?: string }> };
  if (!tools.tools?.some((tool) => tool.name === 'execute_sql_readonly')) {
    throw new Error('Turso did not expose execute_sql_readonly');
  }

  const tables = parseToolText(await tursoMcpRpc(env, record, 'tools/call', {
    name: 'list_tables',
    arguments: {},
  }) as Record<string, unknown>);
  if (!JSON.stringify(tables).includes('widgets')) {
    throw new Error(`Turso list_tables did not return widgets: ${JSON.stringify(tables)}`);
  }

  const result = parseToolText(await tursoMcpRpc(env, record, 'tools/call', {
    name: 'execute_sql_readonly',
    arguments: { query: 'select name from widgets order by rowid' },
  }) as Record<string, unknown>);
  if (!JSON.stringify(result).includes('alpha')) {
    throw new Error(`Turso readonly query returned unexpected rows: ${JSON.stringify(result)}`);
  }
}

async function withHttpsTunnel<T>(
  label: string,
  startServer: () => Promise<{ server: http.Server | null; port: number }>,
  run: (url: string) => Promise<T>
): Promise<T> {
  let server: http.Server | null = null;
  let ngrokProcess: ReturnType<typeof spawn> | null = null;
  try {
    const started = await startServer();
    server = started.server;
    const tunnel = await startNgrok(started.port);
    ngrokProcess = tunnel.process;
    console.log(`${label} exposed through ${tunnel.url}`);
    return await run(tunnel.url);
  } finally {
    if (ngrokProcess) {
      await stopProcessGroup(ngrokProcess);
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function main(): Promise<void> {
  await cleanupContainers();
  try {
    console.log('Starting local Redis and ClickHouse containers...');
    const [redis, clickhouse] = await Promise.all([
      startRedis(),
      startClickHouse(),
    ]);

    console.log('Verifying Redis MCP broker against Docker via ngrok HTTPS shim...');
    await withHttpsTunnel('Redis REST shim', () => startRedisRestShim(redis), async (url) => {
      await verifyRedis(await redisRecord(url));
    });
    console.log('Redis MCP smoke passed.');

    console.log('Verifying ClickHouse MCP broker against Docker via ngrok HTTPS tunnel...');
    await withHttpsTunnel('ClickHouse HTTP endpoint', async () => ({ server: null, port: clickhouse.port }), async (url) => {
      await verifyClickHouse(await clickHouseRecord(url));
    });
    console.log('ClickHouse MCP smoke passed.');

    console.log('Verifying MongoDB MCP broker against Atlas Data API-compatible ngrok HTTPS shim...');
    await withHttpsTunnel('MongoDB Data API shim', startMongoDataApiShim, async (url) => {
      await verifyMongoDb(await mongoDbRecord(url));
    });
    console.log('MongoDB MCP smoke passed.');

    console.log('Verifying Turso MCP broker against libSQL HTTP-compatible ngrok HTTPS shim...');
    await withHttpsTunnel('Turso HTTP shim', startTursoHttpShim, async (url) => {
      await verifyTurso(await tursoRecord(url));
    });
    console.log('Turso MCP smoke passed.');
  } finally {
    await cleanupContainers();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
