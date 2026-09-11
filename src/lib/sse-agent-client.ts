import {
  chatSseCloseCodeForByeReason,
  chatSseCloseCodeForHttpStatus,
  isTerminalChatSseByeReason,
  isTerminalChatSseHttpStatus,
  type ChatSseByeReason,
} from "./chat-sse-close";

/**
 * Chat transport: native WebSocket send/receive, with completed HTTP polling
 * and POST calls after a socket error or unexpected close. The historical
 * SseAgentClient export remains the shared client interface used by chat hooks.
 * No connection deadline or receive watchdog is added to the WebSocket.
 */

/** Same numbers as WebSocket.CONNECTING/OPEN/CLOSED — consumers gate on
 * `readyState === SSE_READY_STATE_OPEN`. An intentionally idle-parked client
 * also stays OPEN for sends, which wake its receive connection. */
export const SSE_READY_STATE_CONNECTING = 0;
export const SSE_READY_STATE_OPEN = 1;
export const SSE_READY_STATE_CLOSED = 3;

export const MIN_RECONNECT_DELAY_MS = 2_000;
export const MAX_RECONNECT_DELAY_MS = 15_000;
const RECONNECT_BACKOFF_FACTOR = 1.3;
const RECONNECT_JITTER_RATIO = 0.2;
const POLL_REQUEST_TIMEOUT_MS = 20_000;
export const POLL_INTERVAL_MS = 1_000;
const POLL_HIDDEN_INTERVAL_MS = 5_000;
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/**
 * The server parks a stream from server-side work alone (it has no client
 * liveness signal), so a visible tab that stays parked silently misses pushes
 * from another author or a server-side ingress. Visible tabs reattach after a
 * short jittered delay; hidden tabs keep full dormancy (that is the DO-pinning
 * saving the idle policy exists for).
 */
export const IDLE_REATTACH_MIN_DELAY_MS = 3_000;
const IDLE_REATTACH_JITTER_MS = 5_000;
/** Two parks closer together than this mean the server is re-parking this client
 * immediately; grow the dormancy interval instead of hot-looping. */
const IDLE_PARK_CYCLE_FLOOR_MS = 60_000;
const IDLE_PARK_BACKOFF_FACTOR = 4;
export const MAX_IDLE_REATTACH_DELAY_MS = 5 * 60_000;
/** A resume frame is worth exactly one retry after a reattach. */
const MAX_RESUME_FRAME_ATTEMPTS = 2;
const MAX_QUEUED_RESUME_FRAMES = 8;

const RESUME_FRAME_TYPES = new Set([
  "cf_agent_stream_resume_request",
  "cf_agent_stream_resume_ack",
]);

export type SseAgentEventType = "message" | "open" | "close";

/** Identity of the emitting client; useAgent compares it by reference. */
export interface SseAgentEventTarget {
  readonly agent: string;
  readonly name: string;
  readonly _pk: string;
  readonly readyState: number;
}

export interface SseAgentMessageEvent {
  type: "message";
  data: string;
  target: SseAgentEventTarget;
}

export interface SseAgentOpenEvent {
  type: "open";
  target: SseAgentEventTarget;
}

export interface SseAgentCloseEvent {
  type: "close";
  target: SseAgentEventTarget;
  code: number | null;
  reason: string;
  wasClean: boolean;
  /** HTTP status when the attach itself failed; null for a mid-stream end. */
  status: number | null;
  byeReason: ChatSseByeReason | null;
  /** True when the client tore the reader down itself (unmount/navigation). */
  aborted: boolean;
}

export type AgentSseConnectionError = Error & {
  code: number;
  reason: string;
  wasClean: boolean;
};

export type SseAgentQuery = Record<string, string | null | undefined>;

export interface SseAgentClientOptions<State = unknown> {
  agent: string;
  name: string;
  host?: string;
  query?: SseAgentQuery;
  defaultCallTimeout?: number;
  onOpen?: (event: SseAgentOpenEvent) => void;
  onMessage?: (event: SseAgentMessageEvent) => void;
  onClose?: (event: SseAgentCloseEvent) => void;
  onError?: (error: unknown) => void;
  onConnectionError?: (error: AgentSseConnectionError) => void;
  onStateUpdate?: (state: State, source: "server" | "client") => void;
  onStateUpdateError?: (error: unknown) => void;
  onMcpUpdate?: (mcp: unknown) => void;
  onIdentity?: (name: string, agent: string) => void;
}

