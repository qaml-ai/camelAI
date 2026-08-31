// Durable turn/steer journal + active-turn marker for ChatThreadDO, extracted
// as a collaborator so the persistence logic is testable without a fake DO.
// All state lives in the DO's SQLite/KV storage; the class itself is stateless
// and is cached for the owning DO's lifetime with closures over its live deps
// (ChatThreadDO keeps thin same-named private delegates as its internal API).
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  sanitizePiModelMessage,
  serializePiMessageForSqlStorageDetailed,
} from "../pi-message-storage";
import { isFailedPiAssistantMessage } from "./pi-message-helpers";

// See chat-thread-do.ts recovery notes: `piActiveTurn` marks the in-flight turn —
// it gates the derived spinner (isThreadStreaming), carries the stable
// stream/message id (turnId) so a recovery continuation re-streams into the SAME
// ai-chat assistant message, and pairs with the `pi_turn_journal` table (the
// not-yet-committed model tail) to tell onChatMessage's resume branch *what* to
// continue. chatRecovery owns the PROGRESS-GATED budget; the marker additionally
// carries a progress-INDEPENDENT resume count ({@link PiTurnJournal.recordResumeAttempt})
// for the failure mode that budget cannot see — a re-drive that checkpoints
// progress and then kills the isolate, forever.
const PI_ACTIVE_TURN_KEY = "piActiveTurn";
// Durable list (sync KV) of user messages handed to steer() while a turn streams,
// so an eviction before Pi drains them can re-deliver instead of losing them.
const PI_STEER_JOURNAL_KEY = "piSteerJournal";

export interface PiActiveTurnMarker {
  // The minted assistant-message / stream id for the turn. Persisted so a recovery
  // continuation re-streams into the SAME ai-chat assistant message (its encoder is
  // rebuilt with this id, and ai-chat's continuation clone keeps the same id).
  turnId: string;
  openedAt: number;
  // How many times this turn has been re-driven through the resume path
  // ({@link PiTurnJournal.recordResumeAttempt}), whatever the cause. Absent on
  // markers written before the counter existed — and on the first attempt of a new
  // turn — which reads as 0. Lives on the marker so it dies with the turn: no reset
  // logic to forget. This total is telemetry plus a very loose absolute ceiling; the
  // tight bound is {@link isolateDeathResumeAttempts}.
  resumeAttempts?: number;
  // Re-drives charged to the progress-INDEPENDENT isolate-death budget: a recovery
  // re-drive whose predecessor left NO in-isolate trace (no caught DO-reset error,
  // no config-change dispose). That is the signature of the failure mode this bound
  // exists for — the isolate dying under memory pressure mid-turn, forever.
  isolateDeathResumeAttempts?: number;
  // When the last isolate-death-charged re-drive was counted. Used to decay the
  // counter for slow churn (resets minutes apart are a rollout, not a tight loop).
  lastIsolateDeathResumeAt?: number;
  // Re-drives this DO chose to run in-process (transient provider-error
  // regeneration, config-change rebuild). They rebuild the session the same way, so
  // they stay bounded — but under their own, separate ceiling.
  voluntaryResumeAttempts?: number;
  // Set by an in-isolate failure handler when the interruption that ended the
  // previous attempt was OBSERVED in-process (a "Durable Object reset because its
  // code was updated" RPC error, a config-change dispose). The isolate lived long
  // enough to run a handler and write this flag, so the next recovery re-drive is
  // not an isolate death and is not charged to that budget. Consumed (cleared) by
  // the recovery re-drive that reads it.
  benignInterruption?: boolean;
}

/** Why a re-drive of the open turn is happening (drives which budget it spends). */
export type PiTurnResumeCause = "recovery" | "transient_retry" | "config_change";

/** The post-increment counters for one re-drive ({@link PiTurnJournal.recordResumeAttempt}). */
export interface PiTurnResumeAttempt {
  /** Every re-drive of this turn, whatever the cause. */
  total: number;
  /** Re-drives charged to the isolate-death (OOM-class) budget. */
  isolateDeath: number;
  /** In-process re-drives this DO chose to run. */
  voluntary: number;
  /** Which counter THIS entry was charged to. */
  charged: "isolate_death" | "benign_interruption" | "voluntary";
}

function readCount(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0));
}

