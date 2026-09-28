/**
 * The runtime's `usage.recorded` events: one per model response of
 * chiridion's runtime agents, delivered to /agent-runtime/events. Each becomes
 * a usage_log row of the org in the agent's `context`, as the acting user
 * (actor, else subject), idempotent by the event id. Billing follows the key
 * scope: `hosted` is camelAI's (credit-chargeable unless the org is enterprise
 * or it is the free tier's model), an org scope or the Codex forwarder is the
 * org's own (BYOK).
 */
import type { Env } from "../types.js";
import { FREE_TIER_RUNTIME_MODEL, RUNTIME_MODEL_ENDPOINT } from "./model-routes.js";
import { HOSTED_KEY_SCOPE } from "./key-scopes.js";
import { recordWorkspaceThreadStreaming } from "../thread-status.js";

/** A `usage.recorded` event's `data`. */
export interface RuntimeUsageRecorded {
  agentId: string;
  requestId?: string | null;
  subject?: string;
  actor?: string | null;
  context?: Record<string, unknown>;
  keyScope?: string | null;
  provider: string;
  model: string;
  kind?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: { usd?: number; source?: "provider" | "catalog" };
  at?: number;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** The usage_log row an event becomes (the provider and model as chiridion names them). */
export function usageRowFor(eventId: string, data: RuntimeUsageRecorded, org: { billing_status?: unknown } | null) {
  const hosted = data.keyScope === HOSTED_KEY_SCOPE;
  let provider = text(data.provider);
  let model = text(data.model);
  // The Codex forwarder is a tenant endpoint: `chiridion/openai-codex/<model>`.
  if (provider === RUNTIME_MODEL_ENDPOINT && model.startsWith("openai-codex/")) {
    provider = "openai";
    model = model.slice("openai-codex/".length);
  }
  // chiridion's usage and pricing name Bedrock `bedrock`.
  if (provider === "amazon-bedrock") provider = "bedrock";
  const freeTier = `${provider}/${model}` === FREE_TIER_RUNTIME_MODEL;
  const context = data.context ?? {};
  return {
    workspace_id: text(context.workspace),
    // The runtime reports the agent itself as subject when it has none.
    user_id: text(data.actor) || (text(data.subject) !== text(data.agentId) ? text(data.subject) : ""),
    thread_id: text(context.thread),
    model: model || "unknown",
    provider: provider || "unknown",
    billing_source: hosted ? "hosted" : "byok",
    credit_chargeable: hosted && !freeTier && org?.billing_status !== "enterprise",
    usage_kind: "llm",
    usage_surface: data.kind === "compaction" ? "compaction" : "agent",
    input_tokens: count(data.input),
    output_tokens: count(data.output),
    cache_creation_input_tokens: count(data.cacheWrite),
    cache_read_input_tokens: count(data.cacheRead),
    ...(typeof data.cost?.usd === "number" && data.cost.usd > 0
      ? data.cost.source === "provider"
        ? { reported_cost_usd: data.cost.usd }
        : { estimated_cost_usd: data.cost.usd }
      : {}),
    duration_ms: 0,
    created_at_ms: typeof data.at === "number" ? data.at : Date.now(),
    source: "agent_runtime",
    source_id: eventId,
  };
}

/** Record one event's usage; false when it names no org chiridion can bill (acknowledged all the same). */
export async function recordRuntimeUsage(env: Env, eventId: string, data: RuntimeUsageRecorded): Promise<boolean> {
  const orgId = text(data.context?.org);
  if (!orgId) return false;
  const org = env.ORG.get(env.ORG.idFromName(orgId));
  const info = await org.getInfo();
  // Idempotent by (source, source_id): a redelivery finds the row and inserts nothing.
  const row = usageRowFor(eventId, data, info);
  await org.recordUsage(row);
  // A model response means the run is still going: mark the thread running
  // (5-minute lease), which also brings back a row the sweeper cleared during
  // a long step. A response from before the thread's last completion is a
  // late delivery of a finished run: it only renews a row that is there.
  const running = async () => {
    const thread = row.thread_id ? await org.getThread(row.thread_id) : null;
    const completedAt = thread?.last_assistant_completed_at ?? null;
    // Completion times come from run events' `created`, whole seconds.
    const finished = completedAt !== null && completedAt + 1_000 >= row.created_at_ms;
    await recordWorkspaceThreadStreaming(env, row.workspace_id, row.thread_id, true, finished ? { refresh: true, source: "runtime_usage" } : undefined);
  };
  await running()
    .catch((error) => console.warn("[agent-runtime-usage] could not renew the thread's running lease", error));
  return true;
}
