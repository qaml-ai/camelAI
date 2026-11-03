import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { getToolSummary, getToolSummaryParts } from '@/components/tool-call/tool-summary';

const root = process.cwd();

function makeTeamCreateTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_team_create',
    name: 'TeamCreate',
    input,
  };
}

function makeAskUserQuestionTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_ask_user_question',
    name: 'AskUserQuestion',
    input,
  };
}

function makeCustomAskUserQuestionTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_custom_ask_user_question',
    name: 'mcp__camelai_ui__ask_user_question',
    input,
  };
}

function makeReadTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_read',
    name: 'Read',
    input,
  };
}

function makeWriteTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_write',
    name: 'Write',
    input,
  };
}

function makeEditTool(input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: 'tool_edit',
    name: 'Edit',
    input,
  };
}

function makeMcpTool(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return {
    type: 'tool_use',
    id: `tool_${name}`,
    name,
    input,
  };
}

function makeToolResult(content: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: 'tool_result',
    content,
  };
}

function sampleToolInput(name: string): Record<string, unknown> {
  switch (name) {
    case 'bash':
      return { command: 'pwd' };
    case 'read':
    case 'write':
    case 'edit':
      return { path: '/workspace/src/app.tsx' };
    case 'ls':
    case 'find':
    case 'grep':
      return { path: '/workspace/src', pattern: '*.tsx' };
    case 'AskUserQuestion':
    case 'ask_user_question':
      return { questions: [{ question: 'Choose an option', header: 'Choice' }] };
    case 'TodoWrite':
      return { todos: [{ content: 'Test task', status: 'completed' }] };
    case 'set_preview':
      return { path: '/workspace/src/app.tsx' };
    case 'set_app_visibility':
    case 'get_latest_logs':
    case 'set_custom_domain':
    case 'remove_custom_domain':
      return { script_name: 'demo-app', app_name: 'demo-app' };
    case 'create_scheduled_prompt':
    case 'update_scheduled_prompt':
    case 'delete_scheduled_prompt':
    case 'run_scheduled_prompt_now':
      return { prompt_id: 'prompt-1', name: 'Daily check' };
    case 'create_integration':
    case 'prompt_connection_setup':
      return { integration_type: 'github', suggested_name: 'GitHub' };
    case 'WebSearch':
    case 'web_search':
      return { query: 'Cloudflare Workers' };
    case 'WebFetch':
    case 'web_fetch':
      return { url: 'https://example.com' };
    case 'Agent':
    case 'agent':
    case 'Explore':
    case 'explore':
      return { description: 'check the implementation' };
    case 'connections_get':
    case 'connections_tools':
      return { connection: 'github' };
    default:
      return {};
  }
}

describe('getToolSummaryParts TeamCreate', () => {
  it('shows running copy while creating a team', () => {
    const tool = makeTeamCreateTool({ team_name: 'Alpha' });
    const summary = getToolSummaryParts(tool, undefined, true, 'running');
    expect(summary.action).toBe('Creating team Alpha...');
  });

  it('shows error copy when team creation fails', () => {
    const tool = makeTeamCreateTool({ team_name: 'Alpha' });
    const summary = getToolSummaryParts(tool, undefined, false, 'error');
    expect(summary.action).toBe('Failed to create team Alpha');
  });

  it('falls back to generic error copy when name is missing', () => {
    const tool = makeTeamCreateTool();
    const summary = getToolSummaryParts(tool, undefined, false, 'error');
    expect(summary.action).toBe('Failed to create team');
  });

  it('shows success copy only for complete status', () => {
    const tool = makeTeamCreateTool({ team_name: 'Alpha' });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Created team Alpha');
  });
});

