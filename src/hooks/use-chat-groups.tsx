"use client";

import {
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMatches, useRouteLoaderData, useRevalidator } from "react-router";
import type {
  ChatGroupAvatar,
  ChatGroupAvatarStatus,
  ChatGroupView,
  ThreadCompletionSummaryStatus,
  ThreadStatus,
} from "@/types";
import { useAuthData } from "@/hooks/use-auth-data";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import { isTerminalChatSseHttpStatus } from "@/lib/chat-sse-close";
import { reportClientEvent } from "@/lib/client-error-reporting";
import { useVersionSkewWatch } from "@/hooks/use-version-skew-watch";
import { maxThreadStatus } from "@/lib/thread-status";
import { isPlaceholderThreadTitle } from "@/lib/thread-title";
import { writePinnedGroupCountHint } from "@/lib/pinned-groups-cookie";
import { markThreadViewed } from "@/lib/mark-thread-viewed.client";
import {
  ChatGroupsContext,
} from "@/hooks/chat-groups-context";

interface AppChatGroupsLoaderData {
  chatGroups?: ChatGroupView[] | Promise<ChatGroupView[]>;
}

interface ChatRouteData {
  activeChatGroup?: ChatGroupView | null;
  activeGroupId?: string | null;
  threadId?: string | null;
}

export interface LiveThreadMetadata {
  status: ThreadStatus;
  /**
   * When `status` was last asserted: client receipt time for socket frames and
   * local dispatches, or the server-reported run start for snapshot-derived
   * running entries. Merge/reconcile prefer the fresher assertion instead of a
   * fixed live-over-local precedence, so a stale server-side "running" row
   * (e.g. a lost turn-end broadcast) cannot pin a thread running after the
   * client has observed the turn finish.
   */
  statusChangedAt?: number;
  completedAt?: number | null;
  summaryStatus?: ThreadCompletionSummaryStatus | null;
  summary?: string | null;
  firstUserMessage?: string | null;
  latestUserMessage?: string | null;
  latestUserMessageAt?: number | null;
  runningActivityText?: string | null;
  runningActivityAt?: number | null;
  runningStartedAt?: number | null;
}

type ThreadStatusOverlay = ThreadStatus | LiveThreadMetadata;

type ChatGroupThreadSummary = ChatGroupView["open_threads"][number];
export type ThreadSummaryPatch = Partial<
  Pick<ChatGroupThreadSummary, "title" | "model">
> & {
  firstUserMessage?: string | null;
  updatedAt: number;
};

export type OptimisticUserMessageRecencyPatch = {
  sentAt: number;
  snapshotVersion: number;
};

export type GroupAvatarPatch = {
  avatar: ChatGroupAvatar;
  updatedAt: number;
  snapshotVersion?: number;
};

export const LOCAL_GROUP_AVATAR_PENDING_TIMEOUT_MS = 15_000;
export const PENDING_GROUP_AVATAR_REVALIDATE_INTERVAL_MS = 2_000;
export const PENDING_GROUP_AVATAR_REVALIDATE_MAX_MS = 20_000;

function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

function getActiveGroupIdFromMatches(matches: ReturnType<typeof useMatches>) {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.activeChatGroup?.id) return data.activeChatGroup.id;
    if (data?.activeGroupId) return data.activeGroupId;
  }
  return null;
}

function getActiveChatGroupFromMatches(
  matches: ReturnType<typeof useMatches>,
): ChatGroupView | null {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.activeChatGroup) return data.activeChatGroup;
  }
  return null;
}

function getActiveThreadIdFromMatches(matches: ReturnType<typeof useMatches>) {
  for (const match of matches) {
    const data = match.data as ChatRouteData | undefined;
    if (data?.threadId) return data.threadId;
  }
  return null;
}

function getOverlayStatus(value: ThreadStatusOverlay | undefined): ThreadStatus | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.status;
}

function getOverlayMetadata(
  value: ThreadStatusOverlay | undefined,
): LiveThreadMetadata | null {
  if (!value || typeof value === "string") return null;
  return value;
}

function mergeThreadMetadata(
  previous: LiveThreadMetadata | undefined,
  metadata: LiveThreadMetadata,
): LiveThreadMetadata {
  return {
    ...previous,
    ...metadata,
    status: metadata.status,
  };
}

export interface WorkspaceStatusStreamOptions {
  url: string;
  onMessage: (data: string) => void;
  /**
   * A stream that failed to attach (network error, or a response that is not a
   * live event-stream). Fires on every failed attempt, terminal or not, so the
   * caller can run a version-skew check: "this transport stopped answering" is
   * exactly the shape a retired route takes on a stale tab.
   */
  onAttachFailure?: (status: number | null) => void;
}

export interface WorkspaceStatusStreamHandle {
  close: () => void;
}

// Matches partysocket's former reconnect profile: first retry immediate, then
// 3s * 1.3^n capped at 10s, retried forever. Anything tighter than the 3s floor
// hammers the DO, anything slower visibly regresses spinner/unread latency.
const STATUS_STREAM_MIN_RETRY_MS = 3000;
const STATUS_STREAM_MAX_RETRY_MS = 10000;
const STATUS_STREAM_RETRY_GROW_FACTOR = 1.3;
const STATUS_STREAM_MIN_UPTIME_MS = 5000;

function statusStreamRetryDelay(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(
    STATUS_STREAM_MIN_RETRY_MS *
      STATUS_STREAM_RETRY_GROW_FACTOR ** (attempt - 1),
    STATUS_STREAM_MAX_RETRY_MS,
  );
}

function parseStatusStreamEvent(frame: string): string | null {
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    // Comment lines (`:hb`) are heartbeats, not frames.
    if (!line.startsWith("data:")) continue;
    data.push(line.slice("data:".length).trimStart());
  }
  return data.length > 0 ? data.join("\n") : null;
}

export function openWorkspaceStatusStream({
  url,
  onMessage,
  onAttachFailure,
}: WorkspaceStatusStreamOptions): WorkspaceStatusStreamHandle {
  const abortController = new AbortController();
  let closed = false;
  let attempt = 0;
  let retryTimer: number | null = null;

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = statusStreamRetryDelay(attempt);
    attempt += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  /**
   * Stop for good. A terminal attach status (401/403/404/4xx that is not in the
   * retryable set) is a verdict, not a blip: retrying it forever is the doom
   * loop the retired WebSocket transports produced on stale tabs, and it is
   * invisible because a reconnecting client shows no error. The chat SSE client
   * already classifies attach statuses this way — `isTerminalChatSseHttpStatus`
   * is the shared predicate, not a chat-specific one.
   */
  const stopTerminally = (status: number) => {
    closed = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
    reportClientEvent({
      source: "workspace_status_stream",
      event: "status_stream_terminal",
      severity: "warn",
      status: String(status),
      message: "Workspace status stream stopped: terminal attach status.",
      details: { httpStatus: status },
    });
  };

  const connect = async () => {
    if (closed) return;
    let attachedAt: number | null = null;
    try {
      const response = await fetch(url, {
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        credentials: "same-origin",
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        onAttachFailure?.(response.status);
        if (isTerminalChatSseHttpStatus(response.status)) {
          stopTerminally(response.status);
          return;
        }
        scheduleReconnect();
        return;
      }
      attachedAt = Date.now();
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = parseStatusStreamEvent(frame);
          if (data !== null) onMessage(data);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborts and network failures both land here; the closed guard below
      // separates teardown from a stream that needs another attempt.
    }
    // partysocket's minUptime rule: only a stream that stayed up resets the
    // backoff, so a server that ends the stream at once cannot hot-loop.
    if (
      attachedAt !== null &&
      Date.now() - attachedAt >= STATUS_STREAM_MIN_UPTIME_MS
    ) {
      attempt = 0;
    } else if (attachedAt === null && !closed) {
      // Never attached and this was not our own teardown: a transport-level
      // failure with no status to classify (DNS/TLS/offline, or a handshake the
      // browser refused). Report it; the caller decides whether the tab is
      // simply running a retired bundle.
      onAttachFailure?.(null);
    }
    scheduleReconnect();
  };

  void connect();

  return {
    close: () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      abortController.abort();
    },
  };
}

// Module-level seam: tests replace `open` to drive status frames without a
// server, the way the partysocket module mock used to.
export const workspaceStatusStream: {
  open: (options: WorkspaceStatusStreamOptions) => WorkspaceStatusStreamHandle;
} = { open: openWorkspaceStatusStream };

export function getGroupLandingHref(group: ChatGroupView): string {
  const activeThreadStillOpen =
    group.last_active_thread_id &&
    group.open_threads.some((thread) => thread.id === group.last_active_thread_id);
  if (activeThreadStillOpen) return `/chat/${group.last_active_thread_id}`;
  const firstOpen = group.open_threads[0]?.id;
  if (firstOpen) return `/chat/${firstOpen}`;
  return `/chat?group=${encodeURIComponent(group.id)}`;
}

