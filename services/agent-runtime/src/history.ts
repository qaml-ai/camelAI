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
 * Close a turn that a runtime restart interrupted. Tool calls without results
 * get an explicit "outcome unknown" result, so the agent stays usable without
 * an operator, and the model is never told an effect did or did not happen.
 */
export function recoverInterruptedTurn(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pending = new Map<string, string>();
  const close = () => {
    for (const [toolCallId, toolName] of pending) result.push({
      role: "toolResult", toolCallId, toolName, isError: true, timestamp: Date.now(),
      content: [{ type: "text", text: "The runtime restarted while this tool call was in progress. Its outcome is unknown: it may or may not have taken effect. Check the current state before repeating it." }],
    });
    pending = new Map();
  };
  for (const message of messages) {
    if (message.role !== "toolResult") close();
    result.push(message);
    if (message.role === "assistant") {
      for (const part of message.content) if (part.type === "toolCall") pending.set(part.id, part.name);
    } else if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  close();
  // Without this, continue() would resubmit a user-only interrupted turn as if it were new.
  result.push({ role: "user", content: "[Runtime notice] The previous run was interrupted by a restart before it finished. Tool results above marked as unknown may or may not have taken effect. Wait for the next instruction.", timestamp: Date.now() });
  return result;
}

/** Bound provider context by whole user turns; durable history remains complete. */
export function boundedContext(messages: AgentMessage[], contextWindow: number, systemPrompt: string): AgentMessage[] {
  // Conservative character budget, reserving space for tools and model output.
  const budget = Math.max(1024, Math.floor(contextWindow * 0.6 * 3) - systemPrompt.length);
  if (JSON.stringify(messages).length <= budget) return messages;
  const starts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  for (const start of starts) {
    const tail = messages.slice(start);
    if (JSON.stringify(tail).length <= budget) return tail;
  }
  throw new Error("The current turn exceeds the model context budget; use smaller tool results or a larger-context model");
}
