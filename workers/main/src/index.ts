/**
 * Main camelAI Worker - Composition Root
 *
 * Routes:
 * - /api/auth/:provider → User OAuth (Google, GitHub)
 * - /api/integrations/slack/* → Slack OAuth
 * - /api/integrations/slack/events → Slack Events API webhook
 * - /api/integrations/telegram/webhook → Telegram Bot API webhook
 * - email() → Workspace email ingress (Cloudflare Email Routing)
 * - /agents/chat-thread/* → 410: the old in-DO chat transport (threads run on the agent runtime)
 * - * → React Router SSR
 */

import { createRequestHandler } from 'react-router';
import { DurableObject } from 'cloudflare:workers';
import type { Env, Route } from './types.js';
import { handleSlackEventsQueue } from './slack-events-queue.js';
import type { AppScreenshotJob } from './screenshot-queue.js';
import type { SlackEventQueueMessage } from './slack-types.js';
import type { DiscordEventQueueMessage } from './discord-types.js';
import {
  handleDiscordEventsDeadLetterQueue,
  handleDiscordEventsQueue,
} from './discord-events-queue.js';

// Route handlers
import { handleAdminMcp } from './routes/admin-mcp.js';
import { handleAgentMcp } from './routes/agent-mcp.js';
import { handleAgentRuntimeLlm } from './routes/agent-runtime-llm.js';
import { handleAgentRuntimeEvents } from './routes/agent-runtime-events.js';
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
import { handleOAuthMetadata, handleResourceMetadata } from './routes/well-known.js';
import { handleStripeWebhook } from './routes/billing.js';
import { handleWorkerAuth } from './routes/worker-auth.js';
import { text } from './helpers/response.js';

// Re-exports for wrangler
export {
  AdminJsExecDoBinding,
  AdminJsExecRuntimeBinding,
} from './routes/admin-mcp.js';
export { ChatThreadDO } from './chat-thread-do.js';
export { CodeModeToolsBinding } from './code-mode-tools.js';
export { UserDO, OrgDO } from './auth.js';
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
export {
  AnalysisConnectionsGateway,
  AnalysisContainer,
  AnalysisEgress,
} from './analysis-container.js';
export { ProjectBuildContainer } from './project-build-container.js';
export { DbQueryContainer } from './db-query-container.js';
// Native containers' R2 bucket mounts (sandbox-mounts.ts: S3Mount) send each storage
// request to this entrypoint, which signs it; the container never sees the key.
export { S3Gateway } from '@cloudflare/sandbox';

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

  // MCP tools for the hosted agent runtime (runtime identity-token auth)
  { method: 'ALL', path: /^\/mcp\/agent$/, handler: handleAgentMcp },
  // The runtime's Codex calls: the one model route chiridion still forwards (same token)
  { method: 'POST', path: /^\/agent-runtime\/llm\/openai-codex\/.+$/, handler: handleAgentRuntimeLlm },
  // The runtime's webhook events: runs, inputs and usage (Standard Webhooks signature)
  { method: 'POST', path: /^\/agent-runtime\/events$/, handler: handleAgentRuntimeEvents },

  // Stripe billing webhook
  { method: 'POST', path: /^\/api\/billing\/stripe\/webhook$/, handler: handleStripeWebhook },

  // OAuth discovery (well-known paths can't be React Router routes)
  { method: 'GET', path: /^\/\.well-known\/oauth-authorization-server(\/.*)?$/, handler: handleOAuthMetadata },
  { method: 'GET', path: /^\/\.well-known\/oauth-protected-resource(\/.*)?$/, handler: handleResourceMetadata },

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

  // The old in-DO chat transport (WebSocket, SSE, polling, calls): every
  // thread runs on the agent runtime now. A tab still open from before gets
  // an answer its client heals from (see oldChatTransport).
  { method: 'GET', path: /^\/agents\/chat-thread\/[^/]+$/, handler: async ({ req }) => oldChatTransport(req), websocket: true },
  { method: 'ALL', path: /^\/agents\/chat-thread\//, handler: async ({ req }) => oldChatTransport(req) },
  { method: 'ALL', path: /^\/agents\//, handler: async () => text('Not Found', 404) },

  // Workspace thread-status SSE stream (replaces the status WebSocket).
  { method: 'GET', path: /^\/api\/workspaces\/([^/]+)\/status\/stream$/, handler: handleWorkspaceStatusStream },
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

const CHAT_THREAD_MOVED = { status: 'moved', error: 'This conversation moved to the new chat engine; reload the page to continue it.' };

/**
 * The old chat transport, for a tab whose page was loaded before the in-DO
 * loop was deleted. Its client (sse-agent-client) falls back from a failed
 * WebSocket to HTTP polling, and a poll that answers opens the connection,
 * which runs the page's version-skew check: the tab reloads itself (when no
 * draft or turn would be lost) or offers "camelAI has been updated, Reload".
 * So a poll answers an empty, well-formed batch (its cursor echoed, no
 * frames: the client keeps polling, cheaply, until it reloads), and a call
 * (a send) answers 503, which the client retries after reconnecting, keeping
 * the message. The WebSocket and the legacy SSE stream answer 410 "moved";
 * a 410 on a poll would read as "You no longer have access to this chat".
 */
function oldChatTransport(req: Request): Response {
  const url = new URL(req.url);
  if (req.method === 'GET' && url.pathname.endsWith('/sse') && url.searchParams.get('transport') === 'poll') {
    const cursor = Number(url.searchParams.get('cursor'));
    return Response.json(
      { cursor: Number.isSafeInteger(cursor) ? cursor : -1, frames: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (req.method === 'POST' && url.pathname.endsWith('/call')) {
    return Response.json(CHAT_THREAD_MOVED, { status: 503, headers: { 'Retry-After': '30' } });
  }
  return Response.json(CHAT_THREAD_MOVED, { status: 410 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    // Only explicitly marked routes accept upgrades: chat. Other upgrade paths,
    // including retired workspace status and log-tail sockets, remain 404s.
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
      return new Response('Not Found', { status: 404 });
    }

    return reactRouterHandler(req, { cloudflare: { env, ctx } });
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await (await loadEmailIngressModule()).handleWorkspaceEmailIngress(message, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const { handleD1MirrorCron } = await import('./d1-mirror-cron.js');
    await handleD1MirrorCron(env, controller.scheduledTime);
    // The cloud thread sweep, once an operator started it (agent-runtime/cloud-sweep.ts).
    try {
      const { runCloudSweepCron } = await import('./agent-runtime/cloud-sweep.js');
      await runCloudSweepCron(env as unknown as Parameters<typeof runCloudSweepCron>[0]);
    } catch (error) {
      console.error('[runtime-migration-sweep] cron step failed', error);
    }
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
