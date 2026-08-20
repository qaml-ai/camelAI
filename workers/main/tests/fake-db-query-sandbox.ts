import { vi } from 'vitest';
import type { DbQueryRequest } from '../src/db-query-service.js';

/**
 * Fake DB_QUERY_SANDBOX Durable Object namespace for tests of the legacy
 * data-proxy surface (data-proxy.ts and its consumers).
 *
 * `getSandbox()` only does `idFromName` + `get` and wraps the stub (any
 * configuration RPCs are optional-chained), so a plain object namespace works.
 * The fake "runner" parses DB_QUERY_REQUEST from the exec env — exactly what
 * the real runner does — and answers with the JSON your `respond` returns
 * (an object is stringified; a string is used verbatim for malformed-output
 * tests).
 */
export interface FakeDbQueryCall {
  request: DbQueryRequest;
  env: Record<string, string | undefined>;
  command: string;
}

export function fakeDbQuerySandboxNamespace(respond: (request: DbQueryRequest) => unknown) {
  const calls: FakeDbQueryCall[] = [];
  const mountPrefixes: string[] = [];
  const stub = {
    ensureReady: vi.fn(async () => {}),
    ensureRelayEgress: vi.fn(async () => {}),
    ensureWarehouseExportMount: vi.fn(async (prefix: string) => {
      mountPrefixes.push(prefix);
    }),
    startProcess: vi.fn(async () => ({})),
    exec: vi.fn(async (command: string, opts?: { env?: Record<string, string | undefined> }) => {
      if (command.includes('/dev/tcp/')) {
        return { stdout: 'up', stderr: '', exitCode: 0 };
      }
      const request = JSON.parse(opts?.env?.DB_QUERY_REQUEST ?? '{}') as DbQueryRequest;
      calls.push({ request, env: opts?.env ?? {}, command });
      const body = respond(request);
      return {
        stdout: typeof body === 'string' ? body : JSON.stringify(body),
        stderr: '',
        exitCode: 0,
      };
    }),
  };
  const namespace = {
    idFromName: (name: string) => ({ name, toString: () => name }),
    get: () => stub,
  };
  return { namespace, stub, calls, mountPrefixes };
}
