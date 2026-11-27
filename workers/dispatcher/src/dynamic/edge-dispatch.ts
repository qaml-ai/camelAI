/**
 * Stateless edge dispatcher for hosted Dynamic Workers.
 *
 * Serves static assets directly from edge Cache API -> AssetsVirtualBinding (R2)
 * with ZERO DO invocations, and runs stateless HTTP requests directly inside
 * `env.USER_APP_LOADER` isolates on `chiridion-dispatcher`.
 */

import type { OrgDO } from '../../../main/src/auth';
import type { DynamicServiceBroker } from '../../../main/src/dynamic-service-broker';
import type { WorkerAccessInfo } from '../access-control';
import {
  isDynamicLogsTailEnabled,
  loadDynamicBundleRecord,
  loadDynamicEnvOverlay,
  loadDynamicUserWorker,
  type DynamicRuntimeExports,
} from './bundle-store';
import { MIGRATION_PENDING_MESSAGE, migrationPendingResponse } from './migration-protocol';
import { emitAppUsageMetric, resolveQuotaTier } from './quota-policy';

export interface EdgeDispatchEnv {
  APP_KV?: KVNamespace;
  R2_BUCKET?: R2Bucket;
  ORG?: DurableObjectNamespace<OrgDO>;
  USER_APP_LOADER?: WorkerLoader;
  APP_USAGE_AE?: AnalyticsEngineDataset;
  MAIN_APP_BROKER?: Service<DynamicServiceBroker>;
  MIGRATION_HMAC_SECRET?: string;
  TOKEN_SIGNING_SECRET?: string;
  DISPATCHER?: {
    get(name: string): { fetch(request: Request): Promise<Response> };
  };
}

const STATIC_ASSET_PATHS = new Set([
  '/favicon.ico',
  '/favicon.svg',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/site.webmanifest',
  '/robots.txt',
]);

function hasStaticExtension(pathname: string): boolean {
  const slash = pathname.lastIndexOf('/');
  const lastSegment = slash === -1 ? pathname : pathname.slice(slash + 1);
  return /\.[A-Za-z0-9]{1,16}$/.test(lastSegment);
}

export function shouldTryEdgeStaticAsset(request: Request, url: URL): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  // React Router single-fetch responses belong to the app, including under /assets/.
  if (url.pathname.endsWith('.data')) return false;
  return (
    url.pathname.startsWith('/assets/') ||
    STATIC_ASSET_PATHS.has(url.pathname) ||
    hasStaticExtension(url.pathname)
  );
}

async function tryServeEdgeStaticAsset(
  request: Request,
  url: URL,
  dispatchScriptName: string,
  bundleSha: string | undefined,
  exports: DynamicRuntimeExports,
  env: EdgeDispatchEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!shouldTryEdgeStaticAsset(request, url)) return null;
  if (!exports.AssetsVirtualBinding) return null;

  const cacheKey = new Request(
    `https://chiridion-asset-cache.internal/${encodeURIComponent(dispatchScriptName)}/${bundleSha ?? 'v0'}${url.pathname}`,
    { method: 'GET' },
  );
  let cache: Cache | null = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      return request.method === 'HEAD'
        ? new Response(null, { status: hit.status, headers: hit.headers })
        : hit;
    }
  } catch {
    // Cache API unavailable in unit test contexts.
  }

  const binding = exports.AssetsVirtualBinding({
    props: { appId: dispatchScriptName },
  }) as { fetch?: (req: Request) => Promise<Response> } | undefined;
  if (!binding || typeof binding.fetch !== 'function') return null;

  const response = await binding.fetch(request);
  if (response.status !== 404) {
    if (cache && response.ok && request.method === 'GET') {
      try {
        await cache.put(cacheKey, response.clone());
      } catch {
        // Best-effort cache fill.
      }
    }
    return response;
  }

  // Fallback & self-heal for migrated apps whose `selfhost:assets:<app>` manifest in KV
  // predated a newer WfP deploy: WfP `keep_assets: true` still holds the latest static files.
  if (!env.DISPATCHER) return null;
  try {
    const wfpResp = await env.DISPATCHER.get(dispatchScriptName).fetch(
      new Request(`https://${dispatchScriptName}.camelai.app${url.pathname}`, { method: 'GET' }),
    );
    if (wfpResp.status !== 200) return null;
    const rawCt = wfpResp.headers.get('content-type') || 'application/octet-stream';
    const contentType = rawCt.split(';')[0]!.trim().toLowerCase();
    // Never treat SPA HTML fallback as a missing JS/CSS/image asset.
    if (!url.pathname.endsWith('.html') && contentType === 'text/html') return null;
    const bytes = await wfpResp.arrayBuffer();
    if (bytes.byteLength === 0) return null;

    const relPath = url.pathname.replace(/^\/+/, '');
    const headers = new Headers();
    headers.set('Content-Type', rawCt);
    headers.set(
      'Cache-Control',
      url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    );
    headers.set('X-Chiridion-Asset-Fallback', 'wfp-heal');
    const out = new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });

    const healTask = (async () => {
      if (cache && request.method === 'GET') {
        try {
          await cache.put(cacheKey, new Response(bytes, { status: 200, headers }));
        } catch {}
      }
      if (env.R2_BUCKET && env.APP_KV && relPath) {
        try {
          const digestBuf = await crypto.subtle.digest('SHA-256', bytes);
          const hash = Array.from(new Uint8Array(digestBuf))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          await env.R2_BUCKET.put(`selfhost-assets/${dispatchScriptName}/${hash}`, bytes, {
            httpMetadata: { contentType },
          });
          const kvKey = `selfhost:assets:${dispatchScriptName}`;
          const existingRaw = await env.APP_KV.get(kvKey);
          const record = existingRaw
            ? (JSON.parse(existingRaw) as {
                schemaVersion?: number;
                appId?: string;
                createdAt?: string;
                manifest?: Record<string, { hash: string; size: number; contentType: string }>;
              })
            : { schemaVersion: 1, appId: dispatchScriptName, createdAt: new Date().toISOString(), manifest: {} };
          record.manifest = record.manifest ?? {};
          record.manifest[relPath] = { hash, size: bytes.byteLength, contentType };
          await env.APP_KV.put(kvKey, JSON.stringify(record));
        } catch {}
      }
    })();
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(healTask);
    }
    return out;
  } catch {
    return null;
  }
}

