import { afterEach, describe, it, expect, vi } from 'vitest';

// Channel turns start on the agent runtime; recorded here through the env's CHAT_THREAD double.
vi.mock("../src/agent-runtime/channel-turns.js", async (importOriginal) =>
  (await import("./helpers/channel-turn-recorder")).recordChannelTurns(await importOriginal<object>()));
import { handleSlackEvents, processSlackEventCallback } from '../src/routes/integrations.js';
import { handleSlackEventsQueue } from '../src/slack-events-queue.js';
import type { SlackEventQueueMessage } from '../src/slack-types.js';
import { encryptCredentials } from '../../../src/lib/integration-crypto';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(): Promise<KVNamespaceListResult> {
      return { keys: [], list_complete: true, cursor: '' };
    },
    getWithMetadata: async () => ({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

function createSlackTeamRegistry(
  records: Array<{
    workspace_id: string;
    org_id: string;
    integration_id: string;
    team_id: string;
    bot_user_id?: string;
    updated_at: number;
  }>,
) {
  const stub = {
    listInstallations: vi.fn(async () => records),
    replaceInstallations: vi.fn(async (nextRecords) => {
      records.splice(0, records.length, ...nextRecords);
    }),
    upsertInstallation: vi.fn(async (record) => {
      records.unshift(record);
    }),
  };
  const namespace = {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => stub),
  };
  return { namespace, stub };
}

function slackInstallationRegistry() {
  return createSlackTeamRegistry([
    {
      workspace_id: 'ws-1',
      org_id: 'org-1',
      integration_id: 'slack-int',
      team_id: 'T123',
      bot_user_id: 'B123',
      updated_at: Date.now(),
    },
  ]);
}

function createSlackOrgNamespace(encryptedCredentials: string) {
  const orgStub = {
    getWorkspaceRecord: vi.fn(async () => ({
      id: 'ws-1',
      org_id: 'org-1',
      archived: false,
    })),
    getWorkspaceIntegration: vi.fn(async () => ({
      integration_type: 'slack',
      credentials_encrypted: encryptedCredentials,
    })),
    getThread: vi.fn(async () => ({ id: 'thread-1', title: 'Slack' })),
  };
  return {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => orgStub),
  };
}

