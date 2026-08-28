import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";
import { BoundedTurnError } from "./bounded-turn-runner";
import { DurableChatTurnStore, type DurableChatTurn, type StoreResult } from "./durable-turn-store";
import type { AutomationRunReport } from "./automation-turn-report";
import type { LegacyMigrationScope, LegacySessionMigrator } from "./legacy-session-migration";
import type { CheckpointProviderBatch, CheckpointToolResult } from "./turn-checkpoint";
import type { ChatRuntimeContentBlock } from "./chat-runtime-content";
import type { ChatRuntimeLiveUpdate } from "./chat-runtime-controller";
import { boundedErrorText } from "./bounded-error-text";

export interface DurableTurnRunContext {
  turn: DurableChatTurn;
  signal: AbortSignal;
  deadlineAt: number;
  startNextInference(): Promise<void>;
  checkpointProviderBatch(batch: CheckpointProviderBatch): Promise<void>;
  checkpointProviderFinal(output: string): Promise<void>;
  beginEffect(callId: string): Promise<void>;
  recordToolResult(result: CheckpointToolResult): Promise<void>;
  publishLive(content: readonly ChatRuntimeContentBlock[]): void;
}

export interface DurableTurnDriverOptions {
  ctx: DurableObjectState;
  store: DurableChatTurnStore;
  migrator: LegacySessionMigrator;
  run(context: DurableTurnRunContext): Promise<string>;
  publish(): void | Promise<void>;
  publishLive?(update: ChatRuntimeLiveUpdate): void;
  clearLive?(turnId?: string, epoch?: string): void;
  reportAutomation?(report: AutomationRunReport, signal: AbortSignal): Promise<boolean>;
  now?: () => number;
  token?: () => string;
}

class TurnDeadlineError extends Error {
  constructor() {
    super("Turn execution deadline expired");
    this.name = "TurnDeadlineError";
  }
}

function withDeadline<T>(
  task: Promise<T>,
  signal: AbortController,
  deadlineAt: number,
  now: () => number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        signal.abort(new TurnDeadlineError());
        reject(new TurnDeadlineError());
      },
      Math.max(0, deadlineAt - now()),
    );
  });
  // Observe a result that arrives after authority was fenced in storage.
  task.catch(() => undefined);
  return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The only durable turn driver. One alarm invocation may claim at most one
 * queued turn; a cold isolate fences and interrupts an attempt it does not own.
 */
export class DurableTurnDriver {
  private readonly now: () => number;
  private readonly token: () => string;
  private ownedAttemptToken: string | null = null;
  private currentAbort: AbortController | null = null;
  private alarmRun: Promise<void> | null = null;

  constructor(private readonly options: DurableTurnDriverOptions) {
    if (CHAT_RUNTIME_BOUNDS.alarmTurnsPerInvocation !== 1) {
      throw new Error("DurableTurnDriver requires one turn per alarm");
    }
    this.now = options.now ?? Date.now;
    this.token = options.token ?? (() => crypto.randomUUID());
  }

  /** An accelerator only: accepted work is owned by the durable alarm. */
  async kick(scope?: LegacyMigrationScope): Promise<void> {
    const now = this.now();
    await this.setAlarm(now);
    if (scope) this.options.migrator.requestAfterOpen(scope, now);
  }

  alarm(): Promise<void> {
    if (this.alarmRun) return this.alarmRun;
    const run = this.runAlarm().finally(() => {
      if (this.alarmRun === run) this.alarmRun = null;
    });
    this.alarmRun = run;
    return run;
  }

  async stop(): Promise<boolean> {
    this.currentAbort?.abort(new Error("Stopped by user"));
    this.options.clearLive?.();
    const result = this.options.store.reconcileCrashedTurn(this.now(), null);
    if (!result.ok) return false;
    this.ownedAttemptToken = null;
    this.publish();
    try {
      await this.armNext(result);
      return true;
    } finally {
      // An adapter may ignore AbortSignal after dispatching an RPC. Once stop
      // is durable, evict the local attempt instead of trusting cooperation.
      this.options.ctx.abort("Stopped chat turn may still own local work");
    }
  }

