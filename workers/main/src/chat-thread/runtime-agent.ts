/**
 * A thread's agent on the hosted agent runtime (plans/agent-runtime-migration.md).
 *
 * `RuntimeAgentSession` stands where ChatThreadDO's in-process Pi `Agent`
 * stands, with the few members the DO uses (`state`, `subscribe`, `prompt`,
 * `steer`, `abort`, `continue`, `waitForIdle`). The runtime runs the model
 * loop and sends native Pi `AgentEvent`s over its client event stream, so the
 * DO's event handler, chunk encoder, pi_core mirror and UI transport work
 * unchanged. The runtime owns the transcript, compaction, retries and turn
 * handoff; this class only relays.
 *
 * Durable per thread (DO KV via `RuntimeAgentStore`): the agent's id and
 * token, the event cursor at the last run boundary, and the run in flight. A
 * DO that restarts mid-run replays that run's events from its start cursor
 * (the runtime buffers them) instead of prompting again.
 */
import type { AgentEvent, AgentMessage, AgentState } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** The MCP server name chiridion's tools are served under in the runtime definition. */
export const RUNTIME_TOOL_SERVER = "camel";
const TOOL_PREFIX = `${RUNTIME_TOOL_SERVER}__`;
const FRAME_LIMIT_BYTES = 16 * 1024 * 1024;

export interface RuntimeAgentEnv {
  AGENT_RUNTIME_ENABLED?: string;
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_API_TOKEN?: string;
  AGENT_RUNTIME_DEFINITION?: string;
  APP_KV: KVNamespace;
}

export interface RuntimeAgentRecord {
  id: string;
  token: string;
}

export interface RuntimeRunRecord {
  requestId: string;
  /** Event cursor before the run began: a restart replays the run from here. */
  cursor: number;
}

export interface RuntimeAgentStore {
  agent(): RuntimeAgentRecord | null;
  saveAgent(agent: RuntimeAgentRecord): void;
  cursor(): number | null;
  saveCursor(cursor: number): void;
  run(): RuntimeRunRecord | null;
  saveRun(run: RuntimeRunRecord | null): void;
}

export interface RuntimeAgentIdentity {
  orgId: string;
  workspaceId: string;
  threadId: string;
  /** The thread's creator: `sub` in the agent's identity tokens. */
  subject: string;
}

export interface RuntimeAgentSessionOptions {
  env: RuntimeAgentEnv;
  store: RuntimeAgentStore;
  identity: RuntimeAgentIdentity;
  /** Who is acting in the run being started: `act` in its tokens. */
  actor: () => string | null;
  /** The committed transcript the DO loaded; runtime messages append to it. */
  initialState: Pick<AgentState, "systemPrompt" | "model" | "tools" | "messages" | "thinkingLevel">;
  /** The configuration applied once, right after the agent is created. */
  configuration: () => Promise<{ systemPrompt: string }>;
  /** Called for the runtime's heartbeats, so the DO's stall watchdog sees a long tool call as alive. */
  onActivity?: () => void;
  fetch?: typeof globalThis.fetch;
}

type Listener = (event: AgentEvent) => unknown;
/** Pi's `AgentState`, writable: this session maintains it from the runtime's events. */
type RuntimeAgentState = { -readonly [K in keyof AgentState]: AgentState[K] } & { pendingToolCalls: Set<string> };
type ClientFrame =
  | { type: "event"; requestId: string; event: Record<string, unknown> }
  | { type: "response"; id: string; outcome: { result?: unknown; error?: string; uncertain?: boolean } };

export function runtimeUrl(env: RuntimeAgentEnv): string {
  return (env.AGENT_RUNTIME_URL || "https://agents.camelai.dev").replace(/\/+$/, "");
}

/** KV allowlist key: an org whose new threads run on the hosted runtime. */
export function runtimeOrgAllowKey(orgId: string): string {
  return `agent_runtime_org:${orgId}`;
}

/** Whether a new thread in `orgId` should run on the hosted runtime. */
export async function runtimeEnabledForOrg(env: RuntimeAgentEnv, orgId: string): Promise<boolean> {
  if (env.AGENT_RUNTIME_ENABLED !== "true") return false;
  if (!env.AGENT_RUNTIME_API_TOKEN || !env.AGENT_RUNTIME_DEFINITION) return false;
  return (await env.APP_KV.get(runtimeOrgAllowKey(orgId))) !== null;
}

