/**
 * Admin API: the self-host thread sweep (agent-runtime/selfhost-sweep.ts),
 * which the app's startup process drives (scripts/selfhost-runtime-sweep.mjs)
 * and selfhost:doctor reports. Self-host only.
 *
 *   GET  /api/admin/selfhost/runtime-sweep   the job, and the threads it skipped or will retry, with reasons
 *   POST /api/admin/selfhost/runtime-sweep   {"action": "start" | "step" | "reset", "concurrency"?, "budget_ms"?}
 *        start = begin a pass (resumes one under way); step = advance it for
 *        up to budget_ms; reset = forget the job and its thread records.
 */
import { Hono } from "hono";
import { openApi } from "hono-zod-openapi";
import { z } from "zod";
import type { Env } from "../../types.js";
import type { ChatEnv } from "../../chat-thread/types.js";
import { isSelfhostRuntime } from "../../../../../src/lib/selfhost-runtime.js";
import { getSweepReport, resetSweep, runSweepStep, startSweep } from "../../agent-runtime/selfhost-sweep.js";

type HonoEnv = { Bindings: Env };

const ObjectSchema = z.record(z.string(), z.unknown());

export const selfhostSweepRoutes = new Hono<HonoEnv>();

const sweepEnv = (env: Env) => env as unknown as ChatEnv & { APP_DB?: D1Database };

selfhostSweepRoutes.get(
  "/selfhost/runtime-sweep",
  openApi({ summary: "Self-host thread sweep: progress, and skipped or retrying threads with reasons", responses: { 200: ObjectSchema } }),
  async (c) => {
    if (!isSelfhostRuntime(c.env)) return c.json({ error: "Not found" }, 404);
    return c.json(await getSweepReport(sweepEnv(c.env)));
  },
);

selfhostSweepRoutes.post(
  "/selfhost/runtime-sweep",
  openApi({
    summary: "Start, advance, or reset the self-host thread sweep",
    request: {
      json: z.object({
        action: z.enum(["start", "step", "reset"]),
        concurrency: z.number().int().min(1).max(16).optional(),
        budget_ms: z.number().int().min(1_000).max(60_000).optional(),
      }),
    },
    responses: { 200: ObjectSchema },
  }),
  async (c) => {
    if (!isSelfhostRuntime(c.env)) return c.json({ error: "Not found" }, 404);
    const { action, concurrency, budget_ms: budgetMs } = c.req.valid("json");
    const env = sweepEnv(c.env);
    if (action === "start") return c.json(await startSweep(env));
    if (action === "reset") return c.json(await resetSweep(env));
    return c.json(await runSweepStep(env, { concurrency, budgetMs }));
  },
);
