import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";

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
import {
  resolveUploadedDispatchScriptVersion,
  withUsageGuardTracing,
} from "./usage-guard-config.js";
import {
  acquireUsageGuardOperationLeaseWithRetry,
  releaseUsageGuardOperationLease,
} from "./usage-guard-state.js";
import { parseJsonBounded } from "./chat-thread/bounded-json-parse.js";
import { utf8ByteLength } from "./chat-thread/utf8-byte-length.js";

// Artifact rollback is admitted only below a 4 MiB aggregate module ceiling.
// Restoring the prior width of 16 improves WebCrypto latency for many small
// modules without widening the already-retained aggregate byte floor.
export const DIRECT_DEPLOY_ARTIFACT_MODULE_CONCURRENCY = 16;
export const DIRECT_DEPLOY_MODULE_MAX_FILES =
  CHAT_RUNTIME_BOUNDS.toolTransferFilesPerCall;
export const DIRECT_DEPLOY_MODULE_MAX_FILE_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const DIRECT_DEPLOY_ASSET_MAX_FILES =
  CHAT_RUNTIME_BOUNDS.providerJsonEntries;
export const DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const DIRECT_DEPLOY_ASSET_MAX_TOTAL_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferBytesPerCall;
export const DIRECT_DEPLOY_ASSET_MAX_METADATA_BYTES = 4 * 1024 * 1024;
export const DIRECT_DEPLOY_ASSET_BUCKET_MAX_BYTES = 16 * 1024 * 1024;
const DIRECT_DEPLOY_PATH_MAX_BYTES = CHAT_RUNTIME_BOUNDS.selfhostAgentPathChars;
const DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_MODULE_BYTES = 4 * 1024 * 1024;
const DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const DIRECT_DEPLOY_RESPONSE_MAX_BYTES = 1024 * 1024;
const DIRECT_DEPLOY_RESPONSE_MAX_CHUNKS = 4_096;
const DIRECT_DEPLOY_STREAM_CLEANUP_MS = 1_000;
const DIRECT_DEPLOY_DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DIRECT_DEPLOY_MIN_DISPATCH_WINDOW_MS = 25;
export const DIRECT_DEPLOY_CALLER_RESERVE_MS = 5_000;

const TrustedAbortController = AbortController;
const trustedSetTimeout = globalThis.setTimeout.bind(globalThis);
const trustedClearTimeout = globalThis.clearTimeout.bind(globalThis);

export class DirectDeployDeadlineExceededError extends Error {
  readonly code = "DIRECT_DEPLOY_DEADLINE_EXCEEDED";

  constructor(subject: string) {
    super(`Direct deploy deadline exceeded while ${subject}`);
    this.name = "DirectDeployDeadlineExceededError";
  }
}

/**
 * A non-cancellable write was dispatched but did not settle before the
 * attempt's absolute deadline. Callers must treat this as terminal: retrying
 * could duplicate an effect whose late outcome cannot be observed safely.
 */
export class DirectDeployOutcomeUnknownError extends Error {
  readonly code = "DIRECT_DEPLOY_OUTCOME_UNKNOWN";
  readonly outcomeUnknown = true;

  constructor(subject: string) {
    super(
      `Direct deploy deadline exceeded after dispatching ${subject}; outcome is unknown and must not be retried automatically`,
    );
    this.name = "DirectDeployOutcomeUnknownError";
  }
}

export interface DirectDispatchDeployOptions {
  fetcher?: typeof fetch;
  /**
   * Every await inside the callback must use the supplied scope. This prevents
   * a late first await from resuming into a second registration write after
   * the deploy attempt has already returned.
   */
  onDeploySideEffects?: (
    info: DeploySideEffectsInfo,
    scope: DirectDeployEffectScope,
  ) => Promise<void>;
  /** Absolute Unix epoch millisecond at which this whole attempt must stop. */
  deadlineAt?: number;
}

export interface DirectDeployEffectScope {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly isActive: boolean;
  assertActive(subject: string): void;
  read<T>(subject: string, start: () => Promise<T>): Promise<T>;
  write<T>(subject: string, start: () => Promise<T>): Promise<T>;
  bindD1(database: D1Database): D1Database;
}

type DirectDeployAwaitKind = "read" | "write";

class DirectDeployAttemptDeadline {
  readonly deadlineAt: number;
  private expired = false;
  private readonly fetchControllers = new Set<AbortController>();
  private readonly lifecycleController = new TrustedAbortController();

  constructor(deadlineAt: number | undefined) {
    const resolved =
      deadlineAt ?? Date.now() + DIRECT_DEPLOY_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(resolved) || !Number.isSafeInteger(resolved)) {
      throw new Error(
        "Direct deploy deadlineAt must be a finite epoch millisecond",
      );
    }
    this.deadlineAt = resolved;
    this.assertCanDispatch("starting the deploy attempt");
  }

  get isActive(): boolean {
    return !this.expired && Date.now() < this.deadlineAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  effectScope(): DirectDeployEffectScope {
    const getIsActive = () => this.isActive;
    return {
      deadlineAt: this.deadlineAt,
      signal: this.lifecycleController.signal,
      get isActive() {
        return getIsActive();
      },
      assertActive: (subject) => this.assertActive(subject),
      read: (subject, start) => this.read(subject, start),
      write: (subject, start) => this.write(subject, start),
      bindD1: (database) => bindD1ToDirectDeployDeadline(database, this),
    };
  }

  assertActive(subject: string): void {
    if (!this.isActive) {
      this.expire();
      throw new DirectDeployDeadlineExceededError(subject);
    }
  }

  assertCanDispatch(subject: string): void {
    if (
      this.expired ||
      this.deadlineAt - Date.now() < DIRECT_DEPLOY_MIN_DISPATCH_WINDOW_MS
    ) {
      this.expire();
      throw new DirectDeployDeadlineExceededError(subject);
    }
  }

  async read<T>(subject: string, start: () => Promise<T>): Promise<T> {
    return this.run(subject, "read", start);
  }

  async write<T>(subject: string, start: () => Promise<T>): Promise<T> {
    return this.run(subject, "write", start);
  }

  wrapFetcher(fetcher: typeof fetch): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const kind: DirectDeployAwaitKind =
        method === "GET" || method === "HEAD" ? "read" : "write";
      const subject = `Cloudflare ${method} request`;
      this.assertCanDispatch(subject);
      const controller = new TrustedAbortController();
      this.fetchControllers.add(controller);
      return this.run(
        subject,
        kind,
        () => fetcher(input, { ...init, signal: controller.signal }),
        kind === "write",
      );
    }) as typeof fetch;
  }

  async sleep(milliseconds: number): Promise<void> {
    await this.read("waiting for the deploy operation lease", () => {
      return new Promise<void>((resolve) => {
        const timer = trustedSetTimeout(resolve, Math.max(0, milliseconds));
        // The absolute-deadline timer in run() wins first when necessary. The
        // late timer merely resolves an already-observed promise.
        void timer;
      });
    });
  }

  async confirmStreamCancellation(
    subject: string,
    cancel: () => Promise<unknown>,
  ): Promise<void> {
    const operation = Promise.resolve().then(cancel);
    operation.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      operation.then(
        () => ({ kind: "confirmed" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = trustedSetTimeout(
          () => resolve({ kind: "timeout" }),
          DIRECT_DEPLOY_STREAM_CLEANUP_MS,
        );
      }),
    ]);
    if (timer !== undefined) trustedClearTimeout(timer);
    if (outcome.kind === "confirmed") return;
    this.expire();
    const detail =
      outcome.kind === "rejected" ? `: ${errorMessage(outcome.error)}` : "";
    throw new Error(
      `${subject} cancellation could not be confirmed within ${DIRECT_DEPLOY_STREAM_CLEANUP_MS}ms${detail}`,
    );
  }

  private async run<T>(
    subject: string,
    kind: DirectDeployAwaitKind,
    start: () => Promise<T>,
    unknownOnRejection = false,
  ): Promise<T> {
    this.assertCanDispatch(subject);
    const operation = Promise.resolve().then(start);
    // Promise.race does attach handlers, but retain an explicit observer so a
    // late storage/fetch rejection can never become unhandled after timeout.
    operation.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = trustedSetTimeout(() => {
        const timeoutError =
          kind === "write"
            ? new DirectDeployOutcomeUnknownError(subject)
            : new DirectDeployDeadlineExceededError(subject);
        // Queue the authoritative timeout result before aborting the fetch;
        // otherwise an abort-aware mock/runtime can race in with a generic
        // AbortError and erase the terminal outcome-unknown classification.
        reject(timeoutError);
        this.expire();
      }, this.remainingMs);
    });
    try {
      const result = await Promise.race([operation, timeout]);
      // Settlement is authoritative even if the wall clock crossed between
      // resolution and this continuation. Preserve a confirmed write result
      // (notably a 2xx script PUT), expire the attempt, and let the next effect
      // be skipped. A read that settles too late remains unusable.
      if (!this.isActive) {
        this.expire();
        if (kind === "read") {
          throw new DirectDeployDeadlineExceededError(`finishing ${subject}`);
        }
      }
      return result;
    } catch (error) {
      if (
        unknownOnRejection &&
        !(error instanceof DirectDeployOutcomeUnknownError)
      ) {
        throw new DirectDeployOutcomeUnknownError(
          `${subject} (${errorMessage(error)})`,
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) trustedClearTimeout(timer);
    }
  }

  private expire(): void {
    if (this.expired) return;
    this.expired = true;
    try {
      this.lifecycleController.abort(
        "Direct deploy absolute deadline exceeded",
      );
    } catch {
      // The promise fence remains authoritative if abort itself fails.
    }
    for (const controller of this.fetchControllers) {
      try {
        controller.abort("Direct deploy absolute deadline exceeded");
      } catch {
        // Abort is best effort; the bounded promise still fences late results.
      }
    }
    this.fetchControllers.clear();
  }
}

