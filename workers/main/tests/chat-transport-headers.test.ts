/**
 * Header hygiene for the HTTP chat transport. Both partyserver and the Agents
 * SDK take routing input from request headers, and the SSE/POST routes forward a
 * browser-shaped request to the DO — so a client that sets those headers itself
 * must never have them reach the framework.
 */

import { describe, expect, it } from 'vitest';

import {
  hasReservedTransportHeader,
  stripReservedTransportHeaders,
  withoutReservedTransportHeaders,
} from '../src/chat-thread/transport-headers';

describe('stripReservedTransportHeaders', () => {
  it('deletes framework routing headers and keeps everything else', () => {
    const headers = new Headers({
      // Agents' SUB_AGENT_OUTER_URL_HEADER: preferred over connection.uri by
      // Agent's onConnect wrapper, so a client value diverts the whole attach.
      'x-cf-agents-subagent-url':
        'https://camelai.dev/agents/chat-thread/t1/sub/chat-thread-d-o/injected',
      'X-CF-Agents-Something-Else': '1',
      'x-partykit-room': 'someone-elses-room',
      'x-partykit-props': '{"userId":"attacker"}',
      'x-partykit-namespace': 'chat-thread',
      Accept: 'text/event-stream',
      Cookie: 'chiridion_session_v3=token',
      'X-Chiridion-User-Id': 'user-1',
    });

    expect(hasReservedTransportHeader(headers)).toBe(true);
    stripReservedTransportHeaders(headers);

    expect(hasReservedTransportHeader(headers)).toBe(false);
    expect(headers.get('x-cf-agents-subagent-url')).toBeNull();
    expect(headers.get('x-cf-agents-something-else')).toBeNull();
    expect(headers.get('x-partykit-room')).toBeNull();
    expect(headers.get('x-partykit-props')).toBeNull();
    expect(headers.get('x-partykit-namespace')).toBeNull();
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('cookie')).toBe('chiridion_session_v3=token');
    expect(headers.get('x-chiridion-user-id')).toBe('user-1');
  });
});

describe('withoutReservedTransportHeaders', () => {
  it('returns the same request when nothing is reserved', () => {
    const request = new Request('https://camelai.dev/agents/chat-thread/t1/sse', {
      headers: { Accept: 'text/event-stream' },
    });
    expect(withoutReservedTransportHeaders(request)).toBe(request);
  });

  it('clones without the reserved headers, preserving the rest', () => {
    const request = new Request('https://camelai.dev/agents/chat-thread/t1/sse', {
      headers: {
        Accept: 'text/event-stream',
        'X-Chiridion-User-Id': 'user-1',
        'x-cf-agents-subagent-url':
          'https://camelai.dev/agents/chat-thread/t1/sub/chat-thread-d-o/injected',
      },
    });

    const sanitized = withoutReservedTransportHeaders(request);

    expect(sanitized).not.toBe(request);
    expect(sanitized.url).toBe(request.url);
    expect(sanitized.method).toBe('GET');
    expect(sanitized.headers.get('x-cf-agents-subagent-url')).toBeNull();
    expect(sanitized.headers.get('accept')).toBe('text/event-stream');
    expect(sanitized.headers.get('x-chiridion-user-id')).toBe('user-1');
  });
});
