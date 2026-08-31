import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  BoundedTurnError,
  createBoundedTurnRunner,
  type BoundedContextTurn,
  type BoundedProviderStep,
  type BoundedTurnAdapter,
} from "../src/chat-thread/bounded-turn-runner";
import type { DurableTurnRunContext } from "../src/chat-thread/durable-turn-driver";
import type { DurableChatTurn } from "../src/chat-thread/durable-turn-store";
import {
  emptyTurnCheckpoint,
  type CheckpointProviderBatch,
  type CheckpointToolResult,
  type TurnCheckpoint,
} from "../src/chat-thread/turn-checkpoint";

const baseTurn: DurableChatTurn = {
  id: "turn:one",
  clientMessageId: "client:one",
  threadId: "thread:one",
  workspaceId: "workspace:one",
  orgId: "org:one",
  userId: "user:one",
  source: "web",
  userContent: "hello",
  userDisplay: "hello",
  status: "running",
  payloadBytes: 5,
  attemptCount: 1,
  attemptToken: "attempt:one",
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

function turnWith(checkpoint: TurnCheckpoint): DurableChatTurn {
  return { ...baseTurn, checkpoint };
}

function fakeAdapter(
  patch: Partial<BoundedTurnAdapter> = {},
): BoundedTurnAdapter {
  return {
    readContext: () => [],
    callProvider: async () => ({ kind: "assistant", content: "done" }),
    callTool: async () => null,
    ...patch,
  };
}

function input(
  patch: Partial<DurableTurnRunContext> = {},
): DurableTurnRunContext {
  return {
    turn: baseTurn,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
    startNextInference: async () => undefined,
    checkpointProviderBatch: async () => undefined,
    checkpointProviderFinal: async () => undefined,
    beginEffect: async () => undefined,
    recordToolResult: async () => undefined,
    publishLive: () => undefined,
    ...patch,
  };
}

function toolBatch(
  ids: readonly string[],
  name = "write_file",
): Extract<BoundedProviderStep, { kind: "tool_batch" }> {
  return {
    kind: "tool_batch",
    providerStateJson: JSON.stringify(
      ids.map((id) => ({ type: "toolCall", id, name, arguments: {} })),
    ),
    calls: ids.map((id) => ({ id, name, input: {} })),
  };
}

function checkpointBatch(ids: readonly string[]): CheckpointProviderBatch {
  const step = toolBatch(ids);
  return {
    providerStateJson: step.providerStateJson,
    calls: step.calls.map((call) => ({
      id: call.id,
      name: call.name,
      inputJson: JSON.stringify(call.input),
      effectStarted: false,
      result: null,
    })),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("bounded turn runner", () => {
  it("bounds newest context and checkpoints the final before returning", async () => {
    let countContext: readonly BoundedContextTurn[] = [];
    const final = vi.fn(async () => undefined);
    const countAdapter = fakeAdapter({
      readContext: async function* () {
        for (
          let index = 0;
          index < CHAT_RUNTIME_BOUNDS.contextMessages + 10;
          index += 1
        ) {
          yield { role: "user", content: `newest-${index}` } as const;
        }
      },
      callProvider: async ({ context }) => {
        countContext = context;
        return { kind: "assistant", content: "done" };
      },
    });
    await createBoundedTurnRunner(countAdapter)(
      input({ checkpointProviderFinal: final }),
    );

    expect(countContext).toHaveLength(CHAT_RUNTIME_BOUNDS.contextMessages);
    expect(countContext.at(-1)?.content).toBe("newest-0");
    expect(final).toHaveBeenCalledWith("done");

    let byteContext: readonly BoundedContextTurn[] = [];
    const large = "x".repeat(
      Math.floor(CHAT_RUNTIME_BOUNDS.contextBytes * 0.6),
    );
    const byteAdapter = fakeAdapter({
      readContext: () => [
        { role: "assistant", content: large },
        { role: "user", content: large },
      ],
      callProvider: async ({ context }) => {
        byteContext = context;
        return { kind: "assistant", content: "done" };
      },
    });
    await createBoundedTurnRunner(byteAdapter)(input());

    expect(byteContext).toHaveLength(1);
    expect(
      new TextEncoder().encode(JSON.stringify(byteContext)).byteLength,
    ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.contextBytes);
  });

  it("aborts one timed-out provider call and fences its late answer", async () => {
    vi.useFakeTimers();
    let clock = 0;
    let finish!: (value: { kind: "assistant"; content: string }) => void;
    let providerSignal: AbortSignal | undefined;
    const callProvider = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ kind: "assistant"; content: string }>((resolve) => {
          providerSignal = signal;
          finish = resolve;
        }),
    );
    const result = createBoundedTurnRunner(
      fakeAdapter({ callProvider }),
      () => clock,
    )(input({ deadlineAt: CHAT_RUNTIME_BOUNDS.turnLeaseMs }));
    await flush();

    const rejected = expect(result).rejects.toMatchObject<
      Partial<BoundedTurnError>
    >({ code: "provider_timeout" });
    clock = CHAT_RUNTIME_BOUNDS.providerDeadlineMs;
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.providerDeadlineMs);
    await rejected;

    expect(callProvider).toHaveBeenCalledOnce();
    expect(providerSignal?.aborted).toBe(true);
    finish({ kind: "assistant", content: "too late" });
    await flush();
    expect(callProvider).toHaveBeenCalledOnce();
  });

  it("checkpoints a whole parallel batch, then each matching result, before inference", async () => {
    const order: string[] = [];
    let providerCalls = 0;
    let replayed: readonly CheckpointProviderBatch[] = [];
    const results: CheckpointToolResult[] = [];
    const adapter = fakeAdapter({
      callProvider: async ({ toolBatches }) => {
        providerCalls += 1;
        order.push(`provider:${providerCalls}`);
        if (providerCalls === 1) return toolBatch(["call-a", "call-b"]);
        replayed = toolBatches;
        return { kind: "assistant", content: "done" };
      },
      callTool: async (call) => {
        order.push(`tool:${call.id}`);
        return { id: call.id };
      },
    });

    await createBoundedTurnRunner(adapter)(
      input({
        startNextInference: async () => order.push("start-provider"),
        checkpointProviderBatch: async (batch) => {
          order.push(`batch:${batch.calls.map((call) => call.id).join(",")}`);
        },
        beginEffect: async (id) => order.push(`begin:${id}`),
        recordToolResult: async (result) => {
          results.push(result);
          order.push(`result:${result.callId}`);
        },
      }),
    );

    expect(order).toEqual([
      "start-provider",
      "provider:1",
      "batch:call-a,call-b",
      "begin:call-a",
      "tool:call-a",
      "result:call-a",
      "begin:call-b",
      "tool:call-b",
      "result:call-b",
      "start-provider",
      "provider:2",
    ]);
    expect(results.map((result) => result.callId)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(replayed[0]?.calls.map((call) => call.result?.callId)).toEqual([
      "call-a",
      "call-b",
    ]);
  });

  it("checkpoints thrown tool values without invoking accessors or coercion", async () => {
    let reads = 0;
    const hostile = Object.defineProperties({}, {
      name: { get: () => { reads += 1; return "Hostile"; } },
      message: { get: () => { reads += 1; return "secret"; } },
      toString: { get: () => { reads += 1; return () => "secret"; } },
      toJSON: { get: () => { reads += 1; return () => "secret"; } },
    });
    let providerCalls = 0;
    const results: CheckpointToolResult[] = [];
    const adapter = fakeAdapter({
      callProvider: async () => {
        providerCalls += 1;
        return providerCalls === 1
          ? toolBatch(["call-error"])
          : { kind: "assistant", content: "continued" };
      },
      callTool: async () => { throw hostile; },
    });

    await createBoundedTurnRunner(adapter)(
      input({ recordToolResult: async (result) => { results.push(result); } }),
    );

    expect(reads).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "error" });
    expect(JSON.parse(results[0].output)).toEqual({
      message: "[object thrown]",
      name: "Error",
    });
    expect(new TextEncoder().encode(results[0].output).byteLength).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
  });

  it("rejects hostile tool inputs without materializing or invoking them", async () => {
    let reads = 0;
    const hostile = Object.defineProperties({
      huge: "x".repeat(CHAT_RUNTIME_BOUNDS.toolInputBytes * 4),
    }, {
      accessor: { enumerable: true, get: () => { reads += 1; return "secret"; } },
      toJSON: { get: () => { reads += 1; return () => ({ secret: true }); } },
    });

    await expect(
      createBoundedTurnRunner(fakeAdapter({
        callProvider: async () => ({
          kind: "tool_batch",
          providerStateJson: "[]",
          calls: [{ id: "hostile", name: "tool", input: hostile }],
        }),
      }))(input()),
    ).rejects.toMatchObject({ code: "tool_input_bytes" });
    expect(reads).toBe(0);
  });

  it("rejects an oversized provider call array before reading an entry", async () => {
    const touched = vi.fn();
    const calls: unknown[] = [];
    calls.length = CHAT_RUNTIME_BOUNDS.toolCallsPerTurn + 1;
    Object.defineProperty(calls, "0", { get: touched });

    await expect(createBoundedTurnRunner(fakeAdapter({
      callProvider: async () => ({
        kind: "tool_batch",
        providerStateJson: "[]",
        calls,
      }) as BoundedProviderStep,
    }))(input())).rejects.toMatchObject({ code: "invalid_provider_step" });
    expect(touched).not.toHaveBeenCalled();
  });

  it("paints provider deltas and tool milestones only behind durable checkpoints", async () => {
    const order: string[] = [];
    const painted: string[][] = [];
    let providerCalls = 0;
    const adapter = fakeAdapter({
      callProvider: async ({ onProgress }) => {
        providerCalls += 1;
        onProgress([
          { type: "text", text: providerCalls === 1 ? "Looking" : "Done" },
        ]);
        return providerCalls === 1
          ? toolBatch(["call-a"], "read_file")
          : { kind: "assistant", content: "Done" };
      },
      callTool: async () => ({ ok: true }),
    });

    await createBoundedTurnRunner(adapter)(
      input({
        checkpointProviderBatch: async () => order.push("batch-durable"),
        beginEffect: async () => order.push("effect-durable"),
        recordToolResult: async () => order.push("result-durable"),
        checkpointProviderFinal: async () => order.push("final-durable"),
        publishLive: (content) => {
          const labels = content.map((block) => block.type);
          painted.push(labels);
          if (order.at(-1) === "final-durable") order.push("paint-final");
          else if (content.at(-1)?.type === "text") order.push("paint-delta");
          else if (labels.includes("tool_result")) order.push("paint-result");
          else if (labels.includes("tool_use")) order.push("paint-tool");
        },
      }),
    );

    expect(order).toEqual([
      "paint-delta",
      "batch-durable",
      "paint-tool",
      "effect-durable",
      "result-durable",
      "paint-result",
      "paint-delta",
      "final-durable",
      "paint-final",
    ]);
    expect(painted.at(-1)).toEqual([
      "tool_use",
      "tool_result",
      "text",
    ]);
  });

  it("recovers an unstarted batch without repeating its provider response", async () => {
    const batch = checkpointBatch(["call-a", "call-b"]);
    const checkpoint: TurnCheckpoint = {
      ...emptyTurnCheckpoint(),
      providerCalls: 1,
      batches: [batch],
    };
    const callTool = vi.fn(async (call) => call.id);
    const callProvider = vi.fn(async () => ({
      kind: "assistant" as const,
      content: "continued",
    }));

    await createBoundedTurnRunner(fakeAdapter({ callTool, callProvider }))(
      input({ turn: turnWith(checkpoint) }),
    );

    expect(callTool.mock.calls.map(([call]) => call.id)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(callProvider).toHaveBeenCalledOnce();
  });

  it("recovers a closed batch without replaying any tool", async () => {
    const batch = checkpointBatch(["call-a", "call-b"]);
    for (const call of batch.calls) {
      call.effectStarted = true;
      call.result = { callId: call.id, status: "success", output: "1" };
    }
    const checkpoint: TurnCheckpoint = {
      ...emptyTurnCheckpoint(),
      providerCalls: 1,
      batches: [batch],
    };
    const callTool = vi.fn(async () => "replayed");
    let seen: readonly CheckpointProviderBatch[] = [];

    await createBoundedTurnRunner(
      fakeAdapter({
        callTool,
        callProvider: async ({ toolBatches }) => {
          seen = toolBatches;
          return { kind: "assistant", content: "continued" };
        },
      }),
    )(input({ turn: turnWith(checkpoint) }));

    expect(callTool).not.toHaveBeenCalled();
    expect(seen[0]?.calls.map((call) => call.result?.callId)).toEqual([
      "call-a",
      "call-b",
    ]);
  });

  it("never runs from an uncertain effect checkpoint", async () => {
    const batch = checkpointBatch(["call-a"]);
    batch.calls[0].effectStarted = true;
    const checkpoint: TurnCheckpoint = {
      ...emptyTurnCheckpoint(),
      providerCalls: 1,
      batches: [batch],
    };
    const callProvider = vi.fn();
    const callTool = vi.fn();

    await expect(
      createBoundedTurnRunner(fakeAdapter({ callProvider, callTool }))(
        input({ turn: turnWith(checkpoint) }),
      ),
    ).rejects.toMatchObject<Partial<BoundedTurnError>>({ code: "aborted" });
    expect(callProvider).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("records an observed tool failure as the matching terminal result", async () => {
    let calls = 0;
    const recorded = vi.fn(async () => undefined);
    await createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () =>
          ++calls === 1
            ? toolBatch(["call-a"])
            : { kind: "assistant", content: "handled" },
        callTool: async () => {
          throw new Error("tool failed");
        },
      }),
    )(input({ recordToolResult: recorded }));

    expect(recorded).toHaveBeenCalledOnce();
    expect(recorded.mock.calls[0][0]).toMatchObject({
      callId: "call-a",
      status: "error",
    });
    expect(JSON.parse(recorded.mock.calls[0][0].output)).toEqual({
      message: "tool failed",
      name: "Error",
    });
  });

  it("marks an effect before a tool and aborts a late tool result", async () => {
    vi.useFakeTimers();
    let clock = 0;
    const order: string[] = [];
    let finish!: (value: string) => void;
    let toolSignal: AbortSignal | undefined;
    const callTool = vi.fn(
      (_call: unknown, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          order.push("tool");
          toolSignal = signal;
          finish = resolve;
        }),
    );
    const result = createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () => toolBatch(["call-a"]),
        callTool,
      }),
      () => clock,
    )(
      input({
        deadlineAt: CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        beginEffect: async () => order.push("effect"),
      }),
    );
    await flush();

    expect(order).toEqual(["effect", "tool"]);
    const rejected = expect(result).rejects.toMatchObject<
      Partial<BoundedTurnError>
    >({ code: "tool_timeout" });
    clock = CHAT_RUNTIME_BOUNDS.toolDeadlineMs;
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.toolDeadlineMs);
    await rejected;

    expect(toolSignal?.aborted).toBe(true);
    finish("too late");
    await flush();
    expect(callTool).toHaveBeenCalledOnce();
  });

  it("executes no more than the tool-call cap", async () => {
    let providerCalls = 0;
    const beginEffect = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => "ok");
    const callProvider = vi.fn(async () =>
      toolBatch([`call-${providerCalls++}`]),
    );

    await expect(
      createBoundedTurnRunner(
        fakeAdapter({ callProvider, callTool }),
        () => 0,
      )(input({ beginEffect })),
    ).rejects.toMatchObject<Partial<BoundedTurnError>>({ code: "tool_limit" });
    expect(callTool).toHaveBeenCalledTimes(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn,
    );
    expect(beginEffect).toHaveBeenCalledTimes(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn,
    );
    expect(callProvider).toHaveBeenCalledTimes(
      CHAT_RUNTIME_BOUNDS.toolCallsPerTurn + 1,
    );
  });

  it("rejects oversized tool input before checkpointing a batch", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const beginEffect = vi.fn(async () => undefined);
    const callTool = vi.fn(async () => "should not run");
    const runner = createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () => ({
          kind: "tool_batch",
          providerStateJson: "[]",
          calls: [
            {
              id: "call-a",
              name: "write_file",
              input: {
                content: "x".repeat(CHAT_RUNTIME_BOUNDS.toolInputBytes),
              },
            },
          ],
        }),
        callTool,
      }),
    );

    await expect(
      runner(input({ checkpointProviderBatch: checkpoint, beginEffect })),
    ).rejects.toMatchObject<Partial<BoundedTurnError>>({
      code: "tool_input_bytes",
    });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(beginEffect).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("canonicalizes cyclic tool results without materializing them first", async () => {
    const cyclic: Record<string, unknown> = {
      count: 7n,
      missing: undefined,
    };
    cyclic.self = cyclic;
    let retained: CheckpointToolResult | undefined;
    let calls = 0;
    await createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () =>
          ++calls === 1
            ? toolBatch(["call-a"], "inspect")
            : { kind: "assistant", content: "done" },
        callTool: async () => cyclic,
      }),
    )(
      input({
        recordToolResult: async (result) => {
          retained = result;
        },
      }),
    );

    expect(JSON.parse(retained?.output ?? "null")).toMatchObject({
      $overflow: { stored: false, complete: false },
      preview: {
        count: "7n",
        missing: "[undefined]",
        self: "[Circular]",
      },
    });
  });

  it("bounds oversized tool results inside the aggregate checkpoint budget", async () => {
    let retained: CheckpointToolResult | undefined;
    let calls = 0;
    await createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () =>
          ++calls === 1
            ? toolBatch(["call-a"], "read")
            : { kind: "assistant", content: "done" },
        callTool: async () => ({
          content: "🦕".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes),
        }),
      }),
    )(
      input({
        recordToolResult: async (result) => {
          retained = result;
        },
      }),
    );

    const output = retained?.output ?? "";
    const encoded = new TextEncoder().encode(output);
    expect(encoded.byteLength).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(encoded),
    ).not.toThrow();
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it("externalizes complete results that no longer fit the turn aggregate", async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `call-${index}`);
    const retained: CheckpointToolResult[] = [];
    let replayed: readonly CheckpointProviderBatch[] = [];
    const overflowToolResult = vi.fn(async (call: { id: string }) => ({
      $overflow: {
        stored: true,
        complete: true,
        path: `tmp/${call.id}.json`,
      },
      hint: `Read tmp/${call.id}.json`,
      preview: { content: "x" },
    }));
    let providerCalls = 0;

    await createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async ({ toolBatches }) => {
          if (++providerCalls === 1) return toolBatch(ids, "read");
          replayed = toolBatches;
          return { kind: "assistant", content: "done" };
        },
        callTool: async () => ({
          content: "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes - 64),
        }),
        overflowToolResult,
      }),
    )(
      input({
        recordToolResult: async (result) => {
          retained.push(result);
        },
      }),
    );

    expect(overflowToolResult).toHaveBeenCalled();
    expect(retained).toHaveLength(ids.length);
    expect(
      retained.some((result) => result.output.includes('"$overflow"')),
    ).toBe(true);
    expect(
      replayed.at(-1)?.calls.some((call) =>
        call.result?.output.includes('"$overflow"'),
      ),
    ).toBe(true);
    expect(
      retained.reduce(
        (total, result) => total + new TextEncoder().encode(result.output).byteLength,
        0,
      ),
    ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes);
  });

  it("keeps a bounded explicit preview when overflow storage fails", async () => {
    let retained: CheckpointToolResult | undefined;
    let providerCalls = 0;
    await createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () =>
          ++providerCalls === 1
            ? toolBatch(["call-a"], "read")
            : { kind: "assistant", content: "done" },
        callTool: async () => "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes * 2),
        overflowToolResult: async () => {
          throw new Error("R2 unavailable");
        },
      }),
    )(
      input({
        recordToolResult: async (result) => {
          retained = result;
        },
      }),
    );

    const output = JSON.parse(retained?.output ?? "null") as Record<string, unknown>;
    expect(output.$overflow).toMatchObject({
      stored: false,
      complete: false,
    });
    expect(new TextEncoder().encode(retained?.output ?? "").byteLength)
      .toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes);
  });

  it("checkpoints a fallback and fences a late overflow result", async () => {
    vi.useFakeTimers();
    let clock = 0;
    let finish!: (value: unknown) => void;
    let overflowSignal: AbortSignal | undefined;
    let providerCalls = 0;
    const recorded = vi.fn(async (_result: CheckpointToolResult) => undefined);
    const run = createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () =>
          ++providerCalls === 1
            ? toolBatch(["call-a"], "read")
            : { kind: "assistant", content: "done" },
        callTool: async () => "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes * 2),
        overflowToolResult: (_call, _value, signal) =>
          new Promise((resolve) => {
            overflowSignal = signal;
            finish = resolve;
          }),
      }),
      () => clock,
    )(input({ deadlineAt: CHAT_RUNTIME_BOUNDS.turnLeaseMs, recordToolResult: recorded }));
    await flush();
    clock = CHAT_RUNTIME_BOUNDS.toolResultOverflowDeadlineMs;
    await vi.advanceTimersByTimeAsync(CHAT_RUNTIME_BOUNDS.toolResultOverflowDeadlineMs);

    await expect(run).resolves.toBe("done");
    expect(overflowSignal?.aborted).toBe(true);
    expect(recorded).toHaveBeenCalledOnce();
    expect(JSON.parse(recorded.mock.calls[0][0].output)).toMatchObject({
      $overflow: { stored: false, complete: false },
    });
    finish({ $overflow: { stored: true, complete: true, path: "tmp/late.json" } });
    await flush();
    expect(recorded).toHaveBeenCalledOnce();
  });

  it("truncates the final UTF-8 answer to the assistant-byte cap", async () => {
    const tooLarge = "🦕".repeat(CHAT_RUNTIME_BOUNDS.assistantBytes);
    const result = await createBoundedTurnRunner(
      fakeAdapter({
        callProvider: async () => ({ kind: "assistant", content: tooLarge }),
      }),
    )(input());

    expect(result.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.assistantBytes,
    );
  });

  it("propagates an external abort without retrying the provider", async () => {
    const controller = new AbortController();
    let finish!: (value: { kind: "assistant"; content: string }) => void;
    let providerSignal: AbortSignal | undefined;
    const callProvider = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ kind: "assistant"; content: string }>((resolve) => {
          providerSignal = signal;
          finish = resolve;
        }),
    );
    const result = createBoundedTurnRunner(fakeAdapter({ callProvider }))(
      input({ signal: controller.signal }),
    );
    await flush();
    const stopped = new Error("stopped");
    controller.abort(stopped);

    await expect(result).rejects.toBe(stopped);
    expect(providerSignal?.aborted).toBe(true);
    finish({ kind: "assistant", content: "late" });
    await flush();
    expect(callProvider).toHaveBeenCalledOnce();
  });
});
