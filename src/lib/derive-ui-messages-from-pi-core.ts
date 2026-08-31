import type { UIMessage } from "ai";

import {
  PI_STEER_MARKER_PART,
  piSteerMarkerPartId,
} from "@/lib/pi-chunk-encoder";
import { parseMessageAuthor } from "@/lib/message-author";
import {
  messageToUiMessage,
  uiMessageCreatedAtMs,
} from "@/lib/ui-message-adapter";
import type { ContentBlock, Message } from "@/types";

/**
 * Minimal pi_core → render row shape. Compatible with AgentEvalParsedMessage
 * (extra fields like thread_id are ignored).
 */
export interface PiParsedRenderMessage {
  id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId: string;
  /** Render-history message id this row streams into (uiMetadata stamp). */
  renderMessageId?: string;
  sentDuringStreaming?: boolean;
  /** Compaction summary rows are model-facing only; omit from UI derive. */
  isCompactSummary?: boolean;
}

/**
 * A derive pass plus the row provenance of every message it produced.
 *
 * `anchorIndexes[i]` / `endIndexes[i]` are indexes into the INPUT `parsed` array:
 * the first and last row folded into message `i` (equal for an unfolded row).
 * A windowed reader needs them to answer the only two questions pagination asks
 * of the fold — "which pi_core row does this message start at" (the cursor it
 * publishes) and "where does its turn end" (the boundary a window may not cut).
 */
export interface DerivedUiMessagesWithRowAnchors {
  messages: UIMessage[];
  anchorIndexes: number[];
  endIndexes: number[];
}

/**
 * Derive settled UIMessages from parsed pi_core rows.
 *
 * Pure transform: fold multi-SDK-turn assistants sharing a renderMessageId,
 * insert steer markers for interposed user rows, prefer stamped user skeleton
 * ids, and order strictly by pi_core sequence. No SQL, no high-water mark, no
 * chronology rewrite — this is the Phase C read path.
 */
export function deriveUiMessagesFromParsedPiCore(
  parsed: readonly PiParsedRenderMessage[],
): UIMessage[] {
  return deriveUiMessagesWithRowAnchors(parsed).messages;
}

/**
 * {@link deriveUiMessagesFromParsedPiCore} with row provenance. The two share
 * ONE implementation on purpose: the storage-boundary pager pages by turn, so a
 * second copy of the grouping rules is the corruption risk (a window that cuts
 * a fold emits a partial message under an id another page also emits).
 */