/** The synchronous KV surface of a SQLite-backed DO (`ctx.storage.kv`). */
export interface SyncKvStorage {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): unknown;
}

export interface PiTurnJournalDeps {
  sql(): SqlStorage;
  kv(): SyncKvStorage;
  /** Ensure the pi_core / pi_turn_journal tables exist (DO owns the DDL). */
  ensureTables(): void;
  /** Async, R2-image-externalizing serializer (DO-owned; needs env/R2). */
  serializeMessageDetailed(message: AgentMessage): Promise<{ payload: string }>;
  /** Re-inflate R2-externalized images on load (DO-owned; needs env/R2). */
  hydrateStoredImages(value: unknown): Promise<unknown>;
}

export class PiTurnJournal {
  constructor(private readonly deps: PiTurnJournalDeps) {}

  /**
   * Replace the journal with the given in-flight session tail. Serializes the
   * replacement payloads FIRST — serializeMessageDetailed can await R2/image
   * work, and an eviction during that await must NOT leave a half-written
   * journal — so the previous (valid) checkpoint is kept until the new payloads
   * are fully prepared, then swapped with no await between DELETE and INSERTs
   * (atomic from an eviction's standpoint).
   */
  async recordTail(tail: AgentMessage[]): Promise<void> {
    const payloads: string[] = [];
    for (const message of tail) {
      payloads.push((await this.deps.serializeMessageDetailed(message)).payload);
    }
    this.deps.ensureTables();
    const now = Date.now();
    const sql = this.deps.sql();
    sql.exec("DELETE FROM pi_turn_journal");
    for (let index = 0; index < payloads.length; index += 1) {
      sql.exec(
        "INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)",
        index,
        payloads[index],
        now,
      );
    }
  }

  /**
   * Seed the journal with the just-accepted user message BEFORE `prompt()` runs.
   * The first {@link recordTail} only happens on message_end, so without this an
   * eviction in the window between agent_start and the model's first message
   * would fold an empty journal, see the prior assistant turn as already
   * complete, and silently drop the accepted prompt.
   *
   * Uses the SYNCHRONOUS serializer (no R2 image externalization) so the durable
   * journal write happens with NO awaitable I/O before it — otherwise an eviction
   * during an image prompt's R2 PUT could land in a window where the marker is set
   * but the journal is still empty, and the prompt would be dropped. Oversized
   * messages are truncated/omitted by the serializer (bounded row); after the first
   * message_end, recordTail rewrites the journal with the full R2-externalized tail.
   */
  recordUserMessage(
    userMessage: AgentMessage,
    options: { append?: boolean } = {},
  ): void {
    const payload = serializePiMessageForSqlStorageDetailed(userMessage).payload;
    this.deps.ensureTables();
    const now = Date.now();
    const sql = this.deps.sql();
    if (options.append) {
      // The active-turn marker was already open when this message was accepted
      // (a second rapid send, or a send while a recovery is pending): APPEND so
      // the journal keeps every accepted-but-uncommitted user message. The
      // resume fold (planPiTurnResume) handles multiple trailing user rows.
      const rows = sql
        .exec<{ next_seq: number }>(
          "SELECT COALESCE(MAX(seq) + 1, 0) AS next_seq FROM pi_turn_journal",
        )
        .toArray();
      const nextSeq = Math.max(0, Math.floor(Number(rows[0]?.next_seq) || 0));
      sql.exec(
        "INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)",
        nextSeq,
        payload,
        now,
      );
      return;
    }
    sql.exec("DELETE FROM pi_turn_journal");
    // A brand-new turn (no marker was open), so any steer-journal entries are
    // stale leftovers from a prior run — drop them so they can't fold in here.
    this.clearSteerMessages();
    sql.exec(
      "INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)",
      0,
      payload,
      now,
    );
  }

