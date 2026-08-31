/**
 * Wake-OOM containment for the resumable-stream replay buffer
 * (plans/sse-migration/OOM-FIX.md).
 *
 * Three bounds are pinned here: transient chunks never reach the buffer, one
 * stream's stored bytes are capped (and a capped stream resumes by attaching to
 * live rather than replaying a truncated turn), and a replay read is paged
 * instead of materializing the whole buffer — byte-identically to the SDK's own
 * frames, which the batched loop is compared against directly. Plus the wake
 * circuit breaker that quarantines the buffers of a thread that cannot finish a
 * wake at all.
 */

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  SSE_MAX_QUEUED_BYTES,
  SseConnection,
  createSseCaptureConnection,
  createSseQueueBudget,
  createSseStreamSink,
} from '../src/chat-thread/sse-connection';
import { ChatThreadDO } from '../src/chat-thread-do';

type AnyRecord = Record<string, unknown>;

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

/**
 * Production installs the bounded readers in the CONSTRUCTOR (the framework's own
 * onStart wrapper does its buffer reads before this class's onStart runs, so
 * installing there would be too late). This is a no-op re-install kept so the
 * tests read as "the bounded reader is what is being exercised"; that the
 * constructor already did it is asserted in the wake-circuit-breaker block.
 */
const installBoundedReplay = (instance: any) => instance.installBoundedStreamReplay();

const seedChatContext = (instance: any, threadId: string) => {
  instance.chatContext = {
    threadId,
    workspaceId: 'workspace-1',
    orgId: 'org-1',
    userId: 'user-1',
    userName: 'User One',
    userEmail: 'user-1@example.com',
  };
};

/** Collect the observability events a call records, without the env round trip. */
function captureObservabilityEvents(instance: any): Array<{ event: string; details: AnyRecord }> {
  const recorded: Array<{ event: string; details: AnyRecord }> = [];
  instance.recordChatThreadObservabilityEvent = (event: string, details: AnyRecord = {}) => {
    recorded.push({ event, details });
  };
  return recorded;
}

const captureConnection = (id: string) =>
  createSseCaptureConnection({ id, uri: null, server: 'thread' });

/** A peer that is gone: `SseConnection.send` reports it as the SDK's closed-send
 *  TypeError, which is what makes a replay loop abort mid-way. */
const deadConnection = (id: string) =>
  new SseConnection({
    id,
    uri: null,
    server: 'thread',
    sink: {
      onDead: null,
      send: () => false,
      comment: () => true,
      bye: () => {},
      stalledFor: () => 0,
      close: () => {},
    },
    onTeardown: () => {},
  });

const storedChunkCount = (instance: any, streamId: string): number => {
  const [row] = instance.ctx.storage.sql
    .exec('select count(*) as n from cf_ai_chat_stream_chunks where stream_id = ?', streamId)
    .toArray() as Array<{ n: number }>;
  return row?.n ?? 0;
};

const storedChunkBytes = (instance: any, streamId: string): number => {
  const [row] = instance.ctx.storage.sql
    .exec(
      'select sum(length(cast(body as blob))) as bytes from cf_ai_chat_stream_chunks where stream_id = ?',
      streamId,
    )
    .toArray() as Array<{ bytes: number | null }>;
  return row?.bytes ?? 0;
};

