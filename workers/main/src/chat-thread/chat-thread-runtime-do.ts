import { DurableObject } from "cloudflare:workers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { getAppUrl } from "../../../../src/lib/app-url";
import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import type { LlmModel } from "../../../../src/types";
import { boundedCanonicalJson } from "./bounded-canonical-json";
import {
  createBoundedTurnRunner,
  type BoundedToolCall,
  type BoundedTurnAdapter,
} from "./bounded-turn-runner";
import {
  ChatRuntimeController,
  type ChatRuntimeControlAction,
  type TrustedChatRuntimeScope,
} from "./chat-runtime-controller";
import { DurableTurnDriver } from "./durable-turn-driver";
import {
  DurableChatTurnStore,
  type SettledChatTurn,
} from "./durable-turn-store";
import { LegacySessionMigrator } from "./legacy-session-migration";
import { getPreviewTabId, normalizePreviewTarget } from "./preview-state";
import { CHAT_RUNTIME_MODEL_KEY } from "./runtime-metadata";
import type {
  AdminExplorerThreadSummary,
  AgentEvalDeployedApp,
  AgentEvalParsedMessage,
  AgentEvalSessionRequest,
  AgentEvalSessionResult,
  ChannelHistoryEventRequest,
  ChannelHistoryEventResult,
  ChatContextState,
  ChatEnv,
  ChatThreadForkState,
  ChatThreadForkStateTarget,
  ChatThreadPiCoreForkResult,
  ChatThreadRuntimeStatus,
  InitialUserMessageRequest,
  InitialUserMessageResult,
  PreviewTarget,
} from "./types";
import type { ConnectionSetupResponse } from "../chat-thread-browser-prompts";

/** Stable, deliberately small compatibility state shared with the Pi adapter. */
export const CHAT_RUNTIME_KV_KEYS = Object.freeze({
  context: "chatContext",
  previewTabs: "previewTabs",
  previewActiveTabId: "previewActiveTabId",
  previewTarget: "previewTarget",
  previewVersion: "previewVersion",
  todos: "chatTodos",
  title: "chatRuntimeTitleV2",
  model: CHAT_RUNTIME_MODEL_KEY,
  channelHistory: "chatRuntimeChannelHistoryV2",
  connectionResponse: "chatRuntimeConnectionResponseV2",
  questionAnswer: "chatRuntimeQuestionAnswerV2",
  forkSeed: "chatRuntimeForkSeedV2",
  evalRun: "chatRuntimeEvalRunV2",
  evalEvents: "chatRuntimeEvalEventsV2",
});

export interface StoredChannelHistoryMessage {
  id: string;
  source: string;
  modelContent: string;
  displayContent: string;
  createdAt: number;
}

interface PreviewState {
  target: PreviewTarget | null;
  tabs: PreviewTarget[];
  activeTabId: string | null;
  version: number;
}

interface VisibleMessage {
  id: string;
  role: "user" | "assistant";
  content: unknown;
  status: string;
  createdAt: number;
}

interface StoredEvalRun {
  turnId: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const validId = (value: string) =>
  Boolean(value) && value.length <= CHAT_RUNTIME_BOUNDS.identifierChars;

function boundText(
  value: string,
  limit = CHAT_RUNTIME_BOUNDS.requestBytes,
): string {
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= limit) return value;
  return decoder.decode(encoded.slice(0, limit)).replace(/\uFFFD+$/, "");
}

function cloneJson<T>(
  value: T,
  limit = CHAT_RUNTIME_BOUNDS.snapshotBytes,
): T | null {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || bytes(serialized) > limit)
      return null;
    return JSON.parse(serialized) as T;
  } catch {
    return null;
  }
}

