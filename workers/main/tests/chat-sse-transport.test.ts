/**
 * ChatThreadDO chat transport over HTTP: SSE receive (`GET .../sse`) + POST send
 * (`POST .../call`).
 *
 * The transport is an ADAPTER, not a reimplementation: the SSE attach drives the
 * existing wrapped onConnect chain and the POST endpoint drives the existing
 * wrapped onMessage chain, so what these tests pin is the seam — frame order on
 * attach, the frame allow-list at the HTTP boundary, rpc capture without a live
 * stream, the resume handshake split across POST (request/ack) and SSE (reply +
 * replay), teardown running the full onClose chain, and the idle-close policy.
 */

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  SseConnection,
  createSseCaptureConnection,
} from '../src/chat-thread/sse-connection';

type AnyRecord = Record<string, unknown>;

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

function attachUrl(
  threadId: string,
  options: { pk: string; orgId?: string | null },
): string {
  const url = new URL(`http://internal/agents/chat-thread/${threadId}/sse`);
  url.searchParams.set('threadId', threadId);
  url.searchParams.set('workspaceId', 'workspace-1');
  if (options.orgId !== null) url.searchParams.set('orgId', options.orgId ?? 'org-1');
  url.searchParams.set('_pk', options.pk);
  return url.toString();
}

function callUrl(threadId: string, pk: string): string {
  const url = new URL(`http://internal/agents/chat-thread/${threadId}/call`);
  url.searchParams.set('threadId', threadId);
  url.searchParams.set('workspaceId', 'workspace-1');
  url.searchParams.set('orgId', 'org-1');
  url.searchParams.set('_pk', pk);
  return url.toString();
}

const identityHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'X-Chiridion-User-Id': 'user-1',
  'X-Chiridion-User-Name': 'User One',
  'X-Chiridion-User-Email': 'user-1@example.com',
  ...extra,
});

/**
 * Registry key for a stream. `_pk` is client-minted and every workspace member
 * passes the same thread-level auth, so the shim is namespaced by the
 * worker-authenticated user id — a participant cannot address another's stream.
 */
const registryKey = (pk: string, userId = 'user-1'): string => `${userId}::${pk}`;