function bindD1ToDirectDeployDeadline(
  database: D1Database,
  deadline: DirectDeployAttemptDeadline,
): D1Database {
  const rawStatements = new WeakMap<object, D1PreparedStatement>();
  const wrapStatement = (
    statement: D1PreparedStatement,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "bind") {
          return (...values: unknown[]) =>
            wrapStatement(target.bind(...values));
        }
        if (property === "run") {
          return (...args: unknown[]) =>
            deadline.write(
              "a D1 deploy write",
              () => Reflect.apply(target.run, target, args) as Promise<unknown>,
            );
        }
        if (property === "all" || property === "first" || property === "raw") {
          return (...args: unknown[]) =>
            deadline.read(
              "a D1 deploy read",
              () =>
                Reflect.apply(
                  Reflect.get(target, property) as (
                    ...input: unknown[]
                  ) => unknown,
                  target,
                  args,
                ) as Promise<unknown>,
            );
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    rawStatements.set(wrapped, statement);
    return wrapped;
  };

  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) =>
          deadline.write("a D1 deploy batch", () =>
            target.batch(
              statements.map(
                (statement) => rawStatements.get(statement) ?? statement,
              ),
            ),
          );
      }
      if (property === "exec") {
        return (query: string) =>
          deadline.write("a D1 deploy exec", () => target.exec(query));
      }
      if (property === "dump") {
        return () => deadline.read("a D1 deploy dump", () => target.dump());
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runOptionalAfterPublished<T>(
  deadline: DirectDeployAttemptDeadline,
  warnings: string[],
  subject: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (!deadline.isActive) {
    warnings.push(`${subject} skipped because the deploy deadline elapsed`);
    return undefined;
  }
  try {
    return await operation();
  } catch (error) {
    warnings.push(
      `${subject} unavailable after publish: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

// Small assets are latency-bound, so admit up to eight reads. Fingerprinting's
// weight conservatively includes the raw bytes plus six base64-sized buffers:
// worst-case UTF-16 base64/template strings, TextEncoder output, and the copy
// sha256Hex makes for WebCrypto. Thus one maximum file (about 72 MiB of modeled
// live payload) fits, two do not, while many small files still overlap.
export const DIRECT_DEPLOY_ASSET_FINGERPRINT_CONCURRENCY = 8;
function directDeployAssetFingerprintWeightBytes(size: number): number {
  const base64Bytes = 4 * Math.ceil(size / 3);
  return size + 6 * base64Bytes;
}
export const DIRECT_DEPLOY_ASSET_FINGERPRINT_MAX_IN_FLIGHT_WEIGHT_BYTES =
  directDeployAssetFingerprintWeightBytes(DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES);
export const DIRECT_DEPLOY_ASSET_FINGERPRINT_MAX_IN_FLIGHT_RAW_BYTES =
  DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES;

// Rollback writes retain raw bytes only. Use the same adaptive lane count and
// raw-byte budget so small R2 writes overlap without widening the maximum-file
// memory floor. The pool drains already-started writes after any failure.
export const DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY = 8;
export const DIRECT_DEPLOY_ASSET_ROLLBACK_MAX_IN_FLIGHT_BYTES =
  2 * DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES;

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
  record(): Promise<DirectDeployArtifactCacheRecord>;
};

type CloudflareResultRead<T> = {
  result: T | null;
  errorText?: string;
};

export async function deployWorkerModulesDirect(
  env: DirectDispatchDeployEnv,
  request: DirectDispatchDeployRequest,
  options: DirectDispatchDeployOptions = {},
): Promise<DirectDispatchDeployResult> {
  const startedAt = Date.now();
  const deadline = new DirectDeployAttemptDeadline(options.deadlineAt);
  const fetcher = deadline.wrapFetcher(options.fetcher ?? fetch);
  const admitted = validateDirectDeployRequestBounds(request);
  const selfhostPublishingMode = isSelfhostDirectPublishingMode(env);
  const requestedAssets = request.assets ?? [];
  const skippedAssets: DirectDeploySkippedAsset[] = [];
  const warnings: string[] = [];
  const prepareAssetsStartedAt = Date.now();
  // Reject known-oversized files before read() transfers their base64 payload
  // over sandbox RPC, where the transport otherwise fails opaquely.
  const preparedAssets = await fingerprintDirectAssets(
    requestedAssets,
    deadline,
  );
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
    moduleBytes: admitted.moduleBytes,
    assetBytes: preparedAssets.reduce((sum, asset) => sum + asset.size, 0),
  };
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const workerServiceName = env.CF_WORKER_NAME?.trim();
  const tailWorkerName = env.TAIL_WORKER_NAME?.trim();
  if (
    !request.modules.some(
      (module) => module.name === request.metadata.main_module,
    )
  ) {
    throw new Error(
      `Direct deploy bundle is missing main module: ${request.metadata.main_module}`,
    );
  }

  const validation = validateBindings(request.metadata.bindings ?? []);
  if (!validation.valid) {
    const forbiddenList = validation.forbiddenBindings
      .map((binding) => `${binding.name} (${binding.type})`)
      .join(", ");
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
      deadline,
    );
  }
  if (!cfApiToken)
    throw new Error("CF_API_TOKEN is required for direct deploy");
  if (!accountId)
    throw new Error("CF_ACCOUNT_ID is required for direct deploy");
  if (!dispatchNamespace)
    throw new Error("CF_DISPATCH_NAMESPACE is required for direct deploy");
  if (!workerServiceName)
    throw new Error("CF_WORKER_NAME is required for direct deploy");
  const nativeAssetsStartedAt = Date.now();
  const nativeAssets = await uploadNativeWorkerAssets(
    env,
    dispatchNamespace,
    dispatchScriptName,
    request,
    preparedAssets,
    fetcher,
    deadline,
  );
  timings.nativeAssetsMs = Date.now() - nativeAssetsStartedAt;
  let assetsRecord: SelfhostAssetsRecord | null = null;
  let startAssetsStore: (() => Promise<void>) | null = null;
  let storeAssetsTask: Promise<void> | null = null;
  const ensureAssetsStored = (): Promise<void> => {
    if (!storeAssetsTask) {
      storeAssetsTask = startAssetsStore?.() ?? Promise.resolve();
    }
    return storeAssetsTask;
  };
  const storeAssetsStartedAt = Date.now();
  try {
    const preparedStore = prepareDirectAssetsRecord(
      env,
      dispatchScriptName,
      request,
      preparedAssets,
      deadline,
    );
    assetsRecord = preparedStore.record;
    startAssetsStore = preparedStore.store;
    if (!nativeAssets) await ensureAssetsStored();
  } catch (error) {
    if (!nativeAssets) throw error;
    warnings.push(
      `Deploy asset rollback cache unavailable: ${errorMessage(error)}`,
    );
    startAssetsStore = null;
    storeAssetsTask = null;
    assetsRecord = null;
  }
  timings.storeAssetsMs = Date.now() - storeAssetsStartedAt;
  const bindings = normalizedDirectBindings(request.metadata).filter(
    (binding) => nativeAssets || binding.type !== "assets",
  );
  const migrationsStartedAt = Date.now();
  const migrations = await migrationsForDirectDeploy(
    accountId,
    dispatchNamespace,
    dispatchScriptName,
    request.metadata,
    cfApiToken,
    fetcher,
    deadline,
  );
  timings.migrationsMs = Date.now() - migrationsStartedAt;
  const metadata: DirectWorkerMetadata = withUsageGuardTracing({
    ...request.metadata,
    migrations,
    assets: nativeAssets ? { jwt: nativeAssets.jwt } : undefined,
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
      ? {
          tail_consumers: withPlatformTailConsumer(
            request.metadata.tail_consumers,
            tailWorkerName,
          ),
        }
      : {}),
  });
  let artifactCacheKey: string | undefined;
  let preparedArtifactCache: PreparedDeployArtifactCache | undefined;
  const artifactCacheStartedAt = Date.now();
  try {
    preparedArtifactCache = await prepareDeployArtifactCache(env, {
      scriptName: request.scriptName,
      dispatchScriptName,
      identity: request.identity,
      metadata,
      modules: request.modules,
      assetsRecord,
    });
  } catch (error) {
    warnings.push(`Deploy artifact cache unavailable: ${errorMessage(error)}`);
  }
  timings.artifactCacheMs = Date.now() - artifactCacheStartedAt;
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const module of request.modules) {
    form.append(
      module.name,
      new Blob([blobPart(module.content)], { type: module.contentType }),
      module.name,
    );
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(dispatchScriptName)}`;
  const cloudflareUploadStartedAt = Date.now();
  const operationLeaseHolder = crypto.randomUUID();
  const operationAppId = `${request.identity.orgId}:${request.scriptName}`;
  const leaseDb = env.APP_DB
    ? bindD1ToDirectDeployDeadline(env.APP_DB, deadline)
    : undefined;
  let operationLeaseAcquired = false;
  if (
    leaseDb &&
    !(
      await acquireUsageGuardOperationLeaseWithRetry(
        {
          db: leaseDb,
          appId: operationAppId,
          holder: operationLeaseHolder,
        },
        {
          sleep: (milliseconds) => deadline.sleep(milliseconds),
        },
      )
    ).acquired
  ) {
    throw new Error("App deployment is temporarily busy; retry shortly");
  }
  operationLeaseAcquired = Boolean(leaseDb);
  const releaseOperationLease = async (): Promise<void> => {
    if (!leaseDb || !operationLeaseAcquired) return;
    await releaseUsageGuardOperationLease({
      db: leaseDb,
      appId: operationAppId,
      holder: operationLeaseHolder,
    });
    deadline.assertActive("finishing the deploy operation lease release");
    operationLeaseAcquired = false;
  };
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfApiToken}` },
      body: form,
    });
  } catch (error) {
    if (deadline.isActive) {
      await releaseOperationLease();
    }
    throw error;
  }
  timings.cloudflareUploadMs = Date.now() - cloudflareUploadStartedAt;
  let body: unknown = null;
  try {
    body = await readJsonOrText(response, deadline);
  } catch (error) {
    warnings.push(
      `Cloudflare deploy response body unavailable: ${errorMessage(error)}`,
    );
  }

  let scriptVersion: string | undefined;
  if (response.ok) {
    scriptVersion = await runOptionalAfterPublished(
      deadline,
      warnings,
      "Deployed script version lookup",
      () =>
        deadline.read("resolving the deployed script version", () =>
          resolveUploadedDispatchScriptVersion({
            uploadBody: body,
            accountId,
            dispatchNamespace,
            dispatchScriptName,
            apiToken: cfApiToken,
            fetcher,
          }),
        ),
    );
    if (assetsRecord) {
      const publishAssetsStartedAt = Date.now();
      await runOptionalAfterPublished(
        deadline,
        warnings,
        "Deploy asset rollback cache",
        async () => {
          await ensureAssetsStored();
          deadline.assertActive("publishing the deploy asset record");
          await publishDirectAssetsRecord(
            env,
            dispatchScriptName,
            assetsRecord,
            deadline,
          );
        },
      );
      timings.publishAssetsRecordMs = Date.now() - publishAssetsStartedAt;
    }
    if (preparedArtifactCache) {
      const artifactCacheStoreStartedAt = Date.now();
      const stored = await runOptionalAfterPublished(
        deadline,
        warnings,
        "Deploy artifact cache",
        async () => {
          await ensureAssetsStored();
          deadline.assertActive("storing the deploy artifact cache");
          await storePreparedDeployArtifactCache(
            env,
            preparedArtifactCache,
            deadline,
          );
          return true;
        },
      );
      if (stored) artifactCacheKey = preparedArtifactCache.key;
      timings.artifactCacheMs += Date.now() - artifactCacheStoreStartedAt;
    }
  } else if (deadline.isActive) {
    await releaseOperationLease();
  } else if (operationLeaseAcquired) {
    warnings.push(
      "Deploy operation lease release skipped because the deploy deadline elapsed",
    );
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
    configPath:
      typeof request.metadata.config_path === "string"
        ? request.metadata.config_path
        : undefined,
    commitSha: request.commitSha,
    artifactCacheKey,
    scriptVersion,
  };
  if (response.ok && options.onDeploySideEffects) {
    await runOptionalAfterPublished(
      deadline,
      warnings,
      "Deploy registration",
      () =>
        deadline.write("deploy registration", () =>
          options.onDeploySideEffects!(sideEffects, deadline.effectScope()),
        ),
    );
  }
  if (response.ok) {
    // Release ownership last. Until every optional cache/registration effect
    // has either settled or been fenced, the lease prevents a newer attempt
    // from overlapping and being reordered by a late continuation.
    await runOptionalAfterPublished(
      deadline,
      warnings,
      "Deploy operation lease release",
      releaseOperationLease,
    );
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
    ...(response.ok
      ? { result: body }
      : {
          error:
            typeof body === "string"
              ? body
              : body === null
                ? `Cloudflare deploy failed with HTTP ${response.status}`
                : JSON.stringify(body),
        }),
  };
}

function isSelfhostDirectPublishingMode(env: DirectDispatchDeployEnv): boolean {
  const accountId = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  const namespace = env.CF_DISPATCH_NAMESPACE?.trim().toLowerCase();
  return accountId === "selfhost" || namespace === "selfhost";
}

function validateDirectDeployRequestBounds(
  request: DirectDispatchDeployRequest,
): { moduleBytes: number; assetBytes: number } {
  if (request.modules.length > DIRECT_DEPLOY_MODULE_MAX_FILES) {
    throw new Error(
      `Direct deploy modules exceed the ${DIRECT_DEPLOY_MODULE_MAX_FILES} file limit`,
    );
  }
  const moduleNames = new Set<string>();
  let moduleBytes = 0;
  for (const module of request.modules) {
    assertDirectDeployPath(module.name, "module");
    if (moduleNames.has(module.name)) {
      throw new Error(
        `Direct deploy contains duplicate module: ${module.name}`,
      );
    }
    moduleNames.add(module.name);
    const size = directContentByteLength(module.content);
    if (size > DIRECT_DEPLOY_MODULE_MAX_FILE_BYTES) {
      throw new Error(
        `Direct deploy module ${module.name} exceeds the ${DIRECT_DEPLOY_MODULE_MAX_FILE_BYTES} byte limit`,
      );
    }
    if (size > DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES - moduleBytes) {
      throw new Error(
        `Direct deploy modules exceed the ${DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES} aggregate byte limit`,
      );
    }
    moduleBytes += size;
  }

  const assets = request.assets ?? [];
  if (assets.length > DIRECT_DEPLOY_ASSET_MAX_FILES) {
    throw new Error(
      `Direct deploy assets exceed the ${DIRECT_DEPLOY_ASSET_MAX_FILES} file limit`,
    );
  }
  const assetPaths = new Set<string>();
  let assetBytes = 0;
  let metadataBytes = 0;
  for (const asset of assets) {
    assertDirectDeployPath(asset.path, "asset");
    const normalizedPath = normalizeSelfhostAssetPath(asset.path);
    if (assetPaths.has(normalizedPath)) {
      throw new Error(
        `Direct deploy contains duplicate asset path: ${normalizedPath}`,
      );
    }
    assetPaths.add(normalizedPath);
    const pathBytes = utf8ByteLength(asset.path);
    const contentTypeBytes = asset.contentType
      ? utf8ByteLength(asset.contentType)
      : 0;
    if (
      contentTypeBytes > DIRECT_DEPLOY_PATH_MAX_BYTES ||
      pathBytes + contentTypeBytes >
        DIRECT_DEPLOY_ASSET_MAX_METADATA_BYTES - metadataBytes
    ) {
      throw new Error("Direct deploy asset metadata exceeds its byte limits");
    }
    metadataBytes += pathBytes + contentTypeBytes;
    if (
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      asset.size > DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES
    ) {
      throw new Error(
        `Direct deploy asset ${asset.path} exceeds the ${DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES} byte limit`,
      );
    }
    if (asset.size > DIRECT_DEPLOY_ASSET_MAX_TOTAL_BYTES - assetBytes) {
      throw new Error(
        `Direct deploy assets exceed the ${DIRECT_DEPLOY_ASSET_MAX_TOTAL_BYTES} aggregate byte limit`,
      );
    }
    assetBytes += asset.size;
  }
  return { moduleBytes, assetBytes };
}

function assertDirectDeployPath(
  path: unknown,
  kind: string,
): asserts path is string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    path.length > DIRECT_DEPLOY_PATH_MAX_BYTES ||
    utf8ByteLength(path) > DIRECT_DEPLOY_PATH_MAX_BYTES
  ) {
    throw new Error(
      `Direct deploy ${kind} path exceeds the ${DIRECT_DEPLOY_PATH_MAX_BYTES} byte limit`,
    );
  }
}

function directContentByteLength(
  content: DirectWorkerModule["content"],
): number {
  const size =
    typeof content === "string" ? utf8ByteLength(content) : content?.byteLength;
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error("Direct deploy module content has an invalid byte length");
  }
  return size as number;
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
      const content =
        type === "data" || type === "wasm"
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
  options: DirectDispatchDeployOptions,
  deadline: DirectDeployAttemptDeadline,
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
    deadline,
  );
  await preparedStore.store?.();
  if (preparedStore.record) {
    await publishDirectAssetsRecord(
      env,
      dispatchScriptName,
      preparedStore.record,
      deadline,
    );
  }
  timings.storeAssetsMs = Date.now() - storeAssetsStartedAt;

  await deadline.write("publishing the self-host worker record", () =>
    env.APP_KV!.put(
      selfhostWorkerKey(dispatchScriptName),
      JSON.stringify(record),
    ),
  );

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
      const stored = await runOptionalAfterPublished(
        deadline,
        warnings,
        "Deploy artifact cache",
        async () => {
          await storePreparedDeployArtifactCache(
            env,
            preparedArtifactCache,
            deadline,
          );
          return true;
        },
      );
      if (stored) artifactCacheKey = preparedArtifactCache.key;
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
  if (options.onDeploySideEffects) {
    await runOptionalAfterPublished(
      deadline,
      warnings,
      "Deploy registration",
      () =>
        deadline.write("deploy registration", () =>
          options.onDeploySideEffects!(sideEffects, deadline.effectScope()),
        ),
    );
  }

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

async function migrationsForDirectDeploy(
  accountId: string,
  dispatchNamespace: string,
  dispatchScriptName: string,
  metadata: DirectWorkerMetadata,
  cfApiToken: string,
  fetcher: typeof fetch,
  deadline: DirectDeployAttemptDeadline,
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
    if (
      !migration ||
      typeof migration !== "object" ||
      Array.isArray(migration)
    ) {
      throw new Error("Deploy migrations must be objects");
    }
    const tag = (migration as Record<string, unknown>).tag;
    if (typeof tag !== "string" || !tag.trim()) {
      throw new Error("Deploy migration entries must include a string tag");
    }
    return tag;
  });
  const latestTag = migrationTags[migrationTags.length - 1]!;
  const currentTag = await readCurrentWorkerMigrationTag(
    accountId,
    dispatchNamespace,
    dispatchScriptName,
    cfApiToken,
    fetcher,
    deadline,
  );
  if (currentTag) {
    const currentIndex = migrationTags.findIndex((tag) => tag === currentTag);
    if (currentIndex === migrationTags.length - 1) return undefined;
    const pendingMigrations =
      currentIndex === -1
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
        if (
          !consumer ||
          typeof consumer !== "object" ||
          Array.isArray(consumer)
        )
          return false;
        // Drop only the exact platform consumer we are about to add (same
        // service, no environment scope). Wrangler treats a consumer with an
        // `environment` as distinct, so environment-scoped consumers for the
        // same service are preserved.
        const { service, environment } = consumer as {
          service?: unknown;
          environment?: unknown;
        };
        const isExactPlatformConsumer =
          service === tailWorkerName && environment == null;
        return !isExactPlatformConsumer;
      })
    : [];
  return [...preserved, { service: tailWorkerName }];
}

function migrationStepsForUpload(
  migrations: unknown[],
): Array<Record<string, unknown>> {
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
  deadline: DirectDeployAttemptDeadline,
): Promise<string | undefined> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(dispatchScriptName)}`;
  const response = await fetcher(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${cfApiToken}` },
  });
  const body = await readJsonOrText(response, deadline);
  if (!response.ok) {
    if (
      response.status === 404 ||
      cloudflareErrorCodes(body).some((code) => code === 10092)
    )
      return undefined;
    throw new Error(
      `Failed to read existing Worker migration tag: ${cloudflareBodyText(body)}`,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const result = (body as { result?: unknown }).result;
  const script =
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "script" in result
      ? (result as { script?: unknown }).script
      : result;
  if (!script || typeof script !== "object" || Array.isArray(script))
    return undefined;
  const migrationTag = (script as { migration_tag?: unknown }).migration_tag;
  return typeof migrationTag === "string" && migrationTag.trim()
    ? migrationTag.trim()
    : undefined;
}

function cloudflareErrorCodes(body: unknown): number[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((error) => {
      if (!error || typeof error !== "object" || Array.isArray(error))
        return undefined;
      return (error as { code?: unknown }).code;
    })
    .filter((code): code is number => typeof code === "number");
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
  deadline: DirectDeployAttemptDeadline,
): Promise<NativeAssetsUploadResult | null> {
  if (!request.metadata.assets || preparedAssets.length === 0) return null;
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  if (!cfApiToken || !accountId)
    throw new Error(
      "Cloudflare credentials are required for direct deploy assets",
    );

  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const asset of preparedAssets) {
    manifest[asset.cfPath] = { hash: asset.cfHash, size: asset.size };
  }

  const sessionUrl =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
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
  const sessionBody = await readCloudflareResult<AssetUploadSessionResult>(
    sessionResponse,
    deadline,
  );
  if (!sessionResponse.ok || !sessionBody.result) {
    throw new Error(
      `Asset upload session failed: ${sessionBody.errorText ?? "missing result"}`,
    );
  }
  const uploadJwt = sessionBody.result.jwt;
  const buckets = sessionBody.result.buckets ?? [];
  if (!uploadJwt)
    throw new Error("Asset upload session did not return an upload token");
  if (buckets.length === 0)
    return { jwt: uploadJwt, assetCount: preparedAssets.length };

  const entriesByHash = new Map(
    preparedAssets.map((asset) => [asset.cfHash, asset]),
  );
  validateNativeAssetUploadBuckets(buckets, entriesByHash);
  const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`;
  // Upload one bucket at a time (see DIRECT_DEPLOY_ASSET_UPLOAD_CONCURRENCY) and
  // re-read each asset's bytes here rather than carrying base64 through from the
  // fingerprint pass, so only the current bucket's payloads live in memory.
  const uploadResults = await mapWithConcurrency(
    buckets,
    DIRECT_DEPLOY_ASSET_UPLOAD_CONCURRENCY,
    async (bucket) => {
      const form = new FormData();
      for (const hash of bucket) {
        const entry = entriesByHash.get(hash);
        if (!entry)
          throw new Error(
            `Asset upload bucket referenced unknown hash: ${hash}`,
          );
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
      const uploadBody = await readCloudflareResult<AssetUploadResult>(
        uploadResponse,
        deadline,
      );
      if (!uploadResponse.ok || !uploadBody.result) {
        throw new Error(
          `Asset upload failed: ${uploadBody.errorText ?? "missing result"}`,
        );
      }
      return uploadBody.result.jwt;
    },
  );
  const completionJwt =
    uploadResults.find(
      (jwt): jwt is string => typeof jwt === "string" && jwt.length > 0,
    ) ?? "";
  if (!completionJwt)
    throw new Error("Asset upload completed without a completion token");
  return { jwt: completionJwt, assetCount: preparedAssets.length };
}

export async function rollbackWorkerDeployFromArtifactCache(
  env: DirectDispatchDeployEnv,
  request: DirectDeployRollbackRequest,
  options: DirectDispatchDeployOptions = {},
): Promise<DirectDispatchDeployResult> {
  const deadline = new DirectDeployAttemptDeadline(options.deadlineAt);
  const warnings: string[] = [];
  const cfApiToken = env.CF_API_TOKEN?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const tailWorkerName = env.TAIL_WORKER_NAME?.trim();
  const fetcher = deadline.wrapFetcher(options.fetcher ?? fetch);
  if (!cfApiToken)
    throw new Error("CF_API_TOKEN is required for direct rollback");
  if (!accountId)
    throw new Error("CF_ACCOUNT_ID is required for direct rollback");
  if (!dispatchNamespace)
    throw new Error("CF_DISPATCH_NAMESPACE is required for direct rollback");
  if (!env.R2_BUCKET)
    throw new Error("R2_BUCKET is required for direct rollback");

  const artifactCacheKey = request.artifactCacheKey.trim();
  if (!artifactCacheKey)
    throw new Error("artifactCacheKey is required for direct rollback");
  const object = await deadline.read("reading the deploy artifact cache", () =>
    env.R2_BUCKET!.get(artifactCacheKey),
  );
  if (!object)
    throw new Error(`Deploy artifact cache not found: ${artifactCacheKey}`);
  const artifactText = await readR2TextBounded(
    object,
    DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_BYTES,
    "Deploy artifact cache",
    deadline,
  );
  const record = validateArtifactCacheRecord(
    parseJsonBounded(artifactText, {
      maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
      maxTokens: 100_000,
      maxNodes: 50_000,
      maxEntries: 25_000,
      maxStrings: 25_000,
      maxStringCodeUnits: DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_BYTES,
    }),
    artifactCacheKey,
  );
  if (
    request.expected?.orgId &&
    record.identity.orgId !== request.expected.orgId
  ) {
    throw new Error("Deploy artifact cache belongs to a different org");
  }
  if (
    request.expected?.workspaceId &&
    record.identity.workspaceId !== request.expected.workspaceId
  ) {
    throw new Error("Deploy artifact cache belongs to a different workspace");
  }
  if (
    request.expected?.scriptName &&
    record.scriptName !== request.expected.scriptName
  ) {
    throw new Error("Deploy artifact cache belongs to a different app");
  }

  let metadata = record.metadata;
  if (record.assetsRecord) {
    const assets = loadDirectAssetsFromRecord(
      env,
      record.dispatchScriptName,
      record.assetsRecord,
      deadline,
    );
    const preparedAssets = await fingerprintDirectAssets(assets, deadline);
    const nativeAssets = await uploadNativeWorkerAssets(
      env,
      dispatchNamespace,
      record.dispatchScriptName,
      {
        scriptName: record.scriptName,
        hostname: request.hostname,
        identity: record.identity,
        metadata: record.metadata,
        modules: [],
        assets,
      },
      preparedAssets,
      fetcher,
      deadline,
    );
    metadata = nativeAssets
      ? { ...record.metadata, assets: { jwt: nativeAssets.jwt } }
      : record.metadata;
  }

  // Re-apply the platform tail consumer so rolling back to an artifact cached
  // before this behavior existed (or under a different tail worker name) still
  // forwards logs to WorkerLogsDO. Idempotent for artifacts already carrying it.
  if (tailWorkerName) {
    metadata = {
      ...metadata,
      tail_consumers: withPlatformTailConsumer(
        metadata.tail_consumers,
        tailWorkerName,
      ),
    };
  }
  metadata = withUsageGuardTracing(metadata);

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const module of record.modules) {
    form.append(
      module.name,
      new Blob([base64ToBytes(module.contentBase64) as BlobPart], {
        type: module.contentType,
      }),
      module.name,
    );
  }

  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(record.dispatchScriptName)}`;
  const operationLeaseHolder = crypto.randomUUID();
  const operationAppId = `${record.identity.orgId}:${record.scriptName}`;
  const leaseDb = env.APP_DB
    ? bindD1ToDirectDeployDeadline(env.APP_DB, deadline)
    : undefined;
  let operationLeaseAcquired = false;
  if (
    leaseDb &&
    !(
      await acquireUsageGuardOperationLeaseWithRetry(
        {
          db: leaseDb,
          appId: operationAppId,
          holder: operationLeaseHolder,
        },
        {
          sleep: (milliseconds) => deadline.sleep(milliseconds),
        },
      )
    ).acquired
  ) {
    throw new Error("App deployment is temporarily busy; retry shortly");
  }
  operationLeaseAcquired = Boolean(leaseDb);
  const releaseOperationLease = async (): Promise<void> => {
    if (!leaseDb || !operationLeaseAcquired) return;
    await releaseUsageGuardOperationLease({
      db: leaseDb,
      appId: operationAppId,
      holder: operationLeaseHolder,
    });
    deadline.assertActive("finishing the rollback operation lease release");
    operationLeaseAcquired = false;
  };
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfApiToken}` },
      body: form,
    });
  } catch (error) {
    if (deadline.isActive) await releaseOperationLease();
    throw error;
  }
  let body: unknown = null;
  try {
    body = await readJsonOrText(response, deadline);
  } catch (error) {
    warnings.push(
      `Cloudflare rollback response body unavailable: ${errorMessage(error)}`,
    );
  }
  let scriptVersion: string | undefined;
  if (response.ok) {
    scriptVersion = await runOptionalAfterPublished(
      deadline,
      warnings,
      "Rolled-back script version lookup",
      () =>
        deadline.read("resolving the rolled-back script version", () =>
          resolveUploadedDispatchScriptVersion({
            uploadBody: body,
            accountId,
            dispatchNamespace,
            dispatchScriptName: record.dispatchScriptName,
            apiToken: cfApiToken,
            fetcher,
          }),
        ),
    );
    if (record.assetsRecord) {
      await runOptionalAfterPublished(
        deadline,
        warnings,
        "Rollback asset record",
        () =>
          publishDirectAssetsRecord(
            env,
            record.dispatchScriptName,
            record.assetsRecord!,
            deadline,
          ),
      );
    }
  } else if (deadline.isActive) {
    await releaseOperationLease();
  } else if (operationLeaseAcquired) {
    warnings.push(
      "Rollback operation lease release skipped because the deploy deadline elapsed",
    );
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
    configPath:
      typeof metadata.config_path === "string"
        ? metadata.config_path
        : undefined,
    artifactCacheKey,
    scriptVersion,
  };
  if (response.ok && options.onDeploySideEffects) {
    await runOptionalAfterPublished(
      deadline,
      warnings,
      "Rollback registration",
      () =>
        deadline.write("rollback registration", () =>
          options.onDeploySideEffects!(sideEffects, deadline.effectScope()),
        ),
    );
  }
  if (response.ok) {
    await runOptionalAfterPublished(
      deadline,
      warnings,
      "Rollback operation lease release",
      releaseOperationLease,
    );
  }
  return {
    success: response.ok,
    scriptName: record.scriptName,
    dispatchScriptName: record.dispatchScriptName,
    status: response.status,
    sideEffects,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(response.ok
      ? { result: body }
      : {
          error:
            typeof body === "string"
              ? body
              : body === null
                ? `Cloudflare rollback failed with HTTP ${response.status}`
                : JSON.stringify(body),
        }),
  };
}

