import type { OrgDO, UserDO } from './auth.js';
import {
  type AppIndexDatabase,
  getAppIndexDatabase,
} from './app-index-db.js';

type AdminIndexBootstrapEnv = {
  APP_DB?: D1Database;
  APP_KV: KVNamespace;
  EMAIL_TO_USER: KVNamespace;
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
};

const APP_INDEX_BOOTSTRAP_LOCK_KEY = 'admin_index_d1_bootstrap_lock';
const APP_INDEX_BOOTSTRAP_IN_PROGRESS = 'syncing';
const APP_INDEX_BOOTSTRAP_LOCK_TTL_SECONDS = 300;
const APP_INDEX_BOOTSTRAP_WAIT_MS = 10_000;
const APP_INDEX_BOOTSTRAP_POLL_MS = 200;
const ORG_INDEX_PREFIX = 'org_index:';

type AdminIndexBootstrapOptions = {
  waitMs?: number;
  pollMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectAllUserIds(env: AdminIndexBootstrapEnv): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const list = await env.EMAIL_TO_USER.list({ prefix: 'email:', cursor });
    for (const key of list.keys) {
      keys.push(key.name);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  const userIds = await Promise.all(keys.map((key) => env.EMAIL_TO_USER.get(key)));
  return Array.from(
    new Set(
      userIds.filter(
        (id): id is string => id !== null && !id.startsWith('{'),
      ),
    ),
  );
}

async function collectOrgIdsFromUsers(
  env: AdminIndexBootstrapEnv,
  userIds: string[],
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userStub = env.USER.get(env.USER.idFromName(userId));
        const orgs = await userStub.getOrgs();
        for (const org of orgs) {
          orgIds.add(org.org_id);
        }
      } catch {
        // Stale email mappings can point at deleted users.
      }
    }),
  );
  return orgIds;
}