describe('resumable-stream chunk storage bounds', () => {
  it('broadcasts transient chunks without storing them', async () => {
    const threadId = 'thread-replay-transient';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const broadcast: string[] = [];
      instance.broadcast = (message: string) => broadcast.push(message);

      const streamId = instance._startStream('request-transient');
      // The SDK's own store+broadcast funnel: storing is skipped, broadcasting
      // is not (the client applies the live tail and then forgets it).
      await instance._broadcastTextEvent(
        streamId,
        { type: 'data-pi-tool-stream', transient: true, id: 'tool-1', data: { text: 'tail' } },
        false,
      );
      await instance._broadcastTextEvent(
        streamId,
        { type: 'data-pi-heartbeat', transient: true, id: 'hb-1', data: { at: 1 } },
        false,
      );
      await instance._broadcastTextEvent(
        streamId,
        { type: 'text-delta', id: 'part-1', delta: 'kept' },
        false,
      );
      instance._flushChunkBuffer();

      expect(broadcast.length).toBe(3);
      expect(broadcast.some((frame) => frame.includes('data-pi-tool-stream'))).toBe(true);
      expect(broadcast.some((frame) => frame.includes('data-pi-heartbeat'))).toBe(true);

      const rows = instance.ctx.storage.sql
        .exec('select body from cf_ai_chat_stream_chunks where stream_id = ?', streamId)
        .toArray() as Array<{ body: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.body).toContain('kept');
      expect(rows[0]!.body).not.toContain('transient');
    });
  });

  it('stops storing past the per-stream byte ceiling', async () => {
    const threadId = 'thread-replay-cap';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      instance._streamReplayMaxStoredBytesOverride = 4_000;

      const streamId = instance._startStream('request-cap');
      const delta = 'x'.repeat(1_000);
      for (let i = 0; i < 20; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta }),
        );
        instance._flushChunkBuffer();
      }

      const bytes = storedChunkBytes(instance, streamId);
      expect(bytes).toBeGreaterThan(0);
      // The chunk that crosses the ceiling is stored whole; nothing after it is.
      expect(bytes).toBeLessThan(4_000 + 1_200);
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(events.filter((entry) => entry.event === 'chat_stream_replay_degraded').length).toBe(1);
    });
  });

  it('replays nothing but the terminator for a degraded live stream', async () => {
    const threadId = 'thread-replay-degraded-live';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 1_000;

      const streamId = instance._startStream('request-degraded-live');
      for (let i = 0; i < 5; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(600) }),
        );
        instance._flushChunkBuffer();
      }
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(storedChunkCount(instance, streamId)).toBeGreaterThan(0);

      const { connection, frames } = captureConnection('capture-degraded-live');
      expect(instance._resumableStream.replayChunks(connection, 'request-degraded-live')).toBe(
        null,
      );
      // Attach to live: the CHAT_MESSAGES snapshot and the turn-end persist are
      // what close the gap, not a truncated replay.
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: false,
          id: 'request-degraded-live',
          type: 'cf_agent_use_chat_response',
          replay: true,
          replayComplete: true,
        },
      ]);
      // The stream stays live and active — nothing about a resume ends the turn.
      expect(instance._resumableStream.hasActiveStream()).toBe(true);
    });
  });

  it('re-detects a degraded stream adopted by restore', async () => {
    const threadId = 'thread-replay-restore-degraded';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 4_000;

      // What an eviction leaves behind: a `streaming` metadata row plus an
      // over-ceiling buffer, and no in-memory byte bookkeeping at all.
      const streamId = 'stream-restored-degraded';
      instance.ctx.storage.sql.exec(
        'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
          ' values (?, ?, ?, ?, ?, ?)',
        streamId,
        'request-restored',
        'streaming',
        Date.now(),
        null,
        0,
      );
      const body = JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'y'.repeat(1_000) });
      for (let index = 0; index < 10; index++) {
        instance.ctx.storage.sql.exec(
          'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
          `chunk-${index}`,
          streamId,
          body,
          index,
          Date.now(),
        );
      }
      instance._streamStoredBytes?.clear();
      instance._replayDegradedStreams?.clear();
      instance._restoreActiveStream();
      expect(instance._resumableStream.activeStreamId).toBe(streamId);

      const events = captureObservabilityEvents(instance);
      const { connection, frames } = captureConnection('capture-restored');
      // A restored stream has no live reader, so this is the orphan branch: no
      // chunk replay (degraded), then the SDK's `done` + finalization.
      expect(instance._resumableStream.replayChunks(connection, 'request-restored')).toBe(streamId);
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: true,
          id: 'request-restored',
          type: 'cf_agent_use_chat_response',
          replay: true,
        },
      ]);
      expect(events.filter((entry) => entry.event === 'chat_stream_replay_degraded').length).toBe(1);
    });
  });

  it('finalizes an orphaned degraded stream with a done frame', async () => {
    const threadId = 'thread-replay-orphan-degraded';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 1_000;

      const streamId = instance._startStream('request-orphan-degraded');
      for (let i = 0; i < 5; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(600) }),
        );
        instance._flushChunkBuffer();
      }
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      // A stream restored from SQLite has no live reader.
      instance._resumableStream._isLive = false;

      const { connection, frames } = captureConnection('capture-orphan');
      expect(
        instance._resumableStream.replayChunks(connection, 'request-orphan-degraded'),
      ).toBe(streamId);
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: true,
          id: 'request-orphan-degraded',
          type: 'cf_agent_use_chat_response',
          replay: true,
        },
      ]);
      // Completed exactly as the SDK would, so the caller persists the partial.
      expect(instance._resumableStream.hasActiveStream()).toBe(false);
    });
  });
});

