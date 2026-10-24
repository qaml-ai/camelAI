import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeApi } from "../workers/main/src/agent-runtime/runtime-api";

afterEach(() => vi.useRealTimers());
describe("runtime API abort", () => {
  it("passes cancellation to fetch", async () => {
    const signal = new AbortController().signal;
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    expect(await runtimeApi({}, "GET", "/history", undefined, {}, fetcher, signal)).toEqual({ ok: true });
    expect(fetcher.mock.calls[0][1].signal).toBe(signal);
  });
  it("aborts during 503 retry backoff without issuing another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const pending = runtimeApi({}, "GET", "/history", undefined, {}, fetcher, controller.signal);
    const rejected = expect(pending).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new DOMException("Timed out", "TimeoutError"));
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
