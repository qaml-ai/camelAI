import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContentBlock, Message } from "@/types";
import {
  CHAT_MAX_SNAPSHOT_MESSAGES,
  ChatRuntimeClient,
  type ChatRuntimeActiveTurn,
  type ChatRuntimeConnectionStatus,
  type ChatRuntimeFrame,
  type ChatRuntimeLiveFrame,
  type ChatRuntimeMessage,
} from "./chat-runtime-client";

export interface UseChatRuntimeOptions<State = unknown> { threadId: string | undefined; baseUrl?: string; enabled?: boolean; initialMessages?: ChatRuntimeMessage[]; initialState?: State }

export interface UseChatRuntimeResult<State = unknown> {
  runtimeMessages: ChatRuntimeMessage[];
  messages: Message[];
  state: State | undefined;
  activeTurn: ChatRuntimeActiveTurn | null;
  activeAssistantMessageId: string | null;
  status: ChatRuntimeActiveTurn["status"] | "idle";
  connectionStatus: ChatRuntimeConnectionStatus;
  ready: boolean;
  connecting: boolean;
  offline: boolean;
  reconnect: () => void;
  sendMessage: <T = unknown, Body = unknown>(body: Body) => Promise<T>;
  control: <T = unknown, Payload = unknown>(action: string, payload?: Payload) => Promise<T>;
}

function upsertBounded(
  messages: ChatRuntimeMessage[],
  message: ChatRuntimeMessage,
): ChatRuntimeMessage[] {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  const next = index < 0 ? [...messages, message] : messages.with(index, message);
  return next.slice(-CHAT_MAX_SNAPSHOT_MESSAGES);
}

export function useChatRuntime<State = unknown>({
  threadId,
  baseUrl,
  enabled = true,
  initialMessages = [],
  initialState,
}: UseChatRuntimeOptions<State>): UseChatRuntimeResult<State> {
  const boundedInitial = initialMessages.slice(-CHAT_MAX_SNAPSHOT_MESSAGES);
  const [runtimeMessages, setRuntimeMessages] = useState<ChatRuntimeMessage[]>(boundedInitial);
  const [state, setState] = useState<State | undefined>(initialState);
  const [activeTurn, setActiveTurn] = useState<ChatRuntimeActiveTurn | null>(null);
  const [liveOverlay, setLiveOverlay] = useState<ChatRuntimeLiveFrame | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ChatRuntimeConnectionStatus>("idle");
  const clientRef = useRef<ChatRuntimeClient<State> | null>(null);

  useEffect(() => {
    setRuntimeMessages(boundedInitial);
    setState(initialState);
    setActiveTurn(null);
    setLiveOverlay(null);
    if (!enabled || !threadId) {
      setConnectionStatus("idle");
      return;
    }
    let current = true;
    let pendingLive: ChatRuntimeLiveFrame | null = null;
    let liveFlushScheduled = false;
    const flushPendingLive = () => {
      liveFlushScheduled = false;
      const frame = pendingLive;
      pendingLive = null;
      if (!current || !frame) return;
      setActiveTurn(frame.activeTurn);
      setLiveOverlay(frame);
    };
    const queueLive = (frame: ChatRuntimeLiveFrame) => {
      pendingLive = frame;
      if (liveFlushScheduled) return;
      liveFlushScheduled = true;
      queueMicrotask(flushPendingLive);
    };
    const reconcileLive = (next: ChatRuntimeActiveTurn | null) => {
      if (pendingLive && (next?.id !== pendingLive.turnId || next.status !== "running")) pendingLive = null;
      setActiveTurn(next);
      setLiveOverlay((live) => live && next?.id === live.turnId && next.status === "running" ? live : null);
    };
    const client = new ChatRuntimeClient<State>({
      baseUrl:
        baseUrl ?? `/agents/chat-thread/${encodeURIComponent(threadId)}/v2`,
      onStatus: (next) => current && setConnectionStatus(next),
      onLiveReset: () => {
        pendingLive = null;
        if (current) setLiveOverlay(null);
      },
      onFrame: (frame: ChatRuntimeFrame<State>) => {
        if (!current) return;
        if (frame.type === "snapshot" || frame.type === "reset") {
          reconcileLive(frame.activeTurn);
          setRuntimeMessages(frame.messages);
          if ("state" in frame) setState(frame.state);
        } else if (frame.type === "turn") {
          reconcileLive(frame.activeTurn);
          if (frame.message) setRuntimeMessages((messages) => upsertBounded(messages, frame.message!));
        } else if (frame.type === "live") queueLive(frame);
        else if (frame.type === "state") setState(frame.state);
      },
    });
    clientRef.current = client;
    client.start();
    return () => {
      current = false;
      pendingLive = null;
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
    // Array identity is intentionally not a connection key. A server snapshot
    // owns reconciliation after the initial seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, enabled, threadId]);

  const visibleRuntimeMessages = useMemo(() => liveOverlay ? upsertBounded(runtimeMessages, liveOverlay.message) : runtimeMessages, [liveOverlay, runtimeMessages]);
  const activeAssistantMessageId = liveOverlay?.message.id ?? null;
  const messages = useMemo(
    () =>
      visibleRuntimeMessages.map(
        (message): Message => ({
          id: message.id,
          ...(message.role === "user" && message.id.endsWith(":user")
            ? { clientMessageId: message.id.slice(0, -":user".length) }
            : {}),
          thread_id: threadId ?? "",
          role: message.role,
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : (message.content as ContentBlock[]),
          created_at: message.createdAt,
          ...(message.id === activeAssistantMessageId
            ? { isStreaming: true }
            : {}),
        }),
      ),
    [activeAssistantMessageId, threadId, visibleRuntimeMessages],
  );
  const reconnect = useCallback(() => clientRef.current?.reconnect(), []);
  const sendMessage = useCallback(<T = unknown, Body = unknown>(body: Body) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error("chat runtime is disabled"));
    return client.sendMessage<T, Body>(body);
  }, []);
  const control = useCallback(
    <T = unknown, Payload = unknown>(action: string, payload?: Payload) => {
      const client = clientRef.current;
      if (!client) return Promise.reject(new Error("chat runtime is disabled"));
      return client.control<T, Payload>(action, payload);
    },
    [],
  );

  return {
    runtimeMessages: visibleRuntimeMessages,
    messages,
    state,
    activeTurn,
    activeAssistantMessageId,
    status: activeTurn?.status ?? "idle",
    connectionStatus,
    ready: connectionStatus === "ready",
    connecting: connectionStatus === "connecting",
    offline: connectionStatus === "offline",
    reconnect,
    sendMessage,
    control,
  };
}
