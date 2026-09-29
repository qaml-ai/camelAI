/**
 * Reads of a ChatThreadDO's stored transcript, as the old in-DO chat loop
 * wrote it (the exporter's only source; chat-thread-do.ts):
 *
 *   pi_core_messages   one pi message per row (idx, JSON payload), images over
 *                      the storage limit replaced by R2 references;
 *   pi_core_compaction the last compaction: its summary and the first row the
 *                      model still saw (rows below it stay, unseen);
 *   pi_core_state      a generation and row count, bumped by every write: a
 *                      move checks nothing changed since it began.
 *
 * Nothing here writes a row. The one side effect is the working-set image
 * policy of the old session load, kept so a move imports what the old model
 * saw: an inline image over PI_SESSION_INLINE_IMAGE_MAX_CHARS is put to its
 * content-addressed R2 key and referenced (the row keeps its bytes).
 */
import type { AgentMessage } from "../../../../src/lib/agent-messages";
import {
  PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES,
  PI_R2_IMAGE_REF_METADATA_KEY,
  normalizePiImageMimeType,
  sanitizePiModelMessage,
  sanitizePiProviderMessage,
  type PiR2ImageReference,
} from "../pi-message-storage";
import { buildWorkspaceScopedR2Key } from "../../../../src/lib/workspace-r2-paths";
import type { ChatContextState } from "./types";

/** How a read resolves images: R2 references kept (the model's view), or shown as a note (the page's). */
export type PiCoreImagePolicy = "reference" | "render";

/** An inline image larger than this is referenced from R2 in a model-view read (the row keeps it). */
export const PI_SESSION_INLINE_IMAGE_MAX_CHARS = 128_000;
/** Stored characters one batch of an export walk holds (a larger row alone). */
export const PI_CORE_EXPORT_BATCH_CHARS = 4_000_000;
/** Rows per metadata probe while choosing a bounded window's cut. */
const PI_SESSION_LOAD_ROW_BATCH_SIZE = 256;

/** A compaction summary as the old loop stored and loaded it: a user message. */
export function createPiSummaryMessage(summary: string, timestamp = Date.now()): AgentMessage {
  return { role: "user", content: `[Context Summary]\n\n${summary}`, timestamp };
}

export interface PiCoreRevision {
  generation: number;
  count: number;
}

/**
 * What a session load actually loaded, and the index space the loaded list
 * lives in.
 *
 * `firstRowIdx` is the `pi_core_messages.idx` of the list's first REAL message,
 * and `summaryOffset` is 1 when a summary message (durable or placeholder) sits
 * ahead of it. Together they are the only way to translate a cut computed over
 * the session list into the `idx >= ?` predicate a `pi_core_compaction` row is
 * read back as:
 *
 *     storedFirstKeptIndex = firstRowIdx + max(0, sessionCut - summaryOffset)
 *
 * Getting this wrong is not a degraded experience, it is data loss: a watermark
 * written too low silently keeps the whole prefix (the bound this exists to
 * enforce never applies again), and one written too high blanks the thread's
 * model context.
 */
export interface PiSessionLoadWindow {
  /** pi_core idx of the first real (non-summary) message loaded. */
  firstRowIdx: number;
  /** 1 when the loaded list starts with a summary message, else 0. */
  summaryOffset: 0 | 1;
  /** The char cap bound: rows below `firstRowIdx` were deliberately skipped. */
  capped: boolean;
  totalChars: number;
  loadedChars: number;
  totalRows: number;
  loadedRows: number;
}

/**
 * Where a context window may open. A window that opens on a toolResult would
 * hand a model an answer to a call it cannot see.
 */
function isPiTurnBoundaryRole(role: unknown): boolean {
  return role === "user" || role === "assistant";
}

