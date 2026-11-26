#!/usr/bin/env node
/**
 * Resumable WfP -> Dynamic Workers Migration CLI (Cohorts A, B, and C).
 *
 * Enterprise & VIP Zero-Disruption Safeguards:
 * - By default, ALL Enterprise orgs — including SECLOCK (`gmie6a`, `seclock`, `qn5nuk`),
 *   BrandRank.ai (`brandrankai-bc3`), Rubicon9 (`rubicon9-c7c`, `rubicon9-e75`), SCX (`r17qk2`),
 *   and Sanjay (`sanjay-05a`, `6itpbw`) — are PROTECTED and SKIPPED unless explicitly opted in
 *   via `--include-enterprise` or `--script <exact-dispatch-name>`.
 * - When an Enterprise org IS migrated, it automatically receives `quota_tier: "enterprise"`
 *   (100x Free SQLite limits + 8 GiB shard DB cap + no CPU clamp).
 * - Always supports instant `<1s` rollback via `--rollback <dispatchScriptName>`.
 *
 * Usage:
 *   npx tsx scripts/migrate-dynamic-workers.ts --cohort a --dry-run
 *   npx tsx scripts/migrate-dynamic-workers.ts --cohort a --script hello--acme85 --env staging
 *   npx tsx scripts/migrate-dynamic-workers.ts --cohort b --script counter--acme85 --singleton-ids name:default
 *   npx tsx scripts/migrate-dynamic-workers.ts --rollback counter--acme85
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  billingPlanToQuotaTier,
  dynamicBundleObjectKey,
  extractHasAssetsBinding,
  extractHasCodemodeLoaderBinding,
  extractLocalDoBindings,
  type AppQuotaTier,
  type DynamicWorkerBundleRecord,
  type DynamicWorkerModule,
} from '../workers/main/src/dynamic-worker-registry.ts';
import { hydrateMigratedBindings } from '../workers/main/src/dynamic-migration-bindings.ts';
import { buildWfpExportShimSource } from '../workers/dispatcher/src/dynamic/export-shim.ts';
import {
  MIGRATION_SIG_HEADER,
  MIGRATION_TS_HEADER,
  signMigrationRequest,
} from '../workers/dispatcher/src/dynamic/migration-protocol.ts';

/**
 * Protected Enterprise / VIP org slugs (including SECLOCK).
 * Never touched by batch migration waves unless `--include-enterprise` is explicitly passed.
 */
export const PROTECTED_ENTERPRISE_ORG_SLUGS = new Set([
  'gmie6a',          // SECLOCK (enterprise, highest-paying VIP customer)
  'seclock',         // John Della Vecchia (SECLOCK)
  'qn5nuk',          // Lalique SECLOCK
  'brandrankai-bc3', // BrandRank.ai (enterprise)
  'rubicon9-c7c',    // TMC x Rubicon9 (enterprise)
  'rubicon9-e75',    // R9 PoC (enterprise)
  'r17qk2',          // SCX (enterprise)
  'sanjay-05a',      // Sanjay (enterprise)
  '6itpbw',          // Sanjay Lohani (enterprise)
]);

interface CliOptions {
  env: 'staging' | 'prod';
  cohort?: 'a' | 'b' | 'c';
  script?: string;
  rollback?: string;
  singletonIds: string[];
  dryRun: boolean;
  includeEnterprise: boolean;
  limit: number;
  logFile: string;
}

const ENV_CONFIG = {
  staging: {
    accountId: '85bbd288051330fb51ee1c86031a299b',
    dispatchNamespace: 'chiridion-platform-staging',
    appKvId: 'e894eb2caf1641ad8870da994b992fce',
    appDbId: 'f73a764a-e6e2-4813-aa5c-6058b0212c51',
    r2Bucket: 'chiridion-sandbox',
    dispatcherOrigin: 'https://chiridion-dispatcher-staging.miguel-85b.workers.dev',
  },
  prod: {
    accountId: '85bbd288051330fb51ee1c86031a299b',
    dispatchNamespace: 'chiridion-platform',
    appKvId: '0ee80299e67c4c7fa0c1ad618b7e7a9c',
    appDbId: 'd4e6f5ca-08ec-4920-a4da-5651336beb79',
    r2Bucket: 'chiridion-sandbox',
    dispatcherOrigin: 'https://custom-domains.camelai.app',
  },
} as const;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    env: 'staging',
    singletonIds: ['name:default'],
    dryRun: false,
    includeEnterprise: false,
    limit: 20,
    logFile: path.resolve('migration-progress.jsonl'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--env' && argv[i + 1]) {
      opts.env = argv[++i] === 'prod' ? 'prod' : 'staging';
    } else if (arg === '--cohort' && argv[i + 1]) {
      const c = argv[++i]!.toLowerCase();
      if (c === 'a' || c === 'b' || c === 'c') opts.cohort = c;
    } else if (arg === '--script' && argv[i + 1]) {
      opts.script = argv[++i]!;
    } else if (arg === '--rollback' && argv[i + 1]) {
      opts.rollback = argv[++i]!;
    } else if (arg === '--singleton-ids' && argv[i + 1]) {
      opts.singletonIds = argv[++i]!.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--include-enterprise') {
      opts.includeEnterprise = true;
    } else if (arg === '--limit' && argv[i + 1]) {
      opts.limit = Math.max(1, Number(argv[++i]!) || 20);
    } else if (arg === '--log-file' && argv[i + 1]) {
      opts.logFile = path.resolve(argv[++i]!);
    }
  }
  return opts;
}

