import type { ProviderMetadata } from 'ai';
import type { ContentBlock } from '../types';
import type { ChatAgentTerminalError } from './chat-agent-state';
import type { RuntimeCallArtifact } from './runtime-artifacts';
import {
  buildPiTodos,
  buildToolResultFromPiItem,
  buildToolUseFromPiItem,
  isFailedRuntimeItem,
  type PiThreadItem,
  type PiTodoItem,
} from './pi-tool-builders';

// Mirrors the server-side overlay bound (chat-thread-do.ts). Kept local so the
// encoder can bound single-shot payloads (tool output, restored item text,
// streamed tool output) before they land in a chunk row — the live overlay
// helper lives in the DO, not a shared module. Exported (with boundBlockText)
// so the client's live tool-output accumulator (use-pi-chat-stream) applies the
// same tail bound to the string it grows across deltas.
export const MAX_LIVE_OVERLAY_BLOCK_CHARS = 128_000;
const LIVE_OVERLAY_TRUNCATION_MARKER =
  '…[earlier output truncated — full output available on reload]…\n';

export function boundBlockText(text: string): string {
  if (text.length <= MAX_LIVE_OVERLAY_BLOCK_CHARS) return text;
  const tailLength = MAX_LIVE_OVERLAY_BLOCK_CHARS - LIVE_OVERLAY_TRUNCATION_MARKER.length;
  return LIVE_OVERLAY_TRUNCATION_MARKER + text.slice(text.length - tailLength);
}

function boundBlockContent(content: string | ContentBlock[]): string | ContentBlock[] {
  return typeof content === 'string' ? boundBlockText(content) : content;
}

function boundToolDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    (key === 'diff' || key === 'patch') && typeof value === 'string'
      ? boundBlockText(value)
      : value,
  ]));
}

export type PiRuntimeEvent = {
  method: string;
  params?: Record<string, unknown>;
};

export interface PiMessageMetadata {
  pi: {
    forkEntryId?: string;
    turnDurationMs?: number;
    completedAtMs?: number;
    usage?: unknown;
    sdkTurnCount?: number;
  };
}

export interface PiToolOutput {
  content: string | ContentBlock[];
  isError: boolean;
  details?: Record<string, unknown>;
  status?: string;
  durationMs?: number;
}

export interface PiTodosData {
  explanation?: string;
  todos: PiTodoItem[];
}

export interface PiUserStopData {
  text: string;
}

/**
 * A system-authored note about the TURN rather than model output (today: the
 * recovery ladder's salvage note). It rides a data part, not text, for the same
 * reason `userStop` does — and for one more: when a recovery CONTINUES an
 * orphan-persisted partial, ai-chat drops the encoder's `text-start` and appends
 * the following deltas to the partial's still-`streaming` text part, which would
 * splice the note onto the tail of a half-written sentence. A data part is always
 * its own part.
 */
export interface PiTurnNoticeData {
  text: string;
}

export interface PiSteerMarkerData {
  steerMessageId: string;
  acceptedAtMs: number;
}

export interface PiToolStreamData {
  toolCallId: string;
  text: string;
  /**
   * Per-tool monotonically increasing delta counter. useAgentChat can deliver
   * the same broadcast chunk to `onData` more than once (raw handler + useChat
   * path) and a reconnect replays the whole buffered stream, so the client's
   * accumulator applies a delta only when `seq` advances past its per-tool
   * cursor.
   */
  seq: number;
}

export interface PiArtifactsData {
  toolCallId: string;
  artifacts: RuntimeCallArtifact[];
}

/**
 * Transient liveness ping for ai-chat's inter-chunk stall watchdog
 * (`chatStreamStallTimeoutMs` resets on ANY chunk reaching the reply stream).
 * Written by the DO — not this encoder — whenever the Pi turn shows genuine
 * progress that maps to zero content chunks: a harness tool still executing
 * (30s cadence) or a runtime event the encoder deliberately drops. Transient,
 * so it never lands in message parts (server builder and browser reducer both
 * skip transient data parts) and never credits recovery progress.
 */
export interface PiHeartbeatData {
  at: number;
}

