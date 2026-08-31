import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai/compat";

import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { connectionsBindingEnabled } from "../../../../src/lib/connections-binding";
import { DEFAULT_LLM_MODEL } from "../../../../src/lib/llm-provider-config";
import {
  CodeModeToolsBinding,
  CODE_MODE_COMPATIBILITY_DATE,
  CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_DEFAULT_TIMEOUT_MS,
  CODE_MODE_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_MAX_TIMEOUT_MS,
  CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
  clampCodeModeInteger,
  truncateCodeModeText,
} from "../code-mode-tools";
import type { CodeModeToolsProps } from "../code-mode-tools";
import {
  codeModeWorkerModule,
  CODE_MODE_MAX_NESTED_TOOL_CALLS,
} from "../code-mode-runner";
import { PI_CONTAINER_TOOL_DEFINITIONS } from "../pi-container-tools";
import { createPiSystemPrompt } from "../pi-system-prompt";
import { PiModelMapping } from "../pi-model-resolution";
import { resolveAgentSkillCatalog } from "../selfhost-agent-pack";
import {
  checkHostedPiModelAccess,
  primaryPiThinkingLevel,
  resolveCurrentByokCredentials,
  resolvePiModelConfig,
  resolvePiRequestConfig,
  type PiResolvedModelConfig,
} from "./pi-model-config";
import type { ChatContextState, ChatEnv } from "./types";
import { assertUserLlmUsageAccess } from "../user-llm-usage-policy";
import {
  BoundedTurnError,
  type BoundedContextTurn,
  type BoundedProviderStep,
  type BoundedTurnAdapter,
} from "./bounded-turn-runner";
import type {
  DurableChatTurn,
  DurableChatTurnStore,
} from "./durable-turn-store";
import { CHAT_RUNTIME_MODEL_KEY } from "./runtime-metadata";
import type { CheckpointProviderBatch } from "./turn-checkpoint";
import type { ChatRuntimeContentBlock } from "./chat-runtime-content";
import { utf8ByteLength } from "./utf8-byte-length";

export { CHAT_RUNTIME_MODEL_KEY } from "./runtime-metadata";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function contextOf(turn: DurableChatTurn): ChatContextState {
  return {
    threadId: turn.threadId,
    workspaceId: turn.workspaceId,
    orgId: turn.orgId,
    userId: turn.userId,
    userName: null,
    userEmail: null,
  };
}

function assistantMessage(
  model: PiResolvedModelConfig["model"],
  content: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: content.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: Date.now(),
  };
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface ProviderJsonState {
  entries: number;
  nodes: number;
  active: WeakSet<object>;
}

interface ProviderJsonOptions {
  maxBytes: number;
  byteCode: "invalid_provider_step" | "tool_input_bytes";
  byteMessage: string;
}

/** Builds only up to its byte ceiling and never appends an unchecked string. */
class BoundedUtf8Builder {
  private readonly chunks: string[] = [];
  private current = "";
  private usedBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly overflow: () => never,
  ) {}

  private appendToken(token: string, bytes: number): void {
    if (this.usedBytes + bytes > this.maxBytes) this.overflow();
    this.usedBytes += bytes;
    this.current += token;
    if (this.current.length >= 4_096) {
      this.chunks.push(this.current);
      this.current = "";
    }
  }

  ascii(token: string): void {
    this.appendToken(token, token.length);
  }

  remainingBytes(): number {
    return this.maxBytes - this.usedBytes;
  }

  byteLength(): number {
    return this.usedBytes;
  }

  private scan(
    value: string,
    quoted: boolean,
    visit: (token: string, bytes: number) => void,
  ): void {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      const next = value.charCodeAt(index + 1);
      if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      ) {
        visit(value.slice(index, index + 2), 4);
        index += 1;
        continue;
      }
      let token = value[index];
      if (quoted) {
        if (code === 0x22) token = '\\"';
        else if (code === 0x5c) token = "\\\\";
        else if (code === 0x08) token = "\\b";
        else if (code === 0x0c) token = "\\f";
        else if (code === 0x0a) token = "\\n";
        else if (code === 0x0d) token = "\\r";
        else if (code === 0x09) token = "\\t";
        else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
          token = `\\u${code.toString(16).padStart(4, "0")}`;
        }
      }
      visit(
        token,
        token.length > 1
          ? token.length
          : code < 0x80
            ? 1
            : code < 0x800
              ? 2
              : 3,
      );
    }
  }

  quotedByteLength(value: string, limit: number): number {
    let bytes = 2;
    if (bytes > limit) this.overflow();
    this.scan(value, true, (_token, tokenBytes) => {
      if (tokenBytes > limit - bytes) this.overflow();
      bytes += tokenBytes;
    });
    return bytes;
  }

  raw(value: string): void {
    this.scan(value, false, (token, bytes) => this.appendToken(token, bytes));
  }

  quoted(value: string): void {
    this.ascii('"');
    this.scan(value, true, (token, bytes) => this.appendToken(token, bytes));
    this.ascii('"');
  }

  finish(): string {
    if (this.current) this.chunks.push(this.current);
    let result = "";
    for (const chunk of this.chunks) result += chunk;
    return result;
  }
}

