// Outbound channel tooling (email / Slack / Telegram) extracted from
// chat-thread-do.ts. Implemented as a small ChannelTools class constructed with
// the worker env — the only Durable Object state these paths ever needed. Both
// ChatThreadDO and CodeModeToolsBinding construct a ChannelTools to send on a
// channel, which removed the previous Object.create(ChatThreadDO.prototype)
// hack and the chat-thread-do <-> code-mode-tools runtime import cycle.
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { OrgDO, OrgThread } from "./auth";
import { decryptCredentials } from "../../../src/lib/integration-crypto";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths";
import { buildWorkspaceEmailSenderAddress, getWorkspaceEmailDomain } from "../../../src/lib/workspace-email";
import { getBillingPlanLimits } from "../../../src/lib/billing-plans";
import { formatMarkdownForTelegram } from "../../../src/lib/telegram-format";
import { isSelfhostRuntime } from "../../../src/lib/selfhost-runtime";
import { SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE } from "../../../src/lib/selfhost-capabilities";
import {
  discordBridgeClient,
  type DiscordBridgeBindingRecord,
} from "./discord-types";
import {
  appendEmailThreadReferenceIds,
  buildEmailReplyHeaders,
  EMAIL_REPLY_REFERENCE_TTL_SECONDS,
  getOrCreateChannelThread,
  getEmailReplyReferenceKey,
  getEmailThreadReferencesKey,
} from "./channels";
import type {
  ChatEnv,
  ChatContextState,
  CloudflareEmailSender,
  ChannelHistoryEventRequest,
  ChannelHistoryEventResult,
} from "./chat-thread-do";
import { resolveEmailBinding } from "./binding-facades/managed";
import { resolveObjectStore } from "./binding-facades/object-store";

export interface ChannelToolAttachmentInput {
  path: string;
  filename?: string;
  content_type?: string;
  caption?: string;
  send_as?: string;
}

export interface ResolvedChannelAttachment {
  path: string;
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  size: number;
  caption?: string;
  sendAs?: string;
}

export const MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export const TELEGRAM_BOT_API_TIMEOUT_MS = 15_000;

export class ChannelTools {
  constructor(private readonly env: ChatEnv) {}

  private getOrgStub(orgId: string): DurableObjectStub<OrgDO> {
    if (!orgId) throw new Error("Missing org scope");
    return this.env.ORG.get(this.env.ORG.idFromName(orgId));
  }

  async markThreadChannelUsedBestEffort(
    context: { orgId?: string | null; threadId?: string | null },
    channelKind: "email" | "slack" | "telegram" | "discord",
  ): Promise<void> {
    if (!context.orgId || !context.threadId) return;
    try {
      const orgStub = this.env.ORG.get(this.env.ORG.idFromName(context.orgId));
      await orgStub.recordThreadChannelUsed(context.threadId, channelKind);
    } catch (error) {
      console.error("[ChatThreadDO] failed to record thread channel usage", {
        threadId: context.threadId,
        channelKind,
        error,
      });
    }
  }

