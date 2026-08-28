import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { boundedCanonicalJsonResult } from "./bounded-canonical-json";
import type { DurableTurnRunContext } from "./durable-turn-driver";
import type { DurableChatTurn } from "./durable-turn-store";
import {
  checkpointClosed,
  checkpointUncertain,
  parseTurnCheckpoint,
  serializeTurnCheckpoint,
  type CheckpointProviderBatch,
  type CheckpointToolCall,
  type CheckpointToolResult,
  type CheckpointToolResultStatus,
  type TurnCheckpoint,
} from "./turn-checkpoint";
import {
  checkpointRuntimeContent,
  combineRuntimeContent,
  type ChatRuntimeContentBlock,
} from "./chat-runtime-content";
import { boundedErrorValue } from "./bounded-error-text";

export interface BoundedContextTurn {
  role: "user" | "assistant";
  content: string;
}

export interface BoundedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type BoundedToolResult = CheckpointToolResult;

export type BoundedProviderStep =
  | { kind: "assistant"; content: string }
  | {
      kind: "tool_batch";
      providerStateJson: string;
      calls: BoundedToolCall[];
    };

export interface BoundedTurnAdapter {
  /** Previous messages, newest first. The runner stops at the supplied limits. */
  readContext(
    turn: DurableChatTurn,
    limits: { messages: number; bytes: number },
    signal: AbortSignal,
  ): Iterable<BoundedContextTurn> | AsyncIterable<BoundedContextTurn>;
  callProvider(input: {
    turn: DurableChatTurn;
    context: readonly BoundedContextTurn[];
    toolBatches: readonly CheckpointProviderBatch[];
    signal: AbortSignal;
    /** Attempt-local presentation only; never awaited or checkpointed. */
    onProgress(content: readonly ChatRuntimeContentBlock[]): void;
  }): Promise<BoundedProviderStep>;
  callTool(call: BoundedToolCall, signal: AbortSignal): Promise<unknown>;
  /** Best-effort externalization when the durable result budget is smaller. */
  overflowToolResult?(
    call: BoundedToolCall, value: unknown, signal: AbortSignal
  ): Promise<unknown>;
}

export type BoundedTurnErrorCode =
  | "aborted"
  | "invalid_context"
  | "invalid_provider_step"
  | "checkpoint_bytes"
  | "provider_limit"
  | "provider_timeout"
  | "tool_input_bytes"
  | "tool_limit"
  | "tool_result_bytes"
  | "tool_timeout";