function providerOutputError(message: string): never {
  throw new BoundedTurnError("invalid_provider_step", message);
}

function dataField(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    providerOutputError("Provider output contains an accessor");
  }
  return descriptor.value;
}

function chargeProviderNode(state: ProviderJsonState): void {
  state.nodes += 1;
  if (state.nodes > CHAT_RUNTIME_BOUNDS.providerJsonNodes) {
    providerOutputError("Provider output exceeds the JSON node limit");
  }
}

function chargeProviderEntries(state: ProviderJsonState, count: number): void {
  if (count > CHAT_RUNTIME_BOUNDS.providerJsonEntries - state.entries) {
    providerOutputError("Provider output exceeds the JSON entry limit");
  }
  state.entries += count;
}

/** Strict JSON serialization with traversal and byte limits charged pre-copy. */
function writeProviderJson(
  value: unknown,
  writer: BoundedUtf8Builder,
  state: ProviderJsonState,
  depth: number,
): void {
  chargeProviderNode(state);
  if (depth > CHAT_RUNTIME_BOUNDS.providerJsonDepth) {
    providerOutputError("Provider output exceeds the JSON depth limit");
  }
  if (value === null) {
    writer.ascii("null");
    return;
  }
  if (typeof value === "string") {
    writer.quoted(value);
    return;
  }
  if (typeof value === "boolean") {
    writer.ascii(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      providerOutputError("Provider output contains a non-finite number");
    }
    writer.ascii(String(value));
    return;
  }
  if (!value || typeof value !== "object") {
    providerOutputError("Provider output contains a non-JSON value");
  }
  if (state.active.has(value)) {
    providerOutputError("Provider output contains a cycle");
  }
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const rawLength = dataField(value, "length");
      if (
        typeof rawLength !== "number" ||
        !Number.isSafeInteger(rawLength) ||
        rawLength < 0
      ) {
        providerOutputError("Provider output contains an invalid array");
      }
      chargeProviderEntries(state, rawLength);
      writer.ascii("[");
      for (let index = 0; index < rawLength; index += 1) {
        if (index) writer.ascii(",");
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor) writer.ascii("null");
        else if (!("value" in descriptor)) {
          providerOutputError("Provider output contains an accessor");
        } else {
          writeProviderJson(descriptor.value, writer, state, depth + 1);
        }
      }
      writer.ascii("]");
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      providerOutputError("Provider output contains a non-plain object");
    }

    const keys: string[] = [];
    let keyBytes = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      chargeProviderEntries(state, 1);
      keyBytes += writer.quotedByteLength(
        key,
        writer.remainingBytes() - keyBytes,
      );
      keys.push(key);
    }
    keys.sort();
    writer.ascii("{");
    for (let index = 0; index < keys.length; index += 1) {
      if (index) writer.ascii(",");
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        providerOutputError("Provider output contains an accessor");
      }
      writer.quoted(key);
      writer.ascii(":");
      writeProviderJson(descriptor.value, writer, state, depth + 1);
    }
    writer.ascii("}");
  } finally {
    state.active.delete(value);
  }
}

function strictProviderJson(
  value: unknown,
  options: ProviderJsonOptions,
): { json: string; value: JsonValue; bytes: number } {
  const writer = new BoundedUtf8Builder(options.maxBytes, () => {
    throw new BoundedTurnError(options.byteCode, options.byteMessage);
  });
  writeProviderJson(
    value,
    writer,
    { entries: 0, nodes: 0, active: new WeakSet<object>() },
    0,
  );
  const json = writer.finish();
  return {
    json,
    value: JSON.parse(json) as JsonValue,
    bytes: writer.byteLength(),
  };
}

function optionalStringField(value: object, key: string): string | undefined {
  const selected = dataField(value, key);
  if (selected === undefined) return undefined;
  if (typeof selected !== "string") {
    providerOutputError(`Provider output has an invalid ${key}`);
  }
  return selected;
}