export function deriveUiMessagesWithRowAnchors(
  parsed: readonly PiParsedRenderMessage[],
): DerivedUiMessagesWithRowAnchors {
  // Drop compaction summaries before indexing so steer fold positions stay
  // aligned with the visible transcript. `visibleToParsed` carries the input
  // index of every surviving row so anchors are reported in INPUT space.
  const visible: PiParsedRenderMessage[] = [];
  const visibleToParsed: number[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const row = parsed[index];
    if (row.isCompactSummary === true) continue;
    visible.push(row);
    visibleToParsed.push(index);
  }
  if (visible.length === 0) {
    return { messages: [], anchorIndexes: [], endIndexes: [] };
  }

  const convertedByIndex = new Map<number, UIMessage>();
  const convertAt = (index: number): UIMessage => {
    const cached = convertedByIndex.get(index);
    if (cached) return cached;
    const row = visible[index];
    let converted = messageToUiMessage(toAdapterMessage(row));
    if (
      row.role === "user" &&
      typeof row.renderMessageId === "string" &&
      row.renderMessageId
    ) {
      converted = { ...converted, id: row.renderMessageId } as UIMessage;
    }
    convertedByIndex.set(index, converted);
    return converted;
  };

  const resolvedUserIdAt = (index: number): string => {
    const row = visible[index];
    if (typeof row.renderMessageId === "string" && row.renderMessageId) {
      return row.renderMessageId;
    }
    return convertAt(index).id;
  };

  const assistantIndexesByStamp = new Map<string, number[]>();
  for (let index = 0; index < visible.length; index += 1) {
    const row = visible[index];
    if (
      row.role !== "assistant" ||
      typeof row.renderMessageId !== "string" ||
      !row.renderMessageId
    ) {
      continue;
    }
    const indexes = assistantIndexesByStamp.get(row.renderMessageId) ?? [];
    indexes.push(index);
    assistantIndexesByStamp.set(row.renderMessageId, indexes);
  }

  const stampedAssistantIndexes = new Set<number>();
  const foldedAssistantByFirstIndex = new Map<number, UIMessage>();
  const foldedLastIndexByFirstIndex = new Map<number, number>();
  for (const [renderMessageId, indexes] of assistantIndexesByStamp) {
    for (const index of indexes) stampedAssistantIndexes.add(index);

    const firstIndex = indexes[0];
    const parts: UIMessage["parts"] = [];
    let previousAssistantIndex = firstIndex;
    for (let offset = 0; offset < indexes.length; offset += 1) {
      const assistantIndex = indexes[offset];
      if (offset > 0) {
        for (
          let between = previousAssistantIndex + 1;
          between < assistantIndex;
          between += 1
        ) {
          const interposed = visible[between];
          if (interposed.role !== "user") continue;
          const steerMessageId = resolvedUserIdAt(between);
          const acceptedAtMs =
            typeof interposed.created_at === "number" &&
            Number.isFinite(interposed.created_at)
              ? interposed.created_at
              : 0;
          parts.push({
            type: PI_STEER_MARKER_PART,
            id: piSteerMarkerPartId(steerMessageId),
            data: { steerMessageId, acceptedAtMs },
          } as UIMessage["parts"][number]);
        }
      }
      parts.push(...convertAt(assistantIndex).parts);
      previousAssistantIndex = assistantIndex;
    }

    const rows = indexes.map((index) => visible[index]);
    const forkEntryIds = rows
      .map((row) => row.forkEntryId)
      .filter((id): id is string => typeof id === "string" && !!id);
    const pi: Record<string, unknown> =
      forkEntryIds.length > 0
        ? {
            forkEntryId: forkEntryIds[forkEntryIds.length - 1],
            forkEntryIds,
          }
        : {};
    const firstCreatedAt = (
      convertAt(firstIndex).metadata as
        | { pi?: { createdAtMs?: unknown } }
        | undefined
    )?.pi?.createdAtMs;
    if (typeof firstCreatedAt === "number") pi.createdAtMs = firstCreatedAt;
    foldedAssistantByFirstIndex.set(firstIndex, {
      id: renderMessageId,
      role: "assistant",
      parts,
      metadata: { pi },
    } as UIMessage);
    // The fold's span INCLUDES rows interposed between its assistant commits
    // (steer user rows, whose markers are folded in above): a window that ends
    // inside that span would split the turn.
    foldedLastIndexByFirstIndex.set(
      firstIndex,
      indexes[indexes.length - 1],
    );
  }

  const uiMessages: UIMessage[] = [];
  const anchorIndexes: number[] = [];
  const endIndexes: number[] = [];
  for (let index = 0; index < visible.length; index += 1) {
    if (stampedAssistantIndexes.has(index)) {
      const folded = foldedAssistantByFirstIndex.get(index);
      if (!folded) continue;
      uiMessages.push(folded);
      anchorIndexes.push(visibleToParsed[index]);
      endIndexes.push(
        visibleToParsed[foldedLastIndexByFirstIndex.get(index) ?? index],
      );
      continue;
    }
    uiMessages.push(convertAt(index));
    anchorIndexes.push(visibleToParsed[index]);
    endIndexes.push(visibleToParsed[index]);
  }
  return { messages: uiMessages, anchorIndexes, endIndexes };
}

/**
 * Overlay the live ai-chat resident rows onto derived settled history.
 *
 * - Open turn id → live row wins.
 * - Live user skeleton with `piCoreMessageKey` or matching `createdAtMs`
 *   replaces the derived `pi_user_*` bubble (same-content-same-id; also keeps
 *   stable archive ids after compaction renumbers pi_core indexes).
 * - Live assistant whose `metadata.pi.forkEntryId(s)` match a derived
 *   assistant's fork entry replaces that derived row (legacy unstamped /
 *   live-minted turn ids).
 * - Remaining live-only rows (just-sent user, in-flight assistant not yet in
 *   pi_core) append at the end — skipped when role+createdAtMs already settled.
 *
 * `appendLiveOnly: false` keeps ONLY the replacements. An OLDER page is a window
 * in the middle of the transcript: live-only rows belong at the transcript's
 * newest end (where the full-array overlay always put them), so appending them
 * to an older page would show them twice.
 *
 * `appendLiveOnlyNewerThanMs` bounds the append for a WINDOWED `settled`. Over a
 * full transcript, "unmatched" meant "genuinely live"; over a window it also
 * catches every resident row belonging to an OLDER part of the transcript (a
 * pre-compaction archive row, the mirror of a message on an older page) — which
 * would then be appended as if it were the newest thing in the thread. A live-only
 * row is appended only when it carries no pi timestamp (a fresh skeleton) or one
 * at/after the window's newest settled message.
 */
