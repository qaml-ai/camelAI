/**
 * The hosted agent runtime's webhook for run and input events of chiridion's
 * runtime threads (POST /agent-runtime/events; plans/runtime-threads-direct.md
 * §4.5). Each is a Standard Webhooks envelope `{id, type, created, data}`,
 * signed with AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET and delivered at least once:
 * deduplicated by `id`.
 *
 * - run.started: the thread shows as running in the sidebar.
 * - run.completed / run.failed: it goes idle, its completion (and a failure's
 *   error) is recorded on the thread, and its summary generated, as
 *   ChatThreadDO does at a turn's end. A stop is no error: the stopped turn
 *   (code "aborted") goes idle with no error, and the messages queued behind it
 *   that the stop cancelled (code "cancelled") change nothing.
 * - input.requested: on a channel or scheduled thread, where nobody is at a
 *   computer to answer, the input is cancelled at once (ChatThreadDO answers
 *   such a thread's questions the same way). A web thread's page reads its
 *   inputs live.
 * - input.resolved: nothing.
 * - run.completed / run.failed of a scheduled prompt's run also finish that
 *   run in WorkspaceCronDO (agent-runtime/scheduled-turns.ts).
 * - usage.recorded: a model response's usage, recorded in the org's usage_log
 *   (agent-runtime/usage.ts).
 *
 * A run's thread comes from the metadata chiridion put on the message that
 * started it (runtimeMessageMetadata), else from the agent's remembered thread.
 */
import type { Env, RouteContext } from "../types.js";
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import { runtimeThreadMetadata } from "../agent-runtime/thread-metadata.js";
import { recordWorkspaceThreadStreaming } from "../thread-status.js";
import { runtimeAgentThreadKey, runtimeHistoryPage } from "../agent-runtime/thread-runtime.js";
import { RuntimeApiError, runtimeApi } from "../agent-runtime/runtime-api.js";
import { verifyStandardWebhook } from "../agent-runtime/webhooks.js";
import { recordRuntimeUsage, type RuntimeUsageRecorded } from "../agent-runtime/usage.js";
import { extractThreadCompletionSummarySource } from "../../../../src/lib/thread-completion-summary-generation.server";
import { recordErrorEvent, recordObservabilityEvent } from "../observability.js";

/** Event ids already handled are kept this long: past the runtime's 3 days of retries. */
const SEEN_TTL_SECONDS = 4 * 24 * 60 * 60;

export interface RuntimeEventEnvelope {
  id: string;
  type: string;
  created: number;
  data: {
    agentId?: string;
    requestId?: string;
    method?: string;
    metadata?: Record<string, string>;
    stopped?: string;
    steeredInto?: string;
    replyIndex?: number;
    error?: string;
    code?: string;
    [key: string]: unknown;
  };
}

type ThreadRef = { org: string; workspace: string; thread: string };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function seenKey(id: string): string {
  return `agent-runtime:event:${id}`;
}

/** The thread a run belongs to, from its message's metadata or the agent's remembered thread. */
async function threadOf(env: Env, data: RuntimeEventEnvelope["data"]): Promise<ThreadRef | null> {
  const metadata = data.metadata ?? {};
  if (text(metadata.org) && text(metadata.workspace) && text(metadata.thread)) {
    return { org: text(metadata.org), workspace: text(metadata.workspace), thread: text(metadata.thread) };
  }
  const agentId = text(data.agentId);
  if (!agentId) return null;
  const stored = await env.APP_KV.get<ThreadRef>(runtimeAgentThreadKey(agentId), "json");
  return stored && text(stored.org) && text(stored.workspace) && text(stored.thread) ? stored : null;
}


/** The text of the run's final reply, for the thread's completion summary. */
async function replyText(env: Env, agentId: string, replyIndex: unknown): Promise<string | null> {
  if (typeof replyIndex !== "number" || !Number.isSafeInteger(replyIndex) || replyIndex < 0) return null;
  try {
    const page = await runtimeHistoryPage(env as unknown as ChatEnv, agentId, { limit: 1, before: replyIndex + 1 });
    return extractThreadCompletionSummarySource(page.entries.filter((entry) => entry.index <= replyIndex).map((entry) => entry.message));
  } catch (error) {
    console.warn("[agent-runtime-events] could not read the run's reply", error);
    return null;
  }
}

/** The `source` a scheduled prompt's messages carry in their metadata. */
const SCHEDULED_RUN_SOURCE = "scheduled prompt";

/** Threads nobody watches from a browser: their inputs are cancelled. */
const UNATTENDED_THREAD_SOURCES = new Set(["channel", "scheduled"]);

/**
 * Cancel an input of an unattended thread's agent. The answer names the
 * person it was for (the run's actor), as the runtime requires; an input
 * already settled is left as it is.
 */
async function cancelUnattendedInput(env: Env, agentId: string, inputId: string): Promise<void> {
  const base = `/v1/agents/${encodeURIComponent(agentId)}/inputs/${encodeURIComponent(inputId)}`;
  const input = await runtimeApi(env, "GET", base) as { state?: unknown; responders?: { audience?: unknown } } | null;
  if (input?.state !== "pending") return;
  const audience = Array.isArray(input.responders?.audience) ? input.responders.audience : [];
  const actor = typeof audience[0] === "string" ? audience[0] : null;
  try {
    await runtimeApi(env, "POST", base, { action: "cancel", ...(actor ? { actor } : {}) });
  } catch (error) {
    // Someone (or the input's expiry) settled it first.
    if (!(error instanceof RuntimeApiError && error.status === 409)) throw error;
  }
}

