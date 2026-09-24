import type {
  ChatEvent,
  ChatMessage,
  ContentBlock,
  UiMessage,
  UiPart,
} from "../shared/index.ts";

function isUiMessage(message: ChatMessage | UiMessage): message is UiMessage {
  return "parts" in message;
}

function chatMessageToUiMessage(message: ChatMessage): UiMessage {
  const blocks: ContentBlock[] =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;

  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    parts: blocks.map((block): UiPart => {
      switch (block.type) {
        case "text":
          return {
            type: "text",
            text: block.text,
            state: message.isStreaming ? "streaming" : "done",
          };
        case "thinking":
          return {
            type: "reasoning",
            text: block.thinking,
            state: message.isStreaming ? "streaming" : "done",
          };
        case "tool_use":
          return {
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
            state: "input-available",
          };
        case "tool_result":
          return {
            type: "tool-result",
            toolCallId: block.tool_use_id,
            output: block.content,
            isError: block.is_error,
          };
        case "error":
          return {
            type: "data-error",
            data: {
              error: block.error,
              title: block.title,
              status: block.status,
              errorType: block.errorType,
            },
          };
      }
    }),
  };
}

function toolOutputToString(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/**
 * Converts the live UI shape to the durable transcript shape.
 * Transient todo and tool-stream parts are intentionally not persisted.
 */
export function uiMessageToChatMessage(
  ui: UiMessage,
  threadId: string,
): ChatMessage {
  const blocks: ContentBlock[] = [];

  for (const part of ui.parts) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "reasoning":
        blocks.push({ type: "thinking", thinking: part.text });
        break;
      case "tool-call":
        blocks.push({
          type: "tool_use",
          id: part.toolCallId,
          name: part.toolName,
          input: part.input,
        });
        break;
      case "tool-result":
        blocks.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: toolOutputToString(part.output),
          is_error: part.isError,
        });
        break;
      case "data-error":
        blocks.push({
          type: "error",
          error: part.data.error,
          title: part.data.title,
          status:
            typeof part.data.status === "number" ? part.data.status : undefined,
          errorType: part.data.errorType ?? undefined,
        });
        break;
      case "data-todos":
      case "data-tool-stream":
        break;
    }
  }

  return {
    id: ui.id,
    threadId,
    role: ui.role,
    content: blocks,
    createdAt: ui.createdAt,
    isStreaming: ui.parts.some(
      (part) =>
        ("state" in part && part.state === "streaming") ||
        ("state" in part && part.state === "input-streaming"),
    ),
  };
}

function appendDeltaParts(existing: UiPart[], incoming: UiPart[]): UiPart[] {
  const next = [...existing];

  for (const part of incoming) {
    const identity =
      part.type === "tool-call" || part.type === "tool-result"
        ? `${part.type}:${part.toolCallId}`
        : part.type === "data-error" && part.id
          ? `${part.type}:${part.id}`
          : part.type === "data-todos" && part.id
            ? `${part.type}:${part.id}`
            : null;

    const replaceIndex =
      identity === null
        ? -1
        : next.findIndex((candidate) => {
            if (
              candidate.type === "tool-call" ||
              candidate.type === "tool-result"
            ) {
              return `${candidate.type}:${candidate.toolCallId}` === identity;
            }
            if (
              (candidate.type === "data-error" ||
                candidate.type === "data-todos") &&
              candidate.id
            ) {
              return `${candidate.type}:${candidate.id}` === identity;
            }
            return false;
          });

    if (replaceIndex >= 0) next[replaceIndex] = part;
    else next.push(part);
  }

  return next;
}

/** Applies transcript events without mutating the previous message array. */
export function applyChatEvent(
  messages: UiMessage[],
  event: ChatEvent,
): UiMessage[] {
  if (event.type === "messageUpsert") {
    const incoming = isUiMessage(event.message)
      ? event.message
      : chatMessageToUiMessage(event.message);
    const existingIndex = messages.findIndex(
      (message) => message.id === incoming.id,
    );

    if (existingIndex < 0) {
      return [...messages, incoming].sort(
        (left, right) => left.createdAt - right.createdAt,
      );
    }

    const next = [...messages];
    next[existingIndex] = incoming;
    return next;
  }

  if (event.type !== "messageDelta") return messages;

  const existingIndex = messages.findIndex(
    (message) => message.id === event.messageId,
  );
  const current: UiMessage =
    existingIndex >= 0
      ? messages[existingIndex]!
      : {
          id: event.messageId,
          role: "assistant",
          parts: [],
          createdAt: Date.now(),
        };
  let parts = event.parts
    ? appendDeltaParts(current.parts, event.parts)
    : [...current.parts];

  if (event.textDelta) {
    const lastPart = parts.at(-1);
    if (lastPart?.type === "text" && lastPart.state === "streaming") {
      parts = [
        ...parts.slice(0, -1),
        { ...lastPart, text: lastPart.text + event.textDelta },
      ];
    } else {
      parts.push({
        type: "text",
        text: event.textDelta,
        state: "streaming",
      });
    }
  }

  const updated = { ...current, parts };
  if (existingIndex < 0) return [...messages, updated];

  const next = [...messages];
  next[existingIndex] = updated;
  return next;
}