/** Minimal SSE parser: yields data frames and `bye` events, skipping heartbeats. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';

  const nextBlock = async (): Promise<{ event: string | null; data: string } | null> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event: string | null = null;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
          else if (line.startsWith('event: ')) event = line.slice('event: '.length);
        }
        if (data.length === 0 && event === null) continue;
        return { event, data: data.join('\n') };
      }
      const { value, done } = await reader.read();
      if (done) return null;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      buffer += text;
    }
  };

  return {
    rawText: () => raw,
    nextBlock,
    async collectUntil(
      isDone: (frames: AnyRecord[]) => boolean,
      max = 12,
    ): Promise<AnyRecord[]> {
      const frames: AnyRecord[] = [];
      while (frames.length < max && !isDone(frames)) {
        const block = await nextBlock();
        if (!block) break;
        if (block.event === 'bye') {
          frames.push({ type: 'bye', ...(JSON.parse(block.data) as AnyRecord) });
          break;
        }
        frames.push(JSON.parse(block.data) as AnyRecord);
      }
      return frames;
    },
    cancel: () => reader.cancel(),
  };
}

const frameTypes = (frames: AnyRecord[]): string[] =>
  frames.map((frame) => String(frame.type));

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await scheduler.wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const seedChatContext = (instance: any, threadId: string, orgId = 'org-1') => {
  instance.chatContext = {
    threadId,
    workspaceId: 'workspace-1',
    orgId,
    userId: 'user-1',
    userName: 'User One',
    userEmail: 'user-1@example.com',
  };
};

describe('ChatThreadDO SSE attach', () => {
  it('serves the wrapped connect chain in socket frame order', async () => {
    const threadId = 'thread-sse-attach-order';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      await instance.persistMessages([
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'yo', state: 'done' }] },
      ]);
    });

    const response = await stub.fetch(attachUrl(threadId, { pk: 'pk-order' }), {
      headers: identityHeaders({ Accept: 'text/event-stream' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = sseReader(response);
    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).includes('cf_agent_chat_messages'),
    );
    const types = frameTypes(frames);

    // Agent's connect wrapper first (identity → state → mcp), then the app's
    // resident render history — the exact order a socket sees today.
    expect(types.indexOf('cf_agent_identity')).toBe(0);
    expect(types.indexOf('cf_agent_state')).toBeGreaterThan(
      types.indexOf('cf_agent_identity'),
    );
    expect(types.indexOf('cf_agent_mcp_servers')).toBeGreaterThan(
      types.indexOf('cf_agent_state'),
    );
    expect(types.indexOf('cf_agent_chat_messages')).toBeGreaterThan(
      types.indexOf('cf_agent_mcp_servers'),
    );
    const history = frames.find((frame) => frame.type === 'cf_agent_chat_messages');
    expect((history?.messages as AnyRecord[]).map((message) => message.id)).toEqual([
      'u1',
      'a1',
    ]);

    await reader.cancel();
  });

  it('registers the stream under the authenticated user + client-minted _pk', async () => {
    const threadId = 'thread-sse-registry';
    const stub = threadStub(threadId);
    const response = await stub.fetch(attachUrl(threadId, { pk: 'pk-registry' }), {
      headers: identityHeaders(),
    });
    expect(response.status).toBe(200);

    const key = registryKey('pk-registry');
    await runInDurableObject(stub, async (instance: any) => {
      const registered = instance.sseConnections.get(key);
      expect(registered).toBeDefined();
      expect(registered.id).toBe(key);
      // The raw client value is NOT an address: it identifies a stream only
      // within its owner's namespace.
      expect(instance.sseConnections.get('pk-registry')).toBeUndefined();
      expect(Array.from(instance.getConnections()).some(
        (connection: any) => connection.id === key,
      )).toBe(true);
      expect(instance.getConnection(key)?.id).toBe(key);
    });

    await response.body?.cancel();
  });

  it('ignores a client-supplied sub-agent routing header', async () => {
    const threadId = 'thread-sse-subagent-header';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
    });

    // `x-cf-agents-subagent-url` is the Agents SDK's SUB_AGENT_OUTER_URL_HEADER:
    // its onConnect wrapper prefers that client-supplied string over
    // `connection.uri` for sub-agent routing, so an honoured value diverts the
    // attach out of the chat protocol chain (and can instantiate an unrelated
    // sub-agent facet inside this shared thread DO). A WS handshake could not
    // carry it; an HTTP attach can, so it is stripped at both ends.
    const response = await stub.fetch(attachUrl(threadId, { pk: 'pk-subagent' }), {
      headers: identityHeaders({
        Accept: 'text/event-stream',
        'x-cf-agents-subagent-url': `https://camelai.dev/agents/chat-thread/${threadId}/sub/chat-thread-d-o/injected`,
        'x-partykit-room': 'someone-elses-room',
      }),
    });
    expect(response.status).toBe(200);

    const reader = sseReader(response);
    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).includes('cf_agent_mcp_servers'),
    );
    expect(frameTypes(frames)[0]).toBe('cf_agent_identity');
    expect(frameTypes(frames)).not.toContain('bye');

    await runInDurableObject(stub, async (instance: any) => {
      const registered = instance.sseConnections.get(registryKey('pk-subagent'));
      expect(registered?.isOpen).toBe(true);
      // The flag the wrapper would have stashed from the header.
      const rawState = (registered?.deserializeAttachment() ?? null) as AnyRecord | null;
      expect(Object.keys(rawState ?? {})).not.toContain('_cf_subAgentOuterUrl');
    });

    await reader.cancel();
  });

  it('bounds one member’s streams by evicting their oldest, not refusing them', async () => {
    const threadId = 'thread-sse-attach-cap';
    const stub = threadStub(threadId);
    const bodies: Array<ReadableStream<Uint8Array> | null> = [];

    // Every attach queues its own copy of the render window into its own
    // transform, so unbounded attaches are a memory lever on a DO shared by every
    // participant of the thread.
    for (let index = 0; index < 16; index++) {
      const admitted = await stub.fetch(
        attachUrl(threadId, { pk: `pk-cap-${index}` }),
        { headers: identityHeaders() },
      );
      expect(admitted.status).toBe(200);
      bodies.push(admitted.body);
    }
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.size).toBe(16);
    });

    // A client mints a fresh `_pk` per attempt and a vanished peer lingers until
    // the stall probe reaps it, so refusing the newest attach would let a
    // flapping client lock itself out of its own chat. The oldest goes instead.
    const admitted = await stub.fetch(attachUrl(threadId, { pk: 'pk-cap-16' }), {
      headers: identityHeaders(),
    });
    expect(admitted.status).toBe(200);
    bodies.push(admitted.body);

    // A different member is unaffected by the first one's limit.
    const other = await stub.fetch(attachUrl(threadId, { pk: 'pk-cap-other' }), {
      headers: identityHeaders({ 'X-Chiridion-User-Id': 'user-2' }),
    });
    expect(other.status).toBe(200);
    bodies.push(other.body);

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.size).toBe(17);
      expect(instance.sseConnections.has(registryKey('pk-cap-0'))).toBe(false);
      expect(instance.sseConnections.get(registryKey('pk-cap-16')).isOpen).toBe(true);
      expect(
        instance.sseConnections.get(registryKey('pk-cap-other', 'user-2')).isOpen,
      ).toBe(true);
    });

    for (const body of bodies) await body?.cancel();
  });

  it('429s an attach once the whole thread is at its stream ceiling', async () => {
    const threadId = 'thread-sse-attach-ceiling';
    const stub = threadStub(threadId);

    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      // Streams held by OTHER members: they must not be evicted to make room, so
      // the ceiling is a refusal rather than a cascade of cross-user teardowns.
      for (let index = 0; index < 64; index++) {
        const { connection } = createSseCaptureConnection({
          id: registryKey('pk-filler', `filler-${index}`),
          uri: null,
          server: threadId,
        });
        instance.sseConnections.set(connection.id, connection);
      }
    });

    const rejected = await stub.fetch(attachUrl(threadId, { pk: 'pk-ceiling' }), {
      headers: identityHeaders(),
    });
    // 429 is retryable for the client (never a false terminal): it reattaches on
    // its normal backoff instead of surfacing a dead chat.
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('5');

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.size).toBe(64);
      instance.sseConnections.clear();
    });
  });

  it('does not let one participant retire another participant’s stream', async () => {
    const threadId = 'thread-sse-cross-user-pk';
    const stub = threadStub(threadId);
    const victim = await stub.fetch(attachUrl(threadId, { pk: 'pk-shared' }), {
      headers: identityHeaders(),
    });
    const victimReader = sseReader(victim);
    await victimReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    // Same thread, same `_pk`, different authenticated member. `_pk` is client
    // input, so it must not be able to address someone else's stream.
    const attacker = await stub.fetch(attachUrl(threadId, { pk: 'pk-shared' }), {
      headers: identityHeaders({
        'X-Chiridion-User-Id': 'user-2',
        'X-Chiridion-User-Email': 'user-2@example.com',
      }),
    });
    expect(attacker.status).toBe(200);

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.get(registryKey('pk-shared')).isOpen).toBe(true);
      expect(
        instance.sseConnections.get(registryKey('pk-shared', 'user-2')).isOpen,
      ).toBe(true);
      expect(instance.sseConnections.size).toBe(2);
    });

    await victimReader.cancel();
    await attacker.body?.cancel();
  });

  it('403s an org mismatch before the stream body starts', async () => {
    const threadId = 'thread-sse-org-mismatch';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId, 'org-1');
    });

    const response = await stub.fetch(
      attachUrl(threadId, { pk: 'pk-mismatch', orgId: 'org-2' }),
      { headers: identityHeaders() },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).not.toBe('text/event-stream');
  });

  it('503s a degraded attach with no prior grant, and admits one with a grant', async () => {
    const threadId = 'thread-sse-degraded';
    const stub = threadStub(threadId);

    const denied = await stub.fetch(attachUrl(threadId, { pk: 'pk-degraded-1' }), {
      headers: identityHeaders({ 'X-Chiridion-Auth-Degraded': '1' }),
    });
    expect(denied.status).toBe(503);

    // A full attach mints the grant and stores the chat context the degraded
    // admit checks against.
    const full = await stub.fetch(attachUrl(threadId, { pk: 'pk-degraded-2' }), {
      headers: identityHeaders(),
    });
    expect(full.status).toBe(200);
    await waitFor(
      () =>
        runInDurableObject(stub, (instance: any) => Boolean(instance.chatContext)),
      'chat context capture',
    );
    await full.body?.cancel();

    const admitted = await stub.fetch(attachUrl(threadId, { pk: 'pk-degraded-3' }), {
      headers: identityHeaders({ 'X-Chiridion-Auth-Degraded': '1' }),
    });
    expect(admitted.status).toBe(200);
    await admitted.body?.cancel();
  });

  it('retires a stale shim when a reattach reuses the same _pk', async () => {
    const threadId = 'thread-sse-reattach';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-reattach');
      await instance._storeStreamChunk(streamId, JSON.stringify({ type: 'text-delta', delta: 'x' }));
      instance._flushChunkBuffer();
    });

    const first = await stub.fetch(attachUrl(threadId, { pk: 'pk-same' }), {
      headers: identityHeaders(),
    });
    expect(first.status).toBe(200);
    const firstReader = sseReader(first);
    await firstReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );

    const second = await stub.fetch(attachUrl(threadId, { pk: 'pk-same' }), {
      headers: identityHeaders(),
    });
    expect(second.status).toBe(200);
    const secondReader = sseReader(second);
    await secondReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.size).toBe(1);
      expect(instance.sseConnections.get(registryKey('pk-same')).isOpen).toBe(true);
      // The retired shim's onClose cleanup is keyed by the id this attach
      // reuses; if it ran late it would wipe the live stream's pending-resume
      // registration and the replay would interleave with live frames.
      expect(instance._pendingResumeConnections.has(registryKey('pk-same'))).toBe(true);
    });

    await firstReader.cancel();
    await secondReader.cancel();
  });
});

describe('ChatThreadDO POST /call', () => {
  it('captures the rpc response in the POST body', async () => {
    const threadId = 'thread-call-rpc';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
    });

    const response = await stub.fetch(callUrl(threadId, 'pk-rpc'), {
      method: 'POST',
      headers: identityHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-1',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });

    expect(response.status).toBe(200);
    const frame = (await response.json()) as AnyRecord;
    expect(frame).toMatchObject({ type: 'rpc', id: 'call-1', success: true, done: true });
  });

  it('returns the rpc failure frame instead of an HTTP error', async () => {
    const threadId = 'thread-call-rpc-error';
    const stub = threadStub(threadId);

    const response = await stub.fetch(callUrl(threadId, 'pk-rpc-error'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-2',
        method: 'getOlderUiMessages',
        args: [''],
      }),
    });

    expect(response.status).toBe(200);
    const frame = (await response.json()) as AnyRecord;
    expect(frame).toMatchObject({ type: 'rpc', id: 'call-2', success: false });
    expect(String(frame.error)).toContain('cursor');
  });

  it('acks a duplicate clientMessageId without enqueueing a second turn', async () => {
    const threadId = 'thread-call-dedupe';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      instance.recordAcceptedClientMessageId('client-msg-1');
      instance.enqueueRunnerUserMessage = () => {
        throw new Error('must not enqueue a duplicate send');
      };
    });

    const response = await stub.fetch(callUrl(threadId, 'pk-dedupe'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-3',
        method: 'sendMessage',
        args: ['hello again', 'client-msg-1'],
      }),
    });

    const frame = (await response.json()) as AnyRecord;
    expect(frame).toMatchObject({ type: 'rpc', id: 'call-3', success: true });
    expect(frame.result).toMatchObject({ status: 'accepted' });
  });

  it('bootstraps chat context on a first POST, then leaves identity alone', async () => {
    const threadId = 'thread-call-bootstrap';
    const stub = threadStub(threadId);

    const first = await stub.fetch(callUrl(threadId, 'pk-bootstrap'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-boot-1',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });
    expect(first.status).toBe(200);
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.chatContext).toMatchObject({
        threadId,
        workspaceId: 'workspace-1',
        orgId: 'org-1',
        userId: 'user-1',
      });
    });

    // A second poster must not rewrite the thread's shared identity context.
    await stub.fetch(callUrl(threadId, 'pk-bootstrap'), {
      method: 'POST',
      headers: identityHeaders({ 'X-Chiridion-User-Id': 'user-2' }),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-boot-2',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.chatContext.userId).toBe('user-1');
    });
  });

  it('rejects an rpc method outside the callable allow-list', async () => {
    const threadId = 'thread-call-method-guard';
    const stub = threadStub(threadId);

    const response = await stub.fetch(callUrl(threadId, 'pk-method'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-4',
        method: 'persistMessages',
        args: [[]],
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects non-frame and unsupported payloads', async () => {
    const threadId = 'thread-call-payload-guard';
    const stub = threadStub(threadId);

    for (const body of ['not json', JSON.stringify({ type: 'bogus_type' }), JSON.stringify({})]) {
      const response = await stub.fetch(callUrl(threadId, 'pk-payload'), {
        method: 'POST',
        headers: identityHeaders(),
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  it('409s a resume frame when no live stream is registered', async () => {
    const threadId = 'thread-call-resume-409';
    const stub = threadStub(threadId);

    const response = await stub.fetch(callUrl(threadId, 'pk-missing'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'probe-1' }),
    });

    expect(response.status).toBe(409);
  });

  it('dispatches a resume request against the live stream shim', async () => {
    const threadId = 'thread-call-resume-live';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-resume' }), {
      headers: identityHeaders(),
    });
    expect(attached.status).toBe(200);
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    const acked = await stub.fetch(callUrl(threadId, 'pk-resume'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'probe-2' }),
    });
    expect(acked.status).toBe(204);

    // The handshake reply rides the SSE stream, not the POST response.
    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).some((type) => type.startsWith('cf_agent_stream_')),
    );
    expect(
      frameTypes(frames).some((type) => type.startsWith('cf_agent_stream_')),
    ).toBe(true);

    await reader.cancel();
  });

  it('replays an active stream over SSE after an ack posted mid-stream', async () => {
    const threadId = 'thread-call-resume-replay';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-1');
      await instance._storeStreamChunk(
        streamId,
        JSON.stringify({ type: 'text-delta', delta: 'partial', id: 'part-1' }),
      );
      instance._flushChunkBuffer();
    });

    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-replay' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    const connectFrames = await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );
    const resuming = connectFrames.find(
      (frame) => frame.type === 'cf_agent_stream_resuming',
    );
    expect(resuming).toMatchObject({ id: 'request-1' });

    const acked = await stub.fetch(callUrl(threadId, 'pk-replay'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'request-1' }),
    });
    expect(acked.status).toBe(204);

    const replayFrames = await reader.collectUntil((frames) =>
      frames.some((frame) => frame.type === 'cf_agent_use_chat_response' && frame.replay),
    );
    const replayed = replayFrames.filter(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.replay,
    );
    expect(replayed.length).toBeGreaterThan(0);
    expect(String(replayed[0]!.body)).toContain('partial');

    await runInDurableObject(stub, async (instance: any) => {
      // The ack un-suppresses live broadcast for this connection.
      expect(instance._pendingResumeConnections.has(registryKey('pk-replay'))).toBe(false);
    });

    await reader.cancel();
  });

  it('keeps an orphaned stream active when the replay cannot reach the client', async () => {
    const threadId = 'thread-call-resume-dead-sink';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-orphan');
      await instance._storeStreamChunk(
        streamId,
        JSON.stringify({ type: 'text-delta', delta: 'partial', id: 'part-1' }),
      );
      instance._flushChunkBuffer();
      // A stream restored from SQLite after an eviction has no live reader. That
      // is the branch where the SDK finalizes the stream (and the host persists
      // the partial) on the strength of the replay it just wrote.
      instance._resumableStream._isLive = false;
    });

    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-dead-replay' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      // Exhaust the registry's shared write budget: the very next frame toward
      // this client cannot be queued, i.e. the peer is gone mid-replay.
      instance.sseQueueBudget.total = instance.sseQueueBudget.max;
    });

    const acked = await stub.fetch(callUrl(threadId, 'pk-dead-replay'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'request-orphan' }),
    });
    expect(acked.status).toBe(204);

    await runInDurableObject(stub, async (instance: any) => {
      // The shim reports the dead sink as the SDK's closed-send TypeError, so
      // `sendIfOpen` returns false and replayChunks bails instead of walking the
      // whole replay into a writer nobody reads, emitting its `done` terminator
      // and completing the stream. The stream must stay ACTIVE so the client's
      // next attach retries the whole replay (a completed stream would answer
      // that attach with `resume_none{idle}` and the replay would be lost).
      expect(instance._resumableStream.hasActiveStream()).toBe(true);
      const [metadata] = instance.ctx.storage.sql
        .exec('select status from cf_ai_chat_stream_metadata order by created_at desc limit 1')
        .toArray() as Array<{ status: string }>;
      expect(metadata?.status).toBe('streaming');
    });

    await reader.cancel();
  });

  it('409s a resume frame addressed at another participant’s stream', async () => {
    const threadId = 'thread-call-resume-cross-user';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-victim' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    const hijacked = await stub.fetch(callUrl(threadId, 'pk-victim'), {
      method: 'POST',
      headers: identityHeaders({ 'X-Chiridion-User-Id': 'user-2' }),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'probe-x' }),
    });
    // Guessing the victim's `_pk` must not drive a replay into their stream.
    expect(hijacked.status).toBe(409);

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.get(registryKey('pk-victim')).isOpen).toBe(true);
    });

    await reader.cancel();
  });
});

describe('ChatThreadDO SSE lifecycle', () => {
  it('fans a broadcast out past a dead stream', async () => {
    const threadId = 'thread-sse-broadcast-dead';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-live' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      const dead = new SseConnection({
        id: registryKey('pk-dead'),
        uri: null,
        server: threadId,
        // A sink whose peer is gone. `SseConnection.send` reports that as the
        // SDK's closed-send TypeError so replay loops abort — which means a
        // broadcast MUST guard its own fan-out, since `Agent.broadcast` does not.
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
      // Ordered ahead of the live stream: an unguarded fan-out would stop here
      // and the live client would silently miss every later frame of the turn.
      const live = instance.sseConnections.get(registryKey('pk-live'));
      instance.sseConnections.delete(live.id);
      instance.sseConnections.set(dead.id, dead);
      instance.sseConnections.set(live.id, live);

      expect(() =>
        instance.broadcast(JSON.stringify({ type: 'chat_broadcast_probe' })),
      ).not.toThrow();
    });

    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).includes('chat_broadcast_probe'),
    );
    expect(frameTypes(frames)).toContain('chat_broadcast_probe');

    await reader.cancel();
  });

  it('runs the full onClose chain when the stream is torn down', async () => {
    const threadId = 'thread-sse-teardown';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-teardown');
      await instance._storeStreamChunk(streamId, JSON.stringify({ type: 'text-delta', delta: 'x' }));
      instance._flushChunkBuffer();
    });

    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-teardown' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance._pendingResumeConnections.has(registryKey('pk-teardown'))).toBe(true);
    });

    // What a stream cancel / request abort / failed heartbeat write all funnel
    // into. The framework's onClose wrapper is the only cleanup for
    // _pendingResumeConnections, so a teardown that skips it leaves this id
    // excluded from every later chat broadcast.
    await runInDurableObject(stub, async (instance: any) => {
      instance.sseConnections.get(registryKey('pk-teardown')).abort(1006, 'stream_closed');
      expect(instance.sseConnections.size).toBe(0);
    });

    await waitFor(
      () =>
        runInDurableObject(
          stub,
          (instance: any) =>
            !instance._pendingResumeConnections.has(registryKey('pk-teardown')),
        ),
      'onClose resume-state cleanup',
    );

    await reader.cancel();
  });

  it('closes an idle stream with bye {"reason":"idle"}', async () => {
    const threadId = 'thread-sse-idle';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-idle' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.hasLiveChatWorkForStream()).toBe(false);
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(0);
    });

    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).includes('bye'),
    );
    expect(frames.at(-1)).toMatchObject({ type: 'bye', reason: 'idle' });
  });

  it('keeps the browser user available while a viewer is idle-parked', async () => {
    const threadId = 'thread-sse-parked-viewer';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-parked' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.hasAvailableBrowserUser()).toBe(true);

      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(0);

      // The park is the transport's doing, not the user leaving: the tab is
      // still open and reopens the stream on demand. Reporting absence here
      // makes askUserQuestion answer itself with "User is not at computer" and
      // promptConnectionSetup cancel itself for a user who is sitting there.
      expect(instance.hasAvailableBrowserUser()).toBe(true);

      const answers = instance.browserPrompts.askUserQuestion({
        questions: [
          { question: 'Ship it?', header: 'Deploy', options: ['Yes', 'No'] },
        ],
      });
      const pending = instance.browserPrompts.getOldestPendingQuestion();
      expect(pending?.questionId).toBeTruthy();
      // Held for the parked tab, which renders it from thread state on reattach.
      expect(
        instance.agentState().pendingQuestion?.questionId,
      ).toBe(pending.questionId);
      // Pending work also pins the stream policy open again.
      expect(instance.hasLiveChatWorkForStream()).toBe(true);

      instance.browserPrompts.answerQuestion({
        questionId: pending.questionId,
        answers: { Deploy: 'Yes' },
      });
      await expect(answers).resolves.toMatchObject({ Deploy: 'Yes' });
    });

    // Past the presumption window the parked viewer stops counting.
    await runInDurableObject(stub, async (instance: any) => {
      instance.ctx.storage.kv.put('chatSseViewer', {
        at: Date.now() - 31 * 60 * 1000,
        present: true,
      });
      expect(instance.hasAvailableBrowserUser()).toBe(false);
      const unavailable = await instance.browserPrompts.askUserQuestion({
        questions: [
          { question: 'Ship it?', header: 'Deploy', options: ['Yes', 'No'] },
        ],
      });
      expect(String(unavailable.unavailable_reason)).toContain(
        'not at computer',
      );
    });

    await reader.cancel();
  });

  it('restarts the idle grace on a new attach and on client POSTs', async () => {
    const threadId = 'thread-sse-idle-reset';
    const stub = threadStub(threadId);
    const first = await stub.fetch(attachUrl(threadId, { pk: 'pk-idle-1' }), {
      headers: identityHeaders(),
    });
    const firstReader = sseReader(first);
    await firstReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    // `sseIdleSince` is per-DO, so a fresh viewer must not inherit an older
    // stream's accumulated silence and get parked seconds after attaching.
    await runInDurableObject(stub, async (instance: any) => {
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
    });
    const second = await stub.fetch(attachUrl(threadId, { pk: 'pk-idle-2' }), {
      headers: identityHeaders(),
    });
    const secondReader = sseReader(second);
    await secondReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseIdleSince).toBeNull();
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(2);
    });

    // A POST is the only upstream signal a client can send between turns.
    await runInDurableObject(stub, async (instance: any) => {
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
    });
    const called = await stub.fetch(callUrl(threadId, 'pk-idle-2'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-idle-reset',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });
    expect(called.status).toBe(200);
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseIdleSince).toBeNull();
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(2);
    });

    await firstReader.cancel();
    await secondReader.cancel();
  });

  it('reaps a stalled stream so a pending question is not pinned to a phantom', async () => {
    const threadId = 'thread-sse-stalled';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-stalled' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      const runnerCommands: AnyRecord[] = [];
      instance.sendRunnerCommand = (command: AnyRecord) => {
        runnerCommands.push(command);
        return true;
      };
      void instance.browserPrompts
        .askUserQuestion({
          questions: [
            { question: 'Ship it?', header: 'Deploy', options: ['Yes', 'No'] },
          ],
        })
        .catch(() => {});
      expect(instance.browserPrompts.pendingQuestionCount).toBe(1);

      // A peer that vanished without the runtime erroring the writable half: the
      // write never drains. Byte volume can never notice (`:hb` is 5 bytes, so the
      // 8MB cap is centuries away), so the outstanding-write age is the probe.
      const connection = instance.sseConnections.get(registryKey('pk-stalled'));
      connection.sink.stalledFor = () => 31_000;

      // The pending question pins the idle policy open, so the stall probe is the
      // only thing that can reap this stream.
      expect(instance.hasLiveChatWorkForStream()).toBe(true);
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(0);

      // With the phantom gone, onClose's last-socket rule answers the question as
      // unavailable instead of blocking the turn for the 30-minute timeout.
      await instance.sseCloseChains.get(registryKey('pk-stalled'));
      await waitFor(
        () => instance.browserPrompts.pendingQuestionCount === 0,
        'pending question auto-answered after stall teardown',
      );
      expect(runnerCommands).toHaveLength(1);
      expect(runnerCommands[0]).toMatchObject({ type: 'question_response' });
      expect(
        String((runnerCommands[0]!.answers as AnyRecord).unavailable_reason),
      ).toContain('not at computer');
      instance.browserPrompts.clearQuestions();
    });

    await reader.cancel();
  });

  it('presumes a viewer through an isolate loss, and forgets one that left', async () => {
    const threadId = 'thread-sse-presence-durable';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-presence' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      // What an eviction/redeploy leaves behind: the registry is isolate-local, so
      // it is empty on wake while the tab is still open and reconnecting. Recovery
      // re-drives (including the alarm-driven OOM retry) ask for browser
      // availability before any client can be back — a hibernating WebSocket was
      // still registered here.
      instance.sseConnections.clear();
      expect(instance.getChatSockets().length).toBe(0);
      expect(instance.hasAvailableBrowserUser()).toBe(true);

      // A viewer that actually left clears the marker on the last stream's exit.
      instance.recordSseViewerPresence(false);
      expect(instance.hasAvailableBrowserUser()).toBe(false);
    });

    await reader.cancel();
  });

  it('records the viewer as gone when the last stream is torn down', async () => {
    const threadId = 'thread-sse-presence-teardown';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-presence-gone' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      instance.sseConnections
        .get(registryKey('pk-presence-gone'))
        .abort(1006, 'stream_closed');
      expect(instance.readSseViewerPresence()).toMatchObject({ present: false });
      expect(instance.hasAvailableBrowserUser()).toBe(false);
    });

    // An idle park is the transport's own doing: the viewer is still there.
    const parked = await stub.fetch(attachUrl(threadId, { pk: 'pk-presence-parked' }), {
      headers: identityHeaders(),
    });
    const parkedReader = sseReader(parked);
    await parkedReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );
    await runInDurableObject(stub, async (instance: any) => {
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(0);
      expect(instance.readSseViewerPresence()).toMatchObject({ present: true });
      expect(instance.hasAvailableBrowserUser()).toBe(true);
    });

    await reader.cancel();
    await parkedReader.cancel();
  });

  it('holds an idle-grace stream open while the thread has work', async () => {
    const threadId = 'thread-sse-hold';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-hold' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      instance.isThreadStreaming = () => true;
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(1);
      expect(instance.sseIdleSince).toBeNull();
    });

    await reader.cancel();
  });
});
