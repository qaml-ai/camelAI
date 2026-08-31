import { describe, expect, it } from 'vitest';

import type { UIMessage } from 'ai';

import {
  messageToUiMessage,
  uiMessageToMessage,
  uiMessagesEquivalent,
} from '@/lib/ui-message-adapter';
import type { ContentBlock, Message } from '@/types';

function assistant(content: ContentBlock[], extra: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    thread_id: 'thread-1',
    role: 'assistant',
    content,
    created_at: 1000,
    ...extra,
  };
}

// Compare only the fields the adapter is responsible for preserving.
function semantic(message: Message) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return {
    role: message.role,
    forkEntryId: message.forkEntryId ?? null,
    blocks: blocks.map((block) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text, itemKind: block.itemKind };
        case 'thinking':
          return { type: 'thinking', thinking: block.thinking, itemKind: block.itemKind };
        case 'tool_use':
          return { type: 'tool_use', name: block.name, input: block.input, itemKind: block.itemKind };
        case 'tool_result':
          return {
            type: 'tool_result',
            content: block.content,
            is_error: block.is_error === true,
            status: block.status,
          };
        default:
          return { type: block.type };
      }
    }),
  };
}

describe('ui-message-adapter round trip (Message → UIMessage → Message)', () => {
  it('preserves text, reasoning, and fork identity', () => {
    const message = assistant(
      [
        { type: 'thinking', thinking: 'reasoning here', itemKind: 'reasoning', label: 'Thinking', summaries: [] },
        { type: 'text', text: 'Final answer' },
      ],
      { forkEntryId: 'fork-1' },
    );
    const round = uiMessageToMessage(messageToUiMessage(message), { threadId: 'thread-1' });
    expect(semantic(round)).toEqual(semantic(message));
    expect(round.forkEntryId).toBe('fork-1');
  });

  it('carries fork id into UIMessage id and metadata', () => {
    const ui = messageToUiMessage(assistant([{ type: 'text', text: 'hi' }], { forkEntryId: 'fork-abc' }));
    expect(ui.id).toBe('fork-abc');
    expect(ui.metadata).toEqual({ pi: { forkEntryId: 'fork-abc', createdAtMs: 1000 } });
  });

  it('stamps created_at into metadata and restores it on read', () => {
    // Without the stamp a backfilled message reads back with created_at 0
    // (epoch) and the bubble renders a 1970 timestamp.
    const ui = messageToUiMessage(assistant([{ type: 'text', text: 'hi' }]));
    expect(ui.metadata).toEqual({ pi: { createdAtMs: 1000 } });
    const round = uiMessageToMessage(ui, { threadId: 'thread-1' });
    expect(round.created_at).toBe(1000);
    // An explicit caller-provided createdAt still wins.
    expect(uiMessageToMessage(ui, { threadId: 'thread-1', createdAt: 7 }).created_at).toBe(7);
  });

  it('falls back to turn-end completedAtMs when no createdAtMs stamp exists', () => {
    const live = uiMessageToMessage(
      {
        id: 'm',
        role: 'assistant',
        parts: [{ type: 'text', text: 'hi', state: 'done' }],
        metadata: { pi: { completedAtMs: 4242 } },
      } as never,
      { threadId: 'thread-1' },
    );
    expect(live.created_at).toBe(4242);
  });

  it('pairs tool_use with its tool_result', () => {
    const message = assistant([
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' }, itemKind: 'commandExecution' },
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        content: 'file1\nfile2',
        status: 'succeeded',
        itemId: 'call-1',
        itemKind: 'commandExecution',
      },
    ]);
    const round = uiMessageToMessage(messageToUiMessage(message), { threadId: 'thread-1' });
    expect(semantic(round).blocks).toEqual([
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, itemKind: 'commandExecution' },
      { type: 'tool_result', content: 'file1\nfile2', is_error: false, status: 'succeeded' },
    ]);
  });

  it('round-trips structured tool result details', () => {
    const message = assistant([
      { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { path: 'a.ts' }, itemKind: 'dynamicToolCall' },
      {
        type: 'tool_result',
        tool_use_id: 'edit-1',
        content: 'edited',
        status: 'succeeded',
        details: { diff: '-1 old\n+1 new', replacementCount: 1 },
      },
    ]);
    const round = uiMessageToMessage(messageToUiMessage(message), { threadId: 'thread-1' });
    const result = (round.content as ContentBlock[]).find((block) => block.type === 'tool_result');
    expect(result).toMatchObject({
      details: { diff: '-1 old\n+1 new', replacementCount: 1 },
    });
  });

  it('folds a code-mode artifact data part onto its tool_result at read time', () => {
    // The artifact part can arrive after the tool's completed output (recorded
    // mid-js_exec), so read-time folding must not depend on wire order: put it
    // last, after the tool part it belongs to.
    const artifact = {
      id: 'art-1',
      kind: 'outbound_email' as const,
      toolName: 'send_email',
      status: 'sent' as const,
      title: 'Sent invite',
      createdAt: 1,
      updatedAt: 1,
      summary: {},
    };
    const message = uiMessageToMessage(
      {
        id: 'm',
        role: 'assistant',
        parts: [
          {
            type: 'tool-js_exec',
            toolCallId: 'call-9',
            toolName: 'js_exec',
            state: 'output-available',
            input: { code: 'sendEmail()' },
            output: { content: 'done', isError: false },
          },
          {
            type: 'data-pi-artifacts',
            id: 'pi-artifacts:call-9',
            data: { toolCallId: 'call-9', artifacts: [artifact] },
          },
        ],
      } as never,
      { threadId: 'thread-1' },
    );
    const result = (message.content as ContentBlock[]).find((b) => b.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'call-9' });
    expect((result as { artifacts?: unknown[] }).artifacts).toEqual([artifact]);
  });

  it('round-trips code-mode artifacts through the backfill data part', () => {
    // Backfilled pi_core rows surface artifacts on the tool_result; messageToUiMessage
    // must emit a data-pi-artifacts part so they render like a live turn.
    const artifact = {
      id: 'art-2',
      kind: 'outbound_email' as const,
      toolName: 'send_email' as const,
      status: 'sent' as const,
      title: 'Sent',
      createdAt: 1,
      updatedAt: 1,
      summary: {},
    };
    const message = assistant([
      { type: 'tool_use', id: 'call-7', name: 'js_exec', input: { code: 'x' }, itemKind: 'dynamicToolCall' },
      {
        type: 'tool_result',
        tool_use_id: 'call-7',
        content: 'ok',
        status: 'succeeded',
        itemId: 'call-7',
        itemKind: 'dynamicToolCall',
        artifacts: [artifact],
      },
    ]);
    const ui = messageToUiMessage(message);
    expect(ui.parts).toContainEqual({
      type: 'data-pi-artifacts',
      id: 'pi-artifacts:call-7',
      data: { toolCallId: 'call-7', artifacts: [artifact] },
    });
    const round = uiMessageToMessage(ui, { threadId: 'thread-1' });
    const result = (round.content as ContentBlock[]).find((b) => b.type === 'tool_result');
    expect((result as { artifacts?: unknown[] }).artifacts).toEqual([artifact]);
  });

  it('preserves a failed tool result', () => {
    const message = assistant([
      { type: 'tool_use', id: 'call-2', name: 'Bash', input: { command: 'bad' }, itemKind: 'commandExecution' },
      {
        type: 'tool_result',
        tool_use_id: 'call-2',
        content: 'boom',
        is_error: true,
        status: 'failed',
        itemId: 'call-2',
        itemKind: 'commandExecution',
      },
    ]);
    const round = uiMessageToMessage(messageToUiMessage(message), { threadId: 'thread-1' });
    const result = (round.content as ContentBlock[]).find((b) => b.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', is_error: true, status: 'failed', content: 'boom' });
  });

  it('surfaces the settled output status on the tool_use input', () => {
    // A tool part whose input froze at "running" but completed successfully must
    // render input.status "completed" (legacy upserted status at item/completed).
    const completed = uiMessageToMessage(
      {
        id: 'm',
        role: 'assistant',
        parts: [
          {
            type: 'tool-Bash',
            toolCallId: 'c1',
            toolName: 'Bash',
            state: 'output-available',
            input: { command: 'ls', status: 'running' },
            output: { content: 'ok', isError: false, status: 'completed' },
          },
        ],
      } as never,
      { threadId: 'thread-1' },
    );
    const toolUse = (completed.content as ContentBlock[]).find((b) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ type: 'tool_use', input: { command: 'ls', status: 'completed' } });

    const failed = uiMessageToMessage(
      {
        id: 'm',
        role: 'assistant',
        parts: [
          {
            type: 'tool-Bash',
            toolCallId: 'c2',
            toolName: 'Bash',
            state: 'output-available',
            input: { command: 'bad', status: 'running' },
            output: { content: 'boom', isError: true, status: 'failed' },
          },
        ],
      } as never,
      { threadId: 'thread-1' },
    );
    const failedUse = (failed.content as ContentBlock[]).find((b) => b.type === 'tool_use');
    const failedResult = (failed.content as ContentBlock[]).find((b) => b.type === 'tool_result');
    expect(failedUse).toMatchObject({ type: 'tool_use', input: { command: 'bad', status: 'failed' } });
    expect(failedResult).toMatchObject({ type: 'tool_result', is_error: true, status: 'failed' });
  });

  it('round-trips the turn-plan TodoWrite panel through data-pi-todos', () => {
    const todos = [{ content: 'A', status: 'completed', activeForm: 'A' }];
    const message = assistant([
      { type: 'tool_use', id: 'turn:plan:todo', name: 'TodoWrite', input: { explanation: 'Plan', todos }, itemKind: 'turnPlan' },
    ]);
    const ui = messageToUiMessage(message);
    expect(ui.parts[0]).toMatchObject({ type: 'data-pi-todos', id: 'turn-plan' });
    const round = uiMessageToMessage(ui, { threadId: 'thread-1' });
    expect(semantic(round).blocks).toEqual([
      { type: 'tool_use', name: 'TodoWrite', input: { explanation: 'Plan', todos }, itemKind: 'turnPlan' },
    ]);
  });

  it('round-trips a userStop text block through data-pi-user-stop', () => {
    const message = assistant([{ type: 'text', text: 'Stopped by user', itemKind: 'userStop' }]);
    const ui = messageToUiMessage(message);
    expect(ui.parts[0]).toMatchObject({ type: 'data-pi-user-stop', data: { text: 'Stopped by user' } });
    const round = uiMessageToMessage(ui, { threadId: 'thread-1' });
    expect(semantic(round).blocks).toEqual([{ type: 'text', text: 'Stopped by user', itemKind: 'userStop' }]);
  });

  it('round-trips a turnNotice text block through data-pi-turn-notice', () => {
    const message = assistant([
      { type: 'text', text: 'This turn was interrupted', itemKind: 'turnNotice' },
    ]);
    const ui = messageToUiMessage(message);
    expect(ui.parts[0]).toMatchObject({
      type: 'data-pi-turn-notice',
      data: { text: 'This turn was interrupted' },
    });
    const round = uiMessageToMessage(ui, { threadId: 'thread-1' });
    expect(semantic(round).blocks).toEqual([
      { type: 'text', text: 'This turn was interrupted', itemKind: 'turnNotice' },
    ]);
  });

  it('round-trips a terminal error block through data-pi-error, preserving metadata', () => {
    const message = assistant([
      {
        type: 'error',
        error: 'Insufficient credits',
        billingSource: 'hosted',
        provider: 'anthropic',
        status: 402,
        errorType: 'billing',
      },
    ]);
    const ui = messageToUiMessage(message);
    // Backfill carries a durable data-pi-error part (not lossy plain text).
    expect(ui.parts[0]).toMatchObject({
      type: 'data-pi-error',
      id: 'pi-error',
      data: { error: 'Insufficient credits', billingSource: 'hosted', status: 402, errorType: 'billing' },
    });
    const round = uiMessageToMessage(ui, { threadId: 'thread-1' });
    expect(round.content).toEqual([
      {
        type: 'error',
        error: 'Insufficient credits',
        billingSource: 'hosted',
        provider: 'anthropic',
        status: 402,
        errorType: 'billing',
      },
    ]);
  });

  it('surfaces a live-emitted data-pi-error part as an inline error block', () => {
    const ui = {
      id: 'm',
      role: 'assistant' as const,
      parts: [
        { type: 'text', text: 'partial', state: 'done' },
        {
          type: 'data-pi-error',
          id: 'pi-error',
          data: {
            id: 'err-1',
            error: 'Rate limited',
            billingSource: 'byok',
            provider: 'openai',
            status: 429,
            errorType: 'rate_limit',
          },
        },
      ],
    };
    const message = uiMessageToMessage(ui as never, { threadId: 'thread-1' });
    expect(message.content).toEqual([
      { type: 'text', text: 'partial' },
      {
        type: 'error',
        error: 'Rate limited',
        billingSource: 'byok',
        provider: 'openai',
        status: 429,
        errorType: 'rate_limit',
      },
    ]);
  });

  it('maps a string-content user message to a single text part', () => {
    const ui = messageToUiMessage({
      id: 'u1',
      thread_id: 'thread-1',
      role: 'user',
      content: 'Hello there',
      created_at: 5,
    });
    expect(ui.role).toBe('user');
    expect(ui.parts).toEqual([{ type: 'text', text: 'Hello there', state: 'done' }]);
  });

  it('round-trips the sentDuringStreaming user metadata flag', () => {
    const ui = messageToUiMessage({
      id: 'u-steer',
      thread_id: 'thread-1',
      role: 'user',
      content: 'Use SQLite instead',
      created_at: 5,
      sentDuringStreaming: true,
    });

    expect(ui.metadata).toEqual({
      pi: { createdAtMs: 5 },
      sentDuringStreaming: true,
    });
    expect(
      uiMessageToMessage(ui, { threadId: 'thread-1' }).sentDuringStreaming,
    ).toBe(true);

    const live = uiMessageToMessage(
      {
        id: 'u-live',
        role: 'user',
        parts: [{ type: 'text', text: 'steer', state: 'done' }],
        metadata: { sentDuringStreaming: true },
      } as never,
      { threadId: 'thread-1' },
    );
    expect(live.sentDuringStreaming).toBe(true);
  });

  it('maps valid author/source metadata both directions', () => {
    const fromUi = uiMessageToMessage(
      {
        id: 'u-attributed',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello', state: 'done' }],
        metadata: {
          authorDisplayName: '  Illiana Reed  ',
          source: ' slack ',
        },
      } as never,
      { threadId: 'thread-1' },
    );
    expect(fromUi).toMatchObject({
      authorDisplayName: 'Illiana Reed',
      messageSource: 'slack',
    });

    const ui = messageToUiMessage({
      ...fromUi,
      created_at: 5,
    });
    expect(ui.metadata).toMatchObject({
      authorDisplayName: 'Illiana Reed',
      source: 'slack',
    });
  });

  it('ignores blank and malformed author/source metadata', () => {
    const message = uiMessageToMessage(
      {
        id: 'u-invalid-attribution',
        role: 'user',
        parts: [{ type: 'text', text: 'Hello', state: 'done' }],
        metadata: { authorDisplayName: 42, source: '   ' },
      } as never,
    );
    expect(message.authorDisplayName).toBeUndefined();
    expect(message.messageSource).toBeUndefined();
  });

  it('drops transient tool-stream, steer-marker, and step-start parts on read', () => {
    const ui = {
      id: 'm',
      role: 'assistant' as const,
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'visible', state: 'done' },
        {
          type: 'data-pi-steer-marker',
          id: 'pi:steer:u1',
          data: { steerMessageId: 'u1', acceptedAtMs: 1 },
        },
        { type: 'data-pi-tool-stream', data: { toolCallId: 't', text: 'noise' } },
      ],
    };
    const message = uiMessageToMessage(ui as never, { threadId: 'thread-1' });
    expect(message.content).toEqual([{ type: 'text', text: 'visible' }]);
  });
});

