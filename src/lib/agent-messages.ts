/**
 * The pi message shapes chiridion reads and writes: the agent runtime's own
 * (its history, a moved thread's import) and the old ChatThreadDO transcript,
 * which stored the same pi messages.
 */
export type {
  AssistantMessage,
  ImageContent,
  Message as AgentMessage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "@camelai/run";

/** What a tool call answers: content for the model, details for the UI. */
export interface AgentToolResult<T> {
  content: Array<import("@camelai/run").TextContent | import("@camelai/run").ImageContent>;
  details: T;
}
