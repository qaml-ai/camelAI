"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
} from "react";
import type { CSSProperties } from "react";
import type { UIMessage } from "ai";
import {
  useNavigate,
  useFetcher,
  useLocation,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "react-router";
import { ArrowDown } from "lucide-react";
import { toast } from "sonner";
import type {
  AtMentionEntity,
  Message,
  LlmModel,
  LlmProvider,
  Thread,
  WorkerScriptWithCreator,
  Integration,
  PreviewTarget,
  PreviewTab,
  ChatGroupView,
  CondensedTranscript,
  GroupNewChatAttachmentCard,
  GroupNewChatPayload,
  GroupNewChatTranscriptCard,
  ChatGroupAvatar,
  ChatGroupAvatarStatus,
} from "@/types";
import { useAuthData } from "@/hooks/use-auth-data";
import {
  useBillingCreditStatus,
  type BillingCreditStatusResourceData,
} from "@/hooks/use-billing-credit-status";
import { useOptionalChatGroups } from "@/hooks/use-chat-groups";
import { useChatCompaction } from "@/hooks/use-chat-compaction";
import {
  useChatTranscriptProjection,
  useInitialChatTranscript,
} from "@/hooks/use-chat-transcript";
import { useCheckoutStatus } from "@/hooks/use-checkout-status";
import { useCompletedTurns } from "@/hooks/use-completed-turns";
import { useFreeTierUpgradePrompt } from "@/hooks/use-free-tier-upgrade-prompt";
import { useBillingDialogPresence } from "@/hooks/use-billing-dialog-presence";
import { useIsMobile } from "@/hooks/use-mobile";
import { APP_BUILD_ID } from "@/lib/app-build-id";
import {
  appendEvictedRenderMessages,
  classifyResidentRenderHistoryUpdate,
  isCurrentRenderHistoryGeneration,
  prependOlderRenderMessages,
  shouldHydrateRenderHistoryCursor,
  type ChatRenderHistoryPage,
} from "@/lib/chat-render-history";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PromptInput } from "@/components/prompt-input";
import { FloatingTodoList, type TodoItem } from "@/components/floating-todo";
import {
  AskUserQuestion,
  type AskUserQuestionData,
} from "@/components/ask-user-question";
import {
  ConnectionSetupPrompt,
  type ConnectionSetupPromptData,
} from "@/components/connection-setup-prompt";
import type { Attachment } from "@/components/attachment-list";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { WelcomeScreen } from "@/components/welcome-screen";
import { BillingCreditNotice } from "@/components/chat-billing-credit-notice";
import {
  TopUpDialog,
  type TopUpDialogPack,
} from "@/components/billing/top-up-dialog";
import { UnlockPremiumModal } from "@/components/billing/unlock-premium-modal";
import { PlanUpgradeDialog } from "@/components/billing/plan-upgrade-dialog";
import { OpenAiSignInDialog } from "@/components/billing/openai-sign-in-dialog";
import { ByokKeyDialog } from "@/components/onboarding/byok-key-dialog";
import { CamelCodeWelcomeDialog } from "@/components/camel-code-welcome-dialog";
import { CamelCodePickerAlert } from "@/components/camel-code-picker-alert";
import { ModelFallbackBanner } from "@/components/model-fallback-banner";
import { ChatErrorNotice } from "@/components/chat-error-notice";
import { ChatMessagesView } from "@/components/chat-messages-view";
import { ChatTranscriptErrorBoundary } from "@/components/chat-transcript-error-boundary";
import { ShareStatusButton } from "@/components/chat-share-status-button";
import {
  isImageFile,
  type NotebookPreviewLoadState,
} from "@/components/chat-file-preview";
import { ChatPreviewProvider } from "@/components/chat-preview/preview-context";
import {
  DEFAULT_NOTEBOOK_PREVIEW_STATE,
  MobileViewSwitcher,
  PreviewPanelShell,
  normalizePreviewSessionState,
} from "@/components/chat-preview/chat-preview-shell";
import { useConnectionSetupResponse } from "@/components/chat-preview/use-connection-setup-response";
import { useChatPreviewRenderState } from "@/components/chat-preview/use-chat-preview-render-state";
import {
  arePreviewSessionsExactlyEqual,
  arePreviewSessionsSemanticallyEqual,
} from "@/components/chat-preview/preview-session-compare";
import {
  getPreviewTabId,
  shouldAutoRefreshFilePreview,
} from "@/components/preview-panel/preview-utils";
import { cn } from "@/lib/utils";
import { CAMEL_CODE_LLM_MODEL } from "@/lib/llm-provider-config";
import { resolveMessageAuthorDisplayName } from "@/lib/message-author";
import { buildSlugMap, type MentionableProject } from "@/lib/mentions";
import { isFileDrag } from "@/lib/file-drag";
import { uiMessagesEquivalent } from "@/lib/ui-message-adapter";
import {
  deriveIsAwaitingAssistant,
  deriveShowGlobalAssistantIndicator,
  deriveTurnSettled,
} from "@/lib/chat-working-indicator";
import {
  shouldShowModelFallbackNotice,
  type ChatAgentModelFallbackNotice,
  type ChatAgentStatePayload,
} from "@/lib/chat-agent-state";
import { usePiChatStream } from "@/lib/use-pi-chat-stream";
import {
  checkForVersionSkew,
  isReloadSafeNow,
  registerReloadSafetyGuard,
  type VersionSkewTrigger,
} from "@/lib/version-skew";
import {
  recordCamelCodeWelcomeDismissal,
  shouldShowCamelCodeWelcome,
} from "@/lib/camel-code-welcome";
import {
  getBillingDialogIdentityKey,
  getWelcomeAutoOpenState,
  hasActiveBillingDialog,
  shouldNavigateToBillingForPausedModel,
  transitionBillingDialogState,
  type BillingDialogState,
} from "@/lib/billing-dialog-state";
import {
  SEND_ACK_TIMEOUT_MS,
  trackChatReconnectFlush,
  trackChatSendDispatched,
  trackChatSendQueuedOffline,
  trackChatStreamClose,
  trackChatStreamError,
  trackChatStreamOpen,
  trackChatStreamTerminalClose,
} from "@/lib/chat-sse-telemetry";
import { terminalChatSseUserMessage } from "@/lib/chat-sse-close";
import {
  SSE_READY_STATE_OPEN,
  type SseAgentCloseEvent,
  type SseAgentMessageEvent,
} from "@/lib/sse-agent-client";
import { useSseAgent } from "@/lib/use-sse-agent";
import { type AppUrlInput, getAppUrl, getAppIframeUrl } from "@/lib/app-url";
import {
  collectProjectReferencesFromMessages,
  collectProjectReferencesFromPreviewTabs,
  formatCopyFilePath,
  normalizeProjectCopyLookupKey,
  resolveProjectMentionSlug,
  type CopyFilePathTarget,
} from "@/lib/file-path-copy";
import { uploadWorkspaceFile } from "@/lib/workspace-upload.client";
import { isManualCompactCommand } from "@/lib/slash-commands";
import { buildAppThreadFallbackTitle } from "@/lib/thread-title";
import { buildAppWorkSystemMessage } from "@/lib/app-chat-context";
import { normalizeThreadPreviewUserMessage } from "@/lib/thread-preview";
import { trackNewCamelActivationAfterAcceptedMessage } from "@/lib/marketing-attribution.client";
import {
  getDefaultLlmModel,
  getVisibleLlmModelOptions,
  isLlmModel,
} from "@/lib/llm-provider-config";
import {
  type ChatApiErrorContext,
  type ChatApiErrorPresentation,
  getChatApiErrorPresentation,
  isChatBillingOrCreditError,
} from "@/lib/chat-api-errors";
import {
  parseByokProvider,
  type OnboardingByokProvider,
} from "@/lib/byok-providers";
import {
  EMPTY_BYOK_CREDENTIAL,
  resolveOrgScopedByokApiKey,
  type OrgScopedByokCredential,
} from "@/lib/byok-credential-state";
import { modelCatalogEntriesForIds } from "@/lib/model-catalog";
import {
  deriveHostedCreditPause,
  findCheapestSelectableModel,
  shouldPromptToAddCamelCode,
  type HostedCreditPauseBilling,
  type ModelPausedReason,
  type ModelPickerOption,
} from "@/lib/model-picker-access";
import { resolveDefaultModelForChat } from "@/lib/model-picker-config";
import { getRecentModel, type RecentModelScope } from "@/lib/recent-model";
import {
  resolveDisplayedBillingCreditStatus,
  resolveRefreshedThreadModel,
  shouldSwitchExhaustedThreadModel,
  type BillingCreditStatus,
} from "@/lib/chat-credit-status";
import {
  loadDeliveryDraft,
  loadDraft,
  markDeliveryDraftAccepted,
  removeDeliveryDraft,
  removeDraft,
  serializeAttachments,
  useDraftPersistence,
  writeDeliveryDraft,
  writeDraft,
  type DeliveryDraftData,
} from "@/hooks/use-draft-persistence";
import { useBufferedState } from "@/hooks/use-buffered-state";
import {
  appendAttachmentReferences,
  isUserUploadMountPath,
} from "@/lib/chat-attachment-refs";
import { condensedTranscriptToMarkdown } from "@/lib/condensed-transcript";

export { ChatErrorNotice } from "@/components/chat-error-notice";
export { BillingCreditNotice } from "@/components/chat-billing-credit-notice";

// Agent-state payload from ChatThreadDO. Structure is the shared source of truth;
// the client fills the generic sub-types with its own component types and treats
// every field as optional (a partial state update may omit any of them).
type ChatAgentState = Partial<
  ChatAgentStatePayload<
    PreviewTarget,
    AskUserQuestionData,
    ConnectionSetupPromptData,
    LlmModel
  >
>;

type ChatAgentClient = {
  readyState: number;
  send(data: string): void;
  reconnect(): void;
  call<T = unknown>(
    method: string,
    args?: unknown[],
    options?: { timeout?: number },
  ): Promise<T>;
};

type SendMessageResult = {
  status: "accepted" | "busy" | "error";
  error?: string;
};

type ChatBillingAccessMode =
  | "enterprise"
  | "subscription"
  | "byok"
  | "credits"
  | "selfhost"
  | "camel_free";

export function isModelVisibleForChatRuntime(
  model: LlmModel,
  billingAccessMode: ChatBillingAccessMode | null,
): boolean {
  return (
    billingAccessMode !== "selfhost" ||
    model !== CAMEL_CODE_LLM_MODEL
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function getThreadRunningState(
  groups: readonly ChatGroupView[] | undefined,
  threadId: string | null,
): { isRunning: boolean; startedAt: number | null } {
  if (!threadId) return { isRunning: false, startedAt: null };

  for (const group of groups ?? []) {
    for (const thread of group.open_threads) {
      if (thread.id === threadId) {
        return {
          isRunning: thread.status === "running",
          startedAt: thread.running_started_at,
        };
      }
    }
    for (const thread of group.closed_threads) {
      if (thread.id === threadId) {
        return {
          isRunning: thread.status === "running",
          startedAt: thread.running_started_at,
        };
      }
    }
  }

  return { isRunning: false, startedAt: null };
}

interface ChatBaseProps {
  threadId?: string;
  workspaceId: string;
  /**
   * Legacy `Message` transcript. Supplied by the admin read-only loader branch
   * (pi_core, rendered directly) and the client snapshot cache. The live
   * loader branch leaves it empty — its
   * fallback view is derived from `initialUiMessages`.
   */
  initialMessages?: Message[];
  /**
   * ai-chat-owned durable render history (commit 4). Seeds `useAgentChat`; the
   * live-user loader branch supplies it and the hook owns the transcript from
   * there. The admin read-only branch leaves it empty and renders `initialMessages`
   * (pi_core) directly.
   */
  initialUiMessages?: UIMessage[];
  /** Cursor for fetching render messages older than the resident window. */
  olderUiMessagesCursor?: string | null;
  initialTodos?: TodoItem[];
  threadModel?: LlmModel | null;
  llmProvider?: LlmProvider | null;
  allowedThreadModels?: LlmModel[] | null;
  modelOptions?: ReadonlyArray<ModelPickerOption> | null;
  effectivePickerDefaultModel?: LlmModel | null;
  hasEffectivePickerDefault?: boolean;
  billingAccessMode?: ChatBillingAccessMode | null;
  canUnlockPremiumModels?: boolean;
  hostedCreditsPaused?: { reason: ModelPausedReason } | null;
  modelPickerSettingsHref?: string;
  allowOpenAiSubscription?: boolean;
  isOrgAdmin?: boolean;
  recentModelScope?: RecentModelScope | null;
  billingCreditStatus?: BillingCreditStatus | null;
  initialError?: string | null;
  newChatActionError?: string | null;
  initialPreviewTabs?: PreviewTarget[];
  initialActiveTabId?: string | null;
  /** Hostname from server for consistent URL generation (avoids hydration mismatch) */
  hostname?: AppUrlInput;
  /** True when messages are still loading (deferred data) */
  isLoadingMessages?: boolean;
  /** Superuser admin read-only viewer */
  readOnly?: boolean;
  chatGroupId?: string | null;
  initialWelcomeInput?: string | null;
  connections?: Integration[] | Promise<Integration[]>;
  projects?: MentionableProject[] | Promise<MentionableProject[]>;
  onSnapshotChange?: (snapshot: {
    messages: Message[];
    uiMessages: UIMessage[];
    streamingMessageId: string | null;
    todos: TodoItem[];
  }) => void;
  /**
   * Id of the assistant message the instant-paint snapshot captured mid-stream
   * and EXCLUDED from `initialUiMessages` (see resolveDisplayChatData). Chat
   * keeps painting it from the legacy snapshot view until the resumed stream
   * re-delivers it (or a bounded window lapses — a turn that died renders
   * whatever the loader/broadcast says instead).
   */
  bridgedStreamingMessageId?: string | null;
}

interface ChatWelcomeData {
  userId: string | null;
  userName: string | null;
  allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
  connections: Integration[] | Promise<Integration[]>;
  projects: MentionableProject[] | Promise<MentionableProject[]>;
  recentThreads: Thread[] | Promise<Thread[]>;
  renderedAt: number;
  group?: GroupNewChatPayload;
}

type ChatProps = ChatBaseProps &
  (
    | {
        /** New-chat app actions require the slug to build their app URL. */
        welcomeData: ChatWelcomeData;
        orgSlug: string;
      }
    | {
        welcomeData?: undefined;
        /** Existing/admin thread views may not have an owning org anymore. */
        orgSlug?: string;
      }
  );

interface CreditPacksResourceData {
  packs: TopUpDialogPack[];
  canTopUp: boolean;
  unavailableReason?: string | null;
}

function isPromiseLike<T>(
  value: T | Promise<T> | undefined,
): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}

const EMPTY_WORKER_APPS: WorkerScriptWithCreator[] = [];
const EMPTY_INTEGRATIONS: Integration[] = [];
const EMPTY_MENTION_PROJECTS: MentionableProject[] = [];
const EMPTY_RECENT_THREADS: Thread[] = [];

export function resolveSelectedThreadModel(args: {
  threadId?: string;
  threadModel?: LlmModel | null;
  allowedThreadModels?: LlmModel[] | null;
  llmProvider?: LlmProvider | null;
  availableThreadModels: ReadonlyArray<ModelPickerOption>;
  effectivePickerDefaultModel: LlmModel | null;
  hasEffectivePickerDefault: boolean;
  recentModel?: LlmModel | null;
}): LlmModel {
  const availableModelIds = new Set(
    args.availableThreadModels.map((entry) => entry.id),
  );
  const selectableModels = args.availableThreadModels.filter(
    (entry) => !entry.locked,
  );
  const threadModelIsAvailable =
    Boolean(args.threadModel) && availableModelIds.has(args.threadModel!);

  // Existing threads keep their explicit model even if an admin later removes
  // it from the picker or free-mode billing now presents it as locked. The
  // server can still roll inaccessible hosted models over to camelCode.
  if (args.threadId && args.threadModel) {
    return args.threadModel;
  }

  const resolvedModel = resolveDefaultModelForChat({
    effectiveDefaultModel: args.hasEffectivePickerDefault
      ? args.effectivePickerDefaultModel
      : null,
    recentModel: args.recentModel,
    fallbackModel: args.threadModel ?? getDefaultLlmModel(args.llmProvider),
    visibleCatalog: selectableModels,
  });

  return (
    resolvedModel ??
    (threadModelIsAvailable ? args.threadModel : null) ??
    args.allowedThreadModels?.[0] ??
    getDefaultLlmModel(args.llmProvider)
  );
}

export function resolveAgentFallbackOptimisticModel(args: {
  threadId: string | null | undefined;
  model: unknown;
  notice: ChatAgentModelFallbackNotice | null | undefined;
  now?: number;
}): { threadId: string; model: LlmModel } | null {
  if (
    !args.threadId ||
    !isLlmModel(args.model) ||
    !shouldShowModelFallbackNotice(args.notice, args.model)
  ) {
    return null;
  }
  return { threadId: args.threadId, model: args.model };
}

export function shouldIgnoreStaleThreadModelResult(args: {
  threadId: string | null | undefined;
  nextModel: LlmModel;
  optimistic: { threadId: string; model: LlmModel } | null;
}): boolean {
  return Boolean(
    args.threadId &&
      args.optimistic?.threadId === args.threadId &&
      args.optimistic.model !== args.nextModel,
  );
}

type AuthoritativeThreadModel = {
  threadId: string;
  model: LlmModel;
  updatedAt: number;
};

export function shouldIgnoreOlderThreadModelUpdate(args: {
  threadId: string | null | undefined;
  nextModel: LlmModel;
  nextUpdatedAt: number | null | undefined;
  authoritative: AuthoritativeThreadModel | null;
}): boolean {
  const current = args.authoritative;
  if (
    !args.threadId ||
    current?.threadId !== args.threadId ||
    current.model === args.nextModel
  ) {
    return false;
  }
  return (
    typeof args.nextUpdatedAt !== "number" ||
    !Number.isFinite(args.nextUpdatedAt) ||
    args.nextUpdatedAt <= current.updatedAt
  );
}

function dispatchLocalThreadStatus(
  threadId: string | null | undefined,
  status: "idle" | "running",
  options: {
    latestUserMessage?: string | null;
    latestUserMessageAt?: number | null;
    firstUserMessage?: string | null;
    runningActivityText?: string | null;
    runningActivityAt?: number | null;
    runningStartedAt?: number | null;
  } = {},
): void {
  if (typeof window === "undefined" || !threadId) return;
  window.dispatchEvent(
    new CustomEvent("camelai:thread-status", {
      detail: { threadId, status, ...options },
    }),
  );
}

function dispatchLocalThreadSummaryUpdate(
  threadId: string | null | undefined,
  patch: {
    title?: string;
    model?: LlmModel;
    updatedAt?: number;
  },
): void {
  if (typeof window === "undefined" || !threadId) return;
  const updatedAt =
    typeof patch.updatedAt === "number" && Number.isFinite(patch.updatedAt)
      ? patch.updatedAt
      : Date.now();
  window.dispatchEvent(
    new CustomEvent("camelai:thread-status", {
      detail: { threadId, ...patch, updatedAt },
    }),
  );
}

function isChatGroupAvatarStatus(
  value: unknown,
): value is ChatGroupAvatarStatus {
  return (
    value === "pending" ||
    value === "generated" ||
    value === "user" ||
    value === "default"
  );
}

function isChatGroupAvatar(value: unknown): value is ChatGroupAvatar {
  if (!value || typeof value !== "object") return false;
  const avatar = value as {
    color?: unknown;
    content?: unknown;
    status?: unknown;
  };
  return (
    typeof avatar.color === "string" &&
    typeof avatar.content === "string" &&
    (avatar.status === undefined || isChatGroupAvatarStatus(avatar.status))
  );
}

function dispatchLocalChatGroupAvatarUpdate(
  threadId: string | null | undefined,
  groupId: string | null | undefined,
  avatar: ChatGroupAvatar | null | undefined,
): void {
  if (typeof window === "undefined" || !threadId || !groupId || !avatar) return;
  window.dispatchEvent(
    new CustomEvent("camelai:chat-group-avatar", {
      detail: {
        threadId,
        groupId,
        avatar,
        updatedAt: Date.now(),
      },
    }),
  );
}

function isComposerVisiblyEmpty(
  text: string,
  attachments: Attachment[],
): boolean {
  return text.trim().length === 0 && attachments.length === 0;
}

function areDraftAttachmentsEqual(
  left: Attachment[],
  right: Attachment[],
): boolean {
  const leftSerialized = serializeAttachments(left);
  const rightSerialized = serializeAttachments(right);

  if (leftSerialized.length !== rightSerialized.length) {
    return false;
  }

  return leftSerialized.every((attachment, index) => {
    const other = rightSerialized[index];
    return (
      attachment.id === other.id &&
      attachment.name === other.name &&
      attachment.path === other.path &&
      attachment.size === other.size &&
      attachment.contentType === other.contentType &&
      attachment.originalName === other.originalName &&
      attachment.kind === other.kind &&
      attachment.sourceThreadId === other.sourceThreadId &&
      attachment.sourceTitle === other.sourceTitle &&
      attachment.snippet === other.snippet
    );
  });
}

function isSubmittedDraftStillVisible(
  currentText: string,
  currentAttachments: Attachment[],
  submittedText: string,
  submittedAttachments: Attachment[],
): boolean {
  return (
    currentText === submittedText &&
    areDraftAttachmentsEqual(currentAttachments, submittedAttachments)
  );
}

interface PendingDeliveryDraft {
  workspaceId: string;
  threadId: string | null;
  clientMessageId: string;
  text: string;
  attachments: Attachment[];
  acceptedAt: number | null;
}

function pendingDeliveryDraftFromStored(
  workspaceId: string,
  threadId: string | null,
  draft: DeliveryDraftData,
): PendingDeliveryDraft {
  return {
    workspaceId,
    threadId,
    clientMessageId: draft.clientMessageId,
    text: draft.text,
    attachments: draft.attachments,
    acceptedAt: draft.acceptedAt,
  };
}

function getCompletedAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((attachment) => attachment.status === "complete");
}

