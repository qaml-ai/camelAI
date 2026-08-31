import { DurableChatTurnStore } from "./durable-turn-store";
import type { ChatSnapshotMessage, StoreRejection } from "./durable-turn-store";
import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { parseJsonBounded, runtimeJsonLimits } from "./bounded-json-parse";
import {
  boundedJsonString,
  jsonStringByteLength,
  utf8ByteLength,
} from "./utf8-byte-length";
import {
  parseRuntimeContent,
  serializeRuntimeContent,
} from "./chat-runtime-content";
export interface TrustedChatRuntimeScope {
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId: string | null;
}
export const CHAT_RUNTIME_CONTROL_ACTIONS = [
  "stop",
  "answer_question",
  "connection_setup",
] as const;
export type ChatRuntimeControlAction =
  (typeof CHAT_RUNTIME_CONTROL_ACTIONS)[number];
export interface ChatRuntimeCallbacks {
  kick(scope?: TrustedChatRuntimeScope): void | Promise<void>;
  control(
    action: ChatRuntimeControlAction,
    payload: unknown,
  ): unknown | Promise<unknown>;
  coarseState(): unknown | Promise<unknown>;
}
export interface ChatRuntimeLiveUpdate {
  turnId: string; epoch: string;
  activeTurn: { id: string; status: "running"; acceptedAt: number; startedAt?: number };
  message: {
    id: string; role: "assistant";
    content: string | readonly unknown[];
    createdAt: number; status: "running";
  };
}
type ChatRuntimeLiveFrame = ChatRuntimeLiveUpdate & { type: "live"; seq: number };
type LiveEpoch = {
  turnId: string; epoch: string;
  latest: ChatRuntimeLiveUpdate;
  startedAt: number; deadlineAt: number; dirty: boolean;
  emitted: number; emittedBytes: number;
  lastFrame: Uint8Array | null;
  timer: ReturnType<typeof setTimeout> | null;
};
class LimitError extends Error {
  constructor(readonly kind: "bytes" | "timeout") {
    super(kind);
  }
}
const encoder = new TextEncoder();
const heartbeatBytes = encoder.encode(":hb\n\n").byteLength;
function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}
function deadline<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LimitError("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function readJsonBounded(request: Request): Promise<unknown> {
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) throw new SyntaxError("content-length");
    if (Number(rawLength) > CHAT_RUNTIME_BOUNDS.requestBytes)
      throw new LimitError("bytes");
  }
  if (!request.body) throw new SyntaxError("empty body");
  const reader = request.body.getReader();
  try {
    return await deadline(
      (async () => {
        let bytes = 0;
        let text = "";
        const decoder = new TextDecoder("utf-8", { fatal: true });
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > CHAT_RUNTIME_BOUNDS.requestBytes) {
            void reader.cancel("body too large");
            throw new LimitError("bytes");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        return parseJsonBounded(
          text,
          runtimeJsonLimits(CHAT_RUNTIME_BOUNDS.requestBytes),
        );
      })(),
      CHAT_RUNTIME_BOUNDS.bodyReadMs,
    );
  } finally {
    // Do not await cancellation: even a hostile body source cannot extend the
    // request deadline, and Promise.race observes the fenced read task.
    void reader.cancel("body complete or fenced").catch(() => undefined);
  }
}
class BoundedSseWriter {
  private blockedAt: number | null = null;
  private lastDataAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  closed = false;
  cursor: number;
  snapshotVersion = 0;
  liveReady = false;
  constructor(
    private readonly sink: ReadableStreamDefaultController<Uint8Array>,
    now: number,
    cursor: number,
    private readonly onClose: () => void,
  ) {
    this.lastDataAt = now;
    this.cursor = cursor;
  }
  start(): void {
    this.timer = setInterval(
      () => this.tick(Date.now()),
      CHAT_RUNTIME_BOUNDS.sseHeartbeatMs,
    );
  }
  comment(value = "hb"): boolean {
    return this.write(encoder.encode(`:${value}\n\n`), false);
  }
  frame(value: unknown): boolean {
    const chunk = encodeFrame(value);
    if (!chunk) {
      this.close();
      return false;
    }
    return this.encodedFrame(chunk);
  }
  encodedFrame(chunk: Uint8Array): boolean {
    const written = this.write(chunk, true);
    if (!written) this.close();
    return written;
  }
  private write(chunk: Uint8Array, data: boolean): boolean {
    if (this.closed) return false;
    if (chunk.byteLength > CHAT_RUNTIME_BOUNDS.sseWriterBytes) return false;
    const remaining = Math.max(0, Math.floor(this.sink.desiredSize ?? 0));
    if (chunk.byteLength > remaining) {
      this.blockedAt ??= Date.now();
      return false;
    }
    try {
      this.sink.enqueue(chunk);
      this.blockedAt = null;
      if (data) this.lastDataAt = Date.now();
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  private tick(now: number): void {
    if (now - this.lastDataAt >= CHAT_RUNTIME_BOUNDS.sseIdleMs) {
      this.close();
      return;
    }
    if ((this.sink.desiredSize ?? 0) < heartbeatBytes) {
      this.blockedAt ??= now;
      if (now - this.blockedAt >= CHAT_RUNTIME_BOUNDS.sseSlowWriterMs)
        this.close();
      return;
    }
    this.blockedAt = null;
    this.comment();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      // Erroring discards the stream's internal queue before this writer
      // releases its aggregate reservation.
      this.sink.error(new Error("Chat SSE writer closed"));
    } catch {
      // Cancellation may already have closed the controller.
    }
    this.onClose();
  }
}
function runtimeMessage(message: ChatSnapshotMessage) {
  const { id, role, content, createdAt, status } = message;
  return { id, role, content, createdAt, status };
}
function encodeFrame(value: unknown): Uint8Array | null {
  try { return encoder.encode(`data: ${JSON.stringify(value)}\n\n`); }
  catch { return null; }
}
function frameBytes(value: unknown): number {
  try { return 8 + utf8ByteLength(JSON.stringify(value)); }
  catch { return Number.POSITIVE_INFINITY; }
}
function liveIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= CHAT_RUNTIME_BOUNDS.identifierChars;
}
function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function normalizeLiveUpdate(update: ChatRuntimeLiveUpdate): {
  update: ChatRuntimeLiveUpdate | null;
  oversize: boolean;
} {
  if (
    !update ||
    typeof update !== "object" ||
    !liveIdentifier(update.turnId) ||
    !liveIdentifier(update.epoch) ||
    !update.activeTurn ||
    typeof update.activeTurn !== "object" ||
    update.activeTurn.id !== update.turnId ||
    update.activeTurn.status !== "running" ||
    !finiteTimestamp(update.activeTurn.acceptedAt) ||
    (update.activeTurn.startedAt !== undefined &&
      !finiteTimestamp(update.activeTurn.startedAt)) ||
    !update.message ||
    typeof update.message !== "object" ||
    !liveIdentifier(update.message.id) ||
    update.message.role !== "assistant" ||
    update.message.status !== "running" ||
    !finiteTimestamp(update.message.createdAt)
  ) {
    return { update: null, oversize: false };
  }

  let content: string | unknown[];
  try {
    if (typeof update.message.content === "string") {
      if (
        jsonStringByteLength(update.message.content) >
        CHAT_RUNTIME_BOUNDS.liveMessageBytes
      ) {
        return { update: null, oversize: true };
      }
      content = update.message.content;
    } else if (Array.isArray(update.message.content)) {
      if (
        update.message.content.length > CHAT_RUNTIME_BOUNDS.liveContentBlocks
      ) {
        return { update: null, oversize: true };
      }
      const trace = serializeRuntimeContent(update.message.content);
      content = parseRuntimeContent(trace) ?? [];
    } else {
      return { update: null, oversize: false };
    }
  } catch {
    return { update: null, oversize: false };
  }

  const normalized: ChatRuntimeLiveUpdate = {
    turnId: update.turnId,
    epoch: update.epoch,
    activeTurn: {
      id: update.activeTurn.id,
      status: "running",
      acceptedAt: update.activeTurn.acceptedAt,
      ...(update.activeTurn.startedAt === undefined
        ? {}
        : { startedAt: update.activeTurn.startedAt }),
    },
    message: {
      id: update.message.id,
      role: "assistant",
      content,
      createdAt: update.message.createdAt,
      status: "running",
    },
  };
  try {
    const messageBytes = utf8ByteLength(JSON.stringify(normalized.message));
    const largestFrame: ChatRuntimeLiveFrame = {
      type: "live",
      ...normalized,
      seq: CHAT_RUNTIME_BOUNDS.liveFramesPerTurn,
    };
    if (
      messageBytes > CHAT_RUNTIME_BOUNDS.liveMessageBytes ||
      frameBytes(largestFrame) > CHAT_RUNTIME_BOUNDS.sseWriterBytes
    ) {
      return { update: null, oversize: true };
    }
  } catch {
    return { update: null, oversize: false };
  }
  return { update: normalized, oversize: false };
}
function fitNewestMessages(
  payload: Record<string, unknown>,
  messages: Array<ReturnType<typeof runtimeMessage>>,
): void {
  if (!messages.length) return;
  let target = -1, targetBytes = -1;
  for (const [index, message] of messages.entries()) {
    if (typeof message.content !== "string") continue;
    const bytes = jsonStringByteLength(message.content);
    if (bytes > targetBytes) { target = index; targetBytes = bytes; }
  }
  if (target < 0) return;
  const content = messages[target].content;
  if (typeof content !== "string") return;
  messages[target] = { ...messages[target], content: "" };
  const empty = encodeFrame(payload);
  if (!empty || empty.byteLength > CHAT_RUNTIME_BOUNDS.sseWriterBytes) return;
  messages[target] = { ...messages[target], content: boundedJsonString(
    content, CHAT_RUNTIME_BOUNDS.sseWriterBytes - empty.byteLength + 2) };
}
function liveRefillDelay(
  live: LiveEpoch, frameBytes: number, now: number,
): number | null {
  const total = CHAT_RUNTIME_BOUNDS.liveBytesPerTurn;
  const required = live.emittedBytes + frameBytes;
  if (required > total || now > live.deadlineAt) return null;
  const burst = Math.min(total, CHAT_RUNTIME_BOUNDS.liveBurstBytes);
  const duration = Math.max(1, live.deadlineAt - live.startedAt);
  const elapsed = Math.max(0, Math.min(duration, now - live.startedAt));
  const allowance = Math.min(total,
    burst + Math.floor(((total - burst) * elapsed) / duration));
  if (required <= allowance) return 0;
  if (now >= live.deadlineAt) return null;
  const refill = total - burst;
  if (refill <= 0) return null;
  const targetElapsed = Math.ceil(((required - burst) * duration) / refill);
  return Math.max(CHAT_RUNTIME_BOUNDS.liveFlushMs,
    live.startedAt + targetElapsed - now);
}
/** A framework-free, bounded HTTP/SSE boundary around durable chat turns. */
export class ChatRuntimeController {
  private readonly connections = new Map<number, BoundedSseWriter>();
  private nextConnectionId = 1;
  private publishRun: Promise<void> | null = null;
  private publishDirty = false;
  private liveEpoch: LiveEpoch | null = null;
  private reservedSseBytes = 0;
  private storeInstance: DurableChatTurnStore | null = null;
  private readonly storeFactory: () => DurableChatTurnStore;
  constructor(
    private readonly ctx: DurableObjectState,
    store: DurableChatTurnStore | (() => DurableChatTurnStore),
    private readonly trustedScope: (
      request: Request,
    ) => TrustedChatRuntimeScope,
    private readonly callbacks: ChatRuntimeCallbacks,
  ) {
    this.storeFactory = typeof store === "function" ? store : () => store;
  }
  private get store(): DurableChatTurnStore {
    return (this.storeInstance ??= this.storeFactory());
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/v2/events")) {
      if (request.method !== "GET") return this.methodNotAllowed("GET");
      return this.events(request, url);
    }
    if (url.pathname.endsWith("/v2/messages")) {
      if (request.method !== "POST") return this.methodNotAllowed("POST");
      return this.messages(request, url);
    }
    if (url.pathname.endsWith("/v2/controls")) {
      if (request.method !== "POST") return this.methodNotAllowed("POST");
      return this.controls(request, url);
    }
    return new Response("Not found", { status: 404 });
  }
  close(): void {
    this.clearLive();
    for (const connection of this.connections.values()) connection.close();
  }
  /** Pushes newly durable events; execution remains owned by the DO driver. */
  publish(): Promise<void> {
    this.publishDirty = true;
    if (this.publishRun) return this.publishRun;
    const run = this.flushPublish().finally(() => {
      if (this.publishRun === run) this.publishRun = null;
      if (this.publishDirty) {
        this.ctx.waitUntil(
          this.publish().catch((error) =>
            console.error(
              "[ChatRuntimeController] coalesced publish failed",
              error,
            ),
          ),
        );
      }
    });
    this.publishRun = run;
    return run;
  }
  /**
   * Best-effort presentation only. Live frames never touch storage, the durable
   * cursor or the turn lifecycle. Callers provide a cumulative
   * view; bursts collapse into at most one bounded frame per flush interval.
   */
  publishLive(update: ChatRuntimeLiveUpdate): void {
    if (
      this.liveEpoch &&
      (this.liveEpoch.emitted >= CHAT_RUNTIME_BOUNDS.liveFramesPerTurn ||
        this.liveEpoch.emittedBytes >= CHAT_RUNTIME_BOUNDS.liveBytesPerTurn)
    )
      return;
    const normalized = normalizeLiveUpdate(update);
    if (!normalized.update) {
      if (normalized.oversize) {
        this.clearLive();
        for (const connection of this.connections.values()) connection.close();
      }
      return;
    }
    const current = this.liveEpoch;
    if (
      current &&
      (current.turnId !== normalized.update.turnId ||
        current.epoch !== normalized.update.epoch)
    ) {
      // An old callback may outlive its attempt. Epoch replacement is explicit
      // through clearLive so a stale producer can never retake presentation.
      return;
    }
    let live = current;
    if (!live) {
      const acceptedAt = normalized.update.activeTurn.acceptedAt;
      const startedAt = Math.min(Date.now(), acceptedAt);
      live = this.liveEpoch = {
        turnId: normalized.update.turnId, epoch: normalized.update.epoch,
        latest: normalized.update, startedAt,
        deadlineAt: Math.min(Number.MAX_SAFE_INTEGER,
          startedAt + CHAT_RUNTIME_BOUNDS.turnLeaseMs),
        dirty: false, emitted: 0, emittedBytes: 0,
        lastFrame: null, timer: null,
      };
    }
    live.latest = normalized.update;
    live.dirty = true;
    if (live.timer !== null) return;
    live.timer = setTimeout(
      () => this.flushLive(live),
      CHAT_RUNTIME_BOUNDS.liveFlushMs,
    );
  }
  clearLive(turnId?: string, epoch?: string): void {
    const live = this.liveEpoch;
    if (!live) return;
    if (turnId !== undefined && live.turnId !== turnId) return;
    if (epoch !== undefined && live.epoch !== epoch) return;
    if (live.timer !== null) clearTimeout(live.timer);
    live.timer = null;
    live.dirty = false;
    if (this.liveEpoch === live) this.liveEpoch = null;
  }
  private flushLive(live: LiveEpoch): void {
    if (this.liveEpoch !== live) return;
    live.timer = null;
    if (
      !live.dirty ||
      live.emitted >= CHAT_RUNTIME_BOUNDS.liveFramesPerTurn ||
      live.emittedBytes >= CHAT_RUNTIME_BOUNDS.liveBytesPerTurn
    )
      return;
    const frame: ChatRuntimeLiveFrame = {
      type: "live",
      ...live.latest,
      seq: live.emitted + 1,
    };
    const encoded = encodeFrame(frame);
    if (!encoded || encoded.byteLength > CHAT_RUNTIME_BOUNDS.sseWriterBytes) {
      this.clearLive(live.turnId, live.epoch);
      for (const connection of this.connections.values()) connection.close();
      return;
    }
    const bytes = encoded.byteLength;
    const now = Date.now();
    const refillDelay = liveRefillDelay(live, bytes, now);
    if (refillDelay === null) {
      live.emittedBytes = CHAT_RUNTIME_BOUNDS.liveBytesPerTurn;
      live.dirty = false;
      return;
    }
    if (refillDelay > 0) {
      live.timer = setTimeout(() => this.flushLive(live), refillDelay);
      return;
    }
    live.dirty = false;
    live.emitted += 1;
    live.emittedBytes += bytes;
    live.lastFrame = encoded;
    for (const writer of this.connections.values()) {
      if (!writer.closed && writer.liveReady) writer.encodedFrame(encoded);
    }
  }
  private seedLive(writer: BoundedSseWriter): void {
    const frame = this.liveEpoch?.lastFrame;
    if (!frame || writer.closed) return;
    writer.encodedFrame(frame);
  }
  private scheduleKick(scope?: TrustedChatRuntimeScope): void {
    this.ctx.waitUntil(
      Promise.resolve()
        .then(() => this.callbacks.kick(scope))
        .catch((error) =>
          console.error("[ChatRuntimeController] kick failed", error),
        ),
    );
  }
  private methodNotAllowed(allow: string): Response {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: allow },
    });
  }
  private getScope(
    request: Request,
    url: URL,
  ): TrustedChatRuntimeScope | Response {
    try {
      const scope = this.trustedScope(request);
      if (!scope.threadId || !scope.workspaceId || !scope.orgId) {
        return new Response("Runtime scope unavailable", { status: 503 });
      }
      for (const key of ["threadId", "workspaceId", "orgId"] as const) {
        const values = url.searchParams
          .getAll(key)
          .map((value) => value.trim());
        if (values.some((value) => value && value !== scope[key])) {
          return new Response("Forbidden", { status: 403 });
        }
      }
      return scope;
    } catch {
      return new Response("Runtime scope unavailable", { status: 503 });
    }
  }
  private events(request: Request, url: URL): Response {
    const afterRaw = url.searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(Number(afterRaw))) {
      return new Response("Invalid cursor", { status: 400 });
    }
    if (
      this.connections.size >= CHAT_RUNTIME_BOUNDS.sseWritersPerThread ||
      this.reservedSseBytes + CHAT_RUNTIME_BOUNDS.sseWriterQueueBytes >
        CHAT_RUNTIME_BOUNDS.sseDoBytes
    ) {
      return new Response("Too many streams", {
        status: 429,
        headers: { "Retry-After": "5" },
      });
    }
    const id = this.nextConnectionId++;
    this.reservedSseBytes += CHAT_RUNTIME_BOUNDS.sseWriterQueueBytes;
    let reserved = true;
    let writer!: BoundedSseWriter;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (sink) => {
          writer = new BoundedSseWriter(
            sink,
            Date.now(),
            Number(afterRaw),
            () => {
              if (reserved) {
                reserved = false;
                this.reservedSseBytes -=
                  CHAT_RUNTIME_BOUNDS.sseWriterQueueBytes;
              }
              if (this.connections.get(id) === writer) {
                this.connections.delete(id);
              }
            },
          );
          // The first byte exists before scope, storage, or runtime callbacks.
          writer.comment();
        },
        cancel: () => writer?.close(),
      },
      {
        highWaterMark: CHAT_RUNTIME_BOUNDS.sseWriterQueueBytes,
        size: (chunk) => chunk.byteLength,
      },
    );
    const scope = this.getScope(request, url);
    if (scope instanceof Response) {
      writer.close();
      return scope;
    }
    if (request.signal.aborted) {
      writer.close();
      return new Response("Client closed", { status: 499 });
    }
    this.connections.set(id, writer);
    writer.start();
    request.signal.addEventListener("abort", () => writer.close(), {
      once: true,
    });
    this.ctx.waitUntil(
      this.seed(writer, Number(afterRaw)).catch(() => {
        writer.close();
      }),
    );
    this.scheduleKick(scope);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
  private async seed(writer: BoundedSseWriter, after: number): Promise<void> {
    await deadline(
      Promise.resolve().then(async () => {
        const snapshotVersion = writer.snapshotVersion;
        const cursor = this.store.revision();
        writer.frame({ type: "hello", cursor });
        if (writer.closed) return;
        if (after === 0 || after !== cursor) {
          const snapshot = await Promise.resolve(this.store.latestSnapshot());
          this.sendSnapshot(
            writer,
            after === 0 ? "snapshot" : "reset",
            cursor,
            snapshot,
            await this.callbacks.coarseState(),
            snapshotVersion,
          );
        }
        writer.liveReady = true;
        this.seedLive(writer);
      }),
      CHAT_RUNTIME_BOUNDS.runtimeCallbackMs,
    );
  }
  private async flushPublish(): Promise<void> {
    this.publishDirty = false;
    try {
      await deadline(
        Promise.resolve().then(async () => {
          const cursor = this.store.revision();
          const changed = [...this.connections.values()].filter(
            (writer) => !writer.closed && writer.cursor !== cursor,
          );
          if (!changed.length) return;
          const snapshot = await Promise.resolve(this.store.latestSnapshot());
          const state = await this.callbacks.coarseState();
          const frame = this.buildSnapshotFrame(
            "reset",
            cursor,
            snapshot,
            state,
          );
          for (const writer of changed) {
            this.writeSnapshot(writer, cursor, frame);
          }
        }),
        CHAT_RUNTIME_BOUNDS.runtimeCallbackMs,
      );
    } catch (error) {
      for (const writer of this.connections.values()) {
        writer.close();
      }
      throw error;
    }
  }
  private sendSnapshot(
    writer: BoundedSseWriter,
    type: "snapshot" | "reset",
    cursor: number,
    snapshot: ReturnType<DurableChatTurnStore["latestSnapshot"]>,
    state: unknown,
    expectedVersion?: number,
  ): void {
    if (
      expectedVersion !== undefined &&
      writer.snapshotVersion !== expectedVersion
    ) {
      return;
    }
    this.writeSnapshot(
      writer,
      cursor,
      this.buildSnapshotFrame(type, cursor, snapshot, state),
    );
  }
  private buildSnapshotFrame(
    type: "snapshot" | "reset",
    cursor: number,
    snapshot: ReturnType<DurableChatTurnStore["latestSnapshot"]>,
    state: unknown,
  ): Uint8Array | null {
    const selected = snapshot.messages.slice(
      -CHAT_RUNTIME_BOUNDS.snapshotMessages,
    );
    const messages = selected.map(runtimeMessage);
    const users = new Map(
      snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => [message.turnId, message]),
    );
    const current = [...users.values()].find(
      (message) => message.status === "running" || message.status === "queued",
    );
    const payload: Record<string, unknown> = {
      type,
      cursor,
      messages,
      activeTurn: current
        ? {
            id: current.turnId,
            status: current.status,
            acceptedAt: current.createdAt,
          }
        : null,
      ...(state === undefined ? {} : { state }),
    };
    let encoded = encodeFrame(payload);
    if (encoded && encoded.byteLength <= CHAT_RUNTIME_BOUNDS.sseWriterBytes) {
      return encoded;
    }
    const newestTurnId = selected.at(-1)?.turnId;
    const newestStart = selected.findIndex(
      (message) => message.turnId === newestTurnId);
    if (newestStart > 0) {
      let low = 1, high = newestStart, keepFrom = newestStart;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        payload.messages = messages.slice(middle);
        const candidate = encodeFrame(payload);
        if (candidate?.byteLength &&
          candidate.byteLength <= CHAT_RUNTIME_BOUNDS.sseWriterBytes) {
          encoded = candidate;
          keepFrom = middle;
          high = middle - 1;
        } else low = middle + 1;
      }
      messages.splice(0, keepFrom);
      payload.messages = messages;
      if (encoded?.byteLength &&
        encoded.byteLength <= CHAT_RUNTIME_BOUNDS.sseWriterBytes) return encoded;
    }
    fitNewestMessages(payload, messages);
    encoded = encodeFrame(payload);
    return encoded && encoded.byteLength <= CHAT_RUNTIME_BOUNDS.sseWriterBytes
      ? encoded
      : null;
  }
  private writeSnapshot(
    writer: BoundedSseWriter,
    cursor: number,
    frame: Uint8Array | null,
  ): void {
    if (frame && writer.encodedFrame(frame)) {
      writer.cursor = cursor;
      writer.snapshotVersion += 1;
    } else if (!frame) {
      writer.close();
    }
  }
  private async messages(request: Request, url: URL): Promise<Response> {
    const scope = this.getScope(request, url);
    if (scope instanceof Response) return scope;
    const body = await this.readPostBody(request);
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid message" }, 422);
    }
    const input = body as Record<string, unknown>;
    const allowed = new Set(["clientMessageId", "content", "display"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      return json({ error: "Unsupported message field" }, 422);
    }
    const clientMessageId =
      typeof input.clientMessageId === "string"
        ? input.clientMessageId.trim()
        : "";
    if (
      !clientMessageId ||
      clientMessageId.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
      typeof input.content !== "string" ||
      input.content.length === 0 ||
      (input.display !== undefined && typeof input.display !== "string")
    ) {
      return json({ error: "Invalid message" }, 422);
    }
    const now = Date.now();
    try {
      await deadline(
        this.ctx.storage.setAlarm(now),
        CHAT_RUNTIME_BOUNDS.alarmWriteMs,
      );
    } catch (error) {
      if (error instanceof LimitError && error.kind === "timeout") {
        this.ctx.abort("Alarm pre-arm timed out");
      }
      return json({ error: "Could not schedule turn" }, 503);
    }
    const result = this.store.admit(
      {
        id: clientMessageId,
        clientMessageId,
        threadId: scope.threadId,
        workspaceId: scope.workspaceId,
        orgId: scope.orgId,
        userId: scope.userId,
        source: "web",
        userContent: input.content,
        userDisplay:
          typeof input.display === "string" ? input.display : input.content,
      },
      now,
    );
    if (!result.ok) return this.storeRejection(result.reason);
    this.ctx.waitUntil(
      this.publish().catch((error) =>
        console.error("[ChatRuntimeController] publish failed", error),
      ),
    );
    this.scheduleKick();
    return json(
      {
        accepted: true,
        duplicate: result.duplicate,
        turnId: result.turn.id,
        status: result.turn.status,
      },
      202,
    );
  }
  private storeRejection(reason: StoreRejection): Response {
    if (reason === "request_bytes") return json({ error: reason }, 413);
    if (
      reason === "queue_full" ||
      reason === "queue_bytes" ||
      reason === "busy"
    ) {
      return json({ error: reason }, 429, { "Retry-After": "5" });
    }
    return json({ error: reason }, reason === "invalid" ? 422 : 409);
  }
  private async controls(request: Request, url: URL): Promise<Response> {
    const scope = this.getScope(request, url);
    if (scope instanceof Response) return scope;
    const body = await this.readPostBody(request);
    if (body instanceof Response) return body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid control" }, 422);
    }
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => key !== "action" && key !== "payload") ||
      typeof input.action !== "string" ||
      !CHAT_RUNTIME_CONTROL_ACTIONS.includes(
        input.action as ChatRuntimeControlAction,
      )
    ) {
      return json({ error: "Unsupported control" }, 400);
    }
    try {
      const result = await deadline(
        Promise.resolve().then(() =>
          this.callbacks.control(
            input.action as ChatRuntimeControlAction,
            input.payload,
          ),
        ),
        CHAT_RUNTIME_BOUNDS.runtimeCallbackMs,
      );
      return json({ ok: true, result });
    } catch (error) {
      return json(
        {
          error:
            error instanceof LimitError
              ? "Control timed out"
              : "Control failed",
        },
        error instanceof LimitError ? 504 : 409,
      );
    }
  }
  private async readPostBody(request: Request): Promise<unknown | Response> {
    const type = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.startsWith("application/json")) {
      return json({ error: "Expected JSON" }, 415);
    }
    try {
      return await readJsonBounded(request);
    } catch (error) {
      if (error instanceof LimitError) {
        return json(
          {
            error:
              error.kind === "bytes"
                ? "Request too large"
                : "Request timed out",
          },
          error.kind === "bytes" ? 413 : 408,
        );
      }
      return json({ error: "Malformed JSON" }, 400);
    }
  }
}
