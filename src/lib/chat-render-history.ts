import type { UIMessage } from "ai";

export const CHAT_RENDER_WINDOW_MAX_MESSAGES = 50;
export const CHAT_RENDER_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

/**
 * LEGACY opaque older-page cursor for derive-on-read history
 * (`d:<endExclusiveIndex>`), an index into a FULLY materialized settled array.
 * Superseded by {@link DERIVED_PI_RENDER_CURSOR_PREFIX}, whose positions live in
 * pi_core row space so a page can be derived without materializing the thread.
 * Still parsed so a cursor a client is holding across the deploy degrades to
 * "serve the newest page" instead of an error.
 */
export const DERIVED_RENDER_HISTORY_CURSOR_PREFIX = "d:";

/**
 * Opaque older-page cursor for STORAGE-BOUNDARY derive-on-read history:
 *
 *  - `dp:p:<beforeIdx>` — the next older page derives pi_core rows with
 *    `idx < beforeIdx`. `beforeIdx` is always a turn boundary (the anchor row of
 *    the oldest message the previous page served, or one past a fold's last
 *    row), so no window can ever cut a fold.
 *  - `dp:a:<aiChatCursor>` — the pi_core-derived tail is exhausted; the rest of
 *    the transcript is pre-compaction archive still held in the ai-chat render
 *    table, paged with that table's own chronology cursor (empty = start from
 *    the newest row older than the derive).
 */
export const DERIVED_PI_RENDER_CURSOR_PREFIX = "dp:";

export type DerivedPiRenderCursor =
  | { kind: "pi"; beforeIdx: number }
  | { kind: "archive"; beforeCursor: string | null };

export function encodeDerivedPiRowCursor(beforeIdx: number): string {
  return `${DERIVED_PI_RENDER_CURSOR_PREFIX}p:${Math.max(0, Math.floor(beforeIdx))}`;
}

export function encodeDerivedArchiveCursor(beforeCursor: string | null): string {
  return `${DERIVED_PI_RENDER_CURSOR_PREFIX}a:${beforeCursor ?? ""}`;
}

export function parseDerivedPiRenderCursor(
  cursor: string,
): DerivedPiRenderCursor | null {
  if (!cursor.startsWith(DERIVED_PI_RENDER_CURSOR_PREFIX)) return null;
  const rest = cursor.slice(DERIVED_PI_RENDER_CURSOR_PREFIX.length);
  if (rest.startsWith("p:")) {
    const raw = rest.slice(2);
    if (!/^\d+$/.test(raw)) return null;
    const beforeIdx = Number(raw);
    if (!Number.isFinite(beforeIdx) || beforeIdx < 0) return null;
    return { kind: "pi", beforeIdx: Math.floor(beforeIdx) };
  }
  if (rest.startsWith("a:")) {
    // The ai-chat chronology cursor carries its own `i:`/`e:` prefix and colons
    // from the timestamp; everything after `dp:a:` is that cursor verbatim.
    const raw = rest.slice(2);
    return { kind: "archive", beforeCursor: raw.length > 0 ? raw : null };
  }
  return null;
}

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
 *
 * @deprecated Requires the WHOLE transcript in memory, which is what made a
 * 5,232-row thread unloadable. The read path now pages at the storage boundary
 * (`workers/main/src/chat-thread/derived-render-page.ts`); this remains as the
 * definition of the legacy `d:` cursor the DO still accepts, and as the reference
 * the golden pagination-equivalence test compares against.
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

  const selected = selectNewestUiMessagesWithinBudget(messages, {
    endExclusive,
    maxMessages,
    maxBytes,
  });
  const startIndex = endExclusive - selected.length;
  const hasMore = startIndex > 0;
  return {
    messages: selected,
    nextCursor: hasMore ? encodeDerivedRenderHistoryCursor(startIndex) : null,
    hasMore,
  };
}

/**
 * The render window rule itself: walk back from `endExclusive` taking messages
 * until the count or byte ceiling would be crossed, always keeping at least one
 * (an oversized single message is served rather than an empty page).
 *
 * Shared by {@link pageDerivedUiMessages} and the storage-boundary pager so the
 * two cannot drift: the pager applies it to a WINDOW that is a suffix of the same
 * transcript, which selects exactly what applying it to the whole array would.
 */
export function selectNewestUiMessagesWithinBudget(
  messages: readonly UIMessage[],
  options: {
    endExclusive?: number;
    maxMessages?: number;
    maxBytes?: number;
  } = {},
): UIMessage[] {
  return selectNewestUiMessageWindow(messages, options).messages;
}

/**
 * {@link selectNewestUiMessagesWithinBudget} plus the budget it consumed, so a
 * caller can top a short page up from another store without re-serializing the
 * messages it already selected.
 */
