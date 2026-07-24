
import {
  callable,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
  ChatRecoveryConfig,
  ChatRecoveryExhaustedContext,
} from "@cloudflare/ai-chat";
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions,
} from "@cloudflare/ai-chat";
import {
  CHAT_MESSAGE_TYPES,
  CHAT_RECOVERING_FLAG_TTL_MS,
  CHAT_RECOVERING_KEY,
  CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
} from "agents/chat";
import type {
  Agent as PiCoreAgent,
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Model,
} from "@earendil-works/pi-ai";
import type { OrgDO } from "./auth";
import type { WorkspaceDO } from "./workspace";
import { WorkspaceFilesystemClient } from "./workspace-filesystem-do";
import { formatAttributedUserMessage } from './chat-author-attribution';
import { resolveMessageAuthorDisplayName } from '../../../src/lib/message-author';
import { injectFileSafetyMessage } from './file-safety';
import { applyMentionContext } from './mention-context';
import { extractThreadCompletionSummarySource } from '../../../src/lib/thread-completion-summary-generation.server';
// Types only — the `ai` package's runtime surface is heavy and chat-thread-do.ts
// sits in every worker/test isolate's module graph, so its stream builders are
// lazy-loaded via dynamic import() inside onChatMessage (the only runtime user)
// rather than eagerly pulled here. Static value imports from 'ai' roughly double
// the worker test-suite import time and time out unrelated slow tests.
import type { UIMessage, UIMessageStreamWriter } from 'ai';
import {
  PiChunkEncoder,
  PI_ERROR_PART_ID,
  type PiRuntimeEvent,
  type PiUiMessageChunk,
} from '../../../src/lib/pi-chunk-encoder';
import { normalizePiUiMetadata, type PiUiMetadata, type RuntimeCallArtifact } from '../../../src/lib/runtime-artifacts';
import type {
  LlmModel,
  ThreadCompletionSummaryStatus,
} from '../../../src/types';
import type {
  ThreadProjectActivity,
  ThreadProjectActivityType,
} from '../../../src/lib/thread-project-activity';
import type { ChatGroupIconGenerationClaim } from "./identity/user-do";
import {
  CAMEL_CODE_LLM_MODEL,
  CUSTOM_LLM_MODEL,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  normalizeLlmModel,
} from "../../../src/lib/llm-provider-config";
import type { HostedCapability } from "../../../src/lib/capability-allowances";
import {
  getEffectiveLlmProviderConfig,
  isSelfhostRuntime,
} from "../../../src/lib/selfhost-ai-provider";
import { isOrgBanned } from "./ban-list";
import type { WorkspaceThreadStreamingOptions } from "./thread-status";

import {
  PI_SKILL_DESCRIPTIONS,
  PI_SKILL_NAMES,
} from "./pi-skills-bundle";
import {
  createPiSystemPrompt,
} from "./pi-system-prompt";

import { repairPiMessageHistoryForReplay } from "./pi-message-history";
import { planPiTurnResume } from "./pi-turn-journal";

import { recordErrorEvent, recordObservabilityEvent } from "./observability";
import {
  boundLakeErrorMessage,
  sendToolCallRecords,
  toolBlocksOnHuman,
} from "./lake-streams";
import { TranscriptLakeMirror } from "./chat-thread/transcript-lake";
import {
  BrowserPromptCoordinator,
  type ConnectionSetupResponse,
} from "./chat-thread-browser-prompts";
import {
  resolveContextUsageForInit,
} from "./chat-context-usage";


import { retryTransientDurableObjectRpc } from "../../../src/lib/do-rpc-retry.server";

import { normalizeChannelIndicatorKind } from "../../../src/lib/channel-kinds";

import { codeModeWorkerModule } from "./code-mode-runner";

import type {
  DynamicIntegrationSchema,
} from "../../../src/lib/integration-registry";
import {
  deriveVerifiedWorkEvidence,
  formatVerifiedWorkStatePrompt,
  mergeVerifiedWorkState,
  type VerifiedWorkEvidence,
} from "./chat-thread/verified-work-state";

export type { ConnectionSetupResponse } from "./chat-thread-browser-prompts";
export {
  applyContextUsageSdkEvent,
  extractContextWindowByModel,
  resolveContextUsageForInit,
  shallowEqualNumberMaps,
} from "./chat-context-usage";
export type {
  ContextUsageSdkEvent,
  ContextUsageTrackingState,
  ContextUsageTrackingUpdate,
  LastMessageStartUsage,
} from "./chat-context-usage";
export { prepareCodeModeUserCode } from "./code-mode-runner";

// Code-mode tool layer lives in ./code-mode-tools (extracted from this file).
// Imported here for internal use and re-exported so existing import paths
// (`from "./chat-thread-do"`) keep working for external callers.
import {
  CodeModeToolsBinding,
  CODE_MODE_COMPATIBILITY_DATE,
  CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_DEFAULT_TIMEOUT_MS,
  CODE_MODE_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_MAX_TIMEOUT_MS,
  CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
  clampCodeModeInteger,
  normalizeTodoItems,
  truncateCodeModeText,
} from "./code-mode-tools";
import type {
  CodeModeToolsProps,
  AIVirtualBindingProps,
} from "./code-mode-tools";
export { CodeModeToolsBinding, CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS };
export type { CodeModeToolsProps, AIVirtualBindingProps };

// Outbound channel tooling lives in ./chat-channels (extracted from this file).
import { ChannelTools } from "./chat-channels";

// Parsed-chat-message conversion (agent-eval / admin explorer) lives in
// ./pi-message-export (extracted from this file).
import {
  PI_USER_STOP_METADATA_REASON,
  isPiUserStopMessage,
  piCoreForkMessageIds,
  piCoreMessageToParsedChatMessage,
  attachPiToolResultToParsedMessages,
  summarizeAdminExplorerThread,
} from "./pi-message-export";

// Pure Pi model/provider mapping helpers live in ./pi-model-resolution.
import { PiModelMapping } from "./pi-model-resolution";

// Pure Pi message helpers (predicates/extractors, tool-result truncation,
// runtime formatting, pi_core keys/stamping) live in
// ./chat-thread/pi-message-helpers.
import {
  truncatePiToolResultText,
  piToolResultTruncationNotice,
  mergePiToolResultDetails,
  isAbortedPiAssistantMessage,
  isFailedPiAssistantMessage,
  isEmptyAbortedPiAssistantMessage,
  isPiAssistantMessage,
  getPiAssistantErrorMessage,
  getLatestPiAssistantErrorMessage,
  piProviderErrorMetadata,
  extractPiMessageText,
  extractLatestPiAssistantText,
  latestPiAssistantMessage,
  isPiSummaryMessage,
  piRuntimeToolItem,
  piEventArgs,
  piToolResultText,
  piRuntimeContentItems,
  latestPiAssistantForkEntryId,
  piRuntimeUsageSummary,
  addPiRuntimeUsageSummaries,
  piUsageSourceId,
  piCoreMessageKey,
  dedupePiMessagesByKey,
  stampPiRenderMessageId,
  withPiRenderMessageId,
} from "./chat-thread/pi-message-helpers";

// Pure Pi context-compaction helpers live in ./chat-thread/pi-compaction.
import {
  piModelContextWindow,
  piCompactionReserveTokens,
  capPiMainRequestOutput,
  effectivePiContextTokens,
  isPiLengthStopContextExhaustion,
  shouldCompactPiAfterAssistantUsage,
  loadPiCompleteSimple,
  findPiCompactionCutIndex,
  summarizePiMessages,
  createFallbackPiCompactionSummary,
  createPiSummaryMessage,
} from "./chat-thread/pi-compaction";
import { measurePiContextTokens } from "./chat-thread/pi-token-count";

// Agent-eval helpers (timeout, result extraction, deployed-app collection).
import {
  withAgentEvalTimeout,
  latestAgentEvalResult,
  collectAgentEvalDeployedApps,
} from "./chat-thread/agent-eval";

// Pi model / billing-source resolution (BYOK, hosted credits, request config).
import {
  resolvePiModelConfig,
  resolvePiRequestConfig,
  checkHostedPiModelAccess,
  resolveCurrentByokCredentials,
  type PiBillingSource,
  type PiRequestConfig,
  type PiResolvedModelConfig,
  type HostedModelAccess,
  type HostedModelFallbackReason,
  type LlmProviderConfigRecord,
  isPiImageBlindModel,
} from "./chat-thread/pi-model-config";
import { FREE_VLLM_PRIORITY } from "./hosted-vllm-priority";

// Provider-level transient-retry ladder for Pi model streams.
import {
  streamPiModelWithTransientRetry,
  abortableSleep,
  type PiProviderStreamTerminalStatus,
} from "./chat-thread/pi-stream-retry";

// Turn/steer journal + active-turn marker persistence (PiTurnJournal).
import {
  PiTurnJournal,
  type PiActiveTurnMarker,
} from "./chat-thread/pi-turn-journal";

// pi_core message persistence (PiCoreMessageStore).
import {
  PiCoreMessageStore,
  type PiCoreImagePolicy,
  type PiImageHydrationBudget,
} from "./chat-thread/pi-core-store";

// pi_core → ai-chat render-mirror machinery (ChatThreadUiMirror): the top-up
// backfill, legacy time heal, user render skeleton, and wipe-and-rebuild resync.
import {
  ChatThreadUiMirror,
  UI_MESSAGES_PI_CORE_HIGH_WATER_KEY,
  UI_MESSAGES_PI_CORE_REVISION_KEY,
} from "./chat-thread/ui-mirror";

// Thread metadata generation (ChatThreadMetadata): per-user-message org
// metadata updates, title generation, chat group avatar/emoji generation, and
// the assistant-completion record + hover-summary persistence pipeline.
import {
  ChatThreadMetadata,
  type AssistantCompletionPersistenceResult,
} from "./chat-thread/metadata";

// Preview-state primitives (ChatThreadPreviewState + the pure target/tab-id
// normalizers): preview-target normalization and preview session persistence.
import {
  ChatThreadPreviewState,
  getPreviewTabId,
  normalizePreviewTarget,
} from "./chat-thread/preview-state";

// Chat access grants + client-message dedup (ChatThreadAccess): the
// degraded-auth grant map and the recently-accepted clientMessageId list.
import { ChatThreadAccess } from "./chat-thread/access";

// Workspace streaming-activity publisher (ChatThreadStreamingActivity): the
// trailing-debounced running-activity fan-in to WorkspaceDO, the streaming
// liveness-lease heartbeat, and the running-activity normalization gates.
import { ChatThreadStreamingActivity } from "./chat-thread/streaming-activity";

// Automation-run state machine (ChatThreadAutomationRun): the persisted
// active scheduled-automation run lock, WorkspaceCronDO result reporting, and
// stale-lock reconciliation.
import {
  ChatThreadAutomationRun,
  CHAT_ACTIVE_AUTOMATION_RUN_KEY,
  type ActiveAutomationRunState,
} from "./chat-thread/automation-run";

// Code-mode artifact buffer (ChatThreadCodeModeArtifacts): per-tool-call KV
// artifact accumulation, live stream delivery, and the read/consume path.
import { ChatThreadCodeModeArtifacts } from "./chat-thread/code-mode-artifacts";

// Bounded per-thread rollup of successful project create/deploy activity.
import { ChatThreadProjectActivity } from "./chat-thread/project-activity";
import {
  collectChatMemoryStats,
  type ChatMemoryStats,
} from "./chat-thread/chat-memory-telemetry";

// Chat send failure / error payload helpers (ChatThreadErrors): send-failure
// status + billing classification, error payload construction, and the
// deduplicated OrgDO thread-error recorder. Event delivery (pushChatEvent /
// broadcast) stays on this DO.
import { ChatThreadErrors } from "./chat-thread/errors";

// Pi tool-definition surface (executor-style tool list + Agent/Explore
// subagent runner + subagent system prompt).
import {
  createPiToolDefinitions,
  runPiSubagentTool,
  createPiSubagentSystemPrompt,
  type PiAfterToolCallOptions,
  type PiToolDefinitionOptions,
  type PiToolSurfaceDeps,
} from "./chat-thread/pi-tools";

// Pure Pi message/tool-result storage helpers live in ./pi-message-storage.
import {
  PI_TOOL_RESULT_R2_REF_METADATA_KEY,
  PI_TAIL_TRUNCATED_TOOL_NAMES,
  sanitizePiModelMessage,
  stripPiInlineImageDataUrls,
  projectPiToolResultDetails,
} from "./pi-message-storage";
import type {
  PiR2ToolResultReference,
  PiSqlStorageSerialization,
} from "./pi-message-storage";

// Shared chat-thread type/interface/env definitions live in
// ./chat-thread/types (extracted from this file). Imported here for internal
// use and re-exported below so existing `from "./chat-thread-do"` import paths
// keep working for external callers.
import type {
  AdminExplorerThreadSummary,
  AgentEvalParsedMessage,
  AgentEvalSessionRequest,
  AgentEvalSessionResult,
  ChannelHistoryEventRequest,
  ChannelHistoryEventResult,
  ChatAgentEnv,
  ChatContextState,
  ChatEnv,
  ChatThreadAgentState,
  ChatThreadForkState,
  ChatThreadForkStateTarget,
  ChatThreadPiCoreForkResult,
  ChatThreadRuntimeStatus,
  ChatUserMessageInput,
  CodeModeJavascriptRequest,
  CodeModeJavascriptResult,
  InitialUserMessageRequest,
  InitialUserMessageResult,
  PiCoreMessageHistoryRepairReport,
  PiCoreMessageRow,
  PiResolvedModelReference,
  PreviewTarget,
} from "./chat-thread/types";
export type {
  AdminExplorerThreadSummary,
  AgentEvalDeployedApp,
  AgentEvalParsedMessage,
  AgentEvalSessionRequest,
  AgentEvalSessionResult,
  ChannelHistoryEventRequest,
  ChannelHistoryEventResult,
  ChatContextState,
  ChatEnv,
  ChatThreadForkState,
  ChatThreadForkStateTarget,
  ChatThreadPiCoreForkResult,
  ChatThreadRuntimeStatus,
  CloudflareEmailSender,
  InitialUserMessageRequest,
  InitialUserMessageResult,
  NormalizedTodoItem,
  NormalizedTodoStatus,
  PiCoreMessageHistoryRepairReport,
  PiCoreMessageRow,
  PiHeaderValue,
  PiResolvedModelReference,
  PreviewTarget,
} from "./chat-thread/types";

const PI_USER_STOP_TEXT = "Stopped by user";
// In-process regeneration budget for a turn whose run SETTLED with a retryable
// transient provider error (e.g. the AI Gateway's mid-stream "Upstream idle
// timeout exceeded"). This is a third, independent retry layer: the
// PI_PROVIDER_* wrapper above retries a transient stream error only BEFORE any
// event was forwarded, and chatRecovery re-drives only evictions/stalls — a
// post-forwarded provider error previously terminal-failed with no final
// message. Classification is pi-ai's isRetryableAssistantError; each attempt
// re-drives resumeActivePiTurn (rebuild from committed history + journal).
const PI_TURN_TRANSIENT_RETRY_ATTEMPTS = 2;
const PI_TURN_TRANSIENT_RETRY_BASE_MS = 500;
const PI_TURN_TRANSIENT_RETRY_MAX_MS = 4_000;

interface CachedLlmProviderConfig {
  orgId: string;
  value: LlmProviderConfigRecord;
}

function cloneDurableState<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

const PI_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
const PI_TURN_PROGRESS_INTERVAL_MS = 30_000;
// Single-tool ceiling under keep-alive. Must sit above the longest legitimate
// harness tool wall clock (notebook exec max 15m, code-mode max 10m) with slack.
// Heartbeats are allowed only while under this ceiling; past it the tool fails
// as an isError result and the agent turn continues (session is NOT disposed).
const PI_TURN_TOOL_HARD_TIMEOUT_MS = 20 * 60_000;
// Whole-turn wall clock from agent_start. Last-resort stop for runaway loops;
// always surfaces a user-visible message before going idle.
const PI_TURN_ABSOLUTE_MAX_MS = 60 * 60_000;
// User/model-facing copy (also becomes the tool-result error text via throw).
const PI_TURN_TOOL_TIMEOUT_MESSAGE =
  "This tool timed out after 20 minutes without completing. Try a smaller scope, a shorter command, or a different approach. The turn is still active — continue or ask the user.";
const PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE =
  "This turn was stopped after running for 60 minutes so the workspace stays responsive. Send a new message to continue from here.";

/**
 * Thrown by {@link ChatThreadDO.withPiTurnInactivityTimeout} when a Pi turn
 * stalls past PI_TURN_INACTIVITY_TIMEOUT_MS. This is a server-side stall, not a
 * user-initiated abort: the Pi session is disposed (handlers unsubscribed)
 * before this is thrown, so no agent_end handler runs and callers must reset
 * streaming state themselves. Detect with `instanceof` so it is not confused
 * with the benign AbortError raised by a genuine user `stop`.
 */
class PiTurnInactivityTimeoutError extends Error {
  constructor(message = "Pi turn inactivity timeout") {
    super(message);
    this.name = "PiTurnInactivityTimeoutError";
  }
}

/**
 * Thrown when a single harness tool exceeds {@link PI_TURN_TOOL_HARD_TIMEOUT_MS}.
 * Propagates out of the tool `execute` path; pi-agent-core turns execute throws
 * into a normal `isError` tool result so the **turn continues** and the model
 * can recover. Must NOT dispose the Pi session (that would kill the whole turn).
 */
class PiTurnToolHardTimeoutError extends Error {
  constructor(message = PI_TURN_TOOL_TIMEOUT_MESSAGE) {
    super(message);
    this.name = "PiTurnToolHardTimeoutError";
  }
}

/**
 * Thrown when a turn exceeds {@link PI_TURN_ABSOLUTE_MAX_MS} wall clock from
 * agent_start. Terminal path surfaces {@link PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE}
 * to the user and clears the marker so chatRecovery cannot re-drive the hang.
 */
class PiTurnAbsoluteTimeoutError extends Error {
  constructor(message = PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE) {
    super(message);
    this.name = "PiTurnAbsoluteTimeoutError";
  }
}

const CHAT_CONTEXT_KEY = "chatContext";
// Durable resume of an interrupted Pi turn (e.g. the DO is evicted mid-turn by a
// deploy). ai-chat's `chatRecovery` owns recovery now: a turn runs through
// saveMessages -> _runProgrammaticChatTurn -> onChatMessage, wrapped by ai-chat's
// `_runChatRecoveryFiber`. A mid-turn eviction leaves an ai-chat fiber orphan the
// framework detects on the next wake and re-drives through onChatMessage
// (continueLastTurn for a mid-stream partial, _retryLastUserTurn for a pre-stream
// eviction) under a bounded attempt budget. The `piActiveTurn` marker and the
// turn/steer journals live in ./chat-thread/pi-turn-journal (PiTurnJournal).
// User-facing copy delivered as the chatRecovery `terminalMessage` when an
// interrupted turn exhausts its recovery budget (reused from the old resume path).
const PI_RESUME_EXHAUSTED_MESSAGE =
  "This turn was interrupted and could not be resumed automatically. Please send your message again.";

const CHAT_TODOS_KEY = "chatTodos";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_ACTIVE_TURN_USER_ID_KEY = "chatActiveTurnUserId";
const CHAT_VERIFIED_WORK_STATE_KEY = "chatVerifiedWorkState";

// ai-chat's recovery-bookkeeping storage keys are imported from agents/chat
// (CHAT_RECOVERY_INCIDENT_KEY_PREFIX / CHAT_RECOVERING_KEY /
// CHAT_RECOVERING_FLAG_TTL_MS) so they can never drift from the framework. The
// stale-marker sweep reads them to confirm ai-chat has no in-flight recovery for
// an orphaned turn before clearing it.
const ACTIVE_CHAT_RECOVERY_STATUSES = new Set([
  "detected",
  "scheduled",
  "attempting",
]);

// Chat-protocol wire frames AIChatAgent's constructor-installed onMessage
// wrapper would service from ANY authorized socket. This DO's chat data flow is
// server-driven (sendMessage callable → sendRunnerCommand → saveMessages); no
// browser client legitimately submits these frames, and letting them through
// would allow any workspace member's socket to wipe/forge render history
// (chat_clear / chat_messages), start framework-owned turns (use_chat_request),
// abort the reply stream mid-turn (request_cancel → stall-dispose with the
// active-turn marker left set), or inject tool results/approvals. The guard
// installed in the constructor drops them before the framework handler runs.
// Resume-handshake frames (cf_agent_stream_resume_*) and the Agents SDK
// rpc/state frames are NOT protocol frames of this set and pass through.
const BLOCKED_CHAT_PROTOCOL_FRAME_TYPES = new Set<string>([
  CHAT_MESSAGE_TYPES.CHAT_CLEAR,
  CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
  CHAT_MESSAGE_TYPES.USE_CHAT_REQUEST,
  CHAT_MESSAGE_TYPES.CHAT_REQUEST_CANCEL,
  CHAT_MESSAGE_TYPES.TOOL_RESULT,
  CHAT_MESSAGE_TYPES.TOOL_APPROVAL,
]);
// The chat-error dedupe window constant lives in ./chat-thread/errors with
// recordCurrentThreadError, its sole user.

const ASK_USER_QUESTION_UNAVAILABLE_MESSAGE = 'User is not at computer; AskUserQuestion is unavailable in this channel. Continue without asking and use best effort.';

const HEADER_USER_NAME = "X-Chiridion-User-Name";
const HEADER_USER_EMAIL = "X-Chiridion-User-Email";
const HEADER_USER_ID = "X-Chiridion-User-Id";
const HEADER_AUTH_DEGRADED = "X-Chiridion-Auth-Degraded";
// The degraded-auth grant map and recent-clientMessageId dedup constants live
// in ./chat-thread/access with the methods that use them.

// The codeModeArtifacts: KV key prefix lives in
// ./chat-thread/code-mode-artifacts with the methods that use it.

// The UI_MESSAGES_* KV keys for the pi_core → ai-chat render mirror live in
// ./chat-thread/ui-mirror (UI_MESSAGES_PI_CORE_HIGH_WATER_KEY is re-imported
// above for replacePiCoreMessages' re-pin path).
// Drop-oldest cap for the pre-attach chunk buffer so a turn that never attaches
// a writer (e.g. saveMessages skipped) cannot grow memory without bound.
const PI_STREAM_PRE_ATTACH_CHUNK_CAP = 5000;

/**
 * ChatThreadDO - One per thread, owns preview state, prompts, browser traffic,
 * and agent-turn orchestration.
 */
// Extends AIChatAgent for its resumable-stream transport (SQLite chunk
// buffering + replay on reconnect) and, later, chatRecovery. The ai-chat
// message model is transport-internal only: pi_core_messages remains the
// canonical history and the Pi runtime owns the agent loop.
export class ChatThreadDO extends AIChatAgent<ChatAgentEnv, ChatThreadAgentState> {
  private static readonly CONNECTION_SETUP_TIMEOUT_MS = 30 * 60 * 1000;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  private agentEvalEventCollector: Array<Record<string, unknown>> | null = null;
  private lastError: ChatThreadAgentState["lastError"] = null;
  // Guards the one-time cold-wake reload of durable notification/error state.
  private durableStateHydrated: boolean = false;
  private currentTodos: unknown[] = [];
  // Canonical persisted/replayed value (set on result events only).
  private contextUsedPercent: number | null = null;
  // Ephemeral in-turn value (never persisted).
  private transientContextUsedPercent: number | null = null;
  private usageIsPostCompaction: boolean = true;
  private cachedContextWindowByModel: Record<string, number> = {};
  private activeAutomationRun: ActiveAutomationRunState | null = null;
  private currentTitle: string | null = null;
  private currentTitleUpdatedAt: number | null = null;
  private currentThreadModel: LlmModel | null = null;
  private currentThreadModelUpdatedAt: number | null = null;
  private modelFallbackNotice: ChatThreadAgentState["modelFallbackNotice"] = null;
  private assistantCompletionRecordedAt: number | null = null;
  private assistantCompletionSummaryRequestedAt: number | null = null;
  private readonly browserPrompts = new BrowserPromptCoordinator({
    hasAvailableBrowserUser: () => this.hasAvailableBrowserUser(),
    broadcast: (message) => this.handleBrowserPromptStateChange(message),
    askUserQuestionUnavailableMessage:
      ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
    questionTimeoutMs: 30 * 60 * 1000,
    connectionSetupTimeoutMs: ChatThreadDO.CONNECTION_SETUP_TIMEOUT_MS,
  });
  // Collaborators are lazily memoized for the lifetime of this DO. Their
  // callbacks dereference live owner state, so caching avoids repeated adapter
  // allocation without freezing mutable fields or prototype-fake test seams.
  private codeModeArtifactsInstance?: ChatThreadCodeModeArtifacts;
  private projectActivityInstance?: ChatThreadProjectActivity;
  private automationRunInstance?: ChatThreadAutomationRun;
  private uiMirrorInstance?: ChatThreadUiMirror;
  private piTurnJournalInstance?: PiTurnJournal;
  private chatAccessInstance?: ChatThreadAccess;
  private channelToolsInstance?: ChannelTools;
  private piModelMappingInstance?: PiModelMapping;
  private chatErrorsInstance?: ChatThreadErrors;
  private previewStateInstance?: ChatThreadPreviewState;
  private streamingActivityInstance?: ChatThreadStreamingActivity;
  private threadMetadataInstance?: ChatThreadMetadata;
  private transcriptLakeInstance?: TranscriptLakeMirror;
  // Live tool timing. Pi emits tool_execution_start/end but records no start
  // timestamp on the resulting toolResult message, so duration exists only
  // between these two events: `piToolStartedAtMs` holds it in flight, and
  // `piToolDurationMs` carries the settled value forward to the commit that
  // stamps it onto the persisted row (uiMetadata.toolDurationMs).
  //
  // Lazily materialized through prototype getters rather than constructor field
  // initializers, so the prototype-fake seam these handlers are unit-tested
  // through (Object.create(ChatThreadDO.prototype)) does not have to enumerate
  // them to exercise an unrelated event.
  private piToolStartedAtMsMap?: Map<string, number>;
  private piToolDurationMsMap?: Map<string, number>;
  private get piToolStartedAtMs(): Map<string, number> {
    return (this.piToolStartedAtMsMap ??= new Map<string, number>());
  }
  private get piToolDurationMs(): Map<string, number> {
    return (this.piToolDurationMsMap ??= new Map<string, number>());
  }
  private lastChatMemoryStoreSnapshotAt = 0;
  private lastChatMemoryPhaseAt = new Map<string, number>();
  private aiChatMemoryBoundariesInstrumented = false;
  private cachedChatMemoryStats: ChatMemoryStats | null = null;
  private cachedChatMemoryStatsAt = 0;
  private titleGenerationInFlight: boolean = false;
  private activeTurnUserId: string | null = null;
  private workspaceStatusStubs = new Map<string, DurableObjectStub<WorkspaceDO>>();
  // Trailing-debounce state for coalescing WorkspaceDO.recordThreadStreaming
  // running-activity updates. This is a per-thread DO, so a single pending entry
  // (one timer + the latest payload) is sufficient. Terminal streaming
  // transitions clear this so a stale activity update can never overwrite the
  // final state.
  private pendingStreamingActivity: {
    workspaceId: string;
    threadId: string;
    activityText: string;
    activityAt: number;
    coalescedCount: number;
  } | null = null;
  private streamingActivityFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Interval renewing the WorkspaceDO running row's liveness lease during a
  // turn; started by markTurnStarted, stopped by resetRunningActivityState.
  private streamingLeaseRefreshTimer: ReturnType<typeof setInterval> | null = null;
  // Absolute wall-clock watchdog for the whole agent turn (agent_start → end).
  private piTurnAbsoluteTimeoutTimer: ReturnType<typeof setInterval> | null = null;
  // Interval owned by the in-flight keepPiTurnToolProgressAliveWhile call (at
  // most one tool at a time). Cleared on settle and on dispose so a hung tool
  // cannot leave a ghost heartbeat interval after abort.
  private piToolKeepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private runnerTransitionChain: Promise<void> = Promise.resolve();
  private piSessionPromise: Promise<PiCoreAgent> | null = null;
  private piSession: PiCoreAgent | null = null;
  private piCoreStoreInstance?: PiCoreMessageStore;
  private piMainBaselineIndex = 0;
  private piModelResolver: (() => Promise<PiResolvedModelConfig>) | null = null;
  private piUnsubscribe: (() => void) | null = null;
  /**
   * Turn-scoped cache of OrgDO.getLlmProviderConfig for this thread's org.
   * Caches both null (no BYOK config, the common hosted case) and non-null
   * records. Cleared at agent_start so each turn reads the config exactly
   * once, and on byokChanged() so admin updates apply promptly mid-turn.
   */
  private cachedLlmProviderConfig: CachedLlmProviderConfig | null = null;
  private pendingClientMessageEnqueues: Map<
    string,
    Promise<InitialUserMessageResult>
  > | null = null;
  private piEventHandlerChain: Promise<void> = Promise.resolve();
  private piActiveItemId: string | null = null;
  private piActiveItemText = "";
  private piReasoningItemId: string | null = null;
  private piToolArgs: Map<string, Record<string, unknown>> = new Map();
  private piToolFailures = new Map<string, { count: number; error: string; limit: number }>();
  private piToolFailureRecordedCallIds = new Set<string>();
  private piAssistantText = "";
  private runningActivityLastText: string | null = null;
  private runningActivityLastSentAt = 0;
  private piTurnStartedAtMs: number = 0;
  private piAgentStartedAtMs: number = 0;
  private piUserStopRequestedAtMs: number = 0;
  private piLastTurnUsage: Record<string, unknown> | null = null;
  private piSdkTurnIndex: number = 0;
  private piSdkTurnUsageTotal: Record<string, unknown> | null = null;
  private piCurrentBillingSource: PiBillingSource = "hosted";
  private piCurrentCreditChargeable: boolean = false;
  private piCurrentUsageProvider: string | null = null;
  private piTurnLastProgressAtMs: number = 0;
  // In-process transient-retry state (see PI_TURN_TRANSIENT_RETRY_ATTEMPTS).
  // agent_end defers terminal surfacing of a retryable provider error by
  // setting the pending token; the turn body's retryPiTurnWhileTransient loop
  // consumes it. Both reset at the start of each onChatMessage execute.
  private piTurnTransientRetryAttempts = 0;
  private piPendingTransientTurnRetry: {
    errorText: string;
    provider: string | null;
    model: string | null;
  } | null = null;
  private piTransientRetryBackoffAbort: AbortController | null = null;
  private recordedChatErrors = new Map<string, number>();

  // --- Native UIMessage stream bridge (commit 6, ai-chat-owned turn) --------
  // onChatMessage OWNS the Pi turn: its stream execute runs the model
  // (prompt for a fresh turn, resume-continue for a recovery) and relays the Pi
  // runtime events through the encoder into native UIMessage chunks. Fresh turns
  // queue their attributed Pi prompts here (in-memory, FIFO): two rapid sends on
  // a cold session both land before prompt() flips isStreaming, so admission
  // must queue rather than overwrite. onChatMessage drains the queue — the first
  // message is prompted, the rest are steer()ed into the just-started run. On a
  // recovery re-drive the queue is empty — the resume branch rebuilds the model
  // turn from the pi_turn_journal (which durably holds every queued user
  // message) instead.
  private pendingPiPromptQueue: Array<{ userMessage: AgentMessage }> = [];
  // The minted stream turnId for the in-flight turn — the id ai-chat adopts as the
  // assistant message id (and the client renders under). Restored from the active-
  // turn marker at the top of onChatMessage so a recovery continuation reuses it.
  // null between turns.
  private activePiStreamTurnId: string | null = null;
  // The stateful encoder for the in-flight turn (created in onChatMessage from the
  // marker turnId). null when no turn is bridging.
  private piChunkEncoder: PiChunkEncoder | null = null;
  // The live ai-chat stream writer once onChatMessage's execute has attached it.
  private piStreamWriter: UIMessageStreamWriter<UIMessage> | null = null;
  // Defensive buffer for any chunk produced before the writer attaches. The turn
  // body runs inside execute (after the writer is set) so this normally stays
  // empty, but it keeps a stray between-attach event from being dropped.
  private piPreAttachChunkBuffer: PiUiMessageChunk[] | null = null;

  // Durable chat recovery (commit 6). MUST be a class field (not set in onStart):
  // the SDK evaluates recovery budgets on wake BEFORE onStart runs. maxAttempts
  // bounds re-drives of an interrupted turn; onExhausted mirrors the old resume
  // give-up cleanup (the framework also delivers `terminalMessage` to the client).
  // Defaults fill stableTimeoutMs / noProgressTimeoutMs / maxOomRetries.
  chatRecovery: ChatRecoveryConfig = {
    maxAttempts: 3,
    terminalMessage: PI_RESUME_EXHAUSTED_MESSAGE,
    onExhausted: (ctx) => this.handlePiRecoveryExhausted(ctx),
  };

  // ai-chat's inter-chunk stall watchdog (commit 7). If no chunk reaches the
  // reply stream within this window the turn is aborted and routed into bounded
  // chatRecovery. Set as a class field (like chatRecovery) so it is live before
  // onStart. This replaces the bespoke `withPiTurnInactivityTimeout` on the
  // bridged turn paths. The watchdog counts REPLY-STREAM chunks, not Pi session
  // progress, and a healthy long turn has legitimate multi-minute wire silences
  // (a tool executing with no output deltas; runtime events the encoder maps to
  // zero chunks) — so genuine liveness is converted into transient
  // `data-pi-heartbeat` chunks ({@link writePiStreamHeartbeat}: 30s cadence while
  // a harness tool executes via keepPiTurnToolProgressAliveWhile, plus one per
  // zero-chunk runtime event in writePiStreamChunks). The watchdog then only
  // trips on a truly dead session (no events, no running tool). onChatMessage
  // wires the watchdog's stream-cancel to dispose the hung Pi session (see
  // {@link onPiReplyStreamCancelled}); the eval path keeps the bespoke wrapper
  // since it prompts the session directly, outside the ai-chat stream.
  chatStreamStallTimeoutMs = PI_TURN_INACTIVITY_TIMEOUT_MS;

