import { waitUntil } from "cloudflare:workers";

import {
  mapVirtualizedBindings,
  validateBindings,
  type DeploySideEffectsInfo,
  type WorkerBinding,
} from "./cf-api-proxy.js";
import {
  normalizeSelfhostAssetPath,
  selfhostAssetObjectKey,
  selfhostAssetsKey,
  type SelfhostAssetsRecord,
} from "./selfhost-assets-registry.js";
import {
  selfhostWorkerKey,
  type SelfhostWorkerModule,
  type SelfhostWorkerRecord,
} from "./selfhost-worker-registry.js";
import { resolveUploadedDispatchScriptVersion, withUsageGuardTracing } from "./usage-guard-config.js";
import {
  acquireUsageGuardOperationLeaseWithRetry,
  releaseUsageGuardOperationLease,
} from "./usage-guard-state.js";

const DIRECT_DEPLOY_WRITE_CONCURRENCY = 16;
const CLOUDFLARE_STATIC_ASSET_MAX_BYTES = 25 * 1024 * 1024;

// Assets are streamed through the deploy in bounded batches so peak isolate
// memory stays flat regardless of how many (or how large) a project's static
// assets are. Only this many asset payloads are ever materialized at once for
// hashing or R2 rollback writes. The Durable Object isolate cap is 128 MB, and
// an asset-heavy build (game textures/models, media) would otherwise exceed it
// if every asset were read up front (see collectWorkerBundleFromSandbox).
const DIRECT_DEPLOY_ASSET_BATCH_SIZE = 8;

// Cloudflare's assets-upload-session groups files into buckets that each must
// upload as a single multipart request, so one bucket's payloads are the
// irreducible memory floor. Uploading buckets one at a time keeps peak memory
// to a single bucket (plus base64 overhead) instead of every bucket at once.
const DIRECT_DEPLOY_ASSET_UPLOAD_CONCURRENCY = 1;

export interface DirectDispatchDeployEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  CF_WORKER_NAME?: string;
  TAIL_WORKER_NAME?: string;
  APP_KV?: KVNamespace;
  APP_DB?: D1Database;
  R2_BUCKET?: R2Bucket;
}

export interface DirectDispatchDeployIdentity {
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
  projectId?: string;
}

export interface DirectWorkerMetadata {
  main_module: string;
  bindings?: WorkerBinding[];
  compatibility_date?: string;
  compatibility_flags?: string[];
  config_path?: string;
  [key: string]: unknown;
}

interface NativeAssetsUploadResult {
  jwt: string;
  assetCount: number;
}

/**
 * A deploy asset the pipeline reads on demand rather than buffering up front.
 * `read()` fetches the bytes from wherever they live (build sandbox, R2), so an
 * asset-heavy project never materializes every asset in the isolate at once.
 * `size` is the listed byte length; the actual bytes are only touched inside a
 * bounded batch (fingerprint, R2 rollback write, or native upload).
 */
export interface DirectDeployAsset {
  path: string;
  contentType?: string;
  size: number;
  read(): Promise<Uint8Array>;
}

/**
 * The hash/size fingerprint of a deploy asset, computed once in a bounded batch
 * that releases the asset bytes before the next batch. It retains only the
 * lazy `read()` handle (no bytes/base64), so a full list of prepared assets is
 * cheap to hold; the native upload and R2 rollback passes re-read each asset on
 * demand from this handle.
 */
interface PreparedDirectAsset {
  path: string;
  normalizedPath: string;
  cfPath: string;
  contentType?: string;
  size: number;
  cfHash: string;
  r2Hash: string;
  read(): Promise<Uint8Array>;
}

export interface DirectWorkerModule {
  name: string;
  contentType: string;
  content: string | Uint8Array | ArrayBuffer;
}

export interface DirectDispatchDeployRequest {
  scriptName: string;
  hostname: string;
  identity: DirectDispatchDeployIdentity;
  metadata: DirectWorkerMetadata;
  modules: DirectWorkerModule[];
  assets?: DirectDeployAsset[];
  commitSha?: string;
}

export interface DirectDispatchDeployResult {
  success: boolean;
  scriptName: string;
  dispatchScriptName: string;
  status: number;
  timings?: DirectDispatchDeployTimings;
  result?: unknown;
  error?: string;
  warnings?: string[];
  skippedAssets?: DirectDeploySkippedAsset[];
  sideEffects: DeploySideEffectsInfo;
}

export interface DirectDeploySkippedAsset {
  path: string;
  size: number;
  limit: number;
  reason: "asset_too_large";
}

export interface DirectDispatchDeployTimings {
  totalMs: number;
  prepareAssetsMs: number;
  nativeAssetsMs: number;
  storeAssetsMs: number;
  migrationsMs: number;
  artifactCacheMs: number;
  cloudflareUploadMs: number;
  publishAssetsRecordMs: number;
  moduleCount: number;
  assetCount: number;
  moduleBytes: number;
  assetBytes: number;
}

export interface DirectDeployRollbackRequest {
  artifactCacheKey: string;
  hostname: string;
  expected?: {
    orgId?: string;
    workspaceId?: string;
    scriptName?: string;
  };
  threadId?: string;
}

export interface DirectDeployArtifactCacheRecord {
  schemaVersion: 1;
  createdAt: string;
  scriptName: string;
  dispatchScriptName: string;
  identity: DirectDispatchDeployIdentity;
  metadata: DirectWorkerMetadata;
  modules: Array<{ name: string; contentType: string; contentBase64: string }>;
  assetsRecord: SelfhostAssetsRecord | null;
}

