import { describe, expect, it } from "vitest";

import {
  boundedUtf8String,
  boundedJsonString,
  jsonStringByteLength,
  utf8ByteLength,
} from "../src/chat-thread/utf8-byte-length";

const encoder = new TextEncoder();

describe("allocation-free UTF-8 sizing", () => {
  it("truncates UTF-8 strings without splitting surrogate pairs", () => {
    expect(boundedUtf8String("ab😀cdef", 9)).toBe("ab😀…");
    expect(boundedUtf8String("😀", 2)).toBe("");
    expect(utf8ByteLength(boundedUtf8String("ééé", 5))).toBeLessThanOrEqual(5);
  });

  it("matches TextEncoder and JSON.stringify for escaped and malformed text", () => {
    for (const value of [
      "plain text",
      "🦕 unicode",
      '\u0000\b\t\n\f\r"\\',
      "\ud800 unpaired high",
      "\udc00 unpaired low",
    ]) {
      expect(utf8ByteLength(value)).toBe(encoder.encode(value).byteLength);
      expect(jsonStringByteLength(value)).toBe(
        encoder.encode(JSON.stringify(value)).byteLength,
      );
    }
  });

  it("truncates without crossing the exact encoded JSON budget", () => {
    const value = '🦕\u0000"\\'.repeat(10_000);
    for (const limit of [2, 4, 5, 17, 1_024, 16_384]) {
      const bounded = boundedJsonString(value, limit);
      expect(jsonStringByteLength(bounded)).toBeLessThanOrEqual(limit);
      expect(value.startsWith(bounded.replace(/…$/, ""))).toBe(true);
    }
  });
});
