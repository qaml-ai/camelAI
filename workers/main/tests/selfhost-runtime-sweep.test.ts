/**
 * The self-host thread sweep (agent-runtime/selfhost-sweep.ts): a resumable,
 * bounded-concurrency walk of every org's threads still on ChatThreadDO,
 * against real OrgDOs and D1, with the move itself substituted.
 *
 * Run with: bun run test:workers
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getAppIndexDatabase } from "../src/app-index-db";
import type { ChatContextState, ChatEnv } from "../src/chat-thread/types";
import type { RuntimeMigrationResult } from "../src/agent-runtime/thread-migration";
import {
  classifyMigration,
  getSweepReport,
  getSweepState,
  resetSweep,
  runSweepStep,
  startSweep,
} from "../src/agent-runtime/selfhost-sweep";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const sweepEnv = env as unknown as ChatEnv & { APP_DB: D1Database };

const email = () => `sweep-${crypto.randomUUID()}@example.com`;

/** Every org a test made, so the next test's sweep never finds its threads (D1's mirror re-adds orgs on its own schedule). */
const installed: Array<{ stub: { listThreadsWithoutRuntime(after: string | null, limit: number): Promise<Array<{ id: string }>>; pinThreadRuntime(id: string): Promise<boolean> } }> = [];

afterEach(async () => {
  for (const { stub } of installed.splice(0)) {
    for (const thread of await stub.listThreadsWithoutRuntime(null, 500)) await stub.pinThreadRuntime(thread.id);
  }
});

/** Orgs with `threads` ChatThreadDO threads each, and only those orgs in D1's index. */
async function install(threadsPerOrg: number[]) {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
  await testEnv.APP_DB!.prepare("DELETE FROM orgs").run();
  await resetSweep(sweepEnv);
  const orgs: Array<{ orgId: string; workspaceId: string; stub: ReturnType<typeof testEnv.ORG.get>; threads: string[] }> = [];
  for (const count of threadsPerOrg) {
    const { userId } = await createUser(testEnv, email(), "password123", "Sweeper");
    const { org, defaultWorkspaceId } = await createOrg(testEnv, "Sweep Org", userId);
    const stub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const threads: string[] = [];
    for (let index = 0; index < count; index += 1) {
      threads.push((await stub.createThread(defaultWorkspaceId as string, `Thread ${index}`, userId)).id);
    }
    await testEnv.APP_DB!.prepare("INSERT OR REPLACE INTO orgs (id, name, created_at) VALUES (?, ?, ?)").bind(org.id, "Sweep Org", Date.now()).run();
    orgs.push({ orgId: org.id, workspaceId: defaultWorkspaceId as string, stub, threads });
    installed.push({ stub: stub as never });
  }
  return orgs;
}

/** A move that pins the thread (as a real one leaves a thread_runtime row), or answers `outcomes[threadId]`. */
function fakeMigrate(outcomes: Record<string, RuntimeMigrationResult | (() => RuntimeMigrationResult)> = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const migrate = async (_env: ChatEnv, context: ChatContextState): Promise<RuntimeMigrationResult> => {
    calls.push(context.threadId);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    const given = outcomes[context.threadId];
    const result = typeof given === "function" ? given() : given;
    if (result) return result;
    await testEnv.ORG.get(testEnv.ORG.idFromName(context.orgId)).pinThreadRuntime(context.threadId);
    return { status: "runtime", row: {} as never };
  };
  return { migrate, calls, maxInFlight: () => maxInFlight };
}

/** A clock that moves only when told, and a step budget measured on it. */
function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

beforeEach(async () => {
  await getAppIndexDatabase(testEnv)!.ensureSchema();
});

describe("OrgDO.listThreadsWithoutRuntime", () => {
  it("pages threads still on ChatThreadDO in id order, leaving out pinned ones", async () => {
    const [org] = await install([4]);
    await org.stub.pinThreadRuntime(org.threads[1]);
    const sorted = org.threads.filter((id) => id !== org.threads[1]).sort();
    const first = await org.stub.listThreadsWithoutRuntime(null, 2);
    expect(first.map((thread) => thread.id)).toEqual(sorted.slice(0, 2));
    expect(first[0]).toMatchObject({ workspace_id: org.workspaceId });
    const rest = await org.stub.listThreadsWithoutRuntime(first[1].id, 10);
    expect(rest.map((thread) => thread.id)).toEqual(sorted.slice(2));
    expect(await org.stub.countThreadsWithoutRuntime()).toBe(3);
  });
});

