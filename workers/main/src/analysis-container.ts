import { Files, SandboxFileError, type S3GatewayBinding } from "@cloudflare/sandbox";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { getWorkspaceR2Prefix } from "../../../src/lib/workspace-r2-paths.js";
import { ANALYSIS_IDLE_TIMEOUT_MS, ANALYSIS_INSTANCE_TYPE } from "./container-sizing.js";
import { errorToObservabilityFields, recordObservabilityEvent } from "./observability.js";
import { handleAuthenticatedConnectionsRpc } from "./routes/connections-rpc.js";
import { SANDBOX_EXEC_TIMEOUT_EXIT_CODE } from "./sandbox-exec-deadline.js";
import {
  createSandboxBucketMounts,
  type BucketMount,
  type SandboxBucketMounts,
} from "./sandbox-mounts.js";
import type { Env } from "./types.js";
import { warehouseWorkspacePrefix } from "./warehouse-export.js";

/** Key of the analysis image in wrangler `containers[].images`. */
export const ANALYSIS_IMAGE = "analysis";

/**
 * The in-container hostname for the workspace connections RPC. Container code
 * (notebooks, scripts) POSTs to `http://connections.internal/`, the same
 * `CAMELAI_CONNECTIONS_RPC_URL` protocol the project VMs used. The request
 * never leaves Cloudflare: a per-host intercept hands it to
 * AnalysisConnectionsGateway in Worker context.
 */
export const ANALYSIS_CONNECTIONS_HOST = "connections.internal";

/** PyPI hosts, so `uv` can install packages beyond the baked default stack. */
export const ANALYSIS_PYPI_HOSTS: readonly string[] = ["pypi.org", "files.pythonhosted.org"];

/** Workspace uploads, read-only: the agent's `uploads/<name>` reference with a leading slash. */
export const ANALYSIS_UPLOADS_MOUNT_PATH = "/uploads";
/** Workspace outputs, writable: `/outputs/<name>` is the `outputs/<name>` R2 reference. */
export const ANALYSIS_OUTPUTS_MOUNT_PATH = "/outputs";

/** Shown (as the thrown error's message) when the container stopped under a command. */
export const ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE =
  "The analysis environment restarted while running this command, so it did not complete. " +
  "Try again — if it keeps happening, run a smaller step (less data in memory at once).";

const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.system.crt";

/**
 * Appends the HTTPS intercept's CA (written into the container once the HTTPS
 * intercept is registered) to the system bundle, keeping a pristine copy so a
 * repeat run never appends twice.
 */
const TRUST_INTERCEPT_CA = [
  "sh",
  "-c",
  `[ -e ${SYSTEM_CA_BUNDLE} ] || { cp ${CA_BUNDLE} ${SYSTEM_CA_BUNDLE}.tmp && mv ${SYSTEM_CA_BUNDLE}.tmp ${SYSTEM_CA_BUNDLE}; }
timeout 10 sh -c 'until [ -s ${INTERCEPT_CA} ]; do sleep 0.1; done' &&
cat ${SYSTEM_CA_BUNDLE} ${INTERCEPT_CA} >${CA_BUNDLE}.tmp && mv ${CA_BUNDLE}.tmp ${CA_BUNDLE}`,
];

/**
 * Environment of every command. `exec()` sees none of the image's `ENV` lines
 * and starts in `/` whatever `WORKDIR` says, so what the Dockerfile sets for
 * the analysis stack is repeated here (keep the two in sync), plus the CA
 * variables that make every HTTPS client trust the intercept CA.
 */
