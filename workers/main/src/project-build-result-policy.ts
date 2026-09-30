import { base64ToBytes } from "./base64-codec.js";
import type { ProjectBuildTimings } from "./project-build-contracts.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";
import { sandboxExecTimeoutMessage } from "./sandbox-exec-deadline.js";
import type { WorkspaceFileStoreLike } from "./workspace-filesystem-do.js";

const BUILD_LOG_EXCERPT_MAX_CHARS = 10_000;
const MAX_COMMAND_OUTPUT_LOG_CHARS = 4000;
export const PROJECT_BUILD_LOG_PATH = "/.camelai/tmp/build.log";

function commandOutputForLog(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= MAX_COMMAND_OUTPUT_LOG_CHARS) return trimmed;
  const omitted = trimmed.length - MAX_COMMAND_OUTPUT_LOG_CHARS;
  return `[truncated ${omitted} chars]\n${trimmed.slice(-MAX_COMMAND_OUTPUT_LOG_CHARS)}`;
}

export function logProjectCommandFailure(
  operation: "build" | "dependency_install",
  details: {
    projectId: string;
    workdir: string;
    fileCount: number;
    durationMs: number;
    timeoutMs?: number;
    dependency?: string;
    dev?: boolean;
  },
  result: { stdout: string; stderr: string; exitCode: number },
): void {
  console.warn("[project-build] command failed", {
    operation,
    projectId: details.projectId,
    workdir: details.workdir,
    fileCount: details.fileCount,
    durationMs: details.durationMs,
    timeoutMs: details.timeoutMs,
    dependency: details.dependency,
    dev: details.dev,
    exitCode: result.exitCode,
    stdout: commandOutputForLog(result.stdout),
    stderr: commandOutputForLog(result.stderr),
  });
}

export function cleanBuildLog(raw: string): string | null {
  const cleaned = raw
    // oxlint-disable-next-line no-control-regex -- These expressions intentionally remove ANSI escape sequences.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    // oxlint-disable-next-line no-control-regex -- Strip any remaining escape characters.
    .replace(/\u001b/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || null;
}

export function buildLogTail(raw: string): string | null {
  const cleaned = cleanBuildLog(raw);
  if (!cleaned) return null;
  if (cleaned.length <= BUILD_LOG_EXCERPT_MAX_CHARS) return cleaned;
  return `[truncated ${cleaned.length - BUILD_LOG_EXCERPT_MAX_CHARS} chars]\n${cleaned.slice(-BUILD_LOG_EXCERPT_MAX_CHARS)}`;
}

export async function persistProjectBuildLog(
  files: WorkspaceFileStoreLike,
  projectId: string,
  content: string,
): Promise<{ persisted: boolean; bytes: number }> {
  const bytes = new TextEncoder().encode(content).byteLength;
  const result = await files.writeFile(PROJECT_BUILD_LOG_PATH, content);
  if (!result.success) {
    console.warn("[project-build] build log persist failed", {
      operation: "build_log_persist",
      projectId,
      path: PROJECT_BUILD_LOG_PATH,
      bytes,
      error: result.error,
    });
    return { persisted: false, bytes };
  }
  return { persisted: true, bytes };
}

export async function persistSandboxTextFile(
  sandbox: ProjectBuildSandboxLike,
  files: WorkspaceFileStoreLike,
  workdir: string,
  path: string,
  options: { required: boolean },
): Promise<boolean> {
  const read = await sandbox.readFile(`${workdir}/${path}`, { encoding: "base64" });
  if (read === null) {
    if (options.required) throw new Error(`Build output is missing: ${path}`);
    return false;
  }
  const content = new TextDecoder().decode(base64ToBytes(read.content));
  const result = await files.writeFile(`/${path}`, content);
  if (!result.success) throw new Error(result.error || `Failed to persist ${path}`);
  return true;
}

export function normalizeDependencySpec(value: unknown): string {
  if (typeof value !== "string") throw new Error("dependency is required");
  const spec = value.trim();
  if (!spec) throw new Error("dependency is required");
  if (spec.length > 214) throw new Error("dependency is too long");
  // oxlint-disable-next-line no-control-regex -- Dependency specs must reject ASCII control characters.
  if (/\s|[\u0000-\u001f\u007f]/.test(spec)) throw new Error("dependency must be a single npm package spec");
  if (spec.startsWith("-")) throw new Error("dependency must not be a CLI flag");
  if (/(^|@)(?:file|link|workspace|portal|git|github|http|https):/i.test(spec) || spec.includes("://")) {
    throw new Error("dependency must be an npm registry package spec");
  }
  const packageSpecPattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*+=:<>{}-]+)?$/i;
  if (!packageSpecPattern.test(spec)) throw new Error("dependency must be an npm package spec");
  return spec;
}

export function normalizeProjectBuildId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 63);
  if (!normalized) throw new Error("projectId is required");
  return normalized;
}

/**
 * A build command's result as build logs and tool results report it. A command
 * the container stopped at `timeoutMs` gets that said on its last stderr line,
 * after the partial output.
 */
export function normalizeSandboxExecResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
}, timeoutMs: number): { stdout: string; stderr: string; exitCode: number } {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : result.success === false ? 1 : 0;
  let stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (result.timedOut) {
    stderr = `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${sandboxExecTimeoutMessage(timeoutMs)}`;
  }
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr,
    exitCode,
  };
}

export function zeroProjectBuildTimings(partial: Partial<ProjectBuildTimings> = {}): ProjectBuildTimings {
  return {
    collectSourceMs: 0,
    sourceListMs: 0,
    sourceReadMs: 0,
    sourceHashMs: 0,
    materializeMs: 0,
    previousManifestReadMs: 0,
    archiveCreateMs: 0,
    archiveWriteMs: 0,
    materializeExecMs: 0,
    commandMs: 0,
    persistMs: 0,
    totalMs: 0,
    ...partial,
  };
}