// Return lazy handles that fetch each rollback blob from R2 on demand, so a
// rollback of an asset-heavy app streams its assets through the same bounded
// batches as a fresh deploy instead of loading every blob into the isolate.
function loadDirectAssetsFromRecord(
  env: DirectDispatchDeployEnv,
  appId: string,
  record: SelfhostAssetsRecord,
  deadline: DirectDeployAttemptDeadline,
): DirectDeployAsset[] {
  if (!env.R2_BUCKET)
    throw new Error("R2_BUCKET is required for direct deploy assets");
  return Object.entries(record.manifest).map(([path, entry]) => ({
    path,
    size: entry.size ?? 0,
    ...(entry.contentType ? { contentType: entry.contentType } : {}),
    read: async () => {
      if (!env.R2_BUCKET)
        throw new Error("R2_BUCKET is required for direct deploy assets");
      const object = await deadline.read(
        `reading rollback asset ${path} from R2`,
        () => env.R2_BUCKET!.get(selfhostAssetObjectKey(appId, entry.hash)),
      );
      if (!object)
        throw new Error(`Deploy artifact asset blob not found: ${path}`);
      if (
        !Number.isSafeInteger(object.size) ||
        object.size !== entry.size ||
        object.size > DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES
      ) {
        throw new Error(
          `Deploy artifact asset blob ${path} did not match its bounded manifest size`,
        );
      }
      return readR2BytesBounded(
        object,
        DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES,
        `Deploy artifact asset blob ${path}`,
        deadline,
        entry.size,
      );
    },
  }));
}