/**
 * Durable terminal-error metadata carried on a non-transient `data-pi-error`
 * part. The native `error` chunk is broadcast-only, so this part is what keeps a
 * terminal error (with the billing/status metadata the composer recovery needs)
 * in ai-chat render history across reload/reconnect. Groundwork for retiring the
 * Agent-state `lastError` channel; the adapter renders it as an inline error
 * block. Same wire shape as the Agent-state channel (both derive from
 * `ErrorBlock` — see chat-agent-state.ts).
 */
export type PiErrorData = ChatAgentTerminalError;

export type PiUiMessageChunk =
  | { type: 'start'; messageId: string }
  | { type: 'start-step' }
  | { type: 'text-start' }
  | { type: 'text-delta'; delta: string }
  | { type: 'text-end' }
  | { type: 'reasoning-start'; providerMetadata?: ProviderMetadata }
  | { type: 'reasoning-delta'; delta: string; providerMetadata?: ProviderMetadata }
  | { type: 'reasoning-end'; providerMetadata?: ProviderMetadata }
  | {
      type: 'tool-input-start';
      toolCallId: string;
      toolName: string;
      providerMetadata?: ProviderMetadata;
    }
  // Dual-encoded input: the server-side builder (agents' applyChunkToParts)
  // reads the structured `input`, while the browser reducer (ai's
  // processUIMessageStream) accumulates `inputTextDelta` text and parses it —
  // without it the live tool card's input stays undefined until completion.
  | {
      type: 'tool-input-delta';
      toolCallId: string;
      input: Record<string, unknown>;
      inputTextDelta: string;
    }
  | {
      type: 'tool-input-available';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      providerMetadata?: ProviderMetadata;
    }
  | { type: 'tool-output-available'; toolCallId: string; output: PiToolOutput }
  | { type: 'data-pi-todos'; id: string; data: PiTodosData }
  | { type: 'data-pi-user-stop'; id: string; data: PiUserStopData }
  | { type: 'data-pi-turn-notice'; id: string; data: PiTurnNoticeData }
  | { type: 'data-pi-steer-marker'; id: string; data: PiSteerMarkerData }
  | { type: 'data-pi-artifacts'; id: string; data: PiArtifactsData }
  | { type: 'data-pi-tool-stream'; transient: true; data: PiToolStreamData }
  | { type: 'data-pi-heartbeat'; transient: true; data: PiHeartbeatData }
  | { type: 'data-pi-error'; id: string; data: PiErrorData }
  | { type: 'message-metadata'; messageMetadata: PiMessageMetadata }
  | { type: 'finish' }
  | { type: 'error'; errorText: string };

/** Fixed reconciliation id for the single in-turn plan panel. */
export const PI_TODOS_PART_ID = 'turn-plan';
/** Legacy tool_use id the plan panel adapts back to. */
export const PI_TODOS_TOOL_USE_ID = 'turn:plan:todo';
export const PI_USER_STOP_PART_ID = 'user-stop';
/** Fixed reconciliation id for the single turn-notice part per turn. */
export const PI_TURN_NOTICE_PART_ID = 'turn-notice';
export const PI_STEER_MARKER_PART = 'data-pi-steer-marker';
/** Fixed reconciliation id for the single terminal-error part per turn. */
export const PI_ERROR_PART_ID = 'pi-error';

/** Per-steer reconciliation id for the durable ordering seam. */
export function piSteerMarkerPartId(steerMessageId: string): string {
  return `pi:steer:${steerMessageId}`;
}

/**
 * Per-tool reconciliation id for the code-mode artifacts data part. Code-mode
 * (js_exec) artifacts are recorded mid-tool, sometimes after item/completed, so
 * they ride a standalone `data-pi-artifacts` part reconciled by this id (full
 * accumulated set each time) rather than being merged into the tool part on the
 * wire; `uiMessageToMessage` folds them onto the tool_result at read time.
 */
export function piArtifactsPartId(toolCallId: string): string {
  return `pi-artifacts:${toolCallId}`;
}

type OpenTextPart = { key: string } | null;
type OpenReasoningPart = {
  key: string;
  providerMetadata: ProviderMetadata;
} | null;

function isPiThreadItem(item: unknown): item is PiThreadItem {
  return Boolean(
    item &&
      typeof item === 'object' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { type?: unknown }).type === 'string',
  );
}

function reasoningContentText(item: PiThreadItem): string {
  return Array.isArray(item.content)
    ? item.content.filter((value): value is string => typeof value === 'string').join('')
    : '';
}

