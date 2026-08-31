import { describe, expect, it } from 'vitest';
import { applyChunkToParts } from 'agents/chat';
import { readUIMessageStream } from 'ai';
import type { UIMessage } from 'ai';

import {
  PiChunkEncoder,
  encodePiEventStream,
  piSteerMarkerPartId,
  PI_STEER_MARKER_PART,
  type PiRuntimeEvent,
  type PiUiMessageChunk,
} from '@/lib/pi-chunk-encoder';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { uiMessageToMessage } from '@/lib/ui-message-adapter';
import type { ContentBlock, Message } from '@/types';

// --- Minimal UIMessage reader, mirroring ai-chat's _reply chunk consumption:
// id from `start`, metadata from `message-metadata`, everything else through the
// shared last-part-oriented builder.
function buildUiMessage(chunks: PiUiMessageChunk[], fallbackId: string): UIMessage {
  let id = fallbackId;
  let metadata: Record<string, unknown> | undefined;
  const parts: unknown[] = [];
  for (const chunk of chunks) {
    if (chunk.type === 'start') {
      if (chunk.messageId) id = chunk.messageId;
      continue;
    }
    if (chunk.type === 'message-metadata') {
      metadata = { ...(metadata ?? {}), ...(chunk.messageMetadata as unknown as Record<string, unknown>) };
      continue;
    }
    if (chunk.type === 'finish' || chunk.type === 'error') continue;
    applyChunkToParts(parts as never, chunk as never);
  }
  return { id, role: 'assistant', parts: parts as UIMessage['parts'], metadata } as UIMessage;
}

function types(chunks: PiUiMessageChunk[]): string[] {
  return chunks.map((chunk) => chunk.type);
}