export class BoundedTurnError extends Error {
  constructor(
    readonly code: BoundedTurnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoundedTurnError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
const TOOL_RESULT_STUB_PLACEHOLDER = JSON.stringify("0".repeat(
  CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes - 2,
));

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new BoundedTurnError("aborted", "Turn was aborted");
}

async function withDeadline<T>(
  code: "provider_timeout" | "tool_timeout",
  limitMs: number,
  parent: AbortSignal,
  turnDeadlineAt: number,
  now: () => number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw abortError(parent);
  const controller = new AbortController();
  const deadlineAt = Math.min(turnDeadlineAt, now() + limitMs);
  const timeoutError = new BoundedTurnError(
    code,
    `${code.replace("_", " ")} expired`,
  );
  if (deadlineAt <= now()) {
    controller.abort(timeoutError);
    throw timeoutError;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectGate!: (reason: Error) => void;
  const onAbort = () => {
    const error = abortError(parent);
    controller.abort(error);
    rejectGate(error);
  };
  const gate = new Promise<never>((_, reject) => {
    rejectGate = reject;
    parent.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, deadlineAt - now());
  });
  const task = Promise.resolve().then(() => operation(controller.signal));
  task.catch(() => undefined); // A fenced late result must still be observed.
  try {
    return await Promise.race([task, gate]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
    if (!controller.signal.aborted) controller.abort();
  }
}

async function boundedContext(
  adapter: BoundedTurnAdapter,
  turn: DurableChatTurn,
  signal: AbortSignal,
): Promise<BoundedContextTurn[]> {
  const newest: BoundedContextTurn[] = [];
  let bytes = 2; // JSON array brackets.
  for await (const message of adapter.readContext(
    turn,
    {
      messages: CHAT_RUNTIME_BOUNDS.contextMessages,
      bytes: CHAT_RUNTIME_BOUNDS.contextBytes,
    },
    signal,
  )) {
    if (signal.aborted) throw abortError(signal);
    if (newest.length === CHAT_RUNTIME_BOUNDS.contextMessages) break;
    if (
      !message ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string"
    ) {
      throw new BoundedTurnError("invalid_context", "Invalid context message");
    }
    const copy = { role: message.role, content: message.content };
    const nextBytes =
      bytes + byteLength(JSON.stringify(copy)) + (newest.length ? 1 : 0);
    if (nextBytes > CHAT_RUNTIME_BOUNDS.contextBytes) break;
    newest.push(copy);
    bytes = nextBytes;
  }
  return newest.reverse();
}

function boundedOutput(content: string): string {
  const bytes = encoder.encode(content);
  if (bytes.byteLength <= CHAT_RUNTIME_BOUNDS.assistantBytes) return content;
  const suffix = "…";
  let kept = decoder
    .decode(
      bytes.slice(0, CHAT_RUNTIME_BOUNDS.assistantBytes - byteLength(suffix)),
    )
    .replace(/\uFFFD+$/, "");
  while (
    byteLength(kept) + byteLength(suffix) >
    CHAT_RUNTIME_BOUNDS.assistantBytes
  ) {
    kept = kept.slice(0, -1);
  }
  return kept + suffix;
}

function toolInputJson(call: BoundedToolCall): string {
  const result = boundedCanonicalJsonResult(
    call.input,
    CHAT_RUNTIME_BOUNDS.toolInputBytes,
    {
      maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
      maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
      maxNodes: CHAT_RUNTIME_BOUNDS.providerJsonNodes,
    },
  );
  if (!result.complete) {
    throw new BoundedTurnError(
      "tool_input_bytes",
      "Tool input is not bounded plain JSON",
    );
  }
  return result.json;
}

function assertProviderStep(step: BoundedProviderStep): void {
  if (step?.kind === "assistant" && typeof step.content === "string") return;
  if (
    step?.kind === "tool_batch" &&
    typeof step.providerStateJson === "string" &&
    Array.isArray(step.calls) &&
    step.calls.length > 0 &&
    step.calls.length <= CHAT_RUNTIME_BOUNDS.toolCallsPerTurn &&
    byteLength(step.providerStateJson) <= CHAT_RUNTIME_BOUNDS.providerStateBytes
  ) {
    try {
      JSON.parse(step.providerStateJson);
    } catch {
      throw new BoundedTurnError(
        "invalid_provider_step",
        "Provider state is not JSON",
      );
    }
    const ids = new Set<string>();
    for (const call of step.calls) {
      if (
        !call ||
        typeof call.id !== "string" ||
        !call.id ||
        call.id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
        ids.has(call.id) ||
        typeof call.name !== "string" ||
        !call.name ||
        call.name.length > CHAT_RUNTIME_BOUNDS.identifierChars
      ) {
        throw new BoundedTurnError(
          "invalid_provider_step",
          "Invalid provider tool call",
        );
      }
      ids.add(call.id);
    }
    return;
  }
  throw new BoundedTurnError("invalid_provider_step", "Invalid provider step");
}

function cloneCheckpoint(checkpoint: TurnCheckpoint): TurnCheckpoint {
  return parseTurnCheckpoint(serializeTurnCheckpoint(checkpoint));
}

function reservedCheckpoint(
  checkpoint: TurnCheckpoint,
  result?: CheckpointToolResult,
): TurnCheckpoint {
  const reserved = cloneCheckpoint(checkpoint);
  for (const batch of reserved.batches) {
    for (const call of batch.calls) {
      if (call.result === null) {
        call.result =
          result?.callId === call.id
            ? result
            : { callId: call.id, status: "error", output: TOOL_RESULT_STUB_PLACEHOLDER };
      }
    }
  }
  return reserved;
}

function assertClosable(checkpoint: TurnCheckpoint): void {
  try {
    serializeTurnCheckpoint(reservedCheckpoint(checkpoint));
  } catch {
    throw new BoundedTurnError(
      "checkpoint_bytes",
      "Provider batch cannot fit terminal tool results",
    );
  }
}

type PreparedCheckpointToolResult = { result: CheckpointToolResult; complete: boolean };

function checkpointToolResult(
  checkpoint: TurnCheckpoint,
  callId: string,
  status: CheckpointToolResultStatus,
  value: unknown,
): PreparedCheckpointToolResult {
  const usedResultBytes = checkpoint.batches.reduce(
    (total, batch) =>
      total +
      batch.calls.reduce(
        (sum, call) => sum + (call.result ? byteLength(call.result.output) : 0),
        0,
      ),
    0,
  );
  const unresolvedResults = checkpoint.batches.reduce(
    (total, batch) =>
      total + batch.calls.filter((call) => call.result === null).length,
    0,
  );
  const aggregateAvailable =
    CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes -
    usedResultBytes -
    Math.max(0, unresolvedResults - 1) *
      CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes;
  if (aggregateAvailable < 1) {
    throw new BoundedTurnError(
      "tool_result_bytes",
      "Tool-result budget is exhausted",
    );
  }
  const minimal = reservedCheckpoint(checkpoint, {
    callId,
    status,
    output: "0",
  });
  let available: number;
  try {
    available =
      CHAT_RUNTIME_BOUNDS.checkpointBytes -
      byteLength(serializeTurnCheckpoint(minimal));
  } catch {
    throw new BoundedTurnError(
      "checkpoint_bytes",
      "Tool result cannot fit its checkpoint",
    );
  }

  // A JSON value is stored inside a JSON string in the checkpoint. Two bytes
  // of outer representation are enough for every byte of the inner value.
  let budget = Math.min(
    CHAT_RUNTIME_BOUNDS.toolResultBytes,
    aggregateAvailable,
    Math.max(1, 1 + Math.floor(available / 2)),
  );
  for (;;) {
    const encoded = boundedCanonicalJsonResult(value, budget, {
      maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
      maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
      maxNodes: CHAT_RUNTIME_BOUNDS.providerJsonNodes,
    });
    const result = {
      callId,
      status,
      output: encoded.json,
    } satisfies CheckpointToolResult;
    try {
      serializeTurnCheckpoint(reservedCheckpoint(checkpoint, result));
      return { result, complete: encoded.complete };
    } catch {
      if (budget === 1) {
        throw new BoundedTurnError(
          "checkpoint_bytes",
          "Tool result cannot fit its checkpoint",
        );
      }
      budget = Math.max(1, Math.floor(budget / 2));
    }
  }
}

function providerBatch(
  checkpoint: TurnCheckpoint,
  step: Extract<BoundedProviderStep, { kind: "tool_batch" }>,
): CheckpointProviderBatch {
  const priorCallCount = checkpoint.batches.reduce(
    (count, batch) => count + batch.calls.length,
    0,
  );
  if (
    priorCallCount + step.calls.length >
    CHAT_RUNTIME_BOUNDS.toolCallsPerTurn
  ) {
    throw new BoundedTurnError("tool_limit", "Tool-call limit reached");
  }
  const priorProviderStateBytes = checkpoint.batches.reduce(
    (total, batch) => total + byteLength(batch.providerStateJson),
    0,
  );
  if (
    priorProviderStateBytes + byteLength(step.providerStateJson) >
    CHAT_RUNTIME_BOUNDS.providerStatePerTurnBytes
  ) {
    throw new BoundedTurnError(
      "checkpoint_bytes",
      "Provider-state budget is exhausted",
    );
  }
  const priorInputBytes = checkpoint.batches.reduce(
    (total, batch) =>
      total +
      batch.calls.reduce((sum, call) => sum + byteLength(call.inputJson), 0),
    0,
  );
  const serializedCalls = step.calls.map((call) => ({
    call,
    inputJson: toolInputJson(call),
  }));
  if (
    priorInputBytes +
      serializedCalls.reduce(
        (total, entry) => total + byteLength(entry.inputJson),
        0,
      ) >
    CHAT_RUNTIME_BOUNDS.toolInputsPerTurnBytes
  ) {
    throw new BoundedTurnError(
      "tool_input_bytes",
      "Cumulative tool-input budget is exhausted",
    );
  }
  const usedResultBytes = checkpoint.batches.reduce(
    (total, batch) =>
      total +
      batch.calls.reduce(
        (sum, call) => sum + (call.result ? byteLength(call.result.output) : 0),
        0,
      ),
    0,
  );
  if (
    usedResultBytes +
      step.calls.length * CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes >
    CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes
  ) {
    throw new BoundedTurnError(
      "tool_result_bytes",
      "Tool-result budget cannot admit another batch",
    );
  }
  const priorIds = new Set(
    checkpoint.batches.flatMap((batch) => batch.calls.map((call) => call.id)),
  );
  const calls: CheckpointToolCall[] = serializedCalls.map(({ call, inputJson }) => {
    if (priorIds.has(call.id)) {
      throw new BoundedTurnError(
        "invalid_provider_step",
        "Provider reused a tool-call id",
      );
    }
    priorIds.add(call.id);
    return {
      id: call.id,
      name: call.name,
      inputJson,
      effectStarted: false,
      result: null,
    };
  });
  return { providerStateJson: step.providerStateJson, calls };
}

function toolErrorValue(error: unknown): unknown {
  return boundedErrorValue(error, CHAT_RUNTIME_BOUNDS.toolResultBytes);
}

function unavailableOverflowValue(value: unknown): unknown {
  const preview = boundedCanonicalJsonResult(
    value, Math.floor(CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes / 2),
    {
      maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
      maxEntries: Math.floor(CHAT_RUNTIME_BOUNDS.providerJsonEntries / 2),
      maxNodes: Math.floor(CHAT_RUNTIME_BOUNDS.providerJsonNodes / 2),
    },
  );
  return {
    $overflow: { stored: false, complete: false,
      reason: "temporary overflow storage unavailable" },
    hint: "Output was truncated inline and could not be stored temporarily.",
    preview: JSON.parse(preview.json),
  };
}

function minimalOverflowValue(): unknown {
  return {
    $overflow: { stored: false, complete: false, reason: "result budget exhausted" },
    hint: "Output could not fit inline or in temporary overflow storage.",
    preview: null,
  };
}

/** One initial attempt plus one checkpoint-only recovery, both absolutely bounded. */
export function createBoundedTurnRunner(
  adapter: BoundedTurnAdapter,
  now: () => number = Date.now,
): (input: DurableTurnRunContext) => Promise<string> {
  if (
    CHAT_RUNTIME_BOUNDS.recoveryAttempts !== 1 ||
    CHAT_RUNTIME_BOUNDS.attemptsPerTurn !== 2
  ) {
    throw new Error("Bounded turn runner requires exactly one recovery");
  }
  return async ({
    turn,
    signal,
    deadlineAt,
    startNextInference,
    checkpointProviderBatch,
    checkpointProviderFinal,
    beginEffect,
    recordToolResult,
    publishLive,
  }) => {
    const context = await boundedContext(adapter, turn, signal);
    const checkpoint = cloneCheckpoint(turn.checkpoint);
    const paintCheckpoint = () =>
      publishLive(checkpointRuntimeContent(checkpoint));

    if (checkpoint.final !== null) return checkpoint.final;
    if (checkpoint.providerInFlight || checkpointUncertain(checkpoint)) {
      throw new BoundedTurnError(
        "aborted",
        "Turn cannot run from an unsafe checkpoint",
      );
    }
    if (checkpoint.batches.length) paintCheckpoint();

    for (;;) {
      const pending = checkpoint.batches
        .at(-1)
        ?.calls.find((call) => call.result === null);
      if (pending) {
        const call: BoundedToolCall = {
          id: pending.id,
          name: pending.name,
          input: JSON.parse(pending.inputJson),
        };
        await beginEffect(call.id);
        pending.effectStarted = true;

        let status: CheckpointToolResultStatus = "success";
        let value: unknown;
        try {
          value = await withDeadline(
            "tool_timeout",
            CHAT_RUNTIME_BOUNDS.toolDeadlineMs,
            signal,
            deadlineAt,
            now,
            (toolSignal) => adapter.callTool(call, toolSignal),
          );
        } catch (error) {
          if (
            signal.aborted ||
            (error instanceof BoundedTurnError &&
              (error.code === "aborted" || error.code === "tool_timeout"))
          ) {
            throw error;
          }
          status = "error";
          value = toolErrorValue(error);
        }
        const prepare = (nextValue: unknown) =>
          checkpointToolResult(checkpoint, call.id, status, nextValue);
        let prepared = prepare(value);
        if (!prepared.complete) {
          let overflow = unavailableOverflowValue(value);
          if (adapter.overflowToolResult) {
            try {
              overflow = await withDeadline(
                "tool_timeout",
                CHAT_RUNTIME_BOUNDS.toolResultOverflowDeadlineMs,
                signal,
                deadlineAt,
                now,
                (overflowSignal) =>
                  adapter.overflowToolResult!(call, value, overflowSignal),
              );
            } catch {
              if (signal.aborted) throw abortError(signal);
            }
          }
          prepared = prepare(overflow);
          if (!prepared.complete) {
            prepared = prepare(minimalOverflowValue());
          }
          if (!prepared.complete) {
            throw new BoundedTurnError(
              "tool_result_bytes",
              "Tool-result overflow reference cannot fit its checkpoint",
            );
          }
        }
        const result = prepared.result;
        await recordToolResult(result);
        pending.result = result;
        paintCheckpoint();
        continue;
      }

      if (!checkpointClosed(checkpoint)) {
        throw new BoundedTurnError("aborted", "Checkpoint batch is incomplete");
      }
      if (
        checkpoint.providerCalls >= CHAT_RUNTIME_BOUNDS.providerCallsPerTurn
      ) {
        throw new BoundedTurnError(
          "provider_limit",
          "Provider-call limit reached",
        );
      }
      await startNextInference();
      checkpoint.providerCalls += 1;
      checkpoint.providerInFlight = true;
      const durableTrace = checkpointRuntimeContent(checkpoint);
      const step = await withDeadline(
        "provider_timeout",
        CHAT_RUNTIME_BOUNDS.providerDeadlineMs,
        signal,
        deadlineAt,
        now,
        (providerSignal) =>
          adapter.callProvider({
            turn,
            context,
            toolBatches: cloneCheckpoint(checkpoint).batches,
            signal: providerSignal,
            onProgress: (content) =>
              publishLive(combineRuntimeContent(durableTrace, content)),
          }),
      );
      assertProviderStep(step);
      if (step.kind === "assistant") {
        const output = boundedOutput(step.content);
        await checkpointProviderFinal(output);
        checkpoint.providerInFlight = false;
        checkpoint.final = output;
        paintCheckpoint();
        return output;
      }
      const batch = providerBatch(checkpoint, step);
      checkpoint.providerInFlight = false;
      checkpoint.batches.push(batch);
      assertClosable(checkpoint);
      await checkpointProviderBatch(batch);
      paintCheckpoint();
    }
  };
}
