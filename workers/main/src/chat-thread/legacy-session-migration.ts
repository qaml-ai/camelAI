import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { parseMessageAuthor } from "../../../../src/lib/message-author";
export type LegacyMigrationState = "unseen" | "pending" | "complete" | "failed";

export interface LegacyMigrationStatus {
  state: LegacyMigrationState;
  attemptCount: number;
  attemptToken: string | null;
  deadlineAt: number | null;
  importedTurns: number;
  importedBytes: number;
  source: "pi_core" | "ai_chat" | "none" | "v2" | null;
  error: string | null;
  changed: boolean;
}

interface MigrationRow {
  [key: string]: string | number | null;
  state: Exclude<LegacyMigrationState, "unseen">;
  attempt_count: number;
  attempt_token: string | null;
  deadline_at: number;
  imported_turns: number;
  imported_bytes: number;
  source: LegacyMigrationStatus["source"];
  error: string | null;
}
type LegacyRow = {
  key: number;
  id: string;
  payload: string;
  createdAt: number;
};
type LegacyRowMeta = {
  key: number;
  id: string | null;
  bytes: number;
  created_at: number | string;
  cursor_key: string | number;
};
type DisplaySegment = {
  fallback: string;
  renderMessageId: string | null;
  piCoreMessageKey: string;
};
interface LegacyTurn {
  id: string;
  userContent: string;
  userDisplay: string;
  assistantFinal: string;
  createdAt: number;
  updatedAt: number;
  displaySegments?: DisplaySegment[];
}
type ScanResult = {
  turns: LegacyTurn[];
  bytes: number;
  source: "pi_core" | "ai_chat" | "none";
};
type PiCompaction = { firstKeptIndex: number; summary: string | null };
type ScanBudget = { rows: number; bytes: number };
type ParsedUiMessage = {
  role: "user" | "assistant";
  id: string;
  text: string;
  complete: boolean;
  explicitlyCompleted: boolean;
  sentDuringStreaming: boolean;
  createdAt: number;
  piCoreMessageKey: string | null;
  steerMessageIds: string[];
};
interface TurnBuilder {
  id: string;
  userSegments: string[];
  userBytes: number;
  displaySegments: DisplaySegment[];
  createdAt: number;
  updatedAt: number;
  assistantParts: string[];
  pendingCalls: Map<string, string>;
  answeredCalls: Set<string>;
  sawAssistant: boolean;
  hasTerminalAssistant: boolean;
  invalid: boolean;
}
class LegacyMigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LegacyMigrationError";
  }
}

class StaleLegacyMigrationAttempt extends Error {}

const MIGRATION_TABLE = "chat_legacy_migration_v2";
const PI_TABLE = "pi_core_messages";
const PI_COMPACTION_TABLE = "pi_core_compaction";
const AI_CHAT_TABLE = "cf_ai_chat_agent_messages";
const AI_CHAT_META_TABLE = "cf_ai_chat_render_history_meta";
const EMPTY_CHECKPOINT_JSON =
  '{"version":1,"providerCalls":0,"providerInFlight":false,"batches":[],"final":null}';
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;
const isPositiveNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegativeInteger = (value: unknown) =>
  Math.max(0, Math.floor(Number(value) || 0));
const FOLLOWUP_SEPARATOR = "\n\n[Follow-up]\n";
const FOLLOWUP_SEPARATOR_BYTES = byteLength(FOLLOWUP_SEPARATOR);
const yieldToTransport = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
const finiteTime = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return Math.max(0, Math.floor(fallback));
};
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function renderMessageId(message: Record<string, unknown>): string | null {
  const value =
    recordOf(message.uiMetadata)?.renderMessageId ??
    recordOf(message.metadata)?.renderMessageId;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= CHAT_RUNTIME_BOUNDS.identifierChars
    ? normalized
    : null;
}
function isStreamingFollowup(message: Record<string, unknown>): boolean {
  return (
    message.sentDuringStreaming === true ||
    recordOf(message.metadata)?.sentDuringStreaming === true ||
    recordOf(message.uiMetadata)?.sentDuringStreaming === true
  );
}
const combinedSegments = (segments: readonly string[]) =>
  segments.join(FOLLOWUP_SEPARATOR);

function appendFollowup(
  segments: string[],
  currentBytes: number,
  content: string,
): number {
  const next = currentBytes + FOLLOWUP_SEPARATOR_BYTES + byteLength(content);
  if (next > CHAT_RUNTIME_BOUNDS.requestBytes) {
    throw new LegacyMigrationError("legacy_user_message_too_large");
  }
  segments.push(content);
  return next;
}

function tableExists(sql: SqlStorage, name: string): boolean {
  return Boolean(
    sql
      .exec<{ present: number }>(
        `SELECT EXISTS(
           SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
         ) AS present`,
        name,
      )
      .one().present,
  );
}

function hasCompleteAiChatChronology(sql: SqlStorage): boolean {
  if (!tableExists(sql, AI_CHAT_META_TABLE)) return false;
  return Boolean(
    sql
      .exec<{ ready: number }>(
        `SELECT EXISTS(SELECT 1 FROM ${AI_CHAT_META_TABLE}
          WHERE key = 'metadata_v1' AND value = 1) AND EXISTS(
          SELECT 1 FROM sqlite_master WHERE type = 'index'
            AND name = 'cf_ai_chat_agent_messages_chronology') AS ready`,
      )
      .one().ready,
  );
}