export function extractOrgSlugFromDispatchName(dispatchScriptName: string): string {
  const idx = dispatchScriptName.indexOf('--');
  return idx >= 0 ? dispatchScriptName.slice(idx + 2) : '';
}

export function isProtectedEnterpriseScript(dispatchScriptName: string): boolean {
  const orgSlug = extractOrgSlugFromDispatchName(dispatchScriptName);
  return PROTECTED_ENTERPRISE_ORG_SLUGS.has(orgSlug);
}

async function cfFetch<T>(
  apiToken: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  const resp = await fetch(url, {
    ...init,
    headers,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Cloudflare API ${init.method ?? 'GET'} ${url} failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as { success?: boolean; result?: T; errors?: unknown[] };
  if (parsed.success === false) {
    throw new Error(`Cloudflare API error: ${JSON.stringify(parsed.errors)}`);
  }
  return (parsed.result ?? parsed) as T;
}

async function kvGet(apiToken: string, accountId: string, kvId: string, key: string): Promise<string | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`KV GET ${key} failed (${resp.status})`);
  return resp.text();
}

async function kvPut(apiToken: string, accountId: string, kvId: string, key: string, value: string): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'text/plain; charset=utf-8' },
    body: value,
  });
  if (!resp.ok) throw new Error(`KV PUT ${key} failed (${resp.status}): ${await resp.text()}`);
}

async function r2GetJson<T>(
  apiToken: string,
  accountId: string,
  bucket: string,
  key: string,
): Promise<T | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) return null;
  return (await resp.json()) as T;
}

interface AppDbMetadataRow {
  org_id: string;
  workspace_id: string;
  created_by: string | null;
  artifact_cache_key: string | null;
  billing_plan: string | null;
}

async function queryAppDbMetadata(
  apiToken: string,
  accountId: string,
  dbId: string,
  orgId: string,
  scriptName: string,
): Promise<AppDbMetadataRow | null> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sql: `
        SELECT a.org_id, a.workspace_id, a.created_by,
               g.artifact_cache_key AS artifact_cache_key,
               o.billing_plan
        FROM apps a
        LEFT JOIN orgs o ON o.id = a.org_id
        LEFT JOIN app_usage_guard_state g ON g.org_id = a.org_id AND g.script_name = a.script_name
        WHERE a.org_id = ? AND a.script_name = ?
        LIMIT 1
      `,
      params: [orgId, scriptName],
    }),
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { result?: Array<{ results?: AppDbMetadataRow[] }> };
  return data.result?.[0]?.results?.[0] ?? null;
}

async function r2PutJson(
  apiToken: string,
  accountId: string,
  bucket: string,
  key: string,
  payload: unknown,
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`R2 PUT ${key} failed (${resp.status}): ${await resp.text()}`);
}

