import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSessionWorkspaceAccessMock = vi.fn();
const getEnvMock = vi.fn();
const getAuthEnvMock = vi.fn();
const createThreadMock = vi.fn();
const deleteThreadMock = vi.fn();
const orgGetThreadMock = vi.fn();
const userGetChatGroupSummaryMock = vi.fn();
const userGetChatGroupForThreadMock = vi.fn();
const addThreadToExistingGroupMock = vi.fn();
const orgGetThreadRuntimeMock = vi.fn();
const forkRuntimeThreadMock = vi.fn();

vi.mock('../workers/main/src/agent-runtime/thread-fork', () => ({
  forkRuntimeThread: forkRuntimeThreadMock,
}));

vi.mock('@/lib/auth.server', () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  createThread: createThreadMock,
  deleteThread: deleteThreadMock,
}));

vi.mock('@/lib/chat-groups.server', () => ({
  addThreadToExistingGroup: addThreadToExistingGroupMock,
}));

const { action } = await import('@/routes/api/workspaces.$id.chat.$threadId.fork');

const SOURCE_ROW = { threadId: 'thread_source', agentId: 'agt_src', model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };

describe('chat fork route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      session: { workspace_id: 'ws_123' },
      orgId: 'org_123',
      workspaceId: 'ws_123',
      userId: 'user_123',
    });
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: orgGetThreadMock,
          getThreadRuntime: orgGetThreadRuntimeMock,
        }),
      },
      USER: {
        idFromName: (id: string) => id,
        get: () => ({
          getChatGroupSummary: userGetChatGroupSummaryMock,
          getChatGroupForThread: userGetChatGroupForThreadMock,
        }),
      },
    });
    orgGetThreadRuntimeMock.mockResolvedValue(SOURCE_ROW);
    forkRuntimeThreadMock.mockResolvedValue({ status: 'forked', row: { ...SOURCE_ROW, threadId: 'thread_fork', agentId: 'agt_fork' } });
    orgGetThreadMock.mockResolvedValue({
      id: 'thread_source',
      workspace_id: 'ws_123',
      title: 'Legacy Opus thread',
      first_user_message: 'Build the prototype',
      model: 'opus-4.7',
    });
    createThreadMock.mockResolvedValue({
      id: 'thread_fork',
      workspace_id: 'ws_123',
      title: 'Fork: Legacy Opus thread',
      first_user_message: 'Build the prototype',
      model: 'opus-5.5',
    });
    deleteThreadMock.mockResolvedValue(undefined);
    addThreadToExistingGroupMock.mockResolvedValue({ id: 'group_123' });
    userGetChatGroupSummaryMock.mockResolvedValue({
      id: 'group_123',
      org_id: 'org_123',
      workspace_id: 'ws_123',
      name: 'Build',
      avatar: { color: '#4F46E5', content: '💬' },
      last_active_thread_id: 'thread_source',
      created_at: 1,
      updated_at: 1,
      open_thread_ids: ['thread_source'],
      closed_thread_ids: [],
    });
    userGetChatGroupForThreadMock.mockResolvedValue({
      id: 'group_123',
      org_id: 'org_123',
      workspace_id: 'ws_123',
      name: 'Build',
      avatar: { color: '#4F46E5', content: '💬' },
      last_active_thread_id: 'thread_source',
      created_at: 1,
      updated_at: 1,
      open_thread_ids: ['thread_source'],
      closed_thread_ids: [],
    });
  });

  it('forks a runtime thread on the runtime, from its history', async () => {
    const source = { threadId: 'thread_source', agentId: 'agt_src', model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };
    orgGetThreadRuntimeMock.mockResolvedValue(source);
    forkRuntimeThreadMock.mockResolvedValue({ status: 'forked', row: { ...source, threadId: 'thread_fork', agentId: 'agt_fork' } });
    const response = await action({
      request: new Request('https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: 'rt:3', renderedMessageId: 'rt:1' }),
      }),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    expect(forkRuntimeThreadMock).toHaveBeenCalledWith(expect.anything(), {
      source,
      target: { orgId: 'org_123', workspaceId: 'ws_123', threadId: 'thread_fork', userId: 'user_123', userName: null, userEmail: null },
      forkEntryId: 'rt:3',
    });
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it('deletes the new thread when a runtime fork point is not found', async () => {
    orgGetThreadRuntimeMock.mockResolvedValue({ threadId: 'thread_source', agentId: 'agt_src', model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 });
    forkRuntimeThreadMock.mockResolvedValue({ status: 'not_found', error: 'Fork target not found in the thread\'s history' });
    const response = await action({
      request: new Request('https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: 'client-1' }),
      }),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(404);
    expect(deleteThreadMock).toHaveBeenCalledWith({}, 'thread_fork', 'ws_123', { orgId: 'org_123' });
  });

  it('remaps legacy source models before creating the forked thread', async () => {
    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      thread: { id: 'thread_fork', model: 'opus-5.5' },
      groupId: 'group_123',
    });
    expect(createThreadMock).toHaveBeenCalledWith(
      {},
      'ws_123',
      'Fork: Legacy Opus thread',
      'user_123',
      'Build the prototype',
      'opus-5.5',
    );
    expect(createThreadMock).toHaveBeenCalledTimes(1);
    expect(addThreadToExistingGroupMock).toHaveBeenCalledWith(
      {},
      {
        userId: 'user_123',
        orgId: 'org_123',
        workspaceId: 'ws_123',
        groupId: 'group_123',
        threadId: 'thread_fork',
      },
    );
    expect(deleteThreadMock).not.toHaveBeenCalled();
  });

  it('refuses to fork a thread still on ChatThreadDO, without creating one', async () => {
    orgGetThreadRuntimeMock.mockResolvedValue(null);
    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123', groupId: 'group_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(409);
    expect(createThreadMock).not.toHaveBeenCalled();
    expect(forkRuntimeThreadMock).not.toHaveBeenCalled();
  });

  it('derives the source group when the client omits groupId', async () => {
    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      groupId: 'group_123',
    });
    expect(userGetChatGroupForThreadMock).toHaveBeenCalledWith('thread_source');
  });

  it('rejects requested groups that do not contain the source thread', async () => {
    userGetChatGroupSummaryMock.mockResolvedValue({
      id: 'group_123',
      org_id: 'org_123',
      workspace_id: 'ws_123',
      name: 'Build',
      avatar: { color: '#4F46E5', content: '💬' },
      last_active_thread_id: null,
      created_at: 1,
      updated_at: 1,
      open_thread_ids: ['other_thread'],
      closed_thread_ids: [],
    });

    const response = await action({
      request: new Request(
        'https://camelai.com/api/workspaces/ws_123/chat/thread_source/fork',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId: 'msg_123', groupId: 'group_123' }),
        },
      ),
      context: {},
      params: { id: 'ws_123', threadId: 'thread_source' },
    } as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Source thread is not in the requested group',
    });
    expect(createThreadMock).not.toHaveBeenCalled();
  });
});
