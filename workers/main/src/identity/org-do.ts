import { DurableObject } from "cloudflare:workers";
import type { DOEnv } from "./env";
import {
  WorkspaceDO,
  type WorkspaceIntegrationAuthStatus,
  type WorkspaceIntegrationRecord,
} from "../workspace";
import { decryptCredentials, encryptCredentials } from "../../../../src/lib/integration-crypto";
import {
  type OpenAiSubscriptionCredentials,
  refreshOpenAiSubscriptionCredentials,
} from "../../../../src/lib/openai-subscription.server";
import { mintBigQueryAccessTokenFromServiceAccount } from "../google-service-account";
import { refreshRemoteMcpOAuthToken } from "../remote-mcp-oauth";
import {
  generateDefaultAvatar,
  validateAvatarContent,
} from "../../../../src/lib/avatar";
import { DEFAULT_THREAD_TITLE } from "../../../../src/lib/thread-title";
import {
  normalizeChannelIndicatorKind,
  type ChannelIndicatorKind,
} from "../../../../src/lib/channel-kinds";
import {
  normalizeThreadCompletionSummary,
  normalizeThreadUserMessageText,
} from "../../../../src/lib/thread-preview";
import {
  appendToThreadAskLog,
  normalizeThreadSearchTitle,
  parseThreadSearchTerms,
  THREAD_ASK_LOG_MAX_BYTES,
  THREAD_SEARCH_FIELD_MAX_CHARS,
} from "../../../../src/lib/thread-search";
import { slugifyWorkspaceName } from "../../../../src/lib/workspace-email";
import type {
  OrgRole,
  BillingStatus,
  User,
  Organization,
  Workspace,
  WorkspaceAccessLevel,
  WorkspaceWithAccess,
  LlmModel,
  OrgModelPickerConfig,
  OnboardingPreferences,
  ThreadCompletionSummaryStatus,
} from "../../../../src/types";
import {
  DEFAULT_LLM_MODEL,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  isLlmModel,
  normalizeLlmModel,
  resolveStoredLlmModel,
  type LlmProviderConfigRecord,
} from "../../../../src/lib/llm-provider-config";
import {
  defaultOrgModelPickerConfig,
  parseOrgModelPickerConfig,
} from "../../../../src/lib/model-picker-config";
import {
  getBillingPlanLimits,
  getOrgSeatLimit,
} from "../../../../src/lib/billing-plans";
import { calculateEffectiveUsageCostUsd } from "../../../../src/lib/usage-pricing";
import {
  getCapabilityAllowancePolicy,
  isHostedCapability,
  nextUtcDayStart,
  utcDayKey,
  type HostedCapability,
} from "../../../../src/lib/capability-allowances";
import { dispatchAdminEvent } from "./admin-events";
import { normalizeOrgBillingFields } from "./billing-state";
import { recordErrorEvent, recordObservabilityEvent } from "../observability";
import { SCRIPT_PREFIX } from "../types";
import {
  buildChatErrorEventPayload,
  mergeModelHistory,
  parseModelHistory,
} from "../chat-error-metadata";
import { ORG_SLUG_KV_PREFIX, generateUniqueOrgSlug, hashOrgSlug, registerOrgSlug } from "./org-slugs";
import {
  ORG_SSO_CONFIG_KEY,
  type OrgSsoConnectionTest,
  type OrgSsoConfig,
  type OrgSsoTransaction,
} from "../org-sso.js";
import { normalizeThreadCompletionSummaryStatus } from "./thread-summary";
import { usageCost, usageInteger, usageText } from "./usage";
import { generateEmailHandle } from "../../../../src/lib/workspace-email";
import type { EmailHandleDO } from "../email-handle-registry";
import type { WorkspaceIntegrationDefinitionRecord } from "../../../../src/lib/integration-definition";
import {
  getCustomDomain as getOrgCustomDomain,
  removeCustomDomain as removeOrgCustomDomain,
  setCustomDomain as setOrgCustomDomain,
  updateCustomDomainStatus as updateOrgCustomDomainStatus,
  type CustomDomain,
  type CustomDomainStatus,
} from "./org/custom-domains";
import {
  OrgUsageControls,
  UsageControlsValidationError,
  normalizeUsageKind,
  normalizeUsageSurface,
  type CheckUserLlmUsageAccessInput,
  type LlmModelPricingInput,
  type LlmPricingResponse,
  type UsageAggregateQuery,
  type UsageAggregateResult,
  type UsageCostSource,
  type UsageKind,
  type UsageSurface,
  type UserLlmUsageAccessResult,
  type UserLlmUsageLimitInput,
  type UserLlmUsageReport,
  type UserLlmUsageReportQuery,
} from "./org/usage-controls";

// Re-export for consumers that import from this module
export type { OrgRole, BillingStatus } from "../../../../src/types";
export type {
  CheckUserLlmUsageAccessInput,
  LlmModelPricingInput,
  LlmPricingResponse,
  UsageAggregateQuery,
  UsageAggregateResult,
  UsageCostSource,
  UsageKind,
  UsageSurface,
  UserLlmUsageAccessResult,
  UserLlmUsageLimit,
  UserLlmUsageLimitInput,
  UserLlmUsageReport,
  UserLlmUsageReportQuery,
} from "./org/usage-controls";

const ORG_MODEL_PICKER_CONFIG_KEY = "model_picker_config";
const ORG_INDEX_PREFIX = "org_index:";
const WORKSPACE_ORG_INDEX_PREFIX = "workspace_org:";
const CUSTOM_DOMAIN_HOST_PREFIX = "custom_domain_host:";
const BIGQUERY_INTEGRATION_TYPE = "bigquery";
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_BATCH_WINDOW_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_FALLBACK_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_RETRY_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_RETRY_MIN_MS = 30 * 1000;
const TOKEN_REFRESH_RETRY_MAX_MS = 60 * 60 * 1000;
const TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS = 2 * 60 * 1000;
const THREAD_SEARCH_BACKFILL_BATCH_SIZE = 25;
const THREAD_SEARCH_BACKFILL_CURSOR_KEY = "threadSearchBackfillCursor:v46";
const THREAD_SEARCH_BACKFILL_COMPLETE_KEY = "threadSearchBackfillComplete:v46";
// RPC/list projection intentionally omits the bounded prompt log. Search
// pagination opts into it only long enough for the server wrapper to build a
// snippet, then drops it before browser serialization.
const THREAD_LIST_SELECT_COLUMN_NAMES = [
  "id",
  "workspace_id",
  "title",
  "created_by",
  "model",
  "created_at",
  "updated_at",
  "user_message_count",
  "first_user_message",
  "last_user_message",
  "last_user_message_at",
  "last_assistant_completed_at",
  "last_assistant_summary",
  "last_assistant_summary_status",
  "source",
  "channel_kind",
  "channel_kinds",
  "channel_connection_id",
  "channel_conversation_id",
  "channel_message_id",
  "chat_error_count",
  "last_chat_error_at",
  "last_chat_error_message",
  "last_chat_error_source",
  "last_chat_error_status",
  "last_chat_error_provider",
  "last_chat_error_model",
  "model_history",
  "last_model_changed_at",
] as const;
const THREAD_LIST_SELECT_COLUMNS = THREAD_LIST_SELECT_COLUMN_NAMES.join(", ");
const BOUNDED_SEARCH_PROJECTION_COLUMNS: Readonly<Record<string, true>> =
  Object.freeze({
    title: true,
    first_user_message: true,
    last_user_message: true,
    last_assistant_summary: true,
  });
const boundedThreadSearchExpression = (column: string): string =>
  `substr(${column}, 1, ${THREAD_SEARCH_FIELD_MAX_CHARS})`;
const THREAD_SEARCH_SELECT_COLUMNS = [
  ...THREAD_LIST_SELECT_COLUMN_NAMES.map((column) =>
    BOUNDED_SEARCH_PROJECTION_COLUMNS[column] === true
      ? `${boundedThreadSearchExpression(column)} AS ${column}`
      : column,
  ),
  `${boundedThreadSearchExpression("user_ask_log")} AS user_ask_log`,
].join(", ");
const THREAD_INTERNAL_ASK_LOG_SELECT_COLUMNS =
  `${THREAD_LIST_SELECT_COLUMNS}, user_ask_log`;
const SEARCHABLE_THREAD_EXPRESSIONS = [
  boundedThreadSearchExpression("title_search"),
  boundedThreadSearchExpression("first_user_message"),
  boundedThreadSearchExpression("last_user_message"),
  boundedThreadSearchExpression("user_ask_log"),
  boundedThreadSearchExpression("last_assistant_summary"),
] as const;

function appendThreadSearchClauses(
  whereClauses: string[],
  whereParams: Array<string | number>,
  searchQuery: string | undefined,
): boolean {
  const terms = parseThreadSearchTerms(searchQuery);
  for (const term of terms) {
    const escapedTerm = term.replace(/([\\%_])/g, "\\$1");
    const titleLike = `%${term.toLowerCase().replace(/([\\%_])/g, "\\$1")}%`;
    const like = `%${escapedTerm}%`;
    whereClauses.push(
      `(${SEARCHABLE_THREAD_EXPRESSIONS.map((expression) => `${expression} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
    );
    whereParams.push(titleLike);
    for (let index = 1; index < SEARCHABLE_THREAD_EXPRESSIONS.length; index += 1) {
      whereParams.push(like);
    }
  }
  return terms.length > 0;
}

class PermanentRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentRefreshError";
  }
}

class RetryableRefreshError extends Error {
  retryAtMs: number;

  constructor(message: string, retryAtMs: number) {
    super(message);
    this.name = "RetryableRefreshError";
    this.retryAtMs = retryAtMs;
  }
}

function parseRetryAfterToRetryAtMs(retryAfterHeader: string | null, nowMs: number): number | null {
  if (!retryAfterHeader) return null;
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + Math.floor(seconds * 1000);
  const absolute = Date.parse(trimmed);
  return Number.isFinite(absolute) ? absolute : null;
}

function clampRetryAtMs(retryAtMs: number, nowMs: number): number {
  const min = nowMs + TOKEN_REFRESH_RETRY_MIN_MS;
  const max = nowMs + TOKEN_REFRESH_RETRY_MAX_MS;
  return Math.max(min, Math.min(max, Math.floor(retryAtMs)));
}

function normalizeThreadModelForStorage(model: LlmModel | undefined): LlmModel {
  // Provider-specific models have already been validated by the caller. Do not
  // normalize them without provider context here: that would collapse Bedrock
  // model ids (and the custom marker) back to the platform Sonnet default.
  if (isLlmModel(model)) {
    return model;
  }
  return normalizeLlmModel(model);
}

function parseThreadChannelKinds(
  value: string | null | undefined,
): ChannelIndicatorKind[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const kinds: ChannelIndicatorKind[] = [];
    for (const entry of parsed) {
      const kind = normalizeChannelIndicatorKind(
        typeof entry === "string" ? entry : null,
      );
      if (kind && !kinds.includes(kind)) {
        kinds.push(kind);
      }
    }
    return kinds;
  } catch {
    return [];
  }
}

function mergeThreadChannelKinds(
  existingJson: string | null | undefined,
  source: string | null | undefined,
): string | null {
  const kind = normalizeChannelIndicatorKind(source);
  if (!kind) return null;
  const existing = parseThreadChannelKinds(existingJson);
  if (existing.includes(kind)) return null;
  return JSON.stringify([...existing, kind]);
}

export interface UserOrg {
  org_id: string;
  role: OrgRole;
  joined_at: number;
  last_workspace_id: string | null;
}

export interface UserAuthBootstrap {
  profile: User | null;
  onboarding: OnboardingPreferences | null;
  orgs: UserOrg[];
  emailVerification: { required: boolean; verified: boolean };
  /** Timestamp when all sessions were invalidated (e.g. on logout). Null if never invalidated. */
  sessionInvalidatedAt: number | null;
}

export type OAuthProvider = "google" | "github" | "cloudflare_access";

export interface UserOAuthProvider {
  provider: OAuthProvider;
  provider_id: string;
  linked_at: number;
}

export interface OrgMember {
  user_id: string;
  role: OrgRole;
  joined_at: number;
  workspace_access_default: WorkspaceAccessLevel;
}

export interface OrgAuthContextBootstrap {
  info: Organization | null;
  member: OrgMember | null;
  workspaces: WorkspaceWithAccess[];
  llmProviderConfig: LlmProviderConfigRecord | null;
}

export interface OrgWorkspaceAccessRow {
  workspace_id: string;
  user_id: string;
  access_level: WorkspaceAccessLevel;
  granted_by: string;
  granted_at: number;
}

export interface OrgProviderContext {
  info: Organization | null;
  llmProviderConfig: LlmProviderConfigRecord | null;
}

export interface OrgOnboardingWelcomeContext extends OrgProviderContext {
  memberCount: number;
  appCount: number;
  integrations: string[];
}

export interface OrgWorkspaceSummaryCounts {
  workspaceId: string;
  memberCount: number;
  publishedApps: number;
}

export interface OrgThreadWithOrgSlug {
  thread: OrgThread | null;
  orgSlug: string | null;
}

export interface OrgSettingsSummary {
  name: string;
  archived: boolean;
  billing_plan: Organization["billing_plan"];
  billing_status: BillingStatus;
  member_count: number;
  workspace_count: number;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
  workspace_access?: Record<string, "full" | "none"> | null;
}

export interface OrgIntegrationRecord {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string;
  credentials_encrypted: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export type WorkerScriptPreviewStatus = "pending" | "ready" | "failed";

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: WorkerScriptPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
  project_id: string | null;
  commit_sha: string | null;
  artifact_cache_key: string | null;
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export interface WorkerScriptDeployVersion {
  [key: string]: string | number | null;
  id: string;
  script_name: string;
  workspace_id: string;
  created_at: number;
  created_by: string;
  config_path: string | null;
  project_id: string | null;
  commit_sha: string | null;
  artifact_cache_key: string | null;
}

export interface WorkerScriptPreviewUpdateInput {
  status: WorkerScriptPreviewStatus;
  preview_key?: string | null;
  preview_error?: string | null;
  preview_updated_at?: number;
  deploy_ts?: number;
}

export interface WorkerScriptPreviewUpdateResult {
  script: WorkerScript | null;
  updated: boolean;
  stale: boolean;
}

type OrgWorkspaceInfoRow = {
  id: string;
  name: string;
  created_at: number;
  archived: number;
  description?: string | null;
  created_by?: string | null;
  avatar_color?: string | null;
  avatar_content?: string | null;
  archived_at?: number | null;
  archived_by?: string | null;
  compute_tier?: Workspace["compute_tier"] | string | null;
  email_handle?: string | null;
};

export interface WorkerScriptCustomDomainUpdateInput {
  hostname: string | null;
  cf_hostname_id?: string | null;
  status?: string | null;
  ssl_status?: string | null;
  error?: string | null;
  updated_at?: number;
  deploy_ts?: number;
}

interface WorkerScriptRow {
  [key: string]: SqlStorageValue;
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: number;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: WorkerScriptPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
  project_id: string | null;
  commit_sha: string | null;
  artifact_cache_key: string | null;
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

export interface OrgThread {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string;
  model: LlmModel;
  created_at: number;
  updated_at: number;
  user_message_count: number;
  first_user_message: string | null;
  last_user_message: string | null;
  user_ask_log?: string | null;
  last_user_message_at: number | null;
  last_assistant_completed_at: number | null;
  last_assistant_summary: string | null;
  last_assistant_summary_status: ThreadCompletionSummaryStatus | null;
  source: string;
  channel_kind: string | null;
  channel_kinds: string | null;
  channel_connection_id: string | null;
  channel_conversation_id: string | null;
  channel_message_id: string | null;
  chat_error_count: number;
  last_chat_error_at: number | null;
  last_chat_error_message: string | null;
  last_chat_error_source: string | null;
  last_chat_error_status: number | null;
  last_chat_error_provider: string | null;
  last_chat_error_model: string | null;
  model_history: string | null;
  last_model_changed_at: number | null;
}

function withoutThreadAskLog(
  thread: OrgThread,
): Omit<OrgThread, "user_ask_log"> {
  const { user_ask_log: _omitted, ...threadWithoutAskLog } = thread;
  return threadWithoutAskLog;
}

function toAdminThreadPayload(
  thread: OrgThread,
  orgId: string,
): Omit<OrgThread, "user_ask_log"> & { org_id: string } {
  return { ...withoutThreadAskLog(thread), org_id: orgId };
}

export interface CreateThreadOptions {
  source?: "web" | "channel" | string | null;
  channelKind?: string | null;
  channelConnectionId?: string | null;
  channelConversationId?: string | null;
  channelMessageId?: string | null;
}

export interface RecordThreadErrorInput {
  message: string;
  source?: string | null;
  errorKind?: string | null;
  status?: number | null;
  provider?: string | null;
  model?: string | null;
  userId?: string | null;
  createdAt?: number | null;
}

export type OrgChatThreadAccessResult =
  | {
      ok: true;
      orgId: string;
      orgSlug: string;
      threadId: string;
    }
  | {
      ok: false;
      reason: "org_not_found" | "forbidden" | "thread_not_found";
    };

export type OrgChatWebSocketAccessResult =
  | {
      ok: true;
      orgId: string;
      orgSlug: string;
      workspaceId: string;
      threadId: string;
    }
  | {
      ok: false;
      reason:
        | "org_not_found"
        | "workspace_not_found"
        | "forbidden"
        | "thread_not_found";
    };

export interface ProxyUsageInput {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface UsageRecordInput {
  workspace_id?: string | null;
  user_id?: string | null;
  thread_id?: string | null;
  model: string;
  provider: string;
  billing_source?: string | null;
  credit_chargeable?: boolean | number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  reported_cost_usd?: number | null;
  upstream_inference_cost_usd?: number | null;
  usage_kind?: UsageKind;
  usage_surface?: UsageSurface;
  duration_ms?: number | null;
  created_at_ms?: number | null;
  source?: string | null;
  source_id?: string | null;
}

export interface ConsumeCapabilityAllowanceInput {
  capability: HostedCapability;
  user_id?: string | null;
  idempotency_key?: string | null;
  now_ms?: number | null;
}

export interface CapabilityAllowanceResult {
  allowed: boolean;
  capability: HostedCapability;
  daily_limit: number | null;
  used: number;
  remaining: number | null;
  reset_at_ms: number;
}

export interface UsageLogQuery {
  limit?: number | null;
  cursor?: string | null;
  from?: number | null;
  to?: number | null;
  chargeable_only?: boolean | number | null;
  user_id?: string | null;
  provider?: string | null;
  model?: string | null;
  usage_kind?: UsageKind | null;
  usage_surface?: UsageSurface | null;
}

export interface UsageLogEntry {
  [key: string]: SqlStorageValue;
  id: number;
  workspace_id: string;
  user_id: string;
  thread_id: string;
  model: string;
  provider: string;
  billing_source: string;
  credit_chargeable: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  metered_cost_microusd: number | null;
  metered_cost_usd: number | null;
  cost_source: UsageCostSource;
  usage_kind: UsageKind;
  usage_surface: UsageSurface;
  duration_ms: number;
  created_at_ms: number;
  source: string;
  source_id: string;
}

export interface UsageLogPage {
  org_id: string;
  entries: UsageLogEntry[];
  count: number;
  has_more: boolean;
  next_cursor: string | null;
}

export interface UsageLogSum {
  org_id: string;
  total_cost_usd: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_input_tokens: number;
  total_cache_read_input_tokens: number;
}

export interface OrgUsageSpend {
  org_id: string;
  total_cost_usd: number;
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_input_tokens: number;
  total_cache_read_input_tokens: number;
  windows: Array<{
    label: string;
    window_ms: number;
    limit_usd: number;
    spent_usd: number;
    exceeded: boolean;
  }>;
}

export interface OrgUsageLimits {
  org_id: string;
  limits: Array<{
    window_hours: number;
    limit_usd: number;
    label?: string;
  }>;
}

export interface OrgBillingStateUpdate {
  billing_status?: BillingStatus;
  billing_plan?: Organization["billing_plan"];
  billing_seat_count?: number;
  billing_customer_id?: string | null;
  billing_subscription_id?: string | null;
  billing_subscription_status?: string | null;
  billing_trial_started_at?: number | null;
  billing_trial_ends_at?: number | null;
  billing_credit_purchase_total_cents?: number;
  billing_credit_grant_total_cents?: number;
  billing_trial_credit_grant_cents?: number;
  billing_trial_credit_granted_at?: number | null;
  billing_free_credit_grant_cents?: number;
  billing_free_credit_granted_at?: number | null;
  billing_last_included_credit_invoice_id?: string | null;
  billing_credit_usage_started_at?: number | null;
}

export interface SyncSubscriptionBillingStateResult {
  org: Organization;
  trialCreditGranted: boolean;
  capacityInvariantError?: string | null;
}

export interface ApplyCreditCheckoutResult {
  org: Organization;
  applied: boolean;
}

export interface SubscriptionInvoiceGrantCommand {
  invoiceId: string;
  subscriptionId: string;
  customerId: string;
  billingReason: "subscription_create" | "subscription_cycle" | "subscription_update";
  source: "initial" | "renewal" | "plan_change" | "legacy_migration";
  plan: "starter" | "pro" | "team";
  seatCount: number;
  grantCents: number;
}

export interface ApplySubscriptionInvoiceGrantResult {
  org: Organization;
  applied: boolean;
  credited: boolean;
  legacyProcessed: boolean;
  invariantError: string | null;
}

export interface SubscriptionInvoiceGrantRow extends Record<string, SqlStorageValue> {
  invoice_id: string;
  subscription_id: string;
  customer_id: string;
  billing_reason: string;
  source: string;
  plan: string;
  seat_count: number;
  amount_cents: number;
  created_at: number;
}

export interface ManualCreditGrantRecord {
  grant_id: string;
  amount_cents: number;
  reason: string | null;
  created_at: number;
  created_by: string | null;
  source: string | null;
}

type ManualCreditGrantRow = ManualCreditGrantRecord &
  Record<string, SqlStorageValue>;

export interface ApplyManualCreditGrantResult {
  org: Organization;
  applied: boolean;
  grantId: string;
  amountCents: number;
  reason: string | null;
  createdAt: number;
  createdBy: string | null;
  source: string | null;
}

export interface OrgSsoIdentityRecord {
  userId: string;
  email: string;
  tenantScoped: boolean;
  membershipRevoked: boolean;
}

/**
 * Migration Pattern for Durable Objects
 * ======================================
 *
 * Schema version is tracked in sync KV (`ctx.storage.kv`) under key `schemaVersion`.
 * Existing DOs fall back to the legacy `_schema_version` SQL table on first load,
 * then persist the version to KV going forward.
 *
 * To add a new migration:
 * 1. Add a new `if (version < N)` block in the `migrate()` method
 * 2. Put your schema changes inside the block
 * 3. Bump `CURRENT_SCHEMA_VERSION` at the bottom of `migrate()`
 */

// User Durable Object - one per user
export class OrgDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;
  private usageControlsInstance?: OrgUsageControls;
  private workerScriptsHasPreviewColumns = true;
  private static readonly LEGACY_HOST_USAGE_BACKFILL_STATUS_KEY =
    "legacyHostUsageBackfillStatus";
  private static readonly LEGACY_HOST_USAGE_BACKFILL_STARTED_AT_KEY =
    "legacyHostUsageBackfillStartedAt";
  private static readonly LEGACY_HOST_USAGE_BACKFILL_COMPLETED_AT_KEY =
    "legacyHostUsageBackfillCompletedAt";
  private static readonly LEGACY_HOST_USAGE_BACKFILL_RESULT_KEY =
    "legacyHostUsageBackfillResult";
  private static readonly LEGACY_HOST_USAGE_BACKFILL_ERROR_KEY =
    "legacyHostUsageBackfillError";
  private static readonly ACCESS_MAPPED_ORG_ID_KEY = "accessMappedOrgId";
  private static readonly WORKSPACE_ACCESS_MIGRATION_PREFIX =
    "workspaceTenantDataMigrated:access:";
  private static readonly WORKSPACE_INTEGRATIONS_MIGRATION_PREFIX =
    "workspaceTenantDataMigrated:integrations:";
  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private get usageControls(): OrgUsageControls {
    return (this.usageControlsInstance ??= new OrgUsageControls({
      sql: this.sql,
      orgId: () => this.getInfoSync()?.id ?? "",
      isCurrentMember: (userId) =>
        this.sql.exec("SELECT 1 FROM members WHERE user_id = ?", userId).toArray().length > 0,
      transactionSync: (callback) => this.ctx.storage.transactionSync(callback),
    }));
  }

  private getOrgIndexKey(orgId: string): string {
    return `${ORG_INDEX_PREFIX}${orgId}`;
  }

  private getWorkspaceOrgIndexKey(workspaceId: string): string {
    return `${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`;
  }

  private async indexOrg(orgId: string): Promise<void> {
    await this.env.APP_KV.put(this.getOrgIndexKey(orgId), "1");
  }

  private async unindexOrg(orgId: string): Promise<void> {
    await this.env.APP_KV.delete(this.getOrgIndexKey(orgId));
  }

  async indexWorkspace(workspaceId: string): Promise<void> {
    const orgId = this.getInfoSync()?.id;
    if (!orgId) return;
    await this.env.APP_KV.put(this.getWorkspaceOrgIndexKey(workspaceId), orgId);
  }

  async unindexWorkspace(workspaceId: string): Promise<void> {
    await this.env.APP_KV.delete(this.getWorkspaceOrgIndexKey(workspaceId));
  }

  static workspaceOrgIndexKey(workspaceId: string): string {
    return `${WORKSPACE_ORG_INDEX_PREFIX}${workspaceId}`;
  }

  private getActiveWorkspaceIntegrationCount(workspaceId: string): number {
    try {
      const rawCount = this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM integrations WHERE workspace_id = ? AND deleted_at IS NULL",
          workspaceId,
        )
        .next().value?.count;
      const count = typeof rawCount === "number" ? rawCount : Number(rawCount ?? 0);
      return Number.isFinite(count) ? count : 0;
    } catch {
      return 0;
    }
  }

  private dispatchWorkspaceUpsert(info: Workspace): void {
    dispatchAdminEvent(this.ctx, this.env, {
      type: "workspace_upsert",
      payload: {
        ...info,
        integration_count: this.getActiveWorkspaceIntegrationCount(info.id),
      },
    });
  }

  private async syncWorkspaceInfoToWorkspaceDO(info: Workspace): Promise<void> {
    try {
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(info.id),
      ) as unknown as {
        syncWorkspaceInfoFromOrg(info: Workspace): Promise<void>;
      };
      await workspaceStub.syncWorkspaceInfoFromOrg(info);
    } catch (error) {
      console.warn("[OrgDO] failed to mirror workspace metadata to WorkspaceDO", {
        workspaceId: info.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async disableScheduledPromptsForWorkspace(
    workspaceId: string,
    reason: string,
  ): Promise<void> {
    if (!this.env.WORKSPACE_CRON) return;
    try {
      const schedulerStub = this.env.WORKSPACE_CRON.get(
        this.env.WORKSPACE_CRON.idFromName(workspaceId),
      ) as unknown as {
        disableAllScheduledPrompts(
          workspaceId: string,
          reason: string,
        ): Promise<void>;
      };
      await schedulerStub.disableAllScheduledPrompts(workspaceId, reason);
    } catch (error) {
      console.warn("[OrgDO] Failed to disable workspace scheduled prompts", {
        workspaceId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private migrate() {
    // Read version from sync KV, falling back to legacy SQL table for existing DOs.
    let version = this.ctx.storage.kv.get<number>("schemaVersion") ?? null;
    if (version === null) {
      try {
        const rows = this.sql
          .exec<{
            version: number;
          }>("SELECT MAX(version) AS version FROM _schema_version")
          .toArray();
        version = rows[0]?.version ?? 0;
      } catch {
        version = 0;
      }
    }

    // Repair columns before version-gated migrations read from them. Some
    // legacy objects were stamped at a newer version despite missing columns.
    this.ensureThreadSchemaColumns();

    if (version < 1) {
      // V1: Fresh start
      this.sql.exec("DROP TABLE IF EXISTS org_info");
      this.sql.exec("DROP TABLE IF EXISTS members");
      this.sql.exec("DROP TABLE IF EXISTS invitations");
      this.sql.exec("DROP TABLE IF EXISTS integrations");
      this.sql.exec("DROP TABLE IF EXISTS workspaces");
      this.sql.exec("DROP TABLE IF EXISTS audit_log");
      this.sql.exec(`
        CREATE TABLE org_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          workspace_access_default TEXT NOT NULL DEFAULT 'full'
        )
      `);
      this.sql.exec(`
        CREATE TABLE invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE integrations (
          id TEXT PRIMARY KEY,
          integration_type TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          config TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 2) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          description TEXT,
          created_by TEXT,
          avatar_color TEXT,
          avatar_content TEXT,
          archived_at INTEGER,
          archived_by TEXT,
          compute_tier TEXT NOT NULL DEFAULT 'standard',
          email_handle TEXT
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      const rows = this.sql
        .exec("SELECT value FROM org_info WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const info = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as Organization;
        normalizeOrgBillingFields(info);
        if (info.billing_customer_id === undefined)
          info.billing_customer_id = null;
        if (info.billing_subscription_id === undefined)
          info.billing_subscription_id = null;
        if (info.billing_subscription_status === undefined)
          info.billing_subscription_status = null;
        if (info.billing_trial_started_at === undefined)
          info.billing_trial_started_at = null;
        if (info.billing_trial_ends_at === undefined)
          info.billing_trial_ends_at = null;
        if (typeof info.billing_credit_purchase_total_cents !== "number") {
          info.billing_credit_purchase_total_cents = 0;
        }
        if (typeof info.billing_credit_grant_total_cents !== "number") {
          info.billing_credit_grant_total_cents = 0;
        }
        if (typeof info.billing_trial_credit_grant_cents !== "number") {
          info.billing_trial_credit_grant_cents = 0;
        }
        if (info.billing_trial_credit_granted_at === undefined) {
          info.billing_trial_credit_granted_at = null;
        }
        if (typeof info.billing_free_credit_grant_cents !== "number") {
          info.billing_free_credit_grant_cents = 0;
        }
        if (info.billing_free_credit_granted_at === undefined) {
          info.billing_free_credit_granted_at = null;
        }
        if (info.billing_last_included_credit_invoice_id === undefined) {
          info.billing_last_included_credit_invoice_id = null;
        }
        if (info.billing_credit_usage_started_at === undefined) {
          info.billing_credit_usage_started_at = null;
        }
        if (typeof info.archived !== "boolean") info.archived = false;
        if (info.archived_at === undefined) info.archived_at = null;
        if (info.archived_by === undefined) info.archived_by = null;
        this.sql.exec(
          "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
          "data",
          JSON.stringify(info),
        );
      }
    }

    if (version < 3) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS worker_scripts (
          script_name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS worker_scripts_workspace_id ON worker_scripts(workspace_id)",
      );
    }

    if (version < 4) {
      // V4: Add is_public column to worker_scripts (default false = private)
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
        );
      } catch {
        // Column may already exist in fresh databases that ran V3 after this migration was added
      }
    }

    if (version < 5) {
      // V5: Add threads table (consolidated from ChatIndexDO)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          channel_kinds TEXT,
          last_user_message TEXT,
          last_user_message_at INTEGER,
          last_assistant_completed_at INTEGER,
          last_assistant_summary TEXT,
          last_assistant_summary_status TEXT,
          chat_error_count INTEGER NOT NULL DEFAULT 0,
          last_chat_error_at INTEGER,
          last_chat_error_message TEXT,
          last_chat_error_source TEXT,
          last_chat_error_status INTEGER,
          last_chat_error_provider TEXT,
          last_chat_error_model TEXT,
          model_history TEXT,
          last_model_changed_at INTEGER
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_workspace_id ON threads(workspace_id)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS thread_error_events (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 6) {
      // V6: Ensure audit_log table exists (fix for DOs that may have skipped V2 migration)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 7) {
      // V7: Add preview metadata fields to worker_scripts
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN preview_key TEXT");
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_updated_at INTEGER",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_status TEXT DEFAULT 'pending'",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_error TEXT",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "UPDATE worker_scripts SET preview_status = 'pending' WHERE preview_status IS NULL",
        );
      } catch {
        // Skip update if columns are unavailable (fallback queries will handle nulls)
      }
    }

    if (version < 8) {
      // V8: Proxy usage rollups per user
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS proxy_usage (
          user_id TEXT PRIMARY KEY,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          last_provider TEXT,
          last_model TEXT,
          last_token_id TEXT,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 9) {
      // V9: Schema consistency fix - ensure all tables and columns exist
      // This fixes DOs that may have skipped migrations due to version conflicts

      // Ensure all core tables exist
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS org_info (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          user_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          workspace_access_default TEXT NOT NULL DEFAULT 'full'
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          role TEXT NOT NULL,
          invited_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS integrations (
          id TEXT PRIMARY KEY,
          integration_type TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          auth_method TEXT NOT NULL,
          config TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS workspace_memberships (
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          access_level TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          granted_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, user_id)
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user ON workspace_memberships(user_id)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          target_id TEXT,
          details TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS worker_scripts (
          script_name TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS worker_scripts_workspace_id ON worker_scripts(workspace_id)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          channel_kinds TEXT,
          last_user_message TEXT,
          last_user_message_at INTEGER,
          last_assistant_completed_at INTEGER,
          last_assistant_summary TEXT,
          last_assistant_summary_status TEXT,
          chat_error_count INTEGER NOT NULL DEFAULT 0,
          last_chat_error_at INTEGER,
          last_chat_error_message TEXT,
          last_chat_error_source TEXT,
          last_chat_error_status INTEGER,
          last_chat_error_provider TEXT,
          last_chat_error_model TEXT,
          model_history TEXT,
          last_model_changed_at INTEGER
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_workspace_id ON threads(workspace_id)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS threads_updated_at ON threads(updated_at)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS thread_error_events (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS proxy_usage (
          user_id TEXT PRIMARY KEY,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          requests INTEGER NOT NULL DEFAULT 0,
          last_provider TEXT,
          last_model TEXT,
          last_token_id TEXT,
          updated_at INTEGER NOT NULL
        )
      `);

      // Ensure all columns exist on worker_scripts
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN preview_key TEXT");
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_updated_at INTEGER",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_status TEXT DEFAULT 'pending'",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN preview_error TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_hostname TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_cf_hostname_id TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_status TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_ssl_status TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_error TEXT",
        );
      } catch {
        // Column already exists
      }
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_updated_at INTEGER",
        );
      } catch {
        // Column already exists
      }
    }

    if (version < 11) {
      // V11: Add config_path column to worker_scripts for tracking source directory
      try {
        this.sql.exec("ALTER TABLE worker_scripts ADD COLUMN config_path TEXT");
      } catch {
        // Column may already exist
      }
    }

    if (version < 12) {
      // V12: Slug backfill for existing orgs (already ran; new orgs get hash slugs via getInfo fallback)
    }

    if (version < 13) {
      // V13: Add workspace_access to invitations for pre-acceptance assignment,
      // and user_message_count to threads for admin visibility
      try {
        this.sql.exec(
          "ALTER TABLE invitations ADD COLUMN workspace_access TEXT",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "ALTER TABLE threads ADD COLUMN user_message_count INTEGER NOT NULL DEFAULT 0",
        );
      } catch {
        // Column may already exist
      }
    }

    if (version < 14) {
      // V14: Add first_user_message to threads for welcome screen preview
      try {
        this.sql.exec("ALTER TABLE threads ADD COLUMN first_user_message TEXT");
      } catch {
        // Column may already exist
      }
    }

    if (version < 15) {
      // V15: Add source column to threads (legacy; runtime treats all sources uniformly)
      try {
        this.sql.exec(
          "ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'web'",
        );
      } catch {
        // Column may already exist
      }
      try {
        this.sql.exec(
          "UPDATE threads SET source = 'web' WHERE source IS NULL OR source = ''",
        );
      } catch {
        // Best-effort backfill
      }
    }

    if (version < 17) {
      // V17: Roll back abandoned V16 workspace summary columns (avatar/content/created_by)
      // so OrgDO workspace schema returns to id/name/created_at/archived only.
      try {
        const workspaceColumns = this.sql
          .exec<{ name: string }>("PRAGMA table_info(workspaces)")
          .toArray();
        const names = new Set(workspaceColumns.map((row) => row.name));
        const hasLegacySummaryColumns =
          names.has("avatar_color") ||
          names.has("avatar_content") ||
          names.has("created_by");

        if (hasLegacySummaryColumns) {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec("DROP TABLE IF EXISTS workspaces_v17_rollback");
            this.sql.exec(`
              CREATE TABLE workspaces_v17_rollback (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0
              )
            `);
            this.sql.exec(`
              INSERT INTO workspaces_v17_rollback (id, name, created_at, archived)
              SELECT id, name, created_at, archived FROM workspaces
            `);
            this.sql.exec("DROP TABLE workspaces");
            this.sql.exec(
              "ALTER TABLE workspaces_v17_rollback RENAME TO workspaces",
            );
          });
        }
      } catch (err) {
        console.error("[OrgDO] V17 rollback migration failed:", err);
        throw err;
      }
    }

    if (version < 18) {
      // V18: LLM provider BYOK config (bring your own API key)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS llm_provider_config (
          id TEXT PRIMARY KEY DEFAULT 'active',
          provider TEXT NOT NULL,
          credentials_encrypted TEXT NOT NULL,
          config TEXT NOT NULL DEFAULT '{}',
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 19) {
      // V19: Legacy org-scoped custom domain table.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS custom_domains (
          domain TEXT PRIMARY KEY,
          cf_hostname_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          ssl_status TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 20) {
      // V20: Per-app Cloudflare custom hostname state
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_hostname TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_cf_hostname_id TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_status TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_ssl_status TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_error TEXT",
        );
      } catch {}
      try {
        this.sql.exec(
          "ALTER TABLE worker_scripts ADD COLUMN custom_domain_updated_at INTEGER",
        );
      } catch {}
    }

