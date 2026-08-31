// pi_core message persistence for ChatThreadDO, extracted as a collaborator:
// table DDL, R2 externalization of oversized images/tool results, the async
// SQLite serializer, and the pi_core_messages / pi_core_compaction row CRUD.
// All state lives in the DO's SQLite storage and R2; the class itself is
// stateless and is cached by the owning DO with closures over its live deps
// (ChatThreadDO keeps thin same-named private delegates as its internal API).
// Cross-operation calls stay on this instance, keeping the dependency surface
// limited to the storage and context capabilities the store actually needs.
// Recursive value traversal likewise stays on this instance so nested payloads
// do not repeatedly cross the DO facade or rebuild collaborator graphs.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES,
  PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS,
  PI_MAX_PERSISTED_IMAGE_DATA_CHARS,
  PI_R2_IMAGE_REF_METADATA_KEY,
  emptyPiSqlStorageStats,
  normalizePiImageMimeType,
  sanitizePiProviderMessage,
  sanitizePiModelMessage,
  shrinkPiValueForSqlStorage,
  preparePiMessageForSqlStorage,
} from "../pi-message-storage";
import type {
  PiR2ImageReference,
  PiR2ToolResultReference,
  PiSqlStorageStats,
  PiSqlStorageSerialization,
} from "../pi-message-storage";
import { piTextBytes, piCoreMessageKey } from "./pi-message-helpers";
import { normalizePiUiMetadata } from "../../../../src/lib/runtime-artifacts";
import { createPiSummaryMessage } from "./pi-compaction";
import { buildWorkspaceScopedR2Key } from "../../../../src/lib/workspace-r2-paths";
import type { ChatContextState } from "./types";

export type PiCoreImagePolicy = "reference" | "render" | "provider";

/**
 * How many DURABLY externalized images this request will pull back out of R2. A
 * count, because the cost being bounded is I/O plus a freshly materialized
 * base64 string per object; inline images are already resident and are not
 * charged against it.
 *
 * A `origin: "session"` reference is NOT charged against this. It stands for an
 * image whose row still holds its bytes and which was inline in the provider
 * context before the working-set trim existed, so counting it here would let a
 * residency optimization silently delete history from the model's view: the
 * third and later historical screenshots of a thread would come back as
 * "(image omitted from provider context)" purely because the session was
 * loaded rather than produced in-turn. Session references are charged against
 * {@link PI_PROVIDER_IMAGE_HYDRATION_MAX_DECLARED_CHARS} instead — exactly what
 * they cost when they were inline — which also bounds the R2 GETs one request
 * can make at `maxDeclaredChars / PI_SESSION_INLINE_IMAGE_MAX_CHARS`.
 */
export const PI_PROVIDER_IMAGE_HYDRATION_MAX_COUNT = 2;
/**
 * How much image base64 the provider context may carry in TOTAL — hydrated from
 * R2 or already inline. Inline used to escape this entirely: the budget was
 * enforced only inside the R2 branch, and an image at or under
 * `PI_MAX_PERSISTED_IMAGE_DATA_CHARS` is never externalized, so a screenshot
 * thread put an unbounded amount of base64 into every one of the ~25 provider
 * bodies of a turn with nothing anywhere to stop it. A live turn's own tool
 * results are worse still — up to `INLINE_IMAGE_MAX_BASE64_CHARS` (4.5 MB) each.
 * The budget now means what its name says regardless of where the bytes came
 * from, which is also what makes the degraded rung's 500 KB an honest cap
 * instead of a cap on R2 images only.
 */
export const PI_PROVIDER_IMAGE_HYDRATION_MAX_DECLARED_CHARS = 6_000_000;

