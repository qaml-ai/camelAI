import type { Avatar, Integration } from "@/types";
import { getIntegrationDefinition } from "@/lib/integration-registry";
import {
  getConnectionContract,
  type ConnectionCapability,
  type ConnectionContract,
} from "@/lib/connection-contract";

export const CHANNEL_INTEGRATION_TYPES = ["slack", "telegram", "discord_channel"] as const;
export const DISCORD_BOT_MENTION = "@Camel";

export type ChannelIntegrationType = (typeof CHANNEL_INTEGRATION_TYPES)[number];
export type ConnectionSort = "updated" | "name" | "created";
export type Capability = ConnectionCapability;

export interface ConnectionListItem extends Integration {
  auth_status?: string | null;
  auth_error_code?: string | null;
  auth_error_message?: string | null;
  auth_checked_at?: number | null;
  reauth_required_at?: number | null;
  token_expires_at?: number | null;
  created_by_name?: string | null;
  created_by_avatar?: Avatar | null;
  channelMetadata?: {
    team_id?: string | null;
    team_name?: string | null;
    bot_user_id?: string | null;
    guild_id?: string | null;
    guild_name?: string | null;
    parent_channel_id?: string | null;
    parent_channel_name?: string | null;
    message_content_mode?: string | null;
    status?: string | null;
    error_code?: string | null;
  };
  definitionMetadata?: {
    source: string;
    operationCount: number;
    genericFetch: boolean;
  };
  contract?: ConnectionContract;
  verification?: {
    status: string;
    message: string | null;
    checkedAt: number | null;
    live: boolean;
    strategy: string;
  };
}

export interface EmailChannel {
  address: string | null;
  handle: string | null;
  /**
   * TODO(email-channel-mention): wire this once backend defines the native
   * Email channel's synthetic @-mention slug and expansion behavior.
   */
  mentionSlug?: string | null;
  inboxEnabled: boolean;
  workspaceCreatedBy: string | null;
  workspaceCreatedByName?: string | null;
  workspaceCreatedByAvatar?: Avatar | null;
  workspaceCreatedAt: number | null;
}

export type PanelItem =
  | { kind: "connection"; id: string; connection: ConnectionListItem }
  | {
      kind: "channel";
      channel: ChannelIntegrationType;
      id: string;
      connection: ConnectionListItem;
    }
  | { kind: "channel"; channel: "email"; id: "email"; email: EmailChannel };

export const TYPE_COPY = {
  channel:
    "A channel receives messages from outside camelAI and turns them into threads the agent can reply to.",
  connection:
    "A connection gives the agent tools it can call. @-mention it in any chat to put its data and actions to work.",
} as const;

export interface DetailField {
  label: string;
  keys: string[];
}

export interface ConnectionDetailRow {
  label: string;
  value: string;
}

