/**
 * TenantObjectSupervisorDO — 1:1 sharded SQLite Durable Object hosting a single
 * `"main"` Facet per `${dispatchScriptName}:${className}:${canonicalObjectId}`.
 *
 * Isolation properties:
 * - Each tenant DO instance gets its own 10 GB SQLite DB (inside the `"main"` Facet),
 *   its own 128 MB isolate memory budget, and independent hibernation.
 * - Supervisor metadata (daily quota state, alarm counters, migration state) lives in
 *   the parent supervisor DO's KV storage — completely unreachable by user SQLite code.
 * - Native `alarm()` on the supervisor wakes the `"main"` Facet (`workerd` #6810 workaround).
 * - WebSocket upgrades pass straight through `facet.fetch(request)` with zero proxying.
 */

import { DurableObject } from 'cloudflare:workers';
import type { OrgDO } from '../../../main/src/auth';
import {
  type AppQuotaTier,
  type DynamicWorkerBundleRecord,
} from '../../../main/src/dynamic-worker-registry';
import { getWorkerAccessInfo, type WorkerAccessInfo } from '../access-control';
import {
  loadDynamicBundleRecord,
  loadDynamicUserWorker,
  loadManagedEnvOverlay,
  type DynamicRuntimeExports,
} from './bundle-store';
import {
  checkShardQuota,
  emitAppUsageMetric,
  nextUtcDayStartMs,
  quotaLimitsForTier,
  resolveQuotaTier,
  rolloverShardQuotaState,
  type PersistedShardQuotaState,
} from './quota-policy';

const META_IDENTITY_KEY = '__chiridion_meta:identity';
const META_QUOTA_KEY = '__chiridion_meta:quota';
const META_MIGRATION_KEY = '__chiridion_meta:migration';

export interface SupervisorIdentity {
  supervisorKey: string;
  dispatchScriptName: string;
  className: string;
  objectId: string;
}

export interface SupervisorMigrationState {
  status: 'native' | 'migrated' | 'empty';
  legacyHexId?: string;
  migratedAt?: string;
  sourceDigest?: string;
}

export interface SupervisorEnv {
  APP_KV: KVNamespace;
  R2_BUCKET?: R2Bucket;
  ORG?: DurableObjectNamespace<OrgDO>;
  USER_APP_LOADER?: WorkerLoader;
  APP_USAGE_AE?: AnalyticsEngineDataset;
  DISPATCHER?: {
    get(name: string): { fetch(request: Request): Promise<Response> };
  };
}

interface MeteredFacetStub {
  fetch(request: Request): Promise<Response>;
  alarm?(alarmInfo?: unknown): Promise<void>;
  __chiridionCallMethod(method: string, args: unknown[]): Promise<unknown>;
  __chiridionFlushMetrics(): Promise<{
    rowsRead: number;
    rowsWritten: number;
    dbSizeBytes: number;
    trips: number;
    lastTripReason: string | null;
  }>;
}

export class TenantObjectSupervisorDO extends DurableObject<SupervisorEnv> {
  private identityCache: SupervisorIdentity | null = null;
  private quotaCache: PersistedShardQuotaState | null = null;
  private activeFacetBundleKey: string | null = null;

  private async ensureIdentity(incoming?: SupervisorIdentity): Promise<SupervisorIdentity | null> {
    if (incoming) {
      if (
        !this.identityCache ||
        this.identityCache.supervisorKey !== incoming.supervisorKey
      ) {
        this.identityCache = incoming;
        await this.ctx.storage.put(META_IDENTITY_KEY, incoming);
      }
      return incoming;
    }
    if (!this.identityCache) {
      const stored = await this.ctx.storage.get<SupervisorIdentity>(META_IDENTITY_KEY);
      if (stored) this.identityCache = stored;
    }
    return this.identityCache;
  }

  private async loadQuotaState(): Promise<PersistedShardQuotaState> {
    if (!this.quotaCache) {
      const stored = await this.ctx.storage.get<PersistedShardQuotaState>(META_QUOTA_KEY);
      this.quotaCache = rolloverShardQuotaState(stored);
    } else {
      this.quotaCache = rolloverShardQuotaState(this.quotaCache);
    }
    return this.quotaCache;
  }

  private async saveQuotaState(state: PersistedShardQuotaState): Promise<void> {
    state.lastUpdatedAt = Date.now();
    this.quotaCache = state;
    await this.ctx.storage.put(META_QUOTA_KEY, state);
  }