  private async getCurrentThreadRecord(
    context: ChatContextState,
  ): Promise<OrgThread> {
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(context.orgId),
    ) as unknown as OrgDO;
    const thread = await orgStub.getThread(context.threadId);
    if (!thread) {
      throw new Error("Thread not found");
    }
    return thread;
  }

  private async getCurrentThreadRecordIfAvailable(
    context: ChatContextState,
  ): Promise<OrgThread | null> {
    if (!context.threadId) return null;
    try {
      return await this.getCurrentThreadRecord(context);
    } catch (error) {
      if (error instanceof Error && error.message === "Thread not found") {
        return null;
      }
      throw error;
    }
  }

  private async getOriginatingChannelThread(
    context: ChatContextState,
    kind: "email" | "slack" | "telegram" | "discord",
  ): Promise<OrgThread | null> {
    const thread = await this.getCurrentThreadRecordIfAvailable(context);
    if (!thread) return null;
    return thread.source?.trim() === "channel" && thread.channel_kind === kind
      ? thread
      : null;
  }

  private async readEmailThreadReferenceIds(
    context: ChatContextState,
    thread: OrgThread | null,
  ): Promise<string[]> {
    if (!context.threadId) return [];

    let rawReferences: string | null = null;
    try {
      rawReferences = await this.env.APP_KV.get(
        getEmailThreadReferencesKey(context.workspaceId, context.threadId),
      );
    } catch (error) {
      console.error("[send_email] failed to read email thread metadata", {
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    if (rawReferences) {
      try {
        const parsed = JSON.parse(rawReferences);
        if (Array.isArray(parsed)) {
          const ids = appendEmailThreadReferenceIds(
            parsed.filter((value): value is string => typeof value === "string"),
          );
          if (ids.length > 0) return ids;
        }
      } catch {
        // Ignore malformed KV data and fall back to real channel metadata.
      }
    }

    if (
      thread?.source?.trim() !== "channel" ||
      thread.channel_kind !== "email" ||
      !thread.channel_message_id
    ) {
      return [];
    }
    return appendEmailThreadReferenceIds([], thread?.channel_message_id);
  }

  private readChannelAttachmentInputs(
    raw: Record<string, unknown>,
  ): ChannelToolAttachmentInput[] {
    const value = raw.attachments;
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new Error("attachments must be an array");
    }
    if (value.length > 10) {
      throw new Error("At most 10 attachments can be sent at once");
    }
    return value.map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`attachments[${index}] must be an object`);
      }
      const candidate = entry as Record<string, unknown>;
      const path =
        typeof candidate.path === "string" ? candidate.path.trim() : "";
      if (!path) {
        throw new Error(`attachments[${index}].path is required`);
      }
      return {
        path,
        filename:
          typeof candidate.filename === "string" &&
          candidate.filename.trim()
            ? candidate.filename.trim()
            : undefined,
        content_type:
          typeof candidate.content_type === "string" &&
          candidate.content_type.trim()
            ? candidate.content_type.trim()
            : undefined,
        caption:
          typeof candidate.caption === "string" && candidate.caption.trim()
            ? candidate.caption.trim()
            : undefined,
        send_as:
          typeof candidate.send_as === "string" && candidate.send_as.trim()
            ? candidate.send_as.trim().toLowerCase()
            : undefined,
      };
    });
  }

  private async resolveChannelOutboundAttachments(
    context: ChatContextState,
    raw: Record<string, unknown>,
  ): Promise<ResolvedChannelAttachment[]> {
    const inputs = this.readChannelAttachmentInputs(raw);
    const attachments: ResolvedChannelAttachment[] = [];
    let totalBytes = 0;

    for (const input of inputs) {
      const attachment = await this.resolveChannelOutboundAttachment(
        context,
        input,
      );
      totalBytes += attachment.size;
      if (totalBytes > MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES) {
        throw new Error("Total attachment size must be 25 MB or less");
      }
      attachments.push(attachment);
    }

    return attachments;
  }

  private async resolveChannelOutboundAttachment(
    context: ChatContextState,
    input: ChannelToolAttachmentInput,
  ): Promise<ResolvedChannelAttachment> {
    const resolved = this.resolveMountedAttachmentPath(input.path);
    if (!resolved) {
      throw new Error(
        "attachments[].path must start with uploads/ or outputs/",
      );
    }

    const key = buildWorkspaceScopedR2Key(
      context.orgId,
      context.workspaceId,
      `${resolved.bucketDir}/${resolved.relativePath}`,
    );
    const object = await resolveObjectStore(this.env).get(key);
    if (!object) {
      throw new Error(`Attachment not found: ${input.path}`);
    }
    if (
      typeof object.size === "number" &&
      object.size > MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES
    ) {
      throw new Error("Attachment size must be 25 MB or less");
    }

    const content = await object.arrayBuffer();
    if (content.byteLength > MAX_CHANNEL_OUTBOUND_ATTACHMENT_BYTES) {
      throw new Error("Attachment size must be 25 MB or less");
    }
    const filename =
      input.filename ||
      resolved.relativePath.split("/").filter(Boolean).pop() ||
      "attachment";
    const contentType =
      input.content_type ||
      object.httpMetadata?.contentType ||
      this.inferContentType(filename);

    return {
      path: input.path,
      filename: this.sanitizeAttachmentFilename(filename),
      contentType,
      content,
      size: object.size || content.byteLength,
      caption: input.caption,
      sendAs: input.send_as,
    };
  }

  private resolveMountedAttachmentPath(path: string): {
    bucketDir: "user-uploads" | "user-outputs";
    relativePath: string;
  } | null {
    const normalized = path.trim().replace(/\\/g, "/");
    const prefixes: Array<{
      prefix: string;
      bucketDir: "user-uploads" | "user-outputs";
    }> = [
      { prefix: "uploads/", bucketDir: "user-uploads" },
      { prefix: "outputs/", bucketDir: "user-outputs" },
    ];
    for (const { prefix, bucketDir } of prefixes) {
      if (!normalized.startsWith(prefix)) continue;
      const relativePath = normalized.slice(prefix.length);
      if (
        !relativePath ||
        relativePath.startsWith("/") ||
        relativePath.split("/").some((part) => part === ".." || part === "")
      ) {
        return null;
      }
      return { bucketDir, relativePath };
    }
    return null;
  }

  private sanitizeAttachmentFilename(filename: string): string {
    const base = filename.split(/[\\/]/).filter(Boolean).pop() || "attachment";
    const sanitized = base.replace(/[\r\n"]/g, "_").slice(0, 180).trim();
    return sanitized || "attachment";
  }

  private inferContentType(filename: string): string {
    const ext = filename.toLowerCase().split(".").pop() || "";
    const map: Record<string, string> = {
      csv: "text/csv",
      gif: "image/gif",
      html: "text/html",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      json: "application/json",
      md: "text/markdown",
      pdf: "application/pdf",
      png: "image/png",
      txt: "text/plain",
      webp: "image/webp",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip",
    };
    return map[ext] || "application/octet-stream";
  }

  async sendChannelEmailTool(
    context: ChatContextState,
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    if (isSelfhostRuntime(this.env)) {
      throw new Error(SELFHOST_OUTBOUND_EMAIL_DISABLED_MESSAGE);
    }
    const orgStub = this.env.ORG.get(
      this.env.ORG.idFromName(context.orgId),
    ) as unknown as OrgDO;
    const orgInfo = await orgStub.getInfo();
    if (
      !orgInfo ||
      !getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
        .emailInbox
    ) {
      throw new Error(
        "Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.",
      );
    }

    const currentThread = await this.getCurrentThreadRecordIfAvailable(context);
    const originatingEmailThread =
      currentThread?.source?.trim() === "channel" &&
      currentThread.channel_kind === "email"
        ? currentThread
        : null;
    const raw = this.readToolObjectParams(params);
    const to = this.requiredToolString(raw, "to");
    const subject = this.requiredToolString(raw, "subject");
    const text = this.optionalToolString(raw, "text");
    const html = this.optionalToolString(raw, "html");
    const attachments = await this.resolveChannelOutboundAttachments(
      context,
      raw,
    );
    if (!text && !html && attachments.length === 0) {
      throw new Error("send_email requires text, html, or attachments");
    }

    const email = resolveEmailBinding(this.env);
    if (!email) {
      throw new Error("Cloudflare Email Sending binding EMAIL is not configured");
    }
    const fallbackFrom = originatingEmailThread?.channel_connection_id?.trim() || "";
    let from = fallbackFrom;
    const emailDomain = getWorkspaceEmailDomain(this.env);
    const workspaceInfo = await orgStub.getWorkspaceRecord(context.workspaceId);
    const emailHandle = workspaceInfo?.email_handle?.trim();
    if (emailDomain && emailHandle) {
      from = buildWorkspaceEmailSenderAddress(
        emailHandle,
        emailDomain,
      );
    } else if (!from) {
      if (!emailDomain) {
        throw new Error("Workspace email domain is not configured");
      }
      throw new Error("Workspace email sender is not configured");
    }

    const explicitReplyTo = this.optionalToolString(raw, "reply_to");
    const replyTo = explicitReplyTo || originatingEmailThread?.channel_connection_id || undefined;
    const emailReferenceIds = currentThread
      ? await this.readEmailThreadReferenceIds(context, currentThread)
      : [];
    const emailReplyHeaders = emailReferenceIds.length > 0
      ? buildEmailReplyHeaders({
          inReplyToMessageId: emailReferenceIds.at(-1),
          referenceMessageIds: emailReferenceIds,
        })
      : undefined;
    const body: Parameters<CloudflareEmailSender["send"]>[0] = {
      from,
      to,
      subject,
    };
    if (text) body.text = text;
    if (html) body.html = html;
    if (replyTo) body.replyTo = replyTo;
    if (emailReplyHeaders) body.headers = emailReplyHeaders;
    if (attachments.length > 0) {
      body.attachments = attachments.map((attachment) => ({
        content: attachment.content,
        filename: attachment.filename,
        type: attachment.contentType,
        disposition: "attachment",
      }));
    }
    const response = await email.send(body);
    if (response.messageId) {
      const nextReferenceIds = appendEmailThreadReferenceIds(
        emailReferenceIds,
        response.messageId,
      );
      await Promise.all([
        this.env.APP_KV.put(
          getEmailReplyReferenceKey(context.workspaceId, response.messageId),
          context.threadId,
          { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
        ),
        currentThread && nextReferenceIds.length > 0
          ? this.env.APP_KV.put(
              getEmailThreadReferencesKey(context.workspaceId, context.threadId),
              JSON.stringify(nextReferenceIds),
              { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
            )
          : Promise.resolve(),
      ]).catch((error) => {
        console.error("[send_email] failed to persist email thread metadata", {
          orgId: context.orgId,
          workspaceId: context.workspaceId,
          threadId: context.threadId,
          messageId: response.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    await this.markThreadChannelUsedBestEffort(context, "email");

    return {
      content: [{ type: "text", text: "Email sent." }],
      details: {
        status: "sent",
        channel: "email",
        provider: "cloudflare_email",
        messageId: response.messageId,
        attachmentCount: attachments.length,
      },
    };
  }

  async sendChannelSlackMessageTool(
    context: ChatContextState,
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const thread = await this.getOriginatingChannelThread(context, "slack");
    const raw = this.readToolObjectParams(params);
    const text = this.optionalToolString(raw, "text");
    const attachments = await this.resolveChannelOutboundAttachments(
      context,
      raw,
    );
    if (!text && attachments.length === 0) {
      throw new Error("send_slack_message requires text or attachments");
    }

    const explicitChannelId = this.optionalToolString(raw, "channel_id");
    const explicitThreadTs = this.optionalToolString(raw, "thread_ts");
    const threadConversation = thread?.channel_conversation_id
      ? this.parseSlackChannelConversation(thread.channel_conversation_id)
      : null;
    const conversation = explicitChannelId
      ? {
          teamId: this.optionalToolString(raw, "team_id") || threadConversation?.teamId || "",
          channelId: explicitChannelId,
          rootTs: explicitThreadTs || "dm",
        }
      : threadConversation;
    if (!conversation?.channelId) {
      throw new Error("Slack channel_id is required outside Slack-originated threads");
    }

    const explicitIntegrationId = this.optionalToolString(raw, "integration_id");
    const explicitTeamId = this.optionalToolString(raw, "team_id") || conversation.teamId;
    const integrationId = explicitIntegrationId || thread?.channel_connection_id?.trim() || "";
    const orgStub = this.getOrgStub(context.orgId);
    const integrations = integrationId
      ? []
      : await orgStub.getWorkspaceIntegrations(context.workspaceId);
    const slackIntegrations = integrations.filter((candidate) => candidate.integration_type === "slack");
    if (!integrationId && slackIntegrations.length === 0) {
      throw new Error("Slack integration_id is required because no Slack connection is available");
    }
    if (!integrationId && slackIntegrations.length > 1 && !explicitTeamId) {
      throw new Error("Multiple Slack integrations are available; provide integration_id or team_id");
    }

    const candidates = integrationId
      ? [await orgStub.getWorkspaceIntegration(context.workspaceId, integrationId)]
      : slackIntegrations;
    let selected: {
      integration: Awaited<ReturnType<OrgDO["getWorkspaceIntegration"]>>;
      credentials: Record<string, unknown>;
    } | null = null;
    for (const candidate of candidates) {
      if (!candidate || candidate.integration_type !== "slack") continue;
      const credentials = await decryptCredentials<Record<string, unknown>>(
        candidate.credentials_encrypted,
        this.env.INTEGRATION_SECRET_KEY,
      );
      const credentialTeamId = typeof credentials.team_id === "string"
        ? credentials.team_id.trim()
        : "";
      if (explicitTeamId && credentialTeamId && credentialTeamId !== explicitTeamId) {
        continue;
      }
      selected = { integration: candidate, credentials };
      break;
    }
    if (!selected) {
      throw new Error(
        explicitTeamId
          ? `Slack integration is no longer available for team ${explicitTeamId}`
          : "Slack integration is no longer available",
      );
    }
    const { credentials } = selected;
    const token =
      typeof credentials.access_token === "string"
        ? credentials.access_token.trim()
        : "";
    if (!token) {
      throw new Error("Slack access token is not configured");
    }

    let responseJson: {
      ok?: boolean;
      error?: string;
      ts?: string;
      files?: Array<{ id?: string }>;
    } | null;
    if (attachments.length > 0) {
      responseJson = await this.uploadSlackAttachments({
        token,
        channelId: conversation.channelId,
        threadTs: conversation.rootTs && conversation.rootTs !== "dm" ? conversation.rootTs : undefined,
        text,
        attachments,
      });
    } else {
      const response = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: conversation.channelId,
          thread_ts: conversation.rootTs && conversation.rootTs !== "dm" ? conversation.rootTs : undefined,
          text,
        }),
      });
      responseJson = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        ts?: string;
      } | null;
      if (!response.ok || responseJson?.ok !== true) {
        throw new Error(
          `Slack send failed: ${responseJson?.error || response.statusText}`,
        );
      }
    }
    await this.markThreadChannelUsedBestEffort(context, "slack");

    return {
      content: [{ type: "text", text: "Slack message sent." }],
      details: {
        status: "sent",
        channel: "slack",
        teamId: conversation.teamId,
        channelId: conversation.channelId,
        ts: responseJson.ts,
        attachmentCount: attachments.length,
        fileIds: responseJson.files?.map((file) => file.id).filter(Boolean),
      },
    };
  }

  async sendChannelTelegramMessageTool(
    context: ChatContextState,
    params: unknown,
  ): Promise<AgentToolResult<unknown>> {
    const thread = await this.getOriginatingChannelThread(context, "telegram");
    const token = this.env.TELEGRAM_BOT_TOKEN?.trim();
    if (!token) {
      throw new Error("Telegram channel is not configured");
    }
    const raw = this.readToolObjectParams(params);
    const text = this.optionalToolString(raw, "text");
    const attachments = await this.resolveChannelOutboundAttachments(
      context,
      raw,
    );
    if (!text && attachments.length === 0) {
      throw new Error("send_telegram_message requires text or attachments");
    }
    const explicitChatId = this.optionalToolString(raw, "chat_id");
    let integrationId = this.optionalToolString(raw, "integration_id");
    let chatId = thread?.channel_conversation_id?.trim() || "";
    let telegramIntegrationId = thread?.channel_connection_id?.trim() || "";
    let telegramTitle = thread?.title || "Telegram chat";
    let recordChannelHistory = false;
    if (!chatId) {
      const orgStub = this.getOrgStub(context.orgId);
      if (!integrationId) {
        const integrations = await orgStub.getWorkspaceIntegrations(
          context.workspaceId,
        );
        const connectedTelegramIntegrations = integrations.filter((candidate) => {
          if (candidate.integration_type !== "telegram") return false;
          try {
            const config = JSON.parse(candidate.config || "{}") as Record<string, unknown>;
            return typeof config.chat_id === "string" && config.chat_id.trim().length > 0;
          } catch {
            return false;
          }
        });
        if (connectedTelegramIntegrations.length === 0) {
          throw new Error(
            "No connected Telegram integrations are available. Ask the user to connect Telegram first.",
          );
        }
        if (connectedTelegramIntegrations.length > 1) {
          throw new Error(
            "Multiple Telegram integrations are available. Call tools.list_integrations({}) and pass the desired Telegram integration id as integration_id.",
          );
        }
        integrationId = connectedTelegramIntegrations[0].id;
      }
      if (!integrationId) {
        throw new Error("Telegram integration_id is required");
      }
      const integration = await orgStub.getWorkspaceIntegration(
        context.workspaceId,
        integrationId,
      );
      if (!integration || integration.integration_type !== "telegram") {
        throw new Error("Telegram integration is no longer available");
      }
      const config = JSON.parse(integration.config || "{}") as Record<string, unknown>;
      const configuredChatId = typeof config.chat_id === "string"
        ? config.chat_id.trim()
        : "";
      if (!configuredChatId) {
        throw new Error("Telegram integration is not connected to a chat");
      }
      if (explicitChatId && explicitChatId !== configuredChatId) {
        throw new Error(
          "Telegram chat_id does not match the configured workspace integration",
        );
      }
      chatId = configuredChatId;
      telegramIntegrationId = integrationId;
      telegramTitle =
        (typeof config.chat_title === "string" && config.chat_title.trim()) ||
        integration.name ||
        "Telegram chat";
      recordChannelHistory = true;
    } else if (explicitChatId && explicitChatId !== chatId) {
      throw new Error("Telegram chat_id does not match the originating conversation");
    }

    const sentMessageIds: Array<number | undefined> = [];
    if (text) {
      const formatted = formatMarkdownForTelegram(text);
      const response = await this.fetchTelegramBotApi(token, "sendMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatted.text,
          parse_mode: formatted.parseMode,
        }),
      });
      const responseJson = await response.json().catch(() => null) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      } | null;
      if (!response.ok || responseJson?.ok !== true) {
        throw new Error(
          `Telegram send failed: ${responseJson?.description || response.statusText}`,
        );
      }
      sentMessageIds.push(responseJson.result?.message_id);
    }

    for (const attachment of attachments) {
      const responseJson = await this.sendTelegramAttachment({
        token,
        chatId,
        attachment,
      });
      sentMessageIds.push(responseJson.result?.message_id);
    }

    const channelHistoryStatus = await this.recordOutboundChannelHistory(context, {
      kind: "telegram",
      remoteConversationId: chatId,
      integrationId: telegramIntegrationId,
      title: telegramTitle,
      recordHistory: recordChannelHistory,
      text: text || undefined,
      providerMessageIds: sentMessageIds,
      attachmentCount: attachments.length,
      firstUserMessage:
        text?.trim() ||
        (attachments.length > 0 ? "Outbound Telegram attachment sent." : null),
    }).catch((error) => {
      console.error("[ChatThreadDO] failed to record Telegram outbound history", error);
      return "error" as const;
    });
    await this.markThreadChannelUsedBestEffort(context, "telegram");

    return {
      content: [{ type: "text", text: "Telegram message sent." }],
      details: {
        status: "sent",
        channel: "telegram",
        chatId,
        integrationId: telegramIntegrationId || undefined,
        messageId: sentMessageIds[0],
        messageIds: sentMessageIds,
        attachmentCount: attachments.length,
        channelHistoryStatus,
      },
    };
  }

  async sendChannelDiscordMessageTool(
    context: ChatContextState,
    params: unknown,
    options: { operationId?: string } = {},
  ): Promise<AgentToolResult<unknown>> {
    if (!this.env.DISCORD_BRIDGE) {
      throw new Error("Discord channel is not configured");
    }
    const thread = await this.getOriginatingChannelThread(context, "discord");
    const raw = this.readToolObjectParams(params);
    const text = this.optionalToolString(raw, "text");
    const attachments = await this.resolveChannelOutboundAttachments(context, raw);
    if (!text && attachments.length === 0) {
      throw new Error("send_discord_message requires text or attachments");
    }

    const explicitIntegrationId = this.optionalToolString(raw, "integration_id");
    const originatingIntegrationId = thread?.channel_connection_id?.trim() || "";
    if (
      originatingIntegrationId &&
      explicitIntegrationId &&
      explicitIntegrationId !== originatingIntegrationId
    ) {
      throw new Error(
        "integration_id does not match the originating Discord conversation",
      );
    }
    let integrationId = originatingIntegrationId || explicitIntegrationId;
    const orgStub = this.getOrgStub(context.orgId);
    const discord = discordBridgeClient(this.env.DISCORD_BRIDGE);
    const getBinding = async (candidateId: string): Promise<DiscordBridgeBindingRecord | null> => {
      return discord.binding(candidateId);
    };
    if (!integrationId) {
      const integrations = await orgStub.getWorkspaceIntegrations(context.workspaceId);
      const discordIntegrations = integrations.filter(
        (candidate) => candidate.integration_type === "discord_channel",
      );
      const activeDiscord = (
        await Promise.all(discordIntegrations.map(async (candidate) => ({
          integration: candidate,
          binding: await getBinding(candidate.id),
        })))
      ).filter(
        (candidate): candidate is {
          integration: (typeof discordIntegrations)[number];
          binding: DiscordBridgeBindingRecord;
        } => candidate.binding !== null,
      );
      if (activeDiscord.length === 0) {
        throw new Error(
          "No active Discord channel is available. Ask the user to connect Discord first.",
        );
      }
      if (activeDiscord.length > 1) {
        throw new Error(
          "Multiple Discord channels are available. Call tools.list_integrations({}) and pass the desired integration id as integration_id.",
        );
      }
      integrationId = activeDiscord[0].integration.id;
    }
    if (!integrationId) throw new Error("Discord integration_id is required");
    const integration = await orgStub.getWorkspaceIntegration(
      context.workspaceId,
      integrationId,
    );
    if (!integration || integration.integration_type !== "discord_channel") {
      throw new Error("Discord integration is no longer available");
    }
    const binding = await getBinding(integrationId);
    if (!binding) {
      throw new Error("Discord integration is not connected to an active channel");
    }

    const stableOperationId = options.operationId?.trim() ||
      `discord-tool-fallback:${crypto.randomUUID()}`;
    let guildId = binding.guildId;
    let discordThreadId = "";
    let recordChannelHistory = false;
    let proactiveStarterMessageId = "";
    let proactiveStarterConsumedText = false;
    const conversationId = thread?.channel_conversation_id?.trim() || "";
    if (conversationId) {
      const separator = conversationId.indexOf(":");
      if (separator <= 0 || separator === conversationId.length - 1) {
        throw new Error("Originating Discord conversation is invalid");
      }
      guildId = conversationId.slice(0, separator);
      discordThreadId = conversationId.slice(separator + 1);
      if (guildId !== binding.guildId) {
        throw new Error("Originating Discord server no longer matches the integration");
      }
    } else {
      const proactive = await discord.startProactiveThread({
        integrationId,
        name: text?.replace(/\s+/gu, " ").trim().slice(0, 100) || "Camel update",
        // A short text send can be the Discord thread's stable starter
        // message. Reusing it avoids posting the same text again in-thread.
        ...(text && text.length <= 2_000 ? { starterText: text } : {}),
        idempotencyKey: `${stableOperationId}:thread`,
      });
      discordThreadId = proactive.threadId;
      guildId = proactive.guildId;
      proactiveStarterMessageId = proactive.starterMessageId?.trim() || "";
      proactiveStarterConsumedText = Boolean(
        proactiveStarterMessageId && text && text.length <= 2_000,
      );
      recordChannelHistory = true;
    }

    const operationId = `${stableOperationId}:message`;
    let response: {
      ok: true;
      threadId: string;
      integrationId: string;
      messageIds: string[];
      chunkCount: number;
      attachmentCount: number;
    };
    if (attachments.length > 0) {
      const form = new FormData();
      form.set("payload", JSON.stringify({
        integrationId,
        threadId: discordThreadId,
        text: proactiveStarterConsumedText ? undefined : text || undefined,
        idempotencyKey: operationId,
      }));
      for (const attachment of attachments) {
        form.append(
          "files",
          new Blob([attachment.content], { type: attachment.contentType }),
          attachment.filename,
        );
      }
      const attachmentResponse = await discord.sendMessage(form);
      response = proactiveStarterConsumedText
        ? {
            ...attachmentResponse,
            messageIds: [
              proactiveStarterMessageId,
              ...attachmentResponse.messageIds,
            ],
            chunkCount: attachmentResponse.chunkCount + 1,
          }
        : attachmentResponse;
    } else if (proactiveStarterConsumedText) {
      response = {
        ok: true,
        threadId: discordThreadId,
        integrationId,
        messageIds: [proactiveStarterMessageId],
        chunkCount: 1,
        attachmentCount: 0,
      };
    } else {
      response = await discord.sendMessage({
        integrationId,
        threadId: discordThreadId,
        text: text!,
        idempotencyKey: operationId,
      });
    }

    const channelHistoryStatus = await this.recordOutboundChannelHistory(context, {
      kind: "discord",
      remoteConversationId: `${guildId}:${discordThreadId}`,
      integrationId,
      title: binding.parentChannelName || integration.name || "Discord",
      recordHistory: recordChannelHistory,
      text: text || undefined,
      providerMessageIds: response.messageIds,
      attachmentCount: attachments.length,
      firstUserMessage: null,
    }).catch((error) => {
      console.error("[ChatThreadDO] failed to record Discord outbound history", error);
      return "error" as const;
    });
    await this.markThreadChannelUsedBestEffort(context, "discord");

    return {
      content: [{ type: "text", text: "Discord message sent." }],
      details: {
        status: "sent",
        channel: "discord",
        integrationId,
        guildId,
        threadId: discordThreadId,
        messageId: response.messageIds[0],
        messageIds: response.messageIds,
        chunkCount: response.chunkCount,
        attachmentCount: response.attachmentCount,
        channelHistoryStatus,
      },
    };
  }

  private async recordOutboundChannelHistory(
    context: ChatContextState,
    args: {
      kind: "discord" | "telegram";
      remoteConversationId: string;
      integrationId: string;
      title: string;
      recordHistory: boolean;
      text?: string;
      providerMessageIds: Array<string | number | undefined>;
      attachmentCount: number;
      firstUserMessage: string | null;
    },
  ): Promise<"recorded" | "skipped"> {
    if (!args.recordHistory || !args.integrationId) return "skipped";
    const firstProviderMessageId = args.providerMessageIds
      .map((id) => (id === undefined ? "" : String(id)))
      .find(Boolean);
    const channelThread = await getOrCreateChannelThread(
      this.env as Parameters<typeof getOrCreateChannelThread>[0],
      {
        kind: args.kind,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        connectionId: args.integrationId,
        remoteConversationId: args.remoteConversationId,
        title: args.title,
        createdBy: args.kind,
        firstUserMessage: args.firstUserMessage,
        firstRemoteMessageId: firstProviderMessageId
          ? `outbound:${firstProviderMessageId}`
          : undefined,
      },
    );
    if (channelThread.threadId === context.threadId) return "skipped";
    const stub = this.env.CHAT_THREAD.get(
      this.env.CHAT_THREAD.idFromName(channelThread.threadId),
    ) as unknown as {
      appendChannelHistoryEvent: (
        input: ChannelHistoryEventRequest,
      ) => Promise<ChannelHistoryEventResult> | ChannelHistoryEventResult;
    };
    const result = await stub.appendChannelHistoryEvent({
      threadId: channelThread.threadId,
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      channelKind: args.kind,
      connectionId: args.integrationId,
      remoteConversationId: args.remoteConversationId,
      sourceThreadId: context.threadId,
      direction: "outbound",
      text: args.text,
      providerMessageIds: args.providerMessageIds,
      attachmentCount: args.attachmentCount,
      sentAt: Date.now(),
    });
    if (result.status === "error") {
      throw new Error(result.error || `Failed to record ${args.kind} channel history`);
    }
    return result.status === "appended" ? "recorded" : "skipped";
  }

  private async fetchTelegramBotApi(
    token: string,
    method: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_BOT_API_TIMEOUT_MS);
    try {
      return await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Telegram ${method} request timed out after ${TELEGRAM_BOT_API_TIMEOUT_MS}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uploadSlackAttachments(args: {
    token: string;
    channelId: string;
    threadTs?: string;
    text: string | null;
    attachments: ResolvedChannelAttachment[];
  }): Promise<{ ts?: string; files?: Array<{ id?: string }> }> {
    const files: Array<{ id: string; title: string }> = [];
    for (const attachment of args.attachments) {
      const uploadUrlResponse = await fetch(
        "https://slack.com/api/files.getUploadURLExternal",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${args.token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            filename: attachment.filename,
            length: attachment.size,
          }),
        },
      );
      const uploadUrlJson = await uploadUrlResponse.json().catch(() => null) as {
        ok?: boolean;
        error?: string;
        upload_url?: string;
        file_id?: string;
      } | null;
      if (
        !uploadUrlResponse.ok ||
        uploadUrlJson?.ok !== true ||
        !uploadUrlJson.upload_url ||
        !uploadUrlJson.file_id
      ) {
        throw new Error(
          `Slack file upload URL failed: ${uploadUrlJson?.error || uploadUrlResponse.statusText}`,
        );
      }

      const uploadResponse = await fetch(uploadUrlJson.upload_url, {
        method: "POST",
        headers: { "Content-Type": attachment.contentType },
        body: attachment.content,
      });
      if (!uploadResponse.ok) {
        throw new Error(
          `Slack file upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
        );
      }
      files.push({
        id: uploadUrlJson.file_id,
        title: attachment.filename,
      });
    }

    const completeResponse = await fetch(
      "https://slack.com/api/files.completeUploadExternal",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          files,
          channel_id: args.channelId,
          ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
          ...(args.text ? { initial_comment: args.text } : {}),
        }),
      },
    );
    const completeJson = await completeResponse.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      ts?: string;
      files?: Array<{ id?: string }>;
    } | null;
    if (!completeResponse.ok || completeJson?.ok !== true) {
      throw new Error(
        `Slack file upload completion failed: ${completeJson?.error || completeResponse.statusText}`,
      );
    }
    return completeJson;
  }

  private isTelegramPhotoAttachment(attachment: ResolvedChannelAttachment): boolean {
    if (attachment.sendAs === "document") return false;
    if (attachment.sendAs === "photo") return true;
    const contentType = attachment.contentType.toLowerCase().split(";")[0]?.trim();
    if (contentType === "image/jpeg" || contentType === "image/png") {
      return true;
    }
    // Telegram Bot API sendPhoto accepts JPEG/PNG-style photos. Avoid sending
    // formats such as SVG/GIF/WebP as photos because they have separate Bot API
    // methods or may be rejected; keep those as documents for reliability.
    const filename = attachment.filename.toLowerCase();
    return filename.endsWith(".jpg") ||
      filename.endsWith(".jpeg") ||
      filename.endsWith(".png");
  }

  private async sendTelegramAttachment(args: {
    token: string;
    chatId: string;
    attachment: ResolvedChannelAttachment;
  }): Promise<{ result?: { message_id?: number } }> {
    const asPhoto = this.isTelegramPhotoAttachment(args.attachment);
    try {
      return await this.sendTelegramMultipart({
        ...args,
        method: asPhoto ? "sendPhoto" : "sendDocument",
        fieldName: asPhoto ? "photo" : "document",
        errorLabel: asPhoto ? "photo" : "document",
      });
    } catch (error) {
      if (!asPhoto || args.attachment.sendAs === "photo") throw error;
      console.warn("[ChatThreadDO] Telegram photo send failed; retrying as document", {
        filename: args.attachment.filename,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.sendTelegramMultipart({
        ...args,
        method: "sendDocument",
        fieldName: "document",
        errorLabel: "document",
      });
    }
  }

  private async sendTelegramMultipart(args: {
    token: string;
    chatId: string;
    attachment: ResolvedChannelAttachment;
    method: "sendPhoto" | "sendDocument";
    fieldName: "photo" | "document";
    errorLabel: "photo" | "document";
  }): Promise<{ result?: { message_id?: number } }> {
    const formData = new FormData();
    formData.set("chat_id", args.chatId);
    if (args.attachment.caption) {
      const formattedCaption = formatMarkdownForTelegram(
        args.attachment.caption.slice(0, 1024),
      );
      formData.set("caption", formattedCaption.text);
      formData.set("parse_mode", formattedCaption.parseMode);
    }
    formData.set(
      args.fieldName,
      new Blob([args.attachment.content], {
        type: args.attachment.contentType,
      }),
      args.attachment.filename,
    );

    const response = await this.fetchTelegramBotApi(args.token, args.method, {
      method: "POST",
      body: formData,
    });
    const responseJson = await response.json().catch(() => null) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    } | null;
    if (!response.ok || responseJson?.ok !== true) {
      throw new Error(
        `Telegram ${args.errorLabel} send failed: ${responseJson?.description || response.statusText}`,
      );
    }
    return responseJson;
  }

  private readToolObjectParams(params: unknown): Record<string, unknown> {
    return params && typeof params === "object"
      ? params as Record<string, unknown>
      : {};
  }

  private requiredToolString(
    params: Record<string, unknown>,
    key: string,
  ): string {
    const value = this.optionalToolString(params, key);
    if (!value) {
      throw new Error(`${key} is required`);
    }
    return value;
  }

  private optionalToolString(
    params: Record<string, unknown>,
    key: string,
  ): string | null {
    const value = params[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private parseSlackChannelConversation(value: string | null): {
    teamId: string;
    channelId: string;
    rootTs: string;
  } {
    const parts = value?.split(":") ?? [];
    const [teamId, channelId, ...rest] = parts;
    const rootTs = rest.join(":");
    if (!teamId || !channelId || !rootTs) {
      throw new Error("Slack thread is missing channel routing metadata");
    }
    return { teamId, channelId, rootTs };
  }
}
