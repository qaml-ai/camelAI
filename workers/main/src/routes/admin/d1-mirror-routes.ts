/**
 * Admin API: DO -> D1 identity mirror operations.
 *
 *   GET  /api/admin/d1-mirror/backfill            backfill job state
 *   POST /api/admin/d1-mirror/backfill            {"action": "start" | "step" | "reset"}
 *   GET  /api/admin/d1-mirror/outbox?org_id=|user_id=   one DO's outbox stats
 *   POST /api/admin/d1-mirror/resync              {"org_id"} | {"user_id"}: re-mirror one DO
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
    request: { json: z.object({ action: z.enum(["start", "step", "reset"]) }) },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    const { action } = c.req.valid("json");
    if (action === "start") return c.json(await startMirrorBackfill(c.env));
    if (action === "reset") return c.json(await resetMirrorBackfill(c.env));
    return c.json(await runMirrorBackfillStep(c.env));
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
