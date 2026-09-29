#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { startSelfhostLoopbackServer } from './selfhost-loopback-server.mjs';
import { driveRuntimeSweep, waitForApp } from './selfhost-runtime-sweep.mjs';

const repoRoot = process.cwd();
const configPath = path.resolve(
  repoRoot,
  process.env.SELFHOST_WORKERD_CONFIG ?? '.selfhost/workerd/camelai.capnp',
);
const manifestPath = path.join(path.dirname(configPath), 'manifest.json');
const workerdPath = path.resolve(repoRoot, 'node_modules/workerd/bin/workerd');

if (!fs.existsSync(configPath)) {
  console.error(`Missing generated workerd config: ${path.relative(repoRoot, configPath)}`);
  console.error('Run `bun run selfhost:workerd:build` first.');
  process.exit(1);
}

if (!fs.existsSync(workerdPath)) {
  console.error('Missing workerd binary. Run `bun install` first.');
  process.exit(1);
}

if (process.env.SELFHOST_SKIP_D1_MIGRATIONS !== '1') {
  const result = spawnSync(process.execPath, ['scripts/selfhost-d1-migrate.mjs'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

let loopbackServer;
try {
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : null;
  if (manifest?.loopback?.mode === 'external') {
    loopbackServer = await startSelfhostLoopbackServer({
      hostname: manifest.loopback.hostname ?? '127.0.0.1',
    });
    console.log(
      `[selfhost:workerd] Local bindings loopback on http://${loopbackServer.hostname}:${loopbackServer.port}`,
    );
  }

  const args = ['serve', configPath, 'camelai', '--experimental'];
  if (process.env.SELFHOST_WORKERD_SOCKET) {
    args.push(`--socket-addr=http=${process.env.SELFHOST_WORKERD_SOCKET}`);
  }
  if (loopbackServer) {
    args.push(`--external-addr=loopback=${loopbackServer.hostname}:${loopbackServer.port}`);
  }

  const child = spawn(workerdPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Move threads still on the in-app loop to the agent runtime, in the
  // background (SELF_HOSTING.md, "Moving existing threads").
  const sweep = new AbortController();
  if (process.env.SELFHOST_RUNTIME_SWEEP !== '0' && process.env.ADMIN_API_KEY) {
    const baseUrl = appLoopbackUrl(process.env.SELFHOST_WORKERD_SOCKET);
    (async () => {
      if (!await waitForApp({ baseUrl, signal: sweep.signal })) return;
      await driveRuntimeSweep({ baseUrl, adminKey: process.env.ADMIN_API_KEY, signal: sweep.signal });
    })().catch((error) => {
      console.error('[selfhost:runtime-sweep] stopped', error);
    });
  }

  const shutdown = async (signal) => {
    sweep.abort();
    if (!child.killed) child.kill(signal);
    if (loopbackServer) {
      await loopbackServer.close().catch((error) => {
        console.error('[selfhost:workerd] Failed to close local bindings loopback', error);
      });
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  child.on('exit', async (code, signal) => {
    if (loopbackServer) {
      await loopbackServer.close().catch(() => {});
    }
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} catch (error) {
  if (loopbackServer) {
    await loopbackServer.close().catch(() => {});
  }
  console.error(error);
  process.exit(1);
}

function appLoopbackUrl(socket) {
  const match = /^(.*):(\d+)$/.exec(String(socket ?? '').trim());
  const [host, port] = match ? [match[1], match[2]] : ['127.0.0.1', '3001'];
  const loopback = !host || host === '*' || host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return `http://${loopback.includes(':') && !loopback.startsWith('[') ? `[${loopback}]` : loopback}:${port}`;
}