describe('batched replay', () => {
  it('emits frames byte-identical to the SDK across many batches', async () => {
    const threadId = 'thread-replay-batched';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-batched');
      // ~100 segment rows — several pages' worth — as a mix of packed
      // multi-chunk segments and single-chunk rows, so unpacking is exercised in
      // both row shapes.
      const chunkCount = 150;
      for (let index = 0; index < chunkCount; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        if (index % 3 !== 1) instance._flushChunkBuffer();
      }
      instance._flushChunkBuffer();
      const rowCount = storedChunkCount(instance, streamId);
      expect(rowCount).toBeGreaterThan(40);

      const stream = instance._resumableStream;
      const batched = captureConnection('capture-batched');
      const unbatched = captureConnection('capture-unbatched');
      // The wrap is installed on the INSTANCE, so the prototype still holds the
      // SDK's original single-query implementation to compare against.
      const sdkReplayChunks = Object.getPrototypeOf(stream).replayChunks;

      expect(stream.replayChunks(batched.connection, 'request-batched')).toBe(null);
      expect(sdkReplayChunks.call(stream, unbatched.connection, 'request-batched')).toBe(null);

      expect(batched.frames).toEqual(unbatched.frames);
      expect(batched.frames.length).toBe(chunkCount + 1);
      expect(JSON.parse(batched.frames[0]!)).toEqual({
        body: JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'chunk-0' }),
        done: false,
        id: 'request-batched',
        type: 'cf_agent_use_chat_response',
        replay: true,
      });
      expect(JSON.parse(batched.frames.at(-1)!)).toMatchObject({ replayComplete: true });
    });
  });

  it('does not replay segments flushed after the replay started', async () => {
    const threadId = 'thread-replay-snapshot';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-snapshot');
      const chunkCount = 90;
      for (let index = 0; index < chunkCount; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        instance._flushChunkBuffer();
      }

      // A still-live stream keeps flushing while the replay is paged out. The
      // SDK's single query never saw those rows — the client receives them as
      // live broadcasts — so paging must not pick them up either, or the text
      // arrives twice.
      const { connection, frames } = captureConnection('capture-snapshot');
      const capturedSend = connection.send.bind(connection);
      let sent = 0;
      (connection as any).send = (message: string) => {
        capturedSend(message);
        if (++sent !== 45) return;
        instance.ctx.storage.sql.exec(
          'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
          'chunk-late',
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'late' }),
          chunkCount,
          Date.now(),
        );
      };

      expect(instance._resumableStream.replayChunks(connection, 'request-snapshot')).toBe(null);
      expect(frames.length).toBe(chunkCount + 1);
      expect(frames.some((frame) => frame.includes('late'))).toBe(false);
    });
  });

  it('is what the resume handshake drives', async () => {
    const threadId = 'thread-replay-handshake';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 1_000;
      const streamId = instance._startStream('request-handshake');
      for (let i = 0; i < 5; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(600) }),
        );
        instance._flushChunkBuffer();
      }

      // The framework's resume-ack path, i.e. what a reconnecting client
      // actually triggers — not a direct call to the replaced method.
      const { connection, frames } = captureConnection('capture-handshake');
      await instance.onMessage(
        connection,
        JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'request-handshake' }),
      );

      const replayFrames = frames
        .map((frame) => JSON.parse(frame) as AnyRecord)
        .filter((frame) => frame.type === 'cf_agent_use_chat_response');
      expect(replayFrames).toEqual([
        {
          body: '',
          done: false,
          id: 'request-handshake',
          type: 'cf_agent_use_chat_response',
          replay: true,
          replayComplete: true,
        },
      ]);
    });
  });

  it('marks continuation replays exactly as the SDK does', async () => {
    const threadId = 'thread-replay-continuation';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-continuation', { continuation: true });
      await instance._storeStreamChunk(
        streamId,
        JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'partial' }),
      );
      instance._flushChunkBuffer();

      const stream = instance._resumableStream;
      const batched = captureConnection('capture-continuation-batched');
      const unbatched = captureConnection('capture-continuation-sdk');
      expect(stream.replayChunks(batched.connection, 'request-continuation')).toBe(null);
      expect(
        Object.getPrototypeOf(stream).replayChunks.call(
          stream,
          unbatched.connection,
          'request-continuation',
        ),
      ).toBe(null);

      expect(batched.frames).toEqual(unbatched.frames);
      expect(JSON.parse(batched.frames[0]!)).toMatchObject({ continuation: true, replay: true });
    });
  });

  it('aborts on a dead sink mid-batch and leaves the stream active', async () => {
    const threadId = 'thread-replay-dead-sink';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-dead');
      for (let index = 0; index < 60; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        instance._flushChunkBuffer();
      }
      // An orphaned stream is the case where bailing matters: completing it on a
      // replay nobody received would lose the buffer for the next reattach.
      instance._resumableStream._isLive = false;

      expect(
        instance._resumableStream.replayChunks(deadConnection('dead-replay'), 'request-dead'),
      ).toBe(null);
      expect(instance._resumableStream.activeStreamId).toBe(streamId);
      const [metadata] = instance.ctx.storage.sql
        .exec('select status from cf_ai_chat_stream_metadata where id = ?', streamId)
        .toArray() as Array<{ status: string }>;
      expect(metadata?.status).toBe('streaming');
    });
  });
});

