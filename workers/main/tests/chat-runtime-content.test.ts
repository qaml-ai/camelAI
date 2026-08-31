import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  checkpointRuntimeContent,
  combineRuntimeContent,
  parseRuntimeContent,
  serializeRuntimeContent,
  type ChatRuntimeContentBlock,
} from "../src/chat-thread/chat-runtime-content";
import type { TurnCheckpoint } from "../src/chat-thread/turn-checkpoint";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

function checkpoint(): TurnCheckpoint {
  return {
    version: 1,
    providerCalls: 2,
    providerInFlight: false,
    batches: [
      {
        providerStateJson: JSON.stringify([
          {
            type: "thinking",
            thinking: "First inspect the file.",
            thinkingSignature: "signed",
          },
          { type: "text", text: "I will inspect it." },
          {
            type: "toolCall",
            id: "call-a",
            name: "read_file",
            arguments: { path: "a.ts" },
          },
          {
            type: "toolCall",
            id: "call-b",
            name: "read_file",
            arguments: { path: "b.ts" },
          },
        ]),
        calls: [
          {
            id: "call-a",
            name: "read_file",
            inputJson: '{"path":"a.ts"}',
            effectStarted: true,
            result: {
              callId: "call-a",
              status: "success",
              output: '{"contents":"export const a = 1"}',
            },
          },
          {
            id: "call-b",
            name: "read_file",
            inputJson: '{"path":"b.ts"}',
            effectStarted: false,
            result: null,
          },
        ],
      },
    ],
    final: null,
  };
}