export const ANALYSIS_BASE_ENV: Readonly<Record<string, string>> = {
  HOME: "/root",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/opt/analysis-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ANALYSIS_VENV: "/opt/analysis-venv",
  // The baked `camelai` helper package, importable from the baked venv,
  // per-project uv environments and run_code alike.
  PYTHONPATH: "/opt/camelai-python",
  // Seeded at build time, so project syncs reuse the baked wheels.
  UV_CACHE_DIR: "/opt/uv-cache",
  UV_NATIVE_TLS: "true",
  SSL_CERT_FILE: CA_BUNDLE,
  REQUESTS_CA_BUNDLE: CA_BUNDLE,
  CURL_CA_BUNDLE: CA_BUNDLE,
  NODE_EXTRA_CA_CERTS: INTERCEPT_CA,
};

/** Bound for the container's own setup commands. */
const SETUP_TIMEOUT_MS = 60_000;

/** GNU `timeout` sends SIGKILL this long after SIGTERM. */
const KILL_AFTER_SECONDS = 5;

/**
 * Per-stream cap on captured output. A command's whole result crosses one RPC
 * message (32 MiB) and sits in Durable Object memory; the tail is kept because
 * tracebacks end there.
 */
export const ANALYSIS_OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

/** DO storage: what the running container was set up for. */
const SETUP_KEY = "analysis-container-setup";

/**
 * Whose data a container serves. The agent container (named `<workspaceId>`)
 * gets uploads, outputs and the export prefix, connections and PyPI; the app
 * container (`app-<workspaceId>`), which runs deployed-app code, gets only the
 * export prefix and no egress at all.
 */
export type AnalysisAccess =
  | { readonly mode: "agent"; readonly orgId: string; readonly workspaceId: string }
  | { readonly mode: "app"; readonly workspaceId: string };

/** The Durable Object name that serves `access`; the class refuses any other pairing. */
export function analysisContainerName(access: AnalysisAccess): string {
  return access.mode === "app" ? `app-${access.workspaceId}` : access.workspaceId;
}

export interface AnalysisExecOptions {
  /** Absolute working directory. */
  cwd: string;
  env?: Record<string, string>;
  /** The command is stopped (process group SIGTERM, then SIGKILL) after this. */
  timeoutMs: number;
}

export interface AnalysisCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The command ran into `timeoutMs` and was stopped (exit 124). */
  timedOut: boolean;
}

export interface AnalysisOpenedFile {
  stream: ReadableStream<Uint8Array>;
  size: number;
}

/** What AnalysisService drives; tests pass a fake. */
export interface AnalysisContainerLike {
  exec(command: string, options: AnalysisExecOptions): Promise<AnalysisCommandResult>;
  /** Creates the directory and its parents. */
  mkdir(path: string): Promise<void>;
  /** Writes the file, creating parent directories; a stream is written as it arrives. */
  writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<void>;
  openFile(path: string): Promise<AnalysisOpenedFile>;
  /** Best-effort `rm -rf`; never starts a container. */
  removePaths(paths: string[]): Promise<void>;
}

export type AnalysisContainerStub = AnalysisContainerLike & {
  /** Starts (or checks) the container for `access`. Call before anything else. */
  prepare(access: AnalysisAccess): Promise<void>;
  /** Copies writable mounts back to R2 where they are not live (self-host); never starts a container. */
  flushMounts(): Promise<void>;
};

interface StoredSetup {
  access: AnalysisAccess;
  /** Mount paths set up with the container (a failed optional mount is absent). */
  mounts: string[];
}

interface MountPlan {
  mount: BucketMount;
  /** A required mount failing fails the setup; an optional one is skipped. */
  required: boolean;
}

export interface AnalysisContainerDeps {
  files?: Pick<Files, "mkdir" | "writeFile" | "readFile" | "rename" | "remove" | "stat">;
  mounts?: SandboxBucketMounts;
}

