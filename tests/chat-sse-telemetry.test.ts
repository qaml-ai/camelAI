import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyChatSseClose,
  FLAP_CLOSE_THRESHOLD,
  FLAP_WINDOW_MS,
  SEND_ACK_TIMEOUT_MS,
  shouldReportFlap,
  trackChatSendDispatched,
  trackChatStreamClose,
  trackChatStreamError,
  trackChatStreamOpen,
} from "@/lib/chat-sse-telemetry";

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

describe("shouldReportFlap", () => {
  const closes = (count: number, now: number) =>
    Array.from({ length: count }, (_, index) => ({
      at: now - index * 1000,
      code: null,
    }));

  it("stays quiet below the close threshold", () => {
    const now = 1_000_000;
    expect(shouldReportFlap(closes(FLAP_CLOSE_THRESHOLD - 1, now), 0, now)).toBe(
      false,
    );
  });

  it("reports once the threshold is crossed", () => {
    const now = 1_000_000;
    expect(shouldReportFlap(closes(FLAP_CLOSE_THRESHOLD, now), 0, now)).toBe(true);
  });

  it("suppresses repeat reports inside one window", () => {
    const now = 1_000_000;
    expect(
      shouldReportFlap(
        closes(FLAP_CLOSE_THRESHOLD + 2, now),
        now - FLAP_WINDOW_MS / 2,
        now,
      ),
    ).toBe(false);
    expect(
      shouldReportFlap(
        closes(FLAP_CLOSE_THRESHOLD + 2, now),
        now - FLAP_WINDOW_MS,
        now,
      ),
    ).toBe(true);
  });
});

describe("classifyChatSseClose", () => {
  it("separates intentional teardown, handshake failure and abnormal end", () => {
    expect(classifyChatSseClose({ aborted: true }, true)).toBe("clean_teardown");
    expect(classifyChatSseClose({ aborted: true }, false)).toBe("preopen_close");
    expect(classifyChatSseClose({ status: 503 }, false)).toBe("preopen_close");
    expect(classifyChatSseClose({}, true)).toBe("abnormal_disconnect");
  });

  it("treats a graceful server bye as a park, not a disconnect", () => {
    // The server ended these on purpose; only `forbidden` is a verdict.
    for (const byeReason of ["idle", "retry", "shutdown"] as const) {
      expect(classifyChatSseClose({ byeReason, aborted: false }, true)).toBe(
        "server_park",
      );
    }
    expect(classifyChatSseClose({ byeReason: "forbidden" }, true)).toBe(
      "abnormal_disconnect",
    );
    // A park can only end a stream that was open.
    expect(classifyChatSseClose({ byeReason: "idle" }, false)).toBe(
      "preopen_close",
    );
  });
});

