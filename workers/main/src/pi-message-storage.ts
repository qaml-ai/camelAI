// Pure helpers, constants, and types for sanitizing, serializing, and
// truncating Pi messages and tool results for SQLite/R2 storage. Extracted from
// chat-thread-do.ts. This is a leaf module — no Durable Object state and no
// import cycles.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { stripPiUiMetadata } from "../../../src/lib/runtime-artifacts";

export const PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function normalizePiImageMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

export function piUnsupportedImageText(mimeType: unknown): string {
  const label =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "unknown MIME type";
  return `(image omitted: unsupported MIME type ${label})`;
}

export interface PiInlineImageDataStripResult {
  text: string;
  count: number;
  bytes: number;
}

/** Remove inline image data URLs for model routes that cannot inspect images. */
export function stripPiInlineImageDataUrls(text: string): PiInlineImageDataStripResult {
  let count = 0;
  let bytes = 0;
  const stripped = text.replace(
    /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,([A-Za-z0-9+/_=-]+)/gi,
    (_match, data: string) => {
      count += 1;
      const imageBytes = Math.floor((data.length * 3) / 4);
      bytes += imageBytes;
      return `[inline image omitted: ${imageBytes} bytes; active model cannot inspect images]`;
    },
  );
  return { text: stripped, count, bytes };
}

export const PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS = 1_500_000;
export const PI_MAX_PERSISTED_IMAGE_DATA_CHARS = 512_000;
export const PI_MAX_PERSISTED_TEXT_CHARS = 200_000;
export const PI_R2_IMAGE_REF_METADATA_KEY = "chiridionR2Image";
export const PI_TOOL_RESULT_MAX_LINES = 2_000;
export const PI_TOOL_RESULT_MAX_BYTES = 50 * 1024;
export const PI_TOOL_RESULT_R2_REF_METADATA_KEY = "chiridionR2ToolResult";
export const PI_TOOL_DETAILS_MAX_BYTES = 32 * 1024;
export const PI_TOOL_DETAILS_MAX_ITEMS = 128;
export const PI_TOOL_DETAILS_MAX_DEPTH = 6;
// Tools whose oversized output is truncated from the head (keeping the most
// recent lines) rather than the tail. Empty now that the shell `bash` tool is
// gone; kept as an extension point for future streaming/log-style tools.
export const PI_TAIL_TRUNCATED_TOOL_NAMES = new Set<string>();

/**
 * Where an image reference came from, and therefore what it is allowed to do.
 *
 * `"storage"` (the default, and what an absent field means on every row written
 * before this discriminator existed) is DURABLE: the row itself has no bytes,
 * because the image was over `PI_MAX_PERSISTED_IMAGE_DATA_CHARS` when it was
 * committed. Render shows a marker for it and always has.
 *
 * `"session"` is EPHEMERAL: the row still holds its base64 and only the loaded
 * in-memory copy was trimmed (see `PI_SESSION_INLINE_IMAGE_MAX_CHARS`). It is a
 * working-set optimization and must never reach a stored row — a rewrite that
 * persisted one would delete the image from the user's visible history, which
 * is exactly what the session trim is documented as not doing. The write path
 * re-inlines it (`restoreSessionExternalizedImages`); the provider path charges
 * it against the declared-char budget only, because inline is what it would
 * have been without the trim.
 */
export type PiR2ImageReferenceOrigin = "storage" | "session";

export interface PiR2ImageReference {
  key: string;
  mimeType: string;
  size: number;
  sha256: string;
  storedAt: number;
  /** Absent means `"storage"` — see {@link PiR2ImageReferenceOrigin}. */
  origin?: PiR2ImageReferenceOrigin;
}

export interface PiR2ToolResultReference {
  path: string;
  size: number;
  sha256: string;
  storedAt: number;
}

export interface PiToolResultTruncation {
  truncated: true;
  truncatedBy: "lines" | "bytes";
  direction: "head" | "tail";
  totalLines: number;
  outputLines: number;
  totalBytes: number;
  outputBytes: number;
  maxLines: number;
  maxBytes: number;
  fullOutput?: PiR2ToolResultReference;
}

export interface PiSqlStorageStats {
  externalizedImages: number;
  omittedImages: number;
  truncatedStrings: number;
  omittedWholeMessage: boolean;
  originalChars: number;
  storedChars: number;
}

export interface PiSqlStorageSerialization {
  payload: string;
  stats: PiSqlStorageStats;
}

