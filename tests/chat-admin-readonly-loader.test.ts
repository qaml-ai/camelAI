import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const requireAuthContextMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadContextByIdMock = vi.fn();
const getThreadMock = vi.fn();
const getThreadPreviewStateMock = vi.fn();
const getTodoStateMock = vi.fn();
const getUiMessagesMock = vi.fn();
const getWorkspaceModelPickerStateMock = vi.fn();
const getOrgBillingOverviewMock = vi.fn();
const getOrgMock = vi.fn();
const getWorkerScriptMock = vi.fn();
const listWorkspaceIntegrationRecordsMock = vi.fn();
const readThreadMessagesMock = vi.fn();
const ensureGroupForThreadMock = vi.fn();
const getGroupForWorkspaceMock = vi.fn();
const listGroupsForMoveMock = vi.fn();
const loadWorkspaceMentionSourcesMock = vi.fn();

vi.mock('@/lib/auth.server', () => ({
  requireSuperuser: requireSuperuserMock,
  requireAuthContext: requireAuthContextMock,
  requireSessionWorkspaceAccess: requireSessionWorkspaceAccessMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/billing.server', () => ({
  getOrgBillingOverview: getOrgBillingOverviewMock,
}));

vi.mock('@/lib/auth-do.server', () => ({
  adminGetThreadContextById: adminGetThreadContextByIdMock,
}));

vi.mock('@/lib/chat-do.server', () => ({
  applyHostedCreditPause: (state: unknown) => state,
  getThread: getThreadMock,
  getThreadPreviewState: getThreadPreviewStateMock,
  getTodoState: getTodoStateMock,
  getUiMessagePage: getUiMessagesMock,
  getWorkspaceModelPickerState: getWorkspaceModelPickerStateMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getOrg: getOrgMock,
  getWorkerScript: getWorkerScriptMock,
  listWorkspaceIntegrationRecords: listWorkspaceIntegrationRecordsMock,
}));

vi.mock('@/lib/chat-history.server', () => ({
  readThreadMessages: readThreadMessagesMock,
}));

vi.mock('@/lib/chat-groups.server', () => ({
  ensureGroupForThread: ensureGroupForThreadMock,
  getGroupForWorkspace: getGroupForWorkspaceMock,
  listGroupsForMove: listGroupsForMoveMock,
}));

vi.mock('@/lib/mention-sources.server', () => ({
  loadWorkspaceMentionSources: loadWorkspaceMentionSourcesMock,
}));

const { loader, shouldRevalidate } = await import('@/routes/_app.chat.$id');

