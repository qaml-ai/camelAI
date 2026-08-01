import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  appendEvictedRenderMessages,
  classifyResidentRenderHistoryUpdate,
  encodeDerivedRenderHistoryCursor,
  findEvictedRenderMessages,
  isCurrentRenderHistoryGeneration,
  pageDerivedUiMessages,
  parseDerivedRenderHistoryCursor,
  prependOlderRenderMessages,
  shouldHydrateRenderHistoryCursor,
} from "@/lib/chat-render-history";

function uiMessage(id: string, text = id): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

describe("prependOlderRenderMessages", () => {
  it("prepends older chronology and keeps the resident version of duplicate ids", () => {
    const resident = [uiMessage("m3", "resident-m3"), uiMessage("m4")];
    const result = prependOlderRenderMessages(resident, [
      uiMessage("m1"),
      uiMessage("m2"),
      uiMessage("m3", "stale-m3"),
    ]);

    expect(result.map((message) => message.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    expect(result[2].parts).toEqual(resident[0].parts);
  });

  it("deduplicates malformed overlapping pages without changing current state", () => {
    const current = [uiMessage("m2")];
    expect(
      prependOlderRenderMessages(current, [
        uiMessage("m1"),
        uiMessage("m1"),
        uiMessage("m2"),
      ]).map((message) => message.id),
    ).toEqual(["m1", "m2"]);
    expect(prependOlderRenderMessages(current, [uiMessage("m2")])).toBe(
      current,
    );
  });
});

describe("resident render-history rollover", () => {
  it("retains rows evicted when an overlapping resident window advances", () => {
    const previous = Array.from({ length: 50 }, (_, index) =>
      uiMessage(`message-${index}`),
    );
    const next = Array.from({ length: 50 }, (_, index) =>
      uiMessage(`message-${index + 2}`),
    );

    const evicted = findEvictedRenderMessages(previous, next);
    expect(evicted.map((message) => message.id)).toEqual([
      "message-0",
      "message-1",
    ]);
    expect(
      appendEvictedRenderMessages([uiMessage("message-0")], evicted).map(
        (message) => message.id,
      ),
    ).toEqual(["message-0", "message-1"]);
  });

  it("does not retain a wholesale resident-history replacement", () => {
    const update = classifyResidentRenderHistoryUpdate(
      [uiMessage("old-1"), uiMessage("old-2")],
      [uiMessage("replacement-1"), uiMessage("replacement-2")],
    );
    expect(update).toEqual({ kind: "replacement", evicted: [] });
  });

  it("treats partial authoritative replacement and clear as resets", () => {
    expect(
      classifyResidentRenderHistoryUpdate(
        [
          uiMessage("m1"),
          uiMessage("m2"),
          uiMessage("m3"),
          uiMessage("m4"),
        ],
        [uiMessage("m1"), uiMessage("m3"), uiMessage("m4"), uiMessage("m5")],
      ),
    ).toEqual({ kind: "replacement", evicted: [] });
    expect(
      classifyResidentRenderHistoryUpdate(
        [uiMessage("m1"), uiMessage("m2")],
        [],
      ),
    ).toEqual({ kind: "replacement", evicted: [] });
  });

  it("retires pre-reset cursor props and in-flight page responses", () => {
    expect(shouldHydrateRenderHistoryCursor(0, null, "loader-cursor")).toBe(
      true,
    );
    expect(
      shouldHydrateRenderHistoryCursor(
        1,
        null,
        "loader-cursor",
      ),
    ).toBe(false);
    expect(isCurrentRenderHistoryGeneration(0, 1)).toBe(false);
    expect(isCurrentRenderHistoryGeneration(1, 1)).toBe(true);
  });
});

describe("pageDerivedUiMessages", () => {
  it("returns the newest window with a d: cursor for older pages", () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      uiMessage(`m${index}`),
    );
    const first = pageDerivedUiMessages(messages, { maxMessages: 2 });
    expect(first.messages.map((message) => message.id)).toEqual(["m3", "m4"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(encodeDerivedRenderHistoryCursor(3));
    expect(parseDerivedRenderHistoryCursor(first.nextCursor!)).toBe(3);

    const older = pageDerivedUiMessages(messages, {
      beforeCursor: first.nextCursor,
      maxMessages: 2,
    });
    expect(older.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(older.nextCursor).toBe(encodeDerivedRenderHistoryCursor(1));

    const oldest = pageDerivedUiMessages(messages, {
      beforeCursor: older.nextCursor,
      maxMessages: 2,
    });
    expect(oldest.messages.map((message) => message.id)).toEqual(["m0"]);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextCursor).toBeNull();
  });

  it("rejects non-derived cursors", () => {
    expect(() =>
      pageDerivedUiMessages([uiMessage("m0")], {
        beforeCursor: "i:not-derived",
      }),
    ).toThrow(/derived render-history cursor/);
  });
});
