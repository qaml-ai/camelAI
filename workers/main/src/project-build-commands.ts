import type { ProjectBuildResult, ProjectDependencyResult } from "./project-build-contracts.js";
import {
  cleanBuildLog,
  logProjectCommandFailure,
  normalizeDependencySpec,
  normalizeProjectBuildId,
  normalizeSandboxExecResult,
  persistProjectBuildLog,
  persistSandboxTextFile,
  PROJECT_BUILD_LOG_PATH,
  zeroProjectBuildTimings,
} from "./project-build-result-policy.js";
import {
  __testing as projectBuildSourceTesting,
  collectProjectSourceFiles,
  materializeProjectSourceFiles,
  PROJECT_BUILD_ROOT,
  shellQuote,
  validateDoSqliteApiUsage,
  validatePackageJson,
  validatePackageJsonBuildScript,
} from "./project-build-source.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";
import type { WorkspaceFileStoreLike } from "./workspace-filesystem-do.js";

/**
 * Container-side budget for `bun install && bun run build` (and for the
 * dependency install). Exported because the tool boundary derives its
 * client-side deadline from the same number — see
 * code-mode-tools.ts PROJECT_BUILD_EXEC_LIMITS.
 */
export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;

export async function runProjectBuild(input: {
  projectId: string;
  files: WorkspaceFileStoreLike;
  sandbox: ProjectBuildSandboxLike;
  timeoutMs?: number;
}): Promise<ProjectBuildResult> {
  const startedAt = Date.now();
  const projectId = normalizeProjectBuildId(input.projectId);
  const workdir = `${PROJECT_BUILD_ROOT}/${projectId}`;
  const timeoutMs = Math.max(1, Math.floor(input.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS));
  const sourceCollection = await collectProjectSourceFiles(input.files, { sandbox: input.sandbox, workdir });
  const sourceFiles = sourceCollection.validationFiles;
  const packageValidationError = validatePackageJsonBuildScript(sourceFiles)
    ?? validateDoSqliteApiUsage(sourceFiles);
  if (packageValidationError) {
    const durationMs = Date.now() - startedAt;
    const buildLog = cleanBuildLog(packageValidationError) || packageValidationError;
    const buildLogPersist = await persistProjectBuildLog(input.files, projectId, buildLog);
    console.warn("[project-build] validation failed", {
      operation: "build",
      projectId,
      workdir,
      fileCount: sourceCollection.entries.length,
      error: packageValidationError,
    });
    return {
      success: false,
      projectId,
      workdir,
      stdout: "",
      stderr: packageValidationError,
      exitCode: 1,
      fileCount: sourceCollection.entries.length,
      sourceBytes: sourceCollection.totalBytes,
      durationMs,
      timings: zeroProjectBuildTimings({ ...sourceCollection.timings, totalMs: durationMs }),
      lockfilePersisted: false,
      buildLogPath: PROJECT_BUILD_LOG_PATH,
      buildLogPersisted: buildLogPersist.persisted,
      buildLogBytes: buildLogPersist.bytes,
      error: packageValidationError,
    };
  }
  const materializeTiming = await materializeProjectSourceFiles(input.sandbox, workdir, sourceCollection);
  const commandStartedAt = Date.now();
  const result = normalizeSandboxExecResult(await input.sandbox.exec("bun install && bun run build", {
    cwd: workdir,
    timeout: timeoutMs,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      CAMELAI_PROJECT_ID: projectId,
      CAMELAI_BUILD_TIMEOUT_MS: String(timeoutMs),
    },
  }), timeoutMs);
  const commandMs = Date.now() - commandStartedAt;
  if (result.exitCode !== 0) {
    logProjectCommandFailure("build", {
      projectId,
      workdir,
      fileCount: sourceCollection.entries.length,
      durationMs: Date.now() - startedAt,
      timeoutMs,
    }, result);
  }
  const buildLogRaw = [result.stdout, result.stderr].filter(Boolean).join("\n") ||
    (result.exitCode === 0 ? "Build completed with no command output" : `Build failed with exit code ${result.exitCode}`);
  const buildLog = cleanBuildLog(buildLogRaw) || buildLogRaw;
  const buildLogPersist = await persistProjectBuildLog(input.files, projectId, buildLog);
  const persistStartedAt = Date.now();
  let lockfilePersisted = false;
  try {
    lockfilePersisted = await persistSandboxTextFile(input.sandbox, input.files, workdir, "bun.lock", { required: false });
  } catch (error) {
    if (result.exitCode === 0) throw error;
    console.warn("[project-build] lockfile persist failed after build failure", {
      operation: "build",
      projectId,
      error: String(error),
    });
  }
  const persistMs = Date.now() - persistStartedAt;
  const durationMs = Date.now() - startedAt;
  return {
    success: result.exitCode === 0,
    projectId,
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    fileCount: sourceCollection.entries.length,
    sourceBytes: sourceCollection.totalBytes,
    durationMs,
    timings: zeroProjectBuildTimings({
      ...sourceCollection.timings,
      ...materializeTiming,
      commandMs,
      persistMs,
      totalMs: durationMs,
    }),
    lockfilePersisted,
    buildLogPath: PROJECT_BUILD_LOG_PATH,
    buildLogPersisted: buildLogPersist.persisted,
    buildLogBytes: buildLogPersist.bytes,
    ...(result.exitCode === 0 ? {} : {
      // stdout first and stderr last keeps compiler diagnostics in a tail excerpt.
      error: [result.stdout, result.stderr].filter(Boolean).join("\n") ||
        `Build failed with exit code ${result.exitCode}`,
    }),
  };
}

