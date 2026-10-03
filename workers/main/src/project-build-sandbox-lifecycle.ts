import {
  PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS,
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
} from "./container-sizing.js";
import type { ProjectBuildContainer } from "./project-build-container.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";
import { followSandboxGeneration, sandboxGenerationName } from "./sandbox-placement.js";

const MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH = 63;

/**
 * Durable Object storage key holding the epoch-ms deadline until which an active
 * build session keeps the container awake. Persisted (not just in-memory) so a
 * DO eviction/restart mid-session does not drop the session back to the bare 2m
 * idle window.
 */
export const PROJECT_BUILD_SESSION_ACTIVITY_KEY = "camelaiBuildSessionActiveUntilMs";

/**
 * Stable Durable Object name for an org's shared project-build sandbox.
 * Kept short enough for Cloudflare sandbox id limits.
 */
export function projectBuildSandboxKey(orgId: string): string {
  const org = orgId.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!org) throw new Error("orgId is required");
  const readable = `org-${org}`;
  if (readable.length <= MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH) return readable;
  const hash = stableHexHash(org);
  const prefixLength = MAX_PROJECT_BUILD_SANDBOX_KEY_LENGTH - hash.length - 1;
  const prefix = readable.slice(0, prefixLength).replace(/-+$/g, "");
  return `${prefix}-${hash}`;
}

/**
 * The org's build container: one ProjectBuildContainer instance per org, at
 * its current placement generation (sandbox-placement.ts). A rotated name is
 * the key plus `-g<N>`, which may pass 63 characters: that bound was the 0.x
 * Sandbox SDK's sandbox id, not a Durable Object name limit.
 */
export function getProjectBuildSandbox(
  env: { PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<ProjectBuildContainer> },
  orgId: string,
): ProjectBuildSandboxLike {
  const namespace = env.PROJECT_BUILD_SANDBOX;
  if (!namespace) {
    throw new Error("PROJECT_BUILD_SANDBOX container binding is not configured");
  }
  const base = projectBuildSandboxKey(orgId);
  return followSandboxGeneration(
    (generation) => namespace.getByName(sandboxGenerationName(base, generation)) as unknown as ProjectBuildSandboxLike,
  );
}

function stableHexHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * New warm-session deadline, or null when the stored one already covers it.
 * Returning null keeps a repeated touch from writing storage on every build.
 */
export function nextBuildSessionDeadline(
  nowMs: number,
  storedUntilMs: number | undefined,
  windowMs: number = PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
): number | null {
  const bounded = Math.min(
    Math.max(0, Number.isFinite(windowMs) ? windowMs : 0),
    PROJECT_BUILD_ACTIVE_SESSION_MAX_WINDOW_MS,
  );
  if (bounded <= 0) return null;
  const deadline = nowMs + bounded;
  const stored = typeof storedUntilMs === "number" && Number.isFinite(storedUntilMs) ? storedUntilMs : 0;
  return deadline > stored ? deadline : null;
}