describe('getToolSummaryParts AskUserQuestion', () => {
  it('shows waiting copy while running with no result', () => {
    const tool = makeAskUserQuestionTool({
      questions: [{ question: 'Preferred auth method?', header: 'Auth method' }],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');
    expect(summary.action).toBe('Waiting for your input');
  });

  it('uses the question header for single-question prompts', () => {
    const tool = makeAskUserQuestionTool({
      questions: [{ question: 'Preferred auth method?', header: 'Auth method' }],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Auth method');
  });

  it('shows question count when multiple questions are asked', () => {
    const tool = makeAskUserQuestionTool({
      questions: [
        { question: 'Question 1', header: 'One' },
        { question: 'Question 2', header: 'Two' },
      ],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Asked 2 questions');
  });

  it('falls back to generic copy when no usable questions are present', () => {
    const tool = makeAskUserQuestionTool();
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Asked a question');
  });

  it('uses the same summary copy for the custom ask_user_question MCP tool', () => {
    const tool = makeCustomAskUserQuestionTool({
      questions: [{ question: 'Preferred auth method?', header: 'Auth method' }],
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');
    expect(summary.action).toBe('Auth method');
  });
});

describe('getToolSummaryParts tense follows status', () => {
  it('uses present tense while running even when file path is known', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    const summary = getToolSummaryParts(tool, undefined, true, 'running');
    expect(summary.action).toBe('Reading');
    expect(summary.filename).toBe('app.tsx');
  });

  it('uses past tense when complete even if streaming flag remains true', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    const summary = getToolSummaryParts(tool, undefined, true, 'complete');
    expect(summary.action).toBe('Read');
    expect(summary.filename).toBe('app.tsx');
  });

  it('uses present tense while running even when streaming flag is false', () => {
    const tool = makeWriteTool({ file_path: '/workspace/src/new-file.ts' });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');
    expect(summary.action).toBe('Creating');
    expect(summary.filename).toBe('new-file.ts');
  });
});

describe('getToolSummaryParts agent progress', () => {
  const oracle: ToolUseBlock = {
    type: 'tool_use',
    id: 'oracle-1',
    name: 'Oracle',
    input: { question: 'Fix the failing flow' },
  };

  it('shows the latest meaningful activity while the child agent is running', () => {
    const update: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'oracle-1',
      content: 'Reviewing the problem\nInspecting the workspace\n',
      isTaskUpdate: true,
    };
    expect(getToolSummaryParts(oracle, update, true, 'running').action).toBe(
      'Oracle · Inspecting the workspace',
    );
  });

  it('only uses completion wording for the terminal state', () => {
    expect(getToolSummaryParts(oracle, undefined, false, 'complete').action).toBe(
      'Oracle completed',
    );
  });
});

describe('getToolSummaryParts JavaScript', () => {
  it('labels a codemode call as JavaScript', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_codemode',
      name: 'codemode',
      input: { code: 'return 1;' },
    };

    expect(getToolSummaryParts(tool, undefined, false, 'complete').action).toBe('Ran JavaScript');
  });

  it('renders friendly code-mode copy for each status', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_js_exec',
      name: 'JavaScript',
      input: { code: 'return 1;' },
    };

    expect(getToolSummaryParts(tool, undefined, true, 'running').action).toBe(
      'Running JavaScript...'
    );
    expect(getToolSummaryParts(tool, undefined, false, 'complete').action).toBe(
      'Ran JavaScript'
    );
    expect(getToolSummaryParts(tool, undefined, false, 'error').action).toBe(
      'JavaScript failed'
    );
  });

  it('uses the JavaScript tool description when present', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_js_exec',
      name: 'JavaScript',
      input: {
        description: 'checking database connection',
        code: 'return await env.CONNECTIONS.test("postgres");',
      },
    };

    expect(getToolSummaryParts(tool, undefined, true, 'running').action).toBe(
      'Running checking database connection...'
    );
    expect(getToolSummaryParts(tool, undefined, false, 'complete').action).toBe(
      'Ran checking database connection'
    );
    expect(getToolSummaryParts(tool, undefined, false, 'error').action).toBe(
      'checking database connection failed'
    );
  });
});

