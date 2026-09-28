// Cron entry for the DO -> D1 identity mirror (triggers.crons in
// wrangler.{prod,staging}.jsonc, every 5 minutes). Each tick advances a
// running backfill job; the first tick of each hour also runs the drift
// reconciler (D1_RECONCILE_SAMPLE_PER_DAY orgs and users per day, default 200).

import { runMirrorBackfillFor } from "./admin-index-bootstrap";
import { runMirrorReconcile } from "./d1-mirror-reconcile";
import type { Env } from "./types";
import { recordErrorEvent } from "./observability";

const BACKFILL_BUDGET_MS = 20_000;
const CRON_INTERVAL_MINUTES = 5;

export async function handleD1MirrorCron(env: Env, scheduledTime: number = Date.now()): Promise<void> {
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

  if (new Date(scheduledTime).getUTCMinutes() >= CRON_INTERVAL_MINUTES) return;
  try {
    await runMirrorReconcile(env, { runsPerDay: 24 });
  } catch (error) {
    recordErrorEvent(env, {
      event: "d1_reconcile_failed",
      component: "d1_mirror_cron",
      operation: "reconcile",
      error,
    });
  }
}
