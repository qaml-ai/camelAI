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
import type { DynamicServiceBroker } from '../../../main/src/dynamic-service-broker';
import {
  dynamicDoAliasKey,
  type AppQuotaTier,
  type DynamicWorkerBundleRecord,
} from '../../../main/src/dynamic-worker-registry';
import { getWorkerAccessInfo, type WorkerAccessInfo } from '../access-control';
import {
  isDynamicLogsTailEnabled,
  loadDynamicBundleRecord,
  loadDynamicUserWorker,
  loadManagedEnvOverlay,
  loadMigratedSecretsOverlay,
  type DynamicRuntimeExports,
} from './bundle-store';
import { MIGRATION_IMPORTER_FACET_SOURCE } from './importer-facet';
import {
  MIGRATION_SIG_HEADER,
  MIGRATION_TS_HEADER,
  signMigrationRequest,
  type FreezeResponsePayload,
  type KvPagePayload,
  type SqlPagePayload,
  type VerifyResponsePayload,
} from './migration-protocol';
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
  bundleR2Key?: string;
  quotaTier?: AppQuotaTier;
  envVersion?: number;
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
  MAIN_APP_BROKER?: Service<DynamicServiceBroker>;
  MIGRATION_HMAC_SECRET?: string;
  TOKEN_SIGNING_SECRET?: string;
  DISPATCHER?: {
    get(name: string): { fetch(request: Request): Promise<Response> };
  };
}

interface MeteredFacetStub {
  fetch(request: Request): Promise<Response>;
  __chiridionRunAlarm(alarmInfo?: unknown): Promise<void>;
  __chiridionCallMethod(method: string, args: unknown[]): Promise<unknown>;
  __chiridionFlushMetrics(): Promise<{
    rowsRead: number;
    rowsWritten: number;
    dbSizeBytes: number;
    trips: number;
    lastTripReason: string | null;
  }>;
}

function isVirtualTableSql(sqlText: string | undefined): boolean {
  return /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(String(sqlText || '').trim());
}

function isExternalContentFtsSql(sqlText: string | undefined): boolean {
  const m = /\bcontent\s*=\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+))/i.exec(String(sqlText || ''));
  if (!m) return false;
  const target = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return target.length > 0;
}

function getFtsShadowAndExternalTables(
  schema: Array<{ type: string; name: string; sql: string }>,
): { shadowLower: Set<string>; externalFtsLower: Set<string> } {
  const shadowLower = new Set<string>();
  const externalFtsLower = new Set<string>();
  for (const item of schema) {
    if (item.type === 'table' && isVirtualTableSql(item.sql)) {
      const base = item.name.toLowerCase();
      for (const suffix of ['_data', '_idx', '_content', '_docsize', '_config']) {
        shadowLower.add(base + suffix);
      }
      if (isExternalContentFtsSql(item.sql)) {
        externalFtsLower.add(base);
      }
    }
  }
  return { shadowLower, externalFtsLower };
}