function normalizedProviderContent(message: AssistantMessage): {
  content: AssistantMessage["content"];
  calls: Array<{ id: string; name: string; input: JsonValue }>;
  assistantText: string;
} {
  const rawContent = dataField(message, "content");
  if (!Array.isArray(rawContent)) {
    providerOutputError("Provider output content is not an array");
  }
  const rawLength = dataField(rawContent, "length");
  if (
    typeof rawLength !== "number" ||
    !Number.isSafeInteger(rawLength) ||
    rawLength < 0 ||
    rawLength > CHAT_RUNTIME_BOUNDS.providerContentParts
  ) {
    providerOutputError("Provider output exceeds the content-part limit");
  }

  const content: AssistantMessage["content"] = [];
  const calls: Array<{ id: string; name: string; input: JsonValue }> = [];
  const text = new BoundedUtf8Builder(CHAT_RUNTIME_BOUNDS.assistantBytes, () =>
    providerOutputError("Provider assistant output is too large"),
  );
  for (let index = 0; index < rawLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      rawContent,
      String(index),
    );
    if (!descriptor || !("value" in descriptor)) {
      providerOutputError("Provider output contains a missing content part");
    }
    const part = descriptor.value;
    if (!part || typeof part !== "object") {
      providerOutputError("Provider output contains an invalid content part");
    }
    const type = dataField(part, "type");
    if (type === "text") {
      const value = dataField(part, "text");
      if (typeof value !== "string") {
        providerOutputError("Provider text output is invalid");
      }
      text.raw(value);
      const textSignature = optionalStringField(part, "textSignature");
      content.push({
        type: "text",
        text: value,
        ...(textSignature === undefined ? {} : { textSignature }),
      });
      continue;
    }
    if (type === "thinking") {
      const thinking = dataField(part, "thinking");
      if (typeof thinking !== "string") {
        providerOutputError("Provider thinking output is invalid");
      }
      const thinkingSignature = optionalStringField(part, "thinkingSignature");
      const redacted = dataField(part, "redacted");
      if (redacted !== undefined && typeof redacted !== "boolean") {
        providerOutputError("Provider thinking redaction flag is invalid");
      }
      content.push({
        type: "thinking",
        thinking,
        ...(thinkingSignature === undefined ? {} : { thinkingSignature }),
        ...(redacted === undefined ? {} : { redacted }),
      });
      continue;
    }
    if (type === "toolCall") {
      if (calls.length >= CHAT_RUNTIME_BOUNDS.toolCallsPerTurn) {
        throw new BoundedTurnError("tool_limit", "Tool-call limit reached");
      }
      const id = dataField(part, "id");
      const name = dataField(part, "name");
      if (
        typeof id !== "string" ||
        !id ||
        id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
        typeof name !== "string" ||
        !name ||
        name.length > CHAT_RUNTIME_BOUNDS.identifierChars
      ) {
        providerOutputError("Provider output contains an invalid tool call");
      }
      const normalizedInput = strictProviderJson(dataField(part, "arguments"), {
        maxBytes: CHAT_RUNTIME_BOUNDS.toolInputBytes,
        byteCode: "tool_input_bytes",
        byteMessage: "Tool input is too large",
      }).value;
      if (
        !normalizedInput ||
        typeof normalizedInput !== "object" ||
        Array.isArray(normalizedInput)
      ) {
        providerOutputError("Provider tool input is not an object");
      }
      const thoughtSignature = optionalStringField(part, "thoughtSignature");
      content.push({
        type: "toolCall",
        id,
        name,
        arguments: normalizedInput,
        ...(thoughtSignature === undefined ? {} : { thoughtSignature }),
      });
      calls.push({ id, name, input: normalizedInput });
      continue;
    }
    providerOutputError("Provider output contains an unsupported content part");
  }
  strictProviderJson(content, {
    maxBytes: CHAT_RUNTIME_BOUNDS.liveMessageBytes,
    byteCode: "invalid_provider_step",
    byteMessage: "Provider content is too large",
  });
  return { content, calls, assistantText: text.finish() };
}

function providerProgressContent(
  message: AssistantMessage,
): ChatRuntimeContentBlock[] {
  const normalized = normalizedProviderContent(message);
  const content: ChatRuntimeContentBlock[] = [];
  for (const part of normalized.content) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    if (part.type === "thinking") {
      content.push({
        type: "thinking",
        thinking: part.thinking,
        ...(part.thinkingSignature
          ? { signature: part.thinkingSignature }
          : {}),
      });
    }
  }
  return content;
}

