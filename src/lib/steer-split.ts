import type { UIMessage } from 'ai';

import { PI_STEER_MARKER_PART } from './pi-chunk-encoder';

type UiPart = UIMessage['parts'][number];

type SteerMarkerPart = UiPart & {
  type: typeof PI_STEER_MARKER_PART;
  data?: { steerMessageId?: unknown };
};

type SplitCacheEntry = {
  sourceRef: UIMessage;
  consumedBubbleRefs: UIMessage[];
  streaming: boolean;
  slices: UIMessage[];
};

// A settled turn's source UIMessage is stable, so retain its derived render
// slices by identity for the adapter's WeakMap cache. Streaming turns replace
// their source object on each chunk and naturally recompute. The bound prevents
// abandoned thread histories from being retained indefinitely.
const SPLIT_CACHE_LIMIT = 512;
const splitCache = new Map<string, SplitCacheEntry>();

function steerMessageId(part: UiPart): string | null {
  if (part.type !== PI_STEER_MARKER_PART) return null;
  const value = (part as SteerMarkerPart).data?.steerMessageId;
  return typeof value === 'string' && value ? value : null;
}

function sameRefs(left: UIMessage[], right: UIMessage[]): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => message === right[index])
  );
}

function cacheSlices(id: string, entry: SplitCacheEntry): void {
  // Refresh insertion order on every write so frequently rendered histories
  // remain resident while old thread entries age out.
  splitCache.delete(id);
  splitCache.set(id, entry);
  if (splitCache.size <= SPLIT_CACHE_LIMIT) return;
  const oldest = splitCache.keys().next().value as string | undefined;
  if (oldest !== undefined) splitCache.delete(oldest);
}

function earlierSliceMetadata(source: UIMessage): UIMessage['metadata'] {
  const metadata = source.metadata as
    | { pi?: { createdAtMs?: unknown } }
    | undefined;
  const createdAtMs = metadata?.pi?.createdAtMs;
  return {
    pi: typeof createdAtMs === 'number' ? { createdAtMs } : {},
  };
}

function splitAssistantMessage(
  source: UIMessage,
  markerClaims: ReadonlyMap<UiPart, UIMessage>,
  streaming: boolean,
): { consumedBubbleRefs: UIMessage[]; slices: UIMessage[] } {
  const segments: UiPart[][] = [[]];
  const consumedBubbleRefs: UIMessage[] = [];

  for (const part of source.parts) {
    if (part.type !== PI_STEER_MARKER_PART) {
      segments[segments.length - 1].push(part);
      continue;
    }

    // Every marker is a render-only seam and is removed from adapted content.
    // An unmatched marker does not open a new segment, so the content on both
    // sides remains joined while its user skeleton is still absent.
    const bubble = markerClaims.get(part);
    if (!bubble) continue;
    consumedBubbleRefs.push(bubble);
    segments.push([]);
  }

  const keptSegmentIndexes: number[] = [];
  const finalSegmentIndex = segments.length - 1;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].length > 0) {
      keptSegmentIndexes.push(index);
    } else if (index === finalSegmentIndex && streaming) {
      // Keep a live assistant group below a just-accepted steer even before the
      // next model chunk arrives. Settled empty tails fold back into the prior
      // non-empty slice so completion metadata stays on real content.
      keptSegmentIndexes.push(index);
    }
  }

  const sliceBySegment = new Map<number, UIMessage>();
  keptSegmentIndexes.forEach((segmentIndex, sliceIndex) => {
    const isLastSlice = sliceIndex === keptSegmentIndexes.length - 1;
    const slice = {
      ...source,
      id: isLastSlice ? source.id : `${source.id}::steer${sliceIndex}`,
      parts: segments[segmentIndex],
    } as UIMessage;
    if (!isLastSlice) {
      slice.metadata = earlierSliceMetadata(source);
    }
    sliceBySegment.set(segmentIndex, slice);
  });

  const slices: UIMessage[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const slice = sliceBySegment.get(index);
    if (slice) slices.push(slice);
    if (index < consumedBubbleRefs.length) {
      slices.push(consumedBubbleRefs[index]);
    }
  }

  return { consumedBubbleRefs, slices };
}

/**
 * Derive the render transcript by replacing durable steer-marker parts with
 * their matching user bubbles. Raw ai-chat history remains untouched; callers
 * use this projection only for adaptation/rendering.
 */
export function splitUiMessagesAtSteerMarkers(
  uiMessages: UIMessage[],
  opts: { streamingMessageId: string | null },
): UIMessage[] {
  const usersById = new Map<string, UIMessage>();
  for (const message of uiMessages) {
    if (message.role === 'user' && !usersById.has(message.id)) {
      usersById.set(message.id, message);
    }
  }

  // Claim each bubble for its first marker in transcript/part order. Claims are
  // computed up front so a bubble that appears before its raw assistant row can
  // be removed from that position and reinserted at the marker seam.
  const markerClaims = new Map<UiPart, UIMessage>();
  const claimedUserIds = new Set<string>();
  for (const message of uiMessages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      const id = steerMessageId(part);
      if (!id || claimedUserIds.has(id)) continue;
      const bubble = usersById.get(id);
      if (!bubble) continue;
      claimedUserIds.add(id);
      markerClaims.set(part, bubble);
    }
  }

  const output: UIMessage[] = [];
  for (const message of uiMessages) {
    if (message.role === 'user' && claimedUserIds.has(message.id)) {
      continue;
    }

    if (
      message.role !== 'assistant' ||
      !message.parts.some((part) => part.type === PI_STEER_MARKER_PART)
    ) {
      output.push(message);
      continue;
    }

    const consumedBubbleRefs = message.parts
      .map((part) => markerClaims.get(part))
      .filter((bubble): bubble is UIMessage => Boolean(bubble));
    const streaming = opts.streamingMessageId === message.id;
    const cached = splitCache.get(message.id);
    if (
      cached?.sourceRef === message &&
      cached.streaming === streaming &&
      sameRefs(cached.consumedBubbleRefs, consumedBubbleRefs)
    ) {
      // Refresh the LRU entry without changing any derived object identities.
      splitCache.delete(message.id);
      splitCache.set(message.id, cached);
      output.push(...cached.slices);
      continue;
    }

    const split = splitAssistantMessage(message, markerClaims, streaming);
    cacheSlices(message.id, {
      sourceRef: message,
      consumedBubbleRefs: split.consumedBubbleRefs,
      streaming,
      slices: split.slices,
    });
    output.push(...split.slices);
  }

  return output;
}

/** Whether a rendered message is the raw turn or one of its derived slices. */
export function isSteerSliceIdOf(rawId: string, id: string): boolean {
  return id === rawId || id.startsWith(`${rawId}::steer`);
}
