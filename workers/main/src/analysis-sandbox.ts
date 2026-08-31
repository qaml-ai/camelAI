import {
  InvalidMountConfigError,
  S3FSMountError,
  Sandbox,
  type ExecOptions,
  type ExecResult,
  type ExecutionSession,
  type MountBucketOptions,
} from "@cloudflare/sandbox";

import {
  isSelfhostRuntime,
  type SelfhostRuntimeEnv,
} from "../../../src/lib/selfhost-runtime.js";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds.js";
import { ANALYSIS_SLEEP_AFTER } from "./container-sizing.js";
import { boundedCanonicalJsonResult } from "./chat-thread/bounded-canonical-json.js";
import { utf8ByteLength } from "./chat-thread/utf8-byte-length.js";
import { handleAuthenticatedConnectionsRpc } from "./routes/connections-rpc.js";
import {
  createSandboxZombieHealState,
  createZombieHealTarget,
  healZombieSandboxContainer,
  SandboxSessionDeathTracker,
  SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD,
  withZombieSelfHeal,
  type SandboxZombieRestartOutcome,
  type SandboxZombieRestartRequest,
  type ZombieHealableSandbox,
} from "./sandbox-zombie-recovery.js";
import type { Env } from "./types.js";

/**
 * Both of these mean "the prefix is already mounted" — recoverable presence, not
 * a hard failure — so callers can unmount+remount (see `mountOrRecover`):
 *
 * - `S3FSMountError` whose message looks like a busy/nonempty mountpoint: the
 *   prefix is still mounted at the kernel level from a previous container life
 *   (this DO instance was recreated, losing the SDK's in-memory mount registry,
 *   while the container kept the mount). We match the message so genuine s3fs
 *   failures (auth, network, missing bucket) still surface.
 * - `InvalidMountConfigError` with an "already in use" message: the SDK's own
 *   in-memory registry already holds this path, so it rejects a second mount of
 *   it (e.g. a concurrent `ensureMounted` that mounted it first). We match the
 *   message so genuine config errors — bad bucket name, a different
 *   prefix/readOnly at the same path — still surface as real failures.
 *
 * Any other error (bad binding name, missing binding, invalid path) is genuine.
 */
export function isMountAlreadyPresent(error: unknown): boolean {
  if (
    error instanceof S3FSMountError &&
    /not empty|MOUNTPOINT|busy|already mounted/i.test(
      String(error.message ?? error),
    )
  ) {
    return true;
  }
  if (
    error instanceof InvalidMountConfigError &&
    /already in use/i.test(String(error.message))
  ) {
    return true;
  }
  return false;
}

/** R2-binding options before choosing Cloudflare s3fs or self-host local sync. */
export type R2BindingMountOptions = {
  prefix: string;
  readOnly?: boolean;
  s3fsOptions?: string[];
};

export interface BoundedAnalysisExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  outputTruncated: boolean;
  overflowStored: boolean;
  overflowComplete: boolean;
  overflowBytes: number;
  /** Internal phase-two token; never exposed in the user-facing tool result. */
  overflowTaintToken?: string;
}

/**
 * Cloudflare Containers can mount R2 through credential-less s3fs. Local
 * workerd containers do not receive /dev/fuse and should use the Sandbox SDK's
 * local R2 synchronization mode instead. That mode uses the R2 binding plus
 * container file/watch APIs, so self-host never needs SYS_ADMIN or an
 * unconfined AppArmor profile.
 */
export function sandboxR2MountOptions(
  env: SelfhostRuntimeEnv,
  options: R2BindingMountOptions,
): MountBucketOptions {
  if (isSelfhostRuntime(env)) {
    return {
      localBucket: true,
      prefix: options.prefix,
      readOnly: options.readOnly,
    };
  }
  return options;
}

/** Writable local-sync watches are restricted by the sandbox server to /workspace. */
export function sandboxR2MountPath(
  requestedMountPath: string,
  options: MountBucketOptions,
): string {
  if (
    "localBucket" in options &&
    options.localBucket &&
    options.readOnly === false &&
    requestedMountPath !== "/workspace" &&
    !requestedMountPath.startsWith("/workspace/")
  ) {
    return `/workspace/.camelai-mounts${requestedMountPath}`;
  }
  return requestedMountPath;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const BOUNDED_EXEC_STREAM_SLICE_BYTES = 64 * 1024;
// sandbox 0.12.0 emits one JSON/SSE output event per line and a legitimate
// event can approach 4 MiB. Keep a small envelope for the JSON metadata while
// retaining a finite parser ceiling. The transport may allocate its incoming
// chunk before this parser sees it; everything retained here remains bounded.
const BOUNDED_EXEC_STREAM_EVENT_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const BOUNDED_EXEC_STREAM_EVENT_LINES = 256;
const BOUNDED_EXEC_SESSION_DELETE_MS = 5_000;
const BOUNDED_EXEC_ARCHIVE_WRITE_MS = 10_000;
const BOUNDED_EXEC_ARCHIVE_DELETE_MS = 5_000;
/** One admitted operation per workspace-scoped sandbox, with stale-owner recovery. */
export const ANALYSIS_EXECUTION_LEASE_MS = CHAT_RUNTIME_BOUNDS.toolDeadlineMs;
/** Destructive reset must either finish in this window or remain fail-closed. */
export const ANALYSIS_CONTAINER_RESET_TIMEOUT_MS = 10_000;
const ANALYSIS_EXECUTION_LEASE_KEY = "analysis:execution-lease:v1";
const ANALYSIS_EXECUTION_SESSION_TAINT_KEY =
  "analysis:execution-session-taint:v1";
const ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY =
  "analysis:execution-archive-taint:v1";
const BOUNDED_EXEC_COMMAND_ENV = "CAMELAI_BOUNDED_COMMAND";
const BOUNDED_EXEC_ENVIRONMENT_ENV = "CAMELAI_BOUNDED_ENVIRONMENT";
const BOUNDED_EXEC_CHILD = `import json
import os

command = os.environ.pop(${JSON.stringify(BOUNDED_EXEC_COMMAND_ENV)})
environment = json.loads(os.environ.pop(${JSON.stringify(BOUNDED_EXEC_ENVIRONMENT_ENV)}))
if not isinstance(environment, dict) or not all(
    isinstance(key, str) and isinstance(value, str)
    for key, value in environment.items()
):
    raise ValueError("invalid bounded execution environment")
os.environ.update(environment)
os.execve("/bin/bash", ["bash", "-lc", command], os.environ)`;
const BOUNDED_EXEC_SUPERVISOR = `child=""
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ -n "$child" ] && kill -0 -- "-$child" 2>/dev/null; then
    kill -TERM -- "-$child" 2>/dev/null || true
    /bin/sleep 0.1
    kill -KILL -- "-$child" 2>/dev/null || true
  fi
  exit "$code"
}
trap cleanup EXIT HUP INT TERM
/usr/bin/setsid /usr/bin/python3 -I -S -c ${shellQuote(BOUNDED_EXEC_CHILD)} &
child=$!
wait "$child"`;
const boundedExecEncoder = new TextEncoder();

type BoundedExecEvent = {
  type: "start" | "stdout" | "stderr" | "complete" | "error";
  data?: string;
  exitCode?: number;
  error?: string;
  result?: { exitCode?: number };
};

interface StoredAnalysisExecutionLease {
  token: string;
  operation: string;
  deadlineAt: number;
  state: "active" | "recovering";
}

interface StoredAnalysisExecutionTaint {
  token: string;
  kind: "session" | "archive";
  resource: string;
  createdAt: number;
  /** Service lease that must acknowledge a successful archive handoff. */
  ownerToken?: string;
}

export type AnalysisExecutionLeaseResult =
  | { acquired: true; deadlineAt: number }
  | {
      acquired: false;
      reason: "busy" | "stale_reset_unconfirmed";
      retryAfterMs: number;
    };

function isStoredAnalysisExecutionLease(
  value: unknown,
): value is StoredAnalysisExecutionLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredAnalysisExecutionLease>;
  return (
    typeof record.token === "string" &&
    record.token.length > 0 &&
    record.token.length <= 128 &&
    typeof record.operation === "string" &&
    record.operation.length > 0 &&
    record.operation.length <= 64 &&
    typeof record.deadlineAt === "number" &&
    Number.isFinite(record.deadlineAt) &&
    (record.state === "active" || record.state === "recovering")
  );
}

function isStoredAnalysisExecutionTaint(
  value: unknown,
): value is StoredAnalysisExecutionTaint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredAnalysisExecutionTaint>;
  return (
    typeof record.token === "string" &&
    /^[A-Za-z0-9-]{1,128}$/.test(record.token) &&
    (record.kind === "session" || record.kind === "archive") &&
    typeof record.resource === "string" &&
    record.resource.length > 0 &&
    record.resource.length <= 1_024 &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    (record.ownerToken === undefined ||
      (typeof record.ownerToken === "string" &&
        /^[A-Za-z0-9-]{1,128}$/.test(record.ownerToken)))
  );
}

