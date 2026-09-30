// Shared types for the worker's chat surfaces: the worker env threads run
// with (ChatEnv), a thread's identity (ChatContextState), preview targets, and
// the parsed-message and eval shapes. Pure types only.

import type {
  LakeStream,
  ToolCallLakeRecord,
} from "../lake-streams";
import type { OrgDO, UserDO } from "../auth";
import type { WorkspaceDO } from "../workspace";
import type { WorkspaceCronDO } from "../workspace-cron";
import type { WorkerLogsDO } from "../worker-logs-do";
import type { WorkspaceFilesystemEnv } from "../workspace-filesystem-do";
import type { ChatThreadDO } from "../chat-thread-do";
import type { RuntimeCallArtifact } from "../../../../src/lib/runtime-artifacts";

export type PreviewTarget =
  | {
      kind: "app";
      scriptName: string;
      isPublic: boolean;
    }
  | {
      kind: "file";
      source: "workspace" | "project" | "upload" | "output" | "scratch";
      workspaceId: string;
      path: string;
      project?: string;
      /** The runtime thread whose scratch file this is (source `scratch`). */
      threadId?: string;
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
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<import("../project-build-container.js").ProjectBuildContainer>;
  APP_KV: KVNamespace;
  // Hosted agent runtime: with the tenant's operator token, id and definition
  // set, threads run there, as agents of AGENT_RUNTIME_DEFINITION.
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_TENANT?: string;
  AGENT_RUNTIME_API_TOKEN?: string;
  AGENT_RUNTIME_DEFINITION?: string;
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
  CONNECTIONS_BINDING_ENABLED?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
  WORKER_BASE_URL?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
  SESSIONS?: KVNamespace;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  CODE_MODE_LOADER?: WorkerLoader;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  // Tool-call telemetry stream (Cloudflare Pipelines -> R2 Data Catalog).
  // Optional everywhere: absent bindings disable export, they never fail a turn.
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

export type NormalizedTodoStatus = "pending" | "in_progress" | "completed";

export interface NormalizedTodoItem {
  content: string;
  status: NormalizedTodoStatus;
  activeForm: string;
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
    /** New scheduled runs must explicitly report their business outcome. */
    requiresExplicitOutcome?: boolean;
  };
}

export interface InitialUserMessageResult {
  /** "moved": the thread runs on the agent runtime now; the caller sends it there. */
  status: "accepted" | "busy" | "error" | "moved";
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
  /** Compaction summary rows are model-facing only; omitted from UI derive. */
  isCompactSummary?: boolean;
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

