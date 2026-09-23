import { randomUUID } from "node:crypto";
import { PreconditionFailed, type Storage } from "../shared/storage.ts";

/**
 * Durable timers that wake agents with a prompt, on any node:
 *
 *   schedules/<agent>/<id>          the schedule (text, next due time, repeat interval)
 *   timers/<minute>/<agent>.<id>    one entry per pending wake-up, grouped by due minute
 *   timer-claims/<agent>.<id>.<due> which node is delivering a due wake-up
 *
 * Every node scans for due timers; a conditional create of the claim lets exactly
 * one deliver it. Delivery submits a prompt whose request id is derived from the
 * schedule and due time, so a repeated delivery (after a crash) is a no-op.
 */
/** A wake-up either prompts the agent (`text`) or runs sandboxed code with its tools (`code`). */
export interface Schedule {
  id: string; agent: string; tenant: string; text?: string; code?: string;
  dueAt: number; everySeconds?: number; createdAt: number;
}
export type Deliver = (schedule: Schedule, requestId: string) => Promise<void>;

const minuteOf = (time: number) => new Date(time).toISOString().slice(0, 16).replace(/[-:T]/g, "");
/** A claim older than this is assumed abandoned by a crashed node and may be retaken. */
const CLAIM_TIMEOUT_MS = 60_000;
export const MIN_REPEAT_SECONDS = 60;

export class Scheduler {
  readonly storage: Storage;
  readonly node: string;
  private readonly deliver: Deliver;
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;

  constructor(options: { storage: Storage; node: string; deliver: Deliver }) {
    this.storage = options.storage;
    this.node = options.node;
    this.deliver = options.deliver;
  }

  start(intervalMs = 5_000) {
    this.timer ??= setInterval(() => void this.scan().catch(error => console.error(JSON.stringify({ type: "scheduler_scan_failed", error: String(error) }))), intervalMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async create(input: { agent: string; tenant: string; text?: string; code?: string; dueAt: number; everySeconds?: number }): Promise<Schedule> {
    const content = input.text ?? input.code;
    if ((input.text === undefined) === (input.code === undefined) || typeof content !== "string" || !content.trim() || content.length > 32_000) throw new Error("Give exactly one of text or code (1–32000 characters)");
    if (!Number.isFinite(input.dueAt)) throw new Error("A schedule needs a due time");
    if (input.everySeconds !== undefined && (!Number.isInteger(input.everySeconds) || input.everySeconds < MIN_REPEAT_SECONDS)) throw new Error(`everySeconds must be an integer of at least ${MIN_REPEAT_SECONDS}`);
    const existing = await this.list(input.agent);
    if (existing.length >= 100) throw new Error("An agent can have at most 100 schedules");
    const schedule: Schedule = { id: randomUUID(), ...input, createdAt: Date.now() };
    await this.storage.writeJson(`schedules/${schedule.agent}/${schedule.id}`, schedule, null);
    await this.storage.writeJson(this.timerKey(schedule), { agent: schedule.agent, id: schedule.id, dueAt: schedule.dueAt });
    return schedule;
  }

  async list(agent: string): Promise<Schedule[]> {
    const keys = await this.storage.listJson(`schedules/${agent}/`);
    const schedules = await Promise.all(keys.map(key => this.storage.readJson<Schedule>(key)));
    return schedules.flatMap(entry => entry ? [entry.value] : []).sort((a, b) => a.dueAt - b.dueAt);
  }

  async remove(agent: string, id: string) {
    const stored = await this.storage.readJson<Schedule>(`schedules/${agent}/${id}`);
    if (!stored) return false;
    await this.storage.deleteJson(this.timerKey(stored.value));
    await this.storage.deleteJson(`schedules/${agent}/${id}`);
    return true;
  }

  private timerKey(schedule: Pick<Schedule, "agent" | "id" | "dueAt">) { return `timers/${minuteOf(schedule.dueAt)}/${schedule.agent}.${schedule.id}`; }

  /** Deliver every due wake-up this node wins the claim for. */
  async scan(now = Date.now()) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const current = minuteOf(now);
      for (const key of await this.storage.listJson("timers/")) {
        if (key.split("/")[1] > current) continue;
        const entry = await this.storage.readJson<{ agent: string; id: string; dueAt: number }>(key);
        if (!entry || entry.value.dueAt > now) continue;
        if (await this.claim(entry.value)) await this.fire(key, entry.value);
      }
    } finally { this.scanning = false; }
  }

