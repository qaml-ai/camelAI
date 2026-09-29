import { describe, expect, it } from 'vitest';

import { mergeLiveToolOutput } from '@/lib/pi-render';
import type { Message } from '@/types';

describe('mergeLiveToolOutput', () => {
  it('marks live agent output as progress instead of a terminal result', () => {
    const message: Message = {
      id: 'message-1',
      thread_id: 'thread-1',
      role: 'assistant',
      created_at: 1,
      content: [{
        type: 'tool_use',
        id: 'oracle-1',
        name: 'Oracle',
        input: { question: 'Fix the issue' },
      }],
    };

    const merged = mergeLiveToolOutput(
      message,
      new Map([['oracle-1', 'Reviewing the problem\n']]),
    );
    expect(merged.content).toEqual([
      message.content[0],
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'oracle-1',
        isTaskUpdate: true,
      }),
    ]);
  });

  it('does not mark ordinary command output as agent progress', () => {
    const message: Message = {
      id: 'message-1',
      thread_id: 'thread-1',
      role: 'assistant',
      created_at: 1,
      content: [{
        type: 'tool_use',
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'echo ok' },
      }],
    };

    const merged = mergeLiveToolOutput(message, new Map([['bash-1', 'ok\n']]));
    expect(Array.isArray(merged.content) && merged.content[1]).not.toHaveProperty('isTaskUpdate');
  });
});
