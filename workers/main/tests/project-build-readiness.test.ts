import { describe, expect, it, vi } from "vitest";

import {
  createProjectBuildReadinessGate,
  ensureBuildSandboxReady,
  isProjectBuildPermanentStartupError,
  isProjectBuildServiceUnavailableError,
  isProjectBuildStorageMountError,
  projectBuildTransientCause,
  ProjectBuildSandboxNotReadyError,
  PROJECT_BUILD_COLD_START_BUDGET_MS,
  PROJECT_BUILD_COLD_START_PROGRESS_MESSAGE,
  PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE,
  PROJECT_BUILD_PROBE_TIMEOUT_MS,
  PROJECT_BUILD_SDK_RETRY_BUDGET_MS,
  PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE,
  PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS,
  PROJECT_BUILD_STORAGE_MOUNT_MESSAGE,
  runWithProjectBuildReadiness,
  type ProjectBuildReadinessEvent,
} from "../src/project-build-readiness";
import {
  withZombieSelfHeal,
  SANDBOX_ZOMBIE_PROBE_THRESHOLD,
} from "../src/sandbox-zombie-recovery";
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

const TRANSIENT = () => new Error("RPCTransportError: Network connection lost");

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
  zombieProbeThreshold?: number;
  onZombieDetected?: (
    input: { consecutive: number; error: unknown },
  ) => { restarted?: boolean } | void;
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
      ...(options.zombieProbeThreshold === undefined
        ? {}
        : { zombieProbeThreshold: options.zombieProbeThreshold }),
      ...(options.onZombieDetected ? { onZombieDetected: options.onZombieDetected } : {}),
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
      { type: "cold_start", waitedMs: 3_400, attempts: 4, cause: "rpc_transport" },
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
    expect(String((cause.cause as Error).message)).toContain("Network connection lost");
    expect(harness.events).toEqual([
      {
        type: "ready_timeout",
        waitedMs: 9_000,
        attempts: 10,
        budgetMs: 10_000,
        cause: "rpc_transport",
      },
    ]);
  });

  it("fails a storage-mount error immediately instead of waiting out the budget", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () =>
        new Error("Container failed to start: S3FS mount failed: fuse: device not found, try modprobe fuse first"),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_STORAGE_MOUNT_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.clock.sleeps).toEqual([]);
    expect(harness.events).toEqual([]);
  });

  it("fails a permanent container-startup error on the first probe", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () =>
        new Error(
          "Container failed to start due to a permanent error. Check your container configuration.",
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
    "RPCTransportError: no such image",
    "RPCTransportError: container ran out of memory",
    "SandboxError: This error will not resolve with retries.",
  ])("fails fast for the permanent-startup marker %s", async (message) => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      failureError: () => new Error(message),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    expect(harness.probe).toHaveBeenCalledTimes(1);
  });

  it("gives a 500 control-plane upgrade a few seconds, not the cold-boot budget", async () => {
    // transport:"rpc" discards the SDK's error body, so a 500 upgrade status is
    // the only surviving signal that the container start was permanent.
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      budgetMs: PROJECT_BUILD_COLD_START_BUDGET_MS,
      probeIntervalMs: 1_500,
      failureError: () =>
        new Error("RPCTransportError: WebSocket upgrade failed: 500 Internal Server Error"),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_CONTAINER_STARTUP_MESSAGE);
    // Bounded by PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS (5s), not 240s.
    expect(harness.probe.mock.calls.length).toBeLessThanOrEqual(4);
    expect(harness.clock.sleeps.reduce((sum, ms) => sum + ms, 0))
      .toBeLessThan(PROJECT_BUILD_STARTUP_FAILURE_BUDGET_MS);
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "startup_failed", cause: "container_startup_failed" }),
    ]);
  });

  it("keeps a 503 control-plane upgrade on the full cold-boot budget", async () => {
    const harness = readinessHarness({
      failures: 6,
      budgetMs: 60_000,
      probeIntervalMs: 1_500,
      failureError: () =>
        new Error("RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable"),
    });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: 7, coldStart: true });
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "cold_start", cause: "websocket_upgrade_failed" }),
    ]);
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
    // The SDK absorbs short 503 boots inside one call, so the catch branch
    // never runs — the wake must still be reported and annotated.
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

  it("probes through the session layer with exec, falling back to exists only without one", async () => {
    // A zombie container answers `exists` and fails `exec`; probing the cheap
    // layer is what let the gate conclude "ready" against a dead shell.
    const withBoth = {
      exists: vi.fn(async () => ({ exists: true })),
      exec: vi.fn(async () => ({ exitCode: 0 })),
    } as unknown as ProjectBuildSandboxLike;
    await ensureBuildSandboxReady(withBoth);
    expect(withBoth.exec).toHaveBeenCalledWith("true", expect.objectContaining({ cwd: "/" }));
    // The probe carries a container-side bound so a hung shell cannot sit on the
    // client-side per-probe deadline.
    expect((withBoth.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].timeout)
      .toBeGreaterThan(0);
    expect(withBoth.exists).not.toHaveBeenCalled();

    const existsOnly = { exists: vi.fn(async () => ({ exists: true })) } as unknown as ProjectBuildSandboxLike;
    await ensureBuildSandboxReady(existsOnly);
    expect(existsOnly.exists).toHaveBeenCalledWith("/workspace");
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

describe("zombie container self-heal", () => {
  const SESSION_DEATH = () =>
    Object.assign(
      new Error("Session 'sandbox-org-1' ended because its shell exited (exit code: 128)"),
      { name: "SessionTerminatedError" },
    );

  it("keeps probing a zombie instead of concluding ready, and fires the self-heal once", async () => {
    const zombieRestarts: Array<{ consecutive: number }> = [];
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      failureError: SESSION_DEATH,
      budgetMs: 10_000,
      probeIntervalMs: 1_000,
      onZombieDetected: (input) => {
        zombieRestarts.push({ consecutive: input.consecutive });
        return { restarted: true };
      },
    });

    const error = await harness.run().then(
      () => null,
      (thrown: unknown) => thrown as Error,
    );

    // The gate never concluded "ready" against the dead shell: it spent the
    // whole budget probing, exactly as it does for a cold boot.
    expect(error?.message).toBe(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);
    expect(harness.probe.mock.calls.length).toBeGreaterThan(SANDBOX_ZOMBIE_PROBE_THRESHOLD);
    // Fired once per wait, at the threshold — not once per probe.
    expect(zombieRestarts).toEqual([{ consecutive: SANDBOX_ZOMBIE_PROBE_THRESHOLD }]);
    expect(harness.events).toEqual([
      expect.objectContaining({
        type: "zombie_detected",
        cause: "session_death",
        restarted: true,
        attempts: SANDBOX_ZOMBIE_PROBE_THRESHOLD,
      }),
      expect.objectContaining({ type: "ready_timeout", cause: "session_death" }),
    ]);
  });

  it("recovers when the restarted container comes back", async () => {
    const harness = readinessHarness({
      failures: SANDBOX_ZOMBIE_PROBE_THRESHOLD,
      failureError: SESSION_DEATH,
      budgetMs: 60_000,
      probeIntervalMs: 1_000,
      onZombieDetected: () => ({ restarted: true }),
    });

    const result = await harness.run();

    expect(result).toMatchObject({ attempts: SANDBOX_ZOMBIE_PROBE_THRESHOLD + 1, coldStart: true });
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "zombie_detected", restarted: true }),
      expect.objectContaining({ type: "cold_start", cause: "session_death" }),
    ]);
  });

  it("reports the restart as suppressed when the DO rate-limits it", async () => {
    const harness = readinessHarness({
      failures: Number.POSITIVE_INFINITY,
      failureError: SESSION_DEATH,
      budgetMs: 8_000,
      probeIntervalMs: 1_000,
      // A second zombie inside the cooldown: the DO refuses to restart again.
      onZombieDetected: () => ({ restarted: false }),
    });

    await expect(harness.run()).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);

    expect(harness.events.filter((event) => event.type === "zombie_detected")).toEqual([
      expect.objectContaining({ type: "zombie_detected", restarted: false }),
    ]);
  });

  it("never fires on a healthy slow boot, however long it takes", async () => {
    const zombieRestarts: unknown[] = [];
    // 60s of ordinary wake transients (the SDK's connection-lost shape), then up.
    const harness = readinessHarness({
      failures: 40,
      failureError: () => new Error("RPCTransportError: Network connection lost"),
      budgetMs: 240_000,
      probeIntervalMs: 1_500,
      onZombieDetected: (input) => {
        zombieRestarts.push(input);
        return { restarted: true };
      },
    });

    const result = await harness.run();

    expect(result.coldStart).toBe(true);
    expect(zombieRestarts).toEqual([]);
    expect(harness.events).toEqual([
      expect.objectContaining({ type: "cold_start", cause: "rpc_transport", attempts: 41 }),
    ]);
  });

  it("resets the zombie counter when a non-session-death failure interleaves", async () => {
    const zombieRestarts: unknown[] = [];
    let call = 0;
    const probe = vi.fn(async () => {
      call += 1;
      // Alternating session death / transport error: never N consecutive.
      if (call % 2 === 1) {
        throw Object.assign(new Error("SessionTerminatedError: shell exited"), {
          name: "SessionTerminatedError",
        });
      }
      throw new Error("RPCTransportError: Network connection lost");
    });

    await expect(
      ensureBuildSandboxReady({} as ProjectBuildSandboxLike, {
        budgetMs: 60,
        probeIntervalMs: 1,
        probe,
        onZombieDetected: (input) => {
          zombieRestarts.push(input);
        },
      }),
    ).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);

    expect(probe.mock.calls.length).toBeGreaterThan(SANDBOX_ZOMBIE_PROBE_THRESHOLD);
    expect(zombieRestarts).toEqual([]);
  });

  /**
   * The probe crosses the DO RPC boundary, so it lands on the SUBCLASS method —
   * and `ProjectBuildSandbox.exec` self-heals on the FIRST session death, inside
   * the DO, before the rejection ever reaches this worker. A probe routed
   * through `exec` therefore destroys the container before the gate can count a
   * second consecutive death, making `SANDBOX_ZOMBIE_PROBE_THRESHOLD` and the
   * `probe_session_death` trigger unreachable. This drives the gate through a
   * fake DO whose `exec` is the REAL wrapper (not a stub), so that shadowing
   * cannot come back.
   */
  it("probes through a heal-exempt entry point, so the DO's exec wrapper never sees it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = new Map<string, number>();
      const destroy = vi.fn(async () => {});
      const healTarget = {
        ctx: {
          storage: {
            get: async <T,>(key: string) => store.get(key) as T | undefined,
            put: async (key: string, value: number) => {
              store.set(key, value);
            },
          },
          container: { running: true },
        },
        env: {},
        destroy,
      };
      const dead = async () => {
        throw SESSION_DEATH();
      };
      const restartZombieContainer = vi.fn(async () => ({ restarted: true, reason: "forced" }));
      const sandbox = {
        // The real DO override: every exec-class call self-heals immediately.
        exec: vi.fn(() => withZombieSelfHeal(healTarget, "ProjectBuildSandbox", "exec", dead)),
        // The real probe entry point: same session layer, no self-heal.
        probeShell: vi.fn(dead),
        restartZombieContainer,
      } as unknown as ProjectBuildSandboxLike;

      await expect(
        ensureBuildSandboxReady(sandbox, { budgetMs: 40, probeIntervalMs: 1 }),
      ).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);

      expect(sandbox.exec).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
      // The gate, not the DO's exec wrapper, decided — after N consecutive
      // session-death probes — and it did so under the real trigger value.
      expect(restartZombieContainer).toHaveBeenCalledTimes(1);
      expect(restartZombieContainer.mock.calls[0]?.[0]).toMatchObject({
        operation: "readiness_probe",
        trigger: "probe_session_death",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("asks the sandbox DO to restart itself by default, and survives a DO that cannot", async () => {
    const restartZombieContainer = vi.fn(async () => ({ restarted: true, reason: "forced" }));
    const sandbox = {
      // The zombie shape from production: cheap ops fine, exec dead.
      exists: vi.fn(async () => ({ exists: true })),
      exec: vi.fn(async () => {
        throw Object.assign(new Error("Session 'sandbox-org' shell exited (exit code: 128)"), {
          name: "SessionTerminatedError",
        });
      }),
      restartZombieContainer,
    } as unknown as ProjectBuildSandboxLike;

    await expect(
      ensureBuildSandboxReady(sandbox, { budgetMs: 40, probeIntervalMs: 1 }),
    ).rejects.toThrow(PROJECT_BUILD_SERVICE_UNAVAILABLE_MESSAGE);

    expect(restartZombieContainer).toHaveBeenCalledTimes(1);
    expect(restartZombieContainer).toHaveBeenCalledWith({
      operation: "readiness_probe",
      trigger: "probe_session_death",
      error: expect.stringContaining("SessionTerminatedError"),
    });

    // A DO without the method (or one that throws) must not turn the wait into
    // a different error.
    const older = {
      exec: vi.fn(async () => {
        throw Object.assign(new Error("SessionTerminatedError: shell exited"), {
          name: "SessionTerminatedError",
        });
      }),
    } as unknown as ProjectBuildSandboxLike;
    await expect(
      ensureBuildSandboxReady(older, { budgetMs: 40, probeIntervalMs: 1 }),
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
      if (probes < 4) throw new Error("RPCTransportError: Network connection lost");
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
  it("dominates the sandbox SDK's own per-call retry budget", () => {
    // The SDK retries its control-plane upgrade internally for
    // computeRetryTimeoutMs(); if our budget did not exceed that (plus the ~30s
    // tail of its final connect attempt), the first probe would consume the
    // whole budget and the re-probe loop would never run.
    expect(PROJECT_BUILD_COLD_START_BUDGET_MS)
      .toBeGreaterThan(PROJECT_BUILD_SDK_RETRY_BUDGET_MS + 30_000);
    // A probe deadline below the SDK budget would cut legitimate boots short.
    expect(PROJECT_BUILD_PROBE_TIMEOUT_MS).toBeGreaterThan(PROJECT_BUILD_SDK_RETRY_BUDGET_MS);
    expect(PROJECT_BUILD_PROBE_TIMEOUT_MS).toBeLessThan(PROJECT_BUILD_COLD_START_BUDGET_MS);
  });
});

describe("project build error classification", () => {
  it.each([
    ["RPCTransportError: boom", "rpc_transport"],
    ["Network connection lost", "network_connection_lost"],
    ["WebSocket upgrade failed: 503 Service Unavailable", "websocket_upgrade_failed"],
    ["RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable", "websocket_upgrade_failed"],
    ["RPCTransportError: WebSocket upgrade failed: 500 Internal Server Error", "container_startup_failed"],
    ["Container is currently provisioning. This can take several minutes", "container_provisioning"],
    ["no container instance available", "container_provisioning"],
    ["got 503 Service Unavailable", "service_unavailable"],
    ["Container failed to start", "container_failed_to_start"],
    ["ContainerUnavailableError: max_container_instances_exceeded", "container_unavailable"],
    ["OperationInterruptedError: runtime replaced", "operation_interrupted"],
    ["RPC session was shut down by disposing the main stub", "rpc_session_disposed"],
  ])("names the transient cause for %s", (message, expected) => {
    expect(projectBuildTransientCause(new Error(message))).toBe(expected);
    expect(isProjectBuildServiceUnavailableError(new Error(message))).toBe(true);
  });

  it("treats unrelated failures as non-transient", () => {
    expect(projectBuildTransientCause(new Error("build failed with exit code 1"))).toBeNull();
    expect(isProjectBuildServiceUnavailableError(new Error("build failed with exit code 1"))).toBe(false);
  });

  it("classifies FUSE/S3FS mount failures as terminal", () => {
    expect(isProjectBuildStorageMountError(new Error("S3FS mount failed"))).toBe(true);
    expect(isProjectBuildStorageMountError(new Error("fuse: device not found"))).toBe(true);
    expect(isProjectBuildStorageMountError(new Error("Network connection lost"))).toBe(false);
  });

  it.each([
    "Container failed to start due to a permanent error. Check your container configuration.",
    "This error will not resolve with retries. Check container logs, image name, and resource limits.",
    "no such image",
    "no container application assigned",
    "no application that matches the request",
    "the container ran out of memory",
    "too many subprocesses",
    "container did not call start",
  ])("classifies the permanent startup failure %s as terminal and non-retryable", (message) => {
    expect(isProjectBuildPermanentStartupError(new Error(message))).toBe(true);
    // The retry ladder keys off this: a permanent failure must not be retried.
    expect(projectBuildTransientCause(new Error(message))).toBeNull();
    expect(isProjectBuildServiceUnavailableError(new Error(message))).toBe(false);
  });

  it("keeps transient wake failures out of the permanent class", () => {
    expect(isProjectBuildPermanentStartupError(new Error("Container is starting. Please retry in a moment."))).toBe(false);
    expect(isProjectBuildPermanentStartupError(new Error("RPCTransportError: Network connection lost"))).toBe(false);
    // Storage-mount failures keep their own terminal mapping and message.
    expect(
      isProjectBuildPermanentStartupError(
        new Error("Container failed to start: S3FS mount failed: fuse: device not found"),
      ),
    ).toBe(false);
  });
});
