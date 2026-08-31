import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxExecDeadline,
  isSandboxDeadlineExceededError,
  SandboxDeadlineExceededError,
  SANDBOX_EXEC_DEADLINE_GRACE_MS,
  type SandboxDeadlineExceededEvent,
} from "../src/sandbox-exec-deadline";
import {
  ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
  ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
  ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS,
} from "../src/analysis-service";
import {
  ANALYSIS_PROJECT_IO_OVERHEAD_MS,
  CodeModeToolsBinding,
  PROJECT_BUILD_IO_OVERHEAD_MS,
  PROJECT_BUILD_MAX_TIMEOUT_MS,
} from "../src/code-mode-tools";
import { DEFAULT_BUILD_TIMEOUT_MS } from "../src/project-build-service";
import {
  projectBuildTransientCause,
  withProjectBuildServiceErrorMapping,
} from "../src/project-build-readiness";
import {
  runDbQuery,
  type DbQueryDeps,
  type DbQueryRequest,
} from "../src/db-query-service";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";

afterEach(() => {
  vi.useRealTimers();
});

/** Deterministic timer + clock seam: no wall-clock waiting in these tests. */
function fakeClock() {
  let nowMs = 1_000;
  const pending: Array<{
    atMs: number;
    resolve: () => void;
    cancelled: boolean;
  }> = [];
  return {
    now: () => nowMs,
    timer: (ms: number) => {
      const entry = { atMs: nowMs + ms, resolve: () => {}, cancelled: false };
      const promise = new Promise<void>((resolve) => {
        entry.resolve = resolve;
      });
      pending.push(entry);
      return {
        promise,
        cancel: () => {
          entry.cancelled = true;
        },
      };
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

describe("createSandboxExecDeadline", () => {
  it("bounds the wait at the declared timeout plus overhead and grace, not at the tool ceiling", async () => {
    const clock = fakeClock();
    const events: SandboxDeadlineExceededEvent[] = [];
    const deadline = createSandboxExecDeadline({
      operation: "analysis_exec",
      declaredTimeoutMs: 120_000,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      overheadMs: 30_000,
      now: clock.now,
      timer: clock.timer,
      onExceeded: (event) => events.push(event),
    });

    expect(deadline.budgetMs).toBe(
      120_000 + 30_000 + SANDBOX_EXEC_DEADLINE_GRACE_MS,
    );

    // A command the container never answers for.
    const settled = vi.fn();
    const promise = deadline
      .run(() => new Promise<never>(() => {}))
      .catch((error) => {
        settled(error);
        return error;
      });
    await clock.advance(deadline.budgetMs - 1);
    expect(settled).not.toHaveBeenCalled();

    await clock.advance(2);
    const error = await promise;
    expect(error).toBeInstanceOf(SandboxDeadlineExceededError);
    expect(isSandboxDeadlineExceededError(error)).toBe(true);
    expect(String(error.message)).toContain("analysis_exec");
    expect(String(error.message)).toContain("120000ms");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "analysis_exec",
      declaredTimeoutMs: 120_000,
      budgetMs: deadline.budgetMs,
    });
    expect(events[0].waitedMs).toBeGreaterThanOrEqual(deadline.budgetMs);
  });

  it("lets the container-enforced timeout win inside the grace window, error text intact", async () => {
    const clock = fakeClock();
    const onExceeded = vi.fn();
    const deadline = createSandboxExecDeadline({
      operation: "analysis_exec",
      declaredTimeoutMs: 10_000,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
      onExceeded,
    });

    let rejectContainer: (error: Error) => void = () => {};
    const promise = deadline.run(
      () =>
        new Promise<never>((_, reject) => {
          rejectContainer = reject;
        }),
    );
    const assertion = expect(promise).rejects.toThrow(
      "Command timed out after 10000ms (exit code 124)",
    );
    // Container answers 3s late — inside the 15s grace.
    await clock.advance(13_000);
    rejectContainer(
      new Error("Command timed out after 10000ms (exit code 124)"),
    );

    await assertion;
    expect(onExceeded).not.toHaveBeenCalled();
  });

  it("clamps an agent-declared timeout to the op-class ceiling", () => {
    const deadline = createSandboxExecDeadline({
      operation: "analysis_exec",
      declaredTimeoutMs: 999_999_999,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: () => 0,
    });
    expect(deadline.budgetMs).toBe(
      ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS + SANDBOX_EXEC_DEADLINE_GRACE_MS,
    );
  });

  it("keeps the maximum notebook wait inside the outer tool deadline", () => {
    const maximumWait =
      ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS +
      ANALYSIS_PROJECT_IO_OVERHEAD_MS +
      ANALYSIS_NOTEBOOK_VALIDATE_TIMEOUT_MS +
      SANDBOX_EXEC_DEADLINE_GRACE_MS;
    expect(maximumWait).toBeLessThan(CHAT_RUNTIME_BOUNDS.toolDeadlineMs);
  });

  it("falls back to the op-class default when nothing was declared", () => {
    const deadline = createSandboxExecDeadline({
      operation: "run_code",
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: () => 0,
    });
    expect(deadline.budgetMs).toBe(
      ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS + SANDBOX_EXEC_DEADLINE_GRACE_MS,
    );
  });

  it("shares ONE budget across a retry ladder instead of multiplying it", async () => {
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: "deploy_project",
      declaredTimeoutMs: 20_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
    });

    const first = deadline
      .run(() => new Promise<never>(() => {}))
      .catch((error) => error);
    await clock.advance(deadline.budgetMs + 1);
    expect(await first).toBeInstanceOf(SandboxDeadlineExceededError);

    // Attempt 2 gets what is left of the SAME budget — here, nothing.
    const second = deadline
      .run(() => new Promise<never>(() => {}))
      .catch((error) => error);
    await clock.advance(2);
    expect(await second).toBeInstanceOf(SandboxDeadlineExceededError);
  });

  it("refuses to DISPATCH once the budget is gone, instead of starting work it abandons", async () => {
    // The ladder's real hazard: `run` used to floor the slice at 1ms and still
    // invoke `fn`, so every rung started a fresh `bun install && bun run build`
    // into the SAME per-project workdir and walked away from it a millisecond
    // later — with no cancellation surface to stop any of them.
    const clock = fakeClock();
    const onExceeded = vi.fn();
    const fn = vi.fn(() => new Promise<never>(() => {}));
    const deadline = createSandboxExecDeadline({
      operation: "deploy_project",
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
      expect(String(error.message)).toContain("was NOT started");
    }
    expect(fn).toHaveBeenCalledTimes(1);
    // One deadline, one telemetry event: retries must not multiply the metric.
    expect(onExceeded).toHaveBeenCalledTimes(1);
  });

  it("does not charge cold-boot waiting or backoff sleeps to the command budget", async () => {
    // A transient mid-build + a slow container reboot used to leave attempt 2 a
    // ~1ms slice of the SAME absolute budget, hard-failing a recoverable build.
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: "deploy_project",
      declaredTimeoutMs: 120_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      overheadMs: PROJECT_BUILD_IO_OVERHEAD_MS,
      now: clock.now,
      timer: clock.timer,
    });

    // Attempt 1 fails transiently 5s in.
    const first = deadline
      .run(async () => {
        await clock.advance(5_000);
        throw new Error("RPCTransportError: Network connection lost");
      })
      .catch((error) => error);
    await clock.advance(0);
    expect(await first).toBeInstanceOf(Error);
    expect(deadline.remainingMs).toBe(deadline.budgetMs - 5_000);

    // 60s of container reboot + a 1s backoff sleep, both OUTSIDE the budget.
    await deadline.excluding(async () => {
      await clock.advance(60_000);
    });
    await deadline.excluding(async () => {
      await clock.advance(1_000);
    });

    // Attempt 2 still has a full command budget, not 190s and certainly not 1ms.
    expect(deadline.remainingMs).toBe(deadline.budgetMs - 5_000);
    expect(deadline.remainingMs).toBeGreaterThan(120_000);
    expect(deadline.exhausted).toBe(false);
    const ran = vi.fn(async () => "built");
    await expect(deadline.run(ran)).resolves.toBe("built");
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("warns that an abandoned command may already have run", () => {
    // There is no cancellation surface, so a deadline fired around a dispatched
    // command must not read like "nothing happened" — a blind retry of a
    // non-idempotent command is the failure mode.
    const started = new SandboxDeadlineExceededError({
      operation: "analysis_exec",
      declaredTimeoutMs: 120_000,
      budgetMs: 255_000,
      waitedMs: 255_000,
    });
    expect(started.started).toBe(true);
    expect(started.message).toMatch(/may already have run to completion/);
    expect(started.message).toMatch(/safe to run twice/);
  });

  it("keeps a late rejection of the abandoned work observed", async () => {
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: "analysis_exec",
      declaredTimeoutMs: 1_000,
      defaultTimeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
      maxTimeoutMs: ANALYSIS_MAX_NOTEBOOK_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
    });

    let rejectLate: (error: Error) => void = () => {};
    const promise = deadline
      .run(
        () =>
          new Promise<never>((_, reject) => {
            rejectLate = reject;
          }),
      )
      .catch((error) => error);
    await clock.advance(deadline.budgetMs + 1);
    expect(await promise).toBeInstanceOf(SandboxDeadlineExceededError);

    // The orphan rejecting afterwards must not surface as an unhandled
    // rejection (vitest strict mode would fail the run).
    rejectLate(new Error("container answered after we gave up"));
    await Promise.resolve();
  });

  it("is treated as transient by the build-service mapping", () => {
    const error = new SandboxDeadlineExceededError({
      operation: "deploy_project",
      declaredTimeoutMs: undefined,
      budgetMs: 1,
      waitedMs: 1,
    });
    expect(projectBuildTransientCause(error)).toBe("exec_deadline_exceeded");
  });
});