type Phase = "new" | "connecting" | "open" | "dormant" | "closed" | "terminal";

interface PendingCall {
  id: string;
  method: string;
  body: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
  dispatched: boolean;
}

interface QueuedResumeFrame {
  body: string;
  attempts: number;
}

interface StreamEndInfo {
  code?: number;
  status?: number | null;
  byeReason?: ChatSseByeReason | null;
  reason?: string;
  aborted?: boolean;
  wasClean?: boolean;
}

function agentHttpBaseUrl(agent: string, name: string, host?: string): string {
  const resolvedHost =
    host ?? (typeof location !== "undefined" ? location.host : "");
  if (!resolvedHost) return "";
  const protocol =
    typeof location !== "undefined" && location.protocol === "http:"
      ? "http:"
      : "https:";
  return `${protocol}//${resolvedHost}/agents/${agent}/${encodeURIComponent(name)}`;
}

function frameType(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

function parseFrame(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Denial bodies are short JSON/text; keep a bounded slice as the close reason. */
async function readReasonBody(response: Response): Promise<string> {
  return (await readBodyText(response)).slice(0, 200);
}

export class SseAgentClient<State = unknown> {
  agent: string;
  name: string;
  path: ReadonlyArray<{ agent: string; name: string }>;
  query: SseAgentQuery;
  /** Opaque per-connection id; the server keys its stream shim on it. */
  _pk: string;
  connectionError: AgentSseConnectionError | null = null;

  private readonly options: SseAgentClientOptions<State>;
  private readonly httpBaseUrl: string;
  private readonly defaultCallTimeout: number;
  private readonly listeners = new Map<
    SseAgentEventType,
    Set<(event: never) => void>
  >();
  private readonly pendingCalls = new Map<string, PendingCall>();
  private queuedResumeFrames: QueuedResumeFrame[] = [];
  private phase: Phase = "new";
  private generation = 0;
  private attempt = 0;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleReattachTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStreamOpenAt = 0;
  private repeatIdleParks = 0;
  private wakeListenersAttached = false;
  private receiveTransport: "websocket" | "poll" = "websocket";
  private socket: WebSocket | null = null;

  get transport(): "websocket" | "poll" { return this.receiveTransport; }

  constructor(options: SseAgentClientOptions<State>) {
    this.options = options;
    this.agent = options.agent;
    this.name = options.name;
    this.path = [{ agent: options.agent, name: options.name }];
    this.query = options.query ?? {};
    this._pk = crypto.randomUUID();
    this.httpBaseUrl = agentHttpBaseUrl(
      options.agent,
      options.name,
      options.host,
    );
    this.defaultCallTimeout = options.defaultCallTimeout ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  get readyState(): number {
    switch (this.phase) {
      case "open":
      case "dormant":
        return SSE_READY_STATE_OPEN;
      case "connecting":
        return SSE_READY_STATE_CONNECTING;
      default:
        return SSE_READY_STATE_CLOSED;
    }
  }

  /** Stable absolute base URL — it feeds the AI SDK chat id, so it must never
   * carry per-connection params (churn discards message state). */
  getHttpUrl(): string {
    return this.httpBaseUrl;
  }

  addEventListener<T extends SseAgentEventType>(
    type: T,
    listener: (
      event: T extends "message"
        ? SseAgentMessageEvent
        : T extends "open"
          ? SseAgentOpenEvent
          : SseAgentCloseEvent,
    ) => void,
    options?: { signal?: AbortSignal },
  ): void;
  // The ai-chat transport registers through the SDK's AgentConnection shape
  // (`type: string`, `MessageEvent` listener); DOM's EventTarget carries the
  // same widening overload for the same reason.
  addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
    options?: { signal?: AbortSignal },
  ): void;
  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: { signal?: AbortSignal },
  ): void {
    if (options?.signal?.aborted) return;
    const eventType = type as SseAgentEventType;
    let set = this.listeners.get(eventType);
    if (!set) {
      set = new Set();
      this.listeners.set(eventType, set);
    }
    const entry = listener as unknown as (event: never) => void;
    set.add(entry);
    // Per-stream teardown in the ai-chat transport relies on {signal}; without
    // it every resumed stream leaks a listener into a dead controller.
    options?.signal?.addEventListener(
      "abort",
      () => {
        set?.delete(entry);
      },
      { once: true },
    );
  }

  removeEventListener(
    type: string,
    listener: (event: never) => void,
  ): void {
    this.listeners.get(type as SseAgentEventType)?.delete(listener);
  }

  /**
   * The SDK sends frames without any readyState guard. Only the resume
   * handshake is live in this app; it needs the stream shim server-side, so it
   * is queued until the connection is up, then sent over WebSocket or POST.
   * Other client frames must use the callable RPC interface.
   */
  send(data: string): void {
    const type = frameType(data);
    if (type && RESUME_FRAME_TYPES.has(type)) {
      this.enqueueResumeFrame({ body: data, attempts: 0 });
      return;
    }
    console.warn(
      `[sse-agent] Dropped an unsupported client frame (type "${type ?? "unknown"}"): raw sends only carry the resume handshake; RPCs use call().`,
    );
  }

  call<T = unknown>(
    method: string,
    args: unknown[] = [],
    options?: { timeout?: number },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.connectionError && this.readyState === SSE_READY_STATE_CLOSED) {
        reject(new Error("Connection closed"));
        return;
      }
      const id = crypto.randomUUID();
      const body = JSON.stringify({ args, id, method, type: "rpc" });
      const effectiveTimeout =
        options?.timeout !== undefined ? options.timeout : this.defaultCallTimeout;
      const pending: PendingCall = {
        id,
        method,
        body,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutId: undefined,
        dispatched: false,
      };
      if (effectiveTimeout) {
        pending.timeoutId = setTimeout(() => {
          this.pendingCalls.delete(id);
          reject(
            new Error(`RPC call to ${method} timed out after ${effectiveTimeout}ms`),
          );
        }, effectiveTimeout);
      }
      this.pendingCalls.set(id, pending);
      if (this.readyState === SSE_READY_STATE_OPEN) this.dispatchCall(pending);
    });
  }

  /**
   * Attach the stream. Idempotent, and revives a closed client so a StrictMode
   * double-mount (effect → cleanup → effect on the same object) reconnects
   * instead of leaving the thread dead. A terminal denial stays terminal.
   */
  start(): void {
    if (this.phase !== "new" && this.phase !== "closed") return;
    this.attachWakeListeners();
    this.phase = "connecting";
    this.startGeneration();
  }

  /** Force a fresh stream generation (the half-open recovery path). */
  reconnect(): void {
    if (this.phase === "closed" || this.phase === "terminal") return;
    // A live generation is about to be aborted mid-flight, and the retiring
    // reader exits through its stale-generation guard without reaching a close
    // path. Announce the end here: `useAgentChat` only re-arms its resume probe
    // on close→open, and with no probe the replacement stream stays in the
    // server's pending-resume set, which excludes it from every chunk of a live
    // turn. A dormant stream already reported its close (bye "idle"), so it must
    // not be closed twice.
    const wasOpen = this.phase === "open";
    this.attempt = 0;
    this.clearReconnectTimer();
    this.attachWakeListeners();
    this.phase = "connecting";
    if (wasOpen) {
      this.emitClose({ reason: "reconnect", aborted: true, wasClean: true });
      // A close listener may tear the client down; do not revive it.
      if (this.phase !== "connecting") return;
    }
    this.startGeneration();
  }

  /** Intentional teardown (unmount / thread switch / navigation). */
  close(): void {
    if (this.phase === "closed") return;
    const previousPhase = this.phase;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearIdleReattachTimer();
    this.closeSocket();
    const controller = this.abortController;
    this.abortController = null;
    controller?.abort();
    this.detachWakeListeners();
    this.rejectPendingCalls("Connection closed");
    this.queuedResumeFrames = [];
    this.phase = "closed";
    if (previousPhase !== "new" && previousPhase !== "terminal") {
      this.emitClose({
        reason: "closed by client",
        aborted: true,
        wasClean: true,
      });
    }
  }

  private startGeneration(): void {
    const generation = (this.generation += 1);
    this.clearIdleReattachTimer();
    this.closeSocket();
    const previous = this.abortController;
    this.abortController = null;
    previous?.abort();
    if (this.receiveTransport === "poll") {
      this._pk = crypto.randomUUID();
      void this.runPoll(generation, -1);
    } else {
      this.runSocket(generation);
    }
  }

  private isStale(generation: number): boolean {
    return this.generation !== generation;
  }

  /** Keep one protocol connection across completed HTTP responses. A cursor is
   * acknowledged only after its entire batch was delivered to the SDK. Failed
   * HTTP reads retry that cursor, so a lost response cannot lose chat chunks.
   * Polling stays selected for this view; a new view tries WebSocket again.
   */
  private async runPoll(generation: number, cursor: number, failures = 0): Promise<void> {
    if (this.isStale(generation)) return;
    const controller = new AbortController();
    this.abortController = controller;
    const timer = setTimeout(() => controller.abort(), POLL_REQUEST_TIMEOUT_MS);
    let nextCursor = cursor;
    let nextFailures = 0;
    try {
      const url = new URL(this.buildUrl("sse"), globalThis.location?.href ?? "http://localhost");
      url.searchParams.set("transport", "poll");
      url.searchParams.set("cursor", String(cursor));
      const response = await globalThis.fetch(url.toString(), {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (this.isStale(generation)) return;
      if (isTerminalChatSseHttpStatus(response.status)) {
        const reason = await readReasonBody(response);
        if (this.isStale(generation)) return;
        this.latchTerminal({
          code: chatSseCloseCodeForHttpStatus(response.status),
          status: response.status,
          reason: reason || "Chat polling denied",
        });
        return;
      }
      if (response.status === 409) {
        // Eviction/redeploy/overflow: reconnect with the SDK handshake and
        // backoff, so repeated resets cannot hammer the authorization path.
        this.emitClose({ reason: "poll session expired" });
        this.scheduleReconnect();
        return;
      }
      if (!response.ok) throw new Error(`Chat poll failed (${response.status}).`);
      const batch: unknown = await response.json();
      if (this.isStale(generation)) return;
      const parsed = batch as { cursor?: unknown; frames?: unknown } | null;
      if (
        !parsed || !Array.isArray(parsed.frames) ||
        !parsed.frames.every((frame): frame is string => typeof frame === "string") ||
        !Number.isSafeInteger(parsed.cursor) ||
        parsed.cursor !== cursor + parsed.frames.length
      ) throw new Error("Invalid chat poll response");
      if (this.phase !== "open") this.markOpen();
      for (const frame of parsed.frames) {
        if (this.isStale(generation)) return;
        this.handleFrame(frame);
      }
      nextCursor = parsed.cursor as number;
    } catch (error) {
      if (this.isStale(generation)) return;
      this.reportError(error);
      nextFailures = failures + 1;
      if (nextFailures >= 3) {
        this.emitClose({ reason: "poll receive failed" });
        this.scheduleReconnect();
        return;
      }
    } finally {
      clearTimeout(timer);
    }
    if (this.isStale(generation)) return;
    const interval = typeof document !== "undefined" && document.visibilityState === "hidden"
      ? POLL_HIDDEN_INTERVAL_MS : POLL_INTERVAL_MS;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runPoll(generation, nextCursor, nextFailures);
    }, nextFailures ? MIN_RECONNECT_DELAY_MS * 2 ** nextFailures : interval);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
  }

  private usePolling(generation: number, reason: string, code?: number): void {
    if (this.isStale(generation)) return;
    for (const pending of Array.from(this.pendingCalls.values())) {
      if (pending.dispatched) this.rejectCall(pending, new Error("Connection lost; the operation may have been accepted"));
    }
    this.receiveTransport = "poll";
    this.emitClose({ reason, code });
    if (this.isStale(generation) || this.phase === "closed" || this.phase === "terminal") return;
    this.phase = "connecting";
    this.startGeneration();
  }

  private runSocket(generation: number): void {
    this._pk = crypto.randomUUID();
    try {
      const url = new URL(this.buildUrl("socket"), globalThis.location?.href ?? "http://localhost");
      url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      socket.onopen = () => {
        if (!this.isStale(generation)) this.markOpen();
      };
      socket.onmessage = (event) => {
        if (!this.isStale(generation) && typeof event.data === "string") this.handleFrame(event.data);
      };
      socket.onerror = () => {
        if (this.isStale(generation)) return;
        this.reportError(new Error("Chat WebSocket connection failed"));
        this.usePolling(generation, "websocket error");
      };
      socket.onclose = (event) => {
        if (this.isStale(generation)) return;
        if (event.code === 1008) {
          this.latchTerminal({ code: event.code, reason: event.reason || "forbidden" });
        } else if (event.code === 1000 && event.reason === "idle") {
          this.handleBye("idle");
        } else {
          this.usePolling(generation, event.reason || "websocket closed", event.code);
        }
      };
    } catch (error) {
      this.reportError(error);
      this.usePolling(generation, "websocket unavailable");
    }
  }

  private handleBye(reason: ChatSseByeReason | null): void {
    if (isTerminalChatSseByeReason(reason)) {
      this.latchTerminal({
        code: chatSseCloseCodeForByeReason(reason),
        reason: reason ?? "forbidden",
        byeReason: reason,
      });
      return;
    }
    if (reason === "idle") {
      // Dormant by design: still OPEN for sends, reattached on demand.
      this.phase = "dormant";
      this.abortController = null;
      const reattachDelay = this.nextIdleReattachDelay();
      this.emitClose({ byeReason: reason, reason, wasClean: true });
      // A close listener may tear the client down or wake it; only a client that
      // is still parked needs the timer.
      if (reattachDelay !== null && this.phase === "dormant") {
        this.scheduleIdleReattach(reattachDelay);
      }
      return;
    }
    this.emitClose({ byeReason: reason, reason: reason ?? "", wasClean: true });
    this.scheduleReconnect();
  }

  private markOpen(): void {
    this.phase = "open";
    this.attempt = 0;
    this.lastStreamOpenAt = Date.now();
    const event: SseAgentOpenEvent = { type: "open", target: this };
    this.safeInvoke("open", () => this.options.onOpen?.(event));
    this.dispatch("open", event);
    this.flushQueues();
  }

  private handleFrame(payload: string): void {
    const event: SseAgentMessageEvent = {
      type: "message",
      data: payload,
      target: this,
    };
    // Every frame reaches every registered listener (the ai-chat transport
    // registers its own), exactly as the WebSocket did.
    this.dispatch("message", event);
    const frame = parseFrame(payload);
    const type = typeof frame?.type === "string" ? frame.type : null;
    if (frame && type && this.interceptFrame(type, frame)) return;
    this.safeInvoke("message", () => this.options.onMessage?.(event));
  }

  /** The five frame types the hook owner consumes instead of onMessage. */
  private interceptFrame(type: string, frame: Record<string, unknown>): boolean {
    switch (type) {
      case "cf_agent_identity": {
        const name = typeof frame.name === "string" ? frame.name : this.name;
        const agent = typeof frame.agent === "string" ? frame.agent : this.agent;
        this.name = name;
        this.agent = agent;
        this.safeInvoke("identity", () => this.options.onIdentity?.(name, agent));
        return true;
      }
      case "cf_agent_state":
        this.safeInvoke("stateUpdate", () =>
          this.options.onStateUpdate?.(frame.state as State, "server"),
        );
        return true;
      case "cf_agent_state_error":
        this.safeInvoke("stateUpdateError", () =>
          this.options.onStateUpdateError?.(frame.error),
        );
        return true;
      case "cf_agent_mcp_servers":
        this.safeInvoke("mcpUpdate", () => this.options.onMcpUpdate?.(frame.mcp));
        return true;
      case "rpc":
        this.applyRpcFrame(frame);
        return true;
      default:
        return false;
    }
  }

  private applyRpcFrame(
    frame: Record<string, unknown>,
    fallback?: PendingCall,
  ): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    const pending = (id ? this.pendingCalls.get(id) : undefined) ?? fallback;
    if (!pending) {
      console.warn(
        `[sse-agent] Discarded an RPC response with no matching pending call (id "${id ?? "unknown"}").`,
      );
      return;
    }
    if (frame.success === false) {
      this.rejectCall(
        pending,
        new Error(
          typeof frame.error === "string" && frame.error
            ? frame.error
            : `RPC call to ${pending.method} failed`,
        ),
      );
      return;
    }
    if ("done" in frame && frame.done === false) {
      console.warn(
        `[sse-agent] Ignored a streaming RPC chunk for "${pending.method}": the POST transport carries one response frame per call.`,
      );
      return;
    }
    this.resolveCall(pending, frame.result);
  }

  private enqueueResumeFrame(frame: QueuedResumeFrame): void {
    if (this.phase === "closed" || this.phase === "terminal") return;
    if (this.phase === "open") {
      void this.postResumeFrame(frame);
      return;
    }
    this.queuedResumeFrames.push(frame);
    if (this.queuedResumeFrames.length > MAX_QUEUED_RESUME_FRAMES) {
      this.queuedResumeFrames.shift();
    }
    // The handshake needs the stream; a parked stream must come back for it.
    this.wake();
  }

  private async postResumeFrame(frame: QueuedResumeFrame): Promise<void> {
    const attempts = frame.attempts + 1;
    try {
      if (this.receiveTransport === "websocket" && this.socket?.readyState === 1) {
        this.socket.send(frame.body);
        return;
      }
      const response = await this.postFrame(frame.body);
      if (response.ok || response.status === 204) return;
      const status = response.status;
      if (status === 409) {
        // The stream shim is gone: reattach, then replay the frame once.
        this.retryResumeFrameAfterReattach(frame.body, attempts);
        return;
      }
      if (status === 400) {
        console.warn(
          "[sse-agent] Server rejected a resume frame (400); dropping it.",
        );
        return;
      }
      if (isTerminalChatSseHttpStatus(status)) {
        const reason = await readReasonBody(response);
        this.latchTerminal({
          code: chatSseCloseCodeForHttpStatus(status),
          reason: reason || `chat send rejected with status ${status}`,
          status,
        });
        return;
      }
      this.retryResumeFrameAfterReattach(frame.body, attempts);
    } catch {
      this.retryResumeFrameAfterReattach(frame.body, attempts);
    }
  }

  /**
   * The queue is drained only on stream open, so the reattach IS the retry
   * driver for a failed resume frame — and the frame needs a live shim anyway.
   * Requeueing without forcing one strands the frame on a stream that is still
   * open (a network blip or a 503 on the POST while the stream survives), and
   * the server keeps this connection excluded from the rest of the turn.
   */
  private retryResumeFrameAfterReattach(body: string, attempts: number): void {
    if (this.phase === "closed" || this.phase === "terminal") return;
    if (attempts >= MAX_RESUME_FRAME_ATTEMPTS) {
      console.warn(
        "[sse-agent] Dropped a resume frame: it did not land after a reattach.",
      );
      return;
    }
    this.requeueResumeFrame({ body, attempts });
    this.reconnect();
  }

  private requeueResumeFrame(frame: QueuedResumeFrame): void {
    if (frame.attempts >= MAX_RESUME_FRAME_ATTEMPTS) return;
    if (this.phase === "closed" || this.phase === "terminal") return;
    this.queuedResumeFrames.push(frame);
    if (this.queuedResumeFrames.length > MAX_QUEUED_RESUME_FRAMES) {
      this.queuedResumeFrames.shift();
    }
  }

  private dispatchCall(pending: PendingCall): void {
    pending.dispatched = true;
    // A dispatched call is a signal the thread is in use: bring a parked
    // stream back so the reply/broadcast path is live again.
    this.wake();
    if (this.receiveTransport === "websocket" && this.socket?.readyState === 1) {
      try {
        this.socket.send(pending.body);
      } catch (error) {
        // Never replay an RPC after an ambiguous send: it may have side effects.
        this.rejectCall(pending, error instanceof Error ? error : new Error(String(error)));
        this.usePolling(this.generation, "websocket send failed");
      }
      return;
    }
    void this.deliverCall(pending);
  }

  private async deliverCall(pending: PendingCall): Promise<void> {
    try {
      const response = await this.postFrame(pending.body);
      if (!this.pendingCalls.has(pending.id)) return;
      if (response.ok) {
        const text = await readBodyText(response);
        if (!this.pendingCalls.has(pending.id)) return;
        const frame = parseFrame(text);
        if (!frame) {
          this.rejectCall(
            pending,
            new Error(`RPC call to ${pending.method} returned no response frame`),
          );
          return;
        }
        this.applyRpcFrame(frame, pending);
        return;
      }
      const status = response.status;
      // A 400 here is the server's frame allow-list (or a malformed call), not
      // an auth verdict — reject the one call instead of killing the thread.
      if (status !== 400 && isTerminalChatSseHttpStatus(status)) {
        const reason = await readReasonBody(response);
        this.latchTerminal({
          code: chatSseCloseCodeForHttpStatus(status),
          reason: reason || `chat call rejected with status ${status}`,
          status,
        });
        return;
      }
      if (!this.pendingCalls.has(pending.id)) return;
      this.rejectCall(
        pending,
        new Error(`RPC call to ${pending.method} failed with status ${status}`),
      );
    } catch (error) {
      if (!this.pendingCalls.has(pending.id)) return;
      this.rejectCall(
        pending,
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
    }
  }

  private postFrame(body: string): Promise<Response> {
    return globalThis.fetch(this.buildUrl("call"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
      },
      credentials: "same-origin",
      cache: "no-store",
      body,
    });
  }

  private resolveCall(pending: PendingCall, result: unknown): void {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    this.pendingCalls.delete(pending.id);
    pending.resolve(result);
  }

  private rejectCall(pending: PendingCall, error: Error): void {
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    this.pendingCalls.delete(pending.id);
    pending.reject(error);
  }

  private rejectPendingCalls(reason: string): void {
    for (const pending of Array.from(this.pendingCalls.values())) {
      this.rejectCall(pending, new Error(reason));
    }
  }

  private flushQueues(): void {
    const frames = this.queuedResumeFrames;
    this.queuedResumeFrames = [];
    for (const frame of frames) void this.postResumeFrame(frame);
    for (const pending of Array.from(this.pendingCalls.values())) {
      if (!pending.dispatched) this.dispatchCall(pending);
    }
  }

  private latchTerminal(input: {
    code: number;
    reason: string;
    status?: number | null;
    byeReason?: ChatSseByeReason | null;
  }): void {
    // One terminal verdict per client: a late POST denial must not re-toast.
    if (this.phase === "terminal" || this.phase === "closed") return;
    const error = Object.assign(
      new Error(`Agent connection closed: ${input.reason}`),
      {
        name: "AgentConnectionError",
        code: input.code,
        reason: input.reason,
        wasClean: false,
      },
    ) as AgentSseConnectionError;
    this.connectionError = error;
    this.phase = "terminal";
    // Retire the in-flight reader with the generation bump, exactly as close()
    // does: the abort below wakes its pending read, and without the bump it
    // survives the stale guard and runs the whole abnormal-end tail — a second
    // close plus an AbortError reported as a pre-open handshake failure, which
    // is the signal this migration is measured by.
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearIdleReattachTimer();
    this.closeSocket();
    const controller = this.abortController;
    this.abortController = null;
    controller?.abort();
    this.rejectPendingCalls("Connection closed");
    this.queuedResumeFrames = [];
    // The only path that releases a pending send bubble and restores its draft.
    this.safeInvoke("connectionError", () =>
      this.options.onConnectionError?.(error),
    );
    this.emitClose({
      status: input.status ?? null,
      byeReason: input.byeReason ?? null,
      reason: input.reason,
      wasClean: false,
    });
  }

  private scheduleReconnect(): void {
    if (this.phase === "closed" || this.phase === "terminal") return;
    this.phase = "connecting";
    this.abortController = null;
    this.attempt += 1;
    this.clearReconnectTimer();
    const delay = this.nextReconnectDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.phase !== "connecting") return;
      this.startGeneration();
    }, delay);
  }

  private nextReconnectDelay(): number {
    const base = Math.min(
      MIN_RECONNECT_DELAY_MS *
        RECONNECT_BACKOFF_FACTOR ** Math.max(0, this.attempt - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    return Math.round(base + Math.random() * base * RECONNECT_JITTER_RATIO);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearIdleReattachTimer(): void {
    if (this.idleReattachTimer !== null) {
      clearTimeout(this.idleReattachTimer);
      this.idleReattachTimer = null;
    }
  }

  /**
   * How long a server-parked stream may stay dormant, or null for full dormancy
   * (wake only on a call/visibility/focus signal).
   *
   * A hidden tab has nothing on screen to go stale, so it stays parked and the
   * DO stays unpinned. A visible tab must come back: the server decides to park
   * from its own work alone, so while parked this tab silently misses a turn
   * started by another author or by a server-side ingress.
   *
   * The interval grows whenever the server parks a stream it held for less than
   * the cycle floor: a server that re-parks this client immediately degrades to
   * a slow poll instead of a park→reopen→park hot loop. A normal 5-minute grace
   * keeps the eager delay (that steady state is the accepted DO-pinning cost).
   */
  private nextIdleReattachDelay(): number | null {
    if (
      typeof document === "undefined" ||
      document.visibilityState !== "visible"
    ) {
      return null;
    }
    const streamLifeMs =
      this.lastStreamOpenAt === 0 ? Infinity : Date.now() - this.lastStreamOpenAt;
    this.repeatIdleParks =
      streamLifeMs < IDLE_PARK_CYCLE_FLOOR_MS ? this.repeatIdleParks + 1 : 0;
    const base =
      IDLE_REATTACH_MIN_DELAY_MS + Math.random() * IDLE_REATTACH_JITTER_MS;
    return Math.round(
      Math.min(
        base * IDLE_PARK_BACKOFF_FACTOR ** this.repeatIdleParks,
        MAX_IDLE_REATTACH_DELAY_MS,
      ),
    );
  }

  private scheduleIdleReattach(delay: number): void {
    this.clearIdleReattachTimer();
    this.idleReattachTimer = setTimeout(() => {
      this.idleReattachTimer = null;
      this.wake();
    }, delay);
  }

  private wake(): void {
    if (this.phase !== "dormant") return;
    this.clearIdleReattachTimer();
    this.attempt = 0;
    this.clearReconnectTimer();
    this.phase = "connecting";
    this.startGeneration();
  }

  private attachWakeListeners(): void {
    if (this.wakeListenersAttached) return;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.handleWindowFocus);
    }
    this.wakeListenersAttached = true;
  }

  private detachWakeListeners(): void {
    if (!this.wakeListenersAttached) return;
    if (typeof document !== "undefined") {
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.handleWindowFocus);
    }
    this.wakeListenersAttached = false;
  }

  private handleVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }
    this.wake();
  };

  private handleWindowFocus = (): void => {
    this.wake();
  };

  private buildUrl(suffix: "sse" | "call" | "socket"): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(this.query)) {
      if (value === null || value === undefined || value === "") continue;
      params.set(key, value);
    }
    params.set("_pk", this._pk);
    const base =
      this.httpBaseUrl ||
      `/agents/${this.agent}/${encodeURIComponent(this.name)}`;
    return `${base}${suffix === "socket" ? "" : `/${suffix}`}?${params.toString()}`;
  }

  private emitClose(info: StreamEndInfo): void {
    const code = info.code ?? (
      typeof info.status === "number"
        ? chatSseCloseCodeForHttpStatus(info.status)
        : info.byeReason
          ? chatSseCloseCodeForByeReason(info.byeReason)
          : null);
    const event: SseAgentCloseEvent = {
      type: "close",
      target: this,
      code,
      reason: info.reason ?? "",
      wasClean: info.wasClean ?? info.aborted === true,
      status: info.status ?? null,
      byeReason: info.byeReason ?? null,
      aborted: info.aborted === true,
    };
    this.safeInvoke("close", () => this.options.onClose?.(event));
    this.dispatch("close", event);
  }

  private reportError(error: unknown): void {
    this.safeInvoke("error", () => this.options.onError?.(error));
  }

  private dispatch(type: SseAgentEventType, event: unknown): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    // Snapshot: a listener may add or remove listeners while handling.
    for (const listener of Array.from(set)) {
      this.safeInvoke(`${type} listener`, () =>
        (listener as (value: unknown) => void)(event),
      );
    }
  }

  /** A throwing consumer must never kill the reader loop. */
  private safeInvoke(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      console.error(`[sse-agent] ${label} handler threw`, error);
    }
  }
}
