import { act, renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
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

function uiMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: `content-${id}` }],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("chat transcript hooks", () => {
  it("derives a legacy seed from UI messages and captures loader error ids", () => {
    const initialUiMessages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "hello", state: "done" },
          { type: "data-pi-error", data: { id: "error-1" } },
        ],
      } as unknown as UIMessage,
    ];

    const { result } = renderHook(() =>
      useInitialChatTranscript({
        threadId: "thread-1",
        initialUiMessages,
      }),
    );

    expect(result.current.parsedInitialMessages).toHaveLength(1);
    expect(result.current.parsedInitialMessages[0].id).toBe("assistant-1");
    expect(result.current.loaderErrorIdsRef.current.has("error-1")).toBe(true);
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
        liveUiMessages: [],
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

  it("prepends render-only archived pages without replacing resident duplicate ids", () => {
    const { result } = renderHook(() =>
      useChatTranscriptProjection({
        archivedUiMessages: [
          uiMessage("older-1"),
          uiMessage("boundary"),
        ],
        liveMessages: [
          message("boundary", "assistant"),
          message("resident", "assistant"),
        ],
        liveUiMessages: [uiMessage("boundary"), uiMessage("resident")],
        optimisticMessages: [],
        parsedInitialMessages: [],
        readOnly: false,
        threadId: "thread-1",
      }),
    );

    expect(result.current.displayMessages.map(({ id }) => id)).toEqual([
      "older-1",
      "boundary",
      "resident",
    ]);
    expect(result.current.displayMessages[0].thread_id).toBe("thread-1");
  });

  it("expires the snapshot bridge when a resumed stream never arrives", () => {
    vi.useFakeTimers();
    const bridgedMessage = message("assistant-1", "assistant");
    const { result } = renderHook(() =>
      useChatTranscriptProjection({
        bridgedStreamingMessageId: "assistant-1",
        liveMessages: [message("user-1")],
        liveUiMessages: [],
        optimisticMessages: [],
        parsedInitialMessages: [bridgedMessage],
        readOnly: false,
      }),
    );

    expect(result.current.displayMessages.map(({ id }) => id)).toContain(
      "assistant-1",
    );

    act(() => vi.advanceTimersByTime(15_000));

    expect(result.current.displayMessages.map(({ id }) => id)).not.toContain(
      "assistant-1",
    );
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
