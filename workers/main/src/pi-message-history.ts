import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { VerifiedWorkEvidence } from "./chat-thread/verified-work-state";

export interface PiMessageHistoryRepairStats {
  droppedToolResults: number;
  syntheticToolResults: number;
  // Non-toolCall blocks (e.g. trailing thinking/reasoning emitted after a
  // tool call) moved back ahead of the tool calls in an assistant message.
  // Providers (and notably OpenRouter-wrapped Anthropic/Bedrock reasoning)
  // require thinking blocks to precede tool_use, so we REORDER rather than
  // delete — preserving signed/redacted reasoning verbatim.
  reorderedAssistantBlocks: number;
}

export interface PiMessageHistoryRepairResult {
  messages: AgentMessage[];
  stats: PiMessageHistoryRepairStats;
  repairedCount: number;
}

/**
 * Stands in for a tool call that was cut off before its result was committed —
 * a Durable Object reset mid-call, most often inside a long `js_exec`.
 *
 * The wording matters. It used to say only "no result was recorded", which the
 * model reasonably read as "it never ran" and retried blind. Production shows
 * that misreading: three interrupted `js_exec` deploys in one thread were each
 * re-run, and each deployed again. A redeploy is harmless, but the same
 * mechanism on `send_email` or a connection write sends twice, and there is no
 * idempotency guard keyed by tool-call id anywhere on the execution path.
 *
 * So be explicit that the outcome is UNKNOWN, not that nothing happened, and
 * tell the model to check state before repeating anything with a side effect.
 */
const INTERRUPTED_TOOL_RESULT_TEXT =
  "Tool call interrupted: its result was not recorded, so it MAY OR MAY NOT have completed. " +
  "If it had side effects (a deploy, an email, a write to an external system), check the current " +
  "state before running it again rather than assuming it did not run.";

export function repairPiMessageHistoryForReplay(
  messages: AgentMessage[],
  verifiedWork: VerifiedWorkEvidence[] = [],
): PiMessageHistoryRepairResult {
  const repaired: AgentMessage[] = [];
  let pendingToolCallIds: Map<string, number> | null = null;
  let pendingToolCallNames: Map<string, string> | null = null;
  let droppedToolResults = 0;
  let syntheticToolResults = 0;
  let reorderedAssistantBlocks = 0;

  const flushUnmatchedToolCalls = () => {
    if (!pendingToolCallIds) return;
    for (const [id, remaining] of pendingToolCallIds.entries()) {
      for (let i = 0; i < remaining; i++) {
        const toolName = pendingToolCallNames?.get(id) ?? "";
        const recovered = verifiedWork.find(
          (evidence) => evidence.id === id && evidence.toolName === toolName,
        );
        repaired.push({
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [
            {
              type: "text",
              text: recovered
                ? `Tool result recovered from durable completion evidence: ${JSON.stringify(recovered)}`
                : INTERRUPTED_TOOL_RESULT_TEXT,
            },
          ],
          isError: recovered?.status !== "succeeded",
          timestamp: Date.now(),
        } as unknown as AgentMessage);
        syntheticToolResults += 1;
      }
    }
    pendingToolCallIds = null;
    pendingToolCallNames = null;
  };

  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    if (record.role === "assistant") {
      flushUnmatchedToolCalls();
      const reordered = reorderAssistantToolCallsLast(message);
      reorderedAssistantBlocks += reordered.movedBlocks;
      repaired.push(reordered.message);
      if (record.stopReason === "error" || record.stopReason === "aborted") {
        continue;
      }
      const collected = collectToolCalls(reordered.message);
      pendingToolCallIds = collected?.ids ?? null;
      pendingToolCallNames = collected?.names ?? null;
      continue;
    }

    if (record.role === "toolResult") {
      const toolCallId = typeof record.toolCallId === "string"
        ? record.toolCallId.trim()
        : "";
      const remaining = toolCallId && pendingToolCallIds
        ? pendingToolCallIds.get(toolCallId) ?? 0
        : 0;
      if (remaining > 0) {
        pendingToolCallIds?.set(toolCallId, remaining - 1);
        repaired.push(message);
      } else {
        droppedToolResults += 1;
      }
      continue;
    }

    flushUnmatchedToolCalls();
    repaired.push(message);
  }

  flushUnmatchedToolCalls();

  const repairedCount = droppedToolResults + syntheticToolResults + reorderedAssistantBlocks;
  return {
    messages: repairedCount > 0 ? repaired : messages,
    stats: {
      droppedToolResults,
      syntheticToolResults,
      reorderedAssistantBlocks,
    },
    repairedCount,
  };
}

function collectToolCalls(
  message: AgentMessage,
): { ids: Map<string, number>; names: Map<string, string> } | null {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) return null;

  const ids = new Map<string, number>();
  const names = new Map<string, string>();
  for (const part of record.content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type !== "toolCall" || typeof item.id !== "string" || !item.id.trim()) {
      continue;
    }
    const id = item.id.trim();
    ids.set(id, (ids.get(id) ?? 0) + 1);
    if (typeof item.name === "string" && !names.has(id)) {
      names.set(id, item.name);
    }
  }
  return ids.size > 0 ? { ids, names } : null;
}

function isToolCallBlock(part: unknown): boolean {
  return (
    !!part &&
    typeof part === "object" &&
    (part as Record<string, unknown>).type === "toolCall"
  );
}

// Anthropic (and OpenRouter-wrapped Anthropic/Bedrock) require an assistant
// turn's thinking/reasoning blocks to precede its tool_use blocks, and reject
// turns whose content does not end on the tool calls. Some providers — OpenRouter
// with reasoning enabled in particular — emit a (signed, sometimes redacted)
// reasoning block AFTER the tool call, yielding e.g. [thinking, text, toolCall,
// thinking]. We must NOT drop that block (signed thinking has to round-trip
// verbatim); instead we stable-partition the content so every non-toolCall block
// keeps its relative order but moves ahead of the tool calls, and the tool calls
// move to the end in their original order: [thinking, text, thinking, toolCall].
function reorderAssistantToolCallsLast(
  message: AgentMessage,
): { message: AgentMessage; movedBlocks: number } {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "assistant" || !Array.isArray(record.content)) {
    return { message, movedBlocks: 0 };
  }

  const content = record.content;
  const firstToolCallIndex = content.findIndex(isToolCallBlock);
  if (firstToolCallIndex < 0) {
    return { message, movedBlocks: 0 };
  }

  // Blocks that need moving: any non-toolCall block positioned after the first
  // tool call. If there are none, the content already ends on the tool calls.
  let movedBlocks = 0;
  for (let index = firstToolCallIndex + 1; index < content.length; index++) {
    if (!isToolCallBlock(content[index])) movedBlocks += 1;
  }
  if (movedBlocks === 0) {
    return { message, movedBlocks: 0 };
  }

  const nonToolCalls = content.filter((part) => !isToolCallBlock(part));
  const toolCalls = content.filter((part) => isToolCallBlock(part));
  return {
    message: {
      ...record,
      content: [...nonToolCalls, ...toolCalls],
    } as unknown as AgentMessage,
    movedBlocks,
  };
}
