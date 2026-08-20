import { describe, it, expect, vi } from 'vitest';
import {
  relayConfigFromEnv,
  runDbExport,
  runDbQuery,
  DB_RELAY_FORWARDER_PROCESS_ID,
  type DbQueryRequest,
  type DbQuerySandboxStub,
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

interface FakeOptions {
  /** forwarderReady probe results in order; the last repeats. "up"/"down". */
  ready: Array<'up' | 'down'>;
  runnerStdout?: string;
  runnerStderr?: string;
  runnerExitCode?: number;
  startProcessError?: Error;
}

function execResult(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode };
}

function fakeSandbox(options: FakeOptions) {
  let readyCalls = 0;
  const ensureReady = vi.fn(async () => {});
  const ensureRelayEgress = vi.fn(async () => {});
  const ensureWarehouseExportMount = vi.fn(async () => {});
  const startProcess = vi.fn(async () => {
    if (options.startProcessError) throw options.startProcessError;
    return {};
  });
  const execCommands: string[] = [];
  const execEnvs: Array<Record<string, string | undefined> | undefined> = [];
  const exec = vi.fn(async (command: string, opts?: { env?: Record<string, string | undefined> }) => {
    if (command.includes('/dev/tcp/')) {
      const step = options.ready[Math.min(readyCalls, options.ready.length - 1)];
      readyCalls += 1;
      return execResult(step === 'up' ? 'up' : 'down');
    }
    execCommands.push(command);
    execEnvs.push(opts?.env);
    return execResult(
      options.runnerStdout ?? JSON.stringify({ ok: true, rows: [{ ok: 1 }], fields: [{ name: 'ok' }], rowCount: 1, truncated: false, durationMs: 3 }),
      options.runnerStderr ?? '',
      options.runnerExitCode ?? 0,
    );
  });
  const sandbox: DbQuerySandboxStub = {
    ensureReady,
    ensureRelayEgress,
    ensureWarehouseExportMount,
    startProcess,
    exec,
  };
  return {
    sandbox,
    ensureReady,
    ensureRelayEgress,
    ensureWarehouseExportMount,
    startProcess,
    exec,
    execCommands,
    execEnvs,
  };
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

describe('runDbQuery — ship + exec', () => {
  const deps = (sandbox: DbQuerySandboxStub, extra?: Partial<Parameters<typeof runDbQuery>[0]>) => ({
    sandbox,
    relay: RELAY,
    newRunId: () => 'test-run',
    ...extra,
  });

  it('opens egress and runs the piped runner in one exec when the forwarder is warm', async () => {
    const fake = fakeSandbox({ ready: ['up'] });
    const result = await runDbQuery(deps(fake.sandbox), REQUEST);

    expect(result).toMatchObject({ ok: true, rows: [{ ok: 1 }], rowCount: 1 });
    expect(fake.ensureRelayEgress).toHaveBeenCalledWith('db-relay.example.com');
    expect(fake.startProcess).not.toHaveBeenCalled();
    // Single stateless exec: runner piped into node over stdin, source + creds in env.
    expect(fake.execCommands).toHaveLength(1);
    expect(fake.execCommands[0]).toContain('node --input-type=module');
    expect(fake.execEnvs[0]?.DB_RUNNER_SRC).toContain('validateQueryRequest');
    expect(fake.execEnvs[0]).toMatchObject({
      DB_QUERY_REQUEST: JSON.stringify(REQUEST),
      DB_EGRESS_RELAY_SOCKS_USERNAME: RELAY.socksUsername,
      DB_EGRESS_RELAY_SOCKS_PASSWORD: RELAY.socksPassword,
    });
  });

  it('direct mode (relay null): dials without a forwarder or SOCKS env', async () => {
    const fake = fakeSandbox({ ready: ['up'] });
    const result = await runDbQuery(deps(fake.sandbox, { relay: null }), REQUEST);

    expect(result.ok).toBe(true);
    // No relay plumbing at all.
    expect(fake.ensureRelayEgress).not.toHaveBeenCalled();
    expect(fake.startProcess).not.toHaveBeenCalled();
    expect(fake.exec.mock.calls.every((call) => !String(call[0]).includes('/dev/tcp'))).toBe(true);
    // Runner still piped + executed, but with no SOCKS creds → direct dial.
    expect(fake.execEnvs[0]?.DB_RUNNER_SRC).toContain('validateQueryRequest');
    expect(fake.execEnvs[0]).not.toHaveProperty('DB_EGRESS_RELAY_SOCKS_USERNAME');
    expect(fake.execEnvs[0]).not.toHaveProperty('DB_RELAY_LOCAL_PORT');
    expect(fake.execEnvs[0]).toMatchObject({ DB_QUERY_REQUEST: JSON.stringify(REQUEST) });
  });

  it('starts the cloudflared forwarder when the port is not yet accepting', async () => {
    const fake = fakeSandbox({ ready: ['down', 'up'] });
    const result = await runDbQuery(deps(fake.sandbox, { readinessTimeoutMs: 3_000 }), REQUEST);

    expect(result.ok).toBe(true);
    expect(fake.startProcess).toHaveBeenCalledTimes(1);
    const [command, opts] = fake.startProcess.mock.calls[0] as unknown as [string, { processId?: string }];
    expect(command).toContain('cloudflared access tcp --hostname db-relay.example.com');
    expect(command).toContain('--service-token-id id');
    expect(opts.processId).toBe(DB_RELAY_FORWARDER_PROCESS_ID);
  });

  it('fails with the forwarder-readiness message when the tunnel never comes up', async () => {
    const fake = fakeSandbox({ ready: ['down'] });
    await expect(
      runDbQuery(deps(fake.sandbox, { readinessTimeoutMs: 600 }), REQUEST),
    ).rejects.toThrow(/forwarder never became ready/);
  });

  it('surfaces runner error payloads as structured failures', async () => {
    const fake = fakeSandbox({
      ready: ['up'],
      runnerStdout: JSON.stringify({ ok: false, error: { message: 'Refusing to relay to 10.0.0.1: blocked IPv4 range 10.0.0.0/8', status: 400 } }),
    });
    const result = await runDbQuery(deps(fake.sandbox), REQUEST);
    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('blocked IPv4 range'), status: 400 },
    });
  });

  it('handles empty runner output without throwing', async () => {
    const fake = fakeSandbox({ ready: ['up'], runnerStdout: '', runnerStderr: 'node crashed', runnerExitCode: 1 });
    const result = await runDbQuery(deps(fake.sandbox), REQUEST);
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
    if (!result.ok) expect(result.error.message).toContain('node crashed');
  });

  it('handles non-JSON runner output without throwing', async () => {
    const fake = fakeSandbox({ ready: ['up'], runnerStdout: 'Segmentation fault' });
    const result = await runDbQuery(deps(fake.sandbox), REQUEST);
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
  });
});

