import { CHAT_RUNTIME_BOUNDS } from "./runtime-lifecycle";
import type { RuntimeTurnStatus } from "./runtime-lifecycle";
import { legacyMigrationBlocksClaim } from "./legacy-session-migration";
import {
  checkpointClosed,
  checkpointUncertain,
  emptyTurnCheckpoint,
  parseTurnCheckpoint,
  serializeTurnCheckpoint,
  type CheckpointProviderBatch,
  type CheckpointToolResult,
  type TurnCheckpoint,
} from "./turn-checkpoint";
import { checkpointRuntimeContent, combineRuntimeContent, parseRuntimeContent,
  serializeRuntimeContent, type ChatRuntimeContentBlock } from "./chat-runtime-content";
import {
  automationReportResult,
  checkpointAutomationOutcome,
  parseAutomationRun,
  terminalAutomation,
  type AutomationRunInput,
  type AutomationRunReport,
  type DurableAutomationRun,
} from "./automation-turn-report";

export interface AdmitChatTurn {
  id: string;
  clientMessageId: string;
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId: string | null;
  source: string;
  userContent: string;
  userDisplay: string;
  automationRun?: AutomationRunInput;
}

export interface DurableChatTurn extends Omit<AdmitChatTurn, "automationRun"> {
  status: RuntimeTurnStatus;
  payloadBytes: number;
  attemptCount: number;
  attemptToken: string | null;
  leaseExpiresAt: number | null;
  terminalDeadlineAt: number;
  effectStarted: boolean;
  checkpoint: TurnCheckpoint;
  assistantFinal: string | null;
  assistantError: string | null;
  assistantRenderJson: string | null;
  automationRun: DurableAutomationRun | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatSnapshotMessage {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  content: string | ChatRuntimeContentBlock[];
  status: RuntimeTurnStatus;
  createdAt: number;
}

export interface SettledChatTurn {
  id: string;
  userContent: string;
  userDisplay: string;
  assistantFinal: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatModelContextTurn {
  userContent: string;
  assistantFinal: string;
}

export interface ChatOutboxEvent {
  seq: number;
  revision: number;
  type:
    | "DurablyAdmit"
    | "StartSelectedTurn"
    | "StartNextInference"
    | "CheckpointProviderBatch"
    | "CheckpointProviderFinal"
    | "BeginEffect"
    | "RecordToolResult"
    | "RecoverFromCheckpoint"
    | "CompleteTurn"
    | "FailTurn"
    | "ExpireOperation"
    | "ReconcileCrashedTurn"
    | "BeginLegacyMigration"
    | "RetryLegacyMigration"
    | "CompleteLegacyMigration"
    | "FailLegacyMigration";
  turnId: string;
  status: RuntimeTurnStatus;
  createdAt: number;
}

export type StoreRejection =
  | "invalid"
  | "request_bytes"
  | "queue_full"
  | "queue_bytes"
  | "thread_full"
  | "busy"
  | "idle"
  | "stale"
  | "output_bytes"
  | "checkpoint_bytes"
  | "provider_limit"
  | "tool_limit"
  | "uncertain";

export type StoreResult =
  | {
      ok: true;
      durable: true;
      duplicate: boolean;
      turn: DurableChatTurn;
      revision: number;
      shouldArmAlarm: boolean;
    }
  | {
      ok: false;
      reason: StoreRejection;
      revision: number;
      shouldArmAlarm: boolean;
    };

type TurnRow = {
  id: string;
  client_message_id: string;
  thread_id: string;
  workspace_id: string;
  org_id: string;
  user_id: string | null;
  source: string;
  user_content: string;
  user_display: string;
  assistant_final: string | null;
  assistant_error: string | null;
  assistant_render_json: string | null;
  automation_json: string | null;
  automation_report_at: number | null;
  status: RuntimeTurnStatus;
  payload_bytes: number;
  attempt_count: number;
  recovery_count: number;
  attempt_token: string | null;
  lease_expires_at: number | null;
  terminal_deadline_at: number;
  effect_started: number;
  checkpoint_json: string;
  retained: number;
  created_at: number;
  updated_at: number;
};

type RuntimeRow = {
  revision: number;
  active_turn_id: string | null;
  thread_id: string | null;
  workspace_id: string | null;
  org_id: string | null;
};

const sizeOf = (value: string) => new TextEncoder().encode(value).byteLength;
const time = (n: number) =>
  Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
const EMPTY_CHECKPOINT_JSON = serializeTurnCheckpoint(emptyTurnCheckpoint());

function terminalRenderJson(checkpointJson: string, output: string, completed: boolean): string | null {
  try {
    const checkpoint = parseTurnCheckpoint(checkpointJson);
    if (checkpoint.batches.length === 0) return null;
    const trace = checkpointRuntimeContent(checkpoint);
    const content = completed ? trace : combineRuntimeContent(trace, [{ type: "text", text: output }]);
    return content.length ? serializeRuntimeContent(content) : null;
  } catch {
    return null;
  }
}

export class DurableChatTurnStore {
  readonly sql: SqlStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.migrate();
  }

