/**
 * Scheduled prompts on the agent runtime: a run's turn starts with
 * startRuntimeTurn, as the prompt's creator (the scheduler acts for them). The run's id is the turn's request
 * id, so its run.completed / run.failed webhook finds the run
 * (routes/agent-runtime-events.ts), and the outcome the agent reports with
 * report_automation_outcome is kept on the run in WorkspaceCronDO.
 */
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import { RUNTIME_TOOL_PREFIX } from "../../../../src/lib/agent-runtime-shared.js";
import { runtimeApi } from "./runtime-api.js";
import { directRuntimeRow, moveThreadForSend, type UnmovableReason } from "./thread-migration.js";
import { runtimeDirectThreadsEnabled, startRuntimeTurn } from "./thread-runtime.js";

/** What a scheduled run must do before it ends, naming the outcome tool as the run's agent has it. */
export function automationOutcomeInstruction(toolName: string, howToCall = ""): string {
  return [
    "## Scheduled Automation Outcome",
    `Before your final response, you MUST call \`${toolName}\` exactly once.${howToCall}`,
    "Use `success` only when the requested business objective was actually completed and verified. A clean turn, partial data extraction, or a decision not to deploy is not success.",
    "Use `failed` when the objective was not completed, `partial` when only part completed, and `needs_attention` when operator action is required. Give a concise factual summary.",
  ].join("\n");
}

/** As a runtime agent has the tool (camel__<tool>, in js_exec too). */
const RUNTIME_OUTCOME_TOOL = `${RUNTIME_TOOL_PREFIX}report_automation_outcome`;
export const RUNTIME_AUTOMATION_OUTCOME_INSTRUCTION = automationOutcomeInstruction(
  RUNTIME_OUTCOME_TOOL,
  ` From js_exec: await tools.${RUNTIME_OUTCOME_TOOL}({ status, summary }).`,
);

export interface ScheduledTurnRequest {
  orgId: string;
  workspaceId: string;
  threadId: string;
  /** The prompt's creator, who the run acts for. */
  userId: string;
  runId: string;
  /** The scheduled message ("Scheduled prompt … fired at …" and the prompt). */
  message: string;
}

/** "unmovable": the prompt's thread can never move to the runtime (`reason`); the scheduler gives it a new one. */
export type ScheduledTurnResult =
  | { status: "accepted" | "busy" | "error"; error?: string }
  | { status: "unmovable"; reason: UnmovableReason };

/** Whether the agent is in a turn, which a scheduled run must not steer into. */
async function agentRunning(env: ChatEnv, agentId: string): Promise<boolean> {
  const state = await runtimeApi(env, "GET", `/v1/agents/${encodeURIComponent(agentId)}/state`) as {
    requests?: Array<{ state?: string; method?: string }>;
  } | null;
  return (state?.requests ?? []).some((request) =>
    request.state === "running" && ["prompt", "continue", "resume"].includes(request.method ?? ""));
}

/**
 * Start a scheduled run's turn on the runtime; null when its thread cannot run
 * there (its move is under way elsewhere, failed, or cannot happen). A thread
 * the old in-DO loop relayed to a runtime agent is adopted between turns, and
 * any other thread still on ChatThreadDO moves first.
 */
export async function startScheduledRuntimeTurn(env: ChatEnv, request: ScheduledTurnRequest): Promise<ScheduledTurnResult | null> {
  if (!runtimeDirectThreadsEnabled(env)) return null;
  const context: ChatContextState = {
    orgId: request.orgId,
    workspaceId: request.workspaceId,
    threadId: request.threadId,
    userId: request.userId,
    userName: "Scheduler",
    userEmail: null,
  };
  let row = await directRuntimeRow(env, request.orgId, request.threadId, { adopt: true });
  if (!row) {
    const moved = await moveThreadForSend(env, context);
    if (!moved.row && moved.outcome.state === "readonly") return { status: "unmovable", reason: moved.outcome.reason };
    row = moved.row;
  }
  if (!row) return null;
  if (row.agentId && await agentRunning(env, row.agentId)) {
    return { status: "busy", error: "Thread is busy with another run" };
  }
  const pending: Promise<unknown>[] = [];
  const result = await startRuntimeTurn(env, {
    context,
    row,
    sender: { userId: request.userId, userName: "Scheduler", userEmail: null },
    text: `<camelai system message>${RUNTIME_AUTOMATION_OUTCOME_INSTRUCTION}</camelai system message>\n\n${request.message}`,
    clientMessageId: request.runId,
    source: "scheduled prompt",
    waitUntil: (promise) => { pending.push(promise); },
  });
  await Promise.allSettled(pending);
  return result.status === "accepted" ? { status: "accepted" } : { status: result.status, error: result.error };
}