  private async claim(timer: { agent: string; id: string; dueAt: number }) {
    const key = `timer-claims/${timer.agent}.${timer.id}.${timer.dueAt}`;
    try { await this.storage.writeJson(key, { node: this.node, at: Date.now() }, null); return true; }
    catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      const claim = await this.storage.readJson<{ node: string; at: number }>(key);
      if (!claim || Date.now() - claim.value.at < CLAIM_TIMEOUT_MS) return false;
      try { await this.storage.writeJson(key, { node: this.node, at: Date.now() }, claim.version); return true; }
      catch (retake) { if (retake instanceof PreconditionFailed) return false; throw retake; }
    }
  }

  private async fire(key: string, timer: { agent: string; id: string; dueAt: number }) {
    const stored = await this.storage.readJson<Schedule>(`schedules/${timer.agent}/${timer.id}`);
    let gone = false;
    if (stored && stored.value.dueAt === timer.dueAt) {
      try { await this.deliver(stored.value, `schedule-${timer.id}-${timer.dueAt}`); }
      catch (error) {
        // The agent was deleted or expired: drop its schedule. Anything else retries after the claim times out.
        const status = (error as { status?: number }).status;
        if (status !== 404 && status !== 410) throw error;
        gone = true;
      }
    }
    if (stored && stored.value.dueAt === timer.dueAt && !gone) {
      if (stored.value.everySeconds) {
        // Next occurrence after now, skipping any missed while nothing was running.
        const step = stored.value.everySeconds * 1000;
        const next = { ...stored.value, dueAt: timer.dueAt + Math.max(1, Math.ceil((Date.now() - timer.dueAt + 1) / step)) * step };
        await this.storage.writeJson(`schedules/${timer.agent}/${timer.id}`, next, stored.version);
        await this.storage.writeJson(this.timerKey(next), { agent: next.agent, id: next.id, dueAt: next.dueAt });
      } else {
        await this.storage.deleteJson(`schedules/${timer.agent}/${timer.id}`);
      }
    } else if (gone) await this.storage.deleteJson(`schedules/${timer.agent}/${timer.id}`);
    await this.storage.deleteJson(key);
    await this.storage.deleteJson(`timer-claims/${timer.agent}.${timer.id}.${timer.dueAt}`);
  }
}

/** Parse `{ text | code, at? (ISO time or ms), inSeconds?, everySeconds? }` into a due time. */
export function scheduleInput(body: any, now = Date.now()) {
  if (!body || typeof body !== "object") throw new Error("Send { text | code, at | inSeconds, everySeconds? }");
  const at = body.at === undefined ? undefined : typeof body.at === "number" ? body.at : Date.parse(body.at);
  const dueAt = at ?? (body.inSeconds !== undefined ? now + Number(body.inSeconds) * 1000 : body.everySeconds !== undefined ? now + Number(body.everySeconds) * 1000 : NaN);
  if (!Number.isFinite(dueAt)) throw new Error("Give a due time: at (ISO time) or inSeconds");
  if (dueAt > now + 366 * 86_400_000) throw new Error("Schedules can be at most a year ahead");
  return { ...(body.text !== undefined ? { text: body.text } : {}), ...(body.code !== undefined ? { code: body.code } : {}), dueAt: Math.max(dueAt, now), ...(body.everySeconds !== undefined ? { everySeconds: Number(body.everySeconds) } : {}) };
}
