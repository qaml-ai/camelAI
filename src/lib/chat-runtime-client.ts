import { CHAT_RUNTIME_BOUNDS } from "./chat-runtime-bounds";

export const CHAT_ATTACH_TIMEOUT_MS = CHAT_RUNTIME_BOUNDS.attachTimeoutMs;
export const CHAT_STREAM_SILENCE_MS = CHAT_RUNTIME_BOUNDS.streamSilenceMs;
export const CHAT_MAX_RECONNECT_ATTEMPTS = CHAT_RUNTIME_BOUNDS.reconnectAttempts;
export const CHAT_MAX_FRAME_BYTES = CHAT_RUNTIME_BOUNDS.frameBytes;
export const CHAT_MAX_SNAPSHOT_MESSAGES = CHAT_RUNTIME_BOUNDS.snapshotMessages;

export type ChatRuntimeConnectionStatus = "idle" | "connecting" | "ready" | "offline" | "closed";
export type ChatRuntimeTurnStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface ChatRuntimeActiveTurn {
  id: string;
  status: ChatRuntimeTurnStatus;
  acceptedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export type ChatRuntimeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; status?: "succeeded" | "failed" };

export interface ChatRuntimeMessage {
  id: string;
  role: "user" | "assistant";
  content: string | ChatRuntimeContentBlock[];
  createdAt: number;
  status: ChatRuntimeTurnStatus;
}

interface CursorFrame { cursor: number }
export interface ChatRuntimeHelloFrame extends CursorFrame {
  type: "hello";
}

export interface ChatRuntimeSnapshotFrame<State = unknown> extends CursorFrame {
  type: "snapshot" | "reset";
  messages: ChatRuntimeMessage[];
  activeTurn: ChatRuntimeActiveTurn | null;
  state?: State;
}

export interface ChatRuntimeTurnFrame extends CursorFrame {
  type: "turn";
  activeTurn: ChatRuntimeActiveTurn | null;
  message?: ChatRuntimeMessage;
}

/** Attempt-local cumulative presentation. It never owns the durable cursor. */
export interface ChatRuntimeLiveFrame {
  type: "live";
  turnId: string;
  epoch: string;
  seq: number;
  activeTurn: ChatRuntimeActiveTurn;
  message: ChatRuntimeMessage;
}

export interface ChatRuntimeStateFrame<State = unknown> extends CursorFrame {
  type: "state";
  state: State;
}

export interface ChatRuntimeByeFrame {
  type: "bye";
  reason?: string;
  retry?: boolean;
}

export type ChatRuntimeFrame<State = unknown> = ChatRuntimeHelloFrame | ChatRuntimeSnapshotFrame<State> | ChatRuntimeTurnFrame | ChatRuntimeLiveFrame | ChatRuntimeStateFrame<State> | ChatRuntimeByeFrame;
export interface ChatRuntimeClientOptions<State = unknown> {
  baseUrl: string;
  eventsPath?: string;
  messagesPath?: string;
  controlsPath?: string;
  fetch?: typeof fetch;
  attachTimeoutMs?: number;
  silenceTimeoutMs?: number;
  maxAttempts?: number;
  maxFrameBytes?: number;
  maxSnapshotMessages?: number;
  onFrame?: (frame: ChatRuntimeFrame<State>) => void;
  onStatus?: (status: ChatRuntimeConnectionStatus) => void;
  onError?: (error: Error) => void;
}

type RequiredOption = "eventsPath" | "messagesPath" | "controlsPath" | "attachTimeoutMs" | "silenceTimeoutMs" | "maxAttempts" | "maxFrameBytes" | "maxSnapshotMessages";
type ResolvedOptions<State> = ChatRuntimeClientOptions<State> & Required<Pick<ChatRuntimeClientOptions<State>, RequiredOption>>;