/**
 * The workspace analysis container on the native Durable Object container API
 * (`scheduling_policy: "durable_object"`, Sandbox SDK 1.0).
 *
 * One warm container per workspace runs everything the old per-project VM did
 * for data analysis: notebook execution, ad-hoc shell/Python and DuckDB over
 * mounted exports. Every command is its own process (`bash -c` under GNU
 * timeout), so nothing queues behind a stuck command and there is no session
 * to die. Per-call isolation is per-run working dirs (analysis-service.ts).
 *
 * NETWORK — the container starts with `enableInternet: false`, then gets
 * intercepts in this order (order matters: a hostname intercept registered
 * after the catch-all receives nothing):
 *   1. the R2 mounts (each live mount is its own per-host intercept to
 *      S3Gateway);
 *   2. agent only: `connections.internal` (HTTP) → AnalysisConnectionsGateway,
 *      whose props carry the org/workspace scope. Container code cannot change
 *      them, and no token or credential enters the container;
 *   3. a catch-all for HTTP and HTTPS → AnalysisEgress, which forwards HTTPS to
 *      the PyPI hosts (agent only) and answers everything else with 520.
 * Other protocols and ports have no route out at all. That is 0.12's posture
 * (`enableInternet = false`, `allowedHosts` = PyPI + connections.internal,
 * `interceptHttps = true`; the app container sealed with `setAllowedHosts([])`)
 * with two tightenings: PyPI only over HTTPS, and redirects are returned to the
 * container rather than followed by the Worker, so each hop is checked again.
 * The intercepts use at most 5 of the 64 hostname slots.
 *
 * DATA — R2 prefixes of the workspace, mounted when the container starts
 * (sandbox-mounts.ts): exports (`/warehouse/<ws>`, read-only), uploads
 * (`/uploads`, read-only) and outputs (`/outputs`, read-write).
 */
export class AnalysisContainer extends DurableObject<Env> {
  private readonly files: AnalysisContainerDeps["files"] | null;
  private mountsImpl: SandboxBucketMounts | null;
  private setup: Promise<void> | null = null;
  /** What the running container was set up for, once known in this instance. */
  private current: StoredSetup | null = null;

