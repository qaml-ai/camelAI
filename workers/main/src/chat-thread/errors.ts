// Chat send failure / error payload helpers for ChatThreadDO, extracted as a
// collaborator: the send-failure HTTP status + billing classification, the
// structured chat-send error payload, the Pi provider-error event payload,
// and the deduplicated OrgDO thread-error metadata recorder. Only computation
// and the OrgDO metadata write live here — event delivery (pushChatEvent /
// broadcast) stays on the DO, which passes the built payloads along. All
// state lives on the owning DO (the billing-source/provider turn fields, the
// Pi session, and the recordedChatErrors dedupe map); the class itself is
// stateless and is cached for the owning DO's lifetime with closures over its
// live deps (ChatThreadDO keeps thin same-named private delegates as its internal
// API). Sibling-method calls route back through the deps callbacks — i.e.
// through the DO's delegates — so dynamic dispatch (and every
// `ChatThreadDO.prototype['method'].call(fake)` test seam that stubs a sibling
// on the fake) behaves exactly as it did when the bodies lived on the DO.
import type { Agent as PiCoreAgent } from "@earendil-works/pi-agent-core";
import {
  buildChatErrorEventPayload,
  createChatErrorFingerprint,
  normalizeChatErrorKind,
  normalizeChatErrorMessage,
  normalizeChatErrorSource,
  normalizeChatErrorStatus,
} from "../chat-error-metadata";
import { piProviderErrorMetadata } from "./pi-message-helpers";
import type { PiBillingSource } from "./pi-model-config";
import type { OrgDO } from "../auth";
import type { ChatContextState } from "./types";

const CHAT_ERROR_DEDUPE_WINDOW_MS = 10_000;

// The slice of the DO's env the error cluster touches: the OrgDO namespace
// thread-error metadata is recorded to.
export interface ChatThreadErrorsEnv {
  ORG: DurableObjectNamespace<OrgDO>;
}

export interface ChatThreadErrorsDeps {
  chatContext(): ChatContextState | null;
  env(): ChatThreadErrorsEnv;
  /** DurableObjectState#waitUntil for the fire-and-forget metadata write. */
  waitUntil(promise: Promise<unknown>): void;
  // Mutable DO turn-state fields, exposed as read operations (never the DO
  // itself); the recordedChatErrors dedupe map also gets a setter for its
  // defensive lazy init.
  piCurrentBillingSource(): PiBillingSource;
  piCurrentUsageProvider(): string | null;
  piSession(): PiCoreAgent | null;
  recordedChatErrors(): Map<string, number>;
  setRecordedChatErrors(value: Map<string, number>): void;
  // DO-side operations (shared helpers whose behavior is owned elsewhere).
  retryChatDurableObjectRpc<T>(
    operation: string,
    fn: () => Promise<T>,
    options?: { attempts?: number; initialDelayMs?: number },
  ): Promise<T>;
  // Sibling routing back through the owning DO's same-named delegates, so a
  // stubbed sibling on a fake (or a subclass override) is honored exactly as
  // it was when these methods lived on ChatThreadDO itself.
  chatSendFailureStatus(status: "busy" | "error" | string, error: unknown): number;
  isChatBillingOrCreditError(error: unknown): boolean;
}

export class ChatThreadErrors {
  constructor(private readonly deps: ChatThreadErrorsDeps) {}

  chatSendFailureStatus(
    status: "busy" | "error" | string,
    error: unknown,
  ): number {
    if (status === "busy") return 409;
    if (this.deps.isChatBillingOrCreditError(error)) return 402;
    const message = error instanceof Error ? error.message : String(error ?? "");
    return piProviderErrorMetadata(message).status ?? 500;
  }

