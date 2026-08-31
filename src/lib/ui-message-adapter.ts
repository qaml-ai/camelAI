import type { UIMessage } from 'ai';
import type {
  ContentBlock,
  ErrorBlock,
  LlmProvider,
  Message,
  ToolResultBlock,
} from '../types';
import type { RuntimeCallArtifact } from './runtime-artifacts';
import type { PiErrorData } from './pi-chunk-encoder';
import {
  PI_ERROR_PART_ID,
  PI_TODOS_PART_ID,
  PI_TODOS_TOOL_USE_ID,
  PI_TURN_NOTICE_PART_ID,
  PI_USER_STOP_PART_ID,
  piArtifactsPartId,
} from './pi-chunk-encoder';

/**
 * Boundary adapter between the app's legacy `Message` shape (consumed by the
 * renderer, turn-utils, condensed-transcript) and AI SDK v6 `UIMessage`s owned
 * by ai-chat. `uiMessageToMessage` is the read/render direction;
 * `messageToUiMessage` is the durable-backfill direction (pi_core rows → ai-chat
 * render history). Both are pure and deterministic.
 */

type UiPart = UIMessage['parts'][number];

type ToolUiPart = Extract<UiPart, { toolCallId: string }> & {
  type: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  callProviderMetadata?: Record<string, Record<string, unknown>>;
};

type ReasoningKind = 'plan' | 'reasoning' | 'reasoningSummary';

function piMetadata(
  metadata: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  const pi = metadata?.pi;
  return pi && typeof pi === 'object' ? pi : undefined;
}

function reasoningItemKind(kind: unknown): string {
  return kind === 'plan' ? 'plan' : 'reasoning';
}

function reasoningLabel(kind: unknown): string {
  return kind === 'plan' ? 'Plan' : 'Thinking';
}

function isToolPart(part: UiPart): part is ToolUiPart {
  return (
    (part.type.startsWith('tool-') || part.type === 'dynamic-tool') &&
    'toolCallId' in part
  );
}

function toolNameFromPart(part: ToolUiPart): string {
  if (typeof part.toolName === 'string' && part.toolName) return part.toolName;
  if (part.type.startsWith('tool-')) return part.type.slice('tool-'.length);
  return 'tool';
}

