import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolBridge {
  definitions: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface AgentConfig {
  id: string;
  directory: string;
  model: Model<Api>;
  apiKey?: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
}
export interface Snapshot {
  version: 1;
  active: boolean;
  messages: AgentMessage[];
}
export type WireMessage =
  | { type: "request"; id: string; method: string; params: any }
  | { type: "response"; id: string; result?: any; error?: string }
  | { type: "event"; event: any };

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
