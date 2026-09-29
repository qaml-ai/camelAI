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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UIMessage } from "ai";
import type { ChatEnv } from "./types.js";
import type { PreviewTarget } from "../../../../src/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import type { PiCoreRevision } from "./pi-core-store.js";
import { RuntimeApiError, provisionedAgentId, runtimeApi, runtimeUrl } from "../agent-runtime/runtime-api.js";
import { runtimeSystemPromptAppend } from "../agent-runtime/run-gates.js";
import {
  ARCHIVE_FILE_NAME,
  ARCHIVE_REQUEST_ID,
  convertTranscript,
  withImportNote,
  type DoMigrationRequest,
  type DoMigrationResult,
} from "../agent-runtime/thread-migration.js";
import { renderArchiveToPiMessages } from "./render-archive-export.js";

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
/** Generations of a provisioning key looked for when deleting what a failed create made. */
const KEY_GENERATIONS = 4;

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
    /** The Idempotency-Key the agent is (being) made under, set before the create. */
    pendingKey?: string;
    agentId?: string;
    /** What an earlier attempt left behind, deleted under this lease before anything is made. */
    orphanAgentId?: string;
    orphanKey?: string;
  })
  | (MoveIdentity & {
    phase: "committing";
    leaseId: string;
    agentId: string;
    previewTabs: PreviewTarget[];
    previewActiveTabId: string | null;
    attempts: number;
    stats?: Extract<DoMigrationResult, { status: "migrated" }>["stats"];
    archived?: boolean;
  })
  | { phase: "moved"; leaseId: string; agentId: string; movedAt: number }
  | (Partial<MoveIdentity> & { phase: "failed"; failures: number; retryAt: number; error: string; orphanAgentId?: string; orphanKey?: string });

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
  loadHistory(maxChars: number): Promise<{ messages: AgentMessage[]; whole: boolean }>;
  /** The render rows a compaction left as the only copy of history below its cut, newest page first. */
  renderArchivePages(): Iterable<UIMessage[]>;
  /** Every stored transcript row as stored, a bounded batch at a time. */
  payloadBatches(): Iterable<string[]>;
  preview(): { tabs: PreviewTarget[]; activeTabId: string | null };
  /** Wake the DO at `at` and call {@link ChatThreadRuntimeMigration.onAlarm}. */
  scheduleAlarm(at: number): void;
  waitUntil(promise: Promise<unknown>): void;
}

interface OrgStub {
  setThreadUiState(threadId: string, preview: Record<string, unknown> | null): Promise<unknown>;
  claimThreadRuntimeAgent(threadId: string, agentId: string): Promise<{ row: ThreadRuntimeRecord; claimed: boolean } | null>;
  getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
}

/** The pause before the next attempt after `failures` failed ones: 1 min, doubling, at most 6 h. */
export function migrationBackoffMs(failures: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
}

const commitRetryMs = (attempts: number) => Math.min(10 * 60_000, 30_000 * 2 ** attempts);

/**
 * A refusal the runtime will give every time for this history (its validator,
 * its size caps, an archive it will not store): tried again only after a day.
 */
