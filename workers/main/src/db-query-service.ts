/**
 * Worker-side orchestration for DbQuerySandbox — the static-IP database query
 * path (docs/db-egress-relay.md).
 *
 * The query logic is NOT baked into the container image. It lives in
 * `db-query-sandbox-assets/runner/db-query-runner.mjs`, is embedded into this
 * worker as a string (below), and is run in the container per call by piping
 * that string into `node` over stdin in a single stateless `exec` (no file is
 * written). Changing how we query is therefore a worker-only change — no image
 * rebuild. The image only carries the runtime (node), the drivers
 * (pg/mysql2/socks at /opt/db-query-runner/node_modules), and cloudflared.
 *
 * Callers are responsible for AUTHORIZATION: by the time runDbQuery is
 * invoked, the caller must already have decided this principal may query this
 * database. Callers: the legacy data-proxy compat surface (data-proxy.ts —
 * connection MCP, the DATA_PROXY user-app binding, sandbox container routes)
 * and the admin smoke route (POST /api/admin/db-query-sandbox/query).
 */

// Embedded at build time; the Vite and Wrangler builds alias this virtual
// module to the runner source using their respective raw-text mechanisms.
import RUNNER_SOURCE from "virtual:db-query-runner-source";
import {
  createSandboxExecDeadline,
  isSandboxDeadlineExceededError,
  SANDBOX_EXEC_DEADLINE_GRACE_MS,
  SandboxDeadlineExceededError,
  type SandboxDeadlineExceededEvent,
  type SandboxExecDeadline,
} from "./sandbox-exec-deadline.js";

/**
 * Directory holding the baked drivers. `node` runs with this as its cwd so the
 * runner's bare `import "pg"` (fed over stdin) resolves against the baked
 * node_modules by normal ESM directory walking — NODE_PATH is not consulted
 * for ESM, and stdin modules resolve bare specifiers relative to cwd.
 */
export const DB_QUERY_RUNNER_DIR = "/opt/db-query-runner";

/** Local port the container's `cloudflared access tcp` forwarder listens on. */
export const DB_RELAY_LOCAL_PORT = 11080;

/** cloudflared forwarder command + stable process id (started once, reused). */
export const DB_RELAY_FORWARDER_PROCESS_ID = "cf-access-tcp";

/**
 * `getSandbox()` options for every worker-side DbQuerySandbox stub.
 *
 * `enableDefaultSession: false` is load-bearing. By default the Sandbox SDK
 * runs every `exec` in ONE persistent shell session per sandbox, and the
 * container runs that session's commands one at a time. The sandbox is shared
 * by a whole workspace, so one slow query or a 5-minute export queued every
 * other query, readiness probe and export behind it. Prod saw a 1-second
 * `/dev/tcp` probe wait 160s behind an export, blow the 45s setup deadline, and
 * the wedge self-heal then destroy a healthy, busy container.
 *
 * Nothing here needs shell state: the runner is one stateless exec with an
 * explicit cwd and env, and the probe is a one-shot. Sessionless execs are
 * independent processes, so a workspace's calls run concurrently. The DO's own
 * internal execs (the export mount) still use the default session.
 */
export const DB_QUERY_SANDBOX_OPTIONS = {
  normalizeId: true,
  enableDefaultSession: false,
} as const;

