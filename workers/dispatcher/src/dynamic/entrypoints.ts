/**
 * Host WorkerEntrypoint RPC services injected into Dynamic Workers:
 * - TenantDoRouter: sharded DO fetch (preserving WebSockets) + structured-clone RPC
 * - AlarmMediator: stateless alarm bridge to TenantObjectSupervisorDO (workerd #6810)
 * - QuotaReporter: out-of-band trip reporter that triggers ctx.facets.abort() on loops
 * - CodemodeLoaderProxy: nested sandboxed Dynamic Worker execution for legacy LOADER apps
 * - UserLogsTail: forwards Dynamic Worker console/exception tail events to WorkerLogsDO
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { WorkerLogsDO } from '../../../main/src/worker-logs-do';
import {
  dynamicDoAliasKey,
  type AppQuotaTier,
  type AppRuntimeMode,
} from '../../../main/src/dynamic-worker-registry';
import { materializeRpcResult } from '../../../main/src/rpc-result';
import { quotaLimitsForTier, resolveQuotaTier } from './quota-policy';
import type { SupervisorIdentity, TenantObjectSupervisorDO } from './supervisor-do';

export interface EntrypointsEnv {
  APP_KV: KVNamespace;
  TENANT_DO_SUPERVISOR?: DurableObjectNamespace<TenantObjectSupervisorDO>;
  USER_APP_LOADER?: WorkerLoader;
  WORKER_LOGS?: DurableObjectNamespace<WorkerLogsDO>;
}

export interface TenantDoRouterProps {
  dispatchScriptName: string;
  orgId: string;
  quotaTier?: AppQuotaTier;
  bundleR2Key?: string;
  runtimeMode?: AppRuntimeMode;
}

const HEX_DO_ID_RE = /^[0-9a-f]{64}$/i;
const MAX_BUFFERED_DO_RESPONSE_BYTES = 4 * 1024 * 1024;

function replayBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
): ReadableStream<Uint8Array> {
  let canceled = false;
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        let next = await reader.read();
        while (!next.done && next.value.byteLength === 0) next = await reader.read();
        if (canceled) return;
        if (next.done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (!canceled) {
          void reader.cancel(error).catch(() => {});
          reader.releaseLock();
          throw error;
        }
      }
    },
    async cancel(reason) {
      canceled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

async function materializeDoResponse(response: Response, method: string): Promise<Response> {
  const body = response.body;
  if (!body || method === 'HEAD' || response.status === 101 || response.webSocket) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (
    contentType.includes('text/event-stream') || contentType.includes('application/x-ndjson') ||
    Number(response.headers.get('content-length')) > MAX_BUFFERED_DO_RESPONSE_BYTES
  ) {
    return response;
  }

  // Drain small replies before returning them through RPC so the caller can drop
  // the reply without leaving a pipe back to the supervisor open.
  const reader = body.getReader();
  let buffer = new Uint8Array(0);
  let size = 0;
  let streaming = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return new Response(buffer.subarray(0, size), response);

      const nextSize = size + value.byteLength;
      if (nextSize > MAX_BUFFERED_DO_RESPONSE_BYTES) {
        // Replay the bytes already read, then stream the rest from the same reader.
        const prefix = size ? [buffer.subarray(0, size), value] : [value];
        const forwarded = new Response(replayBody(reader, prefix), response);
        streaming = true;
        return forwarded;
      }
      if (nextSize > buffer.byteLength) {
        const capacity = Math.max(nextSize, Math.min(buffer.byteLength * 2, MAX_BUFFERED_DO_RESPONSE_BYTES));
        const expanded = new Uint8Array(capacity);
        expanded.set(buffer);
        buffer = expanded;
      }
      buffer.set(value, size);
      size = nextSize;
    }
  } finally {
    if (!streaming) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function cancelRequestBody(request: Request): void {
  const body = request.body;
  if (body && !body.locked) {
    // Cancellation can wait for another tee branch. Start it without delaying the error.
    void body.cancel().catch(() => {});
  }
}

export class TenantDoRouter extends WorkerEntrypoint<EntrypointsEnv, TenantDoRouterProps> {
  private hopCount = 0;

  private enforceHopBudget(): void {
    const tier = resolveQuotaTier(this.ctx.props?.quotaTier);
    const limits = quotaLimitsForTier(tier);
    const maxHops = limits?.maxDoHopsPerRequest ?? 0;
    if (maxHops > 0 && this.hopCount >= maxHops) {
      throw new Error(`Durable Object fan-out budget exceeded (${maxHops} hops per request)`);
    }
    this.hopCount += 1;
  }

  private async resolveCanonicalObjectId(
    appId: string,
    className: string,
    rawObjectId: string,
  ): Promise<string> {
    if (HEX_DO_ID_RE.test(rawObjectId)) {
      const aliased = await this.env.APP_KV.get(dynamicDoAliasKey(appId, className, rawObjectId));
      if (aliased) return aliased;
    }
    return rawObjectId;
  }

  private async getSupervisor(
    appId: string,
    className: string,
    rawObjectId: string,
  ): Promise<{
    stub: DurableObjectStub<TenantObjectSupervisorDO>;
    identity: SupervisorIdentity;
  }> {
    if (!this.env.TENANT_DO_SUPERVISOR) {
      throw new Error('TENANT_DO_SUPERVISOR binding is not configured on dispatcher');
    }
    const canonicalId = await this.resolveCanonicalObjectId(appId, className, rawObjectId);
    const supervisorKey = `${appId}:${className}:${canonicalId}`;
    const stub = this.env.TENANT_DO_SUPERVISOR.get(
      this.env.TENANT_DO_SUPERVISOR.idFromName(supervisorKey),
    );
    return {
      stub,
      identity: {
        supervisorKey,
        dispatchScriptName: appId,
        className,
        objectId: canonicalId,
        ...(this.ctx.props?.bundleR2Key ? { bundleR2Key: this.ctx.props.bundleR2Key } : {}),
        ...(this.ctx.props?.quotaTier ? { quotaTier: this.ctx.props.quotaTier } : {}),
        ...(this.ctx.props?.runtimeMode ? { runtimeMode: this.ctx.props.runtimeMode } : {}),
      },
    };
  }

  async fetchObject(
    appId: string,
    className: string,
    objectId: string,
    request: Request,
  ): Promise<Response> {
    let uploadAbort: AbortController | undefined;
    try {
      this.enforceHopBudget();
      const expectedApp = this.ctx.props?.dispatchScriptName;
      if (expectedApp && appId !== expectedApp) {
        cancelRequestBody(request);
        return new Response('Cross-app Durable Object access denied', { status: 403 });
      }
      const { stub, identity } = await this.getSupervisor(appId, className, objectId);
      const headers = new Headers(request.headers);
      headers.set('x-chiridion-app-id', identity.dispatchScriptName);
      headers.set('x-chiridion-do-class', identity.className);
      headers.set('x-chiridion-do-id', identity.objectId);
      headers.set('x-chiridion-supervisor-key', identity.supervisorKey);
      if (identity.bundleR2Key) headers.set('x-chiridion-bundle-key', identity.bundleR2Key);
      if (identity.quotaTier) headers.set('x-chiridion-quota-tier', identity.quotaTier);
      if (identity.runtimeMode) {
        headers.set('x-chiridion-runtime-mode', identity.runtimeMode);
      } else {
        headers.delete('x-chiridion-runtime-mode');
      }

      const init: RequestInit = { method: request.method, headers };
      if (request.body && request.method !== 'GET' && request.method !== 'HEAD') {
        uploadAbort = new AbortController();
        init.body = request.body;
        init.signal = uploadAbort.signal;
      }
      const response = await stub.fetch(new Request(request.url, init));
      return await materializeDoResponse(response, request.method);
    } catch (error) {
      // The outgoing fetch may still hold the request body lock when reading the reply fails.
      uploadAbort?.abort();
      cancelRequestBody(request);
      throw error;
    }
  }

  async rpcObject(
    appId: string,
    className: string,
    objectId: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    this.enforceHopBudget();
    const expectedApp = this.ctx.props?.dispatchScriptName;
    if (expectedApp && appId !== expectedApp) {
      throw new Error('Cross-app Durable Object RPC access denied');
    }
    if (!method || method === 'fetch' || method.startsWith('__chiridion')) {
      throw new Error(`Disallowed Durable Object RPC method: ${method}`);
    }
    const { stub, identity } = await this.getSupervisor(appId, className, objectId);
    return materializeRpcResult(await stub.rpcCall(identity, method, args));
  }
}

export interface AlarmMediatorProps {
  supervisorKey: string;
  dispatchScriptName: string;
  orgId: string;
  quotaTier?: AppQuotaTier;
}

export class AlarmMediator extends WorkerEntrypoint<EntrypointsEnv, AlarmMediatorProps> {
  private supervisorStub(): DurableObjectStub<TenantObjectSupervisorDO> {
    if (!this.env.TENANT_DO_SUPERVISOR) {
      throw new Error('TENANT_DO_SUPERVISOR binding is not configured');
    }
    return this.env.TENANT_DO_SUPERVISOR.get(
      this.env.TENANT_DO_SUPERVISOR.idFromName(this.ctx.props.supervisorKey),
    );
  }

  async setAlarm(
    scheduledTimeMs: number,
    options?: DurableObjectSetAlarmOptions,
  ): Promise<void> {
    await this.supervisorStub().setFacetAlarm(
      scheduledTimeMs,
      options,
      this.ctx.props.quotaTier,
    );
  }

  async getAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null> {
    return this.supervisorStub().getFacetAlarm(options);
  }

  async deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void> {
    await this.supervisorStub().deleteFacetAlarm(options);
  }
}

export interface QuotaReporterProps {
  supervisorKey: string;
  dispatchScriptName: string;
  orgId: string;
  quotaTier?: AppQuotaTier;
}

export class QuotaReporter extends WorkerEntrypoint<EntrypointsEnv, QuotaReporterProps> {
  async reportQuotaTrip(
    reason: string,
    limit: number,
    observed: number,
    tripCountInEvent: number,
  ): Promise<void> {
    if (!this.env.TENANT_DO_SUPERVISOR) return;
    const stub = this.env.TENANT_DO_SUPERVISOR.get(
      this.env.TENANT_DO_SUPERVISOR.idFromName(this.ctx.props.supervisorKey),
    );
    await stub.reportQuotaTrip(reason, limit, observed, tripCountInEvent);
  }
}

export interface CodemodeLoaderProxyProps {
  dispatchScriptName: string;
  orgId: string;
}

export interface CodemodeWorkerSpec {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  mainModule: string;
  modules: Record<string, string | WorkerLoaderModule>;
  env?: Record<string, unknown>;
}

function disposeQuietly(resource: unknown): void {
  if (typeof resource === 'object' && resource !== null && Symbol.dispose in resource) {
    try {
      (resource as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    } catch {}
  }
}

export class CodemodeLoaderProxy extends WorkerEntrypoint<EntrypointsEnv, CodemodeLoaderProxyProps> {
  private spawn(id: string | null, spec: CodemodeWorkerSpec): WorkerStub {
    if (!this.env.USER_APP_LOADER) {
      throw new Error('USER_APP_LOADER binding is not configured for codemode proxy');
    }
    const normalizedModules: Record<string, string | WorkerLoaderModule> = {};
    for (const [modName, modVal] of Object.entries(spec.modules)) {
      if (typeof modVal === 'string' && !modName.endsWith('.js') && !modName.endsWith('.py')) {
        normalizedModules[modName] = { js: modVal };
      } else {
        normalizedModules[modName] = modVal;
      }
    }
    const code: WorkerLoaderWorkerCode = {
      compatibilityDate: spec.compatibilityDate || '2026-07-13',
      compatibilityFlags: spec.compatibilityFlags ?? ['nodejs_compat'],
      mainModule: spec.mainModule,
      modules: normalizedModules,
      ...(spec.env ? { env: spec.env } : {}),
      // Always enforce zero raw network egress inside nested codemode sandboxes.
      globalOutbound: null,
    };
    const loader = this.env.USER_APP_LOADER as WorkerLoader & {
      load?: (c: WorkerLoaderWorkerCode) => WorkerStub;
    };
    if (!id && typeof loader.load === 'function') {
      return loader.load(code);
    }
    const scopedId = `cm:${this.ctx.props.dispatchScriptName}:${id ?? crypto.randomUUID()}`;
    return loader.get(scopedId, () => code);
  }

  /**
   * 2-hop RPC execution matching `@cloudflare/codemode`'s DynamicWorkerExecutor:
   * forwards `dispatchers` / `connectors` containing UserApp `RpcTarget`s directly
   * into the nested sandbox entrypoint's method (e.g. `evaluate(...)`).
   */
  async invokeEntrypoint(
    id: string | null,
    spec: CodemodeWorkerSpec,
    entrypointName: string | undefined,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const worker = this.spawn(id, spec);
    try {
      const ep = worker.getEntrypoint(entrypointName) as unknown as Record<
        string,
        (...a: unknown[]) => Promise<unknown>
      >;
      try {
        return await ep[method]!(...args);
      } finally {
        disposeQuietly(ep);
      }
    } finally {
      disposeQuietly(worker);
    }
  }

  async fetchEntrypoint(
    id: string | null,
    spec: CodemodeWorkerSpec,
    entrypointName: string | undefined,
    request: Request,
  ): Promise<Response> {
    const worker = this.spawn(id, spec);
    try {
      const ep = worker.getEntrypoint(entrypointName);
      try {
        return await ep.fetch(request);
      } finally {
        disposeQuietly(ep);
      }
    } finally {
      disposeQuietly(worker);
    }
  }
}