export async function consumePiProviderStream(
  stream: AssistantMessageEventStream,
  signal: AbortSignal,
  onProgress: (content: readonly ChatRuntimeContentBlock[]) => void,
): Promise<AssistantMessage> {
  let response: AssistantMessage | null = null;
  let events = 0;
  let nextProgressAt = Number.NEGATIVE_INFINITY;
  for await (const event of stream) {
    if (signal.aborted)
      throw signal.reason ?? new Error("Provider request aborted");
    events += 1;
    if (events > CHAT_RUNTIME_BOUNDS.providerStreamEvents) {
      throw new BoundedTurnError(
        "invalid_provider_step",
        "Provider stream event limit reached",
      );
    }
    if (event.type === "done") response = event.message;
    else if (event.type === "error") response = event.error;
    else if (
      event.type === "text_delta" ||
      event.type === "text_end" ||
      event.type === "thinking_delta" ||
      event.type === "thinking_end"
    ) {
      const now = Date.now();
      if (now >= nextProgressAt || event.type.endsWith("_end")) {
        try {
          onProgress(providerProgressContent(event.partial));
        } catch {}
        nextProgressAt = now + CHAT_RUNTIME_BOUNDS.liveFlushMs;
      }
    }
  }
  return response ?? stream.result();
}

function priorMessages(
  model: PiResolvedModelConfig["model"],
  context: readonly BoundedContextTurn[],
): Message[] {
  return context.map((message) =>
    message.role === "user"
      ? { role: "user", content: message.content, timestamp: 0 }
      : assistantMessage(model, [{ type: "text", text: message.content }]),
  );
}

function checkpointResultContent(
  output: string,
): Extract<Message, { role: "toolResult" }>["content"] {
  const fallback = [{ type: "text" as const, text: output }];
  if (!output.startsWith('{"content":')) return fallback;
  try {
    const value = strictProviderJson(JSON.parse(output), {
      maxBytes: CHAT_RUNTIME_BOUNDS.toolResultBytes,
      byteCode: "invalid_provider_step",
      byteMessage: "Checkpointed tool result is too large",
    }).value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fallback;
    const content = value.content;
    if (!Array.isArray(content) || content.length > 4) return fallback;
    const normalized: Extract<Message, { role: "toolResult" }>["content"] = [];
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part))
        return fallback;
      if (part.type === "text" && typeof part.text === "string") {
        normalized.push({ type: "text", text: part.text });
      } else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        part.data.length <= CHAT_RUNTIME_BOUNDS.toolResultBytes / 2 &&
        typeof part.mimeType === "string" &&
        ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          part.mimeType,
        )
      ) {
        normalized.push({
          type: "image",
          data: part.data,
          mimeType: part.mimeType,
        });
      } else return fallback;
    }
    return normalized.length ? normalized : fallback;
  } catch {
    return fallback;
  }
}

export function checkpointToolHistory(
  model: PiResolvedModelConfig["model"],
  batches: readonly CheckpointProviderBatch[],
): Message[] {
  return batches.flatMap((batch) => {
    const content = strictProviderJson(JSON.parse(batch.providerStateJson), {
      maxBytes: CHAT_RUNTIME_BOUNDS.providerStateBytes,
      byteCode: "invalid_provider_step",
      byteMessage: "Checkpointed provider state is too large",
    }).value;
    if (!Array.isArray(content)) {
      throw new Error("Invalid checkpointed provider state");
    }
    const providerContent = content as unknown as AssistantMessage["content"];
    const calls = providerContent.filter(
      (part): part is ToolCall =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "toolCall",
    );
    if (
      calls.length !== batch.calls.length ||
      batch.calls.some(
        (call, index) =>
          call.result === null ||
          calls[index]?.id !== call.id ||
          calls[index]?.name !== call.name ||
          strictProviderJson(calls[index]?.arguments, {
            maxBytes: CHAT_RUNTIME_BOUNDS.toolInputBytes,
            byteCode: "tool_input_bytes",
            byteMessage: "Checkpointed tool input is too large",
          }).json !== call.inputJson,
      )
    ) {
      throw new Error("Checkpointed tool batch does not match provider state");
    }
    return [
      assistantMessage(model, providerContent),
      ...batch.calls.map((call) => ({
        role: "toolResult" as const,
        toolCallId: call.id,
        toolName: call.name,
        content: checkpointResultContent(call.result?.output ?? "0"),
        isError: call.result?.status === "error",
        timestamp: Date.now(),
      })),
    ];
  });
}

export function checkpointProviderStep(
  message: AssistantMessage,
): BoundedProviderStep {
  const stopReason = dataField(message, "stopReason");
  if (stopReason === "error" || stopReason === "aborted") {
    const rawError = dataField(message, "errorMessage");
    if (rawError !== undefined && typeof rawError !== "string") {
      providerOutputError("Provider error output is invalid");
    }
    const error = new BoundedUtf8Builder(
      CHAT_RUNTIME_BOUNDS.assistantBytes,
      () => providerOutputError("Provider error output is too large"),
    );
    error.raw(rawError || "Model request failed");
    throw new Error(error.finish());
  }
  const normalized = normalizedProviderContent(message);
  if (normalized.calls.length) {
    const providerStateJson = strictProviderJson(normalized.content, {
      maxBytes: CHAT_RUNTIME_BOUNDS.providerStateBytes,
      byteCode: "invalid_provider_step",
      byteMessage: "Provider state is too large",
    }).json;
    return {
      kind: "tool_batch",
      providerStateJson,
      calls: normalized.calls,
    };
  }
  return { kind: "assistant", content: normalized.assistantText };
}