  private async runAlarm(): Promise<void> {
    const now = this.now();
    const expired = this.options.store.expire(now);
    if (expired.ok) {
      this.ownedAttemptToken = null;
      this.publish();
      await this.armNext(expired);
      return;
    }
    if (await this.reportAutomation(now)) return;
    let active: DurableChatTurn | null;
    try {
      active = this.options.store.activeTurn();
    } catch {
      const invalid = this.options.store.reconcileCrashedTurn(now, null);
      if (invalid.ok) this.publish();
      await this.armNext();
      return;
    }
    if (active) {
      if (active.attemptToken === this.ownedAttemptToken) {
        await this.setRecoveryAlarm(active, now);
        return;
      }
      const freshToken = this.token();
      await this.setAlarm(now);
      const recovered = this.options.store.recoverFromCheckpoint(
        now,
        freshToken,
      );
      if (!recovered.ok || recovered.turn.status !== "running") {
        this.ownedAttemptToken = null;
        if (recovered.ok) this.publish();
        await this.armNext();
        return;
      }
      await this.execute(recovered.turn, freshToken);
      return;
    }

    const storeAlarmAt = this.options.store.nextAlarmAt(now);
    const migrationAlarmAt = this.options.migrator.nextAlarmAt(now);
    if (storeAlarmAt === null && migrationAlarmAt === null) {
      await this.deleteAlarm();
      return;
    }

    // Migration is alarm-owned and starts only after admission or an open request. Its
    // marker is the claim fence: neither a constructor nor an SSE attach reads
    // legacy rows, and a queued turn cannot start while migration is pending.
    await this.setAlarm(now);
    const migration = await this.options.migrator.runAfterTrigger(
      now,
      this.token(),
    );
    if (migration.changed) this.publish();
    if (migration.state === "pending") {
      await this.setAlarm(
        this.options.migrator.nextAlarmAt(this.now()) ??
          Math.min(
            migration.deadlineAt ??
              this.now() + CHAT_RUNTIME_BOUNDS.legacyMigrationRetryMs,
            this.now() + CHAT_RUNTIME_BOUNDS.legacyMigrationRetryMs,
          ),
      );
      return;
    }
    if (this.options.store.nextAlarmAt(this.now()) === null) {
      await this.deleteAlarm();
      return;
    }

    const token = this.token();
    // Leave an immediate wake durable before the attempt gains authority. If
    // this isolate dies between claim and the exact-lease write, the next one
    // fences the claimed token instead of waiting past the turn's total bound.
    await this.setAlarm(now);
    const claimed = this.options.store.claim(now, token);
    if (!claimed.ok) {
      await this.armNext();
      return;
    }
    await this.execute(claimed.turn, token);
  }

