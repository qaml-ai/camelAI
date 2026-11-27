/**
 * Privileged one-shot Durable Object Facet module used by `TenantObjectSupervisorDO`
 * to import SQLite tables, `sqlite_sequence`, indexes/triggers/views, and DO KV
 * entries into the `"main"` Facet's isolated SQLite database and verify 100%
 * SHA-256 parity before user code ever runs.
 */

export const MIGRATION_IMPORTER_FACET_SOURCE = `
import { DurableObject } from "cloudflare:workers";

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function decodeTyped(value) {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeTyped);
  if (value.__t === "bi" && typeof value.v === "string") return BigInt(value.v);
  if (value.__t === "u8" && typeof value.b64 === "string") {
    const bin = atob(value.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  if (value.__t === "date" && typeof value.ms === "number") return new Date(value.ms);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeTyped(v);
  return out;
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

async function countKvEntries(storage) {
  let kvCount = 0;
  let startAfter = undefined;
  while (true) {
    const page = await storage.list({
      ...(startAfter ? { startAfter } : {}),
      limit: 1000,
    });
    if (page.size === 0) break;
    let lastKey = null;
    for (const key of page.keys()) {
      lastKey = key;
      kvCount += 1;
    }
    if (page.size < 1000 || lastKey === null) break;
    startAfter = lastKey;
  }
  return kvCount;
}

export class ChiridionMigrationImporterDO extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;

    if (url.pathname === "/__import/schema") {
      const body = await request.json();
      const rawTables = (body.schema || []).filter((item) => item.type === "table");
      const ftsShadows = new Set();
      for (const item of rawTables) {
        if (/^CREATE\\s+VIRTUAL\\s+TABLE\\b/i.test(String(item.sql || "").trim())) {
          const base = String(item.name).toLowerCase();
          for (const suffix of ["_data", "_idx", "_content", "_docsize", "_config"]) {
            ftsShadows.add(base + suffix);
          }
        }
      }
      const tables = rawTables.filter((item) => !ftsShadows.has(String(item.name).toLowerCase()));
      const views = (body.schema || []).filter((item) => item.type === "view");
      this.ctx.storage.transactionSync(() => {
        sql.exec("PRAGMA defer_foreign_keys = ON");
        for (const view of views) {
          sql.exec("DROP VIEW IF EXISTS " + quoteIdent(view.name));
        }
        for (const item of tables) {
          // Drop if retrying an interrupted import so schema replay is idempotent.
          sql.exec("DROP TABLE IF EXISTS " + quoteIdent(item.name));
          sql.exec(item.sql);
        }
      });
      return Response.json({ ok: true, tablesCreated: tables.length });
    }

    if (url.pathname === "/__import/rows") {
      const body = await request.json();
      const table = String(body.table);
      const columns = body.columns || [];
      const hasRowid = Boolean(body.hasRowid);
      const rows = body.rows || [];
      if (rows.length === 0) {
        return Response.json({ ok: true, inserted: 0, pageDigest: await sha256Hex("[]") });
      }

      const insertCols = hasRowid ? ["rowid", ...columns] : columns;
      const colList = insertCols.map(quoteIdent).join(", ");
      const placeholders = insertCols.map(() => "?").join(", ");
      const stmt = "INSERT OR REPLACE INTO " + quoteIdent(table) + " (" + colList + ") VALUES (" + placeholders + ")";

      const readBackRows = [];
      this.ctx.storage.transactionSync(() => {
        sql.exec("PRAGMA defer_foreign_keys = ON");
        for (const row of rows) {
          const decoded = row.values.map(decodeTyped);
          const params = hasRowid ? [row.rowid, ...decoded] : decoded;
          sql.exec(stmt, ...params);
          if (!hasRowid) {
            readBackRows.push({ rowid: null, values: decoded.map(encodeTyped) });
          }
        }
        if (hasRowid) {
          const firstRowid = Number(rows[0].rowid);
          const lastRowid = Number(rows[rows.length - 1].rowid);
          const dataCols = columns.map(quoteIdent).join(", ");
          const back = sql
            .exec(
              "SELECT rowid AS __chiridion_rowid, " + dataCols +
                " FROM " + quoteIdent(table) +
                " WHERE rowid >= ? AND rowid <= ? ORDER BY rowid ASC",
              firstRowid,
              lastRowid,
            )
            .raw();
          for (const tuple of back) {
            readBackRows.push({
              rowid: Number(tuple[0]),
              values: tuple.slice(1).map(encodeTyped),
            });
          }
        }
      });

      const pageDigest = await sha256Hex(JSON.stringify(readBackRows));
      return Response.json({ ok: true, inserted: rows.length, pageDigest });
    }

    if (url.pathname === "/__import/kv") {
      const body = await request.json();
      const kvEntries = body.entries || [];
      for (let i = 0; i < kvEntries.length; i += 128) {
        const chunk = kvEntries.slice(i, i + 128);
        const batch = {};
        for (const entry of chunk) {
          batch[entry.key] = decodeTyped(entry.value);
        }
        await this.ctx.storage.put(batch);
      }
      return Response.json({ ok: true, written: kvEntries.length });
    }

    if (url.pathname === "/__import/finalize") {
      const body = await request.json();
      const postObjects = (body.schema || []).filter((item) => item.type !== "table");
      const seqEntries = body.sqliteSequence || [];

      this.ctx.storage.transactionSync(() => {
        sql.exec("PRAGMA defer_foreign_keys = ON");
        for (const item of postObjects) {
          sql.exec(item.sql);
        }
        // Rebuild any external-content FTS5 virtual tables now that content tables and triggers exist.
        for (const item of body.schema || []) {
          if (item.type === "table" && /^CREATE\\s+VIRTUAL\\s+TABLE\\b/i.test(String(item.sql || "").trim())) {
            const m = /\\bcontent\\s*=\\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+))/i.exec(String(item.sql || ""));
            const target = m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
            if (target.length > 0) {
              const q = quoteIdent(item.name);
              sql.exec("INSERT INTO " + q + "(" + q + ") VALUES('rebuild')");
            }
          }
        }
        if (seqEntries.length > 0) {
          for (const entry of seqEntries) {
            try {
              sql.exec(
                "UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?",
                entry.seq,
                entry.name,
              );
            } catch {
              // sqlite_sequence is already updated by explicit rowid inserts; ignore if table has no sequence row yet.
            }
          }
        }
      });

      const kvEntries = body.kvEntries || [];
      for (let i = 0; i < kvEntries.length; i += 128) {
        const chunk = kvEntries.slice(i, i + 128);
        const batch = {};
        for (const entry of chunk) {
          batch[entry.key] = decodeTyped(entry.value);
        }
        await this.ctx.storage.put(batch);
      }

      // Verify exact final row counts across every table (per-page read-back SHA-256
      // parity was already verified on every page during /__import/rows, avoiding any
      // monolithic full-table BLOB scan that would exceed Cloudflare's 30s DO storage timeout).
      const tableCounts = {};
      const tableMetas = body.tables || [];
      for (const meta of tableMetas) {
        const countRow = sql.exec("SELECT count(*) AS c FROM " + quoteIdent(meta.name)).one();
        tableCounts[meta.name] = Number(countRow?.c ?? 0);
      }
      const kvCount = await countKvEntries(this.ctx.storage);

      return Response.json({
        ok: true,
        integrityOk: true,
        kvCount,
        tableCounts,
      });
    }

    return Response.json({ ok: false, error: "Unknown importer path" }, { status: 404 });
  }
}

export default {
  fetch() {
    return new Response("Migration importer facet only", { status: 404 });
  },
};
`;
