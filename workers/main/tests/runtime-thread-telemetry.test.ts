/**
 * Analytics Engine events for the runtime-thread path: a send the runtime
 * did not accept, and a browser token that could not be minted.
 *
 * Run with: bun run test:workers -- runtime-thread-telemetry
 */
import { describe, expect, it, vi } from "vitest";
import {
  classifyRuntimeFailure,
  recordRuntimeSendFailure,
  recordRuntimeSendTiming,
  recordRuntimeTokenMintFailure,
  SEND_TIMING_STEPS,
} from "../src/agent-runtime/runtime-thread-telemetry";
import { RuntimeApiError } from "../src/agent-runtime/runtime-api";

const context = { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user1" };

function datasets() {
  const events = { writeDataPoint: vi.fn() };
  const errors = { writeDataPoint: vi.fn() };
  return { env: { OBSERVABILITY_EVENTS: events, ERROR_ANALYTICS: errors } as never, events, errors };
}

/** blob1 event, blob3 component, blob4 operation, blob5 status, blob9 thread, blob16 errorName; double3 statusCode. */
function point(dataset: { writeDataPoint: ReturnType<typeof vi.fn> }) {
  const [{ blobs, doubles }] = dataset.writeDataPoint.mock.calls[0] as [{ blobs: string[]; doubles: number[] }];
  return {
    event: blobs[0], severity: blobs[1], component: blobs[2], operation: blobs[3], status: blobs[4],
    thread: blobs[8], workspace: blobs[9], org: blobs[10], errorName: blobs[15], statusCode: doubles[2],
  };
}

describe("classifyRuntimeFailure", () => {
  it("tells the runtime's refusals, its failures and other exceptions apart", () => {
    expect(classifyRuntimeFailure(new RuntimeApiError("bad", 409))).toEqual({ status: "runtime_4xx", statusCode: 409 });
    expect(classifyRuntimeFailure(new RuntimeApiError("down", 502))).toEqual({ status: "runtime_5xx", statusCode: 502 });
    expect(classifyRuntimeFailure(new TypeError("fetch failed"))).toEqual({ status: "exception", statusCode: null });
  });
});

describe("recordRuntimeSendTiming", () => {
  it("records one event per send, each step's milliseconds on double6 onward", () => {
    const { env, events } = datasets();
    recordRuntimeSendTiming(env, context, {
      firstSend: false,
      status: "accepted",
      durationMs: 420,
      timings: { ban: 3, prepare: 120, route: 40, prompt: 250 },
    });
    expect(events.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(point(events)).toMatchObject({ event: "runtime_thread_send_timing", operation: "send", status: "accepted", thread: "thread1" });
    const [{ doubles }] = events.writeDataPoint.mock.calls[0] as [{ doubles: number[] }];
    expect(doubles[1]).toBe(420);
    expect(doubles).toHaveLength(5 + SEND_TIMING_STEPS.length);
    const steps = Object.fromEntries(SEND_TIMING_STEPS.map((step, index) => [step, doubles[5 + index]]));
    expect(steps).toMatchObject({ ban: 3, prepare: 120, route: 40, patch: 0, prompt: 250 });
  });
});

describe("recordRuntimeSendFailure", () => {
  it("records nothing for an accepted send", () => {
    const { env, events } = datasets();
    recordRuntimeSendFailure(env, context, "send", { result: { status: "accepted", requestId: "r", agentId: "a", fallback: null } });
    expect(events.writeDataPoint).not.toHaveBeenCalled();
  });

  it("records a refusal with its code, and a busy agent", () => {
    const refused = datasets();
    recordRuntimeSendFailure(refused.env, context, "first_send", { result: { status: "error", error: "Limit reached", code: "usage_limit" } });
    expect(point(refused.events)).toMatchObject({
      event: "runtime_thread_send_failed", component: "runtime_thread", operation: "first_send",
      status: "refused", errorName: "usage_limit", thread: "thread1", workspace: "ws1", org: "org1",
    });
    expect(refused.errors.writeDataPoint).not.toHaveBeenCalled();

    const busy = datasets();
    recordRuntimeSendFailure(busy.env, context, "send", { result: { status: "busy", error: "queued" } });
    expect(point(busy.events)).toMatchObject({ status: "busy", operation: "send" });
  });

  it("records a thrown error by class, in both datasets", () => {
    const { env, events, errors } = datasets();
    recordRuntimeSendFailure(env, context, "send", { error: new RuntimeApiError("Bad gateway", 502) });
    expect(point(events)).toMatchObject({ event: "runtime_thread_send_failed", status: "runtime_5xx", statusCode: 502, severity: "error" });
    expect(errors.writeDataPoint).toHaveBeenCalledTimes(1);
  });
});

describe("recordRuntimeTokenMintFailure", () => {
  it("records a thread with no agent yet", () => {
    const { env, events } = datasets();
    recordRuntimeTokenMintFailure(env, context, "token_route", { status: "no_agent", statusCode: 404 });
    expect(point(events)).toMatchObject({
      event: "runtime_token_mint_failed", component: "runtime_thread", operation: "token_route", status: "no_agent", statusCode: 404,
    });
  });

  it("records a mint the runtime failed, by class", () => {
    const { env, events, errors } = datasets();
    recordRuntimeTokenMintFailure(env, context, "page_seed", { error: new RuntimeApiError("Unauthorized", 401) });
    expect(point(events)).toMatchObject({ operation: "page_seed", status: "runtime_4xx", statusCode: 401 });
    expect(errors.writeDataPoint).toHaveBeenCalledTimes(1);
  });
});