type AssetUploadSessionResult = {
  jwt?: string;
  buckets?: string[][];
};

type AssetUploadResult = {
  jwt?: string;
};

type PreparedDeployArtifactCache = {
  key: string;
  record: Promise<DirectDeployArtifactCacheRecord>;
};

type CloudflareResultRead<T> = {
  result: T | null;
  errorText?: string;
};

export async function deployWorkerModulesDirect(
  env: DirectDispatchDeployEnv,
  request: DirectDispatchDeployRequest,
  options: {
    fetcher?: typeof fetch;
    onDeploySideEffects?: (info: DeploySideEffectsInfo) => Promise<void>;
  } = {},
): Promise<DirectDispatchDeployResult> {
  const startedAt = Date.now();
  const selfhostPublishingMode = isSelfhostDirectPublishingMode(env);
  const requestedAssets = request.assets ?? [];
  const skippedAssets: DirectDeploySkippedAsset[] = selfhostPublishingMode
    ? []
    : requestedAssets
        .filter((asset) => asset.size > CLOUDFLARE_STATIC_ASSET_MAX_BYTES)
        .map((asset) => ({
          path: asset.path,
          size: asset.size,
          limit: CLOUDFLARE_STATIC_ASSET_MAX_BYTES,
          reason: "asset_too_large",
        }));
  const deployableAssets = selfhostPublishingMode
    ? requestedAssets
    : requestedAssets.filter((asset) => asset.size <= CLOUDFLARE_STATIC_ASSET_MAX_BYTES);
  const warnings = skippedAssets.map((asset) =>
    `Skipped static asset ${JSON.stringify(asset.path)} (${formatMiB(asset.size)} MiB, ${asset.size} bytes): ` +
    `Cloudflare Workers allows at most 25 MiB per asset. The deployed app will return 404 for this file.`
  );
  const prepareAssetsStartedAt = Date.now();
  // Reject known-oversized files before read() transfers their base64 payload
  // over sandbox RPC, where the transport otherwise fails opaquely.
  const preparedAssets = await fingerprintDirectAssets(deployableAssets);
  const prepareAssetsMs = Date.now() - prepareAssetsStartedAt;
  const timings: DirectDispatchDeployTimings = {
    totalMs: 0,
    prepareAssetsMs,
    nativeAssetsMs: 0,
    storeAssetsMs: 0,
    migrationsMs: 0,
    artifactCacheMs: 0,
    cloudflareUploadMs: 0,
    publishAssetsRecordMs: 0,
    moduleCount: request.modules.length,
    assetCount: preparedAssets.length,
    moduleBytes: request.modules.reduce((sum, module) => sum + contentBytes(module.content).byteLength, 0),
    assetBytes: preparedAssets.reduce((sum, asset) => sum + asset.size, 0),
  };
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const workerServiceName = env.CF_WORKER_NAME?.trim();
  const tailWorkerName = env.TAIL_WORKER_NAME?.trim();
  if (!request.modules.some((module) => module.name === request.metadata.main_module)) {
    throw new Error(`Direct deploy bundle is missing main module: ${request.metadata.main_module}`);
  }

  const validation = validateBindings(request.metadata.bindings ?? []);
  if (!validation.valid) {
    const forbiddenList = validation.forbiddenBindings.map((binding) => `${binding.name} (${binding.type})`).join(", ");
    throw new Error(`Deploy blocked: forbidden bindings: ${forbiddenList}`);
  }

  const dispatchScriptName = `${request.scriptName}--${request.identity.orgSlug}`;
  if (selfhostPublishingMode) {
    return deploySelfhostWorkerModulesDirect(
      env,
      request,
      dispatchScriptName,
      preparedAssets,
      warnings,
      timings,
      startedAt,
      options,
    );
  }
  if (!cfApiToken) throw new Error("CF_API_TOKEN is required for direct deploy");
  if (!accountId) throw new Error("CF_ACCOUNT_ID is required for direct deploy");
  if (!dispatchNamespace) throw new Error("CF_DISPATCH_NAMESPACE is required for direct deploy");
  if (!workerServiceName) throw new Error("CF_WORKER_NAME is required for direct deploy");
  const nativeAssetsStartedAt = Date.now();
  const nativeAssets = await uploadNativeWorkerAssets(env, dispatchNamespace, dispatchScriptName, request, preparedAssets, options.fetcher ?? fetch);
  timings.nativeAssetsMs = Date.now() - nativeAssetsStartedAt;
  let assetsRecord: SelfhostAssetsRecord | null = null;
  let storeAssetsTask: Promise<void> | null = null;
  const storeAssetsStartedAt = Date.now();
  try {
    const preparedStore = prepareDirectAssetsRecord(env, dispatchScriptName, request, preparedAssets);
    assetsRecord = preparedStore.record;
    storeAssetsTask = preparedStore.store;
    storeAssetsTask?.catch(() => {});
    if (!nativeAssets) await storeAssetsTask;
  } catch (error) {
    if (!nativeAssets) throw error;
    warnings.push(`Deploy asset rollback cache unavailable: ${errorMessage(error)}`);
    storeAssetsTask = null;
    assetsRecord = null;
  }
  timings.storeAssetsMs = Date.now() - storeAssetsStartedAt;
  const bindings = normalizedDirectBindings(request.metadata)
    .filter((binding) => nativeAssets || binding.type !== "assets");
  const migrationsStartedAt = Date.now();
  const migrations = await migrationsForDirectDeploy(
    accountId,
    dispatchNamespace,
    dispatchScriptName,
    request.metadata,
    cfApiToken,
    options.fetcher ?? fetch,
  );
  timings.migrationsMs = Date.now() - migrationsStartedAt;
  const metadata: DirectWorkerMetadata = withUsageGuardTracing({
    ...request.metadata,
    migrations,
    assets: nativeAssets
      ? { jwt: nativeAssets.jwt }
      : undefined,
    bindings: mapDirectDispatchBindings(
      bindings,
      request.identity.workspaceId,
      request.identity.orgId,
      request.identity.userId,
      workerServiceName,
      dispatchScriptName,
    ),
    // Attach the tail worker so deployed app logs/exceptions flow into
    // WorkerLogsDO. The legacy wrangler-deploy path set this via a separate
    // settings PATCH in cf-api-proxy; the direct-dispatch path owns the upload
    // PUT, so we set tail_consumers inline on every deploy (incl. redeploys).
    // Merge into (not replace) any consumers the project already declares so a
    // project-configured tail consumer is preserved alongside the platform one.
    ...(tailWorkerName
      ? { tail_consumers: withPlatformTailConsumer(request.metadata.tail_consumers, tailWorkerName) }
      : {}),
  });
  let artifactCacheKey: string | undefined;
  let artifactCacheTask: Promise<string | undefined> | null = null;
  const artifactCacheStartedAt = Date.now();
  try {
    const preparedArtifactCache = await prepareDeployArtifactCache(env, {
      scriptName: request.scriptName,
      dispatchScriptName,
      identity: request.identity,
      metadata,
      modules: request.modules,
      assetsRecord,
    });
    artifactCacheTask = preparedArtifactCache
      ? Promise.resolve(storeAssetsTask)
        .then(() => storePreparedDeployArtifactCache(env, preparedArtifactCache))
        .then(() => preparedArtifactCache.key)
      : null;
    artifactCacheTask?.catch(() => {});
  } catch (error) {
    warnings.push(`Deploy artifact cache unavailable: ${errorMessage(error)}`);
  }
  timings.artifactCacheMs = Date.now() - artifactCacheStartedAt;
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const module of request.modules) {
    form.append(module.name, new Blob([blobPart(module.content)], { type: module.contentType }), module.name);
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(dispatchScriptName)}`;
  const fetcher = options.fetcher ?? fetch;
  const cloudflareUploadStartedAt = Date.now();
  const operationLeaseHolder = crypto.randomUUID();
  const operationAppId = `${request.identity.orgId}:${request.scriptName}`;
  if (env.APP_DB && !(await acquireUsageGuardOperationLeaseWithRetry({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder })).acquired) {
    throw new Error("App deployment is temporarily busy; retry shortly");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfApiToken}` },
      body: form,
    });
  } catch (error) {
    if (env.APP_DB) {
      await releaseUsageGuardOperationLease({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder });
    }
    throw error;
  }
  try {
    timings.cloudflareUploadMs = Date.now() - cloudflareUploadStartedAt;
    const body = await readJsonOrText(response);
    const scriptVersion = response.ok
      ? await resolveUploadedDispatchScriptVersion({
          uploadBody: body,
          accountId,
          dispatchNamespace,
          dispatchScriptName,
          apiToken: cfApiToken,
          fetcher,
        })
      : undefined;
    if (response.ok && assetsRecord) {
      const publishAssetsStartedAt = Date.now();
      scheduleDeployBackgroundTask(
        Promise.resolve(storeAssetsTask)
          .then(() => publishDirectAssetsRecord(env, dispatchScriptName, assetsRecord))
          .catch((error) => console.warn("[direct-deploy] asset cache publish failed", { dispatchScriptName, error: errorMessage(error) })),
      );
      timings.publishAssetsRecordMs = Date.now() - publishAssetsStartedAt;
    }
    if (response.ok && artifactCacheTask) {
      const artifactCacheStoreStartedAt = Date.now();
      try {
        artifactCacheKey = await artifactCacheTask;
      } catch (error) {
        warnings.push(`Deploy artifact cache unavailable: ${errorMessage(error)}`);
      }
      timings.artifactCacheMs += Date.now() - artifactCacheStoreStartedAt;
    }
    timings.totalMs = Date.now() - startedAt;
    const sideEffects: DeploySideEffectsInfo = {
      scriptName: request.scriptName,
      dispatchScriptName,
      orgId: request.identity.orgId,
      orgSlug: request.identity.orgSlug,
      workspaceId: request.identity.workspaceId,
      hostname: request.hostname,
      threadId: request.identity.threadId,
      projectId: request.identity.projectId,
      configPath: typeof request.metadata.config_path === "string" ? request.metadata.config_path : undefined,
      commitSha: request.commitSha,
      artifactCacheKey,
      scriptVersion,
    };
    if (response.ok && options.onDeploySideEffects) {
      await options.onDeploySideEffects(sideEffects);
    }
    return {
      success: response.ok,
      scriptName: request.scriptName,
      dispatchScriptName,
      status: response.status,
      timings,
      sideEffects,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(skippedAssets.length > 0 ? { skippedAssets } : {}),
      ...(response.ok ? { result: body } : { error: typeof body === "string" ? body : JSON.stringify(body) }),
    };
  } finally {
    if (env.APP_DB) {
      await releaseUsageGuardOperationLease({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder });
    }
  }
}

