export type EventSeverity = "debug" | "info" | "warn" | "error";

export type RecordEventInput = {
  event: string;
  severity?: EventSeverity;
  component: string;
  operation?: string;
  status?: string;
  threadId?: string;
  workspaceId?: string;
  orgId?: string;
  userId?: string;
  durationMs?: number;
  count?: number;
  meta?: Record<string, unknown>;
};

export type StructuredEvent = RecordEventInput & {
  timestamp: string;
  severity: EventSeverity;
};

export type ObservabilityCounters = {
  turns_started: number;
  turns_completed: number;
  turns_denied_credits: number;
  http_requests: number;
};

const MAX_RECENT_EVENTS = 500;
const recentEvents: StructuredEvent[] = [];
const counters: ObservabilityCounters = {
  turns_started: 0,
  turns_completed: 0,
  turns_denied_credits: 0,
  http_requests: 0,
};

const sensitiveKey =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)/i;

export function recordEvent(input: RecordEventInput): StructuredEvent {
  requireNonEmpty(input.event, "recordEvent: event is required");
  requireNonEmpty(input.component, "recordEvent: component is required");

  const structured: StructuredEvent = {
    timestamp: new Date().toISOString(),
    ...input,
    severity: input.severity ?? "info",
    ...(input.meta ? { meta: sanitizeRecord(input.meta) } : {}),
  };

  if (isCounterName(structured.event)) {
    counters[structured.event] += structured.count ?? 1;
  }
  recentEvents.push(structured);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
  }

  process.stdout.write(`${JSON.stringify(structured)}\n`);
  return structuredClone(structured);
}

export function recordError(
  input: RecordEventInput & { error?: unknown },
): StructuredEvent {
  const { error, ...event } = input;
  const errorMeta =
    error === undefined
      ? {}
      : error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : { errorMessage: String(error) };
  return recordEvent({
    ...event,
    severity: "error",
    status: event.status ?? "error",
    meta: { ...event.meta, ...errorMeta },
  });
}

export function getObservabilitySnapshot(): {
  counters: ObservabilityCounters;
  recentEvents: StructuredEvent[];
} {
  return {
    counters: { ...counters },
    recentEvents: structuredClone(recentEvents),
  };
}

export function getCounters(): ObservabilityCounters {
  return { ...counters };
}

export function getRecentEvents(): StructuredEvent[] {
  return structuredClone(recentEvents);
}

/** Test-only reset for process-global metrics state. */
export function resetObservabilityForTests(): void {
  recentEvents.splice(0, recentEvents.length);
  for (const name of Object.keys(counters) as Array<
    keyof ObservabilityCounters
  >) {
    counters[name] = 0;
  }
}

function isCounterName(value: string): value is keyof ObservabilityCounters {
  return Object.hasOwn(counters, value);
}

function sanitizeRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKey.test(key) ? "[REDACTED]" : sanitizeValue(entry),
    ]),
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function requireNonEmpty(value: string, message: string): void {
  if (!value?.trim()) {
    throw new Error(message);
  }
}