/** Keeps the newest JSON-safe entries within both the shared count and byte caps. */
function boundedList<T>(input: readonly T[]): T[] {
  const result: T[] = [];
  let used = 2;
  for (const value of input.slice(-CHAT_RUNTIME_BOUNDS.snapshotMessages)) {
    const copy = cloneJson(value);
    if (copy === null) continue;
    const size = bytes(JSON.stringify(copy)) + (result.length ? 1 : 0);
    if (used + size > CHAT_RUNTIME_BOUNDS.snapshotBytes) continue;
    result.push(copy);
    used += size;
  }
  return result;
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function stableTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function safeText(
  value: unknown,
  limit = CHAT_RUNTIME_BOUNDS.requestBytes,
): string {
  if (typeof value === "string") return boundText(value, limit);
  try {
    return boundText(JSON.stringify(value) ?? "", limit);
  } catch {
    return boundText(String(value), limit);
  }
}

function displayText(content: unknown): string {
  if (typeof content === "string") return boundText(content);
  if (!Array.isArray(content)) return safeText(content);
  return boundText(
    content
      .flatMap((part) => {
        const item = recordOf(part);
        if (!item) return [];
        if (typeof item.text === "string") return [item.text];
        if (typeof item.thinking === "string") return [item.thinking];
        if (item.type === "tool_use" && typeof item.name === "string") {
          return [`[${item.name}]`];
        }
        if (item.type === "tool_result") return [safeText(item.content)];
        return [];
      })
      .filter(Boolean)
      .join("\n"),
    CHAT_RUNTIME_BOUNDS.assistantBytes,
  );
}

function forkMessageIds(message: AgentMessage, index: number): string[] {
  const item = recordOf(message)!;
  const timestamp = stableTime(item.timestamp);
  const ids = [
    item.role === "user" ? `pi_user_${timestamp}_${index}` : "",
    item.role === "assistant"
      ? (typeof item.responseId === "string" && item.responseId.trim()) ||
        `pi_assistant_${timestamp}_${index}`
      : "",
    typeof item.id === "string" ? item.id.trim() : "",
    typeof recordOf(item.uiMetadata)?.renderMessageId === "string"
      ? String(recordOf(item.uiMetadata)!.renderMessageId).trim()
      : "",
  ];
  return [...new Set(ids.filter(validId))];
}

function parsedHistory(
  messages: readonly AgentMessage[],
  threadId: string,
): AgentEvalParsedMessage[] {
  const parsed: AgentEvalParsedMessage[] = [];
  for (const [index, message] of messages.entries()) {
    const item = recordOf(message);
    if (!item || item.visibility === "hidden") continue;
    const createdAt = stableTime(item.timestamp);
    const fallback = `pi_${item.role}_${createdAt}_${index}`;
    const id = [item.responseId, item.id].find(
      (value) => typeof value === "string" && validId(value.trim()),
    );
    if (item.role === "user") {
      const blocks = Array.isArray(item.content)
        ? item.content.flatMap((part): Array<Record<string, unknown>> => {
            const block = recordOf(part);
            return block?.type === "text" && typeof block.text === "string"
              ? [{ type: "text", text: boundText(block.text) }]
              : [];
          })
        : null;
      parsed.push({
        id: typeof id === "string" ? id.trim() : fallback,
        thread_id: threadId,
        role: "user",
        content:
          typeof item.content === "string"
            ? boundText(item.content)
            : blocks?.length
              ? blocks
              : "",
        created_at: createdAt,
        forkEntryId: typeof id === "string" ? id.trim() : fallback,
      });
      continue;
    }
    if (item.role === "assistant") {
      const content = Array.isArray(item.content)
        ? item.content.flatMap((part): Array<Record<string, unknown>> => {
            const block = recordOf(part);
            if (block?.type === "text" && typeof block.text === "string") {
              return [
                {
                  type: "text",
                  text: boundText(
                    block.text,
                    CHAT_RUNTIME_BOUNDS.assistantBytes,
                  ),
                },
              ];
            }
            if (
              block?.type === "thinking" &&
              typeof block.thinking === "string"
            ) {
              return [
                { type: "thinking", thinking: boundText(block.thinking) },
              ];
            }
            if (
              block?.type === "toolCall" &&
              typeof block.id === "string" &&
              typeof block.name === "string"
            ) {
              return [
                {
                  type: "tool_use",
                  id: boundText(block.id, CHAT_RUNTIME_BOUNDS.identifierChars),
                  name: boundText(
                    block.name,
                    CHAT_RUNTIME_BOUNDS.identifierChars,
                  ),
                  input:
                    cloneJson(
                      block.arguments,
                      CHAT_RUNTIME_BOUNDS.toolInputBytes,
                    ) ?? {},
                },
              ];
            }
            return [];
          })
        : [];
      if (!content.length && typeof item.errorMessage === "string") {
        content.push({
          type: "error",
          title: "Assistant error",
          error: boundText(
            item.errorMessage,
            CHAT_RUNTIME_BOUNDS.assistantBytes,
          ),
        });
      }
      if (!content.length) continue;
      const assistantId = typeof id === "string" ? id.trim() : fallback;
      parsed.push({
        id: assistantId,
        thread_id: threadId,
        role: "assistant",
        content,
        created_at: createdAt,
        forkEntryId: assistantId,
      });
      continue;
    }
    if (item.role !== "toolResult" || typeof item.toolCallId !== "string")
      continue;
    const result = {
      type: "tool_result",
      tool_use_id: boundText(
        item.toolCallId,
        CHAT_RUNTIME_BOUNDS.identifierChars,
      ),
      content: displayText(item.content),
      is_error: item.isError === true,
      status: item.isError === true ? "failed" : "succeeded",
      itemId: boundText(item.toolCallId, CHAT_RUNTIME_BOUNDS.identifierChars),
      itemKind:
        String(item.toolName).toLowerCase() === "bash"
          ? "commandExecution"
          : "dynamicToolCall",
    };
    for (let target = parsed.length - 1; target >= 0; target -= 1) {
      if (parsed[target].role !== "assistant") continue;
      const content = Array.isArray(parsed[target].content)
        ? [...(parsed[target].content as unknown[])]
        : [];
      const call = content.findIndex(
        (part) =>
          recordOf(part)?.type === "tool_use" &&
          recordOf(part)?.id === item.toolCallId,
      );
      content.splice(call < 0 ? content.length : call + 1, 0, result);
      parsed[target] = { ...parsed[target], content };
      break;
    }
  }
  return boundedList(parsed);
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Operation timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Framework-free chat ownership. Construction performs no storage or network
 * work; HTTP, storage, runner, and alarm collaborators are all lazy.
 */
export class ChatThreadRuntimeDO extends DurableObject<ChatEnv> {
  private storeInstance: DurableChatTurnStore | null = null;
  private controllerInstance: ChatRuntimeController | null = null;
  private driverInstance: DurableTurnDriver | null = null;
  private migratorInstance: LegacySessionMigrator | null = null;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
  }

  protected createStore(): DurableChatTurnStore {
    return new DurableChatTurnStore(this.ctx.storage);
  }

  protected createDriver(): DurableTurnDriver {
    return new DurableTurnDriver({
      ctx: this.ctx,
      store: this.store,
      migrator: this.migrator,
      run: async (context) => {
        const { createPiTurnAdapter } = await import("./pi-turn-adapter");
        return createBoundedTurnRunner(
          this.captureEvalTools(
            createPiTurnAdapter({
              ctx: this.ctx,
              env: this.env,
              store: this.store,
            }),
          ),
        )(context);
      },
      publish: () => this.controller.publish(),
      publishLive: (update) => this.controller.publishLive(update),
      clearLive: (turnId, epoch) => this.controller.clearLive(turnId, epoch),
    });
  }

  protected createController(): ChatRuntimeController {
    return new ChatRuntimeController(
      this.ctx,
      () => this.store,
      (request) => this.trustedScope(request),
      {
        kick: () => this.driver.kick(),
        control: (action, payload) => this.control(action, payload),
        coarseState: () => this.coarseState(),
      },
    );
  }

  protected get store(): DurableChatTurnStore {
    return (this.storeInstance ??= this.createStore());
  }

  private get controller(): ChatRuntimeController {
    return (this.controllerInstance ??= this.createController());
  }

  private get driver(): DurableTurnDriver {
    return (this.driverInstance ??= this.createDriver());
  }

  private get migrator(): LegacySessionMigrator {
    return (this.migratorInstance ??= new LegacySessionMigrator(
      this.ctx.storage,
    ));
  }

  private publish(): void {
    this.ctx.waitUntil(
      this.controller
        .publish()
        .catch((error) =>
          console.error("[ChatThreadRuntimeDO] publish failed", error),
        ),
    );
  }

  private appendEvalEvent(
    turnId: string,
    event: Record<string, unknown>,
  ): void {
    const run = this.ctx.storage.kv.get<StoredEvalRun>(
      CHAT_RUNTIME_KV_KEYS.evalRun,
    );
    if (run?.turnId !== turnId) return;
    const copy = cloneJson(event, CHAT_RUNTIME_BOUNDS.outboxEventBytes);
    if (!copy) return;
    const events =
      this.ctx.storage.kv.get<Array<Record<string, unknown>>>(
        CHAT_RUNTIME_KV_KEYS.evalEvents,
      ) ?? [];
    this.ctx.storage.kv.put(
      CHAT_RUNTIME_KV_KEYS.evalEvents,
      boundedList([...events, copy]),
    );
  }

  private captureEvalTools(adapter: BoundedTurnAdapter): BoundedTurnAdapter {
    let turnId = "";
    const record = (
      call: BoundedToolCall,
      status: "completed" | "failed",
      result: unknown,
    ) => {
      try {
        const run = this.ctx.storage.kv.get<StoredEvalRun>(
          CHAT_RUNTIME_KV_KEYS.evalRun,
        );
        if (!turnId || run?.turnId !== turnId) return;
        const childBytes = Math.floor(CHAT_RUNTIME_BOUNDS.outboxEventBytes / 3);
        this.appendEvalEvent(turnId, {
          type: "runtime_event",
          event: {
            method: "item/completed",
            params: {
              item: {
                id: `v2:${crypto.randomUUID()}`,
                type: "dynamicToolCall",
                tool: call.name,
                status,
                isError: status === "failed",
                arguments: JSON.parse(
                  boundedCanonicalJson(call.input, childBytes),
                ),
                result: JSON.parse(boundedCanonicalJson(result, childBytes)),
              },
            },
          },
        });
      } catch (error) {
        // Eval telemetry is observational and may never change tool semantics.
        console.error("[ChatRuntime] eval tool recording failed", error);
      }
    };
    return {
      readContext: (turn, limits, signal) =>
        adapter.readContext(turn, limits, signal),
      callProvider: async (input) => {
        turnId = input.turn.id;
        return adapter.callProvider(input);
      },
      callTool: async (call, signal) => {
        try {
          const result = await adapter.callTool(call, signal);
          record(call, "completed", result);
          return result;
        } catch (error) {
          record(
            call,
            "failed",
            error instanceof Error ? error.message : error,
          );
          throw error;
        }
      },
      ...(adapter.overflowToolResult
        ? {
            overflowToolResult: (call, value, signal) =>
              adapter.overflowToolResult!(call, value, signal),
          }
        : {}),
    };
  }

  fetch(request: Request): Promise<Response> {
    return this.controller.fetch(request);
  }

  alarm(): Promise<void> {
    return this.driver.alarm();
  }

  private context(): ChatContextState | null {
    const value = this.ctx.storage.kv.get<ChatContextState>(
      CHAT_RUNTIME_KV_KEYS.context,
    );
    if (
      !value ||
      ![value.threadId, value.workspaceId, value.orgId].every(validId)
    ) {
      return null;
    }
    return {
      ...value,
      userId: value.userId && validId(value.userId) ? value.userId : null,
      userName:
        typeof value.userName === "string" ? boundText(value.userName) : null,
      userEmail:
        typeof value.userEmail === "string" ? boundText(value.userEmail) : null,
    };
  }

  private bindContext(input: Partial<ChatContextState>): string | null {
    const current = this.context();
    const threadId = input.threadId?.trim() || current?.threadId || "";
    const workspaceId = input.workspaceId?.trim() || current?.workspaceId || "";
    const orgId = input.orgId?.trim() || current?.orgId || "";
    if (![threadId, workspaceId, orgId].every(validId))
      return "Missing or invalid chat scope";
    if (
      current &&
      (current.threadId !== threadId ||
        current.workspaceId !== workspaceId ||
        current.orgId !== orgId)
    ) {
      return "Chat scope does not match this thread";
    }
    const next: ChatContextState = {
      threadId,
      workspaceId,
      orgId,
      userId: input.userId?.trim() || current?.userId || null,
      userName: input.userName
        ? boundText(input.userName.trim())
        : (current?.userName ?? null),
      userEmail: input.userEmail
        ? boundText(input.userEmail.trim())
        : (current?.userEmail ?? null),
    };
    if (next.userId && !validId(next.userId)) return "Invalid user id";
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.context, next);
    return null;
  }

  private trustedScope(request: Request): TrustedChatRuntimeScope {
    const url = new URL(request.url);
    const query = {
      threadId: url.searchParams.get("threadId")?.trim() || "",
      workspaceId: url.searchParams.get("workspaceId")?.trim() || "",
      orgId: url.searchParams.get("orgId")?.trim() || "",
    };
    // The outer Worker overwrites these parameters after authorization. Keep
    // the ordinary SSE handshake completely independent of DO storage.
    if (Object.values(query).every(validId)) {
      return {
        ...query,
        userId: request.headers.get("X-Chiridion-User-Id")?.trim() || null,
      };
    }

    // Degraded authorization deliberately omits query scope. It may use only
    // previously bound durable identity, never client-controlled parameters.
    let context = this.context();
    if (!context) {
      const durable = this.store.scope();
      if (durable) {
        const error = this.bindContext(durable);
        if (error) throw new Error(error);
        context = this.context();
      }
    }
    if (!context) throw new Error("Missing trusted chat runtime scope");
    return {
      threadId: context.threadId,
      workspaceId: context.workspaceId,
      orgId: context.orgId,
      userId: request.headers.get("X-Chiridion-User-Id")?.trim() || null,
    };
  }

  async startInitialUserMessage(
    body: InitialUserMessageRequest,
  ): Promise<InitialUserMessageResult> {
    const contextError = this.bindContext(body);
    if (contextError) return { status: "error", error: contextError };
    try {
      this.adoptForkSeed();
    } catch (error) {
      return {
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Could not import fork history",
      };
    }
    const context = this.context()!;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return { status: "error", error: "Missing message" };
    const clientMessageId = body.clientMessageId?.trim() || crypto.randomUUID();
    const source = body.messageSource?.trim() || "web";
    if (!validId(clientMessageId) || !validId(source)) {
      return { status: "error", error: "Invalid message id or source" };
    }
    const now = Date.now();
    try {
      await withTimeout(
        this.ctx.storage.setAlarm(now),
        CHAT_RUNTIME_BOUNDS.alarmWriteMs,
      );
    } catch {
      return { status: "error", error: "Could not schedule turn" };
    }
    const result = this.store.admit(
      {
        id: clientMessageId,
        clientMessageId,
        threadId: context.threadId,
        workspaceId: context.workspaceId,
        orgId: context.orgId,
        userId: body.userId?.trim() || context.userId,
        source,
        userContent: message,
        userDisplay: message,
      },
      now,
    );
    if (!result.ok) {
      return result.reason === "queue_full" ||
        result.reason === "queue_bytes" ||
        result.reason === "busy"
        ? { status: "busy", error: "Thread is busy with queued work" }
        : { status: "error", error: `Message rejected: ${result.reason}` };
    }
    this.publish();
    return { status: "accepted" };
  }

  getRuntimeStatus(): ChatThreadRuntimeStatus {
    const snapshot = this.store.latestSnapshot();
    const latest = snapshot.messages.at(-1);
    return {
      isStreaming: snapshot.shouldArmAlarm,
      pendingQuestionCount: 0,
      oldestPendingQuestion: null,
      updatedAt: latest?.createdAt ?? null,
    };
  }

  getActiveTurnUserId(): string | null {
    return this.store.activeTurn()?.userId ?? null;
  }

  getAdminExplorerSummary(input?: {
    userMessageCap?: number;
  }): AdminExplorerThreadSummary {
    const aggregate = this.store.sql
      .exec<{
        user_count: number;
        error_count: number;
        last_error_at: number | null;
      }>(
        `SELECT COUNT(*) AS user_count,
      COALESCE(SUM(CASE WHEN status IN ('failed','interrupted') THEN 1 ELSE 0 END), 0) AS error_count,
      MAX(CASE WHEN status IN ('failed','interrupted') THEN updated_at END) AS last_error_at
      FROM chat_turns_v2`,
      )
      .one();
    const lastError =
      this.store.sql
        .exec<{ message: string | null }>(
          `SELECT COALESCE(assistant_error, '') AS message FROM chat_turns_v2
       WHERE status IN ('failed','interrupted')
       ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
        )
        .toArray()[0]?.message ?? null;
    const total = Number(aggregate.user_count);
    const requestedCap = Number(input?.userMessageCap);
    const cap = Number.isFinite(requestedCap)
      ? Math.max(0, Math.floor(requestedCap))
      : CHAT_RUNTIME_BOUNDS.historyTurns;
    const model = this.ctx.storage.kv.get<string>(CHAT_RUNTIME_KV_KEYS.model);
    const errorCount = Number(aggregate.error_count);
    return {
      userMessageCount: Math.min(total, cap),
      userMessageCountCapped: total > cap,
      hasError: errorCount > 0,
      errorCount,
      lastErrorAt:
        aggregate.last_error_at === null
          ? null
          : Number(aggregate.last_error_at),
      lastErrorMessage: lastError ? boundText(lastError) : null,
      models: model ? [model] : [],
    };
  }

  /** Optional presentation work must never gate a chat turn. */
  async generateChatGroupAvatarForThread(
    _context: Partial<ChatContextState>,
  ): Promise<void> {}

  /** Interactive waits are intentionally outside the one-attempt runtime. */
  async askUserQuestion(_input: unknown): Promise<never> {
    throw new Error("Interactive questions are unavailable in bounded turns");
  }

  async promptConnectionSetup(_input: unknown): Promise<never> {
    throw new Error(
      "Interactive connection setup is unavailable in bounded turns",
    );
  }

  async runCodeModeSubagent(_name: string, _input: unknown): Promise<never> {
    throw new Error("Nested agents are unavailable in bounded turns");
  }

  async streamToolProgress(_toolUseId: string, _delta: string): Promise<void> {}
  async recordVerifiedWorkEvidence(_input: unknown): Promise<void> {}
  async recordProjectActivity(_input: unknown): Promise<void> {}
  async recordCodeModeArtifact(
    _toolUseId: string,
    _input: unknown,
  ): Promise<void> {}

  private previewState(): PreviewState {
    let tabs = boundedList(
      this.ctx.storage.kv.get<PreviewTarget[]>(
        CHAT_RUNTIME_KV_KEYS.previewTabs,
      ) ?? [],
    ).flatMap((target) => {
      const normalized = normalizePreviewTarget(target);
      return normalized ? [normalized] : [];
    });
    if (!tabs.length) {
      const legacy = normalizePreviewTarget(
        this.ctx.storage.kv.get<PreviewTarget>(
          CHAT_RUNTIME_KV_KEYS.previewTarget,
        ),
      );
      if (legacy) tabs = [legacy];
    }
    const active = this.ctx.storage.kv.get<string | null>(
      CHAT_RUNTIME_KV_KEYS.previewActiveTabId,
    );
    const activeTabId =
      typeof active === "string" &&
      tabs.some((tab) => getPreviewTabId(tab) === active)
        ? active
        : tabs[0]
          ? getPreviewTabId(tabs[0])
          : null;
    const storedVersion = this.ctx.storage.kv.get<number>(
      CHAT_RUNTIME_KV_KEYS.previewVersion,
    );
    return {
      tabs,
      activeTabId,
      target: tabs.find((tab) => getPreviewTabId(tab) === activeTabId) ?? null,
      version: Number.isFinite(storedVersion)
        ? Math.max(0, Math.floor(storedVersion!))
        : 0,
    };
  }

  private putPreview(state: Omit<PreviewState, "version">): void {
    const current = this.previewState();
    const tabs = boundedList(state.tabs);
    const activeTabId =
      state.activeTabId &&
      tabs.some((tab) => getPreviewTabId(tab) === state.activeTabId)
        ? state.activeTabId
        : tabs[0]
          ? getPreviewTabId(tabs[0])
          : null;
    const target =
      tabs.find((tab) => getPreviewTabId(tab) === activeTabId) ?? null;
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.previewTabs, tabs);
    this.ctx.storage.kv.put(
      CHAT_RUNTIME_KV_KEYS.previewActiveTabId,
      activeTabId,
    );
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.previewTarget, target);
    this.ctx.storage.kv.put(
      CHAT_RUNTIME_KV_KEYS.previewVersion,
      current.version + 1,
    );
    this.publish();
  }

  getPreviewTarget(): PreviewTarget | null {
    return cloneJson(this.previewState().target);
  }

  getPreviewState(): PreviewState {
    return (
      cloneJson(this.previewState()) ?? {
        target: null,
        tabs: [],
        activeTabId: null,
        version: 0,
      }
    );
  }

  async setPreviewTarget(target: PreviewTarget | null): Promise<void> {
    const normalized = normalizePreviewTarget(target);
    if (target && !normalized) throw new Error("Invalid preview target");
    const context = this.context();
    if (
      normalized?.kind === "file" &&
      context &&
      normalized.workspaceId !== context.workspaceId
    ) {
      throw new Error("Invalid preview target workspace");
    }
    this.putPreview({
      tabs: normalized ? [normalized] : [],
      activeTabId: normalized ? getPreviewTabId(normalized) : null,
      target: normalized,
    });
  }

  async setPreviewTabsState(
    tabs: PreviewTarget[],
    activeTabId: string | null,
  ): Promise<void> {
    const context = this.context();
    const deduped = new Map<string, PreviewTarget>();
    for (const value of boundedList(Array.isArray(tabs) ? tabs : [])) {
      const target = normalizePreviewTarget(value);
      if (!target) continue;
      if (
        target.kind === "file" &&
        context &&
        target.workspaceId !== context.workspaceId
      ) {
        throw new Error("Invalid preview target workspace");
      }
      deduped.set(getPreviewTabId(target), target);
    }
    const resolved = [...deduped.values()];
    this.putPreview({
      tabs: resolved,
      activeTabId,
      target:
        resolved.find((tab) => getPreviewTabId(tab) === activeTabId) ?? null,
    });
  }

  async clearPreviewTarget(): Promise<void> {
    await this.setPreviewTarget(null);
  }

  async setPreviewAppVisibility(
    scriptName: string,
    isPublic: boolean,
  ): Promise<void> {
    const state = this.previewState();
    const tabs = state.tabs.map((tab) =>
      tab.kind === "app" && tab.scriptName === scriptName
        ? { ...tab, isPublic }
        : tab,
    );
    this.putPreview({
      tabs,
      activeTabId: state.activeTabId,
      target: state.target,
    });
  }

  async setTitle(title: string, _updatedAt?: number): Promise<void> {
    const value = boundText(title.trim());
    if (value) {
      this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.title, value);
      this.publish();
    }
  }

  async setModel(model: LlmModel, _updatedAt?: number): Promise<void> {
    const value = String(model).trim();
    if (!validId(value)) throw new Error("Invalid model");
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.model, value as LlmModel);
    this.publish();
  }

  async setTodoState(todos: unknown[]): Promise<void> {
    this.ctx.storage.kv.put(
      CHAT_RUNTIME_KV_KEYS.todos,
      boundedList(Array.isArray(todos) ? todos : []),
    );
    this.publish();
  }

  getTodoState(): unknown[] {
    return boundedList(
      this.ctx.storage.kv.get<unknown[]>(CHAT_RUNTIME_KV_KEYS.todos) ?? [],
    );
  }

  async appendChannelHistoryEvent(
    input: ChannelHistoryEventRequest,
  ): Promise<ChannelHistoryEventResult> {
    if (!cloneJson(input, CHAT_RUNTIME_BOUNDS.requestBytes)) {
      return { status: "error", error: "Channel history event is too large" };
    }
    const contextError = this.bindContext(input);
    if (contextError) return { status: "error", error: contextError };
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const attachments = Number.isFinite(input.attachmentCount)
      ? Math.max(0, Math.floor(Number(input.attachmentCount)))
      : 0;
    if (!text && attachments === 0) return { status: "skipped" };
    const source = input.channelKind?.trim() || "channel";
    if (!validId(source))
      return { status: "error", error: "Invalid channel kind" };
    const createdAt = Number.isFinite(input.sentAt)
      ? Math.floor(Number(input.sentAt))
      : Date.now();
    const providerId = String(
      input.providerMessageIds?.find(Boolean) ?? "",
    ).trim();
    const id = boundText(
      `history:${createdAt}:${providerId || input.sourceThreadId || "event"}`,
      CHAT_RUNTIME_BOUNDS.identifierChars,
    );
    const details = [
      "<camelai system message>",
      `Already-delivered ${source} channel history. Do not resend it.`,
      attachments ? `Attachment count: ${attachments}.` : "",
      text ? `Delivered message:\n${text}` : "",
      "</camelai system message>",
    ]
      .filter(Boolean)
      .join("\n");
    const existing = boundedList(
      this.ctx.storage.kv.get<StoredChannelHistoryMessage[]>(
        CHAT_RUNTIME_KV_KEYS.channelHistory,
      ) ?? [],
    );
    const record: StoredChannelHistoryMessage = {
      id,
      source,
      modelContent: boundText(details),
      displayContent: boundText(text || `${attachments} attachment(s)`),
      createdAt,
    };
    this.ctx.storage.kv.put(
      CHAT_RUNTIME_KV_KEYS.channelHistory,
      boundedList([...existing.filter((value) => value.id !== id), record]),
    );
    this.publish();
    return { status: "appended" };
  }

  private forkSeed(): AgentMessage[] {
    return boundedList(
      this.ctx.storage.kv.get<AgentMessage[]>(CHAT_RUNTIME_KV_KEYS.forkSeed) ??
        [],
    );
  }

  private currentVisibleMessages(): VisibleMessage[] {
    const messages: VisibleMessage[] = this.store
      .latestSnapshot()
      .messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
      }));
    for (const message of boundedList(
      this.ctx.storage.kv.get<StoredChannelHistoryMessage[]>(
        CHAT_RUNTIME_KV_KEYS.channelHistory,
      ) ?? [],
    )) {
      messages.push({
        id: message.id,
        role: "user",
        content: message.displayContent,
        status: "completed",
        createdAt: message.createdAt,
      });
    }
    return boundedList(messages.sort((a, b) => a.createdAt - b.createdAt));
  }

  private canonicalAgentMessages(): AgentMessage[] {
    const current = this.currentVisibleMessages().map(
      (message) =>
        ({
          id: message.id,
          role: message.role,
          content:
            message.role === "user"
              ? message.content
              : message.status === "failed" || message.status === "interrupted"
                ? []
                : [{ type: "text", text: message.content }],
          ...(message.role === "assistant"
            ? {
                responseId: message.id,
                ...(message.status === "failed" ||
                message.status === "interrupted"
                  ? { errorMessage: message.content }
                  : {}),
              }
            : {}),
          timestamp: message.createdAt,
        }) as unknown as AgentMessage,
    );
    return boundedList(
      [...this.forkSeed(), ...current].sort(
        (left, right) =>
          stableTime(recordOf(left)?.timestamp) -
          stableTime(recordOf(right)?.timestamp),
      ),
    );
  }

  private adoptForkSeed(): void {
    const seed = this.forkSeed();
    if (!seed.length) return;
    const context = this.context();
    if (!context) return;
    const turns: SettledChatTurn[] = [];
    let pending: SettledChatTurn | null = null;
    for (const [index, message] of parsedHistory(
      seed,
      context.threadId,
    ).entries()) {
      if (message.role === "user") {
        if (pending) turns.push(pending);
        const content = displayText(message.content) || "[Imported message]";
        pending = {
          id: `fork:${index}:${crypto.randomUUID()}`,
          userContent: content,
          userDisplay: content,
          assistantFinal: null,
          createdAt: message.created_at,
          updatedAt: message.created_at,
        };
      } else if (pending) {
        const content = displayText(message.content);
        pending.assistantFinal = boundText(
          [pending.assistantFinal, content].filter(Boolean).join("\n"),
          CHAT_RUNTIME_BOUNDS.assistantBytes,
        );
        pending.updatedAt = Math.max(pending.updatedAt, message.created_at);
      }
    }
    if (pending) turns.push(pending);
    if (!turns.length) throw new Error("Forked history has no user messages");
    this.store.replaceSettledHistory(context, turns);
    this.ctx.storage.kv.delete(CHAT_RUNTIME_KV_KEYS.forkSeed);
  }

  async getPiCoreParsedMessages(
    threadId: string,
  ): Promise<AgentEvalParsedMessage[]> {
    const normalized = threadId.trim() || this.context()?.threadId || "";
    if (!validId(normalized)) return [];
    return parsedHistory(this.canonicalAgentMessages(), normalized);
  }

  async getPiCoreForkMessages(options: {
    forkEntryId: string;
    renderedMessageId?: string;
  }): Promise<ChatThreadPiCoreForkResult> {
    const messages = this.canonicalAgentMessages();
    if (!messages.length) {
      return {
        success: false,
        code: "NO_PI_CORE_MESSAGES",
        error: "Source thread has no canonical messages",
      };
    }
    const targets = [options.forkEntryId, options.renderedMessageId].flatMap(
      (value) =>
        typeof value === "string" && validId(value.trim())
          ? [value.trim()]
          : [],
    );
    const target = messages.findIndex((message, index) =>
      targets.some((id) => forkMessageIds(message, index).includes(id)),
    );
    if (target < 0) {
      return {
        success: false,
        code: "TARGET_NOT_FOUND",
        error: "Fork target not found in bounded canonical history",
      };
    }
    const forked = boundedList(messages.slice(0, target + 1));
    return { success: true, messages: forked, messageCount: forked.length };
  }

  async replacePiCoreForkMessages(messages: AgentMessage[]): Promise<void> {
    const seed = boundedList(
      (Array.isArray(messages) ? messages : [])
        .slice(-CHAT_RUNTIME_BOUNDS.snapshotMessages)
        .filter((message): message is AgentMessage => {
          const role = recordOf(message)?.role;
          return (
            role === "user" || role === "assistant" || role === "toolResult"
          );
        }),
    );
    if (!seed.length)
      throw new Error("Forked message history is empty or too large");
    const previous = this.forkSeed();
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.forkSeed, seed);
    try {
      this.adoptForkSeed();
    } catch (error) {
      if (previous.length) {
        this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.forkSeed, previous);
      } else {
        this.ctx.storage.kv.delete(CHAT_RUNTIME_KV_KEYS.forkSeed);
      }
      throw error;
    }
  }

  async getGroupNewChatRecentSource(threadId: string): Promise<{
    messages: AgentEvalParsedMessage[];
    projectActivity: [];
  }> {
    const context = this.context();
    return {
      messages:
        context?.threadId === threadId
          ? await this.getPiCoreParsedMessages(threadId)
          : [],
      projectActivity: [],
    };
  }

  protected evalNow(): number {
    return Date.now();
  }

  protected waitForEvalPoll(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async evalDeployedApps(): Promise<
    AgentEvalDeployedApp[] | undefined
  > {
    const context = this.context();
    const apps = this.previewState().tabs.filter(
      (target): target is Extract<PreviewTarget, { kind: "app" }> =>
        target.kind === "app",
    );
    if (!context || !apps.length) return undefined;
    const slug = await withTimeout(
      Promise.resolve(
        this.env.ORG.get(this.env.ORG.idFromName(context.orgId)).getSlug(),
      ),
      CHAT_RUNTIME_BOUNDS.runtimeCallbackMs,
    ).catch(() => null);
    if (!slug) return undefined;
    let hostname = "camelai.dev";
    try {
      if (this.env.WORKER_BASE_URL)
        hostname = new URL(this.env.WORKER_BASE_URL).host;
    } catch {
      // The stable production hostname is a safe fallback for malformed test config.
    }
    return boundedList(
      apps.map((app) => ({
        name: app.scriptName,
        url: getAppUrl(
          app.scriptName,
          {
            hostname,
            vanityDomain: this.env.LOCAL_APP_VANITY_DOMAIN,
            iframeDomain: this.env.LOCAL_APP_IFRAME_DOMAIN,
          },
          slug,
        ),
        isPublic: app.isPublic,
      })),
    );
  }

  private async finishEval(
    turnId: string,
    status: AgentEvalSessionResult["status"],
    options: { error?: string; result?: string; terminal?: boolean } = {},
  ): Promise<AgentEvalSessionResult> {
    const run = this.ctx.storage.kv.get<StoredEvalRun>(
      CHAT_RUNTIME_KV_KEYS.evalRun,
    );
    let events =
      run?.turnId === turnId
        ? boundedList(
            this.ctx.storage.kv.get<Array<Record<string, unknown>>>(
              CHAT_RUNTIME_KV_KEYS.evalEvents,
            ) ?? [],
          )
        : [];
    if (options.terminal) {
      events = boundedList([
        ...events,
        {
          type: "runtime_event",
          event: { method: "sdk/turn/completed", params: { turnId, status } },
        },
      ]);
    }
    if (status === "completed" && options.result !== undefined) {
      events = boundedList([
        ...events,
        { type: "result", result: options.result },
      ]);
    }
    if (run?.turnId === turnId) {
      this.ctx.storage.kv.delete(CHAT_RUNTIME_KV_KEYS.evalRun);
      this.ctx.storage.kv.delete(CHAT_RUNTIME_KV_KEYS.evalEvents);
    }
    const context = this.context();
    return {
      status,
      ...(options.error ? { error: boundText(options.error) } : {}),
      ...(options.result !== undefined ? { result: options.result } : {}),
      events,
      messages: context
        ? await this.getPiCoreParsedMessages(context.threadId)
        : [],
      ...(status === "completed"
        ? { deployedApps: await this.evalDeployedApps() }
        : {}),
    };
  }

  /** Admit once, then observe the alarm-owned turn until one finite deadline. */
  async runAgentEvalSession(
    body: AgentEvalSessionRequest,
  ): Promise<AgentEvalSessionResult> {
    const contextError = this.bindContext(body);
    if (contextError) {
      return { status: "error", error: contextError, events: [], messages: [] };
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return this.finishEval("", "error", { error: "Missing message" });
    }
    if (this.store.shouldArmAlarm()) {
      return this.finishEval("", "busy", {
        error: "Thread is busy with another run",
      });
    }
    const turnId =
      body.clientMessageId?.trim() || `eval:${crypto.randomUUID()}`;
    if (!validId(turnId)) {
      return this.finishEval("", "error", { error: "Invalid eval message id" });
    }
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.evalRun, { turnId });
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.evalEvents, [
      {
        type: "runtime_event",
        event: { method: "sdk/turn/started", params: { turnId } },
      },
    ]);
    const admitted = await this.startInitialUserMessage({
      ...body,
      clientMessageId: turnId,
      messageSource: body.messageSource?.trim() || "eval",
    });
    if (admitted.status !== "accepted") {
      return this.finishEval(turnId, admitted.status, {
        error: admitted.error || "Eval admission failed",
      });
    }

    const requested = Number(body.timeoutMs);
    const timeoutMs = Number.isFinite(requested)
      ? Math.max(
          1,
          Math.min(Math.floor(requested), CHAT_RUNTIME_BOUNDS.turnLeaseMs),
        )
      : CHAT_RUNTIME_BOUNDS.providerDeadlineMs;
    const deadline = this.evalNow() + timeoutMs;
    for (;;) {
      const turn = this.store.getTurn(turnId);
      if (!turn) {
        return this.finishEval(turnId, "error", {
          error: "Eval turn disappeared from bounded history",
          terminal: true,
        });
      }
      if (turn.status === "completed") {
        return this.finishEval(turnId, "completed", {
          result: turn.assistantFinal ?? "",
          terminal: true,
        });
      }
      if (turn.status === "failed" || turn.status === "interrupted") {
        return this.finishEval(turnId, "error", {
          error: turn.assistantError || "Eval turn failed",
          terminal: true,
        });
      }
      const remaining = deadline - this.evalNow();
      if (remaining <= 0) {
        return this.finishEval(turnId, "error", {
          error: `Agent eval timed out after ${timeoutMs}ms`,
        });
      }
      await this.waitForEvalPoll(
        Math.min(remaining, CHAT_RUNTIME_BOUNDS.runtimeCallbackMs),
      );
    }
  }

  getForkStateSnapshot(): ChatThreadForkState {
    const preview = this.previewState();
    return {
      previewTarget: preview.target,
      previewTabs: preview.tabs,
      previewActiveTabId: preview.activeTabId,
      previewVersion: preview.version,
      chatContext: this.context(),
      currentTodos: this.getTodoState(),
      contextUsedPercent: null,
      usageIsPostCompaction: true,
      cachedContextWindowByModel: {},
    };
  }

  applyForkStateSnapshot(
    snapshot: ChatThreadForkState,
    target: ChatThreadForkStateTarget,
  ): void {
    const error = this.bindContext({
      threadId: target.threadId,
      workspaceId: target.workspaceId,
      orgId: target.orgId,
      userId: target.userId ?? null,
    });
    if (error) throw new Error(error);
    this.adoptForkSeed();
    const normalized = boundedList(snapshot.previewTabs).flatMap((value) => {
      const preview = normalizePreviewTarget(value);
      return preview ? [preview] : [];
    });
    this.putPreview({
      tabs: normalized,
      activeTabId: snapshot.previewActiveTabId,
      target: snapshot.previewTarget,
    });
    this.ctx.storage.kv.put(
      CHAT_RUNTIME_KV_KEYS.todos,
      boundedList(snapshot.currentTodos),
    );
  }

  async receiveConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }> {
    const requestId = response?.requestId?.trim() || "";
    const stored = cloneJson(
      {
        response,
        receivedAt: Date.now(),
      },
      CHAT_RUNTIME_BOUNDS.requestBytes,
    );
    if (!validId(requestId) || !stored) return { accepted: false };
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.connectionResponse, stored);
    return { accepted: true };
  }

  async submitConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<void> {
    if (!(await this.receiveConnectionSetupResponse(response)).accepted) {
      throw new Error("Invalid connection setup response");
    }
  }

  async answerQuestion(
    questionId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const stored = cloneJson(
      {
        questionId: questionId.trim(),
        answers,
        receivedAt: Date.now(),
      },
      CHAT_RUNTIME_BOUNDS.requestBytes,
    );
    if (!validId(questionId.trim()) || !stored)
      throw new Error("Invalid question answer");
    this.ctx.storage.kv.put(CHAT_RUNTIME_KV_KEYS.questionAnswer, stored);
  }

  private async control(
    action: ChatRuntimeControlAction,
    payload: unknown,
  ): Promise<unknown> {
    if (action === "stop") return { stopped: await this.driver.stop() };
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Invalid control payload");
    }
    if (action === "answer_question") {
      const input = payload as { questionId?: unknown; answers?: unknown };
      await this.answerQuestion(
        typeof input.questionId === "string" ? input.questionId : "",
        input.answers && typeof input.answers === "object"
          ? (input.answers as Record<string, unknown>)
          : {},
      );
      return { accepted: true };
    }
    await this.submitConnectionSetupResponse(
      payload as ConnectionSetupResponse,
    );
    return { accepted: true };
  }

  private coarseState(): Record<string, unknown> {
    const preview = this.previewState();
    const migration = this.migrator.status();
    return {
      previewTarget: preview.target,
      previewTabs: preview.tabs,
      previewActiveTabId: preview.activeTabId,
      previewVersion: preview.version,
      currentTodos: this.getTodoState(),
      title:
        this.ctx.storage.kv.get<string>(CHAT_RUNTIME_KV_KEYS.title) ?? null,
      model:
        this.ctx.storage.kv.get<LlmModel>(CHAT_RUNTIME_KV_KEYS.model) ?? null,
      legacyMigrationError:
        migration.state === "failed"
          ? {
              id: `legacy-migration:${migration.deadlineAt ?? 0}`,
              error:
                "Recent chat history could not be restored. This message will continue without older context.",
            }
          : null,
    };
  }
}
