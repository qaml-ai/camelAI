import { describe, expect, it, vi } from "vitest";

import { IN_APP_LOOP_REMOVED, runtimeMigrationGate } from "../scripts/selfhost-runtime-gate.mjs";
import { driveRuntimeSweep, sweepDoctorReport, sweepSummary } from "../scripts/selfhost-runtime-sweep.mjs";

const complete = { status: "complete", pass: 3, completedAt: 1, remaining: 0, counts: { migrated: 10, skipped: 0, retrying: 0 } };

describe("runtime migration gate", () => {
  it("never refuses while this release still has the in-app loop", () => {
    expect(IN_APP_LOOP_REMOVED).toBe(false);
    expect(runtimeMigrationGate({ sweep: null, orgCount: 5 })).toEqual({ ok: true, message: null });
  });

  describe("in the release that removes the in-app loop", () => {
    const gate = (input: Parameters<typeof runtimeMigrationGate>[0]) => runtimeMigrationGate({ loopRemoved: true, ...input });

    it("starts a new install, and one whose sweep moved every thread", () => {
      expect(gate({ sweep: null, orgCount: 0 }).ok).toBe(true);
      expect(gate({ sweep: complete, orgCount: 3 })).toEqual({ ok: true, message: null });
    });

    it("refuses an install that skipped the releases with the sweep, pointing at the doc", () => {
      const result = gate({ sweep: null, orgCount: 2 });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/skipped the releases that move them/);
      expect(result.message).toContain("SELF_HOSTING.md#moving-existing-threads");
    });

    it("refuses while the sweep has not finished", () => {
      const result = gate({ sweep: { ...complete, status: "waiting", completedAt: null, counts: { migrated: 4, skipped: 1, retrying: 2 } }, orgCount: 2 });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/status waiting, pass 3: 4 moved, 2 to retry, 1 skipped/);
    });

    it("goes by the last complete pass while a later one rechecks, and lets the operator accept a waiting sweep (S4)", () => {
      const rechecking = { ...complete, status: "running", completedAt: 5, completedRemaining: 0, counts: { migrated: 0, skipped: 0, retrying: 0 } };
      expect(gate({ sweep: rechecking, orgCount: 2 })).toEqual({ ok: true, message: null });
      expect(gate({ sweep: { ...rechecking, completedRemaining: 3 }, orgCount: 2 }).ok).toBe(false);
      const waiting = { ...complete, status: "waiting", completedAt: null, completedRemaining: null, remaining: 2 };
      expect(gate({ sweep: waiting, orgCount: 2 }).ok).toBe(false);
      expect(gate({ sweep: waiting, orgCount: 2, allowUnmigrated: true })).toMatchObject({ ok: true, message: expect.stringMatching(/2 thread/) });
    });

    it("refuses threads the sweep skipped unless the operator accepts losing them", () => {
      const skipped = { ...complete, remaining: 2 };
      expect(gate({ sweep: skipped, orgCount: 1 })).toMatchObject({ ok: false, message: expect.stringMatching(/2 chat threads were not moved[\s\S]*SELFHOST_ALLOW_UNMIGRATED_THREADS=1/) });
      expect(gate({ sweep: skipped, orgCount: 1, allowUnmigrated: true })).toMatchObject({ ok: true, message: expect.stringMatching(/2 thread/) });
    });
  });
});

describe("runtime sweep driver", () => {
  it("starts a pass, steps it until it is waiting, and logs progress only when it changes", async () => {
    const states = [
      { status: "running", pass: 1, counts: { migrated: 0, retrying: 0, skipped: 0 } },
      { status: "running", pass: 1, counts: { migrated: 5, retrying: 0, skipped: 0 } },
      { status: "running", pass: 1, counts: { migrated: 5, retrying: 0, skipped: 0 } },
      { status: "waiting", pass: 1, nextPassAt: 61_000, counts: { migrated: 9, retrying: 1, skipped: 0 } },
    ];
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer admin-key");
      return Response.json(states.shift());
    }) as unknown as typeof fetch;
    const logged: string[] = [];
    const sleeps: number[] = [];
    await driveRuntimeSweep({
      baseUrl: "http://127.0.0.1:3001",
      adminKey: "admin-key",
      fetchImpl,
      log: { log: (line: string) => logged.push(line) } as unknown as Console,
      sleep: async (ms: number) => { sleeps.push(ms); },
      now: () => 1_000,
      maxSteps: 4,
    });
    expect(bodies).toEqual([{ action: "start" }, { action: "step" }, { action: "step" }, { action: "step" }]);
    expect(logged).toHaveLength(3);
    expect(logged.at(-1)).toMatch(/waiting for retries \(pass 1: 9 moved, 1 to retry, 0 skipped\)/);
    expect(sleeps).toEqual([60_000]);
  });

  it("waits out a paused sweep and a step another caller holds, and gives a step longer than its worst case (S1, S2)", async () => {
    const states = [
      { status: "running", pass: 1, counts: {} },
      { status: "running", pass: 1, pausedUntil: 91_000, error: "the agent runtime does not answer", counts: {} },
      { status: "running", pass: 1, stepInProgress: true, counts: {} },
    ];
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return Response.json(states.shift());
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    await driveRuntimeSweep({
      baseUrl: "http://x",
      adminKey: "k",
      fetchImpl,
      log: { log: () => {} } as unknown as Console,
      sleep: async (ms: number) => { sleeps.push(ms); },
      now: () => 1_000,
      maxSteps: 3,
    });
    expect(sleeps).toEqual([90_000, 5_000]);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("backs off and keeps going when the app refuses a step", async () => {
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const sleeps: number[] = [];
    await driveRuntimeSweep({
      baseUrl: "http://x",
      adminKey: "k",
      fetchImpl,
      log: { warn: () => {} } as unknown as Console,
      sleep: async (ms: number) => { sleeps.push(ms); },
      maxSteps: 2,
    });
    expect(sleeps).toEqual([30_000, 30_000]);
  });
});

describe("selfhost:doctor sweep report", () => {
  it("passes a complete sweep, and lists the threads it could not move by reason", () => {
    expect(sweepDoctorReport({ ...complete, skipped: [], retrying: [] })).toMatchObject({ level: "pass" });
    const report = sweepDoctorReport({
      ...complete,
      remaining: 3,
      skipped: [
        { orgId: "o1", threadId: "t1", reason: "too_large" },
        { orgId: "o1", threadId: "t2", reason: "no runtime route for its model" },
      ],
      retrying: [{ orgId: "o2", threadId: "t3", reason: "busy: a turn is running" }],
    }, { limit: 5 });
    expect(report.level).toBe("warn");
    expect(report.lines).toEqual([
      "complete (pass 3: 10 moved, 0 to retry, 0 skipped; 3 not moved)",
      "skipped (too_large): 1 - o1/t1",
      "skipped (no runtime route for its model): 1 - o1/t2",
      "retrying (busy): 1 - o2/t3",
    ]);
    expect(sweepSummary({ status: "blocked", error: "direct threads are off" })).toBe("blocked: direct threads are off");
  });
});
