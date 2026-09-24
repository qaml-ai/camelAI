import type { ChatEvent, TodoStatus, UiPart } from "../../shared/index.ts";

/**
 * Structural subset of AgentOS' SessionStreamEntry. Keeping this permissive
 * makes the mapper usable with recorded ACP fixtures across protocol versions.
 */
export type SessionStreamEntryLike = Record<string, unknown> & {
  type?: unknown;
};

export type AcpMapperOptions = {
  /** UI message receiving agent deltas for this turn. */
  messageId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textFromContent).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.text === "string") {
    return value.text;
  }
  if (value.type === "content") {
    return textFromContent(value.content);
  }
  if (value.type === "diff") {
    const oldText = asString(value.oldText) ?? asString(value.old_text);
    const newText = asString(value.newText) ?? asString(value.new_text);
    return [oldText, newText].filter(Boolean).join("\n");
  }
  return "";
}

function toolState(
  status: unknown,
): "input-available" | "output-available" | "output-error" {
  if (status === "failed") {
    return "output-error";
  }
  if (status === "completed") {
    return "output-available";
  }
  return "input-available";
}

function toolCallPart(entry: SessionStreamEntryLike): UiPart | undefined {
  const toolCallId = asString(entry.toolCallId);
  if (!toolCallId) {
    return undefined;
  }

  return {
    type: "tool-call",
    toolCallId,
    toolName:
      asString(entry.title) ?? asString(entry.kind) ?? "tool",
    input: asRecord(entry.rawInput),
    state: toolState(entry.status),
  };
}

function toolResultPart(entry: SessionStreamEntryLike): UiPart | undefined {
  if (entry.status !== "completed" && entry.status !== "failed") {
    return undefined;
  }
  const toolCallId = asString(entry.toolCallId);
  if (!toolCallId) {
    return undefined;
  }

  const contentText = textFromContent(entry.content);
  const output =
    entry.rawOutput !== undefined
      ? entry.rawOutput
      : contentText || (entry.status === "failed" ? "Tool failed" : "");

  return {
    type: "tool-result",
    toolCallId,
    toolName: asString(entry.title),
    output,
    isError: entry.status === "failed",
  };
}

function permissionDecision(entry: SessionStreamEntryLike) {
  const outcome = isRecord(entry.outcome) ? entry.outcome : {};
  if (outcome.outcome === "cancelled") {
    return "deny" as const;
  }
  const optionId = asString(outcome.optionId)?.toLowerCase() ?? "";
  if (optionId.includes("reject") || optionId.includes("deny")) {
    return "deny" as const;
  }
  if (optionId.includes("always")) {
    return "allow_always" as const;
  }
  return "allow" as const;
}

/**
 * Convert one flattened AgentOS/ACP session event to browser chat events.
 * Unknown protocol extensions intentionally produce no output.
 */
export function mapAcpSessionEntry(
  entry: SessionStreamEntryLike,
  options: AcpMapperOptions,
): ChatEvent[] {
  const type = asString(entry.type);
  switch (type) {
    case "agent_message_chunk": {
      const text = textFromContent(entry.content);
      return text
        ? [{ type: "messageDelta", messageId: options.messageId, textDelta: text }]
        : [];
    }
    case "agent_thought_chunk": {
      const text = textFromContent(entry.content);
      return text
        ? [
            {
              type: "messageDelta",
              messageId: options.messageId,
              parts: [{ type: "reasoning", text, state: "streaming" }],
            },
          ]
        : [];
    }
    case "tool_call":
    case "tool_call_update": {
      const parts = [toolCallPart(entry), toolResultPart(entry)].filter(
        (part): part is UiPart => part !== undefined,
      );
      return parts.length
        ? [{ type: "messageDelta", messageId: options.messageId, parts }]
        : [];
    }
    case "plan": {
      if (!Array.isArray(entry.entries)) {
        return [];
      }
      const currentTodos = entry.entries.flatMap((item) => {
        if (!isRecord(item) || typeof item.content !== "string") {
          return [];
        }
        const status: TodoStatus =
          item.status === "in_progress" || item.status === "completed"
            ? item.status
            : "pending";
        return [
          {
            content: item.content,
            activeForm: asString(item.activeForm) ?? item.content,
            status,
          },
        ];
      });
      return [{ type: "state", state: { currentTodos } }];
    }
    case "permission_request": {
      const requestId = asString(entry.requestId);
      const toolCall = asRecord(entry.toolCall);
      const toolCallId = asString(toolCall.toolCallId);
      if (!requestId || !toolCallId) {
        return [];
      }
      return [
        {
          type: "permissionRequest",
          requestId,
          toolCallId,
          toolName:
            asString(toolCall.title) ?? asString(toolCall.kind) ?? "tool",
          input: asRecord(toolCall.rawInput),
          description: asString(toolCall.title),
        },
      ];
    }
    case "permission_response": {
      const requestId = asString(entry.requestId);
      if (!requestId) {
        return [];
      }
      return [
        {
          type: "permissionResolved",
          requestId,
          decision: permissionDecision(entry),
        },
      ];
    }
    case "session_info_update": {
      const title = asString(entry.title);
      return title ? [{ type: "state", state: { title } }] : [];
    }
    default:
      return [];
  }
}

export function mapAcpSessionEntries(
  entries: readonly SessionStreamEntryLike[],
  options: AcpMapperOptions,
): ChatEvent[] {
  return entries.flatMap((entry) => mapAcpSessionEntry(entry, options));
}