describe('wake circuit breaker', () => {
  const seedStreamBuffer = (instance: any, streamId: string) => {
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
        ' values (?, ?, ?, ?, ?, ?)',
      streamId,
      `request-${streamId}`,
      'streaming',
      Date.now(),
      null,
      0,
    );
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
      `chunk-${streamId}`,
      streamId,
      JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'partial' }),
      0,
      Date.now(),
    );
  };

  const streamRowCounts = (instance: any): { chunks: number; metadata: number } => {
    const [chunks] = instance.ctx.storage.sql
      .exec('select count(*) as n from cf_ai_chat_stream_chunks')
      .toArray() as Array<{ n: number }>;
    const [metadata] = instance.ctx.storage.sql
      .exec('select count(*) as n from cf_ai_chat_stream_metadata')
      .toArray() as Array<{ n: number }>;
    return { chunks: chunks?.n ?? 0, metadata: metadata?.n ?? 0 };
  };

  it('quarantines the stream buffers on the third failed wake', async () => {
    const threadId = 'thread-wake-quarantine';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-quarantined');
      // Quarantine is gated on the buffers being big enough to plausibly have
      // killed the isolate; scale the gate down instead of seeding 8MB.
      instance.replayBoundOverrides = { wakeQuarantineMinStoredBytes: 8 };
      instance.ctx.storage.kv.put('wakeOomGuard', { count: 2, at: Date.now() });
      instance.ctx.storage.kv.put('cf:chat:recovering', { at: Date.now(), requestId: 'r-1' });

      await instance.onStart();

      expect(streamRowCounts(instance)).toEqual({ chunks: 0, metadata: 0 });
      expect(instance._resumableStream.hasActiveStream()).toBe(false);
      expect(instance.ctx.storage.kv.get('cf:chat:recovering')).toBe(undefined);
      const quarantine = events.filter((entry) => entry.event === 'chat_do_wake_quarantine');
      expect(quarantine.length).toBe(1);
      expect(quarantine[0]!.details).toMatchObject({ severity: 'error', count: 3 });
      // A wake that completed says nothing about the next one.
      expect(instance.ctx.storage.kv.get('wakeOomGuard')).toMatchObject({ count: 0 });
    });
  });

  it('leaves the stream buffers alone on a healthy wake', async () => {
    const threadId = 'thread-wake-healthy';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-kept');
      instance.ctx.storage.kv.delete('wakeOomGuard');

      await instance.onStart();

      expect(streamRowCounts(instance)).toEqual({ chunks: 1, metadata: 1 });
      expect(events.some((entry) => entry.event === 'chat_do_wake_quarantine')).toBe(false);
      expect(instance.ctx.storage.kv.get('wakeOomGuard')).toMatchObject({ count: 0 });
      // Every wake also (re)installs the bounded replay before super.onStart's
      // buffer reads can run.
      expect(instance.boundedReplayStream).toBe(instance._resumableStream);
    });
  });

  it('ignores a count from outside the rolling window', async () => {
    const threadId = 'thread-wake-stale';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-stale-guard');
      instance.ctx.storage.kv.put('wakeOomGuard', {
        count: 9,
        at: Date.now() - 2 * 60 * 60 * 1000,
      });

      await instance.onStart();

      // The stale count was discarded rather than incremented to 10.
      expect(streamRowCounts(instance)).toEqual({ chunks: 1, metadata: 1 });
      expect(events.some((entry) => entry.event === 'chat_do_wake_quarantine')).toBe(false);
    });
  });

  it('keeps the rolling window anchored to the FIRST unfinished wake', async () => {
    const threadId = 'thread-wake-window-anchor';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const firstFailureAt = Date.now() - 40 * 60 * 1000;
      instance.ctx.storage.kv.put('wakeOomGuard', { count: 1, at: firstFailureAt });
      // Observed before onStart's success reset: the window must not slide
      // forward on every increment, or three same-isolate retries stretch a 1h
      // ceiling into an unbounded gap between failures.
      const armed: Array<{ count?: number; at?: number }> = [];
      const originalCheck = instance._checkRunFibers.bind(instance);
      instance._checkRunFibers = async (...args: unknown[]) => {
        armed.push(instance.ctx.storage.kv.get('wakeOomGuard') as any);
        return originalCheck(...args);
      };

      await instance.onStart();

      expect(armed).toEqual([{ count: 2, at: firstFailureAt }]);
    });
  });

  it('arms the breaker BEFORE the framework does its wake reads', async () => {
    const threadId = 'thread-wake-arm-order';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      instance.ctx.storage.kv.delete('wakeOomGuard');

      // `_checkRunFibers` is the framework's fiber-recovery scan: it drives chat
      // fiber recovery, whose classification read reconstructs the recovery
      // partial from the replay buffer. The Agent constructor's own onStart
      // wrapper runs it BEFORE this class's onStart, so a breaker armed from
      // ChatThreadDO.onStart would only ever be written after the read that
      // kills the isolate — the counter would never leave 0 and the quarantine
      // would never fire for the one failure it exists for.
      const observed: Array<{ count?: number; boundedRecoveryRead: boolean }> = [];
      const originalCheck = instance._checkRunFibers.bind(instance);
      instance._checkRunFibers = async (...args: unknown[]) => {
        observed.push({
          count: (instance.ctx.storage.kv.get('wakeOomGuard') as { count?: number })?.count,
          boundedRecoveryRead: Object.prototype.hasOwnProperty.call(
            instance,
            '_getPartialStreamText',
          ),
        });
        return originalCheck(...args);
      };

      await instance.onStart();

      expect(observed).toEqual([{ count: 1, boundedRecoveryRead: true }]);
    });
  });

  it('installs the bounded readers in the constructor, before any wake runs', async () => {
    const threadId = 'thread-wake-install-in-ctor';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      // No onStart in this test at all: `runInDurableObject` skips partyserver's
      // initialization, so anything true here was done by the constructor.
      expect(instance.boundedReplayStream).toBe(instance._resumableStream);
      expect(
        Object.prototype.hasOwnProperty.call(instance, '_getPartialStreamText'),
      ).toBe(true);
      expect(typeof instance._resumableStream.replayCompletedChunksByRequestId).toBe(
        'function',
      );
    });
  });

  it('never reaches the threshold from wakes that threw and were caught', async () => {
    const threadId = 'thread-wake-caught-throw';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-caught-throw');
      instance.ctx.storage.kv.delete('wakeOomGuard');
      // Gate the destructive remedy open so only the counting is under test.
      instance.replayBoundOverrides = { wakeQuarantineMinStoredBytes: 8 };
      // Anything inside the guarded region can throw for reasons that have
      // nothing to do with memory (a storage hiccup, a nameless alarm wake's
      // setState, a bad deploy of onStart itself). Reaching a catch PROVES the
      // isolate survived, so it is definitionally not the OOM the breaker counts.
      instance.sweepOrphanedActiveTurnMarker = async () => {
        throw new Error('storage hiccup');
      };

      for (let wake = 1; wake <= 5; wake++) {
        // A fresh isolate for each wake — the harshest case, since within one
        // isolate partyserver's retries are already deduped.
        instance.wakeGuardArmed = false;
        await expect(instance.onStart()).rejects.toThrow('storage hiccup');
        expect(instance.ctx.storage.kv.get('wakeOomGuard')).toMatchObject({ count: 0 });
      }

      expect(streamRowCounts(instance)).toEqual({ chunks: 1, metadata: 1 });
      expect(events.some((entry) => entry.event === 'chat_do_wake_quarantine')).toBe(false);
    });
  });

  it('counts one wake per isolate however often onStart is retried', async () => {
    const threadId = 'thread-wake-per-isolate';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      instance.ctx.storage.kv.delete('wakeOomGuard');
      // partyserver puts #status back to "zero" when onStart throws and re-runs
      // it on the next entry point in the SAME live isolate (webSocketMessage
      // even swallows the error), so a reconnecting tab's frames retry startup
      // within milliseconds. Neutralize the reset to isolate the arming side:
      // three retries must still be ONE count, because an isolate that was
      // really OOM-killed never comes back to retry anything.
      instance.resetWakeOomGuard = () => {};

      await instance.onStart();
      await instance.onStart();
      await instance.onStart();

      expect(instance.ctx.storage.kv.get('wakeOomGuard')).toMatchObject({ count: 1 });
    });
  });

  it('refuses to quarantine a buffer too small to have killed the isolate', async () => {
    const threadId = 'thread-wake-small-buffer';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-small-buffer');
      instance.ctx.storage.kv.put('wakeOomGuard', { count: 2, at: Date.now() });
      instance.ctx.storage.kv.put('cf:chat:recovering', { at: Date.now(), requestId: 'r-1' });

      await instance.onStart();

      // The remedy is destructive: it deletes the stream an interrupted turn's
      // settled partial would be persisted from. A one-chunk buffer cannot be
      // what OOM-killed a 128MB isolate, so the wake failed for another reason.
      expect(streamRowCounts(instance)).toEqual({ chunks: 1, metadata: 1 });
      expect(instance.ctx.storage.kv.get('cf:chat:recovering')).toMatchObject({
        requestId: 'r-1',
      });
      const quarantine = events.filter((entry) => entry.event === 'chat_do_wake_quarantine');
      expect(quarantine.length).toBe(1);
      expect(quarantine[0]!.details).toMatchObject({ status: 'skipped_small_buffer' });
    });
  });
});