function isSelfhostDirectPublishingMode(env: DirectDispatchDeployEnv): boolean {
  const accountId = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  const namespace = env.CF_DISPATCH_NAMESPACE?.trim().toLowerCase();
  return accountId === "selfhost" || namespace === "selfhost";
}

function selfhostModuleType(
  module: DirectWorkerModule,
  metadata: DirectWorkerMetadata,
): SelfhostWorkerModule["type"] {
  const binding = metadata.bindings?.find((candidate) => {
    const part = typeof candidate.part === "string" ? candidate.part : null;
    return part === module.name || (!part && candidate.name === module.name);
  });
  if (binding?.type === "wasm_module") return "wasm";
  if (binding?.type === "data_blob") return "data";
  if (binding?.type === "text_blob") return "text";

  const lowerName = module.name.toLowerCase();
  const lowerType = module.contentType.toLowerCase();
  if (lowerName.endsWith(".wasm") || lowerType.includes("application/wasm")) {
    return "wasm";
  }
  if (
    lowerType.startsWith("text/") &&
    !lowerName.endsWith(".js") &&
    !lowerName.endsWith(".mjs")
  ) {
    return "text";
  }
  if (lowerType.includes("application/json") && lowerName.endsWith(".json")) {
    return "json";
  }
  return "js";
}

