import { vi } from 'vitest';
import type { DbQueryContainerStub, DbQueryRequest } from '../src/db-query-service.js';

/**
 * Fake DB_QUERY_SANDBOX Durable Object namespace (DbQueryContainer) for tests
 * of the legacy data-proxy surface (data-proxy.ts and its consumers).
 *
 * The fake runner parses DB_QUERY_REQUEST from the runner env — exactly what
 * the real runner does — and answers with the JSON your `respond` returns (an
 * object is stringified; a string is used verbatim for malformed-output tests).
 */
export interface FakeDbQueryCall {
  request: DbQueryRequest;
  env: Record<string, string>;
}

export function fakeDbQueryContainerNamespace(respond: (request: DbQueryRequest) => unknown) {
  const calls: FakeDbQueryCall[] = [];
  const prepared: string[] = [];
  /** Instance names the namespace was asked for. */
  const names: string[] = [];
  const stub = {
    start: vi.fn(async () => {}),
    startRelayForwarder: vi.fn(async () => {}),
    relayForwarderReady: vi.fn(async () => true),
    runRunner: vi.fn(async (env: Record<string, string>) => {
      const request = JSON.parse(env.DB_QUERY_REQUEST ?? '{}') as DbQueryRequest;
      calls.push({ request, env });
      const body = respond(request);
      return {
        stdout: typeof body === 'string' ? body : JSON.stringify(body),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };
    }),
    prepareWarehouseExport: vi.fn(async (prefix: string) => {
      prepared.push(prefix);
    }),
    publishWarehouseExport: vi.fn(async () => {}),
    destroy: vi.fn(async () => ({ destroyed: true })),
  } satisfies DbQueryContainerStub;
  const namespace = {
    getByName: (name: string) => {
      names.push(name);
      return stub;
    },
  };
  return { namespace, stub, calls, prepared, names };
}
