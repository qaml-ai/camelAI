import { describe, expect, it } from 'vitest';

import {
  buildPiTodos,
  buildToolResultFromPiItem,
  buildToolUseFromPiItem,
  isFailedRuntimeItem,
  type PiThreadItem,
} from '@/lib/pi-tool-builders';

// The tool builders are the shared source of tool_use name/input and
// tool_result error status for both the live chunk encoder
// (pi-chunk-encoder.ts) and durable backfill. These cases were previously
// exercised indirectly through the now-deleted runtime reducer; they test the
// builders directly.

describe('buildToolResultFromPiItem error status', () => {
  it('surfaces nested structured edit details', () => {
    const result = buildToolResultFromPiItem({
      id: 'tool-edit',
      type: 'dynamicToolCall',
      tool: 'edit',
      status: 'completed',
      contentItems: [{ type: 'inputText', text: 'edited' }],
      result: {
        details: {
          text: 'edited',
          details: { diff: '-1 old\n+1 new', patch: '@@ patch', replacementCount: 1 },
        },
      },
    });
    expect(result?.details).toEqual({
      diff: '-1 old\n+1 new',
      patch: '@@ patch',
      replacementCount: 1,
    });
  });

  it('preserves agent activity metadata for the completed task card', () => {
    const result = buildToolResultFromPiItem({
      id: 'tool-oracle',
      type: 'dynamicToolCall',
      tool: 'Oracle',
      status: 'completed',
      contentItems: [{ type: 'inputText', text: 'fixed' }],
      result: {
        details: {
          status: 'completed',
          activities: ['read · public/main.js', 'edit · public/main.js'],
          toolActivities: [
            { toolCallId: 'child-read', toolName: 'read', label: 'read · public/main.js', status: 'complete' },
            { toolCallId: 'child-edit', toolName: 'edit', label: 'edit · public/main.js', status: 'complete' },
          ],
          durationMs: 12_000,
          toolUseCount: 2,
        },
      },
    });
    expect(result?.details).toMatchObject({
      activities: ['read · public/main.js', 'edit · public/main.js'],
      toolActivities: [
        { toolCallId: 'child-read', toolName: 'read', label: 'read · public/main.js', status: 'complete' },
        { toolCallId: 'child-edit', toolName: 'edit', label: 'edit · public/main.js', status: 'complete' },
      ],
      durationMs: 12_000,
      toolUseCount: 2,
    });
  });

  it('renders structured Oracle text as plain response content without redundant status', () => {
    const result = buildToolResultFromPiItem({
      id: 'tool-oracle-text',
      type: 'dynamicToolCall',
      tool: 'Oracle',
      status: 'completed',
      success: true,
      contentItems: [{ type: 'text', text: '### Defects fixed\n\n- Pawn attacks' }],
    });

    expect(result?.content).toBe('### Defects fixed\n\n- Pawn attacks');
  });

  it('marks a failed commandExecution as an error result', () => {
    const item: PiThreadItem = {
      id: 'tool-bash',
      type: 'commandExecution',
      command: 'bun run validate',
      status: 'failed',
      aggregatedOutput: 'Error: unsupported extra arguments\n',
    };
    expect(isFailedRuntimeItem(item)).toBe(true);
    expect(buildToolResultFromPiItem(item)).toMatchObject({ isError: true });
  });

  it('marks a failed dynamicToolCall (success:false) as an error result', () => {
    const item: PiThreadItem = {
      id: 'tool-dynamic',
      type: 'dynamicToolCall',
      tool: 'validate_workflow',
      arguments: { name: 'daily-sync' },
      success: false,
      contentItems: [{ type: 'inputText', text: 'Validation failed' }],
    };
    expect(buildToolResultFromPiItem(item)).toMatchObject({ isError: true });
  });

  it('marks completed items with failed nested result details as errors', () => {
    const nestedSuccessFalse: PiThreadItem = {
      id: 'tool-nested-success',
      type: 'dynamicToolCall',
      tool: 'validate_workflow',
      arguments: { name: 'daily-sync' },
      status: 'completed',
      contentItems: [{ type: 'inputText', text: 'Validation failed' }],
      result: { details: { success: false } },
    };
    const nestedExitCode: PiThreadItem = {
      id: 'tool-nested-exit-code',
      type: 'commandExecution',
      command: 'bun run validate',
      status: 'completed',
      aggregatedOutput: 'Validation failed\n',
      result: { details: { exitCode: 1 } },
    };
    expect(buildToolResultFromPiItem(nestedSuccessFalse)).toMatchObject({ isError: true });
    expect(buildToolResultFromPiItem(nestedExitCode)).toMatchObject({ isError: true });
  });

  it('marks an mcpToolCall with an error payload as an error result', () => {
    const item: PiThreadItem = {
      id: 'tool-mcp',
      type: 'mcpToolCall',
      tool: 'list_resources',
      status: 'completed',
      error: { message: 'MCP server unavailable' },
    };
    expect(buildToolResultFromPiItem(item)).toMatchObject({ isError: true });
  });

  it('leaves a successful command result unmarked', () => {
    const item: PiThreadItem = {
      id: 'tool-ok',
      type: 'commandExecution',
      command: 'ls',
      status: 'completed',
      aggregatedOutput: 'file1\n',
    };
    expect(buildToolResultFromPiItem(item)).toMatchObject({ isError: false });
  });
});

