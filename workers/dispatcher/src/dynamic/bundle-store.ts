/**
 * Immutable R2 bundle loader with in-isolate LRU + Cache API caching,
 * optional live OrgDO managed env overlay, and WorkerLoader option assembly.
 */

import type { OrgDO } from '../../../main/src/auth';
import {
  type AppQuotaTier,
  type DynamicWorkerBundleRecord,
  type DynamicWorkerModule,
} from '../../../main/src/dynamic-worker-registry';
import type { ShardQuotaLimits } from './quota-policy';
import { generateDynamicWorkerWrapperSource } from './wrapper-generator';

export interface DynamicRuntimeExports {
  AIVirtualBinding?: (options: { props: Record<string, unknown> }) => unknown;
  AssetsVirtualBinding?: (options: { props: Record<string, unknown> }) => unknown;
  CamelAiService?: (options: { props: Record<string, unknown> }) => unknown;
  ConnectionsService?: (options: { props: Record<string, unknown> }) => unknown;
  DataProxyService?: (options: { props: Record<string, unknown> }) => unknown;
  AnalysisAppService?: (options: { props: Record<string, unknown> }) => unknown;
  WarehouseService?: (options: { props: Record<string, unknown> }) => unknown;
  DynamicAIVirtualBinding?: (options: { props: Record<string, unknown> }) => unknown;
  DynamicCamelAiService?: (options: { props: Record<string, unknown> }) => unknown;
  DynamicConnectionsService?: (options: { props: Record<string, unknown> }) => unknown;
  DynamicDataProxyService?: (options: { props: Record<string, unknown> }) => unknown;
  DynamicAnalysisAppService?: (options: { props: Record<string, unknown> }) => unknown;
  DynamicWarehouseService?: (options: { props: Record<string, unknown> }) => unknown;
  KVVirtualNamespace?: (options: { props: Record<string, unknown> }) => unknown;
  R2VirtualBucket?: (options: { props: Record<string, unknown> }) => unknown;
  TenantDoRouter?: (options: { props: Record<string, unknown> }) => unknown;
  AlarmMediator?: (options: { props: Record<string, unknown> }) => unknown;
  QuotaReporter?: (options: { props: Record<string, unknown> }) => unknown;
  OutboundGate?: (options: { props: Record<string, unknown> }) => Fetcher;
  CodemodeLoaderProxy?: (options: { props: Record<string, unknown> }) => unknown;
  UserLogsTail?: (options: { props: Record<string, unknown> }) => unknown;
}

export interface BundleStoreEnv {
  R2_BUCKET?: R2Bucket;
  ORG?: DurableObjectNamespace<OrgDO>;
  USER_APP_LOADER?: WorkerLoader;
}

export interface ManagedAppEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

const BUNDLE_LRU_MAX = 64;
const bundleLru = new Map<string, DynamicWorkerBundleRecord>();

const ENV_CACHE_TTL_MS = 60_000;
const envVarCache = new Map<string, { expiresAt: number; vars: ManagedAppEnvVar[]; envHash: string }>();

function setBundleLru(key: string, record: DynamicWorkerBundleRecord): void {
  if (bundleLru.has(key)) bundleLru.delete(key);
  bundleLru.set(key, record);
  if (bundleLru.size > BUNDLE_LRU_MAX) {
    const oldest = bundleLru.keys().next().value;
    if (oldest) bundleLru.delete(oldest);
  }
}

export function clearBundleStoreCachesForTest(): void {
  bundleLru.clear();
  envVarCache.clear();
}

