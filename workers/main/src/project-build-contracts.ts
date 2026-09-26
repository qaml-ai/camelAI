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
