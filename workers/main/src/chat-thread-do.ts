
import {
  callable,
  type Connection,
  type ConnectionContext,
  type WSMessage,
} from "agents";
import { Type } from "typebox";
import { AIChatAgent } from "@cloudflare/ai-chat";
import type {
  ChatRecoveryConfig,
  ChatRecoveryExhaustedContext,
  ChatResponseResult,
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
  recordChatTerminal,
  sendIfOpen,
  setChatRecovering,
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
  CHAT_RENDER_WINDOW_MAX_BYTES,
  CHAT_RENDER_WINDOW_MAX_MESSAGES,
  formatAiChatCreatedAt,
  parseDerivedPiRenderCursor,
  parseDerivedRenderHistoryCursor,
  type ChatRenderHistoryPage,
} from '../../../src/lib/chat-render-history';
import { materializeBoundedRenderArchive } from './chat-thread/render-archive-preserve';
import type { PreserveArchiveResult } from './chat-thread/render-archive-preserve';
import {
  buildDerivedRenderPage,
  deriveRenderWindowFromPiCore,
  type PiDeriveRowRead,
  type PiDeriveRowSource,
  type PiDerivedRenderWindow,
  type PiDerivedWindowStats,
} from './chat-thread/derived-render-page';
import {
  PiChunkEncoder,
  PI_ERROR_PART_ID,
  type PiRuntimeEvent,
  type PiUiMessageChunk,
} from '../../../src/lib/pi-chunk-encoder';
import { uiMessageCreatedAtMs } from '../../../src/lib/ui-message-adapter';
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
  getStoredBedrockAwsRegion,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  normalizeLlmModel,
} from "../../../src/lib/llm-provider-config";
import { isTransientDurableObjectRpcError } from "../../../src/lib/do-rpc-retry.server";
import type { HostedCapability } from "../../../src/lib/capability-allowances";
import { connectionsBindingEnabled } from "../../../src/lib/connections-binding";
import {
  getEffectiveLlmProviderConfig,
  isSelfhostRuntime,
} from "../../../src/lib/selfhost-ai-provider";
import { isOrgBanned } from "./ban-list";
import type { WorkspaceThreadStreamingOptions } from "./thread-status";

import {
  createPiSystemPrompt,
} from "./pi-system-prompt";
import { resolveAgentSkillCatalog } from "./selfhost-agent-pack";

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
import {
  SSE_MAX_QUEUED_BYTES,
  SseConnection,
  type SseQueueBudget,
  createSseCaptureConnection,
  createSseQueueBudget,
  createSseStreamSink,
  isClosedStreamSendError,
} from "./chat-thread/sse-connection";
import { withoutReservedTransportHeaders } from "./chat-thread/transport-headers";


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
  normalizeVerifiedWorkState,
  type VerifiedWorkEvidence,
} from "./chat-thread/verified-work-state";
import { resolveObjectStore } from "./binding-facades/object-store";
import { runPortableCode } from "./binding-facades/code-executor";

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
  piSummaryMessageText,
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
  estimatePiContextBytes,
  estimatePiContextFootprint,
  PI_CONTEXT_MAX_WORKING_SET_BYTES,
  type PiContextFootprint,
  isPiLengthStopContextExhaustion,
  shouldCompactPiAfterAssistantUsage,
  piTranscriptCompactionTrigger,
  type PiTranscriptCompactionTrigger,
  loadPiCompleteSimple,
  findPiCompactionCutIndex,
  summarizePiMessages,
  createFallbackPiCompactionSummary,
  createPiSummaryMessage,
} from "./chat-thread/pi-compaction";

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
  primaryPiThinkingLevel,
} from "./chat-thread/pi-model-config";
import { FREE_VLLM_PRIORITY } from "./hosted-vllm-priority";
import {
  assertUserLlmUsageAccess,
  UserLlmUsageLimitError,
} from "./user-llm-usage-policy";

// Provider-level transient-retry ladder for Pi model streams.
import {
  streamPiModelWithTransientRetry,
  abortableSleep,
  isBedrockRegionUnavailableError,
  type PiProviderStreamTerminalStatus,
} from "./chat-thread/pi-stream-retry";

// Turn/steer journal + active-turn marker persistence (PiTurnJournal).
import {
  PiTurnJournal,
  type PiActiveTurnMarker,
  type PiTurnResumeAttempt,
  type PiTurnResumeCause,
} from "./chat-thread/pi-turn-journal";

// pi_core message persistence (PiCoreMessageStore).
import {
  PiCoreMessageStore,
  PI_SESSION_LOAD_MAX_CHARS,
  PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
  type PiCoreImagePolicy,
  type PiImageHydrationBudget,
  type PiSessionLoadWindow,
} from "./chat-thread/pi-core-store";

// pi_core → ai-chat render-mirror machinery (ChatThreadUiMirror): the top-up
// backfill, legacy time heal, user render skeleton, and wipe-and-rebuild resync.
import { ChatThreadUiMirror } from "./chat-thread/ui-mirror";

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
// How many ISOLATE-DEATH re-drives a single interrupted turn may spend through
// {@link ChatThreadDO.resumeActivePiTurn} before it is abandoned. This bound is
// PROGRESS-INDEPENDENT, which is the whole point: chatRecovery's budget resets on
// forward progress, so a turn that journals a checkpoint and then OOM-kills the
// isolate inside the same re-drive renews its budget on every pass and loops
// forever (thread 3030f522: ~96 kills in three hours, every wake "successful").
// The count lives on the active-turn marker, so it dies when the turn completes
// or is cleared.
//
// It is charged ONLY to re-drives whose predecessor left no in-isolate trace —
// i.e. the isolate died without any handler running, the signature of the memory
// kill. Interruptions this isolate CAUGHT (a DO code-update reset, a config-change
// dispose) stamp `benignInterruption` on the marker and are charged to the loose
// total below instead: the same file documents a production thread that absorbed
// 15 consecutive code-update resets and still completed correctly, and the SDK
// draws the same line (`maxOomRetries` counts OOM-ended attempts only).
export const PI_TURN_RESUME_BUDGET = 3;
// Isolate-death charges older than this are forgiven (the counter restarts).
// The loop this bounds kills every ~2 minutes; resets this far apart are a rollout
// walking the fleet, and must not accumulate across a long turn into an
// abandonment. Well under PI_TURN_ABSOLUTE_MAX_MS so a spiral still trips first.
export const PI_TURN_ISOLATE_DEATH_DECAY_MS = 10 * 60 * 1000;
// Ceiling on the re-drives this DO chooses to run in-process: the transient
// provider-error regeneration ({@link PI_TURN_TRANSIENT_RETRY_ATTEMPTS}, reset per
// stream invocation) and config-change rebuilds. They do the same rebuild work, so
// they stay bounded — but under their own counter, so a provider-overload window
// can never consume the eviction-recovery headroom.
export const PI_TURN_VOLUNTARY_RESUME_BUDGET = 8;
// Loose absolute ceiling on re-drives of ANY cause, so even an endlessly "benign"
// interruption loop terminates. Deliberately far above the 15-reset production
// example the transient-reset branch cites below.
export const PI_TURN_TOTAL_RESUME_BUDGET = 32;

// --- Recovery ladder (rung = the ISOLATE-DEATH count after the durable increment) ---
//
// A turn that keeps dying under memory pressure does not deserve the SAME resume
// three times over and then nothing: each rung is strictly cheaper in memory than
// the one before it, so the turn gets a real chance to land before it is dropped.
// The rung is a pure function of the persisted isolate-death counter — no extra
// marker field — which also means a death INSIDE a rung advances the ladder on the
// next wake by construction.
//
// It keys off the isolate-death counter and NOT the total/voluntary ones on
// purpose: those count healthy churn (deploy resets, provider-529 regenerations),
// and a turn re-driven by a rollout must resume normally, not degraded. The decay
// window applies here identically — a decayed counter is a rung-1 resume again.
//
//   isolate-death 1-2 -> normal resume
//   isolate-death 3   -> degraded resume (PI_TURN_DEGRADED_RESUME_ATTEMPT)
//   isolate-death 4   -> salvage without the model (PI_TURN_SALVAGE_RESUME_ATTEMPT)
//   isolate-death >4  -> terminal abandonment (exceededPiTurnResumeBudget)
export const PI_TURN_DEGRADED_RESUME_ATTEMPT = PI_TURN_RESUME_BUDGET;
export const PI_TURN_SALVAGE_RESUME_ATTEMPT = PI_TURN_RESUME_BUDGET + 1;

/** Which rung of the recovery ladder this re-drive lands on. */
export type PiTurnResumeRung = "normal" | "degraded" | "salvage" | "terminal";

/**
 * The ladder rung for a counted re-drive. Only the isolate-death counter moves the
 * rung; the voluntary/total ceilings are flat abandonments handled by
 * {@link exceededPiTurnResumeBudget} (they bound churn, not memory pressure, so
 * there is nothing cheaper to try — the rungs exist to survive an OOM).
 */
export function piTurnResumeRung(attempt: PiTurnResumeAttempt): PiTurnResumeRung {
  if (attempt.isolateDeath > PI_TURN_SALVAGE_RESUME_ATTEMPT) return "terminal";
  if (attempt.isolateDeath === PI_TURN_SALVAGE_RESUME_ATTEMPT) return "salvage";
  if (attempt.isolateDeath === PI_TURN_DEGRADED_RESUME_ATTEMPT) return "degraded";
  return "normal";
}

/**
 * Which (if any) of the marker's resume budgets this re-drive just blew — i.e.
 * which one means TERMINAL abandonment with no cheaper rung left to try. The
 * isolate-death line sits one past {@link PI_TURN_RESUME_BUDGET} because attempt
 * {@link PI_TURN_SALVAGE_RESUME_ATTEMPT} is spent on the model-free salvage rung
 * ({@link piTurnResumeRung}); a salvage with nothing to salvage falls through to
 * this same abandonment inside the same wake.
 */
export function exceededPiTurnResumeBudget(
  attempt: PiTurnResumeAttempt,
): "isolate_death" | "voluntary" | "total" | null {
  if (attempt.isolateDeath > PI_TURN_SALVAGE_RESUME_ATTEMPT) return "isolate_death";
  if (attempt.voluntary > PI_TURN_VOLUNTARY_RESUME_BUDGET) return "voluntary";
  if (attempt.total > PI_TURN_TOTAL_RESUME_BUDGET) return "total";
  return null;
}
// Image budget for a DEGRADED resume (ladder rung 3). The default (2 hydrated
// images / 6M base64 chars) is a sane provider-context bound but a poor memory
// bound for a turn that has already been memory-killed three times: the
// hydrated base64, its R2 body and the request copy all live at once. One small
// image is enough to keep a screenshot-driven turn coherent; anything larger is
// replaced with the same "(image omitted…)" text the default budget uses.
// `maxDeclaredChars` covers INLINE base64 too, not only what is pulled from R2 —
// a screenshot at or under PI_MAX_PERSISTED_IMAGE_DATA_CHARS is never
// externalized, so a budget that only saw R2 refs left rung 3 with no lever at
// all on exactly the image-heavy threads it exists for.
const PI_DEGRADED_RESUME_IMAGE_HYDRATION_BUDGET: PiImageHydrationBudget = {
  maxCount: 1,
  maxDeclaredChars: 500_000,
};
// Payload-byte ceiling a DEGRADED resume (ladder rung 3) forces compaction at,
// alongside the token floor below. The rung exists to make the request small
// after an isolate death, and the token floor alone stopped being able to do
// that once an image was charged what an image costs: 20 inline screenshots are
// ~10 MB of resident base64 and only ~70k estimated tokens, well under half of
// any threshold. A few megabytes is past anything a healthy turn carries and
// far under what killed the isolate, so it fires on the target population
// without touching the mid-size threads the floor fraction deliberately spares
// (one screenshot is ~0.5 MB and still a no-op here).
const PI_DEGRADED_COMPACTION_MAX_WORKING_SET_BYTES = 4_000_000;
// How full the context must already be before a DEGRADED resume (ladder rung 3)
// pulls compaction forward. Compaction's own floor is `keepRecentTokens` (20k), so
// forcing it unconditionally would summarize any thread over ~20k — roughly an
// eighth of the real threshold on a 200k-window model — spending a provider call
// mid-recovery to shed a few thousand tokens from a context that was never the
// memory problem. Half the threshold keeps the rung aimed at the case it exists
// for: an OOM loop on a genuinely large thread.
export const PI_DEGRADED_COMPACTION_FLOOR_FRACTION = 0.5;
// User-facing copy committed as the final assistant message of a SALVAGED turn
// (ladder rung 4). Tone matches PI_RESUME_EXHAUSTED_MESSAGE, but it is not an
// error: real work was kept, and the invitation is to continue rather than to
// resend.
const PI_TURN_SALVAGE_NOTE =
  "This turn was interrupted before it finished, so I've kept the work above. Ask me to continue and I'll pick up from here.";
// Marks the synthetic assistant row that carries {@link PI_TURN_SALVAGE_NOTE}, the
// way `user_stop` marks the stop row: it is a system-authored message, not a model
// answer, and anything reasoning over the transcript should be able to tell.
const PI_TURN_SALVAGE_METADATA_REASON = "turn_salvaged";
// User-facing copy for that abandonment. Distinct from
// {@link PI_RESUME_EXHAUSTED_MESSAGE} only in saying the turn was stopped after
// repeated failures; both end with the same "send it again" instruction.
const PI_TURN_RESUME_BUDGET_EXHAUSTED_MESSAGE =
  "This turn kept failing while it was being resumed, so it was stopped after several attempts. Please send your message again.";

const CHAT_TODOS_KEY = "chatTodos";
// Last thing the transport knows about a human watching this thread. Durable on
// purpose: the SSE registry dies with the isolate, and the recovery re-drive that
// asks "is a browser user available?" runs before any client can reattach.
const CHAT_SSE_VIEWER_KEY = "chatSseViewer";
const CHAT_CONTEXT_USED_PERCENT_KEY = "chatContextUsedPercent";
const CHAT_CONTEXT_WINDOW_BY_MODEL_KEY = "chatContextWindowByModel";
const CHAT_ACTIVE_TURN_USER_ID_KEY = "chatActiveTurnUserId";
const CHAT_VERIFIED_WORK_STATE_KEY = "chatVerifiedWorkState";
// The integration record and this DO cannot update atomically. Keep a bounded,
// content-free receipt ledger so cleanup can safely retry an accepted response.
const CHAT_ACCEPTED_CONNECTION_SETUP_RESPONSES_KEY =
  "chatAcceptedConnectionSetupResponses";
const MAX_ACCEPTED_CONNECTION_SETUP_RESPONSES = 64;

interface AcceptedConnectionSetupResponse {
  requestId: string;
  acceptedAt: number;
}

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

// Client→server frames the SSE transport's POST endpoint accepts. `rpc` frames
// are additionally restricted to the callables registered in the static block:
// the HTTP boundary must be at least as narrow as the socket one, which drops
// BLOCKED_CHAT_PROTOCOL_FRAME_TYPES (see the constructor's onMessage guard).
const CHAT_TRANSPORT_CALLABLE_METHODS = new Set<string>([
  "requestStop",
  "setPreviewTabsState",
  "answerQuestion",
  "submitConnectionSetupResponse",
  "refreshModel",
  "sendMessage",
  "getOlderUiMessages",
]);
interface ChatTransportFrame {
  type?: unknown;
  method?: unknown;
  id?: unknown;
}
// SSE has no runtime-answered ping/pong analogue, so the DO writes its own
// comment keepalive. The same tick runs the idle sweep.
const SSE_HEARTBEAT_INTERVAL_MS = 25_000;
// How long a thread with no work must stay quiet before the stream is closed
// with `bye {"reason":"idle"}`. The client reopens on demand (send, focus,
// visibility), so a dormant tab stops pinning this DO.
const SSE_IDLE_GRACE_MS = 5 * 60 * 1000;
// How long a viewer we last saw (attached, or parked by the idle policy) keeps
// counting as present. Two absences must not read as "the user left":
//  - the idle park is the transport's own doing, and the tab reopens the stream
//    on demand;
//  - an eviction/redeploy destroys the registry entirely, and the client needs a
//    reconnect delay plus a full auth round trip to come back — while recovery
//    re-drives run on the freshly woken isolate immediately (and OOM retries
//    wake the DO by alarm with no client involved at all).
// A hibernating WebSocket survived both, so without a presumption a re-driven
// turn tells the agent "User is not at computer" and silently auto-cancels
// connection-setup prompts for a user who is sitting there. The presumption is
// bounded because a viewer that has since gone away is indistinguishable from
// one watching an idle tab: past this, availability falls back to "no stream".
const SSE_PRESUMED_VIEWER_MS = 30 * 60 * 1000;
// Refresh the durable marker for a long-lived stream at most this often, so an
// eviction hours into a session still finds a recent viewer without writing
// storage on every heartbeat tick.
const SSE_PRESENCE_REFRESH_MS = 5 * 60 * 1000;
// Concurrent streams one thread will hold, in total and per authenticated user.
// Each attach queues its own copy of the render window (up to
// CHAT_RENDER_WINDOW_MAX_BYTES) into its own transform, so unbounded attaches
// are an OOM lever on a DO shared by every thread participant (the aggregate
// SseQueueBudget bounds the bytes; these bound the slots). The per-user limit
// keeps one member from crowding out the others, and is enforced by evicting
// that member's OLDEST stream rather than refusing the newest: a client mints a
// fresh `_pk` per attempt, and a peer that vanished without erroring its writer
// lingers until the stall probe reaps it, so refusing would let a flapping
// client lock itself out of chat with its own retries. Both are far above any
// real multi-tab / multi-participant usage.
const SSE_MAX_CONNECTIONS = 64;
const SSE_MAX_CONNECTIONS_PER_USER = 16;
// The degraded-auth grant map and recent-clientMessageId dedup constants live
// in ./chat-thread/access with the methods that use them.

// The codeModeArtifacts: KV key prefix lives in
// ./chat-thread/code-mode-artifacts with the methods that use it.

// Drop-oldest cap for the pre-attach chunk buffer so a turn that never attaches
// a writer (e.g. saveMessages skipped) cannot grow memory without bound.
const PI_STREAM_PRE_ATTACH_CHUNK_CAP = 5000;

// Derive-on-read page memo (see derivedRenderWindowCache). Small and byte-capped
// on purpose: the memo exists to spare a second derive within one wake (loader
// RPC then connect reconcile), NOT to hold history. A window whose rows exceed
// the cap is exactly the window that must not stay resident, so it is served and
// dropped.
const DERIVED_RENDER_WINDOW_CACHE_MAX_ENTRIES = 3;
const DERIVED_RENDER_WINDOW_CACHE_MAX_CHARS = 1_000_000;
// Rows scanned forward from the compaction watermark to find the oldest visible
// derived message (the archive seam). One or two rows in practice.
const OLDEST_DERIVED_ROW_SCAN_MAX_ROWS = 32;

// Bounded forward reader behind the render mirror's top-up (readParsedPiCoreRowRange).
/** Rows per metadata probe. Payloads are still materialized one at a time. */
const PI_TOPUP_ROW_BATCH_SIZE = 64;
/**
 * Rows the reader may take PAST its budget before it gives up going FORWARD to
 * find a turn boundary and retreats to the newest one behind it instead.
 *
 * A range that ends between an assistant row and its tool answers drops those
 * answers from the mirror (they attach to the previous parsed assistant, which is
 * in the earlier range); one that ends inside a stamped fold upserts the same
 * render id twice, second write winning. Both are corruption, not slowness, so
 * the budget yields.
 *
 * What this constant is NOT is a licence to stop wherever the count runs out —
 * that was the original reading and it ended ranges on toolResult rows, which is
 * exactly the first failure above. It only chooses between the two SAFE ways to
 * end: extend forward to the next boundary, or rewind to the last one.
 */
const PI_TOPUP_BOUNDARY_MAX_EXTRA_ROWS = 256;

// ---------------------------------------------------------------------------
// Wake-OOM containment for the resumable-stream replay buffer. A whale turn's
// buffer used to be unbounded in total size, and EVERY read of it materializes
// the whole thing at once — a resume replay, and (with no client involved at
// all) the recovery classification that runs on wake. The DO was OOM-killed
// before the aged-buffer sweep could ever reclaim it, and the kill re-woke it.
// Three bounds, cheapest first: don't store what replay throws away (the SDK
// patch's transient-chunk skip), cap what one stream may store, and never
// materialize a whole buffer in one read.
// ---------------------------------------------------------------------------
// Ceiling on stored replay bytes for one stream. Enforced in the patched
// `_storeStreamChunk` funnel; past it the stream is degraded (resumes attach to
// live instead of replaying).
//
// This number is a property of the TRANSPORT, not of storage. A replay is pushed
// into ONE SSE sink synchronously — `replayStreamChunksBounded` never awaits
// between sends, and a sink write only un-queues itself in a `.then` microtask,
// which cannot run inside synchronous JS — so the sink's queue grows
// monotonically for the whole replay. Past SSE_MAX_QUEUED_BYTES the sink kills
// itself, `sendIfOpen` reports a dead peer, the replay bails with the stream
// still active, and the client answers by reconnecting and asking for the exact
// same replay: an un-resumable turn plus a reconnect loop. So the ceiling that
// decides "replay or attach to live" has to sit far enough below the queue cap
// that a capped buffer's FRAMES still fit, and frames are strictly larger than
// the bodies they carry (each body is JSON-escaped again inside a ~90 byte
// envelope, plus `data: …\n\n`). Three eighths of the queue cap leaves room for
// worst-case escaping and for the render-window snapshot the same sink is
// already carrying. KEEP THESE COUPLED: raising the stored ceiling without
// raising SSE_MAX_QUEUED_BYTES (./chat-thread/sse-connection) re-creates the
// un-replayable band.
const CHAT_STREAM_REPLAY_MAX_STORED_BYTES = Math.floor(
  (SSE_MAX_QUEUED_BYTES * 3) / 8,
);
// Frame characters one replay may enqueue before it stops replaying, marks the
// stream degraded and attaches the client to live instead. The stored ceiling
// above already keeps a capped buffer's frames well under this, so it only fires
// on pathological escaping — but it must fire BEFORE the sink's own cap, because
// the sink's answer is to kill the connection. Characters, not bytes: counting
// UTF-8 bytes means a second pass over every frame, and the gap between this and
// SSE_MAX_QUEUED_BYTES plus {@link CHAT_REPLAY_MAX_ABORTED_ATTEMPTS} covers the
// multi-byte case.
const CHAT_REPLAY_MAX_SENT_CHARS = Math.floor((SSE_MAX_QUEUED_BYTES * 3) / 4);
// Replays of one stream that may die mid-way before the buffer is declared
// un-replayable over this transport. A client that really did go away costs a
// replay; a buffer that cannot fit the wire costs the same replay on every
// reconnect forever, so the Nth abort forces the degraded (attach-to-live) path
// no matter what the byte arithmetic said.
const CHAT_REPLAY_MAX_ABORTED_ATTEMPTS = 3;
// Segment rows per page of a replay read. Small enough that a capped buffer's
// worst case is resident one page at a time, large enough that a normal turn's
// replay is a couple of queries.
const CHAT_REPLAY_BATCH_SEGMENTS = 40;
// Body bytes one page of a replay read may materialize. Rows alone are not a
// bound: the SDK sizes a segment row in BYTES (up to ~512KB packed, up to ~1.8MB
// for a single oversized chunk stored unwrapped), so `limit 40` lets a buffer
// made of large rows come back whole — exactly the materialization paging exists
// to prevent. Each page therefore reads row LENGTHS first (no bodies) and only
// fetches the prefix that fits here; a single row that exceeds it is still
// fetched alone, since one row is already bounded by the SDK's chunk ceiling.
const CHAT_REPLAY_PAGE_MAX_BYTES = 1024 * 1024;
// Stored bytes past which the recovery-classification read is skipped instead of
// reconstructing the partial. That read (`_getPartialStreamText` → the SDK's
// unpaged `getStreamChunks`) runs on WAKE with no client and no transport, so
// only the isolate's memory bounds it — and it runs inside the framework's own
// startup wrapper, before any app code, which is what made pre-existing whale
// buffers unkillable. Streams written under the ceiling above never come close,
// so the recovery partial keeps its full-prefix semantics (OOM-FIX.md fix 3) for
// every stream this deploy governs; this only sheds buffers that predate the cap.
const CHAT_RECOVERY_PARTIAL_MAX_STORED_BYTES = 8 * 1024 * 1024;
// Wake circuit breaker: `{count, at}` incremented (and durably written) before
// any of the framework's startup work and reset once a wake completes OR fails
// with a catchable error, so it only ever counts wakes that left no epilogue at
// all — the signature of an isolate that was killed. At the threshold the stream
// buffers are quarantined, which is the only way out of a wake that OOMs while
// reading them. Counts inside a rolling window from the FIRST such wake so
// unrelated failures months apart never add up to a quarantine.
const CHAT_WAKE_OOM_GUARD_KEY = "wakeOomGuard";
const CHAT_WAKE_OOM_GUARD_WINDOW_MS = 60 * 60 * 1000;
const CHAT_WAKE_OOM_QUARANTINE_AFTER = 3;
// Total stored chunk bytes below which quarantine is refused. The remedy is
// destructive (both stream tables dropped, so an in-flight turn loses its
// resumability and its settled-partial persist), and a buffer this small cannot
// be what killed a 128MB isolate — so a wake failing for any other reason must
// not be allowed to cash in three attempts against an actively recoverable turn.
const CHAT_WAKE_QUARANTINE_MIN_STORED_BYTES = 8 * 1024 * 1024;
// Durable ids of streams whose replay buffer is known-incomplete. The SDK's own
// verdict is in-memory, and its post-eviction recompute re-derives it from a SQL
// byte sum over PACKED rows — a different currency than the store-time tally —
// so it cannot reproduce a live verdict. Remembering the ids is what makes
// "this buffer is truncated" survive hibernation. Bounded FIFO: a thread only
// ever has a handful of streams in flight, and the ids are cheap.
const CHAT_REPLAY_DEGRADED_STREAMS_KEY = "chatReplayDegradedStreams";
const CHAT_REPLAY_DEGRADED_STREAMS_MAX = 16;