function hasContent(content: string | ContentBlock[]): boolean {
  return content.length > 0;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function normalizedMetadataString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/**
 * Creation time (ms since epoch) recoverable from a UIMessage's metadata:
 * the backfill stamp (`pi.createdAtMs`, written by messageToUiMessage from the
 * source row's created_at), then the live turn-end stamp (`pi.completedAtMs`),
 * then the legacy pi_core message key. Undefined when the message predates all
 * three (early-migration rows) — callers decide the last-resort fallback.
 */
export function uiMessageCreatedAtMs(ui: UIMessage): number | undefined {
  const metadata = ui.metadata as
    | {
        pi?: { createdAtMs?: unknown; completedAtMs?: unknown };
        piCoreMessageKey?: unknown;
      }
    | undefined;
  const createdAt = positiveFiniteNumber(metadata?.pi?.createdAtMs);
  if (createdAt !== undefined) return createdAt;
  const completedAt = positiveFiniteNumber(metadata?.pi?.completedAtMs);
  if (completedAt !== undefined) return completedAt;
  const piCoreKey = metadata?.piCoreMessageKey;
  if (typeof piCoreKey === 'string') {
    const parsed = positiveFiniteNumber(Number(piCoreKey));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Cheap, content-sensitive signature for a single render-history message. Unlike
 * an id-only comparison this changes when a message's *contents* change under the
 * same id — a missed stream completion persisted onto the same assistant id (more
 * parts, a text part grown longer, a tool part that gained output/error) or
 * updated turn metadata (`pi.completedAtMs` stamped, `pi.forkEntryId` set). Used
 * to decide whether a re-delivered loader payload is genuinely already applied.
 */
export function uiMessageContentSignature(ui: UIMessage): string {
  let partsSig = '';
  for (const rawPart of ui.parts) {
    const part = rawPart as {
      type: string;
      text?: unknown;
      state?: unknown;
      output?: unknown;
      errorText?: unknown;
    };
    partsSig += part.type;
    if (typeof part.text === 'string') partsSig += `#${part.text.length}`;
    if (typeof part.state === 'string') partsSig += `@${part.state}`;
    if (part.output !== undefined) partsSig += '+o';
    if (part.errorText) partsSig += '+e';
    partsSig += ';';
  }
  const meta = ui.metadata as
    | {
        pi?: { completedAtMs?: unknown; forkEntryId?: unknown };
        authorDisplayName?: unknown;
        source?: unknown;
      }
    | undefined;
  const completedAtMs =
    typeof meta?.pi?.completedAtMs === 'number' ? meta.pi.completedAtMs : '';
  const forkEntryId = meta?.pi?.forkEntryId ? '1' : '0';
  const attribution = JSON.stringify([
    normalizedMetadataString(meta?.authorDisplayName) ?? '',
    normalizedMetadataString(meta?.source) ?? '',
  ]);
  return `${ui.id}|${ui.role}|${ui.parts.length}|${partsSig}|${completedAtMs}|${forkEntryId}|${attribution}`;
}

/**
 * Content-aware equality for two render-history lists. Returns false when any
 * message's `uiMessageContentSignature` differs, so callers reconcile a payload
 * that reuses the same ids but carries changed parts/metadata (an id-only check
 * would treat that as already-applied and keep a stale transcript).
 */
export function uiMessagesEquivalent(
  left: UIMessage[],
  right: UIMessage[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      uiMessageContentSignature(left[index]) !==
      uiMessageContentSignature(right[index])
    ) {
      return false;
    }
  }
  return true;
}

/** UIMessage (ai-chat render history) → legacy Message consumed by the renderer. */
export function uiMessageToMessage(
  ui: UIMessage,
  context: { threadId?: string; createdAt?: number } = {},
): Message {
  const blocks: ContentBlock[] = [];

  // Code-mode artifacts ride standalone data parts that can arrive after the
  // tool's item/completed; collect them up front so their tool_result carries
  // them regardless of wire order.
  const artifactsByToolCallId = new Map<string, RuntimeCallArtifact[]>();
  for (const part of ui.parts) {
    if (part.type !== 'data-pi-artifacts') continue;
    const data = (part as { data?: { toolCallId?: unknown; artifacts?: unknown } }).data ?? {};
    if (typeof data.toolCallId === 'string' && Array.isArray(data.artifacts)) {
      artifactsByToolCallId.set(data.toolCallId, data.artifacts as RuntimeCallArtifact[]);
    }
  }

  for (const part of ui.parts) {
    switch (part.type) {
      case 'step-start':
        break;
      case 'text': {
        blocks.push({ type: 'text', text: part.text });
        break;
      }
      case 'reasoning': {
        const pi = piMetadata(part.providerMetadata as never);
        const kind = pi?.kind as ReasoningKind | undefined;
        const block: ContentBlock = {
          type: 'thinking',
          thinking: part.text,
          itemKind: reasoningItemKind(kind),
          label: reasoningLabel(kind),
          summaries: [],
        };
        if (pi && typeof pi.itemId === 'string') block.itemId = pi.itemId;
        blocks.push(block);
        break;
      }
      case 'data-pi-todos': {
        const data = (part as { data?: { explanation?: unknown; todos?: unknown } }).data ?? {};
        blocks.push({
          type: 'tool_use',
          id: PI_TODOS_TOOL_USE_ID,
          name: 'TodoWrite',
          input: {
            explanation: typeof data.explanation === 'string' ? data.explanation : undefined,
            todos: Array.isArray(data.todos) ? data.todos : [],
          },
          itemKind: 'turnPlan',
        });
        break;
      }
      case 'data-pi-user-stop': {
        const data = (part as { data?: { text?: unknown } }).data ?? {};
        blocks.push({
          type: 'text',
          text: typeof data.text === 'string' ? data.text : '',
          itemKind: 'userStop',
        });
        break;
      }
      case 'data-pi-turn-notice': {
        // System-authored note about the turn (e.g. the salvage note). Renders as
        // ordinary text; the itemKind keeps it distinguishable from model output.
        const data = (part as { data?: { text?: unknown } }).data ?? {};
        blocks.push({
          type: 'text',
          text: typeof data.text === 'string' ? data.text : '',
          itemKind: 'turnNotice',
        });
        break;
      }
      case 'data-pi-error': {
        const data = (part as { data?: Partial<PiErrorData> }).data ?? {};
        const block: ErrorBlock = {
          type: 'error',
          error: typeof data.error === 'string' ? data.error : '',
        };
        if (data.billingSource === 'byok' || data.billingSource === 'hosted') {
          block.billingSource = data.billingSource;
        }
        if (typeof data.status === 'number') block.status = data.status;
        if (typeof data.errorType === 'string') block.errorType = data.errorType;
        if (typeof data.provider === 'string' && data.provider) {
          block.provider = data.provider as LlmProvider;
        }
        blocks.push(block);
        break;
      }
      default: {
        if (isToolPart(part)) {
          appendToolBlocks(blocks, part, artifactsByToolCallId);
        }
        // Transient (data-pi-tool-stream), data-pi-artifacts (folded onto the
        // tool_result above), data-pi-steer-marker (a render-order seam consumed
        // before adaptation), and unknown parts are not emitted as blocks.
        break;
      }
    }
  }

  const message: Message = {
    id: ui.id,
    thread_id: context.threadId ?? '',
    role: ui.role === 'assistant' ? 'assistant' : 'user',
    content: blocks,
    // Message.created_at is required, so 0 remains the last-resort sentinel; it
    // is only reachable for rows written before both the backfill createdAtMs
    // stamp and the turn-end completedAtMs metadata existed.
    created_at: context.createdAt ?? uiMessageCreatedAtMs(ui) ?? 0,
  };

  const pi = piMetadata(ui.metadata as never);
  const forkEntryId = pi?.forkEntryId;
  if (typeof forkEntryId === 'string' && forkEntryId) {
    message.forkEntryId = forkEntryId;
  }
  if (typeof pi?.turnDurationMs === 'number') {
    message.turnDurationMs = pi.turnDurationMs;
  }
  if (typeof pi?.completedAtMs === 'number') {
    message.completedAtMs = pi.completedAtMs;
  }
  const metadata = ui.metadata as
    | {
        sentDuringStreaming?: unknown;
        authorDisplayName?: unknown;
        source?: unknown;
      }
    | undefined;
  if (metadata?.sentDuringStreaming === true) {
    message.sentDuringStreaming = true;
  }
  const authorDisplayName = normalizedMetadataString(
    metadata?.authorDisplayName,
  );
  if (authorDisplayName) message.authorDisplayName = authorDisplayName;
  const messageSource = normalizedMetadataString(metadata?.source);
  if (messageSource) message.messageSource = messageSource;

  return message;
}

function appendToolBlocks(
  blocks: ContentBlock[],
  part: ToolUiPart,
  artifactsByToolCallId: Map<string, RuntimeCallArtifact[]>,
): void {
  const toolCallId = part.toolCallId;
  const name = toolNameFromPart(part);
  const itemKind = piMetadata(part.callProviderMetadata)?.itemKind;
  const input =
    part.input && typeof part.input === 'object' && !Array.isArray(part.input)
      ? { ...(part.input as Record<string, unknown>) }
      : {};
  const state = (part as { state?: string }).state;

  const output =
    state === 'output-available'
      ? ((part.output ?? {}) as {
          content?: string | ContentBlock[];
          isError?: unknown;
          status?: unknown;
          details?: unknown;
        })
      : undefined;

  // The tool_use input is frozen at input-start; the settled tool status lives on
  // the output. Surface it on the rendered input.status so the block matches the
  // completed/failed tool (legacy upserted input.status at item/completed).
  if (output && typeof output.status === 'string') {
    input.status = output.status;
  }

  const toolUse: ContentBlock = {
    type: 'tool_use',
    id: toolCallId,
    name,
    input,
  };
  if (typeof itemKind === 'string') toolUse.itemKind = itemKind;
  blocks.push(toolUse);

  const artifacts = artifactsByToolCallId.get(toolCallId);
  if (output) {
    const content = output.content ?? '';
    const isError = output.isError === true;
    if (hasContent(content) || isError || (artifacts && artifacts.length > 0)) {
      blocks.push(toolResultBlock(toolCallId, content, isError, itemKind, artifacts, output.details));
    }
  } else if (state === 'output-error') {
    blocks.push(
      toolResultBlock(toolCallId, part.errorText ?? '', true, itemKind, artifacts),
    );
  }
}

function toolResultBlock(
  toolCallId: string,
  content: string | ContentBlock[],
  isError: boolean,
  itemKind: unknown,
  artifacts?: RuntimeCallArtifact[],
  details?: unknown,
): ToolResultBlock {
  const block: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content,
    ...(isError
      ? { is_error: true, status: 'failed' as const }
      : { status: 'succeeded' as const }),
    itemId: toolCallId,
  };
  if (typeof itemKind === 'string') block.itemKind = itemKind;
  if (artifacts && artifacts.length > 0) block.artifacts = artifacts;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    block.details = details as Record<string, unknown>;
  }
  return block;
}

