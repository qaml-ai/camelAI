// Shared type/interface/env definitions for ChatThreadDO and its sibling
// chat-thread-* modules (extracted from chat-thread-do.ts). Pure types only —
// no runtime values live here, so every import below is type-only and the
// module is fully erased at runtime (the type-only circular reference back to
// ChatThreadDO in ChatEnv is therefore safe).
//
// chat-thread-do.ts re-exports every previously-exported symbol from this
// module, so existing `import ... from "../chat-thread-do"` paths keep working
// unchanged. Prefer importing from "../chat-thread-do" externally; this module
// exists to keep the DO file smaller.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  LakeStream,
  PiMessageLakeRecord,
  ToolCallLakeRecord,
} from "../lake-streams";
import type { OrgDO, UserDO } from "../auth";
import type { WorkspaceDO } from "../workspace";
import type { WorkspaceCronDO } from "../workspace-cron";
import type { WorkerLogsDO } from "../worker-logs-do";
import type { WorkspaceFilesystemEnv } from "../workspace-filesystem-do";
import type {
  PendingConnectionSetupPromptData,
  PendingQuestionInfo,
} from "../chat-thread-browser-prompts";
import type { ChatThreadDO } from "../chat-thread-do";
import type { ChatAgentStatePayload } from "../../../../src/lib/chat-agent-state";
import type { RuntimeCallArtifact } from "../../../../src/lib/runtime-artifacts";
import type { LlmModel } from "../../../../src/types";

export type PreviewTarget =
  | {
      kind: "app";
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: "file";
      source: "workspace" | "project" | "upload" | "output";
      workspaceId: string;
      path: string;
      project?: string;
      filename?: string;
      contentType?: string;
    }
  | {
      kind: "runtime_artifact";
      artifact: RuntimeCallArtifact;
    };

export type PiHeaderValue = string | null;

export interface PiResolvedModelReference {
  provider: string;
  modelId: string;
  api?: string;
  hostedGatewayProvider: string;
  hostedModelId?: string;
  /** True only when the hosted route can reach the thread-affine RTX router. */
  hostedStickyRouting?: boolean;
  /** False for hosted-only camelAI routes that must not be served by BYOK keys. */
  byokAllowed?: boolean;
  hostedRequestProfile?: {
    name: "deepseek-v4-flash-rtx";
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    supportsReasoningEffort?: boolean;
    thinkingFormat?: "openai";
  };
  // Reasoning effort to force on the hosted (AI Gateway) model. The gateway
  // provider reports supportsReasoningEffort=false in pi-ai, so without this
  // reasoning_effort is never sent and the route uses its upstream default.
  hostedReasoningEffort?: string;
}

