import { describe, expect, it, vi } from "vitest";
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import {
  createOrg,
  createUser,
  createWorkspace,
  listOrgWorkspaces,
  type TestEnv,
} from "./test-helpers";
import { bridgeWorkspaceStatusStream } from "../src/workspace-status-stream";
import {
  createSignedSession,
  type SignedSessionData,
} from "../src/signed-session";

type WorkspaceStatusStub = DurableObjectStub<{
  recordThreadStreaming(
    threadId: string,
    isStreaming: boolean,
    options?: {
      completedAt?: number;
      summaryStatus?: "pending" | "ready" | "failed" | null;
      summary?: string | null;
      activityText?: string | null;
      activityAt?: number | null;
      clearOnlyIfRunning?: boolean;
      clearRunningStartedAtOrBefore?: number | null;
      clearRunningStartedAt?: number;
      startedAt?: number;
    },
  ): Promise<void>;
  listStreamingThreadIds(): Promise<string[]>;
  listStreamingThreadStatuses(): Promise<
    Array<{
      threadId: string;
      startedAt: number;
      updatedAt: number;
      latestActivityText: string | null;
      latestActivityAt: number | null;
    }>
  >;
}>;

const testEmail = () =>
  `workspace-status-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

type StatusFrame = Record<string, unknown>;

/**
 * Read a never-ending `text/event-stream` body incrementally: `response.text()`
 * would hang on a status stream, which only ends when the reader cancels.
 */
function readStatusStream(response: Response): {
  frames: StatusFrame[];
  comments: string[];
  cancel: () => Promise<void>;
} {
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const frames: StatusFrame[] = [];
  const comments: string[] = [];
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of event.split("\n")) {
            if (line.startsWith("data:")) {
              frames.push(JSON.parse(line.slice("data:".length).trim()));
            } else if (line.startsWith(":")) {
              comments.push(line);
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Cancelling the reader is how these tests end a stream.
    }
  })();
  return { frames, comments, cancel: () => reader.cancel() };
}

async function waitForFrames(
  frames: StatusFrame[],
  count: number,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (frames.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${count} status frames, saw ${frames.length}`,
  );
}

