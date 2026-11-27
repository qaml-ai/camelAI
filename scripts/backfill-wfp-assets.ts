#!/usr/bin/env node
/**
 * Backfills `selfhost:assets:<dispatchScriptName>` in KV + `selfhost-assets/<app>/<hash>` in R2
 * for pre-July-2026 WfP apps that predate automatic R2/KV asset mirroring.
 *
 * Extracts every asset path referenced in the WfP worker's JS server bundle (React Router / Vite
 * manifest) + live HTML + recursive JS/CSS chunk imports, fetches each static asset from the
 * currently live WfP worker, hashes and uploads it to R2, and writes the canonical
 * `SelfhostAssetsRecord` manifest to `APP_KV`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/backfill-wfp-assets.ts --script ethio-chat--o2tecj
 *   node --experimental-strip-types scripts/backfill-wfp-assets.ts --apps-file /tmp/apps.txt
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  MIGRATION_SIG_HEADER,
  MIGRATION_TS_HEADER,
  signMigrationRequest,
} from '../workers/dispatcher/src/dynamic/migration-protocol.ts';

const ACCOUNT_ID = '85bbd288051330fb51ee1c86031a299b';
const PROD_KV_ID = '0ee80299e67c4c7fa0c1ad618b7e7a9c';
const R2_BUCKET = 'chiridion-sandbox';
const NAMESPACE = 'chiridion-platform';
const DISPATCHER_ORIGIN = 'https://custom-domains.camelai.app';

const STANDARD_STATIC_PATHS = [
  'favicon.svg',
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'android-chrome-192x192.png',
  'android-chrome-512x512.png',
  'site.webmanifest',
  'manifest.webmanifest',
  'manifest.json',
  'robots.txt',
  'og-image.png',
  'index.html',
];

let lastApiCallAt = 0;
async function fetchWithRetry(url: string, init: RequestInit = {}, maxAttempts = 5): Promise<Response> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isCfApi = url.startsWith('https://api.cloudflare.com/');
    if (isCfApi) {
      const now = Date.now();
      const waitMs = Math.max(0, lastApiCallAt + 280 - now);
      lastApiCallAt = now + waitMs;
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }
    const resp = await fetch(url, init);
    if (resp.status !== 429 && resp.status < 500) return resp;
    if (attempt === maxAttempts) return resp;
    const retryAfterSec = Number(resp.headers.get('retry-after') || '0');
    const backoffMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(60_000, retryAfterSec * 1000)
        : Math.min(20_000, 1500 * 2 ** (attempt - 1));
    await resp.text().catch(() => {});
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw new Error(`fetchWithRetry exhausted: ${url}`);
}

function normalizeRelPath(raw: string): string | null {
  const cleaned = raw.split('?')[0]!.split('#')[0]!.replace(/^\/+/, '').trim();
  if (!cleaned || cleaned.includes('..') || cleaned.startsWith('http://') || cleaned.startsWith('https://')) {
    return null;
  }
  if (!/\.[A-Za-z0-9]{1,12}$/.test(cleaned)) return null;
  return cleaned;
}

function extractAssetPaths(text: string, baseDir = ''): string[] {
  const found = new Set<string>();
  // Absolute asset paths like "/assets/entry.client-abc.js" or "/logo.png"
  for (const m of text.matchAll(/["'`(](\/(?:assets|images|img|fonts|icons|static|_assets)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})["'`)]/g)) {
    const p = normalizeRelPath(m[1]!);
    if (p) found.add(p);
  }
  // HTML href/src attributes
  for (const m of text.matchAll(/(?:href|src)=["'](\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})["']/g)) {
    const p = normalizeRelPath(m[1]!);
    if (p) found.add(p);
  }
  // Relative JS/CSS chunk imports inside /assets/*.js or /assets/*.css (e.g. "./chunk-abc.js" or "url(./font.woff2)")
  if (baseDir) {
    for (const m of text.matchAll(/["'`(](\.\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,12})["'`)]/g)) {
      const rel = m[1]!.slice(2);
      const p = normalizeRelPath(`${baseDir}/${rel}`);
      if (p) found.add(p);
    }
  }
  return [...found];
}

async function fetchFromWfpAsset(
  dispatchScriptName: string,
  assetPath: string,
  isPublic: boolean,
  migrationHmacSecret: string,
): Promise<Response | null> {
  const normalized = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
  if (!isPublic && migrationHmacSecret) {
    const ts = Date.now();
    const sig = await signMigrationRequest(
      migrationHmacSecret,
      `wfp-asset:${dispatchScriptName}:${normalized}`,
      ts,
    );
    const url = `${DISPATCHER_ORIGIN}/__chiridion_migrate/fetch-wfp-asset?script=${encodeURIComponent(dispatchScriptName)}&path=${encodeURIComponent(normalized)}`;
    return fetchWithRetry(url, {
      redirect: 'manual',
      headers: {
        [MIGRATION_TS_HEADER]: String(ts),
        [MIGRATION_SIG_HEADER]: sig,
      },
    }).catch(() => null);
  }
  const origin = `https://${dispatchScriptName}.camelai.app`;
  return fetchWithRetry(`${origin}${normalized}`, { redirect: 'manual' }).catch(() => null);
}

async function backfillApp(
  apiToken: string,
  dispatchScriptName: string,
  dryRun: boolean,
  migrationHmacSecret: string,
): Promise<Record<string, unknown>> {
  // Fast edge-native path: crawl WfP assets and write R2 + KV directly inside chiridion-dispatcher
  // (avoids Cloudflare Control Plane 1,200 req/5min rate limits and round-tripping assets over the internet).
  if (migrationHmacSecret) {
    // Optionally extract seed asset paths from the WfP server bundle for apps whose root `/` is auth-gated or redirects.
    let seedPaths: string[] = [];
    const contentResp = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${encodeURIComponent(dispatchScriptName)}/content`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    ).catch(() => null);
    if (contentResp?.ok) {
      seedPaths = extractAssetPaths(await contentResp.text());
    }
    const ts = Date.now();
    const sig = await signMigrationRequest(
      migrationHmacSecret,
      `backfill-assets:${dispatchScriptName}`,
      ts,
    );
    const resp = await fetchWithRetry(`${DISPATCHER_ORIGIN}/__chiridion_migrate/backfill-assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [MIGRATION_TS_HEADER]: String(ts),
        [MIGRATION_SIG_HEADER]: sig,
      },
      body: JSON.stringify({ script: dispatchScriptName, seedPaths, dryRun }),
    });
    if (!resp.ok) {
      throw new Error(`Edge backfill-assets failed (${resp.status}): ${await resp.text()}`);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  const kvKey = `selfhost:assets:${dispatchScriptName}`;
  const existing = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${PROD_KV_ID}/values/${encodeURIComponent(kvKey)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (existing.status === 200) {
    return { dispatchScriptName, status: 'skipped', reason: 'already_has_assets_mirror' };
  }

  // Check if app is public (private apps use HMAC-authenticated dispatcher direct WfP asset fetch)
  const regResp = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${PROD_KV_ID}/values/${encodeURIComponent(`script:${dispatchScriptName}`)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (regResp.status !== 200) {
    return { dispatchScriptName, status: 'skipped', reason: 'missing_kv_registry' };
  }
  const reg = (await regResp.json()) as { is_public?: boolean };
  const isPublic = Boolean(reg.is_public);
  if (!isPublic && !migrationHmacSecret) {
    return { dispatchScriptName, status: 'skipped', reason: 'private_app_cannot_crawl_assets' };
  }

  // Download WfP worker JS content to extract exact React Router / Vite asset manifest paths
  const contentResp = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/${encodeURIComponent(dispatchScriptName)}/content`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (!contentResp.ok) {
    return { dispatchScriptName, status: 'error', error: `GET content failed (${contentResp.status})` };
  }
  const contentText = await contentResp.text();

  const queue = new Set<string>([...STANDARD_STATIC_PATHS, ...extractAssetPaths(contentText)]);

  // Also inspect live HTML root for any additional asset tags
  const rootResp = await fetchFromWfpAsset(dispatchScriptName, '/', isPublic, migrationHmacSecret);
  if (rootResp && rootResp.status === 200) {
    const html = await rootResp.text();
    for (const p of extractAssetPaths(html)) queue.add(p);
  }

  const manifest: Record<string, { hash: string; size: number; contentType: string }> = {};
  const visited = new Set<string>();
  const pending = [...queue];

  while (pending.length > 0 && visited.size < 200) {
    const relPath = pending.shift()!;
    if (visited.has(relPath)) continue;
    visited.add(relPath);

    const resp = await fetchFromWfpAsset(dispatchScriptName, relPath, isPublic, migrationHmacSecret);
    if (!resp || resp.status !== 200) continue;
    const contentType = (resp.headers.get('content-type') || 'application/octet-stream').split(';')[0]!.trim();
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.byteLength === 0) continue;

    // Guard against SPA fallback returning index.html for missing non-HTML paths
    if (!relPath.endsWith('.html') && contentType === 'text/html') continue;

    // Recursively discover imported JS/CSS sub-chunks
    if (
      (contentType.includes('javascript') || contentType === 'text/css' || relPath.endsWith('.js') || relPath.endsWith('.css')) &&
      bytes.byteLength < 5 * 1024 * 1024
    ) {
      const text = new TextDecoder().decode(bytes);
      const slash = relPath.lastIndexOf('/');
      const baseDir = slash >= 0 ? relPath.slice(0, slash) : '';
      for (const nextPath of extractAssetPaths(text, baseDir)) {
        if (!visited.has(nextPath)) pending.push(nextPath);
      }
    }

    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!dryRun) {
      const r2Key = `selfhost-assets/${dispatchScriptName}/${hash}`;
      const put = await fetchWithRetry(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(r2Key)}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': contentType },
          body: bytes,
        },
      );
      if (!put.ok) {
        throw new Error(`R2 PUT ${r2Key} failed (${put.status})`);
      }
    }
    manifest[relPath] = { hash, size: bytes.byteLength, contentType };
  }

  const assetCount = Object.keys(manifest).length;
  if (assetCount === 0) {
    return { dispatchScriptName, status: 'skipped', reason: 'no_static_assets_discovered' };
  }

  if (!dryRun) {
    const record = {
      schemaVersion: 1,
      appId: dispatchScriptName,
      createdAt: new Date().toISOString(),
      manifest,
    };
    const kvPut = await fetchWithRetry(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${PROD_KV_ID}/values/${encodeURIComponent(kvKey)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain; charset=utf-8' },
        body: JSON.stringify(record),
      },
    );
    if (!kvPut.ok) {
      throw new Error(`KV PUT ${kvKey} failed (${kvPut.status})`);
    }
  }

  return {
    dispatchScriptName,
    status: dryRun ? 'dry_run_ready' : 'backfilled',
    assetCount,
    samplePaths: Object.keys(manifest).slice(0, 8),
  };
}

async function main() {
  const args = process.argv.slice(2);
  let script = '';
  let appsFile = '';
  let dryRun = false;
  let concurrency = 1;
  let logFile = '';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--script' && args[i + 1]) script = args[++i]!;
    else if (args[i] === '--apps-file' && args[i + 1]) appsFile = args[++i]!;
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--concurrency' && args[i + 1]) concurrency = Math.max(1, Math.min(8, Number(args[++i]!) || 1));
    else if (args[i] === '--log-file' && args[i + 1]) logFile = args[++i]!;
  }
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  const migrationHmacSecret = process.env.MIGRATION_HMAC_SECRET || process.env.TOKEN_SIGNING_SECRET || '';
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required');

  const targets = script
    ? [script]
    : appsFile
      ? fs.readFileSync(appsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      : [];
  if (targets.length === 0) {
    console.error('Usage: --script <name> | --apps-file <path> [--dry-run] [--concurrency N] [--log-file <path>]');
    process.exit(1);
  }

  let nextIdx = 0;
  const runWorker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= targets.length) return;
      const app = targets[idx]!;
      try {
        const res = await backfillApp(apiToken, app, dryRun, migrationHmacSecret);
        const line = JSON.stringify(res);
        console.log(line);
        if (logFile) fs.appendFileSync(logFile, `${line}\n`);
      } catch (err) {
        const line = JSON.stringify({ dispatchScriptName: app, status: 'error', error: String(err) });
        console.error(line);
        if (logFile) fs.appendFileSync(logFile, `${line}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: script ? 1 : concurrency }, () => runWorker()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
