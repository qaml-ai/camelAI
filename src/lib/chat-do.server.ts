import type { AppLoadContext } from "react-router";
import type { UIMessage } from "ai";
import type { ChatRenderHistoryPage } from "./chat-render-history";
import { getEnv, type CloudflareEnv } from "./cloudflare.server";
import type {
  Thread,
  Message,
  PaginatedResult,
  PaginationParams,
  LlmProvider,
  LlmModel,
  Organization,
  OrgModelPickerConfig,
  PreviewTarget,
  WorkspaceModelPickerConfig,
} from "@/types";
import {
  generateThreadTitleWithOpenAI,
} from "./thread-title-generation.server";
import { OrgDO, type OrgThread } from "../../workers/main/src/auth";
import { WorkspaceDO } from "../../workers/main/src/workspace";
import {
  CAMEL_CODE_LLM_MODEL,
  CUSTOM_LLM_MODEL,
  type CustomLlmProviderApi,
  type LlmProviderConfigRecord,
  getDefaultLlmModel,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  getStoredBedrockAwsRegion,
  isLlmModelCoveredByByokProvider,
  isLlmModelCoveredByOpenAiSubscription,
  isLlmModelAllowedForNewThread,
  isLlmModel,
  normalizeLlmModel,
} from "./llm-provider-config";
import { getEffectiveLlmProviderConfig } from "./selfhost-ai-provider";
import { isSelfhostRuntime } from "./selfhost-runtime";
import {
  MODEL_CATALOG,
  resolveModelPickerCatalog,
} from "./model-catalog";
import {
  deriveHostedCreditPause,
  findCheapestSelectableModel,
  type HostedCreditPauseBilling,
  type ModelPausedReason,
  type ModelPickerOption,
} from "./model-picker-access";
export type {
  ModelPausedReason,
  ModelPickerOption,
} from "./model-picker-access";
import { parseChannelIndicatorKindsJson } from "./channel-kinds";
import {
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from "./model-picker-config";
import { retryTransientDurableObjectRead } from "./do-rpc-retry.server";
import { truncateThreadPreviewText } from "./thread-preview";
import {
  buildThreadSearchMatch,
  parseThreadSearchTerms,
} from "./thread-search";
import { getThreadTitleSourceMessage } from "./thread-title";
import type { ThreadProjectActivity } from "./thread-project-activity";
import {
  isOrgBillingAccessReady,
  resolveOrgBillingAccess,
  type OrgBillingAccessState,
} from "./billing.server";

interface ParsedThreadMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: number;
  forkEntryId?: string;
  sentDuringStreaming?: boolean;
  isMeta?: boolean;
  sourceToolUseID?: string;
  isCompactSummary?: boolean;
}

export interface ThreadPreviewState {
  target: PreviewTarget | null;
  tabs: PreviewTarget[];
  activeTabId: string | null;
  version: number;
}

export interface RawThreadCreator {
  created_by: string;
  thread_count: number;
  latest_updated_at: number;
}

interface KnownOrgOptions {
  orgId?: string;
}

interface ModelPickerStateOptions extends KnownOrgOptions {
  llmProviderConfig?: LlmProviderConfigRecord | null;
  orgBillingState?: Pick<
    Organization,
    | "billing_status"
    | "billing_credit_purchase_total_cents"
    | "billing_credit_grant_total_cents"
  > | null;
}

export function normalizeStoredThreadModel(
  rawModel: unknown,
): { model: LlmModel } {
  return { model: normalizeLlmModel(rawModel) };
}

function normalizeRuntimeThreadModel(
  env: CloudflareEnv,
  rawModel: unknown,
): LlmModel {
  if (!isSelfhostRuntime(env)) {
    return normalizeStoredThreadModel(rawModel).model;
  }
  const providerConfig = getEffectiveLlmProviderConfig(env, null);
  return normalizeLlmModel(rawModel, providerConfig?.provider, {
    customApi: getStoredCustomLlmProviderApi(providerConfig),
    customModelId: getStoredCustomLlmProviderModelId(providerConfig),
    awsRegion: getStoredBedrockAwsRegion(providerConfig),
    allowCamelCode: false,
  });
}

