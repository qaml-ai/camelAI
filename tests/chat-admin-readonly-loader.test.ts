import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireSuperuserMock = vi.fn();
const requireAuthContextMock = vi.fn();
const requireSessionWorkspaceAccessMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const adminGetThreadContextByIdMock = vi.fn();
const getThreadMock = vi.fn();
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
const getThreadRuntimeMock = vi.fn(async () => null as unknown);
const loadRuntimeThreadSeedMock = vi.fn();
const openUnmovedThreadMock = vi.fn(async () => ({ state: 'moving' }) as unknown);
const readOnlyThreadHistoryMock = vi.fn();

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
  getThreadRuntime: getThreadRuntimeMock,
  getWorkspaceModelPickerState: getWorkspaceModelPickerStateMock,
}));

vi.mock('@/lib/runtime-threads.server', () => ({
  loadRuntimeThreadSeed: loadRuntimeThreadSeedMock,
  openUnmovedThread: openUnmovedThreadMock,
  readOnlyThreadHistory: readOnlyThreadHistoryMock,
}));
vi.mock('@/lib/wait-until', () => ({ waitUntil: vi.fn() }));

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
      todos: [],
      previewTabs: [],
      activeTabId: null,
    });
    expect(readThreadMessagesMock).toHaveBeenCalledWith({}, expect.objectContaining({ threadId: 'thread_123', skipBanCheck: true }));
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
    // A thread id from another workspace is never moved to the runtime.
    expect(openUnmovedThreadMock).not.toHaveBeenCalled();
  });

  it('moves a thread to the runtime only once it resolves for the active workspace', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'u1', name: 'Ada', email: null },
    });
    let resolveThread!: (thread: unknown) => void;
    getThreadMock.mockReturnValue(new Promise((resolve) => { resolveThread = resolve; }));

    const loading = loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openUnmovedThreadMock).not.toHaveBeenCalled();
    resolveThread({ id: 'thread_123', workspace_id: 'ws_active', title: 'Workspace Thread' });
    await loading;
    expect(openUnmovedThreadMock).toHaveBeenCalledWith({}, expect.objectContaining({
      orgId: 'org_active', workspaceId: 'ws_active', threadId: 'thread_123',
    }), expect.any(Function), expect.any(Number));
  });

  it('shows a thread still on ChatThreadDO moving, rendering nothing from the DO', async () => {
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
    expect(result.runtimeThread).toBe(false);
    expect(result.workspaceId).toBe('ws_active');
    expect(result.threadTitle).toBe('Workspace Thread');
    expect(await result.chatData).toEqual({
      messages: [],
      messagesError: null,
      todos: [],
      previewTabs: [],
      activeTabId: null,
      move: { state: 'moving' },
    });
    expect(readOnlyThreadHistoryMock).not.toHaveBeenCalled();
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('opens a thread its move just finished on the runtime', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'user_1' },
    });
    getThreadMock.mockResolvedValue({ id: 'thread_123', workspace_id: 'ws_active', title: 'Workspace Thread' });
    const row = { threadId: 'thread_123', agentId: 'agt_1', model: 'm', keyScope: 'hosted', configured: null, createdAt: 1, updatedAt: 1 };
    openUnmovedThreadMock.mockResolvedValueOnce({ state: 'runtime', row });
    const seed = { agentId: 'agt_1', token: 't', expiresAt: 2, url: null, page: { entries: [], next: null }, previewTabs: [], activeTabId: null };
    loadRuntimeThreadSeedMock.mockResolvedValue({ seed, error: null });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.runtimeThread).toBe(true);
    expect(await result.chatData).toMatchObject({ runtime: seed });
  });

  it('carries a stalled move (retrying, or blocked) to the page, not a spinner', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'user_1' },
    });
    getThreadMock.mockResolvedValue({ id: 'thread_123', workspace_id: 'ws_active', title: 'Workspace Thread' });
    for (const move of [{ state: 'retrying', retryAt: 1_700_000_000_000 }, { state: 'blocked', message: 'Hosted models are not configured.' }]) {
      openUnmovedThreadMock.mockResolvedValueOnce(move);
      const result = await loader({
        request: new Request('https://camelai.com/chat/thread_123'),
        context: {},
        params: { id: 'thread_123' },
      } as never);
      expect(await result.chatData).toMatchObject({ move });
    }
    expect(readOnlyThreadHistoryMock).not.toHaveBeenCalled();
  });

  it('shows a thread that cannot move read-only, from the exporter, with the reason', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'user_1' },
    });
    getThreadMock.mockResolvedValue({ id: 'thread_123', workspace_id: 'ws_active', title: 'Huge Thread' });
    openUnmovedThreadMock.mockResolvedValueOnce({ state: 'readonly', reason: 'too_large' });
    const messages = [{ id: 'm1', thread_id: 'thread_123', role: 'user', content: 'hello', created_at: 1, forkEntryId: 'm1' }];
    readOnlyThreadHistoryMock.mockResolvedValue({ messages, truncated: true });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.runtimeThread).toBe(false);
    expect(await result.chatData).toMatchObject({
      messages,
      move: { state: 'readonly', reason: 'too_large', truncated: true },
    });
    expect(readOnlyThreadHistoryMock).toHaveBeenCalledWith({}, 'thread_123');
  });

  it('loads a runtime thread from the runtime, without the thread DO', async () => {
    requireAuthContextMock.mockResolvedValue({
      currentWorkspace: { id: 'ws_active' },
      currentOrg: { id: 'org_active', slug: 'acme' },
      orgs: [{ org_id: 'org_active', role: 'admin' }],
      user: { id: 'user_1' },
    });
    getThreadMock.mockResolvedValue({ id: 'thread_rt', workspace_id: 'ws_active', title: 'Runtime Thread' });
    const row = { threadId: 'thread_rt', agentId: 'agt_1', model: 'm', keyScope: 'hosted', configured: null, createdAt: 1, updatedAt: 1 };
    getThreadRuntimeMock.mockResolvedValueOnce(row);
    const seed = {
      agentId: 'agt_1', token: 'abt', expiresAt: 2, url: 'https://agents.test',
      page: { entries: [], next: null }, previewTabs: [], activeTabId: null,
    };
    loadRuntimeThreadSeedMock.mockResolvedValue({ seed, error: null });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_rt'),
      context: {},
      params: { id: 'thread_rt' },
    } as never);

    expect(result.runtimeThread).toBe(true);
    expect(await result.chatData).toMatchObject({ runtime: seed, messagesError: null });
    expect(loadRuntimeThreadSeedMock).toHaveBeenCalledWith(expect.anything(), {
      orgId: 'org_active', workspaceId: 'ws_active', threadId: 'thread_rt', userId: 'user_1', row,
    });
    expect(openUnmovedThreadMock).not.toHaveBeenCalled();
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

  it("seeds a runtime thread's transcript from the thread record while its history resolves", async () => {
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
    getThreadRuntimeMock.mockResolvedValueOnce({ threadId: 'thread_123', agentId: null, model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 });
    loadRuntimeThreadSeedMock.mockResolvedValue({ seed: { agentId: null, token: null, expiresAt: null, url: null, page: null, previewTabs: [], activeTabId: null }, error: null });

    const result = await loader({
      request: new Request('https://camelai.com/chat/thread_123'),
      context: {},
      params: { id: 'thread_123' },
    } as never);

    expect(result.chatDataSeed.messages).toEqual([
      expect.objectContaining({
        id: 'thread-seed:thread_123',
        role: 'user',
        content: 'Build an analytics dashboard',
        authorDisplayName: 'Illiana Reed',
        messageSource: 'web',
      }),
    ]);
    await result.chatData;
    expect(readThreadMessagesMock).not.toHaveBeenCalled();
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
      model: 'opus-5.5',
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

    expect(result.threadModel).toBe('opus-5.5');
    if (!Array.isArray(result.allowedThreadModels)) {
      throw new Error('Expected fallback allowedThreadModels to be an array');
    }
    expect(result.allowedThreadModels).toContain('opus-5.5');
    expect(result.allowedThreadModels).toContain('sonnet');
    expect(result.allowedThreadModels.length).toBeGreaterThan(0);
    consoleErrorSpy.mockRestore();
  });
});
