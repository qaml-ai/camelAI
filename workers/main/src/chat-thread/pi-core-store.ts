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

export const PI_PROVIDER_IMAGE_HYDRATION_MAX_COUNT = 2;
export const PI_PROVIDER_IMAGE_HYDRATION_MAX_DECLARED_CHARS = 6_000_000;

export interface PiImageHydrationBudget {
  maxCount: number;
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

export interface PiCoreMessageStoreDeps {
  sql(): SqlStorage;
  r2(): R2Bucket;
  chatContext(): ChatContextState | null;
  /** Privacy-safe allocation counters used by focused tests and diagnostics. */
  recordReadOperation?(operation: "payload_row_parsed" | "r2_image_hydrated"): void;
  /**
   * Wall-clock duration measured for a settled tool call, consumed once as its
   * toolResult row is committed. Optional so tests and non-agent callers can
   * construct the store without a timing source.
   */
  takeToolDurationMs?(toolCallId: string): number | undefined;
}

export class PiCoreMessageStore {
  constructor(private readonly deps: PiCoreMessageStoreDeps) {}

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
      const hydrated = new Array<unknown>(value.length);
      // Prefer recent provider context and avoid concurrently materializing
      // several R2 bodies/base64 strings. The source/session graph is untouched.
      for (let index = value.length - 1; index >= 0; index -= 1) {
        hydrated[index] = await this.hydratePiStoredImages(value[index], budget, state);
      }
      return hydrated;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "image") {
      const ref = this.readPiR2ImageReference(record);
      if (ref && typeof record.data === "string" && record.data.length === 0) {
        const availableChars = Math.max(0, budget.maxDeclaredChars - state.declaredChars);
        if (state.count >= budget.maxCount || ref.size > availableChars) {
          return {
            type: "text",
            text: `(image omitted from provider context: hydration budget exceeded; ${ref.mimeType}, ${ref.size} base64 chars)`,
          };
        }

        // Charge admission before I/O. A missing/corrupt object remains charged,
        // keeping the request's maximum work deterministic.
        state.count += 1;
        state.declaredChars += ref.size;
        let data = "";
        try {
          const object = await this.deps.r2().get(ref.key);
          const objectSize = object
            ? Math.max(0, Math.floor(Number(object.size) || 0))
            : 0;
          if (object && (objectSize > ref.size || objectSize > availableChars)) {
            object.body?.cancel().catch(() => undefined);
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
        return {
          type: "text",
          text: `(image data unavailable from persisted transcript: ${ref.mimeType}, ${ref.size} base64 chars)`,
        };
      }
    }
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      next[key] = await this.hydratePiStoredImages(nested, budget, state);
    }
    return next;
  }

  async serializePiMessageForSqlStorageDetailed(message: AgentMessage): Promise<PiSqlStorageSerialization> {
    const stats = emptyPiSqlStorageStats();
    const providerSanitized = sanitizePiProviderMessage(message);
    const externalized = await this.externalizePiImagesForSqlStorage(providerSanitized, stats);
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

  async loadPiCoreMessages(options: {
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
      try {
        this.deps.recordReadOperation?.("payload_row_parsed");
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const imagePolicy = options.imagePolicy ?? "reference";
          const resolved = imagePolicy === "render"
            ? this.renderPiStoredImageReferences(parsed)
            : imagePolicy === "provider"
              ? await this.hydratePiStoredImages(
                  parsed,
                  options.imageHydrationBudget,
                  hydrationState,
                )
              : parsed;
          messages.push(options.includeUiMetadata
            ? sanitizePiProviderMessage(resolved as AgentMessage)
            : sanitizePiModelMessage(resolved as AgentMessage));
        }
      } catch {
        // Skip corrupt rows rather than failing the whole thread.
      }
    }
    if (!compaction || firstKeptIndex <= 0) return messages;
    return [
      createPiSummaryMessage(compaction.summary, compaction.updatedAt),
      ...messages,
    ];
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
    const existingMessages = await this.loadPiCoreMessages({ imagePolicy: "reference" });
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

  loadPiCoreCompaction(): { summary: string; firstKeptIndex: number; updatedAt: number } | null {
    this.ensurePiCoreTables();
    const rows = this.deps.sql()
      .exec<{ summary: string; first_kept_index: number; updated_at: number }>(
        "SELECT summary, first_kept_index, updated_at FROM pi_core_compaction WHERE id = 1",
      )
      .toArray();
    const row = rows[0];
    if (!row || typeof row.summary !== "string") return null;
    return {
      summary: row.summary,
      firstKeptIndex: Math.max(0, Math.floor(Number(row.first_kept_index) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(row.updated_at) || 0)),
    };
  }

  persistPiCoreCompaction(summary: string, firstKeptIndex: number): void {
    this.ensurePiCoreTables();
    this.deps.sql().exec(
      `INSERT OR REPLACE INTO pi_core_compaction (id, summary, first_kept_index, updated_at)
       VALUES (1, ?, ?, ?)`,
      summary,
      Math.max(0, Math.floor(firstKeptIndex)),
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
