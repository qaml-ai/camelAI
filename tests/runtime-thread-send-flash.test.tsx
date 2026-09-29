/**
 * What a runtime thread's transcript does on screen while a message is sent,
 * driven through the real pieces: useRuntimeThread (with a scripted watcher
 * replaying the runtime's event order), Chat's transcript projection (the
 * optimistic bubble overlay) and ChatMessagesView. MessageBubble is replaced
 * by a probe that counts mounts and records which rows render as active.
 */
import { createRef } from "react";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentBlock, Message } from "@/types";

const probe = vi.hoisted(() => ({ mounts: new Map<string, number>(), renders: new Map<string, number>() }));

vi.mock("@/components/message-bubble", async () => {
  const { memo, useEffect } = await import("react");
  const text = (content: string | ContentBlock[]) =>
    typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "")).join("");
  // Memoized on the message object, as the real MessageBubble is.
  return {
    MessageBubble: memo(({ message }: { message: Message; renderMode?: string }) => {
      const label = text(message.content) || message.id;
      probe.renders.set(label, (probe.renders.get(label) ?? 0) + 1);
      useEffect(() => {
        probe.mounts.set(label, (probe.mounts.get(label) ?? 0) + 1);
      }, []);
      return <div data-testid="bubble">{label}</div>;
    }, (previous, next) => previous.message === next.message && previous.renderMode === next.renderMode),
    isInterruptMessage: () => false,
    parseLocalCommandStdout: () => null,
    parseSlashCommand: () => null,
    userFacingContentToString: text,
  };
});

type WatcherState = Record<string, unknown> & { messages: unknown[]; indexes: number[] };
const watchers: Array<{ state: WatcherState; emit(patch: Partial<WatcherState>, event?: Record<string, unknown>): void }> = [];
vi.mock("@camelai/agent-runtime/watch", () => ({
  watchAgent: (options: { onChange?: (state: WatcherState) => void; onEvent?: (event: unknown) => void }) => {
    const state: WatcherState = { messages: [], indexes: [], partial: null, progress: new Map(), running: false, pendingInputs: [], lastOutcome: null, hasOlder: false, transport: null, connected: true };
    // As the watcher does: state takes the event in, then onEvent, then onChange.
    watchers.push({ state, emit: (patch, event) => { Object.assign(state, patch); if (event) options.onEvent?.(event); options.onChange?.(state); } });
    return { state, loadOlder: async () => false, close: () => {} };
  },
}));

import { useRuntimeThread, type RuntimeThreadSeed } from "@/lib/use-runtime-thread";
import { useChatTranscriptProjection } from "@/hooks/use-chat-transcript";
import { ChatMessagesView } from "@/components/chat-messages-view";

const history = [
  { index: 0, message: { role: "user", content: [{ type: "text", text: "first question" }], timestamp: 1, requestId: "client_1_a" } },
  { index: 1, message: { role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop", timestamp: 2 } },
];
const seed: RuntimeThreadSeed = {
  agentId: "agt_1", token: "abt", expiresAt: Date.now() + 900_000, url: "https://agents.test",
  page: { entries: history, next: null }, previewTabs: [], activeTabId: null,
};

beforeEach(() => {
  watchers.length = 0;
  probe.mounts.clear();
  probe.renders.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "accepted", requestId: "client_2_b", agentId: "agt_1", fallback: null })));
});

/** Chat's pipeline from the hook's stream to the rendered rows. */
function Transcript({ live, optimistic }: { live: { messages: Message[]; streamingMessageId: string | null }; optimistic: Message[] }) {
  const { visibleMessages } = useChatTranscriptProjection({
    liveMessages: live.messages,
    optimisticMessages: optimistic,
    parsedInitialMessages: [],
    readOnly: false,
  });
  return (
    <ChatMessagesView
      visibleMessages={visibleMessages}
      copyMessage={() => {}}
      copiedMessageId={null}
      runningStartedAt={null}
      activeTurnActionMessageId={live.streamingMessageId}
      isAssistantTurnActive={live.streamingMessageId !== null}
      completedTurns={new Map()}
      freshlyCompletedTurnId={null}
      onFreshlyCompletedTurnAnimationScheduled={() => {}}
      skillSheetsByToolId={new Map()}
      error={null}
      setError={() => {}}
      isCompacting={false}
      compactingPriorMessageId={null}
      isLoadingMessages={false}
      showGlobalAssistantIndicator={false}
      messagesEndRef={createRef()}
    />
  );
}

