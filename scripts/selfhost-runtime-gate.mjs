/**
 * The version gate for the release that deletes the in-app chat loop
 * (ChatThreadDO's own model loop): such a release must not start on an
 * install whose threads have not all moved to the agent runtime, since it
 * could no longer run or export them. The thread sweep of the releases before
 * it (workers/main/src/agent-runtime/selfhost-sweep.ts) moves them and
 * records, in D1, when a pass ended with nothing left to retry and how many
 * threads it had to skip; selfhost-d1-migrate.mjs reads that record, with the
 * number of orgs, before workerd starts, and refuses to go on when this gate
 * says so.
 *
 * The release that deleted the in-app loop kept a read-only exporter instead
 * (ChatThreadDO still moves its threads, when opened and by the sweep), so
 * this gate stays inert there: an install can jump any number of versions.
 * It turns on only in a release that removes the exporter too (after its
 * support window, SELF_HOSTING.md "Moving existing threads").
 */

/** True in a release that can no longer move threads (the exporter removed); the gate only refuses there. */
export const IN_APP_LOOP_REMOVED = false;

export const RUNTIME_MIGRATION_DOC = "SELF_HOSTING.md#moving-existing-threads";

/**
 * Whether this release may start: `sweep` is the D1 record (null when this
 * install never ran the sweep), `orgCount` the orgs in D1 (0: a new install,
 * with no threads to move). `allowUnmigrated` is the operator's explicit
 * acknowledgement (SELFHOST_ALLOW_UNMIGRATED_THREADS=1) that the threads the
 * sweep skipped will no longer open.
 *
 * @param {{ sweep: any, orgCount: number, allowUnmigrated?: boolean, loopRemoved?: boolean }} input
 * @returns {{ ok: boolean, message: string | null }}
 */
export function runtimeMigrationGate({ sweep, orgCount, allowUnmigrated = false, loopRemoved = IN_APP_LOOP_REMOVED }) {
  if (!loopRemoved) return { ok: true, message: null };
  if (!orgCount) return { ok: true, message: null };
  const help = `See ${RUNTIME_MIGRATION_DOC}.`;
  if (!sweep || !sweep.pass) {
    return {
      ok: false,
      message:
        "This release no longer runs chat threads inside the app, and this install's threads were never moved to the agent runtime " +
        "(it skipped the releases that move them). Install the last release with the thread sweep first, let `bun run selfhost:doctor` " +
        `report the sweep complete, then upgrade to this one. ${help}`,
    };
  }
  // A complete pass counts while a later one rechecks (every start, every six
  // hours): the threads it had left are what `completedRemaining` says.
  const completedBefore = sweep.completedAt && sweep.completedRemaining !== null && sweep.completedRemaining !== undefined;
  const finished = sweep.status === "complete" && sweep.completedAt;
  const waitingAccepted = allowUnmigrated && sweep.status === "waiting";
  if (!finished && !completedBefore && !waitingAccepted) {
    return {
      ok: false,
      message:
        `The thread sweep has not finished (status ${sweep.status}, pass ${sweep.pass}: ${sweep.counts?.migrated ?? 0} moved, ` +
        `${sweep.counts?.retrying ?? 0} to retry, ${sweep.counts?.skipped ?? 0} skipped). Run the previous release until ` +
        `\`bun run selfhost:doctor\` reports it complete, then upgrade. ${help}`,
    };
  }
  const remaining = Number((finished ? sweep.remaining : completedBefore ? sweep.completedRemaining : sweep.remaining) ?? 0);
  if (remaining > 0 && !allowUnmigrated) {
    return {
      ok: false,
      message:
        `${remaining} chat thread${remaining === 1 ? " was" : "s were"} not moved to the agent runtime (\`bun run selfhost:doctor\` lists why) ` +
        "and would no longer open in this release. Fix what the doctor reports on the previous release, or set " +
        `SELFHOST_ALLOW_UNMIGRATED_THREADS=1 to upgrade without them. ${help}`,
    };
  }
  return {
    ok: true,
    message: remaining > 0 ? `Starting with ${remaining} thread(s) left on the in-app loop (SELFHOST_ALLOW_UNMIGRATED_THREADS=1).` : null,
  };
}
