import { HOSTED_KEY_SCOPE } from "../agent-runtime/key-scopes.js";
import { runtimeThreadMetadata } from "../agent-runtime/thread-metadata.js";
import { recordRuntimeUsage } from "../agent-runtime/usage.js";
import { verifyV2Webhook } from "../agent-runtime/webhooks.js";
import { recordWorkspaceThreadStreaming } from "../thread-status.js";
import type { RouteContext } from "../types.js";

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const tokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Receives usage from Chiridion's dedicated hosted v2 tenant. */
export async function handleAgentRuntimeV2Events({ req, env, ctx }: Pick<RouteContext, "req" | "env"> & Partial<Pick<RouteContext, "ctx">>): Promise<Response> {
  const secret = env.AGENT_RUNTIME_V2_EVENTS_WEBHOOK_SECRET?.trim();
  const tenant = env.AGENT_RUNTIME_V2_TENANT?.trim();
  if (!secret || !tenant) return Response.json({ error: "Runtime v2 events webhook is not configured" }, { status: 503 });
  const body = await req.text();
  if (!await verifyV2Webhook(secret, req.headers, body)) {
    return Response.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  let event: {
    id?: unknown;
    type?: unknown;
    tenantId?: unknown;
    createdAt?: unknown;
    data?: {
      agentId?: unknown;
      actor?: unknown;
      model?: unknown;
      kind?: unknown;
      input?: unknown;
      output?: unknown;
      text?: unknown;
      error?: { message?: unknown };
      cost?: { usd?: unknown; source?: unknown };
      context?: { org?: unknown; workspace?: unknown; thread?: unknown };
    };
  } | null;
  try {
    event = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (event?.tenantId !== tenant) {
    return Response.json({ error: "Unexpected runtime tenant" }, { status: 403 });
  }
  const id = text(event.id);
  const usage = event.data;
  const modelRoute = text(usage?.model);
  const separator = modelRoute.indexOf("/");
  const agentId = text(usage?.agentId);
  const actor = text(usage?.actor);
  const orgId = text(usage?.context?.org);
  const workspaceId = text(usage?.context?.workspace);
  const threadId = text(usage?.context?.thread);
  if (
    !id || !agentId || !actor || !orgId || !workspaceId || !threadId ||
    !tokenCount(event.createdAt) || event.createdAt === 0
  ) {
    return Response.json({ error: "Invalid v2 thread event" }, { status: 400 });
  }
  const org = env.ORG.get(env.ORG.idFromName(orgId));
  const [thread, runtime] = await Promise.all([org.getThread(threadId), org.getThreadRuntime(threadId)]);
  if (thread?.workspace_id !== workspaceId || runtime?.agentId !== agentId ||
      runtime.runtimeVersion !== "v2" || runtime.keyScope !== HOSTED_KEY_SCOPE) {
    return Response.json({ error: "Event does not match a hosted v2 thread" }, { status: 409 });
  }
  if (event.type !== "usage.recorded") {
    const completedAt = thread.last_assistant_completed_at ?? 0;
    if (completedAt >= event.createdAt) return new Response(null, { status: 204 });
    if (event.type === "run.started" || event.type === "run.resumed") {
      await recordWorkspaceThreadStreaming(env, workspaceId, threadId, true, { startedAt: event.createdAt });
    } else if (event.type === "run.input_required" || event.type === "run.cancelled") {
      await recordWorkspaceThreadStreaming(env, workspaceId, threadId, false, {
        clearOnlyIfRunning: true, clearRunningStartedAtOrBefore: event.createdAt,
      });
    } else if (event.type === "run.completed" || event.type === "run.failed") {
      if (event.type === "run.failed") {
        await org.recordThreadError(threadId, {
          message: text(usage?.error?.message) || "The v2 run failed",
          source: "agent_runtime", errorKind: "run_failed", createdAt: event.createdAt,
        });
      }
      const context = { orgId, workspaceId, threadId, userId: actor, userName: null, userEmail: null };
      await runtimeThreadMetadata(env, context, (promise) => ctx?.waitUntil(promise))
        .recordThreadAssistantCompletion(context, event.createdAt, text(usage?.text) || null);
    } else {
      return Response.json({ error: "Unsupported v2 thread event" }, { status: 400 });
    }
    return new Response(null, { status: 204 });
  }
  if (
    separator < 1 || separator === modelRoute.length - 1 ||
    (usage?.kind !== "response" && usage?.kind !== "compaction") ||
    !tokenCount(usage.input) || !tokenCount(usage.output) ||
    usage.cost?.source !== "catalog" || typeof usage.cost.usd !== "number" ||
    !Number.isFinite(usage.cost.usd) || usage.cost.usd < 0
  ) {
    return Response.json({ error: "Invalid v2 usage event" }, { status: 400 });
  }
  await recordRuntimeUsage(env, `v2:${id}`, {
    agentId,
    actor,
    context: { org: orgId, workspace: workspaceId, thread: threadId },
    keyScope: HOSTED_KEY_SCOPE,
    provider: modelRoute.slice(0, separator),
    model: modelRoute.slice(separator + 1),
    kind: usage.kind,
    input: usage.input,
    output: usage.output,
    cost: { usd: usage.cost.usd, source: "catalog" },
    at: event.createdAt,
  });
  return new Response(null, { status: 204 });
}
