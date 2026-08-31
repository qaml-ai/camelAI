// Conversion of stored Pi-core messages into the parsed chat-message shape used
// by agent-eval and the admin explorer. Pure transforms extracted from
// chat-thread-do.ts — a leaf module with no Durable Object state.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizePiUiMetadata } from "../../../src/lib/runtime-artifacts";
import type { ToolResultBlock } from "../../../src/types";
import type { AdminExplorerThreadSummary } from "./chat-thread/types";
import { getPiAssistantErrorMessage } from "./chat-thread/pi-message-helpers";
import { normalizeModelHistoryValue } from "./chat-error-metadata";

export const PI_USER_STOP_METADATA_REASON = "user_stop";

export function isPiUserStopMessage(message: AgentMessage): boolean {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "assistant") return false;
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object") {
    const reason = (metadata as Record<string, unknown>).reason;
    if (reason === PI_USER_STOP_METADATA_REASON) return true;
  }
  return false;
}

export function piCoreMessageToParsedChatMessage(
  message: AgentMessage,
  index: number,
  threadId: string,
): Array<{
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId: string;
  /** Render-history message id this row streams into (uiMetadata stamp); the
   * backfill folds assistant rows sharing it into that one UIMessage and uses
   * user stamps to rebuild steer bubbles. Absent on legacy rows. */
  renderMessageId?: string;
  sentDuringStreaming?: boolean;
  isCompactSummary?: boolean;
}> {
  const record = message as unknown as Record<string, unknown>;
  const role = record.role;
  const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
    ? record.timestamp
    : Date.now();

  if (isInternalPiClientMessage(record)) {
    return [];
  }

  if (role === "user") {
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : null;
    const sentDuringStreaming =
      record.sentDuringStreaming === true ||
      metadata?.sentDuringStreaming === true;
    const isCompactSummary =
      record.isCompactSummary === true ||
      metadata?.compactSummary === true ||
      metadata?.isCompactSummary === true;
    const renderMessageId = normalizePiUiMetadata(record.uiMetadata)?.renderMessageId;
    return [{
      id: `pi_user_${timestamp}_${index}`,
      thread_id: threadId,
      role: "user",
      content: piUserContentToChatContent(record.content),
      created_at: timestamp,
      forkEntryId: `pi_user_${timestamp}_${index}`,
      ...(renderMessageId ? { renderMessageId } : {}),
      ...(sentDuringStreaming ? { sentDuringStreaming: true } : {}),
      ...(isCompactSummary ? { isCompactSummary: true } : {}),
    }];
  }

  if (role === "assistant") {
    const content = piAssistantContentToChatContent(record);
    if (Array.isArray(content) && content.length === 0) return [];
    const responseId = typeof record.responseId === "string" && record.responseId.trim()
      ? record.responseId.trim()
      : `pi_assistant_${timestamp}_${index}`;
    const renderMessageId = normalizePiUiMetadata(record.uiMetadata)?.renderMessageId;
    return [{
      id: responseId,
      thread_id: threadId,
      role: "assistant",
      content,
      created_at: timestamp,
      forkEntryId: responseId,
      ...(renderMessageId ? { renderMessageId } : {}),
    }];
  }

  return [];
}

export function piCoreForkMessageIds(message: AgentMessage, index: number): string[] {
  const record = message as unknown as Record<string, unknown>;
  const role = record.role;
  const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
    ? record.timestamp
    : Date.now();
  const ids: string[] = [];

  if (role === "user") {
    ids.push(`pi_user_${timestamp}_${index}`);
  } else if (role === "assistant") {
    const responseId = typeof record.responseId === "string" && record.responseId.trim()
      ? record.responseId.trim()
      : `pi_assistant_${timestamp}_${index}`;
    ids.push(responseId);
  }

  if (typeof record.id === "string" && record.id.trim()) {
    ids.push(record.id.trim());
  }
  return Array.from(new Set(ids));
}

export function isInternalPiClientMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  return record.visibility === "hidden";
}

export function isCompactSummaryPiMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.isCompactSummary === true || record.isMeta === true) return true;
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const meta = metadata as Record<string, unknown>;
  return meta.compactSummary === true || meta.isCompactSummary === true;
}

export function piUserContentToChatContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = content.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      return [{ type: "text", text: item.text }];
    }
    return [];
  });
  return blocks.length > 0 ? blocks : "";
}

export function piAssistantContentToChatContent(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const isUserStop = isPiUserStopMessage(message as unknown as AgentMessage);
  const content = message.content;
  const blocks = Array.isArray(content) ? content.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      return [{
        type: "text",
        text: item.text,
        ...(isUserStop ? { itemKind: "userStop" } : {}),
      }];
    }
    if (item.type === "thinking" && typeof item.thinking === "string") {
      return [{
        type: "thinking",
        thinking: item.thinking,
        signature: typeof item.thinkingSignature === "string" ? item.thinkingSignature : undefined,
      }];
    }
    if (item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
      return [{
        type: "tool_use",
        id: item.id,
        name: item.name,
        input: item.arguments && typeof item.arguments === "object" ? item.arguments : {},
      }];
    }
    return [];
  }) : [];
  if (
    blocks.length === 0 &&
    typeof message.errorMessage === "string" &&
    message.errorMessage.trim()
  ) {
    const status = typeof message.status === "number" && Number.isFinite(message.status)
      ? Math.trunc(message.status)
      : undefined;
    return [{
      type: "error",
      title: "Assistant error",
      error: message.errorMessage.trim(),
      ...(message.billingSource === "byok" || message.billingSource === "hosted"
        ? { billingSource: message.billingSource }
        : {}),
      ...(typeof message.provider === "string" && message.provider.trim()
        ? { provider: message.provider.trim() }
        : {}),
      ...(status ? { status } : {}),
      ...(typeof message.errorType === "string" && message.errorType.trim()
        ? { errorType: message.errorType.trim() }
        : {}),
    }];
  }
  return blocks;
}