  isChatBillingOrCreditError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    return (
      lower.includes("credit") ||
      lower.includes("billing") ||
      lower.includes("subscription") ||
      lower.includes("payment") ||
      lower.includes("pay as you go") ||
      lower.includes("api key") ||
      lower.includes("usage limit") ||
      lower.includes("hosted model")
    );
  }

  chatSendErrorPayload(
    error: unknown,
    options: {
      status?: "busy" | "error" | string;
      fallbackMessage: string;
    },
  ): Record<string, unknown> {
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "";
    const message = rawMessage.trim() || options.fallbackMessage;
    const metadata = piProviderErrorMetadata(message);
    const status = this.deps.chatSendFailureStatus(
      options.status ?? "error",
      message,
    );
    return {
      type: "error",
      error: message,
      status,
      ...(this.deps.isChatBillingOrCreditError(message)
        ? { errorType: "billing" }
        : {}),
      ...(this.deps.piCurrentBillingSource() === "byok" || this.deps.piCurrentBillingSource() === "hosted"
        ? { billingSource: this.deps.piCurrentBillingSource() }
        : {}),
      ...(this.deps.piCurrentUsageProvider() ? { provider: this.deps.piCurrentUsageProvider() } : {}),
      ...metadata,
    };
  }

  recordCurrentThreadError(input: {
    message: string;
    source?: unknown;
    errorKind?: unknown;
    status?: unknown;
    provider?: unknown;
    model?: unknown;
    createdAt?: number;
  }): void {
    const context = this.deps.chatContext();
    const message = input.message.trim();
    if (!context || !message) return;

    const explicitSource =
      typeof input.source === "string" && input.source.trim()
        ? input.source.trim()
        : "";
    const sourceCandidate =
      explicitSource === "chat_thread_do_pi"
        ? "pi_provider"
        : explicitSource || (input.provider ? "pi_provider" : undefined);
    const status = normalizeChatErrorStatus(input.status);
    const source = normalizeChatErrorSource(sourceCandidate);
    const messageNormalized = normalizeChatErrorMessage(message) || "Unknown chat error";
    const errorKind = normalizeChatErrorKind(input.errorKind, messageNormalized, status);
    const provider =
      typeof input.provider === "string" && input.provider.trim()
        ? input.provider.trim()
        : this.deps.piCurrentUsageProvider();
    const model =
      typeof input.model === "string" && input.model.trim()
        ? input.model.trim()
        : this.deps.piSession()?.state.model?.id ?? null;
    const previewEvent = buildChatErrorEventPayload({
      threadId: context.threadId,
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      userId: context.userId,
      message,
      source,
      errorKind,
      status,
      provider,
      model,
      createdAt: input.createdAt,
    });
    const fingerprint = createChatErrorFingerprint({
      source,
      messageNormalized,
      errorKind,
      status,
      provider,
      model,
    });
    const key = `${context.threadId}:${fingerprint}`;
    const now = Date.now();
    if (!this.deps.recordedChatErrors()) {
      this.deps.setRecordedChatErrors(new Map());
    }
    const recordedChatErrors = this.deps.recordedChatErrors();
    for (const [existingKey, recordedAt] of recordedChatErrors.entries()) {
      if (now - recordedAt > CHAT_ERROR_DEDUPE_WINDOW_MS) {
        recordedChatErrors.delete(existingKey);
      }
    }
    const previous = recordedChatErrors.get(key);
    if (previous && now - previous <= CHAT_ERROR_DEDUPE_WINDOW_MS) return;
    recordedChatErrors.set(key, now);

    this.deps.waitUntil(
      this.deps.retryChatDurableObjectRpc(
        "OrgDO.recordThreadError",
        () => {
          const orgStub = this.deps.env().ORG.get(this.deps.env().ORG.idFromName(context.orgId));
          return orgStub.recordThreadError(context.threadId, {
            message,
            source: previewEvent.source,
            errorKind,
            status,
            provider,
            model,
            userId: context.userId,
            createdAt: previewEvent.created_at,
          });
        },
        { attempts: 3, initialDelayMs: 150 },
      ).catch((error) => {
        console.error("[ChatThreadDO] failed to record chat error metadata", error);
      }),
    );
  }

  piProviderErrorEvent(message: string): Record<string, unknown> {
    const metadata = piProviderErrorMetadata(message);
    return {
      type: "error",
      error: message,
      source: "chat_thread_do_pi",
      billingSource: this.deps.piCurrentBillingSource(),
      provider: this.deps.piCurrentUsageProvider(),
      ...metadata,
    };
  }
}
