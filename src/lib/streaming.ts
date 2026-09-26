import type {
  ContentBlock,
  Message,
  TaskNotificationBlock,
  TeammateMessageBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@/types';
import { parseTeammateMessage, type ParsedTeammateMessage } from '@/lib/teammate-message';
import {
  parseTaskNotificationFromContent,
  type ParsedTaskNotification,
} from '@/lib/task-notification';

/**
 * Identity-keyed per-message caches for the render-time normalization chain
 * (normalizeToolResultMessages → mergeTeammateMessages → mergeTaskNotifications).
 * The chain re-runs over the whole transcript on every streaming tick, but only
 * the streaming message's object identity changes per tick — so the per-message
 * pure work (content sanitizing, teammate/task-notification XML parsing,
 * tool_use extraction) is cached here and only the cheap cross-message merge
 * loops re-run. Messages are immutable snapshots (a changed message is a new
 * object), which is what makes identity keying sound. Optional everywhere:
 * callers that don't stream (tests, one-shot paths) can omit it.
 */
export interface TranscriptNormalizationCaches {
  toolResultClassification: WeakMap<Message, ToolResultMessageClassification>;
  teammateParse: WeakMap<Message, ParsedTeammateMessage | null>;
  taskNotificationParse: WeakMap<Message, ParsedTaskNotification | null>;
  toolUseBlocks: WeakMap<Message, ToolUseBlock[]>;
}

export function createTranscriptNormalizationCaches(): TranscriptNormalizationCaches {
  return {
    toolResultClassification: new WeakMap(),
    teammateParse: new WeakMap(),
    taskNotificationParse: new WeakMap(),
    toolUseBlocks: new WeakMap(),
  };
}

function isContentBlockLike(value: unknown): value is ContentBlock {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function sanitizeContentBlocks(content: Message['content']): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isContentBlockLike);
}

function sanitizeMessageContentForRender(message: Message): Message {
  if (!Array.isArray(message.content)) return message;
  const sanitizedContent = sanitizeContentBlocks(message.content);
  if (sanitizedContent.length === message.content.length) {
    return message;
  }
  return {
    ...message,
    content: sanitizedContent,
  };
}

function isToolResultBlock(block: ContentBlock | null | undefined): block is ToolResultBlock {
  return block?.type === 'tool_result';
}

interface ToolUseIndexEntry {
  messageIndex: number;
  tool: ToolUseBlock;
}

function extractToolUseBlocks(
  message: Message,
  cache?: WeakMap<Message, ToolUseBlock[]>,
): ToolUseBlock[] {
  const cached = cache?.get(message);
  if (cached) return cached;
  const blocks =
    message.role === 'assistant' && Array.isArray(message.content)
      ? sanitizeContentBlocks(message.content).filter(
          (block): block is ToolUseBlock =>
            block.type === 'tool_use' && Boolean(block.id),
        )
      : [];
  cache?.set(message, blocks);
  return blocks;
}

function buildToolUseIndex(
  messages: Message[],
  cache?: WeakMap<Message, ToolUseBlock[]>,
): Map<string, ToolUseIndexEntry> {
  const index = new Map<string, ToolUseIndexEntry>();
  messages.forEach((message, messageIndex) => {
    for (const block of extractToolUseBlocks(message, cache)) {
      index.set(block.id, { messageIndex, tool: block });
    }
  });
  return index;
}

function isSubAgentTool(name?: string): boolean {
  return name === 'Task' || name === 'Agent' || name === 'agent' || name === 'Explore' || name === 'explore' || name === 'Research' || name === 'Oracle';
}

function findTaskToolUseIdByPrompt(messages: Message[], prompt?: string): string | undefined {
  if (!prompt) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isContentBlockLike(block)) continue;
      if (block.type !== 'tool_use' || !isSubAgentTool(block.name)) continue;
      const blockPrompt = typeof block.input?.prompt === 'string' ? block.input.prompt : '';
      if (blockPrompt && blockPrompt === prompt) {
        return block.id;
      }
    }
  }
  return undefined;
}

