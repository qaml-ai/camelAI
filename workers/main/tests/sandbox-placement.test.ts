import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisContainer, ANALYSIS_IMAGE, getAnalysisSandbox, type AnalysisAccess } from "../src/analysis-container";
import { ContainerStartFailedError } from "../src/container-start";
import { DB_QUERY_IMAGE, DbQueryContainer } from "../src/db-query-container";
import { dbQueryContainerKey, getDbQueryContainer } from "../src/db-query-contracts";
import { getProjectBuildSandbox } from "../src/project-build-sandbox-lifecycle";
import {
  FAILURE_WINDOW_MS,
  followSandboxGeneration,
  MAX_ROTATIONS,
  parseSandboxGenerationName,
  PLACEMENT_KEY,
  ROTATION_WINDOW_MS,
  SandboxPlacement,
  SandboxRelocatedError,
  sandboxGenerationName,
  START_FAILURES_KEY,
  type SandboxPlacementRegistry,
} from "../src/sandbox-placement";
import type { Env } from "../src/types";

vi.mock("cloudflare:workers", async (importOriginal) => {
  const original = await importOriginal<typeof import("cloudflare:workers")>();
  class DurableObject {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  }
  class WorkerEntrypoint {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  }
  return { ...original, DurableObject, WorkerEntrypoint };
});

const UNAVAILABLE = "The container connection is temporarily unavailable, try again shortly";

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: vi.fn(async <T>(key: string) => values.get(key) as T | undefined),
    put: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    delete: vi.fn(async (key: string) => values.delete(key)),
  };
}

function fakeEvents() {
  const points: Array<{ blobs: string[]; doubles: number[] }> = [];
  return {
    points,
    names: () => points.map((point) => point.blobs[0]),
    env: { OBSERVABILITY_EVENTS: { writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => points.push(point) } },
  };
}

function startFailure(permanent = false): ContainerStartFailedError {
  return new ContainerStartFailedError({
    label: "test environment",
    attempts: 2,
    waitedMs: 100_000,
    permanent,
    cause: new Error(permanent ? "no such image: x" : UNAVAILABLE),
  });
}

/** A set of SandboxPlacements for one base, wired the way the DOs wire them. */
function placements(base: string, clock: { now: number }) {
  const events = fakeEvents();
  const storages = new Map<number, ReturnType<typeof fakeStorage>>();
  const instances = new Map<number, SandboxPlacement>();
  const get = (generation: number): SandboxPlacement => {
    let instance = instances.get(generation);
    if (!instance) {
      const storage = fakeStorage();
      storages.set(generation, storage);
      instance = new SandboxPlacement({
        storage,
        name: sandboxGenerationName(base, generation),
        component: "DbQueryContainer",
        env: events.env as never,
        registry: (registryBase) => {
          expect(registryBase).toBe(base);
          const registry = get(0);
          return { rotateSandboxPlacement: (request) => registry.rotate(request) } satisfies SandboxPlacementRegistry;
        },
        scope: () => ({ workspaceId: "w1" }),
        now: () => clock.now,
      });
      instances.set(generation, instance);
    }
    return instance;
  };
  return { get, storages, events };
}

describe("sandbox generation names", () => {
  it("keeps generation 0 at the existing name and suffixes later generations", () => {
    expect(sandboxGenerationName("ws-abc", 0)).toBe("ws-abc");
    expect(sandboxGenerationName("ws-abc", 2)).toBe("ws-abc-g2");
    expect(parseSandboxGenerationName("ws-abc-g2")).toEqual({ base: "ws-abc", generation: 2 });
    expect(parseSandboxGenerationName("6cb4c12a-12cd-4f54-a779-c27206d941d8")).toEqual({
      base: "6cb4c12a-12cd-4f54-a779-c27206d941d8",
      generation: 0,
    });
    expect(parseSandboxGenerationName("app-w1-g1")).toEqual({ base: "app-w1", generation: 1 });
    // `-g0` is not a generation suffix: generation 0 has no suffix.
    expect(parseSandboxGenerationName("ws-x-g0")).toEqual({ base: "ws-x-g0", generation: 0 });
  });
});

