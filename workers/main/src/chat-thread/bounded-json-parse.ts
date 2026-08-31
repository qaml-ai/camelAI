import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";

export interface JsonPreflightLimits {
  maxDepth: number;
  maxTokens: number;
  maxNodes: number;
  maxEntries: number;
  maxStrings: number;
  maxStringCodeUnits: number;
}

const whitespace = (code: number): boolean =>
  code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;

export function runtimeJsonLimits(
  maxStringCodeUnits: number,
): JsonPreflightLimits {
  const allocations =
    CHAT_RUNTIME_BOUNDS.providerJsonNodes +
    CHAT_RUNTIME_BOUNDS.providerJsonEntries;
  return {
    maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
    maxTokens: 4 * allocations + 16,
    maxNodes: allocations,
    maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
    maxStrings: allocations,
    maxStringCodeUnits,
  };
}

/**
 * Reject allocation-amplifying JSON before handing it to JSON.parse.
 *
 * This lexical pass retains only a depth-bounded delimiter stack. JSON.parse
 * remains the syntax authority; the conservative node count includes object
 * keys so every string allocation is charged before parsing.
 */
export function preflightJson(
  raw: string,
  limits: JsonPreflightLimits,
): {
  tokens: number;
  nodes: number;
  entries: number;
  strings: number;
  stringCodeUnits: number;
} {
  const stack: Array<{ open: string; nonEmpty: boolean }> = [];
  const stats = { tokens: 0, nodes: 0, entries: 0 };
  let strings = 0;
  let stringCodeUnits = 0;
  let inString = false;
  let escaped = false;
  let inPrimitive = false;

  const charge = (
    key: keyof typeof stats,
    maximum: number,
    label: string,
  ) => {
    stats[key] += 1;
    if (stats[key] > maximum) throw new Error(`JSON ${label} limit exceeded`);
  };
  const markContainerContent = () => {
    const container = stack.at(-1);
    if (!container || container.nonEmpty) return;
    container.nonEmpty = true;
    charge("entries", limits.maxEntries, "entry");
  };

  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = raw[index];
    if (inString) {
      if (!escaped && character === '"') {
        inString = false;
        continue;
      }
      stringCodeUnits += 1;
      if (stringCodeUnits > limits.maxStringCodeUnits) {
        throw new Error("JSON string limit exceeded");
      }
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      continue;
    }

    const delimiter = whitespace(code) || '"{}[],:'.includes(character);
    if (inPrimitive && !delimiter) continue;
    if (inPrimitive) inPrimitive = false;
    if (whitespace(code)) continue;

    if (character === '"') {
      markContainerContent();
      charge("tokens", limits.maxTokens, "token");
      charge("nodes", limits.maxNodes, "node");
      strings += 1;
      if (strings > limits.maxStrings) {
        throw new Error("JSON string count limit exceeded");
      }
      inString = true;
      escaped = false;
      continue;
    }
    if (character === "{" || character === "[") {
      markContainerContent();
      charge("tokens", limits.maxTokens, "token");
      charge("nodes", limits.maxNodes, "node");
      if (stack.length >= limits.maxDepth) {
        throw new Error("JSON depth limit exceeded");
      }
      stack.push({ open: character, nonEmpty: false });
      continue;
    }
    if (character === "}" || character === "]") {
      charge("tokens", limits.maxTokens, "token");
      const expected = character === "}" ? "{" : "[";
      if (stack.pop()?.open !== expected)
        throw new Error("Invalid JSON structure");
      continue;
    }
    if (character === ",") {
      charge("tokens", limits.maxTokens, "token");
      const container = stack.at(-1);
      if (container) {
        container.nonEmpty = true;
        charge("entries", limits.maxEntries, "entry");
      }
      continue;
    }
    if (character === ":") {
      charge("tokens", limits.maxTokens, "token");
      continue;
    }
    markContainerContent();
    charge("tokens", limits.maxTokens, "token");
    charge("nodes", limits.maxNodes, "node");
    inPrimitive = true;
  }
  if (inString || stack.length > 0) throw new Error("Invalid JSON structure");
  return { ...stats, strings, stringCodeUnits };
}

export function parseJsonBounded(
  raw: string,
  limits: JsonPreflightLimits,
): unknown {
  preflightJson(raw, limits);
  return JSON.parse(raw) as unknown;
}
