'use client';

import { AlertCircle, Copy, Check, GitFork } from 'lucide-react';
import type { AtMentionEntity, Message, ContentBlock, ToolResultBlock, ToolUseBlock, LlmModel, LlmProvider } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { ThinkingBlock, ToolCall } from '@/components/tool-call';
import { isSubAgentTool } from '@/components/tool-call/tool-utils';
import { TeammateMessage } from '@/components/tool-call/teammate-message';
import { TaskNotification } from '@/components/tool-call/task-notification';
import { LoadingDots } from '@/components/loading-dots';
import { CompactSummaryCard } from '@/components/compact-summary-card';
import { memo } from 'react';
import type { ReactNode } from 'react';
import { useAuthData } from '@/hooks/use-auth-data';
import { FilePreviewChip } from '@/components/chat-file-preview';
import { CollapsibleUserMessage } from '@/components/collapsible-user-message';
import { ChannelLogo } from '@/components/chat/channel-logo';
import {
  ChatApiErrorNotice,
} from '@/components/chat-api-error-notice';
import { isSupportedSlashCommand } from '@/lib/slash-commands';
import {
  getChatApiErrorPresentation,
} from '@/lib/chat-api-errors';
import { parseByokProvider } from '@/lib/byok-providers';
import { parseUploadRefsFromContent } from '@/lib/chat-attachment-refs';
import { getChannelBrand } from '@/lib/channel-branding';
import {
  parseMessageAuthor,
  resolveMessageAuthorDisplayName,
  stripSystemMessageTagsOnly,
} from '@/lib/message-author';
import {
  type AnnotatedMentionRef,
  stripMentionAnnotations,
  stripMentionAnnotationsWithMetadata,
} from '@/lib/mentions';
import { cn } from '@/lib/utils';
import {
  filterContentForRenderMode,
  isRedactedThinkingBlock,
  type MessageRenderMode,
} from '@/lib/turn-utils';

const messageTimeCache = new Map<string, string>();
const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const EMPTY_ANNOTATED_MENTIONS: AnnotatedMentionRef[] = [];

function getDayKey(timestamp: number, timeZone?: string): string {
  const formatterKey = timeZone ?? 'local';
  let formatter = dayKeyFormatters.get(formatterKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    });
    dayKeyFormatters.set(formatterKey, formatter);
  }
  return formatter.format(timestamp);
}