function sortTablesByForeignKeys<T extends { name: string }>(
  tables: T[],
  schema: Array<{ type: string; name: string; sql: string }>,
): T[] {
  const byLower = new Map<string, T>();
  for (const t of tables) byLower.set(t.name.toLowerCase(), t);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t.name.toLowerCase(), new Set());

  for (const entry of schema) {
    if (entry.type !== 'table' || !entry.sql) continue;
    const child = entry.name.toLowerCase();
    if (!deps.has(child)) continue;
    for (const match of entry.sql.matchAll(/\bREFERENCES\s+(?:["`[])?([A-Za-z0-9_]+)(?:["`\]])?/gi)) {
      const parent = match[1]!.toLowerCase();
      if (parent !== child && byLower.has(parent)) {
        deps.get(child)!.add(parent);
      }
    }
  }

  const ordered: T[] = [];
  const placed = new Set<string>();
  const remaining = new Set(tables.map((t) => t.name.toLowerCase()));
  while (remaining.size > 0) {
    let progressed = false;
    for (const key of remaining) {
      const reqs = deps.get(key)!;
      if ([...reqs].every((p) => placed.has(p))) {
        ordered.push(byLower.get(key)!);
        placed.add(key);
        remaining.delete(key);
        progressed = true;
      }
    }
    if (!progressed) {
      // Break any circular FK cleanly by taking the first remaining table.
      const nextKey = remaining.values().next().value!;
      ordered.push(byLower.get(nextKey)!);
      placed.add(nextKey);
      remaining.delete(nextKey);
    }
  }
  return ordered;
}

export class TenantObjectSupervisorDO extends DurableObject<SupervisorEnv> {
  private identityCache: SupervisorIdentity | null = null;
  private quotaCache: PersistedShardQuotaState | null = null;
  private lastQuotaPersistAt = 0;
  private unsavedQuotaRowsRead = 0;
  private unsavedQuotaRowsWritten = 0;
  private activeFacetBundleKey: string | null = null;
  private migrationInFlight: Promise<{
    status: 'migrated' | 'empty' | 'already_migrated';
    hexId?: string;
    tableCounts?: Record<string, number>;
    kvCount?: number;
    overallDigest?: string;
  }> | null = null;

  private async ensureIdentity(incoming?: SupervisorIdentity): Promise<SupervisorIdentity | null> {
    if (incoming) {
      if (
        !this.identityCache ||
        this.identityCache.supervisorKey !== incoming.supervisorKey ||
        (incoming.bundleR2Key && this.identityCache.bundleR2Key !== incoming.bundleR2Key) ||
        (incoming.quotaTier && this.identityCache.quotaTier !== incoming.quotaTier)
      ) {
        this.identityCache = this.identityCache
          ? { ...this.identityCache, ...incoming }
          : { ...incoming };
        await this.ctx.storage.put(META_IDENTITY_KEY, this.identityCache);
      }
      return this.identityCache;
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
    const now = Date.now();
    state.lastUpdatedAt = now;
    this.quotaCache = state;
    this.lastQuotaPersistAt = now;
    this.unsavedQuotaRowsRead = 0;
    this.unsavedQuotaRowsWritten = 0;
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
    const effectiveBundleKey = identity.bundleR2Key || accessInfo?.bundle_r2_key;
    if (!effectiveBundleKey) return null;
    const bundle = await loadDynamicBundleRecord(this.env, effectiveBundleKey);
    if (!bundle) return null;
    const effectiveAccess: WorkerAccessInfo = accessInfo
      ? {
          ...accessInfo,
          bundle_r2_key: effectiveBundleKey,
          ...(identity.quotaTier ? { quota_tier: identity.quotaTier } : {}),
          ...(identity.envVersion !== undefined ? { env_version: identity.envVersion } : {}),
        }
      : {
          is_public: false,
          org_id: bundle.orgId,
          org_slug: bundle.orgSlug,
          runtime_mode: 'dynamic',
          bundle_r2_key: effectiveBundleKey,
          bundle_sha: bundle.bundleSha,
          quota_tier: identity.quotaTier ?? 'free',
          env_version: identity.envVersion ?? 0,
        };
    return {
      accessInfo: effectiveAccess,
      bundle,
      quotaTier: resolveQuotaTier(effectiveAccess.quota_tier),
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

    const [{ vars: managedOverlay, envHash }, migratedSecrets, enableLogsTail] = await Promise.all([
      loadManagedEnvOverlay(
        this.env,
        bundle.orgId,
        bundle.scriptName,
        accessInfo.env_version ?? 0,
      ),
      loadMigratedSecretsOverlay(this.env, bundle),
      isDynamicLogsTailEnabled(this.env, bundle),
    ]);

    const combinedOverlay =
      migratedSecrets.length > 0 ? [...migratedSecrets, ...managedOverlay] : managedOverlay;
    const effectiveEnvHash =
      migratedSecrets.length > 0 ? `${envHash}:ms${migratedSecrets.length}` : envHash;

    const nextFacetBundleKey = `${bundle.bundleSha}:${effectiveEnvHash}:${quotaTier}`;
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
      managedOverlay: combinedOverlay,
      envHash: effectiveEnvHash,
      quotaTier,
      quotaLimits: quotaLimitsForTier(quotaTier),
      supervisorKey: identity.supervisorKey,
      dailyRowsRead: quotaState.rowsRead,
      dailyRowsWritten: quotaState.rowsWritten,
      preferBroker: Boolean(this.env.MAIN_APP_BROKER),
      enableLogsTail,
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
        this.unsavedQuotaRowsRead += metrics.rowsRead;
        this.unsavedQuotaRowsWritten += metrics.rowsWritten;
        const shouldPersist =
          metrics.trips > 0 ||
          Date.now() - this.lastQuotaPersistAt >= 30_000 ||
          this.unsavedQuotaRowsRead >= 5_000 ||
          this.unsavedQuotaRowsWritten >= 500;
        if (shouldPersist) {
          await this.saveQuotaState(state);
        }
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
    const bundleR2Key = request.headers.get('x-chiridion-bundle-key')?.trim() || undefined;
    const quotaTierHeader = request.headers.get('x-chiridion-quota-tier')?.trim() as AppQuotaTier | undefined;
    const supervisorKey =
      request.headers.get('x-chiridion-supervisor-key')?.trim() ||
      (dispatchScriptName && className && objectId
        ? `${dispatchScriptName}:${className}:${objectId}`
        : undefined);

    const identity = await this.ensureIdentity(
      dispatchScriptName && className && objectId && supervisorKey
        ? {
            supervisorKey,
            dispatchScriptName,
            className,
            objectId,
            ...(bundleR2Key ? { bundleR2Key } : {}),
            ...(quotaTierHeader ? { quotaTier: quotaTierHeader } : {}),
          }
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

    if (accessInfo.runtime_mode === 'dynamic_migrating') {
      await this.ensureLazyMigrated(identity, accessInfo.org_id, quotaTier);
    }

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
    cleanHeaders.delete('x-chiridion-bundle-key');
    cleanHeaders.delete('x-chiridion-quota-tier');

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
      console.error('[supervisor] fetch failed', {
        supervisorKey: identity.supervisorKey,
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      });
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

    if (accessInfo.runtime_mode === 'dynamic_migrating') {
      await this.ensureLazyMigrated(identity, accessInfo.org_id, quotaTier);
    }

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
      console.error('[supervisor] rpcCall failed', {
        supervisorKey: identity.supervisorKey,
        method,
        error: error instanceof Error ? error.message : String(error),
      });
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
      await facet.__chiridionRunAlarm();
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

  private migrationHmacSecret(): string {
    const secret =
      this.env.MIGRATION_HMAC_SECRET?.trim() || this.env.TOKEN_SIGNING_SECRET?.trim();
    if (!secret) throw new Error('Missing MIGRATION_HMAC_SECRET for WfP shard migration');
    return secret;
  }

  private async fetchWfpShim<T>(
    dispatchScriptName: string,
    className: string,
    objectId: string,
    path: string,
    query: Record<string, string> = {},
    method: 'GET' | 'POST' = 'GET',
  ): Promise<T> {
    if (!this.env.DISPATCHER) {
      throw new Error('DISPATCHER binding is required to pull state from WfP export shim');
    }
    const secret = this.migrationHmacSecret();
    const ts = Date.now();
    const sig = await signMigrationRequest(secret, path, ts);
    const url = new URL(`https://migrate.internal${path}`);
    url.searchParams.set('className', className);
    url.searchParams.set('objectId', objectId);
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
    const wfpWorker = this.env.DISPATCHER.get(dispatchScriptName);
    const resp = await wfpWorker.fetch(
      new Request(url.toString(), {
        method,
        headers: {
          [MIGRATION_TS_HEADER]: String(ts),
          [MIGRATION_SIG_HEADER]: sig,
        },
      }),
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(
        `WfP export shim ${path} failed (HTTP ${resp.status}, script=${dispatchScriptName}): ${body.slice(0, 256)}`,
      );
    }
    return (await resp.json()) as T;
  }

  /**
   * Streams SQLite schema, rows, `sqlite_sequence`, indexes/triggers/views, DO KV,
   * and pending alarm from the app's WfP Export Shim into this supervisor's `"main"`
   * Facet and verifies 100% SHA-256 parity before marking the shard migrated.
   */
  async migrateFromWfpShim(
    identityInput: SupervisorIdentity,
    options?: { force?: boolean; orgId?: string; quotaTier?: AppQuotaTier },
  ): Promise<{
    status: 'migrated' | 'empty' | 'already_migrated';
    hexId?: string;
    tableCounts?: Record<string, number>;
    kvCount?: number;
    overallDigest?: string;
  }> {
    if (this.migrationInFlight) {
      return this.migrationInFlight;
    }
    const run = this.runMigrationFromWfpShim(identityInput, options);
    this.migrationInFlight = run;
    try {
      return await run;
    } finally {
      if (this.migrationInFlight === run) {
        this.migrationInFlight = null;
      }
    }
  }

  private async runMigrationFromWfpShim(
    identityInput: SupervisorIdentity,
    options?: { force?: boolean; orgId?: string; quotaTier?: AppQuotaTier },
  ): Promise<{
    status: 'migrated' | 'empty' | 'already_migrated';
    hexId?: string;
    tableCounts?: Record<string, number>;
    kvCount?: number;
    overallDigest?: string;
  }> {
    const identity = await this.ensureIdentity(identityInput);
    if (!identity) throw new Error('Missing supervisor identity for migration');

    const existing = await this.getMigrationState();
    if (!options?.force && existing && (existing.status === 'migrated' || existing.status === 'empty')) {
      return { status: 'already_migrated', hexId: existing.legacyHexId, overallDigest: existing.sourceDigest };
    }

    if (!this.env.USER_APP_LOADER) {
      throw new Error('USER_APP_LOADER binding is required for migration import');
    }

    let freeze: FreezeResponsePayload | null = null;
    let lastFreezeErr: unknown = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1_500));
      }
      try {
        const candidate = await this.fetchWfpShim<FreezeResponsePayload>(
          identity.dispatchScriptName,
          identity.className,
          identity.objectId,
          '/__migrate/freeze',
          {},
          'POST',
        );
        if (candidate && Array.isArray(candidate.tables) && Array.isArray(candidate.schema)) {
          freeze = candidate;
          break;
        }
        lastFreezeErr = new Error(
          `WfP DO isolate for ${identity.dispatchScriptName}:${identity.className} returned non-shim response (likely active WebSocket/alarm still running pre-shim code)`,
        );
      } catch (err) {
        lastFreezeErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isPreRecycle =
          msg.includes('Handler does not export a fetch') ||
          msg.includes('HTTP 405') ||
          msg.includes('HTTP 404') ||
          msg.includes('non-shim response') ||
          msg.includes('Unexpected token') ||
          msg.includes('not valid JSON');
        if (!isPreRecycle) throw err;
      }
    }
    if (!freeze) {
      throw lastFreezeErr instanceof Error
        ? lastFreezeErr
        : new Error(String(lastFreezeErr ?? 'WfP export shim freeze failed'));
    }

    const hasSqlData = freeze.tables.some((t) => t.rowCount > 0) || freeze.schema.length > 0;
    const hasAnyState = hasSqlData || freeze.kvCount > 0 || freeze.alarmMs !== null;

    // Record hex -> name anti-split-brain alias whenever migrating a named DO.
    if (freeze.hexId && identity.objectId !== freeze.hexId) {
      await this.env.APP_KV.put(
        dynamicDoAliasKey(identity.dispatchScriptName, identity.className, freeze.hexId),
        identity.objectId,
      );
    }

    if (!hasAnyState) {
      await this.setMigrationState({
        status: 'empty',
        legacyHexId: freeze.hexId,
        migratedAt: new Date().toISOString(),
      });
      return { status: 'empty', hexId: freeze.hexId, tableCounts: {}, kvCount: 0 };
    }

    // Abort any running facet cleanly before mounting the one-shot importer facet on `"main"`.
    try {
      this.ctx.facets.abort('main', new Error('Mounting privileged migration importer facet'));
    } catch {}
    this.activeFacetBundleKey = null;

    const importerWorker = this.env.USER_APP_LOADER.get('__chiridion_migration_importer_v5', () => ({
      compatibilityDate: '2026-07-13',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: '__chiridion_importer.js',
      modules: {
        '__chiridion_importer.js': MIGRATION_IMPORTER_FACET_SOURCE,
      },
      globalOutbound: null,
    }));

    const importerFacet = this.ctx.facets.get('main', () => ({
      class: importerWorker.getDurableObjectClass('ChiridionMigrationImporterDO'),
    })) as unknown as { fetch(req: Request): Promise<Response> };

    try {
      // Filter out SQLite FTS5 shadow tables (*_data, *_idx, *_content, *_docsize, *_config)
      // and external-content FTS5 virtual tables on the supervisor side as well, so Cohort C
      // apps still running an older WfP export shim migrate cleanly without attempting direct
      // INSERTs into FTS5 shadow tables (SQLITE_ERROR: table *_fts_config may not be modified).
      const { shadowLower, externalFtsLower } = getFtsShadowAndExternalTables(freeze.schema);
      const cleanSchema = freeze.schema.filter(
        (item) => !(item.type === 'table' && shadowLower.has(item.name.toLowerCase())),
      );
      const cleanTables = freeze.tables.filter((t) => {
        const lower = t.name.toLowerCase();
        return !shadowLower.has(lower) && !externalFtsLower.has(lower);
      });

      // 1. Replay CREATE TABLE DDL
      const schemaResp = await importerFacet.fetch(
        new Request('https://import.internal/__import/schema', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schema: cleanSchema }),
        }),
      );
      if (!schemaResp.ok) {
        throw new Error(`Importer schema replay failed: ${await schemaResp.text()}`);
      }

      // 2. Stream every table in 500-row pages (parent tables before FK-referencing child tables)
      // Start cursor at Number.MIN_SAFE_INTEGER so tables with negative INTEGER PRIMARY KEY
      // aliases for rowid (e.g. Telegram supergroup chat IDs like -1001234567890) are exported.
      const orderedTables = sortTablesByForeignKeys(cleanTables, cleanSchema);
      for (const table of orderedTables) {
        if (table.rowCount === 0) continue;
        let cursor = Number.MIN_SAFE_INTEGER;
        while (true) {
          const page = await this.fetchWfpShim<SqlPagePayload>(
            identity.dispatchScriptName,
            identity.className,
            identity.objectId,
            '/__migrate/export-sql',
            { table: table.name, afterRowid: String(cursor), limit: '500' },
          );
          if (page.rows.length > 0) {
            const importResp = await importerFacet.fetch(
              new Request('https://import.internal/__import/rows', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  table: page.table,
                  columns: page.columns,
                  hasRowid: page.hasRowid,
                  rows: page.rows,
                }),
              }),
            );
            if (!importResp.ok) {
              throw new Error(`Importer rows failed for ${table.name}: ${await importResp.text()}`);
            }
          }
          if (page.done || page.nextCursor === null) break;
          cursor = page.nextCursor;
        }
      }

      // 3. Stream DO KV entries
      const allKvEntries: Array<{ key: string; value: unknown }> = [];
      let afterKey: string | undefined;
      while (true) {
        const kvPage = await this.fetchWfpShim<KvPagePayload>(
          identity.dispatchScriptName,
          identity.className,
          identity.objectId,
          '/__migrate/export-kv',
          { ...(afterKey ? { afterKey } : {}), limit: '256' },
        );
        allKvEntries.push(...kvPage.entries);
        if (kvPage.done || !kvPage.nextAfterKey) break;
        afterKey = kvPage.nextAfterKey;
      }

      // 4. Finalize indexes/triggers/views/sqlite_sequence/KV + compute target parity digest
      const finalizeResp = await importerFacet.fetch(
        new Request('https://import.internal/__import/finalize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schema: cleanSchema,
            sqliteSequence: freeze.sqliteSequence,
            tables: cleanTables,
            kvEntries: allKvEntries,
          }),
        }),
      );
      const finalized = (await finalizeResp.json()) as {
        ok: boolean;
        integrityOk: boolean;
        kvCount: number;
        tableCounts: Record<string, number>;
        tableDigests: Record<string, string>;
        overallDigest: string;
      };
      if (!finalizeResp.ok || !finalized.integrityOk) {
        throw new Error(`Importer finalize/integrity_check failed: ${JSON.stringify(finalized)}`);
      }

      // 5. Verify 100% SHA-256 parity against the frozen WfP shard!
      const verify = await this.fetchWfpShim<VerifyResponsePayload>(
        identity.dispatchScriptName,
        identity.className,
        identity.objectId,
        '/__migrate/verify',
      );
      const usedFtsFilter = cleanTables.length !== freeze.tables.length;
      const filteredParityOk =
        finalized.kvCount === verify.kvCount &&
        cleanTables.every(
          (t) =>
            finalized.tableCounts[t.name] === verify.tableCounts[t.name] &&
            finalized.tableDigests[t.name] === verify.tableDigests[t.name],
        );
      if (finalized.overallDigest !== verify.overallDigest && !(usedFtsFilter && filteredParityOk)) {
        throw new Error(
          `Migration parity mismatch for ${identity.supervisorKey}: ` +
            `source=${verify.overallDigest} target=${finalized.overallDigest} ` +
            `sourceCounts=${JSON.stringify(verify.tableCounts)} targetCounts=${JSON.stringify(finalized.tableCounts)}`,
        );
      }

      // 6. Restore pending alarm on supervisor if scheduled in the future
      if (verify.alarmMs !== null) {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, verify.alarmMs));
      }

      await this.setMigrationState({
        status: 'migrated',
        legacyHexId: verify.hexId,
        migratedAt: new Date().toISOString(),
        sourceDigest: finalized.overallDigest,
      });

      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: identity.dispatchScriptName,
        orgId: options?.orgId ?? '',
        className: identity.className,
        eventKind: 'lazy_migration_hit',
        quotaTier: options?.quotaTier ?? 'free',
      });

      return {
        status: 'migrated',
        hexId: verify.hexId,
        tableCounts: finalized.tableCounts,
        kvCount: finalized.kvCount,
        overallDigest: finalized.overallDigest,
      };
    } finally {
      // Unmount the one-shot importer facet so the next call loads the real user DO class on `"main"`.
      try {
        this.ctx.facets.abort('main', new Error('Migration importer completed'));
      } catch {}
      this.activeFacetBundleKey = null;
    }
  }

  /**
   * Cohort C first-touch lazy hydration using an in-memory single-flight promise so
   * concurrent requests queue cleanly behind a single verified import without hitting
   * Cloudflare DO's 30-second `blockConcurrencyWhile()` reset timeout on larger shards.
   */
  private async ensureLazyMigrated(
    identity: SupervisorIdentity,
    orgId: string,
    quotaTier: AppQuotaTier,
  ): Promise<void> {
    if (this.migrationInFlight) {
      await this.migrationInFlight;
      return;
    }
    const state = await this.getMigrationState();
    if (state && (state.status === 'migrated' || state.status === 'empty')) {
      return;
    }
    await this.migrateFromWfpShim(identity, { orgId, quotaTier });
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
