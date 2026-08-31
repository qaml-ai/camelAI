// Thread metadata generation for ChatThreadDO, extracted as a collaborator:
// per-user-message org metadata updates (first message, preview, title kick),
// OpenAI-backed thread title generation, chat group icon generation,
// and the assistant-completion record + hover-summary persistence pipeline.
// All state lives on the owning DO (chatContext, the title-generation and
// completion high-water fields) and in Org/User/Workspace DOs; the class
// itself is stateless and is cached for the owning DO's lifetime with closures
// over its live deps (ChatThreadDO keeps thin same-named private delegates as
// its internal API, and the public RPCs setTitle /
// generateChatGroupAvatarForThread stay on the DO as thin orchestrators).
// Sibling-method calls route back through the deps callbacks — i.e. through
// the DO's delegates — so dynamic dispatch (and every
// `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a sibling
// on the fake) behaves exactly as it did when the bodies lived on the DO.
import {
  getThreadUserMessageSources,
  isPlaceholderThreadTitle,
} from "../../../../src/lib/thread-title";
import { AUXILIARY_AI_MODEL } from "../../../../src/lib/auxiliary-ai.server";
import {
  CHAT_GROUP_ICON_SELECTION_STRATEGY,
  generateChatGroupIconWithOpenAI,
  type ChatGroupIconSelectionOutcome,
} from "../../../../src/lib/chat-group-avatar-generation.server";
import { normalizeChatGroupIconName } from "../../../../src/lib/chat-group-icons";
import { generateThreadTitleWithOpenAI } from "../../../../src/lib/thread-title-generation.server";
import { generateThreadCompletionSummaryWithOpenAI } from "../../../../src/lib/thread-completion-summary-generation.server";
import type {
  ChatGroupAvatar,
  ThreadCompletionSummaryStatus,
} from "../../../../src/types";
import type { OrgDO, UserDO } from "../auth";
import type { ChatGroupIconGenerationClaim } from "../identity/user-do";
import type { WorkspaceThreadStreamingOptions } from "../thread-status";
import type { ChatContextState } from "./types";

export type AssistantCompletionPersistenceResult =
  | { status: "stored"; completedAt: number }
  | { status: "stale" }
  | { status: "failed" };

// The slice of the DO's env the metadata cluster touches: org/user stubs for
// thread + chat-group writes, Workers AI for the OpenAI-backed generators, and
// the AI Gateway name they attribute usage to.
export interface ChatThreadMetadataEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  USER: DurableObjectNamespace<UserDO>;
  AI: Ai;
  CF_GATEWAY_NAME?: string;
}

export interface ChatThreadMetadataDeps {
  chatContext(): ChatContextState | null;
  env(): ChatThreadMetadataEnv;
  /** DurableObjectState#waitUntil for post-return background work. */
  waitUntil(promise: Promise<unknown>): void;
  // Mutable DO turn-state fields, exposed as read/write operations (never the
  // DO itself): the title-generation re-entrancy latch and the completion /
  // summary high-water timestamps finishTurn gates on.
  titleGenerationInFlight(): boolean;
  setTitleGenerationInFlight(value: boolean): void;
  setAssistantCompletionRecordedAt(value: number | null): void;
  setAssistantCompletionSummaryRequestedAt(value: number | null): void;
  // DO-side operations (public RPC setTitle stays on the DO; the rest are
  // shared helpers whose behavior is owned elsewhere).
  setTitle(title: string, updatedAt?: number): Promise<void>;
  broadcastChat(message: object): void;
  recordWorkspaceThreadStreaming(
    workspaceId: string | null | undefined,
    threadId: string | null | undefined,
    isStreaming: boolean,
    options?: WorkspaceThreadStreamingOptions,
  ): Promise<void>;
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
      model?: string | null;
      durationMs?: number;
      error?: unknown;
    },
  ): void;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  persistThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summary: string | null,
    summaryStatus: ThreadCompletionSummaryStatus | null,
  ): Promise<AssistantCompletionPersistenceResult>;
  recordCompletionSummaryStatus(
    context: ChatContextState,
    completedAt: number,
    summaryStatus: ThreadCompletionSummaryStatus,
    summary?: string,
  ): Promise<void>;
  generateAndPersistThreadAssistantCompletionSummary(
    context: ChatContextState,
    completedAt: number,
    sourceText: string,
  ): Promise<void>;
  generateThreadTitleFromMessage(threadId: string, message: string): Promise<void>;
  generateClaimedChatGroupAvatar(
    threadId: string,
    claim: ChatGroupIconGenerationClaim,
    userStub: {
      setGeneratedChatGroupIcon: (
        groupId: string,
        claimId: string,
        icon: string,
      ) => unknown;
      markChatGroupAvatarGenerationFailed: (
        groupId: string,
        claimId: string,
      ) => unknown;
    },
  ): Promise<void>;
  maybeGenerateChatGroupAvatarForThread(
    threadId: string,
    trigger?: ChatGroupIconGenerationClaim["trigger"],
  ): Promise<void>;
  errorLogFields(error: unknown): {
    errorName: string;
    errorMessage: string;
  };
}