// Format timestamp to readable time, prefixed with the date for messages
// sent before today (e.g., "12:25 PM" today, "Jun 25, 2:41 PM" otherwise)
function formatMessageTime(timestamp: number, timeZone?: string): string {
  const isToday = getDayKey(timestamp, timeZone) === getDayKey(Date.now(), timeZone);
  const cacheKey = `${timestamp}:${timeZone ?? 'local'}:${isToday ? 'today' : 'dated'}`;
  const cached = messageTimeCache.get(cacheKey);
  if (cached) return cached;

  const formatted = new Date(timestamp).toLocaleString([], {
    ...(isToday ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  });
  messageTimeCache.set(cacheKey, formatted);
  if (messageTimeCache.size > 2000) {
    const firstKey = messageTimeCache.keys().next().value;
    if (typeof firstKey === 'string') {
      messageTimeCache.delete(firstKey);
    }
  }
  return formatted;
}

// ── Special message detection ──

const INTERRUPT_TEXT = '[Request interrupted by user]';
const STOPPED_BY_USER_TEXT = 'Stopped by user';

const WRAPPED_SLASH_COMMAND_REGEX = /<command-name>(\/\w[\w-]*)<\/command-name>/;
const BARE_SLASH_COMMAND_REGEX = /^(\/\w[\w-]*)$/;

const LOCAL_COMMAND_STDOUT_REGEX = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/;

/** Extract raw text from content, stripping author prefix and system tags. */
function extractRawText(content: string | ContentBlock[]): string {
  const text = typeof content === 'string'
    ? content
    : content.map(b => (b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
  return stripSystemMessageTags(parseMessageAuthor(text).content);
}

/** True when the message is the SDK's "[Request interrupted by user]" sentinel. */
export function isInterruptMessage(content: string | ContentBlock[]): boolean {
  return extractRawText(content).trim() === INTERRUPT_TEXT;
}

function isStoppedByUserStatusMessage(content: string | ContentBlock[]): boolean {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const [block] = content;
  return (
    block.type === 'text' &&
    block.itemKind === 'userStop' &&
    extractRawText(block.text).trim() === STOPPED_BY_USER_TEXT
  );
}

/** Returns the slash command name (e.g. "/compact") or null. */
export function parseSlashCommand(content: string | ContentBlock[]): string | null {
  const raw = extractRawText(content).trim();
  const wrapped = raw.match(WRAPPED_SLASH_COMMAND_REGEX);
  const wrappedCommand = wrapped?.[1];
  if (wrappedCommand && isSupportedSlashCommand(wrappedCommand)) {
    return wrappedCommand;
  }

  const bare = raw.match(BARE_SLASH_COMMAND_REGEX);
  const bareCommand = bare?.[1];
  return bareCommand && isSupportedSlashCommand(bareCommand) ? bareCommand : null;
}

/** Returns the inner text of a `<local-command-stdout>` message, or null. */
export function parseLocalCommandStdout(content: string | ContentBlock[]): string | null {
  const match = extractRawText(content).trim().match(LOCAL_COMMAND_STDOUT_REGEX);
  return match ? match[1].trim() : null;
}

/**
 * Strip camelAI system message tags from content.
 * These tags are used internally to pass context to the AI but shouldn't
 * be shown verbosely to users.
 */
function stripSystemMessageTags(text: string): string {
  return stripMentionAnnotations(stripSystemMessageTagsOnly(text)).trim();
}

function prepareDisplayText(text: string): {
  displayText: string;
  annotatedMentions: AnnotatedMentionRef[];
} {
  const { displayText, annotatedMentions } = stripMentionAnnotationsWithMetadata(
    stripSystemMessageTagsOnly(text),
  );
  return {
    displayText: displayText.trim(),
    annotatedMentions:
      annotatedMentions.length > 0 ? annotatedMentions : EMPTY_ANNOTATED_MENTIONS,
  };
}

function safeJsonStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (block.type === 'text') return block.text;
        if (isRedactedThinkingBlock(block)) return '';
        if (block.type === 'thinking') {
          const summaryText = Array.isArray(block.summaries) ? block.summaries.join('\n\n') : '';
          return summaryText
            ? `[Thinking Summary]\n${summaryText}\n\n[Thinking]\n${block.thinking}`
            : `[Thinking]\n${block.thinking}`;
        }
        if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${safeJsonStringify(block.input)}`;
        if (block.type === 'tool_result') return `[Result]\n${normalizeToolResultContent(block.content)}`;
        if (block.type === 'task_notification') return `[Task ${block.status}] ${block.summary}`;
        if (block.type === 'error') return `[Error]\n${block.error}`;
        return safeJsonStringify(block);
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return safeJsonStringify(content);
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

/**
 * Check if content has any visible text after stripping system messages.
 * Returns false if the content is entirely system messages.
 */
function hasVisibleContent(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') {
    return stripSystemMessageTags(content).length > 0;
  }
  return content.some(block => {
    if (block.type === 'text') {
      return stripSystemMessageTags(block.text).length > 0;
    }
    if (isRedactedThinkingBlock(block)) {
      return false;
    }
    // Other block types (tool_use, tool_result, thinking) are always visible
    return true;
  });
}

// Convert content to string for copy functionality
export function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return stripSystemMessageTags(content);
  return content
    .map(block => {
      if (block.type === 'text') return stripSystemMessageTags(block.text);
      if (block.type === 'tool_use') return `[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
      if (block.type === 'tool_result') return `[Result]\n${normalizeToolResultContent(block.content)}`;
      if (isRedactedThinkingBlock(block)) return '';
      if (block.type === 'thinking') {
        const summaryText = Array.isArray(block.summaries) ? block.summaries.join('\n\n') : '';
        return summaryText
          ? `[Thinking Summary]\n${summaryText}\n\n[Thinking]\n${block.thinking}`
          : `[Thinking]\n${block.thinking}`;
      }
      if (block.type === 'teammate_message') return `[Update from ${block.teammateId}]\n${block.content}`;
      if (block.type === 'task_notification') return `[Task ${block.status}] ${block.summary}`;
      if (block.type === 'error') return `[Error]\n${block.error}`;
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function userFacingContentToString(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return stripSystemMessageTags(content).trim();
  return content
    .map(block => {
      if (block.type !== 'text') return '';
      return stripSystemMessageTags(block.text).trim();
    })
    .filter(Boolean)
    .join('\n\n');
}
interface ContentBlockRendererProps {
  content: string | ContentBlock[];
  messageId?: string;
  isStreaming?: boolean;
  workspaceId?: string;
  skillSheets?: Map<string, string>;
  mentionSlugMap?: Map<string, AtMentionEntity>;
  llmProvider?: LlmProvider | null;
  threadModel?: LlmModel | null;
}

export function ContentBlockRenderer({
  content,
  messageId,
  isStreaming = false,
  workspaceId,
  skillSheets,
  mentionSlugMap,
  llmProvider,
  threadModel,
}: ContentBlockRendererProps) {
  // String content - render as markdown
  if (typeof content === 'string') {
    const { displayText: displayContent, annotatedMentions } = prepareDisplayText(content);
    if (!displayContent) return null;
    return (
      <MarkdownRenderer
        content={displayContent}
        isStreaming={isStreaming}
        workspaceId={workspaceId}
        mentionSlugMap={mentionSlugMap}
        annotatedMentions={annotatedMentions}
      />
    );
  }

  // Empty content
  if (content.length === 0) {
    return null;
  }

  const toolResultsById = new Map<string, ToolResultBlock[]>();
  const toolUseIds = new Set<string>();
  content.forEach(block => {
    if (block.type === 'tool_result') {
      const existing = toolResultsById.get(block.tool_use_id) ?? [];
      existing.push(block);
      toolResultsById.set(block.tool_use_id, existing);
    }
    if (block.type === 'tool_use') {
      toolUseIds.add(block.id);
    }
  });
  const agentContinuedAfterIndex = new Map<number, boolean>();
  const thinkingContinuedAfterIndex = new Map<number, boolean>();
  let hasToolContinuationAfterCurrentBlock = false;
  let hasThinkingContinuationAfterCurrentBlock = false;
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (block.type === 'tool_use') {
      agentContinuedAfterIndex.set(index, hasToolContinuationAfterCurrentBlock);
    }
    if (block.type === 'thinking') {
      thinkingContinuedAfterIndex.set(index, hasThinkingContinuationAfterCurrentBlock);
    }
    if (block.type === 'text' || block.type === 'tool_result') {
      hasToolContinuationAfterCurrentBlock = true;
    }
    if (
      block.type === 'text' ||
      block.type === 'tool_use' ||
      block.type === 'tool_result' ||
      block.type === 'teammate_message' ||
      block.type === 'task_notification' ||
      block.type === 'error' ||
      (block.type === 'thinking' && !isRedactedThinkingBlock(block))
    ) {
      hasThinkingContinuationAfterCurrentBlock = true;
    }
  }
  const items: Array<{ kind: 'trace' | 'other'; node: ReactNode; key: string }> = [];

  content.forEach((block, index) => {
    if (block.type === 'text') {
      const { displayText, annotatedMentions } = prepareDisplayText(block.text);
      // Skip empty text blocks after stripping system messages
      if (!displayText) return;
      if (block.itemKind === 'userStop' && displayText === STOPPED_BY_USER_TEXT) {
        items.push({
          kind: 'other',
          key: `text-${index}`,
          node: (
            <p className="text-sm italic text-muted-foreground/70">
              {STOPPED_BY_USER_TEXT}
            </p>
          ),
        });
        return;
      }
      items.push({
        kind: 'other',
        key: `text-${index}`,
        node: (
          <div className="max-w-none">
            <MarkdownRenderer
              content={displayText}
              isStreaming={isStreaming}
              workspaceId={workspaceId}
              mentionSlugMap={mentionSlugMap}
              annotatedMentions={annotatedMentions}
            />
          </div>
        ),
      });
      return;
    }

    if (isRedactedThinkingBlock(block)) {
      return;
    }

    if (block.type === 'thinking') {
      const thinkingContinued = thinkingContinuedAfterIndex.get(index) ?? false;
      const blockIsStreaming = isStreaming && !thinkingContinued;
      items.push({
        kind: 'trace',
        key: `thinking-${index}`,
        node: (
          <ThinkingBlock
            thinking={block.thinking}
            label={block.label}
            summaries={block.summaries}
            isStreaming={blockIsStreaming}
          />
        ),
      });
      return;
    }

    if (block.type === 'error') {
      const blockProvider = parseByokProvider(block.provider);
      const errorPayload =
        typeof block.status === 'number' || typeof block.errorType === 'string'
          ? {
              error: block.error,
              status: block.status,
              type: block.errorType,
            }
          : block.error;
      const presentation = getChatApiErrorPresentation(errorPayload, {
        billingSource: block.billingSource,
        llmProvider: blockProvider ?? llmProvider,
        threadModel,
      });
      items.push({
        kind: 'other',
        key: `error-${index}`,
        node: presentation.kind === 'provider_auth_action' ? (
          <ChatApiErrorNotice presentation={presentation} />
        ) : (
          <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium">{block.title || presentation.title || 'Error'}</div>
              <div className="mt-1 break-words text-destructive/90">{presentation.message}</div>
            </div>
          </div>
        ),
      });
      return;
    }

    if (block.type === 'tool_use') {
      const results = toolResultsById.get(block.id) ?? [];
      const latestResult = results[results.length - 1];
      const isTaskTool = isSubAgentTool(block.name);
      const skillSheet = skillSheets?.get(block.id);
      const agentContinued = agentContinuedAfterIndex.get(index) ?? false;
      items.push({
        kind: 'trace',
        key: `tool-${block.id || index}`,
        node: (
          <ToolCall
            tool={block}
            result={latestResult}
            results={isTaskTool ? results : undefined}
            callIdentity={`${messageId ?? 'message'}:tool:${block.id || index}`}
            isStreaming={isStreaming}
            skillSheet={skillSheet}
            agentContinued={agentContinued}
          />
        ),
      });
      return;
    }

    if (block.type === 'tool_result') {
      if (toolUseIds.has(block.tool_use_id)) return;
      items.push({
        kind: 'trace',
        key: `result-${block.tool_use_id || index}`,
        node: (
          <ToolCall
            result={block}
            callIdentity={`${messageId ?? 'message'}:result:${block.tool_use_id || index}`}
            isStreaming={isStreaming}
          />
        ),
      });
      return;
    }

    if (block.type === 'teammate_message') {
      items.push({
        kind: 'trace',
        key: `teammate-${index}`,
        node: (
          <TeammateMessage
            teammateId={block.teammateId}
            content={block.content}
          />
        ),
      });
      return;
    }

    if (block.type === 'task_notification') {
      items.push({
        kind: 'trace',
        key: `task-notification-${index}`,
        node: (
          <TaskNotification
            taskId={block.taskId}
            outputFile={block.outputFile}
            status={block.status}
            summary={block.summary}
          />
        ),
      });
    }
  });

  const sections: ReactNode[] = [];
  let traceGroup: ReactNode[] = [];
  let traceGroupKey = '';

  items.forEach((item, index) => {
    if (item.kind === 'trace') {
      if (!traceGroup.length) traceGroupKey = `trace-${item.key}-${index}`;
      traceGroup.push(<div key={item.key}>{item.node}</div>);
      return;
    }

    if (traceGroup.length) {
      sections.push(
        <div key={traceGroupKey} className="space-y-1">
          {traceGroup}
        </div>
      );
      traceGroup = [];
    }

    sections.push(
      <div key={item.key}>{item.node}</div>
    );
  });

  if (traceGroup.length) {
    sections.push(
      <div key={traceGroupKey || 'trace-final'} className="space-y-1">
        {traceGroup}
      </div>
    );
  }

  return <div className="space-y-4">{sections}</div>;
}

interface MessageBubbleProps {
  message: Message;
  onCopy: (id: string, content: string) => void;
  copiedId: string | null;
  onFork?: (id: string, renderedId?: string) => void;
  forkingId?: string | null;
  /** Whether to show the streaming loading indicator (only true for the last streaming message) */
  showStreamingIndicator?: boolean;
  /** Keep the message in "running" visual state and hide finalized actions (used during compaction). */
  suppressFinalizedState?: boolean;
  /** Whether this message owns the visible action row for its turn. */
  showActionRow?: boolean;
  /** Optional copied text when the action row represents multiple message chunks. */
  actionCopyContent?: string;
  /** Optional hover/focus classes supplied by a parent turn group. */
  actionHoverClassName?: string;
  /** Which subset of a message's content blocks should be rendered. */
  renderMode?: MessageRenderMode;
  skillSheets?: Map<string, string>;
  mentionSlugMap?: Map<string, AtMentionEntity>;
  llmProvider?: LlmProvider | null;
  messageTimeZone?: string;
  threadModel?: LlmModel | null;
}

function getMessageToolUseIds(message: Message): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter((block): block is ToolUseBlock => block.type === 'tool_use' && Boolean(block.id))
    .map((block) => block.id);
}

function messageSkillSheetsEqual(
  message: Message,
  previous?: Map<string, string>,
  next?: Map<string, string>,
): boolean {
  if (previous === next) return true;
  const toolUseIds = getMessageToolUseIds(message);
  if (toolUseIds.length === 0) return true;
  return toolUseIds.every((id) => previous?.get(id) === next?.get(id));
}

function MessageBubbleBase({
  message,
  onCopy,
  copiedId,
  onFork,
  forkingId = null,
  showStreamingIndicator = false,
  suppressFinalizedState = false,
  showActionRow = true,
  actionCopyContent,
  actionHoverClassName = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100",
  renderMode = "full",
  skillSheets,
  mentionSlugMap,
  llmProvider,
  messageTimeZone,
  threadModel,
}: MessageBubbleProps) {
  const { currentWorkspace } = useAuthData();
  const workspaceId = currentWorkspace?.id;

  if (message.isMeta || message.sourceToolUseID) {
    return null;
  }

  // Compact summaries get their own distinct rendering
  if (message.isCompactSummary) {
    return <CompactSummaryCard content={message.content} workspaceId={workspaceId} />;
  }

  const displayContent = filterContentForRenderMode(message.content, renderMode);

  if (message.role === 'assistant' && isStoppedByUserStatusMessage(displayContent)) {
    return (
      <div className="flex justify-start">
        <span className="text-sm italic text-muted-foreground/70">
          {STOPPED_BY_USER_TEXT}
        </span>
      </div>
    );
  }

  // ── Special user-role messages with distinct rendering ──

  if (message.role === 'user') {
    // "[Request interrupted by user]" → grey italic "Stopped by user"
    if (isInterruptMessage(displayContent)) {
      return (
        <div className="flex justify-end">
          <span className="text-sm italic text-muted-foreground/70">
            {STOPPED_BY_USER_TEXT}
          </span>
        </div>
      );
    }

    // Slash commands (e.g. /compact) → monospaced, outside bubble
    const slashCmd = parseSlashCommand(displayContent);
    if (slashCmd) {
      return (
        <div className="flex justify-end">
          <span className="text-foreground text-sm font-mono">{slashCmd}</span>
        </div>
      );
    }

    // <local-command-stdout> → assistant-side grey italic text
    const localStdout = parseLocalCommandStdout(displayContent);
    if (localStdout) {
      return (
        <div className="flex justify-start">
          <span className="text-muted-foreground text-sm italic">{localStdout}</span>
        </div>
      );
    }
  }

  // Hide messages that are entirely system messages (no visible content after stripping)
  // For assistant streaming turns, allow an empty-content bubble to render
  // so loading dots stay visible before the first content block arrives.
  if (!hasVisibleContent(displayContent) && !(message.role === 'assistant' && showStreamingIndicator)) {
    return null;
  }

  const isCopied = copiedId === message.id;
  const forkTargetId = message.forkEntryId || message.id;
  const isForking = forkingId === message.id || forkingId === forkTargetId;
  const isStreaming = (message.isStreaming ?? false) || suppressFinalizedState;
  const messageTime =
    message.created_at > 0 && !(message.role === 'assistant' && isStreaming)
      ? formatMessageTime(message.created_at, messageTimeZone)
      : null;
  const actionVisibilityClassName = cn(
    "transition-opacity",
    actionHoverClassName,
  );
  const hasContent = typeof displayContent === 'string'
    ? displayContent.length > 0
    : displayContent.length > 0;

  if (message.role === 'user') {
    // Structured render metadata is authoritative; the model-prefix parser is
    // retained for old/backfilled rows and always cleans model-only content.
    const parsed = parseMessageAuthor(displayContent);
    const displayName =
      resolveMessageAuthorDisplayName(message.authorDisplayName, null) ??
      parsed.author?.displayName ??
      null;
    const source =
      (typeof message.messageSource === 'string'
        ? message.messageSource.trim() || null
        : null) ??
      parsed.source ??
      null;
    const userDisplayContent = parsed.content;
    const authorStamp = [displayName, messageTime].filter(Boolean).join(' ');

    const uploadInfo = parseUploadRefsFromContent(userDisplayContent);

    const previewRefs = uploadInfo.refs;
    const cleanedContent = uploadInfo.cleanContent;
    const hasCleanContent = typeof cleanedContent === 'string'
      ? cleanedContent.length > 0
      : cleanedContent.length > 0;
    const channelBrand = getChannelBrand(source);

    return (
      <div className="flex flex-col items-end gap-2">
        {previewRefs.length > 0 && workspaceId && (
          <div className="flex flex-wrap gap-2">
            {previewRefs.map(ref => (
              <FilePreviewChip
                key={ref.mountPath}
                filename={ref.originalName}
                previewUrl={`/api/workspaces/${workspaceId}/uploads/${encodePathSegments(ref.filename)}`}
                previewTarget={{
                  kind: 'file',
                  source: 'upload',
                  workspaceId,
                  path: ref.filename,
                  filename: ref.originalName,
                }}
              />
            ))}
          </div>
        )}
        {hasCleanContent && (
          <div className="max-w-[85%] px-4 py-3 rounded-3xl border border-border bg-muted/30 text-foreground">
            <CollapsibleUserMessage>
              <ContentBlockRenderer
                content={cleanedContent}
                messageId={message.id}
                workspaceId={workspaceId}
                skillSheets={skillSheets}
                mentionSlugMap={mentionSlugMap}
                llmProvider={llmProvider}
                threadModel={threadModel}
              />
            </CollapsibleUserMessage>
          </div>
        )}
        {/* Hover action row */}
        {showActionRow && channelBrand ? (
          <div
            className="flex items-center justify-end gap-1"
            role="group"
            aria-label="Message actions"
          >
            <div
              className={cn(
                "flex items-center gap-0.5 pointer-coarse:gap-1",
                "pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto pointer-coarse:pointer-events-auto",
                actionVisibilityClassName,
              )}
            >
              {authorStamp && (
                <span className="text-muted-foreground text-xs mr-1">
                  {authorStamp}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
                    onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))}
                  >
                    {isCopied ? <Check /> : <Copy />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isCopied ? 'Copied!' : 'Copy message'}
                </TooltipContent>
              </Tooltip>
              <span className="text-muted-foreground/60 text-xs mx-1" aria-hidden>
                ·
              </span>
            </div>
            <ChannelLogo
              channel={channelBrand.kind}
              tooltip={`Sent via ${channelBrand.label}`}
            />
          </div>
        ) : showActionRow ? (
          <div
            className={cn("flex items-center gap-0.5 pointer-coarse:gap-1", actionVisibilityClassName)}
            role="group"
            aria-label="Message actions"
          >
            {authorStamp && (
              <span className="text-muted-foreground text-xs mr-1">
                {authorStamp}
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
                  onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(cleanedContent))}
                >
                  {isCopied ? <Check /> : <Copy />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isCopied ? 'Copied!' : 'Copy message'}
              </TooltipContent>
            </Tooltip>
          </div>
        ) : null}
      </div>
    );
  }

  // Assistant message
  return (
    <div className="flex flex-col gap-1">
      {hasContent && (
        <div className="max-w-none space-y-4">
          <ContentBlockRenderer
            content={displayContent}
            messageId={message.id}
            isStreaming={isStreaming}
            workspaceId={workspaceId}
            skillSheets={skillSheets}
            mentionSlugMap={mentionSlugMap}
            llmProvider={llmProvider}
            threadModel={threadModel}
          />
        </div>
      )}
      {/* Hover action row */}
      {hasContent && !isStreaming && showActionRow && (
        <div
          className={cn("flex items-center gap-0.5 pointer-coarse:gap-1", actionVisibilityClassName)}
          role="group"
          aria-label="Message actions"
        >
          {messageTime && (
            <span className="text-muted-foreground text-xs mr-1">
              {messageTime}
            </span>
          )}
          {onFork && !isStreaming && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
                  disabled={isForking}
                  onClick={() => onFork(forkTargetId, message.id)}
                >
                  <GitFork />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {isForking ? 'Starting new thread...' : 'New thread from here'}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground pointer-coarse:size-9 pointer-coarse:[&_svg:not([class*='size-'])]:size-4"
                onClick={() => onCopy(message.id, actionCopyContent ?? contentToString(displayContent))}
              >
                {isCopied ? <Check /> : <Copy />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isCopied ? 'Copied!' : 'Copy message'}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
      {showStreamingIndicator && <LoadingDots />}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleBase, (prev, next) => {
  const wasCopied = prev.copiedId === prev.message.id;
  const isCopied = next.copiedId === next.message.id;
  const previousForkTargetId = prev.message.forkEntryId || prev.message.id;
  const nextForkTargetId = next.message.forkEntryId || next.message.id;
  const wasForking =
    prev.forkingId === prev.message.id || prev.forkingId === previousForkTargetId;
  const isForking =
    next.forkingId === next.message.id || next.forkingId === nextForkTargetId;

  return (
    prev.message === next.message &&
    prev.onCopy === next.onCopy &&
    prev.onFork === next.onFork &&
    wasCopied === isCopied &&
    wasForking === isForking &&
    prev.showStreamingIndicator === next.showStreamingIndicator &&
    prev.suppressFinalizedState === next.suppressFinalizedState &&
    prev.showActionRow === next.showActionRow &&
    prev.actionCopyContent === next.actionCopyContent &&
    prev.actionHoverClassName === next.actionHoverClassName &&
    prev.messageTimeZone === next.messageTimeZone &&
    prev.renderMode === next.renderMode &&
    prev.mentionSlugMap === next.mentionSlugMap &&
    prev.llmProvider === next.llmProvider &&
    prev.threadModel === next.threadModel &&
    messageSkillSheetsEqual(prev.message, prev.skillSheets, next.skillSheets)
  );
});

MessageBubble.displayName = 'MessageBubble';
