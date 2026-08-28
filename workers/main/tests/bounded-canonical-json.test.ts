import { describe, expect, it, vi } from "vitest";

import { boundedCanonicalJson } from "../src/chat-thread/bounded-canonical-json";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("boundedCanonicalJson", () => {
  it("sorts object keys and preserves supported scalar markers", () => {
    const value: Record<string, unknown> = {
      z: undefined,
      symbol: Symbol("secret"),
      number: 7n,
      function: () => "never called",
      a: true,
    };
    value.self = value;

    const encoded = boundedCanonicalJson(value, 4_096);
    expect(encoded).toBe(
      '{"a":true,"function":"[function]","number":"7n","self":"[Circular]","symbol":"[symbol]","z":"[undefined]"}',
    );
    expect(JSON.parse(encoded)).toEqual({
      a: true,
      function: "[function]",
      number: "7n",
      self: "[Circular]",
      symbol: "[symbol]",
      z: "[undefined]",
    });
  });

  it("returns valid UTF-8 JSON within every requested positive byte budget", () => {
    const value = {
      nested: [{ text: '🦕"\\\n'.repeat(2_000) }],
      loneSurrogate: "\ud800tail",
    };
    for (let maxBytes = 1; maxBytes <= 128; maxBytes += 1) {
      const encoded = boundedCanonicalJson(value, maxBytes);
      expect(utf8Bytes(encoded)).toBeLessThanOrEqual(maxBytes);
      expect(() => JSON.parse(encoded)).not.toThrow();
      expect(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(
          new TextEncoder().encode(encoded),
        ),
      ).not.toThrow();
    }
  });

  it("never invokes JSON.stringify, toJSON, getters, or functions", () => {
    const toJson = vi.fn(() => ({ leaked: true }));
    const getter = vi.fn(() => "leaked");
    const callable = vi.fn(() => "leaked");
    const value = {
      toJSON: toJson,
      callable,
      get secret() {
        return getter();
      },
    };
    const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new Error("must not stringify arbitrary input");
    });
    try {
      const encoded = boundedCanonicalJson(value, 1_024);
      expect(JSON.parse(encoded)).toEqual({
        callable: "[function]",
        secret: "[Accessor]",
        toJSON: "[function]",
      });
      expect(stringify).not.toHaveBeenCalled();
      expect(toJson).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
      expect(callable).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it("stops independently at depth, entry, and node limits", () => {
    expect(
      JSON.parse(
        boundedCanonicalJson({ a: { b: { c: 1 } } }, 1_024, {
          maxDepth: 1,
        }),
      ),
    ).toEqual({ a: "[MaxDepth]" });

    const entries = JSON.parse(
      boundedCanonicalJson({ a: 1, b: 2, c: 3 }, 1_024, {
        maxEntries: 2,
      }),
    ) as Record<string, unknown>;
    expect(entries).toEqual({ a: 1, b: 2 });

    expect(
      JSON.parse(
        boundedCanonicalJson([1, [2], 3], 1_024, {
          maxNodes: 2,
        }),
      ),
    ).toEqual([1, "[MaxNodes]", "[MaxNodes]"]);
  });

  it("bounds sparse arrays and enormous bigint conversion work", () => {
    const sparse: unknown[] = [];
    sparse.length = 1_000_000;
    sparse[0] = "first";
    const array = JSON.parse(
      boundedCanonicalJson(sparse, 1_024, { maxEntries: 3 }),
    ) as unknown[];
    expect(array).toEqual(["first", null, null]);

    const huge = 1n << 100_000n;
    expect(JSON.parse(boundedCanonicalJson(huge, 64))).toBe("[bigint]");
  });

  it("rejects impossible or non-finite limits", () => {
    expect(() => boundedCanonicalJson({}, 0)).toThrow(RangeError);
    expect(() => boundedCanonicalJson({}, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
    expect(() => boundedCanonicalJson({}, 10, { maxNodes: 0 })).toThrow(
      RangeError,
    );
  });
});
