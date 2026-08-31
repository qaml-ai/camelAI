import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai/compat";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import { DurableChatTurnStore } from "../src/chat-thread/durable-turn-store";
import {
  buildBoundedToolCatalog,
  checkpointProviderStep,
  checkpointToolHistory,
  consumePiProviderStream,
  createPiTurnAdapter,
  PI_AUTOMATION_OUTCOME_TOOL_DEFINITION,
  PI_JS_EXEC_TOOL_DEFINITION,
} from "../src/chat-thread/pi-turn-adapter";
import {
  CODE_MODE_MAX_OUTPUT_CHARACTERS,
  CODE_MODE_MAX_TIMEOUT_MS,
} from "../src/code-mode-tools";
import { CODE_MODE_MAX_NESTED_TOOL_CALLS } from "../src/code-mode-runner";
import type { ChatEnv } from "../src/chat-thread/types";
import type { CheckpointProviderBatch } from "../src/chat-thread/turn-checkpoint";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const response: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "I will inspect both." },
    {
      type: "toolCall",
      id: "provider-call-a",
      name: "read_file",
      arguments: { path: "a.ts" },
    },
    {
      type: "toolCall",
      id: "provider-call-b",
      name: "read_file",
      arguments: { path: "b.ts" },
    },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-test",
  usage,
  stopReason: "toolUse",
  timestamp: 1,
};

const stub = () => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName("pi-adapter-context-projection"));
};

