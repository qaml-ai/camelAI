/**
 * Server-side auth-do functions that accept React Router AppLoadContext.
 * These functions wrap the auth-do module to use context-passed environment.
 */
import type { AppLoadContext } from "react-router";
import type {
  OrgRole,
  AdminThreadWithContext,
  WorkspaceAccessLevel,
} from "@/types";
import { getEnv, type CloudflareEnv } from "./cloudflare.server";
import { getAuthEnv } from "./auth-helpers";
import * as authDO from "./auth-do";
import { normalizeStoredThreadModel } from "./chat-do.server";
import {
  deleteDeployedAppRuntime,
  getDispatchScriptName,
} from "./deployed-app-delete.server";
import {
  getAppIndexDatabase,
  getAppIndexReadDatabase,
} from "../../workers/main/src/app-index-db";
import { ensureAdminIndexReady } from "../../workers/main/src/admin-index-bootstrap";
import {
  type BanRecord,
  type BanScope,
  getOrgBanById,
  getUserBanById,
  putBanRecord,
} from "../../workers/main/src/ban-list";

export { ensureAdminIndexReady } from "../../workers/main/src/admin-index-bootstrap";

// Helper: Collect all user IDs from KV
async function collectAllUserIds(env: CloudflareEnv): Promise<string[]> {
  const allKeys: string[] = [];
  let cursor: string | undefined;

  while (true) {
    const list = await env.EMAIL_TO_USER.list({ prefix: "email:", cursor });
    for (const key of list.keys) {
      allKeys.push(key.name);
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  const userIdResults = await Promise.all(
    allKeys.map((key) => env.EMAIL_TO_USER.get(key)),
  );
  return userIdResults.filter(
    (id): id is string => id !== null && !id.startsWith("{"),
  );
}

// Helper: Collect all org IDs from raw user membership rows, including archived orgs.
async function collectAllOrgIdsIncludingArchived(
  env: CloudflareEnv,
): Promise<Set<string>> {
  const authEnv = getAuthEnv(env);
  const userIds = await collectAllUserIds(env);
  const orgIds = new Set<string>();

  await Promise.all(
    userIds.map(async (userId) => {
      try {
        const userOrgs = await authEnv.USER.get(
          authEnv.USER.idFromName(userId),
        ).getOrgs();
        for (const org of userOrgs) {
          orgIds.add(org.org_id);
        }
      } catch {
        // User may not exist
      }
    }),
  );

  return orgIds;
}

async function collectOrgIdsFromOrgIndex(
  env: CloudflareEnv,
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const list = await env.APP_KV.list({ prefix: ORG_INDEX_PREFIX, cursor });
    for (const key of list.keys) {
      const orgId = key.name.slice(ORG_INDEX_PREFIX.length);
      if (orgId) {
        orgIds.add(orgId);
      }
    }
    if (list.list_complete || !list.cursor) break;
    cursor = list.cursor;
  }

  return orgIds;
}

const SCRIPT_PREFIX = "script:";
const SPEND_PREFIX = "spend:";
const ORG_INDEX_PREFIX = "org_index:";
const API_TOKEN_PREFIX = "tok_";
const SESSION_PREFIX = "session:";
const WORKER_SESSION_PREFIX = "worker_session:";
const WORKER_AUTH_STATE_PREFIX = "wauth_state:";
const WORKER_AUTH_TOKEN_PREFIX = "wauth_token:";
const PREVIEW_PREFIX = "app-previews/";
const ORG_MEMBERSHIP_PROBE_CONCURRENCY = 20;
const ORG_MEMBERSHIP_MUTATION_CONCURRENCY = 8;
const BAN_PURGE_JOB_PREFIX = "ban_purge_job:";

export interface BanPurgeJobRecord {
  id: string;
  scope: BanScope;
  target_id: string;
  reason: string;
  created_at: number;
  created_by: string;
  status: "pending" | "running" | "completed" | "failed";
  completed_at: number | null;
  error: string | null;
}

function getBanPurgeJobKey(jobId: string): string {
  return `${BAN_PURGE_JOB_PREFIX}${jobId}`;
}

async function saveBanPurgeJob(
  env: CloudflareEnv,
  job: BanPurgeJobRecord,
): Promise<void> {
  await env.APP_KV.put(getBanPurgeJobKey(job.id), JSON.stringify(job));
}

async function getBanRecordByScope(
  env: CloudflareEnv,
  scope: BanScope,
  targetId: string,
): Promise<BanRecord | null> {
  return scope === "user"
    ? getUserBanById(env.APP_KV, targetId)
    : getOrgBanById(env.APP_KV, targetId);
}

async function updateBanRecordPurgeStatus(
  env: CloudflareEnv,
  scope: BanScope,
  targetId: string,
  update: Partial<
    Pick<
      BanRecord,
      | "purge_status"
      | "purge_job_id"
      | "purge_started_at"
      | "purge_completed_at"
      | "purge_error"
    >
  >,
): Promise<void> {
  const existing = await getBanRecordByScope(env, scope, targetId);
  if (!existing) return;
  await putBanRecord(env.APP_KV, {
    ...existing,
    ...update,
  });
}

function parseJsonSafely(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function sanitizeStorageName(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 20) || "x"
  );
}

