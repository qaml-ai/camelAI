import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { fetchMcpHttp, parseJsonObject, readBoundedResponseText, requireString, textToolResult } from './mcp-values.js';
import type { WorkspaceIntegrationRecord } from './workspace.js';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue };

interface AmplitudeMcpEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface AmplitudeClient {
  region: 'us' | 'eu';
  apiKey: string;
  secretKey: string;
}

export function isAmplitudeMcpIntegration(integrationType: string): boolean {
  return integrationType === 'amplitude';
}

export function listAmplitudeMcpTools(): Array<Record<string, unknown>> {
  return [
    {
      name: 'list_events',
      description: 'List event types from Amplitude Taxonomy.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'list_event_properties',
      description: 'List event properties from Amplitude Taxonomy.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'query_events_segmentation',
      description: 'Run an Amplitude events segmentation query for one event.',
      inputSchema: {
        type: 'object',
        properties: {
          eventType: { type: 'string', description: 'Amplitude event type.' },
          start: { type: 'string', description: 'Start date in YYYYMMDD format.' },
          end: { type: 'string', description: 'End date in YYYYMMDD format.' },
        },
        required: ['eventType', 'start', 'end'],
        additionalProperties: false,
      },
    },
  ];
}

export async function amplitudeMcpRpc(
  env: AmplitudeMcpEnv,
  record: WorkspaceIntegrationRecord,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  if (!isAmplitudeMcpIntegration(record.integration_type)) {
    throw Object.assign(new Error(`Integration type "${record.integration_type}" is not Amplitude.`), {
      status: 404,
    });
  }

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'camelai-amplitude', version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listAmplitudeMcpTools() };
    case 'tools/call':
      return callAmplitudeTool(env, record, params);
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { status: 404 });
  }
}

async function callAmplitudeTool(
  env: AmplitudeMcpEnv,
  record: WorkspaceIntegrationRecord,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = requireString(params.name, 'name');
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? params.arguments as Record<string, unknown>
    : {};
  const client = await createAmplitudeClient(env, record);

  switch (name) {
    case 'list_events':
      return textToolResult(await amplitudeFetch(client, '/api/2/taxonomy/event'));
    case 'list_event_properties':
      return textToolResult(await amplitudeFetch(client, '/api/2/taxonomy/event-property'));
    case 'query_events_segmentation':
      return textToolResult(await amplitudeFetch(client, `/api/2/events/segmentation?${new URLSearchParams({
        e: JSON.stringify({ event_type: requireString(args.eventType, 'eventType') }),
        start: requireCompactDate(args.start, 'start'),
        end: requireCompactDate(args.end, 'end'),
      })}`));
    default:
      throw Object.assign(new Error(`Unknown Amplitude tool: ${name}`), { status: 404 });
  }
}

async function createAmplitudeClient(
  env: AmplitudeMcpEnv,
  record: WorkspaceIntegrationRecord
): Promise<AmplitudeClient> {
  const config = parseJsonObject(record.config);
  const credentials = record.credentials_encrypted
    ? await decryptCredentials<Record<string, unknown>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY)
    : {};
  return {
    region: config.region === 'eu' ? 'eu' : 'us',
    apiKey: requireString(credentials.api_key, 'api_key'),
    secretKey: requireString(credentials.api_secret, 'api_secret'),
  };
}

async function amplitudeFetch(client: AmplitudeClient, path: string): Promise<JsonValue> {
  const response = await fetchMcpHttp(`${amplitudeBase(client)}${path}`, {
    headers: {
      authorization: `Basic ${btoa(`${client.apiKey}:${client.secretKey}`)}`,
      accept: 'application/json',
    },
  });
  const text = await readBoundedResponseText(response);
  const payload = text ? JSON.parse(text) as JsonValue : null;
  if (!response.ok) {
    throw Object.assign(new Error(`Amplitude API request failed with HTTP ${response.status}: ${text}`), {
      status: response.status,
    });
  }
  return payload;
}

function amplitudeBase(client: AmplitudeClient): string {
  return client.region === 'eu' ? 'https://analytics.eu.amplitude.com' : 'https://amplitude.com';
}

function requireCompactDate(value: unknown, field: string): string {
  const date = requireString(value, field);
  if (!/^\d{8}$/.test(date)) {
    throw Object.assign(new Error(`${field} must be in YYYYMMDD format.`), { status: 400 });
  }
  return date;
}
