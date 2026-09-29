/**
 * ChatThreadDO, now only an exporter: every thread runs on the hosted agent
 * runtime, and this object keeps the storage of the threads the old in-DO
 * chat loop ran, read-only, until each has moved (lazily, when it is opened
 * or sent to, or by a sweep).
 *
 * What stays is what a move needs (chat-thread/runtime-migration.ts): its
 * record, lease, commit and alarm; the pi_core readers (chat-thread/
 * pi-core-store.ts); the pre-compaction render archive (the old ai-chat
 * render table, cf_ai_chat_agent_messages); and a bounded read of the
 * history for a thread that cannot move (the page shows it read-only).
 *
 * Nothing runs here any more: a turn, a send or a connection answers
 * "moved" (HTTP 410). The class stays bound with its storage; it must never
 * be listed in a migration's deleted_classes, which would destroy every
 * thread not yet moved.
 */
import { DurableObject } from "cloudflare:workers";
import type { AgentMessage } from "../../../src/lib/agent-messages";
import type { PreviewTarget } from "../../../src/types";
import { PiCoreMessageStore } from "./chat-thread/pi-core-store";
import { getPreviewTabId } from "./chat-thread/preview-state";
import { ChatThreadRuntimeMigration, type RuntimeMigrationStatus } from "./chat-thread/runtime-migration";
import {
  isRenderMessage,
  renderArchiveToPiMessages,
  renderMessageCreatedAtMs,
  type RenderMessage,
} from "./chat-thread/render-archive-export";
import { piMessagesToParsedMessages } from "./pi-message-export";
import type { DoMigrationRequest, DoMigrationResult } from "./agent-runtime/thread-migration";
import type { RelayRuntimeAgent } from "./agent-runtime/channel-turns";
import type {
  AgentEvalParsedMessage,
  ChatContextState,
  ChatEnv,
  InitialUserMessageResult,
} from "./chat-thread/types";

export type * from "./chat-thread/types";

/** KV keys the old chat loop wrote, read here. */
const CHAT_CONTEXT_KEY = "chatContext";
const PREVIEW_TABS_KEY = "previewTabs";
const PREVIEW_ACTIVE_TAB_KEY = "previewActiveTabId";
/** A thread from before preview tabs: its one preview target. */
const PREVIEW_TARGET_KEY = "previewTarget";
/** A thread the old loop relayed to a runtime agent: adopted, not imported. */
const RUNTIME_AGENT_KEY = "runtimeAgent";

/** The old render table (ai-chat's): the only copy of history a rewrite compaction cut from pi_core. */
const RENDER_TABLE = "cf_ai_chat_agent_messages";
const RENDER_PAGE_MAX_MESSAGES = 50;
const RENDER_PAGE_MAX_BYTES = 2_000_000;

/** What the read-only view of a thread that cannot move shows: the newest history within these. */
export const READ_ONLY_HISTORY_MAX_CHARS = 4_000_000;
export const READ_ONLY_ARCHIVE_MAX_CHARS = 2_000_000;
/** The group welcome page's recent items look through at most this many messages. */
const RECENT_SOURCE_MESSAGES = 50;

export const THREAD_MOVED_ERROR = "This conversation moved to the new chat engine; reload the page to continue it.";

/** A read-only thread's history, for its page. */
export interface ChatThreadReadOnlyHistory {
  messages: AgentEvalParsedMessage[];
  /** Older history is not shown (over the read's bounds). */
  truncated: boolean;
}

function* mapIterable<T, U>(items: Iterable<T>, map: (item: T) => U): Generator<U> {
  for (const item of items) yield map(item);
}

const isSummary = (message: { role?: unknown; content?: unknown }) =>
  message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Context Summary]");

export class ChatThreadDO extends DurableObject<ChatEnv> {
  private storeInstance: PiCoreMessageStore | null = null;
  private migrationInstance: ChatThreadRuntimeMigration | null = null;
  private renderColumns: Set<string> | null = null;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    // The old loop scheduled the move's alarm through the Agents SDK's
    // schedule table; its storage alarm still fires alarm() below. One lost
    // (or never set) while the record still needs it is set again here.
    ctx.blockConcurrencyWhile(async () => {
      const due = this.migration.alarmDue();
      if (due !== null && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(due);
    });
  }

  /** The thread's identity as the old loop recorded it; null for a thread it never ran. */
  private chatContext(): ChatContextState | null {
    const stored = this.ctx.storage.kv.get<ChatContextState>(CHAT_CONTEXT_KEY);
    if (!stored?.threadId || !stored.workspaceId || !stored.orgId) return null;
    return { ...stored, userId: stored.userId ?? null, userName: stored.userName ?? null, userEmail: stored.userEmail ?? null };
  }

  private get store(): PiCoreMessageStore {
    return (this.storeInstance ??= new PiCoreMessageStore({
      sql: () => this.ctx.storage.sql,
      r2: () => this.env.R2_BUCKET,
      chatContext: () => this.chatContext(),
    }));
  }

