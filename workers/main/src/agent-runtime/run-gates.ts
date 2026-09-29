/**
 * The gates before a run of a thread's agent on the hosted runtime, outside
 * any Durable Object (plans/runtime-threads-direct.md §4.2): the model the
 * thread resolves to now (picker, BYOK, gateway, credit fallback), its runtime
 * route, the acting user's limits, the key scope synced, and the spend limit
 * the run may use. ChatThreadDO's `prepareRuntimeRun` does the same for
 * runtime threads it still hosts; the thread-model choice is shared.
 */
import type { Model } from "@earendil-works/pi-ai";
import {
  CAMEL_CODE_LLM_MODEL,
  CUSTOM_LLM_MODEL,
  getStoredBedrockAwsRegion,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  isCreditFreeHostedModel,
  normalizeLlmModel,
} from "../../../../src/lib/llm-provider-config";
import { getEffectiveLlmProviderConfig, isSelfhostRuntime } from "../../../../src/lib/selfhost-ai-provider";
import { connectionsBindingEnabled } from "../../../../src/lib/connections-binding";
import type { LlmModel } from "../../../../src/types";
import type { ChatContextState, ChatEnv } from "../chat-thread/types";
import {
  checkHostedPiModelAccess,
  HostedModelFallbackRequiredError,
  primaryPiThinkingLevel,
  resolveCurrentByokCredentials,
  resolvePiModelConfig,
  resolvePiRequestConfig,
  type HostedModelFallbackReason,
  type LlmProviderConfigRecord,
  type PiResolvedModelConfig,
} from "../chat-thread/pi-model-config";
import { PiModelMapping } from "../pi-model-resolution";
import { assertUserLlmUsageAccess, UserLlmUsageLimitError } from "../user-llm-usage-policy";
import { createPiSystemPrompt } from "../pi-system-prompt";
import { resolveAgentSkillCatalog } from "../selfhost-agent-pack";
import { RUNTIME_PROMPT_PREAMBLE, type RuntimeRunConfig } from "../chat-thread/runtime-agent";
import { FREE_TIER_RUNTIME_MODEL, runtimeModelRoute, type RuntimeModelRoute } from "./model-routes";
import { HOSTED_KEY_SCOPE, ensureHostedKeyScope, hostedModelHeaders, selfhostOperatorEndpointOrigin, syncOrgKeyScope } from "./key-scopes";

type OrgInfoLike = {
  billing_status?: string | null;
  billing_credit_purchase_total_cents?: number | null;
  billing_credit_grant_total_cents?: number | null;
} | null;

/**
 * The model a thread runs now, from what OrgDO stores: its own model when it
 * has one (normalized for the org's provider), else the org's default; an org
 * that has nothing to pay with defaults to the free model.
 */
export function storedThreadModel(
  env: Parameters<typeof isSelfhostRuntime>[0] & Parameters<typeof getEffectiveLlmProviderConfig>[0],
  input: {
    thread: { model?: unknown; workspace_id?: unknown } | null;
    workspaceId: string;
    llmProviderRecord: LlmProviderConfigRecord;
    orgInfo: OrgInfoLike;
  },
): LlmModel {
  const { thread, workspaceId, orgInfo } = input;
  const threadWorkspaceId = thread && typeof thread === "object" && "workspace_id" in thread
    ? thread.workspace_id
    : null;
  const effectiveLlmProviderRecord = getEffectiveLlmProviderConfig(env, input.llmProviderRecord);
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderRecord);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderRecord);
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderRecord);
  const billingStatus = orgInfo?.billing_status ?? "inactive";
  const totalCreditsCents =
    (orgInfo?.billing_credit_purchase_total_cents ?? 0) +
    (orgInfo?.billing_credit_grant_total_cents ?? 0);
  const shouldDefaultToCamelCode = Boolean(
    orgInfo &&
      !isSelfhostRuntime(env) &&
      !effectiveLlmProviderRecord &&
      billingStatus !== "enterprise" &&
      billingStatus !== "trialing" &&
      billingStatus !== "active" &&
      totalCreditsCents <= 0,
  );
  const stored = thread && threadWorkspaceId === workspaceId
    ? (thread as { model?: unknown }).model
    : undefined;
  if (stored === CUSTOM_LLM_MODEL) {
    return normalizeLlmModel(stored, effectiveLlmProviderRecord?.provider, { customApi, customModelId });
  }
  if (stored !== undefined) {
    return isSelfhostRuntime(env)
      ? normalizeLlmModel(stored, effectiveLlmProviderRecord?.provider, { customApi, customModelId, awsRegion, allowCamelCode: false })
      : normalizeLlmModel(stored);
  }
  return shouldDefaultToCamelCode
    ? CAMEL_CODE_LLM_MODEL
    : normalizeLlmModel(undefined, effectiveLlmProviderRecord?.provider, { customApi, customModelId, awsRegion });
}

