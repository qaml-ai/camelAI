import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type StoreOptions = {
  /** Override data directory. Defaults to `DATA_DIR` env or `.data/`. */
  dataDir?: string;
  /** JSON filename inside dataDir. Defaults to `store.json`. */
  filename?: string;
};

/** Resolve the platform data directory. */
export function resolveDataDir(override?: string): string {
  return resolve(override ?? process.env.DATA_DIR ?? ".data");
}

/**
 * Simple JSON-file + in-memory key/value store.
 * Swap later for SQLite / Durable Object storage without changing callers.
 */
export class Store {
  readonly dataDir: string;
  private readonly filePath: string;
  private readonly memory = new Map<string, unknown>();

  constructor(options: StoreOptions = {}) {
    this.dataDir = resolveDataDir(options.dataDir);
    this.filePath = join(this.dataDir, options.filename ?? "store.json");
    mkdirSync(this.dataDir, { recursive: true });
    this.load();
  }

  get<T = unknown>(key: string): T | undefined {
    if (!key) {
      throw new Error("Store.get: key must be a non-empty string");
    }
    return this.memory.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (!key) {
      throw new Error("Store.set: key must be a non-empty string");
    }
    this.memory.set(key, value);
    this.persist();
  }

  delete(key: string): boolean {
    if (!key) {
      throw new Error("Store.delete: key must be a non-empty string");
    }
    const existed = this.memory.delete(key);
    if (existed) {
      this.persist();
    }
    return existed;
  }

  listByPrefix<T = unknown>(prefix: string): Array<{ key: string; value: T }> {
    if (prefix === undefined || prefix === null) {
      throw new Error("Store.listByPrefix: prefix is required");
    }
    const out: Array<{ key: string; value: T }> = [];
    for (const [key, value] of this.memory) {
      if (key.startsWith(prefix)) {
        out.push({ key, value: value as T });
      }
    }
    out.sort((a, b) => a.key.localeCompare(b.key));
    return out;
  }

  /** Clear all keys (tests / reset). */
  clear(): void {
    this.memory.clear();
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      throw new Error(
        `Store: failed to read ${this.filePath}: ${errorMessage(error)}`,
      );
    }
    if (!raw.trim()) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Store: invalid JSON in ${this.filePath}: ${errorMessage(error)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Store: expected a JSON object in ${this.filePath}, got ${typeof parsed}`,
      );
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      this.memory.set(key, value);
    }
  }

  private persist(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(this.memory), null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmpPath, payload, "utf8");
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      try {
        if (existsSync(tmpPath)) {
          writeFileSync(this.filePath, payload, "utf8");
        }
      } catch {
        // fall through to the wrapped error below
      }
      throw new Error(
        `Store: failed to persist ${this.filePath}: ${errorMessage(error)}`,
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