export interface CloudflareEmailSender {
  send(message: {
    to: string | string[];
    from: string | { email: string; name: string };
    subject: string;
    html?: string;
    text?: string;
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string | { email: string; name: string };
    headers?: Record<string, string>;
    attachments?: Array<{
      content: string | ArrayBuffer;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
  }): Promise<{ messageId?: string }>;
}

export interface ChatEnv extends WorkspaceFilesystemEnv {
  // Main app static assets. Notebook deploys read the pre-built renderer SPA
  // from /notebook-renderer/ to synthesize published-notebook workers.
  ASSETS?: Fetcher;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  USER: DurableObjectNamespace<UserDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  DETERMINISTIC_AUTOMATION_WORKFLOWS?: Workflow;
  WORKER_LOGS?: DurableObjectNamespace<WorkerLogsDO>;
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<import("../project-build-sandbox.js").ProjectBuildSandbox>;
  MCP_OBJECT: DurableObjectNamespace;
  APP_KV: KVNamespace;
  R2_BUCKET: R2Bucket;
  IMAGES?: ImagesBinding;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_BASE_URL?: string;
  CF_GATEWAY_TOKEN?: string;
  OPENAI_CODEX_PROXY_BASE_URL?: string;
  OPENAI_CODEX_PROXY_TOKEN?: string;
  INTEGRATION_SECRET_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  // E2E determinism: when set, hosted/provider LLM calls are routed to the local
  // record/replay stub (scripts/llm-replay-stub.mjs). Unset in production.
  TEST_LLM_REPLAY_URL?: string;
  SELFHOST_AI_PROVIDER?: string;
  SELFHOST_AI_API_KEY?: string;
  SELFHOST_AI_BASE_URL?: string;
  SELFHOST_AI_MODEL?: string;
  SELFHOST_AI_NAME?: string;
  SELFHOST_AI_AUTH_TYPE?: string;
  SELFHOST_AI_API?: string;
  SELFHOST_AI_AWS_REGION?: string;
  SELFHOST_AGENT_PROMPT_APPEND?: string;
  SELFHOST_AGENT_PROMPT_PREPEND?: string;
  SELFHOST_AGENT_SKILLS_JSON?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
  WORKER_BASE_URL?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
  SESSIONS?: KVNamespace;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  SANDBOX_PROXY_SECRET?: string;
  SANDBOX_DOCKER_PROXY_BASE_URL?: string;
  CODE_MODE_LOADER?: WorkerLoader;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  // Transcript data lake streams (Cloudflare Pipelines -> R2 Data Catalog).
  // Optional everywhere: absent bindings disable export, they never fail a turn.
  TRANSCRIPT_LAKE?: LakeStream<PiMessageLakeRecord>;
  TOOL_CALLS_LAKE?: LakeStream<ToolCallLakeRecord>;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL?: CloudflareEmailSender;
  TELEGRAM_BOT_TOKEN?: string;
  DISCORD_BRIDGE?: import("../discord-types.js").DiscordBridgeFetcher;
  DISCORD_CHANNEL_ENABLED?: string;
  NEXTJS_ENV?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_BASE_URL?: string;
  PARALLEL_API_KEY?: string;
  PARALLEL_BASE_URL?: string;
  EXA_API_KEY?: string;
  EXA_BASE_URL?: string;
  WEB_PROVIDER_ORDER?: string;
  CHIRIDION_WEB_PROVIDER_ORDER?: string;
  APP_DB?: D1Database;
  RUN_AGENT_EVALS?: string;
}

export type ChatAgentEnv = Cloudflare.Env & Omit<ChatEnv, keyof Cloudflare.Env>;

export interface ChatContextState {
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
}

export interface ChatThreadForkState {
  previewTarget: PreviewTarget | null;
  previewTabs: PreviewTarget[];
  previewActiveTabId: string | null;
  previewVersion: number;
  chatContext: ChatContextState | null;
  currentTodos: unknown[];
  contextUsedPercent: number | null;
  usageIsPostCompaction: boolean;
  cachedContextWindowByModel: Record<string, number>;
}

export interface ChatThreadForkStateTarget {
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId?: string | null;
}

// The Agent-state payload synced to the browser. Structure (field set /
// nullability / lastError shape) is fixed in the shared module so the DO and the
// client can't drift; the DO instantiates the generic sub-types with its own
// worker-side types.
export type ChatThreadAgentState = ChatAgentStatePayload<
  PreviewTarget,
  PendingQuestionInfo,
  PendingConnectionSetupPromptData,
  LlmModel
>;

export interface AdminExplorerThreadSummary {
  userMessageCount: number;
  userMessageCountCapped: boolean;
  hasError: boolean;
  errorCount: number;
  lastErrorAt: number | null;
  lastErrorMessage: string | null;
  models: string[];
}

export interface ChatThreadPiCoreForkResult {
  success: boolean;
  messages?: AgentMessage[];
  messageCount?: number;
  error?: string;
  code?: "NO_PI_CORE_MESSAGES" | "TARGET_NOT_FOUND";
}

export interface PiCoreMessageRow {
  idx: number;
  payload: string;
  created_at: number;
}

export interface PiCoreMessageHistoryRepairReport {
  ok: true;
  mode: "dry_run" | "repair";
  persisted: boolean;
  changed: boolean;
  beforeCount: number;
  validBeforeCount: number;
  afterCount: number;
  invalidRows: number;
  repairedCount: number;
  stats: {
    droppedToolResults: number;
    syntheticToolResults: number;
    reorderedAssistantBlocks: number;
  };
}

export type NormalizedTodoStatus = "pending" | "in_progress" | "completed";

export interface NormalizedTodoItem {
  content: string;
  status: NormalizedTodoStatus;
  activeForm: string;
}

export interface ChatUserMessageInput {
  content?: string;
  clientMessageId?: string;
}

export interface InitialUserMessageRequest {
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  messageSource?: string | null;
  message?: string;
  clientMessageId?: string | null;
  automationRun?: {
    workspaceId: string;
    automationId: string;
    runId: string;
  };
}

export interface InitialUserMessageResult {
  status: "accepted" | "busy" | "error";
  error?: string;
}

export interface AgentEvalParsedMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId: string;
  /** Render-history message id this row streams into (uiMetadata stamp);
   * absent on rows committed before stamping shipped. */
  renderMessageId?: string;
  /** User row accepted while its assistant turn was already streaming. */
  sentDuringStreaming?: boolean;
}

export interface AgentEvalSessionRequest extends InitialUserMessageRequest {
  timeoutMs?: number;
}

export interface AgentEvalDeployedApp {
  name: string;
  /** Authoritative app URL (the *.evals.camelai.app host for real eval deploys). */
  url: string;
  isPublic: boolean;
}

export interface AgentEvalSessionResult {
  status: "completed" | "busy" | "error";
  error?: string;
  result?: string;
  events: Array<Record<string, unknown>>;
  messages: AgentEvalParsedMessage[];
  /**
   * Apps the agent deployed during this eval, from the eval deploy registry. Captured
   * directly in the result so the deployed URLs are authoritative regardless of what
   * list_apps/set_preview report. Omitted when no apps were deployed.
   */
  deployedApps?: AgentEvalDeployedApp[];
}

export interface ChannelHistoryEventRequest {
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  channelKind?: string;
  connectionId?: string | null;
  remoteConversationId?: string | null;
  sourceThreadId?: string | null;
  direction?: "inbound" | "outbound";
  text?: string | null;
  providerMessageIds?: Array<string | number | null | undefined>;
  attachmentCount?: number;
  sentAt?: number;
}

export interface ChannelHistoryEventResult {
  status: "appended" | "skipped" | "error";
  error?: string;
}

export interface ChatThreadRuntimeStatus {
  isStreaming: boolean;
  pendingQuestionCount: number;
  oldestPendingQuestion: string | null;
  updatedAt: number | null;
}

export interface CodeModeJavascriptRequest {
  code: string;
  orgId: string;
  workspaceId: string;
  threadId?: string;
  userId?: string;
  toolUseId?: string;
  timeoutMs?: number | null;
  maxOutputCharacters?: number | null;
}

export interface CodeModeJavascriptResult {
  text: string;
}
