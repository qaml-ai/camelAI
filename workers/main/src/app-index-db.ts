import type {
  AdminAppListRow,
  AdminChatErrorBreakdownRow,
  AdminChatErrorBreakdowns,
  AdminChatErrorEventRow,
  AdminChatErrorFilters,
  AdminChatErrorGroupRow,
  AdminChatErrorQueryOptions,
  AdminChatErrorSummary,
  AdminChatErrorThreadRow,
  AdminChatExplorerRow,
  AdminThreadListRow,
  AdminUserSummaryRow,
  AppFilters,
  ChatExplorerFilters,
  OrgDirectoryFilters,
  OrgFilters,
  ThreadFilters,
  UserFilters,
  VersionedAdminEvent,
  WorkspaceFilters,
} from './admin-index-types.js';
import {
  buildChatErrorEventPayload,
  normalizeChatErrorMessage,
  parseModelHistory,
  truncateChatMetadata,
} from './chat-error-metadata.js';
import {
  computeDashboardSummary as computeDashboardSummaryFromSnapshot,
  computeRetentionData as computeRetentionDataFromSnapshot,
  filterDashboardEntitySnapshot,
  type DashboardEntitySnapshot,
  type DashboardMetricsFilterOptions,
  type DashboardRetentionOptions,
  type DashboardRetentionResponse,
  type DashboardSummaryOptions,
  type DashboardSummaryResponse,
  type DashboardWorkspaceMetricsRow,
} from './admin-dashboard-metrics.js';
import { truncateThreadPreviewText } from '../../../src/lib/thread-preview';
import { recordErrorEvent, type ObservabilityEnv } from './observability.js';

type AppIndexEnv = { APP_DB?: D1Database } & ObservabilityEnv;

/** An ensureSchema statement that failed: the statement itself, and D1's error. */
export class AppIndexSchemaError extends Error {
  constructor(readonly statement: string, readonly cause: unknown) {
    super(`D1 app index schema statement failed: ${statement.replace(/\s+/g, ' ').slice(0, 300)}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'AppIndexSchemaError';
  }
}

type D1Binding = D1Database | D1DatabaseSession;

async function first<T = Record<string, unknown>>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

function toNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function toBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

function normalizeSignupIp(ip: string): string | null {
  const normalized = ip.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSqlStringList(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

function applyOrgDirectoryFilters(
  conditions: string[],
  params: unknown[],
  filters: OrgDirectoryFilters | undefined,
): void {
  if (filters?.archived !== undefined) {
    conditions.push('o.archived = ?');
    params.push(filters.archived ? 1 : 0);
  }
  if (filters?.has_llm_provider === true) conditions.push('o.llm_provider IS NOT NULL');
  if (filters?.has_llm_provider === false) conditions.push('o.llm_provider IS NULL');
  if (filters?.llm_provider) {
    conditions.push('o.llm_provider = ?');
    params.push(filters.llm_provider);
  }
  const excludedOrgIds = normalizeSqlStringList(filters?.exclude_org_ids);
  if (excludedOrgIds.length > 0) {
    conditions.push(`
      NOT EXISTS (
        SELECT 1
        FROM json_each(?) excluded_org_ids
        WHERE excluded_org_ids.value = o.id
      )
    `);
    params.push(JSON.stringify(excludedOrgIds));
  }
  const excludedDomains = normalizeSqlStringList(filters?.exclude_creator_domains).map((domain) => domain.toLowerCase());
  if (excludedDomains.length > 0) {
    conditions.push(`
      (
        u.email IS NULL
        OR INSTR(u.email, '@') <= 0
        OR NOT EXISTS (
          SELECT 1
          FROM json_each(?) excluded_creator_domains
          WHERE excluded_creator_domains.value = LOWER(SUBSTR(u.email, INSTR(u.email, '@') + 1))
        )
      )
    `);
    params.push(JSON.stringify(excludedDomains));
  }
}

function normalizeOrgDirectoryRow(row: any) {
  return {
    ...row,
    archived: toBoolean(row.archived),
    slug: row.slug ?? null,
    billing_status: row.billing_status ?? null,
    creator_email: row.creator_email ?? null,
    creator_name: row.creator_name ?? null,
  };
}

function normalizeWorkspaceRow(row: any) {
  return {
    ...row,
    description: row.description ?? null,
    avatar: {
      color: row.avatar_color || '#666',
      content: row.avatar_content || 'W',
    },
    archived: toBoolean(row.archived),
    archived_at: row.archived_at ?? null,
    archived_by: row.archived_by ?? null,
    compute_tier: row.compute_tier ?? 'standard',
  };
}

const USER_SORT_COLS: Record<string, string> = { created_at: 'created_at', email: 'email', name: 'name' };
const THREAD_SORT_COLS: Record<string, string> = { created_at: 't.created_at', updated_at: 't.updated_at' };
const ORG_SORT_COLS: Record<string, string> = { created_at: 'created_at', name: 'name' };
const ORG_DIRECTORY_SORT_COLS: Record<string, string> = { created_at: 'o.created_at', name: 'o.name' };
const WORKSPACE_SORT_COLS: Record<string, string> = { created_at: 'w.created_at', name: 'w.name' };
const APP_SORT_COLS: Record<string, string> = { created_at: 'a.created_at', updated_at: 'a.updated_at' };
const CHAT_EXPLORER_SORT_COLS: Record<NonNullable<ChatExplorerFilters['sort_by']>, string> = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
};
const CHAT_ERROR_GROUP_SORT_COLS: Record<NonNullable<AdminChatErrorQueryOptions['sort_by']>, string> = {
  count: 'count',
  affected_threads: 'affected_thread_count',
  last_seen: 'last_seen_at',
  first_seen: 'first_seen_at',
};
const THREADS_INDEX_VERSION_KEY = 'threads_index_version';
const THREADS_INDEX_VERSION = '3';
const THREADS_INDEX_BACKFILL_REQUIRED_KEY = 'threads_index_backfill_required';
const CHAT_EXPLORER_ORG_PLAN_SQL = `
  CASE
    WHEN o.billing_status = 'enterprise' OR o.billing_plan = 'enterprise' THEN 'enterprise'
    WHEN o.billing_plan = 'free' THEN 'payg'
    WHEN o.billing_plan IN ('payg','starter','pro','team') THEN o.billing_plan
    WHEN o.billing_status IN ('trialing','active','past_due') THEN 'starter'
    ELSE 'payg'
  END
`;
const CHAT_EXPLORER_FIRST_THREAD_SQL = `
  (u.id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM threads t2
    WHERE t2.created_by = t.created_by
      AND (
        t2.created_at < t.created_at
        OR (t2.created_at = t.created_at AND t2.id < t.id)
      )
  ))
`;
const CHAT_EXPLORER_AUTOMATED_THREAD_SQL = `
  (
    t.source = 'scheduled'
    OR t.created_by = 'system'
    OR t.title LIKE 'Scheduled: %'
  )
`;
const CHAT_EXPLORER_FIRST_USER_MESSAGE_PREVIEW_LENGTH = 300;

function normalizeChannelKindsForIndex(value: unknown): string | null {
  if (Array.isArray(value)) return JSON.stringify(value);
  return typeof value === 'string' ? value : null;
}

function normalizeChatErrorFilters(
  options: Pick<AdminChatErrorQueryOptions, 'filters' | 'fingerprint'>,
): AdminChatErrorFilters | undefined {
  const filters: AdminChatErrorFilters = {};
  const source = options.filters ?? {};
  const copyString = (key: keyof Omit<AdminChatErrorFilters, 'status'>) => {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      filters[key] = value.trim();
    }
  };

  copyString('fingerprint');
  copyString('org_id');
  copyString('workspace_id');
  copyString('thread_id');
  copyString('user_id');
  copyString('source');
  copyString('error_kind');
  copyString('provider');
  copyString('model');
  copyString('search');

  const fingerprint = typeof options.fingerprint === 'string' ? options.fingerprint.trim() : '';
  if (fingerprint) filters.fingerprint = fingerprint;

  if (typeof source.status === 'number' && Number.isFinite(source.status)) {
    filters.status = Math.trunc(source.status);
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

type ChatErrorSqlFilterOptions = {
  alias?: string;
  startAt: number;
  endAt: number;
  filters?: AdminChatErrorFilters;
};

function buildChatErrorWhere(options: ChatErrorSqlFilterOptions): {
  whereSql: string;
  params: unknown[];
} {
  const prefix = options.alias ? `${options.alias}.` : '';
  const conditions = [`${prefix}created_at >= ?`, `${prefix}created_at < ?`];
  const params: unknown[] = [
    Math.max(0, Math.floor(options.startAt)),
    Math.max(0, Math.floor(options.endAt)),
  ];
  const filters = normalizeChatErrorFilters({ filters: options.filters });
  const columns: Record<Exclude<keyof AdminChatErrorFilters, 'search'>, string> = {
    fingerprint: 'fingerprint',
    org_id: 'org_id',
    workspace_id: 'workspace_id',
    thread_id: 'thread_id',
    user_id: 'user_id',
    source: 'source',
    error_kind: 'error_kind',
    provider: 'provider',
    model: 'model',
    status: 'status',
  };

  for (const [key, column] of Object.entries(columns) as Array<[keyof typeof columns, string]>) {
    const value = filters?.[key];
    if (value === undefined) continue;
    conditions.push(`${prefix}${column} = ?`);
    params.push(value);
  }

  if (filters?.search) {
    const like = `%${escapeSqlLike(filters.search)}%`;
    conditions.push(`(${prefix}message_normalized LIKE ? ESCAPE '\\' OR ${prefix}message_sample LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }

  return {
    whereSql: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

function normalizeModelHistoryForIndex(value: unknown, fallbackModel: unknown): string | null {
  const models = parseModelHistory(value, fallbackModel);
  return models.length > 0 ? JSON.stringify(models) : null;
}

function mergeModelHistoryForIndex(
  existingValue: unknown,
  incomingValue: unknown,
  fallbackModel: unknown,
): string | null {
  const merged: string[] = [];
  const add = (model: string) => {
    if (!merged.includes(model) && merged.length < 12) merged.push(model);
  };
  for (const model of parseModelHistory(existingValue)) add(model);
  for (const model of parseModelHistory(incomingValue, fallbackModel)) add(model);
  return merged.length > 0 ? JSON.stringify(merged) : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return null;
}

function normalizeNonNegativeInteger(value: unknown): number {
  const number = normalizeNullableNumber(value);
  return number !== null && number > 0 ? number : 0;
}

function hasOwnField(value: unknown, field: string): boolean {
  return Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, field));
}

type ExistingThreadMetadata = {
  chat_error_count: number | null;
  last_chat_error_at: number | null;
  last_chat_error_message: string | null;
  last_chat_error_source: string | null;
  last_chat_error_status: number | null;
  last_chat_error_provider: string | null;
  last_chat_error_model: string | null;
  model_history: string | null;
  last_model_changed_at: number | null;
};

function normalizeInternalDomainList(
  rawValue: string | undefined,
  defaultDomains: string[] = [],
): string[] {
  const source = rawValue && rawValue.trim().length > 0 ? rawValue : defaultDomains.join(',');
  return Array.from(
    new Set(
      source
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .map((domain) => domain.replace(/^@+/, '').replace(/\.+$/, ''))
        .filter((domain) => domain.length > 0),
    ),
  );
}

/** Mirrored entity kinds, as recorded in `mirror_rows.entity`. */
export type MirrorEntity =
  | 'user'
  | 'org'
  | 'workspace'
  | 'thread'
  | 'app'
  | 'invitation'
  | 'org_membership'
  | 'workspace_member';

const MIRROR_FANOUT_COLUMN_STATEMENTS = [
  'ALTER TABLE users ADD COLUMN email_verified_at INTEGER',
  'ALTER TABLE users ADD COLUMN orphaned_at INTEGER',
  'ALTER TABLE org_memberships ADD COLUMN workspace_access_default TEXT',
  'ALTER TABLE workspaces ADD COLUMN email_handle TEXT',
  // Thread-list projection: previews truncated exactly like the list mapper.
  'ALTER TABLE threads ADD COLUMN first_user_message_preview TEXT',
  'ALTER TABLE threads ADD COLUMN last_user_message_preview TEXT',
  'ALTER TABLE threads ADD COLUMN last_assistant_completed_at INTEGER',
  'ALTER TABLE threads ADD COLUMN last_assistant_summary TEXT',
  'ALTER TABLE threads ADD COLUMN last_assistant_summary_status TEXT',
  'ALTER TABLE threads ADD COLUMN channel_connection_id TEXT',
  'ALTER TABLE threads ADD COLUMN channel_conversation_id TEXT',
  'ALTER TABLE threads ADD COLUMN channel_message_id TEXT',
];

export interface MirroredUserProfile {
  id: string;
  email: string;
  email_verified_at: number | null;
  name: string | null;
  created_at: number;
  is_superuser: boolean;
  avatar: { color: string; content: string };
  is_orphaned: boolean;
  orphaned_at: number | null;
}

/** A D1 threads row projected for thread lists (previews already truncated). */
export interface MirroredThreadRow {
  id: string;
  workspace_id: string;
  title: string | null;
  created_by: string | null;
  model: string;
  created_at: number;
  updated_at: number;
  user_message_count: number | null;
  first_user_message_preview: string | null;
  last_user_message_preview: string | null;
  last_user_message_at: number | null;
  last_assistant_completed_at: number | null;
  last_assistant_summary: string | null;
  last_assistant_summary_status: string | null;
  source: string | null;
  channel_kind: string | null;
  channel_kinds: string | null;
  channel_connection_id: string | null;
  channel_conversation_id: string | null;
  channel_message_id: string | null;
}

const MIRRORED_THREAD_COLUMNS = [
  'id',
  'workspace_id',
  'title',
  'created_by',
  'model',
  'created_at',
  'updated_at',
  'user_message_count',
  'first_user_message_preview',
  'last_user_message_preview',
  'last_user_message_at',
  'last_assistant_completed_at',
  'last_assistant_summary',
  'last_assistant_summary_status',
  'source',
  'channel_kind',
  'channel_kinds',
  'channel_connection_id',
  'channel_conversation_id',
  'channel_message_id',
].join(', ');

/** Thread list previews: the same limit `toThreadListPreview` applies. */
export const THREAD_LIST_PREVIEW_LENGTH = 500;

export function workspaceMemberMirrorKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

const MIRROR_ROW_CLAIM_SQL = `
  INSERT INTO mirror_rows (entity, entity_key, version, deleted, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(entity, entity_key) DO UPDATE SET
    version = excluded.version,
    deleted = excluded.deleted,
    updated_at = excluded.updated_at
  WHERE excluded.version > mirror_rows.version
`;

export function orgMembershipMirrorKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

function normalizeMirrorVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

type MirrorGuard = { sql: string; binds: unknown[] };

/**
 * Guard for a mirrored upsert. Versioned: the write lands only while `version`
 * is the row's recorded live version, so a newer write or a newer delete turns
 * it into a no-op. Unversioned (legacy/repair): lands unless a versioned delete
 * has tombstoned the row.
 */
function mirrorUpsertGuard(entity: MirrorEntity, key: string, version: number | undefined): MirrorGuard {
  if (version === undefined) {
    return {
      sql: 'NOT EXISTS (SELECT 1 FROM mirror_rows WHERE entity = ? AND entity_key = ? AND deleted = 1)',
      binds: [entity, key],
    };
  }
  return {
    sql: 'EXISTS (SELECT 1 FROM mirror_rows WHERE entity = ? AND entity_key = ? AND version = ? AND deleted = 0)',
    binds: [entity, key, version],
  };
}

function mirrorDeleteGuard(entity: MirrorEntity, key: string, version: number | undefined): MirrorGuard {
  if (version === undefined) return { sql: '1', binds: [] };
  return {
    sql: 'EXISTS (SELECT 1 FROM mirror_rows WHERE entity = ? AND entity_key = ? AND version = ? AND deleted = 1)',
    binds: [entity, key, version],
  };
}

export class AppIndexDatabase {
  private schemaReady: Promise<void> | null = null;

