/**
 * The cloud thread sweep (agent-runtime/cloud-sweep.ts): recently active
 * threads, newest first, moved at a bounded pace, against D1, with the move,
 * the runtime-row check and the size read substituted and a clock the test
 * drives.
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getAppIndexDatabase } from "../src/app-index-db";
import type { ChatContextState, ChatEnv } from "../src/chat-thread/types";
import type { RuntimeMigrationResult } from "../src/agent-runtime/thread-migration";
import {
  LARGE_THREAD_CHARS,
  getCloudSweepReport,
  getCloudSweepState,
  pauseCloudSweep,
  runCloudSweepStep,
  startCloudSweep,
  type CloudSweepOptions,
} from "../src/agent-runtime/cloud-sweep";
import type { TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const DAY = 24 * 60 * 60_000;
// Far from the real clock: rows the D1 mirror adds on its own schedule are never this recent.
const T0 = Date.UTC(2100, 0, 1);
const FLAGS = { AGENT_RUNTIME_API_TOKEN: "t", AGENT_RUNTIME_TENANT: "x", AGENT_RUNTIME_DEFINITION: "d", AGENT_RUNTIME_DIRECT_THREADS: "1" };

function sweepEnv(migrateFlag = "1") {
  return { ...(env as object), ...FLAGS, AGENT_RUNTIME_MIGRATE_DO_THREADS: migrateFlag } as unknown as ChatEnv & { APP_DB: D1Database };
}

/** Thread index rows: [id, org, days before T0 it was last updated]. */
async function install(threads: Array<[string, string, number]>) {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
  await testEnv.APP_DB!.prepare("DELETE FROM threads WHERE updated_at >= ?").bind(T0 - 3650 * DAY).run();
  for (const [id, org, daysAgo] of threads) {
    await testEnv.APP_DB!
      .prepare("INSERT OR REPLACE INTO threads (id, org_id, workspace_id, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, org, `ws-${org}`, T0 - 400 * DAY, T0 - daysAgo * DAY, "u1")
      .run();
  }
}

/** A clock the sweep's waits advance, and a fake move that takes `moveMs` of it. */
function harness(options: {
  outcomes?: Record<string, RuntimeMigrationResult | Array<RuntimeMigrationResult>>;
  onRuntime?: string[];
  sizes?: Record<string, number>;
  moveMs?: number;
} = {}) {
  let time = T0;
  const starts: Array<{ id: string; at: number }> = [];
  const moved = new Set<string>(options.onRuntime ?? []);
  let inFlight = 0;
  let maxInFlight = 0;
  let bigOverlap = false;
  const running = new Set<string>();
  const sleep = async (ms: number) => {
    time += Math.max(1, ms);
    await Promise.resolve();
  };
  const migrate = async (_env: ChatEnv, context: ChatContextState, { dryRun }: { dryRun: boolean }): Promise<RuntimeMigrationResult> => {
    starts.push({ id: context.threadId, at: time });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    running.add(context.threadId);
    const big = (options.sizes?.[context.threadId] ?? 0) > LARGE_THREAD_CHARS;
    if ([...running].some((id) => id !== context.threadId && ((options.sizes?.[id] ?? 0) > LARGE_THREAD_CHARS || big))) bigOverlap = true;
    await sleep(options.moveMs ?? 100);
    running.delete(context.threadId);
    inFlight -= 1;
    const given = options.outcomes?.[context.threadId];
    const result = Array.isArray(given) ? given.shift() : given;
    if (result) return result;
    if (dryRun) return { status: "dry_run", stats: { total: 2 } as never, lossy: context.threadId.endsWith("lossy"), bytes: context.threadId.length * 100 };
    moved.add(context.threadId);
    return { status: "migrated", row: {} as never, stats: {} as never, archived: false };
  };
  const step: CloudSweepOptions = {
    now: () => time,
    sleep,
    migrate,
    probe: async () => true,
    runtimeRow: async (_env, thread) => (moved.has(thread.id) ? ({ agentId: "agt" } as never) : null),
    size: async (_env, thread) => options.sizes?.[thread.id] ?? 1_000,
    budgetMs: 60_000,
  };
  return {
    step,
    starts,
    moved,
    maxInFlight: () => maxInFlight,
    bigOverlap: () => bigOverlap,
    now: () => time,
    advance: (ms: number) => { time += ms; },
  };
}

beforeEach(async () => {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
});

describe("the cloud sweep", () => {
  it("moves threads active in the window, newest first, where the flag is on for their org, and completes", async () => {
    await install([
      ["t-new", "org-a", 1],
      ["t-mid", "org-b", 5],
      ["t-old", "org-a", 45],
      ["t-other", "org-c", 2],
      ["t-done", "org-a", 3],
    ]);
    const env = sweepEnv("org-a,org-b");
    const h = harness({ onRuntime: ["t-done"] });
    await startCloudSweep(env, { now: h.step.now, restart: true });
    const state = await runCloudSweepStep(env, h.step);
    expect(h.starts.map((start) => start.id)).toEqual(["t-new", "t-mid"]);
    expect(state).toMatchObject({ status: "complete", counts: { migrated: 2, alreadyOnRuntime: 1, notEnabled: 1, skipped: 0, retrying: 0 } });
    // A start again is a new sweep; the same settings under way are returned as they are.
    expect((await startCloudSweep(env, { now: h.step.now })).status).toBe("running");
    expect((await startCloudSweep(env, { now: h.step.now })).startedAt).toBe(h.now());
  });

  it("starts about two moves a second, four at most in flight, and a thread over 4 MB alone", async () => {
    const threads: Array<[string, string, number]> = Array.from({ length: 12 }, (_, index) => [`t-${String(index).padStart(2, "0")}`, "org-a", 1 + index / 100]);
    await install(threads);
    const env = sweepEnv();
    const h = harness({ moveMs: 3_000, sizes: { "t-05": LARGE_THREAD_CHARS + 1 } });
    await startCloudSweep(env, { now: h.step.now, restart: true });
    await runCloudSweepStep(env, h.step);
    expect(h.starts).toHaveLength(12);
    for (let index = 1; index < h.starts.length; index += 1) {
      expect(h.starts[index].at - h.starts[index - 1].at).toBeGreaterThanOrEqual(500);
    }
    expect(h.maxInFlight()).toBeLessThanOrEqual(4);
    expect(h.maxInFlight()).toBeGreaterThan(1);
    expect(h.bigOverlap()).toBe(false);
  });

  it("pauses for the runtime's Retry-After, and goes on after it", async () => {
    await install([["t-1", "org-a", 1], ["t-2", "org-a", 2], ["t-3", "org-a", 3]]);
    const env = sweepEnv();
    const h = harness({ outcomes: { "t-1": [{ status: "failed", error: "HTTP 429", retryAfterMs: 120_000 }] } });
    await startCloudSweep(env, { now: h.step.now, restart: true });
    const paused = await runCloudSweepStep(env, { ...h.step, concurrency: 1 });
    expect(paused.pausedUntil).toBeGreaterThanOrEqual(h.now() + 100_000);
    expect(paused.error).toContain("Retry-After 120 s");
    expect(h.starts.map((start) => start.id)).toEqual(["t-1"]);
    // Still paused: nothing starts.
    await runCloudSweepStep(env, h.step);
    expect(h.starts).toHaveLength(1);
    h.advance(121_000);
    const done = await runCloudSweepStep(env, h.step);
    // The rest, then the thread it paused on, whose retry is due by then.
    expect(h.starts.map((start) => start.id)).toEqual(["t-1", "t-2", "t-3", "t-1"]);
    expect(done).toMatchObject({ status: "complete", pausedUntil: null });
  });

  it("retries a thread that could not move, then completes", async () => {
    await install([["t-busy", "org-a", 1], ["t-ok", "org-a", 2]]);
    const env = sweepEnv();
    const h = harness({ outcomes: { "t-busy": [{ status: "busy", reason: "running" }] } });
    await startCloudSweep(env, { now: h.step.now, restart: true });
    const waiting = await runCloudSweepStep(env, h.step);
    expect(waiting).toMatchObject({ status: "waiting", phase: "retry", counts: { migrated: 1, retrying: 1 } });
    expect((await getCloudSweepReport(env)).retrying.map((record) => record.threadId)).toEqual(["t-busy"]);
    // Not due yet.
    await runCloudSweepStep(env, h.step);
    expect(h.starts).toHaveLength(2);
    h.advance(61_000);
    const done = await runCloudSweepStep(env, h.step);
    expect(done).toMatchObject({ status: "complete", counts: { migrated: 2 } });
    expect((await getCloudSweepReport(env)).totals).toEqual({ skipped: 0, retrying: 0 });
  });

  it("trips the breaker when moves keep failing", async () => {
    await install(Array.from({ length: 8 }, (_, index) => [`t-${index}`, "org-a", 1 + index / 100] as [string, string, number]));
    const env = sweepEnv();
    const failed: RuntimeMigrationResult = { status: "failed", error: "runtime 500" };
    const h = harness({ outcomes: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`t-${index}`, failed])) });
    await startCloudSweep(env, { now: h.step.now, restart: true });
    const state = await runCloudSweepStep(env, h.step);
    expect(state.breakerTrips).toBe(1);
    expect(state.pausedUntil).toBeGreaterThan(h.now());
    expect(state.error).toContain("moves failed");
    expect(h.starts.length).toBeLessThan(8);
  });

  it("resumes where a step stopped, without trying a thread twice", async () => {
    await install(Array.from({ length: 6 }, (_, index) => [`t-${index}`, "org-a", 1 + index / 100] as [string, string, number]));
    const env = sweepEnv();
    const h = harness();
    await startCloudSweep(env, { now: h.step.now, restart: true });
    await runCloudSweepStep(env, { ...h.step, budgetMs: 1_200, concurrency: 1 });
    const first = h.starts.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6);
    await runCloudSweepStep(env, h.step);
    // Moves in flight together may start in any order; each thread starts once.
    const ids = h.starts.map((start) => start.id);
    expect(ids.slice(0, first)).toEqual(["t-0", "t-1", "t-2"].slice(0, first));
    expect([...ids].sort()).toEqual(["t-0", "t-1", "t-2", "t-3", "t-4", "t-5"]);
    expect((await getCloudSweepState(env)).status).toBe("complete");
  });

  it("dry-runs every org whatever the flag, moving nothing, and tallies what it would import", async () => {
    await install([["t-a", "org-a", 1], ["t-b-lossy", "org-b", 2]]);
    const env = sweepEnv("org-a");
    const h = harness();
    await startCloudSweep(env, { now: h.step.now, restart: true, dryRun: true });
    const state = await runCloudSweepStep(env, h.step);
    expect(h.moved.size).toBe(0);
    expect(state).toMatchObject({
      status: "complete",
      dryRun: true,
      counts: { wouldMove: 2, wouldBeLossy: 1, migrated: 0, notEnabled: 0, largestBytes: 900, largestThreadId: "t-b-lossy" },
    });
  });

  it("does nothing while paused, and resumes on the next start", async () => {
    await install([["t-1", "org-a", 1]]);
    const env = sweepEnv();
    const h = harness();
    await startCloudSweep(env, { now: h.step.now, restart: true });
    expect((await pauseCloudSweep(env, h.now())).status).toBe("paused");
    expect((await runCloudSweepStep(env, h.step)).status).toBe("paused");
    expect(h.starts).toHaveLength(0);
    expect((await startCloudSweep(env, { now: h.step.now })).status).toBe("running");
    expect((await runCloudSweepStep(env, h.step)).status).toBe("complete");
    expect(h.starts).toHaveLength(1);
  });
});
