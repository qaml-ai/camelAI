import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';

// The stall clamp guards the one client-side hole the server watchdog cannot
// close: a busy indicator fed by a resume attach (or a missed terminal frame)
// onto a stream that will never emit again. The server kills any turn whose
// reply stream is chunk-silent past chatStreamStallTimeoutMs (10min) and a
// healthy turn now emits transient heartbeats every 30s, so a CONNECTED client
// whose busy state sees zero progress past STREAM_PROGRESS_STALE_MS is provably
// attached to a dead stream — the hook clears the indicator instead of spinning
// forever, and releases the clamp if genuine progress later arrives.

const mockChat: {
  messages: UIMessage[];
  isStreaming: boolean;
  status: string;
  setMessages: (messages: UIMessage[]) => void;
} = {
  messages: [],
  isStreaming: false,
  status: 'ready',
  setMessages: vi.fn(),
};
let capturedOnData: ((part: { type: string; data?: unknown }) => void) | null =
  null;

vi.mock('@cloudflare/ai-chat/react', () => ({
  useAgentChat: (options: { onData?: (part: never) => void }) => {
    capturedOnData = options.onData as typeof capturedOnData;
    return mockChat;
  },
}));

import {
  STREAM_PROGRESS_STALE_MS,
  isStreamProgressStale,
  usePiChatStream,
} from '@/lib/use-pi-chat-stream';

function renderStream() {
  return renderHook(() =>
    usePiChatStream({
      agent: {} as never,
      threadId: 'thread-1',
      initialUiMessages: [],
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  mockChat.messages = [];
  mockChat.isStreaming = false;
  mockChat.status = 'ready';
  capturedOnData = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isStreamProgressStale', () => {
  it('is stale only at or past the bound', () => {
    expect(isStreamProgressStale(0, STREAM_PROGRESS_STALE_MS - 1)).toBe(false);
    expect(isStreamProgressStale(0, STREAM_PROGRESS_STALE_MS)).toBe(true);
  });
});

describe('usePiChatStream stall clamp', () => {
  it('clears a busy indicator that makes no progress past the stall bound', () => {
    mockChat.isStreaming = true;
    mockChat.status = 'streaming';
    const { result } = renderStream();
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.status).toBe('streaming');
    expect(result.current.isStallClamped).toBe(false);

    act(() => {
      vi.advanceTimersByTime(STREAM_PROGRESS_STALE_MS + 30_000);
    });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.status).toBe('ready');
    expect(result.current.isStallClamped).toBe(true);
    expect(result.current.streamingMessageId).toBeNull();
  });

  it('keeps a heartbeat-fed busy indicator alive well past the bound', () => {
    mockChat.isStreaming = true;
    mockChat.status = 'streaming';
    const { result } = renderStream();

    // Twice the stale bound of wall time, but a transient heartbeat lands every
    // 30s (the server cadence while a silent tool executes) — never clamped.
    const steps = Math.ceil((2 * STREAM_PROGRESS_STALE_MS) / 30_000);
    for (let i = 0; i < steps; i += 1) {
      act(() => {
        vi.advanceTimersByTime(30_000);
        capturedOnData?.({
          type: 'data-pi-heartbeat',
          data: { at: Date.now() },
        });
      });
    }

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.status).toBe('streaming');
  });

  it('releases the clamp when genuine progress arrives (message list change)', () => {
    mockChat.isStreaming = true;
    mockChat.status = 'streaming';
    const { result, rerender } = renderStream();

    act(() => {
      vi.advanceTimersByTime(STREAM_PROGRESS_STALE_MS + 30_000);
    });
    expect(result.current.isStreaming).toBe(false);

    // A recovery continuation lands chunks: ai-chat replaces the message list.
    mockChat.messages = [
      { id: 'a1', role: 'assistant', parts: [] } as unknown as UIMessage,
    ];
    act(() => {
      rerender();
    });

    expect(result.current.isStreaming).toBe(true);
    expect(result.current.status).toBe('streaming');
    expect(result.current.isStallClamped).toBe(false);
    expect(result.current.streamingMessageId).toBe('a1');
  });

  it('never clamps an idle stream and resets the budget per busy window', () => {
    const { result, rerender } = renderStream();
    // Idle for far longer than the bound — nothing to clamp.
    act(() => {
      vi.advanceTimersByTime(3 * STREAM_PROGRESS_STALE_MS);
    });
    expect(result.current.isStreaming).toBe(false);

    // A new busy window opens: it gets the full staleness budget from now.
    mockChat.isStreaming = true;
    mockChat.status = 'streaming';
    act(() => {
      rerender();
    });
    act(() => {
      vi.advanceTimersByTime(STREAM_PROGRESS_STALE_MS - 60_000);
    });
    expect(result.current.isStreaming).toBe(true);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current.isStreaming).toBe(false);
  });
});