class BoundedExecSessionCleanupError extends Error {
  override name = "BoundedExecSessionCleanupError";
}

class BoundedByteCapture {
  totalBytes = 0;
  private readonly head: Uint8Array;
  private readonly tail: Uint8Array;
  private headLength = 0;
  private tailLength = 0;
  private tailWrite = 0;

  constructor(headBytes: number, tailBytes: number) {
    this.head = new Uint8Array(headBytes);
    this.tail = new Uint8Array(tailBytes);
  }

  add(value: string): void {
    const bytes = boundedExecEncoder.encode(value);
    if (bytes.byteLength > Number.MAX_SAFE_INTEGER - this.totalBytes) {
      throw new Error("Bounded analysis output byte count overflowed");
    }
    if (this.headLength < this.head.byteLength) {
      const selected = bytes.subarray(
        0,
        Math.min(bytes.byteLength, this.head.byteLength - this.headLength),
      );
      this.head.set(selected, this.headLength);
      this.headLength += selected.byteLength;
    }
    if (this.tail.byteLength > 0) {
      if (bytes.byteLength >= this.tail.byteLength) {
        this.tail.set(bytes.subarray(bytes.byteLength - this.tail.byteLength));
        this.tailLength = this.tail.byteLength;
        this.tailWrite = 0;
      } else {
        const first = Math.min(
          bytes.byteLength,
          this.tail.byteLength - this.tailWrite,
        );
        this.tail.set(bytes.subarray(0, first), this.tailWrite);
        if (first < bytes.byteLength) this.tail.set(bytes.subarray(first), 0);
        this.tailWrite =
          (this.tailWrite + bytes.byteLength) % this.tail.byteLength;
        this.tailLength = Math.min(
          this.tail.byteLength,
          this.tailLength + bytes.byteLength,
        );
      }
    }
    this.totalBytes += bytes.byteLength;
  }

  headBytes(): Uint8Array {
    return this.head.subarray(0, this.headLength);
  }

  tailBytes(): Uint8Array {
    if (this.tailLength < this.tail.byteLength) {
      return this.tail.slice(0, this.tailLength);
    }
    if (this.tailWrite === 0) return this.tail.slice();
    const ordered = new Uint8Array(this.tailLength);
    const first = this.tail.subarray(this.tailWrite);
    ordered.set(first);
    ordered.set(this.tail.subarray(0, this.tailWrite), first.byteLength);
    return ordered;
  }
}

class BoundedExecSseDecoder {
  private line = "";
  private lineBytes = 0;
  private data: string[] = [];
  private dataBytes = 0;

  push(text: string, receive: (event: BoundedExecEvent) => void): void {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const end = newline < 0 ? text.length : newline;
      const segment = text.slice(offset, end);
      const segmentBytes = utf8ByteLength(segment);
      if (segmentBytes > BOUNDED_EXEC_STREAM_EVENT_BYTES - this.lineBytes) {
        throw new Error("Bounded analysis stream frame exceeded its limit");
      }
      this.line += segment;
      this.lineBytes += segmentBytes;
      if (newline < 0) return;
      const line = this.line.replace(/\r$/, "");
      this.line = "";
      this.lineBytes = 0;
      this.acceptLine(line, receive);
      offset = newline + 1;
    }
  }

  finish(receive: (event: BoundedExecEvent) => void): void {
    if (this.line) this.acceptLine(this.line.replace(/\r$/, ""), receive);
    this.line = "";
    this.lineBytes = 0;
    this.acceptLine("", receive);
  }

  private acceptLine(
    line: string,
    receive: (event: BoundedExecEvent) => void,
  ): void {
    if (line !== "") {
      if (!line.startsWith("data:")) return;
      const value = line.slice(5).replace(/^ /, "");
      this.dataBytes += utf8ByteLength(value) + (this.data.length ? 1 : 0);
      if (
        this.dataBytes > BOUNDED_EXEC_STREAM_EVENT_BYTES ||
        this.data.length >= BOUNDED_EXEC_STREAM_EVENT_LINES
      ) {
        throw new Error("Bounded analysis stream frame exceeded its limit");
      }
      this.data.push(value);
      return;
    }
    if (!this.data.length) return;
    const serialized = this.data.join("\n");
    this.data = [];
    this.dataBytes = 0;
    if (!serialized.trim() || serialized === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Bounded analysis stream returned invalid SSE metadata");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Bounded analysis stream returned invalid SSE metadata");
    }
    const event = parsed as Partial<BoundedExecEvent>;
    if (
      !event.type ||
      !["start", "stdout", "stderr", "complete", "error"].includes(event.type)
    ) {
      throw new Error("Bounded analysis stream returned invalid SSE metadata");
    }
    receive(event as BoundedExecEvent);
  }
}

function boundedExecAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Analysis execution was aborted");
}

/** Race an SDK operation whose public signal is only checked before it starts. */
async function withBoundedExecAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw boundedExecAbortReason(signal);
  let rejectAbort: ((reason: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(boundedExecAbortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    rejectAbort = undefined;
  }
}

async function deleteBoundedExecSession(
  target: Pick<AnalysisSandbox, "deleteSession">,
  sessionId: string,
): Promise<boolean> {
  let request: ReturnType<AnalysisSandbox["deleteSession"]>;
  try {
    request = target.deleteSession(sessionId);
  } catch {
    return false;
  }
  let settled = false;
  const deletion = request.then(
    (result) => {
      settled = true;
      return result.success === true;
    },
    () => {
      settled = true;
      return false;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), BOUNDED_EXEC_SESSION_DELETE_MS);
  });
  const deleted = await Promise.race([deletion, deadline]);
  if (timer) clearTimeout(timer);
  // `deletion` already has both resolution handlers, so a late RPC response
  // cannot become an unhandled rejection after the local deadline wins.
  return deleted && settled;
}

async function destroyUncleanExecContainer(
  target: AnalysisSandbox,
): Promise<boolean> {
  const candidate = target as unknown as {
    destroyAndForgetContainerGeneration?: () => Promise<unknown>;
  };
  if (typeof candidate.destroyAndForgetContainerGeneration !== "function")
    return false;
  const destruction = Promise.resolve()
    .then(() => candidate.destroyAndForgetContainerGeneration!())
    .then(
      () => true,
      () => false,
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(
      () => resolve(false),
      ANALYSIS_CONTAINER_RESET_TIMEOUT_MS,
    );
  });
  const destroyed = await Promise.race([destruction, deadline]);
  if (timer) clearTimeout(timer);
  return destroyed;
}

function isTrustedBoundedExecArchiveKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length <= 1_024 &&
    /^[A-Za-z0-9._/-]+\/user-outputs\/tmp\/[A-Za-z0-9._-]+\.log$/.test(
      key,
    ) &&
    !key.includes("..")
  );
}

async function deleteBoundedExecArchiveObject(
  target: AnalysisSandbox,
  key: string,
): Promise<boolean> {
  // Durable recovery must never turn a corrupt/old marker into an arbitrary
  // delete against the shared outputs bucket. Keep this guard at the deletion
  // seam as well as at callers that need a more specific recovery error.
  if (!isTrustedBoundedExecArchiveKey(key)) return false;
  const bucket = (
    target as unknown as { env?: { R2_OUTPUTS_BUCKET?: R2Bucket } }
  ).env?.R2_OUTPUTS_BUCKET;
  if (!bucket) return false;
  let request: Promise<unknown>;
  try {
    request = Promise.resolve(bucket.delete(key));
  } catch {
    return false;
  }
  const deletion = request.then(
    () => true,
    () => false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), BOUNDED_EXEC_ARCHIVE_DELETE_MS);
  });
  const deleted = await Promise.race([deletion, deadline]);
  if (timer) clearTimeout(timer);
  return deleted;
}

interface AnalysisExecutionTaintKv {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}

/** Test fakes omit Durable Object storage; production AnalysisSandbox never does. */
function analysisExecutionTaintKv(
  target: unknown,
): AnalysisExecutionTaintKv | undefined {
  return (
    target as {
      ctx?: { storage?: { kv?: AnalysisExecutionTaintKv } };
    }
  ).ctx?.storage?.kv;
}

function markAnalysisExecutionTaint(
  target: unknown,
  kind: StoredAnalysisExecutionTaint["kind"],
  resource: string,
  ownerToken?: string,
): string {
  const token = crypto.randomUUID();
  const key =
    kind === "session"
      ? ANALYSIS_EXECUTION_SESSION_TAINT_KEY
      : ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY;
  analysisExecutionTaintKv(target)?.put(key, {
    token,
    kind,
    resource,
    createdAt: Date.now(),
    ...(ownerToken ? { ownerToken } : {}),
  } satisfies StoredAnalysisExecutionTaint);
  return token;
}