function coerceMessageContent(content: Message['content']): ContentBlock[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function findLastAssistantIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') return i;
  }
  return -1;
}

export function attachToolResultsToMessages(
  messages: Message[],
  toolResults: ToolResultBlock[],
  options: {
    threadId?: string;
    createdAt?: number;
    parentToolUseId?: string;
    parentToolPrompt?: string;
  } = {}
): Message[] {
  if (toolResults.length === 0) return messages;

  const next = [...messages];
  const toolUseIndex = buildToolUseIndex(next);
  const createdAt = options.createdAt ?? Date.now();
  const promptMatchedId = findTaskToolUseIdByPrompt(next, options.parentToolPrompt);
  const parentToolUseId = options.parentToolUseId ?? promptMatchedId;
  const parentEntry = parentToolUseId ? toolUseIndex.get(parentToolUseId) : undefined;
  const parentIsTask = isSubAgentTool(parentEntry?.tool.name);

  const appendToIndex = (index: number, toolResult: ToolResultBlock) => {
    const target = next[index];
    const content = Array.isArray(target.content)
      ? target.content.slice()
      : coerceMessageContent(target.content);
    content.push(toolResult);
    next[index] = {
      ...target,
      content,
    };
  };

  toolResults.forEach((toolResult, index) => {
    const directEntry = toolUseIndex.get(toolResult.tool_use_id);
    // When the parent is a sub-agent tool (Agent/Task), always group results under
    // the parent — even if the sub-agent's tool_use blocks were mixed into the main
    // message via streaming and would otherwise match directly.
    const resolvedToolUseId = (parentIsTask && parentToolUseId)
      ? parentToolUseId
      : directEntry
        ? toolResult.tool_use_id
        : toolResult.tool_use_id;
    const resolvedEntry = (parentIsTask && parentEntry)
      ? parentEntry
      : directEntry ?? (resolvedToolUseId === parentToolUseId ? parentEntry : undefined);
    const targetIndex = resolvedEntry?.messageIndex ?? findLastAssistantIndex(next);
    const resolvedResult = resolvedToolUseId === toolResult.tool_use_id
      ? toolResult
      : { ...toolResult, tool_use_id: resolvedToolUseId, isTaskUpdate: true };

    if (targetIndex >= 0) {
      appendToIndex(targetIndex, resolvedResult);
      return;
    }

    const threadId = options.threadId ?? messages[0]?.thread_id ?? '';
    next.push({
      id: `tool_result_${createdAt}_${index}`,
      thread_id: threadId,
      role: 'assistant',
      content: [resolvedResult],
      created_at: createdAt,
    });
  });

  return next;
}

/** Per-message pure step of normalizeToolResultMessages: `toolResults` is set
 * for a user message made entirely of tool_result blocks (lifted into earlier
 * messages by the merge loop), otherwise `sanitizedMessage` is what renders. */
export interface ToolResultMessageClassification {
  sanitizedMessage: Message;
  toolResults: ToolResultBlock[] | null;
}

function classifyToolResultMessage(
  message: Message,
  cache?: WeakMap<Message, ToolResultMessageClassification>,
): ToolResultMessageClassification {
  const cached = cache?.get(message);
  if (cached) return cached;
  const contentBlocks = Array.isArray(message.content)
    ? sanitizeContentBlocks(message.content)
    : null;
  const isToolResultMessage = message.role === 'user' &&
    contentBlocks &&
    contentBlocks.length > 0 &&
    contentBlocks.every(isToolResultBlock);
  const classification: ToolResultMessageClassification =
    isToolResultMessage && contentBlocks
      ? { sanitizedMessage: message, toolResults: contentBlocks.filter(isToolResultBlock) }
      : { sanitizedMessage: sanitizeMessageContentForRender(message), toolResults: null };
  cache?.set(message, classification);
  return classification;
}