export function hasPiR2ImageReferenceMetadata(record: Record<string, unknown>): boolean {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const ref = (metadata as Record<string, unknown>)[PI_R2_IMAGE_REF_METADATA_KEY];
  if (!ref || typeof ref !== "object") return false;
  const refRecord = ref as Record<string, unknown>;
  return (
    typeof refRecord.key === "string" &&
    refRecord.key.length > 0 &&
    typeof refRecord.mimeType === "string" &&
    refRecord.mimeType.length > 0 &&
    typeof refRecord.sha256 === "string" &&
    refRecord.sha256.length > 0
  );
}

export function piLargeImageStorageText(mimeType: unknown, dataChars: number): string {
  const label =
    typeof mimeType === "string" && mimeType.trim()
      ? mimeType.trim()
      : "unknown MIME type";
  return `(image data omitted from persisted transcript: ${label}, ${dataChars} base64 chars)`;
}

export function emptyPiSqlStorageStats(): PiSqlStorageStats {
  return {
    omittedImages: 0,
    externalizedImages: 0,
    truncatedStrings: 0,
    omittedWholeMessage: false,
    originalChars: 0,
    storedChars: 0,
  };
}

export function truncatePiStorageString(value: string, stats?: PiSqlStorageStats): string {
  if (value.length <= PI_MAX_PERSISTED_TEXT_CHARS) return value;
  const omitted = value.length - PI_MAX_PERSISTED_TEXT_CHARS;
  if (stats) stats.truncatedStrings += 1;
  return `${value.slice(0, PI_MAX_PERSISTED_TEXT_CHARS)}\n\n[...truncated ${omitted} characters for storage safety...]`;
}

export function sanitizePiProviderContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const sanitized = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type !== "image") return part;

    const mimeType = typeof item.mimeType === "string"
      ? normalizePiImageMimeType(item.mimeType)
      : "";
    const data = typeof item.data === "string" ? item.data : "";
    if (
      mimeType &&
      PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType) &&
      (data || hasPiR2ImageReferenceMetadata(item))
    ) {
      if (mimeType === item.mimeType) return part;
      changed = true;
      return { ...item, mimeType };
    }

    changed = true;
    return { type: "text", text: piUnsupportedImageText(item.mimeType) };
  });

  return changed ? sanitized : content;
}

export function sanitizePiProviderMessage(message: AgentMessage): AgentMessage {
  if (!message || typeof message !== "object") return message;
  const record = message as unknown as Record<string, unknown>;
  if (!Array.isArray(record.content)) return message;
  const content = sanitizePiProviderContent(record.content);
  if (content === record.content) return message;
  return { ...record, content } as unknown as AgentMessage;
}

export function sanitizePiModelMessage(message: AgentMessage): AgentMessage {
  return sanitizePiProviderMessage(stripPiUiMetadata(message));
}

export function sanitizePiProviderContentForSqlStorage(content: unknown, stats?: PiSqlStorageStats): unknown {
  const supported = sanitizePiProviderContent(content);
  if (!Array.isArray(supported)) return supported;
  let changed = supported !== content;
  const sanitized = supported.map((part) => {
    if (!part || typeof part !== "object") return part;
    const item = part as Record<string, unknown>;
    if (item.type === "image") {
      const data = typeof item.data === "string" ? item.data : "";
      if (data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS) {
        if (stats) stats.omittedImages += 1;
        changed = true;
        return {
          type: "text",
          text: piLargeImageStorageText(item.mimeType, data.length),
        };
      }
    }
    return part;
  });
  return changed ? sanitized : content;
}

const PI_TOOL_DETAIL_DUPLICATE_ROOT_KEYS = [
  "body",
  "content",
  "data",
  "output",
  "raw",
  "stderr",
  "stdout",
  "text",
] as const;
const PI_TOOL_DETAIL_PRIORITY_KEYS = [
  "status",
  "statusCode",
  "ok",
  "success",
  "isError",
  "error",
  "artifacts",
  "artifact",
  "uiMetadata",
  "metadata",
  "details",
  // Tool-specific render fields must be admitted before potentially large
  // diagnostics such as edit diffs.
  "replacementCount",
  "activities",
  "toolActivities",
  "childToolsUsed",
  "durationMs",
  "toolUseCount",
  "preview",
  "deployment",
  "diff",
  "patch",
];
const PI_TOOL_DETAIL_OMITTED = "[model-visible tool output omitted from details]";
const PI_TOOL_DETAIL_TRUNCATED = "[details truncated]";
const PI_TOOL_DETAIL_TEXT_ENCODER = new TextEncoder();

