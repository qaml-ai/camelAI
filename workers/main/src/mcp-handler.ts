/**
 * MCP Server Handler
 *
 * Handles MCP protocol requests authenticated via sandbox host proxy.
 * Uses the agents package with streamable HTTP transport.
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OrgDO, WorkerScript } from './auth';
import type { ChatThreadDO, PreviewTarget } from './chat-thread-do';
import type { WorkspaceCronDO } from './workspace-cron';
import {
  getAllIntegrations,
  getIntegrationsByCategory,
  getIntegrationDefinition,
  shouldStoreIntegrationCredentials,
  validateConfig,
  validateCredentials,
} from '../../../src/lib/integration-registry';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { getProviderMcpDefinition } from '../../../src/lib/provider-mcp-registry';
import { normalizeRemoteMcpUrl, validateRemoteMcpConnection } from '../../../src/lib/remote-mcp';
import { validateSandboxProxy } from './sandbox-auth';
import {
  createOrRefreshCustomHostname,
  deleteCustomHostname,
  findCustomHostnameByHostname,
  getCustomHostnameStatus,
} from './cf-api-proxy';
import type { WorkerLogsDO } from './worker-logs-do';
import { getPreferredAppUrl, isAppCustomDomainReady } from '../../../src/lib/app-url';
import {
  buildCustomDomainDnsCheck,
  getCustomHostnameDnsTarget,
  type CnameLookupResult,
  type CustomDomainDnsCheck,
} from '../../../src/lib/custom-domain-dns';
import {
  getAppCustomDomainDiagnosticState,
  shouldRefreshAppCustomDomainState,
  shouldRetryAppCustomDomainProvisioning,
} from '../../../src/lib/custom-domain-state';
import { parseFilePreviewPath } from './preview-paths';
import { formatDeterministicAutomation } from './code-mode-deterministic-automations';
import {
  discordChannelCatalogAvailable,
  type DiscordBridgeFetcher,
} from './discord-types';

export interface McpEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  MCP_OBJECT: DurableObjectNamespace<ChiridionMcp>;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  APP_KV: KVNamespace;
  SANDBOX_PROXY_SECRET?: string;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  INTEGRATION_SECRET_KEY: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
  ASSETS?: Fetcher;
  IMAGES?: ImagesBinding;
  NEXTJS_ENV?: string;
  WORKER_BASE_URL?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
  WORKER_SELF_REFERENCE?: Fetcher;
  APP_DB?: D1Database;
  RUN_AGENT_EVALS?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  DISCORD_CHANNEL_ENABLED?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BRIDGE?: DiscordBridgeFetcher;
}

// Headers used to pass auth context to the MCP DO
const AUTH_HEADER_ORG_ID = 'x-chiridion-org-id';
const AUTH_HEADER_USER_ID = 'x-chiridion-user-id';
const AUTH_HEADER_WORKSPACE_ID = 'x-chiridion-workspace-id';
const AUTH_HEADER_THREAD_ID = 'x-chiridion-thread-id';

function hasNonEmptyCredentialValue(credentials: Record<string, unknown>): boolean {
  return Object.values(credentials).some((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  });
}

function hasTelegramDefaultRecipient(config: Record<string, unknown>): boolean {
  return typeof config.chat_id === 'string' && config.chat_id.trim().length > 0;
}

function telegramRoutingNote(config: Record<string, unknown>): string {
  return hasTelegramDefaultRecipient(config)
    ? 'Default Telegram recipient is configured for this connection; pass integration_id when more than one Telegram connection exists.'
    : 'No default Telegram recipient is configured yet; ask the user to connect Telegram first.';
}

function recommendedIntegrationAccess(
  integrationId: string,
  integrationType: string,
  config: Record<string, unknown> = {}
): Record<string, unknown> {
  if (integrationType === 'telegram') {
    return {
      tool: 'js_exec',
      inspect_methods: 'await env.CONNECTIONS.methods()',
      call_pattern: `await tools.send_telegram_message({ integration_id: ${JSON.stringify(integrationId)}, text: "..." })`,
      connection_id: integrationId,
      recommended_actions: [
        {
          name: 'send_telegram_message',
          tool: 'tools.send_telegram_message',
          usage: `await tools.send_telegram_message({ integration_id: ${JSON.stringify(integrationId)}, text: "..." })`,
          description: 'Send a Telegram message from js_exec through this connected Telegram channel.',
          routing: telegramRoutingNote(config),
        },
      ],
      routing: telegramRoutingNote(config),
    };
  }
  if (integrationType === 'discord_channel') {
    return {
      tool: 'js_exec',
      inspect_methods: 'await env.CONNECTIONS.methods()',
      call_pattern: `await tools.send_discord_message({ integration_id: ${JSON.stringify(integrationId)}, text: "..." })`,
      connection_id: integrationId,
      recommended_actions: [
        {
          name: 'send_discord_message',
          tool: 'tools.send_discord_message',
          usage: `await tools.send_discord_message({ integration_id: ${JSON.stringify(integrationId)}, text: "..." })`,
          description: 'Send a message through this native Discord channel.',
          routing: 'The destination is fixed by the selected integration; never supply Discord channel or thread ids.',
        },
      ],
    };
  }
  return {
    tool: 'js_exec',
    inspect_methods: 'await env.CONNECTIONS.methods()',
    call_pattern: 'await connections.<alias>.<method>({ ...input })',
    connection_id: integrationId,
  };
}

/**
 * MCP Agent implementation with deployment management tools
 */
export class ChiridionMcp extends McpAgent<any, Record<string, unknown>, Record<string, unknown>> {
  declare env: McpEnv;

  server = new McpServer({
    name: 'chiridion-mcp',
    version: '1.0.0',
  });

  // Auth context extracted from request headers (resolved per request)
  private orgId: string | null = null;
  private orgSlug: string | null = null;
  private userId: string | null = null;
  private workspaceId: string | null = null;
  private threadId: string | null = null;

  /**
   * Override fetch to extract auth context from headers before processing
   */
  async fetch(request: Request): Promise<Response> {
    const t0 = performance.now();
    // Extract auth context from headers (set by handleMcpRequest)
    this.orgId = request.headers.get(AUTH_HEADER_ORG_ID);
    this.userId = request.headers.get(AUTH_HEADER_USER_ID);
    this.workspaceId = request.headers.get(AUTH_HEADER_WORKSPACE_ID);
    this.threadId = request.headers.get(AUTH_HEADER_THREAD_ID);

    // Call parent fetch to handle MCP protocol
    const response = await super.fetch(request);
    console.log(`[MCP DO] ${request.method} fetch completed in ${(performance.now() - t0).toFixed(0)}ms`);
    return response;
  }

