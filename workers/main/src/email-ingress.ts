import PostalMime from "postal-mime";
import type { Env } from "./types.js";
import { getOrgStub, getUserStub, getWorkspaceStub } from "./helpers/stubs.js";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths.js";
import {
  getWorkspaceEmailRoutingConfig,
  parseMailboxAddress,
  parseWorkspaceEmailAddress,
} from "../../../src/lib/workspace-email.js";
import { getBillingPlanLimits } from "../../../src/lib/billing-plans.js";
import type { Attachment as PostalMimeAttachment } from "postal-mime";
import { isOrgBanned } from "./ban-list.js";
import {
  appendEmailThreadReferenceIds,
  enqueueChannelMessage,
  EMAIL_REPLY_REFERENCE_TTL_SECONDS,
  getChannelDedupeKey,
  getEmailReplyReferenceKey,
  getEmailThreadReferencesKey,
  getOrCreateChannelThread,
} from "./channels.js";
import { resolveObjectStore } from "./binding-facades/object-store.js";

interface AuthorizedSender {
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string;
  orgId: string;
}

interface EmailThreadResolution {
  threadId: string;
  title: string;
}

interface ParsedEmailContent {
  text: string;
  attachments: PostalMimeAttachment[];
}

const EMAIL_EVENT_DEDUPE_TTL_SECONDS = 10 * 60;
const EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS = 5 * 60;
const EMAIL_EVENT_DEDUPE_PROCESSING_MAX_AGE_MS =
  EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS * 1000;
const EMAIL_EVENT_DEDUPE_DONE_VALUE = "done";
const EMAIL_EVENT_DEDUPE_LEGACY_DONE_VALUE = "1";
const MAX_EMAIL_RAW_SIZE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ATTACHMENT_BASENAME = "attachment";
const DEFAULT_ATTACHMENT_CONTENT_TYPE = "application/octet-stream";
const MIME_EXTENSION_MAP: Record<string, string> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/xml": ".xml",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function sanitizeHeaderValue(value: string, maxLength = 200): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeMessageId(rawValue: string | null): string | null {
  if (!rawValue) return null;
  const sanitized = sanitizeHeaderValue(rawValue, 512)
    .replace(/^<|>$/g, "")
    .trim();
  return sanitized || null;
}

function getEmailDedupeKey(workspaceId: string, messageId: string): string {
  return getChannelDedupeKey("email", workspaceId, messageId);
}

function buildEmailProcessingDedupeValue(
  token: string,
  startedAt: number,
): string {
  return `processing:${token}:${startedAt}`;
}

function parseEmailDedupeValue(rawValue: string | null): {
  state: "done" | "processing";
  token?: string;
  startedAt?: number;
} | null {
  if (!rawValue) return null;
  if (
    rawValue === EMAIL_EVENT_DEDUPE_DONE_VALUE ||
    rawValue === EMAIL_EVENT_DEDUPE_LEGACY_DONE_VALUE
  ) {
    return { state: "done" };
  }

  if (!rawValue.startsWith("processing:")) {
    return null;
  }

  const parts = rawValue.split(":");
  if (parts.length !== 3) return null;
  const token = parts[1]?.trim();
  const startedAt = Number(parts[2]);
  if (!token || !Number.isFinite(startedAt) || startedAt <= 0) {
    return null;
  }

  return {
    state: "processing",
    token,
    startedAt,
  };
}

function stripSubjectPrefixes(subject: string): string {
  return subject.replace(/^(\s*(re|fw|fwd)\s*:\s*)+/i, "").trim();
}

function titleFromEmail(subject: string, body: string): string {
  const subjectTitle = stripSubjectPrefixes(subject);
  if (subjectTitle) return subjectTitle.slice(0, 100);

  const firstLine =
    body
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) || "Email conversation";
  return firstLine.slice(0, 100);
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function buildUploadKey(
  orgId: string,
  workspaceId: string,
  filename: string,
): string {
  return buildWorkspaceScopedR2Key(
    orgId,
    workspaceId,
    `user-uploads/${filename}`,
  );
}

function toUploadMountPath(filename: string): string {
  return `uploads/${filename}`;
}

