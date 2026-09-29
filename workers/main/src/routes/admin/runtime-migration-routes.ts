/**
 * Admin API: moving ChatThreadDO threads to the agent runtime.
 *
 *   POST /api/admin/runtime-migration/reconcile-orphans   {"dry_run"?, "limit"?, "after"?}:
 *        delete (or list) runtime agents a move made that neither their
 *        thread's move nor its runtime row holds (agent-runtime/thread-migration.ts),
 *        a page at a time; pass the answer's `next` as `after` for the next page.
 *   POST /api/admin/runtime-migration/dry-run   {"org_id", "thread_id"}: what moving
 *        the thread would import (stats, lossy, bytes), without moving it: no
 *        lease, no agent, and the thread keeps running where it does.
 */

import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import type { ChatEnv } from "../../chat-thread/types.js";
import type { OrgThread } from "../../identity/org-do.js";
import { migrateThreadToRuntime, reconcileRuntimeMigrationOrphans } from "../../agent-runtime/thread-migration.js";
import { getOrgStub } from "./helpers.js";

type HonoEnv = { Bindings: Env };

export const runtimeMigrationRoutes = new Hono<HonoEnv>();

runtimeMigrationRoutes.post(
  "/runtime-migration/reconcile-orphans",
  openApi({
    summary: "Delete (or, on a dry run, list) runtime agents a thread move made and lost track of",
    request: {
      json: z.object({
        dry_run: z.boolean().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        after: z.string().min(1).optional(),
      }),
    },
    responses: { 200: z.record(z.string(), z.unknown()) },
  }),
  async (c) => {
    const { dry_run, limit, after } = c.req.valid("json");
    return c.json(await reconcileRuntimeMigrationOrphans(c.env as unknown as ChatEnv, { dryRun: dry_run, limit, after }));
  },
);

runtimeMigrationRoutes.post(
  "/runtime-migration/dry-run",
  openApi({
    summary: "What moving a thread to the agent runtime would import, without moving it",
    request: { json: z.object({ org_id: z.string().min(1), thread_id: z.string().min(1) }) },
    responses: { 200: z.record(z.string(), z.unknown()), 404: z.record(z.string(), z.unknown()) },
  }),
  async (c) => {
    const { org_id: orgId, thread_id: threadId } = c.req.valid("json");
    const thread = await (getOrgStub(c.env, orgId) as unknown as { getThread(id: string): Promise<OrgThread | null> }).getThread(threadId);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    const result = await migrateThreadToRuntime(c.env as unknown as ChatEnv, {
      orgId,
      workspaceId: thread.workspace_id,
      threadId,
      userId: thread.created_by || null,
      userName: null,
      userEmail: null,
    }, { dryRun: true });
    return c.json({
      thread: { id: thread.id, title: thread.title, source: thread.source, channel_kind: thread.channel_kind, created_at: thread.created_at, user_message_count: thread.user_message_count },
      result,
    });
  },
);
