// Pure Pi context-compaction helpers extracted from chat-thread-do.ts: token
// estimation, cut-index selection, summary chunking/generation, and fallback
// summaries. Each function reads only its arguments; the stateful compaction
// orchestrators (compactPiContext, compactPiContextAfterTurn) stay on
// ChatThreadDO and call into this module.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { stripPiUiMetadata } from "../../../../src/lib/runtime-artifacts";
import { piAgentLoopErrorDetails } from "./pi-message-helpers";
import { PI_R2_IMAGE_REF_METADATA_KEY } from "../pi-message-storage";

export function piModelContextWindow(model: Model<any> | null | undefined): number {
  return typeof model?.contextWindow === "number" && model.contextWindow > 0
    ? model.contextWindow
    : 128_000;
}

export const PI_MAIN_REQUEST_MAX_OUTPUT_TOKENS = 32_000;
export const PI_MAIN_REQUEST_DEFAULT_OUTPUT_TOKENS = 16_384;

export function piEffectiveMaxOutputTokens(model: Model<any> | null | undefined): number {
  const maxTokens = Math.floor(Number(model?.maxTokens ?? 0));
  return Number.isFinite(maxTokens) && maxTokens > 0
    ? Math.min(maxTokens, PI_MAIN_REQUEST_MAX_OUTPUT_TOKENS)
    : 0;
}

/**
 * Clamp the model copy handed to the main Pi agent. Model catalog values describe
 * provider capability and can be 128k-262k; passing those values through as the
 * request max reserves unaffordable or impossible output on OpenRouter and can
 * itself overflow the context window. Keep catalog metadata intact and cap only
 * the request-facing copy.
 */
export function capPiMainRequestOutput(
  model: Model<any>,
): Model<any> {
  const configured = Math.floor(Number(model.maxTokens ?? 0));
  const maxTokens = Number.isFinite(configured) && configured > 0
    ? Math.min(configured, PI_MAIN_REQUEST_MAX_OUTPUT_TOKENS)
    : PI_MAIN_REQUEST_DEFAULT_OUTPUT_TOKENS;
  return maxTokens === model.maxTokens ? model : { ...model, maxTokens };
}

export function piCompactionReserveTokens(model: Model<any> | null | undefined): number {
  const contextWindow = piModelContextWindow(model);
  const outputReserveTokens = piEffectiveMaxOutputTokens(model);
  return Math.max(16_384, Math.ceil(contextWindow * 0.1), outputReserveTokens);
}

export function estimatePiCompactionTokens(messages: AgentMessage[]): number {
  return Math.ceil(estimatePiContextTokens(messages) * 1.12);
}

export function piAssistantContextTokens(message: AgentMessage): number | null {
  const record = message as unknown as {
    role?: unknown;
    usage?: {
      input?: unknown;
      output?: unknown;
      cacheRead?: unknown;
      cacheWrite?: unknown;
      totalTokens?: unknown;
    };
  };
  if (record.role !== "assistant") return null;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") return null;
  const totalTokens = Number(usage.totalTokens);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    return Math.floor(totalTokens);
  }
  const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
  const output = Math.max(0, Math.floor(Number(usage.output ?? 0)));
  const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
  const cacheWrite = Math.max(0, Math.floor(Number(usage.cacheWrite ?? 0)));
  const total = input + output + cacheRead + cacheWrite;
  return total > 0 ? total : null;
}

export function shouldCompactPiAfterAssistantUsage(
  message: AgentMessage,
  model: Model<any> | null | undefined,
): boolean {
  const contextWindow = piModelContextWindow(model);
  if (isPiContextOverflowMessage(message, contextWindow)) return true;
  const contextTokens = piAssistantContextTokens(message);
  if (contextTokens === null) return false;
  return contextTokens >= contextWindow - piCompactionReserveTokens(model);
}

