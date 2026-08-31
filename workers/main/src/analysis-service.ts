import { WorkerEntrypoint } from "cloudflare:workers";

import { assertConnectionsBindingEnabled } from "../../../src/lib/connections-binding";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import { getWorkspaceR2Prefix } from "../../../src/lib/workspace-r2-paths";
import {
  ANALYSIS_CONTAINER_RESET_TIMEOUT_MS,
  ANALYSIS_CONNECTIONS_HOST,
  ANALYSIS_EXECUTION_LEASE_MS,
  type AnalysisConnectionsParams,
  type AnalysisExecutionLeaseResult,
} from "./analysis-sandbox.js";
import { boundedCanonicalJsonResult } from "./chat-thread/bounded-canonical-json.js";
import { utf8ByteLength } from "./chat-thread/utf8-byte-length.js";
import {
  listConnections,
  type ConnectionsRuntimeEnv,
} from "./connections-runtime.js";
import {
  annotateWarehouseConnections,
  type WarehouseConnection,
} from "./warehouse-service.js";
import { warehouseWorkspacePrefix } from "./warehouse-export.js";
import {
  recordObservabilityEvent,
  type ObservabilityEnv,
} from "./observability.js";
import {
  isSandboxSessionDeathError,
  isSandboxSessionDeathResult,
  sandboxSessionExitCode,
} from "./sandbox-session-death.js";
import {
  ProjectFilesystemClient,
  type WorkspaceFileStoreLike,
} from "./workspace-filesystem-do.js";

/**
 * Unified analysis compute service — the successor to (and absorption of)
 * WarehouseService.
 *
 * Runs on one warm AnalysisSandbox container per workspace (see analysis-sandbox.ts).
 * Provides the stateless data-analysis surface that used to require a persistent
 * project VM:
 *   - runNotebook: execute + validate a project notebook, persist changed files back
 *   - exec:        ad-hoc shell in a project working dir
 *   - runCode:     Python string (warehouse-compatible; DuckDB over mounted exports)
 *   - addDependency: `uv add`, persist pyproject.toml + uv.lock back
 *   - listConnections: exportable-connection catalog (same as the warehouse)
 *
 * Truth lives in the project filesystem (WorkspaceFilesystemDO, DO+R2); the
 * container is a disposable cache. Files are materialized in before a run and the
 * changed set is persisted out after — a content-addressed diff, size-guarded.
 * See plans/stateless-data-analysis-architecture.md.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where materialized project trees live in the container (persisted warm). */
export const ANALYSIS_PROJECT_ROOT = "/projects";
/** Ephemeral scratch root for no-project runs; never persisted. */
export const ANALYSIS_SCRATCH_ROOT = "/scratch";
/** R2 binding names the container's s3fs mounts route to. */
export const ANALYSIS_EXPORT_BUCKET_BINDING = "WAREHOUSE_EXPORT_BUCKET";
export const ANALYSIS_UPLOADS_BUCKET_BINDING = "R2_BUCKET";
/**
 * Second binding name for the SAME bucket as R2_BUCKET. The sandbox SDK rejects
 * mounting one binding at two different prefixes ("R2 binding \"R2_BUCKET\" is
 * already mounted at /uploads with a different prefix"), so the writable
 * /outputs mount cannot reuse the uploads binding — with uploads mounted first,
 * every outputs mount failed. Keeping them on separate bindings also keeps
 * /uploads read-only, which a single shared parent mount could not.
 */
export const ANALYSIS_OUTPUTS_BUCKET_BINDING = "R2_OUTPUTS_BUCKET";
/**
 * Where workspace uploads mount inside the container. The agent references
 * uploads as `uploads/<name>` (R2-relative), so the in-container path is that
 * same reference with a leading slash — the raw `<org>/<ws>/user-uploads` R2
 * prefix is never shown to the agent and can't be derived inside the container.
 */
export const ANALYSIS_UPLOADS_MOUNT_PATH = "/uploads";
/**
 * Where workspace outputs mount inside the container, writable. This is how a
 * run hands a generated file back to the user: anything written to
 * `/outputs/<name>` is the `outputs/<name>` R2 reference the file tools read
 * and the chat links as `/api/workspaces/<id>/outputs/<name>`.
 *
 * Without it a generated binary was effectively trapped. Production agents hit
 * this repeatedly on "export this to Excel": the file existed in the sandbox
 * and every route out was a dead end — `shutil` to a project path (not mounted),
 * base64 through the text-only `write` tool (corrupts), and finally deploying a
 * whole Worker just to serve one spreadsheet.
 */
export const ANALYSIS_OUTPUTS_MOUNT_PATH = "/outputs";
/** Files larger than this are NOT auto-persisted back to the project FS. */
export const ANALYSIS_MAX_PERSIST_BYTES = 25 * 1024 * 1024;
/**
 * Where the baked `camelai` helper package lives (analysis-sandbox.Dockerfile
 * COPYs it there and sets the same PYTHONPATH as an image ENV). Also set
 * per-run so helper importability never depends on how the container server
 * propagates image ENV to exec'd processes.
 */
export const ANALYSIS_PYTHONPATH = "/opt/camelai-python";
/**
 * Container-side timeouts for the analysis legs. Exported because the tool
 * boundary (code-mode-tools.ts) derives its client-side deadline from the SAME
 * numbers — a second, divergent set of defaults there would either cut a
 * legitimate run short or fail to bound the one this file forwards.
 */
export const ANALYSIS_DEFAULT_NOTEBOOK_TIMEOUT_MS = 300_000;
export const ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS =
  CHAT_RUNTIME_BOUNDS.analysisCommandDeadlineMs;
// Long connection exports have a five-minute server budget. Leave enough room
// for the request plus local DuckDB materialization in run_code/analysis_exec.
export const ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS = 360_000;
export const ANALYSIS_DEFAULT_DEP_TIMEOUT_MS = 300_000;
/** Fixed budget for the post-execution notebook validator leg. */
export const ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS = 60_000;
/** Hard producer-side ceilings for post-run project manifests. */
export const ANALYSIS_MANIFEST_MAX_FILES = 4_096;
export const ANALYSIS_MANIFEST_MAX_ENTRIES = 8_192;
export const ANALYSIS_MANIFEST_MAX_PATH_BYTES = 224 * 1024;
export const ANALYSIS_MANIFEST_MAX_BYTES = 512 * 1024;
export const ANALYSIS_MAX_SOURCE_FILE_BYTES = ANALYSIS_MAX_PERSIST_BYTES;
export const ANALYSIS_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
/** Aggregate bytes a single run may stream back into project storage. */
export const ANALYSIS_MAX_PERSIST_TOTAL_BYTES = 256 * 1024 * 1024;
/** Absolute wall-clock budget for the whole post-command persist phase. */
export const ANALYSIS_PERSIST_TIMEOUT_MS = 120_000;
/** Container-reset confirmation when per-run directory cleanup fails. */
export const ANALYSIS_CLEANUP_RESET_TIMEOUT_MS =
  ANALYSIS_CONTAINER_RESET_TIMEOUT_MS;
const ANALYSIS_ARCHIVE_HANDOFF_TIMEOUT_MS = 5_000;
const ANALYSIS_OPERATION_FINALIZE_TIMEOUT_MS =
  ANALYSIS_CLEANUP_RESET_TIMEOUT_MS + ANALYSIS_ARCHIVE_HANDOFF_TIMEOUT_MS;
/**
 * One service-side lifecycle budget is command + bounded I/O (+ validator for
 * notebooks). It is deliberately shorter than the tool boundary's 15s grace,
 * so callers are still present while this service confirms cancellation/reset.
 */
export const ANALYSIS_OPERATION_IO_TIMEOUT_MS = ANALYSIS_PERSIST_TIMEOUT_MS;
/** Pure admission RPCs should never consume the operation's execution budget. */
const ANALYSIS_ADMISSION_RPC_TIMEOUT_MS =
  ANALYSIS_CLEANUP_RESET_TIMEOUT_MS + 1_000;
/** At most two bounded requests wait behind the active workspace/scope run. */
export const ANALYSIS_EXECUTION_QUEUE_MAX_WAITERS = 2;
/** Queueing is backpressure, not another unbounded analysis lifecycle. */
export const ANALYSIS_EXECUTION_QUEUE_WAIT_MS = 30_000;
const ANALYSIS_EXECUTION_QUEUE_POLL_MS = 1_000;
/** Admission ceilings applied before command/env/params copies are built. */
export const ANALYSIS_MAX_COMMAND_BYTES = CHAT_RUNTIME_BOUNDS.toolInputBytes;
export const ANALYSIS_MAX_CODE_BYTES = CHAT_RUNTIME_BOUNDS.toolSourceReadBytes;
export const ANALYSIS_MAX_PARAMS_BYTES = CHAT_RUNTIME_BOUNDS.toolInputBytes;
export const ANALYSIS_MAX_ENV_BYTES = 32 * 1024;
export const ANALYSIS_MAX_REQUEST_PATH_BYTES = 4 * 1024;
export const ANALYSIS_MAX_DEPENDENCY_SPECS = 64;
export const ANALYSIS_MAX_DEPENDENCY_SPEC_BYTES = 214;
export const ANALYSIS_MAX_DEPENDENCY_BYTES = 8 * 1024;

const DEFAULT_NOTEBOOK_TIMEOUT_MS = ANALYSIS_DEFAULT_NOTEBOOK_TIMEOUT_MS;
const MAX_NOTEBOOK_TIMEOUT_MS = ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS;
const DEFAULT_EXEC_TIMEOUT_MS = ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS;
const DEFAULT_DEP_TIMEOUT_MS = ANALYSIS_DEFAULT_DEP_TIMEOUT_MS;

export class AnalysisExecutionBusyError extends Error {
  override name = "AnalysisExecutionBusyError";

  constructor(
    operation: string,
    scope: "agent" | "app",
    readonly retryAfterMs: number,
    reason: "busy" | "stale_reset_unconfirmed",
  ) {
    super(
      reason === "stale_reset_unconfirmed"
        ? `Analysis ${scope} environment could not confirm stale-owner cleanup for ${operation}; retry later`
        : `Analysis ${scope} environment is busy with another operation; retry ${operation} later`,
    );
  }
}

export class AnalysisOperationDeadlineError extends Error {
  override name = "AnalysisOperationDeadlineError";

  constructor(
    readonly operation: string,
    readonly budgetMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `Analysis ${operation} exceeded its ${Math.round(budgetMs / 1000)}s absolute lifecycle budget`,
      options,
    );
  }
}

interface AnalysisOperationBudget {
  readonly operation: string;
  readonly ownerToken: string;
  readonly budgetMs: number;
  readonly deadlineAt: number;
  /** The final reset window is reserved; ordinary phases stop at this instant. */
  readonly workDeadlineAt: number;
  readonly signal: AbortSignal;
  /** RPCs whose local deadline fired before their server outcome was known. */
  readonly pending: Set<Promise<unknown>>;
  /** Successful overflow writes awaiting service-level reference handoff. */
  readonly archives: Map<string, string>;
  abort(reason: unknown): void;
  reset?: Promise<void>;
}

interface AnalysisExecutionQueueWaiter {
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve(release: () => void): void;
  reject(error: AnalysisExecutionBusyError): void;
}

interface AnalysisExecutionQueueState {
  active: boolean;
  waiters: AnalysisExecutionQueueWaiter[];
}

function analysisOperationBudgetMs(
  commandTimeoutMs: number,
  secondaryTimeoutMs = 0,
): number {
  return Math.min(
    ANALYSIS_EXECUTION_LEASE_MS,
    commandTimeoutMs + secondaryTimeoutMs + ANALYSIS_OPERATION_IO_TIMEOUT_MS,
  );
}

function analysisOperationDeadlineError(
  budget: AnalysisOperationBudget,
  cause?: unknown,
): AnalysisOperationDeadlineError {
  return new AnalysisOperationDeadlineError(
    budget.operation,
    budget.budgetMs,
    cause === undefined ? undefined : { cause },
  );
}

function assertAnalysisOperationActive(
  budget: AnalysisOperationBudget | undefined,
): void {
  if (!budget) return;
  if (budget.signal.aborted || Date.now() >= budget.workDeadlineAt) {
    const reason = budget.signal.reason;
    const error =
      reason instanceof AnalysisOperationDeadlineError
        ? reason
        : analysisOperationDeadlineError(budget, reason);
    budget.abort(error);
    throw error;
  }
}

async function awaitAnalysisOperation<T>(
  pending: Promise<T>,
  budget: AnalysisOperationBudget | undefined,
): Promise<T> {
  assertAnalysisOperationActive(budget);
  const value = await pending;
  assertAnalysisOperationActive(budget);
  return value;
}

function remainingAnalysisWorkMs(
  budget: AnalysisOperationBudget | undefined,
  requestedMs: number,
): number {
  if (!budget) return requestedMs;
  assertAnalysisOperationActive(budget);
  const remaining = Math.floor(budget.workDeadlineAt - Date.now());
  if (remaining < 1_000) {
    const error = analysisOperationDeadlineError(budget);
    budget.abort(error);
    throw error;
  }
  return Math.max(1, Math.min(requestedMs, remaining));
}

