import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSandboxExecDeadline,
  isSandboxDeadlineExceededError,
  SandboxDeadlineExceededError,
  SANDBOX_EXEC_DEADLINE_GRACE_MS,
  type SandboxDeadlineExceededEvent,
} from '../src/sandbox-exec-deadline';
import {
  ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
  ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
} from '../src/analysis-service';
import {
  ANALYSIS_PROJECT_IO_OVERHEAD_MS,
  CodeModeToolsBinding,
  PROJECT_BUILD_IO_OVERHEAD_MS,
  PROJECT_BUILD_MAX_TIMEOUT_MS,
  ANALYSIS_PROJECT_IO_MAX_OVERHEAD_MS,
  analysisProjectIoOverheadMs,
} from '../src/code-mode-tools';
import { DEFAULT_BUILD_TIMEOUT_MS } from '../src/project-build-service';
import {
  projectBuildTransientCause,
  withProjectBuildServiceErrorMapping,
} from '../src/project-build-readiness';
import {
  DbQueryContainerNotReadyError,
  runDbExport,
  runDbQuery,
  type DbQueryDeps,
  type DbQueryRequest,
} from '../src/db-query-service';

afterEach(() => {
  vi.useRealTimers();
});

/** Deterministic timer + clock seam: no wall-clock waiting in these tests. */
function fakeClock() {
  let nowMs = 1_000;
  const pending: Array<{ atMs: number; resolve: () => void; cancelled: boolean }> = [];
  return {
    now: () => nowMs,
    timer: (ms: number) => {
      const entry = { atMs: nowMs + ms, resolve: () => {}, cancelled: false };
      const promise = new Promise<void>((resolve) => {
        entry.resolve = resolve;
      });
      pending.push(entry);
      return { promise, cancel: () => { entry.cancelled = true; } };
    },
    /** Advance the clock and fire every deadline that came due. */
    async advance(ms: number) {
      nowMs += ms;
      for (const entry of pending) {
        if (!entry.cancelled && entry.atMs <= nowMs) entry.resolve();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('createSandboxExecDeadline', () => {
  it('bounds the wait at the declared timeout plus overhead and grace, not at the tool ceiling', async () => {
    const clock = fakeClock();
    const events: SandboxDeadlineExceededEvent[] = [];
    const deadline = createSandboxExecDeadline({
      operation: 'analysis_exec',
      declaredTimeoutMs: 120_000,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      overheadMs: 30_000,
      now: clock.now,
      timer: clock.timer,
      onExceeded: (event) => events.push(event),
    });

    expect(deadline.budgetMs).toBe(120_000 + 30_000 + SANDBOX_EXEC_DEADLINE_GRACE_MS);

    // A command the container never answers for.
    const settled = vi.fn();
    const promise = deadline.run(() => new Promise<never>(() => {})).catch((error) => {
      settled(error);
      return error;
    });
    await clock.advance(deadline.budgetMs - 1);
    expect(settled).not.toHaveBeenCalled();

    await clock.advance(2);
    const error = await promise;
    expect(error).toBeInstanceOf(SandboxDeadlineExceededError);
    expect(isSandboxDeadlineExceededError(error)).toBe(true);
    expect(String(error.message)).toContain('analysis_exec');
    expect(String(error.message)).toContain('120000ms');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: 'analysis_exec',
      declaredTimeoutMs: 120_000,
      budgetMs: deadline.budgetMs,
    });
    expect(events[0].waitedMs).toBeGreaterThanOrEqual(deadline.budgetMs);
  });

  it('lets the container-enforced timeout win inside the grace window, error text intact', async () => {
    const clock = fakeClock();
    const onExceeded = vi.fn();
    const deadline = createSandboxExecDeadline({
      operation: 'analysis_exec',
      declaredTimeoutMs: 10_000,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
      onExceeded,
    });

    let rejectContainer: (error: Error) => void = () => {};
    const promise = deadline.run(() => new Promise<never>((_, reject) => {
      rejectContainer = reject;
    }));
    const assertion = expect(promise).rejects.toThrow(
      'Command timed out after 10000ms (exit code 124)',
    );
    // Container answers 3s late — inside the 15s grace.
    await clock.advance(13_000);
    rejectContainer(new Error('Command timed out after 10000ms (exit code 124)'));

    await assertion;
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it('clamps an agent-declared timeout to the op-class ceiling', () => {
    const deadline = createSandboxExecDeadline({
      operation: 'analysis_exec',
      declaredTimeoutMs: 999_999_999,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: () => 0,
    });
    expect(deadline.budgetMs).toBe(
      ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS + SANDBOX_EXEC_DEADLINE_GRACE_MS,
    );
  });

  it('falls back to the op-class default when nothing was declared', () => {
    const deadline = createSandboxExecDeadline({
      operation: 'run_code',
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: () => 0,
    });
    expect(deadline.budgetMs).toBe(
      ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS + SANDBOX_EXEC_DEADLINE_GRACE_MS,
    );
  });

  it('shares ONE budget across a retry ladder instead of multiplying it', async () => {
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: 'deploy_project',
      declaredTimeoutMs: 20_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
    });

    const first = deadline.run(() => new Promise<never>(() => {})).catch((error) => error);
    await clock.advance(deadline.budgetMs + 1);
    expect(await first).toBeInstanceOf(SandboxDeadlineExceededError);

    // Attempt 2 gets what is left of the SAME budget — here, nothing.
    const second = deadline.run(() => new Promise<never>(() => {})).catch((error) => error);
    await clock.advance(2);
    expect(await second).toBeInstanceOf(SandboxDeadlineExceededError);
  });

  it('refuses to DISPATCH once the budget is gone, instead of starting work it abandons', async () => {
    // The ladder's real hazard: `run` used to floor the slice at 1ms and still
    // invoke `fn`, so every rung started a fresh `bun install && bun run build`
    // into the SAME per-project workdir and walked away from it a millisecond
    // later — with no cancellation surface to stop any of them.
    const clock = fakeClock();
    const onExceeded = vi.fn();
    const fn = vi.fn(() => new Promise<never>(() => {}));
    const deadline = createSandboxExecDeadline({
      operation: 'deploy_project',
      declaredTimeoutMs: 20_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
      onExceeded,
    });

    const first = deadline.run(fn).catch((error) => error);
    await clock.advance(deadline.budgetMs + 1);
    expect(await first).toBeInstanceOf(SandboxDeadlineExceededError);
    expect(deadline.exhausted).toBe(true);

    // Four more rungs of the ladder, all refused.
    for (let rung = 0; rung < 4; rung += 1) {
      const error = await deadline.run(fn).catch((e) => e);
      expect(error).toBeInstanceOf(SandboxDeadlineExceededError);
      expect((error as SandboxDeadlineExceededError).started).toBe(false);
      expect(String(error.message)).toContain('was NOT started');
    }
    expect(fn).toHaveBeenCalledTimes(1);
    // One deadline, one telemetry event: retries must not multiply the metric.
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it('does not charge cold-boot waiting or backoff sleeps to the command budget', async () => {
    // A transient mid-build + a slow container reboot used to leave attempt 2 a
    // ~1ms slice of the SAME absolute budget, hard-failing a recoverable build.
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: 'deploy_project',
      declaredTimeoutMs: 120_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      overheadMs: PROJECT_BUILD_IO_OVERHEAD_MS,
      now: clock.now,
      timer: clock.timer,
    });

    // Attempt 1 fails transiently 5s in.
    const first = deadline.run(async () => {
      await clock.advance(5_000);
      throw new Error('RPCTransportError: Network connection lost');
    }).catch((error) => error);
    await clock.advance(0);
    expect(await first).toBeInstanceOf(Error);
    expect(deadline.remainingMs).toBe(deadline.budgetMs - 5_000);

    // 60s of container reboot + a 1s backoff sleep, both OUTSIDE the budget.
    await deadline.excluding(async () => { await clock.advance(60_000); });
    await deadline.excluding(async () => { await clock.advance(1_000); });

    // Attempt 2 still has a full command budget, not 190s and certainly not 1ms.
    expect(deadline.remainingMs).toBe(deadline.budgetMs - 5_000);
    expect(deadline.remainingMs).toBeGreaterThan(120_000);
    expect(deadline.exhausted).toBe(false);
    const ran = vi.fn(async () => 'built');
    await expect(deadline.run(ran)).resolves.toBe('built');
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('warns that an abandoned command may already have run', () => {
    // There is no cancellation surface, so a deadline fired around a dispatched
    // command must not read like "nothing happened" — a blind retry of a
    // non-idempotent command is the failure mode.
    const started = new SandboxDeadlineExceededError({
      operation: 'analysis_exec',
      declaredTimeoutMs: 120_000,
      budgetMs: 255_000,
      waitedMs: 255_000,
    });
    expect(started.started).toBe(true);
    expect(started.message).toMatch(/may already have run to completion/);
    expect(started.message).toMatch(/safe to run twice/);
  });

  it('keeps a late rejection of the abandoned work observed', async () => {
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: 'analysis_exec',
      declaredTimeoutMs: 1_000,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
    });

    let rejectLate: (error: Error) => void = () => {};
    const promise = deadline.run(() => new Promise<never>((_, reject) => {
      rejectLate = reject;
    })).catch((error) => error);
    await clock.advance(deadline.budgetMs + 1);
    expect(await promise).toBeInstanceOf(SandboxDeadlineExceededError);

    // The orphan rejecting afterwards must not surface as an unhandled
    // rejection (vitest strict mode would fail the run).
    rejectLate(new Error('container answered after we gave up'));
    await Promise.resolve();
  });

  it('is treated as transient by the build-service mapping', () => {
    const error = new SandboxDeadlineExceededError({
      operation: 'deploy_project',
      declaredTimeoutMs: undefined,
      budgetMs: 1,
      waitedMs: 1,
    });
    expect(projectBuildTransientCause(error)).toBe('exec_deadline_exceeded');
  });
});

/** Minimal CodeModeToolsBinding fake: only the analysis binding seam is stubbed. */
function analysisToolFake(binding: Record<string, unknown>) {
  const events: Array<Record<string, unknown>> = [];
  const fake = Object.create(CodeModeToolsBinding.prototype) as any;
  fake.ctx = {
    props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1', userId: 'user1' },
  };
  fake.env = {
    OBSERVABILITY_EVENTS: {
      writeDataPoint: (point: Record<string, unknown>) => events.push(point),
    },
  };
  fake.analysisServiceBinding = () => binding;
  return { fake, events };
}

describe('analysis tools under a client-side deadline', () => {
  it('abandons a hung analysis_exec at its declared budget, not at the 20-minute ceiling', async () => {
    vi.useFakeTimers();
    // The container took the command and never answered — the prod shape.
    const { fake, events } = analysisToolFake({
      exec: () => new Promise<never>(() => {}),
    });

    const promise = CodeModeToolsBinding.prototype.callTool.call(fake, 'analysis_exec', {
      command: 'python long_job.py',
      timeoutMs: 120_000,
    });
    const assertion = expect(promise).rejects.toThrow(/analysis_exec did not return within/);

    const budgetMs = 120_000 + ANALYSIS_PROJECT_IO_OVERHEAD_MS + SANDBOX_EXEC_DEADLINE_GRACE_MS;
    // Well inside the 20-minute PI_TURN_TOOL_HARD_TIMEOUT backstop.
    expect(budgetMs).toBeLessThan(20 * 60_000);
    await vi.advanceTimersByTimeAsync(budgetMs + 10);
    await assertion;

    const deadlineEvent = events.find((point) =>
      (point.blobs as string[])[0] === 'sandbox_exec_deadline_exceeded');
    expect(deadlineEvent).toBeDefined();
    expect((deadlineEvent!.blobs as string[])[3]).toBe('analysis_exec');
    expect((deadlineEvent!.blobs as string[])[4]).toBe('deadline_exceeded');
  });

  it('keeps a container-side timeout error verbatim', async () => {
    vi.useFakeTimers();
    const { fake, events } = analysisToolFake({
      exec: async () => ({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: 124,
        error: 'Command timed out after 120000ms',
        changedFiles: [],
        removedFiles: [],
        skippedOversize: [],
        durationMs: 120_001,
      }),
    });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'analysis_exec', {
      command: 'python long_job.py',
      timeoutMs: 120_000,
    }) as Record<string, unknown>;

    expect(result.error).toBe('Command timed out after 120000ms');
    expect(result.exitCode).toBe(124);
    expect(events.some((point) =>
      (point.blobs as string[])[0] === 'sandbox_exec_deadline_exceeded')).toBe(false);
  });

  it('sizes the project IO allowance to the tree, not to a fixed constant', () => {
    // materialize + persist is one sequential RPC round trip PER FILE plus the
    // bytes themselves, so a fixed 120s let the deadline fire AFTER a
    // successful command on a big tree — and the error invited a re-run of a
    // command that had already applied its side effects.
    const smallProject = analysisProjectIoOverheadMs({ fileCount: 12, totalBytes: 200_000 });
    expect(smallProject).toBeGreaterThanOrEqual(ANALYSIS_PROJECT_IO_OVERHEAD_MS);
    expect(smallProject).toBeLessThan(ANALYSIS_PROJECT_IO_OVERHEAD_MS + 5_000);

    // ~1000 small files: the file-count route the fixed constant missed.
    const manyFiles = analysisProjectIoOverheadMs({ fileCount: 1_000, totalBytes: 5 * 1024 * 1024 });
    expect(manyFiles).toBeGreaterThan(ANALYSIS_PROJECT_IO_OVERHEAD_MS + 100_000);

    // A few GB of parquet: the byte route, reachable with a handful of files.
    const bigBytes = analysisProjectIoOverheadMs({ fileCount: 4, totalBytes: 3 * 1024 * 1024 * 1024 });
    expect(bigBytes).toBeGreaterThan(ANALYSIS_PROJECT_IO_OVERHEAD_MS + 100_000);

    // Always capped well inside the 20-minute tool backstop.
    expect(analysisProjectIoOverheadMs({ fileCount: 50_000, totalBytes: 100 * 1024 * 1024 * 1024 }))
      .toBe(ANALYSIS_PROJECT_IO_MAX_OVERHEAD_MS);
    expect(ANALYSIS_PROJECT_IO_MAX_OVERHEAD_MS).toBeLessThan(20 * 60_000);
  });

  it('does not cut a long legitimate build short at a smaller analysis default', () => {
    // Regression guard for the plan's "do not regress long-legitimate tools":
    // builds run minutes, and their op-class budget must dominate the analysis
    // exec default rather than inheriting it.
    const buildBudgetMs =
      DEFAULT_BUILD_TIMEOUT_MS + PROJECT_BUILD_IO_OVERHEAD_MS + SANDBOX_EXEC_DEADLINE_GRACE_MS;
    expect(buildBudgetMs).toBeGreaterThan(DEFAULT_BUILD_TIMEOUT_MS);
    expect(PROJECT_BUILD_MAX_TIMEOUT_MS).toBeGreaterThan(DEFAULT_BUILD_TIMEOUT_MS);
    // An agent asking for a 9-minute build gets a 9-minute budget, not 300s.
    const declaredMs = 9 * 60_000;
    expect(Math.min(declaredMs, PROJECT_BUILD_MAX_TIMEOUT_MS)).toBe(declaredMs);
  });
});


const RUNNER_OK = {
  stdout: JSON.stringify({
    ok: true,
    rows: [{ ok: 1 }],
    fields: [{ name: 'ok' }],
    rowCount: 1,
    truncated: false,
    durationMs: 1,
  }),
  stderr: '',
  exitCode: 0,
  timedOut: false,
};

function dbContainer(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => {}),
    startRelayForwarder: vi.fn(async () => {}),
    relayForwarderReady: vi.fn(async () => true),
    runRunner: vi.fn(async () => RUNNER_OK),
    prepareWarehouseExport: vi.fn(async () => {}),
    publishWarehouseExport: vi.fn(async () => {}),
    destroy: vi.fn(async () => ({ destroyed: true })),
    ...overrides,
  };
}