  private async execute(turn: DurableChatTurn, token: string): Promise<void> {
    const deadlineAt =
      turn.leaseExpiresAt ??
      Math.min(
        this.now() + CHAT_RUNTIME_BOUNDS.turnLeaseMs,
        turn.terminalDeadlineAt,
      );
    await this.setRecoveryAlarm(turn, this.now());
    this.ownedAttemptToken = token;
    this.publish();

    const abort = new AbortController();
    const liveEpoch = crypto.randomUUID();
    this.currentAbort = abort;
    let terminal: StoreResult;
    let abortInstance = false;
    try {
      const output = await withDeadline(
        Promise.resolve().then(() =>
          this.options.run({
            turn,
            signal: abort.signal,
            deadlineAt,
            startNextInference: () =>
              this.runningCheckpoint(
                this.options.store.startNextInference(
                  turn.id,
                  token,
                  this.now(),
                ),
              ),
            checkpointProviderBatch: (batch) =>
              this.runningCheckpoint(
                this.options.store.checkpointProviderBatch(
                  turn.id,
                  token,
                  batch,
                  this.now(),
                ),
              ),
            checkpointProviderFinal: (output) =>
              this.runningCheckpoint(
                this.options.store.checkpointProviderFinal(
                  turn.id,
                  token,
                  output,
                  this.now(),
                ),
              ),
            beginEffect: (callId) =>
              this.runningCheckpoint(
                this.options.store.markEffectStarted(
                  turn.id,
                  token,
                  callId,
                  this.now(),
                ),
              ),
            recordToolResult: (result) =>
              this.runningCheckpoint(
                this.options.store.recordToolResult(
                  turn.id,
                  token,
                  result,
                  this.now(),
                ),
              ),
            publishLive: (content) => {
              if (
                abort.signal.aborted ||
                this.currentAbort !== abort ||
                this.ownedAttemptToken !== token
              ) {
                return;
              }
              try {
                this.options.publishLive?.({
                  turnId: turn.id,
                  epoch: liveEpoch,
                  activeTurn: { id: turn.id, status: "running", acceptedAt: turn.createdAt, startedAt: turn.updatedAt },
                  message: {
                    id: `${turn.id}:assistant`,
                    role: "assistant",
                    content: [...content],
                    createdAt: this.now(),
                    status: "running",
                  },
                });
              } catch (error) {
                console.error("[DurableTurnDriver] live publish failed", error);
              }
            },
          }),
        ),
        abort,
        deadlineAt,
        this.now,
      );
      // Keep the next alarm durable across the terminal commit.
      await this.setAlarm(this.now());
      terminal = this.options.store.complete(
        turn.id,
        token,
        boundedErrorText(output),
        this.now(),
      );
    } catch (error) {
      abortInstance =
        error instanceof TurnDeadlineError ||
        (error instanceof BoundedTurnError &&
          (error.code === "tool_timeout" || error.code === "provider_timeout"));
      await this.setAlarm(this.now());
      terminal =
        error instanceof TurnDeadlineError
          ? this.options.store.expire(deadlineAt)
          : this.options.store.fail(
              turn.id,
              token,
              boundedErrorText(error),
              this.now(),
            );
    } finally {
      this.options.clearLive?.(turn.id, liveEpoch);
      if (this.currentAbort === abort) this.currentAbort = null;
      if (this.ownedAttemptToken === token) this.ownedAttemptToken = null;
    }
    this.publish();
    try {
      await this.armNext(terminal);
    } finally {
      if (abortInstance) {
        // CodeModeToolsBinding cannot cancel every RPC it has already started.
        // Terminal state is durable and an immediate alarm was prearmed before
        // this path, so eviction remains mandatory even if alarm cleanup fails.
        this.options.ctx.abort(
          "Uncancellable chat operation exceeded its deadline",
        );
      }
    }
  }

  private async runningCheckpoint(result: StoreResult): Promise<void> {
    if (!result.ok || result.turn.status !== "running") {
      throw new Error("Turn authority expired");
    }
    this.publish();
  }

  private setRecoveryAlarm(turn: DurableChatTurn, now: number): Promise<void> {
    const deadline = turn.leaseExpiresAt ?? turn.terminalDeadlineAt;
    return this.setAlarm(
      Math.min(deadline, now + CHAT_RUNTIME_BOUNDS.recoveryWakeMs),
    );
  }

  private publish(): void {
    this.options.ctx.waitUntil(
      Promise.resolve(this.options.publish()).catch((error) =>
        console.error("[DurableTurnDriver] publish failed", error),
      ),
    );
  }

  private async reportAutomation(now: number): Promise<boolean> {
    const report = this.options.store.claimAutomationReport(now);
    if (!report) return false;
    const abort = new AbortController();
    try {
      const sent = await withDeadline(
        Promise.resolve().then(() => this.options.reportAutomation?.(report, abort.signal) ?? false),
        abort,
        Math.min(report.deadlineAt, now + CHAT_RUNTIME_BOUNDS.automationReportAttemptMs),
        this.now,
      );
      if (sent) this.options.store.completeAutomationReport(report.turnId, report.attempt);
    } catch (error) {
      console.error("[DurableTurnDriver] automation report failed", error);
    }
    await this.armNext();
    return true;
  }

  private async armNext(_result?: StoreResult): Promise<void> {
    const now = this.now();
    const storeAt = this.options.store.nextAlarmAt(now);
    const migrationAt = this.options.migrator.nextAlarmAt(now);
    const at =
      storeAt === null
        ? migrationAt
        : migrationAt === null
          ? storeAt
          : Math.min(storeAt, migrationAt);
    if (at === null) await this.deleteAlarm();
    else await this.setAlarm(at);
  }

  private async deleteAlarm(): Promise<void> {
    await this.alarmStorageCall(
      this.options.ctx.storage.deleteAlarm(),
      "Alarm delete timed out",
    );
  }

  private async setAlarm(at: number): Promise<void> {
    await this.alarmStorageCall(
      this.options.ctx.storage.setAlarm(at),
      "Alarm write timed out",
    );
  }

  private async alarmStorageCall(
    task: Promise<void>,
    message: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(message)),
          CHAT_RUNTIME_BOUNDS.alarmWriteMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
}