describe('bounded recovery-classification read', () => {
  const seedRestoredStream = (
    instance: any,
    streamId: string,
    requestId: string,
    bodies: string[],
  ) => {
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
        ' values (?, ?, ?, ?, ?, ?)',
      streamId,
      requestId,
      'streaming',
      Date.now(),
      null,
      0,
    );
    bodies.forEach((body, index) => {
      instance.ctx.storage.sql.exec(
        'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
        `chunk-${streamId}-${index}`,
        streamId,
        body,
        index,
        Date.now(),
      );
    });
  };

  it('reads the full prefix for a buffer inside the ceiling', async () => {
    const threadId = 'thread-recovery-partial-small';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = 'stream-recovery-small';
      seedRestoredStream(instance, streamId, 'request-recovery-small', [
        JSON.stringify({ type: 'text-start', id: 'part-1' }),
        JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'hello ' }),
        JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'world' }),
      ]);

      // OOM-FIX.md fix 3: the recovery partial must still be built from the FULL
      // prefix for every stream the store-side ceiling governs.
      expect(instance._getPartialStreamText(streamId).text).toBe('hello world');
      expect(instance._isStreamReplayDegraded(streamId)).toBe(false);
    });
  });

  it('never materializes a buffer that predates the ceiling', async () => {
    const threadId = 'thread-recovery-partial-whale';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      instance.replayBoundOverrides = { recoveryPartialMaxStoredBytes: 2_000 };
      const streamId = 'stream-recovery-whale';
      // What an eviction left behind before the store-side cap existed: rows the
      // cap can never remove, read whole by the framework's own wake-time fiber
      // recovery, before any app code gets to run.
      seedRestoredStream(
        instance,
        streamId,
        'request-recovery-whale',
        Array.from({ length: 10 }, (_unused, index) =>
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `${index}`.repeat(1_000) }),
        ),
      );

      const stream = instance._resumableStream;
      let bodyReads = 0;
      const sdkGetStreamChunks = stream.getStreamChunks.bind(stream);
      stream.getStreamChunks = (id: string) => {
        bodyReads += 1;
        return sdkGetStreamChunks(id);
      };

      expect(instance._getPartialStreamText(streamId)).toEqual({
        text: '',
        parts: [],
        hasSettledToolResults: false,
      });
      expect(bodyReads).toBe(0);
      // Remembered durably, so the next wake does not re-decide from a byte sum
      // in a currency the live tally never used.
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(instance.ctx.storage.kv.get('chatReplayDegradedStreams')).toEqual([streamId]);
      expect(
        events.filter((entry) => entry.event === 'chat_stream_replay_degraded'),
      ).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ status: 'recovery_read_skipped' }) }),
      ]);
    });
  });
});

