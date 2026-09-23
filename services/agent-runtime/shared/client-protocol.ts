export const FRAME_BYTES = 1_100_000;
export type Outcome = { result: unknown; error?: never; uncertain?: never } | { error: string; uncertain?: boolean; result?: never };
export interface SessionCredentials { id: string; token: string; expiresAt: number }
export type RequestMethod = "prompt" | "execute" | "status" | "abort";
export type CallRecord = {
  id: string; requestId?: string; createdAt?: number; name: string; args: Record<string, unknown>; deadline: number;
  state: "offered" | "started" | "completed" | "cancelled" | "uncertain";
  outcome?: Outcome; lateOutcome?: Outcome;
};
export type RequestRecord = {
  id: string; startedAt?: number; endedAt?: number; prompt?: string; code?: string; fingerprint: string; method: RequestMethod;
  state: "running" | "completed" | "uncertain"; outcome?: Outcome;
};
export type ClientEvent =
  | { type: "tool_call"; call: CallRecord }
  | { type: "tool_cancel"; id: string }
  | { type: "event"; requestId: string; event: any }
  | { type: "response"; id: string; outcome: Outcome };
export type SessionState = { cursor: number; calls: CallRecord[]; requests: RequestRecord[]; needsReconciliation: boolean };
