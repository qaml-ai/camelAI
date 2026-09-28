// Drift reconciler for the DO -> D1 identity mirror.
//
// Each run samples orgs and users from D1, asks the owning Durable Object for
// the current state of every row it mirrors (org, members, invitations,
// workspaces, workspace access overrides, apps, a sample of threads), and
// diffs it against D1 field by field, in both directions. Rows still queued
// in the DO's outbox are in flight, not drift, and are skipped.
//
// Analytics Engine (OBSERVABILITY_EVENTS, dataset chiridion_observability):
//   d1_drift          blob4 (operation) = entity, blob5 (status) = field,
//                     blob11/12 = org/user id, index1 = "<entity>.<field>"
//   d1_reconcile_ok   one per entity row that matched; operation = entity
//   d1_reconcile_run  one per run; count = rows compared, size = drifted rows
// A DO with drift is asked to resync, so drift self-heals but is still counted.
// Phase-2 gate: zero d1_drift for 7 days.

import type { AdminEventType } from "./admin-index-types";
import { THREAD_LIST_PREVIEW_LENGTH, getAppIndexDatabase } from "./app-index-db";
import { recordObservabilityEvent, type ObservabilityEnv } from "./observability";
import { truncateThreadPreviewText } from "../../../src/lib/thread-preview";
import type { OrgDO, UserDO } from "./auth";

type ReconcileEnv = ObservabilityEnv & {
  APP_DB?: D1Database;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  D1_RECONCILE_SAMPLE_PER_DAY?: string;
};

type Row = Record<string, unknown>;

export interface DriftFinding {
  entity: string;
  key: string;
  field: string;
  orgId?: string | null;
  userId?: string | null;
}

export interface ReconcileResult {
  compared: number;
  drift: DriftFinding[];
}

const DEFAULT_SAMPLE_PER_DAY = 200;
const THREAD_SAMPLE_PER_ORG = 20;

