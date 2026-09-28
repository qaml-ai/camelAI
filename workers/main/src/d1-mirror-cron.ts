// Cron entry for the DO -> D1 identity mirror (triggers.crons in
// wrangler.{prod,staging}.jsonc). Each tick advances a running backfill job.

import { runMirrorBackfillFor } from "./admin-index-bootstrap";
import type { Env } from "./types";
import { recordErrorEvent } from "./observability";

const BACKFILL_BUDGET_MS = 20_000;

export async function handleD1MirrorCron(env: Env, _scheduledTime: number = Date.now()): Promise<void> {
  if (!env.APP_DB) return;
  try {
    await runMirrorBackfillFor(env, BACKFILL_BUDGET_MS);
  } catch (error) {
    recordErrorEvent(env, {
      event: "d1_mirror_backfill_failed",
      component: "d1_mirror_cron",
      operation: "backfill",
      error,
    });
  }
}
