/**
 * Shared types and constants for the main worker
 */

import type {
  LakeStream,
  ToolCallLakeRecord,
} from "./lake-streams.js";
import type { ChatEnv } from "./chat-thread-do.js";
import type { DOEnv } from "./auth.js";
import type { DataProxyEnv } from "./data-proxy.js";
import type { CfApiProxyEnv } from "./cf-api-proxy.js";
import type { WorkspaceDO } from "./workspace.js";
import type { WorkerLogsDO } from "./worker-logs-do.js";
import type { EmailHandleDO } from "./email-handle-registry.js";
import type { SignupDO } from "./signup-do.js";
import type {
  SlackTeamRegistryDO,
  TelegramRegistryDO,
} from "./channel-registries.js";
import type { AppScreenshotJob } from "./screenshot-queue.js";
import type { SlackEventQueueMessage } from "./slack-types.js";
import type {
  DiscordBridgeFetcher,
  DiscordEventQueueMessage,
} from "./discord-types.js";
import type { ArtifactsRepo } from "./workspace-filesystem-do.js";
import type { DispatcherBinding } from "./workspace-app-fetcher.js";

interface ArtifactsBinding {
  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<{
    id?: string;
    name: string;
    remote: string;
    defaultBranch?: string;
    status?: "ready" | "creating" | "importing" | "forking";
    token?: string;
  }>;
  get(name: string): Promise<ArtifactsRepo>;
}

