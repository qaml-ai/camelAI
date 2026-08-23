import { isOrgBanned } from "./ban-list.js";
import {
  enqueueChannelMessage,
  getChannelDedupeKey,
  getOrCreateChannelThread,
} from "./channels.js";
import {
  DiscordBridgeRequestError,
  discordBridgeClient,
  parseDiscordChannelConfig,
  type DiscordBridgeDelivery,
  type DiscordBridgeDeliveryMessage,
  type DiscordEventQueueMessage,
} from "./discord-types.js";
import { getOrgStub } from "./helpers/stubs.js";
import type { OrgDO } from "./auth.js";
import type { Env } from "./types.js";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths.js";
import { recordErrorEvent, recordObservabilityEvent } from "./observability.js";
import { resolveObjectStore } from "./binding-facades/object-store.js";

const MAX_DISCORD_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const DISCORD_ATTACHMENT_TIMEOUT_MS = 15_000;
const DISCORD_DEDUPE_TTL_SECONDS = 24 * 60 * 60;
const DISCORD_BUSY_RETRY_SECONDS = 30;
const DISCORD_WAIT_RETRY_SECONDS = 2;

function validQueueMessage(value: unknown): value is DiscordEventQueueMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DiscordEventQueueMessage>;
  return candidate.version === 1 && typeof candidate.eventId === "string" && Boolean(candidate.eventId);
}

function safeDiscordFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\r\n"/\\]/g, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .slice(0, 140);
  return normalized || "attachment";
}

function deterministicDiscordFilename(event: DiscordBridgeDeliveryMessage, attachment: DiscordBridgeDeliveryMessage["attachments"][number]): string {
  const base = safeDiscordFilename(attachment.filename);
  return `discord-${event.discordMessageId}-${attachment.id}-${base}`.slice(0, 200);
}

function validDiscordAttachmentUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "cdn.discordapp.com") return null;
    if (!url.pathname.startsWith("/attachments/")) return null;
    return url;
  } catch {
    return null;
  }
}

