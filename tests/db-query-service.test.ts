import { describe, it, expect, vi } from 'vitest';
import {
  DbQueryContainerUnavailableError,
  relayConfigFromEnv,
  runDbExport,
  runDbQuery,
  type DbQueryContainerStub,
  type DbQueryRequest,
  type DbRunnerOutput,
} from '../workers/main/src/db-query-service.js';

const RELAY = {
  hostname: 'db-relay.example.com',
  socksUsername: 'user',
  socksPassword: 'pass',
  accessClientId: 'id',
  accessClientSecret: 'secret',
};

const REQUEST: DbQueryRequest = {
  engine: 'postgres',
  target: { host: 'db.example.com', port: 5432, user: 'u', password: 'p', database: 'd' },
  sql: 'SELECT 1',
};

const QUERY_OK = JSON.stringify({ ok: true, rows: [{ ok: 1 }], fields: [{ name: 'ok' }], rowCount: 1, truncated: false, durationMs: 3 });

interface FakeOptions {
  /** relayForwarderReady results in order; the last repeats. */
  ready: boolean[];
  runnerStdout?: string;
  runnerStderr?: string;
  runnerExitCode?: number;
  runnerTimedOut?: boolean;
}

function runnerOutput(stdout: string, stderr = '', exitCode = 0, timedOut = false): DbRunnerOutput {
  return { stdout, stderr, exitCode, timedOut };
}

function fakeContainer(options: FakeOptions) {
  let readyCalls = 0;
  const runnerEnvs: Array<Record<string, string>> = [];
  const runnerTimeouts: number[] = [];
  const container = {
    start: vi.fn(async () => {}),
    startRelayForwarder: vi.fn(async () => {}),
    relayForwarderReady: vi.fn(async () => {
      const ready = options.ready[Math.min(readyCalls, options.ready.length - 1)];
      readyCalls += 1;
      return ready;
    }),
    runRunner: vi.fn(async (env: Record<string, string>, timeoutMs: number) => {
      runnerEnvs.push(env);
      runnerTimeouts.push(timeoutMs);
      return runnerOutput(
        options.runnerStdout ?? QUERY_OK,
        options.runnerStderr ?? '',
        options.runnerExitCode ?? 0,
        options.runnerTimedOut ?? false,
      );
    }),
    prepareWarehouseExport: vi.fn(async () => {}),
    publishWarehouseExport: vi.fn(async () => {}),
    destroy: vi.fn(async () => ({ destroyed: true })),
  } satisfies DbQueryContainerStub;
  return { container, runnerEnvs, runnerTimeouts };
}

describe('relayConfigFromEnv', () => {
  it('returns the config when hostname and SOCKS credentials are set', () => {
    expect(
      relayConfigFromEnv({
        DB_EGRESS_RELAY_HOSTNAME: ' db-relay.example.com ',
        DB_EGRESS_RELAY_SOCKS_USERNAME: 'u',
        DB_EGRESS_RELAY_SOCKS_PASSWORD: 'p',
      }),
    ).toEqual({
      hostname: 'db-relay.example.com',
      socksUsername: 'u',
      socksPassword: 'p',
      accessClientId: undefined,
      accessClientSecret: undefined,
    });
  });

  it('returns null only when the relay is FULLY unset (direct mode)', () => {
    expect(relayConfigFromEnv({})).toBeNull();
  });

  it.each([
    { DB_EGRESS_RELAY_HOSTNAME: 'h' },
    { DB_EGRESS_RELAY_HOSTNAME: 'h', DB_EGRESS_RELAY_SOCKS_USERNAME: 'u' },
    // Blank hostname but creds present is also a misconfig, not direct mode.
    { DB_EGRESS_RELAY_HOSTNAME: '   ', DB_EGRESS_RELAY_SOCKS_USERNAME: 'u', DB_EGRESS_RELAY_SOCKS_PASSWORD: 'p' },
    // Exactly one Access service-token half set is a partial config too.
    { DB_EGRESS_RELAY_HOSTNAME: 'h', DB_EGRESS_RELAY_SOCKS_USERNAME: 'u', DB_EGRESS_RELAY_SOCKS_PASSWORD: 'p', DB_EGRESS_RELAY_ACCESS_CLIENT_ID: 'id' },
    { DB_EGRESS_RELAY_HOSTNAME: 'h', DB_EGRESS_RELAY_SOCKS_USERNAME: 'u', DB_EGRESS_RELAY_SOCKS_PASSWORD: 'p', DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET: 'sec' },
  ])('throws on a partial relay config instead of silently degrading (%#)', (env) => {
    expect(() => relayConfigFromEnv(env)).toThrow(/partial relay config/);
  });

  it('accepts a relay config with both Access token halves', () => {
    expect(
      relayConfigFromEnv({
        DB_EGRESS_RELAY_HOSTNAME: 'h',
        DB_EGRESS_RELAY_SOCKS_USERNAME: 'u',
        DB_EGRESS_RELAY_SOCKS_PASSWORD: 'p',
        DB_EGRESS_RELAY_ACCESS_CLIENT_ID: 'id',
        DB_EGRESS_RELAY_ACCESS_CLIENT_SECRET: 'sec',
      }),
    ).toMatchObject({ hostname: 'h', accessClientId: 'id', accessClientSecret: 'sec' });
  });
});

