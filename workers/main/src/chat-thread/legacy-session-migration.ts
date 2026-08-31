import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { parseMessageAuthor } from "../../../../src/lib/message-author";
import { preflightJson } from "./bounded-json-parse";
import { utf8ByteLength } from "./utf8-byte-length";
export type LegacyMigrationState = "unseen" | "pending" | "complete" | "failed";
type LegacySource = "pi_core" | "ai_chat" | "none" | "v2" | null;
export interface LegacyMigrationStatus {
  state: LegacyMigrationState; attemptCount: number; attemptToken: string | null;
  deadlineAt: number | null; importedTurns: number; importedBytes: number;
  source: LegacySource; error: string | null; changed: boolean;
}
export type LegacyMigrationScope = { threadId: string; workspaceId: string; orgId: string };
interface MigrationRow {
  [key: string]: string | number | null;
  state: Exclude<LegacyMigrationState, "unseen">; attempt_count: number;
  attempt_token: string | null; deadline_at: number; imported_turns: number;
  imported_bytes: number; source: LegacySource; error: string | null;
}
type LegacyRow = { key: number; id: string; payload: Record<string, unknown> | null; createdAt: number };
type LegacyRowMeta = {
  key: number; id: string | null; bytes: number;
  created_at: number | string; cursor_key: number | string;
};
type LegacyTurn = {
  id: string; userContent: string; userDisplay: string;
  assistantFinal: string; createdAt: number; updatedAt: number;
};
type ScanResult = { turns: LegacyTurn[]; bytes: number; source: Exclude<LegacySource, "v2" | null> };
type ScanBudget = {
  rows: number; bytes: number; tokens: number; nodes: number;
  entries: number; strings: number; stringCodeUnits: number;
};
type PiTurn = {
  id: string; userContent: string; userDisplay: string; createdAt: number;
  updatedAt: number; assistantParts: string[];
  pendingCalls: Map<string, string>; terminal: boolean;
};
type AiMessage = { role: "user" | "assistant"; id: string; text: string;
  createdAt: number; completion: "explicit" | "boundary" | null;
  followup: boolean; steerIds: string[] };
type PiCompaction = { firstKeptIndex: number; summary: string | null };
class LegacyMigrationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "LegacyMigrationError"; }
}
class StaleLegacyMigrationAttempt extends Error {}
const MIGRATION_TABLE = "chat_legacy_migration_v2";
const PI_TABLE = "pi_core_messages";
const PI_COMPACTION_TABLE = "pi_core_compaction";
const AI_CHAT_TABLE = "cf_ai_chat_agent_messages";
const AI_CHAT_META_TABLE = "cf_ai_chat_render_history_meta";
const EMPTY_CHECKPOINT_JSON =
  '{"version":1,"providerCalls":0,"providerInFlight":false,"batches":[],"final":null}';
const FOLLOWUP_SEPARATOR = "\n\n[Follow-up]\n";
const byteLength = utf8ByteLength;
const yieldToTransport = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
const JSON_ROW_LIMITS = Object.freeze({
  depth: 32, tokens: 65_536, nodes: 16_384, entries: 16_384, strings: 8_192,
  stringCodeUnits: CHAT_RUNTIME_BOUNDS.legacyMigrationRowBytes,
});
const JSON_SCAN_LIMITS = Object.freeze({
  tokens: 262_144, nodes: 65_536, entries: 65_536, strings: 32_768,
  stringCodeUnits: CHAT_RUNTIME_BOUNDS.legacyMigrationBytes,
});
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const boundedInteger = (value: unknown): number =>
  Math.max(0, Math.floor(Number(value) || 0));