function clearAnalysisExecutionTaint(
  target: unknown,
  kind: StoredAnalysisExecutionTaint["kind"],
  token: string,
): boolean {
  const kv = analysisExecutionTaintKv(target);
  if (!kv) return true;
  const key =
    kind === "session"
      ? ANALYSIS_EXECUTION_SESSION_TAINT_KEY
      : ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY;
  const current = kv.get<unknown>(key);
  if (
    !isStoredAnalysisExecutionTaint(current) ||
    current.kind !== kind ||
    current.token !== token
  ) {
    return false;
  }
  kv.delete(key);
  return true;
}

function assertAnalysisExecutionOwner(
  target: unknown,
  ownerToken: string | undefined,
): void {
  if (ownerToken === undefined) return;
  const owner = analysisExecutionTaintKv(target)?.get<unknown>(
    ANALYSIS_EXECUTION_LEASE_KEY,
  );
  if (
    !isStoredAnalysisExecutionLease(owner) ||
    owner.state !== "active" ||
    owner.token !== ownerToken
  ) {
    throw new Error("Bounded-exec owner no longer holds the execution lease");
  }
}

/**
 * Resolve a write-ahead taint before another bounded command starts. Session
 * taints require generation reset; archive taints are cleared only after
 * exact-key deletion from the trusted workspace output prefix is confirmed.
 */
async function recoverAnalysisExecutionTaint(
  target: AnalysisSandbox,
): Promise<void> {
  const kv = analysisExecutionTaintKv(target);
  const sessionRaw = kv?.get<unknown>(ANALYSIS_EXECUTION_SESSION_TAINT_KEY);
  if (sessionRaw !== undefined) {
    const reset = await destroyUncleanExecContainer(target);
    if (!reset) {
      throw new BoundedExecSessionCleanupError(
        "A prior bounded-analysis session could not be proven terminated",
      );
    }
    if (
      isStoredAnalysisExecutionTaint(sessionRaw) &&
      sessionRaw.kind === "session"
    ) {
      clearAnalysisExecutionTaint(target, "session", sessionRaw.token);
    } else {
      kv?.delete(ANALYSIS_EXECUTION_SESSION_TAINT_KEY);
    }
  }

  const raw = kv?.get<unknown>(ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY);
  if (raw === undefined) return;
  if (!isStoredAnalysisExecutionTaint(raw) || raw.kind !== "archive") {
    throw new BoundedExecSessionCleanupError(
      "Corrupt bounded-analysis archive cleanup marker could not be recovered",
    );
  }
  const currentOwner = kv?.get<unknown>(ANALYSIS_EXECUTION_LEASE_KEY);
  if (
    raw.ownerToken &&
    isStoredAnalysisExecutionLease(currentOwner) &&
    currentOwner.state === "active" &&
    currentOwner.token === raw.ownerToken
  ) {
    // This operation has not handed the reference back yet. A later bounded
    // command may proceed, but only the owning lease can acknowledge the marker.
    return;
  }
  const reset = await destroyUncleanExecContainer(target);
  if (!reset) {
    throw new BoundedExecSessionCleanupError(
      "A prior bounded-analysis archive writer could not be proven terminated",
    );
  }
  if (!isTrustedBoundedExecArchiveKey(raw.resource)) {
    throw new BoundedExecSessionCleanupError(
      "Invalid bounded-analysis archive cleanup marker",
    );
  }
  const deleted = await deleteBoundedExecArchiveObject(target, raw.resource);
  if (!deleted) {
    throw new BoundedExecSessionCleanupError(
      "A prior bounded-analysis archive could not be removed",
    );
  }
  clearAnalysisExecutionTaint(target, "archive", raw.token);
}

function captureArchive(
  label: string,
  capture: BoundedByteCapture,
): { segments: Uint8Array[]; complete: boolean } {
  const head = capture.headBytes();
  const tail = capture.tailBytes();
  const tailStart = Math.max(0, capture.totalBytes - tail.byteLength);
  const complete = tailStart <= head.byteLength;
  const segments = [
    boundedExecEncoder.encode(
      `=== ${label} (${capture.totalBytes} bytes) ===\n`,
    ),
    head,
  ];
  if (capture.totalBytes > head.byteLength) {
    if (!complete) {
      segments.push(
        boundedExecEncoder.encode(
          `\n[... ${tailStart - head.byteLength} middle bytes omitted ...]\n`,
        ),
        tail,
      );
    } else {
      segments.push(tail.subarray(head.byteLength - tailStart));
    }
  }
  segments.push(boundedExecEncoder.encode("\n"));
  return { segments, complete };
}

function archiveStream(
  segments: readonly Uint8Array[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const segment of segments) controller.enqueue(segment);
      controller.close();
    },
  });
}

