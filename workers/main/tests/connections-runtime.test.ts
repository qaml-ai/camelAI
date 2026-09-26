import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import {
  callConnectionTool,
  getConnection,
  findConnectionMethodEntry,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnectionTools,
  listConnections,
  readBoundedMcpResponseText,
  testConnectionMethodEntry,
  verifyConnection,
  type ConnectionsRuntimeEnv,
} from '../src/connections-runtime.js';
import type { WorkspaceIntegrationRecord } from '../src/workspace.js';
import { fakeDbQuerySandboxNamespace } from './fake-db-query-sandbox.js';

describe('bounded native MCP responses', () => {
  it('rejects declared and streamed oversized bodies before full materialization', async () => {
    const declared = new Response('small', { headers: { 'content-length': '100' } });
    await expect(readBoundedMcpResponseText(declared, 10)).rejects.toThrow(
      'Native MCP response exceeded 10 byte limit',
    );

    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123456'));
        controller.enqueue(new TextEncoder().encode('789012'));
        controller.close();
      },
    }));
    await expect(readBoundedMcpResponseText(streamed, 10)).rejects.toThrow(
      'Native MCP response exceeded 10 byte limit',
    );
  });
});

function integration(overrides: Partial<WorkspaceIntegrationRecord>): WorkspaceIntegrationRecord {
  return {
    id: 'int_1',
    integration_type: 'stripe',
    name: 'prod',
    category: 'payments',
    auth_method: 'api_key',
    config: '{}',
    credentials_encrypted: '',
    created_by: 'user_1',
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    token_expires_at: null,
    auth_status: 'connected',
    auth_error_code: null,
    auth_error_message: null,
    auth_checked_at: null,
    reauth_required_at: null,
    ...overrides,
  };
}

function envWith(
  records: WorkspaceIntegrationRecord[],
  onAuthStatus?: (id: string, status: string, code: string | null, message: string | null) => void,
  onVerification?: (id: string, verification: Record<string, unknown>) => void,
  overrides: Partial<ConnectionsRuntimeEnv> = {},
): ConnectionsRuntimeEnv {
  const orgStub = {
    getWorkspaceIntegrations: async () => records,
    getWorkspaceIntegration: async (_workspaceId: string, id: string) =>
      records.find((record) => record.id === id) ?? null,
    updateWorkspaceIntegrationAuthStatus: async (
      _workspaceId: string,
      id: string,
      status: string,
      code: string | null,
      message: string | null
    ) => {
      onAuthStatus?.(id, status, code, message);
    },
    updateWorkspaceIntegrationVerification: async (
      _workspaceId: string,
      id: string,
      verification: Record<string, unknown>,
    ) => {
      onVerification?.(id, verification);
      return true;
    },
  };
  return {
    INTEGRATION_SECRET_KEY: 'test-secret',
    ORG: {
      idFromName: (name: string) => name,
      get: () => orgStub,
    } as unknown as ConnectionsRuntimeEnv['ORG'],
    WORKSPACE: {
      idFromName: (name: string) => name,
      get: () => ({
        getIntegrations: async () => records,
        updateIntegrationAuthStatus: async (
          id: string,
          status: string,
          code: string | null,
          message: string | null
        ) => {
          onAuthStatus?.(id, status, code, message);
        },
      }),
    } as unknown as ConnectionsRuntimeEnv['WORKSPACE'],
    ...overrides,
  };
}

const context = {
  orgId: 'org_1',
  workspaceId: 'ws_1',
  userId: 'user_1',
};

async function encryptedCredentials(credentials: Record<string, unknown>): Promise<string> {
  return encryptCredentials(credentials, 'test-secret');
}