/** Legacy Message → UIMessage for durable ai-chat backfill. Deterministic ids. */
export function messageToUiMessage(message: Message): UIMessage {
  const id = message.forkEntryId || message.id;
  const parts: UiPart[] = [];

  if (typeof message.content === 'string') {
    if (message.content) {
      parts.push({ type: 'text', text: message.content, state: 'done' });
    }
  } else {
    const resultsByToolUseId = new Map<string, ToolResultBlock>();
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        resultsByToolUseId.set(block.tool_use_id, block);
      }
    }
    const consumedResults = new Set<string>();

    for (const block of message.content) {
      switch (block.type) {
        case 'text': {
          if (block.itemKind === 'userStop') {
            parts.push({
              type: 'data-pi-user-stop',
              id: PI_USER_STOP_PART_ID,
              data: { text: block.text },
            } as UiPart);
          } else if (block.itemKind === 'turnNotice') {
            parts.push({
              type: 'data-pi-turn-notice',
              id: PI_TURN_NOTICE_PART_ID,
              data: { text: block.text },
            } as UiPart);
          } else {
            parts.push({ type: 'text', text: block.text, state: 'done' });
          }
          break;
        }
        case 'thinking': {
          const kind = block.itemKind === 'plan' ? 'plan' : 'reasoning';
          const text = block.thinking || (block.summaries ?? []).join('\n\n');
          const pi: Record<string, unknown> = { kind };
          if (block.itemId) pi.itemId = block.itemId;
          parts.push({
            type: 'reasoning',
            text,
            state: 'done',
            providerMetadata: { pi } as never,
          });
          break;
        }
        case 'redacted_thinking': {
          parts.push({ type: 'reasoning', text: '', state: 'done' });
          break;
        }
        case 'tool_use': {
          if (block.itemKind === 'turnPlan' || block.id === PI_TODOS_TOOL_USE_ID) {
            const input = block.input as { explanation?: unknown; todos?: unknown };
            parts.push({
              type: 'data-pi-todos',
              id: PI_TODOS_PART_ID,
              data: {
                explanation: typeof input?.explanation === 'string' ? input.explanation : undefined,
                todos: Array.isArray(input?.todos) ? input.todos : [],
              },
            } as UiPart);
            break;
          }
          const result = resultsByToolUseId.get(block.id);
          if (result) consumedResults.add(block.id);
          parts.push(toolUiPart(block, result));
          // Code-mode artifacts on the persisted tool_result ride a standalone
          // data part so a backfilled message renders them the same as a live one.
          if (result?.artifacts && result.artifacts.length > 0) {
            parts.push({
              type: 'data-pi-artifacts',
              id: piArtifactsPartId(block.id),
              data: { toolCallId: block.id, artifacts: result.artifacts },
            } as UiPart);
          }
          break;
        }
        case 'tool_result': {
          // Merged into its tool_use above; a lone result has no tool part to attach to.
          if (!consumedResults.has(block.tool_use_id)) {
            consumedResults.add(block.tool_use_id);
          }
          break;
        }
        case 'error': {
          // Round-trip the structured error as a durable data part (not lossy
          // plain text) so a backfilled thread renders the same inline error
          // block, with billing/status metadata intact.
          const data: PiErrorData = {
            id: `${message.id}:error`,
            error: block.error,
            billingSource: block.billingSource ?? null,
            provider: block.provider ?? null,
            status: typeof block.status === 'number' ? block.status : null,
            errorType: block.errorType ?? null,
          };
          parts.push({
            type: 'data-pi-error',
            id: PI_ERROR_PART_ID,
            data,
          } as UiPart);
          break;
        }
        case 'teammate_message': {
          parts.push({ type: 'text', text: block.content, state: 'done' });
          break;
        }
        case 'task_notification': {
          parts.push({ type: 'text', text: block.summary, state: 'done' });
          break;
        }
      }
    }
  }

  const uiMessage: UIMessage = {
    id,
    role: message.role,
    parts,
  };
  const pi: Record<string, unknown> = {};
  if (message.forkEntryId) pi.forkEntryId = message.forkEntryId;
  // Stamp the source row's creation time so the read direction can restore it
  // (uiMessageCreatedAtMs); without it a backfilled message renders epoch 0.
  const createdAtMs = positiveFiniteNumber(message.created_at);
  if (createdAtMs !== undefined) pi.createdAtMs = createdAtMs;
  const metadata: Record<string, unknown> = {};
  if (Object.keys(pi).length > 0) metadata.pi = pi;
  if (message.role === 'user' && message.sentDuringStreaming === true) {
    metadata.sentDuringStreaming = true;
  }
  const authorDisplayName = normalizedMetadataString(message.authorDisplayName);
  if (authorDisplayName) metadata.authorDisplayName = authorDisplayName;
  const messageSource = normalizedMetadataString(message.messageSource);
  if (messageSource) metadata.source = messageSource;
  if (Object.keys(metadata).length > 0) {
    uiMessage.metadata = metadata;
  }
  return uiMessage;
}

function toolUiPart(
  block: Extract<ContentBlock, { type: 'tool_use' }>,
  result: ToolResultBlock | undefined,
): UiPart {
  const callProviderMetadata = block.itemKind
    ? { pi: { itemKind: block.itemKind } }
    : undefined;

  if (result) {
    const isError = result.is_error === true || result.status === 'failed';
    return {
      type: `tool-${block.name}`,
      toolCallId: block.id,
      toolName: block.name,
      state: 'output-available',
      input: block.input,
      // No output.status: the result's succeeded/failed enum is recovered from
      // is_error on read, and the pi status already rides the tool_use input.
      output: {
        content: result.content,
        isError,
        ...(result.details ? { details: result.details } : {}),
      },
      ...(callProviderMetadata ? { callProviderMetadata } : {}),
    } as UiPart;
  }

  return {
    type: `tool-${block.name}`,
    toolCallId: block.id,
    toolName: block.name,
    state: 'input-available',
    input: block.input,
    ...(callProviderMetadata ? { callProviderMetadata } : {}),
  } as UiPart;
}
