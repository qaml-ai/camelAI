/**
 * Websocket / event-bus contracts between agentOS server and web client.
 */

import type { ChatMessage, UiMessage, UiPart } from "./messages";
import type { ThreadState } from "./thread-state";

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

export type TurnStatus = "idle" | "streaming" | "recovering" | "error";

// ---------------------------------------------------------------------------
// Client → server inputs
// ---------------------------------------------------------------------------

/** User send payload. */
export type SendMessageInput = {
  content: string;
  /** Client-generated delivery id for reconnect-safe sends. */
  clientMessageId: string;
};

/** Answer to a pending AskUserQuestion prompt. */
export type AnswerQuestionInput = {
  questionId: string;
  /** Map of question text → selected label (or Other free text). */
  answers: Record<string, string>;
};

/** Client response to a tool permission gate. */
export type PermissionDecisionInput = {
  requestId: string;
  decision: "allow" | "deny" | "allow_always";
};

// ---------------------------------------------------------------------------
// Server → client events
// ---------------------------------------------------------------------------

export type MessageUpsertEvent = {
  type: "messageUpsert";
  /** Full message snapshot (ChatMessage and/or UiMessage). */
  message: ChatMessage | UiMessage;
};

/** Incremental part/text append onto an in-flight assistant message. */
export type MessageDeltaEvent = {
  type: "messageDelta";
  messageId: string;
  /** Appended or replaced parts for this delta. */
  parts?: UiPart[];
  /** Convenience text append when only streaming plain text. */
  textDelta?: string;
};

/** Transient live tool stdout/stderr (also available as a UiPart). */
export type ToolStreamEvent = {
  type: "toolStream";
  toolCallId: string;
  text: string;
  /** Monotonic per-tool sequence; clients ignore non-advancing seq. */
  seq: number;
};

/** Partial thread-state patch; missing keys are left unchanged. */
export type StateEvent = {
  type: "state";
  state: Partial<ThreadState>;
};

export type TurnStatusEvent = {
  type: "turnStatus";
  status: TurnStatus;
  /** Optional human-readable detail when status is error. */
  errorMessage?: string;
};

/** Server asks the user to approve a tool call before execution. */
export type PermissionRequestEvent = {
  type: "permissionRequest";
  requestId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Short description shown in the permission UI. */
  description?: string;
};

export type PermissionResolvedEvent = {
  type: "permissionResolved";
  requestId: string;
  decision: "allow" | "deny" | "allow_always";
};

export type ErrorEvent = {
  type: "error";
  error: string;
  /** Optional stable id for one-shot display / dismissal. */
  id?: string;
  status?: number;
};

/**
 * Discriminated union of all server → client chat events.
 */
export type ChatEvent =
  | MessageUpsertEvent
  | MessageDeltaEvent
  | ToolStreamEvent
  | StateEvent
  | TurnStatusEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | ErrorEvent;