describe('connections runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('lists connected integrations with MCP capabilities', async () => {
    const records = [
      integration({ id: 'bq_prod', integration_type: 'bigquery', name: 'analytics', category: 'databases' }),
      integration({ id: 'stripe_prod', integration_type: 'stripe', name: 'prod' }),
      integration({ id: 'pg_main', integration_type: 'postgres', name: 'main', category: 'database' }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'bq_prod',
        type: 'bigquery',
        name: 'analytics',
        capabilities: ['query_database', 'mcp_tools'],
        nativeMcp: { serverName: 'bigquery', transport: 'streamable_http', directConnect: false },
      },
      {
        id: 'stripe_prod',
        type: 'stripe',
        name: 'prod',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'stripe',
          transport: 'streamable_http',
          directConnect: false,
          brokered: true,
          preferredMode: 'brokered',
          broker: {
            url: 'https://mcp.stripe.com',
            authStrategy: 'connected_credentials_broker',
          },
        },
      },
      {
        id: 'pg_main',
        type: 'postgres',
        name: 'main',
        capabilities: ['query_database', 'mcp_tools'],
        nativeMcp: { serverName: 'postgres', transport: 'streamable_http', directConnect: false },
      },
    ]);
  });

  it('treats Slack as a bot channel connection instead of a brokered MCP connection', async () => {
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ access_token: 'xoxb-token' }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'slack_workspace',
        type: 'slack',
        capabilities: ['channel_send', 'slack_api'],
        nativeMcp: null,
        recommendedActions: [
          {
            name: 'send_slack_message',
            tool: 'tools.send_slack_message',
          },
        ],
      },
    ]);
    const catalog = await listConnectionMethods(envWith(records), context);
    expect(catalog).toMatchObject([
      {
        alias: 'slackWorkspace',
        methods: expect.arrayContaining([
          expect.objectContaining({
            name: 'sendSlackMessage',
            tool: 'send_slack_message',
            invokeVia: 'tools.send_slack_message',
          }),
          expect.objectContaining({
            name: 'slackApi',
            tool: 'slack_api',
          }),
          expect.objectContaining({
            name: 'listSlackChannels',
            tool: 'list_slack_channels',
          }),
        ]),
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'slack_workspace'))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'slack_api' }),
        expect.objectContaining({ name: 'list_slack_channels' }),
        expect.objectContaining({ name: 'update_slack_message' }),
      ]));
  });

  it('invokes arbitrary Slack Web API methods with the connected bot token', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://slack.com/api/conversations.info');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer xoxb-token');
      expect(headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(JSON.parse(String(init?.body))).toEqual({ channel: 'C123' });
      return new Response(JSON.stringify({
        ok: true,
        channel: { id: 'C123', name: 'general' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ access_token: 'xoxb-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'slackWorkspace',
      method: 'slackApi',
      input: {
        method: 'conversations.info',
        params: { channel: 'C123' },
      },
    })).resolves.toEqual({
      ok: true,
      channel: { id: 'C123', name: 'general' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps common Slack helpers to bot-token Web API calls', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://slack.com/api/conversations.list');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-token');
      expect(JSON.parse(String(init?.body))).toEqual({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 2,
      });
      return new Response(JSON.stringify({
        ok: true,
        channels: [{ id: 'C123', name: 'general' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ access_token: 'xoxb-token' }),
      }),
    ];

    await expect(callConnectionTool(
      envWith(records),
      context,
      'slack_workspace',
      'list_slack_channels',
      { limit: 2 }
    )).resolves.toEqual({
      ok: true,
      channels: [{ id: 'C123', name: 'general' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces Slack Web API errors from bot-token calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ ok: false, error: 'missing_scope' }))
    )));
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ access_token: 'xoxb-token' }),
      }),
    ];

    await expect(callConnectionTool(
      envWith(records),
      context,
      'slack_workspace',
      'list_slack_users'
    )).rejects.toMatchObject({
      message: 'Slack API users.list failed: missing_scope',
      status: 400,
    });
  });

  it('requires ids when a connection query is ambiguous', async () => {
    const records = [
      integration({ id: 'stripe_prod', integration_type: 'stripe', name: 'prod' }),
      integration({ id: 'stripe_test', integration_type: 'stripe', name: 'test' }),
    ];

    await expect(getConnection(envWith(records), context, 'stripe')).rejects.toMatchObject({
      message: 'Multiple connected integrations matched "stripe". Retry with an integration id.',
      status: 409,
      matches: [
        { id: 'stripe_prod', type: 'stripe', name: 'prod' },
        { id: 'stripe_test', type: 'stripe', name: 'test' },
      ],
    });
  });

  it('surfaces reauth metadata for unhealthy connections', async () => {
    const records = [
      integration({
        id: 'notion_workspace',
        integration_type: 'notion',
        name: 'workspace',
        category: 'saas',
        auth_method: 'oauth2',
        auth_status: 'needs_reauth',
        auth_error_code: 'AUTH_REAUTH_REQUIRED',
        auth_error_message: 'Refresh token was revoked.',
        auth_checked_at: 1_700_000_000_000,
        reauth_required_at: 1_700_000_000_000,
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'notion_workspace',
        authStatus: 'needs_reauth',
        authErrorCode: 'AUTH_REAUTH_REQUIRED',
        authErrorMessage: 'Refresh token was revoked.',
        authCheckedAt: '2023-11-14T22:13:20.000Z',
        reauthRequiredAt: '2023-11-14T22:13:20.000Z',
        reauthUrl: '/api/integrations/notion/oauth?workspace_id=ws_1&integration_id=notion_workspace&redirect=%2Fconnections',
      },
    ]);
  });

  it('marks first-party MCP broker credentials stale when the provider returns 401', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') {
        return new Response('invalid_token', { status: 401 });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(
      listConnectionTools(envWith(records, (id, status, code, message) => {
        updates.push({ id, status, code, message });
      }), context, 'intercom_support')
    ).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/connections?connection=intercom_support&reauth=1',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'intercom_support',
        status: 'needs_reauth',
        code: 'AUTH_REAUTH_REQUIRED',
      },
    ]);
  });

  it('lists camelAI-hosted BigQuery MCP tools', async () => {
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project', dataset: 'warehouse' }),
      }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'bq_prod')).resolves.toMatchObject([
      { name: 'list_dataset_ids' },
      { name: 'get_dataset_info' },
      { name: 'list_table_ids' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
      { name: 'estimate_query' },
      { name: 'export' },
    ]);
  });

  it('connects to the no-auth Devin DeepWiki remote MCP server', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mcp.deepwiki.com/mcp');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('mcp-protocol-version')).toBe('2025-06-18');

      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'deepwiki' },
          },
        }), {
          headers: { 'mcp-session-id': 'deepwiki-session' },
        });
      }

      expect(headers.get('mcp-session-id')).toBe('deepwiki-session');
      expect(body.method).toBe('tools/list');
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            { name: 'read_wiki_structure' },
            { name: 'read_wiki_contents' },
            { name: 'ask_question' },
          ],
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'deepwiki',
        integration_type: 'remote_mcp',
        name: 'DeepWiki',
        category: 'saas',
        config: JSON.stringify({
          server_url: 'https://mcp.deepwiki.com/mcp',
          auth_type: 'none',
        }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'deepwiki',
        type: 'remote_mcp',
        name: 'DeepWiki',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'DeepWiki',
          transport: 'streamable_http',
          directConnect: false,
          brokered: true,
          authStrategy: 'remote_mcp_config',
          preferredMode: 'brokered',
          broker: {
            url: 'https://mcp.deepwiki.com/mcp',
            authStrategy: 'remote_mcp_config',
          },
        },
      },
    ]);

    await expect(listConnectionTools(envWith(records), context, 'deepwiki')).resolves.toEqual([
      { name: 'read_wiki_structure' },
      { name: 'read_wiki_contents' },
      { name: 'ask_question' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not intercept remote MCP tools named authenticated_fetch as native HTTP fetch', async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mcp.example.com/mcp');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);

      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'colliding-tools' },
          },
        }), {
          headers: { 'mcp-session-id': `session-${methods.length}` },
        });
      }

      expect(headers.get('mcp-session-id')).toMatch(/^session-/);
      if (body.method === 'tools/list') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'authenticated_fetch',
                description: 'A real MCP tool that happens to share camelAI fetch tool naming.',
              },
            ],
          },
        }));
      }

      expect(body.method).toBe('tools/call');
      expect(body.params).toEqual({
        name: 'authenticated_fetch',
        arguments: { input: '/from-mcp' },
      });
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ text: 'proxied through MCP' }] },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'remote_mcp_bridge',
        integration_type: 'remote_mcp',
        name: 'bridge',
        category: 'saas',
        config: JSON.stringify({
          server_url: 'https://mcp.example.com/mcp',
          auth_type: 'none',
        }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'remoteMcpBridge',
      method: 'authenticatedFetch',
      input: { input: '/from-mcp' },
    })).resolves.toEqual({
      content: [{ text: 'proxied through MCP' }],
    });
    expect(methods).toEqual(['initialize', 'tools/list', 'initialize', 'tools/call']);
  });

  it('times out stalled remote MCP HTTP calls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    ));
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'stalled_mcp',
        integration_type: 'remote_mcp',
        name: 'Stalled MCP',
        category: 'saas',
        config: JSON.stringify({
          server_url: 'https://mcp.example.com/mcp',
          auth_type: 'none',
        }),
      }),
    ];

    const result = expect(listConnectionTools(envWith(records), context, 'stalled_mcp'))
      .rejects.toMatchObject({
        message: 'Native MCP initialize request timed out after 15000ms',
        status: 504,
      });

    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });

  it('proxies an OAuth remote MCP connection with the stored access token', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mcp.example.com/mcp');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer oauth-access-token');

      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
          },
        }), {
          headers: { 'mcp-session-id': 'oauth-session' },
        });
      }

      expect(headers.get('mcp-session-id')).toBe('oauth-session');
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'search' }] },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'oauth_mcp',
        integration_type: 'remote_mcp',
        name: 'OAuth MCP',
        category: 'saas',
        config: JSON.stringify({
          server_url: 'https://mcp.example.com/mcp',
          auth_type: 'oauth',
        }),
        credentials_encrypted: await encryptedCredentials({
          access_token: 'oauth-access-token',
        }),
      }),
    ];

    await expect(getConnection(envWith(records), context, 'oauth_mcp')).resolves.toMatchObject({
      reauthUrl: null,
    });
    await expect(listConnectionTools(envWith(records), context, 'oauth_mcp')).resolves.toEqual([
      { name: 'search' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns the remote MCP OAuth reauth URL when OAuth credentials are missing', async () => {
    const statuses: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'oauth_mcp',
        integration_type: 'remote_mcp',
        name: 'OAuth MCP',
        category: 'saas',
        config: JSON.stringify({
          server_url: 'https://mcp.example.com/mcp',
          auth_type: 'oauth',
        }),
        credentials_encrypted: '',
        auth_status: 'setup_incomplete',
      }),
    ];

    await expect(listConnectionTools(
      envWith(records, (id, status, code, message) => statuses.push({ id, status, code, message })),
      context,
      'oauth_mcp'
    )).rejects.toMatchObject({
      status: 401,
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/api/integrations/remote_mcp/oauth?workspace_id=ws_1&integration_id=oauth_mcp&redirect=%2Fconnections',
      },
    });
    expect(statuses.at(-1)).toMatchObject(
      {
        id: 'oauth_mcp',
        status: 'needs_reauth',
        code: 'AUTH_REAUTH_REQUIRED',
      }
    );
  });

  it('lists method aliases for connection tools', async () => {
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project', dataset: 'warehouse' }),
      }),
    ];

    await expect(listConnectionMethods(envWith(records), context)).resolves.toMatchObject([
      {
        alias: 'bigqueryAnalytics',
        connection: { id: 'bq_prod', type: 'bigquery', name: 'analytics' },
        methods: [
          { name: 'query', tool: 'execute_sql_readonly', example: 'await connections.bigqueryAnalytics.query({ query: "SELECT 1 AS ok" })' },
          { name: 'listDatasetIds', tool: 'list_dataset_ids' },
          { name: 'getDatasetInfo', tool: 'get_dataset_info' },
          { name: 'listTableIds', tool: 'list_table_ids' },
          { name: 'getTableInfo', tool: 'get_table_info' },
          { name: 'executeSqlReadonly', tool: 'execute_sql_readonly' },
          { name: 'estimateQuery', tool: 'estimate_query' },
          { name: 'export', tool: 'export' },
          { name: 'executeQuery', tool: 'execute_sql_readonly' },
        ],
      },
    ]);
  });

  it('finds one method catalog entry by type and exposes copyable examples', async () => {
    const records = [
      integration({
        id: 'clickhouse_events',
        integration_type: 'clickhouse',
        name: 'events',
        category: 'databases',
        config: JSON.stringify({ host: 'clickhouse.example', port: 8443, database: 'default' }),
        credentials_encrypted: await encryptedCredentials({ username: 'default', password: 'secret' }),
      }),
    ];

    const entry = await findConnectionMethodEntry(envWith(records), context, { type: 'clickhouse' });

    expect(entry).toMatchObject({
      alias: 'clickhouseEvents',
      connection: { id: 'clickhouse_events', type: 'clickhouse' },
    });
    expect(entry.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'query',
        tool: 'execute_sql_readonly',
        example: 'await connections.clickhouseEvents.query({ query: "SELECT 1 AS ok" })',
      }),
    ]));
  });

  it('lists a fetch method for custom API connections', async () => {
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com/v1',
          auth_type: 'bearer',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(listConnectionMethods(envWith(records), context)).resolves.toMatchObject([
      {
        alias: 'otherCustomApi',
        connection: {
          id: 'custom_api',
          type: 'other',
          name: 'custom-api',
          capabilities: ['authenticated_fetch'],
        },
        methods: [
          {
            name: 'fetch',
            tool: 'authenticated_fetch',
            example: 'await connections.otherCustomApi.fetch("/v1/items", { method: "GET" })',
          },
        ],
      },
    ]);
  });

  it('lists a fetch method for native Resend connections', async () => {
    const records = [
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ api_key: 're_test' }),
      }),
    ];

    await expect(listConnectionMethods(envWith(records), context)).resolves.toMatchObject([
      {
        alias: 'resendTxn',
        connection: {
          id: 'resend_txn',
          type: 'resend',
          name: 'txn',
          capabilities: ['authenticated_fetch'],
          nativeMcp: null,
        },
        methods: [
          {
            name: 'fetch',
            tool: 'authenticated_fetch',
            example: 'await connections.resendTxn.fetch("/v1/items", { method: "GET" })',
          },
        ],
      },
    ]);
  });

  it('lists Telegram as a virtual channel action instead of raw authenticated fetch', async () => {
    const records = [
      integration({
        id: 'telegram_direct',
        integration_type: 'telegram',
        name: 'direct',
        category: 'communication',
        config: JSON.stringify({
          status: 'active',
          chat_id: '12345',
          chat_title: 'Miguel',
        }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'telegram_direct',
        type: 'telegram',
        capabilities: ['channel_send'],
        recommendedActions: [
          {
            name: 'send_telegram_message',
            tool: 'tools.send_telegram_message',
            usage: 'await tools.send_telegram_message({ integration_id: "telegram_direct", text: "Hello" })',
            routing: expect.stringContaining('Default Telegram recipient is configured'),
          },
        ],
        nativeMcp: null,
      },
    ]);
    const catalog = await listConnectionMethods(envWith(records), context);
    expect(catalog).toMatchObject([
      {
        alias: 'telegramDirect',
        connection: {
          id: 'telegram_direct',
          type: 'telegram',
          capabilities: ['channel_send'],
        },
        methods: [
          {
            name: 'sendTelegramMessage',
            tool: 'send_telegram_message',
            invokeVia: 'tools.send_telegram_message',
            example: 'await tools.send_telegram_message({ integration_id: "telegram_direct", text: "Hello" })',
          },
        ],
      },
    ]);
    expect(catalog[0]?.connection.capabilities).not.toContain('authenticated_fetch');
  });

  it('gives an actionable error if Telegram is invoked through the connections facade', async () => {
    const records = [
      integration({
        id: 'telegram_direct',
        integration_type: 'telegram',
        name: 'direct',
        category: 'communication',
        config: JSON.stringify({
          status: 'active',
          chat_id: '12345',
        }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'telegramDirect',
      method: 'sendTelegramMessage',
      input: { text: 'Hello' },
    })).rejects.toThrow(
      'Telegram send is available in js_exec as tools.send_telegram_message(...)'
    );
  });

  it('keeps native Discord bounded to its virtual channel send action', async () => {
    const records = [
      integration({
        id: 'discord_native',
        integration_type: 'discord_channel',
        name: 'product-support',
        category: 'communication',
        config: JSON.stringify({
          schema_version: 1,
          status: 'active',
          application_id: 'app-1',
          guild_id: 'guild-1',
          guild_name: 'Camel',
          parent_channel_id: 'channel-1',
          parent_channel_name: 'product-support',
          binding_version: 3,
          message_content_mode: 'full',
        }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'discord_native',
        type: 'discord_channel',
        capabilities: ['channel_send'],
        nativeMcp: null,
        recommendedActions: [
          {
            name: 'send_discord_message',
            tool: 'tools.send_discord_message',
            usage: 'await tools.send_discord_message({ integration_id: "discord_native", text: "Hello" })',
          },
        ],
      },
    ]);

    const catalog = await listConnectionMethods(envWith(records), context);
    expect(catalog).toMatchObject([
      {
        alias: 'discordChannelProductSupport',
        methods: [
          {
            name: 'sendDiscordMessage',
            tool: 'send_discord_message',
            invokeVia: 'tools.send_discord_message',
          },
        ],
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'discord_native'))
      .rejects.toMatchObject({
        message: 'Connection type "discord_channel" does not have MCP-backed tools.',
        status: 404,
      });
    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'discordChannelProductSupport',
      method: 'sendDiscordMessage',
      input: { text: 'Hello' },
    })).rejects.toThrow(
      'Discord send is available in js_exec as tools.send_discord_message(...)',
    );
  });

  it('invokes native Resend fetch methods with server-side auth and User-Agent', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.resend.com/emails');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer re_test');
      expect(headers.get('user-agent')).toBe('camelai-resend-connection/1.0');
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('host')).toBeNull();
      expect(JSON.parse(String(init?.body))).toEqual({
        from: 'Acme <onboarding@example.com>',
        to: ['customer@example.com'],
        subject: 'Welcome',
        html: '<p>Hello</p>',
      });
      return new Response(JSON.stringify({ id: 'email_123' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ api_key: 're_test' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'resendTxn',
      method: 'fetch',
      input: {
        input: '/emails',
        init: {
          method: 'POST',
          headers: {
            authorization: 'Bearer caller-token',
            'content-type': 'application/json',
            host: 'evil.example',
            'user-agent': 'caller-agent',
          },
          body: JSON.stringify({
            from: 'Acme <onboarding@example.com>',
            to: ['customer@example.com'],
            subject: 'Welcome',
            html: '<p>Hello</p>',
          }),
        },
      },
    })).resolves.toMatchObject({
      status: 200,
      bodyText: JSON.stringify({ id: 'email_123' }),
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks native Resend fetch setup incomplete when the API key is missing', async () => {
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({}),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status, code, message) => updates.push({ id, status, code, message })),
      context,
      {
        connection: 'resendTxn',
        method: 'fetch',
        input: { input: '/emails' },
      }
    )).rejects.toMatchObject({
      message: 'Resend connection "txn" requires api_key.',
      status: 400,
      code: 'AUTH_SETUP_INCOMPLETE',
      data: {
        authStatus: 'setup_incomplete',
        reauthUrl: '/connections?connection=resend_txn&reauth=1',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'resend_txn',
        status: 'setup_incomplete',
        code: 'AUTH_SETUP_INCOMPLETE',
        message: 'Resend connection "txn" requires api_key.',
      },
    ]);
  });

  it('invokes custom API fetch methods with stored auth', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v1/items?limit=2&tag=a&tag=b');
      expect(init?.method).toBe('POST');
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({
        authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({ active: true });
      return new Response(JSON.stringify({ items: [{ id: 1 }] }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com/v1',
          auth_type: 'bearer',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: 'items?limit=2&tag=a&tag=b',
        init: {
          method: 'POST',
          body: { active: true },
        },
      },
    })).resolves.toMatchObject({
      status: 201,
      bodyText: JSON.stringify({ items: [{ id: 1 }] }),
      truncated: false,
    });
  });

  it('allows native Resend fetches to absolute URLs on the Resend API origin', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.resend.com/domains');
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer re_test');
      return new Response('restricted_api_key', {
        status: 403,
        statusText: 'Forbidden',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ api_key: 're_test' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'resendTxn',
      method: 'fetch',
      input: {
        input: 'https://api.resend.com/domains',
      },
    })).resolves.toMatchObject({
      status: 403,
      statusText: 'Forbidden',
      bodyText: 'restricted_api_key',
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects native Resend fetches to non-Resend origins', async () => {
    const records = [
      integration({
        id: 'resend_txn',
        integration_type: 'resend',
        name: 'txn',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ api_key: 're_test' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'resendTxn',
      method: 'fetch',
      input: {
        input: 'https://api.example.com/emails',
      },
    })).rejects.toMatchObject({
      message: 'Resend fetch input must resolve to https://api.resend.com.',
      status: 400,
    });
  });

  it('allows custom API fetches to absolute http URLs for migration compatibility', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://uploads.example.net/items');
      expect(init?.method).toBe('GET');
      expect(Object.fromEntries(new Headers(init?.headers).entries())).toMatchObject({
        authorization: 'Bearer secret-token',
      });
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'bearer',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: 'https://uploads.example.net/items',
      },
    })).resolves.toMatchObject({
      status: 200,
      bodyText: 'ok',
    });
  });

  it('runs a database smoke test through the normalized query method', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://clickhouse.example:8443/?database=default&default_format=JSON&readonly=2');
      expect(String(init?.body)).toBe('SELECT 1 AS ok');
      return new Response(JSON.stringify({
        data: [{ ok: 1 }],
        rows: 1,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'clickhouse_events',
        integration_type: 'clickhouse',
        name: 'events',
        category: 'databases',
        config: JSON.stringify({ host: 'clickhouse.example', port: 8443, database: 'default' }),
        credentials_encrypted: await encryptedCredentials({ username: 'default', password: 'secret' }),
      }),
    ];

    await expect(testConnectionMethodEntry(envWith(records), context, 'clickhouse')).resolves.toMatchObject({
      ok: true,
      alias: 'clickhouseEvents',
      method: 'query',
      result: {
        content: [
          {
            text: JSON.stringify({
              data: [{ ok: 1 }],
              rows: 1,
            }, null, 2),
          },
        ],
      },
    });
  });

  it('persists an honest configuration-only verification for generic HTTP', async () => {
    const persisted = vi.fn();
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'none',
        }),
      }),
    ];

    await expect(verifyConnection(
      envWith(records, undefined, persisted),
      context,
      { id: 'custom_api' },
    )).resolves.toMatchObject({
      ok: true,
      status: 'configured',
      live: false,
      strategy: 'http_configuration',
      connection: {
        capabilities: ['authenticated_fetch'],
      },
    });
    expect(persisted).toHaveBeenCalledWith('custom_api', expect.objectContaining({
      status: 'configured',
      live: false,
      strategy: 'http_configuration',
    }));
  });

  it('records verification telemetry without credential or request data', async () => {
    const writeDataPoint = vi.fn();
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        config: JSON.stringify({
          base_url: 'https://api.example.com',
          auth_type: 'none',
        }),
      }),
    ];
    const env = envWith(records);
    env.OBSERVABILITY_EVENTS = { writeDataPoint } as never;

    await verifyConnection(env, context, 'custom_api');

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const point = writeDataPoint.mock.calls[0]![0] as { blobs: string[] };
    expect(point.blobs[0]).toBe('connection_verification');
    expect(point.blobs[4]).toBe('configured');
    expect(point.blobs[9]).toBe('ws_1');
    expect(point.blobs[10]).toBe('org_1');
    expect(point.blobs[13]).toBe('other');
    expect(JSON.stringify(point)).not.toContain('api.example.com');
  });

  it('records safe provider and error diagnostics for failed invocations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      new Response(JSON.stringify({ ok: false, error: 'sensitive-provider-detail' }))
    )));
    const observabilityWrite = vi.fn();
    const errorWrite = vi.fn();
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ access_token: 'xoxb-secret-token' }),
      }),
    ];
    const env = envWith(records);
    env.OBSERVABILITY_EVENTS = { writeDataPoint: observabilityWrite } as never;
    env.ERROR_ANALYTICS = { writeDataPoint: errorWrite } as never;

    await expect(invokeConnectionMethod(env, {
      ...context,
      threadId: 'thread_1',
      requestId: 'request_1',
    }, {
      connection: 'slackWorkspace',
      method: 'slackApi',
      input: {
        method: 'chat.postMessage',
        params: { text: 'private-chat-content' },
      },
    })).rejects.toMatchObject({ status: 400 });

    expect(observabilityWrite).toHaveBeenCalledTimes(1);
    expect(errorWrite).toHaveBeenCalledTimes(1);
    const point = observabilityWrite.mock.calls[0]![0] as {
      blobs: string[];
      doubles: number[];
    };
    expect(point.blobs[0]).toBe('connection_invocation');
    expect(point.blobs[1]).toBe('error');
    expect(point.blobs[3]).toBe('slackApi');
    expect(point.blobs[4]).toBe('error');
    expect(point.blobs[8]).toBe('thread_1');
    expect(point.blobs[9]).toBe('ws_1');
    expect(point.blobs[10]).toBe('org_1');
    expect(point.blobs[11]).toBe('user_1');
    expect(point.blobs[12]).toBe('request_1');
    expect(point.blobs[13]).toBe('slack');
    expect(point.blobs[15]).toBe('ConnectionRequestError');
    expect(point.blobs[16]).toBe('Connection invocation failed');
    expect(point.doubles[2]).toBe(400);

    const serializedPoints = JSON.stringify({
      observability: observabilityWrite.mock.calls,
      errors: errorWrite.mock.calls,
    });
    expect(serializedPoints).not.toContain('xoxb-secret-token');
    expect(serializedPoints).not.toContain('sensitive-provider-detail');
    expect(serializedPoints).not.toContain('private-chat-content');
  });

  it('performs a live Slack auth probe and records ready health', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://slack.com/api/auth.test');
      return new Response(JSON.stringify({ ok: true, team: 'Example' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const persisted = vi.fn();
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({ access_token: 'xoxb-token' }),
      }),
    ];

    await expect(verifyConnection(
      envWith(records, undefined, persisted),
      context,
      'slack_workspace',
    )).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      live: true,
      strategy: 'slack_auth',
      method: 'auth.test',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledWith('slack_workspace', expect.objectContaining({
      status: 'ready',
      live: true,
    }));
  });

  it('requires healthy Discord bridge ownership and ignores stale product versions', async () => {
    const applicationId = '123456789012345678';
    const records = [integration({
      id: 'discord_support',
      integration_type: 'discord_channel',
      name: 'support',
      category: 'communication',
      auth_method: 'oauth2',
      config: JSON.stringify({
        schema_version: 1,
        status: 'active',
        application_id: applicationId,
        guild_id: 'guild-1',
        guild_name: 'Camel',
        parent_channel_id: 'parent-1',
        parent_channel_name: 'support',
        bot_user_id: applicationId,
        binding_version: 7,
        message_content_mode: 'full',
      }),
    })];
    const bridgeFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/internal/v1/status') {
        return Response.json({
          ok: true,
          applicationId,
          botUserId: applicationId,
          readiness: { ready: true, status: 'ready', reason: 'ready', message: 'Bridge ready' },
          gateway: { state: 'ready', lastHeartbeatAckAt: Date.now() },
        });
      }
      return Response.json({
        ok: true,
        verification: {
          status: 'ready',
          message: 'Discord channel is ready',
          checkedAt: Date.now(),
          binding: {
            integrationId: 'discord_support',
            orgId: 'org_1',
            workspaceId: 'ws_1',
            guildId: 'guild-1',
            parentChannelId: 'parent-1',
            version: 7,
          },
        },
      });
    });
    const discordEnv = {
      DISCORD_CHANNEL_ENABLED: 'true',
      DISCORD_CLIENT_ID: applicationId,
      DISCORD_CLIENT_SECRET: 'test-discord-client-secret-value',
      DISCORD_BRIDGE: { fetch: bridgeFetch },
    } as Partial<ConnectionsRuntimeEnv>;

    await expect(verifyConnection(
      envWith(records, undefined, undefined, discordEnv),
      context,
      'discord_support',
    )).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      live: true,
      strategy: 'discord_channel_access',
    });

    const mismatchedBindingFetch = vi.fn(async (request: Request) => {
      const response = await bridgeFetch(request);
      if (new URL(request.url).pathname === '/internal/v1/status') return response;
      const body = await response.json() as {
        verification: { binding: { version: number } };
      };
      body.verification.binding.version = 8;
      return Response.json({ ok: true, ...body });
    });
    await expect(verifyConnection(
      envWith(records, undefined, undefined, {
        ...discordEnv,
        DISCORD_BRIDGE: { fetch: mismatchedBindingFetch },
      }),
      context,
      'discord_support',
    )).resolves.toMatchObject({
      ok: true,
      status: 'ready',
    });
  });

  it('degrades Discord when globally disabled or bridge health is stale', async () => {
    const applicationId = '123456789012345678';
    const records = [integration({
      id: 'discord_support',
      integration_type: 'discord_channel',
      name: 'support',
      category: 'communication',
      auth_method: 'oauth2',
      config: JSON.stringify({
        schema_version: 1,
        status: 'active',
        application_id: applicationId,
        guild_id: 'guild-1',
        guild_name: 'Camel',
        parent_channel_id: 'parent-1',
        parent_channel_name: 'support',
        bot_user_id: applicationId,
        binding_version: 7,
        message_content_mode: 'full',
      }),
    })];
    const darkFetch = vi.fn();
    await expect(verifyConnection(
      envWith(records, undefined, undefined, { DISCORD_BRIDGE: { fetch: darkFetch } }),
      context,
      'discord_support',
    )).resolves.toMatchObject({
      ok: false,
      status: 'degraded',
      message: expect.stringContaining('unavailable'),
    });
    expect(darkFetch).not.toHaveBeenCalled();

    const staleFetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === '/internal/v1/status') {
        return Response.json({
          ok: true,
          applicationId,
          botUserId: applicationId,
          readiness: {
            ready: false,
            status: 'degraded',
            reason: 'heartbeat_stale',
            message: 'Discord Gateway heartbeat acknowledgement is stale',
          },
          gateway: { state: 'ready', lastHeartbeatAckAt: 1 },
        });
      }
      return Response.json({
        ok: true,
        verification: { status: 'degraded', message: 'stale', binding: null },
      });
    });
    await expect(verifyConnection(
      envWith(records, undefined, undefined, {
        DISCORD_CHANNEL_ENABLED: 'true',
        DISCORD_CLIENT_ID: applicationId,
        DISCORD_CLIENT_SECRET: 'test-discord-client-secret-value',
        DISCORD_BRIDGE: { fetch: staleFetch },
      }),
      context,
      'discord_support',
    )).resolves.toMatchObject({
      ok: false,
      status: 'degraded',
      message: expect.stringContaining('stale'),
    });
  });

  it('verifies Databricks by listing warehouses without requiring a warehouse id', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://dbc.example.cloud.databricks.com/api/2.0/sql/warehouses');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer dapi-token');
      return new Response(JSON.stringify({ warehouses: [{ id: 'wh_123', name: 'Starter Warehouse' }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const persisted = vi.fn();
    const records = [
      integration({
        id: 'databricks_prod',
        integration_type: 'databricks',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ workspace_url: 'https://dbc.example.cloud.databricks.com' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'dapi-token' }),
      }),
    ];

    await expect(verifyConnection(
      envWith(records, undefined, persisted),
      context,
      'databricks_prod',
    )).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      live: true,
      strategy: 'mcp_discovery',
      method: 'list_sql_warehouses',
      connection: {
        capabilities: ['query_database', 'mcp_tools'],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveBeenCalledWith('databricks_prod', expect.objectContaining({
      status: 'ready',
      strategy: 'mcp_discovery',
    }));
  });

  it('normalizes known auth failures without attempting a provider call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'slack_workspace',
        integration_type: 'slack',
        name: 'workspace',
        category: 'communication',
        auth_status: 'needs_reauth',
        auth_error_message: 'Token expired',
      }),
    ];

    await expect(verifyConnection(envWith(records), context, 'slack_workspace'))
      .resolves.toMatchObject({
        ok: false,
        status: 'needs_authorization',
        message: 'Token expired',
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects custom API fetch URLs with embedded credentials', async () => {
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'none',
        }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: 'https://user:pass@example.net/items',
      },
    })).rejects.toMatchObject({
      message: 'fetch input must not include embedded credentials.',
      status: 400,
    });
  });

  it('defaults custom API auth to bearer when auth_type is omitted', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fallback-token');
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'fallback-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200, bodyText: 'ok' });
  });

  it('falls back to access_token then token for custom API bearer auth', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer oauth-access');
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'bearer' }),
        credentials_encrypted: await encryptedCredentials({ access_token: 'oauth-access', token: 'ignored' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('applies basic auth from client_id/client_secret for custom API connections', async () => {
    const expected = `Basic ${btoa('client-abc:secret-xyz')}`;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(expected);
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'basic' }),
        credentials_encrypted: await encryptedCredentials({ client_id: 'client-abc', client_secret: 'secret-xyz' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('applies basic auth from api_key/api_secret fallback for custom API connections', async () => {
    const expected = `Basic ${btoa('user-key:user-secret')}`;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(expected);
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'basic' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'user-key', api_secret: 'user-secret' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('applies a custom header for custom API header auth', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-acme-key')).toBe('header-token');
      expect(headers.get('authorization')).toBeNull();
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'header',
          auth_header: 'X-Acme-Key',
        }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'header-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('defaults header auth to X-API-Key when no header name is configured', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-api-key')).toBe('header-token');
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'header' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'header-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('does not send an authorization header for custom API none auth', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'none' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: { input: '/v1/items' },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('overrides any caller-supplied authorization header with the stored bearer token', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'bearer' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherCustomApi',
      method: 'fetch',
      input: {
        input: '/v1/items',
        init: { headers: { Authorization: 'Bearer attacker-supplied' } },
      },
    })).resolves.toMatchObject({ status: 200 });
  });

  it('marks custom API bearer auth setup incomplete when api_key is missing', async () => {
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'bearer' }),
        credentials_encrypted: await encryptedCredentials({}),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status, code, message) => updates.push({ id, status, code, message })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).rejects.toMatchObject({
      message: 'Custom API connection "custom-api" requires api_key for bearer auth.',
      status: 400,
      code: 'AUTH_SETUP_INCOMPLETE',
      data: {
        authStatus: 'setup_incomplete',
        reauthUrl: '/connections?connection=custom_api&reauth=1',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'custom_api',
        status: 'setup_incomplete',
        code: 'AUTH_SETUP_INCOMPLETE',
        message: 'Custom API connection "custom-api" requires api_key for bearer auth.',
      },
    ]);
  });

  it('marks custom API basic auth setup incomplete when the password is missing', async () => {
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'basic' }),
        credentials_encrypted: await encryptedCredentials({ client_id: 'client-abc' }),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status, code, message) => updates.push({ id, status, code, message })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).rejects.toMatchObject({
      status: 400,
      code: 'AUTH_SETUP_INCOMPLETE',
      data: { authStatus: 'setup_incomplete' },
    });
    expect(updates).toMatchObject([
      { id: 'custom_api', status: 'setup_incomplete', code: 'AUTH_SETUP_INCOMPLETE' },
    ]);
  });

  it('marks custom API header auth setup incomplete when api_key is missing', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({
          display_name: 'Custom API',
          base_url: 'https://api.example.com',
          auth_type: 'header',
          auth_header: 'X-Acme-Key',
        }),
        credentials_encrypted: await encryptedCredentials({}),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status) => updates.push({ id, status })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).rejects.toMatchObject({
      status: 400,
      code: 'AUTH_SETUP_INCOMPLETE',
    });
    expect(updates).toMatchObject([{ id: 'custom_api', status: 'setup_incomplete' }]);
  });

  it('rejects unsupported custom API auth_type without marking setup incomplete', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'oauth2' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status) => updates.push({ id, status })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).rejects.toMatchObject({
      message: 'Unsupported custom API auth_type: oauth2',
      status: 400,
    });
    expect(updates).toEqual([]);
  });

  it('clears a stale setup_incomplete status after a successful custom API fetch', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        // Previously flagged as incomplete; user has since switched to auth_type none.
        auth_status: 'setup_incomplete',
        auth_error_code: 'AUTH_SETUP_INCOMPLETE',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'none' }),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status) => updates.push({ id, status })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).resolves.toMatchObject({ status: 200, bodyText: 'ok' });
    expect(updates).toMatchObject([{ id: 'custom_api', status: 'connected' }]);
  });

  it('does not rewrite auth status when an already connected custom API fetch succeeds', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        auth_status: 'connected',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'bearer' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status) => updates.push({ id, status })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).resolves.toMatchObject({ status: 200 });
    expect(updates).toEqual([]);
  });

  it('does not clear a stale status when the upstream rejects the custom API auth', async () => {
    const updates: Array<{ id: string; status: string }> = [];
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'custom_api',
        integration_type: 'other',
        name: 'custom-api',
        category: 'saas',
        auth_status: 'setup_incomplete',
        config: JSON.stringify({ display_name: 'Custom API', base_url: 'https://api.example.com', auth_type: 'none' }),
      }),
    ];

    await expect(invokeConnectionMethod(
      envWith(records, (id, status) => updates.push({ id, status })),
      context,
      { connection: 'otherCustomApi', method: 'fetch', input: { input: '/v1/items' } }
    )).resolves.toMatchObject({ status: 403 });
    expect(updates).toEqual([]);
  });

  it('marks Notion as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'notion_workspace',
        integration_type: 'notion',
        name: 'workspace',
        category: 'saas',
        auth_method: 'oauth2',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'notion_workspace',
        type: 'notion',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'notion',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
          broker: {
          },
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'notion_workspace')).rejects.toMatchObject({
      message: 'Connected notion integration does not have a usable token credential for MCP proxying.',
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/api/integrations/notion/oauth?workspace_id=ws_1&integration_id=notion_workspace&redirect=%2Fconnections',
      },
    });
  });

  it('marks Cloudflare as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'cf_account',
        integration_type: 'cloudflare',
        name: 'account',
        category: 'cloud_providers',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'cf_account',
        type: 'cloudflare',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'cloudflare',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'cf_account')).rejects.toMatchObject({
      message: 'Connected cloudflare integration does not have a usable token credential for MCP proxying.',
      status: 400,
    });
  });

  it('marks Salesforce as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'salesforce_prod',
        integration_type: 'salesforce',
        name: 'prod',
        category: 'saas',
        auth_method: 'oauth2',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'salesforce_prod',
        type: 'salesforce',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'salesforce',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'salesforce_prod')).rejects.toMatchObject({
      message: 'Connected salesforce integration does not have a usable token credential for MCP proxying.',
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
    });
  });

  it('marks Supabase as first-party remote MCP brokered by camelAI', async () => {
    const records = [
      integration({
        id: 'supabase_main',
        integration_type: 'supabase',
        name: 'main',
        category: 'databases',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'supabase_main',
        type: 'supabase',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'supabase',
          transport: 'streamable_http',
          directConnect: false,
          brokered: true,
          authStrategy: 'connected_credentials_broker',
          preferredMode: 'brokered',
        },
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'supabase_main')).rejects.toMatchObject({
      message: 'Connected supabase integration does not have a usable token credential for MCP proxying.',
      status: 400,
    });
  });

  it('does not advertise Square MCP until SSE transport is supported', async () => {
    const records = [
      integration({
        id: 'square_prod',
        integration_type: 'square',
        name: 'prod',
        category: 'saas',
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'square_prod',
        type: 'square',
        capabilities: ['project_credentials'],
        nativeMcp: null,
      },
    ]);
    await expect(listConnectionTools(envWith(records), context, 'square_prod')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('supports both direct Intercom MCP metadata and brokered tools through connected credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(url)).toBe('https://mcp.intercom.com/mcp');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer intercom-token',
        accept: 'application/json, text/event-stream',
      });
      expect(body).toMatchObject({ jsonrpc: '2.0' });
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: body.method === 'tools/list'
          ? { tools: [{ name: 'search' }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'intercom' },
            },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'intercom_support',
        type: 'intercom',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'intercom',
          directConnect: false,
          brokered: true,
          preferredMode: 'brokered',
          broker: {
            url: 'https://mcp.intercom.com/mcp',
            authStrategy: 'connected_credentials_broker',
          },
        },
      },
    ]);

    const tools = await listConnectionTools(envWith(records), context, 'intercom_support');
    expect(tools).toMatchObject([{ name: 'search' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/list',
    });
  });

  it('invokes connection tools by method alias', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'search_conversations', inputSchema: { type: 'object' } }] }
        : body.method === 'tools/call'
          ? { results: [{ id: 'conv_1' }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'intercom' },
            };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'intercomSupport',
      method: 'searchConversations',
      input: { query: 'refund' },
    })).resolves.toEqual({ results: [{ id: 'conv_1' }] });

    const toolCall = fetchMock.mock.calls
      .map((call) => JSON.parse(String(call[1]?.body)))
      .find((body) => body.method === 'tools/call');
    expect(toolCall).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'search_conversations',
        arguments: { query: 'refund' },
      },
    });
  });

  it('surfaces discovery auth errors before method lookup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('invalid token', { status: 401 })
    ));
    const records = [
      integration({
        id: 'intercom_support',
        integration_type: 'intercom',
        name: 'support',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'intercom-token' }),
      }),
    ];

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'intercomSupport',
      method: 'searchConversations',
      input: { query: 'refund' },
    })).rejects.toMatchObject({
      message: 'Native MCP request failed with HTTP 401',
      status: 401,
      code: 'AUTH_REAUTH_REQUIRED',
      data: {
        authStatus: 'needs_reauth',
        reauthUrl: '/connections?connection=intercom_support&reauth=1',
      },
    });
  });

  it('supports both direct Typeform MCP metadata and brokered tools through connected credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(url)).toBe('https://api.typeform.com/mcp');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer typeform-token',
        accept: 'application/json, text/event-stream',
      });
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: body.method === 'tools/list'
          ? { tools: [{ name: 'forms_list' }] }
          : {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'typeform' },
            },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'typeform_forms',
        integration_type: 'typeform',
        name: 'forms',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'typeform-token' }),
      }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      {
        id: 'typeform_forms',
        type: 'typeform',
        capabilities: ['mcp_tools'],
        nativeMcp: {
          serverName: 'typeform',
          directConnect: false,
          brokered: true,
          preferredMode: 'brokered',
          broker: {
            url: 'https://api.typeform.com/mcp',
            authStrategy: 'connected_credentials_broker',
          },
        },
      },
    ]);

    const tools = await listConnectionTools(envWith(records), context, 'typeform_forms');
    expect(tools).toMatchObject([{ name: 'forms_list' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses multi-event SSE responses from first-party MCP servers', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const result = body.method === 'tools/list'
        ? { tools: [{ name: 'forms_list' }] }
        : {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'typeform' },
          };
      return new Response(
        [
          'event: progress',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: `progress-${body.id}`, result: { ok: true } })}`,
          '',
          'event: message',
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}`,
          '',
          'event: done',
          'data: [DONE]',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'typeform_forms',
        integration_type: 'typeform',
        name: 'forms',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'typeform-token' }),
      }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'typeform_forms')).resolves.toMatchObject([
      { name: 'forms_list' },
    ]);
  });

  it('lists camelAI-hosted Sentry MCP tools', async () => {
    const records = [
      integration({
        id: 'sentry_prod',
        integration_type: 'sentry',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ organization: 'acme' }),
      }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'sentry_prod')).resolves.toMatchObject([
      { name: 'list_organizations' },
      { name: 'list_projects' },
      { name: 'search_issues' },
      { name: 'get_issue' },
      { name: 'list_issue_events' },
    ]);
  });

  it('searches Sentry issues through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://sentry.io/api/0/organizations/acme/issues/?limit=5&query=is%3Aunresolved');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer sentry-token',
      });
      return new Response(JSON.stringify([{ id: '123', title: 'Boom', status: 'unresolved' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'sentry_prod',
        integration_type: 'sentry',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ organization: 'acme' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'sentry-token' }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'sentry_prod', 'search_issues', {
      query: 'is:unresolved',
      limit: 5,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      { id: '123', title: 'Boom', status: 'unresolved' },
    ]);
  });

  it('queries Airtable records through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.airtable.com/v0/app123/Tasks?maxRecords=2&view=Open');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer airtable-token',
      });
      return new Response(JSON.stringify({
        records: [
          { id: 'rec1', fields: { Title: 'Fix bug' } },
        ],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'airtable_main',
        integration_type: 'airtable',
        name: 'main',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'airtable-token' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'airtable_main');
    expect(tools).toMatchObject([
      { name: 'list_bases' },
      { name: 'list_tables' },
      { name: 'query_records' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'airtable_main', 'query_records', {
      baseId: 'app123',
      table: 'Tasks',
      view: 'Open',
      maxRecords: 2,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      records: [{ id: 'rec1', fields: { Title: 'Fix bug' } }],
    });
  });

  it('marks hosted MCP setup failures as setup incomplete', async () => {
    const updates: Array<{ id: string; status: string; code: string | null; message: string | null }> = [];
    const records = [
      integration({
        id: 'mongo_prod',
        integration_type: 'mongodb',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ database: 'app', data_source: 'Cluster0' }),
        credentials_encrypted: await encryptedCredentials({ data_api_key: 'mongo-data-key' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records, (id, status, code, message) => {
      updates.push({ id, status, code, message });
    }), context, 'mongo_prod', 'find_documents', {
      collection: 'users',
    })).rejects.toMatchObject({
      status: 400,
      code: 'AUTH_SETUP_INCOMPLETE',
      data: {
        authStatus: 'setup_incomplete',
        reauthUrl: '/connections?connection=mongo_prod&reauth=1',
      },
    });
    expect(updates).toMatchObject([
      {
        id: 'mongo_prod',
        status: 'setup_incomplete',
        code: 'AUTH_SETUP_INCOMPLETE',
      },
    ]);
  });

  it('searches Zendesk tickets through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://acme.zendesk.com/api/v2/search.json');
      expect(target.searchParams.get('query')).toBe('type:ticket status:open');
      expect(target.searchParams.get('per_page')).toBe('2');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('agent@example.com/token:zendesk-token')}`,
      });
      return new Response(JSON.stringify({
        results: [{ id: 123, subject: 'Need help' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'zendesk_support',
        integration_type: 'zendesk',
        name: 'support',
        category: 'saas',
        config: JSON.stringify({ subdomain: 'acme' }),
        credentials_encrypted: await encryptedCredentials({
          email: 'agent@example.com',
          api_key: 'zendesk-token',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'zendesk_support');
    expect(tools).toMatchObject([
      { name: 'search_tickets' },
      { name: 'get_ticket' },
      { name: 'list_ticket_comments' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'zendesk_support', 'search_tickets', {
      query: 'status:open',
      limit: 2,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      results: [{ id: 123, subject: 'Need help' }],
    });
  });

  it('lists Mailchimp campaigns through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://us21.api.mailchimp.com/3.0/campaigns');
      expect(target.searchParams.get('count')).toBe('3');
      expect(target.searchParams.get('list_id')).toBe('aud_123');
      expect(target.searchParams.get('status')).toBe('sent');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('camelai:mailchimp-key-us21')}`,
      });
      return new Response(JSON.stringify({
        campaigns: [{ id: 'cmp_1', status: 'sent' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'mailchimp_marketing',
        integration_type: 'mailchimp',
        name: 'marketing',
        category: 'saas',
        config: JSON.stringify({ data_center: 'us21' }),
        credentials_encrypted: await encryptedCredentials({
          api_key: 'mailchimp-key-us21',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'mailchimp_marketing');
    expect(tools).toMatchObject([
      { name: 'list_audiences' },
      { name: 'get_audience' },
      { name: 'list_campaigns' },
      { name: 'get_campaign' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'mailchimp_marketing', 'list_campaigns', {
      listId: 'aud_123',
      status: 'sent',
      limit: 3,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      campaigns: [{ id: 'cmp_1', status: 'sent' }],
    });
  });

  it('lists SendGrid templates through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://api.sendgrid.com/v3/templates');
      expect(target.searchParams.get('generations')).toBe('dynamic');
      expect(target.searchParams.get('page_size')).toBe('4');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer sendgrid-token',
      });
      return new Response(JSON.stringify({
        templates: [{ id: 'd-template_1', name: 'Welcome' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'sendgrid_txn',
        integration_type: 'sendgrid',
        name: 'transactional',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({
          api_key: 'sendgrid-token',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'sendgrid_txn');
    expect(tools).toMatchObject([
      { name: 'list_sender_identities' },
      { name: 'list_templates' },
      { name: 'get_template' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'sendgrid_txn', 'list_templates', {
      limit: 4,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      templates: [{ id: 'd-template_1', name: 'Welcome' }],
    });
  });

  it('lists Twilio messages through the platform broker', async () => {
    const accountSid = 'AC00000000000000000000000000000000';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`);
      expect(target.searchParams.get('PageSize')).toBe('2');
      expect(target.searchParams.get('To')).toBe('+15551234567');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa(`${accountSid}:twilio-token`)}`,
      });
      return new Response(JSON.stringify({
        messages: [{ sid: 'SM0123456789abcdef0123456789abcdef', status: 'delivered' }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'twilio_sms',
        integration_type: 'twilio',
        name: 'sms',
        category: 'communication',
        credentials_encrypted: await encryptedCredentials({
          account_sid: accountSid,
          auth_token: 'twilio-token',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'twilio_sms');
    expect(tools).toMatchObject([
      { name: 'list_messages' },
      { name: 'get_message' },
      { name: 'list_calls' },
      { name: 'get_call' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'twilio_sms', 'list_messages', {
      to: '+15551234567',
      limit: 2,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      messages: [{ sid: 'SM0123456789abcdef0123456789abcdef', status: 'delivered' }],
    });
  });

  it('executes read-only PostHog HogQL through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://us.posthog.com/api/projects/123/query/');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer phx-token',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        query: {
          kind: 'HogQLQuery',
          query: 'select event, count() from events group by event',
        },
      });
      return new Response(JSON.stringify({ results: [['$pageview', 12]] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'posthog_prod',
        integration_type: 'posthog',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ host: 'https://us.posthog.com', project_id: '123' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'phx-token' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'posthog_prod');
    expect(tools).toMatchObject([
      { name: 'list_projects' },
      { name: 'list_feature_flags' },
      { name: 'list_insights' },
      { name: 'execute_hogql_readonly' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'posthog_prod', 'execute_hogql_readonly', {
      query: 'select event, count() from events group by event',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ results: [['$pageview', 12]] });
  });

  it('executes read-only ClickHouse SQL through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://clickhouse.example:8443/?database=default&default_format=JSON&readonly=2');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('default:secret')}`,
      });
      expect(String(init?.body)).toBe('SELECT event, count() FROM events GROUP BY event');
      return new Response(JSON.stringify({
        data: [{ event: 'pageview', count: 12 }],
        rows: 1,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'clickhouse_events',
        integration_type: 'clickhouse',
        name: 'events',
        category: 'databases',
        config: JSON.stringify({ host: 'clickhouse.example', port: 8443, database: 'default' }),
        credentials_encrypted: await encryptedCredentials({ username: 'default', password: 'secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'clickhouse_events');
    expect(tools).toMatchObject([
      { name: 'list_databases' },
      { name: 'list_tables' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
      { name: 'export' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'clickhouse_events', 'execute_sql_readonly', {
      query: 'SELECT event, count() FROM events GROUP BY event',
      limit: 10,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      data: [{ event: 'pageview', count: 12 }],
      rows: 1,
    });
  });

  it('executes read-only Postgres SQL through the db-query sandbox MCP broker', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request).toMatchObject({
        engine: 'postgres',
        mode: 'read',
        sql: 'select id, email from users',
        params: [],
        target: {
          host: 'db.example.com',
          port: 5432,
          user: 'app',
          password: 'secret',
          database: 'appdb',
          sslMode: 'require',
        },
      });
      return { ok: true, rows: [{ id: 1, email: 'ada@example.com' }], fields: [{ name: 'id' }, { name: 'email' }], rowCount: 1, truncated: false, durationMs: 2 };
    });
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({
          host: 'db.example.com',
          port: 5432,
          database: 'appdb',
          schema: 'public',
          ssl_mode: 'require',
        }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'pg_main');
    expect(tools).toMatchObject([
      { name: 'list_schemas' },
      { name: 'list_tables' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
      { name: 'export' },
    ]);

    const result = await callConnectionTool({
      ...envWith(records),
      DB_QUERY_SANDBOX: fake.namespace as never,
    }, context, 'pg_main', 'execute_sql_readonly', {
      query: 'select id, email from users',
      limit: 25,
    }) as { content: Array<{ text: string }> };

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ id: 1, email: 'ada@example.com' }],
      rowsAffected: [],
    });
  });

  it('does not append a default SQL LIMIT when the query has a parameterized LIMIT', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request).toMatchObject({
        sql: 'select id from users LIMIT $1',
        params: [5],
      });
      return { ok: true, rows: [{ id: 1 }], fields: [{ name: 'id' }], rowCount: 1, truncated: false, durationMs: 2 };
    });
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({ host: 'db.example.com', database: 'appdb' }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    await expect(callConnectionTool({
      ...envWith(records),
      DB_QUERY_SANDBOX: fake.namespace as never,
    }, context, 'pg_main', 'execute_sql_readonly', {
      query: 'select id from users LIMIT $1',
      params: [5],
      limit: 25,
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
    expect(fake.calls).toHaveLength(1);
  });

  it('lists MySQL table metadata through the db-query sandbox MCP broker', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request).toMatchObject({
        engine: 'mysql',
        mode: 'read',
        params: ['appdb', 'users'],
        target: {
          host: 'mysql.example.com',
          user: 'app',
          password: 'secret',
          database: 'appdb',
        },
      });
      return { ok: true, rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }], fields: [], rowCount: 1, truncated: false, durationMs: 2 };
    });
    const records = [
      integration({
        id: 'mysql_main',
        integration_type: 'mysql',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({
          host: 'mysql.example.com',
          database: 'appdb',
        }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    const result = await callConnectionTool({
      ...envWith(records),
      DB_QUERY_SANDBOX: fake.namespace as never,
    }, context, 'mysql_main', 'get_table_info', {
      table: 'users',
    }) as { content: Array<{ text: string }> };

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }],
      rowsAffected: [],
    });
  });

  it('executes read-only Neon SQL through the Postgres db-query sandbox MCP broker', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request).toMatchObject({
        engine: 'postgres',
        mode: 'read',
        sql: 'select now()',
        params: [],
        target: {
          host: 'ep-example.us-east-2.aws.neon.tech',
          user: 'app',
          password: 'secret',
          database: 'neondb',
          sslMode: 'require',
        },
      });
      return { ok: true, rows: [{ now: '2026-05-08T00:00:00Z' }], fields: [{ name: 'now' }], rowCount: 1, truncated: false, durationMs: 2 };
    });
    const records = [
      integration({
        id: 'neon_main',
        integration_type: 'neon',
        name: 'main',
        category: 'databases',
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'postgresql://app:secret@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require',
        }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'neon_main');
    expect(tools).toMatchObject([
      { name: 'list_schemas' },
      { name: 'list_tables' },
      { name: 'get_table_info' },
      { name: 'execute_sql_readonly' },
      { name: 'export' },
    ]);

    const result = await callConnectionTool({
      ...envWith(records),
      DB_QUERY_SANDBOX: fake.namespace as never,
    }, context, 'neon_main', 'execute_sql_readonly', {
      query: 'select now()',
      limit: 5,
    }) as { content: Array<{ text: string }> };

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ now: '2026-05-08T00:00:00Z' }],
      rowsAffected: [],
    });
  });

  it('executes read-only PlanetScale SQL through the MySQL db-query sandbox MCP broker', async () => {
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request).toMatchObject({
        engine: 'mysql',
        mode: 'read',
        sql: 'select id from users',
        params: [],
        target: {
          host: 'aws.connect.psdb.cloud',
          user: 'svc',
          password: 'secret',
          database: 'appdb',
          // Legacy tls: 'true' (go-sql-driver full verification) maps to verify-full.
          sslMode: 'verify-full',
        },
      });
      return { ok: true, rows: [{ id: 1 }], fields: [{ name: 'id' }], rowCount: 1, truncated: false, durationMs: 2 };
    });
    const records = [
      integration({
        id: 'planetscale_main',
        integration_type: 'planetscale',
        name: 'main',
        category: 'databases',
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'mysql://svc:secret@aws.connect.psdb.cloud/appdb?sslaccept=strict',
        }),
      }),
    ];

    const result = await callConnectionTool({
      ...envWith(records),
      DB_QUERY_SANDBOX: fake.namespace as never,
    }, context, 'planetscale_main', 'execute_sql_readonly', {
      query: 'select id from users',
      limit: 3,
    }) as { content: Array<{ text: string }> };

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [{ id: 1 }],
      rowsAffected: [],
    });
  });

  it('forwards SQL database MCP queries without keyword filtering', async () => {
    // The MCP does no keyword filtering: the statement is forwarded verbatim
    // in read mode — the runner's rolled-back transaction is the safety net.
    const fake = fakeDbQuerySandboxNamespace((request) => {
      expect(request).toMatchObject({
        mode: 'read',
        sql: 'delete from users',
      });
      return { ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 2 };
    });
    const records = [
      integration({
        id: 'pg_main',
        integration_type: 'postgres',
        name: 'main',
        category: 'databases',
        config: JSON.stringify({ host: 'db.example.com', database: 'appdb' }),
        credentials_encrypted: await encryptedCredentials({ username: 'app', password: 'secret' }),
      }),
    ];

    const result = await callConnectionTool({
      ...envWith(records),
      DB_QUERY_SANDBOX: fake.namespace as never,
    }, context, 'pg_main', 'execute_sql_readonly', {
      query: 'delete from users',
    }) as { content: Array<{ text: string }> };

    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      rows: [],
      rowsAffected: [],
    });
  });

  it('queries Mixpanel top events through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://mixpanel.com/api/2.0/events/top?project_id=1234567&from_date=2026-05-01&to_date=2026-05-08&limit=3');
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('svc-user:svc-secret')}`,
      });
      return new Response(JSON.stringify({ events: [{ event: 'Signup', count: 42 }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'mixpanel_prod',
        integration_type: 'mixpanel',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ project_id: '1234567', region: 'us' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'svc-user', api_secret: 'svc-secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'mixpanel_prod');
    expect(tools).toMatchObject([
      { name: 'top_events' },
      { name: 'event_properties' },
      { name: 'query_jql_readonly' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'mixpanel_prod', 'top_events', {
      fromDate: '2026-05-01',
      toDate: '2026-05-08',
      limit: 3,
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ events: [{ event: 'Signup', count: 42 }] });
  });

  it('queries Amplitude event segmentation through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(`${target.origin}${target.pathname}`).toBe('https://amplitude.com/api/2/events/segmentation');
      expect(target.searchParams.get('start')).toBe('20260501');
      expect(target.searchParams.get('end')).toBe('20260508');
      expect(JSON.parse(target.searchParams.get('e') || '{}')).toEqual({ event_type: 'Signup' });
      expect(init?.headers).toMatchObject({
        authorization: `Basic ${btoa('amp-key:amp-secret')}`,
      });
      return new Response(JSON.stringify({ data: { series: [1, 2, 3] } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'amplitude_prod',
        integration_type: 'amplitude',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ region: 'us' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'amp-key', api_secret: 'amp-secret' }),
      }),
    ];

    const tools = await listConnectionTools(envWith(records), context, 'amplitude_prod');
    expect(tools).toMatchObject([
      { name: 'list_events' },
      { name: 'list_event_properties' },
      { name: 'query_events_segmentation' },
    ]);

    const result = await callConnectionTool(envWith(records), context, 'amplitude_prod', 'query_events_segmentation', {
      eventType: 'Signup',
      start: '20260501',
      end: '20260508',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ data: { series: [1, 2, 3] } });
  });

  it('executes BigQuery read-only SQL through the platform broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/jobs')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          configuration: {
            dryRun: true,
            query: {
              query: 'select name, active from users',
              useLegacySql: false,
              defaultDataset: { projectId: 'demo-project', datasetId: 'warehouse' },
              maximumBytesBilled: '1000000000',
            },
          },
        });
        return new Response(JSON.stringify({
          statistics: {
            query: {
              totalBytesProcessed: '42',
              totalBytesBilled: '0',
              cacheHit: false,
              statementType: 'SELECT',
            },
          },
        }));
      }
      if (target.endsWith('/queries')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          query: 'select name, active from users',
          useLegacySql: false,
          maxResults: 100,
          timeoutMs: 30000,
        });
        return new Response(JSON.stringify({
          jobComplete: true,
          totalRows: '1',
          schema: {
            fields: [
              { name: 'name', type: 'STRING' },
              { name: 'active', type: 'BOOL' },
            ],
          },
          rows: [{ f: [{ v: 'Ada' }, { v: 'true' }] }],
        }));
      }
      return new Response(JSON.stringify({ error: { message: `unexpected URL ${target}` } }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project', dataset: 'warehouse' }),
        credentials_encrypted: await encryptedCredentials({
          access_token: 'bq-access-token',
          expires_at: Date.now() + 3600_000,
        }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'bq_prod', 'execute_sql_readonly', {
      query: 'select name, active from users',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      projectId: 'demo-project',
      datasetId: 'warehouse',
      totalRows: '1',
      totalBytesProcessed: '42',
      rows: [{ name: 'Ada', active: true }],
    });
  });

  it('forwards BigQuery SQL without keyword filtering', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const body = JSON.parse(String(init?.body));
      if (target.endsWith('/projects/demo-project/jobs')) {
        expect(body.configuration.query.query).toBe('delete from warehouse.users where true');
        return new Response(JSON.stringify({
          statistics: { query: { totalBytesProcessed: '12', totalBytesBilled: '0', statementType: 'SELECT' } },
        }));
      }
      if (target.endsWith('/projects/demo-project/queries')) {
        expect(body.query).toBe('delete from warehouse.users where true');
        return new Response(JSON.stringify({
          jobComplete: true,
          totalRows: '0',
          schema: { fields: [] },
          rows: [],
        }));
      }
      return new Response(JSON.stringify({ error: { message: `unexpected URL ${target}` } }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const records = [
      integration({
        id: 'bq_prod',
        integration_type: 'bigquery',
        name: 'analytics',
        category: 'databases',
        config: JSON.stringify({ project_id: 'demo-project' }),
        credentials_encrypted: await encryptedCredentials({
          access_token: 'bq-access-token',
          expires_at: Date.now() + 3600_000,
        }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'bq_prod', 'execute_sql_readonly', {
      query: 'delete from warehouse.users where true',
    }) as { content: Array<{ text: string }> };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      projectId: 'demo-project',
      totalRows: '0',
    });
  });

  it('lists MCP tools for the new hosted broker batch', async () => {
    const records = [
      integration({ id: 'snowflake_prod', integration_type: 'snowflake', name: 'prod', category: 'databases' }),
      integration({ id: 'mongo_prod', integration_type: 'mongodb', name: 'prod', category: 'databases' }),
      integration({ id: 'redis_prod', integration_type: 'redis', name: 'prod', category: 'databases' }),
      integration({ id: 'turso_prod', integration_type: 'turso', name: 'prod', category: 'databases' }),
      integration({ id: 'databricks_prod', integration_type: 'databricks', name: 'prod', category: 'databases' }),
      integration({ id: 'shopify_prod', integration_type: 'shopify', name: 'prod', category: 'saas' }),
      integration({ id: 'segment_prod', integration_type: 'segment', name: 'prod', category: 'saas' }),
      integration({ id: 'teams_prod', integration_type: 'teams', name: 'prod', category: 'communication' }),
    ];

    await expect(listConnections(envWith(records), context)).resolves.toMatchObject([
      { id: 'snowflake_prod', capabilities: ['query_database', 'mcp_tools'], nativeMcp: { serverName: 'snowflake', brokered: true } },
      { id: 'mongo_prod', capabilities: ['mcp_tools'], nativeMcp: { serverName: 'mongodb', brokered: true } },
      { id: 'redis_prod', capabilities: ['mcp_tools'], nativeMcp: { serverName: 'redis', brokered: true } },
      { id: 'turso_prod', capabilities: ['query_database', 'mcp_tools'], nativeMcp: { serverName: 'turso', brokered: true } },
      { id: 'databricks_prod', capabilities: ['query_database', 'mcp_tools'], nativeMcp: { serverName: 'databricks', brokered: true } },
      { id: 'shopify_prod', capabilities: ['mcp_tools'], nativeMcp: { serverName: 'shopify', brokered: true } },
      { id: 'segment_prod', capabilities: ['mcp_tools'], nativeMcp: { serverName: 'segment', brokered: true } },
      { id: 'teams_prod', capabilities: ['mcp_tools'], nativeMcp: { serverName: 'teams', brokered: true } },
    ]);

    await expect(listConnectionTools(envWith(records), context, 'snowflake_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'execute_sql_readonly' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'mongo_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'find_documents' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'redis_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'scan_keys' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'turso_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'execute_sql_readonly' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'databricks_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_sql_warehouses' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'shopify_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_products' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'segment_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_sources' })])
    );
    await expect(listConnectionTools(envWith(records), context, 'teams_prod')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'list_teams' })])
    );
  });

  it('calls Databricks read-only SQL through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://dbc.example.cloud.databricks.com/api/2.0/sql/statements');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer dapi-token' });
      const body = JSON.parse(String(init?.body));
      expect(body.statement).toBe('SELECT * FROM events');
      expect(body.warehouse_id).toBe('wh_123');
      return Response.json({ statement_id: 'stmt_1', status: { state: 'SUCCEEDED' }, result: { row_count: 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'databricks_prod',
        integration_type: 'databricks',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ workspace_url: 'https://dbc.example.cloud.databricks.com', sql_warehouse_id: 'wh_123' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'dapi-token' }),
      }),
    ];

    const result = await callConnectionTool(envWith(records), context, 'databricks_prod', 'execute_sql_readonly', {
      query: 'SELECT * FROM events',
      limit: 5,
    });
    expect(result).toMatchObject({
      content: [{ type: 'text' }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls Shopify Admin GraphQL through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://demo.myshopify.com/admin/api/2026-04/graphql.json');
      expect(init?.headers).toMatchObject({ 'x-shopify-access-token': 'shpat_token' });
      return Response.json({ data: { shop: { name: 'Demo' } } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'shopify_prod',
        integration_type: 'shopify',
        name: 'prod',
        category: 'saas',
        config: JSON.stringify({ shop_domain: 'demo.myshopify.com' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'shpat_token' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'shopify_prod', 'get_shop')).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
  });

  it('calls MongoDB Atlas Data API through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://data.mongodb-api.com/app/app-id/endpoint/data/v1/action/find');
      expect(init?.headers).toMatchObject({ 'api-key': 'mongo-data-key' });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        dataSource: 'Cluster0',
        database: 'app',
        collection: 'users',
        limit: 2,
      });
      return Response.json({ documents: [{ _id: '1' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'mongo_prod',
        integration_type: 'mongodb',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ database: 'app', data_source: 'Cluster0' }),
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'mongodb+srv://unused',
          data_api_url: 'https://data.mongodb-api.com/app/app-id/endpoint/data/v1',
          data_api_key: 'mongo-data-key',
        }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'mongo_prod', 'find_documents', {
      collection: 'users',
      limit: 2,
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });

  it('calls Redis REST through a read-only command allowlist', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://redis.example.upstash.io');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer redis-rest-token' });
      expect(JSON.parse(String(init?.body))).toEqual(['GET', 'session:1']);
      return Response.json({ result: 'value' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'redis_prod',
        integration_type: 'redis',
        name: 'prod',
        category: 'databases',
        credentials_encrypted: await encryptedCredentials({
          connection_string: 'redis://unused',
          rest_url: 'https://redis.example.upstash.io',
          rest_token: 'redis-rest-token',
        }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'redis_prod', 'get_key', {
      key: 'session:1',
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });

  it('calls Turso libSQL HTTP through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://db-org.turso.io/v2/pipeline');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer turso-token' });
      const body = JSON.parse(String(init?.body));
      expect(body.requests[0].stmt.sql).toBe('SELECT * FROM users');
      return Response.json({ results: [{ type: 'ok' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'turso_prod',
        integration_type: 'turso',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ database_url: 'libsql://db-org.turso.io' }),
        credentials_encrypted: await encryptedCredentials({ api_key: 'turso-token' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'turso_prod', 'execute_sql_readonly', {
      query: 'SELECT * FROM users',
      limit: 3,
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });

  it('calls Segment Public API through the hosted broker', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('https://api.segmentapis.com/sources?');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer segment-token' });
      return Response.json({ sources: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'segment_prod',
        integration_type: 'segment',
        name: 'prod',
        category: 'saas',
        credentials_encrypted: await encryptedCredentials({ api_key: 'segment-token' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'segment_prod', 'list_sources')).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
  });

  it('calls Microsoft Graph for Teams through client credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token') {
        expect(init?.method).toBe('POST');
        return Response.json({ access_token: 'graph-token' });
      }
      expect(target).toContain('https://graph.microsoft.com/v1.0/groups?');
      expect(init?.headers).toMatchObject({ authorization: 'Bearer graph-token' });
      return Response.json({ value: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = [
      integration({
        id: 'teams_prod',
        integration_type: 'teams',
        name: 'prod',
        category: 'communication',
        config: JSON.stringify({ tenant_id: 'tenant-1' }),
        credentials_encrypted: await encryptedCredentials({ client_id: 'client-1', client_secret: 'secret' }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'teams_prod', 'list_teams')).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
  });

  it('requires Snowflake SQL API fingerprint setup for hosted MCP calls', async () => {
    const records = [
      integration({
        id: 'snowflake_prod',
        integration_type: 'snowflake',
        name: 'prod',
        category: 'databases',
        config: JSON.stringify({ account: 'xy12345.us-east-1', database: 'APP', schema: 'PUBLIC' }),
        credentials_encrypted: await encryptedCredentials({
          username: 'svc_user',
          private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
        }),
      }),
    ];

    await expect(callConnectionTool(envWith(records), context, 'snowflake_prod', 'list_databases')).rejects.toMatchObject({
      message: 'private_key_fingerprint is required',
      status: 400,
    });
  });

  it('rejects MCP tool listing for non-MCP connection types', async () => {
    const records = [
      integration({ id: 'discord_main', integration_type: 'discord', name: 'main', category: 'communication' }),
    ];

    await expect(listConnectionTools(envWith(records), context, 'discord_main')).rejects.toMatchObject({
      message: 'Connection type "discord" does not have MCP-backed tools.',
      status: 404,
    });
  });

  it('exposes imported OpenAPI operations alongside generic fetch and enforces write policy', async () => {
    const definition = {
      schemaVersion: 1,
      slug: 'example',
      displayName: 'Example API',
      surface: 'openapi',
      source: 'discovered',
      sourceUrl: 'https://api.example.com/openapi.json',
      baseUrl: 'https://api.example.com/v2',
      auth: [{ kind: 'bearer' }],
      provenance: { kind: 'discovered' },
      operations: [
        {
          id: 'getItem',
          name: 'getItem',
          method: 'GET',
          path: '/items/{itemId}',
          access: 'read',
          inputSchema: { type: 'object' },
        },
        {
          id: 'deleteItem',
          name: 'deleteItem',
          method: 'DELETE',
          path: '/items/{itemId}',
          access: 'write',
          inputSchema: { type: 'object' },
        },
      ],
    };
    const records = [integration({
      id: 'imported_api',
      integration_type: 'other',
      name: 'example',
      category: 'saas',
      config: JSON.stringify({
        base_url: 'https://api.example.com/v2',
        auth_type: 'bearer',
        operation_policy: 'read_only',
        restrict_to_base_origin: true,
      }),
      credentials_encrypted: await encryptedCredentials({ api_key: 'secret-token' }),
      definition_id: 'definition_1',
      definition: JSON.stringify(definition),
    })];

    const catalog = await listConnectionMethods(envWith(records), context);
    expect(catalog[0]?.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'getItem', access: 'read' }),
      expect.objectContaining({ name: 'deleteItem', access: 'write' }),
      expect.objectContaining({ name: 'fetch', tool: 'authenticated_fetch' }),
    ]));

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/v2/items/item-1?expand=owner');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
      return Response.json({ id: 'item-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherExample',
      method: 'getItem',
      input: { path: { itemId: 'item-1' }, query: { expand: 'owner' } },
    })).resolves.toMatchObject({ status: 200 });
    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherExample',
      method: 'deleteItem',
      input: { path: { itemId: 'item-1' } },
    })).rejects.toMatchObject({ status: 403, code: 'CONNECTION_POLICY_BLOCKED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('executes a discovered GraphQL operation against the exact endpoint URL', async () => {
    const definition = {
      schemaVersion: 1,
      slug: 'graphql-api',
      displayName: 'Example GraphQL',
      surface: 'graphql',
      source: 'discovered',
      sourceUrl: 'https://integrations.sh/api/example.com/surface',
      baseUrl: 'https://api.example.com/graphql',
      auth: [{ kind: 'header', header: 'X-API-Key' }],
      provenance: { kind: 'discovered' },
      operations: [{
        id: 'graphql.execute',
        name: 'executeGraphql',
        method: 'POST',
        path: '',
        access: 'write',
        inputSchema: { type: 'object' },
      }],
    };
    const records = [integration({
      id: 'graphql_api',
      integration_type: 'other',
      name: 'graphql',
      category: 'saas',
      config: JSON.stringify({
        base_url: 'https://api.example.com/graphql',
        auth_type: 'header',
        auth_header: 'X-API-Key',
        operation_policy: 'all',
        restrict_to_base_origin: true,
      }),
      credentials_encrypted: await encryptedCredentials({ api_key: 'graphql-token' }),
      definition_id: 'definition_graphql',
      definition: JSON.stringify(definition),
    })];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.example.com/graphql');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('graphql-token');
      expect(JSON.parse(String(init?.body))).toEqual({
        query: 'query Viewer { viewer { id } }',
        variables: {},
      });
      return Response.json({ data: { viewer: { id: 'user_1' } } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'otherGraphql',
      method: 'executeGraphql',
      input: {
        body: {
          query: 'query Viewer { viewer { id } }',
          variables: {},
        },
      },
    })).resolves.toMatchObject({
      status: 200,
      bodyText: JSON.stringify({ data: { viewer: { id: 'user_1' } } }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs GA4 reports as curated read operations with the stored OAuth token', async () => {
    const records = [integration({
      id: 'ga4_prod',
      integration_type: 'google_analytics',
      name: 'production',
      category: 'saas',
      auth_method: 'oauth2',
      config: JSON.stringify({ property_id: '123456789' }),
      credentials_encrypted: await encryptedCredentials({ access_token: 'ga4-token' }),
    })];
    const catalog = await listConnectionMethods(envWith(records), context);
    expect(catalog[0]).toMatchObject({
      alias: 'googleAnalyticsProduction',
      connection: { capabilities: ['typed_operations'] },
    });
    expect(catalog[0]?.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'runReport', tool: 'run_report', access: 'read' }),
      expect.objectContaining({ name: 'topPages', tool: 'top_pages', access: 'read' }),
    ]));

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ga4-token');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'activeUsers' }],
      });
      return Response.json({ rows: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(invokeConnectionMethod(envWith(records), context, {
      connection: 'googleAnalyticsProduction',
      method: 'runReport',
      input: {
        dimensions: [{ name: 'country' }],
        metrics: [{ name: 'activeUsers' }],
      },
    })).resolves.toEqual({ rows: [] });
  });
});