function contentLength(response: Response): number | null {
  const value = Number(response.headers.get("content-length"));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readResponseBodyAtMost(
  response: Response,
  maximumBytes: number,
): Promise<ArrayBuffer | null> {
  if (!response.body) {
    const body = await response.arrayBuffer();
    return body.byteLength <= maximumBytes ? body : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel("attachment size limit exceeded").catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function ingestDiscordAttachments(
  env: Env,
  event: DiscordBridgeDeliveryMessage,
): Promise<{ uploadPaths: string[]; skipped: string[] }> {
  const uploadPaths: string[] = [];
  const skipped: string[] = [];
  let aggregateBytes = 0;
  for (const attachment of event.attachments) {
    const displayName = safeDiscordFilename(attachment.filename);
    if (attachment.size > MAX_DISCORD_ATTACHMENT_BYTES || aggregateBytes + attachment.size > MAX_DISCORD_ATTACHMENT_BYTES) {
      skipped.push(`${displayName} was skipped because Discord attachments are limited to 25 MiB per message.`);
      continue;
    }
    const url = validDiscordAttachmentUrl(attachment.url);
    if (!url) {
      skipped.push(`${displayName} was skipped because its Discord download URL was invalid.`);
      continue;
    }
    const storedFilename = deterministicDiscordFilename(event, attachment);
    const r2Key = buildWorkspaceScopedR2Key(
      event.orgId,
      event.workspaceId,
      `user-uploads/${storedFilename}`,
    );
    const bucket = resolveObjectStore(env);
    const existing = await bucket.head(r2Key);
    if (existing) {
      const existingSize = Number(existing.size || attachment.size);
      if (
        existingSize > MAX_DISCORD_ATTACHMENT_BYTES ||
        aggregateBytes + existingSize > MAX_DISCORD_ATTACHMENT_BYTES
      ) {
        skipped.push(`${displayName} was skipped because it exceeded the 25 MiB limit.`);
        continue;
      }
      aggregateBytes += existingSize;
      uploadPaths.push(`uploads/${storedFilename}`);
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCORD_ATTACHMENT_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Discord attachment download failed with status ${response.status}`);
      }
      if (!response.ok || (response.status >= 300 && response.status < 400)) {
        skipped.push(`${displayName} could not be downloaded from Discord.`);
        continue;
      }
      const declaredLength = contentLength(response);
      if (
        (declaredLength !== null && declaredLength > MAX_DISCORD_ATTACHMENT_BYTES) ||
        (declaredLength !== null && aggregateBytes + declaredLength > MAX_DISCORD_ATTACHMENT_BYTES)
      ) {
        skipped.push(`${displayName} was skipped because it exceeded the 25 MiB limit.`);
        continue;
      }
      const body = await readResponseBodyAtMost(
        response,
        MAX_DISCORD_ATTACHMENT_BYTES - aggregateBytes,
      );
      if (!body) {
        skipped.push(`${displayName} was skipped because it exceeded the 25 MiB limit.`);
        continue;
      }
      if (!body.byteLength) {
        skipped.push(`${displayName} was skipped because Discord returned an empty file.`);
        continue;
      }
      if (
        body.byteLength > MAX_DISCORD_ATTACHMENT_BYTES ||
        aggregateBytes + body.byteLength > MAX_DISCORD_ATTACHMENT_BYTES
      ) {
        skipped.push(`${displayName} was skipped because it exceeded the 25 MiB limit.`);
        continue;
      }
      const contentType =
        attachment.contentType ||
        response.headers.get("content-type") ||
        "application/octet-stream";
      await bucket.put(r2Key, body, {
        httpMetadata: { contentType },
        customMetadata: {
          originalName: displayName,
          uploadedAt: new Date().toISOString(),
          source: "discord-ingress",
          discordAttachmentId: attachment.id,
        },
      });
      aggregateBytes += body.byteLength;
      uploadPaths.push(`uploads/${storedFilename}`);
    } catch (error) {
      recordErrorEvent(env, {
        event: "discord.attachment.failed",
        component: "discord_events_queue",
        operation: "attachment_ingest",
        status: "failed",
        workspaceId: event.workspaceId,
        orgId: event.orgId,
        count: 1,
        size: attachment.size,
        sampleIndex: event.integrationId,
        error,
      });
      console.warn("[discord-events] attachment ingestion failed", {
        attachmentId: attachment.id,
        error: error instanceof Error ? error.name : "Error",
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (uploadPaths.length > 0) {
    recordObservabilityEvent(env, {
      event: "discord.attachment.stored",
      component: "discord_events_queue",
      operation: "attachment_ingest",
      status: "stored",
      workspaceId: event.workspaceId,
      orgId: event.orgId,
      count: uploadPaths.length,
      size: aggregateBytes,
      sampleIndex: event.integrationId,
    });
  }
  if (skipped.length > 0) {
    recordObservabilityEvent(env, {
      event: "discord.attachment.skipped",
      severity: "warn",
      component: "discord_events_queue",
      operation: "attachment_ingest",
      status: "skipped",
      workspaceId: event.workspaceId,
      orgId: event.orgId,
      count: skipped.length,
      sampleIndex: event.integrationId,
    });
  }
  return { uploadPaths, skipped };
}

function normalizeDiscordMessage(event: DiscordBridgeDeliveryMessage, botUserId?: string): string {
  let content = event.content;
  if (botUserId) {
    content = content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "");
  }
  for (const mention of event.mentions) {
    if (mention.id === botUserId) continue;
    const display = mention.globalName || mention.username || "Discord user";
    content = content.replace(new RegExp(`<@!?${mention.id}>`, "g"), `@${display}`);
  }
  return content.replace(/[ \t]+\n/g, "\n").trim();
}

function discordAuthorName(event: DiscordBridgeDeliveryMessage): string {
  return event.author.guildNickname ||
    event.author.globalName ||
    event.author.username ||
    `Discord user ${event.author.id.slice(-4)}`;
}

function appendDiscordAttachmentNotes(
  content: string,
  uploadPaths: string[],
  skipped: string[],
): string {
  const sections = [content.trim()];
  if (uploadPaths.length > 0) {
    sections.push(uploadPaths.map((path) => `(user uploaded file to ${path})`).join("\n"));
  }
  if (skipped.length > 0) {
    sections.push(skipped.map((note) => `(Discord attachment note: ${note})`).join("\n"));
  }
  return sections.filter(Boolean).join("\n\n");
}

function discordThreadTitle(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim() || "Camel request";
  return Array.from(normalized).slice(0, 100).join("");
}

async function finishDelivery(
  env: Env,
  eventId: string,
  leaseToken: string,
  action: "complete" | "retry" | "fail",
): Promise<void> {
  await discordBridgeClient(env.DISCORD_BRIDGE).finishDelivery(
    eventId,
    leaseToken,
    action,
  );
}

async function validateDelivery(
  env: Env,
  payload: DiscordBridgeDelivery,
): Promise<{
  orgStub: OrgDO;
  config: NonNullable<ReturnType<typeof parseDiscordChannelConfig>>;
  integration: NonNullable<Awaited<ReturnType<OrgDO["getWorkspaceIntegration"]>>>;
} | null> {
  if (await isOrgBanned(env.APP_KV, { orgId: payload.orgId })) return null;
  const orgStub = getOrgStub(env, payload.orgId) as unknown as OrgDO;
  const [workspace, integration] = await Promise.all([
    orgStub.getWorkspaceRecord(payload.workspaceId),
    orgStub.getWorkspaceIntegration(payload.workspaceId, payload.integrationId),
  ]);
  if (!workspace || workspace.archived) return null;
  if (!integration || integration.integration_type !== "discord_channel") return null;
  const config = parseDiscordChannelConfig(integration.config || "{}");
  if (!config) return null;
  return { orgStub, config, integration };
}

async function handlePermanentStarterThreadFailure(
  env: Env,
  payload: DiscordBridgeDeliveryMessage,
  validated: NonNullable<Awaited<ReturnType<typeof validateDelivery>>>,
  error: DiscordBridgeRequestError,
): Promise<void> {
  await discordBridgeClient(env.DISCORD_BRIDGE).sendFailureNotice({
    integrationId: payload.integrationId,
    parentChannelId: payload.parentChannelId,
    messageId: payload.discordMessageId,
    reason: error.code,
    idempotencyKey: `discord-starter-failure:${payload.discordMessageId}`,
  }).catch((noticeError) => {
    console.warn("[discord-events] failed to post starter failure notice", {
      integrationId: payload.integrationId,
      error: noticeError instanceof DiscordBridgeRequestError
        ? noticeError.code
        : noticeError instanceof Error ? noticeError.name : "Error",
    });
  });

  await validated.orgStub.updateWorkspaceIntegrationVerification(
    payload.workspaceId,
    payload.integrationId,
    {
      status: "degraded",
      message: error.code === "active_thread_limit"
        ? "Discord has too many active threads; archive an older thread and try again."
        : "Discord cannot create conversation threads with the current channel permissions.",
      checkedAt: Date.now(),
      live: true,
      strategy: "discord_channel_access",
    },
    "system",
    {
      config: validated.integration.config,
      credentialsEncrypted: validated.integration.credentials_encrypted,
    },
  ).catch((verificationError) => {
    console.warn("[discord-events] failed to record degraded verification", {
      integrationId: payload.integrationId,
      error: verificationError instanceof Error ? verificationError.name : "Error",
    });
  });
  recordObservabilityEvent(env, {
    event: "discord.verification",
    severity: "warn",
    component: "discord_events_queue",
    operation: "starter_thread",
    status: error.code,
    workspaceId: payload.workspaceId,
    orgId: payload.orgId,
    sampleIndex: payload.integrationId,
  });
}

async function handleLifecycleDelivery(
  env: Env,
  payload: Extract<DiscordBridgeDelivery, { kind: "lifecycle" }>,
  validated: Awaited<ReturnType<typeof validateDelivery>>,
): Promise<void> {
  if (!validated) return;
  const integration = await validated.orgStub.getWorkspaceIntegration(
    payload.workspaceId,
    payload.integrationId,
  );
  if (!integration) return;
  const config = {
    ...validated.config,
    status: "disconnected" as const,
    parent_channel_id: undefined,
    parent_channel_name: undefined,
    binding_version: undefined,
    error_code: payload.lifecycleType,
    last_verified_at: Date.now(),
  };
  await discordBridgeClient(env.DISCORD_BRIDGE).releaseBinding(
    payload.integrationId,
    payload.bindingVersion,
  );
  await validated.orgStub.updateWorkspaceIntegration(
    payload.workspaceId,
    payload.integrationId,
    { config: JSON.stringify(config) },
    integration.created_by,
  );
}

async function processClaimedDelivery(
  env: Env,
  eventId: string,
  leaseToken: string,
  payload: DiscordBridgeDelivery,
): Promise<"accepted" | "retry" | "completed"> {
  const validated = await validateDelivery(env, payload);
  if (!validated) {
    await finishDelivery(env, eventId, leaseToken, "complete");
    return "completed";
  }
  if (payload.kind === "lifecycle") {
    await handleLifecycleDelivery(env, payload, validated);
    await finishDelivery(env, eventId, leaseToken, "complete");
    return "completed";
  }

  const dedupeKey = getChannelDedupeKey(
    "discord",
    payload.workspaceId,
    payload.discordMessageId,
  );
  const dedupe = await env.APP_KV.get(dedupeKey);
  if (dedupe === "done") {
    await finishDelivery(env, eventId, leaseToken, "complete");
    return "completed";
  }
  await env.APP_KV.put(dedupeKey, "processing", {
    expirationTtl: DISCORD_DEDUPE_TTL_SECONDS,
  });

  try {
    const normalizedText = normalizeDiscordMessage(payload, validated.config.bot_user_id);
    let threadId = payload.threadId;
    if (payload.starter) {
      try {
        const thread = await discordBridgeClient(env.DISCORD_BRIDGE).startThreadFromMessage({
          integrationId: payload.integrationId,
          parentChannelId: payload.parentChannelId,
          messageId: payload.discordMessageId,
          name: discordThreadTitle(normalizedText),
          idempotencyKey: `discord-starter:${payload.discordMessageId}`,
        });
        threadId = thread.threadId;
      } catch (error) {
        if (
          error instanceof DiscordBridgeRequestError &&
          [
            "active_thread_limit",
            "missing_permissions",
            "unknown_channel",
            "bot_removed",
            "invalid_request",
          ].includes(error.code)
        ) {
          await handlePermanentStarterThreadFailure(env, payload, validated, error);
          await env.APP_KV.put(dedupeKey, "done", {
            expirationTtl: DISCORD_DEDUPE_TTL_SECONDS,
          });
          await finishDelivery(env, eventId, leaseToken, "complete");
          return "completed";
        }
        throw error;
      }
    }
    if (!threadId) throw new Error("Discord thread was not created");

    // Attachment URLs expire, so ingestion happens before the potentially busy
    // ChatThreadDO call. Deterministic R2 keys make the retry a cheap lookup.
    const attachments = await ingestDiscordAttachments(env, payload);
    const userMessage = appendDiscordAttachmentNotes(
      normalizedText,
      attachments.uploadPaths,
      attachments.skipped,
    );
    if (!normalizedText && attachments.uploadPaths.length === 0) {
      await discordBridgeClient(env.DISCORD_BRIDGE).sendMessage({
        integrationId: payload.integrationId,
        threadId,
        text: "I couldn't use the attached Discord file. Please attach a file under 25 MiB and try again.",
        idempotencyKey: `discord-invalid-attachments:${payload.discordMessageId}`,
      });
      await env.APP_KV.put(dedupeKey, "done", { expirationTtl: DISCORD_DEDUPE_TTL_SECONDS });
      await finishDelivery(env, eventId, leaseToken, "complete");
      return "completed";
    }

    const remoteConversationId = `${payload.guildId}:${threadId}`;
    const channelThread = await getOrCreateChannelThread(env, {
      kind: "discord",
      workspaceId: payload.workspaceId,
      orgId: payload.orgId,
      connectionId: payload.integrationId,
      remoteConversationId,
      title: discordThreadTitle(normalizedText),
      createdBy: "discord",
      firstUserMessage: userMessage,
      firstRemoteMessageId: payload.discordMessageId,
    });
    const result = await enqueueChannelMessage(env, {
      channelKind: "discord",
      threadId: channelThread.threadId,
      workspaceId: payload.workspaceId,
      orgId: payload.orgId,
      userName: discordAuthorName(payload),
      userEmail: null,
      message: userMessage,
      clientMessageId: `discord:${payload.discordMessageId}`,
    });
    if (result.status === "busy") {
      await env.APP_KV.delete(dedupeKey);
      await finishDelivery(env, eventId, leaseToken, "retry");
      return "retry";
    }
    if (result.status !== "accepted") {
      throw new Error(result.error || "Discord channel message was rejected");
    }
    await env.APP_KV.put(dedupeKey, "done", {
      expirationTtl: DISCORD_DEDUPE_TTL_SECONDS,
    });
    await finishDelivery(env, eventId, leaseToken, "complete");
    return "accepted";
  } catch (error) {
    await env.APP_KV.delete(dedupeKey);
    if (
      error instanceof DiscordBridgeRequestError &&
      !["rate_limited", "provider_unavailable"].includes(error.code)
    ) {
      await finishDelivery(env, eventId, leaseToken, "complete");
      return "completed";
    }
    await finishDelivery(env, eventId, leaseToken, "retry").catch(() => undefined);
    throw error;
  }
}

export async function handleDiscordEventsQueue(
  batch: MessageBatch<DiscordEventQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    if (!validQueueMessage(message.body)) {
      recordObservabilityEvent(env, {
        event: "discord.ingress.filtered",
        severity: "warn",
        component: "discord_events_queue",
        operation: "queue_consume",
        status: "invalid_queue_message",
        count: 1,
      });
      message.ack();
      continue;
    }
    try {
      const claim = await discordBridgeClient(env.DISCORD_BRIDGE).claimDelivery(
        message.body.eventId,
      );
      if (claim.status === "ordered_wait") {
        recordObservabilityEvent(env, {
          event: "discord.ingress.deferred",
          component: "discord_events_queue",
          operation: "delivery_claim",
          status: "ordered_wait",
          sampleIndex: message.body.eventId,
        });
        message.ack();
        continue;
      }
      if (claim.status === "wait") {
        recordObservabilityEvent(env, {
          event: "discord.ingress.retried",
          component: "discord_events_queue",
          operation: "delivery_claim",
          status: "lease_wait",
          sampleIndex: message.body.eventId,
        });
        message.retry({
          delaySeconds: Math.max(
            DISCORD_WAIT_RETRY_SECONDS,
            Math.ceil((claim.retryAfterMs || 0) / 1_000),
          ),
        });
        continue;
      }
      if (claim.status !== "claimed") {
        recordObservabilityEvent(env, {
          event: "discord.ingress.filtered",
          component: "discord_events_queue",
          operation: "delivery_claim",
          status: claim.status,
          sampleIndex: message.body.eventId,
        });
        message.ack();
        continue;
      }
      recordObservabilityEvent(env, {
        event: "discord.ingress.claimed",
        component: "discord_events_queue",
        operation: "delivery_claim",
        status: "claimed",
        workspaceId: claim.payload.workspaceId,
        orgId: claim.payload.orgId,
        sampleIndex: claim.payload.integrationId,
      });
      const result = await processClaimedDelivery(
        env,
        message.body.eventId,
        claim.leaseToken,
        claim.payload,
      );
      if (result === "retry") {
        recordObservabilityEvent(env, {
          event: "discord.ingress.busy",
          severity: "warn",
          component: "discord_events_queue",
          operation: "chat_enqueue",
          status: "busy",
          workspaceId: claim.payload.workspaceId,
          orgId: claim.payload.orgId,
          sampleIndex: claim.payload.integrationId,
        });
        message.retry({ delaySeconds: DISCORD_BUSY_RETRY_SECONDS });
      } else {
        recordObservabilityEvent(env, {
          event: "discord.ingress.accepted",
          component: "discord_events_queue",
          operation: "chat_enqueue",
          status: result,
          workspaceId: claim.payload.workspaceId,
          orgId: claim.payload.orgId,
          sampleIndex: claim.payload.integrationId,
        });
        message.ack();
      }
    } catch (error) {
      recordErrorEvent(env, {
        event: "discord.ingress.retried",
        component: "discord_events_queue",
        operation: "queue_consume",
        status: "failed",
        sampleIndex: message.body.eventId,
        error,
      });
      console.error("[discord-events-queue] delivery failed", {
        eventId: message.body.eventId,
        attempt: message.attempts,
        error: error instanceof DiscordBridgeRequestError
          ? error.code
          : error instanceof Error ? error.name : "Error",
      });
      const delaySeconds = error instanceof DiscordBridgeRequestError && error.retryAfterMs
        ? Math.max(1, Math.ceil(error.retryAfterMs / 1_000))
        : undefined;
      message.retry(delaySeconds ? { delaySeconds } : undefined);
    }
  }
}

export async function handleDiscordEventsDeadLetterQueue(
  batch: MessageBatch<DiscordEventQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    if (!validQueueMessage(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await discordBridgeClient(env.DISCORD_BRIDGE).deadLetterDelivery(
        message.body.eventId,
      );
      if (result.status === "wait") {
        message.retry({
          delaySeconds: Math.max(
            DISCORD_WAIT_RETRY_SECONDS,
            Math.ceil((result.retryAfterMs || 0) / 1_000),
          ),
        });
        continue;
      }
      recordObservabilityEvent(env, {
        event: "discord.ingress.failed",
        severity: "error",
        component: "discord_events_queue",
        operation: "dead_letter",
        status: result.status === "failed" ? "advanced" : result.status,
        sampleIndex: message.body.eventId,
      });
      message.ack();
    } catch (error) {
      recordErrorEvent(env, {
        event: "discord.ingress.failed",
        component: "discord_events_queue",
        operation: "dead_letter",
        status: "retry",
        sampleIndex: message.body.eventId,
        error,
      });
      console.error("[discord-events-dlq] failed to advance delivery", {
        eventId: message.body.eventId,
        error: error instanceof Error ? error.name : "Error",
      });
      message.retry();
    }
  }
}

export {
  deterministicDiscordFilename,
  normalizeDiscordMessage,
  validDiscordAttachmentUrl,
  readResponseBodyAtMost,
};