export async function dispatchDynamicWorkerEdge(input: {
  request: Request;
  env: EdgeDispatchEnv;
  ctx: ExecutionContext;
  exports: DynamicRuntimeExports;
  dispatchScriptName: string;
  accessInfo: WorkerAccessInfo;
}): Promise<Response> {
  const { request, env, ctx, exports, dispatchScriptName, accessInfo } = input;
  const startedAt = Date.now();
  const url = new URL(request.url);
  const quotaTier = resolveQuotaTier(accessInfo.quota_tier);

  // Fast path: serve static assets directly from edge Cache API -> R2
  // without booting the Dynamic Worker isolate or touching any DO.
  if (accessInfo.has_assets !== false) {
    const assetResponse = await tryServeEdgeStaticAsset(
      request,
      url,
      dispatchScriptName,
      accessInfo.bundle_sha,
      exports,
      env,
      ctx,
    );
    if (assetResponse) {
      emitAppUsageMetric(env.APP_USAGE_AE, {
        dispatchScriptName,
        orgId: accessInfo.org_id,
        eventKind: 'asset',
        quotaTier,
        durationMs: Date.now() - startedAt,
      });
      return assetResponse;
    }
  }

  if (!env.USER_APP_LOADER) {
    throw new Error('USER_APP_LOADER binding is not configured on dispatcher');
  }
  if (!accessInfo.bundle_r2_key) {
    throw new Error(`Worker not found: missing bundle_r2_key for ${dispatchScriptName}`);
  }

  const record = await loadDynamicBundleRecord(env, accessInfo.bundle_r2_key);
  if (!record) {
    throw new Error(`Worker not found: bundle missing in R2 for ${dispatchScriptName}`);
  }

  const [{ vars, envHash }, enableLogsTail] = await Promise.all([
    loadDynamicEnvOverlay(env, record, accessInfo.env_version),
    isDynamicLogsTailEnabled(env, record),
  ]);

  const worker = loadDynamicUserWorker({
    loader: env.USER_APP_LOADER,
    record,
    exports,
    managedOverlay: vars,
    envHash,
    quotaTier,
    runtimeMode: accessInfo.runtime_mode,
    preferBroker: Boolean(env.MAIN_APP_BROKER),
    enableLogsTail,
  });

  let response: Response;
  try {
    response = await worker.getEntrypoint().fetch(request);
  } catch (error) {
    // Workerd preserves the message of an uncaught supervisor RPC error.
    if (error instanceof Error && error.message === MIGRATION_PENDING_MESSAGE) {
      return migrationPendingResponse();
    }
    throw error;
  }

  const metricEmit = Promise.resolve().then(() => {
    emitAppUsageMetric(env.APP_USAGE_AE, {
      dispatchScriptName,
      orgId: accessInfo.org_id,
      eventKind: 'http',
      quotaTier,
      durationMs: Date.now() - startedAt,
    });
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(metricEmit);
  }
  return response;
}