/**
 * A `length` stop that produced no usable answer means the input filled the
 * window and left no room to generate. Pi's own `isContextOverflow` covers this
 * (its "Xiaomi MiMo" case) but only for `output === 0` at `>= 99%` of the
 * window. Real exhaustion routinely misses both bars: a reasoning model emits a
 * token or two of thinking before the budget runs out, and providers that
 * reserve their own headroom stop short of 99%. A camelCode thread wedged
 * permanently at `input: 216149 / 220000` (98.25%) with `output: 1` — one
 * reasoning token — and every later turn repeated it, because neither bar was
 * met so nothing forced compaction. Keep Pi's check and widen it: no usable
 * output plus a near-full window is exhaustion regardless of the exact counts.
 */
const PI_LENGTH_STOP_MAX_USABLE_OUTPUT_TOKENS = 16;
const PI_LENGTH_STOP_CONTEXT_FRACTION = 0.9;

export function isPiLengthStopContextExhaustion(
  message: AgentMessage,
  contextWindow: number,
): boolean {
  const record = message as unknown as {
    role?: unknown;
    stopReason?: unknown;
    usage?: { input?: unknown; cacheRead?: unknown; output?: unknown };
  };
  if (record.role !== "assistant") return false;
  if (record.stopReason !== "length") return false;
  if (!contextWindow || contextWindow <= 0) return false;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") return false;
  const output = Math.max(0, Math.floor(Number(usage.output ?? 0)));
  if (output > PI_LENGTH_STOP_MAX_USABLE_OUTPUT_TOKENS) return false;
  const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
  const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
  return input + cacheRead >= contextWindow * PI_LENGTH_STOP_CONTEXT_FRACTION;
}

export function isPiContextOverflowMessage(message: AgentMessage, contextWindow: number): boolean {
  const record = message as unknown as {
    role?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
    usage?: unknown;
    content?: unknown;
    timestamp?: unknown;
  };
  if (record.role !== "assistant") return false;
  if (isPiLengthStopContextExhaustion(message, contextWindow)) return true;
  return isContextOverflow(record as Parameters<typeof isContextOverflow>[0], contextWindow);
}

export async function loadPiCompleteSimple(): Promise<typeof import("@earendil-works/pi-ai/compat").completeSimple> {
  const { completeSimple } = await import("@earendil-works/pi-ai/compat");
  return completeSimple;
}

export function estimatePiContextTokens(messages: AgentMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimatePiMessageTokens(message),
    0,
  );
}

/**
 * The character heuristic only sees `messages`. The real request also carries
 * the system prompt and every tool schema, and no char-count models a
 * provider's tokenizer exactly — measured against a wedged production thread
 * the estimate came in at 154,520 tokens for a request the provider billed at
 * 216,184, a 1.40x undercount that kept the pre-turn check below its threshold
 * while the real context was already too full to answer.
 *
 * Each assistant turn reports what the provider actually counted, so use that
 * as a floor: the last assistant `input + cacheRead` covers everything up to
 * that message (system prompt and tools included), and only the messages after
 * it need estimating. Returns 0 when no turn has reported usage yet.
 */
export function observedPiContextTokens(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const record = messages[index] as unknown as {
      role?: unknown;
      usage?: { input?: unknown; cacheRead?: unknown };
    };
    if (record.role !== "assistant") continue;
    const usage = record.usage;
    if (!usage || typeof usage !== "object") continue;
    const input = Math.max(0, Math.floor(Number(usage.input ?? 0)));
    const cacheRead = Math.max(0, Math.floor(Number(usage.cacheRead ?? 0)));
    const reported = input + cacheRead;
    if (reported <= 0) continue;
    // Everything from this assistant message onward is new input for the next
    // request: the assistant's own output plus any later user/tool messages.
    return reported + estimatePiContextTokens(messages.slice(index));
  }
  return 0;
}

/**
 * Best available size for the next request: the char estimate, floored by what
 * the provider last reported. Ground truth wins whenever we have it.
 */