describe('runDbQuery — ship + run', () => {
  const deps = (container: DbQueryContainerStub, extra?: Partial<Parameters<typeof runDbQuery>[0]>) => ({
    container,
    relay: RELAY,
    ...extra,
  });

  it('runs the runner once with source, request and SOCKS creds when the forwarder is warm', async () => {
    const fake = fakeContainer({ ready: [true] });
    const result = await runDbQuery(deps(fake.container), REQUEST);

    expect(result).toMatchObject({ ok: true, rows: [{ ok: 1 }], rowCount: 1 });
    expect(fake.container.start).toHaveBeenCalledTimes(1);
    expect(fake.container.startRelayForwarder).not.toHaveBeenCalled();
    expect(fake.container.runRunner).toHaveBeenCalledTimes(1);
    expect(fake.runnerEnvs[0]?.DB_RUNNER_SRC).toContain('validateQueryRequest');
    expect(fake.runnerEnvs[0]).toMatchObject({
      DB_QUERY_REQUEST: JSON.stringify(REQUEST),
      DB_RELAY_LOCAL_PORT: '11080',
      DB_EGRESS_RELAY_SOCKS_USERNAME: RELAY.socksUsername,
      DB_EGRESS_RELAY_SOCKS_PASSWORD: RELAY.socksPassword,
    });
    // The default 30s query budget plus the runner's startup overhead.
    expect(fake.runnerTimeouts[0]).toBe(45_000);
  });

  it('direct mode (relay null): dials without a forwarder or SOCKS env', async () => {
    const fake = fakeContainer({ ready: [true] });
    const result = await runDbQuery(deps(fake.container, { relay: null }), REQUEST);

    expect(result.ok).toBe(true);
    expect(fake.container.relayForwarderReady).not.toHaveBeenCalled();
    expect(fake.container.startRelayForwarder).not.toHaveBeenCalled();
    expect(fake.runnerEnvs[0]?.DB_RUNNER_SRC).toContain('validateQueryRequest');
    expect(fake.runnerEnvs[0]).not.toHaveProperty('DB_EGRESS_RELAY_SOCKS_USERNAME');
    expect(fake.runnerEnvs[0]).not.toHaveProperty('DB_RELAY_LOCAL_PORT');
    expect(fake.runnerEnvs[0]).toMatchObject({ DB_QUERY_REQUEST: JSON.stringify(REQUEST) });
  });

  it('starts the forwarder with the relay host and Access token when the port is not yet accepting', async () => {
    const fake = fakeContainer({ ready: [false, true] });
    const result = await runDbQuery(deps(fake.container, { readinessTimeoutMs: 3_000 }), REQUEST);

    expect(result.ok).toBe(true);
    expect(fake.container.startRelayForwarder).toHaveBeenCalledTimes(1);
    expect(fake.container.startRelayForwarder).toHaveBeenCalledWith({
      hostname: 'db-relay.example.com',
      accessClientId: 'id',
      accessClientSecret: 'secret',
    });
  });

  it('fails with the forwarder-readiness message when the tunnel never comes up', async () => {
    const fake = fakeContainer({ ready: [false] });
    await expect(
      runDbQuery(deps(fake.container, { readinessTimeoutMs: 600 }), REQUEST),
    ).rejects.toThrow(/forwarder never became ready/);
  });

  it('surfaces runner error payloads as structured failures', async () => {
    const fake = fakeContainer({
      ready: [true],
      runnerStdout: JSON.stringify({ ok: false, error: { message: 'Refusing to relay to 10.0.0.1: blocked IPv4 range 10.0.0.0/8', status: 400 } }),
    });
    const result = await runDbQuery(deps(fake.container), REQUEST);
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('blocked IPv4 range'), status: 400 },
    });
  });

  it('handles empty runner output without throwing', async () => {
    const fake = fakeContainer({ ready: [true], runnerStdout: '', runnerStderr: 'node crashed', runnerExitCode: 1 });
    const result = await runDbQuery(deps(fake.container), REQUEST);
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
    if (!result.ok) expect(result.error.message).toContain('node crashed');
  });

  it('reports a runner the container timed out as a 504', async () => {
    const fake = fakeContainer({ ready: [true], runnerStdout: '', runnerExitCode: 124, runnerTimedOut: true });
    const result = await runDbQuery(deps(fake.container), REQUEST);
    expect(result).toMatchObject({ ok: false, error: { status: 504, message: 'runner timed out after 45000ms' } });
  });

  it('handles non-JSON runner output without throwing', async () => {
    const fake = fakeContainer({ ready: [true], runnerStdout: 'Segmentation fault' });
    const result = await runDbQuery(deps(fake.container), REQUEST);
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
  });
});