describe('runDbExport — mount + exec straight to R2', () => {
  const deps = (sandbox: DbQuerySandboxStub, extra?: Partial<Parameters<typeof runDbExport>[0]>) => ({
    sandbox,
    relay: RELAY,
    ...extra,
  });
  const PREFIX = 'warehouse/ws-1';
  const PATH = '/warehouse/ws-1/conn/abc.parquet';

  it('mounts the workspace prefix and execs the runner with op export + DB_EXPORT_PATH', async () => {
    const fake = fakeSandbox({
      ready: ['up'],
      runnerStdout: JSON.stringify({ ok: true, rowCount: 42, bytes: 1234, durationMs: 8 }),
    });
    const result = await runDbExport(deps(fake.sandbox), REQUEST, PREFIX, PATH);

    expect(result).toEqual({ ok: true, rowCount: 42, bytes: 1234, durationMs: 8 });
    expect(fake.ensureWarehouseExportMount).toHaveBeenCalledWith(PREFIX);
    expect(fake.ensureRelayEgress).toHaveBeenCalledWith('db-relay.example.com');
    // Same single stateless exec as queries — no process, no files written by us.
    expect(fake.startProcess).not.toHaveBeenCalled();
    expect(fake.execCommands).toHaveLength(1);
    expect(fake.execCommands[0]).toContain('node --input-type=module');
    expect(fake.execEnvs[0]?.DB_EXPORT_PATH).toBe(PATH);
    expect(JSON.parse(fake.execEnvs[0]?.DB_QUERY_REQUEST ?? '{}')).toMatchObject({ op: 'export', engine: 'postgres' });
  });

  it('direct mode skips relay plumbing but still mounts', async () => {
    const fake = fakeSandbox({
      ready: ['up'],
      runnerStdout: JSON.stringify({ ok: true, rowCount: 0, bytes: 12, durationMs: 1 }),
    });
    const result = await runDbExport(deps(fake.sandbox, { relay: null }), REQUEST, PREFIX, PATH);
    expect(result.ok).toBe(true);
    expect(fake.ensureRelayEgress).not.toHaveBeenCalled();
    expect(fake.ensureWarehouseExportMount).toHaveBeenCalledWith(PREFIX);
    expect(fake.execEnvs[0]).not.toHaveProperty('DB_EGRESS_RELAY_SOCKS_USERNAME');
  });

  it('surfaces runner export errors as structured failures', async () => {
    const fake = fakeSandbox({
      ready: ['up'],
      runnerStdout: JSON.stringify({ ok: false, error: { message: 'Export timed out after 120000ms', status: 504, code: 'ETIMEOUT' } }),
    });
    const result = await runDbExport(deps(fake.sandbox), REQUEST, PREFIX, PATH);
    expect(result).toMatchObject({ ok: false, error: { status: 504, code: 'ETIMEOUT' } });
  });

  it('treats an ok result without rowCount/bytes as malformed', async () => {
    const fake = fakeSandbox({
      ready: ['up'],
      runnerStdout: JSON.stringify({ ok: true, rows: [], fields: [], rowCount: 0, truncated: false, durationMs: 1 }),
    });
    const result = await runDbExport(deps(fake.sandbox), REQUEST, PREFIX, PATH);
    expect(result).toMatchObject({ ok: false, error: { status: 502 } });
  });
});