async function withAnalysisAdmissionRpcDeadline<T>(
  pending: Promise<T>,
  operation: "acquire" | "release" | "authorization",
  timeoutMs = ANALYSIS_ADMISSION_RPC_TIMEOUT_MS,
): Promise<T> {
  pending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Analysis ${operation} RPC deadline exceeded`)),
      Math.max(1, Math.min(ANALYSIS_ADMISSION_RPC_TIMEOUT_MS, timeoutMs)),
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function acquireAnalysisExecutionLeaseWithBoundedWait(
  sandbox: AnalysisSandboxStub,
  request: { token: string; operation: string },
  queueDeadlineAt: number,
): Promise<AnalysisExecutionLeaseResult> {
  for (;;) {
    const remainingMs = Math.max(1, Math.floor(queueDeadlineAt - Date.now()));
    const admission = await withAnalysisAdmissionRpcDeadline(
      sandbox.acquireExecutionLease(request),
      "acquire",
      remainingMs,
    );
    if (
      admission.acquired ||
      admission.reason !== "busy" ||
      Date.now() >= queueDeadlineAt
    ) {
      return admission;
    }
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.max(
          1,
          Math.min(
            ANALYSIS_EXECUTION_QUEUE_POLL_MS,
            queueDeadlineAt - Date.now(),
          ),
        ),
      );
    });
  }
}

function clampAnalysisOutputCaptureBytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(
        0,
        Math.min(
          CHAT_RUNTIME_BOUNDS.analysisOutputOverflowBytes,
          Math.floor(value),
        ),
      )
    : 0;
}

function encodeBoundedAnalysisObject(
  value: unknown,
  maximumBytes: number,
  label: string,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const encoded = boundedCanonicalJsonResult(value, maximumBytes, {
    maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
    maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
    maxNodes: CHAT_RUNTIME_BOUNDS.providerJsonNodes,
  });
  if (!encoded.complete || !encoded.json.startsWith("{")) {
    throw new Error(`${label} exceeds its bounded JSON limit`);
  }
  return encoded.json;
}

function boundedAnalysisEnvironment(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const parsed = JSON.parse(
    encodeBoundedAnalysisObject(value, ANALYSIS_MAX_ENV_BYTES, "environment"),
  ) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(parsed)) {
    if (
      typeof entry !== "string" ||
      key.includes("\0") ||
      key.includes("=") ||
      entry.includes("\0")
    ) {
      throw new Error("environment must contain valid string entries");
    }
  }
  return parsed as Record<string, string>;
}

function withBoundedAnalysisParams(
  code: string,
  params: Record<string, unknown> | undefined,
): string {
  if (params === undefined) return code;
  const encoded = encodeBoundedAnalysisObject(
    params,
    ANALYSIS_MAX_PARAMS_BYTES,
    "params",
  );
  if (encoded === "{}") return code;
  const literal = JSON.stringify(encoded);
  return `import json as _wh_json\nparams = _wh_json.loads(${literal})\ndel _wh_json\n${code}`;
}

type AnalysisInputValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function validateAnalysisNotebookPath(
  path: unknown,
): AnalysisInputValidation<string> {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    utf8ByteLength(path) > ANALYSIS_MAX_REQUEST_PATH_BYTES
  ) {
    return { ok: false, error: "path exceeds the analysis path byte limit" };
  }
  const notebookRel = normalizeAnalysisRelPath(path);
  return notebookRel && notebookRel.endsWith(".ipynb")
    ? { ok: true, value: notebookRel }
    : {
        ok: false,
        error: "path must be a .ipynb file inside the project",
      };
}

interface ValidatedAnalysisExecRequest {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

function validateAnalysisExecRequest(request: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
  timeoutMs?: number;
}): AnalysisInputValidation<ValidatedAnalysisExecRequest> {
  if (typeof request.command !== "string" || !/\S/.test(request.command)) {
    return { ok: false, error: "command is required" };
  }
  if (request.command.includes("\0")) {
    return { ok: false, error: "command contains a NUL byte" };
  }
  if (utf8ByteLength(request.command) > ANALYSIS_MAX_COMMAND_BYTES) {
    return {
      ok: false,
      error: `command exceeds the ${ANALYSIS_MAX_COMMAND_BYTES} byte limit`,
    };
  }
  if (
    request.cwd !== undefined &&
    (typeof request.cwd !== "string" ||
      request.cwd.includes("\0") ||
      utf8ByteLength(request.cwd) > ANALYSIS_MAX_REQUEST_PATH_BYTES)
  ) {
    return {
      ok: false,
      error: "cwd exceeds the analysis path byte limit",
    };
  }
  try {
    return {
      ok: true,
      value: {
        command: request.command,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.env === undefined
          ? {}
          : {
              env: boundedAnalysisEnvironment(
                request.env as Record<string, string>,
              ),
            }),
        ...(request.timeoutMs === undefined
          ? {}
          : { timeoutMs: request.timeoutMs }),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "invalid analysis environment",
    };
  }
}

function validateAnalysisCodeRequest(request: {
  code?: unknown;
  params?: unknown;
}): AnalysisInputValidation<string> {
  if (typeof request.code !== "string" || !/\S/.test(request.code)) {
    return { ok: false, error: "code is required" };
  }
  if (utf8ByteLength(request.code) > ANALYSIS_MAX_CODE_BYTES) {
    return {
      ok: false,
      error: `code exceeds the ${ANALYSIS_MAX_CODE_BYTES} byte limit`,
    };
  }
  try {
    return {
      ok: true,
      value: withBoundedAnalysisParams(
        request.code,
        request.params as Record<string, unknown> | undefined,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "invalid analysis params",
    };
  }
}

async function r2PrefixHasObjects(
  bucket: R2Bucket,
  prefix: string,
): Promise<boolean> {
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  const listed = await bucket.list({
    prefix: `${normalizedPrefix}/`,
    limit: 1,
  });
  return listed.objects.length > 0;
}

// ---------------------------------------------------------------------------
// Sandbox interface (minimal, for testability)
// ---------------------------------------------------------------------------

export interface AnalysisSandboxLike {
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
    },
  ): Promise<{
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  execBounded(
    command: string,
    options:
      | {
          cwd?: string;
          env?: Record<string, string | undefined>;
          timeout?: number;
          signal?: AbortSignal;
        }
      | undefined,
    limits: {
      stdoutBytes: number;
      stderrBytes: number;
      overflowPath?: string;
      overflowObjectKey?: string;
      executionOwnerToken?: string;
      overflowBytes?: number;
    },
  ): Promise<{
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    stdoutBytes: number;
    stderrBytes: number;
    outputTruncated: boolean;
    overflowStored: boolean;
    overflowComplete: boolean;
    overflowBytes: number;
    overflowTaintToken?: string;
  }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: "base64" | "utf8" },
  ): Promise<unknown>;
  readFile(
    path: string,
    options?: { encoding?: "base64" | "utf8" | "none" },
  ): Promise<{
    content: string | ReadableStream<Uint8Array>;
    size?: number;
    mimeType?: string;
  }>;
  /** Disposable-container fallback, including generation-specific cache reset. */
  destroyAndForgetContainerGeneration?(): Promise<void>;
}

/** The full DO-RPC stub surface the service drives (custom AnalysisSandbox methods). */
export type AnalysisSandboxStub = AnalysisSandboxLike & {
  acquireExecutionLease(request: {
    token: string;
    operation: string;
  }): Promise<AnalysisExecutionLeaseResult>;
  releaseExecutionLease(token: string): Promise<boolean>;
  acknowledgeBoundedExecArchive?(request: {
    ownerToken: string;
    taintToken: string;
    objectKey: string;
  }): Promise<boolean>;
  discardBoundedExecArchive?(request: {
    ownerToken: string;
    taintToken: string;
    objectKey: string;
  }): Promise<boolean>;
  /**
   * Optional: drop the container session handle so the next command
   * re-handshakes one (see AnalysisSandbox.resetSession). Absent on older
   * deployments and on test fakes, hence optional at the call site.
   */
  resetSession?(): Promise<void>;
  ensureMounted(
    bucketBinding: string,
    prefix: string,
    mountPath?: string,
    options?: { readOnly?: boolean },
  ): Promise<void>;
  ensureConnectionsRpc(params: AnalysisConnectionsParams): Promise<void>;
  sealAppEgress(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface AnalysisFullOutput {
  path: string;
  hint: string;
  bytes: number;
  complete: boolean;
}

export interface AnalysisNotebookResult {
  ok: boolean;
  executed: boolean;
  validation: { clean: boolean; issues: string[] };
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: string[];
  removedFiles: string[];
  skippedOversize: string[];
  durationMs: number;
  /** Producer acknowledgement used to settle reserved output-archive capacity. */
  outputTruncated: boolean;
  error?: string;
  fullOutput?: AnalysisFullOutput;
}

export interface AnalysisExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: string[];
  removedFiles: string[];
  skippedOversize: string[];
  durationMs: number;
  /** Producer acknowledgement used to settle reserved output-archive capacity. */
  outputTruncated: boolean;
  error?: string;
  fullOutput?: AnalysisFullOutput;
}

export interface AnalysisDependencyResult {
  ok: boolean;
  packages: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  pyprojectPersisted: boolean;
  lockPersisted: boolean;
  durationMs: number;
  error?: string;
  fullOutput?: AnalysisFullOutput;
}

export interface AnalysisRunCodeResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  fullOutput?: AnalysisFullOutput;
  /** Omitted when execution failed before its output state became certain. */
  outputTruncated?: boolean;
  /**
   * Internal recovery marker: the sandbox SESSION died (not the user program).
   * Set only where the environment error was caught, never from program output.
   * Stripped by withSessionRecovery before the result leaves the service.
   */
  sessionDeath?: true;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Source-file metadata, with no file payload retained in isolate memory. */
export interface AnalysisSourceFile {
  path: string;
  size: number;
}

/**
 * Derived/ephemeral paths that are never materialized in or persisted out. The
 * venv is reconstituted, caches are container-local, notebook checkpoints are
 * junk, and the git/node stores don't belong in a project source tree.
 */
export function shouldIgnoreAnalysisPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return parts.some(
    (part) =>
      part === ".venv" ||
      part === "venv" ||
      part === "__pycache__" ||
      part === ".ipynb_checkpoints" ||
      part === ".cache" ||
      part === ".uv-cache" ||
      part === "node_modules" ||
      part === ".git" ||
      part === ".pytest_cache" ||
      part === ".mypy_cache",
  );
}

export function normalizeAnalysisRelPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

/** Parse a complete, producer-counted post-run manifest or fail closed. */
export function parseSha256Manifest(stdout: string): Map<string, string> {
  if (utf8ByteLength(stdout) > ANALYSIS_MANIFEST_MAX_BYTES) {
    throw new Error("analysis manifest exceeds its byte limit");
  }
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const footer = lines.pop();
  const footerMatch = /^CAMELAI_MANIFEST_V1 ([0-9]+)$/.exec(footer ?? "");
  if (!footerMatch)
    throw new Error("analysis manifest is missing its completion footer");
  const expectedFiles = Number(footerMatch[1]);
  if (
    !Number.isSafeInteger(expectedFiles) ||
    expectedFiles > ANALYSIS_MANIFEST_MAX_FILES
  ) {
    throw new Error("analysis manifest footer exceeds its file limit");
  }
  const manifest = new Map<string, string>();
  let pathBytes = 0;
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  \.\/(.+)$/i.exec(line);
    if (!match) throw new Error("analysis manifest contains a malformed row");
    const rawPath = match[2];
    const rel = normalizeAnalysisRelPath(rawPath);
    if (
      !rel ||
      rel !== rawPath ||
      rawPath.includes("\\") ||
      shouldIgnoreAnalysisPath(rel)
    ) {
      throw new Error("analysis manifest contains an unsupported path");
    }
    if (manifest.has(rel))
      throw new Error("analysis manifest contains a duplicate path");
    pathBytes += utf8ByteLength(rel);
    if (pathBytes > ANALYSIS_MANIFEST_MAX_PATH_BYTES) {
      throw new Error("analysis manifest exceeds its path-byte limit");
    }
    manifest.set(rel, match[1].toLowerCase());
  }
  if (manifest.size !== expectedFiles) {
    throw new Error("analysis manifest footer does not match its rows");
  }
  return manifest;
}

/**
 * Content-addressed diff of two path→hash manifests. `changed` = present in
 * `next` with a different (or new) hash vs `before`; `removed` = present in
 * `before` but gone from `next`.
 */
export function diffManifests(
  before: Map<string, string>,
  next: Map<string, string>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  for (const [path, hash] of next) {
    if (before.get(path) !== hash) changed.push(path);
  }
  const removed: string[] = [];
  for (const path of before.keys()) {
    if (!next.has(path)) removed.push(path);
  }
  return { changed: changed.sort(), removed: removed.sort() };
}

/**
 * Producer-side byte caps for notebook output returned to the model. The
 * service owns the only bounded overflow archive; downstream code never makes
 * a second full-output copy merely to clamp it again.
 */
export const ANALYSIS_NOTEBOOK_STDOUT_BYTES = 8_000;
export const ANALYSIS_NOTEBOOK_STDERR_BYTES = 20_000;

/** Clamp text to its last `maxChars` characters, marking what was dropped. */
export function clampOutputTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `[... ${omitted} earlier characters truncated ...]\n${text.slice(-maxChars)}`;
}

/**
 * Extract the Python traceback from nbconvert stderr, so the run's `error`
 * field leads with the actual exception instead of whatever nbconvert printed
 * first. Matches the LAST traceback (nested/chained failures end with the one
 * that killed the run) and returns it tail-clamped.
 */
export function extractNotebookTraceback(stderr: string): string | undefined {
  const markers = ["Traceback (most recent call last)", "CellExecutionError"];
  let start = -1;
  for (const marker of markers) {
    const index = stderr.lastIndexOf(marker);
    if (index >= 0 && (start === -1 || index < start)) {
      // Prefer the earliest marker of the final error block so the cell
      // context nbconvert prints between the two markers is retained.
      start = index;
    }
  }
  if (start === -1) return undefined;
  // Back up to the start of the marker's line so the excerpt is line-aligned.
  const lineStart = stderr.lastIndexOf("\n", start) + 1;
  const traceback = stderr.slice(lineStart).trim();
  return traceback ? clampOutputTail(traceback, 6_000) : undefined;
}

/** validate-notebook prints "OK" (exit 0) or newline-joined issues (exit 1). */
export function parseValidateNotebookOutput(
  stdout: string,
  exitCode: number,
): { clean: boolean; issues: string[] } {
  const trimmed = stdout.trim();
  if (exitCode === 0 && (trimmed === "OK" || trimmed === "")) {
    return { clean: true, issues: [] };
  }
  const issues = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "OK");
  return { clean: issues.length === 0 && exitCode === 0, issues };
}

/**
 * The default analysis stack, mirrored from analysis-sandbox.Dockerfile (keep
 * the two lists in sync). Used to seed a project's pyproject.toml the first
 * time add_python_dependency initializes one, so "default stack + extras"
 * stays true once a project declares its own environment.
 */
export const ANALYSIS_DEFAULT_STACK = [
  "pandas",
  "numpy",
  "polars",
  "duckdb",
  "pyarrow",
  "altair",
  "plotly",
  "matplotlib",
  "seaborn",
  "scipy",
  "scikit-learn",
  "statsmodels",
  "openpyxl",
  "xlsxwriter",
  "pdfplumber",
  "python-docx",
  "python-pptx",
  "sqlalchemy",
  "psycopg[binary]",
  "pymysql",
  "jupyter",
  "nbconvert",
  "ipykernel",
];

/** The notebook toolchain overlaid onto project envs that don't declare it. */
const NOTEBOOK_TOOLCHAIN_WITH = ["jupyter", "nbconvert", "ipykernel"]
  .map((pkg) => `--with ${pkg}`)
  .join(" ");

/**
 * The command that executes a notebook in place, via the baked
 * `execute-notebook` runner (nbclient with save-after-every-cell, so a failing
 * run keeps every completed cell's outputs — nbconvert only wrote on full
 * success). When the project declares a `pyproject.toml`, run through `uv` so
 * the kernel sees the PROJECT env (synced from the seeded cache) — never the
 * baked venv, which would make project packages invisible. The notebook
 * toolchain is overlaid via `--with` so execution works even for user-authored
 * pyprojects that don't declare jupyter. The runner is invoked as
 * `python /usr/local/bin/execute-notebook` so it always runs under the active
 * env's interpreter.
 */
export function notebookExecuteCommand(
  notebookRelPath: string,
  hasPyproject: boolean,
): string {
  const quoted = shellQuote(notebookRelPath);
  const execute = `python /usr/local/bin/execute-notebook ${quoted}`;
  return hasPyproject
    ? `uv run --project . ${NOTEBOOK_TOOLCHAIN_WITH} ${execute}`
    : execute;
}

/** validate-notebook is a baked system CLI, independent of the project venv. */
export function validateNotebookCommand(notebookRelPath: string): string {
  return `validate-notebook ${shellQuote(notebookRelPath)}`;
}

/**
 * Fingerprints the post-run tree while enforcing the file, visited-entry, path,
 * and output ceilings before the manifest crosses the container boundary. A
 * partial manifest exits non-zero and is never diffed: treating one as complete
 * could make untouched project files look deleted.
 */
export function treeManifestCommand(): string {
  const script = String.raw`
import hashlib
import os
import sys

pruned = {
    ".venv", "venv", "__pycache__", ".ipynb_checkpoints", ".cache",
    ".uv-cache", "node_modules", ".git", ".pytest_cache", ".mypy_cache",
}
file_count = entry_count = path_bytes = eligible_bytes = 0

def fail(message):
    sys.stderr.write(message + "\n")
    raise SystemExit(73)

pending = ["."]
while pending:
    current = pending.pop()
    try:
        with os.scandir(current) as entries:
            for entry in entries:
                entry_count += 1
                if entry_count > ${ANALYSIS_MANIFEST_MAX_ENTRIES}:
                    fail("analysis manifest exceeds visited-entry limit")
                if entry.is_dir(follow_symlinks=False):
                    if entry.name not in pruned:
                        pending.append(entry.path)
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                relative = os.path.relpath(entry.path, ".").replace(os.sep, "/")
                if any(character in relative for character in ("\0", "\n", "\r", "\\")):
                    fail("analysis manifest contains an unsupported path")
                try:
                    encoded_path = relative.encode("utf-8", "strict")
                except UnicodeError:
                    fail("analysis manifest contains a non-UTF-8 path")
                file_count += 1
                path_bytes += len(encoded_path)
                if file_count > ${ANALYSIS_MANIFEST_MAX_FILES}:
                    fail("analysis manifest exceeds file limit")
                if path_bytes > ${ANALYSIS_MANIFEST_MAX_PATH_BYTES}:
                    fail("analysis manifest exceeds path-byte limit")
                try:
                    size = entry.stat(follow_symlinks=False).st_size
                except OSError:
                    fail("analysis manifest could not stat the complete project tree")
                if size < 0:
                    fail("analysis manifest contains an invalid file size")
                if size > ${ANALYSIS_MAX_PERSIST_BYTES}:
                    # Oversize files are reported as changed without reading
                    # their bodies. persistChangedFiles will surface them in
                    # skippedOversize instead of copying them into project R2.
                    marker = hashlib.sha256(("oversize:" + str(size)).encode()).hexdigest()
                    print(marker + "  ./" + relative)
                    continue
                eligible_bytes += size
                if eligible_bytes > ${ANALYSIS_MAX_PERSIST_TOTAL_BYTES}:
                    fail("analysis manifest exceeds aggregate eligible-byte limit")
                digest = hashlib.sha256()
                with open(entry.path, "rb") as source:
                    remaining = size
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            fail("analysis manifest file changed while hashing")
                        digest.update(chunk)
                        remaining -= len(chunk)
                    if source.read(1):
                        fail("analysis manifest file changed while hashing")
                print(digest.hexdigest() + "  ./" + relative)
    except OSError:
        fail("analysis manifest could not read the complete project tree")
print("CAMELAI_MANIFEST_V1 " + str(file_count))
`;
  return `python3 -I -c ${shellQuote(script)}`;
}

// ---------------------------------------------------------------------------
// Core run logic (pure of `this`, testable with fakes)
// ---------------------------------------------------------------------------

/**
 * Two-phase marker for session-death recovery.
 *
 * A dead shell is only SAFE to retry while the agent's own command has not been
 * dispatched yet — a stale session faulting on mkdir/materialize is the case a
 * retry actually fixes. Once `started` flips, the command is in the container's
 * hands: it may have run fully or partly (external DB writes, /outputs writes,
 * outbound calls all survive the shell), so re-running it would double-apply.
 *
 * The flag is flipped immediately before the dispatch and stays set for the
 * rest of the run, which also covers a death raised LATER (persist, cleanup).
 */
export interface AnalysisCommandDispatch {
  started: boolean;
}

interface AnalysisRunDeps {
  sandbox: AnalysisSandboxLike;
  files: WorkspaceFileStoreLike;
  projectId: string;
  newRunId: () => string;
  /** Reserved by the chat attempt before dispatch; zero means inline-only. */
  outputCaptureBytes?: number;
  /** Trusted R2 prefix paired with /outputs for archive cleanup after reset. */
  outputObjectPrefix?: string;
  /** Set by withSessionRecovery; absent in direct unit calls. */
  dispatch?: AnalysisCommandDispatch;
  /** One absolute service-side lifecycle budget; direct helper tests may omit. */
  budget?: AnalysisOperationBudget;
}

/**
 * Per-invocation working directory for a project run. Concurrent runs on the
 * same project (Promise.all in js_exec, overlapping app calls) each materialize
 * into their own tree and persist a diff against their own start manifest, so
 * one run can never clobber or persist another run's intermediate state. The
 * project venv is shared across runs via UV_PROJECT_ENVIRONMENT (uv holds its
 * own lock during sync), so isolation doesn't cost env warmth.
 */
function analysisRunWorkdir(projectId: string, runId: string): string {
  return `${ANALYSIS_PROJECT_ROOT}/${sanitizeSegment(projectId)}/runs/${sanitizeSegment(runId)}`;
}

/**
 * Per-run scratch dir, created by the service before user code runs and removed
 * with the workdir. Exposed to the run as $SCRATCH — the documented home for
 * large intermediates, so they never enter the persist diff and never
 * accumulate in the warm container.
 */
function analysisRunScratchDir(runId: string): string {
  return `${ANALYSIS_SCRATCH_ROOT}/${sanitizeSegment(runId)}`;
}

/**
 * Remove every per-run directory or reset the disposable container. Returning
 * success while neither happened would let warm-container disk grow without a
 * lifetime bound, so an unconfirmed reset is an explicit run failure.
 */
async function cleanupWorkdirs(
  sandbox: AnalysisSandboxLike,
  workdirs: readonly string[],
  budget?: AnalysisOperationBudget,
): Promise<void> {
  if (!workdirs.length) return;
  // The admission wrapper owns the one destructive reset after its deadline.
  // A late continuation must stop here instead of racing a second cleanup.
  if (budget?.signal.aborted) return;
  let cleanupError: unknown;
  try {
    const timeout = remainingAnalysisWorkMs(budget, 30_000);
    const result = await sandbox.execBounded(
      `rm -rf -- ${workdirs.map(shellQuote).join(" ")}`,
      { cwd: "/", timeout, ...(budget ? { signal: budget.signal } : {}) },
      {
        stdoutBytes: 1024,
        stderrBytes: 4096,
        ...(budget ? { executionOwnerToken: budget.ownerToken } : {}),
      },
    );
    assertAnalysisOperationActive(budget);
    const exitCode =
      result && typeof result.exitCode === "number"
        ? result.exitCode
        : result?.success === false
          ? 1
          : 0;
    if (exitCode === 0) return;
    cleanupError = new Error(`analysis directory cleanup exited ${exitCode}`);
  } catch (error) {
    cleanupError = error;
  }

  await resetAnalysisContainer(sandbox, cleanupError, budget);
}

async function resetAnalysisContainer(
  sandbox: AnalysisSandboxLike,
  cause: unknown,
  budget?: AnalysisOperationBudget,
): Promise<void> {
  if (budget?.reset) return budget.reset;
  if (typeof sandbox.destroyAndForgetContainerGeneration !== "function") {
    const error = new Error("Analysis container reset is unavailable", {
      cause,
    });
    budget?.abort(error);
    throw error;
  }
  const runReset = async () => {
    const remaining = budget
      ? Math.floor(budget.deadlineAt - Date.now())
      : ANALYSIS_CLEANUP_RESET_TIMEOUT_MS;
    if (remaining <= 0) {
      throw new Error("Analysis container reset was unconfirmed", { cause });
    }
    const reset = Promise.resolve()
      .then(() => sandbox.destroyAndForgetContainerGeneration!())
      .then(
        () => true,
        () => false,
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(
        () => resolve(false),
        Math.max(1, Math.min(ANALYSIS_CLEANUP_RESET_TIMEOUT_MS, remaining)),
      );
    });
    const resetConfirmed = await Promise.race([reset, deadline]);
    if (timer) clearTimeout(timer);
    if (!resetConfirmed) {
      throw new Error("Analysis container reset was unconfirmed", { cause });
    }
  };
  const reset = runReset().catch((error) => {
    budget?.abort(error);
    throw error;
  });
  if (budget) budget.reset = reset;
  return reset;
}

async function settleAnalysisArchives(
  sandbox: AnalysisSandboxStub,
  budget: AnalysisOperationBudget,
  action: "acknowledge" | "discard",
): Promise<void> {
  for (const [taintToken, objectKey] of budget.archives) {
    assertAnalysisOperationActive(budget);
    const method =
      action === "acknowledge"
        ? sandbox.acknowledgeBoundedExecArchive
        : sandbox.discardBoundedExecArchive;
    if (typeof method !== "function") {
      const error = new Error(
        `Analysis archive ${action} capability is unavailable`,
      );
      budget.abort(error);
      throw error;
    }
    const confirmed = await awaitAnalysisOperation(
      method.call(sandbox, {
        ownerToken: budget.ownerToken,
        taintToken,
        objectKey,
      }),
      budget,
    );
    if (!confirmed) {
      const error = new Error(`Analysis archive ${action} was unconfirmed`);
      budget.abort(error);
      throw error;
    }
    budget.archives.delete(taintToken);
  }
}

/** Final-window cleanup after the ordinary work budget has already aborted. */
async function discardAnalysisArchivesAfterAbort(
  sandbox: AnalysisSandboxStub,
  budget: AnalysisOperationBudget,
): Promise<void> {
  for (const [taintToken, objectKey] of budget.archives) {
    const remaining = Math.floor(budget.deadlineAt - Date.now());
    if (
      remaining <= 0 ||
      typeof sandbox.discardBoundedExecArchive !== "function"
    ) {
      throw new Error("Analysis archive discard was unconfirmed");
    }
    const confirmed = await withAnalysisAdmissionRpcDeadline(
      sandbox.discardBoundedExecArchive({
        ownerToken: budget.ownerToken,
        taintToken,
        objectKey,
      }),
      "release",
      Math.min(remaining, ANALYSIS_ARCHIVE_HANDOFF_TIMEOUT_MS),
    );
    if (!confirmed) throw new Error("Analysis archive discard was unconfirmed");
    budget.archives.delete(taintToken);
  }
}

/**
 * Per-run bookkeeping for the cleanup `finally`: did this run die with the
 * container's shell?
 */
interface AnalysisRunOutcome {
  sessionDied: boolean;
}

/**
 * Remove a run's scratch/work dirs. A dead shell cannot prove that its
 * container or run directories disappeared, so production stubs reset the
 * disposable container; minimal legacy/test fakes without destroy retain the
 * historical skip behavior.
 */
async function cleanupRunDirs(
  sandbox: AnalysisSandboxLike,
  outcome: AnalysisRunOutcome,
  budget: AnalysisOperationBudget | undefined,
  ...workdirs: string[]
): Promise<void> {
  if (budget?.signal.aborted) return;
  if (outcome.sessionDied) {
    if (typeof sandbox.destroyAndForgetContainerGeneration === "function") {
      await resetAnalysisContainer(
        sandbox,
        new Error("analysis session died before directory cleanup"),
        budget,
      );
    }
    return;
  }
  await cleanupWorkdirs(sandbox, workdirs, budget);
}

/** Execute + validate a notebook, persisting the changed set back. */
/** Flip the dispatch marker immediately before the agent's command leaves us. */
function markCommandDispatched(dispatch?: AnalysisCommandDispatch): void {
  if (dispatch) dispatch.started = true;
}

const ANALYSIS_COMMAND_STDOUT_BYTES = 96 * 1024;
const ANALYSIS_COMMAND_STDERR_BYTES = 96 * 1024;

async function boundedAnalysisExec(
  sandbox: AnalysisSandboxLike,
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeout?: number;
    signal?: AbortSignal;
  },
  label: string,
  limits: {
    stdoutBytes?: number;
    stderrBytes?: number;
    overflowBytes?: number;
    overflowObjectPrefix?: string;
  } = {},
  budget?: AnalysisOperationBudget,
): Promise<{
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  fullOutput?: AnalysisFullOutput;
  outputTruncated?: boolean;
}> {
  const filename = `${Date.now()}-${label.replace(/[^a-z0-9-]/gi, "-")}-${crypto.randomUUID().slice(0, 8)}.log`;
  const relativePath = `outputs/tmp/${filename}`;
  const overflowObjectKey = limits.overflowObjectPrefix
    ? `${limits.overflowObjectPrefix.replace(/\/+$/, "")}/tmp/${filename}`
    : undefined;
  const overflowBytes = Number.isFinite(limits.overflowBytes)
    ? Math.max(
        0,
        Math.min(
          CHAT_RUNTIME_BOUNDS.analysisOutputOverflowBytes,
          Math.floor(limits.overflowBytes ?? 0),
        ),
      )
    : 0;
  const requestedTimeout = Number.isFinite(options.timeout)
    ? Math.max(1, Math.floor(options.timeout ?? 1))
    : DEFAULT_EXEC_TIMEOUT_MS;
  const timeout = remainingAnalysisWorkMs(budget, requestedTimeout);
  const result = await sandbox.execBounded(
    command,
    {
      ...options,
      timeout,
      ...(budget ? { signal: budget.signal } : {}),
    },
    {
      stdoutBytes: limits.stdoutBytes ?? ANALYSIS_COMMAND_STDOUT_BYTES,
      stderrBytes: limits.stderrBytes ?? ANALYSIS_COMMAND_STDERR_BYTES,
      ...(budget ? { executionOwnerToken: budget.ownerToken } : {}),
      ...(overflowBytes > 0
        ? {
            overflowPath: `/${relativePath}`,
            ...(overflowObjectKey ? { overflowObjectKey } : {}),
            overflowBytes,
          }
        : {}),
    },
  );
  if (
    budget &&
    overflowObjectKey &&
    result.overflowStored &&
    result.overflowTaintToken
  ) {
    budget.archives.set(result.overflowTaintToken, overflowObjectKey);
  } else if (budget && overflowObjectKey && result.overflowStored) {
    const error = new Error(
      "Bounded analysis archive was not durably staged for acknowledgement",
    );
    budget.abort(error);
    throw error;
  }
  assertAnalysisOperationActive(budget);
  return {
    ...result,
    ...(result.outputTruncated && result.overflowStored
      ? {
          fullOutput: {
            path: relativePath,
            bytes: result.overflowBytes,
            complete: result.overflowComplete,
            hint: result.overflowComplete
              ? `stdout/stderr were truncated inline. Complete output: read({ location: "r2", path: "${relativePath}" })`
              : `stdout/stderr exceeded the bounded archive. Read its bounded head/tail at read({ location: "r2", path: "${relativePath}" }).`,
          },
        }
      : {}),
  };
}

export async function runAnalysisNotebook(
  request: { path: string; timeoutMs?: number },
  deps: AnalysisRunDeps,
  prevalidatedNotebookRel?: string,
): Promise<AnalysisNotebookResult> {
  const startedAt = Date.now();
  const validation = prevalidatedNotebookRel
    ? ({ ok: true, value: prevalidatedNotebookRel } as const)
    : validateAnalysisNotebookPath(request.path);
  if (!validation.ok) return emptyNotebookResult(startedAt, validation.error);
  const notebookRel = validation.value;
  const timeoutMs = clampTimeout(
    request.timeoutMs,
    DEFAULT_NOTEBOOK_TIMEOUT_MS,
    MAX_NOTEBOOK_TIMEOUT_MS,
  );

  const runId = deps.newRunId();
  const workdir = analysisRunWorkdir(deps.projectId, runId);
  const scratchDir = analysisRunScratchDir(runId);
  const outcome: AnalysisRunOutcome = { sessionDied: false };
  try {
    const before = await materializeProject(
      deps.sandbox,
      workdir,
      deps.files,
      deps.budget,
    );
    if (!before.some((f) => f.path === notebookRel)) {
      return emptyNotebookResult(
        startedAt,
        `notebook ${notebookRel} not found in project`,
      );
    }
    const hasPyproject = before.some((f) => f.path === "pyproject.toml");
    const beforeManifest = await snapshotProjectManifest(
      deps.sandbox,
      workdir,
      deps.budget,
    );
    await awaitAnalysisOperation(
      deps.sandbox.mkdir(scratchDir, { recursive: true }),
      deps.budget,
    );

    markCommandDispatched(deps.dispatch);
    const nb = normalizeExec(
      await boundedAnalysisExec(
        deps.sandbox,
        notebookExecuteCommand(notebookRel, hasPyproject),
        {
          cwd: workdir,
          timeout: timeoutMs,
          env: {
            ...analysisRunEnv({ projectId: deps.projectId }),
            SCRATCH: scratchDir,
          },
        },
        "run-notebook",
        {
          stdoutBytes: ANALYSIS_NOTEBOOK_STDOUT_BYTES,
          stderrBytes: ANALYSIS_NOTEBOOK_STDERR_BYTES,
          overflowBytes: deps.outputCaptureBytes,
          overflowObjectPrefix: deps.outputObjectPrefix,
        },
        deps.budget,
      ),
    );

    // Always run the validator (nbconvert can "succeed" while embedding error
    // outputs the report would surface); its stdout is the structured issue list.
    const val = normalizeExec(
      await boundedAnalysisExec(
        deps.sandbox,
        validateNotebookCommand(notebookRel),
        {
          cwd: workdir,
          timeout: ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS,
        },
        "validate-notebook",
        {},
        deps.budget,
      ),
    );
    const validation = parseValidateNotebookOutput(val.stdout, val.exitCode);

    const persisted = await persistChangedFiles(
      deps.sandbox,
      workdir,
      deps.files,
      beforeManifest,
      undefined,
      deps.budget,
    );
    const executed = nb.exitCode === 0;
    const ok = executed && validation.clean;
    return {
      ok,
      executed,
      validation,
      // Inline output is bounded at the producer. A separately reserved,
      // bounded archive is included only when /outputs is durably mounted.
      stdout: nb.stdout,
      stderr: nb.stderr,
      exitCode: nb.exitCode,
      outputTruncated: nb.outputTruncated,
      ...(nb.fullOutput ? { fullOutput: nb.fullOutput } : {}),
      ...persisted,
      durationMs: Date.now() - startedAt,
      ...(ok ? {} : { error: notebookErrorMessage(nb, validation) }),
    };
  } catch (error) {
    outcome.sessionDied = isSandboxSessionDeathError(error);
    throw error;
  } finally {
    await cleanupRunDirs(
      deps.sandbox,
      outcome,
      deps.budget,
      workdir,
      scratchDir,
    );
  }
}

/** Ad-hoc shell in a project working dir (or a scratch dir when no project). */
export async function runAnalysisExec(
  request: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  },
  deps: AnalysisRunDeps & { hasProject: boolean; scratchId: string },
  prevalidatedRequest?: ValidatedAnalysisExecRequest,
): Promise<AnalysisExecResult> {
  const startedAt = Date.now();
  const validation = prevalidatedRequest
    ? ({ ok: true, value: prevalidatedRequest } as const)
    : validateAnalysisExecRequest(request);
  if (!validation.ok) return emptyExecResult(startedAt, validation.error);
  const validatedRequest = validation.value;
  const requestEnvironment = validatedRequest.env;
  const timeoutMs = clampTimeout(
    validatedRequest.timeoutMs,
    DEFAULT_EXEC_TIMEOUT_MS,
    MAX_NOTEBOOK_TIMEOUT_MS,
  );

  const outcome: AnalysisRunOutcome = { sessionDied: false };
  if (!deps.hasProject) {
    const scratch = `${ANALYSIS_SCRATCH_ROOT}/${sanitizeSegment(deps.scratchId)}`;
    try {
      await awaitAnalysisOperation(
        deps.sandbox.mkdir(scratch, { recursive: true }),
        deps.budget,
      );
      const cwd = validatedRequest.cwd
        ? joinWithin(scratch, validatedRequest.cwd)
        : scratch;
      markCommandDispatched(deps.dispatch);
      const res = normalizeExec(
        await boundedAnalysisExec(
          deps.sandbox,
          validatedRequest.command,
          {
            cwd,
            timeout: timeoutMs,
            env: {
              ...analysisRunEnv(),
              SCRATCH: scratch,
              ...requestEnvironment,
            },
          },
          "analysis-exec",
          {
            overflowBytes: deps.outputCaptureBytes,
            overflowObjectPrefix: deps.outputObjectPrefix,
          },
          deps.budget,
        ),
      );
      return {
        ok: res.exitCode === 0,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
        changedFiles: [],
        removedFiles: [],
        skippedOversize: [],
        durationMs: Date.now() - startedAt,
        outputTruncated: res.outputTruncated,
        ...(res.fullOutput ? { fullOutput: res.fullOutput } : {}),
        ...(res.exitCode === 0 ? {} : { error: execError(res) }),
      };
    } catch (error) {
      outcome.sessionDied = isSandboxSessionDeathError(error);
      throw error;
    } finally {
      // Scratch is per-call; without cleanup a warm container accumulates
      // abandoned scratch trees until its disk fills.
      await cleanupRunDirs(deps.sandbox, outcome, deps.budget, scratch);
    }
  }

  const runId = deps.newRunId();
  const workdir = analysisRunWorkdir(deps.projectId, runId);
  const scratchDir = analysisRunScratchDir(runId);
  try {
    await materializeProject(deps.sandbox, workdir, deps.files, deps.budget);
    const beforeManifest = await snapshotProjectManifest(
      deps.sandbox,
      workdir,
      deps.budget,
    );
    await awaitAnalysisOperation(
      deps.sandbox.mkdir(scratchDir, { recursive: true }),
      deps.budget,
    );
    const cwd = validatedRequest.cwd
      ? joinWithin(workdir, validatedRequest.cwd)
      : workdir;
    markCommandDispatched(deps.dispatch);
    const res = normalizeExec(
      await boundedAnalysisExec(
        deps.sandbox,
        validatedRequest.command,
        {
          cwd,
          timeout: timeoutMs,
          env: {
            ...analysisRunEnv({ projectId: deps.projectId }),
            SCRATCH: scratchDir,
            ...requestEnvironment,
          },
        },
        "analysis-exec",
        {
          overflowBytes: deps.outputCaptureBytes,
          overflowObjectPrefix: deps.outputObjectPrefix,
        },
        deps.budget,
      ),
    );
    const persisted = await persistChangedFiles(
      deps.sandbox,
      workdir,
      deps.files,
      beforeManifest,
      undefined,
      deps.budget,
    );
    return {
      ok: res.exitCode === 0,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      ...persisted,
      durationMs: Date.now() - startedAt,
      outputTruncated: res.outputTruncated,
      ...(res.fullOutput ? { fullOutput: res.fullOutput } : {}),
      ...(res.exitCode === 0 ? {} : { error: execError(res) }),
    };
  } catch (error) {
    outcome.sessionDied = isSandboxSessionDeathError(error);
    throw error;
  } finally {
    await cleanupRunDirs(
      deps.sandbox,
      outcome,
      deps.budget,
      workdir,
      scratchDir,
    );
  }
}

/** `uv add` the packages, persisting pyproject.toml + uv.lock back. */
export async function runAnalysisAddDependency(
  request: { packages: string[]; dev?: boolean },
  deps: AnalysisRunDeps,
  prevalidatedPackages?: string[],
): Promise<AnalysisDependencyResult> {
  const startedAt = Date.now();
  const packages =
    prevalidatedPackages ?? normalizeDependencySpecs(request.packages);
  const workdir = analysisRunWorkdir(deps.projectId, deps.newRunId());
  const outcome: AnalysisRunOutcome = { sessionDied: false };
  try {
    const before = await materializeProject(
      deps.sandbox,
      workdir,
      deps.files,
      deps.budget,
    );
    const hasPyproject = before.some((f) => f.path === "pyproject.toml");

    // `uv add` requires a project; init one if the analysis project has no
    // pyproject.toml yet (mirrors the skill's old `uv init` preamble, now
    // implicit). A fresh pyproject is seeded with the DEFAULT STACK alongside
    // the requested packages: once a project declares its own env, uv runs use
    // ONLY that env, so the advertised "preinstalled defaults + extras" flow
    // must be reproduced in the declaration (installs come from the seeded
    // cache, so this is fast).
    const initCmd = hasPyproject
      ? ""
      : `uv init --no-workspace --python 3.13 && uv add ${ANALYSIS_DEFAULT_STACK.map(shellQuote).join(" ")} && `;
    const command = `${initCmd}uv add ${request.dev ? "--dev " : ""}${packages.map(shellQuote).join(" ")}`;
    markCommandDispatched(deps.dispatch);
    const res = normalizeExec(
      await boundedAnalysisExec(
        deps.sandbox,
        command,
        {
          cwd: workdir,
          timeout: DEFAULT_DEP_TIMEOUT_MS,
          env: analysisRunEnv({ projectId: deps.projectId }),
        },
        "add-dependency",
        {},
        deps.budget,
      ),
    );

    const persisted =
      res.exitCode === 0
        ? await withAnalysisPersistBudget(
            async (budget) => ({
              pyproject: await persistSingleFile(
                deps.sandbox,
                workdir,
                deps.files,
                "pyproject.toml",
                budget,
              ),
              lock: await persistSingleFile(
                deps.sandbox,
                workdir,
                deps.files,
                "uv.lock",
                budget,
              ),
            }),
            undefined,
            deps.budget,
          )
        : { pyproject: false, lock: false };
    return {
      ok: res.exitCode === 0,
      packages,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      pyprojectPersisted: persisted.pyproject,
      lockPersisted: persisted.lock,
      durationMs: Date.now() - startedAt,
      ...(res.fullOutput ? { fullOutput: res.fullOutput } : {}),
      ...(res.exitCode === 0 ? {} : { error: execError(res) }),
    };
  } catch (error) {
    outcome.sessionDied = isSandboxSessionDeathError(error);
    throw error;
  } finally {
    await cleanupRunDirs(deps.sandbox, outcome, deps.budget, workdir);
  }
}

/**
 * Run a Python string (warehouse-compatible). No project — reads only the mounted
 * exports/uploads. `params` are injected as a Python dict, not interpolated.
 */
export async function runAnalysisCode(
  request: { code: string; params?: Record<string, unknown> },
  deps: {
    sandbox: AnalysisSandboxLike;
    scratchId: string;
    connections?: boolean;
    outputCaptureBytes?: number;
    outputObjectPrefix?: string;
    dispatch?: AnalysisCommandDispatch;
    budget?: AnalysisOperationBudget;
  },
  prevalidatedCode?: string,
): Promise<AnalysisRunCodeResult> {
  const validation = prevalidatedCode
    ? ({ ok: true, value: prevalidatedCode } as const)
    : validateAnalysisCodeRequest(request);
  if (!validation.ok) {
    return { ok: false, error: validation.error, outputTruncated: false };
  }
  const code = validation.value;
  const scratch = `${ANALYSIS_SCRATCH_ROOT}/${sanitizeSegment(deps.scratchId)}`;
  const scriptPath = `${scratch}/main.py`;
  const outcome: AnalysisRunOutcome = { sessionDied: false };
  try {
    await awaitAnalysisOperation(
      deps.sandbox.mkdir(scratch, { recursive: true }),
      deps.budget,
    );
    await awaitAnalysisOperation(
      deps.sandbox.writeFile(scriptPath, base64FromString(code), {
        encoding: "base64",
      }),
      deps.budget,
    );
    markCommandDispatched(deps.dispatch);
    const res = normalizeExec(
      await boundedAnalysisExec(
        deps.sandbox,
        `python ${shellQuote(scriptPath)}`,
        {
          cwd: scratch,
          timeout: DEFAULT_EXEC_TIMEOUT_MS,
          env: {
            ...analysisRunEnv({ connections: deps.connections }),
            SCRATCH: scratch,
          },
        },
        "run-code",
        {
          overflowBytes: deps.outputCaptureBytes,
          overflowObjectPrefix: deps.outputObjectPrefix,
        },
        deps.budget,
      ),
    );
    if (res.exitCode !== 0) {
      // Deliberately NOT flagged as a session death, whatever the text says:
      // `execError` is the user program's own stderr, and a script that merely
      // PRINTS "SessionTerminatedError" must not trigger a silent re-run.
      return {
        ok: false,
        stdout: res.stdout,
        stderr: res.stderr,
        error: execError(res),
        outputTruncated: res.outputTruncated,
        ...(res.fullOutput ? { fullOutput: res.fullOutput } : {}),
      };
    }
    return {
      ok: true,
      stdout: res.stdout,
      stderr: res.stderr,
      outputTruncated: res.outputTruncated,
      ...(res.fullOutput ? { fullOutput: res.fullOutput } : {}),
    };
  } catch (error) {
    outcome.sessionDied = isSandboxSessionDeathError(error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : "analysis code failed",
      // Structured marker: this shape reports environment failures as a VALUE
      // (deployed apps depend on that), so recovery needs a signal it cannot
      // confuse with program output.
      ...(outcome.sessionDied ? { sessionDeath: true as const } : {}),
    };
  } finally {
    // Scratch is per-call; without cleanup a warm container accumulates
    // abandoned scratch trees until its disk fills.
    await cleanupRunDirs(deps.sandbox, outcome, deps.budget, scratch);
  }
}

// ---------------------------------------------------------------------------
// Materialize / persist
// ---------------------------------------------------------------------------

async function materializeProject(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  files: WorkspaceFileStoreLike,
  budget?: AnalysisOperationBudget,
): Promise<AnalysisSourceFile[]> {
  const sourceFiles = await collectProjectSourceFiles(files, budget);
  await awaitAnalysisOperation(
    sandbox.mkdir(workdir, { recursive: true }),
    budget,
  );
  // Every run gets a UUID-unique workdir, so there is no previous source tree
  // to wipe and no reason to run another output-producing shell command here.
  for (const file of sourceFiles) {
    assertAnalysisOperationActive(budget);
    const targetPath = `${workdir}/${file.path}`;
    const parent = dirname(targetPath);
    if (parent && parent !== workdir)
      await awaitAnalysisOperation(
        sandbox.mkdir(parent, { recursive: true }),
        budget,
      );
    const read = await awaitAnalysisOperation(
      files.readFileStream(`/${file.path}`),
      budget,
    );
    if (!read.success || !read.stream) {
      throw new Error(
        read.error || `Failed to stream /${file.path} from the project store`,
      );
    }
    if (!Number.isSafeInteger(read.size) || read.size !== file.size) {
      await read.stream.cancel().catch(() => {});
      throw new Error(
        `Project file /${file.path} changed size during analysis materialization ` +
          `(${file.size} -> ${String(read.size)} bytes)`,
      );
    }
    const exactStream = exactByteLengthStream(
      read.stream,
      file.size,
      `/${file.path}`,
    );
    const boundedStream = budget
      ? abortableAnalysisPersistStream(exactStream, budget.signal)
      : exactStream;
    try {
      // ReadableStream ownership transfers through RPC: project R2 ->
      // WorkspaceFilesystemDO -> AnalysisService -> AnalysisSandbox. No file
      // bytes or base64 copy are retained in a Worker/DO isolate.
      await awaitAnalysisOperation(
        sandbox.writeFile(targetPath, boundedStream),
        budget,
      );
    } catch (error) {
      await boundedStream.cancel().catch(() => {});
      throw error;
    }
  }
  return sourceFiles;
}

function exactByteLengthStream(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
  label: string,
): ReadableStream<Uint8Array> {
  let receivedBytes = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error(`Project file ${label} returned a non-byte stream`);
        }
        if (chunk.byteLength > expectedBytes - receivedBytes) {
          throw new Error(
            `Project file ${label} exceeded its listed byte size while streaming`,
          );
        }
        receivedBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (receivedBytes !== expectedBytes) {
          throw new Error(
            `Project file ${label} ended after ${receivedBytes} of ${expectedBytes} listed bytes`,
          );
        }
      },
    }),
  );
}

async function snapshotProjectManifest(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  budget?: AnalysisOperationBudget,
): Promise<Map<string, string>> {
  const manifest = normalizeExec(
    await boundedAnalysisExec(
      sandbox,
      treeManifestCommand(),
      { cwd: workdir, timeout: ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS },
      "tree-manifest",
      {
        stdoutBytes: ANALYSIS_MANIFEST_MAX_BYTES,
        stderrBytes: 8 * 1024,
      },
      budget,
    ),
  );
  if (manifest.exitCode !== 0) {
    throw new Error(
      `analysis persist aborted: tree manifest failed with exit code ${manifest.exitCode}` +
        (manifest.stderr ? `: ${manifest.stderr.slice(0, 500)}` : ""),
    );
  }
  if (manifest.outputTruncated) {
    throw new Error(
      `analysis persist aborted: tree manifest exceeds ${ANALYSIS_MANIFEST_MAX_BYTES} bytes`,
    );
  }
  const parsed = parseSha256Manifest(manifest.stdout);
  if (parsed.size > ANALYSIS_MANIFEST_MAX_FILES) {
    throw new Error(
      `analysis persist aborted: tree manifest exceeds ${ANALYSIS_MANIFEST_MAX_FILES} files`,
    );
  }
  return parsed;
}

interface StreamedSandboxFile {
  stream: ReadableStream<Uint8Array>;
  size: number;
  mimeType?: string;
}

interface AnalysisPersistBudget {
  deadlineAt: number;
  signal: AbortSignal;
  reservedBytes: number;
}

function analysisPersistDeadlineError(): Error {
  return new Error("analysis persist deadline exceeded");
}

function assertAnalysisPersistActive(budget: AnalysisPersistBudget): void {
  if (budget.signal.aborted || Date.now() >= budget.deadlineAt) {
    throw analysisPersistDeadlineError();
  }
}

async function withAnalysisPersistBudget<T>(
  run: (budget: AnalysisPersistBudget) => Promise<T>,
  timeoutMs = ANALYSIS_PERSIST_TIMEOUT_MS,
  operationBudget?: AnalysisOperationBudget,
): Promise<T> {
  const requestedDurationMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(ANALYSIS_PERSIST_TIMEOUT_MS, Math.floor(timeoutMs)))
    : ANALYSIS_PERSIST_TIMEOUT_MS;
  const durationMs = operationBudget
    ? remainingAnalysisWorkMs(operationBudget, requestedDurationMs)
    : requestedDurationMs;
  const controller = new AbortController();
  const budget: AnalysisPersistBudget = {
    deadlineAt: Date.now() + durationMs,
    signal: controller.signal,
    reservedBytes: 0,
  };
  const operation = Promise.resolve().then(() => run(budget));
  // The persist timer may return a bounded error before a remote adoption or
  // deletion reports its outcome. Keep that continuation visible to the outer
  // admission owner so it cannot release the workspace lease meanwhile.
  operationBudget?.pending.add(operation);
  void operation.then(
    () => operationBudget?.pending.delete(operation),
    () => operationBudget?.pending.delete(operation),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const parentAbort = () =>
    controller.abort(
      operationBudget?.signal.reason ?? analysisPersistDeadlineError(),
    );
  if (operationBudget?.signal.aborted) parentAbort();
  else
    operationBudget?.signal.addEventListener("abort", parentAbort, {
      once: true,
    });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = analysisPersistDeadlineError();
      controller.abort(error);
      operationBudget?.abort(error);
      reject(error);
    }, durationMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    operationBudget?.signal.removeEventListener("abort", parentAbort);
  }
}

async function openSandboxFileStream(
  sandbox: AnalysisSandboxLike,
  path: string,
  budget: AnalysisPersistBudget,
): Promise<StreamedSandboxFile> {
  assertAnalysisPersistActive(budget);
  const read = await sandbox.readFile(path, { encoding: "none" });
  if (typeof read.content === "string") {
    throw new Error(`Sandbox did not return a binary stream for ${path}`);
  }
  if (!Number.isSafeInteger(read.size) || (read.size as number) < 0) {
    await read.content.cancel().catch(() => {});
    throw new Error(`Sandbox did not report a valid byte size for ${path}`);
  }
  if (budget.signal.aborted || Date.now() >= budget.deadlineAt) {
    await read.content.cancel().catch(() => {});
    throw analysisPersistDeadlineError();
  }
  return {
    stream: read.content,
    size: read.size as number,
    mimeType: read.mimeType,
  };
}

function abortableAnalysisPersistStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abort = () => {
    if (finished) return;
    finished = true;
    const reason = signal.reason ?? analysisPersistDeadlineError();
    void reader.cancel(reason).catch(() => {});
    controller?.error(reason);
  };
  return new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(nextController) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) {
          finished = true;
          signal.removeEventListener("abort", abort);
          nextController.close();
          return;
        }
        nextController.enqueue(next.value);
      } catch (error) {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", abort);
        nextController.error(error);
      }
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      await reader.cancel(reason);
    },
  });
}

async function persistOpenedSandboxFile(
  files: WorkspaceFileStoreLike,
  rel: string,
  opened: StreamedSandboxFile,
  budget: AnalysisPersistBudget,
): Promise<"persisted" | "oversize"> {
  assertAnalysisPersistActive(budget);
  if (opened.size > ANALYSIS_MAX_PERSIST_BYTES) {
    await opened.stream.cancel().catch(() => {});
    return "oversize";
  }
  if (opened.size > ANALYSIS_MAX_PERSIST_TOTAL_BYTES - budget.reservedBytes) {
    await opened.stream.cancel().catch(() => {});
    throw new Error(
      `analysis persist exceeds the ${ANALYSIS_MAX_PERSIST_TOTAL_BYTES} aggregate-byte limit`,
    );
  }
  if (!files.adoptR2File) {
    await opened.stream.cancel().catch(() => {});
    throw new Error(
      "Project file store does not support streaming R2 adoption",
    );
  }
  // Reserve before crossing the RPC boundary. A failed or uncertain adoption
  // never refunds capacity, so concurrent/late completion cannot exceed the
  // per-run contract.
  budget.reservedBytes += opened.size;
  const abortableStream = abortableAnalysisPersistStream(
    opened.stream,
    budget.signal,
  );
  const result = await files.adoptR2File(
    `/${rel}`,
    abortableStream,
    opened.size,
    opened.mimeType,
  );
  assertAnalysisPersistActive(budget);
  if (!result.success) {
    throw new Error(result.error || `Failed to persist ${rel}`);
  }
  return "persisted";
}

async function persistChangedFiles(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  files: WorkspaceFileStoreLike,
  beforeManifest: Map<string, string>,
  timeoutMs = ANALYSIS_PERSIST_TIMEOUT_MS,
  operationBudget?: AnalysisOperationBudget,
): Promise<{
  changedFiles: string[];
  removedFiles: string[];
  skippedOversize: string[];
}> {
  return withAnalysisPersistBudget(
    async (budget) => {
      // NEVER diff against a failed/partial manifest: an incomplete listing makes
      // untouched files look removed and the loop below would delete them from the
      // project store. Fail the run loudly instead.
      const afterManifest = await snapshotProjectManifest(
        sandbox,
        workdir,
        operationBudget,
      );
      assertAnalysisPersistActive(budget);
      const { changed, removed } = diffManifests(beforeManifest, afterManifest);

      const changedFiles: string[] = [];
      const skippedOversize: string[] = [];
      for (const rel of changed) {
        const opened = await openSandboxFileStream(
          sandbox,
          `${workdir}/${rel}`,
          budget,
        );
        const persisted = await persistOpenedSandboxFile(
          files,
          rel,
          opened,
          budget,
        );
        if (persisted === "oversize") {
          skippedOversize.push(rel);
          continue;
        }
        changedFiles.push(rel);
      }
      const removedFiles: string[] = [];
      for (const rel of removed) {
        assertAnalysisPersistActive(budget);
        // force covers already-gone files; any remaining failure is a genuine
        // storage error — fail loudly like the write path, or the project store
        // silently keeps files the run deleted.
        const result = await files.deleteFile(`/${rel}`, { force: true });
        assertAnalysisPersistActive(budget);
        if (!result.success)
          throw new Error(
            result.error || `Failed to remove ${rel} from the project`,
          );
        removedFiles.push(rel);
      }
      return { changedFiles, removedFiles, skippedOversize };
    },
    timeoutMs,
    operationBudget,
  );
}

async function persistSingleFile(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  files: WorkspaceFileStoreLike,
  rel: string,
  budget: AnalysisPersistBudget,
): Promise<boolean> {
  let opened: StreamedSandboxFile;
  try {
    opened = await openSandboxFileStream(sandbox, `${workdir}/${rel}`, budget);
  } catch {
    assertAnalysisPersistActive(budget);
    return false;
  }
  return (
    (await persistOpenedSandboxFile(files, rel, opened, budget)) === "persisted"
  );
}

async function collectProjectSourceFiles(
  files: WorkspaceFileStoreLike,
  budget?: AnalysisOperationBudget,
): Promise<AnalysisSourceFile[]> {
  const listing = await awaitAnalysisOperation(
    files.listFiles("/", {
      recursive: true,
      includeHidden: true,
      limit: ANALYSIS_MANIFEST_MAX_ENTRIES + 1,
      bounds: {
        maxEntries: ANALYSIS_MANIFEST_MAX_ENTRIES,
        maxFiles: ANALYSIS_MANIFEST_MAX_FILES,
        maxPathBytes: ANALYSIS_MANIFEST_MAX_PATH_BYTES,
        maxFileBytes: ANALYSIS_MAX_SOURCE_FILE_BYTES,
        maxTotalBytes: ANALYSIS_MAX_SOURCE_BYTES,
      },
    }),
    budget,
  );
  if (!listing.success)
    throw new Error(listing.error || "Failed to list project files");
  if (listing.files.length > ANALYSIS_MANIFEST_MAX_ENTRIES) {
    throw new Error("Project exceeds the analysis source entry limit");
  }
  const out: AnalysisSourceFile[] = [];
  const seen = new Set<string>();
  let pathBytes = 0;
  let totalBytes = 0;
  for (const entry of listing.files) {
    assertAnalysisOperationActive(budget);
    if (entry.type !== "file") continue;
    const listedPath = entry.absolutePath.replace(/^\/+/, "");
    const rel = normalizeAnalysisRelPath(entry.absolutePath);
    if (!rel || shouldIgnoreAnalysisPath(rel)) continue;
    if (
      rel !== listedPath ||
      listedPath.includes("\\") ||
      listedPath.includes("\0") ||
      listedPath.includes("\n") ||
      listedPath.includes("\r")
    ) {
      throw new Error(
        `Project file ${entry.absolutePath} has an unsupported path`,
      );
    }
    if (seen.has(rel))
      throw new Error(
        `Project contains duplicate file path ${entry.absolutePath}`,
      );
    seen.add(rel);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(
        `Project file ${entry.absolutePath} has an invalid byte size`,
      );
    }
    const size = entry.size;
    if (size > ANALYSIS_MAX_SOURCE_FILE_BYTES) {
      throw new Error(
        `Project file ${entry.absolutePath} exceeds the analysis source byte limit`,
      );
    }
    if (out.length >= ANALYSIS_MANIFEST_MAX_FILES) {
      throw new Error("Project exceeds the analysis source file limit");
    }
    pathBytes += utf8ByteLength(rel);
    totalBytes += size;
    if (pathBytes > ANALYSIS_MANIFEST_MAX_PATH_BYTES) {
      throw new Error("Project exceeds the analysis source path-byte limit");
    }
    if (totalBytes > ANALYSIS_MAX_SOURCE_BYTES) {
      throw new Error(
        "Project exceeds the aggregate analysis source byte limit",
      );
    }
    out.push({
      path: rel,
      size,
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function analysisRunEnv(
  options: { projectId?: string; connections?: boolean } = {},
): Record<string, string> {
  return {
    CI: "1",
    PYTHONUNBUFFERED: "1",
    // The baked camelai helper package (see ANALYSIS_PYTHONPATH).
    PYTHONPATH: ANALYSIS_PYTHONPATH,
    // Same protocol + variable the project VMs exposed, so the skill's notebook
    // helper code carries over unchanged. The host is intercepted at the sandbox
    // egress layer and served by the connectionsRpc outbound handler with the
    // workspace/org scope the service attached DO-side (see analysis-sandbox.ts).
    // Omitted for app-scoped runs, whose container never registers the
    // interception (see runCodeForApps).
    ...(options.connections === false
      ? {}
      : {
          CAMELAI_CONNECTIONS_RPC_URL: `http://${ANALYSIS_CONNECTIONS_HOST}/`,
        }),
    // Project runs use per-invocation workdirs (analysisRunWorkdir), so point uv
    // at a container-lifetime venv shared per project — env warmth survives run
    // isolation, and the venv never sits inside a persisted tree. uv locks the
    // environment during sync, so concurrent runs on one project are safe.
    ...(options.projectId
      ? {
          UV_PROJECT_ENVIRONMENT: `/venvs/project-${sanitizeSegment(options.projectId)}`,
        }
      : {}),
  };
}