describe('runDbExport — prepare + run straight to R2', () => {
  const deps = (container: DbQueryContainerStub, extra?: Partial<Parameters<typeof runDbExport>[0]>) => ({
    container,
    relay: RELAY,
    ...extra,
  });
  const PREFIX = 'warehouse/ws-1';
  const PATH = '/warehouse/ws-1/conn/abc.parquet';

  it('prepares the workspace prefix, runs op export with DB_EXPORT_PATH, then publishes', async () => {
    const fake = fakeContainer({
      ready: [true],
      runnerStdout: JSON.stringify({ ok: true, rowCount: 42, bytes: 1234, durationMs: 8 }),
    });
    const result = await runDbExport(deps(fake.container), REQUEST, PREFIX, PATH);

    expect(result).toEqual({ ok: true, rowCount: 42, bytes: 1234, durationMs: 8 });
    expect(fake.container.prepareWarehouseExport).toHaveBeenCalledWith(PREFIX);
    expect(fake.container.runRunner).toHaveBeenCalledTimes(1);
    expect(fake.runnerEnvs[0]?.DB_EXPORT_PATH).toBe(PATH);
    expect(JSON.parse(fake.runnerEnvs[0]?.DB_QUERY_REQUEST ?? '{}')).toMatchObject({ op: 'export', engine: 'postgres' });
    expect(fake.container.publishWarehouseExport).toHaveBeenCalledWith(PREFIX, PATH);
  });

  it('direct mode skips relay plumbing but still prepares', async () => {
    const fake = fakeContainer({
      ready: [true],
      runnerStdout: JSON.stringify({ ok: true, rowCount: 0, bytes: 12, durationMs: 1 }),
    });
    const result = await runDbExport(deps(fake.container, { relay: null }), REQUEST, PREFIX, PATH);
    expect(result.ok).toBe(true);
    expect(fake.container.relayForwarderReady).not.toHaveBeenCalled();
    expect(fake.container.prepareWarehouseExport).toHaveBeenCalledWith(PREFIX);
    expect(fake.runnerEnvs[0]).not.toHaveProperty('DB_EGRESS_RELAY_SOCKS_USERNAME');
  });

  it('surfaces runner export errors as structured failures and publishes nothing', async () => {
    const fake = fakeContainer({
      ready: [true],
      runnerStdout: JSON.stringify({ ok: false, error: { message: 'Export timed out after 120000ms', status: 504, code: 'ETIMEOUT' } }),
    });
    const result = await runDbExport(deps(fake.container), REQUEST, PREFIX, PATH);
    expect(result).toMatchObject({ ok: false, error: { status: 504, code: 'ETIMEOUT' } });
    expect(fake.container.publishWarehouseExport).not.toHaveBeenCalled();
  });

  it('treats an ok result without rowCount/bytes as malformed', async () => {
    const fake = fakeContainer({
      ready: [true],
      runnerStdout: JSON.stringify({ ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 1 }),
    });
    const result = await runDbExport(deps(fake.container), REQUEST, PREFIX, PATH);
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
    expect(fake.container.publishWarehouseExport).not.toHaveBeenCalled();
  });
});

