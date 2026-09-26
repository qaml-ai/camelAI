import type { SqlDatabaseClient } from './sql-database-mcp.js';

/**
 * Warehouse export — the deterministic, Worker-side pieces of a connection's
 * `export` method: the R2 staging key + the SQL export request body.
 *
 * Data reaches the analysis container only via R2: a connection's `export`
 * method resolves credentials server-side and stages the read result as an R2
 * object (SQL engines export in the db-query sandbox, which writes Parquet
 * straight to its mounted warehouse prefix — see data-proxy.ts
 * sqlExportToWarehouse; ClickHouse/BigQuery stream from the Worker through
 * stageWarehouseExport below); the container then reads that object via a
 * read-only R2 mount. See docs/warehouse-binding-design.md.
 */

/** Stable, non-cryptographic hash for the R2 staging key (cache identity, not security). */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

export type WarehouseExportFormat = 'parquet' | 'ndjson';

/**
 * R2 key prefix for a workspace's warehouse exports. The sealed container mounts
 * exactly this prefix (read-only), so a workspace can only ever see its own
 * staged objects — the bucket is multi-tenant-safe.
 */
export function warehouseWorkspacePrefix(workspaceId: string): string {
  return `warehouse/${slug(workspaceId)}`;
}

/**
 * Deterministic R2 staging key for a (workspace, connection, query) export.
 * Same inputs → same key, so a re-export overwrites/reuses the same object.
 * Namespaced by workspace (see warehouseWorkspacePrefix).
 *
 * `connectionId` MUST be the integration's unique id, not its display name — two
 * different integrations (e.g. a Postgres and a ClickHouse) can share a name
 * (uniqueness is only enforced per integration_type), so keying by name would
 * collide and silently overwrite/cross-read each other's exports.
 */
export function warehouseExportKey(
  workspaceId: string,
  connectionId: string,
  sql: string,
  format: WarehouseExportFormat = 'parquet',
): string {
  return `${warehouseWorkspacePrefix(workspaceId)}/${slug(connectionId)}/${fnv1a(sql)}.${format}`;
}

const EXPORT_CONTENT_TYPE: Record<WarehouseExportFormat, string> = {
  parquet: 'application/vnd.apache.parquet',
  ndjson: 'application/x-ndjson',
};

