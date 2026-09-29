/**
 * ChatThreadDO's side of moving its thread to the agent runtime
 * (agent-runtime/thread-migration.ts has the worker's side and the import
 * format). The DO drives the move, one state at a time, each kept in its KV:
 *
 *   leased      the history is exported and the agent made, under a lease
 *               renewed while the work goes on; no new turns. Expiry (the
 *               alarm) undoes it: the agent is deleted and the thread carries
 *               on here.
 *   committing  checked against the thread (no turn running, no transcript
 *               change since the lease began); no turns, and no expiry: the
 *               thread_runtime row is written compare-and-set (OrgDO keeps
 *               the first agent a thread is given), then the move is final.
 *               A commit that failed is re-driven by the alarm or the next
 *               call, however far it got.
 *   moved       the thread runs on the runtime; this DO refuses turns.
 *   failed      a move that did not happen, with a backoff before the next
 *               attempt, and the agent it made (or the key it made it under)
 *               until that is deleted.
 *
 * Every write re-reads the record and goes ahead only if it is still the one
 * this call holds, so no await can let a stale write undo another's. No
 * agent the thread's runtime row holds is ever deleted.
 */
import type { AgentMessage } from "../../../../src/lib/agent-messages.js";
import type { ChatEnv } from "./types.js";
import type { PreviewTarget } from "../../../../src/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import type { PiCoreRevision } from "./pi-core-store.js";
import { RuntimeApiError, provisionedAgentId, retryAfterMs, runtimeApi, runtimeUrl } from "../agent-runtime/runtime-api.js";
import { runtimeSystemPromptAppend, type RuntimeAgentModel } from "../agent-runtime/run-gates.js";
import { RUNTIME_PROMPT_VERSION } from "../agent-runtime/runtime-prompt.js";
import {
  ARCHIVE_FILE_NAME,
  ARCHIVE_REQUEST_ID,
  convertTranscript,
  runtimeMigrationKey,
  withImportNote,
  type DoMigrationRequest,
  type DoMigrationResult,
} from "../agent-runtime/thread-migration.js";
import { renderArchiveToPiMessages, type RenderMessage } from "./render-archive-export.js";

export const RUNTIME_MIGRATION_KEY = "runtimeMigration";
/** How long a move holds the thread without progress before the alarm undoes it. */
export const RUNTIME_MIGRATION_LEASE_MS = 2 * 60_000;
/** The agent create's deadline: well inside the lease it runs under. */
export const RUNTIME_MIGRATION_CREATE_TIMEOUT_MS = RUNTIME_MIGRATION_LEASE_MS - 30_000;
/** The history a move may hold at once; over it, only the model's window moves (and the whole is archived). */
export const RUNTIME_MIGRATION_EXPORT_MAX_CHARS = 12_000_000;
/** Pre-compaction render history (UI only) a move brings along; older is in the archive. */
export const RUNTIME_MIGRATION_RENDER_ARCHIVE_MAX_CHARS = 4_000_000;
/** How long a thread the runtime will not take (too large, content it refuses) waits before it is tried again. */
export const PERMANENT_FAILURE_RETRY_MS = 24 * 60 * 60_000;
/**
 * How long an agent made under a key a cut-off create used may still appear
 * (the runtime finishing the create after chiridion stopped waiting): until
 * then, a key that finds no agent is not forgotten.
 */
export const ORPHAN_KEY_SETTLE_MS = 10 * 60_000;
/** Deadline for one runtime or OrgDO call the move makes outside the create and the archive. */
export const RUNTIME_MIGRATION_CALL_TIMEOUT_MS = 20_000;
/** Deadline for the archive upload, whatever its size (the lease is renewed as it streams). */
export const RUNTIME_MIGRATION_ARCHIVE_TIMEOUT_MS = 15 * 60_000;

interface MoveIdentity {
  orgId: string;
  threadId: string;
}

export type RuntimeMigrationRecord =
  | (MoveIdentity & {
    phase: "leased";
    leaseId: string;
    startedAt: number;
    expiresAt: number;
    revision: PiCoreRevision;
    failures: number;
    /** The Idempotency-Key the agent is (being) made under (this attempt's own), set before the create. */
    pendingKey?: string;
    agentId?: string;
    /** What an earlier attempt left behind, deleted under this lease before anything is made. */
    orphanAgentId?: string;
    orphanKey?: string;
    orphanKeyAt?: number;
  })
  | (MoveIdentity & {
    phase: "committing";
    leaseId: string;
    agentId: string;
    previewTabs: PreviewTarget[];
    previewActiveTabId: string | null;
    attempts: number;
    /** What the agent was made with, recorded on the runtime row it is claimed under. */
    agentModel?: RuntimeAgentModel;
    stats?: Extract<DoMigrationResult, { status: "migrated" }>["stats"];
    archived?: boolean;
    /** Why the archive the import names is not the original (the runtime would not keep it). */
    archiveNote?: string;
  })
  | { phase: "moved"; leaseId: string; agentId: string; movedAt: number }
  | (Partial<MoveIdentity> & {
    phase: "failed";
    failures: number;
    retryAt: number;
    error: string;
    orphanAgentId?: string;
    /** The key of a create that was cut off, and when: the agent it may have made is looked for until it settles. */
    orphanKey?: string;
    orphanKeyAt?: number;
  });