describe('PiChunkEncoder unit families', () => {
  it('emits start + start-step at the head, once', () => {
    const encoder = new PiChunkEncoder({ messageId: 'msg-1' });
    expect(encoder.start()).toEqual([
      { type: 'start', messageId: 'msg-1' },
      { type: 'start-step' },
    ]);
    expect(encoder.start()).toEqual([]);
  });

  it('brackets a single agentMessage item as one text part', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const chunks = [
      ...encoder.encode({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hel' } }),
      ...encoder.encode({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'lo' } }),
    ];
    expect(types(chunks)).toEqual(['text-start', 'text-delta', 'text-delta']);
    expect((chunks[1] as { delta: string }).delta).toBe('Hel');
  });

  it('keeps concurrent text/reasoning parts open; closes only on a same-kind switch', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const chunks = [
      ...encoder.encode({ method: 'item/reasoning/textDelta', params: { itemId: 'r', contentIndex: 0, delta: 'think' } }),
      // A text item starting does NOT close the streaming reasoning part (the
      // builder tracks the kinds independently) …
      ...encoder.encode({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'answer' } }),
      // … but a DIFFERENT reasoning item does close the first one (within a
      // kind the builder is append-to-last).
      ...encoder.encode({ method: 'item/reasoning/textDelta', params: { itemId: 'r2', contentIndex: 0, delta: 'more' } }),
    ];
    expect(types(chunks)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'text-start',
      'text-delta',
      'reasoning-end',
      'reasoning-start',
      'reasoning-delta',
    ]);
    const firstReasoning = chunks[1] as { providerMetadata?: { pi?: { kind?: string; itemId?: string } } };
    expect(firstReasoning.providerMetadata?.pi).toMatchObject({ kind: 'reasoning', itemId: 'r', contentIndex: 0 });
  });

  it('accumulates interleaved reasoning/text deltas into two coherent parts', () => {
    // Fast self-hosted models flush reasoning and message deltas interleaved;
    // the old single-open-slot encoder fragmented them into alternating
    // slivers ("Thought … / Now let / Thought … / me rebuild…").
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const chunks = [
      ...encoder.encode({ method: 'item/reasoning/textDelta', params: { itemId: 'r', contentIndex: 0, delta: 'Now I need to rebuild. ' } }),
      ...encoder.encode({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Now let ' } }),
      ...encoder.encode({ method: 'item/reasoning/textDelta', params: { itemId: 'r', contentIndex: 0, delta: 'Then test the API routes.' } }),
      ...encoder.encode({ method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'me rebuild and redeploy.' } }),
      ...encoder.encode({ method: 'item/completed', params: { item: { id: 'r', type: 'reasoning', content: [] } } }),
      ...encoder.encode({ method: 'item/completed', params: { item: { id: 'a', type: 'agentMessage', text: 'Now let me rebuild and redeploy.' } } }),
    ];
    // Exactly one part of each kind: one start per kind, deltas routed to it,
    // ends only at the items' own completions.
    expect(types(chunks)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'text-start',
      'text-delta',
      'reasoning-delta',
      'text-delta',
      'reasoning-end',
      'text-end',
    ]);
  });

  it('opens a tool part at started and settles input+output at completed', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const started = encoder.encode({
      method: 'item/started',
      params: { item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'running' } },
    });
    const stream = encoder.encode({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 't1', delta: 'file1\n' },
    });
    const completed = encoder.encode({
      method: 'item/completed',
      params: {
        item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: 'file1\n' },
      },
    });
    // Live tool card renders from tool-input-start + streamed input.
    expect(types(started)).toEqual(['tool-input-start', 'tool-input-delta']);
    expect(started[0]).toMatchObject({
      type: 'tool-input-start',
      toolCallId: 't1',
      toolName: 'Bash',
      providerMetadata: { pi: { itemKind: 'commandExecution' } },
    });
    // Dual-encoded for both consumers: the server-side builder reads `input`,
    // the browser reducer accumulates `inputTextDelta` and parses it.
    expect(started[1]).toMatchObject({ type: 'tool-input-delta', toolCallId: 't1', input: { command: 'ls', status: 'running' } });
    const inputTextDelta = (started[1] as { inputTextDelta: string }).inputTextDelta;
    expect(JSON.parse(inputTextDelta)).toEqual({ command: 'ls', status: 'running' });
    // Output deltas are transient (live/replay only, never persisted).
    expect(types(stream)).toEqual(['data-pi-tool-stream']);
    expect(stream[0]).toMatchObject({ type: 'data-pi-tool-stream', transient: true });
    // Completion settles the merged input then the output.
    expect(types(completed)).toEqual(['tool-input-available', 'tool-output-available']);
    expect(completed[0]).toMatchObject({
      type: 'tool-input-available',
      toolCallId: 't1',
      toolName: 'Bash',
      input: { command: 'ls', status: 'completed' },
    });
    expect(completed[1]).toMatchObject({
      type: 'tool-output-available',
      toolCallId: 't1',
      output: { isError: false, status: 'completed' },
    });
  });

  it('merges input fields the runtime only supplies at item/completed', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/started',
      params: { item: { id: 't3', type: 'dynamicToolCall', tool: 'validate_workflow', arguments: {}, status: 'running' } },
    });
    const completed = encoder.encode({
      method: 'item/completed',
      params: {
        item: {
          id: 't3',
          type: 'dynamicToolCall',
          tool: 'validate_workflow',
          arguments: { name: 'daily-sync' },
          status: 'completed',
        },
      },
    });
    const available = completed.find((c) => c.type === 'tool-input-available') as {
      input: Record<string, unknown>;
    };
    // The `name` arg absent at started reaches the finalized input.
    expect(available.input).toMatchObject({ name: 'daily-sync', arguments: { name: 'daily-sync' }, status: 'completed' });
  });

  it('carries completed child-agent activity into the durable tool output', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/started',
      params: {
        item: {
          id: 'oracle-1',
          type: 'dynamicToolCall',
          tool: 'Oracle',
          arguments: { question: 'Fix the issue' },
          status: 'running',
        },
      },
    });
    const chunks = encoder.encode({
      method: 'item/completed',
      params: {
        item: {
          id: 'oracle-1',
          type: 'dynamicToolCall',
          tool: 'Oracle',
          arguments: { question: 'Fix the issue' },
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'Fixed.' }],
          result: {
            details: {
              activities: ['read · public/main.js', 'edit · public/main.js'],
              toolActivities: [
                { toolCallId: 'child-read', toolName: 'read', label: 'read · public/main.js', status: 'complete' },
                { toolCallId: 'child-edit', toolName: 'edit', label: 'edit · public/main.js', status: 'complete' },
              ],
              durationMs: 5_000,
              toolUseCount: 2,
            },
          },
        },
      },
    });
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'tool-output-available',
      toolCallId: 'oracle-1',
      output: expect.objectContaining({
        details: {
          activities: ['read · public/main.js', 'edit · public/main.js'],
          toolActivities: [
            { toolCallId: 'child-read', toolName: 'read', label: 'read · public/main.js', status: 'complete' },
            { toolCallId: 'child-edit', toolName: 'edit', label: 'edit · public/main.js', status: 'complete' },
          ],
          durationMs: 5_000,
          toolUseCount: 2,
        },
      }),
    }));
  });

  it('preserves started-only input fields when item/completed omits them', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/started',
      params: { item: { id: 'wf', type: 'dynamicToolCall', tool: 'web_fetch', arguments: { url: 'https://example.com' }, status: 'running' } },
    });
    const completed = encoder.encode({
      method: 'item/completed',
      params: { item: { id: 'wf', type: 'dynamicToolCall', tool: 'web_fetch', status: 'completed', result: 'ok' } },
    });
    const available = completed.find((c) => c.type === 'tool-input-available') as {
      toolName: string;
      input: Record<string, unknown>;
    };
    // The url only present at started survives the completed-side rebuild that
    // omits arguments (encoder merges started+completed input).
    expect(available.toolName).toBe('WebFetch');
    expect(available.input).toMatchObject({ url: 'https://example.com', status: 'completed', rawToolName: 'web_fetch' });
  });

  it('keeps a commandExecution description supplied only at item/started', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/started',
      params: { item: { id: 'b', type: 'commandExecution', command: 'pwd', description: 'Check workspace directory', status: 'running' } },
    });
    const completed = encoder.encode({
      method: 'item/completed',
      params: { item: { id: 'b', type: 'commandExecution', command: 'pwd', status: 'completed', aggregatedOutput: '/workspace\n' } },
    });
    const available = completed.find((c) => c.type === 'tool-input-available') as {
      toolName: string;
      input: Record<string, unknown>;
    };
    expect(available.toolName).toBe('Bash');
    expect(available.input).toMatchObject({ command: 'pwd', description: 'Check workspace directory', status: 'completed' });
  });

  it('creates the tool part from item/completed alone when there was no item/started', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const completed = encoder.encode({
      method: 'item/completed',
      params: {
        item: {
          id: 't4',
          type: 'dynamicToolCall',
          tool: 'validate_workflow',
          arguments: { name: 'daily-sync' },
          status: 'failed',
          isError: true,
          contentItems: [{ type: 'inputText', text: 'invalid' }],
        },
      },
    });
    expect(types(completed)).toEqual(['tool-input-available', 'tool-output-available']);
    expect(completed[0]).toMatchObject({ type: 'tool-input-available', toolName: 'ValidateWorkflow', input: { name: 'daily-sync' } });
    expect(completed[1]).toMatchObject({ type: 'tool-output-available', output: { isError: true } });
  });

  it('carries bounded structured edit details on the settled tool output', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const completed = encoder.encode({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-1',
          type: 'dynamicToolCall',
          tool: 'edit',
          arguments: { path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] },
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'edited' }],
          result: {
            details: {
              details: { diff: '-1 old\n+1 new', patch: '@@ patch', replacementCount: 1 },
            },
          },
        },
      },
    });

    expect(completed.find((chunk) => chunk.type === 'tool-output-available')).toMatchObject({
      output: {
        details: { diff: '-1 old\n+1 new', patch: '@@ patch', replacementCount: 1 },
      },
    });
  });

  it('emits a non-transient data-pi-todos part with fixed id, reconciled in place', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const first = encoder.encode({
      method: 'turn/plan/updated',
      params: { explanation: 'Working', plan: [{ step: 'A', status: 'inProgress' }] },
    });
    const second = encoder.encode({
      method: 'turn/plan/updated',
      params: { explanation: 'Working', plan: [{ step: 'A', status: 'completed' }] },
    });
    expect(first[0]).toMatchObject({
      type: 'data-pi-todos',
      id: 'turn-plan',
      data: { explanation: 'Working', todos: [{ content: 'A', status: 'in_progress', activeForm: 'A' }] },
    });
    expect(second).toEqual([
      {
        type: 'data-pi-todos',
        id: 'turn-plan',
        data: { explanation: 'Working', todos: [{ content: 'A', status: 'completed', activeForm: 'A' }] },
      },
    ]);
  });

  it('maps a userStop delta to a non-transient data-pi-user-stop part', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const chunks = encoder.encode({
      method: 'item/agentMessage/delta',
      params: { itemId: 'f', itemKind: 'userStop', delta: 'Stopped by user' },
    });
    expect(chunks).toEqual([
      { type: 'data-pi-user-stop', id: 'user-stop', data: { text: 'Stopped by user' } },
    ]);
  });

  it('maps a turnNotice delta to its own part, closing any open text run', () => {
    // A turn-level note (the recovery ladder's salvage note) must never ride a
    // text delta: on a recovery CONTINUE, ai-chat drops the encoder's text-start
    // and appends the delta to the orphan partial's still-streaming text part,
    // splicing the note onto a half-written sentence.
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/agentMessage/delta',
      params: { itemId: 'a', delta: 'half a sen' },
    });
    const chunks = encoder.encode({
      method: 'item/agentMessage/delta',
      params: { itemId: 'n', itemKind: 'turnNotice', delta: 'Ask me to continue' },
    });
    expect(chunks).toEqual([
      { type: 'text-end' },
      { type: 'data-pi-turn-notice', id: 'turn-notice', data: { text: 'Ask me to continue' } },
    ]);
  });

  it('closes open content and emits a distinct durable part for each steer', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/agentMessage/delta',
      params: { itemId: 'a', delta: 'answer' },
    });
    encoder.encode({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'r', contentIndex: 0, delta: 'thought' },
    });

    const first = encoder.encodeSteerMarker('u1', 10);
    const second = encoder.encodeSteerMarker('u2', 20);

    expect(types(first)).toEqual([
      'text-end',
      'reasoning-end',
      PI_STEER_MARKER_PART,
    ]);
    expect(first.at(-1)).toEqual({
      type: PI_STEER_MARKER_PART,
      id: piSteerMarkerPartId('u1'),
      data: { steerMessageId: 'u1', acceptedAtMs: 10 },
    });
    expect(second).toEqual([
      {
        type: PI_STEER_MARKER_PART,
        id: piSteerMarkerPartId('u2'),
        data: { steerMessageId: 'u2', acceptedAtMs: 20 },
      },
    ]);
    expect(piSteerMarkerPartId('u1')).not.toBe(piSteerMarkerPartId('u2'));

    encoder.encode({ method: 'turn/completed', params: {} });
    expect(encoder.encodeSteerMarker('too-late', 30)).toEqual([]);
  });

  it('emits message-metadata + finish on turn/completed and ignores sdk turn events', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    expect(encoder.encode({ method: 'sdk/turn/started', params: {} })).toEqual([]);
    const chunks = encoder.encode({
      method: 'turn/completed',
      params: { forkEntryId: 'fork-9', turnDurationMs: 42, completedAtMs: 100, sdkTurnCount: 2 },
    });
    expect(chunks).toEqual([
      {
        type: 'message-metadata',
        messageMetadata: { pi: { forkEntryId: 'fork-9', turnDurationMs: 42, completedAtMs: 100, sdkTurnCount: 2 } },
      },
      { type: 'finish' },
    ]);
  });

  it('renders the live tool input through the browser reducer (ai processUIMessageStream path)', async () => {
    // The browser consumes chunks through ai's stream reducer, which reads
    // inputTextDelta (not input) — a chunk without it leaves the running tool
    // card's input undefined until item/completed.
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const chunks = [
      ...encoder.start(),
      ...encoder.encode({
        method: 'item/started',
        params: { item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'running' } },
      }),
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk as never);
        controller.close();
      },
    });
    let last: UIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) last = message;
    const toolPart = last?.parts.find((part) => 'toolCallId' in part) as
      | { state: string; input: unknown }
      | undefined;
    expect(toolPart).toMatchObject({
      state: 'input-streaming',
      input: { command: 'ls', status: 'running' },
    });
  });

  it('stamps a per-tool monotonically increasing seq on tool output deltas', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    encoder.encode({
      method: 'item/started',
      params: { item: { id: 't1', type: 'commandExecution', command: 'a', status: 'running' } },
    });
    encoder.encode({
      method: 'item/started',
      params: { item: { id: 't2', type: 'commandExecution', command: 'b', status: 'running' } },
    });
    const seqOf = (chunks: PiUiMessageChunk[]) =>
      (chunks[0] as { data: { seq: number } }).data.seq;
    expect(seqOf(encoder.encode({ method: 'item/commandExecution/outputDelta', params: { itemId: 't1', delta: 'one' } }))).toBe(0);
    expect(seqOf(encoder.encode({ method: 'item/commandExecution/outputDelta', params: { itemId: 't1', delta: 'two' } }))).toBe(1);
    // Independent counter per tool.
    expect(seqOf(encoder.encode({ method: 'item/commandExecution/outputDelta', params: { itemId: 't2', delta: 'x' } }))).toBe(0);
    expect(seqOf(encoder.encode({ method: 'item/commandExecution/terminalInteraction', params: { itemId: 't1', input: 'y' } }))).toBe(2);
  });

  it('emits reasoning/plan text present at both item/started and item/completed once', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const plan = [
      ...encoder.encode({ method: 'item/started', params: { item: { id: 'p1', type: 'plan', text: 'the plan' } } }),
      ...encoder.encode({ method: 'item/completed', params: { item: { id: 'p1', type: 'plan', text: 'the plan' } } }),
    ];
    expect(types(plan)).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-end']);
    expect((plan[1] as { delta: string }).delta).toBe('the plan');

    const reasoning = [
      ...encoder.encode({ method: 'item/started', params: { item: { id: 'r1', type: 'reasoning', content: ['a thought'] } } }),
      ...encoder.encode({ method: 'item/completed', params: { item: { id: 'r1', type: 'reasoning', content: ['a thought'] } } }),
    ];
    expect(types(reasoning)).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-end']);
    expect((reasoning[1] as { delta: string }).delta).toBe('a thought');
  });

  it('still emits reasoning text supplied only at item/completed after an empty item/started', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const chunks = [
      ...encoder.encode({ method: 'item/started', params: { item: { id: 'p1', type: 'plan' } } }),
      ...encoder.encode({ method: 'item/completed', params: { item: { id: 'p1', type: 'plan', text: 'late plan' } } }),
    ];
    expect(types(chunks)).toEqual(['reasoning-start', 'reasoning-delta', 'reasoning-end']);
    expect((chunks[1] as { delta: string }).delta).toBe('late plan');
  });

  it('bounds oversized single-shot payloads', () => {
    const encoder = new PiChunkEncoder({ messageId: 'm' });
    const huge = 'x'.repeat(200_000);
    const chunks = encoder.encode({
      method: 'item/completed',
      params: {
        item: { id: 't', type: 'commandExecution', command: 'gen', status: 'completed', aggregatedOutput: huge },
      },
    });
    const output = (chunks.find((c) => c.type === 'tool-output-available') as { output: { content: string } }).output;
    expect(output.content.length).toBeLessThanOrEqual(128_000);
    expect(output.content.startsWith('…[earlier output truncated')).toBe(true);
  });
});

