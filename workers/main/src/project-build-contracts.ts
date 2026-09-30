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
 * keeps an error's `name` and message but not its class, so callers use
 * `is()` rather than `instanceof`.
 */
export class ProjectBuildContainerUnavailableError extends Error {
  static is(error: unknown): boolean {
    return error instanceof Error && error.name === "ProjectBuildContainerUnavailableError";
  }

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Project build container is not running (${operation}): ${detail}`, { cause });
    this.name = "ProjectBuildContainerUnavailableError";
  }
}
