import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, unlink } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join, relative, sep } from "node:path";
import { fileAppendLog, type AppendLog } from "./append-log.ts";
import { writeDurableJson } from "./durable-json.ts";

/**
 * Where the runtime keeps durable state: JSON documents with optimistic
 * concurrency, and append-only logs. Keys are slash-separated paths without
 * extensions, e.g. "client-sessions/client_ab12" or "sessions/client_ab12/transcript".
 *
 * - `fileStorage` keeps the single-host layout (`<key>.json`, `<key>.jsonl`).
 * - `s3Storage` makes state independent of any host: a log is a series of
 *   segment objects created with If-None-Match, so two writers can never both
 *   append the same segment; the loser is fenced out.
 */
export interface Storage {
  readJson<T>(key: string): Promise<{ value: T; version: string } | undefined>;
  /**
   * Write a document. `expected` makes it conditional: a version from `readJson`
   * (must be unchanged) or `null` (must not exist). A failed condition throws
   * `PreconditionFailed`.
   */
  writeJson(key: string, value: unknown, expected?: string | null): Promise<string>;
  deleteJson(key: string): Promise<void>;
  /** Document keys starting with `prefix`. */
  listJson(prefix: string): Promise<string[]>;
  log<T>(key: string): AppendLog<T>;
  /** True if a log has any records (without reading it). */
  hasLog(key: string): Promise<boolean>;
}

export class PreconditionFailed extends Error {
  constructor(key: string) { super(`Conditional write lost for ${key}: another writer changed it`); this.name = "PreconditionFailed"; }
}

const versionOf = (text: string) => createHash("sha256").update(text).digest("hex");
const validKey = (key: string) => {
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(key) || key.split("/").some(part => part === "." || part === "..")) throw new Error(`Invalid storage key: ${key}`);
  return key;
};

/** Serialize conditional writes per key within this process (the file backend has one writer host). */
function keyedMutex() {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, work: () => Promise<T>) => {
    const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => {});
    chains.set(key, settled);
    void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
    return next;
  };
}

/**
 * Files under `root`. By default one process owns the directory (the single-host
 * layout). With `shared`, several processes (or hosts on a shared filesystem) can
 * use it safely: logs become exclusive-create segment files, and conditional
 * document writes hold a lock file.
 */
export function fileStorage(root: string, options: { shared?: boolean } = {}): Storage {
  const inProcess = keyedMutex();
  const lock = options.shared ? <T>(key: string, work: () => Promise<T>) => inProcess(key, () => withLockFile(path(key, ".json.lock"), work)) : inProcess;
  const path = (key: string, extension: string) => join(root, `${validKey(key)}${extension}`);
  const read = async (file: string) => {
    try { return await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  return {
    async readJson(key) {
      const text = await read(path(key, ".json"));
      return text === undefined ? undefined : { value: JSON.parse(text), version: versionOf(text) };
    },
    writeJson(key, value, expected) {
      return lock(key, async () => {
        const file = path(key, ".json");
        if (expected !== undefined) {
          const current = await read(file);
          if (expected === null ? current !== undefined : current === undefined || versionOf(current) !== expected) throw new PreconditionFailed(key);
        }
        const text = JSON.stringify(value);
        writeDurableJson(file, value);
        return versionOf(text);
      });
    },
    async deleteJson(key) { await rm(path(key, ".json"), { force: true }); },
    async listJson(prefix) {
      // Walk only the directory the prefix points into; keys may continue below it.
      const directory = prefix.includes("/") ? validKey(prefix.slice(0, prefix.lastIndexOf("/"))) : "";
      const found: string[] = [];
      const walk = async (directory: string) => {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        for (const entry of entries) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (entry.name.endsWith(".json")) {
            const key = relative(root, full).split(sep).join("/").slice(0, -".json".length);
            if (key.startsWith(prefix)) found.push(key);
          }
        }
      };
      await walk(join(root, directory));
      return found.sort();
    },
    log: key => options.shared ? segmentLog(fileSegments(path(key, ".log")), key) : fileAppendLog(path(key, ".jsonl")),
    async hasLog(key) {
      if (!options.shared) return !!(await read(path(key, ".jsonl")));
      const { segments, snapshots } = await fileSegments(path(key, ".log")).list();
      return segments.length + snapshots.length > 0;
    },
  };
}

async function withLockFile<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  await mkdir(join(lockPath, ".."), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    try { await (await open(lockPath, "wx", 0o600)).close(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 400) throw error;
      await sleep(5);
    }
  }
  try { return await work(); } finally { await unlink(lockPath).catch(() => {}); }
}

