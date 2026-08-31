/**
 * The ChatThreadDO → browser Agent-state payload shape, shared so the DO producer
 * (workers/main/src/chat-thread-do.ts) and the client consumer
 * (src/components/Chat.tsx) can no longer drift apart by hand-copy.
 *
 * The leaf sub-types (preview target / pending question / connection-setup prompt
 * / model) live in layer-specific modules — the DO's in the worker, the client's
 * in React component modules — and can't be imported across that boundary without
 * dragging code the other side shouldn't bundle. So they stay generic here and
 * each side instantiates them with its own types. Everything that actually drifts
 * (the field set, nullability, and the terminal-error shape) is fixed here as one
 * source of truth. Imported from both sides like runtime-message-state.
 */

import type { ErrorBlock } from '../types';

/**
 * The most recent terminal error surfaced through Agent state (one-shot by id).
 *
 * This is the wire shape of the renderer's `ErrorBlock` (src/types.ts): `error`
 * is shared via Pick, and the optional narrowed fields become required-but-
 * nullable, widened to what the DO can carry before validation (`billingSource`/
 * `provider` as raw strings, `status` possibly a string). The adapter narrows
 * them back into `ErrorBlock` at read time (ui-message-adapter). The durable
 * `data-pi-error` part payload (`PiErrorData`) is an alias of this type.
 */
export interface ChatAgentTerminalError extends Pick<ErrorBlock, 'error'> {
  id: string;
  billingSource: string | null;
  provider: string | null;
  status: number | string | null;
  errorType: string | null;
}

export interface ChatAgentModelFallbackNotice {
  id: string;
  fromModel: string;
  toModel: string;
  reason: 'hosted_credits_exhausted' | 'hosted_subscription_unavailable';
  createdAt: number;
}

export function shouldShowModelFallbackNotice(
  notice: ChatAgentModelFallbackNotice | null | undefined,
  activeModel: string | null | undefined,
): notice is ChatAgentModelFallbackNotice {
  return Boolean(notice && notice.toModel === activeModel);
}

export interface ChatAgentStatePayload<
  Preview = unknown,
  Question = unknown,
  ConnectionPrompt = unknown,
  Model = unknown,
> {
  previewTabs: Preview[];
  previewActiveTabId: string | null;
  previewVersion: number;
  previewRefreshTabId: string | null;
  currentTodos: unknown[];
  contextUsedPercent: number | null;
  pendingQuestion: Question | null;
  connectionSetupPrompt: ConnectionPrompt | null;
  title: string | null;
  titleUpdatedAt: number | null;
  model: Model | null;
  modelUpdatedAt: number | null;
  modelFallbackNotice: ChatAgentModelFallbackNotice | null;
  lastError: ChatAgentTerminalError | null;
}
