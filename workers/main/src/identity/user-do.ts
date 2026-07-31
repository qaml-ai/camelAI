import { DurableObject } from "cloudflare:workers";
import type { DOEnv } from "./env";
import { hashPassword, verifyPassword } from "../password";
import {
  DEFAULT_CHAT_GROUP_EMOJI,
  generateDefaultAvatar,
  generateDefaultChatGroupAvatar,
  normalizeAvatarColor,
  normalizeChatGroupAvatar,
  validateAvatarContent,
} from "../../../../src/lib/avatar";
import {
  DEFAULT_CHAT_GROUP_ICON,
  normalizeChatGroupIconName,
} from "../../../../src/lib/chat-group-icons";
import { isPlaceholderThreadTitle } from "../../../../src/lib/thread-title";
import type {
  OrgRole,
  BillingStatus,
  User,
  Organization,
  LlmModel,
  OnboardingPreferences,
  ChatGroup,
  ChatGroupAvatar,
  ChatGroupAvatarStatus,
  ChatGroupSummary,
  ThreadCompletionSummaryStatus,
  Avatar,
} from "../../../../src/types";
import { dispatchAdminEvent } from "./admin-events";
import { getDefaultOnboardingPreferences, sanitizeOnboardingPreferences, toOnboardingPreferences } from "./onboarding";
import { isSuperuserEmail, parseSuperuserEmails } from "./superuser";
import { recordObservabilityEvent } from "../observability";

// Re-export for consumers that import from this module
export type { OrgRole, BillingStatus } from "../../../../src/types";

const USER_ONBOARDING_KEY = "onboarding";
const USER_SIGNUP_IP_KEY = "signup_ip";
const USER_NEW_CAMEL_ACTIVATION_KEY = "new_camel_activation";
const CHAT_GROUP_ICON_GENERATION_LEASE_MS = 2 * 60 * 1000;
const CHAT_GROUP_ICON_MAX_CONCURRENCY = 3;

type ChatGroupIconGenerationState =
  | "idle"
  | "queued"
  | "generating"
  | "failed";

export interface ChatGroupIconGenerationClaim {
  id: string;
  name: string;
  avatar: ChatGroupAvatar;
  claimId: string;
  claimedAt: number;
  trigger: "first_title" | "legacy_migration";
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

export interface NewCamelActivationClaim {
  eventId: string;
  activatedAt: number;
  isFirst: boolean;
}

export type OAuthProvider =
  | "google"
  | "github"
  | "cloudflare_access"
  | "pomerium";

export interface UserOAuthProvider {
  provider: OAuthProvider;
  provider_id: string;
  linked_at: number;
}

export function canCreateEnterpriseSsoUser(
  email: string,
  allowlist?: Set<string> | string | null,
): boolean {
  // With an empty/missing allowlist, enterprise SSO may create the user as a
  // normal member. Only configured bootstrap superuser emails are refused.
  return !isSuperuserEmail(email, allowlist);
}

export interface OrgMember {
  user_id: string;
  role: OrgRole;
  joined_at: number;
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
  custom_domain_hostname: string | null;
  custom_domain_cf_hostname_id: string | null;
  custom_domain_status: string | null;
  custom_domain_ssl_status: string | null;
  custom_domain_error: string | null;
  custom_domain_updated_at: number | null;
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

export interface WorkerScriptCustomDomainUpdateInput {
  hostname: string | null;
  cf_hostname_id?: string | null;
  status?: string | null;
  ssl_status?: string | null;
  error?: string | null;
  updated_at?: number;
  deploy_ts?: number;
}

export interface WorkerScriptAccess {
  script_name: string;
  workspace_id: string;
  org_id: string;
  is_public: boolean;
}

export type CustomDomainStatus = "pending" | "active" | "failed";

export interface CustomDomain {
  domain: string;
  cf_hostname_id: string | null;
  status: CustomDomainStatus;
  ssl_status: string | null;
  created_at: number;
  updated_at: number;
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
}

export interface CreateThreadOptions {
  source?: "web" | "channel" | string | null;
  channelKind?: string | null;
  channelConnectionId?: string | null;
  channelConversationId?: string | null;
  channelMessageId?: string | null;
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
  reported_cost_usd?: number | null;
  upstream_inference_cost_usd?: number | null;
  duration_ms?: number | null;
  created_at_ms?: number | null;
  source?: string | null;
  source_id?: string | null;
}

export interface UsageLogQuery {
  limit?: number | null;
  cursor?: string | null;
  from?: number | null;
  to?: number | null;
  chargeable_only?: boolean | number | null;
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
}

export interface ApplyCreditCheckoutResult {
  org: Organization;
  applied: boolean;
}

export interface ApplyManualCreditGrantResult {
  org: Organization;
  applied: boolean;
  grantId: string;
  amountCents: number;
  reason: string | null;
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
export class UserDO extends DurableObject<DOEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: DOEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private getSchemaVersionValue(): number {
    const storedVersion = this.ctx.storage.kv.get<number>("schemaVersion");
    if (typeof storedVersion === "number") {
      return storedVersion;
    }

    try {
      const rows = this.sql
        .exec<{
          version: number;
        }>("SELECT MAX(version) AS version FROM _schema_version")
        .toArray();
      return rows[0]?.version ?? 0;
    } catch {
      return 0;
    }
  }