/**
 * The `ResumableStream` state the bounded replay needs. Everything here is
 * `private` in the SDK's declarations but real state on the instance; the
 * replaced `replayChunks` must read exactly what the original read.
 */
type ResumableStreamReplayInternals = {
  replayChunks(connection: Connection, requestId: string): string | null;
  replayCompletedChunksByRequestId(
    connection: Connection,
    requestId: string,
  ): boolean;
  replayErroredChunksByRequestId(
    connection: Connection,
    requestId: string,
  ): boolean;
  readonly activeStreamId: string | null;
  readonly isLive: boolean;
  _activeIsContinuation?: boolean;
  flushBuffer(): void;
  complete(streamId: string): void;
};

/** The recovery partial `_getPartialStreamText` reconstructs from stored chunks. */
type ChatRecoveryPartial = {
  text: string;
  parts: UIMessage["parts"];
  hasSettledToolResults: boolean;
};

/** Why a stream's replay buffer was declared unusable. */
type ChatReplayDegradeReason =
  /** The patched store-side funnel hit its byte ceiling and stopped storing. */
  | "capped"
  /** A replay's frames would not fit the SSE sink that has to carry them. */
  | "transport_budget"
  /** Repeated replays of this buffer died mid-way; stop re-reading it. */
  | "replay_aborted"
  /** The wake-time recovery read would have materialized too much to survive. */
  | "recovery_read_skipped";

/** How a chunk replay ended. Only `aborted` means the client did not get it. */
type ChatReplayOutcome =
  /** Every stored frame was sent. */
  | "complete"
  /** Buffer is known-truncated; no content frames were sent by design. */
  | "skipped"
  /** A send failed mid-replay: the peer is gone and nothing may be finalized. */
  | "aborted"
  /** The replay would not fit the transport; the rest is deliberately dropped. */
  | "budget_exhausted";

interface WakeOomGuardRecord {
  count: number;
  at: number;
}

/**
 * What one provider request's compaction actually did, for `pi_context_budget`.
 *
 * Every exit from `compactPiContext` names itself, because the interesting ones
 * are otherwise indistinguishable. On the normal path the FIRST request of a
 * turn summarizes and writes a durable `pi_core_compaction` row (which clears
 * the in-memory memo), so every later request takes the durable-row branch —
 * a healthy reuse that used to report the same `unchanged` as "the context was
 * always in budget" and as "we were over budget and found nothing to cut". That
 * last one is a real failure: the full oversized context ships anyway. It is
 * `no_cut` now, and the alert this event exists for ("more than one
 * `summarized` per turn is a regression") can finally see the difference.
 */
type PiCompactionStatus =
  /** In budget on both tokens and bytes; nothing to do. */
  | "unchanged"
  /** Reused the in-memory cut from earlier in this stream invocation. */
  | "memo_hit"
  /** Reused the durable `pi_core_compaction` row. */
  | "row_hit"
  /** Ran a summarization (provider call or fallback summary). */
  | "summarized"
  /** Over budget, but the cut index landed nowhere: the whole context ships. */
  | "no_cut";

interface PiCompactionOutcome {
  status: PiCompactionStatus;
  /**
   * Payload bytes of the view actually returned, so the event shows what
   * compaction achieved and not only what went into it.
   */
  resultBytes?: number;
}

/**
 * A stored replay row is either one chunk body (a JSON object string — a legacy
 * row or a single-chunk segment) or a packed segment (a JSON array of chunk body
 * strings). The SDK's own unpack is not exported, so this mirrors it, including
 * replaying an unparseable row verbatim.
 */