export type BoundedToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
};

export const PI_JS_EXEC_TOOL_DEFINITION: BoundedToolDefinition = {
  name: "js_exec",
  description:
    "Run bounded JavaScript or TypeScript in an isolated Worker with workspace tools on `tools` and runtime bindings on `env`. The final expression and console output are returned. Use `await tools.help()` to discover non-trivial tools; tool calls return `{ ok, data?, error? }`.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["description", "code"],
    properties: {
      description: {
        type: "string",
        description: "Concise description shown in the chat UI.",
      },
      code: { type: "string" },
      timeoutMs: {
        type: "number",
        minimum: 100,
        maximum: CODE_MODE_MAX_TIMEOUT_MS,
        description: `Wall-clock timeout; defaults to ${CODE_MODE_DEFAULT_TIMEOUT_MS}ms.`,
      },
      maxOutputCharacters: {
        type: "number",
        minimum: 1_000,
        maximum: CODE_MODE_MAX_OUTPUT_CHARACTERS,
      },
    },
  },
};
export const PI_AUTOMATION_OUTCOME_TOOL_DEFINITION: BoundedToolDefinition = {
  name: "report_automation_outcome",
  description:
    "Required final status for this scheduled automation. Use success only when the requested objective completed and was verified.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary"],
    properties: {
      status: {
        type: "string",
        enum: ["success", "failed", "partial", "needs_attention"],
      },
      summary: {
        type: "string",
        minLength: 1,
        maxLength: CHAT_RUNTIME_BOUNDS.automationSummaryChars,
      },
    },
  },
};
const AUTOMATION_OUTCOME_PROMPT = [
  "## Scheduled Automation Outcome",
  "Before your final response, you MUST call `report_automation_outcome` exactly once.",
  "Use `success` only when the requested business objective actually completed and was verified. Otherwise use `failed`, `partial`, or `needs_attention`, with a concise factual summary.",
].join("\n");

function boundedCatalogJson(value: unknown, maxBytes: number, message: string) {
  try {
    return strictProviderJson(value, {
      maxBytes,
      byteCode: "invalid_provider_step",
      byteMessage: message,
    });
  } catch (error) {
    if (error instanceof BoundedTurnError && error.message === message)
      return null;
    throw error;
  }
}

