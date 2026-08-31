// Provider-level transient-retry ladder for Pi model streams, extracted from
// chat-thread-do.ts. Wraps a stream factory and retries bounded transient
// provider errors as long as nothing has been forwarded downstream yet;
// terminal errors are synthesized into the outer stream. Holds no ChatThreadDO
// state — the only DO-owned concern (terminal-error logging with the current
// usage provider) comes in as a callback.
import {
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";

const PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS = 2;
const PI_PROVIDER_TRANSIENT_RETRY_DELAY_MS = 300;

// Pure Pi provider stream-error helpers (formerly ./chat-thread-pi-provider-errors).
// These read only their arguments plus the module-local transient-error
// pattern list; they hold no ChatThreadDO state.

const PI_PROVIDER_TRANSIENT_ERROR_PATTERNS = [
  "network connection lost",
  "connection lost",
  "transient issue on remote node",
];

export function piProviderStreamErrorMessage(event: AssistantMessageEvent): string {
  if (event.type !== "error") return "";
  const message = event.error.errorMessage;
  return typeof message === "string" ? message.trim() : "";
}

export function isTransientPiProviderError(message: string): boolean {
  const lower = message.toLowerCase();
  return PI_PROVIDER_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
    lower.includes(pattern),
  );
}

export function isBedrockRegionUnavailableError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("not_found_error") ||
    lower.includes("model not found") ||
    lower.includes("model") && lower.includes("does not exist") ||
    lower.includes("model") && lower.includes("not available in") ||
    lower.includes("model") && lower.includes("unsupported region")
  );
}

