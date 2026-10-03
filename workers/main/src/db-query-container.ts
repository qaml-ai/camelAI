import { type Files, type S3GatewayBinding, SandboxFileError, SandboxS3MountError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import { createContainerFiles } from "./container-files.js";
import { DB_QUERY_IDLE_TIMEOUT_MS, DB_QUERY_INSTANCE_TYPE } from "./container-sizing.js";
import {
  ContainerStartFailedError,
  DB_QUERY_START_POLICY,
  LAST_STARTED_IMAGE_KEY,
  recordContainerStartEvent,
  startWithRetry,
} from "./container-start.js";
import {
  DB_QUERY_RUNNER_DIR,
  DB_RELAY_LOCAL_PORT,
  DbQueryContainerUnavailableError,
  type DbQueryContainerStub,
  type DbRelayForwarderConfig,
  type DbRunnerOutput,
} from "./db-query-contracts.js";
import { recordObservabilityEvent } from "./observability.js";
import { createSandboxBucketMounts, type BucketMount, type SandboxBucketMounts } from "./sandbox-mounts.js";
import {
  parseSandboxGenerationName,
  SandboxPlacement,
  type RotationRequest,
  type RotationResult,
  type SandboxPlacementRegistry,
} from "./sandbox-placement.js";
import type { Env } from "./types.js";

/** Key of the db-query image in wrangler `containers[].images`. */
export const DB_QUERY_IMAGE = "db-query";

/**
 * Environment for every command. `exec()` sees none of the image's `ENV` lines
 * (only `PATH`), so callers' variables are added to this per call.
 */
const BASE_ENV: Readonly<Record<string, string>> = {
  HOME: "/root",
  LANG: "C.UTF-8",
};

/** How a start failure names this container to the agent. */
const DB_QUERY_ENVIRONMENT_LABEL = "database query environment";

/** GNU `timeout` sends SIGKILL this long after SIGTERM. */
const KILL_AFTER_SECONDS = 5;

/** Bound for one forwarder readiness probe. */
const PROBE_TIMEOUT_SECONDS = 5;

/** Directory of the relay forwarder process: pid, stdout.log, stderr.log, exit-code. */
export const RELAY_FORWARDER_DIR = "/var/lib/db-query/processes/relay-forwarder";

/**
 * The relay forwarder: `cloudflared access tcp` listening on the local port
 * the runner dials through. The hostname and the Access service token arrive
 * as environment variables, so they are never parsed by a shell or visible in
 * the process's argv.
 */
const RELAY_FORWARDER_COMMAND =
  `exec cloudflared access tcp --hostname "$DB_RELAY_HOSTNAME" --url 127.0.0.1:${DB_RELAY_LOCAL_PORT}`;

/**
 * Starts `$2` (a shell command) as a background process owned by directory
 * `$1`, unless the process that owns it is still starting or running.
 *
 * 1.0 has no startProcess(): this is the documented pattern (setsid, a pid
 * file, an exit-code file). The check and the claim of the directory run under
 * flock, so concurrent callers — including a second Durable Object instance
 * during a deploy — start one process between them. This shell stays as the
 * process's parent to reap it and record its exit code, so a dead process never
 * lingers as a zombie that `/proc` would still list.
 */
const ENSURE_PROCESS_SCRIPT = `dir=$1; command=$2
root=\${dir%/*}
mkdir -p "$root" || exit 1
exec 9>"$root/.lock"
flock 9
if [ -d "$dir" ] && [ ! -e "$dir/exit-code" ]; then
  [ -e "$dir/pid" ] || exit 0
  read -r pid <"$dir/pid"
  grep -qs '^State:[[:space:]]*[^Z]' "/proc/$pid/status" && exit 0
fi
rm -rf "$dir" && mkdir "$dir" || exit 1
flock -u 9
exec 9>&-
setsid bash -c 'echo "$$" >"$0/pid"; exec bash -c "$1"' "$dir" "$command" \\
  >"$dir/stdout.log" 2>"$dir/stderr.log" </dev/null
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

/** Pipes the runner source (DB_RUNNER_SRC) into node; see db-query-service.ts. */
const RUNNER_COMMAND = `printf %s "$DB_RUNNER_SRC" | node --input-type=module`;

export interface DbQueryContainerDeps {
  files?: Pick<Files, "mkdir" | "writeFile" | "readFile" | "rename" | "remove" | "stat">;
  mounts?: SandboxBucketMounts;
}

/**
 * Per-workspace database query container on the native Durable Object
 * container API (`scheduling_policy: "durable_object"`, Sandbox SDK 1.0),
 * bound as DB_QUERY_SANDBOX and reached through getDbQueryContainer()
 * (db-query-contracts.ts), one instance per workspace (`ws-<workspace>`, or
 * `ws-<workspace>-g<N>` after its placement rotated; sandbox-placement.ts).
 *
 * It runs NO user code and holds no state worth keeping: db-query-service.ts
 * ships the runner per call, exports land in R2, and the relay forwarder
 * starts again on demand. Authorization happens worker-side before a query
 * reaches it.
 *
 * Network: `enableInternet: true` and no outbound interception. The runner
 * needs public DNS (to resolve and SSRF-check database hosts) and raw TCP in
 * direct mode. The static-IP guarantee is the runner's: with a relay
 * configured it dials the database through the forwarder (`cloudflared access
 * tcp` → tunnel → gost on the static-IP VM), whose WebSocket goes to the relay
 * host directly. The 0.12 class also routed HTTP(S) through an allowlist of
 * the relay host, a leftover of its internet-off first version; with raw TCP
 * open to every host and port that list bounded nothing, and it put the
 * forwarder's WebSocket through the Worker. The export mount (S3Mount) has
 * its own host-scoped intercept and needs no CA in the container.
 */
export class DbQueryContainer extends DurableObject<Env> implements DbQueryContainerStub, SandboxPlacementRegistry {
  private readonly files: DbQueryContainerDeps["files"] | null;
  private readonly placement: SandboxPlacement;
  private mountsImpl: SandboxBucketMounts | null;
  private setup: Promise<void> | null = null;
  /** A start (with its retry) is in flight: callers join it, even while it destroys between attempts. */
  private starting = false;

  constructor(ctx: DurableObjectState, env: Env, deps: DbQueryContainerDeps = {}) {
    super(ctx, env);
    const container = ctx.container;
    this.files = deps.files ?? (container ? createContainerFiles(container, env) : null);
    this.mountsImpl = deps.mounts ?? null;
    this.placement = new SandboxPlacement({
      storage: ctx.storage,
      name: ctx.id.name,
      component: "DbQueryContainer",
      env,
      registry: (base) => {
        if (!env.DB_QUERY_SANDBOX) throw new Error("DB_QUERY_SANDBOX container binding is not configured");
        return env.DB_QUERY_SANDBOX.getByName(base) as unknown as SandboxPlacementRegistry;
      },
      scope: () => ({ workspaceId: this.workspaceId }),
    });
    // The inactivity timeout belongs to the DO instance: a restarted DO (a
    // deploy, an eviction) must set it again or the container stops shortly
    // after the DO goes idle.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        await container.setInactivityTimeout(DB_QUERY_IDLE_TIMEOUT_MS);
      });
    }
  }

  /**
   * Starts the container and waits until it runs commands. A cold start is
   * bounded and retried once in here (container-start.ts), and every caller
   * waiting on it gets the retried container. Callers also put a client-side
   * backstop around this, so the relay/mount setup deadlines that follow are
   * not spent on a cold start.
   */
  async start(): Promise<void> {
    await this.withContainer("start", async () => {});
  }

  /**
   * Starts the relay forwarder unless it is already starting or running (so a
   * call per query is cheap and never starts a second copy), or starts it again
   * after it exited. It does not keep the container alive (the inactivity
   * timeout does), and it stops with the container; the next query starts it.
   */
  async startRelayForwarder(relay: DbRelayForwarderConfig): Promise<void> {
    const env: Record<string, string> = { ...BASE_ENV, DB_RELAY_HOSTNAME: relay.hostname };
    if (relay.accessClientId && relay.accessClientSecret) {
      // cloudflared reads the Access service token from these.
      env.TUNNEL_SERVICE_TOKEN_ID = relay.accessClientId;
      env.TUNNEL_SERVICE_TOKEN_SECRET = relay.accessClientSecret;
    }
    await this.withContainer("startRelayForwarder", async () => {
      const launcher = await this.container.exec(
        ["bash", "-c", ENSURE_PROCESS_SCRIPT, "ensure-process", RELAY_FORWARDER_DIR, RELAY_FORWARDER_COMMAND],
        { cwd: "/", env, stdout: "ignore", stderr: "ignore" },
      );
      // The launcher lives as long as the forwarder; nobody waits for it. A
      // container that stops under it must not surface as an unhandled rejection.
      launcher.exitCode.catch(() => {});
    });
  }

  /** Whether the forwarder's local port accepts connections. */
  async relayForwarderReady(): Promise<boolean> {
    return this.withContainer("relayForwarderReady", async () => {
      const probe = await this.container.exec(
        [
          "timeout", `${PROBE_TIMEOUT_SECONDS}s`,
          "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${DB_RELAY_LOCAL_PORT}`,
        ],
        { cwd: "/", env: { ...BASE_ENV }, stdout: "ignore", stderr: "ignore" },
      );
      return (await probe.exitCode) === 0;
    });
  }

  /**
   * Runs the runner once: its source (DB_RUNNER_SRC) piped into node from the
   * drivers directory, under GNU `timeout`, which signals the whole process
   * group (SIGTERM, then SIGKILL 5s later). `timedOut` says the bound fired.
   */
  async runRunner(env: Record<string, string>, timeoutMs: number): Promise<DbRunnerOutput> {
    const boundMs = Math.max(1, Math.ceil(timeoutMs));
    return this.withContainer("runRunner", async () => {
      const startedAt = Date.now();
      const child = await this.container.exec(
        ["timeout", `--kill-after=${KILL_AFTER_SECONDS}`, `${boundMs / 1000}s`, "bash", "-c", RUNNER_COMMAND],
        { cwd: DB_QUERY_RUNNER_DIR, env: { ...BASE_ENV, ...env } },
      );
      const output = await child.output();
      const decoder = new TextDecoder();
      return {
        exitCode: output.exitCode,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        // 124 (TERM) or 137 (KILL after the grace), only once the bound passed.
        timedOut: (output.exitCode === 124 || output.exitCode === 137) && Date.now() - startedAt >= boundMs,
      };
    });
  }

  /**
   * Makes the workspace's warehouse prefix writable at `/<prefix>`, so an
   * export written at `/<r2Key>` lands at R2 key `<r2Key>`: a write-only mount
   * of the export bucket (sandbox-mounts.ts). Safe to call before every export:
   * an existing mount is reused.
   */
  async prepareWarehouseExport(prefix: string): Promise<void> {
    await this.withContainer("prepareWarehouseExport", () => this.mounts().mount(exportMount(prefix)));
  }

  /**
   * Called after the export runner succeeded. On Cloudflare the file is
   * already in R2 (s3fs uploads it on close); on self-host this moves it from
   * the container into the bucket.
   */
  async publishWarehouseExport(prefix: string, exportPath: string): Promise<void> {
    const mount = exportMount(prefix);
    const key = exportPath.replace(/^\/+/, "");
    if (!key.startsWith(`${prefix}/`) || key.split("/").includes("..")) {
      throw new Error(`export path "${exportPath}" is outside the warehouse prefix "${prefix}/"`);
    }
    await this.mounts().flush(mount);
  }

  /**
   * Stops the container; the next call starts a fresh one. `reason` (a setup
   * step that outlived its deadline, from db-query-service.ts) is recorded.
   * There is no cooldown: in prod a fresh container after a stuck one served
   * queries within seconds.
   */
  async destroy(reason?: { operation: string; error?: string }): Promise<{ destroyed: boolean }> {
    try {
      await this.placement.assertCurrent();
    } catch (relocated) {
      // A retired generation: let go of anything left here, then send the
      // caller on to the current one.
      if (this.ctx.container?.running) await this.ctx.container.destroy().catch(() => {});
      throw relocated;
    }
    this.setup = null;
    this.starting = false;
    const container = this.ctx.container;
    const destroyed = container?.running === true;
    if (destroyed) await container.destroy();
    if (reason) {
      recordObservabilityEvent(this.env, {
        event: "db_query_container_destroyed",
        severity: "warn",
        component: "DbQueryContainer",
        operation: reason.operation,
        status: destroyed ? "destroyed" : "not_running",
        errorMessage: reason.error?.slice(0, 500) ?? null,
        workspaceId: this.workspaceId,
      });
    }
    return { destroyed };
  }

  /** Generation 0 only: moves this sandbox to a new DO (sandbox-placement.ts). */
  async rotateSandboxPlacement(request: RotationRequest): Promise<RotationResult> {
    return this.placement.rotate(request);
  }

  // -------------------------------------------------------------------------

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("The db-query container binding is not configured");
    return container;
  }

  private mounts(): SandboxBucketMounts {
    this.mountsImpl ??= createSandboxBucketMounts({
      container: this.container,
      files: this.requireFiles(),
      gateway: () => {
        const gateway = (this.ctx.exports as unknown as { S3Gateway?: S3GatewayBinding }).S3Gateway;
        if (!gateway) throw new Error("The Worker must export S3Gateway for the warehouse export mount");
        return gateway;
      },
      env: this.env,
    });
    return this.mountsImpl;
  }

  private requireFiles(): NonNullable<DbQueryContainerDeps["files"]> {
    if (!this.files) throw new Error("The db-query container binding is not configured");
    return this.files;
  }

  /** `ws-<workspace>[-g<N>]` (data-proxy.ts), for telemetry. */
  private get workspaceId(): string | null {
    const name = this.ctx.id.name;
    const base = name ? parseSandboxGenerationName(name).base : null;
    return base?.startsWith("ws-") ? base.slice("ws-".length) : null;
  }

  /**
   * Run `operation` against a started container. A failure that leaves the
   * container stopped (it failed to start, or died under the call) is a
   * DbQueryContainerUnavailableError, which db-query-service.ts retries once;
   * the next call starts a new container.
   */
  private async withContainer<T>(operation: string, run: () => Promise<T>): Promise<T> {
    // A retired generation does nothing: the caller re-sends to the current one.
    await this.placement.assertCurrent();
    try {
      await this.ensureRunning();
      return await run();
    } catch (error) {
      // A start that failed after its retry already says so in plain words,
      // and the caller must not retry it again: that would double the wait.
      if (ContainerStartFailedError.is(error)) throw error;
      if (this.ctx.container?.running || SandboxFileError.is(error) || SandboxS3MountError.is(error)) {
        throw error;
      }
      this.setup = null;
      throw new DbQueryContainerUnavailableError(operation, error);
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.setup !== null && (this.starting || this.container.running)) return this.setup;
    this.starting = true;
    const setup: Promise<void> = this.startContainer().then(
      () => {
        if (this.setup === setup) this.starting = false;
      },
      (error: unknown) => {
        if (this.setup === setup) {
          this.setup = null;
          this.starting = false;
        }
        throw error;
      },
    );
    this.setup = setup;
    return setup;
  }

  /**
   * Starts the container if needed and (re)applies the inactivity timeout.
   * Runs once per DO instance, or again after the container stopped. Every step
   * after start() is safe to repeat: a deploy can restart the DO mid-setup.
   *
   * A cold start runs under DB_QUERY_START_POLICY: start, then a `true` probe
   * (the first command blocks until the container runs). A stuck or failed
   * attempt is destroyed and retried once; see container-start.ts.
   */
  private async startContainer(): Promise<void> {
    const container = this.container;
    const image = container.images[DB_QUERY_IMAGE];
    if (!image) {
      throw new ContainerStartFailedError({
        label: DB_QUERY_ENVIRONMENT_LABEL,
        attempts: 0,
        waitedMs: 0,
        permanent: true,
        cause: new Error(`no such image: ${DB_QUERY_IMAGE} is missing from the container images`),
      });
    }

    if (container.running) {
      // A deploy never replaces a running container. The first call on a new DO
      // instance moves it to the current image; in-flight commands from the
      // previous instance ended with that instance.
      const info = await container.inspect();
      if (info && info.image !== "" && info.image !== image) {
        await container.destroy();
        recordObservabilityEvent(this.env, {
          event: "db_query_container_image_replaced",
          severity: "info",
          component: "DbQueryContainer",
          operation: "startContainer",
          workspaceId: this.workspaceId,
        });
      }
    }

    if (container.running) {
      try {
        await container.setInactivityTimeout(DB_QUERY_IDLE_TIMEOUT_MS);
      } catch (error) {
        await container.destroy();
        throw error;
      }
      return;
    }

    const freshImage = (await this.ctx.storage.get<string>(LAST_STARTED_IMAGE_KEY)) !== image;
    // Two whole failed starts in a row move the sandbox to a new DO.
    await this.placement.trackStart(() => startWithRetry({
      policy: DB_QUERY_START_POLICY,
      label: DB_QUERY_ENVIRONMENT_LABEL,
      freshImage,
      attempt: async (signal) => {
        container.start({
          image,
          instance: DB_QUERY_INSTANCE_TYPE,
          // Public DNS and raw TCP to databases; see the class doc.
          enableInternet: true,
        });
        recordObservabilityEvent(this.env, {
          event: "db_query_container_start",
          severity: "info",
          component: "DbQueryContainer",
          operation: "startContainer",
          workspaceId: this.workspaceId,
        });
        await container.setInactivityTimeout(DB_QUERY_IDLE_TIMEOUT_MS);
        signal.throwIfAborted();
        const probe = await container.exec(["true"], {
          cwd: "/",
          env: { ...BASE_ENV },
          stdout: "ignore",
          stderr: "ignore",
          signal,
        });
        const exitCode = await probe.exitCode;
        if (exitCode !== 0) throw new Error(`the readiness probe exited ${exitCode}`);
      },
      reset: async () => {
        if (container.running) await container.destroy();
      },
      onEvent: (event) =>
        recordContainerStartEvent(this.env, event, { component: "DbQueryContainer", workspaceId: this.workspaceId }),
    }), async () => {
      if (container.running) await container.destroy();
    });
    await this.ctx.storage.put(LAST_STARTED_IMAGE_KEY, image);
  }
}

/** The workspace's export prefix of WAREHOUSE_EXPORT_BUCKET, at `/<prefix>`. */
function exportMount(prefix: string): BucketMount {
  assertWarehousePrefix(prefix);
  return { binding: "WAREHOUSE_EXPORT_BUCKET", keyPrefix: prefix, mountPath: `/${prefix}`, access: "write-only" };
}

function assertWarehousePrefix(prefix: string): void {
  if (!prefix || prefix.startsWith("/") || prefix.endsWith("/") || prefix.split("/").includes("..")) {
    throw new Error(`Invalid warehouse export prefix: ${prefix}`);
  }
}
