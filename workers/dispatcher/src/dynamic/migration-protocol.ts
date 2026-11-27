/**
 * Shared protocol for zero-data-loss Durable Object migration from WfP to
 * Dynamic Workers (`TenantObjectSupervisorDO` Facets).
 *
 * - HMAC-SHA256 request signing (`X-Chiridion-Migration-Sig`, `X-Chiridion-Migration-Ts`)
 * - Lossless typed JSON encoding for SQLite blobs (`Uint8Array`) & `BigInt` values
 * - Canonical table & shard SHA-256 verification digests
 */

export const MIGRATION_SIG_HEADER = 'x-chiridion-migration-sig';
export const MIGRATION_TS_HEADER = 'x-chiridion-migration-ts';
export const MIGRATION_MAX_SKEW_MS = 60_000;
export const MIGRATION_RETRY_AFTER_SECONDS = 2;
export const MIGRATION_PENDING_MESSAGE = `Durable Object migration is still in progress (retry after ${MIGRATION_RETRY_AFTER_SECONDS} seconds)`;

export function migrationPendingResponse(): Response {
  return new Response(MIGRATION_PENDING_MESSAGE, {
    status: 503,
    headers: { 'Retry-After': String(MIGRATION_RETRY_AFTER_SECONDS) },
  });
}

export interface SchemaObjectDdl {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  tblName: string;
  sql: string;
}

export interface TableExportMeta {
  name: string;
  rowCount: number;
  hasRowid: boolean;
  primaryKeyColumns: string[];
  columns: string[];
}

export interface FreezeResponsePayload {
  ok: true;
  hexId: string;
  databaseSize: number;
  alarmMs: number | null;
  kvCount: number;
  schema: SchemaObjectDdl[];
  tables: TableExportMeta[];
  sqliteSequence: Array<{ name: string; seq: number }>;
}

export interface SqlPagePayload {
  ok: true;
  table: string;
  columns: string[];
  hasRowid: boolean;
  rows: Array<{ rowid: number | null; values: unknown[] }>;
  nextCursor: number | null;
  done: boolean;
  pageDigest: string;
}

export interface KvPagePayload {
  ok: true;
  entries: Array<{ key: string; value: unknown }>;
  nextAfterKey: string | null;
  done: boolean;
}

export interface VerifyResponsePayload {
  ok: true;
  hexId: string;
  alarmMs: number | null;
  kvCount: number;
  tableCounts: Record<string, number>;
  tableDigests: Record<string, string>;
  overallDigest: string;
}

export interface FullShardMigrationBundle {
  hexId: string;
  alarmMs: number | null;
  schema: SchemaObjectDdl[];
  sqliteSequence: Array<{ name: string; seq: number }>;
  tables: Array<{
    name: string;
    columns: string[];
    hasRowid: boolean;
    rows: Array<{ rowid: number | null; values: unknown[] }>;
  }>;
  kvEntries: Array<{ key: string; value: unknown }>;
  expectedCounts: Record<string, number>;
  expectedOverallDigest: string;
}

export function encodeTypedValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    return { __t: 'bi', v: value.toString() };
  }
  if (value instanceof Uint8Array) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < value.length; i += chunk) {
      binary += String.fromCharCode(...value.subarray(i, i + chunk));
    }
    return { __t: 'u8', b64: btoa(binary) };
  }
  if (value instanceof ArrayBuffer) {
    return encodeTypedValue(new Uint8Array(value));
  }
  if (value instanceof Date) {
    return { __t: 'date', ms: value.getTime() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeTypedValue);
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = encodeTypedValue(v);
    }
    return out;
  }
  return value;
}

export function decodeTypedValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeTypedValue);
  }
  const obj = value as Record<string, unknown>;
  if (obj.__t === 'bi' && typeof obj.v === 'string') {
    return BigInt(obj.v);
  }
  if (obj.__t === 'u8' && typeof obj.b64 === 'string') {
    const binary = atob(obj.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  if (obj.__t === 'date' && typeof obj.ms === 'number') {
    return new Date(obj.ms);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = decodeTypedValue(v);
  }
  return out;
}

export async function sha256HexString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function signMigrationRequest(
  secret: string,
  canonicalTarget: string,
  timestampMs: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestampMs}:${canonicalTarget}`),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyMigrationSignature(
  secret: string,
  canonicalTarget: string,
  signature: string | null,
  timestampHeader: string | null,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !signature || !timestampHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > MIGRATION_MAX_SKEW_MS) {
    return false;
  }
  const expected = await signMigrationRequest(secret, canonicalTarget, ts);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
