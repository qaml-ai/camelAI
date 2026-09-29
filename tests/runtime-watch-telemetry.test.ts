import { describe, expect, it, vi } from "vitest";

import { trackRuntimeWatchError } from "@/lib/chat-sse-telemetry";

/**
 * The browser's runtime-thread watcher reports its errors (a failed token
 * mint, a 401/403/404 that stops it, a dropped stream) as `runtime_watch_error`
 * events through /api/client-errors.
 */
// The telemetry module reports through navigator.sendBeacon (with a fetch
// fallback); install a beacon capture to assert on emitted events. jsdom does
// not implement sendBeacon, so define rather than spy.
function captureBeacons(): {
  events: () => Array<Record<string, unknown>>;
  flush: () => Promise<void>;
} {
  const payloads: Array<Record<string, unknown>> = [];
  const pending: Array<Promise<void>> = [];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: (_url: string, body: Blob) => {
      // jsdom's Blob has no .text(); FileReader is implemented.
      const reader = new FileReader();
      pending.push(
        new Promise<void>((resolve, reject) => {
          reader.onload = () => {
            payloads.push(
              JSON.parse(String(reader.result)) as Record<string, unknown>,
            );
            resolve();
          };
          reader.onerror = () => reject(reader.error);
        }),
      );
      reader.readAsText(body);
      return true;
    },
  });
  return {
    events: () => payloads,
    flush: async () => {
      if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
      vi.useRealTimers();
      await Promise.all(pending);
    },
  };
}

describe("trackRuntimeWatchError", () => {
  it("reports an HTTP failure by its status", async () => {
    const beacons = captureBeacons();
    trackRuntimeWatchError("thread-a", Object.assign(new Error("token: HTTP 404"), { status: 404 }), "watch");
    await beacons.flush();
    const [event] = beacons.events();
    expect(event).toMatchObject({
      kind: "event",
      source: "runtime_watch",
      event: "runtime_watch_error",
      severity: "warn",
      status: "404",
      statusCode: 404,
      threadId: "thread-a",
    });
    expect(String(event.details)).toContain('"phase":"watch"');
    expect(event.message).toBe("Runtime thread watcher error (watch, 404, stopped).");
  });

  it("tells a dropped stream the watcher reconnects from one that stops it", async () => {
    const beacons = captureBeacons();
    trackRuntimeWatchError("thread-c", new TypeError("network error"), "watch");
    trackRuntimeWatchError("thread-c", Object.assign(new Error("events: HTTP 503"), { status: 503 }), "watch");
    trackRuntimeWatchError("thread-c", new Error("The runtime refused the renewed browser token; the watcher stopped"), "watch");
    await beacons.flush();
    expect(beacons.events().map((event) => event.message)).toEqual([
      "Runtime thread watcher error (watch, TypeError, reconnecting).",
      "Runtime thread watcher error (watch, 503, reconnecting).",
      "Runtime thread watcher error (watch, Error, stopped).",
    ]);
  });

  it("reports an error without a status by its name, and a failed start as an error", async () => {
    const beacons = captureBeacons();
    trackRuntimeWatchError("thread-b", new TypeError("Failed to fetch"), "start");
    await beacons.flush();
    const [event] = beacons.events();
    expect(event).toMatchObject({ event: "runtime_watch_error", status: "TypeError", severity: "error" });
    expect(event.statusCode).toBeUndefined();
  });
});
