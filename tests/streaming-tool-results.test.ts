import { describe, expect, it } from 'vitest';

import {
  attachToolResultsToMessages,
  normalizeToolResultMessages,
} from '@/lib/streaming';
import type { ContentBlock, Message, ToolResultBlock } from '@/types';

function createAssistantMessage(content: ContentBlock[]): Message {
  return {
    id: 'assistant-1',
    thread_id: 'thread-1',
    role: 'assistant',
    content,
    created_at: Date.now(),
  };
}

describe('tool result attachment', () => {
  it('preserves sparse assistant content without materializing undefined blocks', () => {
    const sparseContent = [] as ContentBlock[];
    sparseContent[1] = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/tmp/a.txt' },
    };

    const toolResult: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'ok',
    };

    const next = attachToolResultsToMessages(
      [createAssistantMessage(sparseContent)],
      [toolResult],
      { threadId: 'thread-1' }
    );

    const assistantContent = next[0].content as unknown[];
    expect(0 in assistantContent).toBe(false);
    expect(assistantContent.at(-1)).toEqual(toolResult);
  });

  it('sanitizes invalid assistant blocks during render normalization', () => {
    const messages: Message[] = [
      {
        id: 'assistant-1',
        thread_id: 'thread-1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
          },
          undefined as unknown as ContentBlock,
        ],
        created_at: Date.now(),
      },
    ];

    expect(() => normalizeToolResultMessages(messages)).not.toThrow();
    const normalized = normalizeToolResultMessages(messages);
    expect(normalized[0].content).toEqual([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: '/tmp/a.txt' },
      },
    ]);
  });
});
