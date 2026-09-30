/**
 * A thread that runs directly on the hosted agent runtime, in the browser
 * (plans/runtime-threads-direct.md §5.2). The runtime SDK's watcher reads the
 * agent itself (SSE, then long polls) with a browser token chiridion mints;
 * writes go through chiridion's routes (/api/threads/:id/{messages,inputs,stop,
 * preview}).
 *
 * Chat.tsx's machinery (send recovery, optimistic bubbles, question card,
 * preview panel) reads the thread through two seams: a `client` shaped like a
 * connection (`call(method)`), and a `chat` whose `messages` are the Pi
 * messages projected by pi-render. Agent state (pending question, todos,
 * errors, preview) is derived here and handed to Chat's `onStateUpdate`.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentMessage } from "@/lib/agent-messages";
import type { AssistantMessage } from "@/lib/agent-messages";
import type { Message, PreviewTarget } from "@/types";
import { localToolName, runtimeInputQuestions, type RuntimeInput } from "@/lib/agent-runtime-shared";
import { latestRuntimeTodos, piRender, type PiRenderMemo } from "@/lib/pi-render";
import { getPreviewTabId } from "@/components/preview-panel/preview-utils";
import { watchAgent, type AgentView, type Watcher } from "@camelai/run/watch";
import { stripSystemMessageTags } from "@/lib/turn-utils";
import { trackRuntimeViewMissedReply, trackRuntimeWatchError, trackRuntimeWatchLifecycle } from "@/lib/chat-sse-telemetry";
import { toast } from "sonner";

/** What the loader read server-side for first paint: a token, and the newest page of history. */
export interface RuntimeThreadSeed {
  agentId: string | null;
  token: string | null;
  expiresAt: number | null;
  url: string | null;
  page: { entries: Array<{ index: number; message: unknown }>; next: number | null } | null;
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
  /** The first message was refused before any agent ran (limits, credits, a ban): shown as a turn error. */
  startError?: { id: string; error: string } | null;
}

/** The slice of Chat.tsx's agent connection a runtime thread answers. */
export interface RuntimeThreadClient {
  readyState: number;
  readonly transport: "websocket" | "poll";
  send(data: string): void;
  reconnect(): void;
  call<T = unknown>(method: string, args?: unknown[], options?: { timeout?: number }): Promise<T>;
}

export interface RuntimeThreadChat {
  messages: Message[];
  status: "ready" | "submitted" | "streaming";
  isStreaming: boolean;
  isStallClamped: boolean;
  streamingMessageId: string | null;
}

export interface RuntimeThreadState {
  previewTabs: PreviewTarget[];
  previewActiveTabId: string | null;
  previewVersion: number;
  previewRefreshTabId: string | null;
  currentTodos: unknown[];
  contextUsedPercent: number | null;
  pendingQuestion: { questionId: string; questions: unknown[] } | null;
  connectionSetupPrompt: null;
  lastError: { id: string; error: string; billingSource: null; provider: null; status: null; errorType: null } | null;
  modelFallbackNotice?: { id: string; fromModel: string; toModel: string; reason: "hosted_credits_exhausted" | "hosted_subscription_unavailable"; createdAt: number } | null;
}

export interface RuntimeThreadCallbacks {
  onOpen(): void;
  onStateUpdate(state: RuntimeThreadState): void;
}

/** A connection's readyState while it takes calls (as a WebSocket's OPEN). */
export const CLIENT_OPEN = 1;
const OPEN = CLIENT_OPEN;
const CLOSED = 3;
/** How long a sent message counts as "submitted" without its run appearing on the stream. */
const SUBMITTED_WINDOW_MS = 60_000;
const RECONNECT_DELAY_MS = 1_000;
/** The longest pause before resending after sends keep failing (a runtime rollout, an outage). */
const MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * A watcher disconnected this long has stopped (a 403 or 404 ends it without
 * `expired`) or cannot get through: watch again. Its own reconnects take less.
 */
const WATCH_STALL_MS = 20_000;
/** A drop shorter than this is a routine reconnect, not worth showing. */
const RECONNECTING_NOTICE_MS = 3_000;
/** How long after a run ends its messages may take to reach the view before it counts as missed. */
const MISSED_REPLY_GRACE_MS = 3_000;

