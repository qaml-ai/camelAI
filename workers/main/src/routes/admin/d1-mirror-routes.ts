/**
 * Admin API: DO -> D1 identity mirror operations.
 *
 *   GET  /api/admin/d1-mirror/backfill            backfill job state
 *   POST /api/admin/d1-mirror/backfill            {"action": "start" | "purge_orphans" | "step" | "reset"}
 *        start = resync every DO, then purge D1 rows of DOs that no longer
 *        exist; purge_orphans = only the purge. "dry_run": true only counts
 *        and lists candidates (orphan_*_candidates, first 50 each).
 *   GET  /api/admin/d1-mirror/outbox?org_id=|user_id=   one DO's outbox stats
 *   POST /api/admin/d1-mirror/resync              {"org_id"} | {"user_id"}: re-mirror one DO
 *   POST /api/admin/d1-mirror/reconcile           {"sample"?}: run the drift reconciler now
 */

import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import {
  getMirrorBackfillState,
  resetMirrorBackfill,
  runMirrorBackfillStep,
  startMirrorBackfill,
} from "../../admin-index-bootstrap.js";
import { runMirrorReconcile } from "../../d1-mirror-reconcile.js";
import { getOrgStub, getUserStub } from "./helpers.js";
import { ErrorSchema } from "./schemas.js";

type HonoEnv = { Bindings: Env };

const ObjectSchema = z.record(z.string(), z.unknown());
const TargetSchema = z
  .object({ org_id: z.string().min(1).optional(), user_id: z.string().min(1).optional() })
  .refine((value) => Boolean(value.org_id) !== Boolean(value.user_id), {
    message: "Pass exactly one of org_id or user_id",
  });

export const d1MirrorRoutes = new Hono<HonoEnv>();

d1MirrorRoutes.get(
  "/d1-mirror/backfill",
  openApi({
    summary: "D1 mirror backfill job state",
    responses: { 200: ObjectSchema },
  }),
  async (c) => c.json(await getMirrorBackfillState(c.env)),
);

d1MirrorRoutes.post(
  "/d1-mirror/backfill",
  openApi({
    summary:
      "Start, advance one page of, or reset the resumable D1 mirror backfill (the cron advances a running job on its own)",
    request: {
      json: z.object({
        action: z.enum(["start", "purge_orphans", "step", "reset"]),
        // start / purge_orphans: count and list orphan candidates without deleting.
        dry_run: z.boolean().optional(),
      }),
    },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    const { action, dry_run: dryRun } = c.req.valid("json");
    if (action === "start") return c.json(await startMirrorBackfill(c.env, { dryRun }));
    if (action === "purge_orphans") {
      return c.json(await startMirrorBackfill(c.env, { orphansOnly: true, dryRun }));
    }
    if (action === "reset") return c.json(await resetMirrorBackfill(c.env));
    return c.json(await runMirrorBackfillStep(c.env));
  },
);

d1MirrorRoutes.post(
  "/d1-mirror/reconcile",
  openApi({
    summary:
      "Run the D1 drift reconciler now over a sample of orgs and users (same as the hourly cron; emits d1_drift / d1_reconcile_ok)",
    request: { json: z.object({ sample: z.number().int().min(1).max(500).optional() }) },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    const { sample } = c.req.valid("json");
    const result = await runMirrorReconcile(c.env, { sample: sample ?? 10 });
    return c.json({ compared: result.compared, drift_count: result.drift.length, drift: result.drift.slice(0, 200) });
  },
);

d1MirrorRoutes.get(
  "/d1-mirror/outbox",
  openApi({
    summary: "Pending/failing D1 mirror outbox rows for one OrgDO or UserDO",
    request: { query: TargetSchema },
    responses: { 200: ObjectSchema, 400: ErrorSchema },
  }),
  async (c) => {
    const { org_id, user_id } = c.req.valid("query");
    const stats = org_id
      ? await getOrgStub(c.env, org_id).getMirrorOutboxStats()
      : await getUserStub(c.env, user_id!).getMirrorOutboxStats();
    return c.json(stats);
  },
);

d1MirrorRoutes.post(
  "/d1-mirror/resync",
  openApi({
    summary: "Queue a full D1 re-mirror of one OrgDO or UserDO",
    request: { json: TargetSchema },
    responses: { 200: ObjectSchema, 400: ErrorSchema },
  }),
  async (c) => {
    const { org_id, user_id } = c.req.valid("json");
    if (org_id) return c.json(await getOrgStub(c.env, org_id).requestMirrorResync());
    await getUserStub(c.env, user_id!).requestMirrorResync();
    return c.json({ queued: 1 });
  },
);