export function createPiProviderStreamErrorMessage(
  model: Model<any>,
  errorMessage: string,
  stopReason: "error" | "aborted",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

export type PiProviderStreamTerminalStatus =
  | "retry_exhausted"
  | "after_forwarded_event"
  | "non_transient"
  | "aborted";

type PiAssistantUsage = AssistantMessage["usage"];

function mergeAssistantUsage(
  accumulated: PiAssistantUsage | null,
  current: PiAssistantUsage,
): PiAssistantUsage {
  if (!accumulated) return current;
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens") =>
    Math.max(0, Number(accumulated[key]) || 0) +
    Math.max(0, Number(current[key]) || 0);
  const costKeys = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
  const cost = Object.fromEntries(costKeys.map((key) => [
    key,
    Math.max(0, Number(accumulated.cost?.[key]) || 0) +
      Math.max(0, Number(current.cost?.[key]) || 0),
  ])) as PiAssistantUsage["cost"];
  return {
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    totalTokens: sum("totalTokens"),
    cost,
  };
}

function usageWithNonzeroBilling(usage: PiAssistantUsage): PiAssistantUsage | null {
  return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 ||
    usage.cacheWrite > 0 || usage.cost.total > 0
    ? usage
    : null;
}

function mergeHiddenUsageIntoEvent(
  event: AssistantMessageEvent,
  hiddenUsage: PiAssistantUsage | null,
): AssistantMessageEvent {
  if (!hiddenUsage) return event;
  if (event.type === "done") {
    return {
      ...event,
      message: {
        ...event.message,
        usage: mergeAssistantUsage(hiddenUsage, event.message.usage),
      },
    };
  }
  if (event.type === "error") {
    return {
      ...event,
      error: {
        ...event.error,
        usage: mergeAssistantUsage(hiddenUsage, event.error.usage),
      },
    };
  }
  return event;
}

function usageFromEvent(event: AssistantMessageEvent): PiAssistantUsage | null {
  if (event.type === "done") return event.message.usage;
  if (event.type === "error") return event.error.usage;
  if ("partial" in event) return event.partial.usage;
  return null;
}

/**
 * Sleep that rejects with "Request was aborted" if the signal fires (or has
 * already fired). Shared by the provider ladder here and ChatThreadDO's
 * turn-level transient-retry backoff.
 */
export function abortableSleep(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Request was aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Request was aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function streamPiModelWithTransientRetry(
  model: Model<any>,
  options: Parameters<typeof import("@earendil-works/pi-ai/compat").streamSimple>[2],
  createStream: () => AssistantMessageEventStream,
  onTerminalError: (
    message: string,
    status: PiProviderStreamTerminalStatus,
    attempt: number,
    forwardedEvent: boolean,
  ) => void,
  retryOptions: {
    maxRetryAttempts?: number;
    isRetryableError?: (message: string) => boolean;
    onRetry?: (message: string, nextAttempt: number) => void;
  } = {},
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  let hiddenRetryUsage: PiAssistantUsage | null = null;
  const maxRetryAttempts = retryOptions.maxRetryAttempts ??
    PI_PROVIDER_TRANSIENT_RETRY_ATTEMPTS;
  const isRetryableError = (message: string) =>
    isTransientPiProviderError(message) ||
    retryOptions.isRetryableError?.(message) === true;

  void (async () => {
    let attempt = 0;
    while (true) {
      let forwardedEvent = false;
      let pendingStartEvent: AssistantMessageEvent | null = null;
      let retryErrorMessage = "";
      let latestAttemptUsage: PiAssistantUsage | null = null;
      try {
        const inner = createStream();
        for await (const event of inner) {
          latestAttemptUsage = usageFromEvent(event) ?? latestAttemptUsage;
          if (event.type === "start") {
            pendingStartEvent = event;
            continue;
          }
          const errorMessage = piProviderStreamErrorMessage(event);
          if (
            event.type === "error" &&
            errorMessage &&
            !forwardedEvent &&
            !options?.signal?.aborted &&
            attempt < maxRetryAttempts &&
            isRetryableError(errorMessage)
          ) {
            const retryUsage = usageWithNonzeroBilling(event.error.usage);
            if (retryUsage) {
              hiddenRetryUsage = mergeAssistantUsage(hiddenRetryUsage, retryUsage);
            }
            retryErrorMessage = errorMessage;
            break;
          }
          if (errorMessage) {
            onTerminalError(
              errorMessage,
              options?.signal?.aborted
                ? "aborted"
                : forwardedEvent
                  ? "after_forwarded_event"
                  : attempt >= maxRetryAttempts
                    ? "retry_exhausted"
                    : "non_transient",
              attempt + 1,
              forwardedEvent,
            );
          }
          if (pendingStartEvent) {
            outer.push(pendingStartEvent);
            pendingStartEvent = null;
            forwardedEvent = true;
          }
          const forwarded = mergeHiddenUsageIntoEvent(event, hiddenRetryUsage);
          if (forwarded.type === "done" || forwarded.type === "error") {
            hiddenRetryUsage = null;
          }
          outer.push(forwarded);
          forwardedEvent = true;
        }
      } catch (error) {
        const billableAttemptUsage = latestAttemptUsage
          ? usageWithNonzeroBilling(latestAttemptUsage)
          : null;
        if (billableAttemptUsage) {
          hiddenRetryUsage = mergeAssistantUsage(hiddenRetryUsage, billableAttemptUsage);
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (
          !forwardedEvent &&
          !options?.signal?.aborted &&
          attempt < maxRetryAttempts &&
          isRetryableError(errorMessage)
        ) {
          retryErrorMessage = errorMessage;
        } else {
          onTerminalError(
            errorMessage,
            options?.signal?.aborted
              ? "aborted"
              : forwardedEvent
                ? "after_forwarded_event"
                : attempt >= maxRetryAttempts
                  ? "retry_exhausted"
                  : "non_transient",
            attempt + 1,
            forwardedEvent,
          );
          const terminalEvent = mergeHiddenUsageIntoEvent({
            type: "error",
            reason: options?.signal?.aborted ? "aborted" : "error",
            error: createPiProviderStreamErrorMessage(
              model,
              errorMessage,
              options?.signal?.aborted ? "aborted" : "error",
            ),
          }, hiddenRetryUsage);
          hiddenRetryUsage = null;
          outer.push(terminalEvent);
          outer.end();
          return;
        }
      }

      if (!retryErrorMessage) {
        outer.end();
        return;
      }

      retryOptions.onRetry?.(retryErrorMessage, attempt + 1);
      attempt += 1;
      await abortableSleep(PI_PROVIDER_TRANSIENT_RETRY_DELAY_MS, options?.signal);
    }
  })().catch((error) => {
    const terminalEvent = mergeHiddenUsageIntoEvent({
      type: "error",
      reason: options?.signal?.aborted ? "aborted" : "error",
      error: createPiProviderStreamErrorMessage(
        model,
        error instanceof Error ? error.message : String(error),
        options?.signal?.aborted ? "aborted" : "error",
      ),
    }, hiddenRetryUsage);
    hiddenRetryUsage = null;
    outer.push(terminalEvent);
    outer.end();
  });

  return outer;
}