describe("sending on a runtime thread", () => {
  it("keeps the sent message's row, and never makes the previous answer the streaming turn", async () => {
    const callbacks = { current: { onOpen: vi.fn(), onStateUpdate: vi.fn() } };
    const hook = renderHook(() => useRuntimeThread({ threadId: "t1", workspaceId: "w1", seed, enabled: true, callbacks }));
    await waitFor(() => expect(watchers).toHaveLength(1));
    const optimistic: Message = {
      id: "client_2_b", clientMessageId: "client_2_b", thread_id: "t1", role: "user",
      content: "second question", created_at: Date.now(), messageSource: "web",
    };
    const view = render(<Transcript live={hook.result.current.chat} optimistic={[]} />);
    const rerender = (withOptimistic: boolean) =>
      view.rerender(<Transcript live={hook.result.current.chat} optimistic={withOptimistic ? [optimistic] : []} />);
    const streamingIds: Array<string | null> = [];

    // The user presses send: the bubble appears, the message goes out.
    await act(async () => {
      await hook.result.current.client.call("sendMessage", ["second question", "client_2_b"]);
    });
    rerender(true);
    const base = history.map((entry) => entry.message);

    // The runtime's order: the run starts (agent_start / turn_opened), then the user message ends...
    act(() => watchers[0].emit({ messages: base, indexes: [0, 1], running: true }));
    await waitFor(() => expect(hook.result.current.chat.isStreaming).toBe(true));
    streamingIds.push(hook.result.current.chat.streamingMessageId);
    rerender(true);
    const echoed = { role: "user", content: [{ type: "text", text: "second question" }], timestamp: Date.now(), requestId: "client_2_b" };
    act(() => watchers[0].emit({ messages: [...base, echoed], indexes: [0, 1, 2], running: true }));
    await waitFor(() => expect(hook.result.current.chat.messages.some((message) => message.clientMessageId === "client_2_b")).toBe(true));
    streamingIds.push(hook.result.current.chat.streamingMessageId);
    rerender(false);
    // ...then the answer streams and ends.
    const partial = { role: "assistant", content: [{ type: "text", text: "second answer" }], stopReason: "stop", timestamp: Date.now() };
    act(() => watchers[0].emit({ messages: [...base, echoed], indexes: [0, 1, 2], running: true, partial }));
    await waitFor(() => expect(JSON.stringify(hook.result.current.chat.messages.at(-1)?.content)).toContain("second answer"));
    streamingIds.push(hook.result.current.chat.streamingMessageId);
    rerender(false);
    act(() => watchers[0].emit({ messages: [...base, echoed, partial], indexes: [0, 1, 2, 3], running: false, partial: null }));
    await waitFor(() => expect(hook.result.current.chat.isStreaming).toBe(false));
    rerender(false);

    // The sent message was mounted once: the echoed row took over the optimistic bubble's.
    expect(probe.mounts.get("second question")).toBe(1);
    // The previous answer was never the streaming turn, and the new turn kept one id.
    expect(streamingIds).not.toContain("rt:1");
    expect(new Set(streamingIds.filter(Boolean))).toEqual(new Set(["rt:3"]));
    // The new turn's row appeared once, below the sent message.
    expect(probe.mounts.get("rt:3") ?? 0).toBeLessThanOrEqual(1);
    // Settled rows did not re-render on every event.
    expect(probe.renders.get("first answer")).toBeLessThanOrEqual(2);
  });

  it("ends a reply without an extra row: the turn's tail streams until the run ends", async () => {
    const callbacks = { current: { onOpen: vi.fn(), onStateUpdate: vi.fn() } };
    const hook = renderHook(() => useRuntimeThread({ threadId: "t1", workspaceId: "w1", seed, enabled: true, callbacks }));
    await waitFor(() => expect(watchers).toHaveLength(1));
    const view = render(<Transcript live={hook.result.current.chat} optimistic={[]} />);
    const statuses: string[] = [];
    const rowIds = new Set<string>();
    const step = async (patch: Partial<WatcherState>, event: Record<string, unknown> | undefined, settled: () => boolean) => {
      act(() => watchers[0].emit(patch, event));
      await waitFor(() => expect(settled()).toBe(true));
      view.rerender(<Transcript live={hook.result.current.chat} optimistic={[]} />);
      statuses.push(hook.result.current.chat.status);
      for (const message of hook.result.current.chat.messages) rowIds.add(message.id);
    };
    const base = history.map((entry) => entry.message);
    const echoed = { role: "user", content: [{ type: "text", text: "second question" }], timestamp: Date.now(), requestId: "client_x" };
    const answer = { role: "assistant", content: [{ type: "text", text: "second answer" }], stopReason: "stop", timestamp: Date.now() };
    const chat = () => hook.result.current.chat;

    // The runtime's real order for one reply.
    await step({ running: true }, { type: "agent_start" }, () => chat().isStreaming);
    await step({ running: true }, { type: "turn_opened", index: 2 }, () => chat().isStreaming);
    await step({ messages: [...base, echoed], indexes: [0, 1, 2] }, { type: "message_end", message: echoed }, () => chat().messages.length >= 3);
    await step({ partial: answer }, { type: "message_update" }, () => JSON.stringify(chat().messages.at(-1)?.content).includes("second answer"));
    // The final message ends while the run is still running...
    await step({ messages: [...base, echoed, answer], indexes: [0, 1, 2, 3], partial: null }, { type: "message_end", message: answer }, () => chat().messages.length >= 4);
    // ...until agent_end.
    await step({ running: false }, { type: "agent_end" }, () => !chat().isStreaming);

    // No empty turn after the answer, ever.
    expect([...rowIds]).not.toContain("rt:4");
    expect(probe.mounts.get("second answer")).toBe(1);
    // submitted → streaming → ready, without going back.
    const order = ["submitted", "streaming", "ready"];
    const ranks = statuses.map((status) => order.indexOf(status));
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b));
    expect(statuses.at(-1)).toBe("ready");
    expect(statuses).toContain("streaming");
  });
});
