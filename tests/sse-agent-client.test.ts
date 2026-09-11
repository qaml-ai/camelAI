import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SseAgentClient } from '@/lib/sse-agent-client';
import { PollConnectionSink } from '../workers/main/src/chat-thread/poll-connection';
import { createSseQueueBudget } from '../workers/main/src/chat-thread/sse-connection';
import { FakeChatSocket } from './helpers/chat-socket';

describe('chat WebSocket client with HTTP polling fallback', () => {
  let client: SseAgentClient;
  let sink: PollConnectionSink;
  let polls: URL[];
  let posts: Record<string, unknown>[];
  let messages: string[];
  let opens: number;
  let denied: number;
  let pollStatus: number;
  let loseResponse: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    FakeChatSocket.instances = [];
    FakeChatSocket.autoOpen = false;
    vi.stubGlobal('WebSocket', FakeChatSocket);
    sink = new PollConnectionSink(createSseQueueBudget());
    polls = []; posts = []; messages = []; opens = 0; denied = 0; pollStatus = 200; loseResponse = false;
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        const frame = JSON.parse(String(init.body));
        posts.push(frame);
        return frame.type === 'rpc'
          ? Response.json({ type: 'rpc', id: frame.id, success: true, result: 'accepted' })
          : new Response(null, { status: 204 });
      }
      expect(url.searchParams.get('transport')).toBe('poll');
      polls.push(url);
      if (pollStatus !== 200) return new Response('denied or expired', { status: pollStatus });
      const batch = sink.read(Number(url.searchParams.get('cursor')));
      if (loseResponse) { loseResponse = false; throw new Error('Lost response'); }
      return Response.json(batch);
    });
    client = new SseAgentClient({
      agent: 'chat-thread', name: 'thread-1', host: 'example.com',
      query: { workspaceId: 'workspace-1' },
      onOpen: () => { opens += 1; },
      onMessage: event => messages.push(event.data),
      onConnectionError: () => { denied += 1; },
    });
  });
  afterEach(() => { client.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  const socket = () => FakeChatSocket.instances.at(-1)!;
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('uses WebSocket directly and has no synthetic connection timeout', async () => {
    client.start();
    const url = new URL(socket().url);
    expect(url.protocol).toBe('ws:'); // jsdom page is HTTP.
    expect(url.pathname).toBe('/agents/chat-thread/thread-1');
    expect(url.searchParams.get('workspaceId')).toBe('workspace-1');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls).toHaveLength(0);
    expect(client.readyState).toBe(0);
  });

  it('sends RPCs and resume frames over the socket, and receives the RPC result', async () => {
    client.start(); socket().open();
    const result = client.call('sendMessage', ['hello']);
    const frame = JSON.parse(socket().sent[0]);
    expect(frame).toMatchObject({ type: 'rpc', method: 'sendMessage', args: ['hello'] });
    socket().frame({ type: 'rpc', id: frame.id, success: true, result: 'accepted' });
    await expect(result).resolves.toBe('accepted');
    client.send(JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'turn-1' }));
    expect(JSON.parse(socket().sent[1]).type).toBe('cf_agent_stream_resume_ack');
    expect(posts).toHaveLength(0);
  });

  it.each([1000, 1006, 1011, 1012])('immediately falls back when a socket opens then closes with %s', async code => {
    client.start(); socket().open();
    socket().peerClose(code);
    expect(polls).toHaveLength(1); // No timer or second WebSocket attempt.
    await flush();
    expect(client.transport).toBe('poll');
    expect(client.readyState).toBe(1);
    expect(opens).toBe(2);
    expect(FakeChatSocket.instances).toHaveLength(1);
    await expect(client.call('sendMessage', ['follow-up'])).resolves.toBe('accepted');
  });

  it('falls back once on an error followed by close, even before opening', async () => {
    client.start(); const original = socket(); original.fail(); original.peerClose();
    await flush();
    expect(polls).toHaveLength(1);
    expect(opens).toBe(1);
    expect(client.transport).toBe('poll');
  });

  it('keeps unsent RPCs queued until polling is available', async () => {
    client.start();
    const result = client.call('sendMessage', ['queued']);
    socket().fail(); await flush();
    await expect(result).resolves.toBe('accepted');
    expect(posts).toHaveLength(1);
  });

  it('does not replay an RPC whose socket delivery was ambiguous', async () => {
    client.start(); socket().open();
    const result = client.call('sendMessage', ['only once']);
    const rejected = expect(result).rejects.toThrow('Connection lost');
    socket().peerClose(); await flush();
    await rejected;
    expect(posts).toHaveLength(0);
  });

  it('retains a lost poll response and delivers its replay once', async () => {
    client.start(); socket().fail(); await flush();
    sink.send(JSON.stringify({ type: 'cf_agent_use_chat_response', body: 'partial', replay: true }));
    loseResponse = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages).toHaveLength(1);
    expect(new Set(polls.map(url => url.searchParams.get('_pk'))).size).toBe(1);
  });

  it('reconnects a lost poll session, and respects HTTP authorization denial', async () => {
    client.start(); socket().fail(); await flush();
    const pk = client._pk;
    pollStatus = 409;
    await vi.advanceTimersByTimeAsync(1_000);
    pollStatus = 200; sink = new PollConnectionSink(createSseQueueBudget());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client._pk).not.toBe(pk);
    expect(client.transport).toBe('poll');
    pollStatus = 403;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(denied).toBe(1);
    expect(client.readyState).toBe(3);
    const count = polls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(count);
  });

  it('does not fall back on an explicit socket policy denial', async () => {
    client.start(); socket().open(); socket().peerClose(1008, 'forbidden'); await flush();
    expect(denied).toBe(1);
    expect(polls).toHaveLength(0);
    expect(client.readyState).toBe(3);
  });

  it('cancels socket callbacks and polling on navigation; can restart after cleanup', async () => {
    client.start(); const original = socket(); client.close(); original.fail(); await flush();
    expect(polls).toHaveLength(0);
    client.start(); socket().fail(); await flush(); client.close();
    const count = polls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(count);
  });

  it('supports SDK message listeners with abort signals', () => {
    const listener = vi.fn(); const controller = new AbortController();
    client.addEventListener('message', listener, { signal: controller.signal });
    client.start(); socket().open(); socket().frame({ type: 'probe' });
    expect(listener).toHaveBeenCalledOnce();
    controller.abort(); socket().frame({ type: 'probe' });
    expect(listener).toHaveBeenCalledOnce();
  });
});