// Full thread records are used by single-thread loaders and new-thread
// transcript hydration, so canonical message metadata must remain unbounded.
function toThread(env: CloudflareEnv, orgThread: OrgThread): Thread {
  const model = normalizeRuntimeThreadModel(env, orgThread.model);
  return {
    id: orgThread.id,
    workspace_id: orgThread.workspace_id,
    title: orgThread.title,
    created_by: orgThread.created_by,
    model,
    created_at: orgThread.created_at,
    updated_at: orgThread.updated_at,
    user_message_count: orgThread.user_message_count ?? 0,
    first_user_message: orgThread.first_user_message ?? null,
    last_user_message: orgThread.last_user_message ?? null,
    last_user_message_at: orgThread.last_user_message_at ?? null,
    last_assistant_completed_at: orgThread.last_assistant_completed_at ?? null,
    last_assistant_summary: orgThread.last_assistant_summary ?? null,
    last_assistant_summary_status:
      orgThread.last_assistant_summary_status ?? null,
    source: orgThread.source ?? "web",
    channel_kind: orgThread.channel_kind ?? null,
    channel_kinds: parseChannelIndicatorKindsJson(orgThread.channel_kinds),
    channel_connection_id: orgThread.channel_connection_id ?? null,
    channel_conversation_id: orgThread.channel_conversation_id ?? null,
    channel_message_id: orgThread.channel_message_id ?? null,
  };
}

// List and history surfaces should not serialize full prompt text. Keep this
// mapper separate from toThread so transcript hydration keeps full metadata.
function toThreadListPreview(
  env: CloudflareEnv,
  orgThread: OrgThread,
): Thread {
  const thread = toThread(env, orgThread);
  return {
    ...thread,
    first_user_message: truncateThreadPreviewText(thread.first_user_message, 500),
    last_user_message: truncateThreadPreviewText(thread.last_user_message, 500),
  };
}

// Helper to get workspace info and org ID
async function getWorkspaceInfo(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<{ org_id: string } | null> {
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  ) as unknown as WorkspaceDO;
  const info = await retryTransientDurableObjectRead("WorkspaceDO.getInfo", () =>
    wsStub.getInfo(),
  );
  if (!info) return null;
  return { org_id: info.org_id };
}

export interface WorkspaceModelPickerState {
  orgId: string;
  llmProvider: LlmProvider | null;
  customApi: CustomLlmProviderApi | null;
  customModelId: string | null;
  awsRegion: string | null;
  allowOpenAiSubscription: boolean;
  billingAccessMode: Extract<
    OrgBillingAccessState,
    { kind: "ready" }
  >["mode"] | null;
  modelOptions: ModelPickerOption[];
  allowedThreadModels: LlmModel[];
  effectivePickerDefaultModel: LlmModel | null;
  hasEffectivePickerDefault: boolean;
  defaultModel: LlmModel | null;
  canUnlockPremiumModels: boolean;
  hostedCreditsPaused: { reason: ModelPausedReason } | null;
  modelPickerSettingsHref: string;
}

const UNLOCKABLE_CATALOG_IDS = (
  Object.keys(MODEL_CATALOG) as LlmModel[]
).filter(
  (id) =>
    id !== CUSTOM_LLM_MODEL &&
    id !== CAMEL_CODE_LLM_MODEL,
);

export function isBillingLockedModel(
  modelId: LlmModel,
  args: { isFreeMode: boolean; allowOpenAiSubscription: boolean },
): boolean {
  if (!args.isFreeMode || modelId === CAMEL_CODE_LLM_MODEL) {
    return false;
  }
  return !(
    args.allowOpenAiSubscription &&
    isLlmModelCoveredByOpenAiSubscription(modelId)
  );
}

export function applyHostedCreditPause(
  pickerState: WorkspaceModelPickerState,
  billing: HostedCreditPauseBilling | null,
): WorkspaceModelPickerState {
  const pause = deriveHostedCreditPause({
    modelOptions: pickerState.modelOptions,
    billingAccessMode: pickerState.billingAccessMode,
    llmProvider: pickerState.llmProvider,
    allowOpenAiSubscription: pickerState.allowOpenAiSubscription,
    billing,
  });
  if (!pause.hostedCreditsPaused) {
    return {
      ...pickerState,
      hostedCreditsPaused: null,
    };
  }

  const { modelOptions } = pause;
  const allowedThreadModels = modelOptions
    .filter((entry) => !entry.locked)
    .map((entry) => entry.id);
  const lockedIds = new Set(
    modelOptions.filter((entry) => entry.locked).map((entry) => entry.id),
  );
  const fallbackModel = findCheapestSelectableModel(modelOptions)?.id ?? null;
  const replaceLockedDefault = (model: LlmModel | null): LlmModel | null =>
    model && lockedIds.has(model) ? fallbackModel ?? model : model;

  return {
    ...pickerState,
    modelOptions,
    allowedThreadModels,
    effectivePickerDefaultModel: replaceLockedDefault(
      pickerState.effectivePickerDefaultModel,
    ),
    defaultModel: replaceLockedDefault(pickerState.defaultModel),
    hostedCreditsPaused: pause.hostedCreditsPaused,
  };
}

