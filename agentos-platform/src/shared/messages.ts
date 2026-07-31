/**
 * Shared chat message + streaming UI part types for agentOS.
 * Mirrors the ContentBlock surface camelAI Chat renders, plus a simplified
 * UIMessage-like part model for live streaming (no AI SDK dependency).
 */

// ---------------------------------------------------------------------------
// Content blocks (durable / render transcript)
// ---------------------------------------------------------------------------

/** Plain assistant or user text. */
export type TextBlock = {
  type: "text";
  text: string;
};

/** Tool invocation issued by the model. */
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** Result paired to a prior tool_use by id. */
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  /** True when the tool execution failed. */
  is_error?: boolean;
  /** Optional structured metadata (diff, patch, etc.). */
  details?: Record<string, unknown>;
};

/** Extended thinking / reasoning text. */
export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  /** Optional provider signature for verified thinking blocks. */
  signature?: string;
};

/** Terminal or inline turn error surfaced in the transcript. */
export type ErrorBlock = {
  type: "error";
  error: string;
  title?: string;
  status?: number;
  errorType?: string;
};

/**
 * Structured message content blocks.
 * Subset of camelAI ContentBlock: text | tool_use | tool_result | thinking | error.
 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ErrorBlock;

// ---------------------------------------------------------------------------
// Chat messages (legacy-style render shape)
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant";

/**
 * A single chat transcript message.
 * `content` may be plain text (user) or structured blocks (assistant).
 */
export type ChatMessage = {
  id: string;
  threadId: string;
  role: ChatRole;
  content: string | ContentBlock[];
  /** Creation time (ms since epoch). */
  createdAt: number;
  /** Client-generated id used to recover sends across reconnects. */
  clientMessageId?: string;
  /** True while this assistant message is still being streamed. */
  isStreaming?: boolean;
  /** Model-reported duration of the completed turn (ms). */
  turnDurationMs?: number;
};

// ---------------------------------------------------------------------------
// UI parts (simplified UIMessage-like streaming model)
// ---------------------------------------------------------------------------

export type UiTextPart = {
  type: "text";
  text: string;
  /** Streaming lifecycle; omit or `done` when complete. */
  state?: "streaming" | "done";
};

export type UiReasoningPart = {
  type: "reasoning";
  text: string;
  state?: "streaming" | "done";
};

export type UiToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  state?: "input-streaming" | "input-available" | "output-available" | "output-error";
};

export type UiToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName?: string;
  output: unknown;
  isError?: boolean;
};

/** Durable terminal error carried on the message (survives reload). */
export type UiDataErrorPart = {
  type: "data-error";
  id?: string;
  data: {
    error: string;
    title?: string;
    status?: number | string | null;
    errorType?: string | null;
  };
};

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  content: string;
  status: TodoStatus;
  /** Present-tense label shown while the todo is active. */
  activeForm: string;
};

/** In-turn plan / todo panel. */
export type UiDataTodosPart = {
  type: "data-todos";
  id?: string;
  data: {
    explanation?: string;
    todos: TodoItem[];
  };
};

/**
 * Transient live tool stdout/stderr delta.
 * Clients accumulate by toolCallId using monotonically increasing `seq`.
 */
export type UiDataToolStreamPart = {
  type: "data-tool-stream";
  data: {
    toolCallId: string;
    text: string;
    seq: number;
  };
};

export type UiPart =
  | UiTextPart
  | UiReasoningPart
  | UiToolCallPart
  | UiToolResultPart
  | UiDataErrorPart
  | UiDataTodosPart
  | UiDataToolStreamPart;

/**
 * Simplified UIMessage: id + role + ordered parts.
 * Prefer this for streaming; adapt to ChatMessage for legacy render paths.
 */
export type UiMessage = {
  id: string;
  role: ChatRole;
  parts: UiPart[];
  /** Creation time (ms since epoch). */
  createdAt: number;
};
