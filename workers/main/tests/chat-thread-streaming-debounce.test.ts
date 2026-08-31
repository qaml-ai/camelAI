import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatThreadDO } from '../src/chat-thread-do';

const DEBOUNCE_MS = 5_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatThreadDO running-activity streaming debounce', () => {
  function createFake() {
    const recordThreadStreaming = vi.fn(async () => {});
    const workspaceStub = { recordThreadStreaming };
    const waitUntilPromises: Promise<unknown>[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => workspaceStub),
      },
    };
    fake.ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        if (promise) waitUntilPromises.push(promise);
      }),
    };
    fake.workspaceStatusStubs = new Map();
    fake.pendingStreamingActivity = null;
    fake.streamingActivityFlushTimer = null;
    fake.runningActivityLastText = null;
    fake.runningActivityLastSentAt = 0;
    fake.recordChatThreadObservabilityEvent = vi.fn();
    // Use the real retry wrapper indirectly by stubbing it to call through.
    fake.retryChatDurableObjectRpc = vi.fn(
      (_operation: string, op: () => Promise<unknown>) => op(),
    );
    return { fake, recordThreadStreaming, waitUntilPromises };
  }

  async function flush(waitUntilPromises: Promise<unknown>[]) {
    await Promise.all(waitUntilPromises);
  }

  it('coalesces a burst of activity updates into one RPC with the latest state', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming, waitUntilPromises } = createFake();

    for (let i = 0; i < 5; i += 1) {
      ChatThreadDO.prototype['queueStreamingActivityUpdate'].call(
        fake,
        'workspace1',
        'thread1',
        `activity ${i}`,
        1_000 + i,
      );
    }

    // No RPC has fired yet; everything is pending in the trailing window.
    expect(recordThreadStreaming).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flush(waitUntilPromises);

    // Exactly one RPC, carrying the latest activity text/timestamp.
    expect(recordThreadStreaming).toHaveBeenCalledTimes(1);
    expect(recordThreadStreaming).toHaveBeenCalledWith('thread1', true, {
      activityText: 'activity 4',
      activityAt: 1_004,
    });

    // A coalesced-count observability event is emitted for the burst.
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'workspace_streaming_activity_coalesced',
      expect.objectContaining({ count: 5, status: 'flushed' }),
    );
  });

  it('does not fire a fresh timer-only flush when nothing is pending', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming } = createFake();

    ChatThreadDO.prototype['flushPendingStreamingActivity'].call(fake);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    expect(recordThreadStreaming).not.toHaveBeenCalled();
  });

  it('discards a pending activity update on a terminal streaming transition', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming, waitUntilPromises } = createFake();

    ChatThreadDO.prototype['queueStreamingActivityUpdate'].call(
      fake,
      'workspace1',
      'thread1',
      'mid-turn activity',
      2_000,
    );
    expect(fake.pendingStreamingActivity).not.toBeNull();

    // resetRunningActivityState runs on every streaming transition and must drop
    // the stale activity update so it cannot resurrect a "streaming" row after
    // the turn ends.
    ChatThreadDO.prototype['resetRunningActivityState'].call(fake);
    expect(fake.pendingStreamingActivity).toBeNull();
    expect(fake.streamingActivityFlushTimer).toBeNull();

    // The dropped update must never reach the workspace, even after the window.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flush(waitUntilPromises);
    expect(recordThreadStreaming).not.toHaveBeenCalled();
  });

  it('logs RPC failures from the debounced flush without throwing to the caller', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming, waitUntilPromises } = createFake();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordThreadStreaming.mockRejectedValueOnce(new Error('Network connection lost.'));

    expect(() =>
      ChatThreadDO.prototype['queueStreamingActivityUpdate'].call(
        fake,
        'workspace1',
        'thread1',
        'activity',
        3_000,
      ),
    ).not.toThrow();

    // The trailing flush itself must not throw synchronously.
    expect(() => vi.advanceTimersByTime(DEBOUNCE_MS)).not.toThrow();
    await flush(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledTimes(1);
    // recordWorkspaceThreadStreaming catches and logs RPC failures itself, so
    // the inner structured log is what fires; the flush-level catch is a
    // belt-and-suspenders guard that stays silent here.
    expect(consoleError).toHaveBeenCalledWith(
      '[ChatThreadDO] failed to record workspace thread status',
      expect.objectContaining({ error: expect.any(Error) }),
    );
    consoleError.mockRestore();
  });

  it('flushes a pending update for a different thread before queueing a new one', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming, waitUntilPromises } = createFake();

    ChatThreadDO.prototype['queueStreamingActivityUpdate'].call(
      fake,
      'workspace1',
      'threadA',
      'activity A',
      4_000,
    );
    // Re-pointing to a different thread must not silently drop threadA's latest
    // state; it is flushed before the new entry is queued.
    ChatThreadDO.prototype['queueStreamingActivityUpdate'].call(
      fake,
      'workspace1',
      'threadB',
      'activity B',
      4_100,
    );

    await flush(waitUntilPromises);
    expect(recordThreadStreaming).toHaveBeenCalledWith('threadA', true, {
      activityText: 'activity A',
      activityAt: 4_000,
    });

    // threadB is still pending until its own window elapses.
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flush(waitUntilPromises);
    expect(recordThreadStreaming).toHaveBeenCalledWith('threadB', true, {
      activityText: 'activity B',
      activityAt: 4_100,
    });
  });

  it('records a single coalesced update without emitting the coalesced counter', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming, waitUntilPromises } = createFake();

    ChatThreadDO.prototype['queueStreamingActivityUpdate'].call(
      fake,
      'workspace1',
      'thread1',
      'only activity',
      5_000,
    );
    vi.advanceTimersByTime(DEBOUNCE_MS);
    await flush(waitUntilPromises);

    expect(recordThreadStreaming).toHaveBeenCalledTimes(1);
    // A single (non-coalesced) update should not emit the burst counter.
    expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalledWith(
      'workspace_streaming_activity_coalesced',
      expect.anything(),
    );
  });
});