async function readOrgModelPickerConfig(
  orgStub: OrgDO,
): Promise<OrgModelPickerConfig> {
  return retryTransientDurableObjectRead("OrgDO.getModelPickerConfig", () =>
    Promise.resolve(orgStub.getModelPickerConfig()),
  );
}

async function readWorkspaceModelPickerConfig(
  wsStub: WorkspaceDO,
): Promise<WorkspaceModelPickerConfig> {
  return retryTransientDurableObjectRead(
    "WorkspaceDO.getModelPickerConfig",
    () => Promise.resolve(wsStub.getModelPickerConfig()),
  );
}

export async function getWorkspaceModelPickerState(
  context: AppLoadContext,
  workspaceId: string,
  options: ModelPickerStateOptions = {},
): Promise<WorkspaceModelPickerState | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }

  return getWorkspaceModelPickerStateForOrg(context, orgId, workspaceId, options);
}

async function getWorkspaceModelPickerStateForOrg(
  context: AppLoadContext,
  orgId: string,
  workspaceId: string,
  options: ModelPickerStateOptions = {},
): Promise<WorkspaceModelPickerState> {
  const env = getEnv(context);
  const orgStub = getOrgStub(env, orgId);
  const wsStub = env.WORKSPACE.get(
    env.WORKSPACE.idFromName(workspaceId),
  ) as unknown as WorkspaceDO;
  const orgInfoPromise =
    options.orgBillingState !== undefined
      ? Promise.resolve(options.orgBillingState)
      : typeof orgStub.getInfo === "function"
        ? retryTransientDurableObjectRead("OrgDO.getInfo", () =>
            Promise.resolve(orgStub.getInfo()),
          )
        : Promise.resolve(null);
  const [llmProviderConfig, openAiSubscription, orgInfo] = await Promise.all([
    options.llmProviderConfig !== undefined
      ? Promise.resolve(options.llmProviderConfig)
      : retryTransientDurableObjectRead("OrgDO.getLlmProviderConfig", () =>
          Promise.resolve(orgStub.getLlmProviderConfig()),
        ),
    typeof orgStub.getOpenAiSubscription === "function"
      ? Promise.resolve(orgStub.getOpenAiSubscription())
      : Promise.resolve(null),
    orgInfoPromise,
  ]);
  const allowOpenAiSubscription = openAiSubscription !== null;
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    llmProviderConfig,
  );
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderConfig);
  const [orgPickerConfig, workspacePickerConfig] = await Promise.all([
    readOrgModelPickerConfig(orgStub),
    readWorkspaceModelPickerConfig(wsStub),
  ]);
  const effectiveConfig = resolveEffectivePickerConfig(
    orgPickerConfig,
    workspacePickerConfig,
  );
  const resolvedBillingAccess = resolveOrgBillingAccess({
    env,
    org: orgInfo,
    llmProviderConfig: effectiveLlmProviderConfig,
  });
  const billingAccessMode = isOrgBillingAccessReady(resolvedBillingAccess)
    ? resolvedBillingAccess.mode
    : null;
  const isFreeMode = billingAccessMode === "camel_free";
  const resolvedCatalog = resolveModelPickerCatalog({
    effectiveConfig,
    orgProvider: effectiveLlmProviderConfig?.provider,
    customApi,
    customModelId,
    awsRegion,
    allowOpenAiSubscription,
    allowCamelCode: billingAccessMode !== "selfhost",
  });
  const isCustomPicker = effectiveConfig.use_platform_defaults === false;
  const visibleCatalog =
    isFreeMode &&
    !isCustomPicker &&
    !resolvedCatalog.some((entry) => entry.id === CAMEL_CODE_LLM_MODEL)
      ? [MODEL_CATALOG[CAMEL_CODE_LLM_MODEL], ...resolvedCatalog]
      : resolvedCatalog;
  const modelOptions: ModelPickerOption[] = visibleCatalog.map((entry) => {
    if (
      !isBillingLockedModel(entry.id, {
        isFreeMode,
        allowOpenAiSubscription,
      })
    ) {
      return entry;
    }
    return {
      ...entry,
      locked: true,
      unlockHint: isLlmModelCoveredByOpenAiSubscription(entry.id)
        ? "openai"
        : "generic",
    };
  });
  const selectableCatalog = modelOptions.filter((entry) => !entry.locked);
  const hasNonCamelCodeUnlocked = modelOptions.some(
    (entry) => !entry.locked && entry.id !== CAMEL_CODE_LLM_MODEL,
  );
  const visibleModelOptions = hasNonCamelCodeUnlocked
    ? modelOptions.filter((entry) => !entry.locked)
    : modelOptions;
  const unlockedIds = new Set(selectableCatalog.map((entry) => entry.id));
  const canUnlockPremiumModels =
    (billingAccessMode === "camel_free" || billingAccessMode === "byok") &&
    UNLOCKABLE_CATALOG_IDS.some(
      (id) =>
        !unlockedIds.has(id) &&
        !(
          billingAccessMode === "byok" &&
          isLlmModelCoveredByByokProvider(
            id,
            effectiveLlmProviderConfig?.provider,
          )
        ),
    );
  const configuredDefault = effectiveConfig.default_model;
  const configuredDefaultIsLocked = modelOptions.some(
    (entry) => entry.id === configuredDefault && entry.locked,
  );
  const fallbackModel = findCheapestSelectableModel(modelOptions)?.id ?? null;
  const effectivePickerDefaultModel = configuredDefaultIsLocked
    ? fallbackModel ?? configuredDefault
    : configuredDefault;
  const defaultModel = resolveDefaultModelForChat({
    effectiveDefaultModel: effectivePickerDefaultModel,
    fallbackModel: isFreeMode
      ? CAMEL_CODE_LLM_MODEL
      : getDefaultLlmModel(effectiveLlmProviderConfig?.provider, {
          customApi,
          customModelId,
          awsRegion,
        }),
    visibleCatalog: selectableCatalog,
  });

  return {
    orgId,
    llmProvider: (effectiveLlmProviderConfig?.provider ?? null) as LlmProvider | null,
    customApi,
    customModelId,
    awsRegion,
    allowOpenAiSubscription,
    billingAccessMode,
    modelOptions: visibleModelOptions,
    allowedThreadModels: selectableCatalog.map((entry) => entry.id),
    effectivePickerDefaultModel,
    hasEffectivePickerDefault: effectivePickerDefaultModel !== null,
    defaultModel,
    canUnlockPremiumModels,
    hostedCreditsPaused: null,
    modelPickerSettingsHref:
      effectiveConfig.source === "workspace"
        ? `/settings/organization/models?scope=ws&workspaceId=${encodeURIComponent(workspaceId)}`
        : "/settings/organization/models",
  };
}