function clampTimeout(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback;
  return Math.min(Math.floor(value), max);
}

function emptyNotebookResult(
  startedAt: number,
  error: string,
): AnalysisNotebookResult {
  return {
    ok: false,
    executed: false,
    validation: { clean: false, issues: [] },
    stdout: "",
    stderr: error,
    exitCode: 1,
    changedFiles: [],
    removedFiles: [],
    skippedOversize: [],
    durationMs: Date.now() - startedAt,
    outputTruncated: false,
    error,
  };
}

function emptyExecResult(startedAt: number, error: string): AnalysisExecResult {
  return {
    ok: false,
    stdout: "",
    stderr: error,
    exitCode: 1,
    changedFiles: [],
    removedFiles: [],
    skippedOversize: [],
    durationMs: Date.now() - startedAt,
    outputTruncated: false,
    error,
  };
}

function notebookErrorMessage(
  nb: { stderr: string; stdout: string; exitCode: number },
  validation: { issues: string[] },
): string {
  if (nb.exitCode !== 0) {
    // Lead with the Python traceback when we can find one — it names the
    // failing cell and exception, which is what the caller needs to fix.
    const traceback = extractNotebookTraceback(nb.stderr);
    if (traceback) return traceback;
    return (
      clampOutputTail(nb.stderr || nb.stdout, ANALYSIS_NOTEBOOK_STDERR_BYTES) ||
      `notebook execution failed with exit code ${nb.exitCode}`
    );
  }
  if (validation.issues.length)
    return `notebook validation failed:\n${validation.issues.join("\n")}`;
  return "notebook run failed";
}