/** Handle one event; false when it is not for a thread chiridion knows (acknowledged all the same). */
export async function handleRuntimeEvent(
  env: Env,
  event: RuntimeEventEnvelope,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<boolean> {
  const { data } = event;
  if (event.type === "usage.recorded") {
    return recordRuntimeUsage(env, event.id, data as unknown as RuntimeUsageRecorded);
  }
  if (!event.type.startsWith("run.") && event.type !== "input.requested") return true;
  const agentId = text(data.agentId);
  const ref = await threadOf(env, data);
  if (!agentId || !ref) return false;
  const org = env.ORG.get(env.ORG.idFromName(ref.org)) as unknown as {
    getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
    getThread(threadId: string): Promise<{ source?: string | null } | null>;
    recordThreadError(threadId: string, input: { message: string; source?: string; errorKind?: string }): Promise<unknown>;
  };
  // Only a runtime thread whose agent this is (not a deleted or re-pinned one).
  const row = await org.getThreadRuntime(ref.thread);
  if (row?.agentId !== agentId) return false;
  if (event.type === "input.requested") {
    const inputId = text(data.inputId);
    const thread = await org.getThread(ref.thread);
    if (inputId && UNATTENDED_THREAD_SOURCES.has(text(thread?.source))) {
      await cancelUnattendedInput(env, agentId, inputId);
    }
    return true;
  }
  const context: ChatContextState = {
    orgId: ref.org,
    workspaceId: ref.workspace,
    threadId: ref.thread,
    userId: null,
    userName: null,
    userEmail: null,
  };

  if (event.type === "run.started") {
    await recordWorkspaceThreadStreaming(env, ref.workspace, ref.thread, true);
    return true;
  }
  if (event.type !== "run.completed" && event.type !== "run.failed") return true;
  // A message the running turn took: that turn's own events settle the thread.
  if (text(data.steeredInto)) return true;
  // The turn waits on a person: not running, and not finished either.
  if (event.type === "run.completed" && data.stopped === "input_required") {
    await recordWorkspaceThreadStreaming(env, ref.workspace, ref.thread, false, { clearOnlyIfRunning: true });
    return true;
  }
  const completedAt = Math.round((Number.isFinite(event.created) ? event.created : Date.now() / 1000) * 1000);
  // A person stopped the agent: the stopped turn ends "aborted", the runs
  // queued behind it "cancelled".
  const code = event.type === "run.failed" ? text(data.code) : "";
  const stopped = code === "aborted" || code === "cancelled";
  if (event.type === "run.failed" && !stopped) {
    await org.recordThreadError(ref.thread, {
      message: text(data.error) || "The agent run failed",
      source: "agent_runtime",
      errorKind: "run_failed",
    });
  }
  // A scheduled prompt's run (its request id is the run's): finish the run as
  // its outcome report and this end say (WorkspaceCronDO.finishScheduledRun).
  if (data.metadata?.source === SCHEDULED_RUN_SOURCE && env.WORKSPACE_CRON) {
    const cron = env.WORKSPACE_CRON.get(env.WORKSPACE_CRON.idFromName(ref.workspace));
    await cron.finishScheduledRun({
      workspaceId: ref.workspace,
      runId: text(data.requestId),
      error: event.type === "run.failed" ? text(data.error) || "The agent run failed" : null,
      completedAt,
    });
  }
  // A cancelled run never began: the stopped turn's own event settles the
  // thread, and one arriving late must not end a run started since.
  if (code === "cancelled") return true;
  const summarySource = event.type === "run.completed" ? await replyText(env, agentId, data.replyIndex) : null;
  // Clears the running row, then records the completion; its summary (a model
  // call) finishes after the runtime has its acknowledgement.
  const done = runtimeThreadMetadata(env, context, waitUntil).recordThreadAssistantCompletion(context, completedAt, summarySource);
  waitUntil(done.catch((error) => console.error("[agent-runtime-events] completion bookkeeping failed", error)));
  return true;
}

export async function handleAgentRuntimeEventsRequest(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  const secret = env.AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET?.trim();
  if (!secret) return Response.json({ error: "Runtime events webhook is not configured" }, { status: 503 });
  const body = await req.text();
  if (!await verifyStandardWebhook(secret, req.headers, body)) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  let event: RuntimeEventEnvelope;
  try {
    event = JSON.parse(body) as RuntimeEventEnvelope;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!event || !text(event.id) || !text(event.type) || !event.data || typeof event.data !== "object") {
    return Response.json({ error: "Not an event" }, { status: 400 });
  }
  if (await env.APP_KV.get(seenKey(event.id))) return new Response(null, { status: 204 });
  // A failure here answers 500, so the runtime delivers the event again.
  let handled: boolean;
  try {
    handled = await handleRuntimeEvent(env, event, waitUntil);
  } catch (error) {
    recordErrorEvent(env, {
      event: "runtime_event_handler_failed",
      component: "agent_runtime_events",
      operation: event.type,
      status: "failed",
      requestId: event.id,
      error,
    });
    throw error;
  }
  if (!handled) {
    console.warn("[agent-runtime-events] event for no known runtime thread", { id: event.id, type: event.type });
    recordObservabilityEvent(env, {
      event: "runtime_event_unknown_thread",
      severity: "warn",
      component: "agent_runtime_events",
      operation: event.type,
      status: "unknown_thread",
      requestId: event.id,
    });
  }
  await env.APP_KV.put(seenKey(event.id), "1", { expirationTtl: SEEN_TTL_SECONDS });
  return new Response(null, { status: 204 });
}

export async function handleAgentRuntimeEvents({ req, env, ctx }: RouteContext): Promise<Response> {
  return handleAgentRuntimeEventsRequest(req, env, (promise) => ctx.waitUntil(promise));
}