describe("chat SSE telemetry events", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports the stream open with connect status and open count", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatStreamOpen(threadId);
    await beacons.flush();

    const open = beacons.events().find((event) => event.event === "chat_sse_open");
    expect(open).toBeDefined();
    expect(open?.status).toBe("connect");
    expect(open?.severity).toBe("info");
    expect(open?.count).toBe(1);
    expect(open?.threadId).toBe(threadId);
  });

  it("reports an EOF disconnect as abnormal with stream lifetime", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatStreamOpen(threadId);
    trackChatStreamClose(threadId, {});
    await beacons.flush();

    const close = beacons
      .events()
      .find((event) => event.event === "chat_sse_abnormal_disconnect");
    expect(close).toBeDefined();
    expect(close?.status).toBe("eof");
    expect(close?.statusCode).toBeUndefined();
    expect(close?.severity).toBe("warn");
    expect(close?.threadId).toBe(threadId);
    expect(String(close?.message)).toContain("(eof)");
    expect(String(close?.details)).toContain('"connectionWasOpen":true');
  });

  it("keeps the HTTP status on a retryable attach failure", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatStreamOpen(threadId);
    trackChatStreamClose(threadId, { status: 503, reason: "overloaded" });
    await beacons.flush();

    const close = beacons
      .events()
      .find(
        (event) =>
          event.event === "chat_sse_abnormal_disconnect" && event.status === "503",
      );
    expect(close?.statusCode).toBe(503);
    expect(String(close?.message)).toContain("(503)");
    expect(String(close?.details)).toContain('"code":1013');
  });

  it("classifies a stream that never opened as a handshake close", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatStreamClose(threadId, { status: 500 });
    await beacons.flush();

    const events = beacons.events();
    const close = events.find((event) => event.event === "chat_sse_preopen_close");
    expect(close?.status).toBe("handshake_close");
    expect(close?.severity).toBe("error");
    expect(String(close?.details)).toContain('"connectionWasOpen":false');
    expect(
      events.find((event) => event.event === "chat_sse_clean_teardown"),
    ).toBeUndefined();
  });

  it("classifies client-aborted teardown cycles without a reconnect-loop report", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    for (let cycle = 0; cycle < FLAP_CLOSE_THRESHOLD; cycle += 1) {
      trackChatStreamOpen(threadId);
      trackChatStreamClose(threadId, { aborted: true });
    }
    await beacons.flush();

    const events = beacons.events();
    expect(
      events.filter((event) => event.event === "chat_sse_clean_teardown"),
    ).toHaveLength(FLAP_CLOSE_THRESHOLD);
    expect(
      events.find((event) => event.event === "chat_sse_reconnect_loop"),
    ).toBeUndefined();
  });

  it("captures an attach timeout as a pre-open connect failure", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatStreamError(threadId, new Error("TIMEOUT: chat stream attach timed out"));
    await beacons.flush();

    const timeout = beacons
      .events()
      .find((event) => event.event === "chat_sse_connect_error");
    expect(timeout?.status).toBe("handshake_timeout");
    expect(String(timeout?.details)).toContain('"timeout":true');
  });

  it("reports an idle park as an info-level park outside the flap window", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    // A quiet tab parks on the server's idle grace forever; that must not read
    // as the dead-transport signal, nor crowd the reconnect-loop window.
    for (let cycle = 0; cycle < FLAP_CLOSE_THRESHOLD + 2; cycle += 1) {
      trackChatStreamOpen(threadId);
      trackChatStreamClose(threadId, {
        byeReason: "idle",
        reason: "idle",
        aborted: false,
      });
    }
    await beacons.flush();

    const events = beacons.events();
    const parks = events.filter((event) => event.event === "chat_sse_server_park");
    // Past the flap threshold (the per-signature budget caps the tail).
    expect(parks.length).toBeGreaterThanOrEqual(FLAP_CLOSE_THRESHOLD);
    expect(parks[0].severity).toBe("info");
    expect(parks[0].status).toBe("idle");
    expect(String(parks[0].details)).toContain('"code":1000');
    expect(
      events.find((event) => event.event === "chat_sse_abnormal_disconnect"),
    ).toBeUndefined();
    expect(
      events.find((event) => event.event === "chat_sse_reconnect_loop"),
    ).toBeUndefined();
  });

  it("escalates to a reconnect-loop report after repeated abnormal cycles", async () => {
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    for (let cycle = 0; cycle < FLAP_CLOSE_THRESHOLD; cycle += 1) {
      trackChatStreamOpen(threadId);
      trackChatStreamClose(threadId, { reason: "stream ended" });
    }
    await beacons.flush();

    const loop = beacons
      .events()
      .find((event) => event.event === "chat_sse_reconnect_loop");
    expect(loop).toBeDefined();
    expect(loop?.severity).toBe("error");
    expect(loop?.status).toBe("reconnect_loop");
    expect(loop?.count).toBe(FLAP_CLOSE_THRESHOLD);
  });

  it("reports an ack timeout when sendMessage never settles", async () => {
    vi.useFakeTimers();
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    trackChatSendDispatched({ threadId, getReadyState: () => 1 });
    vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 1);
    await beacons.flush();

    const timeout = beacons
      .events()
      .find((event) => event.event === "chat_post_ack_timeout");
    expect(timeout).toBeDefined();
    expect(timeout?.severity).toBe("error");
    expect(timeout?.status).toBe("ack_timeout");
    expect(timeout?.threadId).toBe(threadId);
  });

  it("suppresses the ack timeout once the send settles", async () => {
    vi.useFakeTimers();
    const beacons = captureBeacons();
    const threadId = crypto.randomUUID();
    const tracker = trackChatSendDispatched({ threadId, getReadyState: () => 1 });
    tracker.accepted();
    vi.advanceTimersByTime(SEND_ACK_TIMEOUT_MS + 1);
    await beacons.flush();

    const events = beacons.events();
    expect(
      events.find((event) => event.event === "chat_post_ack_timeout"),
    ).toBeUndefined();
    const accepted = events.find((event) => event.event === "chat_post_accepted");
    expect(accepted).toBeDefined();
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.source).toBe("chat_sse");
  });
});
