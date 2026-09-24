/**
 * Zod schemas for the admin API.
 *
 * These serve dual purpose:
 * 1. Runtime request validation via hono-zod-openapi's openApi() middleware
 * 2. OpenAPI 3.1 spec auto-generation (schemas are read from routes at startup)
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export const ErrorSchema = z.object({
  error: z.string(),
});

const AvatarSchema = z.object({
  color: z.string(),
  content: z.string(),
});

export const ParsedChatMessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.any(),
  created_at: z.number().int(),
  isMeta: z.boolean().optional(),
  sourceToolUseID: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Pagination & query schemas
// ---------------------------------------------------------------------------

/**
 * Parse a boolean query param from its string representation.
 * z.coerce.boolean() is broken for query strings — Boolean("false") === true.
 * This accepts "true"/"1" → true, "false"/"0" → false, and rejects anything else.
 */
const booleanQueryParam = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

/** Base pagination params shared by all list endpoints. */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  search: z.string().optional(),
});

export const UsersQuerySchema = PaginationQuerySchema.extend({
  is_superuser: booleanQueryParam,
  is_orphaned: booleanQueryParam,
  sort_by: z
    .enum(["created_at", "email", "name"])
    .optional()
    .default("created_at"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const ThreadsQuerySchema = PaginationQuerySchema.extend({
  org_id: z.string().optional(),
  workspace_id: z.string().optional(),
  created_by: z.string().optional(),
  sort_by: z
    .enum(["created_at", "updated_at"])
    .optional()
    .default("updated_at"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const OrgsQuerySchema = PaginationQuerySchema.extend({
  archived: booleanQueryParam,
  exclude_spam: booleanQueryParam,
  exclude_internal_domains: z.string().optional(),
  include_usage: booleanQueryParam,
  include_spend_30d: booleanQueryParam,
  include_llm_provider: booleanQueryParam,
  sort_by: z.enum(["created_at", "name"]).optional().default("created_at"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const OrgLlmProvidersQuerySchema = PaginationQuerySchema.extend({
  provider: z.enum(["anthropic", "bedrock", "custom", "openai", "openrouter", "requesty"]).optional(),
});

export const WorkspacesQuerySchema = PaginationQuerySchema.extend({
  org_id: z.string().optional(),
  archived: booleanQueryParam,
  sort_by: z.enum(["created_at", "name"]).optional().default("created_at"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const AppsQuerySchema = PaginationQuerySchema.extend({
  org_id: z.string().optional(),
  workspace_id: z.string().optional(),
  is_public: booleanQueryParam,
  sort_by: z
    .enum(["created_at", "updated_at"])
    .optional()
    .default("updated_at"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const ChatErrorsQuerySchema = z.object({
  range: z.enum(["1h", "6h", "24h", "7d", "30d"]).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  fingerprint: z.string().optional(),
  org_id: z.string().optional(),
  workspace_id: z.string().optional(),
  thread_id: z.string().optional(),
  user_id: z.string().optional(),
  source: z.string().optional(),
  error_kind: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  status: z.coerce.number().int().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
  threads_limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  threads_offset: z.coerce.number().int().min(0).optional().default(0),
  events_limit: z.coerce.number().int().min(0).max(200).optional().default(0),
  events_offset: z.coerce.number().int().min(0).optional().default(0),
  include_threads: booleanQueryParam,
  include_events: booleanQueryParam,
  include_breakdowns: booleanQueryParam,
  sort_by: z
    .enum(["count", "affected_threads", "last_seen", "first_seen"])
    .optional()
    .default("count"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
});

// ---------------------------------------------------------------------------
// Request schemas (mutations)
// ---------------------------------------------------------------------------

export const AddMemberBodySchema = z.object({
  user_id: z.string(),
  role: z.enum(["admin", "member"]).optional().default("member"),
});

export const BlockSignupIpBodySchema = z.object({
  blocked_by: z.string().optional(),
  reason: z.string().optional(),
});

export const UpdateUserCreditsBodySchema = z.object({
  org_id: z.string().optional(),
  available_credits_cents: z.number().int().min(0).optional(),
  billing_credit_purchase_total_cents: z.number().int().optional(),
  billing_credit_grant_total_cents: z.number().int().optional(),
  billing_credit_usage_started_at: z.number().int().min(0).nullable().optional(),
});

export const LlmModelSchema = z.enum([
  "haiku",
  "sonnet",
  "opus-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-sol-bedrock",
  "gpt-5.6-terra-bedrock",
  "custom",
  "kimi-k2.7-code",
  "grok-4.5",
  "glm-5.3",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "deepseek-v4-pro",
  "deepseek-v4-auto",
  "deepseek-v4-flash",
]);

export const UpdateThreadBodySchema = z.object({
  title: z.string().optional(),
  created_by: z.string().optional(),
  model: LlmModelSchema.exclude(["custom"]).optional(),
});

export const CreateBanBodySchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export const BansQuerySchema = z.object({
  scope: z.enum(["user", "org"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const StatsResponseSchema = z.object({
  total_users: z.number().int(),
  total_orgs: z.number().int(),
  total_memberships: z.number().int(),
  total_workspaces: z.number().int(),
  total_integrations: z.number().int(),
  orphaned_users: z.number().int(),
});

export const UserSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatar: AvatarSchema,
  created_at: z.number(),
  org_count: z.number().int(),
  is_superuser: z.boolean(),
  is_orphaned: z.boolean(),
  signup_ip: z.string().nullable(),
});

export const OrgMembershipSchema = z.object({
  org_id: z.string(),
  role: z.enum(["admin", "member"]),
});

export const UserCreditsResponseSchema = z.object({
  user_id: z.string(),
  org_id: z.string(),
  chargeable_usage_cents: z.number().int(),
  available_credits_cents: z.number().int(),
  total_credit_limit_cents: z.number().int(),
  billing_credit_purchase_total_cents: z.number().int(),
  billing_credit_grant_total_cents: z.number().int(),
  billing_credit_usage_started_at: z.number().int().nullable(),
  previous: z.object({
    available_credits_cents: z.number().int(),
    total_credit_limit_cents: z.number().int(),
    billing_credit_purchase_total_cents: z.number().int(),
    billing_credit_grant_total_cents: z.number().int(),
    billing_credit_usage_started_at: z.number().int().nullable(),
  }),
});

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  archived: z.boolean(),
  billing_status: z.string().nullable().optional(),
  member_count: z.number().int(),
  workspace_count: z.number().int(),
});

export const LlmProviderConfigSchema = z.object({
  provider: z.enum(["anthropic", "bedrock", "custom", "openai", "openrouter", "requesty"]),
  config: z.object({
    aws_region: z.string().optional(),
    custom_name: z.string().optional(),
    custom_base_url: z.string().optional(),
    custom_auth_type: z.enum(["bearer", "x-api-key"]).optional(),
    custom_api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]).optional(),
    custom_model_id: z.string().optional(),
  }),
  key_hint: z.string(),
  created_by: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export const OrgDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  archived: z.boolean(),
  member_count: z.number().int(),
  workspace_count: z.number().int(),
  has_llm_provider: z.boolean(),
  llm_provider: LlmProviderConfigSchema.nullable(),
  threads: z.array(z.any()),
  apps: z.array(z.any()),
  threadCount: z.number().int().nullable(),
  appCount: z.number().int().nullable(),
});

export const GrantOrgCreditsBodySchema = z.object({
  amount_cents: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500).optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
});

export const GrantOrgCreditsResponseSchema = z.object({
  org_id: z.string(),
  applied: z.boolean(),
  grant_id: z.string(),
  amount_cents: z.number().int(),
  reason: z.string().nullable(),
  created_at: z.number().int(),
  created_by: z.string().nullable(),
  source: z.string().nullable(),
  billing_credit_grant_total_cents: z.number().int(),
});

export const RefreshOrgCustomDomainBodySchema = z.object({
  include_active: z.boolean().optional().default(false),
});

const RefreshOrgCustomDomainAppSchema = z.object({
  script_name: z.string(),
  hostname: z.string(),
  action: z.enum(["skipped_active", "refreshed", "failed"]),
  cf_hostname_id: z.string().nullable(),
  status: z.string().nullable(),
  ssl_status: z.string().nullable(),
  error: z.string().nullable(),
});

export const RefreshOrgCustomDomainResponseSchema = z.object({
  org_id: z.string(),
  domain: z.string().nullable(),
  total_apps: z.number().int(),
  attempted: z.number().int(),
  refreshed: z.number().int(),
  failed: z.number().int(),
  skipped_active: z.number().int(),
  apps: z.array(RefreshOrgCustomDomainAppSchema),
});

export const ThreadSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  model: LlmModelSchema,
  workspace_id: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  created_by: z.string().nullable().optional(),
  org_id: z.string(),
  org_name: z.string().nullable().optional(),
  workspace_name: z.string().nullable().optional(),
});

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  org_id: z.string(),
  org_name: z.string(),
  description: z.string().nullable(),
  avatar: AvatarSchema,
  created_at: z.number(),
  created_by: z.string(),
  archived: z.boolean(),
  archived_at: z.number().nullable(),
  archived_by: z.string().nullable(),
  compute_tier: z.string(),
  thread_count: z.number().int(),
  integration_count: z.number().int(),
});

export const AppSchema = z.object({
  app_id: z.string(),
  script_name: z.string(),
  org_id: z.string(),
  workspace_id: z.string(),
  project_id: z.string().nullable().optional(),
  org_name: z.string().nullable().optional(),
  org_slug: z.string().nullable().optional(),
  workspace_name: z.string().nullable().optional(),
  created_by: z.string(),
  created_by_name: z.string().nullable().optional(),
  created_by_email: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number(),
  is_public: z.boolean(),
  preview_status: z.string().nullable().optional(),
  preview_error: z.string().nullable().optional(),
});

export const AddMemberResponseSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  role: z.string(),
});

export const BlockedSignupIpSchema = z.object({
  ip: z.string(),
  blocked: z.boolean(),
  blocked_at: z.number().int().nullable().optional(),
  blocked_by: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

export const KvEntrySchema = z.object({
  name: z.string(),
  metadata: z.unknown().optional(),
});

export const KvValueSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  type: z.enum(["json", "string"]),
});

export const R2ObjectSummarySchema = z.object({
  key: z.string(),
  size: z.number().int(),
  lastModified: z.string(),
  etag: z.string(),
});

export const R2ObjectDetailSchema = z.object({
  key: z.string(),
  size: z.number().int(),
  lastModified: z.string(),
  etag: z.string(),
  httpMetadata: z.record(z.string(), z.unknown()).optional(),
  customMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const ThreadMessagesResponseSchema = z.object({
  success: z.literal(true),
  messages: z.array(ParsedChatMessageSchema),
});

export const BanRecordSchema = z.object({
  scope: z.enum(["user", "org"]),
  target_id: z.string(),
  email: z.string().nullable(),
  org_slug: z.string().nullable(),
  reason: z.string(),
  created_at: z.number().int(),
  created_by: z.string(),
  status: z.literal("active"),
  purge_status: z.enum(["pending", "running", "completed", "failed"]),
  purge_job_id: z.string().nullable(),
  purge_started_at: z.number().int().nullable(),
  purge_completed_at: z.number().int().nullable(),
  purge_error: z.string().nullable(),
});

export const BanStartResponseSchema = z.object({
  ok: z.literal(true),
  scope: z.enum(["user", "org"]),
  target_id: z.string(),
  ban_status: z.literal("active"),
  purge_status: z.enum(["pending", "running", "completed", "failed"]),
  job_id: z.string(),
});

const ChatErrorFiltersSchema = z.object({
  fingerprint: z.string().optional(),
  org_id: z.string().optional(),
  workspace_id: z.string().optional(),
  thread_id: z.string().optional(),
  user_id: z.string().optional(),
  source: z.string().optional(),
  error_kind: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  status: z.number().int().optional(),
  search: z.string().optional(),
});

const ChatErrorSummarySchema = z.object({
  total_events: z.number().int(),
  affected_threads: z.number().int(),
  distinct_groups: z.number().int(),
  latest_error_at: z.number().nullable(),
});

const ChatErrorGroupSchema = z.object({
  fingerprint: z.string(),
  message_sample: z.string(),
  source: z.string(),
  error_kind: z.string().nullable(),
  status: z.number().int().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  count: z.number().int(),
  affected_thread_count: z.number().int(),
  first_seen_at: z.number(),
  last_seen_at: z.number(),
});

const ChatErrorBreakdownRowSchema = z.object({
  value: z.union([z.string(), z.number(), z.null()]),
  count: z.number().int(),
  affected_thread_count: z.number().int(),
  latest_error_at: z.number().nullable(),
});

const ChatErrorThreadSchema = z.object({
  thread_id: z.string(),
  title: z.string().nullable(),
  org_id: z.string(),
  org_name: z.string().nullable(),
  workspace_id: z.string(),
  workspace_name: z.string().nullable(),
  user_id: z.string().nullable(),
  user_email: z.string().nullable(),
  last_seen_at: z.number(),
  count: z.number().int(),
});

const ChatErrorEventSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  thread_id: z.string(),
  title: z.string().nullable(),
  org_id: z.string(),
  org_name: z.string().nullable(),
  workspace_id: z.string(),
  workspace_name: z.string().nullable(),
  user_id: z.string().nullable(),
  user_email: z.string().nullable(),
  created_at: z.number(),
  source: z.string(),
  error_kind: z.string().nullable(),
  status: z.number().int().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  message_sample: z.string(),
  message_normalized: z.string(),
});

export const ChatErrorsResponseSchema = z.object({
  query: z.object({
    from: z.number().int(),
    to: z.number().int(),
    range: z.string().nullable(),
    filters: ChatErrorFiltersSchema,
    limit: z.number().int(),
    offset: z.number().int(),
    threads_limit: z.number().int(),
    threads_offset: z.number().int(),
    events_limit: z.number().int(),
    events_offset: z.number().int(),
  }),
  summary: ChatErrorSummarySchema,
  groups: z.array(ChatErrorGroupSchema),
  breakdowns: z.object({
    source: z.array(ChatErrorBreakdownRowSchema),
    error_kind: z.array(ChatErrorBreakdownRowSchema),
    status: z.array(ChatErrorBreakdownRowSchema),
    provider: z.array(ChatErrorBreakdownRowSchema),
    model: z.array(ChatErrorBreakdownRowSchema),
  }).optional(),
  threads: z.array(ChatErrorThreadSchema).optional(),
  events: z.array(ChatErrorEventSchema).optional(),
});

// ---------------------------------------------------------------------------
// Usage / spend schemas
// ---------------------------------------------------------------------------

export const WindowSpendSchema = z.object({
  label: z.string(),
  window_ms: z.number(),
  limit_usd: z.number(),
  spent_usd: z.number(),
  exceeded: z.boolean(),
});

export const OrgUsageSpendSchema = z.object({
  org_id: z.string(),
  total_cost_usd: z.number(),
  total_requests: z.number().int(),
  windows: z.array(WindowSpendSchema),
});

export const SpamOrgIdsResponseSchema = z.object({
  org_ids: z.array(z.string()),
  count: z.number().int(),
});

export const OrgUsageAnalyticsItemSchema = z.object({
  org_id: z.string(),
  total_cost_usd: z.number(),
  total_requests: z.number().int(),
  spend_7d: z.number(),
  spend_30d: z.number(),
  windows: z.array(WindowSpendSchema).optional(),
});

export const OrgUsageAnalyticsResponseSchema = z.object({
  items: z.array(OrgUsageAnalyticsItemSchema),
  count: z.number().int(),
});

export const AdminOrgListItemSchema = OrgSchema.extend({
  total_requests: z.number().int().optional(),
  total_cost_usd: z.number().optional(),
  spend_30d: z.number().optional(),
  windows: z.array(WindowSpendSchema).optional(),
  has_llm_provider: z.boolean().optional(),
  llm_provider: LlmProviderConfigSchema.nullable().optional(),
});

export const AdminOrgLlmProviderListItemSchema = OrgSchema.extend({
  has_llm_provider: z.literal(true),
  llm_provider: LlmProviderConfigSchema,
});

export const DashboardTopOrgsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  exclude_spam: booleanQueryParam,
  exclude_internal_domains: z.string().optional(),
  sort_by: z
    .enum(["spend_7d", "spend_30d", "member_count"])
    .optional()
    .default("spend_7d"),
});

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DashboardSummaryQuerySchema = z.object({
  date: DateOnlySchema.optional(),
  exclude_spam: booleanQueryParam,
  exclude_internal_domains: z.string().optional(),
});

export const DashboardDailySpendQuerySchema = z.object({
  date: DateOnlySchema.optional(),
  top_orgs_limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export const DashboardRetentionQuerySchema = z.object({
  exclude_spam: booleanQueryParam,
  exclude_internal_domains: z.string().optional(),
});

const NormalizedBillingStatusSchema = z.enum(["active", "free"]);

export const DashboardTopOrgSchema = z.object({
  org_id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  created_at: z.number(),
  created_by: z.string(),
  creator_name: z.string().nullable().optional(),
  creator_email: z.string().nullable().optional(),
  member_count: z.number().int(),
  workspace_count: z.number().int(),
  billing_status: NormalizedBillingStatusSchema,
  total_requests: z.number().int(),
  total_cost_usd: z.number(),
  spend_7d: z.number(),
  spend_30d: z.number(),
  windows: z.array(WindowSpendSchema),
});

export const DashboardTopOrgsResponseSchema = z.object({
  items: z.array(DashboardTopOrgSchema),
  count: z.number().int(),
  limit: z.number().int(),
  sort_by: z.enum(["spend_7d", "spend_30d", "member_count"]),
});

export const DashboardSpamOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable().optional(),
  created_by: z.string(),
  created_at: z.number(),
  archived: z.boolean(),
  billing_status: NormalizedBillingStatusSchema,
  member_count: z.number().int(),
  workspace_count: z.number().int(),
});

export const DashboardSpamSummaryResponseSchema = z.object({
  users: z.array(UserSummarySchema),
  threads: z.array(ThreadSchema),
  apps: z.array(AppSchema),
  orgs: z.array(DashboardSpamOrgSchema),
  org_usage: z.array(DashboardTopOrgSchema),
});

const DashboardGrowthThresholdSchema = z.object({
  flat: z.number(),
  linear: z.number(),
  exponential: z.number(),
  show_exponential: z.boolean(),
});

const DashboardSummaryKpisSchema = z.object({
  total_users: z.number().int(),
  total_orgs: z.number().int(),
  total_threads: z.number().int(),
  total_apps: z.number().int(),
  total_workspaces: z.number().int(),
});

const DashboardDailySeriesItemSchema = z.object({
  date: DateOnlySchema,
  new_users: z.number().int(),
  new_threads: z.number().int(),
  new_apps: z.number().int(),
  returning_users: z.number().int(),
  new_active_users: z.number().int(),
  rolling_avg_signups: z.number(),
});

const DashboardWeeklySeriesItemSchema = z.object({
  week_start: DateOnlySchema,
  label: z.string(),
  new_users: z.number().int(),
  returning_users: z.number().int(),
  projected_new_users: z.number().int(),
  projected_returning_users: z.number().int(),
});

const DashboardTopUserByThreadsSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  avatar: AvatarSchema,
  thread_count: z.number().int(),
});

const DashboardTopOrgByActivitySchema = z.object({
  name: z.string(),
  thread_count: z.number().int(),
});

const DashboardBillingBreakdownItemSchema = z.object({
  status: NormalizedBillingStatusSchema,
  count: z.number().int(),
});

const DashboardRetentionSnapshotSchema = z.object({
  rate_pct: z.number().int(),
  cohort_size: z.number().int(),
  retained_count: z.number().int(),
});

export const DashboardSummaryResponseSchema = z.object({
  kpis: DashboardSummaryKpisSchema,
  daily_series: z.array(DashboardDailySeriesItemSchema),
  weekly_series: z.array(DashboardWeeklySeriesItemSchema),
  growth_thresholds: z.object({
    signups: DashboardGrowthThresholdSchema,
    returning: DashboardGrowthThresholdSchema,
    total_active: DashboardGrowthThresholdSchema,
  }),
  selected_day: z.object({
    date: DateOnlySchema,
    new_users: z.number().int(),
    new_threads: z.number().int(),
    new_apps: z.number().int(),
    new_orgs: z.number().int(),
    top_users_by_threads: z.array(DashboardTopUserByThreadsSchema),
    top_orgs_by_activity: z.array(DashboardTopOrgByActivitySchema),
    latest_threads: z.array(ThreadSchema),
    latest_apps: z.array(AppSchema),
    latest_orgs: z.array(OrgSchema),
    recent_users: z.array(UserSummarySchema),
  }),
  billing_breakdown: z.array(DashboardBillingBreakdownItemSchema),
  app_visibility: z.object({
    public: z.number().int(),
    private: z.number().int(),
  }),
  retention_snapshot: DashboardRetentionSnapshotSchema,
});

const DashboardDailySpendSummarySchema = z.object({
  date: DateOnlySchema,
  total_spend_usd: z.number(),
  total_requests: z.number().int(),
  spam_spend_usd: z.number(),
  non_spam_spend_usd: z.number(),
});

const DashboardDailySpendHourlyRowSchema = z.object({
  hour: z.number().int().min(0).max(23),
  spend_usd: z.number(),
  requests: z.number().int(),
  spam_spend_usd: z.number(),
  non_spam_spend_usd: z.number(),
});

const DashboardDailySpendModelRowSchema = z.object({
  model: z.string(),
  spend_usd: z.number(),
  requests: z.number().int(),
  pct_of_total: z.number(),
});

const DashboardDailySpendTopOrgSchema = z.object({
  org_id: z.string(),
  org_name: z.string(),
  org_slug: z.string().nullable(),
  spend_usd: z.number(),
  requests: z.number().int(),
  is_spam: z.boolean(),
  billing_plan: z.string(),
});

export const DashboardDailySpendResponseSchema = z.object({
  date: DateOnlySchema,
  is_partial: z.boolean(),
  total_spend_usd: z.number(),
  total_requests: z.number().int(),
  spam_spend_usd: z.number(),
  non_spam_spend_usd: z.number(),
  spam_org_count: z.number().int(),
  non_spam_org_count: z.number().int(),
  previous_day: DashboardDailySpendSummarySchema,
  hourly_series: z.array(DashboardDailySpendHourlyRowSchema),
  model_breakdown: z.array(DashboardDailySpendModelRowSchema),
  top_orgs: z.array(DashboardDailySpendTopOrgSchema),
  other_orgs_spend_usd: z.number(),
  other_orgs_count: z.number().int(),
});

const DashboardCohortWeekSchema = z.object({
  pct: z.number().int(),
  count: z.number().int(),
});

const DashboardCohortRowSchema = z.object({
  cohort_label: z.string(),
  cohort_start_date: DateOnlySchema,
  cohort_size: z.number().int(),
  weeks: z.array(DashboardCohortWeekSchema.nullable()),
});

const DashboardRetentionCurvePointSchema = z.object({
  day: z.number().int(),
  retention_pct: z.number().int(),
  users_eligible: z.number().int(),
});

const DashboardWauTimeSeriesItemSchema = z.object({
  week_label: z.string(),
  week_start: DateOnlySchema,
  wau: z.number().int(),
  new_users: z.number().int(),
  returning_users: z.number().int(),
});

const DashboardStickinessSeriesItemSchema = z.object({
  date: DateOnlySchema,
  label: z.string(),
  dau_wau_ratio: z.number(),
  dau: z.number().int(),
  wau: z.number().int(),
});

const DashboardRetentionKpisSchema = z.object({
  day1_retention: z.number().int(),
  day7_retention: z.number().int(),
  day14_retention: z.number().int(),
  day30_retention: z.number().int(),
  current_wau: z.number().int(),
  previous_wau: z.number().int(),
  wau_growth_pct: z.number().int(),
  avg_stickiness: z.number(),
});

export const DashboardRetentionResponseSchema = z.object({
  cohort_table: z.array(DashboardCohortRowSchema),
  max_week_columns: z.number().int(),
  retention_curve: z.array(DashboardRetentionCurvePointSchema),
  wau_time_series: z.array(DashboardWauTimeSeriesItemSchema),
  stickiness_series: z.array(DashboardStickinessSeriesItemSchema),
  kpis: DashboardRetentionKpisSchema,
});

const SpendLimitSchema = z.object({
  window_hours: z.number(),
  limit_usd: z.number(),
  label: z.string().nullable().optional(),
});

export const OrgUsageLimitsSchema = z.object({
  org_id: z.string(),
  limits: z.array(SpendLimitSchema),
});

export const SetOrgLimitsBodySchema = z.object({
  limits: z.array(
    z.object({
      window_hours: z.number().positive(),
      limit_usd: z.number().positive(),
      label: z.string().optional(),
    }),
  ),
});

function isApproximatelyInteger(value: number): boolean {
  const rounded = Math.round(value);
  const tolerance = Math.max(1e-6, Math.abs(value) * Number.EPSILON * 2);
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded) <= tolerance;
}

const SixDecimalUsdSchema = z.number().finite().nonnegative().refine(
  (value) => isApproximatelyInteger(value * 1_000_000),
  "must have at most six decimal places",
);

export const UserLlmLimitInputSchema = z.object({
  window_hours: z.number().finite().min(1 / 60).max(5 * 365 * 24).refine(
    (value) => {
      const rawMilliseconds = value * 60 * 60 * 1000;
      return isApproximatelyInteger(rawMilliseconds);
    },
    "must resolve to a whole number of milliseconds",
  ),
  limit_usd: SixDecimalUsdSchema.max(1_000_000_000),
  label: z.string().trim().max(200).nullable().optional(),
});

export const SetUserLlmLimitsBodySchema = z.object({
  limits: z.array(UserLlmLimitInputSchema).max(10).superRefine((limits, ctx) => {
    const seen = new Set<number>();
    limits.forEach((limit, index) => {
      const windowMs = Math.round(limit.window_hours * 60 * 60 * 1000);
      if (seen.has(windowMs)) {
        ctx.addIssue({ code: "custom", message: "duplicate window_hours", path: [index, "window_hours"] });
      }
      seen.add(windowMs);
    });
  }),
});

export const UserLlmLimitStatusSchema = UserLlmLimitInputSchema.extend({
  label: z.string().nullable(),
  spent_usd: z.number(),
  remaining_usd: z.number(),
  unpriced_requests: z.number().int(),
  exceeded: z.boolean(),
  retry_at_ms: z.number().int().nullable(),
});

const UserLlmAccessStatusSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(["no_limits", "within_limits", "limit_exceeded", "pricing_unavailable"]),
  evaluated_at_ms: z.number().int().optional(),
  blocking_limit: UserLlmLimitStatusSchema.nullable().optional(),
  limits: z.array(UserLlmLimitStatusSchema),
});

