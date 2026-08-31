import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { repairPiMessageHistoryForReplay } from '../src/pi-message-history';

describe('repairPiMessageHistoryForReplay', () => {
  it('drops duplicate Pi tool results before provider replay', () => {
    const messages = [
      assistantWithToolCalls([{ id: 'tool1', name: 'read' }]),
      toolResult('tool1', 'first result'),
      toolResult('tool1', 'duplicate result', 301),
      { role: 'user', content: 'continue', timestamp: 400 },
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toEqual([messages[0], messages[1], messages[3]]);
    expect(result.stats).toEqual({
      droppedToolResults: 1,
      syntheticToolResults: 0,
      reorderedAssistantBlocks: 0,
    });
    expect(result.repairedCount).toBe(1);
  });

  it('synthesizes missing Pi tool results before provider replay', () => {
    const messages = [
      assistantWithToolCalls([
        { id: 'toolu_bdrk_01KrRfZTYj5KqFZAxKQexJbK', name: 'read' },
      ]),
      { role: 'user', content: 'continue', timestamp: 400 },
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'toolu_bdrk_01KrRfZTYj5KqFZAxKQexJbK',
      toolName: 'read',
      isError: true,
      // The placeholder must say the outcome is UNKNOWN, not that nothing ran:
      // production showed the model reading "no result was recorded" as "it
      // never ran" and re-deploying three already-deployed js_exec calls.
      content: [
        { type: 'text', text: expect.stringContaining('MAY OR MAY NOT have completed') },
      ],
    });
    expect(result.messages[2]).toBe(messages[1]);
    expect(result.stats.syntheticToolResults).toBe(1);
    expect(result.repairedCount).toBe(1);
  });

  it('recovers a completed tool result from durable evidence instead of reporting an unknown outcome', () => {
    const messages = [
      assistantWithToolCalls([{ id: 'deploy-1', name: 'deploy_project' }]),
      { role: 'user', content: 'continue', timestamp: 400 },
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages, [{
      id: 'deploy-1',
      toolName: 'deploy_project',
      status: 'succeeded',
      supportedClaims: ['deployed', 'published'],
      target: 'https://demo.camelai.app',
      updatedAt: 300,
    }]);

    expect(result.messages[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'deploy-1',
      toolName: 'deploy_project',
      isError: false,
      content: [{
        type: 'text',
        text: expect.stringContaining('Tool result recovered from durable completion evidence'),
      }],
    });
    expect((result.messages[1] as any).content[0].text).toContain('https://demo.camelai.app');
    expect((result.messages[1] as any).content[0].text).not.toContain('MAY OR MAY NOT');
  });

  it('synthesizes missing Pi tool results when assistant turn ends the history', () => {
    const messages = [
      assistantWithToolCalls([
        { id: 'tool1', name: 'read' },
        { id: 'tool2', name: 'bash' },
      ]),
      toolResult('tool1', 'ok'),
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tool2',
      toolName: 'bash',
      isError: true,
    });
    expect(result.stats.syntheticToolResults).toBe(1);
    expect(result.repairedCount).toBe(1);
  });

  it('does not synthesize missing Pi tool results for aborted assistant turns', () => {
    const messages = [
      assistantWithToolCalls([{ id: 'tool1', name: 'read' }], {
        stopReason: 'aborted',
      }),
      { role: 'user', content: 'continue', timestamp: 400 },
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toBe(messages);
    expect(result.stats.syntheticToolResults).toBe(0);
    expect(result.repairedCount).toBe(0);
  });

  it('drops tool results that belong to aborted assistant turns', () => {
    const messages = [
      assistantWithToolCalls([{ id: 'tool1', name: 'read' }], {
        stopReason: 'aborted',
      }),
      toolResult('tool1', 'late result'),
      { role: 'user', content: 'continue', timestamp: 400 },
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toEqual([messages[0], messages[2]]);
    expect(result.stats.droppedToolResults).toBe(1);
    expect(result.stats.syntheticToolResults).toBe(0);
    expect(result.repairedCount).toBe(1);
  });

  it('reorders thinking/text emitted after a tool call back ahead of it, preserving signed reasoning', () => {
    // OpenRouter (reasoning enabled) over Anthropic/Bedrock can emit a signed,
    // redacted reasoning block AFTER the tool call. Anthropic requires thinking
    // to precede tool_use AND the signed block to round-trip verbatim, so we
    // reorder (tool calls last) without dropping anything.
    const signedThinking = {
      type: 'thinking',
      thinking: 'valid signed thinking',
      signature: 'sig',
    };
    const redactedTail = {
      type: 'thinking',
      thinking: '[Reasoning redacted]',
      thinkingSignature: 'openrouter.reasoning:abc',
      redacted: true,
    };
    const tailText = { type: 'text', text: 'tail text' };
    const toolCall = { type: 'toolCall', id: 'tool1', name: 'read', arguments: {} };
    const messages = [
      {
        role: 'assistant',
        content: [signedThinking, toolCall, redactedTail, tailText],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
      toolResult('tool1', 'ok'),
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    // Nothing deleted: every block (incl. the signed/redacted reasoning) is kept,
    // just reordered so the tool call is last.
    expect((result.messages[0] as any).content).toEqual([
      signedThinking,
      redactedTail,
      tailText,
      toolCall,
    ]);
    expect(result.stats.reorderedAssistantBlocks).toBe(2);
    expect(result.repairedCount).toBe(2);
  });

  it('leaves an assistant turn untouched when tool calls are already last', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
          { type: 'text', text: 'let me check' },
          { type: 'toolCall', id: 'tool1', name: 'read', arguments: {} },
          { type: 'toolCall', id: 'tool2', name: 'bash', arguments: {} },
        ],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
      toolResult('tool1', 'ok'),
      toolResult('tool2', 'ok'),
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toBe(messages);
    expect(result.stats.reorderedAssistantBlocks).toBe(0);
    expect(result.repairedCount).toBe(0);
  });

  it('leaves Pi message history unchanged when tool calls and results are balanced', () => {
    const messages = [
      assistantWithToolCalls([{ id: 'tool1', name: 'read' }]),
      toolResult('tool1', 'ok'),
      { role: 'user', content: 'continue', timestamp: 400 },
    ] as AgentMessage[];

    const result = repairPiMessageHistoryForReplay(messages);

    expect(result.messages).toBe(messages);
    expect(result.stats).toEqual({
      droppedToolResults: 0,
      syntheticToolResults: 0,
      reorderedAssistantBlocks: 0,
    });
    expect(result.repairedCount).toBe(0);
  });
});

function assistantWithToolCalls(
  calls: Array<{ id: string; name: string }>,
  options: { stopReason?: string } = {},
): AgentMessage {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: {},
    })),
    responseId: 'resp_tool',
    timestamp: 200,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {},
    stopReason: options.stopReason ?? 'toolUse',
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string, timestamp = 300): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}