function selfhostWorkerModules(
  modules: DirectWorkerModule[],
  metadata: DirectWorkerMetadata,
): Record<string, SelfhostWorkerModule> {
  return Object.fromEntries(
    modules.map((module) => {
      const type = selfhostModuleType(module, metadata);
      const bytes = contentBytes(module.content);
      const content = type === "data" || type === "wasm"
        ? bytesToBase64(bytes)
        : typeof module.content === "string"
          ? module.content
          : new TextDecoder().decode(bytes);
      return [module.name, { name: module.name, type, content }];
    }),
  );
}

async function deploySelfhostWorkerModulesDirect(
  env: DirectDispatchDeployEnv,
  request: DirectDispatchDeployRequest,
  dispatchScriptName: string,
  preparedAssets: PreparedDirectAsset[],
  warnings: string[],
  timings: DirectDispatchDeployTimings,
  startedAt: number,
  options: {
    fetcher?: typeof fetch;
    onDeploySideEffects?: (info: DeploySideEffectsInfo) => Promise<void>;
  },
): Promise<DirectDispatchDeployResult> {
  if (!env.APP_KV) {
    throw new Error("APP_KV is required for self-host app publishing");
  }

  const bindings = normalizedDirectBindings(request.metadata).filter(
    (binding) => binding.type !== "worker_loader",
  );
  const version = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const record: SelfhostWorkerRecord = {
    schemaVersion: 1,
    appId: dispatchScriptName,
    scriptName: request.scriptName,
    dispatchScriptName,
    orgId: request.identity.orgId,
    orgSlug: request.identity.orgSlug,
    workspaceId: request.identity.workspaceId,
    version,
    createdAt,
    compatibilityDate:
      typeof request.metadata.compatibility_date === "string" &&
      request.metadata.compatibility_date.trim()
        ? request.metadata.compatibility_date.trim()
        : "2026-06-09",
    compatibilityFlags: Array.isArray(request.metadata.compatibility_flags)
      ? request.metadata.compatibility_flags.filter(
          (flag): flag is string => typeof flag === "string",
        )
      : [],
    mainModule: request.metadata.main_module,
    modules: selfhostWorkerModules(request.modules, request.metadata),
    bindings: bindings as Array<Record<string, unknown>>,
  };

  const storeAssetsStartedAt = Date.now();
  const preparedStore = prepareDirectAssetsRecord(
    env,
    dispatchScriptName,
    request,
    preparedAssets,
  );
  await preparedStore.store;
  if (preparedStore.record) {
    await publishDirectAssetsRecord(env, dispatchScriptName, preparedStore.record);
  }
  timings.storeAssetsMs = Date.now() - storeAssetsStartedAt;

  await env.APP_KV.put(selfhostWorkerKey(dispatchScriptName), JSON.stringify(record));

  let artifactCacheKey: string | undefined;
  const artifactCacheStartedAt = Date.now();
  try {
    const preparedArtifactCache = await prepareDeployArtifactCache(env, {
      scriptName: request.scriptName,
      dispatchScriptName,
      identity: request.identity,
      metadata: request.metadata,
      modules: request.modules,
      assetsRecord: preparedStore.record,
    });
    if (preparedArtifactCache) {
      await storePreparedDeployArtifactCache(
        env,
        preparedArtifactCache,
      );
      artifactCacheKey = preparedArtifactCache.key;
    }
  } catch (error) {
    warnings.push(`Deploy artifact cache unavailable: ${errorMessage(error)}`);
  }
  timings.artifactCacheMs = Date.now() - artifactCacheStartedAt;
  timings.totalMs = Date.now() - startedAt;

  const sideEffects: DeploySideEffectsInfo = {
    scriptName: request.scriptName,
    dispatchScriptName,
    orgId: request.identity.orgId,
    orgSlug: request.identity.orgSlug,
    workspaceId: request.identity.workspaceId,
    hostname: request.hostname,
    threadId: request.identity.threadId,
    projectId: request.identity.projectId,
    configPath:
      typeof request.metadata.config_path === "string"
        ? request.metadata.config_path
        : undefined,
    commitSha: request.commitSha,
    artifactCacheKey,
    scriptVersion: version,
  };
  await options.onDeploySideEffects?.(sideEffects);

  return {
    success: true,
    scriptName: request.scriptName,
    dispatchScriptName,
    status: 200,
    timings,
    sideEffects,
    ...(warnings.length > 0 ? { warnings } : {}),
    result: {
      id: dispatchScriptName,
      script_name: dispatchScriptName,
      deployment_id: version,
      source: "selfhost",
    },
  };
}

