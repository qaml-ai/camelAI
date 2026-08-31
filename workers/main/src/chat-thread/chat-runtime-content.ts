import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { boundedCanonicalJson } from "./bounded-canonical-json";
import { parseJsonBounded, runtimeJsonLimits } from "./bounded-json-parse";
import type { TurnCheckpoint } from "./turn-checkpoint";
import {
  boundedJsonString,
  boundedUtf8String,
  jsonStringByteLength,
  utf8ByteLength,
} from "./utf8-byte-length";

export type ChatRuntimeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    };

const MISSING = Symbol("missing data property");
const byteLength = utf8ByteLength;

function dataField(value: unknown, key: string): unknown | typeof MISSING {
  if (!value || typeof value !== "object") return MISSING;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : MISSING;
  } catch {
    return MISSING;
  }
}

function boundedArrayLength(value: unknown, maximum: number): number | null {
  try {
    if (!Array.isArray(value)) return null;
  } catch {
    return null;
  }
  const length = dataField(value, "length");
  return typeof length === "number" &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= maximum
    ? length
    : null;
}

function arrayItem(value: unknown, index: number): unknown | typeof MISSING {
  return dataField(value, String(index));
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CHAT_RUNTIME_BOUNDS.identifierChars
  );
}

function parseJson(
  raw: unknown,
  maximumBytes: number,
): unknown | typeof MISSING {
  if (typeof raw !== "string" || byteLength(raw) > maximumBytes) return MISSING;
  try {
    return parseJsonBounded(raw, runtimeJsonLimits(maximumBytes));
  } catch {
    return MISSING;
  }
}

function safeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  try {
    const serialized = boundedCanonicalJson(
      value,
      CHAT_RUNTIME_BOUNDS.toolInputBytes,
      {
        maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
        maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
        maxNodes: CHAT_RUNTIME_BOUNDS.providerJsonNodes,
      },
    );
    const parsed = JSON.parse(serialized) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function safeResultContent(raw: unknown): string | null {
  const parsed = parseJson(raw, CHAT_RUNTIME_BOUNDS.toolResultBytes);
  if (parsed === MISSING) return null;
  if (typeof parsed === "string") return parsed;
  try {
    return boundedCanonicalJson(parsed, CHAT_RUNTIME_BOUNDS.toolResultBytes, {
      maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
      maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
      maxNodes: CHAT_RUNTIME_BOUNDS.providerJsonNodes,
    });
  } catch {
    return null;
  }
}

function sanitizeRuntimeBlock(
  value: unknown,
  textOnly: boolean,
): ChatRuntimeContentBlock | null {
  const type = dataField(value, "type");
  if (type === "text") {
    const text = dataField(value, "text");
    return typeof text === "string" ? { type, text } : null;
  }
  if (type === "thinking") {
    const thinking = dataField(value, "thinking");
    const signature = dataField(value, "signature");
    if (
      typeof thinking !== "string" ||
      (signature !== MISSING && typeof signature !== "string")
    ) {
      return null;
    }
    return {
      type,
      thinking,
      ...(typeof signature === "string" ? { signature } : {}),
    };
  }
  if (textOnly) return null;
  if (type === "tool_use") {
    const id = dataField(value, "id");
    const name = dataField(value, "name");
    const input = safeJsonObject(dataField(value, "input"));
    return boundedId(id) && boundedId(name) && input
      ? { type, id, name, input }
      : null;
  }
  if (type === "tool_result") {
    const toolUseId = dataField(value, "tool_use_id");
    const content = dataField(value, "content");
    const isError = dataField(value, "is_error");
    if (
      !boundedId(toolUseId) ||
      typeof content !== "string" ||
      (isError !== MISSING && typeof isError !== "boolean")
    ) {
      return null;
    }
    return {
      type,
      tool_use_id: toolUseId,
      content: boundedUtf8String(content, CHAT_RUNTIME_BOUNDS.toolResultBytes),
      is_error: isError === true,
    };
  }
  return null;
}

function providerBlock(value: unknown): ChatRuntimeContentBlock | null {
  const type = dataField(value, "type");
  if (type === "text") {
    const text = dataField(value, "text");
    return typeof text === "string" ? { type: "text", text } : null;
  }
  if (type === "thinking") {
    const thinking = dataField(value, "thinking");
    const signature = dataField(value, "thinkingSignature");
    if (
      typeof thinking !== "string" ||
      (signature !== MISSING && typeof signature !== "string")
    ) {
      return null;
    }
    return {
      type: "thinking",
      thinking,
      ...(typeof signature === "string" ? { signature } : {}),
    };
  }
  if (type !== "toolCall") return null;
  const id = dataField(value, "id");
  const name = dataField(value, "name");
  const input = safeJsonObject(dataField(value, "arguments"));
  return boundedId(id) && boundedId(name) && input
    ? { type: "tool_use", id, name, input }
    : null;
}

function withMainText(
  block: ChatRuntimeContentBlock,
  text: string,
): ChatRuntimeContentBlock {
  if (block.type === "text") return { ...block, text };
  if (block.type === "thinking") return { ...block, thinking: text };
  if (block.type === "tool_result") return { ...block, content: text };
  return block;
}

function serializedBlock(block: ChatRuntimeContentBlock): string | null {
  try {
    return JSON.stringify(block);
  } catch {
    return null;
  }
}

function compactBlock(
  block: ChatRuntimeContentBlock,
  maximumBytes: number,
): ChatRuntimeContentBlock | null {
  if (block.type === "tool_use") {
    const serialized = serializedBlock(block);
    return serialized !== null && byteLength(serialized) <= maximumBytes
      ? block
      : null;
  }
  let candidate = block;
  if (block.type === "thinking" && block.signature !== undefined) {
    const emptySigned = serializedBlock({
      type: "thinking",
      thinking: "",
      signature: "",
    });
    const signedBytes =
      (emptySigned === null ? maximumBytes + 1 : byteLength(emptySigned)) +
      jsonStringByteLength(block.signature) -
      2;
    if (signedBytes > maximumBytes) {
      candidate = { type: "thinking", thinking: block.thinking };
    }
  }
  const original =
    candidate.type === "text"
      ? candidate.text
      : candidate.type === "thinking"
        ? candidate.thinking
        : candidate.content;
  const empty = serializedBlock(withMainText(candidate, ""));
  if (empty === null) return null;
  const stringBudget = maximumBytes - byteLength(empty) + 2;
  if (stringBudget < 2) return null;
  const compact = withMainText(
    candidate,
    boundedJsonString(original, stringBudget),
  );
  const serialized = serializedBlock(compact);
  return serialized !== null && byteLength(serialized) <= maximumBytes
    ? compact
    : null;
}

class ContentAccumulator {
  readonly blocks: ChatRuntimeContentBlock[] = [];
  private usedBytes = 2;

  constructor(
    private readonly maximumBytes: number,
    private readonly maximumBlocks: number,
  ) {}

  add(block: ChatRuntimeContentBlock): boolean {
    if (this.blocks.length >= this.maximumBlocks) return false;
    const separatorBytes = this.blocks.length ? 1 : 0;
    const available = this.maximumBytes - this.usedBytes - separatorBytes;
    const compact = compactBlock(block, available);
    if (!compact) return false;
    const serialized = serializedBlock(compact);
    if (serialized === null) return false;
    const size = byteLength(serialized);
    if (size > available) return false;
    this.blocks.push(compact);
    this.usedBytes += separatorBytes + size;
    return true;
  }

  addPair(
    tool: Extract<ChatRuntimeContentBlock, { type: "tool_use" }>,
    result: Extract<ChatRuntimeContentBlock, { type: "tool_result" }>,
  ): boolean {
    const length = this.blocks.length;
    const usedBytes = this.usedBytes;
    if (this.add(tool) && this.add(result)) return true;
    this.blocks.length = length;
    this.usedBytes = usedBytes;
    return false;
  }
}

function resultByCallId(batch: unknown): Map<string, ChatRuntimeContentBlock> {
  const results = new Map<string, ChatRuntimeContentBlock>();
  const calls = dataField(batch, "calls");
  const length = boundedArrayLength(
    calls,
    CHAT_RUNTIME_BOUNDS.toolCallsPerTurn,
  );
  if (length === null) return results;
  for (let index = 0; index < length; index += 1) {
    const call = arrayItem(calls, index);
    const id = dataField(call, "id");
    const result = dataField(call, "result");
    if (!boundedId(id) || !result || typeof result !== "object") continue;
    const callId = dataField(result, "callId");
    const status = dataField(result, "status");
    const content = safeResultContent(dataField(result, "output"));
    if (
      callId !== id ||
      (status !== "success" && status !== "error") ||
      content === null
    ) {
      continue;
    }
    results.set(id, {
      type: "tool_result",
      tool_use_id: id,
      content,
      is_error: status === "error",
    });
  }
  return results;
}

function checkpointTrace(
  checkpoint: unknown,
  maximumBytes: number,
  maximumBlocks: number,
): ChatRuntimeContentBlock[] {
  const output = new ContentAccumulator(maximumBytes, maximumBlocks);
  const batches = dataField(checkpoint, "batches");
  const batchLength = boundedArrayLength(
    batches,
    CHAT_RUNTIME_BOUNDS.providerCallsPerTurn,
  );
  if (batchLength === null) return output.blocks;

  for (let batchIndex = 0; batchIndex < batchLength; batchIndex += 1) {
    const batch = arrayItem(batches, batchIndex);
    const providerState = parseJson(
      dataField(batch, "providerStateJson"),
      CHAT_RUNTIME_BOUNDS.providerStateBytes,
    );
    const partLength = boundedArrayLength(
      providerState,
      CHAT_RUNTIME_BOUNDS.providerContentParts,
    );
    if (partLength === null) continue;
    const results = resultByCallId(batch);
    for (let partIndex = 0; partIndex < partLength; partIndex += 1) {
      const block = providerBlock(arrayItem(providerState, partIndex));
      if (!block) continue;
      if (block.type !== "tool_use") {
        output.add(block);
        continue;
      }
      const result = results.get(block.id);
      if (result?.type === "tool_result") output.addPair(block, result);
      else output.add(block);
    }
  }
  return output.blocks;
}

function boundedInput(
  value: unknown,
  maximumBytes: number,
  maximumBlocks: number,
  textOnly: boolean,
  strict: boolean,
): ChatRuntimeContentBlock[] | null {
  const length = boundedArrayLength(
    value,
    CHAT_RUNTIME_BOUNDS.liveContentBlocks,
  );
  if (length === null) return strict ? null : [];
  const output = new ContentAccumulator(maximumBytes, maximumBlocks);
  for (let index = 0; index < length; index += 1) {
    const item = arrayItem(value, index);
    const block = sanitizeRuntimeBlock(item, textOnly);
    if (!block) {
      if (strict) return null;
      continue;
    }
    if (block.type === "tool_use" && index + 1 < length) {
      const next = sanitizeRuntimeBlock(arrayItem(value, index + 1), textOnly);
      if (next?.type === "tool_result" && next.tool_use_id === block.id) {
        if (!output.addPair(block, next) && strict) return null;
        index += 1;
        continue;
      }
    }
    if (!output.add(block) && strict) return null;
  }
  return output.blocks;
}

function joinedByteLimit(right: readonly ChatRuntimeContentBlock[]): number {
  if (!right.length) return CHAT_RUNTIME_BOUNDS.liveMessageBytes;
  let serialized: string;
  try {
    serialized = JSON.stringify(right);
  } catch {
    return 2;
  }
  return Math.max(
    2,
    CHAT_RUNTIME_BOUNDS.liveMessageBytes - byteLength(serialized) + 1,
  );
}

/** Projects only durable checkpoint state; incomplete tool calls have no result. */
export function checkpointRuntimeContent(
  checkpoint: TurnCheckpoint,
): ChatRuntimeContentBlock[] {
  const final = dataField(checkpoint, "final");
  const tail =
    typeof final === "string" && final.length
      ? (boundedInput(
          [{ type: "text", text: final }],
          CHAT_RUNTIME_BOUNDS.liveMessageBytes,
          1,
          true,
          false,
        ) ?? [])
      : [];
  const trace = checkpointTrace(
    checkpoint,
    Math.min(CHAT_RUNTIME_BOUNDS.liveTraceBytes, joinedByteLimit(tail)),
    Math.max(0, CHAT_RUNTIME_BOUNDS.liveContentBlocks - tail.length),
  );
  return [...trace, ...tail];
}

/** Keeps current provider text/thinking visible even when the durable trace is full. */
export function combineRuntimeContent(
  trace: readonly ChatRuntimeContentBlock[],
  current: readonly ChatRuntimeContentBlock[],
): ChatRuntimeContentBlock[] {
  const tail =
    boundedInput(
      current,
      CHAT_RUNTIME_BOUNDS.liveMessageBytes,
      CHAT_RUNTIME_BOUNDS.liveContentBlocks,
      true,
      false,
    ) ?? [];
  const head =
    boundedInput(
      trace,
      Math.min(CHAT_RUNTIME_BOUNDS.liveTraceBytes, joinedByteLimit(tail)),
      Math.max(0, CHAT_RUNTIME_BOUNDS.liveContentBlocks - tail.length),
      false,
      false,
    ) ?? [];
  return [...head, ...tail];
}

/** Serializes a self-contained terminal render artifact within the wire ceiling. */
export function serializeRuntimeContent(blocks: readonly unknown[]): string {
  const safe =
    boundedInput(
      blocks,
      CHAT_RUNTIME_BOUNDS.liveMessageBytes,
      CHAT_RUNTIME_BOUNDS.liveContentBlocks,
      false,
      false,
    ) ?? [];
  try {
    const serialized = JSON.stringify(safe);
    return byteLength(serialized) <= CHAT_RUNTIME_BOUNDS.liveMessageBytes
      ? serialized
      : "[]";
  } catch {
    return "[]";
  }
}

/** Refuses malformed or oversized stored render artifacts instead of guessing. */
export function parseRuntimeContent(
  raw: string,
): ChatRuntimeContentBlock[] | null {
  const parsed = parseJson(raw, CHAT_RUNTIME_BOUNDS.liveMessageBytes);
  if (parsed === MISSING) return null;
  return boundedInput(
    parsed,
    CHAT_RUNTIME_BOUNDS.liveMessageBytes,
    CHAT_RUNTIME_BOUNDS.liveContentBlocks,
    false,
    true,
  );
}