export function reconcileLocalThreadStatusesWithSnapshot<T extends ThreadStatusOverlay>(
  localStatuses: Map<string, T>,
  runningThreadIds: Set<string>,
  runningStartedAts: ReadonlyMap<string, number | null> = new Map(),
): Map<string, T> {
  let next: Map<string, T> | null = null;
  for (const [threadId, overlay] of localStatuses) {
    const status = getOverlayStatus(overlay);
    if (status === "running" && !runningThreadIds.has(threadId)) {
      next ??= new Map(localStatuses);
      next.delete(threadId);
      continue;
    }
    if (status !== "running" && runningThreadIds.has(threadId)) {
      // A snapshot can carry a stale running row (the server's turn-end
      // record/broadcast was lost). If the run it describes started BEFORE the
      // client locally marked the thread not-running, the local status is
      // firsthand knowledge of that same run ending — keep it. A genuinely new
      // run has a startedAt after the local write and still clears the overlay.
      const startedAt = runningStartedAts.get(threadId);
      const localChangedAt = getOverlayMetadata(overlay)?.statusChangedAt ?? 0;
      if (typeof startedAt === "number" && startedAt <= localChangedAt) {
        continue;
      }
      next ??= new Map(localStatuses);
      next.delete(threadId);
    }
  }
  return next ?? localStatuses;
}

export function mergeLiveAndLocalThreadStatuses(
  liveStatuses: ReadonlyMap<string, LiveThreadMetadata>,
  localStatuses: ReadonlyMap<string, LiveThreadMetadata>,
): Map<string, LiveThreadMetadata> {
  const next = new Map(liveStatuses);
  for (const [threadId, metadata] of localStatuses) {
    const liveMetadata = next.get(threadId);
    // Live "running" outranks a local non-running overlay only while the live
    // assertion is fresher. Once the client observes the turn end (its local
    // idle is newer), the local status wins — otherwise a stale server-side
    // running row would pin the thread "running" indefinitely.
    if (
      liveMetadata?.status === "running" &&
      metadata.status !== "running" &&
      (liveMetadata.statusChangedAt ?? 0) > (metadata.statusChangedAt ?? 0)
    ) {
      continue;
    }
    next.set(threadId, mergeThreadMetadata(liveMetadata, metadata));
  }
  return next;
}

export function hasPendingCompletionSummaries(
  groups: readonly ChatGroupView[] | null | undefined,
): boolean {
  return Boolean(
    groups?.some((group) =>
      [...group.open_threads, ...group.closed_threads].some(
        (thread) => thread.last_assistant_summary_status === "pending",
      ),
    ),
  );
}

export function shouldRevalidateThreadStatusUpdate(
  status: ThreadStatus,
  isMetadataOnlyUpdate: boolean,
  hasSummaryMetadataUpdate: boolean,
): boolean {
  return (
    (status === "running" || status === "idle" || status === "unread") &&
    (!isMetadataOnlyUpdate || hasSummaryMetadataUpdate)
  );
}

export function shouldMarkActiveUnreadThreadViewed(
  status: ThreadStatus,
  threadId: string,
  activeThreadId: string | null,
): boolean {
  return status === "unread" && threadId === activeThreadId;
}

export function shouldMarkActiveIdleThreadViewed(
  status: ThreadStatus,
  threadId: string,
  activeThreadId: string | null,
): boolean {
  return status === "idle" && threadId === activeThreadId;
}

export function getThreadIdsRequiringSnapshotRevalidation(
  liveStatuses: ReadonlyMap<string, ThreadStatusOverlay>,
  localStatuses: ReadonlyMap<string, ThreadStatusOverlay>,
  runningThreadIds: Set<string>,
  activeThreadId: string | null,
): string[] {
  const threadIds = new Set<string>();
  for (const [threadId, overlay] of liveStatuses) {
    const status = getOverlayStatus(overlay);
    if (status === "running") threadIds.add(threadId);
  }
  for (const [threadId, overlay] of localStatuses) {
    const status = getOverlayStatus(overlay);
    if (status === "running") threadIds.add(threadId);
  }

  return Array.from(threadIds).filter(
    (threadId) =>
      threadId !== activeThreadId && !runningThreadIds.has(threadId),
  );
}

export function mergeActiveChatGroup(
  groups: ChatGroupView[],
  activeGroup: ChatGroupView | null,
): ChatGroupView[] {
  if (!activeGroup) return groups;
  const existingIndex = groups.findIndex((group) => group.id === activeGroup.id);
  if (existingIndex < 0) return [activeGroup, ...groups];

  const next = [...groups];
  next[existingIndex] = mergeActiveGroupWithExistingGroup(
    next[existingIndex],
    activeGroup,
  );
  return next;
}

/**
 * Effective recency for display ordering. Must only run AHEAD of the server's
 * `chat_groups.updated_at` for events that also bump the server key — a user
 * message landing bumps `updated_at` via touchGroupForThread, and the same
 * send adds a snapshot-bounded optimistic recency overlay on the client.
 * `latest_user_message_at` is intentionally not used because legacy summaries
 * may synthesize it from thread.updated_at. Closed threads are included because
 * Chat History can open one directly without reopening its group membership.
 * Anything broader (e.g. thread.last_active_at, which also moves on assistant
 * activity) would make the client order disagree with the next revalidation
 * and bounce rows.
 */
export function getChatGroupRecency(
  group: ChatGroupView,
  optimisticPatches: ReadonlyMap<
    string,
    OptimisticUserMessageRecencyPatch
  > = new Map(),
): number {
  let recency = group.updated_at;
  for (const thread of [...group.open_threads, ...group.closed_threads]) {
    const sentAt = Math.max(
      thread.last_user_message_at ?? 0,
      optimisticPatches.get(thread.id)?.sentAt ?? 0,
    );
    if (sentAt > recency) recency = sentAt;
  }
  return recency;
}

export function orderChatGroupsForDisplay(
  groups: ChatGroupView[],
  activeFirstGroupId: string | null = null,
  optimisticPatches: ReadonlyMap<
    string,
    OptimisticUserMessageRecencyPatch
  > = new Map(),
): ChatGroupView[] {
  const sorted = [...groups].sort(
    (a, b) =>
      getChatGroupRecency(b, optimisticPatches) -
      getChatGroupRecency(a, optimisticPatches),
  );
  if (activeFirstGroupId !== null) {
    const index = sorted.findIndex((group) => group.id === activeFirstGroupId);
    if (index > 0) {
      const [activeFirst] = sorted.splice(index, 1);
      sorted.unshift(activeFirst);
    }
  }
  return sorted;
}

function mergeThreadSummaries(
  activeThreads: ChatGroupThreadSummary[],
  existingThreads: ChatGroupThreadSummary[],
): ChatGroupThreadSummary[] {
  const activeById = new Map(activeThreads.map((thread) => [thread.id, thread]));
  const existingIds = new Set(existingThreads.map((thread) => thread.id));
  const activeContainsExistingOrder = existingThreads.every((thread) =>
    activeById.has(thread.id),
  );
  if (activeContainsExistingOrder) {
    return [
      ...activeThreads,
      ...existingThreads.filter((thread) => !activeById.has(thread.id)),
    ];
  }
  return [
    ...existingThreads.map((thread) => activeById.get(thread.id) ?? thread),
    ...activeThreads.filter((thread) => !existingIds.has(thread.id)),
  ];
}

function mergeThreadIds(
  activeThreadIds: string[],
  existingThreadIds: string[],
): string[] {
  const activeIds = new Set(activeThreadIds);
  const existingIds = new Set(existingThreadIds);
  const activeContainsExistingOrder = existingThreadIds.every((threadId) =>
    activeIds.has(threadId),
  );
  if (activeContainsExistingOrder) {
    return [
      ...activeThreadIds,
      ...existingThreadIds.filter((threadId) => !activeIds.has(threadId)),
    ];
  }
  return [
    ...existingThreadIds,
    ...activeThreadIds.filter((threadId) => !existingIds.has(threadId)),
  ];
}

function mergeActiveGroupWithExistingGroup(
  existingGroup: ChatGroupView,
  activeGroup: ChatGroupView,
): ChatGroupView {
  const openThreads = mergeThreadSummaries(
    activeGroup.open_threads,
    existingGroup.open_threads,
  );
  const closedThreads = mergeThreadSummaries(
    activeGroup.closed_threads,
    existingGroup.closed_threads,
  );
  const openThreadIds = mergeThreadIds(
    activeGroup.open_thread_ids,
    existingGroup.open_thread_ids,
  );
  const closedThreadIds = mergeThreadIds(
    activeGroup.closed_thread_ids,
    existingGroup.closed_thread_ids,
  );

  return {
    ...existingGroup,
    ...activeGroup,
    name: existingGroup.name || activeGroup.name,
    avatar: existingGroup.avatar,
    pinned_at: existingGroup.pinned_at,
    open_thread_ids: openThreadIds,
    closed_thread_ids: closedThreadIds,
    open_threads: openThreads,
    closed_threads: closedThreads,
    member_count: Math.max(
      activeGroup.member_count,
      existingGroup.member_count,
      openThreads.length + closedThreads.length,
    ),
  };
}