export function overlayLiveUiMessages(
  settled: UIMessage[],
  live: readonly UIMessage[],
  options: {
    activeTurnId: string | null;
    appendLiveOnly?: boolean;
    appendLiveOnlyNewerThanMs?: number;
  },
): UIMessage[] {
  if (live.length === 0) return settled;

  const liveById = new Map<string, UIMessage>();
  const liveUserByPiKey = new Map<string, UIMessage>();
  const liveUserByCreatedAt = new Map<number, UIMessage>();
  const liveAssistantByForkEntryId = new Map<string, UIMessage>();
  for (const message of live) {
    if (typeof message?.id !== "string" || !message.id) continue;
    liveById.set(message.id, message);
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    if (message.role === "user") {
      const key = metadata.piCoreMessageKey;
      if (typeof key === "string" && key) liveUserByPiKey.set(key, message);
      const createdAt = uiMessageCreatedAtMs(message);
      if (createdAt !== undefined) liveUserByCreatedAt.set(createdAt, message);
    } else if (message.role === "assistant") {
      const pi =
        metadata.pi && typeof metadata.pi === "object"
          ? (metadata.pi as Record<string, unknown>)
          : null;
      const forkEntryId = pi?.forkEntryId;
      if (typeof forkEntryId === "string" && forkEntryId) {
        liveAssistantByForkEntryId.set(forkEntryId, message);
      }
      if (Array.isArray(pi?.forkEntryIds)) {
        for (const id of pi.forkEntryIds) {
          if (typeof id === "string" && id) {
            liveAssistantByForkEntryId.set(id, message);
          }
        }
      }
    }
  }

  const consumedLiveIds = new Set<string>();
  const result = settled.map((message) => {
    if (options.activeTurnId && message.id === options.activeTurnId) {
      const liveMsg = liveById.get(message.id);
      if (liveMsg) {
        consumedLiveIds.add(liveMsg.id);
        return liveMsg;
      }
    }

    if (message.role === "user") {
      const createdAt = uiMessageCreatedAtMs(message);
      const liveUser =
        (createdAt !== undefined
          ? liveUserByPiKey.get(String(createdAt))
          : undefined) ??
        (createdAt !== undefined
          ? liveUserByCreatedAt.get(createdAt)
          : undefined) ??
        liveById.get(message.id);
      if (liveUser) {
        consumedLiveIds.add(liveUser.id);
        return liveUser;
      }
    }

    if (message.role === "assistant") {
      const liveAssistant = findLiveAssistantForSettled(
        message,
        liveAssistantByForkEntryId,
        liveById,
      );
      if (liveAssistant) {
        consumedLiveIds.add(liveAssistant.id);
        return liveAssistant;
      }
    }

    return message;
  });

  if (options.appendLiveOnly === false) return result;

  const appendFloorMs = options.appendLiveOnlyNewerThanMs;
  const settledIds = new Set(result.map((message) => message.id));
  const settledDedupeKeys = new Set(
    result.map((message) => renderOverlayDedupeKey(message)),
  );
  for (const message of live) {
    if (!message?.id || consumedLiveIds.has(message.id) || settledIds.has(message.id)) {
      continue;
    }
    const dedupeKey = renderOverlayDedupeKey(message);
    if (settledDedupeKeys.has(dedupeKey)) {
      continue;
    }
    if (appendFloorMs !== undefined) {
      const createdAt = uiMessageCreatedAtMs(message);
      if (createdAt !== undefined && createdAt < appendFloorMs) continue;
    }
    settledIds.add(message.id);
    settledDedupeKeys.add(dedupeKey);
    result.push(message);
  }
  return result;
}

function renderOverlayDedupeKey(message: UIMessage): string {
  const createdAt = uiMessageCreatedAtMs(message);
  if (createdAt !== undefined) return `${message.role}:${createdAt}`;
  return `${message.role}:${message.id}`;
}

function findLiveAssistantForSettled(
  settled: UIMessage,
  liveAssistantByForkEntryId: Map<string, UIMessage>,
  liveById: Map<string, UIMessage>,
): UIMessage | undefined {
  const metadata = (settled.metadata ?? {}) as Record<string, unknown>;
  const pi =
    metadata.pi && typeof metadata.pi === "object"
      ? (metadata.pi as Record<string, unknown>)
      : null;
  if (typeof pi?.forkEntryId === "string" && pi.forkEntryId) {
    const match = liveAssistantByForkEntryId.get(pi.forkEntryId);
    if (match) return match;
  }
  if (Array.isArray(pi?.forkEntryIds)) {
    for (const id of pi.forkEntryIds) {
      if (typeof id !== "string" || !id) continue;
      const match = liveAssistantByForkEntryId.get(id);
      if (match) return match;
    }
  }
  // Unstamped derive uses forkEntryId as the UIMessage id.
  const byForkAsId = liveAssistantByForkEntryId.get(settled.id);
  if (byForkAsId) return byForkAsId;
  return liveById.get(settled.id);
}

function toAdapterMessage(row: PiParsedRenderMessage): Message {
  let content: string | ContentBlock[] =
    typeof row.content === "string"
      ? row.content
      : Array.isArray(row.content)
        ? (row.content as ContentBlock[])
        : "";
  let authorDisplayName: string | undefined;
  let messageSource: string | undefined;

  if (row.role === "user") {
    const parsedAuthor = parseMessageAuthor(content);
    content = parsedAuthor.content;
    if (parsedAuthor.author?.displayName) {
      authorDisplayName = parsedAuthor.author.displayName;
    }
    if (parsedAuthor.source) {
      messageSource = parsedAuthor.source;
    }
  }

  return {
    id: row.id,
    thread_id: "",
    role: row.role,
    content,
    created_at: row.created_at,
    forkEntryId: row.forkEntryId,
    ...(row.sentDuringStreaming ? { sentDuringStreaming: true } : {}),
    ...(authorDisplayName ? { authorDisplayName } : {}),
    ...(messageSource ? { messageSource } : {}),
  };
}