async function readR2BytesBounded(
  object: R2ObjectBody,
  maximumBytes: number,
  subject: string,
  deadline: DirectDeployAttemptDeadline,
  expectedSize?: number,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    object.size > maximumBytes ||
    (expectedSize !== undefined && object.size !== expectedSize)
  ) {
    throw new Error(`${subject} did not match its bounded object size`);
  }
  if (!object.body) {
    throw new Error(`${subject} does not expose a bounded body stream`);
  }
  const reader = object.body.getReader();
  const output = new Uint8Array(object.size);
  let offset = 0;
  let chunks = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: string): Promise<void> => {
    cancellation ??= deadline.confirmStreamCancellation(subject, () =>
      reader.cancel(reason),
    );
    return cancellation;
  };
  try {
    for (;;) {
      const item = await deadline.read(`reading ${subject} body`, () =>
        reader.read(),
      );
      if (item.done) break;
      chunks += 1;
      if (
        chunks > DIRECT_DEPLOY_RESPONSE_MAX_CHUNKS ||
        item.value.byteLength > output.byteLength - offset
      ) {
        throw new Error(`${subject} exceeded its bounded object size`);
      }
      output.set(item.value, offset);
      offset += item.value.byteLength;
    }
  } catch (error) {
    await cancel(`${subject} body read did not finish`);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation owns a pending read until it settles or the bounded
      // cleanup fence reports that ownership could not be confirmed.
    }
  }
  if (offset !== object.size) {
    throw new Error(`${subject} did not match its bounded object size`);
  }
  return output;
}