  initialState: ChatThreadAgentState = {
    previewTabs: [],
    previewActiveTabId: null,
    previewVersion: 0,
    previewRefreshTabId: null,
    currentTodos: [],
    contextUsedPercent: null,
    pendingQuestion: null,
    connectionSetupPrompt: null,
    title: null,
    titleUpdatedAt: null,
    model: null,
    modelUpdatedAt: null,
    modelFallbackNotice: null,
    lastError: null,
  };

  static {
    const context = {} as ClassMethodDecoratorContext;
    callable()(this.prototype.requestStop, context);
    callable()(this.prototype.setPreviewTabsState, context);
    callable()(this.prototype.answerQuestion, context);
    callable()(this.prototype.submitConnectionSetupResponse, context);
    callable()(this.prototype.refreshModel, context);
    callable()(this.prototype.sendMessage, context);
  }

  private agentState(
    overrides: Partial<ChatThreadAgentState> = {},
  ): ChatThreadAgentState {
    // Derived only to seed the initial context-usage estimate; streaming state
    // itself now reaches the browser through the ai-chat hook, not Agent state.
    const isStreaming = this.isThreadStreaming();
    return {
      previewTabs: cloneDurableState(this.previewTabs),
      previewActiveTabId: this.previewActiveTabId,
      previewVersion: this.previewVersion,
      previewRefreshTabId: null,
      currentTodos: cloneDurableState(this.currentTodos),
      contextUsedPercent: resolveContextUsageForInit(
        this.transientContextUsedPercent,
        this.contextUsedPercent,
        isStreaming,
      ),
      pendingQuestion: cloneDurableState(
        this.browserPrompts?.getOldestPendingQuestion?.() ?? null,
      ),
      connectionSetupPrompt: cloneDurableState(
        this.browserPrompts?.pendingConnectionSetupPrompts?.()[0] ?? null,
      ),
      title: this.currentTitle,
      titleUpdatedAt: this.currentTitleUpdatedAt,
      model: this.currentThreadModel,
      modelUpdatedAt: this.currentThreadModelUpdatedAt,
      modelFallbackNotice: this.modelFallbackNotice,
      lastError: this.lastError,
      ...overrides,
    };
  }

  // Restore coarse durable notification/error state from Agent state on a
  // cold wake, once.
  // Render history comes from ai-chat; streaming state is derived on read
  // ({@link isThreadStreaming}); these instance fields must be reloaded before
  // the next syncAgentState() would otherwise overwrite them with null.
  private hydrateDurableStateOnce(): void {
    if (this.durableStateHydrated) return;
    this.durableStateHydrated = true;
    const state = this.state as Partial<ChatThreadAgentState> | undefined;
    if (!state) return;
    // NOTE: streaming state is no longer restored here — it is derived on read from
    // execution ground truth ({@link isThreadStreaming}), so a cold wake recomputes
    // it (an evicted mid-turn thread reports streaming via its orphan fiber row /
    // pending resume; a completed one reports idle) with no flag to resurrect.
    if (state.lastError && typeof state.lastError === "object") {
      this.lastError = cloneDurableState(state.lastError);
    }
    if (
      state.modelFallbackNotice &&
      typeof state.modelFallbackNotice === "object"
    ) {
      this.modelFallbackNotice = cloneDurableState(state.modelFallbackNotice);
    }
  }

  private syncAgentState(overrides?: Partial<ChatThreadAgentState>): void {
    this.hydrateDurableStateOnce();
    this.setState(this.agentState(overrides));
  }

  private handleBrowserPromptStateChange(
    message: Record<string, unknown>,
  ): void {
    if (
      message.type === "ask_user_question" ||
      message.type === "question_answered" ||
      message.type === "connection_setup_prompt" ||
      message.type === "connection_setup_answered"
    ) {
      this.syncAgentState();
      return;
    }
    this.broadcastChat(message);
  }

  private async withRunnerTransitionLock<T>(
    _source: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.runnerTransitionChain;
    let release!: () => void;
    this.runnerTransitionChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env as unknown as ChatAgentEnv);

