import type { AppLoadContext } from "react-router";
import type { UserDO, OrgDO } from "../../workers/main/src/auth";
import type { WorkspaceDO } from "../../workers/main/src/workspace";
import type { WorkspaceFilesystemDO } from "../../workers/main/src/workspace-filesystem-do";
import type { ChatThreadDO } from "../../workers/main/src/chat-thread-do";
import type { WorkspaceCronDO } from "../../workers/main/src/workspace-cron";
import type { WorkerLogsDO } from "../../workers/main/src/worker-logs-do";
import type { SignupDO } from "../../workers/main/src/signup-do";
import type {
  SlackTeamRegistryDO,
  TelegramRegistryDO,
} from "../../workers/main/src/channel-registries";
import type { CloudflareEmailSender } from "./cloudflare-email.server";

/**
 * Cloudflare environment bindings available in React Router loaders/actions.
 * This interface should match the Env type in workers/main/src/index.ts
 */
export interface CloudflareEnv {
  // Durable Objects
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  USER: DurableObjectNamespace<UserDO>;
  SIGNUP: DurableObjectNamespace<SignupDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  MCP_OBJECT: DurableObjectNamespace;
  WORKER_LOGS: DurableObjectNamespace<WorkerLogsDO>;
  TELEGRAM_REGISTRY?: DurableObjectNamespace<TelegramRegistryDO>;
  SLACK_TEAM_REGISTRY?: DurableObjectNamespace<SlackTeamRegistryDO>;
  PROJECT_BUILD_SANDBOX?: DurableObjectNamespace;
  ANALYSIS_SANDBOX?: DurableObjectNamespace;
  DB_QUERY_SANDBOX?: DurableObjectNamespace;

  // KV Namespaces
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
  SESSIONS: KVNamespace;

  // R2
  R2_BUCKET: R2Bucket;
  // Staging area for warehouse connection exports (auto-expiring); read by the
  // sealed DuckDB warehouse container.
  WAREHOUSE_EXPORT_BUCKET: R2Bucket;

  // Service bindings
  WORKER_SELF_REFERENCE: Fetcher;
  DISCORD_BRIDGE?: Fetcher;

  // Other bindings
  ASSETS: Fetcher;
  IMAGES: unknown; // ImagesBinding
  AI: unknown; // AI binding
  BROWSER?: Fetcher;
  EMAIL?: CloudflareEmailSender;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  APP_DB?: D1Database;
  ARTIFACTS?: unknown;

  // Environment variables
  NEXTJS_ENV?: string;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_BASE_URL?: string;
  CF_GATEWAY_TOKEN?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  CF_DISPATCH_NAMESPACE: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
  WORKER_BASE_URL: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  GOOGLE_ANALYTICS_CLIENT_ID?: string;
  GOOGLE_ANALYTICS_CLIENT_SECRET?: string;
  WORKSPACE_EMAIL_DOMAIN?: string;
  EMAIL_FROM_ADDRESS?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_CHANNEL_ENABLED?: string;
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
  ADMIN_MCP_CLIENT_ID?: string;
  ADMIN_MCP_REDIRECT_URIS?: string;
  LOCAL_AUTH_BYPASS?: string;
  LOCAL_AUTH_BYPASS_HOSTS?: string;
  LOCAL_AUTH_USER_EMAIL?: string;
  LOCAL_AUTH_USER_NAME?: string;
  /** Comma/whitespace-separated bootstrap superuser emails (prefer wrangler secret). */
  SUPERUSER_EMAILS?: string;
}

/**
 * Extended load context with Cloudflare bindings
 */
export interface CloudflareLoadContext extends AppLoadContext {
  cloudflare: {
    env: CloudflareEnv;
    ctx?: Pick<ExecutionContext, "waitUntil">;
  };
}

/**
 * Get Cloudflare environment bindings from React Router load context
 */
export function getEnv(context: AppLoadContext): CloudflareEnv {
  const cfContext = context as CloudflareLoadContext;
  if (!cfContext.cloudflare?.env) {
    throw new Error("Cloudflare environment not available in load context");
  }
  return cfContext.cloudflare.env;
}
