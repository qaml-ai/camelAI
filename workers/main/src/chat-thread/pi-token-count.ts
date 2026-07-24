// Precise context measurement for Pi compaction decisions.
//
// The character heuristic in ./pi-compaction is cheap and always available, but
// it is a guess: measured against a wedged production thread it read 137,964
// tokens for a request the provider billed at 216,184. Deciding whether to
// compact on a guess that loose is how a thread ends up too big to answer with
// nothing to show the user.
//
// This module counts with a real BPE tokenizer instead. o200k_base is used as a
// universal estimate for every model, not just OpenAI's: on that same thread it
// counted 212,055 tokens against a true 216,149 — within 1.9%, and the residual
// is the system prompt and tool schemas, which are in the request but not in
// `messages`. Other vocabularies differ, but not nearly enough to matter
// against the compaction reserve, and one accurate-enough number for every
// provider beats maintaining five.
//
// COST. Tokenizing a full 560KB context takes ~117ms, and this runs from
// `transformContext` — once per provider request, so 25+ times in a single
// agent-loop turn. Doing it naively would add seconds of CPU per turn. It is
// avoided almost entirely by only ever measuring what the provider has NOT
// already priced: every assistant message carries the provider's own exact
// input count for everything before it, so only the messages after the last one
// need tokenizing. In an agent loop that tail is usually a single tool result —
// 0.06ms for a small one, ~3ms for a 52KB one. The full-context path only runs
// before any turn has reported usage, when the context is small anyway.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  estimatePiContextTokens,
  stringifyPiMessageForTokenCount,
} from "./pi-compaction";

/**
 * Fraction of the context window above which a precise count is worth its CPU
 * on the no-usage-yet path. Below this the cheap estimate cannot plausibly be
 * hiding an overflow.
 */
const PI_PRECISE_COUNT_TRIGGER_FRACTION = 0.5;

export function shouldMeasurePiContextPrecisely(
  estimatedTokens: number,
  contextWindow: number,
): boolean {
  if (!contextWindow || contextWindow <= 0) return false;
  return estimatedTokens >= contextWindow * PI_PRECISE_COUNT_TRIGGER_FRACTION;
}

export interface PiPricedContextSplit {
  /** Index of the assistant message whose usage priced everything before it. */
  index: number;
  /** Provider-reported input tokens: exact, and free to obtain. */
  reported: number;
}

/**
 * The most recent assistant message that reported real input usage. Everything
 * before it is already priced exactly by the provider; everything from it
 * onward is the only part still needing measurement.
 */
export function findLastPricedContextSplit(
  messages: AgentMessage[],
): PiPricedContextSplit | null {
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
    if (reported > 0) return { index, reported };
  }
  return null;
}

/**
 * Dynamic import rather than a module-level cache: the ES module registry
 * already memoizes this, so repeat calls are cheap without introducing
 * cross-request singleton state in a Worker isolate. Mirrors the
 * loadPiCompleteSimple pattern in ./pi-compaction.
 */
async function loadO200kEncoder(): Promise<((text: string) => number[]) | null> {
  try {
    const { encode } = await import("gpt-tokenizer/encoding/o200k_base");
    return typeof encode === "function" ? encode : null;
  } catch {
    return null;
  }
}

/**
 * BPE merging degrades quadratically on long runs of one repeated character.
 * Measured on o200k: 10K repeated chars take 33ms, 50K take 739ms, 100K take
 * 4.3s, and 400K did not finish inside a 115s test timeout — while 100K of real
 * high-entropy base64 takes 2.9ms. This is not a synthetic worry: a screenshot
 * with a large solid-colour region base64-encodes to exactly such a run, and a
 * single oversized tool result would otherwise stall the Durable Object.
 *
 * Runs are collapsed to a short sample before tokenizing and their cost added
 * arithmetically. Repeated characters measured a consistent 8 chars/token at
 * every length tested, so the substituted arithmetic tracks what the tokenizer
 * would have returned.
 */
const PI_REPEATED_RUN_MIN_LENGTH = 64;
const PI_REPEATED_RUN_CHARS_PER_TOKEN = 8;
const PI_REPEATED_RUN_PATTERN = /(.)\1{63,}/gs;

/**
 * Absolute backstop on how much text one message hands the tokenizer, in case
 * some other input shape is pathological in a way runs-collapsing misses.
 * Beyond this the measured rate of the sampled prefix is extrapolated.
 */
const PI_MAX_TOKENIZED_CHARS_PER_MESSAGE = 262_144;

export function collapsePiRepeatedRuns(text: string): {
  text: string;
  addedTokens: number;
} {
  if (text.length < PI_REPEATED_RUN_MIN_LENGTH) return { text, addedTokens: 0 };
  let addedTokens = 0;
  const collapsed = text.replace(PI_REPEATED_RUN_PATTERN, (run: string, char: string) => {
    addedTokens += Math.ceil(
      (run.length - PI_REPEATED_RUN_MIN_LENGTH) / PI_REPEATED_RUN_CHARS_PER_TOKEN,
    );
    return char.repeat(PI_REPEATED_RUN_MIN_LENGTH);
  });
  return { text: collapsed, addedTokens };
}

function countTextTokens(encode: (text: string) => number[], raw: string): number {
  const { text, addedTokens } = collapsePiRepeatedRuns(raw);
  if (text.length <= PI_MAX_TOKENIZED_CHARS_PER_MESSAGE) {
    return encode(text).length + addedTokens;
  }
  const sample = text.slice(0, PI_MAX_TOKENIZED_CHARS_PER_MESSAGE);
  const sampled = encode(sample).length;
  const scaled = Math.ceil(sampled * (text.length / sample.length));
  return scaled + addedTokens;
}

/**
 * Token count for `messages` using a real tokenizer. Resolves to null when the
 * tokenizer cannot be loaded, so callers fall back to the heuristic rather than
 * failing a turn over a measurement.
 */
export async function countPiContextTokensPrecise(
  messages: AgentMessage[],
): Promise<number | null> {
  const encode = await loadO200kEncoder();
  if (!encode) return null;
  try {
    let total = 0;
    for (const message of messages) {
      total += countTextTokens(encode, stringifyPiMessageForTokenCount(message));
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Best available measurement of what the next request will cost, in order of
 * trust: what the provider actually charged (exact, free), a real tokenizer
 * over the remainder (accurate, cheap because the remainder is small), then the
 * character heuristic (loose, but never worse than what we had).
 */
export async function measurePiContextTokens(
  messages: AgentMessage[],
  contextWindow: number,
): Promise<number> {
  const split = findLastPricedContextSplit(messages);
  if (split) {
    const tail = messages.slice(split.index);
    const measured = await countPiContextTokensPrecise(tail);
    return split.reported + (measured ?? estimatePiContextTokens(tail));
  }

  // Nothing priced yet — this is the opening of a thread, so the whole context
  // is normally small. Only reach for the tokenizer if the estimate suggests
  // otherwise (a very large first message or attachment).
  const heuristic = estimatePiContextTokens(messages);
  if (!shouldMeasurePiContextPrecisely(heuristic, contextWindow)) return heuristic;
  return (await countPiContextTokensPrecise(messages)) ?? heuristic;
}