/** A thread's model moved to the free model because hosted access ran out. */
export interface ThreadModelFallback {
  fromModel: string;
  toModel: string;
  reason: HostedModelFallbackReason;
}

export interface ThreadRuntimeRoute {
  /** The thread's model after any credit fallback. */
  threadModel: LlmModel;
  config: PiResolvedModelConfig;
  route: RuntimeModelRoute | null;
  fallback: ThreadModelFallback | null;
  llmProviderRecord: LlmProviderConfigRecord;
}

type OrgStub = {
  getThread(id: string): Promise<{ model?: unknown; workspace_id?: unknown } | null>;
  getLlmProviderConfig(): Promise<LlmProviderConfigRecord>;
  getInfo(): Promise<OrgInfoLike & Record<string, unknown>>;
  updateThreadModel(id: string, model: LlmModel, actorId?: string, expectedModel?: LlmModel): Promise<{ model: string } | null>;
  getCreditChargeableSpendUsd(): Promise<number>;
  getUserLlmUsageLimits(userId: string): Promise<{ status: { limits?: Array<{ remaining_usd: number }> } }>;
  checkUserLlmUsageAccess: Parameters<typeof assertUserLlmUsageAccess>[0]["checkUserLlmUsageAccess"];
};

function orgStub(env: ChatEnv, orgId: string): OrgStub {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgStub;
}

/**
 * The model a thread resolves to now and how it runs on the runtime (null
 * route: it cannot). A thread whose hosted access ran out is moved to the free
 * model in OrgDO, as the DO does, unless someone changed its model meanwhile;
 * `persistFallback: false` only asks (the route is then the fallback's).
 */
export async function resolveThreadRuntimeRoute(
  env: ChatEnv,
  context: ChatContextState,
  options: { persistFallback?: boolean } = {},
): Promise<ThreadRuntimeRoute> {
  const org = orgStub(env, context.orgId);
  const [thread, llmProviderRecord, orgInfo] = await Promise.all([
    org.getThread(context.threadId),
    org.getLlmProviderConfig(),
    org.getInfo(),
  ]);
  let threadModel = storedThreadModel(env, { thread, workspaceId: context.workspaceId, llmProviderRecord, orgInfo });
  let fallback: ThreadModelFallback | null = null;
  let ranOn: string | null = null;
  const modelMapping = new PiModelMapping();
  const { getModel } = await import("@earendil-works/pi-ai/compat");
  const config = await resolvePiModelConfig(
    {
      env,
      modelMapping,
      resolveRequestConfig: (resolved, ctx, requestedModelId) => resolvePiRequestConfig(
        {
          env,
          modelMapping,
          getChatMetadata: () => context,
          resolveByokCredentials: (byokContext, options) =>
            resolveCurrentByokCredentials(env, async () => llmProviderRecord, byokContext, options),
          checkHostedModelAccess: (hostedContext, model) => checkHostedPiModelAccess(env, hostedContext, model),
        },
        resolved,
        ctx,
        requestedModelId,
      ),
      onBillingResolved: () => {},
      onHostedModelFallback: async (requestedModel, fallbackModel, reason) => {
        ranOn = fallbackModel;
        if (options.persistFallback === false) return;
        const updated = await org.updateThreadModel(
          context.threadId,
          fallbackModel as LlmModel,
          context.userId ?? undefined,
          normalizeLlmModel(requestedModel),
        );
        // Someone chose another model while access was checked: theirs stands
        // for the next run; this one runs on the fallback.
        if (updated) fallback = { fromModel: requestedModel, toModel: fallbackModel, reason };
      },
    },
    context,
    { CHIRIDION_MODEL: threadModel },
    getModel as unknown as (provider: never, modelId: never) => Model<any>,
  );
  if (ranOn) threadModel = ranOn as LlmModel;
  const route = runtimeModelRoute(config, {
    orgId: context.orgId,
    freeTier: isCreditFreeHostedModel(threadModel),
    operatorEndpointOrigin: selfhostOperatorEndpointOrigin(env),
  });
  return { threadModel, config, route, fallback, llmProviderRecord };
}

export class RuntimeRunRefused extends Error {
  constructor(message: string, readonly code: "no_route" | "usage_limit" | "hosted_access" | "not_configured") {
    super(message);
    this.name = "RuntimeRunRefused";
  }
}

export interface PreparedRuntimeRun extends RuntimeRunConfig {
  threadModel: LlmModel;
  thinkingLevel: "medium" | "high";
  fallback: ThreadModelFallback | null;
}

/** Milliseconds per step of one send, for its timing event (runtime-thread-telemetry). */
export type SendTimings = Partial<Record<
  "ban" | "prepare" | "route" | "access" | "keyScope" | "credit" | "limits" | "spent"
  | "configure" | "activity" | "patch" | "uploads" | "prompt",
  number
>>;

/** Run `step` and add how long it took to `timings` under `name`. */
export async function timed<T>(timings: SendTimings | undefined, name: keyof SendTimings, step: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await step();
  } finally {
    if (timings) timings[name] = (timings[name] ?? 0) + Date.now() - started;
  }
}

