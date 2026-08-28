/**
 * The complete durable chat-turn state machine.
 *
 * Transport is intentionally absent: opening an SSE response is an HTTP concern
 * and may never wait for this state to load. Reconnects read a bounded snapshot;
 * they do not resume an execution stream.
 */

export { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";

export type RuntimeTurnStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export interface RuntimeTurnRef {
  id: string;
  bytes: number;
  status: RuntimeTurnStatus;
  attempt: number;
  attemptToken: string | null;
  leaseExpiresAt: number | null;
  terminalDeadlineAt: number;
  effectStarted: boolean;
}

export interface RuntimeLifecycleState {
  revision: number;
  seen: string[];
  queue: RuntimeTurnRef[];
  active: RuntimeTurnRef | null;
}

export type RuntimeLifecycleEvent =
  | { type: "DurablyAdmit"; id: string; bytes: number; now: number }
  | { type: "StartSelectedTurn"; now: number; attemptToken: string }
  | { type: "BeginEffect"; id: string; attemptToken: string }
  | { type: "CompleteTurn"; id: string; attemptToken: string }
  | { type: "FailTurn"; id: string; attemptToken: string }
  | { type: "ExpireOperation"; now: number }
  | { type: "ReconcileCrashedTurn"; now: number };

export type RuntimeLifecycleResult =
  | { accepted: true; state: RuntimeLifecycleState; turn?: RuntimeTurnRef }
  | {
      accepted: false;
      state: RuntimeLifecycleState;
      reason:
        | "duplicate"
        | "queue_full"
        | "queue_bytes"
        | "thread_full"
        | "stale"
        | "idle";
    };

export function initialRuntimeLifecycleState(): RuntimeLifecycleState {
  return { revision: 0, seen: [], queue: [], active: null };
}

function next(
  state: RuntimeLifecycleState,
  patch: Partial<RuntimeLifecycleState>,
): RuntimeLifecycleState {
  return { ...state, ...patch, revision: state.revision + 1 };
}

function queueBytes(state: RuntimeLifecycleState): number {
  return state.queue.reduce((sum, turn) => sum + turn.bytes, 0);
}

/**
 * Pure transition function shared by implementation tests and the TLA+ trace
 * checker. Rejected/stale events are exact no-ops.
 */
export function transitionRuntimeLifecycle(
  state: RuntimeLifecycleState,
  event: RuntimeLifecycleEvent,
): RuntimeLifecycleResult {
  switch (event.type) {
    case "DurablyAdmit": {
      if (state.seen.includes(event.id)) {
        return { accepted: false, state, reason: "duplicate" };
      }
      if (state.seen.length >= CHAT_RUNTIME_BOUNDS.admissionsPerThread) {
        return { accepted: false, state, reason: "thread_full" };
      }
      if (state.queue.length >= CHAT_RUNTIME_BOUNDS.queueTurns) {
        return { accepted: false, state, reason: "queue_full" };
      }
      if (queueBytes(state) + event.bytes > CHAT_RUNTIME_BOUNDS.queueBytes) {
        return { accepted: false, state, reason: "queue_bytes" };
      }
      const turn: RuntimeTurnRef = {
        id: event.id,
        bytes: event.bytes,
        status: "queued",
        attempt: 0,
        attemptToken: null,
        leaseExpiresAt: null,
        terminalDeadlineAt: event.now + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        effectStarted: false,
      };
      return {
        accepted: true,
        state: next(state, {
          seen: [...state.seen, event.id],
          queue: [...state.queue, turn],
        }),
        turn,
      };
    }
    case "StartSelectedTurn": {
      if (state.active || state.queue.length === 0) {
        return {
          accepted: false,
          state,
          reason: state.active ? "stale" : "idle",
        };
      }
      const [head, ...tail] = state.queue;
      const turn: RuntimeTurnRef = {
        ...head,
        status: "running",
        attempt: head.attempt + 1,
        attemptToken: event.attemptToken,
        leaseExpiresAt: Math.min(
          event.now + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
          head.terminalDeadlineAt,
        ),
      };
      return {
        accepted: true,
        state: next(state, { active: turn, queue: tail }),
        turn,
      };
    }
    case "BeginEffect": {
      const active = state.active;
      if (
        !active ||
        active.id !== event.id ||
        active.attemptToken !== event.attemptToken
      ) {
        return { accepted: false, state, reason: "stale" };
      }
      const turn = { ...active, effectStarted: true };
      return { accepted: true, state: next(state, { active: turn }), turn };
    }
    case "CompleteTurn":
    case "FailTurn": {
      const active = state.active;
      if (
        !active ||
        active.id !== event.id ||
        active.attemptToken !== event.attemptToken
      ) {
        return { accepted: false, state, reason: "stale" };
      }
      const turn = {
        ...active,
        status:
          event.type === "CompleteTurn"
            ? ("completed" as const)
            : ("failed" as const),
        leaseExpiresAt: null,
      };
      return { accepted: true, state: next(state, { active: null }), turn };
    }
    case "ExpireOperation": {
      const active = state.active;
      if (
        active &&
        ((active.leaseExpiresAt !== null &&
          event.now >= active.leaseExpiresAt) ||
          event.now >= active.terminalDeadlineAt)
      ) {
        const turn = {
          ...active,
          status: "interrupted" as const,
          leaseExpiresAt: null,
        };
        return { accepted: true, state: next(state, { active: null }), turn };
      }
      const expired = state.queue.findIndex(
        (turn) => event.now >= turn.terminalDeadlineAt,
      );
      if (expired < 0) {
        return { accepted: false, state, reason: active ? "stale" : "idle" };
      }
      const turn = { ...state.queue[expired], status: "failed" as const };
      return {
        accepted: true,
        state: next(state, {
          queue: state.queue.filter((_, index) => index !== expired),
        }),
        turn,
      };
    }
    case "ReconcileCrashedTurn": {
      const active = state.active;
      if (!active) return { accepted: false, state, reason: "idle" };
      const turn = {
        ...active,
        status: "interrupted" as const,
        leaseExpiresAt: null,
      };
      return { accepted: true, state: next(state, { active: null }), turn };
    }
  }
}

export function assertRuntimeLifecycleInvariants(
  state: RuntimeLifecycleState,
): void {
  const seen = new Set(state.seen);
  if (
    seen.size !== state.seen.length ||
    state.seen.length > CHAT_RUNTIME_BOUNDS.admissionsPerThread
  ) {
    throw new Error("invalid admission ledger");
  }
  const ids = new Set<string>();
  for (const turn of state.queue) {
    if (turn.status !== "queued" || ids.has(turn.id) || !seen.has(turn.id)) {
      throw new Error("invalid queue");
    }
    ids.add(turn.id);
  }
  if (state.active) {
    if (
      state.active.status !== "running" ||
      !state.active.attemptToken ||
      state.active.leaseExpiresAt === null ||
      state.active.attempt > CHAT_RUNTIME_BOUNDS.attemptsPerTurn ||
      !seen.has(state.active.id) ||
      ids.has(state.active.id)
    ) {
      throw new Error("invalid active turn");
    }
  }
  if (
    state.queue.length > CHAT_RUNTIME_BOUNDS.queueTurns ||
    queueBytes(state) > CHAT_RUNTIME_BOUNDS.queueBytes
  ) {
    throw new Error("queue bound exceeded");
  }
}
