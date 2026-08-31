import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

// Chat connects through the SSE transport (`useSseAgent`). This test does not
// exercise the live connection, so mock the hook with an inert client.
vi.mock('@/lib/use-sse-agent', () => {
  const client = {
    readyState: 0,
    send: vi.fn(),
    call: vi.fn(() => Promise.resolve()),
    reconnect: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
  };
  return { useSseAgent: () => client };
});

// Chat owns its transcript through ai-chat (useAgentChat) now; this test does
// not exercise the live stream, so stub the projection hook. An empty history
// makes Chat fall back to `initialMessages`, matching the pre-cutover behavior.
vi.mock('@/lib/use-pi-chat-stream', () => ({
  usePiChatStream: () => ({
    messages: [],
    uiMessages: [],
    status: 'ready',
    isStreaming: false,
    streamingMessageId: null,
    setUiMessages: vi.fn(),
  }),
}));

import Chat from '@/components/Chat';
import type {
  AtMentionEntity,
  Integration,
  Message,
  PreviewTarget,
  WorkerScriptWithCreator,
} from '@/types';

const { latestPreviewContextValue } = vi.hoisted(() => ({
  latestPreviewContextValue: {
    current: null as null | {
      formatFilePathForCopy?: (target: {
        path: string;
        source?: string | null;
        project?: string | null;
      }) => string;
    },
  },
}));

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
const mockSubmit = vi.fn();

type MockFetcher = {
  state: 'idle';
  data: unknown;
  formData: undefined;
  load: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
};

function createFetcher(): MockFetcher {
  return {
    state: 'idle',
    data: undefined,
    formData: undefined,
    load: vi.fn(),
    submit: vi.fn(),
  };
}

let fetcherCallIndex = 0;
let fetchers: MockFetcher[] = [];

function resetFetchers() {
  fetcherCallIndex = 0;
  fetchers = [
    createFetcher(),
    createFetcher(),
    createFetcher(),
    createFetcher(),
    createFetcher(),
  ];
}

function findMentionFetcher() {
  return fetchers.find((fetcher) =>
    fetcher.load.mock.calls.some(
      ([url]) => url === '/api/workspaces/ws-1/mentions',
    ),
  );
}

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({
      pathname: '/chat/thread-1',
      search: '',
      hash: '',
      state: null,
      key: 'default',
    }),
    useNavigation: () => ({ state: 'idle', formData: undefined }),
    useRevalidator: () => ({ state: 'idle' as const, revalidate: mockRevalidate }),
    useFetcher: () => {
      const fetcher = fetchers[fetcherCallIndex % fetchers.length] ?? createFetcher();
      fetcherCallIndex += 1;
      return fetcher;
    },
    useSubmit: () => mockSubmit,
  };
});

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/hooks/use-auth-data', () => ({
  useAuthData: () => ({
    user: { id: 'user-1', name: 'Illiana' },
    currentWorkspace: { id: 'ws-1', name: 'Workspace 1' },
    currentOrg: { id: 'org-1', slug: 'org-1', name: 'Org 1' },
    orgs: [{ org_id: 'org-1', role: 'owner' }],
  }),
}));

vi.mock('@/hooks/use-chat-groups', () => ({
  useOptionalChatGroups: () => null,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/prompt-input', () => ({
  PromptInput: ({
    mentionables = [],
    onMentionMenuOpenChange,
  }: {
    mentionables?: AtMentionEntity[];
    onMentionMenuOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onMentionMenuOpenChange?.(true)}
      >
        Open mentions
      </button>
      <ul>
        {mentionables.map((item) => (
          <li key={`${item.kind}:${item.id}`}>{item.name}</li>
        ))}
      </ul>
    </div>
  ),
}));

vi.mock('@/components/chat-messages-view', () => ({
  ChatMessagesView: () => <div data-testid="messages" />,
}));

vi.mock('@/components/message-bubble', () => ({
  isInterruptMessage: () => false,
  parseLocalCommandStdout: () => null,
}));

vi.mock('@/components/welcome-screen', () => ({
  WelcomeScreen: ({
    allApps,
    onStartChatForApp,
  }: {
    allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
    onStartChatForApp: (app: WorkerScriptWithCreator) => void;
  }) => Array.isArray(allApps) && allApps[0] ? (
    <button type="button" onClick={() => onStartChatForApp(allApps[0]!)}>
      Edit {allApps[0].script_name}
    </button>
  ) : null,
}));

vi.mock('@/components/floating-todo', () => ({
  FloatingTodoList: () => null,
}));

vi.mock('@/components/ask-user-question', () => ({
  AskUserQuestion: () => null,
}));

vi.mock('@/components/connection-setup-prompt', () => ({
  ConnectionSetupPrompt: () => null,
}));

vi.mock('@/components/onboarding-loading-modal', () => ({
  OnboardingLoadingModal: () => null,
}));

vi.mock('@/components/chat-billing-credit-notice', () => ({
  BillingCreditNotice: () => null,
}));

