// Automation-run state machine for ChatThreadDO, extracted as a collaborator:
// the persisted active scheduled-automation run lock (normalize / set /
// clear), result reporting back to the owning WorkspaceCronDO, and the
// stale-lock reconciliation that runs before a new automation start. All
// state lives on the owning DO (the activeAutomationRun field mirrored into
// KV storage); the class itself is stateless and is cached for the owning DO's
// lifetime with closures over its live deps (ChatThreadDO keeps thin same-named
// private delegates as its internal API). Sibling-method calls route back
// through the deps callbacks — i.e. through the DO's delegates — so dynamic
// dispatch (and every `ChatThreadDO.prototype['method'].call(fake)` test seam
// that stubs a sibling on the fake) behaves exactly as it did when the bodies
// lived on the DO.
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
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  setActiveAutomationRun(value: ActiveAutomationRunState | null): void;
  recordScheduledAutomationRun(
    run: ActiveAutomationRunState,
    input: {
      status: "success" | "error" | "question" | "busy";
      message?: string | null;
      completedAt?: number | null;
    },
  ): Promise<boolean>;
  updateActiveAutomationRun(input: {
    status: "success" | "error" | "question" | "busy";
    message?: string | null;
    completedAt?: number | null;
    clear?: boolean;
  }): void;
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
      this.deps.setActiveAutomationRun(null);
    }
    this.deps.waitUntil(
      this.deps.recordScheduledAutomationRun(run, input).catch((error) => {
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
    this.deps.updateActiveAutomationRun({
      status: "error",
      message: reason,
      completedAt: Date.now(),
      clear: true,
    });
    return true;
  }
}
