/**
 * Analytics Engine events for threads that run directly on the hosted agent
 * runtime: where a send's time went, a send the runtime did not take, and a
 * browser token that could not be minted. Component `runtime_thread`; ids, classes and status codes only,
 * never message text.
 */
import { recordErrorEvent, recordObservabilityEvent, type ObservabilityEnv } from "../observability.js";
import { RuntimeApiError } from "./runtime-api.js";
import type { RuntimeTurnResult } from "./thread-runtime.js";
import type { SendTimings } from "./run-gates.js";

export interface RuntimeThreadTelemetryContext {
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId?: string | null;
}

export type RuntimeFailureClass = { status: "runtime_4xx" | "runtime_5xx" | "exception"; statusCode: number | null };

/** A thrown error: the runtime refused (4xx), the runtime failed (5xx), or anything else. */
export function classifyRuntimeFailure(error: unknown): RuntimeFailureClass {
  if (error instanceof RuntimeApiError) {
    return { status: error.status >= 500 ? "runtime_5xx" : "runtime_4xx", statusCode: error.status };
  }
  return { status: "exception", statusCode: null };
}

function ids(context: RuntimeThreadTelemetryContext) {
  return {
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    threadId: context.threadId,
    userId: context.userId ?? null,
  };
}

/** The steps of a send, in the order they land on double6 onward of `runtime_thread_send_timing`. */
export const SEND_TIMING_STEPS = [
  "ban", "prepare", "route", "access", "keyScope", "credit", "limits", "spent",
  "configure", "activity", "patch", "uploads", "prompt",
] as const satisfies ReadonlyArray<keyof SendTimings>;

/**
 * `runtime_thread_send_timing`: one per send, however it ended. durationMs is
 * the send's time up to the runtime's answer to the prompt; double6 onward are
 * the milliseconds of each step in SEND_TIMING_STEPS (0: it did not run).
 * Steps overlap: ban, prepare and spent run at once, and so do access,
 * keyScope, credit and limits within prepare, and configure and uploads.
 * Status is the result (accepted, busy, error) or `exception`; operation says
 * whether the thread's agent existed before (`send`) or not (`first_send`).
 */
export function recordRuntimeSendTiming(
  env: ObservabilityEnv | undefined,
  context: RuntimeThreadTelemetryContext,
  send: { firstSend: boolean; status: string; code?: string | null; durationMs: number; timings: SendTimings },
): void {
  recordObservabilityEvent(env, {
    event: "runtime_thread_send_timing",
    component: "runtime_thread",
    operation: send.firstSend ? "first_send" : "send",
    ...ids(context),
    status: send.status,
    errorName: send.code ?? null,
    durationMs: send.durationMs,
    extraCounts: SEND_TIMING_STEPS.map((step) => send.timings[step] ?? 0),
  });
}

/**
 * `runtime_thread_send_failed`: a message the runtime did not accept. Status
 * `refused` (chiridion's gates; errorName is the refusal's code), `busy`, or
 * the class of a thrown error. Nothing for an accepted send.
 */
export function recordRuntimeSendFailure(
  env: ObservabilityEnv | undefined,
  context: RuntimeThreadTelemetryContext,
  operation: "send" | "first_send",
  outcome: { result?: RuntimeTurnResult; error?: unknown },
): void {
  const base = { event: "runtime_thread_send_failed", component: "runtime_thread", operation, ...ids(context) };
  if (outcome.result) {
    if (outcome.result.status === "accepted") return;
    const refused = outcome.result.status === "error";
    recordObservabilityEvent(env, {
      ...base,
      severity: "warn",
      status: refused ? "refused" : "busy",
      errorName: refused ? outcome.result.code ?? "unspecified" : null,
    });
    return;
  }
  const failure = classifyRuntimeFailure(outcome.error);
  recordErrorEvent(env, { ...base, status: failure.status, statusCode: failure.statusCode, error: outcome.error });
}

/**
 * `runtime_token_mint_failed`: the browser could not get a watch token, from
 * the token route or the page's first load. Status `no_agent` (the thread has
 * no agent yet), or the class of a thrown error.
 */
export function recordRuntimeTokenMintFailure(
  env: ObservabilityEnv | undefined,
  context: RuntimeThreadTelemetryContext,
  operation: "token_route" | "page_seed",
  outcome: { status: "no_agent"; statusCode: number } | { error: unknown },
): void {
  const base = { event: "runtime_token_mint_failed", component: "runtime_thread", operation, ...ids(context) };
  if ("status" in outcome) {
    recordObservabilityEvent(env, { ...base, severity: "warn", status: outcome.status, statusCode: outcome.statusCode });
    return;
  }
  const failure = classifyRuntimeFailure(outcome.error);
  recordErrorEvent(env, { ...base, status: failure.status, statusCode: failure.statusCode, error: outcome.error });
}