describe('transient container failures', () => {
  function flakyRunner(error: Error, failures = 1, stdout = QUERY_OK) {
    let remaining = failures;
    return vi.fn(async () => {
      if (remaining > 0) {
        remaining -= 1;
        throw error;
      }
      return runnerOutput(stdout);
    });
  }

  function harness(overrides: Partial<Record<keyof DbQueryContainerStub, unknown>>) {
    const onTransientRetry = vi.fn();
    const sleep = vi.fn(async () => {});
    const { container } = fakeContainer({ ready: [true] });
    const deps = {
      relay: RELAY,
      onTransientRetry,
      sleep,
      container: { ...container, ...overrides } as DbQueryContainerStub,
    };
    return { deps, onTransientRetry, sleep };
  }

  it.each([
    'DbQueryContainerUnavailableError: DB query container is not running (runRunner): container crashed',
    'Network connection lost.',
    'Runtime signalled the container to exit due to a new version rollout: 0',
    "Durable Object's code has been updated",
  ])('retries a read once after "%s"', async (message) => {
    const runRunner = flakyRunner(new Error(message));
    const t = harness({ runRunner });
    const result = await runDbQuery(t.deps, REQUEST);

    expect(result).toMatchObject({ ok: true, rowCount: 1 });
    expect(runRunner).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledTimes(1);
    expect(t.onTransientRetry).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'db_query', dispatched: true }),
    );
  });

  it('retries a modify when the failure hit before the SQL was dispatched', async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new DbQueryContainerUnavailableError('start', new Error('no capacity')))
      .mockResolvedValue(undefined);
    const t = harness({ start });
    const result = await runDbQuery(t.deps, { ...REQUEST, mode: 'modify' });

    expect(result.ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
    expect(t.onTransientRetry).toHaveBeenCalledWith(expect.objectContaining({ dispatched: false }));
  });

  it('never re-runs a modify whose runner was already dispatched', async () => {
    const runRunner = flakyRunner(new Error('Network connection lost.'));
    const t = harness({ runRunner });

    await expect(runDbQuery(t.deps, { ...REQUEST, mode: 'modify' })).rejects.toThrow('Network connection lost.');
    expect(runRunner).toHaveBeenCalledTimes(1);
    expect(t.onTransientRetry).not.toHaveBeenCalled();
  });

  it('retries at most once', async () => {
    const runRunner = flakyRunner(new Error('Network connection lost.'), 2);
    const t = harness({ runRunner });

    await expect(runDbQuery(t.deps, REQUEST)).rejects.toThrow('Network connection lost.');
    expect(runRunner).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    const runRunner = flakyRunner(new Error('relation "nope" does not exist'));
    const t = harness({ runRunner });

    await expect(runDbQuery(t.deps, REQUEST)).rejects.toThrow('does not exist');
    expect(t.onTransientRetry).not.toHaveBeenCalled();
  });

  it('retries an export only before its runner is dispatched', async () => {
    const exportOk = JSON.stringify({ ok: true, rowCount: 1, bytes: 10, durationMs: 1 });
    const prepare = vi.fn()
      .mockRejectedValueOnce(new DbQueryContainerUnavailableError('prepareWarehouseExport', new Error('gone')))
      .mockResolvedValue(undefined);
    const beforeDispatch = harness({
      prepareWarehouseExport: prepare,
      runRunner: flakyRunner(new Error('unused'), 0, exportOk),
    });
    await expect(runDbExport(beforeDispatch.deps, REQUEST, 'warehouse/ws-1', '/warehouse/ws-1/x.parquet'))
      .resolves.toMatchObject({ ok: true });
    expect(prepare).toHaveBeenCalledTimes(2);

    const midExport = harness({ runRunner: flakyRunner(new Error('Network connection lost.'), 1, exportOk) });
    await expect(runDbExport(midExport.deps, REQUEST, 'warehouse/ws-1', '/warehouse/ws-1/x.parquet'))
      .rejects.toThrow('Network connection lost.');
    expect(midExport.onTransientRetry).not.toHaveBeenCalled();
  });
});