  private migrate() {
    // Read version from sync KV, falling back to legacy SQL table for existing DOs.
    const version = this.getSchemaVersionValue();

    if (version < 1) {
      // V1: Fresh start
      this.sql.exec("DROP TABLE IF EXISTS profile");
      this.sql.exec("DROP TABLE IF EXISTS orgs");
      this.sql.exec("DROP TABLE IF EXISTS projects");
      this.sql.exec(`
        CREATE TABLE profile (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE orgs (
          org_id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          joined_at INTEGER NOT NULL,
          last_workspace_id TEXT
        )
      `);
      this.sql.exec(`
        CREATE TABLE projects (
          org_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (org_id, project_id)
        )
      `);
    }

    if (version < 2) {
      const rows = this.sql
        .exec("SELECT value FROM profile WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const profile = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as User;
        const shouldBeSuperuser = isSuperuserEmail(
          profile.email,
          this.superuserAllowlist(),
        );
        if (profile.is_superuser !== shouldBeSuperuser) {
          profile.is_superuser = shouldBeSuperuser;
          this.sql.exec(
            "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
            "data",
            JSON.stringify(profile),
          );
        }
      }
    }

    if (version < 3) {
      // V3: Remove projects table - projects feature removed
      this.sql.exec("DROP TABLE IF EXISTS projects");
    }

    if (version < 4) {
      const rows = this.sql
        .exec("SELECT value FROM profile WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const profile = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as User;
        if (!profile.avatar) {
          profile.avatar = generateDefaultAvatar(profile.name || profile.email);
        }
        if (typeof profile.is_orphaned !== "boolean")
          profile.is_orphaned = false;
        if (profile.orphaned_at === undefined) profile.orphaned_at = null;
        this.sql.exec(
          "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
          "data",
          JSON.stringify(profile),
        );
      }
    }

    if (version < 5) {
      try {
        this.sql.exec("ALTER TABLE orgs ADD COLUMN last_workspace_id TEXT");
      } catch {
        // Column may already exist in fresh databases.
      }
    }

    if (version < 6) {
      // V6: Add oauth_providers table for OAuth sign-in support
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS oauth_providers (
          provider TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (provider)
        )
      `);
    }

    // V7: Reserve profile keys for onboarding state. No schema changes needed.

    if (version < 8) {
      // V8: Track email verification status on profiles.
      const rows = this.sql
        .exec("SELECT value FROM profile WHERE key = ?", "data")
        .toArray();
      if (rows.length > 0) {
        const profile = JSON.parse(
          (rows[0] as { value: string }).value,
        ) as User;
        if (profile.email_verified_at === undefined) {
          // Backfill legacy accounts as verified so this remains non-breaking.
          profile.email_verified_at = profile.created_at ?? Date.now();
          this.sql.exec(
            "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
            "data",
            JSON.stringify(profile),
          );
        }
      }
    }

    if (version < 9) {
      // V9: Per-user chat groups and per-thread viewed timestamps.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS chat_groups (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          last_active_thread_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS chat_groups_workspace ON chat_groups(org_id, workspace_id, updated_at DESC)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS chat_group_members (
          group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL,
          is_open INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          closed_at INTEGER,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (group_id, thread_id)
        )
      `);
      this.sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS chat_group_members_thread ON chat_group_members(thread_id)",
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS chat_group_members_open ON chat_group_members(group_id, is_open, position)",
      );
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS chat_thread_views (
          thread_id TEXT PRIMARY KEY,
          viewed_at INTEGER NOT NULL
        )
      `);
    }

    if (version < 10) {
      // V10: Per-user chat group color + emoji avatars.
      try {
        this.sql.exec(
          "ALTER TABLE chat_groups ADD COLUMN avatar_color TEXT NOT NULL DEFAULT '#3B82F6'",
        );
      } catch {
        // Column may already exist in fresh databases.
      }
      try {
        this.sql.exec(
          `ALTER TABLE chat_groups ADD COLUMN avatar_content TEXT NOT NULL DEFAULT '${DEFAULT_CHAT_GROUP_EMOJI}'`,
        );
      } catch {
        // Column may already exist in fresh databases.
      }
      try {
        this.sql.exec(
          "ALTER TABLE chat_groups ADD COLUMN avatar_content_source TEXT NOT NULL DEFAULT 'default'",
        );
      } catch {
        // Column may already exist in fresh databases.
      }
      try {
        this.sql.exec(
          "ALTER TABLE chat_groups ADD COLUMN avatar_emoji_last_attempt_at INTEGER",
        );
      } catch {
        // Column may already exist in fresh databases.
      }

      const rows = this.sql
        .exec<{
          id: string;
          org_id: string;
          workspace_id: string;
          created_at: number;
        }>(
          `SELECT id, org_id, workspace_id, created_at
           FROM chat_groups
           ORDER BY org_id ASC, workspace_id ASC, created_at ASC, id ASC`,
        )
        .toArray();
      const counters = new Map<string, number>();
      for (const row of rows) {
        const key = `${row.org_id}:${row.workspace_id}`;
        const count = counters.get(key) ?? 0;
        counters.set(key, count + 1);
        const avatar = generateDefaultChatGroupAvatar({ groupIndex: count });
        this.sql.exec(
          `UPDATE chat_groups
           SET avatar_color = ?,
               avatar_content = ?,
               avatar_content_source = 'default'
           WHERE id = ?`,
          avatar.color,
          avatar.content,
          row.id,
        );
      }
    }

    if (version < 11) {
      // V11: Durable, claim-fenced Lucide avatar generation. Provenance stays
      // in avatar_content_source; these columns describe pending work only.
      try {
        this.sql.exec(
          "ALTER TABLE chat_groups ADD COLUMN avatar_icon_generation_state TEXT NOT NULL DEFAULT 'idle'",
        );
      } catch {
        // Column may already exist after a partially completed migration.
      }
      try {
        this.sql.exec(
          "ALTER TABLE chat_groups ADD COLUMN avatar_icon_generation_claim_id TEXT",
        );
      } catch {
        // Column may already exist after a partially completed migration.
      }
      try {
        this.sql.exec(
          "ALTER TABLE chat_groups ADD COLUMN avatar_icon_generation_claimed_at INTEGER",
        );
      } catch {
        // Column may already exist after a partially completed migration.
      }

      const rows = this.sql
        .exec<{
          id: string;
          name: string;
          avatar_content: string | null;
          avatar_icon_generation_state: ChatGroupIconGenerationState;
        }>(
          `SELECT id, name, avatar_content, avatar_icon_generation_state
           FROM chat_groups`,
        )
        .toArray();
      let queuedCount = 0;
      for (const row of rows) {
        const normalizedContent = normalizeChatGroupIconName(row.avatar_content);
        if (normalizedContent) {
          // A fresh V10 row has just received the generation columns with their
          // idle/null defaults. On a V11 retry, however, this may be a legacy
          // row already converted to messages-square + queued before the
          // schema-version write was interrupted. Preserve that durable work
          // state and only canonicalize the valid icon value.
          this.sql.exec(
            `UPDATE chat_groups
             SET avatar_content = ?
             WHERE id = ?`,
            normalizedContent,
            row.id,
          );
          if (row.avatar_icon_generation_state === "queued") queuedCount += 1;
          continue;
        }

        const state: ChatGroupIconGenerationState = isPlaceholderThreadTitle(
          row.name,
        )
          ? "idle"
          : "queued";
        if (state === "queued") queuedCount += 1;
        this.sql.exec(
          `UPDATE chat_groups
           SET avatar_content = ?,
               avatar_content_source = 'default',
               avatar_icon_generation_state = ?,
               avatar_icon_generation_claim_id = NULL,
               avatar_icon_generation_claimed_at = NULL
           WHERE id = ?`,
          DEFAULT_CHAT_GROUP_ICON,
          state,
          row.id,
        );
      }

      recordObservabilityEvent(this.env, {
        event: "chat_group_icon_generation",
        component: "UserDO",
        operation: "legacy_migration",
        status: "queued",
        count: queuedCount,
      });
    }

    if (version < 12) {
      // V12: Per-user chat group pinning.
      try {
        this.sql.exec("ALTER TABLE chat_groups ADD COLUMN pinned_at INTEGER");
      } catch {
        // Column may already exist after a partially completed migration.
      }
    }

    const CURRENT_SCHEMA_VERSION = 12;
    if (version < CURRENT_SCHEMA_VERSION) {
      this.ctx.storage.kv.put("schemaVersion", CURRENT_SCHEMA_VERSION);
    }
  }

  private superuserAllowlist(): Set<string> {
    return parseSuperuserEmails(
      (this.env as { SUPERUSER_EMAILS?: string }).SUPERUSER_EMAILS,
    );
  }

  // Profile methods
  async getProfile(): Promise<User | null> {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", "data")
      .toArray();
    if (rows.length === 0) return null;
    const profile = JSON.parse((rows[0] as { value: string }).value) as User;
    let changed = false;

    if (typeof profile.is_superuser !== "boolean") {
      profile.is_superuser = isSuperuserEmail(
        profile.email,
        this.superuserAllowlist(),
      );
      changed = true;
    }
    if (!profile.avatar) {
      profile.avatar = generateDefaultAvatar(profile.name || profile.email);
      changed = true;
    }
    if (typeof profile.is_orphaned !== "boolean") {
      profile.is_orphaned = false;
      changed = true;
    }
    if (profile.orphaned_at === undefined) {
      profile.orphaned_at = null;
      changed = true;
    }
    if (profile.email_verified_at === undefined) {
      // Legacy accounts pre-date verification and are treated as verified.
      profile.email_verified_at = profile.created_at ?? Date.now();
      changed = true;
    }

    if (changed) {
      await this.setProfile(profile);
    }
    return profile;
  }

  async getAuthBootstrap(): Promise<UserAuthBootstrap> {
    const [profile, onboarding, orgs, passwordHash] = await Promise.all([
      this.getProfile(),
      this.getOnboarding(),
      this.getOrgs(),
      this.getPasswordHash(),
    ]);
    const emailVerification = {
      required: Boolean(passwordHash),
      verified: profile?.email_verified_at != null,
    };
    const sessionInvalidatedAt =
      this.ctx.storage.kv.get<number>("sessionInvalidatedAt") ?? null;
    return {
      profile,
      onboarding,
      orgs,
      emailVerification,
      sessionInvalidatedAt,
    };
  }

  /**
   * Invalidate all outstanding signed sessions for this user.
   * Any session created before this timestamp will be rejected.
   */
  invalidateSessions(): void {
    this.ctx.storage.kv.put("sessionInvalidatedAt", Date.now());
  }

  /**
   * Get the session invalidation timestamp. Returns null if never invalidated.
   */
  getSessionInvalidatedAt(): number | null {
    return this.ctx.storage.kv.get<number>("sessionInvalidatedAt") ?? null;
  }

  setPendingSalesPrompt(prompt: string): void {
    this.ctx.storage.kv.put("pendingSalesPrompt", prompt);
  }

  getPendingSalesPrompt(): string | null {
    return this.ctx.storage.kv.get<string>("pendingSalesPrompt") ?? null;
  }

  clearPendingSalesPrompt(): void {
    this.ctx.storage.kv.delete("pendingSalesPrompt");
  }

  consumePendingSalesPrompt(): string | null {
    const prompt = this.getPendingSalesPrompt();
    if (prompt !== null) {
      this.clearPendingSalesPrompt();
    }
    return prompt;
  }

  async setProfile(profile: User): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      "data",
      JSON.stringify(profile),
    );
    dispatchAdminEvent(this.ctx, this.env, {
      type: "user_upsert",
      payload: profile,
    });
  }

  async getPasswordHash(): Promise<string | null> {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", "password_hash")
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { value: string }).value;
  }

  async setPasswordHash(hash: string): Promise<void> {
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      "password_hash",
      hash,
    );
  }

  async verifyPassword(password: string): Promise<boolean> {
    const hash = await this.getPasswordHash();
    if (!hash) return false;
    return verifyPassword(password, hash);
  }

  getSignupIp(): string | null {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", USER_SIGNUP_IP_KEY)
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { value: string }).value;
  }

  setSignupIp(ip: string): void {
    const normalizedIp = ip.trim().toLowerCase();
    if (!normalizedIp) return;
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      USER_SIGNUP_IP_KEY,
      normalizedIp,
    );
  }

  async createUser(
    id: string,
    email: string,
    password: string,
    name: string | null,
    signupIp: string | null = null,
  ): Promise<User> {
    const existing = await this.getProfile();
    if (existing) {
      if (existing.id !== id || existing.email !== email) {
        throw new Error("signup_user_conflict");
      }

      const passwordHash = await this.getPasswordHash();
      if (passwordHash) {
        if (!(await verifyPassword(password, passwordHash))) {
          throw new Error("signup_attempt_conflict");
        }
      } else {
        await this.setPasswordHash(await hashPassword(password));
      }

      if (signupIp && !this.getSignupIp()) {
        this.setSignupIp(signupIp);
        dispatchAdminEvent(this.ctx, this.env, {
          type: "user_upsert",
          payload: { ...existing, signup_ip: signupIp },
        });
      }
      return existing;
    }

    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const allowlist = this.superuserAllowlist();
    const profile: User = {
      id,
      email,
      email_verified_at: null,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email, allowlist),
      avatar,
      is_orphaned: false,
      orphaned_at: null,
    };
    const passwordHash = await hashPassword(password);

    await this.setProfile(profile);
    await this.setPasswordHash(passwordHash);
    if (signupIp) {
      this.setSignupIp(signupIp);
      // Re-dispatch with signup_ip so the D1 admin index can index it.
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_upsert",
        payload: { ...profile, signup_ip: signupIp },
      });
    }

    return profile;
  }

  async setOrphaned(isOrphaned: boolean): Promise<void> {
    const profile = await this.getProfile();
    if (!profile) return;
    profile.is_orphaned = isOrphaned;
    profile.orphaned_at = isOrphaned ? Date.now() : null;
    await this.setProfile(profile);
  }

  async markEmailVerified(): Promise<User | null> {
    const profile = await this.getProfile();
    if (!profile) return null;
    if (profile.email_verified_at === null) {
      profile.email_verified_at = Date.now();
      await this.setProfile(profile);
    }
    return profile;
  }

  async getEmailVerificationStatus(): Promise<{
    required: boolean;
    verified: boolean;
    email_verified_at: number | null;
  }> {
    const profile = await this.getProfile();
    if (!profile) {
      return { required: false, verified: false, email_verified_at: null };
    }

    // Password-based accounts require verification. OAuth-only accounts do not.
    const hasPassword = Boolean(await this.getPasswordHash());
    const verified = profile.email_verified_at !== null;
    return {
      required: hasPassword,
      verified,
      email_verified_at: profile.email_verified_at,
    };
  }

  async updateProfile(updates: {
    name?: string | null;
    avatar?: { color?: string; content?: string };
    is_superuser?: boolean;
  }): Promise<User | null> {
    const profile = await this.getProfile();
    if (!profile) return null;

    let changed = false;

    if (updates.name !== undefined && updates.name !== profile.name) {
      profile.name = updates.name;
      changed = true;
    }

    if (
      updates.avatar?.color &&
      updates.avatar.color !== profile.avatar.color
    ) {
      profile.avatar.color = updates.avatar.color;
      changed = true;
    }

    if (
      updates.avatar?.content &&
      updates.avatar.content !== profile.avatar.content
    ) {
      const trimmed = updates.avatar.content.trim();
      if (!validateAvatarContent(trimmed)) {
        throw new Error("Invalid avatar content");
      }
      profile.avatar.content = trimmed;
      changed = true;
    }

    if (
      updates.is_superuser !== undefined &&
      updates.is_superuser !== profile.is_superuser
    ) {
      profile.is_superuser = updates.is_superuser;
      changed = true;
    }

    if (changed) {
      await this.setProfile(profile);
    }

    return profile;
  }

  async getOnboarding(): Promise<OnboardingPreferences | null> {
    const rows = this.sql
      .exec("SELECT value FROM profile WHERE key = ?", USER_ONBOARDING_KEY)
      .toArray() as Array<{ value: string }>;
    if (rows.length === 0) {
      return null;
    }

    try {
      return toOnboardingPreferences(JSON.parse(rows[0].value));
    } catch {
      return null;
    }
  }

  async updateOnboarding(
    input: OnboardingPreferences,
  ): Promise<OnboardingPreferences> {
    const next = sanitizeOnboardingPreferences(input);
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      USER_ONBOARDING_KEY,
      JSON.stringify(next),
    );
    return next;
  }

  async resetOnboarding(): Promise<OnboardingPreferences> {
    const next = getDefaultOnboardingPreferences();
    this.sql.exec(
      "INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)",
      USER_ONBOARDING_KEY,
      JSON.stringify(next),
    );
    return next;
  }

  async claimNewCamelActivation(
    activatedAt = Date.now(),
  ): Promise<NewCamelActivationClaim> {
    const existing =
      this.ctx.storage.kv.get<Omit<NewCamelActivationClaim, "isFirst">>(
        USER_NEW_CAMEL_ACTIVATION_KEY,
      );
    if (existing) {
      return { ...existing, isFirst: false };
    }

    const activation = {
      eventId: crypto.randomUUID(),
      activatedAt,
    };
    this.ctx.storage.kv.put(USER_NEW_CAMEL_ACTIVATION_KEY, activation);
    return { ...activation, isFirst: true };
  }

  // Org membership methods
  async getOrgs(): Promise<UserOrg[]> {
    return this.sql
      .exec(
        "SELECT org_id, role, joined_at, last_workspace_id FROM orgs ORDER BY joined_at ASC",
      )
      .toArray() as unknown as UserOrg[];
  }

  async addOrg(
    orgId: string,
    role: OrgRole,
    lastWorkspaceId: string | null = null,
  ): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO orgs (org_id, role, joined_at, last_workspace_id) VALUES (?, ?, ?, ?)",
      orgId,
      role,
      now,
      lastWorkspaceId,
    );
    const profile = await this.getProfile();
    if (profile)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_org_delta",
        payload: { user_id: profile.id, delta: 1 },
      });
  }

  async ensureOrg(
    orgId: string,
    role: OrgRole,
    lastWorkspaceId: string | null,
  ): Promise<boolean> {
    const existing = this.sql
      .exec("SELECT 1 FROM orgs WHERE org_id = ?", orgId)
      .toArray();
    if (existing.length > 0) return false;

    this.sql.exec(
      "INSERT INTO orgs (org_id, role, joined_at, last_workspace_id) VALUES (?, ?, ?, ?)",
      orgId,
      role,
      Date.now(),
      lastWorkspaceId,
    );
    const profile = await this.getProfile();
    if (profile) {
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_org_delta",
        payload: { user_id: profile.id, delta: 1 },
      });
    }
    return true;
  }

  async removeOrg(orgId: string): Promise<void> {
    this.sql.exec("DELETE FROM orgs WHERE org_id = ?", orgId);
    const profile = await this.getProfile();
    if (profile)
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_org_delta",
        payload: { user_id: profile.id, delta: -1 },
      });
  }

  async updateOrgRole(orgId: string, role: OrgRole): Promise<void> {
    this.sql.exec("UPDATE orgs SET role = ? WHERE org_id = ?", role, orgId);
  }

  async setOrgLastWorkspace(
    orgId: string,
    workspaceId: string | null,
  ): Promise<void> {
    this.sql.exec(
      "UPDATE orgs SET last_workspace_id = ? WHERE org_id = ?",
      workspaceId,
      orgId,
    );
  }

  async hasOrg(orgId: string): Promise<boolean> {
    const rows = this.sql
      .exec("SELECT 1 FROM orgs WHERE org_id = ?", orgId)
      .toArray();
    return rows.length > 0;
  }

  async getOrgRole(orgId: string): Promise<OrgRole | null> {
    const rows = this.sql
      .exec("SELECT role FROM orgs WHERE org_id = ?", orgId)
      .toArray();
    if (rows.length === 0) return null;
    return (rows[0] as { role: string }).role as OrgRole;
  }

  private normalizeChatGroupName(name: string | null | undefined): string {
    return (name ?? "").trim().slice(0, 120);
  }

  private getChatGroupAvatarStatus(
    source: string | null | undefined,
    generationState: string | null | undefined,
  ): ChatGroupAvatarStatus {
    if (generationState === "queued" || generationState === "generating") {
      return "pending";
    }
    if (source === "generated" || source === "user") return source;
    return "default";
  }

  private toChatGroup(row: unknown): ChatGroup {
    const group = row as {
      id: string;
      org_id: string;
      workspace_id: string;
      name: string;
      last_active_thread_id: string | null;
      created_at: number;
      updated_at: number;
      pinned_at?: number | null;
      avatar_color?: string | null;
      avatar_content?: string | null;
      avatar_content_source?: string | null;
      avatar_icon_generation_state?: string | null;
    };
    const fallbackAvatar = generateDefaultChatGroupAvatar();
    const avatarColor = normalizeAvatarColor(group.avatar_color) ?? fallbackAvatar.color;
    // `avatar_content` now stores a Lucide icon name; legacy emoji rows (and any
    // unknown value) fall back to the default chat icon.
    const avatarContent =
      normalizeChatGroupIconName(group.avatar_content) ?? fallbackAvatar.content;
    return {
      id: group.id,
      org_id: group.org_id,
      workspace_id: group.workspace_id,
      name: group.name,
      pinned_at: group.pinned_at ?? null,
      last_active_thread_id: group.last_active_thread_id ?? null,
      created_at: group.created_at,
      updated_at: group.updated_at,
      avatar: {
        color: avatarColor,
        content: avatarContent,
        status: this.getChatGroupAvatarStatus(
          group.avatar_content_source,
          group.avatar_icon_generation_state,
        ),
      },
    };
  }

  private getChatGroupRow(groupId: string): ChatGroup | null {
    const rows = this.sql
      .exec("SELECT * FROM chat_groups WHERE id = ?", groupId)
      .toArray();
    return rows[0] ? this.toChatGroup(rows[0]) : null;
  }

  private getChatGroupForThreadRow(threadId: string): ChatGroup | null {
    const rows = this.sql
      .exec(
        `SELECT g.*
         FROM chat_groups g
         INNER JOIN chat_group_members m ON m.group_id = g.id
         WHERE m.thread_id = ?
         LIMIT 1`,
        threadId,
      )
      .toArray();
    return rows[0] ? this.toChatGroup(rows[0]) : null;
  }

  private orderedThreadIds(groupId: string, isOpen: boolean): string[] {
    const rows = this.sql
      .exec<{ thread_id: string }>(
        `SELECT thread_id
         FROM chat_group_members
         WHERE group_id = ? AND is_open = ?
         ORDER BY position ASC, added_at ASC`,
        groupId,
        isOpen ? 1 : 0,
      )
      .toArray();
    return rows.map((row) => row.thread_id);
  }

  private getNextOpenPosition(groupId: string): number {
    const rows = this.sql
      .exec<{ position: number | null }>(
        "SELECT MAX(position) AS position FROM chat_group_members WHERE group_id = ? AND is_open = 1",
        groupId,
      )
      .toArray();
    return (rows[0]?.position ?? -1) + 1;
  }

  private getMemberCount(groupId: string): number {
    const rows = this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM chat_group_members WHERE group_id = ?",
        groupId,
      )
      .toArray();
    return rows[0]?.count ?? 0;
  }

  private getWorkspaceChatGroupCount(orgId: string, workspaceId: string): number {
    const rows = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM chat_groups
         WHERE org_id = ? AND workspace_id = ?`,
        orgId,
        workspaceId,
      )
      .toArray();
    return rows[0]?.count ?? 0;
  }