export async function loadDynamicBundleRecord(
  env: BundleStoreEnv,
  bundleR2Key: string,
): Promise<DynamicWorkerBundleRecord | null> {
  const cached = bundleLru.get(bundleR2Key);
  if (cached) {
    setBundleLru(bundleR2Key, cached);
    return cached;
  }

  // Try Cloudflare edge Cache API (immutable bundle key).
  const cacheUrl = `https://chiridion-bundle-cache.internal/${encodeURIComponent(bundleR2Key)}`;
  let cache: Cache | null = null;
  try {
    cache = caches.default;
    const hit = await cache.match(cacheUrl);
    if (hit) {
      const parsed = (await hit.json()) as DynamicWorkerBundleRecord;
      if (parsed && parsed.schemaVersion === 2) {
        setBundleLru(bundleR2Key, parsed);
        return parsed;
      }
    }
  } catch {
    // Cache API unavailable in unit test / miniflare contexts without caches.default.
  }

  if (!env.R2_BUCKET) return null;
  const object = await env.R2_BUCKET.get(bundleR2Key);
  if (!object) return null;

  const text = await object.text();
  const parsed = JSON.parse(text) as DynamicWorkerBundleRecord;
  if (!parsed || parsed.schemaVersion !== 2) return null;

  setBundleLru(bundleR2Key, parsed);
  if (cache) {
    try {
      await cache.put(
        cacheUrl,
        new Response(text, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=86400, immutable',
          },
        }),
      );
    } catch {
      // Best-effort cache fill.
    }
  }
  return parsed;
}