function resolveGroupNameAfterThreadPatches(
  group: ChatGroupView,
  openThreads: ChatGroupThreadSummary[],
  closedThreads: ChatGroupThreadSummary[],
): string {
  const threads = [...openThreads, ...closedThreads];
  if (threads.length !== 1) return group.name;
  const previousThreads = [...group.open_threads, ...group.closed_threads];
  const groupName = group.name.trim();
  const previousThreadTitle = previousThreads[0]?.title.trim();
  const isThreadTitleFallback =
    previousThreads.length === 1 && groupName === previousThreadTitle;
  if (!isPlaceholderThreadTitle(group.name) && !isThreadTitleFallback) {
    return group.name;
  }
  return threads[0].title;
}

export function getCloseGroupRedirect(
  groups: ChatGroupView[],
  activeGroupId: string | null,
  closingGroupId: string,
): string | null {
  if (closingGroupId !== activeGroupId) return null;
  const nextGroup = groups.find((group) => group.id !== closingGroupId);
  return nextGroup ? getGroupLandingHref(nextGroup) : "/chat";
}

function getThreadSummariesInGroups(
  groups: ChatGroupView[] | undefined,
): Map<string, ChatGroupThreadSummary> {
  const threads = new Map<string, ChatGroupThreadSummary>();
  for (const group of groups ?? []) {
    for (const thread of group.open_threads) {
      threads.set(thread.id, thread);
    }
    for (const thread of group.closed_threads) {
      threads.set(thread.id, thread);
    }
  }
  return threads;
}

export function reconcileThreadSummaryPatchesWithGroups(
  patches: ReadonlyMap<string, ThreadSummaryPatch>,
  groups: ChatGroupView[] | undefined,
): Map<string, ThreadSummaryPatch> {
  if (patches.size === 0) return patches as Map<string, ThreadSummaryPatch>;
  if (!groups) return patches as Map<string, ThreadSummaryPatch>;
  if (groups && groups.length === 0) return new Map();
  const refreshedThreads = getThreadSummariesInGroups(groups);
  if (refreshedThreads.size === 0) return new Map();

  let next: Map<string, ThreadSummaryPatch> | null = null;
  for (const [threadId, patch] of patches) {
    const refreshedThread = refreshedThreads.get(threadId);
    if (refreshedThread && refreshedThread.updated_at < patch.updatedAt) {
      continue;
    }
    next ??= new Map(patches);
    next.delete(threadId);
  }

  return next ?? (patches as Map<string, ThreadSummaryPatch>);
}

export function reconcileOptimisticUserMessageRecencyPatches(
  patches: ReadonlyMap<string, OptimisticUserMessageRecencyPatch>,
  snapshotVersion: number,
): Map<string, OptimisticUserMessageRecencyPatch> {
  if (patches.size === 0) {
    return patches as Map<string, OptimisticUserMessageRecencyPatch>;
  }
  let next: Map<string, OptimisticUserMessageRecencyPatch> | null = null;
  for (const [threadId, patch] of patches) {
    if (snapshotVersion <= patch.snapshotVersion) continue;
    next ??= new Map(patches);
    next.delete(threadId);
  }
  return next ?? (patches as Map<string, OptimisticUserMessageRecencyPatch>);
}

function isFinalChatGroupAvatarStatus(
  status: ChatGroupAvatarStatus | undefined,
): boolean {
  return status === "generated" || status === "user" || status === "default";
}

function isSameChatGroupAvatar(
  left: ChatGroupAvatar | null | undefined,
  right: ChatGroupAvatar | null | undefined,
): boolean {
  return (
    left?.color === right?.color &&
    left?.content === right?.content &&
    left?.status === right?.status
  );
}

export function reconcileGroupAvatarPatchesWithGroups(
  patches: ReadonlyMap<string, GroupAvatarPatch>,
  groups: ChatGroupView[] | undefined,
  now: number = Date.now(),
  options: { snapshotVersion?: number } = {},
): Map<string, GroupAvatarPatch> {
  if (patches.size === 0) return patches as Map<string, GroupAvatarPatch>;
  const groupsById = groups
    ? new Map(groups.map((group) => [group.id, group] as const))
    : null;

  let next: Map<string, GroupAvatarPatch> | null = null;
  for (const [groupId, patch] of patches) {
    const refreshedGroup = groupsById?.get(groupId);
    const isPendingPatch = patch.avatar.status === "pending";
    const isExpiredPendingPatch =
      isPendingPatch &&
      now - patch.updatedAt >= LOCAL_GROUP_AVATAR_PENDING_TIMEOUT_MS;

    if (isExpiredPendingPatch) {
      next ??= new Map(patches);
      next.delete(groupId);
      continue;
    }

    if (!refreshedGroup) continue;

    const refreshedAvatar = refreshedGroup.avatar;
    const snapshotCanResolvePatch =
      options.snapshotVersion === undefined ||
      patch.snapshotVersion === undefined ||
      options.snapshotVersion > patch.snapshotVersion;
    const shouldClearPatch =
      isSameChatGroupAvatar(refreshedAvatar, patch.avatar) ||
      (isPendingPatch &&
        snapshotCanResolvePatch &&
        isFinalChatGroupAvatarStatus(refreshedAvatar.status));
    if (!shouldClearPatch) continue;

    next ??= new Map(patches);
    next.delete(groupId);
  }

  return next ?? (patches as Map<string, GroupAvatarPatch>);
}

function isChatGroupAvatarStatus(value: unknown): value is ChatGroupAvatarStatus {
  return (
    value === "pending" ||
    value === "generated" ||
    value === "user" ||
    value === "default"
  );
}

function isChatGroupAvatar(value: unknown): value is ChatGroupAvatar {
  if (!value || typeof value !== "object") return false;
  const avatar = value as { color?: unknown; content?: unknown; status?: unknown };
  return (
    typeof avatar.color === "string" &&
    typeof avatar.content === "string" &&
    (avatar.status === undefined || isChatGroupAvatarStatus(avatar.status))
  );
}

export function applyLocalGroupAvatarPatches(
  source: ChatGroupView[],
  avatarPatches: ReadonlyMap<string, GroupAvatarPatch>,
): ChatGroupView[] {
  if (avatarPatches.size === 0) return source;
  let changed = false;
  const nextGroups = source.map((group) => {
    const patch = avatarPatches.get(group.id);
    if (!patch) return group;
    if (
      group.avatar.color === patch.avatar.color &&
      group.avatar.content === patch.avatar.content &&
      group.avatar.status === patch.avatar.status
    ) {
      return group;
    }
    changed = true;
    return {
      ...group,
      avatar: patch.avatar,
    };
  });
  return changed ? nextGroups : source;
}

export function reconcileGroupPinnedPatchesWithGroups(
  patches: ReadonlyMap<string, number | null>,
  groups: ChatGroupView[] | undefined,
): Map<string, number | null> {
  if (patches.size === 0 || !groups) {
    return patches as Map<string, number | null>;
  }

  const groupsById = new Map(groups.map((group) => [group.id, group] as const));
  let next: Map<string, number | null> | null = null;
  for (const [groupId, pinnedAt] of patches) {
    const refreshedGroup = groupsById.get(groupId);
    if (!refreshedGroup) continue;
    const pinStateMatches =
      (refreshedGroup.pinned_at !== null) === (pinnedAt !== null);
    if (!pinStateMatches) continue;
    next ??= new Map(patches);
    next.delete(groupId);
  }
  return next ?? (patches as Map<string, number | null>);
}

export function applyLocalGroupPinnedPatches(
  source: ChatGroupView[],
  pinnedPatches: ReadonlyMap<string, number | null>,
): ChatGroupView[] {
  if (pinnedPatches.size === 0) return source;
  let changed = false;
  const nextGroups = source.map((group) => {
    if (!pinnedPatches.has(group.id)) return group;
    const pinnedAt = pinnedPatches.get(group.id) ?? null;
    if (group.pinned_at === pinnedAt) return group;
    changed = true;
    return { ...group, pinned_at: pinnedAt };
  });
  return changed ? nextGroups : source;
}

export function applyExpiredPendingGroupAvatarFallbacks(
  source: ChatGroupView[],
  expiredPendingGroupIds: ReadonlySet<string>,
): ChatGroupView[] {
  if (expiredPendingGroupIds.size === 0) return source;
  let changed = false;
  const nextGroups = source.map((group) => {
    if (
      group.avatar.status !== "pending" ||
      !expiredPendingGroupIds.has(group.id)
    ) {
      return group;
    }
    changed = true;
    return {
      ...group,
      avatar: {
        ...group.avatar,
        status: "default" as const,
      },
    };
  });
  return changed ? nextGroups : source;
}

