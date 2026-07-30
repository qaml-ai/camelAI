import { DurableObject } from "cloudflare:workers";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import type { OrgDO, OrgThread, UserDO } from "./auth";
import type {
  ChatThreadDO,
  InitialUserMessageRequest,
  InitialUserMessageResult,
} from "./chat-thread-do";
import {
  getCronMinimumIntervalMs,
  getNextCronRunAt,
  parseCronExpression,
} from "./cron-schedule";
import type { WorkspaceDO } from "./workspace";
import type { WorkspaceFilesystemDO } from "./workspace-filesystem-do";
import type { ProjectBuildSandbox } from "./project-build-sandbox";
import {
  getDefaultLlmModel,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
} from "../../../src/lib/llm-provider-config";
import { resolveModelPickerCatalog } from "../../../src/lib/model-catalog";
import {
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from "../../../src/lib/model-picker-config";
import { retryTransientDurableObjectRead } from "../../../src/lib/do-rpc-retry.server";
import { getEffectiveLlmProviderConfig } from "../../../src/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "../../../src/lib/selfhost-runtime";
import {
  getBillingPlanLimits,
  type BillingPlanLimits,
} from "../../../src/lib/billing-plans";
import { isChatBillingOrCreditError } from "../../../src/lib/chat-api-errors";
import { sendScheduledPromptPausedEmail } from "../../../src/lib/email.server";
import type { CloudflareEmailSender } from "../../../src/lib/cloudflare-email.server";
import type { LlmModel } from "../../../src/types";
import {
  readOrgModelPickerConfig,
  readWorkspaceModelPickerConfig,
} from "./model-picker-config-reader";
import { recordObservabilityEvent } from "./observability";

const MAX_DUE_JOBS_PER_ALARM = 20;
const WORKSPACE_ID_KEY = "workspaceId";
const AUTOMATION_WORKFLOW_BINDING = "DETERMINISTIC_AUTOMATION_WORKFLOWS";
const SCHEDULE_DISABLED_BY_BILLING_PREFIX =
  "Schedule disabled by billing plan:";
/**
 * Prefix stamped on `last_run_error` when a scheduled prompt is auto-paused
 * after repeated billing failures. Exported so UI/tests can detect the state.
 */
export const SCHEDULE_PAUSED_BILLING_FAILURES_PREFIX =
  "Schedule paused after repeated billing failures:";
/**
 * Auto-pause a scheduled prompt once this many consecutive runs fail with a
 * billing-classified error. Successful (or clarifying-question) runs reset the
 * streak; busy and non-billing errors leave it unchanged.
 */
const SCHEDULED_PROMPT_BILLING_FAILURE_PAUSE_THRESHOLD = 3;
const OBSERVABILITY_COMPONENT = "workspace_cron";

function formatInterval(ms: number): string {
  if (ms % (24 * 60 * 60 * 1000) === 0) {
    const days = ms / (24 * 60 * 60 * 1000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms % (60 * 60 * 1000) === 0) {
    const hours = ms / (60 * 60 * 1000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / (60 * 1000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type RunStatus = "success" | "busy" | "question" | "error";
type DeterministicAutomationRunStatus = "started" | "success" | "error";
type AutomationRunKind = "scheduled_prompt" | "deterministic_automation";
type AutomationRunStatus = "started" | "success" | "error" | "question" | "busy";
type AutomationRunTrigger = "schedule" | "manual";

/**
 * Max run-history rows retained per automation. Older rows are trimmed on
 * insert. Keep this bounded to the current product cap; pagination only pages
 * through retained history.
 */
const AUTOMATION_RUN_RETENTION = 20;
/** Default/maximum page size for {@link WorkspaceCronDO.listAutomationRunsPage}. */
const AUTOMATION_RUNS_PAGE_SIZE = 20;
const AUTOMATION_RUNS_PAGE_MAX = 50;

export interface AutomationRunCursor {
  startedAt: number;
  id: string;
}

interface ScheduledPromptRow {
  id: string;
  name: string;
  prompt: string;
  cron_expression: string;
  thread_id: string;
  scheduled_by_thread_id: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  run_count: number;
  consecutive_billing_failures: number;
}

interface DeterministicAutomationRow {
  id: string;
  name: string;
  description: string | null;
  source: string;
  source_version: number;
  cron_expression: string;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_instance_id: string | null;
  run_count: number;
}

interface DeterministicAutomationVersionRow {
  automation_id: string;
  workspace_id: string;
  source_version: number;
  source: string;
  created_by: string;
  created_at: number;
}

interface AutomationRunRow {
  id: string;
  kind: AutomationRunKind;
  automation_id: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  started_at: number;
  completed_at: number | null;
  message: string | null;
  thread_id: string | null;
  instance_id: string | null;
  created_at: number;
}

interface WorkspaceInfo {
  id: string;
  org_id: string;
  archived: boolean;
}

interface EnabledAutomationLimitRow {
  kind: AutomationRunKind;
  id: string;
  created_by: string;
  created_at: number;
}

export interface WorkspaceAutomationInfo {
  id: string;
  org_id: string;
}

interface DispatchResult {
  status: RunStatus;
  error?: string;
  threadId: string;
  accepted?: boolean;
}

type InitialUserMessageRpc = {
  startInitialUserMessage: (
    body: InitialUserMessageRequest,
  ) => Promise<InitialUserMessageResult>;
};

interface DeterministicAutomationDispatchResult {
  status: DeterministicAutomationRunStatus;
  instanceId?: string;
  error?: string;
}

export interface RecordDeterministicAutomationRunResultInput {
  workspaceId: string;
  automationId: string;
  instanceId: string;
  status: "success" | "error";
  error?: string | null;
}

export interface RecordScheduledPromptRunResultInput {
  workspaceId: string;
  promptId: string;
  runId: string;
  status: "success" | "error" | "question" | "busy";
  message?: string | null;
  completedAt?: number | null;
}

export interface AutomationRunRecord {
  id: string;
  kind: AutomationRunKind;
  automation_id: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  started_at: number;
  completed_at: number | null;
  message: string | null;
  thread_id: string | null;
  instance_id: string | null;
  created_at: number;
}

export interface WorkspaceScheduledPrompt {
  id: string;
  name: string;
  prompt: string;
  cron_expression: string;
  thread_id: string;
  scheduled_by_thread_id: string | null;
  enabled: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: RunStatus | null;
  last_run_error: string | null;
  run_count: number;
  consecutive_billing_failures: number;
  /**
   * True when the schedule was automatically paused after repeated billing
   * failures (derived from `enabled` + the pause-prefixed `last_run_error`).
   * Re-enabling the schedule clears the failure streak.
   */
  auto_paused: boolean;
}

export interface WorkspaceDeterministicAutomation {
  id: string;
  name: string;
  description: string;
  source: string;
  source_version: number;
  cron_expression: string;
  enabled: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: DeterministicAutomationRunStatus | null;
  last_run_error: string | null;
  last_instance_id: string | null;
  run_count: number;
}

export interface CreateScheduledPromptInput {
  workspaceId: string;
  name: string;
  prompt: string;
  cronExpression: string;
  createdBy: string;
  scheduledByThreadId?: string | null;
  enabled?: boolean;
}

export interface CreateDeterministicAutomationInput {
  workspaceId: string;
  name: string;
  source: string;
  cronExpression: string;
  createdBy: string;
  description: string;
  enabled?: boolean;
}

export interface UpdateScheduledPromptInput {
  workspaceId: string;
  id: string;
  name?: string;
  prompt?: string;
  cronExpression?: string;
  enabled?: boolean;
}

export interface UpdateDeterministicAutomationInput {
  workspaceId: string;
  id: string;
  name?: string;
  description?: string;
  source?: string;
  cronExpression?: string;
  enabled?: boolean;
  /** Reject the update if another writer changed the automation source first. */
  expectedSourceVersion?: number;
}

export interface RunScheduledPromptNowResult {
  prompt: WorkspaceScheduledPrompt;
  dispatch: {
    status: RunStatus;
    thread_id: string;
    error?: string;
      };
}

export interface RunDeterministicAutomationNowResult {
  automation: WorkspaceDeterministicAutomation;
  dispatch: {
    status: DeterministicAutomationRunStatus;
    instance_id?: string;
    error?: string;
  };
}

export interface DeterministicAutomationSourceSnapshot {
  automation_id: string;
  workspace_id: string;
  source_version: number;
  source: string;
  created_by: string;
}

export interface ValidateDeterministicAutomationResult {
  valid: boolean;
  errors: string[];
}


export interface WorkspaceCronEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  USER: DurableObjectNamespace<UserDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<ProjectBuildSandbox>;
  CODE_MODE_LOADER?: WorkerLoader;
  DETERMINISTIC_AUTOMATION_WORKFLOWS?: Workflow;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  SELFHOST_AI_PROVIDER?: string;
  SELFHOST_AI_API_KEY?: string;
  SELFHOST_AI_BASE_URL?: string;
  SELFHOST_AI_MODEL?: string;
  SELFHOST_AI_NAME?: string;
  SELFHOST_AI_AUTH_TYPE?: string;
  SELFHOST_AI_API?: string;
  SELFHOST_AI_AWS_REGION?: string;
  WORKER_BASE_URL?: string;
  EMAIL?: CloudflareEmailSender;
  EMAIL_FROM_ADDRESS?: string;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
}

export class WorkspaceCronDO extends DurableObject<WorkspaceCronEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkspaceCronEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    const version = this.ctx.storage.kv.get<number>("schemaVersion") ?? 0;
    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_prompts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          cron_expression TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          scheduled_by_thread_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_run_status TEXT,
          last_run_error TEXT,
          run_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_next_run ON scheduled_prompts(enabled, next_run_at)",
      );
    }

    if (version >= 1 && version < 2) {
      this.sql.exec(
        "ALTER TABLE scheduled_prompts ADD COLUMN scheduled_by_thread_id TEXT",
      );
    }

    if (version < 2) {
      this.ctx.storage.kv.put("schemaVersion", 2);
    }

    if (version < 3) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS deterministic_automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          source TEXT NOT NULL,
          source_version INTEGER NOT NULL DEFAULT 1,
          cron_expression TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_run_status TEXT,
          last_run_error TEXT,
          last_instance_id TEXT,
          run_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS deterministic_automation_versions (
          automation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          source_version INTEGER NOT NULL,
          source TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (automation_id, source_version)
        )`,
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_deterministic_automations_next_run ON deterministic_automations(enabled, next_run_at)",
      );
      this.ctx.storage.kv.put("schemaVersion", 3);
    }

    if (version < 4) {
      this.sql.exec(
        "UPDATE deterministic_automations SET description = name WHERE description IS NULL OR trim(description) = ''",
      );
      this.ctx.storage.kv.put("schemaVersion", 4);
    }

    if (version < 5) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS automation_runs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          automation_id TEXT NOT NULL,
          trigger TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          message TEXT,
          thread_id TEXT,
          instance_id TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_automation_runs_lookup
         ON automation_runs(kind, automation_id, started_at DESC, id DESC)`,
      );
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_automation_runs_instance
         ON automation_runs(kind, automation_id, instance_id)
         WHERE instance_id IS NOT NULL`,
      );
      this.ctx.storage.kv.put("schemaVersion", 5);
    } else {
      this.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_automation_runs_lookup_v2
         ON automation_runs(kind, automation_id, started_at DESC, id DESC)`,
      );
    }

    if (version < 6) {
      this.sql.exec(
        "ALTER TABLE scheduled_prompts ADD COLUMN last_run_id TEXT",
      );
      this.ctx.storage.kv.put("schemaVersion", 6);
    }

    if (version < 7) {
      this.sql.exec(
        "ALTER TABLE scheduled_prompts ADD COLUMN consecutive_billing_failures INTEGER NOT NULL DEFAULT 0",
      );
      this.ctx.storage.kv.put("schemaVersion", 7);
    }
  }

  private normalizeWorkspaceId(workspaceId: string): string {
    const normalized = workspaceId.trim();
    if (!normalized) {
      throw new Error("workspaceId is required");
    }
    return normalized;
  }

  private assertWorkspaceIdentity(workspaceId: string): string {
    const normalized = this.normalizeWorkspaceId(workspaceId);
    const storedWorkspaceId = this.ctx.storage.kv.get<string>(WORKSPACE_ID_KEY);
    if (!storedWorkspaceId) {
      this.ctx.storage.kv.put(WORKSPACE_ID_KEY, normalized);
      return normalized;
    }
    if (storedWorkspaceId !== normalized) {
      throw new Error("Workspace scheduler context mismatch");
    }
    return normalized;
  }

  private getStoredWorkspaceId(): string | null {
    const workspaceId = this.ctx.storage.kv.get<string>(WORKSPACE_ID_KEY);
    if (!workspaceId || !workspaceId.trim()) return null;
    return workspaceId.trim();
  }

  private toPrompt(row: ScheduledPromptRow): WorkspaceScheduledPrompt {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      cron_expression: row.cron_expression,
      thread_id: row.thread_id,
      scheduled_by_thread_id: row.scheduled_by_thread_id,
      enabled: row.enabled === 1,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_run_status: (row.last_run_status as RunStatus | null) ?? null,
      last_run_error: row.last_run_error,
      run_count: row.run_count,
      consecutive_billing_failures: row.consecutive_billing_failures ?? 0,
      auto_paused:
        row.enabled === 0 &&
        this.isSchedulePausedByBillingFailuresMessage(row.last_run_error),
    };
  }

  private toAutomation(
    row: DeterministicAutomationRow,
  ): WorkspaceDeterministicAutomation {
    return {
      id: row.id,
      name: row.name,
      description: this.parseDescription(row.description ?? row.name),
      source: row.source,
      source_version: row.source_version,
      cron_expression: row.cron_expression,
      enabled: row.enabled === 1,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_run_status:
        (row.last_run_status as DeterministicAutomationRunStatus | null) ??
        null,
      last_run_error: row.last_run_error,
      last_instance_id: row.last_instance_id,
      run_count: row.run_count,
    };
  }

  private toAutomationRun(row: AutomationRunRow): AutomationRunRecord {
    return {
      id: row.id,
      kind: row.kind,
      automation_id: row.automation_id,
      trigger: row.trigger,
      status: row.status,
      started_at: row.started_at,
      completed_at: row.completed_at,
      message: row.message,
      thread_id: row.thread_id,
      instance_id: row.instance_id,
      created_at: row.created_at,
    };
  }

  private parseName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("name is required");
    }
    if (trimmed.length > 120) {
      throw new Error("name must be 120 characters or fewer");
    }
    return trimmed;
  }

  private parsePrompt(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("prompt is required");
    }
    if (trimmed.length > 20_000) {
      throw new Error("prompt must be 20000 characters or fewer");
    }
    return trimmed;
  }

  private parseDescription(value: string | null | undefined): string {
    if (typeof value !== "string") {
      throw new Error("description is required");
    }
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("description is required");
    }
    if (trimmed.length > 500) {
      throw new Error("description must be 500 characters or fewer");
    }
    return trimmed;
  }

  private parseAutomationSource(value: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("source is required");
    }
    if (value.length > 100_000) {
      throw new Error("source must be 100000 characters or fewer");
    }
    return value;
  }

  private parseOptionalThreadId(
    value: string | null | undefined,
  ): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeCronExpression(value: string): string {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      throw new Error("cronExpression is required");
    }
    if (trimmed.length > 100) {
      throw new Error("cronExpression must be 100 characters or fewer");
    }
    parseCronExpression(trimmed);
    return trimmed;
  }

  private getPromptRow(id: string): ScheduledPromptRow | null {
    const rows = this.sql
      .exec("SELECT * FROM scheduled_prompts WHERE id = ?", id)
      .toArray() as unknown as ScheduledPromptRow[];
    return rows[0] ?? null;
  }

  private getAutomationRow(id: string): DeterministicAutomationRow | null {
    const rows = this.sql
      .exec("SELECT * FROM deterministic_automations WHERE id = ?", id)
      .toArray() as unknown as DeterministicAutomationRow[];
    return rows[0] ?? null;
  }

  private getAutomationRunRow(
    kind: AutomationRunKind,
    automationId: string,
    id: string,
  ): AutomationRunRow | null {
    const rows = this.sql
      .exec(
        `SELECT * FROM automation_runs
         WHERE id = ? AND kind = ? AND automation_id = ?`,
        id,
        kind,
        automationId,
      )
      .toArray() as unknown as AutomationRunRow[];
    return rows[0] ?? null;
  }

  private insertAutomationRun(input: {
    id: string;
    kind: AutomationRunKind;
    automationId: string;
    trigger: AutomationRunTrigger;
    status: AutomationRunStatus;
    startedAt: number;
    completedAt?: number | null;
    message?: string | null;
    threadId?: string | null;
    instanceId?: string | null;
  }): void {
    this.sql.exec(
      `INSERT INTO automation_runs
       (id, kind, automation_id, trigger, status, started_at, completed_at, message, thread_id, instance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.kind,
      input.automationId,
      input.trigger,
      input.status,
      input.startedAt,
      input.completedAt ?? null,
      input.message ?? null,
      input.threadId ?? null,
      input.instanceId ?? null,
      Date.now(),
    );
    this.trimAutomationRuns(input.kind, input.automationId);
  }

  private trimAutomationRuns(
    kind: AutomationRunKind,
    automationId: string,
  ): void {
    this.sql.exec(
      `DELETE FROM automation_runs
       WHERE kind = ? AND automation_id = ?
         AND id NOT IN (
           SELECT id FROM automation_runs
           WHERE kind = ? AND automation_id = ?
           ORDER BY started_at DESC, id DESC
           LIMIT ?
         )`,
      kind,
      automationId,
      kind,
      automationId,
      AUTOMATION_RUN_RETENTION,
    );
  }

  private updateAutomationRunById(input: {
    id: string;
    kind: AutomationRunKind;
    automationId: string;
    status: AutomationRunStatus;
    message?: string | null;
    completedAt?: number | null;
  }): boolean {
    const completedAt =
      input.completedAt === null
        ? null
        : typeof input.completedAt === "number" && Number.isFinite(input.completedAt)
          ? input.completedAt
          : input.status === "started" || input.status === "question"
            ? null
            : Date.now();
    const result = this.sql.exec(
      `UPDATE automation_runs
       SET status = ?, message = ?, completed_at = ?
       WHERE id = ? AND kind = ? AND automation_id = ?`,
      input.status,
      input.message ?? null,
      completedAt,
      input.id,
      input.kind,
      input.automationId,
    );
    return result.rowsWritten > 0;
  }

  private updateDeterministicRunByInstance(input: {
    automationId: string;
    instanceId: string;
    status: "success" | "error";
    message?: string | null;
    completedAt?: number | null;
  }): boolean {
    const completedAt =
      typeof input.completedAt === "number" && Number.isFinite(input.completedAt)
        ? input.completedAt
        : Date.now();
    const result = this.sql.exec(
      `UPDATE automation_runs
       SET status = ?, message = ?, completed_at = ?
       WHERE kind = 'deterministic_automation'
         AND automation_id = ?
         AND instance_id = ?`,
      input.status,
      input.message ?? null,
      completedAt,
      input.automationId,
      input.instanceId,
    );
    return result.rowsWritten > 0;
  }

  private insertAutomationVersion(
    workspaceId: string,
    automationId: string,
    sourceVersion: number,
    source: string,
    createdBy: string,
    createdAt: number,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO deterministic_automation_versions
       (automation_id, workspace_id, source_version, source, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      automationId,
      workspaceId,
      sourceVersion,
      source,
      createdBy,
      createdAt,
    );
  }

  private async getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo> {
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspaceId),
    ) as DurableObjectStub<WorkspaceDO>;
    const info = await workspaceStub.getInfo();
    if (!info || info.archived) {
      throw new Error("Workspace not found or archived");
    }
    return {
      id: info.id,
      org_id: info.org_id,
      archived: info.archived,
    };
  }

  async getWorkspaceInfoForAutomation(
    workspaceId: string,
  ): Promise<WorkspaceAutomationInfo> {
    this.assertWorkspaceIdentity(workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    return {
      id: workspace.id,
      org_id: workspace.org_id,
    };
  }

  private getOrgStub(orgId: string): DurableObjectStub<OrgDO> {
    return this.env.ORG.get(
      this.env.ORG.idFromName(orgId),
    ) as DurableObjectStub<OrgDO>;
  }

  private async getWorkspaceBillingLimits(
    workspace: WorkspaceInfo,
  ): Promise<BillingPlanLimits> {
    if (isSelfhostRuntime(this.env)) {
      return getBillingPlanLimits("enterprise", "enterprise");
    }

    const org = await this.getOrgStub(workspace.org_id).getInfo();
    return getBillingPlanLimits(org?.billing_plan, org?.billing_status);
  }

  private formatAutomationCountLimitMessage(
    limit: number,
    scope: "user" | "workspace",
    style: "assert" | "runtime",
  ): string {
    const subject =
      style === "assert" ? "Your current billing plan" : "your current plan";
    return `${subject} allows ${limit} automation${limit === 1 ? "" : "s"} per ${scope}.`;
  }

  private getCronBillingIntervalViolation(
    cronExpression: string,
    limits: BillingPlanLimits,
    style: "assert" | "runtime" = "assert",
  ): string | null {
    const minIntervalMs = limits.minCronIntervalMs;
    if (minIntervalMs === null) return null;

    const actualIntervalMs = getCronMinimumIntervalMs(cronExpression);
    if (actualIntervalMs !== null && actualIntervalMs < minIntervalMs) {
      const subject =
        style === "assert" ? "Your current billing plan" : "your current plan";
      return `${subject} allows automations no more frequent than every ${formatInterval(minIntervalMs)}.`;
    }
    return null;
  }

  private getEnabledAutomationLimitRows(
    createdBy: string | null,
  ): EnabledAutomationLimitRow[] {
    if (createdBy !== null) {
      return this.sql
        .exec(
          `SELECT 'scheduled_prompt' AS kind, id, created_by, created_at
           FROM scheduled_prompts
           WHERE enabled = 1 AND created_by = ?
           UNION ALL
           SELECT 'deterministic_automation' AS kind, id, created_by, created_at
           FROM deterministic_automations
           WHERE enabled = 1 AND created_by = ?
           ORDER BY created_at ASC, id ASC`,
          createdBy,
          createdBy,
        )
        .toArray() as unknown as EnabledAutomationLimitRow[];
    }

    return this.sql
      .exec(
        `SELECT 'scheduled_prompt' AS kind, id, created_by, created_at
         FROM scheduled_prompts
         WHERE enabled = 1
         UNION ALL
         SELECT 'deterministic_automation' AS kind, id, created_by, created_at
         FROM deterministic_automations
         WHERE enabled = 1
         ORDER BY created_at ASC, id ASC`,
      )
      .toArray() as unknown as EnabledAutomationLimitRow[];
  }

  private getAutomationCountViolation(
    kind: AutomationRunKind,
    automationId: string,
    createdBy: string,
    limits: BillingPlanLimits,
  ): string | null {
    const userLimit = limits.maxCronJobsPerUser;
    if (userLimit !== null) {
      const rows = this.getEnabledAutomationLimitRows(createdBy);
      if (rows.length <= userLimit) return null;
      const index = rows.findIndex(
        (row) => row.kind === kind && row.id === automationId,
      );
      if (index >= 0 && index < userLimit) return null;
      return this.formatAutomationCountLimitMessage(
        userLimit,
        "user",
        "runtime",
      );
    }

    const workspaceLimit = limits.maxCronJobsPerWorkspace;
    if (workspaceLimit !== null) {
      const rows = this.getEnabledAutomationLimitRows(null);
      if (rows.length <= workspaceLimit) return null;
      const index = rows.findIndex(
        (row) => row.kind === kind && row.id === automationId,
      );
      if (index >= 0 && index < workspaceLimit) return null;
      return this.formatAutomationCountLimitMessage(
        workspaceLimit,
        "workspace",
        "runtime",
      );
    }

    return null;
  }

  private getRuntimeBillingViolation(
    kind: AutomationRunKind,
    automationId: string,
    cronExpression: string,
    createdBy: string,
    limits: BillingPlanLimits,
  ): string | null {
    return (
      this.getCronBillingIntervalViolation(cronExpression, limits, "runtime") ??
      this.getAutomationCountViolation(kind, automationId, createdBy, limits)
    );
  }

  private formatScheduleDisabledByBillingMessage(message: string): string {
    return `${SCHEDULE_DISABLED_BY_BILLING_PREFIX} ${message}`;
  }

  private isScheduleDisabledByBillingMessage(
    message: string | null | undefined,
  ): boolean {
    return Boolean(message?.startsWith(SCHEDULE_DISABLED_BY_BILLING_PREFIX));
  }

  private formatSchedulePausedByBillingFailuresMessage(
    message: string,
  ): string {
    return `${SCHEDULE_PAUSED_BILLING_FAILURES_PREFIX} ${message}`;
  }

  private isSchedulePausedByBillingFailuresMessage(
    message: string | null | undefined,
  ): boolean {
    return Boolean(
      message?.startsWith(SCHEDULE_PAUSED_BILLING_FAILURES_PREFIX),
    );
  }

  /**
   * Whether a `last_run_error` summary records a billing-driven disable/pause
   * that a late-arriving success completion must not overwrite.
   */
  private isBillingProtectedSummaryMessage(
    message: string | null | undefined,
  ): boolean {
    return (
      this.isScheduleDisabledByBillingMessage(message) ||
      this.isSchedulePausedByBillingFailuresMessage(message)
    );
  }

  private async resolveDefaultThreadModel(
    workspace: WorkspaceInfo,
  ): Promise<LlmModel> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspace.id),
    ) as DurableObjectStub<WorkspaceDO>;
    const [
      llmProviderConfig,
      orgPickerConfig,
      workspacePickerConfig,
    ] = await Promise.all([
      retryTransientDurableObjectRead("OrgDO.getLlmProviderConfig", () =>
        Promise.resolve(orgStub.getLlmProviderConfig()),
      ),
      readOrgModelPickerConfig(orgStub),
      readWorkspaceModelPickerConfig(workspaceStub),
    ]);
    const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
      this.env,
      llmProviderConfig,
    );
    const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
    const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
    const effectiveConfig = resolveEffectivePickerConfig(
      orgPickerConfig,
      workspacePickerConfig,
    );
    const visibleCatalog = resolveModelPickerCatalog({
      effectiveConfig,
      orgProvider: effectiveLlmProviderConfig?.provider,
      customApi,
      customModelId,
      allowCamelCode: !isSelfhostRuntime(this.env),
    });
    const model = resolveDefaultModelForChat({
      effectiveDefaultModel: effectiveConfig.default_model,
      fallbackModel: getDefaultLlmModel(effectiveLlmProviderConfig?.provider, {
        customApi,
        customModelId,
      }),
      visibleCatalog,
    });
    if (!model) {
      throw new Error("No models are available");
    }
    return model;
  }

  private async assertCronWithinBillingLimits(
    workspace: WorkspaceInfo,
    cronExpression: string,
    createdBy: string,
    existingPromptId?: string,
  ): Promise<void> {
    const limits = await this.getWorkspaceBillingLimits(workspace);
    const intervalViolation = this.getCronBillingIntervalViolation(
      cronExpression,
      limits,
    );
    if (intervalViolation) {
      throw new Error(intervalViolation);
    }

    if (limits.maxCronJobsPerUser !== null) {
      const scheduledPromptCount =
        this.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM scheduled_prompts
           WHERE created_by = ? AND enabled = 1 AND id != ?`,
            createdBy,
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const automationCount =
        this.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM deterministic_automations
           WHERE created_by = ? AND enabled = 1 AND id != ?`,
            createdBy,
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const count = scheduledPromptCount + automationCount;
      if (count >= limits.maxCronJobsPerUser) {
        throw new Error(
          this.formatAutomationCountLimitMessage(
            limits.maxCronJobsPerUser,
            "user",
            "assert",
          ),
        );
      }
      return;
    }

    if (limits.maxCronJobsPerWorkspace !== null) {
      const scheduledPromptCount =
        this.sql
          .exec<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM scheduled_prompts WHERE enabled = 1 AND id != ?",
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const automationCount =
        this.sql
          .exec<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM deterministic_automations WHERE enabled = 1 AND id != ?",
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const count = scheduledPromptCount + automationCount;
      if (count >= limits.maxCronJobsPerWorkspace) {
        throw new Error(
          this.formatAutomationCountLimitMessage(
            limits.maxCronJobsPerWorkspace,
            "workspace",
            "assert",
          ),
        );
      }
    }
  }

  private async createInitialThreadForPrompt(
    workspace: WorkspaceInfo,
    name: string,
    prompt: string,
    createdBy: string,
  ): Promise<string> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const model = await this.resolveDefaultThreadModel(workspace);
    const created = (await orgStub.createThread(
      workspace.id,
      `Scheduled: ${name}`,
      createdBy || "system",
      prompt.slice(0, 500),
      model,
      { source: "scheduled" },
    )) as OrgThread;
    return created.id;
  }

  private async ensureRunnableThread(
    prompt: WorkspaceScheduledPrompt,
    workspace: WorkspaceInfo,
  ): Promise<string> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const existing = (await orgStub.getThread(
      prompt.thread_id,
    )) as OrgThread | null;
    if (existing && existing.workspace_id === workspace.id) {
      return prompt.thread_id;
    }

    const model = await this.resolveDefaultThreadModel(workspace);
    const created = (await orgStub.createThread(
      workspace.id,
      `Scheduled: ${prompt.name}`,
      "system",
      prompt.prompt.slice(0, 500),
      model,
      { source: "scheduled" },
    )) as OrgThread;

    this.sql.exec(
      "UPDATE scheduled_prompts SET thread_id = ?, updated_at = ? WHERE id = ?",
      created.id,
      Date.now(),
      prompt.id,
    );
    return created.id;
  }

  private buildScheduledMessage(
    prompt: WorkspaceScheduledPrompt,
    scheduledForMs: number,
  ): string {
    const scheduledForIso = new Date(scheduledForMs).toISOString();
    const originThreadId = prompt.scheduled_by_thread_id ?? "unknown";
    return [
      `<camelai system message>Scheduled prompt "${prompt.name}" fired at ${scheduledForIso} UTC. Origin scheduler thread/session id: ${originThreadId}. Use this id to search prior context from when this cron was created.</camelai system message>`,
      prompt.prompt,
    ].join("\n\n");
  }

  private async dispatchPrompt(
    prompt: WorkspaceScheduledPrompt,
    workspace: WorkspaceInfo,
    scheduledForMs: number,
    trigger: AutomationRunTrigger,
    runId: string,
  ): Promise<DispatchResult> {
    const threadId = await this.ensureRunnableThread(prompt, workspace);
    this.insertAutomationRun({
      id: runId,
      kind: "scheduled_prompt",
      automationId: prompt.id,
      trigger,
      status: "started",
      startedAt: scheduledForMs,
      threadId,
    });
    if (!this.env.CHAT_THREAD) {
      return {
        status: "error",
        error: "Chat thread binding is not configured",
        threadId,
      };
    }
    const chatThreadStub = this.env.CHAT_THREAD.get(
      this.env.CHAT_THREAD.idFromName(threadId),
    ) as unknown as InitialUserMessageRpc;

    try {
      const payload = await chatThreadStub.startInitialUserMessage({
        threadId,
        workspaceId: workspace.id,
        orgId: workspace.org_id,
        userName: "Scheduler",
        messageSource: "scheduled prompt",
        message: this.buildScheduledMessage(prompt, scheduledForMs),
        automationRun: {
          workspaceId: workspace.id,
          automationId: prompt.id,
          runId,
        },
      });
      switch (payload.status) {
        case "accepted":
          return {
            status: "success",
            threadId,
            accepted: true,
          };
        case "busy":
          return {
            status: "busy",
            error: "Thread is busy with another run",
            threadId,
          };
        case "error":
          return {
            status: "error",
            error:
              typeof payload.error === "string"
                ? payload.error
                : "Unknown chat error",
            threadId,
          };
        default:
          return {
            status: "error",
            error: "Unexpected response from chat thread",
            threadId,
          };
      }
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        threadId,
      };
    }
  }

  async validateDeterministicAutomationSource(
    source: string,
  ): Promise<ValidateDeterministicAutomationResult> {
    const errors: string[] = [];
    const normalized = this.parseAutomationSource(source);
    if (!/\bexport\s+class\s+AutomationWorkflow\s+extends\s+WorkflowEntrypoint\b/.test(normalized)) {
      errors.push(
        "source must export `class AutomationWorkflow extends WorkflowEntrypoint`",
      );
    }

    const loader = this.env.CODE_MODE_LOADER as
      | (WorkerLoader & { load?: (code: WorkerLoaderWorkerCode) => WorkerStub })
      | undefined;
    if (loader) {
      try {
        const workerCode: WorkerLoaderWorkerCode = {
          compatibilityDate: "2026-05-18",
          mainModule: "index.js",
          modules: {
            "index.js": { js: normalized },
          },
          env: {},
        };
        const worker =
          typeof loader.load === "function"
            ? loader.load(workerCode)
            : loader.get(`automation-validate-${crypto.randomUUID()}`, () => workerCode);
        worker.getEntrypoint("AutomationWorkflow");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private async assertValidDeterministicAutomationSource(
    source: string,
  ): Promise<void> {
    const result = await this.validateDeterministicAutomationSource(source);
    if (!result.valid) {
      throw new Error(`Invalid deterministic automation source: ${result.errors.join("; ")}`);
    }
  }

  private async dispatchDeterministicAutomation(
    automation: WorkspaceDeterministicAutomation,
    workspace: WorkspaceInfo,
    scheduledForMs: number,
    trigger: "schedule" | "manual",
    instanceId: string,
  ): Promise<DeterministicAutomationDispatchResult> {
    if (!this.env.DETERMINISTIC_AUTOMATION_WORKFLOWS) {
      return {
        status: "error",
        error: "Deterministic automation workflow binding is not configured",
      };
    }

    try {
      const workflow = wrapWorkflowBinding(
        {
          workspaceId: workspace.id,
          automationId: automation.id,
          sourceVersion: automation.source_version,
        },
        { bindingName: AUTOMATION_WORKFLOW_BINDING },
      ) as Workflow;
      await workflow.create({
        id: instanceId,
        params: {
          workspaceId: workspace.id,
          workflowId: automation.id,
          workflowName: automation.name,
          automationId: automation.id,
          automationName: automation.name,
          scheduledFor: new Date(scheduledForMs).toISOString(),
          triggeredAt: new Date().toISOString(),
          trigger,
        },
      });
      return {
        status: "started",
        instanceId,
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT MIN(next_run_at) AS next_run_at
         FROM (
           SELECT next_run_at
           FROM scheduled_prompts
           WHERE enabled = 1 AND next_run_at IS NOT NULL
           UNION ALL
           SELECT next_run_at
           FROM deterministic_automations
           WHERE enabled = 1 AND next_run_at IS NOT NULL
         )`,
      )
      .toArray() as Array<{ next_run_at: number | null }>;

    const nextRunAt = rows[0]?.next_run_at ?? null;
    if (!nextRunAt) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    // Floor at now+1s so a just-due or slightly-past next_run_at cannot arm a
    // tight 0-delay loop if the handler returns without advancing schedules.
    await this.ctx.storage.setAlarm(Math.max(now + 1000, nextRunAt));
  }

  async listScheduledPrompts(
    workspaceId: string,
  ): Promise<WorkspaceScheduledPrompt[]> {
    this.assertWorkspaceIdentity(workspaceId);
    const rows = this.sql
      .exec("SELECT * FROM scheduled_prompts ORDER BY created_at DESC")
      .toArray() as unknown as ScheduledPromptRow[];
    return rows.map((row) => this.toPrompt(row));
  }

  async listDeterministicAutomations(
    workspaceId: string,
  ): Promise<WorkspaceDeterministicAutomation[]> {
    this.assertWorkspaceIdentity(workspaceId);
    const rows = this.sql
      .exec("SELECT * FROM deterministic_automations ORDER BY created_at DESC")
      .toArray() as unknown as DeterministicAutomationRow[];
    return rows.map((row) => this.toAutomation(row));
  }

  async listAutomationRuns(
    workspaceId: string,
    input: { limitPerAutomation?: number } = {},
  ): Promise<Record<`${AutomationRunKind}:${string}`, AutomationRunRecord[]>> {
    this.assertWorkspaceIdentity(workspaceId);
    const limitPerAutomation = Math.max(
      1,
      Math.min(20, Math.floor(input.limitPerAutomation ?? 5)),
    );
    const rows = this.sql
      .exec(
        `SELECT *
         FROM automation_runs
         ORDER BY kind ASC, automation_id ASC, started_at DESC, id DESC`,
      )
      .toArray() as unknown as AutomationRunRow[];
    const result: Record<`${AutomationRunKind}:${string}`, AutomationRunRecord[]> = {};
    for (const row of rows) {
      const key = `${row.kind}:${row.automation_id}` as const;
      const existing = result[key] ?? [];
      if (existing.length >= limitPerAutomation) continue;
      existing.push(this.toAutomationRun(row));
      result[key] = existing;
    }
    return result;
  }

  /**
   * Keyset-paginated run history for a single automation, newest first.
   * Pages by (started_at DESC, id DESC) so results are stable as new runs
   * arrive. Returns `nextCursor = null` once the history is exhausted.
   */
  async listAutomationRunsPage(
    workspaceId: string,
    input: {
      kind: AutomationRunKind;
      automationId: string;
      limit?: number;
      cursor?: AutomationRunCursor | null;
    },
  ): Promise<{ runs: AutomationRunRecord[]; nextCursor: AutomationRunCursor | null }> {
    this.assertWorkspaceIdentity(workspaceId);
    const automationId = input.automationId.trim();
    if (!automationId) {
      throw new Error("automationId is required");
    }
    const limit = Math.max(
      1,
      Math.min(
        AUTOMATION_RUNS_PAGE_MAX,
        Math.floor(input.limit ?? AUTOMATION_RUNS_PAGE_SIZE),
      ),
    );
    const cursor = input.cursor ?? null;
    // Fetch one extra row to detect whether another page exists.
    const rows = (
      cursor
        ? this.sql.exec(
            `SELECT * FROM automation_runs
             WHERE kind = ? AND automation_id = ?
               AND (started_at < ? OR (started_at = ? AND id < ?))
             ORDER BY started_at DESC, id DESC
             LIMIT ?`,
            input.kind,
            automationId,
            cursor.startedAt,
            cursor.startedAt,
            cursor.id,
            limit + 1,
          )
        : this.sql.exec(
            `SELECT * FROM automation_runs
             WHERE kind = ? AND automation_id = ?
             ORDER BY started_at DESC, id DESC
             LIMIT ?`,
            input.kind,
            automationId,
            limit + 1,
          )
    ).toArray() as unknown as AutomationRunRow[];

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const runs = pageRows.map((row) => this.toAutomationRun(row));
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last ? { startedAt: last.started_at, id: last.id } : null;
    return { runs, nextCursor };
  }

  async getDeterministicAutomationSource(
    workspaceId: string,
    automationId: string,
    sourceVersion?: number | null,
  ): Promise<DeterministicAutomationSourceSnapshot | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const trimmedId = automationId.trim();
    if (!trimmedId) {
      throw new Error("automationId is required");
    }

    if (typeof sourceVersion === "number" && Number.isFinite(sourceVersion)) {
      const rows = this.sql
        .exec(
          `SELECT automation_id, workspace_id, source_version, source, created_by, created_at
           FROM deterministic_automation_versions
           WHERE automation_id = ? AND source_version = ? AND workspace_id = ?`,
          trimmedId,
          Math.floor(sourceVersion),
          workspaceId,
        )
        .toArray() as unknown as DeterministicAutomationVersionRow[];
      const row = rows[0];
      if (!row) return null;
      return {
        automation_id: row.automation_id,
        workspace_id: row.workspace_id,
        source_version: row.source_version,
        source: row.source,
        created_by: row.created_by,
      };
    }

    const row = this.getAutomationRow(trimmedId);
    if (!row) return null;
    return {
      automation_id: row.id,
      workspace_id: workspaceId,
      source_version: row.source_version,
      source: row.source,
      created_by: row.created_by,
    };
  }

  async createScheduledPrompt(
    input: CreateScheduledPromptInput,
  ): Promise<WorkspaceScheduledPrompt> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const name = this.parseName(input.name);
    const prompt = this.parsePrompt(input.prompt);
    const cronExpression = this.normalizeCronExpression(input.cronExpression);
    const createdBy = input.createdBy?.trim() || "system";
    const scheduledByThreadId = this.parseOptionalThreadId(
      input.scheduledByThreadId,
    );
    const enabled = input.enabled ?? true;
    if (enabled) {
      await this.assertCronWithinBillingLimits(
        workspace,
        cronExpression,
        createdBy,
      );
    }

    const now = Date.now();
    const nextRunAt = enabled ? getNextCronRunAt(cronExpression, now) : null;
    if (enabled && !nextRunAt) {
      throw new Error(
        "Unable to compute next run time for this cron expression",
      );
    }
    const threadId = await this.createInitialThreadForPrompt(
      workspace,
      name,
      prompt,
      createdBy,
    );

    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO scheduled_prompts
       (id, name, prompt, cron_expression, thread_id, scheduled_by_thread_id, enabled, created_by, created_at, updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
      id,
      name,
      prompt,
      cronExpression,
      threadId,
      scheduledByThreadId,
      enabled ? 1 : 0,
      createdBy,
      now,
      now,
      nextRunAt,
    );

    await this.scheduleNextAlarm();
    const created = this.getPromptRow(id);
    if (!created) {
      throw new Error("Failed to create scheduled prompt");
    }
    return this.toPrompt(created);
  }

  async createDeterministicAutomation(
    input: CreateDeterministicAutomationInput,
  ): Promise<WorkspaceDeterministicAutomation> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const name = this.parseName(input.name);
    const description = this.parseDescription(input.description);
    const source = this.parseAutomationSource(input.source);
    await this.assertValidDeterministicAutomationSource(source);
    const cronExpression = this.normalizeCronExpression(input.cronExpression);
    const createdBy = input.createdBy?.trim() || "system";
    const enabled = input.enabled ?? true;
    if (enabled) {
      await this.assertCronWithinBillingLimits(
        workspace,
        cronExpression,
        createdBy,
      );
    }

    const now = Date.now();
    const nextRunAt = enabled ? getNextCronRunAt(cronExpression, now) : null;
    if (enabled && !nextRunAt) {
      throw new Error(
        "Unable to compute next run time for this cron expression",
      );
    }

    const id = crypto.randomUUID();
    const sourceVersion = 1;
    this.sql.exec(
      `INSERT INTO deterministic_automations
       (id, name, description, source, source_version, cron_expression, enabled, created_by, created_at, updated_at, next_run_at, last_run_at, last_run_status, last_run_error, last_instance_id, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
      id,
      name,
      description,
      source,
      sourceVersion,
      cronExpression,
      enabled ? 1 : 0,
      createdBy,
      now,
      now,
      nextRunAt,
    );
    this.insertAutomationVersion(
      workspaceId,
      id,
      sourceVersion,
      source,
      createdBy,
      now,
    );

    await this.scheduleNextAlarm();
    const created = this.getAutomationRow(id);
    if (!created) {
      throw new Error("Failed to create deterministic automation");
    }
    return this.toAutomation(created);
  }

  async updateScheduledPrompt(
    input: UpdateScheduledPromptInput,
  ): Promise<WorkspaceScheduledPrompt | null> {
    this.assertWorkspaceIdentity(input.workspaceId);
    const existing = this.getPromptRow(input.id);
    if (!existing) return null;

    const workspace = await this.getWorkspaceInfo(input.workspaceId);
    const existingPrompt = this.toPrompt(existing);
    const name =
      input.name !== undefined
        ? this.parseName(input.name)
        : existingPrompt.name;
    const prompt =
      input.prompt !== undefined
        ? this.parsePrompt(input.prompt)
        : existingPrompt.prompt;
    const cronExpression =
      input.cronExpression !== undefined
        ? this.normalizeCronExpression(input.cronExpression)
        : existingPrompt.cron_expression;
    const enabled =
      input.enabled !== undefined ? input.enabled : existingPrompt.enabled;
    if (enabled) {
      await this.assertCronWithinBillingLimits(
        workspace,
        cronExpression,
        existingPrompt.created_by,
        existingPrompt.id,
      );
    }

    const now = Date.now();
    let nextRunAt: number | null;
    if (!enabled) {
      nextRunAt = null;
    } else {
      const cronChanged = cronExpression !== existingPrompt.cron_expression;
      const needsRecompute =
        !existingPrompt.enabled ||
        cronChanged ||
        existingPrompt.next_run_at === null;
      nextRunAt = needsRecompute
        ? getNextCronRunAt(cronExpression, now)
        : existingPrompt.next_run_at;
      if (!nextRunAt) {
        throw new Error(
          "Unable to compute next run time for this cron expression",
        );
      }
    }

    // Re-enabling grants a fresh run of billing-failure attempts (e.g. after
    // topping up credits), so the auto-pause streak resets with it.
    const reenabling = enabled && !existingPrompt.enabled;
    this.sql.exec(
      `UPDATE scheduled_prompts
       SET name = ?, prompt = ?, cron_expression = ?, enabled = ?, updated_at = ?, next_run_at = ?, consecutive_billing_failures = ?
       WHERE id = ?`,
      name,
      prompt,
      cronExpression,
      enabled ? 1 : 0,
      now,
      nextRunAt,
      reenabling ? 0 : (existing.consecutive_billing_failures ?? 0),
      existingPrompt.id,
    );
    if (
      reenabling &&
      this.isSchedulePausedByBillingFailuresMessage(existing.last_run_error)
    ) {
      recordObservabilityEvent(this.env, {
        event: "scheduled_prompt_resumed",
        component: OBSERVABILITY_COMPONENT,
        operation: "update",
        status: "resumed",
        threadId: existing.thread_id,
        workspaceId: workspace.id,
        orgId: workspace.org_id,
      });
    }

    await this.scheduleNextAlarm();
    const updated = this.getPromptRow(existingPrompt.id);
    return updated ? this.toPrompt(updated) : null;
  }

  async updateDeterministicAutomation(
    input: UpdateDeterministicAutomationInput,
  ): Promise<WorkspaceDeterministicAutomation | null> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const existing = this.getAutomationRow(input.id);
    if (!existing) return null;

    const workspace = await this.getWorkspaceInfo(workspaceId);
    const existingAutomation = this.toAutomation(existing);
    if (
      input.expectedSourceVersion !== undefined &&
      input.expectedSourceVersion !== existingAutomation.source_version
    ) {
      throw new Error(
        `Automation edit conflict: expected source version ${input.expectedSourceVersion}, ` +
        `found ${existingAutomation.source_version}. Read it again and retry.`,
      );
    }
    const name =
      input.name !== undefined
        ? this.parseName(input.name)
        : existingAutomation.name;
    const description =
      input.description !== undefined
        ? this.parseDescription(input.description)
        : existingAutomation.description;
    const source =
      input.source !== undefined
        ? this.parseAutomationSource(input.source)
        : existingAutomation.source;
    if (input.source !== undefined && source !== existingAutomation.source) {
      await this.assertValidDeterministicAutomationSource(source);
    }
    const cronExpression =
      input.cronExpression !== undefined
        ? this.normalizeCronExpression(input.cronExpression)
        : existingAutomation.cron_expression;
    const enabled =
      input.enabled !== undefined ? input.enabled : existingAutomation.enabled;
    if (enabled) {
      await this.assertCronWithinBillingLimits(
        workspace,
        cronExpression,
        existingAutomation.created_by,
        existingAutomation.id,
      );
    }

    const now = Date.now();
    const sourceChanged = source !== existingAutomation.source;
    const sourceVersion = sourceChanged
      ? existingAutomation.source_version + 1
      : existingAutomation.source_version;
    let nextRunAt: number | null;
    if (!enabled) {
      nextRunAt = null;
    } else {
      const cronChanged =
        cronExpression !== existingAutomation.cron_expression;
      const needsRecompute =
        !existingAutomation.enabled ||
        cronChanged ||
        existingAutomation.next_run_at === null;
      nextRunAt = needsRecompute
        ? getNextCronRunAt(cronExpression, now)
        : existingAutomation.next_run_at;
      if (!nextRunAt) {
        throw new Error(
          "Unable to compute next run time for this cron expression",
        );
      }
    }

    const updateResult = input.expectedSourceVersion === undefined
      ? this.sql.exec(
          `UPDATE deterministic_automations
           SET name = ?, description = ?, source = ?, source_version = ?, cron_expression = ?, enabled = ?, updated_at = ?, next_run_at = ?
           WHERE id = ?`,
          name,
          description,
          source,
          sourceVersion,
          cronExpression,
          enabled ? 1 : 0,
          now,
          nextRunAt,
          existingAutomation.id,
        )
      : this.sql.exec(
          `UPDATE deterministic_automations
           SET name = ?, description = ?, source = ?, source_version = ?, cron_expression = ?, enabled = ?, updated_at = ?, next_run_at = ?
           WHERE id = ? AND source_version = ?`,
          name,
          description,
          source,
          sourceVersion,
          cronExpression,
          enabled ? 1 : 0,
          now,
          nextRunAt,
          existingAutomation.id,
          input.expectedSourceVersion,
        );
    if (updateResult.rowsWritten === 0 && input.expectedSourceVersion !== undefined) {
      throw new Error(
        `Automation edit conflict: source version ${input.expectedSourceVersion} changed while the edit was running. ` +
        "Read it again and retry.",
      );
    }
    if (sourceChanged) {
      this.insertAutomationVersion(
        workspaceId,
        existingAutomation.id,
        sourceVersion,
        source,
        existingAutomation.created_by,
        now,
      );
    }

    await this.scheduleNextAlarm();
    const updated = this.getAutomationRow(existingAutomation.id);
    return updated ? this.toAutomation(updated) : null;
  }

  async deleteScheduledPrompt(
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    this.assertWorkspaceIdentity(workspaceId);
    const existing = this.getPromptRow(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM scheduled_prompts WHERE id = ?", id);
    this.sql.exec(
      "DELETE FROM automation_runs WHERE kind = 'scheduled_prompt' AND automation_id = ?",
      id,
    );
    await this.scheduleNextAlarm();
    return true;
  }

  async deleteDeterministicAutomation(
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    this.assertWorkspaceIdentity(workspaceId);
    const existing = this.getAutomationRow(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM deterministic_automations WHERE id = ?", id);
    this.sql.exec(
      "DELETE FROM automation_runs WHERE kind = 'deterministic_automation' AND automation_id = ?",
      id,
    );
    await this.scheduleNextAlarm();
    return true;
  }

  async disableAllScheduledPrompts(
    workspaceId: string,
    reason = "disabled",
  ): Promise<void> {
    this.assertWorkspaceIdentity(workspaceId);
    const now = Date.now();
    this.sql.exec(
      `UPDATE scheduled_prompts
       SET enabled = 0, next_run_at = NULL, updated_at = ?, last_run_error = ?
       WHERE enabled = 1`,
      now,
      reason,
    );
    this.sql.exec(
      `UPDATE deterministic_automations
       SET enabled = 0, next_run_at = NULL, updated_at = ?, last_run_error = ?
       WHERE enabled = 1`,
      now,
      reason,
    );
    await this.ctx.storage.deleteAlarm();
  }

  async runScheduledPromptNow(
    workspaceId: string,
    id: string,
  ): Promise<RunScheduledPromptNowResult | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const existingRow = this.getPromptRow(id);
    if (!existingRow) return null;
    const existing = this.toPrompt(existingRow);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const limits = await this.getWorkspaceBillingLimits(workspace);
    const runStartedAt = Date.now();
    const runId = crypto.randomUUID();
    const dispatch = await this.dispatchPrompt(
      existing,
      workspace,
      runStartedAt,
      "manual",
      runId,
    );
    if (!dispatch.accepted) {
      this.updateAutomationRunById({
        id: runId,
        kind: "scheduled_prompt",
        automationId: existing.id,
        status: dispatch.status,
        message: dispatch.error ?? null,
      });
    }

    const scheduleDisableReason = existing.enabled
      ? this.getRuntimeBillingViolation(
          "scheduled_prompt",
          existing.id,
          existing.cron_expression,
          existing.created_by,
          limits,
        )
      : null;
    let nextRunAt = existing.next_run_at;
    if (
      existing.enabled &&
      !scheduleDisableReason &&
      (!nextRunAt || nextRunAt <= runStartedAt)
    ) {
      nextRunAt = getNextCronRunAt(existing.cron_expression, runStartedAt);
    }
    const enabledAfterRun = existing.enabled && !scheduleDisableReason;
    const billingDisabledMessage = scheduleDisableReason
      ? this.formatScheduleDisabledByBillingMessage(scheduleDisableReason)
      : null;

    this.sql.exec(
      `UPDATE scheduled_prompts
       SET thread_id = ?, updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_id = ?, last_run_status = ?, last_run_error = ?, run_count = run_count + 1
       WHERE id = ?`,
      dispatch.threadId,
      Date.now(),
      enabledAfterRun ? 1 : 0,
      enabledAfterRun ? nextRunAt : null,
      runStartedAt,
      runId,
      billingDisabledMessage ? "error" : dispatch.status,
      billingDisabledMessage ?? dispatch.error ?? null,
      existing.id,
    );

    if (!dispatch.accepted) {
      // The run failed to start, so this is its final outcome; accepted runs
      // report theirs later through recordScheduledPromptRunResult.
      await this.applyScheduledRunOutcome(existing.id, {
        status: dispatch.status,
        message: dispatch.error ?? null,
        trigger: "manual",
        workspaceId,
        orgId: workspace.org_id,
      });
    }

    await this.scheduleNextAlarm();
    const updated = this.getPromptRow(existing.id);
    if (!updated) return null;
    return {
      prompt: this.toPrompt(updated),
      dispatch: {
        status: dispatch.status,
        thread_id: dispatch.threadId,
        error: dispatch.error,
      },
    };
  }

  async runDeterministicAutomationNow(
    workspaceId: string,
    id: string,
  ): Promise<RunDeterministicAutomationNowResult | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const existingRow = this.getAutomationRow(id);
    if (!existingRow) return null;
    const existing = this.toAutomation(existingRow);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const limits = await this.getWorkspaceBillingLimits(workspace);
    const runStartedAt = Date.now();

    const scheduleDisableReason = existing.enabled
      ? this.getRuntimeBillingViolation(
          "deterministic_automation",
          existing.id,
          existing.cron_expression,
          existing.created_by,
          limits,
        )
      : null;
    let nextRunAt = existing.next_run_at;
    if (
      existing.enabled &&
      !scheduleDisableReason &&
      (!nextRunAt || nextRunAt <= runStartedAt)
    ) {
      nextRunAt = getNextCronRunAt(existing.cron_expression, runStartedAt);
    }
    const enabledAfterRun = existing.enabled && !scheduleDisableReason;
    const billingDisabledMessage = scheduleDisableReason
      ? this.formatScheduleDisabledByBillingMessage(scheduleDisableReason)
      : null;

    let dispatch: DeterministicAutomationDispatchResult;
    if (!this.env.DETERMINISTIC_AUTOMATION_WORKFLOWS) {
      dispatch = {
        status: "error",
        error: "Deterministic automation workflow binding is not configured",
      };
      this.insertAutomationRun({
        id: crypto.randomUUID(),
        kind: "deterministic_automation",
        automationId: existing.id,
        trigger: "manual",
        status: "error",
        startedAt: runStartedAt,
        completedAt: Date.now(),
        message: dispatch.error,
      });
      this.sql.exec(
        `UPDATE deterministic_automations
         SET updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = ?, run_count = run_count + 1
         WHERE id = ?`,
        Date.now(),
        enabledAfterRun ? 1 : 0,
        enabledAfterRun ? nextRunAt : null,
        runStartedAt,
        dispatch.status,
        billingDisabledMessage ?? dispatch.error ?? null,
        null,
        existing.id,
      );
    } else {
      const instanceId = crypto.randomUUID();
      this.insertAutomationRun({
        id: crypto.randomUUID(),
        kind: "deterministic_automation",
        automationId: existing.id,
        trigger: "manual",
        status: "started",
        startedAt: runStartedAt,
        instanceId,
      });
      this.sql.exec(
        `UPDATE deterministic_automations
         SET updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = ?, run_count = run_count + 1
         WHERE id = ?`,
        Date.now(),
        enabledAfterRun ? 1 : 0,
        enabledAfterRun ? nextRunAt : null,
        runStartedAt,
        billingDisabledMessage ? "error" : "started",
        billingDisabledMessage,
        instanceId,
        existing.id,
      );
      dispatch = await this.dispatchDeterministicAutomation(
        existing,
        workspace,
        runStartedAt,
        "manual",
        instanceId,
      );
      if (dispatch.status === "error") {
        this.updateDeterministicRunByInstance({
          automationId: existing.id,
          instanceId,
          status: "error",
          message: dispatch.error ?? "Workflow start failed",
        });
        if (billingDisabledMessage) {
          this.sql.exec(
            `UPDATE deterministic_automations
             SET updated_at = ?, last_instance_id = NULL
             WHERE id = ? AND last_instance_id = ?`,
            Date.now(),
            existing.id,
            instanceId,
          );
        } else {
          this.sql.exec(
            `UPDATE deterministic_automations
             SET updated_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = NULL
             WHERE id = ? AND last_instance_id = ? AND last_run_status = 'started'`,
            Date.now(),
            dispatch.status,
            dispatch.error ?? "Workflow start failed",
            existing.id,
            instanceId,
          );
        }
      }
    }

    await this.scheduleNextAlarm();
    const updated = this.getAutomationRow(existing.id);
    if (!updated) return null;
    return {
      automation: this.toAutomation(updated),
      dispatch: {
        status: dispatch.status,
        instance_id: dispatch.instanceId,
        error: dispatch.error,
      },
    };
  }

  /**
   * Update the consecutive-billing-failure streak for a scheduled prompt after
   * a run outcome is known, auto-pausing the schedule once the streak reaches
   * {@link SCHEDULED_PROMPT_BILLING_FAILURE_PAUSE_THRESHOLD}.
   *
   * Semantics:
   * - "success" / "question" reset the streak to 0.
   * - "error" with a billing-classified message increments the streak.
   * - "busy" and non-billing errors leave the streak unchanged (transient).
   *
   * Callers must only invoke this for the prompt's current run (never for a
   * stale late completion), so the streak reflects consecutive outcomes.
   */
  private async applyScheduledRunOutcome(
    promptId: string,
    outcome: {
      status: RunStatus;
      message: string | null;
      trigger: AutomationRunTrigger;
      workspaceId: string;
      orgId?: string | null;
    },
  ): Promise<void> {
    const prompt = this.getPromptRow(promptId);
    if (!prompt) return;

    if (outcome.status === "success" || outcome.status === "question") {
      if ((prompt.consecutive_billing_failures ?? 0) !== 0) {
        this.sql.exec(
          "UPDATE scheduled_prompts SET consecutive_billing_failures = 0 WHERE id = ?",
          promptId,
        );
      }
      return;
    }

    if (outcome.status !== "error") return;
    const message = outcome.message?.trim();
    if (!message || !isChatBillingOrCreditError(message)) return;

    const streak = (prompt.consecutive_billing_failures ?? 0) + 1;
    this.sql.exec(
      "UPDATE scheduled_prompts SET consecutive_billing_failures = ? WHERE id = ?",
      streak,
      promptId,
    );
    recordObservabilityEvent(this.env, {
      event: "scheduled_prompt_billing_failure",
      severity: "warn",
      component: OBSERVABILITY_COMPONENT,
      operation: outcome.trigger,
      status: "billing_failure",
      threadId: prompt.thread_id,
      workspaceId: outcome.workspaceId,
      orgId: outcome.orgId ?? null,
      errorMessage: message,
      count: streak,
    });

    if (
      streak < SCHEDULED_PROMPT_BILLING_FAILURE_PAUSE_THRESHOLD ||
      prompt.enabled !== 1
    ) {
      return;
    }

    const pausedMessage =
      this.formatSchedulePausedByBillingFailuresMessage(message);
    this.sql.exec(
      `UPDATE scheduled_prompts
       SET enabled = 0, next_run_at = NULL, updated_at = ?, last_run_status = 'error', last_run_error = ?
       WHERE id = ? AND enabled = 1`,
      Date.now(),
      pausedMessage,
      promptId,
    );
    await this.scheduleNextAlarm();

    let orgId = outcome.orgId ?? null;
    if (!orgId) {
      try {
        orgId = (await this.getWorkspaceInfo(outcome.workspaceId)).org_id;
      } catch {
        // The pause itself must not depend on the org lookup succeeding.
      }
    }
    recordObservabilityEvent(this.env, {
      event: "scheduled_prompt_auto_paused",
      severity: "warn",
      component: OBSERVABILITY_COMPONENT,
      operation: outcome.trigger,
      status: "paused",
      threadId: prompt.thread_id,
      workspaceId: outcome.workspaceId,
      orgId,
      errorMessage: message,
      count: streak,
    });

    this.ctx.waitUntil(
      this.notifyScheduledPromptPaused(prompt, outcome.workspaceId, message).catch(
        (error) => {
          console.warn(
            "[WorkspaceCronDO] scheduled prompt pause notification failed",
            {
              promptId,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        },
      ),
    );
  }

  /**
   * Best-effort email to the schedule creator when a scheduled prompt is
   * auto-paused after repeated billing failures. Degrades to a no-op when the
   * creator has no resolvable profile/email or email bindings are unset.
   */
  private async notifyScheduledPromptPaused(
    prompt: ScheduledPromptRow,
    workspaceId: string,
    billingErrorMessage: string,
  ): Promise<void> {
    const createdBy = prompt.created_by?.trim();
    if (!createdBy || createdBy === "system") return;

    const userStub = this.env.USER.get(
      this.env.USER.idFromName(createdBy),
    ) as DurableObjectStub<UserDO>;
    const profile = await userStub.getProfile();
    const email = profile?.email?.trim();
    if (!email) return;

    let workspaceName: string | null = null;
    try {
      const workspaceStub = this.env.WORKSPACE.get(
        this.env.WORKSPACE.idFromName(workspaceId),
      ) as DurableObjectStub<WorkspaceDO>;
      workspaceName = (await workspaceStub.getInfo())?.name ?? null;
    } catch {
      // Name is cosmetic; send the notification without it.
    }

    let automationsUrl: string | null = null;
    const baseUrl = this.env.WORKER_BASE_URL?.trim();
    if (baseUrl) {
      try {
        automationsUrl = new URL("/automations", baseUrl).toString();
      } catch {
        automationsUrl = null;
      }
    }

    const result = await sendScheduledPromptPausedEmail({
      env: {
        EMAIL: this.env.EMAIL,
        EMAIL_FROM_ADDRESS: this.env.EMAIL_FROM_ADDRESS,
      },
      to: email,
      scheduleName: prompt.name,
      workspaceName,
      billingError: billingErrorMessage,
      automationsUrl,
    });
    if (result.status === "failed") {
      console.warn("[WorkspaceCronDO] scheduled prompt pause email failed", {
        promptId: prompt.id,
        reason: result.reason,
      });
    }
  }

  async recordScheduledPromptRunResult(
    input: RecordScheduledPromptRunResultInput,
  ): Promise<boolean> {
    this.assertWorkspaceIdentity(input.workspaceId);
    const promptId = input.promptId.trim();
    const runId = input.runId.trim();
    if (!promptId) {
      throw new Error("promptId is required");
    }
    if (!runId) {
      throw new Error("runId is required");
    }
    if (
      input.status !== "success" &&
      input.status !== "error" &&
      input.status !== "question" &&
      input.status !== "busy"
    ) {
      throw new Error("status must be success, error, question, or busy");
    }

    const message = input.message?.trim() || null;
    const runUpdated = this.updateAutomationRunById({
      id: runId,
      kind: "scheduled_prompt",
      automationId: promptId,
      status: input.status,
      message,
      completedAt:
        input.completedAt === undefined && input.status === "question"
          ? null
          : input.completedAt,
    });
    if (!runUpdated) return false;
    const runRow = this.getAutomationRunRow("scheduled_prompt", promptId, runId);
    if (!runRow) return true;

    const now = Date.now();
    const currentPrompt = this.getPromptRow(promptId);
    // Any completion that lands after the schedule was disabled or auto-paused
    // for billing must leave that summary alone: it is the reason the schedule
    // stopped, it is what `auto_paused` derives from, and it is what the user
    // has to act on. A run can report more than once (a late duplicate, or a
    // turn that fails asynchronously after the pause was written), and letting
    // an unrelated later error overwrite the summary strands the schedule
    // disabled with no explanation. The run row itself still records the real
    // status/message above, so no detail is lost.
    const preserveBillingDisabledSummary =
      currentPrompt?.enabled === 0 &&
      currentPrompt.last_run_status === "error" &&
      this.isBillingProtectedSummaryMessage(currentPrompt.last_run_error);
    if (preserveBillingDisabledSummary) {
      this.sql.exec(
        `UPDATE scheduled_prompts
         SET updated_at = ?
         WHERE id = ?
           AND (
             last_run_id = ?
             OR (last_run_id IS NULL AND last_run_at = ?)
           )`,
        now,
        promptId,
        runId,
        runRow.started_at,
      );
      return true;
    }

    const summaryUpdate = this.sql.exec(
      `UPDATE scheduled_prompts
       SET updated_at = ?, last_run_status = ?, last_run_error = ?
       WHERE id = ?
         AND (
           last_run_id = ?
           OR (last_run_id IS NULL AND last_run_at = ?)
         )`,
      now,
      input.status,
      input.status === "error" || input.status === "busy" ? message : null,
      promptId,
      runId,
      runRow.started_at,
    );
    // Only the prompt's current run may move the billing-failure streak; a
    // stale late completion (guarded UPDATE wrote no row) must not touch it.
    if (summaryUpdate.rowsWritten > 0) {
      await this.applyScheduledRunOutcome(promptId, {
        status: input.status,
        message,
        trigger: runRow.trigger,
        workspaceId: input.workspaceId,
      });
    }
    return true;
  }

  async recordDeterministicAutomationRunResult(
    input: RecordDeterministicAutomationRunResultInput,
  ): Promise<boolean> {
    this.assertWorkspaceIdentity(input.workspaceId);
    const automationId = input.automationId.trim();
    const instanceId = input.instanceId.trim();
    if (!automationId) {
      throw new Error("automationId is required");
    }
    if (!instanceId) {
      throw new Error("instanceId is required");
    }
    if (input.status !== "success" && input.status !== "error") {
      throw new Error("status must be success or error");
    }

    const runUpdated = this.updateDeterministicRunByInstance({
      automationId,
      instanceId,
      status: input.status,
      message: input.status === "error" ? input.error ?? "Workflow failed" : null,
    });

    const now = Date.now();
    const currentAutomation = this.getAutomationRow(automationId);
    const preserveBillingDisabledSummary =
      input.status === "success" &&
      currentAutomation?.enabled === 0 &&
      currentAutomation.last_run_status === "error" &&
      this.isScheduleDisabledByBillingMessage(
        currentAutomation.last_run_error,
      );

    if (preserveBillingDisabledSummary) {
      this.sql.exec(
        `UPDATE deterministic_automations
         SET updated_at = ?
         WHERE id = ? AND last_instance_id = ?`,
        now,
        automationId,
        instanceId,
      );
    } else {
      this.sql.exec(
        `UPDATE deterministic_automations
         SET updated_at = ?, last_run_status = ?, last_run_error = ?
         WHERE id = ? AND last_instance_id = ?`,
        now,
        input.status,
        input.status === "error" ? input.error ?? "Workflow failed" : null,
        automationId,
        instanceId,
      );
    }

    return runUpdated;
  }

  async runDueAutomationsForTest(workspaceId: string): Promise<void> {
    this.assertWorkspaceIdentity(workspaceId);
    await this.alarm();
  }

  /**
   * Whether any scheduled prompt or deterministic automation is actually due as
   * of `now`. Used so a spurious early alarm (or race after another writer
   * advanced next_run_at) never takes the destructive "workspace unavailable"
   * disable path on a transient failure.
   */
  private hasDueScheduledWork(now: number): boolean {
    const row = this.sql
      .exec(
        `SELECT
           (SELECT COUNT(*) FROM scheduled_prompts
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?)
         + (SELECT COUNT(*) FROM deterministic_automations
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?) AS due_count`,
        now,
        now,
      )
      .toArray()[0] as { due_count: number } | undefined;
    return (row?.due_count ?? 0) > 0;
  }

  async alarm(): Promise<void> {
    const workspaceId = this.getStoredWorkspaceId();
    if (!workspaceId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    // Only a wake with actually-due work may take the destructive disable path
    // below; a spurious early alarm must not tear down future schedules.
    const hasDueWork = this.hasDueScheduledWork(now);

    let workspace: WorkspaceInfo;
    try {
      workspace = await this.getWorkspaceInfo(workspaceId);
    } catch (error) {
      console.warn("[WorkspaceCronDO] workspace unavailable", {
        workspaceId,
        hasDueWork,
        error: error instanceof Error ? error.message : String(error),
      });
      if (hasDueWork) {
        await this.disableAllScheduledPrompts(
          workspaceId,
          "workspace_unavailable",
        );
        return;
      }
      // Nothing due yet: don't disable on a transient failure. Re-arm so the
      // real run time gets its own (destructive-on-failure) attempt.
      await this.scheduleNextAlarm();
      return;
    }

    if (!hasDueWork) {
      // Spurious/early wake: nothing is due. Re-arm for the next real run.
      await this.scheduleNextAlarm();
      return;
    }

    const limits = await this.getWorkspaceBillingLimits(workspace);
    const dueRows = this.sql
      .exec(
        `SELECT * FROM scheduled_prompts
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
        now,
        MAX_DUE_JOBS_PER_ALARM,
      )
      .toArray() as unknown as ScheduledPromptRow[];

    for (const row of dueRows) {
      const prompt = this.toPrompt(row);
      const runStartedAt = Date.now();
      const scheduledFor = prompt.next_run_at ?? runStartedAt;
      const runId = crypto.randomUUID();
      const billingViolation = this.getRuntimeBillingViolation(
        "scheduled_prompt",
        prompt.id,
        prompt.cron_expression,
        prompt.created_by,
        limits,
      );
      if (billingViolation) {
        const errorMessage = `Blocked by billing plan: ${billingViolation}`;
        this.insertAutomationRun({
          id: runId,
          kind: "scheduled_prompt",
          automationId: prompt.id,
          trigger: "schedule",
          status: "error",
          startedAt: scheduledFor,
          completedAt: Date.now(),
          message: errorMessage,
        });
        this.sql.exec(
          `UPDATE scheduled_prompts
           SET updated_at = ?, enabled = 0, next_run_at = NULL, last_run_at = ?, last_run_id = ?, last_run_status = ?, last_run_error = ?, run_count = run_count + 1
           WHERE id = ?`,
          Date.now(),
          runStartedAt,
          runId,
          "error",
          errorMessage,
          prompt.id,
        );
        continue;
      }

      const dispatch = await this.dispatchPrompt(
        prompt,
        workspace,
        scheduledFor,
        "schedule",
        runId,
      );
      if (!dispatch.accepted) {
        this.updateAutomationRunById({
          id: runId,
          kind: "scheduled_prompt",
          automationId: prompt.id,
          status: dispatch.status,
          message: dispatch.error ?? null,
        });
      }
      const nextRunAt = getNextCronRunAt(prompt.cron_expression, runStartedAt);
      const enabledAfterRun = Boolean(nextRunAt);

      this.sql.exec(
        `UPDATE scheduled_prompts
         SET thread_id = ?, updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_id = ?, last_run_status = ?, last_run_error = ?, run_count = run_count + 1
         WHERE id = ?`,
        dispatch.threadId,
        Date.now(),
        enabledAfterRun ? 1 : 0,
        nextRunAt,
        runStartedAt,
        runId,
        dispatch.status,
        dispatch.error ?? (!enabledAfterRun ? "No future run found" : null),
        prompt.id,
      );
      if (!dispatch.accepted) {
        // The run failed to start, so this is its final outcome; accepted runs
        // report theirs later through recordScheduledPromptRunResult.
        await this.applyScheduledRunOutcome(prompt.id, {
          status: dispatch.status,
          message: dispatch.error ?? null,
          trigger: "schedule",
          workspaceId,
          orgId: workspace.org_id,
        });
      }
    }

    const dueAutomationRows = this.sql
      .exec(
        `SELECT * FROM deterministic_automations
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
        now,
        MAX_DUE_JOBS_PER_ALARM,
      )
      .toArray() as unknown as DeterministicAutomationRow[];

    for (const row of dueAutomationRows) {
      const automation = this.toAutomation(row);
      const runStartedAt = Date.now();
      const scheduledFor = automation.next_run_at ?? runStartedAt;
      const billingViolation = this.getRuntimeBillingViolation(
        "deterministic_automation",
        automation.id,
        automation.cron_expression,
        automation.created_by,
        limits,
      );

      if (billingViolation) {
        const errorMessage = `Blocked by billing plan: ${billingViolation}`;
        this.insertAutomationRun({
          id: crypto.randomUUID(),
          kind: "deterministic_automation",
          automationId: automation.id,
          trigger: "schedule",
          status: "error",
          startedAt: scheduledFor,
          completedAt: Date.now(),
          message: errorMessage,
        });
        this.sql.exec(
          `UPDATE deterministic_automations
           SET updated_at = ?, enabled = 0, next_run_at = NULL, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = NULL, run_count = run_count + 1
           WHERE id = ?`,
          Date.now(),
          runStartedAt,
          "error",
          errorMessage,
          automation.id,
        );
        continue;
      }

      const nextRunAt = getNextCronRunAt(
        automation.cron_expression,
        runStartedAt,
      );
      const enabledAfterRun = Boolean(nextRunAt);

      if (!this.env.DETERMINISTIC_AUTOMATION_WORKFLOWS) {
        this.insertAutomationRun({
          id: crypto.randomUUID(),
          kind: "deterministic_automation",
          automationId: automation.id,
          trigger: "schedule",
          status: "error",
          startedAt: scheduledFor,
          completedAt: Date.now(),
          message:
            "Deterministic automation workflow binding is not configured",
        });
        this.sql.exec(
          `UPDATE deterministic_automations
           SET updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = ?, run_count = run_count + 1
           WHERE id = ?`,
          Date.now(),
          enabledAfterRun ? 1 : 0,
          nextRunAt,
          runStartedAt,
          "error",
          "Deterministic automation workflow binding is not configured",
          null,
          automation.id,
        );
      } else {
        const instanceId = crypto.randomUUID();
        this.insertAutomationRun({
          id: crypto.randomUUID(),
          kind: "deterministic_automation",
          automationId: automation.id,
          trigger: "schedule",
          status: "started",
          startedAt: scheduledFor,
          message: !enabledAfterRun ? "No future run found" : null,
          instanceId,
        });
        this.sql.exec(
          `UPDATE deterministic_automations
           SET updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = ?, run_count = run_count + 1
           WHERE id = ?`,
          Date.now(),
          enabledAfterRun ? 1 : 0,
          nextRunAt,
          runStartedAt,
          "started",
          !enabledAfterRun ? "No future run found" : null,
          instanceId,
          automation.id,
        );
        const dispatch = await this.dispatchDeterministicAutomation(
          automation,
          workspace,
          scheduledFor,
          "schedule",
          instanceId,
        );
        if (dispatch.status === "error") {
          this.updateDeterministicRunByInstance({
            automationId: automation.id,
            instanceId,
            status: "error",
            message: dispatch.error ?? "Workflow start failed",
          });
          this.sql.exec(
            `UPDATE deterministic_automations
             SET updated_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = NULL
             WHERE id = ? AND last_instance_id = ? AND last_run_status = 'started'`,
            Date.now(),
            dispatch.status,
            dispatch.error ?? "Workflow start failed",
            automation.id,
            instanceId,
          );
        }
      }
    }

    await this.scheduleNextAlarm();
  }
}
