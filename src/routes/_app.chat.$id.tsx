import { useCallback, useEffect, useRef, useState } from "react";
import {
  redirect,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
} from "react-router";
import type { Route } from "./+types/_app.chat.$id";
import type { UIMessage } from "ai";
import {
  requireAuthContext,
  requireSuperuser,
  requireSessionWorkspaceAccess,
  getAuthEnv,
} from "@/lib/auth.server";
import {
  createSessionCookieHeader,
  getRemainingSessionCookieMaxAge,
} from "@/lib/cookies.server";
import type { MentionableProject } from "@/lib/mentions";
import { resolveDisplayChatData } from "@/lib/chat-thread-display";
import { loadWorkspaceMentionSources } from "@/lib/mention-sources.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAppUrlContext } from "@/lib/app-url.server";
import { getOrgBillingOverview } from "@/lib/billing.server";
import {
  applyDevBillingCreditStatusOverride,
  buildBillingCreditStatus,
  getDevBillingCreditStatus,
  getDevChatInitialError,
} from "@/lib/chat-credit-status";
import {
  CAMEL_CODE_LLM_MODEL,
  getDefaultLlmModel,
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  getStoredBedrockAwsRegion,
  getVisibleLlmModelOptions,
  isLlmModel,
  normalizeLlmModel,
} from "@/lib/llm-provider-config";
import { getEffectiveLlmProviderConfig } from "@/lib/selfhost-ai-provider";
import { isSelfhostRuntime } from "@/lib/selfhost-runtime";
import { modelCatalogEntriesForIds } from "@/lib/model-catalog";
import { getOrg, getWorkerScript } from "@/lib/auth-do";
import { switchSessionOrg, switchSessionWorkspace } from "@/lib/auth-do";
import { validateSessionIdentityMapsToOrg } from "../../workers/main/src/helpers/proxy-auth-providers";
import type { ProxyAuthValidationEnv } from "../../workers/main/src/helpers/proxy-auth-core";
import { getChatDebugFlags } from "@/lib/chat-debug-flags";
import { shouldRevalidateActiveChatRoute } from "@/lib/chat-route-revalidation";
import { resolveMessageAuthorDisplayName } from "@/lib/message-author";
import { messageToUiMessage } from "@/lib/ui-message-adapter";
import {
  saveChatGroupRename,
  type ChatGroupRenameInput,
} from "@/lib/chat-group-rename.client";
import { saveChatGroupPinned } from "@/lib/chat-group-pin.client";
import * as authDO from "@/lib/auth-do.server";
import * as chatDO from "@/lib/chat-do.server";
import {
  ensureGroupForThread,
  listGroupsForMove,
} from "@/lib/chat-groups.server";
import { readThreadMessages } from "@/lib/chat-history.server";
import Chat from "@/components/Chat";
import { ChatTabBar } from "@/components/chat-tab-bar";
import { ChatLoadingSkeleton } from "@/components/chat/chat-loading";
import { NoWorkspacesError } from "@/components/no-workspaces-error";
import {
  getCloseGroupRedirect,
  useChatGroups,
} from "@/hooks/use-chat-groups";
import { useChatThreadSnapshots } from "@/hooks/use-chat-thread-snapshots";
import type { TodoItem } from "@/components/floating-todo";
import type {
  Integration,
  LlmProvider,
  LlmModel,
  Message,
  PreviewTarget,
  User,
  WorkspaceWithAccess,
} from "@/types";
import {
  createRequestObservabilityContext,
  normalizePathForObservability,
  recordErrorEvent,
  recordObservabilityEvent,
} from "../../workers/main/src/observability";

export function meta({ data }: Route.MetaArgs) {
  const title = data?.threadTitle || "Chat";
  return [
    { title: `${title} - camelAI` },
    { name: "description", content: "AI Chat" },
  ];
}

export function shouldRevalidate(
  args: Parameters<typeof shouldRevalidateActiveChatRoute>[0],
) {
  return shouldRevalidateActiveChatRoute(args);
}

type ChatThreadRouteLoaderTraceContext = {
  requestId: string;
  sampleIndex: string;
  method: string;
  path: string;
  route: string;
};

type ChatThreadRouteLoaderTraceIds = {
  orgId?: string | null;
  workspaceId?: string | null;
  userId?: string | null;
  threadId?: string | null;
};

type ChatThreadRouteLoaderTraceExtra = {
  status?: string;
  statusCode?: number;
  count?: number;
  size?: number;
  model?: string | null;
};

function createChatThreadRouteLoaderTraceContext(
  request: Request,
): ChatThreadRouteLoaderTraceContext {
  const requestContext = createRequestObservabilityContext(request);
  const url = new URL(request.url);
  return {
    requestId: requestContext.requestId,
    sampleIndex: requestContext.colo,
    method: request.method,
    path: normalizePathForObservability(url.pathname),
    route: "routes/_app.chat.$id.loader",
  };
}