describe("chat runtime content", () => {
  it("projects durable provider batches and only completed tool results", () => {
    expect(checkpointRuntimeContent(checkpoint())).toEqual([
      {
        type: "thinking",
        thinking: "First inspect the file.",
        signature: "signed",
      },
      { type: "text", text: "I will inspect it." },
      {
        type: "tool_use",
        id: "call-a",
        name: "read_file",
        input: { path: "a.ts" },
      },
      {
        type: "tool_result",
        tool_use_id: "call-a",
        content: '{"contents":"export const a = 1"}',
        is_error: false,
      },
      {
        type: "tool_use",
        id: "call-b",
        name: "read_file",
        input: { path: "b.ts" },
      },
    ]);
  });

  it("appends a terminal answer after the durable trace", () => {
    const value = checkpoint();
    value.final = "The issue is fixed.";

    expect(checkpointRuntimeContent(value).at(-1)).toEqual({
      type: "text",
      text: "The issue is fixed.",
    });
  });

  it("combines durable trace with current provider text and thinking only", () => {
    const trace = checkpointRuntimeContent(checkpoint());
    const current: ChatRuntimeContentBlock[] = [
      { type: "thinking", thinking: "Now compare both files." },
      { type: "text", text: "The difference is" },
      {
        type: "tool_use",
        id: "not-durable",
        name: "read_file",
        input: { path: "c.ts" },
      },
    ];

    const combined = combineRuntimeContent(trace, current);
    expect(combined.slice(0, trace.length)).toEqual(trace);
    expect(combined.slice(trace.length)).toEqual(current.slice(0, 2));
  });

  it("round-trips the separately stored terminal render artifact", () => {
    const value = checkpoint();
    value.batches[0].calls[1].effectStarted = true;
    value.batches[0].calls[1].result = {
      callId: "call-b",
      status: "error",
      output: JSON.stringify("file disappeared"),
    };
    value.final = "I recovered safely.";
    const content = checkpointRuntimeContent(value);

    const serialized = serializeRuntimeContent(content);
    expect(bytes(serialized)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.liveMessageBytes,
    );
    expect(parseRuntimeContent(serialized)).toEqual(content);
    expect(content).toContainEqual({
      type: "tool_result",
      tool_use_id: "call-b",
      content: "file disappeared",
      is_error: true,
    });
  });

  it("refuses malformed, oversized, and over-count stored artifacts", () => {
    expect(parseRuntimeContent("not json")).toBeNull();
    expect(
      parseRuntimeContent('{"type":"text","text":"wrong root"}'),
    ).toBeNull();
    expect(
      parseRuntimeContent('[{"type":"thinking","thinking":"x","signature":7}]'),
    ).toBeNull();
    expect(
      parseRuntimeContent(
        JSON.stringify(
          Array.from(
            { length: CHAT_RUNTIME_BOUNDS.liveContentBlocks + 1 },
            () => ({ type: "text", text: "x" }),
          ),
        ),
      ),
    ).toBeNull();
    expect(
      parseRuntimeContent(" ".repeat(CHAT_RUNTIME_BOUNDS.liveMessageBytes + 1)),
    ).toBeNull();
    let tooDeep = "0";
    for (
      let depth = 0;
      depth < CHAT_RUNTIME_BOUNDS.providerJsonDepth + 2;
      depth += 1
    ) {
      tooDeep = `[${tooDeep}]`;
    }
    expect(parseRuntimeContent(tooDeep)).toBeNull();
  });

  it("bounds trace, message, and block count without splitting UTF-8", () => {
    const calls = Array.from(
      { length: CHAT_RUNTIME_BOUNDS.toolCallsPerTurn },
      (_, index) => ({
        id: `call-${index}`,
        name: "large_tool",
        inputJson: "{}",
        effectStarted: true,
        result: {
          callId: `call-${index}`,
          status: "success" as const,
          output: JSON.stringify("🦕\u0000".repeat(18_000)),
        },
      }),
    );
    const value: TurnCheckpoint = {
      version: 1,
      providerCalls: 1,
      providerInFlight: false,
      batches: [
        {
          providerStateJson: JSON.stringify(
            calls.map((call) => ({
              type: "toolCall",
              id: call.id,
              name: call.name,
              arguments: {},
            })),
          ),
          calls,
        },
      ],
      final: null,
    };

    const content = checkpointRuntimeContent(value);
    const serialized = JSON.stringify(content);
    expect(bytes(serialized)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.liveTraceBytes,
    );
    expect(content.length).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.liveContentBlocks,
    );
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        new TextEncoder().encode(serialized),
      ),
    ).not.toThrow();

    const huge = serializeRuntimeContent([
      { type: "text", text: "🦕\u0000".repeat(1_000_000) },
    ]);
    expect(bytes(huge)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.liveMessageBytes,
    );
    expect(parseRuntimeContent(huge)).not.toBeNull();

    const resultArtifact = parseRuntimeContent(
      serializeRuntimeContent([
        {
          type: "tool_result",
          tool_use_id: "large-result",
          content: "🦕".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes),
          is_error: false,
        },
      ]),
    );
    expect(resultArtifact?.[0]).toMatchObject({ type: "tool_result" });
    if (resultArtifact?.[0]?.type !== "tool_result") {
      throw new Error("missing bounded tool result");
    }
    expect(bytes(resultArtifact[0].content)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
  });

  it("truncates large text before its first JSON serialization", () => {
    const huge = "\u0000".repeat(CHAT_RUNTIME_BOUNDS.liveMessageBytes);
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const serialized = serializeRuntimeContent([
        { type: "thinking", thinking: huge, signature: huge },
      ]);
      expect(bytes(serialized)).toBeLessThanOrEqual(
        CHAT_RUNTIME_BOUNDS.liveMessageBytes,
      );
      expect(
        stringify.mock.calls.some(
          ([value]) =>
            !!value &&
            typeof value === "object" &&
            ((value as { thinking?: unknown }).thinking === huge ||
              (value as { signature?: unknown }).signature === huge),
        ),
      ).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it("omits malformed provider JSON and tool results without losing safe parts", () => {
    const value = checkpoint();
    value.batches.unshift({
      providerStateJson: "not json",
      calls: [],
    });
    value.batches[1].calls[0].result = {
      callId: "wrong-call",
      status: "success",
      output: "not json",
    };

    const content = checkpointRuntimeContent(value);
    expect(content).toContainEqual({
      type: "tool_use",
      id: "call-a",
      name: "read_file",
      input: { path: "a.ts" },
    });
    expect(content.some((block) => block.type === "tool_result")).toBe(false);
  });

  it("never invokes accessors or toJSON on checkpoint or wire inputs", () => {
    const accessed = vi.fn(() => "leaked");
    const serialized = vi.fn(() => ({ leaked: true }));
    const hostileBlock = {
      type: "tool_use",
      id: "safe-id",
      name: "safe-tool",
      input: {
        visible: true,
        get secret() {
          return accessed();
        },
        toJSON: serialized,
      },
      get ignored() {
        return accessed();
      },
    } as unknown as ChatRuntimeContentBlock;
    const hostileCheckpoint = {
      final: null,
      get batches() {
        return accessed();
      },
    } as unknown as TurnCheckpoint;

    expect(checkpointRuntimeContent(hostileCheckpoint)).toEqual([]);
    const raw = serializeRuntimeContent([hostileBlock]);
    expect(parseRuntimeContent(raw)).toEqual([
      {
        type: "tool_use",
        id: "safe-id",
        name: "safe-tool",
        input: {
          secret: "[Accessor]",
          toJSON: "[function]",
          visible: true,
        },
      },
    ]);
    expect(accessed).not.toHaveBeenCalled();
    expect(serialized).not.toHaveBeenCalled();
  });

  it("rejects oversized arrays before touching any element", () => {
    const accessed = vi.fn(() => ({ type: "text", text: "never" }));
    const blocks: unknown[] = [];
    blocks.length = CHAT_RUNTIME_BOUNDS.liveContentBlocks + 1;
    Object.defineProperty(blocks, "0", { get: accessed });

    expect(
      combineRuntimeContent(
        blocks as ChatRuntimeContentBlock[],
        blocks as ChatRuntimeContentBlock[],
      ),
    ).toEqual([]);
    expect(serializeRuntimeContent(blocks as ChatRuntimeContentBlock[])).toBe(
      "[]",
    );
    expect(accessed).not.toHaveBeenCalled();
  });
});