async function computeEnvHash(vars: ManagedAppEnvVar[]): Promise<string> {
  if (vars.length === 0) return '0';
  const sorted = [...vars].sort((a, b) => a.key.localeCompare(b.key));
  const payload = JSON.stringify(sorted.map((entry) => [entry.key, entry.value]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function loadManagedEnvOverlay(
  env: BundleStoreEnv,
  orgId: string,
  scriptName: string,
  envVersion = 0,
): Promise<{ vars: ManagedAppEnvVar[]; envHash: string }> {
  if (!env.ORG) return { vars: [], envHash: '0' };
  const cacheKey = `${orgId}:${scriptName}:${envVersion}`;
  const now = Date.now();
  const cached = envVarCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { vars: cached.vars, envHash: cached.envHash };
  }

  try {
    const stub = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
      getAppEnvVarsForDeploy?: (name: string) => Promise<ManagedAppEnvVar[]>;
    };
    if (typeof stub.getAppEnvVarsForDeploy !== 'function') {
      return { vars: [], envHash: '0' };
    }
    const vars = await stub.getAppEnvVarsForDeploy(scriptName);
    const envHash = await computeEnvHash(vars);
    envVarCache.set(cacheKey, { expiresAt: now + ENV_CACHE_TTL_MS, vars, envHash });
    return { vars, envHash };
  } catch {
    return { vars: [], envHash: '0' };
  }
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function toWorkerLoaderModule(module: DynamicWorkerModule): WorkerLoaderModule | string {
  switch (module.type) {
    case 'text':
      return { text: module.content };
    case 'json':
      return { json: JSON.parse(module.content) };
    case 'data':
      return { data: base64ToArrayBuffer(module.content) };
    case 'wasm':
      return { wasm: base64ToArrayBuffer(module.content) };
    case 'js':
    default:
      // WorkerLoader requires explicit `{ js }` object when module name doesn't end with `.js`.
      return module.name.endsWith('.js') ? module.content : { js: module.content };
  }
}

function moduleBytes(module: DynamicWorkerModule): ArrayBuffer {
  if (module.type === 'data' || module.type === 'wasm') {
    return base64ToArrayBuffer(module.content);
  }
  const encoded = new TextEncoder().encode(module.content);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
}

function moduleText(module: DynamicWorkerModule): string {
  if (module.type === 'data' || module.type === 'wasm') {
    return new TextDecoder().decode(base64ToArrayBuffer(module.content));
  }
  return module.content;
}

function bindingModule(
  record: DynamicWorkerBundleRecord,
  binding: Record<string, unknown>,
): DynamicWorkerModule | null {
  const partName =
    typeof binding.part === 'string'
      ? binding.part
      : typeof binding.name === 'string'
        ? binding.name
        : null;
  return partName ? record.modules[partName] ?? null : null;
}

function buildPlainAndBlobEnv(
  record: DynamicWorkerBundleRecord,
  managedOverlay: ManagedAppEnvVar[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const binding of record.bindings) {
    if (typeof binding.name !== 'string') continue;
    if (binding.type === 'plain_text' || binding.type === 'secret_text') {
      result[binding.name] =
        typeof binding.text === 'string'
          ? binding.text
          : typeof binding.value === 'string'
            ? binding.value
            : '';
    } else if (binding.type === 'json') {
      if (typeof binding.json === 'string') {
        result[binding.name] = JSON.parse(binding.json);
      } else if ('json' in binding) {
        result[binding.name] = binding.json;
      }
    } else if (binding.type === 'text_blob') {
      const mod = bindingModule(record, binding);
      if (mod) result[binding.name] = moduleText(mod);
    } else if (binding.type === 'data_blob') {
      const mod = bindingModule(record, binding);
      if (mod) result[binding.name] = moduleBytes(mod);
    } else if (binding.type === 'wasm_module') {
      const mod = bindingModule(record, binding);
      if (mod) {
        const WasmModuleCtor = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
        result[binding.name] = new WasmModuleCtor(moduleBytes(mod));
      }
    }
  }
  for (const entry of managedOverlay) {
    result[entry.key] = entry.value;
  }
  return result;
}

const BROKERED_PROXY_NAME: Record<string, keyof DynamicRuntimeExports> = {
  AIVirtualBinding: 'DynamicAIVirtualBinding',
  CamelAiService: 'DynamicCamelAiService',
  ConnectionsService: 'DynamicConnectionsService',
  DataProxyService: 'DynamicDataProxyService',
  AnalysisAppService: 'DynamicAnalysisAppService',
  WarehouseService: 'DynamicWarehouseService',
};

function resolveServiceFactory(
  entrypoint: string,
  exports: DynamicRuntimeExports,
  preferBroker: boolean,
): ((opts: { props: Record<string, unknown> }) => unknown) | undefined {
  if (preferBroker) {
    const brokeredKey = BROKERED_PROXY_NAME[entrypoint];
    if (brokeredKey && typeof exports[brokeredKey] === 'function') {
      return exports[brokeredKey] as (opts: { props: Record<string, unknown> }) => unknown;
    }
  }
  const direct = (
    exports as Record<string, ((opts: { props: Record<string, unknown> }) => unknown) | undefined>
  )[entrypoint];
  return typeof direct === 'function' ? direct : undefined;
}

function buildVirtualBindingsEnv(
  record: DynamicWorkerBundleRecord,
  exports: DynamicRuntimeExports,
  preferBroker: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const binding of record.bindings) {
    if (typeof binding.name !== 'string') continue;

    if (binding.type === 'service') {
      const props =
        binding.props && typeof binding.props === 'object' && !Array.isArray(binding.props)
          ? (binding.props as Record<string, unknown>)
          : {};
      const entrypoint = typeof binding.entrypoint === 'string' ? binding.entrypoint : '';
      const factory = resolveServiceFactory(entrypoint, exports, preferBroker);
      if (factory) {
        result[binding.name] = factory({ props });
      }
      continue;
    }

    if (binding.type === 'r2_bucket' && exports.R2VirtualBucket) {
      result[binding.name] = exports.R2VirtualBucket({
        props: {
          workspaceId: record.workspaceId,
          bucketName: typeof binding.bucket_name === 'string' ? binding.bucket_name : binding.name,
        },
      });
    } else if (binding.type === 'kv_namespace' && exports.KVVirtualNamespace) {
      result[binding.name] = exports.KVVirtualNamespace({
        props: {
          workspaceId: record.workspaceId,
          appId: record.appId,
          namespaceId: typeof binding.namespace_id === 'string' ? binding.namespace_id : binding.name,
        },
      });
    } else if (binding.type === 'assets' && exports.AssetsVirtualBinding) {
      result[binding.name] = exports.AssetsVirtualBinding({
        props: { appId: record.appId },
      });
    } else if (binding.type === 'ai') {
      const aiFactory = resolveServiceFactory('AIVirtualBinding', exports, preferBroker);
      if (aiFactory) {
        result[binding.name] = aiFactory({
          props: { orgId: record.orgId, workspaceId: record.workspaceId },
        });
      }
    }
  }
  return result;
}

export interface LoadDynamicWorkerOptions {
  loader: WorkerLoader;
  record: DynamicWorkerBundleRecord;
  exports: DynamicRuntimeExports;
  managedOverlay: ManagedAppEnvVar[];
  envHash: string;
  quotaTier: AppQuotaTier;
  quotaLimits?: ShardQuotaLimits | null;
  supervisorKey?: string;
  dailyRowsRead?: number;
  dailyRowsWritten?: number;
  preferBroker?: boolean;
}

export function loadDynamicUserWorker(opts: LoadDynamicWorkerOptions): WorkerStub {
  const {
    loader,
    record,
    exports,
    managedOverlay,
    envHash,
    quotaTier,
    quotaLimits,
    supervisorKey,
    dailyRowsRead = 0,
    dailyRowsWritten = 0,
    preferBroker = false,
  } = opts;

  const isolateId = supervisorKey
    ? `do:${supervisorKey}:${record.bundleSha}:${envHash}`
    : `http:${record.dispatchScriptName}:${record.bundleSha}:${envHash}`;

  return loader.get(isolateId, () => {
    const modules: Record<string, WorkerLoaderModule | string> = {
      '__chiridion_wrapper.js': generateDynamicWorkerWrapperSource(record),
    };
    for (const [moduleName, module] of Object.entries(record.modules)) {
      modules[moduleName] = toWorkerLoaderModule(module);
    }

    const dynamicEnv: Record<string, unknown> = {
      ...buildPlainAndBlobEnv(record, managedOverlay),
      ...buildVirtualBindingsEnv(record, exports, preferBroker),
      __CHIRIDION_APP_ID: record.dispatchScriptName,
      __CHIRIDION_DO_BINDINGS: record.doBindings,
    };

    if (exports.TenantDoRouter) {
      dynamicEnv.__CHIRIDION_DO_ROUTER = exports.TenantDoRouter({
        props: {
          dispatchScriptName: record.dispatchScriptName,
          orgId: record.orgId,
          quotaTier,
          bundleR2Key: `dynamic-bundles/${encodeURIComponent(record.dispatchScriptName)}/${record.bundleSha}.json`,
        },
      });
    }

    if (supervisorKey && exports.AlarmMediator) {
      dynamicEnv.__CHIRIDION_ALARM_MEDIATOR = exports.AlarmMediator({
        props: {
          supervisorKey,
          dispatchScriptName: record.dispatchScriptName,
          orgId: record.orgId,
          quotaTier,
        },
      });
    }

    if (supervisorKey && exports.QuotaReporter) {
      dynamicEnv.__CHIRIDION_QUOTA_REPORTER = exports.QuotaReporter({
        props: {
          supervisorKey,
          dispatchScriptName: record.dispatchScriptName,
          orgId: record.orgId,
          quotaTier,
        },
      });
    }

    if (record.hasCodemodeLoader && exports.CodemodeLoaderProxy) {
      dynamicEnv.__CHIRIDION_CODEMODE_PROXY = exports.CodemodeLoaderProxy({
        props: {
          dispatchScriptName: record.dispatchScriptName,
          orgId: record.orgId,
        },
      });
    }

    if (quotaLimits) {
      dynamicEnv.__CHIRIDION_QUOTA_LIMITS = quotaLimits;
      dynamicEnv.__CHIRIDION_DAILY_ROWS_READ = dailyRowsRead;
      dynamicEnv.__CHIRIDION_DAILY_ROWS_WRITTEN = dailyRowsWritten;
    }

    const globalOutbound = exports.OutboundGate
      ? exports.OutboundGate({
          props: {
            dispatchScriptName: record.dispatchScriptName,
            orgId: record.orgId,
            quotaTier,
          },
        })
      : undefined;

    const tails = exports.UserLogsTail
      ? [
          exports.UserLogsTail({
            props: {
              dispatchScriptName: record.dispatchScriptName,
              orgId: record.orgId,
            },
          }),
        ]
      : undefined;

    return {
      compatibilityDate: record.compatibilityDate || '2026-07-13',
      compatibilityFlags: record.compatibilityFlags,
      mainModule: '__chiridion_wrapper.js',
      modules,
      env: dynamicEnv,
      ...(globalOutbound ? { globalOutbound } : {}),
      ...(tails ? { tails } : {}),
    } as WorkerLoaderWorkerCode;
  });
}