const finiteTime = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return boundedInteger(value);
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
    if (Number.isFinite(parsed)) return boundedInteger(parsed);
  }
  return boundedInteger(fallback);
};
function tableExists(sql: SqlStorage, name: string): boolean {
  return Boolean(sql.exec<{ present: number }>(
        `SELECT EXISTS(
           SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
         ) AS present`,
        name,
      ).one().present);
}
function hasCompleteAiChatChronology(sql: SqlStorage): boolean {
  if (!tableExists(sql, AI_CHAT_META_TABLE)) return false;
  return Boolean(sql.exec<{ ready: number }>(
        `SELECT EXISTS(SELECT 1 FROM ${AI_CHAT_META_TABLE}
          WHERE key = 'metadata_v1' AND value = 1) AND EXISTS(
          SELECT 1 FROM sqlite_master WHERE type = 'index'
            AND name = 'cf_ai_chat_agent_messages_chronology') AS ready`,
      ).one().ready);
}
function unseenStatus(): LegacyMigrationStatus {
  return {
    state: "unseen", attemptCount: 0, attemptToken: null, deadlineAt: null,
    importedTurns: 0, importedBytes: 0, source: null, error: null, changed: false,
  };
}
function statusFromRow(row: MigrationRow, changed = false): LegacyMigrationStatus {
  return {
    state: row.state, attemptCount: Number(row.attempt_count),
    attemptToken: row.attempt_token, deadlineAt: Number(row.deadline_at),
    importedTurns: Number(row.imported_turns), importedBytes: Number(row.imported_bytes),
    source: row.source, error: row.error, changed,
  };
}
function migrationRow(sql: SqlStorage): MigrationRow | null {
  if (!tableExists(sql, MIGRATION_TABLE)) return null;
  return sql.exec<MigrationRow>(
        `SELECT state, attempt_count, attempt_token, deadline_at,
                imported_turns, imported_bytes, source, error
           FROM ${MIGRATION_TABLE} WHERE singleton = 1`,
      ).toArray()[0] ?? null;
}
function isStreamingFollowup(message: Record<string, unknown>): boolean {
  return (
    message.sentDuringStreaming === true ||
    recordOf(message.metadata)?.sentDuringStreaming === true ||
    recordOf(message.uiMetadata)?.sentDuringStreaming === true
  );
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const text: string[] = [];
  for (const item of value) {
    const part = recordOf(item);
    if (typeof part?.text === "string") text.push(part.text);
    else if (part?.type === "image") text.push("[image]");
  }
  return text.join("\n");
}
function parsePayload(
  json: string,
  budget: ScanBudget,
): Record<string, unknown> | null {
  const reserved = {
    tokens: Math.min(JSON_ROW_LIMITS.tokens, budget.tokens),
    nodes: Math.min(JSON_ROW_LIMITS.nodes, budget.nodes),
    entries: Math.min(JSON_ROW_LIMITS.entries, budget.entries),
    strings: Math.min(JSON_ROW_LIMITS.strings, budget.strings),
    stringCodeUnits: Math.min(
      JSON_ROW_LIMITS.stringCodeUnits,
      budget.stringCodeUnits,
    ),
  };
  try {
    const stats = preflightJson(json, {
      maxDepth: JSON_ROW_LIMITS.depth,
      maxTokens: reserved.tokens,
      maxNodes: reserved.nodes,
      maxEntries: reserved.entries,
      maxStrings: reserved.strings,
      maxStringCodeUnits: reserved.stringCodeUnits,
    });
    budget.tokens -= stats.tokens;
    budget.nodes -= stats.nodes;
    budget.entries -= stats.entries;
    budget.strings -= stats.strings;
    budget.stringCodeUnits -= stats.stringCodeUnits;
    return recordOf(JSON.parse(json) as unknown);
  } catch {
    // A failed lexical pass cannot charge any dimension more than the input
    // length before stopping. Conservatively account for that work so short
    // corrupt rows do not hide all older history.
    budget.tokens -= Math.min(reserved.tokens, json.length);
    budget.nodes -= Math.min(reserved.nodes, json.length);
    budget.entries -= Math.min(reserved.entries, json.length);
    budget.strings -= Math.min(reserved.strings, json.length);
    budget.stringCodeUnits -= Math.min(reserved.stringCodeUnits, json.length);
    return null;
  }
}
function parseToolCalls(
  content: unknown,
): Array<{ id: string; name: string }> | null {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  const ids = new Set<string>();
  for (const item of content) {
    const part = recordOf(item);
    if (!part || (part.type !== "toolCall" && part.type !== "tool_use")) {
      continue;
    }
    const id = String(part.id ?? part.toolCallId ?? "").trim();
    const name = String(part.name ?? part.toolName ?? "").trim();
    if (
      !id ||
      !name ||
      id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
      name.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
      ids.has(id) ||
      calls.length >= CHAT_RUNTIME_BOUNDS.toolCallsPerTurn
    ) {
      return null;
    }
    ids.add(id);
    calls.push({ id, name });
  }
  return calls;
}
function settlePi(builder: PiTurn | null): LegacyTurn | null {
  if (!builder || !builder.terminal || builder.pendingCalls.size !== 0) {
    return null;
  }
  const assistantFinal = builder.assistantParts.filter(Boolean).join("\n\n");
  if (
    !assistantFinal ||
    byteLength(assistantFinal) > CHAT_RUNTIME_BOUNDS.assistantBytes
  ) {
    return null;
  }
  return {
    id: builder.id,
    userContent: builder.userContent,
    userDisplay: builder.userDisplay,
    assistantFinal,
    createdAt: builder.createdAt,
    updatedAt: builder.updatedAt,
  };
}
function parsePiTurns(
  rows: readonly LegacyRow[],
  checkDeadline: () => void,
): LegacyTurn[] {
  const turns: LegacyTurn[] = [];
  let builder: PiTurn | null = null;
  const settle = () => {
    const turn = settlePi(builder);
    if (turn) turns.push(turn);
    builder = null;
  };
  for (const row of rows) {
    checkDeadline();
    const message = row.payload;
    if (!message || !message.role) {
      settle();
      continue;
    }
    if (message.visibility === "hidden") continue;
    if (message.role === "user") {
      const followup = isStreamingFollowup(message);
      if (!followup) settle();
      const content = textContent(message.content);
      if (!content || byteLength(content) > CHAT_RUNTIME_BOUNDS.requestBytes)
        { if (followup) builder = null; continue; }
      if (followup) {
        if (!builder) continue;
        const combined = `${builder.userContent}${FOLLOWUP_SEPARATOR}${content}`;
        if (byteLength(combined) > CHAT_RUNTIME_BOUNDS.requestBytes)
          { builder = null; continue; }
        builder.userContent = combined;
        builder.userDisplay += `${FOLLOWUP_SEPARATOR}${parseMessageAuthor(content).content}`;
        builder.updatedAt = Math.max(builder.updatedAt, finiteTime(message.timestamp, row.createdAt));
        builder.terminal = false;
        continue;
      }
      const createdAt = finiteTime(message.timestamp, row.createdAt);
      builder = { id: `legacy:pi:${row.key}`, userContent: content,
        userDisplay: parseMessageAuthor(content).content,
        createdAt, updatedAt: createdAt, assistantParts: [],
        pendingCalls: new Map(), terminal: false,
      };
      continue;
    }
    if (!builder) continue;
    builder.updatedAt = Math.max(
      builder.updatedAt,
      finiteTime(message.timestamp, row.createdAt),
    );
    if (message.role === "assistant") {
      if (
        message.stopReason === "aborted" ||
        message.stopReason === "error" ||
        builder.pendingCalls.size > 0
      ) {
        builder = null;
        continue;
      }
      const calls = parseToolCalls(message.content);
      if (!calls) { builder = null; continue; }
      for (const call of calls) builder.pendingCalls.set(call.id, call.name);
      const text = textContent(message.content);
      if (text) builder.assistantParts.push(text);
      builder.terminal = calls.length === 0 && Boolean(text);
      continue;
    }
    if (message.role === "toolResult") {
      const id = String(message.toolCallId ?? message.tool_use_id ?? "").trim();
      const expectedName = builder.pendingCalls.get(id);
      const actualName =
        typeof message.toolName === "string" ? message.toolName.trim() : "";
      if (!id || !expectedName || (actualName && actualName !== expectedName)) {
        builder = null;
        continue;
      }
      builder.pendingCalls.delete(id);
      builder.terminal = false;
      continue;
    }
    builder = null;
  }
  settle();
  return turns;
}
function parseAiMessage(
  row: LegacyRow,
  checkDeadline: () => void,
): AiMessage | null {
  const message = row.payload;
  if (!message || (message.role !== "user" && message.role !== "assistant")) {
    return null;
  }
  if (!Array.isArray(message.parts)) return null;
  const text: string[] = [], toolIds = new Set<string>(), steerIds: string[] = [];
  for (const raw of message.parts) {
    checkDeadline();
    const part = recordOf(raw);
    if (!part || typeof part.type !== "string") return null;
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text) text.push(part.text);
      if (
        typeof part.state === "string" &&
        part.state !== "done" &&
        part.state !== "output-available"
      ) {
        return null;
      }
      continue;
    }
    if (part.type === "reasoning") {
      if (part.state !== undefined && part.state !== "done") return null;
      continue;
    }
    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const id =
        typeof part.toolCallId === "string" ? part.toolCallId.trim() : "";
      if (!id || id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
        toolIds.has(id) || toolIds.size >= CHAT_RUNTIME_BOUNDS.toolCallsPerTurn ||
        (part.state !== "output-available" && part.state !== "output-error")) return null;
      toolIds.add(id);
      continue;
    }
    if (part.type === "data-pi-steer-marker") {
      const id = String(recordOf(part.data)?.steerMessageId ?? "").trim();
      if (!id || id.length > CHAT_RUNTIME_BOUNDS.identifierChars || steerIds.includes(id))
        return null;
      steerIds.push(id);
      continue;
    }
    if (part.type !== "step-start") return null;
  }
  const joined = text.join("\n");
  const limit = message.role === "user" ? CHAT_RUNTIME_BOUNDS.requestBytes
    : CHAT_RUNTIME_BOUNDS.assistantBytes;
  if (!joined || byteLength(joined) > limit) return null;
  const pi = recordOf(recordOf(message.metadata)?.pi);
  const completion =
    message.role === "user" ||
    (typeof pi?.completedAtMs === "number" && pi.completedAtMs > 0)
      ? "explicit"
      : typeof pi?.createdAtMs === "number" && pi.createdAtMs > 0
        ? "boundary"
        : null;
  const rawId = typeof message.id === "string" && message.id.trim()
    ? message.id.trim() : row.id;
  return {
    role: message.role,
    id: rawId,
    text: joined,
    createdAt: finiteTime(pi?.createdAtMs ?? pi?.completedAtMs, row.createdAt),
    completion,
    followup: isStreamingFollowup(message),
    steerIds,
  };
}
function parseAiTurns(
  rows: readonly LegacyRow[],
  checkDeadline: () => void,
): LegacyTurn[] {
  const messages = rows.map((row) => parseAiMessage(row, checkDeadline));
  const followups = new Map<string, AiMessage | null>();
  const marked = new Set<string>();
  for (const message of messages) {
    if (!message) continue;
    if (message.role === "user" && message.followup)
      followups.set(message.id, followups.has(message.id) ? null : message);
    for (const id of message.steerIds) marked.add(id);
  }
  const turns: LegacyTurn[] = [];
  let user: AiMessage | null = null;
  let assistantParts: string[] = [], assistantBytes = 0, assistantAt = 0;
  let completion: AiMessage["completion"] = null;
  let assistantValid = true;
  const append = (text: string) => {
    if (!user) return false;
    const combined = `${user.text}${FOLLOWUP_SEPARATOR}${text}`;
    if (byteLength(combined) > CHAT_RUNTIME_BOUNDS.requestBytes) return false;
    user = { ...user, text: combined }; completion = null; return true;
  };
  const settle = (laterUser: boolean) => {
    const assistantFinal = assistantParts.filter(Boolean).join("\n\n");
    if (user && assistantFinal && (completion === "explicit" || (laterUser && completion === "boundary"))) {
      turns.push({ id: `legacy:ai:${user.id.slice(0, CHAT_RUNTIME_BOUNDS.identifierChars - 10)}`,
        userContent: user.text, userDisplay: user.text, assistantFinal,
        createdAt: user.createdAt,
        updatedAt: Math.max(user.createdAt, assistantAt),
      });
    }
    user = null; assistantParts = []; assistantBytes = assistantAt = 0;
    completion = null; assistantValid = true;
  };
  const claimed = new Set<string>();
  for (const message of messages) {
    checkDeadline();
    if (!message) { settle(false); continue; }
    if (message.role === "user") {
      if (message.followup) {
        if (!marked.has(message.id) && !append(message.text)) settle(false);
        continue;
      }
      settle(true); user = message; continue;
    }
    if (!user) continue;
    let valid: boolean = assistantValid && Boolean(message.completion);
    for (const id of message.steerIds) {
      const steer = followups.get(id);
      if (!steer || claimed.has(id) || !append(steer.text)) valid = false;
      else claimed.add(id);
    }
    const nextBytes = assistantBytes + (assistantParts.length ? 2 : 0) +
      byteLength(message.text);
    if (nextBytes <= CHAT_RUNTIME_BOUNDS.assistantBytes) {
      assistantParts.push(message.text);
      assistantBytes = nextBytes;
    } else valid = false;
    assistantValid = valid;
    assistantAt = Math.max(assistantAt, message.createdAt);
    completion = valid ? message.completion : null;
  }
  settle(false);
  return turns;
}
function selectNewest(
  turns: readonly LegacyTurn[],
  checkDeadline: () => void,
): Omit<ScanResult, "source"> {
  const selected: LegacyTurn[] = [];
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    checkDeadline();
    if (selected.length >= CHAT_RUNTIME_BOUNDS.historyTurns) break;
    const turn = turns[index];
    const turnBytes = byteLength(
      JSON.stringify({
        content: turn.userContent,
        display: turn.userDisplay,
        assistant: turn.assistantFinal,
      }),
    );
    if (turnBytes > CHAT_RUNTIME_BOUNDS.legacyMigrationBytes) continue;
    if (bytes + turnBytes > CHAT_RUNTIME_BOUNDS.legacyMigrationBytes) break;
    selected.unshift(turn);
    bytes += turnBytes;
  }
  return { turns: selected, bytes };
}
export class LegacySessionMigrator {
  private readonly sql: SqlStorage;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly now: () => number = Date.now,
  ) {
    this.sql = storage.sql;
  }
  status(): LegacyMigrationStatus {
    const row = migrationRow(this.sql);
    return row ? statusFromRow(row) : unseenStatus();
  }
  claimBlocked(): boolean { return legacyMigrationBlocksClaim(this.sql); }
  nextAlarmAt(now = this.now()): number | null {
    const status = this.status();
    if (status.state !== "pending" || status.deadlineAt === null) return null;
    return Math.min(status.deadlineAt,
      boundedInteger(now) + CHAT_RUNTIME_BOUNDS.legacyMigrationRetryMs);
  }
  requestAfterOpen(scope: LegacyMigrationScope, at: number): LegacyMigrationStatus {
    const ids = [scope.threadId, scope.workspaceId, scope.orgId];
    if (ids.some((id) => !id || id.length > CHAT_RUNTIME_BOUNDS.identifierChars) ||
      !tableExists(this.sql, "chat_runtime_v2")) return this.status();
    this.ensureTable();
    const now = boundedInteger(at);
    return this.storage.transactionSync(() => {
      const existing = migrationRow(this.sql);
      if (existing) return statusFromRow(existing);
      const runtime = this.sql
        .exec<{
          thread_id: string | null;
          workspace_id: string | null;
          org_id: string | null;
        }>(
          `SELECT thread_id, workspace_id, org_id
             FROM chat_runtime_v2 WHERE singleton = 1`,
        )
        .toArray()[0];
      if (!runtime) return unseenStatus();
      const stored = [runtime.thread_id, runtime.workspace_id, runtime.org_id];
      if (stored.some((id, index) => id !== null && id !== ids[index])) {
        return unseenStatus();
      }
      this.sql.exec(
        `UPDATE chat_runtime_v2 SET thread_id = ?, workspace_id = ?, org_id = ?
          WHERE singleton = 1`,
        ...ids,
      );
      this.sql.exec(
        `INSERT INTO ${MIGRATION_TABLE}
          (singleton, state, attempt_count, attempt_token, deadline_at,
           imported_turns, imported_bytes, source, error, started_at, updated_at)
         VALUES (1, 'pending', 0, NULL, ?, 0, 0, 'none', NULL, ?, ?)`,
        now + CHAT_RUNTIME_BOUNDS.legacyMigrationDeadlineMs,
        now,
        now,
      );
      this.bumpRevision();
      return statusFromRow(migrationRow(this.sql) as MigrationRow, true);
    });
  }
  async runAfterTrigger(at: number, attemptToken: string): Promise<LegacyMigrationStatus> {
    const now = boundedInteger(at);
    if (!attemptToken || attemptToken.length > CHAT_RUNTIME_BOUNDS.identifierChars)
      return this.status();
    const existing = migrationRow(this.sql);
    if (existing?.state === "complete" || existing?.state === "failed") {
      return statusFromRow(existing);
    }
    const admitted = this.hasAdmittedTurn(now);
    const opened = existing?.state === "pending" && existing.source === "none";
    if (!existing && !admitted) return unseenStatus();
    this.ensureTable();
    if (existing?.state === "pending" && !opened && !admitted) {
      return this.storage.transactionSync(() =>
        this.failInTransaction("legacy_migration_admission_missing"),
      );
    }
    if (this.hasSettledV2History()) {
      if (existing && Number(existing.attempt_count) > 0) {
        return this.storage.transactionSync(() =>
          this.failInTransaction("v2_runtime_changed_during_migration"),
        );
      }
      return this.completeExistingV2(now, attemptToken);
    }
    const claimed = this.claimAttempt(now, attemptToken);
    if (claimed.state !== "pending" || claimed.attemptToken !== attemptToken) {
      return claimed;
    }
    try {
      const selection = await this.scanLegacy(
        claimed.deadlineAt as number,
        attemptToken,
      );
      return this.commit(attemptToken, selection);
    } catch (error) {
      if (error instanceof StaleLegacyMigrationAttempt) return this.status();
      if (error instanceof LegacyMigrationError) {
        return this.recordAttemptError(
          attemptToken,
          error.code,
          error.code === "legacy_row_changed_during_read",
        );
      }
      return this.recordAttemptError(
        attemptToken,
        "legacy_migration_read_failed",
        true,
      );
    }
  }
  private hasAdmittedTurn(now: number): boolean {
    if (!tableExists(this.sql, "chat_turns_v2")) return false;
    return Boolean(
      this.sql
        .exec<{ present: number }>(
          `SELECT EXISTS(
             SELECT 1 FROM chat_turns_v2
              WHERE status IN ('queued','running') AND terminal_deadline_at > ?
           ) AS present`,
          now,
        )
        .one().present,
    );
  }
  private hasSettledV2History(): boolean {
    if (!tableExists(this.sql, "chat_turns_v2")) return false;
    return Boolean(
      this.sql
        .exec<{ present: number }>(
          `SELECT EXISTS(
             SELECT 1 FROM chat_turns_v2
              WHERE status IN ('completed','failed','interrupted')
                 OR source IN ('fork','legacy_migration')
           ) AS present`,
        )
        .one().present,
    );
  }
  private ensureTable(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      state TEXT NOT NULL CHECK(state IN ('pending','complete','failed')),
      attempt_count INTEGER NOT NULL CHECK(
        attempt_count BETWEEN 0 AND ${CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts}
      ),
      attempt_token TEXT,
      deadline_at INTEGER NOT NULL,
      imported_turns INTEGER NOT NULL DEFAULT 0,
      imported_bytes INTEGER NOT NULL DEFAULT 0,
      source TEXT CHECK(source IN ('pi_core','ai_chat','none','v2')),
      error TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }
  private claimAttempt(now: number, token: string): LegacyMigrationStatus {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT OR IGNORE INTO ${MIGRATION_TABLE}
          (singleton, state, attempt_count, attempt_token, deadline_at,
           imported_turns, imported_bytes, source, error, started_at, updated_at)
         VALUES (1, 'pending', 0, NULL, ?, 0, 0, NULL, NULL, ?, ?)`,
        now + CHAT_RUNTIME_BOUNDS.legacyMigrationDeadlineMs,
        now,
        now,
      );
      const row = migrationRow(this.sql) as MigrationRow;
      if (row.state !== "pending") return statusFromRow(row);
      if (now >= Number(row.deadline_at))
        return this.failInTransaction("legacy_migration_deadline");
      if (Number(row.attempt_count) >= CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts)
        return this.failInTransaction("legacy_migration_attempts_exhausted");
      const claimed = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE}
              SET attempt_count = attempt_count + 1, attempt_token = ?,
                  error = NULL
            WHERE singleton = 1 AND state = 'pending'
              AND attempt_count < ? AND deadline_at > ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          token,
          CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts,
          now,
        )
        .toArray()[0];
      if (!claimed)
        return statusFromRow(migrationRow(this.sql) as MigrationRow);
      this.bumpRevision();
      return statusFromRow(claimed, true);
    });
  }
  private completeExistingV2(now: number, token: string): LegacyMigrationStatus {
    const claimed = this.claimAttempt(now, token);
    if (claimed.state !== "pending" || claimed.attemptToken !== token) return claimed;
    return this.storage.transactionSync(() => {
      const completed = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE}
              SET state = 'complete', attempt_token = NULL, source = 'v2',
                  error = NULL
            WHERE singleton = 1 AND state = 'pending' AND attempt_token = ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          token,
        )
        .one();
      this.bumpRevision();
      return statusFromRow(completed, true);
    });
  }
  private async scanLegacy(deadlineAt: number, token: string): Promise<ScanResult> {
    const budget: ScanBudget = {
      rows: CHAT_RUNTIME_BOUNDS.legacyMigrationScanRows,
      bytes: CHAT_RUNTIME_BOUNDS.legacyMigrationBytes,
      ...JSON_SCAN_LIMITS,
    };
    this.assertOwned(token, deadlineAt);
    if (tableExists(this.sql, PI_TABLE)) {
      const compaction = this.readPiCompaction(deadlineAt, token, budget);
      const rows = await this.readNewestRows(PI_TABLE, deadlineAt, token,
        budget, compaction.firstKeptIndex);
      const check = () => this.assertWithinDeadline(deadlineAt);
      const turns = parsePiTurns(rows, check);
      if (turns.length && compaction.summary) {
        const newest = turns.length - 1;
        const combined = `[Context Summary]\n\n${compaction.summary}\n\n${turns[newest].userContent}`;
        if (byteLength(combined) > CHAT_RUNTIME_BOUNDS.requestBytes)
          throw new LegacyMigrationError("legacy_summary_too_large");
        turns[newest] = { ...turns[newest], userContent: combined };
      }
      const selection = selectNewest(turns, check);
      if (selection.turns.length) return { ...selection, source: "pi_core" };
      if (compaction.firstKeptIndex > 0)
        return { turns: [], bytes: 0, source: "none" };
    }
    this.assertOwned(token, deadlineAt);
    if (tableExists(this.sql, AI_CHAT_TABLE)) {
      const rows = await this.readNewestRows(
        AI_CHAT_TABLE,
        deadlineAt,
        token,
        budget,
      );
      const check = () => this.assertWithinDeadline(deadlineAt);
      const selection = selectNewest(parseAiTurns(rows, check), check);
      return {
        ...selection,
        source: selection.turns.length ? "ai_chat" : "none",
      };
    }
    return { turns: [], bytes: 0, source: "none" };
  }
  private async readNewestRows(
    table: typeof PI_TABLE | typeof AI_CHAT_TABLE,
    deadlineAt: number,
    token: string,
    budget: ScanBudget,
    minimumPiIndex = 0,
  ): Promise<LegacyRow[]> {
    const rows: LegacyRow[] = [];
    const usesChronology =
      table === AI_CHAT_TABLE && hasCompleteAiChatChronology(this.sql);
    let numericCursor = Number.MAX_SAFE_INTEGER;
    let chronologyCursor = "\uffff";
    let userRows = 0;
    while (
      budget.rows > 0 &&
      budget.bytes > 0 &&
      budget.tokens > 0 &&
      budget.nodes > 0 &&
      budget.entries > 0 &&
      budget.strings > 0 &&
      budget.stringCodeUnits > 0 &&
      userRows <= CHAT_RUNTIME_BOUNDS.historyTurns
    ) {
      this.assertOwned(token, deadlineAt);
      const pageSize = Math.min(
        CHAT_RUNTIME_BOUNDS.legacyMigrationPageRows,
        budget.rows,
      );
      const metadata = this.readMetadata(
        table,
        pageSize,
        numericCursor,
        chronologyCursor,
        usesChronology,
        minimumPiIndex,
      );
      if (!metadata.length) break;
      budget.rows -= metadata.length;
      for (const meta of metadata) {
        this.assertWithinDeadline(deadlineAt);
        if (usesChronology) chronologyCursor = String(meta.cursor_key);
        else numericCursor = Math.min(numericCursor, Number(meta.cursor_key));
        const boundary: LegacyRow = {
          key: Number(meta.key),
          id: meta.id ?? String(meta.key),
          payload: null,
          createdAt: finiteTime(meta.created_at),
        };
        const expectedBytes = boundedInteger(meta.bytes);
        if (
          expectedBytes === 0 ||
          expectedBytes > CHAT_RUNTIME_BOUNDS.legacyMigrationRowBytes
        ) {
          rows.push(boundary);
          continue;
        }
        if (expectedBytes > budget.bytes) {
          budget.bytes = 0;
          rows.push(boundary);
          break;
        }
        const body = this.readPayload(table, meta);
        if (typeof body !== "string") {
          rows.push(boundary);
          continue;
        }
        const actualBytes = byteLength(body);
        if (actualBytes !== expectedBytes) {
          throw new LegacyMigrationError("legacy_row_changed_during_read");
        }
        budget.bytes -= actualBytes;
        const payload = parsePayload(body, budget);
        rows.push({ ...boundary, payload });
        if (payload?.role === "user") userRows += 1;
        if (userRows > CHAT_RUNTIME_BOUNDS.historyTurns) break;
      }
      if (metadata.length < pageSize) break;
      await yieldToTransport();
    }
    return rows.reverse();
  }
  private readMetadata(
    table: typeof PI_TABLE | typeof AI_CHAT_TABLE,
    limit: number,
    numericCursor: number,
    chronologyCursor: string,
    usesChronology: boolean,
    minimumPiIndex: number,
  ): LegacyRowMeta[] {
    if (table === PI_TABLE) {
      return this.sql
        .exec<LegacyRowMeta>(
          `SELECT idx AS key, NULL AS id,
                  length(CAST(payload AS BLOB)) AS bytes, created_at,
                  idx AS cursor_key
             FROM ${PI_TABLE} WHERE idx >= ? AND idx < ?
            ORDER BY idx DESC LIMIT ?`,
          minimumPiIndex,
          numericCursor,
          limit,
        )
        .toArray();
    }
    if (usesChronology) {
      return this.sql
        .exec<LegacyRowMeta>(
          `SELECT rowid AS key, id,
                  length(CAST(message AS BLOB)) AS bytes, created_at,
                  chronology_key AS cursor_key
             FROM ${AI_CHAT_TABLE}
            WHERE chronology_key IS NOT NULL AND chronology_key < ?
            ORDER BY chronology_key DESC LIMIT ?`,
          chronologyCursor,
          limit,
        )
        .toArray();
    }
    return this.sql
      .exec<LegacyRowMeta>(
        `SELECT rowid AS key, id,
                length(CAST(message AS BLOB)) AS bytes, created_at,
                rowid AS cursor_key
           FROM ${AI_CHAT_TABLE} WHERE rowid < ?
          ORDER BY rowid DESC LIMIT ?`,
        numericCursor,
        limit,
      )
      .toArray();
  }
  private readPiCompaction(
    deadlineAt: number, token: string, budget: ScanBudget,
  ): PiCompaction {
    if (!tableExists(this.sql, PI_COMPACTION_TABLE))
      return { firstKeptIndex: 0, summary: null };
    this.assertOwned(token, deadlineAt);
    const end = boundedInteger(this.sql.exec<{ end: number }>(
      `SELECT COALESCE(MAX(idx) + 1, 0) AS end FROM ${PI_TABLE}`,
    ).one().end);
    const meta = this.sql.exec<{ first: number; bytes: number }>(
      `SELECT first_kept_index AS first, length(CAST(summary AS BLOB)) AS bytes
         FROM ${PI_COMPACTION_TABLE} WHERE id = 1`,
    ).toArray()[0];
    const first = boundedInteger(meta?.first);
    if (!meta || first === 0 || first > end)
      return { firstKeptIndex: 0, summary: null };
    const bytes = boundedInteger(meta.bytes);
    if (bytes > CHAT_RUNTIME_BOUNDS.requestBytes || bytes > budget.bytes)
      throw new LegacyMigrationError("legacy_summary_too_large");
    this.assertWithinDeadline(deadlineAt);
    const summary = this.sql.exec<{ summary: string }>(
      `SELECT summary FROM ${PI_COMPACTION_TABLE} WHERE id = 1`,
    ).toArray()[0]?.summary;
    if (typeof summary !== "string" || byteLength(summary) !== bytes)
      throw new LegacyMigrationError("legacy_row_changed_during_read");
    budget.bytes -= bytes;
    return { firstKeptIndex: first, summary: summary || null };
  }
  private readPayload(
    table: typeof PI_TABLE | typeof AI_CHAT_TABLE,
    meta: LegacyRowMeta,
  ): string | undefined {
    if (table === PI_TABLE) {
      return this.sql
        .exec<{
          payload: string;
        }>(`SELECT payload FROM ${PI_TABLE} WHERE idx = ? LIMIT 1`, meta.key)
        .toArray()[0]?.payload;
    }
    return this.sql
      .exec<{
        payload: string;
      }>(
        `SELECT message AS payload FROM ${AI_CHAT_TABLE} WHERE id = ? LIMIT 1`,
        meta.id,
      )
      .toArray()[0]?.payload;
  }
  private commit(token: string, selection: ScanResult): LegacyMigrationStatus {
    return this.storage.transactionSync(() => {
      const now = this.now();
      const marker = migrationRow(this.sql) as MigrationRow;
      if (
        marker.state !== "pending" ||
        marker.attempt_token !== token ||
        now >= Number(marker.deadline_at)
      ) {
        if (marker.state === "pending" && now >= Number(marker.deadline_at)) {
          return this.failInTransaction("legacy_migration_deadline");
        }
        return statusFromRow(marker);
      }
      const current = this.sql
        .exec<{ count: number; unsafe: number }>(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(CASE
                    WHEN status IN ('running','completed','failed','interrupted')
                    THEN 1 ELSE 0 END), 0) AS unsafe
             FROM chat_turns_v2`,
        )
        .one();
      if (Number(current.unsafe) !== 0) {
        return this.failInTransaction("v2_runtime_changed_during_migration");
      }
      if (
        Number(current.count) + selection.turns.length >
        CHAT_RUNTIME_BOUNDS.admissionsPerThread
      ) {
        return this.failInTransaction("legacy_migration_admission_limit");
      }
      const scope = this.sql
        .exec<{
          thread_id: string | null;
          workspace_id: string | null;
          org_id: string | null;
          user_id: string | null;
        }>(
          `SELECT runtime.thread_id, runtime.workspace_id, runtime.org_id,
                  (SELECT user_id FROM chat_turns_v2
                    WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1)
                    AS user_id
             FROM chat_runtime_v2 runtime WHERE runtime.singleton = 1`,
        )
        .one();
      if (!scope.thread_id || !scope.workspace_id || !scope.org_id) {
        return this.failInTransaction("legacy_migration_scope_missing");
      }
      for (const turn of selection.turns) {
        if (
          turn.id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
          this.sql
            .exec<{ present: number }>(
              `SELECT COUNT(*) AS present FROM chat_turns_v2
                WHERE id = ? OR client_message_id = ?`,
              turn.id,
              turn.id,
            )
            .one().present
        ) {
          throw new LegacyMigrationError("legacy_migration_id_collision");
        }
        const payloadBytes = byteLength(
          JSON.stringify({
            content: turn.userContent,
            display: turn.userDisplay,
          }),
        );
        this.sql.exec(
          `INSERT INTO chat_turns_v2
            (id, client_message_id, thread_id, workspace_id, org_id, user_id,
             source, user_content, user_display, assistant_final, status,
             payload_bytes, terminal_deadline_at, effect_started,
             checkpoint_json, retained, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'legacy_migration', ?, ?, ?, 'completed',
                   ?, ?, 0, ?, 1, ?, ?)`,
          turn.id,
          turn.id,
          scope.thread_id,
          scope.workspace_id,
          scope.org_id,
          scope.user_id,
          turn.userContent,
          turn.userDisplay,
          turn.assistantFinal,
          payloadBytes,
          turn.createdAt + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
          EMPTY_CHECKPOINT_JSON,
          turn.createdAt,
          turn.updatedAt,
        );
      }
      const completed = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE}
              SET state = 'complete', attempt_token = NULL,
                  imported_turns = ?, imported_bytes = ?, source = ?,
                  error = NULL
            WHERE singleton = 1 AND state = 'pending' AND attempt_token = ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          selection.turns.length,
          selection.bytes,
          selection.source,
          token,
        )
        .toArray()[0];
      if (!completed)
        return statusFromRow(migrationRow(this.sql) as MigrationRow);
      this.bumpRevision();
      return statusFromRow(completed, true);
    });
  }
  private bumpRevision(): void {
    this.sql.exec(`UPDATE chat_runtime_v2 SET revision = revision + 1
      WHERE singleton = 1`);
  }
  private recordAttemptError(
    token: string,
    error: string,
    retryable: boolean,
  ): LegacyMigrationStatus {
    return this.storage.transactionSync(() => {
      const row = migrationRow(this.sql);
      if (!row) return unseenStatus();
      if (row.state !== "pending" || row.attempt_token !== token) {
        return statusFromRow(row);
      }
      const now = this.now();
      if (
        !retryable ||
        now >= Number(row.deadline_at) ||
        Number(row.attempt_count) >= CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts
      ) {
        return this.failInTransaction(error);
      }
      const pending = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE} SET error = ?
            WHERE singleton = 1 AND state = 'pending' AND attempt_token = ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          error,
          token,
        )
        .one();
      return statusFromRow(pending, true);
    });
  }
  private failInTransaction(error: string): LegacyMigrationStatus {
    const failed = this.sql
      .exec<MigrationRow>(
        `UPDATE ${MIGRATION_TABLE}
            SET state = 'failed', attempt_token = NULL, error = ?
          WHERE singleton = 1 AND state = 'pending'
        RETURNING state, attempt_count, attempt_token, deadline_at,
                  imported_turns, imported_bytes, source, error`,
        error.slice(0, CHAT_RUNTIME_BOUNDS.identifierChars),
      )
      .toArray()[0];
    if (failed) {
      this.bumpRevision();
      return statusFromRow(failed, true);
    }
    const current = migrationRow(this.sql);
    return current ? statusFromRow(current) : unseenStatus();
  }
  private assertWithinDeadline(deadlineAt: number): void {
    if (this.now() >= deadlineAt) {
      throw new LegacyMigrationError("legacy_migration_deadline");
    }
  }
  private assertOwned(token: string, deadlineAt: number): void {
    this.assertWithinDeadline(deadlineAt);
    const row = migrationRow(this.sql);
    if (!row || row.state !== "pending" || row.attempt_token !== token) {
      throw new StaleLegacyMigrationAttempt();
    }
  }
}
export function legacyMigrationBlocksClaim(sql: SqlStorage): boolean {
  const marker = migrationRow(sql);
  if (marker) return marker.state === "pending";
  if (!tableExists(sql, "chat_turns_v2")) return false;
  return Boolean(
    sql
      .exec<{ present: number }>(
        `SELECT EXISTS(
           SELECT 1 FROM chat_turns_v2 WHERE status IN ('queued','running')
         ) AS present`,
      )
      .one().present,
  );
}