describe('chat loader admin readonly mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          getIntegrations: async () => [],
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({
          getThread: async () => null,
          getInfo: async () => ({ id: 'org_active', slug: 'acme' }),
        }),
      },
    });
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
    });
    getTodoStateMock.mockResolvedValue([]);
    getUiMessagesMock.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      llmProvider: null,
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
    getOrgBillingOverviewMock.mockResolvedValue(null);
    getWorkerScriptMock.mockResolvedValue(null);
    listWorkspaceIntegrationRecordsMock.mockResolvedValue([]);
    readThreadMessagesMock.mockResolvedValue([]);
    ensureGroupForThreadMock.mockResolvedValue(null);
    getGroupForWorkspaceMock.mockResolvedValue(null);
    listGroupsForMoveMock.mockResolvedValue([]);
    loadWorkspaceMentionSourcesMock.mockResolvedValue({
      connections: [],
      projects: [],
    });
  });

  it('route shouldRevalidate preserves explicit same-thread same-URL revalidation', () => {
    const shouldRunLoader = shouldRevalidate({
      currentUrl: new URL('https://camelai.com/chat/thread_123?group=group_1'),
      nextUrl: new URL('https://camelai.com/chat/thread_123?group=group_1'),
      currentParams: { id: 'thread_123' },
      nextParams: { id: 'thread_123' },
      defaultShouldRevalidate: true,
    });

    expect(shouldRunLoader).toBe(true);
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('requires superuser for adminReadonly mode', async () => {
    requireSuperuserMock.mockRejectedValue(
      new Response(null, { status: 302, headers: { Location: '/' } })
    );

    await expect(
      loader({
        request: new Request('https://camelai.com/chat/thread_123?adminReadonly=1'),
        context: {},
        params: { id: 'thread_123' },
      } as never)
    ).rejects.toBeInstanceOf(Response);

    expect(requireSuperuserMock).toHaveBeenCalledTimes(1);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
  });

  it('returns read-only loader payload for superusers', async () => {
    requireSuperuserMock.mockResolvedValue({
      user: { is_superuser: true },
    });
    adminGetThreadContextByIdMock.mockResolvedValue({
      org_id: 'org_123',
      workspace_id: 'ws_123',
      title: 'Indexed Title',
    });
    getThreadMock.mockResolvedValue({
      title: 'Thread Title',
    });
    getOrgMock.mockResolvedValue({
      id: 'org_123',
      slug: 'acme',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123?adminReadonly=1'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.readOnly).toBe(true);
    expect(result.workspaceId).toBe('ws_123');
    expect(result.threadTitle).toBe('Thread Title');
    expect(result.orgSlug).toBe('acme');
    expect(requireAuthContextMock).not.toHaveBeenCalled();

    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      initialUiMessages: [],
      olderUiMessagesCursor: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
  });
});

describe('chat loader workspace mismatch handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => ({
          getIntegrations: async () => [],
        }),
      },
    });
    getAuthEnvMock.mockReturnValue({});
    getThreadPreviewStateMock.mockResolvedValue({
      target: null,
      tabs: [],
      activeTabId: null,
      version: 0,
    });
    getTodoStateMock.mockResolvedValue([]);
    getUiMessagesMock.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_active',
      workspaceId: 'ws_active',
      userId: 'user_123',
      access: 'full',
    });
    getWorkspaceModelPickerStateMock.mockResolvedValue({
      llmProvider: null,
      allowedThreadModels: ['sonnet'],
      effectivePickerDefaultModel: 'sonnet',
      hasEffectivePickerDefault: true,
      defaultModel: 'sonnet',
    });
    getOrgBillingOverviewMock.mockResolvedValue(null);
    requireSessionWorkspaceAccessMock.mockResolvedValue({
      orgId: 'org_active',
      workspaceId: 'ws_active',
      userId: 'user_123',
      access: 'full',
    });
  });

  it('redirects to /chat when the thread is not in the active workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue(null);

    await expect(
      loader({
        request: new Request('https://camelai.com/chat/thread_123'),
        context: {},
        params: { id: 'thread_123' },
      } as never)
    ).rejects.toSatisfy((response: unknown) => {
      return response instanceof Response
        && response.status === 302
        && response.headers.get('Location') === '/chat';
    });

    expect(getThreadMock).toHaveBeenCalledWith({}, 'thread_123', 'ws_active', {
      orgId: 'org_active',
    });
  });

  it('returns chat payload when the thread belongs to the active workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.readOnly).toBe(false);
    expect(result.workspaceId).toBe('ws_active');
    expect(result.threadTitle).toBe('Workspace Thread');
    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      initialUiMessages: [],
      olderUiMessagesCursor: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
  });

  it('preserves billing overview failures instead of exposing unpaused models', async () => {
    const billingError = new Error('billing overview unavailable');
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
    });
    getOrgBillingOverviewMock.mockRejectedValueOnce(billingError);

    await expect(
      loader({
        request: new Request('https://camelai.com/chat/thread_123'),
        context: {},
        params: { id: 'thread_123' },
      } as never),
    ).rejects.toBe(billingError);
  });

  it('seeds the normal transcript path from the thread record while durable history resolves', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'user_123', name: 'Illiana Reed', email: 'illiana@example.com' },
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      created_by: 'user_123',
      title: 'New Chat',
      model: 'sonnet',
      user_message_count: 0,
      first_user_message: 'Build an analytics dashboard',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.chatDataSeed.initialUiMessages).toEqual([
      expect.objectContaining({
        id: 'thread-seed:thread_123',
        role: 'user',
        parts: [{ type: 'text', text: 'Build an analytics dashboard', state: 'done' }],
        metadata: expect.objectContaining({ authorDisplayName: 'Illiana Reed', source: 'web' }),
      }),
    ]);
    // The same deferred durable transcript path runs for every thread shape.
    await result.chatData;
    expect(getUiMessagesMock).toHaveBeenCalled();
  });

  it('uses the same seed and transcript path for an API-created thread', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'viewer_456', name: 'Different Viewer', email: 'viewer@example.com' },
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      created_by: 'creator_123',
      title: 'New Chat',
      model: 'sonnet',
      user_message_count: 0,
      first_user_message: 'Build an analytics dashboard',
    });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.chatDataSeed.initialUiMessages[0]?.metadata).not.toHaveProperty('authorDisplayName');
    await result.chatData;
    expect(getUiMessagesMock).toHaveBeenCalled();
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('does not block existing-thread navigation on chat data resolution', async () => {
    let resolveMessages:
      | ((page: { messages: []; nextCursor: null; hasMore: false }) => void)
      | undefined;
    const pendingMessages = new Promise<{
      messages: [];
      nextCursor: null;
      hasMore: false;
    }>((resolve) => {
      resolveMessages = resolve;
    });
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
    });
    getUiMessagesMock.mockReturnValue(pendingMessages);

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.threadId).toBe('thread_123');
    expect(typeof (result.chatData as Promise<unknown>).then).toBe('function');

    let chatDataResolved = false;
    void Promise.resolve(result.chatData).then(() => {
      chatDataResolved = true;
    });
    await Promise.resolve();
    expect(chatDataResolved).toBe(false);

    resolveMessages?.({ messages: [], nextCursor: null, hasMore: false });
    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      initialUiMessages: [],
      olderUiMessagesCursor: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
  });

  it('loads messages for explicit same-thread revalidation and thread navigation', async () => {
    const context = {};
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockImplementation(async (_context, threadId: string) => ({
      id: threadId,
      workspace_id: 'ws_active',
      title: `Thread ${threadId}`,
    }));

    await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context,
      params: { id: 'thread_123' },
    } as never);
    expect(getUiMessagesMock).toHaveBeenCalledTimes(1);

    getUiMessagesMock.mockClear();
    const sameThreadShouldRevalidate = shouldRevalidate({
      currentUrl: new URL('https://camelai.com/chat/thread_123'),
      nextUrl: new URL('https://camelai.com/chat/thread_123'),
      currentParams: { id: 'thread_123' },
      nextParams: { id: 'thread_123' },
      defaultShouldRevalidate: true,
    });
    if (sameThreadShouldRevalidate) {
      await loader({
        request: new Request('https://camelai.com/chat/thread_123'),
        context,
        params: { id: 'thread_123' },
      } as never);
    }
    expect(getUiMessagesMock).toHaveBeenCalledTimes(1);
    expect(getUiMessagesMock).toHaveBeenCalledWith(context, 'thread_123');
    getUiMessagesMock.mockClear();

    const threadChangeShouldRevalidate = shouldRevalidate({
      currentUrl: new URL('https://camelai.com/chat/thread_123'),
      nextUrl: new URL('https://camelai.com/chat/thread_456'),
      currentParams: { id: 'thread_123' },
      nextParams: { id: 'thread_456' },
      defaultShouldRevalidate: false,
    });
    expect(threadChangeShouldRevalidate).toBe(true);

    await loader({
      request: new Request('https://camelai.com/chat/thread_456'),
      context,
      params: { id: 'thread_456' },
    } as never);

    expect(getUiMessagesMock).toHaveBeenCalledWith(context, 'thread_456');
    // Live loads never touch the legacy pi_core transcript RPC.
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('loads todo state into chat data for existing threads', async () => {
    const context = {};
    const todos = [
      {
        content: 'Review results',
        status: 'in_progress',
        activeForm: 'Reviewing results',
      },
    ];
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
    });
    getTodoStateMock.mockResolvedValue(todos);

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context,
      params: { id: 'thread_123' },
    } as never);

    expect(getTodoStateMock).toHaveBeenCalledWith(context, 'thread_123');
    expect(await result.chatData).toEqual(
      expect.objectContaining({ todos }),
    );
  });

  it('falls back to legacy visible models when picker state fails to load', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
    });
    getThreadMock.mockResolvedValue({
      id: 'thread_123',
      workspace_id: 'ws_active',
      title: 'Workspace Thread',
      model: 'opus-5',
    });
    getWorkspaceModelPickerStateMock.mockRejectedValue(
      new Error('transient picker failure'),
    );
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.threadModel).toBe('opus-5');
    if (!Array.isArray(result.allowedThreadModels)) {
      throw new Error('Expected fallback allowedThreadModels to be an array');
    }
    expect(result.allowedThreadModels).toContain('opus-5');
    expect(result.allowedThreadModels).toContain('sonnet');
    expect(result.allowedThreadModels.length).toBeGreaterThan(0);
    consoleErrorSpy.mockRestore();
  });
});
