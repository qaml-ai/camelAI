import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';

import { dedupeUiMessagesById } from '@/lib/use-pi-chat-stream';

// Exact-identity dedupe for the residual resume-replay duplication: the AI
// SDK's chunk writer is replace-last-or-push, so a replayed `start` whose id
// exists in the seed but is not the tail message pushes a second same-id
// message. (Part-level duplication is designed out at the seam — seeds never
// include the in-flight streaming message; see resolveDisplayChatData.)

function message(
  id: string,
  role: UIMessage['role'],
  parts: UIMessage['parts'],
): UIMessage {
  return { id, role, parts } as UIMessage;
}

const text = (t: string) => ({ type: 'text' as const, text: t });
const reasoning = (t: string) => ({ type: 'reasoning' as const, text: t });

describe('dedupeUiMessagesById', () => {
  it('returns the input array identity when no id repeats', () => {
    const messages = [
      message('u1', 'user', [text('hi')]),
      message('a1', 'assistant', [text('hello')]),
    ];
    expect(dedupeUiMessagesById(messages)).toBe(messages);
  });

  it('keeps the richer copy at the first occurrence position', () => {
    // Steering scenario: seeded assistant T above the steering user skeleton,
    // replayed rebuild of T pushed to the tail and now richer.
    const seeded = message('turn-1', 'assistant', [text('partial')]);
    const steering = message('u2', 'user', [text('also do X')]);
    const rebuilt = message('turn-1', 'assistant', [
      text('partial plus more'),
      text('and a second part'),
    ]);
    const result = dedupeUiMessagesById([seeded, steering, rebuilt]);
    expect(result.map((m) => m.id)).toEqual(['turn-1', 'u2']);
    expect(result[0]).toBe(rebuilt);
  });

  it('keeps the seeded copy while the replayed rebuild is still emptier', () => {
    // At the instant of the replayed `start`, the pushed rebuild has no parts
    // yet; the richer seeded copy must keep rendering (no blank flash).
    const seeded = message('turn-1', 'assistant', [
      reasoning('plan'),
      text('partial'),
    ]);
    const rebuild = message('turn-1', 'assistant', []);
    const result = dedupeUiMessagesById([
      seeded,
      message('u2', 'user', [text('steer')]),
      rebuild,
    ]);
    expect(result.map((m) => m.id)).toEqual(['turn-1', 'u2']);
    expect(result[0]).toBe(seeded);
  });

  it('prefers the later copy on equal part counts', () => {
    const first = message('turn-1', 'assistant', [text('a')]);
    const second = message('turn-1', 'assistant', [text('ab')]);
    const third = message('turn-1', 'assistant', [text('abc')]);
    const result = dedupeUiMessagesById([
      first,
      message('u1', 'user', [text('q')]),
      second,
      third,
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(third);
  });
});