export function selectNewestUiMessageWindow(
  messages: readonly UIMessage[],
  options: {
    endExclusive?: number;
    maxMessages?: number;
    maxBytes?: number;
  } = {},
): { messages: UIMessage[]; bytes: number } {
  const maxMessages = Math.max(
    1,
    Math.floor(options.maxMessages ?? CHAT_RENDER_WINDOW_MAX_MESSAGES),
  );
  const maxBytes = Math.max(
    1,
    Math.floor(options.maxBytes ?? CHAT_RENDER_WINDOW_MAX_BYTES),
  );
  const endExclusive = Math.max(
    0,
    Math.min(options.endExclusive ?? messages.length, messages.length),
  );

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
  return { messages: selectedReversed.reverse(), bytes };
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

/**
 * Stable identity for one rendered part, used to merge two halves of a turn that
 * pagination split without duplicating the overlap.
 */
function renderPartKey(part: unknown, index: number): string {
  if (!part || typeof part !== "object") return `${index}:${String(part)}`;
  const record = part as Record<string, unknown>;
  const type = String(record.type ?? "");
  if (typeof record.toolCallId === "string" && record.toolCallId) {
    return `${type}:${record.toolCallId}`;
  }
  if (type === "text" || type === "reasoning") {
    return `${type}:${String(record.text ?? "")}`;
  }
  try {
    return `${type}:${JSON.stringify(record)}`;
  } catch {
    return `${type}:${index}`;
  }
}

/**
 * Metadata flag the server sets on a message it is knowingly serving PARTIAL:
 * the derive's window closed inside that message's `renderMessageId` fold (one
 * turn bigger than the boundary byte budget — see
 * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR in
 * workers/main/src/chat-thread/derived-render-page.ts), so the turn's EARLIER
 * parts arrive on the next older page under the SAME id.
 *
 * Without this flag an id-keyed prepend drops that arrival, and the turn's
 * opening content is lost permanently and silently rather than "kept whichever
 * arrived first". With it, and only for messages carrying it, the older copy's
 * parts are merged in front of the ones already held.
 */
export const RENDER_FOLD_PARTIAL_METADATA_KEY = "piRenderFoldPartial";

function isFoldPartialRenderMessage(message: UIMessage): boolean {
  const metadata = (message as { metadata?: unknown }).metadata;
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>)[RENDER_FOLD_PARTIAL_METADATA_KEY] ===
      true
  );
}

export function markRenderFoldPartial(message: UIMessage): UIMessage {
  const metadata = (message as { metadata?: unknown }).metadata;
  return {
    ...message,
    metadata: {
      ...(metadata && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : {}),
      [RENDER_FOLD_PARTIAL_METADATA_KEY]: true,
    },
  } as UIMessage;
}

/**
 * Merge the earlier half of a split turn into the half already held. Only ever
 * applied to a message the server flagged as partial; every other duplicate id
 * keeps the copy already held (a resident/streamed row is authoritative).
 */
function mergeFoldPartialRenderMessage(
  current: UIMessage,
  older: UIMessage,
): UIMessage {
  const currentParts = Array.isArray(current.parts) ? current.parts : [];
  const olderParts = Array.isArray(older.parts) ? older.parts : [];
  const held = new Set(currentParts.map(renderPartKey));
  const missing = olderParts.filter(
    (part, index) => !held.has(renderPartKey(part, index)),
  );
  const metadata = { ...(current as { metadata?: object }).metadata } as Record<
    string,
    unknown
  >;
  delete metadata[RENDER_FOLD_PARTIAL_METADATA_KEY];
  const stillPartial = isFoldPartialRenderMessage(older);
  return {
    ...current,
    parts: missing.length > 0 ? [...missing, ...currentParts] : currentParts,
    metadata: stillPartial
      ? { ...metadata, [RENDER_FOLD_PARTIAL_METADATA_KEY]: true }
      : metadata,
  } as UIMessage;
}

export function prependOlderRenderMessages(
  current: UIMessage[],
  older: UIMessage[],
): UIMessage[] {
  if (older.length === 0) return current;

  const currentById = new Map(current.map((message) => [message.id, message]));
  const merged = new Map<string, UIMessage>();
  const seenOlderIds = new Set<string>();
  const uniqueOlder = older.filter((message) => {
    if (seenOlderIds.has(message.id)) return false;
    seenOlderIds.add(message.id);
    const held = currentById.get(message.id);
    if (!held) return true;
    if (isFoldPartialRenderMessage(held)) {
      merged.set(message.id, mergeFoldPartialRenderMessage(held, message));
    }
    return false;
  });

  const base =
    merged.size === 0
      ? current
      : current.map((message) => merged.get(message.id) ?? message);
  return uniqueOlder.length === 0 && merged.size === 0
    ? current
    : [...uniqueOlder, ...base];
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
