import type { Route } from './+types/workspaces.$id.chat.$threadId.fork';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import * as chatDO from '@/lib/chat-do.server';
import { addThreadToExistingGroup } from '@/lib/chat-groups.server';
import { normalizeLlmModel } from '@/lib/llm-provider-config';
import type { ThreadRuntimeRecord } from '../../../workers/main/src/identity/org-do';
import { actionOnlyLoader } from '@/lib/method-not-allowed';

function forkThreadTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Fork: ${trimmed}` : 'Forked chat';
}

function normalizeForkError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || 'Failed to fork chat');
  return message;
}

export const loader = actionOnlyLoader('POST');

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const sourceThreadId = params.threadId?.trim();
  if (!sourceThreadId) {
    return Response.json({ error: 'Thread ID required' }, { status: 400 });
  }

  const { session, orgId, workspaceId, userId } =
    await requireSessionWorkspaceAccess(request, context, params.id, {
      requireWrite: true,
    });

  if (session.workspace_id !== params.id) {
    return Response.json({ error: 'Workspace mismatch' }, { status: 403 });
  }

  let body: {
    messageId?: unknown;
    renderedMessageId?: unknown;
    groupId?: unknown;
  };
  try {
    body = (await request.json()) as {
      messageId?: unknown;
      renderedMessageId?: unknown;
      groupId?: unknown;
    };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const messageId =
    typeof body.messageId === 'string' ? body.messageId.trim() : '';
  if (!messageId) {
    return Response.json({ error: 'messageId is required' }, { status: 400 });
  }
  const groupId = typeof body.groupId === 'string' ? body.groupId.trim() : '';

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  const sourceThread = await orgStub.getThread(sourceThreadId);
  if (!sourceThread || sourceThread.workspace_id !== workspaceId) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }
  const sourceModel = normalizeLlmModel(sourceThread.model);
  // Threads fork on the runtime: a new agent with the source's history. A
  // thread still on ChatThreadDO forks once it has moved (opening it moves it).
  const sourceRuntime = await orgStub.getThreadRuntime(sourceThreadId) as ThreadRuntimeRecord | null;
  if (!sourceRuntime) {
    return Response.json(
      { error: 'This conversation is moving to the new chat engine; open it, then fork it once it has moved.' },
      { status: 409 },
    );
  }

  let targetGroupId: string | null = null;
  if (groupId) {
    const group = await userStub.getChatGroupSummary(groupId);
    if (
      !group ||
      group.org_id !== orgId ||
      group.workspace_id !== workspaceId ||
      ![...group.open_thread_ids, ...group.closed_thread_ids].includes(
        sourceThreadId,
      )
    ) {
      return Response.json(
        { error: 'Source thread is not in the requested group' },
        { status: 400 },
      );
    }
    targetGroupId = group.id;
  } else {
    const sourceGroup = await userStub.getChatGroupForThread(sourceThreadId);
    if (
      sourceGroup &&
      sourceGroup.org_id === orgId &&
      sourceGroup.workspace_id === workspaceId
    ) {
      targetGroupId = sourceGroup.id;
    }
  }

  let targetThread: Awaited<ReturnType<typeof chatDO.createThread>>;
  try {
    try {
      targetThread = await chatDO.createThread(
        context,
        workspaceId,
        forkThreadTitle(sourceThread.title),
        userId,
        sourceThread.first_user_message ?? undefined,
        sourceModel,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create fork';
      if (
        message !== 'Invalid thread model' &&
        message !== 'No models are available'
      ) {
        throw error;
      }
      targetThread = await chatDO.createThread(
        context,
        workspaceId,
        forkThreadTitle(sourceThread.title),
        userId,
        sourceThread.first_user_message ?? undefined,
      );
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create fork';
    const status =
      message === 'Invalid thread model' || message === 'No models are available'
        ? 400
        : 500;
    return Response.json({ error: message }, { status });
  }

  const failed = async (status: number, error: string) => {
    await chatDO.deleteThread(context, targetThread.id, workspaceId, { orgId }).catch(() => {});
    return Response.json({ error }, { status });
  };
  if (!sourceRuntime.agentId) return await failed(404, 'Fork target not found in the thread\'s history');
  const { forkRuntimeThread } = await import('../../../workers/main/src/agent-runtime/thread-fork');
  const forked = await forkRuntimeThread(env as never, {
    source: { ...sourceRuntime, agentId: sourceRuntime.agentId },
    target: { orgId, workspaceId, threadId: targetThread.id, userId, userName: null, userEmail: null },
    forkEntryId: messageId,
  }).catch((error: unknown) => ({ status: 'failed' as const, error: normalizeForkError(error) }));
  if (forked.status !== 'forked') return await failed(forked.status === 'not_found' ? 404 : 500, forked.error);
  if (targetGroupId) {
    await addThreadToExistingGroup(context, {
      userId,
      orgId,
      workspaceId,
      groupId: targetGroupId,
      threadId: targetThread.id,
    }).catch((error: unknown) => console.error('Failed to add the fork to its group:', error));
  }
  return Response.json({ thread: targetThread, groupId: targetGroupId });
}