describe("Pi checkpoint protocol adapter", () => {
  it("publishes cumulative text before the authoritative provider result", async () => {
    const stream = createAssistantMessageEventStream();
    const partial = (text: string): AssistantMessage => ({
      ...response,
      content: [{ type: "text", text }],
      stopReason: "stop",
    });
    const painted: string[] = [];
    let settled = false;
    const result = consumePiProviderStream(
      stream,
      new AbortController().signal,
      (content) => {
        const block = content.at(-1);
        if (block?.type === "text") painted.push(block.text);
      },
    ).finally(() => {
      settled = true;
    });

    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "Hel",
      partial: partial("Hel"),
    });
    await vi.waitFor(() => expect(painted).toEqual(["Hel"]));
    expect(settled).toBe(false);

    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: "lo",
      partial: partial("Hello"),
    });
    await vi.waitFor(() => expect(painted).toEqual(["Hel", "Hello"]));
    expect(settled).toBe(false);

    const final = partial("Hello");
    stream.push({ type: "done", reason: "stop", message: final });
    await expect(result).resolves.toBe(final);
  });

  it("bounds presentation work for a maximum-size burst of cumulative deltas", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const text = "x".repeat(64 * 1024);
    const partial = (value: string): AssistantMessage => ({
      ...response,
      content: [{ type: "text", text: value }],
      stopReason: "stop",
    });
    const final = partial(text);
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (
          let index = 0;
          index < CHAT_RUNTIME_BOUNDS.providerStreamEvents;
          index += 1
        ) {
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: "x",
            partial: partial(
              text.slice(
                0,
                Math.ceil(
                  ((index + 1) * text.length) /
                    CHAT_RUNTIME_BOUNDS.providerStreamEvents,
                ),
              ),
            ),
          };
        }
      },
      result: vi.fn(() => final),
    } as unknown as Parameters<typeof consumePiProviderStream>[0];
    const progress = vi.fn();

    try {
      await expect(
        consumePiProviderStream(stream, new AbortController().signal, progress),
      ).resolves.toBe(final);
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress.mock.calls[0]?.[0]).toEqual([
        { type: "text", text: text.slice(0, 8) },
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a provider stream that exceeds its finite event budget", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (
          let index = 0;
          index <= CHAT_RUNTIME_BOUNDS.providerStreamEvents;
          index += 1
        ) {
          yield { type: "start" };
        }
      },
      result: vi.fn(),
    } as unknown as Parameters<typeof consumePiProviderStream>[0];

    await expect(
      consumePiProviderStream(stream, new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({
      code: "invalid_provider_step",
      message: "Provider stream event limit reached",
    });
    expect(stream.result).not.toHaveBeenCalled();
  });

  it("reads bounded model context without leaking the UI display projection", async () => {
    await runInDurableObject(stub(), async (instance: any) => {
      const store = new DurableChatTurnStore(instance.ctx.storage);
      store.replaceSettledHistory(
        {
          threadId: "thread:test",
          workspaceId: "workspace:test",
          orgId: "org:test",
          userId: "user:test",
        },
        Array.from({ length: 40 }, (_, index) => ({
          id: `history:${index}`,
          userContent:
            index === 39
              ? "[Context Summary]\n\nbounded earlier context\n\nmodel:39"
              : `model:${index}`,
          userDisplay: `raw:${index}`,
          assistantFinal: `answer:${index}`,
          createdAt: index,
          updatedAt: index,
        })),
      );
      store.admit(
        {
          id: "current",
          clientMessageId: "client:current",
          threadId: "thread:test",
          workspaceId: "workspace:test",
          orgId: "org:test",
          userId: "user:test",
          source: "web",
          userContent: "continue",
          userDisplay: "continue",
        },
        100,
      );
      const current = store.getTurn("current");
      if (!current) throw new Error("missing current turn");
      const adapter = createPiTurnAdapter({
        ctx: instance.ctx,
        env: env as unknown as ChatEnv,
        store,
      });
      const context = Array.from(
        adapter.readContext(
          current,
          {
            messages: CHAT_RUNTIME_BOUNDS.contextMessages,
            bytes: CHAT_RUNTIME_BOUNDS.contextBytes,
          },
          new AbortController().signal,
        ),
      );

      expect(context).toHaveLength(CHAT_RUNTIME_BOUNDS.contextMessages);
      expect(context.slice(0, 2)).toEqual([
        { role: "assistant", content: "answer:39" },
        {
          role: "user",
          content: "[Context Summary]\n\nbounded earlier context\n\nmodel:39",
        },
      ]);
      expect(
        context.some((message) => message.content.startsWith("raw:")),
      ).toBe(false);
      expect(
        store
          .latestSnapshot()
          .messages.find((message) => message.id === "history:39:user")
          ?.content,
      ).toBe("raw:39");
    });
  });

  it("preserves the complete provider batch and exact provider call ids", () => {
    const step = checkpointProviderStep(response);

    expect(step).toMatchObject({
      kind: "tool_batch",
      calls: [
        { id: "provider-call-a", name: "read_file", input: { path: "a.ts" } },
        { id: "provider-call-b", name: "read_file", input: { path: "b.ts" } },
      ],
    });
    if (step.kind !== "tool_batch") throw new Error("expected tool batch");
    expect(JSON.parse(step.providerStateJson)).toEqual(response.content);
  });

  it("normalizes provider batches without calling unbounded array or JSON helpers", () => {
    const toJson = vi.fn(() => ({ leaked: true }));
    const getter = vi.fn(() => "leaked");
    const content = [
      { type: "text", text: 'quoted " text\n' },
      {
        type: "toolCall",
        id: "safe-call",
        name: "read_file",
        arguments: { path: "a\u0000b\\c", nested: [true, 1, null] },
      },
    ] as AssistantMessage["content"];
    Object.defineProperties(content, {
      find: { value: () => getter() },
      filter: { value: () => getter() },
      map: { value: () => getter() },
      join: { value: () => getter() },
    });
    Object.defineProperties(content[1].arguments, {
      toJSON: { value: toJson, enumerable: false },
      secret: { get: getter, enumerable: false },
    });
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("unbounded stringify must not run");
    });

    let step: ReturnType<typeof checkpointProviderStep>;
    try {
      step = checkpointProviderStep({ ...response, content });
    } finally {
      stringify.mockRestore();
    }

    expect(step.kind).toBe("tool_batch");
    if (step.kind !== "tool_batch") throw new Error("expected tool batch");
    expect(step.calls).toEqual([
      {
        id: "safe-call",
        name: "read_file",
        input: { nested: [true, 1, null], path: "a\u0000b\\c" },
      },
    ]);
    expect(JSON.parse(step.providerStateJson)).toEqual([
      { type: "text", text: 'quoted " text\n' },
      {
        type: "toolCall",
        id: "safe-call",
        name: "read_file",
        arguments: { nested: [true, 1, null], path: "a\u0000b\\c" },
      },
    ]);
    expect(toJson).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects an oversized content array before touching any content part", () => {
    const touched = vi.fn(() => ({ type: "text", text: "never" }));
    const content: unknown[] = [];
    content.length = CHAT_RUNTIME_BOUNDS.providerContentParts + 1;
    Object.defineProperty(content, "0", { get: touched });

    expect(() =>
      checkpointProviderStep({
        ...response,
        content: content as AssistantMessage["content"],
      }),
    ).toThrow("Provider output exceeds the content-part limit");
    expect(touched).not.toHaveBeenCalled();
  });

  it("fails deterministically while scanning oversized assistant text", () => {
    expect(() =>
      checkpointProviderStep({
        ...response,
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "x".repeat(CHAT_RUNTIME_BOUNDS.assistantBytes + 1),
          },
        ],
      }),
    ).toThrow("Provider assistant output is too large");
  });

  it("charges JSON escapes before accepting a tool input", () => {
    expect(() =>
      checkpointProviderStep({
        ...response,
        content: [
          {
            type: "toolCall",
            id: "escaped-call",
            name: "read_file",
            arguments: {
              path: "\u0000".repeat(CHAT_RUNTIME_BOUNDS.toolInputBytes),
            },
          },
        ],
      }),
    ).toThrow("Tool input is too large");
  });

  it("rejects an oversized object key before sorting provider-controlled keys", () => {
    const sort = vi.spyOn(Array.prototype, "sort").mockImplementation(() => {
      throw new Error(
        "provider keys must not be sorted before their byte gate",
      );
    });
    try {
      expect(() =>
        checkpointProviderStep({
          ...response,
          content: [
            {
              type: "toolCall",
              id: "huge-key-call",
              name: "read_file",
              arguments: {
                ["x".repeat(CHAT_RUNTIME_BOUNDS.toolInputBytes)]: true,
              },
            },
          ],
        }),
      ).toThrow("Tool input is too large");
      expect(sort).not.toHaveBeenCalled();
    } finally {
      sort.mockRestore();
    }
  });

  it("rejects non-plain provider objects without traversing their prototype", () => {
    const inherited = vi.fn(() => "never");
    const prototype = Object.create(null);
    Object.defineProperty(prototype, "inherited", {
      get: inherited,
      enumerable: true,
    });
    const argumentsValue = Object.create(prototype) as Record<string, unknown>;
    argumentsValue.path = "a.ts";

    expect(() =>
      checkpointProviderStep({
        ...response,
        content: [
          {
            type: "toolCall",
            id: "prototype-call",
            name: "read_file",
            arguments: argumentsValue,
          },
        ],
      }),
    ).toThrow("Provider output contains a non-plain object");
    expect(inherited).not.toHaveBeenCalled();
  });

  it("rejects enormous nested arrays from metadata without traversing them", () => {
    const touched = vi.fn(() => "never");
    const huge: unknown[] = [];
    huge.length = CHAT_RUNTIME_BOUNDS.providerJsonEntries + 1;
    Object.defineProperty(huge, "0", { get: touched });

    expect(() =>
      checkpointProviderStep({
        ...response,
        content: [
          {
            type: "toolCall",
            id: "huge-call",
            name: "read_file",
            arguments: { values: huge },
          },
        ],
      }),
    ).toThrow("Provider output exceeds the JSON entry limit");
    expect(touched).not.toHaveBeenCalled();
  });

  it("stops at the shared tool-call ceiling during content scanning", () => {
    const content = Array.from(
      { length: CHAT_RUNTIME_BOUNDS.toolCallsPerTurn + 1 },
      (_, index) => ({
        type: "toolCall" as const,
        id: `call-${index}`,
        name: "read_file",
        arguments: {},
      }),
    );

    expect(() => checkpointProviderStep({ ...response, content })).toThrow(
      "Tool-call limit reached",
    );
  });

  it("replays one assistant batch followed by one matching terminal result per call", () => {
    const step = checkpointProviderStep(response);
    if (step.kind !== "tool_batch") throw new Error("expected tool batch");
    const batch: CheckpointProviderBatch = {
      providerStateJson: step.providerStateJson,
      calls: step.calls.map((call, index) => ({
        id: call.id,
        name: call.name,
        inputJson: JSON.stringify(call.input),
        effectStarted: true,
        result: {
          callId: call.id,
          status: index === 0 ? "success" : "error",
          output: JSON.stringify({ index }),
        },
      })),
    };
    batch.calls[0].result!.output = JSON.stringify({
      content: [
        { type: "text", text: "Read image" },
        { type: "image", data: "bounded-base64", mimeType: "image/png" },
      ],
      text: "Read image",
    });

    const messages = checkpointToolHistory(
      {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-test",
      } as never,
      [batch],
    );

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: response.content,
    });
    expect(messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "provider-call-a",
      toolName: "read_file",
      content: [
        { type: "text", text: "Read image" },
        { type: "image", data: "bounded-base64", mimeType: "image/png" },
      ],
      isError: false,
    });
    expect(messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "provider-call-b",
      toolName: "read_file",
      isError: true,
    });
  });

  it("refuses an incomplete or mismatched batch before the next provider call", () => {
    const step = checkpointProviderStep(response);
    if (step.kind !== "tool_batch") throw new Error("expected tool batch");
    const batch: CheckpointProviderBatch = {
      providerStateJson: step.providerStateJson,
      calls: step.calls.map((call) => ({
        id: call.id,
        name: call.name,
        inputJson: JSON.stringify(call.input),
        effectStarted: false,
        result: null,
      })),
    };

    expect(() => checkpointToolHistory({} as never, [batch])).toThrow(
      "does not match provider state",
    );
    batch.calls[0].result = {
      callId: batch.calls[0].id,
      status: "success",
      output: "1",
    };
    batch.calls[1].result = {
      callId: batch.calls[1].id,
      status: "success",
      output: "1",
    };
    batch.calls[1].inputJson = '{"path":"wrong.ts"}';
    expect(() => checkpointToolHistory({} as never, [batch])).toThrow(
      "does not match provider state",
    );
  });
});

