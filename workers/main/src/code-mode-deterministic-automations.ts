import type { AutomationRunRecord, WorkspaceCronDO } from "./workspace-cron";

/**
 * Flatten one stored automation run into an agent-friendly shape: a plain status
 * (`started` = still running, `success`, `error`), ISO timestamps, the computed
 * `duration_ms`, and the error message (if any). Pure + unit-testable.
 */
export function formatAutomationRun(run: AutomationRunRecord): Record<string, unknown> {
  const durationMs =
    run.completed_at != null ? Math.max(0, run.completed_at - run.started_at) : null;
  return {
    instance_id: run.instance_id,
    status: run.status,
    trigger: run.trigger,
    started_at: new Date(run.started_at).toISOString(),
    completed_at: run.completed_at != null ? new Date(run.completed_at).toISOString() : null,
    duration_ms: durationMs,
    error: run.status === "error" ? run.message : null,
  };
}

interface CodeModeDeterministicAutomationsOptions {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  userId?: string;
}

interface DeterministicAutomationRecord {
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
  last_run_status: string | null;
  last_run_error: string | null;
  last_instance_id: string | null;
  run_count: number;
}

function getWorkflowId(args: Record<string, unknown>): string {
  const value = typeof args.workflow_id === "string" ? args.workflow_id : "";
  return value.trim();
}

function formatDeterministicAutomation(
  automation: DeterministicAutomationRecord,
  includeSource = false,
): Record<string, unknown> {
  return {
    id: automation.id,
    workflow_id: automation.id,
    name: automation.name,
    description: automation.description,
    ...(includeSource ? { source: automation.source } : {}),
    source_version: automation.source_version,
    cron_expression: automation.cron_expression,
    enabled: automation.enabled,
    created_by: automation.created_by,
    created_at: new Date(automation.created_at).toISOString(),
    updated_at: new Date(automation.updated_at).toISOString(),
    next_run_at: automation.next_run_at
      ? new Date(automation.next_run_at).toISOString()
      : null,
    last_run_at: automation.last_run_at
      ? new Date(automation.last_run_at).toISOString()
      : null,
    last_run_status: automation.last_run_status,
    last_run_error: automation.last_run_error,
    last_instance_id: automation.last_instance_id,
    run_count: automation.run_count,
    virtual_path: `/workspace/.camelai/automations/${automation.id}.js`,
  };
}

export class CodeModeDeterministicAutomations {
  constructor(
    private readonly options: CodeModeDeterministicAutomationsOptions,
  ) {}

  async list(): Promise<unknown> {
    const automations = await this.options.cronStub.listDeterministicAutomations(
      this.options.workspaceId,
    );
    const workflows = automations.map((automation) =>
      formatDeterministicAutomation(automation),
    );
    return {
      success: true,
      count: automations.length,
      timezone: "UTC",
      workflows,
    };
  }

  async validate(args: Record<string, unknown>): Promise<unknown> {
    const source = typeof args.source === "string" ? args.source : "";
    const result =
      await this.options.cronStub.validateDeterministicAutomationSource(source);
    return { success: result.valid, valid: result.valid, errors: result.errors };
  }

  async create(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args.name === "string" ? args.name : "";
    const source = typeof args.source === "string" ? args.source : "";
    const cronExpression =
      typeof args.cron_expression === "string" ? args.cron_expression : "";
    const description =
      typeof args.description === "string" ? args.description : "";
    if (!name.trim()) throw new Error("name is required");
    if (!source.trim()) throw new Error("source is required");
    if (!cronExpression.trim()) throw new Error("cron_expression is required");
    if (!description.trim()) throw new Error("description is required");
    const created = await this.options.cronStub.createDeterministicAutomation({
      workspaceId: this.options.workspaceId,
      name,
      source,
      cronExpression,
      createdBy: this.options.userId || "system",
      description,
      enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    });
    return {
      success: true,
      timezone: "UTC",
      workflow: formatDeterministicAutomation(created, true),
      message: `Created workflow "${created.name}"`,
    };
  }

  async update(args: Record<string, unknown>): Promise<unknown> {
    const automationId = getWorkflowId(args);
    if (!automationId) throw new Error("workflow_id is required");
    let description: string | undefined;
    if (Object.prototype.hasOwnProperty.call(args, "description")) {
      if (typeof args.description !== "string") {
        throw new Error("description must be a string");
      }
      description = args.description;
    }
    const updated = await this.options.cronStub.updateDeterministicAutomation({
      workspaceId: this.options.workspaceId,
      id: automationId,
      name: typeof args.name === "string" ? args.name : undefined,
      description,
      source: typeof args.source === "string" ? args.source : undefined,
      cronExpression:
        typeof args.cron_expression === "string"
          ? args.cron_expression
          : undefined,
      enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    });
    if (!updated) {
      return {
        success: false,
        error: `Workflow "${automationId}" not found`,
      };
    }
    return {
      success: true,
      timezone: "UTC",
      workflow: formatDeterministicAutomation(updated, true),
      message: `Updated workflow "${updated.name}"`,
    };
  }

  async delete(args: Record<string, unknown>): Promise<unknown> {
    const automationId = getWorkflowId(args);
    if (!automationId) throw new Error("workflow_id is required");
    const deleted = await this.options.cronStub.deleteDeterministicAutomation(
      this.options.workspaceId,
      automationId,
    );
    if (!deleted) {
      return {
        success: false,
        error: `Workflow "${automationId}" not found`,
      };
    }
    return {
      success: true,
      message: `Deleted workflow "${automationId}"`,
    };
  }

  async getRuns(args: Record<string, unknown>): Promise<unknown> {
    const automationId = getWorkflowId(args);
    if (!automationId) throw new Error("workflow_id is required");
    const requested = typeof args.limit === "number" ? Math.floor(args.limit) : 10;
    const limit = Math.max(1, Math.min(50, requested));
    const page = await this.options.cronStub.listAutomationRunsPage(
      this.options.workspaceId,
      { kind: "deterministic_automation", automationId, limit },
    );
    const runs = page.runs.map(formatAutomationRun);
    return {
      success: true,
      workflow_id: automationId,
      latest: runs[0] ?? null,
      runs,
    };
  }

  async runNow(args: Record<string, unknown>): Promise<unknown> {
    const automationId = getWorkflowId(args);
    if (!automationId) throw new Error("workflow_id is required");
    const result = await this.options.cronStub.runDeterministicAutomationNow(
      this.options.workspaceId,
      automationId,
    );
    if (!result) {
      return {
        success: false,
        error: `Workflow "${automationId}" not found`,
      };
    }
    const workflow = formatDeterministicAutomation(result.automation);
    return {
      success: true,
      timezone: "UTC",
      workflow,
      run: {
        status: result.dispatch.status,
        instance_id: result.dispatch.instance_id,
        error: result.dispatch.error,
      },
    };
  }
}