  constructor(
    private readonly db: D1Binding,
    private readonly observability?: ObservabilityEnv,
  ) {}

  /** One schema statement, failing as an AppIndexSchemaError that names it. */
  private async runSchemaStatement(statement: string): Promise<void> {
    try {
      await this.db.prepare(statement).run();
    } catch (error) {
      throw new AppIndexSchemaError(statement, error);
    }
  }

  /**
   * The CREATE statements in one batch. D1 fails a batch as a whole without
   * saying which statement broke it, so on failure they run again one at a
   * time (each is IF NOT EXISTS) to find it.
   */
  private async runSchemaBatch(statements: string[]): Promise<void> {
    try {
      await this.db.batch(statements.map((statement) => this.db.prepare(statement)));
    } catch (error) {
      for (const statement of statements) await this.runSchemaStatement(statement);
      throw new AppIndexSchemaError('(batch)', error);
    }
  }

  async ensureSchema(): Promise<void> {
    const statements = `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        avatar_color TEXT,
        avatar_content TEXT,
        created_at INTEGER NOT NULL,
        is_superuser INTEGER NOT NULL DEFAULT 0,
        is_orphaned INTEGER NOT NULL DEFAULT 0,
        org_count INTEGER NOT NULL DEFAULT 0,
        signup_ip TEXT
      );
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT,
        created_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        billing_status TEXT,
        billing_plan TEXT,
        created_by TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        workspace_count INTEGER NOT NULL DEFAULT 0,
        llm_provider TEXT,
        llm_provider_updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        org_id TEXT NOT NULL,
        description TEXT,
        avatar_color TEXT,
        avatar_content TEXT,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        archived_by TEXT,
        compute_tier TEXT NOT NULL DEFAULT 'standard',
        thread_count INTEGER NOT NULL DEFAULT 0,
        integration_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT,
        model TEXT,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_by TEXT,
        user_message_count INTEGER,
        first_user_message TEXT,
        last_user_message_at INTEGER,
        source TEXT,
        channel_kind TEXT,
        channel_kinds TEXT,
        chat_error_count INTEGER NOT NULL DEFAULT 0,
        last_chat_error_at INTEGER,
        last_chat_error_message TEXT,
        last_chat_error_source TEXT,
        last_chat_error_status INTEGER,
        last_chat_error_provider TEXT,
        last_chat_error_model TEXT,
        model_history TEXT,
        last_model_changed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS chat_error_events (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        user_id TEXT,
        created_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        error_kind TEXT,
        status INTEGER,
        provider TEXT,
        model TEXT,
        message_normalized TEXT NOT NULL,
        message_sample TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS apps (
        app_id TEXT PRIMARY KEY,
        script_name TEXT NOT NULL,
        org_id TEXT,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_public INTEGER NOT NULL DEFAULT 0,
        preview_status TEXT,
        preview_error TEXT
      );
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_users (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blocked_signup_ips (
        ip TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL,
        blocked_by TEXT,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS org_memberships (
        org_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (org_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS app_index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mirror_rows (
        entity TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (entity, entity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_mirror_rows_deleted_updated_at ON mirror_rows(deleted, updated_at);
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        access_level TEXT NOT NULL,
        granted_by TEXT,
        granted_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, org_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_org ON workspace_members(org_id);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_orgs_created_at ON orgs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orgs_llm_provider_created_at ON orgs(llm_provider, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_workspaces_org_created_at ON workspaces(org_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_org_updated_at ON threads(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated_at ON threads(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_created_by_created_at ON threads(created_by, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_chat_error_events_created_at ON chat_error_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_error_events_fingerprint_created_at ON chat_error_events(fingerprint, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_error_events_thread_created_at ON chat_error_events(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_apps_org_updated_at ON apps(org_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_apps_workspace_updated_at ON apps(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_org_memberships_user_id ON org_memberships(user_id);
      CREATE INDEX IF NOT EXISTS idx_org_memberships_org_joined_at ON org_memberships(org_id, joined_at DESC);
    `;
    this.schemaReady ??= this.runSchemaBatch(
      statements
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
      .then(async () => {
        try {
          await this.db.prepare("ALTER TABLE apps ADD COLUMN project_id TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE orgs ADD COLUMN billing_plan TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN user_message_count INTEGER").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN first_user_message TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_user_message_at INTEGER").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN source TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN channel_kind TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN channel_kinds TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN chat_error_count INTEGER NOT NULL DEFAULT 0").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_chat_error_at INTEGER").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_chat_error_message TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_chat_error_source TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_chat_error_status INTEGER").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_chat_error_provider TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_chat_error_model TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN model_history TEXT").run();
        } catch {}
        try {
          await this.db.prepare("ALTER TABLE threads ADD COLUMN last_model_changed_at INTEGER").run();
        } catch {}
        // Columns the fan-out reads (org members, user orgs, thread lists,
        // workspace switcher) need to be served from D1. Added here rather than
        // in migrations/ because SQLite has no ADD COLUMN IF NOT EXISTS and this
        // runtime path may already have run against a database.
        for (const statement of MIRROR_FANOUT_COLUMN_STATEMENTS) {
          try {
            await this.db.prepare(statement).run();
          } catch {}
        }
        for (const statement of [
          "CREATE INDEX IF NOT EXISTS idx_apps_project_updated_at ON apps(project_id, updated_at DESC)",
          "CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC)",
          "CREATE INDEX IF NOT EXISTS idx_threads_created_at ON threads(created_at DESC)",
          "CREATE INDEX IF NOT EXISTS idx_threads_created_by_created_at ON threads(created_by, created_at, id)",
          "CREATE INDEX IF NOT EXISTS idx_threads_chat_error_updated_at ON threads(chat_error_count, updated_at DESC)",
          "CREATE INDEX IF NOT EXISTS idx_chat_error_events_created_at ON chat_error_events(created_at DESC)",
          "CREATE INDEX IF NOT EXISTS idx_chat_error_events_fingerprint_created_at ON chat_error_events(fingerprint, created_at DESC)",
          "CREATE INDEX IF NOT EXISTS idx_chat_error_events_thread_created_at ON chat_error_events(thread_id, created_at DESC)",
        ]) {
          await this.runSchemaStatement(statement);
        }
        const version = await first<{ value: string }>(
          this.db.prepare("SELECT value FROM app_index_metadata WHERE key = ? LIMIT 1").bind(THREADS_INDEX_VERSION_KEY),
        );
        if (version?.value !== THREADS_INDEX_VERSION) {
          const now = Date.now();
          // Do not clear bootstrap readiness here: ensureSchema runs in admin
          // request paths, and rebuilding the full index synchronously can time out
          // at production scale. The marker lets an explicit backfill workflow pick
          // up old rows without blocking ordinary admin reads.
          await this.db.batch([
            this.db
              .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES (?, ?, ?)")
              .bind(THREADS_INDEX_VERSION_KEY, THREADS_INDEX_VERSION, now),
            this.db
              .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES (?, ?, ?)")
              .bind(THREADS_INDEX_BACKFILL_REQUIRED_KEY, '1', now),
          ]);
        }
      })
      .then(
        () => undefined,
        (error: unknown) => {
          // Loudly, once per failed attempt, naming the statement: otherwise
          // every caller fails downstream on a table that was never created
          // (2026-09-29: an old workspace_members without org_id failed
          // CREATE INDEX, so mirror_rows never existed and every mirror
          // drain failed). The next call tries again.
          this.schemaReady = null;
          const statement = error instanceof AppIndexSchemaError ? error.statement : null;
          console.error('[app-index] ensureSchema failed', statement ?? '', error);
          recordErrorEvent(this.observability, {
            event: 'app_index_schema_failed',
            component: 'app_index_db',
            operation: 'ensure_schema',
            status: 'error',
            error,
          });
          throw error;
        },
      );
    await this.schemaReady;
  }

