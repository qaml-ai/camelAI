// Synthetic Connection for the SSE chat transport. ChatThreadDO registers one
// shim per open stream and then drives the EXISTING wrapped
// onConnect/onMessage/onClose chains with it, so the chat protocol is never
// re-implemented for HTTP. Modelled on the Agents SDK's own non-WebSocket
// connection factory (`Agent._cf_createSubAgentBridgeConnection`).
//
// Three properties of this shim are load-bearing and easy to break:
//  - `state` must be an OWN accessor. `Agent._ensureConnectionWrapped` only
//    binds a live getter when `getOwnPropertyDescriptor(conn, "state").get`
//    exists; with a plain field it snapshots the value once and the connection
//    flags (readonly / no-protocol) silently stop tracking.
//  - `send` must signal a dead peer the ONLY way the SDK understands: by
//    throwing the WebSocket-specific "send() after close" TypeError.
//    `sendIfOpen`/`sendRpcResponseIfOpen` swallow exactly that shape and return
//    false, which is what makes `ResumableStream.replayChunks` bail mid-replay
//    and leave the stream active for the next reconnect to retry. Returning
//    normally would tell the SDK the client received a replay it never got, and
//    an orphaned stream would be finalized on that strength. The flip side is
//    that `Agent.broadcast` calls `send` with no try/catch, so the DO's
//    `broadcast` override guards its own registry fan-out (the only place a
//    shim is sent to outside the wrapped connect/message chains).
//  - `serializeAttachment` MERGES. The state slot also carries Agent's internal
//    `_cf_*` connection flags, so a whole-slot write would drop them.

const CF_INTERNAL_KEY_PREFIX = "_cf_";

// A peer can vanish without the runtime rejecting anything (a cancelled reader
// on the far side of a Durable Object stub does not necessarily error the
// writable half), leaving every broadcast to queue in the transform forever.
// Cap the outstanding bytes and treat a runaway queue as a dead peer: the client
// reconnects and replays from chunk 0, which is cheaper than an unbounded buffer
// inside the DO. A reader that is actually draining never approaches this.
export const SSE_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
// Per-stream bytes bound ONE peer; a shared DO is only safe if the sum is bounded
// too (every attach queues its own copy of the render window, so N unread
// attaches multiply the retained bytes with no broadcast traffic at all). The
// budget is owned by the registry and shared by every sink in it.
export const SSE_MAX_TOTAL_QUEUED_BYTES = 24 * 1024 * 1024;
// A write that has not drained in this long belongs to a peer that is gone.
// Byte volume alone cannot detect it: a 5-byte `:hb` comment every 25s would
// need centuries to reach SSE_MAX_QUEUED_BYTES, so the outstanding-write age is
// the only liveness probe a quiet stream has (WorkspaceDO's status streams use
// the same threshold for the same reason).
export const SSE_STREAM_STALL_MS = 30 * 1000;

const encoder = new TextEncoder();

export type SseByeReason = "idle" | "retry" | "forbidden" | "shutdown";

/** Sink for one synthetic connection. No method may throw. */
export interface SseConnectionSink {
  /** Returns false once the sink is gone. */
  send(payload: string): boolean;
  comment(text: string): boolean;
  bye(reason: SseByeReason): void;
  close(): void;
  /**
   * How long writes have been outstanding with none of them draining; 0 when
   * nothing is queued. A busy-but-healthy stream never accumulates here.
   */
  stalledFor(nowMs: number): number;
  /**
   * Set by the owning connection. Fired once when the sink discovers on its own
   * that the peer is gone (a queued write rejected), so teardown does not have
   * to wait for the next broadcast or heartbeat.
   */
  onDead?: (() => void) | null;
}

/** Undrained bytes shared by every sink in one registry. */
export interface SseQueueBudget {
  total: number;
  readonly max: number;
}

export function createSseQueueBudget(
  max: number = SSE_MAX_TOTAL_QUEUED_BYTES,
): SseQueueBudget {
  return { total: 0, max };
}

/**
 * The exact error shape the SDK reads as "this peer is gone": `sendIfOpen` /
 * `sendRpcResponseIfOpen` swallow it and return false, everything else rethrows.
 */
export function closedStreamSendError(): TypeError {
  return new TypeError("WebSocket send() after close");
}

export function isClosedStreamSendError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes("WebSocket send() after close")
  );
}