// --- Golden transcripts: recorded Pi event streams run through the
// encoder → applyChunkToParts → uiMessageToMessage pipeline, compared against
// frozen expected Message[] fixtures (see the describe block below for how to
// regenerate).

const GOLDEN_FIXTURE_PATH = resolve(process.cwd(), 'tests/fixtures/pi-golden-transcripts.json');

function encodeAdapt(events: PiRuntimeEvent[]): Message[] {
  const chunks = encodePiEventStream(events, { messageId: 'turn-stable' });
  const ui = buildUiMessage(chunks, 'turn-stable');
  return [uiMessageToMessage(ui, { threadId: 'thread-1' })];
}

const goldenStreams: Record<string, PiRuntimeEvent[]> = {
  'text only': [
    { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'Hello ' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'world' } },
    { method: 'turn/completed', params: { forkEntryId: 'fork-text', completedAtMs: 1 } },
  ],
  'completed agentMessage without deltas': [
    { method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', text: 'One-shot answer' } } },
    { method: 'turn/completed', params: { forkEntryId: 'fork-oneshot' } },
  ],
  'reasoning then text': [
    { method: 'item/reasoning/textDelta', params: { itemId: 'r1', contentIndex: 0, delta: 'Let me think.' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'The answer.' } },
    { method: 'turn/completed', params: { forkEntryId: 'fork-r' } },
  ],
  'interleaved reasoning/text/reasoning': [
    { method: 'item/reasoning/textDelta', params: { itemId: 'r1', contentIndex: 0, delta: 'First thought.' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'Interim answer' } },
    { method: 'item/reasoning/textDelta', params: { itemId: 'r2', contentIndex: 0, delta: 'Second thought.' } },
    { method: 'turn/completed', params: {} },
  ],
  'command execution with output delta': [
    { method: 'item/started', params: { item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'running' } } },
    { method: 'item/commandExecution/outputDelta', params: { itemId: 't1', delta: 'file1\n' } },
    {
      method: 'item/completed',
      params: { item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: 'file1\n' } },
    },
    { method: 'turn/completed', params: { forkEntryId: 'fork-cmd' } },
  ],
  'failed command execution': [
    { method: 'item/started', params: { item: { id: 't1', type: 'commandExecution', command: 'bad', status: 'running' } } },
    {
      method: 'item/completed',
      params: {
        item: { id: 't1', type: 'commandExecution', command: 'bad', status: 'failed', aggregatedOutput: 'boom\n', exitCode: 1 },
      },
    },
    { method: 'turn/completed', params: {} },
  ],
  'dynamic tool call': [
    {
      method: 'item/started',
      params: { item: { id: 't2', type: 'dynamicToolCall', tool: 'web_search', arguments: { query: 'x' }, status: 'running' } },
    },
    {
      method: 'item/completed',
      params: {
        item: {
          id: 't2',
          type: 'dynamicToolCall',
          tool: 'web_search',
          arguments: { query: 'x' },
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'result text' }],
        },
      },
    },
    { method: 'turn/completed', params: {} },
  ],
  'text, tool, text combined': [
    { method: 'item/reasoning/textDelta', params: { itemId: 'r1', contentIndex: 0, delta: 'think' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'Answer part 1' } },
    { method: 'item/started', params: { item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'running' } } },
    { method: 'item/commandExecution/outputDelta', params: { itemId: 't1', delta: 'out\n' } },
    {
      method: 'item/completed',
      params: { item: { id: 't1', type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: 'out\n' } },
    },
    { method: 'item/agentMessage/delta', params: { itemId: 'a2', delta: 'Answer part 2' } },
    { method: 'turn/completed', params: { forkEntryId: 'fork-combined' } },
  ],
  'user stop': [
    { method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'Partial ' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'f1', itemKind: 'userStop', delta: 'Stopped by user' } },
    { method: 'turn/completed', params: { forkEntryId: 'f1' } },
  ],
};