/** Where a move stands; `error` is why the last attempt failed (while backing off). */
export interface RuntimeMigrationStatus {
  state: "moving" | "committing" | "moved" | "backoff" | null;
  retryAt?: number;
  error?: string;
}

type Leased = Extract<RuntimeMigrationRecord, { phase: "leased" }>;
type Committing = Extract<RuntimeMigrationRecord, { phase: "committing" }>;
type Failed = Extract<RuntimeMigrationRecord, { phase: "failed" }>;

export interface RuntimeMigrationDeps {
  env: ChatEnv;
  kv: {
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
  };
  /** Why the thread cannot move right now (a turn, an automation run, an open question), or null. */
  busyReason(): string | null;
  /** The thread relays to a runtime agent (adopted, not imported). */
  hasRelayAgent(): boolean;
  revision(): PiCoreRevision;
  loadHistory(maxChars: number): Promise<{ messages: AgentMessage[]; whole: boolean; openingRenderMessageId?: string | null }>;
  /** The render rows older than `beforeMs` (a compaction's only copy of history below its cut), newest page first. */
  renderArchivePages(beforeMs: number): Iterable<RenderMessage[]>;
  /** When stored history begins: the oldest stored message that is no compaction summary. */
  firstStoredAtMs(): number | undefined;
  /** Every stored transcript row as stored, a bounded batch at a time. */
  payloadBatches(): Iterable<string[]>;
  preview(): { tabs: PreviewTarget[]; activeTabId: string | null };
  /** Wake the DO at `at` and call {@link ChatThreadRuntimeMigration.onAlarm}. */
  scheduleAlarm(at: number): void;
  waitUntil(promise: Promise<unknown>): void;
  /** The thread runs here again: take back what was queued for its runtime prompt meanwhile. */
  onUndone(): void;
  /** The thread's org, where the DO knows it. */
  orgId(): string | undefined;
}

interface OrgStub {
  setThreadUiState(threadId: string, preview: Record<string, unknown> | null): Promise<unknown>;
  claimThreadRuntimeAgent(
    threadId: string,
    agentId: string,
    configuration?: { model: string | null; keyScope: string | null; configured: Record<string, unknown> | null },
  ): Promise<{ row: ThreadRuntimeRecord; claimed: boolean } | null>;
  getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
}

/** The pause before the next attempt after `failures` failed ones: 1 min, doubling, at most 6 h. */
export function migrationBackoffMs(failures: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
}

const commitRetryMs = (attempts: number) => Math.min(10 * 60_000, 30_000 * 2 ** attempts);

/**
 * A refusal the runtime will give every time for this history (its import
 * validator, its size cap): tried again only after a day. Any other refusal
 * (a key scope or model the runtime lacks: chiridion's configuration, not the
 * history) is retried on the usual backoff.
 */
function permanentRefusal(error: unknown): string | null {
  if (!(error instanceof RuntimeApiError)) return null;
  if (error.code === "INVALID_HISTORY" || /INVALID_HISTORY/.test(error.message)) return "invalid_history";
  if (error.status === 413 || error.code === "HISTORY_TOO_LARGE") return "too_large";
  return null;
}

/** A fetch with the move's per-call deadline. */
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RUNTIME_MIGRATION_CALL_TIMEOUT_MS) });

/** An OrgDO call with the move's per-call deadline. */
function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the call timed out")), RUNTIME_MIGRATION_CALL_TIMEOUT_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function runtimeError(method: string, path: string, response: Response): Promise<RuntimeApiError> {
  const text = await response.text().catch(() => "");
  let code: string | null = null;
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    if (typeof parsed?.code === "string") code = parsed.code;
  } catch {
    // Not JSON.
  }
  return new RuntimeApiError(
    `Agent runtime ${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`,
    response.status,
    code,
    retryAfterMs(response.headers.get("retry-after")),
  );
}

export class ChatThreadRuntimeMigration {
  constructor(private readonly deps: RuntimeMigrationDeps) {}