const LEASE_REFRESH_MS = 60_000;

describe('ChatThreadDO streaming lease heartbeat', () => {
  function createFake() {
    const recordThreadStreaming = vi.fn(async () => {});
    const workspaceStub = { recordThreadStreaming };
    const waitUntilPromises: Promise<unknown>[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => workspaceStub),
      },
    };
    fake.ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        if (promise) waitUntilPromises.push(promise);
      }),
    };
    fake.workspaceStatusStubs = new Map();
    fake.pendingStreamingActivity = null;
    fake.streamingActivityFlushTimer = null;
    fake.streamingLeaseRefreshTimer = null;
    fake.runningActivityLastText = null;
    fake.runningActivityLastSentAt = 0;
    fake.isThreadStreaming = vi.fn(() => true);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.retryChatDurableObjectRpc = vi.fn(
      (_operation: string, op: () => Promise<unknown>) => op(),
    );
    return { fake, recordThreadStreaming, waitUntilPromises };
  }

  it('renews the workspace lease every interval while the turn is streaming', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming, waitUntilPromises } = createFake();

    ChatThreadDO.prototype['startStreamingLeaseHeartbeat'].call(fake);
    expect(recordThreadStreaming).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LEASE_REFRESH_MS);
    await Promise.all(waitUntilPromises);
    expect(recordThreadStreaming).toHaveBeenCalledTimes(1);
    expect(recordThreadStreaming).toHaveBeenCalledWith('thread1', true, {
      refresh: true,
    });

    vi.advanceTimersByTime(LEASE_REFRESH_MS);
    await Promise.all(waitUntilPromises);
    expect(recordThreadStreaming).toHaveBeenCalledTimes(2);
  });

  it('self-cancels when the turn is no longer streaming', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming } = createFake();
    fake.isThreadStreaming = vi.fn(() => false);

    ChatThreadDO.prototype['startStreamingLeaseHeartbeat'].call(fake);
    vi.advanceTimersByTime(LEASE_REFRESH_MS * 3);

    expect(recordThreadStreaming).not.toHaveBeenCalled();
    expect(fake.streamingLeaseRefreshTimer).toBeNull();
  });

  it('is stopped by resetRunningActivityState (turn boundaries)', async () => {
    vi.useFakeTimers();
    const { fake, recordThreadStreaming } = createFake();

    ChatThreadDO.prototype['startStreamingLeaseHeartbeat'].call(fake);
    ChatThreadDO.prototype['resetRunningActivityState'].call(fake);
    expect(fake.streamingLeaseRefreshTimer).toBeNull();

    vi.advanceTimersByTime(LEASE_REFRESH_MS * 3);
    expect(recordThreadStreaming).not.toHaveBeenCalled();
  });
});
