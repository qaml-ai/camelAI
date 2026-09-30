import { getSandbox } from "@cloudflare/sandbox";

import { projectBuildSandboxKey } from "./project-build-sandbox-lifecycle.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";
import type { Env } from "./types.js";

export type ProjectBuildSandboxRuntime = "v0" | "v1";

type ProjectBuildSandboxEnv = Pick<
  Env,
  "PROJECT_BUILD_SANDBOX" | "PROJECT_BUILD_SANDBOX_V1" | "PROJECT_BUILD_SANDBOX_RUNTIME"
>;

/**
 * Which class serves project builds: "v1" (ProjectBuildSandboxV1, native
 * ctx.container) only when PROJECT_BUILD_SANDBOX_RUNTIME says so AND its binding
 * exists; anything else is the 0.12 ProjectBuildSandbox. Rollback is flipping
 * the var back: the containers only cache build state, so neither side needs
 * the other's files.
 */
export function projectBuildSandboxRuntime(env: ProjectBuildSandboxEnv): ProjectBuildSandboxRuntime {
  return env.PROJECT_BUILD_SANDBOX_RUNTIME?.trim().toLowerCase() === "v1" && env.PROJECT_BUILD_SANDBOX_V1
    ? "v1"
    : "v0";
}

/** True when either build sandbox class is bound. */
export function hasProjectBuildSandbox(env: ProjectBuildSandboxEnv): boolean {
  return projectBuildSandboxRuntime(env) === "v1" || Boolean(env.PROJECT_BUILD_SANDBOX);
}

/**
 * The org's build sandbox stub. The one place build callers obtain it, so the
 * runtime switch applies to every path (build tools, admin verify) alike.
 */
export function getProjectBuildSandbox(env: ProjectBuildSandboxEnv, orgId: string): ProjectBuildSandboxLike {
  const key = projectBuildSandboxKey(orgId);
  if (projectBuildSandboxRuntime(env) === "v1" && env.PROJECT_BUILD_SANDBOX_V1) {
    // The key is already lowercase, which is what 0.12's normalizeId did.
    return env.PROJECT_BUILD_SANDBOX_V1.getByName(key) as unknown as ProjectBuildSandboxLike;
  }
  if (!env.PROJECT_BUILD_SANDBOX) {
    throw new Error("PROJECT_BUILD_SANDBOX container binding is not configured");
  }
  return getSandbox(env.PROJECT_BUILD_SANDBOX, key, {
    normalizeId: true,
    transport: "rpc",
  }) as unknown as ProjectBuildSandboxLike;
}
