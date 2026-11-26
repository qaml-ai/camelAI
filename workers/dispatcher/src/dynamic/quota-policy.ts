/**
 * Tiered quota policy, synchronous shard quota tracking, and Analytics Engine
 * telemetry emission for hosted Dynamic Workers.
 */

import type { AppQuotaTier } from '../../../main/src/dynamic-worker-registry';

export const UTC_DAY_MS = 86_400_000;

export interface ShardQuotaLimits {
  maxRowsWrittenPerDay: number;
  maxRowsReadPerDay: number;
  maxRowsWrittenPerEvent: number;
  maxRowsReadPerEvent: number;
  maxDbSizeBytes: number;
  maxSubrequestsPerRequest: number;
  maxDoHopsPerRequest: number;
  alarmMinIntervalMs: number;
  alarmDailyBudget: number;
}

export const QUOTA_LIMITS_BY_TIER: Record<Exclude<AppQuotaTier, 'exempt'>, ShardQuotaLimits> = {
  free: {
    maxRowsWrittenPerDay: 100_000,
    maxRowsReadPerDay: 25_000_000,
    maxRowsWrittenPerEvent: 10_000,
    maxRowsReadPerEvent: 500_000,
    maxDbSizeBytes: 400 * 1024 * 1024, // 400 MiB
    maxSubrequestsPerRequest: 200,
    maxDoHopsPerRequest: 64,
    alarmMinIntervalMs: 30_000,
    alarmDailyBudget: 3_000,
  },
  pro: {
    maxRowsWrittenPerDay: 1_000_000,
    maxRowsReadPerDay: 250_000_000,
    maxRowsWrittenPerEvent: 100_000,
    maxRowsReadPerEvent: 5_000_000,
    maxDbSizeBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
    maxSubrequestsPerRequest: 1_000,
    maxDoHopsPerRequest: 128,
    alarmMinIntervalMs: 10_000,
    alarmDailyBudget: 10_000,
  },
  // Enterprise tier (e.g. SECLOCK, BrandRank.ai, Rubicon9): 100x Free limits +
  // 8 GiB SQLite DB cap so high-volume enterprise analytics & DO workloads run
  // with full real-time visibility and zero disruption.
  enterprise: {
    maxRowsWrittenPerDay: 10_000_000,
    maxRowsReadPerDay: 2_500_000_000,
    maxRowsWrittenPerEvent: 1_000_000,
    maxRowsReadPerEvent: 50_000_000,
    maxDbSizeBytes: 8 * 1024 * 1024 * 1024, // 8 GiB
    maxSubrequestsPerRequest: 5_000,
    maxDoHopsPerRequest: 512,
    alarmMinIntervalMs: 5_000,
    alarmDailyBudget: 50_000,
  },
};

export function resolveQuotaTier(tier: string | undefined): AppQuotaTier {
  if (tier === 'pro' || tier === 'enterprise' || tier === 'exempt') return tier;
  return 'free';
}

export function quotaLimitsForTier(tier: AppQuotaTier): ShardQuotaLimits | null {
  if (tier === 'exempt') return null;
  return QUOTA_LIMITS_BY_TIER[tier];
}

export function currentUtcDayBucket(nowMs = Date.now()): number {
  return Math.floor(nowMs / UTC_DAY_MS);
}

export function nextUtcDayStartMs(nowMs = Date.now()): number {
  return (currentUtcDayBucket(nowMs) + 1) * UTC_DAY_MS;
}

export interface PersistedShardQuotaState {
  dayBucket: number;
  rowsRead: number;
  rowsWritten: number;
  alarmsFired: number;
  trips: number;
  lastTripReason?: string | null;
  lastUpdatedAt: number;
}

export function createEmptyShardQuotaState(nowMs = Date.now()): PersistedShardQuotaState {
  return {
    dayBucket: currentUtcDayBucket(nowMs),
    rowsRead: 0,
    rowsWritten: 0,
    alarmsFired: 0,
    trips: 0,
    lastTripReason: null,
    lastUpdatedAt: nowMs,
  };
}

