/**
 * OpenAI chat-completions <-> Pi, for the inference proxy the hosted agent
 * runtime calls (routes/agent-runtime-llm.ts). The runtime speaks Pi's stock
 * `openai-completions` client to chiridion; chiridion turns the request into a
 * Pi context, runs it through its own provider routing, and streams Pi's
 * events back as chat-completion chunks.
 *
 * The OpenAI wire format has no place for thinking signatures (Anthropic),
 * thought signatures (Gemini) or encrypted reasoning (OpenAI Responses), and
 * providers reject tool-use continuations that lost them. They travel as
 * OpenRouter-style `reasoning_details` entries keyed by tool call id, which
 * Pi's client stores on the tool call and sends back verbatim.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

type JsonRecord = Record<string, unknown>;

/** What a `reasoning.encrypted` detail carries for one tool call. */
interface ReasoningCarrier {
  /** The response's thinking blocks, signatures included (on its first tool call only). */
  thinking?: ThinkingContent[];
  thoughtSignature?: string;
}

const REASONING_DETAIL_FORMAT = "chiridion.pi.v1";

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class OpenAiRequestError extends Error {
  readonly status = 400;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && (part.type === "text" || part.type === "input_text") ? str(part.text) : ""))
    .join("");
}

/** An `image_url` part's data URL as Pi image content; remote URLs are not fetched. */
function imageOf(part: JsonRecord): ImageContent | null {
  const imageUrl = isRecord(part.image_url) ? str(part.image_url.url) : str(part.image_url);
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(imageUrl);
  if (!match) throw new OpenAiRequestError("Only data: URLs are accepted for image_url parts");
  return { type: "image", mimeType: match[1], data: match[2] };
}

