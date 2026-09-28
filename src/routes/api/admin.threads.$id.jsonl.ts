import type { Route } from './+types/admin.threads.$id.jsonl';
import { requireSuperuser, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getThreadTranscript } from '@/lib/chat-do.server';

function sanitizeFilename(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized || 'thread';
}

function messagesToJsonl(messages: unknown[]): string {
  if (messages.length === 0) {
    return '';
  }
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    await requireSuperuser(request, context);

    const threadId = params.id?.trim();
    if (!threadId) {
      return Response.json({ error: 'Thread ID required' }, { status: 400 });
    }

    const url = new URL(request.url);
    const orgId = url.searchParams.get('orgId')?.trim();
    const workspaceId = url.searchParams.get('workspaceId')?.trim();

    if (!orgId || !workspaceId) {
      return Response.json(
        { error: 'orgId and workspaceId query params are required' },
        { status: 400 }
      );
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const thread = await orgStub.getThread(threadId);

    if (!thread || thread.workspace_id !== workspaceId) {
      return Response.json({ error: 'Thread not found' }, { status: 404 });
    }

    const filename = `${sanitizeFilename(threadId)}.jsonl`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    };

    const piMessages = await getThreadTranscript(context, { orgId, threadId });
    if (piMessages.length > 0) {
      return new Response(messagesToJsonl(piMessages), { headers });
    }

    return new Response('', { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error downloading thread JSONL:', error);
    return Response.json({ error: 'Failed to download thread JSONL' }, { status: 500 });
  }
}