/** Relay coordinates + credentials, from worker env (never baked in images). */
export interface DbEgressRelayConfig {
  hostname: string;
  socksUsername: string;
  socksPassword: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface DbEgressRelayEnv {
  DB_EGRESS_RELAY_HOSTNAME?: string;
  DB_EGRESS_RELAY_SOCKS_USERNAME?: string;
  DB_EGRESS_RELAY_SOCKS_PASSWORD?: string;
  DB_EGRESS_RELAY_ACCESS_CLIENT_ID?: string;
  DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET?: string;
}

/**
 * Relay config for this environment, or null for direct mode.
 *
 * Only a FULLY-unset relay is direct mode. A PARTIAL config (e.g. hostname set
 * but a SOCKS secret missing after a typo/rollout slip) throws instead of
 * silently degrading: `DbQuerySandbox` keys `enableInternet` off the hostname
 * alone, so a partial config would leave egress locked to relay posture while
 * `runDbQuery` skipped the forwarder — every query would then fail as an opaque
 * network error instead of an obvious config error.
 */
export function relayConfigFromEnv(env: DbEgressRelayEnv): DbEgressRelayConfig | null {
  const hostname = env.DB_EGRESS_RELAY_HOSTNAME?.trim();
  const socksUsername = env.DB_EGRESS_RELAY_SOCKS_USERNAME;
  const socksPassword = env.DB_EGRESS_RELAY_SOCKS_PASSWORD;

  if (!hostname) {
    if (socksUsername || socksPassword) {
      throw Object.assign(
        new Error(
          "DB egress relay SOCKS credentials are set but DB_EGRESS_RELAY_HOSTNAME is missing (partial relay config)",
        ),
        { status: 500 },
      );
    }
    return null; // fully unset → direct mode
  }
  if (!socksUsername || !socksPassword) {
    throw Object.assign(
      new Error(
        "DB_EGRESS_RELAY_HOSTNAME is set but DB_EGRESS_RELAY_SOCKS_USERNAME/PASSWORD are missing (partial relay config)",
      ),
      { status: 500 },
    );
  }
  // The Access service token is a pair: both or neither. Exactly one set (a
  // typo/rollout slip) would otherwise start `cloudflared access tcp` WITHOUT
  // the token, and the Access-gated hostname would reject every connection —
  // surfacing only as a forwarder-readiness timeout, not a config error.
  const accessClientId = env.DB_EGRESS_RELAY_ACCESS_CLIENT_ID?.trim() || undefined;
  const accessClientSecret = env.DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET?.trim() || undefined;
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw Object.assign(
      new Error(
        "DB_EGRESS_RELAY_ACCESS_CLIENT_ID and DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET must be set together (partial relay config)",
      ),
      { status: 500 },
    );
  }
  return { hostname, socksUsername, socksPassword, accessClientId, accessClientSecret };
}

export interface DbQueryTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  /** May be empty ONLY for mysql (Go data-proxy parity). */
  database: string;
  /**
   * default "require"; "verify-full" enables CA + hostname verification,
   * "verify-ca" chain-only, "prefer" (mysql) tries TLS then falls back to
   * plaintext when the server lacks it.
   */
  sslMode?: "disable" | "require" | "verify-ca" | "verify-full" | "prefer";
  /** mysql only; identifier, e.g. "utf8mb4" (the driver default). */
  charset?: string;
}

export interface DbQueryRequest {
  /** "query" (default): point query over exec; "export": streaming Parquet extract. */
  op?: "query" | "export";
  engine: "postgres" | "mysql" | "mssql";
  /** "read" (default) runs in a rolled-back transaction; "modify" returns rowsAffected. */
  mode?: "read" | "modify";
  target: DbQueryTarget;
  sql: string;
  /** Positional array for postgres/mysql; named record for mssql. */
  params?: unknown[] | Record<string, unknown>;
  /** null = uncapped rows (the byte cap still bounds the response). */
  rowLimit?: number | null;
  timeoutMs?: number;
  /** Serialized-result size cap for op "query" (default 8 MiB in the runner). */
  maxResponseBytes?: number;
}

export type DbQueryResult =
  | {
      ok: true;
      rows: Record<string, unknown>[];
      fields: { name: string }[];
      rowCount: number;
      truncated: boolean;
      durationMs: number;
      /** Present for mode "modify". */
      rowsAffected?: number[];
    }
  | { ok: false; error: { message: string; code?: string; number?: number; status?: number } };

interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The slice of the DbQuerySandbox stub this module uses (test seam). */
export interface DbQuerySandboxStub {
  ensureReady(): Promise<void>;
  ensureRelayEgress(relayHostname: string): Promise<void>;
  ensureWarehouseExportMount(prefix: string): Promise<void>;
  startProcess(
    command: string,
    options?: { processId?: string; env?: Record<string, string | undefined> },
  ): Promise<unknown>;
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
  ): Promise<SandboxExecResult>;
  /**
   * Wedged-container self-heal (DbQuerySandbox.restartWedgedContainer):
   * bounded destroy, rate-limited DO-side. Optional so test fakes and older
   * stubs without it keep working.
   */
  restartWedgedContainer?(request: {
    operation: string;
    error?: string;
  }): Promise<{ restarted: boolean; reason: string } | undefined>;
}

