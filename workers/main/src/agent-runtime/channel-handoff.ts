import type { OrgThread } from "../identity/org-do";

export type HandoffChannel = "discord" | "telegram";
export type ChannelHandoffBinding = { kind: HandoffChannel; connectionId: string; remoteConversationId: string };

/** The stored integration type can differ from its origin channel kind. */
export function channelHandoffOwner(kind: HandoffChannel, connection: { integration_type: string; created_by: string | null } | null) {
  const integrationType = kind === "discord" ? "discord_channel" : "telegram";
  return connection?.integration_type === integrationType ? connection.created_by?.trim() || null : null;
}

export function channelHandoffBinding(thread: OrgThread, kind: unknown): ChannelHandoffBinding | null {
  if ((kind !== "discord" && kind !== "telegram") || thread.source !== "channel" ||
      thread.channel_kind !== kind || !thread.channel_connection_id || !thread.channel_conversation_id) return null;
  return {
    kind,
    connectionId: thread.channel_connection_id,
    remoteConversationId: thread.channel_conversation_id,
  };
}