function permanentRefusal(error: unknown): string | null {
  if (!(error instanceof RuntimeApiError)) return null;
  if (error.code === "INVALID_HISTORY" || /INVALID_HISTORY/.test(error.message)) return "invalid_history";
  if (error.status === 413 || error.code === "HISTORY_TOO_LARGE") return "too_large";
  if (error.status >= 400 && error.status < 500 && ![401, 403, 404, 408, 409, 429].includes(error.status)) return `refused_${error.status}`;
  return null;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return new RuntimeApiError(`Agent runtime ${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`, response.status, code);
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
  status(now = Date.now()): { state: "moving" | "moved" | "backoff" | null; retryAt?: number } {
    const state = this.state(now);
    if (state) return { state };
    const record = this.read();
    if (record?.phase === "failed" && record.retryAt > now) return { state: "backoff", retryAt: record.retryAt };
    return { state: null };
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
      ...(failed?.orphanKey ? { orphanKey: failed.orphanKey } : {}),
    };
    this.write(lease);
    this.deps.scheduleAlarm(lease.expiresAt + 1_000);

    try {
      if (lease.orphanAgentId || lease.orphanKey) {
        const cleared = await this.deleteLeftovers(lease, lease.orphanAgentId, lease.orphanKey);
        if (!this.lease(leaseId)) return { status: "failed", error: "the move's lease ran out" };
        if (!cleared) {
          this.fail(leaseId, "could not delete an earlier attempt's agent");
          return { status: "failed", error: "could not delete an earlier attempt's agent" };
        }
        this.renew(leaseId, { orphanAgentId: undefined, orphanKey: undefined });
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
      if (archived) await this.archive(leaseId, agentId);

      const prepared = this.prepare(leaseId, agentId, context.orgId, context.threadId);
      if (typeof prepared === "string") {
        this.fail(leaseId, prepared);
        return { status: "busy", reason: prepared };
      }
      return await this.commit({ ...prepared, stats: converted.stats, archived });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = permanentRefusal(error);
      this.fail(leaseId, permanent ? `${permanent}: ${message}` : message, permanent ? PERMANENT_FAILURE_RETRY_MS : undefined);
      return permanent ? { status: "skipped", reason: `${permanent}: ${message}` } : { status: "failed", error: message };
    }
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
   * The history to import: the pi_core export and, when a compaction left
   * render rows as the only copy of what came before its cut, those rebuilt
   * ahead of it. `archived`: the import is not the whole history as stored.
   */
  private async history(): Promise<{ messages: AgentMessage[]; archived: boolean }> {
    const history = await this.deps.loadHistory(RUNTIME_MIGRATION_EXPORT_MAX_CHARS);
    const pages: UIMessage[][] = [];
    let chars = 0;
    let complete = true;
    for (const page of this.deps.renderArchivePages()) {
      const size = page.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
      if (chars + size > RUNTIME_MIGRATION_RENDER_ARCHIVE_MAX_CHARS) {
        complete = false;
        break;
      }
      chars += size;
      pages.push(page);
    }
    const before = renderArchiveToPiMessages(pages.reverse().flat());
    const first = history.messages[0] as { role?: string; content?: unknown } | undefined;
    // A thread whose rows open on a summary lost what came before it from pi_core.
    const cutByRewrite = first?.role === "user" && typeof first.content === "string" && first.content.startsWith("[Context Summary]");
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
  private prepare(leaseId: string, agentId: string, orgId: string, threadId: string): Committing | string {
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
      outcome = await org.claimThreadRuntimeAgent(record.threadId, record.agentId);
    } catch (error) {
      const row = await org.getThreadRuntime(record.threadId).catch(() => undefined);
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
      this.deps.waitUntil(this.deleteLeftovers(record, record.agentId, undefined));
      return { status: "runtime", row: outcome.row };
    }
    return record.stats
      ? { status: "migrated", row: outcome.row, stats: record.stats, archived: record.archived ?? false }
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
    const orphanKey = record.pendingKey ?? record.orphanKey;
    const failed: Failed = {
      phase: "failed",
      failures,
      retryAt: Date.now() + (retryMs ?? migrationBackoffMs(failures)),
      error,
      orgId: record.orgId,
      threadId: record.threadId,
      ...(orphanAgentId ? { orphanAgentId } : {}),
      ...(orphanKey ? { orphanKey } : {}),
    };
    this.write(failed);
    if (orphanAgentId || orphanKey) this.cleanUpFailed(failed);
  }

  /** Delete what a failed move left, in the background, and forget it once gone. */
  private cleanUpFailed(record: Failed): void {
    if (!record.orgId || !record.threadId) return;
    const identity = { orgId: record.orgId, threadId: record.threadId };
    this.deps.waitUntil(this.deleteLeftovers(identity, record.orphanAgentId, record.orphanKey).then((deleted) => {
      const current = this.read();
      if (deleted && current?.phase === "failed" && current.orphanAgentId === record.orphanAgentId && current.orphanKey === record.orphanKey) {
        this.write({ ...current, orphanAgentId: undefined, orphanKey: undefined });
      }
    }));
  }

  /**
   * Delete an agent a move made, and any agent made under its key (a create
   * that timed out, or was cut off, may have made one we never heard of),
   * never the agent the thread's runtime row holds. True when nothing is left.
   */
  private async deleteLeftovers(identity: MoveIdentity, agentId: string | undefined, key: string | undefined): Promise<boolean> {
    let held: string | null;
    try {
      held = (await this.org(identity.orgId).getThreadRuntime(identity.threadId))?.agentId ?? null;
    } catch (error) {
      console.warn("[runtime-migration] could not read the thread's runtime row; nothing deleted", error);
      return false;
    }
    const candidates = new Set<string>(agentId ? [agentId] : []);
    const tenant = this.deps.env.AGENT_RUNTIME_TENANT?.trim();
    if (key && tenant) {
      for (let generation = 0; generation < KEY_GENERATIONS; generation++) {
        candidates.add(await provisionedAgentId(tenant, generation ? `${key}#${generation}` : key));
      }
    }
    let ok = true;
    for (const candidate of candidates) {
      if (candidate === held) {
        console.warn("[runtime-migration] kept an agent the thread's runtime row holds", { agentId: candidate });
        continue;
      }
      ok = (await this.deleteAgent(candidate)) && ok;
    }
    return ok;
  }

  private async deleteAgent(agentId: string): Promise<boolean> {
    try {
      await runtimeApi(this.deps.env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
      return true;
    } catch (error) {
      if (error instanceof RuntimeApiError && (error.status === 404 || error.status === 410)) return true;
      console.warn("[runtime-migration] could not delete the agent of a move that did not happen", error);
      return false;
    }
  }

  /**
   * The agent, made with the history, under the lease; null once the lease
   * is lost. Its Idempotency-Key is the history's hash, recorded in the lease
   * before the call, so a create cut off anywhere can be found and deleted,
   * and a retry with the same history gets the same agent back.
   */
  private async createAgent(leaseId: string, request: DoMigrationRequest, held: { messages: AgentMessage[] }): Promise<string | null> {
    const { env } = this.deps;
    const { context } = request;
    // The history is serialized and encoded once, then only its bytes are
    // kept: hashed, and sent as they are.
    const hasHistory = held.messages.length > 0;
    const history = new TextEncoder().encode(JSON.stringify(held.messages)) as Uint8Array<ArrayBuffer>;
    held.messages = [];
    const key = `migrate_${context.threadId}_${(await sha256Hex(history)).slice(0, 16)}`;
    if (!this.renew(leaseId, { pendingKey: key })) return null;
    const fields = JSON.stringify({
      definition: env.AGENT_RUNTIME_DEFINITION,
      name: context.threadId,
      type: "camelai-thread",
      ttlSeconds: null,
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
  private async archive(leaseId: string, agentId: string): Promise<void> {
    const { env } = this.deps;
    const encoder = new TextEncoder();
    const pages = this.deps.renderArchivePages();
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
    const response = await fetch(
      `${runtimeUrl(env)}/v1/agents/${encodeURIComponent(agentId)}/uploads/${ARCHIVE_REQUEST_ID}/${ARCHIVE_FILE_NAME}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
          "Content-Type": "application/x-ndjson",
        },
        body,
      },
    );
    if (!response.ok) throw await runtimeError("PUT", "/v1/agents/:id/uploads", response);
    await response.body?.cancel();
  }
}
