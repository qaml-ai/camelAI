#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { runtimeMigrationGate } from './selfhost-runtime-gate.mjs';

const repoRoot = process.cwd();
const stateDir = path.resolve(repoRoot, process.env.SELFHOST_WORKERD_STATE_DIR ?? '.selfhost/workerd/state');
const migrationsDir = path.resolve(repoRoot, process.env.SELFHOST_D1_MIGRATIONS_DIR ?? 'migrations');
const workerdPath = path.resolve(repoRoot, 'node_modules/workerd/bin/workerd');
const miniflareWorkersDir = path.join(repoRoot, 'node_modules/miniflare/dist/src/workers');

function q(value) {
  return JSON.stringify(String(value));
}

function relFrom(dir, filePath) {
  return path.relative(dir, filePath).replaceAll(path.sep, '/');
}

function moduleFile(outDir, name, filePath) {
  return `(name = ${q(name)}, esModule = embed ${q(relFrom(outDir, filePath))})`;
}

function moduleSource(name, source) {
  return `(name = ${q(name)}, esModule = ${q(source)})`;
}

function bindingText(name, value) {
  return `(name = ${q(name)}, text = ${q(value)})`;
}

function bindingJson(name, value) {
  return `(name = ${q(name)}, json = ${q(JSON.stringify(value))})`;
}

function bindingService(name, serviceName) {
  return `(name = ${q(name)}, service = (name = ${q(serviceName)}))`;
}

function bindingD1(name, serviceName) {
  return `(name = ${q(name)}, wrapped = (` +
    `moduleName = "cloudflare-internal:d1-api", ` +
    `innerBindings = [(name = "fetcher", service = (name = ${q(serviceName)}))]` +
  `))`;
}

function serviceDisk(name, diskPath) {
  return `(name = ${q(name)}, disk = (path = ${q(diskPath)}, writable = true))`;
}

function miniflareSupportModules(outDir) {
  return [
    moduleFile(outDir, 'miniflare:shared', path.join(miniflareWorkersDir, 'shared/index.worker.js')),
    moduleFile(outDir, 'miniflare:zod', path.join(miniflareWorkersDir, 'shared/zod.worker.js')),
    moduleSource('node-internal:internal_assert', 'import assert from "node:assert"; export default assert; export * from "node:assert";'),
    moduleSource('node-internal:internal_buffer', 'export { Buffer } from "node:buffer";'),
  ];
}

function serviceObjectEntry(outDir, serviceName, objectServiceName, className, namespace) {
  return `(name = ${q(serviceName)}, worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `modules = [${moduleFile(outDir, 'object-entry.worker.js', path.join(miniflareWorkersDir, 'shared/object-entry.worker.js'))}], ` +
    `bindings = [` +
      bindingText('MINIFLARE_NAMESPACE', namespace) + ', ' +
      `(name = "MINIFLARE_OBJECT", durableObjectNamespace = (` +
        `className = ${q(className)}, serviceName = ${q(objectServiceName)}` +
      `))` +
    `]` +
  `))`;
}

function serviceD1Storage(outDir, storageServiceName) {
  return `(name = "d1:db", worker = (` +
    `compatibilityDate = "2023-07-24", ` +
    `compatibilityFlags = ["nodejs_compat", "experimental"], ` +
    `modules = [` +
      [
        moduleFile(outDir, 'database.worker.js', path.join(miniflareWorkersDir, 'd1/database.worker.js')),
        ...miniflareSupportModules(outDir),
      ].join(', ') +
    `], ` +
    `durableObjectNamespaces = [(` +
      `className = "D1DatabaseObject", uniqueKey = "miniflare-D1DatabaseObject", enableSql = true` +
    `)], ` +
    `durableObjectStorage = (localDisk = ${q(storageServiceName)}), ` +
    `bindings = [` +
      [
        bindingService('MINIFLARE_BLOBS', storageServiceName),
        bindingService('MINIFLARE_LOOPBACK', 'loopback'),
      ].join(', ') +
    `]` +
  `))`;
}

async function readMigrations() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(files.map(async (name) => ({
    name,
    sql: await fs.readFile(path.join(migrationsDir, name), 'utf8'),
  })));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function migratorWorkerSource() {
  return `