function unpackReplaySegmentBody(rowBody: string): string[] {
  try {
    const parsed = JSON.parse(rowBody) as unknown;
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // Not a body this SDK version could have written; pass it through as-is.
  }
  return [rowBody];
}

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
  static renderHistoryWindow = {
    maxMessages: CHAT_RENDER_WINDOW_MAX_MESSAGES,
    maxBytes: CHAT_RENDER_WINDOW_MAX_BYTES,
  };
  static streamReplayMaxStoredBytes = CHAT_STREAM_REPLAY_MAX_STORED_BYTES;

  private previewTarget: PreviewTarget | null = null;
  private previewTabs: PreviewTarget[] = [];
  private previewActiveTabId: string | null = null;
  private previewVersion: number = 0;

  // Chat bridge state
  private chatContext: ChatContextState | null = null;
  // SSE chat transport registry. partyserver's own connection store is
  // `ctx.getWebSockets()` under hibernation and its manager field is truly
  // private, so synthetic connections can only live here — which is why
  // broadcast/getConnection/getConnections are overridden below.
  private sseConnectionRegistry?: Map<string, SseConnection>;
  private sseCloseChainRegistry?: Map<string, Promise<void>>;
  /** Undrained bytes across every registered stream (see SseQueueBudget). */
  private sseQueueBudgetRef?: SseQueueBudget;
  private sseHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sseIdleSince: number | null = null;
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
  private legacyUiMessageHealingPromise: Promise<void> | null = null;
  /**
   * Revision-keyed LRU of derived render WINDOWS — one page each, never the whole
   * settled transcript (that cache is what made a 5,232-row thread fatal to load).
   * The live overlay is applied AFTER a cache hit, so an open turn is never served
   * stale, and oversized windows are not cached at all: on a whale thread the
   * cheap thing is re-deriving one bounded page, not holding several.
   */
  private derivedRenderWindowCache: {
    token: string;
    entries: Map<string, PiDerivedRenderWindow>;
  } | null = null;
  private piDeriveRowSourceInstance?: PiDeriveRowSource;
  /** Allocation accounting for the last derived page (telemetry + tests). */
  private lastDerivedRenderPageStats: PiDerivedWindowStats | null = null;
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
  private llmUsageSettlementChain: Promise<void> = Promise.resolve();
  private pendingLlmUsageSettlements: Array<() => Promise<void>> = [];
  /**
   * The post-turn durable cut, single-flighted. Non-null for exactly as long as
   * a pass is running; see `maybeSchedulePiPostTurnCompaction` for why a
   * level-shaped trigger makes this mandatory rather than tidy.
   */
  private piPostTurnCompactionInFlight: Promise<void> | null = null;
  /** At most one coalesced follow-up pass, requested while one was in flight. */
  private piPostTurnCompactionRerun: {
    triggerMessage: AgentMessage;
    userId: string | null;
  } | null = null;
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
  /**
   * The pi_core index space the live session's message list lives in — set by
   * every session build, reset by every wholesale pi_core rewrite, and null when
   * no session has been built (direct-call tests, cold facades).
   *
   * `piMainBaselineIndex` says how much of the list is committed; this says
   * WHERE it is committed. They answer different halves of the same question and
   * a compaction cut needs both: `committedBound` decides whether a cut may be
   * persisted at all, and this decides which `pi_core_messages.idx` it names
   * (see {@link PiSessionLoadWindow}). Before the bounded load there was only
   * one shape that shifted the mapping — a durable compaction summary at index 0
   * — so `compactPiContext` could infer it from the compaction row. A capped
   * load makes the offset independent of the row, so it has to be carried.
   */
  private piSessionLoadWindow: {
    firstRowIdx: number;
    summaryOffset: 0 | 1;
    /** The list is SHORT of the thread: rows below `firstRowIdx` were skipped. */
    capped: boolean;
  } | null = null;
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
  private piCurrentUsageModel: string | null = null;
  private piTurnLastProgressAtMs: number = 0;
  // In-process transient-retry state (see PI_TURN_TRANSIENT_RETRY_ATTEMPTS).
  // agent_end defers terminal surfacing of a retryable provider error by
  // setting the pending token; the turn body's retryPiTurnWhileTransient loop
  // consumes it. Both reset at the start of each onChatMessage execute.
  private piTurnTransientRetryAttempts = 0;
  // >0 while {@link driveConfigChangeResume} is re-driving the interrupted turn
  // through ai-chat's recovery entry points. The re-drive lands in onChatMessage's
  // resume branch like an eviction recovery, but this DO caused it (a model /
  // BYOK change), so it spends the VOLUNTARY budget, not the isolate-death one.
  private piConfigChangeResumeDepth = 0;
  // True while the DEGRADED ladder rung ({@link piTurnResumeRung}) owns this
  // stream invocation: the session's transformContext then forces an eager
  // compaction and hydrates images under
  // {@link PI_DEGRADED_RESUME_IMAGE_HYDRATION_BUDGET}. Read at call time rather
  // than baked into the session, so it applies to a warm session too, and reset at
  // the top of every onChatMessage execute so it can never leak into a later turn.
  private piDegradedResumeAttempt = false;
  // The DEGRADED rung's compaction is EPHEMERAL: it shrinks the bytes of each
  // provider request without writing the durable `pi_core_compaction` row, so a
  // recovery can never permanently truncate a thread the token threshold would
  // not have compacted at all. This memo is what the durable row would have
  // provided — reuse across the ~25 provider requests of one attempt, so the
  // summarization provider call happens once. Lives and dies with
  // {@link piDegradedResumeAttempt}.
  private piEphemeralCompaction: { summary: string; firstKeptIndex: number } | null =
    null;
  // A terminal this DO decided by itself ({@link deliverPiTurnTerminal}) that must
  // be re-asserted after ai-chat's turn drain clears CHAT_LAST_TERMINAL_KEY — the
  // abandoned turn's reply stream ends WITHOUT an error, so the framework treats it
  // as "completed" and deletes the record moments after we write it.
  private pendingPiTurnTerminal: { requestId: string; message: string } | null =
    null;
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
    callable()(this.prototype.getOlderUiMessages, context);
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

    // No ctx.setWebSocketAutoResponse pair is registered: no WebSocket can
    // reach this DO any more, and the SSE transport keepalive is its own
    // comment heartbeat (SSE_HEARTBEAT_INTERVAL_MS).

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

    // The Agent constructor also replaced this.onStart with ITS OWN wrapper, and
    // that wrapper does the heavy wake work — state restore, MCP restore, and
    // `_checkRunFibers` → chat fiber recovery, whose classification read
    // materializes the whole replay buffer with no client involved — BEFORE it
    // calls this class's onStart. Arming the breaker or installing the bounded
    // readers from ChatThreadDO.onStart is therefore strictly too late: the read
    // that kills the isolate has already happened, nothing was ever counted, and
    // the kill re-drives the identical wake forever. Wrapping the wrapper here is
    // the only app-controlled point that precedes it (partyserver calls onStart
    // from #ensureInitialized, which cannot run before the constructor returns).
    const frameworkOnStart = this.onStart.bind(this);
    this.onStart = async (props?: unknown): Promise<void> => {
      this.armWakeOomGuard();
      this.installBoundedStreamReplay();
      try {
        await frameworkOnStart(props as never);
      } catch (error) {
        // Reaching a catch PROVES the isolate survived this wake, so it is not
        // the OOM the breaker counts — and partyserver re-runs onStart on the
        // next entry point in this same live isolate, so leaving the increment
        // would let three client frames quarantine a healthy thread in seconds.
        this.resetWakeOomGuard();
        throw error;
      }
    };
    // Also install before the first wake even reaches onStart: the wrapper above
    // covers every partyserver entry point, but the reads are cheap to bound
    // twice and expensive to bound once too late.
    this.installBoundedStreamReplay();

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
    const loader = this.env.CODE_MODE_LOADER as (WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    }) | undefined;
    if (!loader) {
      const result = await runPortableCode(this.env, {
        code,
        orgId: request.orgId,
        workspaceId: request.workspaceId,
        userId: request.userId,
        threadId: request.threadId,
        toolUseId: request.toolUseId,
        timeoutMs,
        maxOutputCharacters,
      });
      return {
        text: truncateCodeModeText(result.text, maxOutputCharacters),
      };
    }
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

  /**
   * Live progress text for a tool running inside code mode.
   *
   * Code-mode tools execute in the CodeModeToolsBinding isolate, so they cannot
   * reach the agent loop's `onUpdate` callback; this is the same seam
   * recordCodeModeArtifact uses. It emits exactly the runtime event the agent
   * loop's own tool_execution_update handler emits, so the client renders it as
   * streamed output of the parent js_exec tool call — which is what keeps a
   * long build-container wake from looking like a hang.
   */
  async streamToolProgress(parentToolUseId: string, delta: string): Promise<void> {
    const itemId = parentToolUseId.trim();
    const text = typeof delta === "string" ? delta.trim() : "";
    if (!itemId || !text) return;
    this.pushPiRuntimeEvent("item/commandExecution/outputDelta", {
      threadId: this.piRuntimeThreadId(),
      itemId,
      delta: `${text}\n`,
    });
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
    // The breaker is armed and the bounded readers installed by the constructor's
    // onStart wrapper, NOT here. This method is the LAST step of startup — the
    // framework's wrapper runs state restore, MCP restore and `_checkRunFibers`
    // (chat fiber recovery, which reconstructs the recovery partial from the
    // replay buffer) before calling it — so anything guarding those reads has to
    // be installed upstream of it. `super.onStart` below resolves to
    // partyserver's empty hook; the reads it used to be credited with are the
    // framework wrapper's, already done by the time we get here.
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
      // A wake that got this far did not die on its stream buffers, so the
      // breaker's count means nothing any more.
      this.resetWakeOomGuard();
    } catch (error) {
      this.endChatMemoryPhase(phase, "error", true);
      throw error;
    }
  }

  /**
   * Alarm-driven resumable-stream buffer sweep. A completed sweep is the other
   * proof the DO can read its own stream state without dying, and unlike onStart
   * it also proves the buffers are being reclaimed.
   */
  override async _cleanupStreamBuffers(): Promise<void> {
    await super._cleanupStreamBuffers();
    this.resetWakeOomGuard();
  }

  /** Set once this isolate has counted its wake against the breaker. */
  private wakeGuardArmed: boolean = false;
  /**
   * Test seams for the wake/replay bounds. Production uses the constants at the
   * top of this file; tests scale them down so a fixture does not have to be
   * megabytes of chunk rows to reach a threshold.
   */
  private replayBoundOverrides: {
    maxSentChars?: number;
    pageMaxBytes?: number;
    recoveryPartialMaxStoredBytes?: number;
    wakeQuarantineMinStoredBytes?: number;
  } = {};

  private replayMaxSentChars(): number {
    return this.replayBoundOverrides.maxSentChars ?? CHAT_REPLAY_MAX_SENT_CHARS;
  }

  private replayPageMaxBytes(): number {
    return this.replayBoundOverrides.pageMaxBytes ?? CHAT_REPLAY_PAGE_MAX_BYTES;
  }

  private recoveryPartialMaxStoredBytes(): number {
    return (
      this.replayBoundOverrides.recoveryPartialMaxStoredBytes ??
      CHAT_RECOVERY_PARTIAL_MAX_STORED_BYTES
    );
  }

  private wakeQuarantineMinStoredBytes(): number {
    return (
      this.replayBoundOverrides.wakeQuarantineMinStoredBytes ??
      CHAT_WAKE_QUARANTINE_MIN_STORED_BYTES
    );
  }

  /**
   * Count this wake against the breaker and quarantine at the threshold. The
   * write is the SYNCHRONOUS kv put on purpose: the failure this counts is the
   * isolate being killed later in the same wake, which loses anything still
   * queued behind an await.
   *
   * Counted ONCE PER ISOLATE. partyserver puts `#status` back to "zero" when
   * onStart throws and re-runs it on the next entry point in the same live
   * isolate — `webSocketMessage` even swallows the error — so a deterministic
   * non-memory failure would otherwise reach the threshold within seconds of a
   * reconnecting tab's frames. An isolate that is genuinely OOM-killed never
   * comes back, so per-isolate dedupe costs the real detector nothing.
   */
  private armWakeOomGuard(): void {
    if (this.wakeGuardArmed) return;
    this.wakeGuardArmed = true;
    let count = 1;
    // The window runs from the FIRST unfinished wake, not from the last one:
    // refreshing `at` on every increment turns a 1h ceiling into an unbounded
    // sliding gap between retries.
    let windowStartedAt = Date.now();
    try {
      const previous = this.ctx.storage.kv.get<Partial<WakeOomGuardRecord>>(
        CHAT_WAKE_OOM_GUARD_KEY,
      );
      if (
        previous &&
        typeof previous.count === "number" &&
        Number.isFinite(previous.count) &&
        typeof previous.at === "number" &&
        Date.now() - previous.at < CHAT_WAKE_OOM_GUARD_WINDOW_MS
      ) {
        count = Math.max(0, Math.floor(previous.count)) + 1;
        if (count > 1) windowStartedAt = previous.at;
      }
      this.ctx.storage.kv.put<WakeOomGuardRecord>(CHAT_WAKE_OOM_GUARD_KEY, {
        count,
        at: windowStartedAt,
      });
    } catch (error) {
      // The breaker is a safety net; never let its bookkeeping fail a wake.
      console.error("[ChatThreadDO] wake OOM guard write failed", error);
      return;
    }
    if (count < CHAT_WAKE_OOM_QUARANTINE_AFTER) return;
    this.quarantineStreamBuffers(count);
  }

  private resetWakeOomGuard(): void {
    try {
      this.ctx.storage.kv.put<WakeOomGuardRecord>(CHAT_WAKE_OOM_GUARD_KEY, {
        count: 0,
        at: Date.now(),
      });
    } catch (error) {
      console.error("[ChatThreadDO] wake OOM guard reset failed", error);
    }
  }

  /**
   * Last resort for a thread that cannot finish a wake: drop the resumable-stream
   * buffers (`clearAll` deletes both tables' rows AND forgets the restored active
   * stream, so nothing later tries to replay or reconstruct from them) and clear
   * ai-chat's live "recovering…" flag, whose only other clearer is the recovery
   * path this wake never reaches. The turn's content is not lost — pi_core_messages
   * is canonical and the render history is already persisted; what is lost is the
   * ability to resume that turn's stream, which is the price of a bootable DO.
   *
   * Refused unless the buffers are big enough to plausibly BE the problem. The
   * breaker cannot observe an OOM directly, so without this gate any repeated
   * wake failure — a storage hiccup in the orphan-marker sweep, a `setState` on a
   * nameless alarm wake, a bad deploy of onStart — would cash in three attempts
   * against an actively recoverable turn and delete the settled partial the
   * recovery path was about to persist.
   */
  private quarantineStreamBuffers(count: number): void {
    try {
      const storedBytes = this.storedStreamChunkBytes();
      if (storedBytes < this.wakeQuarantineMinStoredBytes()) {
        this.recordChatThreadObservabilityEvent("chat_do_wake_quarantine", {
          operation: "wake_oom_guard",
          status: "skipped_small_buffer",
          severity: "warn",
          count,
          size: storedBytes,
        });
        return;
      }
      const stream = this._resumableStream as unknown as
        | { clearAll?: () => void }
        | undefined;
      if (typeof stream?.clearAll === "function") {
        stream.clearAll();
      } else {
        this.ctx.storage.sql.exec("delete from cf_ai_chat_stream_chunks");
        this.ctx.storage.sql.exec("delete from cf_ai_chat_stream_metadata");
      }
      this.ctx.storage.kv.delete(CHAT_RECOVERING_KEY);
      // The rows those ids described are gone, so the durable degraded set has
      // nothing left to remember.
      this.clearDegradedStreamIds();
      this.recordChatThreadObservabilityEvent("chat_do_wake_quarantine", {
        operation: "wake_oom_guard",
        status: "stream_buffers_cleared",
        severity: "error",
        count,
        size: storedBytes,
      });
    } catch (error) {
      this.recordChatThreadObservabilityEvent("chat_do_wake_quarantine", {
        operation: "wake_oom_guard",
        status: "failed",
        severity: "error",
        count,
        error,
      });
    }
  }

  /** Set once the SDK's replay entry points have been replaced on this instance. */
  private boundedReplayStream?: ResumableStreamReplayInternals;
  /** Set once the recovery-partial read has been bounded on this instance. */
  private boundedRecoveryPartialRead: boolean = false;

  /**
   * Replace every whole-buffer read of the replay tables with the paged,
   * degraded-aware versions below. Installed on the instance rather than the
   * prototype so nothing leaks across DO classes in the isolate, and idempotent
   * because the constructor's onStart wrapper runs on every cold wake.
   *
   * All FOUR readers, not just `replayChunks`: the two terminal readers are
   * reachable from any client's resume ACK after the turn ended (a completion
   * race, or an errored turn's `_replayTerminalOnAck`) and the recovery-partial
   * read is reachable with no client at all, on the wake path, before app code
   * gets to run.
   */
  private installBoundedStreamReplay(): void {
    this.installBoundedRecoveryPartialRead();
    const stream = this._resumableStream as unknown as
      | ResumableStreamReplayInternals
      | undefined;
    if (!stream || this.boundedReplayStream === stream) return;
    this.boundedReplayStream = stream;
    stream.replayChunks = (connection: Connection, requestId: string) =>
      this.replayStreamChunksBounded(stream, connection, requestId);
    stream.replayCompletedChunksByRequestId = (
      connection: Connection,
      requestId: string,
    ) => this.replayTerminalChunksBounded(stream, connection, requestId, "completed");
    stream.replayErroredChunksByRequestId = (
      connection: Connection,
      requestId: string,
    ) => this.replayTerminalChunksBounded(stream, connection, requestId, "error");
  }

  /**
   * Bound `AIChatAgent._getPartialStreamText`, the recovery-classification read.
   * It is `private` in the SDK's declarations, so it is wrapped on the instance
   * the same way this class already wraps other ai-chat privates.
   *
   * This is the read that OOM-killed whale threads: `_checkRunFibers` →
   * `handleChatFiberRecovery` → `getPartialStreamText` runs inside the framework's
   * startup wrapper, with no client and no transport, and the SDK's
   * `getStreamChunks` selects every body for the stream and expands each packed
   * row into one object per chunk. The store-side ceiling bounds streams written
   * from now on, but a buffer that predates it is still read whole — and because
   * the fiber row is only deleted AFTER the hook returns, every wake redoes the
   * identical read.
   */
  private installBoundedRecoveryPartialRead(): void {
    if (this.boundedRecoveryPartialRead) return;
    const agent = this as unknown as {
      _getPartialStreamText?: (streamId: string) => ChatRecoveryPartial;
    };
    const sdkGetPartialStreamText = agent._getPartialStreamText;
    if (typeof sdkGetPartialStreamText !== "function") return;
    this.boundedRecoveryPartialRead = true;
    agent._getPartialStreamText = (streamId: string): ChatRecoveryPartial => {
      // `_streamStoredBytesFor` answers from the live tally or ONE sum query over
      // row lengths — it never touches a body, so the pre-check itself is safe on
      // a buffer that cannot be read.
      const storedBytes = this._streamStoredBytesFor(streamId);
      if (storedBytes <= this.recoveryPartialMaxStoredBytes()) {
        return sdkGetPartialStreamText.call(this, streamId);
      }
      this.markStreamReplayDegradedFor(
        streamId,
        storedBytes,
        "recovery_read_skipped",
      );
      // An empty partial means recovery treats the turn as having produced
      // nothing resumable: it re-drives from pi_core_messages (canonical) rather
      // than from a prefix it cannot load. Losing the prefix is strictly better
      // than never booting.
      return { text: "", parts: [], hasSettledToolResults: false };
    };
  }

  /**
   * `ResumableStream.replayChunks` with the whole-buffer materialization removed
   * and the transport it has to fit taken into account. The chunk read is paged by
   * rows AND bytes instead of one `select *`; a degraded stream (buffer capped or
   * known-truncated, so a replay would show a truncated turn anyway) skips chunk
   * replay entirely and just attaches the client to live; and a replay whose
   * frames would not fit one SSE sink stops early and does the same, because the
   * alternative is the sink killing the connection and the client asking for the
   * identical replay on every reconnect. The CHAT_MESSAGES snapshot the connect
   * chain sends and the turn-end persist are what close those gaps.
   *
   * Everything else is the SDK's contract, frame for frame: a failed send returns
   * null with the stream LEFT ACTIVE (so the next reattach retries the whole
   * replay), a stream that changed mid-replay gets a `done` frame, an orphaned
   * stream gets `done` + completion and returns its id for the caller's
   * orphan-persist, and a live stream gets the `replayComplete` terminator.
   */
  private replayStreamChunksBounded(
    stream: ResumableStreamReplayInternals,
    connection: Connection,
    requestId: string,
  ): string | null {
    const streamId = stream.activeStreamId;
    if (!streamId) return null;
    stream.flushBuffer();
    const continuation = stream._activeIsContinuation === true;
    const outcome = this.replayStoredChunkFrames(
      connection,
      streamId,
      requestId,
      continuation,
    );
    if (outcome === "aborted") {
      // The peer is gone; the SDK leaves the stream active so the next reattach
      // retries. Count it — a buffer that cannot fit the wire dies here on EVERY
      // reconnect, and the Nth abort is what converts that loop into attach-to-live.
      this.noteStreamReplayAborted(streamId);
      return null;
    }
    if (outcome === "complete") this.noteStreamReplayCompleted(streamId);

    if (stream.activeStreamId !== streamId) {
      sendIfOpen(connection, this.replayDoneFrame(requestId, continuation));
      return null;
    }
    if (!stream.isLive) {
      sendIfOpen(connection, this.replayDoneFrame(requestId, continuation));
      stream.complete(streamId);
      return streamId;
    }
    sendIfOpen(connection, this.replayCompleteFrame(requestId, continuation));
    return null;
  }

  /**
   * `replayCompletedChunksByRequestId` / `replayErroredChunksByRequestId`, paged.
   * Both are reachable from an ordinary client resume ACK once a turn has ended
   * and, unpatched, both read the stream's whole buffer in one `select *` with no
   * degraded check — the same materialization as `replayChunks`, on a path a page
   * load can drive once per tab.
   *
   * Return contracts are the SDK's, and they differ between the two: `completed`
   * returns false when no completed stream exists and otherwise the terminal
   * `done` frame's send result; `error` returns TRUE when no errored stream exists
   * (nothing to replay, caller proceeds to its own terminal frame) and sends no
   * terminal frame itself.
   */
  private replayTerminalChunksBounded(
    stream: ResumableStreamReplayInternals,
    connection: Connection,
    requestId: string,
    status: "completed" | "error",
  ): boolean {
    stream.flushBuffer();
    const [row] = this.ctx.storage.sql
      .exec<{ id: string; is_continuation: number | null }>(
        "select id, is_continuation from cf_ai_chat_stream_metadata" +
          " where request_id = ? and status = ? order by created_at desc limit 1",
        requestId,
        status,
      )
      .toArray();
    if (!row) return status === "error";
    const continuation = row.is_continuation === 1;
    const outcome = this.replayStoredChunkFrames(
      connection,
      row.id,
      requestId,
      continuation,
    );
    if (outcome === "aborted") {
      this.noteStreamReplayAborted(row.id);
      return false;
    }
    if (outcome === "complete") this.noteStreamReplayCompleted(row.id);
    if (status === "error") return true;
    return sendIfOpen(connection, this.replayDoneFrame(requestId, continuation));
  }

  private replayContentFrame(
    body: string,
    requestId: string,
    continuation: boolean,
  ): string {
    return JSON.stringify({
      body,
      done: false,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      replay: true,
      ...(continuation && { continuation: true }),
    });
  }

  private replayDoneFrame(requestId: string, continuation: boolean): string {
    return JSON.stringify({
      body: "",
      done: true,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      replay: true,
      ...(continuation && { continuation: true }),
    });
  }

  private replayCompleteFrame(requestId: string, continuation: boolean): string {
    return JSON.stringify({
      body: "",
      done: false,
      id: requestId,
      type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
      replay: true,
      replayComplete: true,
      ...(continuation && { continuation: true }),
    });
  }

  /**
   * Test seam: one call per page of a replay read, with the body bytes that page
   * materialized and the rows it covered. The whole point of paging is that this
   * stays bounded, and nothing else about the read is observable from outside.
   */
  protected onReplayPageRead?: (pageBytes: number, rows: number) => void;

  /**
   * Send one stream's stored chunks as replay content frames, paged by rows AND
   * bytes, bailing before the transport's queue cap. Sends no terminal frame of
   * any kind — the callers own those, because their contracts differ.
   */
  private replayStoredChunkFrames(
    connection: Connection,
    streamId: string,
    requestId: string,
    continuation: boolean,
  ): ChatReplayOutcome {
    if (this._isStreamReplayDegraded(streamId)) return "skipped";
    // The SDK read every row in ONE query, so a segment flushed by the still
    // live LLM reader during the replay was never replayed — it reaches this
    // client as a live broadcast instead (the ack already un-suppressed it).
    // Paging must respect the same boundary or those chunks arrive twice.
    const [{ max_index: lastChunkIndex } = { max_index: null }] = this.ctx.storage.sql
      .exec<{ max_index: number | null }>(
        "select max(chunk_index) as max_index from cf_ai_chat_stream_chunks where stream_id = ?",
        streamId,
      )
      .toArray();
    if (lastChunkIndex === null) return "complete";
    let afterChunkIndex = -1;
    let sentChars = 0;
    for (;;) {
      // Row LENGTHS first: bodies are what must not pile up, and a segment row is
      // sized in bytes by the SDK, so a row limit alone is not a byte bound.
      const lengths = this.ctx.storage.sql
        .exec<{ chunk_index: number; bytes: number | null }>(
          "select chunk_index, length(cast(body as blob)) as bytes" +
            " from cf_ai_chat_stream_chunks" +
            " where stream_id = ? and chunk_index > ? and chunk_index <= ?" +
            " order by chunk_index asc limit ?",
          streamId,
          afterChunkIndex,
          lastChunkIndex,
          CHAT_REPLAY_BATCH_SEGMENTS,
        )
        .toArray();
      if (lengths.length === 0) return "complete";
      // Always take at least one row (a single row is already bounded by the
      // SDK's per-chunk ceiling), then as many more as the byte budget allows.
      let pageEndIndex = lengths[0]!.chunk_index;
      let pageBytes = lengths[0]!.bytes ?? 0;
      for (let index = 1; index < lengths.length; index++) {
        const rowBytes = lengths[index]!.bytes ?? 0;
        if (pageBytes + rowBytes > this.replayPageMaxBytes()) break;
        pageBytes += rowBytes;
        pageEndIndex = lengths[index]!.chunk_index;
      }
      const page = this.ctx.storage.sql
        .exec<{ chunk_index: number; body: string }>(
          "select chunk_index, body from cf_ai_chat_stream_chunks" +
            " where stream_id = ? and chunk_index > ? and chunk_index <= ?" +
            " order by chunk_index asc",
          streamId,
          afterChunkIndex,
          pageEndIndex,
        )
        .toArray();
      this.onReplayPageRead?.(pageBytes, page.length);
      if (page.length === 0) return "complete";
      for (const row of page) {
        for (const body of unpackReplaySegmentBody(row.body)) {
          const frame = this.replayContentFrame(body, requestId, continuation);
          if (sentChars + frame.length > this.replayMaxSentChars()) {
            this.markStreamReplayTransportExhausted(streamId, sentChars);
            return "budget_exhausted";
          }
          if (!sendIfOpen(connection, frame)) return "aborted";
          sentChars += frame.length;
        }
        afterChunkIndex = row.chunk_index;
      }
    }
  }

  /**
   * This buffer cannot be replayed over one SSE connection. Remember it durably so
   * reconnects stop re-reading and re-encoding it, and record the band: the
   * store-side ceiling is supposed to make this unreachable, so an event here means
   * the two caps have drifted apart.
   */
  private markStreamReplayTransportExhausted(
    streamId: string,
    sentChars: number,
  ): void {
    console.warn("[ChatThreadDO] stream replay exceeded the transport budget", {
      streamId,
      sentChars,
      budgetChars: this.replayMaxSentChars(),
    });
    this.markStreamReplayDegradedFor(streamId, sentChars, "transport_budget");
  }

  /** Replays of one stream that died mid-way, per isolate. */
  private streamReplayAbortCounts?: Map<string, number>;

  private noteStreamReplayAborted(streamId: string): void {
    const counts = (this.streamReplayAbortCounts ??= new Map<string, number>());
    const attempts = (counts.get(streamId) ?? 0) + 1;
    counts.set(streamId, attempts);
    if (attempts < CHAT_REPLAY_MAX_ABORTED_ATTEMPTS) return;
    counts.delete(streamId);
    // A client that really went away costs one replay. A buffer that does not fit
    // the wire costs the same read-and-encode on every reconnect, forever, and the
    // byte arithmetic that is supposed to prevent that is an estimate. Stop.
    this.markStreamReplayDegradedFor(
      streamId,
      this.storedStreamChunkBytes(streamId),
      "replay_aborted",
    );
  }

  private noteStreamReplayCompleted(streamId: string): void {
    this.streamReplayAbortCounts?.delete(streamId);
  }

  /** Stored chunk bytes, for one stream or for the whole thread. Row lengths
   *  only — never a body, so it is safe on a buffer that cannot be read. */
  private storedStreamChunkBytes(streamId?: string): number {
    try {
      const [row] = (
        streamId === undefined
          ? this.ctx.storage.sql.exec<{ bytes: number | null }>(
              "select sum(length(cast(body as blob))) as bytes from cf_ai_chat_stream_chunks",
            )
          : this.ctx.storage.sql.exec<{ bytes: number | null }>(
              "select sum(length(cast(body as blob))) as bytes from cf_ai_chat_stream_chunks where stream_id = ?",
              streamId,
            )
      ).toArray();
      const bytes = row?.bytes;
      return typeof bytes === "number" && Number.isFinite(bytes) ? bytes : 0;
    } catch (error) {
      console.error("[ChatThreadDO] stored stream chunk byte read failed", error);
      return 0;
    }
  }

  /** Why the `_onStreamReplayDegraded` currently in flight fired. Only ever set
   *  around a single {@link markStreamReplayDegradedFor} call; the patched
   *  funnel's own byte ceiling is the default, "capped". */
  private streamReplayDegradeReason: ChatReplayDegradeReason = "capped";

  /**
   * Mark a stream's replay buffer unusable for a host-side reason. Always restores
   * the default reason, because `_markStreamReplayDegraded` is a no-op for a stream
   * the SDK already marked — leaving the reason set would mislabel the NEXT
   * stream's event.
   */
  private markStreamReplayDegradedFor(
    streamId: string,
    storedBytes: number,
    reason: ChatReplayDegradeReason,
  ): void {
    this.streamReplayDegradeReason = reason;
    try {
      this._markStreamReplayDegraded(streamId, storedBytes);
    } finally {
      this.streamReplayDegradeReason = "capped";
    }
  }
  /** In-memory mirror of {@link CHAT_REPLAY_DEGRADED_STREAMS_KEY}. */
  private degradedStreamIdCache?: Set<string>;

  private durableDegradedStreamIds(): Set<string> {
    if (this.degradedStreamIdCache) return this.degradedStreamIdCache;
    let ids: string[] = [];
    try {
      const stored = this.ctx.storage.kv.get<unknown>(
        CHAT_REPLAY_DEGRADED_STREAMS_KEY,
      );
      if (Array.isArray(stored)) {
        ids = stored.filter((id): id is string => typeof id === "string");
      }
    } catch (error) {
      console.error("[ChatThreadDO] degraded stream id read failed", error);
    }
    this.degradedStreamIdCache = new Set(ids);
    return this.degradedStreamIdCache;
  }

  private persistDegradedStreamId(streamId: string): void {
    const ids = this.durableDegradedStreamIds();
    if (ids.has(streamId)) return;
    const next = [...ids, streamId].slice(-CHAT_REPLAY_DEGRADED_STREAMS_MAX);
    this.degradedStreamIdCache = new Set(next);
    try {
      this.ctx.storage.kv.put(CHAT_REPLAY_DEGRADED_STREAMS_KEY, next);
    } catch (error) {
      console.error("[ChatThreadDO] degraded stream id write failed", error);
    }
  }

  private clearDegradedStreamIds(): void {
    this.degradedStreamIdCache = new Set();
    try {
      this.ctx.storage.kv.delete(CHAT_REPLAY_DEGRADED_STREAMS_KEY);
    } catch (error) {
      console.error("[ChatThreadDO] degraded stream id clear failed", error);
    }
  }

  /**
   * The SDK settles an unknown stream's verdict from a `sum(length(body))` over
   * PACKED rows, which is a different currency than the store-time tally that
   * produced the live verdict (a packed row re-escapes every body it holds), and
   * the host's own bail-outs (transport budget, repeated aborted replays, skipped
   * recovery read) are not byte-derived at all. So the ids are remembered durably:
   * a buffer that was truncated stays truncated across hibernation, and — since
   * the tally is a deliberate OVER-estimate of on-disk bytes — a recompute can
   * never contradict a live verdict by declaring a truncated buffer healthy and
   * replaying it as if complete.
   */
  protected override _isStreamReplayDegraded(streamId: string | null): boolean {
    if (!streamId) return false;
    if (this.durableDegradedStreamIds().has(streamId)) return true;
    return super._isStreamReplayDegraded(streamId);
  }

  /** One event per stream whose replay buffer becomes unusable, for any reason.
   *  Replaces the SDK's log-only default, so it keeps the log line too. */
  protected override _onStreamReplayDegraded(info: {
    streamId: string;
    storedBytes: number;
    limitBytes: number;
  }): void {
    const reason = this.streamReplayDegradeReason;
    this.streamReplayDegradeReason = "capped";
    this.persistDegradedStreamId(info.streamId);
    console.warn("[ChatThreadDO] stream replay buffer degraded", {
      streamId: info.streamId,
      storedBytes: info.storedBytes,
      limitBytes: info.limitBytes,
      reason,
    });
    this.recordChatThreadObservabilityEvent("chat_stream_replay_degraded", {
      operation: "stream_replay_buffer",
      status: reason,
      severity: "warn",
      size: info.storedBytes,
    });
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
    // Same give-up rule as every other abandonment: whatever the journal holds was
    // already accepted, so commit it before the marker + journal are deleted.
    await this.releasePiTurnAfterGiveUp();
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

  /**
   * Handshake-only: push the in-memory resident window synchronously so
   * onConnect stays bounded (no pi_core derive, no SQL page). Background
   * reconcile follows with derive-on-read.
   */
  private sendResidentRenderHistoryToConnection(connection: Connection): void {
    try {
      const messages = this.messages as UIMessage[];
      if (!Array.isArray(messages) || messages.length === 0) return;
      connection.send(
        JSON.stringify({
          messages,
          type: CHAT_MESSAGE_TYPES.CHAT_MESSAGES,
        }),
      );
    } catch (error) {
      console.error(
        "[ChatThreadDO] failed to send resident render history on connect",
        error,
      );
    }
  }

  private async sendRenderHistoryToConnection(connection: Connection): Promise<void> {
    try {
      const page = await this.getDerivedUiMessagePage();
      if (page.messages.length === 0) return;
      connection.send(
        JSON.stringify({
          messages: page.messages,
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
      // Settled history is derive-on-read from pi_core; only sweep a stranded
      // active-turn marker before shipping the resident derived page.
      await this.sweepOrphanedActiveTurnMarker();
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
      await this.sendRenderHistoryToConnection(connection);
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
      await this.sendRenderHistoryToConnection(connection);
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
    // resident ai-chat window, then derive-on-read after the 101 (and after any
    // orphaned active-turn sweep) so settled order comes from pi_core.
    this.syncAgentState();
    this.sendResidentRenderHistoryToConnection(connection);
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

  /**
   * Lazily created: the framework constructors can already broadcast (an
   * `initialState` push fans out through `_broadcastProtocol`) before this
   * class's field initializers run, and prototype-based test fakes never run
   * them at all.
   */
  private get sseConnections(): Map<string, SseConnection> {
    return (this.sseConnectionRegistry ??= new Map<string, SseConnection>());
  }

  /** In-flight onClose chains, so a reattach on the same id can wait for one. */
  private get sseCloseChains(): Map<string, Promise<void>> {
    return (this.sseCloseChainRegistry ??= new Map<string, Promise<void>>());
  }

  /** Shared undrained-byte budget for the registry's sinks. */
  private get sseQueueBudget(): SseQueueBudget {
    return (this.sseQueueBudgetRef ??= createSseQueueBudget());
  }

  /**
   * Fan out to the SSE registry, then delegate exactly once. `Agent.broadcast`
   * iterates `super.getConnections()` (partyserver's hibernating store), so
   * overriding `getConnections` alone would leave every SSE client silent — and
   * `AIChatAgent.broadcast` has a pre-delegation side effect (agent-tool
   * interception), so `super.broadcast` must be called once and not bypassed.
   */
  broadcast(msg: string | ArrayBuffer | ArrayBufferView, without?: string[]): void {
    for (const connection of this.sseConnections.values()) {
      if (!connection.isOpen) continue;
      if (without?.includes(connection.id)) continue;
      try {
        connection.send(msg);
      } catch (error) {
        // `SseConnection.send` throws the SDK's closed-socket TypeError so that
        // replay loops abort (sendIfOpen contract); a fan-out must not stop at
        // one dead peer. The throw already tore that connection down.
        if (!isClosedStreamSendError(error)) {
          console.error("[ChatThreadDO] SSE broadcast send failed", error);
        }
      }
    }
    super.broadcast(msg, without);
  }

  getConnection<TState = unknown>(id: string): Connection<TState> | undefined {
    const sseConnection = this.sseConnections.get(id);
    if (sseConnection) return sseConnection as unknown as Connection<TState>;
    return super.getConnection<TState>(id);
  }

  /**
   * Keeps `_isConnectionPresent` (resume-handshake ownership), `getChatSockets`,
   * `hasAvailableBrowserUser` and onClose's last-socket auto-answer rule correct
   * for SSE clients.
   */
  *getConnections<TState = unknown>(tag?: string): IterableIterator<Connection<TState>> {
    for (const connection of this.sseConnections.values()) {
      if (!connection.isOpen) continue;
      if (tag && !connection.tags.includes(tag)) continue;
      yield connection as unknown as Connection<TState>;
    }
    yield* super.getConnections<TState>(tag);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // No WebSocket upgrade is ever delegated to `Server.fetch`: the worker has
    // no chat upgrade route left, so an upgrade cannot reach this DO. The
    // partyserver/Agents connection machinery below is still live — the SSE
    // shim drives onConnect/onMessage/onClose through it.

    // Chat transport (SSE receive + POST send). This override never delegates
    // plain HTTP to `Server.fetch`, so startup (onStart: stream restore, chat
    // recovery, MCP) has to be forced before any frame is served.
    if (request.method === "GET" && url.pathname.endsWith("/sse")) {
      await this.__unsafe_ensureInitialized();
      return this.handleChatStreamAttach(request, url);
    }
    if (request.method === "POST" && url.pathname.endsWith("/call")) {
      await this.__unsafe_ensureInitialized();
      return this.handleChatTransportCall(request, url);
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

  /**
   * onConnect's two auth gates, expressed as HTTP so a denial lands before the
   * stream body starts (a committed 200 can only carry a `bye`). Mirrors
   * {@link onConnect}: 1008 'forbidden' → 403, 1013
   * 'auth_temporarily_unavailable' → 503 (retryable, never a false terminal).
   */
  private authorizeChatTransportRequest(request: Request, url: URL): Response | null {
    const incomingOrgId = url.searchParams.get("orgId")?.trim() || "";
    if (
      this.chatContext?.orgId &&
      incomingOrgId &&
      this.chatContext.orgId !== incomingOrgId
    ) {
      return new Response("forbidden", { status: 403 });
    }

    const userId = request.headers.get(HEADER_USER_ID)?.trim() || "";
    const authDegraded = request.headers.get(HEADER_AUTH_DEGRADED)?.trim() === "1";
    if (authDegraded) {
      if (
        !userId ||
        !this.chatContext ||
        !this.isPreviouslyAuthorizedChatUser(userId)
      ) {
        return new Response("auth_temporarily_unavailable", { status: 503 });
      }
    } else if (userId) {
      this.recordAuthorizedChatUser(userId);
    }
    return null;
  }

  /**
   * Registry key for one client stream. `_pk` is CLIENT-minted and a thread is
   * shared by every workspace member with access, so keying the registry on `_pk`
   * alone would make one participant's stream addressable by another who guesses
   * the value — either killing it (an attach retires the shim on that key) or
   * driving a resume replay into it (`POST /call` dispatches against it).
   * Namespacing by the worker-authenticated user id (the client's own header is
   * stripped at the trust boundary) makes a shim reachable only by its owner.
   */
  private sseRegistryKey(request: Request, streamKey: string): string {
    const userId = request.headers.get(HEADER_USER_ID)?.trim() || "";
    return userId ? `${userId}::${streamKey}` : streamKey;
  }

  /**
   * Make room for one more stream for this request's authenticated user by
   * retiring their oldest ones (insertion-ordered registry). Evicting rather than
   * refusing keeps the tab the user is actually looking at working; the retired
   * stream ends without a `bye`, which the client treats as a reconnectable drop.
   */
  private evictExcessSseConnectionsForUser(request: Request): void {
    const userId = request.headers.get(HEADER_USER_ID)?.trim() || "";
    if (!userId) return;
    const prefix = `${userId}::`;
    const owned: SseConnection[] = [];
    for (const [id, connection] of this.sseConnections) {
      if (id.startsWith(prefix)) owned.push(connection);
    }
    // Room for the attach that is about to register, and never a negative slice.
    const excess = owned.length - SSE_MAX_CONNECTIONS_PER_USER + 1;
    if (excess <= 0) return;
    for (const connection of owned.slice(0, excess)) {
      this.recordChatThreadObservabilityEvent("chat_sse_attach_evicted", {
        operation: "sse_attach",
        status: "too_many_user_streams",
        severity: "warn",
        count: owned.length,
      });
      connection.abort(1006, "stream_evicted");
    }
  }

  private async handleChatStreamAttach(request: Request, url: URL): Promise<Response> {
    const denial = this.authorizeChatTransportRequest(request, url);
    if (denial) return denial;

    const connectionId = this.sseRegistryKey(
      request,
      url.searchParams.get("_pk")?.trim() || crypto.randomUUID(),
    );
    // A reattach that reuses `_pk` must not leave the previous shim registered:
    // broadcasts would go to a writer nobody reads. Retire it first, and let its
    // close chain finish — that cleanup is keyed by connection id, which this
    // attach is about to reuse, so a late run would wipe the new stream's
    // resume-handshake registration and silently exclude it from broadcasts.
    const previous = this.sseConnections.get(connectionId);
    if (previous) {
      previous.abort(1006, "stream_replaced");
      await this.sseCloseChains.get(connectionId);
    }

    // Retiring the same-key shim happens first, so a normal reattach is never
    // what trips these. Beyond them the DO is being used as a memory amplifier:
    // every attach queues its own copy of the render window.
    this.evictExcessSseConnectionsForUser(request);
    if (this.sseConnections.size >= SSE_MAX_CONNECTIONS) {
      // Only reachable with many distinct members holding many streams each — one
      // member's streams are bounded by the eviction above, so their own retries
      // can never produce this. Another member's stream must not be evicted for
      // it, so refuse: 429 is retryable for the client (never a false terminal),
      // and it reattaches on its normal backoff.
      this.recordChatThreadObservabilityEvent("chat_sse_attach_rejected", {
        operation: "sse_attach",
        status: "too_many_streams",
        severity: "warn",
        count: this.sseConnections.size,
      });
      return new Response("too_many_streams", {
        status: 429,
        headers: { "Retry-After": "5" },
      });
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const connection = new SseConnection({
      id: connectionId,
      uri: request.url,
      server: this.resolvePartyServerName(),
      sink: createSseStreamSink(writer, this.sseQueueBudget),
      onTeardown: (torndown, code, reason) =>
        this.teardownSseConnection(torndown, code, reason),
    });
    this.sseConnections.set(connectionId, connection);
    // A new viewer restarts the idle grace: `sseIdleSince` is per-DO, so without
    // the reset a fresh attach inherits an older stream's accumulated silence and
    // can be parked seconds after it opened.
    this.sseIdleSince = null;
    this.recordSseViewerPresence(true);
    this.startSseHeartbeat();

    // Cancelling the response body errors the writable half; the request signal
    // covers proxies that abort without draining. Either way the stream is gone.
    void writer.closed.then(
      () => connection.abort(1006, "stream_closed"),
      () => connection.abort(1006, "stream_closed"),
    );
    if (request.signal.aborted) {
      connection.abort(1006, "client_aborted");
    } else {
      request.signal.addEventListener(
        "abort",
        () => connection.abort(1006, "client_aborted"),
        { once: true },
      );
    }

    // The FULL wrapped chain, so the frame order (resume/pending/recovering →
    // identity → state → mcp → app history + background reconcile) is the
    // socket's, not a reimplementation of it. Frames queue in the writer, so
    // this can run after the response is returned.
    //
    // The chain reads routing input off the REQUEST HEADERS: Agent's onConnect
    // wrapper honours `x-cf-agents-subagent-url` over `connection.uri` and would
    // divert this attach into sub-agent resolution instead of the chat protocol.
    // The worker strips those headers at the trust boundary; this is the DO-side
    // backstop, and it is a no-op for a clean request.
    const connectRequest = withoutReservedTransportHeaders(request);
    this.ctx.waitUntil(
      Promise.resolve()
        .then(() =>
          this.onConnect(connection as unknown as Connection, {
            request: connectRequest,
          }),
        )
        .catch((error) => {
          // A peer that left mid-handshake surfaces as the closed-send TypeError;
          // teardown already ran and the client reattaches on its own.
          if (isClosedStreamSendError(error)) return;
          console.error("[ChatThreadDO] SSE connect chain failed", error);
          connection.closeWithBye("retry", 1011, "connect_failed");
        }),
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  private async handleChatTransportCall(request: Request, url: URL): Promise<Response> {
    const denial = this.authorizeChatTransportRequest(request, url);
    if (denial) return denial;

    // Client traffic is liveness: the idle policy measures silence, and a POST is
    // the only silence-breaking signal a client can send while a turn is not
    // running (the stream carries nothing upstream).
    this.sseIdleSince = null;

    // A POST is independent of the stream, so a client's first action on a
    // thread can land before its first attach — where the socket transport
    // guaranteed onConnect had already filled the scope/identity sink. Bootstrap
    // it in that case ONLY: an established thread keeps its stored context
    // rather than having identity rewritten by whoever posted last.
    if (!this.chatContext) this.captureChatContextFromRequest(url, request);

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return new Response("Unreadable frame", { status: 400 });
    }
    let frame: ChatTransportFrame | null = null;
    try {
      frame = JSON.parse(raw) as ChatTransportFrame | null;
    } catch {
      return new Response("Invalid frame", { status: 400 });
    }
    const frameType =
      frame && typeof frame === "object" && typeof frame.type === "string"
        ? frame.type
        : null;

    if (
      frameType === CHAT_MESSAGE_TYPES.STREAM_RESUME_REQUEST ||
      frameType === CHAT_MESSAGE_TYPES.STREAM_RESUME_ACK
    ) {
      // The handshake reply and the replay are written to the stream's sink, and
      // the framework keys its pending-resume/replay bookkeeping off the
      // connection OBJECT, so this must dispatch against the live registered
      // shim. Nothing to dispatch against → the client reattaches and retries.
      const streamKey = url.searchParams.get("_pk")?.trim() || "";
      const connection = streamKey
        ? this.sseConnections.get(this.sseRegistryKey(request, streamKey))
        : undefined;
      if (!connection || !connection.isOpen) {
        return new Response("No live chat stream", { status: 409 });
      }
      try {
        await this.onMessage(connection as unknown as Connection, raw);
      } catch (error) {
        // The stream died while its own replay was being written (the shim
        // reports that as the SDK's closed-send TypeError, which is what makes
        // replayChunks leave the stream active). Same answer as a missing shim:
        // reattach and retry the handshake.
        if (!isClosedStreamSendError(error)) throw error;
        return new Response("No live chat stream", { status: 409 });
      }
      return new Response(null, { status: 204 });
    }

    if (frameType === "rpc") {
      const method = typeof frame?.method === "string" ? frame.method : "";
      if (!CHAT_TRANSPORT_CALLABLE_METHODS.has(method)) {
        this.recordChatThreadObservabilityEvent("chat_ws_frame_blocked", {
          operation: `rpc:${method || "unknown"}`,
          status: "blocked",
          severity: "warn",
        });
        return new Response("Unsupported rpc method", { status: 400 });
      }
      // RPCs must work while the stream is down (that is the point of POST
      // sends), so the reply is captured off a one-shot connection sharing the
      // stream's id rather than requiring a live sink.
      const { connection, frames } = createSseCaptureConnection({
        id: this.sseRegistryKey(
          request,
          url.searchParams.get("_pk")?.trim() || crypto.randomUUID(),
        ),
        uri: request.url,
        server: this.resolvePartyServerName(),
      });
      await this.onMessage(connection as unknown as Connection, raw);
      const response = frames.find((payload) => {
        try {
          return (JSON.parse(payload) as { type?: unknown }).type === "rpc";
        } catch {
          return false;
        }
      });
      return new Response(
        response ??
          JSON.stringify({
            type: "rpc",
            id: typeof frame?.id === "string" ? frame.id : "",
            success: false,
            error: "No rpc response produced",
          }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Everything else — including BLOCKED_CHAT_PROTOCOL_FRAME_TYPES — stays off
    // the HTTP boundary exactly as it is off the socket one.
    if (frameType && BLOCKED_CHAT_PROTOCOL_FRAME_TYPES.has(frameType)) {
      this.recordChatThreadObservabilityEvent("chat_ws_frame_blocked", {
        operation: frameType,
        status: "blocked",
        severity: "warn",
      });
    }
    return new Response("Unsupported frame", { status: 400 });
  }

  /**
   * `this.name` throws until partyserver has resolved the room name. The value
   * is only a deprecated informational field on the connection, so never let it
   * fail an attach.
   */
  private resolvePartyServerName(): string {
    try {
      return this.name;
    } catch {
      return this.chatContext?.threadId ?? "";
    }
  }

  private startSseHeartbeat(): void {
    if (this.sseHeartbeatTimer) return;
    this.sseHeartbeatTimer = setInterval(
      () => this.sweepSseConnections(),
      SSE_HEARTBEAT_INTERVAL_MS,
    );
  }

  private stopSseHeartbeat(): void {
    if (!this.sseHeartbeatTimer) return;
    clearInterval(this.sseHeartbeatTimer);
    this.sseHeartbeatTimer = null;
  }

  /** Keepalive plus idle-close policy; runs on the heartbeat tick. */
  private sweepSseConnections(): void {
    if (this.sseConnections.size === 0) {
      this.sseIdleSince = null;
      this.stopSseHeartbeat();
      return;
    }
    // A failed heartbeat (write rejected, or a write that has not drained inside
    // SSE_STREAM_STALL_MS — the only probe a quiet stream has) tears the
    // connection down, which unregisters it; Map iteration tolerates that
    // deletion. Done BEFORE the work check so a phantom peer cannot be pinned
    // resident by a pending question it will never answer.
    for (const connection of this.sseConnections.values()) {
      connection.heartbeat();
    }
    // Teardown already reset the idle clock and stopped this timer.
    if (this.sseConnections.size === 0) return;
    // A long-lived stream must keep its durable presence marker fresh, or an
    // eviction hours into a session looks like a viewer who left.
    this.refreshSseViewerPresence();
    if (this.hasLiveChatWorkForStream()) {
      this.sseIdleSince = null;
      return;
    }
    const idleSince = this.sseIdleSince ?? Date.now();
    this.sseIdleSince = idleSince;
    if (Date.now() - idleSince < SSE_IDLE_GRACE_MS) return;
    this.sseIdleSince = null;
    for (const connection of this.sseConnections.values()) {
      // A park is the transport's doing, not a departure; teardown records the
      // viewer as still present when the last stream leaves this way.
      connection.closeWithBye("idle", 1000, "idle");
    }
  }

  /**
   * Durable "a human was watching this thread" marker. The SSE registry is
   * isolate-local, so it is the only thing that survives an eviction/redeploy —
   * and recovery re-drives (including the alarm-driven OOM retry, which wakes the
   * DO with no client involved) ask for browser availability before any client
   * can possibly have reattached.
   */
  private recordSseViewerPresence(present: boolean): void {
    try {
      this.ctx.storage.kv.put(CHAT_SSE_VIEWER_KEY, {
        at: Date.now(),
        present,
      });
    } catch (error) {
      // Transport bookkeeping must never fail an attach or a teardown.
      console.error("[ChatThreadDO] failed to record SSE viewer presence", error);
    }
  }

  private refreshSseViewerPresence(): void {
    const record = this.readSseViewerPresence();
    if (
      record?.present &&
      Date.now() - record.at < SSE_PRESENCE_REFRESH_MS
    ) {
      return;
    }
    this.recordSseViewerPresence(true);
  }

  private readSseViewerPresence(): { at: number; present: boolean } | null {
    try {
      const record = this.ctx.storage.kv.get<{ at?: unknown; present?: unknown }>(
        CHAT_SSE_VIEWER_KEY,
      );
      if (!record || typeof record.at !== "number") return null;
      return { at: record.at, present: record.present === true };
    } catch {
      return null;
    }
  }

  /** A viewer seen recently enough (attached or idle-parked) to still count. */
  private hasPresumedViewer(): boolean {
    const record = this.readSseViewerPresence();
    if (!record?.present) return false;
    return Date.now() - record.at < SSE_PRESUMED_VIEWER_MS;
  }

  /** Work that must keep an attached stream open regardless of client silence. */
  private hasLiveChatWorkForStream(): boolean {
    if (this.isThreadStreaming()) return true;
    try {
      if (this._resumableStream.hasActiveStream()) return true;
    } catch {
      // Never let a transport sweep fail on framework state.
    }
    if (this.hasActiveChatRecovery()) return true;
    if ((this.browserPrompts?.pendingQuestionCount ?? 0) > 0) return true;
    return (this.browserPrompts?.pendingConnectionSetupPrompts?.().length ?? 0) > 0;
  }

  private teardownSseConnection(
    connection: SseConnection,
    code: number,
    reason: string,
  ): void {
    if (this.sseConnections.get(connection.id) === connection) {
      this.sseConnections.delete(connection.id);
    }
    if (this.sseConnections.size === 0) {
      this.sseIdleSince = null;
      this.stopSseHeartbeat();
      // Only the LAST stream's exit says anything about the viewer, and only an
      // idle park says the viewer is still there (the tab reopens the stream on
      // demand). Every other exit — client abort, write failure, stall, denial —
      // is a client that is gone as far as this transport can tell, exactly as a
      // closed WebSocket was.
      this.recordSseViewerPresence(reason === "idle");
    }
    // ai-chat's onClose wrapper is the ONLY cleanup for _pendingResumeConnections
    // / continuation / pre-stream registrations — skipping it leaves a dead id
    // permanently excluded from chat broadcasts (the thread goes quiet). Run it
    // off the current task so a send failure mid-broadcast cannot re-enter the
    // framework from inside its own fan-out loop.
    const chain = Promise.resolve()
      .then(() =>
        this.onClose(
          connection as unknown as Connection,
          code,
          reason,
          code === 1000,
        ),
      )
      .catch((error) => {
        console.error("[ChatThreadDO] SSE close chain failed", error);
      })
      .finally(() => {
        if (this.sseCloseChains.get(connection.id) === chain) {
          this.sseCloseChains.delete(connection.id);
        }
      });
    this.sseCloseChains.set(connection.id, chain);
    this.ctx.waitUntil(chain);
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

  // Params are the framework's (partyserver calls onClose(connection, code,
  // reason, wasClean)); this handler only cares that a client left, and the SSE
  // teardown path calls the same wrapped chain with them.
  async onClose(
    _connection?: Connection,
    _code?: number,
    _reason?: string,
    _wasClean?: boolean,
  ): Promise<void> {
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

  /**
   * Ceiling on how much pi_core payload one read may materialise in the isolate.
   * 4MB leaves ample room in a 128MB budget for the rest of a turn's state.
   */
  private static readonly PI_CORE_ROW_READ_MAX_BYTES = 4 * 1024 * 1024;

  getPreviewTarget(): PreviewTarget | null {
    return this.previewTarget;
  }

  getPiCoreMessageRows(limit = 200): PiCoreMessageRow[] {
    const resolvedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(2000, Math.floor(limit)))
      : 200;

    // Bounded by BYTES, not just row count. A row payload is capped at 1.5MB and
    // production threads carry rows over 200KB, so a caller-supplied row limit
    // says almost nothing about the allocation: asking this for 2000 rows of a
    // real thread built a 37,187,107-byte value in-isolate — 29% of a Durable
    // Object's 128MB budget, from a read-only admin call. Iterate the cursor
    // instead of materialising every row up front, and stop at the budget.
    const rows: Array<{ idx: number; payload: string; created_at: number }> = [];
    let bytes = 0;
    let truncated = false;
    const cursor = this.ctx.storage.sql.exec<{ idx: number; payload: string; created_at: number }>(
      "SELECT idx, payload, created_at FROM pi_core_messages ORDER BY idx DESC LIMIT ?",
      resolvedLimit,
    );
    for (const row of cursor) {
      const size = row.payload?.length ?? 0;
      // Always take one row, so a single oversized payload is still readable.
      if (rows.length > 0 && bytes + size > ChatThreadDO.PI_CORE_ROW_READ_MAX_BYTES) {
        truncated = true;
        break;
      }
      rows.push(row);
      bytes += size;
    }
    if (truncated) {
      // Say so rather than silently returning a short page: a caller comparing
      // row counts would otherwise read a byte-bounded page as "that is all
      // there is". Rows come back newest-first-trimmed, so page with `limit`.
      console.warn(
        `[ChatThreadDO] pi_core row read truncated at ${rows.length} row(s) / ${bytes} bytes (requested ${resolvedLimit})`,
      );
      this.recordChatThreadObservabilityEvent("pi_core_row_read_truncated", {
        operation: "admin_row_read",
        status: "truncated",
        severity: "warn",
        count: rows.length,
        size: bytes,
      });
    }

    return rows
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
    if (this.wasConnectionSetupResponseAccepted(response.requestId)) {
      return { accepted: true };
    }
    if (!this.browserPrompts.hasPendingConnectionSetup(response.requestId)) {
      return this.handleConnectionSetupResponse(response);
    }

    this.recordAcceptedConnectionSetupResponse(response.requestId);
    try {
      const result = await this.handleConnectionSetupResponse(response);
      if (!result.accepted) {
        this.forgetAcceptedConnectionSetupResponse(response.requestId);
      }
      return result;
    } catch (error) {
      this.forgetAcceptedConnectionSetupResponse(response.requestId);
      throw error;
    }
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

  /**
   * The whole visible transcript as parsed render messages. UNBOUNDED by
   * construction — every visible row is read, parsed, and kept resident — so it
   * is named for what it costs and its callers are audited
   * (scripts/check-unbounded-pi-core-callers.mjs). The bounded readers are
   * {@link deriveRenderWindow} (render pages), {@link readParsedPiCoreRowRange}
   * (mirror top-up / archive preserve) and
   * {@link loadBoundedPiCoreSessionWindow} (session build).
   */
  private async loadFullPiCoreParsedTranscriptUnbounded(
    threadId: string,
  ): Promise<AgentEvalParsedMessage[]> {
    const normalizedThreadId = threadId.trim() || this.chatContext?.threadId || "";
    const parsed: AgentEvalParsedMessage[] = [];

    // The browser rebuilds live assistant/tool content from the replay buffer,
    // so only canonical persisted history is returned here.
    const storedMessages = await this.loadFullPiCoreTranscriptUnbounded({
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

  /**
   * Public transcript RPC (admin explorer, agent evals, group-chat seeding,
   * legacy author heal). Thin wrapper over the unbounded parsed load: it is the
   * export surface, so it genuinely needs the whole thread — no request path may
   * call it (see the allowlist check).
   */
  async getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]> {
    return this.loadFullPiCoreParsedTranscriptUnbounded(threadId);
  }

  /**
   * The bounded, RESUMABLE twin of the parsed transcript load: parsed render
   * messages for one budgeted forward range of pi_core rows.
   *
   * Same policy as {@link loadFullPiCoreParsedTranscriptUnbounded} row for row
   * (render image policy, `piCoreMessageToParsedChatMessage`, toolResult
   * folding), and the same PARSED POSITIONS — an unstamped user row's id embeds
   * its index in the full load, so the range reconstructs absolute positions
   * from `idx` and the compaction watermark exactly as the derive pager does.
   *
   * The range ends at a turn boundary, never mid-turn: a batch that stopped on
   * its budget keeps taking rows while they are toolResults (an answer whose
   * call is above it) or continue a stamped assistant fold already in the batch.
   * A boundary in either of those places would drop a tool answer from the
   * mirror or split one turn across two upserts of the same render id.
   *
   * That is an invariant, not a preference, so `maxBoundaryExtraRows` is a
   * RETREAT trigger rather than a place the walk may stop: on hitting it the
   * range rewinds to the newest legal boundary it already passed (the rows after
   * it are simply re-read next call, and the cursor still moves forward). Only
   * when the range contains no legal boundary at all — one turn longer than the
   * whole budget — does the walk keep going, because at that point splitting the
   * turn corrupts the mirror and stopping inside it loses a tool answer, while
   * extending merely costs one turn's rows and is reported.
   */
  private readParsedPiCoreRowRange(options: {
    fromIdx: number;
    maxRows: number;
    maxChars: number;
    maxBoundaryExtraRows?: number;
  }): {
    parsed: AgentEvalParsedMessage[];
    /** Absolute position of `parsed[0]` in the full parsed transcript. */
    parsedStartIndex: number;
    /** First pi_core idx NOT covered — where the next call resumes. */
    nextIdx: number;
    reachedEnd: boolean;
    rowsRead: number;
    payloadChars: number;
  } {
    const { firstKeptIndex, summaryOffset, endIdx } =
      this.piCoreStore.piCoreVisibleWindow();
    const maxRows = Math.max(1, Math.floor(options.maxRows));
    const maxChars = Math.max(1, Math.floor(options.maxChars));
    const maxBoundaryExtraRows = Math.max(
      0,
      Math.floor(options.maxBoundaryExtraRows ?? PI_TOPUP_BOUNDARY_MAX_EXTRA_ROWS),
    );
    // A cursor left behind by a wholesale rewrite can name a row that no longer
    // exists; clamp it into the current visible window rather than going silent.
    const fromIdx = Math.min(
      Math.max(Math.floor(options.fromIdx), firstKeptIndex),
      Math.max(firstKeptIndex, endIdx),
    );
    const threadId = this.chatContext?.threadId ?? "";
    const parsed: AgentEvalParsedMessage[] = [];

    // The synthetic compaction summary occupies parsed index 0 of the full load,
    // so a range that starts at the watermark has to carry it or every id below
    // it shifts by one.
    let parsedStartIndex = fromIdx - firstKeptIndex + summaryOffset;
    if (summaryOffset === 1 && fromIdx === firstKeptIndex) {
      const compaction = this.loadPiCoreCompaction();
      if (compaction) {
        parsed.push(
          ...piCoreMessageToParsedChatMessage(
            createPiSummaryMessage(compaction.summary, compaction.updatedAt),
            0,
            threadId,
          ),
        );
        parsedStartIndex = 0;
      }
    }

    let idx = fromIdx;
    let rowsRead = 0;
    let payloadChars = 0;
    let boundaryExtraRows = 0;
    let reachedEnd = false;
    let stopped = false;
    /** Newest idx > `fromIdx` this range could legally have ended on, if any. */
    let lastLegalStopIdx: number | null = null;
    let lastLegalStopParsedLength = 0;
    /** Rows taken past the hard cap because no legal boundary existed to stop at. */
    let overExtendedRows = 0;
    const stamps = new Set<string>();

    while (!stopped) {
      const batch = this.piCoreStore.listPiCoreRowMetaAscending({
        fromIdx: idx,
        limit: PI_TOPUP_ROW_BATCH_SIZE,
      });
      if (batch.length === 0) {
        reachedEnd = true;
        break;
      }
      for (const meta of batch) {
        const budgetSpent = rowsRead >= maxRows || payloadChars >= maxChars;
        const message = this.piCoreStore.loadPiCoreRenderMessageAt(meta.idx);
        const record = message as unknown as Record<string, unknown> | null;
        const isToolResult = record?.role === "toolResult";
        const stamp =
          record?.role === "assistant"
            ? (normalizePiUiMetadata(record.uiMetadata)?.renderMessageId ?? "")
            : "";
        // The derive pager's boundary rule, in the forward direction: only an
        // assistant COMMIT proves a clean break. A tool answer belongs to the
        // call above it, and a user row proves nothing at all — a steered turn
        // is `assistant(T) … steer-user … assistant(T)`, so stopping at the
        // steer would split one fold across two batches, and the second half
        // would then be skipped entirely by the same-id dedup. An assistant
        // row carrying a stamp this batch has not seen (or no stamp, which is
        // a legacy row that folds with nothing) is a new turn: stop there.
        const foreignCommit =
          record?.role === "assistant" && (!stamp || !stamps.has(stamp));
        // The newest row this range could legally have ended on. Recorded on
        // every pass, budget or not, because the hard cap below needs somewhere
        // safe to retreat to and `fromIdx` itself is not one (retreating there
        // would not advance the cursor).
        if (foreignCommit && meta.idx > fromIdx) {
          lastLegalStopIdx = meta.idx;
          lastLegalStopParsedLength = parsed.length;
        }
        if (budgetSpent) {
          if (foreignCommit) {
            idx = meta.idx;
            stopped = true;
            break;
          }
          boundaryExtraRows += 1;
          if (boundaryExtraRows > maxBoundaryExtraRows) {
            // HARD CAP. It used to break right here with `idx = meta.idx` and no
            // look at what `meta` was — so a cap that landed on a toolResult
            // ended the range between an assistant and its answer. The next call
            // then started with an empty `parsed`, `attachPiToolResultToParsed
            // Messages` found no assistant to attach to and returned having
            // mutated nothing, and the row was consumed anyway: that tool output
            // was silently and permanently missing from the durable mirror.
            //
            // A cap may only ever fire at a legal boundary. When one was passed
            // inside this range, retreat to it — the rows after it are re-read by
            // the next call, and the cursor still advances. When there was none,
            // the range is a single turn longer than the budget, and there is
            // nothing to retreat to: keep taking rows until the turn ends, since
            // splitting it corrupts the mirror and truncating it loses history.
            // That extension is bounded by one turn's committed rows.
            if (lastLegalStopIdx !== null) {
              parsed.length = lastLegalStopParsedLength;
              idx = lastLegalStopIdx;
              stopped = true;
              break;
            }
            overExtendedRows += 1;
          }
        }
        rowsRead += 1;
        payloadChars += meta.chars;
        idx = meta.idx + 1;
        if (!message || !record) continue;
        if (stamp) stamps.add(stamp);
        if (isToolResult) {
          attachPiToolResultToParsedMessages(parsed, record);
          continue;
        }
        parsed.push(
          ...piCoreMessageToParsedChatMessage(
            message,
            meta.idx - firstKeptIndex + summaryOffset,
            threadId,
          ),
        );
      }
    }

    if (overExtendedRows > 0) {
      // One turn is longer than a whole top-up budget. Not corruption — the
      // range still ends on a boundary — but it means a single turn is pinning
      // more than the pass was sized for, which is worth seeing before it is
      // worth guessing about.
      this.recordChatThreadObservabilityEvent("pi_topup_range_over_extended", {
        operation: "topup_read_range",
        status: "over_extended",
        severity: "warn",
        count: overExtendedRows,
        size: payloadChars,
        extraCounts: [rowsRead, fromIdx, idx],
        sampleKey: this.chatContext?.threadId,
      });
    }
    return {
      parsed,
      parsedStartIndex,
      nextIdx: idx,
      reachedEnd,
      rowsRead,
      payloadChars,
    };
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
    const messages = await this.loadFullPiCoreTranscriptUnbounded({
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
          authorDisplayName: "Camel",
          messageSource: channelKind,
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
    const messages = await this.loadFullPiCoreTranscriptUnbounded({ imagePolicy: "reference" });
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
    // The dispose that interrupted the turn was OURS and ran in this isolate, so
    // the re-drive below is not an isolate death: it spends the voluntary budget
    // (via piConfigChangeResumeDepth, read by resumeActivePiTurn), and the flag
    // keeps a re-drive that arrives through chatRecovery instead off the
    // isolate-death budget too.
    this.markPiTurnBenignInterruption();
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
    this.piConfigChangeResumeDepth += 1;
    let result: { status: string };
    try {
      result =
        lastAssistant && lastAssistant.id === marker.turnId
          ? await agent.continueLastTurn()
          : await agent._retryLastUserTurn();
    } finally {
      this.piConfigChangeResumeDepth = Math.max(
        0,
        this.piConfigChangeResumeDepth - 1,
      );
    }
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
      await this.releasePiTurnAfterGiveUp();
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
    this.piSessionLoadWindow = null;
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
      r2: () => resolveObjectStore(this.env),
      chatContext: () => this.chatContext,
      takeToolDurationMs: (toolCallId) => this.takePiToolDurationMs(toolCallId),
      // Wired in PRODUCTION, not just in focused tests. Two of these operations
      // are silent history/context degradation — an image dropped from the
      // provider context, and a session-trimmed image that could not be put back
      // before its row was rewritten — and without a counter a thread that lost
      // its visual history is indistinguishable from one that never had images.
      recordReadOperation: (operation) => {
        const counters = (this.piCoreReadOps ??= {});
        counters[operation] = (counters[operation] ?? 0) + 1;
      },
    }));
  }

  /**
   * Per-wake counters from the pi_core store's read/write policies. Flushed onto
   * the per-request `pi_context_budget` event rather than emitted per occurrence:
   * `transformContext` runs ~25 times a turn and an event per omitted image would
   * be noise, while a per-request count is exactly the resolution the question
   * ("is this thread losing images?") needs.
   */
  private piCoreReadOps: Record<string, number> = {};

  private takePiCoreReadOpCount(operation: string): number {
    // Tolerates a facade built with `Object.create(ChatThreadDO.prototype)`,
    // which never runs field initializers: a diagnostic counter may not be the
    // reason a unit-level caller of a real method blows up.
    const counters = this.piCoreReadOps;
    if (!counters) return 0;
    const value = counters[operation] ?? 0;
    counters[operation] = 0;
    return value;
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
    const imagePartNotice = omittedImageParts > 0
      ? `[${omittedImageParts} image tool result${omittedImageParts === 1 ? "" : "s"} omitted: ${omittedImageBytes} bytes; active model cannot inspect images]`
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

  private loadFullPiCoreTranscriptUnbounded(options: {
    includeUiMetadata?: boolean;
    imagePolicy?: PiCoreImagePolicy;
    imageHydrationBudget?: PiImageHydrationBudget;
  } = {}): Promise<AgentMessage[]> {
    return this.withChatMemoryPhase("pi_read", () =>
      this.piCoreStore.loadFullPiCoreTranscriptUnbounded(options),
    );
  }

  /**
   * The session-build read. Named apart from {@link loadFullPiCoreTranscriptUnbounded} because
   * it is the one caller that is allowed to return LESS than the visible window
   * — everything else (fork, dedup, export, admin) needs the whole thing and
   * must keep calling the unbounded load.
   */
  private loadBoundedPiCoreSessionWindow(): Promise<{
    messages: AgentMessage[];
    window: PiSessionLoadWindow;
  }> {
    return this.piCoreStore.loadBoundedPiCoreSessionWindow({
      maxChars: PI_SESSION_LOAD_MAX_CHARS,
    });
  }

  /**
   * Adopt a session load's index space, and say so when the char cap bound.
   *
   * A capped load is not an error and not a degraded rung — it is the only way a
   * thread this size gets a turn at all — but it means the model is answering
   * without part of its own history, so it must never be silent. The event is
   * what proves the follow-through too: a thread should appear here at most
   * ONCE, because the first completed turn's compaction persists a real
   * watermark and every later load is an ordinary summary+tail load.
   */
  private recordPiSessionLoadWindow(window: PiSessionLoadWindow): void {
    this.piSessionLoadWindow = {
      firstRowIdx: window.firstRowIdx,
      summaryOffset: window.summaryOffset,
      capped: window.capped,
    };
    if (!window.capped) return;
    this.recordChatThreadObservabilityEvent("pi_session_load_capped", {
      operation: "pi_session_load",
      status: "capped",
      severity: "warn",
      // count = rows skipped, size = chars actually materialized. The totals ride
      // along so the ratio (what the load would have been) is visible.
      count: Math.max(0, window.totalRows - window.loadedRows),
      size: window.loadedChars,
      extraCounts: [window.totalChars, window.totalRows, window.firstRowIdx],
    });
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
  ): Promise<{ status: "rewritten" | "skipped_archive_truncated" }> {
    this.ensurePiCoreTables();
    // Before pi_core shrinks, snapshot the current visible derive into the
    // ai-chat table so post-compaction reads can prepend those rows as archive.
    if (options.uiRender === "preserve") {
      // The rewrite keeps `messages` and nothing else, so the rows it destroys
      // are exactly the visible ones below the kept tail. Everything newer is
      // still served by the post-compaction derive and needs no archive copy.
      const archive = await this.materializeSettledRenderArchiveFromPiCore({
        keptTailRows: messages.length - (isPiSummaryMessage(messages[0]) ? 1 : 0),
      });
      if (archive?.truncated) {
        // A ceiling stopped the archive walk, so the rows below
        // `lowestRowIdx` have NO copy anywhere. Deleting them here would be
        // permanent history loss to save one compaction; refuse instead. The
        // caller's `pi_core_compaction` watermark is already durable, so the
        // model context stays bounded — the same trade the capped-session
        // branch makes, and the next pass can try again.
        this.recordChatThreadObservabilityEvent("pi_core_rewrite_skipped", {
          operation: "replace_pi_core",
          status: "archive_truncated",
          severity: "warn",
          count: archive.messagesPersisted,
          size: archive.payloadChars,
          extraCounts: [archive.rowsRead, archive.batches, archive.lowestRowIdx],
          sampleKey: this.chatContext?.threadId,
        });
        return { status: "skipped_archive_truncated" };
      }
    }
    // Serialize first (this can await R2/image work); swap the table contents
    // with no await between DELETE and the INSERTs so an eviction or a
    // concurrent reader never observes a half-written history.
    const payloads: string[] = [];
    for (const message of messages) {
      const serialized = await this.serializePiMessageForSqlStorageDetailed(message);
      payloads.push(serialized.payload);
    }
    // A session-trimmed image the serializer could not put back is written as a
    // reference, and render then shows a marker for it forever. It should never
    // happen (the object is content-addressed and was proven present before the
    // reference was minted), which is exactly why it must be loud when it does.
    const restoreFailures = this.takePiCoreReadOpCount("session_image_restore_failed");
    if (restoreFailures > 0) {
      this.recordChatThreadObservabilityEvent("pi_session_image_restore_failed", {
        operation: "replace_pi_core",
        status: "degraded",
        severity: "warn",
        count: restoreFailures,
        size: messages.length,
        sampleKey: this.chatContext?.threadId,
      });
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
    // pi_core is renumbered from 0 and `messages` IS the new row list, so the
    // session's index space is now the identity mapping. Callers that keep the
    // session alive (post-turn compaction) assign `session.state.messages =
    // messages` right after; callers that do not have already disposed it. Either
    // way a stale offset here would name the wrong rows on the next cut.
    this.piSessionLoadWindow = { firstRowIdx: 0, summaryOffset: 0, capped: false };
    // Invalidate derive-on-read cache; markPiCoreChanged already bumped generation.
    this.derivedRenderWindowCache = null;
    if (options.uiRender === "rebuild") {
      // Admin/fork rewrites: refresh the live/archive render table too so
      // compaction-archive hybrid and any residual mirror consumers converge.
      await this.rebuildUiMessagesFromPiCore();
    }
    // uiRender: "preserve" keeps cf_ai_chat_agent_messages as the pre-compaction
    // visible archive; settled reads derive from the new pi_core and prepend
    // archive rows whose ids are absent from the derive.
    return { status: "rewritten" };
  }

  /**
   * Write the pi_core rows a preserve-compaction is about to delete into the
   * ai-chat table (with pi timestamps as chronology) so post-compaction reads can
   * keep showing them via the archive hybrid.
   *
   * Bounded by construction (stage 2a): scoped to the rows the post-compaction
   * derive can no longer see, and walked one bounded derived window at a time
   * instead of materializing the whole transcript. See
   * ./chat-thread/render-archive-preserve.
   *
   * Returns the walk's result so the caller can honour its contract: a
   * `truncated` pass leaves rows unarchived, and the rewrite must then be
   * abandoned rather than delete them.
   */
  private async materializeSettledRenderArchiveFromPiCore(
    options: { keptTailRows: number },
  ): Promise<PreserveArchiveResult> {
    const startedAt = Date.now();
    const result = await materializeBoundedRenderArchive(
      {
        visibleWindow: () => this.piCoreStore.piCoreVisibleWindow(),
        // Deliberately NOT `deriveRenderWindow`: that memo is the read path's
        // page cache, and a preserve pass would evict every entry in it with
        // windows nobody is going to request.
        deriveWindow: (beforeIdx, limits) =>
          deriveRenderWindowFromPiCore(this.piDeriveRowSource, {
            beforeIdx,
            maxMessages: limits.maxMessages,
            maxBytes: limits.maxBytes,
          }),
        persistBatch: (messages) => this.persistMessages(messages),
        stampChronology: (message) => {
          const createdAtMs = uiMessageCreatedAtMs(message);
          if (createdAtMs === undefined) return;
          this._setRenderHistoryChronology(
            message.id,
            formatAiChatCreatedAt(createdAtMs),
          );
        },
      },
      { keptTailRows: options.keptTailRows },
    );
    if (result.messagesPersisted === 0 && !result.truncated) return result;
    // `warn` only on truncation, which is the one outcome that costs something:
    // the rows below `lowestRowIdx` have no archive copy, so the caller has to
    // abandon its rewrite. Everything else is routine bookkeeping.
    // `peakRetainedMessages` rides along because no storage counter can see it —
    // it is the only evidence the walk's residency bound still holds.
    this.recordChatThreadObservabilityEvent("pi_render_archive_preserved", {
      operation: "preserve_render_archive",
      status: result.truncated ? "truncated" : "preserved",
      severity: result.truncated ? "warn" : "info",
      count: result.messagesPersisted,
      size: result.payloadChars,
      durationMs: Date.now() - startedAt,
      extraCounts: [
        result.rowsRead,
        result.batches,
        result.lowestRowIdx,
        result.peakRetainedMessages,
        result.duplicateIdsSkipped,
      ],
      sampleKey: this.chatContext?.threadId,
    });
    this.messages = this.getRenderHistoryPage().messages;
    return result;
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
      getRenderHistoryPage: (beforeCursor) =>
        this.getRenderHistoryPage({ beforeCursor }),
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
      readParsedPiCoreRowRange: (options) => this.readParsedPiCoreRowRange(options),
      setRenderHistoryChronology: (id, createdAt) =>
        this._setRenderHistoryChronology(id, createdAt),
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
    if (!(this.env?.TRANSCRIPT_LAKE || this.env?.PIPELINE_SERVICE) || !this.ctx?.waitUntil) return;
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

  private recordPiActiveTurnResumeAttempt(
    cause: PiTurnResumeCause,
  ): PiTurnResumeAttempt | null {
    return this.piTurnJournal.recordResumeAttempt(cause, {
      isolateDeathDecayMs: PI_TURN_ISOLATE_DEATH_DECAY_MS,
    });
  }

  /**
   * Stamp the open turn: the interruption ending this attempt was observed
   * IN-PROCESS (a DO code-update reset, a config-change dispose), so the recovery
   * re-drive that follows is not an isolate death and must not spend the tight
   * {@link PI_TURN_RESUME_BUDGET}.
   */
  private markPiTurnBenignInterruption(): void {
    try {
      this.piTurnJournal.markBenignInterruption();
    } catch (error) {
      // Best effort: worst case the next re-drive is charged as an isolate death.
      console.warn(
        "[ChatThreadDO] failed to mark a benign turn interruption",
        error,
      );
    }
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
   * No fiber wrapping here — chatRecovery owns that. Errors propagate to
   * onChatMessage's catch, which runs the shared failure cleanup.
   *
   * The bounds this path owns live on the durable marker and are counted BEFORE any
   * heavy work, SPLIT BY CAUSE (see {@link PI_TURN_RESUME_BUDGET}):
   *  - {@link PI_TURN_RESUME_BUDGET} — re-drives after an isolate death nothing
   *    in-process observed. This is the loop chatRecovery cannot catch: it
   *    checkpoints progress and then kills the isolate every pass, renewing the
   *    SDK's progress-gated budget forever.
   *  - {@link PI_TURN_VOLUNTARY_RESUME_BUDGET} — re-drives this DO chose to run
   *    in-process ({@link retryPiTurnWhileTransient}, itself capped per stream
   *    invocation at {@link PI_TURN_TRANSIENT_RETRY_ATTEMPTS}, and config-change
   *    rebuilds). Same rebuild work, so still bounded — but on their own counter, so
   *    a provider-overload window cannot eat the eviction-recovery headroom.
   *  - {@link PI_TURN_TOTAL_RESUME_BUDGET} — loose ceiling on everything, including
   *    the re-drives that follow interruptions this isolate caught and classified as
   *    recoverable (code-update resets: survivable 15 times in production).
   * Exceeding any of them abandons the turn ({@link abandonPiTurnOverResumeBudget}).
   *
   * Between "resume normally" and "abandon" sits the LADDER ({@link piTurnResumeRung},
   * keyed on the isolate-death counter only): the third memory kill resumes DEGRADED
   * (forced compaction + a hard image-hydration budget, {@link piDegradedResumeAttempt}),
   * and the fourth skips the model entirely and SALVAGES what the journal holds
   * ({@link salvagePiTurnWithoutModel}). Each rung is cheaper than the last, so a turn
   * too big to resume can still land its accepted work instead of being dropped.
   */
  private async resumeActivePiTurn(
    options: { cause?: PiTurnResumeCause } = {},
  ): Promise<void> {
    // FIRST thing, before ensurePiSessionReady or any other awaitable work: the
    // increment only bounds the loop if it survives an isolate that dies inside
    // this very re-drive. Absent marker (null) = nothing to bound; the resume
    // below fails its own way.
    const cause =
      options.cause ??
      (this.piConfigChangeResumeDepth > 0 ? "config_change" : "recovery");
    const attempt = this.recordPiActiveTurnResumeAttempt(cause);
    const exceeded = attempt ? exceededPiTurnResumeBudget(attempt) : null;
    if (attempt && exceeded) {
      await this.abandonPiTurnOverResumeBudget(attempt, exceeded);
      return;
    }
    // Ladder rung for this re-drive, from the counter that was just persisted.
    const rung = attempt ? piTurnResumeRung(attempt) : "normal";
    if (attempt && rung === "salvage") {
      // Rung 4: do not call the provider at all. If the journal holds nothing
      // worth committing there is nothing cheaper left to try — go terminal in
      // this same wake rather than burning another kill on an empty salvage.
      if (await this.salvagePiTurnWithoutModel(attempt)) return;
      await this.abandonPiTurnOverResumeBudget(attempt, "isolate_death");
      return;
    }
    // Rung 3: rebuild low-memory. The flag is read by the session's
    // transformContext (so a warm session degrades too) and reset at the top of
    // every onChatMessage execute, so it never outlives this attempt. Its
    // ephemeral-compaction memo is scoped to the same window: a stale cut from an
    // earlier attempt must never shrink a healthy resume's context.
    this.piDegradedResumeAttempt = rung === "degraded";
    this.piEphemeralCompaction = null;
    this.recordChatThreadObservabilityEvent("pi_turn_recovery_attempt", {
      operation: "resume_interrupted_turn",
      status: rung === "degraded" ? "attempting_degraded" : "attempting",
      count: attempt?.total ?? 0,
      // Which budget this re-drive spent, and how much of it is gone — the split
      // is the whole point of the bound, so it has to be visible in telemetry.
      size: attempt?.isolateDeath ?? 0,
      sampleKey: attempt ? `${cause}/${attempt.charged}` : null,
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
   * Does a render row already exist for the in-flight stream (id = the active
   * turnId)? True exactly when ai-chat orphan-persisted the interrupted stream's
   * partial, which is the same condition that makes the re-drive a CONTINUE rather
   * than a RETRY. Callers use it to decide whether stamping pi_core rows with the
   * turnId is a true statement about what that row displays — see
   * {@link releasePiTurnAfterGiveUp}'s `stampWork`.
   */
  private hasLiveAssistantRowForActiveTurn(): boolean {
    const turnId = this.activePiStreamTurnId;
    if (!turnId) return false;
    return this.messages.some(
      (message) => message.id === turnId && message.role === "assistant",
    );
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

  /**
   * Run one harness tool with the turn's progress heartbeat pinned to it.
   *
   * The optional `signal` is the ACTIVE TOOL's abort signal (pi-agent-core hands
   * it to `execute`, and `Agent.abort()` — driven by requestStop →
   * sendRunnerCommand("stop") → piSession.abort() — fires it). It is observed
   * HERE rather than raced by the caller so that a stop releases the keepalive
   * immediately: racing outside this wrapper would leave the heartbeat interval
   * (and the turn's "a tool is running" state) pinned by the orphaned promise
   * until the abandoned tool finally settled — up to the 20-minute tool ceiling.
   *
   * The underlying work is never dropped unobserved: `work.catch` is attached up
   * front so a late rejection cannot surface as an unhandled rejection.
   *
   * `abortGraceMs` is for the tools that CAN cancel. A sandbox exec cannot, so
   * rejecting the instant the signal fires costs nothing there. A subagent is
   * the opposite: `child.abort()` unwinds in milliseconds and `child.prompt()`
   * then RETURNS the answer it accumulated. Rejecting first threw that away and
   * persisted a tool result reading "Operation aborted" with empty details, for
   * work the user was already billed for. With a grace window we let the child's
   * own graceful abort win if it lands inside it, and only reject if it does not.
   */
  private async keepPiTurnToolProgressAliveWhile<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    options: { abortGraceMs?: number } = {},
  ): Promise<T> {
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
    work.catch(() => {});
    // Same error shape pi-agent-core produces for an aborted tool call, so a
    // stop reads identically whether it lands before, during, or after execute.
    let onAbort: (() => void) | null = null;
    const abortGraceMs = Math.max(0, options.abortGraceMs ?? 0);
    let abortGraceTimer: ReturnType<typeof setTimeout> | null = null;
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
        const rejectAborted = () => reject(new Error("Operation aborted"));
        onAbort = () => {
          if (abortGraceMs === 0) {
            rejectAborted();
            return;
          }
          // Let `work` win the race if the tool's own cancellation lands first;
          // this promise stays pending until the window closes.
          abortGraceTimer = setTimeout(rejectAborted, abortGraceMs);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
      : null;
    if (abortPromise) abortPromise.catch(() => {});
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
      return await Promise.race(
        abortPromise ? [work, hardTimeoutPromise, abortPromise] : [work, hardTimeoutPromise],
      );
    } finally {
      this.clearPiToolKeepAliveInterval();
      this.touchPiTurnProgress();
      if (abortGraceTimer !== null) clearTimeout(abortGraceTimer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
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

  private acceptedConnectionSetupResponses(): AcceptedConnectionSetupResponse[] {
    const stored = this.ctx.storage.kv.get<unknown>(
      CHAT_ACCEPTED_CONNECTION_SETUP_RESPONSES_KEY,
    );
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (entry): entry is AcceptedConnectionSetupResponse =>
        Boolean(entry) &&
        typeof entry === "object" &&
        typeof (entry as AcceptedConnectionSetupResponse).requestId === "string" &&
        Boolean((entry as AcceptedConnectionSetupResponse).requestId) &&
        typeof (entry as AcceptedConnectionSetupResponse).acceptedAt === "number" &&
        Number.isFinite((entry as AcceptedConnectionSetupResponse).acceptedAt),
    );
  }

  private wasConnectionSetupResponseAccepted(requestId: string): boolean {
    if (!requestId) return false;
    return this.acceptedConnectionSetupResponses().some(
      (entry) => entry.requestId === requestId,
    );
  }

  private recordAcceptedConnectionSetupResponse(requestId: string): void {
    const accepted = this.acceptedConnectionSetupResponses()
      .filter((entry) => entry.requestId !== requestId);
    accepted.push({ requestId, acceptedAt: Date.now() });
    this.ctx.storage.kv.put(
      CHAT_ACCEPTED_CONNECTION_SETUP_RESPONSES_KEY,
      accepted.slice(-MAX_ACCEPTED_CONNECTION_SETUP_RESPONSES),
    );
  }

  private forgetAcceptedConnectionSetupResponse(requestId: string): void {
    const accepted = this.acceptedConnectionSetupResponses()
      .filter((entry) => entry.requestId !== requestId);
    if (accepted.length > 0) {
      this.ctx.storage.kv.put(
        CHAT_ACCEPTED_CONNECTION_SETUP_RESPONSES_KEY,
        accepted,
      );
    } else {
      this.ctx.storage.kv.delete(
        CHAT_ACCEPTED_CONNECTION_SETUP_RESPONSES_KEY,
      );
    }
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
      // Match the durable-submit invariant used by the initial-message path:
      // a resolved "accepted" response means the new-turn user row is already
      // in pi_core. The render skeleton and recovery journal still use the same
      // timestamp/id, so the eventual turn-end commit remains idempotent.
      persistUserMessageImmediately: true,
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
    const joinsExistingTurn = this.isThreadStreaming();
    const startsNewTurn =
      options.persistUserMessageImmediately === true && !joinsExistingTurn;
    const turnTimestamp = Date.now();

    let sent = false;
    try {
      // Steering is authored by the new sender but remains part of the
      // initiator's provider turn for billing attribution.
      if (!joinsExistingTurn) this.setActiveTurnUserId(context.userId);
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
      if (!joinsExistingTurn) this.setActiveTurnUserId(null);
      throw error;
    }
    if (!sent) {
      this.updateActiveAutomationRun({
        status: "error",
        message: "Failed to send message",
        clear: true,
      });
      this.finishTurn();
      if (!joinsExistingTurn) this.setActiveTurnUserId(null);
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
          render: { rows: 0, bytes: 0, maxRowBytes: 0, measured: false },
          pi: { rows: 0, bytes: 0, maxRowBytes: 0, measured: false },
          journal: { rows: 0, bytes: 0, maxRowBytes: 0, measured: false },
          toolRuns: { rows: 0, bytes: 0, maxRowBytes: 0, measured: false },
        },
      };
    }
  }

  /**
   * The memory-instrumentation sampling rule, shared by every event that wants
   * it: keep every breadcrumb for memory-heavy threads (the OOM population is
   * fully instrumented), and for small threads emit the first occurrence and
   * then at most one per key every 10 seconds, so provider/persistence loops
   * cannot flood Analytics Engine. Records the emission when it returns true.
   */
  private shouldSampleChatMemoryEvent(
    key: string,
    now: number,
    totalBytes: number,
  ): boolean {
    const lastAt = this.lastChatMemoryPhaseAt?.get(key) ?? 0;
    if (totalBytes < 1024 * 1024 && now - lastAt < 10_000) return false;
    (this.lastChatMemoryPhaseAt ??= new Map()).set(key, now);
    return true;
  }

  /**
   * One line per provider request describing what the context actually costs and
   * what compaction did about it — the event that proves or disproves the
   * image-charge thesis. `count`/`size` are the tokens and payload bytes going
   * IN (deliberately separate numbers now: tokens gate summarization, bytes
   * describe the working set); `status` carries the compaction outcome; the
   * extra doubles are imageCount, imageChars, messageCount and the payload bytes
   * of the view that actually shipped, in that order — so a row shows both what
   * the context weighed and what compaction got it down to.
   *
   * The alert this exists for: more than one `summarized` per turn is a
   * regression, full stop. Its companion: any `no_cut` means an over-budget
   * context shipped whole.
   */
  private recordPiContextBudget(
    footprint: PiContextFootprint,
    model: Model<any> | null | undefined,
    outcome: PiCompactionOutcome,
  ): void {
    const now = Date.now();
    // Deliberately the LAST measured size rather than a fresh
    // `readChatMemoryStats()`: this runs on every provider request, inside the
    // `provider_request_prepare` phase whose own start already measured, and the
    // aggregate is a full scan of the thread's payload columns — exactly the
    // work this whole change is trying to stop doing 25 times a turn. The value
    // is only used to pick a sampling rate, and it is from this same request.
    const totalBytes = this.cachedChatMemoryStats?.totalBytes ?? 0;
    if (!this.shouldSampleChatMemoryEvent("pi_context_budget", now, totalBytes)) {
      return;
    }
    this.recordChatThreadObservabilityEvent("pi_context_budget", {
      operation: "provider_request_prepare",
      status: outcome.status,
      severity: outcome.status === "no_cut" ? "warn" : undefined,
      count: footprint.tokens,
      size: footprint.bytes,
      model: typeof model?.id === "string" ? model.id : null,
      provider: this.piCurrentUsageProvider || null,
      extraCounts: [
        footprint.imageCount,
        footprint.imageChars,
        footprint.messageCount,
        outcome.resultBytes ?? footprint.bytes,
        // Images the store replaced with a marker since the last emitted budget
        // event, and images it hydrated back out of R2 to produce this request.
        // `imageCount` alone cannot distinguish a thread whose screenshots are
        // being dropped from one that never had any. Taken (and zeroed) only
        // when the event is actually emitted, so a sampled-out request carries
        // its counts forward instead of losing them.
        this.takePiCoreReadOpCount("provider_image_omitted"),
        this.takePiCoreReadOpCount("r2_image_hydrated"),
      ],
      sampleKey: this.chatContext?.threadId,
    });
  }

  private startChatMemoryPhase(operation: string): {
    operation: string;
    startedAt: number;
    emitted: boolean;
  } {
    const startedAt = Date.now();
    const stats = this.readChatMemoryStats();
    const emitted = this.shouldSampleChatMemoryEvent(
      operation,
      startedAt,
      stats.totalBytes,
    );
    if (emitted) {
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
      /** Event-specific numeric dimensions; see {@link recordObservabilityEvent}. */
      extraCounts?: (number | null | undefined)[];
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
      extraCounts: details.extraCounts,
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
      const run = this.activeAutomationRun;
      const outcome = run.reportedOutcome;
      const requiresOutcome = run.requiresExplicitOutcome === true;
      const status = !requiresOutcome || outcome?.status === "success"
        ? "success"
        : "error";
      const message = requiresOutcome
        ? outcome
          ? outcome.status === "success"
            ? outcome.summary
            : `[${outcome.status}] ${outcome.summary}`
          : "Automation completed without explicitly reporting an outcome"
        : null;
      this.updateActiveAutomationRun({
        status,
        message,
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


  /**
   * Whether a browser is reachable for a prompt. NOT the same as "a transport
   * connection is registered right now": the SSE idle policy parks a viewer's
   * stream after five quiet minutes, and an eviction destroys the registry
   * outright while the tab is still open and reconnecting. Treating either as
   * absence makes askUserQuestion answer itself with "User is not at computer"
   * and promptConnectionSetup cancel itself, for a user who is sitting there —
   * and a recovery re-drive runs before any client can reattach. A recently seen
   * viewer therefore stays available for a bounded window and picks the prompt up
   * from thread state on its next attach.
   */
  private hasAvailableBrowserUser(): boolean {
    if (this.getChatSockets().length > 0) return true;
    return this.hasPresumedViewer();
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
      const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderRecord);
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
      const selfhostRuntime = isSelfhostRuntime(this.env);
      const threadModel =
        storedThreadModel === CUSTOM_LLM_MODEL
          ? normalizeLlmModel(storedThreadModel, effectiveLlmProviderRecord?.provider, {
              customApi,
              customModelId,
            })
          : storedThreadModel !== undefined
            ? selfhostRuntime
              ? normalizeLlmModel(
                  storedThreadModel,
                  effectiveLlmProviderRecord?.provider,
                  {
                    customApi,
                    customModelId,
                    awsRegion,
                    allowCamelCode: false,
                  },
                )
              : normalizeLlmModel(storedThreadModel)
          : shouldDefaultToCamelCode
            ? CAMEL_CODE_LLM_MODEL
            : normalizeLlmModel(undefined, effectiveLlmProviderRecord?.provider, {
                customApi,
                customModelId,
                awsRegion,
              });
      // Keep the in-memory model aligned with the durable thread before any
      // refresh rebuilds the tool surface.
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
    // Bounded by construction: a thread whose visible window exceeds
    // PI_SESSION_LOAD_MAX_CHARS loads its newest turn-aligned tail plus a
    // placeholder summary instead of the whole transcript. Under the cap this is
    // the same load it always was, row for row.
    const loaded = await this.withChatMemoryPhase("pi_session_load", () =>
      this.loadBoundedPiCoreSessionWindow(),
    );
    const persistedMessages = loaded.messages;
    this.recordPiSessionLoadWindow(loaded.window);
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
      ], normalizeVerifiedWorkState(
        this.ctx.storage.kv.get<unknown>(CHAT_VERIFIED_WORK_STATE_KEY),
      ));
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
        tools: this.createPiToolDefinitions(context),
        messages: initialMessages,
        thinkingLevel: primaryPiThinkingLevel(
          envVars.CHIRIDION_MODEL ?? this.currentThreadModel,
        ),
      },
      transformContext: (messages, signal) =>
        this.withChatMemoryPhase("provider_request_prepare", async () => {
          const current = await resolveCurrentModel();
          return this.transformPiProviderContext(
            messages,
            current.model,
            current.apiKey,
            completeSimple,
            signal,
            { context, modelConfig: current, userId: this.getActiveTurnUserId() },
          );
        }),
      getApiKey: async () => {
        const requestUserId = this.getActiveTurnUserId();
        const current = await resolveCurrentModel();
        await this.assertPiUserLlmUsageAccess(context, current, requestUserId);
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
    _envVars?: Record<string, string>,
  ): string {
    const catalog = resolveAgentSkillCatalog(this.env);
    const base = createPiSystemPrompt(context, {
      skillNames: catalog.skillNames,
      skillDescriptions: catalog.skillDescriptions,
      promptPrepend: catalog.promptPrepend,
      promptAppend: catalog.promptAppend,
      deployedConnectionsBindingEnabled: connectionsBindingEnabled(this.env),
      selfhostAppAccessSsoOnly: isSelfhostRuntime(this.env),
    });
    const verifiedWorkState = formatVerifiedWorkStatePrompt(
      this.ctx?.storage?.kv?.get<unknown>(CHAT_VERIFIED_WORK_STATE_KEY),
    );
    const automationOutcomeInstruction = this.activeAutomationRun?.requiresExplicitOutcome
      ? [
          "## Scheduled Automation Outcome",
          "Before your final response, you MUST call `report_automation_outcome` exactly once.",
          "Use `success` only when the requested business objective was actually completed and verified. A clean turn, partial data extraction, or a decision not to deploy is not success.",
          "Use `failed` when the objective was not completed, `partial` when only part completed, and `needs_attention` when operator action is required. Give a concise factual summary.",
        ].join("\n")
      : null;
    return [base, verifiedWorkState, automationOutcomeInstruction]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  }

  /**
   * The session's `transformContext`: everything between the session's message
   * list and the bytes a provider request carries — compaction, image hydration,
   * replay repair. Runs once per provider request (25+ times in a single
   * agent-loop turn), which makes it both the hottest allocation site in the DO
   * and the one place a resume can be made cheaper.
   *
   * Hence the DEGRADED ladder rung ({@link piDegradedResumeAttempt}): a turn whose
   * isolate has already been killed three times in this very phase gets the
   * smallest context that can still answer it — compaction pulled forward from the
   * token threshold, and image hydration under
   * {@link PI_DEGRADED_RESUME_IMAGE_HYDRATION_BUDGET} instead of the default. The
   * flag is read per request rather than captured at session build, so a warm
   * session degrades too, and it applies to THIS attempt only — which is a real
   * contract, not a comment: the degraded compaction is EPHEMERAL (`persist:
   * false`, memoized in {@link piEphemeralCompaction}), so no rung-3 attempt can
   * leave a thread permanently truncated, and it only fires once the thread is at
   * least {@link PI_DEGRADED_COMPACTION_FLOOR_FRACTION} of the way to the real
   * threshold, so a mid-size thread — whose context was never the memory problem —
   * is left whole instead of being cut to `keepRecentTokens`.
   *
   * `committedBound` is `piMainBaselineIndex` on purpose: only session indexes
   * below it map to committed `pi_core_messages` rows (the folded journal tail and
   * pending steer messages above it exist nowhere durable yet), and a persisted
   * `first_kept_index` is read back as a pi_core `idx` predicate.
   */
  /**
   * True when this turn's session load was capped and the durable row that is
   * supposed to end that state has not been written yet.
   *
   * A capped load leaves storage untouched and hands the model a placeholder;
   * the ONE thing that turns it into an ordinary summary+tail thread is the
   * `pi_core_compaction` row `compactPiContext`'s `recordCut` persists. But
   * that row is only ever written when a compaction actually runs, and the two
   * triggers are a token threshold and {@link PI_CONTEXT_MAX_WORKING_SET_BYTES}
   * — both of which a capped load is deliberately sized to sit UNDER
   * ({@link PI_SESSION_LOAD_MAX_CHARS} is the smaller number, on purpose). For a
   * text-heavy thread the token estimate trips anyway and the gap never shows.
   * For an image-dominated one it does not: images are charged a flat
   * `PI_IMAGE_CONTEXT_TOKENS` each, so ~24 screenshots is well under any
   * threshold while the load itself is 12 MB. Nothing else consults `capped`
   * before the fact, and the post-turn path was usage-gated too, so such a
   * thread re-entered the capped branch on every wake forever: the placeholder
   * becomes permanent, `pi_session_load_capped` fires on every turn (the event
   * documents that a thread appears there at most once), and every wake
   * re-materializes 12 MB and re-runs the session image externalization pass.
   *
   * The post-turn trigger now also has a STORED-CHAR dimension
   * ({@link PI_DURABLE_CUT_MAX_VISIBLE_CHARS}, below the load cap and measured
   * in its units), so a thread growing turn by turn should acquire its durable
   * cut before it can be capped at all. This stays as the backstop for the
   * threads already in that shape, for a load that arrives before any turn ends,
   * and for the case where the stored-char probe cannot read storage.
   *
   * So the follow-through is forced instead of inferred. On the first provider
   * request of the turn the whole loaded tail is below `piMainBaselineIndex`,
   * so `recordCut`'s committed-bound check passes and the row lands in pi_core
   * idx space through the usual `storedFirstKeptIndex` mapping; from the second
   * request on, the `row_hit` branch serves it and this returns false.
   */
  private piCappedLoadNeedsWatermark(): boolean {
    const window = this.piSessionLoadWindow;
    if (!window?.capped) return false;
    const existing = this.loadPiCoreCompaction();
    return !existing || existing.firstKeptIndex < window.firstRowIdx;
  }

  private async transformPiProviderContext(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
    signal?: AbortSignal,
    metering?: {
      context: ChatContextState;
      modelConfig: PiResolvedModelConfig;
      userId: string | null;
    },
  ): Promise<AgentMessage[]> {
    const degraded = this.piDegradedResumeAttempt;
    // The ONE estimate of this request. It used to be computed three times
    // inside compactPiContext, each time re-serializing every message and
    // re-scanning it with the dense-blob regex — O(3B) of transient string per
    // request, 25 times a turn. Threading it in also gives the budget event a
    // number that is exactly what the compaction decision was made on.
    const footprint = estimatePiContextFootprint(messages);
    const outcome: PiCompactionOutcome = { status: "unchanged" };
    const compactionOptions = {
      committedBound: this.piMainBaselineIndex,
      contextTokens: footprint.tokens,
      contextBytes: footprint.bytes,
      outcome,
      metering,
    };
    const compacted = await this.compactPiContext(
      messages,
      model,
      apiKey,
      completeSimple,
      signal,
      degraded
        ? {
            ...compactionOptions,
            force: true,
            persist: false,
            forceFloorFraction: PI_DEGRADED_COMPACTION_FLOOR_FRACTION,
            byteCeiling: PI_DEGRADED_COMPACTION_MAX_WORKING_SET_BYTES,
          }
        : this.piCappedLoadNeedsWatermark()
          ? {
              ...compactionOptions,
              // A capped load's follow-through, forced rather than hoped for.
              // See piCappedLoadNeedsWatermark.
              force: true,
              forceFloorFraction: 0,
              persist: true,
            }
          : compactionOptions,
    );
    this.recordPiContextBudget(footprint, model, outcome);
    const hydrated = (await this.hydratePiStoredImages(
      compacted.map((message) => sanitizePiModelMessage(message)),
      degraded ? PI_DEGRADED_RESUME_IMAGE_HYDRATION_BUDGET : undefined,
    )) as AgentMessage[];
    return repairPiMessageHistoryForReplay(hydrated).messages;
  }

  /**
   * `force` lowers the token THRESHOLD (to `forceFloorFraction` of it, 0 = none);
   * everything else — cut selection, summarization — is identical to a
   * threshold-triggered compaction. Two callers force it: post-turn compaction
   * (which is itself threshold-gated by `shouldCompactPiAfterAssistantUsage`, so
   * its floor is 0), and the degraded recovery rung (rung 3), whose invariants
   * were audited as:
   *  - Safe to run mid-recovery. It reads only its arguments plus the compaction
   *    row, and rewrites nothing the resume depends on: called from
   *    transformContext it returns a per-REQUEST view and never touches
   *    `session.state.messages` or `piMainBaselineIndex` (only
   *    compactPiContextAfterTurn does that, from an idle session).
   *  - Total: a summarization failure falls back to a synthetic summary rather
   *    than throwing, so it cannot fail an in-flight resume.
   *  - Idempotent enough to force on EVERY request of a degraded attempt: the
   *    first call records the cut ({@link piEphemeralCompaction} for a
   *    non-persisting caller, the `pi_core_compaction` row otherwise) and later
   *    calls reuse it (no second provider call) unless the context grew past the
   *    threshold again, which is exactly what an unforced compaction would do.
   *  - Cut boundaries stay on a user/assistant message and `transformContext`
   *    re-runs `repairPiMessageHistoryForReplay` afterwards, so a forced cut cannot
   *    orphan a tool result the resume just synthesized.
   * DURABILITY, which is the bar the ladder plan sets ("the degraded rung must not
   * permanently alter thread state"): `persist: false` keeps the forced compaction
   * per-request. The threshold path's one durable effect — the compaction row,
   * which truncates what every later session build loads — would otherwise fire ~8x
   * earlier than the threshold ever does and never be undone, because
   * `clearPiCoreCompaction` only runs from the (threshold-gated) post-turn
   * compaction. The render transcript is untouched either way (`pi_core_messages`
   * rows and the ai-chat render table both stay whole).
   * INDEX SPACE: `first_kept_index` is read back as a `pi_core_messages.idx`
   * predicate, but the cut is computed over the SESSION list, and those two spaces
   * only agree below `committedBound` (`piMainBaselineIndex` mid-turn — the folded
   * journal tail above it is committed nowhere yet). A cut above the bound is
   * therefore applied to the returned view but never persisted; persisting it would
   * write a watermark past MAX(idx) and blank the thread's model context. It lands
   * in {@link piEphemeralCompaction} instead, so the rest of the invocation still
   * reuses one summarization.
   */
  private async compactPiContext(
    messages: AgentMessage[],
    model: Model<any>,
    apiKey: string,
    completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
    signal?: AbortSignal,
    options: {
      force?: boolean;
      /** Fraction of the real threshold a FORCED compaction still requires. */
      forceFloorFraction?: number;
      /** false => record the cut in memory for this attempt, never durably. */
      persist?: boolean;
      /** Session index below which indexes map to committed pi_core rows. */
      committedBound?: number;
      /**
       * `effectivePiContextTokens(messages)`, already computed by the caller.
       * Same number, not recomputed; omitted callers still get it computed here.
       */
      contextTokens?: number;
      /**
       * `estimatePiContextBytes(messages)`, already computed by the caller.
       * Same number, not recomputed; omitted callers still get it computed here.
       */
      contextBytes?: number;
      /**
       * Payload-byte ceiling this context must stay under, independently of its
       * token count. Defaults to {@link PI_CONTEXT_MAX_WORKING_SET_BYTES}; the
       * degraded rung passes a lower one.
       */
      byteCeiling?: number;
      /** Written by this method so the caller can report what the request did. */
      outcome?: PiCompactionOutcome;
      metering?: {
        context: ChatContextState;
        modelConfig: PiResolvedModelConfig;
        userId: string | null;
      };
    } = {},
  ): Promise<AgentMessage[]> {
    const force = options.force === true;
    const persist = options.persist !== false;
    const contextWindow = piModelContextWindow(model);
    const reserveTokens = piCompactionReserveTokens(model);
    const keepRecentTokens = 20_000;
    // Floored by what the provider actually charged for everything up to the
    // last assistant turn: exact, free, and it accounts for the system prompt
    // and tool schemas that no message-only estimate can see. The character
    // heuristic alone used to decide this, and it read 137,964 tokens for a
    // request the provider billed at 216,184 — far enough under the threshold
    // that compaction never ran while the thread was already too full to
    // answer. Measured against that same thread this lands within 0.02%.
    const tokens = options.contextTokens ?? effectivePiContextTokens(messages);
    // The second, independent trigger. Tokens describe the provider's bill;
    // bytes describe the working set, and since an image is charged what an
    // image costs, the two no longer move together. A screenshot-driven
    // transcript can sit far below the token threshold while holding tens of
    // megabytes resident — the shape that killed the isolate — so either
    // dimension being over budget is enough to force a cut.
    const bytes = options.contextBytes ?? estimatePiContextBytes(messages);
    const byteCeiling = options.byteCeiling ?? PI_CONTEXT_MAX_WORKING_SET_BYTES;
    const threshold = contextWindow - reserveTokens;
    const floor = force
      ? Math.max(0, Math.floor(threshold * (options.forceFloorFraction ?? 0)))
      : threshold;
    const outcome = options.outcome;
    /**
     * Record what this request did and hand back the view. `status` is the only
     * thing `pi_context_budget` can use to tell "compaction reused a durable cut"
     * from "compaction found nothing to cut" from "the context was in budget" —
     * all three used to report `unchanged`, which made the one alert this event
     * exists for unable to see its own failure mode.
     */
    const finish = (
      view: AgentMessage[],
      status: PiCompactionStatus,
      viewBytes?: number,
    ): AgentMessage[] => {
      if (outcome) {
        outcome.status = status;
        outcome.resultBytes = view === messages
          ? bytes
          : viewBytes ?? estimatePiContextBytes(view);
      }
      return view;
    };
    // A view is only reusable if it is inside BOTH budgets: a byte-triggered
    // compaction that accepted a token-cheap, multi-megabyte cached view would
    // return exactly the context it was invoked to shrink. Returns the view's
    // byte count so the caller does not weigh it twice.
    const withinBudget = (view: AgentMessage[]): number | null => {
      if (effectivePiContextTokens(view) >= threshold) return null;
      const viewBytes = estimatePiContextBytes(view);
      return viewBytes < byteCeiling ? viewBytes : null;
    };
    if (tokens < floor && bytes < byteCeiling) {
      return finish(messages, "unchanged");
    }

    {
      // Reuse this stream invocation's in-memory cut instead of summarizing again
      // on every one of the ~25 provider requests it makes — the memo is what the
      // durable row would have been for a cut that must not (degraded rung) or
      // cannot (uncommitted tail) be persisted. It is dropped and recomputed if
      // the context outgrew it. Only the per-request caller consults it:
      // `committedBound` is what identifies transformContext, whose message list
      // the memo's index was computed over.
      const memo =
        options.committedBound === undefined ? null : this.piEphemeralCompaction;
      if (memo && memo.firstKeptIndex > 0 && memo.firstKeptIndex < messages.length) {
        const view = [
          createPiSummaryMessage(memo.summary),
          ...messages.slice(memo.firstKeptIndex),
        ];
        // Per-message estimates are memoized on message identity, so weighing
        // this view costs the summary message plus the kept tail, not another
        // walk of the whole transcript.
        const viewBytes = withinBudget(view);
        if (viewBytes !== null) {
          return finish(view, "memo_hit", viewBytes);
        }
      }
    }

    const existing = this.loadPiCoreCompaction();
    const hasSummaryHead = isPiSummaryMessage(messages[0]);
    const startsWithExistingSummary = Boolean(existing) && hasSummaryHead;
    // Where this message list sits in pi_core's idx space. The session load
    // records it ({@link piSessionLoadWindow}); when it has not run — a direct
    // call, a cold facade, a unit test — fall back to the only shape that used to
    // shift the mapping, a durable compaction summary at index 0. A recorded
    // window claiming a summary head that is not there is stale and is ignored,
    // so a wrong offset can never outlive the list it described.
    const recorded = this.piSessionLoadWindow;
    const indexSpace =
      recorded && (recorded.summaryOffset === 0 || hasSummaryHead)
        ? recorded
        : {
            firstRowIdx:
              existing && startsWithExistingSummary ? existing.firstKeptIndex : 0,
            summaryOffset: (startsWithExistingSummary ? 1 : 0) as 0 | 1,
          };
    /** Session index of a pi_core `first_kept_index`. Inverse of the write below. */
    const sessionIndexOfRow = (rowIdx: number): number =>
      rowIdx - indexSpace.firstRowIdx + indexSpace.summaryOffset;

    if (existing) {
      if (startsWithExistingSummary && tokens < threshold && bytes < byteCeiling) {
        return finish(messages, "row_hit");
      }
      // Rebuild the durable cut's view in SESSION space. `sessionCut >
      // summaryOffset` is the "this actually shrinks something" test: on a warm
      // load whose head IS the row's summary it evaluates to 1 > 1 and skips,
      // which is the pre-existing behaviour and keeps the hot path free of a
      // pointless view. It fires when the row names rows newer than the session's
      // own head — including the case that matters here, a capped load whose
      // first turn already persisted a real watermark, which without this branch
      // would re-summarize on every one of the turn's ~25 provider requests.
      const sessionCut = sessionIndexOfRow(existing.firstKeptIndex);
      if (sessionCut > indexSpace.summaryOffset && sessionCut < messages.length) {
        const view = [
          createPiSummaryMessage(existing.summary),
          ...messages.slice(sessionCut),
        ];
        const viewBytes = withinBudget(view);
        if (viewBytes !== null) {
          return finish(view, "row_hit", viewBytes);
        }
      }
    }

    const firstKeptIndex = findPiCompactionCutIndex(messages, keepRecentTokens);
    // A summary head is not conversation and must not be summarized again: it is
    // handed to the summarizer as `previousSummary` (its own dedicated slot) and
    // excluded from the chunked conversation. Without this the head was BOTH the
    // previous-summary block and the first thing in the transcript being
    // summarized, so every compaction of an already-compacted thread folded its
    // own summary in a second time — and a capped load, whose head is a
    // placeholder saying "history was omitted", would have had that notice
    // laundered into the durable summary as if it were something the user said.
    const summarizeFrom = hasSummaryHead ? 1 : 0;
    if (
      firstKeptIndex <= 0 ||
      firstKeptIndex >= messages.length ||
      summarizeFrom >= firstKeptIndex
    ) {
      // Over budget with nothing to cut. Distinct from `unchanged` on purpose:
      // this is the case where the full, oversized context ships to the provider
      // anyway, and it must not be invisible in telemetry. `summarizeFrom >=
      // firstKeptIndex` is the same statement for a summary-headed list: the cut
      // keeps everything but the head, so there is no conversation to compact.
      return finish(messages, "no_cut");
    }

    const previousSummary = hasSummaryHead
      ? piSummaryMessageText(messages[0]) || existing?.summary
      : existing?.summary;
    const messagesToSummarize = messages.slice(summarizeFrom, firstKeptIndex);
    const storedFirstKeptIndex =
      indexSpace.firstRowIdx +
      Math.max(0, firstKeptIndex - indexSpace.summaryOffset);
    const recordCut = (summary: string): void => {
      // A cut inside the uncommitted tail has no pi_core `idx` to name; applying
      // it to this request is fine, persisting it is not (see the INDEX SPACE note).
      const cutIsCommitted =
        options.committedBound === undefined ||
        firstKeptIndex <= options.committedBound;
      if (persist && cutIsCommitted) {
        this.piEphemeralCompaction = null;
        this.persistPiCoreCompaction(summary, storedFirstKeptIndex);
        return;
      }
      // Not durable — either the caller forbids it (degraded rung) or the cut is
      // unrepresentable. Keep it in memory so the rest of this stream invocation
      // reuses it rather than paying for a summarization per provider request.
      this.piEphemeralCompaction = { summary, firstKeptIndex };
      if (persist) {
        this.recordChatThreadObservabilityEvent("pi_compaction_cut_uncommitted", {
          operation: "compact_context",
          status: "not_persisted",
          severity: "warn",
          count: firstKeptIndex,
          size: options.committedBound,
        });
      }
    };
    try {
      const metering = options.metering;
      const summary = await summarizePiMessages(
        messagesToSummarize,
        model,
        apiKey,
        completeSimple,
        signal,
        previousSummary,
        metering
          ? {
              beforePull: () => this.assertPiUserLlmUsageAccess(
                metering.context,
                metering.modelConfig,
                metering.userId,
              ),
              afterPull: (response, pullId, durationMs) =>
                this.recordPiAssistantUsage(
                  response,
                  durationMs,
                  metering.modelConfig.billingSource,
                  metering.modelConfig.creditChargeable,
                  metering.modelConfig.usageProvider,
                  {
                    userId: metering.userId,
                    model: metering.modelConfig.model.id,
                    usageSurface: "compaction",
                    sourceScope: `${metering.context.threadId}:compaction:${pullId}`,
                    source: "pi_compaction",
                  },
                ),
            }
          : undefined,
      );
      recordCut(summary);
      return finish(
        [createPiSummaryMessage(summary), ...messages.slice(firstKeptIndex)],
        "summarized",
      );
    } catch (error) {
      if (error instanceof UserLlmUsageLimitError) throw error;
      console.error("[ChatThreadDO] Pi context compaction failed", error);
      // `previousSummary` is threaded in on purpose: this branch persists through
      // the SAME `recordCut` as the success branch, so without it a single
      // transient summarizer failure replaces the whole accumulated durable
      // summary with an error banner while still advancing the watermark.
      const fallbackSummary = createFallbackPiCompactionSummary(
        messagesToSummarize,
        error,
        previousSummary,
      );
      recordCut(fallbackSummary);
      return finish(
        [createPiSummaryMessage(fallbackSummary), ...messages.slice(firstKeptIndex)],
        "summarized",
      );
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

  /**
   * The post-turn summarizer, behind an instance seam.
   *
   * {@link loadPiCompleteSimple} dynamic-imports `@earendil-works/pi-ai/compat`
   * at CALL time, so a suite that wants a summarizer which never reaches a
   * provider had to `vi.mock` that whole module. That is not a viable seam: the
   * factory is file-scoped and hoisted, pi-agent-core imports `EventStream`,
   * `streamSimple` and `validateToolArguments` from the same module (so a
   * partial factory is mandatory), and an async `importOriginal` factory cannot
   * resolve at all when the lazy import happens inside a Durable Object —
   * Workers refuses the cross-object I/O. Overriding this one method is what
   * every other compaction surface already does by being handed a
   * `completeSimple` argument.
   */
  protected loadPiCompleteSimple(): Promise<
    typeof import("@earendil-works/pi-ai/compat").completeSimple
  > {
    return loadPiCompleteSimple();
  }

  /**
   * Stored chars of the visible pi_core window, for the durable trigger's
   * stored-char dimension. Null when storage cannot answer — the trigger treats
   * that as "not measured", never as "small", and stage 1c plus
   * {@link piCappedLoadNeedsWatermark} remain the backstop.
   */
  private piVisibleWindowStoredChars(): number | null {
    try {
      const watermark = this.loadPiCoreCompaction();
      return this.piCoreStore.piCoreVisibleWindowTotals(
        watermark?.firstKeptIndex ?? 0,
      ).chars;
    } catch (error) {
      console.error("[ChatThreadDO] visible window totals probe failed", error);
      return null;
    }
  }

  /**
   * Why the post-turn durable cut should run, or null. TWO independent reasons,
   * and the second is the one that matters for prevention:
   *
   *  - `usage`: the provider reported a near-full window for the last request
   *    ({@link shouldCompactPiAfterAssistantUsage}). Keyed on THIS TURN's
   *    trigger message — a delta question, and deliberately unchanged: it
   *    catches shapes the estimate cannot see.
   *  - `transcript`: the SESSION's whole list is over the threshold the
   *    per-request path compacts at, over the working-set ceiling, or its
   *    visible pi_core window is over the stored-char ceiling
   *    ({@link piTranscriptCompactionTrigger}). This is the trigger the
   *    ephemeral per-request compaction masks: it shrinks what the provider
   *    bills, so `usage` structurally never fires on precisely the threads
   *    growing without bound.
   *
   * THE TWO HALVES TAKE DIFFERENT LISTS, and that is the whole point.
   * `triggerMessage` is the assistant message this turn produced; `transcript`
   * must be the SESSION's accumulated list. `agent_end` hands the listener the
   * run DELTA (pi-agent-core seeds `newMessages` with the prompts and pushes
   * only what this run produced), so measuring the transcript on that argument
   * asks "was this ONE TURN huge?" — a question that answers no on every
   * ordinary turn of a 29 MB thread, which is exactly the growth shape this
   * trigger exists to stop. Callers pass `session.state.messages`.
   *
   * Evaluated against the CURRENT list on every check, not captured once: the
   * post-turn pass awaits the run settling and a model resolve, and a list that
   * shrank under it (another compaction landed, the session was rebuilt) must
   * stop this one rather than cut a transcript that no longer needs it.
   */
  private piPostTurnCompactionReason(
    triggerMessage: AgentMessage,
    transcriptMessages: AgentMessage[],
    model: Model<any> | null | undefined,
  ):
    | { kind: "usage" }
    | ({ kind: "transcript" } & PiTranscriptCompactionTrigger)
    | null {
    if (shouldCompactPiAfterAssistantUsage(triggerMessage, model)) {
      return { kind: "usage" };
    }
    const transcript = piTranscriptCompactionTrigger(transcriptMessages, model, {
      storedCharCeiling: PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
      storedChars: () => this.piVisibleWindowStoredChars(),
    });
    return transcript ? { kind: "transcript", ...transcript } : null;
  }

  /**
   * @param turnMessages the run DELTA `agent_end` reports — the messages THIS
   *   run produced. Used only to find the trigger message for the usage half;
   *   the transcript half reads the session's own list. See
   *   {@link piPostTurnCompactionReason}.
   */
  private maybeSchedulePiPostTurnCompaction(turnMessages: AgentMessage[]): void {
    const latestAssistant = latestPiAssistantMessage(turnMessages);
    if (!latestAssistant) return;
    const transcript = this.piSession?.state.messages ?? turnMessages;
    const reason = this.piPostTurnCompactionReason(
      latestAssistant,
      transcript,
      this.piSession?.state.model,
    );
    if (!reason) return;

    // SINGLE FLIGHT, because the transcript reason is LEVEL-shaped, not
    // edge-shaped: it stays true on every turn until a cut actually lands, and
    // a pass takes O(transcript / window) sequential metered provider calls to
    // land one. Without this, a turn that starts and finishes while a pass is
    // summarizing schedules a second full summarization of the same transcript
    // — duplicate work, duplicate residency, and duplicate BILLING (each pass
    // meters under its own `compaction` sourceScope, so nothing dedupes them).
    // The old usage-only gate was edge-shaped and effectively never doubled up;
    // this is the exposure the transcript reason introduces.
    if (this.piPostTurnCompactionInFlight) {
      // Coalesce rather than drop: the turns that landed during the pass are
      // not covered by the cut it is computing, and a level trigger that is
      // merely suppressed would wait for the NEXT turn to be re-noticed.
      this.piPostTurnCompactionRerun = {
        triggerMessage: latestAssistant,
        userId: this.getActiveTurnUserId(),
      };
      return;
    }

    this.recordPiPostTurnCompactionDecision(reason);
    this.startPiPostTurnCompaction(latestAssistant, this.getActiveTurnUserId());
  }

  /**
   * The masked case, made visible: this turn's provider usage was comfortable,
   * and a durable cut is being scheduled anyway because the transcript behind
   * the request is not. Emitted at the DECISION, not at the outcome — the pass
   * re-checks and may still stand down, which `pi_context_budget` reports.
   * Without this event the fix is indistinguishable in telemetry from a thread
   * that simply never grew.
   *
   * One event per pass that actually starts, including a coalesced follow-up;
   * a suppressed schedule emits nothing, because the pass it folded into
   * already reported the same decision.
   */
  private recordPiPostTurnCompactionDecision(
    reason: { kind: "usage" } | ({ kind: "transcript" } & PiTranscriptCompactionTrigger),
  ): void {
    if (reason.kind !== "transcript") return;
    this.recordChatThreadObservabilityEvent("pi_post_turn_compaction_transcript", {
      operation: "compact_context_after_turn",
      status: reason.reason,
      count: reason.tokens,
      size: reason.bytes,
      model: typeof this.piSession?.state.model?.id === "string"
        ? this.piSession.state.model.id
        : null,
      provider: this.piCurrentUsageProvider || null,
      extraCounts: [
        reason.thresholdTokens,
        reason.byteCeiling,
        reason.messageCount,
        reason.storedChars,
        reason.storedCharCeiling,
      ],
    });
  }

  /**
   * Owns the in-flight slot: assigned before the promise is handed to
   * `waitUntil`, cleared in `finally`, and the only place either happens.
   */
  private startPiPostTurnCompaction(
    triggerMessage: AgentMessage,
    initiatingUserId: string | null,
  ): void {
    const run = this.compactPiContextAfterTurn(triggerMessage, initiatingUserId)
      .catch((error) => {
        console.error("[ChatThreadDO] Pi post-turn compaction failed", error);
      })
      .finally(() => {
        this.piPostTurnCompactionInFlight = null;
        this.runCoalescedPiPostTurnCompaction();
      });
    this.piPostTurnCompactionInFlight = run;
    this.ctx.waitUntil(run);
  }

  /**
   * At most ONE follow-up pass per completed pass, re-gated against the list as
   * it stands now. The pass that just finished usually cut the transcript, so
   * the common outcome here is that the reason is gone and nothing runs.
   */
  private runCoalescedPiPostTurnCompaction(): void {
    const pending = this.piPostTurnCompactionRerun;
    this.piPostTurnCompactionRerun = null;
    if (!pending) return;
    const session = this.piSession;
    if (!session) return;
    const reason = this.piPostTurnCompactionReason(
      pending.triggerMessage,
      session.state.messages,
      session.state.model,
    );
    if (!reason) return;
    this.recordPiPostTurnCompactionDecision(reason);
    this.startPiPostTurnCompaction(pending.triggerMessage, pending.userId);
  }

  private async compactPiContextAfterTurn(
    triggerMessage: AgentMessage,
    initiatingUserId: string | null = null,
  ): Promise<void> {
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
      !this.piPostTurnCompactionReason(
        triggerMessage,
        session.state.messages,
        session.state.model,
      )
    ) {
      return;
    }

    const completeSimple = await this.loadPiCompleteSimple();
    const current = await resolver();
    if (
      session.state.isStreaming ||
      !this.piPostTurnCompactionReason(
        triggerMessage,
        session.state.messages,
        current.model,
      )
    ) {
      return;
    }

    const before = session.state.messages;
    const context = this.chatContext;
    const compacted = await this.compactPiContext(
      before,
      current.model,
      current.apiKey,
      completeSimple,
      undefined,
      // Already gated by piPostTurnCompactionReason above, so no extra floor;
      // the session is idle here, so every index is committed — which is the
      // whole reason the durable cut belongs on THIS path and not on the
      // per-request one, whose cut lands in the uncommitted tail and can only
      // ever be memoized.
      {
        force: true,
        ...(context
          ? { metering: { context, modelConfig: current, userId: initiatingUserId } }
          : {}),
      },
    );
    if (compacted === before || session.state.isStreaming || session.state.messages !== before) {
      return;
    }

    session.state.messages = compacted;
    /**
     * Keep the rows, keep the durable watermark, re-point the session's index
     * space at it. Shared by the two cases that must NOT rewrite pi_core, both
     * for the same reason: the rewrite would delete rows that have no copy
     * anywhere else. `compactPiContext` above already persisted a real
     * `pi_core_compaction` row, so the thread is bounded either way — the
     * rewrite is only a compaction of storage, never the bound itself.
     */
    const keepRowsBehindWatermark = (): void => {
      const persisted = this.loadPiCoreCompaction();
      if (persisted) {
        this.piSessionLoadWindow = {
          firstRowIdx: persisted.firstKeptIndex,
          summaryOffset: 1,
          capped: this.piSessionLoadWindow?.capped ?? false,
        };
      }
      this.piMainBaselineIndex = compacted.length;
    };
    if (this.piSessionLoadWindow?.capped) {
      // A CAPPED session does not hold the whole thread, so it may not rewrite
      // pi_core: `replacePiCoreMessages` deletes every row not in the list it is
      // handed, and the rows this session deliberately never loaded are exactly
      // the ones that would be destroyed. (Its archive snapshot is also the
      // full-thread derive — the O(thread) allocator this whole change exists to
      // avoid, pointed at the biggest thread there is.)
      //
      // The durable bound is already in place: `compactPiContext` above persisted
      // a real `pi_core_compaction` row, which is what every later load reads. So
      // keep the row, keep the rows, and re-point the session's index space at the
      // watermark that was just written — the view the session now holds is
      // `[summary, ...rows >= first_kept_index]`, still short of the thread.
      keepRowsBehindWatermark();
      return;
    }
    // Compaction only summarizes away rows the render mirror already shows;
    // "preserve" keeps the visible history and re-pins the top-up mark to the
    // rewritten (shorter) parsed count.
    const rewrite = await this.replacePiCoreMessages(compacted, {
      uiRender: "preserve",
    });
    if (rewrite.status === "skipped_archive_truncated") {
      // The archive walk could not cover the whole prefix, so the rewrite was
      // refused rather than delete unarchived rows. Same landing as the capped
      // branch: the durable watermark is what bounds the thread, and the next
      // post-turn pass gets to try again from a shorter range.
      keepRowsBehindWatermark();
      return;
    }
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
    ).then((modelConfig) => {
      if (!sponsoredCapability) this.piCurrentUsageModel = modelConfig.model.id;
      return modelConfig;
    });
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

  private async assertPiUserLlmUsageAccess(
    context: ChatContextState,
    modelConfig: PiResolvedModelConfig,
    userId: string | null = this.getActiveTurnUserId(),
  ): Promise<void> {
    if (!userId) return;
    try {
      await this.awaitPiUsageSettlements();
    } catch {
      recordObservabilityEvent(this.env, {
        event: "user_llm_usage_limit_denied",
        severity: "error",
        component: "chat_thread",
        operation: "await_usage_settlement",
        status: "usage_policy_unavailable",
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId,
        provider: modelConfig.usageProvider,
        model: modelConfig.model.id,
      });
      throw new UserLlmUsageLimitError(
        "usage_policy_unavailable",
        null,
        modelConfig.usageProvider,
        modelConfig.model.id,
      );
    }
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
    await assertUserLlmUsageAccess(orgStub, {
      env: this.env,
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      threadId: context.threadId,
      userId,
      provider: modelConfig.usageProvider || modelConfig.model.provider,
      model: modelConfig.model.id,
    });
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
    const bedrockBaseUrls = this.piCurrentUsageProvider === "bedrock"
      ? this.piModelMapping.bedrockRegionalBaseUrls(model.id, model.baseUrl)
      : [model.baseUrl];
    let bedrockRegionIndex = 0;
    let requestModel = model;
    const canRetryInAnotherBedrockRegion = (message: string) =>
      isBedrockRegionUnavailableError(message) &&
      bedrockRegionIndex < bedrockBaseUrls.length - 1;
    return streamPiModelWithTransientRetry(
      model,
      effectiveOptions,
      () => streamSimple(requestModel, context, effectiveOptions),
      (message, status, attempt, forwardedEvent) =>
        this.recordPiProviderStreamTerminalError(
          requestModel,
          message,
          status,
          attempt,
          forwardedEvent,
        ),
      {
        maxRetryAttempts: 2 + Math.max(0, bedrockBaseUrls.length - 1),
        isRetryableError: canRetryInAnotherBedrockRegion,
        onRetry: (message) => {
          if (!canRetryInAnotherBedrockRegion(message)) return;
          bedrockRegionIndex += 1;
          requestModel = {
            ...model,
            baseUrl: bedrockBaseUrls[bedrockRegionIndex],
          };
        },
      },
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
      activeTurnUserId: () => this.getActiveTurnUserId(),
      assertUserLlmUsageAccess: (context, modelConfig, userId) =>
        this.assertPiUserLlmUsageAccess(context, modelConfig, userId),
      afterPiToolCall: (toolContext, signal, options) =>
        this.afterPiToolCall(toolContext, signal, options),
      beforePiToolCall: (toolContext, signal) =>
        this.beforePiToolCall(toolContext, signal),
      streamPiModel: (model, llmContext, options, streamSimple) =>
        this.streamPiModel(model, llmContext, options, streamSimple),
      recordPiAssistantUsage: (message, durationMs, billingSource, creditChargeable, usageProvider, attribution) =>
        this.recordPiAssistantUsage(message, durationMs, billingSource, creditChargeable, usageProvider, attribution),
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
    const definitions = createPiToolDefinitions(this.piToolSurfaceDeps(), context, {
      ...options,
      outboundEmailEnabled:
        options.outboundEmailEnabled !== false &&
        !isSelfhostRuntime(this.env),
      appVisibilityConfigurable:
        options.appVisibilityConfigurable !== false &&
        !isSelfhostRuntime(this.env),
    });
    if (
      this.activeAutomationRun?.requiresExplicitOutcome &&
      options.includeSubagents !== false
    ) {
      definitions.push({
        name: "report_automation_outcome",
        label: "Report automation outcome",
        description:
          "Required final status for this scheduled automation. Report success only if the requested objective actually completed and was verified; otherwise report failed, partial, or needs_attention.",
        parameters: Type.Object({
          status: Type.Union([
            Type.Literal("success"),
            Type.Literal("failed"),
            Type.Literal("partial"),
            Type.Literal("needs_attention"),
          ]),
          summary: Type.String({
            minLength: 1,
            maxLength: 2_000,
            description: "Concise factual outcome, including the blocker when not successful.",
          }),
        }),
        execute: async (_toolUseId, params, signal) => {
          if (signal?.aborted) throw new Error("Operation aborted");
          const run = this.activeAutomationRun;
          if (!run?.requiresExplicitOutcome) {
            throw new Error("No scheduled automation run is active");
          }
          if (run.reportedOutcome) {
            throw new Error("Automation outcome was already reported for this run");
          }
          const raw = params as {
            status: "success" | "failed" | "partial" | "needs_attention";
            summary: string;
          };
          const summary = raw.summary.trim();
          if (!summary) throw new Error("Automation outcome summary is required");
          this.setActiveAutomationRun({
            ...run,
            reportedOutcome: { status: raw.status, summary },
          });
          return {
            content: [{
              type: "text" as const,
              text: `Automation outcome recorded: ${raw.status}`,
            }],
            details: { status: raw.status },
          };
        },
        executionMode: "sequential",
      });
    }
    return definitions;
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
    return createPiSubagentSystemPrompt(context, isExplore, this.env);
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
      // Failed and user-aborted responses can still contain provider-reported
      // usage (for example, a stream that fails after emitting billable
      // tokens). Meter before the transcript-specific early returns so every
      // completed provider pull with usage reaches the settlement queue.
      const durationMs = this.piTurnStartedAtMs
        ? Date.now() - this.piTurnStartedAtMs
        : 0;
      const billingSource = this.piCurrentBillingSource;
      const creditChargeable = this.piCurrentCreditChargeable;
      const usageProvider = this.piCurrentUsageProvider;
      const usageUserId = this.getActiveTurnUserId();
      this.ctx.waitUntil(
        this.recordPiAssistantUsage(
          event.message,
          durationMs,
          billingSource,
          creditChargeable,
          usageProvider,
          {
            userId: usageUserId,
            model:
              (event.message as AgentMessage & { model?: string }).model ||
              this.piCurrentUsageModel ||
              undefined,
            usageSurface: "agent",
            sourceScope: this.piRuntimeThreadId(),
          },
        ).catch((error) => {
          console.error("[ChatThreadDO] failed to record Pi usage", error);
        }),
      );

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
      // Deliberately NOT gated on finalText. It used to be, which meant a run
      // that failed AFTER emitting any visible token surfaced nothing at all:
      // pushChatEvent is the only funnel for the thread error record, the
      // observability event, the composer banner, and the durable inline error
      // part, so skipping it skipped every channel. Across 100 production
      // threads, 14 abnormal turns that had emitted text recorded zero errors
      // while 9 of 17 that had emitted none recorded them — perfect separation.
      // One real case had piAssistantText === "\n\n", truthy enough to hide a
      // failure, and the user's next message was "can you do it or not? I've
      // been waiting about 3 or 4 hours now".
      //
      // Safe because a completed run cannot carry an error: Pi's loop returns
      // immediately on stopReason "error", so only a run's last message has one;
      // stopped-by-user is a separate branch below, and aborted yields "".
      const errorMessage = stoppedByUser
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
      // Before turn/completed on purpose: that event encodes `finish`, and a
      // durable error part written after `finish` does not stick — which is why
      // an already-reported error could still reappear as a fresh banner on
      // every reload instead of staying inline in the transcript.
      if (!stoppedByUser && errorMessage) {
        this.pushChatEvent(this.piProviderErrorEvent(errorMessage));
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
      } else if (errorMessage) {
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
    attribution: {
      userId: string | null;
      model?: string;
      usageSurface: "agent" | "subagent" | "compaction";
      sourceScope?: string;
      source?: "pi_assistant" | "pi_compaction";
    } = {
      userId: this.getActiveTurnUserId(),
      usageSurface: "agent",
    },
  ): Promise<void> {
    const context = this.chatContext;
    if (message.role !== "assistant" || !context) return;
    const immutableContext = { ...context };
    const createdAtMs = Date.now();
    const job = () => this.recordPiAssistantUsageSettled(
      message,
      durationMs,
      billingSource,
      creditChargeable,
      usageProvider,
      attribution,
      immutableContext,
      createdAtMs,
    );
    const queue = (this.pendingLlmUsageSettlements ??= []);
    queue.push(job);
    const settlement = (this.llmUsageSettlementChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.drainPiUsageSettlements());
    this.llmUsageSettlementChain = settlement;
    return settlement;
  }

  private async awaitPiUsageSettlements(): Promise<void> {
    try {
      await (this.llmUsageSettlementChain ?? Promise.resolve());
      return;
    } catch (error) {
      if (!(this.pendingLlmUsageSettlements?.length > 0)) throw error;
    }

    // A failed job remains at the head of the in-memory queue with the same
    // deterministic source/source_id inputs. Retry it before policy evaluation
    // so recovery cannot bypass spend that should have settled. Isolate
    // eviction remains the recovery boundary; provider-response journaling is
    // intentionally a separate durability project.
    const retry = (this.llmUsageSettlementChain ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.drainPiUsageSettlements());
    this.llmUsageSettlementChain = retry;
    await retry;
  }

  private async drainPiUsageSettlements(): Promise<void> {
    const queue = (this.pendingLlmUsageSettlements ??= []);
    while (queue.length > 0) {
      const job = queue[0];
      await job();
      queue.shift();
    }
  }

  private async recordPiAssistantUsageSettled(
    message: AgentMessage,
    durationMs: number,
    billingSource: PiBillingSource,
    creditChargeable: boolean,
    usageProvider: string | null | undefined,
    attribution: {
      userId: string | null;
      model?: string;
      usageSurface: "agent" | "subagent" | "compaction";
      sourceScope?: string;
      source?: "pi_assistant" | "pi_compaction";
    },
    context: ChatContextState,
    createdAtMs: number,
  ): Promise<void> {
    if (message.role !== "assistant") return;

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

    const immutableAssistant = Number.isFinite(Number(assistant.timestamp))
      ? assistant
      : { ...assistant, timestamp: createdAtMs };
    const usageSourceId = piUsageSourceId(
      attribution.sourceScope || context.threadId,
      immutableAssistant,
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
          user_id: attribution.userId ?? "",
          thread_id: context.threadId,
          model: attribution.model || assistant.model || "unknown",
          provider: usageProvider || assistant.provider || "unknown",
          billing_source: billingSource,
          credit_chargeable: billingSource === "hosted" && creditChargeable,
          usage_kind: "llm",
          usage_surface: attribution.usageSurface,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheWriteTokens,
          cache_read_input_tokens: cacheReadTokens,
          estimated_cost_usd:
            typeof usage.cost?.total === "number" && usage.cost.total > 0
              ? usage.cost.total
              : undefined,
          duration_ms: durationMs,
          created_at_ms: createdAtMs,
          source: attribution.source ?? "pi_assistant",
          source_id: usageSourceId,
        }),
      { attempts: 4, initialDelayMs: 150 },
    );
  }

  private sendRunnerCommand(message: Record<string, unknown>): boolean {
    const type = typeof message.type === "string" ? message.type : "unknown";
    try {
      if (type === "message") {
          const content = typeof message.content === "string" ? message.content : "";
          if (!content.trim()) {
            return false;
          }
          // Cold admission must not wait for Pi session construction. An
          // existing marker means this message joins the recoverable in-flight
          // turn; otherwise it opens a new journaled turn. A warm idle session
          // retains the rapid-double-send FIFO behavior below.
          const wasStreaming = this.piSession
            ? this.piSession.state.isStreaming
            : this.readPiActiveTurn() !== null;
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
      if (this.piSession) {
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
      }
    } catch (error) {
      console.error("[ChatThreadDO] send Pi command failed", error);
      return false;
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
    this.piSession.state.tools = this.createPiToolDefinitions(context);
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
          // A fresh prompt is never degraded, and neither is the next re-drive
          // unless its own rung says so: resumeActivePiTurn re-sets this below.
          this.piDegradedResumeAttempt = false;
          this.piEphemeralCompaction = null;
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
      // VOLUNTARY re-drive: this isolate is alive and chose to regenerate after a
      // provider 429/529. It rebuilds the session like an eviction recovery, so it
      // is still bounded — but on its own counter
      // ({@link PI_TURN_VOLUNTARY_RESUME_BUDGET}), never on the isolate-death
      // budget that a real wake loop must pass through.
      await this.resumeActivePiTurn({ cause: "transient_retry" });
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
    // A Durable Object reset is not a turn failure. Until now AbortError was the
    // only exemption, so a platform reset took the terminal path: it showed the
    // user the raw workerd string ("Durable Object reset because its code was
    // updated.") AND cleared the marker + journal that chatRecovery needs — so
    // the same handler that reported the failure also disabled the recovery that
    // would have fixed it. Recovery demonstrably works when left armed: one
    // production thread absorbed 15 consecutive resets and still completed with
    // a correct answer. Leave the marker and journal in place, record it as a
    // warning rather than a user-visible terminal error, and let chatRecovery
    // re-drive within its existing bounded budget.
    if (isTransientDurableObjectRpcError(error)) {
      console.warn("[ChatThreadDO] Pi turn hit a transient DO reset; leaving recovery armed", error);
      this.recordChatThreadObservabilityEvent("pi_turn_transient_reset", {
        operation: "pi_turn",
        status: "recoverable",
        severity: "warn",
        error,
      });
      // This handler RAN, so the isolate was alive to classify the interruption:
      // the recovery re-drive that follows must not spend the isolate-death budget
      // (the 15-reset production thread would otherwise be abandoned at reset #4).
      this.markPiTurnBenignInterruption();
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
    void this.releasePiTurnAfterGiveUp();
  }

  /**
   * Commit the journal's accepted-but-uncommitted REAL WORK, then clear the marker
   * and journals. Every give-up path must go through here rather than calling
   * {@link clearPiActiveTurnAndJournal} directly.
   *
   * The journal is the only durable copy of work the thread already accepted but
   * pi_core has not seen: the turn's user message when the FIRST model call failed,
   * messages admitted while the marker was open (onChatMessage discards the
   * in-memory prompt queue on the resume branch precisely BECAUSE their journal rows
   * are the durable copy), steered messages that never drained, and completed tool
   * results. Deleting it leaves the render transcript showing a user bubble the
   * model has never seen and no later turn will ever re-deliver. Mirrors
   * {@link finishPiTurnStoppedDuringTransientRetry}, which already does this for the
   * user-stop give-up: keep everything except the failed assistant rows, dedup
   * against committed history (appendPiCoreMessagesIfMissing), then delete.
   *
   * Code Mode / js_exec artifacts are folded onto their tool results first, exactly
   * as turn_end and the recovered-tail commit do: the artifacts live in a transient
   * KV bucket keyed by tool-call id, and this is the LAST moment anything will ever
   * look at that key — after the clear below, no future turn's journal tail carries
   * the id, so an unfolded artifact is both invisible in the transcript and a
   * permanent KV leak. `consume: true` drains the bucket.
   *
   * `stampWork` controls the same-content-same-id invariant. Stamping a pi_core row
   * with the live turnId is a PROMISE that the render row under that id displays
   * this content (the mirror's top-up skips stamped rows whose id already exists —
   * ui-mirror.ts, `hasDurableRenderId`). That holds when the interrupted stream
   * orphan-persisted its partial; it does NOT hold when the give-up is about to
   * create the turnId row out of `append` alone, which would hide the salvaged work
   * forever. The caller decides; the default (stamped) preserves the historical
   * behaviour of the paths that stream nothing of their own.
   *
   * Best effort: a storage failure here must never throw an abandoned turn back
   * into the resume loop, and the clear still runs.
   */
  private async releasePiTurnAfterGiveUp(
    options: {
      work?: AgentMessage[];
      append?: AgentMessage[];
      stampWork?: boolean;
    } = {},
  ): Promise<void> {
    try {
      // `work` lets the salvage rung reuse the tail it already read (and already
      // decided is worth keeping) instead of loading the journals twice.
      const realWork = options.work ?? (await this.loadPiTurnUncommittedWork());
      if (realWork.length > 0) {
        const workWithArtifacts = await Promise.all(
          realWork.map((message) =>
            this.attachCodeModeArtifactsToToolResult(message, { consume: true }),
          ),
        );
        const append = options.append ?? [];
        const turnId = this.activePiStreamTurnId;
        await this.appendPiCoreMessagesIfMissing(
          options.stampWork === false
            ? [...workWithArtifacts, ...stampPiRenderMessageId(append, turnId)]
            : stampPiRenderMessageId([...workWithArtifacts, ...append], turnId),
        );
        this.recordChatThreadObservabilityEvent("pi_turn_giveup_journal_commit", {
          operation: "resume_interrupted_turn",
          status: "committed",
          severity: "warn",
          count: realWork.length,
        });
      }
    } catch (error) {
      console.error(
        "[ChatThreadDO] failed to commit the journal tail before giving up",
        error,
      );
      try {
        this.recordChatThreadObservabilityEvent("pi_turn_giveup_journal_commit", {
          operation: "resume_interrupted_turn",
          status: "failed",
          severity: "error",
          error,
        });
      } catch {
        // Telemetry is never allowed to block the clear below.
      }
    }
    await this.clearPiActiveTurnAndJournal();
  }

  /**
   * The work an interrupted turn already accepted but pi_core has not seen: the
   * turn journal's staged tail plus steered messages that never drained, minus the
   * failed assistant rows (a provider error is not work). Shared by every give-up
   * path and by the salvage rung, which decides on emptiness BEFORE committing.
   */
  private async loadPiTurnUncommittedWork(): Promise<AgentMessage[]> {
    const [journalTail, steerMessages] = await Promise.all([
      this.loadPiTurnJournalTail(),
      this.loadPiTurnSteerJournal(),
    ]);
    return [...journalTail, ...steerMessages].filter(
      (message) => !isFailedPiAssistantMessage(message),
    );
  }

  /**
   * Ladder rung 4 ({@link piTurnResumeRung}): finish the turn WITHOUT calling the
   * provider. Three memory kills and a degraded rebuild have already failed, so the
   * only thing left that is cheaper is not rebuilding a model context at all: commit
   * the settled journal work (tool results, partial assistant text, admitted user
   * messages) plus a short note saying the turn was interrupted and can be
   * continued, then close the turn exactly like a completed one — marker + journal
   * cleared, ownership released, todo state completed, automation run closed.
   *
   * Returns false when the journal holds no real work: there is nothing to salvage,
   * so the caller goes terminal in the same wake instead of ending the turn with a
   * bare note. Also returns false if the journals cannot be read — the terminal path
   * is the safe fallback, and it re-reads them under its own best-effort commit.
   *
   * The commit reuses {@link releasePiTurnAfterGiveUp} (commit-then-clear, dedup via
   * appendPiCoreMessagesIfMissing) so salvage cannot drift from the other give-ups;
   * the note rides along as the final assistant message.
   *
   * Two details keep the render transcript honest, and both hinge on whether the
   * dead stream left a durable render row under this turnId (ai-chat orphan-persists
   * a partial only when it carried settled tool results — see onChatRecovery):
   *  - WHEN IT DID, that row already shows the salvaged work, so the commit stamps
   *    the work with the turnId as usual and ai-chat's CONTINUE appends the note to
   *    that same row.
   *  - WHEN IT DID NOT, the re-drive is a RETRY and the only thing that will ever
   *    stream into the turnId row is the note itself. Stamping the work then would
   *    promise the mirror that a note-only row displays it, and the top-up would
   *    skip those rows forever — the user would never see the work this rung exists
   *    to save. So only the NOTE is stamped; the work commits unstamped and the
   *    top-up converts it normally, ahead of the note by pi_core commit order.
   * The note is emitted as its own `turnNotice` part rather than a text delta, so a
   * CONTINUE cannot splice it onto the tail of the partial's half-written sentence
   * (ai-chat drops the encoder's `text-start` when it resumes a `streaming` text
   * part). Trimming that partial instead is not an option here: unlike a real
   * continuation, nothing regenerates it, and its content is exactly what this rung
   * is preserving.
   */
  private async salvagePiTurnWithoutModel(
    attempt: PiTurnResumeAttempt,
  ): Promise<boolean> {
    let work: AgentMessage[];
    try {
      work = await this.loadPiTurnUncommittedWork();
    } catch (error) {
      console.error(
        "[ChatThreadDO] failed to read the journal for a turn salvage",
        error,
      );
      return false;
    }
    if (work.length === 0) return false;

    const completedAtMs = Date.now();
    const note = this.createPiTurnSalvageMessage(completedAtMs);
    // Read BEFORE the note streams (which creates the row when it is absent).
    const liveTurnRowExists = this.hasLiveAssistantRowForActiveTurn();
    this.recordChatThreadObservabilityEvent("pi_turn_resume_salvaged", {
      operation: "resume_interrupted_turn",
      status: "salvaged",
      severity: "info",
      count: work.length,
      size: attempt.isolateDeath,
      sampleKey: liveTurnRowExists ? "continued_partial" : "no_partial",
    });
    await this.releasePiTurnAfterGiveUp({
      work,
      append: [note],
      stampWork: liveTurnRowExists,
    });

    // Close the turn out on every channel the normal end-of-turn uses, so the
    // thread is immediately usable and no client is left spinning.
    const threadId = this.chatContext?.threadId || "";
    const turnStartedAtMs =
      this.piAgentStartedAtMs || this.piTurnStartedAtMs || completedAtMs;
    this.piAgentStartedAtMs = 0;
    this.pushPiRuntimeEvent("item/agentMessage/delta", {
      threadId,
      itemId: `pi_turn_salvage_${completedAtMs}`,
      // Its own part (see the class note above): a text delta would be absorbed
      // into a resumed partial's trailing streaming text run.
      itemKind: "turnNotice",
      delta: PI_TURN_SALVAGE_NOTE,
    });
    this.pushPiRuntimeEvent("turn/completed", {
      threadId,
      completedAtMs,
      turnDurationMs: Math.max(0, completedAtMs - turnStartedAtMs),
    });
    this.pushChatEvent({
      type: "result",
      threadId,
      result: PI_TURN_SALVAGE_NOTE,
      sessionId: threadId,
      completedAt: completedAtMs,
    });
    // An automation run whose turn never reached the model did not do what it was
    // asked, so it closes as an error carrying the note — same shape as the
    // user-stop teardown, and set BEFORE finishTurn so its success branch (which
    // fires on markUnread) finds no run left to mark.
    this.updateActiveAutomationRun({
      status: "error",
      message: PI_TURN_SALVAGE_NOTE,
      completedAt: completedAtMs,
      clear: true,
    });
    this.finishTurn({
      markUnread: true,
      completedAt: completedAtMs,
      summarySource: extractThreadCompletionSummarySource(work, PI_TURN_SALVAGE_NOTE),
    });
    this.setActiveTurnUserId(null);
    await this.completeTodoStateForTurnEnd();
    // The warm session (if any) still holds the interrupted turn's uncommitted
    // tail, which pi_core has now absorbed — rebuild on the next turn.
    this.disposePiSession();
    return true;
  }

  /**
   * The salvage note as a pi_core assistant message (rung 4's final message).
   * Shaped like {@link createPiUserStopMessage}: a synthetic assistant row with an
   * `aborted` stop reason so nothing downstream reads it as a provider answer.
   */
  private createPiTurnSalvageMessage(timestamp: number): AgentMessage {
    const model = this.piSession?.state.model;
    return {
      role: "assistant",
      content: [{ type: "text", text: PI_TURN_SALVAGE_NOTE }],
      api: model?.api ?? "unknown",
      provider: model?.provider ?? "unknown",
      model: model?.id ?? "unknown",
      usage: this.emptyPiUsage(),
      stopReason: "aborted",
      responseId: `pi_turn_salvage_${timestamp}`,
      timestamp,
      metadata: {
        reason: PI_TURN_SALVAGE_METADATA_REASON,
      },
    } as unknown as AgentMessage;
  }

  /**
   * chatRecovery `onExhausted` hook (commit 6): an interrupted turn spent its
   * recovery budget. The framework delivers `terminalMessage` to the client and
   * records the durable terminal itself; here we run the same give-up teardown the
   * old failPiResume path did — commit the journal's accepted work and clear the
   * marker + journal, release turn ownership, fail any active automation run,
   * surface durable lastError, and log.
   */
  private async handlePiRecoveryExhausted(
    ctx: ChatRecoveryExhaustedContext,
  ): Promise<void> {
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
    await this.releasePiTurnAfterGiveUp();
    this.finishTurn();
    this.setActiveTurnUserId(null);
    try {
      this.pushChatEvent(this.piProviderErrorEvent(ctx.terminalMessage));
    } catch {
      // Best effort: the framework already delivered the terminal banner; the
      // observability event above is the actionable signal.
    }
  }

  /**
   * Give up on an interrupted turn that spent one of its progress-independent
   * resume budgets ({@link PI_TURN_RESUME_BUDGET} /
   * {@link PI_TURN_VOLUNTARY_RESUME_BUDGET} / {@link PI_TURN_TOTAL_RESUME_BUDGET}).
   * Runs exactly the {@link handlePiRecoveryExhausted} teardown — fail the
   * automation run, commit the journal's accepted work and clear the marker +
   * journal, release turn ownership, surface the error — under a DISTINCT
   * observability status, because this abandonment happens while ai-chat still
   * considers the recovery healthy (every re-drive made progress) and is therefore
   * a different production signal. `exceeded` says WHICH budget tripped so the
   * three failure modes stay separable in telemetry.
   *
   * Since the framework is NOT giving up here, it also does not run its own
   * terminal delivery: {@link deliverPiTurnTerminal} supplies that half.
   * Afterwards the thread owns no turn — a new sendMessage starts a fresh one.
   */
  private async abandonPiTurnOverResumeBudget(
    attempt: PiTurnResumeAttempt,
    exceeded: "isolate_death" | "voluntary" | "total",
  ): Promise<void> {
    console.error(
      `[ChatThreadDO] abandoning an interrupted Pi turn: ${exceeded} resume budget spent ` +
        `(total=${attempt.total} isolateDeath=${attempt.isolateDeath} voluntary=${attempt.voluntary})`,
    );
    this.recordChatThreadObservabilityEvent("pi_turn_resume_abandoned", {
      operation: "resume_interrupted_turn",
      status: "resume_budget_exhausted",
      severity: "error",
      count: attempt.total,
      size: attempt.isolateDeath,
      sampleKey: exceeded,
    });
    this.updateActiveAutomationRun({
      status: "error",
      message: PI_TURN_RESUME_BUDGET_EXHAUSTED_MESSAGE,
      clear: true,
    });
    await this.releasePiTurnAfterGiveUp();
    this.finishTurn();
    this.setActiveTurnUserId(null);
    try {
      this.pushChatEvent(
        this.piProviderErrorEvent(PI_TURN_RESUME_BUDGET_EXHAUSTED_MESSAGE),
      );
    } catch (error) {
      // Best effort: the durable terminal below is what a detached client reads.
      console.error(
        "[ChatThreadDO] failed to push the resume-budget terminal event",
        error,
      );
    }
    await this.deliverPiTurnTerminal(PI_TURN_RESUME_BUDGET_EXHAUSTED_MESSAGE);
  }

  /**
   * The framework half of a give-up, for a terminal this DO decided by itself.
   * Mirrors AIChatAgent's `_exhaustChatRecovery` `terminalize` step (which only
   * runs when the SDK is the one exhausting a recovery): broadcast the terminal
   * banner, persist the durable terminal record so a client that reconnects after
   * the turn ended still learns the outcome (replayed over the resume handshake),
   * and clear the live "recovering…" flag — whose only other clearer is the
   * recovery bookkeeping this abandonment steps outside of.
   *
   * Best effort by design: the teardown already ran, so a storage failure here
   * must not throw the abandoned turn back into the resume loop.
   *
   * The durable record alone is NOT enough: this abandonment returns normally, so
   * the reply stream closes without an error and ai-chat's turn drain sees
   * `status: "completed"` and calls `_clearChatTerminal()` — deleting the record we
   * just wrote, in the same turn. The pending copy stashed here is re-asserted from
   * {@link onChatResponse}, which the drain calls immediately AFTER that clear.
   */
  private async deliverPiTurnTerminal(message: string): Promise<void> {
    try {
      // The id the terminal frame (and its handshake replay) is keyed by: the
      // request the live stream belongs to, falling back to the turn/stream id
      // when no resumable stream is attached.
      const requestId =
        this._activeRequestId ?? this.activePiStreamTurnId ?? undefined;
      this.broadcastChat({
        body: message,
        done: true,
        error: true,
        type: CHAT_MESSAGE_TYPES.USE_CHAT_RESPONSE,
        ...(requestId ? { id: requestId } : {}),
      });
      if (requestId) {
        await recordChatTerminal(this.ctx.storage, requestId, message);
        this.pendingPiTurnTerminal = { requestId, message };
      }
      await setChatRecovering(false, requestId, {
        storage: this.ctx.storage,
        messageType: CHAT_MESSAGE_TYPES.CHAT_RECOVERING,
        broadcast: (frame) => this.broadcastChat(frame),
        now: Date.now(),
      });
    } catch (error) {
      this.recordChatThreadObservabilityEvent("pi_turn_terminal_delivery", {
        operation: "resume_interrupted_turn",
        status: "failed",
        severity: "warn",
        error,
      });
    }
  }

  /**
   * Re-assert a terminal this DO decided by itself ({@link deliverPiTurnTerminal})
   * after ai-chat's turn drain deleted it.
   *
   * The drain (`_runExclusiveChatTurn`'s finally) runs
   * `_clearChatTerminal()` for a `completed`/`aborted` turn and THEN calls this
   * hook. An abandoned resume returns normally — the reply stream carries the error
   * frame but closes cleanly — so the turn drains as `completed` and the record
   * written moments earlier inside the same turn is deleted before any client can
   * read it. Re-recording here (after the delete, keyed on the same requestId) is
   * what makes `_replayTerminalOnResume` / `_replayTerminalOnAck` find it, so a
   * client that reconnects after the turn ended still learns the outcome instead of
   * an empty replay frame.
   */
  protected override async onChatResponse(
    result: ChatResponseResult,
  ): Promise<void> {
    const pending = this.pendingPiTurnTerminal;
    if (pending && pending.requestId === result.requestId) {
      this.pendingPiTurnTerminal = null;
      try {
        await recordChatTerminal(
          this.ctx.storage,
          pending.requestId,
          pending.message,
        );
      } catch (error) {
        this.recordChatThreadObservabilityEvent("pi_turn_terminal_delivery", {
          operation: "resume_interrupted_turn",
          status: "replay_record_failed",
          severity: "warn",
          error,
        });
      }
    }
    await super.onChatResponse(result);
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
   * Settled render history for the live-user chat loader. Derived from pi_core
   * on read (Phase C), with the live resident window overlaid for the open turn.
   * DO RPC only — intentionally NOT wired to any HTTP route (auth-sensitive).
   */
  async getUiMessages(): Promise<UIMessage[]> {
    return this.withChatMemoryPhase("render_rpc_return_full", async () => {
      await this.sweepOrphanedActiveTurnMarker();
      return (await this.getDerivedUiMessagePage()).messages;
    });
  }

  async getUiMessagePage(): Promise<ChatRenderHistoryPage> {
    return this.withChatMemoryPhase("render_rpc_return", async () => {
      // The SSR loader is the first page-open touch (before the websocket
      // connects). Heal a provably-dead turn's stranded marker here so the load
      // doesn't derive a busy indicator from it.
      await this.sweepOrphanedActiveTurnMarker();
      return this.getDerivedUiMessagePage();
    });
  }

  async getOlderUiMessages(beforeCursor: string): Promise<ChatRenderHistoryPage> {
    if (
      typeof beforeCursor !== "string" ||
      beforeCursor.length === 0 ||
      beforeCursor.length > 1024
    ) {
      throw new Error("A valid render-history cursor is required");
    }
    return this.withChatMemoryPhase("render_rpc_older_page", async () =>
      this.getDerivedUiMessagePage({ beforeCursor }),
    );
  }

  /**
   * Build the newest (or older) page of settled UI history AT THE STORAGE
   * BOUNDARY: pi_core rows are paged newest-first by idx, derived incrementally,
   * and the walk stops once the page is covered — so peak memory is O(page), not
   * O(thread). The live resident window is overlaid on the newest page, and the
   * pre-compaction archive still held in the ai-chat table is consulted only when
   * a page reaches back past the derived tail.
   *
   * `maxMessages`/`maxBytes` exist for tests; every caller uses the constants.
   */
  private async getDerivedUiMessagePage(options?: {
    beforeCursor?: string | null;
    maxMessages?: number;
    maxBytes?: number;
  }): Promise<ChatRenderHistoryPage> {
    const maxMessages = Math.max(
      1,
      Math.floor(options?.maxMessages ?? CHAT_RENDER_WINDOW_MAX_MESSAGES),
    );
    const maxBytes = Math.max(
      1,
      Math.floor(options?.maxBytes ?? CHAT_RENDER_WINDOW_MAX_BYTES),
    );
    const requested =
      typeof options?.beforeCursor === "string" && options.beforeCursor.length > 0
        ? options.beforeCursor
        : null;
    const cursor = requested ? parseDerivedPiRenderCursor(requested) : null;
    let passthroughCursor: string | null = null;
    if (requested && !cursor) {
      if (parseDerivedRenderHistoryCursor(requested) !== null) {
        // A LEGACY `d:<index>` cursor names a position in the fully materialized
        // settled array this path no longer builds. Serve the newest page (whose
        // nextCursor is in the new space) instead of failing the client's scroll.
        //
        // Be precise about what that costs: this REWINDS the client to the top
        // of history. Nothing is lost or duplicated (the client prepends by id
        // and its projection filters resident ids), but a session that had
        // already paged N screens back must click "load older" N more times
        // before the transcript advances. Exposure is limited to SPA sessions
        // that span this deploy — `d:` cursors live only in React state, are
        // minted only by the deprecated full-array pager, and a reload clears
        // them; a DO restart cannot produce one.
        this.recordChatThreadObservabilityEvent("render_page_cursor_legacy", {
          operation: "derive_render_page",
          status: "restarted",
          severity: "warn",
          sampleKey: this.chatContext?.threadId,
        });
      } else {
        // ai-chat's own chronology cursor (handed out while the derive was empty).
        passthroughCursor = requested;
      }
    }

    const page = buildDerivedRenderPage(
      {
        deriveWindow: (beforeIdx) =>
          this.deriveRenderWindow(beforeIdx, { maxMessages, maxBytes }),
        liveMessages: () => this.messages as UIMessage[],
        activeTurnId: () =>
          this.activePiStreamTurnId ?? this.readPiActiveTurn()?.turnId ?? null,
        renderHistoryPage: (args) =>
          this.getRenderHistoryPage({
            beforeCursor: args.beforeCursor,
            maxMessages: args.maxMessages,
            maxBytes: args.maxBytes,
          }),
        oldestDerivedCreatedAtMs: () => this.oldestDerivedPiCreatedAtMs(),
      },
      { cursor, maxMessages, maxBytes, passthroughCursor },
    );

    this.lastDerivedRenderPageStats = page.stats ?? null;
    // Emitted for EVERY page (an archive-phase page carries no derive stats and
    // reports zeroes): `size`/`extraCounts[0]` are the payload bytes and pi_core
    // rows this page materialized, which is the number that says whether the
    // derive is still bounded on a given thread.
    this.recordChatThreadObservabilityEvent("render_derive_page", {
      operation: "derive_render_page",
      status: page.source,
      count: page.messages.length,
      size: page.stats?.payloadChars ?? 0,
      // `warn` means "a FOLD may have been cut", the one outcome that makes two
      // pages emit one id. An orphaned tool answer is not that and must not
      // poison the signal: it is counted separately in extraCounts[4].
      severity: page.stats?.foldCuts ? "warn" : "info",
      extraCounts: [
        page.stats?.rowsRead ?? 0,
        page.stats?.boundaryExtraRows ?? 0,
        page.stats?.droppedToolResults ?? 0,
        page.stats?.boundaryUnresolved ? 1 : 0,
        page.stats?.orphanedToolResults ?? 0,
        page.stats?.foldCuts ?? 0,
      ],
      sampleKey: this.chatContext?.threadId,
    });
    return {
      messages: page.messages,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * One bounded derived window, memoized per pi_core revision + cursor. The
   * memo holds WINDOWS (a page each) and refuses oversized ones, so a whale
   * thread cannot park its transcript in this DO's heap.
   */
  private deriveRenderWindow(
    beforeIdx: number | null,
    limits: { maxMessages: number; maxBytes: number },
  ): PiDerivedRenderWindow {
    const revision = this.piCoreStore.getPiCoreRevision();
    const token = `${revision.generation}:${revision.count}:${limits.maxMessages}:${limits.maxBytes}`;
    const key = beforeIdx === null ? "newest" : `p:${beforeIdx}`;
    const cache =
      this.derivedRenderWindowCache?.token === token
        ? this.derivedRenderWindowCache
        : null;
    const cached = cache?.entries.get(key);
    if (cached) return cached;

    const window = deriveRenderWindowFromPiCore(this.piDeriveRowSource, {
      beforeIdx,
      maxMessages: limits.maxMessages,
      maxBytes: limits.maxBytes,
    });
    const entries = cache?.entries ?? new Map<string, PiDerivedRenderWindow>();
    if (window.stats.payloadChars <= DERIVED_RENDER_WINDOW_CACHE_MAX_CHARS) {
      entries.delete(key);
      entries.set(key, window);
      while (entries.size > DERIVED_RENDER_WINDOW_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
    this.derivedRenderWindowCache = { token, entries };
    return window;
  }

  /** pi_core row reader for the storage-boundary derive. */
  private get piDeriveRowSource(): PiDeriveRowSource {
    return (this.piDeriveRowSourceInstance ??= {
      visibleWindow: () => this.piCoreStore.piCoreVisibleWindow(),
      listRowMeta: (args) => this.piCoreStore.listPiCoreRowMeta(args),
      readRow: (idx, parsedIndex) => this.readPiDeriveRow(idx, parsedIndex),
    });
  }

  /**
   * One pi_core row as the derive needs it. Mirrors the row handling in
   * {@link getPiCoreParsedMessages} exactly — same render image policy, same
   * `piCoreMessageToParsedChatMessage`, same toolResult folding — so a windowed
   * read produces byte-identical messages to the full-thread read.
   *
   * `parsedIndex` must be the row's position in the legacy full load, because an
   * unstamped user row's derived id embeds it (`pi_user_<timestamp>_<index>`). It
   * is reconstructed from `idx` and the compaction watermark, which counts rows
   * the full load would SKIP as corrupt; a thread carrying an unparseable row
   * below the window can therefore number its unstamped legacy user ids
   * differently than before this change (stamped rows, responseId assistants and
   * the role+timestamp mirror keys are unaffected).
   */
  private readPiDeriveRow(
    idx: number,
    parsedIndex: number,
  ): PiDeriveRowRead | null {
    const message = this.piCoreStore.loadPiCoreRenderMessageAt(idx);
    if (!message) return null;
    const record = message as unknown as Record<string, unknown>;
    if (record.role === "toolResult") {
      const toolCallId =
        typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
      return {
        parsed: [],
        toolResult: record,
        stamp: null,
        toolUseIds: [],
        toolCallId: toolCallId || null,
      };
    }
    const parsed = piCoreMessageToParsedChatMessage(
      message,
      parsedIndex,
      this.chatContext?.threadId ?? "",
    );
    // Only ASSISTANT stamps are fold keys (the derive groups assistant rows by
    // renderMessageId); a user row's stamp is its own skeleton id.
    const stamp =
      record.role === "assistant"
        ? (normalizePiUiMetadata(record.uiMetadata)?.renderMessageId ?? null)
        : null;
    const toolUseIds: string[] = [];
    for (const entry of parsed) {
      if (!Array.isArray(entry.content)) continue;
      for (const block of entry.content) {
        if (!block || typeof block !== "object") continue;
        const candidate = block as Record<string, unknown>;
        if (
          candidate.type === "tool_use" &&
          typeof candidate.id === "string" &&
          candidate.id
        ) {
          toolUseIds.push(candidate.id);
        }
      }
    }
    return { parsed, stamp: stamp || null, toolUseIds, toolCallId: null };
  }

  /**
   * pi timestamp of the OLDEST derived message, which places the archive seam
   * (pre-compaction rows are exactly the render rows older than it). Reads
   * forward from the compaction watermark until one row yields a visible
   * message — a couple of rows in practice, hard-bounded regardless.
   *
   * COMPACTION SUMMARIES ARE SKIPPED, and the scan takes the MINIMUM rather than
   * the first hit. `compactPiContext` rewrites pi_core as
   * `[createPiSummaryMessage(summary), ...keptTail]` and then clears the
   * compaction row, so row 0 of the visible window is a synthetic "[Context
   * Summary]" user row stamped with the compaction WALL CLOCK — newer than every
   * row it summarizes and newer than the whole kept tail. Anchoring the seam
   * there admits the entire render table (kept-tail mirrors included) as
   * "archive", which duplicated the tail on every compacted thread's first page.
   */
  private oldestDerivedPiCreatedAtMs(): number | undefined {
    const { firstKeptIndex, summaryOffset, endIdx } =
      this.piCoreStore.piCoreVisibleWindow();
    const limit = Math.min(
      endIdx,
      firstKeptIndex + OLDEST_DERIVED_ROW_SCAN_MAX_ROWS,
    );
    let oldest: number | undefined;
    let oldestIncludingSummaries: number | undefined;
    for (let idx = firstKeptIndex; idx < limit; idx += 1) {
      const message = this.piCoreStore.loadPiCoreRenderMessageAt(idx);
      if (!message) continue;
      const read = this.readPiDeriveRow(
        idx,
        idx - firstKeptIndex + summaryOffset,
      );
      const createdAt = read?.parsed[0]?.created_at;
      if (typeof createdAt !== "number" || !(createdAt > 0)) continue;
      if (
        oldestIncludingSummaries === undefined ||
        createdAt < oldestIncludingSummaries
      ) {
        oldestIncludingSummaries = createdAt;
      }
      if (
        isPiSummaryMessage(message) ||
        read?.parsed[0]?.isCompactSummary === true
      ) {
        continue;
      }
      if (oldest === undefined || createdAt < oldest) oldest = createdAt;
      // The tail is chronological, so the first non-summary row is already the
      // minimum; keep scanning only while summaries are all we have seen.
      break;
    }
    return oldest ?? oldestIncludingSummaries;
  }

  /** @deprecated Kept for focused legacy-heal unit tests; not on the read path. */
  private healLegacyUiMessageTimes(): Promise<void> {
    return this.uiMirror.healLegacyUiMessageTimes();
  }

  /** @deprecated Kept for focused legacy-heal unit tests; not on the read path. */
  private healLegacyUiMessageAuthors(): Promise<void> {
    return this.uiMirror.healLegacyUiMessageAuthors();
  }

  /**
   * Admin repair RPC: refresh the ai-chat live/archive table from pi_core and
   * clear the derive-on-read cache. Settled reads already derive from pi_core;
   * this keeps the compaction-archive hybrid and residual mirror consumers
   * aligned after fork/admin rewrites.
   */
  async resyncUiMessagesFromPiCore(): Promise<{
    ok: true;
    messageCount: number;
  }> {
    this.derivedRenderWindowCache = null;
    await this.rebuildUiMessagesFromPiCore();
    const row = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages",
      )
      .toArray()[0];
    return { ok: true, messageCount: Number(row?.count ?? 0) };
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
      this.messages = this.getRenderHistoryPage().messages;
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