function getThreadSummaryPatchFromPayload(payload: unknown): ThreadSummaryPatch | null {
  if (!payload || typeof payload !== "object") return null;
  const thread = (payload as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object") return null;
  const record = thread as Record<string, unknown>;
  if (
    typeof record.title !== "string" ||
    typeof record.model !== "string" ||
    typeof record.updated_at !== "number" ||
    !Number.isFinite(record.updated_at)
  ) {
    return null;
  }

  return {
    title: record.title,
    model: record.model as ChatGroupThreadSummary["model"],
    firstUserMessage:
      typeof record.first_user_message === "string"
        ? record.first_user_message
        : record.first_user_message === null
          ? null
          : undefined,
    updatedAt: record.updated_at,
  };
}

function mergeThreadSummaryPatch(
  current: ReadonlyMap<string, ThreadSummaryPatch>,
  threadId: string,
  patch: ThreadSummaryPatch,
): Map<string, ThreadSummaryPatch> {
  const currentPatch = current.get(threadId);
  if (currentPatch && currentPatch.updatedAt > patch.updatedAt) {
    return current as Map<string, ThreadSummaryPatch>;
  }

  const nextPatch: ThreadSummaryPatch = {
    ...currentPatch,
    ...patch,
    updatedAt: Math.max(currentPatch?.updatedAt ?? 0, patch.updatedAt),
  };
  if (
    currentPatch?.title === nextPatch.title &&
    currentPatch?.model === nextPatch.model &&
    currentPatch?.firstUserMessage === nextPatch.firstUserMessage &&
    currentPatch?.updatedAt === nextPatch.updatedAt
  ) {
    return current as Map<string, ThreadSummaryPatch>;
  }

  const next = new Map(current);
  next.set(threadId, nextPatch);
  return next;
}

export function applyLiveRunningStatuses(
  source: ChatGroupView[],
  runningThreadIds: Set<string>,
  hasStatusSnapshot: boolean,
  activeThreadId: string | null = null,
  liveThreadStatuses: ReadonlyMap<string, ThreadStatusOverlay> = new Map(),
  threadSummaryPatches: ReadonlyMap<string, ThreadSummaryPatch> = new Map(),
): ChatGroupView[] {
  let changed = false;
  const nextGroups = source.map((group) => {
    const resolveThread = (
      thread: ChatGroupThreadSummary,
    ): ChatGroupThreadSummary => {
      const liveOverlay = liveThreadStatuses.get(thread.id);
      const liveMetadata = getOverlayMetadata(liveOverlay);
      const liveStatus = getOverlayStatus(liveOverlay);
      const status =
        liveStatus === "running" ||
        liveStatus === "unread" ||
        liveStatus === "idle"
          ? liveStatus
          : runningThreadIds.has(thread.id)
              ? "running" as const
              : hasStatusSnapshot && thread.status === "running"
                ? thread.is_unread
                  ? "unread" as const
                  : "idle" as const
                : thread.status;
      const resolvedStatus =
        thread.id === activeThreadId && status === "unread" ? "idle" : status;
      const summaryPatch = threadSummaryPatches.get(thread.id);
      const nextTitle = summaryPatch?.title ?? thread.title;
      const nextModel = summaryPatch?.model ?? thread.model;
      const firstUserMessage =
        liveMetadata?.firstUserMessage !== undefined
          ? liveMetadata.firstUserMessage
          : summaryPatch?.firstUserMessage !== undefined
            ? summaryPatch.firstUserMessage
            : undefined;
      const completedAt =
        typeof liveMetadata?.completedAt === "number" &&
        Number.isFinite(liveMetadata.completedAt)
          ? liveMetadata.completedAt
          : null;
      const latestUserMessage =
        liveMetadata?.latestUserMessage !== undefined
          ? liveMetadata.latestUserMessage
          : undefined;
      const runningActivityText =
        liveMetadata?.runningActivityText !== undefined
          ? liveMetadata.runningActivityText
          : undefined;
      const runningActivityAt =
        typeof liveMetadata?.runningActivityAt === "number" &&
        Number.isFinite(liveMetadata.runningActivityAt)
          ? liveMetadata.runningActivityAt
          : liveMetadata?.runningActivityAt === null
            ? null
            : undefined;
      const runningStartedAt =
        typeof liveMetadata?.runningStartedAt === "number" &&
        Number.isFinite(liveMetadata.runningStartedAt)
          ? liveMetadata.runningStartedAt
          : liveMetadata?.runningStartedAt === null
            ? null
            : undefined;
      const lastAssistantCompletedAt =
        completedAt !== null
          ? completedAt
          : thread.last_assistant_completed_at;
      const lastAssistantSummaryStatus =
        liveMetadata?.summaryStatus !== undefined
          ? liveMetadata.summaryStatus
          : thread.last_assistant_summary_status;
      const lastAssistantSummary =
        liveMetadata?.summary !== undefined
          ? liveMetadata.summary
          : thread.last_assistant_summary;
      const updatedAt =
        completedAt !== null
          ? Math.max(thread.updated_at, completedAt, summaryPatch?.updatedAt ?? 0)
          : Math.max(thread.updated_at, summaryPatch?.updatedAt ?? 0);
      const lastActiveAt = Math.max(
        thread.last_active_at,
        updatedAt,
        lastAssistantCompletedAt ?? 0,
        resolvedStatus === "running"
          ? (runningActivityAt ?? thread.running_activity_at ?? 0)
          : 0,
        resolvedStatus === "running"
          ? (runningStartedAt ?? thread.running_started_at ?? 0)
          : 0,
      );
      const nextIsUnread = resolvedStatus === "unread";
      const currentIsUnread = thread.is_unread ?? thread.status === "unread";
      const nextLatestUserMessage =
        latestUserMessage !== undefined
          ? latestUserMessage
          : thread.latest_user_message;
      const latestUserMessageAt =
        typeof liveMetadata?.latestUserMessageAt === "number" &&
        Number.isFinite(liveMetadata.latestUserMessageAt)
          ? liveMetadata.latestUserMessageAt
          : liveMetadata?.latestUserMessageAt === null
            ? null
            : undefined;
      const nextLatestUserMessageAt =
        latestUserMessageAt !== undefined
          ? latestUserMessageAt
          : thread.latest_user_message_at;
      const nextFirstUserMessage =
        firstUserMessage !== undefined
          ? firstUserMessage
          : thread.first_user_message;
      const nextRunningActivityText =
        resolvedStatus === "running"
          ? runningActivityText !== undefined
            ? runningActivityText
            : thread.running_activity_text
          : null;
      const nextRunningActivityAt =
        resolvedStatus === "running"
          ? runningActivityAt !== undefined
            ? runningActivityAt
            : thread.running_activity_at
          : null;
      const nextRunningStartedAt =
        resolvedStatus === "running"
          ? runningStartedAt !== undefined
            ? runningStartedAt
            : thread.running_started_at
          : null;

      if (
        thread.status === resolvedStatus &&
        currentIsUnread === nextIsUnread &&
        thread.title === nextTitle &&
        thread.model === nextModel &&
        thread.updated_at === updatedAt &&
        thread.last_active_at === lastActiveAt &&
        thread.last_assistant_completed_at === lastAssistantCompletedAt &&
        thread.last_assistant_summary === lastAssistantSummary &&
        thread.last_assistant_summary_status === lastAssistantSummaryStatus &&
        thread.first_user_message === nextFirstUserMessage &&
        thread.latest_user_message === nextLatestUserMessage &&
        thread.latest_user_message_at === nextLatestUserMessageAt &&
        thread.running_activity_text === nextRunningActivityText &&
        thread.running_activity_at === nextRunningActivityAt &&
        thread.running_started_at === nextRunningStartedAt
      ) {
        return thread;
      }

      changed = true;
      return {
        ...thread,
        title: nextTitle,
        model: nextModel,
        updated_at: updatedAt,
        is_unread: nextIsUnread,
        status: resolvedStatus,
        last_active_at: lastActiveAt,
        last_assistant_completed_at: lastAssistantCompletedAt,
        last_assistant_summary: lastAssistantSummary,
        last_assistant_summary_status: lastAssistantSummaryStatus,
        first_user_message: nextFirstUserMessage,
        latest_user_message: nextLatestUserMessage,
        latest_user_message_at: nextLatestUserMessageAt,
        running_activity_text: nextRunningActivityText,
        running_activity_at: nextRunningActivityAt,
        running_started_at: nextRunningStartedAt,
      };
    };
    let openThreadsChanged = false;
    let closedThreadsChanged = false;
    const open_threads = group.open_threads.map((thread) => {
      const nextThread = resolveThread(thread);
      if (nextThread !== thread) openThreadsChanged = true;
      return nextThread;
    });
    const closed_threads = group.closed_threads.map((thread) => {
      const nextThread = resolveThread(thread);
      if (nextThread !== thread) closedThreadsChanged = true;
      return nextThread;
    });
    const nextStatus = maxThreadStatus([
      ...open_threads.map((thread) => thread.status),
      ...closed_threads.map((thread) => thread.status),
    ]);
    const nextName = resolveGroupNameAfterThreadPatches(
      group,
      open_threads,
      closed_threads,
    );

    if (
      !openThreadsChanged &&
      !closedThreadsChanged &&
      group.status === nextStatus &&
      group.name === nextName
    ) {
      return group;
    }

    changed = true;
    return {
      ...group,
      name: nextName,
      open_threads: openThreadsChanged ? open_threads : group.open_threads,
      closed_threads: closedThreadsChanged ? closed_threads : group.closed_threads,
      status: nextStatus,
    };
  });

  return changed ? nextGroups : source;
}

export function ChatGroupsProvider({
  children,
  disableLiveStatus = false,
}: {
  children: ReactNode;
  disableLiveStatus?: boolean;
}) {
  const { currentWorkspace } = useAuthData();
  const revalidator = useRevalidator();
  // App-shell version-skew watch: this provider is mounted on every non-embed
  // page, so it is the only place a tab that never opens a chat can notice it
  // is running a retired bundle.
  const runVersionSkewCheck = useVersionSkewWatch();
  const runVersionSkewCheckRef = useLatestRef(runVersionSkewCheck);
  const chatDebugFlags = getChatDebugFlags();
  const statusSocketEnabled = !disableLiveStatus && chatDebugFlags.statusSocket;
  const statusRevalidateEnabled = !disableLiveStatus && chatDebugFlags.statusRevalidate;
  const markViewedEnabled = !disableLiveStatus && chatDebugFlags.markViewed;
  const revalidateRef = useLatestRef(revalidator.revalidate);
  const data = useRouteLoaderData("routes/_app") as
    | AppChatGroupsLoaderData
    | undefined;
  const rawChatGroups = data?.chatGroups;
  const currentWorkspaceId = currentWorkspace?.id ?? null;
  const [resolvedChatGroups, setResolvedChatGroups] = useState<
    ChatGroupView[] | null
  >(() => (Array.isArray(rawChatGroups) ? rawChatGroups : null));
  const rawChatGroupsRef = useRef(rawChatGroups);
  const resolvedChatGroupsSnapshotVersionRef = useRef(0);
  const [isChatGroupsLoading, setIsChatGroupsLoading] = useState(() =>
    isPromiseLike(rawChatGroups),
  );
  const previousWorkspaceIdRef = useRef(currentWorkspaceId);
  const matches = useMatches();
  const activeThreadId = getActiveThreadIdFromMatches(matches);
  const activeThreadIdRef = useLatestRef(activeThreadId);
  const [liveThreadStatuses, setLiveThreadStatuses] = useState<
    Map<string, LiveThreadMetadata>
  >(
    () => new Map(),
  );
  const [localThreadStatuses, setLocalThreadStatuses] = useState<
    Map<string, LiveThreadMetadata>
  >(() => new Map());
  const [localThreadSummaryPatches, setLocalThreadSummaryPatches] = useState<
    Map<string, ThreadSummaryPatch>
  >(() => new Map());
  const [optimisticUserMessageRecencyPatches, setOptimisticUserMessageRecencyPatches] =
    useState<Map<string, OptimisticUserMessageRecencyPatch>>(() => new Map());
  const [localGroupAvatarPatches, setLocalGroupAvatarPatches] = useState<
    Map<string, GroupAvatarPatch>
  >(() => new Map());
  const [localGroupPinnedPatches, setLocalGroupPinnedPatches] = useState<
    Map<string, number | null>
  >(() => new Map());
  const [expiredPendingGroupAvatarIds, setExpiredPendingGroupAvatarIds] = useState<
    Set<string>
  >(() => new Set());
  const liveThreadStatusesRef = useLatestRef(liveThreadStatuses);
  const localThreadStatusesRef = useLatestRef(localThreadStatuses);
  const pendingGroupAvatarStartedAtRef = useRef<Map<string, number>>(new Map());
  const hasPendingCompletionSummariesRef = useLatestRef(
    hasPendingCompletionSummaries(resolvedChatGroups),
  );
  const [hasStatusSnapshot, setHasStatusSnapshot] = useState(false);
  const resolvedThreadStatuses = useMemo(
    () => mergeLiveAndLocalThreadStatuses(liveThreadStatuses, localThreadStatuses),
    [liveThreadStatuses, localThreadStatuses],
  );
  const runningThreadIds = useMemo(
    () =>
      new Set(
        Array.from(resolvedThreadStatuses)
          .filter(([, metadata]) => metadata.status === "running")
          .map(([threadId]) => threadId),
      ),
    [resolvedThreadStatuses],
  );

  useEffect(() => {
    if (!activeThreadId) return;
    setLiveThreadStatuses((current) => {
      const currentMetadata = current.get(activeThreadId);
      if (currentMetadata?.status !== "unread") return current;
      const next = new Map(current);
      next.set(activeThreadId, { ...currentMetadata, status: "idle" });
      return next;
    });
    setLocalThreadStatuses((current) => {
      const currentMetadata = current.get(activeThreadId);
      if (currentMetadata?.status !== "unread") return current;
      const next = new Map(current);
      next.set(activeThreadId, { ...currentMetadata, status: "idle" });
      return next;
    });
  }, [activeThreadId]);

  useEffect(() => {
    setLocalThreadSummaryPatches((current) =>
      reconcileThreadSummaryPatchesWithGroups(
        current,
        resolvedChatGroups ?? undefined,
      ),
    );
    setOptimisticUserMessageRecencyPatches((current) =>
      reconcileOptimisticUserMessageRecencyPatches(
        current,
        resolvedChatGroupsSnapshotVersionRef.current,
      ),
    );
    setLocalGroupAvatarPatches((current) =>
      reconcileGroupAvatarPatchesWithGroups(
        current,
        resolvedChatGroups ?? undefined,
        Date.now(),
        { snapshotVersion: resolvedChatGroupsSnapshotVersionRef.current },
      ),
    );
    setLocalGroupPinnedPatches((current) =>
      reconcileGroupPinnedPatchesWithGroups(
        current,
        resolvedChatGroups ?? undefined,
      ),
    );
  }, [resolvedChatGroups]);

  useEffect(() => {
    if (
      !currentWorkspaceId ||
      resolvedChatGroups === null ||
      resolvedChatGroups.some(
        (group) => group.workspace_id !== currentWorkspaceId,
      )
    ) {
      return;
    }
    writePinnedGroupCountHint(
      currentWorkspaceId,
      resolvedChatGroups.filter((group) => group.pinned_at !== null).length,
    );
  }, [currentWorkspaceId, resolvedChatGroups]);

  useEffect(() => {
    if (typeof window === "undefined" || localGroupAvatarPatches.size === 0) {
      return;
    }

    const now = Date.now();
    const nextExpirationAt = Array.from(localGroupAvatarPatches.values())
      .filter((patch) => patch.avatar.status === "pending")
      .map((patch) => patch.updatedAt + LOCAL_GROUP_AVATAR_PENDING_TIMEOUT_MS)
      .sort((left, right) => left - right)[0];
    if (nextExpirationAt === undefined) return;

    const timeout = window.setTimeout(() => {
      setLocalGroupAvatarPatches((current) =>
        reconcileGroupAvatarPatchesWithGroups(
          current,
          resolvedChatGroups ?? undefined,
          Date.now(),
        ),
      );
    }, Math.max(0, nextExpirationAt - now) + 10);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [localGroupAvatarPatches, resolvedChatGroups]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleLocalGroupAvatar = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const payload = detail as {
        groupId?: unknown;
        avatar?: unknown;
        updatedAt?: unknown;
      };
      if (typeof payload.groupId !== "string" || !isChatGroupAvatar(payload.avatar)) {
        return;
      }
      const updatedAt =
        typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
          ? payload.updatedAt
          : Date.now();
      setLocalGroupAvatarPatches((current) => {
        const currentPatch = current.get(payload.groupId as string);
        if (currentPatch && currentPatch.updatedAt > updatedAt) return current;
        const avatar = payload.avatar as ChatGroupAvatar;
        if (
          currentPatch?.avatar.color === avatar.color &&
          currentPatch.avatar.content === avatar.content &&
          currentPatch.avatar.status === avatar.status &&
          currentPatch.updatedAt === updatedAt
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(payload.groupId as string, {
          avatar,
          updatedAt,
          snapshotVersion: resolvedChatGroupsSnapshotVersionRef.current,
        });
        return next;
      });
    };

    window.addEventListener("camelai:chat-group-avatar", handleLocalGroupAvatar);
    return () => {
      window.removeEventListener("camelai:chat-group-avatar", handleLocalGroupAvatar);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleLocalGroupPinned = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const payload = detail as { groupId?: unknown; pinnedAt?: unknown };
      if (
        typeof payload.groupId !== "string" ||
        (payload.pinnedAt !== null &&
          (typeof payload.pinnedAt !== "number" ||
            !Number.isFinite(payload.pinnedAt)))
      ) {
        return;
      }
      const pinnedAt = payload.pinnedAt as number | null;
      setLocalGroupPinnedPatches((current) => {
        if (current.has(payload.groupId as string)) {
          const currentPinnedAt = current.get(payload.groupId as string) ?? null;
          if (currentPinnedAt === pinnedAt) return current;
        }
        const next = new Map(current);
        next.set(payload.groupId as string, pinnedAt);
        return next;
      });
    };

    window.addEventListener("camelai:chat-group-pinned", handleLocalGroupPinned);
    return () => {
      window.removeEventListener(
        "camelai:chat-group-pinned",
        handleLocalGroupPinned,
      );
    };
  }, []);

  useEffect(() => {
    const workspaceChanged = previousWorkspaceIdRef.current !== currentWorkspaceId;
    previousWorkspaceIdRef.current = currentWorkspaceId;
    if (workspaceChanged) {
      setOptimisticUserMessageRecencyPatches(new Map());
      setLocalGroupPinnedPatches(new Map());
    }
    const markRawSnapshotChanged = () => {
      if (rawChatGroupsRef.current === rawChatGroups) return;
      rawChatGroupsRef.current = rawChatGroups;
      resolvedChatGroupsSnapshotVersionRef.current += 1;
    };

    if (Array.isArray(rawChatGroups)) {
      markRawSnapshotChanged();
      setIsChatGroupsLoading(false);
      setResolvedChatGroups(rawChatGroups);
      return;
    }
    if (!isPromiseLike(rawChatGroups)) {
      markRawSnapshotChanged();
      setIsChatGroupsLoading(false);
      setResolvedChatGroups([]);
      return;
    }

    let cancelled = false;
    setIsChatGroupsLoading(true);
    if (workspaceChanged) {
      setResolvedChatGroups(null);
      setLocalGroupAvatarPatches(new Map());
      setLocalGroupPinnedPatches(new Map());
      setExpiredPendingGroupAvatarIds(new Set());
      pendingGroupAvatarStartedAtRef.current.clear();
    }
    rawChatGroups
      .then((groups) => {
        if (!cancelled) {
          resolvedChatGroupsSnapshotVersionRef.current += 1;
          setResolvedChatGroups(groups);
          setIsChatGroupsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolvedChatGroups((current) => {
            if (!workspaceChanged && current && current.length > 0) {
              return current;
            }
            return [];
          });
          setIsChatGroupsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, rawChatGroups]);

  const markThreadIdle = useCallback((threadId: string) => {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return;
    setLocalThreadStatuses((current) => {
      const currentStatus =
        current.get(normalizedThreadId) ??
        liveThreadStatusesRef.current.get(normalizedThreadId);
      const status = currentStatus?.status;
      if (status === "running" || status === "idle") {
        return current;
      }
      const next = new Map(current);
      next.set(
        normalizedThreadId,
        mergeThreadMetadata(currentStatus, {
          status: "idle",
          statusChangedAt: Date.now(),
        }),
      );
      return next;
    });
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleLocalThreadStatus = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const payload = detail as {
        threadId?: unknown;
        status?: unknown;
        title?: unknown;
        model?: unknown;
        updatedAt?: unknown;
        firstUserMessage?: unknown;
        latestUserMessage?: unknown;
        latestUserMessageAt?: unknown;
        runningActivityText?: unknown;
        runningActivityAt?: unknown;
        runningStartedAt?: unknown;
      };
      if (
        typeof payload.threadId !== "string" ||
        (payload.status !== undefined &&
          payload.status !== "idle" &&
          payload.status !== "running")
      ) {
        return;
      }
      const threadId = payload.threadId;
      const status =
        payload.status === "idle" || payload.status === "running"
          ? payload.status
          : null;
      const title =
        typeof payload.title === "string" ? payload.title.trim() : undefined;
      const model = typeof payload.model === "string" ? payload.model : undefined;
      if (title || model) {
        setLocalThreadSummaryPatches((current) => {
          const currentPatch = current.get(threadId);
          const updatedAt =
            typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? payload.updatedAt
              : Date.now();
          if (currentPatch && currentPatch.updatedAt > updatedAt) {
            return current;
          }
          return mergeThreadSummaryPatch(current, threadId, {
            ...(title ? { title } : {}),
            ...(model ? { model: model as ChatGroupThreadSummary["model"] } : {}),
            updatedAt,
          });
        });
      }
      if (!status) return;
      const latestUserMessage =
        typeof payload.latestUserMessage === "string"
          ? payload.latestUserMessage
          : payload.latestUserMessage === null
            ? null
            : undefined;
      const firstUserMessage =
        typeof payload.firstUserMessage === "string"
          ? payload.firstUserMessage
          : payload.firstUserMessage === null
            ? null
            : undefined;
      const latestUserMessageAt =
        typeof payload.latestUserMessageAt === "number" &&
        Number.isFinite(payload.latestUserMessageAt)
          ? payload.latestUserMessageAt
          : payload.latestUserMessageAt === null
            ? null
            : undefined;
      if (typeof latestUserMessageAt === "number") {
        setOptimisticUserMessageRecencyPatches((current) => {
          const existing = current.get(threadId);
          if (existing && existing.sentAt >= latestUserMessageAt) return current;
          const next = new Map(current);
          next.set(threadId, {
            sentAt: latestUserMessageAt,
            snapshotVersion: resolvedChatGroupsSnapshotVersionRef.current,
          });
          return next;
        });
      }
      const runningActivityText =
        typeof payload.runningActivityText === "string"
          ? payload.runningActivityText
          : payload.runningActivityText === null
            ? null
            : undefined;
      const runningActivityAt =
        typeof payload.runningActivityAt === "number" &&
        Number.isFinite(payload.runningActivityAt)
          ? payload.runningActivityAt
          : payload.runningActivityAt === null
            ? null
            : undefined;
      const runningStartedAt =
        typeof payload.runningStartedAt === "number" &&
        Number.isFinite(payload.runningStartedAt)
          ? payload.runningStartedAt
          : payload.runningStartedAt === null
            ? null
            : undefined;
      if (
        markViewedEnabled &&
        shouldMarkActiveIdleThreadViewed(status, threadId, activeThreadIdRef.current)
      ) {
        void markThreadViewed(threadId);
      }

      setLocalThreadStatuses((current) => {
        const existing = current.get(threadId);
        if (
          existing?.status === status &&
          (latestUserMessage === undefined ||
            existing.latestUserMessage === latestUserMessage) &&
          (firstUserMessage === undefined ||
            existing.firstUserMessage === firstUserMessage) &&
          (latestUserMessageAt === undefined ||
            existing.latestUserMessageAt === latestUserMessageAt) &&
          (runningActivityText === undefined ||
            existing.runningActivityText === runningActivityText) &&
          (runningActivityAt === undefined ||
            existing.runningActivityAt === runningActivityAt) &&
          (runningStartedAt === undefined ||
            existing.runningStartedAt === runningStartedAt)
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(
          threadId,
          mergeThreadMetadata(existing, {
            status,
            statusChangedAt: Date.now(),
            ...(firstUserMessage === undefined ? {} : { firstUserMessage }),
            ...(latestUserMessage === undefined ? {} : { latestUserMessage }),
            ...(latestUserMessageAt === undefined ? {} : { latestUserMessageAt }),
            ...(runningActivityText === undefined ? {} : { runningActivityText }),
            ...(runningActivityAt === undefined ? {} : { runningActivityAt }),
            ...(runningStartedAt === undefined ? {} : { runningStartedAt }),
          }),
        );
        return next;
      });
    };

    window.addEventListener("camelai:thread-status", handleLocalThreadStatus);
    return () => {
      window.removeEventListener("camelai:thread-status", handleLocalThreadStatus);
    };
  }, [markViewedEnabled]);

  useLayoutEffect(() => {
    const workspaceId = currentWorkspace?.id;
    if (!statusSocketEnabled || !workspaceId || typeof window === "undefined") {
      setLiveThreadStatuses(new Map());
      setLocalThreadStatuses(new Map());
      setLocalThreadSummaryPatches(new Map());
      setOptimisticUserMessageRecencyPatches(new Map());
      setLocalGroupAvatarPatches(new Map());
      setExpiredPendingGroupAvatarIds(new Set());
      pendingGroupAvatarStartedAtRef.current.clear();
      setHasStatusSnapshot(false);
      return;
    }

    const streamUrl = `/api/workspaces/${encodeURIComponent(workspaceId)}/status/stream`;
    let revalidateTimer: number | null = null;
    const metadataRefreshTimers = new Map<string, number>();
    let closedByEffect = false;

    const scheduleStatusRevalidate = (
      threadId: string,
      options: { includeActive?: boolean } = {},
    ) => {
      if (!statusRevalidateEnabled) return;
      if (!options.includeActive && threadId === activeThreadIdRef.current) return;
      if (revalidateTimer !== null) return;
      revalidateTimer = window.setTimeout(() => {
        revalidateTimer = null;
        revalidateRef.current();
      }, 750);
    };
    const scheduleStatusSnapshotRevalidate = () => {
      if (!statusRevalidateEnabled) return;
      if (revalidateTimer !== null) return;
      revalidateTimer = window.setTimeout(() => {
        revalidateTimer = null;
        revalidateRef.current();
      }, 750);
    };
    const refreshThreadSummary = async (threadId: string) => {
      try {
        const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`);
        if (!response.ok || closedByEffect) return;
        const patch = getThreadSummaryPatchFromPayload(await response.json());
        if (!patch || closedByEffect) return;
        setLocalThreadSummaryPatches((current) =>
          mergeThreadSummaryPatch(current, threadId, patch),
        );
      } catch {
        // The next loader refresh will catch up if this narrow metadata fetch fails.
      }
    };
    const scheduleThreadSummaryRefresh = (threadId: string) => {
      if (threadId === activeThreadIdRef.current) return;
      if (metadataRefreshTimers.has(threadId)) return;
      const timer = window.setTimeout(() => {
        metadataRefreshTimers.delete(threadId);
        void refreshThreadSummary(threadId);
      }, 750);
      metadataRefreshTimers.set(threadId, timer);
    };
    const markActiveThreadViewed = (threadId: string) => {
      if (!markViewedEnabled) return;
      void markThreadViewed(threadId);
    };

    const handleStatusMessage = (data: string) => {
      try {
        const payload = JSON.parse(data) as {
          type?: unknown;
          runningThreadIds?: unknown;
          runningThreads?: unknown;
          threadId?: unknown;
          status?: unknown;
          completedAt?: unknown;
          summaryStatus?: unknown;
          summary?: unknown;
          runningActivityText?: unknown;
          runningActivityAt?: unknown;
          runningStartedAt?: unknown;
        };
        if (
          payload.type === "thread_status_snapshot" &&
          (Array.isArray(payload.runningThreadIds) ||
            Array.isArray(payload.runningThreads))
        ) {
          setHasStatusSnapshot(true);
          const fallbackRunningThreadIds = Array.isArray(payload.runningThreadIds)
            ? payload.runningThreadIds.filter(
                (threadId): threadId is string => typeof threadId === "string",
              )
            : [];
          type RunningThreadSnapshot = {
            threadId: string;
            runningActivityText?: string | null;
            runningActivityAt?: number | null;
            runningStartedAt?: number | null;
          };
          const parsedRunningThreads: RunningThreadSnapshot[] = Array.isArray(payload.runningThreads)
            ? payload.runningThreads.flatMap((entry) => {
                if (!entry || typeof entry !== "object") return [];
                const record = entry as {
                  threadId?: unknown;
                  startedAt?: unknown;
                  runningActivityText?: unknown;
                  latestActivityText?: unknown;
                  runningActivityAt?: unknown;
                  latestActivityAt?: unknown;
                };
                if (typeof record.threadId !== "string") return [];
                const runningActivityText =
                  typeof record.runningActivityText === "string"
                    ? record.runningActivityText
                    : typeof record.latestActivityText === "string"
                      ? record.latestActivityText
                      : record.runningActivityText === null ||
                          record.latestActivityText === null
                        ? null
                        : undefined;
                const runningActivityAt =
                  typeof record.runningActivityAt === "number" &&
                  Number.isFinite(record.runningActivityAt)
                    ? record.runningActivityAt
                    : typeof record.latestActivityAt === "number" &&
                        Number.isFinite(record.latestActivityAt)
                      ? record.latestActivityAt
                      : record.runningActivityAt === null ||
                          record.latestActivityAt === null
                        ? null
                        : undefined;
                const runningStartedAt =
                  typeof record.startedAt === "number" &&
                  Number.isFinite(record.startedAt)
                    ? record.startedAt
                    : undefined;
                return [
                  {
                    threadId: record.threadId,
                    runningActivityText,
                    runningActivityAt,
                    runningStartedAt,
                  },
                ];
              })
            : [];
          const nextRunningThreads: RunningThreadSnapshot[] =
            parsedRunningThreads.length > 0
              ? parsedRunningThreads
              : fallbackRunningThreadIds.map((threadId) => ({ threadId }));
          const nextRunningThreadIds = nextRunningThreads.map(
            (thread) => thread.threadId,
          );
          const nextRunningThreadIdSet = new Set(nextRunningThreadIds);
          const snapshotReceivedAt = Date.now();
          const nextRunningStartedAts = new Map(
            nextRunningThreads.map((thread) => [
              thread.threadId,
              thread.runningStartedAt ?? null,
            ]),
          );
          const staleRunningThreadIds =
            getThreadIdsRequiringSnapshotRevalidation(
              liveThreadStatusesRef.current,
              localThreadStatusesRef.current,
              nextRunningThreadIdSet,
              activeThreadIdRef.current,
            );
          setLiveThreadStatuses((current) => {
            const next = new Map(current);
            for (const [threadId, metadata] of next) {
              if (metadata.status === "running") next.delete(threadId);
            }
            for (const thread of nextRunningThreads) {
              next.set(thread.threadId, {
                status: "running",
                // Stamp with the run's server-side start so a stale snapshot
                // row loses to a local not-running write made after that run
                // began (the client watched that same run finish).
                statusChangedAt: thread.runningStartedAt ?? snapshotReceivedAt,
                ...(thread.runningActivityText === undefined
                  ? {}
                  : { runningActivityText: thread.runningActivityText }),
                ...(thread.runningActivityAt === undefined
                  ? {}
                  : { runningActivityAt: thread.runningActivityAt }),
                ...(thread.runningStartedAt === undefined
                  ? {}
                  : { runningStartedAt: thread.runningStartedAt }),
              });
            }
            return next;
          });
          setLocalThreadStatuses((current) =>
            reconcileLocalThreadStatusesWithSnapshot(
              current,
              nextRunningThreadIdSet,
              nextRunningStartedAts,
            ),
          );
          if (staleRunningThreadIds.length > 0) {
            scheduleStatusRevalidate(staleRunningThreadIds[0]);
            for (const threadId of staleRunningThreadIds) {
              scheduleThreadSummaryRefresh(threadId);
            }
          } else if (hasPendingCompletionSummariesRef.current) {
            scheduleStatusSnapshotRevalidate();
          }
        }
        if (
          payload.type === "thread_status" &&
          typeof payload.threadId === "string" &&
          (payload.status === "idle" ||
            payload.status === "running" ||
            payload.status === "unread")
        ) {
          const threadId = payload.threadId;
          const payloadStatus = payload.status as ThreadStatus;
          const isActiveUnread = shouldMarkActiveUnreadThreadViewed(
            payloadStatus,
            threadId,
            activeThreadIdRef.current,
          );
          if (isActiveUnread) {
            markActiveThreadViewed(threadId);
          }
          const status = isActiveUnread ? "idle" : payloadStatus;
          const completedAt =
            typeof payload.completedAt === "number" &&
            Number.isFinite(payload.completedAt)
              ? payload.completedAt
              : undefined;
          const summaryStatus =
            payload.summaryStatus === "pending" ||
            payload.summaryStatus === "ready" ||
            payload.summaryStatus === "failed"
              ? payload.summaryStatus
              : undefined;
          const summary =
            typeof payload.summary === "string"
              ? payload.summary
              : payload.summary === null
                ? null
                : undefined;
          const runningActivityText =
            typeof payload.runningActivityText === "string"
              ? payload.runningActivityText
              : payload.runningActivityText === null
                ? null
                : undefined;
          const runningActivityAt =
            typeof payload.runningActivityAt === "number" &&
            Number.isFinite(payload.runningActivityAt)
              ? payload.runningActivityAt
              : payload.runningActivityAt === null
                ? null
                : undefined;
          const runningStartedAt =
            typeof payload.runningStartedAt === "number" &&
            Number.isFinite(payload.runningStartedAt)
              ? payload.runningStartedAt
              : payload.runningStartedAt === null
                ? null
                : undefined;
          const existingMetadata =
            localThreadStatusesRef.current.get(threadId) ??
            liveThreadStatusesRef.current.get(threadId);
          const hasMetadataOnlyUpdate =
            summaryStatus !== undefined ||
            summary !== undefined ||
            runningActivityText !== undefined ||
            runningActivityAt !== undefined ||
            runningStartedAt !== undefined;
          const hasSummaryMetadataUpdate =
            summaryStatus !== undefined || summary !== undefined;
          const isMetadataOnlyUpdate =
            hasMetadataOnlyUpdate &&
            existingMetadata?.status === status &&
            (completedAt === undefined ||
              existingMetadata.completedAt === completedAt);
          const frameReceivedAt = Date.now();
          setHasStatusSnapshot(true);
          setLiveThreadStatuses((current) => {
            const existing = current.get(threadId);
            if (
              existing?.status === status &&
              (completedAt === undefined || existing.completedAt === completedAt) &&
              (summaryStatus === undefined || existing.summaryStatus === summaryStatus) &&
              (summary === undefined || existing.summary === summary) &&
              (runningActivityText === undefined ||
                existing.runningActivityText === runningActivityText) &&
              (runningActivityAt === undefined ||
                existing.runningActivityAt === runningActivityAt) &&
              (runningStartedAt === undefined ||
                existing.runningStartedAt === runningStartedAt)
            ) {
              return current;
            }
            const next = new Map(current);
            next.set(
              threadId,
              mergeThreadMetadata(existing, {
                status,
                statusChangedAt: frameReceivedAt,
                ...(completedAt === undefined ? {} : { completedAt }),
                ...(summaryStatus === undefined ? {} : { summaryStatus }),
                ...(summary === undefined ? {} : { summary }),
                ...(runningActivityText === undefined ? {} : { runningActivityText }),
                ...(runningActivityAt === undefined ? {} : { runningActivityAt }),
                ...(runningStartedAt === undefined ? {} : { runningStartedAt }),
              }),
            );
            return next;
          });
          setLocalThreadStatuses((current) => {
            const existing = current.get(threadId);
            if (
              existing?.status === status &&
              (completedAt === undefined || existing.completedAt === completedAt) &&
              (summaryStatus === undefined || existing.summaryStatus === summaryStatus) &&
              (summary === undefined || existing.summary === summary) &&
              (runningActivityText === undefined ||
                existing.runningActivityText === runningActivityText) &&
              (runningActivityAt === undefined ||
                existing.runningActivityAt === runningActivityAt) &&
              (runningStartedAt === undefined ||
                existing.runningStartedAt === runningStartedAt)
            ) {
              return current;
            }
            const next = new Map(current);
            next.set(
              threadId,
              mergeThreadMetadata(existing, {
                status,
                statusChangedAt: frameReceivedAt,
                ...(completedAt === undefined ? {} : { completedAt }),
                ...(summaryStatus === undefined ? {} : { summaryStatus }),
                ...(summary === undefined ? {} : { summary }),
                ...(runningActivityText === undefined ? {} : { runningActivityText }),
                ...(runningActivityAt === undefined ? {} : { runningActivityAt }),
                ...(runningStartedAt === undefined ? {} : { runningStartedAt }),
              }),
            );
            return next;
          });
          if (status === "idle" || status === "unread") {
            scheduleThreadSummaryRefresh(threadId);
          }
          if (
            shouldRevalidateThreadStatusUpdate(
              status,
              isMetadataOnlyUpdate,
              hasSummaryMetadataUpdate,
            )
          ) {
            scheduleStatusRevalidate(threadId, {
              includeActive: hasSummaryMetadataUpdate,
            });
          }
        }
      } catch {
        // Ignore malformed status frames.
      }
    };

    // Same-origin session cookies ride the fetch; the reader loop owns
    // reconnect/backoff and close() aborts it without a further attempt. Every
    // (re)attach re-receives the snapshot, which is the only resync mechanism.
    const stream = workspaceStatusStream.open({
      url: streamUrl,
      onMessage: handleStatusMessage,
      // A status stream that cannot attach is the app-shell signal that this
      // tab may be running a bundle whose transport the server retired; the
      // check is throttled internally, so a backoff loop cannot spam it.
      onAttachFailure: () => {
        runVersionSkewCheckRef.current("status_stream_error");
      },
    });

    return () => {
      closedByEffect = true;
      if (revalidateTimer) window.clearTimeout(revalidateTimer);
      for (const timer of metadataRefreshTimers.values()) {
        window.clearTimeout(timer);
      }
      metadataRefreshTimers.clear();
      stream.close();
    };
  }, [
    currentWorkspace?.id,
    markViewedEnabled,
    statusRevalidateEnabled,
    statusSocketEnabled,
  ]);

  const groupsBeforePendingExpiry = useMemo(() => {
    const loaderGroups = resolvedChatGroups ?? [];
    const activeGroup = getActiveChatGroupFromMatches(matches);
    const activeGroupWasMissing =
      activeGroup !== null &&
      !loaderGroups.some((group) => group.id === activeGroup.id);
    const source = mergeActiveChatGroup(loaderGroups, activeGroup);
    const avatarPatchedSource = applyLocalGroupAvatarPatches(
      source,
      localGroupAvatarPatches,
    );
    const pinnedPatchedSource = applyLocalGroupPinnedPatches(
      avatarPatchedSource,
      localGroupPinnedPatches,
    );
    const withLiveStatuses = applyLiveRunningStatuses(
      pinnedPatchedSource,
      runningThreadIds,
      hasStatusSnapshot,
      activeThreadId,
      resolvedThreadStatuses,
      localThreadSummaryPatches,
    );
    // Sorting must run last: the snapshot-bounded optimistic recency overlay
    // lets a local send run ahead of the server key without mutating canonical
    // timestamps. Keep the active group first only when it is missing from
    // the LIMIT-bounded loader list (mergeActiveChatGroup prepends it); a strict
    // recency sort would sink it below the fold.
    return orderChatGroupsForDisplay(
      withLiveStatuses,
      activeGroupWasMissing ? activeGroup.id : null,
      optimisticUserMessageRecencyPatches,
    );
  }, [
    activeThreadId,
    hasStatusSnapshot,
    localGroupAvatarPatches,
    localGroupPinnedPatches,
    localThreadSummaryPatches,
    matches,
    optimisticUserMessageRecencyPatches,
    resolvedChatGroups,
    resolvedThreadStatuses,
    runningThreadIds,
  ]);

  const groups = useMemo(
    () =>
      applyExpiredPendingGroupAvatarFallbacks(
        groupsBeforePendingExpiry,
        expiredPendingGroupAvatarIds,
      ),
    [expiredPendingGroupAvatarIds, groupsBeforePendingExpiry],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const now = Date.now();
    const pendingGroupIds = new Set(
      groupsBeforePendingExpiry
        .filter((group) => group.avatar.status === "pending")
        .map((group) => group.id),
    );
    const startedAtByGroupId = pendingGroupAvatarStartedAtRef.current;

    if (pendingGroupIds.size === 0) {
      startedAtByGroupId.clear();
      setExpiredPendingGroupAvatarIds((current) =>
        current.size === 0 ? current : new Set(),
      );
      return;
    }

    for (const groupId of Array.from(startedAtByGroupId.keys())) {
      if (!pendingGroupIds.has(groupId)) startedAtByGroupId.delete(groupId);
    }

    setExpiredPendingGroupAvatarIds((current) => {
      let next: Set<string> | null = null;
      for (const groupId of current) {
        if (pendingGroupIds.has(groupId)) continue;
        next ??= new Set(current);
        next.delete(groupId);
      }
      return next ?? current;
    });

    let nextRevalidateAt: number | null = null;
    let expiredNow = false;
    for (const groupId of pendingGroupIds) {
      if (expiredPendingGroupAvatarIds.has(groupId)) continue;
      const startedAt = startedAtByGroupId.get(groupId) ?? now;
      startedAtByGroupId.set(groupId, startedAt);
      const expiresAt = startedAt + PENDING_GROUP_AVATAR_REVALIDATE_MAX_MS;
      if (now >= expiresAt) {
        expiredNow = true;
        setExpiredPendingGroupAvatarIds((current) => {
          if (current.has(groupId)) return current;
          const next = new Set(current);
          next.add(groupId);
          return next;
        });
        continue;
      }
      nextRevalidateAt =
        nextRevalidateAt === null ? expiresAt : Math.min(nextRevalidateAt, expiresAt);
    }

    if (expiredNow) {
      revalidateRef.current();
      return;
    }

    const pendingGroupIdsToPoll = Array.from(pendingGroupIds).filter(
      (groupId) => !expiredPendingGroupAvatarIds.has(groupId),
    );
    if (pendingGroupIdsToPoll.length === 0) return;

    const timeout = window.setTimeout(() => {
      const timeoutNow = Date.now();
      let expiredAtTimeout = false;
      setExpiredPendingGroupAvatarIds((current) => {
        let next: Set<string> | null = null;
        for (const groupId of pendingGroupIdsToPoll) {
          const startedAt = startedAtByGroupId.get(groupId);
          if (
            startedAt === undefined ||
            timeoutNow - startedAt < PENDING_GROUP_AVATAR_REVALIDATE_MAX_MS ||
            current.has(groupId)
          ) {
            continue;
          }
          next ??= new Set(current);
          next.add(groupId);
          expiredAtTimeout = true;
        }
        return next ?? current;
      });
      revalidateRef.current();
      if (expiredAtTimeout) {
        pendingGroupAvatarStartedAtRef.current = new Map(startedAtByGroupId);
      }
    }, Math.min(
      PENDING_GROUP_AVATAR_REVALIDATE_INTERVAL_MS,
      Math.max(0, (nextRevalidateAt ?? now) - now),
    ));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [expiredPendingGroupAvatarIds, groupsBeforePendingExpiry]);

  const value = useMemo(() => ({
    groups,
    activeGroupId: getActiveGroupIdFromMatches(matches),
    runningThreadIds,
    hasStatusSnapshot,
    isLoading: isChatGroupsLoading,
    markThreadIdle,
  }), [
    groups,
    hasStatusSnapshot,
    isChatGroupsLoading,
    markThreadIdle,
    matches,
    runningThreadIds,
  ]);

  return (
    <ChatGroupsContext.Provider value={value}>
      {children}
    </ChatGroupsContext.Provider>
  );
}

export function useChatGroups() {
  const context = use(ChatGroupsContext);
  if (!context) {
    throw new Error("useChatGroups must be used within ChatGroupsProvider");
  }
  return context;
}

export function useOptionalChatGroups() {
  return use(ChatGroupsContext);
}