async function resolveCreateThreadModel(
  context: AppLoadContext,
  workspaceId: string,
  requestedModel?: unknown,
  knownOrgId?: string,
): Promise<{ orgId: string; model: LlmModel }> {
  const pickerState = knownOrgId
    ? await getWorkspaceModelPickerStateForOrg(context, knownOrgId, workspaceId)
    : await getWorkspaceModelPickerState(context, workspaceId);
  if (!pickerState || pickerState.allowedThreadModels.length === 0) {
    throw new Error("No models are available");
  }

  const selectedModel =
    requestedModel == null
      ? pickerState.defaultModel
      : requestedModel;
  if (!selectedModel) {
    throw new Error("No models are available");
  }
  if (
    !isLlmModel(selectedModel) ||
    !isLlmModelAllowedForNewThread(
      selectedModel,
      pickerState.llmProvider,
      {
        customApi: pickerState.customApi,
        customModelId: pickerState.customModelId,
        awsRegion: pickerState.awsRegion,
        allowOpenAiSubscription: pickerState.allowOpenAiSubscription,
      },
    ) ||
    !pickerState.allowedThreadModels.includes(selectedModel)
  ) {
    throw new Error("Invalid thread model");
  }

  return { orgId: pickerState.orgId, model: selectedModel };
}

