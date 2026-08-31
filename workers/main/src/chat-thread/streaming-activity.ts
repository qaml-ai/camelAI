// Workspace streaming-activity publisher for ChatThreadDO, extracted as a
// collaborator: the trailing-debounced running-activity fan-in to the single
// WorkspaceDO instance, the streaming liveness-lease heartbeat, and the
// running-activity text normalization/rate-limit gates. All state lives on the
// owning DO (pendingStreamingActivity, the flush/lease timers, the
// running-activity high-water fields, and the WorkspaceDO stub cache); the
// class itself is stateless and is cached for the owning DO's lifetime with
// closures over its live deps (ChatThreadDO keeps thin same-named private delegates
// as its internal API). Sibling-method calls route back through the deps
// callbacks — i.e. through the DO's delegates — so dynamic dispatch (and every
// `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a sibling
// or reads/writes the plain DO fields on the fake) behaves exactly as it did
// when the bodies lived on the DO.
import type { WorkspaceDO } from "../workspace";
import type { WorkspaceThreadStreamingOptions } from "../thread-status";
import { normalizeThreadPreviewUserMessage } from "../../../../src/lib/thread-preview";
import { getToolSummary } from "../../../../src/lib/tool-activity-summary";
import type { ToolResultBlock, ToolUseBlock } from "../../../../src/types";
import { piToolResultText } from "./pi-message-helpers";
import type { ChatContextState } from "./types";

// Trailing-debounce window for coalescing the high-frequency "thread is still
// streaming" activity updates that ChatThreadDO fan-in RPCs to the single
// WorkspaceDO instance. A burst of running-activity updates for the same thread
// collapses into one RPC carrying the LATEST activity state. Terminal streaming
// transitions (streaming start/stop) bypass this debounce entirely so a
// workspace UI is never stuck showing "streaming".
const WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS = 5_000;
// Liveness-lease heartbeat cadence for the WorkspaceDO running row while a
// turn executes. Must be several times shorter than the WorkspaceDO's
// THREAD_STREAMING_LEASE_TTL_MS so a healthy turn always renews well before
// its lease can expire.
const WORKSPACE_STREAMING_LEASE_REFRESH_MS = 60_000;

// The single pending trailing-debounced activity entry (one timer + the latest
// payload); matches the owning DO's `pendingStreamingActivity` field shape.
export interface PendingStreamingActivityState {
  workspaceId: string;
  threadId: string;
  activityText: string;
  activityAt: number;
  coalescedCount: number;
}

// The slice of the DO's env the streaming-activity cluster touches: the
// WorkspaceDO namespace the status RPCs fan in to.
export interface ChatThreadStreamingActivityEnv {
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
}

export interface ChatThreadStreamingActivityDeps {
  chatContext(): ChatContextState | null;
  env(): ChatThreadStreamingActivityEnv;
  /** DurableObjectState#waitUntil for fire-and-forget status RPCs. */
  waitUntil(promise: Promise<unknown>): void;
  // Mutable DO turn-state fields, exposed as read/write operations (never the
  // DO itself): the pending debounced entry + its trailing timer, the lease
  // heartbeat interval, the last-published activity text/timestamp gates, and
  // the per-workspace WorkspaceDO stub cache (the getter performs the DO-side
  // nullish init so a fake constructed without the field still works).
  pendingStreamingActivity(): PendingStreamingActivityState | null;
  setPendingStreamingActivity(value: PendingStreamingActivityState | null): void;
  streamingActivityFlushTimer(): ReturnType<typeof setTimeout> | null;
  setStreamingActivityFlushTimer(value: ReturnType<typeof setTimeout> | null): void;
  streamingLeaseRefreshTimer(): ReturnType<typeof setInterval> | null;
  setStreamingLeaseRefreshTimer(value: ReturnType<typeof setInterval> | null): void;
  runningActivityLastText(): string | null;
  setRunningActivityLastText(value: string | null): void;
  runningActivityLastSentAt(): number;
  setRunningActivityLastSentAt(value: number): void;
  workspaceStatusStubs(): Map<string, DurableObjectStub<WorkspaceDO>>;
  // DO-side operations (shared helpers whose behavior is owned elsewhere).
  isThreadStreaming(): boolean;
  retryChatDurableObjectRpc<T>(
    operation: string,
    fn: () => Promise<T>,
    options?: { attempts?: number; initialDelayMs?: number },
  ): Promise<T>;
  recordChatThreadObservabilityEvent(
    event: string,
    details?: {
      operation?: string;
      status?: string;
      severity?: "debug" | "info" | "warn" | "error";
      count?: number;
      durationMs?: number;
      error?: unknown;
      sampleKey?: string | null;
    },
  ): void;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  discardPendingStreamingActivity(): void;
  stopStreamingLeaseHeartbeat(): void;
  flushPendingStreamingActivity(): void;
  getWorkspaceStatusStub(workspaceId: string): DurableObjectStub<WorkspaceDO>;
  recordWorkspaceThreadStreaming(
    workspaceId: string | null | undefined,
    threadId: string | null | undefined,
    isStreaming: boolean,
    options?: WorkspaceThreadStreamingOptions,
  ): Promise<void>;
  queueStreamingActivityUpdate(
    workspaceId: string,
    threadId: string,
    activityText: string,
    activityAt: number,
  ): void;
  normalizeRunningActivityText(text: string | null | undefined): string | null;
  shouldPublishRunningActivity(
    activityText: string,
    now: number,
    immediate: boolean,
  ): boolean;
  publishRunningActivity(
    text: string | null | undefined,
    options?: { immediate?: boolean; activityAt?: number },
  ): void;
}