class ProtocolError extends Error { constructor(message: string) { super(message); this.name = "ChatRuntimeProtocolError"; } }
class PostAttemptTimeoutError extends Error { constructor() { super("POST attempt timed out"); this.name = "PostAttemptTimeoutError"; } }
class AttachTimeoutError extends Error { constructor() { super("SSE attach timed out"); this.name = "AttachTimeoutError"; } }
class StreamSilenceError extends Error { constructor() { super("SSE stream exceeded its silence deadline"); this.name = "StreamSilenceError"; } }

const encoder = new TextEncoder();

class BoundedPlainJsonError extends Error {
  constructor(readonly kind: "bytes" | "shape") { super(kind); }
}
export interface BoundedPlainJsonResult<T> { value: T; bytes: number; }

function quotedJsonBytes(value: string, maximum: number): number | null {
  if (value.length + 2 > maximum) return null;
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { bytes += 4; index += 1; }
      else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
    if (bytes > maximum) return null;
  }
  return bytes;
}

export function boundedPlainJsonClone<T>(
  input: unknown,
  maximumBytes: number,
): BoundedPlainJsonResult<T> {
  const maximum = Math.max(0, Math.floor(maximumBytes));
  let bytes = 0;
  let entries = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const spend = (amount: number) => {
    if (bytes + amount > maximum) throw new BoundedPlainJsonError("bytes");
    bytes += amount;
  };
  const spendQuoted = (value: string) => {
    const quotedBytes = quotedJsonBytes(value, maximum - bytes);
    if (quotedBytes === null) throw new BoundedPlainJsonError("bytes");
    bytes += quotedBytes;
  };
  const visit = (value: unknown, depth: number, arrayValue: boolean): unknown => {
    if (
      ++nodes > CHAT_RUNTIME_BOUNDS.providerJsonNodes ||
      depth > CHAT_RUNTIME_BOUNDS.providerJsonDepth
    ) throw new BoundedPlainJsonError("shape");
    if (value === null) { spend(4); return null; }
    if (typeof value === "string") { spendQuoted(value); return value; }
    if (typeof value === "boolean") { spend(value ? 4 : 5); return value; }
    if (typeof value === "number") {
      const normalized = Number.isFinite(value) ? value : null;
      spend(JSON.stringify(normalized).length);
      return normalized;
    }
    if (
      value === undefined ||
      typeof value === "function" ||
      typeof value === "symbol"
    ) {
      if (arrayValue) { spend(4); return null; }
      throw new BoundedPlainJsonError("shape");
    }
    if (typeof value !== "object") throw new BoundedPlainJsonError("shape");
    if (ancestors.has(value)) throw new BoundedPlainJsonError("shape");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        entries += value.length;
        if (entries > CHAT_RUNTIME_BOUNDS.providerJsonEntries)
          throw new BoundedPlainJsonError("shape");
        spend(2 + Math.max(0, value.length - 1));
        const copy: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor) { spend(4); copy.push(null); }
          else if (!("value" in descriptor)) throw new BoundedPlainJsonError("shape");
          else copy.push(visit(descriptor.value, depth + 1, true));
        }
        return copy;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new BoundedPlainJsonError("shape");
      spend(2);
      const copy = Object.create(null) as Record<string, unknown>;
      let first = true;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable) continue;
        if (++entries > CHAT_RUNTIME_BOUNDS.providerJsonEntries)
          throw new BoundedPlainJsonError("shape");
        if (!("value" in descriptor)) throw new BoundedPlainJsonError("shape");
        const child = descriptor.value;
        if (
          child === undefined ||
          typeof child === "function" ||
          typeof child === "symbol"
        ) {
          continue;
        }
        if (!first) spend(1);
        first = false;
        spendQuoted(key);
        spend(1);
        copy[key] = visit(child, depth + 1, false);
      }
      return copy;
    } finally {
      ancestors.delete(value);
    }
  };
  return { value: visit(input, 0, false) as T, bytes };
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), maximum)
    : fallback;
}

