import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Imported provider messages remain native: reasoning/signatures are never reconstructed. */
export function validateInitialMessages(messages: AgentMessage[]) {
  if (!Array.isArray(messages) || messages.some(message => !message || !["user", "assistant", "toolResult"].includes(message.role))) {
    throw new Error("Initial messages must be native user, assistant, or toolResult messages");
  }
  if (Buffer.byteLength(JSON.stringify(messages)) > 16 * 1024 * 1024) throw new Error("Initial history exceeds 16 MB");
}

/** Scoped callers may only add user input; assistant and tool history is runtime-owned. */
export function validateUserMessages(messages: AgentMessage[]) {
  validateInitialMessages(messages);
  for (const message of messages) {
    if (message.role !== "user") throw new Error("Only user messages can be submitted; assistant and tool results are produced by the runtime");
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content) || message.content.some(part => !part || !(part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))) {
      throw new Error("User messages may only contain text and images");
    }
  }
}

/**
 * Messages that close a turn a runtime restart interrupted. Tool calls without
 * results get an explicit "outcome unknown" result, so the agent stays usable
 * without an operator, and the model is never told an effect did or did not
 * happen. They are appended: an interrupted turn's open calls are always at the end.
 */
export function interruptedTurnRepairs(messages: AgentMessage[]): AgentMessage[] {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      pending.clear();
      for (const part of message.content) if (part.type === "toolCall") pending.set(part.id, part.name);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
    else if (message.role === "user") pending.clear();
  }
  const repairs: AgentMessage[] = [...pending].map(([toolCallId, toolName]) => ({
    role: "toolResult", toolCallId, toolName, isError: true, timestamp: Date.now(),
    content: [{ type: "text", text: "The runtime restarted while this tool call was in progress. Its outcome is unknown: it may or may not have taken effect. Check the current state before repeating it." }],
  }));
  // Without this, continue() would resubmit a user-only interrupted turn as if it were new.
  repairs.push({ role: "user", content: "[Runtime notice] The previous run was interrupted by a restart before it finished. Tool results above marked as unknown may or may not have taken effect. Wait for the next instruction.", timestamp: Date.now() });
  return repairs;
}

export function recoverInterruptedTurn(messages: AgentMessage[]): AgentMessage[] {
  return [...messages, ...interruptedTurnRepairs(messages)];
}

/** Approximate prompt characters for a message; an image counts like pi's estimate, not by its base64 size. */
export function messageChars(message: AgentMessage): number {
  let images = 0;
  const text = JSON.stringify(message, (key, value) => {
    if (key === "data" && typeof value === "string" && value.length > 256) { images++; return ""; }
    return value;
  });
  return text.length + images * 4800;
}

/**
 * Last-resort bound on provider context, used only when compaction could not run:
 * drop whole older user turns until the rest fits `budgetTokens` (pi's chars/4
 * estimate, the same measure compaction uses). Durable history stays complete.
 */
export function boundedContext(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  const budget = Math.max(1024, budgetTokens) * 4;
  let size = 0;
  let start = -1;
  // Walk back from the newest message, remembering the oldest user turn that still fits.
  for (let index = messages.length - 1; index >= 0; index--) {
    size += messageChars(messages[index]);
    if (size > budget) break;
    if (messages[index].role === "user" || messages[index].role === "compactionSummary") start = index;
  }
  if (size <= budget) return messages;
  if (start < 0) throw new Error("The current turn exceeds the model context budget; use smaller tool results or a larger-context model");
  return messages.slice(start);
}