export function buildBoundedToolCatalog(
  definitions: Iterable<BoundedToolDefinition>,
): Tool[] {
  const seen = new Set<string>();
  const catalog: Tool[] = [];
  let bytes = 2;
  let visited = 0;
  const iterator = definitions[Symbol.iterator]();
  while (visited < CHAT_RUNTIME_BOUNDS.toolCatalogEntries) {
    const next = iterator.next();
    if (next.done) break;
    const definition = next.value;
    visited += 1;
    if (!definition || typeof definition !== "object") {
      providerOutputError("Tool catalog contains an invalid definition");
    }
    const name = dataField(definition, "name");
    const description = dataField(definition, "description");
    if (
      typeof name !== "string" ||
      !name ||
      name.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
      typeof description !== "string"
    ) {
      providerOutputError("Tool catalog contains invalid metadata");
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const separator = catalog.length ? 1 : 0;
    const remaining = CHAT_RUNTIME_BOUNDS.toolSchemaBytes - bytes - separator;
    if (remaining <= 0) break;
    const byteMessage = "Tool schema exceeds the catalog byte limit";
    // Prove metadata plus the smallest schema fits before touching a possibly
    // accessor-backed parameters field.
    if (
      !boundedCatalogJson(
        { name, description, parameters: {} },
        remaining,
        byteMessage,
      )
    )
      break;
    const parameters = dataField(definition, "parameters");
    const serialized = boundedCatalogJson(
      { name, description, parameters },
      remaining,
      byteMessage,
    );
    if (!serialized) break;
    catalog.push(serialized.value as unknown as Tool);
    bytes += separator + serialized.bytes;
  }
  return catalog;
}

type ExportFactory = (input: { props: Record<string, unknown> }) => unknown;

/** Executes one js_exec call without adding session or recovery state. */
async function executeBoundedJsExec(input: {
  ctx: Pick<DurableObjectState, "exports">;
  env: Pick<ChatEnv, "CODE_MODE_LOADER">;
  turn: Pick<DurableChatTurn, "orgId" | "workspaceId" | "threadId" | "userId">;
  tools: CodeModeToolsBinding;
  args: Record<string, unknown>;
}): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { ctx, env, turn, tools, args } = input;
  const code = typeof args.code === "string" ? args.code : "";
  if (!code.trim()) throw new Error("code is required");
  const loader = env.CODE_MODE_LOADER as
    | (WorkerLoader & { load?: (code: WorkerLoaderWorkerCode) => WorkerStub })
    | undefined;
  if (!loader) throw new Error("CODE_MODE_LOADER binding is not configured");
  const maxTimeoutMs = Math.min(
    CODE_MODE_MAX_TIMEOUT_MS,
    CHAT_RUNTIME_BOUNDS.toolDeadlineMs,
  );
  const timeoutMs = clampCodeModeInteger(
    args.timeoutMs,
    Math.min(CODE_MODE_DEFAULT_TIMEOUT_MS, maxTimeoutMs),
    100,
    maxTimeoutMs,
  );
  const maxOutputCharacters = clampCodeModeInteger(
    args.maxOutputCharacters,
    CODE_MODE_DEFAULT_MAX_OUTPUT_CHARACTERS,
    1_000,
    CODE_MODE_MAX_OUTPUT_CHARACTERS,
  );
  const exports = ctx.exports as unknown as Record<string, ExportFactory>;
  const binding = (name: string, props: Record<string, unknown>) =>
    exports[name]({ props });
  const scope = {
    orgId: turn.orgId,
    workspaceId: turn.workspaceId,
    userId: turn.userId ?? undefined,
  };
  const workerCode: WorkerLoaderWorkerCode & { limits?: { cpuMs?: number } } = {
    compatibilityDate: CODE_MODE_COMPATIBILITY_DATE,
    limits: { cpuMs: CHAT_RUNTIME_BOUNDS.codeModeCpuMs },
    mainModule: "index.js",
    modules: { "index.js": { js: codeModeWorkerModule(code) } },
    env: {
      // Reuse the attempt binding: direct tools and nested js_exec therefore
      // share one scratch/overflow ledger instead of each claiming a full cap.
      TOOLS: tools,
      AI: binding("AIVirtualBinding", scope),
      CAMELAI: binding("CamelAiService", scope),
      SECURE_FETCH: binding("SecureFetchBinding", scope),
      SCREENSHOT: binding("AppScreenshotBinding", scope),
      BROWSER: binding("AppBrowserBinding", scope),
    },
  };
  const worker =
    typeof loader.load === "function"
      ? loader.load(workerCode)
      : loader.get(`pi-codemode-${crypto.randomUUID()}`, () => workerCode);
  const runner = worker.getEntrypoint("CodeModeRunner") as unknown as {
    run(
      timeout: number,
      maximum: number,
      outputCharacters: number,
      nestedToolCalls: number,
    ): Promise<{ text?: unknown }>;
  };
  const result = await runner.run(
    timeoutMs,
    maxTimeoutMs,
    maxOutputCharacters,
    CODE_MODE_MAX_NESTED_TOOL_CALLS,
  );
  const text = truncateCodeModeText(result.text ?? "", maxOutputCharacters);
  return { content: [{ type: "text", text }] };
}

