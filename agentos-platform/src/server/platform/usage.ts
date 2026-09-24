import type { Store } from "./store.ts";

export type UsageEvent = {
  id: string;
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId?: string;
  kind: "turn" | "tool" | "inference";
  model?: string;
  /** Cost in USD cents. */
  cents: number;
  creditChargeable: boolean;
  durationMs?: number;
  createdAt: string;
};

export type ListUsageOptions = {
  since?: string;
  limit?: number;
};

function usagePrefix(orgId: string): string {
  return `usage:${orgId}:`;
}

function usageKey(event: UsageEvent): string {
  return `${usagePrefix(event.orgId)}${event.id}`;
}

/** Persistent per-organization usage ledger backed by the platform Store. */
export class UsageService {
  constructor(private readonly store: Store) {}

  recordUsage(event: UsageEvent): UsageEvent {
    validateEvent(event);
    const snapshot = structuredClone(event);
    this.store.set(usageKey(snapshot), snapshot);
    return snapshot;
  }

  listUsage(orgId: string, options: ListUsageOptions = {}): UsageEvent[] {
    requireNonEmpty(orgId, "UsageService: orgId is required");
    const sinceMs =
      options.since === undefined
        ? undefined
        : requireTimestamp(options.since, "listUsage: since");
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("listUsage: limit must be a non-negative integer");
    }

    return this.store
      .listByPrefix<UsageEvent>(usagePrefix(orgId))
      .map(({ value }) => structuredClone(value))
      .filter(
        (event) =>
          sinceMs === undefined || Date.parse(event.createdAt) >= sinceMs,
      )
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          b.id.localeCompare(a.id),
      )
      .slice(0, limit);
  }

  sumChargeableCents(orgId: string): number {
    return this.listUsage(orgId, { limit: Number.MAX_SAFE_INTEGER })
      .filter((event) => event.creditChargeable)
      .reduce((total, event) => total + event.cents, 0);
  }
}

function validateEvent(event: UsageEvent): void {
  if (!event || typeof event !== "object") {
    throw new Error("recordUsage: event is required");
  }
  requireNonEmpty(event.id, "recordUsage: id is required");
  requireNonEmpty(event.orgId, "recordUsage: orgId is required");
  requireNonEmpty(event.workspaceId, "recordUsage: workspaceId is required");
  requireNonEmpty(event.threadId, "recordUsage: threadId is required");
  if (!["turn", "tool", "inference"].includes(event.kind)) {
    throw new Error("recordUsage: invalid usage kind");
  }
  if (
    !Number.isFinite(event.cents) ||
    !Number.isInteger(event.cents) ||
    event.cents < 0
  ) {
    throw new Error("recordUsage: cents must be a non-negative integer");
  }
  if (typeof event.creditChargeable !== "boolean") {
    throw new Error("recordUsage: creditChargeable must be a boolean");
  }
  if (
    event.durationMs !== undefined &&
    (!Number.isFinite(event.durationMs) || event.durationMs < 0)
  ) {
    throw new Error("recordUsage: durationMs must be non-negative");
  }
  requireTimestamp(event.createdAt, "recordUsage: createdAt");
}

function requireNonEmpty(value: string, message: string): void {
  if (!value?.trim()) {
    throw new Error(message);
  }
}

function requireTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!value?.trim() || !Number.isFinite(timestamp)) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return timestamp;
}