const DETAIL_FIELDS_BY_TYPE: Record<string, DetailField[]> = {
  postgres: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
    { label: "Schema", keys: ["schema"] },
  ],
  mysql: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
  ],
  clickhouse: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
  ],
  mongodb: [
    { label: "Cluster", keys: ["cluster_url", "host", "endpoint"] },
    { label: "Database", keys: ["database"] },
  ],
  redis: [
    { label: "Host", keys: ["host", "endpoint"] },
    { label: "Port", keys: ["port"] },
    { label: "Database", keys: ["database"] },
  ],
  snowflake: [
    { label: "Account", keys: ["account"] },
    { label: "Warehouse", keys: ["warehouse"] },
    { label: "Database", keys: ["database"] },
    { label: "Schema", keys: ["schema"] },
  ],
  supabase: [{ label: "Project URL", keys: ["project_url"] }],
  neon: [{ label: "Project ID", keys: ["project_id"] }],
  planetscale: [
    { label: "Organization", keys: ["organization"] },
    { label: "Database", keys: ["database"] },
  ],
  turso: [{ label: "Database URL", keys: ["database_url"] }],
  databricks: [{ label: "Workspace URL", keys: ["workspace_url"] }],
  bigquery: [
    { label: "Project ID", keys: ["project_id"] },
    { label: "Dataset", keys: ["dataset"] },
  ],
  jira: [{ label: "Domain", keys: ["domain"] }],
  zendesk: [{ label: "Subdomain", keys: ["subdomain"] }],
  shopify: [{ label: "Shop domain", keys: ["shop_domain"] }],
  mailchimp: [{ label: "Data center", keys: ["data_center"] }],
  square: [{ label: "Environment", keys: ["environment"] }],
  amplitude: [{ label: "Region", keys: ["region"] }],
  mixpanel: [
    { label: "Project ID", keys: ["project_id"] },
    { label: "Region", keys: ["region"] },
  ],
  posthog: [
    { label: "Host", keys: ["host"] },
    { label: "Project ID", keys: ["project_id"] },
  ],
  google_analytics: [
    { label: "Default property", keys: ["property_name", "property_id"] },
    { label: "Property ID", keys: ["property_id"] },
  ],
  sentry: [{ label: "Organization", keys: ["organization"] }],
  salesforce: [{ label: "Instance URL", keys: ["instance_url"] }],
  remote_mcp: [
    { label: "Server URL", keys: ["server_url"] },
    { label: "Transport", keys: ["transport"] },
    { label: "Auth type", keys: ["auth_type"] },
    { label: "Auth header", keys: ["auth_header"] },
  ],
  other: [
    { label: "Base URL", keys: ["base_url", "url"] },
    { label: "Auth type", keys: ["auth_type"] },
    { label: "Display name", keys: ["display_name"] },
    { label: "Description", keys: ["description"] },
  ],
  aws: [
    { label: "Region", keys: ["region"] },
    { label: "Role ARN", keys: ["role_arn"] },
  ],
  gcp: [{ label: "Project ID", keys: ["project_id"] }],
  azure: [
    { label: "Tenant ID", keys: ["tenant_id"] },
    { label: "Subscription ID", keys: ["subscription_id"] },
  ],
  vercel: [{ label: "Team ID", keys: ["team_id"] }],
  cloudflare: [{ label: "Account ID", keys: ["account_id"] }],
  openai: [{ label: "Organization ID", keys: ["organization_id"] }],
  anthropic: [{ label: "Provider", keys: ["display_name"] }],
  openrouter: [{ label: "Provider", keys: ["display_name"] }],
  discord: [{ label: "Application ID", keys: ["application_id"] }],
  discord_channel: [
    { label: "Server", keys: ["guild_name", "guild_id"] },
    { label: "Channel", keys: ["parent_channel_name", "parent_channel_id"] },
    { label: "Content mode", keys: ["message_content_mode"] },
  ],
  teams: [{ label: "Tenant ID", keys: ["tenant_id"] }],
};

export function isChannelIntegrationType(
  integrationType: string,
): integrationType is ChannelIntegrationType {
  return CHANNEL_INTEGRATION_TYPES.includes(
    integrationType as ChannelIntegrationType,
  );
}

export function panelItemFromConnection(connection: ConnectionListItem): PanelItem {
  if (isChannelIntegrationType(connection.integration_type)) {
    return {
      kind: "channel",
      channel: connection.integration_type,
      id: connection.id,
      connection,
    };
  }
  return { kind: "connection", id: connection.id, connection };
}

export function emailPanelItem(email: EmailChannel): PanelItem {
  return { kind: "channel", channel: "email", id: "email", email };
}

export function panelItemName(item: PanelItem): string {
  if (item.kind === "connection") return item.connection.name;
  if (item.channel === "email") return "Email";
  return item.connection.name;
}

export function panelItemConnection(item: PanelItem): ConnectionListItem | null {
  if (item.kind === "connection") return item.connection;
  if (item.channel === "email") return null;
  return item.connection;
}

export function providerDisplayName(integrationType: string): string {
  return getIntegrationDefinition(integrationType)?.displayName ?? integrationType;
}

export function deriveCapabilities(connection: Integration): Capability[] {
  const item = connection as ConnectionListItem;
  if (item.contract) return item.contract.capabilities;
  const capabilities = getConnectionContract(connection.integration_type, {
    config: connection.config,
  }).capabilities;
  return item.definitionMetadata?.operationCount
    ? [...new Set([...capabilities, "typed_operations" as const])]
    : capabilities;
}

