import { describe, expect, it, vi } from 'vitest';
import { ChatThreadDO } from '../src/chat-thread-do';
import {
  createPiToolDefinitions,
  PI_SUBAGENT_ABORT_GRACE_MS,
  type PiToolSurfaceDeps,
} from '../src/chat-thread/pi-tools';
import type { ChatContextState } from '../src/chat-thread/types';

/**
 * Stop must interrupt an IN-FLIGHT tool call, not wait for it.
 *
 * The chain under test:
 *   requestStop → sendRunnerCommand("stop") → piSession.abort()
 *     → pi-agent-core aborts the active run's controller
 *     → that signal is the one handed to AgentTool.execute
 *     → execute passes it INTO keepPiTurnToolProgressAliveWhile
 *     → the tool call rejects with "Operation aborted" and the keep-alive is released.
 *
 * The middle hop is pi-agent-core's own contract (`Agent.abort()` calls
 * `activeRun.abortController.abort()`, and agent-loop hands
 * `abortController.signal` to `tool.execute`); the hops this repo owns are the
 * two ends, and both are covered here.
 */

/** DO fake carrying just the state keepPiTurnToolProgressAliveWhile touches. */
function keepAliveHost() {
  const host = Object.create(ChatThreadDO.prototype) as any;
  host.chatContext = { threadId: 'thread-stop' };
  host.activePiStreamTurnId = null;
  host.piStreamWriter = null;
  host.piPreAttachChunkBuffer = null;
  host.piToolKeepAliveInterval = null;
  host.piAgentStartedAtMs = Date.now();
  host.piTurnStartedAtMs = Date.now();
  host.recordChatThreadObservabilityEvent = vi.fn();
  host.syncAgentState = vi.fn();
  return host;
}

function toolSurface(callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const host = keepAliveHost();
  const deps = {
    scopedCodeModeTools: () => ({ callTool }) as never,
    keepPiTurnToolProgressAliveWhile: <T,>(fn: () => Promise<T>, signal?: AbortSignal) =>
      ChatThreadDO.prototype['keepPiTurnToolProgressAliveWhile'].call(host, fn, signal) as Promise<T>,
    runCodeModeJavascript: vi.fn(),
    piModelResolver: () => null,
  } as unknown as PiToolSurfaceDeps;
  const context = {
    orgId: 'org1',
    workspaceId: 'workspace1',
    threadId: 'thread-stop',
    userId: 'user1',
  } as unknown as ChatContextState;
  const definitions = createPiToolDefinitions(deps, context, {
    includeSubagents: false,
    includeResearch: false,
  });
  return { definitions, host };
}

describe('stop interrupts an in-flight tool call', () => {
  it('rejects the tool call as soon as the signal fires, without waiting for the tool', async () => {
    let rejectTool!: (error: Error) => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const { definitions, host } = toolSurface(
      // A sandbox-backed call that has already reached the container: nothing
      // client-side can cancel it, so stop must not wait for it.
      () => new Promise<never>((_, reject) => {
        rejectTool = reject;
        started();
      }),
    );
    const read = definitions.find((definition) => definition.name === 'read')!;
    const controller = new AbortController();

    const running = read.execute('tool-1', { path: '/big.csv' }, controller.signal);
    const settled = expect(running).rejects.toThrow('Operation aborted');
    // Stop lands MID-flight, after the RPC is away.
    await inFlight;
    controller.abort();
    await settled;

    // Keep-alive released with the call, not with the abandoned tool.
    expect(host.piToolKeepAliveInterval).toBeNull();

    // The abandoned work settling later stays observed.
    rejectTool(new Error('sandbox answered after the stop'));
    await Promise.resolve();
  });

  it('interrupts js_exec too — the tool every code-mode sandbox call runs inside', async () => {
    const host = keepAliveHost();
    const deps = {
      scopedCodeModeTools: () => ({ callTool: vi.fn() }) as never,
      keepPiTurnToolProgressAliveWhile: <T,>(fn: () => Promise<T>, signal?: AbortSignal) =>
        ChatThreadDO.prototype['keepPiTurnToolProgressAliveWhile'].call(host, fn, signal) as Promise<T>,
      runCodeModeJavascript: () => new Promise<never>(() => {}),
      piModelResolver: () => null,
    } as unknown as PiToolSurfaceDeps;
    const definitions = createPiToolDefinitions(deps, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread-stop',
      userId: 'user1',
    } as unknown as ChatContextState, { includeSubagents: false, includeResearch: false });

    const jsExec = definitions.find((definition) => definition.name === 'js_exec')!;
    const controller = new AbortController();
    const running = jsExec.execute('tool-2', {
      description: 'run the analysis',
      code: 'await tools.analysis_exec({ command: "python job.py" })',
    }, controller.signal);
    const settled = expect(running).rejects.toThrow('Operation aborted');
    controller.abort();
    await settled;
    expect(host.piToolKeepAliveInterval).toBeNull();
  });

  it('honors an abort that lands while the service is retrying a dead session', async () => {
    // Fix C retries once inside the RPC; the retry is invisible from here and
    // must not delay the stop.
    let attempts = 0;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const { definitions, host } = toolSurface(() => {
      attempts += 1;
      started();
      // The retry hangs too: the caller must still come back on abort.
      return new Promise<never>(() => {});
    });
    const read = definitions.find((definition) => definition.name === 'read')!;
    const controller = new AbortController();

    const running = read.execute('tool-3', { path: '/big.csv' }, controller.signal);
    const settled = expect(running).rejects.toThrow('Operation aborted');
    await inFlight;
    controller.abort();
    await settled;
    expect(attempts).toBe(1);
    expect(host.piToolKeepAliveInterval).toBeNull();
  });

  it('releases the keep-alive when a tool rejects on its own client deadline', async () => {
    // Fix A path: the deadline makes the RPC reject, which must unpin the
    // heartbeat exactly like any other tool failure.
    const { definitions, host } = toolSurface(async () => {
      const error = new Error('analysis_exec did not return within its 255s budget');
      error.name = 'SandboxDeadlineExceededError';
      throw error;
    });
    const read = definitions.find((definition) => definition.name === 'read')!;

    await expect(read.execute('tool-5', { path: '/big.csv' }, new AbortController().signal))
      .rejects.toThrow('did not return within');
    expect(host.piToolKeepAliveInterval).toBeNull();
  });

  it('passes a normal tool result through untouched when no stop arrives', async () => {
    const { definitions } = toolSurface(async () => ({ content: 'file body' }));
    const read = definitions.find((definition) => definition.name === 'read')!;
    const controller = new AbortController();
    const result = await read.execute('tool-4', { path: '/small.txt' }, controller.signal);
    expect(JSON.stringify(result)).toContain('file body');
  });
});