async function consumeBoundedExecStream(
  stream: ReadableStream<Uint8Array>,
  stdout: BoundedByteCapture,
  stderr: BoundedByteCapture,
  signal: AbortSignal,
): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const sse = new BoundedExecSseDecoder();
  let exitCode: number | undefined;
  let terminal = false;
  const receive = (event: BoundedExecEvent) => {
    if (terminal)
      throw new Error("Bounded analysis stream emitted data after completion");
    if (event.type === "stdout" || event.type === "stderr") {
      if (typeof event.data !== "string") {
        throw new Error(
          "Bounded analysis stream returned invalid output metadata",
        );
      }
      (event.type === "stdout" ? stdout : stderr).add(event.data);
      return;
    }
    if (event.type === "error") {
      terminal = true;
      throw new Error(
        `Bounded analysis execution failed: ${String(event.error ?? event.data ?? "unknown error").slice(0, 1024)}`,
      );
    }
    if (event.type === "complete") {
      const candidate = event.exitCode ?? event.result?.exitCode;
      if (
        !Number.isSafeInteger(candidate) ||
        candidate! < 0 ||
        candidate! > 255
      ) {
        throw new Error(
          "Bounded analysis stream returned an invalid exit code",
        );
      }
      terminal = true;
      exitCode = candidate;
    }
  };
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  let listeningForAbort = false;
  if (signal.aborted) cancel();
  else {
    signal.addEventListener("abort", cancel, { once: true });
    listeningForAbort = true;
  }
  try {
    for (;;) {
      if (signal.aborted) throw boundedExecAbortReason(signal);
      const chunk = await reader.read();
      if (signal.aborted) throw boundedExecAbortReason(signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new Error("Bounded analysis stream returned invalid bytes");
      }
      for (
        let offset = 0;
        offset < chunk.value.byteLength;
        offset += BOUNDED_EXEC_STREAM_SLICE_BYTES
      ) {
        const slice = chunk.value.subarray(
          offset,
          offset + BOUNDED_EXEC_STREAM_SLICE_BYTES,
        );
        sse.push(decoder.decode(slice, { stream: true }), receive);
        if (terminal) break;
      }
      if (terminal) {
        // Some transports do not settle their underlying cancel promise. The
        // command is terminal already, so initiate cancellation without making
        // successful completion depend on that transport acknowledgement.
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!terminal) {
      sse.push(decoder.decode(), receive);
      sse.finish(receive);
    }
    if (signal.aborted) throw boundedExecAbortReason(signal);
    if (exitCode === undefined) {
      throw new Error(
        "Bounded analysis stream ended without a completion event",
      );
    }
    return exitCode;
  } finally {
    if (listeningForAbort) signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function ensureLocalMountAlias(
  target: Pick<MountRecoverTarget, "exec">,
  requestedMountPath: string,
  actualMountPath: string,
): Promise<void> {
  if (requestedMountPath === actualMountPath) return;
  const parent =
    requestedMountPath.slice(0, requestedMountPath.lastIndexOf("/")) || "/";
  const result = await target.exec(
    `mkdir -p ${shellQuote(parent)} && rm -rf ${shellQuote(requestedMountPath)} && ` +
      `ln -s ${shellQuote(actualMountPath)} ${shellQuote(requestedMountPath)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to expose local R2 mount at ${requestedMountPath}: ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Minimal surface `mountOrRecover` needs from a Sandbox. Kept narrow so the
 * recovery path is unit-testable without spinning a container.
 */
export interface MountRecoverTarget {
  mountBucket(
    bucket: string,
    mountPath: string,
    options: MountBucketOptions,
  ): Promise<void>;
  unmountBucket(mountPath: string): Promise<void>;
  exec(
    command: string,
    options?: { timeout?: number },
  ): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
}

export class UnreadableR2MountError extends Error {
  constructor(mountPath: string) {
    super(
      `R2 mount at ${mountPath} appears present but is not readable (I/O error). ` +
        `Recreate the analysis sandbox container to recover.`,
    );
    this.name = "UnreadableR2MountError";
  }
}

interface WritableLocalMountTarget {
  writeFile(path: string, content: string): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
}

interface LocalMountBucket {
  head(key: string): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
}

const LOCAL_MOUNT_READY_DELAYS_MS = [50, 100, 200, 400, 800, 1_200] as const;

/**
 * `localBucket` starts its writable container watcher asynchronously after the
 * initial R2 -> container sync. Prove that watcher is accepting events before
 * returning a writable mount, otherwise the first generated output/export can
 * be written during the startup gap and never reach R2.
 */
export async function waitForWritableLocalMount(
  target: WritableLocalMountTarget,
  bucket: LocalMountBucket,
  mountPath: string,
  prefix: string,
  delaysMs: readonly number[] = LOCAL_MOUNT_READY_DELAYS_MS,
): Promise<void> {
  const sentinelName = `.camelai-mount-ready-${crypto.randomUUID()}`;
  const sentinelPath = `${mountPath.replace(/\/$/, "")}/${sentinelName}`;
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const sentinelKey = normalizedPrefix
    ? `${normalizedPrefix}/${sentinelName}`
    : sentinelName;

  try {
    for (let attempt = 0; ; attempt += 1) {
      // Rewriting creates a fresh modify event if the initial create happened
      // just before the SDK's inotify stream became ready.
      await target.writeFile(sentinelPath, `ready-${attempt}`);
      if (await bucket.head(sentinelKey)) return;
      const delayMs = delaysMs[attempt];
      if (delayMs == null) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(
      `Writable local R2 synchronization did not start for ${mountPath}; ` +
        "sandbox output would not persist",
    );
  } finally {
    await target.deleteFile(sentinelPath).catch(() => undefined);
    await bucket.delete(sentinelKey).catch(() => undefined);
  }
}

/**
 * Mount an R2 prefix, recovering from the warm-container remount hazard:
 *
 * When a Sandbox DO is recreated, the SDK loses its in-memory mount registry
 * and `r2.internal` interception, but the container can keep the old FUSE
 * mounts. A naive remount then fails with "MOUNTPOINT … is not empty". The SDK
 * cleans up the failed attempt by calling `configureR2EgressOutbound` with the
 * *remaining* (often empty) bucket set — which **removes** `r2.internal` —
 * while the zombie FUSE mounts stay. Every subsequent read returns Errno 5.
 *
 * Swallowing that error (the old behaviour) left the workspace permanently
 * wedged until the container was destroyed. Instead: unmount, remount (so
 * egress is re-registered), and if the mount still only "looks" present, probe
 * a directory listing and fail loudly when I/O is dead.
 */
export async function mountOrRecover(
  target: MountRecoverTarget,
  bucket: string,
  mountPath: string,
  options: MountBucketOptions,
): Promise<void> {
  try {
    await target.mountBucket(bucket, mountPath, options);
    return;
  } catch (error) {
    if (!isMountAlreadyPresent(error)) throw error;
  }

  try {
    await target.unmountBucket(mountPath);
  } catch (error) {
    console.warn(`[sandbox] unmount ${mountPath} before remount failed`, error);
  }

  try {
    await target.mountBucket(bucket, mountPath, options);
    return;
  } catch (error) {
    if (!isMountAlreadyPresent(error)) throw error;
  }

  if (!(await mountAllowsList(target, mountPath))) {
    throw new UnreadableR2MountError(mountPath);
  }
}

/** True when listing the mount's contents succeeds without an I/O error. */
export async function mountAllowsList(
  target: Pick<MountRecoverTarget, "exec">,
  mountPath: string,
): Promise<boolean> {
  // Mount paths are platform-controlled (`/uploads`, `/outputs`, `/warehouse/<uuid>`).
  if (!/^\/[A-Za-z0-9._/-]+$/.test(mountPath) || mountPath.includes(".."))
    return false;
  try {
    // `ls -ld <mountpoint>` only stats the mountpoint entry in its parent. A
    // dead s3fs mount can satisfy that stat while any traversal of the mounted
    // directory fails with EIO. Force a readdir so the probe exercises the
    // FUSE connection the upcoming analysis code actually depends on.
    const result = await target.exec(`ls -la -- ${mountPath} >/dev/null`, {
      timeout: 15_000,
    });
    if ((result.exitCode ?? 1) !== 0) return false;
    const combined = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (/Input\/output error|Errno 5/i.test(combined)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-flight gate: concurrent callers share one in-flight run; once it
 * succeeds the gate stays open and the work never runs again. A failed run is
 * NOT cached, so the next call retries. Pure + unit-testable.
 */
export function createSingleFlight(): (
  run: () => Promise<void>,
) => Promise<void> {
  let settled = false;
  let inFlight: Promise<void> | undefined;
  return (run) => {
    if (settled) return Promise.resolve();
    if (!inFlight) {
      inFlight = (async () => {
        await run();
        settled = true;
      })().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

/**
 * The in-container hostname for the workspace connections RPC. Container code
 * (notebooks, scripts) POSTs to `http://connections.internal/` — the same
 * `CAMELAI_CONNECTIONS_RPC_URL` protocol the project VMs used — and the request
 * never leaves Cloudflare: the sandbox egress layer intercepts the host and
 * dispatches the registered outbound handler in Worker context (the same
 * mechanism the SDK itself uses for `r2.internal` mounts).
 */
export const ANALYSIS_CONNECTIONS_HOST = "connections.internal";

/** The outbound-handler method name registered for ANALYSIS_CONNECTIONS_HOST. */
export const ANALYSIS_CONNECTIONS_HANDLER = "connectionsRpc";

/** PyPI hosts, so `uv` can install packages beyond the baked default stack. */
export const ANALYSIS_PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];

/**
 * The container's egress allowlist. The SDK's proxy applies `allowedHosts` as a
 * whitelist gate BEFORE dispatching `outboundByHost` handlers ("outboundByHost
 * only maps a handler for a hostname, it does not allow it" — containers SDK),
 * so the intercepted connections host must be listed here for its handler to be
 * reachable at all. Listing it does NOT open internet access to it: a matching
 * outbound handler is dispatched before the allowed-host pass-through. The
 * app-scoped container doesn't rely on this list at all — its egress is sealed
 * outright per run (see sealAppEgress). Everything else is blocked.
 */
export const ANALYSIS_ALLOWED_HOSTS = [
  ...ANALYSIS_PYPI_HOSTS,
  ANALYSIS_CONNECTIONS_HOST,
];

/** Workspace/org scope attached DO-side to the connections outbound handler. */
export interface AnalysisConnectionsParams {
  orgId: string;
  workspaceId: string;
}

/**
 * Unified analysis container — the successor to (and absorption of)
 * WarehouseSandbox.
 *
 * One warm container per workspace runs everything the old per-project VM did for
 * data analysis: Jupyter notebook execution, ad-hoc shell/Python, and the heavy
 * DuckDB cross-source reduction that used to be the sealed warehouse's whole job.
 * Per-call isolation is via sessions/working dirs (see analysis-service.ts).
 *
 * NETWORK POSTURE — `enableInternet = false` with an SDK-enforced egress
 * allowlist, not a sealed box and not open internet:
 *   - `allowedHosts` = PyPI only, so `uv` can install packages beyond the baked
 *     default stack. The sandbox egress proxy enforces this; it is not deferred
 *     to host-level infra.
 *   - `connections.internal` is an intercepted host: requests to it are
 *     dispatched to the `connectionsRpc` outbound handler below, running in
 *     Worker context with the workspace/org scope that the AnalysisService
 *     attached DO-side via `setOutboundByHost` params. Container code cannot
 *     forge that scope and no token or credential ever enters the container.
 *
 * DATA IN — read-only R2 mounts, platform-mediated (egress interception → the R2
 * binding, NOT the internet), scoped to the workspace's own key prefixes:
 *   - connection exports (WAREHOUSE_EXPORT_BUCKET / `warehouse/<ws>/…`)
 *   - workspace uploads (R2_BUCKET / `<org>/<ws>/user-uploads/…`)
 * Each prefix mounts at `/<prefix>`, so an object at R2 key `<prefix>/x` is read at
 * `/<prefix>/x` — this preserves the warehouse's `'/' + r2_key` contract exactly.
 * See plans/stateless-data-analysis-architecture.md.
 */
export class AnalysisSandbox extends Sandbox<Env> {
  // Internet off; PyPI reachable via allowedHosts, connections via the
  // intercepted internal host. See the class doc for the full posture.
  enableInternet = false;
  allowedHosts = ANALYSIS_ALLOWED_HOSTS;
  // Without this, HTTPS never enters the interception chain (the SDK only
  // applies the outbound fetcher to HTTPS when interceptHttps is on), so with
  // the internet off, uv's HTTPS requests to the allowed PyPI hosts would be
  // blocked outright. The SDK signals the container via SANDBOX_INTERCEPT_HTTPS
  // so the baked container-server trusts the interception CA for spawned
  // processes. connections.internal is plain HTTP and unaffected.
  interceptHttps = true;
  // Memory/disk bill while awake; 5m is enough for interactive notebooks
  // without the SDK's 10m default idle burn (see container-sizing.ts).
  sleepAfter = ANALYSIS_SLEEP_AFTER;

  // Mount paths already established in this container, and a per-path single-flight
  // gate coalescing concurrent mount attempts of the SAME path. Both track the
  // actual container mounts, not DO storage. Instance state on a DO — not a
  // module-level cache — so nothing leaks across containers.
  //
  // They are cleared in `onStop`, NOT by DO recreation: a container stop fires
  // `onStop` on the SURVIVING DO instance (that is what the hook is for) and the
  // SDK clears its own `activeMounts` there. Without the override below, a
  // restarted container came back with empty mount points while this set still
  // claimed them, so `ensureMounted` short-circuited and a run read an empty
  // `/exports` with exit 0 — a silent wrong answer.
  private mountedPaths = new Set<string>();
  private mountGates = new Map<
    string,
    (run: () => Promise<void>) => Promise<void>
  >();
  // Container generation `mountedPaths` describes. `onStop` is the hook that is
  // SUPPOSED to clear the bookkeeping, but the SDK only flushes pending stop
  // events from startAndWaitForPorts/stop()/alarm — a `destroy()` (which is what
  // the zombie self-heal does) does NOT run it synchronously. Pinning the
  // generation makes a stale entry unusable even if no hook ever fires.
  private mountedContainerGeneration: number | undefined;

  /** Consecutive session deaths seen by `exec` on this DO instance. */
  private sessionDeaths = new SandboxSessionDeathTracker();

  /**
   * Wedged-teardown bookkeeping, per DO instance (see
   * SandboxZombieHealState).
   */
  private zombieHealState = createSandboxZombieHealState();

  /**
   * Same zombie self-heal the build container runs (see
   * sandbox-zombie-recovery.ts), with one deliberate difference: it fires on the
   * SECOND consecutive session death, not the first.
   *
   * The analysis path already has a cheap, correct recovery for a single death —
   * `AnalysisService.withSessionRecovery` clears the cached session id
   * (`resetSession`) and retries once against the SAME warm container, which is
   * sub-second and is exactly what the SDK's self-recovering SessionTerminated
   * class needs. Destroying on the first death would pre-empt that retry with a
   * 30-120s cold boot plus a full re-mount. A death that survives the fresh
   * session handshake is a real zombie, and that is what
   * SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD counts. The error always propagates, so
   * the service's recovery keeps its semantics either way, and the shared
   * cooldown still prevents a double restart.
   */
  override async exec(
    command: string,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return withZombieSelfHeal(
      this.zombieHealTarget,
      "AnalysisSandbox",
      "exec",
      () => super.exec(command, options),
      {
        threshold: SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD,
        tracker: this.sessionDeaths,
      },
    );
  }

  /**
   * Fail-fast admission for one complete analysis operation in this
   * workspace/scoped container. The lease is durable so a DO eviction cannot
   * forget an owner while its container work is still alive. Expiry is NOT
   * permission to overlap: an expired owner is replaced only after a bounded,
   * confirmed destructive reset. The recovering marker blocks every concurrent
   * acquirer while that reset is in flight.
   */
  async acquireExecutionLease(request: {
    token: string;
    operation: string;
  }): Promise<AnalysisExecutionLeaseResult> {
    if (
      !request ||
      typeof request.token !== "string" ||
      !/^[A-Za-z0-9-]{1,128}$/.test(request.token) ||
      typeof request.operation !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(request.operation)
    ) {
      throw new Error("Invalid analysis execution lease request");
    }

    const now = Date.now();
    const raw = this.ctx.storage.kv.get<unknown>(ANALYSIS_EXECUTION_LEASE_KEY);
    const current = isStoredAnalysisExecutionLease(raw) ? raw : undefined;
    const sessionTaintRaw = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_SESSION_TAINT_KEY,
    );
    const archiveTaintRaw = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY,
    );
    if (current && current.deadlineAt > now) {
      return {
        acquired: false,
        reason: "busy",
        retryAfterMs: Math.max(1, current.deadlineAt - now),
      };
    }

    if (
      raw !== undefined ||
      sessionTaintRaw !== undefined ||
      archiveTaintRaw !== undefined
    ) {
      // Fence the stale token before the first await. Another RPC can interleave
      // while destroy() waits, but it can only observe this recovering owner and
      // return busy; it cannot start a second reset or a second operation.
      const recoveryToken = `recovery-${request.token}`;
      const recoveryDeadlineAt = now + ANALYSIS_EXECUTION_LEASE_MS;
      this.ctx.storage.kv.put(ANALYSIS_EXECUTION_LEASE_KEY, {
        token: recoveryToken,
        operation: "stale_recovery",
        deadlineAt: recoveryDeadlineAt,
        state: "recovering",
      } satisfies StoredAnalysisExecutionLease);

      const resetConfirmed = await destroyUncleanExecContainer(this);
      if (!resetConfirmed) {
        // Keep the durable recovering marker. A later caller may retry recovery
        // only after its fixed expiry; no caller is admitted on uncertainty.
        return {
          acquired: false,
          reason: "stale_reset_unconfirmed",
          retryAfterMs: Math.max(1, recoveryDeadlineAt - Date.now()),
        };
      }

      const owner = this.ctx.storage.kv.get<unknown>(
        ANALYSIS_EXECUTION_LEASE_KEY,
      );
      if (
        !isStoredAnalysisExecutionLease(owner) ||
        owner.token !== recoveryToken ||
        owner.state !== "recovering"
      ) {
        return {
          acquired: false,
          reason: "busy",
          retryAfterMs: ANALYSIS_EXECUTION_LEASE_MS,
        };
      }
      // A resolved generation reset proves the old writer/session is fenced.
      // Archive bytes live in R2 after the mount disappears, so delete by the
      // trusted object key before admitting any replacement operation.
      const archiveTaint = this.ctx.storage.kv.get<unknown>(
        ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY,
      );
      if (
        isStoredAnalysisExecutionTaint(archiveTaint) &&
        archiveTaint.kind === "archive" &&
        isTrustedBoundedExecArchiveKey(archiveTaint.resource)
      ) {
        const deleted = await deleteBoundedExecArchiveObject(
          this,
          archiveTaint.resource,
        );
        if (!deleted) {
          return {
            acquired: false,
            reason: "stale_reset_unconfirmed",
            retryAfterMs: Math.max(1, recoveryDeadlineAt - Date.now()),
          };
        }
        clearAnalysisExecutionTaint(this, "archive", archiveTaint.token);
      } else if (archiveTaint !== undefined) {
        // Its exact object key is no longer trustworthy, so never admit work
        // that could stack more output behind an unrecoverable marker.
        return {
          acquired: false,
          reason: "stale_reset_unconfirmed",
          retryAfterMs: Math.max(1, recoveryDeadlineAt - Date.now()),
        };
      }
      if (
        this.ctx.storage.kv.get<unknown>(
          ANALYSIS_EXECUTION_SESSION_TAINT_KEY,
        ) !== undefined
      ) {
        this.ctx.storage.kv.delete(ANALYSIS_EXECUTION_SESSION_TAINT_KEY);
      }
    }

    const deadlineAt = Date.now() + ANALYSIS_EXECUTION_LEASE_MS;
    this.ctx.storage.kv.put(ANALYSIS_EXECUTION_LEASE_KEY, {
      token: request.token,
      operation: request.operation,
      deadlineAt,
      state: "active",
    } satisfies StoredAnalysisExecutionLease);
    return { acquired: true, deadlineAt };
  }

  /** Token-fenced release: an old finally can never clear a recovered owner. */
  async releaseExecutionLease(token: string): Promise<boolean> {
    const owner = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_LEASE_KEY,
    );
    if (
      !isStoredAnalysisExecutionLease(owner) ||
      owner.state !== "active" ||
      owner.token !== token
    ) {
      return false;
    }
    const archiveTaint = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY,
    );
    if (archiveTaint !== undefined) return false;
    this.ctx.storage.kv.delete(ANALYSIS_EXECUTION_LEASE_KEY);
    return true;
  }

  /** Phase two: clear an archive marker only after its service result is ready. */
  async acknowledgeBoundedExecArchive(request: {
    ownerToken: string;
    taintToken: string;
    objectKey: string;
  }): Promise<boolean> {
    const owner = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_LEASE_KEY,
    );
    const taint = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY,
    );
    if (
      !isStoredAnalysisExecutionLease(owner) ||
      owner.state !== "active" ||
      owner.token !== request.ownerToken ||
      !isStoredAnalysisExecutionTaint(taint) ||
      taint.kind !== "archive" ||
      taint.ownerToken !== request.ownerToken ||
      taint.token !== request.taintToken ||
      taint.resource !== request.objectKey
    ) {
      return false;
    }
    return clearAnalysisExecutionTaint(this, "archive", taint.token);
  }

  /** Abort phase two: delete the exact object before clearing its marker. */
  async discardBoundedExecArchive(request: {
    ownerToken: string;
    taintToken: string;
    objectKey: string;
  }): Promise<boolean> {
    const owner = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_LEASE_KEY,
    );
    const taint = this.ctx.storage.kv.get<unknown>(
      ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY,
    );
    if (
      !isStoredAnalysisExecutionLease(owner) ||
      owner.state !== "active" ||
      owner.token !== request.ownerToken ||
      !isStoredAnalysisExecutionTaint(taint) ||
      taint.kind !== "archive" ||
      taint.ownerToken !== request.ownerToken ||
      taint.token !== request.taintToken ||
      taint.resource !== request.objectKey
    ) {
      return false;
    }
    if (!(await deleteBoundedExecArchiveObject(this, request.objectKey))) {
      return false;
    }
    return clearAnalysisExecutionTaint(this, "archive", taint.token);
  }

  /** Consume the SDK's raw execution stream without ever accumulating output. */
  async execBounded(
    command: string,
    options: ExecOptions | undefined,
    limits: {
      stdoutBytes: number;
      stderrBytes: number;
      overflowPath?: string;
      /** Trusted exact R2 key for eviction-safe cleanup after mount teardown. */
      overflowObjectKey?: string;
      /** Active service lease that owns this bounded command lifecycle. */
      executionOwnerToken?: string;
      overflowBytes?: number;
    },
  ): Promise<BoundedAnalysisExecResult> {
    if (typeof command !== "string")
      throw new Error("Analysis command must be a string");
    if (command.includes("\0"))
      throw new Error("Analysis command contains a NUL byte");
    if (utf8ByteLength(command) > 64 * 1024) {
      throw new Error("Analysis command exceeds the 65536 byte limit");
    }
    if (
      options?.cwd !== undefined &&
      (typeof options.cwd !== "string" ||
        options.cwd.includes("\0") ||
        utf8ByteLength(options.cwd) > 4 * 1024)
    ) {
      throw new Error(
        "Analysis working directory exceeds its bounded path limit",
      );
    }
    const executionOwnerToken = limits.executionOwnerToken;
    if (
      executionOwnerToken !== undefined &&
      !/^[A-Za-z0-9-]{1,128}$/.test(executionOwnerToken)
    ) {
      throw new Error("Invalid bounded-exec archive owner token");
    }
    // A previous acquisition/archive timeout can survive DO eviction. Reconcile
    // its durable write-ahead marker before allocating captures or starting a
    // second process. An archive owned by this active lease remains pending
    // until the service acknowledges its result.
    await recoverAnalysisExecutionTaint(this);
    assertAnalysisExecutionOwner(this, executionOwnerToken);
    const cap = (value: number) => {
      const finite = Number.isFinite(value) ? Math.floor(value) : 1024;
      return Math.min(512 * 1024, Math.max(1024, finite));
    };
    const stdoutLimit = cap(limits.stdoutBytes);
    const stderrLimit = cap(limits.stderrBytes);
    const overflowPath = limits.overflowPath;
    const overflowObjectKey = limits.overflowObjectKey;
    if (
      overflowPath !== undefined &&
      !/^\/outputs\/tmp\/[A-Za-z0-9._-]+\.log$/.test(overflowPath)
    ) {
      throw new Error("Invalid bounded-exec overflow path");
    }
    const overflowFilename = overflowPath?.split("/").at(-1);
    if (
      overflowObjectKey !== undefined &&
      (!overflowFilename ||
        !isTrustedBoundedExecArchiveKey(overflowObjectKey) ||
        !overflowObjectKey.endsWith(`/user-outputs/tmp/${overflowFilename}`))
    ) {
      throw new Error("Invalid bounded-exec overflow object key");
    }
    const requestedOverflow = Number.isFinite(limits.overflowBytes)
      ? Math.max(0, Math.floor(limits.overflowBytes ?? 0))
      : 0;
    const minimumOverflow = stdoutLimit + stderrLimit + 4096;
    const overflowLimit =
      overflowPath && requestedOverflow >= minimumOverflow
        ? Math.min(
            CHAT_RUNTIME_BOUNDS.analysisOutputOverflowBytes,
            requestedOverflow,
          )
        : 0;
    const encodedEnvironment = boundedCanonicalJsonResult(
      options?.env ?? {},
      32 * 1024,
      {
        maxDepth: 2,
        maxEntries: 128,
        maxNodes: 256,
      },
    );
    if (!encodedEnvironment.complete) {
      throw new Error("Analysis environment exceeds its bounded JSON limit");
    }
    try {
      const parsed = JSON.parse(encodedEnvironment.json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      if (
        !Object.entries(parsed).every(
          ([key, value]) =>
            typeof value === "string" &&
            !key.includes("\0") &&
            !key.includes("=") &&
            !value.includes("\0"),
        )
      ) {
        throw new Error();
      }
    } catch {
      throw new Error("Analysis environment must contain only string values");
    }
    const requestedTimeout = Number.isFinite(options?.timeout)
      ? Math.floor(options?.timeout ?? 0)
      : 360_000;
    const outerTimeoutMs = Math.max(
      1_000,
      Math.min(CHAT_RUNTIME_BOUNDS.analysisCommandDeadlineMs, requestedTimeout),
    );
    const childTimeoutMs = Math.max(250, outerTimeoutMs - 750);
    const headLimit =
      overflowLimit > 0
        ? Math.floor((overflowLimit - stdoutLimit - stderrLimit - 4096) / 2)
        : 0;
    const stdoutCapture = new BoundedByteCapture(headLimit, stdoutLimit);
    const stderrCapture = new BoundedByteCapture(headLimit, stderrLimit);
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(
        new Error(`Analysis execution exceeded ${outerTimeoutMs}ms`),
      );
    }, outerTimeoutMs);
    const externalSignal = options?.signal;
    const externalAbort = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) externalAbort();
    else
      externalSignal?.addEventListener("abort", externalAbort, { once: true });
    let exitCode: number;
    try {
      exitCode = await withZombieSelfHeal(
        this.zombieHealTarget,
        "AnalysisSandbox",
        "exec_bounded",
        async () => {
          if (controller.signal.aborted)
            throw boundedExecAbortReason(controller.signal);
          const sessionId = `bounded-${crypto.randomUUID()}`;
          // Write ahead of the non-abortable SDK acquisition. A DO eviction or
          // local timeout can lose the awaiting continuation, but not this
          // generation-taint marker; later admission must reset before reuse.
          const sessionTaint = markAnalysisExecutionTaint(
            this,
            "session",
            sessionId,
          );
          let creation: Promise<ExecutionSession>;
          try {
            creation = this.createSession({
              id: sessionId,
              ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
              env: {
                // Keep arbitrary shell text out of the fixed supervisor command.
                // Caller env is likewise decoded only inside the supervised
                // process group. PATH/BASH_ENV therefore cannot alter the fixed
                // supervisor before its cleanup trap is installed.
                [BOUNDED_EXEC_COMMAND_ENV]: command,
                [BOUNDED_EXEC_ENVIRONMENT_ENV]: encodedEnvironment.json,
              },
              commandTimeoutMs: childTimeoutMs,
            });
          } catch (error) {
            const destroyed = await destroyUncleanExecContainer(this);
            if (!destroyed) {
              throw new BoundedExecSessionCleanupError(
                "Bounded analysis session acquisition failed and container reset was unconfirmed",
                { cause: error },
              );
            }
            clearAnalysisExecutionTaint(this, "session", sessionTaint);
            throw error;
          }
          let session: ExecutionSession | undefined;
          let primaryError: unknown;
          let executionResult: number | undefined;
          try {
            try {
              session = await withBoundedExecAbort(creation, controller.signal);
            } catch (error) {
              // Session acquisition has no SDK signal or acquisition timeout.
              // Do not make correctness depend on a late `.then`: immediately
              // destroy this generation and clear the durable taint only after
              // teardown is confirmed. `creation` remains rejection-observed by
              // withBoundedExecAbort's Promise.race handlers.
              const destroyed = await destroyUncleanExecContainer(this);
              if (!destroyed) {
                throw new BoundedExecSessionCleanupError(
                  "Bounded analysis session acquisition was abandoned and container reset was unconfirmed",
                  { cause: error },
                );
              }
              clearAnalysisExecutionTaint(this, "session", sessionTaint);
              throw error;
            }

            assertAnalysisExecutionOwner(this, executionOwnerToken);
            if (controller.signal.aborted)
              throw boundedExecAbortReason(controller.signal);
            const opening = session.execStream(BOUNDED_EXEC_SUPERVISOR, {
              timeout: childTimeoutMs,
              signal: controller.signal,
            });
            let stream: ReadableStream<Uint8Array>;
            try {
              stream = await withBoundedExecAbort(opening, controller.signal);
            } catch (error) {
              // `execStream` also checks its signal only before opening. Cancel
              // a stream that arrives after the local deadline so its RPC
              // export cannot stay live until the container-side timeout.
              void opening
                .then(
                  (lateStream) => lateStream.cancel(controller.signal.reason),
                  () => undefined,
                )
                .catch(() => undefined);
              throw error;
            }
            executionResult = await withBoundedExecAbort(
              consumeBoundedExecStream(
                stream,
                stdoutCapture,
                stderrCapture,
                controller.signal,
              ),
              controller.signal,
            );
          } catch (error) {
            primaryError = error;
          }
          if (session) {
            // The SDK timeout only bounds waiting; it does not kill work.
            // The supervisor owns a fresh process group and reaps ordinary
            // background descendants on success, while deleting the unique
            // session triggers that same trap on timeout/error. A process
            // that deliberately creates a second session can still escape;
            // the current image exposes neither PID namespaces nor writable
            // cgroups, so do not describe this as adversarial containment.
            const deleted = await deleteBoundedExecSession(this, sessionId);
            if (!deleted) {
              const destroyed = await destroyUncleanExecContainer(this);
              if (!destroyed) {
                throw new BoundedExecSessionCleanupError(
                  "Bounded analysis session cleanup did not finish and container reset failed; process termination is unconfirmed",
                  primaryError === undefined
                    ? undefined
                    : { cause: primaryError },
                );
              }
              console.warn(
                "[sandbox] reset container after bounded analysis session cleanup failed",
                { sessionId },
              );
            }
            clearAnalysisExecutionTaint(this, "session", sessionTaint);
          }
          if (primaryError !== undefined) throw primaryError;
          if (controller.signal.aborted) {
            throw boundedExecAbortReason(controller.signal);
          }
          if (executionResult === undefined) {
            throw new Error("Bounded analysis stream ended without a result");
          }
          return executionResult;
        },
        {
          threshold: SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD,
          tracker: this.sessionDeaths,
        },
      );
    } catch (error) {
      if (error instanceof BoundedExecSessionCleanupError) throw error;
      if (!timedOut) throw error;
      exitCode = 124;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", externalAbort);
    }
    const stdoutTail = stdoutCapture.tailBytes();
    const stderrTail = stderrCapture.tailBytes();
    const stdoutBytes = stdoutCapture.totalBytes;
    const stderrBytes = stderrCapture.totalBytes;
    const outputTruncated =
      stdoutBytes > stdoutTail.byteLength ||
      stderrBytes > stderrTail.byteLength;
    let overflowStored = false;
    let overflowComplete = false;
    let overflowBytes = 0;
    let overflowTaintToken: string | undefined;
    if (outputTruncated && overflowLimit > 0 && overflowPath) {
      const stdoutArchive = captureArchive("stdout", stdoutCapture);
      const stderrArchive = captureArchive("stderr", stderrCapture);
      const segments = [...stdoutArchive.segments, ...stderrArchive.segments];
      const archiveBytes = segments.reduce(
        (sum, segment) => sum + segment.byteLength,
        0,
      );
      if (archiveBytes <= overflowLimit) {
        assertAnalysisExecutionOwner(this, executionOwnerToken);
        if (
          analysisExecutionTaintKv(this)?.get<unknown>(
            ANALYSIS_EXECUTION_ARCHIVE_TAINT_KEY,
          ) !== undefined
        ) {
          throw new BoundedExecSessionCleanupError(
            "A bounded-analysis archive is still awaiting acknowledgement",
          );
        }
        const archiveTaint = overflowObjectKey
          ? markAnalysisExecutionTaint(
              this,
              "archive",
              overflowObjectKey,
              executionOwnerToken,
            )
          : undefined;
        const write = Promise.resolve()
          .then(() => this.writeFile(overflowPath, archiveStream(segments)))
          .then(
            (result) => result.success === true,
            () => false,
          );
        let archiveTimer: ReturnType<typeof setTimeout> | undefined;
        const archiveDeadline = new Promise<false>((resolve) => {
          archiveTimer = setTimeout(
            () => resolve(false),
            BOUNDED_EXEC_ARCHIVE_WRITE_MS,
          );
        });
        overflowStored = await Promise.race([write, archiveDeadline]);
        if (archiveTimer) clearTimeout(archiveTimer);
        if (overflowStored) {
          if (archiveTaint && executionOwnerToken) {
            overflowTaintToken = archiveTaint;
          } else if (archiveTaint) {
            clearAnalysisExecutionTaint(this, "archive", archiveTaint);
          }
        } else {
          // Neither a timeout nor an RPC rejection proves that writeFile did
          // not commit remotely. Fence every non-successful writer by awaiting
          // destructive reset, then delete the exact object directly from R2.
          // The durable marker survives eviction or an unconfirmed step.
          const destroyed = await destroyUncleanExecContainer(this);
          if (!destroyed || !archiveTaint || !overflowObjectKey) {
            throw new BoundedExecSessionCleanupError(
              "Bounded analysis archive write was abandoned and cleanup was unconfirmed",
            );
          }
          const deleted = await deleteBoundedExecArchiveObject(
            this,
            overflowObjectKey,
          );
          if (!deleted) {
            throw new BoundedExecSessionCleanupError(
              "Bounded analysis archive object cleanup was unconfirmed",
            );
          }
          clearAnalysisExecutionTaint(this, "archive", archiveTaint);
        }
        overflowComplete =
          overflowStored && stdoutArchive.complete && stderrArchive.complete;
        overflowBytes = overflowStored ? archiveBytes : 0;
      }
    }
    const marker = (total: number, kept: number) =>
      total > kept ? `[... ${total - kept} earlier bytes truncated ...]\n` : "";
    return {
      success: exitCode === 0,
      exitCode,
      stdout: `${marker(stdoutBytes, stdoutTail.byteLength)}${new TextDecoder().decode(stdoutTail)}`,
      stderr: `${marker(stderrBytes, stderrTail.byteLength)}${new TextDecoder().decode(stderrTail)}`,
      stdoutBytes,
      stderrBytes,
      outputTruncated,
      overflowStored,
      overflowComplete,
      overflowBytes,
      ...(overflowTaintToken ? { overflowTaintToken } : {}),
    };
  }

  /** Worker-side entry point for the same rate-limited self-heal. */
  async restartZombieContainer(
    request: SandboxZombieRestartRequest,
  ): Promise<SandboxZombieRestartOutcome> {
    return healZombieSandboxContainer(
      this.zombieHealTarget,
      "AnalysisSandbox",
      request,
    );
  }

  /** `ctx` is protected, so the shared helper gets an explicit public view. */
  private get zombieHealTarget(): ZombieHealableSandbox {
    return createZombieHealTarget({
      ctx: this.ctx,
      env: this.env,
      destroy: () => this.destroy(),
      healState: this.zombieHealState,
      onContainerDestroyed: () => this.forgetDestroyedContainerState(),
    });
  }

  /**
   * The only direct destructive-reset surface for callers outside the zombie
   * helper. A resolved reset means both the container and every cache describing
   * that container generation are gone; callers must fail closed if it rejects
   * or misses their own deadline.
   */
  async destroyAndForgetContainerGeneration(): Promise<void> {
    await this.destroy();
    await this.forgetDestroyedContainerState();
  }

  /**
   * The container was destroyed under us (zombie self-heal). `onStop` is NOT
   * guaranteed to run for that path, so everything that only described THAT
   * container is dropped here: the mount bookkeeping (otherwise the retry that
   * follows short-circuits `ensureMounted` and runs user code against a
   * container with nothing mounted — an empty `/exports` read as exit 0), the
   * cached session id, and the consecutive-death count.
   */
  private async forgetDestroyedContainerState(): Promise<void> {
    this.clearMountBookkeeping();
    this.sessionDeaths.reset();
    await this.resetSession();
  }

  private clearMountBookkeeping(): void {
    this.mountedPaths = new Set<string>();
    this.mountGates = new Map<
      string,
      (run: () => Promise<void>) => Promise<void>
    >();
  }

  /**
   * Drop mount bookkeeping left over from a previous container life. The SDK
   * bumps `containerGeneration` on every container stop; anything recorded under
   * an older generation describes mounts that no longer exist.
   */
  private syncMountBookkeepingToContainer(): void {
    const sdk = this as unknown as { containerGeneration?: number };
    const generation =
      typeof sdk.containerGeneration === "number" ? sdk.containerGeneration : 0;
    if (this.mountedContainerGeneration === generation) return;
    this.mountedContainerGeneration = generation;
    this.clearMountBookkeeping();
  }

  /**
   * Container went away: everything mounted into it went with it. Clear the
   * bookkeeping so the next `ensureMounted` really re-mounts.
   */
  override async onStop(): Promise<void> {
    this.clearMountBookkeeping();
    this.sessionDeaths.reset();
    await super.onStop();
  }

  /**
   * Mount an R2 prefix so container code can read the staged objects. Mounts are
   * read-only by default; pass `{ readOnly: false }` for the outputs mount,
   * which is how a run hands a generated file back to the user.
   *
   * By default the mount lands at `/<prefix>` (preserving the warehouse's
   * `'/' + r2_key` contract for exports); pass `mountPath` to mount at a stable
   * alias instead (uploads mount at `/uploads`, since the org/workspace-prefixed
   * R2 key is neither shown to the agent nor derivable inside the container).
   * The `prefix` option passed to `mountBucket` keeps the proven warehouse shape
   * (leading slash).
   *
   * The mount runs at most once per mount path per container life: the
   * single-flight gate coalesces concurrent callers and caches success; repeated
   * calls on a warm container are a no-op. An already-mounted error from a
   * previous container life is recovered via unmount+remount (see mountOrRecover)
   * so `r2.internal` egress is re-registered instead of leaving zombie FUSE mounts.
   */
  async ensureMounted(
    bucketBinding: string,
    prefix: string,
    mountPath?: string,
    options: { readOnly?: boolean } = {},
  ): Promise<void> {
    const resolvedMountPath = mountPath ?? `/${prefix}`;
    // Never trust bookkeeping from a container that has since stopped/been
    // destroyed: short-circuiting there is what silently runs a query against
    // missing mounts.
    this.syncMountBookkeepingToContainer();
    const readOnly = options.readOnly ?? true;
    const mountOptions = sandboxR2MountOptions(this.env, {
      prefix: `/${prefix}`,
      readOnly,
      // Shrink the s3fs stat cache (default 60s + negative caching) so a
      // just-staged export/upload isn't read through a stale/partial view.
      // Self-host local sync deliberately drops this s3fs-only option.
      s3fsOptions: ["stat_cache_expire=1"],
    });
    const actualMountPath = sandboxR2MountPath(resolvedMountPath, mountOptions);
    if (this.mountedPaths.has(resolvedMountPath)) {
      if (await mountAllowsList(this, actualMountPath)) return;
      // A mount can die without a container stop (the exact production Errno 5
      // failure mode). Do not trust the cached success: reopen the single-flight
      // gate so this call unmounts/remounts before dispatching user code.
      console.warn(
        `[sandbox] cached R2 mount ${actualMountPath} is unreadable; remounting`,
      );
      this.mountedPaths.delete(resolvedMountPath);
      this.mountGates.delete(resolvedMountPath);
    }
    let gate = this.mountGates.get(resolvedMountPath);
    if (!gate) {
      gate = createSingleFlight();
      this.mountGates.set(resolvedMountPath, gate);
    }
    await gate(async () => {
      try {
        await mountOrRecover(
          this,
          bucketBinding,
          actualMountPath,
          mountOptions,
        );
      } catch (error) {
        if (!(error instanceof UnreadableR2MountError)) throw error;
        // Unmount/remount already failed and a real directory traversal still
        // returned EIO. That state cannot recover inside the current container.
        // Reuse the bounded, cooldown-fenced sandbox restart path, then mount
        // once against the fresh container before any user code is dispatched.
        const outcome = await healZombieSandboxContainer(
          this.zombieHealTarget,
          "AnalysisSandbox",
          { operation: "ensure_mounted", trigger: "mount_io_error", error },
        );
        if (!outcome.restarted && outcome.reason !== "container_not_running") {
          throw error;
        }
        await mountOrRecover(
          this,
          bucketBinding,
          actualMountPath,
          mountOptions,
        );
      }
      await ensureLocalMountAlias(this, resolvedMountPath, actualMountPath);
      if (
        "localBucket" in mountOptions &&
        mountOptions.localBucket &&
        !readOnly
      ) {
        const bucket = this.env[bucketBinding as keyof Env];
        await waitForWritableLocalMount(
          this,
          bucket as unknown as LocalMountBucket,
          actualMountPath,
          mountOptions.prefix ?? "",
        );
      }
      this.mountedPaths.add(resolvedMountPath);
    });
  }

  /**
   * Register the connections RPC interception for this container, scoping it to
   * the given workspace/org. Called by AnalysisService before each run — the
   * params live DO-side, so container code cannot change whose connections it
   * queries. Cheap on a warm container (a registry write, no error on repeat).
   */
  async ensureConnectionsRpc(params: AnalysisConnectionsParams): Promise<void> {
    await this.setOutboundByHost(
      ANALYSIS_CONNECTIONS_HOST,
      ANALYSIS_CONNECTIONS_HANDLER,
      params,
    );
  }

  /**
   * Seal this container's egress entirely (block-all allowlist override). Used
   * for the app-scoped container: deployed-app code has no PyPI use case (no
   * uv, no installs) and no connections interception, so the class-level
   * allowlist would only be an exfiltration channel for the mounted export
   * data — the pre-merge WarehouseSandbox posture, restored. The override is
   * in-memory DO state, so AnalysisService applies it before every app run.
   */
  async sealAppEgress(): Promise<void> {
    // [] is a non-nullish override that matches no host — the SDK's proxy then
    // rejects every origin before any pass-through or handler dispatch.
    await this.setAllowedHosts([]);
  }

  /**
   * Forget the container session so the next command re-runs the create-session
   * handshake.
   *
   * A container OOM/restart kills the persistent shell; the container reaps the
   * session and answers `SessionTerminatedError`, but the SDK caches the default
   * session id in DO memory AND in DO storage and only clears it from `onStop`
   * (`node_modules/@cloudflare/sandbox/dist/sandbox-*.js`: `defaultSession`,
   * `ensureDefaultSession`, `onStop`) — so a shell that dies while the container
   * stays up leaves the cached id pointing at a session that no longer exists.
   * Clearing it here is the SDK's own documented remedy ("call createSession()
   * with the same id to recreate it explicitly"), just driven from inside the DO
   * where `ensureDefaultSession` will do it on the next call.
   *
   * Mount bookkeeping is deliberately left alone: mounts are container-level,
   * not session-level, so a dead shell does not invalidate them. A real
   * container stop is the case that DOES invalidate them, and `onStop` clears
   * them there (the DO instance itself survives a container stop).
   *
   * Called only by AnalysisService's one-shot session recovery, and always
   * best-effort: the SDK recreates a terminated session on the next call anyway,
   * so a failure here must not fail the run.
   */
  async resetSession(): Promise<void> {
    const sdkState = this as unknown as {
      defaultSession: string | null;
      defaultSessionInit: unknown;
    };
    sdkState.defaultSession = null;
    sdkState.defaultSessionInit = null;
    try {
      await this.ctx.storage.delete("defaultSession");
    } catch (error) {
      console.warn(
        "[AnalysisSandbox] failed to clear the stored default session",
        error,
      );
    }
  }
}