async function fetchWfpScriptContent(
  apiToken: string,
  accountId: string,
  namespace: string,
  scriptName: string,
): Promise<{ mainModule: string; modules: Record<string, DynamicWorkerModule> }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${encodeURIComponent(scriptName)}/content`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
  if (!resp.ok) throw new Error(`GET script content failed (${resp.status})`);
  const mainModule = resp.headers.get('cf-entrypoint') || 'index.js';
  const contentType = resp.headers.get('content-type') || '';

  const modules: Record<string, DynamicWorkerModule> = {};
  if (contentType.includes('multipart/form-data')) {
    const form = await resp.formData();
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        modules[name] = { name, type: 'js', content: value };
      } else {
        const buf = new Uint8Array(await value.arrayBuffer());
        const partType = value.type.toLowerCase();
        if (partType.includes('wasm') || name.endsWith('.wasm')) {
          modules[name] = { name, type: 'wasm', content: Buffer.from(buf).toString('base64') };
        } else if (partType.includes('json') && name.endsWith('.json')) {
          modules[name] = { name, type: 'json', content: Buffer.from(buf).toString('utf8') };
        } else if (partType.startsWith('text/') && !name.endsWith('.js') && !name.endsWith('.mjs')) {
          modules[name] = { name, type: 'text', content: Buffer.from(buf).toString('utf8') };
        } else if (partType.includes('octet-stream')) {
          modules[name] = { name, type: 'data', content: Buffer.from(buf).toString('base64') };
        } else {
          modules[name] = { name, type: 'js', content: Buffer.from(buf).toString('utf8') };
        }
      }
    }
  } else {
    const text = await resp.text();
    modules[mainModule] = { name: mainModule, type: 'js', content: text };
  }
  return { mainModule, modules };
}

async function uploadWfpExportShim(input: {
  apiToken: string;
  accountId: string;
  namespace: string;
  dispatchScriptName: string;
  doBindings: Record<string, string>;
  hmacSecret: string;
  discoveryWebhookUrl?: string;
}): Promise<void> {
  const shimSource = buildWfpExportShimSource({
    classNames: Object.values(input.doBindings),
    bindingMap: input.doBindings,
    hmacSecret: input.hmacSecret,
    discoveryWebhookUrl: input.discoveryWebhookUrl,
  });
  const bindings = Object.entries(input.doBindings).map(([name, class_name]) => ({
    type: 'durable_object_namespace',
    name,
    class_name,
  }));
  const form = new FormData();
  form.append(
    'metadata',
    new Blob(
      [
        JSON.stringify({
          main_module: 'export-shim.js',
          compatibility_date: '2026-07-13',
          compatibility_flags: ['nodejs_compat'],
          bindings,
          keep_bindings: ['secret_text', 'secret_key'],
          keep_assets: true,
        }),
      ],
      { type: 'application/json' },
    ),
  );
  form.append(
    'export-shim.js',
    new Blob([shimSource], { type: 'application/javascript+module' }),
    'export-shim.js',
  );

  const url = `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/dispatch/namespaces/${input.namespace}/scripts/${encodeURIComponent(input.dispatchScriptName)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${input.apiToken}` },
    body: form,
  });
  if (!resp.ok) {
    throw new Error(`Upload WfP export shim failed (${resp.status}): ${await resp.text()}`);
  }
}

async function migrateSingleScript(
  opts: CliOptions,
  apiToken: string,
  migrationHmacSecret: string,
  dispatchScriptName: string,
): Promise<Record<string, unknown>> {
  const cfg = ENV_CONFIG[opts.env];

  if (!opts.includeEnterprise && !opts.script && isProtectedEnterpriseScript(dispatchScriptName)) {
    return { dispatchScriptName, status: 'skipped', reason: 'protected_enterprise_org' };
  }

  const registryKey = `script:${dispatchScriptName}`;
  const rawRegistry = await kvGet(apiToken, cfg.accountId, cfg.appKvId, registryKey);
  if (!rawRegistry) {
    return { dispatchScriptName, status: 'skipped', reason: 'missing_kv_registry' };
  }
  const registry = JSON.parse(rawRegistry) as Record<string, unknown>;

  const settings = await cfFetch<{
    bindings?: Array<Record<string, unknown>>;
    compatibility_date?: string;
    compatibility_flags?: string[];
  }>(
    apiToken,
    `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/workers/dispatch/namespaces/${cfg.dispatchNamespace}/scripts/${encodeURIComponent(dispatchScriptName)}/settings`,
  );
  const bindings = settings.bindings ?? [];
  const doBindings = extractLocalDoBindings(bindings);
  const doClasses = [...new Set(Object.values(doBindings))];
  const hasAssets = extractHasAssetsBinding(bindings);
  const hasCodemodeLoader = extractHasCodemodeLoaderBinding(bindings);

  if (opts.cohort === 'a' && doClasses.length > 0) {
    return { dispatchScriptName, status: 'skipped', reason: 'has_durable_objects', doClasses };
  }
  if ((opts.cohort === 'b' || opts.cohort === 'c') && doClasses.length === 0) {
    return { dispatchScriptName, status: 'skipped', reason: 'no_durable_objects' };
  }

  // Verify R2/KV asset mirror exists before cutting over an asset-bearing app.
  if (hasAssets) {
    const assetsManifest = await kvGet(
      apiToken,
      cfg.accountId,
      cfg.appKvId,
      `selfhost:assets:${dispatchScriptName}`,
    );
    if (!assetsManifest) {
      return { dispatchScriptName, status: 'skipped', reason: 'missing_r2_kv_assets_mirror' };
    }
  }

  const orgSlug = extractOrgSlugFromDispatchName(dispatchScriptName);
  const scriptName = dispatchScriptName.slice(0, Math.max(0, dispatchScriptName.indexOf('--')));
  const orgId = String(registry.org_id ?? '');

  // Look up authoritative org/workspace/billing_plan/artifact_cache_key from APP_DB
  // so R2VirtualBucket, KVVirtualNamespace, ConnectionsService, DataProxyService,
  // AIVirtualBinding, CamelAiService, AnalysisAppService, and WarehouseService get
  // 100% exact tenant `props` (Cloudflare /settings strips `props` from service bindings!).
  const appDbRow = orgId
    ? await queryAppDbMetadata(apiToken, cfg.accountId, cfg.appDbId, orgId, scriptName)
    : null;
  const workspaceId = appDbRow?.workspace_id ?? '';
  const artifactRecord = appDbRow?.artifact_cache_key
    ? await r2GetJson<{ metadata?: { bindings?: Array<Record<string, unknown>> } }>(
        apiToken,
        cfg.accountId,
        cfg.r2Bucket,
        appDbRow.artifact_cache_key,
      )
    : null;

  const hydratedResult = hydrateMigratedBindings({
    dispatchScriptName,
    orgId,
    workspaceId,
    userId: appDbRow?.created_by ?? undefined,
    liveSettingsBindings: bindings,
    artifactCacheBindings: artifactRecord?.metadata?.bindings ?? null,
  });
  if (!hydratedResult.ok) {
    return {
      dispatchScriptName,
      status: 'skipped',
      reason: hydratedResult.reason,
      missingBindings: hydratedResult.missingBindings,
    };
  }
  const hydratedBindings = hydratedResult.bindings;

  const quotaTier: AppQuotaTier =
    isProtectedEnterpriseScript(dispatchScriptName) || appDbRow?.billing_plan === 'enterprise'
      ? 'enterprise'
      : billingPlanToQuotaTier(appDbRow?.billing_plan ?? (registry.quota_tier as string | undefined));

  if (opts.dryRun) {
    return {
      dispatchScriptName,
      status: 'dry_run_ready',
      cohort: opts.cohort,
      doClasses,
      hasAssets,
      hasCodemodeLoader,
      quotaTier,
      bindingPropsSource: hydratedResult.source,
      workspaceId,
    };
  }

  // 1. Fetch WfP bundle & write immutable DynamicWorkerBundleRecord to R2 + backup
  const { mainModule, modules } = await fetchWfpScriptContent(
    apiToken,
    cfg.accountId,
    cfg.dispatchNamespace,
    dispatchScriptName,
  );
  const bundleSha = crypto
    .createHash('sha256')
    .update(JSON.stringify({ mainModule, bindings: hydratedBindings, modules }))
    .digest('hex')
    .slice(0, 16);
  const bundleR2Key = dynamicBundleObjectKey(dispatchScriptName, bundleSha);

  const bundleRecord: DynamicWorkerBundleRecord = {
    schemaVersion: 2,
    appId: dispatchScriptName,
    scriptName,
    dispatchScriptName,
    orgId,
    orgSlug,
    workspaceId,
    bundleSha,
    createdAt: new Date().toISOString(),
    compatibilityDate: settings.compatibility_date || '2026-07-13',
    compatibilityFlags: settings.compatibility_flags ?? ['nodejs_compat'],
    mainModule,
    modules,
    bindings: hydratedBindings,
    doBindings,
    doClasses,
    hasAssets,
    hasCodemodeLoader,
  };

  await r2PutJson(apiToken, cfg.accountId, cfg.r2Bucket, `wfp-backups/${dispatchScriptName}.json`, {
    backedUpAt: new Date().toISOString(),
    settings,
    mainModule,
    modules,
  });
  await r2PutJson(apiToken, cfg.accountId, cfg.r2Bucket, bundleR2Key, bundleRecord);

  // 2. For DO cohorts (B & C), swap WfP to zero-migration Export Shim & run verified import
  let importedShards: unknown[] = [];
  const targetMode = opts.cohort === 'c' ? 'dynamic_migrating' : 'dynamic';
  if (doClasses.length > 0) {
    if (!migrationHmacSecret) {
      throw new Error('MIGRATION_HMAC_SECRET (or TOKEN_SIGNING_SECRET) is required for DO migrations');
    }
    await uploadWfpExportShim({
      apiToken,
      accountId: cfg.accountId,
      namespace: cfg.dispatchNamespace,
      dispatchScriptName,
      doBindings,
      hmacSecret: migrationHmacSecret,
      discoveryWebhookUrl:
        opts.cohort === 'c'
          ? `${cfg.dispatcherOrigin}/__chiridion_migrate/alarm-discovered?appId=${encodeURIComponent(dispatchScriptName)}`
          : undefined,
    });

    if (opts.cohort === 'b') {
      // Allow any already-warm WfP Durable Object isolate ~12s of quiet idle time
      // so Cloudflare reloads the DO class onto ChiridionExportShimDO cleanly.
      await new Promise((r) => setTimeout(r, 12_000));
      for (const className of doClasses) {
        for (const objectId of opts.singletonIds) {
          const ts = Date.now();
          const sig = await signMigrationRequest(
            migrationHmacSecret,
            '/__chiridion_migrate/import',
            ts,
          );
          const importResp = await fetch(`${cfg.dispatcherOrigin}/__chiridion_migrate/import`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [MIGRATION_TS_HEADER]: String(ts),
              [MIGRATION_SIG_HEADER]: sig,
            },
            body: JSON.stringify({
              dispatchScriptName,
              className,
              objectId,
              orgId: String(registry.org_id ?? ''),
            }),
          });
          if (!importResp.ok) {
            throw new Error(
              `Shard import failed for ${dispatchScriptName}:${className}:${objectId} (${importResp.status}): ${await importResp.text()}`,
            );
          }
          importedShards.push(await importResp.json());
        }
      }
    }
  }

  // 3. Atomic KV cutover
  const nextRegistry = {
    ...registry,
    runtime_mode: targetMode,
    bundle_r2_key: bundleR2Key,
    bundle_sha: bundleSha,
    quota_tier: quotaTier,
    do_classes: doClasses,
    has_assets: hasAssets,
    migrated_at: new Date().toISOString(),
  };
  await kvPut(apiToken, cfg.accountId, cfg.appKvId, registryKey, JSON.stringify(nextRegistry));

  return {
    dispatchScriptName,
    status: 'migrated',
    runtime_mode: targetMode,
    bundle_r2_key: bundleR2Key,
    quota_tier: quotaTier,
    importedShards,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiToken = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  const migrationHmacSecret = process.env.MIGRATION_HMAC_SECRET || process.env.TOKEN_SIGNING_SECRET || '';
  if (!apiToken) {
    console.error('Error: CLOUDFLARE_API_TOKEN or CF_API_TOKEN is required.');
    process.exit(1);
  }
  const cfg = ENV_CONFIG[opts.env];

  if (opts.rollback) {
    const key = `script:${opts.rollback}`;
    const raw = await kvGet(apiToken, cfg.accountId, cfg.appKvId, key);
    if (!raw) throw new Error(`Registry key not found: ${key}`);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.runtime_mode = 'wfp';
    await kvPut(apiToken, cfg.accountId, cfg.appKvId, key, JSON.stringify(parsed));
    console.log(JSON.stringify({ ok: true, action: 'rollback', dispatchScriptName: opts.rollback, runtime_mode: 'wfp' }));
    return;
  }

  if (!opts.cohort) {
    console.error('Error: --cohort a|b|c (or --rollback <name>) is required.');
    process.exit(1);
  }

  let targets: string[];
  if (opts.script) {
    targets = [opts.script];
  } else {
    const scripts = await cfFetch<Array<{ id: string }>>(
      apiToken,
      `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/workers/dispatch/namespaces/${cfg.dispatchNamespace}/scripts`,
    );
    targets = scripts.map((s) => s.id).slice(0, opts.limit);
  }

  for (const script of targets) {
    try {
      const outcome = await migrateSingleScript(opts, apiToken, migrationHmacSecret, script);
      const line = JSON.stringify({ ts: new Date().toISOString(), ...outcome });
      console.log(line);
      fs.appendFileSync(opts.logFile, `${line}\n`);
    } catch (error) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        dispatchScriptName: script,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(line);
      fs.appendFileSync(opts.logFile, `${line}\n`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