export function getConnectionDetailRows(
  connection: ConnectionListItem,
): ConnectionDetailRow[] {
  const fields = DETAIL_FIELDS_BY_TYPE[connection.integration_type] ?? [];
  return fields.flatMap((field) => {
    const value = firstConfigValue(connection.config, field.keys);
    return value ? [{ label: field.label, value }] : [];
  });
}

export function connectionRequiresOutboundIpAllowlist(
  connection: ConnectionListItem,
): boolean {
  return Boolean(
    getIntegrationDefinition(connection.integration_type)?.requiresOutboundIpAllowlist,
  );
}

export function canReconnectConnection(connection: ConnectionListItem): boolean {
  if (connection.integration_type === "telegram") return false;
  if (
    connection.integration_type === "slack" ||
    connection.integration_type === "discord_channel" ||
    connection.integration_type === "notion" ||
    connection.integration_type === "salesforce"
  ) {
    return true;
  }
  return (
    connection.integration_type === "remote_mcp" &&
    connection.config.auth_type === "oauth"
  );
}

export function getDiscordChannelMetadata(connection: ConnectionListItem): {
  guild_id: string | null;
  guild_name: string | null;
  parent_channel_id: string | null;
  parent_channel_name: string | null;
  message_content_mode: string | null;
  status: string | null;
  error_code: string | null;
  reauthorization_pending: boolean;
} {
  const pendingReauthorization = connection.config.pending_reauthorization;
  return {
    guild_id:
      connection.channelMetadata?.guild_id ??
      stringConfigValue(connection.config, "guild_id"),
    guild_name:
      connection.channelMetadata?.guild_name ??
      stringConfigValue(connection.config, "guild_name"),
    parent_channel_id:
      connection.channelMetadata?.parent_channel_id ??
      stringConfigValue(connection.config, "parent_channel_id"),
    parent_channel_name:
      connection.channelMetadata?.parent_channel_name ??
      stringConfigValue(connection.config, "parent_channel_name"),
    message_content_mode:
      connection.channelMetadata?.message_content_mode ??
      stringConfigValue(connection.config, "message_content_mode"),
    status:
      connection.channelMetadata?.status ??
      stringConfigValue(connection.config, "status"),
    error_code:
      connection.channelMetadata?.error_code ??
      stringConfigValue(connection.config, "error_code"),
    reauthorization_pending:
      Boolean(
        pendingReauthorization &&
        typeof pendingReauthorization === "object" &&
        !Array.isArray(pendingReauthorization),
      ),
  };
}

export const DISCORD_PERMISSION_LABELS: Record<string, string> = {
  VIEW_CHANNEL: "View Channel",
  SEND_MESSAGES: "Send Messages",
  EMBED_LINKS: "Embed Links",
  ATTACH_FILES: "Attach Files",
  READ_MESSAGE_HISTORY: "Read Message History",
  CREATE_PUBLIC_THREADS: "Create Public Threads",
  SEND_MESSAGES_IN_THREADS: "Send Messages in Threads",
};

export function formatDiscordPermissionList(names: string[]): string {
  return names
    .map((name) => DISCORD_PERMISSION_LABELS[name] ?? name)
    .join(", ");
}

export type DiscordChannelBlockReason =
  | { kind: "no_access" }
  | { kind: "missing_permissions"; label: string };

export function getDiscordChannelBlockReason(channel: {
  canActivate: boolean;
  missingPermissions: string[];
}): DiscordChannelBlockReason | null {
  if (channel.canActivate) return null;
  if (channel.missingPermissions.includes("VIEW_CHANNEL")) {
    return { kind: "no_access" };
  }
  return {
    kind: "missing_permissions",
    label: formatDiscordPermissionList(channel.missingPermissions),
  };
}

export const DISCORD_STATUS_LABELS: Record<string, string> = {
  pending_channel: "Waiting for channel selection",
  active: "Active",
  disconnected: "Disconnected",
  setup_error: "Setup error",
};