function generateUniqueFilename(originalName: string): string {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 8);
  const ext = originalName.includes(".")
    ? originalName
        .slice(originalName.lastIndexOf("."))
        .replace(/[^a-zA-Z0-9.]/g, "_")
        .substring(0, 20)
    : "";
  const baseName = originalName.includes(".")
    ? originalName.slice(0, originalName.lastIndexOf("."))
    : originalName;
  const sanitized = baseName.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 50);
  return `${sanitized || DEFAULT_ATTACHMENT_BASENAME}-${timestamp}-${randomPart}${ext}`;
}

function normalizeAttachmentName(
  attachment: PostalMimeAttachment,
  index: number,
): string {
  const fromFilename =
    typeof attachment.filename === "string" ? attachment.filename.trim() : "";
  if (fromFilename) return fromFilename.slice(0, 255);

  const fallbackBase = `${DEFAULT_ATTACHMENT_BASENAME}-${index + 1}`;
  const extension =
    MIME_EXTENSION_MAP[(attachment.mimeType || "").toLowerCase()] || "";
  return `${fallbackBase}${extension}`.slice(0, 255);
}

function decodeBase64Content(content: string): Uint8Array | null {
  try {
    const compact = content.replace(/\s+/g, "");
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function toAttachmentPayload(
  attachment: PostalMimeAttachment,
): { body: ArrayBuffer | Uint8Array; size: number } | null {
  const content = attachment.content as unknown;

  if (content instanceof ArrayBuffer) {
    return { body: content, size: content.byteLength };
  }

  if (ArrayBuffer.isView(content)) {
    const body = new Uint8Array(
      content.buffer,
      content.byteOffset,
      content.byteLength,
    );
    return { body, size: body.byteLength };
  }

  if (typeof content !== "string") return null;

  if (attachment.encoding === "base64") {
    const decoded = decodeBase64Content(content);
    if (!decoded) return null;
    return { body: decoded, size: decoded.byteLength };
  }

  const encoded = new TextEncoder().encode(content);
  return { body: encoded, size: encoded.byteLength };
}

function shouldUploadAttachment(attachment: PostalMimeAttachment): boolean {
  if (attachment.related) return false;
  if (!attachment.content) return false;
  if (attachment.disposition === "inline" && !attachment.filename) return false;
  return true;
}

function appendUploadRefsToMessage(
  content: string,
  uploadPaths: string[],
): string {
  if (uploadPaths.length === 0) return content.trim();
  const refs = uploadPaths
    .map((path) => `(user uploaded file to ${path})`)
    .join("\n");
  const trimmed = content.trim();
  return trimmed ? `${trimmed}\n\n${refs}` : refs;
}

async function parseEmailContent(
  message: ForwardableEmailMessage,
): Promise<ParsedEmailContent> {
  const rawBytes = await new Response(message.raw).arrayBuffer();

  try {
    const parser = new PostalMime();
    const parsed = (await parser.parse(rawBytes)) as {
      text?: string | null;
      html?: string | null;
      attachments?: PostalMimeAttachment[] | null;
    };

    const text = parsed.text?.trim() || "";
    if (text) {
      return {
        text,
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments
          : [],
      };
    }

    const html = parsed.html?.trim() || "";
    return {
      text: html ? stripHtmlTags(html) : "",
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    };
  } catch {
    const raw = new TextDecoder().decode(rawBytes);
    const normalized = raw.replace(/\r\n/g, "\n");
    const splitIndex = normalized.indexOf("\n\n");
    return {
      text: (splitIndex >= 0
        ? normalized.slice(splitIndex + 2)
        : normalized
      ).trim(),
      attachments: [],
    };
  }
}

async function uploadEmailAttachments(
  env: Env,
  args: {
    orgId: string;
    workspaceId: string;
    attachments: PostalMimeAttachment[];
  },
): Promise<string[]> {
  const uploadedPaths: string[] = [];

  for (const [index, attachment] of args.attachments.entries()) {
    if (!shouldUploadAttachment(attachment)) continue;

    const payload = toAttachmentPayload(attachment);
    if (!payload || payload.size === 0) continue;

    const originalName = normalizeAttachmentName(attachment, index);
    const storedFilename = generateUniqueFilename(originalName);
    const contentType =
      (attachment.mimeType || "").trim() || DEFAULT_ATTACHMENT_CONTENT_TYPE;
    const r2Key = buildUploadKey(args.orgId, args.workspaceId, storedFilename);

    try {
      await resolveObjectStore(env).put(r2Key, payload.body, {
        httpMetadata: { contentType },
        customMetadata: {
          originalName,
          uploadedAt: new Date().toISOString(),
          source: "email-ingress",
        },
      });
      uploadedPaths.push(toUploadMountPath(storedFilename));
    } catch (error) {
      console.error("[email-ingress] failed to upload attachment", {
        workspaceId: args.workspaceId,
        orgId: args.orgId,
        filename: attachment.filename || null,
        mimeType: attachment.mimeType || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return uploadedPaths;
}

function stripQuotedReplyContent(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^on\s.+wrote:\s*$/i.test(trimmed)) break;
    if (/^[-_]{2,}\s*original message\s*[-_]{2,}$/i.test(trimmed)) break;
    if (/^from:\s.+@.+$/i.test(trimmed) && kept.length > 0) break;
    if (trimmed.startsWith(">") && kept.length > 0) break;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

async function resolveWorkspaceFromEmailHandle(
  env: Env,
  emailHandle: string,
): Promise<{ orgId: string; workspaceId: string } | null> {
  if (!env.EMAIL_HANDLE) return null;
  const stub = env.EMAIL_HANDLE.get(env.EMAIL_HANDLE.idFromName(emailHandle));
  const workspaceId = await stub.getOwner();
  if (!workspaceId) return null;

  const wsStub = getWorkspaceStub(env, workspaceId);
  const info = await wsStub.getInfo();
  if (!info || info.archived) return null;

  return { orgId: info.org_id, workspaceId };
}

async function resolveAuthorizedSender(
  env: Env,
  workspaceId: string,
  orgId: string,
  senderEmail: string,
): Promise<AuthorizedSender | null> {
  const userId = await env.EMAIL_TO_USER.get(`email:${senderEmail}`);
  if (!userId) return null;

  const wsStub = getWorkspaceStub(env, workspaceId);
  const workspaceInfo = await wsStub.getInfo();
  if (!workspaceInfo || workspaceInfo.archived) return null;

  const orgStub = getOrgStub(env, orgId);
  const [isOrgMember, workspaceAccess, profile] = await Promise.all([
    orgStub.isMember(userId),
    orgStub.getWorkspaceAccess(workspaceId, userId),
    getUserStub(env, userId).getProfile(),
  ]);

  if (!isOrgMember) return null;
  if (workspaceAccess !== "full") return null;

  return {
    userId,
    userName: profile?.name?.trim() || senderEmail,
    userEmail: senderEmail,
    workspaceId,
    orgId,
  };
}

function extractMessageIdsFromHeaderValue(rawValue: string | null): string[] {
  if (!rawValue) return [];

  const normalized = sanitizeHeaderValue(rawValue, 1200);
  if (!normalized) return [];

  const extracted = Array.from(normalized.matchAll(/<([^>]+)>/g))
    .map((match) => normalizeMessageId(match[1] || ""))
    .filter((value): value is string => Boolean(value));

  if (extracted.length > 0) return extracted;
  const fallback = normalizeMessageId(normalized);
  return fallback ? [fallback] : [];
}

function getReplyReferenceCandidates(headers: Headers): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const inReplyTo = extractMessageIdsFromHeaderValue(
    headers.get("in-reply-to"),
  );
  const references = extractMessageIdsFromHeaderValue(
    headers.get("references"),
  ).reverse();

  for (const value of [...inReplyTo, ...references]) {
    if (seen.has(value)) continue;
    seen.add(value);
    candidates.push(value);
  }

  return candidates;
}

function getEmailThreadReferenceIds(
  headers: Headers,
  currentMessageId: string | null,
): string[] {
  const references = extractMessageIdsFromHeaderValue(
    headers.get("references"),
  );
  const inReplyTo = extractMessageIdsFromHeaderValue(
    headers.get("in-reply-to"),
  );
  return appendEmailThreadReferenceIds(references, ...inReplyTo, currentMessageId);
}

async function resolveThreadFromReplyHeaders(
  env: Env,
  args: {
    workspaceId: string;
    orgId: string;
    headers: Headers;
  },
): Promise<EmailThreadResolution | null> {
  const references = getReplyReferenceCandidates(args.headers);
  if (references.length === 0) return null;

  const orgStub = getOrgStub(env, args.orgId);
  for (const messageId of references) {
    const key = getEmailReplyReferenceKey(args.workspaceId, messageId);
    const mappedThreadId = await env.APP_KV.get(key);
    if (!mappedThreadId) continue;

    const thread = await orgStub.getThread(mappedThreadId);
    if (thread && thread.workspace_id === args.workspaceId) {
      return {
        threadId: thread.id,
        title: thread.title || "Email conversation",
      };
    }

    await env.APP_KV.delete(key);
  }

  return null;
}

async function resolveThreadForEmail(
  env: Env,
  args: {
    workspaceId: string;
    orgId: string;
    headers: Headers;
    subject: string;
    message: string;
    userId: string;
    messageId: string | null;
    recipientAddress: string;
  },
): Promise<EmailThreadResolution> {
  const fromReplyHeaders = await resolveThreadFromReplyHeaders(env, {
    workspaceId: args.workspaceId,
    orgId: args.orgId,
    headers: args.headers,
  });
  if (fromReplyHeaders) return fromReplyHeaders;

  const title = titleFromEmail(args.subject, args.message);
  const created = await getOrCreateChannelThread(env, {
    kind: "email",
    workspaceId: args.workspaceId,
    orgId: args.orgId,
    remoteConversationId: args.messageId
      ? `message:${args.messageId}`
      : `generated:${crypto.randomUUID()}`,
    connectionId: args.recipientAddress,
    title,
    createdBy: args.userId,
    firstUserMessage: args.message,
    firstRemoteMessageId: args.messageId,
    mapTtlSeconds: EMAIL_REPLY_REFERENCE_TTL_SECONDS,
  });

  return {
    threadId: created.threadId,
    title: created.title,
  };
}

export async function handleWorkspaceEmailIngress(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  if (message.rawSize > MAX_EMAIL_RAW_SIZE_BYTES) {
    message.setReject("Email is too large. Maximum size is 2 MiB.");
    return;
  }

  const routingConfig = getWorkspaceEmailRoutingConfig(env);
  if (!routingConfig) {
    message.setReject("Workspace email routing is not configured.");
    return;
  }

  const parsed = parseWorkspaceEmailAddress(message.to, {
    expectedDomain: routingConfig.domain,
  });
  if (!parsed) {
    message.setReject("Unknown workspace email address.");
    return;
  }

  const resolved = await resolveWorkspaceFromEmailHandle(
    env,
    parsed.emailHandle,
  );
  if (!resolved) {
    message.setReject("Unknown workspace email address.");
    return;
  }

  const orgInfo = await getOrgStub(env, resolved.orgId).getInfo();
  if (
    !orgInfo ||
    !getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
      .emailInbox
  ) {
    message.setReject(
      "Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.",
    );
    return;
  }

  const recipientMailbox = parseMailboxAddress(message.to);
  if (!recipientMailbox) {
    message.setReject("Unknown workspace email address.");
    return;
  }
  const recipientAddress = `${recipientMailbox.local}@${recipientMailbox.domain}`;

  const sender = parseMailboxAddress(message.from);
  if (!sender) {
    message.setReject("Invalid sender address.");
    return;
  }

  const senderEmail = `${sender.local}@${sender.domain}`;
  const authorizedSender = await resolveAuthorizedSender(
    env,
    resolved.workspaceId,
    resolved.orgId,
    senderEmail,
  );
  if (!authorizedSender) {
    message.setReject("Sender is not allowed for this workspace inbox.");
    return;
  }

  const orgBan = await isOrgBanned(env.APP_KV, {
    orgId: authorizedSender.orgId,
  });
  if (orgBan) {
    message.setReject("This workspace is blocked.");
    return;
  }

  const normalizedMessageId = normalizeMessageId(
    message.headers.get("message-id"),
  );
  const dedupeKey = normalizedMessageId
    ? getEmailDedupeKey(resolved.workspaceId, normalizedMessageId)
    : null;
  let dedupeProcessingValue: string | null = null;
  let dedupeHandled = false;
  if (dedupeKey) {
    const existing = parseEmailDedupeValue(await env.APP_KV.get(dedupeKey));
    if (existing?.state === "done") return;
    if (
      existing?.state === "processing" &&
      typeof existing.startedAt === "number" &&
      Date.now() - existing.startedAt < EMAIL_EVENT_DEDUPE_PROCESSING_MAX_AGE_MS
    ) {
      return;
    }

    dedupeProcessingValue = buildEmailProcessingDedupeValue(
      crypto.randomUUID(),
      Date.now(),
    );
    await env.APP_KV.put(dedupeKey, dedupeProcessingValue, {
      expirationTtl: EMAIL_EVENT_DEDUPE_PROCESSING_TTL_SECONDS,
    });

    const reservedValue = await env.APP_KV.get(dedupeKey);
    if (reservedValue !== dedupeProcessingValue) {
      return;
    }
  }

  try {
    const subject = sanitizeHeaderValue(
      message.headers.get("subject") || "",
      240,
    );
    const parsedContent = await parseEmailContent(message);
    const messageBody = stripQuotedReplyContent(parsedContent.text);
    const uploadedAttachmentPaths = await uploadEmailAttachments(env, {
      orgId: authorizedSender.orgId,
      workspaceId: authorizedSender.workspaceId,
      attachments: parsedContent.attachments,
    });
    const userMessage = appendUploadRefsToMessage(
      (messageBody || subject).trim(),
      uploadedAttachmentPaths,
    );

    if (!userMessage) {
      message.setReject("Email message is empty.");
      dedupeHandled = true;
      return;
    }

    const thread = await resolveThreadForEmail(env, {
      workspaceId: resolved.workspaceId,
      orgId: authorizedSender.orgId,
      headers: message.headers,
      subject,
      message: userMessage,
      userId: authorizedSender.userId,
      messageId: normalizedMessageId,
      recipientAddress,
    });

    const enqueueResult = await enqueueChannelMessage(env, {
      channelKind: "email",
      threadId: thread.threadId,
      workspaceId: authorizedSender.workspaceId,
      orgId: authorizedSender.orgId,
      userId: authorizedSender.userId,
      userName: authorizedSender.userName,
      userEmail: authorizedSender.userEmail,
      message: userMessage,
    });

    if (enqueueResult.status !== "accepted") {
      throw new Error(
        enqueueResult.error ||
          `Channel email message was not accepted (${enqueueResult.status})`,
      );
    }

    dedupeHandled = true;

    if (normalizedMessageId) {
      const referenceIds = getEmailThreadReferenceIds(
        message.headers,
        normalizedMessageId,
      );
      await Promise.all([
        env.APP_KV.put(
          getEmailReplyReferenceKey(
            authorizedSender.workspaceId,
            normalizedMessageId,
          ),
          thread.threadId,
          { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
        ),
        env.APP_KV.put(
          getEmailThreadReferencesKey(
            authorizedSender.workspaceId,
            thread.threadId,
          ),
          JSON.stringify(referenceIds),
          { expirationTtl: EMAIL_REPLY_REFERENCE_TTL_SECONDS },
        ),
      ]).catch((error) => {
        console.error(
          "[email-ingress] failed to persist email thread metadata",
          {
            workspaceId: authorizedSender.workspaceId,
            orgId: authorizedSender.orgId,
            threadId: thread.threadId,
            messageId: normalizedMessageId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
    }
  } finally {
    if (dedupeKey && dedupeProcessingValue) {
      if (dedupeHandled) {
        await env.APP_KV.put(dedupeKey, EMAIL_EVENT_DEDUPE_DONE_VALUE, {
          expirationTtl: EMAIL_EVENT_DEDUPE_TTL_SECONDS,
        });
      } else {
        const currentValue = await env.APP_KV.get(dedupeKey);
        if (currentValue === dedupeProcessingValue) {
          await env.APP_KV.delete(dedupeKey);
        }
      }
    }
  }
}
