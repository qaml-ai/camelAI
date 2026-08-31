import { describe, expect, it } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import { boundCodeModeToolResult } from "../src/code-mode-tools";
import { createBoundedTurnRunner } from "../src/chat-thread/bounded-turn-runner";
import {
  checkpointRuntimeContent,
  parseRuntimeContent,
  serializeRuntimeContent,
  type ChatRuntimeContentBlock,
} from "../src/chat-thread/chat-runtime-content";
import type { DurableTurnRunContext } from "../src/chat-thread/durable-turn-driver";
import type { DurableChatTurn } from "../src/chat-thread/durable-turn-store";
import { checkpointToolHistory } from "../src/chat-thread/pi-turn-adapter";
import {
  emptyTurnCheckpoint,
  parseTurnCheckpoint,
  serializeTurnCheckpoint,
  type CheckpointProviderBatch,
  type CheckpointToolResult,
  type TurnCheckpoint,
} from "../src/chat-thread/turn-checkpoint";

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;

function providerBatch(callCount: number) {
  const calls = Array.from({ length: callCount }, (_, index) => ({
    id: `memory-call-${index}`,
    name: "memory_probe",
    input: { index },
  }));
  return {
    kind: "tool_batch" as const,
    providerStateJson: JSON.stringify(
      calls.map((call) => ({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.input,
      })),
    ),
    calls,
  };
}

function stressValues(): unknown[] {
  const hugeEscaped = "🦕\u0000".repeat(
    Math.ceil(CHAT_RUNTIME_BOUNDS.liveMessageBytes / 5),
  );

  let deep: unknown = { leaf: true };
  for (
    let depth = 0;
    depth < CHAT_RUNTIME_BOUNDS.providerJsonDepth + 2_000;
    depth += 1
  ) {
    deep = { depth, next: deep };
  }

  const broad: Record<string, unknown> = {};
  for (
    let index = 0;
    index < CHAT_RUNTIME_BOUNDS.providerJsonEntries * 4;
    index += 1
  ) {
    broad[`field_${index.toString().padStart(5, "0")}`] = `value-${index}`;
  }

  const binary = new Uint8Array(CHAT_RUNTIME_BOUNDS.toolResultBytes * 4);
  for (let index = 0; index < binary.length; index += 1) {
    binary[index] = index % 251;
  }

  return [
    { kind: "huge-string", value: hugeEscaped },
    { kind: "deep-object", value: deep },
    { kind: "broad-object", value: broad },
    { kind: "binary-like", value: binary },
  ];
}

