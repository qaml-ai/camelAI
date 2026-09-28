/**
 * Admin API: entity detail + management endpoints.
 *
 * These cover the superuser actions that previously only existed in the
 * `/qaml-backdoor` React Router UI (user/org/workspace/app edits, archive,
 * hard delete, ownership transfer, invitations, audit logs, app logs, chat
 * explorer). The admin MCP reaches all of them through `admin_api_request`.
 */

import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import type { AuthEnv } from "../../../../../src/lib/auth-helpers.js";
import {
  adminForceOrphanUser,
  adminTransferOrgOwnership,
  adminUpdateUser,
  deleteWorkerScript,
  getOrgAuditLog,
  getOrgInvitations,
  getOrgMembers,
  getUserOrgs,
  getWorkspace,
  getWorkspaceAuditLog,
  listWorkspaceIntegrations,
  resetOnboardingForUser,
  setWorkerScriptPublic,
  updateOrgMemberRole,
} from "../../../../../src/lib/auth-do.js";
import {
  hardDeleteAdminOrgWithEnv,
  hardDeleteAdminUserWithEnv,
} from "../../../../../src/lib/auth-do.server.js";
import { deleteDeployedAppRuntime } from "../../../../../src/lib/deployed-app-delete.server.js";
import { getUserBanById } from "../../ban-list.js";
import type { ChatExplorerFilters } from "../../admin-index-types.js";
import type { AppIndexDatabase } from "../../app-index-db.js";
import { getAdminIndexStub, getOrgStub, getUserStub } from "./helpers.js";
import {
  booleanQueryParam,
  ErrorSchema,
  PaginationQuerySchema,
} from "./schemas.js";

type HonoEnv = { Bindings: Env };

const ACTOR_ID = "admin-api";
const BILLING_STATUSES = [
  "inactive",
  "trialing",
  "active",
  "enterprise",
  "past_due",
  "canceled",
] as const;

const ObjectSchema = z.record(z.string(), z.unknown());
const OkSchema = z.object({ ok: z.literal(true) }).passthrough();
const AvatarBodySchema = z.object({
  color: z.string().min(1),
  content: z.string().min(1),
});
const AuditLogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

function adminIndex(env: Env): AppIndexDatabase {
  return getAdminIndexStub(env) as unknown as AppIndexDatabase;
}

