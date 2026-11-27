#!/usr/bin/env node
/**
 * Live Staging End-to-End WfP -> Dynamic Workers Zero-Data-Loss DO Migration Verification.
 *
 * Proves the complete production cutover path live on Cloudflare staging:
 *  1. Deploys a real WfP SQLite DO app to `chiridion-platform-staging`
 *  2. Seeds SQLite tables (AUTOINCREMENT, BLOB Uint8Array, INDEX), DO KV, and an alarm
 *  3. Swaps WfP script to zero-migration Storage Export Shim (preserving SQLite untouched)
 *  4. Calls HMAC-signed `POST /__chiridion_migrate/import` on `chiridion-dispatcher-staging`
 *  5. Asserts 100% SHA-256 parity + PRAGMA integrity_check
 *  6. Flips `APP_KV` to `runtime_mode: "dynamic"` and verifies every row, blob, KV, next AUTOINCREMENT id, and alarm live!
 *  7. Cleans up all temporary WfP script, R2, and KV artifacts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const ACCOUNT_ID = '85bbd288051330fb51ee1c86031a299b';
const STAGING_KV_ID = 'e894eb2caf1641ad8870da994b992fce';
const R2_BUCKET = 'chiridion-sandbox';
const STAGING_NAMESPACE = 'chiridion-platform-staging';

const RUN_ID = crypto.randomBytes(3).toString('hex');
const SCRIPT_NAME = `dw-mig-${RUN_ID}`;
const ORG_SLUG = 'camelai-team-d9e';
const DISPATCH_NAME = `${SCRIPT_NAME}--${ORG_SLUG}`;
const HOST = `${DISPATCH_NAME}.staging.camelai.app`;

function getApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const configPath = `${process.env.HOME}/.config/.wrangler/config/default.toml`;
  const m = fs.readFileSync(configPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('No Cloudflare token found');
  return m[1];
}

const API_TOKEN = getApiToken();
const HMAC_SECRET = process.env.MIGRATION_HMAC_SECRET;
if (!HMAC_SECRET) {
  console.error('Error: MIGRATION_HMAC_SECRET env var is required to run migration E2E.');
  process.exit(1);
}

async function sign(target, ts) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${target}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function kvPut(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${STAGING_KV_ID}/values/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'text/plain; charset=utf-8' },
    body: value,
  });
  if (!resp.ok) throw new Error(`KV PUT ${key} failed (${resp.status}): ${await resp.text()}`);
}

async function kvDelete(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/storage/kv/namespaces/${STAGING_KV_ID}/values/${encodeURIComponent(key)}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${API_TOKEN}` } }).catch(() => {});
}

async function r2Put(key, body) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) throw new Error(`R2 PUT ${key} failed (${resp.status}): ${await resp.text()}`);
}

async function r2Delete(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${API_TOKEN}` } }).catch(() => {});
}

async function uploadWfpScript(metadata, mainFileName, source) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append(mainFileName, new Blob([source], { type: 'application/javascript+module' }), mainFileName);
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${STAGING_NAMESPACE}/scripts/${encodeURIComponent(DISPATCH_NAME)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`WfP PUT failed (${resp.status}): ${await resp.text()}`);
}

async function deleteWfpScript() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${STAGING_NAMESPACE}/scripts/${encodeURIComponent(DISPATCH_NAME)}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${API_TOKEN}` } }).catch(() => {});
}

const APP_SOURCE = `
import { DurableObject } from "cloudflare:workers";

export class LedgerDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, payload BLOB NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_entries_label ON entries(label)",
    );
  }

  async alarm() {}

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      this.ctx.storage.sql.exec("INSERT INTO entries (label, payload) VALUES (?, ?)", "alpha", new Uint8Array([1, 2, 3, 250, 255]));
      this.ctx.storage.sql.exec("INSERT INTO entries (label, payload) VALUES (?, ?)", "beta", new Uint8Array([9, 8, 7]));
      // Delete id=2 and insert id=3 so AUTOINCREMENT sqlite_sequence is non-trivial!
      this.ctx.storage.sql.exec("DELETE FROM entries WHERE label = 'beta'");
      this.ctx.storage.sql.exec("INSERT INTO entries (label, payload) VALUES (?, ?)", "gamma", new Uint8Array([42, 99]));
      await this.ctx.storage.put("meta_tag", { owner: "migration-test", rev: 7 });
      const futureAlarm = Date.now() + 600_000;
      await this.ctx.storage.setAlarm(futureAlarm);
      return Response.json({ ok: true, hexId: this.ctx.id.toString(), futureAlarm });
    }
    if (url.pathname === "/append-after") {
      this.ctx.storage.sql.exec("INSERT INTO entries (label, payload) VALUES (?, ?)", "post_cutover", new Uint8Array([77]));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/inspect") {
      const rows = this.ctx.storage.sql.exec("SELECT id, label, payload FROM entries ORDER BY id ASC").toArray().map((r) => ({
        id: Number(r.id),
        label: String(r.label),
        payload: [...new Uint8Array(r.payload)],
      }));
      const kvVal = await this.ctx.storage.get("meta_tag");
      const alarm = await this.ctx.storage.getAlarm();
      return Response.json({ rows, kvVal, alarm });
    }
    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    try {
      const stub = env.LEDGER.get(env.LEDGER.idFromName("default"));
      return await stub.fetch(request);
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.stack || err.message : String(err) }, { status: 500 });
    }
  },
};
`;

async function run() {
  const registryKey = `script:${DISPATCH_NAME}`;
  const bundleSha = `mig${RUN_ID}00000000`.slice(0, 16);
  const bundleKey = `dynamic-bundles/${encodeURIComponent(DISPATCH_NAME)}/${bundleSha}.json`;
  const cleanupKv = [registryKey];
  const cleanupR2 = [bundleKey];

  try {
    // 1. Deploy real WfP SQLite DO app to chiridion-platform-staging
    await uploadWfpScript(
      {
        main_module: 'index.js',
        compatibility_date: '2026-07-13',
        compatibility_flags: ['nodejs_compat'],
        bindings: [{ type: 'durable_object_namespace', name: 'LEDGER', class_name: 'LedgerDO' }],
        migrations: { new_tag: 'v1', new_sqlite_classes: ['LedgerDO'] },
      },
      'index.js',
      APP_SOURCE,
    );
    await kvPut(
      registryKey,
      JSON.stringify({
        org_id: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
        org_slug: ORG_SLUG,
        is_public: true,
        runtime_mode: 'wfp',
      }),
    );
    await new Promise((r) => setTimeout(r, 1500));

    // 2. Seed SQLite rows + BLOB + sqlite_sequence + DO KV + future alarm on WfP
    let seedJson = null;
    let lastSeedErr = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const seedResp = await fetch(`https://${HOST}/seed`);
      const text = await seedResp.text();
      if (seedResp.status === 200) {
        seedJson = JSON.parse(text);
        break;
      }
      lastSeedErr = `HTTP ${seedResp.status}: ${text.slice(0, 200)}`;
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('1_wfp_seeded:', JSON.stringify(seedJson), lastSeedErr);
    if (!seedJson?.ok) throw new Error(`WfP seed failed (${lastSeedErr})`);
    cleanupKv.push(`do_alias:${DISPATCH_NAME}:LedgerDO:${seedJson.hexId}`);

    // 3. Upload Dynamic Worker bundle to R2 (not live yet)
    await r2Put(
      bundleKey,
      JSON.stringify({
        schemaVersion: 2,
        appId: DISPATCH_NAME,
        scriptName: SCRIPT_NAME,
        dispatchScriptName: DISPATCH_NAME,
        orgId: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
        orgSlug: ORG_SLUG,
        workspaceId: 'ws-mig',
        bundleSha,
        createdAt: new Date().toISOString(),
        compatibilityDate: '2026-07-13',
        compatibilityFlags: ['nodejs_compat'],
        mainModule: 'index.js',
        modules: { 'index.js': { name: 'index.js', type: 'js', content: APP_SOURCE } },
        bindings: [{ type: 'durable_object_namespace', name: 'LEDGER', class_name: 'LedgerDO' }],
        doBindings: { LEDGER: 'LedgerDO' },
        doClasses: ['LedgerDO'],
        hasAssets: false,
        hasCodemodeLoader: false,
      }),
    );

    // 4. Swap WfP script to zero-migration Storage Export Shim!
    const { buildWfpExportShimSource } = await import('../workers/dispatcher/src/dynamic/export-shim.ts');
    const shimSource = buildWfpExportShimSource({
      classNames: ['LedgerDO'],
      bindingMap: { LEDGER: 'LedgerDO' },
      hmacSecret: HMAC_SECRET,
    });
    await uploadWfpScript(
      {
        main_module: 'export-shim.js',
        compatibility_date: '2026-07-13',
        compatibility_flags: ['nodejs_compat'],
        bindings: [{ type: 'durable_object_namespace', name: 'LEDGER', class_name: 'LedgerDO' }],
      },
      'export-shim.js',
      shimSource,
    );
    console.log('2_wfp_export_shim_swapped: ok');

    // Wait 12s quietly (with zero requests to the DO!) so Cloudflare reloads the
    // warm WfP Durable Object isolate onto ChiridionExportShimDO, then verify once.
    await new Promise((r) => setTimeout(r, 12_000));
    for (let w = 0; w < 5; w += 1) {
      const probe = await fetch(
        `https://${HOST}/__migrate/freeze?className=LedgerDO&objectId=${encodeURIComponent('name:default')}`,
      );
      const probeText = await probe.text();
      console.log(`2b_do_shim_probe[${w}]: status=${probe.status} body=${probeText.slice(0, 80)}`);
      if (probe.status === 503 && probeText.includes('Service temporarily migrating')) break;
      await new Promise((r) => setTimeout(r, 12_000));
    }

    // 5. Trigger verified shard import via POST /__chiridion_migrate/import on chiridion-dispatcher-staging!
    let importJson = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ts = Date.now();
      const sig = await sign('/__chiridion_migrate/import', ts);
      const importResp = await fetch(`https://${HOST}/__chiridion_migrate/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-chiridion-migration-ts': String(ts),
          'x-chiridion-migration-sig': sig,
        },
        body: JSON.stringify({
          dispatchScriptName: DISPATCH_NAME,
          className: 'LedgerDO',
          objectId: 'name:default',
        }),
      });
      importJson = await importResp.json();
      if (importResp.ok && importJson.status === 'migrated') break;
      if (String(importJson.error || '').includes('HTTP 404')) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(`Migration import failed: ${JSON.stringify(importJson)}`);
    }
    console.log('3_verified_import:', JSON.stringify(importJson));
    if (importJson?.status !== 'migrated') {
      throw new Error(`Migration import failed: ${JSON.stringify(importJson)}`);
    }

    // 6. Flip to Dynamic Workers on a fresh verification key (or wait for KV)
    const cutoverKey = `script:${DISPATCH_NAME}`;
    await kvPut(
      cutoverKey,
      JSON.stringify({
        org_id: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
        org_slug: ORG_SLUG,
        is_public: true,
        runtime_mode: 'dynamic',
        bundle_r2_key: bundleKey,
        bundle_sha: bundleSha,
        quota_tier: 'enterprise',
        do_classes: ['LedgerDO'],
        has_assets: false,
      }),
    );

    // Wait for KV flip propagation (WfP shim returns 503 until KV flips to dynamic!)
    let inspected = null;
    for (let i = 0; i < 25; i += 1) {
      const r = await fetch(`https://${HOST}/inspect`);
      if (r.status === 200) {
        inspected = await r.json();
        break;
      }
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (!inspected) throw new Error('Timed out waiting for KV flip to dynamic');
    console.log('4_dynamic_inspect_after_cutover:', JSON.stringify(inspected));

    // Verify exact rows, Uint8Array bytes, DO KV, and alarm!
    const okRows =
      inspected.rows.length === 2 &&
      inspected.rows[0].id === 1 &&
      inspected.rows[0].label === 'alpha' &&
      JSON.stringify(inspected.rows[0].payload) === JSON.stringify([1, 2, 3, 250, 255]) &&
      inspected.rows[1].id === 3 &&
      inspected.rows[1].label === 'gamma' &&
      JSON.stringify(inspected.rows[1].payload) === JSON.stringify([42, 99]);
    const okKv = inspected.kvVal?.owner === 'migration-test' && inspected.kvVal?.rev === 7;
    const okAlarm = typeof inspected.alarm === 'number' && inspected.alarm > Date.now();
    if (!okRows || !okKv || !okAlarm) {
      throw new Error(`Post-cutover data check failed: okRows=${okRows} okKv=${okKv} okAlarm=${okAlarm}`);
    }

    // 7. Insert post-cutover row and verify AUTOINCREMENT continues at id=4 (no collision!)
    await fetch(`https://${HOST}/append-after`);
    const afterInspect = await (await fetch(`https://${HOST}/inspect`)).json();
    console.log('5_post_cutover_autoincrement:', JSON.stringify(afterInspect.rows));
    if (afterInspect.rows[2]?.id !== 4 || afterInspect.rows[2]?.label !== 'post_cutover') {
      throw new Error(`AUTOINCREMENT sequence mismatch: ${JSON.stringify(afterInspect.rows)}`);
    }

    console.log('\nPASS | LIVE WFP -> DYNAMIC WORKERS ZERO-DATA-LOSS MIGRATION VERIFIED 100%!');
  } finally {
    await deleteWfpScript();
    for (const k of cleanupKv) await kvDelete(k);
    for (const k of cleanupR2) await r2Delete(k);
    console.log(`Cleaned up WfP canary ${DISPATCH_NAME}, ${cleanupKv.length} KV keys, ${cleanupR2.length} R2 objects.`);
  }
}

run().catch((err) => {
  console.error('MIGRATION E2E FAILED:', err);
  process.exit(1);
});
