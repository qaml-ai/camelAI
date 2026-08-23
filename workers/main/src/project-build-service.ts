import { getSandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

import { runProjectAddDependency, runProjectBuild } from "./project-build-commands.js";
import type {
  ProjectBuildEnv,
  ProjectBuildProps,
  ProjectBuildRequest,
  ProjectBuildResult,
  ProjectDependencyRequest,
  ProjectDependencyResult,
} from "./project-build-contracts.js";
import { normalizeProjectBuildId } from "./project-build-result-policy.js";
import { projectBuildSandboxKey } from "./project-build-sandbox-lifecycle.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";
import { ProjectFilesystemClient } from "./workspace-filesystem-do.js";
import { resolveComputeSandbox } from "./binding-facades/compute.js";

export { __testing, DEFAULT_BUILD_TIMEOUT_MS, runProjectAddDependency, runProjectBuild } from "./project-build-commands.js";
export type {
  ProjectBuildEnv,
  ProjectBuildProps,
  ProjectBuildRequest,
  ProjectBuildResult,
  ProjectBuildSandboxNamespaceEnv,
  ProjectBuildTimings,
  ProjectDependencyRequest,
  ProjectDependencyResult,
} from "./project-build-contracts.js";
export { buildLogTail, cleanBuildLog } from "./project-build-result-policy.js";
export { projectBuildSandboxKey } from "./project-build-sandbox-lifecycle.js";
export { collectWorkerBundleFromSandbox } from "./project-worker-bundle.js";
export type { ProjectBuildSandboxLike, ProjectWorkerBundle } from "./project-worker-bundle.js";

export class ProjectBuildService extends WorkerEntrypoint<ProjectBuildEnv, ProjectBuildProps> {
  async buildProject(request: ProjectBuildRequest): Promise<ProjectBuildResult> {
    const { projectId, sandbox } = resolveProjectBuildRuntime(this.env, this.ctx.props.orgId, request.projectId);
    return runProjectBuild({
      projectId,
      files: new ProjectFilesystemClient(this.env as never, projectId),
      sandbox,
      timeoutMs: request.timeoutMs,
    });
  }

  async addDependency(request: ProjectDependencyRequest): Promise<ProjectDependencyResult> {
    const { projectId, sandbox } = resolveProjectBuildRuntime(this.env, this.ctx.props.orgId, request.projectId);
    return runProjectAddDependency({
      projectId,
      dependency: request.dependency,
      dev: request.dev,
      files: new ProjectFilesystemClient(this.env as never, projectId),
      sandbox,
    });
  }
}

function resolveProjectBuildRuntime(
  env: ProjectBuildEnv,
  orgId: string,
  value: string,
): { projectId: string; sandbox: ProjectBuildSandboxLike } {
  if (!env.PROJECT_BUILD_SANDBOX && !env.COMPUTE_SERVICE) {
    throw new Error("PROJECT_BUILD_SANDBOX container binding is not configured");
  }
  if (!orgId) throw new Error("Project build service requires org scope");
  const projectId = normalizeProjectBuildId(value);
  const sandboxKey = projectBuildSandboxKey(orgId);
  const sandbox = resolveComputeSandbox<ProjectBuildSandboxLike>(env, {
    kind: "project-build",
    id: sandboxKey,
    nativeAvailable: Boolean(env.PROJECT_BUILD_SANDBOX),
    native: () => getSandbox(
      env.PROJECT_BUILD_SANDBOX!,
      sandboxKey,
      { normalizeId: true, transport: "rpc" },
    ) as unknown as ProjectBuildSandboxLike,
  });
  return { projectId, sandbox };
}
