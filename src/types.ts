import type { RuntimeCallArtifact, RuntimeArtifactPreviewTarget } from "@/lib/runtime-artifacts";
import type { MentionableProject } from "@/lib/mentions";
import type { ThreadSearchMatch } from "@/lib/thread-search";

export interface Thread {
  id: string;
  workspace_id: string;
  title: string;
  created_by: string;
  model: LlmModel;
  created_at: number;
  updated_at: number;
  user_message_count: number;
  first_user_message?: string | null;
  last_user_message?: string | null;
  last_user_message_at?: number | null;
  last_assistant_completed_at?: number | null;
  last_assistant_summary?: string | null;
  last_assistant_summary_status?: ThreadCompletionSummaryStatus | null;
  source?: string | null;
  channel_kind?: string | null;
  channel_kinds?: string[] | null;
  channel_connection_id?: string | null;
  channel_conversation_id?: string | null;
  channel_message_id?: string | null;
  search_match?: ThreadSearchMatch | null;
  creator?: User;
}

export type ChatGroupAvatarStatus = "pending" | "generated" | "user" | "default";

export interface ChatGroupAvatar extends Avatar {
  status?: ChatGroupAvatarStatus;
}

export interface ChatGroup {
  id: string;
  org_id: string;
  workspace_id: string;
  name: string;
  avatar: ChatGroupAvatar;
  pinned_at: number | null;
  last_active_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChatGroupSummary extends ChatGroup {
  open_thread_ids: string[];
  closed_thread_ids: string[];
}

export type ThreadStatus = "idle" | "running" | "unread";
export type ThreadCompletionSummaryStatus = "pending" | "ready" | "failed";

export interface ChatGroupThreadSummary {
  id: string;
  title: string;
  model: LlmModel;
  updated_at: number;
  channel_kind?: string | null;
  channel_kinds?: string[] | null;
  is_unread?: boolean;
  status: ThreadStatus;
  membership: "open" | "closed";
  last_active_at: number;
  first_user_message: string | null;
  latest_user_message: string | null;
  latest_user_message_at: number | null;
  /** Canonical user-send timestamp; never synthesized from thread.updated_at. */
  last_user_message_at?: number | null;
  running_activity_text: string | null;
  running_activity_at: number | null;
  last_assistant_completed_at: number | null;
  last_assistant_summary: string | null;
  last_assistant_summary_status: ThreadCompletionSummaryStatus | null;
  running_started_at: number | null;
  /** Upload mount paths seen in first/latest user messages (pre-truncation); attachment-loading hint. */
  upload_ref_paths?: string[];
}

export interface ChatGroupView extends ChatGroupSummary {
  status: ThreadStatus;
  member_count: number;
  open_threads: ChatGroupThreadSummary[];
  closed_threads: ChatGroupThreadSummary[];
}

export interface GroupNewChatTranscriptCard {
  threadId: string;
  title: string;
  openingLine: string;
  status: ThreadStatus;
  lastActiveAt: number;
  lastAssistantCompletedAt: number;
}

export interface GroupNewChatAttachmentCard {
  path: string;
  filename: string;
  originalName: string;
  sourceThreadId: string;
  sourceTitle: string;
  lastUsedAt: number;
  contentType?: string;
  size?: number;
}

export interface GroupNewChatRecentItems {
  recentlyUsed: {
    projectIds: string[];
    connectionIds: string[];
  };
  attachmentCards: GroupNewChatAttachmentCard[];
}

export interface GroupNewChatPayload {
  id: string;
  name: string;
  avatar: ChatGroupAvatar | null;
  transcriptCards: GroupNewChatTranscriptCard[];
  recentlyUsed: GroupNewChatRecentItems["recentlyUsed"];
  attachmentCards: GroupNewChatAttachmentCard[];
  recentItems?: GroupNewChatRecentItems | Promise<GroupNewChatRecentItems>;
  /** Expected attachment-card count while recentItems is still streaming. */
  pendingAttachmentCount?: number;
}

export interface CondensedTranscriptTurn {
  user: string;
  assistantFinal: string;
  omittedCount: number;
}

export interface CondensedTranscript {
  threadId: string;
  title: string;
  turns: CondensedTranscriptTurn[];
}

export interface ThreadCreator {
  userId: string;
  name: string | null;
  email: string;
  avatar: Avatar | null;
  threadCount: number;
  latestUpdatedAt: number;
}

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
  | RuntimeArtifactPreviewTarget;

export interface PreviewTab {
  /** Unique ID for this tab (used as React key). */
  id: string;
  /** The preview target this tab displays. */
  target: PreviewTarget;
}

// Content block types for structured message content
export interface TextBlock {
  type: "text";
  text: string;
  itemId?: string;
  itemKind?: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  itemKind?: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  /** True when the backing tool execution failed. */
  is_error?: boolean;
  /** Human-readable execution outcome for exported/audited transcripts. */
  status?: "succeeded" | "failed";
  /** Marks a Task progress update (not the final Task result). */
  isTaskUpdate?: boolean;
  itemId?: string;
  itemKind?: string;
  artifacts?: RuntimeCallArtifact[];
  /** Structured tool metadata such as an edit diff or unified patch. */
  details?: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
  itemId?: string;
  itemKind?: string;
  label?: string;
  summaries?: string[];
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
}

export interface TeammateMessageBlock {
  type: "teammate_message";
  teammateId: string;
  content: string;
}

export interface TaskNotificationBlock {
  type: "task_notification";
  taskId: string;
  outputFile: string;
  status: string;
  summary: string;
}

export interface ErrorBlock {
  type: "error";
  error: string;
  title?: string;
  billingSource?: "byok" | "hosted";
  provider?: LlmProvider;
  status?: number;
  errorType?: string;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | TeammateMessageBlock
  | TaskNotificationBlock
  | ErrorBlock;

export interface Message {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string | ContentBlock[];
  created_at: number;
  /** Presentation snapshot from UI-message metadata; never an authorization source. */
  authorDisplayName?: string;
  /** Presentation-only channel source from UI-message metadata, separate from authorship. */
  messageSource?: string;
  /** Client-generated delivery id used to recover sends across reconnects. */
  clientMessageId?: string;
  /** Stable runtime/session entry id used for fork operations. */
  forkEntryId?: string;
  /**
   * Model-reported duration of the turn this assistant message completed (ms),
   * surfaced from `message-metadata.pi.turnDurationMs`. Drives the turn duration
   * badge without a separate Agent-state channel.
   */
  turnDurationMs?: number;
  /** Wall-clock completion time of the turn (ms since epoch). */
  completedAtMs?: number;
  isStreaming?: boolean;
  /** True if this user message was sent while assistant was streaming */
  sentDuringStreaming?: boolean;
  /** @internal Block offset for streaming, cleared when done */
  _blockOffset?: number;
  /** Indicates this is a meta message (e.g., skill sheet), not a real user message */
  isMeta?: boolean;
  /** Links meta message to the originating tool_use block */
  sourceToolUseID?: string;
  /** True when this message is a compaction summary (system-generated context recap) */
  isCompactSummary?: boolean;
}

// Auth types
// TODO: Viewer role (deferred): Members with viewer access can view any apps that are
// private to the workspace, including apps that are not published publicly. This is
// designed for enterprise use cases where a company wants to share internal apps within
// the org without making them public. Viewers can view apps but cannot: create apps,
// use chat, manage team settings, or perform any write operations. They are read-only
// consumers of workspace output.
export type OrgRole = "owner" | "admin" | "member" | "viewer";
export type WorkspaceAccessLevel = "full" | "none";
export type BillingStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "enterprise"
  | "past_due"
  | "canceled";
export type BillingPlan =
  | "free"
  | "payg"
  | "starter"
  | "pro"
  | "team"
  | "enterprise";

export interface Avatar {
  color: string;
  content: string;
}

export interface User {
  id: string;
  email: string;
  email_verified_at: number | null;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  avatar: Avatar;
  is_orphaned: boolean;
  orphaned_at: number | null;
}

export interface Session {
  id: string;
  user_id: string;
  org_id: string;
  workspace_id: string | null;
  created_at: number;
  expires_at: number;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_at: number;
  created_by: string;
  billing_status: BillingStatus;
  billing_plan?: BillingPlan;
  billing_seat_count?: number;
  billing_customer_id: string | null;
  billing_subscription_id: string | null;
  billing_subscription_status: string | null;
  billing_trial_started_at: number | null;
  billing_trial_ends_at: number | null;
  billing_credit_purchase_total_cents: number;
  billing_credit_grant_total_cents: number;
  billing_trial_credit_grant_cents: number;
  billing_trial_credit_granted_at: number | null;
  billing_free_credit_grant_cents?: number;
  billing_free_credit_granted_at?: number | null;
  billing_last_included_credit_invoice_id: string | null;
  billing_credit_usage_started_at: number | null;
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
}

export interface OrgMembership {
  org_id: string;
  org_name: string;
  role: OrgRole;
  joined_at: number;
  last_workspace_id?: string | null;
}

export interface Invitation {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: OrgRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
}

export interface Workspace {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  avatar: Avatar;
  archived: boolean;
  archived_at: number | null;
  archived_by: string | null;
  compute_tier: "standard";
  email_handle: string | null;
}

export interface WorkspaceWithAccess extends Workspace {
  access_level: WorkspaceAccessLevel;
}

export interface WorkspaceMember {
  user_id: string;
  access_level: WorkspaceAccessLevel;
  granted_by: string;
  granted_at: number;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  actor_id: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: number;
}

export interface OnboardingPreferences {
  completed_at: number | null;
}

// Auth context types for frontend
export interface AuthState {
  user: User | null;
  currentOrg: Organization | null;
  currentWorkspace?: WorkspaceWithAccess | null;
  orgs: OrgMembership[];
  onboarding?: OnboardingPreferences | null;
  /** Workspaces in the current org only (for settings/management) */
  workspaces?: WorkspaceWithAccess[];
  /** All workspaces across all orgs (for workspace switcher) */
  allWorkspaces?: WorkspaceWithAccess[];
  /** Total workspaces in org (includes ones user may not have access to) */
  orgWorkspaceCount?: number;
  loading: boolean;
  error: string | null;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  org_count: number;
  avatar: Avatar;
  is_orphaned: boolean;
  signup_ip: string | null;
}

export interface AdminOverview {
  users: AdminUserSummary[];
  total_users: number;
  total_orgs: number;
  total_memberships: number;
  total_workspaces: number;
  total_integrations: number;
  orphaned_users: number;
}

export interface AdminWorkspaceSummary extends Workspace {
  org_id: string;
  org_name: string;
  thread_count: number;
  integration_count: number;
}

export interface AdminWorkspaceDetail {
  workspace: Workspace;
  org: Organization;
  threads: Thread[];
  integrations: Integration[];
  members: WorkspaceMember[];
}

export interface AdminThreadWithContext extends Thread {
  org_id: string;
  org_name: string;
  workspace_id: string;
  workspace_name: string;
}

export interface AdminAppSummary {
  script_name: string;
  workspace_id: string;
  workspace_name: string;
  project_id: string | null;
  org_id: string;
  org_name: string;
  org_slug: string | null;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_status: AppPreviewStatus | null;
  preview_error: string | null;
}

export type AdminAppDetail = AdminAppSummary;

export interface AdminInvitation {
  id: string;
  email: string;
  role: OrgRole;
  org_id: string;
  org_name: string;
  invited_by: string;
  inviter_email: string;
  inviter_name: string | null;
  created_at: number;
  expires_at: number;
}

// Paginated result types for admin lists
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PaginationParams {
  offset?: number;
  limit?: number;
  search?: string;
  searchQuery?: string;
  createdBy?: string;
}

// Integration types
export type IntegrationCategory =
  | "databases"
  | "saas"
  | "ai_services"
  | "cloud_providers"
  | "communication";

export type IntegrationAuthMethod = "oauth2" | "api_key";

export interface Integration {
  id: string;
  integration_type: string;
  name: string;
  category: IntegrationCategory;
  auth_method: IntegrationAuthMethod;
  config: Record<string, unknown>;
  created_by: string;
  created_at: number;
  updated_at: number;
  has_credentials: boolean;
}

export type AtMentionConnection = Integration & { kind: "connection" };
export type AtMentionEntity = AtMentionConnection | MentionableProject;

// API Token types
export interface CreateApiTokenInput {
  name: string;
  integration_id?: string; // scope to specific integration
  scopes?: string[]; // defaults to ['proxy']
  expires_in_days?: number; // null = never expires
}

// Worker/App types
export type AppPreviewStatus = "pending" | "ready" | "failed";

export interface WorkerScript {
  script_name: string;
  workspace_id: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_key: string | null;
  preview_updated_at: number | null;
  preview_status: AppPreviewStatus | null;
  preview_error: string | null;
  config_path: string | null;
  project_id: string | null;
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
}

export interface AppCreator {
  id: string;
  name: string | null;
  email: string | null;
  avatar: Avatar | null;
}

export interface WorkerScriptWithCreator extends WorkerScript {
  creator?: AppCreator;
}

// LLM Provider BYOK types
export type LlmProvider = "anthropic" | "bedrock" | "custom" | "openai" | "openrouter";
export type LlmModel =
  | "haiku"
  | "sonnet"
  | "fable-5"
  | "opus-5"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gpt-5.6-sol-bedrock"
  | "gpt-5.6-terra-bedrock"
  | "custom"
  | "kimi-k2.7-code"
  | "grok-4.5"
  | "glm-5.3"
  | "gemini-3.5-flash"
  | "gemini-3-flash-preview"
  | "deepseek-v4-pro"
  | "deepseek-v4-auto"
  | "deepseek-v4-flash";

export interface ModelPickerModelConfig {
  id: LlmModel;
  added_at: number;
}

export interface OrgModelPickerConfig {
  models: ModelPickerModelConfig[];
  default_model: LlmModel | null;
  use_platform_defaults?: boolean;
}

export interface WorkspaceModelPickerConfig extends OrgModelPickerConfig {
  use_org_defaults: boolean;
}

export interface LlmProviderConfigPublic {
  provider: LlmProvider;
  config: {
    aws_region?: string; // Bedrock only
    custom_name?: string;
    custom_base_url?: string;
    custom_auth_type?: "bearer" | "x-api-key";
    custom_api?: "openai-completions" | "openai-responses" | "anthropic-messages";
    custom_model_id?: string;
  };
  key_hint: string; // First 8 chars of the key
  created_by: string;
  created_at: number;
  updated_at: number;
}