function unseenStatus(): LegacyMigrationStatus {
  return {
    state: "unseen",
    attemptCount: 0,
    attemptToken: null,
    deadlineAt: null,
    importedTurns: 0,
    importedBytes: 0,
    source: null,
    error: null,
    changed: false,
  };
}

function statusFromRow(
  row: MigrationRow,
  changed = false,
): LegacyMigrationStatus {
  return {
    state: row.state,
    attemptCount: Number(row.attempt_count),
    attemptToken: row.attempt_token,
    deadlineAt: Number(row.deadline_at),
    importedTurns: Number(row.imported_turns),
    importedBytes: Number(row.imported_bytes),
    source: row.source,
    error: row.error,
    changed,
  };
}

function migrationRow(sql: SqlStorage): MigrationRow | null {
  if (!tableExists(sql, MIGRATION_TABLE)) return null;
  return (
    sql
      .exec<MigrationRow>(
        `SELECT state, attempt_count, attempt_token, deadline_at,
              imported_turns, imported_bytes, source, error
         FROM ${MIGRATION_TABLE} WHERE singleton = 1`,
      )
      .toArray()[0] ?? null
  );
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const text: string[] = [];
  for (const raw of value) {
    const part = recordOf(raw);
    if (!part) continue;
    if (typeof part.text === "string") text.push(part.text);
    else if (part.type === "image") text.push("[image]");
  }
  return text.join("\n");
}

function piToolCalls(content: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string }> = [];
  for (const raw of content) {
    const part = recordOf(raw);
    if (!part || (part.type !== "toolCall" && part.type !== "tool_use")) {
      continue;
    }
    const id =
      typeof part.id === "string"
        ? part.id.trim()
        : typeof part.toolCallId === "string"
          ? part.toolCallId.trim()
          : "";
    const name =
      typeof part.name === "string"
        ? part.name.trim()
        : typeof part.toolName === "string"
          ? part.toolName.trim()
          : "";
    if (
      !id ||
      !name ||
      id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
      name.length > CHAT_RUNTIME_BOUNDS.identifierChars
    ) {
      throw new LegacyMigrationError("malformed_tool_call");
    }
    calls.push({ id, name });
  }
  return calls;
}