async function readR2TextBounded(
  object: R2ObjectBody,
  maximumBytes: number,
  subject: string,
  deadline: DirectDeployAttemptDeadline,
): Promise<string> {
  const bytes = await readR2BytesBounded(
    object,
    maximumBytes,
    subject,
    deadline,
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validateArtifactCacheRecord(
  value: unknown,
  key: string,
): DirectDeployArtifactCacheRecord {
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
  if (record.modules.length > DIRECT_DEPLOY_MODULE_MAX_FILES) {
    throw new Error(`Deploy artifact cache is invalid: ${key}`);
  }
  const moduleNames = new Set<string>();
  let moduleBytes = 0;
  for (const module of record.modules) {
    if (!module || typeof module !== "object") {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    try {
      assertDirectDeployPath(module.name, "module");
    } catch {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    if (
      moduleNames.has(module.name) ||
      typeof module.contentType !== "string" ||
      utf8ByteLength(module.contentType) > DIRECT_DEPLOY_PATH_MAX_BYTES ||
      typeof module.contentBase64 !== "string"
    ) {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    moduleNames.add(module.name);
    const size = boundedBase64DecodedLength(module.contentBase64);
    if (
      size === null ||
      size > DIRECT_DEPLOY_MODULE_MAX_FILE_BYTES ||
      size > DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES - moduleBytes
    ) {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    moduleBytes += size;
  }
  validateArtifactAssetsRecord(record.assetsRecord, key);
  return record;
}

function boundedBase64DecodedLength(value: string): number | null {
  const maximumCharacters =
    Math.ceil(DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES / 3) * 4;
  if (
    value.length > maximumCharacters ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function validateArtifactAssetsRecord(
  record: SelfhostAssetsRecord | null,
  key: string,
): void {
  if (record === null) return;
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schemaVersion !== 1 ||
    typeof record.appId !== "string" ||
    utf8ByteLength(record.appId) > DIRECT_DEPLOY_PATH_MAX_BYTES ||
    !record.manifest ||
    typeof record.manifest !== "object" ||
    Array.isArray(record.manifest)
  ) {
    throw new Error(`Deploy artifact cache is invalid: ${key}`);
  }
  let count = 0;
  let bytes = 0;
  let metadataBytes = 0;
  for (const [path, entry] of Object.entries(record.manifest)) {
    count += 1;
    if (count > DIRECT_DEPLOY_ASSET_MAX_FILES) {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    try {
      assertDirectDeployPath(path, "asset");
    } catch {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.hash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.hash) ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES ||
      (entry.contentType !== undefined &&
        (typeof entry.contentType !== "string" ||
          utf8ByteLength(entry.contentType) > DIRECT_DEPLOY_PATH_MAX_BYTES))
    ) {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    const size = entry.size as number;
    if (size > DIRECT_DEPLOY_ASSET_MAX_TOTAL_BYTES - bytes) {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    bytes += size;
    const entryMetadataBytes =
      utf8ByteLength(path) +
      utf8ByteLength(entry.hash) +
      (entry.contentType ? utf8ByteLength(entry.contentType) : 0);
    if (
      entryMetadataBytes >
      DIRECT_DEPLOY_ASSET_MAX_METADATA_BYTES - metadataBytes
    ) {
      throw new Error(`Deploy artifact cache is invalid: ${key}`);
    }
    metadataBytes += entryMetadataBytes;
  }
}

function normalizedDirectBindings(
  metadata: DirectWorkerMetadata,
): WorkerBinding[] {
  const bindings = metadata.bindings ?? [];
  if (!metadata.assets || bindings.some((binding) => binding.type === "assets"))
    return bindings;
  return [
    ...bindings,
    { type: "assets", name: assetsBindingName(metadata.assets) },
  ];
}

function assetsBindingName(assets: unknown): string {
  if (assets && typeof assets === "object" && !Array.isArray(assets)) {
    const record = assets as Record<string, unknown>;
    const configured = record.binding ?? record.binding_name ?? record.name;
    if (typeof configured === "string" && configured.trim())
      return configured.trim();
  }
  return "ASSETS";
}

// Read each asset once, in bounded batches, to compute its Cloudflare and R2
// hashes plus size, then release the bytes. The returned fingerprints carry no
// payload — only the lazy `read()` handle — so the native upload and R2
// rollback passes re-read on demand without the whole asset set ever being
// resident at once.
async function fingerprintDirectAssets(
  assets: DirectDeployAsset[],
  deadline: DirectDeployAttemptDeadline,
): Promise<PreparedDirectAsset[]> {
  return mapWithWeightedConcurrency(
    assets,
    DIRECT_DEPLOY_ASSET_FINGERPRINT_CONCURRENCY,
    DIRECT_DEPLOY_ASSET_FINGERPRINT_MAX_IN_FLIGHT_WEIGHT_BYTES,
    (asset) => directDeployAssetFingerprintWeightBytes(asset.size),
    async (asset) => {
      const bytes = await readBoundedDirectAsset(asset, deadline);
      const normalizedPath = normalizeSelfhostAssetPath(asset.path);
      const base64 = bytesToBase64(bytes);
      const extension = asset.path.split(".").pop() ?? "";
      const cfHash = (
        await sha256Hex(new TextEncoder().encode(`${base64}${extension}`))
      ).slice(0, 32);
      const r2Hash = await sha256Hex(bytes);
      return {
        path: asset.path,
        normalizedPath,
        cfPath: `/${normalizedPath}`,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        size: bytes.byteLength,
        cfHash,
        r2Hash,
        read: () => readBoundedDirectAsset(asset, deadline),
      };
    },
  );
}

async function readBoundedDirectAsset(
  asset: DirectDeployAsset,
  deadline: DirectDeployAttemptDeadline,
): Promise<Uint8Array> {
  const bytes = await deadline.read(
    `reading direct deploy asset ${asset.path}`,
    () => asset.read(),
  );
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== asset.size ||
    bytes.byteLength > DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES
  ) {
    throw new Error(
      `Direct deploy asset ${asset.path} did not match its bounded listed size`,
    );
  }
  return bytes;
}

function validateNativeAssetUploadBuckets(
  buckets: unknown,
  entriesByHash: Map<string, PreparedDirectAsset>,
): asserts buckets is string[][] {
  if (
    !Array.isArray(buckets) ||
    buckets.length > DIRECT_DEPLOY_ASSET_MAX_FILES
  ) {
    throw new Error("Asset upload session returned too many buckets");
  }
  const seen = new Set<string>();
  let references = 0;
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      throw new Error("Asset upload session returned an invalid bucket");
    }
    let bucketBytes = 0;
    for (const hash of bucket) {
      references += 1;
      if (
        references > DIRECT_DEPLOY_ASSET_MAX_FILES ||
        typeof hash !== "string" ||
        hash.length > 128 ||
        seen.has(hash)
      ) {
        throw new Error("Asset upload session returned invalid asset hashes");
      }
      seen.add(hash);
      const entry = entriesByHash.get(hash);
      if (!entry) {
        throw new Error(`Asset upload bucket referenced unknown hash: ${hash}`);
      }
      if (entry.size > DIRECT_DEPLOY_ASSET_BUCKET_MAX_BYTES - bucketBytes) {
        throw new Error(
          `Asset upload bucket exceeds the ${DIRECT_DEPLOY_ASSET_BUCKET_MAX_BYTES} raw byte limit`,
        );
      }
      bucketBytes += entry.size;
    }
  }
}

function prepareDirectAssetsRecord(
  env: DirectDispatchDeployEnv,
  appId: string,
  request: DirectDispatchDeployRequest,
  preparedAssets: PreparedDirectAsset[],
  deadline: DirectDeployAttemptDeadline,
): {
  record: SelfhostAssetsRecord | null;
  store: (() => Promise<void>) | null;
} {
  if (preparedAssets.length === 0) return { record: null, store: null };
  const hasAssetsBinding =
    request.metadata.bindings?.some((binding) => binding.type === "assets") ||
    Boolean(request.metadata.assets);
  if (!hasAssetsBinding) return { record: null, store: null };
  if (!env.APP_KV)
    throw new Error("APP_KV is required for direct deploy assets");
  if (preparedAssets.length > 0 && !env.R2_BUCKET)
    throw new Error("R2_BUCKET is required for direct deploy assets");

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
  // Write rollback blobs through a small drain-on-error lane pool, re-reading
  // each lazy asset on demand so the transient payload count stays explicit.
  const store =
    preparedAssets.length > 0
      ? () =>
          mapWithWeightedConcurrency(
            preparedAssets,
            DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY,
            DIRECT_DEPLOY_ASSET_ROLLBACK_MAX_IN_FLIGHT_BYTES,
            (asset) => asset.size,
            async (asset) => {
              if (!env.R2_BUCKET)
                throw new Error(
                  "R2_BUCKET is required for direct deploy assets",
                );
              const bytes = await asset.read();
              deadline.assertActive(
                `storing direct deploy asset ${asset.path}`,
              );
              await deadline.write(
                `storing direct deploy asset ${asset.path} in R2`,
                () =>
                  env.R2_BUCKET!.put(
                    selfhostAssetObjectKey(appId, asset.r2Hash),
                    bytes,
                    asset.contentType
                      ? { httpMetadata: { contentType: asset.contentType } }
                      : undefined,
                  ),
              );
            },
          ).then(() => undefined)
      : null;
  return { record, store };
}

async function publishDirectAssetsRecord(
  env: DirectDispatchDeployEnv,
  appId: string,
  record: SelfhostAssetsRecord,
  deadline: DirectDeployAttemptDeadline,
): Promise<void> {
  if (!env.APP_KV)
    throw new Error("APP_KV is required for direct deploy assets");
  await deadline.write("publishing the direct deploy asset record", () =>
    env.APP_KV!.put(selfhostAssetsKey(appId), JSON.stringify(record)),
  );
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
  const moduleBytes = input.modules.reduce(
    (total, module) => total + directContentByteLength(module.content),
    0,
  );
  // Artifact rollback is an optional convenience. Above this threshold the
  // base64 record would overlap too much retained data with the module upload;
  // omit it rather than creating a second full-bundle representation.
  if (moduleBytes > DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_MODULE_BYTES) {
    return undefined;
  }
  const moduleFingerprints = await mapWithConcurrency(
    input.modules,
    DIRECT_DEPLOY_ARTIFACT_MODULE_CONCURRENCY,
    async (module) => {
      const bytes = contentBytes(module.content);
      return {
        name: module.name,
        contentType: module.contentType,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      };
    },
  );
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
  const projectSegment = input.identity.projectId
    ? encodeURIComponent(input.identity.projectId)
    : "workspace";
  const key = `deploy-artifacts/${encodeURIComponent(input.identity.orgId)}/${encodeURIComponent(input.identity.workspaceId)}/${projectSegment}/${encodeURIComponent(input.dispatchScriptName)}/${digest}.json`;
  const record = async (): Promise<DirectDeployArtifactCacheRecord> => ({
    schemaVersion: 1 as const,
    scriptName: input.scriptName,
    dispatchScriptName: input.dispatchScriptName,
    identity: input.identity,
    metadata: input.metadata,
    modules: await mapWithConcurrency(
      input.modules,
      DIRECT_DEPLOY_ARTIFACT_MODULE_CONCURRENCY,
      async (module) => ({
        name: module.name,
        contentType: module.contentType,
        contentBase64: bytesToBase64(contentBytes(module.content)),
      }),
    ),
    assetsRecord: input.assetsRecord,
    createdAt: new Date().toISOString(),
  });
  return { key, record };
}

async function storePreparedDeployArtifactCache(
  env: DirectDispatchDeployEnv,
  prepared: PreparedDeployArtifactCache,
  deadline: DirectDeployAttemptDeadline,
): Promise<void> {
  if (!env.R2_BUCKET) return;
  const record = await prepared.record();
  const encoded = JSON.stringify(record);
  if (utf8ByteLength(encoded) > DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_BYTES) {
    throw new Error(
      `Deploy artifact cache exceeds the ${DIRECT_DEPLOY_ARTIFACT_CACHE_MAX_BYTES} byte limit`,
    );
  }
  await deadline.write("storing the direct deploy artifact cache in R2", () =>
    env.R2_BUCKET!.put(prepared.key, encoded, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        type: "direct-deploy-artifact-cache",
        orgId: record.identity.orgId,
        workspaceId: record.identity.workspaceId,
        scriptName: record.scriptName,
        dispatchScriptName: record.dispatchScriptName,
        ...(record.identity.projectId
          ? { projectId: record.identity.projectId }
          : {}),
      },
    }),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  return mapWithWeightedConcurrency(
    items,
    concurrency,
    Math.max(1, concurrency),
    () => 1,
    mapper,
  );
}

/**
 * Adaptive drain-on-error lane pool. No new mapper starts after the first
 * failure, and every mapper that crossed the boundary settles before the error
 * is exposed. Weight is admitted independently from lane count so small I/O can
 * overlap without multiplying the maximum-payload memory floor.
 */
async function mapWithWeightedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  maximumWeight: number,
  weightOf: (item: T, index: number) => number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const laneLimit = Math.max(1, Math.floor(concurrency));
  const weightLimit = Math.max(1, Math.floor(maximumWeight));
  const weights = items.map((item, index) => {
    const weight = Math.max(1, Math.floor(weightOf(item, index)));
    if (!Number.isSafeInteger(weight) || weight > weightLimit) {
      throw new Error("Bounded concurrency item exceeds its weight budget");
    }
    return weight;
  });
  const pending = items.map((_item, index) => index);
  const inFlight = new Set<Promise<void>>();
  const results = Array.from<R>({ length: items.length });
  let activeWeight = 0;
  let stopped = false;
  let firstError: unknown;

  while (!stopped && pending.length > 0) {
    for (
      let cursor = 0;
      cursor < pending.length && inFlight.size < laneLimit;
    ) {
      const index = pending[cursor]!;
      const weight = weights[index]!;
      if (weight > weightLimit - activeWeight) {
        cursor += 1;
        continue;
      }
      pending.splice(cursor, 1);
      activeWeight += weight;
      let task!: Promise<void>;
      task = Promise.resolve()
        .then(() => mapper(items[index]!, index))
        .then(
          (value) => {
            results[index] = value;
          },
          (error) => {
            if (!stopped) firstError = error;
            stopped = true;
          },
        )
        .finally(() => {
          activeWeight -= weight;
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }

  // Stop admission on failure, but drain every mapper that already crossed the
  // I/O/effect boundary before allowing a retry to observe the failure.
  if (inFlight.size > 0) await Promise.allSettled(inFlight);
  if (stopped) throw firstError;
  return results;
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
  if (typeof content === "string" || content instanceof ArrayBuffer)
    return content;
  return content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonOrText(
  response: Response,
  deadline: DirectDeployAttemptDeadline,
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const listedText = response.headers.get("content-length");
  const listedSize = listedText === null ? null : Number(listedText);
  if (
    listedSize !== null &&
    (!Number.isSafeInteger(listedSize) ||
      listedSize < 0 ||
      listedSize > DIRECT_DEPLOY_RESPONSE_MAX_BYTES)
  ) {
    if (response.body) {
      await deadline.confirmStreamCancellation(
        "Direct deploy response body",
        () =>
          response.body!.cancel(
            "Direct deploy response exceeded its byte limit",
          ),
      );
    }
    throw new Error(
      `Direct deploy response exceeds the ${DIRECT_DEPLOY_RESPONSE_MAX_BYTES} byte limit`,
    );
  }
  if (!response.body)
    return contentType.includes("application/json") ? null : "";
  const reader = response.body.getReader();
  const output = new Uint8Array(listedSize ?? DIRECT_DEPLOY_RESPONSE_MAX_BYTES);
  let offset = 0;
  let chunks = 0;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: string): Promise<void> => {
    cancellation ??= deadline.confirmStreamCancellation(
      "Direct deploy response body",
      () => reader.cancel(reason),
    );
    return cancellation;
  };
  try {
    for (;;) {
      const item = await deadline.read(
        "reading a Cloudflare response body",
        () => reader.read(),
      );
      if (item.done) break;
      chunks += 1;
      if (
        chunks > DIRECT_DEPLOY_RESPONSE_MAX_CHUNKS ||
        item.value.byteLength > output.byteLength - offset
      ) {
        throw new Error(
          `Direct deploy response exceeds the ${DIRECT_DEPLOY_RESPONSE_MAX_BYTES} byte limit`,
        );
      }
      output.set(item.value, offset);
      offset += item.value.byteLength;
    }
  } catch (error) {
    await cancel("Direct deploy response body read did not finish");
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A synthetic/non-abort-aware stream may retain a pending read after the
      // attempt timeout. Its result is fenced and observed by deadline.read().
    }
  }
  if (listedSize !== null && offset !== listedSize) {
    throw new Error(
      "Direct deploy response did not match its listed byte size",
    );
  }
  const text = new TextDecoder().decode(output.subarray(0, offset));
  if (!contentType.includes("application/json")) return text;
  try {
    return parseJsonBounded(text, {
      maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
      maxTokens: 100_000,
      maxNodes: 50_000,
      maxEntries: 25_000,
      maxStrings: 25_000,
      maxStringCodeUnits: DIRECT_DEPLOY_RESPONSE_MAX_BYTES,
    });
  } catch {
    return null;
  }
}

async function readCloudflareResult<T>(
  response: Response,
  deadline: DirectDeployAttemptDeadline,
): Promise<CloudflareResultRead<T>> {
  const body = await readJsonOrText(response, deadline);
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "result" in body
  ) {
    const result = (body as { result?: T | null }).result ?? null;
    return {
      result,
      ...(!response.ok || result == null
        ? { errorText: JSON.stringify(body) }
        : {}),
    };
  }
  return {
    result: response.ok ? (body as T) : null,
    ...(!response.ok
      ? { errorText: typeof body === "string" ? body : JSON.stringify(body) }
      : {}),
  };
}