  private get migration(): ChatThreadRuntimeMigration {
    return (this.migrationInstance ??= new ChatThreadRuntimeMigration({
      env: this.env,
      kv: this.ctx.storage.kv,
      // Nothing runs here: a thread is never busy.
      busyReason: () => null,
      hasRelayAgent: () => Boolean(this.ctx.storage.kv.get<{ id?: string }>(RUNTIME_AGENT_KEY)?.id),
      revision: () => this.store.getPiCoreRevision(),
      loadHistory: (maxChars) => this.store.loadPiCoreHistoryForMigration(maxChars),
      renderArchivePages: (beforeMs) => this.renderArchivePages(beforeMs),
      firstStoredAtMs: () => this.store.firstStoredMessageAtMs(),
      payloadBatches: () => mapIterable(this.store.piCoreRowBatches(), (batch) => batch.map((row) => row.payload)),
      preview: () => this.previewTabs(),
      scheduleAlarm: (at) => this.ctx.waitUntil(this.ctx.storage.setAlarm(at)),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      // Channel notes queued for the runtime prompt meanwhile stay queued: the
      // thread cannot take them here, and they reach it once it moves.
      onUndone: () => {},
      orgId: () => this.chatContext()?.orgId,
    }));
  }

  private previewTabs(): { tabs: PreviewTarget[]; activeTabId: string | null } {
    const isTarget = (tab: unknown): tab is PreviewTarget =>
      Boolean(tab) && typeof tab === "object" && typeof (tab as { kind?: unknown }).kind === "string";
    const stored = this.ctx.storage.kv.get<unknown>(PREVIEW_TABS_KEY);
    if (!Array.isArray(stored)) {
      // Before tabs, a thread kept one preview target: it becomes its one tab.
      const target = this.ctx.storage.kv.get<unknown>(PREVIEW_TARGET_KEY);
      return isTarget(target) ? { tabs: [target], activeTabId: getPreviewTabId(target) } : { tabs: [], activeTabId: null };
    }
    const tabs = stored.filter(isTarget);
    const active = this.ctx.storage.kv.get<unknown>(PREVIEW_ACTIVE_TAB_KEY);
    return { tabs, activeTabId: typeof active === "string" ? active : null };
  }

  // ---- Turns, sends and connections: the thread has moved. ----

  /** Every HTTP request (the old chat transport: WebSocket, SSE, polling, calls): 410. */
  override async fetch(_request: Request): Promise<Response> {
    return Response.json({ status: "moved", error: THREAD_MOVED_ERROR }, { status: 410 });
  }

  async startInitialUserMessage(_request?: unknown): Promise<InitialUserMessageResult> {
    return { status: "moved", error: THREAD_MOVED_ERROR };
  }

  async sendMessage(_input?: unknown): Promise<InitialUserMessageResult> {
    return { status: "moved", error: THREAD_MOVED_ERROR };
  }

  // ---- The move to the runtime (agent-runtime/thread-migration.ts). ----

  /** Move this thread to the runtime (the worker decides it may): export, make the agent, commit, all here. */
  async migrateToRuntime(request: DoMigrationRequest): Promise<DoMigrationResult> {
    return await this.migration.migrate(request);
  }

  /** Where this thread's move stands (moving, moved, backing off), before anyone asks for one. */
  runtimeMigrationStatus(): RuntimeMigrationStatus {
    return this.migration.status();
  }

  /** Whether this thread's move holds a runtime agent a move made (the orphan reconciler asks). */
  runtimeMigrationHolds(agentId: string, key: string | null): { holds: boolean; orgId?: string } {
    return this.migration.holds(agentId, key);
  }

  /** The stored transcript's size (rows and payload characters), read without a payload: the sweep moves large threads one at a time. */
  runtimeMigrationSize(): { rows: number; chars: number } {
    this.store.ensurePiCoreTables();
    return this.store.piCoreVisibleWindowTotals(0);
  }

  /** End a failed move's backoff (the admin retry route): the next open or send may move the thread. */
  clearRuntimeMigrationBackoff(): boolean {
    return this.migration.clearBackoff();
  }

  /** The move's alarm: undo an abandoned one, finish a commit, delete a failed attempt's agent. */
  override async alarm(): Promise<void> {
    await this.migration.onAlarm();
  }

  /**
   * The runtime agent the old loop relayed this thread to, for the direct
   * path to adopt (agent-runtime/channel-turns.ts); null when it had none.
   */
  relayRuntimeAgent(): RelayRuntimeAgent | null {
    const agent = this.ctx.storage.kv.get<{ id?: string; model?: string; keyScope?: string | null }>(RUNTIME_AGENT_KEY);
    if (!agent?.id) return null;
    return { agentId: agent.id, model: agent.model ?? null, keyScope: agent.keyScope ?? null };
  }

  // ---- Reads. ----

  /**
   * The whole stored transcript, parsed (the export surface: admin views and
   * the JSONL export of a thread not yet moved). Unbounded by design; no
   * request path renders from it.
   */
  async getPiCoreParsedMessages(threadId: string): Promise<AgentEvalParsedMessage[]> {
    const messages = await this.store.loadFullPiCoreTranscriptUnbounded({ includeUiMetadata: true, imagePolicy: "render" });
    return piMessagesToParsedMessages(messages, threadId.trim() || this.chatContext()?.threadId || "");
  }

