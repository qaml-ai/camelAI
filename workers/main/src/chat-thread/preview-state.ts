import { normalizeRuntimeCallArtifacts } from "../../../../src/lib/runtime-artifacts";
import type { PreviewTarget } from "./types";

export function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") return `app:${target.scriptName}`;
  if (target.kind === "runtime_artifact") {
    return `artifact:${target.artifact.id}`;
  }
  return `file:${target.workspaceId}:${target.source}:${target.project ?? ""}:${target.path}`;
}

export function normalizePreviewTarget(
  target: PreviewTarget | null | undefined,
): PreviewTarget | null {
  if (!target || typeof target !== "object") return null;
  if (target.kind === "app") {
    const scriptName = target.scriptName
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 63);
    return scriptName
      ? { kind: "app", scriptName, isPublic: Boolean(target.isPublic) }
      : null;
  }
  if (target.kind === "runtime_artifact") {
    const artifact = normalizeRuntimeCallArtifacts([target.artifact])[0];
    return artifact ? { kind: "runtime_artifact", artifact } : null;
  }
  if (target.kind !== "file") return null;
  if (!["workspace", "project", "upload", "output"].includes(target.source)) {
    return null;
  }
  const workspaceId = target.workspaceId?.trim();
  const path = target.path?.trim();
  const project =
    target.source === "project" ? target.project?.trim() : undefined;
  if (
    !workspaceId ||
    !path ||
    path.includes("..") ||
    (target.source === "project" && !project)
  ) {
    return null;
  }
  return {
    kind: "file",
    source: target.source,
    workspaceId,
    path,
    project,
    filename: target.filename?.trim() || undefined,
    contentType: target.contentType?.trim() || undefined,
  };
}