  private read(): RuntimeMigrationRecord | undefined {
    const record = this.deps.kv.get<RuntimeMigrationRecord>(RUNTIME_MIGRATION_KEY);
    return record && typeof record === "object" && "phase" in record ? record : undefined;
  }

  private write(record: RuntimeMigrationRecord): void {
    this.deps.kv.put(RUNTIME_MIGRATION_KEY, record);
  }

  /** The live lease `leaseId`, or null once it is not (expired, undone, or moved on). */
  private lease(leaseId: string): Leased | null {
    const record = this.read();
    return record?.phase === "leased" && record.leaseId === leaseId && record.expiresAt > Date.now() ? record : null;
  }

  /** Change the lease, and push its expiry out: the move is making progress. False once it is not ours. */
  private renew(leaseId: string, change: Partial<Leased> = {}): boolean {
    const record = this.lease(leaseId);
    if (!record) return false;
    const expiresAt = Date.now() + RUNTIME_MIGRATION_LEASE_MS;
    this.write({ ...record, ...change, expiresAt });
    this.deps.scheduleAlarm(expiresAt + 1_000);
    return true;
  }

  /** Whether turns are refused here: while a move holds the thread, and for good once it moved. */
  state(now = Date.now()): "moving" | "moved" | null {
    const record = this.read();
    if (!record) return null;
    if (record.phase === "moved") return "moved";
    if (record.phase === "committing") return "moving";
    if (record.phase === "leased" && record.expiresAt > now) return "moving";
    return null;
  }

  /** Where the move stands, for a caller deciding whether to ask for one (and do the work to). */
  status(now = Date.now()): RuntimeMigrationStatus {
    // A commit the caller should re-drive (migrate() does), not wait out.
    if (this.read()?.phase === "committing") return { state: "committing" };
    const state = this.state(now);
    if (state) return { state };
    const record = this.read();
    if (record?.phase === "failed" && record.retryAt > now) return { state: "backoff", retryAt: record.retryAt, error: record.error };
    return { state: null };
  }

  /**
   * End a failed move's backoff (an operator retrying it): the next open or
   * send may move the thread at once. What the failed attempt left to delete
   * stays recorded, and is deleted before the next agent is made. False when
   * the thread is not backing off.
   */
  clearBackoff(now = Date.now()): boolean {
    const record = this.read();
    // A deleted thread's record never retries.
    if (record?.phase !== "failed" || record.retryAt <= now || record.retryAt === Number.MAX_SAFE_INTEGER) return false;
    this.write({ ...record, retryAt: now });
    return true;
  }

  /**
   * Whether this thread's move holds `agentId` (made under `key`): its agent
   * once moved or committing, or the one a live lease is making. For the
   * orphan reconciler; `orgId` lets it check the thread's runtime row too.
   */
  holds(agentId: string, key: string | null): { holds: boolean; orgId?: string } {
    const record = this.read();
    const orgId = record && "orgId" in record && record.orgId ? record.orgId : this.deps.orgId();
    if (!record) return { holds: false, orgId };
    if (record.phase === "moved" || record.phase === "committing") return { holds: record.agentId === agentId, orgId };
    if (record.phase === "leased") return { holds: record.agentId === agentId || (key !== null && record.pendingKey === key), orgId };
    return { holds: false, orgId };
  }

