/**
 * ChatThreadDO's side of moving its thread to the agent runtime
 * (agent-runtime/thread-migration.ts has the worker's side and the import
 * format). The DO drives the move, one state at a time, each kept in its KV:
 *
 *   leased      the history is exported and the agent made, under a lease;
 *               no new turns. Expiry (the alarm) undoes it: the agent is
 *               deleted and the thread carries on here.
 *   committing  checked against the thread (no turn running, no transcript
 *               change since the lease began); no turns, and no expiry: the
 *               thread_runtime row is written compare-and-set (OrgDO keeps
 *               the first agent a thread is given), then the move is final.
 *               A commit that failed is re-driven by the alarm or the next
 *               call, however far it got.
 *   moved       the thread runs on the runtime; this DO refuses turns.
 *   failed      a move that did not happen, with a backoff before the next
 *               attempt (and the agent it made, until that is deleted).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatEnv } from "./types.js";
import type { PreviewTarget } from "../../../../src/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import type { PiCoreRevision } from "./pi-core-store.js";
import { RuntimeApiError, runtimeApi, runtimeUrl } from "../agent-runtime/runtime-api.js";
import { runtimeSystemPromptAppend } from "../agent-runtime/run-gates.js";
import {
  ARCHIVE_FILE_NAME,
  ARCHIVE_REQUEST_ID,
  convertTranscript,
  withImportNote,
  type DoMigrationRequest,
  type DoMigrationResult,
} from "../agent-runtime/thread-migration.js";

export const RUNTIME_MIGRATION_KEY = "runtimeMigration";
/** How long a begun move holds the thread before the alarm undoes it. */
export const RUNTIME_MIGRATION_LEASE_MS = 2 * 60_000;
/** The history a move may hold at once; over it, only the model's window moves (and the whole is archived). */
export const RUNTIME_MIGRATION_EXPORT_MAX_CHARS = 12_000_000;
/** How long a thread whose history cannot fit the runtime waits before it is tried again. */
const TOO_LARGE_RETRY_MS = 24 * 60 * 60_000;

