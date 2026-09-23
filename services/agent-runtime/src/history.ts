import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Imported provider messages remain native: reasoning/signatures are never reconstructed. */
export function validateInitialMessages(messages: AgentMessage[]) {
  if (!Array.isArray(messages) || messages.some(message => !message || !["user", "assistant", "toolResult"].includes(message.role))) {
    throw new Error("Initial messages must be native user, assistant, or toolResult messages");
  }
  if (Buffer.byteLength(JSON.stringify(messages)) > 16 * 1024 * 1024) throw new Error("Initial history exceeds 16 MB");
}

/** Explicit operator acknowledgement abandons unresolved calls; it never retries them. */
export function reconcileMessages(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  let pending = new Map<string, string>();
  const close = () => {
    for (const [toolCallId, toolName] of pending) result.push({
      role: "toolResult", toolCallId, toolName, isError: true, timestamp: Date.now(),
      content: [{ type: "text", text: "Execution was interrupted. The tool may have had side effects; its outcome is unknown. An operator acknowledged the interruption. Do not automatically repeat this operation." }],
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
  // Prevent continue() from automatically resubmitting a user-only interrupted turn.
  result.push({ role: "user", content: "The previous run was interrupted and has been acknowledged. Its unresolved tool effects must not be automatically repeated. Wait for or follow the next explicit instruction.", timestamp: Date.now() });
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