  private async resolveAppAndBundle(
    identity: SupervisorIdentity,
  ): Promise<{
    accessInfo: WorkerAccessInfo;
    bundle: DynamicWorkerBundleRecord;
    quotaTier: AppQuotaTier;
  } | null> {
    const accessInfo = await getWorkerAccessInfo(this.env.APP_KV, identity.dispatchScriptName);
    if (!accessInfo || !accessInfo.bundle_r2_key) return null;
    const bundle = await loadDynamicBundleRecord(this.env, accessInfo.bundle_r2_key);
    if (!bundle) return null;
    return {
      accessInfo,
      bundle,
      quotaTier: resolveQuotaTier(accessInfo.quota_tier),
    };
  }

  private async getMainFacet(
    identity: SupervisorIdentity,
    accessInfo: WorkerAccessInfo,
    bundle: DynamicWorkerBundleRecord,
    quotaTier: AppQuotaTier,
    quotaState: PersistedShardQuotaState,
  ): Promise<MeteredFacetStub> {
    if (!this.env.USER_APP_LOADER) {
      throw new Error('USER_APP_LOADER binding is not configured on dispatcher');
    }

    const { vars: managedOverlay, envHash } = await loadManagedEnvOverlay(
      this.env,
      bundle.orgId,
      bundle.scriptName,
      accessInfo.env_version ?? 0,
    );

    const nextFacetBundleKey = `${bundle.bundleSha}:${envHash}:${quotaTier}`;
    if (this.activeFacetBundleKey && this.activeFacetBundleKey !== nextFacetBundleKey) {
      // Gracefully abort the warm facet so the new bundle/env takes effect immediately
      // while preserving 100% of the facet's SQLite database.
      try {
        this.ctx.facets.abort('main', new Error('Bundle or env version updated'));
      } catch {
        // Facet may not have been started yet.
      }
    }
    this.activeFacetBundleKey = nextFacetBundleKey;

    const worker = loadDynamicUserWorker({
      loader: this.env.USER_APP_LOADER,
      record: bundle,
      exports: ((this.ctx as unknown as { exports?: DynamicRuntimeExports }).exports ?? {}) as DynamicRuntimeExports,
      managedOverlay,
      envHash,
      quotaTier,
      quotaLimits: quotaLimitsForTier(quotaTier),
      supervisorKey: identity.supervisorKey,
      dailyRowsRead: quotaState.rowsRead,
      dailyRowsWritten: quotaState.rowsWritten,
    });

    return this.ctx.facets.get('main', () => ({
      class: worker.getDurableObjectClass(identity.className),
    })) as unknown as MeteredFacetStub;
  }