describe('getToolSummaryParts friendly dynamic tool labels', () => {
  it('renders lowercase file tool names with the normal friendly copy', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_bash',
      name: 'bash',
      input: { command: 'pwd' },
    };

    expect(getToolSummaryParts(tool, undefined, true, 'running').action).toBe(
      'Running pwd...'
    );
    expect(getToolSummaryParts(tool, undefined, false, 'complete').action).toBe(
      'Ran pwd'
    );
  });

  it('uses the question prompt UI copy for raw ask_user_question calls', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_ask_user_question',
      name: 'ask_user_question',
      input: {
        questions: [{ question: 'Pick a color', header: 'Color' }],
      },
    };

    expect(getToolSummaryParts(tool, undefined, false, 'running').action).toBe(
      'Waiting for your input'
    );
    expect(getToolSummaryParts(tool, undefined, false, 'complete').action).toBe('Color');
  });

  it('renders connection and domain tools without raw underscores', () => {
    const listConnections: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_list_integrations',
      name: 'list_integrations',
      input: {},
    };
    const customDomain: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_get_custom_domain',
      name: 'get_custom_domain',
      input: {},
    };

    expect(getToolSummaryParts(listConnections, undefined, false, 'complete').action).toBe(
      'Checked connections'
    );
    expect(getToolSummaryParts(customDomain, undefined, true, 'running').action).toBe(
      'Checking custom domain...'
    );
  });

  it('humanizes unknown tool names instead of showing raw identifiers', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_unknown',
      name: 'some_future_tool',
      input: {},
    };

    expect(getToolSummaryParts(tool, undefined, false, 'complete').action).toBe(
      'Used Some future tool'
    );
  });

  it('has friendly summaries for every registered code-mode tool', () => {
    const source = fs.readFileSync(
      path.join(root, 'workers/main/src/code-mode-tools.ts'),
      'utf8',
    );
    const registryStart = source.indexOf('const CODE_MODE_CONTAINER_TOOL_NAMES');
    const registryEnd = source.indexOf('const CODE_MODE_TOOL_DEFINITIONS', registryStart);
    const registry = source.slice(registryStart, registryEnd);
    const toolNames = Array.from(new Set([
      ...Array.from(
        registry.matchAll(/CODE_MODE_CONTAINER_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/g),
        (match) => Array.from(match[1].matchAll(/"([^"]+)"/g), (nameMatch) => nameMatch[1]),
      ).flat(),
      ...Array.from(
        registry.matchAll(/codeMode(?:Passthrough)?(?:Tool|Alias)\(\s*"([^"]+)"/g),
        (match) => match[1],
      ),
    ]));

    expect(toolNames.length).toBeGreaterThan(20);

    for (const name of toolNames) {
      const tool: ToolUseBlock = {
        type: 'tool_use',
        id: `tool_${name}`,
        name,
        input: sampleToolInput(name),
      };
      const summary = getToolSummaryParts(tool, undefined, false, 'complete').action;

      expect(summary).not.toBe(name);
      expect(summary).not.toContain('_');
    }
  });
});