  private migrate(): void {
    this.storage.transactionSync(() => {
      const existingColumns = new Set(
        this.sql
          .exec<{ name: string }>("PRAGMA table_info(chat_turns_v2)")
          .toArray()
          .map((column) => column.name),
      );
      const existingTable = existingColumns.size > 0;
      const hadCheckpoint = existingColumns.has("checkpoint_json");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_turns_v2 (
        id TEXT PRIMARY KEY, client_message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL, workspace_id TEXT NOT NULL, org_id TEXT NOT NULL,
        user_id TEXT, source TEXT NOT NULL,
        user_content TEXT NOT NULL, user_display TEXT NOT NULL,
        assistant_final TEXT, assistant_error TEXT, assistant_render_json TEXT,
        automation_json TEXT, automation_report_at INTEGER,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','interrupted')),
        payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 1),
        recovery_count INTEGER NOT NULL DEFAULT 0 CHECK(recovery_count BETWEEN 0 AND 1),
        attempt_token TEXT UNIQUE, lease_expires_at INTEGER,
        terminal_deadline_at INTEGER NOT NULL,
        effect_started INTEGER NOT NULL DEFAULT 0 CHECK(effect_started IN (0,1)),
        checkpoint_json TEXT NOT NULL DEFAULT '{"version":1,"providerCalls":0,"providerInFlight":false,"batches":[],"final":null}',
        retained INTEGER NOT NULL DEFAULT 1 CHECK(retained IN (0,1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
      if (existingTable && !existingColumns.has("recovery_count")) {
        this.sql.exec(
          "ALTER TABLE chat_turns_v2 ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0 CHECK(recovery_count BETWEEN 0 AND 1)",
        );
      }
      if (existingTable && !hadCheckpoint) {
        this.sql.exec(
          `ALTER TABLE chat_turns_v2 ADD COLUMN checkpoint_json TEXT NOT NULL
           DEFAULT '{"version":1,"providerCalls":0,"providerInFlight":false,"batches":[],"final":null}'`,
        );
      }
      if (existingTable && !existingColumns.has("assistant_render_json")) {
        this.sql.exec(
          "ALTER TABLE chat_turns_v2 ADD COLUMN assistant_render_json TEXT",
        );
      }
      if (existingTable && !existingColumns.has("automation_json")) {
        this.sql.exec("ALTER TABLE chat_turns_v2 ADD COLUMN automation_json TEXT");
      }
      if (existingTable && !existingColumns.has("automation_report_at")) {
        this.sql.exec("ALTER TABLE chat_turns_v2 ADD COLUMN automation_report_at INTEGER");
      }
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS chat_turns_v2_one_running
        ON chat_turns_v2 ((1)) WHERE status = 'running'`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS chat_turns_v2_fifo
        ON chat_turns_v2 (status, created_at, id)`);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS chat_turns_v2_automation
        ON chat_turns_v2 (automation_report_at) WHERE automation_report_at IS NOT NULL`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_attempt_tokens_v2 (
        token TEXT PRIMARY KEY, turn_id TEXT NOT NULL, created_at INTEGER NOT NULL
      )`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_runtime_v2 (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL,
        active_turn_id TEXT, thread_id TEXT, workspace_id TEXT, org_id TEXT)`);
      this.sql.exec(
        `INSERT OR IGNORE INTO chat_runtime_v2
          (singleton, revision, active_turn_id, thread_id, workspace_id, org_id)
         VALUES (1, 0, NULL, NULL, NULL, NULL)`,
      );
      this.sql.exec(`CREATE TABLE IF NOT EXISTS chat_outbox_v2 (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, event_type TEXT NOT NULL,
        turn_id TEXT NOT NULL, status TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`);
      this.sql.exec(
        `INSERT OR IGNORE INTO chat_attempt_tokens_v2 (token, turn_id, created_at)
         SELECT attempt_token, id, updated_at FROM chat_turns_v2
         WHERE attempt_token IS NOT NULL`,
      );
      if (existingTable && !hadCheckpoint) {
        // No legacy V2 running row carries enough information to distinguish
        // an unstarted call from an uncertain effect. End it; never invent a
        // recoverable empty checkpoint during an upgrade.
        this.sql.exec(
          `UPDATE chat_turns_v2 SET status = 'interrupted', assistant_error = ?,
             lease_expires_at = NULL, checkpoint_json = ?, updated_at = updated_at
           WHERE status = 'running'`,
          "Turn interrupted during the bounded runtime upgrade; please continue.",
          EMPTY_CHECKPOINT_JSON,
        );
        this.sql.exec(
          "UPDATE chat_runtime_v2 SET active_turn_id = NULL WHERE singleton = 1",
        );
      }
    });
  }

  private runtime(): RuntimeRow {
    return this.sql
      .exec<RuntimeRow>(
        `SELECT revision, active_turn_id, thread_id, workspace_id, org_id
         FROM chat_runtime_v2 WHERE singleton = 1`,
      )
      .one();
  }

  private toTurn(row: TurnRow): DurableChatTurn {
    return {
      id: row.id,
      clientMessageId: row.client_message_id,
      threadId: row.thread_id,
      workspaceId: row.workspace_id,
      orgId: row.org_id,
      userId: row.user_id,
      source: row.source,
      userContent: row.user_content,
      userDisplay: row.user_display,
      assistantFinal: row.assistant_final,
      assistantError: row.assistant_error,
      assistantRenderJson: row.assistant_render_json,
      automationRun: parseAutomationRun(row.automation_json),
      status: row.status,
      payloadBytes: Number(row.payload_bytes),
      attemptCount: Number(row.attempt_count) + Number(row.recovery_count),
      attemptToken: row.attempt_token,
      leaseExpiresAt:
        row.lease_expires_at === null ? null : Number(row.lease_expires_at),
      terminalDeadlineAt: Number(row.terminal_deadline_at),
      effectStarted: Boolean(row.effect_started),
      checkpoint: parseTurnCheckpoint(row.checkpoint_json),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private find(id: string, clientMessageId?: string): TurnRow | undefined {
    const cursor = clientMessageId
      ? this.sql.exec<TurnRow>(
          `SELECT * FROM chat_turns_v2
           WHERE id = ? OR client_message_id = ? ORDER BY created_at LIMIT 1`,
          id,
          clientMessageId,
        )
      : this.sql.exec<TurnRow>("SELECT * FROM chat_turns_v2 WHERE id = ?", id);
    return cursor.toArray()[0];
  }

  private rejected(reason: StoreRejection): StoreResult {
    const runtime = this.runtime();
    return {
      ok: false,
      reason,
      revision: Number(runtime.revision),
      shouldArmAlarm: this.shouldArmAlarm(),
    };
  }

  private bumpRevision(): number {
    this.sql.exec(
      "UPDATE chat_runtime_v2 SET revision = revision + 1 WHERE singleton = 1",
    );
    return Number(this.runtime().revision);
  }

  private appendEvent(
    type: ChatOutboxEvent["type"],
    turnId: string,
    status: RuntimeTurnStatus,
    revision: number,
    now: number,
  ): void {
    const bytes = sizeOf(
      JSON.stringify({ revision, type, turnId, status, createdAt: now }),
    );
    this.sql.exec(
      `INSERT INTO chat_outbox_v2
        (revision, event_type, turn_id, status, payload_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      revision,
      type,
      turnId,
      status,
      bytes,
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

  /**
   * Scrub old payloads but retain bounded idempotency tombstones. Exact
   * admit-once semantics and finite storage are compatible because a thread
   * has an explicit lifetime admission cap.
   */
  private pruneHistory(): void {
    this.sql.exec(
      `UPDATE chat_turns_v2 SET retained = 0, user_id = NULL,
         source = 'tombstone', user_content = '', user_display = '',
         assistant_final = NULL, assistant_error = NULL,
         assistant_render_json = NULL, payload_bytes = 0
         , checkpoint_json = ?
       WHERE retained = 1
         AND status IN ('completed', 'failed', 'interrupted')
         AND automation_report_at IS NULL AND id NOT IN (
         SELECT id FROM (
           SELECT id,
             SUM(payload_bytes + length(CAST(COALESCE(
               assistant_render_json, assistant_final, assistant_error, ''
             ) AS BLOB))) OVER (
               ORDER BY created_at DESC, rowid DESC
               ROWS UNBOUNDED PRECEDING
             ) AS cumulative_bytes
           FROM chat_turns_v2
           WHERE retained = 1
             AND status IN ('completed', 'failed', 'interrupted')
             AND automation_report_at IS NULL
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?
         ) WHERE cumulative_bytes <= ?
       )`,
      EMPTY_CHECKPOINT_JSON,
      CHAT_RUNTIME_BOUNDS.historyTurns,
      CHAT_RUNTIME_BOUNDS.historyBytes,
    );
  }

  private accepted(turn: TurnRow, duplicate = false): StoreResult {
    const runtime = this.runtime();
    return {
      ok: true,
      durable: true,
      duplicate,
      turn: this.toTurn(turn),
      revision: Number(runtime.revision),
      shouldArmAlarm: this.shouldArmAlarm(),
    };
  }

  private mutateCheckpoint(
    id: string,
    attemptToken: string,
    now: number,
    event:
      | "StartNextInference"
      | "CheckpointProviderBatch"
      | "CheckpointProviderFinal"
      | "BeginEffect"
      | "RecordToolResult",
    mutate: (checkpoint: TurnCheckpoint) => TurnCheckpoint | StoreRejection,
    markEffect = false,
  ): StoreResult {
    return this.storage.transactionSync(() => {
      const row = this.find(id);
      if (
        !row ||
        row.status !== "running" ||
        row.attempt_token !== attemptToken
      ) {
        return this.rejected("stale");
      }
      const at = time(now);
      if (
        row.lease_expires_at === null ||
        at >= Number(row.lease_expires_at) ||
        at >= Number(row.terminal_deadline_at)
      ) {
        return this.interruptRunning(
          row,
          at,
          "Turn interrupted when a checkpoint crossed its deadline.",
          "ExpireOperation",
        );
      }
      let checkpoint: TurnCheckpoint;
      try {
        checkpoint = parseTurnCheckpoint(row.checkpoint_json);
      } catch {
        return this.interruptRunning(
          row,
          at,
          "Turn interrupted because its durable checkpoint was invalid.",
          "ReconcileCrashedTurn",
        );
      }
      const changed = mutate(checkpoint);
      if (typeof changed === "string") return this.rejected(changed);
      let serialized: string;
      try {
        serialized = serializeTurnCheckpoint(changed);
        parseTurnCheckpoint(serialized);
      } catch (error) {
        return this.rejected(
          error instanceof Error && error.message.includes("byte limit")
            ? "checkpoint_bytes"
            : "invalid",
        );
      }
      const updated = this.sql
        .exec<TurnRow>(
          `UPDATE chat_turns_v2 SET checkpoint_json = ?,
             effect_started = CASE WHEN ? THEN 1 ELSE effect_started END,
             updated_at = ?
           WHERE id = ? AND status = 'running' AND attempt_token = ?
             AND lease_expires_at > ? AND terminal_deadline_at > ?
           RETURNING *`,
          serialized,
          markEffect ? 1 : 0,
          at,
          id,
          attemptToken,
          at,
          at,
        )
        .toArray()[0];
      if (!updated) return this.rejected("stale");
      const revision = this.bumpRevision();
      this.appendEvent(event, id, "running", revision, at);
      return this.accepted(updated);
    });
  }

  admit(input: AdmitChatTurn, now: number): StoreResult {
    const scheduled = input.automationRun;
    const identifiers = [
      input.id,
      input.clientMessageId,
      input.threadId,
      input.workspaceId,
      input.orgId,
      input.source,
      ...(input.userId ? [input.userId] : []),
      ...(scheduled ? [scheduled.workspaceId, scheduled.automationId, scheduled.runId] : []),
    ];
    if (
      identifiers.some(
        (value) => !value || value.length > CHAT_RUNTIME_BOUNDS.identifierChars,
      ) || (scheduled !== undefined &&
        (scheduled.workspaceId !== input.workspaceId ||
          scheduled.runId !== input.id ||
          (scheduled.requiresExplicitOutcome !== undefined &&
            typeof scheduled.requiresExplicitOutcome !== "boolean")))
    ) {
      return this.rejected("invalid");
    }
    return this.storage.transactionSync(() => {
      const runtime = this.runtime();
      if (
        runtime.thread_id !== null &&
        (runtime.thread_id !== input.threadId ||
          runtime.workspace_id !== input.workspaceId ||
          runtime.org_id !== input.orgId)
      ) {
        return this.rejected("invalid");
      }
      if (runtime.thread_id === null) {
        this.sql.exec(
          `UPDATE chat_runtime_v2
           SET thread_id = ?, workspace_id = ?, org_id = ? WHERE singleton = 1`,
          input.threadId,
          input.workspaceId,
          input.orgId,
        );
      }
      const duplicate = this.find(input.id, input.clientMessageId);
      if (duplicate) return this.accepted(duplicate, true);

      const admissionCount = Number(
        this.sql
          .exec<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM chat_turns_v2")
          .one().count,
      );
      if (admissionCount >= CHAT_RUNTIME_BOUNDS.admissionsPerThread) {
        return this.rejected("thread_full");
      }

      const requestBytes = sizeOf(JSON.stringify(input));
      if (requestBytes > CHAT_RUNTIME_BOUNDS.requestBytes) {
        return this.rejected("request_bytes");
      }
      const payloadBytes = sizeOf(
        JSON.stringify({
          content: input.userContent,
          display: input.userDisplay,
        }),
      );
      const queue = this.sql
        .exec<{ turns: number; bytes: number | null }>(
          `SELECT COUNT(*) AS turns, COALESCE(SUM(payload_bytes), 0) AS bytes
           FROM chat_turns_v2 WHERE status = 'queued'`,
        )
        .one();
      if (Number(queue.turns) >= CHAT_RUNTIME_BOUNDS.queueTurns) {
        return this.rejected("queue_full");
      }
      if (
        Number(queue.bytes ?? 0) + payloadBytes >
        CHAT_RUNTIME_BOUNDS.queueBytes
      ) {
        return this.rejected("queue_bytes");
      }

      const at = time(now);
      this.sql.exec(
        `INSERT INTO chat_turns_v2
          (id, client_message_id, thread_id, workspace_id, org_id, user_id,
           source, user_content, user_display, status, payload_bytes,
           automation_json, terminal_deadline_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
        input.id,
        input.clientMessageId,
        input.threadId,
        input.workspaceId,
        input.orgId,
        input.userId,
        input.source,
        input.userContent,
        input.userDisplay,
        payloadBytes,
        scheduled ? JSON.stringify({ ...scheduled, requiresExplicitOutcome: scheduled.requiresExplicitOutcome === true }) : null,
        at + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        at,
        at,
      );
      const revision = this.bumpRevision();
      this.appendEvent("DurablyAdmit", input.id, "queued", revision, at);
      return this.accepted(this.find(input.id) as TurnRow);
    });
  }

  claim(now: number, attemptToken: string): StoreResult {
    if (
      !attemptToken ||
      attemptToken.length > CHAT_RUNTIME_BOUNDS.identifierChars
    ) {
      return this.rejected("invalid");
    }
    return this.storage.transactionSync(() => {
      if (legacyMigrationBlocksClaim(this.sql)) return this.rejected("busy");
      if (this.runtime().active_turn_id) return this.rejected("busy");
      if (
        Number(
          this.sql
            .exec<{
              used: number;
            }>(
              "SELECT EXISTS(SELECT 1 FROM chat_attempt_tokens_v2 WHERE token = ?) AS used",
              attemptToken,
            )
            .one().used,
        ) !== 0
      ) {
        return this.rejected("stale");
      }
      const at = time(now);
      const turn = this.sql
        .exec<TurnRow>(
          `SELECT * FROM chat_turns_v2
           WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`,
        )
        .toArray()[0];
      // Never skip an expired FIFO head to run newer work. The alarm driver
      // terminalizes that head first, one bounded transition per wake.
      if (!turn || Number(turn.terminal_deadline_at) <= at) {
        return this.rejected("idle");
      }

      const lease = Math.min(
        at + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        Number(turn.terminal_deadline_at),
      );
      const claimed = this.sql
        .exec<TurnRow>(
          `UPDATE chat_turns_v2 SET status = 'running', attempt_token = ?,
          attempt_count = attempt_count + 1, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND attempt_count < ?
           AND terminal_deadline_at > ? RETURNING *`,
          attemptToken,
          lease,
          at,
          turn.id,
          CHAT_RUNTIME_BOUNDS.attemptsPerTurn -
            CHAT_RUNTIME_BOUNDS.recoveryAttempts,
          at,
        )
        .toArray()[0];
      if (!claimed) return this.rejected("stale");
      this.sql.exec(
        `INSERT INTO chat_attempt_tokens_v2 (token, turn_id, created_at)
         VALUES (?, ?, ?)`,
        attemptToken,
        turn.id,
        at,
      );
      this.sql.exec(
        `UPDATE chat_runtime_v2 SET active_turn_id = ? WHERE singleton = 1`,
        turn.id,
      );
      const revision = this.bumpRevision();
      this.appendEvent("StartSelectedTurn", turn.id, "running", revision, at);
      return this.accepted(claimed);
    });
  }

  startNextInference(
    id: string,
    attemptToken: string,
    now: number,
  ): StoreResult {
    return this.mutateCheckpoint(
      id,
      attemptToken,
      now,
      "StartNextInference",
      (checkpoint) => {
        if (
          checkpoint.final !== null ||
          checkpoint.providerInFlight ||
          !checkpointClosed(checkpoint)
        ) {
          return "stale";
        }
        if (
          checkpoint.providerCalls >= CHAT_RUNTIME_BOUNDS.providerCallsPerTurn
        ) {
          return "provider_limit";
        }
        checkpoint.providerCalls += 1;
        checkpoint.providerInFlight = true;
        return checkpoint;
      },
    );
  }

  checkpointProviderBatch(
    id: string,
    attemptToken: string,
    batch: CheckpointProviderBatch,
    now: number,
  ): StoreResult {
    return this.mutateCheckpoint(
      id,
      attemptToken,
      now,
      "CheckpointProviderBatch",
      (checkpoint) => {
        if (
          !checkpoint.providerInFlight ||
          checkpoint.final !== null ||
          !checkpointClosed(checkpoint) ||
          batch.calls.length === 0 ||
          batch.calls.some((call) => call.effectStarted || call.result !== null)
        ) {
          return "stale";
        }
        const calls = checkpoint.batches.reduce(
          (count, item) => count + item.calls.length,
          batch.calls.length,
        );
        if (calls > CHAT_RUNTIME_BOUNDS.toolCallsPerTurn) return "tool_limit";
        checkpoint.providerInFlight = false;
        checkpoint.batches.push(batch);
        return checkpoint;
      },
    );
  }

  checkpointProviderFinal(
    id: string,
    attemptToken: string,
    output: string,
    now: number,
  ): StoreResult {
    if (sizeOf(output) > CHAT_RUNTIME_BOUNDS.assistantBytes) {
      return this.rejected("output_bytes");
    }
    return this.mutateCheckpoint(
      id,
      attemptToken,
      now,
      "CheckpointProviderFinal",
      (checkpoint) => {
        if (
          !checkpoint.providerInFlight ||
          checkpoint.final !== null ||
          !checkpointClosed(checkpoint)
        ) {
          return "stale";
        }
        checkpoint.providerInFlight = false;
        checkpoint.final = output;
        return checkpoint;
      },
    );
  }

  markEffectStarted(
    id: string,
    attemptToken: string,
    callId: string,
    now: number,
  ): StoreResult {
    return this.mutateCheckpoint(
      id,
      attemptToken,
      now,
      "BeginEffect",
      (checkpoint) => {
        if (checkpoint.providerInFlight || checkpoint.final !== null) {
          return "stale";
        }
        const batch = checkpoint.batches.at(-1);
        const firstPending = batch?.calls.find((call) => call.result === null);
        if (
          !firstPending ||
          firstPending.id !== callId ||
          firstPending.effectStarted
        ) {
          return "stale";
        }
        firstPending.effectStarted = true;
        return checkpoint;
      },
      true,
    );
  }

  recordToolResult(
    id: string,
    attemptToken: string,
    result: CheckpointToolResult,
    now: number,
  ): StoreResult {
    return this.mutateCheckpoint(
      id,
      attemptToken,
      now,
      "RecordToolResult",
      (checkpoint) => {
        if (checkpoint.providerInFlight || checkpoint.final !== null) {
          return "stale";
        }
        const call = checkpoint.batches
          .at(-1)
          ?.calls.find((candidate) => candidate.result === null);
        if (
          !call ||
          call.id !== result.callId ||
          !call.effectStarted ||
          result.output.length === 0
        ) {
          return "stale";
        }
        call.result = result;
        return checkpoint;
      },
    );
  }

  complete(id: string, attemptToken: string, assistantFinal: string, now: number): StoreResult {
    return this.terminal(id, attemptToken, "completed", assistantFinal, now); }

  fail(id: string, attemptToken: string, assistantError: string, now: number): StoreResult {
    return this.terminal(id, attemptToken, "failed", assistantError, now); }

  private terminal(
    id: string,
    attemptToken: string,
    status: "completed" | "failed",
    output: string,
    now: number,
  ): StoreResult {
    if (sizeOf(output) > CHAT_RUNTIME_BOUNDS.assistantBytes) {
      return this.rejected("output_bytes");
    }
    return this.storage.transactionSync(() => {
      const at = time(now);
      const running = this.find(id);
      if (
        !running ||
        running.status !== "running" ||
        running.attempt_token !== attemptToken
      ) {
        return this.rejected("stale");
      }
      if (
        running.lease_expires_at === null ||
        at >= Number(running.lease_expires_at) ||
        at >= Number(running.terminal_deadline_at)
      ) {
        return this.interruptRunning(
          running,
          at,
          "Turn interrupted when a late result crossed its deadline.",
          "ExpireOperation",
        );
      }
      if (status === "completed") {
        let checkpoint: TurnCheckpoint;
        try {
          checkpoint = parseTurnCheckpoint(running.checkpoint_json);
        } catch {
          return this.rejected("invalid");
        }
        if (
          checkpoint.providerInFlight ||
          !checkpointClosed(checkpoint) ||
          checkpoint.final !== output
        ) {
          return this.rejected("stale");
        }
      }
      return this.finishTurn(
        running, status, output,
        status === "completed" ? "CompleteTurn" : "FailTurn", at,
      );
    });
  }

  expire(now: number): StoreResult {
    return this.storage.transactionSync(() => {
      const at = time(now);
      const turn = this.sql
        .exec<TurnRow>(
          `SELECT * FROM chat_turns_v2
           WHERE (status = 'running' AND (lease_expires_at <= ? OR terminal_deadline_at <= ?))
              OR (status = 'queued' AND terminal_deadline_at <= ?)
           ORDER BY terminal_deadline_at, created_at, rowid LIMIT 1`,
          at,
          at,
          at,
        )
        .toArray()[0];
      if (!turn) return this.rejected("idle");
      if (turn.status === "queued") {
        return this.finishTurn(
          turn, "failed", "Turn expired before execution could begin.",
          "ExpireOperation", at,
        );
      }
      return this.interruptRunning(
        turn,
        at,
        "Turn interrupted after its execution lease expired.",
        "ExpireOperation",
      );
    });
  }

  /**
   * Give a cold isolate one fresh fenced owner without changing the original
   * absolute deadline. An unrecorded effect or a second crash is terminal.
   */
  recoverFromCheckpoint(now: number, freshToken: string): StoreResult {
    if (
      !freshToken ||
      freshToken.length > CHAT_RUNTIME_BOUNDS.identifierChars
    ) {
      return this.rejected("invalid");
    }
    return this.storage.transactionSync(() => {
      const turn = this.activeTurnRow();
      if (!turn) return this.rejected("idle");
      const at = time(now);
      if (
        turn.lease_expires_at === null ||
        at >= Number(turn.terminal_deadline_at)
      ) {
        return this.interruptRunning(
          turn,
          at,
          "Turn interrupted before checkpoint recovery could begin.",
          "ExpireOperation",
        );
      }
      if (
        Number(
          this.sql
            .exec<{
              used: number;
            }>(
              "SELECT EXISTS(SELECT 1 FROM chat_attempt_tokens_v2 WHERE token = ?) AS used",
              freshToken,
            )
            .one().used,
        ) !== 0
      ) {
        return this.rejected("stale");
      }
      let checkpoint: TurnCheckpoint;
      try {
        checkpoint = parseTurnCheckpoint(turn.checkpoint_json);
      } catch {
        return this.interruptRunning(
          turn,
          at,
          "Turn interrupted because its recovery checkpoint was invalid.",
          "ReconcileCrashedTurn",
        );
      }
      if (
        Number(turn.recovery_count) >= CHAT_RUNTIME_BOUNDS.recoveryAttempts ||
        checkpointUncertain(checkpoint)
      ) {
        return this.interruptRunning(
          turn,
          at,
          checkpointUncertain(checkpoint)
            ? "Turn interrupted after a crash with an uncertain external effect."
            : "Turn interrupted after its one checkpoint recovery was exhausted.",
          "ReconcileCrashedTurn",
        );
      }
      // A provider dispatch without a response checkpoint is safe to repeat
      // once. Its consumed provider-call count remains consumed.
      checkpoint.providerInFlight = false;
      const serialized = serializeTurnCheckpoint(checkpoint);
      const lease = Math.min(
        at + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        Number(turn.terminal_deadline_at),
      );
      const recovered = this.sql
        .exec<TurnRow>(
          `UPDATE chat_turns_v2 SET attempt_token = ?,
             recovery_count = recovery_count + 1, lease_expires_at = ?,
             checkpoint_json = ?, updated_at = ?
           WHERE id = ? AND status = 'running' AND attempt_token = ?
             AND recovery_count < ? AND terminal_deadline_at > ?
           RETURNING *`,
          freshToken,
          lease,
          serialized,
          at,
          turn.id,
          turn.attempt_token,
          CHAT_RUNTIME_BOUNDS.recoveryAttempts,
          at,
        )
        .toArray()[0];
      if (!recovered) return this.rejected("stale");
      this.sql.exec(
        `INSERT INTO chat_attempt_tokens_v2 (token, turn_id, created_at)
         VALUES (?, ?, ?)`,
        freshToken,
        turn.id,
        at,
      );
      const revision = this.bumpRevision();
      this.appendEvent(
        "RecoverFromCheckpoint",
        turn.id,
        "running",
        revision,
        at,
      );
      return this.accepted(recovered);
    });
  }

  /**
   * Terminalize an attempt owned by a previous isolate. This never retries it;
   * the token makes every late completion from the dead owner stale.
   */
  reconcileCrashedTurn(
    now: number,
    ownedAttemptToken: string | null,
  ): StoreResult {
    return this.storage.transactionSync(() => {
      const turn = this.activeTurnRow();
      if (!turn) return this.rejected("idle");
      if (ownedAttemptToken && turn.attempt_token === ownedAttemptToken) {
        return this.rejected("busy");
      }
      return this.interruptRunning(
        turn,
        time(now),
        turn.effect_started
          ? "Turn interrupted after a crash; an external effect may have completed."
          : "Turn interrupted after a crash before any external effect began.",
        "ReconcileCrashedTurn",
      );
    });
  }

  private activeTurnRow(): TurnRow | undefined {
    return this.sql
      .exec<TurnRow>(
        `SELECT turns.* FROM chat_runtime_v2 runtime
         JOIN chat_turns_v2 turns ON turns.id = runtime.active_turn_id
         WHERE runtime.singleton = 1 AND turns.status = 'running' LIMIT 1`,
      )
      .toArray()[0];
  }

  activeTurn(): DurableChatTurn | null {
    const turn = this.activeTurnRow();
    return turn ? this.toTurn(turn) : null;
  }

  getTurn(id: string): DurableChatTurn | null {
    const turn = this.find(id);
    return turn ? this.toTurn(turn) : null; }

  recordedAutomationOutcome(id: string) {
    return checkpointAutomationOutcome(this.find(id)?.checkpoint_json ?? "") ?? null; }

  claimAutomationReport(now: number): AutomationRunReport | null {
    return this.storage.transactionSync(() => {
      const at = time(now);
      const row = this.sql.exec<TurnRow>(`SELECT * FROM chat_turns_v2
        WHERE automation_report_at <= ? ORDER BY automation_report_at, rowid LIMIT 1`, at).toArray()[0];
      if (!row) return null;
      const run = parseAutomationRun(row.automation_json);
      const attempts = Number(run?.reportAttempts ?? 0);
      const deadline = Number(run?.reportDeadlineAt ?? 0);
      if (!run || at >= deadline || attempts >= CHAT_RUNTIME_BOUNDS.automationReportAttempts) {
        this.sql.exec("UPDATE chat_turns_v2 SET automation_report_at = NULL WHERE id = ?", row.id);
        return null;
      }
      const attempt = attempts + 1;
      run.reportAttempts = attempt;
      this.sql.exec(
        `UPDATE chat_turns_v2 SET automation_json = ?, automation_report_at = ?
         WHERE id = ? AND automation_report_at IS NOT NULL`,
        JSON.stringify(run), Math.min(deadline, at + CHAT_RUNTIME_BOUNDS.automationReportRetryMs), row.id,
      );
      return {
        turnId: row.id,
        workspaceId: run.workspaceId,
        automationId: run.automationId,
        runId: run.runId,
        attempt,
        deadlineAt: deadline,
        ...automationReportResult(row.status, row.assistant_error, run),
        completedAt: Number(row.updated_at),
      };
    });
  }

  completeAutomationReport(turnId: string, attempt: number): boolean {
    return this.storage.transactionSync(() => {
      const row = this.find(turnId);
      const run = row ? parseAutomationRun(row.automation_json) : null;
      if (!run || run.reportAttempts !== attempt) return false;
      return Boolean(this.sql.exec<{ id: string }>(
        `UPDATE chat_turns_v2 SET automation_report_at = NULL
         WHERE id = ? AND automation_report_at IS NOT NULL RETURNING id`, turnId,
      ).toArray()[0]);
    });
  }

  hasPendingTurn(): boolean {
    return Boolean(this.sql.exec<{ found: number }>(`SELECT EXISTS(SELECT 1 FROM
      chat_turns_v2 WHERE status IN ('queued','running')) AS found`).one().found);
  }

  /** Newest-first, model-only settled history; never substitutes UI display text. */
  *readModelContext(excludeTurnId: string): Iterable<ChatModelContextTurn> {
    const rows = this.sql.exec<{
      user_content: string;
      assistant_final: string;
    }>(
      `SELECT user_content, assistant_final FROM chat_turns_v2
       WHERE retained = 1 AND status = 'completed' AND id <> ?
         AND assistant_final IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      excludeTurnId,
      Math.ceil(CHAT_RUNTIME_BOUNDS.contextMessages / 2),
    );
    for (const row of rows) {
      yield {
        userContent: row.user_content,
        assistantFinal: row.assistant_final,
      };
    }
  }

  scope(): { threadId: string; workspaceId: string; orgId: string } | null {
    const runtime = this.runtime();
    if (!runtime.thread_id || !runtime.workspace_id || !runtime.org_id) {
      return null;
    }
    return {
      threadId: runtime.thread_id,
      workspaceId: runtime.workspace_id,
      orgId: runtime.org_id,
    };
  }

  /** One bounded compatibility import; imported rows are ordinary settled turns. */
  replaceSettledHistory(
    scope: {
      threadId: string;
      workspaceId: string;
      orgId: string;
      userId: string | null;
    },
    turns: readonly SettledChatTurn[],
  ): void {
    const identifiers = [scope.threadId, scope.workspaceId, scope.orgId];
    if (
      identifiers.some(
        (value) => !value || value.length > CHAT_RUNTIME_BOUNDS.identifierChars,
      ) ||
      turns.length === 0 ||
      turns.length > CHAT_RUNTIME_BOUNDS.historyTurns
    ) {
      throw new Error("Invalid settled history");
    }
    let totalBytes = 0;
    const normalized = turns.map((turn) => {
      if (!turn.id || turn.id.length > CHAT_RUNTIME_BOUNDS.identifierChars) {
        throw new Error("Invalid settled turn id");
      }
      const payloadBytes = sizeOf(
        JSON.stringify({
          content: turn.userContent,
          display: turn.userDisplay,
        }),
      );
      const historyBytes = sizeOf(
        JSON.stringify({
          content: turn.userContent,
          display: turn.userDisplay,
          assistant: turn.assistantFinal,
        }),
      );
      if (
        historyBytes >
        CHAT_RUNTIME_BOUNDS.requestBytes + CHAT_RUNTIME_BOUNDS.assistantBytes
      ) {
        throw new Error("Settled turn is too large");
      }
      totalBytes += historyBytes;
      return {
        ...turn,
        payloadBytes,
        createdAt: time(turn.createdAt),
        updatedAt: Math.max(time(turn.createdAt), time(turn.updatedAt)),
      };
    });
    if (totalBytes > CHAT_RUNTIME_BOUNDS.historyBytes) {
      throw new Error("Settled history is too large");
    }

    this.storage.transactionSync(() => {
      if (
        this.sql
          .exec<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM chat_turns_v2")
          .one().count > 0
      ) {
        throw new Error("Cannot import history into a nonempty runtime");
      }
      this.sql.exec(
        `UPDATE chat_runtime_v2 SET active_turn_id = NULL,
         thread_id = ?, workspace_id = ?, org_id = ? WHERE singleton = 1`,
        scope.threadId,
        scope.workspaceId,
        scope.orgId,
      );
      for (const turn of normalized) {
        this.sql.exec(
          `INSERT INTO chat_turns_v2
            (id, client_message_id, thread_id, workspace_id, org_id, user_id,
             source, user_content, user_display, assistant_final, status,
             payload_bytes, terminal_deadline_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'fork', ?, ?, ?, 'completed', ?, ?, ?, ?)`,
          turn.id,
          turn.id,
          scope.threadId,
          scope.workspaceId,
          scope.orgId,
          scope.userId,
          turn.userContent,
          turn.userDisplay,
          turn.assistantFinal,
          turn.payloadBytes,
          turn.createdAt + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
          turn.createdAt,
          turn.updatedAt,
        );
      }
      this.bumpRevision();
      this.pruneHistory();
    });
  }

  private interruptRunning(
    turn: TurnRow,
    at: number,
    error: string,
    event: "ExpireOperation" | "ReconcileCrashedTurn",
  ): StoreResult {
    return this.finishTurn(turn, "interrupted", error, event, at);
  }

  private finishTurn(
    turn: TurnRow,
    status: "completed" | "failed" | "interrupted",
    output: string,
    event: "CompleteTurn" | "FailTurn" | "ExpireOperation" | "ReconcileCrashedTurn",
    at: number,
  ): StoreResult {
    const pending = terminalAutomation(
      parseAutomationRun(turn.automation_json), turn.checkpoint_json, at,
    );
    const terminal = this.sql.exec<TurnRow>(
      `UPDATE chat_turns_v2 SET status = ?, assistant_final = ?, assistant_error = ?,
       assistant_render_json = ?, automation_json = ?, automation_report_at = ?,
       lease_expires_at = NULL, checkpoint_json = ?, updated_at = ?
       WHERE id = ? AND status = ? AND attempt_token IS ? RETURNING *`,
      status, status === "completed" ? output : null,
      status === "completed" ? null : output,
      terminalRenderJson(turn.checkpoint_json, output, status === "completed"),
      pending ? JSON.stringify(pending) : null, pending ? at : null,
      EMPTY_CHECKPOINT_JSON, at, turn.id, turn.status, turn.attempt_token,
    ).toArray()[0];
    if (!terminal) return this.rejected("stale");
    this.sql.exec(
      `UPDATE chat_runtime_v2 SET active_turn_id = NULL
         WHERE singleton = 1 AND active_turn_id = ?`,
      turn.id,
    );
    const revision = this.bumpRevision();
    this.appendEvent(event, turn.id, status, revision, at);
    const result = this.accepted(terminal);
    this.pruneHistory();
    return result;
  }

  shouldArmAlarm(): boolean { return this.nextAlarmAt(0) !== null; }

  nextAlarmAt(now: number): number | null {
    const row = this.sql
      .exec<{ alarm_at: number | null }>(
        `SELECT MIN(alarm_at) AS alarm_at FROM (
         SELECT CASE
          WHEN EXISTS(SELECT 1 FROM chat_turns_v2 WHERE status = 'running')
            THEN (SELECT MIN(lease_expires_at, terminal_deadline_at) FROM chat_turns_v2
                  WHERE status = 'running' LIMIT 1)
          WHEN EXISTS(SELECT 1 FROM chat_turns_v2 WHERE status = 'queued')
            THEN MIN(?, (SELECT MIN(terminal_deadline_at) FROM chat_turns_v2
                         WHERE status = 'queued'))
          ELSE NULL END AS alarm_at
         UNION ALL SELECT MIN(automation_report_at) FROM chat_turns_v2
           WHERE automation_report_at IS NOT NULL
        ) WHERE alarm_at IS NOT NULL`,
        time(now),
      )
      .one();
    return row.alarm_at === null ? null : Number(row.alarm_at);
  }

  latestSnapshot(): {
    revision: number;
    messages: ChatSnapshotMessage[];
    bytes: number;
    shouldArmAlarm: boolean;
  } {
    const newest: ChatSnapshotMessage[] = [];
    let bytes = 2; // Canonical JSON array brackets.
    const rows = this.sql.exec<TurnRow>(
      `SELECT * FROM chat_turns_v2
       WHERE retained = 1
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      CHAT_RUNTIME_BOUNDS.snapshotMessages,
    );
    for (const row of rows) {
      const turn = this.toTurn(row);
      const group: ChatSnapshotMessage[] = [
        {
          id: `${turn.id}:user`,
          turnId: turn.id,
          role: "user",
          content: turn.userDisplay,
          status: turn.status,
          createdAt: turn.createdAt,
        },
      ];
      const storedRender = turn.assistantRenderJson
        ? parseRuntimeContent(turn.assistantRenderJson)
        : null;
      const activeRender =
        turn.status === "running"
          ? checkpointRuntimeContent(turn.checkpoint)
          : [];
      const assistant =
        storedRender?.length
          ? storedRender
          : activeRender.length
            ? activeRender
            : (turn.assistantFinal ?? turn.assistantError);
      if (assistant !== null) {
        group.push({
          id: `${turn.id}:assistant`,
          turnId: turn.id,
          role: "assistant",
          content: assistant,
          status: turn.status,
          createdAt: turn.updatedAt,
        });
      }
      const groupBytes = group.reduce(
        (sum, message, index) =>
          sum +
          sizeOf(JSON.stringify(message)) +
          (newest.length + index > 0 ? 1 : 0),
        0,
      );
      if (
        newest.length + group.length > CHAT_RUNTIME_BOUNDS.snapshotMessages ||
        bytes + groupBytes > CHAT_RUNTIME_BOUNDS.snapshotBytes
      ) {
        break;
      }
      newest.unshift(...group);
      bytes += groupBytes;
    }
    return {
      revision: Number(this.runtime().revision),
      messages: newest,
      bytes,
      shouldArmAlarm: this.shouldArmAlarm(),
    };
  }

  readOutbox(afterSeq: number | null): {
    reset: boolean;
    cursor: number;
    events: ChatOutboxEvent[];
    revision: number;
  } {
    const range = this.sql
      .exec<{
        oldest: number | null;
        latest: number | null;
      }>("SELECT MIN(seq) AS oldest, MAX(seq) AS latest FROM chat_outbox_v2")
      .one();
    const oldest = range.oldest === null ? 0 : Number(range.oldest);
    const latest = range.latest === null ? 0 : Number(range.latest);
    const reset =
      afterSeq === null || afterSeq < oldest - 1 || afterSeq > latest;
    if (reset) {
      return {
        reset: true,
        cursor: latest,
        events: [],
        revision: Number(this.runtime().revision),
      };
    }

    const events = this.sql
      .exec<{
        seq: number;
        revision: number;
        event_type: ChatOutboxEvent["type"];
        turn_id: string;
        status: RuntimeTurnStatus;
        created_at: number;
      }>(
        `SELECT seq, revision, event_type, turn_id, status, created_at
         FROM chat_outbox_v2 WHERE seq > ? ORDER BY seq
         LIMIT ?`,
        afterSeq,
        CHAT_RUNTIME_BOUNDS.outboxEvents,
      )
      .toArray()
      .map((row) => ({
        seq: Number(row.seq),
        revision: Number(row.revision),
        type: row.event_type,
        turnId: row.turn_id,
        status: row.status,
        createdAt: Number(row.created_at),
      }));
    return {
      reset: false,
      cursor: events.at(-1)?.seq ?? afterSeq,
      events,
      revision: Number(this.runtime().revision),
    };
  }
}
