import { useCallback, useState, type RefObject } from "react";
import type {
  ConnectionSetupPromptData,
  ConnectionSetupResponse,
} from "@/components/connection-setup-prompt";
import { CLIENT_OPEN } from "@/lib/use-runtime-thread";

type ChatAgentClientLike = {
  readyState: number;
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
};

export function useConnectionSetupResponse({
  chatAgentRef,
}: {
  chatAgentRef: RefObject<ChatAgentClientLike | null>;
}) {
  const [connectionSetupPrompt, setConnectionSetupPrompt] =
    useState<ConnectionSetupPromptData | null>(null);

  const handleConnectionSetupResponse = useCallback(
    async (response: ConnectionSetupResponse) => {
      const agent = chatAgentRef.current;
      if (!agent || agent.readyState !== CLIENT_OPEN) {
        throw new Error(
          "The chat connection disconnected before the connection details could be submitted. Please try again.",
        );
      }

      await agent.call("submitConnectionSetupResponse", [response]);
      setConnectionSetupPrompt((current) =>
        current?.requestId === response.requestId ? null : current,
      );
    },
    [chatAgentRef],
  );

  const handleConnectionSetupCancel = useCallback(() => {
    setConnectionSetupPrompt(null);
  }, []);

  return {
    connectionSetupPrompt,
    handleConnectionSetupCancel,
    handleConnectionSetupResponse,
    setConnectionSetupPrompt,
  };
}