export interface Env
  extends
    ChatEnv,
    DOEnv,
    DataProxyEnv,
    Omit<CfApiProxyEnv, "CHAT_THREAD"> {
  ASSETS: Fetcher;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
  // Unified analysis container (notebooks + shell + DuckDB) on the native DO
  // container API; one warm container per workspace (analysis-container.ts).
  ANALYSIS_SANDBOX?: DurableObjectNamespace<import('./analysis-container.js').AnalysisContainer>;
  // R2 bucket mounts of native containers (sandbox-mounts.ts). 1.0 cannot
  // mount through a binding, so on Cloudflare the mounts sign with an R2 API
  // token: the bucket names are vars, the key pair is secret (access key id =
  // token id, secret = SHA-256 hex of the token value). Unused on self-host.
  R2_BUCKET_NAME?: string;
  WAREHOUSE_EXPORT_BUCKET_NAME?: string;
  R2_S3_ENDPOINT?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  // Warm native-toolchain build container for DO+R2-backed projects (per-org).
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace<import('./project-build-container.js').ProjectBuildContainer>;
  // Trusted query-execution container with static-IP database egress via the
  // sandbox-host SOCKS relay (docs/db-egress-relay.md).
  // Served by DbQueryContainer (native DO container API, Sandbox SDK 1.0).
  DB_QUERY_SANDBOX?: DurableObjectNamespace<import('./db-query-container.js').DbQueryContainer>;
  // Static-IP database egress relay coordinates (see infra/db-egress-relay/):
  // hostname is a var; the token/credential pairs are secrets.
  DB_EGRESS_RELAY_HOSTNAME?: string;
  DB_EGRESS_RELAY_ACCESS_CLIENT_ID?: string;
  DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET?: string;
  DB_EGRESS_RELAY_SOCKS_USERNAME?: string;
  DB_EGRESS_RELAY_SOCKS_PASSWORD?: string;
  // Auto-expiring R2 staging bucket for warehouse/analysis connection exports.
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
  SESSIONS: KVNamespace;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  // Tool-call telemetry stream (Cloudflare Pipelines -> R2 Data Catalog).
  // Optional everywhere: absent bindings disable export, they never fail a turn.
  TOOL_CALLS_LAKE?: LakeStream<ToolCallLakeRecord>;
  APP_SCREENSHOT_QUEUE?: Queue<AppScreenshotJob>;
  SLACK_EVENTS_QUEUE?: Queue<SlackEventQueueMessage>;
  DISCORD_EVENTS_QUEUE?: Queue<DiscordEventQueueMessage>;
  DISCORD_BRIDGE?: DiscordBridgeFetcher;
  BROWSER?: Fetcher;
  DISPATCHER?: DispatcherBinding;
  ARTIFACTS?: ArtifactsBinding;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ANALYTICS_CLIENT_ID?: string;
  GOOGLE_ANALYTICS_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_CHANNEL_ENABLED?: string;
  /**
   * Deployed-app CONNECTIONS binding kill switch. Default enabled; set to
   * "false" for on-prem self-host installs that must not expose workspace
   * connections to published apps.
   */
  CONNECTIONS_BINDING_ENABLED?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  SALESFORCE_CLIENT_ID?: string;
  SALESFORCE_CLIENT_SECRET?: string;
  INTEGRATION_SECRET_KEY: string;
  // Hosted agent runtime (routes/agent-mcp.ts, routes/agent-runtime-llm.ts): the
  // tenant its identity tokens must name, and the audiences to expect when these
  // endpoints sit behind a proxy. AGENT_RUNTIME_URL (its JWKS) is on ChatEnv.
  AGENT_RUNTIME_TENANT?: string;
  AGENT_RUNTIME_MCP_AUDIENCE?: string;
  AGENT_RUNTIME_LLM_AUDIENCE?: string;
  // Standard Webhooks secret (whsec_…) of the runtime's webhook endpoint for
  // run, input and usage events (routes/agent-runtime-events.ts).
  AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET?: string;
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL?: ChatEnv["EMAIL"];
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  STRIPE_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET_NEXT?: string;
  STRIPE_SUBSCRIPTION_PRICE_ID?: string;
  STRIPE_STARTER_PRICE_ID?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_TEAM_PRICE_ID?: string;
  STRIPE_CREDIT_PRICE_IDS?: string;
  STRIPE_CREDIT_PRICE_ID?: string;
  BILLING_TRIAL_CREDIT_CENTS?: string;
  BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS?: string;
  LOCAL_AUTH_BYPASS?: string;
  LOCAL_AUTH_BYPASS_HOSTS?: string;
  LOCAL_AUTH_USER_EMAIL?: string;
  LOCAL_AUTH_USER_NAME?: string;
  RUN_AGENT_EVALS?: string;
  // Within agent eval runs, deploys go for real to the testing-grounds namespace by
  // default whenever CF_API_TOKEN is set. Set to "0"/"false" to disable real deploys
  // (the deploy eval then skips). Opt-out switch.
  EVAL_REAL_DEPLOY?: string;
  // Claude API Proxy (CF AI Gateway)
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_BASE_URL?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  BEDROCK_REGION?: string;
  LOCAL_ARTIFACTS_BASE_URL?: string;
  LOCAL_ARTIFACTS_SECRET?: string;
  LOCAL_APP_VANITY_DOMAIN?: string;
  LOCAL_APP_IFRAME_DOMAIN?: string;
  CLOUDFLARE_ACCESS_TEAM_DOMAIN?: string;
  CLOUDFLARE_ACCESS_AUD?: string;
  CLOUDFLARE_ACCESS_AUDS?: string;
  CLOUDFLARE_ACCESS_ORG_MAP?: string;
  CLOUDFLARE_ACCESS_ORG_CLAIMS?: string;
  CLOUDFLARE_ACCESS_ORG_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_ADMIN_GROUP_PREFIX?: string;
  CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME?: string;
  CLOUDFLARE_ACCESS_REQUIRED_EMAIL_DOMAIN?: string;
  POMERIUM_JWKS_URL?: string;
  POMERIUM_AUTHENTICATE_URL?: string;
  POMERIUM_ISSUER?: string;
  POMERIUM_AUDIENCE?: string;
  POMERIUM_ORG_MAP?: string;
  POMERIUM_ORG_CLAIMS?: string;
  POMERIUM_ORG_GROUP_PREFIX?: string;
  POMERIUM_ADMIN_GROUP_PREFIX?: string;
  POMERIUM_DEFAULT_ORG_NAME?: string;
  POMERIUM_REQUIRED_EMAIL_DOMAIN?: string;
  // Email handle registry (atomic handle claims)
  EMAIL_HANDLE?: DurableObjectNamespace<EmailHandleDO>;
  SIGNUP: DurableObjectNamespace<SignupDO>;
  // Channel routing registries (strongly consistent routing state)
  TELEGRAM_REGISTRY?: DurableObjectNamespace<TelegramRegistryDO>;
  SLACK_TEAM_REGISTRY?: DurableObjectNamespace<SlackTeamRegistryDO>;
  // Admin CLI API key (set via wrangler secret)
  ADMIN_API_KEY?: string;
  // Optional comma/whitespace-separated bootstrap superuser emails.
  // Prefer `wrangler secret put SUPERUSER_EMAILS`.
  SUPERUSER_EMAILS?: string;
  // Derived global admin/index read model. Tenant-owned state remains authoritative in DOs.
  APP_DB?: D1Database;
  // Optional static OAuth client id for the remote admin MCP server.
  ADMIN_MCP_CLIENT_ID?: string;
  // Comma/whitespace-separated redirect URI allowlist for ADMIN_MCP_CLIENT_ID.
  ADMIN_MCP_REDIRECT_URIS?: string;
}

export interface RouteContext {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  match: RegExpMatchArray;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response | null>;

export interface Route {
  method: string;
  path: RegExp;
  handler: RouteHandler;
  websocket?: boolean;
}

// Re-export cookie constants from cookies.ts (single source of truth)
export { SESSION_HEADER } from "./cookies.js";

// New prefix with org-slug namespacing: script:{script-name}--{org-slug}
export const SCRIPT_PREFIX = "script:";