describe('tool-input upgrade path through applyChunkToParts', () => {
  it('input-start → input-available updates the built part input with merged args', () => {
    const events: PiRuntimeEvent[] = [
      {
        method: 'item/started',
        params: { item: { id: 't', type: 'dynamicToolCall', tool: 'validate_workflow', arguments: {}, status: 'running' } },
      },
      {
        method: 'item/completed',
        params: {
          item: { id: 't', type: 'dynamicToolCall', tool: 'validate_workflow', arguments: { name: 'daily-sync' }, status: 'completed' },
        },
      },
      { method: 'turn/completed', params: {} },
    ];
    const ui = buildUiMessage(encodePiEventStream(events, { messageId: 'turn' }), 'turn');
    const message = uiMessageToMessage(ui, { threadId: 'thread-1' });
    const toolUse = (message.content as ContentBlock[]).find((b) => b.type === 'tool_use');
    // The `name` arg only present at completion survives the input-streaming →
    // input-available transition (builder is not suppressed by isReplayChunk).
    expect(toolUse).toMatchObject({ name: 'ValidateWorkflow', input: { name: 'daily-sync', status: 'completed' } });
  });
});

describe('golden transcript: frozen encoder+adapter fixtures', () => {
  // Each fixture is the frozen adapted Message[] output of the
  // encoder → applyChunkToParts → uiMessageToMessage pipeline for one recorded
  // Pi event stream. The pipeline was verified semantically equivalent to the
  // legacy runtime reducer at commit 3a; that reducer has since been deleted, so
  // these fixtures are now the golden reference.
  //
  // To regenerate after a DELIBERATE encoder/adapter change, run:
  //   UPDATE_GOLDEN=1 bun run test:run tests/pi-chunk-encoder.test.ts
  // then review the fixture diff before committing.
  const generated: Record<string, Message[]> = {};
  for (const [name, events] of Object.entries(goldenStreams)) {
    generated[name] = encodeAdapt(events);
  }

  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(GOLDEN_FIXTURE_PATH), { recursive: true });
    writeFileSync(GOLDEN_FIXTURE_PATH, `${JSON.stringify(generated, null, 2)}\n`);
  }

  const expected = JSON.parse(
    readFileSync(GOLDEN_FIXTURE_PATH, 'utf8'),
  ) as Record<string, Message[]>;

  for (const name of Object.keys(goldenStreams)) {
    it(`matches frozen fixture for "${name}"`, () => {
      expect(generated[name]).toEqual(expected[name]);
    });
  }
});