// R2 multipart parts (except the last) must be >= 5 MiB; buffer to 8 MiB so a
// large export streams through in bounded memory.
const WAREHOUSE_EXPORT_PART_SIZE = 8 * 1024 * 1024;

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Stream an export body into the warehouse R2 staging bucket and return the
 * object handle.
 *
 * The export bodies are chunked (ClickHouse/data-proxy responses, the BigQuery
 * pager) with no Content-Length, so `R2.put(stream)` rejects them ("readable
 * stream must have a known length"). We therefore buffer and:
 *   - if the WHOLE body fits in one part (the common case — most exports are
 *     small), commit it with a single known-length `bucket.put`. A plain put is
 *     simple and reliable; a one-part multipart upload here was leaving the
 *     object uncommitted (export reported success but no object ever landed in
 *     R2, surfacing in the sealed container as a 0-byte phantom).
 *   - only escalate to a multipart upload once the body exceeds a single part,
 *     so multi-GB exports still stream through in bounded memory (~one part at a
 *     time) without an OOM. Aborts the upload on any failure so no partial object
 *     is left behind.
 *
 * Parts are flushed in fixed `WAREHOUSE_EXPORT_PART_SIZE` chunks, and ONLY while
 * strictly more than one part is buffered — so the retained remainder (and thus
 * the final part) is always non-empty. That guarantees a multipart upload is
 * never completed with a single part, even when the source delivers one big chunk
 * that lands right at/above the threshold and then ends (e.g. BigQuery enqueues a
 * whole result page as one chunk) — which is exactly the single-part case that
 * was failing to commit.
 *
 * After writing, HEAD the key to confirm the object is durably present — so a
 * silent write failure becomes a loud error instead of a phantom that `export()`
 * reports `ok` for.
 */
export async function stageWarehouseExport(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array> | null,
  format: WarehouseExportFormat,
): Promise<{ ok: true; r2_key: string }> {
  if (!body) {
    throw Object.assign(new Error('export source returned no body'), { status: 502 });
  }
  const httpMetadata = { contentType: EXPORT_CONTENT_TYPE[format] };
  const reader = body.getReader();
  let upload: Awaited<ReturnType<R2Bucket['createMultipartUpload']>> | null = null;
  const parts: R2UploadedPart[] = [];
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;

  // Take exactly `size` bytes off the front of the buffer (splitting a chunk if
  // needed), retaining the rest. Callers only ever take <= bufferedBytes.
  const takeBytes = (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      const head = buffered[0]!;
      const need = size - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        buffered.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        buffered[0] = head.subarray(need);
        filled += need;
      }
    }
    bufferedBytes -= size;
    return out;
  };

  const flushPart = async (size: number) => {
    if (!upload) upload = await bucket.createMultipartUpload(key, { httpMetadata });
    parts.push(await upload.uploadPart(parts.length + 1, takeBytes(size)));
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        buffered.push(value);
        bufferedBytes += value.length;
        // Flush full parts only while STRICTLY more than a part remains, so the
        // leftover — and therefore a trailing part — is guaranteed non-empty. We
        // must never complete a multipart upload with a single part.
        while (bufferedBytes > WAREHOUSE_EXPORT_PART_SIZE) {
          await flushPart(WAREHOUSE_EXPORT_PART_SIZE);
        }
      }
    }

    const activeUpload = upload as Awaited<ReturnType<R2Bucket['createMultipartUpload']>> | null;
    if (activeUpload) {
      // Multipart was started, so > 1 part of data exists; the remaining buffer
      // (always > 0 here) is the final, size-unrestricted part.
      if (bufferedBytes > 0) await flushPart(bufferedBytes);
      await activeUpload.complete(parts);
    } else {
      // Whole body fit in one part (incl. empty → 0-byte object): single put.
      await bucket.put(key, concatChunks(buffered, bufferedBytes), { httpMetadata });
    }
  } catch (error) {
    const activeUpload = upload as Awaited<ReturnType<R2Bucket['createMultipartUpload']>> | null;
    if (activeUpload) await activeUpload.abort().catch(() => {});
    throw error;
  }

  const head = await bucket.head(key);
  if (!head) {
    throw Object.assign(
      new Error(`warehouse export did not persist: no object at ${key} after write`),
      { status: 502 },
    );
  }
  return { ok: true, r2_key: key };
}

/**
 * Map a resolved SQL connection client to the engine + legacy-shape export
 * body (the /query body contract the db-query compat layer maps). Pure +
 * unit-testable.
 */
export function sqlClientToExportBody(
  client: SqlDatabaseClient,
  sql: string,
): { engine: 'mysql' | 'postgres'; body: Record<string, unknown> } {
  const base: Record<string, unknown> = {
    mode: 'read',
    host: client.host,
    port: client.port,
    user: client.username,
    password: client.password,
    database: client.database,
    query: sql,
  };
  return client.type === 'postgres'
    ? { engine: 'postgres', body: { ...base, sslmode: client.sslMode } }
    : { engine: 'mysql', body: { ...base, tls: client.tls } };
}

/** A planned export: which engine, the export request body, and the R2 staging key. */
export interface SqlExportPlan {
  engine: 'mysql' | 'postgres';
  body: Record<string, unknown>;
  r2Key: string;
}

/**
 * Build the full export plan for a SQL connection client — the export body +
 * the R2 staging key. Pure; sqlExportToWarehouse (data-proxy.ts) executes it
 * in the db-query sandbox, which writes the Parquet extract to `r2Key`.
 */
export function buildSqlExportPlan(
  workspaceId: string,
  connectionId: string,
  client: SqlDatabaseClient,
  sql: string,
): SqlExportPlan {
  const { engine, body } = sqlClientToExportBody(client, sql);
  return { engine, body, r2Key: warehouseExportKey(workspaceId, connectionId, sql, 'parquet') };
}
