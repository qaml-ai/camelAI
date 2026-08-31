/**
 * Main camelAI Worker - Composition Root
 *
 * Routes:
 * - /client/v4/* → CF API proxy for wrangler deploys
 * - /mcp/* → MCP protocol
 * - /api/auth/:provider → User OAuth (Google, GitHub)
 * - /api/integrations/slack/* → Slack OAuth
 * - /api/integrations/slack/events → Slack Events API webhook
 * - /api/integrations/telegram/webhook → Telegram Bot API webhook
 * - email() → Workspace email ingress (Cloudflare Email Routing)
 * - /api/threads/:id/preview → Thread preview API
 * - /agents/chat-thread/:thread/sse → ChatThreadDO chat stream (SSE)
 * - /agents/chat-thread/:thread/call → ChatThreadDO chat frames (POST)
 * - * → React Router SSR
 */

import { createRequestHandler } from 'react-router';
import { DurableObject } from 'cloudflare:workers';
export { ContainerProxy, Sandbox } from '@cloudflare/sandbox';
import type { Env, Route, RouteContext } from './types.js';
import { handleSlackEventsQueue } from './slack-events-queue.js';
import type { AppScreenshotJob } from './screenshot-queue.js';
import type { SlackEventQueueMessage } from './slack-types.js';
import type { DiscordEventQueueMessage } from './discord-types.js';
import {
  handleDiscordEventsDeadLetterQueue,
  handleDiscordEventsQueue,
} from './discord-events-queue.js';

// Route handlers
import { handleCfProxy } from './routes/cf-proxy.js';
import { handleMcp } from './routes/mcp.js';
import { handleConnectionsRpc } from './routes/connections-rpc.js';
import { handleAdminMcp } from './routes/admin-mcp.js';
import { handleThreadPreview } from './routes/threads.js';
import { handleOAuthStart, handleOAuthCallback } from './routes/oauth.js';
import {
  handleSlackOAuthStart,
  handleSlackOAuthCallback,
  handleSlackEvents,
  handleTelegramWebhook,
  handleNotionOAuthStart,
  handleNotionOAuthCallback,
  handleSalesforceOAuthStart,
  handleSalesforceOAuthCallback,
  handleRemoteMcpOAuthStart,
  handleRemoteMcpOAuthCallback,
  handleGoogleAnalyticsOAuthStart,
  handleGoogleAnalyticsOAuthCallback,
} from './routes/integrations.js';
import {
  handleDiscordOAuthCallback,
  handleDiscordOAuthStart,
} from './routes/discord-integrations.js';
import { handleWorkspaceStatusStream } from './routes/status-stream.js';
import { handleLogsWebSocket } from './routes/logs-websocket.js';
import { handleOAuthMetadata, handleResourceMetadata } from './routes/well-known.js';
import {
  handleMssqlQuery,
  handleMysqlQuery,
  handlePostgresQuery,
} from './routes/data-proxy.js';
import {
  handleInternalBillingAccess,
  handleStripeWebhook,
} from './routes/billing.js';
import { handleEmailSendProxy } from './routes/email-send-proxy.js';
import { handleWorkerAuth } from './routes/worker-auth.js';
import { requireChatWebSocketAccess } from './helpers/auth.js';
import { stripReservedTransportHeaders } from './chat-thread/transport-headers.js';
import { getThreadStub } from './helpers/stubs.js';
import { text } from './helpers/response.js';
import { normalizePathForObservability, recordObservabilityEvent } from './observability.js';