    if (version < 21) {
      try {
        this.sql.exec(
          `ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT '${DEFAULT_LLM_MODEL}'`,
        );
      } catch {}
      try {
        this.sql.exec(
          `UPDATE threads SET model = '${DEFAULT_LLM_MODEL}' WHERE model IS NULL OR model = ''`,
        );
      } catch {}
    }

    if (version < 22) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS stripe_credit_checkouts (
          session_id TEXT PRIMARY KEY,
          amount_cents INTEGER NOT NULL,
          customer_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 25) {
      // V25: Merge-convergence migration after main and this branch both used
      // OrgDO V23 for different schema changes. Keep this idempotent so DOs
      // that saw either parent history converge without reusing migration ids.
      this.ensureColumn("workspaces", "description", "TEXT");
      this.ensureColumn("workspaces", "created_by", "TEXT");
      this.ensureColumn("workspaces", "avatar_color", "TEXT");
      this.ensureColumn("workspaces", "avatar_content", "TEXT");
      this.ensureColumn("workspaces", "archived_at", "INTEGER");
      this.ensureColumn("workspaces", "archived_by", "TEXT");
      this.ensureColumn(
        "workspaces",
        "compute_tier",
        "TEXT NOT NULL DEFAULT 'standard'",
      );
      this.ensureColumn("workspaces", "email_handle", "TEXT");

      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS usage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          workspace_id TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT '',
          thread_id TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          billing_source TEXT NOT NULL DEFAULT 'hosted',
          credit_chargeable INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log(created_at_ms)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_usage_log_workspace_id ON usage_log(workspace_id)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_usage_log_chargeable_created_at ON usage_log(credit_chargeable, created_at_ms)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS usage_spend (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          total_cost_usd REAL NOT NULL DEFAULT 0,
          total_input_tokens INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          total_requests INTEGER NOT NULL DEFAULT 0,
          limits_json TEXT,
          updated_at_ms INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec("INSERT OR IGNORE INTO usage_spend (id) VALUES (1)");
      this.ensureColumn(
        "usage_log",
        "source",
        "TEXT NOT NULL DEFAULT ''",
      );
      this.ensureColumn(
        "usage_log",
        "source_id",
        "TEXT NOT NULL DEFAULT ''",
      );
      this.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_source ON usage_log(source, source_id) WHERE source != '' AND source_id != ''",
      );
    }

    if (version < 26) {
      // V26: Thread hover metadata for chat group summaries.
      this.ensureColumn("threads", "last_user_message", "TEXT");
      this.ensureColumn("threads", "last_assistant_completed_at", "INTEGER");
      this.ensureColumn("threads", "last_assistant_summary", "TEXT");
    }

    if (version < 27) {
      // V27: Explicit completion-summary lifecycle state.
      this.ensureColumn("threads", "last_assistant_summary_status", "TEXT");
    }

    if (version < 28) {
      // V28: Stable latest user-message timestamp for chat group ordering.
      this.ensureColumn("threads", "last_user_message_at", "INTEGER");
    }

    if (version < 29) {
      // V29: External channel metadata for Slack/email-originated threads.
      this.ensureColumn("threads", "channel_kind", "TEXT");
      this.ensureColumn("threads", "channel_connection_id", "TEXT");
      this.ensureColumn("threads", "channel_conversation_id", "TEXT");
      this.ensureColumn("threads", "channel_message_id", "TEXT");
    }

    if (version < 31) {
      // V31: Aggregate external channel kinds that have participated in a thread.
      // V30 was consumed by a staging deployment of this feature; do not reuse it.
      this.ensureColumn("threads", "channel_kinds", "TEXT");

      const rows = this.sql
        .exec<{ id: string; channel_kind: string | null }>(
          "SELECT id, channel_kind FROM threads WHERE channel_kinds IS NULL OR channel_kinds = ''",
        )
        .toArray();

      for (const row of rows) {
        const kind = normalizeChannelIndicatorKind(row.channel_kind);
        if (!kind) continue;
        this.sql.exec(
          "UPDATE threads SET channel_kinds = ? WHERE id = ?",
          JSON.stringify([kind]),
          row.id,
        );
      }
    }

    if (version < 32) {
      // V32: Track which project VM an app deploy came from.
      this.ensureColumn("worker_scripts", "project_id", "TEXT");
    }

    if (version < 33) {
      // V33: Thread metadata for admin chat explorer error badges and model history.
      this.ensureColumn("threads", "chat_error_count", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("threads", "last_chat_error_at", "INTEGER");
      this.ensureColumn("threads", "last_chat_error_message", "TEXT");
      this.ensureColumn("threads", "last_chat_error_source", "TEXT");
      this.ensureColumn("threads", "last_chat_error_status", "INTEGER");
      this.ensureColumn("threads", "last_chat_error_provider", "TEXT");
      this.ensureColumn("threads", "last_chat_error_model", "TEXT");
      this.ensureColumn("threads", "model_history", "TEXT");
      this.ensureColumn("threads", "last_model_changed_at", "INTEGER");

      const rows = this.sql
        .exec<{ id: string; model: string | null; model_history: string | null; created_at: number }>(
          "SELECT id, model, model_history, created_at FROM threads WHERE model_history IS NULL OR model_history = ''",
        )
        .toArray();
      for (const row of rows) {
        const history = parseModelHistory(row.model_history, row.model);
        if (history.length === 0) continue;
        this.sql.exec(
          "UPDATE threads SET model_history = ?, last_model_changed_at = COALESCE(last_model_changed_at, ?) WHERE id = ?",
          JSON.stringify(history),
          row.created_at,
          row.id,
        );
      }
    }

    if (version < 34) {
      // V34: Idempotency keys for user-visible chat error recording.
      this.ensureThreadErrorEventSchema();
    }

    if (version < 35) {
      // V35: Tenant-local workspace access lives in OrgDO alongside workspace rows.
      this.ensureWorkspaceMembershipSchema();
    }

    if (version < 36) {
      // V36: Workspace-scoped integrations move from WorkspaceDO into OrgDO.
      this.ensureColumn("integrations", "workspace_id", "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn("integrations", "deleted_at", "INTEGER");
      this.ensureColumn("integrations", "token_expires_at", "INTEGER");
      this.ensureColumn("integrations", "auth_status", "TEXT DEFAULT 'connected'");
      this.ensureColumn("integrations", "auth_error_code", "TEXT");
      this.ensureColumn("integrations", "auth_error_message", "TEXT");
      this.ensureColumn("integrations", "auth_checked_at", "INTEGER");
      this.ensureColumn("integrations", "reauth_required_at", "INTEGER");
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_integrations_workspace_active ON integrations(workspace_id, deleted_at)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_integrations_token_expires ON integrations(token_expires_at) WHERE token_expires_at IS NOT NULL AND deleted_at IS NULL",
      );
    }

    if (version < 37) {
      // V37: Deploy history metadata for platform-built project versions.
      this.ensureColumn("worker_scripts", "commit_sha", "TEXT");
      this.ensureColumn("worker_scripts", "artifact_cache_key", "TEXT");
    }

    if (version < 38) {
      // V38: Append-only deploy history for rollback/version discovery.
      this.ensureWorkerScriptDeploysSchema();
    }

    if (version < 39) {
      // V39: Per-workspace registry of active Browser Rendering sessions, used
      // to cap concurrent browser tests per workspace (see app-browser-binding).
      this.ensureBrowserSessionsSchema();
    }

    if (version < 40) {
      // V40: One shared ChatGPT/Codex subscription per organization.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS openai_subscription (
          id TEXT PRIMARY KEY DEFAULT 'active',
          credentials_encrypted TEXT NOT NULL,
          account_email TEXT,
          plan_type TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 41) {
      this.ensureStripeSubscriptionInvoiceGrantsTable();
    }

    if (version < 42) {
      // V42: Per-user daily product allowances for hosted capabilities. These
      // are deliberately separate from usage_log and credit charging.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS capability_daily_usage (
          day_key TEXT NOT NULL,
          capability TEXT NOT NULL,
          user_id TEXT NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (day_key, capability, user_id)
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS capability_usage_events (
          idempotency_key TEXT NOT NULL,
          day_key TEXT NOT NULL,
          capability TEXT NOT NULL,
          user_id TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          PRIMARY KEY (day_key, capability, user_id, idempotency_key)
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_capability_events_day ON capability_usage_events(day_key)",
      );
    }

    if (version < 43) {
      // V43: Separate reusable API/tool definitions from account credentials.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS integration_definitions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          payload TEXT NOT NULL,
          source TEXT NOT NULL,
          source_url TEXT,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_integration_definitions_workspace ON integration_definitions(workspace_id, updated_at)",
      );
      this.ensureColumn("integrations", "definition_id", "TEXT");
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_integrations_definition ON integrations(definition_id) WHERE definition_id IS NOT NULL",
      );
    }

    if (version < 44) {
      // V44: Persist the latest normalized connection verification separately
      // from auth health. A valid credential is not proof that an endpoint is
      // reachable, and configuration-only adapters cannot be live-checked.
      this.ensureColumn("integrations", "verification_status", "TEXT");
      this.ensureColumn("integrations", "verification_message", "TEXT");
      this.ensureColumn("integrations", "verification_checked_at", "INTEGER");
      this.ensureColumn("integrations", "verification_live", "INTEGER");
      this.ensureColumn("integrations", "verification_strategy", "TEXT");
    }

    if (version < 45) {
      // V45: Bounded rolling log of user messages for history search.
      try {
        this.sql.exec("ALTER TABLE threads ADD COLUMN user_ask_log TEXT");
      } catch {
        // Column may already exist after defensive schema repair.
      }
    }

    if (version < 46) {
      // V46: Unicode-aware lowercase title projection for history search.
      try {
        this.sql.exec("ALTER TABLE threads ADD COLUMN title_search TEXT");
      } catch {
        // Column may already exist after defensive schema repair.
      }
      // Population is intentionally lazy and checkpointed. Loading every
      // thread here would block OrgDO startup before the schema marker can be
      // persisted, causing large orgs to retry the same unbounded work.
      this.resetThreadSearchBackfillCheckpoint();
    }

    if (version < 47) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_sso_transactions (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL,
          config_version INTEGER NOT NULL,
          pkce_verifier TEXT NOT NULL,
          nonce TEXT NOT NULL,
          browser_binding_hash TEXT NOT NULL,
          link_user_id TEXT,
          redirect_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS enterprise_sso_identities (
          connection_id TEXT NOT NULL,
          issuer TEXT NOT NULL,
          subject TEXT NOT NULL,
          user_id TEXT NOT NULL,
          email TEXT NOT NULL,
          tenant_scoped INTEGER NOT NULL DEFAULT 0,
          membership_revoked INTEGER NOT NULL DEFAULT 0,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (connection_id, issuer, subject)
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_enterprise_sso_identities_user ON enterprise_sso_identities(user_id)",
      );
    }