/**
 * Before a run, as `userId` (null: nobody's limits apply): the thread's route,
 * then at once the per-user gates, the key scope synced, and the spend limit
 * the run may use, the least of the org's hosted credit left and the user's
 * headroom. Throws RuntimeRunRefused when the run may not start.
 */
export async function prepareThreadRuntimeRun(
  env: ChatEnv,
  context: ChatContextState,
  userId: string | null,
  timings?: SendTimings,
): Promise<PreparedRuntimeRun> {
  let resolved: ThreadRuntimeRoute;
  try {
    resolved = await timed(timings, "route", () => resolveThreadRuntimeRoute(env, context));
  } catch (error) {
    if (error instanceof HostedModelFallbackRequiredError) throw new RuntimeRunRefused(error.message, "hosted_access");
    throw error;
  }
  const { route, config, threadModel, fallback } = resolved;
  if (!route) throw new RuntimeRunRefused("This thread's model cannot run on the agent runtime; switch models to continue.", "no_route");
  const org = orgStub(env, context.orgId);
  const access = async () => {
    if (!userId) return;
    // Limits are checked against the model the runtime will call (the free
    // tier's runtime model is not the in-DO loop's dynamic route).
    const gated = route.kind === "scope" && route.model === FREE_TIER_RUNTIME_MODEL
      ? { provider: "openrouter", model: "openai/gpt-6-luna" }
      : { provider: config.usageProvider || config.model.provider, model: config.model.id };
    try {
      await assertUserLlmUsageAccess(org, {
        env,
        orgId: context.orgId,
        workspaceId: context.workspaceId,
        threadId: context.threadId,
        userId,
        ...gated,
      });
    } catch (error) {
      if (error instanceof UserLlmUsageLimitError) throw new RuntimeRunRefused(error.message, "usage_limit");
      throw error;
    }
  };
  const keyScope = async () => {
    if (route.kind !== "scope") return;
    if (route.keyScope === HOSTED_KEY_SCOPE) {
      if (!await ensureHostedKeyScope(env)) throw new RuntimeRunRefused("Hosted models are not configured for the agent runtime.", "not_configured");
    } else {
      await syncOrgKeyScope(env, context.orgId, resolved.llmProviderRecord);
    }
  };
  const credit = async () => config.billingSource === "hosted" && config.creditChargeable
    ? await hostedCreditRemainingUsd(org)
    : null;
  const limits = async () => userId
    ? ((await org.getUserLlmUsageLimits(userId)).status.limits ?? []).map((limit) => limit.remaining_usd)
    : [];
  // None depends on another: one round of RPCs, not four.
  const [, , creditLeft, userHeadroom] = await Promise.all([
    timed(timings, "access", access),
    timed(timings, "keyScope", keyScope),
    timed(timings, "credit", credit),
    timed(timings, "limits", limits),
  ]);
  const budgets = [...(creditLeft !== null ? [creditLeft] : []), ...userHeadroom];
  return {
    model: route.model,
    keyScope: route.kind === "scope" ? route.keyScope : null,
    spendLimitUsd: budgets.length > 0 ? Math.max(0, Math.min(...budgets)) : null,
    modelHeaders: route.kind === "scope" && route.keyScope === HOSTED_KEY_SCOPE ? hostedModelHeaders(context) : null,
    threadModel,
    thinkingLevel: primaryPiThinkingLevel(threadModel),
    fallback,
  };
}

/**
 * The org's hosted credit left, in USD (checkHostedPiModelAccess's
 * arithmetic); null when unmetered. Spend is OrgDO's running all-time
 * credit-chargeable total, so this is O(1).
 */
async function hostedCreditRemainingUsd(org: OrgStub): Promise<number | null> {
  const [info, spentUsd] = await Promise.all([org.getInfo(), org.getCreditChargeableSpendUsd()]);
  if (!info || info.billing_status === "enterprise") return null;
  const spentCents = Math.round(Number(spentUsd ?? 0) * 100);
  const totalCents = Number(info.billing_credit_purchase_total_cents ?? 0) + Number(info.billing_credit_grant_total_cents ?? 0);
  return Math.max(0, totalCents - spentCents) / 100;
}

/** The instructions a new runtime agent is created with: the runtime preamble, then chiridion's prompt. */
export function runtimeSystemPromptAppend(env: ChatEnv, context: ChatContextState): string {
  const catalog = resolveAgentSkillCatalog(env);
  const base = createPiSystemPrompt(context, {
    skillNames: catalog.skillNames,
    skillDescriptions: catalog.skillDescriptions,
    promptPrepend: catalog.promptPrepend,
    promptAppend: catalog.promptAppend,
    deployedConnectionsBindingEnabled: connectionsBindingEnabled(env),
  });
  return `${RUNTIME_PROMPT_PREAMBLE}\n\n${base}`;
}