async function collectOrgIdsFromOrgIndex(
  env: AdminIndexBootstrapEnv,
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const list = await env.APP_KV.list({ prefix: ORG_INDEX_PREFIX, cursor });
    for (const key of list.keys) {
      const orgId = key.name.slice(ORG_INDEX_PREFIX.length);
      if (orgId) orgIds.add(orgId);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  return orgIds;
}

async function waitForAdminIndexBootstrap(
  appIndex: AppIndexDatabase,
  options: AdminIndexBootstrapOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const waitMs = options.waitMs ?? APP_INDEX_BOOTSTRAP_WAIT_MS;
  const pollMs = options.pollMs ?? APP_INDEX_BOOTSTRAP_POLL_MS;
  while (Date.now() - startedAt < waitMs) {
    if (await appIndex.isBootstrapComplete()) {
      return;
    }
    await sleep(pollMs);
  }
}

/**
 * Mirror one Durable Object's facts into D1 through its own outbox: queue a
 * full resync and drain it now. The DO stamps every row with its mirror
 * version, so this can never overwrite a newer write the way a direct walk of
 * DO reads could.
 */
async function resyncDurableObjectNow(stub: {
  requestMirrorResync(): Promise<unknown>;
  drainMirrorNow(): Promise<{ failed: number; remaining: number }>;
}): Promise<void> {
  await stub.requestMirrorResync();
  const result = await stub.drainMirrorNow();
  if (result.failed > 0 || result.remaining > 0) {
    throw new Error(
      `D1 mirror drain incomplete (failed=${result.failed}, remaining=${result.remaining})`,
    );
  }
}

async function bootstrapAdminIndexFromDurableObjects(
  env: AdminIndexBootstrapEnv,
  appIndex: AppIndexDatabase,
): Promise<void> {
  const userIds = await collectAllUserIds(env);

  for (const userId of userIds) {
    await resyncDurableObjectNow(env.USER.get(env.USER.idFromName(userId)));
  }

  const [membershipOrgIds, indexedOrgIds] = await Promise.all([
    collectOrgIdsFromUsers(env, userIds),
    collectOrgIdsFromOrgIndex(env),
  ]);
  const orgIds = new Set([...membershipOrgIds, ...indexedOrgIds]);

  for (const orgId of orgIds) {
    await resyncDurableObjectNow(env.ORG.get(env.ORG.idFromName(orgId)));
  }

  await appIndex.markBootstrapComplete();
  await appIndex.markThreadsIndexBackfillComplete();
}

async function acquireAdminIndexBootstrapLock(
  env: AdminIndexBootstrapEnv,
): Promise<boolean> {
  const bootstrapLock = await env.APP_KV.get(APP_INDEX_BOOTSTRAP_LOCK_KEY);
  if (bootstrapLock === APP_INDEX_BOOTSTRAP_IN_PROGRESS) {
    return false;
  }

  await env.APP_KV.put(
    APP_INDEX_BOOTSTRAP_LOCK_KEY,
    APP_INDEX_BOOTSTRAP_IN_PROGRESS,
    { expirationTtl: APP_INDEX_BOOTSTRAP_LOCK_TTL_SECONDS },
  );
  return true;
}

export async function ensureAdminIndexReady(
  env: AdminIndexBootstrapEnv,
  options: AdminIndexBootstrapOptions = {},
): Promise<void> {
  const appIndex = getAppIndexDatabase(env);
  if (!appIndex) {
    throw new Error('APP_DB binding is not configured');
  }

  await appIndex.ensureSchema();
  if (await appIndex.isBootstrapComplete()) {
    // Schema-version backfills must run through an explicit, checkpointed job.
    // Starting the full-platform rebuild here ties it to every admin request;
    // an OOM leaves the marker set and restarts the rebuild after the KV lock
    // expires, repeatedly killing the request isolate.
    return;
  }

  let ownsLock = await acquireAdminIndexBootstrapLock(env);
  if (!ownsLock) {
    await waitForAdminIndexBootstrap(appIndex, options);
    if (await appIndex.isBootstrapComplete()) {
      return;
    }
    ownsLock = await acquireAdminIndexBootstrapLock(env);
    if (!ownsLock) {
      throw new Error('Admin index bootstrap is still in progress; retry shortly');
    }
  }

  try {
    if (!(await appIndex.isBootstrapComplete())) {
      await bootstrapAdminIndexFromDurableObjects(env, appIndex);
    }
  } finally {
    await env.APP_KV.delete(APP_INDEX_BOOTSTRAP_LOCK_KEY);
  }
}

// ---------------------------------------------------------------------------
// Resumable D1 mirror backfill
// ---------------------------------------------------------------------------
//
// Walks every UserDO (EMAIL_TO_USER) and then every OrgDO (org_index: in
// APP_KV) and asks each to re-queue everything it owns in its D1 mirror
// outbox; each DO's alarm then drains it with versioned upserts. The walk
// cursor lives in app_index_metadata, so the job survives restarts and is
// advanced by the cron trigger (or by POST /api/admin/d1-mirror/backfill
// {"action":"step"} where there is no cron, e.g. self-host).

const MIRROR_BACKFILL_STATE_KEY = 'd1_mirror_backfill';
const MIRROR_BACKFILL_PAGE_SIZE = 25;

export type MirrorBackfillPhase = 'users' | 'orgs' | 'orphan_orgs' | 'orphan_users' | 'done';

export interface MirrorBackfillState {
  status: 'idle' | 'running' | 'done';
  phase: MirrorBackfillPhase;
  cursor: string | null;
  users_queued: number;
  orgs_queued: number;
  /** D1 orgs/users whose owning DO no longer exists, purged from D1. */
  orphan_orgs_purged: number;
  orphan_users_purged: number;
  /** Count and list orphan candidates without deleting anything. */
  dry_run: boolean;
  /** First MAX_LISTED_CANDIDATES orphan ids found (purged, or would be in a dry run). */
  orphan_org_candidates: string[];
  orphan_user_candidates: string[];
  errors: number;
  last_error: string | null;
  started_at: number | null;
  updated_at: number | null;
  finished_at: number | null;
}

const IDLE_BACKFILL_STATE: MirrorBackfillState = {
  status: 'idle',
  phase: 'users',
  cursor: null,
  users_queued: 0,
  orgs_queued: 0,
  orphan_orgs_purged: 0,
  orphan_users_purged: 0,
  dry_run: false,
  orphan_org_candidates: [],
  orphan_user_candidates: [],
  errors: 0,
  last_error: null,
  started_at: null,
  updated_at: null,
  finished_at: null,
};

type MirrorBackfillEnv = Pick<AdminIndexBootstrapEnv, 'APP_DB' | 'APP_KV' | 'EMAIL_TO_USER' | 'USER' | 'ORG'>;

function requireAppIndex(env: MirrorBackfillEnv): AppIndexDatabase {
  const appIndex = getAppIndexDatabase(env);
  if (!appIndex) throw new Error('APP_DB binding is not configured');
  return appIndex;
}

export async function getMirrorBackfillState(env: MirrorBackfillEnv): Promise<MirrorBackfillState> {
  const raw = await requireAppIndex(env).getMetadata(MIRROR_BACKFILL_STATE_KEY);
  if (!raw) return { ...IDLE_BACKFILL_STATE };
  try {
    return { ...IDLE_BACKFILL_STATE, ...(JSON.parse(raw) as Partial<MirrorBackfillState>) };
  } catch {
    return { ...IDLE_BACKFILL_STATE };
  }
}

async function saveMirrorBackfillState(env: MirrorBackfillEnv, state: MirrorBackfillState): Promise<void> {
  await requireAppIndex(env).setMetadata(MIRROR_BACKFILL_STATE_KEY, JSON.stringify(state));
}

/** Start (or restart from the beginning) the backfill. */
export async function startMirrorBackfill(
  env: MirrorBackfillEnv,
  options: { orphansOnly?: boolean; dryRun?: boolean } = {},
): Promise<MirrorBackfillState> {
  const now = Date.now();
  const state: MirrorBackfillState = {
    ...IDLE_BACKFILL_STATE,
    status: 'running',
    dry_run: Boolean(options.dryRun),
    // The orphan cleanup alone skips the resync walk.
    phase: options.orphansOnly ? 'orphan_orgs' : 'users',
    started_at: now,
    updated_at: now,
  };
  await saveMirrorBackfillState(env, state);
  return state;
}

export async function resetMirrorBackfill(env: MirrorBackfillEnv): Promise<MirrorBackfillState> {
  const state = { ...IDLE_BACKFILL_STATE };
  await saveMirrorBackfillState(env, state);
  return state;
}

/**
 * Advance a running backfill by one page of DOs. Per-DO failures are counted
 * and skipped (the reconciler catches whatever they left behind); the cursor
 * only moves forward once the page has been attempted.
 */
export async function runMirrorBackfillStep(
  env: MirrorBackfillEnv,
  pageSize = MIRROR_BACKFILL_PAGE_SIZE,
): Promise<MirrorBackfillState> {
  const state = await getMirrorBackfillState(env);
  if (state.status !== 'running') return state;

  const recordError = (error: unknown) => {
    state.errors += 1;
    state.last_error = error instanceof Error ? error.message : String(error);
  };

  if (state.phase === 'users') {
    const page = await env.EMAIL_TO_USER.list({
      prefix: 'email:',
      cursor: state.cursor ?? undefined,
      limit: pageSize,
    });
    const userIds = new Set(
      (await Promise.all(page.keys.map((key) => env.EMAIL_TO_USER.get(key.name)))).filter(
        (id): id is string => id !== null && !id.startsWith('{'),
      ),
    );
    await Promise.all(
      [...userIds].map(async (userId) => {
        try {
          await env.USER.get(env.USER.idFromName(userId)).requestMirrorResync();
          state.users_queued += 1;
        } catch (error) {
          recordError(error);
        }
      }),
    );
    if (page.list_complete || !page.cursor) {
      state.phase = 'orgs';
      state.cursor = null;
    } else {
      state.cursor = page.cursor;
    }
  } else if (state.phase === 'orgs') {
    const page = await env.APP_KV.list({
      prefix: ORG_INDEX_PREFIX,
      cursor: state.cursor ?? undefined,
      limit: pageSize,
    });
    await Promise.all(
      page.keys.map(async (key) => {
        const orgId = key.name.slice(ORG_INDEX_PREFIX.length);
        if (!orgId) return;
        try {
          await env.ORG.get(env.ORG.idFromName(orgId)).requestMirrorResync();
          state.orgs_queued += 1;
        } catch (error) {
          recordError(error);
        }
      }),
    );
    if (page.list_complete || !page.cursor) {
      state.phase = 'orphan_orgs';
      state.cursor = null;
    } else {
      state.cursor = page.cursor;
    }
  } else if (state.phase === 'orphan_orgs') {
    // D1 rows of orgs whose OrgDO is gone (hard-deleted before the purge
    // existed): purge them so they do not show up as permanent drift.
    const appIndex = requireAppIndex(env);
    const orgIds = await appIndex.listMirroredOrgIds(state.cursor ?? '', pageSize);
    await Promise.all(
      orgIds.map(async (orgId) => {
        try {
          if (!(await isOrphanedOrg(env, appIndex, orgId))) return;
          noteCandidate(state.orphan_org_candidates, orgId);
          if (!state.dry_run) await appIndex.purgeMirroredOrg(orgId);
          state.orphan_orgs_purged += 1;
        } catch (error) {
          recordError(error);
        }
      }),
    );
    if (orgIds.length < pageSize) {
      state.phase = 'orphan_users';
      state.cursor = null;
    } else {
      state.cursor = orgIds[orgIds.length - 1]!;
    }
  } else if (state.phase === 'orphan_users') {
    const appIndex = requireAppIndex(env);
    const userIds = await appIndex.listMirroredUserIds(state.cursor ?? '', pageSize);
    await Promise.all(
      userIds.map(async (userId) => {
        try {
          if (!(await isOrphanedUser(env, appIndex, userId))) return;
          noteCandidate(state.orphan_user_candidates, userId);
          if (!state.dry_run) {
            await appIndex.applyAdminEvent({ type: 'user_delete', payload: { id: userId } });
          }
          state.orphan_users_purged += 1;
        } catch (error) {
          recordError(error);
        }
      }),
    );
    if (userIds.length < pageSize) {
      state.phase = 'done';
      state.cursor = null;
    } else {
      state.cursor = userIds[userIds.length - 1]!;
    }
  }

  const now = Date.now();
  state.updated_at = now;
  if (state.phase === 'done') {
    state.status = 'done';
    state.finished_at = now;
  }
  await saveMirrorBackfillState(env, state);
  return state;
}

/** Advance a running backfill for up to `budgetMs` (cron). */
export async function runMirrorBackfillFor(env: MirrorBackfillEnv, budgetMs: number): Promise<MirrorBackfillState> {
  const deadline = Date.now() + budgetMs;
  let state = await getMirrorBackfillState(env);
  while (state.status === 'running' && Date.now() < deadline) {
    state = await runMirrorBackfillStep(env);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Orphan checks (shared with the reconciler's do_missing repair)
// ---------------------------------------------------------------------------

const MAX_LISTED_CANDIDATES = 50;
/** An org with D1 member/workspace/thread activity this recent is never purged. */
export const ORPHAN_ORG_MIN_QUIET_MS = 30 * 24 * 60 * 60 * 1000;

function noteCandidate(list: string[], id: string): void {
  if (list.length < MAX_LISTED_CANDIDATES) list.push(id);
}

type OrphanCheckEnv = Pick<AdminIndexBootstrapEnv, 'EMAIL_TO_USER' | 'USER' | 'ORG'>;

/**
 * An org's D1 rows are orphaned only when its OrgDO holds no org AND D1 shows
 * no membership, workspace or thread activity in the last 30 days.
 */
export async function isOrphanedOrg(
  env: OrphanCheckEnv,
  appIndex: AppIndexDatabase,
  orgId: string,
  now = Date.now(),
): Promise<boolean> {
  if (await env.ORG.get(env.ORG.idFromName(orgId)).mirrorOrgExists()) return false;
  const recent = await appIndex.getOrgActivitySince(orgId, now - ORPHAN_ORG_MIN_QUIET_MS);
  return recent.members === 0 && recent.workspaces === 0 && recent.threads === 0;
}

/**
 * A D1 user is orphaned only when three sources agree it is gone: its UserDO
 * has no profile, the login index (EMAIL_TO_USER, prefixed or legacy key) does
 * not map its email to it, and D1 holds no org membership for it. Purging
 * writes deleted_users, which permanently blocks re-mirroring, so any doubt
 * keeps the row.
 */
export async function isOrphanedUser(
  env: OrphanCheckEnv,
  appIndex: AppIndexDatabase,
  userId: string,
): Promise<boolean> {
  if (await env.USER.get(env.USER.idFromName(userId)).mirrorUserExists()) return false;
  const evidence = await appIndex.getUserOrphanEvidence(userId);
  if (evidence.memberships > 0) return false;
  const email = evidence.email?.trim().toLowerCase();
  if (email) {
    const [prefixed, legacy] = await Promise.all([
      env.EMAIL_TO_USER.get(`email:${email}`),
      env.EMAIL_TO_USER.get(email),
    ]);
    if (prefixed === userId || legacy === userId) return false;
  }
  return true;
}
