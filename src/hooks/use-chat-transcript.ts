import { useMemo, useRef } from "react";

import type { Message } from "@/types";
import { parseMessageContent } from "@/lib/chat-message-content";
import { mergeOverlay } from "@/lib/runtime-message-state";
import {
  createTranscriptNormalizationCaches,
  mergeTaskNotifications,
  mergeTeammateMessages,
  normalizeToolResultMessages,
} from "@/lib/streaming";

export function useInitialChatTranscript({
  initialMessages = [],
}: {
  initialMessages?: Message[];
}) {
  const parsedInitialMessages = useMemo(
    () =>
      initialMessages.map((message) => ({
        ...message,
        content: parseMessageContent(message.content),
      })),
    [initialMessages],
  );

  return { parsedInitialMessages };
}

interface ChatTranscriptProjectionOptions {
  liveMessages: Message[];
  optimisticMessages: Message[];
  parsedInitialMessages: Message[];
  readOnly: boolean;
}

/** Projects the canonical transcript into the renderer's normalized view. */
export function useChatTranscriptProjection({
  liveMessages,
  optimisticMessages,
  parsedInitialMessages,
  readOnly,
}: ChatTranscriptProjectionOptions) {
  const residentMessages =
    readOnly || liveMessages.length === 0
      ? parsedInitialMessages
      : liveMessages;

  const displayMessages = useMemo(() => {
    if (optimisticMessages.length === 0) return residentMessages;
    const baseKeys = new Set<string>();
    for (const message of residentMessages) {
      baseKeys.add(message.id);
      if (message.clientMessageId) baseKeys.add(message.clientMessageId);
    }
    const optimistic = optimisticMessages.filter(
      (message) =>
        !baseKeys.has(message.id) &&
        !(message.clientMessageId && baseKeys.has(message.clientMessageId)),
    );
    return optimistic.length === 0
      ? residentMessages
      : mergeOverlay(residentMessages, optimistic);
  }, [optimisticMessages, residentMessages]);

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
