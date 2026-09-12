// Durable scheduled-run state and result reporting to WorkspaceCronDO.
import type { WorkspaceCronDO } from "../workspace-cron";
import type { SyncKvStorage } from "./pi-turn-journal";

export const CHAT_ACTIVE_AUTOMATION_RUN_KEY = "activeAutomationRun";

export interface ActiveAutomationRunState {
  workspaceId: string;
  automationId: string;
  runId: string;
  requiresExplicitOutcome?: boolean;
  reportedOutcome?: {
    status: "success" | "failed" | "partial" | "needs_attention";
    summary: string;
  };
}

// The slice of the DO's env the automation-run cluster touches: the
// WorkspaceCronDO namespace scheduled-run results are reported to.
export interface ChatThreadAutomationRunEnv {
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
}

export interface ChatThreadAutomationRunDeps {
  env(): ChatThreadAutomationRunEnv;
  kv(): SyncKvStorage;
  /** DurableObjectState#waitUntil for fire-and-forget result reporting. */
  waitUntil(promise: Promise<unknown>): void;
  // Mutable DO turn-state field, exposed as read/write operations (never the
  // DO itself): the in-memory active-run lock (its KV mirror is written via
  // kv() by setActiveAutomationRun).
  activeAutomationRun(): ActiveAutomationRunState | null;
  setActiveAutomationRunField(value: ActiveAutomationRunState | null): void;
  // DO-side operations (shared helpers whose behavior is owned elsewhere).
  isThreadStreaming(): boolean;
  pendingBrowserQuestionCount(): number;
}

export class ChatThreadAutomationRun {
  constructor(private readonly deps: ChatThreadAutomationRunDeps) {}

  normalizeActiveAutomationRun(value: unknown): ActiveAutomationRunState | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const workspaceId =
      typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
    const automationId =
      typeof record.automationId === "string" ? record.automationId.trim() : "";
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    if (!workspaceId || !automationId || !runId) return null;
    const requiresExplicitOutcome = record.requiresExplicitOutcome === true;
    const rawOutcome = record.reportedOutcome;
    let reportedOutcome: ActiveAutomationRunState["reportedOutcome"];
    if (rawOutcome && typeof rawOutcome === "object" && !Array.isArray(rawOutcome)) {
      const outcome = rawOutcome as Record<string, unknown>;
      const status = outcome.status;
      const summary = typeof outcome.summary === "string" ? outcome.summary.trim() : "";
      if (
        (status === "success" ||
          status === "failed" ||
          status === "partial" ||
          status === "needs_attention") &&
        summary
      ) {
        reportedOutcome = { status, summary };
      }
    }
    return {
      workspaceId,
      automationId,
      runId,
      ...(requiresExplicitOutcome ? { requiresExplicitOutcome: true } : {}),
      ...(reportedOutcome ? { reportedOutcome } : {}),
    };
  }

  setActiveAutomationRun(value: ActiveAutomationRunState | null): void {
    this.deps.setActiveAutomationRunField(value);
    if (value) {
      this.deps.kv().put(CHAT_ACTIVE_AUTOMATION_RUN_KEY, value);
    } else {
      this.deps.kv().delete(CHAT_ACTIVE_AUTOMATION_RUN_KEY);
    }
  }

  recordScheduledAutomationRun(
    run: ActiveAutomationRunState,
    input: {
      status: "success" | "error" | "question" | "busy";
      message?: string | null;
      completedAt?: number | null;
    },
  ): Promise<boolean> {
    if (!this.deps.env().WORKSPACE_CRON) return Promise.resolve(false);
    const cronStub = this.deps.env().WORKSPACE_CRON!.get(
      this.deps.env().WORKSPACE_CRON!.idFromName(run.workspaceId),
    ) as DurableObjectStub<WorkspaceCronDO>;
    return cronStub.recordScheduledPromptRunResult({
      workspaceId: run.workspaceId,
      promptId: run.automationId,
      runId: run.runId,
      status: input.status,
      message: input.message ?? null,
      completedAt: input.completedAt,
    });
  }

  updateActiveAutomationRun(input: {
    status: "success" | "error" | "question" | "busy";
    message?: string | null;
    completedAt?: number | null;
    clear?: boolean;
  }): void {
    const run = this.deps.activeAutomationRun();
    if (!run) return;
    if (input.clear) {
      this.setActiveAutomationRun(null);
    }
    this.deps.waitUntil(
      this.recordScheduledAutomationRun(run, input).catch((error) => {
        console.error(
          "[ChatThreadDO] failed to record scheduled automation run",
          error,
        );
        return false;
      }),
    );
  }

  reconcileInactiveAutomationRun(reason: string): boolean {
    if (
      !this.deps.activeAutomationRun() ||
      this.deps.isThreadStreaming() ||
      this.deps.pendingBrowserQuestionCount() > 0
    ) {
      return false;
    }
    this.updateActiveAutomationRun({
      status: "error",
      message: reason,
      completedAt: Date.now(),
      clear: true,
    });
    return true;
  }
}