/**
 * Inline base64 a SESSION copy of a message may keep resident, independent of
 * what the ROW keeps.
 *
 * `PI_MAX_PERSISTED_IMAGE_DATA_CHARS` (512_000) is a STORAGE rule and must not
 * move: `renderPiStoredImageReferences` replaces every externalized image with a
 * fixed text marker, so lowering the storage threshold retroactively deletes
 * images from users' visible history (WHALE-WORKINGSET-PROPOSAL §4). That leaves
 * every screenshot under 512 KB of base64 inline in its payload forever — twenty
 * of them is 6 MB of base64 resident for the life of the isolate, before any
 * per-request copy of the transcript.
 *
 * This is the working-set half of the same question, and it is free to be much
 * lower ONLY because it changes nothing durable — a property that has to be
 * enforced on both sides of the session copy, not just asserted here:
 *
 *  - WRITE. `serializePiMessageForSqlStorageDetailed` re-inlines every
 *    `origin: "session"` reference before a row is written
 *    ({@link PiCoreMessageStore.restoreSessionExternalizedImages}). Without
 *    that, any rewrite of a LOADED list — post-turn preserve compaction, fork
 *    seeding — persists `data: ""` and `renderPiStoredImageReferences` then
 *    replaces the image with a text marker forever, which is precisely the
 *    retroactive history deletion this comment's own §4 reference forbids.
 *  - READ (provider). `hydratePiStoredImages` charges a session reference
 *    against the DECLARED-CHAR budget only, never against
 *    {@link PI_PROVIDER_IMAGE_HYDRATION_MAX_COUNT}, so the model sees the same
 *    images it saw when they were inline.
 *
 * 128 KB of base64 ≈ 96 KB of image, which is a small screenshot or a large
 * icon: below this the round trip costs more than the residency.
 */
export const PI_SESSION_INLINE_IMAGE_MAX_CHARS = 128_000;

/**
 * Per-ROW bound on re-inlining session-trimmed images on the write path.
 *
 * `restoreSessionExternalizedImages` runs inside the serializer, once per
 * message, so the bound is naturally per row: a single pi_core row holds one
 * tool answer, i.e. a handful of screenshots at most. A row over either limit
 * keeps its references rather than stalling a rewrite on unbounded R2 I/O — the
 * bytes are still in R2 and the model still gets them, only that row's render
 * degrades, and the store reports it so the loss is never silent.
 */
export const PI_SESSION_IMAGE_RESTORE_MAX_COUNT = 8;
export const PI_SESSION_IMAGE_RESTORE_MAX_CHARS = 4_000_000;

/**
 * Stored payload chars one session load may materialize.
 *
 * `loadFullPiCoreTranscriptUnbounded` is O(thread): it reads and parses every visible row
 * before any bound applies. A thread with a durable compaction row is already
 * bounded by the `idx >= first_kept_index` predicate, but a thread that never
 * compacted — the observed whale — has no watermark at all, so the load is the
 * whole transcript and the isolate dies before the turn starts. Past this cap
 * {@link PiCoreMessageStore.loadBoundedPiCoreSessionWindow} loads the newest
 * turn-aligned tail that fits and hands the model a placeholder summary for the
 * prefix, which the first completed turn turns into a real compaction row.
 *
 * 12 MB, i.e. under `PI_CONTEXT_MAX_WORKING_SET_BYTES` (16 MB) so a capped load
 * lands inside the byte trigger rather than tripping it on arrival, and far
 * enough above an ordinary thread that nothing normal ever sees it.
 *
 * That ordering used to be the whole follow-through argument, and it was wrong:
 * landing UNDER both triggers means an image-dominated capped load runs a turn
 * without compacting at all, so the durable row that ends the capped state is
 * never written and the thread is capped forever. The follow-through is now
 * forced explicitly by `ChatThreadDO#piCappedLoadNeedsWatermark`, which is where
 * that invariant lives; this constant is once again just a residency cap and no
 * longer carries the correctness argument on the relationship between the two
 * numbers.
 */
export const PI_SESSION_LOAD_MAX_CHARS = 12_000_000;

/**
 * The stored-char ceiling the DURABLE post-turn cut fires at, in the same units
 * as {@link PI_SESSION_LOAD_MAX_CHARS} and deliberately BELOW it.
 *
 * The post-turn trigger's other two dimensions measure an in-memory estimate,
 * and neither is comparable to a `SUM(length(payload))` over the visible window
 * — an inline image is bigger in the row than in the estimate, an
 * R2-externalized one is far smaller. So an image-dominated thread can cross
 * this cap with both estimate dimensions quiet, get loaded capped, and only then
 * acquire a watermark whose summary is the "earlier messages were NOT loaded"
 * placeholder: a permanent hole in model context where a real summarization
 * would have preserved the prefix.
 *
 * Firing the durable cut at 75% of the cap closes that gap in the cap's own
 * units: the last turn before a thread would be capped ends with a real
 * summarization instead. The 25% margin covers the growth one more turn can add
 * between the probe and the next cold load.
 */
export const PI_DURABLE_CUT_MAX_VISIBLE_CHARS = Math.floor(
  PI_SESSION_LOAD_MAX_CHARS * 0.75,
);

/** Rows per metadata probe while choosing the capped window's cut. */
const PI_SESSION_LOAD_ROW_BATCH_SIZE = 256;