const endpoint = (base: string, suffix: string) => `${base.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIdentifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= CHAT_RUNTIME_BOUNDS.identifierChars;
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

function serializedBytesAtMost(value: unknown, maximum: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return serialized !== undefined && encoder.encode(serialized).byteLength <= maximum;
  } catch {
    return false;
  }
}

function isBoundedToolInput(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  try {
    boundedPlainJsonClone(value, CHAT_RUNTIME_BOUNDS.toolInputBytes);
    return true;
  } catch {
    return false;
  }
}

function isRuntimeContentBlock(value: unknown): value is ChatRuntimeContentBlock {
  if (!isObject(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return hasOnlyKeys(value, ["type", "text"]) && typeof value.text === "string";
  if (value.type === "thinking") return hasOnlyKeys(value, ["type", "thinking", "signature"]) && typeof value.thinking === "string" && (value.signature === undefined || typeof value.signature === "string");
  if (value.type === "tool_use") return hasOnlyKeys(value, ["type", "id", "name", "input"]) && isIdentifier(value.id) && isIdentifier(value.name) && isBoundedToolInput(value.input);
  if (value.type === "tool_result") return (
      hasOnlyKeys(value, ["type", "tool_use_id", "content", "is_error", "status"]) &&
      isIdentifier(value.tool_use_id) &&
      typeof value.content === "string" &&
      encoder.encode(value.content).byteLength <= CHAT_RUNTIME_BOUNDS.toolResultBytes &&
      (value.is_error === undefined || typeof value.is_error === "boolean") &&
      (value.status === undefined || value.status === "succeeded" || value.status === "failed")
    );
  return false;
}

function isRuntimeContent(value: unknown): value is ChatRuntimeMessage["content"] {
  if (typeof value === "string") return encoder.encode(value).byteLength <= CHAT_RUNTIME_BOUNDS.assistantBytes;
  return (
    Array.isArray(value) &&
    value.length <= CHAT_RUNTIME_BOUNDS.liveContentBlocks &&
    value.every(isRuntimeContentBlock) &&
    serializedBytesAtMost(value, CHAT_RUNTIME_BOUNDS.liveMessageBytes)
  );
}

function isRuntimeMessage(value: unknown): value is ChatRuntimeMessage {
  return (
    isObject(value) &&
    isIdentifier(value.id) &&
    (value.role === "user" || value.role === "assistant") &&
    isRuntimeContent(value.content) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    TURN_STATUSES.has(value.status as ChatRuntimeTurnStatus)
  );
}

const TURN_STATUSES = new Set<ChatRuntimeTurnStatus>(["queued", "running", "completed", "failed", "interrupted", "cancelled"]);

function isActiveTurn(value: unknown): value is ChatRuntimeActiveTurn | null {
  if (value === null) return true;
  if (!isObject(value)) return false;
  const finiteOptional = (field: unknown) => field === undefined || (typeof field === "number" && Number.isFinite(field));
  return (
    isIdentifier(value.id) &&
    TURN_STATUSES.has(value.status as ChatRuntimeTurnStatus) &&
    typeof value.acceptedAt === "number" &&
    Number.isFinite(value.acceptedAt) &&
    finiteOptional(value.startedAt) &&
    finiteOptional(value.finishedAt) &&
    (value.error === undefined || (typeof value.error === "string" && encoder.encode(value.error).byteLength <= CHAT_RUNTIME_BOUNDS.assistantBytes))
  );
}

function cursorOf(value: Record<string, unknown>): number | null {
  return Number.isSafeInteger(value.cursor) && (value.cursor as number) >= 0 ? (value.cursor as number) : null;
}

function parseFrame<State>(raw: string, maxSnapshotMessages: number): ChatRuntimeFrame<State> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError("SSE data is not valid JSON");
  }
  if (!isObject(value) || typeof value.type !== "string") throw new ProtocolError("SSE data is not a typed object");
  if (value.type === "bye") {
    if ((value.reason !== undefined && typeof value.reason !== "string") || (value.retry !== undefined && typeof value.retry !== "boolean")) throw new ProtocolError("bye frame has invalid fields");
    return value as unknown as ChatRuntimeByeFrame;
  }
  if (value.type === "live") {
    if (
      !isIdentifier(value.turnId) ||
      !isIdentifier(value.epoch) ||
      !Number.isSafeInteger(value.seq) ||
      (value.seq as number) < 0 ||
      (value.seq as number) > CHAT_RUNTIME_BOUNDS.liveFramesPerTurn ||
      !isActiveTurn(value.activeTurn) ||
      value.activeTurn === null ||
      value.activeTurn.id !== value.turnId ||
      value.activeTurn.status !== "running" ||
      !isRuntimeMessage(value.message) ||
      value.message.role !== "assistant" ||
      value.message.status !== "running"
    ) {
      throw new ProtocolError("live frame exceeds bounds or has invalid fields");
    }
    return value as unknown as ChatRuntimeLiveFrame;
  }
  const cursor = cursorOf(value);
  if (cursor === null) throw new ProtocolError("frame cursor is invalid");
  if (value.type === "hello") return { type: "hello", cursor };
  if (value.type === "state") {
    if (!("state" in value)) throw new ProtocolError("state frame is empty");
    return value as unknown as ChatRuntimeStateFrame<State>;
  }
  if (value.type === "turn") {
    if (!isActiveTurn(value.activeTurn)) throw new ProtocolError("turn frame has an invalid active turn");
    if (value.message !== undefined && !isRuntimeMessage(value.message)) throw new ProtocolError("turn frame has an invalid message");
    return value as unknown as ChatRuntimeTurnFrame;
  }
  if (value.type === "snapshot" || value.type === "reset") {
    if (
      !Array.isArray(value.messages) ||
      value.messages.length > maxSnapshotMessages ||
      !value.messages.every(isRuntimeMessage) ||
      !isActiveTurn(value.activeTurn)
    ) throw new ProtocolError("snapshot exceeds bounds or has invalid fields");
    return value as unknown as ChatRuntimeSnapshotFrame<State>;
  }
  throw new ProtocolError(`unsupported frame type: ${value.type}`);
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const result = await reader.read();
    if (result.done) return text + decoder.decode();
    bytes += result.value.byteLength;
    if (bytes > maxBytes) {
      // Cancellation is advisory; a hostile source must not turn the byte
      // fence itself into an unbounded wait.
      void reader.cancel().catch(() => undefined);
      throw new ProtocolError("response exceeds byte limit");
    }
    text += decoder.decode(result.value, { stream: true });
  }
}

/** Small cursor-based SSE transport. POSTs never wait for the receive stream. */
export class ChatRuntimeClient<State = unknown> {
  private readonly options: ResolvedOptions<State>;
  private readonly fetcher: typeof fetch;
  private generation = 0;
  private attempts = 0;
  private cursor: number | null = null;
  private durableActiveTurnId: string | null | undefined;
  private liveTurnId: string | null = null;
  private liveEpoch: string | null = null;
  private liveSequence = -1;
  private readonly liveEpochs = new Set<string>();
  private stopped = true;
  private status: ChatRuntimeConnectionStatus = "idle";
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ChatRuntimeClientOptions<State>) {
    this.options = {
      ...options,
      eventsPath: options.eventsPath || "/events",
      messagesPath: options.messagesPath || "/messages",
      controlsPath: options.controlsPath || "/controls",
      attachTimeoutMs: boundedPositive(options.attachTimeoutMs, CHAT_ATTACH_TIMEOUT_MS, CHAT_ATTACH_TIMEOUT_MS),
      silenceTimeoutMs: boundedPositive(options.silenceTimeoutMs, CHAT_STREAM_SILENCE_MS, CHAT_STREAM_SILENCE_MS),
      maxAttempts: boundedPositive(options.maxAttempts, CHAT_MAX_RECONNECT_ATTEMPTS, CHAT_MAX_RECONNECT_ATTEMPTS),
      maxFrameBytes: boundedPositive(options.maxFrameBytes, CHAT_MAX_FRAME_BYTES, CHAT_MAX_FRAME_BYTES),
      maxSnapshotMessages: boundedPositive(options.maxSnapshotMessages, CHAT_MAX_SNAPSHOT_MESSAGES, CHAT_MAX_SNAPSHOT_MESSAGES),
    };
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get connectionStatus(): ChatRuntimeConnectionStatus { return this.status; }
  get lastCursor(): number { return this.cursor ?? 0; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onActivation);
      globalThis.addEventListener?.("focus", this.onActivation);
    }
    this.reconnect();
  }

  reconnect = (): void => {
    if (this.stopped) return;
    this.attempts = 0;
    this.cancelAttach();
    void this.attach(++this.generation);
  };

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.cancelAttach();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onActivation);
      globalThis.removeEventListener?.("focus", this.onActivation);
    }
    this.setStatus("closed");
  }

  sendMessage<T = unknown, Body = unknown>(body: Body): Promise<T> { return this.post<T>(this.options.messagesPath, body); }

  control<T = unknown, Payload = unknown>(action: string, payload?: Payload): Promise<T> {
    return this.post<T>(this.options.controlsPath, { action, payload });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let serialized: string;
    try {
      const detached = boundedPlainJsonClone<unknown>(body, CHAT_RUNTIME_BOUNDS.requestBytes);
      serialized = JSON.stringify(detached.value);
    } catch (error) {
      throw new ProtocolError(
        error instanceof BoundedPlainJsonError && error.kind === "bytes"
          ? "POST body exceeds byte limit"
          : "POST body is not valid JSON",
      );
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.postAttempt<T>(path, serialized);
      } catch (error) {
        const retryable =
          error instanceof PostAttemptTimeoutError ||
          error instanceof TypeError ||
          (error instanceof DOMException && error.name === "AbortError");
        if (!retryable || attempt + 1 >= CHAT_RUNTIME_BOUNDS.postAttempts) throw error;
      }
    }
  }

  private async postAttempt<T>(path: string, serialized: string): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = (async () => {
      const response = await this.fetcher(endpoint(this.options.baseUrl, path), {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: serialized,
          signal: controller.signal,
      });
      const text = await boundedResponseText(response, CHAT_RUNTIME_BOUNDS.postResponseBytes);
      if (!response.ok) throw new Error(text.slice(0, 300) || `HTTP ${response.status}`);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ProtocolError("POST response is not valid JSON");
      }
    })();
    task.catch(() => undefined);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PostAttemptTimeoutError());
      }, CHAT_RUNTIME_BOUNDS.postAttemptMs);
    });
    return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
  }

  private async attach(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    if (this.attempts >= this.options.maxAttempts) {
      this.setStatus("offline");
      return;
    }
    this.attempts += 1;
    this.setStatus("connecting");
    const startedAt = Date.now();
    const controller = new AbortController();
    this.controller = controller;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    const attachTimer = setTimeout(
      () => controller.abort(new AttachTimeoutError()),
      this.options.attachTimeoutMs,
    );
    const aborted = new Promise<never>((_, reject) => {
      const rejectAbort = () => {
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new DOMException("aborted", "AbortError"),
        );
      };
      if (controller.signal.aborted) rejectAbort();
      else
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
    });
    // The abort gate remains live across both fetch and stream consumption.
    // Observing it here also makes a final cleanup abort harmless after a race
    // has already resolved through the network side.
    aborted.catch(() => undefined);
    let attached = false;
    const touch = () => {
      if (!attached) {
        attached = true;
        clearTimeout(attachTimer);
        this.setStatus("ready");
      }
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(
        () => controller.abort(new StreamSilenceError()),
        this.options.silenceTimeoutMs,
      );
    };
    let terminal = false;
    try {
      const url = endpoint(this.options.baseUrl, this.options.eventsPath);
      const fetchTask = this.fetcher(
        `${url}${url.includes("?") ? "&" : "?"}after=${this.cursor ?? 0}`,
        { signal: controller.signal, credentials: "same-origin" },
      );
      fetchTask.catch(() => undefined);
      const response = await Promise.race([fetchTask, aborted]);
      if (!response.ok) throw new Error(`event stream HTTP ${response.status}`);
      if (
        !response.headers.get("content-type")?.includes("text/event-stream")
      ) {
        throw new ProtocolError("event response is not SSE");
      }
      if (!response.body) throw new ProtocolError("event response has no body");
      if (generation !== this.generation) return;
      const streamTask = this.readStream(
        response.body,
        generation,
        touch,
        controller.signal,
      );
      streamTask.catch(() => undefined);
      const stream = await Promise.race([streamTask, aborted]);
      terminal = stream.terminal;
      // The server always writes an immediate heartbeat. That first byte is
      // liveness, not proof of a healthy connection: only durable cursor
      // progress or a genuinely stable interval renews the failure budget.
      if (
        stream.observedProgress ||
        Date.now() - startedAt >= CHAT_RUNTIME_BOUNDS.reconnectStableMs
      ) {
        this.attempts = 0;
      }
    } catch (error) {
      if (generation === this.generation && !this.stopped) {
        this.options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      clearTimeout(attachTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
      controller.abort();
      if (this.controller === controller) this.controller = null;
    }
    if (generation !== this.generation || this.stopped) return;
    if (terminal || this.attempts >= this.options.maxAttempts) {
      this.setStatus("offline");
      return;
    }
    this.setStatus("connecting");
    const delay = Math.min(
      CHAT_RUNTIME_BOUNDS.reconnectBackoffMs,
      250 * 2 ** Math.max(0, this.attempts - 1),
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attach(generation);
    }, delay);
  }

  private async readStream(
    body: ReadableStream<Uint8Array>,
    generation: number,
    touch: () => void,
    signal: AbortSignal,
  ): Promise<{ terminal: boolean; observedProgress: boolean }> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    });
    let buffer = "";
    let bufferBytes = 0;
    let protocolErrors = 0;
    let observedProgress = false;
    const cancel = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    const consume = (text: string, receivedBytes: number): boolean | null => {
      buffer += text;
      bufferBytes += receivedBytes;
      const boundaryPattern = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r|\n)/;
      let boundary = boundaryPattern.exec(buffer);
      while (boundary) {
        const end = boundary.index + boundary[0].length;
        const block = buffer.slice(0, boundary.index);
        const wire = buffer.slice(0, end);
        buffer = buffer.slice(end);
        const wireBytes = encoder.encode(wire).byteLength;
        if (wireBytes > this.options.maxFrameBytes) {
          throw new ProtocolError("SSE frame exceeds byte limit");
        }
        // Input bytes are counted once as they arrive. Encoding a completed
        // wire frame lets us assign those bytes to this event without
        // repeatedly encoding the growing incomplete prefix.
        bufferBytes -= wireBytes;
        if (bufferBytes < 0) {
          throw new ProtocolError("SSE frame byte accounting is invalid");
        }
        const data = block
          .replace(/\r\n|\r/g, "\n")
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          try {
            const frame = parseFrame<State>(
              data,
              this.options.maxSnapshotMessages,
            );
            if (frame.type === "bye") {
              this.options.onFrame?.(frame);
              return frame.retry === false;
            }
            if (frame.type === "live") {
              if (this.acceptLiveFrame(frame)) {
                this.options.onFrame?.(frame);
              }
            } else if (frame.type === "hello") {
              this.options.onFrame?.(frame);
            } else if (frame.type === "reset") {
              // A reset alone is authoritative when storage recreation moves
              // the server cursor backwards.
              if (frame.cursor > (this.cursor ?? 0)) observedProgress = true;
              this.cursor = frame.cursor;
              this.reconcileDurableActiveTurn(frame.activeTurn);
              this.options.onFrame?.(frame);
            } else if (
              frame.type === "snapshot" &&
              (this.cursor === null || frame.cursor >= this.cursor)
            ) {
              if (frame.cursor > (this.cursor ?? 0)) observedProgress = true;
              this.cursor = frame.cursor;
              this.reconcileDurableActiveTurn(frame.activeTurn);
              this.options.onFrame?.(frame);
            } else if (this.cursor === null || frame.cursor > this.cursor) {
              if (frame.cursor > (this.cursor ?? 0)) observedProgress = true;
              this.cursor = frame.cursor;
              if (frame.type === "turn") {
                this.reconcileDurableActiveTurn(frame.activeTurn);
              }
              this.options.onFrame?.(frame);
            }
          } catch (error) {
            protocolErrors += 1;
            this.options.onError?.(error as Error);
            if (protocolErrors >= CHAT_RUNTIME_BOUNDS.malformedFrames) {
              throw error;
            }
          }
        }
        boundary = boundaryPattern.exec(buffer);
      }
      if (bufferBytes > this.options.maxFrameBytes) {
        throw new ProtocolError("SSE frame exceeds byte limit");
      }
      return null;
    };
    try {
      while (generation === this.generation && !this.stopped) {
        const result = await reader.read();
        if (
          generation !== this.generation ||
          this.stopped ||
          signal.aborted
        ) {
          return { terminal: true, observedProgress };
        }
        if (result.done) {
          const tail = decoder.decode();
          const terminal = tail ? consume(tail, 0) : null;
          if (terminal !== null) return { terminal, observedProgress };
          return { terminal: false, observedProgress };
        }
        touch(); // Includes `:comment` heartbeats.
        for (
          let offset = 0;
          offset < result.value.byteLength;
          offset += CHAT_RUNTIME_BOUNDS.sseDecodeSliceBytes
        ) {
          const slice = result.value.subarray(
            offset,
            offset + CHAT_RUNTIME_BOUNDS.sseDecodeSliceBytes,
          );
          const decoded = decoder.decode(slice, { stream: true });
          const terminal = consume(decoded, slice.byteLength);
          if (terminal !== null) return { terminal, observedProgress };
        }
      }
      return { terminal: true, observedProgress };
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      try {
        reader.releaseLock();
      } catch {
        // Cancellation may still be settling a hostile underlying source.
      }
    }
  }

  private acceptLiveFrame(frame: ChatRuntimeLiveFrame): boolean {
    if (
      this.durableActiveTurnId !== undefined &&
      this.durableActiveTurnId !== frame.turnId
    ) {
      return false;
    }
    if (this.liveTurnId !== frame.turnId) {
      this.resetLiveTracking(frame.turnId);
    }
    if (this.liveEpoch === frame.epoch) {
      if (frame.seq <= this.liveSequence) return false;
    } else {
      if (
        this.liveEpochs.has(frame.epoch) ||
        this.liveEpochs.size >= CHAT_RUNTIME_BOUNDS.attemptsPerTurn
      ) {
        return false;
      }
      this.liveEpochs.add(frame.epoch);
      this.liveEpoch = frame.epoch;
      this.liveSequence = -1;
    }
    this.liveSequence = frame.seq;
    return true;
  }

  private reconcileDurableActiveTurn(
    activeTurn: ChatRuntimeActiveTurn | null,
  ): void {
    const nextTurnId =
      activeTurn?.status === "queued" || activeTurn?.status === "running"
        ? activeTurn.id
        : null;
    this.durableActiveTurnId = nextTurnId;
    if (this.liveTurnId !== nextTurnId) this.resetLiveTracking(nextTurnId);
  }

  private resetLiveTracking(turnId: string | null): void {
    this.liveTurnId = turnId;
    this.liveEpoch = null;
    this.liveSequence = -1;
    this.liveEpochs.clear();
  }

  private setStatus(status: ChatRuntimeConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private cancelAttach(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.controller?.abort();
    this.controller = null;
  }

  private onActivation = (): void => {
    if (
      this.stopped ||
      (typeof document !== "undefined" && document.visibilityState === "hidden")
    ) {
      return;
    }
    this.attempts = 0;
    if (this.status === "offline") this.reconnect();
  };
}