function jsonUtf8Bytes(value: string | number | boolean | null): number {
  return PI_TOOL_DETAIL_TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function boundedJsonStringUtf8Bytes(value: string, maxBytes: number): number | null {
  if (maxBytes < 2) return null;
  let bytes = 2;
  for (const character of value) {
    const encoded = JSON.stringify(character);
    bytes += PI_TOOL_DETAIL_TEXT_ENCODER.encode(encoded.slice(1, -1)).byteLength;
    if (bytes > maxBytes) return null;
  }
  return bytes;
}

function projectPiToolDetailString(
  value: string,
  maxBytes: number,
): { value: string; bytes: number; changed: boolean } | null {
  if (maxBytes < 2) return null;
  let output = "";
  let bytes = 2;
  let changed = false;
  for (const character of value) {
    // Stringify one code point only; never materialize an unbounded escaped copy.
    const encoded = JSON.stringify(character);
    const characterBytes = PI_TOOL_DETAIL_TEXT_ENCODER.encode(encoded.slice(1, -1)).byteLength;
    if (bytes + characterBytes > maxBytes) {
      changed = true;
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  if (changed) {
    const markerBytes = jsonUtf8Bytes(PI_TOOL_DETAIL_TRUNCATED) - 2;
    if (bytes + markerBytes <= maxBytes) {
      output += PI_TOOL_DETAIL_TRUNCATED;
      bytes += markerBytes;
    }
  }
  return { value: output, bytes, changed };
}

interface ProjectedPiToolDetail {
  value: unknown;
  bytes: number;
  changed: boolean;
}

/**
 * Preserve bounded status/artifact/UI metadata without retaining a second full
 * copy of model-visible tool output. The budget is the exact JSON UTF-8 size,
 * including object keys and syntax. Traversal never stringifies an unbounded
 * object, and duplicate payload names are stripped only at the result root so
 * nested artifact schemas keep legitimate `data`/`body` fields.
 */
export function projectPiToolResultDetails(value: unknown): unknown {
  if (value === undefined) return undefined;
  let remainingItems = PI_TOOL_DETAILS_MAX_ITEMS;

  const visit = (
    item: unknown,
    depth: number,
    maxBytes: number,
    rootKey?: string,
  ): ProjectedPiToolDetail | null => {
    if (
      depth === 1 &&
      rootKey &&
      (PI_TOOL_DETAIL_DUPLICATE_ROOT_KEYS as readonly string[]).includes(rootKey)
    ) {
      const projected = projectPiToolDetailString(PI_TOOL_DETAIL_OMITTED, maxBytes);
      return projected ? { ...projected, changed: true } : null;
    }
    if (typeof item === "string") return projectPiToolDetailString(item, maxBytes);
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      const normalized = typeof item === "number" && !Number.isFinite(item) ? null : item;
      const bytes = jsonUtf8Bytes(normalized);
      return bytes <= maxBytes ? { value: normalized, bytes, changed: normalized !== item } : null;
    }
    if (item === undefined || typeof item === "function" || typeof item === "symbol") return null;
    if (typeof item === "bigint") {
      const projected = projectPiToolDetailString(String(item), maxBytes);
      return projected ? { ...projected, changed: true } : null;
    }
    if (depth >= PI_TOOL_DETAILS_MAX_DEPTH || maxBytes < 2 || remainingItems <= 0) {
      return null;
    }

    if (Array.isArray(item)) {
      const result: unknown[] = [];
      let bytes = 2;
      let changed = Object.getPrototypeOf(item) !== Array.prototype;
      for (const nested of item) {
        if (remainingItems <= 0) {
          changed = true;
          break;
        }
        const commaBytes = result.length > 0 ? 1 : 0;
        const projected = visit(nested, depth + 1, maxBytes - bytes - commaBytes);
        remainingItems -= 1;
        if (!projected) {
          changed = true;
          continue;
        }
        result.push(projected.value);
        bytes += commaBytes + projected.bytes;
        changed ||= projected.changed;
      }
      changed ||= result.length !== item.length;
      return { value: result, bytes, changed };
    }

    const source = item as Record<string, unknown>;
    const sourceKeys = Object.keys(source);
    const priority = new Map(PI_TOOL_DETAIL_PRIORITY_KEYS.map((key, index) => [key, index]));
    const keys = sourceKeys
      .map((key, index) => ({ key, index }))
      .sort((left, right) =>
        (priority.get(left.key) ?? PI_TOOL_DETAIL_PRIORITY_KEYS.length) -
          (priority.get(right.key) ?? PI_TOOL_DETAIL_PRIORITY_KEYS.length) ||
        left.index - right.index,
      );
    const result: Record<string, unknown> = {};
    let bytes = 2;
    const prototype = Object.getPrototypeOf(item);
    let changed = prototype !== Object.prototype && prototype !== null;
    for (const { key } of keys) {
      if (remainingItems <= 0) {
        changed = true;
        break;
      }
      // Count and bound the escaped UTF-8 key before visiting its value. This
      // stops an attacker-controlled giant key without materializing it via a
      // whole-key JSON.stringify or starving prioritized metadata.
      const commaBytes = Object.keys(result).length > 0 ? 1 : 0;
      const keyBudget = maxBytes - bytes - commaBytes - 1;
      const keyBytes = boundedJsonStringUtf8Bytes(key, keyBudget);
      if (keyBytes === null) {
        changed = true;
        continue;
      }
      const entryOverhead = commaBytes + keyBytes + 1;
      const projected = visit(source[key], depth + 1, maxBytes - bytes - entryOverhead, key);
      remainingItems -= 1;
      if (!projected) {
        changed = true;
        continue;
      }
      result[key] = projected.value;
      bytes += entryOverhead + projected.bytes;
      changed ||= projected.changed;
    }
    changed ||= Object.keys(result).length !== sourceKeys.length;
    return { value: result, bytes, changed };
  };

  const projected = visit(value, 0, PI_TOOL_DETAILS_MAX_BYTES);
  if (!projected) return { detailsOmitted: "payload budget exceeded" };
  // Preserve identity for unchanged plain JSON graphs so afterToolCall remains
  // a no-op. Custom prototypes/toJSON methods always use the plain projection.
  return projected.changed ? projected.value : value;
}

export function shrinkPiValueForSqlStorage(value: unknown, depth = 0, stats?: PiSqlStorageStats): unknown {
  if (typeof value === "string") return truncatePiStorageString(value, stats);
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth > 8) return "[nested value omitted for storage safety]";
  if (Array.isArray(value)) {
    return value.map((item) => shrinkPiValueForSqlStorage(item, depth + 1, stats));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    if (record.data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS) {
      if (stats) stats.omittedImages += 1;
      return {
        type: "text",
        text: piLargeImageStorageText(record.mimeType, record.data.length),
      };
    }
    return { ...record, data: record.data };
  }
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    next[key] = shrinkPiValueForSqlStorage(nested, depth + 1, stats);
  }
  return next;
}