export function effectivePiContextTokens(messages: AgentMessage[]): number {
  return Math.max(
    estimatePiCompactionTokens(messages),
    observedPiContextTokens(messages),
  );
}

/**
 * Base64 is much less token-dense than ordinary prose for the models we use.
 * In particular, `take_screenshot({ include_image_data_url: true })` places a
 * data URL inside a text tool result. Counting all characters at 4 chars/token
 * can undercount such a payload by several times and skip compaction until the
 * provider has no usable output budget left. Treat an inline data URL
 * conservatively while retaining the ordinary heuristic for the surrounding
 * JSON/text.
 */
/**
 * Long unbroken high-entropy runs (base64, hex) are charged separately from
 * prose. Two things to know about this rule:
 *
 * 1. It matches any such run, not just `data:` URLs. The common case is an
 *    agent moving a generated file around, which puts raw base64 into tool
 *    arguments and results with no `data:` prefix at all.
 * 2. The per-character rate is deliberately pessimistic, NOT an estimate of
 *    true density. Measured with o200k, real base64 runs about 5.4 chars/token
 *    — slightly *cheaper* than prose, not "near one token per character" as
 *    this rule originally assumed. The rate is kept high on purpose: this
 *    heuristic's only remaining job is to decide whether a precise count is
 *    worth taking (see ./pi-token-count), and over-counting merely buys an
 *    accurate measurement, while under-counting silently skips compaction.
 *
 * Anything that actually depends on the number, rather than on "are we close",
 * should use the tokenizer or the provider-reported count instead.
 */
const PI_DENSE_BLOB_MIN_LENGTH = 256;
const PI_DENSE_BLOB_TOKENS_PER_CHAR = 0.75;
const PI_DENSE_BLOB_PATTERN = new RegExp(
  `[A-Za-z0-9+/_=-]{${PI_DENSE_BLOB_MIN_LENGTH},}`,
  "g",
);

export function estimatePiTextTokens(text: string): number {
  let tokens = 0;
  let offset = 0;
  for (const match of text.matchAll(PI_DENSE_BLOB_PATTERN)) {
    const start = match.index ?? offset;
    // Overlapping matches cannot happen with a global regex, but a blob that
    // begins before the current offset (already counted) must not double-count.
    if (start < offset) continue;
    tokens += Math.ceil((start - offset) / 4);
    tokens += Math.ceil(match[0].length * PI_DENSE_BLOB_TOKENS_PER_CHAR);
    offset = start + match[0].length;
  }
  tokens += Math.ceil((text.length - offset) / 4);
  return tokens;
}

/**
 * The text a message contributes to the context, as both the character
 * heuristic and the real tokenizer in ./pi-token-count see it. Shared so the
 * two measurements always agree on *what* is being counted and differ only in
 * how.
 */
export function stringifyPiMessageForTokenCount(message: AgentMessage): string {
  const record = message as unknown as { role?: unknown; content?: unknown };
  if (record.role === "user") {
    return stringifyPiUserContentForCompaction(record.content);
  }
  if (record.role === "assistant") {
    return stringifyPiAssistantContentForCompaction(record.content);
  }
  if (record.role === "toolResult") {
    return stringifyPiToolResultContentForCompaction(record.content);
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

export function estimatePiMessageTokens(message: AgentMessage): number {
  const record = message as unknown as { role?: unknown; content?: unknown };
  const text = stringifyPiMessageForTokenCount(message);
  return estimatePiTextTokens(text) + estimatePiImageMemoryTokens(record.content);
}

/** Charge inline or externally-declared base64 size before provider hydration. */
export function estimatePiImageMemoryTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type !== "image") continue;
    const inlineChars = typeof record.data === "string" ? record.data.length : 0;
    const metadata = record.metadata && typeof record.metadata === "object"
      ? record.metadata as Record<string, unknown>
      : undefined;
    const ref = metadata?.[PI_R2_IMAGE_REF_METADATA_KEY];
    const declaredChars = ref && typeof ref === "object"
      ? Math.max(0, Math.floor(Number((ref as Record<string, unknown>).size) || 0))
      : 0;
    tokens += Math.ceil(Math.max(inlineChars, declaredChars) * 0.75);
  }
  return tokens;
}

