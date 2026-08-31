import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ChatThreadDO } from '../src/chat-thread-do';

// Keep-in-sync guard for trimIncompleteStreamingReplyParts (the transient-retry
// path in chat-thread-do.ts). That trim reaches @cloudflare/ai-chat's PRIVATE
// in-flight reply state (`_streamingMessage.parts`) through a defensive cast to
// drop the failed attempt's incomplete trailing parts before the regeneration
// re-drives content into the SAME open reply — otherwise the persisted message
// renders the half text followed by the full regenerated text.
//
// The cast NO-OPS if the field is absent, and a silent no-op reintroduces exactly
// the half+full bug the trim prevents. These tests pin the coupling so an upstream
// ai-chat rename/reshape FAILS LOUDLY here instead of degrading silently in prod:
//   1. the private field the cast reads (`_streamingMessage`) exists on a real
//      AIChatAgent-derived instance, and ai-chat still builds it as `{ parts: [] }`;
//   2. the trim's pop semantics (trailing streaming / input-streaming only);
//   3. the runtime signal that fires when the field is missing (rename detection),
//      kept distinct from a legitimate null (no reply stream open).

type AnyRecord = Record<string, unknown>;

async function newChatThreadStub(threadId: string) {
  const id = (env as any).CHAT_THREAD.idFromName(threadId);
  return (env as any).CHAT_THREAD.get(id);
}

/** A fake whose only real method is the trim under test; observability is captured. */
function trimFake(): {
  fake: any;
  events: Array<{ event: string; details: AnyRecord }>;
} {
  const events: Array<{ event: string; details: AnyRecord }> = [];
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.recordChatThreadObservabilityEvent = (event: string, details: AnyRecord) => {
    events.push({ event, details });
  };
  return { fake, events };
}

function callTrim(fake: any): void {
  ChatThreadDO.prototype['trimIncompleteStreamingReplyParts'].call(fake);
}

describe('trimIncompleteStreamingReplyParts ai-chat coupling guard', () => {
  it('pins the private _streamingMessage field + { parts } shape on a real instance', async () => {
    const stub = await newChatThreadStub('thread-streaming-field-guard');
    await runInDurableObject(stub, async (instance: any) => {
      // The cast in trimIncompleteStreamingReplyParts reads `this._streamingMessage`.
      // ai-chat's constructor initializes it (to null); an upstream rename drops the
      // own property and the trim would silently no-op — this pins the exact name.
      expect('_streamingMessage' in instance).toBe(true);

      // `_reply` assigns `_streamingMessage = _createStreamingAssistantMessage(...)`
      // and persists that same object's `parts` array verbatim at stream end, so the
      // shape the trim mutates originates here. Pin it: an assistant message whose
      // `parts` is an array.
      expect(typeof instance._createStreamingAssistantMessage).toBe('function');
      const message = instance._createStreamingAssistantMessage(false);
      expect(message).toMatchObject({ role: 'assistant' });
      expect(Array.isArray(message.parts)).toBe(true);
    });
  });

  it('pops only the trailing streaming / input-streaming parts and keeps settled work', () => {
    const { fake, events } = trimFake();
    fake._streamingMessage = {
      id: 'assistant_1',
      role: 'assistant',
      parts: [
        { type: 'text', state: 'done', text: 'settled run' },
        {
          type: 'tool-shell',
          state: 'output-available',
          toolCallId: 't1',
          output: 'ok',
        },
        { type: 'tool-shell', state: 'input-streaming', toolCallId: 't2' },
        { type: 'text', state: 'streaming', text: 'half of the interrupted' },
      ],
    };

    callTrim(fake);

    const kinds = fake._streamingMessage.parts.map(
      (part: AnyRecord) => `${part.type}:${part.state}`,
    );
    expect(kinds).toEqual(['text:done', 'tool-shell:output-available']);
    expect(events).toEqual([
      {
        event: 'pi_turn_partial_trimmed',
        details: { operation: 'transient_turn_retry', status: 'trimmed', count: 2 },
      },
    ]);
  });

  it('is a quiet no-op when the field is present but null (no reply stream open)', () => {
    const { fake, events } = trimFake();
    fake._streamingMessage = null;

    callTrim(fake);

    // A legitimately null field means there is no in-flight reply to trim; it must
    // NOT be mistaken for the missing-field (rename) case.
    expect(events).toEqual([]);
  });

  it('is a quiet no-op when there is no incomplete trailing part', () => {
    const { fake, events } = trimFake();
    fake._streamingMessage = {
      id: 'assistant_2',
      role: 'assistant',
      parts: [{ type: 'text', state: 'done', text: 'complete' }],
    };

    callTrim(fake);

    expect(fake._streamingMessage.parts).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('surfaces a loud signal when the field is missing (upstream rename)', () => {
    const { fake, events } = trimFake();
    // A fake without the field simulates an ai-chat that no longer exposes
    // `_streamingMessage` under that name. The trim must report it, not silently
    // no-op (which would let the half+full render slip back into production).
    expect('_streamingMessage' in fake).toBe(false);

    callTrim(fake);

    expect(events).toEqual([
      {
        event: 'pi_streaming_reply_field_missing',
        details: {
          operation: 'transient_turn_retry',
          status: 'error',
          severity: 'error',
        },
      },
    ]);
  });
});
