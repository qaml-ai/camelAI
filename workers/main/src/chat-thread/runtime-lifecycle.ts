/** Pure durable chat-turn state machine; transport never participates. */
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
type RejectionReason =
  | "duplicate"
  | "queue_full"
  | "queue_bytes"
  | "thread_full"
  | "stale"
  | "idle";
export type RuntimeLifecycleResult =
  | { accepted: true; state: RuntimeLifecycleState; turn?: RuntimeTurnRef }
  | { accepted: false; state: RuntimeLifecycleState; reason: RejectionReason };
type State = RuntimeLifecycleState;
type Turn = RuntimeTurnRef;
type Result = RuntimeLifecycleResult;
type AttemptEvent = Extract<RuntimeLifecycleEvent, { id: string; attemptToken: string }>;
type TerminalStatus = Exclude<RuntimeTurnStatus, "queued" | "running">;
export function initialRuntimeLifecycleState(): RuntimeLifecycleState {
  return { revision: 0, seen: [], queue: [], active: null };
}
const queueBytes = (state: State) =>
  state.queue.reduce((sum, turn) => sum + turn.bytes, 0);
function reject(state: State, reason: RejectionReason): Result {
  return { accepted: false, state, reason };
}

function accept(state: State, turn: Turn, patch: Partial<State>): Result {
  return {
    accepted: true,
    state: { ...state, ...patch, revision: state.revision + 1 },
    turn,
  };
}

function matchingActive(state: State, event: AttemptEvent): Turn | null {
  const active = state.active;
  return active?.id === event.id && active.attemptToken === event.attemptToken
    ? active
    : null;
}

function finish(state: State, active: Turn, status: TerminalStatus): Result {
  return accept(
    state,
    { ...active, status, leaseExpiresAt: null },
    { active: null },
  );
}

/** Rejected or stale events are exact no-ops. */
export function transitionRuntimeLifecycle(
  state: RuntimeLifecycleState,
  event: RuntimeLifecycleEvent,
): RuntimeLifecycleResult {
  switch (event.type) {
    case "DurablyAdmit": {
      if (state.seen.includes(event.id)) return reject(state, "duplicate");
      if (state.seen.length >= CHAT_RUNTIME_BOUNDS.admissionsPerThread) {
        return reject(state, "thread_full");
      }
      if (state.queue.length >= CHAT_RUNTIME_BOUNDS.queueTurns) {
        return reject(state, "queue_full");
      }
      if (queueBytes(state) + event.bytes > CHAT_RUNTIME_BOUNDS.queueBytes) {
        return reject(state, "queue_bytes");
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
      return accept(state, turn, {
        seen: [...state.seen, event.id],
        queue: [...state.queue, turn],
      });
    }
    case "StartSelectedTurn": {
      if (state.active || !state.queue.length) {
        return reject(state, state.active ? "stale" : "idle");
      }
      const [head, ...queue] = state.queue;
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
      return accept(state, turn, { active: turn, queue });
    }
    case "BeginEffect":
    case "CompleteTurn":
    case "FailTurn": {
      const active = matchingActive(state, event);
      if (!active) return reject(state, "stale");
      if (event.type === "BeginEffect") {
        const turn = { ...active, effectStarted: true };
        return accept(state, turn, { active: turn });
      }
      return finish(
        state,
        active,
        event.type === "CompleteTurn" ? "completed" : "failed",
      );
    }
    case "ExpireOperation": {
      const active = state.active;
      const activeExpired =
        active &&
        ((active.leaseExpiresAt !== null &&
          event.now >= active.leaseExpiresAt) ||
          event.now >= active.terminalDeadlineAt);
      if (activeExpired) return finish(state, active, "interrupted");
      const index = state.queue.findIndex(
        (turn) => event.now >= turn.terminalDeadlineAt,
      );
      if (index < 0) return reject(state, active ? "stale" : "idle");
      const turn = { ...state.queue[index], status: "failed" as const };
      return accept(state, turn, {
        queue: state.queue.filter((_, candidate) => candidate !== index),
      });
    }
    case "ReconcileCrashedTurn":
      return state.active
        ? finish(state, state.active, "interrupted")
        : reject(state, "idle");
  }
}
export function assertRuntimeLifecycleInvariants(
  state: RuntimeLifecycleState,
): void {
  const seen = new Set(state.seen);
  if (
    seen.size !== state.seen.length ||
    state.seen.length > CHAT_RUNTIME_BOUNDS.admissionsPerThread
  )
    throw new Error("invalid admission ledger");
  const ids = new Set(state.queue.map((turn) => turn.id));
  if (
    ids.size !== state.queue.length ||
    state.queue.some((turn) => turn.status !== "queued" || !seen.has(turn.id))
  )
    throw new Error("invalid queue");
  const active = state.active;
  if (
    active &&
    (active.status !== "running" ||
      !active.attemptToken ||
      active.leaseExpiresAt === null ||
      active.attempt > CHAT_RUNTIME_BOUNDS.attemptsPerTurn ||
      !seen.has(active.id) ||
      ids.has(active.id))
  )
    throw new Error("invalid active turn");
  if (
    state.queue.length > CHAT_RUNTIME_BOUNDS.queueTurns ||
    queueBytes(state) > CHAT_RUNTIME_BOUNDS.queueBytes
  )
    throw new Error("queue bound exceeded");
}