export interface DbQueryDeps {
  sandbox: DbQuerySandboxStub;
  /**
   * Telemetry sink for a query we abandoned on its client-side deadline. The
   * caller owns the observability env, so it supplies the recorder.
   */
  onDeadlineExceeded?: (event: SandboxDeadlineExceededEvent) => void;
  /**
   * Static-IP egress relay, or null to dial the database DIRECTLY from the
   * container's own Cloudflare IP (the opt-out when no relay is configured).
   */
  relay: DbEgressRelayConfig | null;
  /** Max ms to wait for the cloudflared forwarder to come up (default 30s). */
  readinessTimeoutMs?: number;
  /**
   * Telemetry sink for a call retried after a transient sandbox failure
   * (see isTransientDbSandboxError). The error is the one we retried past.
   */
  onTransientRetry?: (event: { operation: "db_query" | "db_export"; dispatched: boolean; error: unknown }) => void;
  /** Test seam for the pause before the transient retry. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Failures of the sandbox/DO transport itself, as opposed to the database or
 * the SQL: the container was stopped under the call (a worker version rollout
 * signals every container to exit), or the RPC hop to the DO dropped. Prod saw
 * "The container is not running, consider calling start()" right after a
 * rollout and "Network connection lost." 142ms into a call; the next call
 * worked both times.
 *
 * Deliberately excludes SandboxDeadlineExceededError: a deadline means the
 * container is slow or wedged, and a retry would double the wait.
 */
const TRANSIENT_SANDBOX_ERROR_PATTERNS: readonly RegExp[] = [
  /container is not running/i,
  /network connection lost/i,
  /signalled the container to exit/i,
  /container crashed/i,
  /durable object (?:reset|storage operation exceeded)|durable object's code has been updated/i,
  // sandbox-sdk#928: on the rpc transport a refused container start disposes
  // the client, and the first call fails ~1s in with this text.
  /disposing the main stub/i,
];

/**
 * Typed transients from @cloudflare/sandbox 0.12.x, all documented as
 * retryable. Matched by name because the class does not survive the DO RPC hop.
 */
const TRANSIENT_SANDBOX_ERROR_NAMES: readonly string[] = [
  "ContainerUnavailableError",
  "OperationInterruptedError",
  "RPCTransportError",
];

export function isTransientDbSandboxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isSandboxDeadlineExceededError(error)) return false;
  if (TRANSIENT_SANDBOX_ERROR_NAMES.includes(error.name)) return true;
  const text = `${error.name}: ${error.message}`;
  return TRANSIENT_SANDBOX_ERROR_PATTERNS.some((pattern) => pattern.test(text)) ||
    TRANSIENT_SANDBOX_ERROR_NAMES.some((name) => text.includes(name));
}

/** Pause before the one transient retry, so a rolling container can come back. */
export const DB_QUERY_TRANSIENT_RETRY_DELAY_MS = 1_000;

/**
 * Run `attempt` and, on a transient sandbox failure, run it exactly once more.
 *
 * `attempt` calls `markDispatched()` right before it hands the SQL to the
 * container. Before that point nothing has touched the database and a retry
 * is always safe. After it, only a caller that can safely run the work twice
 * (a read, which the runner rolls back) may retry: a `modify` statement may
 * already have committed.
 */
async function withTransientRetry<T>(
  deps: DbQueryDeps,
  operation: "db_query" | "db_export",
  retryAfterDispatch: boolean,
  attempt: (markDispatched: () => void) => Promise<T>,
): Promise<T> {
  let dispatched = false;
  try {
    return await attempt(() => {
      dispatched = true;
    });
  } catch (error) {
    if (!isTransientDbSandboxError(error) || (dispatched && !retryAfterDispatch)) throw error;
    console.warn("[db-query] retrying after a transient sandbox failure", {
      operation,
      dispatched,
      error: error instanceof Error ? error.message : String(error),
    });
    deps.onTransientRetry?.({ operation, dispatched, error });
    await (deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
      DB_QUERY_TRANSIENT_RETRY_DELAY_MS,
    );
    return await attempt(() => {});
  }
}

