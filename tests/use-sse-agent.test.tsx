import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSseAgent } from "@/lib/use-sse-agent";

const THREAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_THREAD_ID = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WORKSPACE_ID = "12121212-3434-4565-8787-909090909090";

function sseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start: () => {} });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("useSseAgent", () => {
  let attachUrls: string[];

  beforeEach(() => {
    attachUrls = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        attachUrls.push(String(input));
        return sseResponse();
      }
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps one client across renders and attaches once", async () => {
    const { result, rerender } = renderHook(
      (props: { workspaceId: string | null }) =>
        useSseAgent({
          agent: "chat-thread",
          name: THREAD_ID,
          enabled: true,
          query: { threadId: THREAD_ID, workspaceId: props.workspaceId },
          // A fresh closure every render must not churn the connection.
          onMessage: () => {},
        }),
      { initialProps: { workspaceId: WORKSPACE_ID } },
    );

    const first = result.current;
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ workspaceId: WORKSPACE_ID });

    expect(result.current).toBe(first);
    expect(attachUrls).toHaveLength(1);
    expect(new URL(attachUrls[0]).searchParams.get("workspaceId")).toBe(
      WORKSPACE_ID,
    );
    expect(result.current.readyState).toBe(1);
  });

  it("replaces the client when the instance name changes", async () => {
    const { result, rerender } = renderHook(
      (props: { name: string }) =>
        useSseAgent({
          agent: "chat-thread",
          name: props.name,
          enabled: true,
          query: { threadId: props.name, workspaceId: WORKSPACE_ID },
        }),
      { initialProps: { name: THREAD_ID } },
    );

    const first = result.current;
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ name: OTHER_THREAD_ID });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).not.toBe(first);
    expect(result.current.name).toBe(OTHER_THREAD_ID);
    expect(first.readyState).toBe(3);
    expect(attachUrls).toHaveLength(2);
    expect(new URL(attachUrls[1]).pathname).toBe(
      `/agents/chat-thread/${OTHER_THREAD_ID}/sse`,
    );
  });

  it("does not attach while disabled and replaces the client when enabled flips", async () => {
    const { result, rerender } = renderHook(
      (props: { enabled: boolean }) =>
        useSseAgent({
          agent: "chat-thread",
          name: THREAD_ID,
          enabled: props.enabled,
          query: { threadId: THREAD_ID, workspaceId: WORKSPACE_ID },
        }),
      { initialProps: { enabled: false } },
    );

    const disabled = result.current;
    await act(async () => {
      await Promise.resolve();
    });
    expect(attachUrls).toHaveLength(0);
    expect(disabled.readyState).toBe(3);

    rerender({ enabled: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).not.toBe(disabled);
    expect(attachUrls).toHaveLength(1);
    expect(result.current.readyState).toBe(1);
  });

  it("closes the stream on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useSseAgent({
        agent: "chat-thread",
        name: THREAD_ID,
        enabled: true,
        query: { threadId: THREAD_ID, workspaceId: WORKSPACE_ID },
      }),
    );

    const client = result.current;
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.readyState).toBe(1);

    unmount();
    expect(client.readyState).toBe(3);
  });

  it("routes lifecycle callbacks through the latest render's closures", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      (props: { onOpen: () => void }) =>
        useSseAgent({
          agent: "chat-thread",
          name: THREAD_ID,
          enabled: false,
          query: { threadId: THREAD_ID, workspaceId: WORKSPACE_ID },
          onOpen: props.onOpen,
        }),
      { initialProps: { onOpen: first } },
    );

    rerender({ onOpen: second });
    await act(async () => {
      result.current.start();
      await Promise.resolve();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