vi.mock('@/components/billing/top-up-dialog', () => ({
  TopUpDialog: () => null,
}));

vi.mock('@/components/chat-error-notice', () => ({
  ChatErrorNotice: () => null,
}));

vi.mock('@/components/chat-share-status-button', () => ({
  ShareStatusButton: () => null,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ResizableHandle: () => null,
}));

vi.mock('@/components/chat-preview/preview-context', () => ({
  ChatPreviewProvider: ({
    value,
    children,
  }: {
    value: {
      formatFilePathForCopy?: (target: {
        path: string;
        source?: string | null;
        project?: string | null;
      }) => string;
    };
    children: React.ReactNode;
  }) => {
    latestPreviewContextValue.current = value;
    return <>{children}</>;
  },
}));

vi.mock('@/components/chat-preview/use-connection-setup-response', () => ({
  useConnectionSetupResponse: () => ({
    connectionSetupPrompt: null,
    handleConnectionSetupCancel: vi.fn(),
    handleConnectionSetupResponse: vi.fn(),
    setConnectionSetupPrompt: vi.fn(),
  }),
}));

vi.mock('@/components/chat-preview/use-chat-preview-render-state', () => ({
  useChatPreviewRenderState: () => ({
    tabRenderStates: {},
    previewDomains: { vanityHost: null },
    appPreviewVanityUrl: null,
    filePreviewOpenUrl: null,
    openElsewhereKind: null,
  }),
}));

vi.mock('@/components/chat-preview/chat-preview-shell', () => ({
  DEFAULT_NOTEBOOK_PREVIEW_STATE: {
    status: 'idle',
    notebook: null,
    reportHtml: null,
    error: null,
  },
  MobileViewSwitcher: () => null,
  PreviewPanelShell: () => null,
  normalizePreviewSessionState: (
    tabsInput: unknown,
    activeTabIdInput: unknown,
  ) => {
    const tabs = Array.isArray(tabsInput)
      ? tabsInput.map((target, index) => ({
          id:
            target && typeof target === 'object' && 'kind' in target
              ? `${String((target as { kind?: unknown }).kind)}:${index}`
              : `tab:${index}`,
          target,
        }))
      : [];
    const activeTabId =
      typeof activeTabIdInput === 'string'
        ? activeTabIdInput
        : (tabs[0]?.id ?? null);

    return {
      tabs,
      activeTabId,
      target: tabs.find((tab) => tab.id === activeTabId)?.target ?? null,
    };
  },
}));

const initialProject: AtMentionEntity = {
  kind: 'project',
  id: 'project-initial',
  name: 'Initial Project',
  description: 'Initial project',
};

const fetchedProject: AtMentionEntity = {
  kind: 'project',
  id: 'project-fetched',
  name: 'Fetched Project',
  description: 'Fetched project',
};

const fetchedConnection: Integration = {
  id: 'conn-bigquery',
  integration_type: 'bigquery',
  name: 'Prod',
  category: 'databases',
  auth_method: 'api_key',
  config: {},
  created_by: 'user-1',
  created_at: 1,
  updated_at: 1,
  has_credentials: true,
};

const initialConnection: Integration = {
  ...fetchedConnection,
  id: 'conn-existing',
  name: 'Existing Connection',
};

function assistantToolUseMessage(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  return {
    id,
    thread_id: 'thread-1',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: `${id}_tool`,
        name,
        input,
      },
    ],
    created_at: 1,
  };
}