/** A hidden page's watcher pauses (the SDK closes its stream): not a stall, and nothing is missed. */
const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

// The watcher's messages are Pi's (the SDK declares its own structural copy
// of them); the view keeps Pi's types for pi-render.
type View = Pick<AgentView, "indexes" | "running" | "pendingInputs" | "lastOutcome" | "hasOlder"> & {
  messages: AgentMessage[];
  partial: AssistantMessage | null;
  progress: Map<string, unknown>;
};

function seedView(seed: RuntimeThreadSeed | null | undefined): View {
  const entries = [...(seed?.page?.entries ?? [])].sort((a, b) => a.index - b.index);
  return {
    messages: entries.map((entry) => entry.message as AgentMessage),
    indexes: entries.map((entry) => entry.index),
    partial: null,
    progress: new Map(),
    running: false,
    pendingInputs: [],
    lastOutcome: null,
    hasOlder: Boolean(seed?.page?.next),
  };
}

const maxIndex = (indexes: number[]) => (indexes.length > 0 ? indexes[indexes.length - 1] : -1);

function snapshot(state: AgentView): View {
  return {
    messages: [...state.messages] as AgentMessage[],
    indexes: [...state.indexes],
    partial: state.partial as AssistantMessage | null,
    progress: new Map(state.progress),
    running: state.running,
    pendingInputs: [...state.pendingInputs],
    lastOutcome: state.lastOutcome,
    hasOlder: state.hasOlder,
  };
}

function userText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