function formatMiB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function migrationsForDirectDeploy(
  accountId: string,
  dispatchNamespace: string,
  dispatchScriptName: string,
  metadata: DirectWorkerMetadata,
  cfApiToken: string,
  fetcher: typeof fetch,
): Promise<DirectWorkerMetadata["migrations"]> {
  const configMigrations = metadata.migrations;
  // Already in the API's object form (or absent): pass through untouched.
  if (!Array.isArray(configMigrations)) {
    return configMigrations;
  }
  // Wrangler-style config carries migrations as an ARRAY of steps, and
  // @cloudflare/vite-plugin emits `migrations: []` by default in generated
  // manifests. The upload API's reader unmarshals `migrations` into an
  // object (internal ActorMigrations) and rejects any array — including an
  // empty one — so an empty config array must become "no migrations field".
  if (configMigrations.length === 0) {
    return undefined;
  }

  const migrationTags = configMigrations.map((migration) => {
    if (!migration || typeof migration !== "object" || Array.isArray(migration)) {
      throw new Error("Deploy migrations must be objects");
    }
    const tag = (migration as Record<string, unknown>).tag;
    if (typeof tag !== "string" || !tag.trim()) {
      throw new Error("Deploy migration entries must include a string tag");
    }
    return tag;
  });
  const latestTag = migrationTags[migrationTags.length - 1]!;
  const currentTag = await readCurrentWorkerMigrationTag(accountId, dispatchNamespace, dispatchScriptName, cfApiToken, fetcher);
  if (currentTag) {
    const currentIndex = migrationTags.findIndex((tag) => tag === currentTag);
    if (currentIndex === migrationTags.length - 1) return undefined;
    const pendingMigrations = currentIndex === -1
      ? configMigrations
      : configMigrations.slice(currentIndex + 1);
    return {
      old_tag: currentTag,
      new_tag: latestTag,
      steps: migrationStepsForUpload(pendingMigrations),
    };
  }

  return {
    new_tag: latestTag,
    steps: migrationStepsForUpload(configMigrations),
  };
}

function withPlatformTailConsumer(
  existing: unknown,
  tailWorkerName: string,
): Array<Record<string, unknown>> {
  const preserved = Array.isArray(existing)
    ? existing.filter((consumer): consumer is Record<string, unknown> => {
        if (!consumer || typeof consumer !== "object" || Array.isArray(consumer)) return false;
        // Drop only the exact platform consumer we are about to add (same
        // service, no environment scope). Wrangler treats a consumer with an
        // `environment` as distinct, so environment-scoped consumers for the
        // same service are preserved.
        const { service, environment } = consumer as { service?: unknown; environment?: unknown };
        const isExactPlatformConsumer = service === tailWorkerName && environment == null;
        return !isExactPlatformConsumer;
      })
    : [];
  return [...preserved, { service: tailWorkerName }];
}

function migrationStepsForUpload(migrations: unknown[]): Array<Record<string, unknown>> {
  return migrations.map((migration) => {
    const { tag: _tag, ...step } = migration as Record<string, unknown>;
    return step;
  });
}

async function readCurrentWorkerMigrationTag(
  accountId: string,
  dispatchNamespace: string,
  dispatchScriptName: string,
  cfApiToken: string,
  fetcher: typeof fetch,
): Promise<string | undefined> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(dispatchScriptName)}`;
  const response = await fetcher(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfApiToken}` },
  });
  const body = await readJsonOrText(response);
  if (!response.ok) {
    if (response.status === 404 || cloudflareErrorCodes(body).some((code) => code === 10092)) return undefined;
    throw new Error(`Failed to read existing Worker migration tag: ${cloudflareBodyText(body)}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const result = (body as { result?: unknown }).result;
  const script = result && typeof result === "object" && !Array.isArray(result) && "script" in result
    ? (result as { script?: unknown }).script
    : result;
  if (!script || typeof script !== "object" || Array.isArray(script)) return undefined;
  const migrationTag = (script as { migration_tag?: unknown }).migration_tag;
  return typeof migrationTag === "string" && migrationTag.trim() ? migrationTag.trim() : undefined;
}

function cloudflareErrorCodes(body: unknown): number[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((error) => {
    if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
    return (error as { code?: unknown }).code;
  }).filter((code): code is number => typeof code === "number");
}

function cloudflareBodyText(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function mapDirectDispatchBindings(
  bindings: WorkerBinding[],
  workspaceId: string,
  orgId: string,
  userId: string | undefined,
  workerServiceName: string,
  appId: string,
): WorkerBinding[] {
  const assetBindings = bindings.filter((binding) => binding.type === "assets");
  const mapped = mapVirtualizedBindings(
    bindings.filter((binding) => binding.type !== "assets"),
    workspaceId,
    orgId,
    userId,
    workerServiceName,
    appId,
  );
  return [...assetBindings, ...mapped];
}

async function uploadNativeWorkerAssets(
  env: DirectDispatchDeployEnv,
  dispatchNamespace: string,
  dispatchScriptName: string,
  request: DirectDispatchDeployRequest,
  preparedAssets: PreparedDirectAsset[],
  fetcher: typeof fetch,
): Promise<NativeAssetsUploadResult | null> {
  if (!request.metadata.assets || preparedAssets.length === 0) return null;
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  if (!cfApiToken || !accountId) throw new Error("Cloudflare credentials are required for direct deploy assets");

  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const asset of preparedAssets) {
    manifest[asset.cfPath] = { hash: asset.cfHash, size: asset.size };
  }

  const sessionUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(dispatchScriptName)}/assets-upload-session`;
  const sessionResponse = await fetcher(sessionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfApiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ manifest }),
  });
  const sessionBody = await readCloudflareResult<AssetUploadSessionResult>(sessionResponse);
  if (!sessionResponse.ok || !sessionBody.result) {
    throw new Error(`Asset upload session failed: ${sessionBody.errorText ?? "missing result"}`);
  }
  const uploadJwt = sessionBody.result.jwt;
  const buckets = sessionBody.result.buckets ?? [];
  if (!uploadJwt) throw new Error("Asset upload session did not return an upload token");
  if (buckets.length === 0) return { jwt: uploadJwt, assetCount: preparedAssets.length };

  const entriesByHash = new Map(preparedAssets.map((asset) => [asset.cfHash, asset]));
  const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`;
  // Upload one bucket at a time (see DIRECT_DEPLOY_ASSET_UPLOAD_CONCURRENCY) and
  // re-read each asset's bytes here rather than carrying base64 through from the
  // fingerprint pass, so only the current bucket's payloads live in memory.
  const uploadResults = await mapWithConcurrency(buckets, DIRECT_DEPLOY_ASSET_UPLOAD_CONCURRENCY, async (bucket) => {
    const form = new FormData();
    for (const hash of bucket) {
      const entry = entriesByHash.get(hash);
      if (!entry) throw new Error(`Asset upload bucket referenced unknown hash: ${hash}`);
      const base64 = bytesToBase64(await entry.read());
      form.append(
        hash,
        new Blob([base64], { type: entry.contentType ?? "application/null" }),
        hash,
      );
    }
    const uploadResponse = await fetcher(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${uploadJwt}` },
      body: form,
    });
    const uploadBody = await readCloudflareResult<AssetUploadResult>(uploadResponse);
    if (!uploadResponse.ok || !uploadBody.result) {
      throw new Error(`Asset upload failed: ${uploadBody.errorText ?? "missing result"}`);
    }
    return uploadBody.result.jwt;
  });
  const completionJwt = uploadResults.find((jwt): jwt is string => typeof jwt === "string" && jwt.length > 0) ?? "";
  if (!completionJwt) throw new Error("Asset upload completed without a completion token");
  return { jwt: completionJwt, assetCount: preparedAssets.length };
}