    // Hibernatable ping/pong so middleboxes and hidden tabs can keep the socket
    // alive without application traffic. Pair is matched by the browser or any
    // client that sends the request string as a WS text frame.
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
    } catch {
      // Older local runtimes may lack auto-response; chat still works without it.
    }

    // AIChatAgent's constructor reassigned this.onMessage to a wrapper that
    // services cf_agent_* chat-protocol frames (chat_clear, chat_messages,
    // use_chat_request, request_cancel, tool_result, tool_approval) from any
    // authorized socket BEFORE subclass code runs. This DO never accepts those
    // frames from clients (see BLOCKED_CHAT_PROTOCOL_FRAME_TYPES), so wrap the
    // wrapper: drop the blocked frame types and pass everything else (resume
    // handshake, Agents SDK rpc/state frames, non-JSON) through unchanged.
    const frameworkOnMessage = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection, message: WSMessage) => {
      if (typeof message === "string") {
        let frameType: string | null = null;
        try {
          const parsed = JSON.parse(message) as { type?: unknown } | null;
          frameType =
            parsed && typeof parsed === "object" && typeof parsed.type === "string"
              ? parsed.type
              : null;
        } catch {
          frameType = null;
        }
        if (frameType && BLOCKED_CHAT_PROTOCOL_FRAME_TYPES.has(frameType)) {
          // No frame contents in the event — the type alone is the signal.
          this.recordChatThreadObservabilityEvent("chat_ws_frame_blocked", {
            operation: frameType,
            status: "blocked",
            severity: "warn",
          });
          return;
        }
      }
      return frameworkOnMessage(connection, message);
    };

    // SQLite-backed storage operations below are synchronous. Keep constructor
    // hydration out of blockConcurrencyWhile: if an active turn is being
    // recovered while route loaders reconnect, a blocked constructor can reset
    // the Durable Object and turn a normal recovery into another interruption.
    this.ensurePiCoreTables();

    const storedTabs = ctx.storage.kv.get<PreviewTarget[]>("previewTabs");
    const storedActiveTabId = ctx.storage.kv.get<string | null>(
      "previewActiveTabId",
    );
    const storedTarget = ctx.storage.kv.get<PreviewTarget>("previewTarget");
    if (Array.isArray(storedTabs)) {
      const normalizedState = this.normalizePreviewTabsState(
        storedTabs,
        storedActiveTabId,
      ) ?? {
        tabs: [],
        activeTabId: null,
        target: null,
      };
      this.previewTabs = normalizedState.tabs;
      this.previewActiveTabId = normalizedState.activeTabId;
      this.previewTarget = normalizedState.target;
    } else {
      const normalizedTarget = this.normalizePreviewTarget(
        storedTarget ?? null,
      );
      if (normalizedTarget) {
        this.previewTabs = [normalizedTarget];
        this.previewActiveTabId = this.getPreviewTabId(normalizedTarget);
        this.previewTarget = normalizedTarget;
      }
    }

    const version = ctx.storage.kv.get<number>("previewVersion");
    if (typeof version === "number") {
      this.previewVersion = version;
    }

    // Persist normalized preview session state. This also migrates legacy
    // single-target threads into multi-tab state on first hydrate.
    this.ctx.storage.kv.put("previewTabs", this.previewTabs);
    this.ctx.storage.kv.put("previewActiveTabId", this.previewActiveTabId);
    this.ctx.storage.kv.put("previewTarget", this.previewTarget);

    const storedContext =
      ctx.storage.kv.get<ChatContextState>(CHAT_CONTEXT_KEY);
    if (
      storedContext &&
      storedContext.threadId &&
      storedContext.workspaceId &&
      storedContext.orgId
    ) {
      this.chatContext = {
        ...storedContext,
        userId: storedContext.userId ?? null,
        userName: storedContext.userName ?? null,
        userEmail: storedContext.userEmail ?? null,
      };
    }

    const storedTodos = ctx.storage.kv.get<unknown[]>(CHAT_TODOS_KEY);
    if (Array.isArray(storedTodos)) {
      this.currentTodos = normalizeTodoItems(storedTodos);
    }

    const storedContextUsedPercent = ctx.storage.kv.get<number>(CHAT_CONTEXT_USED_PERCENT_KEY);
    if (typeof storedContextUsedPercent === 'number' && Number.isFinite(storedContextUsedPercent)) {
      this.contextUsedPercent = Math.max(0, Math.min(100, Math.round(storedContextUsedPercent)));
    }

    const storedContextWindowByModel = ctx.storage.kv.get<
      Record<string, unknown>
    >(CHAT_CONTEXT_WINDOW_BY_MODEL_KEY);
    if (
      storedContextWindowByModel &&
      typeof storedContextWindowByModel === "object"
    ) {
      for (const [model, contextWindow] of Object.entries(
        storedContextWindowByModel,
      )) {
        if (
          typeof contextWindow === "number" &&
          Number.isFinite(contextWindow) &&
          contextWindow > 0
        ) {
          this.cachedContextWindowByModel[model] = contextWindow;
        }
      }
    }

    const storedActiveTurnUserId = ctx.storage.kv.get<string>(
      CHAT_ACTIVE_TURN_USER_ID_KEY,
    );
    if (
      typeof storedActiveTurnUserId === "string" &&
      storedActiveTurnUserId.trim()
    ) {
      this.activeTurnUserId = storedActiveTurnUserId.trim();
    }

    this.activeAutomationRun = this.normalizeActiveAutomationRun(
      ctx.storage.kv.get<unknown>(CHAT_ACTIVE_AUTOMATION_RUN_KEY),
    );

    this.instrumentAiChatMemoryBoundaries();

    // super() has already performed ai-chat's eager render load. We cannot emit
    // before a base constructor in JavaScript, but this post-constructor pair
    // records the first allocation-safe watermark available to the subclass.
    const constructorPhase = this.startChatMemoryPhase("render_post_constructor");
    this.endChatMemoryPhase(constructorPhase);
  }

  async runCodeModeJavascript(
    request: CodeModeJavascriptRequest,
  ): Promise<CodeModeJavascriptResult> {
    const code = typeof request.code === "string" ? request.code : "";
    if (!code.trim()) {
      throw new Error("code is required");
    }
    if (!request.orgId || !request.workspaceId) {
      throw new Error("Code mode requires org and workspace scope");
    }

    const loader = this.env.CODE_MODE_LOADER as (WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    }) | undefined;
    if (!loader) {
      throw new Error("CODE_MODE_LOADER binding is not configured");
    }

    const timeoutMs = clampCodeModeInteger(
      request.timeoutMs,
      CODE_MODE_DEFAULT_TIMEOUT_MS,
      100,
      CODE_MODE_MAX_TIMEOUT_MS,
    );
    const maxOutputCharacters = clampCodeModeInteger(
      request.maxOutputCharacters,
      CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS,
      1000,
      CODE_MODE_MAX_OUTPUT_CHARACTERS,
    );
    const tools = (this.ctx.exports as unknown as {
      CodeModeToolsBinding: (options: { props: CodeModeToolsProps }) => unknown;
    }).CodeModeToolsBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        threadId: request.threadId,
        parentToolUseId: request.toolUseId,
        allowWebTools: false,
      },
    });
    const ai = (this.ctx.exports as unknown as {
      AIVirtualBinding: (options: { props: AIVirtualBindingProps }) => unknown;
    }).AIVirtualBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
      },
    });
    const camelai = (this.ctx.exports as unknown as {
      CamelAiService: (options: { props: AIVirtualBindingProps }) => unknown;
    }).CamelAiService({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
      },
    });
    const secureFetch = (this.ctx.exports as unknown as {
      SecureFetchBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
    }).SecureFetchBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
      },
    });
    const screenshot = (this.ctx.exports as unknown as {
      AppScreenshotBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
    }).AppScreenshotBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
      },
    });
    const appBrowser = (this.ctx.exports as unknown as {
      AppBrowserBinding: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
    }).AppBrowserBinding({
      props: {
        orgId: request.orgId,
        workspaceId: request.workspaceId,
      },
    });

    const workerCode: WorkerLoaderWorkerCode = {
      compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: codeModeWorkerModule(code) },
      },
      env: { TOOLS: tools, AI: ai, CAMELAI: camelai, SECURE_FETCH: secureFetch, SCREENSHOT: screenshot, BROWSER: appBrowser },
    };
    const worker = typeof loader.load === "function"
      ? loader.load(workerCode)
      : loader.get(`pi-codemode-${crypto.randomUUID()}`, () => workerCode);
    const runner = worker.getEntrypoint("CodeModeRunner") as unknown as {
      run(timeoutMs: number, maxTimeoutMs: number): Promise<{ text?: unknown }>;
    };
    const result = await runner.run(timeoutMs, CODE_MODE_MAX_TIMEOUT_MS);
    return {
      text: truncateCodeModeText(result.text ?? "", maxOutputCharacters),
    };
  }

  // Code-mode artifact buffer collaborator (see
  // chat-thread-code-mode-artifacts.ts). All state stays in this DO's KV
  // storage and stream-bridge fields, and the memoized collaborator's deps
  // arrows close over `this` so a fake with stubbed siblings behaves exactly
  // as when the bodies lived here. The public RPC wrappers
  // (recordCodeModeArtifact / consumeCodeModeArtifacts) stay on the DO.
  private get codeModeArtifacts(): ChatThreadCodeModeArtifacts {
    return (this.codeModeArtifactsInstance ??= new ChatThreadCodeModeArtifacts({
      kv: () => this.ctx.storage.kv,
      piChunkEncoder: () => this.piChunkEncoder,
      enqueuePiStreamChunks: (chunks) => this.enqueuePiStreamChunks(chunks),
      setPreviewTarget: (target) => this.setPreviewTarget(target),
      deliverCodeModeArtifacts: (parentToolUseId, artifacts) =>
        this.deliverCodeModeArtifacts(parentToolUseId, artifacts),
      codeModeArtifactsKey: (parentToolUseId) =>
        this.codeModeArtifactsKey(parentToolUseId),
    }));
  }

  async recordCodeModeArtifact(
    parentToolUseId: string,
    artifact: RuntimeCallArtifact,
  ): Promise<void> {
    return this.codeModeArtifacts.recordCodeModeArtifact(parentToolUseId, artifact);
  }

  private deliverCodeModeArtifacts(
    parentToolUseId: string,
    artifacts: RuntimeCallArtifact[],
  ): void {
    this.codeModeArtifacts.deliverCodeModeArtifacts(parentToolUseId, artifacts);
  }

  async consumeCodeModeArtifacts(
    parentToolUseId: string,
    options: { deleteAfterRead?: boolean } = {},
  ): Promise<RuntimeCallArtifact[]> {
    return this.codeModeArtifacts.consumeCodeModeArtifacts(parentToolUseId, options);
  }

  private codeModeArtifactsKey(parentToolUseId: string): string {
    return this.codeModeArtifacts.codeModeArtifactsKey(parentToolUseId);
  }

  private get projectActivity(): ChatThreadProjectActivity {
    return (this.projectActivityInstance ??= new ChatThreadProjectActivity({
      kv: () => this.ctx.storage.kv,
    }));
  }

  async recordProjectActivity(input: {
    projectId: string;
    activityType: ThreadProjectActivityType;
  }): Promise<void> {
    this.projectActivity.recordProjectActivity({
      projectId: input.projectId,
      activityType: input.activityType,
      lastUsedAt: Date.now(),
    });
  }

  async listProjectActivity(): Promise<ThreadProjectActivity[]> {
    return this.projectActivity.listProjectActivity();
  }

  override async onStart(props?: unknown): Promise<void> {
    const phase = this.startChatMemoryPhase("on_start");
    try {
      await this.withChatMemoryPhase("stream_reconstruct", async () => {
        await super.onStart?.(props as never);
      });
      this.hydrateDurableStateOnce();
      // super.onStart already let ai-chat evaluate recovery budgets and establish
      // any incident/stream for an interrupted turn, so it is now safe to clear a
      // marker that ai-chat is provably NOT recovering (an old→new deploy orphan).
      await this.sweepOrphanedActiveTurnMarker();
      // PartyServer name bootstrap happens before onStart, not in the constructor.
      // syncAgentState() calls setState(), which emits through PartyServer and needs
      // this.name; doing it here keeps cold-wake state fresh without crashing stale
      // alarm/RPC wakes that haven't initialized the PartyServer name yet.
      this.syncAgentState();
      this.endChatMemoryPhase(phase, "end", true);
    } catch (error) {
      this.endChatMemoryPhase(phase, "error", true);
      throw error;
    }
  }

  override async persistMessages(
    messages: UIMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean },
  ): Promise<void> {
    return this.withChatMemoryPhase("render_persist_reconcile", () =>
      super.persistMessages(messages, excludeBroadcastIds, options),
    );
  }

  /**
   * Clear an active-turn marker whose turn is provably dead — nothing owns it and
   * nothing will re-drive it — so {@link isThreadStreaming} (and the workspace
   * thread-list "running" row finishTurn clears) can't report a dead turn as busy
   * forever. Two orphan sources: a marker written by the pre-ai-chat fiber
   * machinery across the old→new recovery boundary (commit 7), and a marker
   * stranded by an ai-chat recovery that gave up SILENTLY — the framework marks
   * its incident "skipped" (conversation_changed / no_unanswered_user_message /
   * continueLastTurn with no assistant) and returns without any app callback, so
   * no terminal path ever clears the marker. Runs at wake (after super.onStart)
   * AND on the page-open reads (getUiMessages, onConnect): a warm isolate never
   * re-runs onStart, so a marker stranded on an alarm wake would otherwise stick
   * for the isolate's whole lifetime — exactly the "thread stuck loading on open"
   * symptom. Clears the marker + journal ONLY when the turn is provably not
   * going to be recovered: no live Pi stream, no pending prompt, no onChatMessage
   * in flight, ai-chat has no active recovery incident
   * (detected/scheduled/attempting) and no non-stale recovering flag, and the
   * marker is not freshly opened (guards a same-wake race with a just-started
   * turn). Fails safe — any read error leaves the marker untouched.
   */
  private async sweepOrphanedActiveTurnMarker(): Promise<void> {
    let marker: PiActiveTurnMarker | null;
    try {
      marker = this.readPiActiveTurn();
    } catch {
      return;
    }
    if (!marker) return;
    // A live/starting turn legitimately owns the marker.
    if (this.piSession?.state.isStreaming) return;
    if (this.activePiStreamTurnId || this.pendingPiPromptQueue.length > 0) return;
    // Only sweep a marker old enough that it cannot be a turn starting on this
    // same wake (the stall timeout is a comfortable floor).
    if (Date.now() - marker.openedAt < PI_TURN_INACTIVITY_TIMEOUT_MS) return;
    // ai-chat still intends to recover this turn — leave it alone.
    if (this.hasActiveChatRecovery()) return;

    this.recordChatThreadObservabilityEvent("pi_turn_marker_swept", {
      operation: "sweep_orphan_marker",
      status: "cleared",
      severity: "warn",
    });
    await this.clearPiActiveTurnAndJournal();
    this.finishTurn();
    this.setActiveTurnUserId(null);
  }

  /**
   * True when ai-chat has an in-flight recovery for the current turn — a recovery
   * incident in an active state (detected/scheduled/attempting) or a non-stale
   * `recovering` flag. Reads ai-chat's own durable bookkeeping (keys imported
   * from agents/chat) through the sync SQLite-backed KV API.
   * Fails safe: on any read error, assume a recovery may be pending (return true)
   * so the sweep never clears a turn ai-chat could still resume.
   */
  private hasActiveChatRecovery(): boolean {
    try {
      const recovering = this.ctx.storage.kv.get<{ at?: number }>(
        CHAT_RECOVERING_KEY,
      );
      if (
        recovering &&
        typeof recovering === "object" &&
        Date.now() - (recovering.at ?? 0) < CHAT_RECOVERING_FLAG_TTL_MS
      ) {
        return true;
      }
      for (const [, incident] of this.ctx.storage.kv.list<{ status?: unknown }>({
        prefix: CHAT_RECOVERY_INCIDENT_KEY_PREFIX,
      })) {
        const status = incident?.status;
        if (
          typeof status === "string" &&
          ACTIVE_CHAT_RECOVERY_STATUSES.has(status)
        ) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error(
        "[ChatThreadDO] failed to read chat recovery state for marker sweep",
        error,
      );
      return true;
    }
  }

  /**
   * The single source of truth for the client loading indicator, DERIVED on read.
   * A turn is "working" iff pi-core is live in this isolate OR an active-turn marker
   * exists. The marker is written synchronously at turn start and cleared by every
   * terminal path (agent_end / resume completion / error cleanup); it survives
   * eviction, so a cold wake still reads busy across the gap between the SDK deleting
   * the recovered fiber row and the scheduled resume running — which also stops a new
   * turn from racing the pending resume. Because nothing sets a separate spinner
   * flag, there's no clear-site to forget; a genuinely hung turn keeps pi-core live
   * (the inactivity timeout's job, not a desync).
   */
  private isThreadStreaming(): boolean {
    if (this.piSession?.state.isStreaming) return true;
    // This derive is called on every state sync; never let a storage read throw.
    try {
      return this.readPiActiveTurn() !== null;
    } catch {
      return false;
    }
  }

  private sendRenderHistoryToConnection(connection: Connection): void {
    if (this.messages.length === 0) return;
    try {
      connection.send(
        JSON.stringify({
          messages: this.messages,
          type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
        }),
      );
    } catch (error) {
      // A socket that closed while background reconciliation ran will reconnect.
      console.error("[ChatThreadDO] failed to send render history on connect", error);
    }
  }

  private async reconcileConnectedClient(connection: Connection): Promise<void> {
    const startedAt = Date.now();
    try {
      // None of these repairs belongs on the HTTP 101 critical path. Run them in
      // order because the mirror top-up must precede legacy metadata healing.
      await this.sweepOrphanedActiveTurnMarker();
      await this.topUpUiMessagesFromPiCore();
      await this.healLegacyUiMessageTimes();
      await this.healLegacyUiMessageAuthors();
      // Repair path for the lake export: catches rows whose post-commit sync was
      // lost to an eviction or a stream failure, and backfills threads whose
      // history predates the export entirely.
      this.scheduleTranscriptLakeSync();

      if (!this.isThreadStreaming() && this.currentTodos.length > 0) {
        // This syncs a completed-todo override; do not overwrite it afterward.
        await this.completeTodoStateForTurnEnd();
      } else {
        this.syncAgentState();
      }
      this.sendRenderHistoryToConnection(connection);
      this.recordChatThreadObservabilityEvent("chat_ws_connect_background_repair", {
        operation: "reconcile_connected_client",
        status: "completed",
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      console.error("[ChatThreadDO] background connect reconciliation failed", error);
      this.recordChatThreadObservabilityEvent("chat_ws_connect_background_repair", {
        operation: "reconcile_connected_client",
        status: "failed",
        severity: "error",
        durationMs: Date.now() - startedAt,
      });
      // Still deliver the best state/history currently available. A later
      // connection or getUiMessages read retries idempotent repairs.
      this.syncAgentState();
      this.sendRenderHistoryToConnection(connection);
    }
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const url = new URL(ctx.request.url);
    const incomingOrgId = url.searchParams.get("orgId")?.trim() || "";
    if (
      this.chatContext?.orgId &&
      incomingOrgId &&
      this.chatContext.orgId !== incomingOrgId
    ) {
      connection.close(1008, "forbidden");
      return;
    }

    const upgradeUserId = ctx.request.headers.get(HEADER_USER_ID)?.trim() || "";
    const authDegraded =
      ctx.request.headers.get(HEADER_AUTH_DEGRADED)?.trim() === "1";
    if (authDegraded) {
      if (
        !upgradeUserId ||
        !this.chatContext ||
        !this.isPreviouslyAuthorizedChatUser(upgradeUserId)
      ) {
        // Cannot verify right now (or no prior grant) — not an authoritative
        // denial. 1013 keeps the client retrying full auth once DOs recover
        // instead of a permanent false "no access" terminal close.
        connection.close(1013, "auth_temporarily_unavailable");
        return;
      }
    } else if (upgradeUserId) {
      this.recordAuthorizedChatUser(upgradeUserId);
    }

    this.captureChatContextFromRequest(url, ctx.request, connection);

    // Keep the handshake path synchronous and bounded: publish the currently
    // available state/history, then reconcile durable truth after the 101.
    this.syncAgentState();
    this.sendRenderHistoryToConnection(connection);
    this.ctx.waitUntil(
      Promise.resolve()
        .then(() => this.reconcileConnectedClient(connection))
        .catch((error) => {
          // Defensive catch: reconcileConnectedClient already catches all repair
          // failures, but never leave a floating rejection on lifecycle work.
          console.error("[ChatThreadDO] connect background task failed", error);
        }),
    );

    const avatarThreadId = this.chatContext?.threadId ?? "";
    if (avatarThreadId) {
      this.ctx.waitUntil(
        Promise.resolve()
          .then(() => this.maybeGenerateChatGroupAvatarForThread(avatarThreadId))
          .catch((error) => {
            console.error("[ChatThreadDO] background chat-group avatar generation failed", error);
          }),
      );
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return super.fetch(request);
    }

    // HTTP API for setting preview state
    if (url.pathname === "/preview" && request.method === "POST") {
      const body = (await request.json()) as {
        target?: PreviewTarget | null;
        tabs?: PreviewTarget[];
        activeTabId?: string | null;
      };
      if (Array.isArray(body.tabs) || body.activeTabId !== undefined) {
        await this.setPreviewTabsStateInternal(
          body.tabs ?? [],
          body.activeTabId ?? null,
        );
      } else {
        await this.setPreviewTarget(body.target ?? null);
      }
      return new Response(
        JSON.stringify({
          target: this.previewTarget,
          tabs: this.previewTabs,
          activeTabId: this.previewActiveTabId,
          version: this.previewVersion,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url.pathname === "/preview" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          target: this.previewTarget,
          tabs: this.previewTabs,
          activeTabId: this.previewActiveTabId,
          version: this.previewVersion,
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response("Not found", { status: 404 });
  }

  async onMessage(
    _ws: Connection,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") return;

    let data: { type: string; [key: string]: unknown };
    try {
      data = JSON.parse(message) as { type: string; [key: string]: unknown };
    } catch {
      return;
    }

    try {
      // Browser commands use Agents SDK callables. Chronological chat data is
      // pushed server-to-client only; reload/reconnect recovery comes from
      // Agents SDK state sync.

    } catch (err) {
      this.emitChatError(
        `Internal error handling ${data.type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onClose(): Promise<void> {
    if (
      this.getChatSockets().length === 0 &&
      this.browserPrompts.pendingQuestionCount > 0
    ) {
      this.ctx.waitUntil(
        this.autoAnswerAllPendingQuestionsAsUnavailable(
          ASK_USER_QUESTION_UNAVAILABLE_MESSAGE,
        ),
      );
    }
  }

  getPreviewTarget(): PreviewTarget | null {
    return this.previewTarget;
  }

  getPiCoreMessageRows(limit = 200): PiCoreMessageRow[] {
    const resolvedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(2000, Math.floor(limit)))
      : 200;

    return this.ctx.storage.sql
      .exec<{ idx: number; payload: string; created_at: number }>(
        "SELECT idx, payload, created_at FROM pi_core_messages ORDER BY idx DESC LIMIT ?",
        resolvedLimit,
      )
      .toArray()
      .reverse()
      .map((row) => {
        try {
          const parsed = JSON.parse(row.payload);
          return {
            ...row,
            payload: JSON.stringify(this.piCoreStore.renderPiStoredImageReferences(parsed)),
          };
        } catch {
          return row;
        }
      });
  }

  async repairPiCoreMessageHistory(input: {
    mode?: "dry_run" | "repair";
  } = {}): Promise<PiCoreMessageHistoryRepairReport> {
    const mode = input.mode ?? "dry_run";
    if (mode !== "dry_run" && mode !== "repair") {
      throw new Error("mode must be dry_run or repair");
    }

    this.ensurePiCoreTables();
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_core_messages ORDER BY idx ASC",
      )
      .toArray();
    const messages: AgentMessage[] = [];
    let invalidRows = 0;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          // Repair identities/order only; provider image bytes are irrelevant.
          messages.push(sanitizePiModelMessage(parsed));
        } else {
          invalidRows += 1;
        }
      } catch {
        invalidRows += 1;
      }
    }

    const repaired = repairPiMessageHistoryForReplay(messages);
    const changed = invalidRows > 0 || repaired.repairedCount > 0;
    const afterMessages = changed ? repaired.messages : messages;

    if (mode === "repair" && changed) {
      await this.replacePiCoreMessages(afterMessages, { uiRender: "rebuild" });
    }

    return {
      ok: true,
      mode,
      persisted: mode === "repair" && changed,
      changed,
      beforeCount: rows.length,
      validBeforeCount: messages.length,
      afterCount: afterMessages.length,
      invalidRows,
      repairedCount: repaired.repairedCount,
      stats: repaired.stats,
    };
  }

  async putPiCoreMessageRow(input: {
    idx: number;
    payload: string;
    created_at?: number;
  }): Promise<{ ok: true; inserted: boolean; idx: number }> {
    const idx = Math.floor(input.idx);
    if (!Number.isFinite(idx) || idx < 0) {
      throw new Error("idx must be a non-negative integer");
    }

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(input.payload);
    } catch {
      throw new Error("payload must be valid JSON");
    }
    const serialized = await this.serializePiMessageForSqlStorageDetailed(parsedPayload as AgentMessage);
    const normalizedPayload = serialized.payload;
    const createdAt = Number.isFinite(input.created_at)
      ? Math.floor(input.created_at as number)
      : Date.now();

    const existing = this.ctx.storage.sql
      .exec<{ idx: number }>("SELECT idx FROM pi_core_messages WHERE idx = ?", idx)
      .one();

    if (existing) {
      this.ctx.storage.sql.exec(
        "UPDATE pi_core_messages SET payload = ?, created_at = ? WHERE idx = ?",
        normalizedPayload,
        createdAt,
        idx,
      );
      this.piCoreStore.markPiCoreChanged(this.piCoreStore.getPiCoreRevision().count);
      return { ok: true, inserted: false, idx };
    }

    this.ctx.storage.sql.exec(
      "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
      idx,
      normalizedPayload,
      createdAt,
    );
    this.piCoreStore.markPiCoreChanged(this.piCoreStore.getPiCoreRevision().count + 1);
    return { ok: true, inserted: true, idx };
  }

  getPreviewState(): {
    target: PreviewTarget | null;
    tabs: PreviewTarget[];
    activeTabId: string | null;
    version: number;
  } {
    return {
      target: this.previewTarget,
      tabs: this.previewTabs,
      activeTabId: this.previewActiveTabId,
      version: this.previewVersion,
    };
  }

  async setPreviewTarget(target: PreviewTarget | null): Promise<void> {
    const previousActiveTabId = this.previewActiveTabId;
    const normalizedTarget = this.normalizePreviewTarget(target);
    if (!normalizedTarget) {
      this.previewTabs = [];
      this.previewActiveTabId = null;
      this.previewTarget = null;
      this.previewVersion++;
      this.persistPreviewState();
      this.syncAgentState();
      return;
    }

    const id = this.getPreviewTabId(normalizedTarget);
    const existingIndex = this.previewTabs.findIndex(
      (tabTarget) => this.getPreviewTabId(tabTarget) === id,
    );
    if (existingIndex >= 0) {
      this.previewTabs = this.previewTabs.map((tabTarget, index) =>
        index === existingIndex ? normalizedTarget : tabTarget,
      );
    } else {
      this.previewTabs = [...this.previewTabs, normalizedTarget];
    }
    this.previewActiveTabId = id;
    this.previewTarget = normalizedTarget;
    this.previewVersion++;
    this.persistPreviewState();
    if (previousActiveTabId === id) {
      this.syncAgentState({ previewRefreshTabId: id });
      this.syncAgentState({ previewRefreshTabId: null });
    } else {
      this.syncAgentState();
    }
  }

  async setPreviewTabsState(
    tabs: PreviewTarget[],
    activeTabId: string | null,
  ): Promise<void> {
    if (!this.chatContext) throw new Error("Missing chat context");
    const ok = await this.setPreviewTabsStateInternal(
      tabs,
      activeTabId,
      this.chatContext.workspaceId,
    );
    if (!ok) throw new Error("Invalid preview target workspace");
  }

  async requestStop(): Promise<void> {
    await this.ensurePiSessionReady();
    this.sendRunnerCommand({ type: "stop", threadId: this.chatContext?.threadId });
  }

  async answerQuestion(
    questionId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    if (!questionId || !answers || typeof answers !== "object") {
      throw new Error("Missing questionId or answers");
    }

    if (this.browserPrompts.answerQuestion({ questionId, answers })) {
      return;
    }

    this.sendRunnerCommand({
      type: "question_response",
      questionId,
      answers,
      userId: this.chatContext?.userId ?? undefined,
    });
  }

  async submitConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<void> {
    const result = await this.handleConnectionSetupResponse(response);
    if (!result.accepted) {
      throw new Error(
        "Connection setup request is no longer pending. Please ask the agent to start connection setup again.",
      );
    }
  }

  async refreshModel(): Promise<void> {
    await this.refreshPiSessionModel();
  }

  async sendMessage(
    content: string,
    clientMessageId: string,
  ): Promise<InitialUserMessageResult> {
    return this.handleClientUserMessage({ content, clientMessageId });
  }

  private async setPreviewTabsStateInternal(
    tabs: PreviewTarget[],
    activeTabId: string | null,
    expectedWorkspaceId?: string,
  ): Promise<boolean> {
    const normalizedState = this.normalizePreviewTabsState(
      tabs,
      activeTabId,
      expectedWorkspaceId,
    );
    if (!normalizedState) {
      return false;
    }

    this.previewTabs = normalizedState.tabs;
    this.previewActiveTabId = normalizedState.activeTabId;
    this.previewTarget = normalizedState.target;
    this.previewVersion++;
    this.persistPreviewState();
    this.syncAgentState();
    return true;
  }

  async clearPreviewTarget(): Promise<void> {
    await this.setPreviewTarget(null);
  }

  async setPreviewAppVisibility(
    scriptName: string,
    isPublic: boolean,
  ): Promise<void> {
    let tabsChanged = false;
    const nextTabs = this.previewTabs.map((tabTarget) => {
      if (tabTarget.kind !== "app" || tabTarget.scriptName !== scriptName) {
        return tabTarget;
      }
      if (tabTarget.isPublic === isPublic) {
        return tabTarget;
      }
      tabsChanged = true;
      return { ...tabTarget, isPublic };
    });

    let targetChanged = false;
    let nextTarget = this.previewTarget;
    if (
      nextTarget?.kind === "app" &&
      nextTarget.scriptName === scriptName &&
      nextTarget.isPublic !== isPublic
    ) {
      targetChanged = true;
      nextTarget = {
        ...nextTarget,
        isPublic,
      };
    }

    if (!tabsChanged && !targetChanged) {
      return;
    }

    this.previewTabs = nextTabs;
    this.previewTarget = nextTarget;

    this.persistPreviewState(false);
    this.syncAgentState();
  }

  // Set latest thread metadata for connected chat clients.
  async setTitle(title: string, updatedAt?: number): Promise<void> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    this.currentTitle = normalizedTitle;
    this.currentTitleUpdatedAt =
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? updatedAt
        : Date.now();
    this.syncAgentState();
  }

  async generateChatGroupAvatarForThread(context: {
    threadId: string;
    workspaceId: string;
    orgId: string;
    userId?: string | null;
  }): Promise<void> {
    const error = this.updateExternalChatContext(context);
    if (error) {
      console.warn("[ChatThreadDO] skipping chat group avatar generation", {
        reason: "invalid_context",
        threadId: context.threadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
      });
      return;
    }
    await this.maybeGenerateChatGroupAvatarForThread(
      context.threadId,
      "first_title",
    );
  }

  async setModel(model: LlmModel, updatedAt?: number): Promise<void> {
    this.currentThreadModel = model;
    this.currentThreadModelUpdatedAt =
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? updatedAt
        : Date.now();
    this.modelFallbackNotice = null;
    this.syncAgentState();
  }

  async setTodoState(todos: unknown[]): Promise<void> {
    this.currentTodos = Array.isArray(todos) ? normalizeTodoItems(todos) : [];
    if (this.currentTodos.length > 0) {
      this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
    } else {
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.syncAgentState();
  }

  getTodoState(): unknown[] {
    if (this.currentTodos.length > 0) {
      return cloneDurableState(this.currentTodos);
    }

    const storedTodos = this.ctx.storage.kv.get<unknown[]>(CHAT_TODOS_KEY);
    if (!Array.isArray(storedTodos) || storedTodos.length === 0) {
      return [];
    }

    this.currentTodos = normalizeTodoItems(storedTodos);
    return cloneDurableState(this.currentTodos);
  }

  async askUserQuestion(input: {
    questions?: unknown[];
    toolUseId?: string;
  }): Promise<Record<string, unknown>> {
    const pendingBefore = this.browserPrompts.pendingQuestionCount;
    const result = this.browserPrompts.askUserQuestion(input);
    if (this.browserPrompts.pendingQuestionCount > pendingBefore) {
      const pending = this.browserPrompts.getOldestPendingQuestion();
      const question = pending?.questions[0]?.question ?? null;
      this.updateActiveAutomationRun({
        status: "question",
        message: question,
        completedAt: null,
      });
    }
    return result;
  }

  getRuntimeStatus(): ChatThreadRuntimeStatus {
    const pending = this.browserPrompts.getOldestPendingQuestion();
    const isStreaming = this.isThreadStreaming();
    return {
      isStreaming,
      pendingQuestionCount: this.browserPrompts.pendingQuestionCount,
      oldestPendingQuestion: pending?.questions[0]?.question ?? null,
      updatedAt:
        isStreaming || this.browserPrompts.pendingQuestionCount > 0
          ? Date.now()
          : null,
    };
  }

  async promptConnectionSetup(input: {
    integrationId?: string;
    integrationType: string;
    suggestedName?: string;
    message?: string;
    instructions?: string;
    initialConfig?: Record<string, unknown>;
    initialCredentials?: Record<string, unknown>;
    dynamicSchema?: DynamicIntegrationSchema;
  }): Promise<ConnectionSetupResponse> {
    return this.browserPrompts.promptConnectionSetup(input);
  }

  async receiveConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    return this.handleConnectionSetupResponse(response);
  }

  async runCodeModeSubagent(
    toolName: "Agent" | "Explore",
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const baseContext = this.chatContext;
    const context = baseContext ?? {
      threadId: this.ctx.id.toString(),
      workspaceId: "",
      orgId: "",
      userId: null,
      userName: null,
      userEmail: null,
    };
    if (!context.threadId || !context.workspaceId || !context.orgId) {
      throw new Error("Subagent tools require chat thread, workspace, and org context");
    }
    return this.runPiSubagentTool(context, toolName, params);
  }

  async setBrowserTurnStreaming(isStreaming: boolean): Promise<void> {
    if (isStreaming) {
      this.markTurnStarted();
      return;
    }
    this.finishTurn({
      markUnread: true,
      completedAt: Date.now(),
      summarySource: null,
    });
  }

  async completeTodoStateForTurnEnd(): Promise<void> {
    if (this.currentTodos.length === 0) return;

    const completedTodos = this.currentTodos.map((todo) => {
      if (!todo || typeof todo !== "object") return todo;
      return {
        ...(todo as Record<string, unknown>),
        status: "completed",
      };
    });

    this.currentTodos = [];
    this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    this.syncAgentState({ currentTodos: completedTodos });
  }

  async getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]> {
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const parsed: AgentEvalParsedMessage[] = [];

    // The browser rebuilds live assistant/tool content from the replay buffer,
    // so only canonical persisted history is returned here.
    const storedMessages = await this.loadPiCoreMessages({
      includeUiMetadata: true,
      imagePolicy: "render",
    });
    storedMessages.forEach((message, index) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role === "toolResult") {
        attachPiToolResultToParsedMessages(parsed, record);
        return;
      }
      parsed.push(...piCoreMessageToParsedChatMessage(message, index, normalizedThreadId));
    });
    return parsed;
  }

  async getGroupNewChatRecentSource(threadId: string): Promise<{
    messages: AgentEvalParsedMessage[];
    projectActivity: ThreadProjectActivity[];
  }> {
    return {
      messages: await this.getPiCoreParsedMessages(threadId),
      projectActivity: await this.listProjectActivity(),
    };
  }

  async getAdminExplorerSummary(input: {
    userMessageCap?: number;
  } = {}): Promise<AdminExplorerThreadSummary> {
    const messages = await this.loadPiCoreMessages({
      includeUiMetadata: true,
      imagePolicy: "render",
    });
    return summarizeAdminExplorerThread(messages, {
      userMessageCap: input.userMessageCap,
      sessionModelId: this.piSession?.state.model?.id,
    });
  }

  async appendChannelHistoryEvent(
    input: ChannelHistoryEventRequest,
  ): Promise<ChannelHistoryEventResult> {
    const threadId =
      typeof input.threadId === "string" && input.threadId.trim()
        ? input.threadId.trim()
        : this.chatContext?.threadId || "";
    const channelKind =
      typeof input.channelKind === "string" && input.channelKind.trim()
        ? input.channelKind.trim()
        : "channel";
    const direction = input.direction === "inbound" ? "inbound" : "outbound";
    const sentAt = Number.isFinite(input.sentAt)
      ? Math.floor(Number(input.sentAt))
      : Date.now();
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const attachmentCount = Number.isFinite(input.attachmentCount)
      ? Math.max(0, Math.floor(Number(input.attachmentCount)))
      : 0;
    if (!threadId) {
      return { status: "error", error: "Missing thread id" };
    }
    if (!text && attachmentCount === 0) {
      return { status: "skipped" };
    }

    const providerMessageIds = Array.isArray(input.providerMessageIds)
      ? input.providerMessageIds
          .map((id) => (id === undefined || id === null ? "" : String(id).trim()))
          .filter(Boolean)
      : [];
    const lines = [
      "<camelai system message>",
      `A camelAI run sent an outbound ${channelKind} message to this channel at ${new Date(sentAt).toISOString()}.`,
    ];
    if (direction !== "outbound") {
      lines.push(`Direction: ${direction}.`);
    }
    if (input.sourceThreadId?.trim()) {
      lines.push(`Source thread: ${input.sourceThreadId.trim()}.`);
    }
    if (input.connectionId?.trim()) {
      lines.push(`Channel connection: ${input.connectionId.trim()}.`);
    }
    if (input.remoteConversationId?.trim()) {
      lines.push(`Remote conversation: ${input.remoteConversationId.trim()}.`);
    }
    if (providerMessageIds.length > 0) {
      lines.push(`Provider message ids: ${providerMessageIds.join(", ")}.`);
    }
    if (attachmentCount > 0) {
      lines.push(`Attachment count: ${attachmentCount}.`);
    }
    lines.push(
      "Treat this as already-delivered channel history. Do not resend it unless the user explicitly asks.",
    );
    if (text) {
      lines.push("", "Delivered message:", text);
    }
    lines.push("</camelai system message>");

    const channelSkeleton = text
      ? this.buildUserUiSkeleton({
          rawContent: text,
          channelHistory: true,
          piCoreMessageKey: sentAt,
        })
      : null;
    const message = withPiRenderMessageId(
      {
        role: "user" as const,
        content: lines.join("\n"),
        timestamp: sentAt,
      } satisfies AgentMessage,
      channelSkeleton?.id ?? null,
    );
    await this.appendPiCoreMessagesIfMissing([message]);
    // Mirror the channel event into the linear render history (commit 3b). A
    // direct linear append (persistMessages, not saveMessages) — this is history,
    // not a new agent turn.
    if (channelSkeleton) {
      this.ctx.waitUntil(
        this.persistMessages([...this.messages, channelSkeleton]).catch(
          (error) => {
            console.error(
              "[ChatThreadDO] failed to persist channel-history render message",
              error,
            );
          },
        ),
      );
    }
    const normalizedChannelKind = normalizeChannelIndicatorKind(channelKind);
    if (normalizedChannelKind) {
      await this.channelTools.markThreadChannelUsedBestEffort(
        {
          orgId: input.orgId || this.chatContext?.orgId,
          threadId,
        },
        normalizedChannelKind,
      );
    }

    const sessionState = this.piSession?.state as
      | { messages?: AgentMessage[]; isStreaming?: boolean }
      | undefined;
    if (
      sessionState &&
      !sessionState.isStreaming &&
      Array.isArray(sessionState.messages)
    ) {
      const key = piCoreMessageKey(message);
      const exists = sessionState.messages.some(
        (existing) => piCoreMessageKey(existing) === key,
      );
      if (!exists) {
        sessionState.messages.push(message);
        this.piMainBaselineIndex = Math.max(
          this.piMainBaselineIndex,
          sessionState.messages.length,
        );
      }
    }

    return { status: "appended" };
  }

  /**
   * Append a one-off camelAI system notice to this thread's model transcript.
   * The agent sees the `<camelai system message>`-wrapped row on its next
   * cold session build; `visibility: "hidden"` keeps it out of the browser
   * render history entirely (isInternalPiClientMessage). Intended for manual
   * post-migration injection via admin_js_exec; warm sessions pick it up on
   * their next rebuild (a worker deploy resets all sessions). Idempotent per
   * (text, sentAt) via appendPiCoreMessagesIfMissing.
   */
  async appendCamelSystemNotice(input: {
    text: string;
    sentAt?: number;
  }): Promise<{ status: "appended" | "skipped" }> {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return { status: "skipped" };
    const sentAt = Number.isFinite(input.sentAt)
      ? Math.floor(Number(input.sentAt))
      : Date.now();
    const message = {
      role: "user" as const,
      content: ["<camelai system message>", text, "</camelai system message>"].join("\n"),
      timestamp: sentAt,
      visibility: "hidden",
    } as AgentMessage;
    await this.appendPiCoreMessagesIfMissing([message]);
    return { status: "appended" };
  }

  async getPiCoreForkMessages(options: {
    forkEntryId: string;
    renderedMessageId?: string;
  }): Promise<ChatThreadPiCoreForkResult> {
    const messages = await this.loadPiCoreMessages({ imagePolicy: "reference" });
    if (messages.length === 0) {
      return {
        success: false,
        code: "NO_PI_CORE_MESSAGES",
        error: "Source thread has no Durable Object Pi messages",
      };
    }

    const targets = [options.forkEntryId, options.renderedMessageId]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    if (targets.length === 0) {
      return {
        success: false,
        code: "TARGET_NOT_FOUND",
        error: "Fork target is required",
      };
    }

    const targetIndex = messages.findIndex((message, index) => {
      const ids = piCoreForkMessageIds(message, index);
      return targets.some((target) => ids.includes(target));
    });
    if (targetIndex < 0) {
      return {
        success: false,
        code: "TARGET_NOT_FOUND",
        error: "Fork target not found in Durable Object Pi messages",
      };
    }

    const forkedMessages = cloneDurableState(messages.slice(0, targetIndex + 1));
    return {
      success: true,
      messages: forkedMessages,
      messageCount: forkedMessages.length,
    };
  }

  async replacePiCoreForkMessages(messages: AgentMessage[]): Promise<void> {
    const normalizedMessages = Array.isArray(messages)
      ? messages.filter((message): message is AgentMessage => {
          return Boolean(
            message &&
              typeof message === "object" &&
              "role" in (message as unknown as Record<string, unknown>),
          );
        })
      : [];
    if (normalizedMessages.length === 0) {
      throw new Error("Forked Pi message history is empty");
    }

    this.disposePiSession();
    await this.replacePiCoreMessages(cloneDurableState(normalizedMessages), {
      uiRender: "rebuild",
    });
    this.ctx.storage.sql.exec("DELETE FROM pi_core_compaction");
  }

  getForkStateSnapshot(): ChatThreadForkState {
    return {
      previewTarget: cloneDurableState(this.previewTarget),
      previewTabs: cloneDurableState(this.previewTabs),
      previewActiveTabId: this.previewActiveTabId,
      previewVersion: this.previewVersion,
      chatContext: cloneDurableState(this.chatContext),
      currentTodos: cloneDurableState(this.currentTodos),
      contextUsedPercent: this.contextUsedPercent,
      usageIsPostCompaction: this.usageIsPostCompaction,
      cachedContextWindowByModel: cloneDurableState(
        this.cachedContextWindowByModel,
      ),
    };
  }

  applyForkStateSnapshot(
    snapshot: ChatThreadForkState,
    target: ChatThreadForkStateTarget,
  ): void {
    const normalizedPreview =
      this.normalizePreviewTabsState(
        snapshot.previewTabs,
        snapshot.previewActiveTabId,
      ) ??
      this.normalizePreviewTabsState(
        snapshot.previewTarget ? [snapshot.previewTarget] : [],
        null,
      ) ?? {
        tabs: [],
        activeTabId: null,
        target: null,
      };

    this.previewTabs = normalizedPreview.tabs;
    this.previewActiveTabId = normalizedPreview.activeTabId;
    this.previewTarget = normalizedPreview.target;
    this.previewVersion =
      typeof snapshot.previewVersion === "number" &&
      Number.isFinite(snapshot.previewVersion)
        ? snapshot.previewVersion
        : 0;
    this.persistPreviewState(true);

    this.chatContext = snapshot.chatContext
      ? {
          ...snapshot.chatContext,
          threadId: target.threadId,
          workspaceId: target.workspaceId,
          orgId: target.orgId,
          userId: target.userId ?? snapshot.chatContext.userId ?? null,
        }
      : null;
    if (this.chatContext) {
      this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    } else {
      this.ctx.storage.kv.delete(CHAT_CONTEXT_KEY);
    }

    this.currentTodos = Array.isArray(snapshot.currentTodos)
      ? normalizeTodoItems(snapshot.currentTodos)
      : [];
    if (this.currentTodos.length > 0) {
      this.ctx.storage.kv.put(CHAT_TODOS_KEY, this.currentTodos);
    } else {
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }

    this.contextUsedPercent =
      typeof snapshot.contextUsedPercent === "number" &&
      Number.isFinite(snapshot.contextUsedPercent)
        ? Math.max(0, Math.min(100, Math.round(snapshot.contextUsedPercent)))
        : null;
    if (this.contextUsedPercent !== null) {
      this.ctx.storage.kv.put(
        CHAT_CONTEXT_USED_PERCENT_KEY,
        this.contextUsedPercent,
      );
    } else {
      this.ctx.storage.kv.delete(CHAT_CONTEXT_USED_PERCENT_KEY);
    }

    this.usageIsPostCompaction =
      typeof snapshot.usageIsPostCompaction === "boolean"
        ? snapshot.usageIsPostCompaction
        : true;
    this.cachedContextWindowByModel = {};
    for (const [model, contextWindow] of Object.entries(
      snapshot.cachedContextWindowByModel ?? {},
    )) {
      if (
        typeof contextWindow === "number" &&
        Number.isFinite(contextWindow) &&
        contextWindow > 0
      ) {
        this.cachedContextWindowByModel[model] = contextWindow;
      }
    }
    this.ctx.storage.kv.put(
      CHAT_CONTEXT_WINDOW_BY_MODEL_KEY,
      this.cachedContextWindowByModel,
    );

    this.setActiveAutomationRun(null);
    this.browserPrompts.clearQuestions();
    this.titleGenerationInFlight = false;
    this.activeTurnUserId = null;
    this.ctx.storage.kv.delete(CHAT_ACTIVE_TURN_USER_ID_KEY);
  }

  getActiveTurnUserId(): string | null {
    return this.activeTurnUserId;
  }

  // Automation-run state machine collaborator (see
  // chat-thread-automation-run.ts). All state stays on this DO (the
  // activeAutomationRun field + its KV mirror), and the memoized deps
  // arrows close over `this` so a fake with stubbed siblings behaves exactly
  // as when the bodies lived here.
  private get automationRun(): ChatThreadAutomationRun {
    return (this.automationRunInstance ??= new ChatThreadAutomationRun({
      env: () => this.env,
      kv: () => this.ctx.storage.kv,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      activeAutomationRun: () => this.activeAutomationRun,
      setActiveAutomationRunField: (value) => {
        this.activeAutomationRun = value;
      },
      isThreadStreaming: () => this.isThreadStreaming(),
      pendingBrowserQuestionCount: () => this.browserPrompts.pendingQuestionCount,
      setActiveAutomationRun: (value) => this.setActiveAutomationRun(value),
      recordScheduledAutomationRun: (run, input) =>
        this.recordScheduledAutomationRun(run, input),
      updateActiveAutomationRun: (input) => this.updateActiveAutomationRun(input),
    }));
  }

  private normalizeActiveAutomationRun(
    value: unknown,
  ): ActiveAutomationRunState | null {
    return this.automationRun.normalizeActiveAutomationRun(value);
  }

  private setActiveAutomationRun(
    value: ActiveAutomationRunState | null,
  ): void {
    this.automationRun.setActiveAutomationRun(value);
  }

  private recordScheduledAutomationRun(
    run: ActiveAutomationRunState,
    input: {
      status: "success" | "error" | "question" | "busy";
      message?: string | null;
      completedAt?: number | null;
    },
  ): Promise<boolean> {
    return this.automationRun.recordScheduledAutomationRun(run, input);
  }

  private updateActiveAutomationRun(
    input: {
      status: "success" | "error" | "question" | "busy";
      message?: string | null;
      completedAt?: number | null;
      clear?: boolean;
    },
  ): void {
    this.automationRun.updateActiveAutomationRun(input);
  }

  private reconcileInactiveAutomationRun(reason: string): boolean {
    return this.automationRun.reconcileInactiveAutomationRun(reason);
  }

  private setActiveTurnUserId(userId: string | null | undefined): void {
    const normalizedUserId =
      typeof userId === "string" && userId.trim() ? userId.trim() : null;
    const currentUserId = this.activeTurnUserId ?? null;
    if (currentUserId === normalizedUserId) {
      return;
    }

    this.activeTurnUserId = normalizedUserId;
    if (normalizedUserId) {
      this.ctx.storage.kv.put(CHAT_ACTIVE_TURN_USER_ID_KEY, normalizedUserId);
    } else {
      const kvStore = this.ctx.storage.kv as {
        put: (key: string, value: string) => unknown;
        delete?: (key: string) => unknown;
      };
      if (typeof kvStore.delete === "function") {
        kvStore.delete(CHAT_ACTIVE_TURN_USER_ID_KEY);
      } else {
        kvStore.put(CHAT_ACTIVE_TURN_USER_ID_KEY, "");
      }
    }

  }

  /**
   * Apply a mid-thread config change (model or BYOK provider/credentials) by
   * rebuilding the session: model + provider routing are baked in at creation, so a
   * cache refresh alone doesn't reach an in-flight turn. Disposing aborts the
   * in-flight prompt (onChatMessage swallows the AbortError, leaving the active-turn
   * marker set), and the interrupted turn is re-driven through ai-chat's recovery
   * entry points so its resume streams into the same assistant message.
   */
  private async rebuildPiSessionForConfigChange(lockLabel: string): Promise<void> {
    await this.withRunnerTransitionLock(lockLabel, async () => {
      const wasStreaming = this.isThreadStreaming();
      this.disposePiSession();
      if (wasStreaming) {
        // Fire-and-forget so the transition lock isn't held for the whole resumed
        // turn; ai-chat's turn queue serializes it behind the aborted turn's close.
        this.ctx.waitUntil(
          this.driveConfigChangeResume().catch((error) => {
            console.error("[ChatThreadDO] config-change resume failed", error);
          }),
        );
      }
    });
  }

  /**
   * Re-drive the interrupted turn after a config-change dispose through ai-chat's
   * recovery entry points (both re-enter onChatMessage's resume branch, which
   * rebuilds the session with the new config and folds the journal). Mirrors
   * ai-chat's own retry-vs-continue classification so the resumed output never
   * merges into a prior turn's bubble: continue when this turn already persisted a
   * partial assistant (last-assistant id === the marker's stream id), otherwise
   * retry from the trailing user message (a fresh assistant under the same id).
   */
  private async driveConfigChangeResume(): Promise<void> {
    const marker = this.readPiActiveTurn();
    if (!marker) return;
    const lastAssistant = [...this.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const agent = this as unknown as {
      continueLastTurn(): Promise<{ status: string }>;
      _retryLastUserTurn(
        clientTools?: unknown,
        body?: unknown,
      ): Promise<{ status: string }>;
    };
    const result =
      lastAssistant && lastAssistant.id === marker.turnId
        ? await agent.continueLastTurn()
        : await agent._retryLastUserTurn();
    if (result.status === "skipped") {
      // The recovery entry point declined to re-drive (no continuable assistant
      // / no unanswered user leaf / conversation changed). Nothing else observes
      // that outcome, so without cleanup the active-turn marker would keep the
      // thread "busy" forever. Close the turn out the same way the exhausted
      // path does.
      this.recordChatThreadObservabilityEvent("pi_turn_resume_skipped", {
        operation: "config_change_resume",
        status: "skipped",
        severity: "warn",
      });
      await this.clearPiActiveTurnAndJournal();
      this.finishTurn();
      this.setActiveTurnUserId(null);
      this.syncAgentState();
    }
  }

  async refreshRunnerConfig(): Promise<void> {
    await this.rebuildPiSessionForConfigChange("refresh_runner_config");
  }

  async byokChanged(): Promise<void> {
    // Drop the cached provider config so the rebuilt session reads the new values.
    this.cachedLlmProviderConfig = null;
    await this.rebuildPiSessionForConfigChange("byok_changed");
  }

  private disposePiSession(): void {
    this.piUnsubscribe?.();
    this.piUnsubscribe = null;
    this.piModelResolver = null;
    this.clearPiToolKeepAliveInterval();
    try {
      this.piSession?.abort();
    } catch {
      // Best effort: the session may already be idle or torn down.
    }
    this.piSession = null;
    this.piMainBaselineIndex = 0;
    this.piSessionPromise = null;
    this.piEventHandlerChain = Promise.resolve();
    this.piActiveItemId = null;
    this.piAssistantText = "";
  }

  private clearPiToolKeepAliveInterval(): void {
    if (this.piToolKeepAliveInterval !== null) {
      clearInterval(this.piToolKeepAliveInterval);
      this.piToolKeepAliveInterval = null;
    }
  }

  // pi_core persistence (table DDL, R2 image/tool-result externalization, the
  // async SQLite serializer, and pi_core_messages / pi_core_compaction CRUD)
  // lives in ./chat-thread/pi-core-store; these thin delegates keep the
  // DO-internal call surface stable. The collaborator is cached for the
  // lifetime of this DO instance and owns its internal method composition; its
  // narrow storage/context capabilities continue to resolve live DO state.
  private get piCoreStore(): PiCoreMessageStore {
    return (this.piCoreStoreInstance ??= new PiCoreMessageStore({
      sql: () => this.ctx.storage.sql,
      r2: () => this.env.R2_BUCKET,
      chatContext: () => this.chatContext,
      takeToolDurationMs: (toolCallId) => this.takePiToolDurationMs(toolCallId),
    }));
  }

  private ensurePiCoreTables(): void {
    this.piCoreStore.ensurePiCoreTables();
  }

  private storePiFullToolResultInR2(
    toolName: string,
    toolCallId: string,
    text: string,
  ): Promise<PiR2ToolResultReference | undefined> {
    return this.piCoreStore.storePiFullToolResultInR2(toolName, toolCallId, text);
  }

  private async truncatePiToolResultForModel(
    context: AfterToolCallContext,
    options?: PiAfterToolCallOptions,
  ): Promise<AfterToolCallResult | undefined> {
    const content = Array.isArray(context.result.content)
      ? context.result.content
      : [];
    // Project before any truncation merge or persistence can serialize a second
    // copy of the model-visible payload under `details`.
    const projectedDetails = projectPiToolResultDetails(context.result.details) as
      AfterToolCallResult["details"];
    const textParts: string[] = [];
    const nonTextContent: AfterToolCallResult["content"] = [];
    const imageBlindModel = isPiImageBlindModel(
      options?.consumerModel ?? this.piSession?.state.model,
    );
    let omittedImageParts = 0;
    let omittedImageBytes = 0;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && typeof part.text === "string") {
        textParts.push(part.text);
      } else if (part.type === "image") {
        if (imageBlindModel) {
          omittedImageParts += 1;
          omittedImageBytes += typeof part.data === "string"
            ? Math.floor((part.data.length * 3) / 4)
            : 0;
        } else {
          nonTextContent.push(part);
        }
      }
    }
    if (textParts.length === 0 && omittedImageParts === 0) {
      return projectedDetails === context.result.details
        ? undefined
        : { content, details: projectedDetails };
    }

    const fullText = textParts.join(textParts.length > 1 ? "\n" : "");
    const inlineImages = imageBlindModel
      ? stripPiInlineImageDataUrls(fullText)
      : { text: fullText, count: 0, bytes: 0 };
    // camelCode threads have a vision-capable Oracle; redirect the agent there
    // exactly where its own image read failed.
    const imageOmissionRedirect = this.isCamelCodeActive()
      ? ". Delegate image understanding to the `Oracle` tool, passing this file path"
      : "";
    const imagePartNotice = omittedImageParts > 0
      ? `[${omittedImageParts} image tool result${omittedImageParts === 1 ? "" : "s"} omitted: ${omittedImageBytes} bytes; active model cannot inspect images${imageOmissionRedirect}]`
      : "";
    const modelText = [inlineImages.text, imagePartNotice]
      .filter(Boolean)
      .join("\n");
    const direction = PI_TAIL_TRUNCATED_TOOL_NAMES.has(context.toolCall.name)
      ? "tail"
      : "head";
    const truncated = truncatePiToolResultText(modelText, direction);
    if (!truncated.truncation && inlineImages.count === 0 && omittedImageParts === 0) {
      return projectedDetails === context.result.details
        ? undefined
        : { content, details: projectedDetails };
    }

    let fullOutput: PiR2ToolResultReference | undefined;
    if (truncated.truncation) {
      try {
        fullOutput = await this.storePiFullToolResultInR2(
          context.toolCall.name,
          context.toolCall.id,
          modelText,
        );
      } catch (error) {
        console.error("[ChatThreadDO] failed to store oversized Pi tool result in R2", error);
      }
    }

    const truncation = truncated.truncation
      ? { ...truncated.truncation, ...(fullOutput ? { fullOutput } : {}) }
      : undefined;

    return {
      content: [
        {
          type: "text",
          text: truncated.truncation
            ? `${truncated.content}\n\n${piToolResultTruncationNotice(truncation!)}`
            : truncated.content,
        },
        ...nonTextContent,
      ],
      details: mergePiToolResultDetails(projectedDetails, {
        ...(truncated.truncation && {
          [PI_TOOL_RESULT_R2_REF_METADATA_KEY]: fullOutput,
          truncation,
        }),
        ...(inlineImages.count > 0 || omittedImageParts > 0 ? {
          imageDataOmitted: {
            inlineDataUrls: inlineImages.count,
            imageParts: omittedImageParts,
            bytes: inlineImages.bytes + omittedImageBytes,
            reason: "active_model_cannot_inspect_images",
          },
        } : {}),
        originalTextBlockCount: textParts.length,
      }),
    };
  }

  private async afterPiToolCall(
    context: AfterToolCallContext,
    signal?: AbortSignal,
    options?: PiAfterToolCallOptions,
  ): Promise<AfterToolCallResult | undefined> {
    if (signal?.aborted) return undefined;
    try {
      const truncated = await this.truncatePiToolResultForModel(context, options);
      const repeatedFailure = ChatThreadDO.prototype.recordPiToolFailure.call(this, {
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.args,
        result: context.result,
        isError: context.isError,
      });
      const evidence = deriveVerifiedWorkEvidence({
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        args: context.args,
        result: context.result,
        isError: context.isError,
      });
      if (evidence) {
        ChatThreadDO.prototype.recordVerifiedWorkEvidence.call(this, evidence);
      }
      const retryBudgetReached = repeatedFailure !== null &&
        repeatedFailure.count >= repeatedFailure.limit;
      if (!retryBudgetReached && !evidence) return truncated;
      const content = truncated?.content ?? context.result.content;
      return {
        ...truncated,
        content: [
          ...content,
          ...(evidence ? [{
            type: "text" as const,
            text: `Completion evidence: ${JSON.stringify({
              status: evidence.status,
              supportedClaims: evidence.supportedClaims,
              unsupportedClaims: evidence.unsupportedClaims,
              target: evidence.target,
            })}`,
          }] : []),
          ...(retryBudgetReached ? [{
            type: "text" as const,
            text: `Recovery hint: this exact tool call exhausted its retry budget after ${repeatedFailure!.count} failed attempt(s). Change the arguments or approach; use tools.search/describe when the contract is unclear, and do not repeat this call.`,
          }] : []),
        ],
        details: mergePiToolResultDetails(
          truncated?.details ?? context.result.details,
          evidence ? { completionEvidence: evidence } : {},
        ),
      };
    } catch (error) {
      console.error("[ChatThreadDO] Pi afterToolCall hook failed", error);
      return undefined;
    }
  }

  recordVerifiedWorkEvidence(evidence: VerifiedWorkEvidence): void {
    const kv = this.ctx?.storage?.kv;
    if (!kv) return;
    const next = mergeVerifiedWorkState(
      kv.get<unknown>(CHAT_VERIFIED_WORK_STATE_KEY),
      evidence,
    );
    kv.put(CHAT_VERIFIED_WORK_STATE_KEY, next);
  }

  private piToolFailureKey(toolName: string, args: unknown): string {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    };
    try {
      return `${toolName}:${JSON.stringify(canonicalize(args))}`;
    } catch {
      return `${toolName}:${String(args)}`;
    }
  }

  private piToolFailureText(result: unknown, isError: boolean): string | null {
    const record = result && typeof result === "object" && !Array.isArray(result)
      ? result as Record<string, unknown>
      : undefined;
    const details = record?.details && typeof record.details === "object" && !Array.isArray(record.details)
      ? record.details as Record<string, unknown>
      : undefined;
    const failed = isError || details?.ok === false || details?.success === false ||
      details?.status === "failed" || details?.status === "error";
    if (!failed) return null;
    const text = piToolResultText(result).replace(/\s+/g, " ").trim();
    return (text || "tool call failed").slice(0, 600);
  }

  private recordPiToolFailure(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    isError: boolean;
  }): { count: number; limit: number } | null {
    this.piToolFailureRecordedCallIds ??= new Set();
    this.piToolFailures ??= new Map();
    if (this.piToolFailureRecordedCallIds.has(input.toolCallId)) return null;
    this.piToolFailureRecordedCallIds.add(input.toolCallId);
    const key = ChatThreadDO.prototype.piToolFailureKey.call(this, input.toolName, input.args);
    const error = ChatThreadDO.prototype.piToolFailureText.call(this, input.result, input.isError);
    if (!error) {
      this.piToolFailures.delete(key);
      return null;
    }
    const previous = this.piToolFailures.get(key);
    const count = previous?.error === error ? previous.count + 1 : 1;
    const limit = /(?:\b401\b|\b402\b|unauthori[sz]ed|forbidden|permission denied|credits? (?:are )?(?:used up|exhausted)|quota|billing|unknown tool|not configured)/i.test(error)
      ? 1
      : 2;
    this.piToolFailures.set(key, { count, error, limit });
    return { count, limit };
  }

  private async beforePiToolCall(
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ): Promise<BeforeToolCallResult | undefined> {
    if (signal?.aborted) return undefined;
    this.piToolFailures ??= new Map();
    const previous = this.piToolFailures.get(
      ChatThreadDO.prototype.piToolFailureKey.call(this, context.toolCall.name, context.args),
    );
    if (!previous || previous.count < previous.limit) return undefined;
    if (typeof this.recordChatThreadObservabilityEvent === "function") {
      this.recordChatThreadObservabilityEvent("pi_tool_retry_blocked", {
        operation: context.toolCall.name,
        status: "blocked",
        count: previous.count,
      });
    }
    return {
      block: true,
      reason: `Blocked an identical retry after the same tool call exhausted its ${previous.limit}-attempt budget. Change the arguments, inspect the tool contract, or use a different approach.`,
    };
  }

  private hydratePiStoredImages(
    value: unknown,
    budget?: PiImageHydrationBudget,
  ): Promise<unknown> {
    return this.piCoreStore.hydratePiStoredImages(value, budget);
  }

  private serializePiMessageForSqlStorageDetailed(message: AgentMessage): Promise<PiSqlStorageSerialization> {
    return this.piCoreStore.serializePiMessageForSqlStorageDetailed(message);
  }

  private async attachCodeModeArtifactsToToolResult(
    message: AgentMessage,
    options: { consume?: boolean } = {},
  ): Promise<AgentMessage> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "toolResult" || record.toolName !== "js_exec") return message;
    const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
    if (!toolCallId) return message;
    const artifacts = await this.consumeCodeModeArtifacts(toolCallId, {
      deleteAfterRead: options.consume === true,
    });
    if (artifacts.length === 0) return message;
    const existingMetadata = normalizePiUiMetadata(record.uiMetadata);
    const artifactsById = new Map<string, RuntimeCallArtifact>();
    for (const artifact of existingMetadata?.codeModeArtifacts ?? []) {
      artifactsById.set(artifact.id, artifact);
    }
    for (const artifact of artifacts) {
      artifactsById.set(artifact.id, artifact);
    }
    return {
      ...record,
      uiMetadata: {
        ...existingMetadata,
        codeModeArtifacts: Array.from(artifactsById.values()),
      } satisfies PiUiMetadata,
    } as unknown as AgentMessage;
  }

  private loadPiCoreMessages(options: {
    includeUiMetadata?: boolean;
    imagePolicy?: PiCoreImagePolicy;
    imageHydrationBudget?: PiImageHydrationBudget;
  } = {}): Promise<AgentMessage[]> {
    return this.withChatMemoryPhase("pi_read", () =>
      this.piCoreStore.loadPiCoreMessages(options),
    );
  }

  /**
   * Rewrite pi_core wholesale. Every rewrite invalidates the render-history
   * high-water mark (its unit is the parsed-render-message COUNT, which a
   * rewrite renumbers), so each caller must say what happens to the ai-chat
   * render mirror:
   *
   *  - `uiRender: "preserve"` — the rewrite only drops/summarizes old rows that
   *    were already mirrored (post-turn compaction): keep the render table
   *    (users keep their full visible history) and re-pin the mark to the new
   *    parsed count so the top-up never re-walks rewritten rows.
   *  - `uiRender: "rebuild"` — the rewrite replaces history semantically (fork
   *    seeding, admin repair): wipe the render table and rebuild it from the
   *    new pi_core via the shared resync.
   */
  private async replacePiCoreMessages(
    messages: AgentMessage[],
    options: { uiRender: "preserve" | "rebuild" },
  ): Promise<void> {
    this.ensurePiCoreTables();
    // Serialize first (this can await R2/image work); swap the table contents
    // with no await between DELETE and the INSERTs so an eviction or a
    // concurrent reader never observes a half-written history.
    const payloads: string[] = [];
    for (const message of messages) {
      const serialized = await this.serializePiMessageForSqlStorageDetailed(message);
      payloads.push(serialized.payload);
    }
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM pi_core_messages");
    for (let index = 0; index < payloads.length; index += 1) {
      this.ctx.storage.sql.exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        index,
        payloads[index],
        now,
      );
    }
    this.piCoreStore.markPiCoreChanged(payloads.length);
    if (options.uiRender === "rebuild") {
      await this.rebuildUiMessagesFromPiCore();
    } else {
      const parsed = await this.getPiCoreParsedMessages(
        this.chatContext?.threadId ?? "",
      );
      this.ctx.storage.kv.put(UI_MESSAGES_PI_CORE_HIGH_WATER_KEY, parsed.length);
      const revision = this.piCoreStore.getPiCoreRevision();
      this.ctx.storage.kv.put(
        UI_MESSAGES_PI_CORE_REVISION_KEY,
        `${revision.generation}:${revision.count}`,
      );
    }
  }

  private get uiMirror(): ChatThreadUiMirror {
    return (this.uiMirrorInstance ??= new ChatThreadUiMirror({
      sql: () => this.ctx.storage.sql,
      kv: () => this.ctx.storage.kv,
      chatContext: () => this.chatContext,
      getRenderMessages: () => this.messages as UIMessage[],
      setRenderMessages: (messages) => {
        this.messages = messages;
      },
      persistRenderMessages: (messages) => this.persistMessages(messages),
      clearPersistedRenderCache: () => {
        // Reaches ai-chat's private serialized-upsert cache; see the invariant
        // note in ChatThreadUiMirror.rebuildUiMessagesFromPiCore.
        (
          this as unknown as { _persistedMessageCache?: Map<string, string> }
        )._persistedMessageCache?.clear();
      },
      readPiActiveTurn: () => this.readPiActiveTurn(),
      activePiStreamTurnId: () => this.activePiStreamTurnId,
      getPiCoreRevision: () => this.piCoreStore.getPiCoreRevision(),
      getPiCoreParsedMessages: (threadId) => this.getPiCoreParsedMessages(threadId),
      reloadAiChatMessagesOrdered: () => this.reloadAiChatMessagesOrdered(),
      topUpUiMessagesFromPiCore: (options) => this.topUpUiMessagesFromPiCore(options),
      withMemoryPhase: (operation, fn) => this.withChatMemoryPhase(operation, fn),
      recordChatThreadObservabilityEvent: (event, details) =>
        this.recordChatThreadObservabilityEvent(event, details),
    }));
  }

  private rebuildUiMessagesFromPiCore(): Promise<void> {
    return this.uiMirror.rebuildUiMessagesFromPiCore();
  }

  // Transcript data lake export (pi_core -> Pipelines -> R2 Data Catalog).
  // Watermark-based and idempotent, so it is safe to fire from every commit.
  private get transcriptLake(): TranscriptLakeMirror {
    return (this.transcriptLakeInstance ??= new TranscriptLakeMirror({
      sql: () => this.ctx.storage.sql,
      kv: () => this.ctx.storage.kv,
      chatContext: () => this.chatContext,
      env: () => this.env,
      withMemoryPhase: (operation, fn) => this.withChatMemoryPhase(operation, fn),
      recordChatThreadObservabilityEvent: (event, details) =>
        this.recordChatThreadObservabilityEvent(event, details),
    }));
  }

  /**
   * Export newly committed pi_core rows. Deliberately fired through waitUntil:
   * the lake is derived data, so a slow or failing stream must never extend a
   * turn — the high-water mark simply re-sends the range on the next call.
   */
  private scheduleTranscriptLakeSync(): void {
    // Defensive on both bindings: export is opt-in per environment, and this
    // runs from connect/commit paths that must never fail because telemetry
    // plumbing is absent.
    if (!this.env?.TRANSCRIPT_LAKE || !this.ctx?.waitUntil) return;
    this.ctx.waitUntil(
      this.transcriptLake.syncTranscriptLake().catch((error) => {
        console.error("[ChatThreadDO] transcript lake sync failed", error);
      }),
    );
  }

  /** Compatibility seam used by direct pi_core persistence tests. */
  async appendPiCoreMessages(messages: AgentMessage[]): Promise<void> {
    await this.piCoreStore.appendPiCoreMessages(messages);
    this.scheduleTranscriptLakeSync();
  }

  private async appendPiCoreMessagesIfMissing(messages: AgentMessage[]): Promise<void> {
    await this.piCoreStore.appendPiCoreMessagesIfMissing(messages);
    this.scheduleTranscriptLakeSync();
  }

  // --- Durable resume of an interrupted Pi turn (Flue-style journal + reconcile) ---

  /**
   * Mirror the in-flight (not-yet-committed) tail of the live session into the
   * `pi_turn_journal` staging table. Called as the turn produces work
   * (message_end / tool_execution_end) so a mid-turn eviction can recover it.
   */
  // Turn/steer journal + active-turn marker persistence lives in
  // ./chat-thread/pi-turn-journal; these thin delegates keep the DO-internal
  // call surface (and its test seams) stable. Its memoized dependency callbacks
  // continue to resolve live DO state.
  private get piTurnJournal(): PiTurnJournal {
    return (this.piTurnJournalInstance ??= new PiTurnJournal({
      sql: () => this.ctx.storage.sql,
      kv: () => this.ctx.storage.kv,
      ensureTables: () => this.ensurePiCoreTables(),
      serializeMessageDetailed: (message) =>
        this.serializePiMessageForSqlStorageDetailed(message),
      // Recovery/fork/dedup use compact references. Provider hydration happens
      // only on transformContext's temporary request copy.
      hydrateStoredImages: async (value) => value,
    }));
  }

  private async recordPiTurnJournalTail(): Promise<void> {
    const session = this.piSession;
    if (!session) return;
    await this.withChatMemoryPhase("journal_checkpoint", () =>
      this.piTurnJournal.recordTail(
        session.state.messages.slice(this.piMainBaselineIndex),
      ),
    );
  }

  private recordPiTurnJournalUserMessage(
    userMessage: AgentMessage,
    options: { append?: boolean } = {},
  ): void {
    this.piTurnJournal.recordUserMessage(userMessage, options);
  }

  private loadPiTurnJournalTail(): Promise<AgentMessage[]> {
    return this.withChatMemoryPhase("journal_recovery_load", () =>
      this.piTurnJournal.loadTail(),
    );
  }

  private clearPiTurnJournal(): void {
    this.piTurnJournal.clearTail();
  }

  private prunePiTurnJournalFailedAssistantMessages(): void {
    this.piTurnJournal.pruneFailedAssistantMessages();
  }

  private recordPiTurnJournalSteerMessage(userMessage: AgentMessage): void {
    this.piTurnJournal.recordSteerMessage(userMessage);
  }

  private loadPiTurnSteerJournal(): Promise<AgentMessage[]> {
    return this.piTurnJournal.loadSteerMessages();
  }

  /** Compatibility seam used by synchronous steer-journal tests. */
  clearPiTurnSteerJournal(): void {
    this.piTurnJournal.clearSteerMessages();
  }

  private readPiActiveTurn(): PiActiveTurnMarker | null {
    return this.piTurnJournal.readActiveTurn();
  }

  private openPiActiveTurnIfAbsent(): void {
    this.piTurnJournal.openActiveTurnIfAbsent();
  }

  private async clearPiActiveTurnAndJournal(): Promise<void> {
    await this.piTurnJournal.clearActiveTurnAndJournal();
  }

  /**
   * Resume branch of {@link onChatMessage} (commit 6): re-drive an interrupted Pi
   * turn. Runs inside the stream execute when ai-chat re-invokes onChatMessage for
   * a recovery (continueLastTurn for a mid-stream partial, _retryLastUserTurn for a
   * pre-stream eviction) — i.e. when there is no fresh pending prompt. The committed
   * history + journal tail (and any pending steer) were folded into the rebuilt
   * session by {@link createPiSession}; from there either the model still owes
   * output (continue it, streaming into the SAME assistant message via the encoder
   * onChatMessage already attached) or the final assistant message already landed
   * pre-eviction (commit the staged tail and finish the turn).
   *
   * No attempt budget or fiber wrapping here — chatRecovery owns both. Errors
   * propagate to onChatMessage's catch, which runs the shared failure cleanup.
   */
  private async resumeActivePiTurn(): Promise<void> {
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_attempt", {
      operation: "resume_interrupted_turn",
      status: "attempting",
    });
    await this.ensurePiSessionReady();
    const session = this.piSession;
    if (!session) {
      throw new Error(
        "Pi session was not available to resume the interrupted turn",
      );
    }
    const messages = session.state.messages;
    const last = messages[messages.length - 1] as { role?: string } | undefined;
    const owesModelOutput = last?.role === "user" || last?.role === "toolResult";
    if (!owesModelOutput) {
      // The interrupted turn already produced its final assistant message; commit
      // whatever the journal staged and close the turn out — nothing to continue.
      // Fold Code Mode / js_exec artifacts back onto their tool results first, the
      // same way turn_end does (consume drains the transient KV artifact bucket) —
      // otherwise the reloaded transcript would be missing those artifacts.
      const tail = messages.slice(this.piMainBaselineIndex);
      if (tail.length > 0) {
        const tailWithArtifacts = await Promise.all(
          tail.map((message) =>
            this.attachCodeModeArtifactsToToolResult(message, { consume: true }),
          ),
        );
        await this.appendPiCoreMessagesIfMissing(
          stampPiRenderMessageId(
            tailWithArtifacts,
            this.activePiStreamTurnId,
          ),
        );
        this.piMainBaselineIndex = messages.length;
        // No continuation streams here, so the encoder never emits the
        // turn/completed metadata. If ai-chat orphan-persisted the interrupted
        // stream's partial (it did whenever the partial carried settled tool
        // results — see onChatRecovery), that live render row already SHOWS this
        // committed content: stamp it with the tail's assistant fork ids so the
        // top-up backfill skips these rows instead of duplicating them. When no
        // partial was persisted there is no row to stamp and the top-up converts
        // the rows exactly once.
        await this.stampLiveAssistantForkEntryIds(tailWithArtifacts);
      }
      await this.clearPiActiveTurnAndJournal();
      // This is the ONLY completion path for a turn recovered after its final
      // assistant message but before agent_end ran, so finalize it exactly like
      // the normal agent_end path via finishTurn({ markUnread }): it drives
      // recordThreadAssistantCompletion (workspace unread + completion timestamp),
      // the active automation run -> success, and the completion summary.
      const completedAt = Date.now();
      const finalText = extractLatestPiAssistantText(messages);
      const summarySource = extractThreadCompletionSummarySource(
        messages,
        finalText,
      );
      this.finishTurn({
        markUnread: true,
        completedAt,
        summarySource,
      });
      this.setActiveTurnUserId(null);
      await this.completeTodoStateForTurnEnd();
      return;
    }
    // Turn-start bookkeeping runs from the agent_start event the continuation
    // emits; the spinner is already derived-on from the active-turn marker. The
    // Pi runtime events stream into the same assistant message through the encoder.
    // The ai-chat stall watchdog (chatStreamStallTimeoutMs) bounds this
    // continuation the same way it bounds a fresh prompt.
    const active = this.piSession;
    if (!active) {
      throw new Error(
        "Pi session was not available to resume the interrupted turn",
      );
    }
    // If ai-chat orphan-persisted a partial for this turn (only done when it
    // carried settled tool results — see onChatRecovery), its trailing
    // incomplete parts (a mid-stream text/reasoning run, a tool call whose input
    // never finished) describe output Pi does NOT continue: the model regenerates
    // its interrupted message from the journal-folded transcript. ai-chat's
    // continuation clones that partial and APPENDS the regenerated stream, so
    // drop the incomplete trailing parts first — otherwise the message renders
    // half text followed by the full regenerated text. Settled parts (completed
    // tools, finished text runs) are earlier, committed work and stay.
    await this.trimIncompleteLiveAssistantParts();
    await active.continue();
    // A successful continuation runs the normal lifecycle; `agent_end` clears the
    // marker + journal.
  }

  /**
   * Stamp the live render row for the in-flight stream (id = the active turnId)
   * with the assistant fork ids (`responseId`s) of pi_core rows whose content it
   * already displays, under `metadata.pi.forkEntryIds`. The top-up backfill
   * treats those ids exactly like the encoder-emitted `forkEntryId`, so the rows
   * are skipped instead of converted into duplicates. No-op when the stream has
   * no persisted render row (nothing displays the content — the top-up then
   * converts it exactly once).
   */
  private async stampLiveAssistantForkEntryIds(
    committedTail: AgentMessage[],
  ): Promise<void> {
    const turnId = this.activePiStreamTurnId;
    if (!turnId) return;
    const live = this.messages.find((message) => message.id === turnId);
    if (!live || live.role !== "assistant") return;
    // responseId is set on every provider-produced assistant message; a rare
    // assistant row without one falls back to a row-index-derived parsed id we
    // cannot know here, so it may still convert once (never a clobber — the
    // upsert identity check is by tool-call id, and such rows carry none).
    const forkIds: string[] = [];
    for (const message of committedTail) {
      const record = message as unknown as Record<string, unknown>;
      if (record.role !== "assistant") continue;
      if (typeof record.responseId === "string" && record.responseId.trim()) {
        forkIds.push(record.responseId.trim());
      }
    }
    if (forkIds.length === 0) return;
    const metadata = ((live as { metadata?: Record<string, unknown> }).metadata ??
      {}) as Record<string, unknown>;
    const pi = (metadata.pi && typeof metadata.pi === "object"
      ? { ...(metadata.pi as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    const existing = Array.isArray(pi.forkEntryIds)
      ? (pi.forkEntryIds as unknown[]).filter(
          (value): value is string => typeof value === "string" && !!value,
        )
      : [];
    pi.forkEntryIds = Array.from(new Set([...existing, ...forkIds]));
    const updated = {
      ...live,
      metadata: { ...metadata, pi },
    } as UIMessage;
    await this.persistMessages(
      this.messages.map((message) => (message.id === turnId ? updated : message)),
    );
  }

  /**
   * Drop trailing incomplete parts (text/reasoning still `streaming`, tool calls
   * still `input-streaming`) from the live render row of the in-flight stream
   * before a resume continuation appends the regenerated output. See the call
   * site in {@link resumeActivePiTurn}.
   */
  private async trimIncompleteLiveAssistantParts(): Promise<void> {
    const turnId = this.activePiStreamTurnId;
    if (!turnId) return;
    const live = this.messages.find((message) => message.id === turnId);
    if (!live || live.role !== "assistant" || !Array.isArray(live.parts)) return;
    const parts = [...live.parts];
    let trimmed = 0;
    while (parts.length > 0) {
      const last = parts[parts.length - 1] as { state?: unknown };
      if (last?.state === "streaming" || last?.state === "input-streaming") {
        parts.pop();
        trimmed += 1;
        continue;
      }
      break;
    }
    if (trimmed === 0) return;
    const updated = { ...live, parts } as UIMessage;
    await this.persistMessages(
      this.messages.map((message) => (message.id === turnId ? updated : message)),
    );
    this.recordChatThreadObservabilityEvent("pi_turn_partial_trimmed", {
      operation: "resume_interrupted_turn",
      status: "trimmed",
      count: trimmed,
    });
  }

  private discardUnpersistedPiSessionMessages(): number {
    const sessionMessages = this.piSession?.state.messages;
    if (!sessionMessages) return 0;
    const baselineIndex = Math.max(
      0,
      Math.min(this.piMainBaselineIndex, sessionMessages.length),
    );
    const droppedCount = sessionMessages.length - baselineIndex;
    if (droppedCount > 0 && this.piSession) {
      this.piSession.state.messages = sessionMessages.slice(0, baselineIndex);
    }
    this.piMainBaselineIndex = baselineIndex;
    return droppedCount;
  }

  private touchPiTurnProgress(): void {
    this.piTurnLastProgressAtMs = Date.now();
  }

  private async keepPiTurnToolProgressAliveWhile<T>(fn: () => Promise<T>): Promise<T> {
    this.touchPiTurnProgress();
    // Only one harness tool runs at a time; drop any prior interval (defensive).
    this.clearPiToolKeepAliveInterval();
    const toolStartedAtMs = Date.now();
    let rejectHard: ((error: Error) => void) | null = null;
    const hardTimeoutPromise = new Promise<never>((_, reject) => {
      rejectHard = reject;
    });
    // Track the underlying work so a timed-out race does not leave an unhandled
    // rejection when the real tool later settles (or fails).
    const work = Promise.resolve().then(() => fn());
    this.piToolKeepAliveInterval = setInterval(() => {
      const now = Date.now();
      const toolElapsedMs = now - toolStartedAtMs;
      const turnStartedAtMs = this.piAgentStartedAtMs || this.piTurnStartedAtMs;
      const turnElapsedMs = turnStartedAtMs > 0 ? now - turnStartedAtMs : 0;

      // Absolute turn ceiling wins: tear down the whole turn with a user-visible
      // stop (see abortTurnForAbsoluteTimeout). Tool path just unblocks execute.
      if (turnElapsedMs >= PI_TURN_ABSOLUTE_MAX_MS) {
        void this.abortTurnForAbsoluteTimeout(turnElapsedMs);
        rejectHard?.(new PiTurnAbsoluteTimeoutError());
        return;
      }

      // Tool ceiling: fail THIS tool only. pi-agent-core maps execute throws to
      // an isError tool result and the model continues — do NOT disposePiSession.
      if (toolElapsedMs >= PI_TURN_TOOL_HARD_TIMEOUT_MS) {
        this.recordChatThreadObservabilityEvent("pi_turn_tool_hard_timeout", {
          operation: "tool_hard_timeout",
          status: "timeout",
          severity: "warn",
          durationMs: toolElapsedMs,
        });
        rejectHard?.(new PiTurnToolHardTimeoutError());
        return;
      }

      // Heartbeats are bounded by the tool ceiling above. They keep the ai-chat
      // stall watchdog fed during legitimate long silent tools (build/notebook)
      // without allowing infinite keep-alive.
      this.touchPiTurnProgress();
      this.writePiStreamHeartbeat();
    }, PI_TURN_PROGRESS_INTERVAL_MS);
    try {
      return await Promise.race([work, hardTimeoutPromise]);
    } finally {
      this.clearPiToolKeepAliveInterval();
      this.touchPiTurnProgress();
      void work.catch(() => {});
    }
  }

  private async withPiTurnInactivityTimeout(
    fn: () => Promise<void>,
  ): Promise<void> {
    this.touchPiTurnProgress();
    let interval: ReturnType<typeof setInterval> | null = null;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          interval = setInterval(() => {
            const stalledMs = Math.max(0, Date.now() - this.piTurnLastProgressAtMs);
            if (stalledMs < PI_TURN_INACTIVITY_TIMEOUT_MS) return;
            this.disposePiSession();
            reject(new PiTurnInactivityTimeoutError());
          }, PI_TURN_PROGRESS_INTERVAL_MS);
        }),
      ]);
    } finally {
      if (interval) clearInterval(interval);
      this.piTurnLastProgressAtMs = 0;
    }
  }

  private emptyPiUsage() {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  private createPiUserStopMessage(timestamp: number): AgentMessage {
    const model = this.piSession?.state.model;
    return {
      role: "assistant",
      content: [{
        type: "text",
        text: PI_USER_STOP_TEXT,
      }],
      api: model?.api ?? "unknown",
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: this.emptyPiUsage(),
      stopReason: "aborted",
      responseId: `pi_user_stop_${timestamp}`,
      timestamp,
      metadata: {
        reason: PI_USER_STOP_METADATA_REASON,
      },
    } as unknown as AgentMessage;
  }

  private ensurePiUserStopMessage(
    messages: AgentMessage[],
    stoppedAtMs: number,
  ): AgentMessage[] {
    const visibleMessages = messages.filter(
      (message) => !isEmptyAbortedPiAssistantMessage(message),
    );
    if (visibleMessages.some((message) => isPiUserStopMessage(message))) {
      return visibleMessages;
    }
    return [...visibleMessages, this.createPiUserStopMessage(stoppedAtMs)];
  }

  private annotatePiProviderErrorMessages(messages: AgentMessage[]): AgentMessage[] {
    let changed = false;
    const next = messages.map((message) => {
      const record = message as unknown as Record<string, unknown>;
      const errorMessage = getPiAssistantErrorMessage(message);
      if (!errorMessage) return message;

      changed = true;
      const billingSource =
        record.billingSource === "byok" || record.billingSource === "hosted"
          ? record.billingSource
          : this.piCurrentBillingSource;
      const provider =
        this.piCurrentUsageProvider ||
        (typeof record.provider === "string" ? record.provider : undefined);
      const metadata = piProviderErrorMetadata(errorMessage);
      return {
        ...record,
        billingSource,
        ...(provider ? { provider } : {}),
        ...metadata,
      } as unknown as AgentMessage;
    });

    return changed ? next : messages;
  }




  // Thin seam over retryTransientDurableObjectRpc so tests can stub the
  // retry behavior on a fake `this` without real backoff sleeps.
  private retryChatDurableObjectRpc<T>(
    operation: string,
    fn: () => Promise<T>,
    options: { attempts?: number; initialDelayMs?: number } = {},
  ): Promise<T> {
    return retryTransientDurableObjectRpc(operation, fn, options);
  }

  private ensurePiAssistantTextMessage(messages: AgentMessage[], text: string): AgentMessage[] {
    const trimmed = text.trim();
    if (!trimmed) return messages;

    const hasAssistantText = messages.some((message) => {
      const record = message as unknown as Record<string, unknown>;
      if (record.role !== "assistant" || !Array.isArray(record.content)) return false;
      return record.content.some((part) => {
        if (!part || typeof part !== "object") return false;
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" && item.text.trim();
      });
    });
    if (hasAssistantText) return messages;

    const next = messages.slice();
    for (let i = next.length - 1; i >= 0; i--) {
      const record = next[i] as unknown as Record<string, unknown>;
      if (record.role !== "assistant") continue;
      next[i] = {
        ...record,
        content: [{ type: "text", text: trimmed }],
        timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
      } as unknown as AgentMessage;
      return next;
    }

    const model = this.piSession?.state.model;
    next.push({
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
      api: model?.api ?? "unknown",
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: this.emptyPiUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage);
    return next;
  }

  private loadPiCoreCompaction(): { summary: string; firstKeptIndex: number; updatedAt: number } | null {
    return this.piCoreStore.loadPiCoreCompaction();
  }

  private persistPiCoreCompaction(summary: string, firstKeptIndex: number): void {
    this.piCoreStore.persistPiCoreCompaction(summary, firstKeptIndex);
  }

  private clearPiCoreCompaction(): void {
    this.piCoreStore.clearPiCoreCompaction();
  }

  private async handleConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    const result = this.browserPrompts.answerConnectionSetup(response);
    if (!result.accepted) {
      console.warn("[ChatThreadDO] Received connection setup response with no pending waiter", {
        requestId: response.requestId,
      });
    }
    return result;
  }

  // The degraded-auth grant map and recently-accepted clientMessageId dedup
  // live in ./chat-thread/access; these thin delegates keep the DO-internal
  // call surface (and its test seams) stable. Its memoized dependency callbacks
  // resolve live DO state and route sibling calls through `this`, so stubbed
  // seams keep working.
  private get chatAccess(): ChatThreadAccess {
    return (this.chatAccessInstance ??= new ChatThreadAccess({
      kv: () => this.ctx.storage.kv,
      readAuthorizedChatUserGrants: () => this.readAuthorizedChatUserGrants(),
    }));
  }

  private readAuthorizedChatUserGrants(): Record<string, number> {
    return this.chatAccess.readAuthorizedChatUserGrants();
  }

  private isPreviouslyAuthorizedChatUser(userId: string): boolean {
    return this.chatAccess.isPreviouslyAuthorizedChatUser(userId);
  }

  private recordAuthorizedChatUser(userId: string): void {
    this.chatAccess.recordAuthorizedChatUser(userId);
  }

  private hasRecentlyAcceptedClientMessage(clientMessageId: string): boolean {
    return this.chatAccess.hasRecentlyAcceptedClientMessage(clientMessageId);
  }

  private recordAcceptedClientMessageId(clientMessageId: string): void {
    this.chatAccess.recordAcceptedClientMessageId(clientMessageId);
  }

  // Lazily created so prototype-based test fakes work; holds enqueues that
  // have not yet resolved, keyed by clientMessageId. A retransmitted
  // duplicate awaits the original attempt's outcome instead of enqueueing
  // again or prematurely acking.
  private getPendingClientMessageEnqueues(): Map<
    string,
    Promise<InitialUserMessageResult>
  > {
    if (!this.pendingClientMessageEnqueues) {
      this.pendingClientMessageEnqueues = new Map();
    }
    return this.pendingClientMessageEnqueues;
  }

  private captureChatContextFromRequest(
    url: URL,
    request: Request,
    ws?: WebSocket,
  ): void {
    const queryThreadId = url.searchParams.get("threadId")?.trim() || "";
    const queryWorkspaceId = url.searchParams.get("workspaceId")?.trim() || "";
    const queryOrgId = url.searchParams.get("orgId")?.trim() || "";

    const userId = request.headers.get(HEADER_USER_ID)?.trim() || null;
    const userName = request.headers.get(HEADER_USER_NAME)?.trim() || null;
    const userEmail = request.headers.get(HEADER_USER_EMAIL)?.trim() || null;

    const prev = this.chatContext;
    const threadId = queryThreadId || prev?.threadId || "";
    const workspaceId = queryWorkspaceId || prev?.workspaceId || "";
    const orgId = queryOrgId || prev?.orgId || "";

    if (!threadId || !workspaceId || !orgId) {
      return;
    }

    this.chatContext = {
      threadId,
      workspaceId,
      orgId,
      userId,
      userName,
      userEmail,
    };

    ws?.serializeAttachment(this.chatContext);
    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
  }

  private async applyMentionsForTurn(content: string): Promise<string> {
    if (!content) return content;
    if (!content.includes('@')) return content;
    const workspaceId = this.chatContext?.workspaceId;
    const orgId = this.chatContext?.orgId;
    if (!workspaceId || !orgId) return content;
    try {
      const orgStub = this.getOrgStub(orgId);
      const workspaceFs = new WorkspaceFilesystemClient(this.env, workspaceId);
      const [integrations, projects] = await Promise.all([
        Promise.resolve()
          .then(() => orgStub.getWorkspaceIntegrations(workspaceId))
          .catch((err) => {
            console.error('[ChatThreadDO] getIntegrations for mentions failed', err);
            return [];
          }),
        Promise.resolve()
          .then(() => workspaceFs.listProjects())
          .catch((err) => {
            console.error('[ChatThreadDO] listProjects for mentions failed', err);
            return [];
          }),
      ]);
      const result = applyMentionContext(content, { integrations, projects });
      return result.content;
    } catch (err) {
      console.error(
        '[ChatThreadDO] applyMentionsForTurn failed',
        err,
      );
      return content;
    }
  }

  private getOrgStub(orgId: string): DurableObjectStub<OrgDO> {
    if (!orgId) throw new Error("Missing org scope");
    return this.env.ORG.get(this.env.ORG.idFromName(orgId));
  }

  private get channelTools(): ChannelTools {
    return (this.channelToolsInstance ??= new ChannelTools(this.env));
  }

  private get piModelMapping(): PiModelMapping {
    return (this.piModelMappingInstance ??= new PiModelMapping());
  }

  // Chat send failure / error payload collaborator (see
  // chat-thread-errors.ts). All state stays on this DO, and the memoized deps
  // close over `this` so a fake with stubbed siblings
  // behaves exactly as when the bodies lived here. Event delivery
  // (pushChatEvent / broadcast) stays on this DO.
  private get chatErrors(): ChatThreadErrors {
    return (this.chatErrorsInstance ??= new ChatThreadErrors({
      chatContext: () => this.chatContext,
      env: () => this.env,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      piCurrentBillingSource: () => this.piCurrentBillingSource,
      piCurrentUsageProvider: () => this.piCurrentUsageProvider,
      piSession: () => this.piSession,
      recordedChatErrors: () => this.recordedChatErrors,
      setRecordedChatErrors: (value) => {
        this.recordedChatErrors = value;
      },
      retryChatDurableObjectRpc: (operation, fn, options) =>
        this.retryChatDurableObjectRpc(operation, fn, options),
      chatSendFailureStatus: (status, error) =>
        this.chatSendFailureStatus(status, error),
      isChatBillingOrCreditError: (error) => this.isChatBillingOrCreditError(error),
    }));
  }

  private chatSendFailureStatus(
    status: "busy" | "error" | string,
    error: unknown,
  ): number {
    return this.chatErrors.chatSendFailureStatus(status, error);
  }

  private isChatBillingOrCreditError(error: unknown): boolean {
    return this.chatErrors.isChatBillingOrCreditError(error);
  }

  private chatSendErrorPayload(
    error: unknown,
    options: {
      status?: "busy" | "error" | string;
      fallbackMessage: string;
    },
  ): Record<string, unknown> {
    return this.chatErrors.chatSendErrorPayload(error, options);
  }

  private async handleClientUserMessage(
    data: ChatUserMessageInput,
  ): Promise<InitialUserMessageResult> {
    const startedAt = Date.now();
    const sendAttemptId = data.clientMessageId || crypto.randomUUID();

    const clientMessageId =
      typeof data.clientMessageId === "string" && data.clientMessageId
        ? data.clientMessageId
        : null;

    if (clientMessageId) {
      // Duplicate of a send whose enqueue already accepted a turn (the
      // browser retransmits when the acceptance ack was lost to a socket
      // drop): re-ack so the client clears its pending state, never enqueue
      // twice.
      if (this.hasRecentlyAcceptedClientMessage(clientMessageId)) {
        return { status: "accepted" };
      }

      // Duplicate of a send whose enqueue is still in flight (reconnect +
      // retransmit before the first attempt resolved). Do not ack yet and do
      // not enqueue again: relay the original attempt's real outcome to this
      // socket, so a failure reported to the old, dead socket still reaches
      // the client instead of being masked by a premature ack.
      const inFlight = this.getPendingClientMessageEnqueues().get(
        clientMessageId,
      );
      if (inFlight) {
        let outcome: InitialUserMessageResult;
        try {
          outcome = await inFlight;
        } catch (error) {
          return {
            status: "error",
            error: error instanceof Error ? error.message : "Failed to send message to sandbox",
          };
        }
        if (outcome.status === "accepted") {
          return { status: "accepted" };
        }
        return outcome;
      }

    }

    let result: InitialUserMessageResult;
    const enqueue = this.enqueueRunnerUserMessage(data, {
      sendAttemptId,
      startedAt,
    });
    if (clientMessageId) {
      this.getPendingClientMessageEnqueues().set(clientMessageId, enqueue);
    }
    try {
      result = await enqueue;
    } catch (error) {
      this.updateActiveAutomationRun({
        status: "error",
        message: error instanceof Error ? error.message : "Failed to send message",
        clear: true,
      });
      this.finishTurn();
      this.setActiveTurnUserId(null);
      console.error("[ChatThreadDO] failed to enqueue browser user message", error);
      return {
        status: "error",
        error: error instanceof Error ? error.message : "Failed to send message to sandbox",
      };
    } finally {
      if (clientMessageId) {
        this.getPendingClientMessageEnqueues().delete(clientMessageId);
      }
    }

    if (result.status !== "accepted") {
      return result;
    }

    // Only now is the id a safe dedupe marker: the message has actually
    // reached an accepted turn, so swallowing retransmits cannot lose it.
    if (clientMessageId) {
      this.recordAcceptedClientMessageId(clientMessageId);
    }

    return result;
  }

  private async enqueueRunnerUserMessage(
    data: ChatUserMessageInput,
    options: {
      sendAttemptId?: string;
      startedAt?: number;
      messageSource?: string | null;
      // Commit the user's message to the canonical transcript before returning
      // (new-turn only). Set by the initial new-chat send so the action can await
      // acceptance and the thread page then loads the message normally — no
      // optimistic client placeholder. Normal sends leave this unset and keep the
      // turn-end commit so their optimistic-echo reconciliation is unchanged.
      persistUserMessageImmediately?: boolean;
    } = {},
  ): Promise<InitialUserMessageResult> {
    const context = this.chatContext;
    if (!context) {
      return { status: "error", error: "Missing chat context for thread" };
    }
    // Capture the presentation identity beside the model attribution before
    // any await can let another connection replace this DO's mutable context.
    const authorDisplayName = resolveMessageAuthorDisplayName(
      context.userName,
      context.userEmail,
    );
    const messageSource = options.messageSource?.trim() || "web";

    const rawContent =
      typeof data.content === "string" ? data.content.trim() : "";
    if (!rawContent) {
      return { status: "error", error: "Empty message" };
    }

    const orgBan = await isOrgBanned(this.env.APP_KV, {
      orgId: context.orgId,
    });
    if (orgBan) {
      return { status: "error", error: "Organization is blocked" };
    }

    await this.ensurePiSessionReady();

    let attributedContent: string;
    const safeContent = injectFileSafetyMessage(rawContent);
    const mentionAugmented = await this.applyMentionsForTurn(safeContent);
    attributedContent = formatAttributedUserMessage(mentionAugmented, {
      userName: context.userName,
      userEmail: context.userEmail,
      messageSource,
    });
    if (!attributedContent) {
      return { status: "error", error: "Empty message" };
    }

    // A new turn (the user is prompting, not steering an in-flight run) is given a
    // single canonical timestamp shared by the message we persist below and the
    // one sendRunnerCommand prompts Pi with, so both carry the same
    // piCoreMessageKey and the turn-end commit dedups instead of double-storing.
    const startsNewTurn = !this.piSession?.state.isStreaming;
    const turnTimestamp = Date.now();

    let sent = false;
    try {
      this.setActiveTurnUserId(context.userId);
      // Turn-start bookkeeping runs from agent_start once the run begins; the
      // spinner turns on via the derived sync after the fiber row is created (below).
      this.publishRunningUserMessageActivity(rawContent);
      this.ctx.waitUntil(
        this.updateThreadMetadataForUserMessage(
          attributedContent,
          messageSource,
        ).catch((err) => {
          console.error(
            '[ChatThreadDO] failed to update thread metadata after browser user message',
            err,
          );
        }),
      );

      sent = this.sendRunnerCommand({
        ...data,
        type: "message",
        content: attributedContent,
        threadId: context.threadId,
        userId: context.userId ?? undefined,
        timestamp: turnTimestamp,
        // Display fields for the native render-history user bubble (commit 3b):
        // the user's typed text (unattributed) and the source channel.
        rawContent,
        authorDisplayName,
        messageSource,
      });
    } catch (error) {
      this.finishTurn();
      this.setActiveTurnUserId(null);
      throw error;
    }
    if (!sent) {
      this.updateActiveAutomationRun({
        status: "error",
        message: "Failed to send message",
        clear: true,
      });
      this.finishTurn();
      this.setActiveTurnUserId(null);
      return { status: "error", error: "Failed to send message" };
    }

    // Persist the user's message to the canonical transcript only after the send
    // is accepted (the fiber row now exists), but before we return "accepted",
    // so a reader that awaits this ack and immediately loads the thread sees it.
    // Deferring until acceptance means a failed/interrupted send never leaves an
    // orphaned first message with no turn behind it — and a retry that re-runs
    // this RPC won't double-append, because the interrupted attempt persisted
    // nothing. This is what lets the new-chat page render the thread normally,
    // with no optimistic client placeholder and no special new-thread loader
    // path. The matching turn-end commit skips it via piCoreMessageKey.
    if (startsNewTurn && options.persistUserMessageImmediately) {
      // Stamp the render id when the client supplied a message id — the
      // skeleton sendRunnerCommand persists uses the same id. (Without one the
      // skeleton id is minted later; the row then just relies on the
      // piCoreMessageKey linkage as before.)
      const immediateClientMessageId =
        typeof data.clientMessageId === "string" && data.clientMessageId.trim()
          ? data.clientMessageId.trim()
          : null;
      await this.appendPiCoreMessagesIfMissing([
        withPiRenderMessageId(
          {
            role: "user",
            content: attributedContent,
            timestamp: turnTimestamp,
          } as unknown as AgentMessage,
          immediateClientMessageId,
        ),
      ]);
    }

    // sendRunnerCommand created the durable fiber row synchronously, so the derived
    // streaming state is now true — broadcast it for instant spinner feedback.
    this.syncAgentState();

    // A new turn's user message is now in the canonical transcript (above); the
    // turn's assistant/tool content streams to the client through ai-chat render
    // history. Steered messages land in the transcript when Pi emits them and on
    // the next reload.
    return { status: "accepted" };
  }

  // Preview-target/tab normalization and preview session persistence live in
  // ./chat-thread/preview-state; these thin delegates keep the DO-internal
  // call surface (and its test seams) stable. Its memoized dependency callbacks
  // resolve live DO state and route sibling calls through `this`, so stubbed
  // seams keep working.
  private get previewState(): ChatThreadPreviewState {
    return (this.previewStateInstance ??= new ChatThreadPreviewState({
      kv: () => this.ctx.storage.kv,
      previewTabs: () => this.previewTabs,
      previewActiveTabId: () => this.previewActiveTabId,
      previewTarget: () => this.previewTarget,
      previewVersion: () => this.previewVersion,
      getPreviewTabId: (target) => this.getPreviewTabId(target),
      normalizePreviewTarget: (target) => this.normalizePreviewTarget(target),
    }));
  }

  private getPreviewTabId(target: PreviewTarget): string {
    return getPreviewTabId(target);
  }

  private normalizePreviewTarget(
    target: PreviewTarget | null | undefined,
  ): PreviewTarget | null {
    return normalizePreviewTarget(target);
  }

  private normalizePreviewTabsState(
    tabs: PreviewTarget[] | null | undefined,
    activeTabId: string | null | undefined,
    expectedWorkspaceId?: string,
  ): {
    tabs: PreviewTarget[];
    activeTabId: string | null;
    target: PreviewTarget | null;
  } | null {
    return this.previewState.normalizePreviewTabsState(
      tabs,
      activeTabId,
      expectedWorkspaceId,
    );
  }

  private persistPreviewState(includeVersion = true): void {
    this.previewState.persistPreviewState(includeVersion);
  }

  // Workspace streaming-activity publisher collaborator (see
  // chat-thread-streaming-activity.ts). All state stays on this DO as plain
  // fields (test fakes read/write them directly), and the memoized deps close
  // over `this` so a fake with stubbed siblings
  // behaves exactly as when the bodies lived here.
  private get streamingActivity(): ChatThreadStreamingActivity {
    return (this.streamingActivityInstance ??= new ChatThreadStreamingActivity({
      chatContext: () => this.chatContext,
      env: () => this.env,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      pendingStreamingActivity: () => this.pendingStreamingActivity,
      setPendingStreamingActivity: (value) => {
        this.pendingStreamingActivity = value;
      },
      streamingActivityFlushTimer: () => this.streamingActivityFlushTimer,
      setStreamingActivityFlushTimer: (value) => {
        this.streamingActivityFlushTimer = value;
      },
      streamingLeaseRefreshTimer: () => this.streamingLeaseRefreshTimer,
      setStreamingLeaseRefreshTimer: (value) => {
        this.streamingLeaseRefreshTimer = value;
      },
      runningActivityLastText: () => this.runningActivityLastText,
      setRunningActivityLastText: (value) => {
        this.runningActivityLastText = value;
      },
      setRunningActivityLastSentAt: (value) => {
        this.runningActivityLastSentAt = value;
      },
      runningActivityLastSentAt: () => this.runningActivityLastSentAt,
      // Nullish-init on read so a caller constructed without the field (test
      // fakes) still gets one shared stub cache — preserves the DO's `??=`.
      workspaceStatusStubs: () =>
        (this.workspaceStatusStubs ??= new Map<
          string,
          DurableObjectStub<WorkspaceDO>
        >()),
      isThreadStreaming: () => this.isThreadStreaming(),
      retryChatDurableObjectRpc: (operation, fn, options) =>
        this.retryChatDurableObjectRpc(operation, fn, options),
      recordChatThreadObservabilityEvent: (event, details) =>
        this.recordChatThreadObservabilityEvent(event, details),
      discardPendingStreamingActivity: () => this.discardPendingStreamingActivity(),
      stopStreamingLeaseHeartbeat: () => this.stopStreamingLeaseHeartbeat(),
      flushPendingStreamingActivity: () => this.flushPendingStreamingActivity(),
      getWorkspaceStatusStub: (workspaceId) => this.getWorkspaceStatusStub(workspaceId),
      recordWorkspaceThreadStreaming: (workspaceId, threadId, isStreaming, options) =>
        this.recordWorkspaceThreadStreaming(workspaceId, threadId, isStreaming, options),
      queueStreamingActivityUpdate: (workspaceId, threadId, activityText, activityAt) =>
        this.queueStreamingActivityUpdate(workspaceId, threadId, activityText, activityAt),
      normalizeRunningActivityText: (text) => this.normalizeRunningActivityText(text),
      shouldPublishRunningActivity: (activityText, now, immediate) =>
        this.shouldPublishRunningActivity(activityText, now, immediate),
      publishRunningActivity: (text, options) => this.publishRunningActivity(text, options),
    }));
  }

  private resetRunningActivityState(): void {
    this.streamingActivity.resetRunningActivityState();
    this.stopPiTurnAbsoluteTimeoutWatchdog();
  }

  private startStreamingLeaseHeartbeat(): void {
    this.streamingActivity.startStreamingLeaseHeartbeat();
  }

  private stopStreamingLeaseHeartbeat(): void {
    this.streamingActivity.stopStreamingLeaseHeartbeat();
  }

  private getWorkspaceStatusStub(workspaceId: string): DurableObjectStub<WorkspaceDO> {
    return this.streamingActivity.getWorkspaceStatusStub(workspaceId);
  }

  private recordWorkspaceThreadStreaming(
    workspaceId: string | null | undefined,
    threadId: string | null | undefined,
    isStreaming: boolean,
    options?: WorkspaceThreadStreamingOptions,
  ): Promise<void> {
    return this.streamingActivity.recordWorkspaceThreadStreaming(
      workspaceId,
      threadId,
      isStreaming,
      options,
    );
  }

  private queueStreamingActivityUpdate(
    workspaceId: string,
    threadId: string,
    activityText: string,
    activityAt: number,
  ): void {
    this.streamingActivity.queueStreamingActivityUpdate(
      workspaceId,
      threadId,
      activityText,
      activityAt,
    );
  }

  private flushPendingStreamingActivity(): void {
    this.streamingActivity.flushPendingStreamingActivity();
  }

  private discardPendingStreamingActivity(): void {
    this.streamingActivity.discardPendingStreamingActivity();
  }

  private instrumentAiChatMemoryBoundaries(): void {
    if (this.aiChatMemoryBoundariesInstrumented) return;
    this.aiChatMemoryBoundariesInstrumented = true;
    // ai-chat 0.9.3 exposes no hooks between persist reconciliation, its full
    // SQL reload, and full-history broadcast. The pinned implementation calls
    // these prototype methods dynamically, so wrap them without looking at or
    // retaining their arguments. A future rename merely removes the fine-grain
    // breadcrumb; the broad render_persist_reconcile phase remains intact.
    const agent = this as unknown as Record<string, unknown>;
    const loadMessages = agent._loadMessagesFromDb;
    if (typeof loadMessages === "function") {
      agent._loadMessagesFromDb = (...args: unknown[]) => {
        const phase = this.startChatMemoryPhase("render_persist_reload");
        try {
          const result = loadMessages.apply(this, args);
          this.endChatMemoryPhase(phase);
          return result;
        } catch (error) {
          this.endChatMemoryPhase(phase, "error");
          throw error;
        }
      };
    }
    const broadcastMessage = agent._broadcastChatMessage;
    if (typeof broadcastMessage === "function") {
      agent._broadcastChatMessage = (...args: unknown[]) => {
        // This private method also transports high-frequency stream chunks.
        // Inspect only the public frame type and instrument full-history frames;
        // never inspect, retain, or serialize the message payload here.
        const frame = args[0] as { type?: unknown } | null | undefined;
        if (frame?.type !== CHAT_MESSAGE_TYPES.CHAT_MESSAGES) {
          return broadcastMessage.apply(this, args);
        }
        const phase = this.startChatMemoryPhase("render_persist_broadcast");
        try {
          const result = broadcastMessage.apply(this, args);
          this.endChatMemoryPhase(phase);
          return result;
        } catch (error) {
          this.endChatMemoryPhase(phase, "error");
          throw error;
        }
      };
    }
  }

  private readChatMemoryStats(): ChatMemoryStats {
    const now = Date.now();
    if (
      this.cachedChatMemoryStats &&
      now - (this.cachedChatMemoryStatsAt ?? 0) < 100
    ) {
      return this.cachedChatMemoryStats;
    }
    try {
      const stats = collectChatMemoryStats(this.ctx.storage.sql);
      this.cachedChatMemoryStats = stats;
      this.cachedChatMemoryStatsAt = now;
      return stats;
    } catch {
      return {
        totalRows: 0,
        totalBytes: 0,
        maxRowBytes: 0,
        stores: {
          render: { rows: 0, bytes: 0, maxRowBytes: 0 },
          pi: { rows: 0, bytes: 0, maxRowBytes: 0 },
          journal: { rows: 0, bytes: 0, maxRowBytes: 0 },
          stream: { rows: 0, bytes: 0, maxRowBytes: 0 },
        },
      };
    }
  }

  private startChatMemoryPhase(operation: string): {
    operation: string;
    startedAt: number;
    emitted: boolean;
  } {
    const startedAt = Date.now();
    const stats = this.readChatMemoryStats();
    // Keep every breadcrumb for memory-heavy threads. For small threads, emit
    // the first occurrence and then at most one pair per phase every 10 seconds;
    // this prevents provider/persistence loops from flooding Analytics Engine.
    const lastPhaseAt = this.lastChatMemoryPhaseAt?.get(operation) ?? 0;
    const emitted = stats.totalBytes >= 1024 * 1024 || startedAt - lastPhaseAt >= 10_000;
    if (emitted) {
      (this.lastChatMemoryPhaseAt ??= new Map()).set(operation, startedAt);
      this.recordChatThreadObservabilityEvent("chat_memory_phase", {
        operation,
        status: "start",
        count: stats.totalRows,
        size: stats.totalBytes,
        sampleKey: this.chatContext?.threadId,
      });
      this.maybeRecordChatMemoryStores(stats, operation, "start", startedAt);
    }
    return { operation, startedAt, emitted };
  }

  private endChatMemoryPhase(
    phase: { operation: string; startedAt: number; emitted: boolean },
    status: "end" | "error" = "end",
    refreshStats = false,
  ): void {
    if (!phase.emitted) return;
    if (refreshStats) {
      this.cachedChatMemoryStats = null;
      this.cachedChatMemoryStatsAt = 0;
    }
    const stats = this.readChatMemoryStats();
    this.recordChatThreadObservabilityEvent("chat_memory_phase", {
      operation: phase.operation,
      status,
      count: stats.totalRows,
      size: stats.totalBytes,
      durationMs: Date.now() - phase.startedAt,
      sampleKey: this.chatContext?.threadId,
    });
    this.maybeRecordChatMemoryStores(stats, phase.operation, status, Date.now());
  }

  private maybeRecordChatMemoryStores(
    stats: ChatMemoryStats,
    phase: string,
    status: "start" | "end" | "error",
    now: number,
  ): void {
    // Store-level dimensions are useful for diagnosis but four events at every
    // boundary would be noisy. Emit at most once/minute per warm thread; the
    // phase event above remains unthrottled so a missing end identifies the
    // likely fatal operation.
    const lastSnapshotAt = this.lastChatMemoryStoreSnapshotAt ?? 0;
    if (lastSnapshotAt === 0 && stats.totalBytes < 1024 * 1024) {
      this.lastChatMemoryStoreSnapshotAt = now;
      return;
    }
    if (now - lastSnapshotAt < 60_000) return;
    this.lastChatMemoryStoreSnapshotAt = now;
    for (const [store, values] of Object.entries(stats.stores)) {
      this.recordChatThreadObservabilityEvent("chat_memory_store", {
        operation: `${phase}:${store}`,
        status,
        count: values.rows,
        size: values.bytes,
        sampleKey: this.chatContext?.threadId,
      });
      this.recordChatThreadObservabilityEvent("chat_memory_max_row", {
        operation: `${phase}:${store}`,
        status,
        count: values.rows,
        size: values.maxRowBytes,
        sampleKey: this.chatContext?.threadId,
      });
    }
  }

  private async withChatMemoryPhase<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const phase = this.startChatMemoryPhase(operation);
    try {
      const result = await fn();
      this.endChatMemoryPhase(phase, "end", true);
      return result;
    } catch (error) {
      // Do not attach the exception: provider/tool errors can contain user or
      // transcript material. The existing operation's own error telemetry owns
      // safe error classification.
      this.endChatMemoryPhase(phase, "error", true);
      throw error;
    }
  }

  private recordChatThreadObservabilityEvent(
    event: string,
    details: {
      operation?: string;
      status?: string;
      severity?: "debug" | "info" | "warn" | "error";
      count?: number;
      size?: number;
      durationMs?: number;
      error?: unknown;
      statusCode?: number | null;
      provider?: string | null;
      model?: string | null;
      sampleKey?: string | null;
      insertedCount?: number;
      updatedCount?: number;
    } = {},
  ): void {
    const context = this.chatContext;
    const count =
      typeof details.insertedCount === "number" || typeof details.updatedCount === "number"
        ? (details.insertedCount ?? 0) + (details.updatedCount ?? 0)
        : details.count;
    if (details.error) {
      recordErrorEvent(this.env, {
        event,
        component: "chat_thread_do",
        operation: details.operation,
        status: details.status ?? "exception",
        threadId: context?.threadId,
        workspaceId: context?.workspaceId,
        orgId: context?.orgId,
        userId: context?.userId,
        durationMs: details.durationMs,
        statusCode: details.statusCode,
        count,
        size: details.size,
        provider: details.provider,
        model: details.model,
        sampleIndex: details.sampleKey,
        error: details.error,
      });
      return;
    }
    recordObservabilityEvent(this.env, {
      event,
      severity: details.severity ?? "info",
      component: "chat_thread_do",
      operation: details.operation,
      status: details.status ?? "ok",
      threadId: context?.threadId,
      workspaceId: context?.workspaceId,
      orgId: context?.orgId,
      userId: context?.userId,
      provider: details.provider,
      model: details.model,
      durationMs: details.durationMs,
      count,
      size: details.size,
      sampleIndex: details.sampleKey,
    });
  }

  private normalizeRunningActivityText(text: string | null | undefined): string | null {
    return this.streamingActivity.normalizeRunningActivityText(text);
  }

  private shouldPublishRunningActivity(
    activityText: string,
    now: number,
    immediate: boolean,
  ): boolean {
    return this.streamingActivity.shouldPublishRunningActivity(
      activityText,
      now,
      immediate,
    );
  }

  private publishRunningActivity(
    text: string | null | undefined,
    options: { immediate?: boolean; activityAt?: number } = {},
  ): void {
    this.streamingActivity.publishRunningActivity(text, options);
  }

  private publishRunningUserMessageActivity(content: string | null | undefined): void {
    this.streamingActivity.publishRunningUserMessageActivity(content);
  }

  private publishPiToolActivity(
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    status: "running" | "complete" | "error",
    result?: unknown,
  ): void {
    this.streamingActivity.publishPiToolActivity(
      toolCallId,
      toolName,
      args,
      status,
      result,
    );
  }

  private pushWorkspaceStreaming(value: boolean): void {
    this.streamingActivity.pushWorkspaceStreaming(value);
  }

  /**
   * Turn-start bookkeeping. Resets the completion-recording guard, clears stale
   * todos, and broadcasts state. Invoked once per run from the agent_start event.
   */
  private markTurnStarted(): void {
    const memoryPhase = this.startChatMemoryPhase("turn_start");
    this.recordChatThreadObservabilityEvent("pi_turn_started", {
      operation: "run_pi_turn",
      status: "started",
    });
    this.assistantCompletionRecordedAt = null;
    this.assistantCompletionSummaryRequestedAt = null;
    this.resetRunningActivityState();
    // Clear persisted todos so they don't go stale across reconnects.
    if (this.currentTodos.length > 0) {
      this.currentTodos = [];
      this.ctx.storage.kv.delete(CHAT_TODOS_KEY);
    }
    this.syncAgentState();
    this.pushWorkspaceStreaming(true);
    this.startStreamingLeaseHeartbeat();
    this.startPiTurnAbsoluteTimeoutWatchdog();
    this.endChatMemoryPhase(memoryPhase);
  }

  private startPiTurnAbsoluteTimeoutWatchdog(): void {
    this.stopPiTurnAbsoluteTimeoutWatchdog();
    this.piTurnAbsoluteTimeoutTimer = setInterval(() => {
      const startedAtMs = this.piAgentStartedAtMs || this.piTurnStartedAtMs;
      if (!(startedAtMs > 0)) return;
      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs < PI_TURN_ABSOLUTE_MAX_MS) return;
      void this.abortTurnForAbsoluteTimeout(elapsedMs);
    }, PI_TURN_PROGRESS_INTERVAL_MS);
  }

  private stopPiTurnAbsoluteTimeoutWatchdog(): void {
    if (this.piTurnAbsoluteTimeoutTimer !== null) {
      clearInterval(this.piTurnAbsoluteTimeoutTimer);
      this.piTurnAbsoluteTimeoutTimer = null;
    }
  }

  /**
   * Terminal stop for a turn that exceeded {@link PI_TURN_ABSOLUTE_MAX_MS}.
   * Always surfaces {@link PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE} to the client
   * (lastError + provider-error chat event) before going idle — never a silent
   * hang. Clears the active-turn marker so chatRecovery cannot re-drive the
   * multi-hour hang. Idempotent if the turn already settled.
   */
  private async abortTurnForAbsoluteTimeout(elapsedMs: number): Promise<void> {
    // Stop the watchdog first so a slow cleanup cannot re-enter.
    this.stopPiTurnAbsoluteTimeoutWatchdog();
    this.clearPiToolKeepAliveInterval();

    const hadMarker = this.readPiActiveTurn() !== null;
    const hadLiveTurn = Boolean(this.activePiStreamTurnId || this.piSession?.state.isStreaming);
    if (!hadMarker && !hadLiveTurn) {
      this.stopStreamingLeaseHeartbeat();
      return;
    }

    this.recordChatThreadObservabilityEvent("pi_turn_absolute_timeout", {
      operation: "absolute_timeout",
      status: "timeout",
      severity: "error",
      durationMs: elapsedMs,
    });

    // User-visible stop BEFORE tearing down the stream/session so reconnects
    // and the live tab both see why the turn ended.
    try {
      this.lastError = {
        id: crypto.randomUUID(),
        error: PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE,
        billingSource: null,
        provider: null,
        status: null,
        errorType: "PiTurnAbsoluteTimeout",
      };
      this.syncAgentState();
      this.pushChatEvent(this.piProviderErrorEvent(PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE));
      this.updateActiveAutomationRun({
        status: "error",
        message: PI_TURN_ABSOLUTE_TIMEOUT_MESSAGE,
        clear: true,
      });
    } catch (error) {
      console.error("[ChatThreadDO] failed to surface absolute timeout to client", error);
    }

    this.disposePiSession();
    this.activePiStreamTurnId = null;
    this.pendingPiPromptQueue = [];
    this.piStreamWriter = null;
    try {
      await this.clearPiActiveTurnAndJournal();
    } catch (error) {
      console.error("[ChatThreadDO] failed to clear active turn after absolute timeout", error);
    }
    this.setActiveTurnUserId(null);
    this.finishTurn({ markUnread: true });
  }

  /**
   * Break-glass: force a hung/zombie thread idle. Disposes any live Pi session,
   * clears the active-turn marker + journal, stops lease/tool intervals, and
   * broadcasts idle. Safe to call when no turn is active (no-op-ish cleanup).
   * Intended for admin_js_exec / ops against known billing zombies.
   */
  async forceClearHungTurn(reason = "admin_force_clear"): Promise<{
    cleared: boolean;
    hadMarker: boolean;
    hadSession: boolean;
    reason: string;
  }> {
    const hadMarker = this.readPiActiveTurn() !== null;
    const hadSession = this.piSession !== null;
    this.recordChatThreadObservabilityEvent("pi_turn_force_cleared", {
      operation: "force_clear_hung_turn",
      status: "cleared",
      severity: "warn",
      error: reason,
    });
    this.stopPiTurnAbsoluteTimeoutWatchdog();
    this.clearPiToolKeepAliveInterval();
    this.disposePiSession();
    this.activePiStreamTurnId = null;
    this.pendingPiPromptQueue = [];
    this.piStreamWriter = null;
    this.piPendingTransientTurnRetry = null;
    this.piTransientRetryBackoffAbort?.abort();
    this.piTransientRetryBackoffAbort = null;
    try {
      await this.clearPiActiveTurnAndJournal();
    } catch (error) {
      console.error("[ChatThreadDO] forceClearHungTurn failed to clear marker", error);
    }
    this.setActiveTurnUserId(null);
    this.finishTurn();
    return { cleared: true, hadMarker, hadSession, reason };
  }

  /**
   * Turn-completion bookkeeping. Records the assistant completion / summary /
   * automation result exactly once per turn — idempotency rides on
   * {@link assistantCompletionRecordedAt}, NOT on any stored streaming flag — and
   * broadcasts the now-idle derived state. Safe to call on any terminal path
   * (agent_end, resume completion, or error/abort cleanup).
   */
  private finishTurn(
    options: { markUnread?: boolean; completedAt?: number; summarySource?: string | null } = {},
  ): void {
    const shouldRecordCompletion =
      options.markUnread === true && this.assistantCompletionRecordedAt === null;
    const shouldRecordCompletionSummary =
      options.markUnread === true &&
      !shouldRecordCompletion &&
      this.assistantCompletionRecordedAt !== null &&
      this.assistantCompletionSummaryRequestedAt !== this.assistantCompletionRecordedAt &&
      typeof options.summarySource === "string" &&
      options.summarySource.trim().length > 0;
    // A turn that stops after asking a browser question is still awaiting user
    // input; keep the automation run active so the eventual answer can finish it.
    if (
      shouldRecordCompletion &&
      this.activeAutomationRun &&
      this.browserPrompts.pendingQuestionCount === 0
    ) {
      this.updateActiveAutomationRun({
        status: "success",
        completedAt:
          typeof options.completedAt === "number" &&
          Number.isFinite(options.completedAt)
            ? options.completedAt
            : Date.now(),
        clear: true,
      });
    }
    this.resetRunningActivityState();
    // Turn over: the assistant/tool content was streamed and persisted through
    // ai-chat render history; the stream's `finish` chunk marks it complete. Just
    // broadcast the now-idle derived state.
    this.syncAgentState();
    const context = this.chatContext;
    if (context?.workspaceId && context.threadId) {
      if (shouldRecordCompletion) {
        const completedAt =
          typeof options.completedAt === "number" &&
          Number.isFinite(options.completedAt)
            ? options.completedAt
            : Date.now();
        this.assistantCompletionRecordedAt = completedAt;
        this.ctx.waitUntil(
          this.recordThreadAssistantCompletion(
            context,
            completedAt,
            options.summarySource ?? null,
          ).catch((error) => {
            console.error("[ChatThreadDO] failed to record assistant completion", error);
          }),
        );
      } else if (shouldRecordCompletionSummary) {
        const completedAt = this.assistantCompletionRecordedAt;
        if (completedAt === null) return;
        this.assistantCompletionSummaryRequestedAt = completedAt;
        this.ctx.waitUntil(
          this.generateAndPersistThreadAssistantCompletionSummary(
            context,
            completedAt,
            options.summarySource!,
          ).catch((error) => {
            console.error("[ChatThreadDO] failed to record assistant completion summary", error);
          }),
        );
      } else {
        // Not a completion (error/abort teardown): just clear the workspace
        // indicator. The completion branches clear it via recordThreadAssistantCompletion.
        this.pushWorkspaceStreaming(false);
      }
    }
  }

  // Thread metadata generation collaborator (see chat-thread-metadata.ts).
  // All state stays on this DO, and the memoized deps close over `this` so a
  // fake with stubbed siblings behaves exactly as when the bodies lived here.
  private get threadMetadata(): ChatThreadMetadata {
    return (this.threadMetadataInstance ??= new ChatThreadMetadata({
      chatContext: () => this.chatContext,
      env: () => this.env,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      titleGenerationInFlight: () => this.titleGenerationInFlight,
      setTitleGenerationInFlight: (value) => {
        this.titleGenerationInFlight = value;
      },
      setAssistantCompletionRecordedAt: (value) => {
        this.assistantCompletionRecordedAt = value;
      },
      setAssistantCompletionSummaryRequestedAt: (value) => {
        this.assistantCompletionSummaryRequestedAt = value;
      },
      setTitle: (title, updatedAt) => this.setTitle(title, updatedAt),
      broadcastChat: (message) => this.broadcastChat(message),
      recordWorkspaceThreadStreaming: (workspaceId, threadId, isStreaming, options) =>
        this.recordWorkspaceThreadStreaming(workspaceId, threadId, isStreaming, options),
      retryChatDurableObjectRpc: (operation, fn, options) =>
        this.retryChatDurableObjectRpc(operation, fn, options),
      recordChatThreadObservabilityEvent: (event, details) =>
        this.recordChatThreadObservabilityEvent(event, details),
      persistThreadAssistantCompletion: (context, completedAt, summary, summaryStatus) =>
        this.persistThreadAssistantCompletion(context, completedAt, summary, summaryStatus),
      recordCompletionSummaryStatus: (context, completedAt, summaryStatus, summary) =>
        this.recordCompletionSummaryStatus(context, completedAt, summaryStatus, summary),
      generateAndPersistThreadAssistantCompletionSummary: (context, completedAt, sourceText) =>
        this.generateAndPersistThreadAssistantCompletionSummary(context, completedAt, sourceText),
      generateThreadTitleFromMessage: (threadId, message) =>
        this.generateThreadTitleFromMessage(threadId, message),
      generateClaimedChatGroupAvatar: (threadId, claim, userStub) =>
        this.generateClaimedChatGroupAvatar(threadId, claim, userStub),
      maybeGenerateChatGroupAvatarForThread: (threadId, trigger) =>
        this.maybeGenerateChatGroupAvatarForThread(threadId, trigger),
      errorLogFields: (error) => this.errorLogFields(error),
    }));
  }

  private recordThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summarySource: string | null,
  ): Promise<void> {
    return this.threadMetadata.recordThreadAssistantCompletion(
      context,
      completedAt,
      summarySource,
    );
  }

  private persistThreadAssistantCompletion(
    context: ChatContextState,
    completedAt: number,
    summary: string | null,
    summaryStatus: ThreadCompletionSummaryStatus | null,
  ): Promise<AssistantCompletionPersistenceResult> {
    return this.threadMetadata.persistThreadAssistantCompletion(
      context,
      completedAt,
      summary,
      summaryStatus,
    );
  }

  private recordCompletionSummaryStatus(
    context: ChatContextState,
    completedAt: number,
    summaryStatus: ThreadCompletionSummaryStatus,
    summary?: string,
  ): Promise<void> {
    return this.threadMetadata.recordCompletionSummaryStatus(
      context,
      completedAt,
      summaryStatus,
      summary,
    );
  }

  private generateAndPersistThreadAssistantCompletionSummary(
    context: ChatContextState,
    completedAt: number,
    sourceText: string,
  ): Promise<void> {
    return this.threadMetadata.generateAndPersistThreadAssistantCompletionSummary(
      context,
      completedAt,
      sourceText,
    );
  }


  async startInitialUserMessage(
    body: InitialUserMessageRequest,
  ): Promise<InitialUserMessageResult> {
    const contextError = this.updateExternalChatContext(body);
    if (contextError) {
      return { status: "error", error: contextError };
    }

    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return { status: "error", error: "Missing message" };
    }

    const automationRun = this.normalizeActiveAutomationRun(body.automationRun);
    if (automationRun) {
      this.reconcileInactiveAutomationRun(
        "Automation run did not finish before the thread restarted",
      );
      if (
        this.activeAutomationRun ||
        this.isThreadStreaming() ||
        this.browserPrompts.pendingQuestionCount > 0
      ) {
        return {
          status: "busy",
          error: "Thread is busy with another run",
        };
      }
      this.setActiveAutomationRun(automationRun);
    }

    try {
      const result = await this.enqueueRunnerUserMessage({
        content: message,
        clientMessageId:
          typeof body.clientMessageId === "string" &&
          body.clientMessageId.trim()
            ? body.clientMessageId.trim()
            : undefined,
      }, {
        messageSource:
          typeof body.messageSource === "string" && body.messageSource.trim()
            ? body.messageSource.trim()
            : "web",
        persistUserMessageImmediately: true,
      });
      if (automationRun && result.status !== "accepted") {
        this.setActiveAutomationRun(null);
      }
      if (result.status !== "accepted") {
        this.pushChatEvent(
          this.chatSendErrorPayload(result.error, {
            status: result.status,
            fallbackMessage: "Failed to start initial message",
          }),
        );
      }
      return result;
    } catch (error) {
      if (automationRun) {
        this.setActiveAutomationRun(null);
      }
      this.pushChatEvent(
        this.chatSendErrorPayload(error, {
          fallbackMessage: "Failed to start initial message",
        }),
      );
      return {
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Failed to start initial message",
      };
    }
  }

  async runAgentEvalSession(
    body: AgentEvalSessionRequest,
  ): Promise<AgentEvalSessionResult> {
    this.agentEvalEventCollector = [];
    const contextError = this.updateExternalChatContext(body);
    if (contextError) {
      return await this.agentEvalResult("error", {
        error: contextError,
      });
    }

    const context = this.chatContext;
    if (!context) {
      return await this.agentEvalResult("error", {
        error: "Missing chat context for eval",
      });
    }

    const rawContent =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!rawContent) {
      return await this.agentEvalResult("error", {
        error: "Missing message",
      });
    }

    if (this.isThreadStreaming()) {
      return await this.agentEvalResult("busy", {
        error: "Thread is busy with another run",
      });
    }

    try {
      const orgBan = await isOrgBanned(this.env.APP_KV, {
        orgId: context.orgId,
      });
      if (orgBan) {
        return await this.agentEvalResult("error", {
          error: "Organization is blocked",
        });
      }

      await this.ensurePiSessionReady();
      if (!this.piSession) {
        return await this.agentEvalResult("error", {
          error: "Pi session was not available for eval",
        });
      }

      const safeContent = injectFileSafetyMessage(rawContent);
      const mentionAugmented =
        await this.applyMentionsForTurn(safeContent);
      const attributedContent = formatAttributedUserMessage(mentionAugmented, {
        userName: context.userName,
        userEmail: context.userEmail,
        messageSource:
          typeof body.messageSource === "string" && body.messageSource.trim()
            ? body.messageSource.trim()
            : "eval",
      });
      if (!attributedContent.trim()) {
        return await this.agentEvalResult("error", {
          error: "Empty message",
        });
      }

      this.setActiveTurnUserId(context.userId);
      // Turn-start bookkeeping runs from the agent_start event the prompt emits.
      this.publishRunningUserMessageActivity(rawContent);
      await this.updateThreadMetadataForUserMessage(
        attributedContent,
        body.messageSource ?? "eval",
      ).catch((error) => {
        console.error("[ChatThreadDO] failed to update eval thread metadata", error);
      });

      const userMessage: AgentMessage = {
        role: "user",
        content: attributedContent,
        timestamp: Date.now(),
      };
      await this.refreshPiSessionModel();
      await withAgentEvalTimeout(
        this.withPiTurnInactivityTimeout(async () => {
          if (!this.piSession) {
            throw new Error("Pi session was not available for eval prompt");
          }
          await this.piSession.prompt(userMessage);
        }),
        body.timeoutMs,
      );
      await this.piEventHandlerChain;

      const events = this.agentEvalEventCollector ?? [];
      const result = latestAgentEvalResult(events);
      return await this.agentEvalResult("completed", {
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[ChatThreadDO] agent eval session failed", error);
      try {
        this.piSession?.abort();
      } catch {
        // Best effort cleanup; the error below is the actionable eval failure.
      }
      this.pushChatEvent(this.piProviderErrorEvent(message));
      this.finishTurn();
      this.setActiveTurnUserId(null);
      return await this.agentEvalResult("error", {
        error: message,
      });
    }
  }



  private async agentEvalResult(
    status: AgentEvalSessionResult["status"],
    options: { error?: string; result?: string } = {},
  ): Promise<AgentEvalSessionResult> {
    const threadId = this.chatContext?.threadId ?? "";
    const events = this.agentEvalEventCollector ? [...this.agentEvalEventCollector] : [];
    this.agentEvalEventCollector = null;
    return {
      status,
      ...options,
      events,
      messages: await this.getPiCoreParsedMessages(threadId),
      deployedApps: await collectAgentEvalDeployedApps(this.env, {
        orgId: this.chatContext?.orgId,
        workspaceId: this.chatContext?.workspaceId,
      }),
    };
  }


  private hasAvailableBrowserUser(): boolean {
    return this.getChatSockets().length > 0;
  }

  private updateExternalChatContext(payload: {
    threadId?: string;
    workspaceId?: string;
    orgId?: string;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
  }): string | null {
    const threadId =
      typeof payload.threadId === "string" ? payload.threadId.trim() : "";
    const workspaceId =
      typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";
    const orgId = typeof payload.orgId === "string" ? payload.orgId.trim() : "";
    if (!threadId || !workspaceId || !orgId) {
      return "Missing thread/workspace/org context";
    }

    if (this.chatContext?.threadId && this.chatContext.threadId !== threadId) {
      return "Thread context mismatch";
    }

    this.chatContext = {
      threadId,
      workspaceId,
      orgId,
      userId:
        typeof payload.userId === "string" && payload.userId.trim()
          ? payload.userId.trim()
          : this.chatContext?.userId ?? null,
      userName:
        typeof payload.userName === "string" && payload.userName.trim()
          ? payload.userName.trim()
          : this.chatContext?.userName ?? null,
      userEmail:
        typeof payload.userEmail === "string" && payload.userEmail.trim()
          ? payload.userEmail.trim()
          : this.chatContext?.userEmail ?? null,
    };
    this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, this.chatContext);
    return null;
  }

  private async autoAnswerPendingQuestionAsUnavailable(
    questionId: string,
    unavailableMessage: string,
  ): Promise<boolean> {
    const sent = this.sendRunnerCommand({
      type: "question_response",
      questionId,
      answers: {
        unavailable_reason: unavailableMessage,
      },
    });
    if (sent) {
      this.browserPrompts.deletePendingQuestion(questionId);
      this.syncAgentState();
    }
    return sent;
  }

  private async autoAnswerAllPendingQuestionsAsUnavailable(
    unavailableMessage: string,
  ): Promise<void> {
    const questionIds = this.browserPrompts.pendingQuestionIds();
    for (const questionId of questionIds) {
      try {
        await this.autoAnswerPendingQuestionAsUnavailable(
          questionId,
          unavailableMessage,
        );
      } catch (err) {
        console.error(
          "[ChatThreadDO] failed to auto-answer pending ask_user_question",
          {
            questionId,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }

  private updateThreadMetadataForUserMessage(
    messageContent: string,
    messageSource?: string | null,
  ): Promise<void> {
    return this.threadMetadata.updateThreadMetadataForUserMessage(
      messageContent,
      messageSource,
    );
  }

  private errorLogFields(error: unknown): {
    errorName: string;
    errorMessage: string;
  } {
    return this.threadMetadata.errorLogFields(error);
  }

  private generateClaimedChatGroupAvatar(
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
    return this.threadMetadata.generateClaimedChatGroupAvatar(
      threadId,
      claim,
      userStub,
    );
  }

  private maybeGenerateChatGroupAvatarForThread(
    threadId: string,
    trigger?: ChatGroupIconGenerationClaim["trigger"],
  ): Promise<void> {
    return this.threadMetadata.maybeGenerateChatGroupAvatarForThread(
      threadId,
      trigger,
    );
  }

  private generateThreadTitleFromMessage(threadId: string, message: string): Promise<void> {
    return this.threadMetadata.generateThreadTitleFromMessage(threadId, message);
  }

  private async ensurePiSessionReady(): Promise<void> {
    await this.withRunnerTransitionLock("ensure_pi_session_ready", async () => {
      if (this.piSession) {
        return;
      }

      const baseContext = this.chatContext;
      if (!baseContext) {
        throw new Error("Missing chat context");
      }

      const orgId = this.env.ORG.idFromName(baseContext.orgId);
      const getOrgStub = () => this.env.ORG.get(orgId);
      const [thread, llmProviderRecord, orgInfo] = await Promise.all([
        this.retryChatDurableObjectRpc(
          "OrgDO.getThread",
          () => getOrgStub().getThread(baseContext.threadId),
          { attempts: 4, initialDelayMs: 150 },
        ),
        this.getCachedLlmProviderConfig(baseContext.orgId),
        typeof getOrgStub().getInfo === "function"
          ? this.retryChatDurableObjectRpc(
              "OrgDO.getInfo",
              () => getOrgStub().getInfo(),
              { attempts: 4, initialDelayMs: 150 },
            )
          : Promise.resolve(null),
      ]);
      const context: ChatContextState = { ...baseContext };
      this.chatContext = context;
      this.ctx.storage.kv.put(CHAT_CONTEXT_KEY, context);
      const threadWorkspaceId =
        thread && typeof thread === "object" && "workspace_id" in thread
          ? (thread as { workspace_id?: unknown }).workspace_id
          : null;
      const effectiveLlmProviderRecord = getEffectiveLlmProviderConfig(
        this.env,
        llmProviderRecord,
      );
      const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderRecord);
      const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderRecord);
      const billingStatus = orgInfo?.billing_status ?? "inactive";
      const totalCreditsCents =
        (orgInfo?.billing_credit_purchase_total_cents ?? 0) +
        (orgInfo?.billing_credit_grant_total_cents ?? 0);
      const shouldDefaultToCamelCode = Boolean(
        orgInfo &&
          !isSelfhostRuntime(this.env) &&
          !effectiveLlmProviderRecord &&
          billingStatus !== "enterprise" &&
          billingStatus !== "trialing" &&
          billingStatus !== "active" &&
          totalCreditsCents <= 0,
      );
      const storedThreadModel =
        thread && threadWorkspaceId === context.workspaceId
          ? (thread as { model?: unknown }).model
          : undefined;
      const threadModel =
        storedThreadModel === CUSTOM_LLM_MODEL
          ? normalizeLlmModel(storedThreadModel, effectiveLlmProviderRecord?.provider, {
              customApi,
              customModelId,
            })
          : storedThreadModel !== undefined
            ? normalizeLlmModel(storedThreadModel)
          : shouldDefaultToCamelCode
            ? CAMEL_CODE_LLM_MODEL
            : normalizeLlmModel(undefined, effectiveLlmProviderRecord?.provider, {
                customApi,
                customModelId,
              });
      // Keep the in-memory model aligned with the durable thread before any
      // refresh rebuilds the tool surface. Without this, an explicitly selected
      // camelCode thread initially receives Oracle, then refreshPiSessionModel()
      // immediately removes it because currentThreadModel is still null.
      this.currentThreadModel = threadModel;
      const storedModelChangedAt =
        thread && typeof thread === "object" && "last_model_changed_at" in thread
          ? (thread as { last_model_changed_at?: unknown }).last_model_changed_at
          : null;
      this.currentThreadModelUpdatedAt =
        typeof storedModelChangedAt === "number" && Number.isFinite(storedModelChangedAt)
          ? storedModelChangedAt
          : this.currentThreadModelUpdatedAt;
      await this.ensurePiSession(context, {
        CHIRIDION_MODEL: threadModel,
        CHIRIDION_CLAUDE_MODEL: threadModel,
        CHIRIDION_CODEX_MODEL: threadModel,
      });
    });
  }

  private async ensurePiSession(
    context: ChatContextState,
    envVars: Record<string, string>,
  ): Promise<PiCoreAgent> {
    if (this.piSession) {
      return this.piSession;
    }
    if (this.piSessionPromise) {
      return await this.piSessionPromise;
    }

    this.piSessionPromise = this.createPiSession(context, envVars)
      .then((session) => {
        this.piSession = session;
        return session;
      })
      .finally(() => {
        this.piSessionPromise = null;
      });

    return await this.piSessionPromise;
  }

  private async createPiSession(
    context: ChatContextState,
    envVars: Record<string, string>,
  ): Promise<PiCoreAgent> {
    const { Agent } = await import("@earendil-works/pi-agent-core");
    const { completeSimple, getModel, streamSimple } = await import("@earendil-works/pi-ai/compat");

    this.piUnsubscribe?.();
    this.piUnsubscribe = null;
    this.piActiveItemId = null;
    this.piAssistantText = "";

    const resolveCurrentModel = () => this.resolvePiModel(context, envVars, getModel);
    const modelConfig = await resolveCurrentModel();
    this.piModelResolver = resolveCurrentModel;
    const persistedMessages = await this.withChatMemoryPhase("pi_session_load", () =>
      this.loadPiCoreMessages({ imagePolicy: "reference" }),
    );
    let initialMessages = [...persistedMessages];
    this.piMainBaselineIndex = persistedMessages.length;
    // Resume an interrupted turn: fold the journaled in-flight tail back in and
    // reconcile (synthesize interrupted results for dispatched-but-unfinished
    // tools; reorder reasoning ahead of tool calls). The synthesized/reordered
    // tail commits at the next turn_end via appendPiCoreMessagesIfMissing, so we
    // keep the committed-message count as the baseline (and never persist the
    // virtual compaction-summary prefix).
    if (this.readPiActiveTurn()) {
      const journalTail = await this.loadPiTurnJournalTail();
      // If the DO was evicted mid-turn_end — after some journaled messages were
      // already appended to pi_core_messages but before the journal was cleared —
      // those messages live in BOTH stores. Drop journal entries already committed
      // (by the same identity appendPiCoreMessagesIfMissing dedups on) so we don't
      // fold a duplicated user/assistant/tool sequence into the resumed transcript.
      const committedKeys = new Set(
        persistedMessages.map((message) => piCoreMessageKey(message)),
      );
      const uncommittedTail = journalTail.filter(
        (message) => !committedKeys.has(piCoreMessageKey(message)),
      );
      // Re-deliver any steer()'d messages that never made it into the turn journal
      // before eviction. Dedup against both committed history and the journal tail:
      // a steer that already drained into messages (and committed, or sits in the
      // tail) carries the same piCoreMessageKey, so it is folded once, never twice.
      const tailKeys = new Set(
        uncommittedTail.map((message) => piCoreMessageKey(message)),
      );
      const pendingSteer = (await this.loadPiTurnSteerJournal()).filter((message) => {
        const key = piCoreMessageKey(message);
        return !committedKeys.has(key) && !tailKeys.has(key);
      });
      const plan = planPiTurnResume(persistedMessages, [
        ...uncommittedTail,
        ...pendingSteer,
      ]);
      initialMessages = [...plan.messages];
      this.recordChatThreadObservabilityEvent("pi_turn_recovered", {
        operation: "resume_interrupted_turn",
        status: plan.owesModelOutput ? "continue" : "complete",
        count: plan.interruptedToolResults,
        size: plan.messages.length,
      });
    }
    const session = new Agent({
      initialState: {
        systemPrompt: this.createPiSystemPrompt(context, envVars),
        model: capPiMainRequestOutput(modelConfig.model),
        tools: this.createPiToolDefinitions(context, {
          includeOracle: this.isCamelCodeActive(envVars),
        }),
        messages: initialMessages,
        thinkingLevel: "medium",
      },
      transformContext: (messages, signal) =>
        this.withChatMemoryPhase("provider_request_prepare", async () => {
          const current = await resolveCurrentModel();
          const compacted = await this.compactPiContext(
            messages,
            current.model,
            current.apiKey,
            completeSimple,
            signal,
          );
          const hydrated = await this.hydratePiStoredImages(
            compacted.map((message) => sanitizePiModelMessage(message)),
          ) as AgentMessage[];
          const repaired = repairPiMessageHistoryForReplay(hydrated);
          return repaired.messages;
        }),
      getApiKey: async () => {
        const current = await resolveCurrentModel();
        if (this.piSession) {
          this.piSession.state.model = capPiMainRequestOutput(current.model);
          this.refreshPiSessionCapabilitySurface(context, envVars);
        }
        return current.apiKey;
      },
      beforeToolCall: (toolContext, signal) =>
        this.beforePiToolCall(toolContext, signal),
      afterToolCall: (toolContext, signal) =>
        this.afterPiToolCall(toolContext, signal),
      streamFn: (model, llmContext, options) =>
        this.streamPiModel(model, llmContext, options, streamSimple),
      sessionId: context.threadId,
      toolExecution: "parallel",
    });

    this.piUnsubscribe = session.subscribe((event) => {
      const handled = this.piEventHandlerChain
        .catch(() => undefined)
        .then(() => this.handlePiSessionEvent(event));
      this.piEventHandlerChain = handled;
      this.ctx.waitUntil(
        handled.catch((error) => {
          console.error("[ChatThreadDO] Pi event handler failed", error);
        }),
      );
      return handled;
    });
    return session;
  }

  private createPiSystemPrompt(
    context: ChatContextState,
    envVars?: Record<string, string>,
  ): string {
    const base = createPiSystemPrompt(context, {
      skillNames: PI_SKILL_NAMES,
      skillDescriptions: PI_SKILL_DESCRIPTIONS,
      oracleAvailable: this.isCamelCodeActive(envVars),
    });
    const verifiedWorkState = formatVerifiedWorkStatePrompt(
      this.ctx?.storage?.kv?.get<unknown>(CHAT_VERIFIED_WORK_STATE_KEY),
    );
    return verifiedWorkState ? `${base}\n\n${verifiedWorkState}` : base;
  }

  private async compactPiContext(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
    signal?: AbortSignal,
    force = false,
  ): Promise<AgentMessage[]> {
    const contextWindow = piModelContextWindow(model);
    const reserveTokens = piCompactionReserveTokens(model);
    const keepRecentTokens = 20_000;
    // Three sources, most trustworthy first: what the provider actually charged
    // for everything up to the last turn (exact and free), plus a real BPE
    // count of only the messages added since (accurate, and cheap because that
    // tail is small). The character heuristic alone used to decide this, and it
    // read 137,964 tokens for a request the provider billed at 216,184 — far
    // enough under the threshold that compaction never ran while the thread was
    // already too full to answer.
    const tokens = await measurePiContextTokens(messages, contextWindow);
    if (!force && tokens < contextWindow - reserveTokens) {
      return messages;
    }

    const existing = this.loadPiCoreCompaction();
    const startsWithExistingSummary =
      Boolean(existing) && isPiSummaryMessage(messages[0]);
    if (existing && startsWithExistingSummary) {
      if (tokens < contextWindow - reserveTokens) {
        return messages;
      }
    } else if (existing && existing.firstKeptIndex > 0 && existing.firstKeptIndex < messages.length) {
      const tail = messages.slice(existing.firstKeptIndex);
      if (effectivePiContextTokens([
        createPiSummaryMessage(existing.summary),
        ...tail,
      ]) < contextWindow - reserveTokens) {
        return [createPiSummaryMessage(existing.summary), ...tail];
      }
    }

    const firstKeptIndex = findPiCompactionCutIndex(messages, keepRecentTokens);
    if (firstKeptIndex <= 0 || firstKeptIndex >= messages.length) {
      return messages;
    }

    const previousSummary = existing?.summary;
    const messagesToSummarize = messages.slice(0, firstKeptIndex);
    const storedFirstKeptIndex =
      existing && startsWithExistingSummary
        ? existing.firstKeptIndex + Math.max(0, firstKeptIndex - 1)
        : firstKeptIndex;
    try {
      const summary = await summarizePiMessages(
        messagesToSummarize,
        model,
        apiKey,
        completeSimple,
        signal,
        previousSummary,
      );
      this.persistPiCoreCompaction(summary, storedFirstKeptIndex);
      return [createPiSummaryMessage(summary), ...messages.slice(firstKeptIndex)];
    } catch (error) {
      console.error("[ChatThreadDO] Pi context compaction failed", error);
      const fallbackSummary = createFallbackPiCompactionSummary(
        messagesToSummarize,
        error,
      );
      this.persistPiCoreCompaction(fallbackSummary, storedFirstKeptIndex);
      return [createPiSummaryMessage(fallbackSummary), ...messages.slice(firstKeptIndex)];
    }
  }

  /**
   * A turn whose input filled the context window stops with `length` before it
   * can say anything. Left alone this reads to the user as the agent silently
   * ignoring them — the case that wedged a production thread for five hours
   * across eleven unanswered messages, with nothing in the error telemetry
   * because a `length` stop is not a provider error. Record it and return text
   * to surface, so the turn explains itself instead of rendering blank.
   * Post-turn compaction (scheduled from the same `agent_end`) shrinks the
   * history, so the user's next message has room to run.
   */
  private piContextExhaustionNotice(messages: AgentMessage[]): string {
    const model = this.piSession?.state.model;
    const contextWindow = piModelContextWindow(model);
    const latest = latestPiAssistantMessage(messages);
    if (!latest || !isPiLengthStopContextExhaustion(latest, contextWindow)) {
      return "";
    }

    const usage = (latest as unknown as { usage?: { input?: unknown; cacheRead?: unknown } }).usage;
    const inputTokens =
      Math.max(0, Math.floor(Number(usage?.input ?? 0))) +
      Math.max(0, Math.floor(Number(usage?.cacheRead ?? 0)));
    this.recordChatThreadObservabilityEvent("chat_context_exhausted", {
      operation: "pi_turn",
      status: "context_exhausted",
      severity: "error",
      count: inputTokens,
      size: contextWindow,
      model: typeof model?.id === "string" ? model.id : null,
      provider: this.piCurrentUsageProvider || null,
      error: new Error(
        `Pi turn stopped at length with no usable output: ${inputTokens} input tokens against a ${contextWindow} context window`,
      ),
    });

    return (
      "This conversation has grown past what the model can read in one go, so that turn had no room left to answer. " +
      "I've just compacted the earlier history — send your message again and I'll pick it up. " +
      "If it keeps happening, starting a fresh chat for this task will give me the most room to work."
    );
  }

  private maybeSchedulePiPostTurnCompaction(messages: AgentMessage[]): void {
    const latestAssistant = latestPiAssistantMessage(messages);
    if (!latestAssistant || !shouldCompactPiAfterAssistantUsage(latestAssistant, this.piSession?.state.model)) {
      return;
    }

    this.ctx.waitUntil(
      this.compactPiContextAfterTurn(latestAssistant).catch((error) => {
        console.error("[ChatThreadDO] Pi post-turn compaction failed", error);
      }),
    );
  }

  private async compactPiContextAfterTurn(triggerMessage: AgentMessage): Promise<void> {
    const resolver = this.piModelResolver;
    const session = this.piSession;
    if (!resolver || !session) return;

    // `agent_end` fires from inside the Pi run, and `isStreaming` is only
    // cleared afterwards in the agent's `finally` (`finishRun`). Guarding on it
    // here without waiting meant this method returned on its very first check
    // every single time, so post-turn compaction never ran in production: a
    // thread that outgrew its window stayed oversized forever and every later
    // turn died with nothing to show the user. Wait for the run to settle
    // first. Safe to await because the caller schedules this via `waitUntil`
    // and does not block `agent_end` on it — awaiting inside the listener
    // itself would deadlock, since `waitForIdle` only resolves after listeners
    // settle.
    await session.waitForIdle();

    if (
      session.state.isStreaming ||
      !shouldCompactPiAfterAssistantUsage(triggerMessage, session.state.model)
    ) {
      return;
    }

    const completeSimple = await loadPiCompleteSimple();
    const current = await resolver();
    if (
      session.state.isStreaming ||
      !shouldCompactPiAfterAssistantUsage(triggerMessage, current.model)
    ) {
      return;
    }

    const before = session.state.messages;
    const compacted = await this.compactPiContext(
      before,
      current.model,
      current.apiKey,
      completeSimple,
      undefined,
      true,
    );
    if (compacted === before || session.state.isStreaming || session.state.messages !== before) {
      return;
    }

    session.state.messages = compacted;
    // Compaction only summarizes away rows the render mirror already shows;
    // "preserve" keeps the visible history and re-pins the top-up mark to the
    // rewritten (shorter) parsed count.
    await this.replacePiCoreMessages(compacted, { uiRender: "preserve" });
    this.clearPiCoreCompaction();
    this.piMainBaselineIndex = compacted.length;
  }

  private resolvePiModel(
    context: ChatContextState,
    envVars: Record<string, string>,
    getModelFn: (provider: never, modelId: never) => Model<any>,
    options: { sponsoredCapability?: boolean } = {},
  ): Promise<PiResolvedModelConfig> {
    const sponsoredCapability = options.sponsoredCapability === true;
    return resolvePiModelConfig(
      {
        env: this.env,
        modelMapping: this.piModelMapping,
        resolveRequestConfig: (resolved, ctx, requestedModelId) =>
          this.resolvePiRequestConfig(resolved, ctx, requestedModelId, {
            forceHosted: sponsoredCapability,
            creditChargeable: sponsoredCapability ? false : undefined,
          }),
        onBillingResolved: (billingSource, creditChargeable, usageProvider) => {
          if (sponsoredCapability) return;
          this.piCurrentBillingSource = billingSource;
          this.piCurrentCreditChargeable = creditChargeable;
          this.piCurrentUsageProvider = usageProvider;
        },
        onHostedModelFallback: sponsoredCapability
          ? undefined
          : (requestedModel, fallbackModel, reason) =>
              this.fallbackThreadToFreeModel(
                context,
                requestedModel,
                fallbackModel,
                reason,
              ),
      },
      context,
      envVars,
      getModelFn,
    );
  }

  private resolvePiRequestConfig(
    resolved: PiResolvedModelReference,
    context: ChatContextState,
    requestedModelId: string,
    options: { forceHosted?: boolean; creditChargeable?: boolean } = {},
  ): Promise<PiRequestConfig> {
    return resolvePiRequestConfig(
      {
        env: this.env,
        modelMapping: this.piModelMapping,
        forceHosted: options.forceHosted,
        getChatMetadata: () => this.chatContext,
        resolveByokCredentials: (ctx, byokOptions) =>
          this.resolveCurrentByokCredentials(ctx, byokOptions),
        checkHostedModelAccess: options.creditChargeable === undefined
          ? (ctx, model) => this.checkHostedPiModelAccess(ctx, model)
          : async () => ({
              creditChargeable: options.creditChargeable ?? false,
              vllmPriority: FREE_VLLM_PRIORITY,
            }),
      },
      resolved,
      context,
      requestedModelId,
    );
  }

  private resolvePiCapabilityModel(
    context: ChatContextState,
    modelId: string,
    getModelFn: (provider: never, modelId: never) => Model<any>,
  ): Promise<PiResolvedModelConfig> {
    return this.resolvePiModel(
      context,
      {
        CHIRIDION_MODEL: modelId,
        CHIRIDION_CODEX_MODEL: modelId,
        CHIRIDION_CLAUDE_MODEL: modelId,
      },
      getModelFn,
      { sponsoredCapability: true },
    );
  }

  private async consumeCapabilityAllowance(
    context: ChatContextState,
    capability: HostedCapability,
    idempotencyKey: string,
  ): Promise<{ allowed: boolean; remaining: number | null; reset_at_ms: number }> {
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    return await orgStub.consumeCapabilityAllowance({
      capability,
      user_id: context.userId ?? undefined,
      idempotency_key: idempotencyKey,
    });
  }

  private isCamelCodeActive(envVars?: Record<string, string>): boolean {
    const requested =
      envVars?.CHIRIDION_MODEL ||
      envVars?.CHIRIDION_CODEX_MODEL ||
      envVars?.CHIRIDION_CLAUDE_MODEL;
    return (requested ?? this.currentThreadModel) === CAMEL_CODE_LLM_MODEL;
  }


  private checkHostedPiModelAccess(
    context: ChatContextState,
    model?: string,
  ): Promise<HostedModelAccess> {
    return checkHostedPiModelAccess(this.env, context, model);
  }

  private async fallbackThreadToFreeModel(
    context: ChatContextState,
    requestedModel: string,
    fallbackModel: string,
    reason: HostedModelFallbackReason = "hosted_credits_exhausted",
  ): Promise<void> {
    if (fallbackModel !== CAMEL_CODE_LLM_MODEL) {
      throw new Error(`Unsupported hosted-credit fallback model ${fallbackModel}`);
    }

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    const updated = await orgStub.updateThreadModel(
      context.threadId,
      CAMEL_CODE_LLM_MODEL,
      context.userId ?? undefined,
      normalizeLlmModel(requestedModel),
    );
    if (!updated) {
      // A user may have selected another model while hosted access was being
      // checked. The compare-and-set in OrgDO protects that newer choice.
      return;
    }

    this.currentThreadModel = updated.model;
    this.currentThreadModelUpdatedAt = updated.updated_at;
    this.modelFallbackNotice = {
      id: crypto.randomUUID(),
      fromModel: requestedModel,
      toModel: CAMEL_CODE_LLM_MODEL,
      reason,
      createdAt: Date.now(),
    };
    this.syncAgentState();
  }

  /**
   * Read OrgDO.getLlmProviderConfig with a short TTL cache.
   *
   * BYOK provider config changes only on rare admin action but is read on
   * every turn across all of an org's threads, hammering the single OrgDO
   * instance. Within the TTL we serve the cached value (including a cached
   * null) and skip the RPC entirely. On a transient RPC failure we fall back
   * to any cached value (even an expired one); with no cached value we
   * propagate the error exactly as the underlying retry wrapper would.
   *
   * The cache is keyed defensively on orgId: a ChatThreadDO instance belongs
   * to a single thread/org, so a mismatch indicates a bug and forces a fresh
   * read rather than serving another org's config.
   */
  /**
   * Read OrgDO.getLlmProviderConfig once per agent turn.
   *
   * The Pi agent loop resolves provider credentials on every LLM call
   * (transformContext), which previously fanned one OrgDO RPC per call into
   * the single OrgDO instance. The cache is cleared at agent_start and by
   * byokChanged(), so each turn reads the config exactly once (first LLM
   * call) and reuses it for the rest of the turn: provider config is
   * constant within a turn by design. Caches both null and non-null records;
   * keyed defensively on orgId so a mismatch forces a fresh read. RPC
   * failures propagate exactly as before (the retry wrapper absorbs
   * transient blips).
   */
  private async getCachedLlmProviderConfig(
    orgId: string,
  ): Promise<LlmProviderConfigRecord> {
    const cached = this.cachedLlmProviderConfig;
    if (cached && cached.orgId === orgId) {
      return cached.value;
    }

    const orgDoId = this.env.ORG.idFromName(orgId);
    const getOrgStub = () => this.env.ORG.get(orgDoId);
    const value = await this.retryChatDurableObjectRpc(
      "OrgDO.getLlmProviderConfig",
      () => getOrgStub().getLlmProviderConfig(),
      { attempts: 4, initialDelayMs: 150 },
    );
    this.cachedLlmProviderConfig = { orgId, value };
    return value;
  }

  private resolveCurrentByokCredentials(
    context: ChatContextState,
    options: { includeOpenAiSubscription: boolean },
  ) {
    return resolveCurrentByokCredentials(
      this.env,
      (orgId) => this.getCachedLlmProviderConfig(orgId),
      context,
      options,
    );
  }

  private streamPiModel(
    model: Model<any>,
    context: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[1],
    options: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[2],
    streamSimple: typeof import("@earendil-works/pi-ai/compat").streamSimple,
  ): ReturnType<typeof import("@earendil-works/pi-ai/compat").streamSimple> {
    // The subscription egress endpoint is an HTTP reverse proxy. Keep Codex
    // traffic on the Responses SSE transport so Pi does not attempt a separate
    // WebSocket upgrade path before making the proven HTTP request.
    const effectiveOptions =
      model.api === "openai-codex-responses" && this.env.OPENAI_CODEX_PROXY_BASE_URL
        ? { ...options, transport: "sse" as const }
        : options;
    return streamPiModelWithTransientRetry(
      model,
      effectiveOptions,
      () => streamSimple(model, context, effectiveOptions),
      (message, status, attempt, forwardedEvent) =>
        this.recordPiProviderStreamTerminalError(model, message, status, attempt, forwardedEvent),
    ) as ReturnType<typeof import("@earendil-works/pi-ai/compat").streamSimple>;
  }


  private recordPiProviderStreamTerminalError(
    model: Model<any>,
    message: string,
    status: PiProviderStreamTerminalStatus,
    attempt: number,
    forwardedEvent: boolean,
  ): void {
    console.warn("[ChatThreadDO] Pi provider stream error", {
      provider: this.piCurrentUsageProvider || model.provider,
      model: model.id,
      status,
      attempt,
      forwardedEvent,
      error: message,
    });
  }


  private scopedCodeModeTools(
    context: ChatContextState,
    options: { allowWebTools?: boolean } = {},
  ): CodeModeToolsBinding {
    return (this.ctx.exports as unknown as {
      CodeModeToolsBinding(init: { props: CodeModeToolsProps }): CodeModeToolsBinding;
    }).CodeModeToolsBinding({
      props: {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId: context.userId ?? undefined,
        allowWebTools: options.allowWebTools === true,
      },
    });
  }

  // The Pi tool surface (executor-style tool list, Agent/Explore subagent
  // runner, subagent system prompt) lives in ./chat-thread/pi-tools. The deps
  // object closes over `this` per call, and sibling entries route back through
  // the same-named delegates below, so dynamic dispatch (instance stubs,
  // subclass overrides, prototype `.call(fake)` test seams) is preserved.
  private piToolSurfaceDeps(): PiToolSurfaceDeps {
    return {
      scopedCodeModeTools: (context, options) => this.scopedCodeModeTools(context, options),
      keepPiTurnToolProgressAliveWhile: <T,>(fn: () => Promise<T>) =>
        this.keepPiTurnToolProgressAliveWhile(fn),
      runCodeModeJavascript: (request) => this.runCodeModeJavascript(request),
      resolvePiModel: (context, envVars, getModelFn) =>
        this.resolvePiModel(context, envVars, getModelFn),
      resolvePiCapabilityModel: (context, modelId, getModelFn) =>
        this.resolvePiCapabilityModel(context, modelId, getModelFn),
      consumeCapabilityAllowance: (context, capability, idempotencyKey) =>
        this.consumeCapabilityAllowance(context, capability, idempotencyKey),
      piModelResolver: () => this.piModelResolver,
      afterPiToolCall: (toolContext, signal, options) =>
        this.afterPiToolCall(toolContext, signal, options),
      beforePiToolCall: (toolContext, signal) =>
        this.beforePiToolCall(toolContext, signal),
      streamPiModel: (model, llmContext, options, streamSimple) =>
        this.streamPiModel(model, llmContext, options, streamSimple),
      recordPiAssistantUsage: (message, durationMs, billingSource, creditChargeable, usageProvider) =>
        this.recordPiAssistantUsage(message, durationMs, billingSource, creditChargeable, usageProvider),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      createPiToolDefinitions: (context, options) =>
        this.createPiToolDefinitions(context, options),
      runPiSubagentTool: (context, toolName, params, signal, onUpdate) =>
        this.runPiSubagentTool(context, toolName, params, signal, onUpdate),
      createPiSubagentSystemPrompt: (context, isExplore) =>
        this.createPiSubagentSystemPrompt(context, isExplore),
    };
  }

  private createPiToolDefinitions(
    context: ChatContextState,
    options: PiToolDefinitionOptions = {},
  ): AgentTool[] {
    return createPiToolDefinitions(this.piToolSurfaceDeps(), context, options);
  }

  private async runPiSubagentTool(
    context: ChatContextState,
    toolName: "Agent" | "Explore",
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (partialResult: AgentToolResult<unknown>) => void,
  ): Promise<AgentToolResult<unknown>> {
    return runPiSubagentTool(this.piToolSurfaceDeps(), context, toolName, params, signal, onUpdate);
  }

  private async createPiSubagentSystemPrompt(
    context: ChatContextState,
    isExplore: boolean,
  ): Promise<string> {
    return createPiSubagentSystemPrompt(context, isExplore);
  }

  private pushPiRuntimeEvent(method: string, params: Record<string, unknown>): void {
    this.pushChatEvent({
      type: "runtime_event",
      event: {
        method,
        params,
      },
    });
  }

  private piRuntimeThreadId(): string {
    return this.chatContext?.threadId || "";
  }

  private rememberPiToolArgs(toolCallId: string, args: Record<string, unknown>): Record<string, unknown> {
    const existing = this.piToolArgs.get(toolCallId) ?? {};
    const merged = { ...existing, ...args };
    this.piToolArgs.set(toolCallId, merged);
    return merged;
  }

  private recallPiToolArgs(toolCallId: string, args: Record<string, unknown>): Record<string, unknown> {
    const existing = this.piToolArgs.get(toolCallId) ?? {};
    const merged = { ...existing, ...args };
    this.piToolArgs.delete(toolCallId);
    return merged;
  }

  /**
   * Close out a tool's timing at tool_execution_end: emit the `tool_calls` lake
   * row and retain the duration so the commit path can stamp it onto the
   * persisted toolResult row. Returns null when no matching start was seen (a
   * resumed turn whose start event predates this DO instance), so callers can
   * omit the field rather than publish a fabricated zero.
   */
  private settlePiToolDuration(
    toolCallId: string,
    toolName: string,
    isError: boolean,
    result: unknown,
  ): number | null {
    const startedAtMs = this.piToolStartedAtMs.get(toolCallId);
    this.piToolStartedAtMs.delete(toolCallId);
    if (typeof startedAtMs !== "number") return null;
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    this.piToolDurationMs.set(toolCallId, durationMs);
    const context = this.chatContext;
    sendToolCallRecords(this.env, [{
      ingested_at_ms: Date.now(),
      ts_ms: startedAtMs,
      thread_id: context?.threadId ?? "",
      org_id: context?.orgId ?? "",
      workspace_id: context?.workspaceId ?? "",
      user_id: context?.userId ?? "",
      turn_id: this.activePiStreamTurnId ?? "",
      tool_call_id: toolCallId,
      parent_tool_call_id: "",
      tool_name: toolName,
      surface: "agent",
      model: this.piSession?.state.model?.id ?? "",
      provider: this.piCurrentUsageProvider ?? "",
      duration_ms: durationMs,
      ok: !isError,
      error_message: isError ? boundLakeErrorMessage(piToolResultText(result)) : "",
      blocks_on_human: toolBlocksOnHuman(toolName),
      result_chars: piToolResultText(result).length,
    }]);
    return durationMs;
  }

  /** Duration measured for a settled tool call, consumed at commit time. */
  private takePiToolDurationMs(toolCallId: string): number | undefined {
    const durationMs = this.piToolDurationMs.get(toolCallId);
    if (durationMs === undefined) return undefined;
    this.piToolDurationMs.delete(toolCallId);
    return durationMs;
  }

  private async handlePiSessionEvent(event: AgentEvent): Promise<void> {
    this.touchPiTurnProgress();
    if (event.type === "agent_start") {
      this.piAssistantText = "";
      this.piActiveItemText = "";
      this.piActiveItemId = null;
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      // In-flight timings must not outlive the run that opened them: a tool
      // whose end event never arrived would otherwise attach its stale start to
      // a later call that reuses the id.
      this.piToolStartedAtMs.clear();
      this.piToolDurationMs.clear();
      this.piToolFailures = new Map();
      this.piToolFailureRecordedCallIds = new Set();
      this.piAgentStartedAtMs = Date.now();
      this.piTurnStartedAtMs = Date.now();
      this.piUserStopRequestedAtMs = 0;
      this.piLastTurnUsage = null;
      this.piSdkTurnIndex = 0;
      this.piSdkTurnUsageTotal = null;
      // Provider config is read once per agent turn: the first LLM call after
      // this re-reads from OrgDO and every later call in the turn reuses it.
      this.cachedLlmProviderConfig = null;
      this.resetRunningActivityState();
      // Hydrate the durable badge/error before clearing lastError below, so a
      // cold-wake hydrate (guarded once) can't restore the previous turn's error
      // after we've cleared it. A fresh turn supersedes any prior terminal error.
      this.hydrateDurableStateOnce();
      this.lastError = null;
      // agent_start is the one turn-start hook for every run (prompt, resume, eval).
      this.markTurnStarted();
      // NOTE: do NOT open the recovery marker here. agent_start also fires for
      // non-fibered turns (e.g. the eval runner's direct piSession.prompt), which
      // have no cf_agents_runs row — opening a marker there would leave stale
      // recovery state that never recovers and shows the thread as busy. The
      // marker is opened only inside the chat turn's runFiber wrapper, so it
      // exists exactly when there is a durable fiber that can drive recovery.
      return;
    }

    if (event.type === "turn_start") {
      this.piTurnStartedAtMs = Date.now();
      this.piSdkTurnIndex += 1;
      this.pushPiRuntimeEvent("sdk/turn/started", {
        threadId: this.piRuntimeThreadId(),
        sdkTurnIndex: this.piSdkTurnIndex,
        startedAtMs: this.piTurnStartedAtMs,
      });
    }

    if (event.type === "turn_end") {
      if (
        this.piUserStopRequestedAtMs > 0 &&
        isAbortedPiAssistantMessage(event.message)
      ) {
        return;
      }

      if (isFailedPiAssistantMessage(event.message)) {
        this.discardUnpersistedPiSessionMessages();
        return;
      }

      const snapshot = this.piSession?.state.messages ?? [];
      const snapshotMessages = await Promise.all(
        snapshot
          .slice(this.piMainBaselineIndex)
          .map((message) => this.attachCodeModeArtifactsToToolResult(message, { consume: true })),
      );
      const newMessages = this.annotatePiProviderErrorMessages(snapshotMessages);
      if (newMessages.length > 0) {
        await this.appendPiCoreMessagesIfMissing(
          stampPiRenderMessageId(newMessages, this.activePiStreamTurnId),
        );
        this.piMainBaselineIndex = snapshot.length;
      }
      // This turn is committed to pi_core_messages; drop its journaled tail (the
      // agent run may still have more turns, which will re-journal their tail).
      this.clearPiTurnJournal();
      const durationMs = this.piTurnStartedAtMs
        ? Date.now() - this.piTurnStartedAtMs
        : 0;
      const billingSource = this.piCurrentBillingSource;
      const creditChargeable = this.piCurrentCreditChargeable;
      const usageProvider = this.piCurrentUsageProvider;
      this.piLastTurnUsage = piRuntimeUsageSummary(event.message);
      this.piSdkTurnUsageTotal = addPiRuntimeUsageSummaries(
        this.piSdkTurnUsageTotal,
        this.piLastTurnUsage,
      );
      this.pushPiRuntimeEvent("sdk/turn/completed", {
        threadId: this.piRuntimeThreadId(),
        sdkTurnIndex: this.piSdkTurnIndex,
        completedAtMs: Date.now(),
        durationMs,
        ...(usageProvider ? { provider: usageProvider } : {}),
        ...(this.piLastTurnUsage ? { usage: this.piLastTurnUsage } : {}),
      });
      this.ctx.waitUntil(
        this.recordPiAssistantUsage(
          event.message,
          durationMs,
          billingSource,
          creditChargeable,
          usageProvider,
        ).catch((error) => {
          console.error("[ChatThreadDO] failed to record Pi usage", error);
        }),
      );
    }

    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent as {
        type?: string;
        contentIndex?: number;
        delta?: string;
        toolCall?: { id?: string; name?: string; arguments?: unknown };
      };
      const threadId = this.piRuntimeThreadId();
      switch (assistantEvent.type) {
        case "start":
          this.piReasoningItemId = null;
          break;
        case "thinking_start": {
          const contentIndex = typeof assistantEvent.contentIndex === "number"
            ? assistantEvent.contentIndex
            : 0;
          if (contentIndex === 0 || !this.piReasoningItemId) {
            this.piReasoningItemId = `pi_reasoning_${crypto.randomUUID()}`;
          }
          this.publishRunningActivity("Thinking", { immediate: true });
          break;
        }
        case "thinking_delta": {
          if (!assistantEvent.delta) break;
          const contentIndex = typeof assistantEvent.contentIndex === "number"
            ? assistantEvent.contentIndex
            : 0;
          if (!this.piReasoningItemId) {
            this.piReasoningItemId = `pi_reasoning_${crypto.randomUUID()}`;
          }
          this.pushPiRuntimeEvent("item/reasoning/textDelta", {
            threadId,
            itemId: this.piReasoningItemId,
            contentIndex,
            delta: assistantEvent.delta,
          });
          break;
        }
        case "text_delta": {
          if (!assistantEvent.delta) break;
          const itemId = this.piActiveItemId || `pi_agent_${crypto.randomUUID()}`;
          this.piActiveItemId = itemId;
          this.piAssistantText += assistantEvent.delta;
          this.piActiveItemText += assistantEvent.delta;
          this.pushPiRuntimeEvent("item/agentMessage/delta", {
            threadId,
            itemId,
            delta: assistantEvent.delta,
          });
          this.publishRunningActivity(this.piActiveItemText);
          break;
        }
        case "toolcall_start": {
          const toolCall = assistantEvent.toolCall ?? {};
          if (typeof toolCall.name !== "string" || !toolCall.name.trim()) {
            break;
          }
          const toolCallId = typeof toolCall.id === "string" && toolCall.id
            ? toolCall.id
            : `pi_tool_${crypto.randomUUID()}`;
          const toolName = toolCall.name.trim();
          const args = piEventArgs(toolCall.arguments);
          if (Object.keys(args).length > 0) {
            this.rememberPiToolArgs(toolCallId, args);
          }
          this.publishPiToolActivity(toolCallId, toolName, args, "running");
          this.pushPiRuntimeEvent("item/started", {
            threadId,
            item: piRuntimeToolItem(
              toolCallId,
              toolName,
              Object.keys(args).length > 0 ? args : null,
              "running",
            ),
          });
          break;
        }
      }
      return;
    }

    if (event.type === "message_end") {
      const isAssistant = isPiAssistantMessage(event.message);
      const text = isAssistant ? extractPiMessageText(event.message) : "";
      if (isAssistant && text) {
        const itemId = this.piActiveItemId || `pi_agent_${crypto.randomUUID()}`;
        const shouldSendCompleted = this.piActiveItemText.length === 0;
        if (shouldSendCompleted) {
          this.piAssistantText += text;
          this.piActiveItemText = text;
          this.publishRunningActivity(text, { immediate: true });
          this.pushPiRuntimeEvent("item/completed", {
            threadId: this.piRuntimeThreadId(),
            item: {
              id: itemId,
              type: "agentMessage",
              text,
            },
          });
        }
        this.piActiveItemId = `pi_agent_${crypto.randomUUID()}`;
        this.piActiveItemText = "";
      }
      // Journal the in-flight tail so a mid-turn eviction can recover this
      // assistant message (and any tool calls it issued) before turn_end commits.
      await this.recordPiTurnJournalTail();
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolCallId = event.toolCallId || `pi_tool_${crypto.randomUUID()}`;
      const toolName = event.toolName || "tool";
      this.piToolStartedAtMs.set(toolCallId, Date.now());
      const args = this.rememberPiToolArgs(toolCallId, piEventArgs(event.args));
      this.publishPiToolActivity(toolCallId, toolName, args, "running");
      this.pushPiRuntimeEvent("item/started", {
        threadId: this.piRuntimeThreadId(),
        item: piRuntimeToolItem(toolCallId, toolName, args, "running"),
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const delta = piToolResultText(event.partialResult);
      if (event.toolCallId && delta) {
        this.pushPiRuntimeEvent("item/commandExecution/outputDelta", {
          threadId: this.piRuntimeThreadId(),
          itemId: event.toolCallId,
          delta,
        });
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolCallId = event.toolCallId || `pi_tool_${crypto.randomUUID()}`;
      const toolName = event.toolName || "tool";
      const eventWithArgs = event as typeof event & { args?: unknown };
      const args = this.recallPiToolArgs(toolCallId, piEventArgs(eventWithArgs.args));
      const isError = event.isError === true;
      ChatThreadDO.prototype.recordPiToolFailure.call(this, {
        toolCallId,
        toolName,
        args,
        result: event.result,
        isError,
      });
      const durationMs = this.settlePiToolDuration(toolCallId, toolName, isError, event.result);
      const status = isError ? "failed" : "completed";
      const item: Record<string, unknown> = {
        id: toolCallId,
        type: "dynamicToolCall",
        tool: toolName,
        arguments: args,
        status,
        isError,
        result: event.result,
        // The UIMessage encoder already forwards this onto the tool part
        // (pi-chunk-encoder's tool-output-available), so tool cards get a real
        // duration as soon as it is measured here.
        ...(durationMs === null ? {} : { durationMs }),
      };
      const contentItems = piRuntimeContentItems(event.result);
      if (contentItems.length > 0) {
        item.contentItems = contentItems;
      }
      this.publishPiToolActivity(
        toolCallId,
        toolName,
        args,
        isError ? "error" : "complete",
        event.result,
      );
      this.pushPiRuntimeEvent("item/completed", {
        threadId: this.piRuntimeThreadId(),
        item,
      });
      // Journal the in-flight tail so a completed tool result survives a mid-turn
      // eviction and is not re-run on resume.
      await this.recordPiTurnJournalTail();
      return;
    }

    if (event.type === "agent_end") {
      const stoppedByUserAtMs = this.piUserStopRequestedAtMs;
      const stoppedByUser = stoppedByUserAtMs > 0;
      // A run that settled with a RETRYABLE transient provider error is not
      // terminal yet: skip ALL terminal surfacing (no error/result events, no
      // finishTurn, marker + journal left set) and let the turn body's
      // retryPiTurnWhileTransient loop regenerate it in-process.
      if (!stoppedByUser && this.maybeDeferPiTurnForTransientRetry(event.messages)) {
        return;
      }
      const newMessages = this.annotatePiProviderErrorMessages(
        stoppedByUser
          ? this.ensurePiUserStopMessage(event.messages, stoppedByUserAtMs)
          : this.ensurePiAssistantTextMessage(
              event.messages,
              this.piAssistantText || this.piContextExhaustionNotice(event.messages),
            ),
      );
      this.maybeSchedulePiPostTurnCompaction(newMessages);
      if (stoppedByUser) {
        // The turn was aborted before turn_end could snapshot it, so persist
        // the uncommitted tail of the live session directly.
        const session = this.piSession;
        const sessionMessages = session?.state.messages ?? [];
        const uncommitted = await Promise.all(
          sessionMessages
            .slice(this.piMainBaselineIndex)
            .filter((message) => !isEmptyAbortedPiAssistantMessage(message))
            .map((message) =>
              this.attachCodeModeArtifactsToToolResult(message, { consume: true }),
            ),
        );
        const messagesToPersist = dedupePiMessagesByKey([
          ...this.annotatePiProviderErrorMessages(uncommitted),
          ...newMessages,
        ]);
        if (messagesToPersist.length > 0) {
          await this.appendPiCoreMessagesIfMissing(
            stampPiRenderMessageId(
              messagesToPersist,
              this.activePiStreamTurnId,
            ),
          );
          if (session?.state.messages) {
            const baselineMessages = sessionMessages.slice(0, this.piMainBaselineIndex);
            const baselineKeys = baselineMessages.map((message) =>
              piCoreMessageKey(message),
            );
            const messagesForSession = dedupePiMessagesByKey(
              messagesToPersist,
              baselineKeys,
            );
            session.state.messages = [...baselineMessages, ...messagesForSession];
            this.piMainBaselineIndex = baselineMessages.length + messagesForSession.length;
          }
        }
      } else {
        this.discardUnpersistedPiSessionMessages();
      }
      const completedAtMs = Date.now();
      const turnStartedAtMs =
        this.piAgentStartedAtMs || this.piTurnStartedAtMs || completedAtMs;
      const turnDurationMs = Math.max(0, completedAtMs - turnStartedAtMs);
      this.piAgentStartedAtMs = 0;
      const threadId = this.chatContext?.threadId || "";
      const finalText = stoppedByUser
        ? PI_USER_STOP_TEXT
        : this.piAssistantText || extractLatestPiAssistantText(newMessages);
      const errorMessage = finalText
        ? ""
        : getLatestPiAssistantErrorMessage(newMessages);
      const summarySource = extractThreadCompletionSummarySource(
        newMessages,
        finalText || errorMessage,
      );
      const forkEntryId = latestPiAssistantForkEntryId(newMessages);
      if (stoppedByUser) {
        this.pushPiRuntimeEvent("item/agentMessage/delta", {
          threadId,
          itemId: forkEntryId || `pi_user_stop_${stoppedByUserAtMs}`,
          itemKind: "userStop",
          delta: PI_USER_STOP_TEXT,
        });
      }
      this.pushPiRuntimeEvent("turn/completed", {
        threadId,
        ...(forkEntryId ? { forkEntryId } : {}),
        completedAtMs,
        turnDurationMs,
        ...(this.piSdkTurnUsageTotal ? { usage: this.piSdkTurnUsageTotal } : {}),
        ...(this.piSdkTurnIndex > 0 ? { sdkTurnCount: this.piSdkTurnIndex } : {}),
      });
      this.pushChatEvent({
        type: "result",
        threadId,
        result: finalText,
        sessionId: threadId,
        completedAt: completedAtMs,
      });
      if (stoppedByUser) {
        this.updateActiveAutomationRun({
          status: "error",
          message: PI_USER_STOP_TEXT,
          completedAt: completedAtMs,
          clear: true,
        });
      } else if (!finalText && errorMessage) {
        this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
        this.updateActiveAutomationRun({
          status: "error",
          message: errorMessage,
          completedAt: completedAtMs,
          clear: true,
        });
      }
      this.finishTurn({
        markUnread: true,
        completedAt: completedAtMs,
        summarySource,
      });
      this.setActiveTurnUserId(null);
      this.completeTodoStateForTurnEnd();
      this.piActiveItemId = null;
      this.piActiveItemText = "";
      this.piReasoningItemId = null;
      this.piToolArgs = new Map();
      this.piToolFailures = new Map();
      this.piToolFailureRecordedCallIds = new Set();
      this.piAssistantText = "";
      this.piUserStopRequestedAtMs = 0;
      this.resetRunningActivityState();
      // The run is complete (success, user-stop, or a surfaced error): the turn is
      // no longer in flight, so clear the resume marker, journal, and alarm.
      await this.clearPiActiveTurnAndJournal();
      return;
    }

  }

  private async recordPiAssistantUsage(
    message: AgentMessage,
    durationMs: number,
    billingSource: PiBillingSource,
    creditChargeable: boolean,
    usageProvider?: string | null,
  ): Promise<void> {
    if (message.role !== "assistant" || !this.chatContext) return;

    const assistant = message as AgentMessage & {
      provider?: string;
      model?: string;
      responseModel?: string;
      responseId?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        totalTokens?: number;
        cost?: {
          total?: number;
        };
      };
    };
    const usage = assistant.usage;
    if (!usage) return;

    const inputTokens = Math.max(0, Math.floor(Number(usage.input ?? 0)));
    const outputTokens = Math.max(0, Math.floor(Number(usage.output ?? 0)));
    const cacheReadTokens = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
    const cacheWriteTokens = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
    if (
      inputTokens <= 0 &&
      outputTokens <= 0 &&
      cacheReadTokens <= 0 &&
      cacheWriteTokens <= 0
    ) {
      return;
    }

    const context = this.chatContext;
    const usageSourceId = piUsageSourceId(
      context.threadId,
      assistant,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    );
    const orgId = this.env.ORG.idFromName(context.orgId);
    const getOrgStub = () => this.env.ORG.get(orgId);
    await this.retryChatDurableObjectRpc(
      "OrgDO.recordUsage",
      () =>
        getOrgStub().recordUsage({
          workspace_id: context.workspaceId,
          user_id: context.userId ?? "",
          thread_id: context.threadId,
          model: assistant.responseModel || assistant.model || "unknown",
          provider: usageProvider || assistant.provider || "unknown",
          billing_source: billingSource,
          credit_chargeable: billingSource === "hosted" && creditChargeable,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheWriteTokens,
          cache_read_input_tokens: cacheReadTokens,
          cost_usd:
            typeof usage.cost?.total === "number" && usage.cost.total > 0
              ? usage.cost.total
              : undefined,
          duration_ms: durationMs,
          created_at_ms: Date.now(),
          source: "pi_assistant",
          source_id: usageSourceId,
        }),
      { attempts: 4, initialDelayMs: 150 },
    );
  }

  private sendRunnerCommand(message: Record<string, unknown>): boolean {
    const type = typeof message.type === "string" ? message.type : "unknown";
    if (this.piSession) {
      try {
        if (type === "message") {
          const content = typeof message.content === "string" ? message.content : "";
          if (!content.trim()) {
            return false;
          }
          const wasStreaming = this.piSession.state.isStreaming;
          // Reuse the caller's timestamp when provided so a message persisted up
          // front (the new-turn path in enqueueRunnerUserMessage) shares its
          // piCoreMessageKey with the one Pi commits at turn end.
          const timestamp =
            typeof message.timestamp === "number"
              ? message.timestamp
              : Date.now();
          const userMessage: AgentMessage = {
            role: "user",
            content,
            timestamp,
            ...(wasStreaming
              ? { metadata: { sentDuringStreaming: true } }
              : {}),
          } as unknown as AgentMessage;
          // Display fields for the native render-history user bubble (commit 3b).
          // rawContent is the user's typed text (before attribution/mention/file-
          // safety augmentation), which is what the render bubble shows; content
          // above is the attributed prompt Pi actually receives.
          const rawContent =
            typeof message.rawContent === "string" && message.rawContent.trim()
              ? message.rawContent
              : content;
          const messageSource =
            typeof message.messageSource === "string" && message.messageSource.trim()
              ? message.messageSource
              : null;
          const authorDisplayName = resolveMessageAuthorDisplayName(
            typeof message.authorDisplayName === "string"
              ? message.authorDisplayName
              : null,
            null,
          );
          const clientMessageId =
            typeof message.clientMessageId === "string" && message.clientMessageId.trim()
              ? message.clientMessageId.trim()
              : undefined;
          if (wasStreaming) {
            // Steering: an in-flight turn is streaming. Durably journal the accepted
            // message BEFORE any await, so an eviction in the window before Pi drains
            // the in-memory steering queue re-delivers it on resume instead of losing
            // it. The in-flight turn's own recovery fiber makes the run recoverable,
            // so the model refresh + steer can run async. The pi_core copy is
            // stamped with the skeleton's id (same-content-same-id invariant).
            const steeredSkeleton = this.buildUserUiSkeleton({
              rawContent,
              clientMessageId,
              authorDisplayName,
              messageSource,
              piCoreMessageKey: timestamp,
              sentDuringStreaming: true,
            });
            const stampedSteerMessage = withPiRenderMessageId(
              userMessage,
              steeredSkeleton.id,
            );
            this.recordPiTurnJournalSteerMessage(stampedSteerMessage);
            this.pushChatEvent({
              type: "steer-marker",
              steerMessageId: steeredSkeleton.id,
              acceptedAtMs: Date.now(),
            });
            this.ctx.waitUntil(
              (async () => {
                // Append the steered bubble to linear render history directly
                // (persistMessages, NOT saveMessages — the latter would enqueue
                // another ai-chat turn). Persist before model refresh so a
                // refresh failure cannot erase the accepted render bubble.
                await this.persistMessages([
                  ...this.messages,
                  steeredSkeleton,
                ]);
                if (!this.piSession) return;
                await this.refreshPiSessionModel();
                if (!this.piSession) return;
                this.piSession.steer(stampedSteerMessage);
              })().catch((error) => {
                console.error(
                  "[ChatThreadDO] failed to steer / persist steered user render message",
                  error,
                );
                this.emitChatError(
                  "Your message could not be delivered to the running turn. Please resend it.",
                );
              }),
            );
            return true;
          }

          // Fresh turn. onChatMessage OWNS it (runs the model + streams the Pi
          // events); here we only make it durable and hand it to ai-chat.
          //
          // Establish durable recoverability in the SAME synchronous tick that
          // persisted isStreaming=true upstream (enqueueRunnerUserMessage) — NO await
          // runs before these two writes. The active-turn marker (kv.put) mints the
          // stable stream/message id and derives the busy spinner; the journal
          // (sql.exec) records the ATTRIBUTED prompt so a pre-stream eviction can
          // rebuild the model turn from it (the in-memory prompt queue below is
          // lost on eviction — the journal is the durable copy). From this tick on,
          // any eviction is recovered by chatRecovery: the ai-chat recovery fiber
          // wraps the saveMessages turn body, so a mid-stream cut resumes via
          // continueLastTurn and a pre-stream cut via _retryLastUserTurn, both
          // re-entering onChatMessage's resume branch.
          //
          // A second fresh send can land before the first prompt() flips
          // isStreaming (or while a recovery for an interrupted turn is still
          // pending) — the marker is then already open. Queue-correct admission:
          // APPEND the new user message to the journal (never replace — that
          // would durably drop the earlier accepted prompt) and push it onto the
          // FIFO queue for onChatMessage to drain (prompt the first, steer the
          // rest).
          const markerAlreadyOpen = this.readPiActiveTurn() !== null;
          this.openPiActiveTurnIfAbsent();
          const userSkeleton = this.buildUserUiSkeleton({
            rawContent,
            clientMessageId,
            authorDisplayName,
            messageSource,
            piCoreMessageKey: timestamp,
          });
          // The pi_core copy carries the skeleton's id (same-content-same-id
          // invariant) through the journal, the prompt queue, and the turn_end
          // commit of the session tail.
          const stampedUserMessage = withPiRenderMessageId(
            userMessage,
            userSkeleton.id,
          );
          this.recordPiTurnJournalUserMessage(stampedUserMessage, {
            append: markerAlreadyOpen,
          });
          this.pendingPiPromptQueue.push({ userMessage: stampedUserMessage });
          // Hand the turn to ai-chat. saveMessages persists the user bubble and drives
          // onChatMessage (wrapped in ai-chat's recovery fiber). Fire-and-forget:
          // saveMessages resolves only when the whole turn's stream closes, but the
          // caller's `sent=true` ack means the turn was ACCEPTED, not completed.
          this.ctx.waitUntil(
            this.saveMessages((msgs) => [...msgs, userSkeleton])
              .then((result) => {
                if (result.status === "error") {
                  console.error(
                    "[ChatThreadDO] ai-chat turn reported error",
                    result.error,
                  );
                }
              })
              .catch((error) => {
                console.error(
                  "[ChatThreadDO] saveMessages for Pi stream turn failed",
                  error,
                );
                this.recordChatThreadObservabilityEvent(
                  "pi_stream_save_messages_failed",
                  {
                    operation: "save_messages",
                    status: "error",
                    error,
                  },
                );
              }),
          );
          return true;
        }
        if (type === "stop") {
          this.piUserStopRequestedAtMs = Date.now();
          // A stop during a transient-retry backoff has no in-flight run to
          // abort — wake the sleeping retry loop so it terminal-stops now.
          this.piTransientRetryBackoffAbort?.abort();
          this.piSession.abort();
          return true;
        }
        if (type === "question_response") {
          return true;
        }
      } catch (error) {
        console.error("[ChatThreadDO] send Pi command failed", error);
        return false;
      }
    }

    return false;
  }

  private async refreshPiSessionModel(): Promise<void> {
    const session = this.piSession;
    const modelResolver = this.piModelResolver;
    if (!session || !modelResolver) {
      return;
    }
    const current = await modelResolver();
    // Model resolution can cross DO/RPC boundaries. A concurrent stream cancel
    // may dispose (or replace) the Pi session while it is in flight; never
    // dereference or mutate that stale session after the await.
    if (this.piSession !== session) return;
    session.state.model = capPiMainRequestOutput(current.model);
    if (this.chatContext) {
      this.refreshPiSessionCapabilitySurface(this.chatContext);
    }
  }

  private refreshPiSessionCapabilitySurface(
    context: ChatContextState,
    envVars?: Record<string, string>,
  ): void {
    if (!this.piSession) return;
    this.piSession.state.systemPrompt = this.createPiSystemPrompt(context, envVars);
    this.piSession.state.tools = this.createPiToolDefinitions(context, {
      includeOracle: this.isCamelCodeActive(envVars),
    });
  }

  private recordCurrentThreadError(input: {
    message: string;
    source?: unknown;
    errorKind?: unknown;
    status?: unknown;
    provider?: unknown;
    model?: unknown;
    createdAt?: number;
  }): void {
    this.chatErrors.recordCurrentThreadError(input);
  }

  private emitChatError(message: string): void {
    this.pushChatEvent({ type: "error", error: message });
  }

  private piProviderErrorEvent(message: string): Record<string, unknown> {
    return this.chatErrors.piProviderErrorEvent(message);
  }

  private pushChatEvent(payload: Record<string, unknown>): void {
    const sessionId = this.chatContext?.threadId || "";
    // Set in the error branch below and stamped onto the envelope so the encoder
    // relay can persist a durable `data-pi-error` part carrying the same id +
    // billing metadata (groundwork for the future terminal-error cutover).
    let errorId: string | null = null;

    if (payload.type === "error") {
      const message =
        typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : typeof payload.message === "string" && payload.message.trim()
            ? payload.message.trim()
            : "";
      if (message) {
        this.recordCurrentThreadError({
          message,
          source: payload.source,
          errorKind: payload.errorType ?? payload.error_kind,
          status: payload.status ?? payload.statusCode,
          provider: payload.provider,
          model: payload.model,
          createdAt: Date.now(),
        });
        // Also surface terminal turn errors (provider faults, loop failures) in the
        // structured errors dataset. Without this a mid-stream provider failure was
        // invisible there — indistinguishable from a stall or client disconnect,
        // since both only funnelled through the reply-stream cancel path.
        const statusValue = payload.status ?? payload.statusCode;
        this.recordChatThreadObservabilityEvent("pi_turn_error", {
          operation: "run_pi_turn",
          status: "error",
          severity: "error",
          provider:
            typeof payload.provider === "string" ? payload.provider : null,
          model: typeof payload.model === "string" ? payload.model : null,
          statusCode: typeof statusValue === "number" ? statusValue : null,
          error: {
            name:
              typeof payload.errorType === "string" ? payload.errorType : "PiTurnError",
            message,
          },
        });
      }
      // Surface the terminal error through Agent state (with a unique id for
      // one-shot client dedup) so a reconnect after a disconnected/early failure
      // still recovers it — the replay buffer is gone. Cleared at agent_start.
      errorId = crypto.randomUUID();
      this.lastError = {
        id: errorId,
        error: message,
        billingSource:
          typeof payload.billingSource === "string" ? payload.billingSource : null,
        provider: typeof payload.provider === "string" ? payload.provider : null,
        status:
          typeof payload.status === "number" || typeof payload.status === "string"
            ? (payload.status as number | string)
            : null,
        errorType: typeof payload.errorType === "string" ? payload.errorType : null,
      };
      this.syncAgentState();
    }

    const envelope: Record<string, unknown> = {
      ...payload,
      sessionId,
      ...(errorId ? { errorId } : {}),
    };

    // The turn/completed badge now rides `message-metadata.pi` (turnDurationMs /
    // completedAtMs / forkEntryId) on the assistant message the encoder emits, so
    // the browser derives it from render history — no Agent-state mirror. Emit the
    // turn-finish lifecycle event here (once per turn/completed, low cardinality).
    if (envelope.type === "runtime_event") {
      const event = envelope.event as
        | { method?: unknown; params?: Record<string, unknown> }
        | undefined;
      if (event?.method === "turn/completed") {
        const params = event.params ?? {};
        const durationMs =
          typeof params.turnDurationMs === "number" &&
          Number.isFinite(params.turnDurationMs)
            ? Math.max(0, params.turnDurationMs)
            : undefined;
        this.recordChatThreadObservabilityEvent("pi_turn_finished", {
          operation: "run_pi_turn",
          status: "completed",
          durationMs,
        });
      }
    }

    // Mirror the event into the native ai-chat stream. All render content reaches
    // the browser through this stream (assistant/tool messages) or Agent state
    // (lastError, todos), never a raw websocket fan-out — so there is no socket
    // broadcast here. The eval collector still consumes every envelope (result
    // frames included) unchanged.
    this.writePiStreamChunks(envelope);
    this.agentEvalEventCollector?.push(envelope);
  }

  /**
   * Native UIMessage stream bridge (commit 3b, dual-emit): feed a chat event into
   * the turn's encoder and relay the resulting chunks to the attached ai-chat
   * stream writer, or buffer them until onChatMessage attaches one. A no-op when
   * no turn is bridging (encoder null) — every legacy emission is untouched.
   */
  private writePiStreamChunks(envelope: Record<string, unknown>): void {
    const encoder = this.piChunkEncoder;
    if (!encoder) return;

    let chunks: PiUiMessageChunk[];
    if (envelope.type === "runtime_event") {
      const event = envelope.event;
      if (!event || typeof event !== "object") return;
      chunks = encoder.encode(event as PiRuntimeEvent);
      if (chunks.length === 0) {
        // The event carries no render content (sdk/turn boundaries, unknown
        // methods, no-op item kinds) but IS proof the session is alive. Convert
        // it into a transient heartbeat so ai-chat's inter-chunk stall watchdog
        // — which counts wire chunks, not Pi events — doesn't read a healthy
        // quiet stretch as a hang.
        this.writePiStreamHeartbeat();
        return;
      }
    } else if (envelope.type === "steer-marker") {
      const steerMessageId =
        typeof envelope.steerMessageId === "string"
          ? envelope.steerMessageId
          : "";
      const acceptedAtMs =
        typeof envelope.acceptedAtMs === "number"
          ? envelope.acceptedAtMs
          : Date.now();
      if (!steerMessageId) return;
      chunks = encoder.encodeSteerMarker(steerMessageId, acceptedAtMs);
    } else if (envelope.type === "error") {
      const errorText =
        typeof envelope.error === "string" && envelope.error.trim()
          ? envelope.error.trim()
          : typeof envelope.message === "string" && envelope.message.trim()
            ? envelope.message.trim()
            : "Unknown error";
      // The native `error` chunk is broadcast-only (ai-chat never persists it), so
      // also emit a durable, non-transient `data-pi-error` part carrying the id +
      // billing metadata. This keeps the structured error in ai-chat render
      // history (a reload/late reconnect surfaces it, and the adapter renders it
      // as an inline error block) and is the groundwork for retiring the
      // Agent-state `lastError` channel — which still drives the live composer
      // banner + billing refresh for now.
      chunks = [{ type: "error", errorText }];
      const errorId =
        typeof envelope.errorId === "string" ? envelope.errorId : null;
      if (errorId) {
        chunks.push({
          type: "data-pi-error",
          id: PI_ERROR_PART_ID,
          data: {
            id: errorId,
            error: errorText,
            billingSource:
              typeof envelope.billingSource === "string"
                ? envelope.billingSource
                : null,
            provider:
              typeof envelope.provider === "string" ? envelope.provider : null,
            status:
              typeof envelope.status === "number" ||
              typeof envelope.status === "string"
                ? (envelope.status as number | string)
                : null,
            errorType:
              typeof envelope.errorType === "string"
                ? envelope.errorType
                : null,
          },
        });
      }
    } else {
      return;
    }
    this.enqueuePiStreamChunks(chunks);
  }

  /**
   * Write a transient `data-pi-heartbeat` chunk to the live reply stream so
   * ai-chat's stall watchdog registers genuine turn liveness that produces no
   * content chunks (see {@link chatStreamStallTimeoutMs}). Writer-attached only,
   * deliberately: a heartbeat is a liveness signal for the CURRENT stream, so
   * buffering one for a future stream is meaningless and would evict real chunks
   * from the bounded pre-attach buffer. Best-effort — a write racing stream
   * close/cancel (e.g. the tool keep-alive interval firing right after a stall
   * abort) is swallowed; the watchdog already owns that turn's outcome.
   */
  private writePiStreamHeartbeat(): void {
    const writer = this.piStreamWriter;
    if (!writer) return;
    try {
      writer.write({
        type: "data-pi-heartbeat",
        transient: true,
        data: { at: Date.now() },
      } as never);
    } catch {
      // Stream already closed/cancelled; nothing to keep alive.
    }
  }

  /**
   * Relay chunks to the attached ai-chat stream writer, or buffer them until
   * onChatMessage attaches one. Shared by the encoder relay (writePiStreamChunks)
   * and out-of-band data parts (code-mode artifacts) that aren't produced from a
   * Pi runtime event.
   */
  private enqueuePiStreamChunks(chunks: PiUiMessageChunk[]): void {
    if (chunks.length === 0) return;

    const writer = this.piStreamWriter;
    if (writer) {
      for (const chunk of chunks) writer.write(chunk as never);
      return;
    }
    // Defensive: the turn body runs inside onChatMessage's execute (after the
    // writer attaches), so this normally never buffers — but a stray between-attach
    // event is kept (drop-oldest, bounded) rather than dropped.
    const buffer = (this.piPreAttachChunkBuffer ??= []);
    for (const chunk of chunks) {
      if (buffer.length >= PI_STREAM_PRE_ATTACH_CHUNK_CAP) {
        buffer.shift();
        console.warn(
          "[ChatThreadDO] pi stream pre-attach buffer overflow; dropping oldest chunk",
        );
      }
      buffer.push(chunk);
    }
  }

  /**
   * ai-chat turn OWNER (commit 6). Driven by saveMessages for a fresh turn, or by
   * chatRecovery (continueLastTurn / _retryLastUserTurn) re-driving an interrupted
   * turn. Returns a native UIMessage stream whose execute RUNS the Pi turn — a
   * fresh prompt on the warm session, or the resume branch that rebuilds and
   * continues — relaying the turn's runtime events through the encoder. Returns
   * undefined when no Pi turn is in flight (no active-turn marker), so any stray
   * ai-chat frame stays inert.
   *
   * The encoder is (re)built from the marker's stable turnId, so a recovery
   * continuation streams into the SAME persisted assistant message: a fresh turn
   * has ai-chat adopt `start {messageId: turnId}`; a continuation ignores the start
   * messageId and appends to the cloned last-assistant message (which already
   * carries that id). See the ai-chat `_streamSSEReply` continuation handling.
   */
  async onChatMessage(
    _onFinish: unknown,
    _options?: unknown,
  ): Promise<Response | undefined> {
    const marker = this.readPiActiveTurn();
    // No in-flight turn to own (e.g. the marker was already cleared). Stay inert
    // WITHOUT draining the prompt queue — a queued admission racing a terminal
    // clear keeps its entry for the next admitted turn instead of being dropped.
    if (!marker) return undefined;

    const turnId = marker.turnId;
    this.activePiStreamTurnId = turnId;
    this.piChunkEncoder = new PiChunkEncoder({ messageId: turnId });
    this.piStreamWriter = null;
    this.piPreAttachChunkBuffer = null;

    // A fresh turn prompts on the already-warm session (built before the marker was
    // set, so createPiSession did NOT fold the journal and prompt() adds the user
    // messages exactly once). Rapid double-sends both queue before prompt() flips
    // isStreaming, so the drain prompts the FIRST message and steer()s the rest
    // into the run. A recovery re-drive has an empty queue and a cold/disposed
    // session — its resume branch rebuilds the session (folding the journal, which
    // durably holds every queued user message) and continues into the same message.
    // When the resume branch runs with a non-empty queue (e.g. a config-change
    // dispose raced admission), the drained entries are safe to discard: their
    // journal rows are what the rebuilt session folds.
    const drained =
      this.pendingPiPromptQueue.length > 0
        ? this.pendingPiPromptQueue.splice(0, this.pendingPiPromptQueue.length)
        : [];
    const freshPrompts =
      drained.length > 0 && this.piSession && !this.piSession.state.isStreaming
        ? drained
        : null;

    // Lazy-load `ai`'s stream builders so the heavy package stays out of the
    // module graph's eager-import cost (see the import note at the top of file).
    const { createUIMessageStream, createUIMessageStreamResponse } = await import(
      "ai"
    );

    const response = createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: async ({ writer }) => {
          // Emit the stream head and attach the writer. The turn body runs below
          // (inside this execute), so every Pi event arrives after the writer is set
          // — the pre-attach buffer is a defensive drain only.
          const encoder = this.piChunkEncoder;
          if (encoder) {
            for (const chunk of encoder.start()) writer.write(chunk as never);
          }
          const buffered = this.piPreAttachChunkBuffer;
          this.piPreAttachChunkBuffer = null;
          if (buffered) {
            for (const chunk of buffered) writer.write(chunk as never);
          }
          this.piStreamWriter = writer;
          // Fresh transient-retry budget per stream invocation (a chatRecovery
          // re-drive is a new invocation and gets its own budget — chatRecovery
          // bounds those separately).
          this.piTurnTransientRetryAttempts = 0;
          this.piPendingTransientTurnRetry = null;
          try {
            if (freshPrompts) {
              // No bespoke inactivity race: the ai-chat stall watchdog
              // (chatStreamStallTimeoutMs) now bounds inter-chunk gaps and, on a
              // stall, cancels this reply stream — onPiReplyStreamCancelled
              // disposes the session, which resolves this prompt() and leaves the
              // marker for bounded recovery.
              if (!this.piSession) {
                throw new Error("Pi session was not available for prompt");
              }
              await this.refreshPiSessionModel();
              const session = this.piSession;
              if (!session) {
                throw new Error("Pi session was not available for prompt");
              }
              // Prompt the first queued message; steer the rest into the run in
              // the SAME synchronous tick (prompt() marks the session streaming
              // before its first await, and pi drains the steering queue at the
              // run's steering points — including messages queued before the
              // first poll). Each steered message is steer-journaled first so an
              // eviction before pi drains it re-delivers on resume; the run's
              // first message_end rewrites the turn journal from the session
              // tail, which would otherwise drop the not-yet-drained entries.
              const [first, ...rest] = freshPrompts;
              const promptPromise = session.prompt(first.userMessage);
              for (const queued of rest) {
                this.recordPiTurnJournalSteerMessage(queued.userMessage);
                session.steer(queued.userMessage);
              }
              await promptPromise;
            } else {
              await this.withChatMemoryPhase("recovery_redrive", () =>
                this.resumeActivePiTurn(),
              );
            }
            // Drain the Pi event handler chain so agent_end's turn/completed → the
            // encoder `finish` chunk is flushed before the stream closes.
            await this.piEventHandlerChain.catch(() => {});
            // If that agent_end deferred a retryable transient provider error,
            // regenerate in-process on this same open stream.
            await this.retryPiTurnWhileTransient();
          } catch (error) {
            this.handlePiTurnFailure(error);
          } finally {
            if (this.piStreamWriter === writer) this.piStreamWriter = null;
            this.piChunkEncoder = null;
            this.piPreAttachChunkBuffer = null;
            this.activePiStreamTurnId = null;
            // Post-settle: pi-core is idle (or the error path cleared the marker), so
            // broadcast the derived state to clear the client spinner.
            this.syncAgentState();
          }
        },
      }),
    });
    return this.wrapReplyResponseForStallDisposal(response);
  }

  /**
   * Recovery classification hook (finding: half+full text after mid-stream
   * eviction). Default ai-chat recovery persists the orphaned partial (e.g. a
   * text part cut mid-stream, still `state: "streaming"`) and then CONTINUES
   * onto it — but Pi's resume regenerates its interrupted message from the
   * journal-folded transcript rather than continuing the partial, so the
   * continuation would append the full regenerated text after the half text.
   *
   * `persist: false` skips the orphan persist, so a mid-text eviction leaves the
   * user message as the leaf and ai-chat classifies the recovery as RETRY
   * (`_dispatchRecoveredChatTurn`'s lost-partial branch → `_chatRecoveryRetry` →
   * `_retryLastUserTurn` → onChatMessage's marker resume branch), which
   * regenerates one clean message under the same turnId. The visible partial is
   * intentionally sacrificed — the regeneration replaces it.
   *
   * The framework's never-drop-settled-work clause overrides `persist: false`
   * when the partial carries settled tool results (agents/chat
   * `_shouldPersistOrphanedPartial`): those partials DO persist and recover via
   * CONTINUE. That path is reconciled in {@link resumeActivePiTurn}, which trims
   * the partial's trailing incomplete parts before continuing.
   */
  override async onChatRecovery(
    _ctx: ChatRecoveryContext,
  ): Promise<ChatRecoveryOptions> {
    return { persist: false };
  }

  /**
   * Wrap the onChatMessage reply so the stall watchdog's stream-cancel disposes
   * the hung Pi session. ai-chat's `chatStreamStallTimeoutMs` watchdog cancels
   * this response body when the turn stalls; that cancel does NOT fire the
   * onChatMessage abortSignal, so we hook the body's `cancel()` here. Bytes pass
   * through untouched (identical SSE); only the cancel path gains the side effect.
   * A normal turn end reaches `done` (no cancel), and this codebase's user-stop
   * completes agent_end normally and closes the stream — so cancel() fires only on
   * a stall (or DO teardown), where disposing the session is correct.
   */
  private wrapReplyResponseForStallDisposal(response: Response): Response {
    const body = response.body;
    if (!body) return response;
    const reader = body.getReader();
    const wrapped = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => {
        void reader.cancel(reason);
        this.onPiReplyStreamCancelled();
      },
    });
    return new Response(wrapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * The reply stream's reader was cancelled. This fires on two distinct paths and
   * they must be told apart:
   *
   *  - A genuine mid-turn interruption (the stall watchdog aborting a hung stream,
   *    or a deploy/eviction tearing down a live turn) cancels while the turn body
   *    is still running inside onChatMessage's `execute` — so `activePiStreamTurnId`
   *    is still set (the `finally` that clears it has not run yet). Here we dispose
   *    the hung Pi session so its in-flight prompt()/continue() resolves (pi-agent-core
   *    catches the abort and settles the run); disposePiSession() drops the handlers
   *    so the synthesized aborted agent_end never runs and the active-turn marker is
   *    LEFT set, routing the turn into bounded chatRecovery.
   *
   *  - A benign post-completion close: ai-chat releases the reader AFTER consuming the
   *    terminal finish chunk (it does not always drain to `done`), so `cancel()` fires
   *    on an already-finished turn. By then `execute`'s `finally` has cleared
   *    `activePiStreamTurnId`, but the Pi session is REUSED (not disposed) for the next
   *    turn, so it is still truthy. The old `!piSession && !activePiStreamTurnId` guard
   *    therefore fell through and disposed a healthy idle session while logging a false
   *    `stall_abort`. Gate on the turn actually being in flight instead: no active turn
   *    id ⇒ nothing to abort.
   */
  private onPiReplyStreamCancelled(): void {
    if (!this.activePiStreamTurnId) {
      // Post-finish reader release (or a deploy tearing down an already-idle
      // stream). The turn already settled; do not dispose the reused session and
      // do not raise a stall alarm. Record a low-severity marker so this remains
      // visible in telemetry without masquerading as a stall.
      this.recordChatThreadObservabilityEvent("pi_turn_stream_closed", {
        operation: "stream_closed",
        status: "closed",
        severity: "debug",
      });
      return;
    }
    this.recordChatThreadObservabilityEvent("pi_turn_stream_stall_abort", {
      operation: "stream_stall_abort",
      status: "aborted",
      severity: "warn",
    });
    this.disposePiSession();
  }

  /**
   * agent_end gate for the in-process transient retry: when the run settled
   * with a RETRYABLE provider error (pi-ai's isRetryableAssistantError — its
   * non-retryable pattern excludes refusals/usage limits, which must
   * terminal-fail immediately) and budget remains, stash a pending-retry token
   * and tell the caller to skip terminal surfacing. Returns false — keeping the
   * existing terminal path — when no ai-chat turn body is attached (direct
   * prompt() drivers like agent evals have no retry loop to consume the token),
   * when the budget is spent, or when the run did not end in a retryable error.
   */
  private maybeDeferPiTurnForTransientRetry(messages: AgentMessage[]): boolean {
    if (!this.activePiStreamTurnId) return false;
    if (this.piTurnTransientRetryAttempts >= PI_TURN_TRANSIENT_RETRY_ATTEMPTS) {
      return false;
    }
    // A failed run always terminates on its error assistant message (pi emits
    // turn_end + agent_end immediately after it), so only the LAST message can
    // carry the retryable error.
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    if (!last) return false;
    const errorText = getPiAssistantErrorMessage(last);
    if (!errorText) return false;
    if (!isRetryableAssistantError(last as unknown as AssistantMessage)) {
      return false;
    }
    const record = last as unknown as Record<string, unknown>;
    this.piPendingTransientTurnRetry = {
      errorText,
      provider:
        this.piCurrentUsageProvider ||
        (typeof record.provider === "string" ? record.provider : null),
      model:
        typeof record.model === "string" && record.model.trim()
          ? record.model.trim()
          : this.piSession?.state.model?.id ?? null,
    };
    return true;
  }

  /**
   * In-process regeneration loop for a turn whose run settled with a retryable
   * transient provider error (deferred by {@link maybeDeferPiTurnForTransientRetry}).
   * Runs in the turn body AFTER the event-handler chain drained, so the deferred
   * agent_end has already been processed. Each attempt: bounded exponential
   * backoff (heartbeats keep ai-chat's inter-chunk stall watchdog fed; a user
   * stop aborts the sleep), then re-drive via the SAME regeneration path
   * eviction recovery uses — prune the failed error row from the journal,
   * dispose the session so resumeActivePiTurn rebuilds it from committed
   * history + journal, and continue into the same assistant message. The
   * active-turn marker + journal stay set across attempts (they are what the
   * rebuild folds); the retried run's own agent_end clears them on success, and
   * on exhaustion or a non-retryable error the gate declines and the normal
   * terminal path runs. Errors thrown by the re-drive propagate to
   * onChatMessage's catch (handlePiTurnFailure).
   */
  private async retryPiTurnWhileTransient(): Promise<void> {
    while (this.piPendingTransientTurnRetry) {
      const pending = this.piPendingTransientTurnRetry;
      this.piPendingTransientTurnRetry = null;
      if (this.piUserStopRequestedAtMs > 0) {
        await this.finishPiTurnStoppedDuringTransientRetry();
        return;
      }
      this.piTurnTransientRetryAttempts += 1;
      const attempt = this.piTurnTransientRetryAttempts;
      // Routed to the errors dataset (via the `error` field): the deferred
      // agent_end surfaced nothing to the client, so this event is the only
      // record of the retried provider error — and each retry re-bills the
      // reprocessed input tokens, so this counter is also the spend signal.
      const retryError = new Error(pending.errorText);
      retryError.name = "PiProviderError";
      this.recordChatThreadObservabilityEvent("pi_turn_transient_retry", {
        operation: "transient_turn_retry",
        status: "retrying",
        severity: "warn",
        count: attempt,
        provider: pending.provider,
        model: pending.model,
        error: retryError,
      });
      // Prune the failed assistant row from the durable journal BEFORE the
      // evictable backoff sleep. If the DO is evicted during the sleep, the
      // in-memory pending-retry intent is lost, so cold-load recovery folds the
      // journal blind — and a lingering error row would make planPiTurnResume see
      // a trailing assistant, take the "already complete" branch, and commit the
      // provider error as a successful final message (silently abandoning the
      // retry). Pruning first means an eviction here folds a transcript ending in
      // the user/tool message and regenerates, exactly as an in-process retry
      // would. Idempotent: finishPiTurnStoppedDuringTransientRetry filters the
      // failed row rather than depending on it, and a second prune is a no-op.
      this.prunePiTurnJournalFailedAssistantMessages();
      // The backoff writes no content chunks; feed the stall watchdog so it
      // cannot cancel the open reply stream while we sleep.
      this.writePiStreamHeartbeat();
      const backoffAbort = new AbortController();
      this.piTransientRetryBackoffAbort = backoffAbort;
      try {
        await this.sleepForPiTransientTurnRetry(attempt, backoffAbort.signal);
      } catch {
        // The only abort source is a user stop (sendRunnerCommand's stop path).
        await this.finishPiTurnStoppedDuringTransientRetry();
        return;
      } finally {
        if (this.piTransientRetryBackoffAbort === backoffAbort) {
          this.piTransientRetryBackoffAbort = null;
        }
      }
      if (this.piUserStopRequestedAtMs > 0) {
        await this.finishPiTurnStoppedDuringTransientRetry();
        return;
      }
      this.writePiStreamHeartbeat();
      // Journal already pruned before the sleep (above); trim the in-flight
      // streaming reply parts (in-memory, not durable, so no eviction concern).
      this.trimIncompleteStreamingReplyParts();
      // resumeActivePiTurn folds committed history + journal only through a
      // session REBUILD (ensurePiSessionReady reuses a warm one) — dispose
      // first so the re-drive runs the same cold path eviction recovery does.
      // Known minor edge: a user `stop` landing in the dispose→rebuild window
      // hits sendRunnerCommand's `if (this.piSession)` guard while the session
      // is null, so that one click is dropped; the rebuilt run streams and can be
      // stopped again. Not a hang (the run completes and clears the marker); left
      // as-is rather than widening the stop path on the hot turn body.
      this.disposePiSession();
      await this.resumeActivePiTurn();
      await this.piEventHandlerChain.catch(() => {});
    }
  }

  /** Bounded exponential backoff between transient turn retries. */
  private sleepForPiTransientTurnRetry(
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const delayMs = Math.min(
      PI_TURN_TRANSIENT_RETRY_MAX_MS,
      PI_TURN_TRANSIENT_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    );
    return abortableSleep(delayMs, signal);
  }

  /**
   * Terminal path for a user stop that lands during a transient-retry backoff:
   * there is no in-flight run to emit the stoppedByUser agent_end, so run the
   * equivalent teardown here. The journal may hold accepted-but-uncommitted
   * real work (the turn's user message when the FIRST model call failed,
   * completed tool results) — commit it minus the failed error row before the
   * journal is cleared, so the stop doesn't drop the prompt from the transcript.
   */
  private async finishPiTurnStoppedDuringTransientRetry(): Promise<void> {
    const stoppedAtMs = this.piUserStopRequestedAtMs || Date.now();
    const completedAtMs = Date.now();
    const threadId = this.chatContext?.threadId || "";
    this.recordChatThreadObservabilityEvent("pi_turn_transient_retry", {
      operation: "transient_turn_retry",
      status: "stopped",
      severity: "warn",
      count: this.piTurnTransientRetryAttempts,
    });
    const journalTail = await this.loadPiTurnJournalTail();
    const realWork = journalTail.filter(
      (message) => !isFailedPiAssistantMessage(message),
    );
    await this.appendPiCoreMessagesIfMissing(
      stampPiRenderMessageId(
        [...realWork, this.createPiUserStopMessage(stoppedAtMs)],
        this.activePiStreamTurnId,
      ),
    );
    const turnStartedAtMs =
      this.piAgentStartedAtMs || this.piTurnStartedAtMs || completedAtMs;
    this.piAgentStartedAtMs = 0;
    this.pushPiRuntimeEvent("item/agentMessage/delta", {
      threadId,
      itemId: `pi_user_stop_${stoppedAtMs}`,
      itemKind: "userStop",
      delta: PI_USER_STOP_TEXT,
    });
    this.pushPiRuntimeEvent("turn/completed", {
      threadId,
      completedAtMs,
      turnDurationMs: Math.max(0, completedAtMs - turnStartedAtMs),
    });
    this.pushChatEvent({
      type: "result",
      threadId,
      result: PI_USER_STOP_TEXT,
      sessionId: threadId,
      completedAt: completedAtMs,
    });
    this.updateActiveAutomationRun({
      status: "error",
      message: PI_USER_STOP_TEXT,
      completedAt: completedAtMs,
      clear: true,
    });
    this.finishTurn({ markUnread: true, completedAt: completedAtMs });
    this.setActiveTurnUserId(null);
    this.completeTodoStateForTurnEnd();
    this.piUserStopRequestedAtMs = 0;
    this.resetRunningActivityState();
    // The warm session's uncommitted tail was discarded at the failed turn_end
    // and pi_core just gained the journal commit above — rebuild next turn.
    this.disposePiSession();
    await this.clearPiActiveTurnAndJournal();
  }

  /**
   * In-process analog of {@link trimIncompleteLiveAssistantParts}: mid-stream
   * nothing is persisted for this turn yet, but ai-chat's in-flight reply
   * message (the parts array `applyChunkToParts` builds and `_reply` persists
   * at stream end) still holds the failed attempt's incomplete trailing parts.
   * The regeneration re-produces that content, so drop the incomplete tail
   * before re-driving — otherwise the persisted message renders the half text
   * followed by the full regenerated text. Settled parts (completed tools,
   * finished text runs) correspond to journaled work the resume keeps, so they
   * stay. The client's live copy still shows the stale tail until the
   * end-of-turn persistMessages broadcast reconciles it.
   */
  private trimIncompleteStreamingReplyParts(): void {
    // ai-chat 0.9.3 holds the in-flight reply on the PRIVATE `_streamingMessage`
    // field: `_reply` assigns it `_createStreamingAssistantMessage()`'s
    // `{ id, role, parts }` and persists that same `parts` array verbatim at
    // stream end. We reach it through a cast (there is no public trim/reset API).
    // An upstream RENAME would make the cast read `undefined`, so this trim would
    // silently no-op and reintroduce the half+full render it exists to prevent.
    // Distinguish a MISSING field (rename — surface loudly so a dependency bump
    // that breaks the safeguard shows up in prod, not just in a stale test) from a
    // legitimately null one (no reply stream open — nothing to trim). The
    // keep-in-sync guard test (chat-thread-streaming-reply-trim.test.ts) pins the
    // field name and the `{ parts }` shape against the installed dist.
    const agent = this as unknown as {
      _streamingMessage?: { parts?: unknown[] } | null;
    };
    if (!("_streamingMessage" in agent)) {
      console.error(
        "[ChatThreadDO] @cloudflare/ai-chat _streamingMessage field is missing; " +
          "transient-retry partial trim is a no-op (upstream rename?)",
      );
      this.recordChatThreadObservabilityEvent("pi_streaming_reply_field_missing", {
        operation: "transient_turn_retry",
        status: "error",
        severity: "error",
      });
      return;
    }
    const streaming = agent._streamingMessage;
    const parts = streaming?.parts;
    if (!Array.isArray(parts)) return;
    let trimmed = 0;
    while (parts.length > 0) {
      const last = parts[parts.length - 1] as { state?: unknown };
      if (last?.state === "streaming" || last?.state === "input-streaming") {
        parts.pop();
        trimmed += 1;
        continue;
      }
      break;
    }
    if (trimmed === 0) return;
    this.recordChatThreadObservabilityEvent("pi_turn_partial_trimmed", {
      operation: "transient_turn_retry",
      status: "trimmed",
      count: trimmed,
    });
  }

  /**
   * Shared failure cleanup for a Pi turn that errored inside onChatMessage's stream
   * execute (a fresh prompt or a resume continuation). Consolidates the old
   * sendRunnerCommand / resume error paths.
   *
   * A genuine user `stop` keeps handlers subscribed, so agent_end already cleared
   * the marker + journal and its AbortError is benign. A config-change dispose (and
   * a stall dispose via {@link onPiReplyStreamCancelled}) also abort with no
   * agent_end but leave the marker set so the pending continuation resumes the turn
   * — all AbortError cases are swallowed WITHOUT clearing recovery state. (A stall
   * abort actually resolves prompt() rather than rejecting, so it usually doesn't
   * reach here at all; the AbortError guard covers the race where it does.)
   *
   * Otherwise: surface the error through the encoder relay (a terminal `error`
   * chunk) plus durable lastError state, run the completion/automation teardown,
   * and clear the marker + journal so chatRecovery does NOT re-drive a turn that
   * terminally errored.
   */
  private handlePiTurnFailure(error: unknown): void {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || /aborted/i.test(error.message))
    ) {
      return;
    }
    console.error("[ChatThreadDO] Pi turn failed", error);
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
    this.updateActiveAutomationRun({
      status: "error",
      message: errorMessage,
      clear: true,
    });
    this.finishTurn();
    this.setActiveTurnUserId(null);
    void this.clearPiActiveTurnAndJournal();
  }

  /**
   * chatRecovery `onExhausted` hook (commit 6): an interrupted turn spent its
   * recovery budget. The framework delivers `terminalMessage` to the client and
   * records the durable terminal itself; here we run the same give-up teardown the
   * old failPiResume path did — clear the marker + journal, release turn ownership,
   * fail any active automation run, surface durable lastError, and log.
   */
  private handlePiRecoveryExhausted(ctx: ChatRecoveryExhaustedContext): void {
    this.recordChatThreadObservabilityEvent("pi_turn_resume_abandoned", {
      operation: "resume_interrupted_turn",
      status: "abandoned",
      severity: "warn",
    });
    this.updateActiveAutomationRun({
      status: "error",
      message: ctx.terminalMessage,
      clear: true,
    });
    void this.clearPiActiveTurnAndJournal();
    this.finishTurn();
    this.setActiveTurnUserId(null);
    try {
      this.pushChatEvent(this.piProviderErrorEvent(ctx.terminalMessage));
    } catch {
      // Best effort: the framework already delivered the terminal banner; the
      // observability event above is the actionable signal.
    }
  }

  private buildUserUiSkeleton(args: {
    rawContent: string;
    clientMessageId?: string;
    authorDisplayName?: string | null;
    messageSource?: string | null;
    channelHistory?: boolean;
    piCoreMessageKey?: number | string;
    sentDuringStreaming?: boolean;
  }): UIMessage {
    return this.uiMirror.buildUserUiSkeleton(args);
  }

  /**
   * Render history for the live-user chat loader (commit 3b). Runs the pi_core →
   * ai-chat top-up backfill first, then returns the full ai-chat message list.
   * DO RPC only — intentionally NOT wired to any HTTP route (auth-sensitive; the
   * loader wiring is commit 4).
   */
  async getUiMessages(): Promise<UIMessage[]> {
    return this.withChatMemoryPhase("render_rpc_return", async () => {
    // The SSR loader is the first page-open touch (before the websocket
    // connects). Heal a provably-dead turn's stranded marker here so the load
    // doesn't derive a busy indicator from it — and so the top-up below (which
    // the marker gates) isn't skipped forever for a turn nothing will resume.
    await this.sweepOrphanedActiveTurnMarker();
    await this.topUpUiMessagesFromPiCore();
    await this.healLegacyUiMessageTimes();
    await this.healLegacyUiMessageAuthors();
    return this.messages as UIMessage[];
    });
  }

  private healLegacyUiMessageTimes(): Promise<void> {
    return this.uiMirror.healLegacyUiMessageTimes();
  }

  private healLegacyUiMessageAuthors(): Promise<void> {
    return this.uiMirror.healLegacyUiMessageAuthors();
  }

  /**
   * Admin repair RPC (commit 3b): rebuild the entire ai-chat render history from
   * pi_core. Clears the mirror + high-water mark, then re-runs the top-up. For
   * flows that rewrite pi_core (fork repair, compaction repair) where the append-
   * only high-water assumption no longer holds.
   */
  async resyncUiMessagesFromPiCore(): Promise<{
    ok: true;
    messageCount: number;
  }> {
    await this.rebuildUiMessagesFromPiCore();
    return { ok: true, messageCount: this.messages.length };
  }

  private topUpUiMessagesFromPiCore(
    options: { force?: boolean } = {},
  ): Promise<void> {
    return this.withChatMemoryPhase("pi_topup", () =>
      this.uiMirror.topUpUiMessagesFromPiCore(options),
    );
  }

  private reloadAiChatMessagesOrdered(): void {
    const phase = this.startChatMemoryPhase("render_persist_reload");
    try {
      this.uiMirror.reloadAiChatMessagesOrdered();
      this.endChatMemoryPhase(phase);
    } catch (error) {
      this.endChatMemoryPhase(phase, "error");
      throw error;
    }
  }

  private getChatSockets(): WebSocket[] {
    return Array.from(this.getConnections()) as unknown as WebSocket[];
  }

  private broadcastChat(message: object): void {
    const json = JSON.stringify(message);
    this.broadcast(json);
  }

}