export function preparePiMessageForSqlStorage(message: AgentMessage, stats?: PiSqlStorageStats): AgentMessage {
  if (!message || typeof message !== "object") return message;
  const providerSanitized = sanitizePiProviderMessage(message);
  const record = providerSanitized as unknown as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? sanitizePiProviderContentForSqlStorage(record.content, stats)
    : record.content;
  let next = content === record.content ? record : { ...record, content };
  if (record.role === "toolResult" && "details" in record) {
    next = { ...next, details: projectPiToolResultDetails(record.details) };
  }
  return shrinkPiValueForSqlStorage(next, 0, stats) as AgentMessage;
}

export function serializePiMessageForSqlStorageDetailed(message: AgentMessage): PiSqlStorageSerialization {
  const stats = emptyPiSqlStorageStats();
  let prepared = preparePiMessageForSqlStorage(message, stats);
  let serialized = JSON.stringify(prepared);
  // Avoid materializing the unbounded source solely for diagnostics.
  stats.originalChars = serialized.length;
  if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
    stats.storedChars = serialized.length;
    return { payload: serialized, stats };
  }

  prepared = shrinkPiValueForSqlStorage(prepared, 4, stats) as AgentMessage;
  serialized = JSON.stringify(prepared);
  if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
    stats.storedChars = serialized.length;
    return { payload: serialized, stats };
  }

  stats.omittedWholeMessage = true;
  const payload = JSON.stringify({
    role: (message as unknown as Record<string, unknown>).role ?? "user",
    content: `[message omitted from persisted transcript: serialized size ${serialized.length} chars exceeded storage safety limit]`,
    timestamp:
      typeof (message as unknown as Record<string, unknown>).timestamp === "number"
        ? (message as unknown as Record<string, unknown>).timestamp
        : Date.now(),
    metadata: { storageOmitted: true },
  });
  stats.storedChars = payload.length;
  return { payload, stats };
}

export function serializePiMessageForSqlStorage(message: AgentMessage): string {
  return serializePiMessageForSqlStorageDetailed(message).payload;
}