describe('replay fits the transport that carries it', () => {
  /** A real SSE sink whose peer never drains, with a small shared budget so the
   *  8MB per-stream cap does not have to be reached to reproduce the kill. */
  const stallingSseConnection = (id: string, budgetBytes: number) => {
    const writer = new WritableStream<Uint8Array>({
      write: () => new Promise<void>(() => {}),
    }).getWriter();
    const sink = createSseStreamSink(writer, createSseQueueBudget(budgetBytes));
    return new SseConnection({
      id,
      uri: null,
      server: 'thread',
      sink,
      onTeardown: () => {},
    });
  };

  it('keeps the stored ceiling below what one SSE connection can queue', () => {
    // The replay loop is fully synchronous, so nothing can drain the sink while
    // it runs: every frame of a replay is resident in the queue at once. Frames
    // are strictly larger than the bodies they carry, so a ceiling at or above
    // the queue cap guarantees an un-replayable band instead of a graceful
    // attach-to-live.
    const ceiling = ChatThreadDO.streamReplayMaxStoredBytes ?? Number.NaN;
    expect(ceiling).toBeGreaterThan(0);
    expect(ceiling * 2).toBeLessThan(SSE_MAX_QUEUED_BYTES);
  });

  it('stops replaying instead of letting the sink kill the connection', async () => {
    const threadId = 'thread-replay-transport-budget';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const events = captureObservabilityEvents(instance);
      instance.replayBoundOverrides = { maxSentChars: 600 };
      const streamId = instance._startStream('request-transport-budget');
      for (let index = 0; index < 40; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        instance._flushChunkBuffer();
      }
      expect(instance._isStreamReplayDegraded(streamId)).toBe(false);

      const { connection, frames } = captureConnection('capture-transport-budget');
      expect(instance._resumableStream.replayChunks(connection, 'request-transport-budget')).toBe(
        null,
      );

      const parsed = frames.map((frame) => JSON.parse(frame) as AnyRecord);
      // Bailed early, and — the whole point — the connection SURVIVED and was
      // attached to live instead of being torn down mid-replay.
      expect(parsed.length).toBeLessThan(41);
      expect(parsed.at(-1)).toMatchObject({ replayComplete: true });
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(
        events.filter((entry) => entry.event === 'chat_stream_replay_degraded'),
      ).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ status: 'transport_budget' }),
        }),
      ]);

      // And the reconnect that used to re-read and re-encode the same buffer now
      // replays nothing at all.
      const retry = captureConnection('capture-transport-budget-retry');
      expect(
        instance._resumableStream.replayChunks(retry.connection, 'request-transport-budget'),
      ).toBe(null);
      expect(retry.frames.length).toBe(1);
      expect(JSON.parse(retry.frames[0]!)).toMatchObject({ replayComplete: true });
    });
  });

  it('gives up on a buffer whose replay keeps dying on the real sink', async () => {
    const threadId = 'thread-replay-sink-loop';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-sink-loop');
      for (let index = 0; index < 200; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(200) }),
        );
        instance._flushChunkBuffer();
      }
      expect(instance._isStreamReplayDegraded(streamId)).toBe(false);

      // Each attempt is a fresh reattach whose sink dies part-way through, which
      // is what the client answers with another reconnect and another ACK. The
      // SDK contract is preserved every time (null, stream left active), but the
      // loop must not be able to repeat forever.
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(
          instance._resumableStream.replayChunks(
            stallingSseConnection(`sse-loop-${attempt}`, 4_000),
            'request-sink-loop',
          ),
        ).toBe(null);
        expect(instance._resumableStream.activeStreamId).toBe(streamId);
      }

      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(instance.ctx.storage.kv.get('chatReplayDegradedStreams')).toContain(streamId);
      const { connection, frames } = captureConnection('capture-sink-loop');
      expect(instance._resumableStream.replayChunks(connection, 'request-sink-loop')).toBe(null);
      expect(frames.length).toBe(1);
    });
  });

  it('pages a replay read by bytes, not only by segment rows', async () => {
    const threadId = 'thread-replay-page-bytes';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance.replayBoundOverrides = { pageMaxBytes: 4_000 };
      const streamId = instance._startStream('request-page-bytes');
      // FEWER rows than CHAT_REPLAY_BATCH_SEGMENTS, each one large: the shape the
      // SDK actually writes (segments are capped in BYTES, and a single oversized
      // chunk is stored unwrapped), and the shape `limit 40` cannot bound at all.
      const rowCount = 20;
      for (let index = 0; index < rowCount; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `${index}`.repeat(2_000) }),
        );
        instance._flushChunkBuffer();
      }
      expect(storedChunkCount(instance, streamId)).toBe(rowCount);
      expect(storedChunkBytes(instance, streamId)).toBeGreaterThan(4_000 * 4);

      const pages: Array<{ bytes: number; rows: number }> = [];
      instance.onReplayPageRead = (bytes: number, rows: number) => {
        pages.push({ bytes, rows });
      };
      const { connection, frames } = captureConnection('capture-page-bytes');
      expect(instance._resumableStream.replayChunks(connection, 'request-page-bytes')).toBe(null);

      expect(frames.length).toBe(rowCount + 1);
      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) {
        // A page never exceeds the byte budget unless it is a single row, which
        // is already bounded by the SDK's own per-chunk ceiling.
        if (page.rows > 1) expect(page.bytes).toBeLessThanOrEqual(4_000);
      }
    });
  });
});