describe("WorkspaceDO thread status", () => {
  const testEnv = env as unknown as TestEnv;

  async function createWorkspaceStatusStub(): Promise<WorkspaceStatusStub> {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Workspace Status User",
    );
    const { org } = await createOrg(testEnv, "Status Org", userId);
    const workspace = await createWorkspace(
      testEnv,
      org.id,
      "Status Workspace",
      userId,
    );
    return testEnv.WORKSPACE.get(
      testEnv.WORKSPACE.idFromName(workspace.id),
    ) as WorkspaceStatusStub;
  }

  it("persists and clears running thread status", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([
      threadId,
    ]);

    await workspaceStub.recordThreadStreaming(threadId, false);
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("tracks multiple running threads by most recent update", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const firstThreadId = crypto.randomUUID();
    const secondThreadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(firstThreadId, true);
    await new Promise((resolve) => setTimeout(resolve, 1));
    await workspaceStub.recordThreadStreaming(secondThreadId, true);

    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([
      secondThreadId,
      firstThreadId,
    ]);
  });

  it("persists latest running activity for live status snapshots", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText:
        "Reading src/components/sidebar/chat-group-hover-card.tsx with extra whitespace",
      activityAt: 12345,
    });

    const statuses = await workspaceStub.listStreamingThreadStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      threadId,
      latestActivityText:
        "Reading src/components/sidebar/chat-group-hover-card.tsx with extra whitespace",
      latestActivityAt: 12345,
    });
    expect(statuses[0].startedAt).toEqual(expect.any(Number));
    expect(statuses[0].updatedAt).toEqual(expect.any(Number));

    await workspaceStub.recordThreadStreaming(threadId, false);
    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([]);
  });

  it("preserves running activity when streaming status is refreshed without activity", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Thinking",
      activityAt: 100,
    });
    await workspaceStub.recordThreadStreaming(threadId, true);

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([
      expect.objectContaining({
        threadId,
        latestActivityText: "Thinking",
        latestActivityAt: 100,
      }),
    ]);
  });

  it("ignores stale completion status updates older than the current running row", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Running newer turn",
      activityAt: 100,
    });
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();
    const staleCompletedAt = runningStatus.startedAt - 1;

    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: staleCompletedAt,
      summaryStatus: "ready",
      summary: "Previous turn summary",
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([
      expect.objectContaining({
        threadId,
        startedAt: runningStatus.startedAt,
        latestActivityText: "Running newer turn",
      }),
    ]);
  });

  it("clears running status for completions newer than the current running row", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();

    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: runningStatus.startedAt + 1,
      summaryStatus: "failed",
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([]);
  });

  it("makes a guarded terminal pre-clear a no-op when no running row exists", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await runInDurableObject(workspaceStub, async (instance) => {
      const broadcast = vi.spyOn(instance as any, "broadcastThreadStatus");
      await (instance as any).recordThreadStreaming(threadId, false, {
        completedAt: Date.now(),
        summaryStatus: "pending",
        clearOnlyIfRunning: true,
      });
      expect(broadcast).not.toHaveBeenCalled();
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([]);
  });

  it("guarded terminal pre-clear deletes an existing running row", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();
    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: runningStatus.startedAt + 1,
      summaryStatus: "pending",
      clearOnlyIfRunning: true,
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([]);
  });

  it("does not clear a newer turn when completion metadata was normalized forward", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();
    await workspaceStub.recordThreadStreaming(threadId, false, {
      // Simulate OrgDO normalizing an old completion beyond the new row's start.
      completedAt: runningStatus.startedAt + 1_000,
      clearRunningStartedAtOrBefore: runningStatus.startedAt - 1,
      summaryStatus: "pending",
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([
      runningStatus,
    ]);
  });

  it("starts a new running row at the sender's startedAt, and an existing row keeps its own", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();
    const clickedAt = Date.now() - 3_000;

    await workspaceStub.recordThreadStreaming(threadId, true, { startedAt: clickedAt });
    // The run's run.started lands later, without a start of its own.
    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, true, { startedAt: clickedAt + 2_000 });

    const [running] = await workspaceStub.listStreamingThreadStatuses();
    expect(running).toMatchObject({ threadId, startedAt: clickedAt });
    expect(running.updatedAt).toBeGreaterThan(clickedAt);
  });

  it("clears by exact start only the running row that start made", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();
    const startedAt = Date.now() - 5_000;
    await workspaceStub.recordThreadStreaming(threadId, true, { startedAt });

    // Another send's failure (its own start) leaves this turn running.
    await workspaceStub.recordThreadStreaming(threadId, false, {
      clearOnlyIfRunning: true,
      clearRunningStartedAt: startedAt + 1_000,
    });
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([threadId]);

    await workspaceStub.recordThreadStreaming(threadId, false, {
      clearOnlyIfRunning: true,
      clearRunningStartedAt: startedAt,
    });
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("does not clear a running turn for a delayed summary-only update", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [runningStatus] = await workspaceStub.listStreamingThreadStatuses();
    await runInDurableObject(workspaceStub, async (instance) => {
      const broadcast = vi.spyOn(instance as any, "broadcastThreadStatus");
      await (instance as any).recordThreadStreaming(threadId, false, {
        completedAt: runningStatus.startedAt + 1_000,
        summaryStatus: "ready",
        summary: "Older turn summary",
        clearRunningStartedAtOrBefore: null,
      });
      expect(broadcast).not.toHaveBeenCalled();
    });

    await expect(workspaceStub.listStreamingThreadStatuses()).resolves.toEqual([
      runningStatus,
    ]);
  });

  it("drops a late activity update after the turn was terminally cleared", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: Date.now(),
    });

    // A debounced/retried running-activity flush landing after the terminal
    // clear must not resurrect a phantom "running" row.
    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Stale activity from the finished turn",
      activityAt: Date.now(),
    });

    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("does not create a running row from an activity-only update", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Activity before the turn-start transition",
      activityAt: Date.now(),
    });

    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("renews the lease on refresh without creating or resurrecting rows", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    // A refresh before the turn-start transition must not create the row.
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);

    await workspaceStub.recordThreadStreaming(threadId, true);
    const [before] = await workspaceStub.listStreamingThreadStatuses();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    const [after] = await workspaceStub.listStreamingThreadStatuses();
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);

    // A late heartbeat after the terminal clear must not resurrect the row.
    await workspaceStub.recordThreadStreaming(threadId, false, {
      completedAt: Date.now(),
    });
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);
  });

  it("arms the lease-sweep alarm when a turn starts", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    const beforeStart = Date.now();
    await workspaceStub.recordThreadStreaming(threadId, true);

    const alarm = await runInDurableObject(workspaceStub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
    // startedAt + 5min lease + 1s slack, allowing for test scheduling drift.
    expect(alarm!).toBeGreaterThan(beforeStart);
    expect(alarm!).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 2_000);
  });

  it("streams a snapshot as the first event on every attach", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);
    await workspaceStub.recordThreadStreaming(threadId, true, {
      activityText: "Reading  files",
      activityAt: 4242,
    });

    const response = await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const stream = readStatusStream(response);
    try {
      await waitForFrames(stream.frames, 1);
      const snapshot = stream.frames[0] as {
        type: string;
        runningThreadIds: string[];
        runningThreads: Array<Record<string, unknown>>;
      };
      expect(snapshot.type).toBe("thread_status_snapshot");
      expect(snapshot.runningThreadIds).toEqual([threadId]);
      // Both alias pairs stay on the wire: the client reads either one.
      expect(snapshot.runningThreads[0]).toEqual({
        threadId,
        startedAt: expect.any(Number),
        updatedAt: expect.any(Number),
        runningActivityText: "Reading files",
        runningActivityAt: 4242,
        latestActivityText: "Reading files",
        latestActivityAt: 4242,
      });
    } finally {
      await stream.cancel();
    }
  });

  it("fans incremental frames out to every attached stream with omitted null fields", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    const first = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );
    const second = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );

    try {
      await waitForFrames(first.frames, 1);
      await waitForFrames(second.frames, 1);

      await workspaceStub.recordThreadStreaming(threadId, true);
      await waitForFrames(first.frames, 2);
      await waitForFrames(second.frames, 2);
      expect(first.frames[1]).toEqual({
        type: "thread_status",
        threadId,
        status: "running",
        runningActivityText: null,
        runningActivityAt: null,
        runningStartedAt: expect.any(Number),
      });
      expect(second.frames[1]).toEqual(first.frames[1]);

      await workspaceStub.recordThreadStreaming(threadId, false, {
        completedAt: Date.now(),
        summaryStatus: "pending",
      });
      await waitForFrames(first.frames, 3);
      expect(first.frames[2]).toMatchObject({
        type: "thread_status",
        threadId,
        status: "unread",
        summaryStatus: "pending",
        runningActivityText: null,
        runningActivityAt: null,
        runningStartedAt: null,
      });
      expect(first.frames[2]).not.toHaveProperty("summary");
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });

  it("starts with the snapshot when attaching also expires a stale running lease", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();
    await workspaceStub.recordThreadStreaming(threadId, true);
    await runInDurableObject(workspaceStub, (instance) => {
      (instance as unknown as { sql: SqlStorage }).sql.exec(
        "UPDATE thread_streaming_status SET updated_at = ? WHERE thread_id = ?",
        Date.now() - 6 * 60 * 1000,
        threadId,
      );
    });
    const stream = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );
    try {
      await waitForFrames(stream.frames, 1);
      expect(stream.frames[0]).toMatchObject({ type: "thread_status_snapshot", runningThreadIds: [] });
    } finally {
      await stream.cancel();
    }
  });

  it("closes the internal socket when the SSE reader cancels", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const stream = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );
    await waitForFrames(stream.frames, 1);
    await stream.cancel();
    for (let i = 0; i < 100; i++) {
      const count = await runInDurableObject(workspaceStub, (_instance, state) =>
        state.getWebSockets("status-sse").filter((socket) => socket.readyState === WebSocket.OPEN).length,
      );
      if (count === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Cancelled status stream left an internal socket open");
  });

  it("keeps the same SSE stream through idle hibernation and a new status", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stream = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );
    try {
      await waitForFrames(stream.frames, 1);
      expect(stream.frames[0]).toMatchObject({ type: "thread_status_snapshot", runningThreadIds: [] });
      // A direct SSE response prevents this eviction from draining. The new
      // internal socket hibernates while the front Worker response stays open.
      await evictDurableObject(workspaceStub, { webSockets: "hibernate" });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(stream.comments).toContain(":hb");
      await workspaceStub.recordThreadStreaming(threadId, true);
      await waitForFrames(stream.frames, 2);
      expect(stream.frames[1]).toMatchObject({ type: "thread_status", threadId, status: "running" });
      await workspaceStub.recordThreadStreaming(threadId, false);
      await waitForFrames(stream.frames, 3);
      expect(stream.frames[2]).toMatchObject({ type: "thread_status", threadId, status: "idle" });
      expect(stream.frames.filter((frame) => frame.type === "thread_status_snapshot")).toHaveLength(1);
    } finally {
      await stream.cancel();
      vi.useRealTimers();
    }
  });

  it("keeps old Worker direct SSE and new Worker socket viewers in sync during overlap", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    // Older Workers forward request headers. Even a browser Upgrade header
    // must retain their SSE contract on the fixed queryless internal URL.
    const legacyResponse = await workspaceStub.fetch("https://workspace/status/stream", {
      headers: { Upgrade: "WebSocket" },
    });
    expect(legacyResponse.status).toBe(200);
    const legacy = readStatusStream(legacyResponse);
    const current = readStatusStream(await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal));
    const threadId = crypto.randomUUID();
    try {
      await waitForFrames(legacy.frames, 1);
      await waitForFrames(current.frames, 1);
      await workspaceStub.recordThreadStreaming(threadId, true);
      await waitForFrames(legacy.frames, 2);
      await waitForFrames(current.frames, 2);
      expect(legacy.frames[1]).toEqual(current.frames[1]);
      expect(current.frames[1]).toMatchObject({ type: "thread_status", threadId, status: "running" });
    } finally {
      await legacy.cancel();
      await current.cancel();
    }
  });

  it("passes through an old DO SSE response while its update is deferred", async () => {
    const original = new Response('data: {"type":"thread_status_snapshot","runningThreadIds":[]}\n\n', {
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
    const fetch = vi.fn(async () => original);
    const response = await bridgeWorkspaceStatusStream({ fetch }, new AbortController().signal);
    expect(response).toBe(original);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await response.text()).toContain('thread_status_snapshot');
  });

  it("closes the internal socket when an SSE reader stops draining", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let response: Response | undefined;
    try {
      response = await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal);
      // Leave the snapshot write pending, as a disconnected buffering proxy can.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await vi.advanceTimersByTimeAsync(50_000);
      for (let i = 0; i < 100; i++) {
        const count = await runInDurableObject(workspaceStub, (_instance, state) =>
          state.getWebSockets("status-sse").filter((socket) => socket.readyState === WebSocket.OPEN).length,
        );
        if (count === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Stalled status reader left an internal socket open");
    } finally {
      await response?.body?.cancel().catch(() => {});
      vi.useRealTimers();
    }
  });

  it("404s unknown durable object paths", async () => {
    const workspaceStub = await createWorkspaceStatusStub();

    const response = await workspaceStub.fetch("https://workspace/nope");
    expect(response.status).toBe(404);
  });

  it("404s the removed status websocket upgrade instead of accepting it", async () => {
    const workspaceStub = await createWorkspaceStatusStub();

    const response = await workspaceStub.fetch("https://workspace/status", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
  });

  it("closes a legacy hibernatable status socket that outlived the deploy", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();
    const closes: Array<{ code: number; reason: string }> = [];

    // Simulate exactly what a pre-removal release left behind: a socket
    // accepted with the 'status' tag, still attached to this DO. Nothing writes
    // to it any more, so leaving it OPEN would strand the stale tab with frozen
    // indicators and no close event — the failure mode this sweep exists for.
    // The client half never leaves the DO's I/O context (the runtime forbids
    // it), so the close listener is installed in there too.
    await runInDurableObject(workspaceStub, (_instance, state) => {
      const pair = new WebSocketPair();
      const [clientSocket, serverSocket] = Object.values(pair);
      state.acceptWebSocket(serverSocket, ["status"]);
      clientSocket.accept();
      clientSocket.addEventListener("close", (event) => {
        closes.push({ code: event.code, reason: event.reason });
      });
    });

    await expect(
      runInDurableObject(
        workspaceStub,
        (_instance, state) => state.getWebSockets("status").length,
      ),
    ).resolves.toBe(1);

    // Any broadcast on the surviving (SSE) transport retires it.
    await workspaceStub.recordThreadStreaming(threadId, true);

    for (let i = 0; i < 100 && closes.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(closes[0]?.code).toBe(1012);

    const openSockets = await runInDurableObject(
      workspaceStub,
      (_instance, state) =>
        state
          .getWebSockets("status")
          .filter((socket) => socket.readyState === WebSocket.OPEN).length,
    );
    expect(openSockets).toBe(0);
  });

  it("retires a legacy status socket on the next fetch too", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const closes: number[] = [];

    await runInDurableObject(workspaceStub, (_instance, state) => {
      const pair = new WebSocketPair();
      const [clientSocket, serverSocket] = Object.values(pair);
      state.acceptWebSocket(serverSocket, ["status"]);
      clientSocket.accept();
      clientSocket.addEventListener("close", (event) => {
        closes.push(event.code);
      });
    });

    // A quiet workspace never broadcasts, so the fetch seam has to sweep as
    // well — otherwise the stale socket hangs until the DO is evicted.
    const response = await workspaceStub.fetch("https://workspace/status", {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(404);

    for (let i = 0; i < 100 && closes.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(closes[0]).toBe(1012);
  });

  it("retires a legacy status socket that sends a frame after the deploy", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const closes: number[] = [];
    let staleClient: WebSocket | null = null;

    await runInDurableObject(workspaceStub, (_instance, state) => {
      const pair = new WebSocketPair();
      const [clientSocket, serverSocket] = Object.values(pair);
      state.acceptWebSocket(serverSocket, ["status"]);
      clientSocket.accept();
      clientSocket.addEventListener("close", (event) => {
        closes.push(event.code);
      });
      staleClient = clientSocket;
    });

    // An inbound frame from a stale bundle must not fault the isolate on an
    // unhandled hibernation delivery — the DO answers by retiring the socket.
    await runInDurableObject(workspaceStub, () => {
      (staleClient as unknown as WebSocket).send("ping");
    });

    for (let i = 0; i < 100 && closes.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(closes[0]).toBe(1012);
  });

  it("fans out through hibernatable internal sockets while the public websocket stays removed", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    const stream = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );
    await waitForFrames(stream.frames, 1);
    expect(stream.frames[0]).toMatchObject({
      type: "thread_status_snapshot",
      runningThreadIds: [],
    });

    // The public SSE shape is unchanged while the internal socket can hibernate.
    await workspaceStub.recordThreadStreaming(threadId, true);
    await waitForFrames(stream.frames, 2);
    expect(stream.frames[1]).toMatchObject({
      type: "thread_status",
      threadId,
      status: "running",
    });

    // Only the new internal bridge is registered; retired browser tags stay absent.
    const socketCount = await runInDurableObject(
      workspaceStub,
      (_instance, state) => ({ bridge: state.getWebSockets("status-sse").length, legacy: state.getWebSockets("status").length }),
    );
    expect(socketCount).toEqual({ bridge: 1, legacy: 0 });

    await stream.cancel();
  });

  it("records each expired running lease it sweeps, with its age", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();
    await workspaceStub.recordThreadStreaming(threadId, true);
    const writeDataPoint = vi.fn();
    await runInDurableObject(workspaceStub, (instance) => {
      const target = instance as unknown as { env: Record<string, unknown>; sql: SqlStorage };
      target.env = { ...target.env, OBSERVABILITY_EVENTS: { writeDataPoint } };
      target.sql.exec(
        "UPDATE thread_streaming_status SET updated_at = ? WHERE thread_id = ?",
        Date.now() - 6 * 60 * 1000,
        threadId,
      );
    });
    await expect(runDurableObjectAlarm(workspaceStub)).resolves.toBe(true);
    const points = writeDataPoint.mock.calls.map(([point]) => point as { blobs: string[]; doubles: number[] });
    const expired = points.filter((point) => point.blobs[0] === "thread_running_lease_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0].blobs.slice(1, 5)).toEqual(["warn", "workspace_do", "lease_sweep", "any_backend"]);
    expect(expired[0].blobs[8]).toBe(threadId);
    // double2: how long the row went without a heartbeat.
    expect(expired[0].doubles[1]).toBeGreaterThanOrEqual(6 * 60 * 1000);
  });

  it("records a lease refresh that finds no running row, by its source", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const writeDataPoint = vi.fn();
    await runInDurableObject(workspaceStub, (instance) => {
      const target = instance as unknown as { env: Record<string, unknown> };
      target.env = { ...target.env, OBSERVABILITY_EVENTS: { writeDataPoint } };
    });
    const threadId = crypto.randomUUID();
    await (workspaceStub as unknown as {
      recordThreadStreaming(id: string, streaming: boolean, options: Record<string, unknown>): Promise<void>;
    }).recordThreadStreaming(threadId, true, { refresh: true, source: "runtime_usage" });
    const points = writeDataPoint.mock.calls.map(([point]) => point as { blobs: string[] });
    const missed = points.filter((point) => point.blobs[0] === "thread_running_lease_refresh_missed");
    expect(missed).toHaveLength(1);
    expect(missed[0].blobs.slice(2, 5)).toEqual(["workspace_do", "lease_refresh", "runtime_usage"]);

    // A refresh that renews a running row records nothing.
    await workspaceStub.recordThreadStreaming(threadId, true);
    writeDataPoint.mockClear();
    await workspaceStub.recordThreadStreaming(threadId, true, { refresh: true });
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it("sweeps an expired lease via the alarm and broadcasts idle", async () => {
    const workspaceStub = await createWorkspaceStatusStub();
    const threadId = crypto.randomUUID();

    await workspaceStub.recordThreadStreaming(threadId, true);

    const stream = readStatusStream(
      await bridgeWorkspaceStatusStream(workspaceStub, new AbortController().signal),
    );
    const frames = stream.frames;
    await waitForFrames(frames, 1);

    // Backdate the lease past the TTL: the turn's heartbeats "stopped".
    await runInDurableObject(workspaceStub, (instance) => {
      (instance as unknown as { sql: SqlStorage }).sql.exec(
        "UPDATE thread_streaming_status SET updated_at = ? WHERE thread_id = ?",
        Date.now() - 6 * 60 * 1000,
        threadId,
      );
    });

    await expect(runDurableObjectAlarm(workspaceStub)).resolves.toBe(true);
    await expect(workspaceStub.listStreamingThreadIds()).resolves.toEqual([]);

    // The prune broadcast an idle frame to attached status streams.
    await waitForFrames(frames, 2);
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "thread_status",
        threadId,
        status: "idle",
      }),
    );
    await stream.cancel();

    // Nothing left running and no managed tokens: the alarm is cleared
    // instead of leaving the 1h dead-man fallback armed.
    const alarmAfter = await runInDurableObject(
      workspaceStub,
      (_instance, state) => state.storage.getAlarm(),
    );
    expect(alarmAfter).toBeNull();
  });
});

