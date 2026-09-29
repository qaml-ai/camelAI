/**
 * Access for the routes of threads that run directly on the hosted agent
 * runtime (plans/runtime-threads-direct.md §4.1): the session, then one
 * OrgDO call that checks the user may use the thread (member, full workspace
 * access, thread in workspace) and returns its runtime row.
 */
import type { AppLoadContext } from "react-router";
import { requireSession } from "@/lib/auth.server";
import { getEnv } from "@/lib/cloudflare.server";
import { getAuthEnv } from "@/lib/auth-helpers";
import type { ChatContextState, ChatEnv } from "../../workers/main/src/chat-thread/types";
import type { OrgChatWebSocketAccessResult, ThreadRuntimeRecord } from "../../workers/main/src/identity/org-do";
import {
  mintRuntimeBrowserToken,
  pinNewThreadToRuntime,
  runtimeHistoryPage,
  startRuntimeTurn,
  type RuntimeThreadSender,
  type RuntimeTurnResult,
} from "../../workers/main/src/agent-runtime/thread-runtime";
import type { RuntimeThreadSeed } from "@/lib/use-runtime-thread";
import { recordRuntimeMigration, recordRuntimeSendFailure, recordRuntimeTokenMintFailure } from "../../workers/main/src/agent-runtime/runtime-thread-telemetry";
import { migrateThreadToRuntime } from "../../workers/main/src/agent-runtime/thread-migration";
import { normalizePreviewTabs } from "../../workers/main/src/chat-thread/preview-state";
import { initialRuntimeRequestId, requireSameOriginJson, runtimeReadProxyBase, runtimeThreadMigrationEnabled, startErrorStillCurrent } from "@/lib/agent-runtime-shared";

export interface RuntimeThreadAccess {
  env: ChatEnv;
  context: ChatContextState;
  sender: RuntimeThreadSender;
  /** Null for a thread that runs on ChatThreadDO. */
  row: ThreadRuntimeRecord | null;
}

