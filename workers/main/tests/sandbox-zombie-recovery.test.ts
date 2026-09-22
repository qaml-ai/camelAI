import { describe, expect, it, vi } from "vitest";

import {
  canForceZombieRestart,
  createSandboxZombieHealState,
  forceSandboxZombieRestart,
  healZombieSandboxContainer,
  SandboxSessionDeathTracker,
  withZombieSelfHeal,
  SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD,
  SANDBOX_ZOMBIE_RESTART_AT_KEY,
  SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS,
  SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS,
  SANDBOX_ZOMBIE_RESTART_EVENT,
  type SandboxZombieRestartHost,
} from "../src/sandbox-zombie-recovery";

const SESSION_DEATH = () =>
  Object.assign(
    new Error("Session 'sandbox-org-1' ended because its shell exited (exit code: 128)"),
    { name: "SessionTerminatedError" },
  );

/** In-memory stand-in for the DO's storage + container handle. */
function createHost(options: {
  running?: boolean;
  lastRestartAtMs?: number;
  destroy?: () => Promise<void>;
} = {}) {
  const store = new Map<string, number>();
  if (options.lastRestartAtMs !== undefined) {
    store.set(SANDBOX_ZOMBIE_RESTART_AT_KEY, options.lastRestartAtMs);
  }
  const destroy = vi.fn(options.destroy ?? (async () => {}));
  const recorded: unknown[] = [];
  const host: SandboxZombieRestartHost = {
    storage: {
      get: async <T,>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: number) => {
        store.set(key, value);
      },
    },
    isContainerRunning: () => options.running !== false,
    destroyContainer: destroy,
    recordRestart: (event) => recorded.push(event),
  };
  return { host, store, destroy, recorded };
}

describe("canForceZombieRestart", () => {
  it("allows the first restart and refuses one inside the cooldown", () => {
    expect(canForceZombieRestart({
      nowMs: 1_000_000,
      lastRestartAtMs: undefined,
      containerRunning: true,
    })).toBe(true);
    expect(canForceZombieRestart({
      nowMs: 1_000_000,
      lastRestartAtMs: 1_000_000 - (SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS - 1),
      containerRunning: true,
    })).toBe(false);
    expect(canForceZombieRestart({
      nowMs: 1_000_000,
      lastRestartAtMs: 1_000_000 - SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS,
      containerRunning: true,
    })).toBe(true);
  });

  it("never restarts a container that is not running, and never trusts a future stamp", () => {
    expect(canForceZombieRestart({
      nowMs: 1_000_000,
      lastRestartAtMs: undefined,
      containerRunning: false,
    })).toBe(false);
    expect(canForceZombieRestart({
      nowMs: 1_000_000,
      lastRestartAtMs: 9_000_000,
      containerRunning: true,
    })).toBe(false);
  });
});

