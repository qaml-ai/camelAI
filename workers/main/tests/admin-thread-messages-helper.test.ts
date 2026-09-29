import { describe, expect, it, vi } from 'vitest';

const { runtimeApiMock } = vi.hoisted(() => ({ runtimeApiMock: vi.fn() }));
vi.mock('../src/agent-runtime/runtime-api.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));

vi.mock('../src/app-index-db', () => ({
  getAppIndexDatabase: (env: { APP_DB: unknown }) => env.APP_DB,
  getAppIndexReadDatabase: (env: { APP_DB: unknown }) => env.APP_DB,
}));

vi.mock('../src/admin-index-bootstrap', () => ({
  ensureAdminIndexReady: vi.fn(async () => undefined),
}));

import { loadAdminThreadMessagesResponse } from '../src/routes/admin/helpers';

describe('loadAdminThreadMessagesResponse', () => {
  it('returns Pi messages directly', async () => {
    const piMessages = [
      {
        id: 'message-1',
        thread_id: 'thread-1',
        role: 'user',
        content: 'hello',
        created_at: 123,
      },
    ];
    const env = {
      APP_DB: {
        getThreadContextById: vi.fn(async () => ({
          org_id: 'org-1',
          workspace_id: 'workspace-1',
        })),
      },
      APP_KV: {},
      EMAIL_TO_USER: {},
      USER: {},
      ORG: {
        idFromName: (id: string) => id,
        get: vi.fn(() => ({
          getThread: vi.fn(async () => ({
            workspace_id: 'workspace-1',
          })),
          getThreadRuntime: vi.fn(async () => null),
        })),
      },
      WORKSPACE: {},
      CHAT_THREAD: {
        idFromName: (id: string) => id,
        get: vi.fn(() => ({
          getPiCoreParsedMessages: vi.fn(async () => piMessages),
        })),
      },
    };

    const response = await loadAdminThreadMessagesResponse(env as never, 'thread-1');
    const body = await response.json() as { success?: boolean; messages?: unknown[] };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.messages).toEqual(piMessages);
  });

  it("reads a runtime thread's messages from its agent's history", async () => {
    runtimeApiMock.mockResolvedValue({ messages: [{ role: 'user', content: 'hello', timestamp: 123 }] });
    const getPiCoreParsedMessages = vi.fn();
    const env = {
      APP_DB: { getThreadContextById: vi.fn(async () => ({ org_id: 'org-1', workspace_id: 'workspace-1' })) },
      APP_KV: {},
      EMAIL_TO_USER: {},
      USER: {},
      ORG: {
        idFromName: (id: string) => id,
        get: vi.fn(() => ({
          getThread: vi.fn(async () => ({ workspace_id: 'workspace-1' })),
          getThreadRuntime: vi.fn(async () => ({ threadId: 'thread-1', agentId: 'agt_1' })),
        })),
      },
      WORKSPACE: {},
      CHAT_THREAD: { idFromName: (id: string) => id, get: vi.fn(() => ({ getPiCoreParsedMessages })) },
    };

    const response = await loadAdminThreadMessagesResponse(env as never, 'thread-1');
    const body = await response.json() as { messages?: Array<{ role: string; content: unknown }> };

    expect(body.messages).toMatchObject([{ role: 'user', content: 'hello' }]);
    expect(runtimeApiMock).toHaveBeenCalledWith(env, 'GET', '/v1/agents/agt_1/history');
    expect(getPiCoreParsedMessages).not.toHaveBeenCalled();
  });
});
