import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";

export const transcriptPath = (directory: string) => join(directory, "transcript.jsonl");
export const legacySnapshotPath = (directory: string) => join(directory, "session.json");

/** Read an agent's history without its process. Never writes, so it is safe beside a live owner. */
export async function readTranscript(directory: string): Promise<AgentMessage[]> {
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(transcriptPath(directory)));
  const records = await transcript.log.read();
  if (!records.length) {
    try { return (JSON.parse(await readFile(legacySnapshotPath(directory), "utf8")) as { messages: AgentMessage[] }).messages ?? []; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  for (const record of records) transcript.apply(record);
  return transcript.messages;
}

/** Native Pi messages, appended as each one ends; never re-serialized per delta. */
export type TranscriptRecord =
  | { t: "message"; message: AgentMessage }
  /** Drops the latest message: a provider error that was retried. */
  | { t: "retract" }
  | { t: "turn"; active: boolean }
  /** Replaces all earlier messages (import, recovery, or folding the log). */
  | { t: "reset"; messages: AgentMessage[] };

export class Transcript {
  messages: AgentMessage[] = [];
  /** A turn was running when the log was last written. */
  active = false;
  readonly log: AppendLog<TranscriptRecord>;
  constructor(log: AppendLog<TranscriptRecord>) { this.log = log; }

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
    if (record.t === "message") this.messages.push(record.message);
    else if (record.t === "retract") this.messages.pop();
    else if (record.t === "turn") this.active = record.active;
    else if (record.t === "reset") this.messages = [...record.messages];
    else throw new Error(`Unknown transcript record: ${(record as { t: string }).t}`);
  }

  private async write(record: TranscriptRecord) {
    this.log.append(record);
    this.apply(record);
    await this.log.flush(true);
  }

  push(message: AgentMessage) { return this.write({ t: "message", message }); }
  retract() { return this.write({ t: "retract" }); }
  setActive(active: boolean) { return this.write({ t: "turn", active }); }

  /** Atomically replace the history, folding the log to a single snapshot record. */
  async replace(messages: AgentMessage[], active = this.active) {
    this.messages = [...messages];
    this.active = active;
    await this.log.rewrite(() => [{ t: "reset", messages: this.messages }, ...(this.active ? [{ t: "turn" as const, active: true }] : [])]);
  }
}
