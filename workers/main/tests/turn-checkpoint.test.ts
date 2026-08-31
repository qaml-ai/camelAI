import { describe, expect, it } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import { parseTurnCheckpoint } from "../src/chat-thread/turn-checkpoint";

const jsonWithBytes = (size: number): string => {
  if (size === 1) return "0";
  if (size < 2) throw new Error("JSON size must be positive");
  return `"${"x".repeat(size - 2)}"`;
};

const jsonChunks = (totalBytes: number, maximumBytes: number): string[] => {
  const chunks: string[] = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    const size = Math.min(remaining, maximumBytes);
    chunks.push(jsonWithBytes(size));
    remaining -= size;
  }
  return chunks;
};
const providerJsonWithBytes = (size: number): string =>
  `[${jsonWithBytes(size - 2)}]`;

const completedCall = (
  id: string,
  inputJson = "{}",
  output = "0",
) => ({
  id,
  name: "bounded_tool",
  inputJson,
  effectStarted: true,
  result: { callId: id, status: "success", output },
});

const batch = (
  id: string,
  providerStateJson: string,
  calls = [completedCall(id)],
) => ({ providerStateJson, calls });

const checkpointJson = (batches: ReturnType<typeof batch>[]): string =>
  JSON.stringify({
    version: 1,
    providerCalls: batches.length,
    providerInFlight: false,
    batches,
    final: null,
  });

describe("turn checkpoint recovery bounds", () => {
  it("rejects 33 calls in one batch before accepting the batch", () => {
    const calls = Array.from(
      { length: CHAT_RUNTIME_BOUNDS.toolCallsPerTurn + 1 },
      (_, index) => completedCall(`call-${index}`),
    );

    expect(() =>
      parseTurnCheckpoint(checkpointJson([batch("batch", "[]", calls)])),
    ).toThrow("Invalid provider batch");
  });

  it("enforces the aggregate provider-state byte limit", () => {
    const exact = jsonChunks(
      CHAT_RUNTIME_BOUNDS.providerStatePerTurnBytes,
      CHAT_RUNTIME_BOUNDS.providerStateBytes,
    ).map((state, index) =>
      batch(`call-${index}`, providerJsonWithBytes(state.length)),
    );

    expect(parseTurnCheckpoint(checkpointJson(exact)).batches).toHaveLength(
      exact.length,
    );
    expect(() =>
      parseTurnCheckpoint(
        checkpointJson([
          ...exact,
          batch("call-over", "[]"),
        ]),
      ),
    ).toThrow("Checkpoint provider state exceeds aggregate byte limit");
  });

  it("rejects structurally excessive recovered provider state", () => {
    const tooManyParts = Array.from(
      { length: CHAT_RUNTIME_BOUNDS.providerContentParts + 1 },
      () => null,
    );
    let tooDeep: unknown = null;
    for (
      let depth = 0;
      depth <= CHAT_RUNTIME_BOUNDS.providerJsonDepth;
      depth += 1
    ) {
      tooDeep = [tooDeep];
    }

    for (const state of [tooManyParts, [tooDeep]]) {
      expect(() =>
        parseTurnCheckpoint(
          checkpointJson([batch("call", JSON.stringify(state))]),
        ),
      ).toThrow("Invalid provider batch");
    }
  });

  it("enforces the aggregate tool-input byte limit", () => {
    const callsAtLimit = jsonChunks(
      CHAT_RUNTIME_BOUNDS.toolInputsPerTurnBytes,
      CHAT_RUNTIME_BOUNDS.toolInputBytes,
    ).map((input, index) => completedCall(`call-${index}`, input));

    expect(
      parseTurnCheckpoint(
        checkpointJson([batch("batch", "[]", callsAtLimit)]),
      ).batches[0].calls,
    ).toHaveLength(callsAtLimit.length);
    expect(() =>
      parseTurnCheckpoint(
        checkpointJson([
          batch("batch", "[]", [
            ...callsAtLimit,
            completedCall("call-over", jsonWithBytes(1)),
          ]),
        ]),
      ),
    ).toThrow("Checkpoint tool inputs exceed aggregate byte limit");
  });

  it("enforces the aggregate tool-result byte limit", () => {
    const callsAtLimit = jsonChunks(
      CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes,
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    ).map((output, index) => completedCall(`call-${index}`, "{}", output));

    expect(
      parseTurnCheckpoint(
        checkpointJson([batch("batch", "[]", callsAtLimit)]),
      ).batches[0].calls,
    ).toHaveLength(callsAtLimit.length);
    expect(() =>
      parseTurnCheckpoint(
        checkpointJson([
          batch("batch", "[]", [
            ...callsAtLimit,
            completedCall("call-over", "{}", jsonWithBytes(1)),
          ]),
        ]),
      ),
    ).toThrow("Checkpoint tool results exceed aggregate byte limit");
  });
});
