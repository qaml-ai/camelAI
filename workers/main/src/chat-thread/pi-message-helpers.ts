// Pure Pi message helpers extracted from chat-thread-do.ts: message/error
// predicates and extractors, tool-result truncation, runtime-event / tool-result
// formatting, and pi_core message identity (dedup keys + render-message-id
// stamping). Each function reads only its arguments (plus the module-level
// byte/line limits imported from ./pi-message-storage) and holds no
// ChatThreadDO state.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  normalizePiUiMetadata,
  stripPiUiMetadata,
  type PiUiMetadata,
} from "../../../../src/lib/runtime-artifacts";
import {
  PI_TOOL_RESULT_MAX_LINES,
  PI_TOOL_RESULT_MAX_BYTES,
  PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES,
  PI_R2_IMAGE_REF_METADATA_KEY,
  normalizePiImageMimeType,
  piUnsupportedImageText,
  preparePiMessageForSqlStorage,
} from "../pi-message-storage";
import type { PiToolResultTruncation } from "../pi-message-storage";

// ---------------------------------------------------------------------------
// Message/error predicates and extractors
// ---------------------------------------------------------------------------

export function isAbortedPiAssistantMessage(message: AgentMessage): boolean {
  const record = message as unknown as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    record.stopReason === "aborted"
  );
}

export function isFailedPiAssistantMessage(message: AgentMessage): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as unknown as Record<string, unknown>;
  return (
    record.role === "assistant" &&
    (record.stopReason === "aborted" || record.stopReason === "error")
  );
}

export function isEmptyAbortedPiAssistantMessage(message: AgentMessage): boolean {
  return (
    isAbortedPiAssistantMessage(message) &&
    extractPiMessageText(message).length === 0
  );
}

export function piProviderErrorMetadata(message: string): {
  status?: number;
  errorType?: string;
} {
  const trimmed = message.trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        parsed = null;
      }
    }
  }

  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const nested = root?.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : null;
  const statusCandidate =
    root?.status ??
    root?.statusCode ??
    root?.code ??
    nested?.status ??
    nested?.statusCode ??
    nested?.code;
  const statusFromText = /\bHTTP\s+(\d{3})\b/i.exec(trimmed)?.[1] ??
    /\berror code:\s*(\d{3})\b/i.exec(trimmed)?.[1];
  const parsedStatus =
    typeof statusCandidate === "number" && Number.isFinite(statusCandidate)
      ? Math.trunc(statusCandidate)
      : typeof statusCandidate === "string" && /^\d{3}$/.test(statusCandidate.trim())
        ? Number(statusCandidate.trim())
        : statusFromText
          ? Number(statusFromText)
          : /\b429\b/.test(trimmed)
            ? 429
            : /\b524\b/.test(trimmed)
              ? 524
          : undefined;
  const errorTypeCandidate =
    nested?.type ??
    nested?.error_type ??
    root?.type ??
    root?.error_type;

  return {
    ...(parsedStatus ? { status: parsedStatus } : {}),
    ...(typeof errorTypeCandidate === "string" && errorTypeCandidate.trim()
      ? { errorType: errorTypeCandidate.trim() }
      : {}),
  };
}

export function getPiAssistantErrorMessage(message: AgentMessage): string {
  const record = message as unknown as Record<string, unknown>;
  if (record.role !== "assistant") return "";
  if (record.stopReason === "aborted") return "";
  if (typeof record.errorMessage === "string" && record.errorMessage.trim()) {
    return record.errorMessage.trim();
  }
  return "";
}

export function getLatestPiAssistantErrorMessage(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const errorMessage = getPiAssistantErrorMessage(messages[i]);
    if (errorMessage) return errorMessage;
  }
  return "";
}

const PI_SUMMARY_MESSAGE_PREFIX = "[Context Summary]\n\n";