export class ChatThreadMetadata {
  constructor(private readonly deps: ChatThreadMetadataDeps) {}

  async recordThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summarySource: string | null,
  ): Promise<void> {
    const hasSummarySource = Boolean(summarySource?.trim());
    const initialSummaryStatus: ThreadCompletionSummaryStatus = hasSummarySource
      ? "pending"
      : "failed";

    // Clear the durable workspace running row before crossing into OrgDO. A
    // completion used to persist its metadata first and only then publish the
    // terminal workspace transition. If that first cross-DO RPC reset/evicted
    // this isolate, the Pi turn was already terminal but WorkspaceDO never saw
    // `isStreaming = false`, leaving every viewer's Camel indicator running
    // until the lease expired. A stale OrgDO completion also returned early and
    // skipped the clear permanently.
    //
    // This ordering is safe when a newer turn has already started: WorkspaceDO
    // compares `completedAt` with the running row's `startedAt` and ignores an
    // older terminal transition. The later summary update remains best-effort
    // metadata and must not gate the authoritative running-state transition.
    await this.deps.recordWorkspaceThreadStreaming(
      context.workspaceId,
      context.threadId,
      false,
      {
        completedAt,
        summaryStatus: initialSummaryStatus,
        clearOnlyIfRunning: true,
      },
    );

    const persistenceResult = await this.deps.persistThreadAssistantCompletion(
      context,
      completedAt,
      null,
      initialSummaryStatus,
    );
    if (persistenceResult.status === "stale") {
      return;
    }
    if (persistenceResult.status === "failed") {
      await this.deps.recordWorkspaceThreadStreaming(
        context.workspaceId,
        context.threadId,
        false,
        {
          completedAt,
          summaryStatus: "failed",
          clearRunningStartedAtOrBefore: completedAt,
        },
      );
      return;
    }
    const storedCompletedAt = persistenceResult.completedAt;

    // OrgDO may normalize the completion timestamp forward to keep thread
    // metadata monotonic. Publish that authoritative value after the guarded
    // pre-clear; summary generation also relies on it as its stable key.
    await this.deps.recordWorkspaceThreadStreaming(
      context.workspaceId,
      context.threadId,
      false,
      {
        completedAt: storedCompletedAt,
        summaryStatus: initialSummaryStatus,
        // OrgDO may move storedCompletedAt past a newly-started turn while this
        // RPC is in flight. Liveness ownership is still bounded by the original
        // terminal observation, not that metadata-normalization timestamp.
        clearRunningStartedAtOrBefore: completedAt,
      },
    );

    if (hasSummarySource) {
      this.deps.setAssistantCompletionRecordedAt(storedCompletedAt);
      this.deps.setAssistantCompletionSummaryRequestedAt(storedCompletedAt);
      await this.deps.generateAndPersistThreadAssistantCompletionSummary(
        context,
        storedCompletedAt,
        summarySource!,
      );
    }
  }

  async persistThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summary: string | null,
    summaryStatus: ThreadCompletionSummaryStatus | null,
  ): Promise<AssistantCompletionPersistenceResult> {
    try {
      const orgId = this.deps.env().ORG.idFromName(context.orgId);
      const getOrgStub = () => this.deps.env().ORG.get(orgId) as unknown as {
        recordThreadAssistantCompletion(
          id: string,
          input: {
            completedAt: number;
            summary: string | null;
            summaryStatus?: ThreadCompletionSummaryStatus | null;
          },
        ): Promise<number | false> | number | false;
      };
      const storedCompletedAt = await this.deps.retryChatDurableObjectRpc(
        "OrgDO.recordThreadAssistantCompletion",
        () =>
          Promise.resolve(
            getOrgStub().recordThreadAssistantCompletion(context.threadId, {
              completedAt,
              summary,
              summaryStatus,
            }),
          ),
        { attempts: 4, initialDelayMs: 150 },
      );
      return typeof storedCompletedAt === "number" &&
        Number.isFinite(storedCompletedAt)
        ? { status: "stored", completedAt: storedCompletedAt }
        : { status: "stale" };
    } catch (error) {
      console.error("[ChatThreadDO] failed to persist assistant completion", error);
      return { status: "failed" };
    }
  }

  async recordCompletionSummaryStatus(
    context: ChatContextState,
    completedAt: number,
    summaryStatus: ThreadCompletionSummaryStatus,
    summary?: string,
  ): Promise<void> {
    const persistenceResult = await this.deps.persistThreadAssistantCompletion(
      context,
      completedAt,
      summary ?? null,
      summaryStatus,
    );
    if (persistenceResult.status === "stale") return;
    const statusCompletedAt =
      persistenceResult.status === "stored"
        ? persistenceResult.completedAt
        : completedAt;
    await this.deps.recordWorkspaceThreadStreaming(
      context.workspaceId,
      context.threadId,
      false,
      {
        completedAt: statusCompletedAt,
        summaryStatus:
          persistenceResult.status === "failed" ? "failed" : summaryStatus,
        // Summary generation is delayed and may finish after another turn has
        // started. It can enrich an idle unread event, but never owns liveness.
        clearRunningStartedAtOrBefore: null,
        ...(persistenceResult.status === "stored" && summary
          ? { summary }
          : {}),
      },
    );
  }

  async generateAndPersistThreadAssistantCompletionSummary(
    context: ChatContextState,
    completedAt: number,
    sourceText: string,
  ): Promise<void> {
    try {
      const summary = await generateThreadCompletionSummaryWithOpenAI(
        this.deps.env().AI,
        sourceText,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
        },
        { gatewayName: this.deps.env().CF_GATEWAY_NAME },
      );
      if (!summary) {
        await this.deps.recordCompletionSummaryStatus(context, completedAt, "failed");
        return;
      }
      await this.deps.recordCompletionSummaryStatus(
        context,
        completedAt,
        "ready",
        summary,
      );
    } catch (error) {
      console.error("[ChatThreadDO] failed to generate assistant completion summary", error);
      await this.deps.recordCompletionSummaryStatus(context, completedAt, "failed");
    }
  }

  async updateThreadMetadataForUserMessage(
    messageContent: string,
    messageSource?: string | null,
  ): Promise<void> {
    const context = this.deps.chatContext();
    if (!context?.orgId || !context?.threadId || !context.workspaceId) return;

    const orgStub = this.deps.env().ORG.get(this.deps.env().ORG.idFromName(context.orgId));
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) return;

    await orgStub.recordThreadUserMessage(
      context.threadId,
      messageContent,
      messageSource,
    );
    if (context.userId) {
      const userStub = this.deps.env().USER.get(this.deps.env().USER.idFromName(context.userId));
      await userStub.touchGroupForThread(context.threadId);
    }

    const messageSources = getThreadUserMessageSources(messageContent);
    if (!messageSources) {
      return;
    }
    const { metadataSourceMessage, titleSourceMessage } = messageSources;

    const hasFirstUserMessage = typeof thread.first_user_message === 'string'
      && thread.first_user_message.trim().length > 0;
    if (!hasFirstUserMessage) {
      await orgStub.setThreadFirstUserMessage(context.threadId, metadataSourceMessage);
    }

    if (!isPlaceholderThreadTitle(thread.title) || this.deps.titleGenerationInFlight()) {
      return;
    }

    this.deps.setTitleGenerationInFlight(true);
    await this.deps.generateThreadTitleFromMessage(context.threadId, titleSourceMessage);
  }

  errorLogFields(error: unknown): {
    errorName: string;
    errorMessage: string;
  } {
    if (error instanceof Error) {
      return {
        errorName: error.name,
        errorMessage: error.message,
      };
    }
    return {
      errorName: "UnknownError",
      errorMessage: String(error),
    };
  }

  async generateClaimedChatGroupAvatar(
    threadId: string,
    claim: ChatGroupIconGenerationClaim,
    userStub: {
      setGeneratedChatGroupIcon: (
        groupId: string,
        claimId: string,
        icon: string,
      ) => unknown;
      markChatGroupAvatarGenerationFailed: (
        groupId: string,
        claimId: string,
      ) => unknown;
    },
  ): Promise<void> {
    const context = this.deps.chatContext();
    if (!context?.orgId || !context.workspaceId) return;

    this.deps.broadcastChat({
      type: "chat_group_avatar_updated",
      threadId,
      groupId: claim.id,
      avatar: { ...claim.avatar, status: "pending" },
    });

    let generatedIcon: string | null = null;
    const generationStartedAt = Date.now();
    let aiErrored = false;
    let selectionOutcome: ChatGroupIconSelectionOutcome = "ai_error";
    try {
      generatedIcon = await generateChatGroupIconWithOpenAI(
        this.deps.env().AI,
        claim.name,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId,
          groupId: claim.id,
        },
        {
          gatewayName: this.deps.env().CF_GATEWAY_NAME,
          onOutcome: (outcome) => {
            selectionOutcome = outcome;
          },
        },
      );
    } catch (error) {
      aiErrored = true;
      console.error("[ChatThreadDO] failed to generate chat group icon", {
        reason: "ai_error",
        threadId,
        groupId: claim.id,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        ...this.deps.errorLogFields(error),
      });
      this.deps.recordChatThreadObservabilityEvent("chat_group_icon_generation", {
        operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:${claim.trigger}`,
        status: "ai_error",
        model: AUXILIARY_AI_MODEL,
        durationMs: Date.now() - generationStartedAt,
        error,
      });
    }
    // One event per generation outcome so the failure rate is measurable.
    if (!aiErrored) {
      this.deps.recordChatThreadObservabilityEvent("chat_group_icon_generation", {
        operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:${claim.trigger}`,
        status: selectionOutcome,
        severity: generatedIcon ? "info" : "warn",
        model: AUXILIARY_AI_MODEL,
        durationMs: Date.now() - generationStartedAt,
      });
    }

    if (!generatedIcon) {
      // No icon: record the one-shot attempt (so reconnects don't retry) and
      // broadcast the group's *actual* current avatar to clear the pending
      // state. Re-reading avoids clobbering an avatar the user set while the AI
      // was in flight.
      try {
        const avatar = (await userStub.markChatGroupAvatarGenerationFailed(
          claim.id,
          claim.claimId,
        )) as ChatGroupAvatar | null;
        if (avatar?.status !== "default") {
          this.deps.recordChatThreadObservabilityEvent(
            "chat_group_icon_generation",
            {
              operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:${claim.trigger}`,
              status: "claim_lost",
            },
          );
        }
        if (avatar) {
          this.deps.broadcastChat({
            type: "chat_group_avatar_updated",
            threadId,
            groupId: claim.id,
            avatar,
          });
        }
      } catch (error) {
        console.error("[ChatThreadDO] failed to mark chat group avatar attempt", {
          reason: "mark_failed",
          threadId,
          groupId: claim.id,
          workspaceId: context.workspaceId,
          orgId: context.orgId,
          ...this.deps.errorLogFields(error),
        });
        this.deps.recordChatThreadObservabilityEvent(
          "chat_group_icon_generation",
          {
            operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:${claim.trigger}:persist`,
            status: "write_error",
            severity: "error",
            error,
          },
        );
      }
      return;
    }

    try {
      // The write re-reads and returns the current avatar (which may be a
      // user-set avatar if it changed while the AI ran), so broadcast that.
      const avatar = (await userStub.setGeneratedChatGroupIcon(
        claim.id,
        claim.claimId,
        generatedIcon,
      )) as ChatGroupAvatar | null;
      const normalizedIcon = normalizeChatGroupIconName(generatedIcon);
      if (
        avatar?.status !== "generated" ||
        avatar.content !== normalizedIcon
      ) {
        this.deps.recordChatThreadObservabilityEvent(
          "chat_group_icon_generation",
          {
            operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:${claim.trigger}`,
            status: "claim_lost",
          },
        );
      }
      if (avatar) {
        this.deps.broadcastChat({
          type: "chat_group_avatar_updated",
          threadId,
          groupId: claim.id,
          avatar,
        });
      }
    } catch (error) {
      console.error("[ChatThreadDO] failed to write chat group avatar", {
        reason: "write_error",
        threadId,
        groupId: claim.id,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        ...this.deps.errorLogFields(error),
      });
      this.deps.recordChatThreadObservabilityEvent("chat_group_icon_generation", {
        operation: `${CHAT_GROUP_ICON_SELECTION_STRATEGY}:${claim.trigger}:persist`,
        status: "write_error",
        severity: "error",
        error,
      });
    }
  }

  async maybeGenerateChatGroupAvatarForThread(
    threadId: string,
    trigger?: ChatGroupIconGenerationClaim["trigger"],
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const context = this.deps.chatContext();
    if (
      !normalizedThreadId ||
      !context?.orgId ||
      !context.workspaceId ||
      !context.userId
    ) {
      return;
    }
    if (!this.deps.env().AI || typeof this.deps.env().AI.run !== "function") {
      console.warn("[ChatThreadDO] skipping chat group avatar generation", {
        reason: "missing_ai",
        threadId: normalizedThreadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
      });
      return;
    }

    try {
      const userStub = this.deps.env().USER.get(this.deps.env().USER.idFromName(context.userId));
      const claim = trigger
        ? await userStub.claimChatGroupAvatarGenerationForThread(
            normalizedThreadId,
            trigger,
          )
        : await userStub.claimChatGroupAvatarGenerationForThread(
            normalizedThreadId,
          );
      if (!claim) return;
      await this.deps.generateClaimedChatGroupAvatar(
        normalizedThreadId,
        claim,
        userStub,
      );
    } catch (error) {
      console.error("[ChatThreadDO] failed to update accessed chat group avatar", {
        threadId: normalizedThreadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        ...this.deps.errorLogFields(error),
      });
    }
  }

  async generateThreadTitleFromMessage(threadId: string, message: string): Promise<void> {
    try {
      const context = this.deps.chatContext();
      if (!context?.orgId) {
        return;
      }

      const title = await generateThreadTitleWithOpenAI(
        this.deps.env().AI,
        message,
        {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId,
        },
        { gatewayName: this.deps.env().CF_GATEWAY_NAME },
      );
      if (!title) {
        return;
      }

      const orgStub = this.deps.env().ORG.get(this.deps.env().ORG.idFromName(context.orgId));
      const updated = await orgStub.updateThread(threadId, title);
      await this.deps.setTitle(title, updated?.updated_at);
      if (context.userId) {
        const userStub = this.deps.env().USER.get(this.deps.env().USER.idFromName(context.userId));
        await userStub.renameEmptySingleThreadGroupForThread(threadId, title);
        if (!isPlaceholderThreadTitle(title)) {
          this.deps.waitUntil(
            this.deps
              .maybeGenerateChatGroupAvatarForThread(threadId, "first_title")
              .catch((error) => {
                console.error("[ChatThreadDO] failed to update chat group avatar", {
                  threadId,
                  ...this.deps.errorLogFields(error),
                });
              }),
          );
        }
      }
    } catch (err) {
      console.error('[ChatThreadDO] failed to generate thread title', err);
    } finally {
      this.deps.setTitleGenerationInFlight(false);
    }
  }
}
