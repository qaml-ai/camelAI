import { describe, expect, it, vi } from 'vitest';
import { runPiCapabilityAgentTool, runPiSubagentTool, type PiToolSurfaceDeps } from '../src/chat-thread/pi-tools';

const context = { orgId: 'org', workspaceId: 'workspace', threadId: 'thread', userId: 'user' };

function fixture(fail = false) {
  let onEvent: (event: any) => void = () => {};
  const closeService = vi.fn(async () => {});
  const prompt = vi.fn(async () => {
    if (fail) throw new Error('External process failed');
    onEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'External result' }] } });
  });
  const child = { prompt, closeService, abort: vi.fn(), subscribe: vi.fn((listener: typeof onEvent) => { onEvent = listener; return vi.fn(); }) };
  const model = { id: 'fixture', api: 'anthropic-messages', provider: 'anthropic', input: ['text'], contextWindow: 128000, maxTokens: 4096 };
  const deps = {
    createExternalAgent: vi.fn(async () => child),
    piModelResolver: () => null,
    resolvePiModel: async () => ({ model }),
    resolvePiCapabilityModel: async () => ({ model }),
    consumeCapabilityAllowance: async () => ({ allowed: true, remaining: 1, reset_at_ms: 1 }),
    activeTurnUserId: () => 'user',
    assertUserLlmUsageAccess: vi.fn(async () => {}),
    createPiSubagentSystemPrompt: async () => 'Inspect this workspace.',
    createPiToolDefinitions: () => [],
  } as unknown as PiToolSurfaceDeps;
  return { deps, child, closeService, prompt };
}

describe('external subagent lifecycle', () => {
  for (const kind of ['Agent', 'Research', 'Oracle'] as const) {
    for (const fail of [false, true]) it(`${kind} closes its external connection after ${fail ? 'failure' : 'completion'}`, async () => {
      const f = fixture(fail);
      const run = kind === 'Agent'
        ? runPiSubagentTool(f.deps, context, kind, { prompt: 'Inspect a file' })
        : runPiCapabilityAgentTool(f.deps, context, kind, 'tool-id', { question: 'Inspect a source' });
      if (fail) await expect(run).rejects.toThrow('External process failed');
      else expect((await run).content).toEqual([{ type: 'text', text: 'External result' }]);
      expect(f.deps.createExternalAgent).toHaveBeenCalledWith(expect.objectContaining({ initialState: expect.objectContaining({ messages: [] }) }), context, kind === 'Research');
      expect(f.closeService).toHaveBeenCalledOnce();
      expect(f.deps.assertUserLlmUsageAccess).toHaveBeenCalledOnce();
    });
  }

  for (const kind of ['Agent', 'Research', 'Oracle'] as const) {
    it(`${kind} checks billing access before creating a service agent`, async () => {
      const f = fixture();
      vi.mocked(f.deps.assertUserLlmUsageAccess).mockRejectedValue(new Error('Usage denied'));
      const run = kind === 'Agent'
        ? runPiSubagentTool(f.deps, context, kind, { prompt: 'Inspect' })
        : runPiCapabilityAgentTool(f.deps, context, kind, 'tool-id', { question: 'Inspect' });
      await expect(run).rejects.toThrow('Usage denied');
      expect(f.deps.createExternalAgent).not.toHaveBeenCalled();
    });
  }

  it('does not leak a provisioned child when cancellation arrives during setup', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(runPiSubagentTool(f.deps, context, 'Explore', { prompt: 'Inspect' }, controller.signal)).rejects.toThrow('Explore was aborted');
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.closeService).toHaveBeenCalledOnce();
  });
});