function reasoningKey(itemId: string, contentIndex = 0): string {
  return `${itemId}:content:${contentIndex}`;
}

/**
 * Stateful, last-part-oriented encoder from Pi runtime events to AI SDK v6
 * UIMessage chunks. The downstream builder (`applyChunkToParts`) appends
 * `text-delta`/`reasoning-delta` to the *last* text/reasoning part and ignores
 * chunk ids — but it tracks the two kinds INDEPENDENTLY, so one text part and
 * one reasoning part can stream concurrently. The encoder therefore keeps one
 * open slot per kind: a fast model that interleaves reasoning and text deltas
 * (self-hosted models flush both channels together) accumulates into two
 * coherent parts instead of fragmenting into alternating slivers. Within a
 * kind the builder is append-to-last, so a DIFFERENT item of the same kind
 * still closes and reopens; genuine sequence breaks (a tool item, the plan
 * panel's creation, user-stop, turn completion) close both slots so the parts
 * array keeps arrival order around them.
 *
 * Emits `start`/`start-step` at the head, `text`/`reasoning`/`tool` chunks per
 * item, transient `data-pi-tool-stream` for output deltas, non-transient
 * `data-pi-todos`/`data-pi-user-stop`/`data-pi-steer-marker`, and
 * `message-metadata` + `finish` on `turn/completed`.
 */
export class PiChunkEncoder {
  private readonly messageId: string;
  private openTextPart: OpenTextPart = null;
  private openReasoningPart: OpenReasoningPart = null;
  private started = false;
  private finished = false;
  private readonly streamedText = new Set<string>();
  private readonly streamedReasoning = new Set<string>();
  // Input known at item/started, kept so item/completed can merge in any fields
  // the runtime only supplies at the end (mirrors the legacy reducer's
  // upsertToolUseBlock started+completed merge — see emitToolInputStarted).
  private readonly toolStartedInput = new Map<string, Record<string, unknown>>();
  private readonly toolStreamSeq = new Map<string, number>();
  private todosCreated = false;

  constructor(options: { messageId: string }) {
    this.messageId = options.messageId;
  }

  /** Emits the stream head: `start {messageId}` + `start-step`. Idempotent. */
  start(): PiUiMessageChunk[] {
    if (this.started) return [];
    this.started = true;
    return [
      { type: 'start', messageId: this.messageId },
      { type: 'start-step' },
    ];
  }

  encode(event: PiRuntimeEvent): PiUiMessageChunk[] {
    const params = event.params ?? {};
    const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;

    switch (event.method) {
      case 'sdk/turn/started':
      case 'sdk/turn/completed':
        return [];

      case 'turn/completed':
        return this.encodeTurnCompleted(params);

      case 'turn/plan/updated':
        return this.encodePlanUpdated(params);

      case 'item/started':
        return isPiThreadItem(params.item) ? this.encodeItemStarted(params.item) : [];

      case 'item/completed':
        return isPiThreadItem(params.item) ? this.encodeItemCompleted(params.item) : [];

      case 'item/agentMessage/delta':
        return this.encodeAgentMessageDelta(params, itemId);

      case 'item/plan/delta':
        if (!itemId || typeof params.delta !== 'string') return [];
        return this.reasoningDelta(itemId, params.delta, {
          pi: { kind: 'plan', itemId },
        });

      case 'item/reasoning/textDelta': {
        if (!itemId || typeof params.delta !== 'string') return [];
        const contentIndex = typeof params.contentIndex === 'number' ? params.contentIndex : 0;
        return this.reasoningDelta(reasoningKey(itemId, contentIndex), params.delta, {
          pi: { kind: 'reasoning', itemId, contentIndex },
        });
      }

      case 'item/reasoning/summaryTextDelta': {
        if (!itemId || typeof params.delta !== 'string') return [];
        const summaryIndex = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
        return this.reasoningDelta(`${itemId}:summary:${summaryIndex}`, params.delta, {
          pi: { kind: 'reasoningSummary', itemId, summaryIndex },
        });
      }

      case 'item/reasoning/summaryPartAdded': {
        if (!itemId) return [];
        const summaryIndex = typeof params.summaryIndex === 'number' ? params.summaryIndex : 0;
        return this.openReasoning(`${itemId}:summary:${summaryIndex}`, {
          pi: { kind: 'reasoningSummary', itemId, summaryIndex },
        });
      }

      case 'command/exec/outputDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        if (!itemId || typeof params.delta !== 'string') return [];
        return this.toolStream(itemId, params.delta);

      case 'item/commandExecution/terminalInteraction':
        if (!itemId || typeof params.input !== 'string') return [];
        return this.toolStream(itemId, `\n> ${params.input}\n`);

      case 'item/mcpToolCall/progress':
        if (!itemId || typeof params.message !== 'string') return [];
        return this.toolStream(itemId, params.message);

      case 'error': {
        const errorText =
          typeof params.errorText === 'string'
            ? params.errorText
            : typeof params.message === 'string'
              ? params.message
              : 'Unknown error';
        return [{ type: 'error', errorText }];
      }

      default:
        return [];
    }
  }

