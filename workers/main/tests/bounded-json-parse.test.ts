import { describe, expect, it, vi } from "vitest";

import {
  parseJsonBounded,
  preflightJson,
} from "../src/chat-thread/bounded-json-parse";

const limits = {
  maxDepth: 3,
  maxTokens: 16,
  maxNodes: 8,
  maxEntries: 16,
  maxStrings: 4,
  maxStringCodeUnits: 12,
};

describe("bounded JSON preflight", () => {
  it("accepts bounded JSON without retaining input-sized scanner state", () => {
    expect(parseJsonBounded('{"a":[1,"ok"]}', limits)).toEqual({
      a: [1, "ok"],
    });
  });

  it("counts escaped quotes and backslashes inside one bounded string", () => {
    expect(
      parseJsonBounded('{"text":"a\\\"b\\\\c"}', {
        ...limits,
        maxStringCodeUnits: 16,
      }),
    ).toEqual({ text: 'a"b\\c' });
  });

  it.each([
    ["[[[[0]]]]", "JSON depth limit exceeded"],
    ["[0,0,0,0,0,0,0,0]", "JSON node limit exceeded"],
    ["[0,0,0,0]", "JSON entry limit exceeded"],
    ['["a","b","c","d","e"]', "JSON string count limit exceeded"],
    ['{"a":"123456789012"}', "JSON string limit exceeded"],
  ])("rejects allocation amplification in %s", (raw, message) => {
    expect(() =>
      preflightJson(
        raw,
        message === "JSON entry limit exceeded"
          ? { ...limits, maxEntries: 3 }
          : limits,
      ),
    ).toThrow(message);
  });

  it("rejects mismatched containers before JSON.parse", () => {
    expect(() => preflightJson('{"a":[]]', limits)).toThrow(
      "Invalid JSON structure",
    );
  });

  it("enforces the lexical token ceiling before JSON.parse", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() =>
        parseJsonBounded('{"a":0,"b":0,"c":0}', {
          ...limits,
          maxTokens: 12,
        }),
      ).toThrow("JSON token limit exceeded");
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("still charges a string following a malformed primitive", () => {
    expect(() => parseJsonBounded('nope"1234567890123"', limits)).toThrow(
      "JSON string limit exceeded",
    );
    expect(() => parseJsonBounded('{"a":truetrue}', limits)).toThrow();
  });
});