export type RuntimeMigrationRecord =
  | { phase: "leased"; leaseId: string; startedAt: number; expiresAt: number; revision: PiCoreRevision; failures: number; agentId?: string }
  | {
    phase: "committing";
    leaseId: string;
    agentId: string;
    orgId: string;
    threadId: string;
    previewTabs: PreviewTarget[];
    previewActiveTabId: string | null;
    attempts: number;
    stats?: Extract<DoMigrationResult, { status: "migrated" }>["stats"];
    archived?: boolean;
  }
  | { phase: "moved"; leaseId: string; agentId: string; movedAt: number }
  | { phase: "failed"; failures: number; retryAt: number; error: string; orphanAgentId?: string };

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
  /** Every stored transcript row as stored, a batch at a time. */
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

  /** Whether turns are refused here: while a move holds the thread, and for good once it moved. */
  state(now = Date.now()): "moving" | "moved" | null {
    const record = this.read();
    if (!record) return null;
    if (record.phase === "moved") return "moved";
    if (record.phase === "committing") return "moving";
    if (record.phase === "leased" && record.expiresAt > now) return "moving";
    return null;
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
    if (!request.dryRun && record?.phase === "failed" && record.retryAt > now) {
      return { status: "skipped", reason: `backoff: ${record.error}` };
    }
    const busy = this.deps.busyReason();
    if (busy) return { status: "busy", reason: busy };
    if (this.deps.hasRelayAgent()) return { status: "relay" };

    if (request.dryRun) {
      const history = await this.deps.loadHistory(RUNTIME_MIGRATION_EXPORT_MAX_CHARS);
      const converted = convertTranscript(history.messages);
      if (converted.tooLarge) return { status: "skipped", reason: "too_large" };
      const archived = converted.lossy || !history.whole;
      return {
        status: "dry_run",
        stats: converted.stats,
        lossy: archived,
        bytes: new TextEncoder().encode(JSON.stringify(withImportNote(converted.messages, archived))).length,
      };
    }

    // The agent an earlier attempt left behind goes first.
    if (record?.phase === "failed" && record.orphanAgentId) {
      if (!await this.deleteAgent(record.orphanAgentId)) return { status: "failed", error: "could not delete an earlier attempt's agent" };
      this.write({ ...record, orphanAgentId: undefined });
    }
    const leaseId = crypto.randomUUID();
    const lease: RuntimeMigrationRecord = {
      phase: "leased",
      leaseId,
      startedAt: now,
      expiresAt: now + RUNTIME_MIGRATION_LEASE_MS,
      revision: this.deps.revision(),
      failures: record?.phase === "failed" ? record.failures : 0,
    };
    this.write(lease);
    this.deps.scheduleAlarm(lease.expiresAt + 1_000);

    try {
      const history = await this.deps.loadHistory(RUNTIME_MIGRATION_EXPORT_MAX_CHARS);
      const converted = convertTranscript(history.messages);
      if (converted.tooLarge) {
        this.fail(leaseId, "too_large", TOO_LARGE_RETRY_MS);
        return { status: "skipped", reason: "too_large" };
      }
      const archived = converted.lossy || !history.whole;
      const initialMessages = withImportNote(converted.messages, archived);
      const agentId = await this.createAgent(request, initialMessages);
      if (!this.recordAgent(leaseId, agentId)) {
        // The lease ran out and the alarm undid the move meanwhile; a later
        // attempt with the same history gets this agent back (same key).
        return { status: "failed", error: "the move's lease ran out" };
      }
      if (archived) await this.archive(agentId);

      const prepared = this.prepare(leaseId, agentId, context.orgId, context.threadId);
      if (typeof prepared === "string") {
        this.fail(leaseId, prepared);
        return { status: "busy", reason: prepared };
      }
      return await this.commit({ ...prepared, stats: converted.stats, archived });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(leaseId, message);
      return { status: "failed", error: message };
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
    } else if (record.phase === "failed" && record.orphanAgentId) {
      this.deleteOrphan(record.orphanAgentId);
    }
  }

  private recordAgent(leaseId: string, agentId: string): boolean {
    const record = this.read();
    if (record?.phase !== "leased" || record.leaseId !== leaseId) return false;
    this.write({ ...record, agentId });
    return true;
  }

  /**
   * Check the move against the thread, synchronously, and hold it for the
   * commit: the lease is still ours and live, no turn runs, and the
   * transcript is the one exported. Returns why not otherwise.
   */
  private prepare(leaseId: string, agentId: string, orgId: string, threadId: string): Extract<RuntimeMigrationRecord, { phase: "committing" }> | string {
    const record = this.read();
    if (record?.phase !== "leased" || record.leaseId !== leaseId) return "the move's lease ran out";
    if (record.expiresAt <= Date.now()) return "the move's lease ran out";
    const busy = this.deps.busyReason();
    if (busy) return busy;
    const revision = this.deps.revision();
    if (revision.generation !== record.revision.generation || revision.count !== record.revision.count) {
      return "the thread changed while it was moving";
    }
    const { tabs, activeTabId } = this.deps.preview();
    const committing = {
      phase: "committing" as const,
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

  /**
   * Write the thread's preview tabs and its runtime row, then finish. Safe to
   * re-drive from any point: both writes are idempotent, and the row is only
   * ever claimed for one agent. A write that failed ambiguously is settled by
   * reading the row back; one that cannot be settled is retried by the alarm,
   * the thread still held.
   */
  private async commit(record: Extract<RuntimeMigrationRecord, { phase: "committing" }>): Promise<DoMigrationResult> {
    const org = this.deps.env.ORG.get(this.deps.env.ORG.idFromName(record.orgId)) as unknown as OrgStub;
    let outcome: { row: ThreadRuntimeRecord; claimed: boolean } | null;
    try {
      if (record.previewTabs.length) {
        await org.setThreadUiState(record.threadId, { tabs: record.previewTabs, activeTabId: record.previewActiveTabId });
      }
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
      this.write({ phase: "failed", failures: 1, retryAt: Number.MAX_SAFE_INTEGER, error: "thread deleted", orphanAgentId: record.agentId });
      this.deleteOrphan(record.agentId);
      return { status: "skipped", reason: "thread deleted" };
    }
    this.write({ phase: "moved", leaseId: record.leaseId, agentId: outcome.row.agentId ?? record.agentId, movedAt: Date.now() });
    if (!outcome.claimed) {
      // It was already on the runtime (another path gave it an agent first): ours is spare.
      this.deps.waitUntil(this.deleteAgent(record.agentId));
      return { status: "runtime", row: outcome.row };
    }
    return record.stats
      ? { status: "migrated", row: outcome.row, stats: record.stats, archived: record.archived ?? false }
      : { status: "runtime", row: outcome.row };
  }

  /**
   * Undo the move under `leaseId`, if it still holds the thread: the thread
   * runs here again after a backoff, and the agent it made is deleted.
   */
  private fail(leaseId: string, error: string, retryMs?: number): void {
    const record = this.read();
    if (record?.phase !== "leased" || record.leaseId !== leaseId) return;
    const failures = record.failures + 1;
    this.write({
      phase: "failed",
      failures,
      retryAt: Date.now() + (retryMs ?? migrationBackoffMs(failures)),
      error,
      ...(record.agentId ? { orphanAgentId: record.agentId } : {}),
    });
    if (record.agentId) this.deleteOrphan(record.agentId);
  }

  private deleteOrphan(agentId: string): void {
    this.deps.waitUntil(this.deleteAgent(agentId).then((deleted) => {
      const record = this.read();
      if (deleted && record?.phase === "failed" && record.orphanAgentId === agentId) {
        this.write({ ...record, orphanAgentId: undefined });
      }
    }));
  }

  private async deleteAgent(agentId: string): Promise<boolean> {
    try {
      await runtimeApi(this.deps.env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`);
      return true;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return true;
      console.warn("[runtime-migration] could not delete the agent of a move that did not happen", error);
      return false;
    }
  }

  /**
   * The agent, made with the history. Its Idempotency-Key is the history's
   * hash: a retry with the same history gets the same agent back (or a fresh
   * one once that was deleted), never a second one.
   */
  private async createAgent(request: DoMigrationRequest, initialMessages: AgentMessage[]): Promise<string> {
    const { env } = this.deps;
    const { context } = request;
    const history = JSON.stringify(initialMessages);
    const key = `migrate_${context.threadId}_${(await sha256Hex(history)).slice(0, 16)}`;
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
    // The history is serialized once: hashed, then spliced into the body.
    const body = initialMessages.length ? `${fields.slice(0, -1)},"initialMessages":${history}}` : fields;
    const response = await fetch(`${runtimeUrl(env)}/v1/agents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new RuntimeApiError(`Agent runtime POST /v1/agents: HTTP ${response.status} ${text.slice(0, 500)}`, response.status);
    const created = JSON.parse(text) as { id?: unknown };
    if (typeof created?.id !== "string") throw new Error("Agent runtime returned no agent id");
    return created.id;
  }

  /** The whole original transcript into the agent's workspace, streamed a batch of rows at a time. */
  private async archive(agentId: string): Promise<void> {
    const { env } = this.deps;
    const encoder = new TextEncoder();
    const batches = this.deps.payloadBatches()[Symbol.iterator]();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = batches.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(`${next.value.join("\n")}\n`));
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
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Could not save the original transcript: HTTP ${response.status}`);
  }
}