describe('uiMessagesEquivalent', () => {
  function ui(id: string, parts: unknown[], metadata?: unknown): UIMessage {
    return {
      id,
      role: 'assistant',
      parts,
      ...(metadata !== undefined ? { metadata } : {}),
    } as unknown as UIMessage;
  }

  it('treats an identical payload as already applied', () => {
    const a = [
      ui('u1', [{ type: 'text', text: 'hi', state: 'done' }]),
      ui('a1', [{ type: 'text', text: 'answer', state: 'done' }], {
        pi: { completedAtMs: 100 },
      }),
    ];
    const b = [
      ui('u1', [{ type: 'text', text: 'hi', state: 'done' }]),
      ui('a1', [{ type: 'text', text: 'answer', state: 'done' }], {
        pi: { completedAtMs: 100 },
      }),
    ];
    expect(uiMessagesEquivalent(a, b)).toBe(true);
  });

  it('reconciles a missed completion persisted under the same assistant id', () => {
    // Same ids, but the redelivered payload grew the assistant turn (a tool part
    // gained output, a longer final text) and stamped completion metadata.
    const partial = [
      ui('a1', [{ type: 'text', text: 'thinki', state: 'streaming' }]),
    ];
    const completed = [
      ui(
        'a1',
        [
          { type: 'text', text: 'thinking done', state: 'done' },
          { type: 'tool-run', state: 'output-available', output: { ok: true } },
        ],
        { pi: { completedAtMs: 200 } },
      ),
    ];
    // ids match, so an id-only comparison would (wrongly) skip.
    expect(partial[0].id).toBe(completed[0].id);
    expect(uiMessagesEquivalent(partial, completed)).toBe(false);
  });

  it('detects changed metadata under identical parts', () => {
    const before = [ui('a1', [{ type: 'text', text: 'x', state: 'done' }])];
    const afterFork = [
      ui('a1', [{ type: 'text', text: 'x', state: 'done' }], {
        pi: { forkEntryId: 'fork-1' },
      }),
    ];
    expect(uiMessagesEquivalent(before, afterFork)).toBe(false);
  });

  it('detects metadata-only author and source repairs under identical parts', () => {
    const before = [ui('u1', [{ type: 'text', text: 'x', state: 'done' }])];
    const afterAuthor = [
      ui('u1', [{ type: 'text', text: 'x', state: 'done' }], {
        authorDisplayName: 'Illiana Reed',
      }),
    ];
    const afterSource = [
      ui('u1', [{ type: 'text', text: 'x', state: 'done' }], {
        source: 'email',
      }),
    ];
    expect(uiMessagesEquivalent(before, afterAuthor)).toBe(false);
    expect(uiMessagesEquivalent(before, afterSource)).toBe(false);
  });

  it('detects a grown text part with the same part count', () => {
    const before = [ui('a1', [{ type: 'text', text: 'par', state: 'streaming' }])];
    const after = [
      ui('a1', [{ type: 'text', text: 'partial then full', state: 'done' }]),
    ];
    expect(uiMessagesEquivalent(before, after)).toBe(false);
  });

  it('returns false when the lengths differ', () => {
    const a = [ui('a1', [{ type: 'text', text: 'x', state: 'done' }])];
    const b = [
      ui('a1', [{ type: 'text', text: 'x', state: 'done' }]),
      ui('a2', [{ type: 'text', text: 'y', state: 'done' }]),
    ];
    expect(uiMessagesEquivalent(a, b)).toBe(false);
  });
});