export interface UserLogsTailProps {
  dispatchScriptName: string;
  orgId: string;
}

interface NormalizedLogEvent {
  timestamp: number;
  level: string;
  message: string | null;
  exception: string | null;
  scriptVersion: string | null;
}

function formatTraceMessage(parts: unknown[] | undefined): string | null {
  if (!parts || parts.length === 0) return null;
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    })
    .join(' ');
}

export class UserLogsTail extends WorkerEntrypoint<EntrypointsEnv, UserLogsTailProps> {
  async tail(events: TraceItem[]): Promise<void> {
    if (!this.env.WORKER_LOGS) return;
    const scriptName = this.ctx.props?.dispatchScriptName;
    if (!scriptName) return;

    const normalized: NormalizedLogEvent[] = [];
    for (const item of events) {
      const timestamp = item.eventTimestamp ?? Date.now();
      const scriptVersion = item.scriptVersion ? String(item.scriptVersion) : null;
      if (item.logs && item.logs.length > 0) {
        for (const log of item.logs) {
          normalized.push({
            timestamp: log.timestamp ?? timestamp,
            level: log.level ?? 'log',
            message: formatTraceMessage(log.message as unknown[] | undefined),
            exception: null,
            scriptVersion,
          });
        }
      }
      if (item.exceptions && item.exceptions.length > 0) {
        for (const ex of item.exceptions) {
          normalized.push({
            timestamp: ex.timestamp ?? timestamp,
            level: 'error',
            message: ex.message ?? null,
            exception: ex.name ? `${ex.name}: ${ex.message ?? ''}` : (ex.message ?? null),
            scriptVersion,
          });
        }
      }
    }

    if (normalized.length === 0) return;
    try {
      const id = this.env.WORKER_LOGS.idFromName(scriptName);
      const stub = this.env.WORKER_LOGS.get(id) as unknown as {
        ingestLogs(events: NormalizedLogEvent[]): Promise<void>;
      };
      await stub.ingestLogs(normalized);
    } catch (error) {
      console.error('[dynamic-logs-tail] failed to store logs', {
        scriptName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
