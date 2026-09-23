import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createCompactionSummaryMessage, type AgentMessage } from "@earendil-works/pi-agent-core";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";

export const transcriptPath = (directory: string) => join(directory, "transcript.jsonl");
export const legacySnapshotPath = (directory: string) => join(directory, "session.json");

/** A compaction: `summary` replaces every message before absolute index `cut`. */
export interface CompactionState {
  summary: string;
  cut: number;
  tokensBefore: number;
  details?: unknown;
  at: number;
}

/** Native Pi messages, appended as each one ends; never re-serialized per delta. */
export type TranscriptRecord =
  | { t: "message"; message: AgentMessage }
  /** Drops the latest message: a provider error that was retried. */
  | { t: "retract" }
  | { t: "turn"; active: boolean }
  /** Replaces all earlier messages (import, or folding the log). */
  | { t: "reset"; messages: AgentMessage[]; compaction?: CompactionState }
  /** The model's context from now on is `summary` plus messages from index `cut`. */
  | ({ t: "compaction" } & CompactionState);

/** Read an agent's full history without its process. Never writes, so it is safe beside a live owner. */
export async function readTranscript(directory: string): Promise<AgentMessage[]> {
  const records = await fileAppendLog<TranscriptRecord>(transcriptPath(directory)).read();
  if (!records.length) {
    try { return (JSON.parse(await readFile(legacySnapshotPath(directory), "utf8")) as { messages: AgentMessage[] }).messages ?? []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  let messages: AgentMessage[] = [];
  for (const record of records) {
    if (record.t === "message") messages.push(record.message);
    else if (record.t === "retract") messages.pop();
    else if (record.t === "reset") messages = [...record.messages];
  }
  return messages;
}

/**
 * The agent's working set: the latest compaction summary plus the messages after
 * its cut. Earlier messages stay in the log (for history) but not in memory, so an
 * agent's memory and load time stop growing with its age.
 */
export class Transcript {
  /** Messages at absolute indexes `offset` .. `total - 1`. */
  context: AgentMessage[] = [];
  /** Messages ever recorded (after retractions); absolute indexes run 0 .. total - 1. */
  total = 0;
  compaction?: CompactionState;
  /** A turn was running when the log was last written. */
  active = false;
  readonly log: AppendLog<TranscriptRecord>;
  constructor(log: AppendLog<TranscriptRecord>) { this.log = log; }

  get offset() { return this.total - this.context.length; }

  /** What the model sees: the summary (as Pi's compaction summary message) and the kept messages. */
  view(): AgentMessage[] {
    if (!this.compaction) return [...this.context];
    return [summaryMessage(this.compaction), ...this.context];
  }

  async load(legacySnapshotPath?: string) {
    const records = await this.log.read();
    if (!records.length && legacySnapshotPath && await this.importLegacy(legacySnapshotPath)) return;
    for (const record of records) this.apply(record);
  }

  /** Version 1 kept the whole transcript in one JSON file, rewritten per message. */
  private async importLegacy(path: string) {
    let snapshot: { version: number; active: boolean; messages: AgentMessage[] };
    try { snapshot = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.messages)) throw new Error("Invalid legacy session snapshot");
    await this.replace(snapshot.messages, snapshot.active);
    await rename(path, `${path}.migrated`);
    return true;
  }

  apply(record: TranscriptRecord) {
    if (record.t === "message") { this.context.push(record.message); this.total++; }
    else if (record.t === "retract") { if (this.context.pop()) this.total--; }
    else if (record.t === "turn") this.active = record.active;
    else if (record.t === "reset") {
      this.total = record.messages.length;
      this.compaction = record.compaction;
      this.context = record.messages.slice(record.compaction?.cut ?? 0);
    } else if (record.t === "compaction") {
      const { t: _type, ...state } = record;
      if (state.cut < this.offset || state.cut > this.total) throw new Error(`Compaction cut ${state.cut} is outside the working set (${this.offset}..${this.total})`);
      this.context = this.context.slice(state.cut - this.offset);
      this.compaction = state;
    } else throw new Error(`Unknown transcript record: ${(record as { t: string }).t}`);
  }

  private async write(record: TranscriptRecord) {
    this.log.append(record);
    this.apply(record);
    await this.log.flush(true);
  }

  push(message: AgentMessage) { return this.write({ t: "message", message }); }
  retract() { return this.write({ t: "retract" }); }
  setActive(active: boolean) { return this.write({ t: "turn", active }); }
  compact(state: CompactionState) { return this.write({ t: "compaction", ...state }); }

  async append(messages: AgentMessage[]) {
    for (const message of messages) { this.log.append({ t: "message", message }); this.apply({ t: "message", message }); }
    await this.log.flush(true);
  }

  /** Atomically replace the history (imports), folding the log to a single snapshot record. */
  async replace(messages: AgentMessage[], active = this.active) {
    this.apply({ t: "reset", messages });
    this.active = active;
    await this.log.rewrite(() => [{ t: "reset", messages: [...messages] }, ...(this.active ? [{ t: "turn" as const, active: true }] : [])]);
  }
}

export function summaryMessage(state: CompactionState): AgentMessage {
  return createCompactionSummaryMessage(state.summary, state.tokensBefore, new Date(state.at).toISOString()) as AgentMessage;
}
