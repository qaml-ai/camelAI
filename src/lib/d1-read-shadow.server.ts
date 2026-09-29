// Phase-2 flags for serving the fan-out reads from the D1 identity mirror.
//
// Per call site ("getUserOrgs", "getOrgMembers", "threadLists"), comma or
// space separated, or "all". Everything defaults OFF (unset vars):
//
//   D1_READ_SHADOW              serve from the DO, also read D1, compare, and
//                               record d1_shadow_match / d1_shadow_mismatch
//                               (status = field) to OBSERVABILITY_EVENTS
//   D1_READ_SHADOW_SAMPLE_RATE  fraction of shadowed calls that compare (default 1)
//   D1_READ_SERVE               serve from D1 (falls back to the DO per missing row
//                               and on any D1 error); wins over D1_READ_SHADOW
//
// None of these read paths are auth decisions: membership still comes from the
// owning DO, and isMember / session / access-context reads never consult D1.

import {
  getAppIndexReadDatabase,
  type AppIndexDatabase,
} from "../../workers/main/src/app-index-db";
import {
  recordObservabilityEvent,
  type ObservabilityEnv,
} from "../../workers/main/src/observability";

export type D1ReadSite = "getUserOrgs" | "getOrgMembers" | "threadLists";
export type D1ReadMode = "do" | "shadow" | "d1";

export type D1ReadFlagEnv = ObservabilityEnv & {
  APP_DB?: D1Database;
  D1_READ_SHADOW?: string;
  D1_READ_SERVE?: string;
  D1_READ_SHADOW_SAMPLE_RATE?: string;
};

const MAX_MISMATCH_EVENTS = 10;

function flagIncludes(value: unknown, site: D1ReadSite): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const entries = value.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
  return entries.includes(site) || entries.includes("all");
}

export function d1ReadMode(env: object, site: D1ReadSite): D1ReadMode {
  const flags = env as D1ReadFlagEnv;
  if (!flags.APP_DB) return "do";
  if (flagIncludes(flags.D1_READ_SERVE, site)) return "d1";
  if (!flagIncludes(flags.D1_READ_SHADOW, site)) return "do";
  const rate = Number(flags.D1_READ_SHADOW_SAMPLE_RATE ?? "1");
  const sampleRate = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 1;
  return Math.random() < sampleRate ? "shadow" : "do";
}

export function mirrorReadDatabase(env: object): AppIndexDatabase | null {
  return getAppIndexReadDatabase(env as D1ReadFlagEnv);
}

/** Start a D1 read that must never fail the request: resolves null on error. */
export function safeMirrorRead<T>(
  env: object,
  site: D1ReadSite,
  read: (db: AppIndexDatabase) => Promise<T>,
): Promise<T | null> {
  const db = mirrorReadDatabase(env);
  if (!db) return Promise.resolve(null);
  return read(db).catch((error) => {
    recordObservabilityEvent(env as D1ReadFlagEnv, {
      event: "d1_shadow_error",
      severity: "warn",
      component: "d1_read_shadow",
      operation: site,
      errorMessage: error instanceof Error ? error.message : String(error),
      sampleIndex: site,
    });
    return null;
  });
}

export function recordShadowComparison(
  env: object,
  site: D1ReadSite,
  mismatches: string[],
  ids: { orgId?: string | null; userId?: string | null; workspaceId?: string | null } = {},
): void {
  const flags = env as D1ReadFlagEnv;
  if (mismatches.length === 0) {
    recordObservabilityEvent(flags, {
      event: "d1_shadow_match",
      component: "d1_read_shadow",
      operation: site,
      ...ids,
      sampleIndex: site,
    });
    return;
  }
  const fields = Array.from(new Set(mismatches));
  for (const field of fields.slice(0, MAX_MISMATCH_EVENTS)) {
    recordObservabilityEvent(flags, {
      event: "d1_shadow_mismatch",
      severity: "warn",
      component: "d1_read_shadow",
      operation: site,
      status: field,
      count: mismatches.length,
      ...ids,
      sampleIndex: `${site}.${field}`,
    });
  }
}

/** Field-level diff of two records keyed by id; returns "field" names (and "missing"/"extra"). */
export function diffById<T extends Record<string, unknown>>(
  primary: Map<string, T>,
  mirror: Map<string, T>,
  fields: Array<keyof T & string>,
): string[] {
  const mismatches: string[] = [];
  for (const [id, row] of primary) {
    const other = mirror.get(id);
    if (!other) {
      mismatches.push("missing");
      continue;
    }
    for (const field of fields) {
      if (normalize(row[field]) !== normalize(other[field])) mismatches.push(field);
    }
  }
  for (const id of mirror.keys()) {
    if (!primary.has(id)) mismatches.push("extra");
  }
  return mismatches;
}

function normalize(value: unknown): unknown {
  if (value === undefined || value === "") return null;
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}
