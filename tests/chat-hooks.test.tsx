import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { useChatCompaction } from "@/hooks/use-chat-compaction";
import {
  useChatTranscriptProjection,
  useInitialChatTranscript,
} from "@/hooks/use-chat-transcript";
import { useCheckoutStatus } from "@/hooks/use-checkout-status";
import type { Message } from "@/types";

vi.mock("sonner", () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn(),
  },
}));

function message(id: string, role: Message["role"] = "user"): Message {
  return {
    id,
    thread_id: "thread-1",
    role,
    content: `content-${id}`,
    created_at: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat transcript hooks", () => {
  it("parses the loader's transcript", () => {
    const { result } = renderHook(() =>
      useInitialChatTranscript({
        initialMessages: [{ ...message("assistant-1", "assistant"), content: JSON.stringify([{ type: "text", text: "hello" }]) }],
      }),
    );

    expect(result.current.parsedInitialMessages).toHaveLength(1);
    expect(result.current.parsedInitialMessages[0].content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("overlays only optimistic messages that have not echoed from the server", () => {
    const liveMessage = message("server-1");
    const echoedOptimistic = {
      ...message("optimistic-echo"),
      clientMessageId: "client-1",
    };
    const liveEcho = { ...liveMessage, clientMessageId: "client-1" };
    const pendingOptimistic = message("optimistic-pending");

    const { result } = renderHook(() =>
      useChatTranscriptProjection({
        liveMessages: [liveEcho],
        optimisticMessages: [echoedOptimistic, pendingOptimistic],
        parsedInitialMessages: [],
        readOnly: false,
      }),
    );

    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "server-1",
      "optimistic-pending",
    ]);
  });

  it("paints the loader's transcript until the live view has messages, and always when read-only", () => {
    const seeded = [message("seed-1")];
    const live = [message("live-1")];
    const empty = renderHook(() =>
      useChatTranscriptProjection({ liveMessages: [], optimisticMessages: [], parsedInitialMessages: seeded, readOnly: false }),
    );
    expect(empty.result.current.displayMessages).toBe(seeded);
    const running = renderHook(() =>
      useChatTranscriptProjection({ liveMessages: live, optimisticMessages: [], parsedInitialMessages: seeded, readOnly: false }),
    );
    expect(running.result.current.displayMessages).toBe(live);
    const readOnly = renderHook(() =>
      useChatTranscriptProjection({ liveMessages: live, optimisticMessages: [], parsedInitialMessages: seeded, readOnly: true }),
    );
    expect(readOnly.result.current.displayMessages).toBe(seeded);
  });
});

describe("useChatCompaction", () => {
  it("keeps the indicator active until queued manual compactions complete", () => {
    const { result } = renderHook(() => useChatCompaction());

    act(() => {
      result.current.queueManualCompaction();
      result.current.queueManualCompaction();
    });
    expect(result.current.isCompacting).toBe(true);

    act(() => result.current.completeActiveManualCompaction());
    expect(result.current.isCompacting).toBe(true);

    act(() => result.current.completeActiveManualCompaction());
    expect(result.current.isCompacting).toBe(false);
  });

  it("clears active manual compaction state after reconnect recovery", () => {
    const { result } = renderHook(() => useChatCompaction());

    act(() => {
      result.current.activeManualCompactionTurnRef.current = true;
      result.current.syncCompactionIndicator();
    });
    expect(result.current.isCompacting).toBe(true);

    act(() => result.current.clearManualCompactionQueue());
    expect(result.current.activeManualCompactionTurnRef.current).toBe(false);
    expect(result.current.isCompacting).toBe(false);
  });
});

describe("useCheckoutStatus", () => {
  it("shows a success toast and removes checkout state from the URL", () => {
    const navigate = vi.fn();

    renderHook(() =>
      useCheckoutStatus({
        hash: "#preview",
        navigate,
        pathname: "/chat/thread-1",
        search: "?checkout=success&panel=billing",
      }),
    );

    expect(toast.success).toHaveBeenCalledWith("Credits added");
    expect(navigate).toHaveBeenCalledWith(
      "/chat/thread-1?panel=billing#preview",
      { replace: true },
    );
  });
});
