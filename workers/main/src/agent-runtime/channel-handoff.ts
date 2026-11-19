import type { OrgThread } from "../identity/org-do";

export type HandoffChannel = "discord" | "telegram";
export type ChannelHandoffBinding = { kind: HandoffChannel; connectionId: string; remoteConversationId: string };

export function channelHandoffBinding(thread: OrgThread, kind: unknown): ChannelHandoffBinding | null {
  if ((kind !== "discord" && kind !== "telegram") || thread.source !== "channel" ||
      thread.channel_kind !== kind || !thread.channel_connection_id || !thread.channel_conversation_id) return null;
  return {
    kind,
    connectionId: thread.channel_connection_id,
    remoteConversationId: thread.channel_conversation_id,
  };
}
