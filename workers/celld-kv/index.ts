import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

interface KvEnv {
  KV_STORAGE: DurableObjectNamespace<CelldKvDO>;
}

interface StoredRow {
  value: unknown;
  metadata: string | null;
  expires_at: number | null;
}

interface ListRow {
  key: string;
  metadata: string | null;
  expires_at: number | null;
}

interface KvGetOptions {
  type?: "text" | "json" | "arrayBuffer" | "stream";
}

interface KvPutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

interface KvListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

function bytesFromStoredValue(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new TypeError("celld KV returned an unsupported SQLite BLOB representation");
}

function bytesFromInput(value: unknown): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ReadableStream) {
    throw new TypeError(
      "ReadableStream KV writes require cross-isolate RPC streams and are not available in the celld pilot",
    );
  }
  throw new TypeError("KV put value must be a string, ArrayBuffer, or ArrayBufferView");
}

function parseMetadata(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function encodeCursor(key: string): string {
  return Array.from(new TextEncoder().encode(key), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeCursor(cursor: string | undefined): string {
  if (!cursor) return "";
  if (!/^(?:[0-9a-f]{2})*$/i.test(cursor)) {
    throw new TypeError("Invalid KV list cursor");
  }
  const bytes = new Uint8Array(cursor.length / 2);
  for (let index = 0; index < cursor.length; index += 2) {
    bytes[index / 2] = Number.parseInt(cursor.slice(index, index + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export class CelldKvDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      `
        CREATE TABLE IF NOT EXISTS kv_entries (
          key TEXT PRIMARY KEY,
          value BLOB NOT NULL,
          metadata TEXT,
          expires_at INTEGER
        )
      `,
    );
    this.ctx.storage.sql.exec(
      `
        CREATE INDEX IF NOT EXISTS kv_entries_expiration
        ON kv_entries (expires_at)
        WHERE expires_at IS NOT NULL
      `,
    );
  }

  private read(key: string): StoredRow | null {
    const rows = this.ctx.storage.sql
      .exec<StoredRow>(
        "SELECT value, metadata, expires_at FROM kv_entries WHERE key = ?",
        key,
      )
      .toArray();
    const row = rows[0];
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.delete(key);
      return null;
    }
    return row;
  }

  private decodeValue(row: StoredRow, type: KvGetOptions["type"]): unknown {
    const bytes = bytesFromStoredValue(row.value);
    if (type === "arrayBuffer") {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (type === "stream") {
      throw new TypeError(
        "ReadableStream KV reads require cross-isolate RPC streams and are not available in the celld pilot",
      );
    }
    const text = new TextDecoder().decode(bytes);
    return type === "json" ? JSON.parse(text) : text;
  }

  get(
    key: string,
    typeOrOptions?: KvGetOptions["type"] | KvGetOptions,
  ): unknown {
    const row = this.read(String(key));
    if (!row) return null;
    const type =
      typeof typeOrOptions === "string"
        ? typeOrOptions
        : typeOrOptions?.type ?? "text";
    return this.decodeValue(row, type);
  }

  getWithMetadata(
    key: string,
    typeOrOptions?: KvGetOptions["type"] | KvGetOptions,
  ): { value: unknown; metadata: unknown } {
    const row = this.read(String(key));
    if (!row) return { value: null, metadata: null };
    const type =
      typeof typeOrOptions === "string"
        ? typeOrOptions
        : typeOrOptions?.type ?? "text";
    return {
      value: this.decodeValue(row, type),
      metadata: parseMetadata(row.metadata),
    };
  }

  put(key: string, value: unknown, options: KvPutOptions = {}): void {
    const now = Math.floor(Date.now() / 1000);
    const expiration =
      options.expiration !== undefined
        ? Math.floor(options.expiration)
        : options.expirationTtl !== undefined
          ? now + Math.floor(options.expirationTtl)
          : null;
    if (expiration !== null && expiration <= now) {
      this.delete(String(key));
      return;
    }
    const bytes = bytesFromInput(value);
    const metadata =
      options.metadata === undefined ? null : JSON.stringify(options.metadata);
    this.ctx.storage.sql.exec(
      `
        INSERT INTO kv_entries (key, value, metadata, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          metadata = excluded.metadata,
          expires_at = excluded.expires_at
      `,
      String(key),
      bytes,
      metadata,
      expiration,
    );
  }

  delete(key: string): void {
    this.ctx.storage.sql.exec("DELETE FROM kv_entries WHERE key = ?", String(key));
  }

  list(options: KvListOptions = {}): {
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor: string;
  } {
    const prefix = String(options.prefix ?? "");
    const after = decodeCursor(options.cursor);
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 1000)));
    const now = Math.floor(Date.now() / 1000);
    const rows = this.ctx.storage.sql
      .exec<ListRow>(
        `
          SELECT key, metadata, expires_at
          FROM kv_entries
          WHERE key > ?
            AND substr(key, 1, ?) = ?
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY key
          LIMIT ?
        `,
        after,
        prefix.length,
        prefix,
        now,
        limit + 1,
      )
      .toArray();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const keys = page.map((row) => ({
      name: row.key,
      ...(row.expires_at === null ? {} : { expiration: row.expires_at }),
      ...(row.metadata === null ? {} : { metadata: parseMetadata(row.metadata) }),
    }));
    return {
      keys,
      list_complete: !hasMore,
      cursor: hasMore ? encodeCursor(page.at(-1)?.key ?? "") : "",
    };
  }
}

abstract class KvNamespaceEntrypoint extends WorkerEntrypoint<KvEnv> {
  protected abstract readonly namespace: string;

  private stub(): DurableObjectStub<CelldKvDO> {
    return this.env.KV_STORAGE.getByName(this.namespace);
  }

  get(key: string, typeOrOptions?: KvGetOptions["type"] | KvGetOptions) {
    return this.stub().get(key, typeOrOptions);
  }

  getWithMetadata(
    key: string,
    typeOrOptions?: KvGetOptions["type"] | KvGetOptions,
  ) {
    return this.stub().getWithMetadata(key, typeOrOptions);
  }

  put(key: string, value: unknown, options?: KvPutOptions) {
    return this.stub().put(key, value, options);
  }

  delete(key: string) {
    return this.stub().delete(key);
  }

  list(options?: KvListOptions) {
    return this.stub().list(options);
  }
}

export class AppKv extends KvNamespaceEntrypoint {
  protected readonly namespace = "APP_KV";
}

export class EmailToUserKv extends KvNamespaceEntrypoint {
  protected readonly namespace = "EMAIL_TO_USER";
}

export class SessionsKv extends KvNamespaceEntrypoint {
  protected readonly namespace = "SESSIONS";
}

export default {
  fetch(): Response {
    return new Response("Not Found", { status: 404 });
  },
};
