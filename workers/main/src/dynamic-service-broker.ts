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
    const fn = stub?.[method];
    if (typeof fn !== 'function') {
      throw new Error(`Method ${method} not found on ${serviceName}`);
    }
    return fn.apply(stub, args);
  }
}