describe('getToolSummaryParts file preview metadata', () => {
  it('includes workspace file targets for read calls', () => {
    const summary = getToolSummaryParts(
      makeReadTool({ location: 'workspace', path: '/notes.md' }),
      undefined,
      false,
      'complete',
    );

    expect(summary.filePreview).toEqual({
      source: 'workspace',
      path: '/notes.md',
      filename: 'notes.md',
    });
    expect(summary.path).toBe('/notes.md');
  });

  it('includes project file targets with the project for read calls', () => {
    const summary = getToolSummaryParts(
      makeReadTool({ location: 'project', project: 'demo-app', path: '/src/App.tsx' }),
      undefined,
      false,
      'complete',
    );

    expect(summary.filePreview).toEqual({
      source: 'project',
      project: 'demo-app',
      path: '/src/App.tsx',
      filename: 'App.tsx',
    });
  });

  it('maps R2 output paths to output preview targets without the outputs prefix', () => {
    const summary = getToolSummaryParts(
      makeWriteTool({ location: 'r2', path: 'outputs/report.html' }),
      undefined,
      false,
      'complete',
    );

    expect(summary.filePreview).toEqual({
      source: 'output',
      path: 'report.html',
      filename: 'report.html',
    });
    expect(summary.path).toBe('outputs/report.html');
  });

  it('maps R2 upload paths to upload preview targets without the uploads prefix', () => {
    const summary = getToolSummaryParts(
      makeReadTool({ location: 'r2', path: 'uploads/data.csv' }),
      undefined,
      false,
      'complete',
    );

    expect(summary.filePreview).toEqual({
      source: 'upload',
      path: 'data.csv',
      filename: 'data.csv',
    });
    expect(summary.path).toBe('uploads/data.csv');
  });

  it('does not create a misleading preview target for R2 tmp paths', () => {
    const summary = getToolSummaryParts(
      makeReadTool({ location: 'r2', path: 'tmp/private.txt' }),
      undefined,
      false,
      'complete',
    );

    expect(summary.filePreview).toBeUndefined();
    expect(summary.path).toBeUndefined();
    expect(summary.filename).toBe('private.txt');
  });

  it('includes workspace file targets for edit calls', () => {
    const summary = getToolSummaryParts(
      makeEditTool({
        location: 'workspace',
        path: '/notes.md',
        edits: [{ old_string: 'old', new_string: 'new' }],
      }),
      undefined,
      false,
      'complete',
    );

    expect(summary.filePreview).toEqual({
      source: 'workspace',
      path: '/notes.md',
      filename: 'notes.md',
    });
  });
});