  private getAppId(orgId: string | null | undefined, scriptName: string): string {
    return orgId ? `${orgId}:${scriptName}` : scriptName;
  }

  async isBootstrapComplete(): Promise<boolean> {
    await this.ensureSchema();
    const row = await first<{ value: string }>(
      this.db.prepare(`
        SELECT value
        FROM app_index_metadata
        WHERE key IN ('bootstrap_complete', 'ready') AND value = '1'
        LIMIT 1
      `),
    );
    return row?.value === '1';
  }

  async getMetadata(key: string): Promise<string | null> {
    await this.ensureSchema();
    const row = await first<{ value: string }>(
      this.db.prepare('SELECT value FROM app_index_metadata WHERE key = ? LIMIT 1').bind(key),
    );
    return row?.value ?? null;
  }

  async setMetadata(key: string, value: string): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare('INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES (?, ?, ?)')
      .bind(key, value, Date.now())
      .run();
  }

  async markBootstrapComplete(): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare("INSERT OR REPLACE INTO app_index_metadata (key, value, updated_at) VALUES ('bootstrap_complete', '1', ?)")
      .bind(Date.now())
      .run();
  }

  async isThreadsIndexBackfillRequired(): Promise<boolean> {
    await this.ensureSchema();
    const row = await first<{ value: string }>(
      this.db.prepare("SELECT value FROM app_index_metadata WHERE key = ? LIMIT 1").bind(THREADS_INDEX_BACKFILL_REQUIRED_KEY),
    );
    return row?.value === '1';
  }

  async markThreadsIndexBackfillComplete(): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare("DELETE FROM app_index_metadata WHERE key = ?")
      .bind(THREADS_INDEX_BACKFILL_REQUIRED_KEY)
      .run();
  }

  private async all<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> {
    await this.ensureSchema();
    const result = await this.db.prepare(query).bind(...params).all<T>();
    return result.results ?? [];
  }

  async isSignupIpBlocked(ip: string): Promise<boolean> {
    await this.ensureSchema();
    const normalizedIp = normalizeSignupIp(ip);
    if (!normalizedIp) return false;
    const row = await first(this.db.prepare('SELECT 1 FROM blocked_signup_ips WHERE ip = ? LIMIT 1').bind(normalizedIp));
    return Boolean(row);
  }

  async blockSignupIp(ip: string, blockedBy: string | null = null, reason: string | null = null): Promise<void> {
    await this.ensureSchema();
    const normalizedIp = normalizeSignupIp(ip);
    if (!normalizedIp) {
      throw new Error('Invalid signup IP');
    }

    await this.db
      .prepare(`
        INSERT INTO blocked_signup_ips (ip, blocked_at, blocked_by, reason)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ip) DO UPDATE SET
          blocked_at = excluded.blocked_at,
          blocked_by = excluded.blocked_by,
          reason = excluded.reason
      `)
      .bind(normalizedIp, Date.now(), blockedBy, reason)
      .run();
  }

  async unblockSignupIp(ip: string): Promise<void> {
    await this.ensureSchema();
    const normalizedIp = normalizeSignupIp(ip);
    if (!normalizedIp) return;
    await this.db.prepare('DELETE FROM blocked_signup_ips WHERE ip = ?').bind(normalizedIp).run();
  }

  /**
   * Statements that record `version` as the entity row's current version.
   * Monotonic: an older or equal version leaves the ledger untouched, and the
   * data statement's guard then decides whether this write is still current.
   */
  private claimMirrorVersion(
    entity: MirrorEntity,
    key: string,
    version: number | undefined,
    deleted: boolean,
  ): D1PreparedStatement[] {
    if (version === undefined) return [];
    return [
      this.db
        .prepare(MIRROR_ROW_CLAIM_SQL)
        .bind(entity, key, version, deleted ? 1 : 0, Date.now()),
    ];
  }

  async applyAdminEvent(event: VersionedAdminEvent): Promise<void> {
    await this.ensureSchema();
    const version = normalizeMirrorVersion(event.version);
    switch (event.type) {
      case 'user_upsert': {
        const u = event.payload;
        const deleted = await first(this.db.prepare('SELECT 1 FROM deleted_users WHERE id = ? LIMIT 1').bind(u.id));
        if (deleted) break;
        const orgCount = typeof u.org_count === 'number' && Number.isFinite(u.org_count) ? u.org_count : null;
        const signupIp = typeof u.signup_ip === 'string' && u.signup_ip.trim() ? u.signup_ip.trim().toLowerCase() : null;
        const guard = mirrorUpsertGuard('user', u.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('user', u.id, version, false),
          this.db
            .prepare(`
              INSERT INTO users (id, email, name, avatar_color, avatar_content, created_at, is_superuser, is_orphaned, org_count, signup_ip, email_verified_at, orphaned_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, COALESCE((SELECT org_count FROM users WHERE id = ?), 0)), COALESCE(?, (SELECT signup_ip FROM users WHERE id = ?)), ?, ?
              WHERE ${guard.sql}
              ON CONFLICT(id) DO UPDATE SET
                email=excluded.email,
                name=excluded.name,
                avatar_color=excluded.avatar_color,
                avatar_content=excluded.avatar_content,
                is_superuser=excluded.is_superuser,
                is_orphaned=excluded.is_orphaned,
                org_count=COALESCE(excluded.org_count, users.org_count),
                signup_ip=COALESCE(excluded.signup_ip, users.signup_ip),
                email_verified_at=CASE WHEN ? THEN excluded.email_verified_at ELSE users.email_verified_at END,
                orphaned_at=CASE WHEN ? THEN excluded.orphaned_at ELSE users.orphaned_at END
            `)
            .bind(
              u.id, u.email ?? '', u.name ?? null, u.avatar?.color ?? '', u.avatar?.content ?? '', u.created_at ?? Date.now(), u.is_superuser ? 1 : 0, u.is_orphaned ? 1 : 0, orgCount, u.id, signupIp, u.id,
              normalizeNullableNumber(u.email_verified_at), normalizeNullableNumber(u.orphaned_at),
              ...guard.binds,
              hasOwnField(u, 'email_verified_at') ? 1 : 0,
              hasOwnField(u, 'orphaned_at') ? 1 : 0,
            ),
        ]);
        break;
      }
      case 'user_delete':
        await this.db.batch([
          this.db.prepare('INSERT OR REPLACE INTO deleted_users (id, deleted_at) VALUES (?, ?)').bind(event.payload.id, Date.now()),
          this.db.prepare('DELETE FROM org_memberships WHERE user_id = ?').bind(event.payload.id),
          this.db.prepare('DELETE FROM users WHERE id = ?').bind(event.payload.id),
        ]);
        break;
      case 'org_upsert': {
        const o = event.payload;
        const slug = typeof o.slug === 'string' && o.slug.trim() ? o.slug : null;
        const memberCount = typeof o.member_count === 'number' && Number.isFinite(o.member_count) ? o.member_count : null;
        const workspaceCount = typeof o.workspace_count === 'number' && Number.isFinite(o.workspace_count) ? o.workspace_count : null;
        const guard = mirrorUpsertGuard('org', o.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('org', o.id, version, false),
          this.db
            .prepare(`
              INSERT INTO orgs (id, name, slug, created_at, archived, billing_status, billing_plan, created_by, member_count, workspace_count)
              SELECT ?, ?, COALESCE(?, (SELECT slug FROM orgs WHERE id = ?)), ?, ?, ?, ?, ?, COALESCE(?, COALESCE((SELECT member_count FROM orgs WHERE id = ?), 0)), COALESCE(?, COALESCE((SELECT workspace_count FROM orgs WHERE id = ?), 0))
              WHERE ${guard.sql}
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                slug=COALESCE(excluded.slug, orgs.slug),
                archived=excluded.archived,
                billing_status=excluded.billing_status,
                billing_plan=excluded.billing_plan,
                member_count=COALESCE(excluded.member_count, orgs.member_count),
                workspace_count=COALESCE(excluded.workspace_count, orgs.workspace_count)
            `)
            .bind(o.id, o.name, slug, o.id, o.created_at ?? Date.now(), o.archived ? 1 : 0, o.billing_status ?? null, o.billing_plan ?? null, o.created_by ?? null, memberCount, o.id, workspaceCount, o.id, ...guard.binds),
        ]);
        break;
      }
      case 'org_llm_provider_update': {
        const guard = mirrorUpsertGuard('org', event.payload.org_id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('org', event.payload.org_id, version, false),
          this.db
            .prepare(`UPDATE orgs SET llm_provider = ?, llm_provider_updated_at = ? WHERE id = ? AND ${guard.sql}`)
            .bind(event.payload.provider, event.payload.updated_at, event.payload.org_id, ...guard.binds),
        ]);
        break;
      }
      case 'workspace_upsert': {
        const w = event.payload;
        const integrationCount = typeof w.integration_count === 'number' && Number.isFinite(w.integration_count) ? w.integration_count : null;
        const guard = mirrorUpsertGuard('workspace', w.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('workspace', w.id, version, false),
          this.db
            .prepare(`
              INSERT INTO workspaces (id, name, org_id, description, avatar_color, avatar_content, created_at, created_by, archived, archived_at, archived_by, compute_tier, thread_count, integration_count, email_handle)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT thread_count FROM workspaces WHERE id = ?), 0), COALESCE(?, COALESCE((SELECT integration_count FROM workspaces WHERE id = ?), 0)), ?
              WHERE ${guard.sql}
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                org_id=excluded.org_id,
                description=excluded.description,
                avatar_color=COALESCE(excluded.avatar_color, workspaces.avatar_color),
                avatar_content=COALESCE(excluded.avatar_content, workspaces.avatar_content),
                created_at=excluded.created_at,
                created_by=excluded.created_by,
                archived=excluded.archived,
                archived_at=excluded.archived_at,
                archived_by=excluded.archived_by,
                compute_tier=COALESCE(excluded.compute_tier, 'standard'),
                integration_count=COALESCE(excluded.integration_count, integration_count),
                email_handle=CASE WHEN ? THEN excluded.email_handle ELSE workspaces.email_handle END
            `)
            .bind(
              w.id, w.name, w.org_id, w.description ?? null, w.avatar?.color ?? null, w.avatar?.content ?? null, w.created_at ?? Date.now(), w.created_by ?? null, w.archived ? 1 : 0, w.archived_at ?? null, w.archived_by ?? null, w.compute_tier ?? 'standard', w.id, integrationCount, w.id,
              typeof w.email_handle === 'string' ? w.email_handle : null,
              ...guard.binds,
              hasOwnField(w, 'email_handle') ? 1 : 0,
            ),
          this.db.prepare('UPDATE orgs SET workspace_count = (SELECT COUNT(*) FROM workspaces WHERE org_id = ?) WHERE id = ?').bind(w.org_id, w.org_id),
        ]);
        break;
      }
      case 'thread_upsert': {
        const t = event.payload;
        const userMessageCount = typeof t.user_message_count === 'number' && Number.isFinite(t.user_message_count) ? t.user_message_count : null;
        const firstUserMessage = truncateThreadPreviewText(
          typeof t.first_user_message === 'string' ? t.first_user_message : null,
          CHAT_EXPLORER_FIRST_USER_MESSAGE_PREVIEW_LENGTH,
        );
        const channelKinds = normalizeChannelKindsForIndex(t.channel_kinds);
        const existingThreadMetadata = await first<ExistingThreadMetadata>(
          this.db.prepare(`
            SELECT
              chat_error_count,
              last_chat_error_at,
              last_chat_error_message,
              last_chat_error_source,
              last_chat_error_status,
              last_chat_error_provider,
              last_chat_error_model,
              model_history,
              last_model_changed_at
            FROM threads
            WHERE id = ?
            LIMIT 1
          `).bind(t.id),
        );
        const hasChatErrorSummary = hasOwnField(t, 'chat_error_count');
        const hasModelHistory = hasOwnField(t, 'model_history');
        const hasLastModelChangedAt = hasOwnField(t, 'last_model_changed_at');
        const incomingModelHistory = hasModelHistory
          ? normalizeModelHistoryForIndex(t.model_history, t.model)
          : normalizeModelHistoryForIndex(undefined, t.model);
        const existingErrorCount = normalizeNonNegativeInteger(existingThreadMetadata?.chat_error_count);
        const incomingErrorCount = hasChatErrorSummary ? normalizeNonNegativeInteger(t.chat_error_count) : 0;
        const chatErrorCount = hasChatErrorSummary
          ? Math.max(existingErrorCount, incomingErrorCount)
          : existingErrorCount;
        const incomingErrorAt = normalizeNullableNumber(t.last_chat_error_at);
        const existingErrorAt = normalizeNullableNumber(existingThreadMetadata?.last_chat_error_at);
        const shouldUseIncomingErrorSummary =
          hasChatErrorSummary &&
          incomingErrorAt !== null &&
          (existingErrorAt === null || incomingErrorAt >= existingErrorAt);
        const modelHistory = hasModelHistory
          ? mergeModelHistoryForIndex(existingThreadMetadata?.model_history, incomingModelHistory, t.model)
          : existingThreadMetadata?.model_history ?? incomingModelHistory;
        const incomingLastModelChangedAt = normalizeNullableNumber(t.last_model_changed_at);
        const existingLastModelChangedAt = normalizeNullableNumber(existingThreadMetadata?.last_model_changed_at);
        const lastModelChangedAt =
          hasLastModelChangedAt &&
          incomingLastModelChangedAt !== null &&
          (existingLastModelChangedAt === null || incomingLastModelChangedAt >= existingLastModelChangedAt)
            ? incomingLastModelChangedAt
            : existingLastModelChangedAt;
        const guard = mirrorUpsertGuard('thread', t.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('thread', t.id, version, false),
          this.db
            .prepare(`
              INSERT INTO threads (
                id,
                title,
                model,
                org_id,
                workspace_id,
                created_at,
                updated_at,
                created_by,
                user_message_count,
                first_user_message,
                last_user_message_at,
                source,
                channel_kind,
                channel_kinds,
                chat_error_count,
                last_chat_error_at,
                last_chat_error_message,
                last_chat_error_source,
                last_chat_error_status,
                last_chat_error_provider,
                last_chat_error_model,
                model_history,
                last_model_changed_at,
                first_user_message_preview,
                last_user_message_preview,
                last_assistant_completed_at,
                last_assistant_summary,
                last_assistant_summary_status,
                channel_connection_id,
                channel_conversation_id,
                channel_message_id
              )
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${guard.sql}
              ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                model=excluded.model,
                updated_at=excluded.updated_at,
                created_by=excluded.created_by,
                user_message_count=excluded.user_message_count,
                first_user_message=excluded.first_user_message,
                last_user_message_at=excluded.last_user_message_at,
                source=excluded.source,
                channel_kind=excluded.channel_kind,
                channel_kinds=excluded.channel_kinds,
                chat_error_count=excluded.chat_error_count,
                last_chat_error_at=excluded.last_chat_error_at,
                last_chat_error_message=excluded.last_chat_error_message,
                last_chat_error_source=excluded.last_chat_error_source,
                last_chat_error_status=excluded.last_chat_error_status,
                last_chat_error_provider=excluded.last_chat_error_provider,
                last_chat_error_model=excluded.last_chat_error_model,
                model_history=excluded.model_history,
                last_model_changed_at=excluded.last_model_changed_at,
                first_user_message_preview=CASE WHEN ? THEN excluded.first_user_message_preview ELSE threads.first_user_message_preview END,
                last_user_message_preview=CASE WHEN ? THEN excluded.last_user_message_preview ELSE threads.last_user_message_preview END,
                last_assistant_completed_at=CASE WHEN ? THEN excluded.last_assistant_completed_at ELSE threads.last_assistant_completed_at END,
                last_assistant_summary=CASE WHEN ? THEN excluded.last_assistant_summary ELSE threads.last_assistant_summary END,
                last_assistant_summary_status=CASE WHEN ? THEN excluded.last_assistant_summary_status ELSE threads.last_assistant_summary_status END,
                channel_connection_id=CASE WHEN ? THEN excluded.channel_connection_id ELSE threads.channel_connection_id END,
                channel_conversation_id=CASE WHEN ? THEN excluded.channel_conversation_id ELSE threads.channel_conversation_id END,
                channel_message_id=CASE WHEN ? THEN excluded.channel_message_id ELSE threads.channel_message_id END
            `)
            .bind(
              t.id,
              t.title ?? null,
              t.model ?? 'sonnet',
              t.org_id,
              t.workspace_id,
              t.created_at ?? Date.now(),
              t.updated_at ?? Date.now(),
              t.created_by ?? null,
              userMessageCount,
              firstUserMessage,
              t.last_user_message_at ?? null,
              t.source ?? null,
              t.channel_kind ?? null,
              channelKinds,
              chatErrorCount,
              shouldUseIncomingErrorSummary ? incomingErrorAt : existingErrorAt,
              shouldUseIncomingErrorSummary
                ? truncateChatMetadata(t.last_chat_error_message)
                : existingThreadMetadata?.last_chat_error_message ?? null,
              shouldUseIncomingErrorSummary
                ? truncateChatMetadata(t.last_chat_error_source, 64)
                : existingThreadMetadata?.last_chat_error_source ?? null,
              shouldUseIncomingErrorSummary
                ? normalizeNullableNumber(t.last_chat_error_status)
                : existingThreadMetadata?.last_chat_error_status ?? null,
              shouldUseIncomingErrorSummary
                ? truncateChatMetadata(t.last_chat_error_provider, 80)
                : existingThreadMetadata?.last_chat_error_provider ?? null,
              shouldUseIncomingErrorSummary
                ? truncateChatMetadata(t.last_chat_error_model, 160)
                : existingThreadMetadata?.last_chat_error_model ?? null,
              modelHistory,
              lastModelChangedAt,
              truncateThreadPreviewText(
                typeof t.first_user_message === 'string' ? t.first_user_message : null,
                THREAD_LIST_PREVIEW_LENGTH,
              ),
              truncateThreadPreviewText(
                typeof t.last_user_message === 'string' ? t.last_user_message : null,
                THREAD_LIST_PREVIEW_LENGTH,
              ),
              normalizeNullableNumber(t.last_assistant_completed_at),
              typeof t.last_assistant_summary === 'string' ? t.last_assistant_summary : null,
              typeof t.last_assistant_summary_status === 'string' ? t.last_assistant_summary_status : null,
              t.channel_connection_id ?? null,
              t.channel_conversation_id ?? null,
              t.channel_message_id ?? null,
              ...guard.binds,
              // The list projection is owned by the DO snapshot: unversioned
              // (legacy/repair) writes, which may carry admin-truncated text,
              // leave it alone, as do snapshots that omit a field.
              ...[
                'first_user_message',
                'last_user_message',
                'last_assistant_completed_at',
                'last_assistant_summary',
                'last_assistant_summary_status',
                'channel_connection_id',
                'channel_conversation_id',
                'channel_message_id',
              ].map((field) => (version !== undefined && hasOwnField(t, field) ? 1 : 0)),
            ),
          this.db.prepare('UPDATE workspaces SET thread_count = (SELECT COUNT(*) FROM threads WHERE workspace_id = ?) WHERE id = ?').bind(t.workspace_id, t.workspace_id),
        ]);
        break;
      }
      case 'thread_error_recorded': {
        const payload = event.payload ?? {};
        const normalized = payload?.fingerprint && payload?.message_normalized && payload?.message_sample
          ? {
              id: String(payload.id ?? `${payload.thread_id ?? ''}:${payload.created_at ?? ''}:${payload.fingerprint}`),
              fingerprint: String(payload.fingerprint),
              thread_id: String(payload.thread_id ?? ''),
              org_id: String(payload.org_id ?? ''),
              workspace_id: String(payload.workspace_id ?? ''),
              user_id: truncateChatMetadata(payload.user_id, 160),
              created_at: normalizeNullableNumber(payload.created_at) ?? Date.now(),
              source: truncateChatMetadata(payload.source, 64) ?? 'chat_event',
              error_kind: truncateChatMetadata(payload.error_kind, 64),
              status: normalizeNullableNumber(payload.status),
              provider: truncateChatMetadata(payload.provider, 80),
              model: truncateChatMetadata(payload.model, 160),
              message_normalized: normalizeChatErrorMessage(String(payload.message_normalized ?? '')) || 'Unknown chat error',
              message_sample: normalizeChatErrorMessage(String(payload.message_sample ?? '')) || 'Unknown chat error',
            }
          : buildChatErrorEventPayload({
              threadId: String(payload.thread_id ?? payload.threadId ?? ''),
              orgId: String(payload.org_id ?? payload.orgId ?? ''),
              workspaceId: String(payload.workspace_id ?? payload.workspaceId ?? ''),
              userId: typeof payload.user_id === 'string' ? payload.user_id : payload.userId ?? null,
              message: String(payload.message ?? payload.error ?? payload.message_sample ?? 'Unknown chat error'),
              source: payload.source,
              errorKind: payload.error_kind ?? payload.errorKind,
              status: payload.status,
              provider: payload.provider,
              model: payload.model,
              createdAt: payload.created_at ?? payload.createdAt,
            });
        if (!normalized.thread_id || !normalized.org_id || !normalized.workspace_id) {
          break;
        }
        // Append-only and keyed by id, so replays are idempotent without a version.
        await this.db
          .prepare(`
            INSERT OR IGNORE INTO chat_error_events (
              id,
              fingerprint,
              thread_id,
              org_id,
              workspace_id,
              user_id,
              created_at,
              source,
              error_kind,
              status,
              provider,
              model,
              message_normalized,
              message_sample
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            normalized.id,
            normalized.fingerprint,
            normalized.thread_id,
            normalized.org_id,
            normalized.workspace_id,
            normalized.user_id,
            normalized.created_at,
            normalized.source,
            normalized.error_kind,
            normalized.status,
            normalized.provider,
            normalized.model,
            normalized.message_normalized,
            normalized.message_sample,
          )
          .run();
        break;
      }
      case 'app_upsert': {
        const a = event.payload;
        const appId = this.getAppId(a.org_id, a.script_name);
        const guard = mirrorUpsertGuard('app', appId, version);
        await this.db.batch([
          ...this.claimMirrorVersion('app', appId, version, false),
          this.db
            .prepare(`
              INSERT INTO apps (app_id, script_name, org_id, workspace_id, project_id, created_by, created_at, updated_at, is_public, preview_status, preview_error)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${guard.sql}
              ON CONFLICT(app_id) DO UPDATE SET
                script_name=excluded.script_name,
                org_id=excluded.org_id,
                workspace_id=excluded.workspace_id,
                project_id=excluded.project_id,
                created_by=excluded.created_by,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                is_public=excluded.is_public,
                preview_status=excluded.preview_status,
                preview_error=excluded.preview_error
            `)
            .bind(appId, a.script_name, a.org_id ?? null, a.workspace_id, a.project_id ?? null, a.created_by ?? null, a.created_at ?? Date.now(), a.updated_at ?? Date.now(), a.is_public ? 1 : 0, a.preview_status ?? null, a.preview_error ?? null, ...guard.binds),
        ]);
        break;
      }
      case 'invitation_upsert': {
        const i = event.payload;
        const guard = mirrorUpsertGuard('invitation', i.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('invitation', i.id, version, false),
          this.db
            .prepare(`
              INSERT INTO invitations (id, org_id, email, role, invited_by, status, created_at, expires_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?
              WHERE ${guard.sql}
              ON CONFLICT(id) DO UPDATE SET status=excluded.status, role=excluded.role
            `)
            .bind(i.id, i.org_id, i.email, i.role, i.invited_by, i.status ?? 'pending', i.created_at ?? Date.now(), i.expires_at ?? Date.now(), ...guard.binds),
        ]);
        break;
      }
      case 'thread_delete': {
        const workspaceId = event.payload.workspace_id ?? (await first<{ workspace_id: string }>(this.db.prepare('SELECT workspace_id FROM threads WHERE id = ?').bind(event.payload.id)))?.workspace_id ?? null;
        const guard = mirrorDeleteGuard('thread', event.payload.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('thread', event.payload.id, version, true),
          this.db.prepare(`DELETE FROM threads WHERE id = ? AND ${guard.sql}`).bind(event.payload.id, ...guard.binds),
          ...(workspaceId
            ? [this.db.prepare('UPDATE workspaces SET thread_count = (SELECT COUNT(*) FROM threads WHERE workspace_id = ?) WHERE id = ?').bind(workspaceId, workspaceId)]
            : []),
        ]);
        break;
      }
      case 'app_delete': {
        if (!event.payload.org_id) {
          await this.db.prepare('DELETE FROM apps WHERE script_name = ?').bind(event.payload.script_name).run();
          break;
        }
        const appId = this.getAppId(event.payload.org_id, event.payload.script_name);
        const guard = mirrorDeleteGuard('app', appId, version);
        await this.db.batch([
          ...this.claimMirrorVersion('app', appId, version, true),
          this.db.prepare(`DELETE FROM apps WHERE app_id = ? AND ${guard.sql}`).bind(appId, ...guard.binds),
        ]);
        break;
      }
      case 'invitation_delete': {
        const guard = mirrorDeleteGuard('invitation', event.payload.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('invitation', event.payload.id, version, true),
          this.db.prepare(`DELETE FROM invitations WHERE id = ? AND ${guard.sql}`).bind(event.payload.id, ...guard.binds),
        ]);
        break;
      }
      case 'workspace_delete': {
        const orgId = (await first<{ org_id: string }>(this.db.prepare('SELECT org_id FROM workspaces WHERE id = ?').bind(event.payload.id)))?.org_id ?? null;
        const guard = mirrorDeleteGuard('workspace', event.payload.id, version);
        await this.db.batch([
          ...this.claimMirrorVersion('workspace', event.payload.id, version, true),
          this.db.prepare(`DELETE FROM workspaces WHERE id = ? AND ${guard.sql}`).bind(event.payload.id, ...guard.binds),
          ...(orgId
            ? [this.db.prepare('UPDATE orgs SET workspace_count = (SELECT COUNT(*) FROM workspaces WHERE org_id = ?) WHERE id = ?').bind(orgId, orgId)]
            : []),
        ]);
        break;
      }
      // Legacy relative counters: not idempotent, so the DO outbox never emits
      // them (it mirrors absolute counts in org/user snapshots instead).
      case 'org_member_delta':
        await this.db.prepare('UPDATE orgs SET member_count = MAX(0, member_count + ?) WHERE id = ?').bind(event.payload.delta, event.payload.org_id).run();
        break;
      case 'user_org_delta':
        await this.db.prepare('UPDATE users SET org_count = MAX(0, org_count + ?) WHERE id = ?').bind(event.payload.delta, event.payload.user_id).run();
        break;
      case 'org_membership_upsert': {
        const key = orgMembershipMirrorKey(event.payload.org_id, event.payload.user_id);
        const guard = mirrorUpsertGuard('org_membership', key, version);
        await this.db.batch([
          ...this.claimMirrorVersion('org_membership', key, version, false),
          this.db
            .prepare(`
              INSERT INTO org_memberships (org_id, user_id, role, joined_at, workspace_access_default)
              SELECT ?, ?, ?, ?, ?
              WHERE ${guard.sql}
              ON CONFLICT(org_id, user_id) DO UPDATE SET
                role = excluded.role,
                joined_at = CASE WHEN ? THEN excluded.joined_at ELSE COALESCE(org_memberships.joined_at, excluded.joined_at) END,
                workspace_access_default = COALESCE(excluded.workspace_access_default, org_memberships.workspace_access_default)
            `)
            .bind(
              event.payload.org_id,
              event.payload.user_id,
              event.payload.role,
              event.payload.joined_at,
              event.payload.workspace_access_default ?? null,
              ...guard.binds,
              // A versioned snapshot is the DO's current row: take its joined_at.
              version === undefined ? 0 : 1,
            ),
        ]);
        break;
      }
      case 'org_membership_delete': {
        const key = orgMembershipMirrorKey(event.payload.org_id, event.payload.user_id);
        const guard = mirrorDeleteGuard('org_membership', key, version);
        await this.db.batch([
          ...this.claimMirrorVersion('org_membership', key, version, true),
          this.db
            .prepare(`DELETE FROM org_memberships WHERE org_id = ? AND user_id = ? AND ${guard.sql}`)
            .bind(event.payload.org_id, event.payload.user_id, ...guard.binds),
        ]);
        break;
      }
      case 'workspace_member_upsert': {
        const m = event.payload;
        const key = workspaceMemberMirrorKey(m.workspace_id, m.user_id);
        const guard = mirrorUpsertGuard('workspace_member', key, version);
        await this.db.batch([
          ...this.claimMirrorVersion('workspace_member', key, version, false),
          this.db
            .prepare(`
              INSERT INTO workspace_members (workspace_id, user_id, org_id, access_level, granted_by, granted_at)
              SELECT ?, ?, ?, ?, ?, ?
              WHERE ${guard.sql}
              ON CONFLICT(workspace_id, user_id) DO UPDATE SET
                org_id = excluded.org_id,
                access_level = excluded.access_level,
                granted_by = excluded.granted_by,
                granted_at = excluded.granted_at
            `)
            .bind(m.workspace_id, m.user_id, m.org_id, m.access_level, m.granted_by ?? null, m.granted_at, ...guard.binds),
        ]);
        break;
      }
      case 'workspace_member_delete': {
        const key = workspaceMemberMirrorKey(event.payload.workspace_id, event.payload.user_id);
        const guard = mirrorDeleteGuard('workspace_member', key, version);
        await this.db.batch([
          ...this.claimMirrorVersion('workspace_member', key, version, true),
          this.db
            .prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND ${guard.sql}`)
            .bind(event.payload.workspace_id, event.payload.user_id, ...guard.binds),
        ]);
        break;
      }
    }
  }

  /**
   * Remove every mirrored row of a hard-deleted org and tombstone the org row
   * permanently, so a late drain cannot resurrect it. Idempotent.
   */
  async purgeMirroredOrg(orgId: string): Promise<void> {
    await this.ensureSchema();
    await this.db.batch([
      this.db
        .prepare(`
          INSERT INTO mirror_rows (entity, entity_key, version, deleted, updated_at)
          VALUES ('org', ?, ?, 1, ?)
          ON CONFLICT(entity, entity_key) DO UPDATE SET
            version = excluded.version, deleted = 1, updated_at = excluded.updated_at
        `)
        .bind(orgId, Number.MAX_SAFE_INTEGER, Date.now()),
      this.db.prepare('DELETE FROM workspace_members WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM org_memberships WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM invitations WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM apps WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM threads WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM chat_error_events WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM workspaces WHERE org_id = ?').bind(orgId),
      this.db.prepare('DELETE FROM orgs WHERE id = ?').bind(orgId),
    ]);
  }

  /**
   * Org ids D1 holds any row for (the org row or an orphaned child), after
   * `afterId`, in id order: the orphan-cleanup walk.
   */
  async listMirroredOrgIds(afterId: string, limit: number): Promise<string[]> {
    // One query per table (D1 caps compound SELECT terms); the smallest
    // `limit` ids of the union are the next page.
    const sources: Array<[string, string]> = [
      ['orgs', 'id'],
      ['workspaces', 'org_id'],
      ['org_memberships', 'org_id'],
      ['threads', 'org_id'],
      ['apps', 'org_id'],
      ['invitations', 'org_id'],
    ];
    const pages = await Promise.all(
      sources.map(([table, column]) =>
        this.all<{ org_id: string }>(
          `SELECT DISTINCT ${column} AS org_id FROM ${table} WHERE ${column} > ? ORDER BY ${column} LIMIT ?`,
          afterId,
          limit,
        ),
      ),
    );
    const ids = new Set(pages.flat().map((row) => row.org_id).filter((id): id is string => Boolean(id)));
    return [...ids].sort().slice(0, limit);
  }

  /** Recent D1 activity for an org: any hit vetoes an orphan purge. */
  async getOrgActivitySince(orgId: string, sinceMs: number): Promise<{ members: number; workspaces: number; threads: number }> {
    const count = async (query: string) =>
      Number((await first<{ n: number }>(this.db.prepare(query).bind(orgId, sinceMs)))?.n ?? 0);
    await this.ensureSchema();
    const [members, workspaces, threads] = await Promise.all([
      count('SELECT COUNT(*) AS n FROM org_memberships WHERE org_id = ? AND joined_at > ?'),
      count('SELECT COUNT(*) AS n FROM workspaces WHERE org_id = ? AND created_at > ?'),
      count('SELECT COUNT(*) AS n FROM threads WHERE org_id = ? AND updated_at > ?'),
    ]);
    return { members, workspaces, threads };
  }

  /** What D1 knows about a user that could corroborate (or veto) an orphan purge. */
  async getUserOrphanEvidence(userId: string): Promise<{ email: string | null; memberships: number }> {
    await this.ensureSchema();
    const [user, memberships] = await Promise.all([
      first<{ email: string | null }>(this.db.prepare('SELECT email FROM users WHERE id = ?').bind(userId)),
      first<{ n: number }>(this.db.prepare('SELECT COUNT(*) AS n FROM org_memberships WHERE user_id = ?').bind(userId)),
    ]);
    return { email: user?.email ?? null, memberships: Number(memberships?.n ?? 0) };
  }

  async listMirroredUserIds(afterId: string, limit: number): Promise<string[]> {
    const rows = await this.all<{ id: string }>(
      'SELECT id FROM users WHERE id > ? ORDER BY id LIMIT ?',
      afterId,
      limit,
    );
    return rows.map((row) => row.id);
  }

  async handleEvent(event: VersionedAdminEvent): Promise<void> {
    await this.applyAdminEvent(event);
  }

  private async loadAllUsersForDashboardMetrics(): Promise<AdminUserSummaryRow[]> {
    const users = await this.all<any>('SELECT * FROM users');
    return users.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name ?? null,
      avatar: {
        color: row.avatar_color || '#666',
        content: row.avatar_content || 'U',
      },
      created_at: row.created_at,
      org_count: row.org_count ?? 0,
      is_superuser: row.is_superuser === 1,
      is_orphaned: row.is_orphaned === 1,
      signup_ip: row.signup_ip ?? null,
    }));
  }

  private async loadAllThreadsForDashboardMetrics(): Promise<AdminThreadListRow[]> {
    // Keep the dashboard snapshot to its declared list shape. SELECT t.* also
    // materializes chat previews and error/model history for every thread.
    return this.all<AdminThreadListRow>(`
      SELECT
        t.id,
        t.title,
        t.model,
        t.workspace_id,
        t.created_at,
        t.updated_at,
        t.created_by,
        t.org_id,
        o.name AS org_name,
        w.name AS workspace_name
      FROM threads t
      LEFT JOIN orgs o ON t.org_id = o.id
      LEFT JOIN workspaces w ON t.workspace_id = w.id
      ORDER BY t.updated_at DESC, t.id ASC
    `);
  }

  private async loadAllAppsForDashboardMetrics(): Promise<AdminAppListRow[]> {
    const rows = await this.all<any>(`
      SELECT
        a.app_id,
        a.script_name,
        a.org_id,
        o.name AS org_name,
        o.slug AS org_slug,
        a.workspace_id,
        a.project_id,
        w.name AS workspace_name,
        a.created_by,
        u.name AS created_by_name,
        u.email AS created_by_email,
        a.created_at,
        a.updated_at,
        a.is_public,
        a.preview_status,
        a.preview_error
      FROM apps a
      LEFT JOIN orgs o ON a.org_id = o.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      LEFT JOIN users u ON a.created_by = u.id
      ORDER BY a.created_at DESC, a.app_id ASC
    `);
    return rows.map((row) => ({
      app_id: row.app_id,
      script_name: row.script_name,
      org_id: row.org_id,
      workspace_id: row.workspace_id,
      project_id: row.project_id ?? null,
      org_name: row.org_name ?? null,
      org_slug: row.org_slug ?? null,
      workspace_name: row.workspace_name ?? null,
      created_by: row.created_by,
      created_by_name: row.created_by_name ?? null,
      created_by_email: row.created_by_email ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      is_public: row.is_public === 1,
      preview_status: row.preview_status ?? null,
      preview_error: row.preview_error ?? null,
    }));
  }

  private async loadAllWorkspacesForDashboardMetrics(): Promise<DashboardWorkspaceMetricsRow[]> {
    const rows = await this.all<any>('SELECT id, org_id FROM workspaces');
    return rows.map((row) => ({
      id: row.id,
      org_id: row.org_id,
    }));
  }

  private async loadFilteredEntitySnapshot(
    options: DashboardMetricsFilterOptions = {},
  ): Promise<DashboardEntitySnapshot> {
    const [users, threads, apps, workspaces, orgs] = await Promise.all([
      this.loadAllUsersForDashboardMetrics(),
      this.loadAllThreadsForDashboardMetrics(),
      this.loadAllAppsForDashboardMetrics(),
      this.loadAllWorkspacesForDashboardMetrics(),
      this.getOrgDirectoryRows(),
    ]);

    return filterDashboardEntitySnapshot(
      {
        users,
        threads,
        apps,
        orgs,
        workspaces,
      },
      options,
    );
  }

  /** Counts-only path for the frequently polled admin stats endpoint. */
  async getStats() {
    const [totalUsers, totalOrgs, totalMemberships, totalWorkspaces, totalIntegrations, orphanedUsers] = await Promise.all([
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM users')),
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM orgs')),
      first<{ count: number }>(this.db.prepare('SELECT SUM(member_count) AS count FROM orgs')),
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM workspaces')),
      first<{ count: number }>(this.db.prepare('SELECT SUM(integration_count) AS count FROM workspaces')),
      first<{ count: number }>(this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE is_orphaned = 1')),
    ]);
    return {
      total_users: toNumber(totalUsers?.count),
      total_orgs: toNumber(totalOrgs?.count),
      total_memberships: toNumber(totalMemberships?.count),
      total_workspaces: toNumber(totalWorkspaces?.count),
      total_integrations: toNumber(totalIntegrations?.count),
      orphaned_users: toNumber(orphanedUsers?.count),
    };
  }

  async computeDashboardSummary(options: DashboardSummaryOptions): Promise<DashboardSummaryResponse> {
    const snapshot = await this.loadFilteredEntitySnapshot(options);
    return computeDashboardSummaryFromSnapshot(snapshot, options);
  }

  async computeRetentionData(options: DashboardRetentionOptions = {}): Promise<DashboardRetentionResponse> {
    const snapshot = await this.loadFilteredEntitySnapshot(options);
    return computeRetentionDataFromSnapshot(snapshot, options);
  }

  async getUsersPaginated(offset: number, limit: number, search?: string, filters?: UserFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push('(email LIKE ? OR name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (filters?.is_superuser !== undefined) {
      conditions.push('is_superuser = ?');
      params.push(filters.is_superuser ? 1 : 0);
    }
    if (filters?.is_orphaned !== undefined) {
      conditions.push('is_orphaned = ?');
      params.push(filters.is_orphaned ? 1 : 0);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = USER_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const items = (await this.all<any>(`SELECT * FROM users${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset)).map((u) => ({
      ...u,
      avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' },
      is_superuser: u.is_superuser === 1,
      is_orphaned: u.is_orphaned === 1,
      signup_ip: u.signup_ip ?? null,
    }));
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM users${where}`).bind(...params)))?.count);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async getThreadsPaginated(offset: number, limit: number, search?: string, filters?: ThreadFilters) {
    // The list contract intentionally excludes chat explorer preview/error data.
    const base = `SELECT
      t.id,
      t.title,
      t.model,
      t.workspace_id,
      t.created_at,
      t.updated_at,
      t.created_by,
      t.org_id,
      o.name AS org_name,
      w.name AS workspace_name
      FROM threads t
      LEFT JOIN orgs o ON t.org_id = o.id
      LEFT JOIN workspaces w ON t.workspace_id = w.id`;
    const countBase = 'SELECT COUNT(*) as count FROM threads t LEFT JOIN orgs o ON t.org_id = o.id LEFT JOIN workspaces w ON t.workspace_id = w.id';
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push('(t.id LIKE ? OR t.title LIKE ? OR t.model LIKE ? OR o.name LIKE ? OR w.name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (filters?.org_id) { conditions.push('t.org_id = ?'); params.push(filters.org_id); }
    if (filters?.workspace_id) { conditions.push('t.workspace_id = ?'); params.push(filters.workspace_id); }
    if (filters?.created_by) { conditions.push('t.created_by = ?'); params.push(filters.created_by); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = THREAD_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 't.updated_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const items = await this.all<AdminThreadListRow>(`${base}${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`${countBase}${where}`).bind(...params)))?.count);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async getChatExplorerThreads(
    offset: number,
    limit: number,
    search?: string,
    filters?: ChatExplorerFilters,
  ) {
    const base = `
      FROM threads t
      LEFT JOIN orgs o ON t.org_id = o.id
      LEFT JOIN workspaces w ON t.workspace_id = w.id
      LEFT JOIN users u ON t.created_by = u.id
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];
    const trimmedSearch = search?.trim();

    if (trimmedSearch) {
      const like = `%${trimmedSearch}%`;
      conditions.push('(u.email LIKE ? OR o.name LIKE ? OR t.title LIKE ?)');
      params.push(like, like, like);
    }
    if (filters?.plan) {
      conditions.push(`${CHAT_EXPLORER_ORG_PLAN_SQL} = ?`);
      params.push(filters.plan);
    }
    if (filters?.first_chats_only) {
      conditions.push(CHAT_EXPLORER_FIRST_THREAD_SQL);
    }
    if (filters?.automated_only) {
      conditions.push(CHAT_EXPLORER_AUTOMATED_THREAD_SQL);
    }
    if (filters?.exclude_internal) {
      for (const domain of normalizeInternalDomainList(undefined, ['camelai.com'])) {
        conditions.push('(u.email IS NULL OR u.email NOT LIKE ?)');
        params.push(`%@${domain}`);
      }
    }
    if (filters?.errors_only) {
      conditions.push('COALESCE(t.chat_error_count, 0) > 0');
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = CHAT_EXPLORER_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 't.updated_at';
    const rows = await this.all<any>(`
      SELECT
        t.id,
        t.title,
        t.model,
        t.org_id,
        t.workspace_id,
        t.created_at,
        t.updated_at,
        t.created_by,
        t.user_message_count,
        t.first_user_message,
        t.last_user_message_at,
        t.source,
        t.channel_kind,
        t.channel_kinds,
        t.chat_error_count,
        t.last_chat_error_at,
        t.last_chat_error_message,
        t.last_chat_error_source,
        t.last_chat_error_status,
        t.last_chat_error_provider,
        t.last_chat_error_model,
        t.model_history,
        t.last_model_changed_at,
        o.name AS org_name,
        o.billing_plan AS org_billing_plan,
        o.billing_status AS org_billing_status,
        ${CHAT_EXPLORER_ORG_PLAN_SQL} AS org_plan,
        w.name AS workspace_name,
        u.email AS user_email,
        u.name AS user_name,
        ${CHAT_EXPLORER_FIRST_THREAD_SQL} AS is_first_thread
      ${base}
      ${where}
      ORDER BY ${sortCol} DESC, t.id ASC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`
      SELECT COUNT(*) AS count
      ${base}
      ${where}
    `).bind(...params)))?.count);

    const items: AdminChatExplorerRow[] = rows.map((row) => ({
      id: row.id,
      title: row.title ?? null,
      model: row.model ?? null,
      org_id: row.org_id,
      workspace_id: row.workspace_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by ?? null,
      user_message_count: row.user_message_count ?? null,
      user_message_count_source: row.user_message_count === null || row.user_message_count === undefined ? 'unknown' : 'admin_index',
      user_message_count_capped: false,
      first_user_message: truncateThreadPreviewText(
        row.first_user_message,
        CHAT_EXPLORER_FIRST_USER_MESSAGE_PREVIEW_LENGTH,
      ),
      last_user_message_at: row.last_user_message_at ?? null,
      source: row.source ?? null,
      channel_kind: row.channel_kind ?? null,
      channel_kinds: row.channel_kinds ?? null,
      chat_error_count: toNumber(row.chat_error_count),
      last_chat_error_at: row.last_chat_error_at ?? null,
      last_chat_error_message: row.last_chat_error_message ?? null,
      last_chat_error_source: row.last_chat_error_source ?? null,
      last_chat_error_status: row.last_chat_error_status ?? null,
      last_chat_error_provider: row.last_chat_error_provider ?? null,
      last_chat_error_model: row.last_chat_error_model ?? null,
      model_history: row.model_history ?? null,
      last_model_changed_at: row.last_model_changed_at ?? null,
      org_name: row.org_name ?? null,
      org_billing_plan: row.org_billing_plan ?? null,
      org_billing_status: row.org_billing_status ?? null,
      org_plan: row.org_plan ?? 'payg',
      workspace_name: row.workspace_name ?? null,
      user_email: row.user_email ?? null,
      user_name: row.user_name ?? null,
      is_first_thread: toBoolean(row.is_first_thread),
    }));
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }

  async getChatErrorSummary(options: AdminChatErrorQueryOptions): Promise<AdminChatErrorSummary> {
    const startAt = Math.max(0, Math.floor(options.startAt));
    const endAt = Math.max(0, Math.floor(options.endAt));
    const filters = normalizeChatErrorFilters(options);
    const { whereSql, params } = buildChatErrorWhere({ startAt, endAt, filters });
    const row = await first<any>(
      this.db.prepare(`
        SELECT
          COUNT(*) AS total_events,
          COUNT(DISTINCT thread_id) AS affected_threads,
          COUNT(DISTINCT fingerprint) AS distinct_groups,
          MAX(created_at) AS latest_error_at
        FROM chat_error_events
        ${whereSql}
      `).bind(...params),
    );
    return {
      total_events: toNumber(row?.total_events),
      affected_threads: toNumber(row?.affected_threads),
      distinct_groups: toNumber(row?.distinct_groups),
      latest_error_at: row?.latest_error_at ?? null,
    };
  }

  async getChatErrorGroups(options: AdminChatErrorQueryOptions): Promise<AdminChatErrorGroupRow[]> {
    const startAt = Math.max(0, Math.floor(options.startAt));
    const endAt = Math.max(0, Math.floor(options.endAt));
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filters = normalizeChatErrorFilters(options);
    const { whereSql, params } = buildChatErrorWhere({ alias: 'e', startAt, endAt, filters });
    const sortBy = CHAT_ERROR_GROUP_SORT_COLS[options.sort_by ?? 'count'] ?? 'count';
    const sortDir = options.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`
      WITH filtered AS (
        SELECT e.*
        FROM chat_error_events e
        ${whereSql}
      )
      SELECT
        fingerprint,
        (
          SELECT message_sample
          FROM filtered sample
          WHERE sample.fingerprint = grouped.fingerprint
          ORDER BY sample.created_at DESC, sample.id DESC
          LIMIT 1
        ) AS message_sample,
        (
          SELECT source
          FROM filtered sample
          WHERE sample.fingerprint = grouped.fingerprint
          ORDER BY sample.created_at DESC, sample.id DESC
          LIMIT 1
        ) AS source,
        (
          SELECT error_kind
          FROM filtered sample
          WHERE sample.fingerprint = grouped.fingerprint
          ORDER BY sample.created_at DESC, sample.id DESC
          LIMIT 1
        ) AS error_kind,
        (
          SELECT status
          FROM filtered sample
          WHERE sample.fingerprint = grouped.fingerprint
          ORDER BY sample.created_at DESC, sample.id DESC
          LIMIT 1
        ) AS status,
        (
          SELECT provider
          FROM filtered sample
          WHERE sample.fingerprint = grouped.fingerprint
          ORDER BY sample.created_at DESC, sample.id DESC
          LIMIT 1
        ) AS provider,
        (
          SELECT model
          FROM filtered sample
          WHERE sample.fingerprint = grouped.fingerprint
          ORDER BY sample.created_at DESC, sample.id DESC
          LIMIT 1
        ) AS model,
        COUNT(*) AS count,
        COUNT(DISTINCT thread_id) AS affected_thread_count,
        MIN(created_at) AS first_seen_at,
        MAX(created_at) AS last_seen_at
      FROM filtered grouped
      GROUP BY fingerprint
      ORDER BY ${sortBy} ${sortDir}, count DESC, affected_thread_count DESC, last_seen_at DESC, fingerprint ASC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);

    return rows.map((row) => ({
      fingerprint: row.fingerprint,
      message_sample: row.message_sample ?? 'Unknown chat error',
      source: row.source ?? 'chat_event',
      error_kind: row.error_kind ?? null,
      status: row.status ?? null,
      provider: row.provider ?? null,
      model: row.model ?? null,
      count: toNumber(row.count),
      affected_thread_count: toNumber(row.affected_thread_count),
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
    }));
  }

  async getChatErrorThreads(options: AdminChatErrorQueryOptions): Promise<AdminChatErrorThreadRow[]> {
    const startAt = Math.max(0, Math.floor(options.startAt));
    const endAt = Math.max(0, Math.floor(options.endAt));
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filters = normalizeChatErrorFilters(options);
    const { whereSql, params } = buildChatErrorWhere({ alias: 'e', startAt, endAt, filters });
    const rows = await this.all<any>(`
      WITH filtered AS (
        SELECT e.*
        FROM chat_error_events e
        ${whereSql}
      ),
      grouped AS (
        SELECT
          e.thread_id,
          MAX(e.created_at) AS last_seen_at,
          COUNT(*) AS count,
          MAX(e.org_id) AS org_id,
          MAX(e.workspace_id) AS workspace_id,
          (
            SELECT latest.user_id
            FROM filtered latest
            WHERE latest.thread_id = e.thread_id
            ORDER BY latest.created_at DESC, latest.id DESC
            LIMIT 1
          ) AS latest_user_id
        FROM filtered e
        GROUP BY e.thread_id
      )
      SELECT
        grouped.thread_id,
        t.title,
        COALESCE(t.org_id, grouped.org_id) AS org_id,
        o.name AS org_name,
        COALESCE(t.workspace_id, grouped.workspace_id) AS workspace_id,
        w.name AS workspace_name,
        COALESCE(t.created_by, grouped.latest_user_id) AS user_id,
        u.email AS user_email,
        grouped.last_seen_at,
        grouped.count
      FROM grouped
      LEFT JOIN threads t ON grouped.thread_id = t.id
      LEFT JOIN orgs o ON o.id = COALESCE(t.org_id, grouped.org_id)
      LEFT JOIN workspaces w ON w.id = COALESCE(t.workspace_id, grouped.workspace_id)
      LEFT JOIN users u ON u.id = COALESCE(t.created_by, grouped.latest_user_id)
      ORDER BY grouped.last_seen_at DESC, grouped.count DESC, grouped.thread_id ASC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);

    return rows.map((row) => ({
      thread_id: row.thread_id,
      title: row.title ?? null,
      org_id: row.org_id,
      org_name: row.org_name ?? null,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name ?? null,
      user_id: row.user_id ?? null,
      user_email: row.user_email ?? null,
      last_seen_at: row.last_seen_at,
      count: toNumber(row.count),
    }));
  }

  async getChatErrorBreakdowns(options: AdminChatErrorQueryOptions): Promise<AdminChatErrorBreakdowns> {
    const startAt = Math.max(0, Math.floor(options.startAt));
    const endAt = Math.max(0, Math.floor(options.endAt));
    const filters = normalizeChatErrorFilters(options);
    const breakdown = async (
      column: 'source' | 'error_kind' | 'status' | 'provider' | 'model',
    ): Promise<AdminChatErrorBreakdownRow[]> => {
      const { whereSql, params } = buildChatErrorWhere({ alias: 'e', startAt, endAt, filters });
      const rows = await this.all<any>(`
        SELECT
          e.${column} AS value,
          COUNT(*) AS count,
          COUNT(DISTINCT e.thread_id) AS affected_thread_count,
          MAX(e.created_at) AS latest_error_at
        FROM chat_error_events e
        ${whereSql}
        GROUP BY e.${column}
        ORDER BY count DESC, affected_thread_count DESC, latest_error_at DESC
        LIMIT 200
      `, ...params);
      return rows.map((row) => ({
        value: row.value ?? null,
        count: toNumber(row.count),
        affected_thread_count: toNumber(row.affected_thread_count),
        latest_error_at: row.latest_error_at ?? null,
      }));
    };

    const [source, error_kind, status, provider, model] = await Promise.all([
      breakdown('source'),
      breakdown('error_kind'),
      breakdown('status'),
      breakdown('provider'),
      breakdown('model'),
    ]);
    return { source, error_kind, status, provider, model };
  }

  async getChatErrorEvents(options: AdminChatErrorQueryOptions): Promise<AdminChatErrorEventRow[]> {
    const startAt = Math.max(0, Math.floor(options.startAt));
    const endAt = Math.max(0, Math.floor(options.endAt));
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filters = normalizeChatErrorFilters(options);
    const { whereSql, params } = buildChatErrorWhere({ alias: 'e', startAt, endAt, filters });
    const rows = await this.all<any>(`
      SELECT
        e.id,
        e.fingerprint,
        e.thread_id,
        t.title,
        COALESCE(t.org_id, e.org_id) AS org_id,
        o.name AS org_name,
        COALESCE(t.workspace_id, e.workspace_id) AS workspace_id,
        w.name AS workspace_name,
        e.user_id,
        u.email AS user_email,
        e.created_at,
        e.source,
        e.error_kind,
        e.status,
        e.provider,
        e.model,
        e.message_sample,
        e.message_normalized
      FROM chat_error_events e
      LEFT JOIN threads t ON t.id = e.thread_id
      LEFT JOIN orgs o ON o.id = COALESCE(t.org_id, e.org_id)
      LEFT JOIN workspaces w ON w.id = COALESCE(t.workspace_id, e.workspace_id)
      LEFT JOIN users u ON u.id = e.user_id
      ${whereSql}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);

    return rows.map((row) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      thread_id: row.thread_id,
      title: row.title ?? null,
      org_id: row.org_id,
      org_name: row.org_name ?? null,
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name ?? null,
      user_id: row.user_id ?? null,
      user_email: row.user_email ?? null,
      created_at: row.created_at,
      source: row.source,
      error_kind: row.error_kind ?? null,
      status: row.status ?? null,
      provider: row.provider ?? null,
      model: row.model ?? null,
      message_sample: row.message_sample,
      message_normalized: row.message_normalized,
    }));
  }

  async getOrgsPaginated(offset: number, limit: number, search?: string, filters?: OrgFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) { conditions.push('name LIKE ?'); params.push(`%${search}%`); }
    if (filters?.archived !== undefined) { conditions.push('archived = ?'); params.push(filters.archived ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = ORG_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`SELECT * FROM orgs${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM orgs${where}`).bind(...params)))?.count);
    return { items: rows.map((o) => ({ ...o, archived: o.archived === 1 })), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getOrgDirectoryRows(): Promise<any[]> {
    return this.getOrgDirectoryRowsInternal();
  }

  private async getOrgDirectoryRowsInternal(filters: OrgDirectoryFilters = {}): Promise<any[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    applyOrgDirectoryFilters(conditions, params, filters);
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.all<any>(`
      SELECT o.id, o.name, o.slug, o.created_at, o.archived, o.billing_status, o.created_by,
             CASE
               WHEN COALESCE(m.indexed_member_count, 0) > COALESCE(o.member_count, 0)
                 THEN m.indexed_member_count
               ELSE COALESCE(o.member_count, 0)
             END AS member_count,
             o.workspace_count, u.email as creator_email, u.name as creator_name
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      ${where}
    `, ...params);
    return rows.map(normalizeOrgDirectoryRow);
  }

  async getOrgDirectoryPaginated(offset: number, limit: number, search?: string, filters: OrgDirectoryFilters = {}) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) { conditions.push('(o.name LIKE ? OR o.slug LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    applyOrgDirectoryFilters(conditions, params, filters);
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = ORG_DIRECTORY_SORT_COLS[filters.sort_by ?? 'created_at'] ?? 'o.created_at';
    const sortDir = filters.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`
      SELECT o.id, o.name, o.slug, o.created_at, o.archived, o.billing_status, o.created_by,
             CASE
               WHEN COALESCE(m.indexed_member_count, 0) > COALESCE(o.member_count, 0)
                 THEN m.indexed_member_count
               ELSE COALESCE(o.member_count, 0)
             END AS member_count,
             o.workspace_count, u.email as creator_email, u.name as creator_name
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      ${where}
    `).bind(...params)))?.count);
    return { items: rows.map(normalizeOrgDirectoryRow), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getOrgLlmProviderDirectoryPaginated(offset: number, limit: number, search?: string, provider?: string) {
    return this.getOrgDirectoryPaginated(offset, limit, search, {
      has_llm_provider: true,
      llm_provider: provider?.trim() || undefined,
    });
  }

  async getWorkspacesPaginated(offset: number, limit: number, search?: string, filters?: WorkspaceFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) { conditions.push('(w.name LIKE ? OR o.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    if (filters?.org_id) { conditions.push('w.org_id = ?'); params.push(filters.org_id); }
    if (filters?.archived !== undefined) { conditions.push('w.archived = ?'); params.push(filters.archived ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = WORKSPACE_SORT_COLS[filters?.sort_by ?? 'created_at'] ?? 'w.created_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`SELECT w.*, o.name as org_name FROM workspaces w LEFT JOIN orgs o ON w.org_id = o.id${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM workspaces w LEFT JOIN orgs o ON w.org_id = o.id${where}`).bind(...params)))?.count);
    return { items: rows.map(normalizeWorkspaceRow), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getWorkspaceOrgId(workspaceId: string): Promise<string | null> {
    const row = await first<{ org_id: string }>(
      this.db.prepare('SELECT org_id FROM workspaces WHERE id = ?').bind(workspaceId),
    );
    return row?.org_id ?? null;
  }

  async getAppsPaginated(offset: number, limit: number, search?: string, filters?: AppFilters) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (search) {
      conditions.push('(a.script_name LIKE ? OR o.name LIKE ? OR w.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (filters?.org_id) { conditions.push('a.org_id = ?'); params.push(filters.org_id); }
    if (filters?.workspace_id) { conditions.push('a.workspace_id = ?'); params.push(filters.workspace_id); }
    if (filters?.is_public !== undefined) { conditions.push('a.is_public = ?'); params.push(filters.is_public ? 1 : 0); }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sortCol = APP_SORT_COLS[filters?.sort_by ?? 'updated_at'] ?? 'a.updated_at';
    const sortDir = filters?.sort_dir === 'asc' ? 'ASC' : 'DESC';
    const rows = await this.all<any>(`
      SELECT a.*, o.name as org_name, o.slug as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email
      FROM apps a
      LEFT JOIN orgs o ON a.org_id = o.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      LEFT JOIN users u ON a.created_by = u.id
      ${where}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`SELECT COUNT(*) AS count FROM apps a LEFT JOIN orgs o ON a.org_id = o.id LEFT JOIN workspaces w ON a.workspace_id = w.id LEFT JOIN users u ON a.created_by = u.id${where}`).bind(...params)))?.count);
    return { items: rows.map((row) => ({ ...row, is_public: row.is_public === 1 })), total, offset, limit, hasMore: offset + rows.length < total };
  }

  async getOrgById(orgId: string) {
    const row = await first<any>(this.db.prepare('SELECT * FROM orgs WHERE id = ? LIMIT 1').bind(orgId));
    return row ? { ...row, archived: row.archived === 1 } : null;
  }

  async getThreadContextById(threadId: string) {
    return first<AdminThreadListRow>(
      this.db.prepare(`
        SELECT t.*, o.name as org_name, w.name as workspace_name
        FROM threads t
        LEFT JOIN orgs o ON t.org_id = o.id
        LEFT JOIN workspaces w ON t.workspace_id = w.id
        WHERE t.id = ?
        LIMIT 1
      `).bind(threadId),
    );
  }

  async getUsersByOrgIds(orgIds: string[]): Promise<AdminUserSummaryRow[]> {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    const rows = await this.all<any>(`
      SELECT DISTINCT u.*
      FROM users u
      INNER JOIN org_memberships m ON m.user_id = u.id
      WHERE m.org_id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedOrgIds));
    return rows.map((u) => ({ ...u, avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' }, is_superuser: u.is_superuser === 1, is_orphaned: u.is_orphaned === 1, signup_ip: u.signup_ip ?? null }));
  }

  async getUsersByIds(userIds: string[]): Promise<AdminUserSummaryRow[]> {
    const normalizedUserIds = Array.from(
      new Set(userIds.map((userId) => userId.trim()).filter((userId) => userId.length > 0)),
    );
    if (normalizedUserIds.length === 0) return [];
    const rows = await this.all<any>(`
      SELECT u.*
      FROM users u
      WHERE u.id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedUserIds));
    return rows.map((u) => ({ ...u, avatar: { color: u.avatar_color || '#666', content: u.avatar_content || 'U' }, is_superuser: u.is_superuser === 1, is_orphaned: u.is_orphaned === 1, signup_ip: u.signup_ip ?? null }));
  }

  // -------------------------------------------------------------------------
  // Mirror reads for the product fan-out call sites (phase 2, flag-gated in
  // src/lib/d1-read-shadow.server.ts). Never used for auth decisions.
  // -------------------------------------------------------------------------

  /** Org names and archive state by id (replaces one OrgDO.getInfo per org). */
  async getMirroredOrgSummaries(orgIds: string[]): Promise<Array<{ id: string; name: string; archived: boolean }>> {
    const ids = Array.from(new Set(orgIds.filter(Boolean)));
    if (ids.length === 0) return [];
    const rows = await this.all<{ id: string; name: string; archived: number }>(
      'SELECT id, name, archived FROM orgs WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(ids),
    );
    return rows.map((row) => ({ id: row.id, name: row.name, archived: row.archived === 1 }));
  }

  /** Full user profiles by id (replaces one UserDO.getProfile per member). */
  async getMirroredUserProfiles(userIds: string[]): Promise<MirroredUserProfile[]> {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    if (ids.length === 0) return [];
    const rows = await this.all<any>(
      `SELECT id, email, email_verified_at, name, created_at, is_superuser, avatar_color, avatar_content, is_orphaned, orphaned_at
         FROM users
        WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(ids),
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      email_verified_at: row.email_verified_at ?? null,
      name: row.name ?? null,
      created_at: row.created_at,
      is_superuser: row.is_superuser === 1,
      avatar: { color: row.avatar_color ?? '', content: row.avatar_content ?? '' },
      is_orphaned: row.is_orphaned === 1,
      orphaned_at: row.orphaned_at ?? null,
    }));
  }

  /** A page of threads, ordered like OrgDO.getThreadsPaginated (no search). */
  async getMirroredThreadPage(input: {
    workspaceIds: string[];
    createdBy?: string;
    offset: number;
    limit: number;
  }): Promise<{ items: MirroredThreadRow[]; total: number }> {
    const where = ['workspace_id IN (SELECT value FROM json_each(?))'];
    const binds: unknown[] = [JSON.stringify(input.workspaceIds)];
    if (input.createdBy) {
      where.push('created_by = ?');
      binds.push(input.createdBy);
    }
    const whereSql = where.join(' AND ');
    const [items, totalRow] = await Promise.all([
      this.all<MirroredThreadRow>(
        `SELECT ${MIRRORED_THREAD_COLUMNS} FROM threads WHERE ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
        ...binds,
        input.limit,
        input.offset,
      ),
      this.all<{ count: number }>(`SELECT COUNT(*) AS count FROM threads WHERE ${whereSql}`, ...binds),
    ]);
    return { items, total: Number(totalRow[0]?.count ?? 0) };
  }

  async getMirroredThreadsByIds(workspaceId: string, threadIds: string[]): Promise<MirroredThreadRow[]> {
    const ids = Array.from(new Set(threadIds.filter(Boolean)));
    if (ids.length === 0) return [];
    return this.all<MirroredThreadRow>(
      `SELECT ${MIRRORED_THREAD_COLUMNS} FROM threads
        WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))`,
      workspaceId,
      JSON.stringify(ids),
    );
  }

  async getThreadsByOrgIds(orgIds: string[]): Promise<AdminThreadListRow[]> {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    return this.all<AdminThreadListRow>(`
      SELECT t.*, o.name as org_name, w.name as workspace_name
      FROM threads t
      LEFT JOIN orgs o ON t.org_id = o.id
      LEFT JOIN workspaces w ON t.workspace_id = w.id
      WHERE t.org_id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedOrgIds));
  }

  async getAppsByOrgIds(orgIds: string[]): Promise<AdminAppListRow[]> {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    return this.all<any>(`
      SELECT a.*, o.name as org_name, o.slug as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email
      FROM apps a
      LEFT JOIN orgs o ON a.org_id = o.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.org_id IN (SELECT value FROM json_each(?))
    `, JSON.stringify(normalizedOrgIds)).then((rows) => rows.map((row) => ({ ...row, is_public: row.is_public === 1 })));
  }

  async getOrgDirectoryByIds(orgIds: string[]) {
    const normalizedOrgIds = Array.from(
      new Set(orgIds.map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0)),
    );
    if (normalizedOrgIds.length === 0) return [];
    const rows = await this.all<any>(`
      SELECT o.id, o.name, o.slug, o.created_at, o.archived, o.billing_status, o.created_by,
             CASE
               WHEN COALESCE(m.indexed_member_count, 0) > COALESCE(o.member_count, 0)
                 THEN m.indexed_member_count
               ELSE COALESCE(o.member_count, 0)
             END AS member_count,
             o.workspace_count, u.email as creator_email, u.name as creator_name
      FROM orgs o
      LEFT JOIN users u ON o.created_by = u.id
      LEFT JOIN (
        SELECT org_id, COUNT(*) AS indexed_member_count
        FROM org_memberships
        GROUP BY org_id
      ) m ON m.org_id = o.id
      WHERE o.id IN (SELECT value FROM json_each(?))
      ORDER BY o.created_at DESC, o.id ASC
    `, JSON.stringify(normalizedOrgIds));
    return rows.map(normalizeOrgDirectoryRow);
  }

  async getOrgRecentThreads(orgId: string, limit = 10) {
    const resolvedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.all<AdminThreadListRow>(`
      SELECT t.*, o.name as org_name, w.name as workspace_name
      FROM threads t
      LEFT JOIN orgs o ON t.org_id = o.id
      LEFT JOIN workspaces w ON t.workspace_id = w.id
      WHERE t.org_id = ?
      ORDER BY t.updated_at DESC
      LIMIT ?
    `, orgId, resolvedLimit);
  }

  async getOrgRecentApps(orgId: string, limit = 10) {
    const resolvedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.all<any>(`
      SELECT a.*, o.name as org_name, o.slug as org_slug, w.name as workspace_name, u.name as created_by_name, u.email as created_by_email
      FROM apps a
      LEFT JOIN orgs o ON a.org_id = o.id
      LEFT JOIN workspaces w ON a.workspace_id = w.id
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.org_id = ?
      ORDER BY a.updated_at DESC
      LIMIT ?
    `, orgId, resolvedLimit);
    return rows.map((row) => ({ ...row, is_public: row.is_public === 1 }));
  }

  async getOrgThreadCount(orgId: string) {
    return toNumber((await first<{ count: number }>(
      this.db.prepare('SELECT COUNT(*) AS count FROM threads WHERE org_id = ?').bind(orgId),
    ))?.count);
  }

  async getOrgAppCount(orgId: string) {
    return toNumber((await first<{ count: number }>(
      this.db.prepare('SELECT COUNT(*) AS count FROM apps WHERE org_id = ?').bind(orgId),
    ))?.count);
  }

  async getOrgRecentActivity(
    orgId: string,
    threadLimit = 10,
    appLimit = 10,
    includeCounts = true,
  ) {
    const [threads, apps, threadCount, appCount] = await Promise.all([
      this.getOrgRecentThreads(orgId, threadLimit),
      this.getOrgRecentApps(orgId, appLimit),
      includeCounts ? this.getOrgThreadCount(orgId) : Promise.resolve(null),
      includeCounts ? this.getOrgAppCount(orgId) : Promise.resolve(null),
    ]);

    return {
      threads,
      apps,
      threadCount,
      appCount,
    };
  }

  async getInvitationsPaginated(offset: number, limit: number, search?: string) {
    const now = Date.now();
    const conditions = ['i.expires_at > ?'];
    const params: unknown[] = [now];
    if (search) {
      conditions.push('(i.email LIKE ? OR o.name LIKE ? OR u.name LIKE ? OR u.email LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const where = ` WHERE ${conditions.join(' AND ')}`;
    const items = await this.all<any>(`
      SELECT i.*, o.name as org_name, u.name as invited_by_name, u.email as invited_by_email
      FROM invitations i
      LEFT JOIN orgs o ON i.org_id = o.id
      LEFT JOIN users u ON i.invited_by = u.id
      ${where}
      ORDER BY i.created_at DESC
      LIMIT ? OFFSET ?
    `, ...params, limit, offset);
    const total = toNumber((await first<{ count: number }>(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM invitations i
      LEFT JOIN orgs o ON i.org_id = o.id
      LEFT JOIN users u ON i.invited_by = u.id
      ${where}
    `).bind(...params)))?.count);
    return { items, total, offset, limit, hasMore: offset + items.length < total };
  }
}

export function getAppIndexDatabase(env: AppIndexEnv): AppIndexDatabase | null {
  return env.APP_DB ? new AppIndexDatabase(env.APP_DB, env) : null;
}

export function getAppIndexReadDatabase(env: AppIndexEnv): AppIndexDatabase | null {
  return env.APP_DB ? new AppIndexDatabase(env.APP_DB.withSession('first-primary'), env) : null;
}
