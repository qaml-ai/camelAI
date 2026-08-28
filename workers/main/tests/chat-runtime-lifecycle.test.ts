import { describe, expect, it } from "vitest";
import {
  CHAT_RUNTIME_BOUNDS,
  assertRuntimeLifecycleInvariants,
  initialRuntimeLifecycleState,
  transitionRuntimeLifecycle,
  type RuntimeLifecycleEvent,
  type RuntimeLifecycleState,
} from "../src/chat-thread/runtime-lifecycle";

function apply(
  state: RuntimeLifecycleState,
  event: RuntimeLifecycleEvent,
): RuntimeLifecycleState {
  const result = transitionRuntimeLifecycle(state, event);
  assertRuntimeLifecycleInvariants(result.state);
  return result.state;
}

describe("bounded chat runtime lifecycle", () => {
  it("admits once, fences stale attempts, and terminalizes an expired run", () => {
    let state = initialRuntimeLifecycleState();
    state = apply(state, {
      type: "DurablyAdmit",
      id: "turn-1",
      bytes: 12,
      now: 0,
    });
    expect(
      transitionRuntimeLifecycle(state, {
        type: "DurablyAdmit",
        id: "turn-1",
        bytes: 12,
        now: 0,
      }),
    ).toMatchObject({ accepted: false, reason: "duplicate", state });

    state = apply(state, {
      type: "StartSelectedTurn",
      now: 100,
      attemptToken: "attempt-1",
    });
    const stale = transitionRuntimeLifecycle(state, {
      type: "CompleteTurn",
      id: "turn-1",
      attemptToken: "old-attempt",
    });
    expect(stale).toMatchObject({ accepted: false, reason: "stale", state });

    const expired = transitionRuntimeLifecycle(state, {
      type: "ExpireOperation",
      now: 100 + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
    });
    expect(expired).toMatchObject({
      accepted: true,
      turn: { id: "turn-1", status: "interrupted" },
      state: { active: null },
    });
  });

  it("bounds both queued turn count and queued bytes", () => {
    let state = initialRuntimeLifecycleState();
    for (let i = 0; i < CHAT_RUNTIME_BOUNDS.queueTurns; i += 1) {
      state = apply(state, {
        type: "DurablyAdmit",
        id: `turn-${i}`,
        bytes: 1,
        now: 0,
      });
    }
    expect(
      transitionRuntimeLifecycle(state, {
        type: "DurablyAdmit",
        id: "overflow",
        bytes: 1,
        now: 0,
      }),
    ).toMatchObject({ accepted: false, reason: "queue_full" });

    const bytes = initialRuntimeLifecycleState();
    expect(
      transitionRuntimeLifecycle(bytes, {
        type: "DurablyAdmit",
        id: "too-large",
        bytes: CHAT_RUNTIME_BOUNDS.queueBytes + 1,
        now: 0,
      }),
    ).toMatchObject({ accepted: false, reason: "queue_bytes" });
  });

  it("keeps terminal ids forever within an explicit lifetime cap", () => {
    let state = apply(initialRuntimeLifecycleState(), {
      type: "DurablyAdmit",
      id: "terminal-id",
      bytes: 1,
      now: 0,
    });
    state = apply(state, {
      type: "StartSelectedTurn",
      now: 1,
      attemptToken: "only-attempt",
    });
    state = apply(state, {
      type: "CompleteTurn",
      id: "terminal-id",
      attemptToken: "only-attempt",
    });
    expect(state.seen).toEqual(["terminal-id"]);
    expect(
      transitionRuntimeLifecycle(state, {
        type: "DurablyAdmit",
        id: "terminal-id",
        bytes: 1,
        now: 2,
      }),
    ).toMatchObject({ accepted: false, reason: "duplicate" });

    const full: RuntimeLifecycleState = {
      ...initialRuntimeLifecycleState(),
      seen: Array.from(
        { length: CHAT_RUNTIME_BOUNDS.admissionsPerThread },
        (_, index) => `seen-${index}`,
      ),
    };
    assertRuntimeLifecycleInvariants(full);
    expect(
      transitionRuntimeLifecycle(full, {
        type: "DurablyAdmit",
        id: "overflow",
        bytes: 1,
        now: 0,
      }),
    ).toMatchObject({ accepted: false, reason: "thread_full" });
  });

  it("preserves invariants across every short crash/fault trace", () => {
    const events: RuntimeLifecycleEvent[] = [
      { type: "DurablyAdmit", id: "a", bytes: 10, now: 0 },
      { type: "DurablyAdmit", id: "b", bytes: 20, now: 1 },
      { type: "StartSelectedTurn", now: 0, attemptToken: "x" },
      { type: "StartSelectedTurn", now: 1, attemptToken: "y" },
      { type: "BeginEffect", id: "a", attemptToken: "x" },
      { type: "CompleteTurn", id: "a", attemptToken: "x" },
      { type: "FailTurn", id: "b", attemptToken: "y" },
      { type: "ExpireOperation", now: CHAT_RUNTIME_BOUNDS.turnLeaseMs },
      { type: "ReconcileCrashedTurn", now: CHAT_RUNTIME_BOUNDS.turnLeaseMs },
    ];

    const visit = (state: RuntimeLifecycleState, depth: number): void => {
      assertRuntimeLifecycleInvariants(state);
      if (depth === 0) return;
      for (const event of events) {
        visit(transitionRuntimeLifecycle(state, event).state, depth - 1);
      }
    };

    visit(initialRuntimeLifecycleState(), 5);
  });
});
