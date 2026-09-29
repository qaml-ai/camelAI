/**
 * Admin API: moving ChatThreadDO threads to the agent runtime.
 *
 *   POST /api/admin/runtime-migration/reconcile-orphans   {"dry_run"?, "limit"?, "after"?}:
 *        delete (or list) runtime agents a move made that neither their
 *        thread's move nor its runtime row holds (agent-runtime/thread-migration.ts),
 *        a page at a time; pass the answer's `next` as `after` for the next page.
 */

import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import type { ChatEnv } from "../../chat-thread/types.js";
import { reconcileRuntimeMigrationOrphans } from "../../agent-runtime/thread-migration.js";

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