function userContent(content: unknown): string | (TextContent | ImageContent)[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: (TextContent | ImageContent)[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text") parts.push({ type: "text", text: str(part.text) });
    else if (part.type === "image_url") {
      const image = imageOf(part);
      if (image) parts.push(image);
    }
  }
  return parts;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readCarriers(details: unknown): Map<string, ReasoningCarrier> {
  const carriers = new Map<string, ReasoningCarrier>();
  if (!Array.isArray(details)) return carriers;
  for (const detail of details) {
    if (!isRecord(detail) || detail.type !== "reasoning.encrypted" || detail.format !== REASONING_DETAIL_FORMAT) continue;
    try {
      const carrier = JSON.parse(str(detail.data)) as ReasoningCarrier;
      if (isRecord(carrier)) carriers.set(str(detail.id), carrier);
    } catch {
      // Not ours, or damaged: the call continues without it.
    }
  }
  return carriers;
}

function assistantMessage(message: JsonRecord, model: string): AssistantMessage {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
  const carriers = readCarriers(message.reasoning_details);
  const content: AssistantMessage["content"] = [];
  const thinking = toolCalls.map((call) => carriers.get(str(call.id))?.thinking).find(Array.isArray);
  if (thinking) content.push(...thinking);
  else {
    const reasoning = str(message.reasoning_content) || str(message.reasoning);
    if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  }
  const text = textOf(message.content);
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    const fn = isRecord(call.function) ? call.function : {};
    const id = str(call.id);
    const toolCall: ToolCall = { type: "toolCall", id, name: str(fn.name), arguments: parseArguments(fn.arguments) };
    const signature = carriers.get(id)?.thoughtSignature;
    if (signature) toolCall.thoughtSignature = signature;
    content.push(toolCall);
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "agent-runtime",
    model,
    usage: emptyUsage(),
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** A chat-completions request body as a Pi context. */
export function openAiRequestToPiContext(body: unknown): Context & { model: string } {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw new OpenAiRequestError("Expected a chat completions request with messages");
  }
  const model = str(body.model);
  const system: string[] = [];
  const messages: Message[] = [];
  const toolNames = new Map<string, string>();
  const now = Date.now();
  for (const raw of body.messages) {
    if (!isRecord(raw)) throw new OpenAiRequestError("Each message must be an object");
    switch (raw.role) {
      case "system":
      case "developer":
        system.push(textOf(raw.content));
        break;
      case "user":
        messages.push({ role: "user", content: userContent(raw.content), timestamp: now });
        break;
      case "assistant": {
        const message = assistantMessage(raw, model);
        for (const block of message.content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
        messages.push(message);
        break;
      }
      case "tool": {
        const toolCallId = str(raw.tool_call_id);
        const content = userContent(raw.content);
        messages.push({
          role: "toolResult",
          toolCallId,
          toolName: toolNames.get(toolCallId) ?? "",
          content: typeof content === "string" ? [{ type: "text", text: content }] : content,
          isError: false,
          timestamp: now,
        });
        break;
      }
      default:
        throw new OpenAiRequestError(`Unsupported message role: ${String(raw.role)}`);
    }
  }
  const tools: Tool[] = Array.isArray(body.tools)
    ? body.tools.filter(isRecord).map((tool) => {
        const fn = isRecord(tool.function) ? tool.function : {};
        return {
          name: str(fn.name),
          description: str(fn.description),
          parameters: (isRecord(fn.parameters) ? fn.parameters : { type: "object", properties: {} }) as Tool["parameters"],
        };
      })
    : [];
  return {
    model,
    ...(system.length > 0 ? { systemPrompt: system.join("\n\n") } : {}),
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function finishReason(message: AssistantMessage): string {
  if (message.stopReason === "toolUse") return "tool_calls";
  if (message.stopReason === "length") return "length";
  return "stop";
}

function usageChunk(usage: Usage) {
  return {
    prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
    prompt_tokens_details: { cached_tokens: usage.cacheRead, cache_write_tokens: usage.cacheWrite },
    completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
  };
}

/** The signatures of a finished response, one detail per tool call that needs one. */
export function reasoningDetails(message: AssistantMessage): JsonRecord[] {
  const thinking = message.content.filter(
    (block): block is ThinkingContent => block.type === "thinking" && Boolean(block.thinkingSignature),
  );
  const details: JsonRecord[] = [];
  let thinkingPlaced = false;
  for (const block of message.content) {
    if (block.type !== "toolCall") continue;
    const carrier: ReasoningCarrier = {};
    if (!thinkingPlaced && thinking.length > 0) {
      carrier.thinking = message.content.filter((b): b is ThinkingContent => b.type === "thinking");
      thinkingPlaced = true;
    }
    if (block.thoughtSignature) carrier.thoughtSignature = block.thoughtSignature;
    if (carrier.thinking || carrier.thoughtSignature) {
      details.push({ type: "reasoning.encrypted", id: block.id, format: REASONING_DETAIL_FORMAT, data: JSON.stringify(carrier) });
    }
  }
  return details;
}

export interface OpenAiStreamOptions {
  id: string;
  model: string;
  /** Called with the final message (done, error or aborted) before the stream closes. */
  onFinal?: (message: AssistantMessage) => void | Promise<void>;
}

/** Pi assistant events as a chat-completions SSE body. */
export function piEventsToOpenAiSse(
  events: AsyncIterable<AssistantMessageEvent>,
  options: OpenAiStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  const chunk = (delta: JsonRecord, extra: JsonRecord = {}) => frame({
    id: options.id,
    object: "chat.completion.chunk",
    created,
    model: options.model,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const toolIndex = new Map<number, number>();
      let final: AssistantMessage | null = null;
      try {
        controller.enqueue(chunk({ role: "assistant", content: "" }));
        for await (const event of events) {
          switch (event.type) {
            case "text_delta":
              if (event.delta) controller.enqueue(chunk({ content: event.delta }));
              break;
            case "thinking_delta":
              if (event.delta) controller.enqueue(chunk({ reasoning_content: event.delta }));
              break;
            case "toolcall_start": {
              const block = event.partial.content[event.contentIndex];
              const index = toolIndex.size;
              toolIndex.set(event.contentIndex, index);
              const call = block?.type === "toolCall" ? block : null;
              controller.enqueue(chunk({
                tool_calls: [{ index, id: call?.id ?? `call_${index}`, type: "function", function: { name: call?.name ?? "", arguments: "" } }],
              }));
              break;
            }
            case "toolcall_delta": {
              const index = toolIndex.get(event.contentIndex);
              if (index !== undefined && event.delta) {
                controller.enqueue(chunk({ tool_calls: [{ index, function: { arguments: event.delta } }] }));
              }
              break;
            }
            case "done":
              final = event.message;
              break;
            case "error":
              final = event.error;
              break;
          }
        }
        if (!final) throw new Error("The model stream ended without a final message");
        await options.onFinal?.(final);
        if (final.stopReason === "error" || final.stopReason === "aborted") {
          controller.enqueue(frame({
            error: { message: final.errorMessage || "The model request failed", type: final.stopReason === "aborted" ? "aborted" : "provider_error" },
          }));
        } else {
          const details = reasoningDetails(final);
          if (details.length > 0) controller.enqueue(chunk({ reasoning_details: details }));
          controller.enqueue(frame({
            id: options.id,
            object: "chat.completion.chunk",
            created,
            model: options.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason(final) }],
            usage: usageChunk(final.usage),
          }));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.enqueue(frame({ error: { message: error instanceof Error ? error.message : String(error), type: "proxy_error" } }));
        controller.close();
      }
    },
  });
}
