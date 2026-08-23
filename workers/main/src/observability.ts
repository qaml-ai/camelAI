import { bindingFacadeJson, jsonRequest } from "./binding-facades/transport";

export interface ObservabilityEnv {
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  OBSERVABILITY_SERVICE?: Fetcher;
}

export interface RequestObservabilityContext {
  requestId: string;
  colo: string;
  country: string;
}

export interface ObservabilityEvent {
  event: string;
  severity?: "debug" | "info" | "warn" | "error";
  component: string;
  operation?: string;
  status?: string;
  route?: string;
  method?: string;
  path?: string;
  threadId?: string | null;
  workspaceId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  provider?: string | null;
  model?: string | null;
  errorName?: string | null;
  errorMessage?: string | null;
  errorStack?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  count?: number | null;
  size?: number | null;
  timestamp?: number;
  sampleIndex?: string | null;
  /**
   * Extra numeric dimensions for the rare event that needs more than
   * `count`/`size`. Appended AFTER the fixed doubles, so `double1`-`double5`
   * keep meaning what every existing query assumes; these land on `double6`
   * onward and each emitting event documents its own order. Capped so one event
   * cannot push the row past the dataset's limits.
   */
  extraCounts?: (number | null | undefined)[];
}

const MAX_EXTRA_COUNTS = 5;

export function createRequestObservabilityContext(req: Request): RequestObservabilityContext {
  const cf = (req as Request & { cf?: { colo?: unknown; country?: unknown } }).cf;
  const ray = req.headers.get("cf-ray")?.trim();
  return {
    requestId: ray || crypto.randomUUID(),
    colo: typeof cf?.colo === "string" && cf.colo ? cf.colo : "unknown",
    country: typeof cf?.country === "string" && cf.country ? cf.country : "unknown",
  };
}

export function normalizePathForObservability(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":uuid")
    .replace(/\b[0-9a-f]{24,}\b/gi, ":hex")
    .replace(/\/\d{5,}(?=\/|$)/g, "/:number");
}

export function errorToObservabilityFields(error: unknown): {
  errorName: string;
  errorMessage: string;
  errorStack: string;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name || "Error",
      errorMessage: error.message || "Unknown error",
      errorStack: error.stack || "",
    };
  }
  if (typeof error === "string") {
    return { errorName: "Error", errorMessage: error, errorStack: "" };
  }
  try {
    return { errorName: "Error", errorMessage: JSON.stringify(error), errorStack: "" };
  } catch {
    return { errorName: "Error", errorMessage: "Unknown error", errorStack: "" };
  }
}

export function recordObservabilityEvent(
  env: ObservabilityEnv | undefined,
  event: ObservabilityEvent,
): void {
  const dataset = env?.OBSERVABILITY_EVENTS;
  if (!dataset) {
    sendFacadeEvent(env, "events", event);
    return;
  }

  const now = event.timestamp ?? Date.now();
  try {
    dataset.writeDataPoint({
      blobs: [
        safeBlob(event.event, 128),
        safeBlob(event.severity ?? "info", 32),
        safeBlob(event.component, 128),
        safeBlob(event.operation, 128),
        safeBlob(event.status, 128),
        safeBlob(event.route, 256),
        safeBlob(event.method, 16),
        safeBlob(event.path, 256),
        safeBlob(event.threadId, 128),
        safeBlob(event.workspaceId, 128),
        safeBlob(event.orgId, 128),
        safeBlob(event.userId, 128),
        safeBlob(event.requestId, 128),
        safeBlob(event.provider, 64),
        safeBlob(event.model, 128),
        safeBlob(event.errorName, 128),
        safeBlob(event.errorMessage, 2048),
        safeBlob(event.errorStack, 4096),
      ],
      doubles: [
        now,
        safeNumber(event.durationMs),
        safeNumber(event.statusCode),
        safeNumber(event.count),
        safeNumber(event.size),
        ...(event.extraCounts ?? [])
          .slice(0, MAX_EXTRA_COUNTS)
          .map((value) => safeNumber(value)),
      ],
      indexes: [safeIndex(event.sampleIndex ?? event.threadId ?? event.workspaceId ?? event.component)],
    });
  } catch (analyticsError) {
    console.warn("[observability] failed to write analytics event", analyticsError);
  }
}