describe("self-host thread sweep", () => {
  it("moves every org's threads, resuming from its cursor step after step, and marks the sweep complete", async () => {
    const orgs = await install([3, 0, 5]);
    const fake = fakeMigrate();
    await startSweep(sweepEnv);
    // Each step may start one page (2 threads) before its budget, measured on a clock each move advances, runs out.
    const time = clock();
    const step = () => runSweepStep(sweepEnv, { probe: async () => true, 
      migrate: async (stepEnv, context) => { time.advance(1_000); return fake.migrate(stepEnv, context); },
      pageSize: 2,
      budgetMs: 1_500,
      concurrency: 2,
      now: time.now,
    });
    const first = await step();
    expect(first.status).toBe("running");
    expect(first.counts.migrated).toBe(2);
    expect(first.cursor.orgId).not.toBeNull();
    // What the first step saved is what the next reads: a restart resumes there.
    expect((await getSweepState(sweepEnv)).cursor).toEqual(first.cursor);
    let state = first;
    for (let index = 0; index < 20 && state.status === "running"; index += 1) state = await step();
    expect(state).toMatchObject({ status: "complete", remaining: 0, counts: { migrated: 8, skipped: 0, retrying: 0 } });
    expect(state.completedAt).toBe(time.now());
    // Each thread was moved exactly once.
    expect(fake.calls.sort()).toEqual(orgs.flatMap((org) => org.threads).sort());
    for (const org of orgs) expect(await org.stub.countThreadsWithoutRuntime()).toBe(0);
  });

  it("moves at most `concurrency` threads at once", async () => {
    await install([12]);
    const fake = fakeMigrate();
    await startSweep(sweepEnv);
    const state = await runSweepStep(sweepEnv, { probe: async () => true,  migrate: fake.migrate, concurrency: 3, pageSize: 12 });
    expect(state.status).toBe("complete");
    expect(fake.calls).toHaveLength(12);
    expect(fake.maxInFlight()).toBe(3);
  });

  it("reports skipped threads with reasons, retries busy ones later, and completes with what it could not move", async () => {
    const [org] = await install([4]);
    const [tooLarge, noRoute, busy] = org.threads;
    let busyTries = 0;
    const fake = fakeMigrate({
      [tooLarge]: { status: "skipped", reason: "too_large" },
      [noRoute]: { status: "skipped", reason: "no runtime route for its model" },
      [busy]: () => (++busyTries === 1 ? { status: "busy", reason: "a turn is running" } : undefined as never),
    });
    const time = clock();
    const step = () => runSweepStep(sweepEnv, { probe: async () => true,  migrate: fake.migrate, now: time.now });
    await startSweep(sweepEnv, { now: time.now });

    const first = await step();
    expect(first).toMatchObject({ status: "waiting", counts: { migrated: 1, skipped: 2, retrying: 1 }, remaining: 3 });
    expect(first.nextPassAt).toBe(time.now() + 60_000);
    const report = await getSweepReport(sweepEnv);
    expect(report.skipped.map((record) => [record.threadId, record.reason]).sort()).toEqual([
      [tooLarge, "too_large"],
      [noRoute, "no runtime route for its model"],
    ].sort());
    expect(report.retrying).toMatchObject([{ threadId: busy, reason: "busy: a turn is running", attempts: 1 }]);

    // Not due yet: nothing happens.
    expect((await step()).status).toBe("waiting");
    time.advance(60_000);
    const second = await step();
    // The retry moved; skipped threads are not tried again within this start.
    expect(second).toMatchObject({ status: "complete", pass: 2, remaining: 2, counts: { migrated: 1, skipped: 0, retrying: 0 } });
    expect(fake.calls.filter((id) => id === busy)).toHaveLength(2);
    expect(fake.calls.filter((id) => id === noRoute)).toHaveLength(1);

    // The next start tries the one whose model may have a route now, never the one too large to import.
    await startSweep(sweepEnv, { now: time.now });
    const third = await step();
    expect(third).toMatchObject({ status: "complete", pass: 3, remaining: 2 });
    expect(fake.calls.filter((id) => id === noRoute)).toHaveLength(2);
    expect(fake.calls.filter((id) => id === tooLarge)).toHaveLength(1);
  });

  it("drops the record of a thread moved some other way (on open)", async () => {
    const [org] = await install([2]);
    const fake = fakeMigrate({ [org.threads[0]]: { status: "failed", error: "runtime unreachable" } });
    const time = clock();
    await startSweep(sweepEnv, { now: time.now });
    expect((await runSweepStep(sweepEnv, { probe: async () => true,  migrate: fake.migrate, now: time.now })).status).toBe("waiting");
    // Opened by a user meanwhile: moved on open, so it has a row.
    await org.stub.pinThreadRuntime(org.threads[0]);
    time.advance(60 * 60_000);
    const state = await runSweepStep(sweepEnv, { probe: async () => true,  migrate: fake.migrate, now: time.now });
    expect(state).toMatchObject({ status: "complete", remaining: 0 });
    expect((await getSweepReport(sweepEnv)).retrying).toEqual([]);
  });

  it("stops, blocked, while the agent runtime is not configured, and a start resumes a pass under way", async () => {
    await install([2]);
    await startSweep(sweepEnv);
    const blocked = await runSweepStep(sweepEnv, { probe: async () => true,  migrate: async () => ({ status: "skipped", reason: "the agent runtime is not configured" }) });
    expect(blocked).toMatchObject({ status: "blocked", error: "the agent runtime is not configured" });
    const restarted = await startSweep(sweepEnv);
    expect(restarted).toMatchObject({ status: "running", pass: blocked.pass + 1 });
    // A start while a pass runs (the app restarted) resumes it rather than starting over.
    expect(await startSweep(sweepEnv)).toEqual(restarted);
  });

  it("starts no move once the budget is spent, and resumes at the first thread it did not try (S1)", async () => {
    const [org] = await install([6]);
    const fake = fakeMigrate();
    const time = clock();
    await startSweep(sweepEnv, { now: time.now });
    const options = {
      probe: async () => true,
      migrate: async (stepEnv: ChatEnv, context: ChatContextState) => { time.advance(1_000); return fake.migrate(stepEnv, context); },
      pageSize: 6,
      concurrency: 1,
      budgetMs: 2_500,
      now: time.now,
    };
    const sorted = [...org.threads].sort();
    const first = await runSweepStep(sweepEnv, options);
    expect(fake.calls).toEqual(sorted.slice(0, 3));
    expect(first.cursor).toEqual({ orgId: org.orgId, threadId: sorted[2] });
    await runSweepStep(sweepEnv, options);
    expect(fake.calls.slice(3, 4)).toEqual([sorted[3]]);
  });

  it("runs one step at a time, and leaves a move that takes too long to finish on its own (S1)", async () => {
    const [org] = await install([2]);
    await startSweep(sweepEnv);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = runSweepStep(sweepEnv, {
      probe: async () => true,
      concurrency: 1,
      pageSize: 1,
      migrate: async () => { await held; return { status: "runtime", row: {} as never }; },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const other = await runSweepStep(sweepEnv, { probe: async () => true, migrate: async () => { throw new Error("must not run"); } });
    expect(other.stepInProgress).toBe(true);
    release();
    await slow;

    const stuck = await runSweepStep(sweepEnv, { probe: async () => true, moveTimeoutMs: 10, migrate: () => new Promise(() => {}) });
    expect(stuck.counts.retrying).toBeGreaterThan(0);
    expect((await getSweepReport(sweepEnv)).retrying[0]).toMatchObject({ reason: "busy: the move is still going" });
    void org;
  });

  it("pauses when the runtime does not answer, or moves keep failing, and moves nothing meanwhile (S2)", async () => {
    await install([8]);
    const time = clock();
    await startSweep(sweepEnv, { now: time.now });
    const fake = fakeMigrate();
    const down = await runSweepStep(sweepEnv, { probe: async () => false, migrate: fake.migrate, now: time.now });
    expect(down.pausedUntil).toBe(time.now() + 60_000);
    expect(fake.calls).toEqual([]);
    expect((await runSweepStep(sweepEnv, { probe: async () => true, migrate: fake.migrate, now: time.now })).pausedUntil).toBe(down.pausedUntil);
    expect(fake.calls).toEqual([]);
    time.advance(60_001);
    const failing = await runSweepStep(sweepEnv, { probe: async () => true, concurrency: 1, now: time.now, migrate: async () => ({ status: "failed", error: "runtime 503" }) });
    expect(failing.counts.checked).toBe(5);
    expect(failing.pausedUntil).toBe(time.now() + 2 * 60_000);
    expect(failing.breakerTrips).toBe(2);
  });

  it("gives up on a thread that keeps failing: skipped, with the reason (S4)", async () => {
    const [org] = await install([1]);
    const time = clock();
    await startSweep(sweepEnv, { now: time.now });
    const fake = fakeMigrate({ [org.threads[0]]: { status: "busy", reason: "a turn is running" } });
    await runSweepStep(sweepEnv, { probe: async () => true, migrate: fake.migrate, now: time.now });
    await testEnv.APP_DB!.prepare("UPDATE selfhost_runtime_sweep_threads SET attempts = 11, next_attempt_at = 0").run();
    time.advance(60 * 60_000);
    const state = await runSweepStep(sweepEnv, { probe: async () => true, migrate: fake.migrate, now: time.now });
    expect(state).toMatchObject({ status: "complete", remaining: 1 });
    expect((await getSweepReport(sweepEnv)).skipped[0].reason).toBe("gave up after 12 attempts: busy: a turn is running");
  });

  it("passes over an org it cannot read, with a record, and moves the others' threads (S5)", async () => {
    const [bad, good] = await install([1, 2]);
    const real = testEnv.ORG as unknown as DurableObjectNamespace;
    const env = {
      ...sweepEnv,
      ORG: {
        idFromName: (name: string) => ({ name, id: real.idFromName(name) }),
        get: (id: { name: string; id: DurableObjectId }) => (id.name === bad.orgId
          ? { listThreadsWithoutRuntime: async () => { throw new Error("OrgDO reset"); }, countThreadsWithoutRuntime: async () => { throw new Error("OrgDO reset"); } }
          : real.get(id.id)),
      },
    } as unknown as ChatEnv & { APP_DB: D1Database };
    const fake = fakeMigrate();
    await startSweep(env);
    const state = await runSweepStep(env, { probe: async () => true, migrate: fake.migrate });
    expect(fake.calls.sort()).toEqual([...good.threads].sort());
    expect(state.status).toBe("waiting");
    expect((await getSweepReport(env)).retrying).toMatchObject([{ threadId: `org:${bad.orgId}`, reason: expect.stringContaining("could not read the org") }]);
  });

  it("counts every org's threads before it says complete: one that came meanwhile starts another pass (S6)", async () => {
    const orgs = await install([1, 1]);
    const [first] = [...orgs].sort((left, right) => (left.orgId < right.orgId ? -1 : 1));
    const fake = fakeMigrate();
    await startSweep(sweepEnv);
    const late: string[] = [];
    const state = await runSweepStep(sweepEnv, {
      probe: async () => true,
      migrate: async (stepEnv, context) => {
        // A thread made in an org the pass already walked.
        if (context.orgId !== first.orgId && late.length === 0) {
          late.push((await first.stub.createThread(first.workspaceId, "Late", "u")).id);
        }
        return fake.migrate(stepEnv, context);
      },
    });
    expect(state).toMatchObject({ status: "running", pass: 2 });
    const next = await runSweepStep(sweepEnv, { probe: async () => true, migrate: fake.migrate });
    expect(next).toMatchObject({ status: "complete", remaining: 0, completedRemaining: 0 });
    expect(fake.calls).toContain(late[0]);
  });

  it("classifies every result of a move", () => {
    expect(classifyMigration({ status: "migrated", row: {} as never, stats: {} as never, archived: false })).toEqual({ outcome: "migrated" });
    expect(classifyMigration({ status: "adopted", row: {} as never })).toEqual({ outcome: "migrated" });
    expect(classifyMigration({ status: "skipped", reason: "moved" })).toEqual({ outcome: "migrated" });
    expect(classifyMigration({ status: "skipped", reason: "backoff: lease ran out" })).toMatchObject({ outcome: "retry" });
    expect(classifyMigration({ status: "failed", error: "x" })).toMatchObject({ outcome: "retry", reason: "failed: x" });
    expect(classifyMigration({ status: "skipped", reason: "too_large" })).toEqual({ outcome: "skipped", reason: "too_large" });
    // A model that did not resolve just now is tried again (S3).
    expect(classifyMigration({ status: "skipped", reason: "its model did not resolve: gone" })).toMatchObject({ outcome: "retry" });
    expect(classifyMigration({ status: "skipped", reason: "invalid_history: initialMessages[3]" })).toMatchObject({ outcome: "skipped" });
  });
});
