/**
 * Zero-migration WfP Storage Export Shim generator.
 *
 * Uploads cleanly over an existing WfP dispatch script with ZERO `migrations`
 * array while exporting the exact same Durable Object class names — preserving
 * 100% of SQLite tables, DO KV keys, and pending alarms untouched (the same
 * mechanism proven in `workers/app-usage-guard/src/quarantine.ts`).
 *
 * Security:
 * - Every `/__migrate/*` endpoint requires a valid HMAC-SHA256 signature
 *   (`X-Chiridion-Migration-Sig` + `X-Chiridion-Migration-Ts` within 60s).
 * - Public traffic receives a clean `503 Maintenance` (`Retry-After: 5`) during
 *   the brief singleton cutover window.
 * - Cohort C alarm auto-discovery: if an unmigrated WfP DO's alarm fires while
 *   the shim is live, `alarm()` POSTs `{ className, hexId }` to the configured
 *   discovery callback URL (HMAC-signed) so the platform can migrate dormant shards.
 */

function assertIdentifier(name: string): void {
  if (!/^[$A-Z_a-z][$\w]*$/.test(name) || name === 'default') {
    throw new Error(`Unsafe Durable Object class name for export shim: ${name}`);
  }
}

export interface BuildExportShimOptions {
  classNames: string[];
  bindingMap: Record<string, string>; // bindingName -> className
  hmacSecret: string;
  discoveryWebhookUrl?: string;
}