export function rolloverShardQuotaState(
  state: PersistedShardQuotaState | null | undefined,
  nowMs = Date.now(),
): PersistedShardQuotaState {
  const today = currentUtcDayBucket(nowMs);
  if (!state || state.dayBucket !== today) {
    return createEmptyShardQuotaState(nowMs);
  }
  return state;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?:
    | 'daily_rows_written'
    | 'daily_rows_read'
    | 'event_rows_written'
    | 'event_rows_read'
    | 'db_size_bytes'
    | 'daily_alarms';
  limit?: number;
  observed?: number;
}

export function checkShardQuota(input: {
  tier: AppQuotaTier;
  daily: PersistedShardQuotaState;
  eventRowsRead?: number;
  eventRowsWritten?: number;
  dbSizeBytes?: number;
}): QuotaCheckResult {
  const limits = quotaLimitsForTier(input.tier);
  if (!limits) return { allowed: true };

  if (input.daily.rowsWritten >= limits.maxRowsWrittenPerDay) {
    return {
      allowed: false,
      reason: 'daily_rows_written',
      limit: limits.maxRowsWrittenPerDay,
      observed: input.daily.rowsWritten,
    };
  }
  if (input.daily.rowsRead >= limits.maxRowsReadPerDay) {
    return {
      allowed: false,
      reason: 'daily_rows_read',
      limit: limits.maxRowsReadPerDay,
      observed: input.daily.rowsRead,
    };
  }
  if ((input.eventRowsWritten ?? 0) > limits.maxRowsWrittenPerEvent) {
    return {
      allowed: false,
      reason: 'event_rows_written',
      limit: limits.maxRowsWrittenPerEvent,
      observed: input.eventRowsWritten,
    };
  }
  if ((input.eventRowsRead ?? 0) > limits.maxRowsReadPerEvent) {
    return {
      allowed: false,
      reason: 'event_rows_read',
      limit: limits.maxRowsReadPerEvent,
      observed: input.eventRowsRead,
    };
  }
  if ((input.dbSizeBytes ?? 0) > limits.maxDbSizeBytes) {
    return {
      allowed: false,
      reason: 'db_size_bytes',
      limit: limits.maxDbSizeBytes,
      observed: input.dbSizeBytes,
    };
  }
  return { allowed: true };
}

export type AppUsageEventKind =
  | 'http'
  | 'asset'
  | 'do_fetch'
  | 'do_rpc'
  | 'do_alarm'
  | 'do_ws'
  | 'quota_trip'
  | 'quota_abort'
  | 'outbound_blocked'
  | 'lazy_migration_hit';

export interface AppUsageMetricPoint {
  dispatchScriptName: string;
  orgId: string;
  className?: string;
  eventKind: AppUsageEventKind;
  quotaTier: AppQuotaTier;
  rowsRead?: number;
  rowsWritten?: number;
  durationMs?: number;
  dbSizeBytes?: number;
  subrequests?: number;
  quotaTripped?: boolean;
}

export function emitAppUsageMetric(
  dataset: AnalyticsEngineDataset | undefined,
  point: AppUsageMetricPoint,
): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint({
      indexes: [point.dispatchScriptName],
      blobs: [
        point.orgId,
        point.className ?? '',
        point.eventKind,
        point.quotaTier,
      ],
      doubles: [
        point.rowsRead ?? 0,
        point.rowsWritten ?? 0,
        point.durationMs ?? 0,
        point.dbSizeBytes ?? 0,
        point.subrequests ?? 0,
        point.quotaTripped ? 1 : 0,
      ],
    });
  } catch (error) {
    console.warn('[dynamic-usage] failed to emit analytics data point', {
      dispatchScriptName: point.dispatchScriptName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
