import { WorkerEntrypoint } from 'cloudflare:workers';
import { assertConnectionsBindingEnabled } from '../../../src/lib/connections-binding';
import {
  getConnection,
  findConnectionMethodEntry,
  invokeConnectionMethod,
  listConnectionMethods,
  listConnections,
  listConnectionTools,
  testConnectionMethodEntry,
  verifyConnection,
  type ConnectionFindQuery,
  type ConnectionInvokeRequest,
  type ConnectionMethodCatalogEntry,
  type ConnectionSmokeTestResult,
  type ConnectionSummary,
  type ConnectionVerificationResult,
  type ConnectionsRuntimeEnv,
} from './connections-runtime.js';

interface ConnectionsServiceProps {
  orgId: string;
  workspaceId: string;
  userId?: string;
}

const LEGACY_CONNECTION_INVOKE_METHOD = ["_", "_", "invoke"].join("");

/**
 * Virtual service binding entrypoint for user uploaded workers.
 *
 * User workers bind `CONNECTIONS` as a service binding; cf-api-proxy rewrites
 * that binding to this entrypoint with workspace/org props for tenant isolation.
 *
 * When CONNECTIONS_BINDING_ENABLED is false, every method fails closed so
 * already-deployed apps cannot pull connection-backed data.
 */
export class ConnectionsService extends WorkerEntrypoint<
  ConnectionsRuntimeEnv,
  ConnectionsServiceProps
> {
  private get context(): ConnectionsServiceProps {
    return this.ctx.props;
  }

  private assertEnabled(): void {
    assertConnectionsBindingEnabled(this.env);
  }

  async list(): Promise<ConnectionSummary[]> {
    this.assertEnabled();
    return listConnections(this.env, this.context);
  }

  async get(connection: string): Promise<ConnectionSummary> {
    this.assertEnabled();
    return getConnection(this.env, this.context, connection);
  }

  async tools(connection: string): Promise<unknown[]> {
    this.assertEnabled();
    return listConnectionTools(this.env, this.context, connection);
  }

  /**
   * Lists every workspace connection plus the method names and JSON schemas
   * exposed on the method facade, e.g. `connections.stripeProd.listCustomers`.
   */
  async methods(): Promise<ConnectionMethodCatalogEntry[]> {
    this.assertEnabled();
    return listConnectionMethods(this.env, this.context);
  }

  /**
   * Finds one connection method catalog entry by alias, id, type, or name.
   * Throws on missing or ambiguous matches so callers fail loudly.
   */
  async find(query: ConnectionFindQuery): Promise<ConnectionMethodCatalogEntry> {
    this.assertEnabled();
    return findConnectionMethodEntry(this.env, this.context, query);
  }

  /**
   * Runs a safe smoke test for a connection. Database-style connections run
   * `SELECT 1 AS ok`; other providers validate that the method catalog resolves.
   */
  async test(query: ConnectionFindQuery): Promise<ConnectionSmokeTestResult> {
    this.assertEnabled();
    return testConnectionMethodEntry(this.env, this.context, query);
  }

  /** Performs the adapter's normalized live or configuration verification. */
  async verify(query: ConnectionFindQuery): Promise<ConnectionVerificationResult> {
    this.assertEnabled();
    return verifyConnection(this.env, this.context, query);
  }

  async invoke<T = unknown>(request: ConnectionInvokeRequest): Promise<T> {
    this.assertEnabled();
    return invokeConnectionMethod(this.env, this.context, request) as Promise<T>;
  }

  async [LEGACY_CONNECTION_INVOKE_METHOD](request: ConnectionInvokeRequest): Promise<unknown> {
    return this.invoke(request);
  }
}