async function createSlackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const base = `v0:${timestamp}:${body}`;
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(base));
  const digest = Array.from(new Uint8Array(signed))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${digest}`;
}

async function postSlackEvent(
  payload: unknown,
  env: {
    APP_KV: KVNamespace;
    SLACK_SIGNING_SECRET: string;
    SLACK_EVENTS_QUEUE?: Queue<SlackEventQueueMessage>;
  },
  waitUntil: (promise: Promise<unknown>) => void
): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await createSlackSignature(env.SLACK_SIGNING_SECRET, timestamp, body);

  const req = new Request('https://camelai.dev/api/integrations/slack/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });

  return handleSlackEvents({
    req,
    env: env as never,
    ctx: { waitUntil } as never,
    url: new URL(req.url),
    match: [] as unknown as RegExpMatchArray,
  });
}

describe('handleSlackEvents', () => {
  it('enqueues callback events when SLACK_EVENTS_QUEUE is configured', async () => {
    const kv = createMockKV();
    const send = vi.fn().mockResolvedValue(undefined);
    const queue = { send } as unknown as Queue<SlackEventQueueMessage>;
    const waitUntil = vi.fn();
    const env = {
      APP_KV: kv,
      SLACK_SIGNING_SECRET: 'test-signing-secret',
      SLACK_EVENTS_QUEUE: queue,
    };

    const payload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvQueue',
      event: {
        type: 'app_mention',
        channel: 'C123',
        channel_type: 'channel',
        user: 'U123',
        ts: '1700000000.000099',
        text: '<@B123> hello',
      },
    };

    const response = await postSlackEvent(payload, env, waitUntil);

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      payload,
      received_at: expect.any(Number),
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('dedupes app_mention and message events for the same Slack message', async () => {
    const kv = createMockKV();
    const waitUntil = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      APP_KV: kv,
      SLACK_SIGNING_SECRET: 'test-signing-secret',
    };

    const sharedEvent = {
      channel: 'C123',
      channel_type: 'channel',
      user: 'U123',
      ts: '1700000000.000100',
      text: '<@B123> hello',
    };

    const mentionPayload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvA',
      event: {
        ...sharedEvent,
        type: 'app_mention',
      },
    };

    const messagePayload = {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvB',
      event: {
        ...sharedEvent,
        type: 'message',
      },
    };

    try {
      const first = await postSlackEvent(mentionPayload, env, waitUntil);
      const second = await postSlackEvent(messagePayload, env, waitUntil);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(await kv.get('slack_message:T123:C123:U123:1700000000.000100')).toBe('1');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('downloads Slack event files into workspace uploads before enqueueing the channel message', async () => {
    const kv = createMockKV();
    const registry = slackInstallationRegistry();
    await kv.put('channel_thread:slack:ws-1:slack-int:t123:c123:dm', 'thread-1');

    const encrypted = await encryptCredentials(
      { access_token: 'xoxb-token', team_id: 'T123', bot_user_id: 'B123' },
      'secret',
    );
    const r2Put = vi.fn(async () => undefined);
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://files.slack.com/files-pri/T123-F123/download/sheet.csv');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-token');
      return new Response('a,b\n1,2\n', {
        headers: { 'content-type': 'text/csv' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await processSlackEventCallback({
      APP_KV: kv,
      SLACK_TEAM_REGISTRY: registry.namespace,
      INTEGRATION_SECRET_KEY: 'secret',
      R2_BUCKET: { put: r2Put },
      ORG: createSlackOrgNamespace(encrypted),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
          getIntegration: vi.fn(async () => ({
            integration_type: 'slack',
            credentials_encrypted: encrypted,
          })),
        })),
      },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ startInitialUserMessage })),
      },
    } as never, {
      type: 'event_callback',
      team_id: 'T123',
      event_id: 'EvFile',
      event: {
        type: 'message',
        subtype: 'file_share',
        channel: 'C123',
        channel_type: 'im',
        user: 'U123',
        ts: '1700000000.000101',
        text: 'see attached',
        files: [
          {
            id: 'F123',
            name: 'sheet.csv',
            mimetype: 'text/csv',
            url_private_download: 'https://files.slack.com/files-pri/T123-F123/download/sheet.csv',
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r2Put).toHaveBeenCalledTimes(1);
    expect(r2Put.mock.calls[0][0]).toMatch(/^org-1\/ws-1\/user-uploads\/sheet-\d+-[a-z0-9]+\.csv$/);
    expect(startInitialUserMessage).toHaveBeenCalledTimes(1);
    const enqueued = startInitialUserMessage.mock.calls[0][0];
    expect(enqueued.threadId).toBe('thread-1');
    expect(enqueued.message).toContain('see attached');
    expect(enqueued.message).toContain('(user uploaded file to uploads/sheet-');
  });

  it('retries busy Slack channel enqueue results as backpressure', async () => {
    const kv = createMockKV();
    const registry = slackInstallationRegistry();
    await kv.put('channel_thread:slack:ws-1:slack-int:t123:c123:dm', 'thread-1');

    const encrypted = await encryptCredentials(
      { access_token: 'xoxb-token', team_id: 'T123', bot_user_id: 'B123' },
      'secret',
    );
    const startInitialUserMessage = vi.fn(async () => ({ status: 'busy' }));
    const ack = vi.fn();
    const retry = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await handleSlackEventsQueue({
        messages: [
          {
            body: {
              payload: {
                type: 'event_callback',
                team_id: 'T123',
                event_id: 'EvBusy',
                event: {
                  type: 'message',
                  channel: 'C123',
                  channel_type: 'im',
                  user: 'U123',
                  ts: '1700000000.000102',
                  text: 'follow up',
                },
              },
              received_at: Date.now(),
            },
            attempts: 99,
            ack,
            retry,
          },
        ],
      } as never, {
        APP_KV: kv,
        SLACK_TEAM_REGISTRY: registry.namespace,
        INTEGRATION_SECRET_KEY: 'secret',
        ORG: createSlackOrgNamespace(encrypted),
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              integration_type: 'slack',
              credentials_encrypted: encrypted,
            })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never);
    } finally {
      warnSpy.mockRestore();
    }

    expect(startInitialUserMessage).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(ack).not.toHaveBeenCalled();
  });

  it('skips oversized Slack event files before downloading them', async () => {
    const kv = createMockKV();
    const registry = slackInstallationRegistry();
    await kv.put('channel_thread:slack:ws-1:slack-int:t123:c123:dm', 'thread-1');

    const encrypted = await encryptCredentials(
      { access_token: 'xoxb-token', team_id: 'T123', bot_user_id: 'B123' },
      'secret',
    );
    const r2Put = vi.fn(async () => undefined);
    const startInitialUserMessage = vi.fn(async () => ({ status: 'accepted' }));
    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    try {
      await processSlackEventCallback({
        APP_KV: kv,
        SLACK_TEAM_REGISTRY: registry.namespace,
        INTEGRATION_SECRET_KEY: 'secret',
        R2_BUCKET: { put: r2Put },
        ORG: createSlackOrgNamespace(encrypted),
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getInfo: vi.fn(async () => ({ id: 'ws-1', org_id: 'org-1', archived: false })),
            getIntegration: vi.fn(async () => ({
              integration_type: 'slack',
              credentials_encrypted: encrypted,
            })),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({ startInitialUserMessage })),
        },
      } as never, {
        type: 'event_callback',
        team_id: 'T123',
        event_id: 'EvOversizedFile',
        event: {
          type: 'message',
          subtype: 'file_share',
          channel: 'C123',
          channel_type: 'im',
          user: 'U123',
          ts: '1700000000.000103',
          text: 'large file',
          files: [
            {
              id: 'F999',
              name: 'large.zip',
              mimetype: 'application/zip',
              size: 26 * 1024 * 1024,
              url_private_download: 'https://files.slack.com/files-pri/T123-F999/download/large.zip',
            },
          ],
        },
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(r2Put).not.toHaveBeenCalled();
    expect(startInitialUserMessage).toHaveBeenCalledTimes(1);
    const enqueued = startInitialUserMessage.mock.calls[0][0];
    expect(enqueued.message).toContain('large file');
    expect(enqueued.message).not.toContain('(user uploaded file to ');
  });
});