function recordChatThreadRouteLoaderStage(
  env: ReturnType<typeof getEnv>,
  trace: ChatThreadRouteLoaderTraceContext,
  ids: ChatThreadRouteLoaderTraceIds,
  operation: string,
  startedAt: number,
  extra: ChatThreadRouteLoaderTraceExtra = {},
): void {
  recordObservabilityEvent(env, {
    event: "chat_thread_route_loader_stage",
    severity: extra.status === "error" ? "error" : "info",
    component: "react_router_loader",
    operation,
    status: extra.status ?? "ok",
    route: trace.route,
    method: trace.method,
    path: trace.path,
    orgId: ids.orgId,
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    threadId: ids.threadId,
    requestId: trace.requestId,
    model: extra.model,
    durationMs: Date.now() - startedAt,
    statusCode: extra.statusCode,
    count: extra.count,
    size: extra.size,
    sampleIndex: trace.sampleIndex,
  });
}

function recordChatThreadRouteLoaderError(
  env: ReturnType<typeof getEnv>,
  trace: ChatThreadRouteLoaderTraceContext,
  ids: ChatThreadRouteLoaderTraceIds,
  operation: string,
  startedAt: number,
  error: unknown,
  extra: ChatThreadRouteLoaderTraceExtra = {},
): void {
  recordErrorEvent(env, {
    event: "chat_thread_route_loader_stage",
    component: "react_router_loader",
    operation,
    status: extra.status ?? "exception",
    route: trace.route,
    method: trace.method,
    path: trace.path,
    orgId: ids.orgId,
    workspaceId: ids.workspaceId,
    userId: ids.userId,
    threadId: ids.threadId,
    requestId: trace.requestId,
    model: extra.model,
    durationMs: Date.now() - startedAt,
    statusCode: extra.statusCode,
    count: extra.count,
    size: extra.size,
    sampleIndex: trace.sampleIndex,
    error,
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const url = new URL(request.url);
  if (url.searchParams.get("adminReadonly") === "1") {
    await requireSuperuser(request, context);
    return { error: "Read-only admin view" };
  }

  const { orgId, workspaceId } = await requireSessionWorkspaceAccess(
    request,
    context,
    undefined,
    {
      requireWrite: true,
    },
  );
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateThreadModel") {
    const model = formData.get("model");
    const existingThread = await chatDO.getThread(
      context,
      params.id,
      workspaceId,
      {
        orgId,
      },
    );
    if (!existingThread) {
      return { error: "Thread not found" };
    }
    if (!isLlmModel(model)) {
      return { error: "A valid thread model is required" };
    }

    let updated;
    try {
      updated = await chatDO.updateThreadModel(
        context,
        params.id,
        model,
        workspaceId,
        { orgId },
      );
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update thread model",
      };
    }
    if (!updated) {
      return { error: "Thread not found" };
    }
    try {
      const env = getEnv(context);
      const chatThread = env.CHAT_THREAD.get(
        env.CHAT_THREAD.idFromName(params.id),
      ) as unknown as {
        setModel(model: LlmModel, updatedAt?: number): Promise<void>;
        refreshRunnerConfig(): Promise<void>;
      };
      await chatThread.setModel(updated.model, updated.updated_at);
      await chatThread.refreshRunnerConfig();
    } catch (error) {
      console.error("Failed to broadcast thread model update:", error);
    }

    return { thread: updated };
  }

  return { error: "Unknown action" };
}

interface ChatData {
  messages: Message[];
  messagesError: string | null;
  // ai-chat-owned durable render history (commit 4). The live-user loader branch
  // fetches this via getUiMessages(); useAgentChat mounts it as its initial
  // messages. The admin-readonly branch leaves it empty (it renders pi_core).
  initialUiMessages: UIMessage[];
  olderUiMessagesCursor: string | null;
  todos: TodoItem[];
  previewTabs: PreviewTarget[];
  activeTabId: string | null;
}

type ChatDataValue = ChatData | Promise<ChatData>;

const EMPTY_CHAT_DATA: ChatData = {
  messages: [],
  messagesError: null,
  initialUiMessages: [],
  olderUiMessagesCursor: null,
  todos: [],
  previewTabs: [],
  activeTabId: null,
};

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === "function";
}

// A first user message projected from the warm thread record while the normal
// durable render-history read resolves.
function threadRecordFirstUserMessage(
  threadId: string,
  content: string,
  user: Pick<User, "name" | "email"> | null,
): Message {
  const authorDisplayName = resolveMessageAuthorDisplayName(
    user?.name,
    user?.email,
  );
  return {
    id: `thread-seed:${threadId}`,
    thread_id: threadId,
    role: "user",
    content,
    created_at: Date.now(),
    ...(authorDisplayName ? { authorDisplayName } : {}),
    messageSource: "web",
  };
}

function buildChatDataError(error: unknown): ChatData {
  console.error("Failed to load chat data:", error);
  return {
    ...EMPTY_CHAT_DATA,
    initialUiMessages: [],
    messagesError: "Failed to load chat messages",
  };
}

type DeferredChatDataState = {
  source: ChatDataValue;
  data: ChatData;
  loading: boolean;
  dataKey: string;
};

function getInitialDeferredChatDataState(
  source: ChatDataValue,
  dataKey: string,
  seed: ChatData = EMPTY_CHAT_DATA,
): DeferredChatDataState {
  return {
    source,
    data: isPromiseLike(source) ? seed : source,
    loading: isPromiseLike(source),
    dataKey,
  };
}

function getDeferredChatDataLoadingState(
  previousState: DeferredChatDataState,
  source: Promise<ChatData>,
  dataKey: string,
): DeferredChatDataState {
  return {
    source,
    data: previousState.dataKey === dataKey ? previousState.data : EMPTY_CHAT_DATA,
    loading: true,
    dataKey,
  };
}