// Re-exports for wrangler
export { ChiridionMcp } from './mcp-handler.js';
export {
  AdminJsExecDoBinding,
  AdminJsExecRuntimeBinding,
} from './routes/admin-mcp.js';
export { ChatThreadDO, CodeModeToolsBinding } from './chat-thread-do.js';
export { UserDO, OrgDO } from './auth.js';
export { OrgSlugDO } from './org-slug-registry.js';
export { EmailHandleDO } from './email-handle-registry.js';
export { SignupDO } from './signup-do.js';
export {
  SlackTeamRegistryDO,
  TelegramRegistryDO,
} from './channel-registries.js';
export { WorkspaceDO } from './workspace.js';
export { WorkspaceCronDO } from './workspace-cron.js';
export { WorkerLogsDO, EphemeralWorkerLogsDO } from './worker-logs-do.js';
export { R2VirtualBucket } from './r2-virtual-bucket.js';
export { KVVirtualNamespace } from './kv-virtual-namespace.js';
export { AssetsVirtualBinding } from './assets-virtual-binding.js';
export { DataProxyService } from './data-proxy-service.js';
export { WarehouseService } from './warehouse-service.js';
export { AnalysisService, AnalysisAppService } from './analysis-service.js';
export { ProjectBuildService } from './project-build-service.js';
export { AIVirtualBinding } from './ai-virtual-binding.js';
export { ConnectionsService } from './connections-service.js';
export {
  DeterministicAutomationWorkflow,
  DynamicWorkflowBinding,
} from './deterministic-automation-workflow.js';
export { CamelAiService } from './camelai-service.js';
export { SecureFetchBinding } from './secure-fetch-service.js';
export { AppScreenshotBinding } from './app-screenshot-binding.js';
export { AppBrowserBinding } from './app-browser-binding.js';
export { WorkspaceFilesystemDO } from './workspace-filesystem-do.js';
export { EvalSandbox } from './eval-sandbox.js';
export { AnalysisSandbox } from './analysis-sandbox.js';
export { ProjectBuildSandbox } from './project-build-sandbox.js';
export { DbQuerySandbox } from './db-query-sandbox.js';

// Compatibility shim for environments whose deployed migration history still
// references the old AdminIndexDO class. The app uses the D1-backed index now.
export class AdminIndexDO extends DurableObject<Env> {}

// Compatibility shim for deployed migration histories that contain the retired
// Cloudflare Sandbox SDK experiment. Projects are DO+R2 backed now.
export class CloudflareSandbox extends DurableObject<Env> {}

// Compatibility shim for deployed migration histories that introduced the
// old Think-based migration planning Durable Object. The legacy workspace
// migration feature has since been removed; this no-op class remains only so
// deployed Durable Object migration histories continue to resolve.
export class MigrationPlanningAgent extends DurableObject<Env> {}

// Extend React Router's AppLoadContext
declare module 'react-router' {
  export interface AppLoadContext {
    cloudflare: { env: Env; ctx: ExecutionContext };
  }
}

let adminApiModulePromise: Promise<typeof import('./routes/admin/index.js')> | undefined;
let emailIngressModulePromise: Promise<typeof import('./email-ingress.js')> | undefined;
let screenshotQueueModulePromise: Promise<typeof import('./screenshot-queue.js')> | undefined;

function loadCachedModule<T>(
  getCurrent: () => Promise<T> | undefined,
  setCurrent: (promise: Promise<T> | undefined) => void,
  loader: () => Promise<T>
): Promise<T> {
  const current = getCurrent();
  if (current) return current;

  const promise = loader().catch((error) => {
    if (getCurrent() === promise) {
      setCurrent(undefined);
    }
    throw error;
  });

  setCurrent(promise);
  return promise;
}

function loadAdminApiModule() {
  return loadCachedModule(
    () => adminApiModulePromise,
    (promise) => {
      adminApiModulePromise = promise;
    },
    () => import('./routes/admin/index.js')
  );
}

function loadEmailIngressModule() {
  return loadCachedModule(
    () => emailIngressModulePromise,
    (promise) => {
      emailIngressModulePromise = promise;
    },
    () => import('./email-ingress.js')
  );
}

function loadScreenshotQueueModule() {
  return loadCachedModule(
    () => screenshotQueueModulePromise,
    (promise) => {
      screenshotQueueModulePromise = promise;
    },
    () => import('./screenshot-queue.js')
  );
}

// =============================================================================
// Route Table
// =============================================================================

