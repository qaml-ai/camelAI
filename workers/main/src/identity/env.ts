import type { UserDO } from "./user-do";
import type { OrgDO } from "./org-do";
import type { WorkspaceDO } from "../workspace";
import type { ChatThreadDO } from "../chat-thread-do";
import type { EmailHandleDO } from "../email-handle-registry";
import type { WorkspaceCronDO } from "../workspace-cron";
import type { SignupDO } from "../signup-do";

// Environment bindings needed by identity Durable Objects
export interface DOEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  APP_DB?: D1Database;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  OBSERVABILITY_SERVICE?: Fetcher;
  EMAIL_TO_USER: KVNamespace;
  SIGNUP: DurableObjectNamespace<SignupDO>;
  APP_KV: KVNamespace;
  EMAIL_HANDLE?: DurableObjectNamespace<EmailHandleDO>;
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  INTEGRATION_SECRET_KEY?: string;
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_ANALYTICS_CLIENT_ID?: string;
  GOOGLE_ANALYTICS_CLIENT_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}
