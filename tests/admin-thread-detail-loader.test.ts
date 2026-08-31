import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadWithMessagesMock = vi.fn();
const getVanityDomainMock = vi.fn();
const orgIdFromNameMock = vi.fn((id: string) => `org-id:${id}`);
const orgGetMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSuperuser: requireSuperuserMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do.server', () => ({
  adminGetThreadWithMessages: adminGetThreadWithMessagesMock,
}));

vi.mock('@/lib/app-url.server', () => ({
  getVanityDomain: getVanityDomainMock,
}));

const { action, loader } = await import('@/routes/_admin.threads.$id');

describe('admin thread detail loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const env = { TEST_ENV: true };
    getEnvMock.mockReturnValue(env);
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: orgIdFromNameMock,
        get: orgGetMock,
      },
    });
    getVanityDomainMock.mockResolvedValue('camelai.dev');
  });

  it('loads thread details without provider compatibility metadata', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    adminGetThreadWithMessagesMock.mockResolvedValue({
      thread: {
        id: 'thread_123',
        title: 'Investigate authEnv',
        model: 'gpt-5.2',
        created_by: 'user_123',
        created_at: 1_710_000_000_000,
        updated_at: 1_710_000_100_000,
      },
      messages: [
        {
          id: 'msg_123',
          thread_id: 'thread_123',
          role: 'user',
          content: 'open admin detail',
          created_at: 1_710_000_000_000,
        },
      ],
      org_id: 'org_123',
      org_name: 'Acme',
      workspace_id: 'ws_123',
      workspace_name: 'Main',
      preview_target: null,
    });

    const context = { cloudflare: { env: { TEST_ENV: true } } };
    const result = await loader({
      request: new Request('https://camelai.dev/qaml-backdoor/threads/thread_123'),
      context,
      params: { id: 'thread_123' },
    } as never);

    expect(requireSuperuserMock).toHaveBeenCalledTimes(1);
    expect(adminGetThreadWithMessagesMock).toHaveBeenCalledWith(context, 'thread_123');
    expect(result.thread).toMatchObject({
      id: 'thread_123',
      model: 'gpt-5.2',
    });
    expect(result.jsonlDownloadUrl).toBe(
      '/api/admin/threads/thread_123/jsonl?orgId=org_123&workspaceId=ws_123',
    );
  });

  it('forwards admin thread update revisions to ChatThreadDO metadata broadcasts', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    const setTitleMock = vi.fn().mockResolvedValue(undefined);
    const setModelMock = vi.fn().mockResolvedValue(undefined);
    const refreshRunnerConfigMock = vi.fn().mockResolvedValue(undefined);
    const chatThreadGetMock = vi.fn().mockReturnValue({
      setTitle: setTitleMock,
      setModel: setModelMock,
      refreshRunnerConfig: refreshRunnerConfigMock,
    });
    const chatThreadIdFromNameMock = vi.fn((id: string) => `chat-thread:${id}`);
    const env = {
      CHAT_THREAD: {
        idFromName: chatThreadIdFromNameMock,
        get: chatThreadGetMock,
      },
    };
    getEnvMock.mockReturnValue(env);
    const adminUpdateThreadMock = vi.fn().mockResolvedValue({
      id: 'thread_123',
      title: 'Renamed thread',
      model: 'sonnet',
      updated_at: 1_710_000_200_000,
    });
    orgGetMock.mockReturnValue({
      getThread: vi.fn().mockResolvedValue({
        id: 'thread_123',
        title: 'Old title',
        model: 'sonnet',
      }),
      adminUpdateThread: adminUpdateThreadMock,
    });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: orgIdFromNameMock,
        get: orgGetMock,
      },
    });
    const formData = new FormData();
    formData.set('intent', 'updateThread');
    formData.set('title', ' Renamed thread ');
    formData.set('model', 'sonnet');
    formData.set('orgId', 'org_123');

    const result = await action({
      request: new Request('https://camelai.dev/qaml-backdoor/threads/thread_123', {
        method: 'POST',
        body: formData,
      }),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result).toEqual({ success: true });
    expect(adminUpdateThreadMock).toHaveBeenCalledWith(
      'thread_123',
      { title: 'Renamed thread', model: 'sonnet' },
      'system-admin',
    );
    expect(setTitleMock).toHaveBeenCalledWith(
      'Renamed thread',
      1_710_000_200_000,
    );
    expect(setModelMock).toHaveBeenCalledWith(
      'sonnet',
      1_710_000_200_000,
    );
    expect(refreshRunnerConfigMock).toHaveBeenCalledTimes(1);
  });
});
