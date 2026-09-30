import { describe, expect, it, vi } from "vitest";

import {
  createProjectBuildReadinessGate,
  ensureBuildSandboxReady,
  isProjectBuildPermanentStartupError,
  isProjectBuildServiceUnavailableError,
  projectBuildReadinessEventName,
  projectBuildTransientCause,
  ProjectBuildSandboxNotReadyError,
  PROJECT_BUILD_COLD_START_BUDGET_MS,
  PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE,
  PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE,
  PROJECT_BUILD_PROBE_TIMEOUT_MS,
  PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE,
  runWithProjectBuildReadiness,
  type ProjectBuildReadinessEvent,
} from "../src/project-build-readiness";
import { ProjectBuildContainerUnavailableError } from "../src/project-build-contracts";
import type { ProjectBuildSandboxLike } from "../src/project-worker-bundle";

/** Virtual clock: sleeps advance time, so the tests never wait in real life. */
function createClock(startMs = 1_000, sleepOvershootMs = 0) {
  let nowMs = startMs;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      nowMs += ms + sleepOvershootMs;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleeps,
  };
}

const TRANSIENT = () => new ProjectBuildContainerUnavailableError("exec", new Error("container is starting"));

function readinessHarness(options: {
  failures: number;
  failureError?: () => unknown;
  budgetMs?: number;
  probeIntervalMs?: number;
  progressAfterMs?: number;
  probeTimeoutMs?: number;
  probeCostMs?: number;
  /** Probe never settles, so only its deadline can end it. */
  probeHangs?: boolean;
  /** Fire probe deadlines (advancing the virtual clock by the window). */
  probeDeadlineFires?: boolean;
  /** Simulate a sleep that overruns the requested cadence. */
  sleepOvershootMs?: number;
}) {
  const clock = createClock(1_000, options.sleepOvershootMs ?? 0);
  const events: ProjectBuildReadinessEvent[] = [];
  const progress: string[] = [];
  const probeWindows: number[] = [];
  let calls = 0;
  const probe = vi.fn(async () => {
    calls += 1;
    clock.advance(options.probeCostMs ?? 0);
    if (options.probeHangs) return new Promise<never>(() => {});
    if (calls <= options.failures) throw (options.failureError ?? TRANSIENT)();
    return { exists: true };
  });
  // Deterministic deadline seam: by default the deadline never fires, so the
  // probe always decides the race; probeDeadlineFires flips it for the
  // hung-probe cases.
  const timer = (ms: number) => {
    probeWindows.push(ms);
    if (!options.probeDeadlineFires) {
      return { promise: new Promise<void>(() => {}), cancel: () => {} };
    }
    return {
      promise: (async () => {
        clock.advance(ms);
      })(),
      cancel: () => {},
    };
  };
  const run = () =>
    ensureBuildSandboxReady({} as ProjectBuildSandboxLike, {
      budgetMs: options.budgetMs ?? 10_000,
      probeIntervalMs: options.probeIntervalMs ?? 1_000,
      progressAfterMs: options.progressAfterMs ?? 5_000,
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      now: clock.now,
      sleep: clock.sleep,
      timer,
      probe,
      onEvent: (event) => events.push(event),
      onProgress: (message) => progress.push(message),
    });
  return { clock, events, progress, probe, probeWindows, run };
}

