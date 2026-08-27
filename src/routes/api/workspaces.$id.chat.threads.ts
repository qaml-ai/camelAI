import { waitUntil } from '@/lib/wait-until';
import type { Route } from './+types/workspaces.$id.chat.threads';
import { requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';
import {
  addThreadToExistingGroup,
  createGroupForNewThread,
} from '@/lib/chat-groups.server';
import type { LlmModel } from '@/types';

type CreateThreadRequestBody = {
  initialTitle?: string;
  firstMessage?: string;
  previewApps?: string;
  model?: LlmModel;
  groupId?: string;
};

function groupThreadFailureStatus(message: string): number {
  return message === 'Chat group not found' || message === 'Thread not found'
    ? 404
    : 500;
}

/**
 * Lightweight thread creation endpoint that validates workspace access
 * without loading full auth context.
 */
export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const { session, orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(
    request,
    context,
    params.id,
    { requireWrite: true }
  );

  if (session.workspace_id !== params.id) {
    return Response.json({ error: 'Workspace mismatch' }, { status: 403 });
  }

  let body: CreateThreadRequestBody;
  try {
    body = (await request.json()) as CreateThreadRequestBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  let thread: Awaited<ReturnType<typeof chatDO.createThread>>;
  try {
    thread = await chatDO.createThread(
      context,
      workspaceId,
      body.initialTitle || undefined,
      userId,
      body.firstMessage || undefined,
      body.model
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create thread';
    const status =
      message === 'Invalid thread model' || message === 'No models are available'
        ? 400
        : 500;
    return Response.json({ error: message || 'Failed to create thread' }, { status });
  }

  // Set preview apps if provided
  if (body.previewApps) {
    const previewApps = body.previewApps.split(',').filter(Boolean);
    if (previewApps.length > 0) {
      const scriptName = previewApps[0];
      const script = await getWorkerScript(authEnv, orgId, scriptName);
      await chatDO.setThreadPreviewTarget(context, thread.id, {
        kind: 'app',
        scriptName,
        isPublic: script?.is_public ?? false,
      });
    }
  }

  // Generate title in background
  if (body.firstMessage) {
    waitUntil(
      chatDO.generateThreadTitle(
        context,
        thread.id,
        workspaceId,
        body.firstMessage,
        userId,
      )
    );
  }

  try {
    const group = body.groupId
      ? await addThreadToExistingGroup(context, {
          userId,
          orgId,
          workspaceId,
          groupId: body.groupId,
          threadId: thread.id,
        })
      : await createGroupForNewThread(context, {
          userId,
          orgId,
          workspaceId,
          threadId: thread.id,
          initialThreadTitle: body.initialTitle,
        });
    return Response.json({ thread, groupId: group.id, group });
  } catch (error) {
    await chatDO.deleteThread(context, thread.id, workspaceId, { orgId }).catch(
      () => {},
    );
    const message = error instanceof Error ? error.message : 'Failed to group thread';
    return Response.json(
      { error: message },
      { status: groupThreadFailureStatus(message) },
    );
  }
}