describe('db-query under a client-side deadline', () => {
  it('starts a cold container before starting the short query setup deadline', async () => {
    let releaseStart!: () => void;
    const order: string[] = [];
    const container = dbContainer({
      start: vi.fn(() => new Promise<void>((resolve) => {
        order.push('start-begin');
        releaseStart = () => {
          order.push('start-end');
          resolve();
        };
      })),
      runRunner: vi.fn(async () => {
        order.push('runner');
        return RUNNER_OK;
      }),
    });
    const deps = { relay: null, container } as unknown as DbQueryDeps;

    const running = runDbQuery(deps, { engine: 'postgres', sql: 'select 1 as ok' } as DbQueryRequest);
    await vi.waitFor(() => expect(container.start).toHaveBeenCalledTimes(1));
    expect(container.runRunner).not.toHaveBeenCalled();
    releaseStart();
    await expect(running).resolves.toMatchObject({ ok: true, rowCount: 1 });
    expect(order).toEqual(['start-begin', 'start-end', 'runner']);
  });

  it('stops waiting on a container that never answers the runner', async () => {
    vi.useFakeTimers();
    const onDeadlineExceeded = vi.fn();
    const deps = {
      relay: null,
      onDeadlineExceeded,
      container: dbContainer({ runRunner: vi.fn(() => new Promise<never>(() => {})) }),
    } as unknown as DbQueryDeps;

    const promise = runDbQuery(deps, {
      engine: 'postgres',
      timeoutMs: 30_000,
    } as unknown as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(/db_query did not return within/);
    // 30s query + 15s runner overhead + 15s marshalling grace.
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;

    expect(onDeadlineExceeded).toHaveBeenCalledTimes(1);
    expect(onDeadlineExceeded.mock.calls[0][0]).toMatchObject({
      operation: 'db_query',
      budgetMs: 60_000,
    });
  });

  it('stops waiting on a relay readiness probe that never answers', async () => {
    // Deployed environments configure a relay, so every real query runs the
    // forwarder prelude BEFORE the runner. A probe that never answers must not
    // hold the caller until its own ceiling.
    vi.useFakeTimers();
    const onDeadlineExceeded = vi.fn();
    const deps = {
      relay: { hostname: 'db-relay.example.dev', socksUsername: 'u', socksPassword: 'p' },
      readinessTimeoutMs: 30_000,
      onDeadlineExceeded,
      container: dbContainer({ relayForwarderReady: vi.fn(() => new Promise<never>(() => {})) }),
    } as unknown as DbQueryDeps;

    const promise = runDbQuery(deps, { engine: 'postgres', sql: 'select 1' } as unknown as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(/db_query_setup did not return within/);
    // 30s readiness + 15s grace — not the caller's 20-minute ceiling.
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;

    expect(onDeadlineExceeded).toHaveBeenCalledTimes(1);
    expect(onDeadlineExceeded.mock.calls[0][0]).toMatchObject({ operation: 'db_query_setup' });
  });

  it('keeps the readiness diagnostic when probes DO answer but stay down', async () => {
    vi.useFakeTimers();
    const deps = {
      relay: { hostname: 'db-relay.example.dev', socksUsername: 'u', socksPassword: 'p' },
      readinessTimeoutMs: 30_000,
      container: dbContainer({ relayForwarderReady: vi.fn(async () => false) }),
    } as unknown as DbQueryDeps;

    const promise = runDbQuery(deps, { engine: 'postgres', sql: 'select 1' } as unknown as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(/forwarder never became ready/);
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });
});

describe('db-query wedged-container recovery', () => {
  const RELAY = { hostname: 'db-relay.example.dev', socksUsername: 'u', socksPassword: 'p' };

  function wedgeDeps(overrides: Record<string, unknown>) {
    const container = dbContainer(overrides);
    return {
      relay: RELAY,
      readinessTimeoutMs: 30_000,
      onDeadlineExceeded: vi.fn(),
      container,
    } as unknown as DbQueryDeps & { container: ReturnType<typeof dbContainer> };
  }

  it('destroys the container when startup never returns, and still fails this call', async () => {
    // The 0.12 prod incident: every query for four days died at the start
    // budget and the container never recovered on its own.
    vi.useFakeTimers();
    const deps = wedgeDeps({ start: vi.fn(() => new Promise<never>(() => {})) });

    const promise = runDbQuery(deps, { engine: 'postgres', sql: 'select 1' } as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(/db_query_container_start did not return within/);
    // 120s startup ceiling + 15s grace.
    await vi.advanceTimersByTimeAsync(135_001);
    await assertion;

    expect(deps.container.destroy).toHaveBeenCalledTimes(1);
    expect(deps.container.destroy.mock.calls[0][0]).toMatchObject({
      operation: 'db_query_container_start',
      error: expect.stringContaining('SandboxDeadlineExceededError'),
    });
    // No in-call retry: the fresh container is for the next call.
    expect(deps.container.start).toHaveBeenCalledTimes(1);
    expect(deps.container.runRunner).not.toHaveBeenCalled();
  });

  it('destroys the container when the export setup prelude never answers', async () => {
    vi.useFakeTimers();
    const deps = wedgeDeps({ relayForwarderReady: vi.fn(() => new Promise<never>(() => {})) });

    const promise = runDbExport(
      deps,
      { engine: 'postgres', sql: 'select 1' } as DbQueryRequest,
      'warehouse/ws-1',
      '/warehouse/ws-1/x.parquet',
    );
    const assertion = expect(promise).rejects.toThrow(/db_export_setup did not return within/);
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;

    expect(deps.container.destroy.mock.calls[0][0]).toMatchObject({ operation: 'db_export_setup' });
    expect(deps.container.prepareWarehouseExport).not.toHaveBeenCalled();
  });

  it('never destroys the container for a slow QUERY or a relay that answers "down"', async () => {
    vi.useFakeTimers();
    const slowQuery = wedgeDeps({ runRunner: vi.fn(() => new Promise<never>(() => {})) });
    const queryPromise = runDbQuery(slowQuery, {
      engine: 'postgres',
      sql: 'select pg_sleep(600)',
      timeoutMs: 30_000,
    } as DbQueryRequest);
    const queryAssertion = expect(queryPromise).rejects.toThrow(/db_query did not return within/);
    await vi.advanceTimersByTimeAsync(60_001);
    await queryAssertion;
    expect(slowQuery.container.destroy).not.toHaveBeenCalled();

    const relayDown = wedgeDeps({ relayForwarderReady: vi.fn(async () => false) });
    const relayPromise = runDbQuery(relayDown, { engine: 'postgres', sql: 'select 1' } as DbQueryRequest);
    const relayAssertion = expect(relayPromise).rejects.toThrow(/forwarder never became ready/);
    await vi.advanceTimersByTimeAsync(31_000);
    await relayAssertion;
    expect(relayDown.container.destroy).not.toHaveBeenCalled();
  });

  it('tells the agent nothing ran and a retry is safe after a setup deadline', async () => {
    vi.useFakeTimers();
    const deps = wedgeDeps({ relayForwarderReady: vi.fn(() => new Promise<never>(() => {})) });

    const promise = runDbQuery(deps, { engine: 'postgres', sql: 'select 1' } as DbQueryRequest)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(45_001);
    const error = await promise;

    expect(error).toBeInstanceOf(DbQueryContainerNotReadyError);
    expect((error as Error).message).toMatch(/query was NOT sent to the database/);
    expect((error as Error).message).toMatch(/restarted; retrying the same query is safe/);
    // The generic "may already have run, do NOT repeat" advice is wrong here.
    expect((error as Error).message).not.toMatch(/do NOT simply repeat/);
    expect((error as Error).cause).toBeInstanceOf(SandboxDeadlineExceededError);
  });

  it('surfaces the original deadline error when the destroy request itself fails', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = wedgeDeps({
        start: vi.fn(() => new Promise<never>(() => {})),
        destroy: vi.fn(async () => {
          throw new Error('DO unreachable');
        }),
      });

      const promise = runDbQuery(deps, { engine: 'postgres', sql: 'select 1' } as DbQueryRequest);
      const assertion = expect(promise).rejects.toMatchObject({
        name: 'DbQueryContainerNotReadyError',
        cause: expect.any(SandboxDeadlineExceededError),
      });
      await vi.advanceTimersByTimeAsync(135_001);
      await assertion;
      expect(deps.container.destroy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});


describe('the project-build retry ladder and a spent exec budget', () => {
  it('stops on the first deadline exceedance instead of stacking builds in one workdir', async () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: 'deploy_project',
      declaredTimeoutMs: 20_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
    });
    const build = vi.fn(() => new Promise<never>(() => {}));
    const onTransient = vi.fn();

    const running = withProjectBuildServiceErrorMapping(
      'deploy_project',
      () => deadline.run(build),
      { onTransient, deadline, unavailableMessage: () => 'temporarily unavailable' },
    ).catch((error) => error as Error);

    await clock.advance(deadline.budgetMs + 1);
    const error = await running;

    // The ladder surfaces the deadline's own message (not "try again in a
    // moment") and never re-enters the build.
    expect(isSandboxDeadlineExceededError(error)).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(onTransient).not.toHaveBeenCalled();
  });

  it('still retries an ordinary transient while budget remains', async () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: 'deploy_project',
      declaredTimeoutMs: 120_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      overheadMs: PROJECT_BUILD_IO_OVERHEAD_MS,
      now: clock.now,
      timer: clock.timer,
    });
    let attempts = 0;
    const running = withProjectBuildServiceErrorMapping('deploy_project', () => deadline.run(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('RPCTransportError: Network connection lost');
      return 'built';
    }), { deadline });

    // Only the ladder's own backoff sleep is on real (faked) timers.
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(running).resolves.toBe('built');
    expect(attempts).toBe(2);
    // The backoff was charged OUTSIDE the exec budget.
    expect(deadline.exhausted).toBe(false);
  });
});