function newBuilder(
  row: LegacyRow,
  message: Record<string, unknown>,
): TurnBuilder {
  const userContent = textContent(message.content);
  if (!userContent) throw new LegacyMigrationError("malformed_user_message");
  if (byteLength(userContent) > CHAT_RUNTIME_BOUNDS.requestBytes) {
    throw new LegacyMigrationError("legacy_user_message_too_large");
  }
  const timestamp = finiteTime(message.timestamp, row.createdAt);
  return {
    id: `legacy:pi:${row.key}`,
    userSegments: [userContent],
    userBytes: byteLength(userContent),
    displaySegments: [
      {
        fallback: parseMessageAuthor(userContent).content,
        renderMessageId: renderMessageId(message),
        piCoreMessageKey: String(timestamp),
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
    assistantParts: [],
    pendingCalls: new Map(),
    answeredCalls: new Set(),
    sawAssistant: false,
    hasTerminalAssistant: false,
    invalid: false,
  };
}

function settleBuilder(builder: TurnBuilder | null): LegacyTurn | null {
  if (
    !builder ||
    builder.invalid ||
    !builder.sawAssistant ||
    !builder.hasTerminalAssistant ||
    builder.pendingCalls.size !== 0
  ) {
    return null;
  }
  const assistantFinal = builder.assistantParts.filter(Boolean).join("\n\n");
  if (!assistantFinal) return null;
  if (byteLength(assistantFinal) > CHAT_RUNTIME_BOUNDS.assistantBytes) {
    throw new LegacyMigrationError("legacy_assistant_message_too_large");
  }
  return {
    id: builder.id,
    userContent: combinedSegments(builder.userSegments),
    userDisplay: combinedSegments(
      builder.displaySegments.map((segment) => segment.fallback),
    ),
    assistantFinal,
    createdAt: builder.createdAt,
    updatedAt: Math.max(builder.createdAt, builder.updatedAt),
    displaySegments: builder.displaySegments,
  };
}

function parsePiTurns(
  rows: readonly LegacyRow[],
  checkDeadline: () => void,
): LegacyTurn[] {
  const turns: LegacyTurn[] = [];
  let builder: TurnBuilder | null = null;
  for (const row of rows) {
    checkDeadline();
    let message: Record<string, unknown>;
    try {
      message = recordOf(JSON.parse(row.payload)) ?? {};
    } catch {
      throw new LegacyMigrationError("malformed_pi_core_json");
    }
    if (!message.role || message.visibility === "hidden") continue;
    if (message.role === "user") {
      if (isStreamingFollowup(message)) {
        // A bounded read can begin mid-turn; never promote its orphaned steer.
        if (!builder) continue;
        const followup = textContent(message.content);
        if (!followup) {
          builder.invalid = true;
          continue;
        }
        const timestamp = finiteTime(message.timestamp, row.createdAt);
        builder.userBytes = appendFollowup(
          builder.userSegments,
          builder.userBytes,
          followup,
        );
        builder.displaySegments.push({
          fallback: parseMessageAuthor(followup).content,
          renderMessageId: renderMessageId(message),
          piCoreMessageKey: String(timestamp),
        });
        builder.hasTerminalAssistant = false;
        builder.updatedAt = Math.max(builder.updatedAt, timestamp);
        continue;
      }
      const settled = settleBuilder(builder);
      if (settled) turns.push(settled);
      builder = newBuilder(row, message);
      continue;
    }
    if (!builder) continue;
    const timestamp = finiteTime(message.timestamp, row.createdAt);
    builder.updatedAt = Math.max(builder.updatedAt, timestamp);
    if (message.role === "assistant") {
      if (message.stopReason === "aborted" || message.stopReason === "error") {
        builder.sawAssistant = true;
        builder.hasTerminalAssistant = false;
        continue;
      }
      if (builder.pendingCalls.size > 0) {
        builder.invalid = true;
        continue;
      }
      let calls: Array<{ id: string; name: string }>;
      try {
        calls = piToolCalls(message.content);
      } catch {
        builder.invalid = true;
        continue;
      }
      const ids = new Set<string>();
      for (const call of calls) {
        checkDeadline();
        if (ids.has(call.id) || builder.answeredCalls.has(call.id)) {
          builder.invalid = true;
          break;
        }
        ids.add(call.id);
        builder.pendingCalls.set(call.id, call.name);
      }
      const text = textContent(message.content);
      if (text) builder.assistantParts.push(text);
      builder.sawAssistant = true;
      builder.hasTerminalAssistant = calls.length === 0 && Boolean(text);
      continue;
    }
    if (message.role === "toolResult") {
      const id =
        typeof message.toolCallId === "string"
          ? message.toolCallId.trim()
          : typeof message.tool_use_id === "string"
            ? message.tool_use_id.trim()
            : "";
      const expectedName = builder.pendingCalls.get(id);
      const actualName =
        typeof message.toolName === "string" ? message.toolName.trim() : "";
      if (
        !id ||
        !expectedName ||
        builder.answeredCalls.has(id) ||
        (actualName && actualName !== expectedName)
      ) {
        builder.invalid = true;
        continue;
      }
      builder.pendingCalls.delete(id);
      builder.answeredCalls.add(id);
      builder.hasTerminalAssistant = false;
      continue;
    }
    builder.invalid = true;
  }
  const settled = settleBuilder(builder);
  if (settled) turns.push(settled);
  return turns;
}

function parsedUiMessage(
  row: LegacyRow,
  checkDeadline: () => void,
): ParsedUiMessage | null {
  let message: Record<string, unknown>;
  try {
    message = recordOf(JSON.parse(row.payload)) ?? {};
  } catch {
    throw new LegacyMigrationError("malformed_ai_chat_json");
  }
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (!Array.isArray(message.parts)) {
    throw new LegacyMigrationError("malformed_ai_chat_message");
  }
  const text: string[] = [];
  const toolIds = new Set<string>();
  const steerMessageIds: string[] = [];
  let complete = true;
  for (const raw of message.parts) {
    checkDeadline();
    const part = recordOf(raw);
    if (!part || typeof part.type !== "string") {
      complete = false;
      continue;
    }
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text) text.push(part.text);
      if (
        typeof part.state === "string" &&
        part.state !== "done" &&
        part.state !== "output-available"
      ) {
        complete = false;
      }
      continue;
    }
    if (part.type === "reasoning") {
      if (part.state !== undefined && part.state !== "done") complete = false;
      continue;
    }
    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const id =
        typeof part.toolCallId === "string" ? part.toolCallId.trim() : "";
      if (
        !id ||
        id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
        toolIds.has(id) ||
        (part.state !== "output-available" && part.state !== "output-error")
      ) {
        complete = false;
      }
      toolIds.add(id);
      continue;
    }
    if (part.type === "data-pi-user-stop") {
      complete = false;
      continue;
    }
    if (part.type === "data-pi-turn-notice") {
      const data = recordOf(part.data);
      if (typeof data?.text === "string" && data.text) text.push(data.text);
      continue;
    }
    if (part.type === "data-pi-error") {
      complete = false;
      continue;
    }
    if (part.type === "data-pi-steer-marker") {
      const value = recordOf(part.data)?.steerMessageId;
      const id = typeof value === "string" ? value.trim() : "";
      if (
        !id ||
        id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
        steerMessageIds.includes(id)
      ) {
        complete = false;
      } else {
        steerMessageIds.push(id);
      }
      continue;
    }
    if (part.type === "step-start" || part.type.startsWith("data-pi-")) {
      continue;
    }
    complete = false;
  }
  const id =
    typeof message.id === "string" && message.id.trim()
      ? message.id.trim()
      : row.id;
  const metadata = recordOf(message.metadata);
  const pi = recordOf(metadata?.pi);
  const explicitlyCompleted = isPositiveNumber(pi?.completedAtMs);
  return {
    role: message.role,
    id,
    text: text.join("\n"),
    complete:
      complete &&
      (message.role === "user" ||
        explicitlyCompleted ||
        isPositiveNumber(pi?.createdAtMs)),
    explicitlyCompleted: message.role === "user" || explicitlyCompleted,
    sentDuringStreaming: isStreamingFollowup(message),
    createdAt: finiteTime(pi?.createdAtMs ?? pi?.completedAtMs, row.createdAt),
    piCoreMessageKey:
      typeof metadata?.piCoreMessageKey === "string"
        ? metadata.piCoreMessageKey
        : null,
    steerMessageIds,
  };
}

