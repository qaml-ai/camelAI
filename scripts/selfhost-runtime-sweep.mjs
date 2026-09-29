/**
 * Drives the self-host thread sweep from the app's startup process
 * (selfhost-workerd-serve.mjs), in the background, through the admin API
 * (workers/main/src/routes/admin/selfhost-sweep-routes.ts): it begins a pass
 * once the app answers, advances it one bounded step at a time, waits out
 * retries, and after a complete pass looks again every few hours for threads
 * still not moved. Progress goes to the log; state lives in
 * D1, so a restart resumes it. SELFHOST_RUNTIME_SWEEP=0 turns it off.
 */

const SWEEP_PATH = "/api/admin/selfhost/runtime-sweep";
const RECHECK_COMPLETE_MS = 6 * 60 * 60_000;
const RECHECK_BLOCKED_MS = 10 * 60_000;
const MAX_WAIT_MS = 10 * 60_000;
const ERROR_BACKOFF_MS = 30_000;
/**
 * How long one step may take: its budget, then the moves it started (up to
 * DEFAULT_MOVE_TIMEOUT_MS each), with room to spare (selfhost-sweep.ts, MAX_STEP_MS).
 */
const STEP_TIMEOUT_MS = 5 * 60_000;
/** How long to wait when another step holds the step lease. */
const STEP_BUSY_MS = 5_000;

export function sweepSummary(state) {
  const counts = state.counts ?? {};
  const base = `pass ${state.pass}: ${counts.migrated ?? 0} moved, ${counts.retrying ?? 0} to retry, ${counts.skipped ?? 0} skipped`;
  switch (state.status) {
    case "complete":
      return `complete (${base}; ${state.remaining ?? 0} not moved)`;
    case "waiting":
      return `waiting for retries (${base}), next pass ${new Date(state.nextPassAt ?? Date.now()).toISOString()}`;
    case "blocked":
      return `blocked: ${state.error}`;
    default:
      if (state.pausedUntil && state.pausedUntil > Date.now()) {
        return `paused until ${new Date(state.pausedUntil).toISOString()}: ${state.error ?? "the agent runtime is failing"} (${base})`;
      }
      return `${state.status} (${base})`;
  }
}

/**
 * Run the sweep until `signal` aborts. `sleep` and `now` are injectable for
 * tests; `maxSteps` bounds a test run.
 *
 * @param {{
 *   baseUrl: string, adminKey: string, fetchImpl?: typeof fetch, log?: Console,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>, now?: () => number,
 *   signal?: AbortSignal, concurrency?: number, maxSteps?: number,
 * }} options
 */
export async function driveRuntimeSweep({
  baseUrl,
  adminKey,
  fetchImpl = globalThis.fetch,
  log = console,
  sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  }),
  now = Date.now,
  signal,
  concurrency,
  maxSteps = Infinity,
}) {
  const call = async (method, body) => {
    const response = await fetchImpl(`${baseUrl}${SWEEP_PATH}`, {
      method,
      headers: { Authorization: `Bearer ${adminKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${SWEEP_PATH}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  let started = false;
  let last = "";
  let steps = 0;
  while (!signal?.aborted && steps < maxSteps) {
    steps += 1;
    let state;
    try {
      state = started ? await call("POST", { action: "step", ...(concurrency ? { concurrency } : {}) }) : await call("POST", { action: "start" });
      started = true;
    } catch (error) {
      log.warn?.(`[selfhost:runtime-sweep] ${error instanceof Error ? error.message : String(error)}; retrying`);
      await sleep(ERROR_BACKOFF_MS, signal);
      continue;
    }
    const summary = sweepSummary(state);
    if (summary !== last) {
      log.log?.(`[selfhost:runtime-sweep] ${summary}`);
      last = summary;
    }
    if (state.status === "running") {
      // Another step holds the lease, or the breaker paused the sweep: wait, then step again.
      if (state.stepInProgress) await sleep(STEP_BUSY_MS, signal);
      else if (state.pausedUntil && state.pausedUntil > now()) await sleep(Math.min(state.pausedUntil - now(), MAX_WAIT_MS), signal);
      continue;
    }
    if (state.status === "waiting") {
      await sleep(Math.min(Math.max(1_000, (state.nextPassAt ?? now()) - now()), MAX_WAIT_MS), signal);
      continue;
    }
    // Complete, blocked or idle: look again later with a new pass.
    await sleep(state.status === "complete" ? RECHECK_COMPLETE_MS : RECHECK_BLOCKED_MS, signal);
    started = false;
  }
}

/**
 * What selfhost:doctor says about a sweep report (GET SWEEP_PATH): a level
 * (pass when every thread is on the runtime; warn while it runs, waits, or
 * had to skip some), a summary, and the threads not moved, grouped by reason.
 */
export function sweepDoctorReport(report, { limit = 10 } = {}) {
  const lines = [sweepSummary(report)];
  const describe = (records, label) => {
    const byReason = new Map();
    for (const record of records ?? []) {
      const reason = record.reason.replace(/^(busy|failed|backoff|gave up after \d+ attempts|invalid_history|refused_\d+|too_large): .*$/, "$1");
      byReason.set(reason, [...(byReason.get(reason) ?? []), record]);
    }
    for (const [reason, records] of byReason) {
      const shown = records.slice(0, limit).map((record) => `${record.orgId}/${record.threadId}`).join(", ");
      lines.push(`${label} (${reason}): ${records.length}${records.length ? ` - ${shown}${records.length > limit ? ", ..." : ""}` : ""}`);
    }
  };
  describe(report.skipped, "skipped");
  describe(report.retrying, "retrying");
  if (report.status === "idle") return { level: "warn", lines: ["the sweep has not run yet (the app starts it)"] };
  if (report.status === "blocked") return { level: "warn", lines };
  if (report.status === "complete" && !report.remaining) return { level: "pass", lines };
  return { level: "warn", lines };
}

/** Wait until the app answers its health check. */
export async function waitForApp({ baseUrl, fetchImpl = globalThis.fetch, signal, intervalMs = 2_000 }) {
  while (!signal?.aborted) {
    try {
      const response = await fetchImpl(`${baseUrl}/api/selfhost/health`, { signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel?.();
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