describe("forceSandboxZombieRestart", () => {
  it("destroys the container once and records the restart", async () => {
    const { host, store, destroy, recorded } = createHost();

    const outcome = await forceSandboxZombieRestart(
      host,
      { operation: "exec", trigger: "exec_session_death", error: SESSION_DEATH() },
      { nowMs: 5_000 },
    );

    expect(outcome).toMatchObject({ restarted: true, reason: "forced" });
    expect(destroy).toHaveBeenCalledTimes(1);
    // Stamped BEFORE the destroy, so a teardown that takes the DO with it still
    // counts against the cooldown.
    expect(store.get(SANDBOX_ZOMBIE_RESTART_AT_KEY)).toBe(5_000);
    expect(recorded).toHaveLength(1);
  });

  it("rate-limits a second zombie inside the cooldown window", async () => {
    const { host, destroy, recorded } = createHost();

    await forceSandboxZombieRestart(
      host,
      { operation: "exec", trigger: "exec_session_death" },
      { nowMs: 1_000 },
    );
    const second = await forceSandboxZombieRestart(
      host,
      { operation: "readiness_probe", trigger: "probe_session_death" },
      { nowMs: 1_000 + SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS - 1 },
    );

    expect(second).toMatchObject({ restarted: false, reason: "rate_limited" });
    // A broken image cannot restart-loop, and a suppressed request is not an
    // event (it can repeat every probe tick).
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(recorded).toHaveLength(1);

    const third = await forceSandboxZombieRestart(
      host,
      { operation: "exec", trigger: "exec_session_death" },
      { nowMs: 1_000 + SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS },
    );
    expect(third).toMatchObject({ restarted: true });
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("skips a container that is not running", async () => {
    const { host, destroy } = createHost({ running: false });

    const outcome = await forceSandboxZombieRestart(
      host,
      { operation: "exec", trigger: "exec_session_death" },
      { nowMs: 1_000 },
    );

    expect(outcome).toMatchObject({ restarted: false, reason: "container_not_running" });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys a wedged START (never running) when the caller opts out of the running check", async () => {
    const { host, destroy, store } = createHost({ running: false });

    const outcome = await forceSandboxZombieRestart(
      host,
      { operation: "db_query_container_start", trigger: "setup_deadline" },
      { nowMs: 1_000, requireRunningContainer: false },
    );

    expect(outcome).toMatchObject({ restarted: true, reason: "forced" });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(store.get(SANDBOX_ZOMBIE_RESTART_AT_KEY)).toBe(1_000);

    // Still one restart per cooldown: a broken image cannot restart-loop.
    const again = await forceSandboxZombieRestart(
      host,
      { operation: "db_query_container_start", trigger: "setup_deadline" },
      { nowMs: 1_000 + SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS - 1, requireRunningContainer: false },
    );
    expect(again).toMatchObject({ restarted: false, reason: "rate_limited" });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("reports (and records) a destroy that fails without throwing", async () => {
    const { host, recorded } = createHost({
      destroy: async () => {
        throw new Error("container destroy rejected");
      },
    });

    const outcome = await forceSandboxZombieRestart(
      host,
      { operation: "exec", trigger: "exec_session_death" },
      { nowMs: 1_000 },
    );

    expect(outcome).toMatchObject({ restarted: false, reason: "destroy_failed" });
    expect(recorded).toHaveLength(1);
  });
});

/** Minimal DO stand-in: storage map + container flag + destroy + AE datasets. */
function createSandbox(options: { running?: boolean; lastRestartAtMs?: number } = {}) {
  const store = new Map<string, number>();
  if (options.lastRestartAtMs !== undefined) {
    store.set(SANDBOX_ZOMBIE_RESTART_AT_KEY, options.lastRestartAtMs);
  }
  const writeDataPoint = vi.fn();
  const destroy = vi.fn(async () => {});
  return {
    destroy,
    writeDataPoint,
    store,
    sandbox: {
      ctx: {
        storage: {
          get: async <T,>(key: string) => store.get(key) as T | undefined,
          put: async (key: string, value: number) => {
            store.set(key, value);
          },
        },
        container: { running: options.running !== false },
      },
      env: {
        OBSERVABILITY_EVENTS: { writeDataPoint },
        ERROR_ANALYTICS: { writeDataPoint: vi.fn() },
      },
      destroy,
    },
  };
}

describe("post-destroy notification", () => {
  it("tells the DO its container is gone, so no bookkeeping outlives it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, destroy } = createSandbox();
      const onContainerDestroyed = vi.fn(async () => {});

      await healZombieSandboxContainer(
        { ...sandbox, onContainerDestroyed },
        "AnalysisSandbox",
        { operation: "exec", trigger: "exec_session_death" },
      );

      // `destroy()` does NOT synchronously run `onStop`, so without this hook the
      // next call short-circuits `ensureMounted` against a dead container.
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(onContainerDestroyed).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("still fires when the teardown is abandoned — the container may be gone anyway", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox } = createSandbox();
      sandbox.destroy = vi.fn(() => new Promise<void>(() => {}));
      const onContainerDestroyed = vi.fn(async () => {});

      const pending = healZombieSandboxContainer(
        { ...sandbox, onContainerDestroyed },
        "AnalysisSandbox",
        { operation: "exec", trigger: "exec_session_death" },
      );
      await vi.advanceTimersByTimeAsync(SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS + 1);
      await expect(pending).resolves.toMatchObject({ restarted: false, reason: "destroy_failed" });

      expect(onContainerDestroyed).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("never lets post-destroy cleanup fail the heal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox } = createSandbox();

      const outcome = await healZombieSandboxContainer(
        {
          ...sandbox,
          onContainerDestroyed: async () => {
            throw new Error("mount bookkeeping reset failed");
          },
        },
        "AnalysisSandbox",
        { operation: "exec", trigger: "exec_session_death" },
      );

      expect(outcome).toMatchObject({ restarted: true, reason: "forced" });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("wedged teardown escalation", () => {
  /**
   * `Sandbox.destroy()` coalesces every later call onto the SAME in-flight
   * promise and only clears it when that promise settles, so re-issuing a
   * destroy we already abandoned re-attaches to the hang: the heal would be dead
   * for the life of the DO instance.
   */
  it("evicts the DO instance instead of re-issuing a destroy that never settled", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox } = createSandbox();
      const destroy = vi.fn(() => new Promise<void>(() => {}));
      sandbox.destroy = destroy;
      const abortInstance = vi.fn();
      const healable = { ...sandbox, healState: createSandboxZombieHealState(), abortInstance };

      const first = healZombieSandboxContainer(healable, "ProjectBuildSandbox", {
        operation: "exec",
        trigger: "exec_session_death",
      }, { nowMs: 1_000 });
      await vi.advanceTimersByTimeAsync(SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS + 1);
      await expect(first).resolves.toMatchObject({ restarted: false, reason: "destroy_failed" });

      const second = await healZombieSandboxContainer(healable, "ProjectBuildSandbox", {
        operation: "exec",
        trigger: "exec_session_death",
      }, { nowMs: 1_000 + SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS });

      expect(second).toMatchObject({ restarted: true, reason: "instance_aborted" });
      // The wedged teardown is never re-issued.
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(abortInstance).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reports destroy_failed (never hangs) when the runtime cannot evict the instance", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox } = createSandbox();
      const destroy = vi.fn(() => new Promise<void>(() => {}));
      sandbox.destroy = destroy;
      const healable = { ...sandbox, healState: createSandboxZombieHealState() };

      const first = healZombieSandboxContainer(healable, "ProjectBuildSandbox", {
        operation: "exec",
        trigger: "exec_session_death",
      }, { nowMs: 1_000 });
      await vi.advanceTimersByTimeAsync(SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS + 1);
      await first;

      const second = await healZombieSandboxContainer(healable, "ProjectBuildSandbox", {
        operation: "exec",
        trigger: "exec_session_death",
      }, { nowMs: 1_000 + SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS });

      expect(second).toMatchObject({ restarted: false, reason: "destroy_failed" });
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("healZombieSandboxContainer", () => {
  it("emits build_sandbox_zombie_restart with the trigger and operation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, destroy, writeDataPoint } = createSandbox();

      const outcome = await healZombieSandboxContainer(sandbox, "ProjectBuildSandbox", {
        operation: "readiness_probe",
        trigger: "probe_session_death",
        error: SESSION_DEATH(),
      });

      expect(outcome.restarted).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(writeDataPoint).toHaveBeenCalledTimes(1);
      const blobs = writeDataPoint.mock.calls[0][0].blobs as string[];
      expect(blobs).toContain(SANDBOX_ZOMBIE_RESTART_EVENT);
      expect(blobs).toContain("ProjectBuildSandbox");
      expect(blobs).toContain("readiness_probe");
      expect(blobs).toContain("probe_session_death");
    } finally {
      warn.mockRestore();
    }
  });

  it("emits the same event for a DbQuerySandbox setup-deadline restart", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, destroy, writeDataPoint } = createSandbox({ running: false });

      const outcome = await healZombieSandboxContainer(
        sandbox,
        "DbQuerySandbox",
        {
          operation: "db_query_container_start",
          trigger: "setup_deadline",
          error: "SandboxDeadlineExceededError: db_query_container_start did not return",
        },
        { requireRunningContainer: false },
      );

      expect(outcome).toMatchObject({ restarted: true, reason: "forced" });
      expect(destroy).toHaveBeenCalledTimes(1);
      const blobs = writeDataPoint.mock.calls[0][0].blobs as string[];
      expect(blobs).toContain(SANDBOX_ZOMBIE_RESTART_EVENT);
      expect(blobs).toContain("DbQuerySandbox");
      expect(blobs).toContain("db_query_container_start");
      expect(blobs).toContain("setup_deadline");
    } finally {
      warn.mockRestore();
    }
  });

  it("writes no event when the cooldown suppresses the restart", async () => {
    const { sandbox, destroy, writeDataPoint } = createSandbox({ lastRestartAtMs: Date.now() });

    const outcome = await healZombieSandboxContainer(sandbox, "AnalysisSandbox", {
      operation: "exec",
      trigger: "exec_session_death",
    });

    expect(outcome).toMatchObject({ restarted: false, reason: "rate_limited" });
    expect(destroy).not.toHaveBeenCalled();
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
});

describe("healZombieSandboxContainer destroy bound", () => {
  it("gives up waiting on a teardown that never completes, without looping", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, store, writeDataPoint } = createSandbox();
      sandbox.destroy = vi.fn(() => new Promise<void>(() => {}));

      const pending = healZombieSandboxContainer(sandbox, "ProjectBuildSandbox", {
        operation: "exec",
        trigger: "exec_session_death",
      });
      await vi.advanceTimersByTimeAsync(SANDBOX_ZOMBIE_DESTROY_TIMEOUT_MS + 1);

      await expect(pending).resolves.toMatchObject({ restarted: false, reason: "destroy_failed" });
      // The cooldown was stamped before the destroy, so abandoning the wait
      // cannot become a restart loop.
      expect(store.get(SANDBOX_ZOMBIE_RESTART_AT_KEY)).toBeGreaterThan(0);
      expect(writeDataPoint).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("withZombieSelfHeal", () => {
  it("heals on session death and still re-throws the original error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, destroy } = createSandbox();
      const death = SESSION_DEATH();

      await expect(
        withZombieSelfHeal(sandbox, "ProjectBuildSandbox", "exec", async () => {
          throw death;
        }),
      ).rejects.toBe(death);

      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves every other failure alone — a slow boot must never be healed", async () => {
    const { sandbox, destroy } = createSandbox();

    for (const message of [
      "RPCTransportError: Network connection lost",
      "Container is currently provisioning. This can take several minutes",
      "build failed with exit code 1",
    ]) {
      await expect(
        withZombieSelfHeal(sandbox, "ProjectBuildSandbox", "exec", async () => {
          throw new Error(message);
        }),
      ).rejects.toThrow(message);
    }

    expect(destroy).not.toHaveBeenCalled();
  });

  it("passes successful results straight through", async () => {
    const { sandbox, destroy } = createSandbox();

    await expect(
      withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => ({ exitCode: 0 })),
    ).resolves.toEqual({ exitCode: 0 });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("waits for N consecutive deaths when the caller has its own session recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, destroy } = createSandbox();
      const tracker = new SandboxSessionDeathTracker();
      const heal = { threshold: SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD, tracker };
      const die = () =>
        withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => {
          throw SESSION_DEATH();
        }, heal);

      // The FIRST death is the SDK's self-recovering class: AnalysisService
      // resets the session and retries against the same warm container. Killing
      // it here would replace a ~1s handshake with a 30-120s cold boot.
      await expect(die()).rejects.toThrow();
      expect(destroy).not.toHaveBeenCalled();

      // A death that survives the fresh session handshake is a zombie.
      await expect(die()).rejects.toThrow();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("resets the count on any non-session-death outcome", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sandbox, destroy } = createSandbox();
      const tracker = new SandboxSessionDeathTracker();
      const heal = { threshold: SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD, tracker };

      await expect(
        withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => {
          throw SESSION_DEATH();
        }, heal),
      ).rejects.toThrow();
      // A shell that answers is not a zombie, whatever the exit code.
      await withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => ({ exitCode: 1 }), heal);
      await expect(
        withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => {
          throw SESSION_DEATH();
        }, heal),
      ).rejects.toThrow();

      expect(destroy).not.toHaveBeenCalled();

      // A transport error between two deaths breaks the streak the same way.
      await expect(
        withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => {
          throw new Error("RPCTransportError: Network connection lost");
        }, heal),
      ).rejects.toThrow();
      await expect(
        withZombieSelfHeal(sandbox, "AnalysisSandbox", "exec", async () => {
          throw SESSION_DEATH();
        }, heal),
      ).rejects.toThrow();
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not double-restart when an exec death and a probe death share the cooldown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The build ladder's exec failure heals; the readiness gate that follows
      // asks for the same heal and is refused, so the container reboots once.
      const { sandbox, destroy } = createSandbox();

      await expect(
        withZombieSelfHeal(sandbox, "ProjectBuildSandbox", "exec", async () => {
          throw SESSION_DEATH();
        }),
      ).rejects.toThrow();
      const probeHeal = await healZombieSandboxContainer(sandbox, "ProjectBuildSandbox", {
        operation: "readiness_probe",
        trigger: "probe_session_death",
      });

      expect(probeHeal).toMatchObject({ restarted: false, reason: "rate_limited" });
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