function parseAiChatTurns(
  rows: readonly LegacyRow[],
  checkDeadline: () => void,
): LegacyTurn[] {
  const messages: ParsedUiMessage[] = [];
  for (const row of rows) {
    checkDeadline();
    const message = parsedUiMessage(row, checkDeadline);
    if (message) messages.push(message);
  }
  const steering = new Map<string, ParsedUiMessage | null>();
  const markedSteers = new Set<string>();
  for (const message of messages) {
    if (message.role === "user" && message.sentDuringStreaming) {
      steering.set(message.id, steering.has(message.id) ? null : message);
    }
    for (const id of message.steerMessageIds) markedSteers.add(id);
  }
  const turns: LegacyTurn[] = [];
  let user: {
    id: string;
    segments: string[];
    bytes: number;
    createdAt: number;
    complete: boolean;
  } | null = null;
  let assistantParts: string[] = [];
  let assistantAt = 0;
  let assistantComplete = false;
  let assistantExplicitlyCompleted = false;
  let sawAssistant = false;
  const claimedSteers = new Set<string>();
  const settle = (laterUserBoundary: boolean) => {
    if (!user || !user.complete || !sawAssistant || !assistantComplete) return;
    if (!assistantExplicitlyCompleted && !laterUserBoundary) return;
    const userContent = combinedSegments(user.segments);
    const assistantFinal = assistantParts.filter(Boolean).join("\n\n");
    if (!assistantFinal) return;
    if (byteLength(assistantFinal) > CHAT_RUNTIME_BOUNDS.assistantBytes) {
      throw new LegacyMigrationError("legacy_assistant_message_too_large");
    }
    turns.push({
      id: `legacy:ai:${user.id.slice(0, 220)}`,
      userContent,
      userDisplay: userContent,
      assistantFinal,
      createdAt: user.createdAt,
      updatedAt: Math.max(user.createdAt, assistantAt),
    });
  };
  for (const message of messages) {
    checkDeadline();
    if (message.role === "user") {
      if (markedSteers.has(message.id)) continue;
      if (message.sentDuringStreaming) {
        // Discard a leading follow-up when the bounded read omitted its base.
        if (!user) continue;
        user.bytes = appendFollowup(user.segments, user.bytes, message.text);
        user.complete &&= message.complete;
        assistantComplete = false;
        assistantExplicitlyCompleted = false;
        continue;
      }
      settle(true);
      const userBytes = byteLength(message.text);
      if (userBytes > CHAT_RUNTIME_BOUNDS.requestBytes) {
        throw new LegacyMigrationError("legacy_user_message_too_large");
      }
      user = {
        id: message.id,
        segments: [message.text],
        bytes: userBytes,
        createdAt: message.createdAt,
        complete: message.complete && Boolean(message.text),
      };
      assistantParts = [];
      assistantAt = 0;
      assistantComplete = false;
      assistantExplicitlyCompleted = false;
      sawAssistant = false;
      continue;
    }
    if (!user) continue;
    let messageComplete = message.complete;
    for (const id of message.steerMessageIds) {
      const steer = steering.get(id);
      if (!steer || !steer.complete || !steer.text || claimedSteers.has(id)) {
        messageComplete = false;
        continue;
      }
      user.bytes = appendFollowup(user.segments, user.bytes, steer.text);
      assistantAt = Math.max(assistantAt, steer.createdAt);
      claimedSteers.add(id);
    }
    assistantParts.push(message.text);
    assistantAt = Math.max(assistantAt, message.createdAt);
    assistantComplete = sawAssistant
      ? assistantComplete && messageComplete
      : messageComplete;
    assistantExplicitlyCompleted = message.explicitlyCompleted;
    sawAssistant = true;
  }
  settle(false);
  return turns;
}