describe('terminal replay readers', () => {
  const seedTerminalStream = (
    instance: any,
    streamId: string,
    requestId: string,
    status: 'completed' | 'error',
    chunkCount: number,
  ) => {
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
        ' values (?, ?, ?, ?, ?, ?)',
      streamId,
      requestId,
      status,
      Date.now(),
      null,
      0,
    );
    for (let index = 0; index < chunkCount; index++) {
      instance.ctx.storage.sql.exec(
        'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
        `chunk-${streamId}-${index}`,
        streamId,
        JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        index,
        Date.now(),
      );
    }
  };

  it('replays a completed stream byte-identically to the SDK', async () => {
    const threadId = 'thread-terminal-completed';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      seedTerminalStream(instance, 'stream-completed', 'request-completed', 'completed', 120);

      const stream = instance._resumableStream;
      const bounded = captureConnection('capture-terminal-completed');
      const sdk = captureConnection('capture-terminal-completed-sdk');
      expect(stream.replayCompletedChunksByRequestId(bounded.connection, 'request-completed')).toBe(
        true,
      );
      expect(
        Object.getPrototypeOf(stream).replayCompletedChunksByRequestId.call(
          stream,
          sdk.connection,
          'request-completed',
        ),
      ).toBe(true);

      expect(bounded.frames).toEqual(sdk.frames);
      expect(bounded.frames.length).toBe(121);
      expect(JSON.parse(bounded.frames.at(-1)!)).toEqual({
        body: '',
        done: true,
        id: 'request-completed',
        type: 'cf_agent_use_chat_response',
        replay: true,
      });
    });
  });

  it('replays an errored stream byte-identically to the SDK', async () => {
    const threadId = 'thread-terminal-errored';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      seedTerminalStream(instance, 'stream-errored', 'request-errored', 'error', 90);

      const stream = instance._resumableStream;
      const bounded = captureConnection('capture-terminal-errored');
      const sdk = captureConnection('capture-terminal-errored-sdk');
      expect(stream.replayErroredChunksByRequestId(bounded.connection, 'request-errored')).toBe(
        true,
      );
      expect(
        Object.getPrototypeOf(stream).replayErroredChunksByRequestId.call(
          stream,
          sdk.connection,
          'request-errored',
        ),
      ).toBe(true);

      expect(bounded.frames).toEqual(sdk.frames);
      expect(bounded.frames.length).toBe(90);
    });
  });

  it('keeps the SDK return contracts when there is no terminal stream', async () => {
    const threadId = 'thread-terminal-missing';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const stream = instance._resumableStream;
      const capture = captureConnection('capture-terminal-missing');

      // Asymmetric on purpose: `completed` reports "nothing served", `error`
      // reports "nothing to serve, go ahead and send your terminal frame".
      expect(stream.replayCompletedChunksByRequestId(capture.connection, 'request-nope')).toBe(
        false,
      );
      expect(stream.replayErroredChunksByRequestId(capture.connection, 'request-nope')).toBe(true);
      expect(capture.frames.length).toBe(0);
    });
  });

  it('serves no content frames for a degraded terminal buffer', async () => {
    const threadId = 'thread-terminal-degraded';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 500;
      seedTerminalStream(instance, 'stream-degraded-terminal', 'request-degraded-terminal', 'completed', 60);
      expect(instance._isStreamReplayDegraded('stream-degraded-terminal')).toBe(true);

      const stream = instance._resumableStream;
      const { connection, frames } = captureConnection('capture-terminal-degraded');
      expect(
        stream.replayCompletedChunksByRequestId(connection, 'request-degraded-terminal'),
      ).toBe(true);
      // A truncated buffer is not replayed as if it were the whole turn; the
      // CHAT_MESSAGES snapshot is what the client renders from.
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: true,
          id: 'request-degraded-terminal',
          type: 'cf_agent_use_chat_response',
          replay: true,
        },
      ]);
    });
  });
});