const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_INTERVAL_MS = 500;
/** Extra wall-clock beyond the query timeout for node start + driver import + connect. */
const EXEC_OVERHEAD_MS = 15_000;
/** Runner-side default when the caller declares no timeout. */
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 300_000;
/** Matches the Sandbox SDK's 30s allocation + 90s port-readiness ceiling. */
const DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS = 120_000;

/**
 * Client-side deadline for one runner exec.
 *
 * The container already enforces `timeout` on the command, and that stays the
 * primary bound (it produces the runner's own error). This only stops the AWAIT
 * from outliving it: a container that never answers used to hold the caller —
 * an agent turn, an admin request, a scheduled export — indefinitely. The
 * budget is the container timeout (which already carries this op's overhead)
 * plus the marshalling grace.
 */
function dbQueryDeadline(
  deps: DbQueryDeps,
  operation: "db_query" | "db_export",
  containerTimeoutMs: number,
): SandboxExecDeadline {
  return createSandboxExecDeadline({
    operation,
    declaredTimeoutMs: containerTimeoutMs,
    defaultTimeoutMs: containerTimeoutMs,
    maxTimeoutMs: containerTimeoutMs,
    graceMs: SANDBOX_EXEC_DEADLINE_GRACE_MS,
    onExceeded: (event) => deps.onDeadlineExceeded?.(event),
  });
}

/**
 * Client-side deadline for the whole relay/mount PRELUDE of one call.
 *
 * The prelude's own awaits used to be unbounded: `forwarderReady`'s 5s
 * `timeout` is enforced CONTAINER-side only (the SDK's http transport issues
 * `containerFetch` with no AbortSignal), and the poll loop's
 * `Date.now() >= deadline` check only runs AFTER a probe settles — so a wedged
 * container that never answers meant the check was never reached and
 * `runDbQuery` hung until the caller's own ceiling (a 20-minute agent turn).
 *
 * One deadline covers every prelude await, and `SandboxExecDeadline` shares its
 * budget across `run` calls, so the poll loop cannot multiply the wait.
 */
function dbQuerySetupDeadline(deps: DbQueryDeps, operation: string): SandboxExecDeadline {
  const readinessMs = deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  return createSandboxExecDeadline({
    operation,
    declaredTimeoutMs: readinessMs,
    defaultTimeoutMs: readinessMs,
    maxTimeoutMs: readinessMs,
    graceMs: SANDBOX_EXEC_DEADLINE_GRACE_MS,
    onExceeded: (event) => deps.onDeadlineExceeded?.(event),
  });
}

/**
 * Cold container provisioning has its own SDK-bounded 120s budget. Keep it
 * outside the warm relay/mount setup deadline: otherwise a healthy cold start
 * can consume the entire 45s client-side setup budget before the first probe.
 */
async function ensureDbQuerySandboxReady(deps: DbQueryDeps): Promise<void> {
  await createSandboxExecDeadline({
    operation: "db_query_container_start",
    declaredTimeoutMs: DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS,
    defaultTimeoutMs: DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS,
    maxTimeoutMs: DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS,
    graceMs: SANDBOX_EXEC_DEADLINE_GRACE_MS,
    onExceeded: (event) => deps.onDeadlineExceeded?.(event),
  }).run(() => deps.sandbox.ensureReady());

  const relay = deps.relay;
  if (!relay) return;
  // setAllowedHosts is a container control-plane call of its own. On a newly
  // provisioned or resource-constrained container it can legitimately take
  // longer than forwarder readiness; don't charge that work to the 45s probe
  // budget below.
  await createSandboxExecDeadline({
    operation: "db_query_relay_egress",
    declaredTimeoutMs: DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS,
    defaultTimeoutMs: DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS,
    maxTimeoutMs: DB_QUERY_CONTAINER_STARTUP_TIMEOUT_MS,
    graceMs: SANDBOX_EXEC_DEADLINE_GRACE_MS,
    onExceeded: (event) => deps.onDeadlineExceeded?.(event),
  }).run(() => deps.sandbox.ensureRelayEgress(relay.hostname));
}