describe("ensureBuildSandboxReady", () => {
  it("returns after one probe on a warm container without emitting an event", async () => {
    const harness = readinessHarness({ failures: 0 });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: 1, coldStart: false, waitedMs: 0 });
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.clock.sleeps).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.progress).toEqual([]);
  });

  it("waits out a cold boot and reports the cold-start duration", async () => {
    const harness = readinessHarness({ failures: 3, probeCostMs: 100 });

    const result = await harness.run();

    expect(result.attempts).toBe(4);
    expect(result.coldStart).toBe(true);
    // 4 probes at 100ms + 3 sleeps at 1000ms.
    expect(result.waitedMs).toBe(3_400);
    expect(harness.events).toEqual([
      { type: "cold_start", waitedMs: 3_400, attempts: 4, cause: "container_unavailable" },
    ]);
  });

  it("reports progress once, only after the wait crosses the progress threshold", async () => {
    const harness = readinessHarness({ failures: 8, progressAfterMs: 5_000 });

    await harness.run();

    expect(harness.progress).toEqual([PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE]);
  });

  it("throws the unavailable message with the waited time in the cause when the budget is exhausted", async () => {
    const harness = readinessHarness({ failures: Number.POSITIVE_INFINITY, budgetMs: 10_000 });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    const cause = error?.cause as ProjectBuildSandboxNotReadyError;
    expect(cause).toBeInstanceOf(ProjectBuildSandboxNotReadyError);
    expect(cause.waitedMs).toBe(9_000);
    expect(cause.attempts).toBe(10);
    expect(cause.budgetMs).toBe(10_000);
    expect(cause.message).toContain("9000ms");
    // The transient probe failure is preserved underneath for triage.
    expect(String((cause.cause as Error).message)).toContain("container is starting");
    expect(harness.events).toEqual([
      {
        type: "ready_timeout",
        waitedMs: 9_000,
        attempts: 10,
        budgetMs: 10_000,
        cause: "container_unavailable",
      },
    ]);
  });

  it("fails a permanent container-startup error on the first probe", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () =>
        new ProjectBuildContainerUnavailableError(
          "exec",
          new Error("no such image: project-build is missing from the container images"),
        ),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.clock.sleeps).toEqual([]);
    // Not cold-start shaped: this is a configuration failure, not a boot.
    expect(harness.events).toEqual([
      { type: "startup_failed", waitedMs: 0, attempts: 1, cause: "container_startup_permanent" },
    ]);
  });

  it.each([
    "no such image",
    "no application that matches the request",
    "no container application assigned",
  ])("fails fast for the permanent-startup marker %s", async (message) => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () => new Error(message),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it("bounds a probe that never settles and counts it as a transient boot signal", async () => {
    const harness = readinessHarness({
      failures: 0,
      probeHangs: true,
      probeDeadlineFires: true,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      probeTimeoutMs: 4_000,
    });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    // Two bounded probes rather than one call blocking forever.
    expect(harness.probe).toHaveBeenCalledTimes(2);
    expect(harness.probeWindows).toEqual([4_000, 4_000]);
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "ready_timeout", cause: "probe_timeout", attempts: 2 }),
    ]);
  });

  it("clamps the last probe window to the remaining budget", async () => {
    const harness = readinessHarness({
      failures: 0,
      probeHangs: true,
      probeDeadlineFires: true,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      probeTimeoutMs: 8_000,
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    // 8s probe, 1s sleep, then only 1s of budget is left to spend.
    expect(harness.probeWindows).toEqual([8_000, 1_000]);
  });

  it("stops at the top of the loop when a sleep overruns the budget", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      // The cadence sleep takes 6s instead of 1s, pushing past the budget
      // between the post-probe check and the next probe.
      sleepOvershootMs: 5_000,
    });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    const cause = error?.cause as ProjectBuildSandboxNotReadyError;
    expect(cause.attempts).toBe(2);
    expect(cause.waitedMs).toBeGreaterThanOrEqual(10_000);
    expect(harness.probe).toHaveBeenCalledTimes(2);
  });

  it("treats a slow first probe as a cold start even when nothing threw", async () => {
    // A probe on a stopped container blocks while it boots, so the catch
    // branch never runs — the wake must still be reported and annotated.
    const harness = readinessHarness({ failures: 0, probeCostMs: 40_000, budgetMs: 240_000 });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: 1, coldStart: true, waitedMs: 40_000 });
    expect(harness.events).toEqual([
      { type: "cold_start", waitedMs: 40_000, attempts: 1, cause: null },
    ]);
  });

  it("rethrows a non-transient probe failure without retrying", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      failureError: () => new Error("Project builds require org scope"),
    });

    await expect(harness.run()).rejects.toThrow("Project builds require org scope");
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([]);
  });

  it("probes by running `true` through exec, bounded container-side", async () => {
    const sandbox = {
      exec: vi.fn(async () => ({ success: true, exitCode: 0, stdout: "", stderr: "", timedOut: false })),
    } as unknown as ProjectBuildSandboxLike;
    await ensureBuildSandboxReady(sandbox);
    expect(sandbox.exec).toHaveBeenCalledWith("true", expect.objectContaining({ cwd: "/" }));
    // The probe carries a container-side bound so a hung shell cannot sit on the
    // client-side per-probe deadline.
    expect((sandbox.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].timeout)
      .toBeGreaterThan(0);
  });

  it("treats a non-zero probe command as a transient, not a build failure", async () => {
    const sandbox = {
      exec: vi.fn(async () => ({ exitCode: 137, stderr: "killed" })),
    } as unknown as ProjectBuildSandboxLike;

    await expect(
      ensureBuildSandboxReady(sandbox, { budgetMs: 20, probeIntervalMs: 1 }),
    ).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
  });
});

describe("createProjectBuildReadinessGate", () => {
  it("waits once per tool call and re-arms only when invalidated", async () => {
    const waits: number[] = [];
    const gate = createProjectBuildReadinessGate(async (_sandbox, budgetMs) => {
      waits.push(budgetMs);
      return { waitedMs: 0, attempts: 1, coldStart: false };
    });
    const sandbox = {} as ProjectBuildSandboxLike;

    await gate.ensureReady(sandbox);
    await gate.ensureReady(sandbox);
    expect(waits).toHaveLength(1);

    gate.invalidate();
    await gate.ensureReady(sandbox);
    expect(waits).toHaveLength(2);
    // The second wait draws on what the first left of the shared budget.
    expect(waits[1]).toBeLessThanOrEqual(waits[0]);
  });

  it("annotates a cold wake onto the result and onto the failure message", async () => {
    const gate = createProjectBuildReadinessGate(async () => ({
      waitedMs: 42_000,
      attempts: 9,
      coldStart: true,
    }));

    await gate.ensureReady({} as ProjectBuildSandboxLike);

    expect(gate.annotate({ success: true })).toMatchObject({
      buildEnvironment: { coldStart: true, startupMs: 42_000, probes: 9 },
    });
    expect(gate.unavailableMessage()).toContain("42000ms");
  });
});