export function stringifyPiUserContentForCompaction(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown; mimeType?: unknown };
      if (record.type === "text") return typeof record.text === "string" ? record.text : "";
      if (record.type === "image") return `[image:${String(record.mimeType || "unknown")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function stringifyPiAssistantContentForCompaction(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (record.type === "text") return typeof record.text === "string" ? record.text : "";
      if (record.type === "thinking") return typeof record.thinking === "string" ? record.thinking : "";
      if (record.type === "toolCall") {
        return `Tool call: ${String(record.name || "unknown")} ${JSON.stringify(record.arguments ?? {})}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function stringifyPiToolResultContentForCompaction(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: unknown; text?: unknown; mimeType?: unknown };
      if (record.type === "text") return typeof record.text === "string" ? record.text : "";
      if (record.type === "image") return `[image:${String(record.mimeType || "unknown")}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function findPiCompactionCutIndex(messages: AgentMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    tokens += estimatePiContextTokens([messages[index] as AgentMessage]);
    if (tokens >= keepRecentTokens) {
      for (let cut = index; cut < messages.length; cut++) {
        const role = (messages[cut] as { role?: unknown }).role;
        if (role === "user" || role === "assistant") {
          return cut;
        }
      }
      return index;
    }
  }
  return 0;
}

export async function summarizePiMessages(
  messages: AgentMessage[],
  model: Model<any>,
  apiKey: string,
  completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
  signal?: AbortSignal,
  previousSummary?: string,
): Promise<string> {
  const summaryMaxTokens = piSummaryMaxTokens(model);
  const inputTokenBudget = piSummaryInputTokenBudget(model, summaryMaxTokens);
  const chunks = chunkPiMessagesForSummary(messages, inputTokenBudget);
  if (chunks.length === 0) {
    throw new Error("Nothing to compact");
  }

  let summary: string | undefined = previousSummary;
  for (const chunk of chunks) {
    summary = await summarizePiMessageChunk(
      chunk,
      model,
      apiKey,
      completeSimple,
      summaryMaxTokens,
      inputTokenBudget,
      signal,
      summary,
    );
  }
  return summary ?? "";
}

export function piSummaryMaxTokens(model: Model<any>): number {
  const contextWindow = piModelContextWindow(model);
  const reserveTokens = piCompactionReserveTokens(model);
  const modelOutputTokens = piEffectiveMaxOutputTokens(model) || reserveTokens;
  return Math.max(
    512,
    Math.min(
      Math.floor(reserveTokens * 0.8),
      modelOutputTokens,
      Math.max(512, Math.floor(contextWindow * 0.25)),
    ),
  );
}

export function piSummaryInputTokenBudget(model: Model<any>, summaryMaxTokens: number): number {
  const contextWindow = piModelContextWindow(model);
  const budget = Math.floor((contextWindow - summaryMaxTokens - 2048) * 0.85);
  return Math.max(2048, budget);
}

export function chunkPiMessagesForSummary(messages: AgentMessage[], inputTokenBudget: number): AgentMessage[][] {
  const chunks: AgentMessage[][] = [];
  let chunk: AgentMessage[] = [];
  let chunkTokens = 0;
  for (const message of messages) {
    const messageTokens = Math.max(1, estimatePiMessageTokens(message));
    if (chunk.length > 0 && chunkTokens + messageTokens > inputTokenBudget) {
      chunks.push(chunk);
      chunk = [];
      chunkTokens = 0;
    }
    chunk.push(message);
    chunkTokens += messageTokens;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export async function summarizePiMessageChunk(
  messages: AgentMessage[],
  model: Model<any>,
  apiKey: string,
  completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple,
  summaryMaxTokens: number,
  inputTokenBudget: number,
  signal?: AbortSignal,
  previousSummary?: string,
): Promise<string> {
  const serialized = messages
    .map((message) => serializePiMessageForSummary(message))
    .filter(Boolean)
    .join("\n\n");
  const previous = previousSummary
    ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
    : "";
  const maxConversationCharacters = Math.max(
    4000,
    (inputTokenBudget * 4) - previous.length - 2000,
  );
  const boundedSerialized = serialized.length > maxConversationCharacters
    ? `${serialized.slice(0, maxConversationCharacters)}\n\n[...truncated oversized compaction chunk...]`
    : serialized;
  const prompt = `${previous}<conversation>\n${boundedSerialized}\n</conversation>\n\nSummarize this coding-agent conversation for future continuation. Preserve exact file paths, commands, tool results that changed decisions, completed work, current goal, constraints, and next steps. Do not answer the conversation.`;
  const summaryContext = {
    systemPrompt: "You produce compact continuation summaries for coding-agent conversations.",
    messages: [{ role: "user" as const, content: prompt, timestamp: Date.now() }],
  };
  const summaryOptions = {
    apiKey,
    signal,
    maxTokens: summaryMaxTokens,
    ...(model.reasoning ? { reasoning: "high" as const } : {}),
  } as Parameters<typeof completeSimple>[2];
  const response = await completeSimple(
    model,
    summaryContext,
    summaryOptions,
  );
  if ((response as { stopReason?: unknown }).stopReason === "error") {
    const errorMessage = typeof (response as { errorMessage?: unknown }).errorMessage === "string"
      ? (response as { errorMessage: string }).errorMessage
      : "Compaction summary generation failed";
    throw new Error(errorMessage);
  }
  if ((response as { stopReason?: unknown }).stopReason === "aborted") {
    throw new Error("Compaction summary generation was aborted");
  }
  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Compaction summary was empty");
  return text;
}

export function serializePiMessageForSummary(message: AgentMessage): string {
  const sanitizedMessage = stripPiUiMetadata(message);
  const role = (sanitizedMessage as { role?: unknown }).role;
  if (role === "user") {
    const content = (sanitizedMessage as { content?: unknown }).content;
    return `[User]\n${typeof content === "string" ? content : JSON.stringify(content)}`;
  }
  if (role === "assistant") {
    return `[Assistant]\n${JSON.stringify((sanitizedMessage as { content?: unknown }).content)}`;
  }
  if (role === "toolResult") {
    const toolName = (sanitizedMessage as { toolName?: unknown }).toolName;
    const content = (sanitizedMessage as { content?: unknown }).content;
    return `[Tool result: ${String(toolName || "unknown")}]\n${JSON.stringify(content).slice(0, 4000)}`;
  }
  return "";
}

export function createFallbackPiCompactionSummary(messages: AgentMessage[], error: unknown): string {
  const details = piAgentLoopErrorDetails(error);
  const roleCounts = messages.reduce<Record<string, number>>((counts, message) => {
    const role = String((message as unknown as Record<string, unknown>).role || "unknown");
    counts[role] = (counts[role] ?? 0) + 1;
    return counts;
  }, {});
  const snippets = messages
    .map((message) => serializePiMessageForSummary(message))
    .filter((line): line is string => Boolean(line && line.trim()))
    .slice(-8)
    .map((line) => line.length > 1000 ? `${line.slice(0, 1000)}\n[...truncated...]` : line)
    .join("\n\n");
  return [
    "Automatic fallback summary created because model-generated compaction failed.",
    `Compaction error: ${details.name}: ${details.message}`,
    `Compacted message count: ${messages.length}`,
    `Role counts: ${JSON.stringify(roleCounts)}`,
    snippets ? `Recent compacted excerpts:\n${snippets}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 80_000);
}

export function createPiSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
  return {
    role: "user",
    content: `[Context Summary]\n\n${summary}`,
    timestamp,
  };
}
