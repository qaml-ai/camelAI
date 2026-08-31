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
  parseDerivedPiRenderCursor,
  encodeDerivedPiRowCursor,
  encodeDerivedArchiveCursor,
  selectNewestUiMessageWindow,
  markRenderFoldPartial,
  prependOlderRenderMessages,
  RENDER_FOLD_PARTIAL_METADATA_KEY,
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

describe("storage-boundary derive cursors", () => {
  it("round-trips pi-row and archive-phase cursors", () => {
    expect(parseDerivedPiRenderCursor(encodeDerivedPiRowCursor(4200))).toEqual({
      kind: "pi",
      beforeIdx: 4200,
    });
    // The ai-chat chronology cursor carries its own prefix and colons verbatim.
    const archive = encodeDerivedArchiveCursor("e:2026-08-17 12:00:00.500");
    expect(parseDerivedPiRenderCursor(archive)).toEqual({
      kind: "archive",
      beforeCursor: "e:2026-08-17 12:00:00.500",
    });
    expect(parseDerivedPiRenderCursor(encodeDerivedArchiveCursor(null))).toEqual({
      kind: "archive",
      beforeCursor: null,
    });
  });

  it("does not accept legacy or foreign cursors as pi cursors", () => {
    expect(parseDerivedPiRenderCursor("d:12")).toBeNull();
    expect(parseDerivedPiRenderCursor("i:2026-08-17 12:00:00")).toBeNull();
    expect(parseDerivedPiRenderCursor("dp:p:-1")).toBeNull();
    expect(parseDerivedPiRenderCursor("dp:x:1")).toBeNull();
  });

  it("reports the budget a selected window consumed", () => {
    const messages = Array.from({ length: 4 }, (_, index) =>
      uiMessage(`m${index}`),
    );
    const window = selectNewestUiMessageWindow(messages, { maxMessages: 2 });
    expect(window.messages.map((message) => message.id)).toEqual(["m2", "m3"]);
    expect(window.bytes).toBeGreaterThan(0);
    expect(window.bytes).toBe(
      window.messages.reduce(
        (total, message) => total + JSON.stringify(message).length,
        0,
      ),
    );
  });
});

describe("prependOlderRenderMessages — split folds", () => {
  function partial(id: string, text: string): UIMessage {
    return markRenderFoldPartial(uiMessage(id, text));
  }

  it("merges the earlier half of a turn the server served partial", () => {
    // The derive's window closed inside `turn-1`'s fold: the newest page carries
    // the closing text, the older page re-emits the same id with the tool trace.
    const resident: UIMessage[] = [
      partial("turn-1", "closing answer"),
      uiMessage("turn-2"),
    ];
    const older: UIMessage[] = [
      uiMessage("turn-0"),
      {
        id: "turn-1",
        role: "assistant",
        parts: [
          { type: "text", text: "opening thought" },
          {
            type: "tool-read_file",
            toolCallId: "call-1",
            state: "output-available",
          },
        ],
      } as unknown as UIMessage,
    ];

    const result = prependOlderRenderMessages(resident, older);
    expect(result.map((message) => message.id)).toEqual([
      "turn-0",
      "turn-1",
      "turn-2",
    ]);
    const merged = result[1];
    expect(
      (merged.parts as Array<Record<string, unknown>>).map((part) =>
        part.type === "text" ? part.text : part.toolCallId,
      ),
    ).toEqual(["opening thought", "call-1", "closing answer"]);
    // The flag is consumed once the halves are reunited.
    expect(
      (merged.metadata as Record<string, unknown> | undefined)?.[
        RENDER_FOLD_PARTIAL_METADATA_KEY
      ],
    ).toBeUndefined();
  });

  it("keeps the flag while the turn is still cut further back", () => {
    const resident = [partial("turn-1", "third slice")];
    const result = prependOlderRenderMessages(resident, [
      partial("turn-1", "second slice"),
    ]);
    expect(result).toHaveLength(1);
    expect(
      (result[0].parts as Array<Record<string, unknown>>).map(
        (part) => part.text,
      ),
    ).toEqual(["second slice", "third slice"]);
    expect(
      (result[0].metadata as Record<string, unknown>)[
        RENDER_FOLD_PARTIAL_METADATA_KEY
      ],
    ).toBe(true);
  });

  it("still keeps the held copy for an ordinary duplicate id", () => {
    const resident = [uiMessage("m3", "resident-m3")];
    const result = prependOlderRenderMessages(resident, [
      uiMessage("m3", "stale-m3"),
    ]);
    expect(result).toBe(resident);
  });

  it("does not re-add parts the held copy already carries", () => {
    const resident = [partial("turn-1", "same text")];
    const result = prependOlderRenderMessages(resident, [
      uiMessage("turn-1", "same text"),
    ]);
    expect(result[0].parts).toHaveLength(1);
  });
});
