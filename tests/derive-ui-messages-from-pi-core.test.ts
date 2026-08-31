import { describe, expect, it } from "vitest";

import {
  deriveUiMessagesFromParsedPiCore,
  deriveUiMessagesWithRowAnchors,
  overlayLiveUiMessages,
  type PiParsedRenderMessage,
} from "@/lib/derive-ui-messages-from-pi-core";
import { PI_STEER_MARKER_PART } from "@/lib/pi-chunk-encoder";
import type { UIMessage } from "ai";

function user(
  overrides: Partial<PiParsedRenderMessage> &
    Pick<PiParsedRenderMessage, "id" | "created_at" | "content">,
): PiParsedRenderMessage {
  return {
    role: "user",
    forkEntryId: overrides.id,
    ...overrides,
  };
}

function assistant(
  overrides: Partial<PiParsedRenderMessage> &
    Pick<PiParsedRenderMessage, "id" | "created_at" | "content">,
): PiParsedRenderMessage {
  return {
    role: "assistant",
    forkEntryId: overrides.id,
    ...overrides,
  };
}

describe("deriveUiMessagesFromParsedPiCore", () => {
  it("orders by pi_core sequence and prefers stamped user skeleton ids", () => {
    const derived = deriveUiMessagesFromParsedPiCore([
      user({
        id: "pi_user_1_0",
        created_at: 1,
        content: "[web message from Illiana Reed (illiana@camelai.com)]: June",
        renderMessageId: "client_june",
      }),
      user({
        id: "pi_user_2_1",
        created_at: 2,
        content: "[web message from Illiana Reed (illiana@camelai.com)]: timeout",
        renderMessageId: "client_timeout",
      }),
      assistant({
        id: "resp-a",
        created_at: 3,
        content: [{ type: "text", text: "lazy loading done" }],
        renderMessageId: "turn-1",
      }),
    ]);

    expect(derived.map((message) => message.id)).toEqual([
      "client_june",
      "client_timeout",
      "turn-1",
    ]);
    expect(
      (derived[0].parts[0] as { text?: string }).text,
    ).toBe("June");
    expect(
      (derived[0].metadata as { authorDisplayName?: string }).authorDisplayName,
    ).toBe("Illiana Reed");
  });

  it("folds multi-SDK-turn assistants and inserts steer markers", () => {
    const derived = deriveUiMessagesFromParsedPiCore([
      user({
        id: "pi_user_1_0",
        created_at: 1,
        content: "start",
        renderMessageId: "client_start",
      }),
      assistant({
        id: "resp-1",
        created_at: 2,
        content: [{ type: "text", text: "pre-steer" }],
        renderMessageId: "turn-1",
      }),
      user({
        id: "pi_user_3_2",
        created_at: 3,
        content: "steer me",
        renderMessageId: "client_steer",
      }),
      assistant({
        id: "resp-2",
        created_at: 4,
        content: [{ type: "text", text: "post-steer" }],
        renderMessageId: "turn-1",
      }),
    ]);

    expect(derived.map((message) => message.id)).toEqual([
      "client_start",
      "turn-1",
      "client_steer",
    ]);
    const folded = derived[1];
    expect(folded.parts.map((part) => part.type)).toEqual([
      "text",
      PI_STEER_MARKER_PART,
      "text",
    ]);
    expect(
      (folded.parts[1] as { data?: { steerMessageId?: string } }).data
        ?.steerMessageId,
    ).toBe("client_steer");
  });

  it("omits compaction summary rows from the visible derive", () => {
    const derived = deriveUiMessagesFromParsedPiCore([
      user({
        id: "pi_user_summary",
        created_at: 1,
        content: "summary of earlier work",
        isCompactSummary: true,
      }),
      user({
        id: "pi_user_tail",
        created_at: 2,
        content: "tail",
        renderMessageId: "client_tail",
      }),
    ]);
    expect(derived.map((message) => message.id)).toEqual(["client_tail"]);
  });
});