function execError(res: {
  stderr: string;
  stdout: string;
  exitCode: number;
}): string {
  return (
    res.stderr || res.stdout || `command failed with exit code ${res.exitCode}`
  );
}

function normalizeExec(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  fullOutput?: AnalysisFullOutput;
  outputTruncated?: boolean;
}): {
  stdout: string;
  stderr: string;
  exitCode: number;
  fullOutput?: AnalysisFullOutput;
  outputTruncated: boolean;
} {
  const exitCode =
    typeof result.exitCode === "number"
      ? result.exitCode
      : result.success === false
        ? 1
        : 0;
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode,
    outputTruncated: result.outputTruncated === true,
    ...(result.fullOutput ? { fullOutput: result.fullOutput } : {}),
  };
}

function normalizeDependencySpecs(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  if (list.length > ANALYSIS_MAX_DEPENDENCY_SPECS) {
    throw new Error(
      `at most ${ANALYSIS_MAX_DEPENDENCY_SPECS} packages are allowed`,
    );
  }
  const out: string[] = [];
  let totalBytes = 0;
  for (const raw of list) {
    if (typeof raw !== "string")
      throw new Error("each package must be a string");
    const spec = raw.trim();
    if (!spec) continue;
    const specBytes = utf8ByteLength(spec);
    if (specBytes > ANALYSIS_MAX_DEPENDENCY_SPEC_BYTES) {
      throw new Error("package spec is too long");
    }
    totalBytes += specBytes;
    if (totalBytes > ANALYSIS_MAX_DEPENDENCY_BYTES) {
      throw new Error("package specs exceed their aggregate byte limit");
    }
    // oxlint-disable-next-line no-control-regex -- Package specs must reject ASCII control characters.
    if (/\s|[\u0000-\u001f\u007f]/.test(spec))
      throw new Error("package must be a single spec (no spaces)");
    if (spec.startsWith("-")) throw new Error("package must not be a CLI flag");
    if (spec.includes("://") || /(^|@)(?:file|git|https?):/i.test(spec)) {
      throw new Error("package must be a PyPI package spec");
    }
    out.push(spec);
  }
  if (!out.length) throw new Error("at least one package is required");
  return out;
}