describe("workspace status stream route", () => {
  const testEnv = env as unknown as TestEnv;
  const signingSecret = (env as unknown as { TOKEN_SIGNING_SECRET: string })
    .TOKEN_SIGNING_SECRET;

  async function setupSession() {
    const { userId } = await createUser(
      testEnv,
      testEmail(),
      "password123",
      "Status Route User",
    );
    const { org } = await createOrg(testEnv, "Status Route Org", userId);
    const [defaultWorkspace] = await listOrgWorkspaces(testEnv, org.id);
    const other = await createWorkspace(
      testEnv,
      org.id,
      "Other Workspace",
      userId,
    );
    const sessionData: SignedSessionData = {
      user_id: userId,
      org_id: org.id,
      // The session is parked on a different workspace than the URL: this used
      // to 403 every status socket in a tab another tab had navigated away from.
      workspace_id: defaultWorkspace!.id,
      created_at: Date.now(),
      user_name: "Status Route User",
      user_email: testEmail(),
    };
    return {
      userId,
      orgId: org.id,
      sessionWorkspaceId: defaultWorkspace!.id,
      workspaceId: other.id,
      signedToken: await createSignedSession(signingSecret, sessionData),
    };
  }

  const attach = (workspaceId: string, signedToken?: string) =>
    SELF.fetch(
      `http://example/api/workspaces/${encodeURIComponent(workspaceId)}/status/stream`,
      {
        headers: {
          Accept: "text/event-stream",
          ...(signedToken ? { "X-Chiridion-Session-Id": signedToken } : {}),
        },
      },
    );

  it("streams the workspace named in the URL, not the session-selected one", async () => {
    const { workspaceId, signedToken } = await setupSession();

    const response = await attach(workspaceId, signedToken);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    // Never read to completion — the stream only ends when the viewer leaves.
    await response.body?.cancel();
  });

  it("rejects an unauthenticated attach", async () => {
    const { workspaceId } = await setupSession();

    const response = await attach(workspaceId);

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).not.toBe(
      "text/event-stream; charset=utf-8",
    );
  });

  it("rejects a workspace the session's user does not belong to", async () => {
    const { workspaceId } = await setupSession();
    const outsider = await setupSession();

    const response = await attach(workspaceId, outsider.signedToken);

    expect(response.status).toBe(403);
  });
});
