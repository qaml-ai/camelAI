import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handlePlatformHttpRequest } from "../src/server/http/metrics.ts";
import {
  getObservabilitySnapshot,
  recordError,
  recordEvent,
  resetObservabilityForTests,
} from "../src/server/observability.ts";

beforeEach(() => {
  resetObservabilityForTests();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("structured observability", () => {
  it("writes JSON lines, increments counters, and redacts sensitive metadata", () => {
    const event = recordEvent({
      event: "turns_started",
      component: "chat-thread",
      orgId: "org-1",
      count: 2,
      meta: { model: "test", apiKey: "must-not-leak" },
    });
    recordError({
      event: "turn_failed",
      component: "chat-thread",
      error: new Error("boom"),
    });

    expect(event.meta).toEqual({
      model: "test",
      apiKey: "[REDACTED]",
    });
    expect(getObservabilitySnapshot()).toMatchObject({
      counters: { turns_started: 2 },
      recentEvents: [
        { event: "turns_started", severity: "info" },
        {
          event: "turn_failed",
          severity: "error",
          status: "error",
          meta: { errorName: "Error", errorMessage: "boom" },
        },
      ],
    });
    const output = vi.mocked(process.stdout.write).mock.calls[0]?.[0];
    expect(JSON.parse(String(output).trim())).toMatchObject({
      event: "turns_started",
      component: "chat-thread",
    });
  });

  it("retains only the latest 500 events", () => {
    for (let index = 0; index < 501; index += 1) {
      recordEvent({
        event: `event-${index}`,
        component: "test",
      });
    }
    const { recentEvents } = getObservabilitySnapshot();
    expect(recentEvents).toHaveLength(500);
    expect(recentEvents[0]?.event).toBe("event-1");
    expect(recentEvents.at(-1)?.event).toBe("event-500");
  });

  it("serves health and metrics endpoints", async () => {
    const health = handlePlatformHttpRequest(
      new Request("http://localhost/health"),
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      version: expect.any(String),
    });

    const metrics = handlePlatformHttpRequest(
      new Request("http://localhost/api/metrics"),
    );
    await expect(metrics.json()).resolves.toMatchObject({
      counters: { http_requests: 2 },
      recentEvents: expect.any(Array),
    });
  });
});