/** Low-level Pi provider/tool adapter with no session, replay, or retry state. */
export function createPiTurnAdapter(input: {
  ctx: DurableObjectState;
  env: ChatEnv;
  store: DurableChatTurnStore;
  automationOutcome?: {
    execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<unknown>;
  };
}): BoundedTurnAdapter {
  const { ctx, env, store } = input;
  const mapping = new PiModelMapping();
  interface TurnAdapterState {
    id: string;
    modelConfig: PiResolvedModelConfig | null;
    providerCalls: number;
    tools: CodeModeToolsBinding | null;
    jsExecUsed: boolean;
  }
  let active: TurnAdapterState | null = null;

  const stateFor = (turn: DurableChatTurn): TurnAdapterState => {
    if (active?.id !== turn.id) {
      active = {
        id: turn.id,
        modelConfig: null,
        providerCalls: 0,
        tools: null,
        jsExecUsed: false,
      };
    }
    return active;
  };

  const binding = (turn: DurableChatTurn) => {
    const state = stateFor(turn);
    return (state.tools ??= (
      ctx.exports as unknown as {
        CodeModeToolsBinding(init: {
          props: CodeModeToolsProps;
        }): CodeModeToolsBinding;
      }
    ).CodeModeToolsBinding({
      props: {
        orgId: turn.orgId,
        workspaceId: turn.workspaceId,
        threadId: turn.threadId,
        userId: turn.userId ?? undefined,
        allowWebTools: false,
      },
    }));
  };

  const resolveModel = async (turn: DurableChatTurn) => {
    const state = stateFor(turn);
    if (state.modelConfig) return state.modelConfig;
    binding(turn);
    const chat = contextOf(turn);
    const org = env.ORG.get(env.ORG.idFromName(turn.orgId));
    const durableModel = ctx.storage.kv.get<string>(CHAT_RUNTIME_MODEL_KEY);
    const thread = durableModel ? null : await org.getThread(turn.threadId);
    const requested =
      durableModel ||
      (thread && typeof thread.model === "string" ? thread.model : "") ||
      DEFAULT_LLM_MODEL;
    const { getModel } = await import("@earendil-works/pi-ai/compat");
    const resolved = await resolvePiModelConfig(
      {
        env,
        modelMapping: mapping,
        resolveRequestConfig: (resolved, context, model) =>
          resolvePiRequestConfig(
            {
              env,
              modelMapping: mapping,
              getChatMetadata: () => chat,
              resolveByokCredentials: (context, options) =>
                resolveCurrentByokCredentials(
                  env,
                  () => org.getLlmProviderConfig(),
                  context,
                  options,
                ),
              checkHostedModelAccess: (context, model) =>
                checkHostedPiModelAccess(env, context, model),
            },
            resolved,
            context,
            model,
          ),
        onBillingResolved: () => undefined,
      },
      chat,
      { CHIRIDION_MODEL: requested },
      getModel as never,
    );
    // A fenced late provider setup must not poison the next turn's cache.
    if (active === state) state.modelConfig = resolved;
    return resolved;
  };

  function* toolDefinitions(): Iterable<BoundedToolDefinition> {
    const containerNames = [
      "read",
      "write",
      "edit",
      "delete",
      "ls",
      "grep",
      "find",
    ] as const;
    let scanned = 0;
    for (const key of containerNames) {
      if (scanned >= CHAT_RUNTIME_BOUNDS.toolCatalogEntries) return;
      scanned += 1;
      const definition = dataField(PI_CONTAINER_TOOL_DEFINITIONS, key);
      if (!definition || typeof definition !== "object") {
        providerOutputError("Tool catalog contains an invalid definition");
      }
      yield definition as BoundedToolDefinition;
    }
    if (scanned++ < CHAT_RUNTIME_BOUNDS.toolCatalogEntries) {
      yield PI_JS_EXEC_TOOL_DEFINITION;
    }
    if (
      input.automationOutcome &&
      scanned++ < CHAT_RUNTIME_BOUNDS.toolCatalogEntries
    ) {
      yield PI_AUTOMATION_OUTCOME_TOOL_DEFINITION;
    }
    const length = dataField(
      CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
      "length",
    );
    if (!Number.isSafeInteger(length) || (length as number) < 0) {
      providerOutputError("Tool catalog has an invalid definition array");
    }
    for (
      let index = 0;
      index < (length as number) &&
      scanned < CHAT_RUNTIME_BOUNDS.toolCatalogEntries;
      index += 1
    ) {
      scanned += 1;
      const definition = dataField(
        CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS,
        String(index),
      );
      if (!definition || typeof definition !== "object") {
        providerOutputError("Tool catalog contains an invalid definition");
      }
      const hidden = dataField(definition, "hidden");
      const name = dataField(definition, "name");
      if (
        typeof hidden !== "boolean" ||
        typeof name !== "string" ||
        name.length > CHAT_RUNTIME_BOUNDS.identifierChars
      ) {
        providerOutputError("Tool catalog contains invalid metadata");
      }
      if (
        !hidden &&
        name !== "AskUserQuestion" &&
        name !== "prompt_connection_setup"
      ) {
        yield definition as BoundedToolDefinition;
      }
    }
  }

  const catalog = buildBoundedToolCatalog(toolDefinitions());
  return {
    *readContext(turn, limits, signal) {
      let count = 0;
      let used = 2;
      for (const previous of store.readModelContext(turn.id)) {
        if (signal.aborted) return;
        const group = [
          { role: "assistant" as const, content: previous.assistantFinal },
          { role: "user" as const, content: previous.userContent },
        ];
        const groupBytes = group.reduce(
          (sum, message) => sum + utf8ByteLength(JSON.stringify(message)) + 1,
          0,
        );
        if (
          count + group.length > limits.messages ||
          used + groupBytes > limits.bytes
        )
          return;
        yield* group;
        count += group.length;
        used += groupBytes;
      }
    },
    async callProvider({ turn, context, toolBatches, signal, onProgress }) {
      const state = stateFor(turn);
      const config = await resolveModel(turn);
      if (turn.userId) {
        await assertUserLlmUsageAccess(
          env.ORG.get(env.ORG.idFromName(turn.orgId)),
          {
            env,
            orgId: turn.orgId,
            workspaceId: turn.workspaceId,
            threadId: turn.threadId,
            userId: turn.userId,
            provider: config.usageProvider,
            model: config.model.id,
          },
        );
      }
      const chat = contextOf(turn);
      const model = {
        ...config.model,
        maxTokens: Math.min(
          config.model.maxTokens,
          CHAT_RUNTIME_BOUNDS.providerOutputTokens,
        ),
      };
      const skills = resolveAgentSkillCatalog(env);
      const suffix = input.automationOutcome
        ? `\n\n${AUTOMATION_OUTCOME_PROMPT}`
        : "";
      const systemPrompt =
        createPiSystemPrompt(chat, {
          skillNames: skills.skillNames,
          skillDescriptions: skills.skillDescriptions,
          promptPrepend: skills.promptPrepend,
          promptAppend: skills.promptAppend,
          deployedConnectionsBindingEnabled: connectionsBindingEnabled(env),
          maxBytes:
            CHAT_RUNTIME_BOUNDS.systemPromptBytes - utf8ByteLength(suffix),
        }) + suffix;
      const { streamSimple } = await import("@earendil-works/pi-ai/compat");
      const startedAt = Date.now();
      const stream = streamSimple(
        model,
        {
          systemPrompt,
          messages: [
            ...priorMessages(model, context),
            {
              role: "user",
              content: turn.userContent,
              timestamp: turn.createdAt,
            },
            ...checkpointToolHistory(model, toolBatches),
          ],
          tools: catalog,
        },
        {
          apiKey: config.apiKey,
          headers: config.headers,
          signal,
          timeoutMs: CHAT_RUNTIME_BOUNDS.providerDeadlineMs,
          maxRetries: 0,
          maxRetryDelayMs: 0,
          sessionId: turn.threadId,
          reasoning: primaryPiThinkingLevel(config.model.id),
        },
      );
      const response = await consumePiProviderStream(
        stream,
        signal,
        onProgress,
      );
      const callIndex = state.providerCalls++;
      const step = checkpointProviderStep(response);
      const usage = response.usage;
      if (
        usage &&
        (usage.input || usage.output || usage.cacheRead || usage.cacheWrite)
      ) {
        ctx.waitUntil(
          env.ORG.get(env.ORG.idFromName(turn.orgId))
            .recordUsage({
              workspace_id: turn.workspaceId,
              user_id: turn.userId ?? "",
              thread_id: turn.threadId,
              model: response.model || config.model.id,
              provider: config.usageProvider,
              billing_source: config.billingSource,
              credit_chargeable:
                config.billingSource === "hosted" && config.creditChargeable,
              usage_kind: "llm",
              usage_surface: "agent",
              input_tokens: usage.input,
              output_tokens: usage.output,
              cache_creation_input_tokens: usage.cacheWrite,
              cache_read_input_tokens: usage.cacheRead,
              estimated_cost_usd: usage.cost.total,
              duration_ms: Date.now() - startedAt,
              created_at_ms: response.timestamp,
              source: "pi_assistant",
              source_id: `chat-v2:${turn.id}:${callIndex}:${response.responseId ?? response.timestamp}`,
            })
            .catch((error) =>
              console.error("[ChatRuntime] usage recording failed", error),
            ),
        );
      }
      return step;
    },
    callTool: (call, signal) => {
      if (signal.aborted) throw signal.reason ?? new Error("Tool aborted");
      const turn = store.activeTurn();
      if (!turn) throw new Error("Turn authority expired");
      const state = stateFor(turn);
      const raw =
        call.input &&
        typeof call.input === "object" &&
        !Array.isArray(call.input)
          ? (call.input as Record<string, unknown>)
          : {};
      if (call.name === PI_AUTOMATION_OUTCOME_TOOL_DEFINITION.name) {
        if (!input.automationOutcome)
          throw new Error("No scheduled automation run is active");
        return input.automationOutcome.execute(raw, signal);
      }
      if (call.name === "js_exec") {
        if (state.jsExecUsed) {
          throw new BoundedTurnError(
            "tool_limit",
            "js_exec may run at most once per turn",
          );
        }
        state.jsExecUsed = true;
        return executeBoundedJsExec({
          ctx,
          env,
          turn,
          tools: binding(turn),
          args: raw,
        });
      }
      return binding(turn).callTool(call.name, {
        ...raw,
        toolUseId: call.id,
      });
    },
    overflowToolResult: (call, value, signal) => {
      if (signal.aborted) throw signal.reason ?? new Error("Tool aborted");
      const turn = store.activeTurn();
      if (!turn || turn.id !== active?.id) {
        throw new Error("Turn authority expired");
      }
      return binding(turn).overflowToolResult(
        call.name,
        call.id,
        value,
        signal,
      );
    },
  };
}