function useDeferredChatData(
  chatData: ChatDataValue,
  dataKey: string,
  seed: ChatData = EMPTY_CHAT_DATA,
): {
  chatData: ChatData;
  isLoading: boolean;
} {
  const [state, setState] = useState<DeferredChatDataState>(() =>
    getInitialDeferredChatDataState(chatData, dataKey, seed),
  );

  useEffect(() => {
    if (!isPromiseLike(chatData)) {
      setState({ source: chatData, data: chatData, loading: false, dataKey });
      return;
    }

    let active = true;
    setState((previousState) =>
      getDeferredChatDataLoadingState(previousState, chatData, dataKey),
    );
    chatData.then(
      (resolvedChatData) => {
        if (active) {
          setState({
            source: chatData,
            data: resolvedChatData,
            loading: false,
            dataKey,
          });
        }
      },
      (error) => {
        if (active) {
          setState({
            source: chatData,
            data: buildChatDataError(error),
            loading: false,
            dataKey,
          });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [chatData, dataKey]);

  const currentState =
    state.source === chatData && state.dataKey === dataKey
      ? state
      : isPromiseLike(chatData) && state.dataKey === dataKey
        ? getDeferredChatDataLoadingState(state, chatData, dataKey)
        : getInitialDeferredChatDataState(chatData, dataKey, seed);

  return {
    chatData: currentState.data,
    isLoading: currentState.loading,
  };
}

function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") return `app:${target.scriptName}`;
  if (target.kind === "runtime_artifact") return `artifact:${target.artifact.id}`;
  return `file:${target.workspaceId}:${target.source}:${target.project ?? ""}:${target.path}`;
}

async function buildChatData(
  context: Route.LoaderArgs["context"],
  authEnv: ReturnType<typeof getAuthEnv>,
  threadId: string,
  options: {
    orgId: string;
    workspaceId: string;
    // Admin-readonly branch only: fetch the legacy pi_core transcript
    // (readThreadMessages) it renders directly. The live branch leaves it off —
    // its transcript is the ai-chat render history, so a normal chat load makes
    // exactly ONE transcript RPC (Chat.tsx derives any fallback Message view
    // from initialUiMessages).
    loadLegacyMessages: boolean;
    // Live-user branch only: fetch the ai-chat render history (getUiMessages)
    // that useAgentChat mounts. Admin-readonly leaves it off (renders pi_core).
    loadUiMessages: boolean;
    skipBanCheck?: boolean;
  },
): Promise<ChatData> {
  const previewDataPromise = (async () => {
    const previewStateRaw = await chatDO
      .getThreadPreviewState(context, threadId)
      .catch(() => ({
        target: null,
        tabs: [],
        activeTabId: null,
        version: 0,
      }));

    const applyAppVisibility = async (
      target: PreviewTarget,
    ): Promise<PreviewTarget> => {
      if (target.kind !== "app") {
        return target;
      }
      const script = await getWorkerScript(
        authEnv,
        options.orgId,
        target.scriptName,
      );
      if (!script) {
        return target;
      }
      return {
        ...target,
        isPublic: script.is_public,
      };
    };

    const previewTabs = await Promise.all(
      previewStateRaw.tabs.map(applyAppVisibility),
    );
    const tabIds = new Set(previewTabs.map(getPreviewTabId));

    let activeTabId = previewStateRaw.activeTabId;
    if (!activeTabId || !tabIds.has(activeTabId)) {
      activeTabId = previewTabs[0] ? getPreviewTabId(previewTabs[0]) : null;
    }

    return {
      previewTabs,
      activeTabId,
    };
  })();

  const messagesPromise = options.loadLegacyMessages
    ? readThreadMessages(context, {
        workspaceId: options.workspaceId,
        orgId: options.orgId,
        threadId,
        skipBanCheck: options.skipBanCheck,
      })
        .then((messages) => ({ messages, messagesError: null }))
    : Promise.resolve({ messages: [], messagesError: null });
  // The live branch has no legacy transcript to fall back on, so a failed
  // render-history read must surface as messagesError instead of silently
  // rendering an empty thread.
  const uiMessagesPromise = options.loadUiMessages
    ? chatDO
        .getUiMessagePage(context, threadId)
        .then((page) => ({ page, uiMessagesError: null }))
        .catch((error) => {
          console.error("Failed to load ai-chat render history:", error);
          return {
            page: {
              messages: [] as UIMessage[],
              nextCursor: null,
              hasMore: false,
            },
            uiMessagesError: "Failed to load chat messages",
          };
        })
    : Promise.resolve({
        page: {
          messages: [] as UIMessage[],
          nextCursor: null,
          hasMore: false,
        },
        uiMessagesError: null,
      });
  const todosPromise = chatDO
    .getTodoState(context, threadId)
    .catch(() => [] as unknown[]);

  const [previewData, messageData, uiMessageData, todos] = await Promise.all([
    previewDataPromise,
    messagesPromise,
    uiMessagesPromise,
    todosPromise,
  ]);
  return {
    ...previewData,
    messages: messageData.messages,
    messagesError: messageData.messagesError ?? uiMessageData.uiMessagesError,
    initialUiMessages: uiMessageData.page.messages,
    olderUiMessagesCursor: uiMessageData.page.hasMore
      ? uiMessageData.page.nextCursor
      : null,
    todos: Array.isArray(todos) ? (todos as TodoItem[]) : [],
  };
}

async function findAccessibleGroupWorkspace(
  context: Route.LoaderArgs["context"],
  userId: string,
  groupId: string,
  workspaces: WorkspaceWithAccess[],
): Promise<WorkspaceWithAccess | null> {
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const group = await userStub.getChatGroup(groupId);
  if (!group) return null;
  return (
    workspaces.find(
      (workspace) =>
        workspace.id === group.workspace_id && workspace.org_id === group.org_id,
    ) ?? null
  );
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const loaderStartedAt = Date.now();
  const url = new URL(request.url);
  const isAdminReadonly = url.searchParams.get("adminReadonly") === "1";
  const env = getEnv(context);
  const hostname = getAppUrlContext(env, request);
  const authEnv = getAuthEnv(env);
  const traceContext = createChatThreadRouteLoaderTraceContext(request);
  const traceIds: ChatThreadRouteLoaderTraceIds = {
    threadId: params.id,
  };

  if (isAdminReadonly) {
    await requireSuperuser(request, context);

    const threadContext = await authDO.adminGetThreadContextById(
      context,
      params.id,
    );
    if (!threadContext) {
      throw redirect("/qaml-backdoor/threads");
    }

    const thread = await chatDO.getThread(
      context,
      params.id,
      threadContext.workspace_id,
      {
        orgId: threadContext.org_id,
      },
    );
    const org = await getOrg(authEnv, threadContext.org_id);

    return {
      threadId: params.id,
      workspaceId: threadContext.workspace_id,
      chatData: await buildChatData(context, authEnv, params.id, {
        orgId: threadContext.org_id,
        workspaceId: threadContext.workspace_id,
        loadLegacyMessages: true,
        loadUiMessages: false,
        skipBanCheck: true,
      }),
      threadTitle: thread?.title ?? threadContext.title ?? null,
      threadModel:
        thread?.model ??
        (threadContext.model as LlmModel | undefined) ??
        getDefaultLlmModel(),
      llmProvider: null as LlmProvider | null,
      modelOptions: null,
      allowedThreadModels: null,
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      billingAccessMode: null,
      canUnlockPremiumModels: false,
      hostedCreditsPaused: null,
      modelPickerSettingsHref: "/settings/organization/models",
      allowOpenAiSubscription: false,
      billingCreditStatus: null,
      initialChatError: null,
      hostname,
      orgSlug: org?.slug,
      connections: [] as Integration[],
      projects: [] as MentionableProject[],
      isOrgAdmin: false,
      recentModelScope: null,
      readOnly: true,
      activeChatGroup: null,
      activeGroupId: null,
      moveChatGroups: [],
      chatDataSeed: EMPTY_CHAT_DATA,
    };
  }

  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return {
      threadId: params.id,
      workspaceId: null,
      chatData: EMPTY_CHAT_DATA,
      threadTitle: null,
      threadModel: getDefaultLlmModel(),
      llmProvider: null as LlmProvider | null,
      modelOptions: [],
      allowedThreadModels: [],
      effectivePickerDefaultModel: null,
      hasEffectivePickerDefault: false,
      billingAccessMode: null,
      canUnlockPremiumModels: false,
      hostedCreditsPaused: null,
      modelPickerSettingsHref: "/settings/organization/models",
      allowOpenAiSubscription: false,
      billingCreditStatus: null,
      initialChatError: getDevChatInitialError(url.searchParams),
      hostname: undefined,
      connections: [] as Integration[],
      projects: [] as MentionableProject[],
      isOrgAdmin: false,
      recentModelScope: null,
      readOnly: false,
      activeGroupId: null,
      chatDataSeed: EMPTY_CHAT_DATA,
    };
  }

  const workspaceId = authContext.currentWorkspace.id;
  const orgId = authContext.currentOrg.id;
  const actingUserId =
    authContext.user?.id ?? authContext.session?.user_id ?? null;
  const requestedGroupId = url.searchParams.get("group")?.trim() || null;

  if (requestedGroupId && actingUserId) {
    const groupWorkspace = await findAccessibleGroupWorkspace(
      context,
      actingUserId,
      requestedGroupId,
      authContext.allWorkspaces,
    ).catch((error) => {
      console.error("Failed to resolve chat group workspace:", error);
      return null;
    });
    if (groupWorkspace && groupWorkspace.id !== workspaceId) {
      let canSwitch = true;
      if (groupWorkspace.org_id !== authContext.session.org_id) {
        // Proxy-backed and enterprise OIDC sessions can be restricted to a
        // subset of the user's orgs. Never mint a cross-org cookie unless the
        // identity validator explicitly accepts the target.
        const proxyValidation = await validateSessionIdentityMapsToOrg(
          request,
          env as unknown as ProxyAuthValidationEnv,
          authContext.session,
          groupWorkspace.org_id,
        );
        if (proxyValidation !== "valid") {
          canSwitch = false;
          console.warn(
            "[proxy-auth] skipped chat group org switch for unmapped org",
            { orgId: groupWorkspace.org_id, validation: proxyValidation },
          );
        }
      }
      if (canSwitch) {
        const signedToken =
          groupWorkspace.org_id !== authContext.session.org_id
            ? await switchSessionOrg(
                authEnv,
                authContext.session,
                groupWorkspace.org_id,
                groupWorkspace.id,
              )
            : await switchSessionWorkspace(
                authEnv,
                authContext.session,
                groupWorkspace.id,
              );
        throw redirect(`${url.pathname}${url.search}`, {
          headers: {
            "Set-Cookie": createSessionCookieHeader(
              signedToken,
              request,
              getRemainingSessionCookieMaxAge(authContext.session),
            ),
          },
        });
      }
    }
  }

  const selfhostRuntime = isSelfhostRuntime(env);
  // Do not convert a failed hosted billing read to null: null bypasses the
  // credit pause and would expose models the Worker may reject.
  const billingOverviewPromise = selfhostRuntime
    ? Promise.resolve(null)
    : getOrgBillingOverview(env, authContext.currentOrg);
  const threadPromise = chatDO.getThread(context, params.id, workspaceId, {
    orgId: authContext.currentOrg.id,
  });
  const pickerStatePromise = chatDO
    .getWorkspaceModelPickerState(context, workspaceId, {
      orgId: authContext.currentOrg.id,
      orgBillingState: authContext.currentOrg,
      llmProviderConfig: authContext.currentOrgLlmProviderConfig,
    })
    .catch((error) => {
      console.error("Failed to load model picker state:", error);
      return null;
    });
  const mentionSourcesPromise = loadWorkspaceMentionSources(env, workspaceId);
  const connectionsPromise: Promise<Integration[]> = mentionSourcesPromise.then(
    ({ connections }) => connections,
  );
  const projectsPromise: Promise<MentionableProject[]> =
    mentionSourcesPromise.then(({ projects }) => projects);
  const [
    billingOverview,
    thread,
    pickerState,
  ] = await Promise.all([
    billingOverviewPromise,
    threadPromise,
    pickerStatePromise,
  ]);
  const devCreditStatus = getDevBillingCreditStatus(url.searchParams);
  const pausedPickerState = pickerState
    ? chatDO.applyHostedCreditPause(
        pickerState,
        billingOverview
          ? {
              billingStatus: billingOverview.billing_status,
              availableCreditsCents:
                devCreditStatus?.availableCreditsCents ??
                billingOverview.available_credits_cents,
            }
          : null,
      )
    : null;

  // Even for newly created threads, load the persisted thread record so the UI
  // reflects the actual saved model instead of the Sonnet default.
  if (!thread) {
    throw redirect("/chat");
  }
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    authContext.currentOrgLlmProviderConfig,
  );
  const customApi = getStoredCustomLlmProviderApi(effectiveLlmProviderConfig);
  const customModelId = getStoredCustomLlmProviderModelId(effectiveLlmProviderConfig);
  const awsRegion = getStoredBedrockAwsRegion(effectiveLlmProviderConfig);
  const providerDefaultModel = getDefaultLlmModel(
    effectiveLlmProviderConfig?.provider,
    {
      customApi,
      customModelId,
    },
  );
  const fallbackThreadModel = selfhostRuntime
    ? normalizeLlmModel(
        thread.model,
        effectiveLlmProviderConfig?.provider,
        {
          customApi,
          customModelId,
          awsRegion,
          allowCamelCode: false,
        },
      )
    : thread.model ?? providerDefaultModel;
  const fallbackAllowedThreadModels = getVisibleLlmModelOptions(
    fallbackThreadModel,
    {
      orgProvider: effectiveLlmProviderConfig?.provider,
      customApi,
      customModelId,
      awsRegion,
      allowCamelCode: !isSelfhostRuntime(env),
    },
  ).map((option) => option.value);

  // Seed the ordinary transcript path from the warm thread record while the
  // durable ai-chat render history resolves. This applies uniformly to new,
  // existing, API-created, forked, and reloaded threads; it is paint data only,
  // never a signal that a turn is running.
  const firstMessage = thread.first_user_message?.trim();
  const seededFirstMessage = firstMessage
    ? threadRecordFirstUserMessage(
        params.id,
        firstMessage,
        thread.created_by === authContext.user.id ? authContext.user : null,
      )
    : null;
  const chatDataSeed: ChatData = seededFirstMessage
    ? {
        ...EMPTY_CHAT_DATA,
        initialUiMessages: [messageToUiMessage(seededFirstMessage)],
      }
    : EMPTY_CHAT_DATA;
  const chatDataStartedAt = Date.now();
  const chatData: ChatDataValue = thread
    ? buildChatData(context, authEnv, params.id, {
        orgId,
        workspaceId,
        loadLegacyMessages: false,
        loadUiMessages: true,
      })
        .then((resolvedChatData) => {
          recordChatThreadRouteLoaderStage(
            env,
            traceContext,
            traceIds,
            "chat_data_resolved",
            chatDataStartedAt,
            {
              status: "loaded",
              model: thread.model,
              count: resolvedChatData.initialUiMessages.length,
              size: resolvedChatData.previewTabs.length,
            },
          );
          return resolvedChatData;
        })
        .catch((error) => {
          recordChatThreadRouteLoaderError(
            env,
            traceContext,
            traceIds,
            "chat_data_resolved",
            chatDataStartedAt,
            error,
            { status: "fallback_empty", model: thread.model },
          );
          return buildChatDataError(error);
        })
    : EMPTY_CHAT_DATA;
  const activeChatGroupPromise = thread && actingUserId
    ? Promise.all([
        ensureGroupForThread(context, {
          userId: actingUserId,
          orgId,
          workspaceId,
          threadId: params.id,
          fallbackName: thread.title,
        }).catch((error) => {
          console.error("Failed to ensure chat group:", error);
          return null;
        }),
        listGroupsForMove(context, {
          userId: actingUserId,
          orgId,
          workspaceId,
        }).catch(() => []),
      ])
    : Promise.resolve([null, []] as const);
  const [activeChatGroup, moveChatGroups] = await activeChatGroupPromise;
  const resolvedThreadModel =
    (selfhostRuntime ? fallbackThreadModel : thread?.model) ??
    pausedPickerState?.defaultModel ??
    fallbackThreadModel;
  recordChatThreadRouteLoaderStage(
    env,
    traceContext,
    traceIds,
    "response_ready",
    loaderStartedAt,
    {
      status: thread ? "chat_data_deferred" : "empty",
      statusCode: 200,
      model: resolvedThreadModel,
    },
  );

  return {
    threadId: params.id,
    workspaceId,
    chatData,
    threadTitle: thread?.title ?? null,
    threadModel: resolvedThreadModel,
    llmProvider:
      pausedPickerState?.llmProvider ??
      ((effectiveLlmProviderConfig?.provider ?? null) as
        | import("@/types").LlmProvider
        | null),
    customApi: pausedPickerState?.customApi ?? customApi,
    customModelId: pausedPickerState?.customModelId ?? customModelId,
    awsRegion: pausedPickerState?.awsRegion ?? awsRegion,
    modelOptions:
      pausedPickerState?.modelOptions ??
      modelCatalogEntriesForIds(fallbackAllowedThreadModels),
    allowedThreadModels:
      pausedPickerState?.allowedThreadModels ?? fallbackAllowedThreadModels,
    effectivePickerDefaultModel:
      pausedPickerState?.effectivePickerDefaultModel ?? null,
    hasEffectivePickerDefault:
      pausedPickerState?.hasEffectivePickerDefault ?? false,
    billingAccessMode: pausedPickerState?.billingAccessMode ?? null,
    canUnlockPremiumModels:
      pausedPickerState?.canUnlockPremiumModels ?? false,
    hostedCreditsPaused: pausedPickerState?.hostedCreditsPaused ?? null,
    modelPickerSettingsHref:
      pausedPickerState?.modelPickerSettingsHref ??
      "/settings/organization/models",
    allowOpenAiSubscription:
      pausedPickerState?.allowOpenAiSubscription ?? false,
    billingCreditStatus: applyDevBillingCreditStatusOverride(
      buildBillingCreditStatus(
        billingOverview,
        effectiveLlmProviderConfig?.provider,
        resolvedThreadModel,
      ),
      url.searchParams,
    ),
    initialChatError: getDevChatInitialError(url.searchParams),
    hostname,
    orgSlug: authContext.currentOrg.slug,
    connections: connectionsPromise,
    projects: projectsPromise,
    isOrgAdmin: authContext.orgs.some(
      (org) =>
        org.org_id === orgId && (org.role === "owner" || org.role === "admin"),
    ),
    recentModelScope: { orgId, workspaceId },
    readOnly: false,
    activeChatGroup,
    activeGroupId: url.searchParams.get("group")?.trim() || null,
    moveChatGroups,
    chatDataSeed,
  };
}

export default function ChatPage() {
  const {
    threadId,
    workspaceId,
    chatData,
    threadModel,
    llmProvider,
    modelOptions,
    allowedThreadModels,
    effectivePickerDefaultModel,
    hasEffectivePickerDefault,
    billingAccessMode,
    canUnlockPremiumModels,
    hostedCreditsPaused,
    modelPickerSettingsHref,
    allowOpenAiSubscription,
    billingCreditStatus,
    initialChatError,
    hostname,
    orgSlug,
    connections,
    projects,
    isOrgAdmin,
    recentModelScope,
    readOnly,
    activeChatGroup,
    activeGroupId,
    moveChatGroups = [],
    chatDataSeed = EMPTY_CHAT_DATA,
  } = useLoaderData<typeof loader>();
  const {
    chatData: resolvedChatData,
    isLoading: isLoadingChatData,
  } = useDeferredChatData(chatData, threadId, chatDataSeed);
  const navigate = useNavigate();
  const location = useLocation();
  const locationPathname = location.pathname;
  const locationSearch = location.search;
  const revalidator = useRevalidator();
  const { groups: liveChatGroups, markThreadIdle } = useChatGroups();
  const { getSnapshot, setSnapshot } = useChatThreadSnapshots();
  const [clientActiveThreadId, setClientActiveThreadId] = useState(threadId);
  const chatDebugFlags = getChatDebugFlags();
  const markViewedEnabled = chatDebugFlags.markViewed;
  const markThreadIdleRef = useRef(markThreadIdle);
  const resolvedActiveGroupId = activeGroupId ?? activeChatGroup?.id ?? null;
  const selfhostDisplayFallbackModel =
    threadModel ??
    allowedThreadModels?.[0] ??
    getDefaultLlmModel(llmProvider);
  const modelForDisplay = (model: LlmModel): LlmModel =>
    billingAccessMode === "selfhost" && model === CAMEL_CODE_LLM_MODEL
      ? selfhostDisplayFallbackModel
      : model;
  const liveActiveChatGroup =
    resolvedActiveGroupId && !readOnly
      ? liveChatGroups.find((group) => group.id === resolvedActiveGroupId) ??
        activeChatGroup
      : activeChatGroup;

  useEffect(() => {
    if (chatDebugFlags.historyLogs) {
      console.info("[chat history route]", {
        event: "loader_data_received",
        at: new Date().toISOString(),
        location: `${locationPathname}${locationSearch}`,
        threadId,
        routeMessageCount: resolvedChatData.messages.length,
        routeMessageIds: resolvedChatData.messages.map((message) => ({
          id: message.id,
          clientMessageId: message.clientMessageId,
          role: message.role,
          created_at: message.created_at,
        })),
        messagesError: resolvedChatData.messagesError,
        isLoadingChatData,
        activeChatGroupId: activeChatGroup?.id ?? null,
      });
    }
  }, [
    activeChatGroup?.id,
    chatDebugFlags.historyLogs,
    isLoadingChatData,
    locationPathname,
    locationSearch,
    resolvedChatData,
    threadId,
  ]);

  useEffect(() => {
    setClientActiveThreadId(threadId);
  }, [threadId]);

  const displayThreadId = clientActiveThreadId;
  const activeThreadSummary =
    liveActiveChatGroup?.open_threads.find(
      (thread) => thread.id === displayThreadId,
    ) ??
    activeChatGroup?.open_threads.find(
      (thread) => thread.id === displayThreadId,
    ) ??
    null;
  const isDisplayingLoaderThread = displayThreadId === threadId;
  const displayThreadModel = isDisplayingLoaderThread
    ? threadModel
    : activeThreadSummary
      ? modelForDisplay(activeThreadSummary.model)
      : threadModel;
  const displayAllowedThreadModels = allowedThreadModels;
  const cachedSnapshot = displayThreadId ? getSnapshot(displayThreadId) : null;
  const shouldUseCachedSnapshot = Boolean(
    cachedSnapshot && (!isDisplayingLoaderThread || isLoadingChatData),
  );
  const displayChatData = resolveDisplayChatData(
    resolvedChatData,
    cachedSnapshot,
    shouldUseCachedSnapshot,
  );
  const isLoadingDisplayMessages =
    isLoadingChatData &&
    !shouldUseCachedSnapshot &&
    displayChatData.messages.length === 0;

  useEffect(() => {
    markThreadIdleRef.current = markThreadIdle;
  }, [markThreadIdle]);

  useEffect(() => {
    if (!markViewedEnabled || readOnly || !workspaceId || !displayThreadId) return;

    markThreadIdleRef.current(displayThreadId);
    const controller = new AbortController();
    void fetch(
      `/api/threads/${encodeURIComponent(displayThreadId)}/mark-viewed`,
      { method: "POST", signal: controller.signal },
    )
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Failed to mark active chat viewed:", error);
      });
    return () => controller.abort();
  }, [
    displayThreadId,
    markViewedEnabled,
    readOnly,
    workspaceId,
  ]);

  const openTabs =
    liveActiveChatGroup?.open_threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      model: modelForDisplay(thread.model),
      status: thread.status,
    })) ?? [];

  const closedTabs =
    liveActiveChatGroup?.closed_threads.map((thread) => ({
      threadId: thread.id,
      title: thread.title,
      model: modelForDisplay(thread.model),
      status: thread.status,
    })) ?? [];
  const liveChatGroupById = new Map(
    liveChatGroups.map((group) => [group.id, group]),
  );
  const availableMoveGroups = (moveChatGroups.length > 0
    ? moveChatGroups
    : liveChatGroups
  ).map((group) => {
    const liveGroup = liveChatGroupById.get(group.id);
    return liveGroup && liveGroup.avatar !== group.avatar
      ? { ...group, avatar: liveGroup.avatar }
      : group;
  });

  const selectTab = (targetThreadId: string) => {
    const snapshot = getSnapshot(targetThreadId);
    if (displayThreadId) {
      markThreadIdle(displayThreadId);
    }
    if (snapshot) {
      setClientActiveThreadId(targetThreadId);
    }
    const params = new URLSearchParams();
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (groupId) {
      params.set("group", groupId);
    }
    navigate(
      `/chat/${targetThreadId}${params.toString() ? `?${params.toString()}` : ""}`,
      { preventScrollReset: true },
    );
  };

  const closeTab = async (targetThreadId: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(targetThreadId)}`,
      { method: "DELETE" },
    );
    const remaining = openTabs.filter((tab) => tab.threadId !== targetThreadId);
    if (targetThreadId === displayThreadId) {
      navigate(
        remaining[0]
          ? `/chat/${remaining[0].threadId}`
          : `/chat?group=${encodeURIComponent(groupId)}`,
      );
      return;
    }
    revalidator.revalidate();
  };

  const reopenTab = async (targetThreadId: string) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(targetThreadId)}/reopen`,
      { method: "POST" },
    );
    revalidator.revalidate();
    navigate(`/chat/${targetThreadId}`);
  };

  const renameTab = async (targetThreadId: string, name: string) => {
    const response = await fetch(
      `/api/threads/${encodeURIComponent(targetThreadId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: name }),
      },
    );
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { thread?: { updated_at?: unknown } }
        | null;
      const updatedAt =
        typeof body?.thread?.updated_at === "number" &&
        Number.isFinite(body.thread.updated_at)
          ? body.thread.updated_at
          : Date.now();
      if (targetThreadId === displayThreadId) {
        document.title = `${name || "Chat"} - camelAI`;
      }
      window.dispatchEvent(
        new CustomEvent("camelai:thread-status", {
          detail: { threadId: targetThreadId, title: name, updatedAt },
        }),
      );
    }
    revalidator.revalidate();
  };

  const renameGroup = async (next: ChatGroupRenameInput) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    await saveChatGroupRename(groupId, next, {
      revalidate: () => revalidator.revalidate(),
    });
  };

  const toggleGroupPin = async () => {
    if (!liveActiveChatGroup || !workspaceId) return;
    await saveChatGroupPinned({
      groupId: liveActiveChatGroup.id,
      workspaceId,
      pinned: liveActiveChatGroup.pinned_at === null,
      currentPinnedAt: liveActiveChatGroup.pinned_at,
      currentPinnedCount: liveChatGroups.filter(
        (group) => group.pinned_at !== null,
      ).length,
      revalidate: () => revalidator.revalidate(),
    });
  };
  const closeGroup = async () => {
    const group = liveActiveChatGroup;
    if (!group) return;
    const redirect = getCloseGroupRedirect(
      liveChatGroups,
      group.id,
      group.id,
    );
    if (redirect) navigate(redirect, { replace: true });
    await fetch(`/api/chat-groups/${encodeURIComponent(group.id)}`, {
      method: "DELETE",
    });
    revalidator.revalidate();
  };

  const reorderTabs = async (orderedThreadIds: string[]) => {
    const groupId = liveActiveChatGroup?.id ?? resolvedActiveGroupId;
    if (!groupId) return;
    await fetch(
      `/api/chat-groups/${encodeURIComponent(groupId)}/reorder-tabs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedThreadIds }),
      },
    );
    revalidator.revalidate();
  };

  const moveTabToGroup = async (
    targetThreadId: string,
    targetGroupId: string | "new",
  ) => {
    const response = await fetch("/api/chat-groups/move-thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: targetThreadId, targetGroupId }),
    });
    if (response.ok) {
      revalidator.revalidate();
      navigate(`/chat/${targetThreadId}`);
    }
  };

  const handleSnapshotChange = useCallback(
    (snapshot: {
      messages: Message[];
      uiMessages: UIMessage[];
      streamingMessageId: string | null;
      todos: TodoItem[];
    }) => {
      if (!displayThreadId || isLoadingDisplayMessages) return;
      setSnapshot(displayThreadId, snapshot);
    },
    [displayThreadId, isLoadingDisplayMessages, setSnapshot],
  );

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {!readOnly && liveActiveChatGroup ? (
          <ChatTabBar
            groupId={liveActiveChatGroup.id}
            groupName={liveActiveChatGroup.name}
            groupAvatar={liveActiveChatGroup.avatar}
            groupPinnedAt={liveActiveChatGroup.pinned_at}
            groupMemberCount={liveActiveChatGroup.member_count}
            openTabs={openTabs}
            closedTabs={closedTabs}
            activeThreadId={displayThreadId}
            moveGroups={availableMoveGroups}
            onSelectTab={selectTab}
            onCloseTab={closeTab}
            onRenameTab={renameTab}
            onReorderTabs={reorderTabs}
            onNewTab={() =>
              navigate(`/chat?group=${encodeURIComponent(liveActiveChatGroup.id)}`)
            }
            onReopenClosedTab={reopenTab}
            onRenameGroup={renameGroup}
            onTogglePin={toggleGroupPin}
            onCloseGroup={closeGroup}
            onMoveTabToGroup={moveTabToGroup}
          />
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">
          <Chat
            key={displayThreadId}
            threadId={displayThreadId}
            workspaceId={workspaceId}
            chatGroupId={liveActiveChatGroup?.id ?? resolvedActiveGroupId}
            initialMessages={displayChatData.messages}
            initialUiMessages={displayChatData.initialUiMessages}
            olderUiMessagesCursor={displayChatData.olderUiMessagesCursor}
            bridgedStreamingMessageId={displayChatData.bridgedStreamingMessageId}
            initialTodos={displayChatData.todos}
            threadModel={displayThreadModel}
            llmProvider={llmProvider}
            allowedThreadModels={displayAllowedThreadModels}
            modelOptions={modelOptions ?? undefined}
            effectivePickerDefaultModel={effectivePickerDefaultModel}
            hasEffectivePickerDefault={hasEffectivePickerDefault}
            billingAccessMode={billingAccessMode}
            canUnlockPremiumModels={canUnlockPremiumModels}
            hostedCreditsPaused={hostedCreditsPaused}
            modelPickerSettingsHref={modelPickerSettingsHref}
            allowOpenAiSubscription={allowOpenAiSubscription}
            billingCreditStatus={billingCreditStatus}
            initialError={initialChatError ?? displayChatData.messagesError}
            initialPreviewTabs={displayChatData.previewTabs}
            initialActiveTabId={displayChatData.activeTabId}
            hostname={hostname}
            orgSlug={orgSlug}
            connections={connections}
            projects={projects}
            onSnapshotChange={handleSnapshotChange}
            isOrgAdmin={isOrgAdmin}
            recentModelScope={recentModelScope}
            isLoadingMessages={isLoadingDisplayMessages}
            readOnly={readOnly}
          />
        </div>
      </div>
    </>
  );
}

export function HydrateFallback() {
  return <ChatLoadingSkeleton />;
}
