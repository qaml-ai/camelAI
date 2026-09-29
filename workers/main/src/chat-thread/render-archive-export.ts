/**
 * The pre-compaction render archive as pi messages, for a thread moving to
 * the agent runtime (chat-thread/runtime-migration.ts). A post-turn
 * compaction deletes the pi_core rows below its cut and keeps them visible
 * only as ai-chat render rows (render-archive-preserve.ts), so the move
 * rebuilds that history from them: shown to the user on the runtime, never
 * to its model (it sits before the compaction summary). The rebuild is
 * approximate (tool results as their text, files and errors as notes), so a
 * move that uses it is always archived and says so.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UIMessage } from "ai";
import type { ContentBlock } from "../../../../src/types";
import { uiMessageToMessage } from "../../../../src/lib/ui-message-adapter";

type PiBlock = Record<string, unknown> & { type: string };

/** What an assistant message the runtime keeps carries besides its content (no model saw these). */
const ARCHIVED_ASSISTANT = {
  api: "archived",
  provider: "camelai",
  model: "archived",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

function resultText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * One render message as pi messages: a user message's text; an assistant
 * message's text, reasoning and tool calls, each call's result after the
 * assistant message that made it, and a new assistant message where the
 * model went on after results.
 */
export function renderMessageToPiMessages(ui: UIMessage): AgentMessage[] {
  const message = uiMessageToMessage(ui);
  const timestamp = message.created_at;
  const content: ContentBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (message.role !== "assistant") {
    const text = content
      .map((block) => (block.type === "text" ? block.text : block.type === "file" ? "[a file was attached here]" : ""))
      .filter(Boolean)
      .join("\n");
    return text ? [{ role: "user", content: text, timestamp } as AgentMessage] : [];
  }
  const out: AgentMessage[] = [];
  let blocks: PiBlock[] = [];
  let results: AgentMessage[] = [];
  const names = new Map<string, string>();
  const flush = () => {
    if (blocks.length) {
      const calls = blocks.some((block) => block.type === "toolCall");
      out.push({ role: "assistant", content: blocks, stopReason: calls ? "toolUse" : "stop", timestamp, ...ARCHIVED_ASSISTANT } as unknown as AgentMessage);
    }
    out.push(...results);
    blocks = [];
    results = [];
  };
  for (const block of content) {
    if (block.type === "tool_result") {
      results.push({
        role: "toolResult",
        toolCallId: block.tool_use_id,
        toolName: names.get(block.tool_use_id) ?? "tool",
        content: [{ type: "text", text: resultText(block.content) }],
        isError: block.is_error === true,
        timestamp,
      } as unknown as AgentMessage);
      continue;
    }
    // The model went on after its tool results: that is its next message.
    if (results.length) flush();
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    else if (block.type === "thinking" && block.thinking) blocks.push({ type: "thinking", thinking: block.thinking });
    else if (block.type === "tool_use") {
      names.set(block.id, block.name);
      blocks.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input ?? {} });
    } else if (block.type === "error" && "error" in block && block.error) {
      blocks.push({ type: "text", text: `[error: ${String(block.error)}]` });
    }
  }
  flush();
  return out;
}

/** Render messages, oldest first, as pi messages. */
export function renderArchiveToPiMessages(messages: readonly UIMessage[]): AgentMessage[] {
  return messages.flatMap((message) => renderMessageToPiMessages(message));
}