describe("runWithProjectBuildReadiness (admin verify seam)", () => {
  it("waits for a stopped container instead of failing the build outright", async () => {
    let probes = 0;
    const probe = vi.fn(async () => {
      probes += 1;
      if (probes < 4) throw TRANSIENT();
      return { exitCode: 0 };
    });
    const build = vi.fn(async () => ({ success: true }));

    const result = await runWithProjectBuildReadiness(
      {} as ProjectBuildSandboxLike,
      build,
      {
        operation: "project_build_verify",
        budgetMs: 60_000,
        readiness: { probe, probeIntervalMs: 1, sleep: async () => {} },
      },
    );

    expect(probes).toBe(4);
    // The build ran exactly once, AFTER the container answered.
    expect(build).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, buildEnvironment: { coldStart: true } });
  });

  it("drives the same ladder: a transient build failure is retried after re-arming the gate", async () => {
    const probe = vi.fn(async () => ({ exitCode: 0 }));
    let attempts = 0;
    const build = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Network connection lost");
      return { success: true };
    });

    const result = await runWithProjectBuildReadiness(
      {} as ProjectBuildSandboxLike,
      build,
      {
        operation: "project_build_verify",
        readiness: { probe, probeIntervalMs: 1, sleep: async () => {} },
      },
    );

    expect(build).toHaveBeenCalledTimes(2);
    // Re-armed: the second attempt re-probed rather than running blind.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ success: true });
  });
});

describe("cold-start budget sizing", () => {
  it("keeps one probe inside the cold-start budget", () => {
    // A probe deadline at or above the budget would leave no room to re-probe.
    expect(PROJECT_BUILD_PROBE_TIMEOUT_MS).toBeLessThan(PROJECT_BUILD_COLD_START_BUDGET_MS);
  });
});

describe("project build error classification", () => {
  it("names a stopped container as transient, across the DO RPC hop", () => {
    const thrown = new ProjectBuildContainerUnavailableError("exec", new Error("container exited"));
    // What the Worker sees after the hop: a plain Error whose message carries
    // the original name.
    const received = new Error(`${thrown.name}: ${thrown.message}`);
    expect(received.name).toBe("Error");
    expect(projectBuildTransientCause(thrown)).toBe("container_unavailable");
    expect(projectBuildTransientCause(received)).toBe("container_unavailable");
    expect(isProjectBuildServiceUnavailableError(received)).toBe(true);
  });

  it("names Durable Object errors the runtime marks retryable", () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true });
    expect(projectBuildTransientCause(reset)).toBe("durable_object_retryable");
    expect(projectBuildTransientCause(new Error("Network connection lost."))).toBe("durable_object_retryable");
  });

  it("treats unrelated failures as non-transient", () => {
    expect(projectBuildTransientCause(new Error("build failed with exit code 1"))).toBeNull();
    expect(isProjectBuildServiceUnavailableError(new Error("build failed with exit code 1"))).toBe(false);
    expect(projectBuildTransientCause(new Error("ContainerUnavailableError: from an old SDK"))).toBeNull();
  });

  it.each([
    "no such image: project-build is missing from the container images",
    "no container application assigned",
    "no application that matches the request",
  ])("classifies the permanent startup failure %s as terminal and non-retryable", (message) => {
    const error = new ProjectBuildContainerUnavailableError("exec", new Error(message));
    expect(isProjectBuildPermanentStartupError(error)).toBe(true);
    // The retry ladder keys off this: a permanent failure must not be retried.
    expect(projectBuildTransientCause(error)).toBeNull();
    expect(isProjectBuildServiceUnavailableError(error)).toBe(false);
  });

  it("keeps transient wake failures out of the permanent class", () => {
    expect(isProjectBuildPermanentStartupError(TRANSIENT())).toBe(false);
    expect(isProjectBuildPermanentStartupError(new Error("Network connection lost"))).toBe(false);
  });

  it("names each readiness event for telemetry", () => {
    expect(projectBuildReadinessEventName({ type: "cold_start", waitedMs: 1, attempts: 1, cause: null }))
      .toBe("build_sandbox_cold_start");
    expect(projectBuildReadinessEventName({ type: "startup_failed", waitedMs: 1, attempts: 1, cause: "x" }))
      .toBe("build_sandbox_startup_failed");
    expect(projectBuildReadinessEventName({ type: "ready_timeout", waitedMs: 1, attempts: 1, budgetMs: 1, cause: null }))
      .toBe("build_sandbox_ready_timeout");
  });
});
