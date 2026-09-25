import type {
  InitialUserMessageRequest,
  InitialUserMessageResult,
} from "./chat-thread-do.js";
import { getOrgStub, getWorkspaceStub } from "./helpers/stubs.js";
import {
  getDefaultLlmModel,
  getStoredBedrockAwsRegion,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
} from "../../../src/lib/llm-provider-config.js";
import { resolveModelPickerCatalog } from "../../../src/lib/model-catalog.js";
import {
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from "../../../src/lib/model-picker-config.js";
import { retryTransientDurableObjectRead } from "../../../src/lib/do-rpc-retry.server.js";
import { getEffectiveLlmProviderConfig } from "../../../src/lib/selfhost-ai-provider.js";
import { isSelfhostRuntime } from "../../../src/lib/selfhost-runtime.js";
import type { LlmModel } from "../../../src/types.js";
import type { Env } from "./types.js";
import {
  readOrgModelPickerConfig,
  readWorkspaceModelPickerConfig,
} from "./model-picker-config-reader.js";

export type ChannelKind = "email" | "slack" | "telegram" | "discord" | (string & {});

export interface ChannelAddress {
  kind: ChannelKind;
  workspaceId: string;
  orgId: string;
  remoteConversationId: string;
  connectionId?: string | null;
}

export interface ChannelThreadInput extends ChannelAddress {
  title: string;
  createdBy?: string | null;
  firstUserMessage?: string | null;
  firstRemoteMessageId?: string | null;
  mapTtlSeconds?: number;
}

export interface ChannelThreadResolution {
  threadId: string;
  title: string;
  created: boolean;
}

const CHANNEL_THREAD_MAP_PREFIX = "channel_thread:";
const EMAIL_REPLY_REFERENCE_PREFIX = "email_reply_ref:";
const EMAIL_THREAD_REFERENCES_PREFIX = "email_thread_refs:";
export const EMAIL_REPLY_REFERENCE_TTL_SECONDS = 180 * 24 * 60 * 60;
export const EMAIL_THREAD_REFERENCE_LIMIT = 20;
export const EMAIL_HEADER_VALUE_MAX_BYTES = 2048;
const CHANNEL_REPLY_TOOLS: Record<string, string> = {
  email: "send_email",
  slack: "send_slack_message",
  telegram: "send_telegram_message",
  discord: "send_discord_message",
};
const MAX_CHANNEL_KEY_PART_LENGTH = 96;

function hashChannelKeyPart(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function safeChannelKeyPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:@/-]/g, "_");
  if (normalized.length <= MAX_CHANNEL_KEY_PART_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, 80)}.${hashChannelKeyPart(normalized)}`;
}

export function getChannelThreadMapKey(address: ChannelAddress): string {
  const kind = safeChannelKeyPart(address.kind) || "unknown";
  const workspaceId = safeChannelKeyPart(address.workspaceId) || "workspace";
  const connectionId =
    safeChannelKeyPart(address.connectionId || "") || "connection";
  const remoteId =
    safeChannelKeyPart(address.remoteConversationId) || "conversation";
  return `${CHANNEL_THREAD_MAP_PREFIX}${kind}:${workspaceId}:${connectionId}:${remoteId}`;
}

export function getChannelDedupeKey(
  kind: ChannelKind,
  workspaceId: string,
  remoteMessageId: string,
): string {
  const safeKind = safeChannelKeyPart(kind) || "unknown";
  const safeWorkspace = safeChannelKeyPart(workspaceId) || "workspace";
  const safeMessage = safeChannelKeyPart(remoteMessageId) || "message";
  return `channel_event:${safeKind}:${safeWorkspace}:${safeMessage}`;
}

export function normalizeEmailReplyMessageId(messageId: string): string | null {
  const trimmed = messageId.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return null;
  const bracketed = trimmed.match(/^<([^>]+)>$/);
  return (bracketed ? bracketed[1] : trimmed).trim() || null;
}

export function getEmailReplyReferenceKey(
  workspaceId: string,
  messageId: string,
): string {
  const normalizedMessageId = normalizeEmailReplyMessageId(messageId) ?? messageId;
  const safeWorkspaceId = safeChannelKeyPart(workspaceId) || "workspace";
  const safeMessageId = safeChannelKeyPart(normalizedMessageId) || "message";
  return `${EMAIL_REPLY_REFERENCE_PREFIX}${safeWorkspaceId}:${safeMessageId}`;
}

export function getEmailThreadReferencesKey(
  workspaceId: string,
  threadId: string,
): string {
  const safeWorkspaceId = safeChannelKeyPart(workspaceId) || "workspace";
  const safeThreadId = safeChannelKeyPart(threadId) || "thread";
  return `${EMAIL_THREAD_REFERENCES_PREFIX}${safeWorkspaceId}:${safeThreadId}`;
}

export function appendEmailThreadReferenceIds(
  existing: Array<string | null | undefined>,
  ...nextIds: Array<string | null | undefined>
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of [...existing, ...nextIds]) {
    if (!value) continue;
    const normalized = normalizeEmailReplyMessageId(value);
    if (!normalized) continue;
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(normalized);
  }

  return result.slice(-EMAIL_THREAD_REFERENCE_LIMIT);
}

export function formatEmailMessageIdHeader(
  messageId: string | null | undefined,
): string | null {
  if (!messageId) return null;
  const normalized = normalizeEmailReplyMessageId(messageId);
  if (!normalized) return null;
  const safe = normalized
    .replace(/[<>\r\n]+/g, "")
    .replace(/\s+/g, "")
    .trim();
  return safe ? `<${safe}>` : null;
}

function emailHeaderValueByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function trimEmailHeaderValuesByByteLength(values: string[]): string[] {
  let startIndex = 0;
  while (
    startIndex < values.length &&
    emailHeaderValueByteLength(values.slice(startIndex).join(" ")) >
      EMAIL_HEADER_VALUE_MAX_BYTES
  ) {
    startIndex += 1;
  }
  return values.slice(startIndex);
}

export function buildEmailReplyHeaders(args: {
  inReplyToMessageId?: string | null;
  referenceMessageIds?: Array<string | null | undefined>;
}): Record<string, string> | undefined {
  const inReplyTo = formatEmailMessageIdHeader(args.inReplyToMessageId);
  const references = appendEmailThreadReferenceIds(
    args.referenceMessageIds || [],
    args.inReplyToMessageId,
  )
    .map(formatEmailMessageIdHeader)
    .filter((value): value is string => Boolean(value));
  const trimmedReferences = trimEmailHeaderValuesByByteLength(references);

  const headers: Record<string, string> = {};
  if (
    inReplyTo &&
    emailHeaderValueByteLength(inReplyTo) <= EMAIL_HEADER_VALUE_MAX_BYTES
  ) {
    headers["In-Reply-To"] = inReplyTo;
  }
  if (trimmedReferences.length > 0) {
    headers.References = trimmedReferences.join(" ");
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function getChannelReplyToolName(kind: ChannelKind): string | null {
  return CHANNEL_REPLY_TOOLS[safeChannelKeyPart(kind)] ?? null;
}

export function buildChannelReplySystemMessage(
  kind: ChannelKind,
  request: Pick<InitialUserMessageRequest, "userEmail">,
): string {
  const safeKind = safeChannelKeyPart(kind) || "unknown";
  const toolName = getChannelReplyToolName(kind);
  const emailHint =
    safeKind === "email" && request.userEmail?.trim()
      ? ` The sender email is ${request.userEmail.trim()}; use it as the to value if replying to the sender.`
      : "";
  const routingHint =
    safeKind === "slack" || safeKind === "telegram" || safeKind === "discord"
      ? " You do not need to provide the channel/chat id because the tool is already scoped to the originating conversation."
      : "";
  const replyInstruction = toolName
    ? `To reply externally, call the js_exec tool and from inside that JavaScript call await tools.${toolName}(...).${emailHint}${routingHint}`
    : "No outbound tool is configured for this channel yet; do not claim you replied externally unless you call a provider-specific send tool from js_exec.";

  return [
    "<camelai system message>",
    `This user message came from the ${safeKind} channel. Final assistant text is internal and will not be sent to the external channel automatically. ${replyInstruction}`,
    "</camelai system message>",
  ].join("");
}

export async function resolveDefaultChannelThreadModel(
  env: Env,
  args: { orgId: string; workspaceId: string },
): Promise<{ model: LlmModel }> {
  const orgStub = getOrgStub(env, args.orgId);
  const workspaceStub = getWorkspaceStub(env, args.workspaceId);
  const [
    llmProviderConfig,
    orgPickerConfig,
    workspacePickerConfig,
  ] = await Promise.all([
    retryTransientDurableObjectRead("OrgDO.getLlmProviderConfig", () =>
      Promise.resolve(orgStub.getLlmProviderConfig()),
    ),
    readOrgModelPickerConfig(orgStub),
    readWorkspaceModelPickerConfig(workspaceStub),
  ]);
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    llmProviderConfig,
  );
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderConfig);
  const effectiveConfig = resolveEffectivePickerConfig(
    orgPickerConfig,
    workspacePickerConfig,
  );
  const visibleCatalog = resolveModelPickerCatalog({
    effectiveConfig,
    orgProvider: effectiveLlmProviderConfig?.provider,
    customApi,
    customModelId,
    awsRegion,
    allowCamelCode: !isSelfhostRuntime(env),
  });
  const model = resolveDefaultModelForChat({
    effectiveDefaultModel: effectiveConfig.default_model,
    fallbackModel: getDefaultLlmModel(effectiveLlmProviderConfig?.provider, {
      customApi,
      customModelId,
      awsRegion,
    }),
    visibleCatalog,
  });
  if (!model) {
    throw new Error("No models are available");
  }
  return { model };
}

export async function getOrCreateChannelThread(
  env: Env,
  input: ChannelThreadInput,
): Promise<ChannelThreadResolution> {
  const mapKey = getChannelThreadMapKey(input);

  const existingThreadId = await env.APP_KV.get(mapKey);
  if (existingThreadId) {
    const thread = await getOrgStub(env, input.orgId).getThread(
      existingThreadId,
    );
    if (thread) {
      return {
        threadId: existingThreadId,
        title: thread.title || input.title || "Conversation",
        created: false,
      };
    }
    await env.APP_KV.delete(mapKey);
  }

  const { model } = await resolveDefaultChannelThreadModel(env, input);
  const thread = await getOrgStub(env, input.orgId).createThread(
    input.workspaceId,
    input.title.trim().slice(0, 100) || "Conversation",
    input.createdBy?.trim() || input.kind,
    input.firstUserMessage?.trim() || undefined,
    model,
    {
      source: "channel",
      channelKind: input.kind,
      channelConnectionId: input.connectionId,
      channelConversationId: input.remoteConversationId,
      channelMessageId: input.firstRemoteMessageId,
    },
  );

  await env.APP_KV.put(mapKey, thread.id, ttlOptions(input.mapTtlSeconds));

  return {
    threadId: thread.id,
    title: thread.title,
    created: true,
  };
}

function ttlOptions(
  ttlSeconds: number | undefined,
): KVNamespacePutOptions | undefined {
  return ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
}

type InitialUserMessageRpc = {
  startInitialUserMessage: (
    body: InitialUserMessageRequest,
  ) => Promise<InitialUserMessageResult>;
};

type ChannelInitialUserMessageRequest = InitialUserMessageRequest & {
  threadId: string;
  channelKind: ChannelKind;
};

export async function enqueueChannelMessage(
  env: Pick<Env, "CHAT_THREAD">,
  request: ChannelInitialUserMessageRequest,
): Promise<InitialUserMessageResult> {
  const { channelKind, ...messageRequest } = request;
  const stub = env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(request.threadId),
  ) as unknown as InitialUserMessageRpc;
  const systemMessage = buildChannelReplySystemMessage(channelKind, request);

  try {
    const result = await stub.startInitialUserMessage({
      ...messageRequest,
      messageSource: channelKind,
      message: `${systemMessage}\n\n${request.message}`,
    });
    if (
      result.status === "accepted" ||
      result.status === "busy" ||
      result.status === "error"
    ) {
      return result;
    }
    return { status: "error", error: "Invalid response from chat thread" };
  } catch (error) {
    return {
      status: "error",
      error:
        error instanceof Error ? error.message : "Chat thread rejected message",
    };
  }
}