function norm(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function diffFields(expected: Row, actual: Row): string[] {
  return Object.keys(expected).filter((field) => norm(expected[field]) !== norm(actual[field]));
}

/** What the D1 row for an upsert event should hold, in D1's representation. */
function expectedRow(event: AdminEventType): Row | null {
  const p = event.payload as Row & { avatar?: { color?: string; content?: string } };
  switch (event.type) {
    case "user_upsert":
      return {
        email: p.email ?? "",
        name: p.name ?? null,
        avatar_color: p.avatar?.color ?? "",
        avatar_content: p.avatar?.content ?? "",
        is_superuser: Boolean(p.is_superuser),
        is_orphaned: Boolean(p.is_orphaned),
        org_count: p.org_count,
        email_verified_at: p.email_verified_at ?? null,
        orphaned_at: p.orphaned_at ?? null,
        ...(p.signup_ip ? { signup_ip: String(p.signup_ip).trim().toLowerCase() } : {}),
      };
    case "org_upsert":
      return {
        name: p.name,
        ...(typeof p.slug === "string" && p.slug.trim() ? { slug: p.slug } : {}),
        archived: Boolean(p.archived),
        billing_status: p.billing_status ?? null,
        billing_plan: p.billing_plan ?? null,
        member_count: p.member_count,
        workspace_count: p.workspace_count,
      };
    case "org_llm_provider_update":
      return { llm_provider: p.provider ?? null };
    case "workspace_upsert":
      return {
        name: p.name,
        org_id: p.org_id,
        description: p.description ?? null,
        avatar_color: p.avatar?.color ?? null,
        avatar_content: p.avatar?.content ?? null,
        created_by: p.created_by ?? null,
        archived: Boolean(p.archived),
        archived_at: p.archived_at ?? null,
        archived_by: p.archived_by ?? null,
        integration_count: p.integration_count,
        email_handle: p.email_handle ?? null,
      };
    case "org_membership_upsert":
      return {
        role: p.role,
        joined_at: p.joined_at,
        workspace_access_default: p.workspace_access_default ?? null,
      };
    case "workspace_member_upsert":
      return { org_id: p.org_id, access_level: p.access_level };
    case "invitation_upsert":
      return { email: p.email, role: p.role, expires_at: p.expires_at };
    case "app_upsert":
      return {
        script_name: p.script_name,
        workspace_id: p.workspace_id,
        created_by: p.created_by ?? null,
        updated_at: p.updated_at,
        is_public: Boolean(p.is_public),
        preview_status: p.preview_status ?? null,
        project_id: p.project_id ?? null,
      };
    case "thread_upsert":
      return {
        title: p.title ?? null,
        model: p.model ?? "sonnet",
        workspace_id: p.workspace_id,
        created_by: p.created_by ?? null,
        updated_at: p.updated_at,
        user_message_count: p.user_message_count ?? null,
        source: p.source ?? null,
        channel_kind: p.channel_kind ?? null,
        first_user_message_preview: truncateThreadPreviewText(
          typeof p.first_user_message === "string" ? p.first_user_message : null,
          THREAD_LIST_PREVIEW_LENGTH,
        ),
        last_user_message_preview: truncateThreadPreviewText(
          typeof p.last_user_message === "string" ? p.last_user_message : null,
          THREAD_LIST_PREVIEW_LENGTH,
        ),
        last_assistant_completed_at: p.last_assistant_completed_at ?? null,
        last_assistant_summary_status: p.last_assistant_summary_status ?? null,
      };
    default:
      return null;
  }
}

const ENTITY_OF_KIND: Record<string, string> = {
  org: "org",
  org_membership: "org_membership",
  invitation: "invitation",
  workspace: "workspace",
  workspace_member: "workspace_member",
  app: "app",
  thread: "thread",
};

async function allRows(db: D1Database, query: string, ...binds: unknown[]): Promise<Row[]> {
  return (await db.prepare(query).bind(...binds).all<Row>()).results ?? [];
}

/** Diff one org's DO state against D1. Exported for tests. */
export async function reconcileOrg(env: ReconcileEnv, orgId: string): Promise<ReconcileResult> {
  const db = env.APP_DB!;
  const drift: DriftFinding[] = [];
  const d1ThreadIds = (
    await allRows(db, "SELECT id FROM threads WHERE org_id = ? ORDER BY RANDOM() LIMIT ?", orgId, THREAD_SAMPLE_PER_ORG)
  ).map((row) => String(row.id));
  const stub = env.ORG.get(env.ORG.idFromName(orgId));
  const snapshot = await stub.getMirrorReconcileSnapshot({
    threadIds: d1ThreadIds,
    threadSample: THREAD_SAMPLE_PER_ORG,
  });
  if (!snapshot.orgId) {
    drift.push({ entity: "org", key: `org:${orgId}`, field: "do_missing", orgId });
    return { compared: 1, drift };
  }

  const threadIds = snapshot.entities
    .filter((entity) => entity.key.startsWith("thread:"))
    .map((entity) => entity.key.slice("thread:".length));
  const [orgRows, memberRows, invitationRows, workspaceRows, workspaceMemberRows, appRows, threadRows] =
    await Promise.all([
      allRows(db, "SELECT * FROM orgs WHERE id = ?", orgId),
      allRows(db, "SELECT * FROM org_memberships WHERE org_id = ?", orgId),
      allRows(db, "SELECT * FROM invitations WHERE org_id = ?", orgId),
      allRows(db, "SELECT * FROM workspaces WHERE org_id = ?", orgId),
      allRows(db, "SELECT * FROM workspace_members WHERE org_id = ?", orgId),
      allRows(db, "SELECT * FROM apps WHERE org_id = ?", orgId),
      threadIds.length > 0
        ? allRows(db, `SELECT * FROM threads WHERE id IN (${threadIds.map(() => "?").join(",")})`, ...threadIds)
        : Promise.resolve([]),
    ]);

  // D1 rows keyed exactly like the DO's outbox keys.
  const d1 = new Map<string, Row>();
  for (const row of orgRows) d1.set("org:", row);
  for (const row of memberRows) d1.set(`org_membership:${row.user_id}`, row);
  for (const row of invitationRows) d1.set(`invitation:${row.id}`, row);
  for (const row of workspaceRows) d1.set(`workspace:${row.id}`, row);
  for (const row of workspaceMemberRows) d1.set(`workspace_member:${row.workspace_id}:${row.user_id}`, row);
  for (const row of appRows) d1.set(`app:${row.script_name}`, row);
  for (const row of threadRows) d1.set(`thread:${row.id}`, row);

  const pending = new Set(snapshot.pending);
  const seen = new Set<string>();
  let compared = 0;
  for (const { key, events } of snapshot.entities) {
    seen.add(key);
    if (pending.has(key) || events.length === 0) continue;
    const entity = ENTITY_OF_KIND[key.slice(0, key.indexOf(":"))] ?? "unknown";
    const row = d1.get(key);
    compared += 1;
    const isDelete = events.every((event) => event.type.endsWith("_delete"));
    const fields: string[] = [];
    if (isDelete) {
      if (row) fields.push("row_stale");
    } else if (!row) {
      fields.push("row_missing");
    } else {
      for (const event of events) {
        const expected = expectedRow(event);
        if (expected) fields.push(...diffFields(expected, row));
      }
    }
    for (const field of fields) drift.push({ entity, key, field, orgId });
    if (fields.length === 0) {
      recordObservabilityEvent(env, {
        event: "d1_reconcile_ok",
        component: "d1_mirror_reconcile",
        operation: entity,
        orgId,
        sampleIndex: entity,
      });
    }
  }
  // Rows D1 still has that the DO no longer owns (threads are sampled, so only
  // the fully listed kinds are checked this way).
  for (const key of d1.keys()) {
    if (seen.has(key) || pending.has(key) || key.startsWith("thread:")) continue;
    compared += 1;
    drift.push({ entity: ENTITY_OF_KIND[key.slice(0, key.indexOf(":"))] ?? "unknown", key, field: "row_orphaned", orgId });
  }
  return { compared, drift };
}

/** Diff one user's DO state against D1. Exported for tests. */
export async function reconcileUser(env: ReconcileEnv, userId: string): Promise<ReconcileResult> {
  const db = env.APP_DB!;
  const deleted = await db.prepare("SELECT 1 FROM deleted_users WHERE id = ?").bind(userId).first();
  if (deleted) return { compared: 0, drift: [] };
  const snapshot = await env.USER.get(env.USER.idFromName(userId)).getMirrorReconcileSnapshot();
  if (snapshot.pending.includes("user:self")) return { compared: 0, drift: [] };
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<Row>();
  const drift: DriftFinding[] = [];
  const upsert = snapshot.events.find((event) => event.type === "user_upsert");
  if (!upsert) {
    if (row) drift.push({ entity: "user", key: `user:${userId}`, field: "do_missing", userId });
  } else if (!row) {
    drift.push({ entity: "user", key: `user:${userId}`, field: "row_missing", userId });
  } else {
    for (const field of diffFields(expectedRow(upsert)!, row)) {
      drift.push({ entity: "user", key: `user:${userId}`, field, userId });
    }
  }
  if (drift.length === 0) {
    recordObservabilityEvent(env, {
      event: "d1_reconcile_ok",
      component: "d1_mirror_reconcile",
      operation: "user",
      userId,
      sampleIndex: "user",
    });
  }
  return { compared: 1, drift };
}

function samplePerRun(env: ReconcileEnv, runsPerDay: number): number {
  const perDay = Number(env.D1_RECONCILE_SAMPLE_PER_DAY ?? DEFAULT_SAMPLE_PER_DAY);
  const safePerDay = Number.isFinite(perDay) && perDay >= 0 ? perDay : DEFAULT_SAMPLE_PER_DAY;
  return Math.ceil(safePerDay / runsPerDay);
}

/**
 * Sample `D1_RECONCILE_SAMPLE_PER_DAY / runsPerDay` orgs and as many users,
 * diff them, emit AE events and resync every DO that drifted.
 */
export async function runMirrorReconcile(
  env: ReconcileEnv,
  options: { runsPerDay?: number; sample?: number } = {},
): Promise<ReconcileResult> {
  const appIndex = getAppIndexDatabase(env);
  if (!appIndex || !env.APP_DB) return { compared: 0, drift: [] };
  await appIndex.ensureSchema();
  const sample = options.sample ?? samplePerRun(env, options.runsPerDay ?? 24);
  const startedAt = Date.now();
  const [orgIds, userIds] = await Promise.all([
    allRows(env.APP_DB, "SELECT id FROM orgs WHERE archived = 0 ORDER BY RANDOM() LIMIT ?", sample),
    allRows(env.APP_DB, "SELECT id FROM users ORDER BY RANDOM() LIMIT ?", sample),
  ]);

  const total: ReconcileResult = { compared: 0, drift: [] };
  const driftedOrgs = new Set<string>();
  const driftedUsers = new Set<string>();
  const run = async (kind: "org" | "user", id: string) => {
    try {
      const result = kind === "org" ? await reconcileOrg(env, id) : await reconcileUser(env, id);
      total.compared += result.compared;
      total.drift.push(...result.drift);
      if (result.drift.length > 0) (kind === "org" ? driftedOrgs : driftedUsers).add(id);
    } catch (error) {
      recordObservabilityEvent(env, {
        event: "d1_reconcile_error",
        severity: "warn",
        component: "d1_mirror_reconcile",
        operation: kind,
        orgId: kind === "org" ? id : null,
        userId: kind === "user" ? id : null,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  };
  for (const row of orgIds) await run("org", String(row.id));
  for (const row of userIds) await run("user", String(row.id));

  for (const finding of total.drift) {
    recordObservabilityEvent(env, {
      event: "d1_drift",
      severity: "warn",
      component: "d1_mirror_reconcile",
      operation: finding.entity,
      status: finding.field,
      orgId: finding.orgId ?? null,
      userId: finding.userId ?? null,
      path: finding.key,
      sampleIndex: `${finding.entity}.${finding.field}`,
    });
  }
  // Self-heal: queue a full re-mirror of every DO that drifted.
  await Promise.allSettled([
    ...[...driftedOrgs].map((id) => env.ORG.get(env.ORG.idFromName(id)).requestMirrorResync()),
    ...[...driftedUsers].map((id) => env.USER.get(env.USER.idFromName(id)).requestMirrorResync()),
  ]);
  recordObservabilityEvent(env, {
    event: "d1_reconcile_run",
    component: "d1_mirror_reconcile",
    status: total.drift.length > 0 ? "drift" : "ok",
    count: total.compared,
    size: total.drift.length,
    durationMs: Date.now() - startedAt,
    sampleIndex: "d1_reconcile_run",
  });
  return total;
}
