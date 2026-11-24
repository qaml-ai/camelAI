import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { boundedInteger } from './mcp-bounded-integer.js';
import { fetchMcpHttp, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SendGridMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface SendGridClient {
  token: string;
}

const SENDGRID_API_BASE = 'https://api.sendgrid.com/v3';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RESOURCE_ID_RE = /^[a-z0-9._-]+$/i;

export function isSendGridMcpIntegration(integrationType: string): boolean {
  return integrationType === 'sendgrid';
}

export function listSendGridMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_sender_identities',
      description: 'List verified sender identities in the connected SendGrid account.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum sender identities to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'list_templates',
      description: 'List SendGrid dynamic templates.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum templates to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_template',
      description: 'Get one SendGrid template by id.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'SendGrid template id.' },
        },
        required: ['templateId'],
        additionalProperties: false,
      },
    },
  ];
}

export async function sendGridMcpRpc(
  env: SendGridMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isSendGridMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not SendGrid.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-sendgrid', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listSendGridMcpTools() };
    case 'tools/call':
      return callSendGridTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callSendGridTool(
  env: SendGridMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createSendGridClient(env, record);

  switch (name) {
    case 'list_sender_identities':
      return textToolResult(await sendGridFetch<JsonValue>(
        client,
        `/verified_senders?${new URLSearchParams({
          limit: String(boundedInteger(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
        })}`
      ));
    case 'list_templates':
      return textToolResult(await sendGridFetch<JsonValue>(
        client,
        `/templates?${new URLSearchParams({
          generations: 'dynamic',
          page_size: String(boundedInteger(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
        })}`
      ));
    case 'get_template':
      return textToolResult(await sendGridFetch<JsonValue>(
        client,
        `/templates/${encodeURIComponent(requireResourceId(args.templateId, 'templateId'))}`
      ));
    default:
      throw Object.assign(new Error(`Unknown SendGrid tool: ${name}`), { status: 404 });
  }
}

async function createSendGridClient(
  env: SendGridMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<SendGridClient> {
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const token = requireString(credentials.api_key, 'api_key');
  return { token };
}

async function sendGridFetch<T>(client: SendGridClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${SENDGRID_API_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload: T & { errors?: Array<{ message?: string }> } = text
    ? JSON.parse(text) as T & { errors?: Array<{ message?: string }> }
    : {} as T & { errors?: Array<{ message?: string }> };
  if (!response.ok) {
    const message = Array.isArray(payload.errors) && typeof payload.errors[0]?.message === 'string'
      ? payload.errors[0].message
      : `SendGrid API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload as T;
}

function requireResourceId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!RESOURCE_ID_RE.test(id)) {
    throw Object.assign(new Error(`${field} contains invalid characters.`), { status: 400 });
  }
  return id;
}
