import type { UIMessage } from "ai";

export const CHAT_RENDER_WINDOW_MAX_MESSAGES = 50;
export const CHAT_RENDER_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

/** Opaque older-page cursor for derive-on-read history (`d:<endExclusiveIndex>`). */
export const DERIVED_RENDER_HISTORY_CURSOR_PREFIX = "d:";

export interface ChatRenderHistoryPage {
  messages: UIMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function estimateUiMessageBytes(message: UIMessage): number {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 1024;
  }
}

export function encodeDerivedRenderHistoryCursor(endExclusiveIndex: number): string {
  return `${DERIVED_RENDER_HISTORY_CURSOR_PREFIX}${Math.max(0, Math.floor(endExclusiveIndex))}`;
}

/** SQLite/ai-chat chronology string from epoch ms (`YYYY-MM-DD HH:MM:SS.mmm`). */
export function formatAiChatCreatedAt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export function parseDerivedRenderHistoryCursor(
  cursor: string,
): number | null {
  if (!cursor.startsWith(DERIVED_RENDER_HISTORY_CURSOR_PREFIX)) return null;
  const raw = cursor.slice(DERIVED_RENDER_HISTORY_CURSOR_PREFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  const index = Number(raw);
  if (!Number.isFinite(index) || index < 0) return null;
  return Math.floor(index);
}

/**
 * Page a chronologically-ordered derived transcript newest-first (same window
 * semantics as ai-chat's renderHistoryWindow), with an opaque `d:` cursor.
 */
export function pageDerivedUiMessages(
  messages: readonly UIMessage[],
  options: {
    beforeCursor?: string | null;
    maxMessages?: number;
    maxBytes?: number;
  } = {},
): ChatRenderHistoryPage {
  const maxMessages = Math.max(
    1,
    Math.floor(options.maxMessages ?? CHAT_RENDER_WINDOW_MAX_MESSAGES),
  );
  const maxBytes = Math.max(
    1,
    Math.floor(options.maxBytes ?? CHAT_RENDER_WINDOW_MAX_BYTES),
  );

  let endExclusive = messages.length;
  if (options.beforeCursor != null && options.beforeCursor !== "") {
    const parsed = parseDerivedRenderHistoryCursor(String(options.beforeCursor));
    if (parsed === null) {
      throw new Error("A valid derived render-history cursor is required");
    }
    endExclusive = Math.min(parsed, messages.length);
  }

  const selectedReversed: UIMessage[] = [];
  let bytes = 0;
  for (let index = endExclusive - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageBytes = Math.max(1, estimateUiMessageBytes(message));
    if (
      selectedReversed.length > 0 &&
      (selectedReversed.length >= maxMessages || bytes + messageBytes > maxBytes)
    ) {
      break;
    }
    selectedReversed.push(message);
    bytes += messageBytes;
  }

  const selected = selectedReversed.reverse();
  const startIndex = endExclusive - selected.length;
  const hasMore = startIndex > 0;
  return {
    messages: selected,
    nextCursor: hasMore ? encodeDerivedRenderHistoryCursor(startIndex) : null,
    hasMore,
  };
}

export type ResidentRenderHistoryUpdate =
  | { kind: "initial"; evicted: UIMessage[] }
  | { kind: "rollover"; evicted: UIMessage[] }
  | { kind: "replacement"; evicted: UIMessage[] };

export function shouldHydrateRenderHistoryCursor(
  generation: number,
  previousProp: string | null,
  nextProp: string | null,
): boolean {
  return generation === 0 && previousProp !== nextProp;
}

export function isCurrentRenderHistoryGeneration(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration;
}

export function prependOlderRenderMessages(
  current: UIMessage[],
  older: UIMessage[],
): UIMessage[] {
  if (older.length === 0) return current;

  const currentIds = new Set(current.map((message) => message.id));
  const seenOlderIds = new Set<string>();
  const uniqueOlder = older.filter((message) => {
    if (currentIds.has(message.id) || seenOlderIds.has(message.id)) return false;
    seenOlderIds.add(message.id);
    return true;
  });

  return uniqueOlder.length === 0 ? current : [...uniqueOlder, ...current];
}

export function findEvictedRenderMessages(
  previousResident: UIMessage[],
  nextResident: UIMessage[],
): UIMessage[] {
  const update = classifyResidentRenderHistoryUpdate(
    previousResident,
    nextResident,
  );
  return update.kind === "rollover" ? update.evicted : [];
}

export function classifyResidentRenderHistoryUpdate(
  previousResident: UIMessage[],
  nextResident: UIMessage[],
): ResidentRenderHistoryUpdate {
  if (previousResident.length === 0) return { kind: "initial", evicted: [] };
  if (nextResident.length === 0) return { kind: "replacement", evicted: [] };

  const nextFirstId = nextResident[0].id;
  const overlapStart = previousResident.findIndex(
    (message) => message.id === nextFirstId,
  );
  if (overlapStart < 0) return { kind: "replacement", evicted: [] };

  const previousSuffix = previousResident.slice(overlapStart);
  if (
    nextResident.length < previousSuffix.length ||
    previousSuffix.some(
      (message, index) => message.id !== nextResident[index]?.id,
    )
  ) {
    return { kind: "replacement", evicted: [] };
  }
  return {
    kind: "rollover",
    evicted: previousResident.slice(0, overlapStart),
  };
}

export function appendEvictedRenderMessages(
  current: UIMessage[],
  evicted: UIMessage[],
): UIMessage[] {
  if (evicted.length === 0) return current;

  const seen = new Set(current.map((message) => message.id));
  const uniqueEvicted = evicted.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
  return uniqueEvicted.length === 0 ? current : [...current, ...uniqueEvicted];
}
