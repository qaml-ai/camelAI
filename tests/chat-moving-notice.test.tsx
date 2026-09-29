import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMovingNotice, MOVE_RETRY_FALLBACK_MS, readOnlyMoveNotice } from "@/components/chat/chat-moving-notice";

function answer(body: Record<string, unknown>) {
  return Promise.resolve(Response.json(body));
}

describe("ChatMovingNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the conversation moving and polls until it runs on the runtime", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => answer({ state: "moving" }))
      .mockImplementationOnce(() => answer({ state: "runtime" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSettled = vi.fn();

    render(<ChatMovingNotice threadId="thread 1" workspaceId="ws-1" onSettled={onSettled} intervalMs={1_000} />);

    expect(screen.getByRole("status")).toHaveTextContent("Moving this conversation…");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    // An automatic poll does not ask the move to end a backoff.
    expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread%201/move?workspaceId=ws-1", expect.anything());
    expect(onSettled).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith("runtime");

    // Settled: no more polls.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("replaces the spinner with the retry time after a failure, retries then, and on the button now", async () => {
    const retryAt = Date.now() + 90_000;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => answer({ state: "retrying", retryAt }))
      .mockImplementationOnce(() => answer({ state: "retrying", retryAt: Date.now() + 200_000 }))
      .mockImplementationOnce(() => answer({ state: "runtime" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSettled = vi.fn();

    render(<ChatMovingNotice threadId="t1" workspaceId="ws-1" onSettled={onSettled} intervalMs={1_000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(screen.getByRole("status")).toHaveTextContent("Couldn't move this conversation yet");
    expect(screen.getByRole("status")).toHaveTextContent(/Retrying at /);
    expect(screen.queryByText("Moving this conversation…")).not.toBeInTheDocument();

    // Nothing before the retry time; at it, a retry (which may end the backoff).
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/threads/t1/move?workspaceId=ws-1&retry=1", expect.anything());

    // The button retries now.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry now" })); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/threads/t1/move?workspaceId=ws-1&retry=1", expect.anything());
    expect(onSettled).toHaveBeenCalledWith("runtime");
  });

  it("says why a blocked move cannot happen, and does not poll until asked", async () => {
    const fetchMock = vi.fn(() => answer({ state: "blocked", message: "Hosted models are not configured for the agent runtime." }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatMovingNotice
        threadId="t1"
        workspaceId="ws-1"
        initial={{ state: "blocked", message: "Hosted models are not configured for the agent runtime." }}
        onSettled={vi.fn()}
        intervalMs={1_000}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Hosted models are not configured for the agent runtime.");
    await act(async () => { await vi.advanceTimersByTimeAsync(MOVE_RETRY_FALLBACK_MS * 2); });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry now" })); });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("hands back a thread that cannot move, and keeps polling through failed polls", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error("offline")))
      .mockImplementationOnce(() => answer({ state: "readonly", reason: "too_large" }));
    vi.stubGlobal("fetch", fetchMock);
    const onSettled = vi.fn();

    render(<ChatMovingNotice threadId="t1" workspaceId="ws-1" onSettled={onSettled} intervalMs={1_000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith("readonly");
  });

  it("stops polling when it unmounts", async () => {
    const fetchMock = vi.fn(() => answer({ state: "moving" }));
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<ChatMovingNotice threadId="t1" workspaceId="ws-1" onSettled={vi.fn()} intervalMs={1_000} />);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("readOnlyMoveNotice", () => {
  it("says why the conversation is read-only", () => {
    expect(readOnlyMoveNotice("too_large", false)).toBe(
      "It is too large to move to camelAI's new chat engine, so it is read-only. Start a new chat to continue.",
    );
    expect(readOnlyMoveNotice("no_route", true)).toContain("Its model is not available");
    expect(readOnlyMoveNotice("no_route", true)).toContain("Only its most recent messages are shown.");
    expect(readOnlyMoveNotice("gone", false)).toContain("could not be moved");
  });
});