export function buildWfpExportShimSource(options: BuildExportShimOptions): string {
  const uniqueClasses = [...new Set(options.classNames)];
  for (const cls of uniqueClasses) {
    assertIdentifier(cls);
  }

  const classExports = uniqueClasses
    .map(
      (className) =>
        `export class ${className} extends ChiridionExportShimDO {\n` +
        `  static __shimClassName = ${JSON.stringify(className)};\n` +
        `}`,
    )
    .join('\n\n');

  return `
import { DurableObject } from "cloudflare:workers";

const HMAC_SECRET = ${JSON.stringify(options.hmacSecret)};
const BINDING_MAP = ${JSON.stringify(options.bindingMap)};
const DISCOVERY_WEBHOOK_URL = ${JSON.stringify(options.discoveryWebhookUrl ?? '')};
const FROZEN_KEY = "__chiridion_migration_frozen";
const MAX_SKEW_MS = 60_000;

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function encodeTyped(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return { __t: "bi", v: value.toString() };
  if (value instanceof Uint8Array) {
    let bin = "";
    for (let i = 0; i < value.length; i += 0x8000) {
      bin += String.fromCharCode(...value.subarray(i, i + 0x8000));
    }
    return { __t: "u8", b64: btoa(bin) };
  }
  if (value instanceof ArrayBuffer) return encodeTyped(new Uint8Array(value));
  if (value instanceof Date) return { __t: "date", ms: value.getTime() };
  if (Array.isArray(value)) return value.map(encodeTyped);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeTyped(v);
    return out;
  }
  return value;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signHmac(message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyRequest(request, canonicalTarget) {
  const sig = request.headers.get("x-chiridion-migration-sig");
  const tsRaw = request.headers.get("x-chiridion-migration-ts");
  if (!sig || !tsRaw) return false;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SKEW_MS) return false;
  const expected = await signHmac(ts + ":" + canonicalTarget);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function getSql(storage) {
  try {
    const sql = storage.sql;
    void sql.databaseSize;
    return sql;
  } catch {
    return null;
  }
}

function inspectTables(sql) {
  if (!sql) return { schema: [], tables: [], sqliteSequence: [] };
  const masterRows = sql
    .exec("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 WHEN 'view' THEN 4 ELSE 5 END, name")
    .toArray();
  const schema = masterRows.map((r) => ({
    type: String(r.type),
    name: String(r.name),
    tblName: String(r.tbl_name),
    sql: String(r.sql),
  }));
  const tables = [];
  for (const item of schema) {
    if (item.type !== "table") continue;
    const infoRows = sql.exec("PRAGMA table_info(" + quoteIdent(item.name) + ")").toArray();
    const columns = infoRows.map((c) => String(c.name));
    const pkCols = infoRows
      .filter((c) => Number(c.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((c) => String(c.name));
    let hasRowid = true;
    try {
      sql.exec("SELECT rowid FROM " + quoteIdent(item.name) + " LIMIT 0").toArray();
    } catch {
      hasRowid = false;
    }
    const countRow = sql.exec("SELECT count(*) AS c FROM " + quoteIdent(item.name)).one();
    tables.push({
      name: item.name,
      rowCount: Number(countRow?.c ?? 0),
      hasRowid,
      primaryKeyColumns: pkCols,
      columns,
    });
  }
  let sqliteSequence = [];
  try {
    sqliteSequence = sql
      .exec("SELECT name, seq FROM sqlite_sequence")
      .toArray()
      .map((r) => ({ name: String(r.name), seq: Number(r.seq) }));
  } catch {
    // sqlite_sequence only exists when AUTOINCREMENT is used.
  }
  return { schema, tables, sqliteSequence };
}

class ChiridionExportShimDO extends DurableObject {
  async alarm() {
    if (!DISCOVERY_WEBHOOK_URL) return;
    const ts = Date.now();
    const className = this.constructor.__shimClassName;
    const hexId = this.ctx.id.toString();
    const sig = await signHmac(ts + ":alarm:" + className + ":" + hexId);
    try {
      await fetch(DISCOVERY_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-chiridion-migration-ts": String(ts),
          "x-chiridion-migration-sig": sig,
        },
        body: JSON.stringify({ className, hexId }),
      });
    } catch {}
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!(await verifyRequest(request, path))) {
      return new Response("Service temporarily migrating", {
        status: 503,
        headers: { "Retry-After": "5", "X-Chiridion-Migrating": "1" },
      });
    }

    const sql = getSql(this.ctx.storage);

    if (path === "/__migrate/freeze") {
      await this.ctx.storage.put(FROZEN_KEY, true);
      const { schema, tables, sqliteSequence } = inspectTables(sql);
      const alarmMs = await this.ctx.storage.getAlarm();
      const kvAll = await this.ctx.storage.list();
      let kvCount = 0;
      for (const key of kvAll.keys()) {
        if (key !== FROZEN_KEY) kvCount += 1;
      }
      return Response.json({
        ok: true,
        hexId: this.ctx.id.toString(),
        databaseSize: sql ? Number(sql.databaseSize) || 0 : 0,
        alarmMs: alarmMs ?? null,
        kvCount,
        schema,
        tables,
        sqliteSequence,
      });
    }

    if (path === "/__migrate/export-sql") {
      if (!sql) return Response.json({ ok: false, error: "No SQLite storage" }, { status: 400 });
      const table = url.searchParams.get("table") || "";
      const afterRowid = Number(url.searchParams.get("afterRowid") ?? "-1");
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") ?? "500")));
      const { tables } = inspectTables(sql);
      const meta = tables.find((t) => t.name === table);
      if (!meta) return Response.json({ ok: false, error: "Table not found: " + table }, { status: 404 });

      const colSql = meta.columns.map(quoteIdent).join(", ");
      const rows = [];
      let nextCursor = null;
      let done = true;

      if (meta.hasRowid) {
        const raw = sql
          .exec(
            "SELECT rowid AS __chiridion_rowid, " + colSql +
              " FROM " + quoteIdent(table) +
              " WHERE rowid > ? ORDER BY rowid ASC LIMIT ?",
            afterRowid,
            limit + 1,
          )
          .raw();
        const batch = [...raw];
        done = batch.length <= limit;
        const page = done ? batch : batch.slice(0, limit);
        for (const tuple of page) {
          const rowid = Number(tuple[0]);
          const values = tuple.slice(1).map(encodeTyped);
          rows.push({ rowid, values });
          nextCursor = rowid;
        }
      } else {
        const offset = Math.max(0, afterRowid < 0 ? 0 : afterRowid);
        const raw = sql
          .exec(
            "SELECT " + colSql + " FROM " + quoteIdent(table) + " LIMIT ? OFFSET ?",
            limit + 1,
            offset,
          )
          .raw();
        const batch = [...raw];
        done = batch.length <= limit;
        const page = done ? batch : batch.slice(0, limit);
        for (const tuple of page) {
          rows.push({ rowid: null, values: tuple.map(encodeTyped) });
        }
        nextCursor = done ? null : offset + page.length;
      }

      const pageDigest = await sha256Hex(JSON.stringify(rows));
      return Response.json({
        ok: true,
        table,
        columns: meta.columns,
        hasRowid: meta.hasRowid,
        rows,
        nextCursor,
        done,
        pageDigest,
      });
    }

    if (path === "/__migrate/export-kv") {
      const afterKey = url.searchParams.get("afterKey") || undefined;
      const limit = Math.max(1, Math.min(256, Number(url.searchParams.get("limit") ?? "256")));
      const listed = await this.ctx.storage.list({
        ...(afterKey ? { startAfter: afterKey } : {}),
        limit: limit + 1,
      });
      const allEntries = [...listed.entries()].filter(([k]) => k !== FROZEN_KEY);
      const done = allEntries.length <= limit;
      const page = done ? allEntries : allEntries.slice(0, limit);
      const entries = page.map(([key, value]) => ({ key, value: encodeTyped(value) }));
      const nextAfterKey = done || page.length === 0 ? null : page[page.length - 1][0];
      return Response.json({ ok: true, entries, nextAfterKey, done });
    }

    if (path === "/__migrate/verify") {
      const { tables } = inspectTables(sql);
      const tableCounts = {};
      const tableDigests = {};
      for (const meta of tables) {
        tableCounts[meta.name] = meta.rowCount;
        const colSql = meta.columns.map(quoteIdent).join(", ");
        const orderClause = meta.hasRowid ? " ORDER BY rowid ASC" : "";
        const rows = sql
          .exec("SELECT " + colSql + " FROM " + quoteIdent(meta.name) + orderClause)
          .raw();
        const serialized = [...rows].map((tuple) => tuple.map(encodeTyped));
        tableDigests[meta.name] = await sha256Hex(JSON.stringify(serialized));
      }
      const alarmMs = await this.ctx.storage.getAlarm();
      const kvAll = await this.ctx.storage.list();
      let kvCount = 0;
      for (const key of kvAll.keys()) {
        if (key !== FROZEN_KEY) kvCount += 1;
      }
      const overallDigest = await sha256Hex(
        JSON.stringify({ tableCounts, tableDigests, kvCount }),
      );
      return Response.json({
        ok: true,
        hexId: this.ctx.id.toString(),
        alarmMs: alarmMs ?? null,
        kvCount,
        tableCounts,
        tableDigests,
        overallDigest,
      });
    }

    return Response.json({ ok: false, error: "Unknown migration path" }, { status: 404 });
  }
}

${classExports}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__migrate/")) {
      return new Response("Service temporarily migrating", {
        status: 503,
        headers: { "Retry-After": "5", "X-Chiridion-Migrating": "1" },
      });
    }
    const className = url.searchParams.get("className") || "";
    const objectId = url.searchParams.get("objectId") || "";
    const bindingEntry = Object.entries(BINDING_MAP).find(([, cls]) => cls === className);
    if (!bindingEntry || !objectId) {
      return Response.json({ ok: false, error: "Missing className or objectId" }, { status: 400 });
    }
    const ns = env[bindingEntry[0]];
    if (!ns) {
      return Response.json({ ok: false, error: "Binding not found: " + bindingEntry[0] }, { status: 500 });
    }
    let doId;
    if (objectId.startsWith("name:")) {
      doId = ns.idFromName(objectId.slice(5));
    } else if (/^[0-9a-f]{64}$/i.test(objectId)) {
      doId = ns.idFromString(objectId);
    } else {
      doId = ns.idFromName(objectId);
    }
    const stub = ns.get(doId);
    return stub.fetch(request);
  },
};
`;
}