  private encodeTurnCompleted(params: Record<string, unknown>): PiUiMessageChunk[] {
    if (this.finished) return [];
    this.finished = true;
    const chunks = this.closeOpen();
    const pi: PiMessageMetadata['pi'] = {};
    if (typeof params.forkEntryId === 'string' && params.forkEntryId.trim()) {
      pi.forkEntryId = params.forkEntryId.trim();
    }
    if (typeof params.turnDurationMs === 'number') pi.turnDurationMs = params.turnDurationMs;
    if (typeof params.completedAtMs === 'number') pi.completedAtMs = params.completedAtMs;
    if (params.usage != null) pi.usage = params.usage;
    if (typeof params.sdkTurnCount === 'number') pi.sdkTurnCount = params.sdkTurnCount;
    chunks.push({ type: 'message-metadata', messageMetadata: { pi } });
    chunks.push({ type: 'finish' });
    return chunks;
  }

  private encodePlanUpdated(params: Record<string, unknown>): PiUiMessageChunk[] {
    const data: PiTodosData = {
      todos: buildPiTodos(params.plan),
    };
    if (typeof params.explanation === 'string') data.explanation = params.explanation;
    const chunks: PiUiMessageChunk[] = [];
    // Only the first plan update creates the part (and breaks the current text
    // run); later updates reconcile the same id in place without fragmenting text.
    if (!this.todosCreated) {
      chunks.push(...this.closeOpen());
      this.todosCreated = true;
    }
    chunks.push({ type: 'data-pi-todos', id: PI_TODOS_PART_ID, data });
    return chunks;
  }

  /**
   * Insert a durable ordering seam at the stream's current position. Closing
   * both open slots makes every part emitted before acceptance render above the
   * steered user bubble and every later part render below it.
   */
  encodeSteerMarker(
    steerMessageId: string,
    acceptedAtMs: number,
  ): PiUiMessageChunk[] {
    if (this.finished) return [];
    const chunks = this.closeOpen();
    chunks.push({
      type: PI_STEER_MARKER_PART,
      id: piSteerMarkerPartId(steerMessageId),
      data: { steerMessageId, acceptedAtMs },
    });
    return chunks;
  }

  private encodeAgentMessageDelta(
    params: Record<string, unknown>,
    itemId: string | undefined,
  ): PiUiMessageChunk[] {
    if (typeof params.delta !== 'string') return [];
    const itemKind =
      typeof params.itemKind === 'string' && params.itemKind.trim()
        ? params.itemKind.trim()
        : 'agentMessage';
    if (itemKind === 'userStop') {
      const chunks = this.closeOpen();
      chunks.push({
        type: 'data-pi-user-stop',
        id: PI_USER_STOP_PART_ID,
        data: { text: params.delta },
      });
      return chunks;
    }
    if (itemKind === 'turnNotice') {
      const chunks = this.closeOpen();
      chunks.push({
        type: 'data-pi-turn-notice',
        id: PI_TURN_NOTICE_PART_ID,
        data: { text: params.delta },
      });
      return chunks;
    }
    if (!itemId) return [];
    const chunks = this.openText(itemId);
    chunks.push({ type: 'text-delta', delta: params.delta });
    return chunks;
  }