function runningTurn(): DurableChatTurn {
  return {
    id: "memory-turn",
    clientMessageId: "memory-client-message",
    threadId: "memory-thread",
    workspaceId: "memory-workspace",
    orgId: "memory-org",
    userId: "memory-user",
    source: "web",
    userContent: "exercise every result bound",
    userDisplay: "exercise every result bound",
    status: "running",
    payloadBytes: 27,
    attemptCount: 1,
    attemptToken: "memory-attempt",
    leaseExpiresAt: CHAT_RUNTIME_BOUNDS.turnLeaseMs,
    terminalDeadlineAt: CHAT_RUNTIME_BOUNDS.turnLeaseMs,
    effectStarted: false,
    checkpoint: emptyTurnCheckpoint(),
    assistantFinal: null,
    assistantError: null,
    assistantRenderJson: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("chat runtime high-memory bounds", () => {
  it("bounds a raw tool result before downstream copies and ignores accessors", () => {
    let reads = 0;
    const raw = {
      huge: "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes * 4),
      get secret() {
        reads += 1;
        return "not read";
      },
    };

    const bounded = boundCodeModeToolResult(raw);

    expect(reads).toBe(0);
    expect(bytes(JSON.stringify(bounded))).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
  });

  it("preserves an inline image that fits the tool-result budget", () => {
    const data = "A".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes / 2);
    const bounded = boundCodeModeToolResult({
      content: [
        { type: "text", text: "Read image" },
        { type: "image", data, mimeType: "image/png" },
      ],
      text: "Read image",
    }) as { content: Array<Record<string, unknown>> };

    expect(bounded.content[1]).toEqual({
      data,
      mimeType: "image/png",
      type: "image",
    });
    expect(bytes(JSON.stringify(bounded))).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
  });

  it("bounds repeated heterogeneous tool output across every runtime view", async () => {
    const values = stressValues();
    const batch = providerBatch(CHAT_RUNTIME_BOUNDS.toolCallsPerTurn);
    const storedSizes: number[] = [];
    const recordedResults: CheckpointToolResult[] = [];
    const liveFrames: ChatRuntimeContentBlock[][] = [];
    let durable: TurnCheckpoint = emptyTurnCheckpoint();
    let providerBatches: readonly CheckpointProviderBatch[] = [];
    let providerCalls = 0;

    const commit = (next: TurnCheckpoint): void => {
      const serialized = serializeTurnCheckpoint(next);
      storedSizes.push(bytes(serialized));
      durable = parseTurnCheckpoint(serialized);
    };
    const currentCall = (callId: string) => {
      for (const candidate of durable.batches) {
        const call = candidate.calls.find((item) => item.id === callId);
        if (call) return call;
      }
      throw new Error(`missing durable call ${callId}`);
    };

    const adapter = {
      readContext: () => [],
      callProvider: async ({
        toolBatches,
        onProgress,
      }: Parameters<
        Parameters<typeof createBoundedTurnRunner>[0]["callProvider"]
      >[0]) => {
        providerCalls += 1;
        onProgress([
          { type: "thinking", thinking: `provider-pass-${providerCalls}` },
          {
            type: "text",
            text: (values[0] as { value: string }).value,
          },
        ]);
        if (providerCalls === 1) return batch;
        providerBatches = toolBatches;
        return { kind: "assistant" as const, content: "bounded final" };
      },
      callTool: async (call: { id: string }) => {
        const index = Number(call.id.slice("memory-call-".length));
        return values[index % values.length];
      },
    };

    const callbacks: DurableTurnRunContext = {
      turn: runningTurn(),
      signal: new AbortController().signal,
      deadlineAt: Date.now() + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
      startNextInference: async () => {
        commit({
          ...durable,
          providerCalls: durable.providerCalls + 1,
          providerInFlight: true,
        });
      },
      checkpointProviderBatch: async (nextBatch) => {
        commit({
          ...durable,
          providerInFlight: false,
          batches: [...durable.batches, nextBatch],
        });
      },
      checkpointProviderFinal: async (output) => {
        commit({ ...durable, providerInFlight: false, final: output });
      },
      beginEffect: async (callId) => {
        const next = parseTurnCheckpoint(serializeTurnCheckpoint(durable));
        durable = next;
        currentCall(callId).effectStarted = true;
        commit(durable);
      },
      recordToolResult: async (result) => {
        const next = parseTurnCheckpoint(serializeTurnCheckpoint(durable));
        durable = next;
        currentCall(result.callId).result = result;
        recordedResults.push(result);
        commit(durable);
      },
      publishLive: (content) => {
        liveFrames.push([...content]);
      },
    };

    await expect(createBoundedTurnRunner(adapter)(callbacks)).resolves.toBe(
      "bounded final",
    );

    expect(recordedResults).toHaveLength(CHAT_RUNTIME_BOUNDS.toolCallsPerTurn);
    expect(providerBatches).toHaveLength(1);
    expect(providerBatches[0].calls).toHaveLength(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn,
    );
    expect(bytes(providerBatches[0].providerStateJson)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.providerStateBytes,
    );
    expect(JSON.parse(providerBatches[0].providerStateJson)).toHaveLength(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn,
    );

    for (const result of recordedResults) {
      expect(bytes(result.output)).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.toolResultBytes,
      );
      expect(() => JSON.parse(result.output)).not.toThrow();
    }
    expect(JSON.parse(recordedResults[1].output)).toMatchObject({
      $overflow: { stored: false, complete: false },
    });
    expect(
      Object.keys(JSON.parse(recordedResults[3].output) as object).length,
    ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.providerJsonEntries);

    expect(storedSizes.length).toBeGreaterThan(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn * 2,
    );
    expect(Math.max(...storedSizes)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.checkpointBytes,
    );
    const stored = serializeTurnCheckpoint(durable);
    expect(bytes(stored)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.checkpointBytes,
    );
    expect(parseTurnCheckpoint(stored).final).toBe("bounded final");

    expect(liveFrames.length).toBeGreaterThan(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn,
    );
    for (const content of liveFrames) {
      expect(content.length).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.liveContentBlocks,
      );
      expect(bytes(JSON.stringify(content))).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.liveMessageBytes,
      );
      for (const block of content) {
        if (block.type === "tool_result") {
          expect(bytes(block.content)).toBeLessThanOrEqual(
            CHAT_RUNTIME_BOUNDS.toolResultBytes,
          );
        }
      }
    }
    const durableOnlyFrames = liveFrames.filter(
      (content) => content.at(-1)?.type !== "text",
    );
    expect(durableOnlyFrames.length).toBeGreaterThan(0);
    for (const content of durableOnlyFrames) {
      expect(bytes(JSON.stringify(content))).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.liveTraceBytes,
      );
    }

    const terminal = checkpointRuntimeContent(durable);
    const terminalJson = serializeRuntimeContent(terminal);
    const restored = parseRuntimeContent(terminalJson);
    expect(bytes(terminalJson)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.liveMessageBytes,
    );
    expect(restored).not.toBeNull();
    expect(restored?.length).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.liveContentBlocks,
    );
    expect(restored?.at(-1)).toEqual({
      type: "text",
      text: "bounded final",
    });
    const uses = new Set(
      restored
        ?.filter((block) => block.type === "tool_use")
        .map((block) => block.id),
    );
    for (const block of restored ?? []) {
      if (block.type === "tool_result") {
        expect(uses.has(block.tool_use_id)).toBe(true);
      }
    }

    const providerHistory = checkpointToolHistory(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "memory-model",
      } as never,
      providerBatches,
    );
    expect(providerHistory).toHaveLength(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn + providerBatches.length,
    );
    const providerResultBytes = providerBatches[0].calls.reduce(
      (total, call) => total + bytes(call.result?.output ?? ""),
      0,
    );
    expect(providerResultBytes).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes,
    );
    expect(bytes(JSON.stringify(providerHistory))).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.checkpointBytes,
    );
  });
});
