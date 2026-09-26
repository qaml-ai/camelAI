// Shared admin index DTOs and filter types for the D1-backed app index.

export interface UserFilters {
  is_superuser?: boolean;
  is_orphaned?: boolean;
  sort_by?: 'created_at' | 'email' | 'name';
  sort_dir?: 'asc' | 'desc';
}

export interface ThreadFilters {
  org_id?: string;
  workspace_id?: string;
  created_by?: string;
  sort_by?: 'created_at' | 'updated_at';
  sort_dir?: 'asc' | 'desc';
}

export interface ChatExplorerFilters {
  plan?: 'payg' | 'starter' | 'pro' | 'team' | 'enterprise';
  first_chats_only?: boolean;
  automated_only?: boolean;
  exclude_internal?: boolean;
  errors_only?: boolean;
  sort_by?: 'updated_at' | 'created_at';
}

export interface OrgFilters {
  archived?: boolean;
  sort_by?: 'created_at' | 'name';
  sort_dir?: 'asc' | 'desc';
}

export interface OrgDirectoryFilters extends OrgFilters {
  exclude_org_ids?: string[];
  exclude_creator_domains?: string[];
  has_llm_provider?: boolean;
  llm_provider?: string;
}

export interface AdminOrgDirectoryRow {
  id: string;
  name: string;
  slug: string | null;
  created_at: number;
  archived: boolean;
  billing_status: string | null;
  created_by: string;
  member_count: number;
  workspace_count: number;
  creator_email: string | null;
  creator_name: string | null;
}

export interface AdminUserSummaryRow {
  id: string;
  email: string;
  name: string | null;
  avatar: {
    color: string;
    content: string;
  };
  created_at: number;
  org_count: number;
  is_superuser: boolean;
  is_orphaned: boolean;
  signup_ip: string | null;
}

export interface AdminThreadListRow {
  id: string;
  title: string | null;
  model: string | null;
  workspace_id: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  org_id: string;
  org_name: string | null;
  workspace_name: string | null;
}

export interface AdminChatExplorerRow {
  id: string;
  title: string | null;
  model: string | null;
  org_id: string;
  workspace_id: string;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  user_message_count: number | null;
  user_message_count_source?: 'admin_index' | 'org_thread' | 'pi_core_fallback' | 'unknown';
  user_message_count_capped?: boolean;
  first_user_message: string | null;
  last_user_message_at: number | null;
  source: string | null;
  channel_kind: string | null;
  channel_kinds: string | null;
  chat_error_count: number;
  last_chat_error_at: number | null;
  last_chat_error_message: string | null;
  last_chat_error_source: string | null;
  last_chat_error_status: number | null;
  last_chat_error_provider: string | null;
  last_chat_error_model: string | null;
  model_history: string | null;
  last_model_changed_at: number | null;
  org_name: string | null;
  org_billing_plan: string | null;
  org_billing_status: string | null;
  org_plan: string;
  workspace_name: string | null;
  user_email: string | null;
  user_name: string | null;
  is_first_thread: boolean;
}

export interface AdminChatErrorGroupRow {
  fingerprint: string;
  message_sample: string;
  source: string;
  error_kind: string | null;
  provider: string | null;
  model: string | null;
  status: number | null;
  count: number;
  affected_thread_count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export interface AdminChatErrorThreadRow {
  thread_id: string;
  title: string | null;
  org_id: string;
  org_name: string | null;
  workspace_id: string;
  workspace_name: string | null;
  user_id: string | null;
  user_email: string | null;
  last_seen_at: number;
  count: number;
}

export interface AdminChatErrorSummary {
  total_events: number;
  affected_threads: number;
  distinct_groups: number;
  latest_error_at: number | null;
}

export interface AdminChatErrorFilters {
  fingerprint?: string;
  org_id?: string;
  workspace_id?: string;
  thread_id?: string;
  user_id?: string;
  source?: string;
  error_kind?: string;
  provider?: string;
  model?: string;
  status?: number;
  search?: string;
}

export type AdminChatErrorGroupSortBy = 'count' | 'affected_threads' | 'last_seen' | 'first_seen';

export interface AdminChatErrorQueryOptions {
  startAt: number;
  endAt: number;
  filters?: AdminChatErrorFilters;
  fingerprint?: string | null;
  limit?: number;
  offset?: number;
  sort_by?: AdminChatErrorGroupSortBy;
  sort_dir?: 'asc' | 'desc';
}

export interface AdminChatErrorBreakdownRow {
  value: string | number | null;
  count: number;
  affected_thread_count: number;
  latest_error_at: number | null;
}

export interface AdminChatErrorBreakdowns {
  source: AdminChatErrorBreakdownRow[];
  error_kind: AdminChatErrorBreakdownRow[];
  status: AdminChatErrorBreakdownRow[];
  provider: AdminChatErrorBreakdownRow[];
  model: AdminChatErrorBreakdownRow[];
}

export interface AdminChatErrorEventRow {
  id: string;
  fingerprint: string;
  thread_id: string;
  title: string | null;
  org_id: string;
  org_name: string | null;
  workspace_id: string;
  workspace_name: string | null;
  user_id: string | null;
  user_email: string | null;
  created_at: number;
  source: string;
  error_kind: string | null;
  status: number | null;
  provider: string | null;
  model: string | null;
  message_sample: string;
  message_normalized: string;
}

export interface AdminAppListRow {
  app_id: string;
  script_name: string;
  org_id: string;
  workspace_id: string;
  project_id: string | null;
  org_name: string | null;
  org_slug: string | null;
  workspace_name: string | null;
  created_by: string;
  created_by_name: string | null;
  created_by_email: string | null;
  created_at: number;
  updated_at: number;
  is_public: boolean;
  preview_status: string | null;
  preview_error: string | null;
}

export interface WorkspaceFilters {
  org_id?: string;
  archived?: boolean;
  sort_by?: 'created_at' | 'name';
  sort_dir?: 'asc' | 'desc';
}

export interface AppFilters {
  org_id?: string;
  workspace_id?: string;
  is_public?: boolean;
  sort_by?: 'created_at' | 'updated_at';
  sort_dir?: 'asc' | 'desc';
}

export type AdminEventType =
  | { type: 'user_upsert'; payload: any }
  | { type: 'user_delete'; payload: { id: string } }
  | { type: 'org_upsert'; payload: any }
  | { type: 'org_llm_provider_update'; payload: { org_id: string; provider: string | null; updated_at: number | null } }
  | { type: 'workspace_upsert'; payload: any }
  | { type: 'thread_upsert'; payload: any }
  | { type: 'thread_error_recorded'; payload: any }
  | { type: 'app_upsert'; payload: any }
  | { type: 'invitation_upsert'; payload: any }
  | { type: 'thread_delete'; payload: { id: string; workspace_id?: string | null } }
  | { type: 'app_delete'; payload: { script_name: string; org_id?: string | null } }
  | { type: 'invitation_delete'; payload: { id: string } }
  | { type: 'workspace_delete'; payload: { id: string } }
  | { type: 'org_member_delta'; payload: { org_id: string; delta: number } }
  | { type: 'user_org_delta'; payload: { user_id: string; delta: number } }
  | {
      type: 'org_membership_upsert';
      payload: { org_id: string; user_id: string; role: string; joined_at: number };
    }
  | { type: 'org_membership_delete'; payload: { org_id: string; user_id: string } };
