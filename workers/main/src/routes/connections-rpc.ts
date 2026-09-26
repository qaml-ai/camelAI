/**
 * Stateless workspace connections RPC.
 *
 * Served to the analysis sandbox's `connections.internal` outbound handler,
 * which establishes the workspace/org scope DO-side, and exposes workspace
 * connection methods without exposing raw credential material.
 */

import type { RouteContext } from '../types.js';
import { createRequestObservabilityContext } from '../observability.js';
import {
  findConnectionMethodEntry,
  getConnection,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnectionTools,
  listConnections,
  testConnectionMethodEntry,
  verifyConnection,
  type ConnectionsContext,
  type ConnectionFindQuery,
} from '../connections-runtime.js';

interface ConnectionsRpcRequest {
  action?: unknown;
  connection?: unknown;
  method?: unknown;
  input?: unknown;
  query?: unknown;
}

const ACTIONS = ['list', 'get', 'find', 'tools', 'methods', 'test', 'verify', 'invoke'] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcResult(result: unknown): Record<string, unknown> {
  return { ok: true, result };
}

function rpcError(
  message: string,
  status = 500,
  data?: Record<string, unknown>,
): Response {
  return jsonResponse({
    ok: false,
    error: data ? { message, ...data } : { message },
  }, status);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value.trim();
}

function requireFindQuery(value: unknown): ConnectionFindQuery {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    const query = {
      id: typeof raw.id === 'string' ? raw.id : undefined,
      alias: typeof raw.alias === 'string' ? raw.alias : undefined,
      type: typeof raw.type === 'string' ? raw.type : undefined,
      name: typeof raw.name === 'string' ? raw.name : undefined,
    };
    if (Object.values(query).some((item) => typeof item === 'string' && item.trim())) {
      return query;
    }
  }
  throw Object.assign(new Error('query is required'), { status: 400 });
}

async function handleRpcAction(
  request: ConnectionsRpcRequest,
  env: RouteContext['env'],
  auth: ConnectionsContext,
): Promise<Record<string, unknown>> {
  const action = requireString(request.action, 'action');

  switch (action) {
    case 'list':
      return rpcResult(await listConnections(env, auth));

    case 'get':
      return rpcResult(await getConnection(env, auth, requireString(request.connection, 'connection')));

    case 'find':
      return rpcResult(await findConnectionMethodEntry(env, auth, requireFindQuery(request.query)));

    case 'tools':
      return rpcResult(await listConnectionTools(env, auth, requireString(request.connection, 'connection')));

    case 'methods':
      return rpcResult(await listConnectionMethods(env, auth));

    case 'test':
      return rpcResult(await testConnectionMethodEntry(env, auth, requireFindQuery(request.query)));

    case 'verify':
      return rpcResult(await verifyConnection(env, auth, requireFindQuery(request.query)));

    case 'invoke':
      return rpcResult(await invokeConnectionMethod(env, auth, {
        connection: requireString(request.connection, 'connection'),
        method: requireString(request.method, 'method'),
        input: request.input,
      }));

    default:
      throw Object.assign(new Error(`Unknown action: ${action}`), { status: 404 });
  }
}

function errorData(error: unknown): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  const source = error as {
    code?: unknown;
    data?: unknown;
    matches?: unknown;
    methods?: unknown;
  };
  if (source.code !== undefined) data.code = source.code;
  if (source.data !== undefined) data.data = source.data;
  if (source.matches !== undefined) data.matches = source.matches;
  if (source.methods !== undefined) data.methods = source.methods;
  return Object.keys(data).length > 0 ? data : undefined;
}

/**
 * Serve a connections RPC request whose identity is ALREADY established by the
 * caller — the auth context is trusted as-is, no header validation happens here.
 *
 * The caller is the analysis sandbox's `connections.internal` outbound
 * handler, where the workspace/org scope is attached DO-side via
 * outbound-handler params (unforgeable by container code — see
 * analysis-sandbox.ts).
 */
export async function handleAuthenticatedConnectionsRpc(
  req: Request,
  env: RouteContext['env'],
  auth: ConnectionsContext,
): Promise<Response> {
  if (req.method === 'GET') {
    return jsonResponse({ ok: true, actions: ACTIONS });
  }
  if (req.method !== 'POST') {
    return rpcError('Method not allowed', 405);
  }

  let payload: ConnectionsRpcRequest;
  try {
    payload = await req.json() as ConnectionsRpcRequest;
  } catch {
    return rpcError('Invalid JSON', 400);
  }

  const requestContext: ConnectionsContext = {
    ...auth,
    requestId: auth.requestId ?? createRequestObservabilityContext(req).requestId,
  };

  try {
    return jsonResponse(await handleRpcAction(payload, env, requestContext));
  } catch (error) {
    const status = (error as { status?: unknown })?.status;
    const httpStatus = typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
    return rpcError(error instanceof Error ? error.message : String(error), httpStatus, errorData(error));
  }
}