function boundedSelection(
  turns: readonly LegacyTurn[],
  checkDeadline: () => void,
): Omit<ScanResult, "source"> {
  const newest: LegacyTurn[] = [];
  let bytes = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    checkDeadline();
    if (newest.length >= CHAT_RUNTIME_BOUNDS.historyTurns) break;
    const turn = turns[index];
    const turnBytes = byteLength(
      JSON.stringify({
        content: turn.userContent,
        display: turn.userDisplay,
        assistant: turn.assistantFinal,
      }),
    );
    if (turnBytes > CHAT_RUNTIME_BOUNDS.historyBytes) {
      throw new LegacyMigrationError("legacy_turn_too_large");
    }
    if (bytes + turnBytes > CHAT_RUNTIME_BOUNDS.historyBytes) break;
    newest.unshift(turn);
    bytes += turnBytes;
  }
  return { turns: newest, bytes };
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

  claimBlocked(): boolean {
    return legacyMigrationBlocksClaim(this.sql);
  }

  nextAlarmAt(now = this.now()): number | null {
    const status = this.status();
    if (status.state !== "pending" || status.deadlineAt === null) return null;
    return Math.min(
      status.deadlineAt,
      Math.max(0, Math.floor(now)) + CHAT_RUNTIME_BOUNDS.legacyMigrationRetryMs,
    );
  }

  async runAfterAdmission(
    at: number,
    attemptToken: string,
  ): Promise<LegacyMigrationStatus> {
    const now = Math.max(0, Math.floor(at));
    if (
      !attemptToken ||
      attemptToken.length > CHAT_RUNTIME_BOUNDS.identifierChars
    ) {
      return this.status();
    }
    const existing = migrationRow(this.sql);
    if (existing?.state === "complete" || existing?.state === "failed") {
      return statusFromRow(existing);
    }
    const hasAdmittedWork = this.hasAdmittedV2Turn(now);
    if (existing?.state === "pending" && !hasAdmittedWork) {
      return this.storage.transactionSync(() =>
        this.failInTransaction(
          now >= Number(existing.deadline_at)
            ? "legacy_migration_deadline"
            : "legacy_migration_admission_missing",
          now,
        ),
      );
    }
    if (!hasAdmittedWork) return unseenStatus();
    this.ensureTable();
    if (this.hasSettledV2History()) {
      return existing
        ? this.storage.transactionSync(() =>
            this.failInTransaction("v2_runtime_changed_during_migration", now),
          )
        : this.markExistingV2Complete(now, attemptToken);
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
      if (error instanceof StaleLegacyMigrationAttempt) {
        return this.status();
      }
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

  private hasAdmittedV2Turn(now: number): boolean {
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

  private markExistingV2Complete(
    now: number,
    token: string,
  ): LegacyMigrationStatus {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO ${MIGRATION_TABLE}
          (singleton, state, attempt_count, attempt_token, deadline_at,
           imported_turns, imported_bytes, source, error, started_at, updated_at)
         VALUES (1, 'pending', 1, ?, ?, 0, 0, NULL, NULL, ?, ?)`,
        token,
        now + CHAT_RUNTIME_BOUNDS.legacyMigrationDeadlineMs,
        now,
        now,
      );
      this.appendMigrationEvent("BeginLegacyMigration", now);
      const completed = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE}
              SET state = 'complete', attempt_token = NULL, source = 'v2',
                  updated_at = ?
            WHERE singleton = 1 AND state = 'pending' AND attempt_token = ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          now,
          token,
        )
        .one();
      this.appendMigrationEvent("CompleteLegacyMigration", now);
      return statusFromRow(completed, true);
    });
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
      if (now >= Number(row.deadline_at)) {
        return this.failInTransaction("legacy_migration_deadline", now);
      }
      if (
        Number(row.attempt_count) >= CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts
      ) {
        return this.failInTransaction(
          "legacy_migration_attempts_exhausted",
          now,
        );
      }
      const claimed = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE}
              SET attempt_count = attempt_count + 1, attempt_token = ?,
                  error = NULL, updated_at = ?
            WHERE singleton = 1 AND state = 'pending'
              AND attempt_count < ? AND deadline_at > ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          token,
          now,
          CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts,
          now,
        )
        .toArray()[0];
      if (claimed) {
        this.appendMigrationEvent(
          Number(row.attempt_count) === 0
            ? "BeginLegacyMigration"
            : "RetryLegacyMigration",
          now,
        );
      }
      return claimed
        ? statusFromRow(claimed, true)
        : statusFromRow(migrationRow(this.sql) as MigrationRow);
    });
  }

  private async scanLegacy(
    deadlineAt: number,
    attemptToken: string,
  ): Promise<ScanResult> {
    const budget: ScanBudget = {
      rows: CHAT_RUNTIME_BOUNDS.legacyMigrationScanRows,
      bytes: CHAT_RUNTIME_BOUNDS.historyBytes,
    };
    this.assertAttemptOwned(attemptToken, deadlineAt);
    if (tableExists(this.sql, PI_TABLE)) {
      const compaction = this.readPiCompaction(deadlineAt, attemptToken);
      const rows = await this.readNewestRows(
        PI_TABLE,
        deadlineAt,
        compaction.firstKeptIndex,
        attemptToken,
        budget,
      );
      const checkDeadline = () => this.assertWithinDeadline(deadlineAt);
      const turns = boundedSelection(
        parsePiTurns(rows, checkDeadline),
        checkDeadline,
      ).turns;
      rows.length = 0;
      if (turns.length > 0) {
        await this.hydratePiUserDisplays(
          turns,
          deadlineAt,
          attemptToken,
          budget,
        );
        this.prependCompactionSummary(turns, compaction.summary, deadlineAt);
        return {
          ...boundedSelection(turns, checkDeadline),
          source: "pi_core",
        };
      }
      // A valid watermark makes rows behind it intentionally invisible. Never
      // resurrect the mirrored pre-compaction transcript from ai-chat.
      if (compaction.firstKeptIndex > 0) {
        return { turns: [], bytes: 0, source: "none" };
      }
    }
    this.assertAttemptOwned(attemptToken, deadlineAt);
    if (tableExists(this.sql, AI_CHAT_TABLE)) {
      const rows = await this.readNewestRows(
        AI_CHAT_TABLE,
        deadlineAt,
        0,
        attemptToken,
        budget,
      );
      const checkDeadline = () => this.assertWithinDeadline(deadlineAt);
      const selection = boundedSelection(
        parseAiChatTurns(rows, checkDeadline),
        checkDeadline,
      );
      return {
        ...selection,
        source: selection.turns.length > 0 ? "ai_chat" : "none",
      };
    }
    return { turns: [], bytes: 0, source: "none" };
  }

  private async readNewestRows(
    table: typeof PI_TABLE | typeof AI_CHAT_TABLE,
    deadlineAt: number,
    minimumPiIndex: number,
    attemptToken: string,
    budget: ScanBudget,
  ): Promise<LegacyRow[]> {
    const newest: LegacyRow[] = [];
    const usesChronology =
      table === AI_CHAT_TABLE && hasCompleteAiChatChronology(this.sql);
    let numericCursor = Number.MAX_SAFE_INTEGER;
    let chronologyCursor = "\uffff";
    let userRows = 0;
    while (
      budget.rows > 0 &&
      budget.bytes > 0 &&
      userRows <= CHAT_RUNTIME_BOUNDS.historyTurns
    ) {
      this.assertAttemptOwned(attemptToken, deadlineAt);
      const pageRows = Math.min(
        CHAT_RUNTIME_BOUNDS.legacyMigrationPageRows,
        budget.rows,
      );
      let metadata: LegacyRowMeta[];
      if (table === PI_TABLE) {
        metadata = this.sql
          .exec<LegacyRowMeta>(
            `SELECT idx AS key, NULL AS id,
                    length(CAST(payload AS BLOB)) AS bytes, created_at,
                    idx AS cursor_key
               FROM ${PI_TABLE}
              WHERE idx >= ? AND idx < ?
              ORDER BY idx DESC LIMIT ?`,
            minimumPiIndex,
            numericCursor,
            pageRows,
          )
          .toArray();
      } else if (usesChronology) {
        metadata = this.sql
          .exec<LegacyRowMeta>(
            `SELECT rowid AS key, id,
                    length(CAST(message AS BLOB)) AS bytes, created_at,
                    chronology_key AS cursor_key
               FROM ${AI_CHAT_TABLE}
              WHERE chronology_key IS NOT NULL AND chronology_key < ?
              ORDER BY chronology_key DESC LIMIT ?`,
            chronologyCursor,
            pageRows,
          )
          .toArray();
      } else {
        metadata = this.sql
          .exec<LegacyRowMeta>(
            `SELECT rowid AS key, id,
                    length(CAST(message AS BLOB)) AS bytes, created_at,
                    rowid AS cursor_key
               FROM ${AI_CHAT_TABLE}
              WHERE rowid < ? ORDER BY rowid DESC LIMIT ?`,
            numericCursor,
            pageRows,
          )
          .toArray();
      }
      if (metadata.length === 0) break;
      budget.rows -= metadata.length;
      for (const meta of metadata) {
        this.assertWithinDeadline(deadlineAt);
        const rowBytes = Math.max(0, Math.floor(Number(meta.bytes) || 0));
        if (rowBytes > CHAT_RUNTIME_BOUNDS.historyBytes) {
          throw new LegacyMigrationError("legacy_row_too_large");
        }
        if (rowBytes > budget.bytes) {
          return newest.reverse();
        }
        const body =
          table === PI_TABLE
            ? this.sql
                .exec<{
                  payload: string;
                }>(
                  `SELECT payload FROM ${PI_TABLE} WHERE idx = ? LIMIT 1`,
                  meta.key,
                )
                .toArray()[0]?.payload
            : this.sql
                .exec<{ payload: string }>(
                  `SELECT message AS payload FROM ${AI_CHAT_TABLE}
                    WHERE id = ? LIMIT 1`,
                  meta.id,
                )
                .toArray()[0]?.payload;
        if (typeof body !== "string" || byteLength(body) !== rowBytes) {
          throw new LegacyMigrationError("legacy_row_changed_during_read");
        }
        let role: unknown;
        try {
          role = recordOf(JSON.parse(body))?.role;
        } catch {
          throw new LegacyMigrationError(
            table === PI_TABLE
              ? "malformed_pi_core_json"
              : "malformed_ai_chat_json",
          );
        }
        newest.push({
          key: Number(meta.key),
          id: meta.id ?? String(meta.key),
          payload: body,
          createdAt: finiteTime(meta.created_at),
        });
        budget.bytes -= rowBytes;
        if (role === "user") userRows += 1;
        if (table === PI_TABLE) {
          numericCursor = Math.min(numericCursor, Number(meta.cursor_key));
        } else if (usesChronology) {
          chronologyCursor = String(meta.cursor_key);
        } else {
          numericCursor = Math.min(numericCursor, Number(meta.key));
        }
        if (userRows > CHAT_RUNTIME_BOUNDS.historyTurns) break;
      }
      if (metadata.length < pageRows) break;
      await yieldToTransport();
    }
    return newest.reverse();
  }

  private readPiCompaction(
    deadlineAt: number,
    attemptToken: string,
  ): PiCompaction {
    if (!tableExists(this.sql, PI_COMPACTION_TABLE)) {
      return { firstKeptIndex: 0, summary: null };
    }
    this.assertAttemptOwned(attemptToken, deadlineAt);
    const endIdx = nonnegativeInteger(
      this.sql
        .exec<{
          end_idx: number;
        }>(`SELECT COALESCE(MAX(idx) + 1, 0) AS end_idx FROM ${PI_TABLE}`)
        .one().end_idx,
    );
    const metadata = this.sql
      .exec<{ first_kept_index: number; bytes: number }>(
        `SELECT first_kept_index,
                length(CAST(summary AS BLOB)) AS bytes
           FROM ${PI_COMPACTION_TABLE} WHERE id = 1`,
      )
      .toArray()[0];
    if (!metadata) return { firstKeptIndex: 0, summary: null };
    const stored = nonnegativeInteger(metadata.first_kept_index);
    if (stored === 0 || stored > endIdx) {
      return { firstKeptIndex: 0, summary: null };
    }
    const bytes = Math.max(0, Math.floor(Number(metadata.bytes) || 0));
    if (bytes > CHAT_RUNTIME_BOUNDS.requestBytes) {
      throw new LegacyMigrationError("legacy_summary_too_large");
    }
    const summary = this.sql
      .exec<{
        summary: string;
      }>(`SELECT summary FROM ${PI_COMPACTION_TABLE} WHERE id = 1`)
      .toArray()[0]?.summary;
    if (typeof summary !== "string" || byteLength(summary) !== bytes) {
      throw new LegacyMigrationError("legacy_row_changed_during_read");
    }
    return { firstKeptIndex: stored, summary: summary || null };
  }

  private async hydratePiUserDisplays(
    turns: LegacyTurn[],
    deadlineAt: number,
    attemptToken: string,
    budget: ScanBudget,
  ): Promise<void> {
    this.assertAttemptOwned(attemptToken, deadlineAt);
    if (!tableExists(this.sql, AI_CHAT_TABLE)) return;
    const byId = new Map<string, string>();
    const byPiKey = new Map<string, string | null>();
    for (const row of await this.readNewestRows(
      AI_CHAT_TABLE,
      deadlineAt,
      0,
      attemptToken,
      budget,
    )) {
      this.assertWithinDeadline(deadlineAt);
      const parsed = parsedUiMessage(row, () =>
        this.assertWithinDeadline(deadlineAt),
      );
      if (parsed?.role !== "user" || !parsed.complete || !parsed.text) continue;
      byId.set(row.id, parsed.text);
      byId.set(parsed.id, parsed.text);
      const key = parsed.piCoreMessageKey;
      if (key) byPiKey.set(key, byPiKey.has(key) ? null : parsed.text);
    }
    const piKeyCounts = new Map<string, number>();
    for (const turn of turns) {
      for (const segment of turn.displaySegments ?? []) {
        const key = segment.piCoreMessageKey;
        piKeyCounts.set(key, (piKeyCounts.get(key) ?? 0) + 1);
      }
    }
    for (const turn of turns) {
      this.assertWithinDeadline(deadlineAt);
      const segments = turn.displaySegments;
      if (!segments) continue;
      for (const segment of segments) {
        this.assertWithinDeadline(deadlineAt);
        const display = segment.renderMessageId
          ? byId.get(segment.renderMessageId)
          : piKeyCounts.get(segment.piCoreMessageKey) === 1
            ? byPiKey.get(segment.piCoreMessageKey)
            : null;
        if (display) segment.fallback = display;
      }
      turn.userDisplay = combinedSegments(
        segments.map((segment) => segment.fallback).filter(Boolean),
      );
    }
  }

  private prependCompactionSummary(
    turns: LegacyTurn[],
    summary: string | null,
    deadlineAt: number,
  ): void {
    if (!turns.length || !summary) return;
    this.assertWithinDeadline(deadlineAt);
    const target = turns.length - 1;
    const combined = `[Context Summary]\n\n${summary}\n\n${turns[target].userContent}`;
    if (byteLength(combined) > CHAT_RUNTIME_BOUNDS.requestBytes) {
      throw new LegacyMigrationError("legacy_summary_too_large");
    }
    turns[target] = { ...turns[target], userContent: combined };
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
          return this.failInTransaction("legacy_migration_deadline", now);
        }
        return statusFromRow(marker);
      }
      const current = this.sql
        .exec<{ count: number; running: number; settled: number }>(
          `SELECT COUNT(*) AS count,
                  COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
                  COALESCE(SUM(CASE WHEN status IN ('completed','failed','interrupted')
                                    THEN 1 ELSE 0 END), 0) AS settled
             FROM chat_turns_v2`,
        )
        .one();
      if (Number(current.running) !== 0 || Number(current.settled) !== 0) {
        return this.failInTransaction(
          "v2_runtime_changed_during_migration",
          now,
        );
      }
      if (
        Number(current.count) + selection.turns.length >
        CHAT_RUNTIME_BOUNDS.admissionsPerThread
      ) {
        return this.failInTransaction("legacy_migration_admission_limit", now);
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
                    WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1) AS user_id
             FROM chat_runtime_v2 runtime WHERE runtime.singleton = 1`,
        )
        .one();
      if (!scope.thread_id || !scope.workspace_id || !scope.org_id) {
        return this.failInTransaction("legacy_migration_scope_missing", now);
      }
      for (const turn of selection.turns) {
        if (
          turn.id.length > CHAT_RUNTIME_BOUNDS.identifierChars ||
          Number(
            this.sql
              .exec<{ present: number }>(
                `SELECT EXISTS(
                   SELECT 1 FROM chat_turns_v2
                    WHERE id = ? OR client_message_id = ?
                 ) AS present`,
                turn.id,
                turn.id,
              )
              .one().present,
          ) !== 0
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
                  error = NULL, updated_at = ?
            WHERE singleton = 1 AND state = 'pending' AND attempt_token = ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          selection.turns.length,
          selection.bytes,
          selection.source,
          now,
          token,
        )
        .toArray()[0];
      if (!completed)
        return statusFromRow(migrationRow(this.sql) as MigrationRow);
      this.appendMigrationEvent("CompleteLegacyMigration", now);
      return statusFromRow(completed, true);
    });
  }

  private appendMigrationEvent(
    type:
      | "BeginLegacyMigration"
      | "RetryLegacyMigration"
      | "CompleteLegacyMigration"
      | "FailLegacyMigration",
    now: number,
  ): void {
    this.sql.exec(
      "UPDATE chat_runtime_v2 SET revision = revision + 1 WHERE singleton = 1",
    );
    const revision = Number(
      this.sql
        .exec<{
          revision: number;
        }>("SELECT revision FROM chat_runtime_v2 WHERE singleton = 1")
        .one().revision,
    );
    const queued = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM chat_turns_v2 WHERE status = 'queued'
          ORDER BY created_at, rowid LIMIT 1`,
      )
      .toArray()[0];
    const turnId = queued?.id ?? "legacy-migration";
    const event = {
      revision,
      type,
      turnId,
      status: "queued",
      createdAt: now,
    };
    this.sql.exec(
      `INSERT INTO chat_outbox_v2
        (revision, event_type, turn_id, status, payload_bytes, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      revision,
      type,
      turnId,
      byteLength(JSON.stringify(event)),
      now,
    );
    this.sql.exec(
      `DELETE FROM chat_outbox_v2 WHERE seq NOT IN (
        SELECT seq FROM (
          SELECT seq, SUM(payload_bytes) OVER (
            ORDER BY seq DESC ROWS UNBOUNDED PRECEDING
          ) AS cumulative_bytes
          FROM chat_outbox_v2 ORDER BY seq DESC LIMIT ?
        ) WHERE cumulative_bytes <= ?
      )`,
      CHAT_RUNTIME_BOUNDS.outboxEvents,
      CHAT_RUNTIME_BOUNDS.outboxBytes,
    );
  }

  private recordAttemptError(
    token: string,
    error: string,
    retryable: boolean,
  ): LegacyMigrationStatus {
    return this.storage.transactionSync(() => {
      const row = migrationRow(this.sql) as MigrationRow;
      if (row.state !== "pending" || row.attempt_token !== token) {
        return statusFromRow(row);
      }
      const now = this.now();
      if (
        !retryable ||
        now >= Number(row.deadline_at) ||
        Number(row.attempt_count) >= CHAT_RUNTIME_BOUNDS.legacyMigrationAttempts
      ) {
        return this.failInTransaction(error, now);
      }
      const pending = this.sql
        .exec<MigrationRow>(
          `UPDATE ${MIGRATION_TABLE} SET error = ?, updated_at = ?
            WHERE singleton = 1 AND state = 'pending' AND attempt_token = ?
          RETURNING state, attempt_count, attempt_token, deadline_at,
                    imported_turns, imported_bytes, source, error`,
          error,
          now,
          token,
        )
        .one();
      return statusFromRow(pending, true);
    });
  }

  private failInTransaction(error: string, now: number): LegacyMigrationStatus {
    const boundedError = error.slice(0, CHAT_RUNTIME_BOUNDS.identifierChars);
    const failed = this.sql
      .exec<MigrationRow>(
        `UPDATE ${MIGRATION_TABLE}
            SET state = 'failed', attempt_token = NULL, error = ?, updated_at = ?
          WHERE singleton = 1 AND state = 'pending'
        RETURNING state, attempt_count, attempt_token, deadline_at,
                  imported_turns, imported_bytes, source, error`,
        boundedError,
        now,
      )
      .toArray()[0];
    if (failed) this.appendMigrationEvent("FailLegacyMigration", now);
    return failed
      ? statusFromRow(failed, true)
      : statusFromRow(migrationRow(this.sql) as MigrationRow);
  }

  private assertWithinDeadline(deadlineAt: number): void {
    if (this.now() >= deadlineAt)
      throw new LegacyMigrationError("legacy_migration_deadline");
  }

  private assertAttemptOwned(token: string, deadlineAt: number): void {
    this.assertWithinDeadline(deadlineAt);
    const row = migrationRow(this.sql);
    if (!row || row.state !== "pending" || row.attempt_token !== token)
      throw new StaleLegacyMigrationAttempt();
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
