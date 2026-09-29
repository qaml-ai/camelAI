/**
 * Admin REST API — Hono-based
 *
 * All endpoints require Bearer token auth via ADMIN_API_KEY secret.
 * If no Bearer token is present, returns null so the request falls through to
 * the rest of the worker (e.g. the OAuth-protected admin MCP).
 *
 * The OpenAPI 3.1 spec is auto-generated from the openApi() middleware
 * on each route via createOpenApiDocument(). No separate spec file needed.
 *
 * Routes:
 *   GET   /api/admin/openapi.json          — OpenAPI 3.1 spec (auto-generated)
 *   GET   /api/admin/stats                 — Aggregate counts
 *   GET   /api/admin/users                 — All users
 *   GET   /api/admin/users/:id/orgs        — User's orgs
 *   GET   /api/admin/spam/org-ids          — Spam org IDs from effective spend limits
 *   GET   /api/admin/orgs                  — All orgs (enriched)
 *   GET   /api/admin/orgs/llm-providers    — Orgs with BYOK LLM providers configured
 *   GET   /api/admin/dashboard/top-orgs    — Top orgs by spend or member count
 *   GET   /api/admin/dashboard/daily-spend — Cross-org daily spend aggregation
 *   GET   /api/admin/dashboard/summary     — Dashboard summary metrics
 *   GET   /api/admin/dashboard/retention   — Dashboard retention metrics
 *   GET   /api/admin/dashboard/spam-summary — Spam-tab entity + usage snapshot
 *   GET   /api/admin/chat-errors          — User-visible chat error dashboard data
 *   GET   /api/admin/discord/status       — Discord canary configuration and bridge health
 *   GET   /api/admin/threads               — All threads
 *   GET   /api/admin/threads/:id/messages  — Parsed thread messages
 *   POST  /api/admin/orgs/:id/credits      — Grant org credits manually
 *   POST  /api/admin/orgs/:id/custom-domain/refresh — Refresh org custom domain hostnames
 *   POST  /api/admin/orgs/:id/members      — Add member to org
 *   GET   /api/admin/orgs/:id/usage/users  — Per-user/model LLM usage
 *   GET/PUT /api/admin/orgs/:id/usage/users/:userId/limits — Rolling user limits
 *   GET/PUT /api/admin/orgs/:id/usage/pricing — Exact model pricing overrides
 *   PUT   /api/admin/signup-blocked-ips/:ip — Block signup attempts from an IP
 *   DELETE /api/admin/signup-blocked-ips/:ip — Remove an IP from the signup blocklist
 *   PATCH /api/admin/threads/:id           — Update thread
 *   GET   /api/admin/kv                    — List KV keys
 *   GET   /api/admin/kv/:key              — Get KV value
 *   GET   /api/admin/r2                    — List R2 objects
 *   GET   /api/admin/r2/:key+             — R2 object metadata
 *   POST  /api/admin/apps/:name/cost-controls — Re-apply user-app cost controls (backfill)
 *
 * Detail + management (management-routes.ts):
 *   GET/PATCH/DELETE /api/admin/users/:id  — Detail / edit / hard delete
 *   POST  /api/admin/users/:id/force-orphan, /reset-onboarding
 *   PATCH/DELETE /api/admin/orgs/:id       — Edit name+billing status / hard delete
 *   POST  /api/admin/orgs/:id/archive, /transfer-ownership
 *   GET   /api/admin/orgs/:id/members, /invitations, /audit-log
 *   PATCH /api/admin/orgs/:id/members/:userId — Change member role
 *   DELETE /api/admin/orgs/:id/invitations/:invitationId
 *   PATCH/DELETE /api/admin/orgs/:id/apps/:scriptName — Public flag / delete app
 *   GET   /api/admin/orgs/:id/apps/:scriptName/logs
 *   GET/PATCH /api/admin/workspaces/:id    — Detail / edit
 *   POST  /api/admin/workspaces/:id/archive; GET /api/admin/workspaces/:id/audit-log
 *   GET   /api/admin/invitations, /api/admin/chat-explorer
 *   POST  /api/admin/email/test
 *   GET|POST /api/admin/d1-mirror/backfill, GET /api/admin/d1-mirror/outbox,
 *   POST  /api/admin/d1-mirror/resync (DO -> D1 identity mirror ops)
 */

import { Hono } from 'hono';
import { createOpenApiDocument } from 'hono-zod-openapi';
import type { Env, RouteContext } from '../../types.js';
import { routes } from './routes.js';
import { managementRoutes } from './management-routes.js';
import { d1MirrorRoutes } from './d1-mirror-routes.js';
import { runtimeMigrationRoutes } from './runtime-migration-routes.js';

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

type HonoEnv = { Bindings: Env };

const app = new Hono<HonoEnv>().basePath('/api/admin');

// All admin routes (each has openApi() middleware for spec generation)
app.route('/', routes);
app.route('/', managementRoutes);
app.route('/', d1MirrorRoutes);
app.route('/', runtimeMigrationRoutes);

// Auto-generate and serve OpenAPI spec from route middleware declarations
createOpenApiDocument(app, {
  info: {
    title: 'camelAI Admin API',
    version: '1.0.0',
    description:
      'Internal admin API for managing users, orgs, threads, and storage. All endpoints require Bearer token auth via ADMIN_API_KEY.',
  },
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'ADMIN_API_KEY set via `wrangler secret put ADMIN_API_KEY`',
      },
    },
  },
}, { routeName: '/openapi.json' });

// Error handler
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  return c.json({ error: message }, 500);
});

// Authed requests to unknown paths → 404
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ---------------------------------------------------------------------------
// Export: wrapper that preserves the null-return contract
// ---------------------------------------------------------------------------

export async function handleAdminApi({ req, env }: RouteContext): Promise<Response | null> {
  // No Bearer token → fall through to React Router (session-auth admin routes)
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const key = env.ADMIN_API_KEY;
  if (!key) {
    return Response.json({ error: 'Admin API not configured' }, {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (auth !== `Bearer ${key}`) {
    return Response.json({ error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // This header is reserved for the already-authorized OAuth MCP bridge. A
  // bearer-key caller must not be able to forge the audit principal.
  const headers = new Headers(req.headers);
  headers.delete('x-admin-mcp-user-id');
  return app.fetch(new Request(req, { headers }), env);
}

/**
 * Delegate to the admin API after an upstream caller has already performed
 * equivalent authorization. This is used by the OAuth-protected admin MCP
 * bridge so admin API handlers remain the single implementation.
 */
export function fetchAdminApiWithValidatedAuth(req: Request, env: Env): Promise<Response> {
  return app.fetch(req, env);
}