function buildMessageContent(text: string, attachments: Attachment[]): string {
  return appendAttachmentReferences(
    text,
    getCompletedAttachments(attachments).map((attachment) => ({
      path: attachment.path,
      kind:
        attachment.kind === "transcript"
          ? "generated_transcript"
          : "user_upload",
      sourceThreadId: attachment.sourceThreadId,
      sourceTitle: attachment.sourceTitle,
    })),
  );
}

function sanitizeGeneratedFilename(value: string): string {
  const basename = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return basename || "chat";
}

const STREAM_MESSAGE_RENDER_THROTTLE_MS = 50;

const CHAT_SCROLL_CONTAINER_STYLE = {
  overflowAnchor: "none",
} as CSSProperties;

export default function Chat({
  threadId,
  workspaceId,
  initialMessages,
  initialUiMessages,
  olderUiMessagesCursor = null,
  initialTodos = [],
  threadModel: providedThreadModel,
  llmProvider,
  allowedThreadModels: providedAllowedThreadModels,
  modelOptions: providedModelOptions,
  effectivePickerDefaultModel = null,
  hasEffectivePickerDefault = false,
  billingAccessMode = null,
  canUnlockPremiumModels = false,
  hostedCreditsPaused = null,
  modelPickerSettingsHref = "/settings/organization/models",
  allowOpenAiSubscription = false,
  isOrgAdmin = false,
  recentModelScope,
  billingCreditStatus,
  initialError,
  newChatActionError,
  initialPreviewTabs,
  initialActiveTabId,
  hostname,
  orgSlug,
  isLoadingMessages = false,
  readOnly = false,
  chatGroupId = null,
  initialWelcomeInput,
  connections,
  projects,
  onSnapshotChange,
  bridgedStreamingMessageId,
  welcomeData,
}: ChatProps) {
  const threadModel =
    providedThreadModel &&
    !isModelVisibleForChatRuntime(providedThreadModel, billingAccessMode)
      ? getDefaultLlmModel(llmProvider)
      : providedThreadModel;
  const allowedThreadModels = useMemo(
    () =>
      providedAllowedThreadModels?.filter((model) =>
        isModelVisibleForChatRuntime(model, billingAccessMode),
      ),
    [billingAccessMode, providedAllowedThreadModels],
  );
  const modelOptions = useMemo(
    () =>
      providedModelOptions?.filter((entry) =>
        isModelVisibleForChatRuntime(entry.id, billingAccessMode),
      ),
    [billingAccessMode, providedModelOptions],
  );
  const navigate = useNavigate();
  const location = useLocation();
  const locationPathname = location.pathname;
  const locationSearch = location.search;
  const locationHash = location.hash;
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const chatGroupsContext = useOptionalChatGroups();
  const updateThreadModelFetcher = useFetcher<{
    thread?: {
      id: string;
      model: LlmModel;
      updated_at: number;
    };
    error?: string;
  }>();
  const creditPacksFetcher = useFetcher<CreditPacksResourceData>();
  const providerFetcher = useFetcher<{
    success?: boolean;
    error?: string;
  }>();
  const billingStatusFetcher = useFetcher<BillingCreditStatusResourceData>();
  const mentionSourcesFetcher = useFetcher<{
    connections?: Integration[];
    projects?: MentionableProject[];
    error?: string;
  }>();
  const { user, currentWorkspace, currentOrg, orgs } = useAuthData();
  // Route data is authoritative, while auth context is a safe fallback during
  // client transitions and for older cached route payloads.
  const resolvedOrgSlug = orgSlug ?? currentOrg?.slug;
  const { isSidebarBillingDialogOpen } = useBillingDialogPresence();
  const isMobile = useIsMobile();
  const resolvedWorkspaceId = readOnly
    ? workspaceId
    : (currentWorkspace?.id ?? workspaceId);
  const isSubmittingNewThread =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "createThreadAndStart";
  const {
    loaderErrorIdsRef,
    parsedInitialMessages,
    stableInitialUiMessages,
  } = useInitialChatTranscript({
    threadId,
    initialMessages,
    initialUiMessages,
  });
  const initialPreviewSession = useMemo(
    () =>
      normalizePreviewSessionState(
        initialPreviewTabs,
        initialActiveTabId,
        null,
      ),
    [initialPreviewTabs, initialActiveTabId],
  );

  // ai-chat owns the durable render history now. `messages` here holds only
  // optimistic pending user bubbles (the just-sent message before its persisted
  // skeleton echoes back through the hook); the transcript itself lives in the
  // stream hook below and is reconciled by id/clientMessageId at render time.
  const {
    state: messages,
    stateRef: messagesRef,
    setImmediate: setMessages,
  } = useBufferedState<Message[]>([], STREAM_MESSAGE_RENDER_THROTTLE_MS);
  const [loading, setLoading] = useState(false);
  const [billingDialog, setBillingDialog] = useState<BillingDialogState>({
    kind: "none",
  });
  const billingDialogRef = useRef(billingDialog);
  billingDialogRef.current = billingDialog;
  const billingIdentityKey = getBillingDialogIdentityKey(
    user?.id,
    currentOrg?.id,
  );
  const previousBillingIdentityKeyRef = useRef(billingIdentityKey);
  const autoOpenedWelcomeIdentityKeysRef = useRef(new Set<string>());
  const openWelcomeIdentityRef = useRef<{
    userId: string;
    orgId: string;
  } | null>(null);
  const [selectedProvider, setSelectedProvider] =
    useState<OnboardingByokProvider>("openrouter");
  const [providerCredential, setProviderCredential] =
    useState<OrgScopedByokCredential>(EMPTY_BYOK_CREDENTIAL);
  const providerApiKey = resolveOrgScopedByokApiKey(
    providerCredential,
    currentOrg?.id,
  );
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [providerError, setProviderError] = useState<string | null>(null);
  const resetByokForm = useCallback(() => {
    setProviderCredential(EMPTY_BYOK_CREDENTIAL);
    setProviderError(null);
  }, []);
  const [modelFallbackNotice, setModelFallbackNotice] =
    useState<ChatAgentModelFallbackNotice | null>(null);
  const [pendingMessages, setPendingMessagesState] = useState<Message[]>([]);
  const [currentTodos, setCurrentTodos] = useState<TodoItem[]>(initialTodos);

  const agentEnabled = !readOnly && Boolean(threadId && resolvedWorkspaceId);
  // The transport's lifecycle callbacks reference many callbacks defined later in
  // the component; stable wrappers read them from a ref so the connection can
  // mount here, ahead of the render-history projection that depends on it.
  const agentCallbacksRef = useRef<{
    onOpen: () => void;
    onMessage: (event: SseAgentMessageEvent) => void;
    onClose: (event?: SseAgentCloseEvent) => void;
    onError: (error?: unknown) => void;
    onConnectionError: (error: {
      code?: number;
      reason?: string;
      wasClean?: boolean;
    }) => void;
    onStateUpdate: (state: ChatAgentState) => void;
  }>({
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
    onError: () => {},
    onConnectionError: () => {},
    onStateUpdate: () => {},
  });
  const agentSocket = useSseAgent<ChatAgentState>({
    agent: "chat-thread",
    name: threadId ?? "disabled",
    enabled: agentEnabled,
    query: {
      threadId: threadId ?? null,
      workspaceId: resolvedWorkspaceId ?? null,
    },
    onOpen: () => agentCallbacksRef.current.onOpen(),
    onMessage: (event) => agentCallbacksRef.current.onMessage(event),
    onClose: (event) => agentCallbacksRef.current.onClose(event),
    onError: (error) => agentCallbacksRef.current.onError(error),
    onConnectionError: (error) =>
      agentCallbacksRef.current.onConnectionError(error),
    onStateUpdate: (state) => agentCallbacksRef.current.onStateUpdate(state),
  });
  const piChat = usePiChatStream({
    agent: agentSocket,
    threadId,
    initialUiMessages: stableInitialUiMessages,
  });
  const piChatRef = useRef(piChat);
  piChatRef.current = piChat;
  const [archivedUiMessages, setArchivedUiMessages] = useState<UIMessage[]>([]);
  const [olderMessagesCursor, setOlderMessagesCursor] = useState<string | null>(
    olderUiMessagesCursor,
  );
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [olderMessagesError, setOlderMessagesError] = useState<string | null>(
    null,
  );
  const renderHistoryGenerationRef = useRef(0);
  const lastHydratedCursorPropRef = useRef(olderUiMessagesCursor);
  const residentUiMessagesRef = useRef<UIMessage[]>(
    piChat.uiMessages.length > 0
      ? piChat.uiMessages
      : (initialUiMessages ?? []),
  );
  const observedLiveResidentRef = useRef(piChat.uiMessages.length > 0);
  useEffect(() => {
    // Cached tab data can mount before its loader page resolves. Accept a later
    // cursor prop only during that initial generation; an authoritative
    // replacement permanently retires the old boundary.
    if (shouldHydrateRenderHistoryCursor(
      renderHistoryGenerationRef.current,
      lastHydratedCursorPropRef.current,
      olderUiMessagesCursor,
    )) {
      lastHydratedCursorPropRef.current = olderUiMessagesCursor;
      setOlderMessagesCursor(olderUiMessagesCursor);
    }
  }, [olderUiMessagesCursor]);
  useLayoutEffect(() => {
    const nextResident = piChat.uiMessages;
    // Some hook versions briefly expose an empty live list before applying the
    // loader seed. Do not mistake that hydration gap for an authoritative
    // clear; after the first non-empty live state, empty is a real reset.
    if (nextResident.length === 0 && !observedLiveResidentRef.current) return;
    const update = classifyResidentRenderHistoryUpdate(
      residentUiMessagesRef.current,
      nextResident,
    );
    residentUiMessagesRef.current = nextResident;
    observedLiveResidentRef.current = nextResident.length > 0;
    if (update.kind === "replacement") {
      renderHistoryGenerationRef.current += 1;
      setArchivedUiMessages([]);
      setOlderMessagesCursor(null);
      setOlderMessagesError(null);
      setIsLoadingOlderMessages(false);
    } else if (update.evicted.length > 0) {
      setArchivedUiMessages((current) =>
        appendEvictedRenderMessages(current, update.evicted),
      );
    }
  }, [piChat.uiMessages]);
  const isStreaming = piChat.isStreaming;
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

  // Snapshot the rendered transcript for instant paint on thread switch. Keyed
  // on the hook history + optimistic bubbles; `displayMessagesRef` holds the
  // merged view (defined below, read at effect time).
  useEffect(() => {
    if (!threadId || readOnly) return;
    onSnapshotChange?.({
      messages: displayMessagesRef.current,
      uiMessages: piChat.uiMessages,
      streamingMessageId: piChat.streamingMessageId,
      todos: currentTodos,
    });
  }, [
    currentTodos,
    piChat.messages,
    piChat.uiMessages,
    piChat.streamingMessageId,
    messages,
    onSnapshotChange,
    readOnly,
    threadId,
  ]);
  const [pendingQuestion, setPendingQuestion] =
    useState<AskUserQuestionData | null>(null);
  const optimisticallyAnsweredQuestionIdRef = useRef<string | null>(null);
  const currentChatPath = useMemo(
    () => `${locationPathname}${locationSearch}${locationHash}`,
    [locationHash, locationPathname, locationSearch],
  );
  const transitionBillingDialog = useCallback(
    (next: BillingDialogState) => {
      const previous = billingDialogRef.current;
      const transition = transitionBillingDialogState(
        previous,
        next,
      );
      if (previous.kind === "byok" && next.kind !== "byok") {
        resetByokForm();
      }
      if (transition.shouldRecordWelcomeDismissal) {
        const welcomeIdentity = openWelcomeIdentityRef.current;
        try {
          if (welcomeIdentity) {
            recordCamelCodeWelcomeDismissal(
              window.localStorage,
              welcomeIdentity.userId,
              welcomeIdentity.orgId,
            );
          }
        } catch {
          // Storage is optional. Closing the dialog must always succeed.
        }
        openWelcomeIdentityRef.current = null;
      }
      billingDialogRef.current = transition.state;
      setBillingDialog(transition.state);
    },
    [resetByokForm],
  );
  const handleBillingDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open) transitionBillingDialog({ kind: "none" });
    },
    [transitionBillingDialog],
  );
  useEffect(() => {
    if (previousBillingIdentityKeyRef.current === billingIdentityKey) return;
    previousBillingIdentityKeyRef.current = billingIdentityKey;
    resetByokForm();
    transitionBillingDialog({ kind: "none" });
  }, [billingIdentityKey, resetByokForm, transitionBillingDialog]);
  useEffect(() => {
    if (
      billingDialog.kind !== "none" ||
      !billingIdentityKey
    ) {
      return;
    }

    let shouldShowWelcome = false;
    try {
      shouldShowWelcome = shouldShowCamelCodeWelcome(window.localStorage, {
        billingAccessMode,
        userId: user?.id ?? null,
        orgId: currentOrg?.id ?? null,
        hasActiveThread: Boolean(threadId),
      });
    } catch {
      return;
    }

    const next = getWelcomeAutoOpenState(
      billingDialog,
      autoOpenedWelcomeIdentityKeysRef.current,
      billingIdentityKey,
      shouldShowWelcome,
    );
    if (!next || !user?.id || !currentOrg?.id) return;

    autoOpenedWelcomeIdentityKeysRef.current.add(billingIdentityKey);
    openWelcomeIdentityRef.current = {
      userId: user.id,
      orgId: currentOrg.id,
    };
    transitionBillingDialog(next);
  }, [
    billingAccessMode,
    billingDialog,
    billingIdentityKey,
    currentOrg?.id,
    threadId,
    transitionBillingDialog,
    user?.id,
  ]);
  const openPlanUpgrade = useCallback(() => {
    transitionBillingDialog({ kind: "plans" });
  }, [transitionBillingDialog]);
  const openBillingTopUp = useCallback(() => {
    transitionBillingDialog({ kind: "topup" });
    if (
      !creditPacksFetcher.data &&
      creditPacksFetcher.state === "idle" &&
      typeof creditPacksFetcher.load === "function"
    ) {
      creditPacksFetcher.load("/api/billing/credit-packs");
    }
  }, [creditPacksFetcher, transitionBillingDialog]);
  const openByokDialog = useCallback(() => {
    resetByokForm();
    transitionBillingDialog({ kind: "byok" });
  }, [resetByokForm, transitionBillingDialog]);
  const openOpenAiSignIn = useCallback(() => {
    transitionBillingDialog({ kind: "openai" });
  }, [transitionBillingDialog]);
  const isAnyBillingDialogOpen = hasActiveBillingDialog(
    billingDialog,
    isSidebarBillingDialogOpen,
  );

  useEffect(() => {
    if (providerFetcher.state !== "idle" || !providerFetcher.data) return;
    if (providerFetcher.data.error) {
      setProviderError(providerFetcher.data.error);
      return;
    }
    if (providerFetcher.data.success) {
      if (billingDialogRef.current.kind === "byok") {
        transitionBillingDialog({ kind: "none" });
      }
      revalidator.revalidate();
    }
  }, [
    providerFetcher.data,
    providerFetcher.state,
    revalidator,
    transitionBillingDialog,
  ]);

  const saveByokProvider = useCallback(() => {
    if (!currentOrg?.id) {
      setProviderError("We couldn't identify the current organization.");
      return;
    }
    if (!providerApiKey.trim()) {
      setProviderError("Enter an API key to continue.");
      return;
    }
    setProviderError(null);
    const payload: Record<string, string> = {
      intent: "setProvider",
      provider: selectedProvider,
    };
    if (selectedProvider === "bedrock") {
      payload.bearer_token = providerApiKey.trim();
      payload.aws_region = awsRegion;
    } else {
      payload.api_key = providerApiKey.trim();
    }
    providerFetcher.submit(payload, {
      method: "POST",
      action: `/api/orgs/${currentOrg.id}/llm-provider`,
      encType: "application/json",
    });
  }, [
    awsRegion,
    currentOrg?.id,
    providerApiKey,
    providerFetcher,
    selectedProvider,
  ]);
  useCheckoutStatus({
    hash: locationHash,
    navigate,
    pathname: locationPathname,
    search: locationSearch,
  });

  useEffect(() => {
    if (!initialWelcomeInput) {
      return;
    }

    setWelcomeInput((current) => {
      const shouldApply =
        current.trim().length === 0 ||
        current === lastAppliedWelcomeInputRef.current;

      if (!shouldApply) {
        return current;
      }

      lastAppliedWelcomeInputRef.current = initialWelcomeInput;
      return initialWelcomeInput;
    });
  }, [initialWelcomeInput]);

  useEffect(() => {
    if (threadId) {
      return;
    }
    if (!locationSearch.includes("prompt_key=")) {
      return;
    }

    const url = new URL(window.location.href);
    if (!url.searchParams.has("prompt_key")) {
      return;
    }

    url.searchParams.delete("prompt_key");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [locationSearch, threadId]);

  const previousWelcomeWorkspaceIdRef = useRef<string | null>(
    resolvedWorkspaceId ?? null,
  );

  useEffect(() => {
    if (threadId || readOnly) {
      previousWelcomeWorkspaceIdRef.current = resolvedWorkspaceId ?? null;
      return;
    }

    const nextWorkspaceId = resolvedWorkspaceId ?? null;
    if (previousWelcomeWorkspaceIdRef.current === nextWorkspaceId) {
      return;
    }

    previousWelcomeWorkspaceIdRef.current = nextWorkspaceId;
    pendingDeliveryDraftRef.current = null;
    skipNextEmptyDraftSaveRef.current = false;

    const nextDraft = initialWelcomeInput
      ? null
      : loadDraft(nextWorkspaceId, null);
    setWelcomeInput(initialWelcomeInput ?? nextDraft?.text ?? "");
    setAttachments(nextDraft?.attachments ?? []);
  }, [initialWelcomeInput, readOnly, resolvedWorkspaceId, threadId]);

  const {
    clearManualCompactionQueue,
    compactingPriorMessageId,
    compactingPriorMessageIdRef,
    completeActiveManualCompaction,
    hasCapturedCompactionSummaryRef,
    isAutoCompactingRef,
    isCompacting,
    queueManualCompaction,
    setCompactingPriorMessageId,
    syncCompactionIndicator,
  } = useChatCompaction();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const {
    displayMessages,
    displayMessagesRef,
    skillSheetsByToolId,
    visibleMessages,
  } = useChatTranscriptProjection({
    archivedUiMessages,
    bridgedStreamingMessageId,
    threadId,
    liveMessages: piChat.messages,
    liveUiMessages: piChat.uiMessages,
    optimisticMessages: messages,
    parsedInitialMessages,
    readOnly,
  });
  // Turn duration/completion badges keyed by the assistant message id, plus the
  // one-shot "freshly completed" highlight. Derived from each completed turn's
  // metadata (turnDurationMs / completedAtMs ride message-metadata.pi on the
  // assistant message). Replaces the retired Agent-state lastCompletedTurn channel.
  const {
    completedTurns,
    freshlyCompletedTurnId,
    clearFreshlyCompletedTurnId,
  } = useCompletedTurns(displayMessages, threadId);
  useFreeTierUpgradePrompt({
    freshlyCompletedTurnId,
    enabled: billingAccessMode === "camel_free" && !readOnly,
    userId: user?.id ?? null,
    orgId: currentOrg?.id ?? null,
    isOrgAdmin,
    isAnyBillingDialogOpen,
    onShow: openPlanUpgrade,
  });
  // Refs to track current state for use in callbacks (avoids stale closures)
  // The most recent terminal error already surfaced, so the state-driven error
  // is shown exactly once even across re-renders/reconnects.
  const lastAppliedErrorIdRef = useRef<string | null>(null);
  const pendingMessagesRef = useRef(pendingMessages);
  const acceptedPendingMessageIdsRef = useRef<Set<string>>(new Set());
  const billingRefreshSequenceRef = useRef(0);
  const pendingThreadContextRef = useRef({
    workspaceId: resolvedWorkspaceId,
    threadId,
    readOnly,
  });
  pendingThreadContextRef.current = {
    workspaceId: resolvedWorkspaceId,
    threadId,
    readOnly,
  };

  const prevInitialUiMessagesRef = useRef(stableInitialUiMessages);
  const prevInitialTodosRef = useRef(initialTodos);
  const hasSyncedInitialPreviewRef = useRef(false);
  const previousPreviewThreadIdRef = useRef(threadId);

  const setPendingMessages = useCallback(
    (updater: Message[] | ((prev: Message[]) => Message[])) => {
      const next =
        typeof updater === "function"
          ? updater(pendingMessagesRef.current)
          : updater;
      pendingMessagesRef.current = next;
      setPendingMessagesState(next);
    },
    [],
  );

  // Reconcile the loader's ai-chat render history into the hook. Covers the
  // deferred initial load (hook seeded empty at mount, payload resolves after)
  // and the missed-turn revalidation (a turn that finished while disconnected).
  // The hook owns history once it has any, so we never clobber a live turn or
  // overwrite a populated transcript with an empty loader result.
  useEffect(() => {
    if (stableInitialUiMessages === prevInitialUiMessagesRef.current) return;
    prevInitialUiMessagesRef.current = stableInitialUiMessages;
    if (readOnly) return;
    if (isStreamingRef.current || pendingMessagesRef.current.length > 0) return;
    const currentUiMessages = piChatRef.current.uiMessages;
    if (stableInitialUiMessages.length === 0 && currentUiMessages.length > 0) {
      return;
    }
    if (uiMessagesEquivalent(currentUiMessages, stableInitialUiMessages))
      return;
    piChatRef.current.setUiMessages(stableInitialUiMessages);
  }, [stableInitialUiMessages, readOnly]);

  // Drop optimistic pending bubbles once their persisted skeleton has echoed
  // back through the hook (matched by id / clientMessageId), so the local list
  // stays bounded to genuinely in-flight sends.
  useEffect(() => {
    if (messagesRef.current.length === 0) return;
    const baseKeys = new Set<string>();
    for (const message of piChat.messages) {
      baseKeys.add(message.id);
      if (message.clientMessageId) baseKeys.add(message.clientMessageId);
    }
    const remaining = messagesRef.current.filter(
      (message) =>
        !baseKeys.has(message.id) &&
        !(message.clientMessageId && baseKeys.has(message.clientMessageId)),
    );
    if (remaining.length !== messagesRef.current.length) {
      setMessages(remaining);
    }
  }, [piChat.messages, setMessages]);

  useLayoutEffect(() => {
    const initialTodosChanged = initialTodos !== prevInitialTodosRef.current;
    if (!initialTodosChanged) {
      return;
    }

    if (
      initialTodos.length === 0 ||
      currentTodos.length > 0 ||
      loading ||
      isStreaming ||
      pendingMessagesRef.current.length > 0
    ) {
      return;
    }
    prevInitialTodosRef.current = initialTodos;
    setCurrentTodos(initialTodos);
  }, [currentTodos.length, initialTodos, isStreaming, loading]);

  // The streaming assistant message is the transcript tail while the hook
  // reports an active stream (see usePiChatStream.streamingMessageId).
  const activeAssistantMessageId = piChat.streamingMessageId;
  const activeThreadRunningState = useMemo(
    () => getThreadRunningState(chatGroupsContext?.groups, threadId ?? null),
    [chatGroupsContext?.groups, threadId],
  );
  // assistantTurnActive / showGlobalAssistantIndicator are defined below after
  // the transcript tail and durable/live running state are available.
  const runningStartedAt = activeThreadRunningState.isRunning
    ? activeThreadRunningState.startedAt
    : null;
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ChatApiErrorPresentation | null>(() =>
    initialError
      ? getChatApiErrorPresentation(initialError, {
          llmProvider,
          threadModel,
        })
      : null,
  );
  const [welcomeInput, setWelcomeInput] = useState(
    () => initialWelcomeInput ?? "",
  );
  const appliedRecentModelScopeRef = useRef<string | null>(null);
  const optimisticThreadModelRef = useRef<{
    threadId: string;
    model: LlmModel;
  } | null>(null);
  const authoritativeThreadModelRef = useRef<AuthoritativeThreadModel | null>(
    null,
  );
  const baseAvailableThreadModels = useMemo<ModelPickerOption[]>(() => {
    if (Array.isArray(modelOptions)) {
      return [...modelOptions];
    }
    if (Array.isArray(allowedThreadModels)) {
      return modelCatalogEntriesForIds(allowedThreadModels);
    }

    const options = getVisibleLlmModelOptions(
      threadModel ?? getDefaultLlmModel(llmProvider),
      {
        orgProvider: llmProvider,
        allowOpenAiSubscription,
        allowCamelCode: billingAccessMode !== "selfhost",
      },
    );
    return modelCatalogEntriesForIds(options.map((option) => option.value));
  }, [
    allowedThreadModels,
    allowOpenAiSubscription,
    billingAccessMode,
    llmProvider,
    modelOptions,
    threadModel,
  ]);
  // A camelCode model supplied by the loader is a billing decision, not a
  // generic platform fallback. Do not let a stale premium recent-model choice
  // replace it for a zero-credit new chat.
  const shouldUseRecentModelFallback =
    !hasEffectivePickerDefault && threadModel !== CAMEL_CODE_LLM_MODEL;
  const modelRecentScope = useMemo<RecentModelScope | null>(() => {
    if (readOnly) return null;
    if (!shouldUseRecentModelFallback) return null;
    if (recentModelScope) return recentModelScope;
    if (!currentOrg?.id || !resolvedWorkspaceId) return null;
    return { orgId: currentOrg.id, workspaceId: resolvedWorkspaceId };
  }, [
    currentOrg?.id,
    readOnly,
    recentModelScope,
    resolvedWorkspaceId,
    shouldUseRecentModelFallback,
  ]);
  const [selectedThreadModel, setSelectedThreadModel] = useState<LlmModel>(() =>
    resolveSelectedThreadModel({
      threadId,
      threadModel,
      allowedThreadModels,
      llmProvider,
      availableThreadModels: baseAvailableThreadModels,
      effectivePickerDefaultModel,
      hasEffectivePickerDefault,
    }),
  );
  const selectedThreadModelRef = useRef<LlmModel>(selectedThreadModel);
  const locationSearchRef = useRef(locationSearch);

  useEffect(() => {
    selectedThreadModelRef.current = selectedThreadModel;
  }, [selectedThreadModel]);

  useEffect(() => {
    locationSearchRef.current = locationSearch;
  }, [locationSearch]);

  const {
    currentBillingCreditStatus,
    refreshedThreadModel,
    refreshBillingCreditStatusAfterTurn,
  } = useBillingCreditStatus({
    billingStatusFetcher,
    initialStatus: billingCreditStatus,
    threadId,
    selectedThreadModelRef,
    locationSearchRef,
  });
  const liveHostedCreditPause = useMemo(
    () =>
      deriveHostedCreditPause({
        modelOptions: baseAvailableThreadModels,
        billingAccessMode,
        llmProvider: llmProvider ?? null,
        allowOpenAiSubscription,
        billing: currentBillingCreditStatus
          ? ({
              billingStatus: currentBillingCreditStatus.billingStatus,
              availableCreditsCents:
                currentBillingCreditStatus.availableCreditsCents,
            } satisfies HostedCreditPauseBilling)
          : null,
      }),
    [
      allowOpenAiSubscription,
      baseAvailableThreadModels,
      billingAccessMode,
      currentBillingCreditStatus,
      llmProvider,
    ],
  );
  const availableThreadModels = liveHostedCreditPause.modelOptions;
  const effectiveHostedCreditsPaused = currentBillingCreditStatus
    ? liveHostedCreditPause.hostedCreditsPaused
    : hostedCreditsPaused;
  const availableThreadModelIds = useMemo(
    () =>
      new Set(
        availableThreadModels
          .filter((entry) => !entry.locked)
          .map((entry) => entry.id),
      ),
    [availableThreadModels],
  );
  const selectableThreadModels = useMemo(
    () => availableThreadModels.filter((entry) => !entry.locked),
    [availableThreadModels],
  );
  const cheapestSelectableModel = useMemo(
    () => findCheapestSelectableModel(availableThreadModels),
    [availableThreadModels],
  );
  const shouldAddCamelCodeToPicker = shouldPromptToAddCamelCode(
    availableThreadModels,
    effectiveHostedCreditsPaused,
  );
  const noModelsMessage =
    shouldAddCamelCodeToPicker
      ? "Add camelCode to the model picker to continue for free."
      : selectableThreadModels.length === 0 && !(threadId && threadModel)
        ? "No models are available. Ask an admin to add a model in Settings > Models."
        : null;
  const openUnlockPremium = useCallback(
    (triggerModel: LlmModel | null) => {
      if (
        shouldNavigateToBillingForPausedModel(
          effectiveHostedCreditsPaused?.reason,
          isOrgAdmin,
        )
      ) {
        navigate("/settings/organization/billing");
        return;
      }
      transitionBillingDialog({ kind: "unlock", triggerModel });
    },
    [
      effectiveHostedCreditsPaused?.reason,
      isOrgAdmin,
      navigate,
      transitionBillingDialog,
    ],
  );
  const displayedBillingCreditStatus = resolveDisplayedBillingCreditStatus(
    currentBillingCreditStatus,
    selectedThreadModel,
    Boolean(effectiveHostedCreditsPaused),
    llmProvider,
    allowOpenAiSubscription,
  );

  const lastAppliedWelcomeInputRef = useRef(initialWelcomeInput ?? "");
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>(() => []);
  const [contextUsedPercent, setContextUsedPercent] = useState<number | null>(
    null,
  );
  const attachmentPreviewUrlsRef = useRef<Set<string>>(new Set());
  const inputRef = useRef(input);
  const welcomeInputRef = useRef(welcomeInput);
  const attachmentsRef = useRef(attachments);
  inputRef.current = input;
  welcomeInputRef.current = welcomeInput;
  attachmentsRef.current = attachments;
  const prevErrorRef = useRef<ChatApiErrorPresentation | null>(null);
  const skipNextEmptyDraftSaveRef = useRef(false);
  const pendingDeliveryDraftRef = useRef<PendingDeliveryDraft | null>(null);
  const pendingNewThreadSubmissionRef = useRef<{
    text: string;
    attachments: Attachment[];
  } | null>(null);
  const handledNewChatActionErrorRef = useRef<string | null>(null);
  const pendingDraftCountRef = useRef(0);
  const restoredDraftKeyRef = useRef<string | null>(null);
  const { saveDraft, flushDraft, clearDraft } = useDraftPersistence(
    resolvedWorkspaceId,
    threadId ?? null,
  );
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    if (readOnly || !resolvedWorkspaceId) {
      return;
    }

    const restoreKey = `${resolvedWorkspaceId}:${threadId ?? "new"}:${initialWelcomeInput ?? ""}`;
    if (restoredDraftKeyRef.current === restoreKey) {
      return;
    }
    restoredDraftKeyRef.current = restoreKey;

    const draft = threadId
      ? loadDraft(resolvedWorkspaceId, threadId)
      : initialWelcomeInput
        ? null
        : loadDraft(resolvedWorkspaceId, null);
    if (!draft) {
      return;
    }

    if (threadId) {
      if (!isComposerVisiblyEmpty(inputRef.current, attachmentsRef.current)) {
        return;
      }
      skipNextEmptyDraftSaveRef.current = true;
      inputRef.current = draft.text;
      attachmentsRef.current = draft.attachments;
      setInput(draft.text);
      setAttachments(draft.attachments);
      return;
    }

    if (
      !isComposerVisiblyEmpty(welcomeInputRef.current, attachmentsRef.current)
    ) {
      return;
    }
    skipNextEmptyDraftSaveRef.current = true;
    welcomeInputRef.current = draft.text;
    attachmentsRef.current = draft.attachments;
    setWelcomeInput(draft.text);
    setAttachments(draft.attachments);
  }, [initialWelcomeInput, readOnly, resolvedWorkspaceId, threadId]);

  useLayoutEffect(() => {
    setError(
      initialError
        ? getChatApiErrorPresentation(initialError, {
            llmProvider,
            threadModel,
          })
        : null,
    );
  }, [initialError, llmProvider, threadModel]);

  useLayoutEffect(() => {
    if (
      !newChatActionError ||
      handledNewChatActionErrorRef.current === newChatActionError
    ) {
      return;
    }
    handledNewChatActionErrorRef.current = newChatActionError;

    const pendingSubmission = pendingNewThreadSubmissionRef.current;
    pendingNewThreadSubmissionRef.current = null;
    if (!pendingSubmission || threadId || readOnly) {
      return;
    }

    if (
      isComposerVisiblyEmpty(welcomeInputRef.current, attachmentsRef.current)
    ) {
      setWelcomeInput(pendingSubmission.text);
      setAttachments(pendingSubmission.attachments);
    }
    writeDraft(
      resolvedWorkspaceId,
      null,
      pendingSubmission.text,
      pendingSubmission.attachments,
    );
  }, [newChatActionError, readOnly, resolvedWorkspaceId, threadId]);

  const [previewTabs, setPreviewTabs] = useState<PreviewTab[]>(
    () => initialPreviewSession.tabs,
  );
  const [activeTabId, setActiveTabId] = useState<string | null>(
    () => initialPreviewSession.activeTabId,
  );
  const previewTabsRef = useRef<PreviewTab[]>(previewTabs);
  const activeTabIdRef = useRef<string | null>(activeTabId);
  previewTabsRef.current = previewTabs;
  activeTabIdRef.current = activeTabId;
  const activeTab = useMemo(
    () => previewTabs.find((tab) => tab.id === activeTabId) ?? null,
    [previewTabs, activeTabId],
  );
  const previewTarget = activeTab?.target ?? null;
  const [tabIframeKeys, setTabIframeKeys] = useState<Record<string, number>>(
    {},
  );
  const [tabFilePreviewKeys, setTabFilePreviewKeys] = useState<
    Record<string, number>
  >({});
  const [tabNotebookViewModes, setTabNotebookViewModes] = useState<
    Record<string, "report" | "notebook">
  >({});
  const [tabFileViewModes, setTabFileViewModes] = useState<
    Record<string, "preview" | "source">
  >({});
  const tabFileViewModesRef =
    useRef<Record<string, "preview" | "source">>(tabFileViewModes);
  tabFileViewModesRef.current = tabFileViewModes;
  const [tabNotebookStates, setTabNotebookStates] = useState<
    Record<string, NotebookPreviewLoadState>
  >({});
  const [tabNotebookPdfExporting, setTabNotebookPdfExporting] = useState<
    Record<string, boolean>
  >({});
  const [tabAppLoading, setTabAppLoading] = useState<Record<string, boolean>>(
    {},
  );
  const notebookViewMode = activeTabId
    ? (tabNotebookViewModes[activeTabId] ?? "report")
    : "report";
  const fileViewMode = activeTabId
    ? (tabFileViewModes[activeTabId] ?? "preview")
    : "preview";
  const activeNotebookState = activeTabId
    ? (tabNotebookStates[activeTabId] ?? DEFAULT_NOTEBOOK_PREVIEW_STATE)
    : DEFAULT_NOTEBOOK_PREVIEW_STATE;
  const isNotebookPdfExporting = activeTabId
    ? Boolean(tabNotebookPdfExporting[activeTabId])
    : false;
  const [mobileView, setMobileView] = useState<"chat" | "preview">("chat");
  const previewVersionRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageColumnRef = useRef<HTMLDivElement>(null);
  const olderPageScrollAnchorRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const initialScrollDoneRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const forceScrollOnNextUpdate = useRef(false);
  const chatAgentRef = useRef<ChatAgentClient | null>(null);

  const loadOlderMessages = useCallback(async () => {
    const cursor = olderMessagesCursor;
    if (!cursor || isLoadingOlderMessages) return;
    const requestGeneration = renderHistoryGenerationRef.current;

    setIsLoadingOlderMessages(true);
    setOlderMessagesError(null);
    try {
      const page = (await agentSocket.call("getOlderUiMessages", [
        cursor,
      ])) as ChatRenderHistoryPage;
      if (!page || !Array.isArray(page.messages)) {
        throw new Error("Invalid render-history page");
      }
      if (
        !isCurrentRenderHistoryGeneration(
          requestGeneration,
          renderHistoryGenerationRef.current,
        )
      ) {
        return;
      }

      const container = scrollContainerRef.current;
      if (container) {
        olderPageScrollAnchorRef.current = {
          scrollHeight: container.scrollHeight,
          scrollTop: container.scrollTop,
        };
      }
      // A page can come back carrying a message that is neither archived nor
      // resident — a legacy `d:` cursor rewinds the server to the NEWEST page,
      // and another session's turn can land in it. Prepending that to the head
      // of the archived array would render a brand-new message at the OLDEST end
      // of the transcript, so drop anything already resident (the resident copy
      // is authoritative and renders in its own place).
      const residentIds = new Set(
        residentUiMessagesRef.current.map((message) => message.id),
      );
      const olderOnly = page.messages.filter(
        (message) => !residentIds.has(message.id),
      );
      setArchivedUiMessages((current) =>
        prependOlderRenderMessages(current, olderOnly),
      );
      setOlderMessagesCursor(
        page.hasMore &&
          typeof page.nextCursor === "string" &&
          page.nextCursor.length > 0
          ? page.nextCursor
          : null,
      );
    } catch (error) {
      if (
        !isCurrentRenderHistoryGeneration(
          requestGeneration,
          renderHistoryGenerationRef.current,
        )
      ) {
        return;
      }
      console.error("Failed to load earlier chat messages:", error);
      setOlderMessagesError("Could not load earlier messages.");
    } finally {
      if (
        isCurrentRenderHistoryGeneration(
          requestGeneration,
          renderHistoryGenerationRef.current,
        )
      ) {
        setIsLoadingOlderMessages(false);
      }
    }
  }, [agentSocket, isLoadingOlderMessages, olderMessagesCursor]);

  useLayoutEffect(() => {
    const anchor = olderPageScrollAnchorRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) return;
    olderPageScrollAnchorRef.current = null;
    container.scrollTop =
      anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight);
  }, [archivedUiMessages]);

  const optimisticallyClearedConnectionSetupRequestIdRef = useRef<
    string | null
  >(null);
  const {
    connectionSetupPrompt,
    handleConnectionSetupCancel: handleConnectionSetupCancelBase,
    handleConnectionSetupResponse,
    setConnectionSetupPrompt,
  } = useConnectionSetupResponse({
    chatAgentRef,
  });
  const handleConnectionSetupCancel = useCallback(() => {
    if (connectionSetupPrompt?.requestId) {
      optimisticallyClearedConnectionSetupRequestIdRef.current =
        connectionSetupPrompt.requestId;
    }
    handleConnectionSetupCancelBase();
  }, [connectionSetupPrompt?.requestId, handleConnectionSetupCancelBase]);
  const lastRunnerModelSelectionRef = useRef<string | null>(null);
  const iframeRefreshTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const iframeRetryCountsRef = useRef<Record<string, number>>({});
  const iframeRetryTimeoutsRef = useRef<
    Record<string, ReturnType<typeof setTimeout>>
  >({});
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fallbackRenderedAtRef = useRef<number>(Date.now());

  useLayoutEffect(() => {
    initialScrollDoneRef.current = false;
    stickToBottomRef.current = true;
    setCurrentTodos(initialTodos);
    setPendingQuestion(null);
    setContextUsedPercent(null);
    lastAppliedErrorIdRef.current = null;
    setModelFallbackNotice(null);
    compactingPriorMessageIdRef.current = null;
    setCompactingPriorMessageId(null);
  }, [threadId]);

  const clearAllIframeRefreshTimeouts = useCallback(() => {
    for (const timeout of Object.values(iframeRefreshTimeoutsRef.current)) {
      clearTimeout(timeout);
    }
    iframeRefreshTimeoutsRef.current = {};
    for (const timeout of Object.values(iframeRetryTimeoutsRef.current)) {
      clearTimeout(timeout);
    }
    iframeRetryTimeoutsRef.current = {};
    iframeRetryCountsRef.current = {};
  }, []);

  const setLocalPreviewSessionState = useCallback(
    (nextTabs: PreviewTab[], nextActiveTabId: string | null) => {
      previewTabsRef.current = nextTabs;
      setPreviewTabs(nextTabs);
      activeTabIdRef.current = nextActiveTabId;
      setActiveTabId(nextActiveTabId);
    },
    [],
  );

  useLayoutEffect(() => {
    const nextTabs = threadId ? initialPreviewSession.tabs : [];
    const nextActiveTabId = threadId ? initialPreviewSession.activeTabId : null;
    const didThreadChange = previousPreviewThreadIdRef.current !== threadId;
    previousPreviewThreadIdRef.current = threadId;

    if (
      !didThreadChange &&
      arePreviewSessionsSemanticallyEqual(
        previewTabsRef.current,
        activeTabIdRef.current,
        nextTabs,
        nextActiveTabId,
      )
    ) {
      if (
        !arePreviewSessionsExactlyEqual(
          previewTabsRef.current,
          activeTabIdRef.current,
          nextTabs,
          nextActiveTabId,
        )
      ) {
        setLocalPreviewSessionState(nextTabs, nextActiveTabId);
      }
      return;
    }

    previewTabsRef.current = nextTabs;
    setPreviewTabs(nextTabs);
    activeTabIdRef.current = nextActiveTabId;
    setActiveTabId(nextActiveTabId);

    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabFileViewModes({});
    setTabNotebookStates({});
    setTabNotebookPdfExporting({});
    setTabAppLoading({});
    previewVersionRef.current = 0;
    clearAllIframeRefreshTimeouts();
    setMobileView("chat");
  }, [
    threadId,
    initialPreviewSession.tabs,
    initialPreviewSession.activeTabId,
    clearAllIframeRefreshTimeouts,
    setLocalPreviewSessionState,
  ]);

  // Retry iframe on transient errors (404/500/503) during deploy.
  // Dispatcher error pages postMessage({ type: 'chiridion-preview-error', status }) to parent.
  const IFRAME_MAX_RETRIES = 3;
  const IFRAME_RETRY_DELAY_MS = 2000;
  useEffect(() => {
    const appOriginContext = hostname && resolvedOrgSlug
      ? { hostname, orgSlug: resolvedOrgSlug }
      : null;

    function handlePreviewError(event: MessageEvent) {
      if (
        !event.data ||
        event.data.type !== "chiridion-preview-error" ||
        typeof event.data.status !== "number"
      )
        return;
      const status = event.data.status as number;
      if (status !== 404 && status !== 500 && status !== 503) return;

      // Match the message origin to an app tab
      const tabs = previewTabsRef.current;
      const matchedTab = appOriginContext
        ? tabs.find((tab) => {
            if (tab.target.kind !== "app") return false;
            const s = tab.target.scriptName;
            const expectedOrigin = new URL(
              getAppIframeUrl(s, appOriginContext.hostname, appOriginContext.orgSlug),
            ).origin;
            return event.origin === expectedOrigin;
          })
        : null;
      const tabId = matchedTab?.id ?? activeTabIdRef.current;
      if (!tabId) return;
      if (tabId !== activeTabIdRef.current) return;

      const retries = iframeRetryCountsRef.current[tabId] ?? 0;
      if (retries >= IFRAME_MAX_RETRIES) return;
      if (iframeRetryTimeoutsRef.current[tabId]) return;

      iframeRetryCountsRef.current[tabId] = retries + 1;
      iframeRetryTimeoutsRef.current[tabId] = setTimeout(() => {
        delete iframeRetryTimeoutsRef.current[tabId];
        setTabIframeKeys((prev) => ({
          ...prev,
          [tabId]: (prev[tabId] ?? 0) + 1,
        }));
      }, IFRAME_RETRY_DELAY_MS);
    }

    window.addEventListener("message", handlePreviewError);
    return () => window.removeEventListener("message", handlePreviewError);
  }, [hostname, resolvedOrgSlug]);

  const clearIframeTimersForTab = useCallback((tabId: string) => {
    const refreshTimeout = iframeRefreshTimeoutsRef.current[tabId];
    if (refreshTimeout) {
      clearTimeout(refreshTimeout);
      delete iframeRefreshTimeoutsRef.current[tabId];
    }
    const retryTimeout = iframeRetryTimeoutsRef.current[tabId];
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      delete iframeRetryTimeoutsRef.current[tabId];
    }
    delete iframeRetryCountsRef.current[tabId];
    setTabAppLoading((prev) => {
      if (!(tabId in prev)) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    for (const tabId of Object.keys(iframeRefreshTimeoutsRef.current)) {
      if (tabId !== activeTabId) clearIframeTimersForTab(tabId);
    }
    for (const tabId of Object.keys(iframeRetryTimeoutsRef.current)) {
      if (tabId !== activeTabId) clearIframeTimersForTab(tabId);
    }
  }, [activeTabId, clearIframeTimersForTab]);

  const revokeAttachmentPreviewUrl = useCallback((url?: string) => {
    if (!url) return;
    attachmentPreviewUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const appIsPublic =
    previewTarget?.kind === "app" ? previewTarget.isPublic : false;
  const setAppIsPublic = useCallback(
    (isPublic: boolean) => {
      if (!activeTabId) return;
      setPreviewTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeTabId || tab.target.kind !== "app") return tab;
          return {
            ...tab,
            target: {
              ...tab.target,
              isPublic,
            },
          };
        }),
      );
    },
    [activeTabId],
  );

  useEffect(() => {
    if (!currentTodos.length || isStreaming) return;
    const allComplete = currentTodos.every(
      (todo) => todo.status === "completed",
    );
    const timeout = setTimeout(
      () => {
        setCurrentTodos([]);
      },
      allComplete ? 1500 : 2000,
    );
    return () => clearTimeout(timeout);
  }, [currentTodos, isStreaming]);

  useEffect(() => {
    const optimistic = optimisticThreadModelRef.current;
    if (
      threadId &&
      optimistic?.threadId === threadId &&
      threadModel !== optimistic.model
    ) {
      return;
    }
    if (
      threadId &&
      optimistic?.threadId === threadId &&
      threadModel === optimistic.model
    ) {
      optimisticThreadModelRef.current = null;
    }
    const recentModel =
      !threadId && modelRecentScope
        ? getRecentModel(modelRecentScope, { orgProvider: llmProvider })
        : null;
    setSelectedThreadModel(
      resolveSelectedThreadModel({
        threadId,
        threadModel,
        allowedThreadModels,
        llmProvider,
        availableThreadModels,
        effectivePickerDefaultModel,
        hasEffectivePickerDefault,
        recentModel,
      }),
    );
  }, [
    allowedThreadModels,
    availableThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    llmProvider,
    modelRecentScope,
    threadId,
    threadModel,
  ]);

  // Track connection ID to ignore events from stale transport instances
  // Ref to hold stable connect function for effect
  const resolvedWelcomeData = welcomeData ?? {
    userId: user?.id ?? null,
    userName: user?.name ?? null,
    allApps: EMPTY_WORKER_APPS,
    connections: EMPTY_INTEGRATIONS,
    projects: EMPTY_MENTION_PROJECTS,
    recentThreads: EMPTY_RECENT_THREADS,
    renderedAt: fallbackRenderedAtRef.current,
    group: undefined,
  };
  const rawMentionConnections = connections ?? resolvedWelcomeData.connections;
  const rawMentionProjects = projects ?? resolvedWelcomeData.projects;
  const [resolvedMentionConnections, setResolvedMentionConnections] = useState<
    Integration[]
  >(() => (Array.isArray(rawMentionConnections) ? rawMentionConnections : []));
  const [resolvedMentionProjects, setResolvedMentionProjects] = useState<
    MentionableProject[]
  >(() => (Array.isArray(rawMentionProjects) ? rawMentionProjects : []));
  useEffect(() => {
    if (Array.isArray(rawMentionConnections)) {
      setResolvedMentionConnections(rawMentionConnections);
      return;
    }
    if (!isPromiseLike(rawMentionConnections)) {
      setResolvedMentionConnections([]);
      return;
    }

    let cancelled = false;
    rawMentionConnections
      .then((nextConnections) => {
        if (!cancelled) setResolvedMentionConnections(nextConnections);
      })
      .catch(() => {
        if (!cancelled) setResolvedMentionConnections([]);
      });

    return () => {
      cancelled = true;
    };
  }, [rawMentionConnections]);
  useEffect(() => {
    if (Array.isArray(rawMentionProjects)) {
      setResolvedMentionProjects(rawMentionProjects);
      return;
    }
    if (!isPromiseLike(rawMentionProjects)) {
      setResolvedMentionProjects([]);
      return;
    }

    let cancelled = false;
    rawMentionProjects
      .then((nextProjects) => {
        if (!cancelled) setResolvedMentionProjects(nextProjects);
      })
      .catch(() => {
        if (!cancelled) setResolvedMentionProjects([]);
      });

    return () => {
      cancelled = true;
    };
  }, [rawMentionProjects]);
  const mentionEntities = useMemo<AtMentionEntity[]>(
    () => [
      ...resolvedMentionConnections.map((connection) => ({
        ...connection,
        kind: "connection" as const,
      })),
      ...resolvedMentionProjects,
    ],
    [resolvedMentionConnections, resolvedMentionProjects],
  );
  const mentionSlugMap = useMemo(
    () => buildSlugMap(mentionEntities),
    [mentionEntities],
  );
  const formatFilePathForCopy = useCallback(
    (target: CopyFilePathTarget) =>
      formatCopyFilePath(target, { mentionSlugMap }),
    [mentionSlugMap],
  );
  const visibleProjectReferences = useMemo(
    () => [
      ...collectProjectReferencesFromPreviewTabs(previewTabs),
      ...collectProjectReferencesFromMessages(visibleMessages),
    ],
    [previewTabs, visibleMessages],
  );
  const attemptedProjectMentionRefreshesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    attemptedProjectMentionRefreshesRef.current.clear();
  }, [resolvedWorkspaceId, threadId]);
  useEffect(() => {
    if (!resolvedWorkspaceId) return;
    if (mentionSourcesFetcher.state !== "idle") return;

    for (const reference of visibleProjectReferences) {
      if (
        resolveProjectMentionSlug(reference.project, mentionSlugMap, {
          projectId: reference.projectId,
        })
      ) {
        continue;
      }

      const projectKey = normalizeProjectCopyLookupKey(reference.project);
      if (!projectKey) continue;
      if (attemptedProjectMentionRefreshesRef.current.has(projectKey)) {
        continue;
      }
      attemptedProjectMentionRefreshesRef.current.add(projectKey);
      mentionSourcesFetcher.load(
        `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/mentions`,
      );
      return;
    }
  }, [
    mentionSlugMap,
    mentionSourcesFetcher,
    resolvedWorkspaceId,
    threadId,
    visibleProjectReferences,
  ]);
  const lastMentionSourcesFetchAtRef = useRef(0);
  const handleMentionMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open || !resolvedWorkspaceId) return;
      if (mentionSourcesFetcher.state !== "idle") return;
      const now = Date.now();
      if (now - lastMentionSourcesFetchAtRef.current < 15_000) return;
      lastMentionSourcesFetchAtRef.current = now;
      mentionSourcesFetcher.load(
        `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/mentions`,
      );
    },
    [mentionSourcesFetcher, resolvedWorkspaceId],
  );
  useEffect(() => {
    const data = mentionSourcesFetcher.data;
    if (data && Array.isArray(data.connections)) {
      setResolvedMentionConnections(data.connections);
    }
    if (data && Array.isArray(data.projects)) {
      setResolvedMentionProjects(data.projects);
    }
  }, [mentionSourcesFetcher.data]);
  const preserveDraftForDelivery = useCallback(
    (
      clientMessageId: string,
      draftThreadId: string | null,
      text: string,
      nextAttachments: Attachment[],
    ) => {
      if (!resolvedWorkspaceId) {
        return;
      }

      if (draftThreadId === (threadId ?? null)) {
        flushDraft(text, nextAttachments);
      } else {
        writeDraft(resolvedWorkspaceId, draftThreadId, text, nextAttachments);
      }

      pendingDraftCountRef.current++;
      pendingDeliveryDraftRef.current = {
        workspaceId: resolvedWorkspaceId,
        threadId: draftThreadId,
        clientMessageId,
        text,
        attachments: nextAttachments,
        acceptedAt: null,
      };
      writeDeliveryDraft(
        resolvedWorkspaceId,
        draftThreadId,
        clientMessageId,
        text,
        nextAttachments,
      );
      skipNextEmptyDraftSaveRef.current = true;
    },
    [flushDraft, resolvedWorkspaceId, threadId],
  );

  const getStoredPendingDeliveryDraft = useCallback(() => {
    const context = pendingThreadContextRef.current;
    const workspaceId = context.workspaceId;
    const deliveryThreadId = context.threadId ?? null;
    if (!workspaceId) {
      return null;
    }

    const storedDraft = loadDeliveryDraft(workspaceId, deliveryThreadId);
    return storedDraft
      ? pendingDeliveryDraftFromStored(
          workspaceId,
          deliveryThreadId,
          storedDraft,
        )
      : null;
  }, []);

  const syncNormalDraftAfterSubmitted = useCallback(
    (pendingDraft: PendingDeliveryDraft) => {
      const currentInput = inputRef.current;
      const currentAttachments = attachmentsRef.current;
      const submittedDraftStillVisible = isSubmittedDraftStillVisible(
        currentInput,
        currentAttachments,
        pendingDraft.text,
        pendingDraft.attachments,
      );

      // Cloudflare OS-style submit semantics: leave the submitted content in
      // the composer until the server has durably accepted it. Clear only the
      // exact snapshot that was sent; if the user edited the composer while the
      // RPC was in flight, their newer draft wins and must remain untouched.
      if (submittedDraftStillVisible) {
        inputRef.current = "";
        attachmentsRef.current = [];
        setInput("");
        for (const attachment of currentAttachments) {
          revokeAttachmentPreviewUrl(attachment.previewUrl);
        }
        setAttachments([]);
        removeDraft(pendingDraft.workspaceId, pendingDraft.threadId);
        return;
      }

      if (isComposerVisiblyEmpty(currentInput, currentAttachments)) {
        removeDraft(pendingDraft.workspaceId, pendingDraft.threadId);
        return;
      }

      writeDraft(
        pendingDraft.workspaceId,
        pendingDraft.threadId,
        currentInput,
        currentAttachments,
      );
    },
    [revokeAttachmentPreviewUrl],
  );

  const markPendingDeliveryDraftAccepted = useCallback(
    (clientMessageId: string) => {
      acceptedPendingMessageIdsRef.current.add(clientMessageId);
      const pendingDraft = pendingDeliveryDraftRef.current;

      if (pendingDraft?.clientMessageId === clientMessageId) {
        const acceptedAt = Date.now();
        pendingDeliveryDraftRef.current = { ...pendingDraft, acceptedAt };
        writeDeliveryDraft(
          pendingDraft.workspaceId,
          pendingDraft.threadId,
          clientMessageId,
          pendingDraft.text,
          pendingDraft.attachments,
          acceptedAt,
        );
        syncNormalDraftAfterSubmitted(pendingDraft);
        return;
      }

      const context = pendingThreadContextRef.current;
      const workspaceId = context.workspaceId;
      const deliveryThreadId = context.threadId ?? null;
      if (!workspaceId) {
        return;
      }

      const storedDraft = markDeliveryDraftAccepted(
        workspaceId,
        deliveryThreadId,
        clientMessageId,
      );
      if (!storedDraft) {
        return;
      }

      syncNormalDraftAfterSubmitted(
        pendingDeliveryDraftFromStored(
          workspaceId,
          deliveryThreadId,
          storedDraft,
        ),
      );
    },
    [syncNormalDraftAfterSubmitted],
  );

  const clearPendingDeliveryDraft = useCallback(() => {
    const pendingDraft =
      pendingDeliveryDraftRef.current ?? getStoredPendingDeliveryDraft();
    if (!pendingDraft) {
      return;
    }

    if (pendingDeliveryDraftRef.current) {
      // If multiple sends are in flight (sentDuringStreaming), only clear the
      // draft backup once the last turn completes — otherwise an earlier result
      // would delete the backup that a later, still-in-flight turn needs.
      pendingDraftCountRef.current = Math.max(
        0,
        pendingDraftCountRef.current - 1,
      );
      if (pendingDraftCountRef.current > 0) {
        return;
      }
    }

    pendingDeliveryDraftRef.current = null;
    syncNormalDraftAfterSubmitted(pendingDraft);
    removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
  }, [getStoredPendingDeliveryDraft, syncNormalDraftAfterSubmitted]);

  const restorePendingDeliveryDraft = useCallback(() => {
    const pendingDraft =
      pendingDeliveryDraftRef.current ?? getStoredPendingDeliveryDraft();
    pendingDeliveryDraftRef.current = null;
    pendingDraftCountRef.current = 0;

    if (!pendingDraft) {
      return;
    }

    // An accepted message is already part of the conversation. A later model
    // or stream failure must not put it back into the composer and invite a
    // duplicate send. Just retire its delivery backup.
    if (pendingDraft.acceptedAt) {
      syncNormalDraftAfterSubmitted(pendingDraft);
      removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
      return;
    }

    if (
      !isComposerVisiblyEmpty(inputRef.current, attachmentsRef.current) &&
      !isSubmittedDraftStillVisible(
        inputRef.current,
        attachmentsRef.current,
        pendingDraft.text,
        pendingDraft.attachments,
      )
    ) {
      removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
      return;
    }

    inputRef.current = pendingDraft.text;
    attachmentsRef.current = pendingDraft.attachments;
    setInput(pendingDraft.text);
    setAttachments(pendingDraft.attachments);
    writeDraft(
      pendingDraft.workspaceId,
      pendingDraft.threadId,
      pendingDraft.text,
      pendingDraft.attachments,
    );
    removeDeliveryDraft(pendingDraft.workspaceId, pendingDraft.threadId);
  }, [getStoredPendingDeliveryDraft, syncNormalDraftAfterSubmitted]);

  const normalizeChatError = useCallback(
    (
      value: unknown,
      context: Partial<ChatApiErrorContext> = {},
    ): ChatApiErrorPresentation =>
      getChatApiErrorPresentation(value, {
        llmProvider,
        threadModel: selectedThreadModel,
        ...context,
      }),
    [llmProvider, selectedThreadModel],
  );

  const showChatError = useCallback(
    (value: unknown, context: Partial<ChatApiErrorContext> = {}) => {
      setError(normalizeChatError(value, context));
    },
    [normalizeChatError],
  );

  const isPendingMessageAccepted = useCallback(
    (clientMessageId: string) => {
      if (acceptedPendingMessageIdsRef.current.has(clientMessageId)) {
        return true;
      }

      const pendingDraft = pendingDeliveryDraftRef.current;
      if (
        pendingDraft?.clientMessageId === clientMessageId &&
        pendingDraft.acceptedAt
      ) {
        return true;
      }

      const storedDraft = getStoredPendingDeliveryDraft();
      return Boolean(
        storedDraft?.clientMessageId === clientMessageId &&
        storedDraft.acceptedAt,
      );
    },
    [getStoredPendingDeliveryDraft],
  );

  const getUnacceptedPendingUserMessages = useCallback(
    () =>
      pendingMessagesRef.current.filter((message) => {
        if (message.role !== "user") return false;
        const deliveryKey = message.clientMessageId ?? message.id;
        return !isPendingMessageAccepted(deliveryKey);
      }),
    [isPendingMessageAccepted],
  );

  const failPendingMessageDelivery = useCallback(
    (message: string, options?: { preserveReady?: boolean }): boolean => {
      const failedMessages = getUnacceptedPendingUserMessages();
      if (failedMessages.length === 0) {
        return false;
      }

      const failedIds = new Set(failedMessages.map((msg) => msg.id));
      const failedDeliveryKeys = new Set(
        failedMessages.map((msg) => msg.clientMessageId ?? msg.id),
      );
      setMessages((prev) => prev.filter((msg) => !failedIds.has(msg.id)));
      for (const deliveryKey of failedDeliveryKeys) {
        acceptedPendingMessageIdsRef.current.delete(deliveryKey);
      }
      const remainingPendingMessages = pendingMessagesRef.current.filter(
        (msg) => !failedIds.has(msg.id),
      );
      setPendingMessages(remainingPendingMessages);
      setLoading(remainingPendingMessages.length > 0 || isStreamingRef.current);
      if (!options?.preserveReady) {
        setReady(false);
      }
      if (remainingPendingMessages.length === 0) {
        dispatchLocalThreadStatus(
          pendingThreadContextRef.current.threadId,
          "idle",
        );
      }
      restorePendingDeliveryDraft();
      showChatError(message);
      return true;
    },
    [
      getUnacceptedPendingUserMessages,
      restorePendingDeliveryDraft,
      showChatError,
      setMessages,
      setPendingMessages,
    ],
  );

  useEffect(() => {
    if (!threadId) return;
    pendingNewThreadSubmissionRef.current = null;
  }, [threadId]);

  useEffect(() => {
    if (!threadId || readOnly) {
      return;
    }

    if (skipNextEmptyDraftSaveRef.current) {
      const shouldSkip = isComposerVisiblyEmpty(input, attachments);
      skipNextEmptyDraftSaveRef.current = false;
      if (shouldSkip) {
        return;
      }
    }

    saveDraft(input, attachments);
  }, [attachments, input, readOnly, saveDraft, threadId]);

  useEffect(() => {
    if (threadId || readOnly) {
      return;
    }

    if (skipNextEmptyDraftSaveRef.current) {
      const shouldSkip = isComposerVisiblyEmpty(welcomeInput, attachments);
      skipNextEmptyDraftSaveRef.current = false;
      if (shouldSkip) {
        return;
      }
    }

    saveDraft(welcomeInput, attachments);
  }, [attachments, readOnly, saveDraft, threadId, welcomeInput]);

  const bumpIframeKey = useCallback((tabId: string) => {
    iframeRetryCountsRef.current[tabId] = 0;
    const retryTimeout = iframeRetryTimeoutsRef.current[tabId];
    if (retryTimeout) {
      clearTimeout(retryTimeout);
      delete iframeRetryTimeoutsRef.current[tabId];
    }
    setTabIframeKeys((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] ?? 0) + 1,
    }));
  }, []);

  const bumpFilePreviewKey = useCallback((tabId: string) => {
    setTabFilePreviewKeys((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] ?? 0) + 1,
    }));
  }, []);

  const refreshActiveIframe = useCallback(() => {
    if (!activeTabId) return;
    bumpIframeKey(activeTabId);
  }, [activeTabId, bumpIframeKey]);

  const refreshActiveFilePreview = useCallback(() => {
    if (!activeTabId) return;
    bumpFilePreviewKey(activeTabId);
  }, [activeTabId, bumpFilePreviewKey]);

  const setActiveNotebookViewMode = useCallback(
    (mode: "report" | "notebook") => {
      if (!activeTabId) return;
      setTabNotebookViewModes((prev) => ({
        ...prev,
        [activeTabId]: mode,
      }));
    },
    [activeTabId],
  );

  const setActiveFileViewMode = useCallback(
    (mode: "preview" | "source") => {
      if (!activeTabId) return;
      setTabFileViewModes((prev) => ({
        ...prev,
        [activeTabId]: mode,
      }));
    },
    [activeTabId],
  );

  const syncPreviewTabsStateBestEffort = useCallback(
    (nextTabs: PreviewTab[], nextActiveTabId: string | null) => {
      if (!threadId) return;
      const agent = chatAgentRef.current;
      if (!agent || agent.readyState !== SSE_READY_STATE_OPEN) return;

      void agent
        .call("setPreviewTabsState", [
          nextTabs.map((tab) => tab.target),
          nextActiveTabId,
        ])
        .catch(() => {});
    },
    [threadId],
  );

  useEffect(() => {
    if (!threadId || hasSyncedInitialPreviewRef.current) return;
    if (previewTabsRef.current.length > 0) {
      hasSyncedInitialPreviewRef.current = true;
      return;
    }
    if (initialPreviewSession.tabs.length === 0) return;

    setLocalPreviewSessionState(
      initialPreviewSession.tabs,
      initialPreviewSession.activeTabId,
    );
    hasSyncedInitialPreviewRef.current = true;
  }, [
    threadId,
    initialPreviewSession.tabs,
    initialPreviewSession.activeTabId,
    setLocalPreviewSessionState,
  ]);

  const cleanupClosedTabState = useCallback(
    (tabId: string) => {
      setTabIframeKeys((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabFilePreviewKeys((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabNotebookViewModes((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabFileViewModes((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabNotebookStates((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabNotebookPdfExporting((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabAppLoading((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });

      clearIframeTimersForTab(tabId);
    },
    [clearIframeTimersForTab],
  );

  const openTabForTarget = useCallback(
    (target: PreviewTarget, options?: { sync?: boolean }) => {
      const id = getPreviewTabId(target);
      const prevTabs = previewTabsRef.current;
      const existing = prevTabs.find((tab) => tab.id === id);
      const nextTabs = existing
        ? prevTabs.map((tab) => (tab.id === id ? { ...tab, target } : tab))
        : [...prevTabs, { id, target }];
      setLocalPreviewSessionState(nextTabs, id);
      if (options?.sync) {
        syncPreviewTabsStateBestEffort(nextTabs, id);
      }
    },
    [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort],
  );

  const selectTab = useCallback(
    (tabId: string) => {
      const nextActiveTab = previewTabsRef.current.find(
        (tab) => tab.id === tabId,
      );
      if (!nextActiveTab) return;
      setLocalPreviewSessionState(previewTabsRef.current, tabId);
      syncPreviewTabsStateBestEffort(previewTabsRef.current, tabId);
    },
    [setLocalPreviewSessionState, syncPreviewTabsStateBestEffort],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      const prevTabs = previewTabsRef.current;
      const closingTabIndex = prevTabs.findIndex((tab) => tab.id === tabId);
      if (closingTabIndex === -1) return;

      const nextTabs = prevTabs.filter((tab) => tab.id !== tabId);
      let nextActiveTabId = activeTabIdRef.current;

      if (tabId === activeTabIdRef.current) {
        if (!nextTabs.length) {
          nextActiveTabId = null;
          setMobileView("chat");
        } else {
          const nextIndex = Math.min(closingTabIndex, nextTabs.length - 1);
          const nextActiveTab = nextTabs[nextIndex];
          nextActiveTabId = nextActiveTab.id;
        }
      }

      setLocalPreviewSessionState(nextTabs, nextActiveTabId);
      syncPreviewTabsStateBestEffort(nextTabs, nextActiveTabId);
      cleanupClosedTabState(tabId);
    },
    [
      setLocalPreviewSessionState,
      syncPreviewTabsStateBestEffort,
      cleanupClosedTabState,
    ],
  );

  const handleTabNotebookStateChange = useCallback(
    (tabId: string, state: NotebookPreviewLoadState) => {
      setTabNotebookStates((prev) => {
        const current = prev[tabId];
        if (
          current?.status === state.status &&
          current?.notebook === state.notebook
        ) {
          return prev;
        }
        return {
          ...prev,
          [tabId]: state,
        };
      });
    },
    [],
  );

  const handleNotebookReportPdfDownload = useCallback(async () => {
    if (!activeTabId || previewTarget?.kind !== "file") return;
    if (tabNotebookPdfExporting[activeTabId]) return;

    const notebookState =
      tabNotebookStates[activeTabId] ?? DEFAULT_NOTEBOOK_PREVIEW_STATE;
    if (notebookState.status !== "ready" || !notebookState.notebook) {
      return;
    }

    const tabId = activeTabId;
    const fallbackName =
      previewTarget.path.split("/").filter(Boolean).pop() || "notebook.ipynb";
    const filename = previewTarget.filename || fallbackName;

    setTabNotebookPdfExporting((prev) => ({
      ...prev,
      [tabId]: true,
    }));

    try {
      const { exportNotebookReportAsPdf } =
        await import("@/components/chat-file-preview/notebook-preview/pdf-export");
      await exportNotebookReportAsPdf({
        notebook: notebookState.notebook,
        filename,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to export notebook report as PDF.";
      toast.error(message);
    } finally {
      setTabNotebookPdfExporting((prev) => {
        if (!(tabId in prev)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    }
  }, [activeTabId, previewTarget, tabNotebookPdfExporting, tabNotebookStates]);

  const applyAgentPreviewState = useCallback(
    (state: ChatAgentState) => {
      const newVersion =
        typeof state.previewVersion === "number" ? state.previewVersion : 0;
      previewVersionRef.current = newVersion;

      const nextSession = normalizePreviewSessionState(
        state.previewTabs,
        state.previewActiveTabId,
        null,
      );
      setLocalPreviewSessionState(nextSession.tabs, nextSession.activeTabId);

      if (!nextSession.target || !nextSession.activeTabId) return;
      if (nextSession.target.kind === "runtime_artifact") return;

      const nextActiveId = nextSession.activeTabId;
      if (state.previewRefreshTabId !== nextActiveId) return;
      if (nextSession.target.kind === "app") {
        const existingTimeout = iframeRefreshTimeoutsRef.current[nextActiveId];
        if (existingTimeout) clearTimeout(existingTimeout);
        setTabAppLoading((prev) => ({ ...prev, [nextActiveId]: true }));
        iframeRefreshTimeoutsRef.current[nextActiveId] = setTimeout(() => {
          delete iframeRefreshTimeoutsRef.current[nextActiveId];
          if (activeTabIdRef.current !== nextActiveId) {
            setTabAppLoading((prev) => {
              if (!(nextActiveId in prev)) return prev;
              const next = { ...prev };
              delete next[nextActiveId];
              return next;
            });
            return;
          }
          setTabAppLoading((prev) => ({ ...prev, [nextActiveId]: false }));
          bumpIframeKey(nextActiveId);
        }, 1500);
      } else if (nextSession.target.kind === "file") {
        const fileViewMode =
          tabFileViewModesRef.current[nextActiveId] ?? "preview";
        if (shouldAutoRefreshFilePreview(nextSession.target, fileViewMode)) {
          bumpFilePreviewKey(nextActiveId);
        }
      }
    },
    [bumpFilePreviewKey, bumpIframeKey, setLocalPreviewSessionState],
  );

  const sendPendingMessageToAgent = useCallback(
    (message: Message, activeThreadId: string) => {
      const agent = chatAgentRef.current;
      const content =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      const clientMessageId = message.clientMessageId ?? message.id;

      if (!agent || agent.readyState !== SSE_READY_STATE_OPEN) {
        return;
      }

      const sendTracker = trackChatSendDispatched({
        threadId: activeThreadId,
        getReadyState: () => chatAgentRef.current?.readyState ?? null,
      });
      void agent
        .call<SendMessageResult>(
          "sendMessage",
          [content, clientMessageId],
          { timeout: SEND_ACK_TIMEOUT_MS },
        )
        .then((result) => {
          if (result.status === "accepted") {
            sendTracker.accepted();
            void trackNewCamelActivationAfterAcceptedMessage();
          } else {
            sendTracker.rejected(result.status ?? "error");
          }
          if (activeThreadId !== pendingThreadContextRef.current.threadId) {
            return;
          }
          if (result.status === "accepted") {
            markPendingDeliveryDraftAccepted(clientMessageId);
            return;
          }

          failPendingMessageDelivery(
            result.error ||
              (result.status === "busy"
                ? "The agent is busy. I restored your message as a draft so you can try again."
                : "Failed to send message"),
            { preserveReady: agent.readyState === SSE_READY_STATE_OPEN },
          );
        })
        .catch((error) => {
          sendTracker.failed(error);
          if (activeThreadId !== pendingThreadContextRef.current.threadId) {
            return;
          }
          // A rejected AgentClient call is a transport failure, not a server
          // rejection (sendMessage reports those as a resolved status). The
          // server may already have accepted the message and lost only the RPC
          // response, so keep the same clientMessageId queued and retransmit it
          // after reconnect. ChatThreadDO durably deduplicates/re-acks that id.
          //
          // The transport can still report OPEN here (a parked stream does by
          // design). Force a fresh stream so the normal onOpen queue flush runs
          // instead of leaving the composer busy forever; a closed transport is
          // reconnecting automatically. This is no longer the half-open
          // detector — sends ride their own POSTs, so a dead receive path is
          // owned by the transport's silence watchdog
          // (STREAM_SILENCE_TIMEOUT_MS), not by an RPC failing.
          const transportOpen =
            chatAgentRef.current?.readyState === SSE_READY_STATE_OPEN;
          setReady(false);
          setLoading(true);
          if (transportOpen) {
            agent.reconnect();
          }
        });
    },
    [failPendingMessageDelivery, markPendingDeliveryDraftAccepted],
  );

  // Version-skew check (src/lib/version-skew.ts): a stale bundle that just
  // reconnected or woke up gets one silent reload when the tab holds no user
  // state, otherwise an "update available" toast. Safety reads through refs so
  // the callback stays stable.
  //
  // The visibility trigger lives at the app shell now
  // (src/hooks/use-version-skew-watch.ts, mounted by ChatGroupsProvider) so
  // non-chat routes self-heal too; this component contributes the chat-specific
  // reload-safety guard and the stream_open trigger.
  const versionSkewSafetyRef = useRef({
    input: "",
    welcomeInput: "",
    attachmentCount: 0,
    loading: false,
  });
  versionSkewSafetyRef.current = {
    input,
    welcomeInput,
    attachmentCount: attachments.length,
    loading,
  };
  const isChatReloadSafe = useCallback(() => {
    const safety = versionSkewSafetyRef.current;
    return (
      !safety.input.trim() &&
      !safety.welcomeInput.trim() &&
      safety.attachmentCount === 0 &&
      !safety.loading &&
      !isStreamingRef.current &&
      pendingMessagesRef.current.length === 0
    );
  }, []);
  useEffect(
    () => registerReloadSafetyGuard(isChatReloadSafe),
    [isChatReloadSafe],
  );
  const runVersionSkewCheck = useCallback(
    (trigger: VersionSkewTrigger) => {
      void checkForVersionSkew({
        trigger,
        // Global: an unrelated component's unsaved state must veto the reload
        // just as the composer's own draft does.
        safeToReload: isReloadSafeNow,
        onUpdateAvailable: (reload) => {
          toast("camelAI has been updated", {
            id: "camelai-version-skew",
            description: "Reload to get the latest version.",
            duration: 60_000,
            action: { label: "Reload", onClick: reload },
          });
        },
      });
    },
    [],
  );

  const handleAgentOpen = useCallback(() => {
    const id = threadId;
    if (!id) return;
    setReady(true);
    trackChatStreamOpen(id);
    runVersionSkewCheck("stream_open");

    // History sync on (re)connect is owned by the ai-chat hook now: `resume: true`
    // replays an in-flight turn's stream and the CHAT_MESSAGES broadcast folds in
    // any turn that finished while we were disconnected. The loader is cold-load
    // only — no reconnect revalidation.

    const queuedMessages = pendingMessagesRef.current.filter((message) => {
      if (message.role !== "user") return false;
      const deliveryKey = message.clientMessageId ?? message.id;
      return !isPendingMessageAccepted(deliveryKey);
    });
    if (queuedMessages.length === 0) return;
    trackChatReconnectFlush(id, queuedMessages.length);

    setLoading(true);
    const currentMessages = messagesRef.current;
    const existingIds = new Set(currentMessages.map((message) => message.id));
    const missing = queuedMessages.filter(
      (message) => !existingIds.has(message.id),
    );
    if (missing.length > 0) {
      setMessages([...currentMessages, ...missing]);
    }
    for (const message of queuedMessages) {
      sendPendingMessageToAgent(message, id);
    }
    setPendingMessages((prev) => prev);
  }, [
    isPendingMessageAccepted,
    runVersionSkewCheck,
    sendPendingMessageToAgent,
    setMessages,
    setPendingMessages,
    threadId,
  ]);

  // Apply a terminal error (delivered through Agent state, not the stream, so
  // it survives a reconnect after a disconnected/early failure).
  const handleTerminalError = useCallback(
    (payload: NonNullable<ChatAgentState["lastError"]>) => {
      const id = threadId;
      console.error("Chat terminal error:", payload.error);
      const billingSource =
        payload.billingSource === "byok" || payload.billingSource === "hosted"
          ? payload.billingSource
          : null;
      const eventProvider = parseByokProvider(payload.provider);
      const errorPayload =
        typeof payload.status === "number" ||
        typeof payload.status === "string" ||
        typeof payload.errorType === "string"
          ? {
              error: payload.error,
              status: payload.status,
              type: payload.errorType,
            }
          : payload.error;
      const errorContext: Partial<ChatApiErrorContext> = { billingSource };
      if (eventProvider) {
        errorContext.llmProvider = eventProvider;
      }
      const shouldRefreshBillingAfterError =
        billingSource === "hosted" || isChatBillingOrCreditError(errorPayload);
      showChatError(errorPayload, errorContext);
      // The stream ends on error; the hook's isStreaming clears itself. Just
      // release the composer and pending queue here.
      setLoading(false);
      acceptedPendingMessageIdsRef.current.clear();
      setPendingMessages([]);
      if (id) dispatchLocalThreadStatus(id, "idle");
      if (id && shouldRefreshBillingAfterError) {
        refreshBillingCreditStatusAfterTurn(
          `${id}:billing-error:${Date.now()}`,
        );
      }
      restorePendingDeliveryDraft();
      isAutoCompactingRef.current = false;
      compactingPriorMessageIdRef.current = null;
      setCompactingPriorMessageId(null);
      clearManualCompactionQueue();
      hasCapturedCompactionSummaryRef.current = false;
    },
    [
      threadId,
      showChatError,
      setPendingMessages,
      refreshBillingCreditStatusAfterTurn,
      restorePendingDeliveryDraft,
      clearManualCompactionQueue,
    ],
  );

  const handleAgentMessage = useCallback(
    (event: SseAgentMessageEvent) => {
      const id = threadId;
      if (!id) return;
      const data = JSON.parse(event.data);

      // Reject messages stamped for a different thread (a late broadcast that
      // arrives after switching threads must never apply to the new one).
      if (typeof data?.threadId === "string" && data.threadId !== id) return;

      // The transcript (streaming tokens, tool output, turn end) now rides
      // ai-chat's native stream, consumed by useAgentChat. This raw handler only
      // covers the remaining out-of-band broadcasts.
      if (
        data.type === "chat_group_avatar_updated" &&
        typeof data.groupId === "string" &&
        isChatGroupAvatar(data.avatar)
      ) {
        dispatchLocalChatGroupAvatarUpdate(id, data.groupId, data.avatar);
      }
    },
    [threadId],
  );

  const handleAgentClose = useCallback(
    (event?: SseAgentCloseEvent) => {
      // `bye {"reason":"idle"}` parks the stream by design; the transport stays
      // OPEN, sends are POSTs, and dispatching one wakes the stream. Clearing
      // `ready` here would queue the next message with nothing to flush it.
      if (event?.byeReason !== "idle") setReady(false);
      if (threadId) trackChatStreamClose(threadId, event);
    },
    [threadId],
  );

  const handleAgentError = useCallback((event?: unknown) => {
    if (threadId) trackChatStreamError(threadId, event);
  }, [threadId]);

  const handleAgentConnectionError = useCallback(
    (error: { code?: number; reason?: string; wasClean?: boolean }) => {
      const code = error.code ?? null;
      if (threadId) {
        trackChatStreamTerminalClose(threadId, {
          code: error.code,
          reason: error.reason,
          wasClean: error.wasClean,
        });
      }
      const message = terminalChatSseUserMessage(code, error.reason);
      // Terminal closes do not reconnect, so a queued delivery cannot make
      // progress. This is the one transport failure that should release the
      // pending bubble and restore its durable draft.
      if (!failPendingMessageDelivery(message)) {
        toast.error(message, {
          id: "chat-sse-terminal-close",
          duration: 12_000,
        });
      }
    },
    [failPendingMessageDelivery, threadId],
  );

  const handleAgentStateUpdate = useCallback(
    (state: ChatAgentState) => {
      // Streaming/loading and turn duration/completion badges are derived from the
      // ai-chat hook + render history now (isStreaming from the hook; completedTurns
      // from message-metadata.pi on the assistant messages). Agent state carries
      // only the coarse fields below (terminal error, preview, todos, etc.).
      // Terminal errors ride Agent state now; show each once (recovers a failure
      // missed while disconnected).
      const lastError = state.lastError;
      if (lastError?.id && lastError.id !== lastAppliedErrorIdRef.current) {
        lastAppliedErrorIdRef.current = lastError.id;
        // Suppress the banner when the error already renders as an inline
        // block from the loader payload (reload-after-error); see
        // loaderErrorIdsRef. Live/reconnect errors are new ids and still fire.
        if (!loaderErrorIdsRef.current.has(lastError.id)) {
          handleTerminalError(lastError);
        }
      }
      const fallbackNotice = state.modelFallbackNotice;
      const optimisticFallbackModel = resolveAgentFallbackOptimisticModel({
        threadId,
        model: state.model,
        notice:
          fallbackNotice &&
          isLlmModel(state.model) &&
          isModelVisibleForChatRuntime(state.model, billingAccessMode)
            ? fallbackNotice
            : null,
      });
      if (optimisticFallbackModel) {
        // Agent state is newer than the route's loader snapshot. Hold this as
        // the optimistic model so the prop-sync effect cannot restore the stale
        // premium model before a later loader catches up.
        optimisticThreadModelRef.current = optimisticFallbackModel;
        authoritativeThreadModelRef.current = {
          ...optimisticFallbackModel,
          updatedAt:
            typeof state.modelUpdatedAt === "number" &&
            Number.isFinite(state.modelUpdatedAt)
              ? state.modelUpdatedAt
              : (fallbackNotice?.createdAt ?? Date.now()),
        };
      }
      if ("modelFallbackNotice" in state) {
        setModelFallbackNotice((current) =>
          billingAccessMode === "selfhost"
            ? null
            : current?.id === fallbackNotice?.id
            ? current
            : (fallbackNotice ?? null),
        );
      }
      applyAgentPreviewState(state);
      if (Array.isArray(state.currentTodos)) {
        setCurrentTodos(state.currentTodos as TodoItem[]);
      }
      setPendingQuestion((previous) => {
        const next = state.pendingQuestion ?? null;
        const suppressedId = optimisticallyAnsweredQuestionIdRef.current;
        if (!next) {
          if (suppressedId) optimisticallyAnsweredQuestionIdRef.current = null;
          return previous === null ? previous : null;
        }
        if (suppressedId === next.questionId) return previous;
        if (suppressedId) optimisticallyAnsweredQuestionIdRef.current = null;
        return sameJson(previous, next) ? previous : next;
      });
      setConnectionSetupPrompt((previous) => {
        const next = state.connectionSetupPrompt ?? null;
        const suppressedId =
          optimisticallyClearedConnectionSetupRequestIdRef.current;
        if (!next) {
          if (suppressedId) {
            optimisticallyClearedConnectionSetupRequestIdRef.current = null;
          }
          return previous === null ? previous : null;
        }
        if (suppressedId === next.requestId) return previous;
        if (suppressedId) {
          optimisticallyClearedConnectionSetupRequestIdRef.current = null;
        }
        return sameJson(previous, next) ? previous : next;
      });
      if (typeof state.title === "string") {
        if (typeof document !== "undefined") {
          document.title = `${state.title || "Chat"} - camelAI`;
        }
        dispatchLocalThreadSummaryUpdate(threadId, {
          title: state.title,
          updatedAt:
            typeof state.titleUpdatedAt === "number" &&
            Number.isFinite(state.titleUpdatedAt)
              ? state.titleUpdatedAt
              : Date.now(),
        });
      }
      if (
        isLlmModel(state.model) &&
        isModelVisibleForChatRuntime(state.model, billingAccessMode)
      ) {
        const updatedAt =
          typeof state.modelUpdatedAt === "number" &&
          Number.isFinite(state.modelUpdatedAt)
            ? state.modelUpdatedAt
            : Date.now();
        if (
          !shouldIgnoreOlderThreadModelUpdate({
            threadId,
            nextModel: state.model,
            nextUpdatedAt: updatedAt,
            authoritative: authoritativeThreadModelRef.current,
          })
        ) {
          if (
            authoritativeThreadModelRef.current?.model !== state.model &&
            updatedAt >
              (authoritativeThreadModelRef.current?.updatedAt ?? -Infinity)
          ) {
            authoritativeThreadModelRef.current = null;
          }
          selectedThreadModelRef.current = state.model;
          setSelectedThreadModel(state.model);
          dispatchLocalThreadSummaryUpdate(threadId, {
            model: state.model,
            updatedAt,
          });
        }
      }
      const usedPercent = state.contextUsedPercent;
      setContextUsedPercent(
        typeof usedPercent === "number" && Number.isFinite(usedPercent)
          ? Math.max(0, Math.min(100, Math.round(usedPercent)))
          : null,
      );
    },
    [
      applyAgentPreviewState,
      billingAccessMode,
      setConnectionSetupPrompt,
      handleTerminalError,
      threadId,
    ],
  );

  // Route the transport's lifecycle callbacks (mounted at the top of the
  // component) to the handlers defined above.
  agentCallbacksRef.current = {
    onOpen: handleAgentOpen,
    onMessage: handleAgentMessage,
    onClose: handleAgentClose,
    onError: handleAgentError,
    onConnectionError: handleAgentConnectionError,
    onStateUpdate: handleAgentStateUpdate,
  };

  // Turn lifecycle: the ai-chat stream owns streaming state, so the "turn just
  // finished" side effects (previously the legacy `result` frame) fire when the
  // hook transitions out of a busy window. `submitted` covers the awaiting-first-
  // token gap; `isServerStreaming` (folded into isStreaming) spans tool rounds.
  const isTurnBusy =
    isStreaming ||
    piChat.status === "submitted" ||
    piChat.status === "streaming";
  const wasTurnBusyRef = useRef(false);
  useEffect(() => {
    const wasBusy = wasTurnBusyRef.current;
    wasTurnBusyRef.current = isTurnBusy;
    if (isTurnBusy) {
      setLoading(true);
      return;
    }
    if (!wasBusy) return;
    const id = pendingThreadContextRef.current.threadId;
    acceptedPendingMessageIdsRef.current.clear();
    setPendingMessages([]);
    if (id) dispatchLocalThreadStatus(id, "idle");
    completeActiveManualCompaction();
    clearPendingDeliveryDraft();
    if (id) {
      billingRefreshSequenceRef.current += 1;
      refreshBillingCreditStatusAfterTurn(
        `${id}:turn:${billingRefreshSequenceRef.current}`,
      );
    }
    if (getUnacceptedPendingUserMessages().length === 0) setLoading(false);
  }, [
    isTurnBusy,
    setPendingMessages,
    completeActiveManualCompaction,
    clearPendingDeliveryDraft,
    refreshBillingCreditStatusAfterTurn,
    getUnacceptedPendingUserMessages,
  ]);

  useEffect(() => {
    chatAgentRef.current = agentEnabled ? agentSocket : null;
    return () => {
      if (chatAgentRef.current === agentSocket) chatAgentRef.current = null;
    };
  }, [agentEnabled, agentSocket]);

  useLayoutEffect(() => {
    setReady(false);
    // Drop the previous context's optimistic bubbles; the hook remounts with the
    // new thread's history (Chat is keyed by threadId).
    setMessages([]);
    compactingPriorMessageIdRef.current = null;
    setCompactingPriorMessageId(null);
    setLoading(false);
    isAutoCompactingRef.current = false;
    syncCompactionIndicator();
  }, [
    threadId,
    resolvedWorkspaceId,
    readOnly,
    setMessages,
    syncCompactionIndicator,
  ]);

  useEffect(() => {
    return () => {
      for (const previewUrl of attachmentPreviewUrlsRef.current) {
        URL.revokeObjectURL(previewUrl);
      }
      attachmentPreviewUrlsRef.current.clear();
      acceptedPendingMessageIdsRef.current.clear();
      clearAllIframeRefreshTimeouts();
    };
  }, [clearAllIframeRefreshTimeouts]);

  // Check if we should show the chat UI
  const shouldShowChat = Boolean(threadId);
  const [hasHydratedChatTranscript, setHasHydratedChatTranscript] =
    useState(false);
  useEffect(() => {
    setHasHydratedChatTranscript(true);
  }, []);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const visibleMessageCount = visibleMessages.length;
  const lastVisibleMessageId = lastMessage?.id ?? null;
  // One pending-turn derivation owns both new and existing chats. The durable
  // workspace status bridges cold starts/reconnects; local loading and the live
  // stream bridge sends that have not reached durable status yet.
  const isAwaitingAssistant = deriveIsAwaitingAssistant({
    loading,
    isStreaming,
    isRunning: activeThreadRunningState.isRunning,
    lastMessage,
  });
  const turnSettled = deriveTurnSettled(lastMessage);
  const assistantTurnActive =
    !turnSettled &&
    (loading ||
      isStreaming ||
      isAwaitingAssistant ||
      activeAssistantMessageId !== null);
  const showGlobalAssistantIndicator = deriveShowGlobalAssistantIndicator({
    assistantTurnActive,
    isCompacting,
    isStreamStallClamped: piChat.isStallClamped,
  });
  const handleFreshlyCompletedTurnAnimationScheduled =
    clearFreshlyCompletedTurnId;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const container = scrollContainerRef.current;
    if (container) {
      if (behavior === "auto") {
        container.scrollTop = container.scrollHeight;
        return;
      }
      container.scrollTo({ top: container.scrollHeight, behavior });
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    if (error && !prevErrorRef.current) {
      const container = scrollContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      } else {
        messagesEndRef.current?.scrollIntoView({
          behavior: "auto",
          block: "end",
        });
      }
    }

    prevErrorRef.current = error;
  }, [error]);

  // Derives pin state + scroll-button visibility from the current geometry.
  // Called on scroll events AND on content/container resize — resizes (e.g. the
  // turn trace collapsing to fit the viewport) change distance-from-bottom
  // without firing any scroll event.
  const syncScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    stickToBottomRef.current = distanceFromBottom < 150;
    setShowScrollButton(distanceFromBottom > 100);
  }, []);

  useEffect(() => {
    if (!shouldShowChat || !threadId) return;

    const container = scrollContainerRef.current;
    const column = messageColumnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;

    let frameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        if (stickToBottomRef.current) {
          scrollToBottom("auto");
        }
        syncScrollPosition();
      });
    });

    observer.observe(column);
    if (container) observer.observe(container);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [scrollToBottom, shouldShowChat, syncScrollPosition, threadId]);

  // Auto-scroll on new messages (initial load, own sends, and while pinned)
  useLayoutEffect(() => {
    if (!shouldShowChat || !threadId) return;
    if (!hasHydratedChatTranscript) return;

    if (!initialScrollDoneRef.current && visibleMessageCount > 0) {
      initialScrollDoneRef.current = true;
      stickToBottomRef.current = true;
      scrollToBottom("auto");
      setShowScrollButton(false);
      return;
    }

    const shouldForce = forceScrollOnNextUpdate.current;
    forceScrollOnNextUpdate.current = false;

    if (shouldForce) {
      stickToBottomRef.current = true;
      scrollToBottom("auto");
      return;
    }

    if (stickToBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [
    visibleMessageCount,
    lastVisibleMessageId,
    scrollToBottom,
    shouldShowChat,
    threadId,
    hasHydratedChatTranscript,
  ]);

  const copyMessage = useCallback(
    async (messageId: string, content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        setCopiedMessageId(messageId);
        setTimeout(() => setCopiedMessageId(null), 2000);
      } catch (err) {
        console.error("Failed to copy message:", err);
      }
    },
    [],
  );

  const forkMessage = useCallback(
    async (messageId: string, renderedMessageId?: string) => {
      if (!threadId || !resolvedWorkspaceId || readOnly) return;
      setForkingMessageId(messageId);
      setError(null);
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/chat/${encodeURIComponent(threadId)}/fork`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messageId,
              renderedMessageId,
              groupId: chatGroupId,
            }),
          },
        );
        const data = (await response.json().catch(() => ({}))) as {
          thread?: { id?: string };
          groupId?: string | null;
          error?: string;
        };
        if (!response.ok || !data.thread?.id) {
          throw new Error(data.error || "Failed to fork chat");
        }
        toast.success("Forked chat");
        revalidator.revalidate();
        navigate(`/chat/${data.thread.id}`, { preventScrollReset: true });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fork chat";
        showChatError(message);
        toast.error(message);
      } finally {
        setForkingMessageId(null);
      }
    },
    [
      chatGroupId,
      navigate,
      readOnly,
      resolvedWorkspaceId,
      revalidator,
      showChatError,
      threadId,
    ],
  );

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!resolvedWorkspaceId) return;

      for (const file of files) {
        const id = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

        // Create a blob URL for browser-renderable image preview in the input field
        const previewUrl = isImageFile(file.name, file.type || undefined)
          ? URL.createObjectURL(file)
          : undefined;
        if (previewUrl) {
          attachmentPreviewUrlsRef.current.add(previewUrl);
        }

        // Add to state as uploading
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: file.name,
            path: "",
            size: file.size,
            contentType: file.type || undefined,
            originalName: file.name,
            status: "uploading",
            progress: 0,
            previewUrl,
          },
        ]);

        try {
          const data = await uploadWorkspaceFile(resolvedWorkspaceId, file, {
            onProgress: (progressPercent) => {
              setAttachments((prev) =>
                prev.map((a) =>
                  a.id === id ? { ...a, progress: progressPercent } : a,
                ),
              );
            },
          });
          if (!isUserUploadMountPath(data.path)) {
            throw new Error(
              `Upload completed without a readable uploads/ path`,
            );
          }

          // Update state to complete
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    path: data.path,
                    size: data.size,
                    contentType: data.contentType ?? a.contentType,
                    originalName: data.originalName ?? a.originalName,
                    status: "complete" as const,
                    progress: 100,
                  }
                : a,
            ),
          );
        } catch (err) {
          console.error("File upload failed:", err);
          const errorMessage =
            err instanceof Error ? err.message : "Upload failed";
          // Update state to error
          setAttachments((prev) =>
            prev.map((a) =>
              a.id === id
                ? {
                    ...a,
                    status: "error" as const,
                    error: errorMessage,
                    progress: undefined,
                  }
                : a,
            ),
          );
        }
      }
    },
    [resolvedWorkspaceId],
  );

  const handleGeneratedTranscriptAttachment = useCallback(
    async (
      transcript: CondensedTranscript,
      card: GroupNewChatTranscriptCard,
    ) => {
      if (!resolvedWorkspaceId) return;
      if (transcript.turns.length === 0) {
        throw new Error("This chat does not have a completed transcript yet.");
      }

      const markdown = condensedTranscriptToMarkdown(transcript);
      const filename = `${sanitizeGeneratedFilename(card.title)}-transcript.md`;
      const file = new File([markdown], filename, { type: "text/markdown" });
      const id = `transcript_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      const snippet = card.openingLine || transcript.turns[0]?.user || filename;

      setAttachments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          path: "",
          size: file.size,
          contentType: file.type || "text/markdown",
          originalName: file.name,
          status: "uploading",
          progress: 0,
          kind: "transcript",
          sourceThreadId: card.threadId,
          sourceTitle: card.title,
          snippet,
        },
      ]);

      try {
        const data = await uploadWorkspaceFile(resolvedWorkspaceId, file, {
          onProgress: (progressPercent) => {
            setAttachments((prev) =>
              prev.map((attachment) =>
                attachment.id === id
                  ? { ...attachment, progress: progressPercent }
                  : attachment,
              ),
            );
          },
        });
        if (!isUserUploadMountPath(data.path)) {
          throw new Error("Upload completed without a readable uploads/ path");
        }

        setAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === id
              ? {
                  ...attachment,
                  path: data.path,
                  size: data.size,
                  contentType: data.contentType ?? attachment.contentType,
                  originalName: data.originalName ?? attachment.originalName,
                  status: "complete" as const,
                  progress: 100,
                }
              : attachment,
          ),
        );
      } catch (err) {
        console.error("Transcript upload failed:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Upload failed";
        setAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === id
              ? {
                  ...attachment,
                  status: "error" as const,
                  error: errorMessage,
                  progress: undefined,
                }
              : attachment,
          ),
        );
      }
    },
    [resolvedWorkspaceId],
  );

  const handleRecentAttachmentSelect = useCallback(
    (card: GroupNewChatAttachmentCard) => {
      setAttachments((prev) => {
        if (prev.some((attachment) => attachment.path === card.path)) {
          return prev;
        }
        return [
          ...prev,
          {
            id: `recent_attachment_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            name: card.originalName || card.filename,
            path: card.path,
            size: card.size,
            contentType: card.contentType,
            originalName: card.originalName,
            status: "complete",
          },
        ];
      });
    },
    [],
  );

  const handleAttachmentRemove = useCallback(
    (id: string) => {
      setAttachments((prev) => {
        const removed = prev.find((a) => a.id === id);
        revokeAttachmentPreviewUrl(removed?.previewUrl);
        return prev.filter((a) => a.id !== id);
      });
    },
    [revokeAttachmentPreviewUrl],
  );

  // Drag-drop handlers for the whole chat area
  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      if (resolvedWorkspaceId) {
        setIsDragOver(true);
      }
    },
    [resolvedWorkspaceId],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    // Only set drag over to false if we're leaving the container entirely
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (!resolvedWorkspaceId) return;

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        handleFilesSelected(Array.from(files));
      }
    },
    [resolvedWorkspaceId, handleFilesSelected],
  );

  useEffect(() => {
    if (
      updateThreadModelFetcher.state !== "idle" ||
      !updateThreadModelFetcher.data
    )
      return;
    if (updateThreadModelFetcher.data.error) {
      optimisticThreadModelRef.current = null;
      setSelectedThreadModel(
        resolveSelectedThreadModel({
          threadId,
          threadModel,
          allowedThreadModels,
          llmProvider,
          availableThreadModels,
          effectivePickerDefaultModel,
          hasEffectivePickerDefault,
        }),
      );
      toast.error(updateThreadModelFetcher.data.error);
      return;
    }
    if (updateThreadModelFetcher.data.thread?.model) {
      const nextModel = updateThreadModelFetcher.data.thread.model;
      if (!isModelVisibleForChatRuntime(nextModel, billingAccessMode)) {
        return;
      }
      const updatedAt = updateThreadModelFetcher.data.thread.updated_at;
      if (
        shouldIgnoreStaleThreadModelResult({
          threadId,
          nextModel,
          optimistic: optimisticThreadModelRef.current,
        }) ||
        shouldIgnoreOlderThreadModelUpdate({
          threadId,
          nextModel,
          nextUpdatedAt: updatedAt,
          authoritative: authoritativeThreadModelRef.current,
        })
      ) {
        return;
      }
      if (
        authoritativeThreadModelRef.current?.model !== nextModel &&
        updatedAt >
          (authoritativeThreadModelRef.current?.updatedAt ?? -Infinity)
      ) {
        authoritativeThreadModelRef.current = null;
      }
      const nextSelectionKey = nextModel;
      optimisticThreadModelRef.current = null;
      setSelectedThreadModel(nextModel);
      dispatchLocalThreadSummaryUpdate(threadId, {
        model: nextModel,
        updatedAt,
      });
      const agent = chatAgentRef.current;
      if (
        lastRunnerModelSelectionRef.current !== nextSelectionKey &&
        agent?.readyState === SSE_READY_STATE_OPEN &&
        ready
      ) {
        lastRunnerModelSelectionRef.current = nextSelectionKey;
        void agent.call("refreshModel").catch(() => {});
      }
    }
  }, [
    llmProvider,
    billingAccessMode,
    threadId,
    ready,
    threadModel,
    updateThreadModelFetcher.state,
    updateThreadModelFetcher.data,
    allowedThreadModels,
  ]);

  const handleThreadModelChange = useCallback(
    (nextModel: LlmModel) => {
      if (!availableThreadModelIds.has(nextModel)) {
        return;
      }
      if (!threadId) {
        setSelectedThreadModel(nextModel);
        return;
      }
      if (
        nextModel === selectedThreadModel ||
        updateThreadModelFetcher.state !== "idle"
      ) {
        return;
      }
      authoritativeThreadModelRef.current = null;
      setSelectedThreadModel(nextModel);
      optimisticThreadModelRef.current = { threadId, model: nextModel };
      updateThreadModelFetcher.submit(
        { intent: "updateThreadModel", model: nextModel },
        { method: "post" },
      );
    },
    [
      availableThreadModelIds,
      selectedThreadModel,
      threadId,
      updateThreadModelFetcher,
    ],
  );

  // The post-turn resource refresh reads the canonical OrgDO thread. Apply a
  // newer persisted model directly when Agent state was missed, but only while
  // the picker still shows the model for which that refresh was requested.
  useEffect(() => {
    if (!threadId || readOnly) return;
    const canonicalModel = resolveRefreshedThreadModel(
      selectedThreadModel,
      refreshedThreadModel,
    );
    if (
      !canonicalModel ||
      !isModelVisibleForChatRuntime(canonicalModel, billingAccessMode)
    ) {
      return;
    }
    optimisticThreadModelRef.current = {
      threadId,
      model: canonicalModel,
    };
    authoritativeThreadModelRef.current = {
      threadId,
      model: canonicalModel,
      updatedAt: refreshedThreadModel?.updatedAt ?? Date.now(),
    };
    selectedThreadModelRef.current = canonicalModel;
    setSelectedThreadModel(canonicalModel);
    dispatchLocalThreadSummaryUpdate(threadId, {
      model: canonicalModel,
      updatedAt: refreshedThreadModel?.updatedAt ?? Date.now(),
    });
  }, [
    billingAccessMode,
    readOnly,
    refreshedThreadModel,
    selectedThreadModel,
    threadId,
  ]);

  // The Durable Object persists hosted-credit fallback and normally broadcasts
  // the new model through Agent state. Reconcile from the independent
  // post-turn billing refresh as well so a missed state frame cannot leave the
  // picker showing (or re-persisting) an exhausted premium model. Custom
  // pickers fall back to their cheapest credential-covered model.
  useEffect(() => {
    if (
      !threadId ||
      readOnly ||
      resolveRefreshedThreadModel(
        selectedThreadModel,
        refreshedThreadModel,
      ) !== null ||
      updateThreadModelFetcher.state !== "idle" ||
      !cheapestSelectableModel ||
      !shouldSwitchExhaustedThreadModel(
        currentBillingCreditStatus,
        selectedThreadModel,
        llmProvider,
        allowOpenAiSubscription,
      )
    ) {
      return;
    }
    handleThreadModelChange(cheapestSelectableModel.id);
  }, [
    allowOpenAiSubscription,
    cheapestSelectableModel,
    currentBillingCreditStatus,
    handleThreadModelChange,
    llmProvider,
    readOnly,
    refreshedThreadModel,
    selectedThreadModel,
    threadId,
    updateThreadModelFetcher.state,
  ]);

  useEffect(() => {
    if (threadId || readOnly || !modelRecentScope || noModelsMessage) {
      return;
    }

    const scopeKey = `${modelRecentScope.orgId}:${modelRecentScope.workspaceId}`;
    if (appliedRecentModelScopeRef.current === scopeKey) {
      return;
    }
    appliedRecentModelScopeRef.current = scopeKey;

    const recentModel = getRecentModel(modelRecentScope, {
      orgProvider: llmProvider,
    });
    const nextModel = resolveDefaultModelForChat({
      effectiveDefaultModel: null,
      recentModel,
      fallbackModel: getDefaultLlmModel(llmProvider),
      visibleCatalog: selectableThreadModels,
    });
    if (nextModel && nextModel !== selectedThreadModel) {
      handleThreadModelChange(nextModel);
    }
  }, [
    selectableThreadModels,
    handleThreadModelChange,
    llmProvider,
    modelRecentScope,
    noModelsMessage,
    readOnly,
    selectedThreadModel,
    threadId,
  ]);

  useEffect(() => {
    if (
      !threadId ||
      readOnly ||
      noModelsMessage ||
      loading ||
      isStreaming ||
      updateThreadModelFetcher.state !== "idle" ||
      (threadModel !== null && selectedThreadModel === threadModel) ||
      availableThreadModelIds.has(selectedThreadModel)
    ) {
      return;
    }

    const nextModel = resolveDefaultModelForChat({
      effectiveDefaultModel: hasEffectivePickerDefault
        ? effectivePickerDefaultModel
        : null,
      fallbackModel: getDefaultLlmModel(llmProvider),
      visibleCatalog: selectableThreadModels,
    });
    if (nextModel && nextModel !== selectedThreadModel) {
      handleThreadModelChange(nextModel);
    }
  }, [
    availableThreadModelIds,
    selectableThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    handleThreadModelChange,
    isStreaming,
    llmProvider,
    loading,
    noModelsMessage,
    readOnly,
    selectedThreadModel,
    threadModel,
    threadId,
    updateThreadModelFetcher.state,
  ]);

  const handleStartChatForApp = useCallback(
    (app: WorkerScriptWithCreator) => {
      if (!resolvedWorkspaceId) {
        toast.error("No workspace selected");
        return;
      }
      if (noModelsMessage) {
        toast.error(noModelsMessage);
        return;
      }

      if (app.workspace_id !== resolvedWorkspaceId) {
        toast.error(
          "App is in a different workspace. Please switch workspaces first.",
        );
        return;
      }
      if (!resolvedOrgSlug) {
        toast.error("Organization slug is unavailable");
        return;
      }

      if (isSubmittingNewThread) return;

      const appUrl = getAppUrl(app.script_name, hostname, resolvedOrgSlug);
      const systemMessage = buildAppWorkSystemMessage({
        scriptName: app.script_name,
        appUrl,
        projectId: app.project_id,
      });
      const threadTitle = buildAppThreadFallbackTitle(app.script_name);

      submit(
        {
          intent: "createThreadAndStart",
          clientBuildId: APP_BUILD_ID,
          initialTitle: threadTitle,
          previewApps: app.script_name,
          firstMessage: systemMessage,
          model: selectedThreadModel,
          ...(chatGroupId ? { groupId: chatGroupId } : {}),
        },
        { method: "post", action: "/chat" },
      );
    },
    [
      hostname,
      resolvedOrgSlug,
      resolvedWorkspaceId,
      submit,
      isSubmittingNewThread,
      noModelsMessage,
      selectedThreadModel,
      chatGroupId,
    ],
  );

  function startNewChat() {
    const currentWelcomeInput = welcomeInputRef.current;
    const currentAttachments = attachmentsRef.current;
    const hasCompletedAttachments =
      getCompletedAttachments(currentAttachments).length > 0;

    if (
      (!currentWelcomeInput.trim() && !hasCompletedAttachments) ||
      isSubmittingNewThread ||
      !resolvedWorkspaceId ||
      noModelsMessage
    )
      return;

    // Don't allow sending while uploads are in progress
    const hasUploadingAttachments = currentAttachments.some(
      (a) => a.status === "uploading",
    );
    if (hasUploadingAttachments) return;

    const userMessage = currentWelcomeInput.trim();
    let finalContent: string;
    try {
      finalContent = buildMessageContent(userMessage, currentAttachments);
    } catch (error) {
      showChatError(error);
      return;
    }

    pendingNewThreadSubmissionRef.current = {
      text: currentWelcomeInput,
      attachments: currentAttachments,
    };
    handledNewChatActionErrorRef.current = null;
    clearDraft();
    welcomeInputRef.current = "";
    attachmentsRef.current = [];
    setWelcomeInput("");
    skipNextEmptyDraftSaveRef.current = true;

    // Keep blob URLs alive until redirect/unmount so an action error can restore
    // image previews without rebuilding local object URLs.
    setAttachments([]);

    // Submit as a navigational route action. The action creates the thread,
    // starts the first turn in the ChatThreadDO, then redirects to the thread.
    const createThreadPayload: Record<string, string> = {
      intent: "createThreadAndStart",
      clientBuildId: APP_BUILD_ID,
      model: selectedThreadModel,
    };
    if (chatGroupId) {
      createThreadPayload.groupId = chatGroupId;
    }
    if (finalContent) {
      createThreadPayload.firstMessage = finalContent;
    }

    submit(createThreadPayload, {
      method: "post",
      action: "/chat",
    });
  }

  function stopGeneration() {
    if (chatAgentRef.current?.readyState !== SSE_READY_STATE_OPEN) return;
    void chatAgentRef.current.call("requestStop").catch(() => {});
  }

  const handleQuestionResponse = useCallback(
    (answers: Record<string, string>) => {
      const agent = chatAgentRef.current;
      if (
        !pendingQuestion ||
        !agent ||
        agent.readyState !== SSE_READY_STATE_OPEN
      ) {
        return;
      }

      optimisticallyAnsweredQuestionIdRef.current = pendingQuestion.questionId;
      void agent.call("answerQuestion", [pendingQuestion.questionId, answers]);

      // Optimistically clear the question
      setPendingQuestion(null);

      window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
    },
    [pendingQuestion],
  );

  const resetPreviewTabsState = useCallback(() => {
    setLocalPreviewSessionState([], null);
    setTabIframeKeys({});
    setTabFilePreviewKeys({});
    setTabNotebookViewModes({});
    setTabFileViewModes({});
    setTabAppLoading({});
    clearAllIframeRefreshTimeouts();
  }, [setLocalPreviewSessionState, clearAllIframeRefreshTimeouts]);

  const setPreviewTargetForThread = useCallback(
    (target: PreviewTarget | null) => {
      if (!threadId) return;

      if (readOnly) {
        if (target === null) {
          resetPreviewTabsState();
          setMobileView("chat");
          return;
        }
        openTabForTarget(target, { sync: false });
        return;
      }

      const agent = chatAgentRef.current;
      if (!agent || agent.readyState !== SSE_READY_STATE_OPEN) {
        if (target === null) {
          resetPreviewTabsState();
          setMobileView("chat");
          return;
        }
        toast.error("Preview is unavailable while reconnecting.");
        return;
      }

      if (target === null) {
        resetPreviewTabsState();
        syncPreviewTabsStateBestEffort([], null);
        setMobileView("chat");
        return;
      }

      openTabForTarget(target, { sync: true });
    },
    [
      threadId,
      readOnly,
      resetPreviewTabsState,
      openTabForTarget,
      syncPreviewTabsStateBestEffort,
    ],
  );

  const openPreviewTarget = useCallback(
    (target: PreviewTarget) => {
      setPreviewTargetForThread(target);
      setMobileView("preview");
    },
    [setPreviewTargetForThread],
  );

  const clearPreviewTarget = useCallback(() => {
    setPreviewTargetForThread(null);
  }, [setPreviewTargetForThread]);

  const resolveAppVisibility = useCallback(
    async (scriptName: string): Promise<boolean | null> => {
      if (!resolvedWorkspaceId) return null;
      try {
        const response = await fetch(
          `/api/workspaces/${encodeURIComponent(resolvedWorkspaceId)}/apps/${encodeURIComponent(scriptName)}/visibility`,
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as { is_public?: unknown };
        return typeof payload.is_public === "boolean"
          ? payload.is_public
          : null;
      } catch {
        return null;
      }
    },
    [resolvedWorkspaceId],
  );

  type SendOptions = {
    contentOverride?: string;
    preserveDraft?: boolean;
    skipAttachmentRefs?: boolean;
  };

  function sendMessage(opts?: SendOptions): boolean {
    if (readOnly) {
      return false;
    }
    const currentInput = inputRef.current;
    const currentAttachments = attachmentsRef.current;
    const hasUploadingAttachments = currentAttachments.some(
      (a) => a.status === "uploading",
    );
    const hasCompletedAttachments =
      getCompletedAttachments(currentAttachments).length > 0;
    const rawContent = (opts?.contentOverride ?? currentInput).trim();
    if (
      isLoadingMessages ||
      hasUploadingAttachments ||
      (!rawContent && !hasCompletedAttachments) ||
      !shouldShowChat ||
      !resolvedWorkspaceId ||
      !threadId ||
      noModelsMessage
    ) {
      return false;
    }

    const wasSentDuringStreaming = assistantTurnActive;
    const clientMessageId = `client_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    const shouldIncludeAttachmentRefs =
      !opts?.skipAttachmentRefs && !opts?.contentOverride;
    let finalContent: string;
    try {
      finalContent = shouldIncludeAttachmentRefs
        ? buildMessageContent(rawContent, currentAttachments)
        : rawContent;
    } catch (error) {
      showChatError(error);
      return false;
    }

    if (!opts?.preserveDraft && !opts?.contentOverride) {
      preserveDraftForDelivery(
        clientMessageId,
        threadId,
        currentInput,
        currentAttachments,
      );
    }

    const shouldShowCompactingIndicator = isManualCompactCommand(finalContent);

    if (shouldShowCompactingIndicator) {
      queueManualCompaction();
    }

    // Clear any previous error
    setError(null);

    // Add user message to state immediately (optimistic)
    const authorDisplayName = resolveMessageAuthorDisplayName(
      user?.name,
      user?.email,
    );
    const userMsg: Message = {
      id: clientMessageId,
      clientMessageId,
      thread_id: threadId,
      role: "user",
      content: finalContent,
      created_at: Date.now(),
      sentDuringStreaming: wasSentDuringStreaming,
      ...(authorDisplayName ? { authorDisplayName } : {}),
      messageSource: "web",
    };

    // Sending your own message always brings the bottom into view. /compact is
    // operational and can happen while users read older messages — don't jump.
    forceScrollOnNextUpdate.current = !shouldShowCompactingIndicator;

    if (wasSentDuringStreaming) {
      // Steering: the assistant keeps streaming in the live overlay. Echo the
      // user's message into committed history optimistically; it reconciles with
      // the server copy by clientMessageId, and Pi's real ordering arrives via
      // the overlay / next reload.
      setMessages((prev) =>
        prev.some(
          (message) =>
            message.id === userMsg.id ||
            (userMsg.clientMessageId &&
              message.clientMessageId === userMsg.clientMessageId),
        )
          ? prev
          : [...prev, userMsg],
      );
    } else {
      setMessages((prev) => [...prev, userMsg]);
    }
    setPendingMessages((prev) => {
      if (
        prev.some(
          (message) =>
            message.id === clientMessageId ||
            message.clientMessageId === clientMessageId,
        )
      ) {
        return prev;
      }
      return [...prev, userMsg];
    });

    // If the transport is connected and ready, send immediately
    const previewUserMessage = normalizeThreadPreviewUserMessage(rawContent);
    const userMessageAt = Date.now();
    const isFirstUserTurn = !displayMessagesRef.current.some(
      (message) =>
        message.role === "user" && !message.isMeta && !message.isCompactSummary,
    );
    dispatchLocalThreadStatus(threadId, "running", {
      latestUserMessage: previewUserMessage,
      latestUserMessageAt: userMessageAt,
      ...(isFirstUserTurn ? { firstUserMessage: previewUserMessage } : {}),
      runningActivityText: previewUserMessage,
      runningActivityAt: userMessageAt,
      runningStartedAt: userMessageAt,
    });
    if (chatAgentRef.current?.readyState === SSE_READY_STATE_OPEN && ready) {
      setLoading(true);
      sendPendingMessageToAgent(userMsg, threadId);
      setPendingMessages((prev) => prev);
    } else {
      // Queue the full message object for later delivery (with file refs in content).
      // The SSE client reconnects automatically; the ready handler flushes the queue.
      trackChatSendQueuedOffline(threadId, {
        readyState: chatAgentRef.current?.readyState ?? null,
        ready,
      });
      setLoading(true);
    }
    return true;
  }

  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;
  const handleCompactFromIndicator = useCallback(() => {
    if (loading || isStreaming || isCompacting || readOnly) return;
    sendMessageRef.current({
      contentOverride: "/compact",
      preserveDraft: true,
      skipAttachmentRefs: true,
    });
  }, [loading, isStreaming, isCompacting, readOnly]);

  const {
    tabRenderStates,
    previewDomains,
    appPreviewVanityUrl,
    filePreviewOpenUrl,
    openElsewhereKind,
  } = useChatPreviewRenderState({
    previewTabs,
    previewTarget,
    tabIframeKeys,
    tabAppLoading,
    tabFilePreviewKeys,
    tabNotebookViewModes,
    tabFileViewModes,
    hostname,
    orgSlug: resolvedOrgSlug,
  });

  const handlePreviewRefresh = useCallback(() => {
    if (!previewTarget || previewTarget.kind === "runtime_artifact") return;
    if (previewTarget.kind === "app") {
      refreshActiveIframe();
      return;
    }
    refreshActiveFilePreview();
  }, [previewTarget, refreshActiveIframe, refreshActiveFilePreview]);

  const handlePreviewOpenElsewhere = useCallback(() => {
    if (!previewTarget || previewTarget.kind === "runtime_artifact") return;
    if (previewTarget.kind === "app") {
      if (!appPreviewVanityUrl) return;
      window.open(appPreviewVanityUrl, "_blank", "noopener,noreferrer");
      return;
    }
  }, [previewTarget, appPreviewVanityUrl]);

  const showMobilePreview = previewTabs.length > 0 && mobileView === "preview";
  const currentMembership = orgs.find(
    (entry) => entry.org_id === currentOrg?.id,
  );
  const isAdmin =
    currentMembership?.role === "owner" || currentMembership?.role === "admin";
  const previewShareButton = useMemo(() => {
    if (readOnly) return undefined;
    if (previewTarget?.kind !== "app") return undefined;
    return (
      <ShareStatusButton
        threadId={threadId}
        scriptName={previewTarget.scriptName}
        isPublic={appIsPublic}
        isAdmin={Boolean(isAdmin)}
        onStatusChange={setAppIsPublic}
      />
    );
  }, [readOnly, previewTarget, threadId, appIsPublic, isAdmin, setAppIsPublic]);
  const previewPanelBody = (
    <PreviewPanelShell
      previewTabs={previewTabs}
      activeTabId={activeTabId}
      previewTarget={previewTarget}
      onTabSelect={selectTab}
      onTabClose={closeTab}
      onRefresh={handlePreviewRefresh}
      openElsewhereKind={openElsewhereKind}
      onOpenElsewhere={handlePreviewOpenElsewhere}
      appShareButton={previewShareButton}
      notebookViewMode={notebookViewMode}
      onNotebookViewModeChange={setActiveNotebookViewMode}
      fileViewMode={fileViewMode}
      onFileViewModeChange={setActiveFileViewMode}
      filePreviewOpenUrl={filePreviewOpenUrl}
      activeNotebookState={activeNotebookState}
      isNotebookPdfExporting={isNotebookPdfExporting}
      onNotebookStateChange={handleTabNotebookStateChange}
      onNotebookReportPdfDownload={handleNotebookReportPdfDownload}
      iframeRef={iframeRef}
      tabRenderStates={tabRenderStates}
      vanityUrl={appPreviewVanityUrl}
      vanityHost={previewDomains.vanityHost}
    />
  );

  const chatPanelContent = (
    <>
      {readOnly && (
        <div className="mx-auto w-full max-w-3xl px-4 md:px-6 pt-3">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Read-only admin view. Messaging is disabled for this thread.
          </div>
        </div>
      )}
      {/* Chat Body - Single Scroll Container */}
      <div
        ref={scrollContainerRef}
        onScroll={syncScrollPosition}
        tabIndex={0}
        role="region"
        aria-label="Chat messages"
        style={CHAT_SCROLL_CONTAINER_STYLE}
        className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden"
      >
        {/* Centered message column */}
        <div
          ref={messageColumnRef}
          className="max-w-3xl mx-auto w-full px-4 md:px-6 pt-2 pb-6 flex flex-col"
        >
          {!readOnly && (olderMessagesCursor || olderMessagesError) ? (
            <div className="flex flex-col items-center gap-1 pb-2">
              {olderMessagesCursor ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isLoadingOlderMessages}
                  onClick={() => void loadOlderMessages()}
                >
                  {isLoadingOlderMessages
                    ? "Loading earlier messages…"
                    : "Load earlier messages"}
                </Button>
              ) : null}
              {olderMessagesError ? (
                <p className="text-xs text-destructive" role="status">
                  {olderMessagesError}
                </p>
              ) : null}
            </div>
          ) : null}
          <ChatTranscriptErrorBoundary>
            <ChatMessagesView
              visibleMessages={visibleMessages}
              copyMessage={copyMessage}
              copiedMessageId={copiedMessageId}
              forkMessage={readOnly ? undefined : forkMessage}
              forkingMessageId={forkingMessageId}
              runningStartedAt={runningStartedAt}
              activeTurnActionMessageId={activeAssistantMessageId}
              isAssistantTurnActive={assistantTurnActive}
              completedTurns={completedTurns}
              freshlyCompletedTurnId={freshlyCompletedTurnId}
              onFreshlyCompletedTurnAnimationScheduled={
                handleFreshlyCompletedTurnAnimationScheduled
              }
              skillSheetsByToolId={skillSheetsByToolId}
              error={error}
              setError={setError}
              llmProvider={llmProvider}
              threadModel={selectedThreadModel}
              isCompacting={isCompacting}
              compactingPriorMessageId={compactingPriorMessageId}
              isLoadingMessages={isLoadingMessages}
              deferRendering={!hasHydratedChatTranscript}
              showGlobalAssistantIndicator={showGlobalAssistantIndicator}
              messagesEndRef={messagesEndRef}
              mentionSlugMap={mentionSlugMap}
            />
          </ChatTranscriptErrorBoundary>
        </div>
      </div>

      {!readOnly && (
        <div className="sticky bottom-0 z-20 shrink-0">
          {/* Scroll to bottom button */}
          <div className="relative">
            <Button
              variant="outline"
              size="icon"
              className={cn(
                "absolute -top-12 left-1/2 -translate-x-1/2 rounded-full shadow-md transition-all duration-200",
                "bg-background/80 backdrop-blur-sm border-border/50",
                showScrollButton
                  ? "opacity-100 translate-y-0"
                  : "opacity-0 translate-y-2 pointer-events-none",
              )}
              onClick={() => scrollToBottom("smooth")}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
          {/* Gradient fade above composer */}
          <div
            className="absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent pointer-events-none"
            aria-hidden="true"
          />
          {/* Composer container */}
          <div className="bg-background">
            <div className="pt-2 px-4 [--safe-area-padding-bottom:1rem] pb-safe">
              <div className="max-w-3xl mx-auto w-full flex flex-col max-h-[calc(100dvh-2rem)]">
                {(pendingQuestion || currentTodos.length > 0) && (
                  <div className="min-h-0 shrink overflow-y-auto">
                    {pendingQuestion && (
                      <AskUserQuestion
                        data={pendingQuestion}
                        onSubmit={handleQuestionResponse}
                        className="mb-3"
                      />
                    )}
                    {currentTodos.length > 0 && (
                      <FloatingTodoList
                        todos={currentTodos}
                        className="mb-3"
                      />
                    )}
                  </div>
                )}
                {shouldAddCamelCodeToPicker ? (
                  <CamelCodePickerAlert
                    isOrgAdmin={isOrgAdmin}
                    settingsHref={modelPickerSettingsHref}
                    className="mb-2 shrink-0"
                  />
                ) : noModelsMessage ? (
                  <p className="mb-3 text-sm text-muted-foreground">
                    {noModelsMessage}
                  </p>
                ) : null}
                <ModelFallbackBanner
                  notice={modelFallbackNotice}
                  activeModel={selectedThreadModel}
                  isOrgAdmin={isOrgAdmin}
                  onTopUp={openBillingTopUp}
                  onUpgrade={openPlanUpgrade}
                  onAddKey={openByokDialog}
                  onOpenAiSignIn={openOpenAiSignIn}
                  className="mb-2 shrink-0"
                />
                {displayedBillingCreditStatus &&
                !shouldAddCamelCodeToPicker ? (
                  <BillingCreditNotice
                    status={displayedBillingCreditStatus}
                    onOpenUsage={() => navigate("/settings/organization/usage")}
                    onTopUp={openBillingTopUp}
                    canTopUp={Boolean(isAdmin)}
                    pauseReason={effectiveHostedCreditsPaused?.reason ?? null}
                    userId={user?.id ?? null}
                    orgId={currentOrg?.id ?? null}
                    className="mb-2 shrink-0"
                  />
                ) : null}
                <PromptInput
                  className="shrink-0"
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  onStop={stopGeneration}
                  placeholder="Type a message..."
                  isLoading={isLoadingMessages}
                  isAssistantRunning={
                    loading || isStreaming || isAwaitingAssistant
                  }
                  autoFocus
                  attachments={attachments}
                  onFilesSelected={handleFilesSelected}
                  onAttachmentRemove={handleAttachmentRemove}
                  workspaceId={resolvedWorkspaceId}
                  disabled={Boolean(noModelsMessage)}
                  contextUsedPercent={contextUsedPercent}
                  onCompact={handleCompactFromIndicator}
                  model={selectedThreadModel}
                  onModelChange={handleThreadModelChange}
                  modelOptions={availableThreadModels}
                  modelDisabled={
                    loading ||
                    isStreaming ||
                    updateThreadModelFetcher.state !== "idle"
                  }
                  isOrgAdmin={isOrgAdmin}
                  onLockedModelSelect={openUnlockPremium}
                  onUnlockRequest={() => openUnlockPremium(null)}
                  showMoreModelsCta={canUnlockPremiumModels}
                  pausedSection={effectiveHostedCreditsPaused}
                  recentModelScope={modelRecentScope}
                  textareaRef={composerTextareaRef}
                  mentionables={mentionEntities}
                  onMentionAddNewClick={() => navigate("/connections")}
                  onMentionMenuOpenChange={handleMentionMenuOpenChange}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return (
    <TooltipProvider>
      <ChatPreviewProvider
        value={{
          openPreviewTarget,
          clearPreviewTarget,
          resolveAppVisibility,
          workspaceId: resolvedWorkspaceId,
          formatFilePathForCopy,
        }}
      >
        <>
          {shouldShowChat ? (
            <div
              className="flex-1 min-h-0 relative flex flex-col"
              onDragOver={readOnly ? undefined : handleDragOver}
              onDragLeave={readOnly ? undefined : handleDragLeave}
              onDrop={readOnly ? undefined : handleDrop}
            >
              {/* Drag overlay */}
              {!readOnly && isDragOver && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg m-2">
                  <div className="bg-background/90 backdrop-blur-sm px-6 py-4 rounded-xl shadow-lg">
                    <span className="text-lg font-medium text-primary">
                      Drop files here to upload
                    </span>
                  </div>
                </div>
              )}
              {isMobile ? (
                <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
                  {previewTabs.length > 0 ? (
                    <>
                      <div className="relative flex-1 min-h-0 overflow-hidden">
                        <div
                          className={cn(
                            "flex h-full w-[200%] will-change-transform motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out",
                            showMobilePreview
                              ? "-translate-x-1/2"
                              : "translate-x-0",
                          )}
                        >
                          <div className="flex w-1/2 shrink-0 flex-col min-h-0">
                            {chatPanelContent}
                          </div>
                          <div className="flex w-1/2 shrink-0 flex-col min-h-0 bg-background">
                            {previewPanelBody}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 border-t border-border bg-background">
                        <MobileViewSwitcher
                          value={mobileView}
                          onChange={setMobileView}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-1 min-h-0 flex-col">
                      {chatPanelContent}
                    </div>
                  )}
                </div>
              ) : (
                <ResizablePanelGroup
                  direction="horizontal"
                  className="flex-1 min-h-0"
                >
                  <ResizablePanel
                    defaultSize={previewTabs.length > 0 ? "50%" : "100%"}
                    minSize="30%"
                    className="flex flex-col min-h-0 min-w-0"
                  >
                    {chatPanelContent}
                  </ResizablePanel>

                  {previewTabs.length > 0 && (
                    <>
                      <ResizableHandle withHandle />
                      <ResizablePanel
                        defaultSize="50%"
                        minSize="25%"
                        maxSize="70%"
                        className="flex flex-col min-h-0 min-w-0 bg-background"
                      >
                        {previewPanelBody}
                      </ResizablePanel>
                    </>
                  )}
                </ResizablePanelGroup>
              )}
            </div>
          ) : (
            <>
              {/* Welcome Screen */}
              <div
                className="flex-1 flex flex-col items-center px-4 py-8 relative overflow-y-auto"
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {/* Drag overlay */}
                {isDragOver && (
                  <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg m-2">
                    <div className="bg-background/90 backdrop-blur-sm px-6 py-4 rounded-xl shadow-lg">
                      <span className="text-lg font-medium text-primary">
                        Drop files here to upload
                      </span>
                    </div>
                  </div>
                )}
                {error ? (
                  <div className="mb-4 w-full max-w-3xl">
                    <ChatErrorNotice
                      error={error}
                      onDismiss={() => setError(null)}
                    />
                  </div>
                ) : null}
                <WelcomeScreen
                  userId={resolvedWelcomeData.userId}
                  userName={resolvedWelcomeData.userName}
                  workspaceId={resolvedWorkspaceId ?? null}
                  allApps={resolvedWelcomeData.allApps}
                  connections={resolvedWelcomeData.connections}
                  projects={resolvedWelcomeData.projects}
                  recentThreads={resolvedWelcomeData.recentThreads}
                  renderedAt={resolvedWelcomeData.renderedAt}
                  group={resolvedWelcomeData.group}
                  inputValue={welcomeInput}
                  onPromptChange={setWelcomeInput}
                  onSubmit={startNewChat}
                  onStartChatForApp={handleStartChatForApp}
                  attachments={attachments}
                  onFilesSelected={handleFilesSelected}
                  onRecentAttachmentSelect={handleRecentAttachmentSelect}
                  onTranscriptAttach={handleGeneratedTranscriptAttachment}
                  onAttachmentRemove={handleAttachmentRemove}
                  isCreatingThread={isSubmittingNewThread}
                  model={selectedThreadModel}
                  onModelChange={handleThreadModelChange}
                  modelOptions={availableThreadModels}
                  isOrgAdmin={isOrgAdmin}
                  onLockedModelSelect={openUnlockPremium}
                  onUnlockRequest={() => openUnlockPremium(null)}
                  showMoreModelsCta={canUnlockPremiumModels}
                  pausedSection={effectiveHostedCreditsPaused}
                  recentModelScope={modelRecentScope}
                  noModelsMessage={noModelsMessage}
                  noModelsNotice={
                    shouldAddCamelCodeToPicker ? (
                      <CamelCodePickerAlert
                        isOrgAdmin={isOrgAdmin}
                        settingsHref={modelPickerSettingsHref}
                      />
                    ) : null
                  }
                />
              </div>
            </>
          )}
        </>
      </ChatPreviewProvider>

      <CamelCodeWelcomeDialog
        open={billingDialog.kind === "welcome"}
        onOpenChange={handleBillingDialogOpenChange}
        onSeePremiumModels={() => openUnlockPremium(null)}
      />
      {currentOrg?.id ? (
        <UnlockPremiumModal
          open={billingDialog.kind === "unlock"}
          onOpenChange={handleBillingDialogOpenChange}
          triggerModel={
            billingDialog.kind === "unlock"
              ? billingDialog.triggerModel
              : null
          }
          isOrgAdmin={isOrgAdmin}
          orgId={currentOrg.id}
          onSeePlans={openPlanUpgrade}
          onTopUp={openBillingTopUp}
          onAddKey={openByokDialog}
          onOpenAiSignIn={openOpenAiSignIn}
          variant={
            effectiveHostedCreditsPaused?.reason ===
            "subscription_unavailable"
              ? "unlock"
              : effectiveHostedCreditsPaused?.reason ?? "unlock"
          }
        />
      ) : null}
      <PlanUpgradeDialog
        open={billingDialog.kind === "plans"}
        onOpenChange={handleBillingDialogOpenChange}
        onTopUp={openBillingTopUp}
        onAddKey={openByokDialog}
        onOpenAiSignIn={openOpenAiSignIn}
      />
      <TopUpDialog
        open={billingDialog.kind === "topup"}
        onOpenChange={handleBillingDialogOpenChange}
        packs={creditPacksFetcher.data?.packs ?? []}
        action="/api/billing/credit-packs"
        returnTo={currentChatPath}
        loading={
          billingDialog.kind === "topup" && !creditPacksFetcher.data
            ? true
            : creditPacksFetcher.state !== "idle"
        }
        canTopUp={creditPacksFetcher.data?.canTopUp ?? Boolean(isAdmin)}
        unavailableReason={creditPacksFetcher.data?.unavailableReason ?? null}
      />
      <ByokKeyDialog
        open={billingDialog.kind === "byok"}
        onOpenChange={(open) => {
          if (!open) {
            transitionBillingDialog({ kind: "none" });
          }
        }}
        selectedProvider={selectedProvider}
        onProviderChange={(provider) => {
          setSelectedProvider(provider);
          setProviderError(null);
        }}
        apiKey={providerApiKey}
        onApiKeyChange={(key) => {
          setProviderCredential({
            orgId: currentOrg?.id ?? null,
            apiKey: key,
          });
          setProviderError(null);
        }}
        awsRegion={awsRegion}
        onAwsRegionChange={(region) => {
          setAwsRegion(region);
          setProviderError(null);
        }}
        onSubmit={saveByokProvider}
        isSubmitting={providerFetcher.state !== "idle"}
        errorMessage={providerError}
      />
      {currentOrg?.id ? (
        <OpenAiSignInDialog
          open={billingDialog.kind === "openai"}
          onOpenChange={handleBillingDialogOpenChange}
          orgId={currentOrg.id}
          onSuccess={() => revalidator.revalidate()}
        />
      ) : null}

      {/* Connection Setup Prompt Modal */}
      {connectionSetupPrompt && (
        <ConnectionSetupPrompt
          data={connectionSetupPrompt}
          onSubmit={handleConnectionSetupResponse}
          onCancel={handleConnectionSetupCancel}
        />
      )}
    </TooltipProvider>
  );
}
