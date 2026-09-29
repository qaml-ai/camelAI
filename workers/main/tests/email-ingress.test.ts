import { beforeEach, describe, expect, it, vi } from 'vitest';

// Channel turns start on the agent runtime; recorded here through the env's CHAT_THREAD double.
vi.mock("../src/agent-runtime/channel-turns.js", async (importOriginal) =>
  (await import("./helpers/channel-turn-recorder")).recordChannelTurns(await importOriginal<object>()));
const {
  startInitialUserMessageMock,
  getWorkspaceStubMock,
  getOrgStubMock,
  getUserStubMock,
} = vi.hoisted(() => ({
  startInitialUserMessageMock: vi.fn(),
  getWorkspaceStubMock: vi.fn(),
  getOrgStubMock: vi.fn(),
  getUserStubMock: vi.fn(),
}));

vi.mock('../src/helpers/stubs.js', () => ({
  getWorkspaceStub: getWorkspaceStubMock,
  getOrgStub: getOrgStubMock,
  getUserStub: getUserStubMock,
}));

import {
  handleWorkspaceEmailIngress,
  toAttachmentPayload,
} from '../src/email-ingress.js';

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
  raw?: string;
}): ForwardableEmailMessage & {
  setReject: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
} {
  const setReject = vi.fn();
  const reply = vi.fn().mockResolvedValue(undefined);

  const raw = args.raw ?? (() => {
    const rawBody = args.rawBody || 'hello';
    return [
      `From: ${args.from}`,
      `To: ${args.to}`,
      `Subject: ${args.subject || ''}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      rawBody,
    ].join('\r\n');
  })();

  return {
    from: args.from,
    to: args.to,
    headers: new Headers({
      subject: args.subject || '',
      'message-id': '<msg-1@example.com>',
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

function createMockKvStore(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createMockEnv(overrides?: Partial<Record<string, unknown>>): any {
  const emailToUser = createMockKvStore();
  const appKv = createMockKvStore();
  return {
    WORKSPACE_EMAIL_DOMAIN: 'mail.camelai.com',
    EMAIL_TO_USER: emailToUser,
    APP_KV: appKv,
    EMAIL_HANDLE: {
      idFromName: (handle: string) => handle,
      get: (handle: string) => ({
        getOwner: async () => handle === 'swift-falcon-ridge' ? 'workspace-1' : null,
      }),
    },
    R2_BUCKET: {
      put: vi.fn().mockResolvedValue({}),
    },
    CHAT_THREAD: {
      idFromName: (threadId: string) => threadId,
      get: () => ({
        startInitialUserMessage: startInitialUserMessageMock,
      }),
    },
    _emailToUserStore: emailToUser,
    _appKvStore: appKv,
    ...overrides,
  };
}

describe('handleWorkspaceEmailIngress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startInitialUserMessageMock.mockResolvedValue({ status: 'accepted' });
  });

  it('converts Uint8Array attachment content for upload', () => {
    const payload = toAttachmentPayload({
      filename: 'binary.dat',
      mimeType: 'application/octet-stream',
      disposition: 'attachment',
      content: new Uint8Array([1, 2, 3, 4]) as unknown as ArrayBuffer,
    });

    expect(payload?.body).toBeInstanceOf(Uint8Array);
    expect(payload?.size).toBe(4);
    expect(Array.from(payload?.body as Uint8Array)).toEqual([1, 2, 3, 4]);
  });

  it('uploads email attachments and appends upload refs to the forwarded message', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'starter', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Quarterly report' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const boundary = 'test-boundary';
    const raw = [
      'From: user@example.com',
      'To: swift-falcon-ridge@mail.camelai.com',
      'Subject: Quarterly report',
      'Message-ID: <msg-1@example.com>',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Here is the report.',
      `--${boundary}`,
      'Content-Type: text/plain; name="report 2026.txt"',
      'Content-Disposition: attachment; filename="report 2026.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8gYXR0YWNobWVudA==',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Quarterly report',
      raw,
    });

    await handleWorkspaceEmailIngress(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(env.R2_BUCKET.put).toHaveBeenCalledTimes(1);
    expect(startInitialUserMessageMock).toHaveBeenCalledTimes(1);
    expect(message.reply).not.toHaveBeenCalled();

    const [r2Key] = env.R2_BUCKET.put.mock.calls[0] as [string];
    const storedFilename = r2Key.split('/').pop() || '';

    expect(r2Key).toMatch(/^org-1\/workspace-1\/user-uploads\/report_2026-\d+-[a-z0-9]{6}\.txt$/);
    expect(startInitialUserMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        message: expect.stringContaining(`Here is the report.\n\n(user uploaded file to uploads/${storedFilename})`),
      })
    );
    expect(startInitialUserMessageMock.mock.calls[0]?.[0].message).toContain('send_email');
    expect(startInitialUserMessageMock.mock.calls[0]?.[0].message).toContain('user@example.com');
  });

  it('retries transient model picker RPC failures before creating a thread', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Durable Object reset because its code was updated.'),
        )
        .mockResolvedValueOnce({
          use_org_defaults: true,
          use_platform_defaults: true,
          models: [],
          default_model: null,
        }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi
        .fn()
        .mockRejectedValueOnce(
          new Error('Durable Object reset because its code was updated.'),
        )
        .mockResolvedValueOnce({
          use_platform_defaults: true,
          models: [],
          default_model: null,
        }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Need help' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Please help',
    });

    await handleWorkspaceEmailIngress(message, env);

    expect(message.setReject).not.toHaveBeenCalled();
    expect(orgStub.createThread).toHaveBeenCalledWith(
      'workspace-1',
      'Need help',
      'user-1',
      'Please help',
      'gpt-6-luna',
      expect.objectContaining({
        source: 'channel',
        channelKind: 'email',
        channelConnectionId: 'swift-falcon-ridge@mail.camelai.com',
        channelConversationId: 'message:msg-1@example.com',
        channelMessageId: 'msg-1@example.com',
      }),
    );
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      'channel_thread:email:workspace-1:swift-falcon-ridge@mail.camelai.com:message:msg-1@example.com',
      'thread-1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      'email_reply_ref:workspace-1:msg-1@example.com',
      'thread-1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      'email_thread_refs:workspace-1:thread-1',
      JSON.stringify(['msg-1@example.com']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(startInitialUserMessageMock).toHaveBeenCalledTimes(1);
  });

  it('uses generated conversation ids, not synthetic message ids, when inbound email lacks Message-ID', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Need help' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Please help',
    });
    message.headers.delete('message-id');

    await handleWorkspaceEmailIngress(message, env);

    expect(orgStub.createThread).toHaveBeenCalledWith(
      'workspace-1',
      'Need help',
      'user-1',
      'Please help',
      'gpt-6-luna',
      expect.objectContaining({
        source: 'channel',
        channelKind: 'email',
        channelConversationId: expect.stringMatching(/^generated:/),
        channelMessageId: null,
      }),
    );
    expect(env.APP_KV.put).not.toHaveBeenCalledWith(
      expect.stringMatching(/^email_thread_refs:/),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects unknown workspace mailbox format', async () => {
    const message = createMessage({
      from: 'user@example.com',
      to: 'support@mail.camelai.com',
      subject: 'hello',
    });

    await handleWorkspaceEmailIngress(message, createMockEnv());

    expect(message.setReject).toHaveBeenCalledWith('Unknown workspace email address.');
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('rejects inbound workspace email for Pay as you go orgs', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'payg', billing_status: 'active' }),
    };
    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'hello',
    });

    await handleWorkspaceEmailIngress(message, createMockEnv());

    expect(message.setReject).toHaveBeenCalledWith(
      'Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.',
    );
    expect(startInitialUserMessageMock).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('rejects senders that are not mapped to a user', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
    };
    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);

    const message = createMessage({
      from: 'stranger@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'hello',
    });

    await handleWorkspaceEmailIngress(message, createMockEnv());

    expect(message.setReject).toHaveBeenCalledWith('Sender is not allowed for this workspace inbox.');
    expect(message.reply).not.toHaveBeenCalled();
  });

  it('marks email dedupe complete after enqueueing without sending an automatic reply', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Need help' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');

    const message = createMessage({
      from: 'user@example.com',
      to: 'swift-falcon-ridge@mail.camelai.com',
      subject: 'Need help',
      rawBody: 'Please reply',
    });
    await expect(handleWorkspaceEmailIngress(message, env)).resolves.toBeUndefined();

    expect(startInitialUserMessageMock).toHaveBeenCalledTimes(1);
    expect(message.reply).not.toHaveBeenCalled();
    expect(env.APP_KV.put).toHaveBeenCalledWith(
      expect.stringMatching(/^channel_event:email:/),
      'done',
      expect.objectContaining({ expirationTtl: 600 })
    );
  });

  it('keeps inbound email deduped when post-enqueue metadata persistence fails', async () => {
    const workspaceStub = {
      getInfo: vi.fn().mockResolvedValue({ org_id: 'org-1', archived: false }),
      getMemberAccess: vi.fn().mockResolvedValue({ access_level: 'full' }),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue({ billing_plan: 'pro', billing_status: 'active' }),
      isMember: vi.fn().mockResolvedValue(true),
      getWorkspaceAccess: vi.fn().mockResolvedValue('full'),
      getThread: vi.fn().mockResolvedValue(null),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
      getModelPickerConfig: vi.fn().mockResolvedValue({
        use_platform_defaults: true,
        models: [],
        default_model: null,
      }),
      createThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Need help' }),
      getWorkspaceBySlug: vi.fn().mockResolvedValue({ id: 'workspace-1', name: 'My Workspace', created_at: 0, archived: 0 }),
    };
    const userStub = {
      getProfile: vi.fn().mockResolvedValue({ name: 'Agent User' }),
    };

    getWorkspaceStubMock.mockReturnValue(workspaceStub);
    getOrgStubMock.mockReturnValue(orgStub);
    getUserStubMock.mockReturnValue(userStub);

    const env = createMockEnv();
    env.EMAIL_TO_USER.get.mockResolvedValue('user-1');
    const originalPut = env.APP_KV.put;
    env.APP_KV.put = vi.fn(async (key: string, value: string, options?: unknown) => {
      if (key.startsWith('email_reply_ref:') || key.startsWith('email_thread_refs:')) {
        throw new Error('KV unavailable');
      }
      return originalPut(key, value, options);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const message = createMessage({
        from: 'user@example.com',
        to: 'swift-falcon-ridge@mail.camelai.com',
        subject: 'Need help',
        rawBody: 'Please reply',
      });

      await expect(handleWorkspaceEmailIngress(message, env)).resolves.toBeUndefined();

      expect(startInitialUserMessageMock).toHaveBeenCalledTimes(1);
      expect(env.APP_KV.put).toHaveBeenCalledWith(
        expect.stringMatching(/^channel_event:email:/),
        'done',
        expect.objectContaining({ expirationTtl: 600 }),
      );
      expect(consoleError).toHaveBeenCalledWith(
        '[email-ingress] failed to persist email thread metadata',
        expect.objectContaining({
          workspaceId: 'workspace-1',
          threadId: 'thread-1',
          messageId: 'msg-1@example.com',
          error: 'KV unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