/** Probe whether the cloudflared forwarder's local port is accepting yet. */
async function forwarderReady(deps: DbQueryDeps, setup: SandboxExecDeadline): Promise<boolean> {
  const probe = await setup.run(() => deps.sandbox.exec(
    `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${DB_RELAY_LOCAL_PORT}' 2>/dev/null && echo up || echo down`,
    { timeout: 5_000 },
  ));
  return probe.stdout.trim() === "up";
}

/**
 * Make sure the container's `cloudflared access tcp` forwarder is running and
 * its local port is accepting. Idempotent: startProcess uses a stable id, so a
 * second attempt on a warm container is a no-op collision we swallow. Relay
 * credentials travel via process env — never image contents.
 *
 * Two bounds, deliberately both: `setup` stops probes that never ANSWER, and
 * the wall-clock check below stops probes that answer but keep saying "down"
 * (the more useful diagnostic, so it keeps its message).
 */
async function ensureRelayForwarder(
  deps: DbQueryDeps,
  relay: DbEgressRelayConfig,
  setup: SandboxExecDeadline,
): Promise<void> {
  const deadline = Date.now() + (deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  if (await forwarderReady(deps, setup)) return;

  try {
    await setup.run(() => deps.sandbox.startProcess(
      `cloudflared access tcp --hostname ${relay.hostname} --url 127.0.0.1:${DB_RELAY_LOCAL_PORT}` +
        (relay.accessClientId && relay.accessClientSecret
          ? ` --service-token-id ${relay.accessClientId} --service-token-secret ${relay.accessClientSecret}`
          : ""),
      { processId: DB_RELAY_FORWARDER_PROCESS_ID },
    ));
  } catch (error) {
    // A concurrent caller likely started it first (stable processId → name
    // collision, not a second forwarder). Readiness polling below is the real
    // gate — but a spent setup budget is terminal, not a collision.
    if (isSandboxDeadlineExceededError(error)) throw error;
  }

  while (!(await forwarderReady(deps, setup))) {
    if (Date.now() >= deadline) {
      throw new Error(
        "db-query relay forwarder never became ready (check the relay hostname, Access service token, and that the egress allowlist admits the relay host)",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
  }
}

/**
 * Run the SETUP half of a call (container start, relay egress, forwarder
 * prelude) and, when any of it outlives its client-side deadline, ask the DO
 * to destroy the container so the NEXT call boots clean.
 *
 * Without this a wedged container never self-healed: prod saw one workspace
 * fail `db_query_container_start` at its 135s budget on every query for four
 * days (403 in a row) until a manual `destroy()` fixed it instantly.
 *
 * Deliberately narrow: only SandboxDeadlineExceededError from setup. The
 * runner exec's own deadline is a slow QUERY, the forwarder's "never became
 * ready" (probes answer, port stays down) is relay configuration, and the
 * export mount has its own in-place recovery (mountOrRecover) — none of those
 * is fixed by destroying a container other calls may be using. The call still
 * fails, as a DbQuerySandboxNotReadyError that tells the agent nothing ran, and
 * there is no in-call retry: the caller has already spent a setup budget of up
 * to 135s, and a second cold start inside the same call would double that.
 */
async function withWedgedSetupRecovery(deps: DbQueryDeps, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    // These deadlines are created in this module, so the error is always the
    // local class (never the name-only RPC shape isSandboxDeadlineExceededError
    // also accepts).
    if (error instanceof SandboxDeadlineExceededError) {
      const restarted = await requestWedgedContainerRestart(deps, error);
      throw new DbQuerySandboxNotReadyError(error, restarted);
    }
    throw error;
  }
}

/**
 * A setup deadline, reworded for the agent. The generic
 * SandboxDeadlineExceededError text says the work "may already have run" and
 * not to repeat it, which is wrong here: setup finished before the SQL was
 * handed to the container, so nothing reached the database and a retry is safe.
 */
export class DbQuerySandboxNotReadyError extends Error {
  readonly operation: string;
  readonly budgetMs: number;

  constructor(cause: SandboxDeadlineExceededError, restarted: boolean) {
    super(
      `The database query sandbox did not become ready: ${cause.operation} did not return within ` +
        `its ${Math.round(cause.budgetMs / 1000)}s budget, so the query was NOT sent to the database. This is a temporary ` +
        `infrastructure problem, not a problem with the SQL or the database. ` +
        (restarted ? "The sandbox has been restarted; " : "") +
        `retrying the same query is safe.`,
      { cause },
    );
    this.name = "DbQuerySandboxNotReadyError";
    this.operation = cause.operation;
    this.budgetMs = cause.budgetMs;
  }
}

/**
 * Best-effort: a failed heal request must never mask the deadline error.
 * Resolves true only when the DO actually restarted the container.
 */
async function requestWedgedContainerRestart(
  deps: DbQueryDeps,
  error: SandboxDeadlineExceededError,
): Promise<boolean> {
  if (typeof deps.sandbox.restartWedgedContainer !== "function") return false;
  try {
    // The DO records `sandbox_zombie_restart` (component DbQuerySandbox,
    // trigger setup_deadline) itself; nothing to emit on this side.
    const outcome = await deps.sandbox.restartWedgedContainer({
      operation: error.operation,
      error: `${error.name}: ${error.message}`,
    });
    return outcome?.restarted === true;
  } catch (restartError) {
    console.warn("[db-query] wedged container restart request failed", {
      operation: error.operation,
      error: restartError instanceof Error ? restartError.message : String(restartError),
    });
    return false;
  }
}

/** Relay forwarder readiness, deadline-bounded after startup/egress setup. */
async function ensureRelayPrelude(deps: DbQueryDeps, setup: SandboxExecDeadline): Promise<void> {
  const relay = deps.relay;
  if (!relay) return;
  await ensureRelayForwarder(deps, relay, setup);
}

function parseRunnerOutput(exec: SandboxExecResult): DbQueryResult {
  const text = exec.stdout.trim();
  if (!text) {
    return {
      ok: false,
      error: {
        message: `runner produced no output (exit ${exec.exitCode})${exec.stderr ? `: ${exec.stderr.trim().slice(0, 500)}` : ""}`,
        status: 502,
      },
    };
  }
  let parsed: DbQueryResult & { error?: { message?: string; code?: string; number?: number; status?: number } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { message: `runner returned non-JSON output: ${text.slice(0, 500)}`, status: 502 } };
  }
  if (parsed.ok === true) return parsed;
  return {
    ok: false,
    error: {
      message: parsed.error?.message ?? `query failed (exit ${exec.exitCode})`,
      code: parsed.error?.code,
      number: parsed.error?.number,
      status: parsed.error?.status,
    },
  };
}

/**
 * Run one worker-authorized query. With `deps.relay` set, it tunnels through
 * the static-IP egress relay; with `deps.relay` null it dials the database
 * directly from the container's own IP (no SOCKS, no forwarder).
 *
 * The runner is shipped and run in a SINGLE stateless `exec`: the source rides
 * in the `DB_RUNNER_SRC` env var and is piped into `node` over stdin. Nothing
 * is written to the container filesystem — no per-call file, no cleanup, no
 * "did we already write it" state. `cwd` is the drivers dir so the runner's
 * bare `import "pg"` resolves against the baked node_modules.
 */
export async function runDbQuery(deps: DbQueryDeps, request: DbQueryRequest): Promise<DbQueryResult> {
  // A read runs in a rolled-back transaction, so running it twice is harmless.
  const retryAfterDispatch = request.mode !== "modify";
  return await withTransientRetry(deps, "db_query", retryAfterDispatch, async (markDispatched) => {
    await withWedgedSetupRecovery(deps, async () => {
      await ensureDbQuerySandboxReady(deps);
      await ensureRelayPrelude(deps, dbQuerySetupDeadline(deps, "db_query_setup"));
    });

    const containerTimeoutMs = (request.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS) + EXEC_OVERHEAD_MS;
    markDispatched();
    const exec = await dbQueryDeadline(deps, "db_query", containerTimeoutMs).run(() =>
      deps.sandbox.exec(
        `bash -c 'printf %s "$DB_RUNNER_SRC" | node --input-type=module'`,
        {
          cwd: DB_QUERY_RUNNER_DIR,
          timeout: containerTimeoutMs,
          env: runnerEnv(deps, request),
        },
      ));
    return parseRunnerOutput(exec);
  });
}

/** Env for a runner invocation: source + request + optional relay creds. */
function runnerEnv(deps: DbQueryDeps, request: DbQueryRequest): Record<string, string | undefined> {
  return {
    DB_RUNNER_SRC: RUNNER_SOURCE,
    DB_QUERY_REQUEST: JSON.stringify(request),
    // SOCKS creds present ⇒ runner uses the relay; absent ⇒ direct dial.
    ...(deps.relay
      ? {
          DB_RELAY_LOCAL_PORT: String(DB_RELAY_LOCAL_PORT),
          DB_EGRESS_RELAY_SOCKS_USERNAME: deps.relay.socksUsername,
          DB_EGRESS_RELAY_SOCKS_PASSWORD: deps.relay.socksPassword,
        }
      : {}),
  };
}

/**
 * Extra wall-clock beyond the export timeout: node start + driver import +
 * connect, PLUS the Parquet footer write and the s3fs flush of the staged
 * file to R2 (which runs after the database deadline — see the runner).
 */
const EXPORT_EXEC_OVERHEAD_MS = 90_000;

export type DbExportResult =
  | { ok: true; rowCount: number; bytes: number; durationMs: number }
  | { ok: false; error: { message: string; code?: string; number?: number; status?: number } };

/**
 * Run one worker-authorized bulk export: the runner streams the read-only
 * result set as a Snappy Parquet file written DIRECTLY into the workspace's
 * mounted warehouse R2 prefix (credential-less bucket mount) — nothing
 * streams through the Worker. Same single stateless exec as runDbQuery, plus
 * the mount ensure. `exportPath` must be `'/' + r2Key` (inside the mounted
 * prefix); `mountPrefix` is the workspace's warehouse prefix. On failure the
 * runner unlinks the partial file — callers should still HEAD-verify the
 * object (warehouse-export parity).
 */
export async function runDbExport(
  deps: DbQueryDeps,
  request: DbQueryRequest,
  mountPrefix: string,
  exportPath: string,
): Promise<DbExportResult> {
  // Retry only before the runner is dispatched: an export can run for minutes,
  // and a second full run is not worth hiding a mid-export failure.
  const exec = await withTransientRetry(deps, "db_export", false, async (markDispatched) => {
    await withWedgedSetupRecovery(deps, async () => {
      await ensureDbQuerySandboxReady(deps);
      await ensureRelayPrelude(deps, dbQuerySetupDeadline(deps, "db_export_setup"));
    });
    // The mount is an exec-class container call too: unbounded, it hung exports
    // exactly like the readiness probes did. Its OWN budget, not a share of the
    // forwarder's — a slow-but-healthy mount must not be cut short by however
    // long the relay took to come up.
    await dbQuerySetupDeadline(deps, "db_export_mount")
      .run(() => deps.sandbox.ensureWarehouseExportMount(mountPrefix));

    const exportRequest: DbQueryRequest = { ...request, op: "export" };
    const containerTimeoutMs =
      (request.timeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS) + EXPORT_EXEC_OVERHEAD_MS;
    markDispatched();
    return await dbQueryDeadline(deps, "db_export", containerTimeoutMs).run(() =>
      deps.sandbox.exec(
        `bash -c 'printf %s "$DB_RUNNER_SRC" | node --input-type=module'`,
        {
          cwd: DB_QUERY_RUNNER_DIR,
          timeout: containerTimeoutMs,
          env: {
            ...runnerEnv(deps, exportRequest),
            DB_EXPORT_PATH: exportPath,
          },
        },
      ));
  });
  const parsed = parseRunnerOutput(exec) as unknown as DbExportResult;
  if (parsed.ok && (typeof parsed.rowCount !== "number" || typeof parsed.bytes !== "number")) {
    return { ok: false, error: { message: "export runner returned a malformed result", status: 502 } };
  }
  return parsed;
}
