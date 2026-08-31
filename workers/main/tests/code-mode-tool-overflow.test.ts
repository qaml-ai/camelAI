import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import { CodeModeToolsBinding } from "../src/code-mode-tools";

interface OverflowProjection {
  $overflow: {
    stored: boolean;
    path?: string;
    format: "text" | "json";
    bytes?: number;
    sha256?: string;
    complete: boolean;
    reason?: string;
  };
  hint: string;
  preview: unknown;
}

type PrivateCodeModeMethods = {
  analysisRunCode(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  callToolWithArtifactCapture(
    this: unknown,
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<unknown> | unknown,
  ): Promise<unknown>;
  readR2File(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

const privateMethods =
  CodeModeToolsBinding.prototype as unknown as PrivateCodeModeMethods;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const byteLength = (value: unknown) =>
  encoder.encode(JSON.stringify(value)).byteLength;

function createBinding(
  put: ReturnType<typeof vi.fn>,
  props: Record<string, unknown> = {},
  bucketExtras: Record<string, unknown> = {},
): CodeModeToolsBinding {
  const binding = Object.create(
    CodeModeToolsBinding.prototype,
  ) as CodeModeToolsBinding;
  Object.assign(binding, {
    ctx: {
      props: {
        orgId: "org-overflow",
        workspaceId: "workspace-overflow",
        threadId: "thread/overflow",
        ...props,
      },
    },
    env: { R2_BUCKET: { put, ...bucketExtras } },
  });
  return binding;
}

function projection(value: unknown): OverflowProjection {
  return value as OverflowProjection;
}

describe("code-mode tool-result overflow", () => {
  it("keeps the two-attempt turn ceiling at eight objects and eight MiB", () => {
    expect(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt *
        CHAT_RUNTIME_BOUNDS.attemptsPerTurn,
    ).toBe(8);
    expect(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowPerAttemptBytes *
        CHAT_RUNTIME_BOUNDS.attemptsPerTurn,
    ).toBe(8 * 1024 * 1024);
  });

  it("reserves analysis archive capacity before concurrent dispatch and refunds only explicit non-use", async () => {
    const binding = createBinding(vi.fn());
    const captures: number[] = [];
    const resolvers: Array<
      (result: { ok: boolean; outputTruncated: false }) => void
    > = [];
    const runCode = vi.fn((request: { outputCaptureBytes?: number }) => {
      captures.push(request.outputCaptureBytes ?? -1);
      return new Promise<{ ok: boolean; outputTruncated: false }>((resolve) => {
        resolvers.push(resolve);
      });
    });
    Object.defineProperty(binding, "analysisService", {
      configurable: true,
      value: () => ({ runCode }),
    });

    const concurrent = Array.from(
      { length: CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt + 1 },
      () => privateMethods.analysisRunCode.call(binding, { code: "print(1)" }),
    );
    expect(captures).toEqual([
      ...Array(CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt).fill(
        CHAT_RUNTIME_BOUNDS.analysisOutputOverflowBytes,
      ),
      0,
    ]);

    for (const resolve of resolvers) {
      resolve({ ok: true, outputTruncated: false });
    }
    await Promise.all(concurrent);

    const final = privateMethods.analysisRunCode.call(binding, {
      code: "print(2)",
    });
    expect(captures.at(-1)).toBe(
      CHAT_RUNTIME_BOUNDS.analysisOutputOverflowBytes,
    );
    resolvers.at(-1)?.({ ok: true, outputTruncated: false });
    await final;
  });

  it("retains analysis reservations on throws, uncertainty, truncation, and archives", async () => {
    const binding = createBinding(vi.fn());
    const captures: number[] = [];
    let call = 0;
    const runCode = vi.fn(async (request: { outputCaptureBytes?: number }) => {
      captures.push(request.outputCaptureBytes ?? -1);
      call += 1;
      if (call === 1) throw new Error("uncertain dispatch");
      if (call === 2) return { ok: false, error: "uncertain result" };
      if (call === 3) return { ok: true, outputTruncated: true };
      if (call === 4) {
        return {
          ok: true,
          outputTruncated: false,
          fullOutput: { path: "outputs/tmp/archive.log" },
        };
      }
      return { ok: true, outputTruncated: false };
    });
    Object.defineProperty(binding, "analysisService", {
      configurable: true,
      value: () => ({ runCode }),
    });

    await expect(
      privateMethods.analysisRunCode.call(binding, { code: "print(1)" }),
    ).rejects.toThrow("uncertain dispatch");
    await privateMethods.analysisRunCode.call(binding, { code: "print(2)" });
    await privateMethods.analysisRunCode.call(binding, { code: "print(3)" });
    await privateMethods.analysisRunCode.call(binding, { code: "print(4)" });
    await privateMethods.analysisRunCode.call(binding, { code: "print(5)" });

    expect(captures).toEqual([
      ...Array(CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt).fill(
        CHAT_RUNTIME_BOUNDS.analysisOutputOverflowBytes,
      ),
      0,
    ]);
  });

  it("spills an exact oversized string before inline bounding destroys it", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put);
    const raw = "exact-output\n".repeat(
      Math.ceil((CHAT_RUNTIME_BOUNDS.toolResultBytes + 1) / 13),
    );

    const result = projection(
      await privateMethods.callToolWithArtifactCapture.call(
        binding,
        "analysis_exec",
        {},
        () => raw,
      ),
    );

    expect(result.$overflow).toMatchObject({
      stored: true,
      format: "text",
      bytes: encoder.encode(raw).byteLength,
      complete: true,
    });
    expect(result.$overflow.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.$overflow.path).toMatch(/^tmp\/tool-result-analysis_exec-/);
    expect(result.hint).toContain("byte_offset: 0");
    expect(result.hint).toContain("nextByteOffset");
    expect(result).not.toHaveProperty("key");
    expect(byteLength(result)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes,
    );

    expect(put).toHaveBeenCalledOnce();
    const [key, body, options] = put.mock.calls[0] as [
      string,
      Uint8Array,
      {
        httpMetadata: { contentType: string };
        customMetadata: Record<string, string>;
      },
    ];
    expect(key).toBe(
      `org-overflow/workspace-overflow/chat-sessions/thread_overflow/pi-tool-results/${result.$overflow.path}`,
    );
    expect(decoder.decode(body)).toBe(raw);
    expect(options).toMatchObject({
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: {
        type: "tool-result-overflow",
        sha256: result.$overflow.sha256,
        size: String(result.$overflow.bytes),
      },
    });
    expect(options.customMetadata.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("snapshots a bounded preview before awaiting overflow storage", async () => {
    let finishPut!: () => void;
    const put = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPut = resolve;
        }),
    );
    const binding = createBinding(put);
    const original = "original".repeat(
      Math.ceil((CHAT_RUNTIME_BOUNDS.toolResultBytes + 1) / 8),
    );
    const raw = { payload: original };

    const pending = binding.overflowToolResult("query", "preview", raw);
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    raw.payload = "mutated after the bounded archive was captured";
    finishPut();

    const result = projection(await pending);
    expect(result.$overflow).toMatchObject({ stored: true, complete: true });
    expect(JSON.stringify(result.preview)).not.toContain("mutated after");
    const [, body] = put.mock.calls[0] as [string, Uint8Array];
    expect(JSON.parse(decoder.decode(body))).toEqual({ payload: original });
  });

  it("does not materialize a truncated inline copy while spilling", async () => {
    const binding = createBinding(vi.fn());
    const raw = {
      payload: "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes * 2),
    };
    const overflow = vi.fn(
      async (_toolName: string, _toolCallId: string, _value: unknown) => ({
        $overflow: { stored: true, complete: true, path: "tmp/result.json" },
      }),
    );
    Object.defineProperty(binding, "overflowToolResult", {
      configurable: true,
      value: overflow,
    });
    const parse = vi.spyOn(JSON, "parse");

    try {
      await expect(
        privateMethods.callToolWithArtifactCapture.call(
          binding,
          "query",
          {},
          () => raw,
        ),
      ).resolves.toMatchObject({
        $overflow: { stored: true, complete: true },
      });
      expect(parse).not.toHaveBeenCalled();
      expect(overflow).toHaveBeenCalledOnce();
      expect(overflow.mock.calls[0]?.[2]).toBe(raw);
    } finally {
      parse.mockRestore();
    }
  });

  it("stores plain data as complete canonical JSON", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put);
    const raw = {
      z: "tail",
      a: "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes),
    };

    const result = projection(
      await binding.overflowToolResult("query", "call/1", raw),
    );

    expect(result.$overflow).toMatchObject({
      stored: true,
      format: "json",
      complete: true,
    });
    const [, body, options] = put.mock.calls[0] as [
      string,
      Uint8Array,
      { httpMetadata: { contentType: string } },
    ];
    const stored = decoder.decode(body);
    expect(stored.startsWith('{"a":"')).toBe(true);
    expect(JSON.parse(stored)).toEqual(raw);
    expect(options.httpMetadata.contentType).toBe("application/json");
  });

  it("returns preview-only projections for the source cap and hostile accessors", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put);
    const capped = projection(
      await binding.overflowToolResult(
        "huge",
        "cap",
        "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultOverflowBytes + 1),
      ),
    );
    expect(capped.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "source_limit",
    });

    let reads = 0;
    const hostile = {
      payload: "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes + 1),
      get secret() {
        reads += 1;
        return "must not be read";
      },
      get toJSON() {
        reads += 1;
        return () => ({ leaked: true });
      },
    };
    const accessorResult = projection(
      await binding.overflowToolResult("hostile", "accessor", hostile),
    );
    expect(reads).toBe(0);
    expect(accessorResult.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "source_limit",
    });
    expect(put).not.toHaveBeenCalled();
    expect(byteLength(capped)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes,
    );
    expect(byteLength(accessorResult)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowStubBytes,
    );

    const unscoped = createBinding(put, { threadId: undefined });
    const scopeResult = projection(
      await unscoped.overflowToolResult("query", "scope", "full result"),
    );
    expect(scopeResult.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "scope_unavailable",
    });
  });

  it("fails closed after R2 failure without failing the tool result", async () => {
    const put = vi.fn(async () => {
      throw new Error("R2 unavailable");
    });
    const binding = createBinding(put);

    const first = projection(
      await binding.overflowToolResult("query", "one", "full one"),
    );
    const second = projection(
      await binding.overflowToolResult("query", "two", "full two"),
    );

    expect(first.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "storage_failure",
    });
    expect(second.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "storage_disabled",
    });
    expect(put).toHaveBeenCalledOnce();
  });

  it("reserves the per-binding file budget before concurrent R2 awaits", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put);
    const calls = Array.from(
      { length: CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt + 1 },
      (_, index) =>
        binding.overflowToolResult("query", `file-${index}`, `value-${index}`),
    );

    const results = (await Promise.all(calls)).map(projection);

    expect(results.filter((item) => item.$overflow.stored)).toHaveLength(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt,
    );
    expect(results.at(-1)?.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "file_limit",
    });
    expect(put).toHaveBeenCalledTimes(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowFilesPerAttempt,
    );
  });

  it("reserves the aggregate byte budget before concurrent R2 awaits", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put);
    const exactCap = "z".repeat(CHAT_RUNTIME_BOUNDS.toolResultOverflowBytes);
    const fullFileCount = Math.floor(
      CHAT_RUNTIME_BOUNDS.toolResultOverflowPerAttemptBytes /
        CHAT_RUNTIME_BOUNDS.toolResultOverflowBytes,
    );
    const calls = [
      ...Array.from({ length: fullFileCount }, (_, index) =>
        binding.overflowToolResult("query", `bytes-${index}`, exactCap),
      ),
      binding.overflowToolResult("query", "bytes-over", "x"),
    ];

    const results = (await Promise.all(calls)).map(projection);

    expect(
      results.slice(0, fullFileCount).every((item) => item.$overflow.stored),
    ).toBe(true);
    expect(results.at(-1)?.$overflow).toMatchObject({
      stored: false,
      complete: false,
      reason: "aggregate_limit",
    });
    expect(put).toHaveBeenCalledTimes(fullFileCount);
  });

  it("pages a large single-line overflow by UTF-8 byte boundary", async () => {
    const maxWindow = 16 * 1024;
    const source = `${"a".repeat(maxWindow - 2)}🦕${"b".repeat(maxWindow)}`;
    const sourceBytes = encoder.encode(source);
    const head = {
      key: "ignored",
      size: sourceBytes.byteLength,
      etag: "etag",
      uploaded: new Date("2026-01-01T00:00:00.000Z"),
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: { type: "tool-result-overflow" },
    };
    const get = vi.fn(
      async (
        _key: string,
        options: {
          range: { offset: number; length: number };
        },
      ) => {
        const { offset, length } = options.range;
        const chunk = sourceBytes.slice(offset, offset + length);
        return {
          ...head,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              controller.close();
            },
          }),
        };
      },
    );
    const binding = createBinding(
      vi.fn(),
      {},
      {
        head: vi.fn(async () => head),
        get,
      },
    );

    const first = await privateMethods.readR2File.call(binding, {
      location: "r2",
      path: "tmp/overflow.txt",
      byte_offset: 0,
    });
    const firstDetails = first.details as Record<string, unknown>;
    expect(firstDetails.byteOffset).toBe(0);
    expect(firstDetails.nextByteOffset).toBe(maxWindow - 2);
    expect(first.text).not.toContain("�");
    expect(first.text).toContain(
      `Use byte_offset=${maxWindow - 2} to continue`,
    );

    const second = await privateMethods.readR2File.call(binding, {
      location: "r2",
      path: "tmp/overflow.txt",
      byte_offset: firstDetails.nextByteOffset,
    });
    const secondDetails = second.details as Record<string, unknown>;
    expect(secondDetails.byteOffset).toBe(maxWindow - 2);
    expect(second.text).toMatch(/^🦕b+/);
    expect(second.text).not.toContain("�");
    expect(secondDetails.windowBytes).toBeLessThanOrEqual(maxWindow);
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("pi-tool-results/tmp/overflow.txt"),
      expect.objectContaining({
        range: expect.objectContaining({ length: expect.any(Number) }),
      }),
    );
  });

  it("rethrows caller abort and deletes a put that completes late", async () => {
    let finishPut: (() => void) | undefined;
    const put = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPut = resolve;
        }),
    );
    const remove = vi.fn(async () => undefined);
    const binding = createBinding(put, {}, { delete: remove });
    const controller = new AbortController();

    const spilling = binding.overflowToolResult(
      "query",
      "abort-call",
      "full result",
      controller.signal,
    );
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    controller.abort(new Error("turn authority expired"));

    await expect(spilling).rejects.toThrow("turn authority expired");
    finishPut?.();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(remove).toHaveBeenCalledWith(put.mock.calls[0][0]);
  });

  it("leaves small values and fitting inline images unchanged", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put);
    const small = { ok: true, rows: [1, 2, 3] };
    const imageData = "A".repeat(
      Math.floor(CHAT_RUNTIME_BOUNDS.toolResultBytes / 2),
    );
    const image = {
      content: [
        { type: "text", text: "Read image" },
        { type: "image", data: imageData, mimeType: "image/png" },
      ],
      text: "Read image",
    };

    const smallResult = await privateMethods.callToolWithArtifactCapture.call(
      binding,
      "small",
      {},
      () => small,
    );
    const imageResult = await privateMethods.callToolWithArtifactCapture.call(
      binding,
      "read",
      {},
      () => image,
    );

    expect(smallResult).toEqual(small);
    expect(imageResult).toEqual(image);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not erase overflow references when simplifying web tools", async () => {
    const put = vi.fn(async () => undefined);
    const binding = createBinding(put) as CodeModeToolsBinding & {
      callTool: ReturnType<typeof vi.fn>;
    };
    const overflow = projection(
      await binding.overflowToolResult(
        "WebSearch",
        "web-call",
        "full web result",
      ),
    );
    binding.callTool = vi.fn(async () => overflow);

    const envelope = await CodeModeToolsBinding.prototype.callToolEnvelope.call(
      binding,
      "WebSearch",
      {},
    );

    expect(envelope).toEqual({ ok: true, data: overflow });
  });
});
