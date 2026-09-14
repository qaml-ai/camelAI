import type { LlmModel, LlmProvider } from "@/types";
import { isLlmModelCoveredByByokProvider } from "./llm-provider-config";

export const CREDIT_SEND_BLOCKED_MESSAGE =
  "Message not sent — top up credits or add an API key to continue.";

export interface ChatApiErrorDetails {
  rawMessage: string;
  status: number | null;
  providerErrorType: string | null;
  providerMessage: string | null;
}

export interface ChatApiErrorContext {
  billingSource?: "byok" | "hosted" | null;
  llmProvider?: LlmProvider | null;
  threadModel?: LlmModel | null;
}

export type ChatApiErrorPresentation =
  | {
      kind: "billing_action";
      title: string;
      message: string;
      actionHref: string;
      actionLabel: string;
    }
  | {
      kind: "provider_auth_action";
      title: string;
      message: string;
      actionHref: string;
      actionLabel: string;
    }
  | {
      kind: "generic";
      title?: string;
      message: string;
      actionHref?: string;
      actionLabel?: string;
    };

const BEDROCK_DATA_RETENTION_DOCS_URL =
  "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valueToRawMessage(error: unknown): string {
  if (error instanceof Error) {
    return valueToRawMessage(error.message);
  }
  if (typeof error === "string") {
    return error.trim();
  }
  if (error && typeof error === "object") {
    return safeJsonStringify(error).trim();
  }
  if (error == null) {
    return "";
  }
  return String(error).trim();
}

function parseEmbeddedJson(rawMessage: string): unknown | null {
  if (!rawMessage) return null;

  try {
    return JSON.parse(rawMessage) as unknown;
  } catch {
    // Provider SDKs often prefix JSON with status text.
  }

  const jsonStart = rawMessage.indexOf("{");
  const jsonEnd = rawMessage.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd <= jsonStart) {
    return null;
  }

  try {
    return JSON.parse(rawMessage.slice(jsonStart, jsonEnd + 1)) as unknown;
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function extractStatus(rawMessage: string, parsed: unknown): number | null {
  const root = objectRecord(parsed);
  const nestedError = objectRecord(root?.error);
  const candidates = [
    root?.status,
    root?.statusCode,
    root?.httpStatus,
    root?.code,
    nestedError?.status,
    nestedError?.statusCode,
    nestedError?.httpStatus,
    nestedError?.code,
  ];
  for (const candidate of candidates) {
    const status = numericStatus(candidate);
    if (status) return status;
  }

  return /\b429\b/.test(rawMessage) ? 429 : null;
}

function extractProviderErrorType(parsed: unknown): string | null {
  const root = objectRecord(parsed);
  const nestedError = objectRecord(root?.error);
  const candidates = [
    nestedError?.type,
    nestedError?.error_type,
    nestedError?.code,
    root?.type,
    root?.error_type,
    root?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function removeErrorPrefix(message: string): string {
  return message.trim().replace(/^Error:\s*/i, "");
}

function extractProviderMessage(parsed: unknown): string | null {
  const root = objectRecord(parsed);
  if (!root) return null;

  const nestedError = objectRecord(root.error);
  const candidates = [
    nestedError?.message,
    nestedError?.error,
    root.error,
    root.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return removeErrorPrefix(candidate);
    }
  }
  return null;
}

export function parseChatApiError(error: unknown): ChatApiErrorDetails {
  const rawMessage = valueToRawMessage(error);
  const parsed =
    error && typeof error === "object" && !(error instanceof Error)
      ? error
      : parseEmbeddedJson(rawMessage);
  const status = extractStatus(rawMessage, parsed);
  const providerErrorType = extractProviderErrorType(parsed);
  const providerMessage =
    extractProviderMessage(parsed) ||
    (rawMessage ? removeErrorPrefix(rawMessage) : null);
  return {
    rawMessage,
    status,
    providerErrorType,
    providerMessage,
  };
}

function isHostedCreditExhaustedMessage(lowerMessage: string): boolean {
  return lowerMessage.includes("credits are used up");
}

function isBillingOrCreditError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("credit") ||
    lowerMessage.includes("billing") ||
    lowerMessage.includes("payment required") ||
    lowerMessage.includes("subscription") ||
    lowerMessage.includes("spend limit") ||
    lowerMessage.includes("spending limit") ||
    lowerMessage.includes("usage limit") ||
    lowerMessage.includes("hosted model")
  );
}