    if (version < 48) {
      this.ensureColumn(
        "enterprise_sso_identities",
        "tenant_scoped",
        "INTEGER NOT NULL DEFAULT 0",
      );
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_enterprise_sso_identities_email
           ON enterprise_sso_identities(connection_id, issuer, email)`,
      );
    }

    if (version < 49) {
      this.ensureColumn(
        "enterprise_sso_identities",
        "membership_revoked",
        "INTEGER NOT NULL DEFAULT 0",
      );
    }

    if (version < 50) {
      this.ensureColumn(
        "members",
        "workspace_access_default",
        "TEXT NOT NULL DEFAULT 'full'",
      );
    }

    if (version < 51) {
      const threadColumns = this.sql
        .exec<{ name: string }>("PRAGMA table_info(threads)")
        .toArray();
      if (threadColumns.some((column) => column.name === "provider")) {
        this.sql.exec("ALTER TABLE threads DROP COLUMN provider");
      }
      this.sql.exec(
        "DELETE FROM org_info WHERE key = 'experimental_settings'",
      );
    }

    const usageLogColumns = new Set(
      this.sql.exec<{ name: string }>("PRAGMA table_info(usage_log)").toArray()
        .map((column) => column.name),
    );
    const usageControlTables = new Set(
      this.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('user_llm_usage_limits', 'llm_model_pricing_overrides')`,
      ).toArray().map((row) => row.name),
    );
    const usageControlsSchemaIncomplete =
      !usageLogColumns.has("usage_kind") ||
      !usageLogColumns.has("usage_surface") ||
      !usageLogColumns.has("metered_cost_microusd") ||
      !usageLogColumns.has("cost_source") ||
      !usageControlTables.has("user_llm_usage_limits") ||
      !usageControlTables.has("llm_model_pricing_overrides");
    if (version < 52 || usageControlsSchemaIncomplete) {
      this.ensureColumn(
        "usage_log",
        "usage_kind",
        "TEXT NOT NULL DEFAULT 'unknown'",
      );
      this.ensureColumn(
        "usage_log",
        "usage_surface",
        "TEXT NOT NULL DEFAULT 'unknown'",
      );
      this.ensureColumn("usage_log", "metered_cost_microusd", "INTEGER");
      this.ensureColumn(
        "usage_log",
        "cost_source",
        "TEXT NOT NULL DEFAULT 'legacy_estimate'",
      );
      this.sql.exec(
        `UPDATE usage_log
            SET metered_cost_microusd = ROUND(cost_usd * 1000000),
                cost_source = 'legacy_estimate'
          WHERE metered_cost_microusd IS NULL`,
      );
      this.sql.exec(
        `UPDATE usage_log SET usage_kind = 'capability', usage_surface = 'capability'
          WHERE usage_kind = 'unknown' AND (
            billing_source = 'hosted_capability' OR
            source IN ('web_search', 'web_fetch')
          )`,
      );
      this.sql.exec(
        `UPDATE usage_log SET usage_kind = 'image', usage_surface = 'auxiliary'
          WHERE usage_kind = 'unknown' AND (
            source IN ('image_generation', 'generate_image') OR
            (thread_id = 'virtual-ai' AND model IN ('auto_image', 'dynamic/auto_image'))
          )`,
      );
      this.sql.exec(
        `UPDATE usage_log SET usage_kind = 'audio'
          WHERE usage_kind = 'unknown' AND source IN ('audio_transcription', 'transcribe_audio')`,
      );
      this.sql.exec(
        `UPDATE usage_log SET usage_kind = 'llm', usage_surface = 'agent'
          WHERE usage_kind = 'unknown' AND source = 'pi_assistant'`,
      );
      // Historical Virtual AI rows stored the provider response model, so an
      // auto-image call can be indistinguishable from a text completion. Keep
      // ambiguous rows out of LLM spend while still exposing their true surface
      // to operators; only the known image route names above are classified.
      this.sql.exec(
        `UPDATE usage_log SET usage_surface = 'virtual_ai'
          WHERE usage_surface = 'unknown' AND thread_id = 'virtual-ai'`,
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_usage_log_user_created_at ON usage_log(user_id, created_at_ms)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_usage_log_user_model_created_at ON usage_log(user_id, provider, model, created_at_ms)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS user_llm_usage_limits (
          user_id TEXT NOT NULL,
          window_ms INTEGER NOT NULL,
          limit_microusd INTEGER NOT NULL,
          label TEXT,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          PRIMARY KEY (user_id, window_ms)
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_user_llm_usage_limits_user ON user_llm_usage_limits(user_id)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS llm_model_pricing_overrides (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_microusd_per_million INTEGER NOT NULL,
          output_microusd_per_million INTEGER NOT NULL,
          cache_creation_microusd_per_million INTEGER NOT NULL DEFAULT 0,
          cache_read_microusd_per_million INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          updated_by TEXT NOT NULL,
          PRIMARY KEY (provider, model)
        )
      `);
    }

    const CURRENT_SCHEMA_VERSION = 52;
    if (version < CURRENT_SCHEMA_VERSION) {
      this.ctx.storage.kv.put("schemaVersion", CURRENT_SCHEMA_VERSION);
    }

    this.workerScriptsHasPreviewColumns =
      this.detectWorkerScriptPreviewColumns();
    if (!this.workerScriptsHasPreviewColumns) {
      console.warn(
        "[OrgDO] worker_scripts missing preview columns - preview updates will be skipped",
      );
    }
  }

  private detectWorkerScriptPreviewColumns(): boolean {
    try {
      const rows = this.sql
        .exec<{ name: string }>("PRAGMA table_info(worker_scripts)")
        .toArray();
      const names = new Set(rows.map((row) => row.name));
      return (
        names.has("preview_key") &&
        names.has("preview_updated_at") &&
        names.has("preview_status") &&
        names.has("preview_error") &&
        names.has("custom_domain_hostname") &&
        names.has("custom_domain_cf_hostname_id") &&
        names.has("custom_domain_status") &&
        names.has("custom_domain_ssl_status") &&
        names.has("custom_domain_error") &&
        names.has("custom_domain_updated_at")
      );
    } catch {
      return false;
    }
  }

  private ensureColumn(
    tableName: string,
    columnName: string,
    columnDef: string,
  ): void {
    const rows = this.sql
      .exec<{ name: string }>(`PRAGMA table_info(${tableName})`)
      .toArray();
    if (rows.some((row) => row.name === columnName)) {
      return;
    }
    this.sql.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
  }

  private ensureWorkerScriptDeploysSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS worker_script_deploys (
        id TEXT PRIMARY KEY,
        script_name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        config_path TEXT,
        project_id TEXT,
        commit_sha TEXT,
        artifact_cache_key TEXT
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_worker_script_deploys_script_workspace ON worker_script_deploys(script_name, workspace_id, created_at DESC)",
    );
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_worker_script_deploys_workspace ON worker_script_deploys(workspace_id, created_at DESC)",
    );
  }

  private ensureBrowserSessionsSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_browser_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_workspace_browser_sessions_workspace ON workspace_browser_sessions(workspace_id)",
    );
  }

  private ensureWorkspaceMembershipSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workspace_memberships (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        access_level TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      )
    `);
    this.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user ON workspace_memberships(user_id)",
    );
  }

  private resetThreadSearchBackfillCheckpoint(): void {
    this.ctx.storage.kv.delete(THREAD_SEARCH_BACKFILL_CURSOR_KEY);
    this.ctx.storage.kv.delete(THREAD_SEARCH_BACKFILL_COMPLETE_KEY);
  }

  private backfillThreadSearchMetadataBatch(
    requestedBatchSize = THREAD_SEARCH_BACKFILL_BATCH_SIZE,
  ): { processed: number; complete: boolean } {
    if (
      this.ctx.storage.kv.get<number>(THREAD_SEARCH_BACKFILL_COMPLETE_KEY) === 1
    ) {
      return { processed: 0, complete: true };
    }

    const normalizedBatchSize = Number.isFinite(requestedBatchSize)
      ? Math.floor(requestedBatchSize)
      : THREAD_SEARCH_BACKFILL_BATCH_SIZE;
    const batchSize = Math.max(
      1,
      Math.min(THREAD_SEARCH_BACKFILL_BATCH_SIZE, normalizedBatchSize),
    );
    const cursor =
      this.ctx.storage.kv.get<string>(THREAD_SEARCH_BACKFILL_CURSOR_KEY) ?? "";
    const rows = this.sql
      .exec<{
        id: string;
        title: string;
        user_ask_log: string | null;
      }>(
        `SELECT id,
                substr(title, 1, ?) AS title,
                substr(user_ask_log, -?) AS user_ask_log
           FROM threads
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?`,
        THREAD_SEARCH_FIELD_MAX_CHARS,
        THREAD_ASK_LOG_MAX_BYTES + 1,
        cursor,
        batchSize,
      )
      .toArray();

    const lastId = rows.at(-1)?.id ?? null;
    const hasMore =
      rows.length === batchSize &&
      lastId !== null &&
      this.sql
        .exec<{ id: string }>(
          "SELECT id FROM threads WHERE id > ? ORDER BY id ASC LIMIT 1",
          lastId,
        )
        .toArray().length > 0;

    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        let askLog = row.user_ask_log;
        const askLogCharacters = askLog ? Array.from(askLog) : [];
        if (askLogCharacters.length > THREAD_ASK_LOG_MAX_BYTES) {
          const precedingCharacter = askLogCharacters.shift();
          askLog = askLogCharacters.join("");
          if (precedingCharacter !== "\n") {
            const firstCompleteEntry = askLog.indexOf("\n");
            if (firstCompleteEntry >= 0) {
              askLog = askLog.slice(firstCompleteEntry + 1);
            }
          }
        }

        this.sql.exec(
          `UPDATE threads
              SET title_search = ?, user_ask_log = ?
            WHERE id = ?`,
          normalizeThreadSearchTitle(row.title),
          appendToThreadAskLog(askLog, null),
          row.id,
        );
      }

      if (hasMore && lastId !== null) {
        this.ctx.storage.kv.put(THREAD_SEARCH_BACKFILL_CURSOR_KEY, lastId);
      } else {
        this.ctx.storage.kv.delete(THREAD_SEARCH_BACKFILL_CURSOR_KEY);
        this.ctx.storage.kv.put(THREAD_SEARCH_BACKFILL_COMPLETE_KEY, 1);
      }
    });

    return { processed: rows.length, complete: !hasMore };
  }

  private ensureThreadSchemaColumns(): void {
    try {
      const rows = this.sql
        .exec<{ name: string }>("PRAGMA table_info(threads)")
        .toArray();
      if (rows.length === 0) return;

      const names = new Set(rows.map((row) => row.name));

      if (!names.has("source")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN source TEXT NOT NULL DEFAULT 'web'",
          );
        } catch {}
        try {
          this.sql.exec(
            "UPDATE threads SET source = 'web' WHERE source IS NULL OR source = ''",
          );
        } catch {}
      }

      if (!names.has("user_message_count")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN user_message_count INTEGER NOT NULL DEFAULT 0",
          );
        } catch {}
      }

      if (!names.has("first_user_message")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN first_user_message TEXT",
          );
        } catch {}
      }

      if (!names.has("user_ask_log")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN user_ask_log TEXT");
          this.resetThreadSearchBackfillCheckpoint();
        } catch {}
      }

      if (!names.has("title_search")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN title_search TEXT");
          this.resetThreadSearchBackfillCheckpoint();
        } catch {}
      }

      if (!names.has("last_user_message")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_user_message TEXT");
        } catch {}
      }

      if (!names.has("last_user_message_at")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_user_message_at INTEGER");
        } catch {}
      }

      if (!names.has("last_assistant_completed_at")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN last_assistant_completed_at INTEGER",
          );
        } catch {}
      }

      if (!names.has("last_assistant_summary")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN last_assistant_summary TEXT",
          );
        } catch {}
      }

      if (!names.has("last_assistant_summary_status")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN last_assistant_summary_status TEXT",
          );
        } catch {}
      }

      if (!names.has("model")) {
        try {
          this.sql.exec(
            `ALTER TABLE threads ADD COLUMN model TEXT NOT NULL DEFAULT '${DEFAULT_LLM_MODEL}'`,
          );
        } catch {}
        try {
          this.sql.exec(
            `UPDATE threads SET model = '${DEFAULT_LLM_MODEL}' WHERE model IS NULL OR model = ''`,
          );
        } catch {}
      }

      if (!names.has("channel_kind")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN channel_kind TEXT");
        } catch {}
      }

      if (!names.has("channel_kinds")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN channel_kinds TEXT");
        } catch {}
      }

      if (!names.has("channel_connection_id")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN channel_connection_id TEXT",
          );
        } catch {}
      }

      if (!names.has("channel_conversation_id")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN channel_conversation_id TEXT",
          );
        } catch {}
      }

      if (!names.has("channel_message_id")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN channel_message_id TEXT");
        } catch {}
      }

      if (!names.has("chat_error_count")) {
        try {
          this.sql.exec(
            "ALTER TABLE threads ADD COLUMN chat_error_count INTEGER NOT NULL DEFAULT 0",
          );
        } catch {}
      }

      if (!names.has("last_chat_error_at")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_chat_error_at INTEGER");
        } catch {}
      }

      if (!names.has("last_chat_error_message")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_chat_error_message TEXT");
        } catch {}
      }

      if (!names.has("last_chat_error_source")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_chat_error_source TEXT");
        } catch {}
      }

      if (!names.has("last_chat_error_status")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_chat_error_status INTEGER");
        } catch {}
      }

      if (!names.has("last_chat_error_provider")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_chat_error_provider TEXT");
        } catch {}
      }

      if (!names.has("last_chat_error_model")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_chat_error_model TEXT");
        } catch {}
      }

      if (!names.has("model_history")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN model_history TEXT");
        } catch {}
      }

      if (!names.has("last_model_changed_at")) {
        try {
          this.sql.exec("ALTER TABLE threads ADD COLUMN last_model_changed_at INTEGER");
        } catch {}
      }
    } catch (err) {
      console.error("[OrgDO] failed to ensure thread schema columns", err);
    }
  }

  private ensureThreadErrorEventSchema(): void {
    try {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS thread_error_events (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_thread_error_events_thread_created_at ON thread_error_events(thread_id, created_at DESC)",
      );
    } catch (err) {
      console.error("[OrgDO] failed to ensure thread error event schema", err);
    }
  }

  private execWorkerScriptsQuery(
    queryWithPreview: string,
    queryBase: string,
    params: Array<string | number>,
  ): WorkerScriptRow[] {
    if (this.workerScriptsHasPreviewColumns) {
      try {
        return this.sql
          .exec<WorkerScriptRow>(queryWithPreview, ...params)
          .toArray();
      } catch {
        this.workerScriptsHasPreviewColumns = false;
      }
    }
    return this.sql.exec<WorkerScriptRow>(queryBase, ...params).toArray();
  }

  private toWorkerScript(row: WorkerScriptRow): WorkerScript {
    return {
      script_name: row.script_name,
      workspace_id: row.workspace_id,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_public: row.is_public === 1,
      preview_key: row.preview_key ?? null,
      preview_updated_at: row.preview_updated_at ?? null,
      preview_status: row.preview_status ?? null,
      preview_error: row.preview_error ?? null,
      config_path: row.config_path ?? null,
      project_id: row.project_id ?? null,
      commit_sha: row.commit_sha ?? null,
      artifact_cache_key: row.artifact_cache_key ?? null,
      custom_domain_hostname: row.custom_domain_hostname ?? null,
      custom_domain_cf_hostname_id: row.custom_domain_cf_hostname_id ?? null,
      custom_domain_status: row.custom_domain_status ?? null,
      custom_domain_ssl_status: row.custom_domain_ssl_status ?? null,
      custom_domain_error: row.custom_domain_error ?? null,
      custom_domain_updated_at: row.custom_domain_updated_at ?? null,
    };
  }

  // Org info methods
  private getInfoSync(): Organization | null {
    const rows = this.sql
      .exec("SELECT value FROM org_info WHERE key = ?", "data")
      .toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse(
      (rows[0] as { value: string }).value,
    ) as Organization;
    normalizeOrgBillingFields(info);
    if (info.billing_customer_id === undefined) info.billing_customer_id = null;
    if (info.billing_subscription_id === undefined)
      info.billing_subscription_id = null;
    if (info.billing_subscription_status === undefined)
      info.billing_subscription_status = null;
    if (info.billing_trial_started_at === undefined)
      info.billing_trial_started_at = null;
    if (info.billing_trial_ends_at === undefined)
      info.billing_trial_ends_at = null;
    if (typeof info.billing_credit_purchase_total_cents !== "number") {
      info.billing_credit_purchase_total_cents = 0;
    }
    if (typeof info.billing_credit_grant_total_cents !== "number") {
      info.billing_credit_grant_total_cents = 0;
    }
    if (typeof info.billing_trial_credit_grant_cents !== "number") {
      info.billing_trial_credit_grant_cents = 0;
    }
    if (info.billing_trial_credit_granted_at === undefined) {
      info.billing_trial_credit_granted_at = null;
    }
    if (typeof info.billing_free_credit_grant_cents !== "number") {
      info.billing_free_credit_grant_cents = 0;
    }
    if (info.billing_free_credit_granted_at === undefined) {
      info.billing_free_credit_granted_at = null;
    }
    if (info.billing_last_included_credit_invoice_id === undefined) {
      info.billing_last_included_credit_invoice_id = null;
    }
    if (info.billing_credit_usage_started_at === undefined) {
      info.billing_credit_usage_started_at = null;
    }
    if (typeof info.archived !== "boolean") info.archived = false;
    if (info.archived_at === undefined) info.archived_at = null;
    if (info.archived_by === undefined) info.archived_by = null;
    return info;
  }

  async getInfo(): Promise<Organization | null> {
    const rows = this.sql
      .exec("SELECT value FROM org_info WHERE key = ?", "data")
      .toArray();
    if (rows.length === 0) return null;
    const info = JSON.parse(
      (rows[0] as { value: string }).value,
    ) as Organization;
    let changed = false;
    changed = normalizeOrgBillingFields(info) || changed;
    if (info.billing_customer_id === undefined) {
      info.billing_customer_id = null;
      changed = true;
    }
    if (info.billing_subscription_id === undefined) {
      info.billing_subscription_id = null;
      changed = true;
    }
    if (info.billing_subscription_status === undefined) {
      info.billing_subscription_status = null;
      changed = true;
    }
    if (info.billing_trial_started_at === undefined) {
      info.billing_trial_started_at = null;
      changed = true;
    }
    if (info.billing_trial_ends_at === undefined) {
      info.billing_trial_ends_at = null;
      changed = true;
    }
    if (typeof info.billing_credit_purchase_total_cents !== "number") {
      info.billing_credit_purchase_total_cents = 0;
      changed = true;
    }
    if (typeof info.billing_credit_grant_total_cents !== "number") {
      info.billing_credit_grant_total_cents = 0;
      changed = true;
    }
    if (typeof info.billing_trial_credit_grant_cents !== "number") {
      info.billing_trial_credit_grant_cents = 0;
      changed = true;
    }
    if (info.billing_trial_credit_granted_at === undefined) {
      info.billing_trial_credit_granted_at = null;
      changed = true;
    }
    if (typeof info.billing_free_credit_grant_cents !== "number") {
      info.billing_free_credit_grant_cents = 0;
      changed = true;
    }
    if (info.billing_free_credit_granted_at === undefined) {
      info.billing_free_credit_granted_at = null;
      changed = true;
    }
    if (info.billing_last_included_credit_invoice_id === undefined) {
      info.billing_last_included_credit_invoice_id = null;
      changed = true;
    }
    if (info.billing_credit_usage_started_at === undefined) {
      info.billing_credit_usage_started_at = null;
      changed = true;
    }
    if (typeof info.archived !== "boolean") {
      info.archived = false;
      changed = true;
    }
    if (info.archived_at === undefined) {
      info.archived_at = null;
      changed = true;
    }
    if (info.archived_by === undefined) {
      info.archived_by = null;
      changed = true;
    }
    if (!info.slug) {
      info.slug = await hashOrgSlug(info.id);
      changed = true;
    }
    if (changed) {
      await this.setInfo(info);
    }
    return info;
  }

  claimLegacyHostUsageBackfill(): "claimed" | "complete" | "running" {
    const status = this.ctx.storage.kv.get<string>(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_STATUS_KEY,
    );
    if (status === "complete") return "complete";
    const startedAt =
      this.ctx.storage.kv.get<number>(
        OrgDO.LEGACY_HOST_USAGE_BACKFILL_STARTED_AT_KEY,
      ) ?? 0;
    if (status === "running" && Date.now() - startedAt < 15 * 60 * 1000) {
      return "running";
    }
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_STATUS_KEY,
      "running",
    );
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_STARTED_AT_KEY,
      Date.now(),
    );
    this.ctx.storage.kv.delete(OrgDO.LEGACY_HOST_USAGE_BACKFILL_ERROR_KEY);
    return "claimed";
  }

  completeLegacyHostUsageBackfill(result: unknown): void {
    const now = Date.now();
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_STATUS_KEY,
      "complete",
    );
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_COMPLETED_AT_KEY,
      now,
    );
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_RESULT_KEY,
      result,
    );
    this.ctx.storage.kv.delete(OrgDO.LEGACY_HOST_USAGE_BACKFILL_ERROR_KEY);
  }

  failLegacyHostUsageBackfill(error: string): void {
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_STATUS_KEY,
      "failed",
    );
    this.ctx.storage.kv.put(
      OrgDO.LEGACY_HOST_USAGE_BACKFILL_ERROR_KEY,
      error,
    );
  }

  /**
   * Get just the org slug (for contexts where we only need the slug).
   * Also ensures the slug→orgId reverse mapping exists in KV.
   */
  async getSlug(): Promise<string | null> {
    const info = await this.getInfo();
    if (!info?.slug) return null;

    // Lazy backfill: ensure KV reverse mapping exists
    const kvKey = `${ORG_SLUG_KV_PREFIX}${info.slug}`;
    const existing = await this.env.APP_KV.get(kvKey);
    if (!existing) {
      await registerOrgSlug(this.env.APP_KV, info.slug, info.id);
    }
    return info.slug;
  }

  async setInfo(info: Organization): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
      "data",
      JSON.stringify(info),
    );
    dispatchAdminEvent(this.ctx, this.env, {
      type: "org_upsert",
      payload: info,
    });
  }

  claimSsoProvisioning(): string | null {
    const key = "sso_provisioning_lease";
    const current = this.ctx.storage.kv.get<{ token: string; startedAt: number }>(key);
    if (current && Date.now() - current.startedAt < 2 * 60 * 1000) return null;
    const token = crypto.randomUUID();
    this.ctx.storage.kv.put(key, { token, startedAt: Date.now() });
    return token;
  }

  releaseSsoProvisioning(token: string): void {
    const key = "sso_provisioning_lease";
    if (this.ctx.storage.kv.get<{ token: string }>(key)?.token === token) {
      this.ctx.storage.kv.delete(key);
    }
  }

  getSsoConfig(): OrgSsoConfig | null {
    const row = this.sql
      .exec<{ value: string }>(
        "SELECT value FROM org_info WHERE key = ?",
        ORG_SSO_CONFIG_KEY,
      )
      .next().value;
    if (!row) return null;
    try {
      const config = JSON.parse(row.value) as OrgSsoConfig;
      return config.protocol === "oidc" && config.connection_id && config.issuer
        ? {
            ...config,
            email_domains: Array.isArray(config.email_domains)
              ? config.email_domains
              : [],
            jit_provisioning_enabled:
              config.jit_provisioning_enabled === true,
          }
        : null;
    } catch {
      return null;
    }
  }

  setSsoConfig(config: OrgSsoConfig, actorId: string): OrgSsoConfig {
    this.sql.exec(
      "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
      ORG_SSO_CONFIG_KEY,
      JSON.stringify(config),
    );
    this.log("sso_config_updated", actorId, undefined, {
      connection_id: config.connection_id,
      issuer: config.issuer,
      email_domains: config.email_domains,
      jit_provisioning_enabled: config.jit_provisioning_enabled,
      config_version: config.config_version,
      enabled: config.enabled,
    });
    return config;
  }

  disableSsoConfig(actorId: string): OrgSsoConfig | null {
    const previous = this.getSsoConfig();
    if (!previous) return null;
    const next = {
      ...previous,
      enabled: false,
      config_version: previous.config_version + 1,
      updated_at: Date.now(),
      updated_by: actorId,
    };
    this.setSsoConfig(next, actorId);
    this.sql.exec("DELETE FROM enterprise_sso_transactions");
    this.log("sso_config_disabled", actorId, undefined, {
      connection_id: next.connection_id,
      config_version: next.config_version,
    });
    return next;
  }

  allowSsoLoginAttempt(clientKey: string, now = Date.now()): boolean {
    const bucket = Math.floor(now / 60_000);
    const key = `sso_login_rate:${bucket}`;
    const state = this.ctx.storage.kv.get<{
      total: number;
      clients: Record<string, number>;
    }>(key) ?? { total: 0, clients: {} };
    const clientCount = state.clients[clientKey] ?? 0;
    if (state.total >= 2_000 || clientCount >= 20) return false;
    state.total += 1;
    state.clients[clientKey] = clientCount + 1;
    this.ctx.storage.kv.put(key, state);
    this.ctx.storage.kv.delete(`sso_login_rate:${bucket - 2}`);
    return true;
  }

  createSsoConnectionTest(test: OrgSsoConnectionTest): void {
    for (const [key, existing] of this.ctx.storage.kv.list<OrgSsoConnectionTest>({
      prefix: "sso_connection_test:",
    })) {
      if (existing.expires_at <= Date.now()) this.ctx.storage.kv.delete(key);
    }
    this.ctx.storage.kv.put(`sso_connection_test:${test.id}`, test);
  }

  getSsoConnectionTest(id: string, actorUserId: string): OrgSsoConnectionTest | null {
    const key = `sso_connection_test:${id}`;
    const test = this.ctx.storage.kv.get<OrgSsoConnectionTest>(key);
    if (!test) return null;
    if (test.expires_at <= Date.now()) {
      this.ctx.storage.kv.delete(key);
      return null;
    }
    return test.actor_user_id === actorUserId ? test : null;
  }

  completeSsoConnectionTest(
    id: string,
    actorUserId: string,
    completion: Pick<OrgSsoConnectionTest, "status" | "checks" | "identity" | "error" | "completed_at"> &
      Partial<Pick<OrgSsoConnectionTest, "config">>,
  ): OrgSsoConnectionTest | null {
    const test = this.getSsoConnectionTest(id, actorUserId);
    if (!test || test.status !== "pending") return null;
    const completed = { ...test, ...completion };
    this.ctx.storage.kv.put(`sso_connection_test:${id}`, completed);
    return completed;
  }

  consumeSuccessfulSsoConnectionTest(
    id: string,
    actorUserId: string,
  ): OrgSsoConnectionTest | null {
    const test = this.getSsoConnectionTest(id, actorUserId);
    if (!test || test.status !== "succeeded") return null;
    this.ctx.storage.kv.delete(`sso_connection_test:${id}`);
    return test;
  }

  createSsoTransaction(transaction: OrgSsoTransaction): void {
    this.sql.exec("DELETE FROM enterprise_sso_transactions WHERE expires_at <= ?", Date.now());
    const outstanding = this.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM enterprise_sso_transactions")
      .next().value?.count ?? 0;
    if (outstanding >= 5_000) throw new Error("Too many pending SSO sign-ins");
    this.sql.exec(
      `INSERT INTO enterprise_sso_transactions (
        id, connection_id, config_version, pkce_verifier, nonce,
        browser_binding_hash, link_user_id, redirect_path, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      transaction.id,
      transaction.connection_id,
      transaction.config_version,
      transaction.pkce_verifier,
      transaction.nonce,
      transaction.browser_binding_hash,
      transaction.link_user_id,
      transaction.redirect_path,
      transaction.created_at,
      transaction.expires_at,
    );
  }

  consumeSsoTransaction(
    id: string,
    browserBindingHash: string,
  ): OrgSsoTransaction | null {
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<OrgSsoTransaction & Record<string, SqlStorageValue>>(
          `SELECT id, connection_id, config_version, pkce_verifier, nonce,
                  browser_binding_hash, link_user_id, redirect_path, created_at, expires_at
             FROM enterprise_sso_transactions WHERE id = ?`,
          id,
        )
        .next().value;
      if (!row) return null;
      if (row.expires_at <= Date.now()) {
        this.sql.exec("DELETE FROM enterprise_sso_transactions WHERE id = ?", id);
        return null;
      }
      if (row.browser_binding_hash !== browserBindingHash) return null;
      this.sql.exec("DELETE FROM enterprise_sso_transactions WHERE id = ?", id);
      return row;
    });
  }

  getSsoIdentityUserId(
    connectionId: string,
    issuer: string,
    subject: string,
  ): string | null {
    return this.getSsoIdentity(connectionId, issuer, subject)?.userId ?? null;
  }

  getSsoIdentity(
    connectionId: string,
    issuer: string,
    subject: string,
  ): OrgSsoIdentityRecord | null {
    const row = this.sql
      .exec<{
        user_id: string;
        email: string;
        tenant_scoped: number;
        membership_revoked: number;
      }>(
        `SELECT user_id, email, tenant_scoped, membership_revoked
           FROM enterprise_sso_identities
          WHERE connection_id = ? AND issuer = ? AND subject = ?`,
        connectionId,
        issuer,
        subject,
      )
      .next().value;
    return row
      ? {
          userId: row.user_id,
          email: row.email,
          tenantScoped: row.tenant_scoped === 1,
          membershipRevoked: row.membership_revoked === 1,
        }
      : null;
  }

  getSsoIdentityByEmail(
    connectionId: string,
    issuer: string,
    email: string,
  ): OrgSsoIdentityRecord | null {
    const row = this.sql
      .exec<{
        user_id: string;
        email: string;
        tenant_scoped: number;
        membership_revoked: number;
      }>(
        `SELECT user_id, email, tenant_scoped, membership_revoked
           FROM enterprise_sso_identities
          WHERE connection_id = ? AND issuer = ? AND email = ?
          ORDER BY linked_at ASC LIMIT 1`,
        connectionId,
        issuer,
        email.trim().toLowerCase(),
      )
      .next().value;
    return row
      ? {
          userId: row.user_id,
          email: row.email,
          tenantScoped: row.tenant_scoped === 1,
          membershipRevoked: row.membership_revoked === 1,
        }
      : null;
  }

  claimSsoJitIdentity(
    connectionId: string,
    issuer: string,
    subject: string,
    email: string,
  ): OrgSsoIdentityRecord | null {
    const normalizedEmail = email.trim().toLowerCase();
    return this.ctx.storage.transactionSync(() => {
      const bySubject = this.getSsoIdentity(connectionId, issuer, subject);
      if (bySubject) return bySubject;
      // Do not silently create a second tenant principal when a connection is
      // rotated, and do not let a new connection bypass a removal tombstone.
      // Rebinding an existing email across connection generations requires an
      // explicit owner/user linking flow.
      const priorEmailIdentity = this.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM enterprise_sso_identities
            WHERE email = ?
            LIMIT 1`,
          normalizedEmail,
        )
        .next().value;
      if (priorEmailIdentity) {
        return null;
      }
      const userId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO enterprise_sso_identities
          (connection_id, issuer, subject, user_id, email, tenant_scoped,
           membership_revoked, linked_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
        connectionId,
        issuer,
        subject,
        userId,
        normalizedEmail,
        Date.now(),
      );
      return {
        userId,
        email: normalizedEmail,
        tenantScoped: true,
        membershipRevoked: false,
      };
    });
  }

  async claimSsoInvitedIdentity(
    connectionId: string,
    issuer: string,
    subject: string,
    email: string,
  ): Promise<OrgSsoIdentityRecord | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const workspaceIds = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM workspaces WHERE archived = 0 ORDER BY created_at ASC",
      )
      .toArray()
      .map((workspace) => workspace.id);
    if (workspaceIds.length > 0) {
      const memberIds = new Set(
        (await this.getMembers()).map((member) => member.user_id),
      );
      await Promise.all(
        workspaceIds.map((workspaceId) =>
          this.ensureWorkspaceAccessMigrated(workspaceId, memberIds),
        ),
      );
    }

    const now = Date.now();
    let acceptedInvitation: OrgInvitation | null = null;
    let addedMember = false;
    let reusedActiveIdentity = false;
    const identity = this.ctx.storage.transactionSync(() => {
      let claimedIdentity = this.getSsoIdentity(connectionId, issuer, subject);
      if (claimedIdentity && claimedIdentity.email !== normalizedEmail) {
        return null;
      }

      let existingMember = claimedIdentity
        ? ((this.sql
            .exec<OrgMember & Record<string, SqlStorageValue>>(
              "SELECT user_id, role, joined_at, workspace_access_default FROM members WHERE user_id = ?",
              claimedIdentity.userId,
            )
            .next().value as OrgMember | undefined) ?? null)
        : null;
      if (
        claimedIdentity &&
        existingMember &&
        !claimedIdentity.membershipRevoked
      ) {
        // A concurrent callback may have loaded the identity before the first
        // callback committed it. Converge on the now-active identity without
        // requiring a second invitation.
        reusedActiveIdentity = true;
        return claimedIdentity;
      }

      const invitationRow = this.sql
        .exec<{
          id: string;
          email: string;
          role: OrgRole;
          invited_by: string;
          created_at: number;
          expires_at: number;
          workspace_access: string | null;
        }>(
          `SELECT id, email, role, invited_by, created_at, expires_at, workspace_access
             FROM invitations
            WHERE email = ? AND expires_at > ?
            ORDER BY created_at ASC
            LIMIT 1`,
          normalizedEmail,
          now,
        )
        .next().value;
      if (
        !invitationRow ||
        !["admin", "member", "viewer"].includes(invitationRow.role)
      ) {
        return null;
      }

      const workspaceAccess = invitationRow.workspace_access
        ? (JSON.parse(invitationRow.workspace_access) as Record<
            string,
            WorkspaceAccessLevel
          >)
        : null;
      acceptedInvitation = {
        ...invitationRow,
        workspace_access: workspaceAccess,
      };

      if (!claimedIdentity) {
        // Email reuse across subjects or connection generations requires an
        // explicit account-link flow. An invitation authorizes membership, not
        // replacement of an existing identity binding.
        const priorEmailIdentity = this.sql
          .exec<{ user_id: string }>(
            `SELECT user_id FROM enterprise_sso_identities
              WHERE email = ?
              LIMIT 1`,
            normalizedEmail,
          )
          .next().value;
        if (priorEmailIdentity) return null;

        const userId = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO enterprise_sso_identities
            (connection_id, issuer, subject, user_id, email, tenant_scoped,
             membership_revoked, linked_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?)`,
          connectionId,
          issuer,
          subject,
          userId,
          normalizedEmail,
          now,
        );
        claimedIdentity = {
          userId,
          email: normalizedEmail,
          tenantScoped: true,
          membershipRevoked: false,
        };
      }

      existingMember ??=
        (this.sql
          .exec<OrgMember & Record<string, SqlStorageValue>>(
            "SELECT user_id, role, joined_at, workspace_access_default FROM members WHERE user_id = ?",
            claimedIdentity.userId,
          )
          .next().value as OrgMember | undefined) ?? null;
      if (!existingMember) {
        const activeInvitations =
          this.sql
            .exec<{
              count: number;
            }>(
              "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
              now,
            )
            .next().value?.count ?? 0;
        this.assertSeatCapacityForAdditionalMembers(
          1,
          Math.max(0, activeInvitations - 1),
        );
        addedMember = true;
      }

      const workspaceAccessDefault =
        existingMember?.workspace_access_default ?? "full";
      this.sql.exec(
        "INSERT OR REPLACE INTO members (user_id, role, joined_at, workspace_access_default) VALUES (?, ?, ?, ?)",
        claimedIdentity.userId,
        invitationRow.role,
        now,
        workspaceAccessDefault,
      );
      this.sql.exec(
        "DELETE FROM workspace_memberships WHERE user_id = ?",
        claimedIdentity.userId,
      );
      const activeWorkspaceIds = this.sql
        .exec<{ id: string }>(
          "SELECT id FROM workspaces WHERE archived = 0 ORDER BY created_at ASC",
        )
        .toArray()
        .map((workspace) => workspace.id);
      for (const workspaceId of activeWorkspaceIds) {
        const accessLevel = this.normalizeWorkspaceAccess(
          workspaceAccess?.[workspaceId] ?? "full",
        );
        if (accessLevel === workspaceAccessDefault) continue;
        this.sql.exec(
          `INSERT INTO workspace_memberships (
            workspace_id, user_id, access_level, granted_by, granted_at
          ) VALUES (?, ?, ?, ?, ?)`,
          workspaceId,
          claimedIdentity.userId,
          accessLevel,
          invitationRow.invited_by,
          now,
        );
      }
      this.sql.exec(
        "UPDATE enterprise_sso_identities SET membership_revoked = 0 WHERE user_id = ?",
        claimedIdentity.userId,
      );
      this.sql.exec("DELETE FROM invitations WHERE id = ?", invitationRow.id);

      return { ...claimedIdentity, membershipRevoked: false };
    });

    const invitation = acceptedInvitation as OrgInvitation | null;
    if (!identity || (!invitation && !reusedActiveIdentity)) return null;
    if (!invitation) return identity;
    if (addedMember) {
      this.log("member_added", identity.userId, identity.userId, {
        role: invitation.role,
        source: "enterprise-sso-invitation",
      });
      const info = await this.getInfo();
      if (info) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "org_member_delta",
          payload: { org_id: info.id, delta: 1 },
        });
      }
      this.dispatchOrgMembershipUpsert(identity.userId, invitation.role, now);
    }
    dispatchAdminEvent(this.ctx, this.env, {
      type: "invitation_delete",
      payload: { id: invitation.id },
    });
    return identity;
  }

  bindSsoIdentity(
    connectionId: string,
    issuer: string,
    subject: string,
    userId: string,
    email: string,
    allowCrossConnectionRebind = false,
  ): string | null {
    const normalizedEmail = email.trim().toLowerCase();
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getSsoIdentity(connectionId, issuer, subject);
      const conflictingEmailIdentity = this.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM enterprise_sso_identities
            WHERE email = ? AND user_id != ?
            LIMIT 1`,
          normalizedEmail,
          userId,
        )
        .next().value;
      if (conflictingEmailIdentity) return null;
      if (existing) {
        return existing.userId === userId &&
          existing.email === normalizedEmail
          ? userId
          : null;
      }
      if (this.getSsoIdentityByEmail(connectionId, issuer, normalizedEmail)) {
        return null;
      }
      const priorEmailIdentity = this.sql
        .exec<{ user_id: string }>(
          `SELECT user_id FROM enterprise_sso_identities
            WHERE email = ?
            ORDER BY linked_at ASC
            LIMIT 1`,
          normalizedEmail,
        )
        .next().value;
      if (
        priorEmailIdentity &&
        (!allowCrossConnectionRebind ||
          priorEmailIdentity.user_id !== userId)
      ) {
        return null;
      }
      this.sql.exec(
        `INSERT INTO enterprise_sso_identities
          (connection_id, issuer, subject, user_id, email, tenant_scoped,
           membership_revoked, linked_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
        connectionId,
        issuer,
        subject,
        userId,
        normalizedEmail,
        Date.now(),
      );
      return userId;
    });
  }

  getModelPickerConfig(): OrgModelPickerConfig {
    const llmProviderConfig = this.getLlmProviderConfig();
    const customApi = getStoredCustomLlmProviderApi(llmProviderConfig);
    const customModelId = getStoredCustomLlmProviderModelId(llmProviderConfig);
    const rows = this.sql
      .exec<{
        value: string;
      }>("SELECT value FROM org_info WHERE key = ?", ORG_MODEL_PICKER_CONFIG_KEY)
      .toArray();
    if (rows.length === 0) {
      return defaultOrgModelPickerConfig(llmProviderConfig?.provider, {
        customApi,
        customModelId,
      });
    }

    return parseOrgModelPickerConfig(rows[0]!.value, llmProviderConfig?.provider, {
      customApi,
      customModelId,
    });
  }

  setModelPickerConfig(
    config: OrgModelPickerConfig,
    audit?: {
      actorId?: string;
      action?: string;
      details?: Record<string, unknown>;
    },
  ): OrgModelPickerConfig {
    const previous = this.getModelPickerConfig();
    const llmProviderConfig = this.getLlmProviderConfig();
    const customApi = getStoredCustomLlmProviderApi(llmProviderConfig);
    const customModelId = getStoredCustomLlmProviderModelId(llmProviderConfig);
    const next = parseOrgModelPickerConfig(
      config,
      llmProviderConfig?.provider,
      { customApi, customModelId },
    );

    this.sql.exec(
      "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
      ORG_MODEL_PICKER_CONFIG_KEY,
      JSON.stringify(next),
    );

    if (audit?.actorId) {
      this.log(audit.action ?? "model_picker_config_updated", audit.actorId, undefined, {
        ...audit.details,
        previous_default_model: previous.default_model,
        next_default_model: next.default_model,
        previous_model_count: previous.models.length,
        next_model_count: next.models.length,
      });
    }

    return next;
  }

  async createOrg(
    id: string,
    name: string,
    createdBy: string,
    initialRole: OrgRole = "owner",
    workspaceId: string = crypto.randomUUID(),
  ): Promise<{ org: Organization; defaultWorkspaceId: string }> {
    const now = Date.now();
    let info = await this.getInfo();
    let created = false;

    if (!info) {
      const slug = await generateUniqueOrgSlug(id, this.env.APP_KV);
      await registerOrgSlug(this.env.APP_KV, slug, id);
      info = {
        id,
        name,
        slug,
        created_at: now,
        created_by: createdBy,
        billing_status: "inactive",
        billing_plan: "payg",
        billing_seat_count: 1,
        billing_customer_id: null,
        billing_subscription_id: null,
        billing_subscription_status: null,
        billing_trial_started_at: null,
        billing_trial_ends_at: null,
        billing_credit_purchase_total_cents: 0,
        billing_credit_grant_total_cents: 0,
        billing_trial_credit_grant_cents: 0,
        billing_trial_credit_granted_at: null,
        billing_last_included_credit_invoice_id: null,
        billing_credit_usage_started_at: null,
        archived: false,
        archived_at: null,
        archived_by: null,
      };
      await this.setInfo(info);
      created = true;
    } else if (info.id !== id || info.created_by !== createdBy) {
      throw new Error("signup_org_conflict");
    }

    try {
      // Add creator with the role chosen by the auth flow. Normal app-created
      // orgs use the default owner role; SSO-created orgs may start as members.
      if (!(await this.getMember(createdBy))) {
        await this.addMember(createdBy, initialRole, createdBy);
      }
      if (created) {
        this.log("org_created", createdBy, id, { name });
      }

      const workspaceExists = (await this.getWorkspaces()).some(
        (workspace) => workspace.id === workspaceId,
      );
      if (!workspaceExists) {
        await this.createWorkspaceRecord(
          workspaceId,
          "Default Workspace",
          createdBy,
          null,
        );
      }
      await this.setWorkspaceAccess(workspaceId, createdBy, "full", createdBy);

      try {
        await this.indexOrg(id);
      } catch {
        // Best-effort indexing; do not fail org creation on APP_KV hiccups.
      }

      return { org: info, defaultWorkspaceId: workspaceId };
    } catch (error) {
      try {
        await this.unindexOrg(id);
      } catch {
        // Best-effort rollback for org index.
      }
      throw error;
    }
  }

  async ensureAccessMappedOrg(
    kvKey: string,
    name: string,
    userId: string,
    role: OrgRole,
  ): Promise<{ org: Organization; defaultWorkspaceId: string | null }> {
    // This lock DO instance (keyed by kvKey) is the authoritative owner of the
    // mapping: APP_KV is eventually consistent and its write can fail after
    // the org already exists, so the org id is also recorded in DO storage to
    // prevent a duplicate org from being created on retry.
    const locallyMappedOrgId =
      this.ctx.storage.kv.get<string>(OrgDO.ACCESS_MAPPED_ORG_ID_KEY) ?? null;
    const kvMappedOrgId = await this.env.APP_KV.get(kvKey);
    const existingOrgId = kvMappedOrgId ?? locallyMappedOrgId;
    if (existingOrgId) {
      const existingOrgStub = this.env.ORG.get(
        this.env.ORG.idFromName(existingOrgId),
      );
      const existingOrg = await existingOrgStub.getInfo();
      if (existingOrg) {
        if (!kvMappedOrgId) {
          // Heal a mapping lost to an earlier APP_KV write failure.
          await this.env.APP_KV.put(kvKey, existingOrgId);
        }
        const workspaces = await existingOrgStub.getWorkspaces();
        const defaultWorkspaceId =
          workspaces.find((workspace) => !workspace.archived)?.id ?? null;
        return { org: existingOrg, defaultWorkspaceId };
      }
    }
    if (role !== "admin") {
      throw new Error("Cloudflare Access orgs must be initialized by an admin");
    }

    const orgId = crypto.randomUUID();
    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const created = await orgStub.createOrg(orgId, name, userId, "owner");
    const userStub = this.env.USER.get(this.env.USER.idFromName(userId));
    await userStub.addOrg(orgId, "owner", created.defaultWorkspaceId);
    this.ctx.storage.kv.put(OrgDO.ACCESS_MAPPED_ORG_ID_KEY, orgId);
    await this.env.APP_KV.put(kvKey, orgId);
    return created;
  }

  /**
   * Strongly consistent read of the Access org mapping owned by this lock DO.
   * Used by session validators when the eventually consistent APP_KV mapping
   * is not visible yet.
   */
  async getAccessMappedOrgId(): Promise<string | null> {
    return (
      this.ctx.storage.kv.get<string>(OrgDO.ACCESS_MAPPED_ORG_ID_KEY) ?? null
    );
  }

  async updateName(name: string, actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (info) {
      const previousName = info.name;
      info.name = name;
      await this.setInfo(info);
      if (previousName !== name) {
        this.log("org_updated", actorId, info.id, {
          previous_name: previousName,
          name,
        });
      }
    }
  }

  async updateBillingState(
    updates: OrgBillingStateUpdate,
  ): Promise<Organization | null> {
    const info = await this.getInfo();
    if (!info) return null;

    const nextInfo: Organization = {
      ...info,
      ...updates,
    };
    normalizeOrgBillingFields(nextInfo);

    await this.setInfo(nextInfo);
    return nextInfo;
  }

  syncSubscriptionBillingState(
    updates: OrgBillingStateUpdate,
    trialCreditGrantCents: number,
  ): SyncSubscriptionBillingStateResult | null {
    const normalizedTrialCreditGrantCents = Math.max(
      0,
      Math.floor(trialCreditGrantCents),
    );

    const result = this.ctx.storage.transactionSync(() => {
      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;

      const nextInfo: Organization = {
        ...existingOrg,
        ...updates,
      };
      let trialCreditGranted = false;
      const existingTrialUsed = Boolean(
        existingOrg.billing_trial_started_at ||
          existingOrg.billing_trial_ends_at ||
          existingOrg.billing_trial_credit_granted_at,
      );

      if (
        normalizedTrialCreditGrantCents > 0 &&
        existingOrg.billing_status !== "enterprise" &&
        updates.billing_status === "trialing" &&
        updates.billing_trial_started_at &&
        updates.billing_trial_ends_at &&
        !existingTrialUsed
      ) {
        nextInfo.billing_credit_grant_total_cents =
          (existingOrg.billing_credit_grant_total_cents ?? 0) +
          normalizedTrialCreditGrantCents;
        nextInfo.billing_trial_credit_grant_cents =
          normalizedTrialCreditGrantCents;
        nextInfo.billing_trial_credit_granted_at = Date.now();
        trialCreditGranted = true;
      } else {
        nextInfo.billing_credit_grant_total_cents =
          existingOrg.billing_credit_grant_total_cents ?? 0;
        nextInfo.billing_trial_credit_grant_cents =
          existingOrg.billing_trial_credit_grant_cents ?? 0;
        nextInfo.billing_trial_credit_granted_at =
          existingOrg.billing_trial_credit_granted_at ?? null;
      }

      normalizeOrgBillingFields(nextInfo);
      const capacityInvariantError =
        this.getBillingStateCapacityInvariantError(nextInfo);
      if (capacityInvariantError) {
        return {
          org: existingOrg,
          trialCreditGranted: false,
          capacityInvariantError,
        };
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );

      return {
        org: nextInfo,
        trialCreditGranted,
        capacityInvariantError: null,
      };
    });

    return result;
  }

  applyCreditCheckout(
    sessionId: string,
    amountCents: number,
    customerId: string | null,
  ): ApplyCreditCheckoutResult | null {
    const trimmedSessionId = sessionId.trim();
    const normalizedAmountCents = Math.max(0, Math.floor(amountCents));
    if (!trimmedSessionId || normalizedAmountCents <= 0) return null;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stripe_credit_checkouts (
        session_id TEXT PRIMARY KEY,
        amount_cents INTEGER NOT NULL,
        customer_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const result = this.ctx.storage.transactionSync(() => {
      const existingCheckout = this.sql
        .exec(
          "SELECT session_id FROM stripe_credit_checkouts WHERE session_id = ?",
          trimmedSessionId,
        )
        .toArray();
      if (existingCheckout.length > 0) {
        const existingOrg = this.getInfoSync();
        return existingOrg ? { org: existingOrg, applied: false } : null;
      }

      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;

      const nextInfo: Organization = {
        ...existingOrg,
        billing_customer_id:
          customerId ?? existingOrg.billing_customer_id ?? null,
        billing_credit_purchase_total_cents:
          (existingOrg.billing_credit_purchase_total_cents ?? 0) +
          normalizedAmountCents,
      };

      this.sql.exec(
        "INSERT INTO stripe_credit_checkouts (session_id, amount_cents, customer_id, created_at) VALUES (?, ?, ?, ?)",
        trimmedSessionId,
        normalizedAmountCents,
        customerId,
        Date.now(),
      );
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );
      return { org: nextInfo, applied: true };
    });

    if (result?.applied) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_upsert",
        payload: result.org,
      });
    }
    return result;
  }

  private ensureStripeSubscriptionInvoiceGrantsTable(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS stripe_subscription_invoice_grants (
        invoice_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        billing_reason TEXT NOT NULL,
        source TEXT NOT NULL,
        plan TEXT NOT NULL,
        seat_count INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  applySubscriptionInvoiceGrant(
    command: SubscriptionInvoiceGrantCommand,
    options: { legacyProcessed?: boolean } = {},
  ): ApplySubscriptionInvoiceGrantResult | null {
    const normalized: SubscriptionInvoiceGrantCommand = {
      invoiceId: command.invoiceId.trim(),
      subscriptionId: command.subscriptionId.trim(),
      customerId: command.customerId.trim(),
      billingReason: command.billingReason,
      source: command.source,
      plan: command.plan,
      seatCount: Math.max(1, Math.floor(command.seatCount)),
      grantCents: Math.max(0, Math.floor(command.grantCents)),
    };
    if (
      !normalized.invoiceId ||
      !normalized.subscriptionId ||
      !normalized.customerId ||
      !["subscription_create", "subscription_cycle", "subscription_update"].includes(
        normalized.billingReason,
      ) ||
      !["initial", "renewal", "plan_change", "legacy_migration"].includes(normalized.source) ||
      !["starter", "pro", "team"].includes(normalized.plan)
    ) {
      throw new Error("Invalid Stripe subscription invoice grant command.");
    }

    this.ensureStripeSubscriptionInvoiceGrantsTable();
    this.ensureAdminCreditGrantsTable();
    const result = this.ctx.storage.transactionSync(() => {
      const existingRow = this.sql
        .exec<SubscriptionInvoiceGrantRow>(
          `SELECT invoice_id, subscription_id, customer_id, billing_reason, source,
                  plan, seat_count, amount_cents, created_at
           FROM stripe_subscription_invoice_grants WHERE invoice_id = ?`,
          normalized.invoiceId,
        )
        .toArray()[0];
      if (existingRow) {
        const existingOrg = this.getInfoSync();
        if (!existingOrg) return null;
        const legacy = existingRow.source === "legacy_processed";
        const matches =
          existingRow.subscription_id === normalized.subscriptionId &&
          existingRow.customer_id === normalized.customerId &&
          existingRow.billing_reason === normalized.billingReason &&
          (legacy || existingRow.source === normalized.source) &&
          existingRow.plan === normalized.plan &&
          Number(existingRow.seat_count) === normalized.seatCount &&
          (legacy || Number(existingRow.amount_cents) === normalized.grantCents);
        return {
          org: existingOrg,
          applied: false,
          credited: false,
          legacyProcessed: legacy,
          invariantError: matches
            ? null
            : `Invoice ${normalized.invoiceId} was already recorded with conflicting immutable grant fields.`,
        };
      }

      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;
      const legacyGrantId = `legacy-migration:${existingOrg.id}:${normalized.subscriptionId}:${normalized.plan}:current-period-included-credits`;
      const hasLegacyManualGrant =
        normalized.source === "legacy_migration" &&
        this.sql
          .exec("SELECT grant_id FROM admin_credit_grants WHERE grant_id = ?", legacyGrantId)
          .toArray().length > 0;
      const legacyProcessed = Boolean(
        options.legacyProcessed ||
          existingOrg.billing_last_included_credit_invoice_id === normalized.invoiceId ||
          hasLegacyManualGrant,
      );
      const createdAt = Date.now();
      const credited =
        !legacyProcessed &&
        existingOrg.billing_status !== "enterprise" &&
        normalized.grantCents > 0;
      const nextInfo: Organization = {
        ...existingOrg,
        billing_credit_grant_total_cents: credited
          ? (existingOrg.billing_credit_grant_total_cents ?? 0) + normalized.grantCents
          : (existingOrg.billing_credit_grant_total_cents ?? 0),
        billing_last_included_credit_invoice_id: credited
          ? normalized.invoiceId
          : (existingOrg.billing_last_included_credit_invoice_id ?? null),
        billing_credit_usage_started_at: credited
          ? (existingOrg.billing_credit_usage_started_at ?? createdAt)
          : (existingOrg.billing_credit_usage_started_at ?? null),
      };
      normalizeOrgBillingFields(nextInfo);
      this.sql.exec(
        `INSERT INTO stripe_subscription_invoice_grants
          (invoice_id, subscription_id, customer_id, billing_reason, source,
           plan, seat_count, amount_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        normalized.invoiceId,
        normalized.subscriptionId,
        normalized.customerId,
        normalized.billingReason,
        legacyProcessed ? "legacy_processed" : normalized.source,
        normalized.plan,
        normalized.seatCount,
        legacyProcessed ? 0 : normalized.grantCents,
        createdAt,
      );
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );
      return {
        org: nextInfo,
        applied: true,
        credited,
        legacyProcessed,
        invariantError: null,
      };
    });

    if (result?.applied) {
      dispatchAdminEvent(this.ctx, this.env, { type: "org_upsert", payload: result.org });
    }
    return result;
  }

  getSubscriptionInvoiceGrant(invoiceId: string): SubscriptionInvoiceGrantRow | null {
    this.ensureStripeSubscriptionInvoiceGrantsTable();
    return (
      this.sql
        .exec<SubscriptionInvoiceGrantRow>(
          `SELECT invoice_id, subscription_id, customer_id, billing_reason, source,
                  plan, seat_count, amount_cents, created_at
           FROM stripe_subscription_invoice_grants WHERE invoice_id = ?`,
          invoiceId.trim(),
        )
        .toArray()[0] ?? null
    );
  }

  applyManualCreditGrant(
    amountCents: number,
    reason?: string | null,
    idempotencyKey?: string | null,
    options: {
      createdBy?: string | null;
      source?: string | null;
    } = {},
  ): ApplyManualCreditGrantResult | null {
    const normalizedAmountCents = Math.floor(amountCents);
    if (!Number.isFinite(normalizedAmountCents)) return null;
    if (normalizedAmountCents <= 0) return null;

    const trimmedReason = reason?.trim() ? reason.trim().slice(0, 500) : null;
    const trimmedIdempotencyKey = idempotencyKey?.trim()
      ? idempotencyKey.trim().slice(0, 200)
      : null;
    const grantId =
      trimmedIdempotencyKey ?? `manual:${Date.now()}:${crypto.randomUUID()}`;
    const normalizedCreatedBy = options.createdBy?.trim()
      ? options.createdBy.trim().slice(0, 200)
      : null;
    const normalizedSource = options.source?.trim()
      ? options.source.trim().slice(0, 100)
      : null;

    this.ensureAdminCreditGrantsTable();

    const result = this.ctx.storage.transactionSync(() => {
      const existingGrant = this.sql
        .exec<ManualCreditGrantRow>(
          `
          SELECT grant_id, amount_cents, reason, created_at, created_by, source
          FROM admin_credit_grants
          WHERE grant_id = ?
          `,
          grantId,
        )
        .toArray();
      if (existingGrant.length > 0) {
        const existing = existingGrant[0];
        const existingOrg = this.getInfoSync();
        return existingOrg
          ? {
              org: existingOrg,
              applied: false,
              grantId,
              amountCents: Number(
                existing.amount_cents ?? normalizedAmountCents,
              ),
              reason:
                typeof existing.reason === "string"
                  ? existing.reason
                  : null,
              createdAt: Number(existing.created_at),
              createdBy:
                typeof existing.created_by === "string"
                  ? existing.created_by
                  : null,
              source:
                typeof existing.source === "string" ? existing.source : null,
            }
          : null;
      }

      const existingOrg = this.getInfoSync();
      if (!existingOrg) return null;

      const createdAt = Date.now();
      const nextInfo: Organization = {
        ...existingOrg,
        billing_credit_grant_total_cents:
          (existingOrg.billing_credit_grant_total_cents ?? 0) +
          normalizedAmountCents,
        billing_credit_usage_started_at:
          existingOrg.billing_credit_usage_started_at ?? createdAt,
      };

      normalizeOrgBillingFields(nextInfo);
      this.sql.exec(
        `
        INSERT INTO admin_credit_grants
          (grant_id, amount_cents, reason, created_at, created_by, source)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        grantId,
        normalizedAmountCents,
        trimmedReason,
        createdAt,
        normalizedCreatedBy,
        normalizedSource,
      );
      this.sql.exec(
        "INSERT OR REPLACE INTO org_info (key, value) VALUES (?, ?)",
        "data",
        JSON.stringify(nextInfo),
      );
      this.log(
        "usage_credit_granted",
        normalizedCreatedBy ?? normalizedSource ?? "system-admin",
        existingOrg.id,
        {
          grant_id: grantId,
          amount_cents: normalizedAmountCents,
          reason: trimmedReason,
          source: normalizedSource,
        },
      );

      return {
        org: nextInfo,
        applied: true,
        grantId,
        amountCents: normalizedAmountCents,
        reason: trimmedReason,
        createdAt,
        createdBy: normalizedCreatedBy,
        source: normalizedSource,
      };
    });

    if (result?.applied) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_upsert",
        payload: result.org,
      });
    }
    return result;
  }

  private ensureAdminCreditGrantsTable(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS admin_credit_grants (
        grant_id TEXT PRIMARY KEY,
        amount_cents INTEGER NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    const columns = new Set(
      this.sql
        .exec<{ name: string }>("PRAGMA table_info(admin_credit_grants)")
        .toArray()
        .map((column) => String(column.name)),
    );

    if (!columns.has("created_by")) {
      this.sql.exec(
        "ALTER TABLE admin_credit_grants ADD COLUMN created_by TEXT",
      );
    }
    if (!columns.has("source")) {
      this.sql.exec("ALTER TABLE admin_credit_grants ADD COLUMN source TEXT");
    }
  }

  listManualCreditGrants(limit = 25): ManualCreditGrantRecord[] {
    this.ensureAdminCreditGrantsTable();
    const resolvedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.sql
      .exec<ManualCreditGrantRow>(
        `
        SELECT grant_id, amount_cents, reason, created_at, created_by, source
        FROM admin_credit_grants
        ORDER BY created_at DESC
        LIMIT ?
        `,
        resolvedLimit,
      )
      .toArray()
      .map((row) => ({
        grant_id: String(row.grant_id),
        amount_cents: Number(row.amount_cents),
        reason: typeof row.reason === "string" ? row.reason : null,
        created_at: Number(row.created_at),
        created_by: typeof row.created_by === "string" ? row.created_by : null,
        source: typeof row.source === "string" ? row.source : null,
      }));
  }

  // Member methods
  async getMembers(): Promise<OrgMember[]> {
    this.ensureOwnerExists("system");
    return this.sql
      .exec(
        "SELECT user_id, role, joined_at, workspace_access_default FROM members ORDER BY joined_at ASC",
      )
      .toArray() as unknown as OrgMember[];
  }

  async getMember(userId: string): Promise<OrgMember | null> {
    const rows = this.sql
      .exec(
        "SELECT user_id, role, joined_at, workspace_access_default FROM members WHERE user_id = ?",
        userId,
      )
      .toArray() as unknown as OrgMember[];
    return rows[0] || null;
  }

  private dispatchOrgMembershipUpsert(
    userId: string,
    role: OrgRole,
    joinedAt: number,
  ): void {
    this.getInfo().then((info) => {
      if (!info) return;
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_membership_upsert",
        payload: {
          org_id: info.id,
          user_id: userId,
          role,
          joined_at: joinedAt,
        },
      });
    });
  }

  private dispatchOrgMembershipDelete(userId: string): void {
    this.getInfo().then((info) => {
      if (!info) return;
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_membership_delete",
        payload: {
          org_id: info.id,
          user_id: userId,
        },
      });
    });
  }

  async addMember(
    userId: string,
    role: OrgRole,
    actorId: string,
    options: {
      workspaceAccessDefault?: WorkspaceAccessLevel;
      initialWorkspaceId?: string | null;
      workspaceAccessRows?: Array<{
        workspaceId: string;
        accessLevel: WorkspaceAccessLevel;
      }>;
    } = {},
  ): Promise<void> {
    const now = Date.now();
    const workspaceAccessDefault =
      options.workspaceAccessDefault === "none" ? "none" : "full";
    let existing: OrgMember | null = null;
    this.ctx.storage.transactionSync(() => {
      existing =
        (this.sql
          .exec<OrgMember & Record<string, SqlStorageValue>>(
            "SELECT user_id, role, joined_at, workspace_access_default FROM members WHERE user_id = ?",
            userId,
          )
          .next().value as OrgMember | undefined) ?? null;
      if (!existing) {
        this.assertSeatCapacityForNewMember();
      }
      if (options.initialWorkspaceId) {
        const workspace = this.sql
          .exec<{ archived: number }>(
            "SELECT archived FROM workspaces WHERE id = ?",
            options.initialWorkspaceId,
          )
          .next().value;
        if (!workspace || workspace.archived === 1) {
          throw new Error("Initial workspace is unavailable");
        }
      }
      this.sql.exec(
        "INSERT OR REPLACE INTO members (user_id, role, joined_at, workspace_access_default) VALUES (?, ?, ?, ?)",
        userId,
        role,
        now,
        existing?.workspace_access_default ?? workspaceAccessDefault,
      );
      if (options.initialWorkspaceId) {
        this.sql.exec(
          `INSERT INTO workspace_memberships (
            workspace_id, user_id, access_level, granted_by, granted_at
          ) VALUES (?, ?, 'full', ?, ?)
          ON CONFLICT(workspace_id, user_id) DO UPDATE SET
            access_level = 'full',
            granted_by = excluded.granted_by,
            granted_at = excluded.granted_at`,
          options.initialWorkspaceId,
          userId,
          actorId,
          now,
        );
      }
      if (options.workspaceAccessRows) {
        this.sql.exec(
          "DELETE FROM workspace_memberships WHERE user_id = ?",
          userId,
        );
        for (const access of options.workspaceAccessRows) {
          this.sql.exec(
            `INSERT INTO workspace_memberships (
              workspace_id, user_id, access_level, granted_by, granted_at
            ) VALUES (?, ?, ?, ?, ?)`,
            access.workspaceId,
            userId,
            this.normalizeWorkspaceAccess(access.accessLevel),
            actorId,
            now,
          );
        }
      }
      this.sql.exec(
        "UPDATE enterprise_sso_identities SET membership_revoked = 0 WHERE user_id = ?",
        userId,
      );
    });
    if (!existing) {
      this.log("member_added", actorId, userId, { role });
      const info = await this.getInfo();
      if (info) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "org_member_delta",
          payload: { org_id: info.id, delta: 1 },
        });
      }
      this.dispatchOrgMembershipUpsert(userId, role, now);
    }
  }

  private assertSeatCapacityForNewMember(): void {
    this.assertSeatCapacityForAdditionalMembers(1);
  }

  private getBillingStateCapacityInvariantError(
    info: Organization,
  ): string | null {
    if (
      info.billing_status !== "active" &&
      info.billing_status !== "trialing" &&
      info.billing_status !== "past_due"
    ) {
      return null;
    }
    const seatLimit = getOrgSeatLimit(info);
    if (seatLimit === null) return null;

    const currentMembers =
      this.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM members")
        .next().value?.count ?? 0;
    const activeInvitations =
      this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
          Date.now(),
        )
        .next().value?.count ?? 0;
    const occupiedSeatCount = currentMembers + activeInvitations;
    if (occupiedSeatCount > seatLimit) {
      return `The projected billing plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}, but this organization has ${occupiedSeatCount} occupied seats.`;
    }
    return null;
  }

  private assertSeatCapacityForAdditionalMembers(
    additionalSeatCount: number,
    reservedInvitations?: number,
  ): void {
    const info = this.getInfoSync();
    if (!info) return;

    const seatLimit = getOrgSeatLimit(info);
    if (seatLimit === null) return;
    const normalizedAdditionalSeatCount = Math.max(0, additionalSeatCount);

    const currentMembers =
      this.sql.exec<{ count: number }>("SELECT COUNT(*) as count FROM members")
        .next().value?.count ?? 0;
    const activeInvitations =
      reservedInvitations ??
      (this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
          Date.now(),
        )
        .next().value?.count ??
        0);
    if (currentMembers + activeInvitations + normalizedAdditionalSeatCount > seatLimit) {
      throw new Error(
        `Your current billing plan includes ${seatLimit} seat${seatLimit === 1 ? "" : "s"}.`,
      );
    }
  }

  async removeMember(userId: string, actorId: string): Promise<void> {
    const existing = await this.getMember(userId);
    if (existing?.role === "owner") {
      throw new Error(
        "Cannot remove the organization owner. Transfer ownership first.",
      );
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM members WHERE user_id = ?", userId);
      this.sql.exec("DELETE FROM workspace_memberships WHERE user_id = ?", userId);
      this.sql.exec("DELETE FROM user_llm_usage_limits WHERE user_id = ?", userId);
      this.sql.exec(
        "UPDATE enterprise_sso_identities SET membership_revoked = 1 WHERE user_id = ?",
        userId,
      );
    });
    if (existing) {
      this.log("member_removed", actorId, userId, { role: existing.role });
      const info = await this.getInfo();
      if (info) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "org_member_delta",
          payload: { org_id: info.id, delta: -1 },
        });
      }
      this.dispatchOrgMembershipDelete(userId);
    }
    this.ensureOwnerExists(actorId);
  }

  async updateMemberRole(
    userId: string,
    role: OrgRole,
    actorId: string,
  ): Promise<void> {
    const existing = await this.getMember(userId);
    if (role === "owner") {
      throw new Error("Use transferOwnership to assign owner role");
    }
    if (existing?.role === "owner") {
      throw new Error(
        "Cannot change the owner role. Transfer ownership first.",
      );
    }
    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      role,
      userId,
    );
    if (existing && existing.role !== role) {
      this.log("member_role_changed", actorId, userId, {
        old_role: existing.role,
        new_role: role,
      });
      this.dispatchOrgMembershipUpsert(userId, role, existing.joined_at);
    }
    this.ensureOwnerExists(actorId);
  }

  async isMember(userId: string): Promise<boolean> {
    const rows = this.sql
      .exec("SELECT 1 FROM members WHERE user_id = ?", userId)
      .toArray();
    return rows.length > 0;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        "SELECT 1 FROM members WHERE user_id = ? AND role IN (?, ?)",
        userId,
        "owner",
        "admin",
      )
      .toArray();
    return rows.length > 0;
  }

  async isOwner(userId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        "SELECT 1 FROM members WHERE user_id = ? AND role = ?",
        userId,
        "owner",
      )
      .toArray();
    return rows.length > 0;
  }

  async getMemberCount(): Promise<number> {
    const rows = this.sql
      .exec("SELECT COUNT(*) as count FROM members")
      .toArray();
    return (rows[0] as { count: number }).count;
  }

  private ensureOwnerExists(actorId: string): void {
    const ownerRows = this.sql
      .exec("SELECT user_id FROM members WHERE role = ? LIMIT 1", "owner")
      .toArray() as Array<{ user_id: string }>;
    if (ownerRows.length > 0) return;

    const fallbackRows = this.sql
      .exec(
        `SELECT user_id, role, joined_at FROM members
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at ASC
       LIMIT 1`,
      )
      .toArray() as Array<{ user_id: string }>;
    const fallback = fallbackRows[0];
    if (!fallback) return;

    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "owner",
      fallback.user_id,
    );
    this.log("owner_recovered", actorId, fallback.user_id);
  }

  // Invitation methods
  async getInvitations(): Promise<OrgInvitation[]> {
    const rows = this.sql
      .exec(
        "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations ORDER BY created_at DESC",
      )
      .toArray() as unknown as Array<
      Omit<OrgInvitation, "workspace_access"> & {
        workspace_access?: string | null;
      }
    >;
    return rows.map((row) => ({
      ...row,
      workspace_access: row.workspace_access
        ? JSON.parse(row.workspace_access)
        : null,
    }));
  }

  async getInvitation(id: string): Promise<OrgInvitation | null> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations WHERE id = ? AND expires_at > ?",
        id,
        now,
      )
      .toArray() as unknown as Array<
      Omit<OrgInvitation, "workspace_access"> & {
        workspace_access?: string | null;
      }
    >;
    if (!rows[0]) return null;
    return {
      ...rows[0],
      workspace_access: rows[0].workspace_access
        ? JSON.parse(rows[0].workspace_access)
        : null,
    };
  }

  async getInvitationByEmail(email: string): Promise<OrgInvitation | null> {
    const now = Date.now();
    const rows = this.sql
      .exec(
        "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations WHERE email = ? AND expires_at > ?",
        email.toLowerCase(),
        now,
      )
      .toArray() as unknown as Array<
      Omit<OrgInvitation, "workspace_access"> & {
        workspace_access?: string | null;
      }
    >;
    if (!rows[0]) return null;
    return {
      ...rows[0],
      workspace_access: rows[0].workspace_access
        ? JSON.parse(rows[0].workspace_access)
        : null,
    };
  }

  async createInvitation(
    email: string,
    role: OrgRole,
    invitedBy: string,
    workspaceAccess?: Record<string, "full" | "none"> | null,
  ): Promise<OrgInvitation> {
    const [invitation] = await this.createInvitations([email], role, invitedBy, {
      workspaceAccess,
    });
    return invitation;
  }

  async createInvitations(
    emails: string[],
    role: OrgRole,
    invitedBy: string,
    options: {
      workspaceAccess?: Record<string, "full" | "none"> | null;
    } = {},
  ): Promise<OrgInvitation[]> {
    if (role === "owner") {
      throw new Error("Cannot invite as owner");
    }

    const normalizedEmails = emails.map((email) => email.toLowerCase().trim());
    const seen = new Set<string>();
    for (const email of normalizedEmails) {
      if (!email || seen.has(email)) {
        throw new Error("Invitation emails must be unique");
      }
      seen.add(email);
    }

    const now = Date.now();
    const expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    const workspaceAccess = options.workspaceAccess ?? null;
    const invitations = normalizedEmails.map((email) => ({
      id: crypto.randomUUID(),
      email,
      role,
      invited_by: invitedBy,
      created_at: now,
      expires_at: expiresAt,
      workspace_access: workspaceAccess,
    })) satisfies OrgInvitation[];

    this.ctx.storage.transactionSync(() => {
      const activeInvitations =
        this.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
            now,
          )
          .next().value?.count ?? 0;
      this.assertSeatCapacityForAdditionalMembers(
        normalizedEmails.length,
        activeInvitations,
      );

      for (const email of normalizedEmails) {
        const existing = this.sql
          .exec<{ id: string }>(
            "SELECT id FROM invitations WHERE email = ? AND expires_at > ? LIMIT 1",
            email,
            now,
          )
          .next().value;
        if (existing) {
          throw new Error(`An active invitation already exists for ${email}`);
        }
      }

      for (const invitation of invitations) {
        this.sql.exec(
          "INSERT INTO invitations (id, email, role, invited_by, created_at, expires_at, workspace_access) VALUES (?, ?, ?, ?, ?, ?, ?)",
          invitation.id,
          invitation.email,
          invitation.role,
          invitation.invited_by,
          invitation.created_at,
          invitation.expires_at,
          workspaceAccess ? JSON.stringify(workspaceAccess) : null,
        );
      }
    });

    const info = this.getInfoSync();
    if (info) {
      for (const invitation of invitations) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "invitation_upsert",
          payload: { ...invitation, org_id: info.id },
        });
      }
    }

    return invitations;
  }

  async deleteInvitation(id: string): Promise<void> {
    this.sql.exec("DELETE FROM invitations WHERE id = ?", id);
    dispatchAdminEvent(this.ctx, this.env, {
      type: "invitation_delete",
      payload: { id },
    });
  }

  async updateInvitationWorkspaceAccess(
    invitationId: string,
    workspaceAccess: Record<string, "full" | "none"> | null,
  ): Promise<boolean> {
    const invitation = await this.getInvitation(invitationId);
    if (!invitation) return false;
    this.sql.exec(
      "UPDATE invitations SET workspace_access = ? WHERE id = ?",
      workspaceAccess ? JSON.stringify(workspaceAccess) : null,
      invitationId,
    );
    return true;
  }

  async acceptInvitation(
    invitationId: string,
    userId: string,
  ): Promise<OrgInvitation | null> {
    const now = Date.now();
    let invitation: OrgInvitation | null = null;
    let existingMember: OrgMember | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{
          id: string;
          email: string;
          role: OrgRole;
          invited_by: string;
          created_at: number;
          expires_at: number;
          workspace_access: string | null;
        }>(
          "SELECT id, email, role, invited_by, created_at, expires_at, workspace_access FROM invitations WHERE id = ? AND expires_at > ?",
          invitationId,
          now,
        )
        .next().value;
      if (!row) return;

      invitation = {
        ...row,
        workspace_access: row.workspace_access
          ? JSON.parse(row.workspace_access)
          : null,
      };
      existingMember =
        (this.sql
          .exec<OrgMember & Record<string, SqlStorageValue>>(
            "SELECT user_id, role, joined_at, workspace_access_default FROM members WHERE user_id = ?",
            userId,
          )
          .next().value as OrgMember | undefined) ?? null;
      if (!existingMember) {
        const activeInvitations =
          this.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) as count FROM invitations WHERE expires_at > ?",
              now,
            )
            .next().value?.count ?? 0;
        this.assertSeatCapacityForAdditionalMembers(
          1,
          Math.max(0, activeInvitations - 1),
        );
      }

      this.sql.exec(
        "INSERT OR REPLACE INTO members (user_id, role, joined_at, workspace_access_default) VALUES (?, ?, ?, ?)",
        userId,
        row.role,
        now,
        existingMember?.workspace_access_default ?? "full",
      );
      this.sql.exec(
        "UPDATE enterprise_sso_identities SET membership_revoked = 0 WHERE user_id = ?",
        userId,
      );
      this.sql.exec("DELETE FROM invitations WHERE id = ?", invitationId);
    });

    const acceptedInvitation = invitation as OrgInvitation | null;
    if (!acceptedInvitation) return null;
    if (!existingMember) {
      this.log("member_added", userId, userId, {
        role: acceptedInvitation.role,
      });
      const info = await this.getInfo();
      if (info) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "org_member_delta",
          payload: { org_id: info.id, delta: 1 },
        });
      }
      this.dispatchOrgMembershipUpsert(userId, acceptedInvitation.role, now);
    }
    dispatchAdminEvent(this.ctx, this.env, {
      type: "invitation_delete",
      payload: { id: invitationId },
    });
    return acceptedInvitation;
  }

  async getWorkspaceIntegrations(
    workspaceId: string,
  ): Promise<WorkspaceIntegrationRecord[]> {
    await this.ensureWorkspaceIntegrationsMigrated(workspaceId);
    return this.sql
      .exec<WorkspaceIntegrationRecord & Record<string, SqlStorageValue>>(
        `SELECT i.id, i.integration_type, i.name, i.category, i.auth_method, i.config,
                i.credentials_encrypted, i.created_by, i.created_at, i.updated_at,
                i.deleted_at, i.token_expires_at, i.auth_status, i.auth_error_code,
                i.auth_error_message, i.auth_checked_at, i.reauth_required_at,
                i.verification_status, i.verification_message,
                i.verification_checked_at, i.verification_live, i.verification_strategy,
                i.definition_id, d.payload AS definition
           FROM integrations i
           LEFT JOIN integration_definitions d
             ON d.id = i.definition_id AND d.workspace_id = i.workspace_id
          WHERE i.workspace_id = ? AND i.deleted_at IS NULL
          ORDER BY i.created_at DESC`,
        workspaceId,
      )
      .toArray();
  }

  async getWorkspaceIntegration(
    workspaceId: string,
    id: string,
  ): Promise<WorkspaceIntegrationRecord | null> {
    await this.ensureWorkspaceIntegrationsMigrated(workspaceId);
    return (
      this.sql
        .exec<WorkspaceIntegrationRecord & Record<string, SqlStorageValue>>(
          `SELECT i.id, i.integration_type, i.name, i.category, i.auth_method, i.config,
                  i.credentials_encrypted, i.created_by, i.created_at, i.updated_at,
                  i.deleted_at, i.token_expires_at, i.auth_status, i.auth_error_code,
                  i.auth_error_message, i.auth_checked_at, i.reauth_required_at,
                  i.verification_status, i.verification_message,
                  i.verification_checked_at, i.verification_live, i.verification_strategy,
                  i.definition_id, d.payload AS definition
             FROM integrations i
             LEFT JOIN integration_definitions d
               ON d.id = i.definition_id AND d.workspace_id = i.workspace_id
            WHERE i.workspace_id = ? AND i.id = ? AND i.deleted_at IS NULL`,
          workspaceId,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  async workspaceIntegrationNameExists(
    workspaceId: string,
    integrationType: string,
    name: string,
    excludeId?: string,
  ): Promise<boolean> {
    await this.ensureWorkspaceIntegrationsMigrated(workspaceId);
    const query = excludeId
      ? `SELECT 1 FROM integrations WHERE workspace_id = ? AND integration_type = ? AND name = ? AND deleted_at IS NULL AND id != ? LIMIT 1`
      : `SELECT 1 FROM integrations WHERE workspace_id = ? AND integration_type = ? AND name = ? AND deleted_at IS NULL LIMIT 1`;
    const args = excludeId
      ? [workspaceId, integrationType, name, excludeId]
      : [workspaceId, integrationType, name];
    return this.sql.exec(query, ...args).toArray().length > 0;
  }

  private async hydrateWorkspaceIntegrationsFromWorkspaceDO(
    workspaceId: string,
  ): Promise<number> {
    try {
      const existingIds = new Set(
        this.sql
          .exec<{ id: string }>(
            "SELECT id FROM integrations WHERE workspace_id = ?",
            workspaceId,
          )
          .toArray()
          .map((row) => row.id),
      );
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(workspaceId),
      ) as unknown as {
        getIntegrations(): Promise<WorkspaceIntegrationRecord[]>;
      };
      const records = await workspaceStub.getIntegrations();
      if (records.length === 0) return 0;

      let copiedExpiringToken = false;
      let copiedCount = 0;
      for (const record of records) {
        this.sql.exec(
          `INSERT INTO integrations
           (id, workspace_id, integration_type, name, category, auth_method, config,
            credentials_encrypted, created_by, created_at, updated_at, deleted_at,
            token_expires_at, auth_status, auth_error_code, auth_error_message,
            auth_checked_at, reauth_required_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          record.id,
          workspaceId,
          record.integration_type,
          record.name,
          record.category,
          record.auth_method,
          record.config,
          record.credentials_encrypted,
          record.created_by,
          record.created_at,
          record.updated_at,
          record.deleted_at ?? null,
          record.token_expires_at ?? null,
          record.auth_status ?? "connected",
          record.auth_error_code ?? null,
          record.auth_error_message ?? null,
          record.auth_checked_at ?? null,
          record.reauth_required_at ?? null,
        );
        if (!existingIds.has(record.id)) {
          copiedCount++;
          existingIds.add(record.id);
        }
        if (record.token_expires_at != null && record.deleted_at == null) {
          copiedExpiringToken = true;
        }
      }
      if (copiedExpiringToken) {
        await this.scheduleNextTokenRefresh();
      }
      return copiedCount;
    } catch (error) {
      console.warn("[OrgDO] failed to hydrate workspace integrations", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private workspaceIntegrationsMigrationKey(workspaceId: string): string {
    return `${OrgDO.WORKSPACE_INTEGRATIONS_MIGRATION_PREFIX}${workspaceId}`;
  }

  private isWorkspaceIntegrationsMigrated(workspaceId: string): boolean {
    return this.ctx.storage.kv.get<number>(
      this.workspaceIntegrationsMigrationKey(workspaceId),
    ) === 1;
  }

  private markWorkspaceIntegrationsMigrated(workspaceId: string): void {
    this.ctx.storage.kv.put(this.workspaceIntegrationsMigrationKey(workspaceId), 1);
  }

  private async ensureWorkspaceIntegrationsMigrated(
    workspaceId: string,
  ): Promise<void> {
    if (this.isWorkspaceIntegrationsMigrated(workspaceId)) return;
    await this.hydrateWorkspaceIntegrationsFromWorkspaceDO(workspaceId);
    this.markWorkspaceIntegrationsMigrated(workspaceId);
  }

  private getIntegrationSecretKey(): string {
    const secret = this.env.INTEGRATION_SECRET_KEY;
    if (!secret) {
      throw new Error("INTEGRATION_SECRET_KEY binding is not configured");
    }
    return secret;
  }

  private async hydrateBigQueryCredentials(
    credentialsEncrypted: string,
  ): Promise<{ credentialsEncrypted: string; tokenExpiresAt: number }> {
    const credentials = await decryptCredentials(
      credentialsEncrypted,
      this.getIntegrationSecretKey(),
    );
    const serviceAccountJson = credentials.service_account_json;
    if (typeof serviceAccountJson !== "string" || serviceAccountJson.trim().length === 0) {
      throw new Error("BigQuery integration requires service_account_json");
    }
    const token = await mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson);
    const hydratedCredentials: Record<string, unknown> = {
      ...credentials,
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_at: token.expiresAt,
    };
    return {
      credentialsEncrypted: await encryptCredentials(
        hydratedCredentials,
        this.getIntegrationSecretKey(),
      ),
      tokenExpiresAt: token.expiresAt,
    };
  }

  async createWorkspaceIntegration(
    workspaceId: string,
    id: string,
    integrationType: string,
    name: string,
    category: string,
    authMethod: string,
    config: string,
    credentialsEncrypted: string,
    createdBy: string,
    tokenExpiresAt?: number | null,
    definitionId?: string | null,
  ): Promise<void> {
    if (await this.workspaceIntegrationNameExists(workspaceId, integrationType, name)) {
      throw new Error(
        `An integration named "${name}" already exists for type "${integrationType}". Please choose a different name.`,
      );
    }

    let resolvedCredentialsEncrypted = credentialsEncrypted;
    let resolvedTokenExpiresAt = tokenExpiresAt ?? null;
    if (integrationType === BIGQUERY_INTEGRATION_TYPE) {
      const hydrated = await this.hydrateBigQueryCredentials(credentialsEncrypted);
      resolvedCredentialsEncrypted = hydrated.credentialsEncrypted;
      resolvedTokenExpiresAt = hydrated.tokenExpiresAt;
    }

    const now = Date.now();
    let credentiallessConnection = false;
    if (!resolvedCredentialsEncrypted && (integrationType === "other" || integrationType === "remote_mcp")) {
      try {
        const parsedConfig = JSON.parse(config) as { auth_type?: unknown };
        credentiallessConnection = parsedConfig.auth_type === "none";
      } catch {
        credentiallessConnection = false;
      }
    }
    const initialAuthStatus: WorkspaceIntegrationAuthStatus =
      resolvedCredentialsEncrypted || credentiallessConnection ? "connected" : "setup_incomplete";
    const initialAuthErrorCode =
      initialAuthStatus === "connected" ? null : "AUTH_SETUP_INCOMPLETE";
    const initialAuthErrorMessage =
      initialAuthStatus === "connected"
        ? null
        : "Connection setup is incomplete; credentials are required before tools can be used.";

    this.sql.exec(
      `INSERT INTO integrations
       (id, workspace_id, integration_type, name, category, auth_method, config,
        credentials_encrypted, created_by, created_at, updated_at, deleted_at,
        token_expires_at, auth_status, auth_error_code, auth_error_message,
        auth_checked_at, reauth_required_at, definition_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      integrationType,
      name,
      category,
      authMethod,
      config,
      resolvedCredentialsEncrypted,
      createdBy,
      now,
      now,
      resolvedTokenExpiresAt,
      initialAuthStatus,
      initialAuthErrorCode,
      initialAuthErrorMessage,
      now,
      initialAuthStatus === "connected" ? null : now,
      definitionId ?? null,
    );
    this.log("integration_created", createdBy, id, {
      workspace_id: workspaceId,
      integration_type: integrationType,
      name,
    });
    const workspace = await this.getWorkspaceInfo(workspaceId);
    if (workspace) this.dispatchWorkspaceUpsert(workspace);
    if (resolvedTokenExpiresAt !== null) {
      await this.scheduleNextTokenRefresh();
    }
  }

  async createWorkspaceIntegrationDefinition(
    workspaceId: string,
    id: string,
    slug: string,
    payload: string,
    source: string,
    sourceUrl: string | null,
    createdBy: string,
  ): Promise<void> {
    JSON.parse(payload);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO integration_definitions
       (id, workspace_id, slug, payload, source, source_url, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      slug,
      payload,
      source,
      sourceUrl,
      createdBy,
      now,
      now,
    );
    this.log("integration_definition_created", createdBy, id, {
      workspace_id: workspaceId,
      slug,
      source,
    });
  }

  async getWorkspaceIntegrationDefinition(
    workspaceId: string,
    id: string,
  ): Promise<WorkspaceIntegrationDefinitionRecord | null> {
    return this.sql
      .exec<WorkspaceIntegrationDefinitionRecord & Record<string, SqlStorageValue>>(
        `SELECT id, workspace_id, slug, payload, source, source_url,
                created_by, created_at, updated_at
           FROM integration_definitions
          WHERE workspace_id = ? AND id = ?`,
        workspaceId,
        id,
      )
      .toArray()[0] ?? null;
  }

  async updateWorkspaceIntegration(
    workspaceId: string,
    id: string,
    updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
      tokenExpiresAt?: number | null;
    },
    actorId: string,
  ): Promise<void> {
    const existing = await this.getWorkspaceIntegration(workspaceId, id);
    if (
      updates.name !== undefined &&
      existing &&
      (await this.workspaceIntegrationNameExists(
        workspaceId,
        existing.integration_type,
        updates.name,
        id,
      ))
    ) {
      throw new Error(
        `An integration named "${updates.name}" already exists for type "${existing.integration_type}". Please choose a different name.`,
      );
    }

    if (
      updates.credentialsEncrypted !== undefined &&
      existing?.integration_type === BIGQUERY_INTEGRATION_TYPE
    ) {
      const hydrated = await this.hydrateBigQueryCredentials(updates.credentialsEncrypted);
      updates.credentialsEncrypted = hydrated.credentialsEncrypted;
      updates.tokenExpiresAt = hydrated.tokenExpiresAt;
    }

    const now = Date.now();
    const setClauses: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];
    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      params.push(updates.name);
    }
    if (updates.config !== undefined) {
      setClauses.push("config = ?");
      params.push(updates.config);
    }
    if (updates.credentialsEncrypted !== undefined) {
      setClauses.push("credentials_encrypted = ?");
      params.push(updates.credentialsEncrypted);
      setClauses.push(
        "auth_status = 'connected'",
        "auth_error_code = NULL",
        "auth_error_message = NULL",
        "auth_checked_at = ?",
        "reauth_required_at = NULL",
      );
      params.push(now);
    }
    if (updates.config !== undefined || updates.credentialsEncrypted !== undefined) {
      setClauses.push(
        "verification_status = NULL",
        "verification_message = NULL",
        "verification_checked_at = NULL",
        "verification_live = NULL",
        "verification_strategy = NULL",
      );
    }
    if (updates.tokenExpiresAt !== undefined) {
      setClauses.push("token_expires_at = ?");
      params.push(updates.tokenExpiresAt);
    }
    params.push(workspaceId, id);
    this.sql.exec(
      `UPDATE integrations SET ${setClauses.join(", ")} WHERE workspace_id = ? AND id = ?`,
      ...params,
    );
    this.log("integration_updated", actorId, id, {
      workspace_id: workspaceId,
      changes: Object.keys(updates),
    });
    const workspace = await this.getWorkspaceInfo(workspaceId);
    if (workspace) this.dispatchWorkspaceUpsert(workspace);
    if (updates.tokenExpiresAt !== undefined) {
      await this.scheduleNextTokenRefresh();
    }
  }

  async updateWorkspaceIntegrationAuthStatus(
    workspaceId: string,
    id: string,
    authStatus: WorkspaceIntegrationAuthStatus,
    errorCode?: string | null,
    errorMessage?: string | null,
    actorId = "system",
    expected?: { config: string; credentialsEncrypted: string },
  ): Promise<boolean> {
    const now = Date.now();
    const requiresReauth =
      authStatus === "needs_reauth" ||
      authStatus === "missing_scopes" ||
      authStatus === "setup_incomplete";
    const result = this.sql.exec(
      `UPDATE integrations
       SET auth_status = ?,
           auth_error_code = ?,
           auth_error_message = ?,
           auth_checked_at = ?,
           reauth_required_at = ?,
           updated_at = ?
       WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL
         ${expected ? "AND config = ? AND credentials_encrypted = ?" : ""}`,
      authStatus,
      authStatus === "connected" ? null : errorCode ?? null,
      authStatus === "connected" ? null : errorMessage ?? null,
      now,
      requiresReauth ? now : null,
      now,
      workspaceId,
      id,
      ...(expected ? [expected.config, expected.credentialsEncrypted] : []),
    );
    if (result.rowsWritten === 0) return false;
    this.log("integration_auth_status_updated", actorId, id, {
      workspace_id: workspaceId,
      auth_status: authStatus,
      error_code: authStatus === "connected" ? null : errorCode ?? null,
    });
    return true;
  }

  async updateWorkspaceIntegrationVerification(
    workspaceId: string,
    id: string,
    verification: {
      status: string;
      message: string;
      checkedAt: number;
      live: boolean;
      strategy: string;
    },
    actorId = "system",
    expected: { config: string; credentialsEncrypted: string },
  ): Promise<boolean> {
    const result = this.sql.exec(
      `UPDATE integrations
       SET verification_status = ?,
           verification_message = ?,
           verification_checked_at = ?,
           verification_live = ?,
           verification_strategy = ?
       WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL
         AND config = ? AND credentials_encrypted = ?`,
      verification.status,
      verification.message,
      verification.checkedAt,
      verification.live ? 1 : 0,
      verification.strategy,
      workspaceId,
      id,
      expected.config,
      expected.credentialsEncrypted,
    );
    if (result.rowsWritten === 0) return false;
    this.log("integration_verified", actorId, id, {
      workspace_id: workspaceId,
      status: verification.status,
      live: verification.live,
      strategy: verification.strategy,
    });
    return true;
  }

  async deleteWorkspaceIntegration(
    workspaceId: string,
    id: string,
    actorId: string,
  ): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "UPDATE integrations SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      now,
      now,
      workspaceId,
      id,
    );
    this.log("integration_deleted", actorId, id, { workspace_id: workspaceId });
    const workspace = await this.getWorkspaceInfo(workspaceId);
    if (workspace) this.dispatchWorkspaceUpsert(workspace);
    await this.scheduleNextTokenRefresh();
  }

  private async scheduleNextTokenRefresh(): Promise<void> {
    const rows = this.sql
      .exec<{ token_expires_at: number | null }>(
        `SELECT MIN(token_expires_at) as token_expires_at
           FROM integrations
          WHERE token_expires_at IS NOT NULL
            AND deleted_at IS NULL
            AND (auth_method = 'oauth2' OR integration_type = ? OR integration_type = 'remote_mcp')`,
        BIGQUERY_INTEGRATION_TYPE,
      )
      .toArray();
    const nextExpiry = rows[0]?.token_expires_at ?? null;
    if (!nextExpiry) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const alarmTime = nextExpiry - TOKEN_REFRESH_BUFFER_MS;
    const now = Date.now();
    await this.ctx.storage.setAlarm(alarmTime <= now ? now + 1000 : alarmTime);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.setAlarm(now + TOKEN_REFRESH_FALLBACK_MS);

    try {
      const batchCutoff = now + TOKEN_BATCH_WINDOW_MS;
      const expiringIntegrations = this.sql
        .exec<WorkspaceIntegrationRecord & Record<string, SqlStorageValue>>(
          `SELECT id, integration_type, name, category, auth_method, config,
                  credentials_encrypted, created_by, created_at, updated_at,
                  deleted_at, token_expires_at, auth_status, auth_error_code,
                  auth_error_message, auth_checked_at, reauth_required_at,
                  workspace_id
             FROM integrations
            WHERE token_expires_at IS NOT NULL
              AND token_expires_at <= ?
              AND deleted_at IS NULL
              AND (auth_method = 'oauth2' OR integration_type = ? OR integration_type = 'remote_mcp')
            ORDER BY token_expires_at ASC`,
          batchCutoff,
          BIGQUERY_INTEGRATION_TYPE,
        )
        .toArray();

      for (const integration of expiringIntegrations) {
        try {
          await this.refreshIntegrationToken(integration);
        } catch (error) {
          console.error("[OrgDO] Failed to refresh integration token", {
            integrationId: integration.id,
            integrationType: integration.integration_type,
            error,
          });
          if (error instanceof PermanentRefreshError) {
            const failureAt = Date.now();
            this.sql.exec(
              `UPDATE integrations
                  SET token_expires_at = NULL,
                      auth_status = 'needs_reauth',
                      auth_error_code = 'AUTH_REAUTH_REQUIRED',
                      auth_error_message = ?,
                      auth_checked_at = ?,
                      reauth_required_at = ?,
                      updated_at = ?
                WHERE workspace_id = ? AND id = ?`,
              error.message,
              failureAt,
              failureAt,
              failureAt,
              integration.workspace_id ?? "",
              integration.id,
            );
          } else {
            const retryAtMs =
              error instanceof RetryableRefreshError
                ? clampRetryAtMs(error.retryAtMs, now)
                : now + TOKEN_REFRESH_RETRY_MS;
            this.sql.exec(
              `UPDATE integrations
                  SET token_expires_at = ?, updated_at = ?
                WHERE workspace_id = ? AND id = ?`,
              retryAtMs,
              Date.now(),
              integration.workspace_id ?? "",
              integration.id,
            );
          }
        }
      }

      await this.scheduleNextTokenRefresh();
    } catch (error) {
      console.error("[OrgDO] Alarm handler failed, will retry in 1 hour:", error);
    }
  }

  private async refreshIntegrationToken(
    integration: WorkspaceIntegrationRecord & { workspace_id?: string },
  ): Promise<void> {
    const credentials = await decryptCredentials(
      integration.credentials_encrypted,
      this.getIntegrationSecretKey(),
    );

    let newCredentials: Record<string, unknown>;
    let newExpiresAt: number;
    switch (integration.integration_type) {
      case "notion": {
        const refreshToken = credentials.refresh_token as string | undefined;
        if (!refreshToken) {
          throw new PermanentRefreshError(
            `No refresh token for Notion integration ${integration.id}`,
          );
        }
        ({ credentials: newCredentials, expiresAt: newExpiresAt } =
          await this.refreshNotionToken(refreshToken));
        break;
      }
      case "google_analytics": {
        const refreshToken = credentials.refresh_token as string | undefined;
        if (!refreshToken) {
          throw new PermanentRefreshError(
            `No refresh token for Google Analytics integration ${integration.id}`,
          );
        }
        ({ credentials: newCredentials, expiresAt: newExpiresAt } =
          await this.refreshGoogleAnalyticsToken(refreshToken, credentials));
        break;
      }
      case BIGQUERY_INTEGRATION_TYPE: {
        const serviceAccountJson = credentials.service_account_json;
        if (
          typeof serviceAccountJson !== "string" ||
          serviceAccountJson.trim().length === 0
        ) {
          console.warn("[OrgDO] Missing service_account_json for BigQuery integration", {
            integrationId: integration.id,
          });
          return;
        }
        const token = await mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson);
        newCredentials = {
          ...credentials,
          access_token: token.accessToken,
          token_type: token.tokenType,
          expires_at: token.expiresAt,
        };
        newExpiresAt = token.expiresAt;
        break;
      }
      case "remote_mcp": {
        if ((credentials.auth_type as string | undefined) && credentials.auth_type !== "oauth") {
          return;
        }
        ({ credentials: newCredentials, expiresAt: newExpiresAt } =
          await refreshRemoteMcpOAuthToken(credentials));
        break;
      }
      default:
        console.warn("[OrgDO] Unknown integration type for token refresh", {
          integrationId: integration.id,
          integrationType: integration.integration_type,
        });
        return;
    }

    const encrypted = await encryptCredentials(newCredentials, this.getIntegrationSecretKey());
    const now = Date.now();
    this.sql.exec(
      `UPDATE integrations
          SET credentials_encrypted = ?,
              token_expires_at = ?,
              auth_status = 'connected',
              auth_error_code = NULL,
              auth_error_message = NULL,
              auth_checked_at = ?,
              reauth_required_at = NULL,
              updated_at = ?
        WHERE workspace_id = ? AND id = ?`,
      encrypted,
      newExpiresAt,
      now,
      now,
      integration.workspace_id ?? "",
      integration.id,
    );
    this.log("token_refreshed", "system", integration.id, {
      workspace_id: integration.workspace_id ?? "",
      integration_type: integration.integration_type,
    });
  }

  private async refreshNotionToken(refreshToken: string): Promise<{
    credentials: Record<string, unknown>;
    expiresAt: number;
  }> {
    if (!this.env.NOTION_CLIENT_ID || !this.env.NOTION_CLIENT_SECRET) {
      throw new Error("Notion OAuth credentials not configured");
    }

    const basicAuth = btoa(`${this.env.NOTION_CLIENT_ID}:${this.env.NOTION_CLIENT_SECRET}`);
    const response = await fetch("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const now = Date.now();
      const errorText = await response.text();
      const message = `Notion token refresh failed: ${response.status} ${errorText}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentRefreshError(message);
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfterToRetryAtMs(response.headers.get("Retry-After"), now);
        const retryAtMs = clampRetryAtMs(
          retryAfter ?? now + TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS,
          now,
        );
        throw new RetryableRefreshError(message, retryAtMs);
      }
      throw new Error(message);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      token_type: string;
      bot_id?: string;
      workspace_id?: string;
      workspace_name?: string;
      owner?: {
        user?: {
          id: string;
          name?: string;
          person?: { email?: string };
        };
      };
    };
    const expiresAt = Date.now() + data.expires_in * 1000;
    return {
      credentials: {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_at: expiresAt,
        token_type: data.token_type,
        bot_id: data.bot_id,
        notion_workspace_id: data.workspace_id,
        notion_workspace_name: data.workspace_name,
        owner_user_id: data.owner?.user?.id,
        owner_user_name: data.owner?.user?.name,
        owner_user_email: data.owner?.user?.person?.email,
      },
      expiresAt,
    };
  }

  private async refreshGoogleAnalyticsToken(
    refreshToken: string,
    previous: Record<string, unknown>,
  ): Promise<{ credentials: Record<string, unknown>; expiresAt: number }> {
    const clientId = this.env.GOOGLE_ANALYTICS_CLIENT_ID || this.env.GOOGLE_CLIENT_ID;
    const clientSecret = this.env.GOOGLE_ANALYTICS_CLIENT_SECRET || this.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("Google Analytics OAuth credentials not configured");
    }
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const data = await response.json() as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !data.access_token) {
      const message = `Google Analytics token refresh failed: ${response.status} ${data.error_description || data.error || response.statusText}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentRefreshError(message);
      }
      if (response.status === 429) {
        throw new RetryableRefreshError(message, Date.now() + TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS);
      }
      throw new Error(message);
    }
    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return {
      credentials: {
        ...previous,
        access_token: data.access_token,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_type: data.token_type ?? previous.token_type ?? "Bearer",
        scope: data.scope ?? previous.scope,
      },
      expiresAt,
    };
  }

  // Integration methods
  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async getIntegrations(): Promise<OrgIntegrationRecord[]> {
    return this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at
         FROM integrations
         ORDER BY created_at DESC`,
      )
      .toArray() as unknown as OrgIntegrationRecord[];
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async getIntegration(id: string): Promise<OrgIntegrationRecord | null> {
    const rows = this.sql
      .exec(
        `SELECT id, integration_type, name, category, auth_method, config,
                credentials_encrypted, created_by, created_at, updated_at
         FROM integrations WHERE id = ?`,
        id,
      )
      .toArray() as unknown as OrgIntegrationRecord[];
    return rows[0] || null;
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async createIntegration(
    id: string,
    integrationType: string,
    name: string,
    category: string,
    authMethod: string,
    config: string,
    credentialsEncrypted: string,
    createdBy: string,
  ): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO integrations
       (id, integration_type, name, category, auth_method, config, credentials_encrypted, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      integrationType,
      name,
      category,
      authMethod,
      config,
      credentialsEncrypted,
      createdBy,
      now,
      now,
    );
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async updateIntegration(
    id: string,
    updates: {
      name?: string;
      config?: string;
      credentialsEncrypted?: string;
    },
  ): Promise<void> {
    const now = Date.now();
    const setClauses: string[] = ["updated_at = ?"];
    const params: (string | number)[] = [now];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      params.push(updates.name);
    }
    if (updates.config !== undefined) {
      setClauses.push("config = ?");
      params.push(updates.config);
    }
    if (updates.credentialsEncrypted !== undefined) {
      setClauses.push("credentials_encrypted = ?");
      params.push(updates.credentialsEncrypted);
    }

    params.push(id);
    this.sql.exec(
      `UPDATE integrations SET ${setClauses.join(", ")} WHERE id = ?`,
      ...params,
    );
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async deleteIntegration(id: string): Promise<void> {
    this.sql.exec("DELETE FROM integrations WHERE id = ?", id);
  }

  /** @deprecated Integrations are workspace-scoped; migrate to WorkspaceDO. */
  async dropLegacyIntegrations(): Promise<void> {
    this.sql.exec("DROP TABLE IF EXISTS integrations");
  }

  // Worker script methods
  async registerWorkerScript(
    scriptName: string,
    workspaceId: string,
    createdBy: string,
    configPath?: string,
    projectId?: string,
    commitSha?: string,
    artifactCacheKey?: string,
  ): Promise<WorkerScript> {
    const now = Date.now();
    const existing = await this.getWorkerScript(scriptName);

    if (existing) {
      // Check if script belongs to a different workspace - prevent name collisions
      if (existing.workspace_id !== workspaceId) {
        throw new Error(
          `Script name "${scriptName}" is already in use by another workspace in this organization. ` +
            `Please choose a different name.`,
        );
      }

      // Same workspace - update the script (redeploy) while preserving its
      // configured visibility.
      this.sql.exec(
        "UPDATE worker_scripts SET updated_at = ?, is_public = ?, config_path = ?, project_id = ?, commit_sha = ?, artifact_cache_key = ? WHERE script_name = ?",
        now,
        existing.is_public ? 1 : 0,
        configPath ?? null,
        projectId ?? null,
        commitSha ?? null,
        artifactCacheKey ?? null,
        scriptName,
      );
      this.log("worker_script_updated", createdBy, scriptName, {
        workspace_id: workspaceId,
        config_path: configPath,
        project_id: projectId,
        commit_sha: commitSha,
        artifact_cache_key: artifactCacheKey,
      });
      this.recordWorkerScriptDeployVersion({
        scriptName,
        workspaceId,
        createdBy,
        createdAt: now,
        configPath,
        projectId,
        commitSha,
        artifactCacheKey,
      });
      return {
        ...existing,
        updated_at: now,
        is_public: existing.is_public,
        config_path: configPath ?? existing.config_path,
        project_id: projectId ?? null,
        commit_sha: commitSha ?? null,
        artifact_cache_key: artifactCacheKey ?? null,
      };
    }

    const isPublic = true;
    this.sql.exec(
      "INSERT INTO worker_scripts (script_name, workspace_id, created_by, created_at, updated_at, is_public, config_path, project_id, commit_sha, artifact_cache_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      scriptName,
      workspaceId,
      createdBy,
      now,
      now,
      isPublic ? 1 : 0,
      configPath ?? null,
      projectId ?? null,
      commitSha ?? null,
      artifactCacheKey ?? null,
    );
    this.log("worker_script_registered", createdBy, scriptName, {
      workspace_id: workspaceId,
      config_path: configPath,
      project_id: projectId,
      commit_sha: commitSha,
      artifact_cache_key: artifactCacheKey,
    });
    this.recordWorkerScriptDeployVersion({
      scriptName,
      workspaceId,
      createdBy,
      createdAt: now,
      configPath,
      projectId,
      commitSha,
      artifactCacheKey,
    });
    const newScript = {
      script_name: scriptName,
      workspace_id: workspaceId,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
      is_public: isPublic,
      preview_key: null,
      preview_updated_at: null,
      preview_status: "pending" as WorkerScriptPreviewStatus,
      preview_error: null,
      config_path: configPath ?? null,
      project_id: projectId ?? null,
      commit_sha: commitSha ?? null,
      artifact_cache_key: artifactCacheKey ?? null,
      custom_domain_hostname: null,
      custom_domain_cf_hostname_id: null,
      custom_domain_status: null,
      custom_domain_ssl_status: null,
      custom_domain_error: null,
      custom_domain_updated_at: null,
    };
    const info = await this.getInfo();
    if (info)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...newScript, org_id: info.id },
      });
    return newScript;
  }

  private recordWorkerScriptDeployVersion(input: {
    scriptName: string;
    workspaceId: string;
    createdBy: string;
    createdAt: number;
    configPath?: string;
    projectId?: string;
    commitSha?: string;
    artifactCacheKey?: string;
  }): void {
    if (!input.commitSha && !input.artifactCacheKey) return;
    this.ensureWorkerScriptDeploysSchema();
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO worker_script_deploys (id, script_name, workspace_id, created_at, created_by, config_path, project_id, commit_sha, artifact_cache_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.scriptName,
      input.workspaceId,
      input.createdAt,
      input.createdBy,
      input.configPath ?? null,
      input.projectId ?? null,
      input.commitSha ?? null,
      input.artifactCacheKey ?? null,
    );
  }

  async listWorkerScriptDeployVersions(scriptName: string, workspaceId: string, limit = 20): Promise<WorkerScriptDeployVersion[]> {
    this.ensureWorkerScriptDeploysSchema();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.sql.exec<WorkerScriptDeployVersion>(
      `SELECT id, script_name, workspace_id, created_at, created_by, config_path, project_id, commit_sha, artifact_cache_key
       FROM worker_script_deploys
       WHERE script_name = ? AND workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      scriptName,
      workspaceId,
      safeLimit,
    ).toArray();
  }

  /**
   * Record a live Browser Rendering session for a workspace so concurrent
   * browser tests can be capped per workspace. Idempotent on session_id.
   */
  async recordBrowserSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    if (!workspaceId || !sessionId) return;
    this.sql.exec(
      "INSERT OR REPLACE INTO workspace_browser_sessions (session_id, workspace_id, created_at) VALUES (?, ?, ?)",
      sessionId,
      workspaceId,
      Date.now(),
    );
  }

  /** Drop a browser session from the registry (best-effort, on session close). */
  async removeBrowserSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    this.sql.exec(
      "DELETE FROM workspace_browser_sessions WHERE session_id = ?",
      sessionId,
    );
  }

  /**
   * Prune recorded browser sessions that are no longer live (the caller passes
   * the account-global live session ids from puppeteer.sessions), then return
   * how many recorded sessions remain for `workspaceId`. Reconciling against the
   * platform's live list makes the per-workspace count self-heal when a session
   * leaks (its worker died before removeBrowserSession ran) — the dead session
   * drops off the live list and is pruned here.
   */
  async reconcileBrowserSessions(
    workspaceId: string,
    liveSessionIds: string[],
  ): Promise<number> {
    const live = [
      ...new Set(
        (Array.isArray(liveSessionIds) ? liveSessionIds : []).filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      ),
    ];
    if (live.length === 0) {
      this.sql.exec("DELETE FROM workspace_browser_sessions");
    } else {
      const placeholders = live.map(() => "?").join(", ");
      this.sql.exec(
        `DELETE FROM workspace_browser_sessions WHERE session_id NOT IN (${placeholders})`,
        ...live,
      );
    }
    return (
      this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM workspace_browser_sessions WHERE workspace_id = ?",
          workspaceId,
        )
        .next().value?.count ?? 0
    );
  }

  async getWorkerScript(scriptName: string): Promise<WorkerScript | null> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path, project_id, commit_sha, artifact_cache_key,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts WHERE script_name = ?`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path, NULL AS project_id, NULL AS commit_sha, NULL AS artifact_cache_key,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts WHERE script_name = ?`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [
      scriptName,
    ]);
    if (rows.length === 0) return null;
    return this.toWorkerScript(rows[0]);
  }

  async listWorkerScripts(): Promise<WorkerScript[]> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path, project_id, commit_sha, artifact_cache_key,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts ORDER BY updated_at DESC`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path, NULL AS project_id, NULL AS commit_sha, NULL AS artifact_cache_key,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts ORDER BY updated_at DESC`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, []);
    return rows.map((row) => this.toWorkerScript(row));
  }

  async listWorkerScriptsPaginated(
    offset: number,
    limit: number,
    search?: string,
  ): Promise<{ items: WorkerScript[]; total: number }> {
    const normalized = search?.trim().toLowerCase();
    const whereClause = normalized ? "WHERE lower(script_name) LIKE ?" : "";
    const params: Array<string | number> = [];
    if (normalized) {
      params.push(`%${normalized}%`);
    }

    const countRows = this.sql
      .exec(
        `SELECT COUNT(*) as count FROM worker_scripts ${whereClause}`,
        ...params,
      )
      .toArray() as unknown as Array<{ count: number }>;
    const total = countRows[0]?.count ?? 0;

    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path, project_id, commit_sha, artifact_cache_key,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path, NULL AS project_id, NULL AS commit_sha, NULL AS artifact_cache_key,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    const items = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [
      ...params,
      limit,
      offset,
    ]);
    return {
      items: items.map((row) => this.toWorkerScript(row)),
      total,
    };
  }

  async listWorkerScriptsByWorkspace(
    workspaceId: string,
  ): Promise<WorkerScript[]> {
    const queryWithPreview = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                                     preview_key, preview_updated_at, preview_status, preview_error, config_path, project_id, commit_sha, artifact_cache_key,
                                     custom_domain_hostname, custom_domain_cf_hostname_id, custom_domain_status,
                                     custom_domain_ssl_status, custom_domain_error, custom_domain_updated_at
                              FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC`;
    const queryBase = `SELECT script_name, workspace_id, created_by, created_at, updated_at, is_public,
                              NULL AS preview_key, NULL AS preview_updated_at, NULL AS preview_status, NULL AS preview_error, NULL AS config_path, NULL AS project_id, NULL AS commit_sha, NULL AS artifact_cache_key,
                              NULL AS custom_domain_hostname, NULL AS custom_domain_cf_hostname_id, NULL AS custom_domain_status,
                              NULL AS custom_domain_ssl_status, NULL AS custom_domain_error, NULL AS custom_domain_updated_at
                       FROM worker_scripts WHERE workspace_id = ? ORDER BY updated_at DESC`;
    const rows = this.execWorkerScriptsQuery(queryWithPreview, queryBase, [
      workspaceId,
    ]);
    return rows.map((row) => this.toWorkerScript(row));
  }

  async updateWorkerScript(
    scriptName: string,
    actorId: string,
  ): Promise<WorkerScript | null> {
    const now = Date.now();
    this.sql.exec(
      "UPDATE worker_scripts SET updated_at = ? WHERE script_name = ?",
      now,
      scriptName,
    );
    const script = await this.getWorkerScript(scriptName);
    if (script) {
      this.log("worker_script_touched", actorId, scriptName);
      const info = await this.getInfo();
      if (info)
        dispatchAdminEvent(this.ctx, this.env, {
          type: "app_upsert",
          payload: { ...script, org_id: info.id },
        });
    }
    return script;
  }

  async updateWorkerScriptProject(
    scriptName: string,
    workspaceId: string,
    projectId: string | null,
    actorId: string,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing || existing.workspace_id !== workspaceId) return null;

    const now = Date.now();
    this.sql.exec(
      "UPDATE worker_scripts SET project_id = ?, updated_at = ? WHERE script_name = ? AND workspace_id = ?",
      projectId,
      now,
      scriptName,
      workspaceId,
    );
    this.log("worker_script_project_updated", actorId, scriptName, {
      workspace_id: workspaceId,
      project_id: projectId,
    });
    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    return script;
  }

  async setWorkerScriptPublic(
    scriptName: string,
    isPublic: boolean,
    actorId: string,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;
    const info = await this.getInfo();
    const visibilityIndexKey = info?.slug
      ? `${SCRIPT_PREFIX}${scriptName}--${info.slug}`
      : null;
    const visibilityIndexValue = info
      ? JSON.stringify({
          org_id: info.id,
          org_slug: info.slug,
          is_public: isPublic,
        })
      : null;

    // Keep visibility changes fail-closed across the OrgDO + KV boundary:
    // lock private apps before changing the product record, and only publish
    // apps to the dispatcher after the product record is public.
    if (!isPublic && visibilityIndexKey && visibilityIndexValue) {
      await this.env.APP_KV.put(visibilityIndexKey, visibilityIndexValue);
    }
    const now = Date.now();
    this.sql.exec(
      "UPDATE worker_scripts SET is_public = ?, updated_at = ? WHERE script_name = ?",
      isPublic ? 1 : 0,
      now,
      scriptName,
    );
    this.log("worker_script_visibility_changed", actorId, scriptName, {
      is_public: isPublic,
    });
    const updated = {
      ...existing,
      is_public: isPublic,
      updated_at: now,
    };
    if (isPublic && visibilityIndexKey && visibilityIndexValue) {
      await this.env.APP_KV.put(visibilityIndexKey, visibilityIndexValue);
    }
    if (info)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...updated, org_id: info.id },
      });
    return updated;
  }

  async updateWorkerScriptPreview(
    scriptName: string,
    input: WorkerScriptPreviewUpdateInput,
  ): Promise<WorkerScriptPreviewUpdateResult> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) {
      return { script: null, updated: false, stale: false };
    }

    if (!this.workerScriptsHasPreviewColumns) {
      return { script: existing, updated: false, stale: false };
    }

    if (input.deploy_ts && existing.updated_at > input.deploy_ts) {
      return { script: existing, updated: false, stale: true };
    }

    const previewUpdatedAt = input.preview_updated_at ?? Date.now();
    this.sql.exec(
      `UPDATE worker_scripts
       SET preview_status = ?, preview_key = ?, preview_error = ?, preview_updated_at = ?
       WHERE script_name = ?`,
      input.status,
      input.preview_key ?? null,
      input.preview_error ?? null,
      previewUpdatedAt,
      scriptName,
    );

    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    return { script, updated: true, stale: false };
  }

  async updateWorkerScriptCustomDomain(
    scriptName: string,
    input: WorkerScriptCustomDomainUpdateInput,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;

    if (!this.workerScriptsHasPreviewColumns) {
      return existing;
    }

    if (input.deploy_ts && existing.updated_at > input.deploy_ts) {
      return existing;
    }

    const nextHostname = input.hostname?.trim().toLowerCase() ?? null;
    if (nextHostname && nextHostname !== existing.custom_domain_hostname) {
      const info = await this.getInfo();
      if (info) {
        const limit = getBillingPlanLimits(
          info.billing_plan,
          info.billing_status,
        ).maxCustomDomains;
        if (limit !== null) {
          const currentCount =
            this.sql
              .exec<{ count: number }>(
                `SELECT COUNT(*) AS count
               FROM worker_scripts
               WHERE custom_domain_hostname IS NOT NULL
                 AND custom_domain_hostname != ''
                 AND script_name != ?`,
                scriptName,
              )
              .toArray()[0]?.count ?? 0;
          if (currentCount >= limit) {
            throw new Error(
              `Your current billing plan allows ${limit} custom domain${limit === 1 ? "" : "s"}.`,
            );
          }
        }
      }
    }

    this.sql.exec(
      `UPDATE worker_scripts
       SET custom_domain_hostname = ?, custom_domain_cf_hostname_id = ?, custom_domain_status = ?,
           custom_domain_ssl_status = ?, custom_domain_error = ?, custom_domain_updated_at = ?
       WHERE script_name = ?`,
      nextHostname,
      input.cf_hostname_id ?? null,
      input.status ?? null,
      input.ssl_status ?? null,
      input.error ?? null,
      input.updated_at ?? Date.now(),
      scriptName,
    );

    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script) {
      if (
        existing.custom_domain_hostname &&
        existing.custom_domain_hostname !== nextHostname
      ) {
        await this.env.APP_KV.delete(
          `${CUSTOM_DOMAIN_HOST_PREFIX}${existing.custom_domain_hostname}`,
        );
      }
      if (nextHostname) {
        await this.env.APP_KV.put(
          `${CUSTOM_DOMAIN_HOST_PREFIX}${nextHostname}`,
          JSON.stringify({
            org_id: info.id,
            org_slug: info.slug,
            script_name: scriptName,
            dispatch_script_name: `${scriptName}--${info.slug}`,
          }),
        );
      }
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    }
    return script;
  }

  async clearWorkerScriptCustomDomain(
    scriptName: string,
  ): Promise<WorkerScript | null> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return null;
    if (!this.workerScriptsHasPreviewColumns) {
      return existing;
    }

    this.sql.exec(
      `UPDATE worker_scripts
       SET custom_domain_hostname = NULL,
           custom_domain_cf_hostname_id = NULL,
           custom_domain_status = NULL,
           custom_domain_ssl_status = NULL,
           custom_domain_error = NULL,
           custom_domain_updated_at = NULL
       WHERE script_name = ?`,
      scriptName,
    );

    if (existing.custom_domain_hostname) {
      await this.env.APP_KV.delete(
        `${CUSTOM_DOMAIN_HOST_PREFIX}${existing.custom_domain_hostname}`,
      );
    }

    const script = await this.getWorkerScript(scriptName);
    const info = await this.getInfo();
    if (info && script) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "app_upsert",
        payload: { ...script, org_id: info.id },
      });
    }
    return script;
  }

  async clearWorkerScriptCustomDomains(): Promise<void> {
    if (!this.workerScriptsHasPreviewColumns) return;

    const customHostnames = (await this.listWorkerScripts())
      .map((script) => script.custom_domain_hostname)
      .filter((hostname): hostname is string => Boolean(hostname));

    this.sql.exec(
      `UPDATE worker_scripts
       SET custom_domain_hostname = NULL,
           custom_domain_cf_hostname_id = NULL,
           custom_domain_status = NULL,
           custom_domain_ssl_status = NULL,
           custom_domain_error = NULL,
           custom_domain_updated_at = NULL`,
    );
    await Promise.all(
      customHostnames.map((hostname) =>
        this.env.APP_KV.delete(`${CUSTOM_DOMAIN_HOST_PREFIX}${hostname}`),
      ),
    );
  }

  async deleteWorkerScript(
    scriptName: string,
    actorId: string,
  ): Promise<boolean> {
    const existing = await this.getWorkerScript(scriptName);
    if (!existing) return false;
    if (existing.custom_domain_hostname) {
      await this.env.APP_KV.delete(
        `${CUSTOM_DOMAIN_HOST_PREFIX}${existing.custom_domain_hostname}`,
      );
    }
    this.sql.exec(
      "DELETE FROM worker_scripts WHERE script_name = ?",
      scriptName,
    );
    this.log("worker_script_deleted", actorId, scriptName, {
      workspace_id: existing.workspace_id,
    });
    const info = await this.getInfo();
    dispatchAdminEvent(this.ctx, this.env, {
      type: "app_delete",
      payload: { script_name: scriptName, org_id: info?.id ?? null },
    });
    return true;
  }

  // ── Legacy Org Custom Domains ───────────────────────────────────────

  async setCustomDomain(
    domain: string,
    actorId: string,
  ): Promise<CustomDomain> {
    return setOrgCustomDomain(this.customDomainContext(), domain, actorId);
  }

  async removeCustomDomain(actorId: string): Promise<CustomDomain | null> {
    return removeOrgCustomDomain(this.customDomainContext(), actorId);
  }

  getCustomDomain(): CustomDomain | null {
    return getOrgCustomDomain(this.customDomainContext());
  }

  async updateCustomDomainStatus(
    domain: string,
    status: CustomDomainStatus,
    sslStatus?: string | null,
    cfHostnameId?: string,
  ): Promise<CustomDomain | null> {
    return updateOrgCustomDomainStatus(
      this.customDomainContext(),
      domain,
      status,
      sslStatus,
      cfHostnameId,
    );
  }

  private customDomainContext() {
    return {
      sql: this.sql,
      log: (action: string, actorId: string, targetId?: string) =>
        this.log(action, actorId, targetId),
    };
  }

  private log(
    action: string,
    actorId: string,
    targetId?: string,
    details?: Record<string, unknown>,
  ): void {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO audit_log (id, action, actor_id, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      action,
      actorId,
      targetId ?? null,
      details ? JSON.stringify(details) : null,
      now,
    );
  }

  private recordThreadCreateStage(
    operation: string,
    startedAt: number,
    ids: {
      threadId?: string | null;
      workspaceId?: string | null;
      userId?: string | null;
      orgId?: string | null;
    } = {},
    extra: {
      status?: string;
      severity?: "debug" | "info" | "warn" | "error";
      count?: number;
      size?: number;
    } = {},
  ): void {
    recordObservabilityEvent(this.env, {
      event: "org_thread_create_stage",
      component: "org_do",
      operation,
      status: extra.status ?? "ok",
      severity: extra.severity ?? "info",
      threadId: ids.threadId,
      workspaceId: ids.workspaceId,
      orgId: ids.orgId,
      userId: ids.userId,
      durationMs: Date.now() - startedAt,
      count: extra.count,
      size: extra.size,
      sampleIndex: ids.threadId ?? ids.workspaceId ?? undefined,
    });
  }

  private recordThreadCreateError(
    operation: string,
    startedAt: number,
    error: unknown,
    ids: {
      threadId?: string | null;
      workspaceId?: string | null;
      userId?: string | null;
      orgId?: string | null;
    } = {},
  ): void {
    recordErrorEvent(this.env, {
      event: "org_thread_create_stage",
      component: "org_do",
      operation,
      status: "exception",
      threadId: ids.threadId,
      workspaceId: ids.workspaceId,
      orgId: ids.orgId,
      userId: ids.userId,
      durationMs: Date.now() - startedAt,
      sampleIndex: ids.threadId ?? ids.workspaceId ?? undefined,
      error,
    });
  }

  private syncThreadToAdminIndex(thread: OrgThread, operation: string): void {
    this.getInfo()
      .then((info) => {
        if (info) {
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(thread, info.id),
          });
        }
      })
      .catch((err) => {
        console.error(`Failed to sync ${operation} to AdminIndex`, err);
      });
  }

  private scheduleThreadCreateSideEffects(
    thread: OrgThread,
    actorId: string,
    auditDetails: Record<string, unknown>,
  ): void {
    this.ctx.waitUntil(
      Promise.resolve()
        .then(async () => {
          const auditStartedAt = Date.now();
          try {
            this.log("thread_created", actorId, thread.id, auditDetails);
            this.recordThreadCreateStage("audit_log_inserted", auditStartedAt, {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              userId: actorId,
            });
          } catch (error) {
            console.error("[OrgDO] failed to write thread_created audit log", error);
            this.recordThreadCreateError("audit_log_insert", auditStartedAt, error, {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              userId: actorId,
            });
          }

          const infoStartedAt = Date.now();
          let info: Organization | null = null;
          try {
            info = await this.getInfo();
            this.recordThreadCreateStage("admin_index_org_loaded", infoStartedAt, {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              userId: actorId,
              orgId: info?.id ?? null,
            });
          } catch (error) {
            console.error("[OrgDO] failed to load org info for thread admin index", error);
            this.recordThreadCreateError("admin_index_org_load", infoStartedAt, error, {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              userId: actorId,
            });
            return;
          }

          if (!info) {
            this.recordThreadCreateStage(
              "admin_index_org_loaded",
              infoStartedAt,
              {
                threadId: thread.id,
                workspaceId: thread.workspace_id,
                userId: actorId,
              },
              { status: "missing", severity: "warn" },
            );
            return;
          }

          const dispatchStartedAt = Date.now();
          try {
            dispatchAdminEvent(this.ctx, this.env, {
              type: "thread_upsert",
              payload: toAdminThreadPayload(thread, info.id),
            });
            this.recordThreadCreateStage("admin_index_dispatch_scheduled", dispatchStartedAt, {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              userId: actorId,
              orgId: info.id,
            });
          } catch (error) {
            console.error("[OrgDO] failed to dispatch thread admin index event", error);
            this.recordThreadCreateError("admin_index_dispatch", dispatchStartedAt, error, {
              threadId: thread.id,
              workspaceId: thread.workspace_id,
              userId: actorId,
              orgId: info.id,
            });
          }
        })
        .catch((error) => {
          console.error("[OrgDO] failed to run thread create side effects", error);
          this.recordThreadCreateError("side_effects", Date.now(), error, {
            threadId: thread.id,
            workspaceId: thread.workspace_id,
            userId: actorId,
          });
        }),
    );
  }

  async checkWorkspaceNameAvailable(
    name: string,
    excludeWorkspaceId?: string,
  ): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;

    // Check both exact name (case-insensitive) and slugified name to prevent
    // email routing collisions (e.g. "Data Science" and "Data-Science" both
    // slugify to "data-science")
    const slug = slugifyWorkspaceName(trimmed);
    const rows = excludeWorkspaceId
      ? (this.sql
          .exec(
            "SELECT id, name FROM workspaces WHERE archived = 0 AND id != ?",
            excludeWorkspaceId,
          )
          .toArray() as Array<{ id: string; name: string }>)
      : (this.sql
          .exec("SELECT id, name FROM workspaces WHERE archived = 0")
          .toArray() as Array<{ id: string; name: string }>);

    for (const row of rows) {
      if (row.name.toLowerCase() === trimmed.toLowerCase()) return false;
      if (slugifyWorkspaceName(row.name) === slug) return false;
    }
    return true;
  }

  async addWorkspace(
    workspaceId: string,
    name: string,
    createdAt: number,
    actorId: string,
  ): Promise<void> {
    const available = await this.checkWorkspaceNameAvailable(name, workspaceId);
    if (!available) {
      throw new Error(
        `A workspace named "${name}" already exists in this organization`,
      );
    }
    const avatar = generateDefaultAvatar(name);
    this.sql.exec(
      `INSERT INTO workspaces (
        id,
        name,
        created_at,
        archived,
        created_by,
        avatar_color,
        avatar_content,
        compute_tier
      )
      VALUES (?, ?, ?, 0, ?, ?, ?, 'standard')
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        created_at = excluded.created_at,
        created_by = COALESCE(workspaces.created_by, excluded.created_by),
        avatar_color = COALESCE(workspaces.avatar_color, excluded.avatar_color),
        avatar_content = COALESCE(workspaces.avatar_content, excluded.avatar_content),
        compute_tier = COALESCE(workspaces.compute_tier, excluded.compute_tier)`,
      workspaceId,
      name,
      createdAt,
      actorId,
      avatar.color,
      avatar.content,
    );
    this.log("workspace_created", actorId, workspaceId, { name });
    await this.indexWorkspace(workspaceId);
  }

  private async claimWorkspaceEmailHandle(workspaceId: string): Promise<string> {
    const registry = this.env.EMAIL_HANDLE;
    for (let attempt = 0; attempt < 20; attempt++) {
      const handle = generateEmailHandle();
      if (registry) {
        const stub = registry.get(
          registry.idFromName(handle),
        ) as unknown as EmailHandleDO;
        const result = await stub.claim(workspaceId);
        if (!result.ok) continue;
      }
      return handle;
    }
    const suffix = workspaceId.replace(/-/g, "").slice(0, 12);
    const handle = `${generateEmailHandle()}-${suffix}`;
    if (registry) {
      const stub = registry.get(
        registry.idFromName(handle),
      ) as unknown as EmailHandleDO;
      await stub.claim(workspaceId);
    }
    return handle;
  }

  async createWorkspaceRecord(
    workspaceId: string,
    name: string,
    createdBy: string,
    description?: string | null,
  ): Promise<Workspace> {
    const now = Date.now();
    const available = await this.checkWorkspaceNameAvailable(name, workspaceId);
    if (!available) {
      throw new Error(
        `A workspace named "${name}" already exists in this organization`,
      );
    }
    const orgId = this.getInfoSync()?.id;
    if (!orgId) {
      throw new Error("Organization not found");
    }
    const avatar = generateDefaultAvatar(name);
    const info: Workspace = {
      id: workspaceId,
      org_id: orgId,
      name,
      description: description ?? null,
      created_by: createdBy,
      created_at: now,
      avatar,
      archived: false,
      archived_at: null,
      archived_by: null,
      compute_tier: "standard",
      email_handle: await this.claimWorkspaceEmailHandle(workspaceId),
    };
    await this.upsertWorkspaceInfo(info);
    await this.syncWorkspaceInfoToWorkspaceDO(info);
    this.log("workspace_created", createdBy, workspaceId, { name });
    return info;
  }

  async upsertWorkspaceInfo(info: Workspace): Promise<void> {
    const avatar = info.avatar ?? generateDefaultAvatar(info.name);
    this.sql.exec(
      `INSERT INTO workspaces (
        id,
        name,
        created_at,
        archived,
        description,
        created_by,
        avatar_color,
        avatar_content,
        archived_at,
        archived_by,
        compute_tier,
        email_handle
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        created_at = excluded.created_at,
        archived = excluded.archived,
        description = excluded.description,
        created_by = excluded.created_by,
        avatar_color = excluded.avatar_color,
        avatar_content = excluded.avatar_content,
        archived_at = excluded.archived_at,
        archived_by = excluded.archived_by,
        compute_tier = excluded.compute_tier,
        email_handle = excluded.email_handle`,
      info.id,
      info.name,
      info.created_at,
      info.archived ? 1 : 0,
      info.description ?? null,
      info.created_by,
      avatar.color,
      avatar.content,
      info.archived_at ?? null,
      info.archived_by ?? null,
      info.compute_tier ?? "standard",
      info.email_handle ?? null,
    );
    await this.indexWorkspace(info.id);
    this.dispatchWorkspaceUpsert(info);
  }

  async updateWorkspaceName(workspaceId: string, name: string): Promise<void> {
    const available = await this.checkWorkspaceNameAvailable(name, workspaceId);
    if (!available) {
      throw new Error(
        `A workspace named "${name}" already exists in this organization`,
      );
    }
    this.sql.exec(
      "UPDATE workspaces SET name = ? WHERE id = ?",
      name,
      workspaceId,
    );
  }

  async updateWorkspaceRecord(
    workspaceId: string,
    updates: {
      name?: string;
      description?: string | null;
      avatar?: { color?: string; content?: string };
    },
    actorId: string,
  ): Promise<Workspace | null> {
    const info = await this.getWorkspaceInfo(workspaceId);
    if (!info) return null;

    const changes: Record<string, [unknown, unknown]> = {};
    if (
      typeof updates.name === "string" &&
      updates.name.trim() &&
      updates.name !== info.name
    ) {
      await this.updateWorkspaceName(info.id, updates.name);
      changes.name = [info.name, updates.name];
      info.name = updates.name;
    }
    if (
      updates.description !== undefined &&
      updates.description !== info.description
    ) {
      changes.description = [info.description, updates.description];
      info.description = updates.description ?? null;
    }
    if (updates.avatar?.color && updates.avatar.color !== info.avatar.color) {
      changes.avatar_color = [info.avatar.color, updates.avatar.color];
      info.avatar.color = updates.avatar.color;
    }
    if (
      updates.avatar?.content &&
      updates.avatar.content !== info.avatar.content
    ) {
      if (!validateAvatarContent(updates.avatar.content)) {
        throw new Error("Invalid avatar content");
      }
      changes.avatar_content = [info.avatar.content, updates.avatar.content];
      info.avatar.content = updates.avatar.content;
    }

    await this.upsertWorkspaceInfo(info);
    await this.syncWorkspaceInfoToWorkspaceDO(info);
    if (Object.keys(changes).length > 0) {
      this.log("workspace_updated", actorId, workspaceId, { changes });
    }
    return info;
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.sql.exec(
      "UPDATE workspaces SET archived = 1 WHERE id = ?",
      workspaceId,
    );
  }

  async archiveWorkspaceRecord(
    workspaceId: string,
    archivedBy: string,
  ): Promise<Workspace | null> {
    const info = await this.getWorkspaceInfo(workspaceId);
    if (!info) return null;
    if (info.archived) return info;

    const archived: Workspace = {
      ...info,
      archived: true,
      archived_at: Date.now(),
      archived_by: archivedBy,
    };
    await this.upsertWorkspaceInfo(archived);
    await this.syncWorkspaceInfoToWorkspaceDO(archived);
    await this.disableScheduledPromptsForWorkspace(workspaceId, "workspace_archived");
    this.log("workspace_archived", archivedBy, workspaceId, {
      workspace_id: workspaceId,
      name: info.name,
    });
    return archived;
  }

  private workspaceFromRow(row: OrgWorkspaceInfoRow): Workspace {
    const orgId = this.getInfoSync()?.id ?? "";
    const avatar =
      row.avatar_color && row.avatar_content
        ? { color: row.avatar_color, content: row.avatar_content }
        : generateDefaultAvatar(row.name);
    return {
      id: row.id,
      org_id: orgId,
      name: row.name,
      description: row.description ?? null,
      created_by: row.created_by ?? "",
      created_at: row.created_at,
      avatar,
      archived: row.archived === 1,
      archived_at: row.archived_at ?? null,
      archived_by: row.archived_by ?? null,
      compute_tier: "standard",
      email_handle: row.email_handle ?? null,
    };
  }

  private shouldHydrateWorkspaceRow(row: OrgWorkspaceInfoRow): boolean {
    return (
      !row.created_by ||
      !row.avatar_color ||
      !row.avatar_content ||
      row.email_handle == null
    );
  }

  private async hydrateWorkspaceRow(
    row: OrgWorkspaceInfoRow,
  ): Promise<Workspace | null> {
    if (!this.shouldHydrateWorkspaceRow(row)) {
      return this.workspaceFromRow(row);
    }
    try {
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(row.id),
      ) as unknown as WorkspaceDO;
      const info = await workspaceStub.getInfo();
      if (info) {
        await this.upsertWorkspaceInfo(info);
        return info;
      }
      return null;
    } catch (error) {
      console.warn("[OrgDO] failed to hydrate workspace metadata", {
        workspaceId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.workspaceFromRow(row);
  }

  async getWorkspaceInfos(includeArchived = false): Promise<Workspace[]> {
    const query = includeArchived
      ? `SELECT id, name, created_at, archived, description, created_by,
                avatar_color, avatar_content, archived_at, archived_by,
                compute_tier, email_handle
           FROM workspaces
          ORDER BY created_at ASC`
      : `SELECT id, name, created_at, archived, description, created_by,
                avatar_color, avatar_content, archived_at, archived_by,
                compute_tier, email_handle
           FROM workspaces
          WHERE archived = 0
          ORDER BY created_at ASC`;
    const rows = this.sql.exec<OrgWorkspaceInfoRow>(query).toArray();
    const workspaces = await Promise.all(
      rows.map((row) => this.hydrateWorkspaceRow(row)),
    );
    return workspaces.filter(
      (workspace): workspace is Workspace =>
        !!workspace && (includeArchived || !workspace.archived),
    );
  }

  private async getWorkspaceInfo(workspaceId: string): Promise<Workspace | null> {
    const row = this.sql
      .exec<OrgWorkspaceInfoRow>(
        `SELECT id, name, created_at, archived, description, created_by,
                avatar_color, avatar_content, archived_at, archived_by,
                compute_tier, email_handle
           FROM workspaces
          WHERE id = ?`,
        workspaceId,
      )
      .one();
    return row ? this.hydrateWorkspaceRow(row) : null;
  }

  async getWorkspaceRecord(workspaceId: string): Promise<Workspace | null> {
    return this.getWorkspaceInfo(workspaceId);
  }

  async migrateWorkspaceTenantDataFromWorkspaceDO(
    workspaceId: string,
  ): Promise<{
    workspace_id: string;
    metadata_migrated: boolean;
    workspace_found: boolean;
    archived: boolean | null;
    access_rows_migrated: number;
    integrations_copied: number;
    integrations_total: number;
  }> {
    const orgId = this.getInfoSync()?.id;
    if (!orgId) {
      throw new Error("Organization not found");
    }

    let metadataMigrated = false;
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspaceId),
    ) as unknown as WorkspaceDO;
    const legacyInfo = await workspaceStub.getInfo();
    if (legacyInfo) {
      if (legacyInfo.org_id !== orgId) {
        throw new Error(
          `Workspace ${workspaceId} belongs to org ${legacyInfo.org_id}, not ${orgId}`,
        );
      }
      await this.upsertWorkspaceInfo(legacyInfo);
      metadataMigrated = true;
    }

    const workspace = await this.getWorkspaceInfo(workspaceId);
    let accessRowsMigrated = 0;
    if (workspace) {
      const members = await this.getMembers();
      for (const member of members) {
        const legacyAccess = await workspaceStub.getMemberAccess(member.user_id);
        if (!legacyAccess) continue;
        await this.setWorkspaceAccess(
          workspaceId,
          member.user_id,
          this.normalizeWorkspaceAccess(legacyAccess.access_level),
          legacyAccess.granted_by || "admin-workspace-do-migration",
        );
        accessRowsMigrated++;
      }
      this.markWorkspaceAccessMigrated(workspaceId);
    }

    const integrationsCopied = await this.hydrateWorkspaceIntegrationsFromWorkspaceDO(
      workspaceId,
    );
    this.markWorkspaceIntegrationsMigrated(workspaceId);
    const integrationsTotal = this.getActiveWorkspaceIntegrationCount(workspaceId);

    return {
      workspace_id: workspaceId,
      metadata_migrated: metadataMigrated,
      workspace_found: Boolean(workspace),
      archived: workspace?.archived ?? legacyInfo?.archived ?? null,
      access_rows_migrated: accessRowsMigrated,
      integrations_copied: integrationsCopied,
      integrations_total: integrationsTotal,
    };
  }

  private normalizeWorkspaceAccess(
    accessLevel: WorkspaceAccessLevel | string | null | undefined,
  ): WorkspaceAccessLevel {
    return accessLevel === "none" ? "none" : "full";
  }

  private getMemberWorkspaceAccessDefault(
    member: Pick<OrgMember, "workspace_access_default">,
  ): WorkspaceAccessLevel {
    return member.workspace_access_default === "none" ? "none" : "full";
  }

  private getStoredWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): WorkspaceAccessLevel | null {
    const row = this.sql
      .exec<{ access_level: string }>(
        "SELECT access_level FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?",
        workspaceId,
        userId,
      )
      .toArray()[0];
    return row ? this.normalizeWorkspaceAccess(row.access_level) : null;
  }

  private workspaceAccessMigrationKey(workspaceId: string): string {
    return `${OrgDO.WORKSPACE_ACCESS_MIGRATION_PREFIX}${workspaceId}`;
  }

  private isWorkspaceAccessMigrated(workspaceId: string): boolean {
    return this.ctx.storage.kv.get<number>(
      this.workspaceAccessMigrationKey(workspaceId),
    ) === 1;
  }

  private markWorkspaceAccessMigrated(workspaceId: string): void {
    this.ctx.storage.kv.put(this.workspaceAccessMigrationKey(workspaceId), 1);
  }

  private async ensureWorkspaceAccessMigrated(
    workspaceId: string,
    orgMemberIds?: Set<string>,
  ): Promise<void> {
    if (this.isWorkspaceAccessMigrated(workspaceId)) return;
    const memberIds =
      orgMemberIds ??
      new Set((await this.getMembers()).map((member) => member.user_id));
    await this.hydrateWorkspaceRestrictedMembersFromWorkspaceDO(
      workspaceId,
      memberIds,
    );
    this.markWorkspaceAccessMigrated(workspaceId);
  }

  private async hydrateWorkspaceRestrictedMembersFromWorkspaceDO(
    workspaceId: string,
    orgMemberIds: Set<string>,
  ): Promise<void> {
    try {
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(workspaceId),
      ) as unknown as WorkspaceDO;
      const restrictedMembers = await workspaceStub.listRestrictedMembers();
      for (const member of restrictedMembers) {
        if (!orgMemberIds.has(member.user_id)) continue;
        const accessLevel = this.normalizeWorkspaceAccess(member.access_level);
        if (accessLevel !== "none") continue;
        this.sql.exec(
          `INSERT INTO workspace_memberships (
            workspace_id,
            user_id,
            access_level,
            granted_by,
            granted_at
          )
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, user_id) DO NOTHING`,
          workspaceId,
          member.user_id,
          accessLevel,
          member.granted_by || "system",
          Number.isFinite(member.granted_at) ? member.granted_at : Date.now(),
        );
      }
    } catch (error) {
      console.warn("[OrgDO] failed to hydrate workspace restrictions", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getWorkspaceAccess(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceAccessLevel> {
    const [member, workspace] = await Promise.all([
      this.getMember(userId),
      this.getWorkspaceInfo(workspaceId),
    ]);
    if (!member || !workspace || workspace.archived) return "none";

    const storedAccess = this.getStoredWorkspaceAccess(workspaceId, userId);
    if (storedAccess) return storedAccess;

    await this.ensureWorkspaceAccessMigrated(workspaceId);
    return (
      this.getStoredWorkspaceAccess(workspaceId, userId) ??
      this.getMemberWorkspaceAccessDefault(member)
    );
  }

  async setWorkspaceAccess(
    workspaceId: string,
    userId: string,
    accessLevel: WorkspaceAccessLevel,
    actorId: string,
  ): Promise<void> {
    const workspace = await this.getWorkspaceInfo(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    const normalizedAccess = this.normalizeWorkspaceAccess(accessLevel);
    if (normalizedAccess === "full") {
      await this.ensureWorkspaceAccessMigrated(workspaceId);
      const storedAccess = this.getStoredWorkspaceAccess(workspaceId, userId);
      const member = await this.getMember(userId);
      const shouldStoreFullOverride =
        storedAccess !== null ||
        (member !== null &&
          this.getMemberWorkspaceAccessDefault(member) === "none");
      if (!shouldStoreFullOverride) {
        this.sql.exec(
          "DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?",
          workspaceId,
          userId,
        );
        this.log("workspace_access_changed", actorId, userId, {
          workspace_id: workspaceId,
          access_level: "full",
        });
        return;
      }
    }

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO workspace_memberships (
        workspace_id,
        user_id,
        access_level,
        granted_by,
        granted_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, user_id) DO UPDATE SET
        access_level = excluded.access_level,
        granted_by = excluded.granted_by,
        granted_at = excluded.granted_at`,
      workspaceId,
      userId,
      normalizedAccess,
      actorId,
      now,
    );
    this.log("workspace_access_changed", actorId, userId, {
      workspace_id: workspaceId,
      access_level: normalizedAccess,
    });
  }

  async listWorkspaceAccessRows(): Promise<OrgWorkspaceAccessRow[]> {
    return this.sql
      .exec<{
        workspace_id: string;
        user_id: string;
        access_level: string;
        granted_by: string;
        granted_at: number;
      }>(
        `SELECT workspace_id, user_id, access_level, granted_by, granted_at
           FROM workspace_memberships
          ORDER BY granted_at ASC`,
      )
      .toArray()
      .map((row) => ({
        ...row,
        access_level: this.normalizeWorkspaceAccess(row.access_level),
      }));
  }

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<Array<{ user_id: string; access_level: WorkspaceAccessLevel }>> {
    const workspace = await this.getWorkspaceInfo(workspaceId);
    if (!workspace || workspace.archived) return [];

    await this.ensureWorkspaceAccessMigrated(workspaceId);

    const rows = this.sql
      .exec<{
        user_id: string;
        access_level: string | null;
        workspace_access_default: string;
      }>(
        `SELECT members.user_id,
                workspace_memberships.access_level AS access_level,
                members.workspace_access_default AS workspace_access_default
           FROM members
           LEFT JOIN workspace_memberships
             ON workspace_memberships.user_id = members.user_id
            AND workspace_memberships.workspace_id = ?
          ORDER BY members.joined_at ASC`,
        workspaceId,
      )
      .toArray();

    const members: Array<{ user_id: string; access_level: WorkspaceAccessLevel }> = [];
    for (const row of rows) {
      const storedAccess = row.access_level
        ? this.normalizeWorkspaceAccess(row.access_level)
        : null;
      members.push({
        user_id: row.user_id,
        access_level:
          storedAccess ??
          (row.workspace_access_default === "none" ? "none" : "full"),
      });
    }
    return members;
  }

  async listUserWorkspaces(
    userId: string,
    includeArchived = false,
  ): Promise<WorkspaceWithAccess[]> {
    const member = await this.getMember(userId);
    if (!member) return [];

    // An archived org should expose no workspaces (a partial archive could leave
    // a stray un-archived workspace behind). Callers used to exclude archived
    // orgs up front via getUserOrgs; that org-level filter no longer runs in the
    // auth critical path, so enforce it here at the source.
    if (!includeArchived) {
      const info = await this.getInfo();
      if (info?.archived) return [];
    }

    const workspaces = await this.getWorkspaceInfos(includeArchived);
    const workspacesNeedingAccessMigration = workspaces.filter(
      (workspace) => !this.isWorkspaceAccessMigrated(workspace.id),
    );
    if (workspacesNeedingAccessMigration.length > 0) {
      const orgMemberIds = new Set(
        (await this.getMembers()).map((member) => member.user_id),
      );
      await Promise.all(
        workspacesNeedingAccessMigration.map((workspace) =>
          this.ensureWorkspaceAccessMigrated(workspace.id, orgMemberIds),
        ),
      );
    }
    const accessRows = this.sql
      .exec<{ workspace_id: string; access_level: string }>(
        "SELECT workspace_id, access_level FROM workspace_memberships WHERE user_id = ?",
        userId,
      )
      .toArray();
    const accessByWorkspace = new Map(
      accessRows.map((row) => [
        row.workspace_id,
        this.normalizeWorkspaceAccess(row.access_level),
      ]),
    );

    const result: WorkspaceWithAccess[] = [];
    for (const workspace of workspaces) {
      const accessLevel = accessByWorkspace.get(workspace.id) ?? null;
      const effectiveAccess =
        accessLevel ?? this.getMemberWorkspaceAccessDefault(member);
      if (effectiveAccess === "none") continue;
      result.push({ ...workspace, access_level: effectiveAccess });
    }
    return result;
  }

  async getWorkspaceAccessContext(
    workspaceId: string,
    userId: string,
  ): Promise<{ workspace: Workspace | null; access: WorkspaceAccessLevel }> {
    const workspace = await this.getWorkspaceInfo(workspaceId);
    if (!workspace || workspace.archived) {
      return { workspace: workspace ?? null, access: "none" };
    }
    const access = await this.getWorkspaceAccess(workspaceId, userId);
    return { workspace, access };
  }

  async getAuthContextBootstrap(
    userId: string,
  ): Promise<OrgAuthContextBootstrap> {
    const [info, member, workspaces, llmProviderConfig] = await Promise.all([
      this.getInfo(),
      this.getMember(userId),
      this.listUserWorkspaces(userId),
      this.getLlmProviderConfig(),
    ]);
    return {
      info,
      member,
      workspaces: workspaces.filter((workspace) => !workspace.archived),
      llmProviderConfig,
    };
  }

  async getProviderContext(): Promise<OrgProviderContext> {
    const [info, llmProviderConfig] = await Promise.all([
      this.getInfo(),
      this.getLlmProviderConfig(),
    ]);
    return { info, llmProviderConfig };
  }

  async getOnboardingWelcomeContext(
    workspaceId: string | null,
  ): Promise<OrgOnboardingWelcomeContext> {
    const [providerContext, memberCount, scripts, integrations] =
      await Promise.all([
        this.getProviderContext(),
        this.getMemberCount(),
        this.listWorkerScripts(),
        workspaceId
          ? this.getWorkspaceIntegrations(workspaceId)
              .then((rows) => rows.map((row) => row.name).slice(0, 4))
              .catch(() => [] as string[])
          : Promise.resolve([] as string[]),
      ]);

    return {
      ...providerContext,
      memberCount,
      appCount: scripts.length,
      integrations,
    };
  }

  async getSettingsSummary(): Promise<OrgSettingsSummary | null> {
    const info = await this.getInfo();
    if (!info) return null;

    this.ensureOwnerExists("system");
    const memberCount =
      this.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM members")
        .one()?.count ?? 0;
    const workspaceCount =
      this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM workspaces WHERE archived = 0",
        )
        .one()?.count ?? 0;

    return {
      name: info.name,
      archived: Boolean(info.archived),
      billing_plan: info.billing_plan,
      billing_status: info.billing_status,
      member_count: Number(memberCount),
      workspace_count: Number(workspaceCount),
    };
  }

  async getWorkspaceSummaryCounts(
    workspaceIds: string[],
  ): Promise<OrgWorkspaceSummaryCounts[]> {
    const uniqueWorkspaceIds = Array.from(
      new Set(workspaceIds.map((id) => id.trim()).filter(Boolean)),
    );
    if (uniqueWorkspaceIds.length === 0) return [];

    const orgMembers = await this.getMembers();
    const orgMemberIds = new Set(orgMembers.map((member) => member.user_id));

    await Promise.all(
      uniqueWorkspaceIds.map((workspaceId) =>
        this.ensureWorkspaceAccessMigrated(workspaceId, orgMemberIds),
      ),
    );

    const appRows = this.sql
      .exec<{ workspace_id: string; count: number }>(
        "SELECT workspace_id, COUNT(*) AS count FROM worker_scripts GROUP BY workspace_id",
      )
      .toArray();
    const appCountByWorkspace = new Map(
      appRows.map((row) => [row.workspace_id, row.count]),
    );

    const accessRows = this.sql
      .exec<{
        workspace_id: string;
        user_id: string;
        access_level: string;
      }>(
        "SELECT workspace_id, user_id, access_level FROM workspace_memberships",
      )
      .toArray()
      .filter((row) => orgMemberIds.has(row.user_id));
    const accessByWorkspaceAndUser = new Map(
      accessRows.map((row) => [
        `${row.workspace_id}:${row.user_id}`,
        this.normalizeWorkspaceAccess(row.access_level),
      ]),
    );

    return uniqueWorkspaceIds.map((workspaceId) => ({
      workspaceId,
      memberCount: orgMembers.filter((member) => {
        const stored = accessByWorkspaceAndUser.get(
          `${workspaceId}:${member.user_id}`,
        );
        return (
          stored ?? this.getMemberWorkspaceAccessDefault(member)
        ) !== "none";
      }).length,
      publishedApps: appCountByWorkspace.get(workspaceId) ?? 0,
    }));
  }

  async getWorkspaces(
    includeArchived = false,
  ): Promise<
    Array<{ id: string; name: string; created_at: number; archived: number }>
  > {
    if (includeArchived) {
      return this.sql
        .exec(
          "SELECT id, name, created_at, archived FROM workspaces ORDER BY created_at ASC",
        )
        .toArray() as unknown as Array<{
        id: string;
        name: string;
        created_at: number;
        archived: number;
      }>;
    }
    return this.sql
      .exec(
        "SELECT id, name, created_at, archived FROM workspaces WHERE archived = 0 ORDER BY created_at ASC",
      )
      .toArray() as unknown as Array<{
      id: string;
      name: string;
      created_at: number;
      archived: number;
    }>;
  }

  async getWorkspaceBySlug(slug: string): Promise<{
    id: string;
    name: string;
    created_at: number;
    archived: number;
  } | null> {
    const workspaces = this.sql
      .exec(
        "SELECT id, name, created_at, archived FROM workspaces WHERE archived = 0",
      )
      .toArray() as Array<{
      id: string;
      name: string;
      created_at: number;
      archived: number;
    }>;
    const normalizedSlug = slug.toLowerCase();
    return (
      workspaces.find(
        (ws) => slugifyWorkspaceName(ws.name) === normalizedSlug,
      ) ?? null
    );
  }

  async transferOwnership(actorId: string, newOwnerId: string): Promise<void> {
    const currentOwnerRows = this.sql
      .exec(
        "SELECT user_id, joined_at FROM members WHERE role = ? LIMIT 1",
        "owner",
      )
      .toArray() as Array<{ user_id: string; joined_at: number }>;
    const currentOwner = currentOwnerRows[0]?.user_id;
    if (!currentOwner) {
      throw new Error("No owner found");
    }
    if (currentOwner !== actorId) {
      throw new Error("Only the owner can transfer ownership");
    }

    const newOwnerRows = this.sql
      .exec("SELECT joined_at FROM members WHERE user_id = ?", newOwnerId)
      .toArray() as Array<{ joined_at: number }>;
    if (newOwnerRows.length === 0) {
      throw new Error("New owner is not a member");
    }

    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "owner",
      newOwnerId,
    );
    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "admin",
      currentOwner,
    );
    this.log("ownership_transferred", actorId, newOwnerId, {
      from_user_id: currentOwner,
    });
    this.dispatchOrgMembershipUpsert(
      newOwnerId,
      "owner",
      newOwnerRows[0]!.joined_at,
    );
    this.dispatchOrgMembershipUpsert(
      currentOwner,
      "admin",
      currentOwnerRows[0]!.joined_at,
    );
  }

  async adminTransferOwnership(
    actorId: string,
    newOwnerId: string,
  ): Promise<void> {
    const currentOwnerRows = this.sql
      .exec(
        "SELECT user_id, joined_at FROM members WHERE role = ? LIMIT 1",
        "owner",
      )
      .toArray() as Array<{ user_id: string; joined_at: number }>;
    const currentOwner = currentOwnerRows[0]?.user_id;
    if (!currentOwner) {
      throw new Error("No owner found");
    }

    const newOwnerRows = this.sql
      .exec("SELECT joined_at FROM members WHERE user_id = ?", newOwnerId)
      .toArray() as Array<{ joined_at: number }>;
    if (newOwnerRows.length === 0) {
      throw new Error("New owner is not a member");
    }

    if (newOwnerId === currentOwner) {
      return;
    }

    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "owner",
      newOwnerId,
    );
    this.sql.exec(
      "UPDATE members SET role = ? WHERE user_id = ?",
      "admin",
      currentOwner,
    );
    this.log("ownership_transferred", actorId, newOwnerId, {
      from_user_id: currentOwner,
    });
    this.dispatchOrgMembershipUpsert(
      newOwnerId,
      "owner",
      newOwnerRows[0]!.joined_at,
    );
    this.dispatchOrgMembershipUpsert(
      currentOwner,
      "admin",
      currentOwnerRows[0]!.joined_at,
    );
  }

  async archiveOrg(actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (!info) {
      throw new Error("Organization not found");
    }
    if (info.archived) return;
    info.archived = true;
    info.archived_at = Date.now();
    info.archived_by = actorId;
    await this.setInfo(info);
    this.log("org_archived", actorId);
  }

  /**
   * Permanently delete all organization data from this Durable Object.
   * This is intended for superuser-only test account resets.
   */
  async hardDeleteOrg(actorId: string): Promise<void> {
    const info = await this.getInfo();
    if (!info) {
      return;
    }

    // Clean up slug→org KV mapping
    try {
      await this.env.APP_KV.delete(`${ORG_SLUG_KV_PREFIX}${info.slug}`);
    } catch {
      // Best-effort slug cleanup.
    }
    try {
      await this.unindexOrg(info.id);
    } catch {
      // Best-effort cleanup; stale index only affects enumeration.
    }

    this.sql.exec("DELETE FROM org_info WHERE key IN (?, ?)", "data", ORG_SSO_CONFIG_KEY);
    this.sql.exec("DELETE FROM enterprise_sso_transactions");
    this.sql.exec("DELETE FROM enterprise_sso_identities");
    this.sql.exec("DELETE FROM members");
    this.sql.exec("DELETE FROM workspace_memberships");
    this.sql.exec("DELETE FROM invitations");
    this.sql.exec("DELETE FROM integrations");
    this.sql.exec("DELETE FROM integration_definitions");
    this.sql.exec("DELETE FROM workspaces");
    this.sql.exec("DELETE FROM audit_log");
    this.sql.exec("DELETE FROM worker_scripts");
    this.sql.exec("DELETE FROM threads");
    this.sql.exec("DELETE FROM proxy_usage");
    this.sql.exec("DELETE FROM openai_subscription");

    console.log("[OrgDO] hard deleted org", {
      orgId: info.id,
      actorId,
    });
  }

  async getAuditLog(
    limit = 100,
    offset = 0,
  ): Promise<
    Array<{
      id: string;
      action: string;
      actor_id: string;
      target_id: string | null;
      details: string | null;
      created_at: number;
    }>
  > {
    const resolvedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const resolvedOffset = Math.max(0, Math.floor(offset));
    return this.sql
      .exec(
        "SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?",
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as Array<{
      id: string;
      action: string;
      actor_id: string;
      target_id: string | null;
      details: string | null;
      created_at: number;
    }>;
  }

  async getWorkspaceAuditLog(
    workspaceId: string,
    limit = 100,
    offset = 0,
  ): Promise<
    Array<{
      id: string;
      action: string;
      actor_id: string;
      target_id: string | null;
      details: string | null;
      created_at: number;
    }>
  > {
    const resolvedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const resolvedOffset = Math.max(0, Math.floor(offset));
    return this.sql
      .exec(
        `SELECT *
           FROM audit_log
          WHERE target_id = ?
             OR json_extract(details, '$.workspace_id') = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
        workspaceId,
        workspaceId,
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as Array<{
      id: string;
      action: string;
      actor_id: string;
      target_id: string | null;
      details: string | null;
      created_at: number;
    }>;
  }

  // Thread methods (consolidated from ChatIndexDO)

  /**
   * Get all threads across all workspaces in this org
   */
  getThreads(): OrgThread[] {
    this.ensureThreadSchemaColumns();
    return this.sql
      .exec(
        `SELECT ${THREAD_LIST_SELECT_COLUMNS} FROM threads ORDER BY updated_at DESC`,
      )
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Get threads for a specific workspace
   */
  getThreadsByWorkspace(workspaceId: string): OrgThread[] {
    this.ensureThreadSchemaColumns();
    return this.sql
      .exec(
        `SELECT ${THREAD_LIST_SELECT_COLUMNS} FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC`,
        workspaceId,
      )
      .toArray() as unknown as OrgThread[];
  }

  /**
   * Get threads with pagination (optionally filtered by workspace and creator)
   */
  getThreadsPaginated(
    offset = 0,
    limit = 50,
    workspaceId?: string,
    createdBy?: string,
    searchQuery?: string,
  ): { items: OrgThread[]; total: number; offset: number; limit: number } {
    this.ensureThreadSchemaColumns();
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    const whereClauses: string[] = [];
    const whereParams: (string | number)[] = [];

    if (workspaceId) {
      whereClauses.push("workspace_id = ?");
      whereParams.push(workspaceId);
    }
    if (createdBy) {
      whereClauses.push("created_by = ?");
      whereParams.push(createdBy);
    }
    const includeAskLog = appendThreadSearchClauses(
      whereClauses,
      whereParams,
      searchQuery,
    );
    if (includeAskLog) {
      this.backfillThreadSearchMetadataBatch();
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const selectColumns = includeAskLog
      ? THREAD_SEARCH_SELECT_COLUMNS
      : THREAD_LIST_SELECT_COLUMNS;

    const items = this.sql
      .exec(
        `SELECT ${selectColumns} FROM threads ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...whereParams,
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as OrgThread[];

    const totalRows = this.sql
      .exec(`SELECT COUNT(*) as count FROM threads ${whereSql}`, ...whereParams)
      .toArray() as Array<{ count: number }>;
    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  /**
   * Get threads across specific workspaces with pagination.
   */
  getThreadsAllWorkspacesPaginated(
    workspaceIds: string[],
    offset = 0,
    limit = 50,
    createdBy?: string,
    searchQuery?: string,
  ): { items: OrgThread[]; total: number; offset: number; limit: number } {
    this.ensureThreadSchemaColumns();
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));

    if (workspaceIds.length === 0) {
      return {
        items: [],
        total: 0,
        offset: resolvedOffset,
        limit: resolvedLimit,
      };
    }

    const placeholders = workspaceIds.map(() => "?").join(",");
    const whereClauses = [`workspace_id IN (${placeholders})`];
    const queryParams: (string | number)[] = [...workspaceIds];

    if (createdBy) {
      whereClauses.push("created_by = ?");
      queryParams.push(createdBy);
    }
    const includeAskLog = appendThreadSearchClauses(
      whereClauses,
      queryParams,
      searchQuery,
    );
    if (includeAskLog) {
      this.backfillThreadSearchMetadataBatch();
    }

    const whereSql = whereClauses.join(" AND ");
    const selectColumns = includeAskLog
      ? THREAD_SEARCH_SELECT_COLUMNS
      : THREAD_LIST_SELECT_COLUMNS;

    const items = this.sql
      .exec(
        `SELECT ${selectColumns} FROM threads WHERE ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
        ...queryParams,
        resolvedLimit,
        resolvedOffset,
      )
      .toArray() as unknown as OrgThread[];

    const totalRows = this.sql
      .exec(
        `SELECT COUNT(*) as count FROM threads WHERE ${whereSql}`,
        ...queryParams,
      )
      .toArray() as Array<{ count: number }>;
    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  getThreadCreators(workspaceId?: string): Array<{
    created_by: string;
    thread_count: number;
    latest_updated_at: number;
  }> {
    this.ensureThreadSchemaColumns();

    const whereClauses: string[] = [];
    const params: string[] = [];

    if (workspaceId) {
      whereClauses.push("workspace_id = ?");
      params.push(workspaceId);
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    return this.sql
      .exec(
        `SELECT created_by, COUNT(*) as thread_count, MAX(updated_at) as latest_updated_at
         FROM threads ${whereSql}
         GROUP BY created_by
         ORDER BY latest_updated_at DESC`,
        ...params,
      )
      .toArray() as Array<{
      created_by: string;
      thread_count: number;
      latest_updated_at: number;
    }>;
  }

  getThreadCreatorsAllWorkspaces(workspaceIds: string[]): Array<{
    created_by: string;
    thread_count: number;
    latest_updated_at: number;
  }> {
    this.ensureThreadSchemaColumns();

    if (workspaceIds.length === 0) {
      return [];
    }

    const placeholders = workspaceIds.map(() => "?").join(", ");

    return this.sql
      .exec(
        `SELECT created_by, COUNT(*) as thread_count, MAX(updated_at) as latest_updated_at
         FROM threads
         WHERE workspace_id IN (${placeholders})
         GROUP BY created_by
         ORDER BY latest_updated_at DESC`,
        ...workspaceIds,
      )
      .toArray() as Array<{
      created_by: string;
      thread_count: number;
      latest_updated_at: number;
    }>;
  }

  /**
   * Create a new thread with a server-generated UUID
   */
  createThread(
    workspaceId: string,
    title: string | undefined,
    createdBy?: string,
    firstUserMessage?: string,
    model?: LlmModel,
    options: CreateThreadOptions = {},
  ): OrgThread {
    const startedAt = Date.now();
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = title || DEFAULT_THREAD_TITLE;
    const creator = createdBy?.trim() || "system";
    const ids = {
      threadId: id,
      workspaceId,
      userId: creator,
    };
    const normalizedUserMessage = firstUserMessage
      ? normalizeThreadUserMessageText(firstUserMessage)
      : null;
    const msg = normalizedUserMessage;
    const lastUserMessage = normalizedUserMessage;
    const lastUserMessageAt = lastUserMessage ? now : null;
    const normalizedModel = normalizeThreadModelForStorage(model);
    const source = options.source?.trim() || "web";
    const channelKind = options.channelKind?.trim() || null;
    const normalizedChannelKind = normalizeChannelIndicatorKind(channelKind);
    const channelKinds = normalizedChannelKind
      ? JSON.stringify([normalizedChannelKind])
      : null;
    const channelConnectionId = options.channelConnectionId?.trim() || null;
    const channelConversationId = options.channelConversationId?.trim() || null;
    const channelMessageId = options.channelMessageId?.trim() || null;
    const modelHistory = JSON.stringify([normalizedModel]);
    this.recordThreadCreateStage("prepared", startedAt, ids, {
      size: msg?.length ?? 0,
    });

    const insertStartedAt = Date.now();
    try {
      this.sql.exec(
        `INSERT INTO threads (
           id,
           workspace_id,
           title,
           title_search,
           created_by,
           model,
           created_at,
           updated_at,
           source,
           first_user_message,
           last_user_message,
           last_user_message_at,
           channel_kind,
           channel_kinds,
           channel_connection_id,
           channel_conversation_id,
           channel_message_id,
           model_history,
           last_model_changed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        workspaceId,
        t,
        normalizeThreadSearchTitle(t),
        creator,
        normalizedModel,
        now,
        now,
        source,
        msg,
        lastUserMessage,
        lastUserMessageAt,
        channelKind,
        channelKinds,
        channelConnectionId,
        channelConversationId,
        channelMessageId,
        modelHistory,
        now,
      );
      this.recordThreadCreateStage("thread_inserted", insertStartedAt, ids, {
        size: msg?.length ?? 0,
      });
    } catch (error) {
      console.error("[OrgDO] failed to insert thread", error);
      this.recordThreadCreateError("thread_insert", insertStartedAt, error, ids);
      throw error;
    }

    const thread = {
      id,
      workspace_id: workspaceId,
      title: t,
      created_by: creator,
      model: normalizedModel,
      created_at: now,
      updated_at: now,
      user_message_count: 0,
      first_user_message: msg,
      last_user_message: lastUserMessage,
      last_user_message_at: lastUserMessageAt,
      last_assistant_completed_at: null,
      last_assistant_summary: null,
      last_assistant_summary_status: null,
      source,
      channel_kind: channelKind,
      channel_kinds: channelKinds,
      channel_connection_id: channelConnectionId,
      channel_conversation_id: channelConversationId,
      channel_message_id: channelMessageId,
      chat_error_count: 0,
      last_chat_error_at: null,
      last_chat_error_message: null,
      last_chat_error_source: null,
      last_chat_error_status: null,
      last_chat_error_provider: null,
      last_chat_error_model: null,
      model_history: modelHistory,
      last_model_changed_at: now,
    };

    const scheduleStartedAt = Date.now();
    this.scheduleThreadCreateSideEffects(thread, creator, {
      workspace_id: workspaceId,
      title: t,
      source,
      channel_kind: channelKind,
    });
    this.recordThreadCreateStage("side_effects_scheduled", scheduleStartedAt, ids);
    return thread;
  }

  /**
   * Get a thread by ID
   */
  getThread(id: string): OrgThread | null {
    return this.selectThreadById(id, false);
  }

  private selectThreadById(id: string, includeAskLog: boolean): OrgThread | null {
    this.ensureThreadSchemaColumns();
    const selectColumns = includeAskLog
      ? THREAD_INTERNAL_ASK_LOG_SELECT_COLUMNS
      : THREAD_LIST_SELECT_COLUMNS;
    const rows = this.sql
      .exec(
        `SELECT ${selectColumns} FROM threads WHERE id = ?`,
        id,
      )
      .toArray() as unknown as OrgThread[];
    return rows[0] || null;
  }

  async getThreadWithOrgSlug(id: string): Promise<OrgThreadWithOrgSlug> {
    const orgInfo = await this.getInfo().catch(() => null);
    return {
      thread: this.getThread(id),
      orgSlug: orgInfo?.slug ?? null,
    };
  }

  getThreadsByIds(workspaceId: string, ids: string[]): OrgThread[] {
    this.ensureThreadSchemaColumns();
    const normalizedWorkspaceId = workspaceId.trim();
    const uniqueIds = Array.from(
      new Set(ids.map((id) => id.trim()).filter(Boolean)),
    );
    if (!normalizedWorkspaceId || uniqueIds.length === 0) {
      return [];
    }
    const placeholders = uniqueIds.map(() => "?").join(", ");
    return this.sql
      .exec(
        `SELECT ${THREAD_LIST_SELECT_COLUMNS} FROM threads WHERE workspace_id = ? AND id IN (${placeholders})`,
        normalizedWorkspaceId,
        ...uniqueIds,
      )
      .toArray() as unknown as OrgThread[];
  }

  // Test helper RPC: simulate a legacy thread schema before model columns existed.
  async downgradeThreadSchemaForTest(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DROP TABLE IF EXISTS threads_legacy_test");
      this.sql.exec(`
        CREATE TABLE threads_legacy_test (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          user_message_count INTEGER NOT NULL DEFAULT 0,
          first_user_message TEXT
        )
      `);
      this.sql.exec(`
        INSERT INTO threads_legacy_test (
          id,
          workspace_id,
          title,
          created_by,
          created_at,
          updated_at,
          source,
          user_message_count,
          first_user_message
        )
        SELECT
          id,
          workspace_id,
          title,
          created_by,
          created_at,
          updated_at,
          COALESCE(source, 'web'),
          COALESCE(user_message_count, 0),
          first_user_message
        FROM threads
      `);
      this.sql.exec("DROP TABLE threads");
      this.sql.exec("ALTER TABLE threads_legacy_test RENAME TO threads");
    });
    this.ctx.storage.kv.put("schemaVersion", 20);
  }

  // Test helper RPC: simulate a thread schema before channel_kinds existed.
  async downgradeThreadChannelKindsSchemaForTest(
    schemaVersion = 30,
  ): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DROP TABLE IF EXISTS threads_channel_kinds_legacy_test");
      this.sql.exec(`
        CREATE TABLE threads_channel_kinds_legacy_test (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '${DEFAULT_LLM_MODEL}',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'web',
          user_message_count INTEGER NOT NULL DEFAULT 0,
          first_user_message TEXT,
          last_user_message TEXT,
          last_user_message_at INTEGER,
          last_assistant_completed_at INTEGER,
          last_assistant_summary TEXT,
          last_assistant_summary_status TEXT,
          channel_kind TEXT,
          channel_connection_id TEXT,
          channel_conversation_id TEXT,
          channel_message_id TEXT
        )
      `);
      this.sql.exec(`
        INSERT INTO threads_channel_kinds_legacy_test (
          id,
          workspace_id,
          title,
          created_by,
          model,
          created_at,
          updated_at,
          source,
          user_message_count,
          first_user_message,
          last_user_message,
          last_user_message_at,
          last_assistant_completed_at,
          last_assistant_summary,
          last_assistant_summary_status,
          channel_kind,
          channel_connection_id,
          channel_conversation_id,
          channel_message_id
        )
        SELECT
          id,
          workspace_id,
          title,
          created_by,
          model,
          created_at,
          updated_at,
          source,
          user_message_count,
          first_user_message,
          last_user_message,
          last_user_message_at,
          last_assistant_completed_at,
          last_assistant_summary,
          last_assistant_summary_status,
          channel_kind,
          channel_connection_id,
          channel_conversation_id,
          channel_message_id
        FROM threads
      `);
      this.sql.exec("DROP TABLE threads");
      this.sql.exec(
        "ALTER TABLE threads_channel_kinds_legacy_test RENAME TO threads",
      );
    });
    this.ctx.storage.kv.put("schemaVersion", schemaVersion);
  }

  // Test helper RPC: force a stored schema version before remigration.
  async setSchemaVersionForTest(version: number): Promise<void> {
    this.ctx.storage.kv.put("schemaVersion", version);
  }

  // Test helper RPC: simulate constructor migration path on an existing OrgDO.
  async remigrate(): Promise<void> {
    this.migrate();
  }

  // Test helper RPC: advance the lazy V46 data migration by one bounded batch.
  async runThreadSearchBackfillBatchForTest(
    batchSize = THREAD_SEARCH_BACKFILL_BATCH_SIZE,
  ): Promise<{ processed: number; complete: boolean }> {
    this.ensureThreadSchemaColumns();
    return this.backfillThreadSearchMetadataBatch(batchSize);
  }

  // Test helper RPC: simulate a workspace that has not crossed the tenant-data
  // migration boundary yet.
  async clearWorkspaceTenantMigrationMarkersForTest(
    workspaceId: string,
  ): Promise<void> {
    this.ctx.storage.kv.delete(this.workspaceAccessMigrationKey(workspaceId));
    this.ctx.storage.kv.delete(this.workspaceIntegrationsMigrationKey(workspaceId));
  }

  /**
   * Update a thread's title
   */
  updateThread(id: string, title: string, actorId?: string): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const now = Date.now();
    this.sql.exec(
      "UPDATE threads SET title = ?, title_search = ?, updated_at = ? WHERE id = ?",
      title,
      normalizeThreadSearchTitle(title),
      now,
      id,
    );
    if (actorId) {
      this.log("thread_updated", actorId, id, { title });
    }
    const updated = {
      ...existing,
      title,
      updated_at: now,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread update to AdminIndex", err);
      });
    return updated;
  }

  updateThreadModel(
    id: string,
    model: LlmModel,
    actorId?: string,
    expectedModel?: LlmModel,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    if (
      expectedModel !== undefined &&
      (resolveStoredLlmModel(existing.model) ?? existing.model) !==
        (resolveStoredLlmModel(expectedModel) ?? expectedModel)
    ) {
      return null;
    }
    const normalizedModel = normalizeThreadModelForStorage(model);
    if (normalizedModel === existing.model) {
      return existing;
    }
    const now = Date.now();
    const modelHistory = mergeModelHistory(existing.model_history, normalizedModel);
    this.sql.exec(
      "UPDATE threads SET model = ?, updated_at = ?, model_history = ?, last_model_changed_at = ? WHERE id = ?",
      normalizedModel,
      now,
      modelHistory,
      now,
      id,
    );
    if (actorId) {
      this.log("thread_model_updated", actorId, id, {
        model: normalizedModel,
      });
    }
    const updated: OrgThread = {
      ...existing,
      model: normalizedModel,
      updated_at: now,
      model_history: modelHistory,
      last_model_changed_at: now,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread model update to AdminIndex", err);
      });
    return updated;
  }

  /**
   * Set the canonical first user message used to hydrate new thread transcripts.
   * This intentionally does not modify updated_at to avoid reordering threads.
   */
  setThreadFirstUserMessage(
    id: string,
    firstUserMessage: string,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;

    const message = normalizeThreadUserMessageText(firstUserMessage);
    if (!message) {
      return existing;
    }

    const result = this.sql.exec(
      "UPDATE threads SET first_user_message = ? WHERE id = ? AND (first_user_message IS NULL OR first_user_message = '')",
      message,
      id,
    );

    const updated = this.getThread(id);
    if (updated && result.rowsWritten > 0) {
      this.syncThreadToAdminIndex(updated, "thread first user message");
    }
    return updated;
  }

  recordThreadChannelUsed(
    id: string,
    channelKind: string | null | undefined,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const nextChannelKinds = mergeThreadChannelKinds(
      existing.channel_kinds,
      channelKind,
    );
    if (!nextChannelKinds) return existing;

    this.sql.exec(
      "UPDATE threads SET channel_kinds = ? WHERE id = ?",
      nextChannelKinds,
      id,
    );
    const updated = { ...existing, channel_kinds: nextChannelKinds };
    this.syncThreadToAdminIndex(updated, "thread channel usage");
    return updated;
  }

  /**
   * Admin: Update thread with arbitrary fields
   */
  adminUpdateThread(
    id: string,
    updates: { title?: string; created_by?: string; model?: LlmModel },
    actorId?: string,
  ): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const normalizedModel =
      updates.model !== undefined
        ? normalizeThreadModelForStorage(updates.model)
        : normalizeThreadModelForStorage(existing.model);
    const shouldPersistModel =
      updates.model !== undefined || normalizedModel !== existing.model;
    const now = Date.now();

    const setClauses: string[] = ["updated_at = ?"];
    const params: (string | number)[] = [now];

    if (updates.title !== undefined) {
      setClauses.push("title = ?");
      params.push(updates.title);
      setClauses.push("title_search = ?");
      params.push(normalizeThreadSearchTitle(updates.title));
    }
    if (updates.created_by !== undefined) {
      setClauses.push("created_by = ?");
      params.push(updates.created_by);
    }
    const nextModelHistory = shouldPersistModel
      ? mergeModelHistory(existing.model_history, normalizedModel)
      : existing.model_history;
    if (shouldPersistModel) {
      setClauses.push("model = ?");
      params.push(normalizedModel);
      setClauses.push("model_history = ?");
      params.push(nextModelHistory ?? JSON.stringify([normalizedModel]));
      setClauses.push("last_model_changed_at = ?");
      params.push(now);
    }

    params.push(id);
    this.sql.exec(
      `UPDATE threads SET ${setClauses.join(", ")} WHERE id = ?`,
      ...params,
    );

    if (actorId) {
      this.log("thread_admin_updated", actorId, id, updates);
    }

    const updated = {
      ...existing,
      title: updates.title ?? existing.title,
      created_by: updates.created_by ?? existing.created_by,
      model: normalizedModel,
      updated_at: now,
      model_history: nextModelHistory,
      last_model_changed_at: shouldPersistModel ? now : existing.last_model_changed_at,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync admin thread update to AdminIndex", err);
      });
    return updated;
  }

  // Test helper RPC: simulate a historical thread row with a removed model id.
  setThreadModelForTest(id: string, model: string): OrgThread | null {
    const existing = this.getThread(id);
    if (!existing) return null;
    const modelHistory = mergeModelHistory(existing.model_history, model);
    this.sql.exec(
      "UPDATE threads SET model = ?, model_history = ?, last_model_changed_at = ? WHERE id = ?",
      model,
      modelHistory,
      Date.now(),
      id,
    );
    return this.getThread(id);
  }

  /**
   * Delete a thread
   */
  deleteThread(id: string, actorId?: string): boolean {
    const existing = this.getThread(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM threads WHERE id = ?", id);
    if (actorId) {
      this.log("thread_deleted", actorId, id, {
        workspace_id: existing.workspace_id,
      });
    }
    dispatchAdminEvent(this.ctx, this.env, {
      type: "thread_delete",
      payload: { id, workspace_id: existing.workspace_id },
    });
    return true;
  }

  /**
   * Touch a thread (update its updated_at timestamp and increment user message count)
   */
  touchThread(id: string): void {
    const existing = this.getThread(id);
    if (!existing) return;
    const now = Date.now();
    this.sql.exec(
      "UPDATE threads SET updated_at = ?, user_message_count = user_message_count + 1, last_user_message_at = ? WHERE id = ?",
      now,
      now,
      id,
    );
    const updated = {
      ...existing,
      updated_at: now,
      user_message_count: existing.user_message_count + 1,
      last_user_message_at: now,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread touch to AdminIndex", err);
      });
  }

  recordThreadUserMessage(
    id: string,
    message: string,
    source?: string | null,
  ): OrgThread | null {
    const existing = this.selectThreadById(id, true);
    if (!existing) return null;
    const now = Date.now();
    const lastUserMessage = normalizeThreadUserMessageText(message);
    const askLog = appendToThreadAskLog(
      existing.user_ask_log ?? null,
      lastUserMessage,
    );
    const userMessageCount = (existing.user_message_count ?? 0) + 1;
    const nextChannelKinds = mergeThreadChannelKinds(
      existing.channel_kinds,
      source,
    );
    const setClauses = [
      "updated_at = ?",
      "user_message_count = user_message_count + 1",
      "last_user_message = ?",
      "last_user_message_at = ?",
    ];
    const params: Array<string | number | null> = [now, lastUserMessage, now];
    if (nextChannelKinds) {
      setClauses.push("channel_kinds = ?");
      params.push(nextChannelKinds);
    }
    if (askLog !== (existing.user_ask_log ?? null)) {
      setClauses.push("user_ask_log = ?");
      params.push(askLog);
    }
    params.push(id);
    this.sql.exec(
      `UPDATE threads SET ${setClauses.join(", ")} WHERE id = ?`,
      ...params,
    );
    const updated: OrgThread = {
      ...existing,
      updated_at: now,
      user_message_count: userMessageCount,
      last_user_message: lastUserMessage,
      user_ask_log: askLog,
      last_user_message_at: now,
      channel_kinds: nextChannelKinds ?? existing.channel_kinds,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread user message to AdminIndex", err);
    });
    return withoutThreadAskLog(updated);
  }

  async recordThreadError(
    id: string,
    input: RecordThreadErrorInput,
  ): Promise<OrgThread | null> {
    const existing = this.getThread(id);
    if (!existing) return null;
    const info = await this.getInfo();
    if (!info) return null;

    const event = buildChatErrorEventPayload({
      threadId: id,
      orgId: info.id,
      workspaceId: existing.workspace_id,
      userId: input.userId ?? existing.created_by ?? null,
      message: input.message,
      source: input.source,
      errorKind: input.errorKind,
      status: input.status,
      provider: input.provider,
      model: input.model ?? existing.model,
      createdAt: input.createdAt,
    });
    const now = event.created_at;
    this.ensureThreadErrorEventSchema();
    const inserted = this.sql.exec(
      "INSERT OR IGNORE INTO thread_error_events (id, thread_id, fingerprint, created_at) VALUES (?, ?, ?, ?)",
      event.id,
      id,
      event.fingerprint,
      now,
    );
    if (inserted.rowsWritten === 0) {
      const current = this.getThread(id);
      if (current) {
        dispatchAdminEvent(this.ctx, this.env, {
          type: "thread_upsert",
          payload: toAdminThreadPayload(current, info.id),
        });
        dispatchAdminEvent(this.ctx, this.env, {
          type: "thread_error_recorded",
          payload: event,
        });
      }
      return current;
    }

    const chatErrorCount = (existing.chat_error_count ?? 0) + 1;

    this.sql.exec(
      `UPDATE threads
       SET updated_at = ?,
           chat_error_count = COALESCE(chat_error_count, 0) + 1,
           last_chat_error_at = ?,
           last_chat_error_message = ?,
           last_chat_error_source = ?,
           last_chat_error_status = ?,
           last_chat_error_provider = ?,
           last_chat_error_model = ?
       WHERE id = ?`,
      now,
      now,
      event.message_sample,
      event.source,
      event.status,
      event.provider,
      event.model,
      id,
    );

    const updated: OrgThread = {
      ...existing,
      updated_at: now,
      chat_error_count: chatErrorCount,
      last_chat_error_at: now,
      last_chat_error_message: event.message_sample,
      last_chat_error_source: event.source,
      last_chat_error_status: event.status,
      last_chat_error_provider: event.provider,
      last_chat_error_model: event.model,
    };

    dispatchAdminEvent(this.ctx, this.env, {
      type: "thread_upsert",
      payload: toAdminThreadPayload(updated, info.id),
    });
    dispatchAdminEvent(this.ctx, this.env, {
      type: "thread_error_recorded",
      payload: event,
    });

    this.log("thread_chat_error_recorded", input.userId ?? "system", id, {
      source: event.source,
      status: event.status,
      provider: event.provider,
      model: event.model,
      fingerprint: event.fingerprint,
    });

    return updated;
  }

  recordThreadAssistantCompletion(
    id: string,
    input: {
      completedAt: number;
      summary: string | null;
      summaryStatus?: ThreadCompletionSummaryStatus | null;
    },
  ): number | false {
    const existing = this.getThread(id);
    if (!existing) return false;
    const requestedAt = Number.isFinite(input.completedAt)
      ? input.completedAt
      : Date.now();
    const summary = normalizeThreadCompletionSummary(input.summary);
    const requestedSummaryStatus =
      summary !== null
        ? "ready"
        : normalizeThreadCompletionSummaryStatus(input.summaryStatus);
    const previousCompletedAt = existing.last_assistant_completed_at ?? null;
    if (previousCompletedAt !== null && requestedAt < previousCompletedAt) {
      return false;
    }
    if (
      previousCompletedAt !== null &&
      requestedAt === previousCompletedAt &&
      summary === null &&
      existing.last_assistant_summary_status === "ready" &&
      requestedSummaryStatus !== null
    ) {
      return previousCompletedAt;
    }
    if (
      previousCompletedAt !== null &&
      requestedAt === previousCompletedAt &&
      summary === null &&
      requestedSummaryStatus === null
    ) {
      return previousCompletedAt;
    }
    const isSummaryOnlyUpdate =
      previousCompletedAt !== null &&
      requestedAt === previousCompletedAt &&
      (summary !== null || requestedSummaryStatus !== null);
    const completedAt = isSummaryOnlyUpdate
      ? previousCompletedAt
      : Math.max(
          requestedAt,
          requestedAt < existing.updated_at ? existing.updated_at + 1 : requestedAt,
          previousCompletedAt !== null && requestedAt <= previousCompletedAt
            ? previousCompletedAt + 1
            : requestedAt,
        );
    const updatedAt = isSummaryOnlyUpdate ? existing.updated_at : completedAt;
    this.sql.exec(
      "UPDATE threads SET updated_at = ?, last_assistant_completed_at = ?, last_assistant_summary = ?, last_assistant_summary_status = ? WHERE id = ?",
      updatedAt,
      completedAt,
      summary,
      requestedSummaryStatus,
      id,
    );
    const updated: OrgThread = {
      ...existing,
      updated_at: updatedAt,
      last_assistant_completed_at: completedAt,
      last_assistant_summary: summary,
      last_assistant_summary_status: requestedSummaryStatus,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread assistant completion to AdminIndex", err);
      });
    return completedAt;
  }

  /**
   * Touch a thread for non-user activity without incrementing user message count.
   * Returns true when the persisted activity timestamp moved forward.
   */
  touchThreadActivity(id: string, at = Date.now()): boolean {
    const existing = this.getThread(id);
    if (!existing) return false;
    const requestedAt = Number.isFinite(at) ? at : Date.now();
    const activityAt = Math.max(requestedAt, Date.now(), existing.updated_at + 1);
    this.sql.exec(
      "UPDATE threads SET updated_at = ? WHERE id = ?",
      activityAt,
      id,
    );
    const updated = {
      ...existing,
      updated_at: activityAt,
    };
    this.getInfo()
      .then((info) => {
        if (info)
          dispatchAdminEvent(this.ctx, this.env, {
            type: "thread_upsert",
            payload: toAdminThreadPayload(updated, info.id),
          });
      })
      .catch((err) => {
        console.error("Failed to sync thread activity to AdminIndex", err);
      });
    return true;
  }

  /**
   * One authorization RPC for the chat WebSocket handshake. All authoritative
   * org/workspace/member/access/thread reads happen synchronously in this
   * Durable Object turn, avoiding both a sequential client-side OrgDO RPC chain
   * and compatibility hydration calls on the handshake path.
   */
  async validateChatWebSocketAccess(
    userId: string,
    workspaceId: string,
    threadId: string,
  ): Promise<OrgChatWebSocketAccessResult> {
    const info = this.getInfoSync();
    if (!info || info.archived) {
      return { ok: false, reason: "org_not_found" };
    }

    // Presence in this org-sharded table establishes workspace ownership
    // without hydrating WorkspaceDO metadata on the handshake path.
    const workspace = this.sql
      .exec<{ id: string; archived: number }>(
        "SELECT id, archived FROM workspaces WHERE id = ?",
        workspaceId,
      )
      .toArray()[0];
    if (!workspace || workspace.archived === 1) {
      return { ok: false, reason: "workspace_not_found" };
    }

    const member = this.sql
      .exec<{ found: number }>(
        "SELECT 1 AS found FROM members WHERE user_id = ?",
        userId,
      )
      .toArray()[0];
    if (!member) {
      return { ok: false, reason: "forbidden" };
    }

    const workspaceAccess =
      this.getStoredWorkspaceAccess(workspaceId, userId) ?? "full";
    if (workspaceAccess !== "full") {
      return { ok: false, reason: "forbidden" };
    }

    const thread = this.getThread(threadId);
    if (!thread || thread.workspace_id !== workspaceId) {
      return { ok: false, reason: "thread_not_found" };
    }

    return {
      ok: true,
      orgId: info.id,
      orgSlug: info.slug || info.id.slice(0, 5),
      workspaceId,
      threadId,
    };
  }

  async validateChatThreadAccess(
    userId: string,
    workspaceId: string,
    threadId: string,
  ): Promise<OrgChatThreadAccessResult> {
    const info = await this.getInfo();
    if (!info || info.archived) {
      return { ok: false, reason: "org_not_found" };
    }

    if (!(await this.isMember(userId))) {
      return { ok: false, reason: "forbidden" };
    }

    const thread = this.getThread(threadId);
    if (!thread || thread.workspace_id !== workspaceId) {
      return { ok: false, reason: "thread_not_found" };
    }

    return {
      ok: true,
      orgId: info.id,
      orgSlug: info.slug || info.id.slice(0, 5),
      threadId,
    };
  }

  /**
   * Search threads by title across all workspaces in this org
   */
  searchThreads(query: string, limit = 50): OrgThread[] {
    this.ensureThreadSchemaColumns();
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const searchPattern = `%${query}%`;
    return this.sql
      .exec(
        `SELECT ${THREAD_LIST_SELECT_COLUMNS} FROM threads WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?`,
        searchPattern,
        resolvedLimit,
      )
      .toArray() as unknown as OrgThread[];
  }

  // ─── LLM Provider BYOK Config ─────────────────────────────────

  getOpenAiSubscription(): {
    credentials_encrypted: string;
    account_email: string | null;
    plan_type: string | null;
    created_at: number;
    updated_at: number;
  } | null {
    return this.sql.exec<{
      credentials_encrypted: string;
      account_email: string | null;
      plan_type: string | null;
      created_at: number;
      updated_at: number;
    }>(
      `SELECT credentials_encrypted, account_email, plan_type, created_at, updated_at
       FROM openai_subscription WHERE id = 'active'`,
    ).toArray()[0] ?? null;
  }

  async getFreshOpenAiSubscription(): Promise<ReturnType<OrgDO["getOpenAiSubscription"]>> {
    const initial = this.getOpenAiSubscription();
    if (!initial) return null;
    const secret = this.env.INTEGRATION_SECRET_KEY;
    if (!secret) {
      throw new Error("OpenAI subscription credentials cannot be read without INTEGRATION_SECRET_KEY.");
    }
    const initialCredentials = await decryptCredentials<Record<string, string>>(
      initial.credentials_encrypted,
      secret,
    );
    if (Number(initialCredentials.expires_at) > Date.now() + 5 * 60 * 1000) return initial;

    await this.ctx.blockConcurrencyWhile(async () => {
      const current = this.getOpenAiSubscription();
      if (!current) return;
      const credentials = await decryptCredentials<Record<string, string>>(
        current.credentials_encrypted,
        secret,
      );
      if (Number(credentials.expires_at) > Date.now() + 5 * 60 * 1000) return;
      if (!credentials.access_token || !credentials.refresh_token || !credentials.account_id) {
        throw new Error("Stored OpenAI subscription credentials are incomplete.");
      }
      const refreshed = await refreshOpenAiSubscriptionCredentials({
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        ...(credentials.id_token ? { id_token: credentials.id_token } : {}),
        account_id: credentials.account_id,
        expires_at: Number(credentials.expires_at) || 0,
      } satisfies OpenAiSubscriptionCredentials);
      const encrypted = await encryptCredentials({ ...refreshed.credentials }, secret);
      this.setOpenAiSubscription(
        encrypted,
        refreshed.identity.email ?? current.account_email,
        refreshed.identity.planType ?? current.plan_type,
      );
    });
    return this.getOpenAiSubscription();
  }

  setOpenAiSubscription(
    credentialsEncrypted: string,
    accountEmail: string | null,
    planType: string | null,
  ): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO openai_subscription
         (id, credentials_encrypted, account_email, plan_type, created_at, updated_at)
       VALUES ('active', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         credentials_encrypted = excluded.credentials_encrypted,
         account_email = excluded.account_email,
         plan_type = excluded.plan_type,
         updated_at = excluded.updated_at`,
      credentialsEncrypted,
      accountEmail,
      planType,
      now,
      now,
    );
  }

  deleteOpenAiSubscription(): void {
    this.sql.exec("DELETE FROM openai_subscription WHERE id = 'active'");
  }

  getLlmProviderConfig(): {
    provider: string;
    credentials_encrypted: string;
    config: string;
    created_by: string;
    created_at: number;
    updated_at: number;
  } | null {
    const rows = this.sql
      .exec<{
        provider: string;
        credentials_encrypted: string;
        config: string;
        created_by: string;
        created_at: number;
        updated_at: number;
      }>(
        "SELECT provider, credentials_encrypted, config, created_by, created_at, updated_at FROM llm_provider_config WHERE id = 'active'",
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  setLlmProviderConfig(
    provider: string,
    credentialsEncrypted: string,
    config: string,
    createdBy: string,
  ): void {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO llm_provider_config (id, provider, credentials_encrypted, config, created_by, created_at, updated_at)
       VALUES ('active', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         credentials_encrypted = excluded.credentials_encrypted,
         config = excluded.config,
         created_by = excluded.created_by,
         updated_at = excluded.updated_at`,
      provider,
      credentialsEncrypted,
      config,
      createdBy,
      now,
      now,
    );
    const info = this.getInfoSync();
    if (info) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_llm_provider_update",
        payload: { org_id: info.id, provider, updated_at: now },
      });
    }
  }

  deleteLlmProviderConfig(): boolean {
    this.sql.exec("DELETE FROM llm_provider_config WHERE id = 'active'");
    const info = this.getInfoSync();
    if (info) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "org_llm_provider_update",
        payload: { org_id: info.id, provider: null, updated_at: null },
      });
    }
    return true;
  }

  getActiveThreadIdsForByokChange(): string[] {
    this.ensureThreadSchemaColumns();

    const activeSince = Date.now() - 30 * 60 * 1000;
    return this.sql
      .exec<{ id: string }>(
        "SELECT id FROM threads WHERE updated_at > ? ORDER BY updated_at DESC",
        activeSince,
      )
      .toArray()
      .flatMap((row) => (row.id ? [row.id] : []));
  }

  async notifyByokChanged(): Promise<number> {
    const threadIds = this.getActiveThreadIdsForByokChange();

    for (let index = 0; index < threadIds.length; index += 50) {
      const batch = threadIds.slice(index, index + 50);
      await Promise.allSettled(
        batch.map((threadId) => {
          const chatThread = this.env.CHAT_THREAD.get(
            this.env.CHAT_THREAD.idFromName(threadId),
          ) as unknown as {
            byokChanged(): Promise<void>;
          };

          return chatThread.byokChanged();
        }),
      );
    }

    return threadIds.length;
  }

  hasLlmProviderConfig(): boolean {
    const rows = this.sql
      .exec<{
        cnt: number;
      }>("SELECT COUNT(*) as cnt FROM llm_provider_config WHERE id = 'active'")
      .toArray();
    return (rows[0]?.cnt ?? 0) > 0;
  }

  /**
   * Record proxy usage for a user (rollup per user within the org).
   */
  recordProxyUsage(
    userId: string,
    usage: ProxyUsageInput,
    provider?: string | null,
    model?: string | null,
    tokenId?: string | null,
  ): void {
    const now = Date.now();
    const inputTokens = Math.max(0, Math.floor(usage.input_tokens ?? 0));
    const outputTokens = Math.max(0, Math.floor(usage.output_tokens ?? 0));
    const totalTokens = Math.max(
      0,
      Math.floor(usage.total_tokens ?? inputTokens + outputTokens),
    );
    const cacheCreationTokens = Math.max(
      0,
      Math.floor(usage.cache_creation_input_tokens ?? 0),
    );
    const cacheReadTokens = Math.max(
      0,
      Math.floor(usage.cache_read_input_tokens ?? 0),
    );

    this.sql.exec(
      `
      INSERT INTO proxy_usage (
        user_id,
        input_tokens,
        output_tokens,
        total_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        requests,
        last_provider,
        last_model,
        last_token_id,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        cache_creation_input_tokens = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens = cache_read_input_tokens + excluded.cache_read_input_tokens,
        requests = requests + 1,
        last_provider = excluded.last_provider,
        last_model = excluded.last_model,
        last_token_id = excluded.last_token_id,
        updated_at = excluded.updated_at
      `,
      userId,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheCreationTokens,
      cacheReadTokens,
      1,
      provider ?? null,
      model ?? null,
      tokenId ?? null,
      now,
    );
  }

  consumeCapabilityAllowance(
    input: ConsumeCapabilityAllowanceInput,
  ): CapabilityAllowanceResult {
    if (!isHostedCapability(input.capability)) {
      throw new Error(`Unknown hosted capability: ${String(input.capability)}`);
    }

    const now = usageInteger(input.now_ms) || Date.now();
    const dayKey = utcDayKey(now);
    const resetAtMs = nextUtcDayStart(now);
    const userId = usageText(input.user_id) || "org";
    const idempotencyKey = usageText(input.idempotency_key);
    const info = this.getInfoSync();
    const policy = getCapabilityAllowancePolicy(
      input.capability,
      info?.billing_plan,
      info?.billing_status,
    );
    const dailyLimit = policy.dailyLimit;

    if (dailyLimit === null) {
      return {
        allowed: true,
        capability: input.capability,
        daily_limit: null,
        used: 0,
        remaining: null,
        reset_at_ms: resetAtMs,
      };
    }

    return this.ctx.storage.transactionSync(() => {
      // Retain only today's small counter/event set. Usage telemetry remains in
      // usage_log; this table is solely the current allowance window.
      this.sql.exec("DELETE FROM capability_daily_usage WHERE day_key != ?", dayKey);
      this.sql.exec("DELETE FROM capability_usage_events WHERE day_key != ?", dayKey);

      const readUsed = () => Number(
        this.sql
          .exec<{ used: number }>(
            `SELECT used FROM capability_daily_usage
             WHERE day_key = ? AND capability = ? AND user_id = ?`,
            dayKey,
            input.capability,
            userId,
          )
          .toArray()[0]?.used ?? 0,
      );

      if (idempotencyKey) {
        const existing = this.sql
          .exec<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM capability_usage_events
             WHERE day_key = ? AND capability = ? AND user_id = ? AND idempotency_key = ?`,
            dayKey,
            input.capability,
            userId,
            idempotencyKey,
          )
          .toArray()[0];
        if (existing) {
          const used = readUsed();
          return {
            allowed: true,
            capability: input.capability,
            daily_limit: dailyLimit,
            used,
            remaining: Math.max(0, dailyLimit - used),
            reset_at_ms: resetAtMs,
          };
        }
      }

      const used = readUsed();
      if (used >= dailyLimit) {
        return {
          allowed: false,
          capability: input.capability,
          daily_limit: dailyLimit,
          used,
          remaining: 0,
          reset_at_ms: resetAtMs,
        };
      }

      const nextUsed = used + 1;
      this.sql.exec(
        `INSERT INTO capability_daily_usage (
           day_key, capability, user_id, used, updated_at_ms
         ) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(day_key, capability, user_id) DO UPDATE SET
           used = used + 1,
           updated_at_ms = excluded.updated_at_ms`,
        dayKey,
        input.capability,
        userId,
        now,
      );
      if (idempotencyKey) {
        this.sql.exec(
          `INSERT INTO capability_usage_events (
            idempotency_key, day_key, capability, user_id, created_at_ms
           ) VALUES (?, ?, ?, ?, ?)`,
          idempotencyKey,
          dayKey,
          input.capability,
          userId,
          now,
        );
      }

      return {
        allowed: true,
        capability: input.capability,
        daily_limit: dailyLimit,
        used: nextUsed,
        remaining: Math.max(0, dailyLimit - nextUsed),
        reset_at_ms: resetAtMs,
      };
    });
  }

  recordUsage(usage: UsageRecordInput): {
    id: number;
    cost_usd: number;
    inserted?: boolean;
  } {
    const now = Date.now();
    const workspaceId = usageText(usage.workspace_id);
    const userId = usageText(usage.user_id);
    const threadId = usageText(usage.thread_id);
    const model = usageText(usage.model) || "unknown";
    const provider = usageText(usage.provider) || "unknown";
    const billingSource = usageText(usage.billing_source) || "hosted";
    const creditChargeable =
      usage.credit_chargeable === true || usage.credit_chargeable === 1 ? 1 : 0;
    const inputTokens = usageInteger(usage.input_tokens);
    const outputTokens = usageInteger(usage.output_tokens);
    const cacheCreationTokens = usageInteger(
      usage.cache_creation_input_tokens,
    );
    const cacheReadTokens = usageInteger(usage.cache_read_input_tokens);
    const durationMs = usageInteger(usage.duration_ms);
    const createdAtMs = usageInteger(usage.created_at_ms) || now;
    const providedCost = usageCost(usage.cost_usd);
    const estimatedCost = usageCost(usage.estimated_cost_usd);
    const reportedCost = usageCost(usage.reported_cost_usd);
    const upstreamInferenceCost = usageCost(usage.upstream_inference_cost_usd);
    const effectiveReportedCost = reportedCost !== null && reportedCost > 0
      ? reportedCost
      : upstreamInferenceCost !== null && upstreamInferenceCost > 0
        ? upstreamInferenceCost
        : null;
    const source = usageText(usage.source);
    const sourceId = usageText(usage.source_id);
    const usageKind = normalizeUsageKind(usage.usage_kind);
    const usageSurface = normalizeUsageSurface(usage.usage_surface);
    const costUsd =
      providedCost ??
      (effectiveReportedCost !== null
        ? effectiveReportedCost
        : estimatedCost ?? calculateEffectiveUsageCostUsd({
            model,
            inputTokens,
            outputTokens,
            cacheCreationInputTokens: cacheCreationTokens,
            cacheReadInputTokens: cacheReadTokens,
          }));
    const strictCost = usageKind === "llm"
      ? this.usageControls.resolveStrictCost({
          provider,
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreationTokens,
          cache_read_input_tokens: cacheReadTokens,
          reported_cost_usd: usage.reported_cost_usd,
          upstream_inference_cost_usd: usage.upstream_inference_cost_usd,
        })
      : {
          meteredCostMicrousd: Math.round(costUsd * 1_000_000),
          costSource: "legacy_estimate" as const,
        };

    const result = this.ctx.storage.transactionSync(() => {
      if (source && sourceId) {
        const existing = this.sql
          .exec<{ id: number; cost_usd: number }>(
            "SELECT id, cost_usd FROM usage_log WHERE source = ? AND source_id = ? LIMIT 1",
            source,
            sourceId,
          )
          .toArray()[0];
        if (existing) {
          return {
            id: Number(existing.id ?? 0),
            cost_usd: Number(existing.cost_usd ?? 0),
            inserted: false,
          };
        }
      }
      this.sql.exec(
        `
        INSERT INTO usage_log (
          workspace_id,
          user_id,
          thread_id,
          model,
          provider,
          billing_source,
          credit_chargeable,
          input_tokens,
          output_tokens,
          cache_creation_input_tokens,
          cache_read_input_tokens,
          cost_usd,
          duration_ms,
          created_at_ms,
          source,
          source_id,
          usage_kind,
          usage_surface,
          metered_cost_microusd,
          cost_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        workspaceId,
        userId,
        threadId,
        model,
        provider,
        billingSource,
        creditChargeable,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        costUsd,
        durationMs,
        createdAtMs,
        source,
        sourceId,
        usageKind,
        usageSurface,
        strictCost.meteredCostMicrousd,
        strictCost.costSource,
      );
      this.sql.exec(
        `
        INSERT INTO usage_spend (
          id,
          total_cost_usd,
          total_input_tokens,
          total_output_tokens,
          total_cache_creation_tokens,
          total_cache_read_tokens,
          total_requests,
          updated_at_ms
        )
        VALUES (1, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          total_cost_usd = total_cost_usd + excluded.total_cost_usd,
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
          total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
          total_requests = total_requests + 1,
          updated_at_ms = excluded.updated_at_ms
        `,
        costUsd,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        now,
      );
      const row = this.sql
        .exec<{ id: number }>("SELECT last_insert_rowid() as id")
        .one();
      return {
        id: Number(row?.id ?? 0),
        cost_usd: costUsd,
        inserted: true,
      };
    });

    return result;
  }

  getUsageSpend(): OrgUsageSpend {
    this.sql.exec("INSERT OR IGNORE INTO usage_spend (id) VALUES (1)");
    const row = this.sql
      .exec<{
        total_cost_usd: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_creation_tokens: number;
        total_cache_read_tokens: number;
        total_requests: number;
      }>(
        `
        SELECT
          total_cost_usd,
          total_input_tokens,
          total_output_tokens,
          total_cache_creation_tokens,
          total_cache_read_tokens,
          total_requests
        FROM usage_spend WHERE id = 1
        `,
      )
      .one();
    return {
      org_id: this.getInfoSync()?.id ?? "",
      total_cost_usd: Number(row?.total_cost_usd ?? 0),
      total_requests: Number(row?.total_requests ?? 0),
      total_input_tokens: Number(row?.total_input_tokens ?? 0),
      total_output_tokens: Number(row?.total_output_tokens ?? 0),
      total_cache_creation_input_tokens: Number(
        row?.total_cache_creation_tokens ?? 0,
      ),
      total_cache_read_input_tokens: Number(row?.total_cache_read_tokens ?? 0),
      windows: [],
    };
  }

  getUsageLog(query: UsageLogQuery = {}): UsageLogPage {
    const limit = Math.min(1000, Math.max(1, usageInteger(query.limit) || 50));
    const rawCursor = query.cursor;
    let cursor = 0;
    if (rawCursor !== undefined && rawCursor !== null) {
      const normalizedCursor = String(rawCursor);
      if (!/^[1-9]\d*$/.test(normalizedCursor) || !Number.isSafeInteger(Number(normalizedCursor))) {
        throw new UsageControlsValidationError("cursor must be a positive safe integer");
      }
      cursor = Number(normalizedCursor);
    }
    const hasFrom = query.from !== undefined && query.from !== null;
    const hasTo = query.to !== undefined && query.to !== null;
    const from = hasFrom ? usageInteger(query.from) : null;
    const to = hasTo ? usageInteger(query.to) : null;
    if (from !== null && to !== null && to <= from) {
      throw new UsageControlsValidationError("to must be greater than from");
    }
    const chargeableOnly =
      query.chargeable_only === true || query.chargeable_only === 1;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (cursor > 0) {
      where.push("id < ?");
      params.push(cursor);
    }
    if (from !== null) {
      where.push("created_at_ms >= ?");
      params.push(from);
    }
    if (to !== null) {
      where.push("created_at_ms < ?");
      params.push(to);
    }
    if (chargeableOnly) {
      where.push("credit_chargeable = 1");
    }
    for (const [column, value] of [
      ["user_id", query.user_id],
      ["provider", query.provider],
      ["model", query.model],
      ["usage_kind", query.usage_kind],
      ["usage_surface", query.usage_surface],
    ] as const) {
      if (typeof value === "string") {
        where.push(`${column} = ?`);
        params.push(value.trim());
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.sql
      .exec<UsageLogEntry>(
        `
        SELECT
          id,
          workspace_id,
          user_id,
          thread_id,
          model,
          provider,
          billing_source,
          credit_chargeable,
          input_tokens,
          output_tokens,
          cache_creation_input_tokens,
          cache_read_input_tokens,
          cost_usd,
          metered_cost_microusd,
          cost_source,
          usage_kind,
          usage_surface,
          duration_ms,
          created_at_ms,
          source,
          source_id
        FROM usage_log
        ${whereSql}
        ORDER BY id DESC
        LIMIT ?
        `,
        ...params,
        limit + 1,
      )
      .toArray();
    const entries = rows.slice(0, limit).map((row) => ({
      ...row,
      id: Number(row.id),
      credit_chargeable: Number(row.credit_chargeable),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cache_creation_input_tokens: Number(row.cache_creation_input_tokens),
      cache_read_input_tokens: Number(row.cache_read_input_tokens),
      cost_usd: Number(row.cost_usd),
      metered_cost_microusd:
        row.metered_cost_microusd === null
          ? null
          : Number(row.metered_cost_microusd),
      metered_cost_usd:
        row.metered_cost_microusd === null
          ? null
          : Number((Number(row.metered_cost_microusd) / 1_000_000).toFixed(6)),
      cost_source:
        typeof row.cost_source === "string"
          ? row.cost_source as UsageCostSource
          : "legacy_estimate",
      usage_kind: normalizeUsageKind(row.usage_kind),
      usage_surface: normalizeUsageSurface(row.usage_surface),
      duration_ms: Number(row.duration_ms),
      created_at_ms: Number(row.created_at_ms),
      source: typeof row.source === "string" ? row.source : "",
      source_id: typeof row.source_id === "string" ? row.source_id : "",
    }));
    const hasMore = rows.length > limit;
    return {
      org_id: this.getInfoSync()?.id ?? "",
      entries,
      count: entries.length,
      has_more: hasMore,
      next_cursor:
        hasMore && entries.length > 0
          ? String(entries[entries.length - 1].id)
          : null,
    };
  }

  getUsageLogSum(
    fromMs = 0,
    toMs = Date.now(),
    chargeableOnly = false,
  ): UsageLogSum {
    const from = usageInteger(fromMs);
    const to = usageInteger(toMs) || Date.now();
    const where = ["created_at_ms >= ?", "created_at_ms < ?"];
    const params: Array<string | number> = [from, to];
    if (chargeableOnly) {
      where.push("credit_chargeable = 1");
    }
    const row = this.sql
      .exec<{
        total_cost_usd: number;
        total_requests: number;
        total_input_tokens: number;
        total_output_tokens: number;
        total_cache_creation_input_tokens: number;
        total_cache_read_input_tokens: number;
      }>(
        `
        SELECT
          COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
          COUNT(*) AS total_requests,
          COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
          COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS total_cache_creation_input_tokens,
          COALESCE(SUM(cache_read_input_tokens), 0) AS total_cache_read_input_tokens
        FROM usage_log
        WHERE ${where.join(" AND ")}
        `,
        ...params,
      )
      .one();
    return {
      org_id: this.getInfoSync()?.id ?? "",
      total_cost_usd: Number(row?.total_cost_usd ?? 0),
      total_requests: Number(row?.total_requests ?? 0),
      total_input_tokens: Number(row?.total_input_tokens ?? 0),
      total_output_tokens: Number(row?.total_output_tokens ?? 0),
      total_cache_creation_input_tokens: Number(
        row?.total_cache_creation_input_tokens ?? 0,
      ),
      total_cache_read_input_tokens: Number(
        row?.total_cache_read_input_tokens ?? 0,
      ),
    };
  }

  getUsageLogAggregate(query: UsageAggregateQuery = {}): UsageAggregateResult {
    return this.usageControls.getAggregate(query);
  }

  checkUserLlmUsageAccess(
    input: CheckUserLlmUsageAccessInput,
  ): UserLlmUsageAccessResult {
    return this.usageControls.checkAccess(input);
  }

  getUserLlmUsageReport(query: UserLlmUsageReportQuery): UserLlmUsageReport {
    return this.usageControls.getUserReport(query);
  }

  getUserLlmUsageLimits(userId: string, nowMs = Date.now()) {
    return {
      org_id: this.getInfoSync()?.id ?? "",
      user_id: usageText(userId),
      limits: this.usageControls.getUserLimits(userId),
      status: this.usageControls.getLimitStatus(userId, nowMs),
    };
  }

  setUserLlmUsageLimits(
    userId: string,
    limits: UserLlmUsageLimitInput[],
    updatedBy = "admin_api_key",
  ) {
    this.usageControls.replaceUserLimits(userId, limits, updatedBy);
    const response = this.getUserLlmUsageLimits(userId);
    recordObservabilityEvent(this.env, {
      event: "user_llm_usage_limit_updated",
      component: "org_do",
      operation: "replace_user_llm_usage_limits",
      status: "success",
      orgId: response.org_id,
      userId: response.user_id,
      count: response.limits.length,
    });
    return response;
  }

  getLlmUsagePricing(): LlmPricingResponse {
    return this.usageControls.getPricing();
  }

  setLlmUsagePricing(
    prices: LlmModelPricingInput[],
    updatedBy = "admin_api_key",
  ): LlmPricingResponse {
    const response = this.usageControls.replacePricing(prices, updatedBy);
    recordObservabilityEvent(this.env, {
      event: "llm_usage_pricing_updated",
      component: "org_do",
      operation: "replace_llm_usage_pricing",
      status: "success",
      orgId: response.org_id,
      count: response.prices.length,
    });
    return response;
  }

  getUsageLimits(): OrgUsageLimits {
    const row = this.sql
      .exec<{ limits_json: string | null }>(
        "SELECT limits_json FROM usage_spend WHERE id = 1",
      )
      .one();
    const parsed = row?.limits_json ? JSON.parse(row.limits_json) : [];
    return {
      org_id: this.getInfoSync()?.id ?? "",
      limits: Array.isArray(parsed) ? parsed : [],
    };
  }

  setUsageLimits(limits: OrgUsageLimits["limits"]): OrgUsageLimits {
    const normalized = Array.isArray(limits)
      ? limits.flatMap((limit) => {
          const windowHours = Number(limit.window_hours);
          const limitUsd = Number(limit.limit_usd);
          if (
            !Number.isFinite(windowHours) ||
            windowHours <= 0 ||
            !Number.isFinite(limitUsd) ||
            limitUsd <= 0
          ) {
            return [];
          }
          return [
            {
              window_hours: windowHours,
              limit_usd: limitUsd,
              ...(limit.label?.trim() ? { label: limit.label.trim() } : {}),
            },
          ];
        })
      : [];
    this.sql.exec(
      `
      INSERT INTO usage_spend (id, limits_json, updated_at_ms)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        limits_json = excluded.limits_json,
        updated_at_ms = excluded.updated_at_ms
      `,
      JSON.stringify(normalized),
      Date.now(),
    );
    return {
      org_id: this.getInfoSync()?.id ?? "",
      limits: normalized,
    };
  }
}