export function isPiSummaryMessage(message: AgentMessage | undefined): boolean {
  return (
    (message as unknown as Record<string, unknown> | undefined)?.role === "user" &&
    typeof (message as unknown as Record<string, unknown> | undefined)?.content === "string" &&
    ((message as unknown as Record<string, unknown>).content as string).startsWith(
      PI_SUMMARY_MESSAGE_PREFIX,
    )
  );
}

/**
 * The summary BODY of a summary message — the inverse of
 * `createPiSummaryMessage`. Compaction needs it to hand an existing summary
 * (durable or a capped-load placeholder) back to the summarizer through
 * `previousSummary`, which is the slot that keeps it from being summarized a
 * second time as if it were conversation.
 */
export function piSummaryMessageText(message: AgentMessage | undefined): string {
  if (!isPiSummaryMessage(message)) return "";
  const content = (message as unknown as Record<string, unknown>).content as string;
  return content.slice(PI_SUMMARY_MESSAGE_PREFIX.length);
}

export function extractLatestPiAssistantText(messages: AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if ((message as { role?: unknown }).role === "assistant") {
      const text = extractPiMessageText(message);
      if (text) return text;
    }
  }
  return "";
}

export function latestPiAssistantMessage(messages: AgentMessage[]): AgentMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if ((message as { role?: unknown }).role === "assistant") {
      return message;
    }
  }
  return null;
}

export function extractPiMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

export function isPiAssistantMessage(message: AgentMessage): boolean {
  return (message as unknown as Record<string, unknown>).role === "assistant";
}

export function piAgentLoopErrorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message.trim() || "Unknown Pi agent loop error",
      stack: typeof error.stack === "string" ? error.stack : undefined,
    };
  }
  if (typeof error === "string" && error.trim()) {
    return { name: "Error", message: error.trim() };
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") {
      return { name: "UnknownError", message: serialized };
    }
  } catch {
    // Fall through to the generic message.
  }
  return { name: "UnknownError", message: "Unknown Pi agent loop error" };
}

// ---------------------------------------------------------------------------
// Tool-result truncation
// ---------------------------------------------------------------------------

export function piTextBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function piTextSliceByBytes(
  value: string,
  maxBytes: number,
  direction: "head" | "tail",
): string {
  if (maxBytes <= 0) return "";
  const chars = Array.from(value);
  const selected: string[] = [];
  let outputBytes = 0;
  const append = (char: string, prepend: boolean): boolean => {
    const charBytes = piTextBytes(char);
    if (outputBytes + charBytes > maxBytes) return false;
    if (prepend) selected.unshift(char);
    else selected.push(char);
    outputBytes += charBytes;
    return true;
  };
  if (direction === "tail") {
    for (let index = chars.length - 1; index >= 0; index -= 1) {
      if (!append(chars[index] ?? "", true)) break;
    }
  } else {
    for (const char of chars) {
      if (!append(char, false)) break;
    }
  }
  return selected.join("");
}

export function truncatePiToolResultText(
  text: string,
  direction: "head" | "tail",
): { content: string; truncation?: Omit<PiToolResultTruncation, "fullOutput"> } {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalBytes = piTextBytes(text);
  if (
    totalLines <= PI_TOOL_RESULT_MAX_LINES &&
    totalBytes <= PI_TOOL_RESULT_MAX_BYTES
  ) {
    return { content: text };
  }

  const selected: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" =
    totalLines > PI_TOOL_RESULT_MAX_LINES ? "lines" : "bytes";

  const appendLine = (line: string, prepend: boolean): boolean => {
    if (selected.length >= PI_TOOL_RESULT_MAX_LINES) {
      truncatedBy = "lines";
      return false;
    }
    const lineBytes = piTextBytes(line) + (selected.length > 0 ? 1 : 0);
    if (outputBytes + lineBytes > PI_TOOL_RESULT_MAX_BYTES) {
      truncatedBy = "bytes";
      const separatorBytes = selected.length > 0 ? 1 : 0;
      const availableBytes = PI_TOOL_RESULT_MAX_BYTES - outputBytes - separatorBytes;
      const clipped = piTextSliceByBytes(line, availableBytes, direction);
      if (clipped) {
        if (prepend) selected.unshift(clipped);
        else selected.push(clipped);
        outputBytes += separatorBytes + piTextBytes(clipped);
      }
      return false;
    }
    if (prepend) selected.unshift(line);
    else selected.push(line);
    outputBytes += lineBytes;
    return true;
  };

  if (direction === "tail") {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!appendLine(lines[index] ?? "", true)) break;
    }
  } else {
    for (const line of lines) {
      if (!appendLine(line, false)) break;
    }
  }

  const content = selected.join("\n");
  return {
    content,
    truncation: {
      truncated: true,
      truncatedBy,
      direction,
      totalLines,
      outputLines: selected.length,
      totalBytes,
      outputBytes: piTextBytes(content),
      maxLines: PI_TOOL_RESULT_MAX_LINES,
      maxBytes: PI_TOOL_RESULT_MAX_BYTES,
    },
  };
}

