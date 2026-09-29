import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMovingNotice, readOnlyMoveNotice } from "@/components/chat/chat-moving-notice";

function answer(state: string) {
  return Promise.resolve(Response.json({ state }));
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
      .mockImplementationOnce(() => answer("moving"))
      .mockImplementationOnce(() => answer("runtime"));
    vi.stubGlobal("fetch", fetchMock);
    const onSettled = vi.fn();

    render(<ChatMovingNotice threadId="thread 1" workspaceId="ws-1" onSettled={onSettled} intervalMs={1_000} />);

    expect(screen.getByRole("status")).toHaveTextContent("Moving this conversation…");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledWith("/api/threads/thread%201/move?workspaceId=ws-1", expect.anything());
    expect(onSettled).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith("runtime");

    // Settled: no more polls.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hands back a thread that cannot move, and keeps polling through failed polls", async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error("offline")))
      .mockImplementationOnce(() => answer("readonly"));
    vi.stubGlobal("fetch", fetchMock);
    const onSettled = vi.fn();

    render(<ChatMovingNotice threadId="t1" workspaceId="ws-1" onSettled={onSettled} intervalMs={1_000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(onSettled).toHaveBeenCalledWith("readonly");
  });

  it("stops polling when it unmounts", async () => {
    const fetchMock = vi.fn(() => answer("moving"));
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
