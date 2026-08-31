import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VerifiedWorkEvidence } from "./chat-thread/verified-work-state";
import { repairPiMessageHistoryForReplay } from "./pi-message-history";

/**
 * Durable resume for an interrupted Pi turn (Flue-style: append-only journal +
 * wake-time reconcile).
 *
 * `pi_core_messages` is the committed store — `turn_end` commits each completed
 * turn. The only window not yet committed is the *in-flight* turn, which we
 * mirror into a per-turn journal (the uncommitted tail of
 * `agent.state.messages`) at every `message_end` / `tool_execution_end`.
 *
 * On a cold load after a mid-turn eviction (e.g. a deploy), we fold the
 * committed history and the journal tail back together, reconcile any tool call
 * that was dispatched but never produced a result, and decide whether the model
 * still owes output so the caller can drive `Agent.continue()`.
 *
 * Reconcile rules (mirroring Flue):
 *  - completed tool results are kept verbatim and never re-run;
 *  - a `tool_use` with no recorded result is surfaced to the model as an
 *    interrupted, unknown-outcome `toolResult` (via
 *    {@link repairPiMessageHistoryForReplay}'s synthetic-result path) rather
 *    than blindly re-executing a possibly side-effecting tool;
 *  - signed reasoning blocks are reordered ahead of tool calls, never dropped.
 */
export interface PiTurnResumePlan {
  /**
   * Provider-valid transcript = committed history + journal tail, repaired
   * (interrupted results synthesized, reasoning reordered ahead of tool calls).
   * Seed this into `agent.state.messages` before resuming.
   */
  messages: AgentMessage[];
  /**
   * True when the model still owes a response — i.e. the reconciled transcript
   * ends in a `user` or `toolResult` message, which is exactly the precondition
   * `Agent.continue()` requires. When false, the turn already produced its final
   * assistant message (nothing to resume).
   */
  owesModelOutput: boolean;
  /** Tool calls that were dispatched but never recorded a result (now interrupted). */
  interruptedToolResults: number;
  /** Reasoning/text blocks reordered back ahead of tool calls (class-A fix). */
  reorderedAssistantBlocks: number;
  /** True when reconcile changed the transcript at all (vs. a clean resume). */
  changed: boolean;
}

function lastRole(messages: AgentMessage[]): string | undefined {
  const last = messages[messages.length - 1] as unknown as
    | Record<string, unknown>
    | undefined;
  return typeof last?.role === "string" ? last.role : undefined;
}

/**
 * Fold the durable committed history and the in-flight journal tail into a
 * single resume plan. Pure: no storage, no agent — the DO wiring supplies the
 * two message arrays and acts on the result.
 */
export function planPiTurnResume(
  committedMessages: AgentMessage[],
  journalTail: AgentMessage[],
  verifiedWork: VerifiedWorkEvidence[] = [],
): PiTurnResumePlan {
  const repaired = repairPiMessageHistoryForReplay([
    ...committedMessages,
    ...journalTail,
  ], verifiedWork);
  const role = lastRole(repaired.messages);
  return {
    messages: repaired.messages,
    owesModelOutput: role === "user" || role === "toolResult",
    interruptedToolResults: repaired.stats.syntheticToolResults,
    reorderedAssistantBlocks: repaired.stats.reorderedAssistantBlocks,
    changed: repaired.repairedCount > 0 || journalTail.length > 0,
  };
}
