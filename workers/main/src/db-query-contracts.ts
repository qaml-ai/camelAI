import type { DbQueryContainer } from "./db-query-container.js";
import { followSandboxGeneration, sandboxGenerationName } from "./sandbox-placement.js";

/**
 * What the Worker and DbQueryContainer agree on: the container surface
 * db-query-service.ts drives, its result shapes, and the error that says the
 * container was not running. Kept free of the runner source and the container
 * class so either side can import it.
 */

/**
 * Directory holding the baked drivers. `node` runs with this as its cwd so the
 * runner's bare `import "pg"` (fed over stdin) resolves against the baked
 * node_modules by normal ESM directory walking — NODE_PATH is not consulted
 * for ESM, and stdin modules resolve bare specifiers relative to cwd.
 */
export const DB_QUERY_RUNNER_DIR = "/opt/db-query-runner";

/** Local port the container's `cloudflared access tcp` forwarder listens on. */
export const DB_RELAY_LOCAL_PORT = 11080;

/** What the container's relay forwarder needs: where to connect, and the Access token. */
export interface DbRelayForwarderConfig {
  hostname: string;
  accessClientId?: string;
  accessClientSecret?: string;
}

/** One runner run. `timedOut`: the container-side bound fired. */
export interface DbRunnerOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The DbQueryContainer surface this module uses (test seam). */
export interface DbQueryContainerStub {
  /** Starts the container; resolves once it runs commands. */
  start(): Promise<void>;
  /** Starts the relay forwarder unless it is already starting or running. */
  startRelayForwarder(relay: DbRelayForwarderConfig): Promise<void>;
  /** Whether the forwarder's local port accepts connections. */
  relayForwarderReady(): Promise<boolean>;
  /** Runs the runner once with `env`, bounded container-side by `timeoutMs`. */
  runRunner(env: Record<string, string>, timeoutMs: number): Promise<DbRunnerOutput>;
  /** Makes `/<prefix>` writable for an export into the warehouse bucket. */
  prepareWarehouseExport(prefix: string): Promise<void>;
  /**
   * Makes a successful export durable in the bucket before runDbExport
   * returns: a no-op on Cloudflare (the mount wrote it), a copy on self-host.
   */
  publishWarehouseExport(prefix: string, exportPath: string): Promise<void>;
  /** Stops the container so the next call starts a fresh one. */
  destroy(reason?: { operation: string; error?: string }): Promise<{ destroyed: boolean }>;
}

/**
 * DbQueryContainer could not run an operation because its container is not
 * running: it failed to start, or it stopped under the call. Transient: the
 * next call starts a fresh container, so db-query-service.ts retries once.
 *
 * Thrown inside the Durable Object and recognized in the Worker. A DO RPC hop
 * delivers a plain `Error` (name "Error", no own properties) whose message is
 * prefixed with the original name, so callers use `is()` rather than
 * `instanceof`.
 */
export class DbQueryContainerUnavailableError extends Error {
  static is(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === "DbQueryContainerUnavailableError" ||
      error.message.startsWith("DbQueryContainerUnavailableError: ");
  }

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`DB query container is not running (${operation}): ${detail}`, { cause });
    this.name = "DbQueryContainerUnavailableError";
  }
}

/** Instance name of a workspace's container (lowercase, as 0.12 normalized it). */
export function dbQueryContainerKey(workspaceId: string): string {
  return `ws-${workspaceId}`.toLowerCase();
}

/**
 * The db-query container for `key` (dbQueryContainerKey(), or the admin smoke
 * key). The one place callers obtain it. Each call goes to the key's current
 * placement generation (sandbox-placement.ts).
 */
export function getDbQueryContainer(
  env: { DB_QUERY_SANDBOX?: DurableObjectNamespace<DbQueryContainer> },
  key: string,
): DbQueryContainerStub {
  const namespace = env.DB_QUERY_SANDBOX;
  if (!namespace) {
    throw Object.assign(new Error("DB_QUERY_SANDBOX container binding is not configured"), { status: 500 });
  }
  const base = key.toLowerCase();
  return followSandboxGeneration(
    (generation) => namespace.getByName(sandboxGenerationName(base, generation)) as unknown as DbQueryContainerStub,
  );
}
