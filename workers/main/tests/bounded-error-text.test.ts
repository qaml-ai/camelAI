import { describe, expect, it } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  boundedErrorText,
  boundedErrorValue,
  boundedUtf8Text,
} from "../src/chat-thread/bounded-error-text";

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("bounded error text", () => {
  it("never invokes error accessors or coercion hooks", () => {
    let reads = 0;
    const hostile = Object.defineProperties({}, {
      name: { get: () => { reads += 1; return "Hostile"; } },
      message: { get: () => { reads += 1; return "secret"; } },
      toString: { get: () => { reads += 1; return () => "secret"; } },
      toJSON: { get: () => { reads += 1; return () => "secret"; } },
    });

    expect(boundedErrorValue(hostile)).toEqual({
      name: "Error",
      message: "[object thrown]",
    });
    expect(reads).toBe(0);
  });

  it("truncates huge unicode messages without first encoding them whole", () => {
    const error = new Error("💥".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes));
    Object.defineProperty(error, "name", {
      value: "N".repeat(CHAT_RUNTIME_BOUNDS.identifierChars * 4),
    });

    const bounded = boundedErrorValue(
      error,
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
    expect(bytes(bounded.name)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.identifierChars,
    );
    expect(bytes(bounded.message)).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.toolResultBytes,
    );
    expect(bounded.message.endsWith("…")).toBe(true);
    expect(boundedErrorText("abc", 2)).toBe("ab");
    expect(boundedUtf8Text("💥x", 4)).toBe("…");
  });
});