function json(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

/**
 * The caller's access to `threadId` in `workspaceId` (default: the session's
 * workspace). Throws a JSON Response (400/403/404) when there is none.
 */
export async function requireRuntimeThreadAccess(
  request: Request,
  loadContext: AppLoadContext,
  threadId: string | undefined,
  workspaceId?: string | null,
): Promise<RuntimeThreadAccess> {
  requireSameOriginJson(request);
  const { session } = await requireSession(request, loadContext);
  const id = threadId?.trim();
  if (!id) throw json("Thread ID required", 400);
  const orgId = session.org_id;
  const workspace = workspaceId?.trim() || session.workspace_id;
  if (!orgId || !workspace) throw json("No workspace selected", 400);
  const env = getEnv(loadContext);
  const authEnv = getAuthEnv(env);
  const access = (await authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
    .validateChatWebSocketAccess(session.user_id, workspace, id)) as OrgChatWebSocketAccessResult;
  if (!access.ok) {
    if (access.reason === "forbidden") throw json("Forbidden", 403);
    throw json(access.reason === "thread_not_found" ? "Thread not found" : "Workspace not found", 404);
  }
  return {
    env: env as unknown as ChatEnv,
    context: {
      threadId: id,
      workspaceId: access.workspaceId,
      orgId: access.orgId,
      userId: session.user_id,
      userName: session.user_name ?? null,
      userEmail: session.user_email ?? null,
    },
    sender: {
      userId: session.user_id,
      userName: session.user_name ?? null,
      userEmail: session.user_email ?? null,
    },
    row: access.runtime ?? null,
  };
}

/** As requireRuntimeThreadAccess, for a thread that must run on the runtime (409 otherwise). */
export async function requireRuntimeThread(
  request: Request,
  loadContext: AppLoadContext,
  threadId: string | undefined,
  workspaceId?: string | null,
): Promise<RuntimeThreadAccess & { row: ThreadRuntimeRecord }> {
  const access = await requireRuntimeThreadAccess(request, loadContext, threadId, workspaceId);
  if (!access.row) throw json("This thread does not run on the agent runtime", 409);
  return access as RuntimeThreadAccess & { row: ThreadRuntimeRecord };
}

/** A route's workspace: `workspaceId` from the query or JSON body, when the tab's workspace is not the session's. */
export function requestWorkspaceId(request: Request, body?: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("workspaceId");
  if (fromQuery?.trim()) return fromQuery.trim();
  const fromBody = body && typeof body === "object" ? (body as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof fromBody === "string" && fromBody.trim() ? fromBody.trim() : null;
}

/**
 * What a runtime thread's page loads server-side for first paint, with no
 * DO: its saved preview tabs, and (once it has an agent) a browser token and
 * the newest page of history, read in parallel.
 */
export async function loadRuntimeThreadSeed(
  env: ChatEnv,
  input: { orgId: string; workspaceId: string; threadId: string; userId: string; row: ThreadRuntimeRecord },
): Promise<{ seed: RuntimeThreadSeed; error: string | null }> {
  const org = env.ORG.get(env.ORG.idFromName(input.orgId)) as unknown as {
    getThreadUiState(threadId: string): Promise<{ preview: Record<string, unknown> | null } | null>;
  };
  const agentId = input.row.agentId;
  const [uiState, reads, startError] = await Promise.all([
    org.getThreadUiState(input.threadId).catch(() => null),
    agentId
      ? Promise.all([
          mintRuntimeBrowserToken(env, { ...input.row, agentId }, input.userId, runtimeReadProxyBase(input.threadId, input.workspaceId)),
          runtimeHistoryPage(env, agentId, { limit: 50 }),
        ]).then(
          ([token, page]) => ({ token, page, error: null as string | null }),
          (error: unknown) => {
            console.error("[runtime-thread] failed to load the thread", error);
            recordRuntimeTokenMintFailure(env, input, "page_seed", { error });
            return { token: null, page: null, error: "Can't reach the agent service. Try again in a moment." };
          },
        )
      : Promise.resolve({ token: null, page: null, error: null }),
    runtimeStartError(org, input.threadId),
  ]);
  const { tabs: previewTabs, activeTabId } = normalizePreviewTabs(
    uiState?.preview?.tabs,
    uiState?.preview?.activeTabId,
    input.workspaceId,
    input.threadId,
  );
  return {
    seed: {
      agentId,
      token: reads.token?.token ?? null,
      expiresAt: reads.token?.expiresAt ?? null,
      url: reads.token?.url ?? null,
      page: reads.page ? { entries: reads.page.entries, next: reads.page.next } : null,
      previewTabs,
      activeTabId,
      startError: startErrorStillCurrent(startError, reads.page?.entries ?? []),
    },
    error: reads.error,
  };
}

/** Why a runtime thread's first message was refused (recorded by startFirstRuntimeTurn), or null. */
async function runtimeStartError(
  org: unknown,
  threadId: string,
): Promise<{ id: string; error: string; at: number } | null> {
  const thread = await (org as { getThread(id: string): Promise<{ last_chat_error_at?: number | null; last_chat_error_message?: string | null } | null> })
    .getThread(threadId)
    .catch(() => null);
  const message = thread?.last_chat_error_message?.trim();
  if (!message) return null;
  const at = thread?.last_chat_error_at ?? 0;
  return { id: `rt-start:${at}`, error: message, at };
}

/** How long opening a thread waits for its move to the runtime before showing it from ChatThreadDO. */
const MIGRATE_ON_OPEN_WAIT_MS = 8_000;

/**
 * A thread still on ChatThreadDO, moved to the runtime as it is opened
 * (AGENT_RUNTIME_MIGRATE_DO_THREADS). Null when it stays on the DO for now:
 * the move was refused, failed, or is still going after a few seconds (it
 * finishes in the background, and the next open finds the thread moved).
 */
export async function migrateThreadOnOpen(
  loadContext: AppLoadContext,
  context: ChatContextState,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<ThreadRuntimeRecord | null> {
  const env = getEnv(loadContext) as unknown as ChatEnv;
  if (!runtimeThreadMigrationEnabled(env)) return null;
  const move = migrateThreadToRuntime(env, context).then((result) => {
    recordRuntimeMigration(env, context, result);
    return "row" in result ? result.row : null;
  }, (error: unknown) => {
    recordRuntimeMigration(env, context, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    return null;
  });
  waitUntil(move);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MIGRATE_ON_OPEN_WAIT_MS); });
  try {
    return await Promise.race([move, wait]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A new web thread, just created: pinned to the runtime when this deployment
 * runs new threads there and its model can. Null: it runs on ChatThreadDO.
 */
export async function pinNewWebThread(
  loadContext: AppLoadContext,
  context: ChatContextState,
): Promise<ThreadRuntimeRecord | null> {
  return await pinNewThreadToRuntime(getEnv(loadContext) as unknown as ChatEnv, context);
}

/**
 * A new runtime thread's first message, sent before the page redirects to it
 * (so the page finds the agent and the message on its first read).
 */
export async function startFirstRuntimeTurn(
  loadContext: AppLoadContext,
  input: {
    context: ChatContextState;
    row: ThreadRuntimeRecord;
    sender: RuntimeThreadSender;
    text: string;
    waitUntil(promise: Promise<unknown>): void;
  },
): Promise<RuntimeTurnResult> {
  const env = getEnv(loadContext) as unknown as ChatEnv;
  let turn: RuntimeTurnResult;
  try {
    turn = await startRuntimeTurn(env, {
      ...input,
      clientMessageId: initialRuntimeRequestId(input.context.threadId),
      source: "web",
    });
    recordRuntimeSendFailure(env, input.context, "first_send", { result: turn });
  } catch (error) {
    recordRuntimeSendFailure(env, input.context, "first_send", { error });
    turn = { status: "error", error: error instanceof Error ? error.message : "Failed to send message" };
  }
  if (turn.status !== "accepted") {
    // Nobody is on the page yet: keep the refusal on the thread, where its
    // page reads it (loadRuntimeThreadSeed) and shows it as the DO path does.
    await env.ORG.get(env.ORG.idFromName(input.context.orgId))
      .recordThreadError(input.context.threadId, {
        message: turn.error,
        source: "agent_runtime_start",
        errorKind: turn.code ?? turn.status,
        userId: input.sender.userId,
      })
      .catch((error: unknown) => console.error("[runtime-thread] failed to record a refused first message", error));
  }
  return turn;
}