// Helper to get OrgDO stub
function getOrgStub(env: CloudflareEnv, orgId: string): OrgDO {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
}

export async function getThreads(
  context: AppLoadContext,
  workspaceId: string,
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const threads = await orgStub.getThreadsByWorkspace(workspaceId);
  return threads.map((t) => toThreadListPreview(env, t));
}

export async function getThreadsPaginated(
  context: AppLoadContext,
  workspaceId: string,
  params: PaginationParams = {},
  options: KnownOrgOptions = {},
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) {
      return { items: [], total: 0, offset, limit };
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  const result = await orgStub.getThreadsPaginated(
    offset,
    limit,
    workspaceId,
    params.createdBy,
    params.searchQuery,
  );
  const searchTerms = parseThreadSearchTerms(params.searchQuery);
  return {
    items: result.items.map((thread) => {
      const preview = toThreadListPreview(env, thread);
      return searchTerms.length > 0
        ? {
            ...preview,
            search_match: buildThreadSearchMatch(thread, searchTerms),
          }
        : preview;
    }),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadsPaginatedAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
  params: PaginationParams = {},
  options: KnownOrgOptions = {},
): Promise<PaginatedResult<Thread>> {
  const env = getEnv(context);
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;
  if (workspaceIds.length === 0) {
    return { items: [], total: 0, offset, limit };
  }
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
    if (!wsInfo) {
      return { items: [], total: 0, offset, limit };
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  const result = await orgStub.getThreadsAllWorkspacesPaginated(
    workspaceIds,
    offset,
    limit,
    params.createdBy,
    params.searchQuery,
  );
  const searchTerms = parseThreadSearchTerms(params.searchQuery);
  return {
    items: result.items.map((thread) => {
      const preview = toThreadListPreview(env, thread);
      return searchTerms.length > 0
        ? {
            ...preview,
            search_match: buildThreadSearchMatch(thread, searchTerms),
          }
        : preview;
    }),
    total: result.total,
    offset: result.offset,
    limit: result.limit,
  };
}

export async function getThreadCreators(
  context: AppLoadContext,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<RawThreadCreator[]> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) {
      return [];
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  return await orgStub.getThreadCreators(workspaceId);
}

export async function getThreadCreatorsAllWorkspaces(
  context: AppLoadContext,
  workspaceIds: string[],
  options: KnownOrgOptions = {},
): Promise<RawThreadCreator[]> {
  if (workspaceIds.length === 0) {
    return [];
  }
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceIds[0]);
    if (!wsInfo) {
      return [];
    }
    orgId = wsInfo.org_id;
  }
  const orgStub = getOrgStub(env, orgId);
  return await orgStub.getThreadCreatorsAllWorkspaces(workspaceIds);
}

export async function createThread(
  context: AppLoadContext,
  workspaceId: string,
  title: string | undefined,
  createdBy?: string,
  firstUserMessage?: string,
  model?: unknown,
): Promise<Thread> {
  const env = getEnv(context);
  const { orgId, model: selectedModel } = await resolveCreateThreadModel(
    context,
    workspaceId,
    model,
  );
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.createThread(
    workspaceId,
    title,
    createdBy,
    firstUserMessage,
    selectedModel,
  );
  return toThread(env, thread);
}

export async function createThreadWithValidatedAccess(
  context: AppLoadContext,
  orgId: string,
  workspaceId: string,
  title: string | undefined,
  createdBy: string | undefined,
  firstUserMessage: string | undefined,
  model?: unknown,
): Promise<Thread> {
  const env = getEnv(context);
  const { model: selectedModel } = await resolveCreateThreadModel(
    context,
    workspaceId,
    model,
    orgId,
  );
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.createThread(
    workspaceId,
    title,
    createdBy,
    firstUserMessage,
    selectedModel,
  );
  return toThread(env, thread);
}

export async function getRecentThreads(
  context: AppLoadContext,
  workspaceId: string,
  limit = 6,
  createdBy?: string,
  options: KnownOrgOptions = {},
): Promise<Thread[]> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return [];
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const result = await orgStub.getThreadsPaginated(
    0,
    limit,
    workspaceId,
    createdBy,
  );
  return result.items.map((t) => toThreadListPreview(env, t));
}

export async function getThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<Thread | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await retryTransientDurableObjectRead("OrgDO.getThread", () =>
    orgStub.getThread(id),
  );
  if (!thread) return null;
  // Verify the thread belongs to this workspace
  if (thread.workspace_id !== workspaceId) return null;
  return toThread(env, thread);
}

