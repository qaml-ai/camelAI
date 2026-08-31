import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import {
  PI_STEER_MARKER_PART,
  piSteerMarkerPartId,
} from '@/lib/pi-chunk-encoder';
import {
  isSteerSliceIdOf,
  splitUiMessagesAtSteerMarkers,
} from '@/lib/steer-split';

type UiPart = UIMessage['parts'][number];

function text(value: string): UiPart {
  return { type: 'text', text: value, state: 'done' } as UiPart;
}

function marker(steerMessageId: string, acceptedAtMs = 20): UiPart {
  return {
    type: PI_STEER_MARKER_PART,
    id: piSteerMarkerPartId(steerMessageId),
    data: { steerMessageId, acceptedAtMs },
  } as UiPart;
}

function user(id: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [text(id)],
    metadata: { sentDuringStreaming: true },
  } as UIMessage;
}

function assistant(
  id: string,
  parts: UiPart[],
  metadata: UIMessage['metadata'] = {
    pi: { createdAtMs: 10, turnDurationMs: 100, completedAtMs: 110 },
  },
): UIMessage {
  return { id, role: 'assistant', parts, metadata } as UIMessage;
}

function texts(message: UIMessage): string[] {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text);
}

describe('splitUiMessagesAtSteerMarkers', () => {
  it.each([
    ['after', false],
    ['before', true],
  ])('interleaves a bubble that appears %s the raw turn row', (_label, bubbleFirst) => {
    const bubble = user('u2');
    const turn = assistant('turn', [text('A.1'), marker('u2'), text('A.2')]);
    const input = bubbleFirst ? [bubble, turn] : [turn, bubble];

    const result = splitUiMessagesAtSteerMarkers(input, {
      streamingMessageId: null,
    });

    expect(result.map((message) => message.id)).toEqual([
      'turn::steer0',
      'u2',
      'turn',
    ]);
    expect(texts(result[0])).toEqual(['A.1']);
    expect(result[1]).toBe(bubble);
    expect(texts(result[2])).toEqual(['A.2']);
    expect(result[0].metadata).toEqual({ pi: { createdAtMs: 10 } });
    expect(result[2].metadata).toBe(turn.metadata);
  });

  it('does not split around an unmatched marker', () => {
    const turn = assistant('turn-unmatched', [
      text('before'),
      marker('missing'),
      text('after'),
    ]);

    const result = splitUiMessagesAtSteerMarkers([turn], {
      streamingMessageId: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('turn-unmatched');
    expect(texts(result[0])).toEqual(['before', 'after']);
    expect(result[0].parts.some((part) => part.type === PI_STEER_MARKER_PART)).toBe(false);
  });

  it('recomputes a settled source when its matching bubble arrives later', () => {
    const turn = assistant('turn-late-bubble', [
      text('before'),
      marker('u-late'),
      text('after'),
    ]);
    const withoutBubble = splitUiMessagesAtSteerMarkers([turn], {
      streamingMessageId: null,
    });
    expect(withoutBubble.map((message) => message.id)).toEqual([
      'turn-late-bubble',
    ]);

    const bubble = user('u-late');
    const withBubble = splitUiMessagesAtSteerMarkers([turn, bubble], {
      streamingMessageId: null,
    });
    expect(withBubble.map((message) => message.id)).toEqual([
      'turn-late-bubble::steer0',
      'u-late',
      'turn-late-bubble',
    ]);
  });

  it('leaves an unreferenced user bubble in its array position', () => {
    const turn = assistant('turn-no-marker', [text('answer')]);
    const bubble = user('u-unreferenced');
    const input = [turn, bubble];

    const result = splitUiMessagesAtSteerMarkers(input, {
      streamingMessageId: null,
    });

    expect(result).toEqual(input);
    expect(result[0]).toBe(turn);
    expect(result[1]).toBe(bubble);
  });

  it('orders multiple steers and drops empty middle segments', () => {
    const first = user('u-first');
    const second = user('u-second');
    const turn = assistant('turn-multiple', [
      text('A.1'),
      marker(first.id),
      marker(second.id),
      text('A.3'),
    ]);

    const result = splitUiMessagesAtSteerMarkers([second, turn, first], {
      streamingMessageId: null,
    });

    expect(result.map((message) => message.id)).toEqual([
      'turn-multiple::steer0',
      first.id,
      second.id,
      'turn-multiple',
    ]);
    expect(texts(result[0])).toEqual(['A.1']);
    expect(texts(result[3])).toEqual(['A.3']);
  });

  it('keeps an empty final slice only while the raw turn is streaming', () => {
    const bubble = user('u-tail');
    const turn = assistant('turn-tail', [text('last content'), marker(bubble.id)]);

    const live = splitUiMessagesAtSteerMarkers([turn, bubble], {
      streamingMessageId: turn.id,
    });
    expect(live.map((message) => message.id)).toEqual([
      'turn-tail::steer0',
      bubble.id,
      'turn-tail',
    ]);
    expect(live[2].parts).toEqual([]);
    expect(live[2].metadata).toBe(turn.metadata);

    const settled = splitUiMessagesAtSteerMarkers([turn, bubble], {
      streamingMessageId: null,
    });
    expect(settled.map((message) => message.id)).toEqual([
      'turn-tail',
      bubble.id,
    ]);
    expect(texts(settled[0])).toEqual(['last content']);
    expect(settled[0].metadata).toBe(turn.metadata);
  });

  it('keeps pass-through and settled slice object identities stable', () => {
    const plain = assistant('plain', [text('plain')]);
    const bubble = user('u-stable');
    const turn = assistant('turn-stable', [
      text('before'),
      marker(bubble.id),
      text('after'),
    ]);
    const input = [plain, turn, bubble];

    const first = splitUiMessagesAtSteerMarkers(input, {
      streamingMessageId: null,
    });
    const second = splitUiMessagesAtSteerMarkers(input, {
      streamingMessageId: null,
    });

    expect(first[0]).toBe(plain);
    expect(second[0]).toBe(plain);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(bubble);
    expect(second[3]).toBe(first[3]);
  });
});

describe('isSteerSliceIdOf', () => {
  it('matches the raw id and derived steer slices only by their turn prefix', () => {
    expect(isSteerSliceIdOf('turn', 'turn')).toBe(true);
    expect(isSteerSliceIdOf('turn', 'turn::steer0')).toBe(true);
    expect(isSteerSliceIdOf('turn', 'other::steer0')).toBe(false);
  });
});
