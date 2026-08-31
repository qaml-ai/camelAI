import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";

import type { Message } from "@/types";
import { parseMessageContent } from "@/lib/chat-message-content";
import { mergeOverlay } from "@/lib/runtime-message-state";
import { isSteerSliceIdOf } from "@/lib/steer-split";
import {
  createTranscriptNormalizationCaches,
  mergeTaskNotifications,
  mergeTeammateMessages,
  normalizeToolResultMessages,
} from "@/lib/streaming";
import { uiMessageToMessage } from "@/lib/ui-message-adapter";

const EMPTY_UI_MESSAGES: UIMessage[] = [];
const BRIDGED_STREAMING_MESSAGE_MAX_AGE_MS = 15_000;

interface InitialChatTranscriptOptions {
  threadId?: string;
  initialMessages?: Message[];
  initialUiMessages?: UIMessage[];
}

/**
 * Normalizes the loader-owned transcript seed and records terminal errors that
 * were already rendered before the live agent connection mounts.
 */
export function useInitialChatTranscript({
  threadId,
  initialMessages,
  initialUiMessages,
}: InitialChatTranscriptOptions) {
  const parsedInitialMessages = useMemo(() => {
    const source =
      initialMessages && initialMessages.length > 0
        ? initialMessages
        : (initialUiMessages ?? []).map((ui) =>
            uiMessageToMessage(ui, { threadId }),
          );
    return source.map((message) => ({
      ...message,
      content: parseMessageContent(message.content),
    }));
  }, [initialMessages, initialUiMessages, threadId]);

  const stableInitialUiMessages = useMemo(
    () => initialUiMessages ?? EMPTY_UI_MESSAGES,
    [initialUiMessages],
  );

  const loaderErrorIdsRef = useRef<Set<string>>(new Set());
  const loaderErrorIdsSourceRef = useRef<UIMessage[] | null>(null);
  if (loaderErrorIdsSourceRef.current !== stableInitialUiMessages) {
    loaderErrorIdsSourceRef.current = stableInitialUiMessages;
    for (const uiMessage of stableInitialUiMessages) {
      for (const part of uiMessage.parts) {
        if (part.type !== "data-pi-error") continue;
        const errorId = (part as { data?: { id?: unknown } }).data?.id;
        if (typeof errorId === "string" && errorId) {
          loaderErrorIdsRef.current.add(errorId);
        }
      }
    }
  }

  return {
    loaderErrorIdsRef,
    parsedInitialMessages,
    stableInitialUiMessages,
  };
}

interface ChatTranscriptProjectionOptions {
  archivedUiMessages?: UIMessage[];
  bridgedStreamingMessageId?: string | null;
  threadId?: string;
  liveMessages: Message[];
  liveUiMessages: UIMessage[];
  optimisticMessages: Message[];
  parsedInitialMessages: Message[];
  readOnly: boolean;
}

/**
 * Owns the render-side transcript projection: loader fallback, bounded stream
 * bridge, optimistic overlays, and the normalization chain used by Chat.
 */
export function useChatTranscriptProjection({
  archivedUiMessages = EMPTY_UI_MESSAGES,
  bridgedStreamingMessageId,
  threadId,
  liveMessages,
  liveUiMessages,
  optimisticMessages,
  parsedInitialMessages,
  readOnly,
}: ChatTranscriptProjectionOptions) {
  const [bridgeExpired, setBridgeExpired] = useState(
    () => !bridgedStreamingMessageId,
  );

  useEffect(() => {
    if (!bridgedStreamingMessageId) return;
    const timer = window.setTimeout(
      () => setBridgeExpired(true),
      BRIDGED_STREAMING_MESSAGE_MAX_AGE_MS,
    );
    return () => window.clearTimeout(timer);
    // The Chat component is keyed by thread, so this bridge is mount-scoped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bridgeMessages = useMemo<Message[]>(() => {
    if (!bridgedStreamingMessageId || bridgeExpired || readOnly) return [];
    if (
      liveUiMessages.some((message) => message.id === bridgedStreamingMessageId)
    ) {
      return [];
    }
    return parsedInitialMessages.filter((message) =>
      isSteerSliceIdOf(bridgedStreamingMessageId, message.id),
    );
  }, [
    bridgedStreamingMessageId,
    bridgeExpired,
    liveUiMessages,
    parsedInitialMessages,
    readOnly,
  ]);

  const residentMessages = useMemo(() => {
    if (readOnly) return parsedInitialMessages;
    if (liveMessages.length === 0) return parsedInitialMessages;
    return bridgeMessages.length > 0
      ? [...liveMessages, ...bridgeMessages]
      : liveMessages;
  }, [bridgeMessages, liveMessages, parsedInitialMessages, readOnly]);

  const baseMessages = useMemo(() => {
    if (readOnly || archivedUiMessages.length === 0) return residentMessages;
    const residentIds = new Set(residentMessages.map((message) => message.id));
    const archived = archivedUiMessages
      .filter((message) => !residentIds.has(message.id))
      .map((message) => uiMessageToMessage(message, { threadId }));
    return archived.length === 0
      ? residentMessages
      : [...archived, ...residentMessages];
  }, [archivedUiMessages, readOnly, residentMessages, threadId]);

  const displayMessages = useMemo(() => {
    if (optimisticMessages.length === 0) return baseMessages;
    const baseKeys = new Set<string>();
    for (const message of baseMessages) {
      baseKeys.add(message.id);
      if (message.clientMessageId) baseKeys.add(message.clientMessageId);
    }
    const optimistic = optimisticMessages.filter(
      (message) =>
        !baseKeys.has(message.id) &&
        !(message.clientMessageId && baseKeys.has(message.clientMessageId)),
    );
    return optimistic.length === 0
      ? baseMessages
      : mergeOverlay(baseMessages, optimistic);
  }, [baseMessages, optimisticMessages]);

  const displayMessagesRef = useRef<Message[]>(displayMessages);
  displayMessagesRef.current = displayMessages;

  const normalizationCachesRef = useRef(createTranscriptNormalizationCaches());
  const normalizedMessages = useMemo(
    () =>
      mergeTaskNotifications(
        mergeTeammateMessages(
          normalizeToolResultMessages(
            displayMessages,
            normalizationCachesRef.current,
          ),
          normalizationCachesRef.current,
        ),
        normalizationCachesRef.current,
      ),
    [displayMessages],
  );

  const visibleMessages = useMemo(
    () =>
      normalizedMessages.filter(
        (message) => !message.isMeta && !message.sourceToolUseID,
      ),
    [normalizedMessages],
  );

  const skillSheetsByToolId = useMemo(() => {
    const map = new Map<string, string>();
    for (const message of normalizedMessages) {
      if (!message.sourceToolUseID) continue;
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((block) => (block?.type === "text" ? block.text : ""))
              .filter(Boolean)
              .join("\n\n");
      if (content) map.set(message.sourceToolUseID, content);
    }
    return map;
  }, [normalizedMessages]);

  return {
    displayMessages,
    displayMessagesRef,
    skillSheetsByToolId,
    visibleMessages,
  };
}