export function piToolResultTruncationNotice(
  truncation: PiToolResultTruncation,
): string {
  const shown =
    truncation.truncatedBy === "lines"
      ? `${truncation.outputLines} of ${truncation.totalLines} lines`
      : `${truncation.outputBytes} of ${truncation.totalBytes} bytes`;
  const source = truncation.fullOutput?.path
    ? ` Full output stored in R2 at ${truncation.fullOutput.path}. Read it with read({ location: "r2", path: "${truncation.fullOutput.path}" }).`
    : "";
  return `[Output truncated: showing ${truncation.direction === "tail" ? "last" : "first"} ${shown}.${source}]`;
}

export function mergePiToolResultDetails(
  existing: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}),
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// Runtime-event / tool-result formatting
// ---------------------------------------------------------------------------

export function piRuntimeToolItem(
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown> | null,
  status: string,
): Record<string, unknown> {
  const normalizedArgs = args ?? {};
  return {
    id: toolCallId,
    type: "dynamicToolCall",
    tool: toolName || "tool",
    arguments: normalizedArgs,
    status,
  };
}

export function piEventArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function piToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    const content = record.content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          const part = item as Record<string, unknown>;
          return typeof part.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

export function piRuntimeContentItems(result: unknown): unknown[] {
  if (!result || typeof result !== "object") return [];
  const content = (result as Record<string, unknown>).content;
  return Array.isArray(content) ? content : [];
}

export function latestPiAssistantForkEntryId(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    if (typeof record.responseId === "string" && record.responseId.trim()) {
      return record.responseId.trim();
    }
    const timestamp = typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
      ? record.timestamp
      : Date.now();
    return `pi_assistant_${timestamp}_${index}`;
  }
  return null;
}

export function piRuntimeUsageSummary(message: AgentMessage): Record<string, unknown> | null {
  if (message.role !== "assistant") return null;
  const usage = (message as AgentMessage & {
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
      cost?: { total?: number };
    };
  }).usage;
  if (!usage) return null;

  const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
  const output = Math.max(0, Math.floor(Number(usage.output ?? 0)));
  const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
  const cacheWrite = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
  const totalTokens = Math.max(
    input + output + cacheRead + cacheWrite,
    Math.floor(Number(usage.totalTokens ?? 0)),
  );
  if (totalTokens <= 0) return null;

  const costTotal = Number(usage.cost?.total);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(Number.isFinite(costTotal) && costTotal > 0
      ? { cost: { total: costTotal } }
      : {}),
  };
}

export function addPiRuntimeUsageSummaries(
  current: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!next) return current;
  const sum = (key: string) =>
    Math.max(0, Math.floor(Number(current?.[key] ?? 0))) +
    Math.max(0, Math.floor(Number(next[key] ?? 0)));
  const currentCost = Number((current?.cost as { total?: unknown } | undefined)?.total ?? 0);
  const nextCost = Number((next.cost as { total?: unknown } | undefined)?.total ?? 0);
  const costTotal =
    (Number.isFinite(currentCost) && currentCost > 0 ? currentCost : 0) +
    (Number.isFinite(nextCost) && nextCost > 0 ? nextCost : 0);
  return {
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    totalTokens: sum("totalTokens"),
    ...(costTotal > 0 ? { cost: { total: costTotal } } : {}),
  };
}