describe('stored-byte accounting parity', () => {
  it('gives the same degraded verdict before and after an eviction', async () => {
    const threadId = 'thread-bytes-parity';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const limit = 20_000;
      instance._streamReplayMaxStoredBytesOverride = limit;
      const streamId = instance._startStream('request-parity');
      // NOT flushed per chunk: let the SDK pack ~10 bodies into one row, which is
      // what re-escapes every quote inside every body and makes the on-disk bytes
      // 20-30% larger than a raw store-time tally would have counted.
      const body = JSON.stringify({
        type: 'tool-output-available',
        toolCallId: 'call-1',
        output: JSON.stringify({ note: 'q"uote', text: 'x'.repeat(120) }),
      });
      for (let index = 0; index < 200; index++) {
        await instance._storeStreamChunk(streamId, body);
      }
      instance._flushChunkBuffer();

      const packedRows = instance.ctx.storage.sql
        .exec('select body from cf_ai_chat_stream_chunks where stream_id = ?', streamId)
        .toArray() as Array<{ body: string }>;
      expect(packedRows.some((row) => row.body.startsWith('['))).toBe(true);

      const liveVerdict = instance._isStreamReplayDegraded(streamId);
      const diskBytes = storedChunkBytes(instance, streamId);
      // The ceiling is a bound on what lands on DISK, not on a raw tally that
      // undercounts what packing writes. One chunk of overshoot is inherent: the
      // chunk that fills the buffer is stored whole.
      expect(diskBytes).toBeLessThanOrEqual(limit + body.length * 2);

      // What an eviction leaves: no in-memory tally, no in-memory degraded set,
      // and a verdict that has to be re-derived.
      instance._streamStoredBytes?.clear();
      instance._replayDegradedStreams?.clear();

      expect(instance._isStreamReplayDegraded(streamId)).toBe(liveVerdict);
    });
  });

  it('does not degrade a stream that stayed inside the ceiling', async () => {
    const threadId = 'thread-bytes-parity-healthy';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      instance._streamReplayMaxStoredBytesOverride = 20_000;
      const streamId = instance._startStream('request-parity-healthy');
      for (let index = 0; index < 20; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'q"uoted' }),
        );
      }
      instance._flushChunkBuffer();

      expect(instance._isStreamReplayDegraded(streamId)).toBe(false);
      instance._streamStoredBytes?.clear();
      instance._replayDegradedStreams?.clear();
      expect(instance._isStreamReplayDegraded(streamId)).toBe(false);
      expect(events.some((entry) => entry.event === 'chat_stream_replay_degraded')).toBe(false);
    });
  });
});
