import type { Route } from './+types/workspaces.$id.chat.$threadId.fork';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import * as chatDO from '@/lib/chat-do.server';
import { addThreadToExistingGroup } from '@/lib/chat-groups.server';
import { normalizeLlmModel } from '@/lib/llm-provider-config';
import type { ChatThreadPiCoreForkResult } from '../../../workers/main/src/chat-thread-do';

function forkThreadTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed ? `Fork: ${trimmed}` : 'Forked chat';
}

function normalizeForkError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : String(error || 'Failed to fork chat');
  return message;
}

function forkMessagesFailureStatus(result: ChatThreadPiCoreForkResult): number {
  if (
    result.code === 'TARGET_NOT_FOUND' ||
    result.error === 'Fork target not found in Durable Object Pi messages'
  ) {
    return 404;
  }
  if (result.code === 'THREAD_MOVED') return 409;
  return 500;
}

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
  const renderedMessageId =
    typeof body.renderedMessageId === 'string'
      ? body.renderedMessageId.trim()
      : '';
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

  try {
    const sourceChatStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(sourceThreadId),
    );
    const targetChatStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(targetThread.id),
    );
    const sourceChat = sourceChatStub as unknown as {
      getPiCoreForkMessages(options: {
        forkEntryId: string;
        renderedMessageId?: string;
      }): Promise<ChatThreadPiCoreForkResult> | ChatThreadPiCoreForkResult;
    };
    const targetChat = targetChatStub as unknown as {
      replacePiCoreForkMessages(messages: NonNullable<ChatThreadPiCoreForkResult['messages']>): Promise<void> | void;
      getForkStateSnapshot: typeof targetChatStub.getForkStateSnapshot;
      applyForkStateSnapshot: typeof targetChatStub.applyForkStateSnapshot;
    };
    const forkMessages = await Promise.resolve(
      sourceChat.getPiCoreForkMessages({
        forkEntryId: messageId,
        renderedMessageId,
      }),
    );
    if (!forkMessages.success || !forkMessages.messages?.length) {
      await chatDO.deleteThread(context, targetThread.id, workspaceId, {
        orgId,
      }).catch(() => {});
      return Response.json(
        {
          error:
            forkMessages.error ||
            'Fork target not found in Durable Object Pi messages',
        },
        { status: forkMessagesFailureStatus(forkMessages) },
      );
    }

    await targetChat.replacePiCoreForkMessages(forkMessages.messages);
    const snapshot = await sourceChatStub.getForkStateSnapshot();
    await targetChat.applyForkStateSnapshot(snapshot, {
      threadId: targetThread.id,
      workspaceId,
      orgId,
      userId,
    });
    if (targetGroupId) {
      await addThreadToExistingGroup(context, {
        userId,
        orgId,
        workspaceId,
        groupId: targetGroupId,
        threadId: targetThread.id,
      });
    }
  } catch (error) {
    await chatDO.deleteThread(context, targetThread.id, workspaceId, {
      orgId,
    }).catch(() => {});
    const message = normalizeForkError(error);
    return Response.json({ error: message }, { status: 500 });
  }

  return Response.json({ thread: targetThread, groupId: targetGroupId });
}
