/**
 * Shared agentOS types — safe for both server and web (no React / Cloudflare).
 */

export type {
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ErrorBlock,
  ContentBlock,
  ChatRole,
  ChatMessage,
  UiTextPart,
  UiReasoningPart,
  UiToolCallPart,
  UiToolResultPart,
  UiDataErrorPart,
  TodoStatus,
  TodoItem,
  UiDataTodosPart,
  UiDataToolStreamPart,
  UiPart,
  UiMessage,
} from "./messages";

export type {
  AskUserQuestionOption,
  AskUserQuestionItem,
  AskUserQuestion,
  ThreadLastError,
  ThreadState,
} from "./thread-state";

export { EMPTY_THREAD_STATE } from "./thread-state";

export type {
  TurnStatus,
  SendMessageInput,
  AnswerQuestionInput,
  PermissionDecisionInput,
  MessageUpsertEvent,
  MessageDeltaEvent,
  ToolStreamEvent,
  StateEvent,
  TurnStatusEvent,
  PermissionRequestEvent,
  PermissionResolvedEvent,
  ErrorEvent,
  ChatEvent,
} from "./events";

export {
  SLASH_COMMANDS,
  MANUAL_COMPACT_COMMAND,
  isSlashCommand,
  isManualCompactCommand,
} from "./slash-commands";

export type { SlashCommand } from "./slash-commands";