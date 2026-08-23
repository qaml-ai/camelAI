import type { ProjectBuildSandbox } from "./project-build-sandbox.js";

export interface ProjectBuildEnv {
  WORKSPACE_FS: DurableObjectNamespace;
  R2_BUCKET: R2Bucket;
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<ProjectBuildSandbox>;
  COMPUTE_SERVICE?: Fetcher;
}

export interface ProjectBuildProps {
  orgId: string;
}

export interface ProjectBuildRequest {
  projectId: string;
  timeoutMs?: number;
}

export interface ProjectDependencyRequest {
  projectId: string;
  dependency: string;
  dev?: boolean;
}

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

export interface ProjectBuildSandboxNamespaceEnv {
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<ProjectBuildSandbox>;
  COMPUTE_SERVICE?: Fetcher;
}
