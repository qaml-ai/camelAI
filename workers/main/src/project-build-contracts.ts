export interface ProjectBuildResult {
  success: boolean;
  projectId: string;
  workdir: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  fileCount: number;
  sourceBytes: number;
  durationMs: number;
  timings: ProjectBuildTimings;
  lockfilePersisted: boolean;
  buildLogPath?: string;
  buildLogPersisted?: boolean;
  buildLogBytes?: number;
  error?: string;
}

export interface ProjectDependencyResult {
  success: boolean;
  projectId: string;
  workdir: string;
  dependency: string;
  dev: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  fileCount: number;
  sourceBytes: number;
  durationMs: number;
  timings: ProjectBuildTimings;
  packageJsonPersisted: boolean;
  lockfilePersisted: boolean;
  error?: string;
}

export interface ProjectBuildTimings {
  collectSourceMs: number;
  sourceListMs: number;
  sourceReadMs: number;
  sourceHashMs: number;
  materializeMs: number;
  previousManifestReadMs: number;
  archiveCreateMs: number;
  archiveWriteMs: number;
  materializeExecMs: number;
  commandMs: number;
  persistMs: number;
  totalMs: number;
}

/**
 * ProjectBuildContainer could not run an operation because its container is
 * not running: it failed to start, or it stopped under the call. Transient: the
 * next call starts a fresh container, so the readiness gate and the retry
 * ladder absorb it.
 *
 * Thrown inside the Durable Object and recognized in the Worker. A DO RPC hop
 * delivers a plain `Error` (name "Error", no own properties) whose message is
 * prefixed with the original name — checked under `wrangler dev` — so callers
 * use `is()` rather than `instanceof`.
 */
export class ProjectBuildContainerUnavailableError extends Error {
  static is(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === "ProjectBuildContainerUnavailableError" ||
      error.message.startsWith("ProjectBuildContainerUnavailableError: ");
  }

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Project build container is not running (${operation}): ${detail}`, { cause });
    this.name = "ProjectBuildContainerUnavailableError";
  }
}
