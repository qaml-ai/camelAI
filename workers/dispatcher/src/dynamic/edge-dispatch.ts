/**
 * Stateless edge dispatcher for hosted Dynamic Workers.
 *
 * Serves static assets directly from edge Cache API -> AssetsVirtualBinding (R2)
 * with ZERO DO invocations, and runs stateless HTTP requests directly inside
 * `env.USER_APP_LOADER` isolates on `chiridion-dispatcher`.
 */

import type { OrgDO } from '../../../main/src/auth';
import type { WorkerAccessInfo } from '../access-control';
import {
  loadDynamicBundleRecord,
  loadDynamicUserWorker,
  loadManagedEnvOverlay,
  type DynamicRuntimeExports,
} from './bundle-store';
import { emitAppUsageMetric, resolveQuotaTier } from './quota-policy';

export interface EdgeDispatchEnv {
  R2_BUCKET?: R2Bucket;
  ORG?: DurableObjectNamespace<OrgDO>;
  USER_APP_LOADER?: WorkerLoader;
  APP_USAGE_AE?: AnalyticsEngineDataset;
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
  if (response.status === 404) return null;

  if (cache && response.ok && request.method === 'GET') {
    try {
      await cache.put(cacheKey, response.clone());
    } catch {
      // Best-effort cache fill.
    }
  }
  return response;
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

  const { vars: managedOverlay, envHash } = await loadManagedEnvOverlay(
    env,
    record.orgId,
    record.scriptName,
    accessInfo.env_version ?? 0,
  );

  const worker = loadDynamicUserWorker({
    loader: env.USER_APP_LOADER,
    record,
    exports,
    managedOverlay,
    envHash,
    quotaTier,
  });

  const response = await worker.getEntrypoint().fetch(request);

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
