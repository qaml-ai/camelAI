// A thread's preview tabs: their ids and normalization (OrgDO keeps a
// thread's tabs; the preview route and the runtime page read them).
import { normalizeRuntimeCallArtifacts } from "../../../../src/lib/runtime-artifacts";
import type { PreviewTarget } from "./types";

export function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") {
    return `app:${target.scriptName}`;
  }
  if (target.kind === "runtime_artifact") {
    return `artifact:${target.artifact.id}`;
  }
  return `file:${target.workspaceId}:${target.source}:${target.project ?? target.threadId ?? ""}:${target.path}`;
}

export function normalizePreviewTarget(
  target: PreviewTarget | null | undefined,
): PreviewTarget | null {
  if (!target || typeof target !== "object") {
    return null;
  }

  if (target.kind === "app") {
    if (typeof target.scriptName !== "string") return null;
    const scriptName = target.scriptName
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 63);
    if (!scriptName) return null;
    return {
      kind: "app",
      scriptName,
      isPublic: Boolean(target.isPublic),
    };
  }

  if (target.kind === "runtime_artifact") {
    const artifacts = normalizeRuntimeCallArtifacts([target.artifact]);
    const artifact = artifacts[0];
    return artifact ? { kind: "runtime_artifact", artifact } : null;
  }

  if (target.kind === "file") {
    const source = target.source;
    if (
      source !== "workspace" &&
      source !== "project" &&
      source !== "upload" &&
      source !== "output" &&
      source !== "scratch"
    ) {
      return null;
    }
    // A runtime thread's scratch file: always with its thread, under /workspace/.
    const threadId = source === "scratch" && typeof target.threadId === "string" ? target.threadId.trim() : "";
    if (source === "scratch" && (!threadId || typeof target.path !== "string" || !target.path.startsWith("/workspace/"))) {
      return null;
    }

    const workspaceId =
      typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
    const path = typeof target.path === "string" ? target.path.trim() : "";

    if (!workspaceId || !path || path.includes("..")) {
      return null;
    }
    const requiresProject = source === "project";
    const project =
      requiresProject && typeof target.project === "string"
        ? target.project.trim()
        : undefined;
    if (requiresProject && !project) {
      return null;
    }

    return {
      kind: "file",
      source,
      workspaceId,
      path,
      project,
      ...(threadId ? { threadId } : {}),
      filename:
        typeof target.filename === "string"
          ? target.filename.trim()
          : undefined,
      contentType:
        typeof target.contentType === "string"
          ? target.contentType
          : undefined,
    };
  }

  return null;
}

/** At most this many preview tabs are kept for a thread. */
export const MAX_PREVIEW_TABS = 32;

/**
 * Preview tabs from outside (a browser's PUT, stored state): each normalized
 * as ChatThreadDO normalizes them, deduplicated, bounded, and file tabs only
 * from `workspaceId`. The active tab must be one of them.
 */
export function normalizePreviewTabs(
  tabs: unknown,
  activeTabId: unknown,
  workspaceId: string,
  threadId?: string,
): { tabs: PreviewTarget[]; activeTabId: string | null } {
  const byId = new Map<string, PreviewTarget>();
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    let normalized: PreviewTarget | null = null;
    try {
      normalized = normalizePreviewTarget(tab as PreviewTarget);
    } catch {
      continue;
    }
    if (!normalized || (normalized.kind === "file" && normalized.workspaceId !== workspaceId)) continue;
    // Scratch files only of this thread.
    if (normalized.kind === "file" && normalized.source === "scratch" && normalized.threadId !== threadId) continue;
    const id = getPreviewTabId(normalized);
    if (!byId.has(id) && byId.size >= MAX_PREVIEW_TABS) continue;
    byId.set(id, normalized);
  }
  const active = typeof activeTabId === "string" && byId.has(activeTabId)
    ? activeTabId
    : (byId.keys().next().value ?? null);
  return { tabs: [...byId.values()], activeTabId: active };
}
