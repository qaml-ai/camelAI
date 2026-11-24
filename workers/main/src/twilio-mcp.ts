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

interface TwilioMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface TwilioClient {
  accountSid: string;
  authorization: string;
}

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SID_RE = /^[A-Z]{2}[a-f0-9]{32}$/i;

export function isTwilioMcpIntegration(integrationType: string): boolean {
  return integrationType === 'twilio';
}

export function listTwilioMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_messages',
      description: 'List recent Twilio messages.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Optional recipient phone number filter.' },
          from: { type: 'string', description: 'Optional sender phone number filter.' },
          dateSent: { type: 'string', description: 'Optional date filter in YYYY-MM-DD format.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum messages to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_message',
      description: 'Get one Twilio message by Message SID.',
      inputSchema: {
        type: 'object',
        properties: {
          messageSid: { type: 'string', description: 'Twilio Message SID.' },
        },
        required: ['messageSid'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_calls',
      description: 'List recent Twilio calls.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Optional called phone number filter.' },
          from: { type: 'string', description: 'Optional caller phone number filter.' },
          status: { type: 'string', description: 'Optional call status filter.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Maximum calls to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'get_call',
      description: 'Get one Twilio call by Call SID.',
      inputSchema: {
        type: 'object',
        properties: {
          callSid: { type: 'string', description: 'Twilio Call SID.' },
        },
        required: ['callSid'],
        additionalProperties: false,
      },
    },
  ];
}

export async function twilioMcpRpc(
  env: TwilioMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isTwilioMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Twilio.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-twilio', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listTwilioMcpTools() };
    case 'tools/call':
      return callTwilioTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callTwilioTool(
  env: TwilioMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createTwilioClient(env, record);

  switch (name) {
    case 'list_messages':
      return textToolResult(await twilioFetch<JsonValue>(client, `/Messages.json?${twilioListParams(args, {
        To: 'to',
        From: 'from',
        DateSent: 'dateSent',
      })}`));
    case 'get_message':
      return textToolResult(await twilioFetch<JsonValue>(
        client,
        `/Messages/${encodeURIComponent(requireSid(args.messageSid, 'messageSid', 'SM'))}.json`
      ));
    case 'list_calls':
      return textToolResult(await twilioFetch<JsonValue>(client, `/Calls.json?${twilioListParams(args, {
        To: 'to',
        From: 'from',
        Status: 'status',
      })}`));
    case 'get_call':
      return textToolResult(await twilioFetch<JsonValue>(
        client,
        `/Calls/${encodeURIComponent(requireSid(args.callSid, 'callSid', 'CA'))}.json`
      ));
    default:
      throw Object.assign(new Error(`Unknown Twilio tool: ${name}`), { status: 404 });
  }
}

async function createTwilioClient(
  env: TwilioMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<TwilioClient> {
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  const accountSid = requireSid(credentials.account_sid, 'account_sid', 'AC');
  const authToken = requireString(credentials.auth_token, 'auth_token');
  return {
    accountSid,
    authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
  };
}

function twilioListParams(
  args: Record<string, unknown>,
  filters: Record<string, string>
): URLSearchParams {
  const params = new URLSearchParams({
    PageSize: String(boundedInteger(args.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit')),
  });
  for (const [apiName, argName] of Object.entries(filters)) {
    if (typeof args[argName] === 'string' && args[argName].trim()) {
      params.set(apiName, args[argName].trim());
    }
  }
  return params;
}

async function twilioFetch<T>(client: TwilioClient, path: string): Promise<T> {
  const response = await fetchMcpHttp(`${TWILIO_API_BASE}/Accounts/${encodeURIComponent(client.accountSid)}${path}`, {
    headers: {
      authorization: client.authorization,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload: T & { message?: unknown } = text
    ? JSON.parse(text) as T & { message?: unknown }
    : {} as T & { message?: unknown };
  if (!response.ok) {
    const message = typeof payload.message === 'string'
      ? payload.message
      : `Twilio API request failed with HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return payload as T;
}

function requireSid(value: unknown, field: string, prefix: string): string {
  const sid = requireString(value, field);
  if (!SID_RE.test(sid) || !sid.toUpperCase().startsWith(prefix)) {
    throw Object.assign(new Error(`${field} must be a valid Twilio ${prefix} SID.`), { status: 400 });
  }
  return sid;
}