export async function getThreadsByIds(
  context: AppLoadContext,
  workspaceId: string,
  threadIds: string[],
): Promise<Thread[]> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return [];
  const uniqueThreadIds = Array.from(
    new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean)),
  );
  if (uniqueThreadIds.length === 0) return [];
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  const threads = await retryTransientDurableObjectRead(
    "OrgDO.getThreadsByIds",
    () => orgStub.getThreadsByIds(workspaceId, uniqueThreadIds),
  );
  return threads.map((thread) => toThreadListPreview(env, thread));
}

export async function updateThread(
  context: AppLoadContext,
  id: string,
  title: string,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<Thread | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const thread = await orgStub.updateThread(id, title);
  if (!thread) return null;
  return toThread(env, thread);
}

export async function updateThreadModel(
  context: AppLoadContext,
  id: string,
  model: LlmModel,
  workspaceId: string,
  options: ModelPickerStateOptions = {},
): Promise<Thread | null> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return null;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const pickerState = await getWorkspaceModelPickerState(
    context,
    workspaceId,
    { ...options, orgId },
  );
  if (
    !pickerState ||
    !isLlmModelAllowedForNewThread(
      model,
      pickerState.llmProvider,
      {
        customApi: pickerState.customApi,
        customModelId: pickerState.customModelId,
        awsRegion: pickerState.awsRegion,
        allowOpenAiSubscription: pickerState.allowOpenAiSubscription,
      },
    ) ||
    !pickerState.allowedThreadModels.includes(model)
  ) {
    throw new Error("Invalid thread model");
  }
  const updated = await orgStub.updateThreadModel(id, model);
  return updated ? toThread(env, updated) : null;
}

export async function setThreadFirstUserMessage(
  context: AppLoadContext,
  id: string,
  firstUserMessage: string,
  workspaceId: string,
): Promise<Thread | null> {
  const env = getEnv(context);
  const wsInfo = await getWorkspaceInfo(env, workspaceId);
  if (!wsInfo) return null;
  const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return null;
  const thread = await orgStub.setThreadFirstUserMessage(id, firstUserMessage);
  if (!thread) return null;
  return toThread(env, thread);
}

export async function deleteThread(
  context: AppLoadContext,
  id: string,
  workspaceId: string,
  options: KnownOrgOptions = {},
): Promise<boolean> {
  const env = getEnv(context);
  let orgId = options.orgId;
  if (!orgId) {
    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return false;
    orgId = wsInfo.org_id;
  }
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  // Verify the thread belongs to this workspace first
  const existing = await orgStub.getThread(id);
  if (!existing || existing.workspace_id !== workspaceId) return false;
  await orgStub.deleteThread(id);
  return true;
}

export async function generateThreadTitle(
  context: AppLoadContext,
  threadId: string,
  workspaceId: string,
  message: string,
  userId?: string | null,
): Promise<void> {
  try {
    const env = getEnv(context);

    const wsInfo = await getWorkspaceInfo(env, workspaceId);
    if (!wsInfo) return;

    const titleSourceMessage = getThreadTitleSourceMessage(message);
    if (!titleSourceMessage) return;

    const title = await generateThreadTitleWithOpenAI(
      env.AI as never,
      titleSourceMessage,
      {
        orgId: wsInfo.org_id,
        workspaceId,
        threadId,
      },
      { gatewayName: env.CF_GATEWAY_NAME },
    );
    if (!title) return;

    const orgStub = env.ORG.get(env.ORG.idFromName(wsInfo.org_id));
    const updated = await orgStub.updateThread(threadId, title);
    if (userId) {
      await env.USER.get(env.USER.idFromName(userId))
        .renameEmptySingleThreadGroupForThread(threadId, title);
    }

    const threadStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(threadId),
    );
    await threadStub.setTitle(title, updated?.updated_at);
    if (userId) {
      await threadStub.generateChatGroupAvatarForThread({
        threadId,
        workspaceId,
        orgId: wsInfo.org_id,
        userId,
      });
    }
  } catch (e) {
    console.error("[generateThreadTitle] Error:", e);
  }
}

