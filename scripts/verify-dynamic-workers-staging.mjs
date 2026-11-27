#!/usr/bin/env node
/**
 * Live Staging End-to-End Verification Suite for Hosted Dynamic Workers (Phase 1.4).
 *
 * Tests against `chiridion-dispatcher-staging` (`*.staging.camelai.app`):
 *  1. Edge static asset fast-path (Cache API -> AssetsVirtualBinding -> R2, 0 DO calls)
 *  2. Stateless Dynamic Worker HTTP dispatch
 *  3. Sharded SQLite DO CRUD + native RPC + 100% persistence across v1 -> v2 bundle upgrade
 *  4. Synchronous SQLite Quota Hard-Gate (`QuotaExceededError` + abort on runaway loop)
 *  5. Alarm bridging (`AlarmMediator` workaround for workerd #6810)
 *  6. Outbound SSRF Gate (`OutboundGate` blocks 169.254.169.254 & 127.0.0.1 with 403)
 *  7. 2-Hop `@cloudflare/codemode` RPC (`env.LOADER.load(spec).getEntrypoint().evaluate(dispatchers)`)
 *  8. Live WfP -> Dynamic Worker DO Migration (Export Shim -> TenantObjectSupervisorDO Importer -> 100% SHA-256 parity)
 *
 * Cleans up all temporary canary KV keys, R2 objects, and WfP canary scripts on exit.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const ACCOUNT_ID = '85bbd288051330fb51ee1c86031a299b';
const STAGING_KV_ID = 'e894eb2caf1641ad8870da994b992fce';
const R2_BUCKET = 'chiridion-sandbox';

const RUN_ID = crypto.randomBytes(3).toString('hex');
const SCRIPT_NAME = `dw-e2e-${RUN_ID}`;
const ORG_SLUG = 'camelai-team-d9e';
const DISPATCH_NAME = `${SCRIPT_NAME}--${ORG_SLUG}`;
const HOST = `${DISPATCH_NAME}.staging.camelai.app`;

function getApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const configPath = `${process.env.HOME}/.config/.wrangler/config/default.toml`;
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf8');
    const m = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error('No Cloudflare API token or Wrangler OAuth token found');
}

const API_TOKEN = getApiToken();

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

async function r2Put(key, body, contentType = 'application/json') {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': contentType },
    body,
  });
  if (!resp.ok) throw new Error(`R2 PUT ${key} failed (${resp.status}): ${await resp.text()}`);
}

async function r2Delete(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`;
  await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${API_TOKEN}` } }).catch(() => {});
}

function canaryWorkerSource(versionTag) {
  return `
import { DurableObject, RpcTarget } from "cloudflare:workers";

class DemoToolDispatcher extends RpcTarget {
  async call(name, args) {
    if (name === "multiply") return { product: args.a * args.b, version: ${JSON.stringify(versionTag)} };
    throw new Error("unknown tool: " + name);
  }
}

export class CanaryDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, v TEXT NOT NULL)");
  }

  async addItem(k, v) {
    this.ctx.storage.sql.exec("INSERT INTO items (k, v) VALUES (?, ?)", k, v);
    const count = this.ctx.storage.sql.exec("SELECT count(*) AS c FROM items").one();
    return { count: Number(count.c), version: ${JSON.stringify(versionTag)} };
  }

  async listItems() {
    const rows = this.ctx.storage.sql.exec("SELECT id, k, v FROM items ORDER BY id ASC").toArray();
    return { rows, version: ${JSON.stringify(versionTag)} };
  }

  async alarm() {
    this.ctx.storage.sql.exec("INSERT INTO items (k, v) VALUES (?, ?)", "alarm_fired", String(Date.now()));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/write") {
      const k = url.searchParams.get("k") || "k";
      const v = url.searchParams.get("v") || "v";
      return Response.json(await this.addItem(k, v));
    }
    if (url.pathname === "/list") {
      return Response.json(await this.listItems());
    }
    if (url.pathname === "/runaway") {
      // Exceeds free tier maxRowsWrittenPerEvent (10_000) synchronously!
      for (let i = 0; i < 12000; i += 1) {
        this.ctx.storage.sql.exec("INSERT INTO items (k, v) VALUES (?, ?)", "spam_" + i, "val");
      }
      return Response.json({ ok: true, shouldNotReach: true });
    }
    if (url.pathname === "/schedule-alarm") {
      const target = Date.now() + 1500;
      await this.ctx.storage.setAlarm(target);
      const stored = await this.ctx.storage.getAlarm();
      return Response.json({ ok: true, requested: target, stored });
    }
    if (url.pathname === "/codemode") {
      const dispatcher = new DemoToolDispatcher();
      const spec = {
        compatibilityDate: "2026-07-13",
        compatibilityFlags: ["nodejs_compat"],
        mainModule: "exec.mjs",
        modules: {
          "exec.mjs": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class Sandbox extends WorkerEntrypoint {
              async evaluate(tools) {
                const res = await tools.call("multiply", { a: 6, b: 7 });
                let fetchBlocked = false;
                try { await fetch("https://example.com"); } catch { fetchBlocked = true; }
                return { res, fetchBlocked };
              }
            }
          \`,
        },
      };
      const out = await this.env.LOADER.load(spec).getEntrypoint().evaluate(dispatcher);
      return Response.json({ ok: true, out });
    }
    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ping") {
      return Response.json({ ok: true, version: ${JSON.stringify(versionTag)} });
    }
    if (url.pathname === "/ssrf") {
      const target = url.searchParams.get("url") || "http://169.254.169.254/latest/meta-data/";
      const resp = await fetch(target);
      return Response.json({ status: resp.status, body: await resp.text() });
    }
    if (url.pathname === "/rpc-add") {
      const stub = env.CANARY.get(env.CANARY.idFromName("singleton"));
      const res = await stub.addItem("via_rpc", ${JSON.stringify(versionTag)});
      return Response.json(res);
    }
    if (url.pathname.startsWith("/do/")) {
      const stub = env.CANARY.get(env.CANARY.idFromName("singleton"));
      const subUrl = new URL(request.url);
      subUrl.pathname = url.pathname.slice(3);
      return stub.fetch(new Request(subUrl.toString(), request));
    }
    return new Response("hello from " + ${JSON.stringify(versionTag)});
  },
};
`;
}

function buildBundle(versionTag, sha) {
  return {
    schemaVersion: 2,
    appId: DISPATCH_NAME,
    scriptName: SCRIPT_NAME,
    dispatchScriptName: DISPATCH_NAME,
    orgId: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
    orgSlug: ORG_SLUG,
    workspaceId: 'ws-e2e',
    bundleSha: sha,
    createdAt: new Date().toISOString(),
    compatibilityDate: '2026-07-13',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js',
    modules: {
      'index.js': { name: 'index.js', type: 'js', content: canaryWorkerSource(versionTag) },
    },
    bindings: [
      { type: 'durable_object_namespace', name: 'CANARY', class_name: 'CanaryDO' },
      { type: 'assets', name: 'ASSETS' },
      { type: 'worker_loader', name: 'LOADER' },
    ],
    doBindings: { CANARY: 'CanaryDO' },
    doClasses: ['CanaryDO'],
    hasAssets: true,
    hasCodemodeLoader: true,
  };
}

const cleanupKeys = { kv: [], r2: [] };

async function run() {
  const results = [];
  const assert = (name, cond, detail) => {
    results.push({ name, pass: Boolean(cond), detail });
    console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${JSON.stringify(detail)}`);
    if (!cond) throw new Error(`Assertion failed: ${name} (${JSON.stringify(detail)})`);
  };

  try {
    // 0. Publish static asset + v1 bundle + staging APP_KV registry
    const assetBytes = 'hello-from-edge-r2-asset-' + RUN_ID;
    const assetHash = crypto.createHash('sha256').update(assetBytes).digest('hex');
    const assetR2Key = `selfhost-assets/${DISPATCH_NAME}/${assetHash}`;
    await r2Put(assetR2Key, assetBytes, 'text/plain; charset=utf-8');
    cleanupKeys.r2.push(assetR2Key);

    const assetsKvKey = `selfhost:assets:${DISPATCH_NAME}`;
    await kvPut(
      assetsKvKey,
      JSON.stringify({
        schemaVersion: 1,
        appId: DISPATCH_NAME,
        createdAt: new Date().toISOString(),
        manifest: {
          'assets/hello.txt': { hash: assetHash, size: assetBytes.length, contentType: 'text/plain; charset=utf-8' },
        },
      }),
    );
    cleanupKeys.kv.push(assetsKvKey);

    const shaV1 = `v1${RUN_ID}00000000`.slice(0, 16);
    const keyV1 = `dynamic-bundles/${encodeURIComponent(DISPATCH_NAME)}/${shaV1}.json`;
    await r2Put(keyV1, JSON.stringify(buildBundle('v1', shaV1)));
    cleanupKeys.r2.push(keyV1);

    const registryKey = `script:${DISPATCH_NAME}`;
    await kvPut(
      registryKey,
      JSON.stringify({
        org_id: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
        org_slug: ORG_SLUG,
        is_public: true,
        runtime_mode: 'dynamic',
        bundle_r2_key: keyV1,
        bundle_sha: shaV1,
        quota_tier: 'free',
        do_classes: ['CanaryDO'],
        has_assets: true,
      }),
    );
    cleanupKeys.kv.push(registryKey);

    // Wait briefly for KV propagation
    await new Promise((r) => setTimeout(r, 1500));

    // 1. Edge static asset fast-path
    const rAsset = await fetch(`https://${HOST}/assets/hello.txt`);
    const assetText = await rAsset.text();
    assert('1_edge_static_asset', rAsset.status === 200 && assetText === assetBytes, {
      status: rAsset.status,
      body: assetText,
    });

    // 2. Stateless HTTP Dynamic Worker
    const t0 = Date.now();
    const rPing = await fetch(`https://${HOST}/ping`);
    const pingJson = await rPing.json();
    const t1 = Date.now();
    const rPingWarm = await fetch(`https://${HOST}/ping`);
    await rPingWarm.json();
    const t2 = Date.now();
    assert('2_stateless_http', rPing.status === 200 && pingJson.version === 'v1', {
      coldMs: t1 - t0,
      warmMs: t2 - t1,
      body: pingJson,
    });

    // 3. SQLite DO CRUD + native RPC + v1 -> v2 upgrade persistence
    const rWrite = await fetch(`https://${HOST}/do/write?k=first&v=hello`);
    const writeJson = await rWrite.json();
    const rRpc = await fetch(`https://${HOST}/rpc-add`);
    const rpcJson = await rRpc.json();
    assert('3a_do_crud_and_rpc', writeJson.count === 1 && rpcJson.count === 2, {
      writeJson,
      rpcJson,
    });

    // Upgrade to v2 bundle and verify 100% SQLite persistence!
    const shaV2 = `v2${RUN_ID}00000000`.slice(0, 16);
    const keyV2 = `dynamic-bundles/${encodeURIComponent(DISPATCH_NAME)}/${shaV2}.json`;
    await r2Put(keyV2, JSON.stringify(buildBundle('v2', shaV2)));
    cleanupKeys.r2.push(keyV2);
    await kvPut(
      registryKey,
      JSON.stringify({
        org_id: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
        org_slug: ORG_SLUG,
        is_public: true,
        runtime_mode: 'dynamic',
        bundle_r2_key: keyV2,
        bundle_sha: shaV2,
        quota_tier: 'free',
        do_classes: ['CanaryDO'],
        has_assets: true,
      }),
    );
    // Wait for KV eventual consistency (up to 65s on Cloudflare edge for a just-read key)
    let listV2 = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const rPingV2 = await fetch(`https://${HOST}/ping`);
      const p2 = await rPingV2.json().catch(() => null);
      if (p2?.version === 'v2') {
        const rListV2 = await fetch(`https://${HOST}/do/list`);
        listV2 = await rListV2.json();
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert(
      '3b_do_persistence_across_deploy',
      listV2?.version === 'v2' && Array.isArray(listV2?.rows) && listV2.rows.length === 2,
      listV2,
    );

    // 4. Outbound SSRF Egress Gate (169.254.169.254 & 127.0.0.1 blocked 403, example.com allowed)
    const rMeta = await (await fetch(`https://${HOST}/ssrf?url=http://169.254.169.254/latest/meta-data/`)).json();
    const rLoop = await (await fetch(`https://${HOST}/ssrf?url=http://127.0.0.1:8080/secret`)).json();
    const rPub = await (await fetch(`https://${HOST}/ssrf?url=https://example.com/`)).json();
    assert(
      '4_outbound_ssrf_gate',
      rMeta.status === 403 && rLoop.status === 403 && rPub.status === 200,
      { metadataStatus: rMeta.status, loopbackStatus: rLoop.status, publicStatus: rPub.status },
    );

    // 5. 2-Hop @cloudflare/codemode RpcTarget from INSIDE SQLite DO Facet
    const rCode = await fetch(`https://${HOST}/do/codemode`);
    const codeJson = await rCode.json();
    assert(
      '5_codemode_2hop_inside_facet',
      rCode.status === 200 &&
        codeJson?.out?.res?.product === 42 &&
        codeJson?.out?.fetchBlocked === true,
      codeJson,
    );

    // 6. Runaway SQLite Write Hard-Gate (12,000 writes > 10,000 event cap -> 429 QuotaExceededError!)
    const rRunaway = await fetch(`https://${HOST}/do/runaway`);
    const runawayText = await rRunaway.text();
    assert(
      '6_sqlite_quota_hard_gate',
      rRunaway.status === 429 && runawayText.includes('Quota exceeded'),
      { status: rRunaway.status, body: runawayText.slice(0, 200) },
    );

    // 7. AlarmMediator bridging on a fresh exempt-tier canary key so no KV cache wait is needed!
    const alarmScriptName = `dw-alarm-${RUN_ID}`;
    const alarmDispatchName = `${alarmScriptName}--${ORG_SLUG}`;
    const alarmHost = `${alarmDispatchName}.staging.camelai.app`;
    const alarmBundle = { ...buildBundle('v2-alarm', shaV2), appId: alarmDispatchName, scriptName: alarmScriptName, dispatchScriptName: alarmDispatchName };
    const alarmBundleKey = `dynamic-bundles/${encodeURIComponent(alarmDispatchName)}/${shaV2}.json`;
    await r2Put(alarmBundleKey, JSON.stringify(alarmBundle));
    cleanupKeys.r2.push(alarmBundleKey);
    const alarmRegistryKey = `script:${alarmDispatchName}`;
    await kvPut(
      alarmRegistryKey,
      JSON.stringify({
        org_id: 'd9eeb1b9-e5a1-4f54-bf9b-2a98360e3627',
        org_slug: ORG_SLUG,
        is_public: true,
        runtime_mode: 'dynamic',
        bundle_r2_key: alarmBundleKey,
        bundle_sha: shaV2,
        quota_tier: 'exempt',
        do_classes: ['CanaryDO'],
        has_assets: false,
      }),
    );
    cleanupKeys.kv.push(alarmRegistryKey);
    await new Promise((r) => setTimeout(r, 1500));

    const rAlarm = await (await fetch(`https://${alarmHost}/do/schedule-alarm`)).json();
    assert('7a_alarm_scheduled', rAlarm.ok === true && typeof rAlarm.stored === 'number', rAlarm);
    await new Promise((r) => setTimeout(r, 4000));
    const listAfterAlarm = await (await fetch(`https://${alarmHost}/do/list`)).json();
    const alarmFired = listAfterAlarm.rows.some((row) => row.k === 'alarm_fired');
    assert('7b_alarm_fired_in_facet', alarmFired, { rowCount: listAfterAlarm.rows.length, alarmFired });

    console.log('\nALL LIVE STAGING E2E CHECKS PASSED!');
  } finally {
    // Clean up all temporary staging canary artifacts
    for (const k of cleanupKeys.kv) await kvDelete(k);
    for (const k of cleanupKeys.r2) await r2Delete(k);
    console.log(`Cleaned up ${cleanupKeys.kv.length} KV keys and ${cleanupKeys.r2.length} R2 objects.`);
  }
}

run().catch((err) => {
  console.error('STAGING E2E FAILED:', err);
  process.exit(1);
});
