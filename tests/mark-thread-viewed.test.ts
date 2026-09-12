import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markThreadViewed } from "@/lib/mark-thread-viewed.client";

describe("markThreadViewed", () => {
  let responses: Array<(response: Response) => void>;
  let fetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    responses = [];
    fetch = vi.fn(() => new Promise<Response>(resolve => responses.push(resolve)));
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("folds overlapping completion updates into one trailing request", async () => {
    const first = markThreadViewed("thread/1");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith("/api/threads/thread%2F1/mark-viewed", { method: "POST" });
    const updates = Array.from({ length: 5 }, () => markThreadViewed("thread/1"));
    expect(fetch).toHaveBeenCalledTimes(1);
    responses[0](Response.json({ success: true }));
    await Promise.resolve();
    // A later write is necessary: the first request may have recorded its
    // viewed timestamp before these newer completion events arrived.
    expect(fetch).toHaveBeenCalledTimes(2);
    responses[1](Response.json({ success: true }));
    await Promise.all([first, ...updates]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not serialize different threads or cache a completed write", async () => {
    const first = markThreadViewed("one");
    const second = markThreadViewed("two");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    responses[0](new Response()); responses[1](new Response());
    await Promise.all([first, second]);
    const later = markThreadViewed("one");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(3);
    responses[2](new Response());
    await later;
  });

  it.each([403, 500])("reports HTTP %s once and releases the queue for a later retry", async status => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = markThreadViewed("one");
    await Promise.resolve();
    const overlapping = markThreadViewed("one");
    responses[0](new Response(null, { status }));
    await Promise.all([first, overlapping]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Failed to mark active chat viewed:",
      expect.objectContaining({ message: `Failed to mark thread viewed (${status})` }),
    );
    const retry = markThreadViewed("one");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
    responses[1](new Response());
    await retry;
  });
});
