/**
 * The SseConnection shim's contract with the Agents SDK.
 *
 * Three properties here are load-bearing and invisible from the DO tests:
 *  - a dead sink must surface as the SDK's "WebSocket send() after close"
 *    TypeError, because `sendIfOpen` infers liveness from nothing else and
 *    `ResumableStream.replayChunks` uses that boolean to abort a replay and keep
 *    the stream active for the next reconnect;
 *  - teardown must run exactly once, however many callers notice the death;
 *  - an undrained write is the only liveness probe a quiet stream has (comment
 *    keepalives are far too small for the byte cap to ever notice).
 */

import { describe, expect, it } from 'vitest';
import {
  SSE_MAX_QUEUED_BYTES,
  SSE_STREAM_STALL_MS,
  SseConnection,
  type SseConnectionSink,
  createSseQueueBudget,
  createSseStreamSink,
  isClosedStreamSendError,
} from '../src/chat-thread/sse-connection';

interface Teardown {
  code: number;
  reason: string;
}

function buildConnection(
  sink: SseConnectionSink,
): { connection: SseConnection; teardowns: Teardown[] } {
  const teardowns: Teardown[] = [];
  const connection = new SseConnection({
    id: 'conn-1',
    uri: null,
    server: 'thread-1',
    sink,
    onTeardown: (_connection, code, reason) => teardowns.push({ code, reason }),
  });
  return { connection, teardowns };
}

function stubSink(overrides: Partial<SseConnectionSink> = {}): SseConnectionSink {
  return {
    onDead: null,
    send: () => true,
    comment: () => true,
    bye: () => {},
    stalledFor: () => 0,
    close: () => {},
    ...overrides,
  };
}

describe('SseConnection send contract', () => {
  it('throws the SDK closed-send TypeError once the stream is gone', () => {
    const { connection, teardowns } = buildConnection(stubSink());
    connection.abort(1006, 'stream_closed');
    expect(teardowns).toHaveLength(1);

    let thrown: unknown = null;
    try {
      connection.send('{"type":"cf_agent_use_chat_response"}');
    } catch (error) {
      thrown = error;
    }
    // `sendIfOpen` (agents/dist/chat/index.js) swallows exactly this shape and
    // returns false; anything else (including returning normally) tells the SDK
    // the client received a frame it never got.
    expect(isClosedStreamSendError(thrown)).toBe(true);
  });

  it('tears down exactly once when a write trips the queue budget', () => {
    const { writable } = new TransformStream<Uint8Array, Uint8Array>();
    // A registry whose shared budget is already exhausted: the next write of any
    // size is refused, which is the byte-cap path with no 8MB detour.
    const sink = createSseStreamSink(writable.getWriter(), createSseQueueBudget(0));
    const { connection, teardowns } = buildConnection(sink);

    expect(() => connection.send('frame')).toThrow(TypeError);
    // The sink's own `onDead` and the failing caller both reach teardown; a
    // second run would drive a second full wrapped onClose chain (duplicate
    // pending-question auto-answers).
    expect(teardowns).toEqual([{ code: 1006, reason: 'stream_write_failed' }]);
    expect(connection.isOpen).toBe(false);
    expect(connection.readyState).toBe(3);
  });

  it('does not throw for binary frames (there is no SSE encoding for them)', () => {
    const { connection } = buildConnection(stubSink());
    expect(() => connection.send(new Uint8Array([1, 2, 3]))).not.toThrow();
  });
});

describe('SseConnection heartbeat', () => {
  it('closes a stream whose write has not drained inside the stall window', () => {
    const stalled = stubSink({ stalledFor: () => SSE_STREAM_STALL_MS + 1 });
    const { connection, teardowns } = buildConnection(stalled);

    expect(connection.heartbeat()).toBe(false);
    expect(teardowns).toEqual([{ code: 1006, reason: 'stream_stalled' }]);
    expect(connection.isOpen).toBe(false);
  });

  it('keeps a stream whose writes are draining', () => {
    const { connection, teardowns } = buildConnection(stubSink());
    expect(connection.heartbeat()).toBe(true);
    expect(teardowns).toHaveLength(0);
  });

  it('reports the age of an undrained write', () => {
    const { writable } = new TransformStream<Uint8Array, Uint8Array>();
    const sink = createSseStreamSink(writable.getWriter());
    const before = Date.now();
    expect(sink.send('{"hello":"world"}')).toBe(true);

    // Nobody is reading the transform, so the write stays outstanding: this age
    // is what distinguishes a vanished peer from a quiet one.
    expect(sink.stalledFor(before + SSE_STREAM_STALL_MS + 5)).toBeGreaterThanOrEqual(
      SSE_STREAM_STALL_MS,
    );
  });

  it('does not accumulate stall time while a busy stream keeps draining', async () => {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const sink = createSseStreamSink(writable.getWriter());
    const reader = readable.getReader();
    const startedAt = Date.now();

    // A streaming turn keeps writes in flight continuously, so the queue never
    // reaches empty. Measuring the OLDEST outstanding write would declare this
    // healthy client dead after 30s of normal streaming.
    for (let index = 0; index < 8; index++) {
      expect(sink.send(`{"delta":${index}}`)).toBe(true);
      await reader.read();
    }
    expect(sink.send('{"delta":"last"}')).toBe(true);

    expect(sink.stalledFor(startedAt + SSE_STREAM_STALL_MS - 1)).toBeLessThan(
      SSE_STREAM_STALL_MS,
    );
    await reader.cancel();
  });
});

describe('SSE queue budget', () => {
  it('refuses a write that would exceed the shared registry budget', () => {
    const budget = createSseQueueBudget(64);
    const first = createSseStreamSink(
      new TransformStream<Uint8Array, Uint8Array>().writable.getWriter(),
      budget,
    );
    const second = createSseStreamSink(
      new TransformStream<Uint8Array, Uint8Array>().writable.getWriter(),
      budget,
    );

    // Well under the per-stream cap; the aggregate is what runs out.
    expect(first.send('x'.repeat(40))).toBe(true);
    expect(budget.total).toBe(48);
    expect(second.send('y'.repeat(40))).toBe(false);
    expect(second.send('y')).toBe(false);
    expect(budget.total).toBe(48);

    // A gone sink releases its share: its transform is unreachable, and leaving
    // the bytes charged would let a few dead peers wedge the budget for the
    // lifetime of the DO.
    first.close();
    expect(budget.total).toBe(0);
  });

  it('still bounds a single stream when no shared budget is supplied', () => {
    const sink = createSseStreamSink(
      new TransformStream<Uint8Array, Uint8Array>().writable.getWriter(),
    );
    expect(sink.send('x'.repeat(SSE_MAX_QUEUED_BYTES))).toBe(false);
  });
});