export const UserLlmLimitsResponseSchema = z.object({
  org_id: z.string(),
  user_id: z.string(),
  limits: z.array(UserLlmLimitInputSchema.extend({ label: z.string().nullable() })),
  status: UserLlmAccessStatusSchema,
});

export const LlmPricingInputSchema = z.object({
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  input_usd_per_million: SixDecimalUsdSchema.max(1_000_000),
  output_usd_per_million: SixDecimalUsdSchema.max(1_000_000),
  cache_creation_usd_per_million: SixDecimalUsdSchema.max(1_000_000).optional().default(0),
  cache_read_usd_per_million: SixDecimalUsdSchema.max(1_000_000).optional().default(0),
});

export const SetLlmPricingBodySchema = z.object({
  prices: z.array(LlmPricingInputSchema).max(500).superRefine((prices, ctx) => {
    const seen = new Set<string>();
    prices.forEach((price, index) => {
      const key = `${price.provider.trim()}\0${price.model.trim()}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: "duplicate provider/model", path: [index] });
      }
      seen.add(key);
    });
  }),
});

export const LlmPricingResponseSchema = z.object({
  org_id: z.string(),
  prices: z.array(LlmPricingInputSchema),
  unpriced_models: z.array(z.object({
    provider: z.string(),
    model: z.string(),
    last_seen_at_ms: z.number().int(),
  })),
});

const UserLlmTotalsSchema = z.object({
  requests: z.number().int(),
  spend_usd: z.number(),
  unpriced_requests: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int(),
  cache_read_input_tokens: z.number().int(),
});

export const UserLlmUsageReportSchema = z.object({
  org_id: z.string(),
  from_ms: z.number().int(),
  to_ms: z.number().int(),
  evaluated_at_ms: z.number().int(),
  users: z.array(z.object({
    user_id: z.string().nullable(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    membership_status: z.enum(["current", "former", "unattributed"]),
    totals: UserLlmTotalsSchema,
    models: z.array(UserLlmTotalsSchema.extend({ provider: z.string(), model: z.string() })),
    limit_status: UserLlmAccessStatusSchema.omit({ evaluated_at_ms: true }),
  })),
  count: z.number().int(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const UsageLogEntrySchema = z.object({
  id: z.number().int(),
  workspace_id: z.string(),
  user_id: z.string(),
  thread_id: z.string(),
  model: z.string(),
  provider: z.string(),
  billing_source: z.string().optional(),
  credit_chargeable: z.number().int().optional(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cache_creation_input_tokens: z.number().int(),
  cache_read_input_tokens: z.number().int(),
  cost_usd: z.number(),
  metered_cost_usd: z.number().nullable(),
  cost_source: z.enum(["provider_reported", "org_override", "builtin_pricing", "legacy_estimate", "unpriced"]),
  usage_kind: z.enum(["llm", "image", "audio", "capability", "unknown"]),
  usage_surface: z.enum(["agent", "subagent", "compaction", "virtual_ai", "auxiliary", "capability", "unknown"]),
  duration_ms: z.number().int(),
  created_at_ms: z.number().int(),
  source: z.string().optional(),
  source_id: z.string().optional(),
});

export const OrgUsageLogSchema = z.object({
  org_id: z.string(),
  entries: z.array(UsageLogEntrySchema),
  count: z.number().int(),
  has_more: z.boolean().optional(),
  next_cursor: z.string().nullable().optional(),
});

export const OrgUsageLogSumSchema = z.object({
  org_id: z.string(),
  total_cost_usd: z.number(),
  metered_cost_usd: z.number().optional(),
  unpriced_requests: z.number().int().optional(),
  total_requests: z.number().int(),
  total_input_tokens: z.number().int(),
  total_output_tokens: z.number().int(),
  total_cache_creation_input_tokens: z.number().int(),
  total_cache_read_input_tokens: z.number().int(),
  from_ms: z.number().int(),
  to_ms: z.number().int(),
});

// ---------------------------------------------------------------------------
// Wrapped list response helpers
// ---------------------------------------------------------------------------

/** Paginated list response: { items, total, offset, limit } */
export function paginatedList<T extends z.ZodType>(schema: T) {
  return z.object({
    items: z.array(schema),
    total: z.number().int(),
    offset: z.number().int(),
    limit: z.number().int(),
  });
}

/** Simple list wrapper for non-paginated endpoints (KV, R2) */
export function dataList<T extends z.ZodType>(schema: T) {
  return z.object({ data: z.array(schema) });
}

// ---------------------------------------------------------------------------
// Email domain blocklist schemas
// ---------------------------------------------------------------------------

export const EmailDomainBlocklistSchema = z.object({
  domains: z.array(z.string()),
});

export const AddEmailDomainBodySchema = z.object({
  domain: z.string().min(1),
});