export class ChatThreadStreamingActivity {
  constructor(private readonly deps: ChatThreadStreamingActivityDeps) {}

  resetRunningActivityState(): void {
    this.deps.setRunningActivityLastText(null);
    this.deps.setRunningActivityLastSentAt(0);
    // Any debounced running-activity update queued for the previous activity
    // state is now stale: the turn is starting, ending, or the streaming state
    // is flipping. Drop it so it cannot race a terminal transition and resurrect
    // a "streaming" row. The authoritative streaming state is delivered
    // un-debounced by finishTurn / completion recording.
    this.deps.discardPendingStreamingActivity();
    this.deps.stopStreamingLeaseHeartbeat();
  }

  /**
   * While a turn executes, periodically renew the WorkspaceDO running row's
   * liveness lease. The row expires THREAD_STREAMING_LEASE_TTL_MS after its
   * last update and the WorkspaceDO alarm sweeps it (delete + idle broadcast),
   * so a turn killed without a terminal isStreaming=false — deploy, eviction,
   * crash — self-heals within minutes instead of pinning "running" in every
   * viewer's sidebar. The refresh is update-only server-side (`refresh: true`),
   * so a late tick racing the terminal transition can never resurrect a
   * cleared row; if the DO dies, the interval dies with it, which is exactly
   * the loss-of-heartbeat signal the lease exists to detect.
   */
  startStreamingLeaseHeartbeat(): void {
    this.deps.stopStreamingLeaseHeartbeat();
    this.deps.setStreamingLeaseRefreshTimer(setInterval(() => {
      if (!this.deps.isThreadStreaming()) {
        // Terminal paths stop the heartbeat via resetRunningActivityState;
        // this is a backstop so a missed clear-site cannot renew a dead turn
        // forever (which would recreate the exact stuck state the lease
        // is meant to prevent).
        this.deps.stopStreamingLeaseHeartbeat();
        return;
      }
      const context = this.deps.chatContext();
      if (!context?.workspaceId || !context.threadId) return;
      this.deps.waitUntil(
        this.deps.recordWorkspaceThreadStreaming(
          context.workspaceId,
          context.threadId,
          true,
          { refresh: true },
        ),
      );
    }, WORKSPACE_STREAMING_LEASE_REFRESH_MS));
  }

  stopStreamingLeaseHeartbeat(): void {
    if (this.deps.streamingLeaseRefreshTimer() !== null) {
      clearInterval(this.deps.streamingLeaseRefreshTimer()!);
      this.deps.setStreamingLeaseRefreshTimer(null);
    }
  }

  getWorkspaceStatusStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
    const normalizedWorkspaceId = workspaceId.trim();
    const workspaceStatusStubs = this.deps.workspaceStatusStubs();
    let stub = workspaceStatusStubs.get(normalizedWorkspaceId);
    if (!stub) {
      stub = this.deps.env().WORKSPACE.get(
        this.deps.env().WORKSPACE.idFromName(normalizedWorkspaceId),
      ) as DurableObjectStub<WorkspaceDO>;
      workspaceStatusStubs.set(normalizedWorkspaceId, stub);
    }
    return stub;
  }

  recordWorkspaceThreadStreaming(
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
    return this.deps.retryChatDurableObjectRpc(
      "WorkspaceDO.recordThreadStreaming",
      () =>
        this.deps.getWorkspaceStatusStub(normalizedWorkspaceId).recordThreadStreaming(
          normalizedThreadId,
          isStreaming,
          options,
        ),
      { attempts: 4, initialDelayMs: 150 },
    ).catch((error) => {
      console.error("[ChatThreadDO] failed to record workspace thread status", {
        workspaceId: normalizedWorkspaceId,
        threadId: normalizedThreadId,
        isStreaming,
        error,
      });
    });
  }

  /**
   * Coalesce high-frequency "still streaming" running-activity updates into a
   * single trailing-debounced RPC to the single WorkspaceDO instance.
   *
   * Each call records the LATEST activity payload and (re)arms a trailing timer.
   * A burst of N updates within {@link WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS}
   * collapses into one RPC carrying the most recent state.
   *
   * This is only used for `isStreaming = true` activity updates. Terminal
   * streaming transitions (start/stop) and completion-metadata updates bypass
   * the debounce via {@link flushPendingStreamingActivity} +
   * {@link recordWorkspaceThreadStreaming}, so the workspace UI is never stuck
   * showing "streaming".
   *
   * Eviction note: if the DO is evicted with a pending debounced update, that
   * single activity-text update is lost. This is acceptable here because the
   * value is a transient, best-effort "what is the agent doing right now" label,
   * not terminal state. The very next activity update re-sends fresh text, and
   * the turn-end terminal transition (always delivered, un-debounced) carries
   * the authoritative streaming=false. The WorkspaceDO row also self-prunes
   * after its TTL, so no permanently-stale "streaming" state can result from a
   * dropped activity update.
   */
  queueStreamingActivityUpdate(
    workspaceId: string,
    threadId: string,
    activityText: string,
    activityAt: number,
  ): void {
    const normalizedWorkspaceId = workspaceId.trim();
    const normalizedThreadId = threadId.trim();
    if (!normalizedWorkspaceId || !normalizedThreadId) return;

    const existing = this.deps.pendingStreamingActivity();
    // If the pending entry targets a different workspace/thread (extremely rare
    // for a per-thread DO, but the chat context can be re-pointed), flush the
    // stale entry first so its latest state is not dropped silently.
    if (
      existing &&
      (existing.workspaceId !== normalizedWorkspaceId ||
        existing.threadId !== normalizedThreadId)
    ) {
      this.deps.flushPendingStreamingActivity();
    }

    const prior = this.deps.pendingStreamingActivity();
    this.deps.setPendingStreamingActivity({
      workspaceId: normalizedWorkspaceId,
      threadId: normalizedThreadId,
      activityText,
      activityAt,
      coalescedCount: (prior?.coalescedCount ?? 0) + 1,
    });

    if (this.deps.streamingActivityFlushTimer() === null) {
      this.deps.setStreamingActivityFlushTimer(setTimeout(() => {
        this.deps.setStreamingActivityFlushTimer(null);
        this.deps.flushPendingStreamingActivity();
      }, WORKSPACE_STREAMING_ACTIVITY_DEBOUNCE_MS));
    }
  }

  /**
   * Send any pending debounced running-activity update immediately (fire and
   * forget) and clear the trailing timer. Safe to call when nothing is pending.
   * Called by the trailing timer, and synchronously by terminal streaming
   * transitions so the final state always wins over an in-flight activity blip.
   */
  flushPendingStreamingActivity(): void {
    if (this.deps.streamingActivityFlushTimer() !== null) {
      clearTimeout(this.deps.streamingActivityFlushTimer()!);
      this.deps.setStreamingActivityFlushTimer(null);
    }
    const pending = this.deps.pendingStreamingActivity();
    if (!pending) return;
    this.deps.setPendingStreamingActivity(null);

    if (pending.coalescedCount > 1) {
      this.deps.recordChatThreadObservabilityEvent("workspace_streaming_activity_coalesced", {
        operation: "record_thread_streaming",
        status: "flushed",
        count: pending.coalescedCount,
        sampleKey: pending.threadId,
      });
    }

    this.deps.waitUntil(
      this.deps.recordWorkspaceThreadStreaming(pending.workspaceId, pending.threadId, true, {
        activityText: pending.activityText,
        activityAt: pending.activityAt,
      }).catch((error) => {
        console.error("[ChatThreadDO] failed to flush running activity", error);
      }),
    );
  }

  /**
   * Drop any pending debounced running-activity update without sending it.
   * Used when a terminal streaming transition (streaming -> not streaming)
   * supersedes the activity update: the activity payload only sets
   * `isStreaming = true`, so flushing it after we have decided streaming has
   * ended could resurrect a stale "streaming" row. The caller is responsible
   * for delivering the authoritative terminal state.
   */
  discardPendingStreamingActivity(): void {
    if (this.deps.streamingActivityFlushTimer() !== null) {
      clearTimeout(this.deps.streamingActivityFlushTimer()!);
      this.deps.setStreamingActivityFlushTimer(null);
    }
    this.deps.setPendingStreamingActivity(null);
  }

  normalizeRunningActivityText(text: string | null | undefined): string | null {
    const normalized = text?.replace(/\s+/g, " ").trim() ?? "";
    if (!normalized) return null;
    return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
  }

  shouldPublishRunningActivity(
    activityText: string,
    now: number,
    immediate: boolean,
  ): boolean {
    if (this.deps.runningActivityLastText() === activityText) return false;
    if (immediate || this.deps.runningActivityLastSentAt() === 0) return true;
    if (now - this.deps.runningActivityLastSentAt() >= 900) return true;
    return /[.!?)]$/.test(activityText);
  }

  publishRunningActivity(
    text: string | null | undefined,
    options: { immediate?: boolean; activityAt?: number } = {},
  ): void {
    const activityText = this.deps.normalizeRunningActivityText(text);
    if (!activityText) return;
    const context = this.deps.chatContext();
    if (!context?.workspaceId || !context.threadId) return;
    const now =
      typeof options.activityAt === "number" && Number.isFinite(options.activityAt)
        ? Math.floor(options.activityAt)
        : Date.now();
    if (!this.deps.shouldPublishRunningActivity(activityText, now, options.immediate === true)) {
      return;
    }
    this.deps.setRunningActivityLastText(activityText);
    this.deps.setRunningActivityLastSentAt(now);
    // Coalesce bursts of running-activity updates into a single trailing
    // debounced RPC carrying the latest state, instead of fanning in one RPC per
    // update to the single WorkspaceDO instance. Terminal streaming transitions
    // (see finishTurn / recordThreadAssistantCompletion) flush or discard this
    // pending update so the workspace UI never sticks on "streaming".
    this.deps.queueStreamingActivityUpdate(
      context.workspaceId,
      context.threadId,
      activityText,
      now,
    );
  }

  publishRunningUserMessageActivity(content: string | null | undefined): void {
    const preview = normalizeThreadPreviewUserMessage(content ?? "");
    this.deps.publishRunningActivity(preview, { immediate: true });
  }

  publishPiToolActivity(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    status: "running" | "complete" | "error",
    result?: unknown,
  ): void {
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: toolCallId,
      name: toolName,
      input: args,
    };
    const resultBlock: ToolResultBlock | undefined =
      status === "running"
        ? undefined
        : {
            type: "tool_result",
            tool_use_id: toolCallId,
            content: piToolResultText(result),
          };
    this.deps.publishRunningActivity(
      getToolSummary(tool, resultBlock, status, status === "running"),
      { immediate: true },
    );
  }

  // Fire-and-forget the workspace thread-list "streaming" indicator. Does NOT drive
  // the client spinner (that is derived; see ChatThreadDO#isThreadStreaming).
  pushWorkspaceStreaming(value: boolean): void {
    const context = this.deps.chatContext();
    if (!context?.workspaceId || !context.threadId) return;
    this.deps.waitUntil(
      this.deps.recordWorkspaceThreadStreaming(context.workspaceId, context.threadId, value).catch(
        (error) => console.error("[ChatThreadDO] failed to record workspace thread status", error),
      ),
    );
  }
}
