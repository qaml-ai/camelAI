import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useConnectionSetupResponse } from "@/components/chat-preview/use-connection-setup-response";
import { SSE_READY_STATE_OPEN } from "@/lib/sse-agent-client";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useConnectionSetupResponse", () => {
  it("clears the submitted connection setup prompt after a successful save", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const chatAgentRef = {
      current: { readyState: SSE_READY_STATE_OPEN, call },
    };
    const { result } = renderHook(() =>
      useConnectionSetupResponse({ chatAgentRef }),
    );

    act(() => {
      result.current.setConnectionSetupPrompt({
        requestId: "prompt-a",
        integrationType: "postgres",
      });
    });

    await act(async () => {
      await result.current.handleConnectionSetupResponse({
        requestId: "prompt-a",
        cancelled: false,
        integration: {
          type: "postgres",
          name: "Primary DB",
          config: {},
          credentials: {},
        },
      });
    });

    expect(call).toHaveBeenCalledWith("submitConnectionSetupResponse", [
      expect.objectContaining({ requestId: "prompt-a" }),
    ]);
    expect(result.current.connectionSetupPrompt).toBeNull();
  });

  it("does not clear a newer connection setup prompt that arrives while save is in flight", async () => {
    const pendingSave = deferred();
    const call = vi.fn().mockReturnValue(pendingSave.promise);
    const chatAgentRef = {
      current: { readyState: SSE_READY_STATE_OPEN, call },
    };
    const { result } = renderHook(() =>
      useConnectionSetupResponse({ chatAgentRef }),
    );

    act(() => {
      result.current.setConnectionSetupPrompt({
        requestId: "prompt-a",
        integrationType: "postgres",
      });
    });

    const submitPromise = act(async () => {
      await result.current.handleConnectionSetupResponse({
        requestId: "prompt-a",
        cancelled: false,
        integration: {
          type: "postgres",
          name: "Primary DB",
          config: {},
          credentials: {},
        },
      });
    });

    act(() => {
      result.current.setConnectionSetupPrompt({
        requestId: "prompt-b",
        integrationType: "bigquery",
      });
    });

    pendingSave.resolve();
    await submitPromise;

    expect(result.current.connectionSetupPrompt).toMatchObject({
      requestId: "prompt-b",
      integrationType: "bigquery",
    });
  });
});
