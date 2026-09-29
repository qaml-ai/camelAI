import { beforeEach, describe, expect, it, vi } from 'vitest';

// Channel turns start on the agent runtime; recorded here through the env's CHAT_THREAD double.
vi.mock("../src/agent-runtime/channel-turns.js", async (importOriginal) =>
  (await import("./helpers/channel-turn-recorder")).recordChannelTurns(await importOriginal<object>()));

const {
  mockStartInitialUserMessage,
  mockGetWorkspaceStub,
  mockGetOrgStub,
  mockGetUserStub,
} = vi.hoisted(() => ({
  mockStartInitialUserMessage: vi.fn(),
  mockGetWorkspaceStub: vi.fn(),
  mockGetOrgStub: vi.fn(),
  mockGetUserStub: vi.fn(),
}));

vi.mock('../src/helpers/stubs.js', () => ({
  getWorkspaceStub: mockGetWorkspaceStub,
  getOrgStub: mockGetOrgStub,
  getUserStub: mockGetUserStub,
}));

import { handleWorkspaceEmailIngress } from '../src/email-ingress.js';

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function createMessage(args: {
  from: string;
  to: string;
  subject?: string;
  rawBody?: string;
}): ForwardableEmailMessage & {
  setReject: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  const setReject = vi.fn();
  const reply = vi.fn().mockResolvedValue(undefined);

  const rawBody = args.rawBody || 'hello';
  const raw = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${args.subject || ''}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    rawBody,
  ].join('\r\n');

  return {
    from: args.from,
    to: args.to,
    headers: new Headers({
      subject: args.subject || '',
      'message-id': '<incoming@example.com>',
    }),
    raw: streamFromString(raw),
    rawSize: raw.length,
    setReject,
    forward: vi.fn(),
    reply,
  } as unknown as ForwardableEmailMessage & {
    setReject: ReturnType<typeof vi.fn>;
    reply: ReturnType<typeof vi.fn>;
  };
}

function createMockKvWithSlug(): KVNamespace {
  const store = new Map<string, string>([
    ['org_slug:acme-85b', 'org-1'],
  ]);
  return {
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function defaultOrgModelPickerConfig() {
  return {
    use_platform_defaults: true,
    default_model: null,
    models: [],
  };
}

function defaultWorkspaceModelPickerConfig() {
  return {
    use_org_defaults: true,
    use_platform_defaults: true,
    default_model: null,
    models: [],
  };
}

describe('handleWorkspaceEmailIngress channel enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockStartInitialUserMessage.mockResolvedValue({ status: 'accepted' });

    mockGetWorkspaceStub.mockReturnValue({
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultWorkspaceModelPickerConfig()),
    });

    mockGetOrgStub.mockReturnValue({
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'starter', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue(defaultOrgModelPickerConfig()),
      createThread: vi.fn().mockResolvedValue({
        id: 'thread-1',
        title: 'Build something',
      }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'My Workspace',
        created_at: 0,
        archived: 0,
      }),
    });

    mockGetUserStub.mockReturnValue({
      getProfile: vi.fn().mockResolvedValue({ name: 'Miguel' }),
    });
  });

  it('enqueues email content without sending an automatic reply', async () => {
    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Can you summarize this?',
    });

    const env = {
      WORKSPACE_EMAIL_DOMAIN: 'mail.camelai.com',
      EMAIL_TO_USER: {
        get: vi.fn().mockResolvedValue('user-1'),
      },
      APP_KV: createMockKvWithSlug(),
      EMAIL_HANDLE: {
        idFromName: (handle: string) => handle,
        get: (handle: string) => ({
          getOwner: async () => handle === 'swift-falcon-ridge' ? 'workspace-1' : null,
        }),
      },
      CHAT_THREAD: {
        idFromName: (threadId: string) => threadId,
        get: () => ({
          startInitialUserMessage: mockStartInitialUserMessage,
        }),
      },
    } as never;

    await handleWorkspaceEmailIngress(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
    expect(mockStartInitialUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        workspaceId: 'workspace-1',
        orgId: 'org-1',
        userId: 'user-1',
        userName: 'Miguel',
        userEmail: 'user@example.com',
        message: expect.stringContaining('Can you summarize this?'),
      }),
    );
    expect(mockStartInitialUserMessage.mock.calls[0]?.[0].message).toContain('send_email');
    expect(mockStartInitialUserMessage.mock.calls[0]?.[0].message).toContain('user@example.com');
  });
});