  /**
   * A thread that cannot move, shown read-only: the newest stored history
   * within READ_ONLY_HISTORY_MAX_CHARS (all of it, below a compaction's
   * watermark too), after the render archive rows older than it (a rewrite
   * compaction's only copy) within READ_ONLY_ARCHIVE_MAX_CHARS.
   */
  async readOnlyHistory(threadId: string): Promise<ChatThreadReadOnlyHistory> {
    const recent = await this.store.loadRecentStoredMessages(READ_ONLY_HISTORY_MAX_CHARS);
    // A rewrite compaction left its summary as a row: the page shows history, not that.
    const held = recent.messages.filter((message) => !isSummary(message as { role?: unknown; content?: unknown }));
    let truncated = recent.truncated;
    const seam = held.reduce<number | undefined>((oldest, message) => {
      const at = (message as { timestamp?: unknown }).timestamp;
      return typeof at === "number" && (oldest === undefined || at < oldest) ? at : oldest;
    }, undefined);
    const pages: RenderMessage[][] = [];
    if (!truncated && seam !== undefined) {
      let chars = 0;
      for (const page of this.renderArchivePages(seam)) {
        const size = page.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
        if (chars + size > READ_ONLY_ARCHIVE_MAX_CHARS) {
          truncated = true;
          break;
        }
        chars += size;
        pages.push(page);
      }
    }
    const archived = renderArchiveToPiMessages(pages.reverse().flat());
    const id = threadId.trim() || this.chatContext()?.threadId || "";
    return { messages: piMessagesToParsedMessages([...archived, ...held] as AgentMessage[], id), truncated };
  }

  /** The newest messages, for the group welcome page's recent connections and uploads. */
  async getGroupNewChatRecentSource(threadId: string): Promise<{ messages: AgentEvalParsedMessage[]; projectActivity: unknown[] }> {
    const { messages } = await this.readOnlyHistory(threadId);
    return { messages: messages.slice(-RECENT_SOURCE_MESSAGES), projectActivity: [] };
  }

  /**
   * The render rows older than `beforeMs`, a bounded page at a time, newest
   * page first. The old table's rows are ordered by their chronology key
   * (created_at, then insertion), which ai-chat backfilled on every row and
   * indexed (cf_ai_chat_agent_messages_chronology): each page is an index
   * range. A table from before that column existed orders by created_at and
   * rowid the same way (a scan; such tables are small).
   */
  private *renderArchivePages(beforeMs: number): Generator<RenderMessage[]> {
    const columns = this.renderTableColumns();
    if (!columns.has("message")) return;
    const key = columns.has("chronology_key")
      ? "chronology_key"
      : "created_at || ':' || printf('%020d', rowid) || ':' || id";
    const bytes = columns.has("serialized_bytes")
      ? "coalesce(serialized_bytes, length(cast(message as blob)))"
      : "length(cast(message as blob))";
    const sql = this.ctx.storage.sql;
    // Keys open with created_at as SQLite writes it ("YYYY-MM-DD HH:MM:SS.sss"):
    // rows created at or after `beforeMs` are never read.
    let before = new Date(beforeMs).toISOString().replace("T", " ").replace("Z", "");
    for (;;) {
      const meta = sql.exec<{ id: string; k: string; bytes: number }>(
        `SELECT id, ${key} AS k, ${bytes} AS bytes FROM ${RENDER_TABLE} WHERE ${key} < ? ORDER BY k DESC LIMIT ?`,
        before,
        RENDER_PAGE_MAX_MESSAGES + 1,
      ).toArray();
      if (meta.length === 0) return;
      const selected: typeof meta = [];
      let size = 0;
      for (const row of meta) {
        const rowBytes = Math.max(0, Number(row.bytes) || 0);
        if (selected.length > 0 && (selected.length >= RENDER_PAGE_MAX_MESSAGES || size + rowBytes > RENDER_PAGE_MAX_BYTES)) break;
        selected.push(row);
        size += rowBytes;
      }
      const page: RenderMessage[] = [];
      const oldestFirst = [...selected].reverse();
      for (const row of oldestFirst) {
        const body = sql.exec<{ message: string }>(`SELECT message FROM ${RENDER_TABLE} WHERE id = ? LIMIT 1`, row.id).toArray()[0];
        if (!body) continue;
        try {
          const parsed: unknown = JSON.parse(body.message);
          if (!isRenderMessage(parsed)) continue;
          const createdAt = renderMessageCreatedAtMs(parsed);
          if (createdAt !== undefined && createdAt < beforeMs) page.push(parsed);
        } catch {
          // A corrupt row is skipped, as the old loop did.
        }
      }
      if (page.length) yield page;
      if (meta.length <= selected.length) return;
      before = String(oldestFirst[0].k);
    }
  }

  private renderTableColumns(): Set<string> {
    if (this.renderColumns) return this.renderColumns;
    const rows = this.ctx.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${RENDER_TABLE})`).toArray();
    this.renderColumns = new Set(rows.map((row) => String(row.name)));
    return this.renderColumns;
  }
}
