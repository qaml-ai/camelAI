/**
 * Chat transport access guard regression tests using Cloudflare Vitest pool.
 *
 * The chat transport is HTTP now: an SSE attach admits with 200 +
 * text/event-stream, and a denial is a real status the client can classify as
 * terminal (400/401/403/404) or retryable (409/429/5xx) — replacing the
 * accept-then-close-with-4403 trick the WebSocket upgrade needed.
 *
 * The legacy upgrade routes are gone entirely (2026-08-15), so the guard cases
 * below are joined by removal regressions: an upgrade attempt must 404 without
 * running authorization, and /ws/logs must keep working.
 */

import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { createSignedSession, type SignedSessionData } from '../src/signed-session';
import {
  createUser,
  createOrg,
  createInvitation,
  acceptInvitation,
  listOrgWorkspaces,
  setWorkspaceAccess,
  removeOrgMember,
  type TestEnv,
} from './test-helpers';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('Chat transport access guard', () => {
  const testEnv = env as unknown as TestEnv;
  const signingSecret = (env as any).TOKEN_SIGNING_SECRET as string;

  async function setupMemberSession() {
    const ownerEmail = testEmail();
    const memberEmail = testEmail();
    const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, memberEmail, 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'WS Access Org', ownerId);

    const invitation = await createInvitation(testEnv, org.id, memberEmail, 'member', ownerId);
    await acceptInvitation(testEnv, org.id, invitation.id, memberId);

    const workspaces = await listOrgWorkspaces(testEnv, org.id);
    const workspaceId = workspaces[0]?.id ?? null;
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(workspaceId!, 'Test thread', memberId);

    // Create a signed session token
    const sessionData: SignedSessionData = {
      user_id: memberId,
      org_id: org.id,
      workspace_id: workspaceId,
      created_at: Date.now(),
      user_name: 'Member',
      user_email: memberEmail,
    };
    const signedToken = await createSignedSession(signingSecret, sessionData);

    return {
      ownerId,
      memberId,
      orgId: org.id,
      workspaceId: workspaceId!,
      threadId: thread.id,
      signedToken,
    };
  }

  const attach = (threadId: string, workspaceId: string, signedToken: string) =>
    SELF.fetch(
      `http://example/agents/chat-thread/${threadId}/sse?workspaceId=${workspaceId}&_pk=pk-1`,
      {
        headers: {
          Accept: 'text/event-stream',
          'X-Chiridion-Session-Id': signedToken,
        },
      },
    );

  it('opens the SSE stream for authorized workspace access', async () => {
    const { workspaceId, threadId, signedToken } = await setupMemberSession();

    const response = await attach(threadId, workspaceId, signedToken);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    // Never read to completion — the stream is long-lived by design.
    await response.body?.cancel();
  });

  it('denies the SSE stream for denied workspace access', async () => {
    const { ownerId, memberId, workspaceId, threadId, signedToken } = await setupMemberSession();

    await setWorkspaceAccess(testEnv, workspaceId, memberId, 'none', ownerId);

    const response = await attach(threadId, workspaceId, signedToken);

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).not.toBe('text/event-stream');
  });

  it('denies the SSE stream when org membership is removed', async () => {
    const { ownerId, memberId, orgId, workspaceId, threadId, signedToken } = await setupMemberSession();

    await removeOrgMember(testEnv, orgId, memberId, ownerId);

    const response = await attach(threadId, workspaceId, signedToken);

    expect(response.status).toBe(403);
  });

  it('strips client-supplied framework routing headers from the attach', async () => {
    const { workspaceId, threadId, signedToken } = await setupMemberSession();

    // Unlike a WS handshake, an HTTP attach lets the browser set any header.
    // `x-cf-agents-subagent-url` is the Agents SDK's sub-agent routing input and
    // is preferred over the connection's own uri, so a forwarded value diverts
    // the attach out of the chat protocol chain entirely (bye instead of
    // identity/state/history). The route must not forward it.
    const response = await SELF.fetch(
      `http://example/agents/chat-thread/${threadId}/sse?workspaceId=${workspaceId}&_pk=pk-hdr`,
      {
        headers: {
          Accept: 'text/event-stream',
          'X-Chiridion-Session-Id': signedToken,
          'x-cf-agents-subagent-url': `http://example/agents/chat-thread/${threadId}/sub/chat-thread-d-o/injected`,
          'x-partykit-room': 'someone-elses-room',
        },
      },
    );

    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('cf_agent_identity');
    expect(first).not.toContain('event: bye');
    await reader.cancel();
  });

  it('rejects an unauthenticated POST send', async () => {
    const { workspaceId, threadId } = await setupMemberSession();

    const response = await SELF.fetch(
      `http://example/agents/chat-thread/${threadId}/call?workspaceId=${workspaceId}&_pk=pk-1`,
      {
        method: 'POST',
        body: JSON.stringify({ type: 'rpc', id: 'r1', method: 'requestStop', args: [] }),
      },
    );

    expect(response.status).toBe(401);
  });

  it('404s an /agents/ path that matches no transport route', async () => {
    const { signedToken } = await setupMemberSession();

    const response = await SELF.fetch('http://example/agents/chat-thread/nope/bogus', {
      headers: { 'X-Chiridion-Session-Id': signedToken },
    });

    // A miss must not fall through to the SPA shell (200 text/html).
    expect(response.status).toBe(404);
  });

  it('404s a chat WebSocket upgrade without running authorization', async () => {
    const { workspaceId, threadId, signedToken } = await setupMemberSession();

    // A fully authorized session: before the legacy path was removed this
    // handshake admitted with 101. It must now miss the route table entirely —
    // no upgrade, no accept-then-close, and no auth round trip.
    const response = await SELF.fetch(
      `http://example/agents/chat-thread/${threadId}?workspaceId=${workspaceId}&_pk=pk-ws`,
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'X-Chiridion-Session-Id': signedToken,
        },
      },
    );

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it('404s an unauthenticated chat WebSocket upgrade the same way', async () => {
    const { workspaceId, threadId } = await setupMemberSession();

    // A denial would have been 401/403 (or a 101 + 4401 close). The route is
    // gone, so a stale bundle gets an ordinary 404 either way.
    const response = await SELF.fetch(
      `http://example/agents/chat-thread/${threadId}?workspaceId=${workspaceId}&_pk=pk-ws`,
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
        },
      },
    );

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it('404s the removed workspace status WebSocket route', async () => {
    const { workspaceId, signedToken } = await setupMemberSession();

    const response = await SELF.fetch(
      `http://example/ws/workspaces/${encodeURIComponent(workspaceId)}/status`,
      {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
          'X-Chiridion-Session-Id': signedToken,
        },
      },
    );

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it('records the removed-route upgrade so stale bundles are countable', async () => {
    // A stale bundle does NOT stop after this 404: a failed handshake surfaces
    // as close code 1006, which every reconnecting client treats as retryable.
    // The event is how that population stays visible (and sizeable) instead of
    // hiding in raw 404 volume — see plans/sse-migration/WS-REMOVAL.md.
    const writes: Array<{ blobs?: unknown[]; doubles?: unknown[] }> = [];
    const envWithDataset = env as unknown as Record<string, unknown>;
    const previous = envWithDataset.OBSERVABILITY_EVENTS;
    envWithDataset.OBSERVABILITY_EVENTS = {
      writeDataPoint: (point: { blobs?: unknown[]; doubles?: unknown[] }) => {
        writes.push(point);
      },
    };

    try {
      const response = await SELF.fetch('http://example/ws/workspaces/ws-abc/status', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Version': '13',
        },
      });
      expect(response.status).toBe(404);
    } finally {
      envWithDataset.OBSERVABILITY_EVENTS = previous;
    }

    const removalEvents = writes.filter(
      (point) => (point.blobs as string[] | undefined)?.[0] === 'ws_upgrade_route_removed',
    );
    expect(removalEvents).toHaveLength(1);
    expect((removalEvents[0].blobs as string[])[7]).toBe('/ws/workspaces/ws-abc/status');
  });

  it('keeps answering the /ws/logs upgrade route (wrangler tail)', async () => {
    // The one surviving WebSocket route: the CF API proxy hands this URL back
    // as the tail endpoint. Unauthenticated, it must reject on its own terms
    // (400 for the missing scriptName) rather than fall into the blanket 404 —
    // proof the `websocket: true` route machinery is still wired up.
    const response = await SELF.fetch('http://example/ws/logs', {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
      },
    });

    expect(response.status).toBe(400);
  });
});