  constructor(ctx: DurableObjectState, env: Env, deps: AnalysisContainerDeps = {}) {
    super(ctx, env);
    const container = ctx.container;
    this.files = deps.files ?? (container ? new Files(container) : null);
    this.mountsImpl = deps.mounts ?? null;
    // The inactivity timeout belongs to the DO instance: a restarted DO (a
    // deploy, an eviction) must set it again or the container stops shortly
    // after the DO goes idle.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(ANALYSIS_IDLE_TIMEOUT_MS));
    }
  }

  /**
   * Makes the container ready for `access`: starts and sets it up if needed,
   * otherwise re-checks its mounts (and refreshes sync mounts). A running
   * container set up for something else, or whose live mount cannot be
   * repaired, is replaced once.
   */
  async prepare(access: AnalysisAccess): Promise<void> {
    this.assertAccess(access);
    const started = await this.ensureStarted(access);
    if (started) return;
    try {
      await this.refreshMounts();
    } catch (error) {
      recordObservabilityEvent(this.env, {
        event: "analysis_container_restart",
        severity: "warn",
        component: "AnalysisContainer",
        operation: "prepare",
        status: "mount_check_failed",
        ...errorToObservabilityFields(error),
        workspaceId: access.workspaceId,
      });
      await this.destroy();
      await this.ensureStarted(access);
    }
  }

  async exec(command: string, options: AnalysisExecOptions): Promise<AnalysisCommandResult> {
    return this.withContainer("exec", () => this.run(command, options));
  }

  async mkdir(path: string): Promise<void> {
    await this.withContainer("mkdir", () => this.requireFiles().mkdir(path, { recursive: true }));
  }

  async writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<void> {
    await this.withContainer("writeFile", async () => {
      const files = this.requireFiles();
      const slash = path.lastIndexOf("/");
      if (slash > 0) await files.mkdir(path.slice(0, slash), { recursive: true });
      await files.writeFile(path, content);
    });
  }

  async openFile(path: string): Promise<AnalysisOpenedFile> {
    return this.withContainer("openFile", async () => {
      const files = this.requireFiles();
      const stat = await files.stat(path);
      if (stat.type !== "file") throw new Error(`${path} is not a regular file`);
      const response = await files.readFile(path);
      if (!response.body) throw new Error(`${path} has no body`);
      return { stream: response.body, size: Number(stat.size) };
    });
  }

  async removePaths(paths: string[]): Promise<void> {
    if (paths.length === 0 || !this.ctx.container?.running) return;
    for (const path of paths) {
      if (!/^\/(projects|scratch)\/[^/]/.test(path) || path.includes("\0") || path.split("/").includes("..")) {
        throw new Error(`Refusing to remove ${path}`);
      }
    }
    await this.run(`rm -rf -- ${paths.map(shellQuote).join(" ")}`, { cwd: "/", timeoutMs: SETUP_TIMEOUT_MS });
  }

  async flushMounts(): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    const setup = this.current ?? await this.readStoredSetup();
    if (!setup) return;
    const mounts = this.mounts();
    if (mounts.kind === "live") return;
    for (const plan of this.mountPlan(setup.access)) {
      if (plan.mount.access !== "read-write" || !setup.mounts.includes(plan.mount.mountPath)) continue;
      await mounts.flush(plan.mount);
    }
  }

  /** Stops the container; the next call starts a fresh one (admin reset, a failed setup). */
  async destroy(): Promise<void> {
    this.setup = null;
    this.current = null;
    await this.ctx.storage.delete(SETUP_KEY);
    const container = this.ctx.container;
    if (container?.running) await container.destroy();
  }

  // -------------------------------------------------------------------------

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The analysis container binding is not configured");
    return container;
  }

  private requireFiles(): NonNullable<AnalysisContainerDeps["files"]> {
    if (!this.files) throw new Error("The analysis container binding is not configured");
    return this.files;
  }

  private mounts(): SandboxBucketMounts {
    this.mountsImpl ??= createSandboxBucketMounts({
      container: this.container,
      files: this.requireFiles(),
      gateway: () => {
        const gateway = (this.ctx.exports as unknown as { S3Gateway?: S3GatewayBinding }).S3Gateway;
        if (!gateway) throw new Error("The Worker must export S3Gateway for R2 bucket mounts");
        return gateway;
      },
      env: this.env,
    });
    return this.mountsImpl;
  }

  /** The container's tenant is its name: refuse access that does not match it. */
  private assertAccess(access: AnalysisAccess): void {
    const name = this.ctx.id.name;
    if (!access.workspaceId || (access.mode === "agent" && !access.orgId)) {
      throw new Error("Analysis access requires a workspace (and, for the agent, an org)");
    }
    if (name !== undefined && name !== analysisContainerName(access)) {
      throw new Error(`Analysis container ${name} cannot serve ${access.mode} access for workspace ${access.workspaceId}`);
    }
  }

  /**
   * Runs `operation` against the prepared container. A failure that leaves the
   * container stopped (out of memory, killed) becomes the user-facing restart
   * message; the next prepare() starts a new container.
   */
  private async withContainer<T>(operation: string, run: () => Promise<T>): Promise<T> {
    // Only prepare() starts a container: one that stopped since took the run's
    // materialized files with it, so the run cannot simply carry on.
    if (!this.ctx.container?.running) {
      throw this.stopped(operation, new Error("The analysis container is not running; call prepare() first"));
    }
    try {
      return await run();
    } catch (error) {
      if (this.ctx.container?.running || SandboxFileError.is(error)) throw error;
      throw this.stopped(operation, error);
    }
  }

  private stopped(operation: string, cause: unknown): Error {
    this.setup = null;
    this.current = null;
    recordObservabilityEvent(this.env, {
      event: "analysis_container_stopped",
      severity: "error",
      component: "AnalysisContainer",
      operation,
      status: "failed",
      ...errorToObservabilityFields(cause),
      workspaceId: this.workspaceId,
    });
    return new Error(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE, { cause });
  }

  /**
   * Starts and sets up the container unless it already serves `access`. True
   * when this call started one. Concurrent callers share one setup: `running`
   * is true as soon as start() returns, so a second caller finds `setup` set.
   */
  private async ensureStarted(access: AnalysisAccess): Promise<boolean> {
    if (this.setup !== null && this.container.running) {
      await this.setup;
      if (this.current && sameAccess(this.current.access, access)) return false;
      await this.destroy();
    }
    let started = false;
    this.setup = this.startContainer(access).then(
      (didStart) => {
        started = didStart;
      },
      (error: unknown) => {
        this.setup = null;
        throw error;
      },
    );
    await this.setup;
    return started;
  }

  /**
   * Starts the container if needed and sets it up. Every step after start()
   * is safe to repeat: a deploy can restart the DO mid-setup, and the setup is
   * recorded only once complete, so a container with an unknown or partial
   * setup is replaced.
   */
  private async startContainer(access: AnalysisAccess): Promise<boolean> {
    const container = this.container;
    const image = container.images[ANALYSIS_IMAGE];
    if (!image) throw new Error(`no such image: ${ANALYSIS_IMAGE} is missing from the container images`);

    if (container.running) {
      // A deploy never replaces a running container: the first call on a new DO
      // instance moves it to the current image. A container this instance
      // cannot vouch for (setup unknown, incomplete or for other access) is
      // replaced too, because its intercepts cannot be changed in place.
      const [info, stored] = await Promise.all([container.inspect(), this.readStoredSetup()]);
      const stale = info !== null && info.image !== "" && info.image !== image;
      if (!stale && stored && sameAccess(stored.access, access)) {
        this.current = stored;
        await container.setInactivityTimeout(ANALYSIS_IDLE_TIMEOUT_MS);
        return false;
      }
      await this.ctx.storage.delete(SETUP_KEY);
      await container.destroy();
    }

    container.start({
      image,
      instance: ANALYSIS_INSTANCE_TYPE,
      enableInternet: false,
    });
    const startedAt = Date.now();
    try {
      await container.setInactivityTimeout(ANALYSIS_IDLE_TIMEOUT_MS);
      const mounts = await this.mountAll(access);
      await this.registerEgress(access);
      await this.trustInterceptCa();
      const setup: StoredSetup = { access, mounts };
      await this.ctx.storage.put(SETUP_KEY, setup);
      this.current = setup;
    } catch (error) {
      recordObservabilityEvent(this.env, {
        event: "analysis_container_start",
        severity: "error",
        component: "AnalysisContainer",
        operation: "startContainer",
        status: "failed",
        durationMs: Date.now() - startedAt,
        ...errorToObservabilityFields(error),
        workspaceId: access.workspaceId,
      });
      await container.destroy().catch(() => {});
      throw error;
    }
    recordObservabilityEvent(this.env, {
      event: "analysis_container_start",
      severity: "info",
      component: "AnalysisContainer",
      operation: "startContainer",
      status: access.mode,
      durationMs: Date.now() - startedAt,
      workspaceId: access.workspaceId,
    });
    return true;
  }

  /** The R2 prefixes `access` gets, in mount order. */
  private mountPlan(access: AnalysisAccess): MountPlan[] {
    const plan: MountPlan[] = [];
    if (this.env.WAREHOUSE_EXPORT_BUCKET) {
      const prefix = warehouseWorkspacePrefix(access.workspaceId);
      // At `/<prefix>`, so an export at R2 key `<prefix>/x` reads at
      // `/<prefix>/x`: the warehouse's `'/' + r2_key` contract.
      plan.push({
        mount: { binding: "WAREHOUSE_EXPORT_BUCKET", keyPrefix: prefix, mountPath: `/${prefix}`, access: "read-only" },
        required: true,
      });
    }
    if (access.mode === "agent" && this.env.R2_BUCKET) {
      const workspacePrefix = getWorkspaceR2Prefix(access.orgId, access.workspaceId);
      plan.push({
        mount: {
          binding: "R2_BUCKET",
          keyPrefix: `${workspacePrefix}/user-uploads`,
          mountPath: ANALYSIS_UPLOADS_MOUNT_PATH,
          access: "read-only",
        },
        required: true,
      });
      // Optional: losing it costs a run its file-delivery path, while failing
      // the setup would take notebook and code execution down entirely.
      plan.push({
        mount: {
          binding: "R2_BUCKET",
          keyPrefix: `${workspacePrefix}/user-outputs`,
          mountPath: ANALYSIS_OUTPUTS_MOUNT_PATH,
          access: "read-write",
        },
        required: false,
      });
    }
    return plan;
  }

  private async mountAll(access: AnalysisAccess): Promise<string[]> {
    const mounts = this.mounts();
    const mounted: string[] = [];
    for (const { mount, required } of this.mountPlan(access)) {
      try {
        await mounts.mount(mount);
        mounted.push(mount.mountPath);
      } catch (error) {
        if (required) throw error;
        console.error(`[AnalysisContainer] ${mount.mountPath} mount failed`, error);
        recordObservabilityEvent(this.env, {
          event: "analysis_mount_failed",
          severity: "error",
          component: "AnalysisContainer",
          operation: "mount",
          path: mount.mountPath,
          ...errorToObservabilityFields(error),
          workspaceId: access.workspaceId,
        });
      }
    }
    return mounted;
  }

  /**
   * Re-checks the mounts of a running container: a live mount is reused, or
   * repaired, and a repair after the catch-all intercept fails (the caller then
   * replaces the container); a sync mount copies what changed in R2.
   */
  private async refreshMounts(): Promise<void> {
    const setup = this.current;
    if (!setup) return;
    const mounts = this.mounts();
    for (const { mount } of this.mountPlan(setup.access)) {
      if (setup.mounts.includes(mount.mountPath)) await mounts.mount(mount);
    }
  }

  private async registerEgress(access: AnalysisAccess): Promise<void> {
    const container = this.container;
    const exports = this.ctx.exports as unknown as {
      AnalysisEgress: (options: { props: AnalysisEgressProps }) => Fetcher;
      AnalysisConnectionsGateway: (options: { props: AnalysisConnectionsParams }) => Fetcher;
    };
    if (access.mode === "agent") {
      await container.interceptOutboundHttp(
        ANALYSIS_CONNECTIONS_HOST,
        exports.AnalysisConnectionsGateway({
          props: { orgId: access.orgId, workspaceId: access.workspaceId },
        }),
      );
    }
    // Registered last: it takes every hostname not intercepted above.
    const egress = exports.AnalysisEgress({ props: { allowPypi: access.mode === "agent" } });
    await container.interceptAllOutboundHttp(egress);
    await container.interceptOutboundHttps("*", egress);
  }

  private async trustInterceptCa(): Promise<void> {
    const child = await this.container.exec(TRUST_INTERCEPT_CA, { cwd: "/", env: { LANG: "C.UTF-8" } });
    const output = await child.output();
    if (output.exitCode !== 0) {
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(`The container did not trust the intercept CA (exit ${output.exitCode})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
    }
  }

  /**
   * `bash -c command` under GNU `timeout`, which signals the whole process
   * group (SIGTERM, then SIGKILL after 5s).
   */
  private async run(command: string, options: AnalysisExecOptions): Promise<AnalysisCommandResult> {
    const timeoutMs = Math.max(1, Math.ceil(options.timeoutMs));
    const argv = [
      "timeout", `--kill-after=${KILL_AFTER_SECONDS}`, `${timeoutMs / 1000}s`,
      "bash", "-c", command,
    ];
    const startedAt = Date.now();
    const child = await this.container.exec(argv, {
      cwd: options.cwd,
      env: { ...ANALYSIS_BASE_ENV, ...options.env },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readTail(child.stdout, ANALYSIS_OUTPUT_CAP_BYTES),
      readTail(child.stderr, ANALYSIS_OUTPUT_CAP_BYTES),
      child.exitCode,
    ]);
    // Exit 124 alone could be the command's own `timeout`; the elapsed time is
    // what says it was ours.
    const timedOut = exitCode === SANDBOX_EXEC_TIMEOUT_EXIT_CODE && Date.now() - startedAt >= timeoutMs;
    return { exitCode, stdout, stderr, timedOut };
  }

  private async readStoredSetup(): Promise<StoredSetup | null> {
    return (await this.ctx.storage.get<StoredSetup>(SETUP_KEY)) ?? null;
  }

  /** The workspace this container serves (`<ws>` or `app-<ws>`), for telemetry. */
  private get workspaceId(): string | null {
    return this.ctx.id.name?.replace(/^app-/, "") ?? null;
  }
}

function sameAccess(a: AnalysisAccess, b: AnalysisAccess): boolean {
  if (a.mode !== b.mode || a.workspaceId !== b.workspaceId) return false;
  return a.mode === "app" || (b.mode === "agent" && a.orgId === b.orgId);
}

/** Decodes a stream, keeping at most its last `cap` bytes. */
async function readTail(stream: ReadableStream<Uint8Array> | null | undefined, cap: number): Promise<string> {
  if (!stream) return "";
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let dropped = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    kept += chunk.byteLength;
    while (kept > cap && chunks.length > 0) {
      const excess = kept - cap;
      const first = chunks[0];
      if (first.byteLength <= excess) {
        chunks.shift();
        kept -= first.byteLength;
        dropped += first.byteLength;
      } else {
        chunks[0] = first.subarray(excess);
        kept -= excess;
        dropped += excess;
      }
    }
  }
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return dropped > 0 ? `[... ${dropped} earlier bytes truncated ...]\n${text}` : text;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Outbound entrypoints (reached through ctx.exports; exported from index.ts)
// ---------------------------------------------------------------------------

export interface AnalysisEgressProps {
  allowPypi: boolean;
}

/** What the catch-all does with a request: forward it, or refuse it. */
export function analysisEgressAllows(url: URL, props: AnalysisEgressProps | undefined): boolean {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  return props?.allowPypi === true && url.protocol === "https:" && ANALYSIS_PYPI_HOSTS.includes(host);
}

/**
 * Every HTTP and HTTPS request the container makes that no hostname intercept
 * took. PyPI over HTTPS is forwarded for the agent container; everything else
 * gets the 520 that 0.12's egress proxy returned for a disallowed origin.
 */
export class AnalysisEgress extends WorkerEntrypoint<Env, AnalysisEgressProps> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!analysisEgressAllows(url, this.ctx.props)) {
      return new Response(`Outbound access to ${url.hostname} is not allowed from the analysis sandbox\n`, {
        status: 520,
      });
    }
    // The container follows redirects itself, so each hop comes back through
    // this check instead of the Worker following one to any host.
    return fetch(new Request(request, { redirect: "manual" }));
  }
}

/** Workspace/org scope the connections gateway serves, fixed when the container starts. */
export interface AnalysisConnectionsParams {
  orgId: string;
  workspaceId: string;
}

/**
 * `http://connections.internal/` from inside an agent container. Identity
 * comes only from the props set DO-side at registration, never from the
 * request.
 */
export class AnalysisConnectionsGateway extends WorkerEntrypoint<Env, AnalysisConnectionsParams> {
  override async fetch(request: Request): Promise<Response> {
    const { orgId, workspaceId } = this.ctx.props ?? ({} as Partial<AnalysisConnectionsParams>);
    if (!orgId || !workspaceId) {
      // Registered without a scope: fail closed rather than guess a tenant.
      return Response.json(
        { ok: false, error: { message: "connections scope not configured for this container" } },
        { status: 401 },
      );
    }
    return handleAuthenticatedConnectionsRpc(request, this.env, { orgId, workspaceId });
  }
}