describe("overlayLiveUiMessages", () => {
  it("lets the live open-turn row win and appends live-only skeletons", () => {
    const settled = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "hi", state: "done" }],
        metadata: { pi: { createdAtMs: 1 } },
      },
      {
        id: "turn-1",
        role: "assistant",
        parts: [{ type: "text", text: "partial", state: "done" }],
      },
    ] as UIMessage[];
    const live = [
      {
        id: "turn-1",
        role: "assistant",
        parts: [{ type: "text", text: "live", state: "streaming" }],
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "just sent", state: "done" }],
      },
    ] as UIMessage[];

    const overlaid = overlayLiveUiMessages(settled, live, {
      activeTurnId: "turn-1",
    });
    expect(overlaid.map((message) => message.id)).toEqual([
      "u1",
      "turn-1",
      "u2",
    ]);
    expect((overlaid[1].parts[0] as { text?: string }).text).toBe("live");
  });

  it("prefers live skeletons matched by piCoreMessageKey / forkEntryId", () => {
    const settled = [
      {
        id: "pi_user_1000_0",
        role: "user",
        parts: [{ type: "text", text: "q", state: "done" }],
        metadata: { pi: { createdAtMs: 1000 } },
      },
      {
        id: "resp-1",
        role: "assistant",
        parts: [{ type: "text", text: "a", state: "done" }],
      },
    ] as UIMessage[];
    const live = [
      {
        id: "client-user-1",
        role: "user",
        parts: [{ type: "text", text: "q", state: "done" }],
        metadata: { piCoreMessageKey: "1000" },
      },
      {
        id: "turn-mint-1",
        role: "assistant",
        parts: [{ type: "text", text: "a", state: "done" }],
        metadata: { pi: { forkEntryId: "resp-1" } },
      },
    ] as UIMessage[];

    expect(
      overlayLiveUiMessages(settled, live, { activeTurnId: null }).map(
        (message) => message.id,
      ),
    ).toEqual(["client-user-1", "turn-mint-1"]);
  });

  it("keeps archive ids when compaction renumbers pi_user_* indexes", () => {
    const settled = [
      {
        id: "pi_user_1000_0",
        role: "user",
        parts: [{ type: "text", text: "old", state: "done" }],
        metadata: { pi: { createdAtMs: 1000 } },
      },
      {
        id: "resp-old",
        role: "assistant",
        parts: [{ type: "text", text: "old a", state: "done" }],
        metadata: { pi: { forkEntryId: "resp-old", createdAtMs: 1100 } },
      },
      {
        id: "pi_user_2000_1",
        role: "user",
        parts: [{ type: "text", text: "new", state: "done" }],
        metadata: { pi: { createdAtMs: 2000 } },
      },
      {
        id: "resp-new",
        role: "assistant",
        parts: [{ type: "text", text: "new a", state: "done" }],
        metadata: { pi: { forkEntryId: "resp-new", createdAtMs: 2100 } },
      },
    ] as UIMessage[];
    const live = [
      {
        id: "pi_user_1000_0",
        role: "user",
        parts: [{ type: "text", text: "old", state: "done" }],
        metadata: { pi: { createdAtMs: 1000 } },
      },
      {
        id: "resp-old",
        role: "assistant",
        parts: [{ type: "text", text: "old a", state: "done" }],
        metadata: { pi: { forkEntryId: "resp-old", createdAtMs: 1100 } },
      },
      {
        id: "pi_user_2000_2",
        role: "user",
        parts: [{ type: "text", text: "new", state: "done" }],
        metadata: { pi: { createdAtMs: 2000 } },
      },
      {
        id: "resp-new",
        role: "assistant",
        parts: [{ type: "text", text: "new a", state: "done" }],
        metadata: { pi: { forkEntryId: "resp-new", createdAtMs: 2100 } },
      },
    ] as UIMessage[];

    expect(
      overlayLiveUiMessages(settled, live, { activeTurnId: null }).map(
        (message) => message.id,
      ),
    ).toEqual(["pi_user_1000_0", "resp-old", "pi_user_2000_2", "resp-new"]);
  });
});

describe("deriveUiMessagesWithRowAnchors", () => {
  it("reports a fold's first and last input row so a window cannot split it", () => {
    const parsed: PiParsedRenderMessage[] = [
      user({ id: "pi_user_1_0", created_at: 1, content: "q" }),
      assistant({
        id: "resp-a",
        created_at: 2,
        content: [{ type: "text", text: "part 1" }],
        renderMessageId: "turn-1",
      }),
      user({
        id: "pi_user_3_2",
        created_at: 3,
        content: "steer",
        renderMessageId: "client-steer",
      }),
      assistant({
        id: "resp-b",
        created_at: 4,
        content: [{ type: "text", text: "part 2" }],
        renderMessageId: "turn-1",
      }),
    ];

    const derived = deriveUiMessagesWithRowAnchors(parsed);
    expect(derived.messages.map((message) => message.id)).toEqual([
      "pi_user_1_0",
      "turn-1",
      "client-steer",
    ]);
    expect(derived.anchorIndexes).toEqual([0, 1, 2]);
    // The fold's span reaches row 3, PAST the steer bubble that sorts after it.
    expect(derived.endIndexes).toEqual([0, 3, 2]);
    expect(deriveUiMessagesFromParsedPiCore(parsed)).toEqual(derived.messages);
  });

  it("reports anchors in input space when compaction summaries are filtered", () => {
    const parsed: PiParsedRenderMessage[] = [
      user({
        id: "summary",
        created_at: 1,
        content: "summary",
        isCompactSummary: true,
      }),
      user({ id: "pi_user_2_1", created_at: 2, content: "q" }),
    ];
    const derived = deriveUiMessagesWithRowAnchors(parsed);
    expect(derived.messages.map((message) => message.id)).toEqual(["pi_user_2_1"]);
    expect(derived.anchorIndexes).toEqual([1]);
    expect(derived.endIndexes).toEqual([1]);
  });
});

describe("overlayLiveUiMessages append bounds", () => {
  const settled = [
    {
      id: "settled-new",
      role: "user",
      parts: [{ type: "text", text: "newest settled", state: "done" }],
      metadata: { pi: { createdAtMs: 5_000 } },
    },
  ] as UIMessage[];
  const live = [
    {
      id: "older-archive-row",
      role: "assistant",
      parts: [{ type: "text", text: "an older page's row", state: "done" }],
      metadata: { pi: { createdAtMs: 1_000 } },
    },
    {
      id: "in-flight",
      role: "assistant",
      parts: [{ type: "text", text: "streaming", state: "streaming" }],
      metadata: { pi: { createdAtMs: 6_000 } },
    },
  ] as UIMessage[];

  it("appends only rows at or after the window's newest settled message", () => {
    expect(
      overlayLiveUiMessages(settled, live, {
        activeTurnId: null,
        appendLiveOnlyNewerThanMs: 5_000,
      }).map((message) => message.id),
    ).toEqual(["settled-new", "in-flight"]);
  });

  it("appends nothing for an older page", () => {
    expect(
      overlayLiveUiMessages(settled, live, {
        activeTurnId: null,
        appendLiveOnly: false,
      }).map((message) => message.id),
    ).toEqual(["settled-new"]);
  });
});