describe('getToolSummaryParts set-preview MCP tools', () => {
  it('renders unified set_preview with a file path as a clickable file summary source', () => {
    const tool = makeMcpTool('set_preview', {
      path: '/workspace/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'app.tsx',
      path: '/workspace/src/app.tsx',
      filePreview: {
        source: 'workspace',
        path: '/src/app.tsx',
        filename: 'app.tsx',
      },
    });
  });

  it('renders unified set_preview project file targets', () => {
    const tool = makeMcpTool('set_preview', {
      location: 'project',
      project: 'demo-app',
      path: 'index.html',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'index.html',
      path: 'index.html',
      filePreview: {
        source: 'project',
        project: 'demo-app',
        path: '/index.html',
        filename: 'index.html',
      },
    });
  });

  it('prefers completed set_preview result file targets over input fallback', () => {
    const tool = makeMcpTool('set_preview', {
      location: 'workspace',
      path: '/wrong.md',
    });
    const result = makeToolResult(JSON.stringify({
      success: true,
      target: {
        kind: 'file',
        source: 'output',
        path: 'plot.png',
        filename: 'plot.png',
      },
    }));
    const summary = getToolSummaryParts(tool, result, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'plot.png',
      path: 'outputs/plot.png',
      filePreview: {
        source: 'output',
        path: 'plot.png',
        filename: 'plot.png',
      },
    });
  });

  it('renders unified set_preview with an app preview target when is_public is parseable', () => {
    const tool = makeMcpTool('set_preview', {
      script_name: 'my-todo-app',
    });
    const result = makeToolResult(JSON.stringify({
      success: true,
      target: {
        kind: 'app',
        scriptName: 'my-todo-app',
        isPublic: false,
      },
    }));
    const summary = getToolSummaryParts(tool, result, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app', isPublic: false },
    });
  });

  it('renders unified set_preview app_name aliases as app preview links', () => {
    const tool = makeMcpTool('set_preview', {
      app_name: 'my-todo-app',
      is_public: true,
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app', isPublic: true },
    });
  });

  it('keeps unified set_preview app targets clickable when result metadata is missing', () => {
    const tool = makeMcpTool('set_preview', {
      script_name: 'my-todo-app',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app' },
    });
  });

  it('shows generic opening copy while set_file_preview is running without a path', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview');
    const summary = getToolSummaryParts(tool, undefined, false, 'running');

    expect(summary).toEqual({
      action: 'Opening preview...',
    });
  });

  it('shows the filename while set_file_preview is running with a path', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      path: '/workspace/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');

    expect(summary).toEqual({
      action: 'Opening preview',
      filename: 'app.tsx',
      path: '/workspace/src/app.tsx',
      filePreview: {
        source: 'workspace',
        path: '/src/app.tsx',
        filename: 'app.tsx',
      },
    });
  });

  it('renders set_file_preview as a clickable file summary source', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      path: '/workspace/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'app.tsx',
      path: '/workspace/src/app.tsx',
      filePreview: {
        source: 'workspace',
        path: '/src/app.tsx',
        filename: 'app.tsx',
      },
    });
  });

  it('prefers completed set_file_preview result file targets over input fallback', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      location: 'workspace',
      path: '/wrong.md',
    });
    const result = makeToolResult(JSON.stringify({
      success: true,
      target: {
        kind: 'file',
        source: 'output',
        path: 'plot.png',
      },
    }));
    const summary = getToolSummaryParts(tool, result, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'plot.png',
      path: 'outputs/plot.png',
      filePreview: {
        source: 'output',
        path: 'plot.png',
        filename: 'plot.png',
      },
    });
  });

  it('shows file preview error copy with the filename', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_file_preview', {
      path: '/workspace/src/app.tsx',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'error');

    expect(summary).toEqual({
      action: 'Failed to preview',
      filename: 'app.tsx',
      path: '/workspace/src/app.tsx',
      filePreview: {
        source: 'workspace',
        path: '/src/app.tsx',
        filename: 'app.tsx',
      },
    });
  });

  it('shows the script name while set_app_preview is running', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_app_preview', {
      script_name: 'my-todo-app',
      is_public: true,
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'running');

    expect(summary).toEqual({
      action: 'Opening preview',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app', isPublic: true },
    });
  });

  it('renders set_app_preview with an app preview target when is_public is parseable', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_app_preview', {
      script_name: 'my-todo-app',
    });
    const result = makeToolResult(JSON.stringify({
      success: true,
      app: {
        name: 'my-todo-app',
        url: 'https://my-todo-app-acme85.camelai.app',
        is_public: true,
      },
    }));
    const summary = getToolSummaryParts(tool, result, false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-todo-app',
      appPreview: { scriptName: 'my-todo-app', isPublic: true },
    });
  });

  it('shows app preview error copy with the script name', () => {
    const tool = makeMcpTool('mcp__chiridion-mcp__set_app_preview', {
      script_name: 'my-todo-app',
    });
    const summary = getToolSummaryParts(tool, undefined, false, 'error');

    expect(summary).toEqual({
      action: 'Failed to preview',
      filename: 'my-todo-app',
    });
  });

  it('keeps set_app_preview clickable when is_public cannot be determined', () => {
    const tool = makeMcpTool('set_app_preview', {
      script_name: 'my-private-app',
    });
    const summary = getToolSummaryParts(tool, makeToolResult('not json'), false, 'complete');

    expect(summary).toEqual({
      action: 'Previewed',
      filename: 'my-private-app',
      appPreview: { scriptName: 'my-private-app' },
    });
  });
});

describe('getToolSummary', () => {
  it('uses provided status when building summary text', () => {
    const tool = makeReadTool({ file_path: '/workspace/src/app.tsx' });
    expect(getToolSummary(tool, undefined, 'running', true)).toBe('Reading app.tsx');
    expect(getToolSummary(tool, undefined, 'complete', true)).toBe('Read app.tsx');
  });
});