  /** Move the thread (see the module comment), or say why not. */
  async migrate(request: DoMigrationRequest): Promise<DoMigrationResult> {
    const { context } = request;
    let record = this.read();
    const now = Date.now();
    if (record?.phase === "moved") return { status: "skipped", reason: "moved" };
    if (record?.phase === "committing") return request.dryRun ? { status: "busy", reason: "moving" } : await this.commit(record);
    if (record?.phase === "leased") {
      if (record.expiresAt > now) return { status: "busy", reason: "moving" };
      this.fail(record.leaseId, "the move's lease ran out");
      record = this.read();
    }
    const failed = record?.phase === "failed" ? record : null;
    if (!request.dryRun && failed && failed.retryAt > now) return { status: "skipped", reason: `backoff: ${failed.error}` };
    const busy = this.deps.busyReason();
    if (busy) return { status: "busy", reason: busy };
    if (this.deps.hasRelayAgent()) return { status: "relay" };

    if (request.dryRun) {
      const history = await this.history();
      const converted = convertTranscript(history.messages);
      if (converted.tooLarge) return { status: "skipped", reason: "too_large" };
      const archived = history.archived || converted.lossy;
      return {
        status: "dry_run",
        stats: converted.stats,
        lossy: archived,
        bytes: new TextEncoder().encode(JSON.stringify(withImportNote(converted.messages, archived))).length,
      };
    }

    // The lease is written first, carrying what an earlier attempt left
    // behind: that is deleted under it, so nothing else can move meanwhile.
    const leaseId = crypto.randomUUID();
    const lease: Leased = {
      phase: "leased",
      leaseId,
      orgId: context.orgId,
      threadId: context.threadId,
      startedAt: now,
      expiresAt: now + RUNTIME_MIGRATION_LEASE_MS,
      revision: this.deps.revision(),
      failures: failed?.failures ?? 0,
      ...(failed?.orphanAgentId ? { orphanAgentId: failed.orphanAgentId } : {}),
      ...(failed?.orphanKey ? { orphanKey: failed.orphanKey, orphanKeyAt: failed.orphanKeyAt ?? now } : {}),
    };
    this.write(lease);
    this.deps.scheduleAlarm(lease.expiresAt + 1_000);

    try {
      if (lease.orphanAgentId || lease.orphanKey) {
        const cleared = await this.deleteLeftovers(lease, lease, () => this.lease(leaseId) !== null);
        if (!this.lease(leaseId)) return { status: "failed", error: "the move's lease ran out" };
        if (cleared !== "done") {
          // An earlier attempt's agent is still to be deleted (or may still
          // appear): no new agent is made until it is settled.
          this.release(leaseId, cleared === "settling" ? (lease.orphanKeyAt ?? now) + ORPHAN_KEY_SETTLE_MS : Date.now() + migrationBackoffMs(lease.failures + 1));
          return { status: "skipped", reason: "backoff: an earlier attempt's agent is not deleted yet" };
        }
        this.renew(leaseId, { orphanAgentId: undefined, orphanKey: undefined, orphanKeyAt: undefined });
      }

      const history = await this.history();
      const converted = convertTranscript(history.messages);
      history.messages = [];
      if (converted.tooLarge) {
        this.fail(leaseId, "too_large", PERMANENT_FAILURE_RETRY_MS);
        return { status: "skipped", reason: "too_large" };
      }
      const archived = history.archived || converted.lossy;
      // Nothing here holds the history while it is sent: createAgent keeps only its bytes.
      const held = { messages: withImportNote(converted.messages, archived) };
      converted.messages = [];
      const agentId = await this.createAgent(leaseId, request, held);
      if (!agentId) return { status: "failed", error: "the move's lease ran out" };
      const archive = archived ? await this.archive(leaseId, agentId) : null;

      const prepared = this.prepare(leaseId, agentId, context.orgId, context.threadId, request.agentModel);
      if (typeof prepared === "string") {
        this.fail(leaseId, prepared);
        return { status: "busy", reason: prepared };
      }
      return await this.commit({ ...prepared, stats: converted.stats, archived, ...(archive === "too_large" ? { archiveNote: "archive too large; the move went on without it" } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = permanentRefusal(error);
      // The runtime asked for a pause (429, 503): the thread waits at least that long, and so does a sweep.
      const asked = error instanceof RuntimeApiError ? error.retryAfterMs : null;
      this.fail(
        leaseId,
        permanent ? `${permanent}: ${message}` : message,
        permanent ? PERMANENT_FAILURE_RETRY_MS : asked !== null ? Math.max(asked, migrationBackoffMs(1)) : undefined,
      );
      if (permanent) return { status: "skipped", reason: `${permanent}: ${message}` };
      // When the next attempt is due (the backoff just written), for a page that says so.
      const failed = this.read();
      const retryAt = failed?.phase === "failed" ? failed.retryAt : undefined;
      return {
        status: "failed",
        error: message,
        ...(asked !== null ? { retryAfterMs: asked } : {}),
        ...(retryAt !== undefined ? { retryAt } : {}),
      };
    }
  }

  /**
   * When the record next needs the alarm (a lease to expire, a commit to
   * re-drive, a failed attempt's agent to delete), or null. For re-arming an
   * alarm that was lost.
   */
  alarmDue(now = Date.now()): number | null {
    const record = this.read();
    if (record?.phase === "leased") return record.expiresAt + 1_000;
    if (record?.phase === "committing") return now;
    if (record?.phase === "failed" && (record.orphanAgentId || record.orphanKey)) return now;
    return null;
  }

  /** The alarm: undo a move whose lease ran out, re-drive a commit, delete a failed attempt's agent. */
  async onAlarm(): Promise<void> {
    const record = this.read();
    if (!record) return;
    if (record.phase === "leased") {
      if (record.expiresAt <= Date.now()) this.fail(record.leaseId, "the move's lease ran out");
      else this.deps.scheduleAlarm(record.expiresAt + 1_000);
    } else if (record.phase === "committing") {
      await this.commit(record);
    } else if (record.phase === "failed" && (record.orphanAgentId || record.orphanKey)) {
      this.cleanUpFailed(record);
    }
  }

  /**
   * The history to import: the pi_core export and, before it, the render rows
   * older than anything it holds (what a rewrite compaction left as the only
   * copy of history below its cut), rebuilt as pi messages. Only rows older
   * than the export's oldest message come (the chat page's archive seam), and
   * of a turn the cut split (the render message the export's first row
   * belongs to) only the part the export does not repeat. `archived`: the
   * import is not the whole history as stored.
   */
  private async history(): Promise<{ messages: AgentMessage[]; archived: boolean }> {
    const history = await this.deps.loadHistory(RUNTIME_MIGRATION_EXPORT_MAX_CHARS);
    const exported = history.messages as Array<{ role?: string; content?: unknown; timestamp?: unknown }>;
    const isSummary = (message: { role?: string; content?: unknown }) =>
      message.role === "user" && typeof message.content === "string" && message.content.startsWith("[Context Summary]");
    const held = exported.filter((message) => !isSummary(message));
    const seam = held.reduce<number | undefined>((oldest, message) =>
      typeof message.timestamp === "number" && (oldest === undefined || message.timestamp < oldest) ? message.timestamp : oldest, undefined);

    const pages: RenderMessage[][] = [];
    let chars = 0;
    let complete = true;
    for (const page of seam === undefined ? [] : this.deps.renderArchivePages(seam)) {
      const kept = page;
      const size = kept.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
      if (chars + size > RUNTIME_MIGRATION_RENDER_ARCHIVE_MAX_CHARS) {
        complete = false;
        break;
      }
      chars += size;
      if (kept.length) pages.push(kept);
    }
    const archivedRows = pages.reverse().flat();

    // A cut inside a turn: the export opens on that turn's later rows, and the
    // archived render message of the same id is the whole turn. Its rebuilt
    // tail that the export repeats goes; if the two do not line up, the
    // archived turn goes (the archive file keeps it).
    const firstHeld = exported.findIndex((message) => !isSummary(message));
    const opening: string[] = [];
    for (let index = firstHeld; index >= 0 && index < exported.length && exported[index].role !== "user"; index++) {
      if (!isSummary(exported[index])) opening.push(String(exported[index].role));
    }
    let before: AgentMessage[];
    const fold = archivedRows.at(-1);
    if (opening.length && fold?.role === "assistant" && history.openingRenderMessageId && fold.id === history.openingRenderMessageId) {
      const rebuilt = renderArchiveToPiMessages([fold]) as unknown as Array<{ role?: string }>;
      const tail = rebuilt.slice(-opening.length).map((message) => String(message.role));
      const lined = tail.length === opening.length && tail.every((role, index) => role === opening[index]);
      before = [
        ...renderArchiveToPiMessages(archivedRows.slice(0, -1)),
        ...(lined ? rebuilt.slice(0, -opening.length) as unknown as AgentMessage[] : []),
      ];
      if (!lined) complete = false;
    } else {
      before = renderArchiveToPiMessages(archivedRows);
    }
    // Rows that open on a summary lost what came before it from pi_core.
    const cutByRewrite = exported[0] !== undefined && isSummary(exported[0]);
    return {
      messages: before.length ? [...before, ...history.messages] : history.messages,
      archived: !history.whole || before.length > 0 || !complete || cutByRewrite,
    };
  }

  /**
   * Check the move against the thread, synchronously, and hold it for the
   * commit: the lease is still ours and live, no turn runs, and the
   * transcript is the one exported. Returns why not otherwise.
   */
  private prepare(leaseId: string, agentId: string, orgId: string, threadId: string, agentModel?: RuntimeAgentModel): Committing | string {
    const record = this.lease(leaseId);
    if (!record || record.agentId !== agentId) return "the move's lease ran out";
    const busy = this.deps.busyReason();
    if (busy) return busy;
    const revision = this.deps.revision();
    if (revision.generation !== record.revision.generation || revision.count !== record.revision.count) {
      return "the thread changed while it was moving";
    }
    const { tabs, activeTabId } = this.deps.preview();
    const committing: Committing = {
      phase: "committing",
      leaseId,
      agentId,
      orgId,
      threadId,
      previewTabs: tabs,
      previewActiveTabId: activeTabId,
      attempts: 0,
      ...(agentModel ? { agentModel } : {}),
    };
    this.write(committing);
    return committing;
  }

  private org(orgId: string): OrgStub {
    return this.deps.env.ORG.get(this.deps.env.ORG.idFromName(orgId)) as unknown as OrgStub;
  }

  /**
   * Claim the thread's runtime row for the agent, then finish. Safe to
   * re-drive from any point: the row is only ever claimed for one agent, and
   * the preview tabs are best-effort (they never hold a commit up). A claim
   * that failed ambiguously is settled by reading the row back; one that
   * cannot be settled is retried by the alarm, the thread still held.
   */
  private async commit(record: Committing): Promise<DoMigrationResult> {
    const org = this.org(record.orgId);
    let outcome: { row: ThreadRuntimeRecord; claimed: boolean } | null;
    try {
      // The row records what the agent was made with, as a new thread's does, so its first send reconfigures nothing.
      const configuration = record.agentModel
        ? {
          model: record.agentModel.model,
          keyScope: record.agentModel.keyScope,
          configured: { thinkingLevel: record.agentModel.thinkingLevel, promptVersion: RUNTIME_PROMPT_VERSION },
        }
        : undefined;
      outcome = await withTimeout(org.claimThreadRuntimeAgent(record.threadId, record.agentId, configuration));
    } catch (error) {
      const row = await withTimeout(org.getThreadRuntime(record.threadId)).catch(() => undefined);
      if (!row) {
        const current = this.read();
        if (current?.phase === "committing" && current.leaseId === record.leaseId) {
          this.write({ ...current, attempts: current.attempts + 1 });
          this.deps.scheduleAlarm(Date.now() + commitRetryMs(current.attempts));
        }
        return { status: "failed", error: `the move's commit is pending: ${error instanceof Error ? error.message : String(error)}` };
      }
      outcome = { row, claimed: row.agentId === record.agentId };
    }
    const current = this.read();
    if (current?.phase !== "committing" || current.leaseId !== record.leaseId) {
      return outcome ? { status: "runtime", row: outcome.row } : { status: "skipped", reason: "moved" };
    }
    if (!outcome) {
      // The thread was deleted meanwhile: nothing to move it to.
      const failed: Failed = { phase: "failed", failures: 1, retryAt: Number.MAX_SAFE_INTEGER, error: "thread deleted", orgId: record.orgId, threadId: record.threadId, orphanAgentId: record.agentId };
      this.write(failed);
      this.cleanUpFailed(failed);
      return { status: "skipped", reason: "thread deleted" };
    }
    this.write({ phase: "moved", leaseId: record.leaseId, agentId: outcome.row.agentId ?? record.agentId, movedAt: Date.now() });
    if (outcome.claimed && record.previewTabs.length) {
      this.deps.waitUntil(org.setThreadUiState(record.threadId, { tabs: record.previewTabs, activeTabId: record.previewActiveTabId })
        .catch((error: unknown) => console.warn("[runtime-migration] the moved thread's preview tabs were not saved", error)));
    }
    if (!outcome.claimed) {
      // It was already on the runtime (another path gave it an agent first): ours is spare.
      this.deps.waitUntil(this.deleteLeftovers(record, { agentId: record.agentId }, () => true));
      return { status: "runtime", row: outcome.row };
    }
    return record.stats
      ? { status: "migrated", row: outcome.row, stats: record.stats, archived: record.archived ?? false, ...(record.archiveNote ? { reason: record.archiveNote } : {}) }
      : { status: "runtime", row: outcome.row };
  }

  /**
   * Undo the move under `leaseId`, if it still holds the thread: the thread
   * runs here again after a backoff, and what the move made is deleted.
   */
  private fail(leaseId: string, error: string, retryMs?: number): void {
    const record = this.read();
    if (record?.phase !== "leased" || record.leaseId !== leaseId) return;
    const failures = record.failures + 1;
    const orphanAgentId = record.agentId ?? record.orphanAgentId;
    // This attempt's key when its create was cut off (no agent id came back).
    const orphanKey = record.agentId ? record.orphanKey : record.pendingKey ?? record.orphanKey;
    const orphanKeyAt = orphanKey === record.pendingKey && !record.agentId ? Date.now() : record.orphanKeyAt;
    const failed: Failed = {
      phase: "failed",
      failures,
      retryAt: Date.now() + (retryMs ?? migrationBackoffMs(failures)),
      error,
      orgId: record.orgId,
      threadId: record.threadId,
      ...(orphanAgentId ? { orphanAgentId } : {}),
      ...(orphanKey ? { orphanKey, orphanKeyAt: orphanKeyAt ?? Date.now() } : {}),
    };
    this.write(failed);
    this.deps.onUndone();
    if (orphanAgentId || orphanKey) this.cleanUpFailed(failed);
  }

  /** Give the thread back without a failure: the next attempt waits until `retryAt`, carrying what is left to delete. */
  private release(leaseId: string, retryAt: number): void {
    const record = this.read();
    if (record?.phase !== "leased" || record.leaseId !== leaseId) return;
    this.write({
      phase: "failed",
      failures: record.failures,
      retryAt,
      error: "an earlier attempt's agent is not deleted yet",
      orgId: record.orgId,
      threadId: record.threadId,
      ...(record.orphanAgentId ? { orphanAgentId: record.orphanAgentId } : {}),
      ...(record.orphanKey ? { orphanKey: record.orphanKey, orphanKeyAt: record.orphanKeyAt ?? Date.now() } : {}),
    });
    this.deps.onUndone();
    this.deps.scheduleAlarm(retryAt);
  }

  /**
   * Delete what a failed move left, in the background, only while the failed
   * record still names it, and forget it once gone. What cannot be settled
   * yet (a delete that failed, a cut-off create's key that finds nothing
   * before it settles) is tried again by the alarm.
   */
  private cleanUpFailed(record: Failed): void {
    if (!record.orgId || !record.threadId) return;
    const identity = { orgId: record.orgId, threadId: record.threadId };
    const same = (current: RuntimeMigrationRecord | undefined): current is Failed =>
      current?.phase === "failed" && current.orphanAgentId === record.orphanAgentId && current.orphanKey === record.orphanKey;
    this.deps.waitUntil(this.deleteLeftovers(identity, record, () => same(this.read())).then((outcome) => {
      const current = this.read();
      if (!same(current)) return;
      if (outcome === "done") {
        this.write({ ...current, orphanAgentId: undefined, orphanKey: undefined, orphanKeyAt: undefined });
        return;
      }
      const again = outcome === "settling"
        ? (record.orphanKeyAt ?? Date.now()) + ORPHAN_KEY_SETTLE_MS
        : Date.now() + migrationBackoffMs(current.failures);
      this.deps.scheduleAlarm(again);
    }));
  }

  /**
   * Delete the agent a move made, and the one its key made when the create
   * was cut off, while `stillOwned()` (re-checked before each delete), and
   * never the agent the thread's runtime row holds (re-read before each).
   * "done": nothing is left; "settling": the key found no agent yet, but a
   * create cut off within ORPHAN_KEY_SETTLE_MS may still make one; "failed":
   * a delete or a read did not go through.
   */
  private async deleteLeftovers(
    identity: MoveIdentity,
    leftovers: { orphanAgentId?: string; orphanKey?: string; orphanKeyAt?: number; agentId?: string },
    stillOwned: () => boolean,
  ): Promise<"done" | "settling" | "failed"> {
    const candidates: Array<{ id: string; byKey: boolean }> = [];
    const agentId = leftovers.orphanAgentId ?? leftovers.agentId;
    if (agentId) candidates.push({ id: agentId, byKey: false });
    const tenant = this.deps.env.AGENT_RUNTIME_TENANT?.trim();
    if (leftovers.orphanKey && tenant) {
      const byKey = await provisionedAgentId(tenant, leftovers.orphanKey);
      if (byKey !== agentId) candidates.push({ id: byKey, byKey: true });
    }
    let outcome: "done" | "settling" | "failed" = "done";
    for (const candidate of candidates) {
      if (!stillOwned()) return "failed";
      let held: string | null;
      try {
        held = (await withTimeout(this.org(identity.orgId).getThreadRuntime(identity.threadId)))?.agentId ?? null;
      } catch (error) {
        console.warn("[runtime-migration] could not read the thread's runtime row; nothing deleted", error);
        return "failed";
      }
      if (candidate.id === held) {
        console.warn("[runtime-migration] kept an agent the thread's runtime row holds", { agentId: candidate.id });
        continue;
      }
      if (!stillOwned()) return "failed";
      const deleted = await this.deleteAgent(candidate.id);
      if (deleted === "failed") outcome = "failed";
      else if (deleted === "absent" && candidate.byKey && outcome === "done"
        && Date.now() < (leftovers.orphanKeyAt ?? 0) + ORPHAN_KEY_SETTLE_MS) outcome = "settling";
    }
    return outcome;
  }

  private async deleteAgent(agentId: string): Promise<"deleted" | "absent" | "failed"> {
    try {
      await runtimeApi(this.deps.env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`, undefined, {}, timedFetch);
      return "deleted";
    } catch (error) {
      if (error instanceof RuntimeApiError && (error.status === 404 || error.status === 410)) return "absent";
      console.warn("[runtime-migration] could not delete the agent of a move that did not happen", error);
      return "failed";
    }
  }

  /**
   * The agent, made with the history, under the lease; null once the lease
   * is lost. Its Idempotency-Key is this attempt's own (the thread and the
   * lease), recorded in the lease before the call: a retry within the attempt
   * gets the same agent back, a create cut off anywhere can be found and
   * deleted exactly, and no two attempts ever share an agent.
   */
  private async createAgent(leaseId: string, request: DoMigrationRequest, held: { messages: AgentMessage[] }): Promise<string | null> {
    const { env } = this.deps;
    const { context } = request;
    // The history is serialized and encoded once, then only its bytes are kept.
    const hasHistory = held.messages.length > 0;
    const history = new TextEncoder().encode(JSON.stringify(held.messages)) as Uint8Array<ArrayBuffer>;
    held.messages = [];
    // Made as a new thread's agent is: on its model and key scope (without
    // them the runtime falls back to its default model's keys, which the tenant may not have).
    const agentModel = request.agentModel;
    if (!agentModel) throw new Error("the move has no model for its agent");
    const key = runtimeMigrationKey(context.threadId, leaseId);
    if (!this.renew(leaseId, { pendingKey: key })) return null;
    const fields = JSON.stringify({
      definition: env.AGENT_RUNTIME_DEFINITION,
      name: context.threadId,
      type: "camelai-thread",
      ttlSeconds: null,
      model: agentModel.model,
      ...(agentModel.keyScope ? { keyScope: agentModel.keyScope } : {}),
      ...(agentModel.modelHeaders ? { modelHeaders: agentModel.modelHeaders } : {}),
      thinkingLevel: agentModel.thinkingLevel,
      systemPromptAppend: runtimeSystemPromptAppend(env, context),
      fileTools: false,
      ...(request.subject ? { subject: request.subject } : {}),
      context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId },
    });
    const body = hasHistory ? new Blob([fields.slice(0, -1), ',"initialMessages":', history, "}"]) : fields;
    const response = await fetch(`${runtimeUrl(env)}/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body,
      signal: AbortSignal.timeout(RUNTIME_MIGRATION_CREATE_TIMEOUT_MS),
    });
    if (!response.ok) throw await runtimeError("POST", "/v1/agents", response);
    const created = await response.json() as { id?: unknown };
    if (typeof created?.id !== "string") throw new Error("Agent runtime returned no agent id");
    return this.renew(leaseId, { agentId: created.id }) ? created.id : null;
  }

  /**
   * The whole original into the agent's workspace, streamed a bounded batch
   * at a time (pi_core rows as stored, then the pre-compaction render rows,
   * newest first), renewing the lease as it goes.
   */
  private async archive(leaseId: string, agentId: string): Promise<"saved" | "too_large"> {
    const { env } = this.deps;
    const encoder = new TextEncoder();
    // Render rows older than anything stored: the only copy of what a rewrite cut.
    const pages = this.deps.renderArchivePages(this.deps.firstStoredAtMs() ?? Date.now() + 60_000);
    const lines = (function* (payloads: Iterable<string[]>): Generator<string> {
      for (const batch of payloads) yield `${batch.join("\n")}\n`;
      for (const page of pages) {
        if (page.length) yield `${page.map((message) => JSON.stringify({ archivedRenderMessage: message })).join("\n")}\n`;
      }
    })(this.deps.payloadBatches())[Symbol.iterator]();
    const renew = () => this.renew(leaseId);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!renew()) {
          controller.error(new Error("the move's lease ran out"));
          return;
        }
        const next = lines.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
    });
    const url = `${runtimeUrl(env)}/v1/agents/${encodeURIComponent(agentId)}/uploads/${ARCHIVE_REQUEST_ID}/${ARCHIVE_FILE_NAME}`;
    const headers = { Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`, "Content-Type": "application/x-ndjson" };
    const response = await fetch(url, { method: "PUT", headers, body, signal: AbortSignal.timeout(RUNTIME_MIGRATION_ARCHIVE_TIMEOUT_MS) });
    await response.body?.cancel();
    if (response.status === 413) {
      // Over what the runtime keeps in one file: the move goes on without it,
      // and the file the import names says so.
      const note = JSON.stringify({ note: "The original transcript was too large to save here; it stays in camelAI's previous chat engine's storage." });
      const placeholder = await fetch(url, { method: "PUT", headers, body: `${note}\n`, signal: AbortSignal.timeout(RUNTIME_MIGRATION_CALL_TIMEOUT_MS) });
      await placeholder.body?.cancel();
      if (!placeholder.ok) throw await runtimeError("PUT", "/v1/agents/:id/uploads", placeholder);
      if (!this.renew(leaseId)) throw new Error("the move's lease ran out");
      return "too_large";
    }
    if (!response.ok) throw await runtimeError("PUT", "/v1/agents/:id/uploads", response);
    // The upload may have taken most of a lease: the move goes on only while it holds.
    if (!this.renew(leaseId)) throw new Error("the move's lease ran out");
    return "saved";
  }
}