  private async flushFacetMetrics(
    facet: MeteredFacetStub,
    identity: SupervisorIdentity,
    orgId: string,
    quotaTier: AppQuotaTier,
    eventKind: 'do_fetch' | 'do_rpc' | 'do_alarm' | 'do_ws',
    startedAt: number,
  ): Promise<void> {
    const durationMs = Date.now() - startedAt;
    try {
      const metrics = await facet.__chiridionFlushMetrics();
      const state = await this.loadQuotaState();
      state.rowsRead += metrics.rowsRead;
      state.rowsWritten += metrics.rowsWritten;
      if (metrics.trips > 0) {
        state.trips += metrics.trips;
        state.lastTripReason = metrics.lastTripReason;
      }
      if (metrics.rowsRead > 0 || metrics.rowsWritten > 0 || metrics.trips > 0) {
        await this.saveQuotaState(state);
      }
      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: identity.dispatchScriptName,
        orgId,
        className: identity.className,
        eventKind,
        quotaTier,
        rowsRead: metrics.rowsRead,
        rowsWritten: metrics.rowsWritten,
        durationMs,
        dbSizeBytes: metrics.dbSizeBytes,
        quotaTripped: metrics.trips > 0,
      });
    } catch {
      // Facet may have been aborted due to quota breach; metric already emitted by reportQuotaTrip.
    }
  }

  async fetch(request: Request): Promise<Response> {
    const startedAt = Date.now();
    const dispatchScriptName = request.headers.get('x-chiridion-app-id')?.trim();
    const className = request.headers.get('x-chiridion-do-class')?.trim();
    const objectId = request.headers.get('x-chiridion-do-id')?.trim();
    const supervisorKey =
      request.headers.get('x-chiridion-supervisor-key')?.trim() ||
      (dispatchScriptName && className && objectId
        ? `${dispatchScriptName}:${className}:${objectId}`
        : undefined);

    const identity = await this.ensureIdentity(
      dispatchScriptName && className && objectId && supervisorKey
        ? { supervisorKey, dispatchScriptName, className, objectId }
        : undefined,
    );
    if (!identity) {
      return new Response('Missing Durable Object supervisor identity', { status: 400 });
    }

    const resolved = await this.resolveAppAndBundle(identity);
    if (!resolved) {
      return new Response('Worker bundle not found', { status: 404 });
    }
    const { accessInfo, bundle, quotaTier } = resolved;

    const quotaState = await this.loadQuotaState();
    const preCheck = checkShardQuota({ tier: quotaTier, daily: quotaState });
    if (!preCheck.allowed) {
      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: identity.dispatchScriptName,
        orgId: accessInfo.org_id,
        className: identity.className,
        eventKind: 'quota_trip',
        quotaTier,
        quotaTripped: true,
      });
      return new Response(
        JSON.stringify({
          error: 'Durable Object quota exceeded',
          reason: preCheck.reason,
          limit: preCheck.limit,
          observed: preCheck.observed,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-CamelAI-Quota-Exceeded': preCheck.reason ?? 'quota_exceeded',
            'Retry-After': '60',
          },
        },
      );
    }

    const facet = await this.getMainFacet(identity, accessInfo, bundle, quotaTier, quotaState);
    const isWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';

    // Strip internal routing headers before handing request to user code.
    const cleanHeaders = new Headers(request.headers);
    cleanHeaders.delete('x-chiridion-app-id');
    cleanHeaders.delete('x-chiridion-do-class');
    cleanHeaders.delete('x-chiridion-do-id');
    cleanHeaders.delete('x-chiridion-supervisor-key');

    const forwardedInit: RequestInit = {
      method: request.method,
      headers: cleanHeaders,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      forwardedInit.body = request.body;
    }

    try {
      const response = await facet.fetch(new Request(request.url, forwardedInit));
      // Do NOT await flush if WebSocket upgrade (101) — use waitUntil so upgrade returns immediately.
      const flushPromise = this.flushFacetMetrics(
        facet,
        identity,
        accessInfo.org_id,
        quotaTier,
        isWebSocket ? 'do_ws' : 'do_fetch',
        startedAt,
      );
      if (isWebSocket) {
        this.ctx.waitUntil(flushPromise);
      } else {
        await flushPromise;
      }
      return response;
    } catch (error) {
      await this.flushFacetMetrics(
        facet,
        identity,
        accessInfo.org_id,
        quotaTier,
        isWebSocket ? 'do_ws' : 'do_fetch',
        startedAt,
      );
      if (error instanceof Error && error.message.includes('Quota exceeded')) {
        return new Response(
          JSON.stringify({ error: error.message }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'X-CamelAI-Quota-Exceeded': 'runtime_trip',
            },
          },
        );
      }
      throw error;
    }
  }

  async rpcCall(
    identityInput: SupervisorIdentity,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const startedAt = Date.now();
    const identity = await this.ensureIdentity(identityInput);
    if (!identity) throw new Error('Missing Durable Object supervisor identity');

    const resolved = await this.resolveAppAndBundle(identity);
    if (!resolved) throw new Error(`Worker bundle not found: ${identity.dispatchScriptName}`);
    const { accessInfo, bundle, quotaTier } = resolved;

    const quotaState = await this.loadQuotaState();
    const preCheck = checkShardQuota({ tier: quotaTier, daily: quotaState });
    if (!preCheck.allowed) {
      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: identity.dispatchScriptName,
        orgId: accessInfo.org_id,
        className: identity.className,
        eventKind: 'quota_trip',
        quotaTier,
        quotaTripped: true,
      });
      throw new Error(`Durable Object quota exceeded (${preCheck.reason})`);
    }

    const facet = await this.getMainFacet(identity, accessInfo, bundle, quotaTier, quotaState);
    try {
      const result = await facet.__chiridionCallMethod(method, args);
      await this.flushFacetMetrics(
        facet,
        identity,
        accessInfo.org_id,
        quotaTier,
        'do_rpc',
        startedAt,
      );
      return result;
    } catch (error) {
      await this.flushFacetMetrics(
        facet,
        identity,
        accessInfo.org_id,
        quotaTier,
        'do_rpc',
        startedAt,
      );
      throw error;
    }
  }

  async alarm(): Promise<void> {
    const startedAt = Date.now();
    const identity = await this.ensureIdentity();
    if (!identity) return;

    const resolved = await this.resolveAppAndBundle(identity);
    if (!resolved) return;
    const { accessInfo, bundle, quotaTier } = resolved;

    const quotaState = await this.loadQuotaState();
    const limits = quotaLimitsForTier(quotaTier);
    quotaState.alarmsFired += 1;
    await this.saveQuotaState(quotaState);

    const preCheck = checkShardQuota({ tier: quotaTier, daily: quotaState });
    if (!preCheck.allowed || (limits && quotaState.alarmsFired > limits.alarmDailyBudget)) {
      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: identity.dispatchScriptName,
        orgId: accessInfo.org_id,
        className: identity.className,
        eventKind: 'quota_trip',
        quotaTier,
        quotaTripped: true,
      });
      return;
    }

    const facet = await this.getMainFacet(identity, accessInfo, bundle, quotaTier, quotaState);
    try {
      if (typeof facet.alarm === 'function') {
        await facet.alarm();
      }
    } finally {
      await this.flushFacetMetrics(
        facet,
        identity,
        accessInfo.org_id,
        quotaTier,
        'do_alarm',
        startedAt,
      );
    }
  }

  /**
   * Called by `AlarmMediator` WorkerEntrypoint RPC to set a native alarm on
   * the supervisor DO while enforcing min-interval clamping and daily alarm budgets.
   */
  async setFacetAlarm(
    scheduledTimeMs: number,
    options?: DurableObjectSetAlarmOptions,
    quotaTierInput?: AppQuotaTier,
  ): Promise<void> {
    const now = Date.now();
    const quotaTier = resolveQuotaTier(quotaTierInput);
    const limits = quotaLimitsForTier(quotaTier);
    const quotaState = await this.loadQuotaState();

    let targetTime = Number.isFinite(scheduledTimeMs) ? scheduledTimeMs : now;
    if (limits) {
      if (quotaState.alarmsFired >= limits.alarmDailyBudget) {
        // Defer to next UTC day with deterministic small jitter.
        targetTime = Math.max(targetTime, nextUtcDayStartMs(now) + (Math.abs(now) % 60_000));
      } else if (limits.alarmMinIntervalMs > 0) {
        targetTime = Math.max(targetTime, now + limits.alarmMinIntervalMs);
      }
    }

    await this.ctx.storage.setAlarm(targetTime, options);
  }

  async getFacetAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null> {
    return this.ctx.storage.getAlarm(options);
  }

  async deleteFacetAlarm(options?: DurableObjectSetAlarmOptions): Promise<void> {
    await this.ctx.storage.deleteAlarm(options);
  }

  /**
   * Called by `QuotaReporter` when user SQLite code trips a synchronous quota
   * limit. If the user catches QuotaExceededError and keeps looping (`trips >= 2`),
   * immediately abort the `"main"` Facet (`<1 ms`, preserving SQLite state cleanly).
   */
  async reportQuotaTrip(
    reason: string,
    _limit: number,
    _observed: number,
    tripCountInEvent: number,
  ): Promise<void> {
    const state = await this.loadQuotaState();
    state.trips += 1;
    state.lastTripReason = reason;
    await this.saveQuotaState(state);

    const identity = await this.ensureIdentity();
    if (tripCountInEvent >= 2) {
      try {
        this.ctx.facets.abort('main', new Error(`Aborted due to repeated quota breach: ${reason}`));
      } catch {
        // Already aborted.
      }
      if (identity) {
        emitAppUsageMetric(this.env.APP_USAGE_AE, {
          dispatchScriptName: identity.dispatchScriptName,
          orgId: '',
          className: identity.className,
          eventKind: 'quota_abort',
          quotaTier: 'free',
          quotaTripped: true,
        });
      }
    }
  }

  async abortFacet(reason: string): Promise<void> {
    try {
      this.ctx.facets.abort('main', new Error(reason));
    } catch {
      // Facet not active.
    }
  }

  async getMigrationState(): Promise<SupervisorMigrationState | null> {
    return (await this.ctx.storage.get<SupervisorMigrationState>(META_MIGRATION_KEY)) ?? null;
  }

  async setMigrationState(state: SupervisorMigrationState): Promise<void> {
    await this.ctx.storage.put(META_MIGRATION_KEY, state);
  }

  /** Permanent data wipe for app deletion / GDPR purge. */
  async deleteFacetData(): Promise<void> {
    try {
      this.ctx.facets.delete('main');
    } catch {
      // Facet may not exist.
    }
    this.identityCache = null;
    this.quotaCache = null;
    this.activeFacetBundleKey = null;
    await this.ctx.storage.deleteAll();
  }
}
