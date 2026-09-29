import { ChatThreadWorkingIndicator } from "@/components/chat-thread-working-indicator";
import { MessageBubble } from "@/components/message-bubble";
import type { Message } from "@/types";

const noop = () => {};

/**
 * What the new-chat page shows from the click that starts a chat until the
 * thread's page takes over: the user's message and the working indicator,
 * timed from the click, so starting a chat never looks frozen.
 */
export function NewChatPending({
  message,
  startedAt,
}: {
  message: Message | null;
  startedAt: number;
}) {
  return (
    <div
      role="region"
      aria-label="Chat messages"
      aria-busy="true"
      className="flex flex-1 flex-col overflow-y-auto overflow-x-hidden"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-6 pt-2 md:px-6">
        {message ? (
          <MessageBubble
            message={message}
            onCopy={noop}
            copiedId={null}
            showActionRow={false}
          />
        ) : null}
        <ChatThreadWorkingIndicator startedAt={startedAt} />
      </div>
    </div>
  );
}