/**
 * Subagents are the one tool class that CAN cancel. `child.abort()` unwinds
 * pi-agent-core in milliseconds and `child.prompt()` then RETURNS the answer it
 * accumulated, so a zero-grace rejection threw away completed, already-billed
 * work and persisted a tool result reading "Operation aborted" with no details.
 */
describe('stop keeps a subagent\'s accumulated answer', () => {
  function subagentSurface(
    runPiSubagentTool: (
      context: unknown,
      toolName: string,
      params: unknown,
      signal?: AbortSignal,
    ) => Promise<unknown>,
  ) {
    const host = keepAliveHost();
    const deps = {
      scopedCodeModeTools: () => ({ callTool: vi.fn() }) as never,
      keepPiTurnToolProgressAliveWhile: <T,>(
        fn: () => Promise<T>,
        signal?: AbortSignal,
        options?: { abortGraceMs?: number },
      ) =>
        ChatThreadDO.prototype['keepPiTurnToolProgressAliveWhile']
          .call(host, fn, signal, options) as Promise<T>,
      runCodeModeJavascript: vi.fn(),
      runPiSubagentTool,
      piModelResolver: () => null,
    } as unknown as PiToolSurfaceDeps;
    const definitions = createPiToolDefinitions(deps, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread-stop',
      userId: 'user1',
    } as unknown as ChatContextState, { includeResearch: false });
    return { definitions, host };
  }

  it('returns the answer the child produced during its graceful abort', async () => {
    const { definitions, host } = subagentSurface(async (_context, _name, _params, signal) => {
      // The child registers its listener AFTER a couple of awaits — the shape
      // that made the wrapper's listener win the race unconditionally.
      await Promise.resolve();
      await Promise.resolve();
      return await new Promise((resolve) => {
        // child.abort() → prompt() unwinds over a few ticks and hands back what
        // it has; it does not throw.
        const unwind = () => setTimeout(() => resolve({
          content: [{ type: 'text', text: 'PARTIAL SUBAGENT ANSWER' }],
          details: { status: 'completed' },
        }), 0);
        if (signal?.aborted) unwind();
        else signal?.addEventListener('abort', unwind, { once: true });
      });
    });

    const agent = definitions.find((definition) => definition.name === 'Agent')!;
    const controller = new AbortController();
    const running = agent.execute('tool-sub-1', { prompt: 'investigate' }, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    expect(JSON.stringify(await running)).toContain('PARTIAL SUBAGENT ANSWER');
    expect(host.piToolKeepAliveInterval).toBeNull();
  });

  it('still gives up on a child that ignores the abort past the grace window', async () => {
    vi.useFakeTimers();
    try {
      const { definitions, host } = subagentSurface(() => new Promise<never>(() => {}));
      const agent = definitions.find((definition) => definition.name === 'Explore')!;
      const controller = new AbortController();
      const running = agent.execute('tool-sub-2', { prompt: 'investigate' }, controller.signal);
      const settled = expect(running).rejects.toThrow('Operation aborted');
      await Promise.resolve();
      controller.abort();
      await vi.advanceTimersByTimeAsync(PI_SUBAGENT_ABORT_GRACE_MS + 10);
      await settled;
      expect(host.piToolKeepAliveInterval).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('requestStop reaches the active Pi run', () => {
  it('aborts the live session (which is what fires the tool signal)', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const abort = vi.fn();
    const backoffAbort = vi.fn();
    fake.piSession = { state: { isStreaming: true }, abort };
    fake.piTransientRetryBackoffAbort = { abort: backoffAbort };
    fake.chatContext = { threadId: 'thread-stop' };

    const sent = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, { type: 'stop' });

    expect(sent).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    // A stop during a transient-retry backoff also wakes the sleeping loop.
    expect(backoffAbort).toHaveBeenCalledTimes(1);
    expect(typeof fake.piUserStopRequestedAtMs).toBe('number');
  });
});