export interface PiImageHydrationBudget {
  /** Maximum images hydrated from R2. Inline images do not consume it. */
  maxCount: number;
  /** Maximum total base64 chars in the provider context, inline or hydrated. */
  maxDeclaredChars: number;
}

interface PiImageHydrationState {
  count: number;
  declaredChars: number;
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
 * Where a context window may open. `findPiCompactionCutIndex` uses exactly this
 * rule to move a cut forward off a toolResult, and a capped load has the same
 * problem for the same reason: an answer whose call is not in the context.
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
  /** Privacy-safe allocation counters used by focused tests and diagnostics. */
  recordReadOperation?(
    operation:
      | "payload_row_parsed"
      | "r2_image_hydrated"
      | "session_image_externalized"
      /** A session-trimmed image was re-inlined before its row was rewritten. */
      | "session_image_restored"
      /**
       * A session-trimmed image could NOT be re-inlined and its row was written
       * carrying the reference — that row's render is degraded until repaired.
       */
      | "session_image_restore_failed"
      /** An image was replaced by a marker in the provider context. */
      | "provider_image_omitted",
  ): void;
  /**
   * Wall-clock duration measured for a settled tool call, consumed once as its
   * toolResult row is committed. Optional so tests and non-agent callers can
   * construct the store without a timing source.
   */
  takeToolDurationMs?(toolCallId: string): number | undefined;
}

export class PiCoreMessageStore {
  constructor(private readonly deps: PiCoreMessageStoreDeps) {}

  /**
   * Content-addressed keys this store has already proven present in R2, so the
   * second and later loads of the same thread in one isolate externalize with
   * zero R2 calls at all. Correctness never depends on it (the key is a sha256
   * of the bytes, so a repeat `put` is a no-op rewrite of identical content);
   * it exists only to keep a warm reload cheap.
   */
  private readonly sessionExternalizedImageKeys = new Set<string>();