/**
 * The model-visible stand-in for history a capped load left in storage.
 *
 * Written to be summarizer-safe as well as model-safe: `compactPiContext` hands
 * it back as `previousSummary` (never as conversation to be summarized), so it
 * has to read as a statement ABOUT the conversation rather than as part of it.
 * It is also deliberately explicit that the omitted content is unavailable — a
 * model told only "the conversation continues below" will confabulate the
 * missing prefix, which on a thread this size is exactly the failure that makes
 * the capped turn useless.
 *
 * DURABLE-SAFE WORDING. Because it is handed back as `previousSummary`, the
 * summarizer carries this notice into the persisted `pi_core_compaction` row —
 * and it SHOULD: the rows a capped load skipped fall permanently behind the
 * watermark the first turn writes, are never summarized, and this notice is the
 * only surviving record that the hole exists. So every sentence has to stay
 * true once it is sitting in a durable summary in front of a different tail.
 * That rules out two things the first version had: exact `rowsSkipped` /
 * `charsSkipped` counts, which are a snapshot that drifts into an undercount as
 * the watermark advances, and any claim that what follows is "the most recent
 * part of the conversation", which stops being true the moment the summary is
 * reused. The counts survive only in the `pi_session_load_capped` event, which
 * is timestamped and therefore cannot go stale.
 */
export function piCappedSessionLoadPlaceholder(args: {
  durableSummary?: string;
}): string {
  const notice = [
    "Earlier messages in this conversation were NOT loaded into your context.",
    "Those messages remain in the thread's storage but are not available to you here, and they are not covered by any summary above.",
    "Do not guess at or invent the omitted content: if you need something from earlier, say so and ask the user.",
  ].join(" ");
  return args.durableSummary
    ? `${args.durableSummary}\n\n${notice}`
    : notice;
}

export interface PiCoreMessageStoreDeps {
  sql(): SqlStorage;
  r2(): R2Bucket;
  chatContext(): ChatContextState | null;
}

export class PiCoreMessageStore {
  constructor(private readonly deps: PiCoreMessageStoreDeps) {}

  /** R2 keys this store has proven present, so a repeat read makes no R2 call. */
  private readonly sessionExternalizedImageKeys = new Set<string>();

  /**
   * The tables a read needs, created empty on a thread the old loop never
   * ran (every read then finds nothing). pi_core_state is initialized from
   * the rows, as the old loop did for histories written before it existed.
   */
  ensurePiCoreTables(): void {
    const sql = this.deps.sql();
    sql.exec("CREATE TABLE IF NOT EXISTS pi_core_messages (idx INTEGER PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS pi_core_compaction (id INTEGER PRIMARY KEY CHECK (id = 1), summary TEXT NOT NULL, first_kept_index INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS pi_core_state (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL, row_count INTEGER NOT NULL)");
    sql.exec("INSERT OR IGNORE INTO pi_core_state (id, generation, row_count) SELECT 1, 1, COUNT(*) FROM pi_core_messages");
  }