export function piUsageSourceId(
  threadId: string,
  assistant: {
    responseId?: string;
    responseModel?: string;
    model?: string;
    timestamp?: number;
  },
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): string {
  const responseId = assistant.responseId?.trim();
  if (responseId) {
    return `${threadId}:response:${responseId}`;
  }
  const model = assistant.responseModel || assistant.model || "unknown";
  const timestamp =
    typeof assistant.timestamp === "number" && Number.isFinite(assistant.timestamp)
      ? Math.floor(assistant.timestamp)
      : Date.now();
  return [
    threadId,
    "assistant",
    timestamp,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ].join(":");
}

export function extractToolText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (typeof record.text === "string") return record.text;
    if (Array.isArray(record.content)) {
      const text = record.content
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          const item = entry as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? item.text : "";
        })
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if (typeof record.stdout === "string" || typeof record.stderr === "string") {
      return [record.stdout, record.stderr].filter((value) => typeof value === "string" && value).join("\n");
    }
  }
  return JSON.stringify(result, null, 2);
}

export function extractToolContent(
  result: unknown,
): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  type ExtractedToolContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const content: ExtractedToolContent[] = [];
      for (const entry of record.content) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        if (item.type === "text" && typeof item.text === "string") {
          content.push({ type: "text", text: item.text });
        }
        if (
          item.type === "image" &&
          typeof item.data === "string" &&
          typeof item.mimeType === "string"
        ) {
          const mimeType = normalizePiImageMimeType(item.mimeType);
          if (PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
            content.push({ type: "image", data: item.data, mimeType });
          } else {
            content.push({
              type: "text",
              text: piUnsupportedImageText(item.mimeType),
            });
          }
        }
      }
      if (content.length > 0) return content;
    }
  }
  return [{ type: "text", text: extractToolText(result) }];
}

// ---------------------------------------------------------------------------
// pi_core message identity: dedup keys and render-message-id stamping
// ---------------------------------------------------------------------------

export function piCoreMessageKey(message: AgentMessage): string {
  const record = stripPiUiMetadata(message) as unknown as Record<string, unknown>;
  if (record.role === "assistant" && typeof record.responseId === "string" && record.responseId.trim()) {
    return `assistant:${record.responseId.trim()}`;
  }
  if (record.role === "toolResult" && typeof record.toolCallId === "string" && record.toolCallId.trim()) {
    return [
      "toolResult",
      record.toolCallId.trim(),
      record.isError === true ? "error" : "ok",
      piCoreMessageKeyContent(record.content),
    ].join(":");
  }
  return [
    record.role,
    typeof record.timestamp === "number" ? record.timestamp : "",
    typeof record.responseId === "string" ? record.responseId : "",
    typeof record.toolCallId === "string" ? record.toolCallId : "",
    piCoreMessageKeyContent(record.content),
  ].join(":");
}

/**
 * Image identity for a dedup key: `(mimeType, base64 length)`, never the bytes.
 *
 * The SAME image legitimately appears in three shapes, and all three must key
 * identically or `appendPiCoreMessagesIfMissing` re-appends a row it already has:
 *
 *  1. INLINE, as the live session/journal message carries it;
 *  2. EXTERNALIZED AT WRITE TIME — `externalizePiImagesForSqlStorage` stores
 *     `data: ""` plus an R2 ref for anything over
 *     `PI_MAX_PERSISTED_IMAGE_DATA_CHARS`, so the stored row never matched its
 *     own live counterpart (a latent duplicate-append this normalization fixes);
 *  3. EXTERNALIZED AT LOAD TIME — the session working-set trim
 *     (`PI_SESSION_INLINE_IMAGE_MAX_CHARS`) hands the session a ref instead of
 *     the base64 without touching the stored row at all.
 *
 * `ref.size` is recorded as `data.length` at externalization in both cases, so
 * `max(inline, declared)` is exactly invariant across the three. Nothing cheaper
 * is: the sha256 exists only on the ref side, and hashing on the inline side
 * would cost a full scan of every image on every dedup.
 *
 * The identity this gives up is "two different images of byte-identical length
 * and the same MIME type". Every key that can carry an image also carries a
 * toolCallId, or a role plus a millisecond timestamp, so a collision needs two
 * messages of the same role in the same millisecond carrying different images
 * that encode to exactly the same number of base64 characters. In exchange the
 * 20k truncation below stops being consumed by base64 — an image-bearing
 * message's key now discriminates on its TEXT, which it previously could not.
 */
function normalizePiKeyContentImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const normalized = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const record = part as Record<string, unknown>;
    if (record.type !== "image") return part;
    const inlineChars = typeof record.data === "string" ? record.data.length : 0;
    const metadata = record.metadata && typeof record.metadata === "object"
      ? record.metadata as Record<string, unknown>
      : undefined;
    const ref = metadata?.[PI_R2_IMAGE_REF_METADATA_KEY];
    const declaredChars = ref && typeof ref === "object"
      ? Math.max(0, Math.floor(Number((ref as Record<string, unknown>).size) || 0))
      : 0;
    changed = true;
    const mimeType = typeof record.mimeType === "string"
      ? normalizePiImageMimeType(record.mimeType)
      : "";
    // A TEXT part, not a stripped image part: `preparePiMessageForSqlStorage`
    // runs `sanitizePiProviderContent` over this, which rewrites any image
    // carrying neither inline data nor an R2 ref into a fixed "unsupported MIME
    // type" marker — collapsing every image of a given type to one string and
    // throwing away the length that does the discriminating.
    return {
      type: "text",
      text: `[image:${mimeType}:${Math.max(inlineChars, declaredChars)}]`,
    };
  });
  return changed ? normalized : content;
}

export function piCoreMessageKeyContent(content: unknown): string {
  try {
    const serialized = JSON.stringify(preparePiMessageForSqlStorage({
      role: "user",
      content: normalizePiKeyContentImages(content),
      timestamp: 0,
    } as unknown as AgentMessage));
    return serialized.length > 20_000
      ? serialized.slice(0, 20_000)
      : serialized;
  } catch {
    return String(content);
  }
}

export function dedupePiMessagesByKey(
  messages: AgentMessage[],
  existingKeys: Iterable<string> = [],
): AgentMessage[] {
  const seen = new Set(existingKeys);
  return messages.filter((message) => {
    const key = piCoreMessageKey(message);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Stamp assistant rows with the render-history message id they stream into
 * (`uiMetadata.renderMessageId`, the minted turnId) before a pi_core commit.
 * This is the same-content-same-id invariant: the backfill converts stamped
 * rows under exactly the id the live stream persists, so whichever writer
 * runs first, the other's upsert converges on one row — no content-heuristic
 * dedup or persist-ordering gates needed. Copies are stamped (the session's
 * own message objects are not mutated); piCoreMessageKey strips uiMetadata,
 * so dedup keys are unaffected.
 */
export function stampPiRenderMessageId(
  messages: AgentMessage[],
  renderMessageId: string | null,
): AgentMessage[] {
  if (!renderMessageId) return messages;
  return messages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "assistant") return message;
    return withPiRenderMessageId(message, renderMessageId);
  });
}

/** Single-message form of the render-id stamp (any role): user rows carry
 * the id of the ui skeleton persisted for them, assistant rows the turnId. */
export function withPiRenderMessageId(
  message: AgentMessage,
  renderMessageId: string | null,
): AgentMessage {
  if (!renderMessageId) return message;
  const record = message as unknown as Record<string, unknown>;
  const existing = normalizePiUiMetadata(record.uiMetadata);
  if (existing?.renderMessageId === renderMessageId) return message;
  return {
    ...record,
    uiMetadata: {
      ...existing,
      renderMessageId,
    } satisfies PiUiMetadata,
  } as unknown as AgentMessage;
}