export async function getPiCoreMessages(
  context: AppLoadContext,
  threadId: string,
): Promise<ParsedThreadMessage[]> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    throw new Error("CHAT_THREAD binding is not available");
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const messages = await Promise.resolve(
    (
      threadStub as unknown as {
        getPiCoreParsedMessages(threadId: string): Promise<ParsedThreadMessage[]> | ParsedThreadMessage[];
      }
    ).getPiCoreParsedMessages(threadId),
  );
  return Array.isArray(messages) ? messages : [];
}

export interface GroupNewChatRecentSource {
  messages: ParsedThreadMessage[];
  projectActivity: ThreadProjectActivity[];
}

export async function getGroupNewChatRecentSource(
  context: AppLoadContext,
  threadId: string,
): Promise<GroupNewChatRecentSource> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    throw new Error("CHAT_THREAD binding is not available");
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const source = await Promise.resolve(
    (
      threadStub as unknown as {
        getGroupNewChatRecentSource(threadId: string):
          | Promise<GroupNewChatRecentSource>
          | GroupNewChatRecentSource;
      }
    ).getGroupNewChatRecentSource(threadId),
  );
  return {
    messages: Array.isArray(source?.messages) ? source.messages : [],
    projectActivity: Array.isArray(source?.projectActivity)
      ? source.projectActivity
      : [],
  };
}

export async function getUiMessages(
  context: AppLoadContext,
  threadId: string,
): Promise<UIMessage[]> {
  return (await getUiMessagePage(context, threadId)).messages;
}

export async function getUiMessagePage(
  context: AppLoadContext,
  threadId: string,
): Promise<ChatRenderHistoryPage> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    throw new Error("CHAT_THREAD binding is not available");
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const page = await Promise.resolve(
    (
      threadStub as unknown as {
        getUiMessagePage():
          | Promise<ChatRenderHistoryPage>
          | ChatRenderHistoryPage;
      }
    ).getUiMessagePage(),
  );
  return {
    messages: Array.isArray(page?.messages) ? page.messages : [],
    nextCursor:
      typeof page?.nextCursor === "string" && page.nextCursor
        ? page.nextCursor
        : null,
    hasMore: page?.hasMore === true,
  };
}

export async function getTodoState(
  context: AppLoadContext,
  threadId: string,
): Promise<unknown[]> {
  const env = getEnv(context);
  if (
    !env ||
    typeof env !== "object" ||
    !("CHAT_THREAD" in env) ||
    !env.CHAT_THREAD
  ) {
    return [];
  }
  const threadStub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const todos = await Promise.resolve(
    (
      threadStub as unknown as {
        getTodoState(): Promise<unknown[]> | unknown[];
      }
    ).getTodoState(),
  ).catch(() => []);
  return Array.isArray(todos) ? todos : [];
}

export async function getMessages(
  context: AppLoadContext,
  threadId: string,
  _workspaceId: string,
  options: { skipBanCheck?: boolean } = {},
): Promise<Message[]> {
  try {
    void options;
    const piMessages = await getPiCoreMessages(context, threadId);
    if (piMessages.length > 0) {
      return piMessages as Message[];
    }

    return [];
  } catch (e) {
    console.error("[getMessages] Error:", e);
    return [];
  }
}

export async function setThreadPreviewTarget(
  context: AppLoadContext,
  threadId: string,
  target: PreviewTarget | null,
): Promise<PreviewTarget | null> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  await stub.setPreviewTarget(target);
  return stub.getPreviewTarget();
}

export async function setThreadPreviewAppVisibility(
  context: AppLoadContext,
  threadId: string,
  scriptName: string,
  isPublic: boolean,
): Promise<void> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  await stub.setPreviewAppVisibility(scriptName, isPublic);
}

export async function getThreadPreviewTarget(
  context: AppLoadContext,
  threadId: string,
): Promise<PreviewTarget | null> {
  const state = await getThreadPreviewState(context, threadId);
  return state.target;
}

export async function getThreadPreviewState(
  context: AppLoadContext,
  threadId: string,
): Promise<ThreadPreviewState> {
  const env = getEnv(context);
  const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId));
  const state = await stub.getPreviewState() as ThreadPreviewState | null | undefined;
  return {
    target: state?.target ?? null,
    tabs: Array.isArray(state?.tabs) ? state.tabs : [],
    activeTabId:
      typeof state?.activeTabId === "string" ? state.activeTabId : null,
    version: typeof state?.version === "number" ? state.version : 0,
  };
}
