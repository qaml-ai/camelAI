/**
 * DynamicServiceBroker — single trusted WorkerEntrypoint exported by `chiridion-app`
 * for `chiridion-dispatcher`'s hosted Dynamic Workers runtime.
 *
 * Why this exists:
 * - User apps deployed as Dynamic Workers run inside `chiridion-dispatcher`, while
 *   platform services (`AIVirtualBinding`, `CamelAiService`, `ConnectionsService`,
 *   `DataProxyService`, `AnalysisAppService`, `WarehouseService`) rely on
 *   `chiridion-app`'s secrets, AI Gateway tokens, egress relay, D1, and Sandbox
 *   Containers (`DbQueryContainer`, `AnalysisContainer`).
 * - Rather than duplicating secrets and container bindings onto `chiridion-dispatcher`
 *   (causing secret-rotation drift), `chiridion-dispatcher` binds this single trusted
 *   service entrypoint (`MAIN_APP_BROKER`) and forwards RPC calls with the app's
 *   verified tenant `props` (`orgId`, `workspaceId`, `userId`).
 * - `R2VirtualBucket`, `KVVirtualNamespace`, and `AssetsVirtualBinding` continue to
 *   run locally on `chiridion-dispatcher` against the exact same `chiridion-sandbox`
 *   R2 bucket and `APP_KV` namespace with zero extra hop.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { decryptCredentials } from '../../../src/lib/integration-crypto';
import { needsIntegrationTokenRefresh } from './integration-token-refresh.js';
import { buildIntegrationEnvVars, getIntegrationEnvVarPrefix } from './legacy-integration-env.js';
import { materializeRpcResult } from './rpc-result.js';
import type { Env } from './types.js';

export type BrokeredVirtualServiceName =
  | 'AIVirtualBinding'
  | 'CamelAiService'
  | 'ConnectionsService'
  | 'DataProxyService'
  | 'AnalysisAppService'
  | 'WarehouseService';

const ALLOWED_BROKERED_SERVICES: ReadonlySet<string> = new Set<BrokeredVirtualServiceName>([
  'AIVirtualBinding',
  'CamelAiService',
  'ConnectionsService',
  'DataProxyService',
  'AnalysisAppService',
  'WarehouseService',
]);

const ALLOWED_METHODS_BY_SERVICE: Record<BrokeredVirtualServiceName, ReadonlySet<string>> = {
  AIVirtualBinding: new Set(['run']),
  CamelAiService: new Set(['generateImage', 'transcribeAudio']),
  ConnectionsService: new Set([
    'list',
    'get',
    'tools',
    'methods',
    'find',
    'test',
    'verify',
    'invoke',
    '__invoke',
  ]),
  DataProxyService: new Set(['mssqlQuery', 'postgresQuery', 'mysqlQuery']),
  AnalysisAppService: new Set(['runCode', 'listConnections']),
  WarehouseService: new Set(['runCode', 'listConnections']),
};

type ExportFactoryMap = Record<
  string,
  ((options: { props: Record<string, unknown> }) => Record<string, (...args: unknown[]) => Promise<unknown>>) | undefined
>;

export class DynamicServiceBroker extends WorkerEntrypoint<Env> {
  // Trusted dispatcher hydration, outside the virtual service invoke allowlist.
  async resolveLegacyIntegrationEnvVars(
    orgId: string,
    workspaceId: string,
    neededKeys: string[],
  ): Promise<Array<{ key: string; value: string; isSecret: true }>> {
    if (
      typeof orgId !== 'string' || !orgId.trim() ||
      typeof workspaceId !== 'string' || !workspaceId.trim() ||
      !Array.isArray(neededKeys)
    ) {
      return [];
    }
    const keys = neededKeys.filter((key) => typeof key === 'string' && /^INT_[A-Z0-9_]+$/.test(key));
    if (keys.length === 0) return [];
    const requested = new Set(keys);

    const org = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    // The OrgDO integration read can migrate rows from a legacy WorkspaceDO.
    // Verify ownership before that read so it can only migrate this org's rows.
    const workspace = await org.getWorkspaceRecord(workspaceId);
    if (workspace?.org_id !== orgId) return [];
    const records = await org.getWorkspaceIntegrations(workspaceId);
    const resolved = new Map<string, string>();
    for (let record of records) {
      const prefix = getIntegrationEnvVarPrefix(record.name, record.integration_type);
      if (!keys.some((key) => key.startsWith(prefix))) continue;
      try {
        let credentials = record.credentials_encrypted
          ? await decryptCredentials(record.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY)
          : {};
        if (needsIntegrationTokenRefresh(record, credentials)) {
          try {
            const refreshed = await org.ensureFreshWorkspaceIntegration(workspaceId, record.id);
            if (!refreshed) continue;
            if (refreshed.credentials_encrypted !== record.credentials_encrypted) {
              credentials = refreshed.credentials_encrypted
                ? await decryptCredentials(refreshed.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY)
                : {};
            }
            record = refreshed;
          } catch {
            console.error('[DynamicServiceBroker] Failed to request integration token refresh', {
              orgId,
              workspaceId,
              integrationId: record.id,
            });
          }
        }
        const config = JSON.parse(record.config) as Record<string, unknown>;
        const vars = buildIntegrationEnvVars([{
          name: record.name,
          integration_type: record.integration_type,
          credentials,
          config,
        }]);
        for (const [key, value] of Object.entries(vars)) {
          if (requested.has(key)) resolved.set(key, value);
        }
      } catch {
        console.error('[DynamicServiceBroker] Failed to resolve legacy integration env vars', {
          orgId,
          workspaceId,
          integrationId: record.id,
        });
      }
    }

    return Array.from(resolved, ([key, value]) => ({ key, value, isSecret: true }));
  }

  async invoke(
    serviceName: BrokeredVirtualServiceName,
    props: Record<string, unknown>,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    if (!ALLOWED_BROKERED_SERVICES.has(serviceName)) {
      throw new Error(`Unsupported brokered virtual service: ${String(serviceName)}`);
    }
    const allowedMethods = ALLOWED_METHODS_BY_SERVICE[serviceName];
    if (!allowedMethods.has(method)) {
      throw new Error(`Unsupported method ${String(method)} on ${serviceName}`);
    }
    const exportsMap = (this.ctx as unknown as { exports?: ExportFactoryMap }).exports;
    const factory = exportsMap?.[serviceName];
    if (typeof factory !== 'function') {
      throw new Error(`Virtual service entrypoint is not exported on chiridion-app: ${serviceName}`);
    }
    const stub = factory({ props });
    if (!stub || typeof stub[method] !== 'function') {
      throw new Error(`Method ${method} not found on ${serviceName}`);
    }
    // IMPORTANT: Call directly as `stub[method](...args)` — never `fn.apply(stub, args)`.
    // On Cloudflare Workers JSRPC stubs, `.apply` is intercepted as a remote RPC method name.
    return materializeRpcResult(await stub[method](...args));
  }
}