  async sha256Hex(value: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  piStoredImageR2Key(sha256: string): string | null {
    const context = this.deps.chatContext();
    if (!context?.orgId || !context.workspaceId || !context.threadId) {
      return null;
    }
    const safeSessionId = context.threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return buildWorkspaceScopedR2Key(
      context.orgId,
      context.workspaceId,
      `chat-sessions/${safeSessionId}/pi-images/${sha256}.base64`,
    );
  }

  readPiR2ImageReference(part: Record<string, unknown>): PiR2ImageReference | null {
    const metadata = part.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const ref = (metadata as Record<string, unknown>)[PI_R2_IMAGE_REF_METADATA_KEY];
    if (!ref || typeof ref !== "object") return null;
    const record = ref as Record<string, unknown>;
    const key = typeof record.key === "string" ? record.key : "";
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
    const sha256 = typeof record.sha256 === "string" ? record.sha256 : "";
    if (!key || !mimeType || !sha256) return null;
    return {
      key,
      mimeType,
      sha256,
      size: Math.max(0, Math.floor(Number(record.size) || 0)),
      storedAt: Math.max(0, Math.floor(Number(record.storedAt) || 0)),
      // Absent (every row written before the discriminator existed) is durable
      // storage externalization, which is the conservative reading: a stored
      // reference is never re-inlined and is never exempt from the count budget.
      origin: record.origin === "session" ? "session" : "storage",
    };
  }

  /**
   * The old session load's image policy, kept so a move imports what the old
   * model saw: an inline image over {@link PI_SESSION_INLINE_IMAGE_MAX_CHARS}
   * is put to its content-addressed R2 location (sha256 of the bytes, so the
   * same image is the same object on every load; a `head` proves presence
   * before any `put`) and the loaded message references it. The stored row
   * keeps its bytes. A failure returns the message unchanged: keeping the
   * base64 is strictly better than losing the image.
   */
  private async externalizeOversizedInlineSessionImages(value: unknown): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const next = Array.from<unknown>({ length: value.length });
      let changed = false;
      for (let index = 0; index < value.length; index += 1) {
        next[index] = await this.externalizeOversizedInlineSessionImages(value[index]);
        if (next[index] !== value[index]) changed = true;
      }
      // Identity when nothing below changed, exactly like hydration: the common
      // thread has no oversized inline image and must not pay for a clone of its
      // message graph on every load.
      return changed ? next : value;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      const data = record.data;
      const mimeType = typeof record.mimeType === "string"
        ? normalizePiImageMimeType(record.mimeType)
        : "";
      if (
        data.length > PI_SESSION_INLINE_IMAGE_MAX_CHARS &&
        mimeType &&
        PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
      ) {
        const reference = await this.putSessionImageReference(data, mimeType);
        if (reference) {
              const metadata = record.metadata && typeof record.metadata === "object"
            ? { ...(record.metadata as Record<string, unknown>) }
            : {};
          metadata[PI_R2_IMAGE_REF_METADATA_KEY] = reference;
          return { ...record, mimeType, data: "", metadata };
        }
      }
      return value;
    }
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.externalizeOversizedInlineSessionImages(nested);
      if (next[key] !== nested) changed = true;
    }
    return changed ? next : value;
  }

  private async putSessionImageReference(
    data: string,
    mimeType: string,
  ): Promise<PiR2ImageReference | null> {
    const sha256 = await this.sha256Hex(data);
    const key = this.piStoredImageR2Key(sha256);
    if (!key) return null;
    const reference: PiR2ImageReference = {
      key,
      mimeType,
      size: data.length,
      sha256,
      storedAt: Date.now(),
      // Ephemeral. The row this came from still holds `data`; see
      // PiR2ImageReferenceOrigin for everything that hangs off this field.
      origin: "session",
    };
    if (this.sessionExternalizedImageKeys.has(key)) return reference;
    try {
      const existing = await this.deps.r2().head(key);
      if (!existing) {
        await this.deps.r2().put(key, data, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
          customMetadata: {
            type: "pi-message-image-base64",
            mimeType,
            sessionId: this.deps.chatContext()?.threadId ?? "",
            threadId: this.deps.chatContext()?.threadId ?? "",
            workspaceId: this.deps.chatContext()?.workspaceId ?? "",
            orgId: this.deps.chatContext()?.orgId ?? "",
            sha256,
          },
        });
      }
    } catch (error) {
      console.warn("[pi-core] failed to externalize session image", {
        error: error instanceof Error ? error.message : String(error),
      });
      // The bytes are not provably in R2, so keep them inline rather than hand
      // the session a reference that would hydrate to nothing.
      return null;
    }
    this.sessionExternalizedImageKeys.add(key);
    return reference;
  }

  private renderSafeExternalImageMarker(ref: PiR2ImageReference): Record<string, string> {
    const normalizedMime = normalizePiImageMimeType(ref.mimeType);
    const mimeType = PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMime)
      ? normalizedMime
      : "image/unknown";
    // Deliberately omit metadata, hashes, and the storage key. The fixed-shape
    // text is deterministic, bounded, and safe for legacy JSON render paths.
    return {
      type: "text",
      text: `(persisted image omitted from render: ${mimeType}, ${Math.min(ref.size, 1_000_000_000)} base64 chars)`,
    };
  }

  renderPiStoredImageReferences(value: unknown): unknown {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.renderPiStoredImageReferences(item));
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image") {
      const metadata = record.metadata && typeof record.metadata === "object"
        ? record.metadata as Record<string, unknown>
        : null;
      const hasExternalReference = !!metadata?.[PI_R2_IMAGE_REF_METADATA_KEY];
      if (hasExternalReference && typeof record.data === "string" && record.data.length === 0) {
        const ref = this.readPiR2ImageReference(record) ?? {
          key: "",
          mimeType: typeof record.mimeType === "string" ? record.mimeType : "",
          sha256: "",
          size: 0,
          storedAt: 0,
        };
        return this.renderSafeExternalImageMarker(ref);
      }
    }
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      next[key] = this.renderPiStoredImageReferences(nested);
    }
    return next;
  }

  getPiCoreRevision(): PiCoreRevision {
    this.ensurePiCoreTables();
    const row = this.deps.sql()
      .exec<{ generation: number; row_count: number }>(
        "SELECT generation, row_count FROM pi_core_state WHERE id = 1",
      )
      .toArray()[0];
    return {
      generation: Math.max(0, Math.floor(Number(row?.generation) || 0)),
      count: Math.max(0, Math.floor(Number(row?.row_count) || 0)),
    };
  }

  async loadFullPiCoreTranscriptUnbounded(options: {
    includeUiMetadata?: boolean;
    imagePolicy?: PiCoreImagePolicy;
  } = {}): Promise<AgentMessage[]> {
    this.ensurePiCoreTables();
    const compaction = this.loadPiCoreCompaction();
    const firstKeptIndex = compaction?.firstKeptIndex ?? 0;
    const rows = firstKeptIndex > 0
      ? this.deps.sql()
        .exec<{ payload: string }>(
          "SELECT payload FROM pi_core_messages WHERE idx >= ? ORDER BY idx ASC",
          firstKeptIndex,
        )
        .toArray()
      : this.deps.sql()
        .exec<{ payload: string }>(
          "SELECT payload FROM pi_core_messages ORDER BY idx ASC",
        )
        .toArray();
    const messages: AgentMessage[] = [];
    for (const row of rows) {
      const message = await this.materializePiCoreRow(row.payload, options);
      if (message) messages.push(message);
    }
    if (!compaction || firstKeptIndex <= 0) return messages;
    return [
      createPiSummaryMessage(compaction.summary, compaction.updatedAt),
      ...messages,
    ];
  }

  /**
   * One stored payload through the read policy: parse, resolve images per
   * `imagePolicy`, sanitize. Null for a corrupt row, which every read skips
   * rather than failing the thread.
   */
  private async materializePiCoreRow(
    payload: string,
    options: { includeUiMetadata?: boolean; imagePolicy?: PiCoreImagePolicy },
  ): Promise<AgentMessage | null> {
    try {
      const parsed = JSON.parse(payload) as AgentMessage;
      if (!parsed || typeof parsed !== "object" || !("role" in parsed)) return null;
      const resolved = (options.imagePolicy ?? "reference") === "render"
        ? this.renderPiStoredImageReferences(parsed)
        : await this.externalizeOversizedInlineSessionImages(parsed);
      return options.includeUiMetadata
        ? sanitizePiProviderMessage(resolved as AgentMessage)
        : sanitizePiModelMessage(resolved as AgentMessage);
    } catch {
      return null;
    }
  }

  /**
   * Row count and total stored payload chars of the visible window, with NO
   * payload selected. The same metadata-then-body discipline the render pager
   * uses: a load has to be able to decide it cannot afford the thread before it
   * materializes any of it.
   */
  piCoreVisibleWindowTotals(firstKeptIndex: number): {
    rows: number;
    chars: number;
  } {
    const row = this.deps.sql()
      .exec<{ visible_rows: number; visible_chars: number }>(
        `SELECT COUNT(*) AS visible_rows,
                COALESCE(SUM(length(payload)), 0) AS visible_chars
           FROM pi_core_messages
          WHERE idx >= ?`,
        Math.max(0, Math.floor(firstKeptIndex)),
      )
      .toArray()[0];
    return {
      rows: Math.max(0, Math.floor(Number(row?.visible_rows) || 0)),
      chars: Math.max(0, Math.floor(Number(row?.visible_chars) || 0)),
    };
  }

  /**
   * The old loop's model-side session load, bounded by construction (a move
   * of a thread over the export cap imports this).
   *
   * Under {@link PI_SESSION_LOAD_MAX_CHARS} this is byte-for-byte the legacy
   * `loadFullPiCoreTranscriptUnbounded({ imagePolicy: "reference" })` — same rows, same order,
   * same summary prefix. Over it, the window is the newest turn-aligned tail
   * that fits, and the skipped prefix becomes a `[Context Summary]` PLACEHOLDER
   * so the model is told plainly what it cannot see instead of silently
   * believing the tail is the whole conversation.
   *
   * The placeholder has the shape of a compaction summary, which a move
   * imports as the runtime's compaction summary. A capped load leaves storage
   * exactly as it found it.
   */
  async loadBoundedPiCoreSessionWindow(options: {
    maxChars: number;
    includeUiMetadata?: boolean;
  }): Promise<{ messages: AgentMessage[]; window: PiSessionLoadWindow }> {
    this.ensurePiCoreTables();
    const maxChars = Math.max(1, Math.floor(options.maxChars));
    const compaction = this.loadPiCoreCompaction();
    const firstKeptIndex = compaction?.firstKeptIndex ?? 0;
    const summaryOffset = compaction && firstKeptIndex > 0 ? 1 : 0;
    const totals = this.piCoreVisibleWindowTotals(firstKeptIndex);

    if (totals.chars <= maxChars) {
      const messages = await this.loadFullPiCoreTranscriptUnbounded({
        imagePolicy: "reference",
        includeUiMetadata: options.includeUiMetadata,
      });
      return {
        messages,
        window: {
          firstRowIdx: firstKeptIndex,
          summaryOffset,
          capped: false,
          totalChars: totals.chars,
          loadedChars: totals.chars,
          totalRows: totals.rows,
          loadedRows: totals.rows,
        },
      };
    }

    // Choose the cut from metadata alone, newest-first, never starting a row we
    // cannot afford — the fill rule `deriveRenderWindowFromPiCore` uses. The
    // newest row is always accepted so one oversized turn still loads.
    const endIdx = this.piCoreRowCount();
    let cutIdx = endIdx;
    let loadedChars = 0;
    let stopped = false;
    while (!stopped) {
      const batch = this.listPiCoreRowMeta({
        minIdx: firstKeptIndex,
        beforeIdx: cutIdx,
        limit: PI_SESSION_LOAD_ROW_BATCH_SIZE,
      });
      if (batch.length === 0) break;
      for (const meta of batch) {
        if (loadedChars > 0 && loadedChars + meta.chars > maxChars) {
          stopped = true;
          break;
        }
        loadedChars += meta.chars;
        cutIdx = meta.idx;
      }
    }

    const rows = this.deps.sql()
      .exec<{ idx: number; payload: string }>(
        "SELECT idx, payload FROM pi_core_messages WHERE idx >= ? ORDER BY idx ASC",
        cutIdx,
      )
      .toArray();
    const loadOptions = {
      imagePolicy: "reference" as const,
      includeUiMetadata: options.includeUiMetadata,
    };
    const tail: AgentMessage[] = [];
    const tailRowIdx: number[] = [];
    for (const row of rows) {
      const message = await this.materializePiCoreRow(
        row.payload,
        loadOptions,
      );
      if (!message) continue;
      tail.push(message);
      tailRowIdx.push(Math.max(0, Math.floor(Number(row.idx) || 0)));
    }

    // Turn alignment, the same forward scan `findPiCompactionCutIndex` uses: a
    // window that opens on a toolResult hands the provider an answer to a call
    // it cannot see. Dropping those rows also moves `firstRowIdx`, which is what
    // the compaction row will be written against.
    let headOffset = 0;
    while (
      headOffset < tail.length &&
      !isPiTurnBoundaryRole((tail[headOffset] as { role?: unknown }).role)
    ) {
      headOffset += 1;
    }
    // Every row a toolResult: keep them rather than hand the model nothing.
    const alignedTail = headOffset < tail.length ? tail.slice(headOffset) : tail;
    const alignedFrom = headOffset < tail.length ? headOffset : 0;
    const firstRowIdx = tailRowIdx[alignedFrom] ?? cutIdx;

    const keptTotals = this.piCoreVisibleWindowTotals(firstRowIdx);
    const rowsSkipped = Math.max(0, totals.rows - keptTotals.rows);

    if (rowsSkipped === 0) {
      // The whole visible window is one row larger than the cap, which the fill
      // rule admits on purpose. Nothing was skipped, so a placeholder announcing
      // omitted history would be a lie and the index space is unshifted.
      return {
        messages: summaryOffset === 1 && compaction
          ? [
              createPiSummaryMessage(compaction.summary, compaction.updatedAt),
              ...alignedTail,
            ]
          : alignedTail,
        window: {
          firstRowIdx: firstKeptIndex,
          summaryOffset,
          capped: false,
          totalChars: totals.chars,
          loadedChars: keptTotals.chars,
          totalRows: totals.rows,
          loadedRows: keptTotals.rows,
        },
      };
    }

    return {
      messages: [
        createPiSummaryMessage(
          piCappedSessionLoadPlaceholder({
            durableSummary: compaction?.summary,
          }),
        ),
        ...alignedTail,
      ],
      window: {
        firstRowIdx,
        summaryOffset: 1,
        capped: true,
        totalChars: totals.chars,
        loadedChars: keptTotals.chars,
        totalRows: totals.rows,
        loadedRows: keptTotals.rows,
      },
    };
  }

  /**
   * The newest stored messages whose payloads fit `maxChars`, oldest first,
   * as a person reads the thread: every stored row (a compaction's watermark
   * hides nothing here), images as notes (nothing is fetched or written), and
   * the window opening on a turn, not on a tool result. `truncated`: older
   * rows were left out.
   */
  async loadRecentStoredMessages(maxChars: number): Promise<{ messages: AgentMessage[]; truncated: boolean }> {
    this.ensurePiCoreTables();
    const budget = Math.max(1, Math.floor(maxChars));
    let cutIdx = this.piCoreRowCount();
    let loaded = 0;
    let truncated = false;
    for (;;) {
      const batch = this.listPiCoreRowMeta({ minIdx: 0, beforeIdx: cutIdx, limit: PI_SESSION_LOAD_ROW_BATCH_SIZE });
      if (batch.length === 0) break;
      for (const meta of batch) {
        if (loaded > 0 && loaded + meta.chars > budget) {
          truncated = true;
          break;
        }
        loaded += meta.chars;
        cutIdx = meta.idx;
      }
      if (truncated) break;
    }
    const rows = this.deps.sql()
      .exec<{ payload: string }>("SELECT payload FROM pi_core_messages WHERE idx >= ? ORDER BY idx ASC", cutIdx)
      .toArray();
    const messages: AgentMessage[] = [];
    for (const row of rows) {
      const message = await this.materializePiCoreRow(row.payload, { includeUiMetadata: true, imagePolicy: "render" });
      if (message) messages.push(message);
    }
    let head = 0;
    while (truncated && head < messages.length && !isPiTurnBoundaryRole((messages[head] as { role?: unknown }).role)) head++;
    return { messages: head < messages.length ? messages.slice(head) : messages, truncated };
  }

  /**
   * Newest-first row metadata for a bounded idx range: no payload is selected,
   * so a pager can decide how many rows it can afford BEFORE materializing any
   * of them (the same metadata-then-body discipline ai-chat's render window uses).
   */
  listPiCoreRowMeta(options: {
    minIdx: number;
    beforeIdx: number;
    limit: number;
  }): Array<{ idx: number; chars: number }> {
    this.ensurePiCoreTables();
    const limit = Math.max(1, Math.floor(options.limit));
    const minIdx = Math.max(0, Math.floor(options.minIdx));
    const beforeIdx = Math.floor(options.beforeIdx);
    if (beforeIdx <= minIdx) return [];
    return this.deps.sql()
      .exec<{ idx: number; chars: number }>(
        `SELECT idx, length(payload) AS chars
           FROM pi_core_messages
          WHERE idx >= ? AND idx < ?
          ORDER BY idx DESC
          LIMIT ?`,
        minIdx,
        beforeIdx,
        limit,
      )
      .toArray()
      .map((row) => ({
        idx: Math.max(0, Math.floor(Number(row.idx) || 0)),
        chars: Math.max(0, Math.floor(Number(row.chars) || 0)),
      }));
  }

  /**
   * A thread's history for its move to the agent runtime
   * (agent-runtime/thread-migration.ts). When every stored row fits
   * `maxChars`: all of them in order (`whole`), with the compaction summary
   * where its cut falls, so the moved thread shows its full history and its
   * model sees the summary and what follows. Past it: the bounded session
   * window (the model's view only). The totals are read first, so a whale
   * never materializes. Deterministic for an unchanged thread: a retried move
   * sends the same import.
   */
  async loadPiCoreHistoryForMigration(maxChars: number): Promise<{
    messages: AgentMessage[];
    whole: boolean;
    totalRows: number;
    /** The render message the export's first (non-summary) row belongs to: a turn a compaction's cut may have split. */
    openingRenderMessageId: string | null;
  }> {
    this.ensurePiCoreTables();
    const totals = this.piCoreVisibleWindowTotals(0);
    if (totals.chars > maxChars) {
      const { messages, window } = await this.loadBoundedPiCoreSessionWindow({ maxChars });
      // A capped window's placeholder summary is stamped with the load time.
      const [first, next] = messages as Array<AgentMessage & { timestamp?: number }>;
      if (first && typeof next?.timestamp === "number" && (first.timestamp ?? 0) > next.timestamp) {
        messages[0] = { ...first, timestamp: next.timestamp } as AgentMessage;
      }
      return { messages, whole: false, totalRows: totals.rows, openingRenderMessageId: this.openingRenderMessageId(window.firstRowIdx) };
    }
    const compaction = this.loadPiCoreCompaction();
    const cutAt = compaction && compaction.firstKeptIndex > 0 ? compaction.firstKeptIndex : null;
    const messages: AgentMessage[] = [];
    let summarized = cutAt === null;
    // A batch of payloads at a time, so each row's stored string is released
    // once it is materialized rather than all of them held until the end.
    for (const batch of this.piCoreRowBatches()) {
      for (const row of batch) {
        if (!summarized && row.idx >= (cutAt ?? 0)) {
          messages.push(createPiSummaryMessage(compaction!.summary, compaction!.updatedAt));
          summarized = true;
        }
        const message = await this.materializePiCoreRow(row.payload, { imagePolicy: "reference" });
        if (message) messages.push(message);
      }
    }
    if (!summarized) messages.push(createPiSummaryMessage(compaction!.summary, compaction!.updatedAt));
    return { messages, whole: true, totalRows: totals.rows, openingRenderMessageId: this.openingRenderMessageId(0) };
  }

  /**
   * The render message the rows from `fromIdx` open on, read as stored: the
   * renderMessageId of the first row that has one before the first user
   * message (a turn a cut split opens on its tool results, which carry none,
   * then the assistant rows that do). Compaction summaries are passed over;
   * null when the rows open on a user message.
   */
  private openingRenderMessageId(fromIdx: number): string | null {
    for (const meta of this.listPiCoreRowMetaAscending({ fromIdx, limit: 32 })) {
      const row = this.deps.sql()
        .exec<{ payload: string }>("SELECT payload FROM pi_core_messages WHERE idx = ? LIMIT 1", meta.idx)
        .toArray()[0];
      let parsed: { role?: unknown; content?: unknown; uiMetadata?: { renderMessageId?: unknown } } | null = null;
      try {
        parsed = row ? JSON.parse(row.payload) : null;
      } catch {
        continue;
      }
      if (!parsed) continue;
      if (parsed.role === "user") {
        if (typeof parsed.content === "string" && parsed.content.startsWith("[Context Summary]")) continue;
        return null;
      }
      const id = parsed.uiMetadata?.renderMessageId;
      if (typeof id === "string" && id) return id;
    }
    return null;
  }

  /**
   * The timestamp of the oldest stored message that is not a compaction
   * summary (a rewrite puts one at row 0, stamped when it ran): where stored
   * history begins. Scans a few rows, payloads one at a time.
   */
  firstStoredMessageAtMs(): number | undefined {
    this.ensurePiCoreTables();
    for (const meta of this.listPiCoreRowMetaAscending({ fromIdx: 0, limit: 16 })) {
      const message = this.loadPiCoreRenderMessageAt(meta.idx) as { role?: unknown; content?: unknown; timestamp?: unknown } | null;
      if (!message || typeof message.timestamp !== "number") continue;
      if (message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Context Summary]")) continue;
      return message.timestamp;
    }
    return undefined;
  }

  /**
   * Every stored row, oldest first, a batch of at most `maxChars` stored
   * characters at a time (a row larger than that alone): a whole transcript
   * walked, or streamed out, without ever holding it.
   */
  *piCoreRowBatches(maxChars = PI_CORE_EXPORT_BATCH_CHARS): Generator<Array<{ idx: number; payload: string }>> {
    this.ensurePiCoreTables();
    let fromIdx = 0;
    for (;;) {
      const meta = this.listPiCoreRowMetaAscending({ fromIdx, limit: PI_SESSION_LOAD_ROW_BATCH_SIZE });
      if (meta.length === 0) return;
      let chars = 0;
      let lastIdx = meta[0].idx;
      for (const row of meta) {
        if (chars > 0 && chars + row.chars > maxChars) break;
        chars += row.chars;
        lastIdx = row.idx;
      }
      const rows = this.deps.sql()
        .exec<{ idx: number; payload: string }>(
          "SELECT idx, payload FROM pi_core_messages WHERE idx >= ? AND idx <= ? ORDER BY idx ASC",
          fromIdx,
          lastIdx,
        )
        .toArray()
        .map((row) => ({ idx: Number(row.idx), payload: row.payload }));
      fromIdx = lastIdx + 1;
      if (rows.length) yield rows;
    }
  }

  /**
   * Oldest-first row metadata from `fromIdx` up, payload never selected. The
   * ascending twin of {@link listPiCoreRowMeta}: the render pager walks history
   * backwards, but the render MIRROR walks it forwards from its high-water mark,
   * and both need to size a batch before materializing it.
   */
  listPiCoreRowMetaAscending(options: {
    fromIdx: number;
    limit: number;
  }): Array<{ idx: number; chars: number }> {
    this.ensurePiCoreTables();
    const limit = Math.max(1, Math.floor(options.limit));
    const fromIdx = Math.max(0, Math.floor(options.fromIdx));
    return this.deps.sql()
      .exec<{ idx: number; chars: number }>(
        `SELECT idx, length(payload) AS chars
           FROM pi_core_messages
          WHERE idx >= ?
          ORDER BY idx ASC
          LIMIT ?`,
        fromIdx,
        limit,
      )
      .toArray()
      .map((row) => ({
        idx: Math.max(0, Math.floor(Number(row.idx) || 0)),
        chars: Math.max(0, Math.floor(Number(row.chars) || 0)),
      }));
  }

  /**
   * One row, materialized exactly as `loadFullPiCoreTranscriptUnbounded({ includeUiMetadata:
   * true, imagePolicy: "render" })` would materialize it — the render read path's
   * policy. Returns null for a missing or corrupt row, which is precisely what
   * the full load does with it (skip, keep the thread readable).
   */
  loadPiCoreRenderMessageAt(idx: number): AgentMessage | null {
    const row = this.deps.sql()
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_core_messages WHERE idx = ? LIMIT 1",
        Math.max(0, Math.floor(idx)),
      )
      .toArray()[0];
    if (!row || typeof row.payload !== "string") return null;
    try {
      const parsed = JSON.parse(row.payload) as AgentMessage;
      if (!parsed || typeof parsed !== "object" || !("role" in parsed)) {
        return null;
      }
      return sanitizePiProviderMessage(
        this.renderPiStoredImageReferences(parsed) as AgentMessage,
      );
    } catch {
      return null;
    }
  }

  /** Committed row count — the exclusive upper bound of a valid `first_kept_index`
   *  (it is read back as an `idx >= ?` predicate over exactly these rows). */
  private piCoreRowCount(): number {
    const rows = this.deps.sql()
      .exec<{ next_idx: number }>(
        "SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM pi_core_messages",
      )
      .toArray();
    return Math.max(0, Math.floor(Number(rows[0]?.next_idx) || 0));
  }

  loadPiCoreCompaction(): { summary: string; firstKeptIndex: number; updatedAt: number } | null {
    this.ensurePiCoreTables();
    const rows = this.deps.sql()
      .exec<{ summary: string; first_kept_index: number; updated_at: number }>(
        "SELECT summary, first_kept_index, updated_at FROM pi_core_compaction WHERE id = 1",
      )
      .toArray();
    const row = rows[0];
    if (!row || typeof row.summary !== "string") return null;
    const stored = Math.max(0, Math.floor(Number(row.first_kept_index) || 0));
    // A watermark past the last committed row would silently return the summary
    // and NOTHING else, i.e. blank the thread's model context. Rows can be
    // rewritten shorter (fork, post-turn compaction) and older builds could write
    // an index computed over uncommitted messages, so treat it as corrupt and keep
    // every row: an over-large context is recoverable, a lost one is not.
    const firstKeptIndex = stored > this.piCoreRowCount() ? 0 : stored;
    return {
      summary: row.summary,
      firstKeptIndex,
      updatedAt: Math.max(0, Math.floor(Number(row.updated_at) || 0)),
    };
  }
}