describe('Chat mention source refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestPreviewContextValue.current = null;
    resetFetchers();
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  it('starts an app-edit chat with the namespaced app URL from welcome data', () => {
    const app: WorkerScriptWithCreator = {
      script_name: 'token-trail',
      workspace_id: 'ws-1',
      created_by: 'user-1',
      created_at: 1,
      updated_at: 1,
      is_public: false,
      preview_key: null,
      preview_updated_at: null,
      preview_status: null,
      preview_error: null,
      config_path: null,
      project_id: 'project-1',
      custom_domain_hostname: null,
      custom_domain_cf_hostname_id: null,
      custom_domain_status: null,
      custom_domain_ssl_status: null,
      custom_domain_error: null,
      custom_domain_updated_at: null,
    };

    render(
      <Chat
        workspaceId="ws-1"
        hostname="camelai.dev"
        orgSlug="valmark"
        welcomeData={{
          userId: 'user-1',
          userName: 'Geoff',
          allApps: [app],
          connections: [],
          projects: [],
          recentThreads: [],
          renderedAt: 1,
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit token-trail' }));

    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: 'createThreadAndStart',
        previewApps: 'token-trail',
        firstMessage: expect.stringContaining(
          'https://token-trail-valmark.camelai.app',
        ),
      }),
      { method: 'post', action: '/chat' },
    );
  });

  it('refreshes existing-thread composer connections and projects together', async () => {
    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    expect(screen.getByText('Initial Project')).toBeInTheDocument();
    expect(screen.queryByText('Prod')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open mentions' }));

    const mentionFetcher = findMentionFetcher();
    expect(mentionFetcher).toBeDefined();
    if (!mentionFetcher) throw new Error('Missing mention fetcher');
    expect(mentionFetcher.load).toHaveBeenCalledWith('/api/workspaces/ws-1/mentions');

    mentionFetcher.data = {
      connections: [fetchedConnection],
      projects: [fetchedProject],
    };
    fetcherCallIndex = 0;
    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Prod')).toBeInTheDocument();
      expect(screen.getByText('Fetched Project')).toBeInTheDocument();
    });
  });

  it('preserves stale connections when a refresh omits connections after a partial failure', async () => {
    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[initialConnection]}
        projects={[initialProject]}
      />,
    );

    expect(screen.getByText('Existing Connection')).toBeInTheDocument();
    expect(screen.getByText('Initial Project')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open mentions' }));

    const mentionFetcher = findMentionFetcher();
    expect(mentionFetcher).toBeDefined();
    if (!mentionFetcher) throw new Error('Missing mention fetcher');
    expect(mentionFetcher.load).toHaveBeenCalledWith('/api/workspaces/ws-1/mentions');

    mentionFetcher.data = {
      projects: [fetchedProject],
      error: 'Failed to load one or more workspace mention sources',
    };
    fetcherCallIndex = 0;
    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[initialConnection]}
        projects={[initialProject]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Existing Connection')).toBeInTheDocument();
      expect(screen.getByText('Fetched Project')).toBeInTheDocument();
    });
    expect(screen.queryByText('Initial Project')).not.toBeInTheDocument();
  });

  it('refreshes mention sources for a preview project missing from the current map', async () => {
    const projectPreviewTarget: PreviewTarget = {
      kind: 'file',
      source: 'project',
      workspaceId: 'ws-1',
      path: '/test.html',
      filename: 'test.html',
      project: 'test',
      contentType: 'text/html',
    };
    const fetchedProjectForPreview: AtMentionEntity = {
      kind: 'project',
      id: 'project-test',
      name: 'test',
      description: 'Test project',
    };

    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[]}
        projects={[initialProject]}
        initialPreviewTabs={[projectPreviewTarget]}
      />,
    );

    await waitFor(() => {
      expect(findMentionFetcher()).toBeDefined();
    });
    const mentionFetcher = findMentionFetcher();
    if (!mentionFetcher) throw new Error('Missing mention fetcher');
    expect(mentionFetcher.load).toHaveBeenCalledTimes(1);
    expect(
      latestPreviewContextValue.current?.formatFilePathForCopy?.({
        path: '/test.html',
        source: 'project',
        project: 'test',
      }),
    ).toBe('/test.html');

    mentionFetcher.data = {
      connections: [],
      projects: [fetchedProjectForPreview],
    };
    fetcherCallIndex = 0;
    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        connections={[]}
        projects={[initialProject]}
        initialPreviewTabs={[projectPreviewTarget]}
      />,
    );

    await waitFor(() => {
      expect(
        latestPreviewContextValue.current?.formatFilePathForCopy?.({
          path: '/test.html',
          source: 'project',
          project: 'test',
        }),
      ).toBe('@test - /test.html');
    });
    expect(mentionFetcher.load).toHaveBeenCalledTimes(1);
  });

  it('refreshes mention sources for a tool-only project missing from the current map', async () => {
    const fetchedProjectForTool: AtMentionEntity = {
      kind: 'project',
      id: 'project-test',
      name: 'test',
      description: 'Test project',
    };

    const { rerender } = render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          assistantToolUseMessage('message-tool-read', 'read', {
            location: 'project',
            project: 'test',
            path: '/test.html',
          }),
        ]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    await waitFor(() => {
      expect(findMentionFetcher()).toBeDefined();
    });
    const mentionFetcher = findMentionFetcher();
    if (!mentionFetcher) throw new Error('Missing mention fetcher');
    expect(mentionFetcher.load).toHaveBeenCalledTimes(1);

    mentionFetcher.data = {
      connections: [],
      projects: [fetchedProjectForTool],
    };
    fetcherCallIndex = 0;
    rerender(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          assistantToolUseMessage('message-tool-read', 'read', {
            location: 'project',
            project: 'test',
            path: '/test.html',
          }),
        ]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    await waitFor(() => {
      expect(
        latestPreviewContextValue.current?.formatFilePathForCopy?.({
          source: 'project',
          project: 'test',
          path: '/test.html',
        }),
      ).toBe('@test - /test.html');
    });
    expect(mentionFetcher.load).toHaveBeenCalledTimes(1);
  });

  it('does not refresh mention sources for non-file-copy project tools', () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          assistantToolUseMessage('message-tool-bash', 'bash', {
            location: 'project',
            project: 'test',
            command: 'cat /test.html',
          }),
        ]}
        connections={[]}
        projects={[initialProject]}
      />,
    );

    expect(fetchers.every((fetcher) => fetcher.load.mock.calls.length === 0)).toBe(
      true,
    );
  });
});