/** Join a user-provided relative subdir under `base`, refusing traversal. */
function joinWithin(base: string, sub: string): string {
  const rel = normalizeAnalysisRelPath(sub);
  return rel ? `${base}/${rel}` : base;
}

function sanitizeSegment(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!cleaned) throw new Error("invalid identifier");
  return cleaned;
}

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function base64FromString(value: string): string {
  return base64FromBytes(new TextEncoder().encode(value));
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Session death (container OOM / restart under a running command)
// ---------------------------------------------------------------------------

// The classifier itself lives in sandbox-session-death.ts so the readiness
// gate and the sandbox DOs key off the SAME predicate this recovery path uses
// (see that module's header). Re-exported here for the existing importers.
export {
  isSandboxSessionDeathError,
  isSandboxSessionDeathResult,
  sandboxSessionExitCode,
} from "./sandbox-session-death.js";

/**
 * User-facing replacement for the raw SDK error. Same tone as the other
 * environment-level messages the agent relays: say what happened, say what to
 * do, never name an SDK class.
 */
export const ANALYSIS_SESSION_RESTARTED_MESSAGE =
  "The analysis environment restarted while running this command, so it did not complete. " +
  "Try again — if it keeps happening, run a smaller step (less data in memory at once).";

/**
 * Told to the agent when recovery DID re-run something. Silence here is how a
 * double-applied command becomes invisible: an agent that just re-ran a
 * migration needs to be able to say so.
 */
export const ANALYSIS_SESSION_RECOVERED_MESSAGE =
  "The analysis environment restarted before this command ran; it was started again on a fresh session.";

/** Stamp a successful recovery onto an object result (never onto a scalar). */
function annotateSessionRecovered<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    ...(value as object),
    sessionRecovered: true,
    sessionRecoveredNote: ANALYSIS_SESSION_RECOVERED_MESSAGE,
  } as T;
}