/**
 * Generic over the row shape (only `role`/`content` are read and rewritten) so
 * both the full-thread export rows and the windowed derive's parsed render rows
 * fold tool answers through this ONE implementation.
 */
export function attachPiToolResultToParsedMessages<
  TMessage extends { role: "user" | "assistant"; content: unknown },
>(
  messages: TMessage[],
  toolResult: Record<string, unknown>,
): void {
  const toolCallId =
    typeof toolResult.toolCallId === "string" && toolResult.toolCallId.trim()
      ? toolResult.toolCallId.trim()
      : "";
  if (!toolCallId) return;

  const uiMetadata = normalizePiUiMetadata(toolResult.uiMetadata);
  const isError = toolResult.isError === true;
  const block: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: toolCallId,
    content: piToolResultContentToChatContent(toolResult.content),
    is_error: isError,
    status: isError ? "failed" : "succeeded",
    itemId: toolCallId,
    itemKind:
      typeof toolResult.toolName === "string" &&
      toolResult.toolName.trim().toLowerCase() === "bash"
        ? "commandExecution"
        : "dynamicToolCall",
    ...(uiMetadata?.codeModeArtifacts?.length
      ? { artifacts: uiMetadata.codeModeArtifacts }
      : {}),
  };

  let fallbackAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (fallbackAssistantIndex === -1) fallbackAssistantIndex = index;
    const content = Array.isArray(message.content) ? message.content : [];
    const toolUseIndex = content.findIndex((part) => {
      if (!part || typeof part !== "object") return false;
      const item = part as Record<string, unknown>;
      return item.type === "tool_use" && item.id === toolCallId;
    });
    if (toolUseIndex !== -1) {
      // Insert the result directly after its tool_use, not at the end of the
      // message. Pi can persist a turn's trailing answer text in the same
      // assistant record as its tool calls; appending the result there would
      // push it past the final text, so the turn view (see turn-utils) would
      // fold that answer into the collapsed tool trace instead of rendering it
      // as the turn's final output. This mirrors the live overlay, which
      // anchors tool_result blocks to their tool_use.
      const nextContent = [...content];
      nextContent.splice(toolUseIndex + 1, 0, block);
      messages[index] = {
        ...message,
        content: nextContent,
      } as TMessage;
      return;
    }
  }

  if (fallbackAssistantIndex !== -1) {
    const message = messages[fallbackAssistantIndex];
    const content = Array.isArray(message.content) ? message.content : [];
    messages[fallbackAssistantIndex] = {
      ...message,
      content: [...content, block],
    } as TMessage;
  }
}

export function piToolResultContentToChatContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return safeLegacyString(content);
  const text = content
    .flatMap((part): string[] => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") {
        return [item.text];
      }
      return [safeLegacyString(item)];
    })
    .filter(Boolean)
    .join("\n");
  return text || safeLegacyString(content);
}

export function safeLegacyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Aggregate stats for the admin chat explorer, folded over stored pi_core
 * rows (plus the live session model, passed in by the DO). */
export function summarizeAdminExplorerThread(
  messages: AgentMessage[],
  options: { userMessageCap?: number; sessionModelId?: string | null } = {},
): AdminExplorerThreadSummary {
  const cap = Number.isFinite(options.userMessageCap)
    ? Math.max(1, Math.min(100, Math.floor(options.userMessageCap as number)))
    : 20;
  const models: string[] = [];
  let userMessageCount = 0;
  let userMessageCountCapped = false;
  let errorCount = 0;
  let lastErrorAt: number | null = null;
  let lastErrorMessage: string | null = null;

  const addModel = (value: unknown) => {
    const model = normalizeModelHistoryValue(value);
    if (model && !models.includes(model)) models.push(model);
  };

  for (const [index, message] of messages.entries()) {
    const record = message as unknown as Record<string, unknown>;
    const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();

    if (record.role === "user") {
      if (
        !isInternalPiClientMessage(record) &&
        !isCompactSummaryPiMessage(record)
      ) {
        if (!userMessageCountCapped) {
          userMessageCount += 1;
          if (userMessageCount > cap) {
            userMessageCount = cap;
            userMessageCountCapped = true;
          }
        }
      }
      continue;
    }

    if (record.role !== "assistant") continue;
    addModel(record.responseModel);
    addModel(record.model);
    const errorMessage = getPiAssistantErrorMessage(message);
    if (errorMessage) {
      errorCount += 1;
      if (lastErrorAt === null || timestamp >= lastErrorAt) {
        lastErrorAt = timestamp;
        lastErrorMessage = errorMessage;
      }
    }

    if (index > 2000 && userMessageCountCapped) {
      break;
    }
  }

  addModel(options.sessionModelId);

  return {
    userMessageCount,
    userMessageCountCapped,
    hasError: errorCount > 0,
    errorCount,
    lastErrorAt,
    lastErrorMessage,
    models,
  };
}