export function normalizeToolResultMessages(
  messages: Message[],
  caches?: TranscriptNormalizationCaches,
): Message[] {
  let normalized: Message[] = [];
  let changed = false;

  messages.forEach(message => {
    const { sanitizedMessage, toolResults } = classifyToolResultMessage(
      message,
      caches?.toolResultClassification,
    );

    if (!toolResults) {
      if (sanitizedMessage !== message) {
        changed = true;
      }
      normalized.push(sanitizedMessage);
      return;
    }

    normalized = attachToolResultsToMessages(normalized, toolResults, {
      threadId: message.thread_id,
      createdAt: message.created_at,
      parentToolUseId: message.sourceToolUseID,
    });
    changed = true;
  });

  return changed ? normalized : messages;
}

/**
 * Merge teammate messages into the preceding assistant message.
 *
 * Teammate messages arrive as `role: "user"` messages containing
 * `<teammate-message>` XML. This function detects them, removes them
 * from the message list, and appends a `teammate_message` content block
 * to the preceding assistant message — so they render inline with the
 * assistant's tool calls and text, with identical spacing.
 */
function parseTeammateMessageFromMessage(
  msg: Message,
  cache?: WeakMap<Message, ParsedTeammateMessage | null>,
): ParsedTeammateMessage | null {
  if (cache?.has(msg)) return cache.get(msg) ?? null;
  // Extract raw text to check for teammate message
  const rawText = typeof msg.content === 'string'
    ? msg.content
    : msg.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n');
  const parsed = parseTeammateMessage(rawText);
  cache?.set(msg, parsed);
  return parsed;
}