export async function runProjectAddDependency(input: {
  projectId: string;
  dependency: string;
  dev?: boolean;
  files: WorkspaceFileStoreLike;
  sandbox: ProjectBuildSandboxLike;
}): Promise<ProjectDependencyResult> {
  const startedAt = Date.now();
  const projectId = normalizeProjectBuildId(input.projectId);
  const workdir = `${PROJECT_BUILD_ROOT}/${projectId}`;
  const dependency = normalizeDependencySpec(input.dependency);
  const dev = input.dev === true;
  const sourceCollection = await collectProjectSourceFiles(input.files, { sandbox: input.sandbox, workdir });
  const sourceFiles = sourceCollection.validationFiles;
  const packageValidationError = validatePackageJson(sourceFiles);
  if (packageValidationError) {
    const durationMs = Date.now() - startedAt;
    console.warn("[project-build] validation failed", {
      operation: "dependency_install",
      projectId,
      workdir,
      dependency,
      dev,
      fileCount: sourceCollection.entries.length,
      error: packageValidationError,
    });
    return {
      success: false,
      projectId,
      workdir,
      dependency,
      dev,
      stdout: "",
      stderr: packageValidationError,
      exitCode: 1,
      fileCount: sourceCollection.entries.length,
      sourceBytes: sourceCollection.totalBytes,
      durationMs,
      timings: zeroProjectBuildTimings({ ...sourceCollection.timings, totalMs: durationMs }),
      packageJsonPersisted: false,
      lockfilePersisted: false,
      error: packageValidationError,
    };
  }
  const materializeTiming = await materializeProjectSourceFiles(input.sandbox, workdir, sourceCollection);
  const command = `bun add ${dev ? "-d " : ""}${shellQuote(dependency)}`;
  const commandStartedAt = Date.now();
  const result = normalizeSandboxExecResult(await input.sandbox.exec(command, {
    cwd: workdir,
    timeout: DEFAULT_BUILD_TIMEOUT_MS,
    env: {
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
      CAMELAI_PROJECT_ID: projectId,
    },
  }), DEFAULT_BUILD_TIMEOUT_MS);
  const commandMs = Date.now() - commandStartedAt;
  if (result.exitCode !== 0) {
    logProjectCommandFailure("dependency_install", {
      projectId,
      workdir,
      dependency,
      dev,
      fileCount: sourceCollection.entries.length,
      durationMs: Date.now() - startedAt,
      timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    }, result);
  }
  const persistStartedAt = Date.now();
  const packageJsonPersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "package.json", { required: true })
    : false;
  const lockfilePersisted = result.exitCode === 0
    ? await persistSandboxTextFile(input.sandbox, input.files, workdir, "bun.lock", { required: false })
    : false;
  const persistMs = Date.now() - persistStartedAt;
  const durationMs = Date.now() - startedAt;
  return {
    success: result.exitCode === 0,
    projectId,
    workdir,
    dependency,
    dev,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    fileCount: sourceCollection.entries.length,
    sourceBytes: sourceCollection.totalBytes,
    durationMs,
    timings: zeroProjectBuildTimings({
      ...sourceCollection.timings,
      ...materializeTiming,
      commandMs,
      persistMs,
      totalMs: durationMs,
    }),
    packageJsonPersisted,
    lockfilePersisted,
    ...(result.exitCode === 0 ? {} : {
      error: result.stderr || result.stdout || `Dependency install failed with exit code ${result.exitCode}`,
    }),
  };
}

export const __testing = {
  collectProjectSourceFiles,
  ...projectBuildSourceTesting,
};
