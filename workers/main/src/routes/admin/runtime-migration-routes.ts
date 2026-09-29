/**
 * Admin API: moving ChatThreadDO threads to the agent runtime.
 *
 *   POST /api/admin/runtime-migration/reconcile-orphans   {"dry_run"?, "limit"?, "after"?}:
 *        delete (or list) runtime agents a move made that neither their
 *        thread's move nor its runtime row holds (agent-runtime/thread-migration.ts),
 *        a page at a time; pass the answer's `next` as `after` for the next page.
 *   POST /api/admin/runtime-migration/dry-run   {"org_id", "thread_id"}: what moving
 *        the thread would import (stats, lossy, bytes), without moving it: no
 *        lease, no agent, and the thread keeps running where it does. Its model's
 *        route and key scope are resolved (and the scope synced) as for a move.
 *   POST /api/admin/runtime-migration/clear-backoff   {"org_id", "thread_id"}: end a
 *        failed move's backoff, so the thread's next open or send tries again.
 *   POST /api/admin/runtime-migration/sweep   {"action": "start" | "step" | "status" | "pause",
 *        "dry_run"?, "active_within_days"?, "restart"?}: the cloud sweep
 *        (agent-runtime/cloud-sweep.ts), which the cron advances once started.
 *        start = begin (or resume a paused one; the same settings under way are
 *        returned as they are); step = advance it now; status = the job and the
 *        threads it skipped or will retry; pause = stop until the next start.
 */

import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import type { ChatEnv } from "../../chat-thread/types.js";
import type { OrgThread } from "../../identity/org-do.js";
import { migrateThreadToRuntime, reconcileRuntimeMigrationOrphans } from "../../agent-runtime/thread-migration.js";
import { getCloudSweepReport, pauseCloudSweep, runCloudSweepStep, startCloudSweep } from "../../agent-runtime/cloud-sweep.js";
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

runtimeMigrationRoutes.post(
  "/runtime-migration/clear-backoff",
  openApi({
    summary: "End a thread's failed-move backoff, so its next open or send tries the move again",
    request: { json: z.object({ org_id: z.string().min(1), thread_id: z.string().min(1) }) },
    responses: { 200: z.record(z.string(), z.unknown()), 404: z.record(z.string(), z.unknown()) },
  }),
  async (c) => {
    const { org_id: orgId, thread_id: threadId } = c.req.valid("json");
    const thread = await (getOrgStub(c.env, orgId) as unknown as { getThread(id: string): Promise<OrgThread | null> }).getThread(threadId);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    const chat = c.env.CHAT_THREAD.get(c.env.CHAT_THREAD.idFromName(threadId)) as unknown as {
      clearRuntimeMigrationBackoff(): Promise<boolean>;
      runtimeMigrationStatus(): Promise<{ state: string | null; retryAt?: number }>;
    };
    const cleared = await chat.clearRuntimeMigrationBackoff();
    return c.json({ thread_id: threadId, cleared, status: await chat.runtimeMigrationStatus() });
  },
);

runtimeMigrationRoutes.post(
  "/runtime-migration/sweep",
  openApi({
    summary: "Start, advance, pause, or report the cloud sweep that moves recently active ChatThreadDO threads to the runtime",
    request: {
      json: z.object({
        action: z.enum(["start", "step", "status", "pause"]),
        dry_run: z.boolean().optional(),
        active_within_days: z.number().int().min(1).max(3650).optional(),
        restart: z.boolean().optional(),
        budget_ms: z.number().int().min(1_000).max(60_000).optional(),
      }),
    },
    responses: { 200: z.record(z.string(), z.unknown()) },
  }),
  async (c) => {
    const { action, dry_run: dryRun, active_within_days: activeWithinDays, restart, budget_ms: budgetMs } = c.req.valid("json");
    const env = c.env as unknown as ChatEnv & { APP_DB?: D1Database };
    if (action === "start") return c.json(await startCloudSweep(env, { dryRun, activeWithinDays, restart }));
    if (action === "pause") return c.json(await pauseCloudSweep(env));
    if (action === "step") return c.json(await runCloudSweepStep(env, { budgetMs }));
    return c.json(await getCloudSweepReport(env));
  },
);