  private encodeItemStarted(item: PiThreadItem): PiUiMessageChunk[] {
    switch (item.type) {
      case 'userMessage':
      case 'hookPrompt':
        return [];
      case 'agentMessage': {
        const chunks = this.openText(item.id);
        if (typeof item.text === 'string' && item.text) {
          chunks.push({ type: 'text-delta', delta: boundBlockText(item.text) });
        }
        return chunks;
      }
      case 'plan': {
        const chunks = this.openReasoning(item.id, { pi: { kind: 'plan', itemId: item.id } });
        if (typeof item.text === 'string' && item.text) {
          // Register as streamed (mirroring openText) so item/completed carrying
          // the same text does not re-emit it. Only on actual emission: a
          // started item without text must still get its text at completion.
          this.streamedReasoning.add(item.id);
          chunks.push({
            type: 'reasoning-delta',
            delta: boundBlockText(item.text),
            providerMetadata: { pi: { kind: 'plan', itemId: item.id } },
          });
        }
        return chunks;
      }
      case 'reasoning': {
        const meta: ProviderMetadata = { pi: { kind: 'reasoning', itemId: item.id, contentIndex: 0 } };
        const key = reasoningKey(item.id);
        const chunks = this.openReasoning(key, meta);
        const text = reasoningContentText(item);
        if (text) {
          // Same started+completed dedupe as the plan branch above.
          this.streamedReasoning.add(key);
          chunks.push({ type: 'reasoning-delta', delta: boundBlockText(text), providerMetadata: meta });
        }
        return chunks;
      }
      default:
        return this.emitToolInputStarted(item);
    }
  }

  private encodeItemCompleted(item: PiThreadItem): PiUiMessageChunk[] {
    switch (item.type) {
      case 'userMessage':
      case 'hookPrompt':
        return [];
      case 'agentMessage': {
        const chunks: PiUiMessageChunk[] = [];
        if (!this.streamedText.has(item.id)) {
          chunks.push(...this.openText(item.id));
          if (typeof item.text === 'string' && item.text) {
            chunks.push({ type: 'text-delta', delta: boundBlockText(item.text) });
          }
        }
        if (this.openTextPart?.key === item.id) {
          chunks.push(...this.closeOpenText());
        }
        return chunks;
      }
      case 'plan': {
        const meta: ProviderMetadata = { pi: { kind: 'plan', itemId: item.id } };
        const chunks: PiUiMessageChunk[] = [];
        if (!this.streamedReasoning.has(item.id)) {
          chunks.push(...this.openReasoning(item.id, meta));
          if (typeof item.text === 'string' && item.text) {
            chunks.push({ type: 'reasoning-delta', delta: boundBlockText(item.text), providerMetadata: meta });
          }
        }
        if (this.openReasoningPart?.key === item.id) {
          chunks.push(...this.closeOpenReasoning());
        }
        return chunks;
      }
      case 'reasoning': {
        const key = reasoningKey(item.id);
        const meta: ProviderMetadata = { pi: { kind: 'reasoning', itemId: item.id, contentIndex: 0 } };
        const chunks: PiUiMessageChunk[] = [];
        if (!this.streamedReasoning.has(key)) {
          chunks.push(...this.openReasoning(key, meta));
          const text = reasoningContentText(item);
          if (text) {
            chunks.push({ type: 'reasoning-delta', delta: boundBlockText(text), providerMetadata: meta });
          }
        }
        if (this.openReasoningPart?.key === key) {
          chunks.push(...this.closeOpenReasoning());
        }
        return chunks;
      }
      default: {
        const chunks = this.closeOpen();
        const tool = buildToolUseFromPiItem(item);
        if (tool) {
          const started = this.toolStartedInput.get(item.id);
          // Merge started+completed so late-arriving fields (the runtime can add
          // args at tool_execution_end) reach the finalized input — the builder
          // only updates a still-input-streaming part, so this rides the
          // input-start → input-available upgrade, not a second frozen input.
          const input = started ? { ...started, ...tool.input } : tool.input;
          this.toolStartedInput.set(item.id, input);
          chunks.push({
            type: 'tool-input-available',
            toolCallId: item.id,
            toolName: tool.name,
            input,
            providerMetadata: { pi: { itemKind: item.type } },
          });
        }
        const result = buildToolResultFromPiItem(item);
        const output: PiToolOutput = {
          content: result ? boundBlockContent(result.content) : '',
          isError: result ? result.isError : isFailedRuntimeItem(item),
        };
        if (result?.details) output.details = boundToolDetails(result.details);
        if (typeof item.status === 'string') output.status = item.status;
        if (typeof item.durationMs === 'number') output.durationMs = item.durationMs;
        chunks.push({ type: 'tool-output-available', toolCallId: item.id, output });
        return chunks;
      }
    }
  }

