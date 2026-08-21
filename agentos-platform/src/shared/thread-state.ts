/**
 * Coarse thread UI state pushed over the chat websocket / event bus.
 * Intentionally small — streaming content lives on messages, not here.
 */

import type { TodoItem } from "./messages";

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

export type AskUserQuestionOption = {
  label: string;
  description?: string;
};

export type AskUserQuestionItem = {
  /** Prompt text; also used as the answer map key. */
  question: string;
  /** Short header shown above the question. */
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
  /** When true (default), allow a free-text "Other" answer. */
  allowOther?: boolean;
};

/**
 * Pending clarifying-question prompt shown in the chat composer area.
 * Mirrors camelAI AskUserQuestionData.
 */
export type AskUserQuestion = {
  questionId: string;
  /** Tool-use id when the prompt came from the AskUserQuestion tool. */
  toolUseId?: string;
  questions: AskUserQuestionItem[];
};

// ---------------------------------------------------------------------------
// Thread state
// ---------------------------------------------------------------------------

/** Terminal error surfaced once via thread state (composer recovery). */
export type ThreadLastError = {
  id: string;
  error: string;
  title?: string;
  status?: number | string | null;
  errorType?: string | null;
};

/**
 * Coarse Agent-state payload for a chat thread.
 * Clients merge partial updates from `ChatEvent` of type `state`.
 */
export type ThreadState = {
  title: string | null;
  /** Active model id (provider-specific string). */
  model: string | null;
  /** Live preview URL, when a deploy/notebook/file is open. */
  previewUrl: string | null;
  /** Bumped when the preview target should reload. */
  previewVersion: number;
  currentTodos: TodoItem[];
  pendingQuestion: AskUserQuestion | null;
  lastError: ThreadLastError | null;
  /** Context window fill estimate, 0–100; null when unknown. */
  contextUsedPercent: number | null;
};

/** Empty / default thread state for a new session. */
export const EMPTY_THREAD_STATE: ThreadState = {
  title: null,
  model: null,
  previewUrl: null,
  previewVersion: 0,
  currentTodos: [],
  pendingQuestion: null,
  lastError: null,
  contextUsedPercent: null,
};