  /**
   * Get OrgDO stub for the current org
   */
  private getOrgStub(): DurableObjectStub<OrgDO> {
    if (!this.orgId) throw new Error('No org context');
    return this.env.ORG.get(this.env.ORG.idFromName(this.orgId)) as DurableObjectStub<OrgDO>;
  }

  /**
   * Get ChatThreadDO stub for a thread
   */
  private getChatThreadStub(threadId: string): DurableObjectStub<ChatThreadDO> {
    return this.env.CHAT_THREAD.get(this.env.CHAT_THREAD.idFromName(threadId)) as DurableObjectStub<ChatThreadDO>;
  }

  /**
   * Get WorkspaceCronDO stub for a workspace.
   */
  private getWorkspaceCronStub(workspaceId: string): DurableObjectStub<WorkspaceCronDO> {
    if (!this.env.WORKSPACE_CRON) {
      throw new Error('Workspace scheduler binding is not configured');
    }
    return this.env.WORKSPACE_CRON.get(
      this.env.WORKSPACE_CRON.idFromName(workspaceId)
    ) as DurableObjectStub<WorkspaceCronDO>;
  }

  /**
   * Require auth context, throwing if not available
   */
  private requireAuth(): { orgId: string; userId: string; workspaceId: string | null } {
    if (!this.orgId || !this.userId) {
      throw new Error('Authentication context not available');
    }
    return { orgId: this.orgId, userId: this.userId, workspaceId: this.workspaceId };
  }

