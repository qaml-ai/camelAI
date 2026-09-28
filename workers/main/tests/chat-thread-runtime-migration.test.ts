/**
 * ChatThreadDO's side of moving a thread to the agent runtime: the handover
 * lease and the turn guard (agent-runtime/thread-migration.ts drives it).
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it, vi } from "vitest";
import { ChatThreadDO } from "../src/chat-thread-do";

type Fake = Record<string, unknown> & { store: Map<string, unknown> };

function fakeThread(options: { streaming?: boolean; automation?: boolean; questions?: number; relay?: boolean; load?: () => Promise<unknown[]> } = {}): Fake {
  const store = new Map<string, unknown>();
  if (options.relay) store.set("runtimeAgent", { id: "agt_relay", token: "t" });
  const fake = Object.create(ChatThreadDO.prototype) as Fake;
  fake.store = store;
  fake.ctx = { storage: { kv: { get: (key: string) => store.get(key), put: (key: string, value: unknown) => { store.set(key, value); }, delete: (key: string) => store.delete(key) } } };
  fake.env = { APP_KV: { get: async () => null } };
  fake.chatContext = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
  fake.isThreadStreaming = () => options.streaming ?? false;
  fake.activeAutomationRun = options.automation ? { runId: "r" } : null;
  fake.browserPrompts = { pendingQuestionCount: options.questions ?? 0 };
  fake.previewTabs = [{ kind: "app", scriptName: "shop", isPublic: true }];
  fake.previewActiveTabId = "app:shop";
  fake.loadFullPiCoreTranscriptUnbounded = vi.fn(options.load ?? (async () => [{ role: "user", content: "hi", timestamp: 1 }]));
  return fake;
}

const call = <T>(fake: Fake, method: string, ...args: unknown[]): Promise<T> =>
  Promise.resolve((ChatThreadDO.prototype as unknown as Record<string, (...a: unknown[]) => T>)[method].call(fake, ...args));

describe("ChatThreadDO runtime migration", () => {
  it("hands over the transcript and preview state, and holds the thread while moving", async () => {
    const fake = fakeThread();
    const handover = await call<{ status: string; leaseId: string }>(fake, "beginRuntimeMigration");
    expect(handover).toMatchObject({
      status: "ok",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      previewTabs: [{ kind: "app", scriptName: "shop", isPublic: true }],
      previewActiveTabId: "app:shop",
    });
    expect(fake.loadFullPiCoreTranscriptUnbounded).toHaveBeenCalledWith({ imagePolicy: "reference" });
    expect(await call(fake, "beginRuntimeMigration")).toEqual({ status: "busy", reason: "moving" });
    expect(await call(fake, "enqueueRunnerUserMessage", { type: "message", content: "hello" }))
      .toEqual({ status: "busy", error: "This conversation is moving; try again in a moment." });
  });

  it("lets the thread run here again after an abort, or once the lease runs out", async () => {
    const fake = fakeThread();
    const { leaseId } = await call<{ leaseId: string }>(fake, "beginRuntimeMigration");
    expect(await call(fake, "abortRuntimeMigration", "someone-else")).toBe(false);
    expect(await call(fake, "abortRuntimeMigration", leaseId)).toBe(true);
    expect(fake.store.has("runtimeMigration")).toBe(false);

    await call(fake, "beginRuntimeMigration");
    const record = fake.store.get("runtimeMigration") as { expiresAt: number };
    record.expiresAt = Date.now() - 1;
    expect(await call(fake, "beginRuntimeMigration")).toMatchObject({ status: "ok" });
  });

  it("refuses turns for good once moved", async () => {
    const fake = fakeThread();
    const { leaseId } = await call<{ leaseId: string }>(fake, "beginRuntimeMigration");
    expect(await call(fake, "completeRuntimeMigration", leaseId, "agt_new")).toBe(true);
    expect(fake.store.get("runtimeMigration")).toMatchObject({ agentId: "agt_new", movedAt: expect.any(Number) });
    expect(await call(fake, "abortRuntimeMigration", leaseId)).toBe(false);
    expect(await call(fake, "beginRuntimeMigration")).toEqual({ status: "moved" });
    expect(await call(fake, "enqueueRunnerUserMessage", { type: "message", content: "hello" }))
      .toEqual({ status: "error", error: "This conversation moved; reload the page to continue it." });
  });

  it("waits out a running turn, an automation run or an open question, and points a relay thread at adoption", async () => {
    expect(await call(fakeThread({ streaming: true }), "beginRuntimeMigration")).toEqual({ status: "busy", reason: "running" });
    expect(await call(fakeThread({ automation: true }), "beginRuntimeMigration")).toEqual({ status: "busy", reason: "automation" });
    expect(await call(fakeThread({ questions: 1 }), "beginRuntimeMigration")).toEqual({ status: "busy", reason: "question" });
    const relay = fakeThread({ relay: true });
    expect(await call(relay, "beginRuntimeMigration")).toEqual({ status: "relay" });
    expect(relay.store.has("runtimeMigration")).toBe(false);
  });

  it("releases the hold when the transcript cannot be read", async () => {
    const fake = fakeThread({ load: async () => { throw new Error("boom"); } });
    let error: unknown;
    try { await call(fake, "beginRuntimeMigration"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(fake.store.has("runtimeMigration")).toBe(false);
  });
});