/**
 * WS close code → SSE `bye` reason. Mirrors the terminality the browser used to
 * read off the close code: 1008 is an authoritative denial, 1013 is "retry once
 * the authorization DOs recover", a redeploy/going-away is reconnectable.
 */
export function sseByeReasonForCloseCode(code: number | undefined): SseByeReason {
  if (code === 1008) return "forbidden";
  if (code === 1001 || code === 1012) return "shutdown";
  return "retry";
}

export function createSseStreamSink(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  budget?: SseQueueBudget,
): SseConnectionSink {
  let dead = false;
  let queuedBytes = 0;
  // Stall bookkeeping is "outstanding writes, and none of them has drained
  // since": counting the age of the OLDEST write instead would kill a healthy
  // client mid-turn, because a busy stream's queue never reaches empty even
  // though every write is settling.
  let pending = 0;
  let lastDrainedAt = 0;
  // Once the sink is gone its transform is unreachable and collectable, so its
  // share of the registry budget is released even though the queued writes may
  // never settle. Leaving them charged would let a handful of dead peers wedge
  // the budget for the lifetime of the DO.
  let released = false;
  const releaseBudget = () => {
    if (!budget || released) return;
    released = true;
    budget.total -= queuedBytes;
  };
  const die = () => {
    if (dead) return;
    dead = true;
    releaseBudget();
    sink.onDead?.();
  };
  // Writes are deliberately not awaited: the caller is inside a broadcast loop
  // that must not block on client backpressure, and a rejected write only means
  // the peer is gone (the connection is marked dead and torn down).
  const write = (frame: string): boolean => {
    if (dead) return false;
    const bytes = encoder.encode(frame);
    const size = bytes.byteLength;
    if (
      queuedBytes + size > SSE_MAX_QUEUED_BYTES ||
      (budget && budget.total + size > budget.max)
    ) {
      die();
      return false;
    }
    queuedBytes += size;
    if (budget) budget.total += size;
    pending += 1;
    if (pending === 1) lastDrainedAt = Date.now();
    const settle = () => {
      queuedBytes -= size;
      if (budget && !released) budget.total -= size;
      pending -= 1;
      lastDrainedAt = Date.now();
    };
    try {
      void writer.write(bytes).then(settle, () => {
        settle();
        die();
      });
    } catch {
      settle();
      die();
      return false;
    }
    return true;
  };
  const sink: SseConnectionSink = {
    onDead: null,
    send(payload) {
      return write(`data: ${payload}\n\n`);
    },
    comment(text) {
      return write(`:${text}\n\n`);
    },
    bye(reason) {
      write(`event: bye\ndata: ${JSON.stringify({ reason })}\n\n`);
    },
    stalledFor(nowMs) {
      if (pending === 0) return 0;
      return Math.max(0, nowMs - lastDrainedAt);
    },
    close() {
      dead = true;
      releaseBudget();
      try {
        void writer.close().catch(() => {});
      } catch {
        // Already closed or errored — nothing to release.
      }
    },
  };
  return sink;
}

/** Sink for a one-shot HTTP-delivered frame: the reply is captured, not streamed. */
export function createSseCaptureSink(): SseConnectionSink & { frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    send(payload) {
      frames.push(payload);
      return true;
    },
    comment() {
      return true;
    },
    bye() {},
    stalledFor() {
      return 0;
    },
    close() {},
  };
}

export interface SseConnectionOptions {
  id: string;
  /** Absolute attach URL, or null. Parsed by the SDK's sub-agent routing on every frame. */
  uri: string | null;
  server: string;
  sink: SseConnectionSink;
  onTeardown: (connection: SseConnection, code: number, reason: string) => void;
}

export class SseConnection {
  readonly id: string;
  uri: string | null;
  tags: string[];
  server: string;
  binaryType = "arraybuffer";
  // Installed as own properties in the constructor (see the header note).
  declare state: unknown;
  declare setState: (next: unknown) => unknown;

  private rawState: unknown = null;
  private readonly sink: SseConnectionSink;
  private readonly onTeardown: SseConnectionOptions["onTeardown"];
  private done = false;