/** Minimal CodeModeToolsBinding fake: only the analysis binding seam is stubbed. */
function analysisToolFake(binding: Record<string, unknown>) {
  const events: Array<Record<string, unknown>> = [];
  const fake = Object.create(CodeModeToolsBinding.prototype) as any;
  fake.ctx = {
    props: {
      orgId: "org1",
      workspaceId: "workspace1",
      threadId: "thread1",
      userId: "user1",
    },
  };
  fake.env = {
    OBSERVABILITY_EVENTS: {
      writeDataPoint: (point: Record<string, unknown>) => events.push(point),
    },
  };
  fake.analysisServiceBinding = () => binding;
  return { fake, events };
}

describe("analysis tools under a client-side deadline", () => {
  it("abandons a hung analysis_exec before the outer tool deadline", async () => {
    vi.useFakeTimers();
    // The container took the command and never answered — the prod shape.
    const { fake, events } = analysisToolFake({
      exec: () => new Promise<never>(() => {}),
    });

    const promise = CodeModeToolsBinding.prototype.callTool.call(
      fake,
      "analysis_exec",
      {
        command: "python long_job.py",
        timeoutMs: 120_000,
      },
    );
    const assertion = expect(promise).rejects.toThrow(
      /analysis_exec did not return within/,
    );

    const budgetMs =
      120_000 +
      ANALYSIS_PROJECT_IO_OVERHEAD_MS +
      SANDBOX_EXEC_DEADLINE_GRACE_MS;
    expect(budgetMs).toBeLessThan(CHAT_RUNTIME_BOUNDS.toolDeadlineMs);
    await vi.advanceTimersByTimeAsync(budgetMs + 10);
    await assertion;

    const deadlineEvent = events.find(
      (point) =>
        (point.blobs as string[])[0] === "sandbox_exec_deadline_exceeded",
    );
    expect(deadlineEvent).toBeDefined();
    expect((deadlineEvent!.blobs as string[])[3]).toBe("analysis_exec");
    expect((deadlineEvent!.blobs as string[])[4]).toBe("deadline_exceeded");
  });

  it("keeps a container-side timeout error verbatim", async () => {
    vi.useFakeTimers();
    const { fake, events } = analysisToolFake({
      exec: async () => ({
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: 124,
        error: "Command timed out after 120000ms",
        changedFiles: [],
        removedFiles: [],
        skippedOversize: [],
        durationMs: 120_001,
      }),
    });

    const result = (await CodeModeToolsBinding.prototype.callTool.call(
      fake,
      "analysis_exec",
      {
        command: "python long_job.py",
        timeoutMs: 120_000,
      },
    )) as Record<string, unknown>;

    expect(result.error).toBe("Command timed out after 120000ms");
    expect(result.exitCode).toBe(124);
    expect(
      events.some(
        (point) =>
          (point.blobs as string[])[0] === "sandbox_exec_deadline_exceeded",
      ),
    ).toBe(false);
  });

  it("does not cut a long legitimate build short at a smaller analysis default", () => {
    // Regression guard for the plan's "do not regress long-legitimate tools":
    // builds run minutes, and their op-class budget must dominate the analysis
    // exec default rather than inheriting it.
    const buildBudgetMs =
      DEFAULT_BUILD_TIMEOUT_MS +
      PROJECT_BUILD_IO_OVERHEAD_MS +
      SANDBOX_EXEC_DEADLINE_GRACE_MS;
    expect(buildBudgetMs).toBeGreaterThan(DEFAULT_BUILD_TIMEOUT_MS);
    expect(PROJECT_BUILD_MAX_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_BUILD_TIMEOUT_MS,
    );
    // An agent asking for a 9-minute build gets a 9-minute budget, not 300s.
    const declaredMs = 9 * 60_000;
    expect(Math.min(declaredMs, PROJECT_BUILD_MAX_TIMEOUT_MS)).toBe(declaredMs);
  });
});

