import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { parseTurnCheckpoint } from "./turn-checkpoint";

export const AUTOMATION_OUTCOME_TOOL = "report_automation_outcome";
export type AutomationOutcomeStatus = "success" | "failed" | "partial" | "needs_attention";
export interface AutomationRunInput {
  workspaceId: string;
  automationId: string;
  runId: string;
  requiresExplicitOutcome?: boolean;
}
export interface DurableAutomationRun extends AutomationRunInput {
  reportedOutcome?: { status: AutomationOutcomeStatus; summary: string };
  reportAttempts?: number;
  reportDeadlineAt?: number;
}
export interface AutomationRunReport {
  turnId: string;
  workspaceId: string;
  automationId: string;
  runId: string;
  attempt: number;
  deadlineAt: number;
  status: "success" | "error";
  message: string | null;
  completedAt: number;
}

const OUTCOMES = new Set<AutomationOutcomeStatus>([
  "success", "failed", "partial", "needs_attention",
]);

export function parseAutomationRun(raw: string | null): DurableAutomationRun | null {
  if (!raw) return null;
  try {
    const run = JSON.parse(raw) as DurableAutomationRun;
    return run && typeof run.workspaceId === "string" &&
      typeof run.automationId === "string" && typeof run.runId === "string"
      ? run : null;
  } catch {
    return null;
  }
}

export function normalizeAutomationOutcome(value: unknown):
  DurableAutomationRun["reportedOutcome"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { status, summary: valueSummary } = value as Record<string, unknown>;
  const summary = typeof valueSummary === "string" ? valueSummary.trim() : "";
  return OUTCOMES.has(status as AutomationOutcomeStatus) && summary &&
    summary.length <= CHAT_RUNTIME_BOUNDS.automationSummaryChars
    ? { status: status as AutomationOutcomeStatus, summary } : null;
}

export function checkpointAutomationOutcome(checkpointJson: string) {
  let outcome: DurableAutomationRun["reportedOutcome"];
  try {
    for (const batch of parseTurnCheckpoint(checkpointJson).batches) {
      for (const call of batch.calls) {
        if (call.name !== AUTOMATION_OUTCOME_TOOL || call.result?.status !== "success") continue;
        const next = normalizeAutomationOutcome(JSON.parse(call.inputJson));
        if (!next || outcome) return undefined;
        outcome = next;
      }
    }
  } catch {
    return undefined;
  }
  return outcome;
}

export function terminalAutomation(
  run: DurableAutomationRun | null,
  checkpointJson: string,
  at: number,
): DurableAutomationRun | null {
  return run && {
    ...run,
    ...(run.requiresExplicitOutcome
      ? { reportedOutcome: checkpointAutomationOutcome(checkpointJson) }
      : {}),
    reportAttempts: 0,
    reportDeadlineAt: at + CHAT_RUNTIME_BOUNDS.automationReportDeadlineMs,
  };
}

export function automationReportResult(
  status: string,
  assistantError: string | null,
  run: DurableAutomationRun,
): Pick<AutomationRunReport, "status" | "message"> {
  if (status !== "completed") {
    return { status: "error", message: (assistantError || "Automation turn failed")
      .slice(0, CHAT_RUNTIME_BOUNDS.automationSummaryChars) };
  }
  if (!run.requiresExplicitOutcome) return { status: "success", message: null };
  const outcome = run.reportedOutcome;
  if (!outcome) return { status: "error", message: "Automation completed without explicitly reporting an outcome" };
  return {
    status: outcome.status === "success" ? "success" : "error",
    message: (outcome.status === "success" ? outcome.summary : `[${outcome.status}] ${outcome.summary}`)
      .slice(0, CHAT_RUNTIME_BOUNDS.automationSummaryChars),
  };
}
