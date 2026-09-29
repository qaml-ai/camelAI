import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSessionWorkspaceAccessMock = vi.fn();
const getThreadMock = vi.fn();
const getThreadTranscriptMock = vi.fn();
const getGroupForWorkspaceMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  getThread: getThreadMock,
  getThreadTranscript: getThreadTranscriptMock,
}));

vi.mock('@/lib/chat-groups.server', () => ({
  getGroupForWorkspace: getGroupForWorkspaceMock,
}));

const route = await import('@/routes/api/threads.$id.condensed-transcript');

function makeArgs(url = 'https://camelai.dev/api/threads/thread_1/condensed-transcript?groupId=group_1') {
  return {
    request: new Request(url, { method: 'GET' }),
    context: {},
    params: { id: 'thread_1' },
  } as never;
}

describe('condensed transcript route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_1',
      workspaceId: 'workspace_1',
      userId: 'user_1',
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_1',
      workspace_id: 'workspace_1',
      title: 'Planning chat',
    });
    getGroupForWorkspaceMock.mockResolvedValue({
      id: 'group_1',
      open_thread_ids: ['thread_1'],
      closed_thread_ids: [],
    });
    getThreadTranscriptMock.mockResolvedValue([
      {
        id: 'u1',
        thread_id: 'thread_1',
        role: 'user',
        content: 'Plan the rollout',
        created_at: 1,
      },
      {
        id: 'a1',
        thread_id: 'thread_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Roll it out in phases.' }],
        created_at: 2,
      },
    ]);
  });

  it('returns structured condensed turns for a group member thread', async () => {
    const response = await route.loader(makeArgs());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      threadId: 'thread_1',
      title: 'Planning chat',
      turns: [
        {
          user: 'Plan the rollout',
          assistantFinal: 'Roll it out in phases.',
          omittedCount: 0,
        },
      ],
    });
    expect(requireSessionWorkspaceAccessMock).toHaveBeenCalled();
    // Wherever the thread runs: a runtime thread's transcript is on the runtime.
    expect(getThreadTranscriptMock).toHaveBeenCalledWith({}, { orgId: 'org_1', threadId: 'thread_1' });
    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_1', 'workspace_1', {
      orgId: 'org_1',
    });
    expect(getGroupForWorkspaceMock).toHaveBeenCalledWith(
      {},
      {
        userId: 'user_1',
        orgId: 'org_1',
        workspaceId: 'workspace_1',
        groupId: 'group_1',
      },
    );
  });

  it('requires a groupId query param', async () => {
    const response = await route.loader(
      makeArgs('https://camelai.dev/api/threads/thread_1/condensed-transcript'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'groupId query param required',
    });
  });

  it('rejects threads that are not in the requested group', async () => {
    getGroupForWorkspaceMock.mockResolvedValue({
      id: 'group_1',
      open_thread_ids: ['thread_2'],
      closed_thread_ids: [],
    });

    const response = await route.loader(makeArgs());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Thread is not in this chat group',
    });
    expect(getThreadTranscriptMock).not.toHaveBeenCalled();
  });
});