describe('buildToolUseFromPiItem name canonicalization + input', () => {
  function dynamicTool(tool: string, args: Record<string, unknown>): PiThreadItem {
    return { id: `tool-${tool}`, type: 'dynamicToolCall', tool, arguments: args, status: 'running' };
  }

  it('canonicalizes dynamic tool aliases and preserves rawToolName', () => {
    expect(buildToolUseFromPiItem(dynamicTool('web_search', { query: 'Pi coding agent docs' }))).toMatchObject({
      name: 'WebSearch',
      input: { query: 'Pi coding agent docs', rawToolName: 'web_search' },
    });
    expect(buildToolUseFromPiItem(dynamicTool('list_integrations', {}))).toMatchObject({
      name: 'ListConnections',
      input: { rawToolName: 'list_integrations' },
    });
    expect(
      buildToolUseFromPiItem(dynamicTool('js_exec', { description: 'evaluate a quick expression', code: 'return 1;' })),
    ).toMatchObject({
      name: 'JavaScript',
      input: { description: 'evaluate a quick expression', code: 'return 1;', rawToolName: 'js_exec' },
    });
    expect(buildToolUseFromPiItem(dynamicTool('ls', { path: '/workspace/src' }))).toMatchObject({
      name: 'LS',
      input: { path: '/workspace/src' },
    });
    expect(buildToolUseFromPiItem(dynamicTool('find', { pattern: '*.tsx', path: '/workspace/src' }))).toMatchObject({
      name: 'Find',
      input: { pattern: '*.tsx' },
    });
    expect(buildToolUseFromPiItem(dynamicTool('explore', { prompt: 'Map the project' }))).toMatchObject({
      name: 'Explore',
      input: { prompt: 'Map the project' },
    });
  });

  it('normalizes stringified and legacy edit arguments for rendering', () => {
    expect(buildToolUseFromPiItem(dynamicTool('edit', {
      edits: JSON.stringify([{ oldText: 'one', newText: 'two' }]),
      oldText: 'three',
      newText: 'four',
    }))).toMatchObject({
      name: 'Edit',
      input: {
        edits: [
          { oldText: 'one', newText: 'two', old_string: 'one', new_string: 'two' },
          { old_string: 'three', new_string: 'four' },
        ],
      },
    });
  });

  it('canonicalizes a todo_write dynamic tool to TodoWrite with its todos', () => {
    const item = dynamicTool('todo_write', {
      todos: [{ content: 'Check aliases', status: 'completed', activeForm: 'Checking aliases' }],
    });
    expect(buildToolUseFromPiItem(item)).toMatchObject({
      name: 'TodoWrite',
      input: {
        todos: [{ content: 'Check aliases', status: 'completed', activeForm: 'Checking aliases' }],
        rawToolName: 'todo_write',
      },
    });
  });

  it('builds a Bash tool with command/description/status from a commandExecution', () => {
    const item: PiThreadItem = {
      id: 'tool-bash',
      type: 'commandExecution',
      command: 'pwd',
      project: 'menu-app',
      description: 'Check workspace directory',
      status: 'running',
    };
    expect(buildToolUseFromPiItem(item)).toMatchObject({
      name: 'Bash',
      input: {
        command: 'pwd',
        project: 'menu-app',
        description: 'Check workspace directory',
        status: 'running',
      },
    });
  });
});

describe('buildPiTodos status normalization', () => {
  it('normalizes plan step statuses to the todo enum', () => {
    const todos = buildPiTodos([
      { step: 'Inspect logs', status: 'completed' },
      { step: 'Patch proxy env', status: 'inProgress' },
      { step: 'Retry deploy', status: 'pending' },
    ]);
    expect(todos).toEqual([
      { content: 'Inspect logs', status: 'completed', activeForm: 'Inspect logs' },
      { content: 'Patch proxy env', status: 'in_progress', activeForm: 'Patch proxy env' },
      { content: 'Retry deploy', status: 'pending', activeForm: 'Retry deploy' },
    ]);
  });
});