export function getChannelAttentionBadge(
  connection: ConnectionListItem,
): { label: string; tooltip: string } | null {
  if (connection.integration_type === "discord_channel") {
    const metadata = getDiscordChannelMetadata(connection);
    if (metadata.status === "pending_channel") {
      return {
        label: "Finish setup",
        tooltip: `Camel is installed in ${metadata.guild_name ?? "your server"} but no channel is selected yet.`,
      };
    }
    if (metadata.status === "disconnected") {
      return {
        label: "Disconnected",
        tooltip: "Camel is not connected to a channel. Open to reconnect.",
      };
    }
    if (metadata.status === "setup_error") {
      return {
        label: "Setup error",
        tooltip: "Something went wrong during setup. Open to retry.",
      };
    }
    return null;
  }

  if (
    connection.integration_type === "telegram" &&
    stringConfigValue(connection.config, "status") === "pending"
  ) {
    return {
      label: "Finish setup",
      tooltip: "Open to finish linking your Telegram chat.",
    };
  }

  return null;
}

export function getSlackChannelMetadata(connection: ConnectionListItem): {
  team_id: string | null;
  team_name: string | null;
  bot_user_id: string | null;
} {
  return {
    team_id:
      connection.channelMetadata?.team_id ??
      stringConfigValue(connection.config, "team_id"),
    team_name:
      connection.channelMetadata?.team_name ??
      stringConfigValue(connection.config, "team_name"),
    bot_user_id:
      connection.channelMetadata?.bot_user_id ??
      stringConfigValue(connection.config, "bot_user_id"),
  };
}

export function buildConnectionGroups(
  connections: readonly ConnectionListItem[],
  email: EmailChannel,
): { channels: PanelItem[]; connections: PanelItem[] } {
  const channels: PanelItem[] = [emailPanelItem(email)];
  const connectionItems: PanelItem[] = [];

  for (const connection of connections) {
    const item = panelItemFromConnection(connection);
    if (item.kind === "channel") {
      channels.push(item);
    } else {
      connectionItems.push(item);
    }
  }

  return { channels, connections: connectionItems };
}

export function filterAndSortConnectionGroups(
  groups: { channels: PanelItem[]; connections: PanelItem[] },
  query: string,
  sortBy: ConnectionSort,
): { channels: PanelItem[]; connections: PanelItem[] } {
  return {
    channels: sortPanelItems(
      groups.channels.filter((item) => panelItemMatchesQuery(item, query)),
      sortBy,
    ),
    connections: sortPanelItems(
      groups.connections.filter((item) => panelItemMatchesQuery(item, query)),
      sortBy,
    ),
  };
}

export function sortPanelItems(
  items: readonly PanelItem[],
  sortBy: ConnectionSort,
): PanelItem[] {
  return [...items].sort((a, b) => {
    if (a.kind === "channel" && a.channel === "email") return -1;
    if (b.kind === "channel" && b.channel === "email") return 1;

    switch (sortBy) {
      case "name":
        return panelItemName(a).localeCompare(panelItemName(b), undefined, {
          sensitivity: "base",
        });
      case "created":
        return itemCreatedAt(b) - itemCreatedAt(a);
      case "updated":
      default:
        return itemUpdatedAt(b) - itemUpdatedAt(a);
    }
  });
}

function panelItemMatchesQuery(item: PanelItem, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  if (item.kind === "channel" && item.channel === "email") {
    return ["email", item.email.address, item.email.handle]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized));
  }

  const connection = panelItemConnection(item);
  if (!connection) return false;
  return [
    connection.name,
    connection.integration_type,
    providerDisplayName(connection.integration_type),
  ].some((value) => value.toLowerCase().includes(normalized));
}

function itemCreatedAt(item: PanelItem): number {
  if (item.kind === "channel" && item.channel === "email") {
    return item.email.workspaceCreatedAt ?? 0;
  }
  const connection = panelItemConnection(item);
  if (connection) return connection.created_at;
  return 0;
}

function itemUpdatedAt(item: PanelItem): number {
  if (item.kind === "channel" && item.channel === "email") {
    return item.email.workspaceCreatedAt ?? 0;
  }
  const connection = panelItemConnection(item);
  if (connection) return connection.updated_at;
  return 0;
}

function firstConfigValue(
  config: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = formatConfigValue(config[key]);
    if (value) return value;
  }
  return null;
}

function stringConfigValue(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatConfigValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}