function isBedrockProviderDataShareRequired(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("data retention mode") &&
    lowerMessage.includes("default") &&
    lowerMessage.includes("not available")
  );
}

function isOpenAiSubscriptionReconnectRequired(lowerMessage: string): boolean {
  return (
    lowerMessage.includes("your openai connection has expired or was revoked") ||
    /openai token refresh returned 40[01]\b/.test(lowerMessage)
  );
}

export function isChatBillingOrCreditError(error: unknown): boolean {
  const details = parseChatApiError(error);
  const message = details.providerMessage || details.rawMessage;
  return isBillingOrCreditError(message.toLowerCase());
}

export function chatStartFailureStatus(
  status: "busy" | "error" | string,
  error: unknown,
): number {
  if (status === "busy") return 409;
  if (isChatBillingOrCreditError(error)) return 402;
  return 500;
}

export function chatBillingActionPayload(status: number):
  | {
      actionHref: string;
      actionLabel: string;
    }
  | undefined {
  return status === 402
    ? {
        actionHref: "/settings/organization/usage?action=topup",
        actionLabel: "Top up credits",
      }
    : undefined;
}

function isCurrentTurnByok(context: ChatApiErrorContext): boolean {
  if (context.billingSource === "hosted") return false;
  if (context.billingSource === "byok") return true;
  return isLlmModelCoveredByByokProvider(
    context.threadModel,
    context.llmProvider,
  );
}

export function getChatApiErrorPresentation(
  error: unknown,
  context: ChatApiErrorContext = {},
): ChatApiErrorPresentation {
  const details = parseChatApiError(error);
  const message = details.providerMessage || "An unknown error occurred";

  const lowerMessage = message.toLowerCase();
  if (isOpenAiSubscriptionReconnectRequired(lowerMessage)) {
    return {
      kind: "provider_auth_action",
      title: "Reconnect your OpenAI account",
      message:
        "OpenAI rejected the saved ChatGPT/Codex login. Reconnect it in AI Provider settings, or ask an organization admin to reconnect it.",
      actionHref:
        "/settings/organization/ai-provider#openai-subscription",
      actionLabel: "Reconnect OpenAI",
    };
  }

  if (
    context.llmProvider === "bedrock" &&
    isBedrockProviderDataShareRequired(lowerMessage)
  ) {
    return {
      kind: "generic",
      title: "Bedrock data retention must be enabled for Fable 5",
      message:
        "Claude Fable 5 on Bedrock requires provider data sharing. Ask an AWS admin to grant bedrock-mantle:PutAccountDataRetention, then set Bedrock Mantle data retention to provider_data_share. Account-level API: PUT https://bedrock-mantle.<region>.api.aws/v1/data_retention with {\"mode\":\"provider_data_share\"}. Project-level API: POST https://bedrock-mantle.<region>.api.aws/v1/organization/projects/{project_id} with {\"data_retention\":{\"mode\":\"provider_data_share\"}}. This is an AWS data-sharing setting, so camelAI cannot enable it automatically.",
      actionHref: BEDROCK_DATA_RETENTION_DOCS_URL,
      actionLabel: "Open AWS data retention docs",
    };
  }

  if (isBillingOrCreditError(lowerMessage)) {
    if (isCurrentTurnByok(context) && !isHostedCreditExhaustedMessage(lowerMessage)) {
      return {
        kind: "generic",
        title: "Provider billing needs attention",
        message,
      };
    }
    return {
      kind: "billing_action",
      title: isHostedCreditExhaustedMessage(lowerMessage)
        ? "You're out of hosted credits"
        : "Billing needs attention",
      message: isHostedCreditExhaustedMessage(lowerMessage)
        ? CREDIT_SEND_BLOCKED_MESSAGE
        : message,
      actionHref: "/settings/organization/usage?action=topup",
      actionLabel: "Top up credits",
    };
  }

  return {
    kind: "generic",
    message,
  };
}