function authEnv(env: Env): AuthEnv {
  return env as unknown as AuthEnv;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const managementRoutes = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

managementRoutes.get(
  "/users/:id",
  openApi({
    summary: "User detail: profile, org memberships, and active ban",
    responses: { 200: ObjectSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const userId = c.req.param("id");
    const [user, orgs, ban] = await Promise.all([
      getUserStub(c.env, userId).getProfile(),
      getUserOrgs(authEnv(c.env), userId, { d1Read: true }),
      getUserBanById(c.env.APP_KV, userId),
    ]);
    if (!user) return c.json({ error: "User not found" }, 404);
    return c.json({ user, orgs, ban });
  },
);

managementRoutes.patch(
  "/users/:id",
  openApi({
    summary: "Update user name, avatar, or superuser flag",
    request: {
      json: z.object({
        name: z.string().nullable().optional(),
        avatar: AvatarBodySchema.optional(),
        is_superuser: z.boolean().optional(),
      }),
    },
    responses: { 200: ObjectSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const updated = await adminUpdateUser(authEnv(c.env), c.req.param("id"), {
      ...(body.name !== undefined ? { name: body.name?.trim() || null } : {}),
      ...(body.avatar ? { avatar: body.avatar } : {}),
      ...(body.is_superuser !== undefined
        ? { is_superuser: body.is_superuser }
        : {}),
    });
    if (!updated) return c.json({ error: "User not found" }, 404);
    return c.json(updated);
  },
);

managementRoutes.post(
  "/users/:id/force-orphan",
  openApi({
    summary: "Remove user from every org and mark them orphaned",
    responses: { 200: OkSchema },
  }),
  async (c) => {
    await adminForceOrphanUser(authEnv(c.env), c.req.param("id"), ACTOR_ID);
    return c.json({ ok: true as const });
  },
);

managementRoutes.post(
  "/users/:id/reset-onboarding",
  openApi({
    summary: "Reset a user's onboarding state",
    responses: { 200: OkSchema },
  }),
  async (c) => {
    await resetOnboardingForUser(authEnv(c.env), c.req.param("id"));
    return c.json({ ok: true as const });
  },
);

managementRoutes.delete(
  "/users/:id",
  openApi({
    summary:
      "Permanently delete a user and related records (fails if the user still owns orgs)",
    responses: { 200: ObjectSchema, 400: ErrorSchema },
  }),
  async (c) => {
    try {
      const result = await hardDeleteAdminUserWithEnv(
        c.env as never,
        c.req.param("id"),
        ACTOR_ID,
      );
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json(
        { error: errorMessage(error, "Failed to permanently delete user") },
        400,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Orgs
// ---------------------------------------------------------------------------

managementRoutes.patch(
  "/orgs/:id",
  openApi({
    summary: "Update org name and/or billing status",
    request: {
      json: z.object({
        name: z.string().trim().min(1).optional(),
        billing_status: z.enum(BILLING_STATUSES).optional(),
      }),
    },
    responses: { 200: OkSchema, 400: ErrorSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const body = c.req.valid("json");
    if (body.name === undefined && body.billing_status === undefined) {
      return c.json({ error: "name or billing_status is required" }, 400);
    }
    const orgStub = getOrgStub(c.env, c.req.param("id"));
    if (!(await orgStub.getInfo())) {
      return c.json({ error: "Organization not found" }, 404);
    }
    if (body.name !== undefined) {
      await orgStub.updateName(body.name, ACTOR_ID);
    }
    if (body.billing_status !== undefined) {
      await orgStub.updateBillingState({ billing_status: body.billing_status });
    }
    return c.json({ ok: true as const });
  },
);

managementRoutes.post(
  "/orgs/:id/archive",
  openApi({
    summary: "Archive an org (soft delete)",
    responses: { 200: OkSchema },
  }),
  async (c) => {
    await getOrgStub(c.env, c.req.param("id")).archiveOrg(ACTOR_ID);
    return c.json({ ok: true as const });
  },
);

managementRoutes.delete(
  "/orgs/:id",
  openApi({
    summary: "Permanently delete an org and all related records",
    responses: { 200: ObjectSchema, 400: ErrorSchema },
  }),
  async (c) => {
    try {
      const result = await hardDeleteAdminOrgWithEnv(
        c.env as never,
        c.req.param("id"),
        ACTOR_ID,
      );
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json(
        {
          error: errorMessage(error, "Failed to permanently delete organization"),
        },
        400,
      );
    }
  },
);

managementRoutes.get(
  "/orgs/:id/members",
  openApi({
    summary: "List org members with profiles and roles",
    responses: { 200: z.object({ data: z.array(ObjectSchema) }) },
  }),
  async (c) => {
    const members = await getOrgMembers(authEnv(c.env), c.req.param("id"));
    return c.json({ data: members });
  },
);

managementRoutes.patch(
  "/orgs/:id/members/:userId",
  openApi({
    summary: "Change an org member's role (use transfer-ownership for owner)",
    request: {
      json: z.object({ role: z.enum(["admin", "member", "viewer"]) }),
    },
    responses: { 200: OkSchema },
  }),
  async (c) => {
    const { role } = c.req.valid("json");
    await updateOrgMemberRole(
      authEnv(c.env),
      c.req.param("id"),
      c.req.param("userId"),
      role,
      ACTOR_ID,
    );
    return c.json({ ok: true as const });
  },
);

managementRoutes.post(
  "/orgs/:id/transfer-ownership",
  openApi({
    summary: "Transfer org ownership; the previous owner becomes admin",
    request: { json: z.object({ new_owner_id: z.string().min(1) }) },
    responses: { 200: OkSchema, 400: ErrorSchema },
  }),
  async (c) => {
    const { new_owner_id } = c.req.valid("json");
    try {
      await adminTransferOrgOwnership(
        authEnv(c.env),
        c.req.param("id"),
        new_owner_id,
        ACTOR_ID,
      );
    } catch (error) {
      return c.json(
        { error: errorMessage(error, "Failed to transfer ownership") },
        400,
      );
    }
    return c.json({ ok: true as const });
  },
);

managementRoutes.get(
  "/orgs/:id/invitations",
  openApi({
    summary: "List an org's pending invitations",
    responses: { 200: z.object({ data: z.array(ObjectSchema) }) },
  }),
  async (c) => {
    const invitations = await getOrgInvitations(
      authEnv(c.env),
      c.req.param("id"),
    );
    return c.json({ data: invitations });
  },
);

managementRoutes.delete(
  "/orgs/:id/invitations/:invitationId",
  openApi({
    summary: "Delete a pending org invitation",
    responses: { 200: OkSchema },
  }),
  async (c) => {
    await getOrgStub(c.env, c.req.param("id")).deleteInvitation(
      c.req.param("invitationId"),
    );
    return c.json({ ok: true as const });
  },
);

managementRoutes.get(
  "/orgs/:id/audit-log",
  openApi({
    summary: "Org audit log (newest first)",
    request: { query: AuditLogQuerySchema },
    responses: { 200: z.object({ data: z.array(ObjectSchema) }) },
  }),
  async (c) => {
    const { limit, offset } = c.req.valid("query");
    const entries = await getOrgAuditLog(
      authEnv(c.env),
      c.req.param("id"),
      limit,
      offset,
    );
    return c.json({ data: entries });
  },
);

// ---------------------------------------------------------------------------
// Invitations (cross-org)
// ---------------------------------------------------------------------------

managementRoutes.get(
  "/invitations",
  openApi({
    summary: "Search pending invitations across all orgs",
    request: { query: PaginationQuerySchema },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    const { limit, offset, search } = c.req.valid("query");
    const page = await adminIndex(c.env).getInvitationsPaginated(
      offset,
      limit,
      search?.trim() || undefined,
    );
    return c.json(page);
  },
);

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

managementRoutes.get(
  "/workspaces/:id",
  openApi({
    summary: "Workspace detail: metadata, integrations, restricted members",
    responses: { 200: ObjectSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const workspaceId = c.req.param("id");
    const env = authEnv(c.env);
    const workspace = await getWorkspace(env, workspaceId);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    const [integrations, members] = await Promise.all([
      listWorkspaceIntegrations(env, workspaceId),
      env.WORKSPACE.get(
        env.WORKSPACE.idFromName(workspaceId),
      ).listRestrictedMembers(),
    ]);
    return c.json({ workspace, integrations, members });
  },
);

managementRoutes.patch(
  "/workspaces/:id",
  openApi({
    summary: "Update workspace name, description, or avatar",
    request: {
      json: z.object({
        name: z.string().trim().min(1).optional(),
        description: z.string().nullable().optional(),
        avatar: AvatarBodySchema.optional(),
      }),
    },
    responses: { 200: OkSchema, 400: ErrorSchema },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const env = authEnv(c.env);
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(c.req.param("id")));
    try {
      await stub.updateWorkspace(
        {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description?.trim() || null }
            : {}),
          ...(body.avatar ? { avatar: body.avatar } : {}),
        },
        ACTOR_ID,
      );
    } catch (error) {
      return c.json(
        { error: errorMessage(error, "Failed to update workspace") },
        400,
      );
    }
    return c.json({ ok: true as const });
  },
);

managementRoutes.post(
  "/workspaces/:id/archive",
  openApi({
    summary: "Archive a workspace",
    responses: { 200: OkSchema },
  }),
  async (c) => {
    const env = authEnv(c.env);
    await env.WORKSPACE.get(env.WORKSPACE.idFromName(c.req.param("id"))).archive(
      ACTOR_ID,
    );
    return c.json({ ok: true as const });
  },
);

managementRoutes.get(
  "/workspaces/:id/audit-log",
  openApi({
    summary: "Workspace audit log (newest first)",
    request: { query: AuditLogQuerySchema },
    responses: { 200: z.object({ data: z.array(ObjectSchema) }) },
  }),
  async (c) => {
    const { limit, offset } = c.req.valid("query");
    const entries = await getWorkspaceAuditLog(
      authEnv(c.env),
      c.req.param("id"),
      limit,
      offset,
    );
    return c.json({ data: entries });
  },
);

// ---------------------------------------------------------------------------
// Apps (addressed by org id + script name)
// ---------------------------------------------------------------------------

managementRoutes.patch(
  "/orgs/:id/apps/:scriptName",
  openApi({
    summary: "Set a deployed app's public flag",
    request: { json: z.object({ is_public: z.boolean() }) },
    responses: { 200: ObjectSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const { is_public } = c.req.valid("json");
    const script = await setWorkerScriptPublic(
      authEnv(c.env),
      c.req.param("id"),
      c.req.param("scriptName"),
      is_public,
      ACTOR_ID,
    );
    if (!script) return c.json({ error: "App not found" }, 404);
    return c.json(script);
  },
);

managementRoutes.delete(
  "/orgs/:id/apps/:scriptName",
  openApi({
    summary: "Delete a deployed app (dispatch script, assets, and registry row)",
    responses: { 200: OkSchema, 400: ErrorSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const orgId = c.req.param("id");
    const scriptName = c.req.param("scriptName");
    const orgInfo = await getOrgStub(c.env, orgId).getInfo();
    if (!orgInfo) return c.json({ error: "Organization not found" }, 404);
    if (!orgInfo.slug) {
      return c.json(
        { error: "Organization slug is required to delete this app" },
        400,
      );
    }
    try {
      await deleteDeployedAppRuntime(c.env as never, {
        scriptName,
        orgSlug: orgInfo.slug,
      });
      const deleted = await deleteWorkerScript(
        authEnv(c.env),
        orgId,
        scriptName,
        ACTOR_ID,
      );
      if (!deleted) return c.json({ error: "App not found" }, 404);
    } catch (error) {
      return c.json({ error: errorMessage(error, "Failed to delete app") }, 400);
    }
    return c.json({ ok: true as const });
  },
);

managementRoutes.get(
  "/orgs/:id/apps/:scriptName/logs",
  openApi({
    summary: "Recent runtime logs captured for a deployed app",
    request: {
      query: z.object({
        limit: z.coerce.number().int().min(1).max(1000).optional().default(200),
      }),
    },
    responses: { 200: ObjectSchema, 404: ErrorSchema },
  }),
  async (c) => {
    const scriptName = c.req.param("scriptName");
    const { limit } = c.req.valid("query");
    const orgInfo = await getOrgStub(c.env, c.req.param("id")).getInfo();
    if (!orgInfo) return c.json({ error: "Organization not found" }, 404);
    // Do not fall back to unscoped legacy keys when an org slug exists.
    const storageKey = orgInfo.slug
      ? `${scriptName}--${orgInfo.slug}`
      : scriptName;
    const logsStub = c.env.WORKER_LOGS.get(
      c.env.WORKER_LOGS.idFromName(storageKey),
    );
    const [logs, stats] = await Promise.all([
      logsStub.getLogs({ limit }),
      logsStub.getStats(),
    ]);
    return c.json({ storage_key: storageKey, stats, logs });
  },
);

// ---------------------------------------------------------------------------
// Chat explorer
// ---------------------------------------------------------------------------

managementRoutes.get(
  "/chat-explorer",
  openApi({
    summary:
      "Browse threads with previews, filterable by plan, first chats, automation, and errors",
    request: {
      query: PaginationQuerySchema.extend({
        plan: z.enum(["starter", "pro", "team", "enterprise", "payg"]).optional(),
        first_chats_only: booleanQueryParam,
        automated_only: booleanQueryParam,
        errors_only: booleanQueryParam,
        exclude_internal: booleanQueryParam,
        sort_by: z.enum(["updated_at", "created_at"]).optional(),
      }),
    },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    const { limit, offset, search, ...rest } = c.req.valid("query");
    const filters: ChatExplorerFilters = {
      ...(rest.plan ? { plan: rest.plan } : {}),
      ...(rest.first_chats_only ? { first_chats_only: true } : {}),
      ...(rest.automated_only ? { automated_only: true } : {}),
      ...(rest.errors_only ? { errors_only: true } : {}),
      ...(rest.exclude_internal ? { exclude_internal: true } : {}),
      ...(rest.sort_by ? { sort_by: rest.sort_by } : {}),
    };
    const page = await adminIndex(c.env).getChatExplorerThreads(
      offset,
      limit,
      search?.trim() || undefined,
      filters,
    );
    return c.json(page);
  },
);

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

managementRoutes.post(
  "/email/test",
  openApi({
    summary: "Send a sample org invitation email to verify email delivery",
    request: { json: z.object({ to: z.string().email() }) },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    const { to } = c.req.valid("json");
    const { resolveAppBaseUrl, sendOrgInvitationEmail } = await import(
      "../../../../../src/lib/email.server.js"
    );
    const baseUrl = resolveAppBaseUrl(c.env as never, new URL(c.req.url));
    const result = await sendOrgInvitationEmail({
      env: c.env as never,
      to,
      orgName: "Test Organization",
      inviterName: "Admin",
      role: "member",
      invitationUrl: `${baseUrl}/invitations/test-org-id/test-invitation-id`,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    return c.json(result);
  },
);