function fileSegments(directory: string): SegmentStore {
  return {
    async list() {
      let names: string[] = [];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return {
        segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
        snapshots: names.filter(name => /^snapshot-\d+$/.test(name)).map(name => Number(name.slice(9))).sort((a, b) => a - b),
      };
    },
    read: name => readFile(join(directory, name), "utf8"),
    async create(name, body) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let file;
      try { file = await open(join(directory, name), "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PreconditionFailed(`${directory}/${name}`); throw error; }
      try { await file.writeFile(body, "utf8"); await file.datasync(); } finally { await file.close(); }
    },
    async remove(names) { await Promise.all(names.map(name => rm(join(directory, name), { force: true }))); },
  };
}

/** In-process storage for tests. */
export function memoryStorage(): Storage & { documents: Map<string, string>; logs: Map<string, Map<string, string>> } {
  const documents = new Map<string, string>();
  const logs = new Map<string, Map<string, string>>();
  return {
    documents, logs,
    async readJson(key) {
      const text = documents.get(validKey(key));
      return text === undefined ? undefined : { value: JSON.parse(text), version: versionOf(text) };
    },
    async writeJson(key, value, expected) {
      const current = documents.get(validKey(key));
      if (expected === null ? current !== undefined : expected !== undefined && (current === undefined || versionOf(current) !== expected)) throw new PreconditionFailed(key);
      const text = JSON.stringify(value);
      documents.set(key, text);
      return versionOf(text);
    },
    async deleteJson(key) { documents.delete(key); },
    async listJson(prefix) { return [...documents.keys()].filter(key => key.startsWith(prefix)).sort(); },
    log<T>(key: string) { return segmentLog<T>(memorySegments(logs, validKey(key)), key); },
    async hasLog(key) { return (logs.get(key)?.size ?? 0) > 0; },
  };
}

/**
 * The segment operations a log needs from an object store. Segment `n` holds the
 * records of one flush; a snapshot at `n` replaces every segment below `n`.
 */
export interface SegmentStore {
  list(): Promise<{ segments: number[]; snapshots: number[] }>;
  read(name: string): Promise<string>;
  /** Create a segment or snapshot; throws PreconditionFailed if it already exists. */
  create(name: string, body: string): Promise<void>;
  remove(names: string[]): Promise<void>;
}

function memorySegments(logs: Map<string, Map<string, string>>, key: string): SegmentStore {
  const objects = () => {
    let entry = logs.get(key);
    if (!entry) { entry = new Map(); logs.set(key, entry); }
    return entry;
  };
  return {
    async list() {
      const names = [...objects().keys()];
      return {
        segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
        snapshots: names.filter(name => name.startsWith("snapshot-")).map(name => Number(name.slice(9))).sort((a, b) => a - b),
      };
    },
    async read(name) { const body = objects().get(name); if (body === undefined) throw new Error(`Missing log object ${key}/${name}`); return body; },
    async create(name, body) { if (objects().has(name)) throw new PreconditionFailed(`${key}/${name}`); objects().set(name, body); },
    async remove(names) { for (const name of names) objects().delete(name); },
  };
}

const segmentName = (sequence: number) => String(sequence).padStart(12, "0");

/**
 * An AppendLog over immutable segments. Durable flushes create the next segment
 * immediately; non-durable flushes are coalesced briefly to save requests.
 * A writer that loses a segment race (another owner appended first) is fenced:
 * every later flush fails, so it can never interleave with the new owner.
 */
export function segmentLog<T>(store: SegmentStore, label: string, options: { coalesceMs?: number } = {}): AppendLog<T> {
  let buffer: string[] = [];
  let next: number | undefined;
  let appended = 0;
  let fenced: Error | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const serialize = <R>(work: () => Promise<R>): Promise<R> => {
    const result = chain.then(work);
    chain = result.then(() => {}, () => {});
    return result;
  };
  const position = async () => {
    if (next === undefined) {
      const { segments, snapshots } = await store.list();
      next = Math.max(-1, ...segments, ...snapshots) + 1;
    }
    return next;
  };
  const write = async () => {
    if (fenced) throw fenced;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    const sequence = await position();
    try { await store.create(segmentName(sequence), batch.join("\n") + "\n"); }
    catch (error) {
      if (error instanceof PreconditionFailed) fenced = new PreconditionFailed(`${label} (another owner is appending)`);
      else buffer = batch.concat(buffer);
      throw fenced ?? error;
    }
    next = sequence + 1;
  };
  return {
    async read() {
      const { segments, snapshots } = await store.list();
      const snapshot = snapshots.at(-1);
      const records: T[] = snapshot === undefined ? [] : JSON.parse(await store.read(`snapshot-${segmentName(snapshot)}`));
      for (const sequence of segments) {
        if (snapshot !== undefined && sequence <= snapshot) continue;
        for (const line of (await store.read(segmentName(sequence))).split("\n")) if (line) records.push(JSON.parse(line));
      }
      next = Math.max(-1, ...segments, ...snapshots) + 1;
      return records;
    },
    append(record) {
      if (closed) throw new Error("Append log closed");
      buffer.push(JSON.stringify(record));
      appended++;
    },
    flush(durable = false) {
      if (!durable && (options.coalesceMs ?? 250) > 0) {
        timer ??= setTimeout(() => { timer = undefined; void serialize(write).catch(() => {}); }, options.coalesceMs ?? 250);
        return Promise.resolve();
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      return serialize(write);
    },
    rewrite(snapshot) {
      return serialize(async () => {
        if (fenced) throw fenced;
        const records = snapshot();
        buffer = [];
        // The snapshot takes a sequence slot, so later segments sort after it.
        const sequence = await position();
        try { await store.create(`snapshot-${segmentName(sequence)}`, JSON.stringify(records)); }
        catch (error) { if (error instanceof PreconditionFailed) fenced = error; throw error; }
        next = sequence + 1;
        const { segments, snapshots } = await store.list();
        await store.remove([
          ...segments.filter(item => item < sequence).map(segmentName),
          ...snapshots.filter(item => item < sequence).map(item => `snapshot-${segmentName(item)}`),
        ]);
        appended = 0;
      });
    },
    get appendedSinceRewrite() { return appended; },
    close() {
      if (timer) { clearTimeout(timer); timer = undefined; }
      closed = true;
      return serialize(write).catch(() => {});
    },
  };
}