const routes: Route[] = [
  // OAuth-protected remote MCP server for the admin API.
  // This must run before the ADMIN_API_KEY admin REST wrapper because it also
  // uses Bearer tokens.
  {
    method: 'ALL',
    path: /^\/api\/admin\/mcp$/,
    handler: handleAdminMcp,
  },
  {
    method: 'GET',
    path: /^\/api\/admin\/oauth$/,
    handler: handleOAuthMetadata,
  },
  {
    method: 'GET',
    path: /^\/api\/admin\/oauth\/\.well-known\/oauth-authorization-server$/,
    handler: handleOAuthMetadata,
  },

  // Admin REST API (ADMIN_API_KEY auth; returns null to fall through to React Router for session-auth routes)
  {
    method: 'ALL',
    path: /^\/api\/admin\//,
    handler: async (context) => (await loadAdminApiModule()).handleAdminApi(context),
  },

  // CF API Proxy
  { method: 'ALL', path: /^\/client\/v4\//, handler: handleCfProxy },

  // Data proxy (for sandbox containers)
  { method: 'POST', path: /^\/api\/mssql\/query$/, handler: handleMssqlQuery },
  { method: 'POST', path: /^\/api\/postgres\/query$/, handler: handlePostgresQuery },
  { method: 'POST', path: /^\/api\/mysql\/query$/, handler: handleMysqlQuery },
  { method: 'GET', path: /^\/api\/internal\/billing\/access$/, handler: handleInternalBillingAccess },
  { method: 'POST', path: /^\/api\/billing\/stripe\/webhook$/, handler: handleStripeWebhook },

  // Email sending proxy (for sandbox containers)
  { method: 'POST', path: /^\/api\/email\/send$/, handler: handleEmailSendProxy },

  // Connections RPC (internal - sandbox/project-runtime tools)
  { method: 'ALL', path: /^\/rpc\/connections$/, handler: handleConnectionsRpc },

  // MCP (internal - sandbox agent)
  { method: 'ALL', path: /^\/mcp(\/|$)/, handler: handleMcp },

  // OAuth discovery (well-known paths can't be React Router routes)
  { method: 'GET', path: /^\/\.well-known\/oauth-authorization-server(\/.*)?$/, handler: handleOAuthMetadata },
  { method: 'GET', path: /^\/\.well-known\/oauth-protected-resource(\/.*)?$/, handler: handleResourceMetadata },

  // Thread Preview API
  { method: 'POST', path: /^\/api\/threads\/([^/]+)\/preview$/, handler: handleThreadPreview },

  // User OAuth
  { method: 'GET', path: /^\/api\/auth\/(google|github)$/, handler: handleOAuthStart },
  { method: 'GET', path: /^\/api\/auth\/(google|github)\/callback$/, handler: handleOAuthCallback },

  // Worker auth (cross-domain auth for private workers)
  { method: 'GET', path: /^\/auth\/worker$/, handler: handleWorkerAuth },

  // Integration OAuth
  { method: 'GET', path: /^\/api\/integrations\/slack\/oauth$/, handler: handleSlackOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/slack\/callback$/, handler: handleSlackOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/discord\/oauth$/, handler: handleDiscordOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/discord\/callback$/, handler: handleDiscordOAuthCallback },
  { method: 'POST', path: /^\/api\/integrations\/slack\/events$/, handler: handleSlackEvents },
  { method: 'POST', path: /^\/api\/integrations\/telegram\/webhook$/, handler: handleTelegramWebhook },
  { method: 'GET', path: /^\/api\/integrations\/notion\/oauth$/, handler: handleNotionOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/notion\/callback$/, handler: handleNotionOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/salesforce\/oauth$/, handler: handleSalesforceOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/salesforce\/callback$/, handler: handleSalesforceOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/google_analytics\/oauth$/, handler: handleGoogleAnalyticsOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/google_analytics\/callback$/, handler: handleGoogleAnalyticsOAuthCallback },
  { method: 'GET', path: /^\/api\/integrations\/remote_mcp\/oauth$/, handler: handleRemoteMcpOAuthStart },
  { method: 'GET', path: /^\/api\/integrations\/remote_mcp\/callback$/, handler: handleRemoteMcpOAuthCallback },

  // Chat transport (HTTP POST send + SSE receive). Plain HTTP: `websocket: true`
  // would make the route loop skip them, and React Router would answer an
  // /agents/* miss with the SPA shell, so misses 404 here instead.
  {
    method: 'GET',
    path: /^\/agents\/chat-thread\/([^/]+)\/sse$/,
    handler: (context) => handleChatTransportRequest(context, 'sse'),
  },
  {
    method: 'POST',
    path: /^\/agents\/chat-thread\/([^/]+)\/call$/,
    handler: (context) => handleChatTransportRequest(context, 'call'),
  },
  { method: 'ALL', path: /^\/agents\//, handler: async () => text('Not Found', 404) },

  // Workspace thread-status SSE stream (replaces the status WebSocket).
  { method: 'GET', path: /^\/api\/workspaces\/([^/]+)\/status\/stream$/, handler: handleWorkspaceStatusStream },

  // WebSocket routes. Only `wrangler tail` log streaming still speaks WebSocket
  // (cf-api-proxy hands this URL back as the tail endpoint); chat and workspace
  // status are HTTP+SSE.
  { method: 'GET', path: /^\/ws\/logs$/, handler: handleLogsWebSocket, websocket: true },
];

// =============================================================================
// React Router Handler (hoisted to module scope)
// =============================================================================

// @ts-expect-error - virtual module provided by @react-router/dev
const reactRouterHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE
);

// =============================================================================
// Main Router
// =============================================================================

/**
 * Chat transports sharing one authorization unit. The telemetry event NAMES are
 * unchanged from the retired WebSocket upgrade path (dashboards filter on
 * them); `operation` distinguishes the two HTTP transports.
 */
type ChatTransport = 'sse' | 'call';

const CHAT_TRANSPORT_AUTH_OPERATIONS: Record<ChatTransport, string> = {
  sse: 'authorizeChatTransportRequest:sse',
  call: 'authorizeChatTransportRequest:call',
};

async function authorizeChatTransportRequest(
  req: Request,
  env: Env,
  threadId: string,
  transport: ChatTransport,
): Promise<Request | Response> {
  const startedAt = Date.now();
  const operation = CHAT_TRANSPORT_AUTH_OPERATIONS[transport];
  const url = new URL(req.url);
  const workspaceIdParam = url.searchParams.get('workspaceId');
  let access: Awaited<ReturnType<typeof requireChatWebSocketAccess>>;
  try {
    access = await requireChatWebSocketAccess(
      req,
      env,
      threadId,
      workspaceIdParam,
    );
  } catch (error) {
    recordObservabilityEvent(env, {
      event: 'chat_ws_auth_completed',
      severity: 'error',
      component: 'chat_ws_auth',
      operation,
      status: 'exception',
      durationMs: Date.now() - startedAt,
      route: '/agents/chat-thread/:threadId',
      method: req.method,
      path: url.pathname,
      threadId,
      workspaceId: workspaceIdParam,
      errorName: error instanceof Error ? error.name : 'Error',
      sampleIndex: threadId,
    });
    // requireChatWebSocketAccess throws on a non-transient session-invalidation
    // check failure. An HTTP transport must render that itself: an uncaught
    // throw is an opaque 500 the client would retry against forever.
    return text('Authorization temporarily unavailable', 503);
  }
  if ('error' in access) {
    const status = access.error.status || 403;
    const reasonText = (await access.error.clone().text().catch(() => '')) ||
      access.error.statusText ||
      'forbidden';
    recordObservabilityEvent(env, {
      event: 'chat_ws_upgrade_rejected',
      severity: status >= 500 ? 'error' : 'warn',
      component: 'chat_ws_auth',
      operation,
      status: String(status),
      statusCode: status,
      durationMs: Date.now() - startedAt,
      route: '/agents/chat-thread/:threadId',
      method: req.method,
      path: url.pathname,
      threadId,
      workspaceId: workspaceIdParam,
      errorMessage: reasonText.slice(0, 200),
      sampleIndex: threadId,
    });
    // The denial goes back as-is — the statuses already carry the
    // terminal/retryable split the client classifies on (400/401/403/404
    // terminal, 409/429/5xx retryable).
    return access.error;
  }

  const { session, userId } = access;
  const fullAccess = 'degraded' in access ? null : access;

  if ('degraded' in access) {
    recordObservabilityEvent(env, {
      event: 'chat_ws_upgrade_degraded',
      severity: 'warn',
      component: 'chat_ws_auth',
      operation,
      status: 'degraded',
      durationMs: Date.now() - startedAt,
      route: '/agents/chat-thread/:threadId',
      method: req.method,
      path: url.pathname,
      threadId,
      workspaceId: workspaceIdParam,
      userId,
      sampleIndex: threadId,
    });
  }

  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Id');
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  headers.delete('X-Chiridion-Auth-Degraded');
  // Hand-rolled routes bypass routePartykitRequest, which would overwrite the
  // partyserver headers, and nothing overwrites the Agents SDK's sub-agent
  // routing header — over HTTP a browser can set both, unlike on a WS handshake.
  stripReservedTransportHeaders(headers);
  headers.set('X-Chiridion-User-Id', userId);
  if (session.user_name) headers.set('X-Chiridion-User-Name', session.user_name);
  if (session.user_email) headers.set('X-Chiridion-User-Email', session.user_email);

  url.searchParams.set('threadId', fullAccess?.threadId ?? threadId);
  if (fullAccess) {
    url.searchParams.set('workspaceId', fullAccess.workspaceId);
    url.searchParams.set('orgId', fullAccess.orgId);
  } else {
    // Never forward client-controlled scope on degraded admits — ChatThreadDO
    // must keep its stored workspace/org context rather than trusting query.
    url.searchParams.delete('workspaceId');
    url.searchParams.delete('orgId');
    headers.set('X-Chiridion-Auth-Degraded', '1');
  }

  recordObservabilityEvent(env, {
    event: 'chat_ws_auth_completed',
    severity: 'info',
    component: 'chat_ws_auth',
    operation,
    status: fullAccess ? 'authorized' : 'degraded_authorized',
    durationMs: Date.now() - startedAt,
    route: '/agents/chat-thread/:threadId',
    method: req.method,
    path: url.pathname,
    threadId,
    workspaceId: fullAccess?.workspaceId ?? workspaceIdParam,
    orgId: fullAccess?.orgId,
    userId,
    sampleIndex: threadId,
  });

  const forwardInit: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // The POST frame body must survive the rewrite; leaving it out authenticates
    // the request perfectly and then delivers an empty message.
    forwardInit.body = req.body;
    // @ts-expect-error - duplex is required for streaming bodies
    forwardInit.duplex = 'half';
  }
  return new Request(url.toString(), forwardInit);
}