  // A tool item at item/started: open the tool part in the input-streaming state
  // and stream the input known so far, so the tool card renders live. The final
  // input is settled at item/completed (emitToolInputStarted counterpart in
  // encodeItemCompleted). This deliberately departs from a single
  // tool-input-available: item/started can carry a subset of the completed
  // input (or none — a tool can have only an item/completed), and the builder
  // will not overwrite a settled part's input.
  private emitToolInputStarted(item: PiThreadItem): PiUiMessageChunk[] {
    const chunks = this.closeOpen();
    if (this.toolStartedInput.has(item.id)) return chunks;
    const tool = buildToolUseFromPiItem(item);
    if (!tool) return chunks;
    this.toolStartedInput.set(item.id, tool.input);
    chunks.push({
      type: 'tool-input-start',
      toolCallId: item.id,
      toolName: tool.name,
      providerMetadata: { pi: { itemKind: item.type } },
    });
    if (Object.keys(tool.input).length > 0) {
      chunks.push({
        type: 'tool-input-delta',
        toolCallId: item.id,
        input: tool.input,
        // One delta per tool, so the accumulated text is this complete JSON doc.
        inputTextDelta: JSON.stringify(tool.input),
      });
    }
    return chunks;
  }

  private toolStream(toolCallId: string, text: string): PiUiMessageChunk[] {
    const seq = this.toolStreamSeq.get(toolCallId) ?? 0;
    this.toolStreamSeq.set(toolCallId, seq + 1);
    return [
      {
        type: 'data-pi-tool-stream',
        transient: true,
        data: { toolCallId, text: boundBlockText(text), seq },
      },
    ];
  }

  private reasoningDelta(
    key: string,
    delta: string,
    providerMetadata: ProviderMetadata,
  ): PiUiMessageChunk[] {
    const chunks = this.openReasoning(key, providerMetadata);
    this.streamedReasoning.add(key);
    chunks.push({ type: 'reasoning-delta', delta, providerMetadata });
    return chunks;
  }

  private openText(key: string): PiUiMessageChunk[] {
    if (this.openTextPart?.key === key) {
      this.streamedText.add(key);
      return [];
    }
    // Only the TEXT slot closes: a concurrently-streaming reasoning part keeps
    // accumulating (the builder tracks the kinds independently).
    const chunks = this.closeOpenText();
    chunks.push({ type: 'text-start' });
    this.openTextPart = { key };
    this.streamedText.add(key);
    return chunks;
  }

  private openReasoning(key: string, providerMetadata: ProviderMetadata): PiUiMessageChunk[] {
    if (this.openReasoningPart?.key === key) {
      return [];
    }
    const chunks = this.closeOpenReasoning();
    chunks.push({ type: 'reasoning-start', providerMetadata });
    this.openReasoningPart = { key, providerMetadata };
    return chunks;
  }

  /** Sequence break: close BOTH open slots (tool items, plan-panel creation,
   * user-stop, steer marker, turn completion) so the parts array keeps arrival
   * order. */
  private closeOpen(): PiUiMessageChunk[] {
    return [...this.closeOpenText(), ...this.closeOpenReasoning()];
  }

  private closeOpenText(): PiUiMessageChunk[] {
    if (!this.openTextPart) return [];
    this.openTextPart = null;
    return [{ type: 'text-end' }];
  }

  private closeOpenReasoning(): PiUiMessageChunk[] {
    if (!this.openReasoningPart) return [];
    const open = this.openReasoningPart;
    this.openReasoningPart = null;
    return [{ type: 'reasoning-end', providerMetadata: open.providerMetadata }];
  }
}

/**
 * Convenience: run an entire recorded Pi event stream through a fresh encoder,
 * returning the flat chunk list including the `start`/`start-step` head.
 */
export function encodePiEventStream(
  events: PiRuntimeEvent[],
  options: { messageId: string },
): PiUiMessageChunk[] {
  const encoder = new PiChunkEncoder(options);
  const chunks: PiUiMessageChunk[] = [...encoder.start()];
  for (const event of events) {
    chunks.push(...encoder.encode(event));
  }
  return chunks;
}