function isMissingRpcMethodError(error: unknown, methodName: string): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes(`does not implement "${methodName}"`)
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function deleteKvEntriesWithPrefix(
  kv: KVNamespace,
  prefix: string,
  shouldDelete: (key: string, value: string | null) => boolean,
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  while (true) {
    const listed = await kv.list({ prefix, cursor });
    const keys = listed.keys.map((entry) => entry.name);
    if (keys.length > 0) {
      const values = await Promise.all(keys.map((key) => kv.get(key)));
      const keysToDelete: string[] = [];

      for (let index = 0; index < keys.length; index += 1) {
        if (shouldDelete(keys[index], values[index])) {
          keysToDelete.push(keys[index]);
        }
      }

      await Promise.all(keysToDelete.map((key) => kv.delete(key)));
      deleted += keysToDelete.length;
    }

    if (listed.list_complete || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
}

async function collectOrgIdsForUserFromKvPrefix(
  kv: KVNamespace,
  prefix: string,
  userId: string,
): Promise<Set<string>> {
  const orgIds = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const listed = await kv.list({ prefix, cursor });
    const keys = listed.keys.map((entry) => entry.name);
    if (keys.length > 0) {
      const values = await Promise.all(keys.map((key) => kv.get(key)));
      for (const value of values) {
        const parsed = parseJsonSafely(value);
        if (parsed?.user_id !== userId) {
          continue;
        }
        if (typeof parsed?.org_id === "string" && parsed.org_id.length > 0) {
          orgIds.add(parsed.org_id);
        }
      }
    }

    if (listed.list_complete || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return orgIds;
}

async function deleteR2Prefix(
  bucket: R2Bucket,
  prefix: string,
): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;

  while (true) {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await Promise.all(listed.objects.map((obj) => bucket.delete(obj.key)));
      deleted += listed.objects.length;
    }

    if (!listed.truncated || !listed.cursor) {
      break;
    }
    cursor = listed.cursor;
  }

  return deleted;
}

// Admin overview functions
function getAdminIndex(env: CloudflareEnv) {
  const appIndex = getAppIndexReadDatabase(env);
  if (!appIndex) {
    throw new Error("APP_DB binding is not configured");
  }
  return appIndex as any;
}

function normalizeAdminThreadModel<T extends AdminThreadWithContext>(
  thread: T,
): T {
  const { model } = normalizeStoredThreadModel(thread.model);
  return { ...thread, model } as T;
}

export async function adminGetThreadContextById(
  context: AppLoadContext,
  threadId: string,
): Promise<AdminThreadWithContext | null> {
  const env = getEnv(context);
  await ensureAdminIndexReady(env);
  const thread = (await getAdminIndex(env).getThreadContextById(
    threadId,
  )) as AdminThreadWithContext | null;
  return thread ? normalizeAdminThreadModel(thread) : null;
}

export interface AdminHardDeleteOrgResult {
  deleted_workspaces: number;
  deleted_apps: number;
  removed_memberships: number;
  warnings: string[];
}

/**
 * Permanently delete an organization and all related records.
 * This is superuser-only and intended for test account resets.
 */
export async function hardDeleteAdminOrgWithEnv(
  env: CloudflareEnv,
  orgId: string,
  actorId = "system-admin",
): Promise<AdminHardDeleteOrgResult> {
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const warnings: string[] = [];

  const [orgInfo, workspaceRows, workerScripts] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getWorkspaces(),
    orgStub.listWorkerScripts(),
  ]);

  if (!orgInfo) {
    throw new Error("Organization not found");
  }

  const workspaceIdSet = new Set(
    workspaceRows.map((workspace) => workspace.id),
  );
  for (const script of workerScripts) {
    workspaceIdSet.add(script.workspace_id);
  }
  const workspaceIds = Array.from(workspaceIdSet);
  const scriptNames = workerScripts.map((script) => script.script_name);

  // Delete deployed dispatch scripts first to avoid orphaned public apps.
  if (scriptNames.length > 0) {
    const failedDeletes: string[] = [];
    await Promise.all(
      scriptNames.map(async (scriptName) => {
        try {
          await deleteDeployedAppRuntime(env, {
            scriptName,
            orgSlug: orgInfo.slug,
          });
        } catch {
          failedDeletes.push(scriptName);
        }
      }),
    );

    if (failedDeletes.length > 0) {
      throw new Error(
        `Failed to delete ${failedDeletes.length} dispatch script(s): ${failedDeletes.slice(0, 3).join(", ")}`,
      );
    }
  }

  // Hard-delete each WorkspaceDO. Project VM lifecycle is owned by the
  // external project runtime service, not this app worker.
  for (const workspaceId of workspaceIds) {
    const workspaceStub = authEnv.WORKSPACE.get(
      authEnv.WORKSPACE.idFromName(workspaceId),
    );
    try {
      await workspaceStub.hardDeleteWorkspace(actorId);
    } catch (error) {
      if (isMissingRpcMethodError(error, "hardDeleteWorkspace")) {
        throw new Error(
          "Workspace Durable Object is running old code (missing hardDeleteWorkspace). Restart `bun run dev` or deploy the latest main worker, then retry delete.",
        );
      }
      throw error;
    }
  }

  // Remove org memberships from all users to prevent stale user->org links.
  const allUserIds = await collectAllUserIds(env);
  const membershipResults = await Promise.all(
    allUserIds.map(async (userId) => {
      const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
      const hasOrg = await userStub.hasOrg(orgId);
      if (!hasOrg) return false;

      await userStub.removeOrg(orgId);

      const remainingOrgs = await userStub.getOrgs();
      const isOrphaned = remainingOrgs.length === 0;
      await userStub.setOrphaned(isOrphaned);

      // For test-account reset flows, clear onboarding when a user has no orgs left.
      if (isOrphaned) {
        try {
          await authDO.resetOnboardingForUser(authEnv, userId);
        } catch (error) {
          warnings.push(
            `Failed to reset onboarding for user ${userId.slice(0, 8)}: ${toErrorMessage(error)}`,
          );
        }
      }

      return true;
    }),
  );
  const removedMemberships = membershipResults.filter(Boolean).length;

  // Finally, wipe org DO state and release slug ownership.
  try {
    await orgStub.hardDeleteOrg(actorId);
  } catch (error) {
    if (isMissingRpcMethodError(error, "hardDeleteOrg")) {
      throw new Error(
        "Organization Durable Object is running old code (missing hardDeleteOrg). Restart `bun run dev` or deploy the latest main worker, then retry delete.",
      );
    }
    throw error;
  }

  // Best-effort cleanup of related KV indexes and sessions.
  const dispatchNames = scriptNames.map(
    (scriptName) => getDispatchScriptName(scriptName, orgInfo.slug),
  );
  await Promise.all([
    authEnv.APP_KV.delete(`${SPEND_PREFIX}${orgId}`),
    ...dispatchNames.map((dispatchName) =>
      authEnv.APP_KV.delete(`${SCRIPT_PREFIX}${dispatchName}`),
    ),
  ]);

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      SCRIPT_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean script ownership index: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      API_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(`Failed to clean API tokens: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_STATE_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.required_org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean worker auth state: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean worker auth tokens: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.SESSIONS,
      SESSION_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(`Failed to clean user sessions: ${toErrorMessage(error)}`);
  }

  try {
    await deleteKvEntriesWithPrefix(
      authEnv.SESSIONS,
      WORKER_SESSION_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.org_id === orgId;
      },
    );
  } catch (error) {
    warnings.push(`Failed to clean worker sessions: ${toErrorMessage(error)}`);
  }

  // Best-effort cleanup of R2 artifacts (uploads/outputs/previews/workspace storage).
  try {
    await deleteR2Prefix(env.R2_BUCKET, `${PREVIEW_PREFIX}${orgId}/`);
  } catch (error) {
    warnings.push(
      `Failed to clean app previews in R2: ${toErrorMessage(error)}`,
    );
  }

  try {
    await deleteR2Prefix(env.R2_BUCKET, `${orgId}/`);
  } catch (error) {
    warnings.push(
      `Failed to clean workspace uploads/outputs in R2: ${toErrorMessage(error)}`,
    );
  }

  try {
    const orgSafe = sanitizeStorageName(orgId);
    for (const workspaceId of workspaceIds) {
      const wsSafe = sanitizeStorageName(workspaceId);
      await deleteR2Prefix(env.R2_BUCKET, `chiridion-${orgSafe}-${wsSafe}/`);
    }
  } catch (error) {
    warnings.push(
      `Failed to clean workspace storage in R2: ${toErrorMessage(error)}`,
    );
  }

  return {
    deleted_workspaces: workspaceIds.length,
    deleted_apps: scriptNames.length,
    removed_memberships: removedMemberships,
    warnings,
  };
}

// User hard delete
// ---------------------------------------------------------------------------

export interface AdminHardDeleteUserResult {
  removed_org_memberships: number;
  warnings: string[];
}

/**
 * Permanently delete a user and all related records.
 * This is superuser-only and intended for test account cleanup.
 *
 * Steps:
 *  1. Fetch user profile + OAuth providers for cleanup key discovery.
 *  2. Build org probe candidates from org registry + user-scoped hints,
 *     and backfill missing org registry entries from legacy membership data.
 *  3. Fail early if the user still owns any organizations.
 *  4. Verify UserDO hard-delete capability before cross-DO mutations.
 *  5. Remove user from every org membership found in OrgDO.
 *  6. Wipe the UserDO Durable Object storage.
 *  7. Delete EMAIL_TO_USER KV entries (email + oauth provider keys).
 *  8. Delete user sessions from SESSIONS KV.
 *  9. Delete workspace-level ACL rows for this user across all org workspaces.
 *  10. Delete user-scoped worker auth one-time tokens from APP_KV.
 */
export async function hardDeleteAdminUserWithEnv(
  env: CloudflareEnv,
  userId: string,
  actorId = "system-admin",
): Promise<AdminHardDeleteUserResult> {
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const warnings: string[] = [];

  // 1. Fetch user data for cleanup keys.
  const [profile, oauthProviders, userOrgs] = await Promise.all([
    userStub.getProfile(),
    userStub.getOAuthProviders(),
    userStub.getOrgs(),
  ]);

  if (!profile) {
    throw new Error("User not found");
  }

  // 2. Build candidate org IDs without relying solely on UserDO<->OrgDO sync.
  const userScopedOrgHints = new Set<string>(userOrgs.map((org) => org.org_id));
  const [
    sessionOrgHints,
    workerSessionOrgHints,
    workerAuthTokenOrgHints,
    indexedOrgIds,
    legacyOrgIds,
  ] = await Promise.all([
    collectOrgIdsForUserFromKvPrefix(authEnv.SESSIONS, SESSION_PREFIX, userId),
    collectOrgIdsForUserFromKvPrefix(
      authEnv.SESSIONS,
      WORKER_SESSION_PREFIX,
      userId,
    ),
    collectOrgIdsForUserFromKvPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_TOKEN_PREFIX,
      userId,
    ),
    collectOrgIdsFromOrgIndex(env),
    collectAllOrgIdsIncludingArchived(env),
  ]);

  for (const orgId of sessionOrgHints) userScopedOrgHints.add(orgId);
  for (const orgId of workerSessionOrgHints) userScopedOrgHints.add(orgId);
  for (const orgId of workerAuthTokenOrgHints) userScopedOrgHints.add(orgId);

  const missingIndexedOrgIds = Array.from(legacyOrgIds).filter(
    (orgId) => !indexedOrgIds.has(orgId),
  );
  if (missingIndexedOrgIds.length > 0) {
    try {
      await Promise.all(
        missingIndexedOrgIds.map((orgId) =>
          authEnv.APP_KV.put(`${ORG_INDEX_PREFIX}${orgId}`, "1"),
        ),
      );
      for (const orgId of missingIndexedOrgIds) {
        indexedOrgIds.add(orgId);
      }
    } catch (error) {
      warnings.push(
        `Failed to backfill org index entries: ${toErrorMessage(error)}`,
      );
    }
  }

  const allProbeOrgIds = new Set<string>(indexedOrgIds);
  for (const orgId of legacyOrgIds) {
    allProbeOrgIds.add(orgId);
  }
  for (const orgId of userScopedOrgHints) {
    allProbeOrgIds.add(orgId);
  }

  type OrgMembershipSnapshot = {
    org_id: string;
    role: OrgRole;
    workspace_access_default: WorkspaceAccessLevel;
    workspace_access_rows: Array<{
      workspaceId: string;
      accessLevel: WorkspaceAccessLevel;
    }>;
  };
  const orgMemberships: OrgMembershipSnapshot[] = [];
  const orgMembershipProbeErrors: string[] = [];
  const orgProbeResults = await mapWithConcurrency(
    Array.from(allProbeOrgIds),
    ORG_MEMBERSHIP_PROBE_CONCURRENCY,
    async (orgId) => {
      try {
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
        const [member, accessRows] = await Promise.all([
          orgStub.getMember(userId),
          orgStub.listWorkspaceAccessRows(),
        ]);
        if (!member) {
          return null;
        }
        return {
          org_id: orgId,
          role: member.role,
          workspace_access_default: member.workspace_access_default,
          workspace_access_rows: accessRows
            .filter((row) => row.user_id === userId)
            .map((row) => ({
              workspaceId: row.workspace_id,
              accessLevel: row.access_level,
            })),
        };
      } catch (error) {
        return `${orgId.slice(0, 8)}: ${toErrorMessage(error)}`;
      }
    },
  );

  for (const result of orgProbeResults) {
    if (!result) continue;
    if (typeof result === "string") {
      orgMembershipProbeErrors.push(result);
      continue;
    }
    orgMemberships.push(result);
  }
  if (orgMembershipProbeErrors.length > 0) {
    const preview = orgMembershipProbeErrors.slice(0, 3).join("; ");
    const suffix =
      orgMembershipProbeErrors.length > 3
        ? `; and ${orgMembershipProbeErrors.length - 3} more`
        : "";
    throw new Error(
      `Failed to verify org memberships in ${orgMembershipProbeErrors.length} org(s) (${preview}${suffix}). User was not deleted.`,
    );
  }

  // 3. Fail early if the user owns any orgs — removing an owner via
  // removeMember throws, and proceeding would leave a dangling owner
  // reference in the OrgDO after the UserDO is wiped.
  const ownedOrgIds = orgMemberships
    .filter((o) => o.role === "owner")
    .map((o) => o.org_id);
  if (ownedOrgIds.length > 0) {
    const preview = ownedOrgIds
      .slice(0, 3)
      .map((id) => id.slice(0, 8))
      .join(", ");
    const suffix =
      ownedOrgIds.length > 3 ? ` and ${ownedOrgIds.length - 3} more` : "";
    throw new Error(
      `User owns ${ownedOrgIds.length} org(s) (${preview}${suffix}). Transfer ownership or delete those orgs before deleting this user.`,
    );
  }

  // 4. Ensure the target UserDO has the hard-delete RPC before mutating org state.
  try {
    await userStub.canHardDeleteUser();
  } catch (error) {
    if (
      isMissingRpcMethodError(error, "canHardDeleteUser") ||
      isMissingRpcMethodError(error, "hardDeleteUser")
    ) {
      throw new Error(
        "User Durable Object is running old code (missing hardDeleteUser). Restart `bun run dev` or deploy the latest main worker, then retry delete.",
      );
    }
    throw error;
  }

  // 5. Remove user from all orgs first. If any membership cleanup fails,
  // stop before wiping the user record to avoid orphaned org membership rows.
  const removedOrgMemberships: OrgMembershipSnapshot[] = [];
  const orgRemovalErrors: string[] = [];
  const removalResults = await mapWithConcurrency(
    orgMemberships,
    ORG_MEMBERSHIP_MUTATION_CONCURRENCY,
    async (org) => {
      try {
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.org_id));
        await orgStub.removeMember(userId, actorId);
        return { ok: true as const, org };
      } catch (error) {
        return {
          ok: false as const,
          error: `${org.org_id.slice(0, 8)}: ${toErrorMessage(error)}`,
        };
      }
    },
  );

  for (const result of removalResults) {
    if (result.ok) {
      removedOrgMemberships.push(result.org);
      continue;
    }
    orgRemovalErrors.push(result.error);
  }
  if (orgRemovalErrors.length > 0) {
    const rollbackErrors: string[] = [];
    for (const membership of removedOrgMemberships) {
      try {
        const orgStub = authEnv.ORG.get(
          authEnv.ORG.idFromName(membership.org_id),
        );
        await orgStub.addMember(userId, membership.role, actorId, {
          workspaceAccessDefault: membership.workspace_access_default,
          workspaceAccessRows: membership.workspace_access_rows,
        });
      } catch (rollbackError) {
        rollbackErrors.push(
          `${membership.org_id.slice(0, 8)}: ${toErrorMessage(rollbackError)}`,
        );
      }
    }

    const preview = orgRemovalErrors.slice(0, 3).join("; ");
    const suffix =
      orgRemovalErrors.length > 3
        ? `; and ${orgRemovalErrors.length - 3} more`
        : "";
    const rollbackSummary =
      rollbackErrors.length > 0
        ? ` Also failed to restore ${rollbackErrors.length} removed membership(s) (${rollbackErrors.slice(0, 3).join("; ")}${rollbackErrors.length > 3 ? `; and ${rollbackErrors.length - 3} more` : ""}). Manual repair required.`
        : "";
    throw new Error(
      `Failed to remove user from ${orgRemovalErrors.length} org(s) (${preview}${suffix}). User was not deleted. Resolve membership cleanup and retry.${rollbackSummary}`,
    );
  }

  // 6. Wipe UserDO state. If this fails, restore removed org memberships.
  try {
    await userStub.hardDeleteUser();
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const membership of removedOrgMemberships) {
      try {
        const orgStub = authEnv.ORG.get(
          authEnv.ORG.idFromName(membership.org_id),
        );
        await orgStub.addMember(userId, membership.role, actorId, {
          workspaceAccessDefault: membership.workspace_access_default,
          workspaceAccessRows: membership.workspace_access_rows,
        });
      } catch (rollbackError) {
        rollbackErrors.push(
          `${membership.org_id.slice(0, 8)}: ${toErrorMessage(rollbackError)}`,
        );
      }
    }

    const rollbackSummary =
      rollbackErrors.length > 0
        ? `Also failed to restore ${rollbackErrors.length} org membership(s) (${rollbackErrors.slice(0, 3).join("; ")}${rollbackErrors.length > 3 ? `; and ${rollbackErrors.length - 3} more` : ""}). Manual repair required.`
        : "Removed org memberships were restored.";

    if (isMissingRpcMethodError(error, "hardDeleteUser")) {
      throw new Error(
        `User Durable Object is running old code (missing hardDeleteUser). Restart \`bun run dev\` or deploy the latest main worker, then retry delete. ${rollbackSummary}`,
      );
    }
    throw new Error(
      `Failed to wipe UserDO state: ${toErrorMessage(error)} ${rollbackSummary}`,
    );
  }

  // Keep the D1 admin index aligned with UserDO + EMAIL_TO_USER cleanup.
  try {
    const appIndex = getAppIndexDatabase(env);
    if (!appIndex) {
      throw new Error("APP_DB binding is not configured");
    }
    await appIndex.applyAdminEvent({
      type: "user_delete",
      payload: { id: userId },
    });
  } catch (error) {
    warnings.push(
      `Failed to remove user from admin index: ${toErrorMessage(error)}`,
    );
  }

  // 7. Delete EMAIL_TO_USER KV entries only when they still belong to this
  // user. Tenant-scoped SSO principals are intentionally absent from this
  // global index and may share an email with a different global account.
  const kvKeysToDelete: string[] = [`email:${profile.email.toLowerCase()}`];
  for (const provider of oauthProviders) {
    kvKeysToDelete.push(`oauth:${provider.provider}:${provider.provider_id}`);
  }
  await Promise.all(
    kvKeysToDelete.map(async (key) => {
      try {
        const value = await authEnv.EMAIL_TO_USER.get(key);
        const parsed = parseJsonSafely(value);
        if (value === userId || parsed?.user_id === userId) {
          await authEnv.EMAIL_TO_USER.delete(key);
        }
      } catch (error) {
        warnings.push(
          `Failed to delete EMAIL_TO_USER key "${key}": ${toErrorMessage(error)}`,
        );
      }
    }),
  );

  // Purge any stale oauth:* indexes that still point to this user (covers
  // partial signup/login failures where UserDO provider rows were not written).
  try {
    await deleteKvEntriesWithPrefix(
      authEnv.EMAIL_TO_USER,
      "oauth:",
      (_key, value) => {
        if (value === userId) {
          return true;
        }
        const parsed = parseJsonSafely(value);
        return parsed?.user_id === userId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean oauth:* EMAIL_TO_USER mappings: ${toErrorMessage(error)}`,
    );
  }

  // 8. Best-effort cleanup of user sessions.
  const sessionOrgIds = new Set<string>(
    orgMemberships.map((org) => org.org_id),
  );
  const sessionPrefixes = [SESSION_PREFIX, WORKER_SESSION_PREFIX] as const;
  for (const prefix of sessionPrefixes) {
    try {
      await deleteKvEntriesWithPrefix(
        authEnv.SESSIONS,
        prefix,
        (_key, value) => {
          const parsed = parseJsonSafely(value);
          if (parsed?.user_id !== userId) {
            return false;
          }
          if (typeof parsed?.org_id === "string") {
            sessionOrgIds.add(parsed.org_id);
          }
          return true;
        },
      );
    } catch (error) {
      warnings.push(
        `Failed to clean ${prefix}* sessions: ${toErrorMessage(error)}`,
      );
    }
  }

  // 9. Best-effort cleanup of workspace member rows for this user.
  const workspaceAclOrgIds = new Set<string>(
    orgMemberships.map((org) => org.org_id),
  );
  for (const orgId of sessionOrgIds) {
    workspaceAclOrgIds.add(orgId);
  }
  for (const orgId of userScopedOrgHints) {
    workspaceAclOrgIds.add(orgId);
  }

  for (const orgId of workspaceAclOrgIds) {
    try {
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      const workspaces = await orgStub.getWorkspaces(true);
      await Promise.all(
        workspaces.map(async (workspace) => {
          const workspaceStub = authEnv.WORKSPACE.get(
            authEnv.WORKSPACE.idFromName(workspace.id),
          );
          await workspaceStub.removeMember(userId, actorId);
        }),
      );
    } catch (error) {
      warnings.push(
        `Failed to clean workspace member rows in org ${orgId.slice(0, 8)}: ${toErrorMessage(error)}`,
      );
    }
  }

  // 10. Best-effort cleanup of pending worker auth tokens to prevent
  // post-delete token exchange into fresh worker sessions.
  try {
    await deleteKvEntriesWithPrefix(
      authEnv.APP_KV,
      WORKER_AUTH_TOKEN_PREFIX,
      (_key, value) => {
        const parsed = parseJsonSafely(value);
        return parsed?.user_id === userId;
      },
    );
  } catch (error) {
    warnings.push(
      `Failed to clean worker auth tokens: ${toErrorMessage(error)}`,
    );
  }

  return {
    removed_org_memberships: removedOrgMemberships.length,
    warnings,
  };
}

export interface StartAdminBanAndPurgeOptions {
  reason: string;
  actorId?: string;
}

export async function startAdminOrgBanAndPurgeWithEnv(
  env: CloudflareEnv,
  orgId: string,
  options: StartAdminBanAndPurgeOptions,
): Promise<BanPurgeJobRecord> {
  const authEnv = getAuthEnv(env);
  const actorId = options.actorId ?? "system-admin";
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("Ban reason is required");
  }
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const orgInfo = await orgStub.getInfo();
  if (!orgInfo) {
    throw new Error("Organization not found");
  }

  const now = Date.now();
  const existingBan = await getOrgBanById(env.APP_KV, orgId);
  const jobId = crypto.randomUUID();
  const record: BanRecord = {
    scope: "org",
    target_id: orgId,
    email: null,
    org_slug: orgInfo.slug ?? null,
    reason,
    created_at: existingBan?.created_at ?? now,
    created_by: existingBan?.created_by ?? actorId,
    status: "active",
    purge_status: "pending",
    purge_job_id: jobId,
    purge_started_at: null,
    purge_completed_at: null,
    purge_error: null,
  };
  await putBanRecord(env.APP_KV, record);

  const members = await orgStub.getMembers();
  await Promise.all(
    members.map(async (member) => {
      try {
        await authEnv.USER.get(
          authEnv.USER.idFromName(member.user_id),
        ).invalidateSessions();
      } catch {
        // best effort
      }
    }),
  );

  const job: BanPurgeJobRecord = {
    id: jobId,
    scope: "org",
    target_id: orgId,
    reason: record.reason,
    created_at: now,
    created_by: actorId,
    status: "pending",
    completed_at: null,
    error: null,
  };
  await saveBanPurgeJob(env, job);
  return job;
}

export async function runAdminOrgBanAndPurgeWithEnv(
  env: CloudflareEnv,
  job: BanPurgeJobRecord,
  actorId = "system-admin",
): Promise<void> {
  const runningJob: BanPurgeJobRecord = {
    ...job,
    status: "running",
    error: null,
  };
  await saveBanPurgeJob(env, runningJob);
  await updateBanRecordPurgeStatus(env, "org", job.target_id, {
    purge_status: "running",
    purge_job_id: job.id,
    purge_started_at: Date.now(),
    purge_completed_at: null,
    purge_error: null,
  });

  try {
    await hardDeleteAdminOrgWithEnv(env, job.target_id, actorId);
    const completedAt = Date.now();
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "completed",
      completed_at: completedAt,
    });
    await updateBanRecordPurgeStatus(env, "org", job.target_id, {
      purge_status: "completed",
      purge_job_id: job.id,
      purge_completed_at: completedAt,
      purge_error: null,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "failed",
      error: message,
      completed_at: Date.now(),
    });
    await updateBanRecordPurgeStatus(env, "org", job.target_id, {
      purge_status: "failed",
      purge_job_id: job.id,
      purge_completed_at: Date.now(),
      purge_error: message,
    });
    throw error;
  }
}

export async function startAdminUserBanAndPurgeWithEnv(
  env: CloudflareEnv,
  userId: string,
  options: StartAdminBanAndPurgeOptions,
): Promise<BanPurgeJobRecord> {
  const authEnv = getAuthEnv(env);
  const actorId = options.actorId ?? "system-admin";
  const reason = options.reason.trim();
  if (!reason) {
    throw new Error("Ban reason is required");
  }
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const profile = await userStub.getProfile();
  if (!profile) {
    throw new Error("User not found");
  }

  const now = Date.now();
  const existingBan = await getUserBanById(env.APP_KV, userId);
  const jobId = crypto.randomUUID();
  const record: BanRecord = {
    scope: "user",
    target_id: userId,
    email: profile.email.toLowerCase(),
    org_slug: null,
    reason,
    created_at: existingBan?.created_at ?? now,
    created_by: existingBan?.created_by ?? actorId,
    status: "active",
    purge_status: "pending",
    purge_job_id: jobId,
    purge_started_at: null,
    purge_completed_at: null,
    purge_error: null,
  };
  await putBanRecord(env.APP_KV, record);

  try {
    await userStub.invalidateSessions();
  } catch {
    // best effort
  }

  const job: BanPurgeJobRecord = {
    id: jobId,
    scope: "user",
    target_id: userId,
    reason: record.reason,
    created_at: now,
    created_by: actorId,
    status: "pending",
    completed_at: null,
    error: null,
  };
  await saveBanPurgeJob(env, job);
  return job;
}

export async function runAdminUserBanAndPurgeWithEnv(
  env: CloudflareEnv,
  job: BanPurgeJobRecord,
  actorId = "system-admin",
): Promise<void> {
  const authEnv = getAuthEnv(env);
  const runningJob: BanPurgeJobRecord = {
    ...job,
    status: "running",
    error: null,
  };
  await saveBanPurgeJob(env, runningJob);
  await updateBanRecordPurgeStatus(env, "user", job.target_id, {
    purge_status: "running",
    purge_job_id: job.id,
    purge_started_at: Date.now(),
    purge_completed_at: null,
    purge_error: null,
  });

  try {
    const userStub = authEnv.USER.get(authEnv.USER.idFromName(job.target_id));
    const userOrgs = await userStub.getOrgs();
    const ownedOrgIds = userOrgs
      .filter((org) => org.role === "owner")
      .map((org) => org.org_id);

    for (const ownedOrgId of ownedOrgIds) {
      const orgJob = await startAdminOrgBanAndPurgeWithEnv(env, ownedOrgId, {
        reason: `Cascade from banned user ${job.target_id}: ${job.reason}`,
        actorId,
      });
      await runAdminOrgBanAndPurgeWithEnv(env, orgJob, actorId);
    }

    await hardDeleteAdminUserWithEnv(env, job.target_id, actorId);
    const completedAt = Date.now();
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "completed",
      completed_at: completedAt,
    });
    await updateBanRecordPurgeStatus(env, "user", job.target_id, {
      purge_status: "completed",
      purge_job_id: job.id,
      purge_completed_at: completedAt,
      purge_error: null,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    await saveBanPurgeJob(env, {
      ...runningJob,
      status: "failed",
      error: message,
      completed_at: Date.now(),
    });
    await updateBanRecordPurgeStatus(env, "user", job.target_id, {
      purge_status: "failed",
      purge_job_id: job.id,
      purge_completed_at: Date.now(),
      purge_error: message,
    });
    throw error;
  }
}