export class RuntimeAgentError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "RuntimeAgentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `camel__deploy_project` → `deploy_project`, so the UI renders chiridion's tools as it always has. */
export function localToolName(name: unknown): unknown {
  return typeof name === "string" && name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function localizeMessage<T>(message: T): T {
  if (!isRecord(message)) return message;
  if (message.role === "toolResult" && typeof message.toolName === "string") {
    return { ...message, toolName: localToolName(message.toolName) } as T;
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((block) =>
        isRecord(block) && block.type === "toolCall" ? { ...block, name: localToolName(block.name) } : block),
    } as T;
  }
  return message;
}

/** A runtime event with chiridion's tool names, as the DO's handler expects it. */
export function localizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const localized: Record<string, unknown> = { ...event };
  if ("toolName" in localized) localized.toolName = localToolName(localized.toolName);
  if ("message" in localized) localized.message = localizeMessage(localized.message);
  if (Array.isArray(localized.messages)) localized.messages = localized.messages.map(localizeMessage);
  if (isRecord(localized.assistantMessageEvent)) {
    const inner = { ...localized.assistantMessageEvent };
    if (isRecord(inner.toolCall)) inner.toolCall = { ...inner.toolCall, name: localToolName(inner.toolCall.name) };
    if ("partial" in inner) inner.partial = localizeMessage(inner.partial);
    localized.assistantMessageEvent = inner;
  }
  return localized;
}

function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && part.type === "text" ? String(part.text ?? "") : "")).join("");
}

