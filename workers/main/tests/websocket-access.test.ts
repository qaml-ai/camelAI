/**
 * The retired chat transports. Threads run on the agent runtime, so the old
 * in-DO chat transport (/agents/chat-thread/*: WebSocket, SSE, polling,
 * calls) answers 410 "moved" to anyone, without running authorization or
 * reaching ChatThreadDO; any other /agents/ path, and the removed workspace
 * status and log-tail WebSocket routes, 404 (never the SPA shell).
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Retired chat transports', () => {
  it('answers every old chat transport route with moved (410), signed in or not', async () => {
    for (const [path, init] of [
      ['/agents/chat-thread/t1?workspaceId=ws1&_pk=pk-ws', { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13' } }],
      ['/agents/chat-thread/t1/sse?workspaceId=ws1&_pk=pk-1', { headers: { Accept: 'text/event-stream' } }],
      ['/agents/chat-thread/t1/sse?transport=poll&_pk=pk-1&cursor=0', {}],
      ['/agents/chat-thread/t1/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
      ['/agents/chat-thread/t1/bogus', {}],
    ] as const) {
      const response = await SELF.fetch(`http://example${path}`, init);
      expect(response.status, path).toBe(410);
      expect(response.webSocket, path).toBeNull();
      expect(await response.json(), path).toMatchObject({ status: 'moved' });
    }
  });

  it('404s an /agents/ path that is no chat thread route', async () => {
    const response = await SELF.fetch('http://example/agents/other-agent/x');
    // A miss must not fall through to the SPA shell (200 text/html).
    expect(response.status).toBe(404);
  });

  it('404s the removed workspace status WebSocket route', async () => {
    const response = await SELF.fetch('http://example/ws/workspaces/ws1/status', {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
      },
    });

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it('404s the removed /ws/logs log-tail WebSocket route', async () => {
    const response = await SELF.fetch('http://example/ws/logs?scriptName=app', {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
      },
    });

    expect(response.status).toBe(404);
  });
});
