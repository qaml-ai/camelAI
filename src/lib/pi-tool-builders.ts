import type { ContentBlock } from '../types';

export type PiThreadItem = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export type RuntimeToolResult = {
  content: string | ContentBlock[];
  isError: boolean;
  details?: Record<string, unknown>;
};

export type PiTodoStatus = 'pending' | 'in_progress' | 'completed';

export type PiTodoItem = {
  content: string;
  status: PiTodoStatus;
  activeForm: string;
};

function normalizePiTodoStatus(status: unknown): PiTodoStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

export function buildPiTodos(plan: unknown): PiTodoItem[] {
  if (!Array.isArray(plan)) {
    return [];
  }

  return plan.map((item) => {
    const content =
      item && typeof item === 'object' && typeof (item as { step?: unknown }).step === 'string'
        ? (item as { step: string }).step
        : 'Untitled task';
    return {
      content,
      status: normalizePiTodoStatus(
        item && typeof item === 'object' ? (item as { status?: unknown }).status : undefined
      ),
      activeForm: content,
    };
  });
}

export function stringifyPiValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function joinNonEmpty(parts: Array<string | null | undefined>, separator = '\n\n'): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(separator);
}

function formatCommandResult(item: PiThreadItem): string {
  const output =
    typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trimEnd() : '';
  const metadata = [
    typeof item.exitCode === 'number' ? `exit code: ${item.exitCode}` : null,
    typeof item.durationMs === 'number' ? `duration: ${item.durationMs}ms` : null,
    typeof item.status === 'string' ? `status: ${item.status}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return joinNonEmpty([
    output,
    metadata ? `[${metadata}]` : '',
  ]);
}

function formatFileChangeResult(item: PiThreadItem): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const renderedChanges = changes
    .map((change) => {
      if (!change || typeof change !== 'object') {
        return stringifyPiValue(change);
      }
      const path =
        typeof (change as { path?: unknown }).path === 'string'
          ? (change as { path: string }).path
          : 'file';
      const kind =
        typeof (change as { kind?: unknown }).kind === 'string'
          ? (change as { kind: string }).kind
          : 'change';
      const diff =
        typeof (change as { diff?: unknown }).diff === 'string'
          ? (change as { diff: string }).diff
          : '';
      return joinNonEmpty([`${kind}: ${path}`, diff], '\n');
    })
    .filter(Boolean)
    .join('\n\n');

  return joinNonEmpty([
    typeof item.status === 'string' ? `status: ${item.status}` : '',
    renderedChanges,
  ]);
}

function formatMcpToolResult(item: PiThreadItem): string {
  if (item.error != null) {
    return stringifyPiValue(item.error);
  }
  if (item.result != null) {
    return stringifyPiValue(item.result);
  }
  if (typeof item.status === 'string') {
    return `status: ${item.status}`;
  }
  return '';
}

function formatDynamicToolResult(item: PiThreadItem): string {
  const parts: string[] = [];
  const dynamicToolName = canonicalizeDynamicToolName(item.tool);
  const isAgentCapability = ['Agent', 'Explore', 'Research', 'Oracle'].includes(dynamicToolName);
  if (Array.isArray(item.contentItems)) {
    for (const contentItem of item.contentItems) {
      if (!contentItem || typeof contentItem !== 'object') {
        parts.push(stringifyPiValue(contentItem));
        continue;
      }
      const contentType = (contentItem as { type?: unknown }).type;
      if (
        (contentType === 'inputText' || contentType === 'outputText' || contentType === 'text') &&
        typeof (contentItem as { text?: unknown }).text === 'string'
      ) {
        parts.push((contentItem as { text: string }).text);
        continue;
      }
      parts.push(stringifyPiValue(contentItem));
    }
  }
  if (typeof item.success === 'boolean' && (!isAgentCapability || item.success === false)) {
    parts.push(`success: ${item.success}`);
  }
  if (
    typeof item.status === 'string' &&
    (!isAgentCapability || item.status === 'failed' || item.status === 'error')
  ) {
    parts.push(`status: ${item.status}`);
  }
  return parts.join('\n\n');
}

function formatCollabAgentResult(item: PiThreadItem): string {
  return stringifyPiValue({
    status: item.status,
    tool: item.tool,
    receiverThreadIds: item.receiverThreadIds,
    agentsStates: item.agentsStates,
  });
}

function formatWebSearchResult(item: PiThreadItem): string {
  return joinNonEmpty([
    typeof item.query === 'string' ? item.query : '',
    item.action != null ? stringifyPiValue(item.action) : '',
  ]);
}

function formatImageResult(item: PiThreadItem): string {
  return joinNonEmpty([
    typeof item.savedPath === 'string' ? `saved to: ${item.savedPath}` : '',
    typeof item.result === 'string' ? item.result : '',
    typeof item.path === 'string' ? item.path : '',
    typeof item.revisedPrompt === 'string' ? `prompt: ${item.revisedPrompt}` : '',
  ]);
}

export function isFailedRuntimeItem(item: PiThreadItem): boolean {
  const status = typeof item.status === 'string' ? item.status : '';
  const result = item.result && typeof item.result === 'object'
    ? item.result as { details?: unknown }
    : null;
  const details = result?.details && typeof result.details === 'object'
    ? result.details as { success?: unknown; exitCode?: unknown }
    : null;
  return (
    item.isError === true ||
    status === 'failed' ||
    status === 'error' ||
    item.error != null ||
    item.success === false ||
    details?.success === false ||
    (typeof details?.exitCode === 'number' && details.exitCode !== 0) ||
    (
      item.type === 'commandExecution' &&
      typeof item.exitCode === 'number' &&
      item.exitCode !== 0
    )
  );
}

function buildRuntimeToolResult(
  item: PiThreadItem,
  content: string | ContentBlock[]
): RuntimeToolResult | null {
  if (typeof content === 'string' && content.length === 0) {
    return null;
  }
  if (Array.isArray(content) && content.length === 0) {
    return null;
  }
  const runtimeResult = item.result && typeof item.result === 'object' && !Array.isArray(item.result)
    ? item.result as Record<string, unknown>
    : null;
  const outerDetails = runtimeResult?.details && typeof runtimeResult.details === 'object' && !Array.isArray(runtimeResult.details)
    ? runtimeResult.details as Record<string, unknown>
    : null;
  const nestedDetails = outerDetails?.details && typeof outerDetails.details === 'object' && !Array.isArray(outerDetails.details)
    ? outerDetails.details as Record<string, unknown>
    : null;
  const dynamicToolName = item.type === 'dynamicToolCall'
    ? canonicalizeDynamicToolName(item.tool)
    : null;
  const details = dynamicToolName === 'Edit'
    ? nestedDetails ?? outerDetails ?? undefined
    : dynamicToolName && ['Agent', 'Explore', 'Research', 'Oracle'].includes(dynamicToolName)
      ? outerDetails ?? undefined
      : undefined;
  return {
    content,
    isError: isFailedRuntimeItem(item),
    ...(details ? { details } : {}),
  };
}

export function canonicalizeDynamicToolName(tool: unknown): string {
  if (typeof tool !== 'string') return 'DynamicTool';
  const name = tool.trim();
  if (!name) return 'DynamicTool';

  switch (name) {
    case 'ask_user_question':
      return 'AskUserQuestion';
    case 'todo_write':
    case 'update_todo':
      return 'TodoWrite';
    case 'agent':
      return 'Agent';
    case 'Explore':
    case 'explore':
      return 'Explore';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    case 'js_exec':
    case 'codemode':
      return 'JavaScript';
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
    case 'connections_list':
      return 'ListConnections';
    case 'connections_get':
      return 'GetConnection';
    case 'connections_tools':
      return 'ListConnectionTools';
    case 'connections_methods':
      return 'ListConnectionMethods';
    case 'read':
      return 'Read';
    case 'write':
      return 'Write';
    case 'edit':
      return 'Edit';
    case 'ls':
      return 'LS';
    case 'bash':
      return 'Bash';
    case 'grep':
      return 'Grep';
    case 'find':
      return 'Find';
    case 'glob':
      return 'Glob';
    default:
      return name;
  }
}

export function normalizeEditArguments(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };

  if (typeof next.edits === 'string') {
    try {
      const parsed = JSON.parse(next.edits);
      if (Array.isArray(parsed)) next.edits = parsed;
    } catch {
      // Preserve the original value for error rendering.
    }
  }

  if (typeof next.old_string !== 'string' && typeof next.oldText === 'string') {
    next.old_string = next.oldText;
  }
  if (typeof next.new_string !== 'string' && typeof next.newText === 'string') {
    next.new_string = next.newText;
  }

  if (Array.isArray(next.edits)) {
    const edits = next.edits.map((edit) => {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return edit;
      const editRecord = edit as Record<string, unknown>;
      return {
        ...editRecord,
        old_string:
          typeof editRecord.old_string === 'string'
            ? editRecord.old_string
            : editRecord.oldText,
        new_string:
          typeof editRecord.new_string === 'string'
            ? editRecord.new_string
            : editRecord.newText,
      };
    });
    if (typeof next.old_string === 'string' && typeof next.new_string === 'string') {
      edits.push({ old_string: next.old_string, new_string: next.new_string });
    }
    next.edits = edits;
  }

  return next;
}

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function buildDynamicToolInput(item: PiThreadItem): Record<string, unknown> {
  const args =
    item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)
      ? normalizeEditArguments(item.arguments as Record<string, unknown>)
      : {};
  const rawToolName = typeof item.tool === 'string' ? item.tool : undefined;

  return omitUndefined({
    ...args,
    arguments: item.arguments,
    status: item.status,
    durationMs: item.durationMs,
    rawToolName,
  });
}

export function buildToolUseFromPiItem(item: PiThreadItem): {
  name: string;
  input: Record<string, unknown>;
} | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        name: 'Bash',
        input: omitUndefined({
          command: item.command,
          project: item.project,
          description: item.description,
          cwd: item.cwd,
          source: item.source,
          processId: item.processId,
          status: item.status,
          commandActions: item.commandActions,
        }),
      };
    case 'fileChange':
      return {
        name: 'PiFileChange',
        input: {
          status: item.status,
          changes: item.changes,
        },
      };
    case 'mcpToolCall':
      return {
        name: `mcp__${String(item.server ?? 'server')}__${String(item.tool ?? 'tool')}`,
        input: {
          arguments: item.arguments,
          status: item.status,
          durationMs: item.durationMs,
        },
      };
    case 'dynamicToolCall':
      return {
        name: canonicalizeDynamicToolName(item.tool),
        input: buildDynamicToolInput(item),
      };
    case 'collabAgentToolCall':
      return {
        name: 'Agent',
        input: {
          description: item.prompt,
          tool: item.tool,
          receiverThreadIds: item.receiverThreadIds,
          model: item.model,
          reasoningEffort: item.reasoningEffort,
          status: item.status,
        },
      };
    case 'webSearch':
      return {
        name: 'WebSearch',
        input: {
          query: item.query,
          action: item.action,
        },
      };
    case 'imageView':
      return {
        name: 'PiImageView',
        input: {
          path: item.path,
        },
      };
    case 'imageGeneration':
      return {
        name: 'PiImageGeneration',
        input: {
          status: item.status,
          revisedPrompt: item.revisedPrompt,
          savedPath: item.savedPath,
        },
      };
    case 'enteredReviewMode':
      return {
        name: 'PiReviewMode',
        input: {
          action: 'enter',
          review: item.review,
        },
      };
    case 'exitedReviewMode':
      return {
        name: 'PiReviewMode',
        input: {
          action: 'exit',
          review: item.review,
        },
      };
    case 'contextCompaction':
      return {
        name: 'PiContextCompaction',
        input: {},
      };
    default:
      return {
        name: `Pi:${item.type}`,
        input: Object.fromEntries(
          Object.entries(item).filter(([key]) => key !== 'id' && key !== 'type')
        ),
      };
  }
}

export function buildToolResultFromPiItem(item: PiThreadItem): RuntimeToolResult | null {
  switch (item.type) {
    case 'commandExecution':
      return buildRuntimeToolResult(item, formatCommandResult(item));
    case 'fileChange':
      return buildRuntimeToolResult(item, formatFileChangeResult(item));
    case 'mcpToolCall':
      return buildRuntimeToolResult(item, formatMcpToolResult(item));
    case 'dynamicToolCall':
      return buildRuntimeToolResult(item, formatDynamicToolResult(item));
    case 'collabAgentToolCall':
      return buildRuntimeToolResult(item, formatCollabAgentResult(item));
    case 'webSearch':
      return buildRuntimeToolResult(item, formatWebSearchResult(item));
    case 'imageView':
    case 'imageGeneration':
      return buildRuntimeToolResult(item, formatImageResult(item));
    case 'enteredReviewMode':
      return buildRuntimeToolResult(
        item,
        typeof item.review === 'string' ? item.review : 'Entered review mode.'
      );
    case 'exitedReviewMode':
      return buildRuntimeToolResult(
        item,
        typeof item.review === 'string' ? item.review : 'Exited review mode.'
      );
    case 'contextCompaction':
      return buildRuntimeToolResult(item, 'Context compacted.');
    default:
      return buildRuntimeToolResult(
        item,
        stringifyPiValue(
          Object.fromEntries(
            Object.entries(item).filter(([key]) => key !== 'id' && key !== 'type')
          )
        )
      );
  }
}
