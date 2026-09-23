import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StorageDescriptor } from "../shared/storage-config.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
}
export interface ToolBridge {
  definitions: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: { toolCallId: string }): Promise<unknown>;
}
export interface AgentConfig {
  id: string;
  directory: string;
  model: Model<Api>;
  apiKey?: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  initialMessages?: AgentMessage[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** js_exec runs on an executor host, registered through the supervisor. */
  remoteExecutor?: boolean;
  /** Host policy for retrying transient provider errors. */
  retry?: { maxAttempts: number; baseDelayMs: number };
  /** Where the transcript lives; without it, `transcript.jsonl` in `directory`. */
  storage?: StorageDescriptor;
  transcriptKey?: string;
}
export type WireMessage =
  | { type: "request"; id: string; method: string; params: any }
  | { type: "response"; id: string; result?: any; error?: string }
  | { type: "event"; event: any };

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