describe("rotation trigger", () => {
  it("does not rotate on a single failed start", async () => {
    const clock = { now: 1_000_000 };
    const { get, storages, events } = placements("ws-w1", clock);
    const cleanup = vi.fn(async () => {});
    await get(0).noteStartFailed(startFailure(), cleanup);
    await expect(get(0).assertCurrent()).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(storages.get(0)?.values.get(PLACEMENT_KEY)).toBeUndefined();
    expect(events.names()).toEqual([]);
  });

  it("rotates on the second failed start within ten minutes, retires the old generation and destroys its container", async () => {
    const clock = { now: 1_000_000 };
    const { get, storages, events } = placements("ws-w1", clock);
    const cleanup = vi.fn(async () => {});
    await get(0).noteStartFailed(startFailure(), cleanup);
    clock.now += FAILURE_WINDOW_MS - 1;
    await get(0).noteStartFailed(startFailure(), cleanup);

    await expect(get(0).assertCurrent()).rejects.toThrow("SandboxRelocatedError: the sandbox moved to generation 1");
    await expect(get(1).assertCurrent()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(storages.get(0)?.values.get(START_FAILURES_KEY)).toBeUndefined();

    expect(events.names()).toEqual(["sandbox_placement_rotated"]);
    const [point] = events.points;
    expect(point.blobs[2]).toBe("DbQueryContainer"); // component = class
    expect(point.blobs[4]).toBe("start_failures"); // status = reason
    expect(point.blobs[7]).toBe("ws-w1 -> ws-w1-g1"); // path = from -> to
    expect(point.blobs[9]).toBe("w1"); // workspace
    expect(point.doubles[3]).toBe(0); // count = from generation
    expect(point.doubles[4]).toBe(1); // size = to generation
  });

  it("does not count failures that are further apart than the window", async () => {
    const clock = { now: 1_000_000 };
    const { get } = placements("ws-w1", clock);
    await get(0).noteStartFailed(startFailure(), async () => {});
    clock.now += FAILURE_WINDOW_MS;
    await get(0).noteStartFailed(startFailure(), async () => {});
    await expect(get(0).assertCurrent()).resolves.toBeUndefined();
  });

  it("needs consecutive failures: a successful start in between resets the count", async () => {
    const clock = { now: 1_000_000 };
    const { get } = placements("ws-w1", clock);
    await get(0).trackStart(() => Promise.reject(startFailure()), async () => {}).catch(() => {});
    await get(0).trackStart(async () => "ok", async () => {});
    await get(0).trackStart(() => Promise.reject(startFailure()), async () => {}).catch(() => {});
    await expect(get(0).assertCurrent()).resolves.toBeUndefined();
  });

  it("never rotates for a permanent start failure or a non-start error", async () => {
    const clock = { now: 1_000_000 };
    const { get } = placements("ws-w1", clock);
    for (const error of [startFailure(true), startFailure(true), new Error("boom"), new Error("boom")]) {
      await expect(get(0).trackStart(() => Promise.reject(error), async () => {})).rejects.toBe(error);
    }
    await expect(get(0).assertCurrent()).resolves.toBeUndefined();
  });

  it("a later generation asks generation 0, which keeps the pointer every caller reads", async () => {
    const clock = { now: 1_000_000 };
    const { get } = placements("ws-w1", clock);
    for (let i = 0; i < 2; i += 1) await get(0).noteStartFailed(startFailure(), async () => {});
    for (let i = 0; i < 2; i += 1) await get(1).noteStartFailed(startFailure(), async () => {});
    await expect(get(0).assertCurrent()).rejects.toThrow("generation 2");
    await expect(get(1).assertCurrent()).rejects.toThrow("generation 2");
    await expect(get(2).assertCurrent()).resolves.toBeUndefined();
  });

  it("a stale request from an already retired generation does not rotate again", async () => {
    const clock = { now: 1_000_000 };
    const { get, events } = placements("ws-w1", clock);
    for (let i = 0; i < 2; i += 1) await get(0).noteStartFailed(startFailure(), async () => {});
    const result = await get(0).rotate({ fromGeneration: 0, reason: "start_failures" });
    expect(result).toEqual({ generation: 1, rotated: false, limited: false });
    expect(events.names()).toEqual(["sandbox_placement_rotated"]);
  });
});

describe("rotation bound", () => {
  it(`rotates at most ${MAX_ROTATIONS} times an hour, then again once the hour passes`, async () => {
    const clock = { now: 1_000_000 };
    const { get, events } = placements("ws-w1", clock);
    const failTwice = async (generation: number) => {
      for (let i = 0; i < 2; i += 1) {
        await get(generation).noteStartFailed(startFailure(), async () => {});
        clock.now += 1_000;
      }
    };
    for (let generation = 0; generation < MAX_ROTATIONS; generation += 1) await failTwice(generation);
    await expect(get(MAX_ROTATIONS).assertCurrent()).resolves.toBeUndefined();

    // The fourth within the hour is refused: the sandbox stays where it is.
    await failTwice(MAX_ROTATIONS);
    await expect(get(MAX_ROTATIONS).assertCurrent()).resolves.toBeUndefined();
    await expect(get(0).assertCurrent()).rejects.toThrow(`generation ${MAX_ROTATIONS}`);
    expect(events.names()).toEqual([
      ...Array.from({ length: MAX_ROTATIONS }, () => "sandbox_placement_rotated"),
      "sandbox_placement_rotation_limited",
    ]);

    clock.now += ROTATION_WINDOW_MS;
    await failTwice(MAX_ROTATIONS);
    await expect(get(0).assertCurrent()).rejects.toThrow(`generation ${MAX_ROTATIONS + 1}`);
  });
});

describe("followSandboxGeneration", () => {
  it("routes to generation 0, follows a relocation across the RPC hop, and stays on the new generation", async () => {
    const calls: string[] = [];
    const open = vi.fn((generation: number) => ({
      run: async (value: string) => {
        calls.push(`g${generation} ${value}`);
        // Across a DO RPC hop the error is a plain Error with the name in the message.
        if (generation === 0) throw new Error(new SandboxRelocatedError(2).message);
        return `g${generation}:${value}`;
      },
    }));
    const stub = followSandboxGeneration(open);
    expect(await stub.run("a")).toBe("g2:a");
    expect(await stub.run("b")).toBe("g2:b");
    expect(calls).toEqual(["g0 a", "g2 a", "g2 b"]);
    expect(open.mock.calls.map(([generation]) => generation)).toEqual([0, 2]);
  });

  it("passes other errors through without re-sending", async () => {
    const run = vi.fn(async () => {
      throw new Error("ContainerStartFailedError: nope");
    });
    const stub = followSandboxGeneration(() => ({ run }));
    await expect(stub.run()).rejects.toThrow("nope");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is not a thenable, so it can be returned from async code", async () => {
    const stub = followSandboxGeneration(() => ({ run: async () => 1 }));
    const resolved = await Promise.resolve(stub);
    expect(await resolved.run()).toBe(1);
  });

  it("routes all three classes' lookups through generation 0", async () => {
    const opened: string[] = [];
    const namespace = {
      getByName: (name: string) => {
        opened.push(name);
        return { start: async () => {}, exec: async () => ({}), prepare: async () => {} };
      },
    };
    await getDbQueryContainer({ DB_QUERY_SANDBOX: namespace as never }, dbQueryContainerKey("W1")).start();
    await getProjectBuildSandbox({ PROJECT_BUILD_SANDBOX: namespace as never }, "org1").exec("true");
    await getAnalysisSandbox({ ANALYSIS_SANDBOX: namespace as never }, { mode: "app", workspaceId: "w1" }).prepare(
      { mode: "app", workspaceId: "w1" },
    );
    expect(opened).toEqual(["ws-w1", "org-org1", "app-w1"]);
  });
});

// ---------------------------------------------------------------------------
// End to end through DbQueryContainer: real DO classes behind a fake namespace.
// ---------------------------------------------------------------------------

function fakeDbContainer(healthy: boolean) {
  let running = false;
  const container = {
    get running() {
      return running;
    },
    get images() {
      return { [DB_QUERY_IMAGE]: "img" };
    },
    start: vi.fn(() => {
      running = true;
    }),
    destroy: vi.fn(async () => {
      running = false;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    inspect: vi.fn(async () => (running ? { image: "img", labels: {} } : null)),
    exec: vi.fn(async () => {
      if (!healthy) {
        running = false;
        throw new Error(UNAVAILABLE);
      }
      return {
        stdin: null, stdout: null, stderr: null, pid: 1, isPty: false,
        exitCode: Promise.resolve(0),
        output: async () => ({ exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }),
        kill: vi.fn(), resize: vi.fn(),
      };
    }),
  };
  return container;
}

function dbQueryNamespace(healthy: (name: string) => boolean) {
  const events = fakeEvents();
  const instances = new Map<string, { instance: DbQueryContainer; container: ReturnType<typeof fakeDbContainer>; storage: ReturnType<typeof fakeStorage> }>();
  const env = { ...events.env } as unknown as Env;
  const namespace = {
    getByName: vi.fn((name: string) => {
      let entry = instances.get(name);
      if (!entry) {
        const container = fakeDbContainer(healthy(name));
        const storage = fakeStorage();
        const ctx = {
          container,
          id: { name, toString: () => name },
          exports: {},
          storage,
          blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
          waitUntil: vi.fn(),
        };
        const instance = new DbQueryContainer(ctx as unknown as DurableObjectState, env, {
          files: {} as never,
          mounts: { kind: "sync", mount: vi.fn(async () => {}), flush: vi.fn(async () => {}) },
        });
        entry = { instance, container, storage };
        instances.set(name, entry);
      }
      // A DO RPC hop turns a thrown error into a plain Error named in the message.
      return new Proxy(entry.instance, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown;
          if (typeof value !== "function") return value;
          return async (...args: unknown[]) => {
            try {
              return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            } catch (error) {
              throw error instanceof Error ? new Error(`${error.name}: ${error.message}`) : error;
            }
          };
        },
      });
    }),
  };
  (env as unknown as { DB_QUERY_SANDBOX: unknown }).DB_QUERY_SANDBOX = namespace;
  return { env, namespace, instances, events };
}

describe("DbQueryContainer placement rotation", () => {
  it("moves a workspace stuck on a bad placement to a new DO, and every caller follows", async () => {
    const { env, instances, events } = dbQueryNamespace((name) => name !== "ws-w1");
    const key = dbQueryContainerKey("w1");

    // Two whole failed starts (each retried once inside the DO).
    for (let i = 0; i < 2; i += 1) {
      const error = await getDbQueryContainer(env, key).start().catch((cause: unknown) => cause);
      expect(ContainerStartFailedError.is(error)).toBe(true);
    }
    expect(events.names()).toContain("sandbox_placement_rotated");
    const old = instances.get("ws-w1")!;
    expect(old.container.start).toHaveBeenCalledTimes(4);
    // The old generation keeps only the redirect.
    expect(old.storage.values.get(PLACEMENT_KEY)).toMatchObject({ generation: 1 });
    expect(old.storage.values.has(START_FAILURES_KEY)).toBe(false);

    // A fresh caller stub (another request) lands on generation 1 at once.
    const output = await getDbQueryContainer(env, key).runRunner({ DB_RUNNER_SRC: "x" }, 1_000);
    expect(output.exitCode).toBe(0);
    expect(instances.get("ws-w1-g1")!.container.start).toHaveBeenCalledTimes(1);
    expect(old.container.start).toHaveBeenCalledTimes(4);

    // An admin reset reaches the current generation too.
    expect(await getDbQueryContainer(env, key).destroy({ operation: "admin" })).toEqual({ destroyed: true });
    expect(instances.get("ws-w1-g1")!.container.destroy).toHaveBeenCalled();
  });

  it("keeps a workspace with one failed start where it is", async () => {
    const { env, instances, events } = dbQueryNamespace((name) => name !== "ws-w1");
    const key = dbQueryContainerKey("w1");
    await expect(getDbQueryContainer(env, key).start()).rejects.toThrow("did not start");
    expect(events.names()).not.toContain("sandbox_placement_rotated");
    expect(instances.get("ws-w1")!.storage.values.has(PLACEMENT_KEY)).toBe(false);
    // The next call still goes to (and starts) the same DO.
    await getDbQueryContainer(env, key).start().catch(() => {});
    expect(instances.get("ws-w1")!.container.start).toHaveBeenCalledTimes(4);
  });

  it("forgets a failed start once a start succeeds", async () => {
    let healthy = false;
    const { env, instances, events } = dbQueryNamespace(() => true);
    const key = dbQueryContainerKey("w1");
    await getDbQueryContainer(env, key).start();
    const entry = instances.get("ws-w1")!;
    entry.container.exec.mockImplementation(async () => {
      if (!healthy) throw new Error(UNAVAILABLE);
      return {
        stdin: null, stdout: null, stderr: null, pid: 1, isPty: false,
        exitCode: Promise.resolve(0),
        output: async () => ({ exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }),
        kill: vi.fn(), resize: vi.fn(),
      } as never;
    });
    const stub = getDbQueryContainer(env, key);
    await stub.destroy();
    await expect(stub.start()).rejects.toThrow("did not start"); // failure 1
    healthy = true;
    await stub.start(); // success clears it
    await stub.destroy();
    healthy = false;
    await expect(stub.start()).rejects.toThrow("did not start"); // failure 1 again
    expect(events.names()).not.toContain("sandbox_placement_rotated");
    expect(entry.storage.values.has(PLACEMENT_KEY)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AnalysisContainer: a later generation serves the same access.
// ---------------------------------------------------------------------------

function analysisInstance(name: string, startError?: Error) {
  let running = false;
  const container = {
    get running() {
      return running;
    },
    get images() {
      return { [ANALYSIS_IMAGE]: "img" };
    },
    start: vi.fn(() => {
      if (startError) throw startError;
      running = true;
    }),
    destroy: vi.fn(async () => {
      running = false;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    inspect: vi.fn(async () => (running ? { image: "img", labels: {} } : null)),
    interceptOutboundHttp: vi.fn(async () => {}),
    interceptAllOutboundHttp: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    exec: vi.fn(async () => ({
      stdin: null, stdout: null, stderr: null, pid: 1, isPty: false,
      exitCode: Promise.resolve(0),
      output: async () => ({ exitCode: 0, stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }),
      kill: vi.fn(), resize: vi.fn(),
    })),
  };
  const storage = fakeStorage();
  const ctx = {
    container,
    id: { name, toString: () => name },
    storage,
    blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    waitUntil: vi.fn(),
    exports: {
      AnalysisEgress: ({ props }: { props: unknown }) => ({ props }),
      AnalysisConnectionsGateway: ({ props }: { props: unknown }) => ({ props }),
    },
  };
  const instance = new AnalysisContainer(ctx as unknown as DurableObjectState, {} as Env, {
    files: {} as never,
    mounts: { kind: "live", mount: vi.fn(async () => {}), flush: vi.fn(async () => {}) },
  });
  return { instance, container, storage };
}

describe("AnalysisContainer placement rotation", () => {
  const AGENT: AnalysisAccess = { mode: "agent", orgId: "o1", workspaceId: "w1" };

  it("lets generation N serve the access its base name serves, and nothing else", async () => {
    const { instance, container } = analysisInstance("w1-g1");
    await instance.prepare(AGENT);
    expect(container.start).toHaveBeenCalledTimes(1);
    await expect(instance.prepare({ mode: "app", workspaceId: "w1" })).rejects.toThrow("cannot serve");
    await expect(analysisInstance("w2-g1").instance.prepare(AGENT)).rejects.toThrow("cannot serve");
  });

  it("retires itself after two failed starts and redirects every later call before starting anything", async () => {
    const { instance, container, storage } = analysisInstance("w1", new Error(UNAVAILABLE));
    for (let i = 0; i < 2; i += 1) {
      await expect(instance.prepare(AGENT)).rejects.toThrow("did not start");
    }
    expect(container.start).toHaveBeenCalledTimes(4);
    expect(storage.values.get(PLACEMENT_KEY)).toMatchObject({ generation: 1 });
    await expect(instance.prepare(AGENT)).rejects.toThrow("SandboxRelocatedError");
    await expect(instance.exec("true", { cwd: "/", timeoutMs: 1_000 })).rejects.toThrow("SandboxRelocatedError");
    expect(container.start).toHaveBeenCalledTimes(4);
  });
});
