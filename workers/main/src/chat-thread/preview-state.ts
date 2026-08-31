// Preview-state primitives for ChatThreadDO: preview-target/tab normalization
// and preview session persistence. The public preview RPCs (getPreviewTarget /
// getPreviewState / setPreviewTarget / setPreviewTabsState / clearPreviewTarget
// / setPreviewAppVisibility) stay on the DO; only the normalization and
// persistence primitives live here. `getPreviewTabId` and
// `normalizePreviewTarget` are pure and exported as plain module functions.
// `ChatThreadPreviewState` holds the two members that touch DO state or
// siblings; it is stateless itself and is cached for the owning DO's lifetime
// with closures over its live deps (ChatThreadDO keeps thin same-named private
// delegates as its internal API). Sibling-method calls route back through the
// deps callbacks — i.e. through the DO's delegates — so dynamic dispatch (and
// every `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a
// sibling on the fake) behaves exactly as it did when the bodies lived on the
// DO.
import { normalizeRuntimeCallArtifacts } from "../../../../src/lib/runtime-artifacts";
import type { SyncKvStorage } from "./pi-turn-journal";
import type { PreviewTarget } from "./types";

export function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") {
    return `app:${target.scriptName}`;
  }
  if (target.kind === "runtime_artifact") {
    return `artifact:${target.artifact.id}`;
  }
  return `file:${target.workspaceId}:${target.source}:${target.project ?? ""}:${target.path}`;
}

export function normalizePreviewTarget(
  target: PreviewTarget | null | undefined,
): PreviewTarget | null {
  if (!target || typeof target !== "object") {
    return null;
  }

  if (target.kind === "app") {
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
      source !== "output"
    ) {
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

export interface ChatThreadPreviewStateDeps {
  kv(): SyncKvStorage;
  // Read-only views of the DO's in-memory preview session fields (the DO owns
  // the mutations; persistPreviewState only snapshots them into KV).
  previewTabs(): PreviewTarget[];
  previewActiveTabId(): string | null;
  previewTarget(): PreviewTarget | null;
  previewVersion(): number;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  getPreviewTabId(target: PreviewTarget): string;
  normalizePreviewTarget(
    target: PreviewTarget | null | undefined,
  ): PreviewTarget | null;
}

export class ChatThreadPreviewState {
  constructor(private readonly deps: ChatThreadPreviewStateDeps) {}

  normalizePreviewTabsState(
    tabs: PreviewTarget[] | null | undefined,
    activeTabId: string | null | undefined,
    expectedWorkspaceId?: string,
  ): {
    tabs: PreviewTarget[];
    activeTabId: string | null;
    target: PreviewTarget | null;
  } | null {
    const deduped: Array<{ id: string; target: PreviewTarget }> = [];
    const dedupedById = new Map<string, number>();

    if (Array.isArray(tabs)) {
      for (const tabTarget of tabs) {
        const normalized = this.deps.normalizePreviewTarget(tabTarget);
        if (!normalized) continue;
        if (
          expectedWorkspaceId &&
          normalized.kind === "file" &&
          normalized.workspaceId !== expectedWorkspaceId
        ) {
          return null;
        }

        const tabId = this.deps.getPreviewTabId(normalized);
        const existingIndex = dedupedById.get(tabId);
        if (existingIndex === undefined) {
          dedupedById.set(tabId, deduped.length);
          deduped.push({ id: tabId, target: normalized });
          continue;
        }
        deduped[existingIndex] = { id: tabId, target: normalized };
      }
    }

    const nextActiveTabId =
      typeof activeTabId === "string" && dedupedById.has(activeTabId)
        ? activeTabId
        : (deduped[0]?.id ?? null);

    const nextTarget = nextActiveTabId
      ? (deduped.find((tab) => tab.id === nextActiveTabId)?.target ?? null)
      : null;

    return {
      tabs: deduped.map((tab) => tab.target),
      activeTabId: nextActiveTabId,
      target: nextTarget,
    };
  }

  persistPreviewState(includeVersion = true): void {
    this.deps.kv().put("previewTabs", this.deps.previewTabs());
    this.deps.kv().put("previewActiveTabId", this.deps.previewActiveTabId());
    this.deps.kv().put("previewTarget", this.deps.previewTarget());
    if (includeVersion) {
      this.deps.kv().put("previewVersion", this.deps.previewVersion());
    }
  }
}