  constructor(options: SseConnectionOptions) {
    this.id = options.id;
    this.uri = options.uri;
    this.tags = [options.id];
    this.server = options.server;
    this.sink = options.sink;
    this.onTeardown = options.onTeardown;
    this.sink.onDead = () => this.abort(1006, "stream_write_failed");

    Object.defineProperty(this, "state", {
      configurable: true,
      enumerable: true,
      get: () => this.rawState,
    });
    Object.defineProperty(this, "setState", {
      configurable: true,
      writable: true,
      value: (next: unknown): unknown => {
        this.rawState =
          typeof next === "function"
            ? (next as (previous: unknown) => unknown)(this.rawState)
            : next;
        return this.rawState;
      },
    });
  }

  get readyState(): number {
    return this.done ? 3 : 1;
  }

  get isOpen(): boolean {
    return !this.done;
  }

  /**
   * Throws {@link closedStreamSendError} once the stream is gone — the shape the
   * SDK's `sendIfOpen` translates into "stop, the client did not get this"
   * (see the header note). Callers that must not be interrupted by a dead peer
   * (broadcast fan-out) guard the call themselves.
   */
  send(message: string | ArrayBuffer | ArrayBufferView): void {
    // Nothing in the chat protocol sends binary frames; there is no SSE
    // encoding for them, so drop rather than corrupt the stream.
    if (typeof message !== "string") return;
    if (this.done) throw closedStreamSendError();
    // A failed write already tore the connection down through `onDead`; finish
    // is idempotent, so this only covers a sink that failed without firing it.
    if (this.sink.send(message)) return;
    this.finish(1006, "stream_write_failed");
    throw closedStreamSendError();
  }

  /** Comment keepalive plus stall probe. Returns false once the stream is gone. */
  heartbeat(): boolean {
    if (this.done) return false;
    // The write queue is the probe: a peer that vanished without erroring the
    // writable half never drains, and comment bytes are far too small for the
    // byte cap to ever notice. Without this a phantom stream stays registered,
    // keeping `hasAvailableBrowserUser()` true and suppressing onClose's
    // last-socket auto-answer while a question waits out its 30-minute timeout.
    if (this.sink.stalledFor(Date.now()) >= SSE_STREAM_STALL_MS) {
      this.finish(1006, "stream_stalled");
      return false;
    }
    if (this.sink.comment("hb")) return true;
    this.finish(1006, "heartbeat_write_failed");
    return false;
  }

  close(code = 1000, reason = ""): void {
    this.closeWithBye(sseByeReasonForCloseCode(code), code, reason);
  }

  closeWithBye(bye: SseByeReason, code = 1000, reason: string = bye): void {
    if (this.done) return;
    this.sink.bye(bye);
    this.finish(code, reason);
  }

  /** Stream ended without a `bye` (client abort, writer error, eviction). */
  abort(code = 1006, reason = "stream_closed"): void {
    if (this.done) return;
    this.finish(code, reason);
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  serializeAttachment(value: unknown): void {
    const current = this.rawState;
    const flags: Record<string, unknown> = {};
    if (current && typeof current === "object") {
      for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
        if (key.startsWith(CF_INTERNAL_KEY_PREFIX)) flags[key] = entry;
      }
    }
    if (value && typeof value === "object") {
      this.rawState = { ...(value as Record<string, unknown>), ...flags };
      return;
    }
    this.rawState = Object.keys(flags).length > 0 ? flags : value;
  }

  deserializeAttachment(): unknown {
    return this.rawState;
  }

  /**
   * Idempotent: the byte-cap/stall paths reach here through `onDead` AND from
   * the failing caller, and a second run would drive a second full wrapped
   * onClose chain for one connection (duplicate pending-question auto-answers).
   */
  private finish(code: number, reason: string): void {
    if (this.done) return;
    this.done = true;
    this.sink.close();
    this.onTeardown(this, code, reason);
  }
}

/**
 * One-shot connection for an HTTP-delivered frame whose reply must come back in
 * the POST body. Shares the SSE stream's connection id so a callable that reads
 * `getCurrentAgent().connection.id` sees the same client.
 */
export function createSseCaptureConnection(options: {
  id: string;
  uri: string | null;
  server: string;
}): { connection: SseConnection; frames: string[] } {
  const sink = createSseCaptureSink();
  const connection = new SseConnection({
    id: options.id,
    uri: options.uri,
    server: options.server,
    sink,
    onTeardown: () => {},
  });
  return { connection, frames: sink.frames };
}
