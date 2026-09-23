import { mkdir, open, readFile, rename, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Append-only record log. Writers append records cheaply and choose when a
 * batch must be durable, so streaming never pays for a full-state rewrite.
 * `rewrite` atomically replaces the log with a folded snapshot of itself.
 */
export interface AppendLog<T> {
  /** Every record since the last rewrite. A torn final record from a crash is dropped. */
  read(): Promise<T[]>;
  /** Buffer a record; it is written by the next `flush`. */
  append(record: T): void;
  /** Write buffered records. `durable` waits for them to reach stable storage. */
  flush(durable?: boolean): Promise<void>;
  /**
   * Atomically replace the whole log with `snapshot()`, which runs inside the
   * write sequence. Callers apply records to memory as they append them, so the
   * snapshot already reflects any still-buffered records; those are discarded.
   */
  rewrite(snapshot: () => T[]): Promise<void>;
  /** Records appended since the last rewrite (for deciding when to fold). */
  readonly appendedSinceRewrite: number;
  close(): Promise<void>;
}

/** JSONL file implementation for a single process that owns `path`. */
export function fileAppendLog<T>(path: string): AppendLog<T> {
  let buffer: string[] = [];
  let handle: FileHandle | undefined;
  let chain: Promise<void> = Promise.resolve();
  let appended = 0;
  let closed = false;
  const serialize = <R>(work: () => Promise<R>): Promise<R> => {
    const next = chain.then(work);
    chain = next.then(() => {}, () => {});
    return next;
  };
  const opened = async () => {
    if (closed) throw new Error("Append log closed");
    if (!handle) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      handle = await open(path, "a", 0o600);
    }
    return handle;
  };
  return {
    async read() {
      let text: string;
      try { text = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      const lines = text.split("\n");
      const records: T[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]) continue;
        try { records.push(JSON.parse(lines[index])); }
        catch (error) {
          // Only the final line can be torn by a crash mid-append.
          if (index === lines.length - 1 || lines.slice(index + 1).every(line => !line)) break;
          throw new Error(`Corrupt append log record ${index + 1} in ${path}: ${(error as Error).message}`);
        }
      }
      return records;
    },
    append(record) {
      if (closed) throw new Error("Append log closed");
      buffer.push(JSON.stringify(record));
      appended++;
    },
    flush(durable = false) {
      return serialize(async () => {
        const file = await opened();
        if (buffer.length) {
          const batch = buffer;
          buffer = [];
          try { await file.appendFile(batch.join("\n") + "\n", "utf8"); }
          catch (error) { buffer = batch.concat(buffer); throw error; }
        }
        if (durable) await file.datasync();
      });
    },
    rewrite(snapshot) {
      return serialize(async () => {
        const records = snapshot();
        buffer = [];
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        const file = await open(temporary, "wx", 0o600);
        try {
          if (records.length) await file.appendFile(records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
          await file.datasync();
        } finally { await file.close(); }
        await handle?.close();
        handle = undefined;
        await rename(temporary, path);
        const parent = openSync(dirname(path), "r");
        try { fsyncSync(parent); } finally { closeSync(parent); }
        appended = 0;
      });
    },
    get appendedSinceRewrite() { return appended; },
    close() {
      return serialize(async () => {
        closed = true;
        await handle?.close();
        handle = undefined;
      });
    },
  };
}
