import type { ToolResultBlock, ToolUseBlock } from '@/types';
import {
  isAskUserQuestionToolName,
  isMcpTool,
  isSetAppPreviewToolName,
  isSetFilePreviewToolName,
  isSetPreviewToolName,
  parseMcpToolName,
} from './tool-activity-mcp-utils';
import { getResultText } from './tool-activity-tool-utils';
import {
  buildFilePreviewLinkTarget,
  parseFilePreviewTargetFromToolResultText,
  type FilePreviewLinkTarget,
} from './file-preview-target';

function getFilename(path: string): string {
  const trimmed = path.trim();
  return trimmed.split('/').pop() || trimmed;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function humanizeToolName(name: string): string {
  const spaced = name
    .replace(/^mcp__/, '')
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!spaced) return 'tool';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function parseCountFromResult(result?: ToolResultBlock): number | null {
  if (!result) return null;
  const content = getResultText(result);
  const match = content.match(/Found\s+(\d+)\s+(files|matches)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function latestAgentProgress(result?: ToolResultBlock): string {
  if (!result?.isTaskUpdate) return '';
  const lines = getResultText(result)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1]?.replace(/[.]+$/, '') ?? '';
}

function canonicalizeToolSummaryName(name: string): string {
  switch (name) {
    case 'bash':
      return 'Bash';
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'ls':
      return 'LS';
    case 'find':
      return 'Find';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'js_exec':
    case 'codemode':
      return 'JavaScript';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    case 'todo_write':
    case 'update_todo':
      return 'TodoWrite';
    case 'list_apps':
      return 'ListApps';
    case 'set_app_visibility':
      return 'SetAppVisibility';
    case 'get_latest_logs':
      return 'GetLatestLogs';
    case 'list_scheduled_prompts':
      return 'ListScheduledPrompts';
    case 'create_scheduled_prompt':
      return 'CreateScheduledPrompt';
    case 'update_scheduled_prompt':
      return 'UpdateScheduledPrompt';
    case 'delete_scheduled_prompt':
      return 'DeleteScheduledPrompt';
    case 'run_scheduled_prompt_now':
      return 'RunScheduledPrompt';
    case 'list_workflows':
      return 'ListWorkflows';
    case 'validate_workflow':
      return 'ValidateWorkflow';
    case 'create_workflow':
      return 'CreateWorkflow';
    case 'update_workflow':
      return 'UpdateWorkflow';
    case 'delete_workflow':
      return 'DeleteWorkflow';
    case 'run_workflow_now':
      return 'RunWorkflow';
    case 'list_integrations':
    case 'connections_list':
      return 'ListConnections';
    case 'list_integration_types':
      return 'ListConnectionTypes';
    case 'create_integration':
      return 'CreateConnection';
    case 'prompt_connection_setup':
      return 'PromptConnectionSetup';
    case 'get_custom_domain':
      return 'GetCustomDomain';
    case 'set_custom_domain':
      return 'SetCustomDomain';
    case 'remove_custom_domain':
      return 'RemoveCustomDomain';
    case 'retry_custom_domain_hostnames':
      return 'RetryCustomDomains';
    case 'connections_get':
      return 'GetConnection';
    case 'connections_tools':
      return 'ListConnectionTools';
    case 'connections_methods':
      return 'ListConnectionMethods';
    case 'list_projects':
      return 'ListProjects';
    case 'create_project':
      return 'CreateProject';
    default:
      return name;
  }
}

function parseAppPreviewIsPublic(
  result?: ToolResultBlock,
  fallbackIsPublic?: boolean | null,
): boolean | null {
  if (!result) return fallbackIsPublic ?? null;
  const text = getResultText(result);
  if (!text) return fallbackIsPublic ?? null;
  try {
    const parsed = JSON.parse(text) as {
      app?: { is_public?: unknown };
      target?: { isPublic?: unknown; is_public?: unknown };
    };
    if (parsed?.app && typeof parsed.app.is_public === 'boolean') {
      return parsed.app.is_public;
    }
    if (parsed?.target && typeof parsed.target.isPublic === 'boolean') {
      return parsed.target.isPublic;
    }
    if (parsed?.target && typeof parsed.target.is_public === 'boolean') {
      return parsed.target.is_public;
    }
  } catch {
    // Result was not JSON.
  }
  return fallbackIsPublic ?? null;
}

export interface ToolSummaryParts {
  action: string;
  filename?: string;
  path?: string;
  appPreview?: { scriptName: string; isPublic?: boolean };
  filePreview?: FilePreviewLinkTarget;
}

function getInputPath(inputRecord: Record<string, unknown>): string {
  if (typeof inputRecord.file_path === 'string') return inputRecord.file_path;
  if (typeof inputRecord.path === 'string') return inputRecord.path;
  return '';
}

function buildFilePreviewFromInput(inputRecord: Record<string, unknown>): FilePreviewLinkTarget | null {
  return buildFilePreviewLinkTarget({
    path: getInputPath(inputRecord),
    location: inputRecord.location,
    project: inputRecord.project,
    contentType: inputRecord.contentType,
    content_type: inputRecord.content_type,
  });
}

function getDisplayPathForTarget(target: FilePreviewLinkTarget): string {
  if (target.source === 'upload') return `uploads/${target.path}`;
  if (target.source === 'output') return `outputs/${target.path}`;
  return target.path;
}

function getFilePreviewSummary(
  filePreview: FilePreviewLinkTarget | null,
  displayPath: string,
  isRunning: boolean,
  isError: boolean,
): ToolSummaryParts {
  const path = displayPath || (filePreview ? getDisplayPathForTarget(filePreview) : '');
  const filename = filePreview?.filename ?? (path ? getFilename(path) : undefined);
  const fileParts = filePreview
    ? { path, filename: filePreview.filename, filePreview }
    : filename
      ? { filename }
      : {};

  if (isRunning) {
    if (!path && !filename) return { action: 'Opening preview...' };
    return { action: 'Opening preview', ...fileParts };
  }
  if (isError) {
    return {
      action: 'Failed to preview',
      ...fileParts,
    };
  }
  return {
    action: 'Previewed',
    ...fileParts,
  };
}

function getFileToolSummary(
  inputRecord: Record<string, unknown>,
  labels: { running: string; runningGeneric: string; error: string; complete: string },
  isRunning: boolean,
  isError: boolean,
): ToolSummaryParts {
  const path = getInputPath(inputRecord);
  const filePreview = buildFilePreviewFromInput(inputRecord);
  const filename = filePreview?.filename ?? (path ? getFilename(path) : undefined);
  const fileParts = filePreview
    ? { filename: filePreview.filename, path, filePreview }
    : filename
      ? { filename }
      : {};

  if (isRunning) {
    if (!path && !filename) return { action: labels.runningGeneric };
    return {
      action: labels.running,
      ...fileParts,
    };
  }
  if (isError) {
    return {
      action: labels.error,
      ...fileParts,
    };
  }
  return {
    action: labels.complete,
    ...fileParts,
  };
}

function getResultFilePreview(result?: ToolResultBlock): FilePreviewLinkTarget | null {
  return parseFilePreviewTargetFromToolResultText(getResultText(result));
}

function getAppPreviewSummary(
  scriptName: string,
  result: ToolResultBlock | undefined,
  isRunning: boolean,
  isError: boolean,
  fallbackIsPublic?: boolean | null,
): ToolSummaryParts {
  const isPublic = parseAppPreviewIsPublic(result, fallbackIsPublic);
  const appPreview = scriptName
    ? {
        scriptName,
        ...(isPublic !== null ? { isPublic } : {}),
      }
    : undefined;
  if (isRunning) {
    if (!scriptName) return { action: 'Opening preview...' };
    return {
      action: 'Opening preview',
      filename: scriptName,
      ...(appPreview ? { appPreview } : {}),
    };
  }
  if (isError) {
    return {
      action: 'Failed to preview',
      filename: scriptName || undefined,
    };
  }
  if (scriptName) {
    return {
      action: 'Previewed',
      filename: scriptName,
      appPreview,
    };
  }
  return { action: 'Previewed' };
}

function getPreviewScriptName(inputRecord: Record<string, unknown>): string {
  if (typeof inputRecord.script_name === 'string' && inputRecord.script_name.trim()) {
    return inputRecord.script_name.trim();
  }
  if (typeof inputRecord.app_name === 'string' && inputRecord.app_name.trim()) {
    return inputRecord.app_name.trim();
  }
  return '';
}

export function getToolSummaryParts(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  isStreaming?: boolean,
  status?: 'running' | 'complete' | 'error'
): ToolSummaryParts {
  if (!tool) return { action: result ? 'Result' : 'Tool call' };

  const { name, input } = tool;
  const summaryName = canonicalizeToolSummaryName(name);
  const inputRecord = input || {};
  const isRunning = status === 'running' || (status == null && !!isStreaming && !result);
  const isError = status === 'error';

  if (isAskUserQuestionToolName(name)) {
    const questions = Array.isArray(inputRecord.questions) ? inputRecord.questions : [];

    if (isRunning && !result) {
      return { action: 'Waiting for your input' };
    }

    if (questions.length === 1) {
      const first = questions[0];
      if (first && typeof first === 'object') {
        const header = (first as { header?: unknown }).header;
        if (typeof header === 'string' && header.trim()) {
          return { action: header.trim() };
        }
      }
    }

    if (questions.length > 1) {
      return { action: `Asked ${questions.length} questions` };
    }

    return { action: 'Asked a question' };
  }

  if (isSetPreviewToolName(name)) {
    const kind = inputRecord.kind === 'app' || inputRecord.kind === 'file' ? inputRecord.kind : undefined;
    const path = getInputPath(inputRecord);
    const scriptName = getPreviewScriptName(inputRecord);
    const fallbackIsPublic = typeof inputRecord.is_public === 'boolean' ? inputRecord.is_public : null;
    const resultFilePreview = getResultFilePreview(result);

    if (kind === 'app' || (!kind && scriptName)) {
      return getAppPreviewSummary(scriptName, result, isRunning, isError, fallbackIsPublic);
    }

    if (resultFilePreview || kind === 'file' || (!kind && path)) {
      return getFilePreviewSummary(
        resultFilePreview ?? buildFilePreviewFromInput(inputRecord),
        resultFilePreview ? getDisplayPathForTarget(resultFilePreview) : path,
        isRunning,
        isError,
      );
    }

    if (isRunning) return { action: 'Opening preview...' };
    if (isError) return { action: 'Failed to preview' };
    return { action: 'Previewed' };
  }

  if (isSetFilePreviewToolName(name)) {
    const resultFilePreview = getResultFilePreview(result);
    return getFilePreviewSummary(
      resultFilePreview ?? buildFilePreviewFromInput(inputRecord),
      resultFilePreview ? getDisplayPathForTarget(resultFilePreview) : getInputPath(inputRecord),
      isRunning,
      isError,
    );
  }

  if (isSetAppPreviewToolName(name)) {
    const scriptName = getPreviewScriptName(inputRecord);
    const fallbackIsPublic = typeof inputRecord.is_public === 'boolean' ? inputRecord.is_public : null;
    return getAppPreviewSummary(scriptName, result, isRunning, isError, fallbackIsPublic);
  }

  if (isMcpTool(name)) {
    const mcpParts = parseMcpToolName(name);
    if (mcpParts) {
      if (isRunning) {
        return { action: `Calling ${mcpParts.displayTool} on ${mcpParts.displayServer}...` };
      }
      if (isError) {
        return { action: `Failed to call ${mcpParts.displayTool} on ${mcpParts.displayServer}` };
      }
      return { action: `Called ${mcpParts.displayTool} on ${mcpParts.displayServer}` };
    }
  }

  switch (summaryName) {
    case 'Read': {
      return getFileToolSummary(
        inputRecord,
        {
          running: 'Reading',
          runningGeneric: 'Reading file...',
          error: 'Failed to read',
          complete: 'Read',
        },
        isRunning,
        isError,
      );
    }
    case 'Write': {
      return getFileToolSummary(
        inputRecord,
        {
          running: 'Creating',
          runningGeneric: 'Creating file...',
          error: 'Failed to create',
          complete: 'Created',
        },
        isRunning,
        isError,
      );
    }
    case 'Edit': {
      return getFileToolSummary(
        inputRecord,
        {
          running: 'Editing',
          runningGeneric: 'Editing file...',
          error: 'Failed to edit',
          complete: 'Edited',
        },
        isRunning,
        isError,
      );
    }
    case 'Bash': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      const command = typeof inputRecord.command === 'string' ? inputRecord.command : '';
      const label = description || truncate(command || 'command', 30);
      if (isRunning) {
        if (!description && !command) return { action: 'Running command...' };
        return { action: `Running ${label}...` };
      }
      if (isError) {
        return { action: `Failed to run ${label}` };
      }
      return { action: `Ran ${label}` };
    }
    case 'Glob': {
      const globPattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isRunning) {
        if (!globPattern) return { action: 'Searching for files...' };
        return { action: `Searching for "${truncate(globPattern, 20)}"...` };
      }
      if (isError) {
        return { action: 'Failed to search files' };
      }
      const count = parseCountFromResult(result);
      if (count !== null) return { action: `Found ${count} files` };
      if (result) {
        const text = getResultText(result).trim();
        if (!text || text === 'No files found' || text === 'No files found.') {
          return { action: 'No files found' };
        }
        return { action: 'Searched files' };
      }
      return { action: 'Searched files' };
    }
    case 'Grep': {
      const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isRunning) {
        if (!pattern) return { action: 'Searching...' };
        return { action: `Searching for "${truncate(pattern, 20)}"...` };
      }
      if (isError) {
        return { action: 'Failed to search codebase' };
      }
      const count = parseCountFromResult(result);
      if (count !== null) return { action: `Found ${count} matches` };
      if (result) {
        const text = getResultText(result).trim();
        if (!text || text === 'No matches found' || text === 'No matches found.') {
          return { action: 'No matches found' };
        }
        return { action: 'Searched codebase' };
      }
      return { action: 'Searched codebase' };
    }
    case 'LS': {
      const path = typeof inputRecord.path === 'string' ? inputRecord.path : '';
      if (isRunning) {
        if (!path) return { action: 'Listing files...' };
        return { action: 'Listing', filename: getFilename(path), path };
      }
      if (isError) {
        return path
          ? { action: 'Failed to list', filename: getFilename(path), path }
          : { action: 'Failed to list files' };
      }
      return path
        ? { action: 'Listed', filename: getFilename(path), path }
        : { action: 'Listed files' };
    }
    case 'Find': {
      const path = typeof inputRecord.path === 'string' ? inputRecord.path : '';
      const pattern = typeof inputRecord.pattern === 'string' ? inputRecord.pattern : '';
      if (isRunning) {
        if (pattern) return { action: `Finding "${truncate(pattern, 20)}"...` };
        return path
          ? { action: 'Finding files in', filename: getFilename(path), path }
          : { action: 'Finding files...' };
      }
      if (isError) {
        return { action: 'Failed to find files' };
      }
      return { action: 'Found files' };
    }
    case 'Task':
    case 'Agent':
    case 'agent':
    case 'Explore':
    case 'explore': {
      const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
      if (isRunning) {
        const progress = latestAgentProgress(result);
        if (progress) return { action: `${name} · ${progress}` };
        const summary = description || 'subtask...';
        return { action: `Working on ${summary}` };
      }
      if (isError) {
        const summary = description || 'subtask';
        return { action: `Could not finish ${summary}` };
      }
      return { action: `Finished ${description || 'subtask'}` };
    }
    case 'Research':
    case 'Oracle': {
      const question = typeof inputRecord.question === 'string' ? inputRecord.question : '';
      const noun = name === 'Research' ? 'research' : 'Oracle';
      if (isRunning) {
        const progress = latestAgentProgress(result);
        if (progress) return { action: `${name} · ${progress}` };
        return { action: `Running ${noun}${question ? `: ${truncate(question, 48)}` : '...'}` };
      }
      if (isError) return { action: `${name} could not finish` };
      return { action: `${name} completed` };
    }
    case 'TeamCreate': {
      const teamName = typeof inputRecord.team_name === 'string' ? inputRecord.team_name : '';
      if (isRunning) {
        if (!teamName) return { action: 'Creating team...' };
        return { action: `Creating team ${teamName}...` };
      }
      if (isError) {
        if (!teamName) return { action: 'Failed to create team' };
        return { action: `Failed to create team ${teamName}` };
      }
      return { action: `Created team ${teamName || 'team'}` };
    }
    case 'Skill': {
      const skill = typeof inputRecord.skill === 'string' ? inputRecord.skill : '';
      if (isRunning) {
        if (!skill) return { action: 'Reading instructions...' };
        return { action: `Reading instructions for ${skill}...` };
      }
      if (isError) {
        if (!skill) return { action: 'Could not read instructions' };
        return { action: `Could not read instructions for ${skill}` };
      }
      const path = skill ? `/workspace/.agents/skills/${skill}/SKILL.md` : '';
      return {
        action: 'Read instructions for',
        filename: skill || 'task',
        path: path || undefined,
      };
    }
    case 'WebFetch': {
      const url = typeof inputRecord.url === 'string' ? inputRecord.url : '';
      if (isRunning) {
        if (!url) return { action: 'Fetching page...' };
        return { action: `Fetching ${getHostname(url)}...` };
      }
      if (isError) {
        return { action: `Failed to fetch ${url ? getHostname(url) : 'web page'}` };
      }
      return { action: `Fetched ${url ? getHostname(url) : 'web page'}` };
    }
    case 'WebSearch':
      if (isRunning) return { action: 'Searching web...' };
      if (isError) return { action: 'Failed to search web' };
      return { action: 'Searched web' };
    case 'JavaScript':
      {
        const description = typeof inputRecord.description === 'string' ? inputRecord.description : '';
        const label = description || 'JavaScript';
        if (isRunning) return { action: `Running ${label}...` };
        if (isError) return { action: `${label} failed` };
        return { action: `Ran ${label}` };
      }
    case 'ListApps':
      if (isRunning) return { action: 'Checking apps...' };
      if (isError) return { action: 'Could not check apps' };
      return { action: 'Checked apps' };
    case 'SetAppVisibility':
      if (isRunning) return { action: 'Updating app visibility...' };
      if (isError) return { action: 'Could not update app visibility' };
      return { action: 'Updated app visibility' };
    case 'GetLatestLogs':
      if (isRunning) return { action: 'Reading app logs...' };
      if (isError) return { action: 'Could not read app logs' };
      return { action: 'Read app logs' };
    case 'ListScheduledPrompts':
      if (isRunning) return { action: 'Checking scheduled prompts...' };
      if (isError) return { action: 'Could not check scheduled prompts' };
      return { action: 'Checked scheduled prompts' };
    case 'CreateScheduledPrompt':
      if (isRunning) return { action: 'Creating scheduled prompt...' };
      if (isError) return { action: 'Could not create scheduled prompt' };
      return { action: 'Created scheduled prompt' };
    case 'UpdateScheduledPrompt':
      if (isRunning) return { action: 'Updating scheduled prompt...' };
      if (isError) return { action: 'Could not update scheduled prompt' };
      return { action: 'Updated scheduled prompt' };
    case 'DeleteScheduledPrompt':
      if (isRunning) return { action: 'Deleting scheduled prompt...' };
      if (isError) return { action: 'Could not delete scheduled prompt' };
      return { action: 'Deleted scheduled prompt' };
    case 'RunScheduledPrompt':
      if (isRunning) return { action: 'Running scheduled prompt...' };
      if (isError) return { action: 'Could not run scheduled prompt' };
      return { action: 'Ran scheduled prompt' };
    case 'ListWorkflows':
    case 'ListDeterministicAutomations':
      if (isRunning) return { action: 'Checking workflows...' };
      if (isError) return { action: 'Could not check workflows' };
      return { action: 'Checked workflows' };
    case 'ValidateWorkflow':
    case 'ValidateDeterministicAutomation':
      if (isRunning) return { action: 'Validating workflow...' };
      if (isError) return { action: 'Could not validate workflow' };
      return { action: 'Validated workflow' };
    case 'CreateWorkflow':
    case 'CreateDeterministicAutomation':
      if (isRunning) return { action: 'Creating workflow...' };
      if (isError) return { action: 'Could not create workflow' };
      return { action: 'Created workflow' };
    case 'UpdateWorkflow':
    case 'UpdateDeterministicAutomation':
      if (isRunning) return { action: 'Updating workflow...' };
      if (isError) return { action: 'Could not update workflow' };
      return { action: 'Updated workflow' };
    case 'DeleteWorkflow':
    case 'DeleteDeterministicAutomation':
      if (isRunning) return { action: 'Deleting workflow...' };
      if (isError) return { action: 'Could not delete workflow' };
      return { action: 'Deleted workflow' };
    case 'RunWorkflow':
    case 'RunDeterministicAutomation':
      if (isRunning) return { action: 'Starting workflow...' };
      if (isError) return { action: 'Could not start workflow' };
      return { action: 'Started workflow' };
    case 'ListConnections':
      if (isRunning) return { action: 'Checking connections...' };
      if (isError) return { action: 'Could not check connections' };
      return { action: 'Checked connections' };
    case 'ListConnectionTypes':
      if (isRunning) return { action: 'Checking available connection types...' };
      if (isError) return { action: 'Could not check connection types' };
      return { action: 'Checked available connection types' };
    case 'GetConnection':
      if (isRunning) return { action: 'Checking connection...' };
      if (isError) return { action: 'Could not check connection' };
      return { action: 'Checked connection' };
    case 'ListConnectionTools':
      if (isRunning) return { action: 'Checking connection tools...' };
      if (isError) return { action: 'Could not check connection tools' };
      return { action: 'Checked connection tools' };
    case 'ListConnectionMethods':
      if (isRunning) return { action: 'Checking connection actions...' };
      if (isError) return { action: 'Could not check connection actions' };
      return { action: 'Checked connection actions' };
    case 'CreateConnection':
      if (isRunning) return { action: 'Saving connection...' };
      if (isError) return { action: 'Could not save connection' };
      return { action: 'Saved connection' };
    case 'PromptConnectionSetup':
      if (isRunning) return { action: 'Asking for connection details...' };
      if (isError) return { action: 'Could not ask for connection details' };
      return { action: 'Asked for connection details' };
    case 'GetCustomDomain':
      if (isRunning) return { action: 'Checking custom domain...' };
      if (isError) return { action: 'Could not check custom domain' };
      return { action: 'Checked custom domain' };
    case 'SetCustomDomain':
      if (isRunning) return { action: 'Setting custom domain...' };
      if (isError) return { action: 'Could not set custom domain' };
      return { action: 'Set custom domain' };
    case 'RemoveCustomDomain':
      if (isRunning) return { action: 'Removing custom domain...' };
      if (isError) return { action: 'Could not remove custom domain' };
      return { action: 'Removed custom domain' };
    case 'RetryCustomDomains':
      if (isRunning) return { action: 'Retrying custom domain setup...' };
      if (isError) return { action: 'Could not retry custom domain setup' };
      return { action: 'Retried custom domain setup' };
    case 'TodoWrite':
      if (isRunning) return { action: 'Updating tasks...' };
      if (isError) return { action: 'Failed to update tasks' };
      return { action: 'Updated tasks' };
    case 'NotebookEdit':
      if (isRunning) return { action: 'Editing notebook cell...' };
      if (isError) return { action: 'Failed to edit notebook cell' };
      return { action: 'Edited notebook cell' };
    case 'KillShell':
      if (isRunning) return { action: 'Stopping background task...' };
      if (isError) return { action: 'Failed to stop background task' };
      return { action: 'Stopped background task' };
    case 'TaskOutput':
      if (isRunning) return { action: 'Checking background task...' };
      if (isError) return { action: 'Could not check background task' };
      return { action: 'Checked background task' };
    default: {
      const displayName = humanizeToolName(summaryName || name || '');
      if (isRunning) return { action: `Using ${displayName}...` };
      if (isError) return { action: `Could not use ${displayName}` };
      return { action: `Used ${displayName}` };
    }
  }
}

export function getToolSummary(
  tool?: ToolUseBlock,
  result?: ToolResultBlock,
  status?: 'running' | 'complete' | 'error',
  isStreaming?: boolean
): string {
  const parts = getToolSummaryParts(tool, result, isStreaming, status);
  if (parts.filename) {
    return `${parts.action} ${parts.filename}`;
  }
  return parts.action;
}
