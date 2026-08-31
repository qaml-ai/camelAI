import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { planPiTurnResume } from '../src/pi-turn-journal';

describe('planPiTurnResume', () => {
  it('does not resume a turn that already produced its final assistant message', () => {
    const committed = [
      userMessage('hi'),
      assistantText('all done'),
    ] as AgentMessage[];

    const plan = planPiTurnResume(committed, []);

    expect(plan.owesModelOutput).toBe(false);
    expect(plan.changed).toBe(false);
    expect(plan.interruptedToolResults).toBe(0);
  });

  it('resumes when the model never responded to the last user message', () => {
    const committed = [userMessage('do the thing')] as AgentMessage[];

    const plan = planPiTurnResume(committed, []);

    expect(plan.owesModelOutput).toBe(true);
    expect(plan.changed).toBe(false);
  });

  it('synthesizes an interrupted result for a tool dispatched but not finished, then resumes', () => {
    // Evicted mid-tool: the in-flight assistant message (with the tool call) was
    // journaled at message_end, but tool_execution_end never fired, so no result.
    const committed = [userMessage('run a deploy')] as AgentMessage[];
    const journalTail = [
      assistantWithToolCalls([{ id: 'tool1', name: 'bash' }]),
    ] as AgentMessage[];

    const plan = planPiTurnResume(committed, journalTail);

    expect(plan.interruptedToolResults).toBe(1);
    expect(plan.changed).toBe(true);
    // Reconciled transcript ends in the (interrupted) tool result -> continue() is valid.
    expect((plan.messages[plan.messages.length - 1] as any).role).toBe('toolResult');
    expect((plan.messages[plan.messages.length - 1] as any).isError).toBe(true);
    expect(plan.owesModelOutput).toBe(true);
  });

  it('uses durable completion evidence when reconnecting after a tool result was lost', () => {
    const committed = [userMessage('run a deploy')] as AgentMessage[];
    const journalTail = [
      assistantWithToolCalls([{ id: 'deploy-1', name: 'deploy_project' }]),
    ] as AgentMessage[];

    const plan = planPiTurnResume(committed, journalTail, [{
      id: 'deploy-1',
      toolName: 'deploy_project',
      status: 'succeeded',
      supportedClaims: ['deployed', 'published'],
      target: 'https://demo.camelai.app',
      updatedAt: 300,
    }]);

    expect(plan.interruptedToolResults).toBe(1);
    expect((plan.messages.at(-1) as any)).toMatchObject({
      role: 'toolResult',
      toolName: 'deploy_project',
      isError: false,
    });
    expect((plan.messages.at(-1) as any).content[0].text).toContain('https://demo.camelai.app');
    expect(plan.owesModelOutput).toBe(true);
  });

  it('keeps a completed tool result from the journal and never re-runs it', () => {
    const committed = [userMessage('read a file')] as AgentMessage[];
    const journalTail = [
      assistantWithToolCalls([{ id: 'tool1', name: 'read' }]),
      toolResult('tool1', 'file contents'),
    ] as AgentMessage[];

    const plan = planPiTurnResume(committed, journalTail);

    // No fabrication: the real result is preserved; model owes its reaction.
    expect(plan.interruptedToolResults).toBe(0);
    expect(plan.owesModelOutput).toBe(true);
    expect(plan.messages.filter((m: any) => m.role === 'toolResult')).toHaveLength(1);
    expect((plan.messages.find((m: any) => m.role === 'toolResult') as any).content).toEqual([
      { type: 'text', text: 'file contents' },
    ]);
  });

  it('reorders signed reasoning ahead of the tool call in the journaled assistant turn', () => {
    const committed = [userMessage('analyze')] as AgentMessage[];
    const journalTail = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'sig' },
          { type: 'toolCall', id: 'tool1', name: 'bash', arguments: {} },
          { type: 'thinking', thinking: '[Reasoning redacted]', redacted: true },
        ],
        responseId: 'resp',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
      toolResult('tool1', 'ok'),
    ] as AgentMessage[];

    const plan = planPiTurnResume(committed, journalTail);

    expect(plan.reorderedAssistantBlocks).toBe(1);
    const assistant = plan.messages.find((m: any) => m.role === 'assistant') as any;
    // tool call is last; both reasoning blocks preserved ahead of it.
    expect(assistant.content.map((b: any) => b.type)).toEqual([
      'thinking',
      'thinking',
      'toolCall',
    ]);
    expect(plan.owesModelOutput).toBe(true);
  });
});

function userMessage(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 100 } as unknown as AgentMessage;
}

function assistantText(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    responseId: 'resp',
    timestamp: 200,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {},
    stopReason: 'endTurn',
  } as unknown as AgentMessage;
}

function assistantWithToolCalls(
  calls: Array<{ id: string; name: string }>,
): AgentMessage {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: {},
    })),
    responseId: 'resp',
    timestamp: 200,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {},
    stopReason: 'toolUse',
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 300,
  } as unknown as AgentMessage;
}