export function recordErrorEvent(
  env: ObservabilityEnv | undefined,
  event: Omit<ObservabilityEvent, "severity" | "errorName" | "errorMessage"> & {
    error: unknown;
  },
): void {
  const details = errorToObservabilityFields(event.error);
  const observabilityEvent = {
    ...event,
    severity: "error",
    errorName: details.errorName,
    errorMessage: details.errorMessage,
    errorStack: details.errorStack,
  } satisfies ObservabilityEvent & { error: unknown };
  recordObservabilityEvent(env, observabilityEvent);

  try {
    if (!env?.ERROR_ANALYTICS) {
      sendFacadeEvent(env, "errors", observabilityEvent);
      return;
    }
    env.ERROR_ANALYTICS.writeDataPoint({
      blobs: [
        safeBlob(event.event, 128),
        safeBlob(event.component, 128),
        safeBlob(event.operation, 128),
        safeBlob(event.status, 128),
        safeBlob(details.errorName, 128),
        safeBlob(details.errorMessage, 2048),
        safeBlob(event.threadId, 128),
        safeBlob(event.workspaceId, 128),
        safeBlob(event.orgId, 128),
        safeBlob(event.userId, 128),
        safeBlob(event.requestId, 128),
        safeBlob(event.route, 256),
        safeBlob(event.path, 256),
        safeBlob(details.errorStack, 4096),
      ],
      doubles: [
        event.timestamp ?? Date.now(),
        safeNumber(event.durationMs),
        safeNumber(event.statusCode),
        safeNumber(event.count),
        safeNumber(event.size),
      ],
      indexes: [safeIndex(event.sampleIndex ?? event.threadId ?? event.component)],
    });
  } catch (analyticsError) {
    console.warn("[observability] failed to write error analytics event", analyticsError);
  }
}

function sendFacadeEvent(
  env: ObservabilityEnv | undefined,
  path: "events" | "errors",
  event: ObservabilityEvent,
): void {
  if (!env?.OBSERVABILITY_SERVICE) return;
  try {
    // This module is shared with the React Router test/runtime graph, where
    // `cloudflare:workers` is intentionally unavailable. Start the service
    // request eagerly and contain failures; native Analytics Engine remains
    // the durable production fast path until callers can supply a portable
    // request-lifetime scheduler here.
    void bindingFacadeJson(
      env.OBSERVABILITY_SERVICE,
      "observability",
      path,
      jsonRequest({ event: facadeObservabilityEvent(event) }, { method: "POST" }),
    ).catch((error) => {
      console.warn(`[observability] failed to write facade ${path}`, error);
    });
  } catch (error) {
    console.warn(`[observability] failed to schedule facade ${path}`, error);
  }
}

function facadeObservabilityEvent(event: ObservabilityEvent): ObservabilityEvent {
  return {
    event: safeBlob(event.event, 128),
    severity: event.severity ?? "info",
    component: safeBlob(event.component, 128),
    operation: safeBlob(event.operation, 128),
    status: safeBlob(event.status, 128),
    route: safeBlob(event.route, 256),
    method: safeBlob(event.method, 16),
    path: safeBlob(event.path, 256),
    threadId: safeBlob(event.threadId, 128),
    workspaceId: safeBlob(event.workspaceId, 128),
    orgId: safeBlob(event.orgId, 128),
    userId: safeBlob(event.userId, 128),
    requestId: safeBlob(event.requestId, 128),
    provider: safeBlob(event.provider, 64),
    model: safeBlob(event.model, 128),
    errorName: safeBlob(event.errorName, 128),
    errorMessage: safeBlob(event.errorMessage, 2048),
    errorStack: safeBlob(event.errorStack, 4096),
    durationMs: safeNumber(event.durationMs),
    statusCode: safeNumber(event.statusCode),
    count: safeNumber(event.count),
    size: safeNumber(event.size),
    timestamp: safeNumber(event.timestamp ?? Date.now()),
    sampleIndex: safeIndex(event.sampleIndex ?? event.threadId ?? event.workspaceId ?? event.component),
    extraCounts: (event.extraCounts ?? [])
      .slice(0, MAX_EXTRA_COUNTS)
      .map((value) => safeNumber(value)),
  };
}

function safeBlob(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return "";
  const stringValue = String(value);
  return stringValue.length > maxLength ? stringValue.slice(0, maxLength) : stringValue;
}

function safeIndex(value: unknown): string {
  const index = safeBlob(value, 96);
  return index || "unknown";
}

function safeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
