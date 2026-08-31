import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  PI_TOOL_DETAILS_MAX_BYTES,
  preparePiMessageForSqlStorage,
  projectPiToolResultDetails,
} from '../src/pi-message-storage';

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe('Pi tool detail projection', () => {
  it('counts hostile object-key UTF-8 bytes and stays within the serialized budget', () => {
    const hostileKey = '🔐'.repeat(20_000);
    const projected = projectPiToolResultDetails({
      [hostileKey]: 'small',
      status: 'completed',
      text: 'x'.repeat(2_000_000),
    }) as Record<string, unknown>;

    expect(utf8Bytes(projected)).toBeLessThanOrEqual(PI_TOOL_DETAILS_MAX_BYTES);
    expect(projected.status).toBe('completed');
    expect(projected).not.toHaveProperty(hostileKey);
    expect(projected.text).toBe('[model-visible tool output omitted from details]');
  });

  it('preserves edit and task UI fields while bounding their large strings', () => {
    const projected = projectPiToolResultDetails({
      status: 'completed',
      replacementCount: 2,
      diff: 'd'.repeat(100_000),
      activities: [{ type: 'tool', body: { label: 'kept nested body' } }],
      toolActivities: [{ data: { toolName: 'read', status: 'completed' } }],
      childToolsUsed: ['read', 'edit'],
      durationMs: 123,
      toolUseCount: 2,
    }) as Record<string, unknown>;

    expect(utf8Bytes(projected)).toBeLessThanOrEqual(PI_TOOL_DETAILS_MAX_BYTES);
    expect(projected.status).toBe('completed');
    expect(projected.replacementCount).toBe(2);
    expect(typeof projected.diff).toBe('string');
    expect((projected.activities as any[])[0].body.label).toBe('kept nested body');
    expect((projected.toolActivities as any[])[0].data.toolName).toBe('read');
    expect(projected.childToolsUsed).toEqual(['read', 'edit']);
    expect(projected.durationMs).toBe(123);
    expect(projected.toolUseCount).toBe(2);
  });

  it('preserves deploy, artifact, status, and UI metadata including nested data/body', () => {
    const projected = projectPiToolResultDetails({
      text: 'the model already receives this',
      body: 'duplicate root response body',
      data: 'duplicate root response data',
      status: 'success',
      artifact: {
        id: 'artifact-1',
        status: 'sent',
        summary: { body: 'message summary', data: { destination: 'team@example.com' } },
      },
      artifacts: [{ id: 'artifact-2', kind: 'file', status: 'created' }],
      uiMetadata: {
        renderMessageId: 'render-1',
        codeModeArtifacts: [{ id: 'runtime-1', status: 'sent', summary: { data: 'kept' } }],
      },
      preview: { kind: 'app', scriptName: 'demo-app' },
      deployment: { id: 'deploy-1', status: 'ready' },
    }) as Record<string, any>;

    expect(projected.status).toBe('success');
    expect(projected.artifact.summary.body).toBe('message summary');
    expect(projected.artifact.summary.data.destination).toBe('team@example.com');
    expect(projected.artifacts[0].id).toBe('artifact-2');
    expect(projected.uiMetadata.renderMessageId).toBe('render-1');
    expect(projected.uiMetadata.codeModeArtifacts[0].summary.data).toBe('kept');
    expect(projected.preview).toEqual({ kind: 'app', scriptName: 'demo-app' });
    expect(projected.deployment).toEqual({ id: 'deploy-1', status: 'ready' });
    expect(projected.text).toBe('[model-visible tool output omitted from details]');
    expect(projected.body).toBe('[model-visible tool output omitted from details]');
    expect(projected.data).toBe('[model-visible tool output omitted from details]');
  });

  it('removes duplicate full payloads before a tool result reaches persistence', () => {
    const duplicate = 'diagnostic'.repeat(100_000);
    const prepared = preparePiMessageForSqlStorage({
      role: 'toolResult',
      toolCallId: 'mcp-call-1',
      toolName: 'remote_mcp',
      content: [{ type: 'text', text: 'bounded model output' }],
      details: {
        text: duplicate,
        content: duplicate,
        status: 'completed',
        artifacts: [{ id: 'artifact-1', kind: 'file' }],
      },
      isError: false,
      timestamp: 1,
    } as AgentMessage) as unknown as Record<string, any>;

    expect(JSON.stringify(prepared)).not.toContain(duplicate.slice(0, 1_000));
    expect(prepared.details.status).toBe('completed');
    expect(prepared.details.artifacts).toEqual([{ id: 'artifact-1', kind: 'file' }]);
  });
});