function errorAssistant(model: AgentState["model"], message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

export class RuntimeAgentSession {
  readonly state: RuntimeAgentState;
  private readonly options: RuntimeAgentSessionOptions;
  private readonly listeners = new Set<Listener>();
  /** Local copies of user messages sent this run, to keep their render ids when the runtime echoes them. */
  private readonly sentUserMessages: AgentMessage[] = [];
  private running: Promise<void> | null = null;
  private streamAbort: AbortController | null = null;
  private sawAgentEnd = false;

  constructor(options: RuntimeAgentSessionOptions) {
    this.options = options;
    this.state = {
      ...options.initialState,
      messages: [...options.initialState.messages],
      isStreaming: false,
      pendingToolCalls: new Set<string>(),
    } as RuntimeAgentState;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get fetcher() {
    return this.options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call(path: string, init: { method?: string; body?: unknown; token: string; headers?: Record<string, string> }) {
    const response = await this.fetcher(`${runtimeUrl(this.options.env)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${init.token}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) as unknown : null;
    if (!response.ok) {
      const message = isRecord(body) && typeof body.error === "string" ? body.error : text.slice(0, 500);
      throw new RuntimeAgentError(`Agent runtime ${init.method ?? "GET"} ${path.split("?")[0]}: HTTP ${response.status} ${message}`, response.status);
    }
    return body;
  }

  /** The thread's runtime agent, created (idempotently, per thread) on first use. */
  private async agent(): Promise<RuntimeAgentRecord> {
    const stored = this.options.store.agent();
    if (stored) return stored;
    const { env, identity } = this.options;
    const created = await this.call("/v1/agents", {
      method: "POST",
      token: env.AGENT_RUNTIME_API_TOKEN ?? "",
      headers: { "Idempotency-Key": `thread:${identity.threadId}` },
      body: {
        definition: env.AGENT_RUNTIME_DEFINITION,
        name: identity.threadId,
        type: "camelai-thread",
        ttlSeconds: null,
        subject: identity.subject,
        context: { org: identity.orgId, workspace: identity.workspaceId, thread: identity.threadId },
      },
    }) as { id?: unknown; token?: unknown };
    if (typeof created.id !== "string" || typeof created.token !== "string") {
      throw new RuntimeAgentError("Agent runtime returned no agent id or token");
    }
    const record = { id: created.id, token: created.token };
    // Until the runtime takes a prompt alongside a definition at creation (R1),
    // configure it before the first run; it is queued ahead of that run.
    const { systemPrompt } = await this.options.configuration();
    await this.call(`/v1/agents/${record.id}/configuration`, {
      method: "PATCH",
      token: env.AGENT_RUNTIME_API_TOKEN ?? "",
      body: { requestId: `configure:${identity.threadId}`, systemPrompt },
    });
    this.options.store.saveAgent(record);
    return record;
  }

  private async request(method: string, params: Record<string, unknown>, id: string = crypto.randomUUID()) {
    const agent = await this.agent();
    return await this.call(`/clients/${agent.id}/requests`, {
      method: "POST",
      token: agent.token,
      body: { id, method, params },
    });
  }

  private async currentCursor(agent: RuntimeAgentRecord): Promise<number> {
    const stored = this.options.store.cursor();
    if (stored !== null) return stored;
    const state = await this.call(`/clients/${agent.id}/state`, { token: agent.token }) as { cursor?: unknown };
    return typeof state.cursor === "number" ? state.cursor : 0;
  }

  private async emit(event: Record<string, unknown>) {
    const localized = localizeEvent(event) as unknown as AgentEvent & { message?: AgentMessage; toolCallId?: string };
    switch (localized.type) {
      case "agent_start":
        this.state.isStreaming = true;
        break;
      case "message_start":
        if ((localized.message as { role?: string } | undefined)?.role === "assistant") this.state.streamingMessage = localized.message;
        break;
      case "message_end": {
        let message = localized.message as AgentMessage;
        if ((message as { role?: string }).role === "user") {
          // Keep the DO's stamped copy (render id, metadata) of what it sent.
          const index = this.sentUserMessages.findIndex((sent) => userText(sent) === userText(message));
          if (index >= 0) [message] = this.sentUserMessages.splice(index, 1);
          localized.message = message;
        }
        if ((message as { role?: string }).role === "assistant") this.state.streamingMessage = undefined;
        this.state.messages.push(message);
        break;
      }
      case "tool_execution_start":
        if (localized.toolCallId) this.state.pendingToolCalls.add(localized.toolCallId);
        break;
      case "tool_execution_end":
        if (localized.toolCallId) this.state.pendingToolCalls.delete(localized.toolCallId);
        break;
      case "agent_end":
        this.sawAgentEnd = true;
        this.state.isStreaming = false;
        break;
    }
    for (const listener of [...this.listeners]) await listener(localized);
  }

  /**
   * Relay the agent's events from `cursor` until the response to `requestId`
   * arrives. Reconnects on a dropped stream; a replay gap (the runtime no
   * longer buffers the run's events) recovers the run's messages from history.
   */
  private async relay(agent: RuntimeAgentRecord, requestId: string, cursor: number): Promise<void> {
    let position = cursor;
    let backoffMs = 250;
    for (;;) {
      this.streamAbort = new AbortController();
      let response: Response;
      try {
        response = await this.fetcher(`${runtimeUrl(this.options.env)}/clients/${agent.id}/events`, {
          headers: { Authorization: `Bearer ${agent.token}`, Accept: "text/event-stream", "Last-Event-ID": String(position) },
          signal: this.streamAbort.signal,
        });
      } catch (error) {
        if (this.streamAbort.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(5000, backoffMs * 2);
        continue;
      }
      if (response.status === 409) {
        await response.body?.cancel();
        await this.recoverFromHistory(agent, requestId);
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if ([401, 403, 404, 410].includes(response.status)) {
          throw new RuntimeAgentError(`Agent runtime event stream: HTTP ${response.status}`, response.status);
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(5000, backoffMs * 2);
        continue;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          if (buffer.length > FRAME_LIMIT_BYTES) throw new RuntimeAgentError("Agent runtime event frame too large");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = raw.split("\n");
            const idLine = lines.find((line) => line.startsWith("id:"));
            const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            // `ready`, heartbeats, and the runtime's live MCP relay carry no id.
            if (!idLine || !data) {
              this.options.onActivity?.();
              continue;
            }
            const id = Number(idLine.slice(3));
            if (!Number.isSafeInteger(id) || id <= position) continue;
            position = id;
            const frame = JSON.parse(data) as ClientFrame;
            if (frame.type === "event" && isRecord(frame.event)) {
              // Runtime notices (turn_resumed, file_presented, …) carry no Pi shape; the DO ignores unknown types.
              if (frame.requestId === requestId || frame.requestId === "") await this.emit(frame.event);
            } else if (frame.type === "response" && frame.id === requestId) {
              this.options.store.saveCursor(position);
              await this.settle(frame.outcome);
              return;
            }
          }
        }
      } catch (error) {
        if (this.streamAbort.signal.aborted) return;
        if (error instanceof RuntimeAgentError) throw error;
      } finally {
        reader.releaseLock();
      }
      backoffMs = 250;
    }
  }

  /** The run ended: make sure the DO sees an agent_end even when the runtime refused the run outright. */
  private async settle(outcome: { error?: string } | undefined) {
    if (this.sawAgentEnd) return;
    const failure = errorAssistant(this.state.model, outcome?.error || "The agent run ended without a result");
    await this.emit({ type: "message_start", message: failure });
    await this.emit({ type: "message_end", message: failure });
    await this.emit({ type: "turn_end", message: failure, toolResults: [] });
    await this.emit({ type: "agent_end", messages: [failure] });
  }

  /** Replay gap: take the run's messages from the agent's history, then close the run out. */
  private async recoverFromHistory(agent: RuntimeAgentRecord, requestId: string) {
    const history = await this.call(`/clients/${agent.id}/history`, { token: agent.token }) as { messages?: AgentMessage[] };
    const status = await this.call(`/clients/${agent.id}/requests/${encodeURIComponent(requestId)}`, { token: agent.token }) as {
      outcome?: { error?: string };
      prompt?: string;
    };
    const messages = (history.messages ?? []).map(localizeMessage);
    const promptText = typeof status.prompt === "string" ? status.prompt : null;
    let start = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as { role?: string };
      if (message.role === "user" && (promptText === null || userText(messages[index]) === promptText)) {
        start = index;
        break;
      }
    }
    const runMessages = start >= 0 ? messages.slice(start) : [];
    const known = new Set(this.state.messages.map((message) => JSON.stringify(localizeMessage(message))));
    this.state.messages.push(...runMessages.filter((message) => !known.has(JSON.stringify(message))));
    const last = [...runMessages].reverse().find((message) => (message as { role?: string }).role === "assistant");
    if (last) await this.emit({ type: "turn_end", message: last, toolResults: [] });
    if (status.outcome && !this.sawAgentEnd) {
      await this.emit({ type: "agent_end", messages: runMessages });
    }
    const state = await this.call(`/clients/${agent.id}/state`, { token: agent.token }) as { cursor?: unknown };
    if (typeof state.cursor === "number") this.options.store.saveCursor(state.cursor);
  }

  private async run(method: "prompt" | "continue", params: Record<string, unknown>) {
    const agent = await this.agent();
    const cursor = await this.currentCursor(agent);
    const requestId = crypto.randomUUID();
    this.options.store.saveRun({ requestId, cursor });
    this.sawAgentEnd = false;
    this.state.isStreaming = true;
    try {
      await this.request(method, params, requestId);
      await this.relay(agent, requestId, cursor);
    } finally {
      this.options.store.saveRun(null);
      this.state.isStreaming = false;
      this.streamAbort = null;
    }
  }

  prompt(message: AgentMessage): Promise<void> {
    const actor = this.options.actor();
    this.sentUserMessages.push(message);
    const promise = this.run("prompt", { text: userText(message), ...(actor ? { actor } : {}) });
    this.running = promise.catch(() => undefined);
    return promise;
  }

  /**
   * Resume after a DO restart: relay the run in flight from its start cursor
   * (the DO rebuilds the stream from a replay), or, with none, do nothing; the
   * runtime already finished or never took it.
   */
  async continue(): Promise<void> {
    const run = this.options.store.run();
    const agent = this.options.store.agent();
    this.sawAgentEnd = false;
    const accepted = run && agent
      ? await this.call(`/clients/${agent.id}/requests/${encodeURIComponent(run.requestId)}`, { token: agent.token })
          .then(() => true, (error) => {
            if (error instanceof RuntimeAgentError && error.status === 404) return false;
            throw error;
          })
      : false;
    if (!run || !agent || !accepted) {
      // The DO stopped before the runtime took the message.
      this.options.store.saveRun(null);
      await this.settle({ error: "This message did not reach the agent. Please send it again." });
      return;
    }
    this.state.isStreaming = true;
    const promise = this.relay(agent, run.requestId, run.cursor).finally(() => {
      this.options.store.saveRun(null);
      this.state.isStreaming = false;
      this.streamAbort = null;
    });
    this.running = promise.catch(() => undefined);
    return promise;
  }

  steer(message: AgentMessage): void {
    this.sentUserMessages.push(message);
    const actor = this.options.actor();
    void this.request("steer", { text: userText(message), ...(actor ? { actor } : {}) }).catch((error) => {
      console.error("[RuntimeAgentSession] steer failed", error);
    });
  }

  abort(): void {
    // The runtime ends the run (and cancels its tool calls); its agent_end and
    // response then arrive on the stream as usual.
    void this.request("abort", {}).catch((error) => {
      console.error("[RuntimeAgentSession] abort failed", error);
      this.streamAbort?.abort();
    });
  }

  async waitForIdle(): Promise<void> {
    await this.running;
  }

  /** Stop relaying without touching the runtime (DO teardown). */
  dispose(): void {
    this.streamAbort?.abort();
    this.listeners.clear();
  }
}
