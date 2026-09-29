/**
 * The pre-compaction render archive as pi messages, for a thread moving to
 * the agent runtime (chat-thread/runtime-migration.ts). A post-turn
 * compaction deleted the pi_core rows below its cut and kept them visible
 * only as ai-chat render rows (cf_ai_chat_agent_messages), so the move
 * rebuilds that history from them: shown to the user on the runtime, never
 * to its model (it sits before the compaction summary). The rebuild is
 * approximate (tool results as their text, files and errors as notes), so a
 * move that uses it is always archived and says so.
 *
 * The rows are AI SDK UIMessages as the old chat loop stored them; only the
 * parts read here are typed.
 */
import type { AgentMessage } from "../../../../src/lib/agent-messages.js";

/** A stored render row (an AI SDK UIMessage), as far as the export reads it. */
export interface RenderMessage {
  id: string;
  role: "system" | "user" | "assistant";
  metadata?: unknown;
  parts: Array<{ type: string; [key: string]: unknown }>;
}

type PiBlock = Record<string, unknown> & { type: string };

/** What an assistant message the runtime keeps carries besides its content (no model saw these). */
const ARCHIVED_ASSISTANT = {
  api: "archived",
  provider: "camelai",
  model: "archived",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** When a render row was made: its backfill stamp, its turn-end stamp, or its legacy pi_core key; 0 when none. */
export function renderMessageCreatedAtMs(message: RenderMessage): number | undefined {
  const metadata = message.metadata as { pi?: { createdAtMs?: unknown; completedAtMs?: unknown }; piCoreMessageKey?: unknown } | undefined;
  return positive(metadata?.pi?.createdAtMs)
    ?? positive(metadata?.pi?.completedAtMs)
    ?? (typeof metadata?.piCoreMessageKey === "string" ? positive(Number(metadata.piCoreMessageKey)) : undefined);
}

/** A row as stored is a render message: an id, a role, and parts. */
export function isRenderMessage(value: unknown): value is RenderMessage {
  const message = value as Partial<RenderMessage> | null;
  return Boolean(message) && typeof message === "object" && typeof message!.id === "string"
    && (message!.role === "user" || message!.role === "assistant" || message!.role === "system")
    && Array.isArray(message!.parts);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A tool output's text: a string, or the text blocks of a content list. */
function outputText(output: unknown): string {
  const content = (output as { content?: unknown } | null)?.content ?? output;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content.map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? text((block as { text?: unknown }).text) : "")).join("");
}

function toolName(part: { type: string; toolName?: unknown }): string {
  if (typeof part.toolName === "string" && part.toolName) return part.toolName;
  return part.type.startsWith("tool-") ? part.type.slice("tool-".length) : "tool";
}

/**
 * One render message as pi messages: a user message's text; an assistant
 * message's text, reasoning and tool calls, each call's result after the
 * assistant message that made it, and a new assistant message where the
 * model went on after results.
 */
export function renderMessageToPiMessages(message: RenderMessage): AgentMessage[] {
  const timestamp = renderMessageCreatedAtMs(message) ?? 0;
  if (message.role !== "assistant") {
    const lines = message.parts
      .map((part) => (part.type === "text" ? text(part.text) : part.type === "file" ? "[a file was attached here]" : ""))
      .filter(Boolean);
    return lines.length ? [{ role: "user", content: lines.join("\n"), timestamp } as AgentMessage] : [];
  }
  const out: AgentMessage[] = [];
  let blocks: PiBlock[] = [];
  let results: AgentMessage[] = [];
  const flush = () => {
    if (blocks.length) {
      const calls = blocks.some((block) => block.type === "toolCall");
      out.push({ role: "assistant", content: blocks, stopReason: calls ? "toolUse" : "stop", timestamp, ...ARCHIVED_ASSISTANT } as unknown as AgentMessage);
    }
    out.push(...results);
    blocks = [];
    results = [];
  };
  for (const part of message.parts) {
    const isTool = (part.type.startsWith("tool-") || part.type === "dynamic-tool") && typeof part.toolCallId === "string";
    if (isTool) {
      // The model went on after its tool results: that is its next message.
      if (results.length) flush();
      const id = part.toolCallId as string;
      const name = toolName(part);
      const input = part.input && typeof part.input === "object" && !Array.isArray(part.input) ? part.input : {};
      blocks.push({ type: "toolCall", id, name, arguments: input });
      const state = part.state;
      if (state === "output-available" || state === "output-error") {
        const output = part.output as { isError?: unknown } | undefined;
        results.push({
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          content: [{ type: "text", text: state === "output-error" ? text(part.errorText) : outputText(output) }],
          isError: state === "output-error" || output?.isError === true,
          timestamp,
        } as unknown as AgentMessage);
      }
      continue;
    }
    if (results.length) flush();
    if (part.type === "text" && text(part.text)) blocks.push({ type: "text", text: text(part.text) });
    else if (part.type === "reasoning" && text(part.text)) blocks.push({ type: "thinking", thinking: text(part.text) });
    else if (part.type === "data-pi-error") {
      const error = text((part.data as { error?: unknown } | undefined)?.error);
      if (error) blocks.push({ type: "text", text: `[error: ${error}]` });
    } else if (part.type === "data-pi-user-stop" || part.type === "data-pi-turn-notice") {
      const note = text((part.data as { text?: unknown } | undefined)?.text);
      if (note) blocks.push({ type: "text", text: note });
    }
  }
  flush();
  return out;
}

/** Render messages, oldest first, as pi messages. */
export function renderArchiveToPiMessages(messages: readonly RenderMessage[]): AgentMessage[] {
  return messages.flatMap((message) => renderMessageToPiMessages(message));
}