/**
 * Worker-side handler for `http://connections.internal/` requests from inside an
 * analysis container. Runs in the ContainerProxy WorkerEntrypoint context with
 * the full worker env; identity comes exclusively from `ctx.params` (attached by
 * `ensureConnectionsRpc` DO-side), never from anything in the request.
 *
 * Registered at module load via the Container static registry — both the DO
 * context and the ContainerProxy context import this module through the worker
 * entrypoint, so the registry is populated in each isolate.
 */
async function connectionsRpcOutboundHandler(
  req: Request,
  env: Env,
  ctx: { containerId: string; className: string; params?: unknown },
): Promise<Response> {
  const params = (ctx.params ?? {}) as Partial<AnalysisConnectionsParams>;
  if (!params.orgId || !params.workspaceId) {
    // No DO-attached scope means the interception was registered incorrectly —
    // fail closed rather than guessing a tenant.
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          message: "connections scope not configured for this container",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  return handleAuthenticatedConnectionsRpc(req, env, {
    orgId: params.orgId,
    workspaceId: params.workspaceId,
  });
}

// Static registration keyed by class name ("AnalysisSandbox"); ContainerProxy
// resolves the handler from this registry when dispatching intercepted egress.
//
// COEXISTENCE WITH R2 MOUNTS: the sandbox SDK's mountBucket path also assigns
// `this.constructor.outboundHandlers = { r2EgressMount: ... }` on this class.
// That is safe because @cloudflare/containers' static setter MERGES into the
// registry (`{ ...existing, ...handlers }`) — it does not replace it — so
// connectionsRpc survives mount registration (and vice versa, since this module
// -scope assignment runs at isolate startup, before any mount). A regression
// test pins the merge semantics so an SDK change to replace-semantics fails
// loudly (analysis-service.test.ts).
AnalysisSandbox.outboundHandlers = {
  [ANALYSIS_CONNECTIONS_HANDLER]: connectionsRpcOutboundHandler as never,
};
