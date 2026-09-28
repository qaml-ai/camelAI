import type { WorkspaceDO } from "./workspace";
import type { ThreadCompletionSummaryStatus } from "../../../src/types";

export interface WorkspaceThreadStatusEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
}

export interface WorkspaceThreadStreamingOptions {
  completedAt?: number;
  summaryStatus?: ThreadCompletionSummaryStatus | null;
  summary?: string | null;
  activityText?: string | null;
  activityAt?: number | null;
  /**
   * Liveness-lease heartbeat: bump the running row's updated_at only. Never
   * creates the row and never broadcasts — a late heartbeat must not
   * resurrect a turn whose terminal isStreaming=false already cleared it.
   */
  refresh?: boolean;
  /** Who sent a `refresh`, for the lease-refresh-missed event (e.g. `chat_thread_do`, `runtime_usage`). */
  source?: string;
  /**
   * Terminal pre-clear used before completion metadata is persisted. Delete and
   * broadcast only when a running row currently exists; a duplicate/stale
   * completion must not manufacture a fresh unread transition.
   */
  clearOnlyIfRunning?: boolean;
  /**
   * Timestamp used only to decide whether the running row belongs to a newer
   * turn. This may differ from `completedAt` when OrgDO normalizes metadata
   * forward after the terminal transition was first observed.
   */
  clearRunningStartedAtOrBefore?: number | null;
  /**
   * Clear only the running row that started at exactly this time: a sender
   * taking back the row it created (its send failed), never another turn's.
   */
  clearRunningStartedAt?: number;
  /**
   * When the turn started, for a row this call creates (a sender marks the
   * thread running with the time it took the message, before the runtime's
   * run.started arrives). An existing row keeps its own start.
   */
  startedAt?: number;
}

export function recordWorkspaceThreadStreaming(
  env: WorkspaceThreadStatusEnv,
  workspaceId: string | null | undefined,
  threadId: string | null | undefined,
  isStreaming: boolean,
  options?: WorkspaceThreadStreamingOptions,
): Promise<void> {
  const normalizedWorkspaceId = workspaceId?.trim();
  const normalizedThreadId = threadId?.trim();
  if (!normalizedWorkspaceId || !normalizedThreadId) {
    return Promise.resolve();
  }
  const workspace = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(normalizedWorkspaceId),
  );
  return workspace.recordThreadStreaming(normalizedThreadId, isStreaming, options);
}