  async loadTail(): Promise<AgentMessage[]> {
    this.deps.ensureTables();
    const rows = this.deps
      .sql()
      .exec<{ payload: string }>(
        "SELECT payload FROM pi_turn_journal ORDER BY seq ASC",
      )
      .toArray();
    const messages: AgentMessage[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const hydrated = await this.deps.hydrateStoredImages(parsed);
          messages.push(sanitizePiModelMessage(hydrated as AgentMessage));
        }
      } catch {
        // Skip corrupt journal rows rather than failing recovery.
      }
    }
    return messages;
  }

  clearTail(): void {
    this.deps.ensureTables();
    this.deps.sql().exec("DELETE FROM pi_turn_journal");
  }

  /**
   * Drop failed (stopReason error/aborted) assistant rows from the turn
   * journal. Pi journals the in-flight tail at message_end — INCLUDING the
   * error assistant message a failed run terminates on (the failed turn_end
   * discards the session tail but leaves the journal untouched). A
   * transient-retry resume must not fold that row: planPiTurnResume would see
   * the transcript as already complete (trailing assistant) and commit the
   * error message instead of regenerating. Real work in the journal (the
   * accepted user message, completed tool results) is kept.
   */
  pruneFailedAssistantMessages(): void {
    this.deps.ensureTables();
    const sql = this.deps.sql();
    const rows = sql
      .exec<{ seq: number; payload: string }>(
        "SELECT seq, payload FROM pi_turn_journal ORDER BY seq ASC",
      )
      .toArray();
    for (const row of rows) {
      let failed = false;
      try {
        const parsed = JSON.parse(row.payload) as AgentMessage;
        failed = isFailedPiAssistantMessage(parsed);
      } catch {
        // Corrupt rows are already skipped by loadTail; keep them.
      }
      if (failed) {
        sql.exec("DELETE FROM pi_turn_journal WHERE seq = ?", row.seq);
      }
    }
  }

  /**
   * Durably record a user message accepted via `steer()` while a turn is already
   * streaming, so a mid-turn eviction can re-deliver it instead of silently
   * dropping it. A small bounded list lives in sync KV (no table needed); the
   * sync serializer keeps each payload within KV's value limit, and the
   * read-push-write has no await between read and write so it is atomic against
   * eviction (same property as {@link recordUserMessage}). Appended, not
   * replaced: a single turn can accept several steering messages.
   */
  recordSteerMessage(userMessage: AgentMessage): void {
    const payload = serializePiMessageForSqlStorageDetailed(userMessage).payload;
    const kv = this.deps.kv();
    const existing = kv.get<string[]>(PI_STEER_JOURNAL_KEY) ?? [];
    existing.push(payload);
    kv.put(PI_STEER_JOURNAL_KEY, existing);
  }

  async loadSteerMessages(): Promise<AgentMessage[]> {
    const payloads = this.deps.kv().get<string[]>(PI_STEER_JOURNAL_KEY) ?? [];
    const messages: AgentMessage[] = [];
    for (const payload of payloads) {
      try {
        const parsed = JSON.parse(payload) as AgentMessage;
        if (parsed && typeof parsed === "object" && "role" in parsed) {
          const hydrated = await this.deps.hydrateStoredImages(parsed);
          messages.push(sanitizePiModelMessage(hydrated as AgentMessage));
        }
      } catch {
        // Skip corrupt entries rather than failing recovery.
      }
    }
    return messages;
  }

  clearSteerMessages(): void {
    this.deps.kv().delete(PI_STEER_JOURNAL_KEY);
  }

  readActiveTurn(): PiActiveTurnMarker | null {
    return this.deps.kv().get<PiActiveTurnMarker>(PI_ACTIVE_TURN_KEY) ?? null;
  }

  /**
   * Mark a turn in flight (once per turn) so a cold load knows to resume it and
   * derives the busy spinner. The minted turnId is the stable assistant-message /
   * stream id: onChatMessage builds the encoder from it, and a recovery
   * continuation re-streams into the same ai-chat message under it.
   */
  openActiveTurnIfAbsent(): void {
    if (this.readActiveTurn()) return;
    this.writeActiveTurn({
      turnId: crypto.randomUUID(),
      openedAt: Date.now(),
    });
  }

  /**
   * Count one resume re-drive against the open turn and return the new counters
   * (null when no turn is open — nothing to bound). Legacy markers with no counts
   * read as 0, so the first re-drive of an in-flight turn written by an older build
   * returns 1.
   *
   * The counters are SPLIT BY CAUSE on purpose. A re-drive after an isolate death
   * (nothing in-process observed the interruption) is the failure mode the tight,
   * progress-independent budget exists for. A re-drive after an interruption this
   * isolate CAUGHT — a DO code-update reset, a config-change dispose — is
   * demonstrably survivable (one production thread absorbed 15 consecutive resets
   * and still answered correctly), and an in-process regeneration this DO chose to
   * run is bounded by its own caller-side budget. Charging all of them to one
   * 3-attempt counter abandons healthy turns on ordinary deploy/provider churn.
   *
   * `isolateDeathDecayMs` additionally forgives the isolate-death counter when the
   * previous charged attempt is older than the window: kills minutes apart are a
   * rollout walking the fleet, not the tight kill loop the bound targets. The decay
   * is evaluated for EVERY cause, before the charge — the returned count also picks
   * the recovery-ladder rung, and a voluntary (transient-retry / config-change) or
   * benign re-drive that read a stale, already-forgiven count would degrade or
   * salvage a turn the decay window says is healthy. Forgiveness is persisted too,
   * so a later real isolate death restarts at 1 exactly as it would have if the
   * re-drive in between had been a recovery.
   *
   * The read-modify-write is the SYNCHRONOUS kv put on purpose, with no await
   * between read and write: the failure being counted is the isolate dying
   * seconds later inside the very resume this call is opening, which loses
   * anything still queued behind an await (same lesson as the wake breaker).
   */
  recordResumeAttempt(
    cause: PiTurnResumeCause = "recovery",
    options: { now?: number; isolateDeathDecayMs?: number } = {},
  ): PiTurnResumeAttempt | null {
    const marker = this.readActiveTurn();
    if (!marker) return null;
    const now = options.now ?? Date.now();
    const decayMs = Math.max(0, Math.floor(Number(options.isolateDeathDecayMs) || 0));
    const total = readCount(marker.resumeAttempts) + 1;
    let isolateDeath = readCount(marker.isolateDeathResumeAttempts);
    let voluntary = readCount(marker.voluntaryResumeAttempts);
    let charged: PiTurnResumeAttempt["charged"];
    const next: PiActiveTurnMarker = { ...marker, resumeAttempts: total };
    // The flag describes the ONE interruption that preceded this re-drive, so any
    // re-drive consumes it — a stale flag must never forgive a later isolate death.
    delete next.benignInterruption;
    // Cause-independent: whatever charges below, the count this call REPORTS (and
    // the ladder rung derived from it) must already reflect the decay window.
    const lastIsolateDeathAt = readCount(marker.lastIsolateDeathResumeAt);
    if (decayMs > 0 && lastIsolateDeathAt > 0 && now - lastIsolateDeathAt >= decayMs) {
      isolateDeath = 0;
      delete next.lastIsolateDeathResumeAt;
    }
    if (cause === "recovery") {
      if (marker.benignInterruption) {
        // The previous attempt ended in an interruption this isolate observed and
        // classified as recoverable; it is not evidence of memory pressure.
        charged = "benign_interruption";
      } else {
        isolateDeath += 1;
        charged = "isolate_death";
        next.lastIsolateDeathResumeAt = now;
      }
    } else {
      voluntary += 1;
      charged = "voluntary";
    }
    next.isolateDeathResumeAttempts = isolateDeath;
    next.voluntaryResumeAttempts = voluntary;
    this.writeActiveTurn(next);
    return { total, isolateDeath, voluntary, charged };
  }

  /**
   * Record that the interruption that just ended (or is about to end) this turn's
   * attempt was observed IN-PROCESS — a DO code-update reset surfaced as a
   * transient RPC error, or a deliberate config-change dispose. The next recovery
   * re-drive reads and clears the flag and skips the isolate-death budget.
   *
   * Synchronous kv write for the same reason the counter is: the eviction it
   * describes can land immediately after.
   */
  markBenignInterruption(): void {
    const marker = this.readActiveTurn();
    if (!marker || marker.benignInterruption) return;
    this.writeActiveTurn({ ...marker, benignInterruption: true });
  }

  writeActiveTurn(marker: PiActiveTurnMarker): void {
    this.deps.kv().put(PI_ACTIVE_TURN_KEY, marker);
  }

  async clearActiveTurnAndJournal(): Promise<void> {
    this.deps.kv().delete(PI_ACTIVE_TURN_KEY);
    this.clearTail();
    // Steering messages span the whole agent run (a steer can drain in a later
    // turn), so they are only dropped here at agent_end — not at per-turn turn_end.
    this.clearSteerMessages();
  }
}
