import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportClientEventMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/client-error-reporting', () => ({
  reportClientEvent: reportClientEventMock,
}));

const {
  clearNewChatSubmitted,
  markNewChatSubmitted,
  resetNewChatTiming,
  trackNewChatStage,
} = await import('@/lib/new-chat-timing');

describe('new chat timing', () => {
  beforeEach(() => {
    resetNewChatTiming();
    reportClientEventMock.mockClear();
  });

  it('times each stage of the thread that shows the new message, once, from the click', () => {
    markNewChatSubmitted(1_000);
    expect(trackNewChatStage('thread-1', 'first_send_accepted', 1_100)).toBeNull();
    expect(trackNewChatStage('thread-1', 'thread_visible', 1_300)).toBe(300);
    expect(trackNewChatStage('thread-1', 'thread_visible', 1_400)).toBeNull();
    expect(trackNewChatStage('thread-1', 'first_send_accepted', 2_000)).toBe(1_000);
    expect(trackNewChatStage('thread-1', 'first_output', 8_000)).toBe(7_000);
    // The click is claimed: another thread reports nothing.
    expect(trackNewChatStage('thread-2', 'thread_visible', 1_500)).toBeNull();
    expect(reportClientEventMock).toHaveBeenCalledTimes(3);
    expect(reportClientEventMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'chat_new_thread',
      event: 'new_chat_timing',
      status: 'thread_visible',
      threadId: 'thread-1',
      durationMs: 300,
    }));
  });

  it('ignores a click that failed or is too old', () => {
    markNewChatSubmitted(1_000);
    clearNewChatSubmitted();
    expect(trackNewChatStage('thread-1', 'thread_visible', 1_200)).toBeNull();
    markNewChatSubmitted(1_000);
    expect(trackNewChatStage('thread-1', 'thread_visible', 70_000)).toBeNull();
    expect(reportClientEventMock).not.toHaveBeenCalled();
  });
});