export function mergeTeammateMessages(
  messages: Message[],
  caches?: TranscriptNormalizationCaches,
): Message[] {
  const result: Message[] = [];
  let changed = false;

  for (const msg of messages) {
    if (msg.role !== 'user') {
      result.push(msg);
      continue;
    }

    const parsed = parseTeammateMessageFromMessage(msg, caches?.teammateParse);
    if (!parsed) {
      result.push(msg);
      continue;
    }

    // Find the last assistant message to attach to
    let lastAssistantIndex = -1;
    for (let i = result.length - 1; i >= 0; i -= 1) {
      if (result[i].role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }

    if (lastAssistantIndex === -1) {
      // No preceding assistant message — keep as-is (fallback)
      result.push(msg);
      continue;
    }

    // Append teammate block to the assistant message's content
    const assistantMsg = result[lastAssistantIndex];
    const existingContent: ContentBlock[] = Array.isArray(assistantMsg.content)
      ? assistantMsg.content
      : [{ type: 'text' as const, text: assistantMsg.content }];

    const teammateBlock: TeammateMessageBlock = {
      type: 'teammate_message',
      teammateId: parsed.teammateId,
      content: parsed.content,
    };

    result[lastAssistantIndex] = {
      ...assistantMsg,
      content: [...existingContent, teammateBlock],
    };
    changed = true;
  }

  return changed ? result : messages;
}

/**
 * Merge task notifications into assistant content so they render as tool-call rows.
 *
 * Task notifications arrive as `role: "user"` messages containing
 * `<task-notification>` XML. This function removes those messages and appends
 * a `task_notification` block to the assistant message that owns the referenced
 * tool use (`sourceToolUseID`) when available, otherwise to the nearest
 * preceding assistant message. If no assistant message exists yet, it creates
 * a synthetic assistant message so raw XML is never shown in the transcript.
 */
export function mergeTaskNotifications(
  messages: Message[],
  caches?: TranscriptNormalizationCaches,
): Message[] {
  const result: Message[] = [];
  let changed = false;
  const fullToolUseIndex = buildToolUseIndex(messages, caches?.toolUseBlocks);
  const resultAssistantIndexBySourceIndex = new Map<number, number>();
  const queuedByAssistantSourceIndex = new Map<
    number,
    Array<{ sourceMessage: Message; taskBlock: TaskNotificationBlock }>
  >();

  const appendTaskBlockToAssistant = (assistantResultIndex: number, taskBlock: TaskNotificationBlock) => {
    const assistantMsg = result[assistantResultIndex];
    const existingContent = coerceMessageContent(assistantMsg.content);
    result[assistantResultIndex] = {
      ...assistantMsg,
      content: [...existingContent, taskBlock],
    };
  };

  const enqueueForAssistant = (
    assistantSourceIndex: number,
    sourceMessage: Message,
    taskBlock: TaskNotificationBlock
  ) => {
    const existing = queuedByAssistantSourceIndex.get(assistantSourceIndex);
    if (existing) {
      existing.push({ sourceMessage, taskBlock });
      return;
    }
    queuedByAssistantSourceIndex.set(assistantSourceIndex, [{ sourceMessage, taskBlock }]);
  };

  const flushQueuedForAssistant = (assistantSourceIndex: number, assistantResultIndex: number) => {
    const queued = queuedByAssistantSourceIndex.get(assistantSourceIndex);
    if (!queued || queued.length === 0) return;

    queued.forEach(({ taskBlock }) => {
      appendTaskBlockToAssistant(assistantResultIndex, taskBlock);
    });
    queuedByAssistantSourceIndex.delete(assistantSourceIndex);
  };

  for (const [sourceIndex, msg] of messages.entries()) {
    if (msg.role !== 'user') {
      result.push(msg);
      if (msg.role === 'assistant') {
        const assistantResultIndex = result.length - 1;
        resultAssistantIndexBySourceIndex.set(sourceIndex, assistantResultIndex);
        flushQueuedForAssistant(sourceIndex, assistantResultIndex);
      }
      continue;
    }

    let parsed: ParsedTaskNotification | null;
    if (caches?.taskNotificationParse.has(msg)) {
      parsed = caches.taskNotificationParse.get(msg) ?? null;
    } else {
      parsed = parseTaskNotificationFromContent(msg.content);
      caches?.taskNotificationParse.set(msg, parsed);
    }
    if (!parsed) {
      result.push(msg);
      continue;
    }

    const taskBlock: TaskNotificationBlock = {
      type: 'task_notification',
      taskId: parsed.taskId,
      outputFile: parsed.outputFile,
      status: parsed.status,
      summary: parsed.summary,
    };

    const sourceToolUseId = msg.sourceToolUseID;
    const sourceToolEntry = sourceToolUseId
      ? fullToolUseIndex.get(sourceToolUseId)
      : undefined;

    if (typeof sourceToolEntry?.messageIndex === 'number') {
      const resolvedAssistantResultIndex = resultAssistantIndexBySourceIndex.get(sourceToolEntry.messageIndex);
      if (typeof resolvedAssistantResultIndex === 'number') {
        appendTaskBlockToAssistant(resolvedAssistantResultIndex, taskBlock);
      } else {
        enqueueForAssistant(sourceToolEntry.messageIndex, msg, taskBlock);
      }
      changed = true;
      continue;
    }

    const targetAssistantIndex = findLastAssistantIndex(result);

    if (targetAssistantIndex === -1) {
      result.push({
        id: `task_notification_${msg.id}`,
        thread_id: msg.thread_id,
        role: 'assistant',
        content: [taskBlock],
        created_at: msg.created_at,
      });
      changed = true;
      continue;
    }

    appendTaskBlockToAssistant(targetAssistantIndex, taskBlock);
    changed = true;
  }

  if (queuedByAssistantSourceIndex.size > 0) {
    queuedByAssistantSourceIndex.forEach(queued => {
      queued.forEach(({ sourceMessage, taskBlock }) => {
        result.push({
          id: `task_notification_${sourceMessage.id}`,
          thread_id: sourceMessage.thread_id,
          role: 'assistant',
          content: [taskBlock],
          created_at: sourceMessage.created_at,
        });
      });
    });
    changed = true;
  }

  return changed ? result : messages;
}