export async function rollbackWorkerDeployFromArtifactCache(
  env: DirectDispatchDeployEnv,
  request: DirectDeployRollbackRequest,
  options: {
    fetcher?: typeof fetch;
    onDeploySideEffects?: (info: DeploySideEffectsInfo) => Promise<void>;
  } = {},
): Promise<DirectDispatchDeployResult> {
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const tailWorkerName = env.TAIL_WORKER_NAME?.trim();
  const fetcher = options.fetcher ?? fetch;
  if (!cfApiToken) throw new Error("CF_API_TOKEN is required for direct rollback");
  if (!accountId) throw new Error("CF_ACCOUNT_ID is required for direct rollback");
  if (!dispatchNamespace) throw new Error("CF_DISPATCH_NAMESPACE is required for direct rollback");
  if (!env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct rollback");

  const artifactCacheKey = request.artifactCacheKey.trim();
  if (!artifactCacheKey) throw new Error("artifactCacheKey is required for direct rollback");
  const object = await env.R2_BUCKET.get(artifactCacheKey);
  if (!object) throw new Error(`Deploy artifact cache not found: ${artifactCacheKey}`);
  const record = validateArtifactCacheRecord(JSON.parse(await object.text()), artifactCacheKey);
  if (request.expected?.orgId && record.identity.orgId !== request.expected.orgId) {
    throw new Error("Deploy artifact cache belongs to a different org");
  }
  if (request.expected?.workspaceId && record.identity.workspaceId !== request.expected.workspaceId) {
    throw new Error("Deploy artifact cache belongs to a different workspace");
  }
  if (request.expected?.scriptName && record.scriptName !== request.expected.scriptName) {
    throw new Error("Deploy artifact cache belongs to a different app");
  }

  let metadata = record.metadata;
  if (record.assetsRecord) {
    const assets = loadDirectAssetsFromRecord(env, record.dispatchScriptName, record.assetsRecord);
    const preparedAssets = await fingerprintDirectAssets(assets);
    const nativeAssets = await uploadNativeWorkerAssets(env, dispatchNamespace, record.dispatchScriptName, {
      scriptName: record.scriptName,
      hostname: request.hostname,
      identity: record.identity,
      metadata: record.metadata,
      modules: [],
      assets,
    }, preparedAssets, fetcher);
    metadata = nativeAssets ? { ...record.metadata, assets: { jwt: nativeAssets.jwt } } : record.metadata;
  }

  // Re-apply the platform tail consumer so rolling back to an artifact cached
  // before this behavior existed (or under a different tail worker name) still
  // forwards logs to WorkerLogsDO. Idempotent for artifacts already carrying it.
  if (tailWorkerName) {
    metadata = { ...metadata, tail_consumers: withPlatformTailConsumer(metadata.tail_consumers, tailWorkerName) };
  }
  metadata = withUsageGuardTracing(metadata);

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const module of record.modules) {
    form.append(
      module.name,
      new Blob([base64ToBytes(module.contentBase64) as BlobPart], { type: module.contentType }),
      module.name,
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(record.dispatchScriptName)}`;
  const operationLeaseHolder = crypto.randomUUID();
  const operationAppId = `${record.identity.orgId}:${record.scriptName}`;
  if (env.APP_DB && !(await acquireUsageGuardOperationLeaseWithRetry({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder })).acquired) {
    throw new Error("App deployment is temporarily busy; retry shortly");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfApiToken}` },
      body: form,
    });
  } catch (error) {
    if (env.APP_DB) {
      await releaseUsageGuardOperationLease({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder });
    }
    throw error;
  }
  try {
    const body = await readJsonOrText(response);
    const scriptVersion = response.ok
      ? await resolveUploadedDispatchScriptVersion({
          uploadBody: body,
          accountId,
          dispatchNamespace,
          dispatchScriptName: record.dispatchScriptName,
          apiToken: cfApiToken,
          fetcher,
        })
      : undefined;
    if (response.ok && record.assetsRecord) {
      await publishDirectAssetsRecord(env, record.dispatchScriptName, record.assetsRecord);
    }
    const sideEffects: DeploySideEffectsInfo = {
      scriptName: record.scriptName,
      dispatchScriptName: record.dispatchScriptName,
      orgId: record.identity.orgId,
      orgSlug: record.identity.orgSlug,
      workspaceId: record.identity.workspaceId,
      hostname: request.hostname,
      threadId: request.threadId ?? record.identity.threadId,
      projectId: record.identity.projectId,
      configPath: typeof metadata.config_path === "string" ? metadata.config_path : undefined,
      artifactCacheKey,
      scriptVersion,
    };
    if (response.ok && options.onDeploySideEffects) {
      await options.onDeploySideEffects(sideEffects);
    }
    return {
      success: response.ok,
      scriptName: record.scriptName,
      dispatchScriptName: record.dispatchScriptName,
      status: response.status,
      sideEffects,
      ...(response.ok ? { result: body } : { error: typeof body === "string" ? body : JSON.stringify(body) }),
    };
  } finally {
    if (env.APP_DB) {
      await releaseUsageGuardOperationLease({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder });
    }
  }
}