  ensurePiCoreTables(): void {
    this.deps.sql().exec(
      `CREATE TABLE IF NOT EXISTS pi_core_messages (
        idx INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    this.deps.sql().exec(
      `CREATE TABLE IF NOT EXISTS pi_core_compaction (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        summary TEXT NOT NULL,
        first_kept_index INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    // A scalar preflight lets image-blind/render readers prove that nothing
    // changed without selecting or parsing any payload rows. INSERT...SELECT
    // initializes old databases from their existing durable history.
    this.deps.sql().exec(
      `CREATE TABLE IF NOT EXISTS pi_core_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        generation INTEGER NOT NULL,
        row_count INTEGER NOT NULL
      )`,
    );
    this.deps.sql().exec(
      `INSERT OR IGNORE INTO pi_core_state (id, generation, row_count)
       SELECT 1, 1, COUNT(*) FROM pi_core_messages`,
    );
    // Staging buffer for the in-flight turn's not-yet-committed tail. It is a
    // discardable mirror of `agent.state.messages.slice(piMainBaselineIndex)`:
    // filled at message_end/tool_execution_end, drained (committed to
    // pi_core_messages) at turn_end, and dropped wholesale on a failed/aborted
    // turn. On a cold load with `piActiveTurn` set, it is folded back in to
    // resume the interrupted turn.
    this.deps.sql().exec(
      `CREATE TABLE IF NOT EXISTS pi_turn_journal (
        seq INTEGER PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
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

  piStoredToolResultR2Location(
    toolName: string,
    toolCallId: string,
    sha256: string,
  ): { key: string; path: string } | null {
    const context = this.deps.chatContext();
    if (!context?.orgId || !context.workspaceId || !context.threadId) {
      return null;
    }
    const safeSessionId = context.threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeToolName = (toolName || "tool")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 48) || "tool";
    const safeToolCallId = (toolCallId || "call")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64) || "call";
    const filename = `${Date.now()}-${safeToolName}-${safeToolCallId}-${sha256.slice(0, 16)}.txt`;
    return {
      key: buildWorkspaceScopedR2Key(
        context.orgId,
        context.workspaceId,
        `chat-sessions/${safeSessionId}/pi-tool-results/tmp/${filename}`,
      ),
      path: `tmp/${filename}`,
    };
  }

  async storePiFullToolResultInR2(
    toolName: string,
    toolCallId: string,
    text: string,
  ): Promise<PiR2ToolResultReference | undefined> {
    const sha256 = await this.sha256Hex(text);
    const location = this.piStoredToolResultR2Location(toolName, toolCallId, sha256);
    if (!location) return undefined;
    await this.deps.r2().put(location.key, text, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
      customMetadata: {
        type: "pi-tool-result-text",
        toolName,
        toolCallId,
        sessionId: this.deps.chatContext()?.threadId ?? "",
        threadId: this.deps.chatContext()?.threadId ?? "",
        workspaceId: this.deps.chatContext()?.workspaceId ?? "",
        orgId: this.deps.chatContext()?.orgId ?? "",
        sha256,
      },
    });
    return {
      path: location.path,
      sha256,
      size: piTextBytes(text),
      storedAt: Date.now(),
    };
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

  async externalizePiImagesForSqlStorage(value: unknown, stats: PiSqlStorageStats): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => this.externalizePiImagesForSqlStorage(item, stats)));
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      const data = record.data;
      const mimeType = typeof record.mimeType === "string"
        ? normalizePiImageMimeType(record.mimeType)
        : "";
      if (
        data.length > PI_MAX_PERSISTED_IMAGE_DATA_CHARS &&
        mimeType &&
        PI_PROVIDER_SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)
      ) {
        const sha256 = await this.sha256Hex(data);
        const key = this.piStoredImageR2Key(sha256);
        if (key) {
          try {
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
            stats.externalizedImages += 1;
            const metadata = record.metadata && typeof record.metadata === "object"
              ? { ...(record.metadata as Record<string, unknown>) }
              : {};
            metadata[PI_R2_IMAGE_REF_METADATA_KEY] = {
              key,
              mimeType,
              size: data.length,
              sha256,
              storedAt: Date.now(),
              // Durable: this row genuinely has no bytes from here on.
              origin: "storage",
            } satisfies PiR2ImageReference;
            return {
              ...record,
              mimeType,
              data: "",
              metadata,
            };
          } catch (error) {
            console.warn("[pi-core] failed to externalize stored image", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.externalizePiImagesForSqlStorage(nested, stats);
    }
    return next;
  }

  /**
   * Trim a LOADED message's resident base64 without touching the row it came
   * from: an inline image over {@link PI_SESSION_INLINE_IMAGE_MAX_CHARS} is put
   * to the same content-addressed R2 location the storage path uses and the
   * in-memory part is swapped for the reference shape.
   *
   * Three properties this relies on, all load-bearing:
   *
   *  - NO STORED-ROW REWRITE. The payload keeps its bytes, so the render path
   *    (`renderPiStoredImageReferences`) still shows the image and the mirror's
   *    idempotent upsert still sees the same row content. This is the whole
   *    reason the working set can be trimmed at 128 KB when storage cannot.
   *    It is NOT enough to leave the row alone here, because the loaded list is
   *    itself an input to two rewrites (preserve compaction, fork seeding): the
   *    reference is tagged `origin: "session"` and
   *    {@link restoreSessionExternalizedImages} puts the bytes back before any
   *    of it can be serialized into a row.
   *  - STABLE IDENTITY. `piCoreMessageKey` weighs an image as
   *    `(mimeType, base64 length)`, and the ref records `size = data.length`, so
   *    a trimmed message keys identically to the inline one the live turn holds.
   *    Without that, every dedup (`appendPiCoreMessagesIfMissing`, the resume
   *    fold) would re-append rows it already has.
   *  - IDEMPOTENCE. The key is `sha256(data)`, so the same image resolves to the
   *    same object on every load, in every isolate. A `head` proves presence
   *    before any `put`, and the per-store key set skips even that on repeats.
   *
   * A failure anywhere here returns the message unchanged: keeping the base64
   * resident is strictly better than losing the image.
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
          this.deps.recordReadOperation?.("session_image_externalized");
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

  /**
   * Undo {@link externalizeOversizedInlineSessionImages} on the WRITE path.
   *
   * The session trim is a residency optimization over an in-memory copy, but
   * that copy is an input to two wholesale rewrites — post-turn preserve
   * compaction (`replacePiCoreMessages(compacted, { uiRender: "preserve" })`)
   * and fork seeding — and nothing downstream would strip the reference:
   * `sanitizePiProviderContent` deliberately PRESERVES a zero-data image part
   * that carries R2 metadata, and `externalizePiImagesForSqlStorage` no-ops on
   * `"".length`. The row would therefore be stored with `data: ""` and
   * `renderPiStoredImageReferences` would replace the image with a fixed text
   * marker in the user's visible history, permanently, for every image between
   * {@link PI_SESSION_INLINE_IMAGE_MAX_CHARS} and
   * `PI_MAX_PERSISTED_IMAGE_DATA_CHARS`.
   *
   * So the bytes go back first. They are recoverable by construction: the key
   * is `sha256(data)` and `putSessionImageReference` proves the object present
   * (head, then put) before it mints a reference. What is written from here is
   * the pre-trim shape, so `externalizePiImagesForSqlStorage` immediately after
   * makes the ordinary storage decision on the ordinary storage threshold.
   *
   * Durable (`origin: "storage"`) references are untouched: their rows really
   * do have no bytes, and re-inlining one would undo storage externalization.
   */
  private async restoreSessionExternalizedImages(
    value: unknown,
    state: PiImageHydrationState = { count: 0, declaredChars: 0 },
  ): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const next = Array.from<unknown>({ length: value.length });
      let changed = false;
      for (let index = 0; index < value.length; index += 1) {
        next[index] = await this.restoreSessionExternalizedImages(value[index], state);
        if (next[index] !== value[index]) changed = true;
      }
      return changed ? next : value;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && record.data.length === 0) {
      const ref = this.readPiR2ImageReference(record);
      if (ref && ref.origin === "session") {
        const overBudget =
          state.count >= PI_SESSION_IMAGE_RESTORE_MAX_COUNT ||
          state.declaredChars + ref.size > PI_SESSION_IMAGE_RESTORE_MAX_CHARS;
        // Charge admission before the I/O, exactly like hydration, so one row's
        // maximum work is deterministic whatever R2 does.
        if (!overBudget) {
          state.count += 1;
          state.declaredChars += ref.size;
        }
        let data = "";
        if (!overBudget) {
          try {
            const object = await this.deps.r2().get(ref.key);
            data = object ? await object.text() : "";
          } catch (error) {
            console.warn("[pi-core] failed to restore session image for storage", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (data) {
          this.deps.recordReadOperation?.("session_image_restored");
          const metadata = record.metadata && typeof record.metadata === "object"
            ? { ...(record.metadata as Record<string, unknown>) }
            : null;
          if (metadata) delete metadata[PI_R2_IMAGE_REF_METADATA_KEY];
          const restored: Record<string, unknown> = { ...record, data };
          if (metadata && Object.keys(metadata).length > 0) {
            restored.metadata = metadata;
          } else {
            delete restored.metadata;
          }
          return restored;
        }
        // Keeping the reference is strictly better than writing a part with no
        // bytes AND no way back, but it does degrade that row's render until a
        // repair pass runs, so it must never be silent.
        this.deps.recordReadOperation?.("session_image_restore_failed");
        console.warn("[pi-core] session image could not be re-inlined before rewrite", {
          sha256: ref.sha256,
          size: ref.size,
          overBudget,
        });
      }
      return value;
    }
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.restoreSessionExternalizedImages(nested, state);
      if (next[key] !== nested) changed = true;
    }
    return changed ? next : value;
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

  async hydratePiStoredImages(
    value: unknown,
    budget: PiImageHydrationBudget = {
      maxCount: PI_PROVIDER_IMAGE_HYDRATION_MAX_COUNT,
      maxDeclaredChars: PI_PROVIDER_IMAGE_HYDRATION_MAX_DECLARED_CHARS,
    },
    state: PiImageHydrationState = { count: 0, declaredChars: 0 },
  ): Promise<unknown> {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const hydrated = Array.from<unknown>({ length: value.length });
      // Prefer recent provider context and avoid concurrently materializing
      // several R2 bodies/base64 strings. The source/session graph is untouched.
      let changed = false;
      for (let index = value.length - 1; index >= 0; index -= 1) {
        hydrated[index] = await this.hydratePiStoredImages(value[index], budget, state);
        if (hydrated[index] !== value[index]) changed = true;
      }
      // Return the original when nothing below it hydrated. This runs from
      // transformContext, i.e. once per provider request and 25+ times in a
      // single agent-loop turn, and threads with no stored images at all — the
      // common case, and every thread in the OOM sample — were paying a full
      // clone of the message graph each time for no change. Strings are shared
      // by reference either way, so the waste was the spine, but the spine of a
      // long transcript is not nothing in a 128MB isolate.
      return changed ? hydrated : value;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image") {
      const ref = this.readPiR2ImageReference(record);
      const inlineChars = typeof record.data === "string" ? record.data.length : 0;
      if (inlineChars > 0) {
        // An INLINE image: nothing to fetch, but it still lands in the provider
        // body, so it is charged against the same shared budget as a hydrated
        // one. Same reverse walk, so the most recent images win the budget and
        // older ones degrade to the same text marker. The source graph is
        // untouched — this is a per-request view, exactly like the R2 branch.
        const availableChars = Math.max(0, budget.maxDeclaredChars - state.declaredChars);
        if (inlineChars > availableChars) {
          const mimeType = typeof record.mimeType === "string" ? record.mimeType : "image/unknown";
          this.deps.recordReadOperation?.("provider_image_omitted");
          return {
            type: "text",
            text: `(image omitted from provider context: hydration budget exceeded; ${mimeType}, ${inlineChars} base64 chars)`,
          };
        }
        state.declaredChars += inlineChars;
        return value;
      }
      if (ref && inlineChars === 0) {
        const availableChars = Math.max(0, budget.maxDeclaredChars - state.declaredChars);
        // A session-trimmed reference stands for bytes the ROW still holds and
        // that were inline in this very context before stage 1b existed. It is
        // charged exactly what it was charged then — declared chars — and never
        // against `maxCount`, or a residency optimization would silently cap a
        // thread's visual history at `maxCount` historical screenshots. See
        // PI_PROVIDER_IMAGE_HYDRATION_MAX_COUNT.
        const chargesCount = ref.origin !== "session";
        if ((chargesCount && state.count >= budget.maxCount) || ref.size > availableChars) {
          this.deps.recordReadOperation?.("provider_image_omitted");
          return {
            type: "text",
            text: `(image omitted from provider context: hydration budget exceeded; ${ref.mimeType}, ${ref.size} base64 chars)`,
          };
        }

        // Charge admission before I/O. A missing/corrupt object remains charged,
        // keeping the request's maximum work deterministic.
        if (chargesCount) state.count += 1;
        state.declaredChars += ref.size;
        let data = "";
        try {
          const object = await this.deps.r2().get(ref.key);
          const objectSize = object
            ? Math.max(0, Math.floor(Number(object.size) || 0))
            : 0;
          if (object && (objectSize > ref.size || objectSize > availableChars)) {
            object.body?.cancel().catch(() => undefined);
            this.deps.recordReadOperation?.("provider_image_omitted");
            return {
              type: "text",
              text: `(image omitted from provider context: stored object exceeds hydration budget; ${ref.mimeType}, ${objectSize} base64 chars)`,
            };
          }
          // R2 exposes size before body materialization, so the aggregate limit
          // is enforced before object.text() allocates the base64 string.
          data = object ? await object.text() : "";
        } catch (error) {
          console.warn("[pi-core] failed to hydrate stored image", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (data) {
          this.deps.recordReadOperation?.("r2_image_hydrated");
          return {
            ...record,
            data,
            mimeType: ref.mimeType,
          };
        }
        this.deps.recordReadOperation?.("provider_image_omitted");
        return {
          type: "text",
          text: `(image data unavailable from persisted transcript: ${ref.mimeType}, ${ref.size} base64 chars)`,
        };
      }
    }
    const next: Record<string, unknown> = {};
    let changed = false;
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.hydratePiStoredImages(nested, budget, state);
      if (next[key] !== nested) changed = true;
    }
    return changed ? next : value;
  }

  async serializePiMessageForSqlStorageDetailed(message: AgentMessage): Promise<PiSqlStorageSerialization> {
    const stats = emptyPiSqlStorageStats();
    const providerSanitized = sanitizePiProviderMessage(message);
    // Put back anything the LOAD trimmed before the storage rules get a say —
    // otherwise a rewrite of a loaded list persists the working-set shape and
    // deletes the image from render forever (see restoreSessionExternalizedImages).
    const restored = await this.restoreSessionExternalizedImages(providerSanitized);
    const externalized = await this.externalizePiImagesForSqlStorage(restored, stats);
    let prepared = preparePiMessageForSqlStorage(externalized as AgentMessage, stats);
    let serialized = JSON.stringify(prepared);
    // Never stringify the unprojected source solely for diagnostics.
    stats.originalChars = serialized.length;
    if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
      stats.storedChars = serialized.length;
      return { payload: serialized, stats };
    }

    prepared = shrinkPiValueForSqlStorage(prepared, 4, stats) as AgentMessage;
    serialized = JSON.stringify(prepared);
    if (serialized.length <= PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS) {
      stats.storedChars = serialized.length;
      return { payload: serialized, stats };
    }

    stats.omittedWholeMessage = true;
    const payload = JSON.stringify({
      role: (message as unknown as Record<string, unknown>).role ?? "user",
      content: `[message omitted from persisted transcript: serialized size ${serialized.length} chars exceeded storage safety limit]`,
      timestamp:
        typeof (message as unknown as Record<string, unknown>).timestamp === "number"
          ? (message as unknown as Record<string, unknown>).timestamp
          : Date.now(),
      metadata: { storageOmitted: true },
    });
    stats.storedChars = payload.length;
    return { payload, stats };
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

  markPiCoreChanged(rowCount: number): void {
    this.ensurePiCoreTables();
    this.deps.sql().exec(
      `UPDATE pi_core_state
       SET generation = generation + 1, row_count = ?
       WHERE id = 1`,
      Math.max(0, Math.floor(rowCount)),
    );
  }

  async loadFullPiCoreTranscriptUnbounded(options: {
    includeUiMetadata?: boolean;
    imagePolicy?: PiCoreImagePolicy;
    imageHydrationBudget?: PiImageHydrationBudget;
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
    const hydrationState: PiImageHydrationState = { count: 0, declaredChars: 0 };
    for (const row of rows) {
      const message = await this.materializePiCoreRow(row.payload, options, hydrationState);
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
   * `imagePolicy`, sanitize. Returns null for a corrupt row — the whole-thread
   * load has always skipped those rather than failing the thread, and the
   * bounded window keeps the same rule.
   */
  private async materializePiCoreRow(
    payload: string,
    options: {
      includeUiMetadata?: boolean;
      imagePolicy?: PiCoreImagePolicy;
      imageHydrationBudget?: PiImageHydrationBudget;
    },
    hydrationState: PiImageHydrationState,
  ): Promise<AgentMessage | null> {
    try {
      this.deps.recordReadOperation?.("payload_row_parsed");
      const parsed = JSON.parse(payload) as AgentMessage;
      if (!parsed || typeof parsed !== "object" || !("role" in parsed)) return null;
      const imagePolicy = options.imagePolicy ?? "reference";
      const resolved = imagePolicy === "render"
        ? this.renderPiStoredImageReferences(parsed)
        : imagePolicy === "provider"
          ? await this.hydratePiStoredImages(
              parsed,
              options.imageHydrationBudget,
              hydrationState,
            )
          // The working-set policy: the session keeps references, never
          // multi-hundred-KB inline base64 (see
          // {@link PI_SESSION_INLINE_IMAGE_MAX_CHARS}). The row is untouched.
          : await this.externalizeOversizedInlineSessionImages(parsed);
      return options.includeUiMetadata
        ? sanitizePiProviderMessage(resolved as AgentMessage)
        : sanitizePiModelMessage(resolved as AgentMessage);
    } catch {
      // Skip corrupt rows rather than failing the whole thread.
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
   * The model-side session load, bounded by construction.
   *
   * Under {@link PI_SESSION_LOAD_MAX_CHARS} this is byte-for-byte the legacy
   * `loadFullPiCoreTranscriptUnbounded({ imagePolicy: "reference" })` — same rows, same order,
   * same summary prefix. Over it, the window is the newest turn-aligned tail
   * that fits, and the skipped prefix becomes a `[Context Summary]` PLACEHOLDER
   * so the model is told plainly what it cannot see instead of silently
   * believing the tail is the whole conversation.
   *
   * The placeholder is deliberately the same SHAPE a durable compaction summary
   * has, because that is what makes the next step work: `compactPiContext` reads
   * the returned {@link PiSessionLoadWindow} as the session's index space, cuts
   * within the loaded tail, summarizes the tail's older half (never the
   * placeholder — it is passed as `previousSummary`, so nothing is summarized
   * twice), and persists a REAL `pi_core_compaction` row at
   * `firstRowIdx + cut - summaryOffset`. From the next load on, the thread is an
   * ordinary summary+tail thread and never reaches this path again.
   *
   * What this does NOT do: touch a stored row, touch the render path (the
   * derive has its own bounded reader), or persist anything itself. A capped
   * load leaves storage exactly as it found it.
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
    const hydrationState: PiImageHydrationState = { count: 0, declaredChars: 0 };
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
        hydrationState,
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
   * The visible pi_core row range, plus the index shift the legacy full load
   * applies. {@link loadFullPiCoreTranscriptUnbounded} returns rows `idx >= firstKeptIndex` in
   * idx order, prefixed by the compaction summary when one is cut — and the
   * parsed render id of a row (`pi_user_<ts>_<index>`) is derived from its
   * position in THAT array. A windowed reader has to reproduce the same position
   * or it renames history, so it needs both numbers.
   */
  piCoreVisibleWindow(): {
    firstKeptIndex: number;
    summaryOffset: number;
    endIdx: number;
  } {
    this.ensurePiCoreTables();
    const compaction = this.loadPiCoreCompaction();
    const firstKeptIndex = compaction?.firstKeptIndex ?? 0;
    return {
      firstKeptIndex,
      summaryOffset: compaction && firstKeptIndex > 0 ? 1 : 0,
      endIdx: this.piCoreRowCount(),
    };
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
      this.deps.recordReadOperation?.("payload_row_parsed");
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

  /**
   * Stamp a toolResult row with the wall-clock duration measured live between
   * its tool_execution_start/end pair. Pi persists no start timestamp, and an
   * assistant row's `timestamp` marks when the model request opened, so a
   * duration derived after the fact from adjacent message timestamps would
   * silently include model latency. Recording it at commit time is the only
   * point where the real value is still known. UI-only metadata:
   * sanitizePiModelMessage strips it before anything reaches the provider.
   */
  private stampPiToolDuration(message: AgentMessage): AgentMessage {
    const take = this.deps.takeToolDurationMs;
    if (!take) return message;
    const record = message as unknown as Record<string, unknown>;
    if (record.role !== "toolResult") return message;
    const toolCallId =
      typeof record.toolCallId === "string" ? record.toolCallId.trim() : "";
    if (!toolCallId) return message;
    const durationMs = take.call(this.deps, toolCallId);
    if (typeof durationMs !== "number") return message;
    const existing = normalizePiUiMetadata(record.uiMetadata);
    return {
      ...record,
      uiMetadata: { ...existing, toolDurationMs: durationMs },
    } as unknown as AgentMessage;
  }

  async appendPiCoreMessages(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;
    this.ensurePiCoreTables();
    const revisionBeforeAppend = this.getPiCoreRevision();
    const rows = this.deps.sql()
      .exec<{ next_idx: number }>(
        "SELECT COALESCE(MAX(idx) + 1, 0) AS next_idx FROM pi_core_messages",
      )
      .toArray();
    const startIndex = Math.max(0, Math.floor(Number(rows[0]?.next_idx) || 0));
    const now = Date.now();
    for (let offset = 0; offset < messages.length; offset += 1) {
      const message = this.stampPiToolDuration(messages[offset]);
      const serialized = await this.serializePiMessageForSqlStorageDetailed(message);
      this.deps.sql().exec(
        "INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)",
        startIndex + offset,
        serialized.payload,
        now,
      );
      // Keep the scalar preflight in lockstep before the next serialization
      // await, so an eviction can never leave durable rows behind its revision.
      this.markPiCoreChanged(revisionBeforeAppend.count + offset + 1);
    }
  }

  async appendPiCoreMessagesIfMissing(messages: AgentMessage[]): Promise<void> {
    if (messages.length === 0) return;
    // Identity does not depend on provider image bytes. Keep compact external
    // references so dedup never downloads an entire historical image set.
    const existingMessages = await this.loadFullPiCoreTranscriptUnbounded({ imagePolicy: "reference" });
    const existingKeys = new Set(
      existingMessages.map((message) => piCoreMessageKey(message)),
    );
    const missing = messages.filter((message) => {
      const key = piCoreMessageKey(message);
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    await this.appendPiCoreMessages(missing);
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

  persistPiCoreCompaction(summary: string, firstKeptIndex: number): void {
    this.ensurePiCoreTables();
    const normalized = Math.max(0, Math.floor(firstKeptIndex));
    // Backstop for the caller's own committed-bound check: a cut that names rows
    // pi_core does not have cannot be expressed as an `idx >= ?` predicate, and
    // writing it anyway would truncate the thread to the summary alone. Dropping
    // the write costs one uncompacted request; writing it costs the history.
    if (normalized > this.piCoreRowCount()) return;
    this.deps.sql().exec(
      `INSERT OR REPLACE INTO pi_core_compaction (id, summary, first_kept_index, updated_at)
       VALUES (1, ?, ?, ?)`,
      summary,
      normalized,
      Date.now(),
    );
    this.markPiCoreChanged(this.getPiCoreRevision().count);
  }

  clearPiCoreCompaction(): void {
    this.ensurePiCoreTables();
    const changed = this.loadPiCoreCompaction() !== null;
    this.deps.sql().exec("DELETE FROM pi_core_compaction");
    if (changed) this.markPiCoreChanged(this.getPiCoreRevision().count);
  }
}
