import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { boundedCanonicalJsonResult } from "./bounded-canonical-json";
import {
  parseJsonBounded,
  type JsonPreflightLimits,
} from "./bounded-json-parse";
import { jsonStringByteLength, utf8ByteLength } from "./utf8-byte-length";

export type CheckpointToolResultStatus = "success" | "error";

export interface CheckpointToolResult {
  callId: string;
  status: CheckpointToolResultStatus;
  /** Bounded canonical JSON. */
  output: string;
}

export interface CheckpointToolCall {
  id: string;
  name: string;
  /** Exact bounded provider arguments as JSON. */
  inputJson: string;
  effectStarted: boolean;
  result: CheckpointToolResult | null;
}

export interface CheckpointProviderBatch {
  /** Bounded adapter-specific provider response state as JSON. */
  providerStateJson: string;
  calls: CheckpointToolCall[];
}

export interface TurnCheckpoint {
  version: 1;
  providerCalls: number;
  providerInFlight: boolean;
  batches: CheckpointProviderBatch[];
  final: string | null;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const bytes = utf8ByteLength;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const boundedId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= CHAT_RUNTIME_BOUNDS.identifierChars;
const checkpointJsonLimits: JsonPreflightLimits = {
  maxDepth: 8,
  maxTokens: 2_048,
  maxNodes: 1_024,
  maxEntries: 1_024,
  maxStrings: 768,
  maxStringCodeUnits: CHAT_RUNTIME_BOUNDS.checkpointBytes,
};
const embeddedJsonLimits = (
  maxStringCodeUnits: number,
): JsonPreflightLimits => ({
  maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
  maxTokens:
    4 *
      (CHAT_RUNTIME_BOUNDS.providerJsonNodes +
        CHAT_RUNTIME_BOUNDS.providerJsonEntries) +
    16,
  maxNodes:
    CHAT_RUNTIME_BOUNDS.providerJsonNodes +
    CHAT_RUNTIME_BOUNDS.providerJsonEntries,
  maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
  maxStrings:
    CHAT_RUNTIME_BOUNDS.providerJsonNodes +
    CHAT_RUNTIME_BOUNDS.providerJsonEntries,
  maxStringCodeUnits,
});
const validJson = (value: string, maximumBytes: number): boolean => {
  try {
    parseJsonBounded(value, embeddedJsonLimits(maximumBytes));
    return true;
  } catch {
    return false;
  }
};
const validProviderState = (value: string): boolean => {
  try {
    const parsed = parseJsonBounded(
      value,
      embeddedJsonLimits(CHAT_RUNTIME_BOUNDS.providerStateBytes),
    );
    return (
      Array.isArray(parsed) &&
      parsed.length <= CHAT_RUNTIME_BOUNDS.providerContentParts &&
      boundedCanonicalJsonResult(
        parsed,
        CHAT_RUNTIME_BOUNDS.providerStateBytes,
        {
          maxDepth: CHAT_RUNTIME_BOUNDS.providerJsonDepth,
          maxEntries: CHAT_RUNTIME_BOUNDS.providerJsonEntries,
          maxNodes: CHAT_RUNTIME_BOUNDS.providerJsonNodes,
        },
      ).complete
    );
  } catch {
    return false;
  }
};

function compactFinal(value: string): string | null {
  const encoded = new TextEncoder().encode(value);
  if (decoder.decode(encoded) !== value) return null;
  let binary = "";
  for (let offset = 0; offset < encoded.length; offset += 32_768) {
    binary += String.fromCharCode(...encoded.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function expandFinal(value: string): string {
  const binary = atob(value);
  if (btoa(binary) !== value) throw new Error("Invalid checkpoint final");
  const encoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    encoded[index] = binary.charCodeAt(index);
  }
  return decoder.decode(encoded);
}

export function emptyTurnCheckpoint(): TurnCheckpoint {
  return {
    version: 1,
    providerCalls: 0,
    providerInFlight: false,
    batches: [],
    final: null,
  };
}

export function checkpointClosed(checkpoint: TurnCheckpoint): boolean {
  return checkpoint.batches.every((batch) =>
    batch.calls.every((call) => call.result !== null),
  );
}

export function checkpointUncertain(checkpoint: TurnCheckpoint): boolean {
  return checkpoint.batches.some((batch) =>
    batch.calls.some((call) => call.effectStarted && call.result === null),
  );
}

export function serializeTurnCheckpoint(checkpoint: TurnCheckpoint): string {
  let serializable:
    | TurnCheckpoint
    | (Omit<TurnCheckpoint, "final"> & {
        final: null;
        finalUtf8Base64: string;
      }) = checkpoint;
  if (
    checkpoint.final !== null &&
    4 * Math.ceil(bytes(checkpoint.final) / 3) + 32 <
      jsonStringByteLength(checkpoint.final)
  ) {
    const encoded = compactFinal(checkpoint.final);
    if (encoded !== null) {
      serializable = {
        ...checkpoint,
        final: null,
        finalUtf8Base64: encoded,
      };
    }
  }
  const serialized = JSON.stringify(serializable);
  if (bytes(serialized) > CHAT_RUNTIME_BOUNDS.checkpointBytes) {
    throw new Error("Checkpoint exceeds byte limit");
  }
  return serialized;
}

/**
 * Validate and copy a checkpoint already held in memory.
 *
 * This is deliberately separate from parsing so a mutation can be checked
 * before persistence without materializing and reparsing a second JSON copy.
 */
export function normalizeTurnCheckpoint(value: unknown): TurnCheckpoint {
  if (!object(value)) throw new Error("Invalid checkpoint shape");
  const encodedFinal = value.finalUtf8Base64;
  if (
    value.version !== 1 ||
    !Number.isInteger(value.providerCalls) ||
    (value.providerCalls as number) < 0 ||
    (value.providerCalls as number) >
      CHAT_RUNTIME_BOUNDS.providerCallsPerTurn ||
    typeof value.providerInFlight !== "boolean" ||
    !Array.isArray(value.batches) ||
    value.batches.length > CHAT_RUNTIME_BOUNDS.toolCallsPerTurn ||
    (value.final !== null && typeof value.final !== "string") ||
    (encodedFinal !== undefined &&
      (value.final !== null ||
        typeof encodedFinal !== "string" ||
        encodedFinal.length >
          4 * Math.ceil(CHAT_RUNTIME_BOUNDS.assistantBytes / 3) + 4))
  ) {
    throw new Error("Invalid checkpoint shape");
  }
  let final = value.final as string | null;
  if (typeof encodedFinal === "string") {
    try {
      final = expandFinal(encodedFinal);
    } catch {
      throw new Error("Invalid checkpoint final");
    }
  }
  if (
    typeof final === "string" &&
    bytes(final) > CHAT_RUNTIME_BOUNDS.assistantBytes
  ) {
    throw new Error("Checkpoint final exceeds byte limit");
  }

  const ids = new Set<string>();
  let callCount = 0;
  let providerStateBytes = 0;
  let toolInputBytes = 0;
  let toolResultBytes = 0;
  let openBatch = false;
  const rawBatches = value.batches;
  const batches: CheckpointProviderBatch[] = rawBatches.map(
    (candidate, batchIndex) => {
      const providerStateLength =
        object(candidate) && typeof candidate.providerStateJson === "string"
          ? bytes(candidate.providerStateJson)
          : null;
      if (
        openBatch ||
        !object(candidate) ||
        typeof candidate.providerStateJson !== "string" ||
        providerStateLength === null ||
        providerStateLength > CHAT_RUNTIME_BOUNDS.providerStateBytes ||
        !validProviderState(candidate.providerStateJson) ||
        !Array.isArray(candidate.calls) ||
        candidate.calls.length === 0 ||
        candidate.calls.length >
          CHAT_RUNTIME_BOUNDS.toolCallsPerTurn - callCount
      ) {
        throw new Error("Invalid provider batch");
      }
      providerStateBytes += providerStateLength;
      if (providerStateBytes > CHAT_RUNTIME_BOUNDS.providerStatePerTurnBytes) {
        throw new Error(
          "Checkpoint provider state exceeds aggregate byte limit",
        );
      }
      callCount += candidate.calls.length;
      const calls: CheckpointToolCall[] = candidate.calls.map((item) => {
        if (
          !object(item) ||
          !boundedId(item.id) ||
          !boundedId(item.name) ||
          ids.has(item.id) ||
          typeof item.inputJson !== "string" ||
          typeof item.effectStarted !== "boolean"
        ) {
          throw new Error("Invalid checkpoint tool call");
        }
        const inputBytes = bytes(item.inputJson);
        if (
          inputBytes > CHAT_RUNTIME_BOUNDS.toolInputBytes ||
          !validJson(item.inputJson, CHAT_RUNTIME_BOUNDS.toolInputBytes)
        ) {
          throw new Error("Invalid checkpoint tool call");
        }
        toolInputBytes += inputBytes;
        if (toolInputBytes > CHAT_RUNTIME_BOUNDS.toolInputsPerTurnBytes) {
          throw new Error("Checkpoint tool inputs exceed aggregate byte limit");
        }
        ids.add(item.id);
        let result: CheckpointToolResult | null = null;
        if (item.result !== null) {
          if (
            !object(item.result) ||
            item.result.callId !== item.id ||
            (item.result.status !== "success" &&
              item.result.status !== "error") ||
            typeof item.result.output !== "string"
          ) {
            throw new Error("Invalid checkpoint tool result");
          }
          const resultBytes = bytes(item.result.output);
          if (
            resultBytes > CHAT_RUNTIME_BOUNDS.toolResultBytes ||
            !validJson(item.result.output, CHAT_RUNTIME_BOUNDS.toolResultBytes)
          ) {
            throw new Error("Invalid checkpoint tool result");
          }
          toolResultBytes += resultBytes;
          result = {
            callId: item.result.callId,
            status: item.result.status,
            output: item.result.output,
          };
          if (!item.effectStarted) {
            throw new Error("Tool result has no matching effect start");
          }
        } else {
          // Every unresolved call reserves a bounded overflow-reference stub,
          // so aggregate pressure can externalize a result and still close.
          toolResultBytes += CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes;
        }
        if (toolResultBytes > CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes) {
          throw new Error(
            "Checkpoint tool results exceed aggregate byte limit",
          );
        }
        return {
          id: item.id,
          name: item.name,
          inputJson: item.inputJson,
          effectStarted: item.effectStarted,
          result,
        };
      });
      openBatch = calls.some((call) => call.result === null);
      if (openBatch && batchIndex !== rawBatches.length - 1) {
        throw new Error("Only the latest provider batch may be open");
      }
      return { providerStateJson: candidate.providerStateJson, calls };
    },
  );
  if (
    callCount > CHAT_RUNTIME_BOUNDS.toolCallsPerTurn ||
    (value.providerCalls as number) <
      batches.length +
        (value.providerInFlight ? 1 : 0) +
        (final === null ? 0 : 1) ||
    (value.providerInFlight && (openBatch || final !== null)) ||
    (final !== null && openBatch)
  ) {
    throw new Error("Invalid checkpoint phase");
  }
  return {
    version: 1,
    providerCalls: value.providerCalls as number,
    providerInFlight: value.providerInFlight,
    batches,
    final,
  };
}

export function parseTurnCheckpoint(raw: string): TurnCheckpoint {
  if (bytes(raw) > CHAT_RUNTIME_BOUNDS.checkpointBytes) {
    throw new Error("Checkpoint exceeds byte limit");
  }
  let value: unknown;
  try {
    value = parseJsonBounded(raw, checkpointJsonLimits);
  } catch {
    throw new Error("Checkpoint is not JSON");
  }
  return normalizeTurnCheckpoint(value);
}