// Return lazy handles that fetch each rollback blob from R2 on demand, so a
// rollback of an asset-heavy app streams its assets through the same bounded
// batches as a fresh deploy instead of loading every blob into the isolate.
function loadDirectAssetsFromRecord(
  env: DirectDispatchDeployEnv,
  appId: string,
  record: SelfhostAssetsRecord,
): DirectDeployAsset[] {
  if (!env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct deploy assets");
  return Object.entries(record.manifest).map(([path, entry]) => ({
    path,
    size: entry.size ?? 0,
    ...(entry.contentType ? { contentType: entry.contentType } : {}),
    read: async () => {
      if (!env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct deploy assets");
      const object = await env.R2_BUCKET.get(selfhostAssetObjectKey(appId, entry.hash));
      if (!object) throw new Error(`Deploy artifact asset blob not found: ${path}`);
      return new Uint8Array(await object.arrayBuffer());
    },
  }));
}

function validateArtifactCacheRecord(value: unknown, key: string): DirectDeployArtifactCacheRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Deploy artifact cache is invalid: ${key}`);
  }
  const record = value as DirectDeployArtifactCacheRecord;
  if (
    record.schemaVersion !== 1 ||
    typeof record.scriptName !== "string" ||
    typeof record.dispatchScriptName !== "string" ||
    !record.identity ||
    typeof record.identity.orgId !== "string" ||
    typeof record.identity.orgSlug !== "string" ||
    typeof record.identity.workspaceId !== "string" ||
    !record.metadata ||
    typeof record.metadata.main_module !== "string" ||
    !Array.isArray(record.modules)
  ) {
    throw new Error(`Deploy artifact cache is invalid: ${key}`);
  }
  for (const module of record.modules) {
    if (!module || typeof module.name !== "string" || typeof module.contentType !== "string" || typeof module.contentBase64 !== "string") {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
  }
  return record;
}

function normalizedDirectBindings(metadata: DirectWorkerMetadata): WorkerBinding[] {
  const bindings = metadata.bindings ?? [];
  if (!metadata.assets || bindings.some((binding) => binding.type === "assets")) return bindings;
  return [...bindings, { type: "assets", name: assetsBindingName(metadata.assets) }];
}

function assetsBindingName(assets: unknown): string {
  if (assets && typeof assets === "object" && !Array.isArray(assets)) {
    const record = assets as Record<string, unknown>;
    const configured = record.binding ?? record.binding_name ?? record.name;
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  }
  return "ASSETS";
}

// Read each asset once, in bounded batches, to compute its Cloudflare and R2
// hashes plus size, then release the bytes. The returned fingerprints carry no
// payload — only the lazy `read()` handle — so the native upload and R2
// rollback passes re-read on demand without the whole asset set ever being
// resident at once.
async function fingerprintDirectAssets(assets: DirectDeployAsset[]): Promise<PreparedDirectAsset[]> {
  return mapWithConcurrency(assets, DIRECT_DEPLOY_ASSET_BATCH_SIZE, async (asset) => {
    const bytes = await asset.read();
    const normalizedPath = normalizeSelfhostAssetPath(asset.path);
    const base64 = bytesToBase64(bytes);
    const extension = asset.path.split(".").pop() ?? "";
    const cfHash = (await sha256Hex(new TextEncoder().encode(`${base64}${extension}`))).slice(0, 32);
    const r2Hash = await sha256Hex(bytes);
    return {
      path: asset.path,
      normalizedPath,
      cfPath: `/${normalizedPath}`,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
      size: bytes.byteLength,
      cfHash,
      r2Hash,
      read: asset.read,
    };
  });
}

function prepareDirectAssetsRecord(
  env: DirectDispatchDeployEnv,
  appId: string,
  request: DirectDispatchDeployRequest,
  preparedAssets: PreparedDirectAsset[],
): { record: SelfhostAssetsRecord | null; store: Promise<void> | null } {
  if (preparedAssets.length === 0) return { record: null, store: null };
  const hasAssetsBinding = request.metadata.bindings?.some((binding) => binding.type === "assets") || Boolean(request.metadata.assets);
  if (!hasAssetsBinding) return { record: null, store: null };
  if (!env.APP_KV) throw new Error("APP_KV is required for direct deploy assets");
  if (preparedAssets.length > 0 && !env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct deploy assets");

  const manifest: SelfhostAssetsRecord["manifest"] = {};
  for (const asset of preparedAssets) {
    manifest[asset.normalizedPath] = {
      hash: asset.r2Hash,
      size: asset.size,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    };
  }

  const record: SelfhostAssetsRecord = {
    schemaVersion: 1 as const,
    appId,
    createdAt: new Date().toISOString(),
    manifest,
  };
  // Write the rollback blobs in bounded batches, re-reading each asset on demand
  // so at most DIRECT_DEPLOY_ASSET_BATCH_SIZE payloads are resident at a time.
  const store = preparedAssets.length > 0
    ? mapWithConcurrency(preparedAssets, DIRECT_DEPLOY_ASSET_BATCH_SIZE, async (asset) => {
      if (!env.R2_BUCKET) throw new Error("R2_BUCKET is required for direct deploy assets");
      await env.R2_BUCKET.put(
        selfhostAssetObjectKey(appId, asset.r2Hash),
        await asset.read(),
        asset.contentType ? { httpMetadata: { contentType: asset.contentType } } : undefined,
      );
    }).then(() => undefined)
    : Promise.resolve();
  return { record, store };
}

async function publishDirectAssetsRecord(
  env: DirectDispatchDeployEnv,
  appId: string,
  record: SelfhostAssetsRecord,
): Promise<void> {
  if (!env.APP_KV) throw new Error("APP_KV is required for direct deploy assets");
  await env.APP_KV.put(selfhostAssetsKey(appId), JSON.stringify(record));
}

async function prepareDeployArtifactCache(
  env: DirectDispatchDeployEnv,
  input: {
    scriptName: string;
    dispatchScriptName: string;
    identity: DirectDispatchDeployIdentity;
    metadata: DirectWorkerMetadata;
    modules: DirectWorkerModule[];
    assetsRecord: SelfhostAssetsRecord | null;
  },
): Promise<PreparedDeployArtifactCache | undefined> {
  if (!env.R2_BUCKET) return undefined;
  const moduleFingerprints = await mapWithConcurrency(input.modules, DIRECT_DEPLOY_WRITE_CONCURRENCY, async (module) => {
    const bytes = contentBytes(module.content);
    return {
      name: module.name,
      contentType: module.contentType,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    };
  });
  const deterministicForKey = {
    schemaVersion: 1 as const,
    scriptName: input.scriptName,
    dispatchScriptName: input.dispatchScriptName,
    identity: input.identity,
    metadata: input.metadata,
    modules: moduleFingerprints,
    assetsRecord: input.assetsRecord,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(deterministicForKey));
  const digest = await sha256Hex(encoded);
  const projectSegment = input.identity.projectId ? encodeURIComponent(input.identity.projectId) : "workspace";
  const key = `deploy-artifacts/${encodeURIComponent(input.identity.orgId)}/${encodeURIComponent(input.identity.workspaceId)}/${projectSegment}/${encodeURIComponent(input.dispatchScriptName)}/${digest}.json`;
  const record = (async (): Promise<DirectDeployArtifactCacheRecord> => ({
    schemaVersion: 1 as const,
    scriptName: input.scriptName,
    dispatchScriptName: input.dispatchScriptName,
    identity: input.identity,
    metadata: input.metadata,
    modules: await mapWithConcurrency(input.modules, DIRECT_DEPLOY_WRITE_CONCURRENCY, async (module) => ({
      name: module.name,
      contentType: module.contentType,
      contentBase64: bytesToBase64(contentBytes(module.content)),
    })),
    assetsRecord: input.assetsRecord,
    createdAt: new Date().toISOString(),
  }))();
  return { key, record };
}

async function storePreparedDeployArtifactCache(
  env: DirectDispatchDeployEnv,
  prepared: PreparedDeployArtifactCache,
): Promise<void> {
  if (!env.R2_BUCKET) return;
  const record = await prepared.record;
  await env.R2_BUCKET.put(prepared.key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      type: "direct-deploy-artifact-cache",
      orgId: record.identity.orgId,
      workspaceId: record.identity.workspaceId,
      scriptName: record.scriptName,
      dispatchScriptName: record.dispatchScriptName,
      ...(record.identity.projectId ? { projectId: record.identity.projectId } : {}),
    },
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentBytes(content: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return content;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

function scheduleDeployBackgroundTask(task: Promise<unknown>): void {
  try {
    waitUntil(task);
  } catch {
    // Unit tests and non-request contexts may not provide an active waitUntil
    // scope. Keep the work best-effort without blocking the deploy response.
    task.catch(() => {});
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function blobPart(content: string | Uint8Array | ArrayBuffer): BlobPart {
  if (typeof content === "string" || content instanceof ArrayBuffer) return content;
  return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonOrText(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => "");
}

async function readCloudflareResult<T>(response: Response): Promise<CloudflareResultRead<T>> {
  const body = await readJsonOrText(response);
  if (body && typeof body === "object" && !Array.isArray(body) && "result" in body) {
    const result = (body as { result?: T | null }).result ?? null;
    return {
      result,
      ...(!response.ok || result == null ? { errorText: JSON.stringify(body) } : {}),
    };
  }
  return {
    result: response.ok ? body as T : null,
    ...(!response.ok ? { errorText: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  };
}