// ---------------------------------------------------------------------------
// WorkerEntrypoint
// ---------------------------------------------------------------------------

interface AnalysisEnv extends ObservabilityEnv {
  ANALYSIS_SANDBOX?: unknown;
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
  R2_BUCKET?: R2Bucket;
  /** Same bucket as R2_BUCKET; separate binding so /outputs can mount alongside /uploads. */
  R2_OUTPUTS_BUCKET?: R2Bucket;
  WORKSPACE_FS?: DurableObjectNamespace<
    import("./workspace-filesystem-do.js").WorkspaceFilesystemDO
  >;
}

interface AnalysisServiceProps {
  workspaceId: string;
  orgId: string;
}

export class AnalysisService extends WorkerEntrypoint<
  AnalysisEnv,
  AnalysisServiceProps
> {
  private readonly sandboxes = new Map<string, AnalysisSandboxStub>();
  private executionQueues?: Record<
    "agent" | "app",
    AnalysisExecutionQueueState
  >;

  /** Test seam (agent-scoped container). */
  setSandbox(sandbox: AnalysisSandboxStub): void {
    this.sandboxes.set("agent", sandbox);
  }

  private executionQueue(scope: "agent" | "app"): AnalysisExecutionQueueState {
    const queues = (this.executionQueues ??= {
      agent: { active: false, waiters: [] },
      app: { active: false, waiters: [] },
    });
    return queues[scope];
  }

  private executionQueueRelease(scope: "agent" | "app"): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const queue = this.executionQueue(scope);
      for (;;) {
        const waiter = queue.waiters.shift();
        if (!waiter) {
          queue.active = false;
          return;
        }
        if (waiter.settled) continue;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(this.executionQueueRelease(scope));
        return;
      }
    };
  }

  private async enterExecutionQueue(
    operation: string,
    scope: "agent" | "app",
    queueDeadlineAt: number,
  ): Promise<() => void> {
    const queue = this.executionQueue(scope);
    if (!queue.active) {
      queue.active = true;
      return this.executionQueueRelease(scope);
    }
    const remainingMs = Math.max(0, Math.floor(queueDeadlineAt - Date.now()));
    if (
      remainingMs < 1 ||
      queue.waiters.length >= ANALYSIS_EXECUTION_QUEUE_MAX_WAITERS
    ) {
      throw new AnalysisExecutionBusyError(
        operation,
        scope,
        Math.max(1, remainingMs),
        "busy",
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: AnalysisExecutionQueueWaiter = {
        settled: false,
        resolve,
        reject,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = queue.waiters.indexOf(waiter);
        if (index >= 0) queue.waiters.splice(index, 1);
        reject(
          new AnalysisExecutionBusyError(
            operation,
            scope,
            ANALYSIS_EXECUTION_QUEUE_POLL_MS,
            "busy",
          ),
        );
      }, remainingMs);
      queue.waiters.push(waiter);
    });
  }

  /**
   * One active operation plus two bounded waiters per workspace-scoped service.
   * Waiters retain only already-admission-bounded request state and never begin
   * file listing, materialization, or output capture before they own the slot.
   * The durable sandbox lease remains the cross-instance authority; its ordinary
   * busy result is polled only inside the same absolute queue deadline.
   * Agent and deployed-app containers have intentionally separate security
   * scopes, so each independently enforces one active operation plus its own
   * bounded waiter lane.
   */
  private async withExecutionAdmission<T>(
    operation: string,
    scope: "agent" | "app",
    budgetMs: number,
    run: (budget: AnalysisOperationBudget) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    const boundedBudgetMs = Math.max(
      ANALYSIS_OPERATION_FINALIZE_TIMEOUT_MS + 1,
      Math.min(ANALYSIS_EXECUTION_LEASE_MS, Math.floor(budgetMs)),
    );
    const lifecycleDeadlineAt = startedAt + boundedBudgetMs;
    const queueDeadlineAt = Math.min(
      lifecycleDeadlineAt - ANALYSIS_OPERATION_FINALIZE_TIMEOUT_MS,
      startedAt + ANALYSIS_EXECUTION_QUEUE_WAIT_MS,
    );
    const releaseQueueSlot = await this.enterExecutionQueue(
      operation,
      scope,
      queueDeadlineAt,
    );
    try {
      const sandbox = await this.resolveSandbox(scope);
      const token = crypto.randomUUID();
      const admission = await acquireAnalysisExecutionLeaseWithBoundedWait(
        sandbox,
        { token, operation },
        queueDeadlineAt,
      );
      if (!admission.acquired) {
        throw new AnalysisExecutionBusyError(
          operation,
          scope,
          admission.retryAfterMs,
          admission.reason,
        );
      }

      const deadlineAt = Math.min(admission.deadlineAt, lifecycleDeadlineAt);
      const controller = new AbortController();
      const budget: AnalysisOperationBudget = {
        operation,
        ownerToken: token,
        budgetMs: Math.max(1, deadlineAt - startedAt),
        deadlineAt,
        workDeadlineAt: Math.max(
          startedAt,
          deadlineAt - ANALYSIS_OPERATION_FINALIZE_TIMEOUT_MS,
        ),
        signal: controller.signal,
        pending: new Set(),
        archives: new Map(),
        abort(reason) {
          if (!controller.signal.aborted) controller.abort(reason);
        },
      };

      const release = async () => {
        const remaining = Math.floor(budget.deadlineAt - Date.now());
        if (remaining <= 0) {
          console.warn(
            "[AnalysisService] analysis execution lease retained at lifecycle deadline",
            { operation, scope, workspaceId: this.ctx.props.workspaceId },
          );
          return;
        }
        try {
          const released = await withAnalysisAdmissionRpcDeadline(
            sandbox.releaseExecutionLease(token),
            "release",
            remaining,
          );
          if (!released) {
            console.warn(
              "[AnalysisService] analysis execution lease release was fenced",
              { operation, scope, workspaceId: this.ctx.props.workspaceId },
            );
          }
        } catch (error) {
          // The durable absolute expiry remains fail-closed if the transport dies.
          console.warn(
            "[AnalysisService] analysis execution lease release was unconfirmed",
            {
              operation,
              scope,
              workspaceId: this.ctx.props.workspaceId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      };

      let releaseNow = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let removeAbortListener = () => {};
      try {
        assertAnalysisOperationActive(budget);
        let settled = false;
        const operationOutcome = Promise.resolve()
          .then(async () => {
            try {
              const value = await run(budget);
              await settleAnalysisArchives(sandbox, budget, "acknowledge");
              return value;
            } catch (error) {
              if (budget.archives.size > 0 && !budget.signal.aborted) {
                try {
                  await settleAnalysisArchives(sandbox, budget, "discard");
                } catch (cleanupError) {
                  throw new Error(
                    "Analysis failed and its output archive cleanup was unconfirmed",
                    { cause: cleanupError },
                  );
                }
              }
              throw error;
            }
          })
          .then(
            (value) => {
              settled = true;
              return { kind: "value" as const, value };
            },
            (error) => {
              settled = true;
              return { kind: "error" as const, error };
            },
          );
        const aborted = new Promise<{ kind: "aborted" }>((resolve) => {
          const onAbort = () => resolve({ kind: "aborted" });
          controller.signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () =>
            controller.signal.removeEventListener("abort", onAbort);
        });
        timer = setTimeout(
          () => {
            budget.abort(analysisOperationDeadlineError(budget));
          },
          Math.max(0, budget.workDeadlineAt - Date.now()),
        );

        const outcome = await Promise.race([operationOutcome, aborted]);
        if (outcome.kind === "value" && !budget.signal.aborted) {
          return outcome.value;
        }
        if (outcome.kind === "error" && !budget.signal.aborted) {
          throw outcome.error;
        }

        const deadlineError = analysisOperationDeadlineError(
          budget,
          budget.signal.reason,
        );
        budget.abort(deadlineError);
        if (budget.archives.size > 0) {
          try {
            await discardAnalysisArchivesAfterAbort(sandbox, budget);
          } catch {
            // Retain both archive marker and durable lease. Stale-owner recovery
            // must reset then delete the exact R2 key before another admission.
            releaseNow = false;
          }
        }
        try {
          await resetAnalysisContainer(sandbox, deadlineError, budget);
        } catch (resetError) {
          // Cancellation is unconfirmed: retain the durable lease. Its stale-owner
          // path requires another confirmed reset before any later admission.
          releaseNow = false;
          throw analysisOperationDeadlineError(budget, resetError);
        }

        const drains = [
          ...(!settled ? [operationOutcome] : []),
          ...budget.pending,
        ];
        if (drains.length > 0) {
          // Do not permit overlap with an abandoned continuation. The durable
          // lease remains owned until every locally-visible remote mutation
          // reaches a terminal outcome; if one never does, lease expiry still
          // requires destructive stale-owner recovery.
          releaseNow = false;
          void Promise.allSettled(drains)
            .then(release)
            .catch(() => undefined);
        }
        throw deadlineError;
      } finally {
        if (timer) clearTimeout(timer);
        removeAbortListener();
        if (releaseNow) await release();
      }
    } finally {
      releaseQueueSlot();
    }
  }

  async runNotebook(request: {
    projectId: string;
    path: string;
    timeoutMs?: number;
    outputCaptureBytes?: number;
  }): Promise<AnalysisNotebookResult> {
    const startedAt = Date.now();
    const validatedPath = validateAnalysisNotebookPath(request.path);
    if (!validatedPath.ok) {
      return emptyNotebookResult(startedAt, validatedPath.error);
    }
    // Authorize the project before revealing workspace execution-busy state.
    // This is a scalar registry lookup, not source materialization.
    const files = await this.projectFiles(request.projectId);
    const commandTimeoutMs = clampTimeout(
      request.timeoutMs,
      DEFAULT_NOTEBOOK_TIMEOUT_MS,
      MAX_NOTEBOOK_TIMEOUT_MS,
    );
    return this.withExecutionAdmission(
      "run_notebook",
      "agent",
      analysisOperationBudgetMs(
        commandTimeoutMs,
        ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS,
      ),
      async (budget) => {
        return this.withSessionRecovery(
          "run_notebook",
          async (sandbox, dispatch) => {
            const outputsMounted = await this.prepareWorkspaceAccess(
              sandbox,
              budget,
            );
            return runAnalysisNotebook(
              { path: request.path, timeoutMs: request.timeoutMs },
              {
                sandbox,
                files,
                projectId: request.projectId,
                newRunId: () => crypto.randomUUID(),
                outputCaptureBytes: outputsMounted
                  ? clampAnalysisOutputCaptureBytes(request.outputCaptureBytes)
                  : 0,
                outputObjectPrefix: outputsMounted
                  ? `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-outputs`
                  : undefined,
                dispatch,
                budget,
              },
              validatedPath.value,
            );
          },
          "agent",
          {},
          budget,
        );
      },
    );
  }

  async exec(request: {
    projectId?: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    outputCaptureBytes?: number;
  }): Promise<AnalysisExecResult> {
    const startedAt = Date.now();
    const validatedRequest = validateAnalysisExecRequest(request);
    if (!validatedRequest.ok) {
      return emptyExecResult(startedAt, validatedRequest.error);
    }
    const hasProject = Boolean(request.projectId);
    const files = hasProject
      ? await this.projectFiles(request.projectId as string)
      : ({} as WorkspaceFileStoreLike);
    const commandTimeoutMs = clampTimeout(
      request.timeoutMs,
      DEFAULT_EXEC_TIMEOUT_MS,
      MAX_NOTEBOOK_TIMEOUT_MS,
    );
    return this.withExecutionAdmission(
      "exec",
      "agent",
      analysisOperationBudgetMs(commandTimeoutMs),
      async (budget) => {
        return this.withSessionRecovery(
          "exec",
          async (sandbox, dispatch) => {
            const outputsMounted = await this.prepareWorkspaceAccess(
              sandbox,
              budget,
            );
            return runAnalysisExec(
              {
                command: request.command,
                cwd: request.cwd,
                env: request.env,
                timeoutMs: request.timeoutMs,
              },
              {
                sandbox,
                files,
                dispatch,
                projectId: request.projectId ?? "scratch",
                newRunId: () => crypto.randomUUID(),
                hasProject,
                scratchId: crypto.randomUUID(),
                outputCaptureBytes: outputsMounted
                  ? clampAnalysisOutputCaptureBytes(request.outputCaptureBytes)
                  : 0,
                outputObjectPrefix: outputsMounted
                  ? `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-outputs`
                  : undefined,
                budget,
              },
              validatedRequest.value,
            );
          },
          "agent",
          {},
          budget,
        );
      },
    );
  }

  async addDependency(request: {
    projectId: string;
    packages: string[];
    dev?: boolean;
  }): Promise<AnalysisDependencyResult> {
    if (request.dev !== undefined && typeof request.dev !== "boolean") {
      throw new Error("dev must be a boolean");
    }
    const packages = normalizeDependencySpecs(request.packages);
    const files = await this.projectFiles(request.projectId);
    return this.withExecutionAdmission(
      "add_dependency",
      "agent",
      analysisOperationBudgetMs(DEFAULT_DEP_TIMEOUT_MS),
      async (budget) => {
        // `uv add` is idempotent (re-adding a pinned package converges on the same
        // pyproject/uv.lock), so this one operation may retry after dispatch.
        return this.withSessionRecovery(
          "add_dependency",
          (sandbox, dispatch) =>
            runAnalysisAddDependency(
              { packages, dev: request.dev },
              {
                sandbox,
                files,
                projectId: request.projectId,
                newRunId: () => crypto.randomUUID(),
                dispatch,
                budget,
              },
              packages,
            ),
          "agent",
          { retryAfterDispatch: true },
          budget,
        );
      },
    );
  }

  async runCode(request: {
    code: string;
    params?: Record<string, unknown>;
    outputCaptureBytes?: number;
  }): Promise<AnalysisRunCodeResult> {
    const validation = validateAnalysisCodeRequest(request);
    if (!validation.ok) {
      return { ok: false, error: validation.error, outputTruncated: false };
    }
    return this.withExecutionAdmission(
      "run_code",
      "agent",
      analysisOperationBudgetMs(DEFAULT_EXEC_TIMEOUT_MS),
      (budget) =>
        this.withSessionRecovery(
          "run_code",
          async (sandbox, dispatch) => {
            const outputsMounted = await this.prepareWorkspaceAccess(
              sandbox,
              budget,
            );
            return runAnalysisCode(
              request,
              {
                sandbox,
                scratchId: crypto.randomUUID(),
                outputCaptureBytes: outputsMounted
                  ? clampAnalysisOutputCaptureBytes(request.outputCaptureBytes)
                  : 0,
                outputObjectPrefix: outputsMounted
                  ? `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-outputs`
                  : undefined,
                dispatch,
                budget,
              },
              validation.value,
            );
          },
          "agent",
          {},
          budget,
        ),
    );
  }

  /**
   * App-scoped runCode — the ONLY compute deployed apps get (via
   * AnalysisAppService / the legacy WarehouseService shim). Runs in a SEPARATE
   * warm container from the agent's (`app-<workspaceId>`): mounts and the
   * connections interception are container-level state, so sharing the agent's
   * container would leak the uploads mount and connections.internal access that
   * agent runs legitimately establish there. The app container only ever gets
   * the export-prefix mount — the pre-merge warehouse contract — and no
   * CAMELAI_CONNECTIONS_RPC_URL is injected (the interception is never
   * registered on this container, so the host is unreachable regardless).
   */
  async runCodeForApps(request: {
    code: string;
    params?: Record<string, unknown>;
  }): Promise<AnalysisRunCodeResult> {
    const validation = validateAnalysisCodeRequest(request);
    if (!validation.ok) {
      return { ok: false, error: validation.error, outputTruncated: false };
    }
    return this.withExecutionAdmission(
      "run_code_for_apps",
      "app",
      analysisOperationBudgetMs(DEFAULT_EXEC_TIMEOUT_MS),
      (budget) =>
        this.withSessionRecovery(
          "run_code_for_apps",
          async (sandbox, dispatch) => {
            // Seal egress before every app run: app code has no PyPI use case, so the
            // class-level allowlist would only be an exfiltration channel for mounted
            // export data (the override is in-memory DO state, hence per-run). The
            // seal is re-applied on a recovery retry because a restarted container
            // starts from the class-level allowlist again.
            await awaitAnalysisOperation(sandbox.sealAppEgress(), budget);
            if (this.env.WAREHOUSE_EXPORT_BUCKET) {
              await awaitAnalysisOperation(
                sandbox.ensureMounted(
                  ANALYSIS_EXPORT_BUCKET_BINDING,
                  warehouseWorkspacePrefix(this.ctx.props.workspaceId),
                ),
                budget,
              );
            }
            return runAnalysisCode(
              request,
              {
                sandbox,
                scratchId: crypto.randomUUID(),
                connections: false,
                dispatch,
                budget,
              },
              validation.value,
            );
          },
          "app",
          {},
          budget,
        ),
    );
  }

  async listConnections(): Promise<WarehouseConnection[]> {
    const summaries = await listConnections(
      this.env as unknown as ConnectionsRuntimeEnv,
      {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    );
    return annotateWarehouseConnections(summaries);
  }

  /**
   * Run one analysis operation, surviving a single death of the container's
   * persistent shell.
   *
   * A container OOM or restart takes the session down mid-command; the SDK
   * caches the default session id in DO memory and storage and only clears it
   * when the CONTAINER stops (`onStop`), so nothing in the app noticed and the
   * raw `SessionTerminatedError` reached the user.
   *
   * At most ONE retry, and ONLY when the death happened BEFORE the agent's own
   * command was dispatched (`dispatch.started` is still false — a stale session
   * faulting on ensureMounted/mkdir/materialize). That is the case a retry
   * actually fixes. Once the command has been handed to the container it may
   * have run fully or partly, and its external effects (warehouse/DB writes,
   * /outputs writes, outbound calls) outlive the shell — so a death from there
   * on is reported, never re-executed. Operations whose command is genuinely
   * idempotent opt in with `retryAfterDispatch`.
   *
   * A retry is never silent: the recovered value carries `sessionRecovered`
   * plus a one-line note, so an agent can say the environment restarted instead
   * of the double-run being visible only in AE.
   *
   * The failure SHAPE is preserved: an operation that reports failures as a
   * `{ ok: false, error }` value (runCode, whose callers include deployed apps
   * through AnalysisAppService) keeps getting a value, with the raw SDK text
   * swapped for the user-facing message; one that throws keeps throwing.
   *
   * The retry inherits this service's absolute lifecycle budget. Preparation,
   * both attempts, persistence, cleanup, and confirmed destructive recovery all
   * share one deadline; the caller-side grace remains only a transport backstop.
   */
  private async withSessionRecovery<T>(
    operation: string,
    run: (
      sandbox: AnalysisSandboxStub,
      dispatch: AnalysisCommandDispatch,
    ) => Promise<T>,
    scope: "agent" | "app" = "agent",
    options: { retryAfterDispatch?: boolean } = {},
    budget?: AnalysisOperationBudget,
  ): Promise<T> {
    const attempt = async (): Promise<
      | { kind: "value"; value: T }
      | { kind: "death"; error: Error; result: T | null; retryable: boolean }
    > => {
      const dispatch: AnalysisCommandDispatch = { started: false };
      // Safe to retry only while the command has not left us — unless the
      // caller declared this operation idempotent.
      const retryable = () =>
        options.retryAfterDispatch === true || !dispatch.started;
      try {
        assertAnalysisOperationActive(budget);
        const value = await run(await this.resolveSandbox(scope), dispatch);
        assertAnalysisOperationActive(budget);
        if (!isSandboxSessionDeathResult(value))
          return { kind: "value", value };
        return {
          kind: "death",
          error: new Error(String((value as { error?: unknown }).error)),
          result: value,
          retryable: retryable(),
        };
      } catch (error) {
        if (!isSandboxSessionDeathError(error)) throw error;
        return {
          kind: "death",
          error: error instanceof Error ? error : new Error(String(error)),
          result: null,
          retryable: retryable(),
        };
      }
    };

    const first = await attempt();
    if (first.kind === "value") return first.value;
    if (!first.retryable) {
      // The command already ran (or partly ran). Report it; re-running would
      // double-apply work whose side effects survived the dead shell.
      this.recordSessionTerminated(operation, first.error, false);
      return this.sessionDeathOutcome(first.result, first.error);
    }
    this.recordSessionTerminated(operation, first.error, true);
    assertAnalysisOperationActive(budget);
    await this.recreateSandboxSession(scope, budget);
    assertAnalysisOperationActive(budget);

    const retry = await attempt();
    if (retry.kind === "value") return annotateSessionRecovered(retry.value);
    this.recordSessionTerminated(operation, retry.error, false);
    return this.sessionDeathOutcome(retry.result, retry.error);
  }

  /** Same failure shape the operation uses, with the SDK text swapped out. */
  private sessionDeathOutcome<T>(result: T | null, error: Error): T {
    if (result !== null) {
      const { sessionDeath: _dropped, ...rest } = result as T & {
        sessionDeath?: true;
      };
      return { ...(rest as T), error: ANALYSIS_SESSION_RESTARTED_MESSAGE };
    }
    throw new Error(ANALYSIS_SESSION_RESTARTED_MESSAGE, { cause: error });
  }

  /**
   * Best-effort session recreation between the two attempts. `resetSession`
   * makes the SDK re-run its create-session handshake instead of reusing the id
   * of a session the container already reaped; if the method is missing or
   * fails, the retry still works — the SDK recreates a terminated session
   * transparently on the next call — so this never fails the operation.
   */
  private async recreateSandboxSession(
    scope: "agent" | "app",
    budget?: AnalysisOperationBudget,
  ): Promise<void> {
    try {
      const sandbox = await this.resolveSandbox(scope);
      if (sandbox.resetSession) {
        await awaitAnalysisOperation(sandbox.resetSession(), budget);
      }
    } catch (error) {
      assertAnalysisOperationActive(budget);
      console.warn(
        "[AnalysisService] failed to reset the sandbox session",
        error,
      );
    }
  }

  private recordSessionTerminated(
    operation: string,
    error: unknown,
    retried: boolean,
  ): void {
    console.warn("[AnalysisService] analysis session died under a command", {
      operation,
      retried,
      workspaceId: this.ctx?.props?.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    recordObservabilityEvent(this.env, {
      event: "sandbox_session_terminated",
      severity: retried ? "warn" : "error",
      component: "AnalysisService",
      operation,
      status: retried ? "retried" : "failed",
      count: sandboxSessionExitCode(error) ?? undefined,
      errorName: error instanceof Error ? error.name : "Error",
      errorMessage: error instanceof Error ? error.message : String(error),
      workspaceId: this.ctx?.props?.workspaceId,
      orgId: this.ctx?.props?.orgId,
    });
  }

  /**
   * Prepare the container's workspace-scoped data access before a run:
   * read-only R2 mounts (exports + uploads) and the connections.internal
   * interception with this workspace/org scope attached DO-side. All three are
   * idempotent-cheap on a warm container.
   */
  private async prepareWorkspaceAccess(
    sandbox: AnalysisSandboxStub,
    budget?: AnalysisOperationBudget,
  ): Promise<boolean> {
    let outputsMounted = false;
    if (this.env.WAREHOUSE_EXPORT_BUCKET) {
      await awaitAnalysisOperation(
        sandbox.ensureMounted(
          ANALYSIS_EXPORT_BUCKET_BINDING,
          warehouseWorkspacePrefix(this.ctx.props.workspaceId),
        ),
        budget,
      );
    }
    if (this.env.R2_BUCKET && this.ctx.props.orgId) {
      // Mounted at the stable /uploads alias — the agent's `uploads/<name>`
      // reference with a leading slash — because the raw org/workspace R2
      // prefix is neither shown to the agent nor derivable in the container.
      const uploadsPrefix = `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-uploads`;
      if (
        await awaitAnalysisOperation(
          r2PrefixHasObjects(this.env.R2_BUCKET, uploadsPrefix),
          budget,
        )
      ) {
        await awaitAnalysisOperation(
          sandbox.ensureMounted(
            ANALYSIS_UPLOADS_BUCKET_BINDING,
            uploadsPrefix,
            ANALYSIS_UPLOADS_MOUNT_PATH,
          ),
          budget,
        );
      }
      // Writable, and deliberately NOT gated on the prefix already having
      // objects the way uploads is: outputs starts empty by definition, and the
      // whole point is to let a run create the first file in it.
      //
      // A failure here is logged rather than thrown. Losing the outputs mount
      // costs the run its delivery path, but throwing would take down notebook
      // and code execution entirely — a much larger regression than the one
      // this mount exists to fix.
      const outputsPrefix = `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-outputs`;
      if (this.env.R2_OUTPUTS_BUCKET) {
        try {
          await awaitAnalysisOperation(
            sandbox.ensureMounted(
              ANALYSIS_OUTPUTS_BUCKET_BINDING,
              outputsPrefix,
              ANALYSIS_OUTPUTS_MOUNT_PATH,
              { readOnly: false },
            ),
            budget,
          );
          outputsMounted = true;
        } catch (error) {
          assertAnalysisOperationActive(budget);
          console.error("[AnalysisService] outputs mount failed", error);
        }
      } else {
        console.error(
          "[AnalysisService] R2_OUTPUTS_BUCKET binding is not configured; generated files cannot be delivered through /outputs",
        );
      }
    }
    if (this.ctx.props.orgId && this.ctx.props.workspaceId) {
      await awaitAnalysisOperation(
        sandbox.ensureConnectionsRpc({
          orgId: this.ctx.props.orgId,
          workspaceId: this.ctx.props.workspaceId,
        }),
        budget,
      );
    }
    return outputsMounted;
  }

  /**
   * Resolve a project's file store ONLY after proving the project belongs to
   * this service's bound workspace. Callers of the virtualized binding (and, in
   * principle, any future caller) control `projectId`, and global project ids
   * are guessable/shareable strings — without this check a caller could read or
   * write another workspace's project through this service. The workspace's own
   * project registry is the authority (same check the connections RPC route
   * uses); fail closed on any miss.
   */
  private async projectFiles(
    projectId: string,
  ): Promise<WorkspaceFileStoreLike> {
    if (!this.ctx.props.workspaceId)
      throw new Error("Analysis service requires workspace scope");
    if (!this.env.WORKSPACE_FS)
      throw new Error("WORKSPACE_FS binding is not configured");
    const registry = this.env.WORKSPACE_FS.get(
      this.env.WORKSPACE_FS.idFromName(this.ctx.props.workspaceId),
    );
    // This authorization lookup intentionally precedes execution admission so
    // guessed cross-workspace ids cannot probe busy state. It has its own small
    // RPC bound and performs no source listing/materialization or mutation.
    const project = await withAnalysisAdmissionRpcDeadline(
      registry.getProject(projectId),
      "authorization",
    );
    if (!project) {
      throw new Error(`Project ${projectId} not found in this workspace`);
    }
    return new ProjectFilesystemClient(this.env as never, projectId);
  }

  /**
   * Resolve the workspace's warm container. `scope: "agent"` (default) is the
   * full-capability container the chat agent's runs use; `scope: "app"` is a
   * separate container for deployed-app runCode, so app code never shares the
   * container-level mounts/interception the agent's runs establish.
   */
  private async resolveSandbox(
    scope: "agent" | "app" = "agent",
  ): Promise<AnalysisSandboxStub> {
    const cached = this.sandboxes.get(scope);
    if (cached) return cached;
    if (!this.env.ANALYSIS_SANDBOX)
      throw new Error("ANALYSIS_SANDBOX container binding is not configured");
    const { getSandbox } = await import("@cloudflare/sandbox");
    // One warm container per workspace and scope; per-call isolation is via
    // working dirs.
    const sandboxId =
      scope === "app"
        ? `app-${this.ctx.props.workspaceId}`
        : this.ctx.props.workspaceId;
    const sandbox = getSandbox(
      this.env.ANALYSIS_SANDBOX as Parameters<typeof getSandbox>[0],
      sandboxId,
      { normalizeId: true, transport: "rpc" },
    ) as unknown as AnalysisSandboxStub;
    this.sandboxes.set(scope, sandbox);
    return sandbox;
  }
}

/**
 * The deployed-app entrypoint for the virtualized ANALYSIS binding — the
 * code-string + export-mounts capability ONLY. A deployed app has no project
 * working tree and must not reach the project filesystem, notebooks, shell,
 * uploads, or the connections RPC, so this class exposes exactly `runCode` +
 * `listConnections` and delegates to AnalysisService.runCodeForApps, which runs
 * in a separate app-scoped container with only the export-prefix mount (the
 * full AnalysisService stays reachable only via ctx.exports with
 * platform-attached props — never bindable by user workers).
 */
export class AnalysisAppService extends WorkerEntrypoint<
  AnalysisEnv,
  AnalysisServiceProps
> {
  async runCode(request: {
    code: string;
    params?: Record<string, unknown>;
  }): Promise<AnalysisRunCodeResult> {
    return this.full().runCodeForApps(request);
  }

  async listConnections(): Promise<WarehouseConnection[]> {
    // Honor CONNECTIONS_BINDING_ENABLED so deployed apps cannot read the
    // connection catalog through ANALYSIS when the CONNECTIONS broker is off.
    assertConnectionsBindingEnabled(
      this.env as { CONNECTIONS_BINDING_ENABLED?: string },
    );
    return this.full().listConnections();
  }

  private full(): Pick<AnalysisService, "runCodeForApps" | "listConnections"> {
    return (
      this.ctx.exports as unknown as {
        AnalysisService: (options: {
          props: AnalysisServiceProps;
        }) => AnalysisService;
      }
    ).AnalysisService({
      props: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    });
  }
}

export const __testing = {
  collectProjectSourceFiles,
  materializeProject,
  persistChangedFiles,
  snapshotProjectManifest,
};