describe("Pi attempt setup bounds", () => {
  it("keeps the scheduled outcome tool fixed and bounded", () => {
    expect(
      buildBoundedToolCatalog([PI_AUTOMATION_OUTCOME_TOOL_DEFINITION]),
    ).toEqual([
      expect.objectContaining({
        name: "report_automation_outcome",
        parameters: expect.objectContaining({
          required: ["status", "summary"],
        }),
      }),
    ]);
  });

  it("advertises bounded js_exec and shares its attempt-level tool ledger", async () => {
    const catalog = buildBoundedToolCatalog([PI_JS_EXEC_TOOL_DEFINITION]);
    expect(catalog).toContainEqual(
      expect.objectContaining({
        name: "js_exec",
        parameters: expect.objectContaining({
          required: ["description", "code"],
        }),
      }),
    );

    const run = vi.fn(async () => ({
      text: "x".repeat(CODE_MODE_MAX_OUTPUT_CHARACTERS + 1),
    }));
    const load = vi.fn((workerCode: unknown) => ({
      getEntrypoint: vi.fn(() => ({ run })),
      workerCode,
    }));
    const factories = Object.fromEntries(
      [
        "CodeModeToolsBinding",
        "AIVirtualBinding",
        "CamelAiService",
        "SecureFetchBinding",
        "AppScreenshotBinding",
        "AppBrowserBinding",
      ].map((name) => [name, vi.fn(({ props }) => ({ name, props }))]),
    );
    const turn = {
      id: "turn:test",
      orgId: "org:test",
      workspaceId: "workspace:test",
      threadId: "thread:test",
      userId: "user:test",
    };
    const adapter = createPiTurnAdapter({
      ctx: { exports: factories } as never,
      env: { CODE_MODE_LOADER: { load } } as never,
      store: { activeTurn: () => turn } as never,
    });
    const result = (await adapter.callTool(
      {
        id: "provider-js-call",
        name: "js_exec",
        input: {
          description: "return output",
          code: "'ok'",
          timeoutMs: Number.MAX_SAFE_INTEGER,
          maxOutputCharacters: Number.MAX_SAFE_INTEGER,
        },
      },
      new AbortController().signal,
    )) as {
      content: Array<{ type: "text"; text: string }>;
    };

    expect(run).toHaveBeenCalledWith(
      Math.min(CODE_MODE_MAX_TIMEOUT_MS, CHAT_RUNTIME_BOUNDS.toolDeadlineMs),
      Math.min(CODE_MODE_MAX_TIMEOUT_MS, CHAT_RUNTIME_BOUNDS.toolDeadlineMs),
      CODE_MODE_MAX_OUTPUT_CHARACTERS,
      CODE_MODE_MAX_NESTED_TOOL_CALLS,
    );
    expect(factories.CodeModeToolsBinding).toHaveBeenCalledOnce();
    const tools = factories.CodeModeToolsBinding.mock.results[0]?.value;
    expect(
      (load.mock.calls[0]?.[0] as { env?: { TOOLS?: unknown } }).env?.TOOLS,
    ).toBe(tools);
    expect(
      (load.mock.calls[0]?.[0] as { limits?: { cpuMs?: number } }).limits,
    ).toEqual({ cpuMs: CHAT_RUNTIME_BOUNDS.codeModeCpuMs });
    expect(result.content[0].text).toContain(
      `[Truncated: ${CODE_MODE_MAX_OUTPUT_CHARACTERS} of ${CODE_MODE_MAX_OUTPUT_CHARACTERS + 1} characters]`,
    );
    expect(() =>
      adapter.callTool(
        {
          id: "second-js-call",
          name: "js_exec",
          input: { description: "again", code: "'again'" },
        },
        new AbortController().signal,
      ),
    ).toThrow("js_exec may run at most once per turn");
    expect(load).toHaveBeenCalledOnce();
  });

  it("clones tool schemas without JSON callbacks or raw stringify", () => {
    const toJSON = vi.fn(() => ({ leaked: true }));
    const getter = vi.fn(() => "leaked");
    const parameters: Record<string, unknown> = {
      type: "object",
      properties: { path: { type: "string" } },
    };
    Object.defineProperties(parameters, {
      toJSON: { value: toJSON, enumerable: false },
      secret: { get: getter, enumerable: false },
    });
    const definition = {
      name: "read_file",
      description: "Read one file",
      parameters,
    };
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("raw schema stringify must not run");
    });

    let catalog: ReturnType<typeof buildBoundedToolCatalog>;
    try {
      catalog = buildBoundedToolCatalog([definition]);
    } finally {
      stringify.mockRestore();
    }
    (parameters.properties as Record<string, unknown>).path = {
      type: "number",
    };

    expect(catalog).toEqual([
      {
        name: "read_file",
        description: "Read one file",
        parameters: {
          properties: { path: { type: "string" } },
          type: "object",
        },
      },
    ]);
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects oversized tool metadata before reading parameters", () => {
    const getter = vi.fn(() => ({ type: "object" }));
    const definition: Record<string, unknown> = {
      name: "oversized",
      description: "x".repeat(CHAT_RUNTIME_BOUNDS.toolSchemaBytes + 1),
    };
    Object.defineProperty(definition, "parameters", {
      get: getter,
      enumerable: true,
    });

    expect(buildBoundedToolCatalog([definition as never])).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects sparse huge schema arrays before touching their entries", () => {
    const getter = vi.fn(() => "leaked");
    const values: unknown[] = [];
    values.length = CHAT_RUNTIME_BOUNDS.providerJsonEntries + 1;
    Object.defineProperty(values, "0", { get: getter });

    expect(() =>
      buildBoundedToolCatalog([
        {
          name: "sparse",
          description: "Sparse schema",
          parameters: { anyOf: values },
        },
      ]),
    ).toThrow("Provider output exceeds the JSON entry limit");
    expect(getter).not.toHaveBeenCalled();
  });

  it("never invokes enumerable schema accessors", () => {
    const getter = vi.fn(() => "leaked");
    const parameters: Record<string, unknown> = { type: "object" };
    Object.defineProperty(parameters, "unsafe", {
      get: getter,
      enumerable: true,
    });

    expect(() =>
      buildBoundedToolCatalog([
        {
          name: "unsafe",
          description: "Unsafe schema",
          parameters,
        },
      ]),
    ).toThrow("Provider output contains an accessor");
    expect(getter).not.toHaveBeenCalled();
  });

  it("pulls at most the centrally bounded number of definitions", () => {
    let pulled = 0;
    function* definitions() {
      for (;;) {
        const index = pulled;
        pulled += 1;
        yield {
          name: `tool-${index}`,
          description: "tool",
          parameters: { type: "object" },
        };
      }
    }

    const catalog = buildBoundedToolCatalog(definitions());
    expect(pulled).toBe(CHAT_RUNTIME_BOUNDS.toolCatalogEntries);
    expect(catalog).toHaveLength(CHAT_RUNTIME_BOUNDS.toolCatalogEntries);
    expect(
      new TextEncoder().encode(JSON.stringify(catalog)).byteLength,
    ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.toolSchemaBytes);
  });
});
