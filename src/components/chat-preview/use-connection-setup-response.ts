import { useCallback, useState } from "react";
import type {
  ConnectionSetupPromptData,
  ConnectionSetupResponse,
} from "@/components/connection-setup-prompt";

export function useConnectionSetupResponse({
  submitResponse,
}: {
  submitResponse: (response: ConnectionSetupResponse) => Promise<unknown>;
}) {
  const [connectionSetupPrompt, setConnectionSetupPrompt] =
    useState<ConnectionSetupPromptData | null>(null);

  const handleConnectionSetupResponse = useCallback(
    async (response: ConnectionSetupResponse) => {
      await submitResponse(response);
      setConnectionSetupPrompt((current) =>
        current?.requestId === response.requestId ? null : current,
      );
    },
    [submitResponse],
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
