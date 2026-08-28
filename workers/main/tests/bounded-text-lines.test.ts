import { describe, expect, it } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  selectTextLineWindow,
  truncateTextHead,
} from "../src/bounded-text-lines";

describe("bounded text line scanning", () => {
  it("selects and truncates a newline-dense source without line arrays", () => {
    const text = "a\n".repeat(CHAT_RUNTIME_BOUNDS.toolSourceReadBytes / 2);
    const window = selectTextLineWindow(text, 900_000, 3);

    expect(window).toMatchObject({ content: "a\na\na", outputLines: 3 });
    expect(window?.totalLines).toBe(
      CHAT_RUNTIME_BOUNDS.toolSourceReadBytes / 2 + 1,
    );

    const truncated = truncateTextHead(text, 2_000, 50 * 1024);
    expect(truncated).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      outputLines: 2_000,
      outputBytes: 3_999,
    });
    expect(truncated.content).toHaveLength(3_999);
  });

  it("never splits a surrogate pair at the UTF-8 byte ceiling", () => {
    const truncated = truncateTextHead("a🦕b", 10, 4);
    expect(truncated.content).toBe("a");
    expect(truncated.outputBytes).toBe(1);
    expect(truncated.totalBytes).toBe(6);
  });
});
