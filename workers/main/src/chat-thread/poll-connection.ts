import {
  SSE_MAX_QUEUED_BYTES,
  type SseConnectionSink,
  type SseQueueBudget,
} from "./sse-connection";

/** A receive queue for completed HTTP responses. Retain frames until the NEXT
 * request acknowledges them: a proxy may lose a response after we return it.
 * The existing connection lifecycle handles expiry, overflow and SDK resume.
 */
export class PollConnectionSink implements SseConnectionSink {
  // Background browsers may coalesce timers to once per minute. Still bound
  // abandoned sessions, but do not evict a healthy hidden tab every heartbeat.
  readonly stallTimeoutMs = 90_000;
  onDead: (() => void) | null = null;
  private frames: Array<{ payload: string; bytes: number }> = [];
  private acknowledged = -1;
  private delivered = -1;
  private bytes = 0;
  private closed = false;
  private lastPollAt = Date.now();

  constructor(private readonly budget: SseQueueBudget) {}

  send(payload: string): boolean {
    if (this.closed) return false;
    // Include framing/entry overhead as well as UTF-8 payload bytes.
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength + 64;
    if (
      this.bytes + bytes > SSE_MAX_QUEUED_BYTES ||
      this.budget.total + bytes > this.budget.max
    ) {
      this.close();
      this.onDead?.();
      return false;
    }
    this.frames.push({ payload, bytes });
    this.bytes += bytes;
    this.budget.total += bytes;
    return true;
  }

  read(cursor: number): { cursor: number; frames: string[] } | null {
    if (this.closed || !Number.isSafeInteger(cursor) || cursor < this.acknowledged || cursor > this.delivered) {
      return null;
    }
    const removed = this.frames.splice(0, cursor - this.acknowledged);
    for (const frame of removed) {
      this.bytes -= frame.bytes;
      this.budget.total -= frame.bytes;
    }
    this.acknowledged = cursor;
    this.lastPollAt = Date.now();
    const frames: string[] = [];
    let batchBytes = 0;
    for (const frame of this.frames) {
      // Bound each serialized response too; a single protocol frame is atomic.
      if (frames.length && batchBytes + frame.bytes > 512 * 1024) break;
      frames.push(frame.payload);
      batchBytes += frame.bytes;
    }
    this.delivered = cursor + frames.length;
    return { cursor: this.delivered, frames };
  }

  comment(): boolean { return !this.closed; }
  bye(): void {} // A retired session returns 409; the client runs normal resume.
  stalledFor(nowMs: number): number { return Math.max(0, nowMs - this.lastPollAt); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.budget.total -= this.bytes;
    this.bytes = 0;
    this.frames = [];
  }
}