function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    current += char;

    if (lineComment) {
      if (char === "\\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if ((quote === "'" || quote === '"') && next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (char === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "\`") {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

export default {
  async fetch(_request, env) {
    const migrations = env.MIGRATIONS;
    await env.APP_DB.exec("CREATE TABLE IF NOT EXISTS selfhost_d1_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const applied = [];
    const skipped = [];
    for (const migration of migrations) {
      const existing = await env.APP_DB.prepare("SELECT name FROM selfhost_d1_migrations WHERE name = ?").bind(migration.name).first();
      if (existing) {
        skipped.push(migration.name);
        continue;
      }
      for (const statement of splitSqlStatements(migration.sql)) {
        await env.APP_DB.prepare(statement).run();
      }
      await env.APP_DB.prepare("INSERT INTO selfhost_d1_migrations (name, applied_at) VALUES (?, ?)").bind(migration.name, Date.now()).run();
      applied.push(migration.name);
    }
    // What the runtime migration gate reads (selfhost-runtime-gate.mjs): the
    // thread sweep's record and whether this install has any org.
    const hasTable = async (name) => Boolean(await env.APP_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first());
    const sweepRow = await hasTable("app_index_metadata")
      ? await env.APP_DB.prepare("SELECT value FROM app_index_metadata WHERE key = 'selfhost_runtime_sweep'").first()
      : null;
    let runtimeSweep = null;
    try { runtimeSweep = sweepRow ? JSON.parse(sweepRow.value) : null; } catch {}
    const orgCount = await hasTable("orgs")
      ? Number((await env.APP_DB.prepare("SELECT COUNT(*) AS count FROM orgs").first())?.count ?? 0)
      : 0;
    return Response.json({ applied, skipped, runtimeSweep, orgCount });
  }
};
`;
}

async function generateConfig({ outDir, configPath, port, migrations }) {
  await fs.mkdir(path.join(stateDir, 'd1'), { recursive: true });
  const d1Storage = path.join(stateDir, 'd1');
  const config = `using Workerd = import "/workerd/workerd.capnp";

const d1migrate :Workerd.Config = (
  services = [
    (name = "migrator", worker = (
      compatibilityDate = "2025-12-01",
      compatibilityFlags = ["nodejs_compat"],
      modules = [${moduleSource('migrator.worker.js', migratorWorkerSource())}],
      bindings = [
        ${bindingD1('APP_DB', 'd1:db:selfhost-app-db')},
        ${bindingJson('MIGRATIONS', migrations)}
      ]
    )),
    ${serviceObjectEntry(outDir, 'd1:db:selfhost-app-db', 'd1:db', 'D1DatabaseObject', 'selfhost-app-db')},
    ${serviceDisk('d1:storage', d1Storage)},
    ${serviceD1Storage(outDir, 'd1:storage')},
    (name = "loopback", network = (allow = ["local"], tlsOptions = (trustBrowserCas = true)))
  ],
  sockets = [
    (name = "http", address = ${q(`127.0.0.1:${port}`)}, http = (), service = "migrator")
  ]
);
`;
  await fs.writeFile(configPath, config);
}

function spawnWorkerd(configPath) {
  return spawn(workerdPath, ['serve', configPath, 'd1migrate', '--experimental'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function shutdownChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function workerOutput(stderr, stdout) {
  return Buffer.concat([...stdout, ...stderr]).toString('utf8').trim();
}

async function waitForMigrator(port, child) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`D1 migrator workerd exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return response.json();
      throw new Error(`D1 migrator returned HTTP ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
      if (error.message?.startsWith('D1 migrator returned HTTP')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error('Timed out waiting for D1 migrator');
}

async function main() {
  const migrations = await readMigrations();
  if (migrations.length === 0) {
    console.log('[selfhost:d1] No migrations found.');
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camelai-selfhost-d1-'));
  const configPath = path.join(tempDir, 'd1-migrate.capnp');
  const port = await freePort();
  await generateConfig({ outDir: tempDir, configPath, port, migrations });

  let gate = { ok: true, message: null };
  const child = spawnWorkerd(configPath);
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  try {
    const result = await waitForMigrator(port, child);
    console.log(`[selfhost:d1] Applied ${result.applied.length}, skipped ${result.skipped.length}.`);
    for (const name of result.applied) console.log(`[selfhost:d1] applied ${name}`);
    gate = runtimeMigrationGate({
      sweep: result.runtimeSweep,
      orgCount: result.orgCount,
      allowUnmigrated: process.env.SELFHOST_ALLOW_UNMIGRATED_THREADS === '1',
    });
  } catch (error) {
    const output = workerOutput(stderr, stdout);
    if (output) {
      error.message += `\n\nworkerd output:\n${output}`;
    }
    throw error;
  } finally {
    await shutdownChild(child);
    const text = workerOutput(stderr, stdout);
    if (text && process.env.SELFHOST_D1_MIGRATE_VERBOSE === '1') {
      console.error(text);
    }
  }
  if (!gate.ok) {
    console.error(`[selfhost:runtime-gate] ${gate.message}`);
    process.exit(3);
  }
  if (gate.message) console.warn(`[selfhost:runtime-gate] ${gate.message}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