describe("db-query under a client-side deadline", () => {
  it("warms a cold sandbox before starting the short query setup deadline", async () => {
    let releaseReady!: () => void;
    const order: string[] = [];
    const deps = {
      relay: null,
      sandbox: {
        ensureReady: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              order.push("ready-start");
              releaseReady = () => {
                order.push("ready-end");
                resolve();
              };
            }),
        ),
        ensureRelayEgress: vi.fn(async () => {}),
        ensureWarehouseExportMount: vi.fn(async () => {}),
        startProcess: vi.fn(async () => ({})),
        exec: vi.fn(async () => {
          order.push("exec");
          return {
            stdout: JSON.stringify({
              ok: true,
              rows: [{ ok: 1 }],
              fields: [{ name: "ok" }],
              rowCount: 1,
              truncated: false,
              durationMs: 1,
            }),
            stderr: "",
            exitCode: 0,
          };
        }),
      },
    } as unknown as DbQueryDeps;

    const running = runDbQuery(deps, {
      engine: "postgres",
      sql: "select 1 as ok",
    });
    await vi.waitFor(() =>
      expect(deps.sandbox.ensureReady).toHaveBeenCalledTimes(1),
    );
    expect(deps.sandbox.exec).not.toHaveBeenCalled();
    releaseReady();
    await expect(running).resolves.toMatchObject({ ok: true, rowCount: 1 });
    expect(order).toEqual(["ready-start", "ready-end", "exec"]);
  });

  it("does not charge slow relay egress configuration to the short readiness budget", async () => {
    vi.useFakeTimers();
    let releaseRelayEgress!: () => void;
    const order: string[] = [];
    const deps = {
      relay: {
        hostname: "db-relay.example.dev",
        socksUsername: "u",
        socksPassword: "p",
      },
      sandbox: {
        ensureReady: vi.fn(async () => {
          order.push("ready");
        }),
        ensureRelayEgress: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              order.push("egress-start");
              releaseRelayEgress = () => {
                order.push("egress-end");
                resolve();
              };
            }),
        ),
        ensureWarehouseExportMount: vi.fn(async () => {}),
        startProcess: vi.fn(async () => ({})),
        exec: vi.fn(async () => {
          if (!order.includes("probe")) {
            order.push("probe");
            return { stdout: "up", stderr: "", exitCode: 0 };
          }
          order.push("query");
          return {
            stdout: JSON.stringify({
              ok: true,
              rows: [{ ok: 1 }],
              fields: [{ name: "ok" }],
              rowCount: 1,
              truncated: false,
              durationMs: 1,
            }),
            stderr: "",
            exitCode: 0,
          };
        }),
      },
    } as unknown as DbQueryDeps;

    const running = runDbQuery(deps, {
      engine: "postgres",
      sql: "select 1 as ok",
    });
    await vi.waitFor(() =>
      expect(deps.sandbox.ensureRelayEgress).toHaveBeenCalledTimes(1),
    );
    // Longer than the 30s readiness + 15s grace that used to abandon this
    // control-plane call even though the container was still progressing.
    await vi.advanceTimersByTimeAsync(60_000);
    releaseRelayEgress();
    await expect(running).resolves.toMatchObject({ ok: true, rowCount: 1 });
    expect(order).toEqual([
      "ready",
      "egress-start",
      "egress-end",
      "probe",
      "query",
    ]);
  });

  it("stops waiting on a container that never answers the runner", async () => {
    vi.useFakeTimers();
    const onDeadlineExceeded = vi.fn();
    const deps = {
      relay: null,
      onDeadlineExceeded,
      sandbox: {
        ensureReady: vi.fn(async () => {}),
        ensureRelayEgress: vi.fn(async () => {}),
        ensureWarehouseExportMount: vi.fn(async () => {}),
        startProcess: vi.fn(async () => ({})),
        exec: vi.fn(() => new Promise<never>(() => {})),
      },
    } as unknown as DbQueryDeps;

    const promise = runDbQuery(deps, {
      engine: "postgres",
      timeoutMs: 30_000,
    } as unknown as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(
      /db_query did not return within/,
    );
    // 30s query + 15s runner overhead + 15s marshalling grace.
    await vi.advanceTimersByTimeAsync(60_001);
    await assertion;

    expect(onDeadlineExceeded).toHaveBeenCalledTimes(1);
    expect(onDeadlineExceeded.mock.calls[0][0]).toMatchObject({
      operation: "db_query",
      budgetMs: 60_000,
    });
  });

  it("stops waiting on a relay readiness probe that never answers", async () => {
    // BOTH deployed environments configure a relay, so every real query runs
    // the forwarder prelude BEFORE the runner exec. Those awaits used to be
    // unbounded: the probe's 5s `timeout` is enforced container-side only, and
    // the poll loop's wall-clock check is reached only AFTER a probe settles.
    vi.useFakeTimers();
    const onDeadlineExceeded = vi.fn();
    const deps = {
      relay: {
        hostname: "db-relay.example.dev",
        socksUsername: "u",
        socksPassword: "p",
      },
      readinessTimeoutMs: 30_000,
      onDeadlineExceeded,
      sandbox: {
        ensureReady: vi.fn(async () => {}),
        ensureRelayEgress: vi.fn(async () => {}),
        ensureWarehouseExportMount: vi.fn(async () => {}),
        startProcess: vi.fn(async () => ({})),
        // The container took the probe and never answered.
        exec: vi.fn(() => new Promise<never>(() => {})),
      },
    } as unknown as DbQueryDeps;

    const promise = runDbQuery(deps, {
      engine: "postgres",
      sql: "select 1",
    } as unknown as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(
      /db_query_setup did not return within/,
    );
    // 30s readiness + 15s grace — not the caller's 20-minute ceiling.
    await vi.advanceTimersByTimeAsync(45_001);
    await assertion;

    expect(onDeadlineExceeded).toHaveBeenCalledTimes(1);
    expect(onDeadlineExceeded.mock.calls[0][0]).toMatchObject({
      operation: "db_query_setup",
    });
  });

  it("keeps the readiness diagnostic when probes DO answer but stay down", async () => {
    vi.useFakeTimers();
    const deps = {
      relay: {
        hostname: "db-relay.example.dev",
        socksUsername: "u",
        socksPassword: "p",
      },
      readinessTimeoutMs: 30_000,
      sandbox: {
        ensureReady: vi.fn(async () => {}),
        ensureRelayEgress: vi.fn(async () => {}),
        ensureWarehouseExportMount: vi.fn(async () => {}),
        startProcess: vi.fn(async () => ({})),
        exec: vi.fn(async () => ({ stdout: "down", stderr: "", exitCode: 0 })),
      },
    } as unknown as DbQueryDeps;

    const promise = runDbQuery(deps, {
      engine: "postgres",
      sql: "select 1",
    } as unknown as DbQueryRequest);
    const assertion = expect(promise).rejects.toThrow(
      /forwarder never became ready/,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
  });
});

describe("the project-build retry ladder and a spent exec budget", () => {
  it("stops on the first deadline exceedance instead of stacking builds in one workdir", async () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: "deploy_project",
      declaredTimeoutMs: 20_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      now: clock.now,
      timer: clock.timer,
    });
    const build = vi.fn(() => new Promise<never>(() => {}));
    const onTransient = vi.fn();

    const running = withProjectBuildServiceErrorMapping(
      "deploy_project",
      () => deadline.run(build),
      {
        onTransient,
        deadline,
        unavailableMessage: () => "temporarily unavailable",
      },
    ).catch((error) => error as Error);

    await clock.advance(deadline.budgetMs + 1);
    const error = await running;

    // The ladder surfaces the deadline's own message (not "try again in a
    // moment") and never re-enters the build.
    expect(isSandboxDeadlineExceededError(error)).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
    expect(onTransient).not.toHaveBeenCalled();
  });

  it("still retries an ordinary transient while budget remains", async () => {
    vi.useFakeTimers();
    const clock = fakeClock();
    const deadline = createSandboxExecDeadline({
      operation: "deploy_project",
      declaredTimeoutMs: 120_000,
      defaultTimeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
      maxTimeoutMs: PROJECT_BUILD_MAX_TIMEOUT_MS,
      overheadMs: PROJECT_BUILD_IO_OVERHEAD_MS,
      now: clock.now,
      timer: clock.timer,
    });
    let attempts = 0;
    const running = withProjectBuildServiceErrorMapping(
      "deploy_project",
      () =>
        deadline.run(async () => {
          attempts += 1;
          if (attempts === 1)
            throw new Error("RPCTransportError: Network connection lost");
          return "built";
        }),
      { deadline },
    );

    // Only the ladder's own backoff sleep is on real (faked) timers.
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(running).resolves.toBe("built");
    expect(attempts).toBe(2);
    // The backoff was charged OUTSIDE the exec budget.
    expect(deadline.exhausted).toBe(false);
  });
});