/** A user message's text as typed: without model-only context blocks or @-mention annotations. */
function comparableText(text: string): string {
  return stripSystemMessageTags(text).replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function postJson(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    // Always JSON: the routes refuse anything else (cross-site request forgery).
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

/**
 * A preview target a tool result opened, for results that arrive while the
 * page watches: set_preview's `target`, or the `preview` a tool that previews
 * what it made reports (run_notebook, deploy_project, …: `preview.target`).
 * The tool already saved it to the thread (thread_ui_state).
 */
function previewTargetOf(message: AgentMessage): PreviewTarget | null {
  const result = message as { role?: string; toolName?: string; details?: unknown; isError?: boolean };
  if (result.role !== "toolResult" || result.isError || !isRecord(result.details)) return null;
  const opened = localToolName(result.toolName) === "set_preview"
    ? result.details
    : isRecord(result.details.preview) && result.details.preview.success !== false ? result.details.preview : null;
  const target = opened?.target;
  return isRecord(target) && typeof target.kind === "string" ? target as unknown as PreviewTarget : null;
}

export function useRuntimeThread(options: {
  threadId: string | undefined;
  workspaceId: string | null | undefined;
  seed: RuntimeThreadSeed | null | undefined;
  enabled: boolean;
  callbacks: { current: RuntimeThreadCallbacks };
}): {
  client: RuntimeThreadClient;
  chat: RuntimeThreadChat;
  hasOlder: boolean;
  loadOlder(): Promise<boolean>;
  /** The watcher has been down a while and is being re-created. */
  reconnecting: boolean;
} {
  const { threadId, workspaceId, seed, enabled, callbacks } = options;
  const [view, setView] = useState<View>(() => seedView(seed));
  const [agentId, setAgentId] = useState<string | null>(seed?.agentId ?? null);
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  /** Bumped when this tab sends: the view places a starting turn after messages on their way. */
  const [sends, countSend] = useReducer((count: number) => count + 1, 0);
  /** Where the running run's first message goes (its turn_opened), until it ends. */
  const runStartRef = useRef<number | undefined>(undefined);
  const [preview, setPreview] = useState(() => ({
    tabs: seed?.previewTabs ?? [],
    activeTabId: seed?.activeTabId ?? null,
    version: 0,
    refreshTabId: null as string | null,
  }));
  const [fallbackNotice, setFallbackNotice] = useState<RuntimeThreadState["modelFallbackNotice"]>(null);
  const watcherRef = useRef<Watcher | null>(null);
  /** Messages this tab sent and has not seen come back, oldest first. */
  const sentRef = useRef<Array<{ clientMessageId: string; text: string; sentAt: number; afterIndex: number }>>([]);
  /** The client message id of each user message this tab matched to its send, by history index. */
  const [clientMessageIds, setClientMessageIds] = useState<ReadonlyMap<number, string>>(() => new Map());
  /** Indexes already on screen at load: their errors and preview results are history, not news. */
  const knownIndexesRef = useRef<Set<number> | null>(null);
  const cancelledInputsRef = useRef<Set<string>>(new Set());
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const base = threadId ? `/api/threads/${encodeURIComponent(threadId)}` : "";

  // The loader's seed can resolve after mount (deferred data): take it once.
  const seededRef = useRef(Boolean(seed));
  useEffect(() => {
    if (!seed || seededRef.current) return;
    seededRef.current = true;
    setView(seedView(seed));
    setAgentId((current) => current ?? seed.agentId);
    setPreview((current) => current.tabs.length > 0 ? current : { tabs: seed.previewTabs, activeTabId: seed.activeTabId, version: current.version + 1, refreshTabId: null });
  }, [seed]);

  const getToken = useCallback(async () => {
    const minted = await postJson(`${base}/token${query}`);
    if (!minted.ok) throw Object.assign(new Error(minted.data?.error ?? `token: HTTP ${minted.status}`), { status: minted.status });
    return minted.data as { token: string; expiresAt: number; url: string; agentId: string };
  }, [base, query]);

  // Watch the agent once it exists; its first send creates it.
  useEffect(() => {
    if (!enabled || !threadId || !agentId) return;
    let cancelled = false;
    let frame: number | null = null;
    let latest: AgentView | null = null;
    let restart: number | null = null;
    let stall: number | null = null;
    let notice: number | null = null;
    // Which watcher is current: a replaced one's late changes are ignored.
    let generation = 0;
    let restartDelay = RECONNECT_DELAY_MS;
    const flush = () => {
      frame = null;
      if (!cancelled && latest) setView(snapshot(latest));
    };
    const rewatch = () => {
      if (restart !== null || cancelled) return;
      restart = window.setTimeout(() => {
        restart = null;
        if (cancelled) return;
        start(true).then(() => { restartDelay = RECONNECT_DELAY_MS; }, (error) => {
          console.warn("[runtime-thread] could not watch the agent again", error);
          trackRuntimeWatchError(threadId, error, "rewatch");
          rewatch();
        });
      }, restartDelay);
      restartDelay = Math.min(restartDelay * 2, 30_000);
    };
    // A watcher down a while is watched again, unless the page is hidden
    // (its watcher waits for it to show, then catches up by itself).
    const armStall = () => {
      if (stall !== null || pageHidden()) return;
      notice ??= window.setTimeout(() => {
        notice = null;
        if (!cancelled) setReconnecting(true);
      }, RECONNECTING_NOTICE_MS);
      stall = window.setTimeout(() => {
        stall = null;
        if (cancelled) return;
        watcherRef.current?.close();
        rewatch();
      }, WATCH_STALL_MS);
    };
    const onVisibility = () => {
      if (pageHidden()) {
        if (stall !== null) window.clearTimeout(stall);
        if (notice !== null) window.clearTimeout(notice);
        stall = notice = null;
      } else if (latest && !latest.connected) {
        armStall();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const start = async (fresh = false) => {
      const initial = !fresh && seed?.token && seed.agentId === agentId && seed.url && (seed.expiresAt ?? 0) - Date.now() > 60_000
        ? { token: seed.token, expiresAt: seed.expiresAt ?? undefined, url: seed.url }
        : await getToken();
      if (cancelled) return;
      const mine = ++generation;
      let opened = false;
      watcherRef.current = watchAgent({
        url: initial.url,
        agentId,
        token: initial.token,
        expiresAt: initial.expiresAt ?? undefined,
        getToken,
        onEvent: (event: { type?: string; index?: unknown }) => {
          if (event?.type === "turn_opened" && typeof event.index === "number") runStartRef.current = event.index;
          else if (event?.type === "agent_end") runStartRef.current = undefined;
        },
        onChange: (state) => {
          if (mine !== generation) return;
          // The watcher stops when its token cannot be renewed: watch again
          // with a new one, backing off while the token route keeps failing.
          if (state.expired) {
            trackRuntimeWatchLifecycle(threadId, "expired", { transport: state.transport, agentId, generation: mine });
            if (stall !== null) window.clearTimeout(stall);
            stall = null;
            setReconnecting(true);
            watcherRef.current?.close();
            rewatch();
            return;
          }
          if (state.connected) {
            if (!opened) {
              opened = true;
              trackRuntimeWatchLifecycle(threadId, "open", { transport: state.transport, agentId, generation: mine });
            }
            if (stall !== null) window.clearTimeout(stall);
            stall = null;
            if (notice !== null) window.clearTimeout(notice);
            notice = null;
            setReconnecting(false);
          } else {
            armStall();
          }
          latest = state;
          // Deltas arrive per token: render at most once a frame.
          if (frame === null) frame = requestAnimationFrame(flush);
        },
        onError: (error) => {
          console.warn("[runtime-thread] watcher", error.message);
          trackRuntimeWatchError(threadId, error, "watch");
        },
      });
    };
    start().catch((error) => {
      console.error("[runtime-thread] could not watch the agent", error);
      trackRuntimeWatchError(threadId, error, "start");
      rewatch();
    });
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (frame !== null) cancelAnimationFrame(frame);
      if (restart !== null) window.clearTimeout(restart);
      if (stall !== null) window.clearTimeout(stall);
      if (notice !== null) window.clearTimeout(notice);
      watcherRef.current?.close();
      watcherRef.current = null;
    };
    // The seed is read once, when the watcher starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, threadId, agentId, getToken]);

  // Sends are HTTP: the thread is ready as soon as it mounts (after Chat has
  // installed this client, so a queued send flushes through it).
  useEffect(() => {
    if (!enabled || !threadId) return;
    const timer = window.setTimeout(() => callbacks.current.onOpen(), 0);
    return () => window.clearTimeout(timer);
  }, [enabled, threadId, callbacks]);

  // Match this tab's sends to the user messages they became, so optimistic
  // bubbles give way to them. The runtime echoes each message's `requestId`
  // (our client message id), which pi-render carries onto the message; only
  // messages recorded before it did are matched here, by the text the user
  // typed (without the model-only context and @-mention annotations the
  // model's copy carries), else as the first user message after the send.
  useEffect(() => {
    if (sentRef.current.length === 0) return;
    let changed = false;
    const next = new Map(clientMessageIds);
    const take = (index: number, at: number) => {
      const [sent] = sentRef.current.splice(at, 1);
      next.set(index, sent.clientMessageId);
      changed = true;
    };
    // Only messages that arrived after the oldest pending send can be it.
    const after = Math.min(...sentRef.current.map((sent) => sent.afterIndex));
    const unmatched = view.messages.flatMap((message, position) => {
      const index = view.indexes[position];
      return (message as { role?: string }).role === "user" && index > after && !next.has(index) ? [{ message, index }] : [];
    });
    const rest: typeof unmatched = [];
    for (const entry of unmatched) {
      const requestId = (entry.message as { requestId?: unknown }).requestId;
      if (typeof requestId === "string" && requestId) {
        // It names its own send (pi-render uses it); done with ours if it is one.
        const byId = sentRef.current.findIndex((sent) => sent.clientMessageId === requestId);
        if (byId >= 0) sentRef.current.splice(byId, 1);
        continue;
      }
      const text = comparableText(userText(entry.message));
      const byText = sentRef.current.findIndex((sent) => entry.index > sent.afterIndex && (text === sent.text || text.endsWith(sent.text)));
      if (byText >= 0) take(entry.index, byText);
      else rest.push(entry);
    }
    for (const entry of rest) {
      if (sentRef.current.length === 0) break;
      const at = (entry.message as { timestamp?: unknown }).timestamp;
      const oldest = sentRef.current[0];
      if (entry.index > oldest.afterIndex && typeof at === "number" && at >= oldest.sentAt - 2_000) take(entry.index, 0);
    }
    if (changed) setClientMessageIds(next);
  }, [view, clientMessageIds]);

  useEffect(() => {
    if (view.running || view.lastOutcome) setSubmittedAt(null);
  }, [view.running, view.lastOutcome]);

  const latestViewRef = useRef(view);
  latestViewRef.current = view;
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  /**
   * A run ended, or a send's submitted window ran out, and no message past
   * `knownMax` is on screen in a visible page: the watcher missed the end of
   * its stream. Diagnostic only (a hidden page's watcher pauses by design,
   * and catches up when the page shows).
   */
  const reportMissedReply = useCallback((reason: "run_ended" | "submitted_expired", knownMax: number) => {
    const shown = latestViewRef.current;
    if (!threadId || pageHidden() || maxIndex(shown.indexes) > knownMax || shown.running) return;
    const watcher = watcherRef.current;
    trackRuntimeViewMissedReply(threadId, {
      reason,
      agentId: agentIdRef.current,
      knownMaxIndex: knownMax,
      viewMaxIndex: maxIndex(shown.indexes),
      connected: watcher?.state.connected ?? false,
      transport: watcher?.state.transport ?? null,
    });
  }, [threadId]);

  // The newest index on screen when a run starts: a run adds at least its
  // prompt, so one that ends without passing it is a missed reply.
  const runFromRef = useRef<number | null>(null);
  useEffect(() => {
    if (view.running) {
      runFromRef.current ??= maxIndex(latestViewRef.current.indexes);
      return;
    }
    const from = runFromRef.current;
    if (from === null) return;
    runFromRef.current = null;
    const timer = window.setTimeout(() => reportMissedReply("run_ended", from), MISSED_REPLY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [view.running, reportMissedReply]);
  useEffect(() => {
    if (submittedAt === null) return;
    // What was on screen when the message went: its run adds past it.
    const from = maxIndex(latestViewRef.current.indexes);
    const timer = window.setTimeout(() => {
      setSubmittedAt(null);
      reportMissedReply("submitted_expired", from);
    }, SUBMITTED_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [submittedAt, reportMissedReply]);

  // A set_preview the agent runs while the page watches opens its tab.
  useEffect(() => {
    if (knownIndexesRef.current === null) {
      if (view.messages.length === 0 && !seed) return;
      knownIndexesRef.current = new Set(view.indexes);
      return;
    }
    const known = knownIndexesRef.current;
    let opened: PreviewTarget | null = null;
    view.messages.forEach((message, position) => {
      const index = view.indexes[position];
      if (known.has(index)) return;
      known.add(index);
      opened = previewTargetOf(message) ?? opened;
    });
    if (!opened) return;
    const target: PreviewTarget = opened;
    const id = getPreviewTabId(target);
    setPreview((current) => {
      const tabs = current.tabs.some((tab) => getPreviewTabId(tab) === id)
        ? current.tabs.map((tab) => (getPreviewTabId(tab) === id ? target : tab))
        : [...current.tabs, target];
      return { tabs, activeTabId: id, version: current.version + 1, refreshTabId: current.activeTabId === id ? id : null };
    });
  }, [view, seed]);

  // Rows that did not change keep their objects between events (see PiRenderMemo).
  const renderMemoRef = useRef<PiRenderMemo>(new Map());
  // When a run ends, take the preview the thread saved: tools called from
  // js_exec (a deploy in code) open their tab server-side only.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    const ended = wasRunningRef.current && !view.running;
    wasRunningRef.current = view.running;
    if (!ended || !enabled || !base) return;
    let cancelled = false;
    fetch(`${base}/preview${query}`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() as Promise<{ preview?: { tabs?: unknown; activeTabId?: unknown } | null }> : null))
      .then((saved) => {
        if (cancelled || !saved?.preview) return;
        const tabs = Array.isArray(saved.preview.tabs) ? saved.preview.tabs as PreviewTarget[] : [];
        const activeTabId = typeof saved.preview.activeTabId === "string" ? saved.preview.activeTabId : null;
        setPreview((current) => (
          JSON.stringify([current.tabs, current.activeTabId]) === JSON.stringify([tabs, activeTabId])
            ? current
            : { tabs, activeTabId, version: current.version + 1, refreshTabId: activeTabId }
        ));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [view.running, enabled, base, query]);

  const rendered = useMemo(() => {
    const echoed = new Set<string>(clientMessageIds.values());
    for (const message of view.messages) {
      const requestId = (message as { requestId?: unknown }).requestId;
      if (typeof requestId === "string") echoed.add(requestId);
    }
    return piRender({
      threadId: threadId ?? "",
      messages: view.messages,
      indexes: view.indexes,
      partial: view.partial,
      progress: view.progress,
      running: view.running,
      clientMessageIds,
      pendingSends: sentRef.current.filter((sent) => !echoed.has(sent.clientMessageId)).length,
      runStartIndex: view.running ? runStartRef.current : undefined,
    }, renderMemoRef.current);
    // `sends` changes when sentRef does.
  }, [threadId, view, clientMessageIds, sends]);

  // Inputs the chat cannot ask (forms with fields) are cancelled, as the DO did, so the turn goes on.
  useEffect(() => {
    if (!enabled) return;
    for (const input of view.pendingInputs as RuntimeInput[]) {
      if (runtimeInputQuestions(input) || cancelledInputsRef.current.has(input.id)) continue;
      cancelledInputsRef.current.add(input.id);
      void postJson(`${base}/inputs/${encodeURIComponent(input.id)}${query}`, { action: "cancel" });
    }
  }, [enabled, view.pendingInputs, base, query]);

  // The agent state Chat.tsx's panels read, derived from the transcript and the stream.
  const agentState = useMemo<RuntimeThreadState>(() => {
    const question = (view.pendingInputs as RuntimeInput[])
      .map((input) => ({ input, card: runtimeInputQuestions(input) }))
      .find((entry) => entry.card);
    const known = knownIndexesRef.current;
    let lastError: RuntimeThreadState["lastError"] = null;
    for (let position = view.messages.length - 1; position >= 0; position--) {
      const message = view.messages[position] as { role?: string; stopReason?: string; errorMessage?: string };
      if (message.role === "user") break;
      if (message.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
        const index = view.indexes[position];
        if (!known || known.has(index)) break;
        lastError = { id: `rt-error:${index}`, error: message.errorMessage, billingSource: null, provider: null, status: null, errorType: null };
        break;
      }
    }
    if (!lastError && view.lastOutcome?.error) {
      lastError = { id: `rt-outcome:${view.lastOutcome.id}`, error: view.lastOutcome.error, billingSource: null, provider: null, status: null, errorType: null };
    }
    // The refusal of the thread's first message, while nothing reached the agent after it.
    if (!lastError && seed?.startError) {
      lastError = { id: seed.startError.id, error: seed.startError.error, billingSource: null, provider: null, status: null, errorType: null };
    }
    return {
      previewTabs: preview.tabs,
      previewActiveTabId: preview.activeTabId,
      previewVersion: preview.version,
      previewRefreshTabId: preview.refreshTabId,
      currentTodos: latestRuntimeTodos(view.messages) ?? [],
      contextUsedPercent: null,
      pendingQuestion: question ? { questionId: question.input.id, questions: question.card!.questions } : null,
      connectionSetupPrompt: null,
      lastError,
      modelFallbackNotice: fallbackNotice ?? null,
    };
  }, [view, preview, fallbackNotice, seed]);

  // Deltas re-derive the state every frame; hand it on only when it changed.
  const lastStateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = JSON.stringify(agentState);
    if (key === lastStateRef.current) return;
    lastStateRef.current = key;
    callbacks.current.onStateUpdate(agentState);
  }, [enabled, agentState, callbacks]);

  const viewRef = useRef(view);
  viewRef.current = view;
  /** Sends that failed in a row, and the pending reopen after them (see `reconnect`). */
  const sendFailuresRef = useRef(0);
  const reopenRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (reopenRef.current !== null) window.clearTimeout(reopenRef.current);
  }, []);
  const call = useCallback(async (method: string, args: unknown[] = []): Promise<any> => {
    if (!base) throw new Error("No thread");
    switch (method) {
      case "sendMessage": {
        const [text, clientMessageId] = args as [string, string];
        // A retry of the same message keeps its one entry.
        if (!sentRef.current.some((entry) => entry.clientMessageId === clientMessageId)) {
          const known = viewRef.current.indexes;
          sentRef.current.push({
            clientMessageId,
            text: comparableText(text),
            sentAt: Date.now(),
            afterIndex: known.length > 0 ? known[known.length - 1] : -1,
          });
          countSend();
        }
        const sent = await postJson(`${base}/messages${query}`, { text, clientMessageId });
        // The runtime or the network failed: a transport failure to Chat, which
        // resends under the same id (the runtime deduplicates it) after `reconnect`'s pause.
        if (sent.status >= 500 || !isRecord(sent.data)) {
          sendFailuresRef.current++;
          throw new Error(isRecord(sent.data) && typeof sent.data.error === "string" ? sent.data.error : `HTTP ${sent.status}`);
        }
        sendFailuresRef.current = 0;
        const result = sent.data;
        if (result.status === "accepted") {
          setSubmittedAt(Date.now());
          if (typeof result.agentId === "string") setAgentId((current) => current ?? (result.agentId as string));
          const fallback = result.fallback as { fromModel: string; toModel: string; reason: "hosted_credits_exhausted" | "hosted_subscription_unavailable" } | null;
          if (fallback) setFallbackNotice({ id: `rt-fallback:${clientMessageId}`, ...fallback, createdAt: Date.now() });
        } else {
          sentRef.current = sentRef.current.filter((entry) => entry.clientMessageId !== clientMessageId);
        }
        return result;
      }
      case "requestStop":
        await postJson(`${base}/stop${query}`);
        return undefined;
      case "answerQuestion": {
        const [questionId, answers] = args as [string, Record<string, unknown>];
        const input = (viewRef.current.pendingInputs as RuntimeInput[]).find((entry) => entry.id === questionId);
        const card = input ? runtimeInputQuestions(input) : null;
        if (!card) return undefined;
        const answered = await postJson(`${base}/inputs/${encodeURIComponent(questionId)}${query}`, card.answer(answers));
        // Only the turn's actor (or the input's audience) may answer: say so.
        if (!answered.ok) {
          toast.error(answered.status === 403
            ? "Only the person who started this turn can answer this question."
            : typeof answered.data?.error === "string" ? answered.data.error : "Could not send your answer.");
        }
        return undefined;
      }
      case "setPreviewTabsState": {
        const [tabs, activeTabId] = args as [PreviewTarget[], string | null];
        setPreview((current) => ({ tabs, activeTabId, version: current.version + 1, refreshTabId: null }));
        await fetch(`${base}/preview${query}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tabs, activeTabId }),
        }).catch(() => undefined);
        return undefined;
      }
      // The next send configures the agent with the thread's model.
      case "refreshModel":
        return undefined;
      default:
        throw new Error(`${method} is not available on runtime threads`);
    }
  }, [base, query]);

  const client = useMemo<RuntimeThreadClient>(() => ({
    readyState: enabled ? OPEN : CLOSED,
    transport: "poll",
    send: () => {},
    // A send whose response was lost: open again after a pause, which resends
    // Chat's queued messages under the same ids (the runtime deduplicates them).
    // One reopen at a time, however many failures ask for it, and a longer pause
    // for each send that failed in a row: otherwise every failed resend adds a loop.
    reconnect: () => {
      if (reopenRef.current !== null) return;
      const delay = Math.min(RECONNECT_DELAY_MS * 2 ** sendFailuresRef.current, MAX_RECONNECT_DELAY_MS);
      reopenRef.current = window.setTimeout(() => {
        reopenRef.current = null;
        callbacks.current.onOpen();
      }, delay);
    },
    call: call as RuntimeThreadClient["call"],
  }), [enabled, call, callbacks]);

  const streaming = view.running || view.partial !== null;
  const chat = useMemo<RuntimeThreadChat>(() => ({
    messages: rendered.messages,
    // Streaming once a turn row streams; before its first token the run (or
    // this tab's send) is submitted.
    status: rendered.streamingMessageId !== null ? "streaming" : streaming || submittedAt !== null ? "submitted" : "ready",
    isStreaming: streaming,
    isStallClamped: false,
    streamingMessageId: rendered.streamingMessageId,
  }), [rendered, streaming, submittedAt]);

  const loadOlder = useCallback(async () => {
    const watcher = watcherRef.current;
    if (!watcher) return false;
    return await watcher.loadOlder();
  }, []);

  return { client, chat, hasOlder: view.hasOlder, loadOlder, reconnecting };
}