async function handleChatTransportRequest(
  { req, env, match }: RouteContext,
  transport: ChatTransport,
): Promise<Response> {
  // Raw, undecoded path segment: partyserver derives the DO name the same way,
  // so an escapable character must not address a different Durable Object.
  const threadId = match[1] ?? '';
  if (!threadId) return text('Missing threadId', 400);
  const authorized = await authorizeChatTransportRequest(
    req,
    env,
    threadId,
    transport,
  );
  if (authorized instanceof Response) return authorized;
  // Returned unmodified: an SSE body must never be buffered here.
  return getThreadStub(env, threadId).fetch(authorized);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    // No chat/agent WebSocket upgrade path exists any more: only routes marked
    // `websocket: true` (currently just /ws/logs) answer an upgrade, and every
    // other upgrade attempt — including a stale bundle reaching for
    // /agents/chat-thread/:id or /ws/workspaces/:id/status — falls through to
    // the 404 below without touching authorization.
    const isWebSocket = req.headers.get('Upgrade') === 'websocket';

    for (const route of routes) {
      if (isWebSocket && !route.websocket) continue;
      if (route.websocket && !isWebSocket) continue;
      if (route.method !== 'ALL' && route.method !== method) continue;

      const match = url.pathname.match(route.path);
      if (!match) continue;

      const result = await route.handler({ req, env, ctx, url, match });
      if (result !== null) return result;
    }

    if (isWebSocket) {
      // A stale bundle reaching for a retired transport lands here. A non-101
      // answer is NOT a terminal signal to a browser client: the handshake
      // failure surfaces as close code 1006, which every reconnecting client we
      // ship (partysocket, the Agents SDK's `isTerminalCloseEvent`) classifies
      // as retryable, so those tabs re-attempt on backoff until a reload or a
      // version-skew check heals them. Name the event so that population is
      // visible in the observability stream instead of only as raw 404 volume.
      const upgradePath = normalizePathForObservability(url.pathname);
      recordObservabilityEvent(env, {
        event: 'ws_upgrade_route_removed',
        severity: 'warn',
        component: 'main-worker',
        operation: 'websocketUpgrade',
        status: 'not_found',
        method,
        path: upgradePath,
        statusCode: 404,
        sampleIndex: upgradePath,
      });
      return new Response('Not Found', { status: 404 });
    }

    return reactRouterHandler(req, { cloudflare: { env, ctx } });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await (await loadEmailIngressModule()).handleWorkspaceEmailIngress(message, env);
  },

  async queue(
    batch: MessageBatch<AppScreenshotJob | SlackEventQueueMessage | DiscordEventQueueMessage>,
    env: Env,
  ): Promise<void> {
    if (batch.queue.startsWith('chiridion-app-screenshots')) {
      return (await loadScreenshotQueueModule()).handleScreenshotQueue(
        batch as MessageBatch<AppScreenshotJob>,
        env
      );
    }
    if (batch.queue.startsWith('chiridion-app-slack-events')) {
      return handleSlackEventsQueue(batch as MessageBatch<SlackEventQueueMessage>, env);
    }
    if (batch.queue.startsWith('chiridion-app-discord-events-dlq')) {
      return handleDiscordEventsDeadLetterQueue(
        batch as MessageBatch<DiscordEventQueueMessage>,
        env,
      );
    }
    if (batch.queue.startsWith('chiridion-app-discord-events')) {
      return handleDiscordEventsQueue(
        batch as MessageBatch<DiscordEventQueueMessage>,
        env,
      );
    }

    console.warn('[queue] unhandled queue batch', { queue: batch.queue, size: batch.messages.length });
    batch.ackAll();
  },
} satisfies ExportedHandler<Env>;