  private deleteGroupIfEmpty(groupId: string): void {
    if (this.getMemberCount(groupId) > 0) return;
    this.sql.exec("DELETE FROM chat_group_members WHERE group_id = ?", groupId);
    this.sql.exec("DELETE FROM chat_groups WHERE id = ?", groupId);
  }

  private summarizeChatGroup(group: ChatGroup): ChatGroupSummary {
    return {
      ...group,
      open_thread_ids: this.orderedThreadIds(group.id, true),
      closed_thread_ids: this.orderedThreadIds(group.id, false),
    };
  }

  getChatGroup(groupId: string): ChatGroup | null {
    return this.getChatGroupRow(groupId);
  }

  getChatGroupForThread(threadId: string): ChatGroupSummary | null {
    const group = this.getChatGroupForThreadRow(threadId);
    return group ? this.summarizeChatGroup(group) : null;
  }

  getChatGroupSummary(groupId: string): ChatGroupSummary | null {
    const group = this.getChatGroupRow(groupId);
    return group ? this.summarizeChatGroup(group) : null;
  }

  listChatGroups(
    orgId: string,
    workspaceId: string,
    opts: { limit?: number } = {},
  ): ChatGroupSummary[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 1000));
    const pinnedGroups = this.sql
      .exec(
        `SELECT *
         FROM chat_groups
         WHERE org_id = ? AND workspace_id = ? AND pinned_at IS NOT NULL
         ORDER BY pinned_at ASC`,
        orgId,
        workspaceId,
      )
      .toArray()
      .map((row) => this.toChatGroup(row));
    const recentGroups = this.sql
      .exec(
        `SELECT *
         FROM chat_groups
         WHERE org_id = ? AND workspace_id = ? AND pinned_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
        orgId,
        workspaceId,
        limit,
      )
      .toArray()
      .map((row) => this.toChatGroup(row));
    return [...pinnedGroups, ...recentGroups].map((group) =>
      this.summarizeChatGroup(group),
    );
  }

  listChatGroupsForMove(orgId: string, workspaceId: string): ChatGroup[] {
    return this.sql
      .exec(
        `SELECT *
         FROM chat_groups
         WHERE org_id = ? AND workspace_id = ?
         ORDER BY updated_at DESC`,
        orgId,
        workspaceId,
      )
      .toArray()
      .map((row) => this.toChatGroup(row));
  }

  createChatGroup(
    orgId: string,
    workspaceId: string,
    opts: { name?: string; lastActiveThreadId?: string } = {},
  ): ChatGroup {
    const now = Date.now();
    const id = crypto.randomUUID();
    const name = this.normalizeChatGroupName(opts.name);
    const lastActiveThreadId = opts.lastActiveThreadId?.trim() || null;
    const avatar = generateDefaultChatGroupAvatar({
      groupIndex: this.getWorkspaceChatGroupCount(orgId, workspaceId),
    });
    this.sql.exec(
      `INSERT INTO chat_groups
       (id, org_id, workspace_id, name, last_active_thread_id, created_at, updated_at, avatar_color, avatar_content, avatar_content_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'default')`,
      id,
      orgId,
      workspaceId,
      name,
      lastActiveThreadId,
      now,
      now,
      avatar.color,
      avatar.content,
    );
    return this.getChatGroupRow(id)!;
  }

  renameChatGroup(groupId: string, name: string): void {
    this.updateChatGroup(groupId, { name });
  }

  updateChatGroup(
    groupId: string,
    updates: { name?: string; avatar?: Avatar; pinned?: boolean },
  ): void {
    this.ctx.storage.transactionSync(() => {
      if (updates.name !== undefined) {
        const nextName = this.normalizeChatGroupName(updates.name);
        const nextState: ChatGroupIconGenerationState =
          isPlaceholderThreadTitle(nextName) ? "idle" : "queued";
        this.sql.exec(
          `UPDATE chat_groups
           SET name = ?,
               avatar_icon_generation_state = CASE
                 WHEN avatar_content_source = 'default' THEN ?
                 ELSE avatar_icon_generation_state
               END,
               avatar_icon_generation_claim_id = CASE
                 WHEN avatar_content_source = 'default' THEN NULL
                 ELSE avatar_icon_generation_claim_id
               END,
               avatar_icon_generation_claimed_at = CASE
                 WHEN avatar_content_source = 'default' THEN NULL
                 ELSE avatar_icon_generation_claimed_at
               END
           WHERE id = ? AND name <> ?`,
          nextName,
          nextState,
          groupId,
          nextName,
        );
      }
      if (updates.avatar !== undefined) {
        const avatar = normalizeChatGroupAvatar(updates.avatar);
        if (!avatar) {
          throw new Error("Invalid chat group avatar");
        }
        this.sql.exec(
          `UPDATE chat_groups
           SET avatar_color = ?,
               avatar_content = ?,
               avatar_content_source = 'user',
               avatar_icon_generation_state = 'idle',
               avatar_icon_generation_claim_id = NULL,
               avatar_icon_generation_claimed_at = NULL
           WHERE id = ?`,
          avatar.color,
          avatar.content,
          groupId,
        );
      }
      if (updates.pinned === true) {
        this.sql.exec(
          `UPDATE chat_groups
           SET pinned_at = ?
           WHERE id = ? AND pinned_at IS NULL`,
          Date.now(),
          groupId,
        );
      } else if (updates.pinned === false) {
        this.sql.exec(
          `UPDATE chat_groups
           SET pinned_at = NULL
           WHERE id = ? AND pinned_at IS NOT NULL`,
          groupId,
        );
      }
    });
  }

  updateChatGroupAvatar(groupId: string, avatar: Avatar): void {
    this.updateChatGroup(groupId, { avatar });
  }

  setGeneratedChatGroupIcon(
    groupId: string,
    claimId: string,
    icon: string,
  ): ChatGroupAvatar | null {
    const content = normalizeChatGroupIconName(icon);
    if (!content) return this.getChatGroupRow(groupId)?.avatar ?? null;
    let avatar: ChatGroupAvatar | null = null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE chat_groups
         SET avatar_content = ?,
             avatar_content_source = 'generated',
             avatar_icon_generation_state = 'idle',
             avatar_icon_generation_claim_id = NULL,
             avatar_icon_generation_claimed_at = NULL
         WHERE id = ?
           AND avatar_content_source = 'default'
           AND avatar_icon_generation_state = 'generating'
           AND avatar_icon_generation_claim_id = ?`,
        content,
        groupId,
        claimId,
      );
      const group = this.getChatGroupRow(groupId);
      avatar = group?.avatar ?? null;
    });
    return avatar;
  }

  claimChatGroupAvatarGenerationForThread(
    threadId: string,
    requestedTrigger?: ChatGroupIconGenerationClaim["trigger"],
  ): ChatGroupIconGenerationClaim | null {
    const group = this.getChatGroupForThreadRow(threadId);
    if (!group || isPlaceholderThreadTitle(group.name)) return null;
    const state = this.sql
      .exec<{ avatar_icon_generation_state: ChatGroupIconGenerationState }>(
        "SELECT avatar_icon_generation_state FROM chat_groups WHERE id = ?",
        group.id,
      )
      .toArray()[0]?.avatar_icon_generation_state;
    const trigger =
      requestedTrigger ??
      (state === "idle" ? "first_title" : "legacy_migration");
    return this.claimChatGroupIconGeneration(
      group.id,
      trigger,
      new Set(["idle", "queued", "generating"]),
    );
  }

  markChatGroupAvatarGenerationFailed(
    groupId: string,
    claimId: string,
  ): ChatGroupAvatar | null {
    let avatar: ChatGroupAvatar | null = null;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE chat_groups
         SET avatar_icon_generation_state = 'failed',
             avatar_icon_generation_claim_id = NULL
         WHERE id = ?
           AND avatar_content_source = 'default'
           AND avatar_icon_generation_state = 'generating'
           AND avatar_icon_generation_claim_id = ?`,
        groupId,
        claimId,
      );
      const group = this.getChatGroupRow(groupId);
      avatar = group?.avatar ?? null;
    });
    return avatar;
  }

  claimChatGroupAvatarMigrationBatch(
    orgId: string,
    workspaceId: string,
    limit: number,
  ): ChatGroupIconGenerationClaim[] {
    const staleBefore = Date.now() - CHAT_GROUP_ICON_GENERATION_LEASE_MS;
    const freshGeneratingCount =
      this.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count
           FROM chat_groups
           WHERE org_id = ?
             AND workspace_id = ?
             AND avatar_content_source = 'default'
             AND avatar_icon_generation_state = 'generating'
             AND avatar_icon_generation_claimed_at > ?`,
          orgId,
          workspaceId,
          staleBefore,
        )
        .toArray()[0]?.count ?? 0;
    const availableCapacity = Math.max(
      0,
      CHAT_GROUP_ICON_MAX_CONCURRENCY - freshGeneratingCount,
    );
    if (availableCapacity === 0) return [];
    const boundedLimit = Math.max(
      1,
      Math.min(
        Math.floor(limit),
        CHAT_GROUP_ICON_MAX_CONCURRENCY,
        availableCapacity,
      ),
    );
    const candidates = this.sql
      .exec<{ id: string }>(
        `SELECT id
         FROM chat_groups
         WHERE org_id = ?
           AND workspace_id = ?
           AND avatar_content_source = 'default'
           AND (
             avatar_icon_generation_state = 'queued'
             OR (
               avatar_icon_generation_state = 'generating'
               AND (
                 avatar_icon_generation_claimed_at IS NULL
                 OR avatar_icon_generation_claimed_at <= ?
               )
             )
           )
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`,
        orgId,
        workspaceId,
        staleBefore,
        boundedLimit,
      )
      .toArray();

    const claims: ChatGroupIconGenerationClaim[] = [];
    for (const candidate of candidates) {
      const claim = this.claimChatGroupIconGeneration(
        candidate.id,
        "legacy_migration",
        new Set(["queued", "generating"]),
      );
      if (claim) claims.push(claim);
    }
    return claims;
  }

  hasChatGroupAvatarMigrationCandidates(
    orgId: string,
    workspaceId: string,
  ): boolean {
    const staleBefore = Date.now() - CHAT_GROUP_ICON_GENERATION_LEASE_MS;
    return (
      this.sql
        .exec(
          `SELECT 1
           FROM chat_groups
           WHERE org_id = ?
             AND workspace_id = ?
             AND avatar_content_source = 'default'
             AND (
               avatar_icon_generation_state = 'queued'
               OR (
                 avatar_icon_generation_state = 'generating'
                 AND (
                   avatar_icon_generation_claimed_at IS NULL
                   OR avatar_icon_generation_claimed_at <= ?
                 )
               )
             )
           LIMIT 1`,
          orgId,
          workspaceId,
          staleBefore,
        )
        .toArray().length > 0
    );
  }

  private claimChatGroupIconGeneration(
    groupId: string,
    trigger: ChatGroupIconGenerationClaim["trigger"],
    allowedStates: ReadonlySet<ChatGroupIconGenerationState>,
  ): ChatGroupIconGenerationClaim | null {
    let claim: ChatGroupIconGenerationClaim | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{
          id: string;
          name: string;
          avatar_content_source: string;
          avatar_icon_generation_state: ChatGroupIconGenerationState;
          avatar_icon_generation_claimed_at: number | null;
        }>(
          `SELECT id, name, avatar_content_source,
                  avatar_icon_generation_state,
                  avatar_icon_generation_claimed_at
           FROM chat_groups
           WHERE id = ?`,
          groupId,
        )
        .toArray()[0];
      if (!row || row.avatar_content_source !== "default") return;
      if (isPlaceholderThreadTitle(row.name)) return;
      if (!allowedStates.has(row.avatar_icon_generation_state)) return;

      const now = Date.now();
      if (
        row.avatar_icon_generation_state === "generating" &&
        row.avatar_icon_generation_claimed_at !== null &&
        row.avatar_icon_generation_claimed_at >
          now - CHAT_GROUP_ICON_GENERATION_LEASE_MS
      ) {
        return;
      }

      const claimId = crypto.randomUUID();
      this.sql.exec(
        `UPDATE chat_groups
         SET avatar_icon_generation_state = 'generating',
             avatar_icon_generation_claim_id = ?,
             avatar_icon_generation_claimed_at = ?
         WHERE id = ?
           AND avatar_content_source = 'default'`,
        claimId,
        now,
        row.id,
      );
      const avatar = this.getChatGroupRow(row.id)?.avatar;
      if (!avatar) return;
      claim = {
        id: row.id,
        name: row.name,
        avatar,
        claimId,
        claimedAt: now,
        trigger,
      };
    });
    return claim;
  }

  closeChatGroup(groupId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM chat_group_members WHERE group_id = ?", groupId);
      this.sql.exec("DELETE FROM chat_groups WHERE id = ?", groupId);
    });
  }

  addThreadToGroup(
    groupId: string,
    threadId: string,
    opts: { position?: number; reopenIfClosed?: boolean } = {},
  ): void {
    this.ctx.storage.transactionSync(() => {
      const group = this.getChatGroupRow(groupId);
      if (!group) throw new Error("Chat group not found");
      const now = Date.now();
      const sourceGroup = this.getChatGroupForThreadRow(threadId);
      const position =
        typeof opts.position === "number" && Number.isFinite(opts.position)
          ? Math.max(0, Math.floor(opts.position))
          : this.getNextOpenPosition(groupId);
      this.sql.exec("DELETE FROM chat_group_members WHERE thread_id = ?", threadId);
      this.sql.exec(
        `INSERT INTO chat_group_members
         (group_id, thread_id, is_open, position, closed_at, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        groupId,
        threadId,
        opts.reopenIfClosed === false ? 0 : 1,
        position,
        opts.reopenIfClosed === false ? now : null,
        now,
      );
      this.sql.exec(
        "UPDATE chat_groups SET last_active_thread_id = ? WHERE id = ?",
        threadId,
        groupId,
      );
      if (sourceGroup && sourceGroup.id !== groupId) {
        this.deleteGroupIfEmpty(sourceGroup.id);
      }
    });
  }

  moveThreadToGroup(
    threadId: string,
    targetGroupId: string,
    opts: { position?: number } = {},
  ): void {
    this.addThreadToGroup(targetGroupId, threadId, {
      position: opts.position,
      reopenIfClosed: true,
    });
  }

  moveThreadToNewGroup(
    orgId: string,
    workspaceId: string,
    threadId: string,
    opts: { name?: string } = {},
  ): { group: ChatGroup } {
    let group: ChatGroup | null = null;
    this.ctx.storage.transactionSync(() => {
      const sourceGroup = this.getChatGroupForThreadRow(threadId);
      group = this.createChatGroup(orgId, workspaceId, {
        name: opts.name,
        lastActiveThreadId: threadId,
      });
      const now = Date.now();
      this.sql.exec("DELETE FROM chat_group_members WHERE thread_id = ?", threadId);
      this.sql.exec(
        `INSERT INTO chat_group_members
         (group_id, thread_id, is_open, position, closed_at, added_at)
         VALUES (?, ?, 1, 0, NULL, ?)`,
        group.id,
        threadId,
        now,
      );
      if (sourceGroup && sourceGroup.id !== group.id) {
        this.deleteGroupIfEmpty(sourceGroup.id);
      }
    });
    return { group: group! };
  }

  closeThreadTab(threadId: string): void {
    this.ctx.storage.transactionSync(() => {
      const group = this.getChatGroupForThreadRow(threadId);
      if (!group) return;
      const now = Date.now();
      this.sql.exec(
        "UPDATE chat_group_members SET is_open = 0, closed_at = ? WHERE thread_id = ?",
        now,
        threadId,
      );
      const nextActive =
        this.orderedThreadIds(group.id, true)[0] ??
        this.orderedThreadIds(group.id, false)[0] ??
        null;
      this.sql.exec(
        "UPDATE chat_groups SET last_active_thread_id = ? WHERE id = ?",
        nextActive,
        group.id,
      );
    });
  }

  reopenThreadTab(threadId: string, opts: { position?: number } = {}): void {
    this.ctx.storage.transactionSync(() => {
      const group = this.getChatGroupForThreadRow(threadId);
      if (!group) return;
      const position =
        typeof opts.position === "number" && Number.isFinite(opts.position)
          ? Math.max(0, Math.floor(opts.position))
          : this.getNextOpenPosition(group.id);
      this.sql.exec(
        "UPDATE chat_group_members SET is_open = 1, position = ?, closed_at = NULL WHERE thread_id = ?",
        position,
        threadId,
      );
      this.sql.exec(
        "UPDATE chat_groups SET last_active_thread_id = ? WHERE id = ?",
        threadId,
        group.id,
      );
    });
  }

  reorderThreadTabs(groupId: string, orderedIds: string[]): void {
    this.ctx.storage.transactionSync(() => {
      const group = this.getChatGroupRow(groupId);
      if (!group) throw new Error("Chat group not found");
      orderedIds.forEach((threadId, index) => {
        this.sql.exec(
          "UPDATE chat_group_members SET position = ? WHERE group_id = ? AND thread_id = ? AND is_open = 1",
          index,
          groupId,
          threadId,
        );
      });
    });
  }

  setGroupActiveThread(groupId: string, threadId: string): void {
    const rows = this.sql
      .exec(
        "SELECT 1 FROM chat_group_members WHERE group_id = ? AND thread_id = ?",
        groupId,
        threadId,
      )
      .toArray();
    if (rows.length === 0) return;
    this.sql.exec(
      "UPDATE chat_groups SET last_active_thread_id = ? WHERE id = ?",
      threadId,
      groupId,
    );
  }

  ensureGroupForThread(
    orgId: string,
    workspaceId: string,
    threadId: string,
    fallbackName: string,
  ): ChatGroupSummary {
    let group: ChatGroup | null = null;
    this.ctx.storage.transactionSync(() => {
      group = this.getChatGroupForThreadRow(threadId);
      const now = Date.now();
      if (!group) {
        group = this.createChatGroup(orgId, workspaceId, {
          name: fallbackName,
          lastActiveThreadId: threadId,
        });
        this.sql.exec(
          `INSERT INTO chat_group_members
           (group_id, thread_id, is_open, position, closed_at, added_at)
           VALUES (?, ?, 1, 0, NULL, ?)`,
          group.id,
          threadId,
          now,
        );
      } else {
        const membership = this.sql
          .exec<{ is_open: number }>(
            "SELECT is_open FROM chat_group_members WHERE thread_id = ?",
            threadId,
          )
          .toArray()[0];
        if (membership?.is_open === 1) {
          this.sql.exec(
            "UPDATE chat_groups SET last_active_thread_id = ? WHERE id = ?",
            threadId,
            group.id,
          );
        }
        group = this.getChatGroupRow(group.id);
      }
    });
    return this.summarizeChatGroup(group!);
  }

  touchGroupForThread(threadId: string, at: number = Date.now()): void {
    const group = this.getChatGroupForThreadRow(threadId);
    if (!group) return;
    this.sql.exec(
      "UPDATE chat_groups SET last_active_thread_id = ?, updated_at = ? WHERE id = ?",
      threadId,
      at,
      group.id,
    );
  }

  forgetThreadView(threadId: string): void {
    this.sql.exec("DELETE FROM chat_thread_views WHERE thread_id = ?", threadId);
  }

  markThreadViewed(threadId: string, at: number = Date.now()): void {
    this.sql.exec(
      `INSERT INTO chat_thread_views (thread_id, viewed_at)
       VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
      threadId,
      at,
    );
  }

  listThreadViews(threadIds: string[]): Record<string, number> {
    if (threadIds.length === 0) return {};
    const result: Record<string, number> = {};
    for (const threadId of threadIds) {
      const rows = this.sql
        .exec<{ viewed_at: number }>(
          "SELECT viewed_at FROM chat_thread_views WHERE thread_id = ?",
          threadId,
        )
        .toArray();
      if (typeof rows[0]?.viewed_at === "number") {
        result[threadId] = rows[0].viewed_at;
      }
    }
    return result;
  }

  removeThreadMembership(threadId: string): void {
    this.ctx.storage.transactionSync(() => {
      const group = this.getChatGroupForThreadRow(threadId);
      this.sql.exec("DELETE FROM chat_group_members WHERE thread_id = ?", threadId);
      this.sql.exec("DELETE FROM chat_thread_views WHERE thread_id = ?", threadId);
      if (group) this.deleteGroupIfEmpty(group.id);
    });
  }

  pruneMissingThreads(threadIds: string[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const threadId of threadIds) {
        const group = this.getChatGroupForThreadRow(threadId);
        this.sql.exec(
          "DELETE FROM chat_group_members WHERE thread_id = ?",
          threadId,
        );
        if (group) this.deleteGroupIfEmpty(group.id);
      }
    });
  }

  renameEmptySingleThreadGroupForThread(
    threadId: string,
    title: string,
  ): void {
    const name = this.normalizeChatGroupName(title);
    if (!name) return;
    this.ctx.storage.transactionSync(() => {
      const group = this.getChatGroupForThreadRow(threadId);
      if (!group) return;
      const rows = this.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM chat_group_members WHERE group_id = ?",
          group.id,
        )
        .toArray();
      if ((rows[0]?.count ?? 0) !== 1) return;
      if (
        name &&
        !isPlaceholderThreadTitle(name) &&
        isPlaceholderThreadTitle(group.name)
      ) {
        this.sql.exec(
          `UPDATE chat_groups
           SET name = ?,
               avatar_icon_generation_state = CASE
                 WHEN avatar_content_source = 'default' THEN 'queued'
                 ELSE avatar_icon_generation_state
               END,
               avatar_icon_generation_claim_id = CASE
                 WHEN avatar_content_source = 'default' THEN NULL
                 ELSE avatar_icon_generation_claim_id
               END,
               avatar_icon_generation_claimed_at = CASE
                 WHEN avatar_content_source = 'default' THEN NULL
                 ELSE avatar_icon_generation_claimed_at
               END
           WHERE id = ?`,
          name,
          group.id,
        );
      }
    });
  }

  // OAuth provider methods
  async getOAuthProviders(): Promise<UserOAuthProvider[]> {
    return this.sql
      .exec(
        "SELECT provider, provider_id, linked_at FROM oauth_providers ORDER BY linked_at ASC",
      )
      .toArray() as unknown as UserOAuthProvider[];
  }

  async getOAuthProvider(
    provider: OAuthProvider,
  ): Promise<UserOAuthProvider | null> {
    const rows = this.sql
      .exec(
        "SELECT provider, provider_id, linked_at FROM oauth_providers WHERE provider = ?",
        provider,
      )
      .toArray() as unknown as UserOAuthProvider[];
    return rows[0] || null;
  }

  async linkOAuthProvider(
    provider: OAuthProvider,
    providerId: string,
  ): Promise<UserOAuthProvider> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO oauth_providers (provider, provider_id, linked_at) VALUES (?, ?, ?)",
      provider,
      providerId,
      now,
    );
    return { provider, provider_id: providerId, linked_at: now };
  }

  async unlinkOAuthProvider(provider: OAuthProvider): Promise<void> {
    this.sql.exec("DELETE FROM oauth_providers WHERE provider = ?", provider);
  }

  async hasOAuthProvider(provider: OAuthProvider): Promise<boolean> {
    const rows = this.sql
      .exec("SELECT 1 FROM oauth_providers WHERE provider = ?", provider)
      .toArray();
    return rows.length > 0;
  }

  /** Create a non-superuser account owned by an enterprise SSO connection. */
  async createUserFromEnterpriseSso(
    id: string,
    email: string,
    name: string | null,
  ): Promise<User> {
    if (!canCreateEnterpriseSsoUser(email, this.superuserAllowlist())) {
      throw new Error("enterprise_sso_superuser_forbidden");
    }
    const existing = await this.getProfile();
    if (existing) {
      if (existing.id !== id || existing.email !== email) {
        throw new Error("enterprise_sso_user_conflict");
      }
      if (existing.is_superuser) {
        throw new Error("enterprise_sso_superuser_forbidden");
      }
      return existing;
    }

    const now = Date.now();
    const profile: User = {
      id,
      email,
      email_verified_at: now,
      name,
      created_at: now,
      // An enterprise IdP can create an organization member, never a global
      // camelAI superuser.
      is_superuser: false,
      avatar: generateDefaultAvatar(name || email),
      is_orphaned: false,
      orphaned_at: null,
    };
    await this.setProfile(profile);
    await this.updateOnboarding({ completed_at: now });
    return profile;
  }

  /**
   * Create a user from OAuth sign-in (no password required).
   */
  async createUserFromOAuth(
    id: string,
    email: string,
    name: string | null,
    provider: OAuthProvider,
    providerId: string,
    signupIp: string | null = null,
  ): Promise<User> {
    const now = Date.now();
    const avatar = generateDefaultAvatar(name || email);
    const allowlist = this.superuserAllowlist();
    const profile: User = {
      id,
      email,
      email_verified_at: now,
      name,
      created_at: now,
      is_superuser: isSuperuserEmail(email, allowlist),
      avatar,
      is_orphaned: false,
      orphaned_at: null,
    };

    await this.setProfile(profile);
    await this.linkOAuthProvider(provider, providerId);
    if (signupIp) {
      this.setSignupIp(signupIp);
      // Re-dispatch with signup_ip so the D1 admin index can index it.
      dispatchAdminEvent(this.ctx, this.env, {
        type: "user_upsert",
        payload: { ...profile, signup_ip: signupIp },
      });
    }

    return profile;
  }

  /**
   * Compatibility probe for admin hard-delete flow.
   * Exists so callers can verify RPC availability before destructive cleanup.
   */
  async canHardDeleteUser(): Promise<boolean> {
    return true;
  }

  /**
   * Permanently delete all data in this UserDO.
   * Wipes profile, org memberships, OAuth providers, onboarding, and password.
   */
  async hardDeleteUser(): Promise<void> {
    this.sql.exec("DELETE FROM profile");
    this.sql.exec("DELETE FROM orgs");
    this.sql.exec("DELETE FROM oauth_providers");
  }

  // Test helper RPC: simulate constructor migration path on an existing DO.
  async remigrate(): Promise<void> {
    this.migrate();
  }

  // Test helper RPC: expose the current schema version used by migration logic.
  async getSchemaVersion(): Promise<number> {
    return this.getSchemaVersionValue();
  }
}

// Organization Durable Object - one per org