  /**
   * Create a text response for MCP tools
   */
  private textResponse(data: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  /**
   * Get the org slug, fetching from OrgDO if not cached.
   */
  private async getOrgSlug(): Promise<string | null> {
    if (this.orgSlug) return this.orgSlug;
    if (!this.orgId) return null;
    try {
      const orgStub = this.getOrgStub();
      this.orgSlug = await orgStub.getSlug();
      return this.orgSlug;
    } catch {
      return null;
    }
  }

  private async refreshScriptCustomDomainState(
    script: WorkerScript
  ): Promise<WorkerScript> {
    const zoneId = this.env.CF_ZONE_ID?.trim();
    const apiToken = this.env.CF_API_TOKEN?.trim();
    if (!script.custom_domain_hostname || !zoneId || !apiToken || isAppCustomDomainReady(script)) {
      return script;
    }

    const expectedHostname = script.custom_domain_hostname;
    let record = null;

    if (script.custom_domain_cf_hostname_id && script.custom_domain_hostname === expectedHostname) {
      record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
    }

    if (!record) {
      record = await findCustomHostnameByHostname(zoneId, apiToken, expectedHostname);
    }

    if (!record) {
      return script;
    }

    const orgStub = this.getOrgStub();
    return (
      await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
        hostname: expectedHostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
      })
    ) ?? script;
  }

  /**
   * Get the full URL for a deployed app.
   * New-style slugs (6+ alphanumeric) use single hyphen, old-style use double.
   */
  private async getAppUrl(script: WorkerScript): Promise<string> {
    let refreshedScript = script;
    let appHostname = 'camelai.dev';
    try {
      refreshedScript = await this.refreshScriptCustomDomainState(script);
    } catch {}

    if (this.env.WORKER_BASE_URL) {
      try {
        appHostname = new URL(this.env.WORKER_BASE_URL).host;
      } catch {}
    }

    const orgSlug = await this.getOrgSlug();
    return getPreferredAppUrl(refreshedScript, {
      hostname: {
        hostname: appHostname,
        vanityDomain: this.env.LOCAL_APP_VANITY_DOMAIN,
        iframeDomain: this.env.LOCAL_APP_IFRAME_DOMAIN,
      },
      orgSlug: orgSlug ?? undefined,
      orgCustomDomain: null,
    });
  }

  private encodePathSegments(path: string): string {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  async init() {
    // ==========================================
    // Deployment Management Tools
    // ==========================================

    // List deployed apps/workers
    this.server.tool(
      'list_apps',
      'List deployed apps/workers for the current workspace. Returns script names, URLs, visibility status, and creation info.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();
        const scripts = (await orgStub.listWorkerScriptsByWorkspace(workspaceId))
          .sort((a, b) => b.updated_at - a.updated_at);

        const apps = await Promise.all(scripts.map(async (s: WorkerScript) => ({
          name: s.script_name,
          url: await this.getAppUrl(s),
          is_public: s.is_public,
          created_by: s.created_by,
          created_at: new Date(s.created_at).toISOString(),
          updated_at: new Date(s.updated_at).toISOString(),
          preview_status: s.preview_status,
        })));

        return this.textResponse({ count: apps.length, apps });
      }
    );

    // Set app visibility (public/private)
    this.server.tool(
        'set_app_visibility',
        'Change the visibility of a deployed app in the current workspace. Public apps are accessible to anyone, private apps require authentication.',
        {
          script_name: z.string().describe('The name of the app/worker script'),
          is_public: z.boolean().describe('Set to true for public access, false for private (org members only)'),
        },
        async ({ script_name, is_public }) => {
          const { userId, workspaceId } = this.requireAuth();
          if (!workspaceId) {
            return this.textResponse({ error: 'No workspace context available' });
          }

          const orgStub = this.getOrgStub();

          // Verify script belongs to current workspace
          const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
          if (!script) {
            return this.textResponse({ success: false, error: `App '${script_name}' not found` });
          }
          if (script.workspace_id !== workspaceId) {
            return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
          }

          const result = await orgStub.setWorkerScriptPublic(script_name, is_public, userId);
          if (!result) {
            return this.textResponse({ success: false, error: `Failed to update app '${script_name}'` });
          }

          return this.textResponse({
            success: true,
            app: {
              name: result.script_name,
              url: await this.getAppUrl(result),
              is_public: result.is_public,
              updated_at: new Date(result.updated_at).toISOString(),
            },
            message: `App '${script_name}' is now ${is_public ? 'public' : 'private'}`,
          });
        }
    );

    // Set preview panel to a file
    this.server.tool(
      'set_file_preview',
      'Set the chat preview panel to a file path. Supports explicit location="workspace", location="project" or "vm" with project, and location="r2" for R2 paths like uploads/... or outputs/....',
      {
        path: z
          .string()
          .describe('Path to preview. Examples: "/workspace/README.md", "src/app.tsx", "outputs/plot.png", "uploads/notebook.ipynb"'),
        location: z
          .enum(['workspace', 'project', 'vm', 'r2'])
          .optional()
          .describe('Set to "workspace" for durable workspace files, "project" for DO-backed project files, "vm" for project VM files, or "r2" for uploads/... / outputs/... paths.'),
        project: z
          .string()
          .optional()
          .describe('Project name when location is "project" or "vm".'),
        content_type: z
          .string()
          .optional()
          .describe('Optional MIME type hint (for example "application/x-ipynb+json" or "image/png").'),
      },
      async ({ path, location, project, content_type }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        if (location !== 'project' && location !== 'vm' && project?.trim()) {
          return this.textResponse({
            success: false,
            error: 'project is only valid with location="project" or location="vm"',
          });
        }

        // Thread ID comes from the proxy auth headers
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available.',
          });
        }

        let parsedPath = parseFilePreviewPath(path);
        let source: Extract<PreviewTarget, { kind: 'file' }>['source'];
        if (location === 'workspace' || location === 'project') {
          parsedPath = parseFilePreviewPath(path.startsWith('/') ? path : `/${path}`);
          if (!parsedPath || parsedPath.source !== 'workspace') {
            return this.textResponse({
              success: false,
              error: 'Invalid file path. Use a workspace path without ".." segments.',
            });
          }
          source = location;
        } else if (location === 'r2') {
          if (!parsedPath || parsedPath.source === 'workspace') {
            return this.textResponse({
              success: false,
              error: 'R2 preview path must start with uploads/... or outputs/... without ".." segments.',
            });
          }
          source = parsedPath.source;
        } else {
          if (!parsedPath) {
            return this.textResponse({
              success: false,
              error: 'Invalid file path. Use a workspace path, uploads/..., or outputs/... without ".." segments.',
            });
          }
          source = parsedPath.source;
        }

        const target: PreviewTarget = {
          kind: 'file',
          source,
          workspaceId,
          path: parsedPath.path,
          project: source === 'project' ? project?.trim() : undefined,
          filename: parsedPath.filename,
          contentType: typeof content_type === 'string' && content_type.trim() ? content_type.trim() : undefined,
        };
        if (target.source === 'project' && !target.project) {
          return this.textResponse({
            success: false,
            error: `project is required when previewing a project file`,
          });
        }

        const chatThreadStub = this.getChatThreadStub(threadId);
        await chatThreadStub.setPreviewTarget(target);

        const normalizedPath = target.path.replace(/^\/+/, '');
        const encodedPath = this.encodePathSegments(normalizedPath);
        const route = target.source === 'project'
          ? `projects/${encodeURIComponent(target.project ?? '')}/fs/content/${encodedPath}`
          : target.source === 'workspace'
          ? `fs/content/${encodedPath}`
          : `${target.source === 'upload' ? 'uploads' : 'outputs'}/${encodedPath}`;
        const previewUrl = `/api/workspaces/${workspaceId}/${route}`;

        return this.textResponse({
          success: true,
          target,
          preview_url: previewUrl,
          message: `Preview set to ${target.path}`,
        });
      }
    );

    // Set preview panel to a deployed app
    this.server.tool(
      'set_app_preview',
      'Set the chat preview panel to a deployed app in the current workspace.',
      {
        script_name: z.string().describe('The name of the deployed app/worker script to preview.'),
      },
      async ({ script_name }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        // Thread ID comes from the proxy auth headers
        const threadId = this.threadId;
        if (!threadId) {
          return this.textResponse({
            success: false,
            error: 'No thread context available.',
          });
        }

        const orgStub = this.getOrgStub();
        const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
        if (!script) {
          return this.textResponse({ success: false, error: `App '${script_name}' not found` });
        }
        if (script.workspace_id !== workspaceId) {
          return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
        }

        const target: PreviewTarget = {
          kind: 'app',
          scriptName: script.script_name,
          isPublic: script.is_public,
        };

        const chatThreadStub = this.getChatThreadStub(threadId);
        await chatThreadStub.setPreviewTarget(target);

        return this.textResponse({
          success: true,
          target,
          app: {
            name: script.script_name,
            url: await this.getAppUrl(script),
            is_public: script.is_public,
          },
          message: `Preview set to app '${script.script_name}'`,
        });
      }
    );

    // Get recent logs for a deployed app
    this.server.tool(
      'get_latest_logs',
      'Get recent runtime logs for a deployed app in the current workspace. Returns console and exception events captured by the tail worker.',
      {
        script_name: z.string().min(1).describe('The app/worker script name to fetch logs for.'),
        limit: z.number().int().min(1).max(500).optional().describe('Maximum number of log entries to return (default 100, max 500).'),
        since_ms: z.number().int().min(0).optional().describe('Optional lower-bound timestamp in milliseconds; only logs newer than this are returned.'),
      },
      async ({ script_name, limit = 100, since_ms }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        const orgStub = this.getOrgStub();
        const script: WorkerScript | null = await orgStub.getWorkerScript(script_name);
        if (!script) {
          return this.textResponse({ success: false, error: `App '${script_name}' not found` });
        }
        if (script.workspace_id !== workspaceId) {
          return this.textResponse({ success: false, error: `App '${script_name}' belongs to a different workspace` });
        }

        const orgSlug = await this.getOrgSlug();
        // Security: do not fall back to unscoped legacy keys when an org slug exists.
        const storageKey = orgSlug ? `${script_name}--${orgSlug}` : script_name;
        const logsStub = this.env.WORKER_LOGS.get(this.env.WORKER_LOGS.idFromName(storageKey));
        const [logs, stats] = await Promise.all([
          logsStub.getLogs({ limit, since: since_ms }),
          logsStub.getStats(),
        ]);

        return this.textResponse({
          success: true,
          script: {
            name: script_name,
            storage_key: storageKey,
            dispatch_name: storageKey,
          },
          count: logs.length,
          limit,
          since_ms: since_ms ?? null,
          stats: {
            total_log_count: stats.logCount,
            last_log_at_ms: stats.lastLogAt,
            last_log_at: stats.lastLogAt ? new Date(stats.lastLogAt).toISOString() : null,
          },
          logs: logs.map((entry) => ({
            id: entry.id,
            timestamp_ms: entry.timestamp,
            timestamp: new Date(entry.timestamp).toISOString(),
            level: entry.level,
            message: entry.message,
            exception: entry.exception,
            script_version: entry.scriptVersion,
          })),
        });
      }
    );

    // ==========================================
    // Scheduled Prompt Tools
    // ==========================================

    const formatScheduledPrompt = (prompt: {
      id: string;
      name: string;
      prompt: string;
      cron_expression: string;
      thread_id: string;
      scheduled_by_thread_id: string | null;
      enabled: boolean;
      created_by: string;
      created_at: number;
      updated_at: number;
      next_run_at: number | null;
      last_run_at: number | null;
      last_run_status: string | null;
      last_run_error: string | null;
      run_count: number;
    }) => ({
      id: prompt.id,
      name: prompt.name,
      prompt: prompt.prompt,
      cron_expression: prompt.cron_expression,
      thread_id: prompt.thread_id,
      scheduled_by_thread_id: prompt.scheduled_by_thread_id,
      enabled: prompt.enabled,
      created_by: prompt.created_by,
      created_at: new Date(prompt.created_at).toISOString(),
      updated_at: new Date(prompt.updated_at).toISOString(),
      next_run_at: prompt.next_run_at ? new Date(prompt.next_run_at).toISOString() : null,
      last_run_at: prompt.last_run_at ? new Date(prompt.last_run_at).toISOString() : null,
      last_run_status: prompt.last_run_status,
      last_run_error: prompt.last_run_error,
      run_count: prompt.run_count,
    });

    const workflowIdSchema = z
      .string()
      .trim()
      .min(1)
      .describe('ID of the workflow');
    const workflowIdentifierInputSchema = z.object({
      workflow_id: workflowIdSchema,
    });
    const workflowUpdateFields = {
      name: z.string().optional().describe('Optional new display name'),
      source: z.string().optional().describe('Optional new source'),
      cron_expression: z.string().optional().describe('Optional new 5-field UTC cron expression'),
      description: z.string().optional().describe('Optional new description'),
      enabled: z.boolean().optional().describe('Optional enabled state'),
    };
    const workflowUpdateInputSchema = z.object({
      workflow_id: workflowIdSchema.describe('ID of the workflow to update'),
      ...workflowUpdateFields,
    });

    this.server.tool(
      'list_scheduled_prompts',
      'List scheduled prompts for the current workspace. Cron expressions use 5 fields in UTC: minute hour day-of-month month day-of-week.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const prompts = await schedulerStub.listScheduledPrompts(workspaceId);

          return this.textResponse({
            success: true,
            count: prompts.length,
            timezone: 'UTC',
            prompts: prompts.map((prompt) => formatScheduledPrompt(prompt)),
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'create_scheduled_prompt',
      'Create a scheduled prompt in the current workspace. The cron expression is evaluated in UTC, and a dedicated thread is created for this schedule automatically.',
      {
        name: z.string().describe('Friendly name for the scheduled prompt'),
        prompt: z.string().describe('Prompt text to send when the schedule fires'),
        cron_expression: z
          .string()
          .describe('5-field cron expression in UTC: minute hour day-of-month month day-of-week'),
        enabled: z
          .boolean()
          .optional()
          .describe('Optional. Defaults to true. Set false to create a paused schedule.'),
      },
      async ({ name, prompt, cron_expression, enabled }) => {
        const { userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const created = await schedulerStub.createScheduledPrompt({
            workspaceId,
            name,
            prompt,
            cronExpression: cron_expression,
            createdBy: userId,
            scheduledByThreadId: this.threadId,
            enabled,
          });

          return this.textResponse({
            success: true,
            timezone: 'UTC',
            scheduled_prompt: formatScheduledPrompt(created),
            message: `Created scheduled prompt "${created.name}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'update_scheduled_prompt',
      'Update an existing scheduled prompt in the current workspace.',
      {
        prompt_id: z.string().describe('ID of the scheduled prompt to update'),
        name: z.string().optional().describe('Optional new display name'),
        prompt: z.string().optional().describe('Optional new prompt text'),
        cron_expression: z
          .string()
          .optional()
          .describe('Optional new 5-field UTC cron expression'),
        enabled: z
          .boolean()
          .optional()
          .describe('Optional enabled state'),
      },
      async ({ prompt_id, name, prompt, cron_expression, enabled }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const updated = await schedulerStub.updateScheduledPrompt({
            workspaceId,
            id: prompt_id,
            name,
            prompt,
            cronExpression: cron_expression,
            enabled,
          });

          if (!updated) {
            return this.textResponse({
              success: false,
              error: `Scheduled prompt "${prompt_id}" not found`,
            });
          }

          return this.textResponse({
            success: true,
            timezone: 'UTC',
            scheduled_prompt: formatScheduledPrompt(updated),
            message: `Updated scheduled prompt "${updated.name}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'delete_scheduled_prompt',
      'Delete a scheduled prompt from the current workspace.',
      {
        prompt_id: z.string().describe('ID of the scheduled prompt to delete'),
      },
      async ({ prompt_id }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const deleted = await schedulerStub.deleteScheduledPrompt(workspaceId, prompt_id);
          if (!deleted) {
            return this.textResponse({
              success: false,
              error: `Scheduled prompt "${prompt_id}" not found`,
            });
          }

          return this.textResponse({
            success: true,
            message: `Deleted scheduled prompt "${prompt_id}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'run_scheduled_prompt_now',
      'Trigger a scheduled prompt immediately without waiting for its next cron time.',
      {
        prompt_id: z.string().describe('ID of the scheduled prompt to run now'),
      },
      async ({ prompt_id }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }

        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const result = await schedulerStub.runScheduledPromptNow(workspaceId, prompt_id);
          if (!result) {
            return this.textResponse({
              success: false,
              error: `Scheduled prompt "${prompt_id}" not found`,
            });
          }

          return this.textResponse({
            success: true,
            timezone: 'UTC',
            scheduled_prompt: formatScheduledPrompt(result.prompt),
            run: {
              status: result.dispatch.status,
              thread_id: result.dispatch.thread_id,
              error: result.dispatch.error,
            },
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'list_workflows',
      'List workflows for the current workspace. Workflows are deterministic JavaScript code that runs on a schedule. Cron expressions use 5 fields in UTC: minute hour day-of-month month day-of-week.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const automations = await schedulerStub.listDeterministicAutomations(workspaceId);
          const workflows = automations.map((automation) => formatDeterministicAutomation(automation));
          return this.textResponse({
            success: true,
            count: automations.length,
            timezone: 'UTC',
            workflows,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.tool(
      'validate_workflow',
      'Validate workflow source without saving it.',
      {
        source: z.string().describe('JavaScript module source exporting AutomationWorkflow'),
      },
      async ({ source }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const result = await schedulerStub.validateDeterministicAutomationSource(source);
          return this.textResponse({ success: result.valid, ...result });
        } catch (error) {
          return this.textResponse({
            success: false,
            valid: false,
            errors: [error instanceof Error ? error.message : String(error)],
          });
        }
      }
    );

    this.server.tool(
      'create_workflow',
      'Create a workflow in the current workspace.',
      {
        name: z.string().describe('Friendly name for the workflow'),
        source: z.string().describe('JavaScript module source exporting AutomationWorkflow'),
        cron_expression: z
          .string()
          .describe('5-field cron expression in UTC: minute hour day-of-month month day-of-week'),
        description: z.string().describe('Required description of what the workflow does'),
        enabled: z.boolean().optional().describe('Optional. Defaults to true.'),
      },
      async ({ name, source, cron_expression, description, enabled }) => {
        const { userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const created = await schedulerStub.createDeterministicAutomation({
            workspaceId,
            name,
            source,
            cronExpression: cron_expression,
            createdBy: userId,
            description,
            enabled,
          });
          return this.textResponse({
            success: true,
            timezone: 'UTC',
            workflow: formatDeterministicAutomation(created, true),
            message: `Created workflow "${created.name}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.registerTool(
      'update_workflow',
      {
        description: 'Update an existing workflow.',
        inputSchema: workflowUpdateInputSchema,
      },
      async ({ workflow_id, name, source, cron_expression, description, enabled }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const updated = await schedulerStub.updateDeterministicAutomation({
            workspaceId,
            id: workflow_id,
            name,
            source,
            cronExpression: cron_expression,
            description,
            enabled,
          });
          if (!updated) {
            return this.textResponse({
              success: false,
              error: `Workflow "${workflow_id}" not found`,
            });
          }
          return this.textResponse({
            success: true,
            timezone: 'UTC',
            workflow: formatDeterministicAutomation(updated, true),
            message: `Updated workflow "${updated.name}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.registerTool(
      'delete_workflow',
      {
        description: 'Delete a workflow from the current workspace.',
        inputSchema: workflowIdentifierInputSchema,
      },
      async ({ workflow_id }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const deleted = await schedulerStub.deleteDeterministicAutomation(workspaceId, workflow_id);
          if (!deleted) {
            return this.textResponse({
              success: false,
              error: `Workflow "${workflow_id}" not found`,
            });
          }
          return this.textResponse({
            success: true,
            workflow_id,
            message: `Deleted workflow "${workflow_id}"`,
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    this.server.registerTool(
      'run_workflow_now',
      {
        description: 'Start a workflow immediately without waiting for its next cron time.',
        inputSchema: workflowIdentifierInputSchema,
      },
      async ({ workflow_id }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ success: false, error: 'No workspace context available' });
        }
        try {
          const schedulerStub = this.getWorkspaceCronStub(workspaceId);
          const result = await schedulerStub.runDeterministicAutomationNow(workspaceId, workflow_id);
          if (!result) {
            return this.textResponse({
              success: false,
              error: `Workflow "${workflow_id}" not found`,
            });
          }
          const workflow = formatDeterministicAutomation(result.automation);
          return this.textResponse({
            success: true,
            timezone: 'UTC',
            workflow,
            run: {
              status: result.dispatch.status,
              instance_id: result.dispatch.instance_id,
              error: result.dispatch.error,
            },
          });
        } catch (error) {
          return this.textResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    );

    // ==========================================
    // Integration Tools
    // ==========================================

    // List configured integrations
    this.server.tool(
      'list_integrations',
      'List configured integrations (Stripe, Notion, GitHub, etc.) for the current workspace.',
      {
        category: z
          .enum(['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'])
          .optional()
          .describe('Optional category to filter integrations'),
      },
      async ({ category }) => {
        const { workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        const rawIntegrations = await this.getOrgStub().getWorkspaceIntegrations(workspaceId);

        // Map from DO format to Integration type (including config for dynamic field detection)
        const integrations = rawIntegrations.map(r => {
          let parsedConfig: Record<string, unknown> = {};
          try {
            parsedConfig = r.config ? JSON.parse(r.config) : {};
          } catch {
            // Ignore parse errors
          }
          return {
            id: r.id,
            integration_type: r.integration_type,
            name: r.name,
            category: r.category,
            auth_method: r.auth_method,
            has_credentials: Boolean(r.credentials_encrypted),
            created_at: r.created_at,
            updated_at: r.updated_at,
            config: parsedConfig,
          };
        });

        let filtered = integrations;
        if (category) {
          filtered = filtered.filter((i) => i.category === category);
        }

        const result = filtered.map((i) => ({
          id: i.id,
          type: i.integration_type,
          name: i.name,
          category: i.category,
          auth_method: i.auth_method,
          has_credentials: i.has_credentials,
          created_at: new Date(i.created_at).toISOString(),
          updated_at: new Date(i.updated_at).toISOString(),
          recommended_access: recommendedIntegrationAccess(i.id, i.integration_type, i.config),
          display_name: i.integration_type === 'other' && i.config.display_name
            ? (i.config.display_name as string)
            : undefined,
        }));

        return this.textResponse({ count: result.length, integrations: result });
      }
    );

    // List available integration types
    this.server.tool(
      'list_integration_types',
      'List all available integration types that can be configured (Stripe, Notion, PostgreSQL, etc.). Returns schemas and MCP capability hints. Use integration_type "remote_mcp" for a native remote MCP server.',
      {
        category: z
          .enum(['databases', 'saas', 'ai_services', 'cloud_providers', 'communication'])
          .optional()
          .describe('Optional category to filter integration types'),
      },
      async ({ category }) => {
        const catalogOptions = {
          includeFeatureGated: await discordChannelCatalogAvailable(this.env),
        };
        const integrations = category
          ? getIntegrationsByCategory(category, catalogOptions)
          : getAllIntegrations(catalogOptions);

        const types = integrations.map((def) => ({
          connection_kind:
            def.type === 'remote_mcp'
              ? 'native_remote_mcp'
              : getProviderMcpDefinition(def.type)
                ? 'brokered_mcp'
                : 'api',
          type: def.type,
          display_name: def.displayName,
          description: def.description,
          category: def.category,
          auth_method: def.authMethod,
          config_fields: def.configSchema.map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            required: f.required,
            description: f.description,
          })),
          credential_fields: def.credentialSchema.map((f) => ({
            name: f.name,
            label: f.label,
            required: f.required,
            description: f.description,
          })),
          supports_proxy: false,
          supports_native_mcp_connection: def.type === 'remote_mcp',
          supports_brokered_mcp_tools: def.type === 'remote_mcp' || Boolean(getProviderMcpDefinition(def.type)),
          setup_hint:
            def.type === 'remote_mcp'
              ? 'Use this type for native remote MCP servers. Provide config.server_url and config.auth_type; use auth_type oauth for MCP OAuth/DCR servers, bearer/custom_header with credentials.token for token auth, or none for public servers.'
              : undefined,
        }));

        // Group by category for easier reading
        const byCategory: Record<string, typeof types> = {};
        for (const t of types) {
          if (!byCategory[t.category]) {
            byCategory[t.category] = [];
          }
          byCategory[t.category].push(t);
        }

        return this.textResponse({
          total_count: types.length,
          by_category: byCategory,
        });
      }
    );

    // Create a new integration
    this.server.tool(
      'create_integration',
      'Create a new integration/connection for the current workspace. Use list_integration_types to see available types and their required config/credential fields. Use integration_type "remote_mcp" for native remote MCP servers.',
      {
        integration_type: z.string().describe('The type of integration (e.g., "stripe", "notion", "postgres", "other")'),
        name: z.string().describe('A friendly name for this connection (e.g., "Production Stripe", "My Notion Workspace")'),
        config: z
          .any()
          .optional()
          .describe('Configuration fields as an object (varies by type). For "other" type, include display_name, description, base_url, auth_type, auth_header.'),
        credentials: z
          .any()
          .optional()
          .describe('Credential fields as an object (e.g., api_key, api_secret, client_id, client_secret). These are encrypted at rest.'),
      },
      async ({ integration_type, name, config = {}, credentials = {} }) => {
        const { userId, workspaceId } = this.requireAuth();
        if (!workspaceId) {
          return this.textResponse({ error: 'No workspace context available' });
        }

        // Validate integration type
        const definition = getIntegrationDefinition(integration_type);
        if (!definition) {
          return this.textResponse({
            success: false,
            error: `Unknown integration type: ${integration_type}. Use list_integration_types to see available types.`,
          });
        }
        if (
          definition.featureGate === 'discord_channel' &&
          !(await discordChannelCatalogAvailable(this.env))
        ) {
          return this.textResponse({
            success: false,
            error: 'Discord channel connections are not available in this environment.',
          });
        }

        // Validate config fields
        const configErrors = validateConfig(integration_type, config as Record<string, unknown>);
        if (configErrors.length > 0) {
          return this.textResponse({
            success: false,
            error: 'Invalid configuration',
            validation_errors: configErrors,
          });
        }

        // Validate credential fields
        const credentialErrors = validateCredentials(integration_type, credentials as Record<string, unknown>);
        if (credentialErrors.length > 0) {
          return this.textResponse({
            success: false,
            error: 'Invalid credentials',
            validation_errors: credentialErrors,
          });
        }

        try {
          let finalConfig = config as Record<string, unknown>;
          const credentialPayload = credentials as Record<string, unknown>;
          if (integration_type === 'remote_mcp') {
            const validationErrors = validateRemoteMcpConnection(finalConfig, credentialPayload);
            if (validationErrors.length > 0) {
              return this.textResponse({
                success: false,
                error: 'Invalid remote MCP connection',
                validation_errors: validationErrors,
              });
            }
            finalConfig = {
              ...finalConfig,
              server_url: normalizeRemoteMcpUrl(String(finalConfig.server_url)),
            };
          }

          // Encrypt credentials
          const shouldStoreCredentials =
            integration_type === 'remote_mcp'
              ? hasNonEmptyCredentialValue(credentialPayload)
              : shouldStoreIntegrationCredentials(integration_type, credentialPayload);
          const credentialsEncrypted = shouldStoreCredentials
            ? await encryptCredentials(credentialPayload, this.env.INTEGRATION_SECRET_KEY)
            : '';

          // Generate ID and create integration
          const integrationId = crypto.randomUUID();
          await this.getOrgStub().createWorkspaceIntegration(
            workspaceId,
            integrationId,
            integration_type,
            name,
            definition.category,
            definition.authMethod,
            JSON.stringify(finalConfig),
            credentialsEncrypted,
            userId
          );

          return this.textResponse({
            success: true,
            integration: {
              id: integrationId,
              type: integration_type,
              name,
              category: definition.category,
              recommended_access: recommendedIntegrationAccess(integrationId, integration_type, finalConfig),
            },
            ...(integration_type === 'remote_mcp' && finalConfig.auth_type === 'oauth'
              ? {
                  oauth_url: `/api/integrations/remote_mcp/oauth?${new URLSearchParams({
                    integration_id: integrationId,
                    redirect: '/connections',
                  }).toString()}`,
                }
              : {}),
            message:
              integration_type === 'remote_mcp' && finalConfig.auth_type === 'oauth'
                ? `Integration '${name}' created successfully. OAuth authorization is still required before MCP tools can be used.`
                : `Integration '${name}' created successfully.`,
          });
        } catch (err) {
          return this.textResponse({
            success: false,
            error: err instanceof Error ? err.message : 'Failed to create integration',
          });
        }
      }
    );

    // ── Custom Domain Tools ──────────────────────────────────────────

    // Get exact custom domains with diagnostic info
    this.server.tool(
      'get_custom_domain',
      'Get exact custom domains configured for this organization with required DNS records, per-app hostname/SSL status, and live DNS resolution checks. Use this to troubleshoot custom domain issues.',
      {},
      async () => {
        this.requireAuth();
        const orgStub = this.getOrgStub();
        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        const dnsTarget = getCustomHostnameDnsTarget({
          cnameTarget: this.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
          fallbackOrigin: this.env.CF_CUSTOM_HOSTNAME_FALLBACK,
        });
        const scripts = await orgStub.listWorkerScripts();
        const now = Date.now();
        const apps: Array<{
          name: string;
          hostname: string | null;
          cf_hostname_id: string | null;
          status: string | null;
          ssl_status: string | null;
          error: string | null;
          updated_at: number | null;
          dns_checks: {
            routing_cname: CustomDomainDnsCheck | null;
          };
        }> = [];

        for (const script of scripts) {
          let currentScript = script;

          if (
            zoneId &&
            apiToken &&
            shouldRefreshAppCustomDomainState(script, null, now) &&
            script.custom_domain_hostname
          ) {
            try {
              let record = null;
              if (script.custom_domain_cf_hostname_id) {
                record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
              }
              if (!record) {
                record = await findCustomHostnameByHostname(zoneId, apiToken, script.custom_domain_hostname);
              }
              if (record) {
                currentScript =
                  (await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                    hostname: script.custom_domain_hostname,
                    cf_hostname_id: record.id,
                    status: record.status,
                    ssl_status: record.ssl.status,
                    error: null,
                  })) ?? currentScript;
              }
            } catch {
              // Fall through to diagnostic state derived from cached data
            }
          }

          const appState = getAppCustomDomainDiagnosticState(currentScript, null);
          const dnsChecks = {
            routing_cname: null as CustomDomainDnsCheck | null,
          };
          if (appState.hostname) {
            dnsChecks.routing_cname = buildCustomDomainDnsCheck({
              queried: appState.hostname,
              expectedTarget: dnsTarget,
              lookup: await resolveCnameViaDoH(appState.hostname),
            });
          }

          apps.push({
            name: script.script_name,
            hostname: appState.hostname,
            cf_hostname_id: appState.cf_hostname_id,
            status: appState.status,
            ssl_status: appState.ssl_status,
            error: appState.error,
            updated_at: appState.updated_at,
            dns_checks: dnsChecks,
          });
        }

        const configuredApps = apps.filter((app) => app.hostname);
        const activeCount = configuredApps.filter(a => a.status === 'active' && a.ssl_status === 'active').length;
        const parts: string[] = [];
        if (configuredApps.length === 0) {
          parts.push('No exact custom domains configured.');
        } else {
          parts.push(`${activeCount}/${configuredApps.length} configured custom domains have active SSL.`);
        }
        if (apps.length === 0) {
          parts.push('No apps deployed yet.');
        }

        return this.textResponse({
          configured: configuredApps.length > 0,
          dns_target: dnsTarget,
          apps,
          message: parts.join(' '),
        });
      }
    );

    // Set exact app custom domain
    this.server.tool(
      'set_custom_domain',
      'Set one exact custom hostname for one deployed app (admin only). The user chooses the hostname; camelAI provides the DNS target. Wildcards are not supported.',
      {
        app_name: z.string().min(1).describe('The deployed app name.'),
        hostname: z.string().min(3).describe('The exact hostname the user wants to use, e.g. "example.com" or "app.example.com".'),
      },
      async ({ app_name: appName, hostname: rawHostname }) => {
        const { userId } = this.requireAuth();
        const orgStub = this.getOrgStub();

        const member = await orgStub.getMember(userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
          return this.textResponse({ success: false, error: 'Only org admins can manage custom domains' });
        }

        const hostname = rawHostname.trim().toLowerCase().replace(/\.$/, '');
        const script = await orgStub.getWorkerScript(appName);
        if (!script) {
          return this.textResponse({ success: false, error: 'App not found' });
        }
        const scripts = await orgStub.listWorkerScripts();
        const conflictingScript = scripts.find(
          (candidate) =>
            candidate.script_name !== appName &&
            candidate.custom_domain_hostname === hostname
        );
        if (conflictingScript) {
          return this.textResponse({
            success: false,
            error: `That hostname is already assigned to ${conflictingScript.script_name}`,
          });
        }

        if (
          hostname.includes('*') ||
          !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
        ) {
          return this.textResponse({ success: false, error: 'Invalid exact hostname. Wildcards are not supported.' });
        }
        if (hostname.endsWith('.camelai.app') || hostname.endsWith('.camelai.dev')) {
          return this.textResponse({ success: false, error: 'Cannot use camelAI domains as custom domains' });
        }

        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        if (!zoneId || !apiToken) {
          return this.textResponse({ success: false, error: 'Cloudflare API not configured' });
        }
        const dnsTarget = getCustomHostnameDnsTarget({
          cnameTarget: this.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
          fallbackOrigin: this.env.CF_CUSTOM_HOSTNAME_FALLBACK,
        });

        try {
          const record = await createOrRefreshCustomHostname(zoneId, apiToken, hostname);
          if (!record) {
            await orgStub.updateWorkerScriptCustomDomain(appName, {
              hostname,
              error: 'Failed to create or locate Cloudflare custom hostname',
            });
            return this.textResponse({ success: false, error: 'Failed to create or locate Cloudflare custom hostname' });
          }

          if (script.custom_domain_cf_hostname_id && script.custom_domain_cf_hostname_id !== record.id) {
            await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
          }

          await orgStub.updateWorkerScriptCustomDomain(appName, {
            hostname,
            cf_hostname_id: record.id,
            status: record.status,
            ssl_status: record.ssl.status,
            error: null,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await orgStub.updateWorkerScriptCustomDomain(appName, {
            hostname,
            error: message,
          });
          return this.textResponse({ success: false, error: message });
        }

        return this.textResponse({
          success: true,
          app: appName,
          hostname,
          dns_target: dnsTarget,
          routing_record: `${hostname} CNAME ${dnsTarget}`,
          message: `Custom hostname set for ${appName}. Add ${hostname} CNAME ${dnsTarget}.`,
        });
      }
    );

    // Remove exact app custom domain
    this.server.tool(
      'remove_custom_domain',
      'Remove the exact custom domain from one app (admin only).',
      {
        app_name: z.string().min(1).describe('The deployed app name.'),
      },
      async ({ app_name: appName }) => {
        const { userId } = this.requireAuth();
        const orgStub = this.getOrgStub();

        const member = await orgStub.getMember(userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
          return this.textResponse({ success: false, error: 'Only org admins can manage custom domains' });
        }

        const script = await orgStub.getWorkerScript(appName);
        if (!script?.custom_domain_hostname) {
          return this.textResponse({ success: false, error: 'No custom domain configured for this app' });
        }

        const removedDomain = script.custom_domain_hostname;
        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        if (zoneId && apiToken && script.custom_domain_cf_hostname_id) {
          await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
        }
        await orgStub.clearWorkerScriptCustomDomain(appName);

        return this.textResponse({
          success: true,
          app: appName,
          removed_domain: removedDomain,
          message: `Custom domain ${removedDomain} removed from ${appName}.`,
        });
      }
    );

    // Retry custom domain hostname provisioning for configured exact app domains
    this.server.tool(
      'retry_custom_domain_hostnames',
      'Retry Cloudflare hostname provisioning for apps with configured exact custom domains whose SSL or hostname setup is not active.',
      {},
      async () => {
        const { userId } = this.requireAuth();
        const orgStub = this.getOrgStub();

        const member = await orgStub.getMember(userId);
        if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
          return this.textResponse({ success: false, error: 'Only org admins can retry hostname provisioning' });
        }

        const zoneId = this.env.CF_ZONE_ID?.trim();
        const apiToken = this.env.CF_API_TOKEN?.trim();
        if (!zoneId || !apiToken) {
          return this.textResponse({ success: false, error: 'Cloudflare API not configured' });
        }

        const scripts = await orgStub.listWorkerScripts();
        const scriptsToSync = scripts.filter((script) =>
          shouldRetryAppCustomDomainProvisioning(script, null)
        );
        let retried = scriptsToSync.length;
        let succeeded = 0;
        const errors: Array<{ app: string; error: string }> = [];

        for (const script of scriptsToSync) {
          if (!script.custom_domain_hostname) continue;
            try {
              const result = await createOrRefreshCustomHostname(zoneId, apiToken, script.custom_domain_hostname);
              if (result) {
                await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                  hostname: script.custom_domain_hostname,
                  cf_hostname_id: result.id,
                  status: result.status,
                  ssl_status: result.ssl.status,
                  error: null,
                });
                succeeded++;
              } else {
                const msg = 'Failed to create or locate Cloudflare hostname';
                await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                  hostname: script.custom_domain_hostname,
                  cf_hostname_id: null,
                  status: null,
                  ssl_status: null,
                  error: msg,
                });
                if (errors.length === 0) {
                  errors.push({ app: script.script_name, error: msg });
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                hostname: script.custom_domain_hostname,
                error: msg,
              });
              errors.push({ app: script.script_name, error: msg });
            }
        }

        return this.textResponse({
          success: true,
          retried,
          succeeded,
          errors: errors.length > 0 ? errors : undefined,
          message: retried === 0
            ? 'No apps need hostname retry — all are either active or still provisioning normally.'
            : `Retried ${retried} app(s): ${succeeded} succeeded${errors.length > 0 ? `, ${errors.length} failed` : ''}. Run get_custom_domain to check updated status.`,
        });
      }
    );

  }
}

/**
 * Resolve a CNAME record via Cloudflare DNS-over-HTTPS.
 * Returns a structured result so callers can distinguish missing records
 * from diagnostic failures like DoH outages or rate limits.
 */
async function resolveCnameViaDoH(hostname: string): Promise<CnameLookupResult> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
      redirect: 'manual',
    });
    if (!resp.ok) {
      return {
        status: 'unavailable',
        error: `DoH query failed with HTTP ${resp.status}`,
        http_status: resp.status,
      };
    }
    const data = await resp.json() as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    // DNS Status: 0 = NOERROR, 3 = NXDOMAIN (both mean "record doesn't exist" when no CNAME answer).
    // Anything else (2 = SERVFAIL, 5 = REFUSED, etc.) is a resolver failure.
    const dnsStatus = data.Status ?? 0;
    // CNAME is DNS type 5
    const cname = data.Answer?.find(a => a.type === 5);
    if (!cname) {
      if (dnsStatus !== 0 && dnsStatus !== 3) {
        return {
          status: 'unavailable',
          error: `DNS resolver returned status ${dnsStatus}`,
          http_status: null,
        };
      }
      return { status: 'missing' };
    }
    // Remove trailing dot from DNS response
    return { status: 'resolved', target: cname.data.replace(/\.$/, '') };
  } catch (error) {
    return {
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Handle MCP requests
 */
export async function handleMcpRequest(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Health check endpoint
  if (url.pathname === '/mcp/health') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const t0 = performance.now();

  // Authenticate via sandbox host proxy
  const proxyAuth = validateSandboxProxy(request, env);
  if (!proxyAuth.valid) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Resolve auth from the currently active turn author rather than the
  // sandbox-host proxy session, which is connection-scoped in multi-user chats.
  let activeTurnUserId: string | null = null;
  if (proxyAuth.threadId) {
    try {
      const chatThreadStub = env.CHAT_THREAD.get(
        env.CHAT_THREAD.idFromName(proxyAuth.threadId)
      ) as DurableObjectStub<ChatThreadDO>;
      const resolvedUserId = await chatThreadStub.getActiveTurnUserId();
      if (typeof resolvedUserId === 'string' && resolvedUserId.trim()) {
        activeTurnUserId = resolvedUserId.trim();
      }
    } catch (error) {
      console.warn('[MCP] Failed to resolve active turn user', {
        threadId: proxyAuth.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const headers = new Headers(request.headers);
  headers.set(AUTH_HEADER_ORG_ID, proxyAuth.orgId);
  headers.set(AUTH_HEADER_USER_ID, activeTurnUserId ?? 'system');
  headers.set(AUTH_HEADER_WORKSPACE_ID, proxyAuth.workspaceId);
  const threadId = proxyAuth.threadId ?? request.headers.get('x-chiridion-thread-id');
  if (threadId) headers.set(AUTH_HEADER_THREAD_ID, threadId);

  const authenticatedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    // @ts-expect-error - duplex is required for streaming bodies
    duplex: 'half',
  });
  const response = await ChiridionMcp.serve('/mcp').fetch(authenticatedRequest, env, ctx);
  console.log(`[MCP] ${request.method} ${url.pathname} → ${response.status} in ${(performance.now() - t0).toFixed(0)}ms`);
  return response;
}
