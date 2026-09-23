import { Check } from "typebox/value";
import type { ToolDefinition } from "./protocol.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";

export function validateDefinitions(definitions: ToolDefinition[]) {
  if (!Array.isArray(definitions)) throw new Error("Tool definitions must be an array");
  if (definitions.length > 128) throw new Error("Too many tool definitions");
  jsonWithinLimit(definitions, 256 * 1024, "Tool catalog");
  const names = new Set<string>();
  for (const tool of definitions) {
    if (!tool || typeof tool.name !== "string" || typeof tool.description !== "string" ||
      !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new Error("Invalid tool definition");
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(tool.name) ||
      ["then", "constructor", "prototype", "search", "describe"].includes(tool.name) || names.has(tool.name)) {
      throw new Error(`Invalid, duplicate, or reserved tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
}

export function validateToolCall(definitions: ToolDefinition[], name: unknown, args: unknown) {
  const tool = definitions.find(tool => tool.name === name);
  if (!tool) throw new Error("Unknown tool");
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object");
  const json = jsonWithinLimit(args, SANDBOX_LIMITS.argumentBytes, "Tool arguments");
  if (!Check(tool.parameters, args)) throw new Error(`Invalid arguments for tool: ${tool.name}`);
  return { tool, args: args as Record<string, unknown>, bytes: Buffer.byteLength(json) };
}
